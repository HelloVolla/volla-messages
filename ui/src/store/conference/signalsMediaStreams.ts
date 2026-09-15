import { decodeHashFromBase64, encodeHashToBase64, type AgentPubKeyB64 } from "@holochain/client";
import {
  FilmstripCarrier,
  VoiceCarrier,
  decideSignalsMediaCadence,
  webCodecsOpus,
  type FilmstripFrame,
  type FilmstripHost,
  type MediaKind,
  type OpusCodec,
  type PeerId,
  type SignalsMediaCadence,
  type TrackHandle,
  type VoiceHost,
} from "@lightningrodlabs/signals-media";
import { SimplePeerSignalType } from "$lib/types";
import { type ConferenceContext, safeGetConference } from "./types";

const PING_INTERVAL_MS = 3000;
const CARRIER_DOWN_INTERVALS = 3;
const RTT_EWMA_ALPHA = 0.2;

interface PingPayload {
  nonce: string;
}
interface PongPayload {
  nonce: string;
}
interface MediaEnvelope {
  kind: MediaKind | "ping" | "pong";
  payload: string;
}

export interface SignalsMediaPeerStats {
  rttMs: number | null;
  voiceJitterMs: number | null;
  voiceLossPercent: number | null;
  videoKbps: number | null;
  videoFpsActual: number | null;
}

export interface SignalsMediaStreams {
  initializeSignalsMedia: (roomId: string) => Promise<void>;
  cleanupSignalsMedia: (roomId: string) => Promise<void>;
  handleMediaFrameSignal: (roomId: string, fromB64: AgentPubKeyB64, data: string) => void;
  subscribeFilmstrip: (
    peerB64: AgentPubKeyB64,
    callback: (frame: FilmstripFrame | null) => void,
  ) => () => void;
  getPeerStats: (peerB64: AgentPubKeyB64) => SignalsMediaPeerStats;
}

export function createSignalsMediaStreams(ctx: ConferenceContext): SignalsMediaStreams {
  const voice = new VoiceCarrier();
  const filmstrip = new FilmstripCarrier();

  let activeRoomId: string | null = null;
  let audioContext: AudioContext | null = null;
  let codec: OpusCodec | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let cadenceMode: SignalsMediaCadence["mode"] = "full";
  let lastPongAtMs = 0;

  const rttEwmaMs = new Map<PeerId, number>();
  const pingsInFlight = new Map<string, number>();
  const devices = new Map<string, { track: MediaStreamTrack; refs: number }>();

  function targets(): ReadonlySet<PeerId> {
    if (!activeRoomId) return new Set();
    const state = safeGetConference(ctx, activeRoomId);
    if (!state) return new Set();
    const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);
    const peers = new Set<PeerId>();
    for (const [pubKey, participant] of state.participants) {
      if (pubKey !== myPubKey && participant.hasJoined) peers.add(pubKey);
    }
    return peers;
  }

  async function acquireShared(
    key: string,
    constraints: MediaStreamConstraints,
  ): Promise<TrackHandle | null> {
    const existing = devices.get(key);
    if (existing) {
      existing.refs += 1;
      return { track: existing.track, release: () => releaseShared(key) };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getTracks()[0];
      devices.set(key, { track, refs: 1 });
      return { track, release: () => releaseShared(key) };
    } catch (e) {
      console.error(`[SignalsMedia] ${key}: getUserMedia failed`, e);
      return null;
    }
  }

  function releaseShared(key: string): void {
    const d = devices.get(key);
    if (!d) return;
    d.refs -= 1;
    if (d.refs > 0) return;
    d.track.stop();
    devices.delete(key);
  }

  async function sendToOne(peerB64: PeerId, kind: MediaKind | "ping" | "pong", payload: string) {
    if (!activeRoomId) return;
    const state = safeGetConference(ctx, activeRoomId);
    if (!state?.cellIdB64) return;
    const cellId = ctx.client.decodeCellId(state.cellIdB64);
    const envelope: MediaEnvelope = { kind, payload };
    try {
      await ctx.client.sendSignal(
        activeRoomId,
        decodeHashFromBase64(peerB64),
        SimplePeerSignalType.MediaFrame,
        JSON.stringify(envelope),
        cellId,
      );
    } catch (e) {
      console.warn(`[SignalsMedia] send to ${peerB64.slice(0, 20)} failed:`, e);
    }
  }

  async function sendToAll(kind: MediaKind | "ping" | "pong", payload: string) {
    await Promise.all([...targets()].map((peer) => sendToOne(peer, kind, payload)));
  }

  const host: VoiceHost & FilmstripHost = {
    targets,
    cadence: () => cadenceMode,
    batchEligible: () => false,
    async send(kind: MediaKind, payload: string, sendTargets: ReadonlySet<PeerId>) {
      await Promise.all([...sendTargets].map((peer) => sendToOne(peer, kind, payload)));
    },
    clock: { now: () => Date.now() },
    log: (line: string) => console.log("[signals-media]", line),
    audioContext: () => audioContext,
    codec: () => {
      if (!codec) throw new Error("opus codec not resolved yet");
      return codec;
    },
    acquireMic: () => acquireShared("mic", { audio: true }),
    acquireCamera: () => acquireShared("camera", { video: { width: 320, height: 240 } }),
  };

  function pingTick(): void {
    const nonce = crypto.randomUUID();
    pingsInFlight.set(nonce, Date.now());
    void sendToAll("ping", JSON.stringify({ nonce } satisfies PingPayload));

    const samples = [...targets()]
      .map((p) => rttEwmaMs.get(p))
      .filter((ms): ms is number => ms !== undefined);
    cadenceMode = decideSignalsMediaCadence({
      carrierDown:
        targets().size > 0 &&
        lastPongAtMs !== 0 &&
        Date.now() - lastPongAtMs > CARRIER_DOWN_INTERVALS * PING_INTERVAL_MS,
      bestRttEwmaMs: samples.length === 0 ? undefined : Math.min(...samples),
      prevMode: cadenceMode,
    }).mode;

    const cutoff = Date.now() - CARRIER_DOWN_INTERVALS * PING_INTERVAL_MS;
    for (const [n, at] of pingsInFlight) if (at < cutoff) pingsInFlight.delete(n);
  }

  function handleMediaFrameSignal(roomId: string, fromB64: AgentPubKeyB64, data: string): void {
    if (roomId !== activeRoomId) return;
    let envelope: MediaEnvelope | null = null;
    try {
      envelope = JSON.parse(data);
    } catch {
      console.warn("[SignalsMedia] dropping unparseable MediaFrame signal");
      return;
    }
    if (!envelope) return;

    switch (envelope.kind) {
      case "voice":
        voice.receiveFrame(fromB64, envelope.payload);
        return;
      case "filmstrip":
        filmstrip.receiveFrame(fromB64, envelope.payload);
        return;
      case "ping": {
        const ping = JSON.parse(envelope.payload) as PingPayload;
        void sendToOne(fromB64, "pong", JSON.stringify({ nonce: ping.nonce } satisfies PongPayload));
        return;
      }
      case "pong": {
        const pong = JSON.parse(envelope.payload) as PongPayload;
        const sentAt = pingsInFlight.get(pong.nonce);
        if (!sentAt) return;
        const rtt = Date.now() - sentAt;
        lastPongAtMs = Date.now();
        const prev = rttEwmaMs.get(fromB64);
        rttEwmaMs.set(
          fromB64,
          prev === undefined ? rtt : RTT_EWMA_ALPHA * rtt + (1 - RTT_EWMA_ALPHA) * prev,
        );
        return;
      }
    }
  }

  async function resolveCodec(): Promise<OpusCodec> {
    const webCodecs = webCodecsOpus();
    if (webCodecs) return webCodecs;
    const { wasmOpus } = await import("@lightningrodlabs/signals-media/opus-wasm");
    return wasmOpus();
  }

  async function initializeSignalsMedia(roomId: string): Promise<void> {
    if (activeRoomId === roomId) return;
    if (activeRoomId) await cleanupSignalsMedia(activeRoomId);
    activeRoomId = roomId;

    audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    await audioContext.resume();
    codec = await resolveCodec();

    voice.bind(host);
    filmstrip.bind(host);

    const localTracks: MediaStreamTrack[] = [];
    const micHandle = await acquireShared("mic", { audio: true });
    if (micHandle) localTracks.push(micHandle.track);
    const camHandle = await acquireShared("camera", { video: { width: 320, height: 240 } });
    if (camHandle) localTracks.push(camHandle.track);

    if (localTracks.length > 0) {
      const localStream = new MediaStream(localTracks);
      ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, localStream }));
    }

    await voice.startCapture();
    await filmstrip.startCapture();

    pingTimer = setInterval(pingTick, PING_INTERVAL_MS);
  }

  async function cleanupSignalsMedia(roomId: string): Promise<void> {
    if (activeRoomId !== roomId) return;
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    rttEwmaMs.clear();
    pingsInFlight.clear();
    lastPongAtMs = 0;
    cadenceMode = "full";

    await Promise.all([voice.stopCapture(), filmstrip.stopCapture()]);
    voice.unbind();
    filmstrip.unbind();

    releaseShared("mic");
    releaseShared("camera");

    await audioContext?.close();
    audioContext = null;
    codec = null;
    activeRoomId = null;
  }

  function subscribeFilmstrip(
    peerB64: AgentPubKeyB64,
    callback: (frame: FilmstripFrame | null) => void,
  ): () => void {
    return filmstrip.subscribe(peerB64, callback);
  }

  function getPeerStats(peerB64: AgentPubKeyB64): SignalsMediaPeerStats {
    const voiceStats = voice.voiceRxStats.get(peerB64);
    const videoStats = filmstrip.signalsVideoStats.get(peerB64);
    return {
      rttMs: rttEwmaMs.get(peerB64) ?? null,
      voiceJitterMs: voiceStats?.jitterMs ?? null,
      voiceLossPercent: voiceStats?.lossPercent ?? null,
      videoKbps: videoStats?.kbps ?? null,
      videoFpsActual: videoStats?.fpsActual ?? null,
    };
  }

  return {
    initializeSignalsMedia,
    cleanupSignalsMedia,
    handleMediaFrameSignal,
    subscribeFilmstrip,
    getPeerStats,
  };
}
