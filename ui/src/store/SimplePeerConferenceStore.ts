import { type Subscriber, type Invalidator, type Unsubscriber, get } from "svelte/store";
import {
  createGenericKeyValueStore,
  type GenericKeyValueStore,
  type GenericKeyValueStoreDataExtended,
  deriveGenericValueStore,
} from "./generic/GenericKeyValueStore";
import { RelayClient } from "./RelayClient";
import { type AgentPubKeyB64, encodeHashToBase64 } from "@holochain/client";
import { ConferenceRole } from "$lib/types";

import {
  type ConferenceContext,
  type SimplePeerConferenceState,
  type SimplePeerParticipant,
  type ConnectionQuality,
  MAX_CONFERENCE_PARTICIPANTS,
  INVITATION_TIMEOUT_MS,
  createUIStateManager,
  createRoleManager,
  createConnectionMonitor,
  createSignalHandler,
  createPeerConnectionManager,
  createMediaManager,
  createConferenceLifecycle,
} from "./conference";

export type {
  SimplePeerConferenceState,
  SimplePeerParticipant,
  ConnectionQuality,
};
export { MAX_CONFERENCE_PARTICIPANTS, INVITATION_TIMEOUT_MS };

export interface SimplePeerConferenceStore {
  createConference: (
    participants: AgentPubKeyB64[],
    cellIdB64?: string,
    initiatorPubKeyB64?: AgentPubKeyB64,
  ) => Promise<string>;
  joinConference: (roomId: string, participants: AgentPubKeyB64[]) => Promise<void>;
  acceptConferenceInvitation: (roomId: string) => Promise<void>;
  setShowPreJoinScreen: (roomId: string, show: boolean) => void;
  setMinimized: (roomId: string, minimized: boolean) => void;
  setMediaEnabled: (roomId: string, video: boolean, audio: boolean) => void;
  rejectConferenceInvitation: (roomId: string) => Promise<void>;
  leaveConference: (roomId: string) => Promise<void>;
  endConferenceForAll: (roomId: string) => Promise<void>;
  sendMediaStateToAll: (
    roomId: string,
    videoEnabled: boolean,
    audioEnabled: boolean,
  ) => Promise<void>;
  handleSimplePeerSignal: (roomId: string, signal: import("$lib/types").SimplePeerSignalPayload) => void;
  initializeWebRTC: (roomId: string) => Promise<void>;
  initiateConnections: (roomId: string) => Promise<void>;
  cleanupWebRTC: (roomId: string) => void;
  cleanupPeer: (roomId: string, pubKey: string) => void;
  deriveConferenceStore: (
    roomId: string,
  ) => import("./generic/GenericKeyValueStore").GenericValueStore<SimplePeerConferenceState>;
  getConference: (roomId: string) => SimplePeerConferenceState;
  setConference: (roomId: string, state: SimplePeerConferenceState) => void;
  updateConference: (
    roomId: string,
    updater: (state: SimplePeerConferenceState) => SimplePeerConferenceState,
  ) => void;
  removeConference: (roomId: string) => void;
  getActiveConferenceRoom: (cellIdB64: string) => Promise<string | null>;
  getMyActiveCall: () => { roomId: string; cellIdB64?: string } | null;
  reconcilePresence: (roomId: string) => Promise<void>;
  cleanupAll: () => void;
  getIncomingInvitations: () => SimplePeerConferenceState[];
  fetchRoles: (roomId: string) => Promise<void>;
  transferHost: (roomId: string, newHostPubKeyB64: AgentPubKeyB64) => Promise<void>;
  kickParticipant: (roomId: string, targetPubKeyB64: AgentPubKeyB64) => Promise<void>;
  changeParticipantRole: (
    roomId: string,
    targetPubKeyB64: AgentPubKeyB64,
    newRole: ConferenceRole,
  ) => Promise<void>;
  canEndConference: (roomId: string) => boolean;
  canKick: (roomId: string, targetPubKeyB64: AgentPubKeyB64) => boolean;
  subscribe: (
    run: Subscriber<GenericKeyValueStoreDataExtended<SimplePeerConferenceState>>,
    invalidate?: Invalidator<GenericKeyValueStoreDataExtended<SimplePeerConferenceState>>,
  ) => Unsubscriber;
}

export function createSimplePeerConferenceStore(client: RelayClient): SimplePeerConferenceStore {
  const conferences: GenericKeyValueStore<SimplePeerConferenceState> =
    createGenericKeyValueStore<SimplePeerConferenceState>([
      ([_, conference]) => conference?.invitationTimestamp || Date.now(),
    ]);

  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const networkMonitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const healthMonitorIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const mediaStateDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const outgoingSdpBuffer = new Map<string, Array<{ data: string; timestamp: number }>>();

  const ctx: ConferenceContext = {
    client,
    conferences,
    reconnectTimers,
    networkMonitorTimers,
    healthMonitorIntervals,
    mediaStateDebounceTimers,
    outgoingSdpBuffer,
  };

  let peerManager: ReturnType<typeof createPeerConnectionManager>;

  const connectionMonitor = createConnectionMonitor(
    ctx,
    (roomId: string, pubKey: string) => peerManager.cleanupPeer(roomId, pubKey),
    (roomId: string) => signalHandler.initiateConnections(roomId),
  );

  peerManager = createPeerConnectionManager(
    ctx,
    connectionMonitor.scheduleReconnect,
    connectionMonitor.startNetworkMonitoring,
    connectionMonitor.stopNetworkMonitoring,
  );

  const signalHandler = createSignalHandler(ctx, peerManager.createPeer);

  const mediaManager = createMediaManager(
    ctx,
    peerManager.cleanupPeer,
    peerManager.cleanupPeerWithVerification,
    signalHandler.handleSimplePeerSignal,
    signalHandler.initiateConnections,
    connectionMonitor.startConnectionHealthMonitoring,
    connectionMonitor.stopConnectionHealthMonitoring,
  );

  const lifecycle = createConferenceLifecycle(
    ctx,
    peerManager.cleanupPeer,
    mediaManager.cleanupWebRTC,
  );

  const roleManager = createRoleManager(ctx, peerManager.cleanupPeer);

  const uiState = createUIStateManager(ctx);

  function deriveConferenceStore(roomId: string) {
    return deriveGenericValueStore(conferences, roomId);
  }

  async function getActiveConferenceRoom(cellIdB64: string): Promise<string | null> {
    try {
      const cellId = client.decodeCellId(cellIdB64);
      return await client.getActiveConference(cellId);
    } catch (e) {
      console.error("[Conference] Failed to query active conference:", e);
      return null;
    }
  }

  async function reconcilePresence(roomId: string): Promise<void> {
    let conf: SimplePeerConferenceState | undefined;
    try {
      conf = conferences.getKeyValue(roomId);
    } catch {
      return;
    }
    if (!conf || conf.ended || !conf.cellIdB64) return;

    let records;
    try {
      const cellId = client.decodeCellId(conf.cellIdB64);
      records = await client.getConferenceParticipants(roomId, cellId);
    } catch (e) {
      console.error("[Conference] reconcilePresence failed:", e);
      return;
    }

    const activeAgents = new Set(
      records.filter((r) => r.is_active).map((r) => encodeHashToBase64(r.agent)),
    );
    const myPubKey = encodeHashToBase64(client.client.myPubKey);

    if (!activeAgents.has(myPubKey)) {
      mediaManager.cleanupWebRTC(roomId);
      conferences.updateKeyValue(roomId, (c) => ({
        ...c,
        ended: true,
        invitationStatus: "left" as const,
      }));
      return;
    }

    const toDrop: string[] = [];
    for (const [pk, p] of conf.participants) {
      if (pk !== myPubKey && p.hasJoined && !activeAgents.has(pk)) {
        toDrop.push(pk);
      }
    }
    for (const pk of toDrop) {
      peerManager.cleanupPeer(roomId, pk);
    }
    if (toDrop.length > 0) {
      conferences.updateKeyValue(roomId, (c) => {
        const next = new Map(c.participants);
        for (const pk of toDrop) {
          const p = next.get(pk);
          if (p) next.set(pk, { ...p, hasJoined: false, connectionStatus: "idle" });
        }
        return { ...c, participants: next };
      });
    }

    const hasActiveHost = records.some((r) => r.is_active && r.role === ConferenceRole.Host);
    if (!hasActiveHost) {
      const activeSorted = Array.from(activeAgents).sort();
      if (activeSorted[0] === myPubKey) {
        try {
          const cellId = client.decodeCellId(conf.cellIdB64);
          await client.claimHost(roomId, cellId);
        } catch (e) {
          console.error("[Conference] claimHost failed:", e);
        }
      }
    }
  }

  function getMyActiveCall(): { roomId: string; cellIdB64?: string } | null {
    const snapshot = get(conferences);
    for (const [roomId, conf] of Object.entries(snapshot.data)) {
      if (conf && !conf.ended && conf.invitationStatus === "accepted") {
        return { roomId, cellIdB64: conf.cellIdB64 };
      }
    }
    return null;
  }

  function cleanupAll(): void {
    const snapshot = get(conferences);
    for (const [roomId, conf] of Object.entries(snapshot.data)) {
      if (!conf) continue;
      if (conf.invitationTimeoutHandle) clearTimeout(conf.invitationTimeoutHandle);
      if (conf.healthMonitorInterval) clearInterval(conf.healthMonitorInterval);
      for (const p of conf.participants.values()) {
        if (p.reconnectTimer) clearTimeout(p.reconnectTimer);
        if (p.connectionTimeout) clearTimeout(p.connectionTimeout);
        if (p.mediaWaitTimer) clearTimeout(p.mediaWaitTimer);
        if (p.networkMonitorTimeout) clearTimeout(p.networkMonitorTimeout);
        if (p.peer && !p.peer.destroyed) {
          try {
            p.peer.destroy();
          } catch (e) {
            console.warn("[Conference] Error destroying peer during cleanupAll:", e);
          }
        }
      }
      conferences.removeKeyValue(roomId);
    }
  }

  return {
    createConference: lifecycle.createConference,
    getActiveConferenceRoom,
    getMyActiveCall,
    reconcilePresence,
    cleanupAll,
    joinConference: lifecycle.joinConference,
    acceptConferenceInvitation: lifecycle.acceptConferenceInvitation,
    rejectConferenceInvitation: lifecycle.rejectConferenceInvitation,
    leaveConference: lifecycle.leaveConference,
    endConferenceForAll: lifecycle.endConferenceForAll,

    setShowPreJoinScreen: uiState.setShowPreJoinScreen,
    setMinimized: uiState.setMinimized,
    setMediaEnabled: uiState.setMediaEnabled,
    getIncomingInvitations: uiState.getIncomingInvitations,

    sendMediaStateToAll: mediaManager.sendMediaStateToAll,
    initializeWebRTC: mediaManager.initializeWebRTC,
    cleanupWebRTC: mediaManager.cleanupWebRTC,

    handleSimplePeerSignal: signalHandler.handleSimplePeerSignal,
    initiateConnections: signalHandler.initiateConnections,

    cleanupPeer: peerManager.cleanupPeer,

    fetchRoles: roleManager.fetchRoles,
    transferHost: roleManager.transferHost,
    kickParticipant: roleManager.kickParticipant,
    changeParticipantRole: roleManager.changeParticipantRole,
    canEndConference: roleManager.canEndConference,
    canKick: roleManager.canKick,

    deriveConferenceStore,
    getConference: conferences.getKeyValue,
    setConference: conferences.setKeyValue,
    updateConference: conferences.updateKeyValue,
    removeConference: conferences.removeKeyValue,
    subscribe: conferences.subscribe,
  };
}
