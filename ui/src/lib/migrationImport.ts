import { invoke } from "@tauri-apps/api/core";
import { Base64 } from "js-base64";
import {
  decodeHashFromBase64,
  encodeHashToBase64,
  type AgentPubKeyB64,
  type CellId,
  type ClonedCell,
} from "@holochain/client";
import { Privacy, type Invitation } from "$lib/types";
import { decodeCellIdFromBase64, encodeCellIdToBase64, makeFullName } from "$lib/utils";
import type { RelayClient } from "$store/RelayClient";
import { decodePersisted, encodePersisted } from "$store/generic/GenericPersistedStore";

/**
 * Rebuild a 1.x (Holochain 0.6) account on 2.x (0.7) from the export 1.0.3
 * wrote.
 *
 * The 0.7 conductor starts empty and cannot read the 0.6 database. The Rust
 * side carries the keystore over and installs the app under the exported
 * agent key; this restores what lived in the conductor — the profile, every
 * conversation, contacts — and the per-conversation state the UI kept in
 * localStorage.
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
 *
 * Contacts and localStorage state are different: the user can delete a contact
 * or clear an unread flag after upgrading, and re-applying the export would
 * bring them back. So each is applied once, recorded in `IMPORT_STATE_KEY`.
 *
 * Must run before the stores are created: `persisted` stores read localStorage
 * once at creation and write their in-memory copy back afterwards, so state
 * restored later would be ignored and then overwritten.
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

interface ExportedContact {
  publicKeyB64: AgentPubKeyB64;
  firstName: string;
  lastName: string;
  avatar: string;
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
  contacts?: ExportedContact[];
  conversations: ExportedConversation[];
  /** Raw localStorage values from 1.x, as `persisted` encoded them. */
  persistedState?: { [key: string]: string };
}

export interface MigrationImportReport {
  profileRestored: boolean;
  imported: number;
  alreadyPresent: number;
  /** Conversations that could not be rebuilt, by title, with the reason. */
  failed: Array<{ title: string; reason: string }>;
  contactsRestored: number;
  contactsFailed: number;
  /** Conversations whose localStorage state was carried over in this run. */
  localStateRestored: number;
  /** Contacts whose 1:1 conversation link was pointed at the rebuilt conversation. */
  contactLinksUpdated: number;
}

/**
 * What the import has applied once and must not apply again. Plain JSON in
 * localStorage, alongside the state it describes.
 */
const IMPORT_STATE_KEY = "MIGRATION.IMPORT_STATE";

interface ImportState {
  agentPubKeyB64: AgentPubKeyB64;
  /** Network seeds whose localStorage state has been restored. */
  restoredSeeds: string[];
  /** Contacts (agent keys) that have been restored or found present. */
  restoredContacts: AgentPubKeyB64[];
}

/**
 * localStorage keys keyed by conversation (`cellIdB64`) to carry over.
 *
 * Deliberately left out:
 * - `CONVERSATION.UNREAD`: 1.x history is not imported yet, so an unread
 *   marker would point at messages that are not there.
 * - `CONVERSATION.INVITED`: the app never removes an agent from it, even after
 *   they join. In 1.x that was invisible, because the "enter your invite code"
 *   notice only shows on an empty conversation. Every migrated conversation is
 *   empty, so carrying the list over shows that notice for members who joined
 *   long ago and will reconnect on their own when they upgrade.
 */
const CONVERSATION_KEYED_STATE = ["CONVERSATION.TITLE"];

/** Contact agent key → `CellId` of the 1:1 conversation with that contact. */
const CONTACT_CONVERSATION_KEY = "CONTACTS.PRIVATE_CONVERSATION";

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

/**
 * Create the profile in the provisioned cell if it is missing, and copy it into
 * every conversation that already exists — as `ProfileStore.createProfile`
 * does. Must run before conversations are rebuilt: joining copies the
 * provisioned cell's profile into the conversation, and fails without one.
 */
async function restoreProfile(exported: MigrationExport, relayClient: RelayClient): Promise<boolean> {
  if (!exported.profile) return false;

  const provisioned = relayClient.provisionedRelayCellId;
  const existing = await withTimeout(
    relayClient.getAgentProfile(provisioned, relayClient.client.myPubKey, true),
    STEP_TIMEOUT_MS,
    "reading the profile",
  );
  if (existing) return false;

  const { firstName, lastName, avatar } = exported.profile;
  await withTimeout(
    relayClient.createProfile(provisioned, {
      nickname: makeFullName(firstName, lastName),
      fields: { firstName, lastName, avatar },
    }),
    STEP_TIMEOUT_MS,
    "creating the profile",
  );

  // Conversations rebuilt by an earlier run that failed to create the profile
  // have none yet. A disabled cell cannot be written; that is a known gap.
  const clones = await withTimeout(
    relayClient.getRelayClonedCellInfos(),
    STEP_TIMEOUT_MS,
    "listing conversations",
  );
  for (const clone of clones.filter((c) => c.enabled)) {
    try {
      await withTimeout(
        relayClient.setMyProfileForConversation(clone.cell_id),
        STEP_TIMEOUT_MS,
        "setting the profile",
      );
    } catch (e) {
      console.warn(`[migration-import] could not set profile in "${clone.name}": ${describe(e)}`);
    }
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

function loadImportState(myPubKeyB64: AgentPubKeyB64): ImportState {
  const fresh: ImportState = { agentPubKeyB64: myPubKeyB64, restoredSeeds: [], restoredContacts: [] };
  try {
    const raw = localStorage.getItem(IMPORT_STATE_KEY);
    const saved = raw ? (JSON.parse(raw) as ImportState) : undefined;
    // Another agent's record says nothing about what this agent has.
    return saved?.agentPubKeyB64 === myPubKeyB64 ? saved : fresh;
  } catch {
    return fresh;
  }
}

function saveImportState(state: ImportState): void {
  localStorage.setItem(IMPORT_STATE_KEY, JSON.stringify(state));
}

/**
 * Re-create the contacts from the export in the provisioned cell. A contact is
 * skipped if it already exists, and never re-created once recorded, so one the
 * user deletes after upgrading stays deleted.
 */
async function restoreContacts(
  exported: MigrationExport,
  relayClient: RelayClient,
  state: ImportState,
  report: MigrationImportReport,
): Promise<void> {
  const pending = (exported.contacts ?? []).filter(
    (c) => !state.restoredContacts.includes(c.publicKeyB64),
  );
  if (pending.length === 0) return;

  const present = new Set(
    (
      await withTimeout(relayClient.getAllContacts(true), STEP_TIMEOUT_MS, "listing contacts")
    )
      .filter((c) => c.contact !== undefined)
      .map((c) => encodeHashToBase64(c.contact!.public_key)),
  );

  for (const contact of pending) {
    try {
      if (!present.has(contact.publicKeyB64)) {
        await withTimeout(
          relayClient.createContact({
            public_key: decodeHashFromBase64(contact.publicKeyB64),
            first_name: contact.firstName,
            last_name: contact.lastName,
            avatar: contact.avatar,
          }),
          STEP_TIMEOUT_MS,
          "creating a contact",
        );
        report.contactsRestored++;
      }
      state.restoredContacts.push(contact.publicKeyB64);
    } catch (e) {
      // Not recorded, so the next launch tries again.
      report.contactsFailed++;
      console.warn(
        `[migration-import] could not restore contact ${contact.firstName}: ${describe(e)}`,
      );
    }
  }
}

function readLocal<T>(key: string): T | undefined {
  const raw = localStorage.getItem(key);
  return raw ? decodePersisted<T>(raw) : undefined;
}

function readExported<T>(exported: MigrationExport, key: string): T | undefined {
  const raw = exported.persistedState?.[key];
  return raw ? decodePersisted<T>(raw) : undefined;
}

/**
 * Carry the 1.x localStorage state over to the rebuilt conversations.
 *
 * Every entry is keyed by `cellIdB64` — DNA hash plus agent key — and the DNA
 * hash of every conversation changed at 0.7, so the 1.x keys match nothing.
 * The network seed is what old and new conversations share, so each old key
 * is translated old `cellIdB64` → seed → new `cellIdB64`.
 *
 * Only adds what is missing — never overwrites a value the user set after
 * upgrading — and each conversation is handled once.
 */
function restoreLocalState(
  exported: MigrationExport,
  clones: ClonedCell[],
  state: ImportState,
  report: MigrationImportReport,
): void {
  if (!exported.persistedState) return;

  const seedOfOldKey = new Map(exported.conversations.map((c) => [c.cellIdB64, c.networkSeed]));
  const newKeyOfSeed = new Map(
    clones.map((c) => [c.dna_modifiers.network_seed, encodeCellIdToBase64(c.cell_id)]),
  );
  const done = new Set(state.restoredSeeds);

  /** The new key for an old one, if its conversation exists and is not done yet. */
  const translate = (oldKey: string): string | undefined => {
    const seed = seedOfOldKey.get(oldKey);
    if (seed === undefined || done.has(seed)) return undefined;
    return newKeyOfSeed.get(seed);
  };

  for (const key of CONVERSATION_KEYED_STATE) {
    const old = readExported<{ [cellIdB64: string]: unknown }>(exported, key);
    if (!old) continue;

    const current = readLocal<{ [cellIdB64: string]: unknown }>(key) ?? {};
    for (const [oldKey, value] of Object.entries(old)) {
      const newKey = translate(oldKey);
      if (newKey !== undefined && !(newKey in current)) current[newKey] = value;
    }
    localStorage.setItem(key, encodePersisted(current));
  }

  const oldContactCells = readExported<{ [agent: string]: CellId }>(
    exported,
    CONTACT_CONVERSATION_KEY,
  );
  if (oldContactCells) {
    // 1.x and 2.x share this localStorage (same app identifier and origin), so
    // after an upgrade every contact already has an entry here — pointing at
    // its 1.x conversation. Such an entry is always stale (nobody can have set
    // it on 2.x), so it is replaced even for a conversation already handled. A
    // missing entry follows the apply-once rule like everything else.
    const current = readLocal<{ [agent: string]: CellId }>(CONTACT_CONVERSATION_KEY) ?? {};
    for (const [agent, oldCellId] of Object.entries(oldContactCells)) {
      const existing = current[agent] ? encodeCellIdToBase64(current[agent]) : undefined;
      const newKey =
        existing === undefined
          ? translate(encodeCellIdToBase64(oldCellId))
          : seedOfOldKey.has(existing)
            ? newKeyOfSeed.get(seedOfOldKey.get(existing)!)
            : undefined;
      if (newKey !== undefined) {
        current[agent] = decodeCellIdFromBase64(newKey);
        report.contactLinksUpdated++;
      }
    }
    localStorage.setItem(CONTACT_CONVERSATION_KEY, encodePersisted(current));
  }

  // Record every exported conversation that exists now; one not rebuilt yet is
  // picked up by a later run.
  for (const seed of new Set(seedOfOldKey.values())) {
    if (!done.has(seed) && newKeyOfSeed.has(seed)) {
      state.restoredSeeds.push(seed);
      report.localStateRestored++;
    }
  }
}

/**
 * Restore the profile, conversations, contacts and localStorage state from the
 * 1.0.3 export, if there is one for this agent. Call before creating the
 * stores. Never throws: the app is usable whatever the outcome.
 */
export async function importMigrationExport(
  relayClient: RelayClient,
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
    contactsRestored: 0,
    contactsFailed: 0,
    localStateRestored: 0,
    contactLinksUpdated: 0,
  };

  try {
    report.profileRestored = await restoreProfile(exported, relayClient);
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

  const state = loadImportState(myPubKeyB64);
  try {
    await restoreContacts(exported, relayClient, state, report);
  } catch (e) {
    console.error(`[migration-import] could not restore contacts: ${describe(e)}`);
  }

  try {
    const clones = await withTimeout(
      relayClient.getRelayClonedCellInfos(),
      STEP_TIMEOUT_MS,
      "listing conversations",
    );
    restoreLocalState(exported, clones, state, report);
  } catch (e) {
    console.error(`[migration-import] could not restore local state: ${describe(e)}`);
  }
  saveImportState(state);

  // Warn level: the release log drops webview info-level output.
  console.warn(`[migration-import] finished: ${JSON.stringify(report)}`);
  return report;
}
