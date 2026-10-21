import { get } from "svelte/store";
import { encodeHashToBase64, type CellId, type EntryHash } from "@holochain/client";
import { FileStorageClient } from "@holochain-open-dev/file-storage";
import { BUCKET_RANGE_MS } from "$config";
import type { RelayClient } from "$store/RelayClient";
import type { ConversationStore } from "$store/ConversationStore";
import type { ConversationExtended, MessageRecord } from "$lib/types";

/**
 * MEASUREMENT ONLY — sizes the 1.0.4 history export before it is built.
 *
 * Walks every enabled conversation the way the export will (day buckets, read
 * from this device only, never the network) and logs what it finds: message
 * counts, text size, the size of the JSON the export would write, and images —
 * declared size, whether they are actually on this device, and how long
 * reading them takes. Image totals are also split by age, to pick a cap.
 *
 * Read-only: writes no files and does not enable archived conversations.
 * Runs only in a build made with VITE_MEASURE_HISTORY=1.
 */

const TAG = "[history-measure]";
const BUCKET_CHUNK = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_LIMITS_DAYS = [30, 90, 180, 365];

interface ImageTotals {
  count: number;
  declaredBytes: number;
  onDevice: number;
  onDeviceBytes: number;
  missing: number;
  readMs: number;
  /** Declared bytes of images younger than each limit in AGE_LIMITS_DAYS. */
  bytesByAge: number[];
}

interface ConversationResult {
  title: string;
  days: number;
  messages: number;
  textBytes: number;
  exportJsonBytes: number;
  images: ImageTotals;
  ms: number;
}

const utf8 = new TextEncoder();

function emptyImages(): ImageTotals {
  return {
    count: 0,
    declaredBytes: 0,
    onDevice: 0,
    onDeviceBytes: 0,
    missing: 0,
    readMs: 0,
    bytesByAge: AGE_LIMITS_DAYS.map(() => 0),
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/** The shape the export will write per message, to size it realistically. */
function exportShape(record: MessageRecord) {
  const action = record.signed_action.hashed.content;
  return {
    id: encodeHashToBase64(record.original_action),
    author: encodeHashToBase64(action.author),
    timestamp: action.timestamp,
    type: record.message?.message_type,
    content: record.message?.content,
    images: (record.message?.images ?? []).map((i) => ({
      name: i.name,
      size: i.size,
      type: i.file_type,
      hash: encodeHashToBase64(i.storage_entry_hash),
    })),
  };
}

/** Read an image's bytes from this device only; resolves to bytes read, or undefined. */
async function readImageLocally(
  files: FileStorageClient,
  hash: EntryHash,
): Promise<number | undefined> {
  try {
    const metadata = await files.getFileMetadata(hash, true);
    let bytes = 0;
    for (const chunkHash of metadata.chunks_hashes) {
      const chunk = await files.fetchChunk(chunkHash, true);
      bytes += chunk.size;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

async function measureConversation(
  relayClient: RelayClient,
  conversation: ConversationExtended,
  now: number,
): Promise<ConversationResult> {
  const started = performance.now();
  const cellId: CellId = conversation.cellInfo.cell_id;
  const title = conversation.config?.title ?? conversation.cellInfo.name;
  const lastBucket = Math.max(
    0,
    Math.round((now - conversation.dnaProperties.created) / BUCKET_RANGE_MS),
  );

  const files = new FileStorageClient(relayClient.client, "UNUSED ROLE NAME", "file_storage", cellId);
  const result: ConversationResult = {
    title,
    days: lastBucket + 1,
    messages: 0,
    textBytes: 0,
    exportJsonBytes: 0,
    images: emptyImages(),
    ms: 0,
  };

  for (let first = 0; first <= lastBucket; first += BUCKET_CHUNK) {
    const buckets: number[] = [];
    for (let b = first; b <= Math.min(lastBucket, first + BUCKET_CHUNK - 1); b++) buckets.push(b);

    const records = await relayClient.getMessagesForBuckets(cellId, buckets);
    for (const record of records) {
      if (!record.message) continue;
      result.messages++;
      result.textBytes += utf8.encode(record.message.content).length;
      result.exportJsonBytes += utf8.encode(JSON.stringify(exportShape(record))).length;

      // Microseconds since the epoch, as Holochain timestamps are.
      const ageDays = (now - record.signed_action.hashed.content.timestamp / 1000) / DAY_MS;
      for (const image of record.message.images) {
        result.images.count++;
        result.images.declaredBytes += image.size;
        AGE_LIMITS_DAYS.forEach((limit, i) => {
          if (ageDays <= limit) result.images.bytesByAge[i] += image.size;
        });

        const readStarted = performance.now();
        const bytes = await readImageLocally(files, image.storage_entry_hash);
        result.images.readMs += performance.now() - readStarted;
        if (bytes === undefined) {
          result.images.missing++;
        } else {
          result.images.onDevice++;
          result.images.onDeviceBytes += bytes;
        }
      }
    }
  }

  result.ms = performance.now() - started;
  return result;
}

export async function measureHistory(
  relayClient: RelayClient,
  conversationStore: ConversationStore,
): Promise<void> {
  const now = Date.now();
  const conversations = Object.values(get(conversationStore).data) as ConversationExtended[];
  const enabled = conversations.filter((c) => c.cellInfo.enabled);
  console.warn(
    `${TAG} starting: ${enabled.length} enabled conversation(s), ` +
      `${conversations.length - enabled.length} archived skipped`,
  );

  const totals = {
    messages: 0,
    textBytes: 0,
    exportJsonBytes: 0,
    images: emptyImages(),
    ms: 0,
  };

  for (const conversation of enabled) {
    try {
      const r = await measureConversation(relayClient, conversation, now);
      console.warn(
        `${TAG} "${r.title}": ${r.days} days, ${r.messages} messages, ` +
          `text ${kb(r.textBytes)} KB, export JSON ${kb(r.exportJsonBytes)} KB, ` +
          `images ${r.images.count} (${mb(r.images.declaredBytes)} MB declared, ` +
          `${r.images.onDevice} on device = ${mb(r.images.onDeviceBytes)} MB, ` +
          `${r.images.missing} missing, read ${(r.images.readMs / 1000).toFixed(1)} s), ` +
          `took ${(r.ms / 1000).toFixed(1)} s`,
      );
      totals.messages += r.messages;
      totals.textBytes += r.textBytes;
      totals.exportJsonBytes += r.exportJsonBytes;
      totals.ms += r.ms;
      totals.images.count += r.images.count;
      totals.images.declaredBytes += r.images.declaredBytes;
      totals.images.onDevice += r.images.onDevice;
      totals.images.onDeviceBytes += r.images.onDeviceBytes;
      totals.images.missing += r.images.missing;
      totals.images.readMs += r.images.readMs;
      r.images.bytesByAge.forEach((b, i) => (totals.images.bytesByAge[i] += b));
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      console.warn(`${TAG} failed on "${conversation.cellInfo.name}": ${message}`);
    }
  }

  const byAge = AGE_LIMITS_DAYS.map(
    (limit, i) => `${limit}d ${mb(totals.images.bytesByAge[i])} MB`,
  ).join(", ");
  console.warn(
    `${TAG} TOTAL: ${totals.messages} messages, text ${kb(totals.textBytes)} KB, ` +
      `export JSON ${kb(totals.exportJsonBytes)} KB; images ${totals.images.count} ` +
      `(${mb(totals.images.declaredBytes)} MB declared, ${totals.images.onDevice} on device = ` +
      `${mb(totals.images.onDeviceBytes)} MB, ${totals.images.missing} missing); ` +
      `image bytes by age: ${byAge}; ` +
      `walk took ${(totals.ms / 1000).toFixed(1)} s of which image reads ` +
      `${(totals.images.readMs / 1000).toFixed(1)} s`,
  );
}
