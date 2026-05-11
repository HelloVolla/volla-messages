/**
 * ConversationMessageStore — production-grade rewrite
 *
 * Architecture:
 *   - Canonical internal order is insertion order in a plain JS object
 *     { [hash]: MessageExtended }.  All sorted output uses timestamp ASC
 *     via the deriveGenericKeyValueStore listSortBy parameter.
 *   - Memory is unbounded during normal use; a hard cap of HARD_MEMORY_LIMIT
 *     (500) evicts oldest entries only during scroll-up prepend.
 *   - Three-state pagination cursor:
 *       oldestMemoryTimestamp  – cursor for the next DB page query
 *       dbExhausted            – DB has no rows older than the cursor
 *       networkExhausted       – Holochain returned 0 hashes for older buckets
 *   - Signal-first dedup: existing in-memory entries always win on merge.
 *   - loadMoreMessages is the only path that prepends older messages.
 *     It never calls _initLoadFromDB (which is init-only).
 *   - _fetchAndStoreTooDB stores to DB only; it never touches in-memory state.
 *   - Polling (_loadFromBucketPipeline) hydrates memory from the newest DB
 *     records after storing, using signal-first merge.
 */

import {
  type CellIdB64,
  type LocalFile,
  type Message,
  type MessageExtended,
  type MessageFile,
  type MessageRecord,
  type MessageSignal,
  type ProfileExtended,
  MessageType,
} from "$lib/types";
import { encodeCellIdToBase64, decodeCellIdFromBase64, enqueueNotification } from "$lib/utils";
import { EntryRecord } from "@holochain-open-dev/utils";
import {
  decodeHashFromBase64,
  encodeHashToBase64,
  type ActionHashB64,
  type CellId,
  type Record as HolochainRecord,
} from "@holochain/client";
import { flatten, range, sum } from "lodash-es";
import type { ConversationStore } from "./ConversationStore";
import {
  createGenericKeyKeyValueStore,
  deriveGenericKeyValueStore,
  type GenericKeyKeyValueStore,
} from "./generic/GenericKeyKeyValueStore";
import {
  deriveCellMergedProfileContactInviteStore,
  type MergedProfileContactInviteStore,
} from "./MergedProfileContactInviteStore";
import type { RelayClient } from "./RelayClient";
import { derived, get, writable } from "svelte/store";
import type { GenericKeyValueStoreReadable } from "./generic/GenericKeyValueStore";
import { TARGET_MESSAGES_COUNT, MESSAGES_PER_PAGE } from "$config";
import type { FileStore } from "./FileStore";
import { messageDB } from "./db/MessageDatabase";

// ── Pagination cursor ─────────────────────────────────────────────────────────
//
// oldestMemoryTimestamp
//   Timestamp of the oldest message currently held in the in-memory store.
//   Used as the exclusive upper-bound for the next getOlderMessages() DB call.
//   Recomputed after every operation that could change the oldest end of memory.
//
// dbExhausted
//   Set true when the local DB returns 0 rows older than oldestMemoryTimestamp.
//   Reset to false after a network backfill writes new messages into the DB.
//
// networkExhausted
//   Set true when Holochain returns 0 action-hashes for all queried buckets
//   before the cursor bucket.  Prevents infinite retries at history start.
// ─────────────────────────────────────────────────────────────────────────────
interface PaginationState {
  oldestMemoryTimestamp: number | undefined;
  dbExhausted: boolean;
  networkExhausted: boolean;
}

// Only evict old messages during scroll-up prepend, and only if memory
// exceeds this generous limit. Most conversations never reach it.
const HARD_MEMORY_LIMIT = 500;

// ── Public store interface ────────────────────────────────────────────────────

export interface ConversationMessageStore extends GenericKeyKeyValueStore<MessageExtended> {
  initialize: () => Promise<void>;
  loadMessagesInCurrentBucketTargetCount: (
    local: boolean,
    key1: CellIdB64,
    targetCount?: number,
    bucketChunkSize?: number,
    maxBucketsToFetch?: number,
  ) => Promise<number>;
  loadMessagesInPreviousBucketTargetCount: (
    local: boolean,
    key1: CellIdB64,
    targetCount?: number,
    bucketChunkSize?: number,
    maxBucketsToFetch?: number,
  ) => Promise<number>;
  loadMoreMessages: (key1: CellIdB64) => Promise<number>;
  sendMessage: (key1: CellIdB64, content: string, files: LocalFile[]) => Promise<void>;
  sendJoinNotice: (key1: CellIdB64) => Promise<void>;
  deleteMessage: (key1: CellIdB64, actionHashB64: ActionHashB64) => Promise<void>;
  handleMessageSignalReceived: (key1: CellIdB64, signal: MessageSignal) => Promise<void>;
  handleMessageDeletedSignalReceived: (
    key1: CellIdB64,
    actionHashB64: ActionHashB64,
  ) => Promise<void>;
  debugGetAllMessages: (key1: CellIdB64) => Promise<MessageRecord[]>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConversationMessageStore(
  client: RelayClient,
  conversationStore: ConversationStore,
  mergedProfileContactInviteStore: MergedProfileContactInviteStore,
  fileStore: FileStore,
): ConversationMessageStore {

  function _cid(id: CellIdB64): string { return id.slice(0, 10); }

  function _log(stage: string, details?: { [key: string]: unknown }): void {
    if (details) console.log(`[MessageFlow] ${stage}`, details);
    else console.log(`[MessageFlow] ${stage}`);
  }

  // ── Internal raw store: { [cellIdB64]: { [hash]: MessageExtended } } ────────
  const messages = createGenericKeyKeyValueStore<MessageExtended>();

  // ── Per-conversation pagination state ─────────────────────────────────────
  const paginationState = writable<{ [cellIdB64: CellIdB64]: PaginationState }>({});

  // ── Filtered public subscribe ──────────────────────────────────────────────
  // Hides messages from agents with no known profile/contact unless profiles
  // haven't loaded yet (prevents a race condition on first open).
  const { subscribe } = derived(
    [messages, mergedProfileContactInviteStore],
    ([$messages, $mergedProfileContactInviteStore]) => {
      const filteredMessages = Object.fromEntries(
        $messages.list.map(([cellIdB64, messagesData]) => {
          const profilesLoaded =
            $mergedProfileContactInviteStore.data[cellIdB64] !== undefined;

          const filtered = Object.entries(messagesData).filter(([, msg]) => {
            if (!profilesLoaded) return true;
            if (msg.message.message_type === MessageType.System) return true;
            return (
              $mergedProfileContactInviteStore.data[cellIdB64][msg.authorAgentPubKeyB64] !==
              undefined
            );
          });

          return [cellIdB64, Object.fromEntries(filtered)];
        }),
      );

      return {
        data: filteredMessages,
        list: Object.entries(filteredMessages),
        count: Object.keys(filteredMessages).length,
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZE
  // ═══════════════════════════════════════════════════════════════════════════

  async function initialize(): Promise<void> {
    _log("initialize:start");
    const cellInfos = await client.getRelayClonedCellInfos();

    // Seed empty maps for every known conversation cell
    messages.set(
      Object.fromEntries(cellInfos.map((ci) => [encodeCellIdToBase64(ci.cell_id), {}])),
    );
    paginationState.set(
      Object.fromEntries(
        cellInfos.map((ci) => [
          encodeCellIdToBase64(ci.cell_id),
          { oldestMemoryTimestamp: undefined, dbExhausted: false, networkExhausted: false },
        ]),
      ),
    );

    const results = await Promise.allSettled(
      cellInfos.map(async (cellInfo) => {
        const cellIdB64 = encodeCellIdToBase64(cellInfo.cell_id);
        _log("initialize:cell:start", { cell: _cid(cellIdB64) });

        // 1. Load most-recent page from local DB (signal-first merge)
        await _initLoadFromDB(cellIdB64);

        // 2. If DB was empty, bootstrap from Holochain (local-first for speed)
        const memCount = Object.keys(get(messages).data[cellIdB64] || {}).length;
        if (memCount === 0) {
          _log("initialize:cell:db-empty→network-bootstrap", { cell: _cid(cellIdB64) });
          await loadMessagesInCurrentBucketTargetCount(
            true, cellIdB64, TARGET_MESSAGES_COUNT, 10, 50,
          );
        }

        _log("initialize:cell:done", {
          cell: _cid(cellIdB64),
          memCount: Object.keys(get(messages).data[cellIdB64] || {}).length,
          state: get(paginationState)[cellIdB64],
        });
      }),
    );

    results.forEach((r, i) => {
      if (r.status === "rejected")
        console.error(`[init] cell ${i} failed:`, r.reason);
    });

    _log("initialize:complete", { cells: cellInfos.length });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DB → MEMORY  (init only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load the most-recent MESSAGES_PER_PAGE messages from IndexedDB into memory.
   * Used ONLY during initialization; never called from loadMoreMessages.
   *
   * Signal-first: if a message is already in memory (e.g., arrived via signal
   * before init finished) the in-memory copy wins — DB data is never applied
   * on top of a live entry.
   */
  async function _initLoadFromDB(cellIdB64: CellIdB64): Promise<void> {
    try {
      await messageDB.clearCacheOnAgentChange(cellIdB64);
      const dbMessages = await messageDB.getMessages(cellIdB64, MESSAGES_PER_PAGE);
      _log("db:init-load", { cell: _cid(cellIdB64), count: dbMessages.length });
      if (dbMessages.length === 0) return;

      // Signal-first merge
      messages.update((m) => {
        const existing = m[cellIdB64] || {};
        const merged = { ...existing };
        for (const [hash, msg] of dbMessages) {
          if (!(hash in merged)) merged[hash] = msg;
        }
        return { ...m, [cellIdB64]: merged };
      });

      _refreshOldestCursor(cellIdB64);
    } catch (err) {
      console.error("[_initLoadFromDB] failed:", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCROLL-UP PAGINATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load the next page of older messages for infinite-scroll.
   *
   * Strategy:
   *   1. Query local DB for messages older than oldestMemoryTimestamp.
   *   2. If DB is exhausted, run a network backfill then re-query DB.
   *   3. Merge results into memory (signal-first, no trim on the newest end).
   *
   * Returns the number of messages actually new to the in-memory store.
   */
  async function loadMoreMessages(cellIdB64: CellIdB64): Promise<number> {
    const state = get(paginationState)[cellIdB64];
    if (!state) return 0;

    const cursor = state.oldestMemoryTimestamp;
    if (cursor === undefined) {
      _log("scroll-up:skip:no-cursor", { cell: _cid(cellIdB64) });
      return 0;
    }

    if (state.networkExhausted) {
      _log("scroll-up:skip:network-exhausted", { cell: _cid(cellIdB64) });
      return 0;
    }

    _log("scroll-up:start", { cell: _cid(cellIdB64), cursor, ...state });

    // ── 1. Local DB ────────────────────────────────────────────────────────
    if (!state.dbExhausted) {
      const olderMsgs = await messageDB.getOlderMessages(cellIdB64, cursor, MESSAGES_PER_PAGE);
      _log("scroll-up:db-result", { cell: _cid(cellIdB64), count: olderMsgs.length });

      if (olderMsgs.length > 0) {
        const added = _mergeOlderIntoMemory(cellIdB64, olderMsgs);
        _log("scroll-up:served-from-db", { cell: _cid(cellIdB64), added });
        return added;
      }

      // DB has nothing older than the cursor — mark exhausted, try network.
      _setPaginationPartial(cellIdB64, { dbExhausted: true });
    }

    // ── 2. Network backfill ────────────────────────────────────────────────
    _log("scroll-up:network-backfill-start", { cell: _cid(cellIdB64), cursor });
    const { newlyStored, noMoreOnNetwork } = await _backfillOlderMessagesToDB(
      cellIdB64,
      cursor,
    );
    _log("scroll-up:network-backfill-result", {
      cell: _cid(cellIdB64),
      newlyStored,
      noMoreOnNetwork,
    });

    if (noMoreOnNetwork) {
      _setPaginationPartial(cellIdB64, { networkExhausted: true });
      return 0;
    }

    // Re-query DB with the same cursor. Works whether newlyStored > 0
    // (fresh data) or == 0 (all hashes already in DB but not in memory).
    const olderMsgs = await messageDB.getOlderMessages(cellIdB64, cursor, MESSAGES_PER_PAGE);
    _log("scroll-up:db-retry-after-backfill", {
      cell: _cid(cellIdB64),
      count: olderMsgs.length,
    });

    if (olderMsgs.length > 0) {
      _setPaginationPartial(cellIdB64, { dbExhausted: false });
      const added = _mergeOlderIntoMemory(cellIdB64, olderMsgs);
      _log("scroll-up:served-after-backfill", { cell: _cid(cellIdB64), added });
      return added;
    }

    // Backfill ran, DB still returns 0. Edge case: all hashes already in DB
    // but their timestamps are >= cursor (clock-skew). Do not mark network
    // exhausted — caller can retry; we just can't serve a page right now.
    _log("scroll-up:done:no-results-after-backfill", { cell: _cid(cellIdB64) });
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMORY HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Merge a batch of (older) messages into the in-memory store.
   * Existing entries win (signal-first dedup).
   * Refreshes the oldest-memory cursor after merging.
   * Applies HARD_MEMORY_LIMIT eviction (oldest end) if needed.
   *
   * Returns the number of entries that were genuinely new to memory.
   */
  function _mergeOlderIntoMemory(
    cellIdB64: CellIdB64,
    batch: [ActionHashB64, MessageExtended][],
  ): number {
    if (batch.length === 0) return 0;

    let addedCount = 0;
    messages.update((m) => {
      const existing = m[cellIdB64] || {};
      const merged = { ...existing };
      for (const [hash, msg] of batch) {
        if (!(hash in merged)) {
          merged[hash] = msg;
          addedCount++;
        }
      }
      return { ...m, [cellIdB64]: merged };
    });

    // Refresh cursor; then apply the hard cap (evicts oldest if over limit).
    _refreshOldestCursor(cellIdB64);
    _applyHardMemoryCap(cellIdB64);

    return addedCount;
  }

  /**
   * Insert a single newest-end message into memory.
   * Does NOT update oldestMemoryTimestamp unless memory was empty.
   * Does NOT trim — new signals and sent messages must always stay visible.
   */
  function _insertNewestIntoMemory(
    cellIdB64: CellIdB64,
    hash: ActionHashB64,
    msg: MessageExtended,
  ): void {
    messages.update((m) => {
      const existing = m[cellIdB64] || {};
      if (hash in existing) return m; // already present
      return { ...m, [cellIdB64]: { ...existing, [hash]: msg } };
    });

    // If this is the very first message in memory, initialise the cursor.
    paginationState.update((s) => {
      const cur = s[cellIdB64] ?? {
        oldestMemoryTimestamp: undefined,
        dbExhausted: false,
        networkExhausted: false,
      };
      if (cur.oldestMemoryTimestamp === undefined) {
        return { ...s, [cellIdB64]: { ...cur, oldestMemoryTimestamp: msg.timestamp } };
      }
      return s;
    });
  }

  /**
   * Recompute and persist the minimum timestamp across all in-memory messages.
   * Must be called after any operation that may change the oldest end of memory.
   */
  function _refreshOldestCursor(cellIdB64: CellIdB64): void {
    const mem = get(messages).data[cellIdB64] || {};
    const vals = Object.values(mem);
    if (vals.length === 0) {
      _setPaginationPartial(cellIdB64, { oldestMemoryTimestamp: undefined });
      return;
    }
    const oldest = Math.min(...vals.map((m) => m.timestamp));
    _setPaginationPartial(cellIdB64, { oldestMemoryTimestamp: oldest });
  }

  /**
   * Evict the oldest messages when memory exceeds HARD_MEMORY_LIMIT.
   * Called only during scroll-up prepend; never during signal receipt.
   * Keeps the HARD_MEMORY_LIMIT most-recent messages.
   */
  function _applyHardMemoryCap(cellIdB64: CellIdB64): void {
    const mem = get(messages).data[cellIdB64] || {};
    const entries = Object.entries(mem);
    if (entries.length <= HARD_MEMORY_LIMIT) return;

    // Sort newest-first, keep the head.
    const sorted = [...entries].sort(([, a], [, b]) => b.timestamp - a.timestamp);
    const kept = sorted.slice(0, HARD_MEMORY_LIMIT);

    messages.update((m) => ({ ...m, [cellIdB64]: Object.fromEntries(kept) }));
    _refreshOldestCursor(cellIdB64);

    _log("memory:hard-cap-applied", {
      cell: _cid(cellIdB64),
      evicted: entries.length - HARD_MEMORY_LIMIT,
    });
  }

  function _setPaginationPartial(
    cellIdB64: CellIdB64,
    patch: Partial<PaginationState>,
  ): void {
    paginationState.update((s) => ({
      ...s,
      [cellIdB64]: {
        ...(s[cellIdB64] ?? {
          oldestMemoryTimestamp: undefined,
          dbExhausted: false,
          networkExhausted: false,
        }),
        ...patch,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NETWORK BACKFILL  (scroll-up)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Query Holochain for message hashes in buckets before cursorTimestamp,
   * download entries that are missing from IndexedDB, store them.
   * Does NOT update the in-memory store (caller does that via a DB query).
   *
   * Returns:
   *   newlyStored    – count of messages newly written to IndexedDB
   *   noMoreOnNetwork – true when Holochain returned 0 hashes for all queried buckets
   */
  async function _backfillOlderMessagesToDB(
    cellIdB64: CellIdB64,
    cursorTimestamp: number,
  ): Promise<{ newlyStored: number; noMoreOnNetwork: boolean }> {
    const oldestBucket = conversationStore.getBucket(cellIdB64, cursorTimestamp);
    if (oldestBucket <= 0) {
      return { newlyStored: 0, noMoreOnNetwork: true };
    }

    _log("backfill:start", { cell: _cid(cellIdB64), startBucket: oldestBucket - 1 });

    // Fetch bucket hashes from Holochain (local DHT first to avoid slow network calls)
    const bucketsToFetch = await _fetchBucketsTargetCount(
      cellIdB64,
      oldestBucket - 1,
      true,
      TARGET_MESSAGES_COUNT,
      3,
      3,
    );

    const allHashes = flatten(bucketsToFetch.map((b) => b.actionHashB64s));

    if (allHashes.length === 0) {
      _log("backfill:no-hashes-on-network", { cell: _cid(cellIdB64) });
      return { newlyStored: 0, noMoreOnNetwork: true };
    }

    const missingHashes = await _filterMissingHashesFromDB(allHashes);
    _log("backfill:missing-from-db", {
      cell: _cid(cellIdB64),
      total: allHashes.length,
      missing: missingHashes.length,
    });

    if (missingHashes.length === 0) {
      // All hashes already in DB. Not network-exhausted — DB just has everything.
      // The edge case (all in DB but wrong timestamps) is handled by the caller.
      return { newlyStored: 0, noMoreOnNetwork: false };
    }

    const newlyStored = await _fetchAndStoreToDB(cellIdB64, missingHashes);
    return { newlyStored, noMoreOnNetwork: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POLLING / BUCKET PIPELINE  (current bucket refresh)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch hashes from the current bucket range, download missing entries,
   * store to DB, then hydrate the newest messages into memory.
   * Used for initial load and ongoing polling — NOT for scroll-up.
   */
  async function loadMessagesInCurrentBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    targetCount = TARGET_MESSAGES_COUNT,
    bucketChunkSize = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    const bucket = conversationStore.getBucket(key1, Date.now());
    return _loadFromBucketPipeline(
      local, key1, bucket, targetCount, bucketChunkSize, maxBucketsToFetch,
    );
  }

  /**
   * Same as above but starting from the bucket before the oldest in-memory message.
   */
  async function loadMessagesInPreviousBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    targetCount = TARGET_MESSAGES_COUNT,
    bucketChunkSize = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    const cursor = get(paginationState)[key1]?.oldestMemoryTimestamp;
    if (!cursor) return 0;
    const oldestBucket = conversationStore.getBucket(key1, cursor);
    return _loadFromBucketPipeline(
      local, key1, oldestBucket - 1, targetCount, bucketChunkSize, maxBucketsToFetch,
    );
  }

  /**
   * Core bucket → hash → entry → DB → memory pipeline.
   * Stores missing entries to DB, then hydrates the newest MESSAGES_PER_PAGE
   * into memory using a signal-first merge.
   */
  async function _loadFromBucketPipeline(
    local: boolean,
    key1: CellIdB64,
    bucket: number,
    targetCount: number,
    bucketChunkSize: number,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    _log("pipeline:start", { cell: _cid(key1), local, bucket, targetCount });

    const bucketsToFetch = await _fetchBucketsTargetCount(
      key1, bucket, local, targetCount, bucketChunkSize, maxBucketsToFetch,
    );

    const allHashes = flatten(bucketsToFetch.map((b) => b.actionHashB64s));
    _log("pipeline:hashes", { cell: _cid(key1), total: allHashes.length });

    const missingHashes = await _filterMissingHashesFromDB(allHashes);
    _log("pipeline:missing", { cell: _cid(key1), missing: missingHashes.length });

    if (missingHashes.length === 0) {
      _log("pipeline:no-new-messages", { cell: _cid(key1) });
      return 0;
    }

    const stored = await _fetchAndStoreToDB(key1, missingHashes);
    _log("pipeline:stored", { cell: _cid(key1), stored });

    // Hydrate the newest page into memory so new messages are immediately visible.
    await _hydrateNewestFromDB(key1);

    return stored;
  }

  /**
   * Read the newest MESSAGES_PER_PAGE messages from DB and merge them into
   * memory using signal-first policy. Updates the oldest cursor.
   */
  async function _hydrateNewestFromDB(cellIdB64: CellIdB64): Promise<void> {
    const dbMessages = await messageDB.getMessages(cellIdB64, MESSAGES_PER_PAGE);
    if (dbMessages.length === 0) return;

    messages.update((m) => {
      const existing = m[cellIdB64] || {};
      const merged = { ...existing };
      for (const [hash, msg] of dbMessages) {
        if (!(hash in merged)) merged[hash] = msg;
      }
      return { ...m, [cellIdB64]: merged };
    });

    _refreshOldestCursor(cellIdB64);
    _log("db:hydrate-newest", {
      cell: _cid(cellIdB64),
      dbCount: dbMessages.length,
      memCount: Object.keys(get(messages).data[cellIdB64] || {}).length,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NETWORK PIPELINE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async function _fetchBucketsTargetCount(
    key1: CellIdB64,
    bucket: number,
    local: boolean,
    targetCount: number,
    bucketChunkSize: number,
    maxBucketsToFetch?: number,
  ): Promise<{ bucket: number; actionHashB64s: ActionHashB64[] }[]> {
    const cellId = decodeCellIdFromBase64(key1);
    let bucketsToFetch: { bucket: number; actionHashB64s: ActionHashB64[] }[] = [];

    while (
      sum(bucketsToFetch.map(({ actionHashB64s }) => actionHashB64s.length)) <= targetCount &&
      bucket >= 0 &&
      (maxBucketsToFetch === undefined || bucketsToFetch.length <= maxBucketsToFetch)
    ) {
      const chunk = range(bucket, bucket - bucketChunkSize).filter((b) => b >= 0);
      _log("pipeline:bucket-scan:chunk", { cell: _cid(key1), chunk, local });

      bucketsToFetch = [
        ...bucketsToFetch,
        ...(await Promise.all(
          chunk.map(async (b) => ({
            bucket: b,
            actionHashB64s: (
              await client.getMessageHashes(cellId, { bucket: b, count: 0 }, local)
            ).map(encodeHashToBase64),
          })),
        )),
      ];
      bucket -= 1;
    }

    // Trim the last bucket if we already exceeded targetCount without it.
    while (
      sum(bucketsToFetch.slice(0, -1).map(({ actionHashB64s }) => actionHashB64s.length)) >
      targetCount
    ) {
      bucketsToFetch.pop();
    }

    return bucketsToFetch;
  }

  /**
   * Parallel bulk-filter: return only the hashes not already in IndexedDB.
   */
  async function _filterMissingHashesFromDB(
    actionHashB64s: ActionHashB64[],
  ): Promise<ActionHashB64[]> {
    if (actionHashB64s.length === 0) return [];
    const checks = await Promise.all(
      actionHashB64s.map(async (h) => ({ h, exists: await messageDB.hasMessage(h) })),
    );
    return checks.filter((c) => !c.exists).map((c) => c.h);
  }

  /**
   * Fetch entries from Holochain, store them in IndexedDB.
   * Does NOT update the in-memory store. Returns count of stored entries.
   */
  async function _fetchAndStoreToDB(
    key1: CellIdB64,
    hashes: ActionHashB64[],
  ): Promise<number> {
    if (hashes.length === 0) return 0;
    _log("fetch-store:start", { cell: _cid(key1), hashes: hashes.length });

    const cellId = decodeCellIdFromBase64(key1);
    const records = await client.getMessageEntries(
      cellId,
      hashes.map(decodeHashFromBase64),
      false,
    );
    _log("fetch-store:records", { cell: _cid(key1), fetched: records.length });

    const settled = await Promise.allSettled(
      records.map(
        async (r) =>
          [
            encodeHashToBase64(r.original_action),
            await _makeMessageExtended(cellId, r),
          ] as [ActionHashB64, MessageExtended],
      ),
    );

    const valid = settled.filter((p) => p.status === "fulfilled").map((p) => p.value);
    if (valid.length === 0) return 0;

    await messageDB.storeMessages(key1, valid);
    _log("fetch-store:stored", { cell: _cid(key1), count: valid.length });
    return valid.length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  async function sendMessage(key1: CellIdB64, content: string, files: LocalFile[]): Promise<void> {
    const cellId = decodeCellIdFromBase64(key1);

    const messageFiles = await Promise.all(
      files.map(async (file) => {
        const entryHash = await fileStore.upload(key1, file.file);
        return {
          last_modified: file.file.lastModified,
          name: file.file.name,
          size: file.file.size,
          storage_entry_hash: entryHash,
          file_type: file.file.type,
        } as MessageFile;
      }),
    );

    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const agentPubKeys = get(mergedProfileContact).list.map(([a]) => decodeHashFromBase64(a));

    const record = await client.createMessage(cellId, {
      message: {
        content,
        bucket: conversationStore.getBucket(key1, Date.now()),
        images: messageFiles,
        message_type: MessageType.User,
      },
      agents: agentPubKeys,
    });

    const message = new EntryRecord<Message>(record).entry;
    if (!message) throw new Error("Failed to decode Message entry from record");

    const messageExtended = await _makeMessageExtended(cellId, {
      message,
      original_action: record.signed_action.hashed.hash,
      signed_action: record.signed_action,
    });

    const actionHashB64 = encodeHashToBase64(record.signed_action.hashed.hash);

    // Persist first, then update memory.
    await messageDB.storeMessage(key1, actionHashB64, messageExtended);
    _insertNewestIntoMemory(key1, actionHashB64, messageExtended);
  }

  async function sendJoinNotice(key1: CellIdB64): Promise<void> {
    const cellId = decodeCellIdFromBase64(key1);
    let agentPubKeys;
    try {
      agentPubKeys = await client.getAgentsWithProfile(cellId);
    } catch {
      agentPubKeys = [client.client.myPubKey];
    }

    const record = await client.createMessage(cellId, {
      message: {
        content: "",
        bucket: conversationStore.getBucket(key1, Date.now()),
        images: [],
        message_type: MessageType.System,
      },
      agents: agentPubKeys,
    });

    const entryMessage = new EntryRecord<Message>(record).entry;
    if (!entryMessage) throw new Error("Failed to decode Message entry from record");

    const messageExtended = await _makeMessageExtended(cellId, {
      message: entryMessage,
      original_action: record.signed_action.hashed.hash,
      signed_action: record.signed_action,
    });

    const actionHashB64 = encodeHashToBase64(record.signed_action.hashed.hash);
    await messageDB.storeMessage(key1, actionHashB64, messageExtended);
    _insertNewestIntoMemory(key1, actionHashB64, messageExtended);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIGNAL HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  async function handleMessageSignalReceived(
    key1: CellIdB64,
    signal: MessageSignal,
  ): Promise<void> {
    const actionHashB64 = encodeHashToBase64(signal.action.hashed.hash);

    // DB dedup first (cheaper than making the MessageExtended)
    if (await messageDB.hasMessage(actionHashB64)) {
      _log("signal:dup-db", { cell: _cid(key1), hash: actionHashB64 });
      return;
    }
    // Memory dedup (fast path for race conditions)
    if (actionHashB64 in (get(messages).data[key1] || {})) {
      _log("signal:dup-memory", { cell: _cid(key1), hash: actionHashB64 });
      return;
    }

    const messageExtended = await _makeMessageExtended(decodeCellIdFromBase64(key1), {
      message: signal.message,
      original_action: signal.action.hashed.hash,
      signed_action: signal.action,
    });

    await messageDB.storeMessage(key1, actionHashB64, messageExtended);
    _insertNewestIntoMemory(key1, actionHashB64, messageExtended);

    // Notification
    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const fromProfile = get(mergedProfileContact).data[encodeHashToBase64(signal.from)];
    _triggerMessageNotification(messageExtended, fromProfile);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════════════

  async function deleteMessage(key1: CellIdB64, actionHashB64: ActionHashB64): Promise<void> {
    const cellId = decodeCellIdFromBase64(key1);
    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const agentPubKeys = get(mergedProfileContact).list.map(([a]) => decodeHashFromBase64(a));

    await client.deleteMessage(cellId, {
      original_message_hash: decodeHashFromBase64(actionHashB64),
      agents: agentPubKeys,
    });

    await messageDB.deleteMessage(actionHashB64);
    _removeFromMemory(key1, actionHashB64);
  }

  async function handleMessageDeletedSignalReceived(
    key1: CellIdB64,
    actionHashB64: ActionHashB64,
  ): Promise<void> {
    if (!(actionHashB64 in (get(messages).data[key1] || {}))) return;
    await messageDB.deleteMessage(actionHashB64);
    _removeFromMemory(key1, actionHashB64);
  }

  function _removeFromMemory(cellIdB64: CellIdB64, actionHashB64: ActionHashB64): void {
    messages.update((m) => {
      const copy = { ...(m[cellIdB64] || {}) };
      delete copy[actionHashB64];
      return { ...m, [cellIdB64]: copy };
    });
    // Cursor may have changed if we removed the oldest message.
    _refreshOldestCursor(cellIdB64);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  async function _makeMessageExtended(
    cellId: CellId,
    messageRecord: MessageRecord,
  ): Promise<MessageExtended> {
    if (!messageRecord.message)
      throw new Error("MessageRecord does not include message entry");

    const base: MessageExtended = {
      message: messageRecord.message,
      authorAgentPubKeyB64: encodeHashToBase64(
        messageRecord.signed_action.hashed.content.author,
      ),
      timestamp: messageRecord.signed_action.hashed.content.timestamp,
    };

    if (messageRecord.message.images.length > 0) {
      messageRecord.message.images.forEach((f) =>
        fileStore.download(
          encodeCellIdToBase64(cellId),
          encodeHashToBase64(f.storage_entry_hash),
        ),
      );
    }

    return base;
  }

  async function _triggerMessageNotification(
    messageExtended: MessageExtended,
    fromProfile?: ProfileExtended,
  ): Promise<void> {
    if (messageExtended.message.message_type === MessageType.System) return;
    const content =
      messageExtended.message.content.length > 125
        ? messageExtended.message.content.slice(0, 50) + "…"
        : messageExtended.message.content;
    await enqueueNotification(
      fromProfile ? `Message From ${fromProfile.profile.nickname}` : "New Message",
      content,
    );
  }

  async function debugGetAllMessages(key1: CellIdB64): Promise<MessageRecord[]> {
    const bucket = conversationStore.getBucket(key1, Date.now());
    const cellId = decodeCellIdFromBase64(key1);
    const records = await client.getMessagesForBuckets(
      cellId,
      Array.from({ length: bucket + 1 }, (_, i) => i),
    );
    console.log("debugGetAllMessages records:", records);
    return records;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC INTERFACE
  // ═══════════════════════════════════════════════════════════════════════════

  return {
    ...messages,
    initialize,
    loadMessagesInCurrentBucketTargetCount,
    loadMessagesInPreviousBucketTargetCount,
    loadMoreMessages,
    sendMessage,
    sendJoinNotice,
    handleMessageSignalReceived,
    subscribe,
    deleteMessage,
    handleMessageDeletedSignalReceived,
    debugGetAllMessages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CELL-SCOPED DERIVED STORE
// ─────────────────────────────────────────────────────────────────────────────

export interface CellConversationMessageStore
  extends GenericKeyValueStoreReadable<MessageExtended> {
  initialize: () => Promise<void>;
  loadMessagesInCurrentBucketTargetCount: (
    local: boolean,
    targetCount?: number,
    bucketChunkSize?: number,
    maxBucketsToFetch?: number,
  ) => Promise<number>;
  loadMessagesInPreviousBucketTargetCount: (
    local: boolean,
    targetCount?: number,
    bucketChunkSize?: number,
    maxBucketsToFetch?: number,
  ) => Promise<number>;
  loadMoreMessages: () => Promise<number>;
  sendMessage: (content: string, files: LocalFile[]) => Promise<void>;
  sendJoinNotice: () => Promise<void>;
  handleMessageSignalReceived: (signal: MessageSignal) => Promise<void>;
  debugGetAllMessages: () => Promise<HolochainRecord[]>;
}

export function deriveCellConversationMessageStore(
  conversationMessageStore: ConversationMessageStore,
  key: CellIdB64,
) {
  // Canonical sort: ascending timestamp = oldest → newest (chronological).
  // The UI receives this order directly; no .reverse() needed anywhere.
  const data = deriveGenericKeyValueStore(conversationMessageStore, key, [
    ([, m]) => m.timestamp,
  ]);

  return {
    ...data,
    loadMessagesInCurrentBucketTargetCount: (
      local: boolean,
      targetCount?: number,
      bucketChunkSize?: number,
      maxBucketsToFetch?: number,
    ) =>
      conversationMessageStore.loadMessagesInCurrentBucketTargetCount(
        local,
        key,
        targetCount,
        bucketChunkSize,
        maxBucketsToFetch,
      ),
    loadMessagesInPreviousBucketTargetCount: (
      local: boolean,
      targetCount?: number,
      bucketChunkSize?: number,
      maxBucketsToFetch?: number,
    ) =>
      conversationMessageStore.loadMessagesInPreviousBucketTargetCount(
        local,
        key,
        targetCount,
        bucketChunkSize,
        maxBucketsToFetch,
      ),
    loadMoreMessages: () => conversationMessageStore.loadMoreMessages(key),
    sendMessage: (content: string, files: LocalFile[]) =>
      conversationMessageStore.sendMessage(key, content, files),
    sendJoinNotice: () => conversationMessageStore.sendJoinNotice(key),
    handleMessageSignalReceived: (signal: MessageSignal) =>
      conversationMessageStore.handleMessageSignalReceived(key, signal),
    deleteMessage: (key1: CellIdB64, actionHashB64: ActionHashB64) =>
      conversationMessageStore.deleteMessage(key1, actionHashB64),
    debugGetAllMessages: () => conversationMessageStore.debugGetAllMessages(key),
  };
}
