import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { Base64 } from "js-base64";
import { decodeHashFromBase64, type AgentPubKeyB64, type ClonedCell } from "@holochain/client";
import { Privacy, type Invitation } from "$lib/types";
import type { RelayClient } from "$store/RelayClient";
import type { ProfileStore } from "$store/ProfileStore";

/**
 * Rebuild a 1.x (Holochain 0.6) account on 2.x (0.7) from the export 1.0.3
 * wrote.
 *
 * The 0.7 conductor starts empty and cannot read the 0.6 database. The Rust
 * side carries the keystore over and installs the app under the exported
 * agent key; this restores what lived in the conductor: the profile and every
 * conversation.
 *
 * Each conversation is re-created as a clone cell from its original network
 * seed and DNA properties, so every member who migrates computes the same new
 * DNA hash and they meet on one network without coordinating. Private
 * conversations the user did not create are re-joined with the membrane proof
 * captured on 0.6 — `check_agent` binds a proof to the network seed, the agent
 * and the progenitor's signature, never to the DNA hash.
 *
 * Runs on every launch and is idempotent: a conversation whose network seed
 * already exists as a clone is skipped. That is safe because the app never
 * deletes a clone — leaving or archiving a conversation only disables it — so
 * a re-run cannot resurrect a conversation the user removed.
 */

/** Must match `MIGRATION_EXPORT_VERSION` in 1.0.3's export. */
const SUPPORTED_EXPORT_VERSION = 1;

/**
 * Upper bounds for each conductor call. The import runs before the app's first
 * screen, so a call that never settles must not keep the user on the
 * splashscreen. These are all local operations (genesis, commits), normally
 * well under a second; the limits only exist to bound the pathological case.
 * A call that times out may still complete in the conductor, which the next
 * launch sees as an existing conversation.
 */
const JOIN_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ExportedConversation {
  cellIdB64: string;
  networkSeed: string;
  created: number;
  privacy: Privacy;
  progenitor: AgentPubKeyB64;
  title: string;
  membraneProofB64?: string;
  enabled: boolean;
}

interface MigrationExport {
  version: number;
  agentPubKeyB64: AgentPubKeyB64;
  profile?: {
    nickname: string;
    firstName: string;
    lastName: string;
    avatar: string;
  };
  conversations: ExportedConversation[];
}

export interface MigrationImportReport {
  profileRestored: boolean;
  imported: number;
  alreadyPresent: number;
  /** Conversations that could not be rebuilt, by title, with the reason. */
  failed: Array<{ title: string; reason: string }>;
}

function toInvitation(conversation: ExportedConversation): Invitation {
  return {
    created: conversation.created,
    networkSeed: conversation.networkSeed,
    privacy: conversation.privacy,
    progenitor: decodeHashFromBase64(conversation.progenitor),
    title: conversation.title,
    proof: conversation.membraneProofB64
      ? Base64.toUint8Array(conversation.membraneProofB64)
      : undefined,
  };
}

async function readExport(): Promise<MigrationExport | undefined> {
  const raw = await invoke<string | null>("read_migration_export", { agent: null });
  if (!raw) return undefined;

  const parsed = JSON.parse(raw) as MigrationExport;
  if (parsed.version !== SUPPORTED_EXPORT_VERSION) {
    console.warn(`[migration-import] unsupported export version ${parsed.version}; skipping`);
    return undefined;
  }
  return parsed;
}

async function restoreProfile(
  exported: MigrationExport,
  profileStore: ProfileStore,
  provisionedRelayCellIdB64: string,
  myPubKeyB64: AgentPubKeyB64,
): Promise<boolean> {
  if (!exported.profile) return false;

  const existing = get(profileStore).data[provisionedRelayCellIdB64]?.[myPubKeyB64];
  if (existing) return false;

  // Before any conversation is rebuilt: joining copies the provisioned cell's
  // profile into the conversation, and fails if there is none yet.
  await withTimeout(
    profileStore.createProfile({
      firstName: exported.profile.firstName,
      lastName: exported.profile.lastName,
      avatar: exported.profile.avatar,
    }),
    STEP_TIMEOUT_MS,
    "creating the profile",
  );

  // `createProfile` discards per-cell failures, so confirm it really landed.
  if (!get(profileStore).data[provisionedRelayCellIdB64]?.[myPubKeyB64]) {
    throw new Error("profile was not created in the provisioned cell");
  }
  return true;
}

/** Errors from the client are often `Error`s, which log as `{}`. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}

async function rebuildConversation(
  relayClient: RelayClient,
  conversation: ExportedConversation,
  myPubKeyB64: AgentPubKeyB64,
): Promise<ClonedCell> {
  const cell = await withTimeout(
    relayClient.joinConversation(toInvitation(conversation)),
    JOIN_TIMEOUT_MS,
    "joining",
  );

  // The remaining steps are best effort: the conversation exists and works
  // without them, so one failing must not undo or block the others.
  try {
    await withTimeout(
      relayClient.setMyProfileForConversation(cell.cell_id),
      STEP_TIMEOUT_MS,
      "setting the profile",
    );
  } catch (e) {
    console.warn(`[migration-import] could not set profile in "${conversation.title}": ${describe(e)}`);
  }

  // The config entry lived in the old DHT. Only the creator publishes it, as
  // when a conversation is first created. The group image was not exported.
  if (conversation.progenitor === myPubKeyB64) {
    try {
      await withTimeout(
        relayClient.setConfig(cell.cell_id, { title: conversation.title, image: "" }),
        STEP_TIMEOUT_MS,
        "restoring the config",
      );
    } catch (e) {
      console.warn(`[migration-import] could not restore config of "${conversation.title}": ${describe(e)}`);
    }
  }

  if (!conversation.enabled) {
    try {
      await withTimeout(
        relayClient.disableConversationCell(cell.cell_id),
        STEP_TIMEOUT_MS,
        "re-archiving",
      );
    } catch (e) {
      console.warn(`[migration-import] could not re-archive "${conversation.title}": ${describe(e)}`);
    }
  }

  return cell;
}

/**
 * Restore the profile and conversations from the 1.0.3 export, if there is one
 * for this agent. Never throws: the app is usable whatever the outcome.
 */
export async function importMigrationExport(
  relayClient: RelayClient,
  profileStore: ProfileStore,
  provisionedRelayCellIdB64: string,
  myPubKeyB64: AgentPubKeyB64,
): Promise<MigrationImportReport | undefined> {
  let exported: MigrationExport | undefined;
  try {
    exported = await readExport();
  } catch (e) {
    console.error(`[migration-import] could not read the export: ${describe(e)}`);
    return undefined;
  }
  if (!exported) return undefined;

  // The proofs in the export name the exported agent. Under any other agent
  // they cannot validate, and the conversations are not this agent's.
  if (exported.agentPubKeyB64 !== myPubKeyB64) {
    console.warn(
      `[migration-import] export belongs to ${exported.agentPubKeyB64}, not ${myPubKeyB64}; skipping`,
    );
    return undefined;
  }

  const report: MigrationImportReport = {
    profileRestored: false,
    imported: 0,
    alreadyPresent: 0,
    failed: [],
  };

  try {
    report.profileRestored = await restoreProfile(
      exported,
      profileStore,
      provisionedRelayCellIdB64,
      myPubKeyB64,
    );
  } catch (e) {
    console.error(`[migration-import] could not restore the profile: ${describe(e)}`);
  }

  let existingSeeds: Set<string>;
  try {
    const clones = await withTimeout(
      relayClient.getRelayClonedCellInfos(),
      STEP_TIMEOUT_MS,
      "listing conversations",
    );
    existingSeeds = new Set(clones.map((c) => c.dna_modifiers.network_seed));
  } catch (e) {
    console.error(`[migration-import] could not list existing conversations: ${describe(e)}`);
    return report;
  }

  for (const conversation of exported.conversations) {
    if (existingSeeds.has(conversation.networkSeed)) {
      report.alreadyPresent++;
      continue;
    }

    const needsProof =
      conversation.privacy === Privacy.Private && conversation.progenitor !== myPubKeyB64;
    if (needsProof && !conversation.membraneProofB64) {
      report.failed.push({ title: conversation.title, reason: "no membrane proof in the export" });
      continue;
    }

    try {
      await rebuildConversation(relayClient, conversation, myPubKeyB64);
      existingSeeds.add(conversation.networkSeed);
      report.imported++;
    } catch (e) {
      report.failed.push({ title: conversation.title, reason: describe(e) });
    }
  }

  // Warn level: the release log drops webview info-level output.
  console.warn(`[migration-import] finished: ${JSON.stringify(report)}`);
  return report;
}
