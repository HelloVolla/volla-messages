import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { encodeHashToBase64, type AgentPubKeyB64, type CellId, type Record } from "@holochain/client";
import { BUCKET_RANGE_MS } from "$config";
import type { ConversationExtended, MessageFile, MessageRecord, MessageType } from "$lib/types";
import type { RelayClient } from "$store/RelayClient";
import type { ConversationStore } from "$store/ConversationStore";
import { encodeCellIdToBase64 } from "$lib/utils";
import { withArchivedCellEnabled } from "$lib/migrationExport";

/**
 * Export every conversation's message history for the next major release.
 *
 * A 2.x release cannot read this release's conductor database, so old messages
 * only survive the upgrade if they are copied out first. One file per
 * conversation, `export/history/<network seed>.json`, beside the main export.
 * 2.x matches it to the rebuilt conversation by that seed.
 *
 * Read from this device only — never the network — so it is fast and cannot
 * stall: the measured cost on a real account was 527 messages in a few
 * seconds. The whole history is re-read on each run, which keeps the logic
 * simple and makes edits and deletions show up without any bookkeeping.
 */

/** Bump when the file shape changes in a way an importer has to notice. */
export const HISTORY_EXPORT_VERSION = 1;

const TAG = "[history-export]";
const BUCKET_CHUNK = 30;

export interface ExportedImage {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  /** `storage_entry_hash` of the file in the file_storage zome. */
  hash: string;
}

export interface ExportedMessage {
  /** Original action hash: stable across edits, so an importer can deduplicate. */
  id: string;
  author: AgentPubKeyB64;
  /** When the message was first sent, in microseconds (Holochain timestamps). */
  timestamp: number;
  /** When it was last edited, if it was; the content is the edited version. */
  editedAt?: number;
  type: MessageType;
  content: string;
  images: ExportedImage[];
}

export interface HistoryExport {
  version: number;
  networkSeed: string;
  /** The 1.x conversation this came from. */
  cellIdB64: string;
  exportedAt: number;
  messages: ExportedMessage[];
}

function exportImage(image: MessageFile): ExportedImage {
  return {
    name: image.name,
    size: image.size,
    type: image.file_type,
    lastModified: image.last_modified,
    hash: encodeHashToBase64(image.storage_entry_hash),
  };
}

/** Timestamp of the original send, for a message that has been edited. */
async function originalTimestamp(
  relayClient: RelayClient,
  cellId: CellId,
  record: MessageRecord,
): Promise<number> {
  const original: Record | undefined = await relayClient.client.callZome({
    cell_id: cellId,
    zome_name: "relay",
    fn_name: "get_original_message",
    payload: record.original_action,
  });
  return original?.signed_action.hashed.content.timestamp ?? record.signed_action.hashed.content.timestamp;
}

async function readHistory(
  relayClient: RelayClient,
  conversation: ConversationExtended,
): Promise<ExportedMessage[]> {
  const cellId = conversation.cellInfo.cell_id;
  const lastBucket = Math.max(
    0,
    Math.round((Date.now() - conversation.dnaProperties.created) / BUCKET_RANGE_MS),
  );

  const messages: ExportedMessage[] = [];
  for (let first = 0; first <= lastBucket; first += BUCKET_CHUNK) {
    const buckets: number[] = [];
    for (let b = first; b <= Math.min(lastBucket, first + BUCKET_CHUNK - 1); b++) buckets.push(b);

    const records = await relayClient.getMessagesForBuckets(cellId, buckets);
    for (const record of records) {
      if (!record.message) continue;
      const latest = record.signed_action.hashed;
      const edited =
        encodeHashToBase64(latest.hash) !== encodeHashToBase64(record.original_action);

      messages.push({
        id: encodeHashToBase64(record.original_action),
        author: encodeHashToBase64(latest.content.author),
        timestamp: edited
          ? await originalTimestamp(relayClient, cellId, record)
          : latest.content.timestamp,
        editedAt: edited ? latest.content.timestamp : undefined,
        type: record.message.message_type,
        content: record.message.content,
        images: record.message.images.map(exportImage),
      });
    }
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

function parse(raw: string | null): HistoryExport | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as HistoryExport;
  } catch {
    return undefined;
  }
}

/** Everything but the timestamp, to skip rewriting an unchanged file. */
function contentKey(history: HistoryExport): string {
  const { exportedAt: _exportedAt, ...rest } = history;
  return JSON.stringify(rest);
}

/** Archived conversations already read this launch; see `exportHistory`. */
const archivedReadThisLaunch = new Set<string>();

let running = false;

/**
 * Export the history of every conversation. Never throws, and a second call
 * while one is running is skipped rather than queued.
 *
 * Archived conversations are disabled cells and have to be enabled briefly to
 * be read, which is visible, so each is read at most once per launch.
 */
export async function exportHistory(
  relayClient: RelayClient,
  conversationStore: ConversationStore,
  myPubKeyB64: AgentPubKeyB64,
): Promise<void> {
  if (running) return;
  running = true;
  const started = performance.now();
  let written = 0;
  let unchanged = 0;
  let messages = 0;
  let failed = 0;

  try {
    const conversations = Object.values(get(conversationStore).data) as ConversationExtended[];
    for (const conversation of conversations) {
      const cellIdB64 = encodeCellIdToBase64(conversation.cellInfo.cell_id);
      const seed = conversation.cellInfo.dna_modifiers.network_seed;
      const archived = !conversation.cellInfo.enabled;
      if (archived && archivedReadThisLaunch.has(cellIdB64)) continue;

      try {
        const read = () => readHistory(relayClient, conversation);
        const history: HistoryExport = {
          version: HISTORY_EXPORT_VERSION,
          networkSeed: seed,
          cellIdB64,
          exportedAt: Date.now(),
          messages: archived
            ? await withArchivedCellEnabled(
                relayClient,
                conversation.cellInfo.cell_id,
                cellIdB64,
                myPubKeyB64,
                read,
              )
            : await read(),
        };
        if (archived) archivedReadThisLaunch.add(cellIdB64);

        const previous = parse(
          await invoke<string | null>("read_history_export", { seed, agent: myPubKeyB64 }),
        );

        // Reading nothing where there used to be messages is far more likely
        // a fault (a conversation that failed to load) than a real change.
        if (history.messages.length === 0 && (previous?.messages.length ?? 0) > 0) {
          console.warn(`${TAG} read no messages for ${seed}; keeping the previous export`);
          continue;
        }
        messages += history.messages.length;
        if (previous && contentKey(previous) === contentKey(history)) {
          unchanged++;
          continue;
        }

        await invoke("write_history_export", {
          seed,
          contents: JSON.stringify(history),
          agent: myPubKeyB64,
        });
        written++;
      } catch (e) {
        failed++;
        const message = e instanceof Error ? e.message : JSON.stringify(e);
        console.error(`${TAG} could not export ${seed}: ${message}`);
      }
    }

    // Warn level: the release log drops webview info-level output.
    console.warn(
      `${TAG} done: ${messages} messages; ${written} file(s) written, ${unchanged} unchanged, ` +
        `${failed} failed, in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
  } finally {
    running = false;
  }
}
