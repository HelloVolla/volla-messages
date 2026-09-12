import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { get } from "svelte/store";
import { Base64 } from "js-base64";
import type { AgentPubKeyB64 } from "@holochain/client";
import { Privacy, type ConversationExtended, type ProfileExtended } from "$lib/types";
import type { RelayClient } from "$store/RelayClient";
import type { ConversationStore } from "$store/ConversationStore";
import type { ContactStore } from "$store/ContactStore";

/**
 * Snapshot of everything a future major release needs to rebuild this account.
 *
 * Holochain 0.7 cannot read a 0.6 conductor database, and the conductor
 * directory is bucketed by major app version, so a `2.x` release starts from an
 * empty conductor. Conversation network seeds exist *only* inside the old
 * database — the frontend caches messages, titles and unread flags, but never
 * the seeds — so without this snapshot there is no way to reconstruct a
 * conversation after the upgrade.
 *
 * Writing it is handled by Rust (`write_migration_export`) so the file lands
 * beside `holochain/` rather than inside a version bucket.
 */

/** Bump when the shape changes in a way an importer has to notice. */
export const MIGRATION_EXPORT_VERSION = 1;

export interface ExportedConversation {
  cellIdB64: string;
  networkSeed: string;
  created: number;
  privacy: Privacy;
  progenitor: AgentPubKeyB64;
  title: string;

  /**
   * Base64 of the signed membrane proof envelope.
   *
   * Absent when the conversation does not need one — the integrity zome's
   * `check_agent` admits public conversations and the progenitor without a
   * proof. Also absent when it needs one that has never been readable; see
   * `conversationsMissingProof`.
   */
  membraneProofB64?: string;

  /** `false` for archived conversations, whose cell is disabled. */
  enabled: boolean;
}

export interface ExportedContact {
  publicKeyB64: AgentPubKeyB64;
  firstName: string;
  lastName: string;
  avatar: string;
}

export interface MigrationExport {
  version: number;
  exportedAt: number;
  appVersion: string;
  agentPubKeyB64: AgentPubKeyB64;
  profile?: {
    nickname: string;
    firstName: string;
    lastName: string;
    avatar: string;
  };
  contacts: ExportedContact[];
  conversations: ExportedConversation[];

  /**
   * Conversations that need a membrane proof but have never had one readable,
   * and so cannot be re-joined automatically. Recorded rather than silently
   * dropped so the importing release can tell the user which conversations
   * need a fresh invitation.
   */
  conversationsMissingProof: string[];

  /**
   * Raw `localStorage` values, exactly as `GenericPersistedStore` wrote them
   * (base64 of msgpack), keyed by their storage key.
   *
   * These hold per-conversation state Holochain never sees: titles, unread
   * flags, invited-but-not-yet-joined agents, and the contact → 1:1
   * conversation mapping. All of them are keyed by `cellIdB64`, which changes
   * when the DNA hash changes at 0.7 — so although `localStorage` itself
   * survives the upgrade, its keys stop matching any existing cell. Captured
   * here alongside each conversation's `cellIdB64` so an importer can map them
   * onto the recreated cells via the network seed.
   *
   * Kept verbatim rather than decoded: `CONTACTS.PRIVATE_CONVERSATION` holds
   * `CellId`s (pairs of byte arrays) that do not survive a JSON round trip, and
   * copying the string means the importer decodes with the same helper.
   */
  persistedState: Record<string, string>;
}

/** `localStorage` keys carried across the upgrade. */
const PERSISTED_STATE_KEYS = [
  "CONVERSATION.TITLE",
  "CONVERSATION.UNREAD",
  "CONVERSATION.INVITED",
  "CONTACTS.PRIVATE_CONVERSATION",
];

function collectPersistedState(): Record<string, string> {
  const state: Record<string, string> = {};

  for (const key of PERSISTED_STATE_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) state[key] = value;
  }

  return state;
}

/**
 * Does re-joining this conversation require presenting a membrane proof?
 *
 * Mirrors the first two short-circuits in the integrity zome's `check_agent`:
 * public conversations admit anyone, and the progenitor never needs an
 * invitation to their own conversation.
 */
function needsMembraneProof(
  conversation: ConversationExtended,
  myPubKeyB64: AgentPubKeyB64,
): boolean {
  return (
    conversation.dnaProperties.privacy === Privacy.Private &&
    conversation.dnaProperties.progenitor !== myPubKeyB64
  );
}

/**
 * Cells whose proof recovery has already been attempted this session.
 *
 * The export re-runs on every store change, and enabling a cell is itself a
 * store change, so without this an unrecoverable conversation would be
 * enabled and disabled in a loop.
 */
const attemptedProofRecovery = new Set<string>();

/** Has this session already checked for an interrupted proof read? */
let repairedPendingEnable = false;

/**
 * Briefly enable an archived conversation to read the membrane proof its cell
 * holds, then disable it again.
 *
 * Archiving disables the clone cell, and a disabled cell cannot be zome-called,
 * so the proof is otherwise unreachable — and after upgrading there is no cell
 * left to enable, because genesis needs the proof. The conversation is visibly
 * un-archived for the duration, which is why the window is kept to a single
 * zome call and why each cell is attempted only once.
 *
 * `set_pending_enable` records the intent before enabling so an interrupted
 * run is repaired on the next launch rather than leaving the conversation
 * un-archived for good.
 */
async function recoverArchivedProof(
  relayClient: RelayClient,
  conversation: ConversationExtended,
  cellIdB64: string,
  myPubKeyB64: AgentPubKeyB64,
): Promise<string | undefined> {
  const cellId = conversation.cellInfo.cell_id;

  await invoke("set_pending_enable", { cell: cellIdB64, agent: myPubKeyB64 });
  try {
    await relayClient.enableConversationCell(cellId);
    const proof = await relayClient.getRawMembraneProof(cellId);
    return proof ? Base64.fromUint8Array(new Uint8Array(proof)) : undefined;
  } finally {
    // Restore the archived state even if the read failed, then drop the
    // marker only once the cell is genuinely disabled again.
    try {
      await relayClient.disableConversationCell(cellId);
      await invoke("set_pending_enable", { cell: null, agent: myPubKeyB64 });
    } catch (e) {
      console.error(
        `[migration-export] could not re-archive ${cellIdB64}; it will be repaired on next launch`,
        e,
      );
    }
  }
}

/**
 * Re-archive a cell left enabled by an interrupted proof read.
 */
async function repairPendingEnable(
  relayClient: RelayClient,
  conversationStore: ConversationStore,
  myPubKeyB64: AgentPubKeyB64,
): Promise<void> {
  const pending = await invoke<string | null>("get_pending_enable", { agent: myPubKeyB64 });
  if (!pending) return;

  const conversation = get(conversationStore).data[pending] as ConversationExtended | undefined;
  try {
    if (conversation) await relayClient.disableConversationCell(conversation.cellInfo.cell_id);
    await invoke("set_pending_enable", { cell: null, agent: myPubKeyB64 });
    console.log(`[migration-export] re-archived ${pending} after an interrupted proof read`);
  } catch (e) {
    console.error(`[migration-export] could not repair ${pending}`, e);
  }
}

function parseExport(raw: string): MigrationExport | undefined {
  try {
    return JSON.parse(raw) as MigrationExport;
  } catch {
    return undefined;
  }
}

/**
 * Membrane proofs captured by a previous export, keyed by `cellIdB64`.
 *
 * A proof is immutable — it lives in the `AgentValidationPkg` action at the
 * head of the source chain — so one captured on any earlier launch is still
 * valid today. Retaining them is what makes archived conversations
 * recoverable: an archived conversation is a disabled cell and cannot be
 * zome-called, but if the user ever unarchives it, that launch reads the proof
 * and every later export keeps it, even after it is archived again.
 */
function previousProofs(previous?: MigrationExport): Map<string, string> {
  const proofs = new Map<string, string>();
  if (!previous) return proofs;

  for (const conversation of previous.conversations ?? []) {
    if (conversation.membraneProofB64) {
      proofs.set(conversation.cellIdB64, conversation.membraneProofB64);
    }
  }
  return proofs;
}

async function collect(
  relayClient: RelayClient,
  conversationStore: ConversationStore,
  contactStore: ContactStore,
  myPubKeyB64: AgentPubKeyB64,
  myProfile?: ProfileExtended,
  previous?: MigrationExport,
): Promise<MigrationExport> {
  const knownProofs = previousProofs(previous);
  const conversations: ExportedConversation[] = [];
  const conversationsMissingProof: string[] = [];

  for (const [cellIdB64, c] of Object.entries(get(conversationStore).data)) {
    const conversation = c as ConversationExtended;
    const title = conversation.config ? conversation.config.title : conversation.cellInfo.name;
    const needsProof = needsMembraneProof(conversation, myPubKeyB64);

    let membraneProofB64: string | undefined;
    if (needsProof) {
      // Cache first: a proof is immutable, so a previously captured one is
      // authoritative and saves a zome call. This matters because the export
      // re-runs whenever conversations change, not just at launch.
      membraneProofB64 = knownProofs.get(cellIdB64);

      if (membraneProofB64 === undefined && conversation.cellInfo.enabled) {
        try {
          const proof = await relayClient.getRawMembraneProof(conversation.cellInfo.cell_id);
          if (proof) membraneProofB64 = Base64.fromUint8Array(new Uint8Array(proof));
        } catch (e) {
          console.warn(`[migration-export] could not read membrane proof for ${title}`, e);
        }
      }

      // Archived conversation with no cached proof: its cell is disabled and
      // cannot be zome-called, so enable it just long enough to read the proof.
      if (membraneProofB64 === undefined && !attemptedProofRecovery.has(cellIdB64)) {
        attemptedProofRecovery.add(cellIdB64);
        try {
          console.log(`[migration-export] recovering membrane proof for archived "${title}"`);
          membraneProofB64 = await recoverArchivedProof(
            relayClient,
            conversation,
            cellIdB64,
            myPubKeyB64,
          );
        } catch (e) {
          console.error(`[migration-export] proof recovery failed for ${title}`, e);
        }
      }

      if (membraneProofB64 === undefined) {
        conversationsMissingProof.push(cellIdB64);
      }
    }

    conversations.push({
      cellIdB64,
      networkSeed: conversation.cellInfo.dna_modifiers.network_seed,
      created: conversation.dnaProperties.created,
      privacy: conversation.dnaProperties.privacy,
      progenitor: conversation.dnaProperties.progenitor,
      title,
      membraneProofB64,
      enabled: conversation.cellInfo.enabled,
    });
  }

  const contacts: ExportedContact[] = Object.values(get(contactStore).data).map((c: any) => ({
    publicKeyB64: c.publicKeyB64,
    firstName: c.contact.first_name,
    lastName: c.contact.last_name,
    avatar: c.contact.avatar,
  }));

  return {
    version: MIGRATION_EXPORT_VERSION,
    exportedAt: Date.now(),
    appVersion: await getVersion(),
    agentPubKeyB64: myPubKeyB64,
    profile: myProfile
      ? {
          nickname: myProfile.profile.nickname,
          firstName: myProfile.profile.fields.firstName,
          lastName: myProfile.profile.fields.lastName,
          avatar: myProfile.profile.fields.avatar,
        }
      : undefined,
    contacts,
    conversations,
    conversationsMissingProof,
    persistedState: collectPersistedState(),
  };
}

/** Serialization of everything except `exportedAt`, for change detection. */
function contentKey(exported: MigrationExport): string {
  const { exportedAt: _exportedAt, ...rest } = exported;
  return JSON.stringify(rest);
}

/**
 * Would writing `next` throw away a populated export in favour of an empty one?
 *
 * This guards the one case far more likely to be a fault than a real change: a
 * launch where a store failed to load and collected nothing at all.
 *
 * A genuine decrease is deliberately allowed through. If the user leaves or
 * deletes a conversation the count drops, and refusing that write would freeze
 * the export at its previous high-water mark — including refusing newly
 * captured membrane proofs — until the count exceeded it again.
 */
function wouldDiscardEverything(next: MigrationExport, previous: MigrationExport): boolean {
  const previousHadData =
    (previous.conversations?.length ?? 0) > 0 || (previous.contacts?.length ?? 0) > 0;
  const nextHasNoData = next.conversations.length === 0 && next.contacts.length === 0;

  return previousHadData && nextHasNoData;
}

/**
 * Collect and persist the migration export. Safe to call on every launch.
 *
 * Never throws: a failed export must not stop the app from starting, since the
 * user can still send and receive messages without one.
 */
export async function exportMigrationData(
  relayClient: RelayClient,
  conversationStore: ConversationStore,
  contactStore: ContactStore,
  myPubKeyB64: AgentPubKeyB64,
  myProfile?: ProfileExtended,
): Promise<void> {
  try {
    // Once per session, before anything else: undo an enable left behind by a
    // proof read that was interrupted last time.
    if (!repairedPendingEnable) {
      repairedPendingEnable = true;
      await repairPendingEnable(relayClient, conversationStore, myPubKeyB64);
    }

    const previousRaw = await invoke<string | null>("read_migration_export", {
      agent: myPubKeyB64,
    });
    const onDisk = previousRaw ? parseExport(previousRaw) : undefined;

    // Only this agent's own export is comparable. Membrane proofs name a
    // specific agent, so inheriting them from a different one would produce
    // proofs that can never validate — and a multi-agent dev run shares this
    // app root, so a foreign export really does turn up here.
    const previous = onDisk?.agentPubKeyB64 === myPubKeyB64 ? onDisk : undefined;

    const next = await collect(
      relayClient,
      conversationStore,
      contactStore,
      myPubKeyB64,
      myProfile,
      previous,
    );

    if (previous && wouldDiscardEverything(next, previous)) {
      console.warn(
        "[migration-export] skipped: this run collected nothing but the existing export has data",
      );
      return;
    }

    // The export re-runs on every store emission, and most of those change
    // nothing it records. Compare everything except `exportedAt`, which always
    // differs, and skip writing when the content is identical.
    if (previous && contentKey(next) === contentKey(previous)) return;

    const path = await invoke<string>("write_migration_export", {
      contents: JSON.stringify(next),
      agent: myPubKeyB64,
    });

    const withProof = next.conversations.filter((c) => c.membraneProofB64).length;
    console.log(
      `[migration-export] wrote ${next.conversations.length} conversation(s) ` +
        `(${withProof} with a membrane proof) and ${next.contacts.length} contact(s) to ${path}`,
    );
    if (next.conversationsMissingProof.length > 0) {
      console.warn(
        `[migration-export] ${next.conversationsMissingProof.length} conversation(s) still need a ` +
          `membrane proof; unarchiving them once would capture it`,
      );
    }
  } catch (e) {
    console.error("[migration-export] failed", e);
  }
}
