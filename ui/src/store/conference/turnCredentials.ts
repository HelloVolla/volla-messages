import type { CellId } from "@holochain/client";
import { Base64 } from "js-base64";
import { TURN_ISSUER_URL, TURN_REFRESH_MARGIN_MS, ZOME_NAME } from "$config";
import type { RelayClient } from "$store/RelayClient";

interface TurnProof {
  space: Uint8Array;
  agent: Uint8Array;
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

const FETCH_TIMEOUT_MS = 5000;

let cached: CachedCredential | undefined;
let inFlight: Promise<boolean> | undefined;

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
  inFlight ??= fetchCredential(client, cellId)
    .then(() => true)
    .catch((e) => {
      console.warn("[TURN] credential fetch failed:", e);
      return hasTurnCredential();
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function fetchCredential(client: RelayClient, cellId: CellId): Promise<void> {
  const nonceRes = await fetch(`${TURN_ISSUER_URL}/turn/nonce`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!nonceRes.ok) throw new Error(`nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const proof: TurnProof = await client.client.callZome({
    cell_id: cellId,
    zome_name: ZOME_NAME,
    fn_name: "sign_turn_challenge",
    payload: Base64.toUint8Array(nonce),
  });

  const credRes = await fetch(
    `${TURN_ISSUER_URL}/turn/${b64url(proof.space)}/${b64url(proof.agent)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, signature: b64url(proof.signature) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!credRes.ok) throw new Error(`credential request failed: ${credRes.status}`);
  const cred = (await credRes.json()) as TurnCredentialResponse;

  cached = {
    iceServer: { urls: cred.uris, username: cred.username, credential: cred.credential },
    expiresAt: Date.now() + cred.ttlSecs * 1000,
  };
}
