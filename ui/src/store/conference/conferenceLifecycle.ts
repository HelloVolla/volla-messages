import { decodeHashFromBase64, encodeHashToBase64, type AgentPubKeyB64 } from "@holochain/client";
import { type ConferenceRoom, ConferenceRole } from "$lib/types";
import {
  type ConferenceContext,
  type SimplePeerConferenceState,
  MAX_CONFERENCE_PARTICIPANTS,
  safeGetConference,
  updateParticipant,
} from "./types";

export interface ConferenceLifecycle {
  createConference: (
    participants: AgentPubKeyB64[],
    cellIdB64?: string,
    initiatorPubKeyB64?: AgentPubKeyB64,
  ) => Promise<string>;
  joinConference: (roomId: string, participants: AgentPubKeyB64[]) => Promise<void>;
  acceptConferenceInvitation: (roomId: string) => Promise<void>;
  rejectConferenceInvitation: (roomId: string) => Promise<void>;
  leaveConference: (roomId: string) => Promise<void>;
  endConferenceForAll: (roomId: string) => Promise<void>;
}

export type CleanupPeerFn = (roomId: string, pubKey: string) => void;
export type CleanupWebRTCFn = (roomId: string) => void;

export function createConferenceLifecycle(
  ctx: ConferenceContext,
  cleanupPeer: CleanupPeerFn,
  cleanupWebRTC: CleanupWebRTCFn,
): ConferenceLifecycle {
  async function createConference(
    participants: AgentPubKeyB64[],
    cellIdB64?: string,
    initiatorPubKeyB64?: AgentPubKeyB64,
  ): Promise<string> {
    if (!cellIdB64) {
      throw new Error("cellIdB64 is required for creating a conference");
    }

    const totalParticipants = participants.length + 1;
    if (totalParticipants > MAX_CONFERENCE_PARTICIPANTS) {
      throw new Error(
        `Cannot create conference with ${totalParticipants} participants. Maximum is ${MAX_CONFERENCE_PARTICIPANTS} for mesh topology.`,
      );
    }

    const participantsEncoded = participants.map((p) => decodeHashFromBase64(p));
    const cellId = ctx.client.decodeCellId(cellIdB64);
    const outcome = await ctx.client.createConference(participantsEncoded, cellId);

    const roomId = outcome.room_id;
    if (!roomId) throw new Error("Failed to create conference room");

    const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);

    if (outcome.joined_existing) {
      const existing = safeGetConference(ctx, roomId);
      if (existing) {
        ctx.conferences.updateKeyValue(roomId, (s) => {
          const merged = new Map(s.participants);
          const mine = merged.get(myPubKey);
          merged.set(myPubKey, {
            ...(mine ?? {}),
            publicKey: myPubKey,
            hasJoined: true,
            connectionStatus: mine?.connectionStatus ?? "idle",
          });
          return {
            ...s,
            participants: merged,
            isInitiator: false,
            ended: false,
            cellIdB64,
            invitationStatus: "accepted",
            startTime: s.startTime ?? Date.now(),
          };
        });
        return roomId;
      }

      const joinerState: SimplePeerConferenceState = {
        room: { participants: participantsEncoded, room_id: roomId },
        participants: new Map(
          participants.map((p) => [
            p,
            {
              publicKey: p,
              hasJoined: false,
              connectionStatus: "idle" as const,
            },
          ]),
        ),
        isInitiator: false,
        ended: false,
        cellIdB64,
        startTime: Date.now(),
        initiatorPubKeyB64,
        invitationStatus: "accepted",
      };
      joinerState.participants.set(myPubKey, {
        publicKey: myPubKey,
        hasJoined: true,
        connectionStatus: "idle",
      });
      ctx.conferences.setKeyValue(roomId, joinerState);
      return roomId;
    }

    const room: ConferenceRoom = {
      participants: participantsEncoded,
      room_id: roomId,
    };

    const state: SimplePeerConferenceState = {
      room,
      participants: new Map(
        participants.map((p) => [
          p,
          {
            publicKey: p,
            hasJoined: false,
            connectionStatus: "idle" as const,
          },
        ]),
      ),
      isInitiator: true,
      ended: false,
      cellIdB64,
      startTime: Date.now(),
      initiatorPubKeyB64,
      invitationStatus: "accepted",
    };

    state.participants.set(myPubKey, {
      publicKey: myPubKey,
      hasJoined: true,
      connectionStatus: "idle",
      role: ConferenceRole.Host,
    });

    state.myRole = ConferenceRole.Host;
    state.currentHostPubKeyB64 = myPubKey;
    state.rolesFetchedAt = Date.now();

    ctx.conferences.setKeyValue(room.room_id, state);

    return room.room_id;
  }

  async function joinConference(roomId: string, participants: AgentPubKeyB64[]): Promise<void> {
    const existingState = safeGetConference(ctx, roomId);
    const participantsDecoded = participants.map((p) => decodeHashFromBase64(p));

    if (existingState) {
      if (!existingState.cellIdB64) {
        throw new Error("Conference state must have cellIdB64");
      }
      const cellId = ctx.client.decodeCellId(existingState.cellIdB64);
      await ctx.client.joinConference(roomId, participantsDecoded, cellId);
      return;
    }

    const state: SimplePeerConferenceState = {
      room: {
        room_id: roomId,
        participants: participantsDecoded,
      },
      participants: new Map(
        participants.map((p) => [
          p,
          {
            publicKey: p,
            hasJoined: false,
            connectionStatus: "idle" as const,
          },
        ]),
      ),
      isInitiator: false,
      ended: false,
    };

    ctx.conferences.setKeyValue(roomId, state);
    console.warn("[SimplePeer] joinConference called without existing conference state");
  }

  async function acceptConferenceInvitation(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    if (!state.cellIdB64) {
      throw new Error("Conference state must have cellIdB64");
    }

    if (state.invitationTimeoutHandle) {
      clearTimeout(state.invitationTimeoutHandle);
    }

    const isRejoining = state.invitationStatus === "left" && state.leftTimestamp !== undefined;

    if (isRejoining) {
      console.log(`[SimplePeer] Rejoining conference: ${roomId}`);
      const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);
      for (const [pubKey] of state.participants) {
        if (pubKey !== myPubKey) {
          cleanupPeer(roomId, pubKey);
        }
      }
    }

    const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);

    ctx.conferences.updateKeyValue(roomId, (conf) => ({
      ...conf,
      invitationStatus: "accepted" as const,
      invitationTimeoutHandle: undefined,
      leftTimestamp: undefined,
      rejoiningTimestamp: isRejoining ? Date.now() : undefined,
      myRole: ConferenceRole.Member,
      rolesFetchedAt: Date.now(),
      cleaningUp: false,
    }));

    updateParticipant(ctx, roomId, myPubKey, (p) => ({
      ...p,
      role: ConferenceRole.Member,
    }));

    const cellId = ctx.client.decodeCellId(state.cellIdB64);
    const participants = Array.from(state.participants.keys());
    await ctx.client.joinConference(
      roomId,
      participants.map((p) => decodeHashFromBase64(p)),
      cellId,
    );
  }

  async function rejectConferenceInvitation(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    if (state.invitationTimeoutHandle) {
      clearTimeout(state.invitationTimeoutHandle);
    }

    if (!state.cellIdB64) {
      console.warn("Conference state missing cellIdB64, skipping reject signal");
      ctx.conferences.removeKeyValue(roomId);
      return;
    }

    ctx.conferences.updateKeyValue(roomId, (conf) => ({
      ...conf,
      invitationStatus: "rejected" as const,
      invitationTimeoutHandle: undefined,
    }));

    try {
      const cellId = ctx.client.decodeCellId(state.cellIdB64);
      const participantsDecoded = Array.from(state.participants.keys()).map((p) =>
        decodeHashFromBase64(p),
      );
      await ctx.client.rejectConference(roomId, participantsDecoded, cellId);
    } catch (e) {
      console.error("Failed to send reject signal", e);
    }
    setTimeout(() => {
      const cur = safeGetConference(ctx, roomId);
      if (cur && cur.invitationStatus === "rejected") {
        ctx.conferences.removeKeyValue(roomId);
      }
    }, 1000);
  }

  async function leaveConference(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);

    if (state.cellIdB64) {
      try {
        await ctx.client.leaveConference(roomId, ctx.client.decodeCellId(state.cellIdB64));
      } catch (e) {
        console.error("[SimplePeer] leaveConference DHT write failed; leaving locally anyway:", e);
      }
    }

    cleanupWebRTC(roomId);

    const othersActive = Array.from(state.participants.entries()).some(
      ([pk, p]) => pk !== myPubKey && p.hasJoined,
    );

    ctx.conferences.updateKeyValue(roomId, (conf) => ({
      ...conf,
      localStream: undefined,
      leftTimestamp: Date.now(),
      invitationStatus: "left" as const,
      ended: othersActive ? conf.ended : true,
      endedByMe: othersActive ? conf.endedByMe : true,
    }));

    if (!othersActive) {
      setTimeout(() => {
        const cur = safeGetConference(ctx, roomId);
        if (cur && (cur.ended || cur.invitationStatus === "left")) {
          ctx.conferences.removeKeyValue(roomId);
        }
      }, 500);
    }

    console.log(`[SimplePeer] Left conference: ${roomId}`);
  }

  async function endConferenceForAll(roomId: string): Promise<void> {
    const conference = safeGetConference(ctx, roomId);
    if (!conference) return;

    ctx.conferences.updateKeyValue(roomId, (conf) => ({
      ...conf,
      ended: true,
      endedByMe: true,
      invitationStatus: "left" as const,
    }));
    cleanupWebRTC(roomId);

    const participants = conference.room?.participants;
    if (conference.cellIdB64 && participants) {
      const cellId = ctx.client.decodeCellId(conference.cellIdB64);
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await ctx.client.endConferenceForAll(roomId, participants, cellId);
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes("Source chain error") && attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
            continue;
          }
          console.error("[SimplePeer] Failed to notify peers about conference end:", errorMessage);
          break;
        }
      }
    }

    setTimeout(() => {
      const cur = safeGetConference(ctx, roomId);
      if (cur && cur.ended) {
        ctx.conferences.removeKeyValue(roomId);
      }
    }, 500);
  }

  return {
    createConference,
    joinConference,
    acceptConferenceInvitation,
    rejectConferenceInvitation,
    leaveConference,
    endConferenceForAll,
  };
}
