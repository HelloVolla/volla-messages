import SimplePeer from "simple-peer";
import { decodeHashFromBase64 } from "@holochain/client";
import {
  type ConferenceContext,
  ICE_CONFIG,
  CONNECTION_TIMEOUT_MS,
  MEDIA_WAIT_MS,
  SDP_BUFFER_EXPIRY_MS,
  safeGetConference,
  updateParticipant,
  deriveConnectionQuality,
} from "./types";

export interface PeerConnectionHooks {
  cleanupPeer: (roomId: string, pubKey: string) => void;
}

export class PeerConnection {
  readonly peer: SimplePeer.Instance;
  readonly pubKey: string;
  readonly connectionId: string;
  private connectionTimeout?: ReturnType<typeof setTimeout>;
  private lastBytesReceived = 0;
  private stalledTicks = 0;

  constructor(
    private ctx: ConferenceContext,
    private roomId: string,
    pubKey: string,
    connectionId: string,
    initiator: boolean,
    localStream: MediaStream | undefined,
    private hooks: PeerConnectionHooks,
  ) {
    this.pubKey = pubKey;
    this.connectionId = connectionId;

    console.log(
      `[SimplePeer] Creating peer for ${pubKey.slice(0, 20)}, initiator: ${initiator}, connectionId: ${connectionId}`,
    );

    const opts: SimplePeer.Options = {
      initiator,
      config: { iceServers: ICE_CONFIG },
      trickle: false,
      objectMode: true,
    };
    if (localStream) opts.stream = localStream;

    this.peer = new SimplePeer(opts);
    this.wire();

    this.connectionTimeout = setTimeout(() => this.onHandshakeTimeout(), CONNECTION_TIMEOUT_MS);
    this.patch({ connectionTimeout: this.connectionTimeout });

    this.flushBufferedSignals();
  }

  private patch(fields: Partial<Record<string, unknown>>): void {
    updateParticipant(this.ctx, this.roomId, this.pubKey, (p) => ({ ...p, ...fields }));
  }

  private wire(): void {
    this.peer.on("signal", (data) => this.relaySignal(data));
    this.peer.on("data", (raw: unknown) => this.onData(raw));
    this.peer.on("stream", (remoteStream) => this.onStream(remoteStream));
    this.peer.on("iceStateChange", (iceState: RTCIceConnectionState) => this.onIceState(iceState));
    this.peer.on("connect", () => this.onConnect());
    this.peer.on("close", () => this.onClose());
    this.peer.on("error", (err) => this.onError(err));
  }

  private async relaySignal(data: SimplePeer.SignalData): Promise<void> {
    if (this.peer.destroyed) return;
    const state = safeGetConference(this.ctx, this.roomId);
    if (!state?.cellIdB64) {
      this.patch({
        pendingOutgoingSdp: [
          ...(state?.participants.get(this.pubKey)?.pendingOutgoingSdp || []),
          JSON.stringify(data),
        ],
      });
      return;
    }
    try {
      await this.ctx.client.sendSdpData(
        this.roomId,
        decodeHashFromBase64(this.pubKey),
        this.connectionId,
        data,
        this.ctx.client.decodeCellId(state.cellIdB64),
      );
    } catch (error) {
      if (!this.peer.destroyed) console.error(`[SimplePeer] Error sending SDP data:`, error);
    }
  }

  private onData(raw: unknown): void {
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBufferView);
      const msg = JSON.parse(text);
      if (msg && msg.t === "media") {
        this.patch({ videoEnabled: !!msg.video, audioEnabled: !!msg.audio });
      }
    } catch (e) {
      console.warn(`[SimplePeer] Bad data-channel message from ${this.pubKey.slice(0, 20)}:`, e);
    }
  }

  private onStream(remoteStream: MediaStream): void {
    const remoteVideo = remoteStream.getVideoTracks();
    const remoteAudio = remoteStream.getAudioTracks();
    updateParticipant(this.ctx, this.roomId, this.pubKey, (p) => {
      if (p.connectionTimeout) clearTimeout(p.connectionTimeout);
      if (p.mediaWaitTimer) clearTimeout(p.mediaWaitTimer);
      return {
        ...p,
        stream: remoteStream,
        connectionStatus: "connected",
        videoEnabled: p.videoEnabled ?? remoteVideo.some((t) => t.enabled && !t.muted),
        audioEnabled: p.audioEnabled ?? remoteAudio.length > 0,
        connectionTimeout: undefined,
        mediaWaitTimer: undefined,
      };
    });
    this.connectionTimeout = undefined;
  }

  private onIceState(iceState: RTCIceConnectionState): void {
    if (this.peer.destroyed) return;
    const state = safeGetConference(this.ctx, this.roomId);
    if (!state || state.ended) return;
    this.patch({ lastIceState: iceState, connectionQuality: deriveConnectionQuality(iceState) });
  }

  private onConnect(): void {
    const mediaWaitTimer = setTimeout(() => {
      const cur = safeGetConference(this.ctx, this.roomId);
      const p = cur?.participants.get(this.pubKey);
      if (cur && !cur.ended && p && p.hasJoined && !p.stream && !this.peer.destroyed) {
        console.warn(
          `[SimplePeer] No media from ${this.pubKey.slice(0, 20)}, dropping to reconnect`,
        );
        this.hooks.cleanupPeer(this.roomId, this.pubKey);
      }
    }, MEDIA_WAIT_MS);

    updateParticipant(this.ctx, this.roomId, this.pubKey, (p) => {
      if (p.connectionTimeout) clearTimeout(p.connectionTimeout);
      if (p.mediaWaitTimer) clearTimeout(p.mediaWaitTimer);
      return {
        ...p,
        connectionStatus: "connected",
        connectionTimeout: undefined,
        mediaWaitTimer,
      };
    });
    this.connectionTimeout = undefined;

    const state = safeGetConference(this.ctx, this.roomId);
    if (state?.localStream) {
      const video = state.videoEnabled ?? state.localStream.getVideoTracks().some((t) => t.enabled);
      const audio = state.audioEnabled ?? state.localStream.getAudioTracks().some((t) => t.enabled);
      this.sendMediaState(video, audio);
    }
  }

  private onClose(): void {
    console.log(`[SimplePeer] Connection closed with ${this.pubKey.slice(0, 20)}`);
    const state = safeGetConference(this.ctx, this.roomId);
    if (state?.ended) return;
    const p = state?.participants.get(this.pubKey);
    if (!p?.hasJoined) return;
    this.patch({ connectionStatus: "idle" });
  }

  private onError(err: Error): void {
    console.error(`[SimplePeer] Error with ${this.pubKey.slice(0, 20)}:`, err);
    const state = safeGetConference(this.ctx, this.roomId);
    const p = state?.participants.get(this.pubKey);
    if (!p?.hasJoined || state?.ended) return;
    this.patch({ connectionStatus: "failed" });
  }

  private onHandshakeTimeout(): void {
    console.error(`[SimplePeer] Connection timeout for ${this.pubKey.slice(0, 20)}`);
    this.hooks.cleanupPeer(this.roomId, this.pubKey);
  }

  private flushBufferedSignals(): void {
    const state = safeGetConference(this.ctx, this.roomId);
    const participant = state?.participants.get(this.pubKey);
    if (!participant) return;

    if (participant.pendingSdpSignals?.length) {
      const now = Date.now();
      const valid = participant.pendingSdpSignals.filter((s) => {
        try {
          return now - (JSON.parse(s).timestamp || now) < SDP_BUFFER_EXPIRY_MS;
        } catch {
          return false;
        }
      });
      for (const buffered of valid) {
        if (this.peer.destroyed) break;
        try {
          const wrapper = JSON.parse(buffered);
          this.peer.signal(wrapper.sdp || wrapper);
        } catch (error) {
          console.error("[SimplePeer] Error processing buffered SDP signal:", error);
        }
      }
      this.patch({ pendingSdpSignals: [], lastSignalReceived: now });
    }

    if (participant.pendingOutgoingSdp?.length && state?.cellIdB64) {
      const cellId = this.ctx.client.decodeCellId(state.cellIdB64);
      const target = decodeHashFromBase64(this.pubKey);
      for (const outData of participant.pendingOutgoingSdp) {
        this.ctx.client
          .sendSdpData(this.roomId, target, this.connectionId, JSON.parse(outData), cellId)
          .catch((err) => console.error("[SimplePeer] Error sending buffered outgoing SDP:", err));
      }
      this.patch({ pendingOutgoingSdp: [] });
    }
  }

  applyRemoteSignal(data: SimplePeer.SignalData): void {
    if (!this.peer.destroyed) this.peer.signal(data);
  }

  sendMediaState(video: boolean, audio: boolean): void {
    if (!this.peer.connected || this.peer.destroyed) return;
    try {
      this.peer.send(JSON.stringify({ t: "media", video, audio }));
    } catch (e) {
      console.warn(`[SimplePeer] media state send to ${this.pubKey.slice(0, 20)} failed:`, e);
    }
  }

  addVideoTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.peer.destroyed || !this.peer.connected) return;
    try {
      this.peer.addTrack(track, stream);
    } catch (e) {
      console.warn(`[SimplePeer] addTrack to ${this.pubKey.slice(0, 20)} failed:`, e);
    }
  }

  removeVideoTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.peer.destroyed) return;
    try {
      this.peer.removeTrack(track, stream);
    } catch (e) {
      console.warn(`[SimplePeer] removeTrack from ${this.pubKey.slice(0, 20)} failed:`, e);
    }
  }

  replaceVideoTrack(
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    stream: MediaStream,
  ): void {
    if (this.peer.destroyed || !this.peer.connected) return;
    try {
      this.peer.replaceTrack(oldTrack, newTrack, stream);
    } catch (e) {
      console.warn(`[SimplePeer] replaceTrack for ${this.pubKey.slice(0, 20)} failed:`, e);
    }
  }

  async isMediaStalled(): Promise<boolean> {
    if (!this.peer.connected || this.peer.destroyed) {
      this.stalledTicks = 0;
      return false;
    }
    const pc = (this.peer as unknown as { _pc?: RTCPeerConnection })._pc;
    if (!pc) return false;
    try {
      const stats = await pc.getStats();
      let bytes = 0;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp") bytes += (r as RTCInboundRtpStreamStats).bytesReceived || 0;
      });
      if (bytes > this.lastBytesReceived) {
        this.lastBytesReceived = bytes;
        this.stalledTicks = 0;
        return false;
      }
      if (this.lastBytesReceived === 0) return false;
      this.stalledTicks++;
      return this.stalledTicks >= 3;
    } catch {
      return false;
    }
  }
}
