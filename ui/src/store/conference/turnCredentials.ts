import { decodeHashFromBase64, type CellId } from "@holochain/client";
import { Base64 } from "js-base64";
import { TURN_ISSUER_URL, TURN_REFRESH_MARGIN_MS, ZOME_NAME } from "$config";
import type { RelayClient } from "$store/RelayClient";
import { fetchDeviceAdmission } from "$store/DeviceAdmissionStore";

interface TurnProof {
  device: Uint8Array;
  signature: Uint8Array;
}

interface TurnCredentialResponse {
  username: string;
  credential: string;
  ttlSecs: number;
  uris: string[];
}

interface CachedCredential {
  iceServer: RTCIceServer;
  expiresAt: number;
}

class IssuerError extends Error {
  constructor(
    step: string,
    readonly status: number,
  ) {
    super(`${step} failed: ${status}`);
  }
}

const FETCH_TIMEOUT_MS = 5000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const RETRY_AFTER_REFUSAL_MS = 10 * 60 * 1000;

let cached: CachedCredential | undefined;
let inFlight: Promise<boolean> | undefined;
let retryAt = 0;

const b64url = (bytes: Uint8Array) => Base64.fromUint8Array(bytes, true);

function isFresh(c: CachedCredential | undefined, marginMs: number): c is CachedCredential {
  return !!c && c.expiresAt - Date.now() > marginMs;
}

export function getTurnIceServers(): RTCIceServer[] {
  return isFresh(cached, 0) ? [cached.iceServer] : [];
}

export function hasTurnCredential(): boolean {
  return isFresh(cached, 0);
}

export function ensureTurnCredential(client: RelayClient, cellId: CellId): Promise<boolean> {
  if (!TURN_ISSUER_URL) return Promise.resolve(false);
  if (isFresh(cached, TURN_REFRESH_MARGIN_MS)) return Promise.resolve(true);
  if (Date.now() < retryAt) return Promise.resolve(hasTurnCredential());
  inFlight ??= fetchCredential(client, cellId)
    .catch((e) => {
      const refused = e instanceof IssuerError && e.status === 403;
      retryAt = Date.now() + (refused ? RETRY_AFTER_REFUSAL_MS : RETRY_AFTER_FAILURE_MS);
      console.warn("[TURN] credential fetch failed:", e);
      return hasTurnCredential();
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function fetchCredential(client: RelayClient, cellId: CellId): Promise<boolean> {
  const admission = await fetchDeviceAdmission();
  if (admission.status !== "approved" || !admission.deviceKey) return false;

  const nonceRes = await fetch(`${TURN_ISSUER_URL}/turn/nonce`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!nonceRes.ok) throw new IssuerError("nonce request", nonceRes.status);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const proof: TurnProof = await client.client.callZome({
    cell_id: cellId,
    zome_name: ZOME_NAME,
    fn_name: "sign_turn_challenge",
    payload: {
      nonce: Base64.toUint8Array(nonce),
      device: decodeHashFromBase64(admission.deviceKey),
    },
  });

  const credRes = await fetch(`${TURN_ISSUER_URL}/turn/${b64url(proof.device)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature: b64url(proof.signature) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!credRes.ok) throw new IssuerError("credential request", credRes.status);
  const cred = (await credRes.json()) as TurnCredentialResponse;

  cached = {
    iceServer: { urls: cred.uris, username: cred.username, credential: cred.credential },
    expiresAt: Date.now() + cred.ttlSecs * 1000,
  };
  return true;
}
