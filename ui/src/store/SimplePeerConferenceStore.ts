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
  updateParticipant,
  createUIStateManager,
  createConferenceStreams,
  createConferenceLifecycle,
} from "./conference";

export type { SimplePeerConferenceState, SimplePeerParticipant, ConnectionQuality };
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
  handleSimplePeerSignal: (
    roomId: string,
    signal: import("$lib/types").SimplePeerSignalPayload,
  ) => void;
  initializeWebRTC: (roomId: string) => Promise<void>;
  setLocalVideo: (roomId: string, enabled: boolean) => Promise<void>;
  startScreenShare: (roomId: string) => Promise<void>;
  stopScreenShare: (roomId: string) => Promise<void>;
  switchDevice: (roomId: string, kind: "audio" | "video", deviceId: string) => Promise<void>;
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
  recordPeerActivity: (agentB64: string) => void;
  cleanupAll: () => void;
  getIncomingInvitations: () => SimplePeerConferenceState[];
  kickParticipant: (roomId: string, targetPubKeyB64: AgentPubKeyB64) => void;
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

  const healthMonitorIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const mediaStateDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const ctx: ConferenceContext = {
    client,
    conferences,
    healthMonitorIntervals,
    mediaStateDebounceTimers,
  };

  function recordPeerActivity(agentB64: string): void {
    const now = Date.now();
    const all = get(conferences).data;
    for (const roomId of Object.keys(all)) {
      const conf = all[roomId];
      if (!conf || conf.ended || !conf.participants.has(agentB64)) continue;
      updateParticipant(ctx, roomId, agentB64, (p) => ({ ...p, lastPongAt: now }));
    }
  }

  const streams = createConferenceStreams(ctx);

  const lifecycle = createConferenceLifecycle(ctx, streams.cleanupPeer, streams.cleanupWebRTC);

  function confInitiator(roomId: string): boolean {
    try {
      return conferences.getKeyValue(roomId)?.isInitiator === true;
    } catch {
      return false;
    }
  }
  function canEndConference(roomId: string): boolean {
    return confInitiator(roomId);
  }
  function canKick(roomId: string, targetPubKeyB64: AgentPubKeyB64): boolean {
    return confInitiator(roomId) && targetPubKeyB64 !== encodeHashToBase64(client.client.myPubKey);
  }
  function kickParticipant(roomId: string, targetPubKeyB64: AgentPubKeyB64): void {
    streams.blockParticipant(roomId, targetPubKeyB64);
  }

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
        if (p.connectionTimeout) clearTimeout(p.connectionTimeout);
        if (p.mediaWaitTimer) clearTimeout(p.mediaWaitTimer);
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
    recordPeerActivity,
    cleanupAll,
    joinConference: lifecycle.joinConference,
    acceptConferenceInvitation: async (roomId: string) => {
      await lifecycle.acceptConferenceInvitation(roomId);
      await streams.initializeWebRTC(roomId);
    },
    rejectConferenceInvitation: lifecycle.rejectConferenceInvitation,
    leaveConference: lifecycle.leaveConference,
    endConferenceForAll: lifecycle.endConferenceForAll,

    setShowPreJoinScreen: uiState.setShowPreJoinScreen,
    setMinimized: uiState.setMinimized,
    setMediaEnabled: uiState.setMediaEnabled,
    getIncomingInvitations: uiState.getIncomingInvitations,

    sendMediaStateToAll: streams.sendMediaStateToAll,
    initializeWebRTC: streams.initializeWebRTC,
    setLocalVideo: streams.setLocalVideo,
    startScreenShare: streams.startScreenShare,
    stopScreenShare: streams.stopScreenShare,
    switchDevice: streams.switchDevice,
    cleanupWebRTC: streams.cleanupWebRTC,

    handleSimplePeerSignal: streams.handleSimplePeerSignal,
    initiateConnections: streams.initiateConnections,

    cleanupPeer: streams.cleanupPeer,

    kickParticipant,
    canEndConference,
    canKick,

    deriveConferenceStore,
    getConference: conferences.getKeyValue,
    setConference: conferences.setKeyValue,
    updateConference: conferences.updateKeyValue,
    removeConference: conferences.removeKeyValue,
    subscribe: conferences.subscribe,
  };
}
