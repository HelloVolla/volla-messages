import {
  decodeHashFromBase64,
  encodeHashToBase64,
  type AgentPubKey,
  type AgentPubKeyB64,
} from "@holochain/client";
import { SimplePeerSignalType, type SimplePeerSignalPayload } from "$lib/types";
import { PeerConnection, type PeerConnectionHooks } from "./peerConnection";
import {
  type ConferenceContext,
  type CleanupReport,
  type PeerCleanupReport,
  HEARTBEAT_INTERVAL_MS,
  INIT_RETRY_MS,
  PONG_STALE_MS,
  MEDIA_STATE_DEBOUNCE_MS,
  safeGetConference,
  updateParticipant,
  isParticipantConnected,
  isParticipantDestroyed,
  generateConnectionId,
} from "./types";

export interface ConferenceStreams {
  createPeer: (
    roomId: string,
    pubKey: string,
    connectionId: string,
    initiator: boolean,
    stream: MediaStream,
  ) => PeerConnection;
  cleanupPeer: (roomId: string, pubKey: string) => void;
  cleanupPeerWithVerification: (roomId: string, pubKey: string) => PeerCleanupReport;
  handleSimplePeerSignal: (roomId: string, signal: SimplePeerSignalPayload) => void;
  initiateConnections: (roomId: string) => Promise<void>;
  startConnectionHealthMonitoring: (roomId: string) => void;
  stopConnectionHealthMonitoring: (roomId: string) => void;
  getUserMediaWithFallback: () => Promise<MediaStream>;
  sendMediaStateToAll: (roomId: string, video: boolean, audio: boolean) => Promise<void>;
  setLocalVideo: (roomId: string, enabled: boolean) => Promise<void>;
  startScreenShare: (roomId: string) => Promise<void>;
  stopScreenShare: (roomId: string) => Promise<void>;
  switchDevice: (roomId: string, kind: "audio" | "video", deviceId: string) => Promise<void>;
  initializeWebRTC: (roomId: string) => Promise<void>;
  cleanupWebRTC: (roomId: string) => void;
  blockParticipant: (roomId: string, targetB64: string) => void;
}

export function createConferenceStreams(ctx: ConferenceContext): ConferenceStreams {
  const hooks: PeerConnectionHooks = { cleanupPeer };
  const initializingRooms = new Set<string>();
  const screenShares = new Map<
    string,
    { screen: MediaStreamTrack; camera: MediaStreamTrack | null }
  >();
  const blockedAgents = new Set<string>();

  function createPeer(
    roomId: string,
    participantPubKey: string,
    connectionId: string,
    initiator: boolean,
    localStream?: MediaStream,
  ): PeerConnection {
    return new PeerConnection(
      ctx,
      roomId,
      participantPubKey,
      connectionId,
      initiator,
      localStream,
      hooks,
    );
  }

  function cleanupPeer(roomId: string, pubKey: string): void {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    const participant = state.participants.get(pubKey);
    if (!participant) return;

    if (participant.connectionTimeout) clearTimeout(participant.connectionTimeout);
    if (participant.mediaWaitTimer) clearTimeout(participant.mediaWaitTimer);

    if (participant.peer && !participant.peer.destroyed) {
      try {
        participant.peer.destroy();
      } catch (e) {
        console.warn(`[SimplePeer] Error destroying peer for ${pubKey.slice(0, 20)}:`, e);
      }
    }

    updateParticipant(ctx, roomId, pubKey, (p) => ({
      publicKey: p.publicKey,
      hasJoined: p.hasJoined,
      connectionStatus: "idle",
      videoEnabled: p.videoEnabled,
      audioEnabled: p.audioEnabled,
      peer: undefined,
      conn: undefined,
      stream: undefined,
      connectionId: undefined,
      pendingSdpSignals: [],
      connectionTimeout: undefined,
      mediaWaitTimer: undefined,
      lastIceState: undefined,
      pendingInitRequest: undefined,
    }));

    console.log(`[SimplePeer] Cleaned up peer connection: ${pubKey.slice(0, 20)}`);
  }

  function cleanupPeerWithVerification(roomId: string, pubKey: string): PeerCleanupReport {
    const report: PeerCleanupReport = {
      peersDestroyed: 0,
      timersCleared: 0,
      buffersCleared: 0,
      errors: [],
    };
    const state = safeGetConference(ctx, roomId);
    if (!state) return report;
    const participant = state.participants.get(pubKey);
    if (!participant) return report;

    for (const timer of [participant.connectionTimeout, participant.mediaWaitTimer]) {
      if (timer) {
        try {
          clearTimeout(timer);
          report.timersCleared++;
        } catch (e) {
          report.errors.push(`Error clearing timer for ${pubKey.slice(0, 20)}: ${e}`);
        }
      }
    }

    if (participant.peer && !participant.peer.destroyed) {
      try {
        participant.peer.destroy();
        report.peersDestroyed++;
      } catch (e) {
        report.errors.push(`Error destroying peer for ${pubKey.slice(0, 20)}: ${e}`);
      }
    }

    report.buffersCleared +=
      (participant.pendingSdpSignals?.length || 0) + (participant.pendingOutgoingSdp?.length || 0);

    try {
      updateParticipant(ctx, roomId, pubKey, (p) => ({
        publicKey: p.publicKey,
        hasJoined: p.hasJoined,
        connectionStatus: "idle",
        videoEnabled: p.videoEnabled,
        audioEnabled: p.audioEnabled,
        peer: undefined,
        conn: undefined,
        stream: undefined,
        connectionId: undefined,
        pendingSdpSignals: [],
        pendingOutgoingSdp: [],
        connectionTimeout: undefined,
        lastSignalReceived: undefined,
        lastIceState: undefined,
      }));
    } catch (e) {
      report.errors.push(`Error resetting participant state for ${pubKey.slice(0, 20)}: ${e}`);
    }

    return report;
  }

  function handleSimplePeerSignal(roomId: string, signal: SimplePeerSignalPayload): void {
    const state = safeGetConference(ctx, roomId);
    if (!state) {
      console.warn(`[SimplePeer] No conference state for room ${roomId}`);
      return;
    }
    if (state.ended) return;

    const sender = state.participants.get(signal.from);
    if (sender && !sender.hasJoined) {
      updateParticipant(ctx, roomId, signal.from, (p) => ({ ...p, hasJoined: true }));
    }

    switch (signal.signal_type) {
      case SimplePeerSignalType.InitRequest:
        handleInitRequest(roomId, signal);
        break;
      case SimplePeerSignalType.InitAccept:
        handleInitAccept(roomId, signal);
        break;
      case SimplePeerSignalType.SdpData:
        handleSdpData(roomId, signal);
        break;
      default:
        console.warn(`[SimplePeer] Unknown signal type: ${signal.signal_type}`);
    }
  }

  function handleInitRequest(roomId: string, signal: SimplePeerSignalPayload): void {
    const state = safeGetConference(ctx, roomId);
    if (!state?.cellIdB64) return;
    if (blockedAgents.has(signal.from)) return;

    const participant = state.participants.get(signal.from);
    if (participant?.peer && !isParticipantDestroyed(participant)) return;

    if (!state.localStream) {
      updateParticipant(ctx, roomId, signal.from, (p) => ({ ...p, pendingInitRequest: signal }));
      return;
    }

    const conn = createPeer(roomId, signal.from, signal.connection_id, false, state.localStream);
    updateParticipant(ctx, roomId, signal.from, (p) => ({
      ...p,
      peer: conn.peer,
      conn,
      connectionId: signal.connection_id,
      connectionStatus: "init-received",
    }));

    const cellId = ctx.client.decodeCellId(state.cellIdB64);
    ctx.client
      .sendInitAccept(roomId, decodeHashFromBase64(signal.from), signal.connection_id, cellId)
      .catch((error) => console.error("[SimplePeer] Error sending InitAccept:", error));
  }

  function handleInitAccept(roomId: string, signal: SimplePeerSignalPayload): void {
    if (blockedAgents.has(signal.from)) return;
    const state = safeGetConference(ctx, roomId);
    if (!state?.localStream) return;

    const participant = state.participants.get(signal.from);
    if (participant?.peer && !isParticipantDestroyed(participant)) return;

    if (
      participant?.connectionStatus !== "init-sent" ||
      participant.connectionId !== signal.connection_id
    ) {
      console.warn(
        `[SimplePeer] Ignoring InitAccept from ${signal.from.slice(0, 20)} - no matching pending init`,
      );
      return;
    }

    const conn = createPeer(roomId, signal.from, signal.connection_id, true, state.localStream);
    updateParticipant(ctx, roomId, signal.from, (p) => ({
      ...p,
      peer: conn.peer,
      conn,
      connectionId: signal.connection_id,
      connectionStatus: "connecting",
    }));
  }

  function handleSdpData(roomId: string, signal: SimplePeerSignalPayload): void {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    const participant = state.participants.get(signal.from);
    if (!participant?.conn || isParticipantDestroyed(participant)) {
      updateParticipant(ctx, roomId, signal.from, (p) => ({
        ...p,
        pendingSdpSignals: [...(p.pendingSdpSignals || []), signal.data],
      }));
      return;
    }

    try {
      const wrapper = JSON.parse(signal.data);
      participant.conn.applyRemoteSignal(wrapper.sdp || wrapper);
    } catch (error) {
      console.error("[SimplePeer] Error parsing/signaling SDP data:", error);
    }
  }

  async function initiateConnections(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state?.localStream || !state.cellIdB64) return;

    const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);
    const cellId = ctx.client.decodeCellId(state.cellIdB64);
    const now = Date.now();

    for (const [pubKey, participant] of state.participants.entries()) {
      if (pubKey === myPubKey) continue;
      if (blockedAgents.has(pubKey)) continue;
      if (participant.declined) continue;
      if (isParticipantConnected(participant)) continue;
      if (participant.peer && !isParticipantDestroyed(participant)) continue;

      if (
        participant.connectionStatus === "init-sent" &&
        participant.initSentAt !== undefined &&
        now - participant.initSentAt < INIT_RETRY_MS
      ) {
        continue;
      }

      if (participant.lastPongAt !== undefined && now - participant.lastPongAt > PONG_STALE_MS) {
        continue;
      }

      if (myPubKey < pubKey) {
        const connectionId = generateConnectionId();
        updateParticipant(ctx, roomId, pubKey, (p) => ({
          ...p,
          connectionId,
          connectionStatus: "init-sent",
          initSentAt: now,
        }));
        try {
          await ctx.client.sendInitRequest(
            roomId,
            decodeHashFromBase64(pubKey),
            connectionId,
            cellId,
          );
        } catch (error) {
          console.error(`[SimplePeer] Error sending InitRequest to ${pubKey.slice(0, 20)}:`, error);
          updateParticipant(ctx, roomId, pubKey, (p) => ({ ...p, connectionStatus: "idle" }));
        }
      }
    }
  }

  function startConnectionHealthMonitoring(roomId: string): void {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;
    if (state.healthMonitorInterval) clearInterval(state.healthMonitorInterval);

    const interval = setInterval(() => {
      const currentState = safeGetConference(ctx, roomId);
      if (!currentState || currentState.ended) {
        stopConnectionHealthMonitoring(roomId);
        return;
      }

      const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);
      const now = Date.now();

      const gone: string[] = [];
      currentState.participants.forEach((participant, pubKey) => {
        if (pubKey === myPubKey) return;

        if (blockedAgents.has(pubKey)) {
          gone.push(pubKey);
          return;
        }

        const stale =
          participant.lastPongAt !== undefined &&
          now - participant.lastPongAt > PONG_STALE_MS &&
          !isParticipantConnected(participant);
        if (stale) {
          gone.push(pubKey);
          return;
        }

        const broken =
          !isParticipantConnected(participant) &&
          ((participant.peer && isParticipantDestroyed(participant)) ||
            participant.lastIceState === "failed" ||
            participant.connectionStatus === "failed");
        if (broken) cleanupPeer(roomId, pubKey);
      });

      if (gone.length > 0) {
        for (const pubKey of gone) {
          console.warn(
            `[SimplePeer] Peer ${pubKey.slice(0, 20)} silent >${PONG_STALE_MS}ms — removing`,
          );
          cleanupPeer(roomId, pubKey);
        }
        ctx.conferences.updateKeyValue(roomId, (conf) => {
          const next = new Map(conf.participants);
          for (const pubKey of gone) next.delete(pubKey);
          return { ...conf, participants: next };
        });
      }

      const liveState = safeGetConference(ctx, roomId) ?? currentState;
      const remoteAgents: AgentPubKey[] = [];
      let healthy = 0;
      let total = 0;
      liveState.participants.forEach((participant, pubKey) => {
        if (pubKey === myPubKey) return;
        total++;
        remoteAgents.push(decodeHashFromBase64(pubKey));
        if (isParticipantConnected(participant)) {
          healthy++;
          participant.conn?.isMediaStalled().then((stalled) => {
            if (stalled) {
              console.warn(`[SimplePeer] Media stalled from ${pubKey.slice(0, 20)} — reconnecting`);
              cleanupPeer(roomId, pubKey);
            }
          });
        }
      });

      if (remoteAgents.length > 0 && currentState.cellIdB64) {
        ctx.client
          .pingAgents(ctx.client.decodeCellId(currentState.cellIdB64), remoteAgents)
          .catch((error) => console.warn("[SimplePeer] heartbeat ping failed:", error));
      }

      initiateConnections(roomId).catch((error) =>
        console.error("[SimplePeer] heartbeat initiate failed:", error),
      );

      console.log(`[SimplePeer] Heartbeat ${roomId.slice(0, 12)}: ${healthy}/${total} connected`);
    }, HEARTBEAT_INTERVAL_MS);

    ctx.conferences.updateKeyValue(roomId, (conf) => ({
      ...conf,
      healthMonitorInterval: interval,
    }));
  }

  function stopConnectionHealthMonitoring(roomId: string): void {
    const state = safeGetConference(ctx, roomId);
    if (state?.healthMonitorInterval) {
      clearInterval(state.healthMonitorInterval);
      ctx.conferences.updateKeyValue(roomId, (conf) => ({
        ...conf,
        healthMonitorInterval: undefined,
      }));
    }
  }

  async function getUserMediaWithFallback(): Promise<MediaStream> {
    const constraints = [
      {
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          facingMode: "user",
        },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      },
      { video: { width: { ideal: 320, max: 640 }, height: { ideal: 240, max: 480 } }, audio: true },
      {
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      },
      { audio: true },
    ];

    let lastError: Error | null = null;
    for (const constraint of constraints) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraint);
      } catch (error) {
        lastError = error as Error;
        console.warn("[SimplePeer] getUserMedia attempt failed:", constraint, error);
      }
    }

    if (lastError instanceof DOMException) {
      switch (lastError.name) {
        case "NotAllowedError":
          throw new Error(
            "Camera/microphone access denied. Please allow camera and microphone permissions, then try again.",
          );
        case "NotFoundError":
          throw new Error(
            "No camera or microphone found. Please connect one and refresh the page.",
          );
        case "NotReadableError":
          throw new Error(
            "Camera/microphone is already in use by another application. Close it and try again.",
          );
        case "OverconstrainedError":
          throw new Error("Your camera/microphone doesn't support the required settings.");
        case "SecurityError":
          throw new Error("Camera/microphone access blocked. Ensure you're using HTTPS.");
        case "AbortError":
          throw new Error("Camera/microphone access was interrupted. Please try again.");
      }
    }
    throw new Error("Unable to access camera or microphone. Check your device and permissions.");
  }

  async function sendMediaStateToAll(
    roomId: string,
    videoEnabled: boolean,
    audioEnabled: boolean,
  ): Promise<void> {
    const existingTimer = ctx.mediaStateDebounceTimers.get(roomId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      ctx.mediaStateDebounceTimers.delete(roomId);
      const state = safeGetConference(ctx, roomId);
      if (!state) return;
      const selfPubKeyB64 = encodeHashToBase64(ctx.client.client.myPubKey);
      state.participants.forEach((participant, pubKey) => {
        if (pubKey === selfPubKeyB64) return;
        participant.conn?.sendMediaState(videoEnabled, audioEnabled);
      });
    }, MEDIA_STATE_DEBOUNCE_MS);

    ctx.mediaStateDebounceTimers.set(roomId, timer);
  }

  async function setLocalVideo(roomId: string, enabled: boolean): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state?.localStream) return;
    const stream = state.localStream;
    const selfPubKeyB64 = encodeHashToBase64(ctx.client.client.myPubKey);
    const existing = stream.getVideoTracks()[0];

    if (enabled) {
      if (existing) {
        existing.enabled = true;
      } else {
        let videoTrack: MediaStreamTrack;
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          videoTrack = cam.getVideoTracks()[0];
        } catch (e) {
          console.error("[SimplePeer] setLocalVideo: camera acquire failed:", e);
          return;
        }
        stream.addTrack(videoTrack);
        state.participants.forEach((p, pk) => {
          if (pk === selfPubKeyB64) return;
          p.conn?.addVideoTrack(videoTrack, stream);
        });
      }
    } else if (existing) {
      state.participants.forEach((p, pk) => {
        if (pk === selfPubKeyB64) return;
        p.conn?.removeVideoTrack(existing, stream);
      });
      stream.removeTrack(existing);
      try {
        existing.stop();
      } catch {
        /* already stopped */
      }
    }

    const audioEnabled = stream.getAudioTracks().some((t) => t.enabled);
    ctx.conferences.updateKeyValue(roomId, (c) => ({
      ...c,
      videoEnabled: enabled,
      localStream: stream,
    }));
    state.participants.forEach((p, pk) => {
      if (pk === selfPubKeyB64) return;
      p.conn?.sendMediaState(enabled, audioEnabled);
    });
  }

  async function startScreenShare(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state?.localStream || screenShares.has(roomId)) return;
    const stream = state.localStream;
    const self = encodeHashToBase64(ctx.client.client.myPubKey);

    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) {
      console.warn("[SimplePeer] screen share denied/failed:", e);
      return;
    }
    const screen = display.getVideoTracks()[0];
    if (!screen) return;
    const camera = stream.getVideoTracks()[0] ?? null;

    state.participants.forEach((p, pk) => {
      if (pk === self) return;
      if (camera) p.conn?.replaceVideoTrack(camera, screen, stream);
      else p.conn?.addVideoTrack(screen, stream);
    });

    if (camera) stream.removeTrack(camera);
    stream.addTrack(screen);
    screenShares.set(roomId, { screen, camera });
    screen.onended = () => void stopScreenShare(roomId);

    const audio = stream.getAudioTracks().some((t) => t.enabled);
    ctx.conferences.updateKeyValue(roomId, (c) => ({
      ...c,
      isScreenSharing: true,
      videoEnabled: true,
      localStream: stream,
    }));
    state.participants.forEach((p, pk) => {
      if (pk !== self) p.conn?.sendMediaState(true, audio);
    });
  }

  async function stopScreenShare(roomId: string): Promise<void> {
    const share = screenShares.get(roomId);
    const state = safeGetConference(ctx, roomId);
    if (!share || !state?.localStream) return;
    const stream = state.localStream;
    const self = encodeHashToBase64(ctx.client.client.myPubKey);
    screenShares.delete(roomId);

    let camera = share.camera && share.camera.readyState !== "ended" ? share.camera : null;
    if (!camera) {
      try {
        camera = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
      } catch {
        camera = null;
      }
    }

    state.participants.forEach((p, pk) => {
      if (pk === self) return;
      if (camera) p.conn?.replaceVideoTrack(share.screen, camera, stream);
      else p.conn?.removeVideoTrack(share.screen, stream);
    });

    stream.removeTrack(share.screen);
    try {
      share.screen.stop();
    } catch {
      /* already stopped */
    }
    if (camera && !stream.getVideoTracks().includes(camera)) stream.addTrack(camera);

    const videoOn = !!camera;
    const audio = stream.getAudioTracks().some((t) => t.enabled);
    ctx.conferences.updateKeyValue(roomId, (c) => ({
      ...c,
      isScreenSharing: false,
      videoEnabled: videoOn,
      localStream: stream,
    }));
    state.participants.forEach((p, pk) => {
      if (pk !== self) p.conn?.sendMediaState(videoOn, audio);
    });
  }

  async function switchDevice(
    roomId: string,
    kind: "audio" | "video",
    deviceId: string,
  ): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state?.localStream) return;
    const stream = state.localStream;
    const self = encodeHashToBase64(ctx.client.client.myPubKey);

    let newTrack: MediaStreamTrack | undefined;
    try {
      const constraints: MediaStreamConstraints =
        kind === "audio"
          ? { audio: { deviceId: { exact: deviceId } } }
          : { video: { deviceId: { exact: deviceId } } };
      const media = await navigator.mediaDevices.getUserMedia(constraints);
      newTrack = kind === "audio" ? media.getAudioTracks()[0] : media.getVideoTracks()[0];
    } catch (e) {
      console.warn("[SimplePeer] switchDevice getUserMedia failed:", e);
      return;
    }
    if (!newTrack) return;

    const share = screenShares.get(roomId);
    if (kind === "video" && share) {
      newTrack.enabled = state.videoEnabled ?? true;
      if (share.camera && share.camera !== newTrack) {
        try {
          share.camera.stop();
        } catch {
          void 0;
        }
      }
      screenShares.set(roomId, { screen: share.screen, camera: newTrack });
      return;
    }

    const oldTrack = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    newTrack.enabled = oldTrack
      ? oldTrack.enabled
      : kind === "audio"
        ? (state.audioEnabled ?? true)
        : (state.videoEnabled ?? true);

    await Promise.all(
      [...state.participants].map(([pk, p]) =>
        pk !== self && p.conn ? p.conn.replaceLocalTrack(kind, newTrack!) : Promise.resolve(false),
      ),
    );

    if (oldTrack) {
      stream.removeTrack(oldTrack);
      try {
        oldTrack.stop();
      } catch {
        void 0;
      }
    }
    stream.addTrack(newTrack);

    ctx.conferences.updateKeyValue(roomId, (c) => ({ ...c, localStream: stream }));
  }

  async function initializeWebRTC(roomId: string): Promise<void> {
    if (initializingRooms.has(roomId)) return;
    initializingRooms.add(roomId);
    try {
      await initializeWebRTCInner(roomId);
    } finally {
      initializingRooms.delete(roomId);
    }
  }

  async function initializeWebRTCInner(roomId: string): Promise<void> {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;

    const isRejoining =
      state.rejoiningTimestamp !== undefined && Date.now() - state.rejoiningTimestamp < 10000;

    if (state.localStream && !isRejoining) return;

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
      const myPubKey = encodeHashToBase64(ctx.client.client.myPubKey);
      for (const [pubKey] of state.participants) {
        if (pubKey !== myPubKey) cleanupPeer(roomId, pubKey);
      }
      ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, localStream: undefined }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      const stream = await getUserMediaWithFallback();
      ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, localStream: stream }));

      const updatedState = safeGetConference(ctx, roomId);
      const videoEnabled = updatedState?.videoEnabled ?? true;
      const audioEnabled = updatedState?.audioEnabled ?? true;

      stream.getVideoTracks().forEach((track) => (track.enabled = videoEnabled));
      stream.getAudioTracks().forEach((track) => (track.enabled = audioEnabled));

      if (updatedState) {
        for (const [pubKey, participant] of updatedState.participants.entries()) {
          if (participant.pendingInitRequest) {
            const bufferedSignal = participant.pendingInitRequest;
            updateParticipant(ctx, roomId, pubKey, (p) => ({
              ...p,
              pendingInitRequest: undefined,
            }));
            handleInitRequest(roomId, bufferedSignal);
          }
        }
      }

      await sendMediaStateToAll(roomId, videoEnabled, audioEnabled);
      await initiateConnections(roomId);
      startConnectionHealthMonitoring(roomId);

      ctx.conferences.updateKeyValue(roomId, (conf) => ({
        ...conf,
        rejoiningTimestamp: undefined,
      }));
    } catch (error) {
      console.error("[SimplePeer] Error initializing WebRTC:", error);
      stopConnectionHealthMonitoring(roomId);
      ctx.conferences.updateKeyValue(roomId, (conf) => ({
        ...conf,
        error: error instanceof Error ? error.message : "Failed to initialize WebRTC",
        rejoiningTimestamp: undefined,
      }));
    }
  }

  function cleanupWebRTC(roomId: string): void {
    const state = safeGetConference(ctx, roomId);
    if (!state) return;
    if (state.cleaningUp) return;

    ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, cleaningUp: true }));
    screenShares.delete(roomId);

    try {
      stopConnectionHealthMonitoring(roomId);

      const mediaStateTimer = ctx.mediaStateDebounceTimers.get(roomId);
      if (mediaStateTimer) {
        clearTimeout(mediaStateTimer);
        ctx.mediaStateDebounceTimers.delete(roomId);
      }

      const cleanupReport: CleanupReport = {
        localStreamsStopped: 0,
        peersDestroyed: 0,
        timersCleared: 0,
        buffersCleared: 0,
        errors: [],
      };

      if (state.localStream) {
        const tracks = state.localStream.getTracks();
        cleanupReport.localStreamsStopped = tracks.length;
        tracks.forEach((track) => {
          try {
            track.onended = null;
            track.onmute = null;
            track.onunmute = null;
            track.stop();
          } catch (e) {
            cleanupReport.errors.push(`Error stopping local track: ${e}`);
          }
        });
      }

      for (const [pubKey] of state.participants.entries()) {
        const peerCleanupReport = cleanupPeerWithVerification(roomId, pubKey);
        cleanupReport.peersDestroyed += peerCleanupReport.peersDestroyed;
        cleanupReport.timersCleared += peerCleanupReport.timersCleared;
        cleanupReport.buffersCleared += peerCleanupReport.buffersCleared;
        cleanupReport.errors.push(...peerCleanupReport.errors);
      }

      ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, localStream: undefined }));

      if (cleanupReport.errors.length > 0) {
        console.warn(`[SimplePeer] Cleanup completed with ${cleanupReport.errors.length} issues`);
      }
    } finally {
      ctx.conferences.updateKeyValue(roomId, (conf) => ({ ...conf, cleaningUp: false }));
    }
  }

  function blockParticipant(roomId: string, targetB64: string): void {
    blockedAgents.add(targetB64);
    cleanupPeer(roomId, targetB64);
    ctx.conferences.updateKeyValue(roomId, (conf) => {
      if (!conf.participants.has(targetB64)) return conf;
      const next = new Map(conf.participants);
      next.delete(targetB64);
      return { ...conf, participants: next };
    });
  }

  return {
    createPeer,
    cleanupPeer,
    cleanupPeerWithVerification,
    handleSimplePeerSignal,
    initiateConnections,
    startConnectionHealthMonitoring,
    stopConnectionHealthMonitoring,
    getUserMediaWithFallback,
    sendMediaStateToAll,
    setLocalVideo,
    startScreenShare,
    stopScreenShare,
    switchDevice,
    initializeWebRTC,
    cleanupWebRTC,
    blockParticipant,
  };
}
