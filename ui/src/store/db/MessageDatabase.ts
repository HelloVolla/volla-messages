import Dexie, { type Table } from "dexie";
import type { CellIdB64, MessageExtended } from "$lib/types";

// Type alias for encoded action hashes
type ActionHashB64 = string;

// Database schema for persistent message storage
export interface DBMessage {
  actionHashB64: ActionHashB64;
  cellIdB64: CellIdB64;
  message: MessageExtended;
  timestamp: number;
  bucket: number;
  createdAt: number;
  deleted?: boolean;
  deletedAt?: number;
}

export class MessageDatabase extends Dexie {
  messages!: Table<DBMessage, ActionHashB64>;

  constructor() {
    super("VollaMessagesDB");

    this.version(1).stores({
      messages:
        "++id, actionHashB64, cellIdB64, timestamp, bucket, [cellIdB64+timestamp], [cellIdB64+bucket]",
    });
    this.version(2).stores({ messages: null });
    this.version(3).stores({
      messages:
        "actionHashB64, cellIdB64, timestamp, bucket, [cellIdB64+timestamp], [cellIdB64+bucket]",
    });
    this.version(4)
      .stores({
        messages:
          "actionHashB64, cellIdB64, timestamp, bucket, [cellIdB64+timestamp], [cellIdB64+bucket]",
      })
      .upgrade((tx) =>
        tx
          .table<DBMessage>("messages")
          .toCollection()
          .modify((row) => {
            if (!Array.isArray(row.message.deliveredTo)) {
              row.message.deliveredTo = [];
            }
          }),
      );
  }

  private async buildRows(
    cellIdB64: CellIdB64,
    entries: Array<[ActionHashB64, MessageExtended]>,
  ): Promise<DBMessage[]> {
    const stored = await this.messages.bulkGet(entries.map(([hash]) => hash));

    return entries.map(([actionHashB64, messageExtended], i) => ({
      actionHashB64,
      cellIdB64,
      message: {
        ...messageExtended,
        deliveredTo: Array.from(
          new Set([
            ...(stored[i]?.message.deliveredTo ?? []),
            ...messageExtended.deliveredTo,
          ]),
        ),
      },
      timestamp: messageExtended.timestamp,
      bucket: messageExtended.message.bucket,
      createdAt: Date.now(),
      deleted: false,
    }));
  }

  async storeMessage(
    cellIdB64: CellIdB64,
    actionHashB64: ActionHashB64,
    messageExtended: MessageExtended,
  ): Promise<void> {
    const [row] = await this.buildRows(cellIdB64, [[actionHashB64, messageExtended]]);

    try {
      await this.messages.put(row);
    } catch (error: any) {
      if (error.name === "QuotaExceededError") {
        console.error("IndexedDB quota exceeded, attempting cleanup...");
        await this.evictOldMessages(cellIdB64);

        await this.messages.put(row);
      } else {
        console.error("Failed to store message in IndexedDB:", error);
        throw error;
      }
    }
  }

  async storeMessages(
    cellIdB64: CellIdB64,
    entries: Array<[ActionHashB64, MessageExtended]>,
  ): Promise<void> {
    try {
      const dbRows = await this.buildRows(cellIdB64, entries);

      console.group(`[MessageDB][storeMessages] ${cellIdB64.slice(0, 10)}`);
      console.log("incoming count:", entries.length);
      console.log(
        "sample:",
        entries.slice(0, 5).map(([hash, msg]) => ({
          hash,
          timestamp: msg.timestamp,
          bucket: msg.message.bucket,
          type: msg.message.message_type,
        })),
      );
      console.groupEnd();

      await this.messages.bulkPut(dbRows);

      const storedCount = await this.messages.where("cellIdB64").equals(cellIdB64).count();
      console.log("post-store total rows for cell:", storedCount);
    } catch (error: any) {
      if (error.name === "QuotaExceededError") {
        console.error("IndexedDB quota exceeded during bulk insert, attempting cleanup...");
        await this.evictOldMessages(cellIdB64);

        await this.messages.bulkPut(await this.buildRows(cellIdB64, entries));
      } else {
        console.error("Failed to bulk store messages in IndexedDB:", error);
        throw error;
      }
    }
  }

  async getMessages(
    cellIdB64: CellIdB64,
    limit: number = 50,
    offset: number = 0,
  ): Promise<Array<[ActionHashB64, MessageExtended]>> {
    const rows = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, Dexie.maxKey])
      .reverse()
      .filter((row) => !row.deleted)
      .offset(offset)
      .limit(limit)
      .toArray();

    console.group(`[MessageDB][getMessages] ${cellIdB64.slice(0, 10)}`);
    console.log("limit:", limit, "offset:", offset);
    console.log("result count:", rows.length);
    console.log(
      "sample:",
      rows.slice(0, 5).map((row) => ({
        hash: row.actionHashB64,
        timestamp: row.timestamp,
        bucket: row.bucket,
      })),
    );
    console.groupEnd();

    return rows.map((row) => [row.actionHashB64, row.message]);
  }

  async getOlderMessages(
    cellIdB64: CellIdB64,
    olderThanTimestamp: number,
    limit: number = 50,
  ): Promise<Array<[ActionHashB64, MessageExtended]>> {
    console.group(`[MessageDB][getOlderMessages] ${cellIdB64.slice(0, 10)}`);
    console.log("olderThanTimestamp:", olderThanTimestamp);
    console.log("limit:", limit);

    const rows = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, olderThanTimestamp], false, false)
      .reverse()
      .filter((row) => !row.deleted)
      .limit(limit)
      .toArray();

    console.log("result count:", rows.length);
    console.log(
      "result sample:",
      rows.slice(0, 5).map((row) => ({
        hash: row.actionHashB64,
        timestamp: row.timestamp,
        bucket: row.bucket,
        deleted: row.deleted,
      })),
    );

    if (rows.length === 0) {
      const allRowsForCell = await this.messages
        .where("[cellIdB64+timestamp]")
        .between([cellIdB64, Dexie.minKey], [cellIdB64, Dexie.maxKey])
        .filter((row) => !row.deleted)
        .toArray();

      console.log(
        "db range:",
        allRowsForCell.length > 0
          ? {
              count: allRowsForCell.length,
              minTimestamp: Math.min(...allRowsForCell.map((row) => row.timestamp)),
              maxTimestamp: Math.max(...allRowsForCell.map((row) => row.timestamp)),
            }
          : "no rows for cell",
      );
    }

    console.groupEnd();

    return rows.map((row) => [row.actionHashB64, row.message]);
  }

  async hasMessage(actionHashB64: ActionHashB64): Promise<boolean> {
    const count = await this.messages.where("actionHashB64").equals(actionHashB64).count();
    return count > 0;
  }

  async getMessageCount(cellIdB64: CellIdB64): Promise<number> {
    return await this.messages.where("cellIdB64").equals(cellIdB64).count();
  }

  async deleteMessage(actionHashB64: ActionHashB64): Promise<void> {
    try {
      const row = await this.messages.where("actionHashB64").equals(actionHashB64).first();

      if (row) {
        await this.messages.put({
          ...row,
          deleted: true,
          deletedAt: Date.now(),
        });
        console.log(`Message ${actionHashB64} marked as deleted (tombstone)`);
      }
    } catch (error) {
      console.error("Failed to delete message:", error);
      throw error;
    }
  }

  async getLatestMessage(
    cellIdB64: CellIdB64,
  ): Promise<[ActionHashB64, MessageExtended] | undefined> {
    const row = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, Dexie.maxKey])
      .reverse()
      .filter((r) => !r.deleted)
      .first();

    return row ? [row.actionHashB64, row.message] : undefined;
  }

  async clearConversationMessages(cellIdB64: CellIdB64): Promise<void> {
    await this.messages.where("cellIdB64").equals(cellIdB64).delete();
  }

  async evictOldMessages(cellIdB64: CellIdB64, keepCount: number = 1000): Promise<void> {
    try {
      console.log(`Evicting old messages for ${cellIdB64}, keeping ${keepCount} most recent`);

      const allRows = await this.messages.where("cellIdB64").equals(cellIdB64).sortBy("timestamp");

      if (allRows.length > keepCount) {
        const deleteCount = allRows.length - keepCount;
        const rowsToDelete = allRows.slice(0, deleteCount);
        const idsToDelete = rowsToDelete.map((row) => row.actionHashB64);

        await this.messages.bulkDelete(idsToDelete);
        console.log(`Evicted ${deleteCount} old messages`);
      } else {
        console.log(`No eviction needed, only ${allRows.length} messages`);
      }
    } catch (error) {
      console.error("Failed to evict old messages:", error);
    }
  }

  async cleanupOldTombstones(daysToKeep: number = 30): Promise<void> {
    try {
      const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

      const oldTombstones = await this.messages
        .filter((row) => row.deleted === true && (row.deletedAt || 0) < cutoffTime)
        .toArray();

      if (oldTombstones.length > 0) {
        const idsToDelete = oldTombstones.map((row) => row.actionHashB64);
        await this.messages.bulkDelete(idsToDelete);
        console.log(`Cleaned up ${oldTombstones.length} old tombstones`);
      }
    } catch (error) {
      console.error("Failed to cleanup old tombstones:", error);
    }
  }

  async getAllCellIds(): Promise<CellIdB64[]> {
    const allRows = await this.messages.toArray();
    const uniqueCellIds = new Set(allRows.map((row) => row.cellIdB64));
    return Array.from(uniqueCellIds);
  }

  async getMessageCountPerCell(): Promise<Record<CellIdB64, number>> {
    const allRows = await this.messages.toArray();
    const counts: Record<CellIdB64, number> = {};

    allRows.forEach((row) => {
      if (!row.deleted) {
        counts[row.cellIdB64] = (counts[row.cellIdB64] || 0) + 1;
      }
    });

    return counts;
  }

  async debugDumpAll(): Promise<void> {
    console.group("IndexedDB Debug Dump");

    const allRows = await this.messages.toArray();
    console.log(`Total messages in DB: ${allRows.length}`);

    const cellIds = await this.getAllCellIds();
    console.log(`Unique Cell IDs: ${cellIds.length}`);
    cellIds.forEach((cellId, index) => {
      console.log(`  ${index + 1}. ${cellId}`);
    });

    const counts = await this.getMessageCountPerCell();
    console.log("\nMessage counts per Cell ID:");
    Object.entries(counts).forEach(([cellId, count]) => {
      console.log(`  ${cellId.substring(0, 20)}...: ${count} messages`);
    });

    console.groupEnd();
  }

  private extractDnaHash(cellIdB64: CellIdB64): string {
    return cellIdB64.substring(0, 52);
  }

  async clearCacheOnAgentChange(currentCellIdB64: CellIdB64): Promise<boolean> {
    const storedCellIds = await this.getAllCellIds();

    if (storedCellIds.length === 0) {
      return false;
    }

    const currentDnaHash = this.extractDnaHash(currentCellIdB64);

    const mismatchedCellIds = storedCellIds.filter(
      (storedCellId) =>
        this.extractDnaHash(storedCellId) === currentDnaHash &&
        storedCellId !== currentCellIdB64,
    );

    if (mismatchedCellIds.length === 0) {
      return false;
    }

    let totalCleared = 0;
    for (const oldCellId of mismatchedCellIds) {
      const count = await this.getMessageCount(oldCellId);
      await this.clearConversationMessages(oldCellId);
      totalCleared += count;
      console.log(`  Cleared ${count} messages from ${oldCellId.substring(0, 20)}...`);
    }

    console.log(` Cache cleared: ${totalCleared} messages removed`);
    return true;
  }
}

export const messageDB = new MessageDatabase();