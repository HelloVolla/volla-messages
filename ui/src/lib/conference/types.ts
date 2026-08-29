import type { AgentPubKeyB64 } from "@holochain/client";

export interface ParticipantData {
  pubKey: AgentPubKeyB64;
  publicKey: AgentPubKeyB64;
  isLocal: boolean;
  hasJoined: boolean;
  connectionStatus?: "idle" | "init-sent" | "init-received" | "connecting" | "connected" | "failed";
  videoEnabled?: boolean;
  audioEnabled?: boolean;
  connectionQuality?: string;
  isHost?: boolean;
  declined?: boolean;
  _stream?: MediaStream | null;
  _connected: boolean;
}
