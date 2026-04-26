import {
  type CellIdB64,
  type LocalFile,
  type Message,
  type MessageExtended,
  type MessageFile,
  type MessageRecord,
  type MessageSignal,
  type ProfileExtended,
} from "$lib/types";
import { encodeCellIdToBase64, decodeCellIdFromBase64, enqueueNotification } from "$lib/utils";
import { EntryRecord } from "@holochain-open-dev/utils";
import {
  decodeHashFromBase64,
  encodeHashToBase64,
  type ActionHashB64,
  type CellId,
  type HoloHash,
  type Record,
} from "@holochain/client";
import { difference, flatten, range, sortBy, sum } from "lodash-es";
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

// Interface for pagination state
interface PaginationState {
  loadedPages: number;
  totalMessages: number;
  oldestLoadedTimestamp?: number;
}

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
  sendMessage: (
    key1: CellIdB64,
    content: string,
    files: LocalFile[],
    replyTo?: ActionHashB64,
  ) => Promise<void>;
  getReplyCount: (key1: CellIdB64, messageHash: ActionHashB64) => Promise<number>;
  deleteMessage: (key1: CellIdB64, messageContent: string) => Promise<void>;
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
  // In-memory store holds only active messages (limited by pagination)
  const messages = createGenericKeyKeyValueStore<MessageExtended>();

  // Track pagination state for each conversation
  const paginationState = writable<{ [cellIdB64: CellIdB64]: PaginationState }>({});

  // Filter out messages by agents who do not have a Contact nor Profile
  // Don't filter if profiles haven't loaded yet (prevents race condition)
  const { subscribe } = derived(
    [messages, mergedProfileContactInviteStore],
    ([$messages, $mergedProfileContactInviteStore]) => {
      const filteredMessages = Object.fromEntries(
        $messages.list.map(([cellIdB64, messagesData]) => {
          const messagesArray = Object.entries(messagesData);

          // Check if profiles have loaded for this cell
          const profilesLoadedForCell =
            $mergedProfileContactInviteStore.data[cellIdB64] !== undefined;

          // If profiles haven't loaded yet, show all messages (prevent race condition)
          // Once profiles load, filter to only show messages from known authors
          const filtered = messagesArray.filter(([actionHash, messageExtended]) => {
            // If profiles not loaded yet, don't filter anything out
            if (!profilesLoadedForCell) {
              return true;
            }

            // Profiles are loaded, so only show messages from known authors
            const hasAuthor =
              $mergedProfileContactInviteStore.data[cellIdB64][
                messageExtended.authorAgentPubKeyB64
              ] !== undefined;

            return hasAuthor;
          });

          return [cellIdB64, Object.fromEntries(filtered)];
        }),
      );

      const result = {
        data: filteredMessages,
        list: Object.entries(filteredMessages),
        count: Object.keys(filteredMessages).length,
      };

      return result;
    },
  );

  async function initialize() {
    const cellInfos = await client.getRelayClonedCellInfos();
    // Log all Cell IDs for debugging
    cellInfos.forEach((cellInfo, index) => {
      const cellIdB64 = encodeCellIdToBase64(cellInfo.cell_id);
    });

    // Initialize empty messages for each conversation
    const messagesData = Object.fromEntries(
      cellInfos.map((cellInfo) => [encodeCellIdToBase64(cellInfo.cell_id), {}]),
    );
    messages.set(messagesData);

    // Initialize pagination state
    const initialPaginationState = Object.fromEntries(
      cellInfos.map((cellInfo) => [
        encodeCellIdToBase64(cellInfo.cell_id),
        { loadedPages: 0, totalMessages: 0 },
      ]),
    );
    paginationState.set(initialPaginationState);

    // Load initial messages from IndexedDB for each conversation
    const results = await Promise.allSettled(
      cellInfos.map(async (cellInfo) => {
        const cellIdB64 = encodeCellIdToBase64(cellInfo.cell_id);

        await _loadMessagesFromDB(cellIdB64, 1); // Load first page

        // If no messages in DB, try to fetch from network
        const currentState = get(paginationState)[cellIdB64];

        if (currentState.totalMessages === 0) {
          // when first initializing go local
          await loadMessagesInCurrentBucketTargetCount(
            true,
            cellIdB64,
            TARGET_MESSAGES_COUNT,
            10,
            50,
          );
        }
      }),
    );

    // Log any errors
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to load messages for conversation ${index}:`, result.reason);
      }
    });

    console.log(" Initialization complete");
  }

  /**
   * Load messages from IndexedDB into memory store with memory management
   * Now merges with existing in-memory messages instead of overwriting
   */
  async function _loadMessagesFromDB(cellIdB64: CellIdB64, pagesToLoad: number): Promise<void> {
    try {
      const limit = pagesToLoad * MESSAGES_PER_PAGE;

      // Check if agent changed and clear cache if needed
      const cacheCleared = await messageDB.clearCacheOnAgentChange(cellIdB64);

      const dbMessages = await messageDB.getMessages(cellIdB64, limit);
      console.log(` Retrieved ${dbMessages.length} messages from IndexedDB`);

      if (dbMessages.length > 0) {
        // Sort messages by timestamp (newest to oldest) for natural chat order
        const sortedMessages = dbMessages.sort(([, a], [, b]) => b.timestamp - a.timestamp);

        // Apply memory management: keep only the most recent messages within limit based on loaded pages
        const maxMessagesInMemory = pagesToLoad * MESSAGES_PER_PAGE;
        const messagesToKeep = sortedMessages.slice(0, maxMessagesInMemory); // Keep from beginning (newest)

        // Fetch fresh reply counts for all messages from DHT (not from cache)
        const cellId = decodeCellIdFromBase64(cellIdB64);
        const messagesWithUpdatedCounts = await Promise.all(
          messagesToKeep.map(async ([actionHashB64, messageExtended]) => {
            try {
              const count = await client.getReplyCount(cellId, decodeHashFromBase64(actionHashB64));
              // Always update with fresh count and hasReplies flag
              return [
                actionHashB64,
                {
                  ...messageExtended,
                  replyCount: count,
                  hasReplies: count > 0,
                },
              ] as [ActionHashB64, MessageExtended];
            } catch (error) {
              console.error("[ConversationMessageStore] Error fetching reply count:", error);
              // Keep existing values on error
              return [actionHashB64, messageExtended] as [ActionHashB64, MessageExtended];
            }
          }),
        );

        const messageData = Object.fromEntries(messagesWithUpdatedCounts);

        messages.update((m) => ({
          ...m,
          [cellIdB64]: messageData,
        }));

        _recomputeThreadCounts(cellIdB64);

        // Update pagination state
        paginationState.update((state) => ({
          ...state,
          [cellIdB64]: {
            ...state[cellIdB64],
            loadedPages: pagesToLoad,
            totalMessages: Object.keys(messagesToKeep).length,
            oldestLoadedTimestamp: messagesToKeep[messagesToKeep.length - 1]?.[1].timestamp, // Last (oldest) message in memory
          },
        }));
      } else {
        console.warn(`No messages found in IndexedDB for cell ${cellIdB64.substring(0, 10)}...`);
      }
    } catch (error) {
      console.error(" Error loading messages from DB:", error);
    }
  }

  /**
   * Load more messages (next page) for infinite scroll
   */
  async function loadMoreMessages(cellIdB64: CellIdB64): Promise<number> {
    const currentState = get(paginationState)[cellIdB64];
    if (!currentState?.oldestLoadedTimestamp) {
      return 0;
    }

    try {
      // First, try to load from IndexedDB
      const olderMessages = await messageDB.getOlderMessages(
        cellIdB64,
        currentState.oldestLoadedTimestamp,
        MESSAGES_PER_PAGE,
      );

      let loadedCount = 0;

      if (olderMessages.length > 0) {
        // Get current messages and sort them by timestamp (newest to oldest) for natural chat order
        const currentMessages = get(messages).data[cellIdB64] || {};
        const currentMessagesList = Object.entries(currentMessages).sort(
          ([, a], [, b]) => b.timestamp - a.timestamp,
        );

        // Combine older messages with current ones - older messages go at the end (bottom)
        const allMessages = [...currentMessagesList, ...olderMessages];

        // Calculate new loaded pages count
        const newLoadedPages = currentState.loadedPages + 1;
        const maxMessagesInMemory = newLoadedPages * MESSAGES_PER_PAGE;

        // Apply memory management: keep only the most recent messages within limit
        const messagesToKeep = allMessages.slice(0, maxMessagesInMemory);
        const updatedMessages = Object.fromEntries(messagesToKeep);
        messages.update((m) => ({
          ...m,
          [cellIdB64]: updatedMessages,
        }));

        _recomputeThreadCounts(cellIdB64);

        _recomputeThreadCounts(cellIdB64);

        paginationState.update((state) => ({
          ...state,
          [cellIdB64]: {
            ...state[cellIdB64],
            loadedPages: newLoadedPages,
            totalMessages: messagesToKeep.length,
            oldestLoadedTimestamp: messagesToKeep[messagesToKeep.length - 1]?.[1].timestamp,
          },
        }));
      }

      // This shouldn't be done, it will only likely trigger timeouts.  Unless the node is zero-arc (which we are not doing in Volla), all loading should be local.
      // Data will be synced quickly and so it's not worth trying to get it from the network.
      if (olderMessages.length === 0) {
        console.log(`Local DB empty. Using reliable backend sync...`);

        try {
          const cellId = decodeCellIdFromBase64(cellIdB64);

          // 1. Get the actual oldest message from memory to find its exact bucket
          const currentMessages = get(messages).data[cellIdB64] || {};
          const messagesList = Object.entries(currentMessages).sort(
            ([, a], [, b]) => a.timestamp - b.timestamp,
          );
          const oldestMessage = messagesList[0]?.[1];

          if (!oldestMessage) return 0;

          // 2. Read the bucket directly from the message object (No timestamp math!)
          const oldestBucket = oldestMessage.message.bucket;

          // 3. Safely ask for just the next 3 older buckets
          const targetBuckets = [oldestBucket - 1, oldestBucket - 2, oldestBucket - 3].filter(
            (b) => b >= 0,
          );

          if (targetBuckets.length > 0) {
            console.log(`Fetching buckets directly from DHT:`, targetBuckets);

            const messageRecords = await client.getMessagesForBuckets(cellId, targetBuckets);

            if (messageRecords.length > 0) {
              const messageEntries = await Promise.allSettled(
                messageRecords.map(
                  async (m) =>
                    [
                      encodeHashToBase64(m.original_action),
                      await _makeMessageExtended(cellId, m),
                    ] as [ActionHashB64, MessageExtended],
                ),
              );

              const validMessages = messageEntries
                .filter((p) => p.status === "fulfilled")
                .map((p: any) => p.value);

              await messageDB.storeMessages(cellIdB64, validMessages);
              await _loadMessagesFromDB(cellIdB64, currentState.loadedPages + 1);
              _applyMemoryManagement(cellIdB64);

              loadedCount = validMessages.length;
              console.log(`[Network Fetch] Success! Downloaded and saved ${loadedCount} messages.`);
            } else {
              console.log(`[Network Fetch] DHT returned 0 messages for those buckets.`);
            }
          }
        } catch (error) {
          console.error(` [Network Fetch] FAILED:`, error);
          loadedCount = 0;
        }
      }

      return loadedCount;
    } catch (error) {
      console.error("Error loading more messages:", error);
      return 0;
    }
  }

  /**
   * Recompute replyCount / hasReplies for messages that have replies, using the
   * full reply graph in memory.  Direct-only counts (from the DHT) miss
   * transitive replies (replies-to-replies), so we BFS from each parent and
   * count ALL descendants.  Only the affected messages are updated in the store.
   */
  function _recomputeThreadCounts(key1: CellIdB64): void {
    try {
      const allMessages = get(messages).data[key1] || {};

      // Build parent → children map from reply_to relationships
      const childrenMap: Record<ActionHashB64, ActionHashB64[]> = {};
      for (const [hash, msg] of Object.entries(allMessages)) {
        if (msg.message?.reply_to) {
          const parentHash = encodeHashToBase64(msg.message.reply_to);
          if (!childrenMap[parentHash]) childrenMap[parentHash] = [];
          childrenMap[parentHash].push(hash);
        }
      }

      // No replies in this conversation — nothing to update
      if (Object.keys(childrenMap).length === 0) return;

      // BFS from each parent to count all transitive descendants
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

      // Only patch the messages whose counts changed — do not replace the whole map
      messages.update((m) => {
        const current = m[key1];
        if (!current) return m;
        const patched = { ...current };
        for (const [hash, count] of Object.entries(counts)) {
          if (patched[hash]) {
            patched[hash] = { ...patched[hash], replyCount: count, hasReplies: count > 0 };
          }
        }
        return { ...m, [key1]: patched };
      });
    } catch (e) {
      console.error("[ConversationMessageStore] _recomputeThreadCounts error:", e);
    }
  }

  async function sendMessage(
    key1: CellIdB64,
    content: string,
    files: LocalFile[],
    replyTo?: ActionHashB64,
  ) {
    const cellId = decodeCellIdFromBase64(key1);
    const messageFiles = await Promise.all(
      files.map(async (file) => {
        const entryHash = await fileStore.upload(key1, file.file);

        const messageFile: MessageFile = {
          last_modified: file.file.lastModified,
          name: file.file.name,
          size: file.file.size,
          storage_entry_hash: entryHash,
          file_type: file.file.type,
        };
        return messageFile;
      }),
    );

    // Get all AgentPubKeys in the conversation.
    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const agentPubKeys = get(mergedProfileContact).list.map(([a]) => decodeHashFromBase64(a));

    // Create Message entry
    const messagePayload = {
      message: {
        content,
        bucket: conversationStore.getBucket(key1, new Date().getTime()),
        images: messageFiles,
        reply_to: replyTo ? decodeHashFromBase64(replyTo) : undefined,
      },
      agents: agentPubKeys,
    };

    const record = await client.createMessage(cellId, messagePayload);

    const message = new EntryRecord<Message>(record).entry;
    if (message === undefined) throw new Error("Failed to decode Message entry from record");

    const messageExtended = await _makeMessageExtended(cellId, {
      message,
      original_action: record.signed_action.hashed.hash,
      signed_action: record.signed_action,
    });

    const actionHashB64 = encodeHashToBase64(record.signed_action.hashed.hash);

    // Store in IndexedDB first
    await messageDB.storeMessage(key1, actionHashB64, messageExtended);

    // Update in-memory store (add new message at the end - newest timestamp)
    messages.update((m) => {
      const currentMessages = m[key1] || {};
      const messagesList = Object.entries(currentMessages).sort(
        ([, a], [, b]) => a.timestamp - b.timestamp, // oldest to newest
      );

      // Add new message at the end (it has the newest timestamp)
      const updatedMessages = Object.fromEntries([
        ...messagesList,
        [actionHashB64, messageExtended],
      ]);

      return {
        ...m,
        [key1]: updatedMessages,
      };
    });

    // Recompute all transitive thread counts now that a new message is in the store
    _recomputeThreadCounts(key1);

    // Apply memory management after adding new message
    _applyMemoryManagement(key1);

    // Update pagination state to reflect new message and potentially increase effective loaded pages
    paginationState.update((state) => {
      const currentState = state[key1] || { loadedPages: 1, totalMessages: 0 };
      const newTotalMessages = (currentState.totalMessages || 0) + 1;

      // If we're actively sending messages, consider that the user wants to see more recent content
      // Increase effective loaded pages if we have more messages than current page limit
      const currentLimit = currentState.loadedPages * MESSAGES_PER_PAGE;
      const newLoadedPages =
        newTotalMessages > currentLimit
          ? Math.ceil(newTotalMessages / MESSAGES_PER_PAGE)
          : currentState.loadedPages;

      return {
        ...state,
        [key1]: {
          ...currentState,
          loadedPages: Math.max(newLoadedPages, currentState.loadedPages),
          totalMessages: newTotalMessages,
        },
      };
    });
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

    // Remove from IndexedDB
    await messageDB.deleteMessage(actionHashB64);

    // Remove from in-memory store
    messages.update((m) => {
      const k = { ...m[key1] };
      delete k[actionHashB64];
      return {
        ...m,
        [key1]: k,
      };
    });
  }

  async function handleMessageDeletedSignalReceived(key1: CellIdB64, actionHashB64: ActionHashB64) {
    const currentMessages = get(messages).data[key1];
    if (currentMessages[actionHashB64] === undefined) {
      return;
    }

    // Remove from IndexedDB
    await messageDB.deleteMessage(actionHashB64);

    // Remove from in-memory store
    messages.update((m) => {
      const k = { ...m[key1] };
      delete k[actionHashB64];
      return {
        ...m,
        [key1]: k,
      };
    });
  }

  async function handleMessageSignalReceived(key1: CellIdB64, signal: MessageSignal) {
    const actionHashB64 = encodeHashToBase64(signal.action.hashed.hash);

    // Check for duplicates before processing
    const exists = await messageDB.hasMessage(actionHashB64);
    if (exists) {
      console.log(`Message ${actionHashB64} already exists, skipping duplicate`);
      return; // Skip duplicate
    }

    // Check if already in memory (double-check for race conditions)
    const currentMessages = get(messages).data[key1] || {};
    if (currentMessages[actionHashB64]) {
      console.log(`Message ${actionHashB64} already in memory, skipping duplicate`);
      return;
    }

    // Make MessageExtended
    const messageExtended = await _makeMessageExtended(decodeCellIdFromBase64(key1), {
      message: signal.message,
      original_action: signal.action.hashed.hash,
      signed_action: signal.action,
    });

    // Store in IndexedDB first
    await messageDB.storeMessage(key1, actionHashB64, messageExtended);

    // Add to in-memory store (add new message at the end - newest timestamp)
    messages.update((m) => {
      const currentMessages = m[key1] || {};
      const messagesList = Object.entries(currentMessages).sort(
        ([, a], [, b]) => a.timestamp - b.timestamp, // oldest to newest
      );

      // Add new message at the end (it has the newest timestamp)
      const updatedMessages = Object.fromEntries([
        ...messagesList,
        [actionHashB64, messageExtended],
      ]);

      return {
        ...m,
        [key1]: updatedMessages,
      };
    });

    // Recompute all transitive thread counts now that a new message is in the store
    _recomputeThreadCounts(key1);

    // Apply memory management after receiving new message
    _applyMemoryManagement(key1);

    // Update pagination state to reflect new message and potentially increase effective loaded pages
    paginationState.update((state) => {
      const currentState = state[key1] || { loadedPages: 1, totalMessages: 0 };
      const newTotalMessages = (currentState.totalMessages || 0) + 1;

      // If we're actively receiving messages, consider that the user wants to see more recent content
      // Increase effective loaded pages if we have more messages than current page limit
      const currentLimit = currentState.loadedPages * MESSAGES_PER_PAGE;
      const newLoadedPages =
        newTotalMessages > currentLimit
          ? Math.ceil(newTotalMessages / MESSAGES_PER_PAGE)
          : currentState.loadedPages;

      return {
        ...state,
        [key1]: {
          ...currentState,
          loadedPages: Math.max(newLoadedPages, currentState.loadedPages),
          totalMessages: newTotalMessages,
        },
      };
    });

    // Get Profile of Message author
    const mergedProfileContact = deriveCellMergedProfileContactInviteStore(
      mergedProfileContactInviteStore,
      key1,
      encodeHashToBase64(client.client.myPubKey),
    );
    const fromProfile = get(mergedProfileContact).data[encodeHashToBase64(signal.from)];

    // Trigger a system notification
    _triggerMessageNotification(messageExtended, fromProfile);
  }

  /**
   * Load messages, starting at the current bucket and working backwards,
   * until at least a targetCount have been fetched.
   */
  async function loadMessagesInCurrentBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    targetCount = TARGET_MESSAGES_COUNT,
    bucketChunkSize: number = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    let bucket = conversationStore.getBucket(key1, new Date().getTime());

    return _loadMessagesFromBucketTargetCount(
      local,
      key1,
      bucket,
      targetCount,
      bucketChunkSize,
      maxBucketsToFetch,
    );
  }

  /**
   * Load messages, starting at the oldest stored message's bucket and working backwards,
   * until at least a targetCount have been fetched.
   */
  async function loadMessagesInPreviousBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    targetCount = TARGET_MESSAGES_COUNT,
    bucketChunkSize: number = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    const currentState = get(paginationState)[key1];
    if (!currentState?.oldestLoadedTimestamp) {
      return 0;
    }

    // Find the bucket for the oldest loaded message
    const oldestBucket = conversationStore.getBucket(key1, currentState.oldestLoadedTimestamp);

    return _loadMessagesFromBucketTargetCount(
      local,
      key1,
      oldestBucket - 1,
      targetCount,
      bucketChunkSize,
      maxBucketsToFetch,
    );
  }

  /**
   * Main function for fetching and loading messages from network
   */
  async function _loadMessagesFromBucketTargetCount(
    local: boolean,
    key1: CellIdB64,
    bucket: number,
    targetCount: number = TARGET_MESSAGES_COUNT,
    bucketChunkSize: number = 3,
    maxBucketsToFetch?: number,
  ): Promise<number> {
    // Fetch the list of buckets that contain the target count
    const bucketsToFetch = await _fetchBucketsTargetCount(
      key1,
      bucket,
      local,
      targetCount,
      bucketChunkSize,
      maxBucketsToFetch,
    );
    const actionHashB64s = flatten(bucketsToFetch.map(({ actionHashB64s }) => actionHashB64s));

    // Filter only messages we are not storing already (check IndexedDB)
    const missingActionHashB64s = await _filterMissingMessagesFromDB(key1, actionHashB64s);

    // Fetch and save missing message data
    const count = await _loadMessages(key1, missingActionHashB64s);

    return count;
  }

  /**
   * Fetch bucket's ActionHashes, starting at the given bucket and working backwards,
   * until at least a targetCount of ActionHashes have been received.
   */
  async function _fetchBucketsTargetCount(
    key1: CellIdB64,
    bucket: number,
    local: boolean,
    targetCount: number = TARGET_MESSAGES_COUNT,
    bucketChunkSize: number = 3,
    maxBucketsToFetch?: number,
  ): Promise<{ bucket: number; actionHashB64s: ActionHashB64[] }[]> {
    const cellId = decodeCellIdFromBase64(key1);

    let bucketsToFetch: { bucket: number; actionHashB64s: ActionHashB64[] }[] = [];
    while (
      sum(bucketsToFetch.map(({ actionHashB64s }) => actionHashB64s.length)) <= targetCount &&
      bucket >= 0 &&
      (maxBucketsToFetch === undefined || bucketsToFetch.length <= maxBucketsToFetch)
    ) {
      const bucketsChunk = range(bucket, bucket - bucketChunkSize).filter((b) => b >= 0);
      bucketsToFetch = [
        ...bucketsToFetch,
        ...(await Promise.all(
          bucketsChunk.map(async (b) => ({
            bucket: b,
            actionHashB64s: (
              await client.getMessageHashes(
                cellId,
                {
                  bucket: b,
                  count: 0,
                },
                local,
              )
            ).map((a) => encodeHashToBase64(a)),
          })),
        )),
      ];
      bucket -= 1;
    }

    while (
      sum(bucketsToFetch.slice(0, -1).map(({ actionHashB64s }) => actionHashB64s.length)) >
      targetCount
    ) {
      bucketsToFetch.pop();
    }

    return bucketsToFetch;
  }

  /**
   * Determine which messages we are currently missing from IndexedDB
   */
  async function _filterMissingMessagesFromDB(
    key1: CellIdB64,
    actionHashB64s: ActionHashB64[],
  ): Promise<ActionHashB64[]> {
    const missingMessages: ActionHashB64[] = [];

    for (const actionHashB64 of actionHashB64s) {
      const exists = await messageDB.hasMessage(actionHashB64);
      if (!exists) {
        missingMessages.push(actionHashB64);
      }
    }

    return missingMessages;
  }

  async function _loadMessages(key1: CellIdB64, actionHashB64s: ActionHashB64[]): Promise<number> {
    if (actionHashB64s.length === 0) return 0;

    const cellId = decodeCellIdFromBase64(key1);

    // Fetch missing messages from network
    const messageRecords: Array<MessageRecord> = await client.getMessageEntries(
      cellId,
      actionHashB64s.map((a) => decodeHashFromBase64(a)),
      false,
    );

    // Transform Messages into MessageExtendeds
    const messageEntries = await Promise.allSettled(
      messageRecords.map(
        async (m) =>
          [encodeHashToBase64(m.original_action), await _makeMessageExtended(cellId, m)] as [
            ActionHashB64,
            MessageExtended,
          ],
      ),
    );

    const validMessages = messageEntries
      .filter((p) => p.status === "fulfilled")
      .map((p) => p.value);

    if (validMessages.length === 0) return 0;

    console.group(" SAVING TO INDEXEDDB");
    console.log(`Cell ID: ${key1.substring(0, 15)}...`);
    console.log(`Attempting to save ${validMessages.length} messages to local database.`);
    console.log("Data payload:", validMessages);
    console.groupEnd();

    // Store in IndexedDB first
    await messageDB.storeMessages(key1, validMessages);

    // Load appropriate messages into memory store based on current pagination
    await _loadMessagesFromDB(key1, get(paginationState)[key1]?.loadedPages || 1);

    // Apply memory management to keep only recent messages
    _applyMemoryManagement(key1);

    return validMessages.length;
  }

  /**
   * Apply memory management when new messages arrive
   * Keeps only the most recent messages and removes old ones based on loaded pages
   */
  function _applyMemoryManagement(cellIdB64: CellIdB64): void {
    const currentMessages = get(messages).data[cellIdB64] || {};
    const messagesList = Object.entries(currentMessages);

    // Get current pagination state to determine memory limit
    const currentPagination = get(paginationState)[cellIdB64];
    const loadedPages = currentPagination?.loadedPages || 1;

    // Calculate memory limit: ensure users can see at least 3 pages worth of recent messages
    // even if they haven't explicitly loaded older pages via infinite scroll
    const effectivePages = Math.max(loadedPages, 3);
    const maxMessagesInMemory = effectivePages * MESSAGES_PER_PAGE;

    if (messagesList.length <= maxMessagesInMemory) {
      console.log("No trimming needed - within memory limit");
      return; // No need to trim
    }

    // Sort messages by timestamp (oldest to newest) and keep only the most recent ones
    const sortedMessages = messagesList.sort(([, a], [, b]) => a.timestamp - b.timestamp);
    const messagesToKeep = sortedMessages.slice(-maxMessagesInMemory);
    const trimmedMessages = Object.fromEntries(messagesToKeep);

    console.log(
      `Trimming messages: keeping ${messagesToKeep.length} most recent out of ${sortedMessages.length} total`,
    );

    // Update the store with trimmed messages
    messages.update((m) => ({
      ...m,
      [cellIdB64]: trimmedMessages,
    }));

    // Update pagination state
    paginationState.update((state) => ({
      ...state,
      [cellIdB64]: {
        ...state[cellIdB64],
        totalMessages: messagesToKeep.length,
        oldestLoadedTimestamp: messagesToKeep[0]?.[1].timestamp,
      },
    }));

    const removedCount = messagesList.length - messagesToKeep.length;
    console.log(
      `Memory management: Removed ${removedCount} old messages, keeping ${messagesToKeep.length} recent messages (${loadedPages} loaded pages, ${effectivePages} effective pages)`,
    );
  }

  async function _triggerMessageNotification(
    messageExtended: MessageExtended,
    fromProfile?: ProfileExtended,
  ) {
    const content =
      messageExtended.message.content.length > 125
        ? messageExtended.message.content.slice(0, 50) + "..."
        : messageExtended.message.content;
    const header = fromProfile ? `Message From ${fromProfile.profile.nickname}` : `New Message`;

    await enqueueNotification(header, content);
  }

  async function _makeMessageExtended(
    cellId: CellId,
    messageRecord: MessageRecord,
  ): Promise<MessageExtended> {
    if (messageRecord.message === undefined)
      throw new Error("MessageRecord does not include message entry");

    const baseMessage: MessageExtended = {
      message: messageRecord.message,
      authorAgentPubKeyB64: encodeHashToBase64(messageRecord.signed_action.hashed.content.author),
      timestamp: messageRecord.signed_action.hashed.content.timestamp,
    };

    // Fetch reply-to message if this is a reply
    if (messageRecord.message.reply_to) {
      try {
        const replyToHash = messageRecord.message.reply_to;
        const replyToRecord = await client.getMessageEntries(cellId, [replyToHash], false);
        if (replyToRecord && replyToRecord.length > 0 && replyToRecord[0].message) {
          baseMessage.replyToMessage = {
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

    // Fetch reply count for thread indicator
    // Always fetch for all messages so we can show thread indicators when needed
    try {
      const actionHash = messageRecord.signed_action.hashed.hash;
      const count = await client.getReplyCount(cellId, actionHash);
      if (count > 0) {
        baseMessage.replyCount = count;
      }
    } catch (error) {
      console.error("[ConversationMessageStore] Error fetching reply count:", error);
    }

    if (messageRecord.message.images.length > 0) {
      messageRecord.message.images.forEach((messageFile) =>
        fileStore.download(
          encodeCellIdToBase64(cellId),
          encodeHashToBase64(messageFile.storage_entry_hash),
        ),
      );
    }

    return baseMessage;
  }

  async function getReplyCount(key1: CellIdB64, messageHash: ActionHashB64): Promise<number> {
    const cellId = decodeCellIdFromBase64(key1);
    return await client.getReplyCount(cellId, decodeHashFromBase64(messageHash));
  }

  async function debugGetAllMessages(key1: CellIdB64): Promise<MessageRecord[]> {
    let bucket = conversationStore.getBucket(key1, new Date().getTime());
    const cellId = decodeCellIdFromBase64(key1);

    // Get the hashes for buckets by calling them one bucket at a time.
    // let hashes: HoloHash[] = [];
    // while (bucket >= 0) {
    //   console.log("getting BUCKET", bucket);
    //   const h = await client.getMessageHashes(
    //     cellId,
    //     {
    //       bucket,
    //       count: 0,
    //     },
    //     true,
    //   );
    //   hashes = [...hashes, ...h];
    //   bucket -= 1;
    // }
    // const records = await client.getMessageEntries(cellId, hashes);

    const records = await client.getMessagesForBuckets(
      cellId,
      Array.from({ length: bucket + 1 }, (_, index) => index),
    );

    console.log("Records", records);
    return records;
  }

  return {
    ...messages,
    initialize,
    loadMessagesInCurrentBucketTargetCount,
    loadMessagesInPreviousBucketTargetCount,
    loadMoreMessages,
    sendMessage,
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
  handleMessageSignalReceived: (signal: MessageSignal) => Promise<void>;
  getReplyCount: (messageHash: ActionHashB64) => Promise<number>;
  debugGetAllMessages: () => Promise<Record[]>;
}

export function deriveCellConversationMessageStore(
  conversationMessageStore: ConversationMessageStore,
  key: CellIdB64,
) {
  const data = deriveGenericKeyValueStore(conversationMessageStore, key, [([, m]) => -m.timestamp]);

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
    sendMessage: (content: string, files: LocalFile[], replyTo?: ActionHashB64) =>
      conversationMessageStore.sendMessage(key, content, files, replyTo),
    handleMessageSignalReceived: (signal: MessageSignal) =>
      conversationMessageStore.handleMessageSignalReceived(key, signal),
    deleteMessage: (key1: CellIdB64, actionHashB64: ActionHashB64) =>
      conversationMessageStore.deleteMessage(key1, actionHashB64),
    getReplyCount: (messageHash: ActionHashB64) =>
      conversationMessageStore.getReplyCount(key, messageHash),
    debugGetAllMessages: () => conversationMessageStore.debugGetAllMessages(key),
  };
}
