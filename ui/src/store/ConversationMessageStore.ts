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
  isConferenceLog,
  parseConferenceLog,
} from "$lib/types";
import { encodeCellIdToBase64, decodeCellIdFromBase64, enqueueNotification } from "$lib/utils";
import { EntryRecord } from "@holochain-open-dev/utils";
import {
  decodeHashFromBase64,
  encodeHashToBase64,
  type ActionHashB64,
  type CellId,
} from "@holochain/client";
import { flatten, range, sum } from "lodash-es";
import type { ConversationStore } from "./ConversationStore";
import {
  createGenericKeyValueStore,
  type GenericKeyValueStore,
  type GenericKeyValueStoreReadable,
} from "./generic/GenericKeyValueStore";
import {
  deriveCellMergedProfileContactInviteStore,
  type MergedProfileContactInviteStore,
} from "./MergedProfileContactInviteStore";
import type { RelayClient } from "./RelayClient";
import { derived, get, writable } from "svelte/store";
import { TARGET_MESSAGES_COUNT, MESSAGES_PER_PAGE } from "$config";
import type { FileStore } from "./FileStore";
import { messageDB } from "./db/MessageDatabase";

interface PaginationState {
  oldestMemoryTimestamp: number | undefined;
  dbExhausted: boolean;
  networkExhausted: boolean;
}

const HARD_MEMORY_LIMIT = 500;

export interface ConversationMessageStore
  extends GenericKeyValueStore<Record<ActionHashB64, MessageExtended>> {
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
  sendMessage: (
    key1: CellIdB64,
    content: string,
    files: LocalFile[],
    replyTo?: ActionHashB64,
  ) => Promise<void>;
  sendJoinNotice: (key1: CellIdB64) => Promise<void>;
  getReplyCount: (key1: CellIdB64, messageHash: ActionHashB64) => Promise<number>;
  deleteMessage: (key1: CellIdB64, actionHashB64: ActionHashB64) => Promise<void>;
  handleMessageSignalReceived: (key1: CellIdB64, signal: MessageSignal) => Promise<void>;
  handleMessageDeletedSignalReceived: (
    key1: CellIdB64,
    actionHashB64: ActionHashB64,
  ) => Promise<void>;
  debugGetAllMessages: (key1: CellIdB64) => Promise<MessageRecord[]>;
}

export function createConversationMessageStore(
  client: RelayClient,
  conversationStore: ConversationStore,
  mergedProfileContactInviteStore: MergedProfileContactInviteStore,
  fileStore: FileStore,
): ConversationMessageStore {
  function _cid(id: CellIdB64): string {
    return id.slice(0, 10);
  }

  function _log(stage: string, details?: { [key: string]: unknown }): void {
    if (details) console.log(`[MessageFlow] ${stage}`, details);
    else console.log(`[MessageFlow] ${stage}`);
  }

  function _getSortedMemoryEntries(cellIdB64: CellIdB64): [ActionHashB64, MessageExtended][] {
    return Object.entries(get(messages).data[cellIdB64] || {}).sort(([, a], [, b]) => a.timestamp - b.timestamp);
  }

  function _getOldestMessage(cellIdB64: CellIdB64): MessageExtended | undefined {
    return _getSortedMemoryEntries(cellIdB64)[0]?.[1];
  }

const messages = createGenericKeyValueStore<Record<ActionHashB64, MessageExtended>>();
const paginationState = writable<Record<string, PaginationState>>({});

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
              $mergedProfileContactInviteStore.data[cellIdB64]?.[msg.authorAgentPubKeyB64] !==
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

  async function initialize(): Promise<void> {
    _log("initialize:start");
    const cellInfos = await client.getRelayClonedCellInfos();

    messages.set(
      Object.fromEntries(cellInfos.map((ci) => [encodeCellIdToBase64(ci.cell_id), {}])),
    );

    paginationState.set(
      Object.fromEntries(
        cellInfos.map((ci) => [
          encodeCellIdToBase64(ci.cell_id),
          {
            oldestMemoryTimestamp: undefined,
            dbExhausted: false,
            networkExhausted: false,
          },
        ]),
      ),
    );

    const results = await Promise.allSettled(
      cellInfos.map(async (cellInfo) => {
        const cellIdB64 = encodeCellIdToBase64(cellInfo.cell_id);
        _log("initialize:cell:start", { cell: _cid(cellIdB64) });

        await _initLoadFromDB(cellIdB64);

        const memCount = Object.keys(get(messages).data[cellIdB64] || {}).length;
        if (memCount === 0) {
          _log("initialize:cell:db-empty→network-bootstrap", { cell: _cid(cellIdB64) });
          await loadMessagesInCurrentBucketTargetCount(
            true,
            cellIdB64,
            TARGET_MESSAGES_COUNT,
            10,
            50,
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
      if (r.status === "rejected") {
        console.error(`[init] cell ${i} failed:`, r.reason);
      }
    });

    _log("initialize:complete", { cells: cellInfos.length });
  }

  async function _initLoadFromDB(cellIdB64: CellIdB64): Promise<void> {
    try {
      await messageDB.clearCacheOnAgentChange(cellIdB64);
      const dbMessages = await messageDB.getMessages(cellIdB64, MESSAGES_PER_PAGE);
      _log("db:init-load", { cell: _cid(cellIdB64), count: dbMessages.length });

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
      _recomputeThreadCounts(cellIdB64);
    } catch (err) {
      console.error("[_initLoadFromDB] failed:", err);
    }
  }

  async function loadMoreMessages(cellIdB64: CellIdB64): Promise<number> {
    const state = get(paginationState)[cellIdB64];
    console.group(`[MessageFlow][loadMoreMessages] ${_cid(cellIdB64)}`);

    if (!state) {
      console.log("No pagination state");
      console.groupEnd();
      return 0;
    }

    if (state.dbExhausted && state.networkExhausted) {
      console.log("Skip: history exhausted");
      console.groupEnd();
    return 0;
}
    console.log("paginationState(before):", state);

    const memoryBefore = _getSortedMemoryEntries(cellIdB64);

    console.log("memory count(before):", memoryBefore.length);
    console.log(
      "oldest memory(before):",
      memoryBefore[0]?.[1]
        ? {
            timestamp: memoryBefore[0][1].timestamp,
            bucket: memoryBefore[0][1].message.bucket,
            hash: memoryBefore[0][0],
          }
        : null,
    );
    console.log(
      "newest memory(before):",
      memoryBefore[memoryBefore.length - 1]?.[1]
        ? {
            timestamp: memoryBefore[memoryBefore.length - 1][1].timestamp,
            bucket: memoryBefore[memoryBefore.length - 1][1].message.bucket,
            hash: memoryBefore[memoryBefore.length - 1][0],
          }
        : null,
    );

    const cursor = state.oldestMemoryTimestamp;
    console.log("cursor:", cursor);

    if (cursor === undefined) {
      console.log("Skip: no cursor");
      console.groupEnd();
      return 0;
    }

    const olderMsgs = await messageDB.getOlderMessages(cellIdB64, cursor, MESSAGES_PER_PAGE);
    console.log("IndexedDB olderMsgs count:", olderMsgs.length);
    console.log(
      "IndexedDB olderMsgs sample:",
      olderMsgs.slice(0, 3).map(([hash, msg]) => ({
        hash,
        timestamp: msg.timestamp,
        bucket: msg.message.bucket,
        type: msg.message.message_type,
      })),
    );

    if (olderMsgs.length > 0) {
      const added = _mergeOlderIntoMemory(cellIdB64, olderMsgs);
      console.log("Merged older messages from DB. added:", added);

      const memoryAfter = _getSortedMemoryEntries(cellIdB64);

      console.log("memory count(after DB merge):", memoryAfter.length);
      console.log(
        "oldest memory(after DB merge):",
        memoryAfter[0]?.[1]
          ? {
              timestamp: memoryAfter[0][1].timestamp,
              bucket: memoryAfter[0][1].message.bucket,
              hash: memoryAfter[0][0],
            }
          : null,
      );
      console.groupEnd();
      return added;
    }

    console.log("IndexedDB returned 0 older rows. Trying LOCAL previous-bucket pipeline...");

    const loadedViaLocalPipeline = await loadMessagesInPreviousBucketTargetCount(
      true,
      cellIdB64,
      TARGET_MESSAGES_COUNT,
      3,
      3,
    );

    console.log("loadedViaLocalPipeline:", loadedViaLocalPipeline);

    const olderMsgsAfterPipeline = await messageDB.getOlderMessages(cellIdB64, cursor, MESSAGES_PER_PAGE);
    console.log("IndexedDB olderMsgs AFTER local pipeline:", olderMsgsAfterPipeline.length);
    console.log(
      "IndexedDB olderMsgs AFTER local pipeline sample:",
      olderMsgsAfterPipeline.slice(0, 3).map(([hash, msg]) => ({
        hash,
        timestamp: msg.timestamp,
        bucket: msg.message.bucket,
        type: msg.message.message_type,
      })),
    );

    if (olderMsgsAfterPipeline.length > 0) {
      const added = _mergeOlderIntoMemory(cellIdB64, olderMsgsAfterPipeline);
      console.log("Merged older messages after local pipeline. added:", added);

      const memoryAfter = _getSortedMemoryEntries(cellIdB64);

      console.log("memory count(after local pipeline merge):", memoryAfter.length);
      console.log(
        "oldest memory(after local pipeline merge):",
        memoryAfter[0]?.[1]
          ? {
              timestamp: memoryAfter[0][1].timestamp,
              bucket: memoryAfter[0][1].message.bucket,
              hash: memoryAfter[0][0],
            }
          : null,
      );
      console.groupEnd();
      return added;
    }

    console.log("No older messages found locally.");
    markHistoryExhausted(cellIdB64);
    console.groupEnd();
    return 0;
  }

  function markHistoryExhausted(cellIdB64: CellIdB64): void {
  _setPaginationPartial(cellIdB64, {
    dbExhausted: true,
    networkExhausted: true,
  });

  _log("pagination:exhausted", { cell: _cid(cellIdB64) });
}

 async function loadMessagesInPreviousBucketTargetCount(
  local: boolean,
  key1: CellIdB64,
  targetCount = TARGET_MESSAGES_COUNT,
  bucketChunkSize = 3,
  maxBucketsToFetch?: number,
): Promise<number> {
  const cursor = get(paginationState)[key1]?.oldestMemoryTimestamp;

  console.group(`[MessageFlow][previousBucket] ${_cid(key1)}`);
  console.log("local:", local);
  console.log("cursor:", cursor);

  if (!cursor) {
    console.log("No cursor");
    console.groupEnd();
    return 0;
  }

  const memory = Object.entries(get(messages).data[key1] || {}).sort(
    ([, a], [, b]) => a.timestamp - b.timestamp,
  );

  const oldestMsg = memory[0]?.[1];

  console.log(
    "memory oldest:",
    oldestMsg
      ? {
          timestamp: oldestMsg.timestamp,
          bucket: oldestMsg.message.bucket,
        }
      : null,
  );

  if (!oldestMsg) {
    console.log("No oldest message in memory");
    console.groupEnd();
    return 0;
  }

  const oldestBucket = oldestMsg.message.bucket;
  console.log("using oldest message.bucket:", oldestBucket);

  if (oldestBucket <= 0) {
    console.log("Already at earliest bucket");
    markHistoryExhausted(key1);
    console.groupEnd();
    return 0;
  }

  console.log("requesting start bucket:", oldestBucket - 1);

  const result = await _loadFromBucketPipeline(
    local,
    key1,
    oldestBucket - 1,
    targetCount,
    bucketChunkSize,
    maxBucketsToFetch,
  );

  console.log("result:", result);
  console.groupEnd();
  return result;
}

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

    _refreshOldestCursor(cellIdB64);
    _applyHardMemoryCap(cellIdB64);
    _recomputeThreadCounts(cellIdB64);

    return addedCount;
  }

  function _insertNewestIntoMemory(
    cellIdB64: CellIdB64,
    hash: ActionHashB64,
    msg: MessageExtended,
  ): void {
    messages.update((m) => {
      const existing = m[cellIdB64] || {};
      if (hash in existing) return m;
      return { ...m, [cellIdB64]: { ...existing, [hash]: msg } };
    });

    paginationState.update((s) => {
      const cur = s[cellIdB64] ?? {
        oldestMemoryTimestamp: undefined,
        dbExhausted: false,
        networkExhausted: false,
      };

      if (cur.oldestMemoryTimestamp === undefined) {
        return {
          ...s,
          [cellIdB64]: { ...cur, oldestMemoryTimestamp: msg.timestamp },
        };
      }

      return s;
    });

    _recomputeThreadCounts(cellIdB64);
  }

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

  function _applyHardMemoryCap(cellIdB64: CellIdB64): void {
    const mem = get(messages).data[cellIdB64] || {};
    const entries = Object.entries(mem);

    if (entries.length <= HARD_MEMORY_LIMIT) return;

    const sorted = [...entries].sort(([, a], [, b]) => b.timestamp - a.timestamp);
    const kept = sorted.slice(0, HARD_MEMORY_LIMIT);

    messages.update((m) => ({
      ...m,
      [cellIdB64]: Object.fromEntries(kept),
    }));

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

  async function _backfillOlderMessagesToDB(
    cellIdB64: CellIdB64,
    _cursorTimestamp: number,
  ): Promise<{ newlyStored: number; noMoreOnNetwork: boolean }> {
    const oldestMessage = _getOldestMessage(cellIdB64);
    if (!oldestMessage) {
      return { newlyStored: 0, noMoreOnNetwork: true };
    }

    const oldestBucket = oldestMessage.message.bucket;
    if (oldestBucket <= 0) {
      return { newlyStored: 0, noMoreOnNetwork: true };
    }

    _log("backfill:start", { cell: _cid(cellIdB64), startBucket: oldestBucket - 1 });

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
      return { newlyStored: 0, noMoreOnNetwork: false };
    }

    const newlyStored = await _fetchAndStoreToDB(cellIdB64, missingHashes);
    return { newlyStored, noMoreOnNetwork: false };
  }

  async function loadMessagesInCurrentBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    targetCount = TARGET_MESSAGES_COUNT,
    bucketChunkSize = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    const bucket = conversationStore.getBucket(key1, Date.now());

    return _loadFromBucketPipeline(
      local,
      key1,
      bucket,
      targetCount,
      bucketChunkSize,
      maxBucketsToFetch,
    );
  }

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
      key1,
      bucket,
      local,
      targetCount,
      bucketChunkSize,
      maxBucketsToFetch,
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

    await _hydrateNewestFromDB(key1);

    return stored;
  }

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
    _recomputeThreadCounts(cellIdB64);

    _log("db:hydrate-newest", {
      cell: _cid(cellIdB64),
      dbCount: dbMessages.length,
      memCount: Object.keys(get(messages).data[cellIdB64] || {}).length,
    });
  }

  async function _fetchBucketsTargetCount(
    key1: CellIdB64,
    bucket: number,
    local: boolean,
    targetCount: number,
    bucketChunkSize: number,
    maxBucketsToFetch?: number,
  ): Promise<{ bucket: number; actionHashB64s: ActionHashB64[] }[]> {
    const cellId = decodeCellIdFromBase64(key1);
    const bucketsToFetch: { bucket: number; actionHashB64s: ActionHashB64[] }[] = [];

    let currentBucket = bucket;
    let fetchedBucketCount = 0;
    let totalHashes = 0;

    while (
      totalHashes <= targetCount &&
      currentBucket >= 0 &&
      (maxBucketsToFetch === undefined || fetchedBucketCount < maxBucketsToFetch)
    ) {
      const chunkStart = currentBucket;
      const chunkEnd = Math.max(0, currentBucket - bucketChunkSize + 1);
      const chunk = range(chunkStart, chunkEnd - 1, -1);

      _log("pipeline:bucket-scan:chunk", { cell: _cid(key1), chunk, local });

      const chunkResults = await Promise.all(
        chunk.map(async (b) => {
          const hashes = (
            await client.getMessageHashes(cellId, { bucket: b, count: 0 }, local)
          ).map(encodeHashToBase64);

          return {
            bucket: b,
            actionHashB64s: hashes,
          };
        }),
      );

      bucketsToFetch.push(...chunkResults);
      totalHashes = sum(bucketsToFetch.map(({ actionHashB64s }) => actionHashB64s.length));
      fetchedBucketCount += chunkResults.length;
      currentBucket = chunkEnd - 1;
    }

    while (
      bucketsToFetch.length > 1 &&
      sum(bucketsToFetch.slice(0, -1).map(({ actionHashB64s }) => actionHashB64s.length)) >=
        targetCount
    ) {
      bucketsToFetch.pop();
    }

    return bucketsToFetch;
  }

  async function _filterMissingHashesFromDB(
    actionHashB64s: ActionHashB64[],
  ): Promise<ActionHashB64[]> {
    if (actionHashB64s.length === 0) return [];

    const checks = await Promise.all(
      actionHashB64s.map(async (h) => ({
        h,
        exists: await messageDB.hasMessage(h),
      })),
    );

    return checks.filter((c) => !c.exists).map((c) => c.h);
  }

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

    const valid = settled
      .filter(
        (p): p is PromiseFulfilledResult<[ActionHashB64, MessageExtended]> =>
          p.status === "fulfilled",
      )
      .map((p) => p.value);

    if (valid.length === 0) return 0;

    await messageDB.storeMessages(key1, valid);
    _log("fetch-store:stored", { cell: _cid(key1), count: valid.length });

    return valid.length;
  }

  async function sendMessage(
    key1: CellIdB64,
    content: string,
    files: LocalFile[],
    replyTo?: ActionHashB64,
  ): Promise<void> {
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
        reply_to: replyTo ? decodeHashFromBase64(replyTo) : undefined,
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

  async function handleMessageSignalReceived(
    key1: CellIdB64,
    signal: MessageSignal,
  ): Promise<void> {
    const actionHashB64 = encodeHashToBase64(signal.action.hashed.hash);

    if (await messageDB.hasMessage(actionHashB64)) {
      _log("signal:dup-db", { cell: _cid(key1), hash: actionHashB64 });
      return;
    }

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

    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const fromProfile = get(mergedProfileContact).data[encodeHashToBase64(signal.from)];
    _triggerMessageNotification(messageExtended, fromProfile);
  }

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

    _refreshOldestCursor(cellIdB64);
    _recomputeThreadCounts(cellIdB64);
  }

  /**
   * Recompute replyCount / hasReplies by BFS-ing the in-memory reply graph and
   * counting ALL transitive descendants of each parent. Because the store only
   * holds a bounded window (HARD_MEMORY_LIMIT), the in-memory count can be lower
   * than the true count when replies sit outside the window — so we never
   * downgrade below the DHT-derived count already on the message; we only raise
   * it. Only affected parents are patched, leaving the rest of the map untouched.
   */
  function _recomputeThreadCounts(cellIdB64: CellIdB64): void {
    try {
      const allMessages = get(messages).data[cellIdB64] || {};

      // Build parent → children map from reply_to relationships
      const childrenMap: Record<ActionHashB64, ActionHashB64[]> = {};
      for (const [hash, msg] of Object.entries(allMessages)) {
        if (msg.message?.reply_to) {
          const parentHash = encodeHashToBase64(msg.message.reply_to);
          if (!childrenMap[parentHash]) childrenMap[parentHash] = [];
          childrenMap[parentHash].push(hash);
        }
      }

      if (Object.keys(childrenMap).length === 0) return;

      // BFS from each parent to count all transitive descendants in memory
      const counts: Record<ActionHashB64, number> = {};
      for (const parentHash of Object.keys(childrenMap)) {
        const queue = [...childrenMap[parentHash]];
        const seen = new Set<ActionHashB64>();
        let count = 0;
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (seen.has(current)) continue;
          seen.add(current);
          count++;
          (childrenMap[current] || []).forEach((c) => queue.push(c));
        }
        counts[parentHash] = count;
      }

      messages.update((m) => {
        const current = m[cellIdB64];
        if (!current) return m;
        const patched = { ...current };
        for (const [hash, count] of Object.entries(counts)) {
          if (!patched[hash]) continue;
          // Never downgrade a DHT-derived count just because replies are not in the window.
          const nextCount = Math.max(patched[hash].replyCount ?? 0, count);
          patched[hash] = {
            ...patched[hash],
            replyCount: nextCount,
            hasReplies: nextCount > 0 || patched[hash].hasReplies === true,
          };
        }
        return { ...m, [cellIdB64]: patched };
      });
    } catch (e) {
      console.error("[ConversationMessageStore] _recomputeThreadCounts error:", e);
    }
  }

  async function _makeMessageExtended(
    cellId: CellId,
    messageRecord: MessageRecord,
  ): Promise<MessageExtended> {
    if (!messageRecord.message) {
      throw new Error("MessageRecord does not include message entry");
    }

    const base: MessageExtended = {
      message: messageRecord.message,
      authorAgentPubKeyB64: encodeHashToBase64(
        messageRecord.signed_action.hashed.content.author,
      ),
      timestamp: messageRecord.signed_action.hashed.content.timestamp,
    };

    // Hydrate the parent message if this is a reply (for inline reply context)
    if (messageRecord.message.reply_to) {
      try {
        const replyToRecord = await client.getMessageEntries(
          cellId,
          [messageRecord.message.reply_to],
          false,
        );
        if (replyToRecord.length > 0 && replyToRecord[0].message) {
          base.replyToMessage = {
            message: replyToRecord[0].message,
            authorAgentPubKeyB64: encodeHashToBase64(
              replyToRecord[0].signed_action.hashed.content.author,
            ),
            timestamp: replyToRecord[0].signed_action.hashed.content.timestamp,
          };
        } else {
          console.warn("[ConversationMessageStore] Reply-to record not found or invalid");
        }
      } catch (error) {
        console.error("[ConversationMessageStore] Error fetching reply-to message:", error);
      }
    }

    // Fetch the DHT reply count so thread indicators are accurate independent of
    // what is currently in memory (the in-memory recompute only ever raises this).
    try {
      const count = await client.getReplyCount(cellId, messageRecord.signed_action.hashed.hash);
      base.replyCount = count;
      base.hasReplies = count > 0;
    } catch (error) {
      console.error("[ConversationMessageStore] Error fetching reply count:", error);
    }

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

    const rawContent = messageExtended.message.content;

    let content;
    if (isConferenceLog(rawContent)) {
      const log = parseConferenceLog(rawContent);
      content = log?.event === "started" ? "📞 Call started" : "📞 Call ended";
    } else {
      content = rawContent.length > 125 ? rawContent.slice(0, 50) + "…" : rawContent;
    }

    await enqueueNotification(
      fromProfile ? `Message From ${fromProfile.profile.nickname}` : "New Message",
      content,
    );
  }

  async function getReplyCount(key1: CellIdB64, messageHash: ActionHashB64): Promise<number> {
    const cellId = decodeCellIdFromBase64(key1);
    return await client.getReplyCount(cellId, decodeHashFromBase64(messageHash));
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

  return {
    ...messages,
    initialize,
    loadMessagesInCurrentBucketTargetCount,
    loadMessagesInPreviousBucketTargetCount,
    loadMoreMessages,
    sendMessage,
    sendJoinNotice,
    getReplyCount,
    handleMessageSignalReceived,
    subscribe,
    deleteMessage,
    handleMessageDeletedSignalReceived,
    debugGetAllMessages,
  };
}

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
  sendMessage: (content: string, files: LocalFile[], replyTo?: ActionHashB64) => Promise<void>;
  sendJoinNotice: () => Promise<void>;
  getReplyCount: (messageHash: ActionHashB64) => Promise<number>;
  handleMessageSignalReceived: (signal: MessageSignal) => Promise<void>;
  deleteMessage: (actionHashB64: ActionHashB64) => Promise<void>;
  debugGetAllMessages: () => Promise<MessageRecord[]>;
}

export function deriveCellConversationMessageStore(
  conversationMessageStore: ConversationMessageStore,
  key: CellIdB64,
): CellConversationMessageStore {
  const sorted = derived(conversationMessageStore, ($store) => {
    const data = $store.data[key] || {};
    const list = Object.entries(data).sort(([, a], [, b]) => a.timestamp - b.timestamp);

    return {
      data,
      list,
      count: list.length,
    };
  });

  return {
    subscribe: sorted.subscribe,
    initialize: conversationMessageStore.initialize,
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
    sendMessage: (content: string, files: LocalFile[], replyTo?: ActionHashB64) =>
      conversationMessageStore.sendMessage(key, content, files, replyTo),
    sendJoinNotice: () => conversationMessageStore.sendJoinNotice(key),
    getReplyCount: (messageHash: ActionHashB64) =>
      conversationMessageStore.getReplyCount(key, messageHash),
    handleMessageSignalReceived: (signal: MessageSignal) =>
      conversationMessageStore.handleMessageSignalReceived(key, signal),
    deleteMessage: (actionHashB64: ActionHashB64) =>
      conversationMessageStore.deleteMessage(key, actionHashB64),
    debugGetAllMessages: () => conversationMessageStore.debugGetAllMessages(key),
  };
}