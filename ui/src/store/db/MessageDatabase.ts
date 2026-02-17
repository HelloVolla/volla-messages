import Dexie, { type Table } from "dexie";
import type { CellIdB64, MessageExtended } from "$lib/types";
import type { ActionHash } from "@holochain/client";
import { encodeHashToBase64 } from "@holochain/client";

// Type alias for encoded action hashes
type ActionHashB64 = string;

// Database schema for persistent message storage
export interface DBMessage {
  id?: number; // Auto-increment primary key
  actionHashB64: ActionHashB64; // Unique message identifier
  cellIdB64: CellIdB64; // Conversation identifier
  message: MessageExtended; // The actual message data
  timestamp: number; // Message timestamp for sorting
  bucket: number; // Message bucket for pagination
  createdAt: number; // When this record was added to DB
  deleted?: boolean; // Deletion tombstone to prevent reappearance
  deletedAt?: number; // When the message was deleted
}

export class MessageDatabase extends Dexie {
  messages!: Table<DBMessage>;

  constructor() {
    super("VollaMessagesDB");

    this.version(1).stores({
      messages:
        "++id, actionHashB64, cellIdB64, timestamp, bucket, [cellIdB64+timestamp], [cellIdB64+bucket]",
    });
  }

  /**
   * Store a message in the database with error handling
   * Added try-catch and quota handling
   */
  async storeMessage(
    cellIdB64: CellIdB64,
    actionHashB64: ActionHashB64,
    messageExtended: MessageExtended,
  ): Promise<void> {
    try {
      await this.messages.put({
        actionHashB64,
        cellIdB64,
        message: messageExtended,
        timestamp: messageExtended.timestamp,
        bucket: messageExtended.message.bucket,
        createdAt: Date.now(),
        deleted: false, // Explicitly mark as not deleted
      });
    } catch (error: any) {
      if (error.name === 'QuotaExceededError') {
        console.error('IndexedDB quota exceeded, attempting cleanup...');
        await this.evictOldMessages(cellIdB64);
        // Retry once after cleanup
        await this.messages.put({
          actionHashB64,
          cellIdB64,
          message: messageExtended,
          timestamp: messageExtended.timestamp,
          bucket: messageExtended.message.bucket,
          createdAt: Date.now(),
          deleted: false,
        });
      } else {
        console.error('Failed to store message in IndexedDB:', error);
        throw error;
      }
    }
  }

  /**
   * Store multiple messages in the database with error handling
   * Added try-catch and quota handling
   */
  async storeMessages(
    cellIdB64: CellIdB64,
    messages: Array<[ActionHashB64, MessageExtended]>,
  ): Promise<void> {
    try {
      const dbMessages = messages.map(([actionHashB64, messageExtended]) => ({
        actionHashB64,
        cellIdB64,
        message: messageExtended,
        timestamp: messageExtended.timestamp,
        bucket: messageExtended.message.bucket,
        createdAt: Date.now(),
        deleted: false, // Explicitly mark as not deleted
      }));

      await this.messages.bulkPut(dbMessages);
    } catch (error: any) {
      if (error.name === 'QuotaExceededError') {
        console.error('IndexedDB quota exceeded during bulk insert, attempting cleanup...');
        await this.evictOldMessages(cellIdB64);
        // Retry once after cleanup
        const dbMessages = messages.map(([actionHashB64, messageExtended]) => ({
          actionHashB64,
          cellIdB64,
          message: messageExtended,
          timestamp: messageExtended.timestamp,
          bucket: messageExtended.message.bucket,
          createdAt: Date.now(),
          deleted: false,
        }));
        await this.messages.bulkPut(dbMessages);
      } else {
        console.error('Failed to bulk store messages in IndexedDB:', error);
        throw error;
      }
    }
  }

  /**
   * Get messages for a conversation with pagination
   * Filter out deleted messages (tombstones)
   */
  async getMessages(
    cellIdB64: CellIdB64,
    limit: number = 50,
    offset: number = 0,
  ): Promise<Array<[ActionHashB64, MessageExtended]>> {
    const messages = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, Dexie.maxKey])
      .reverse() // Latest messages first
      .filter(msg => !msg.deleted) // Filter out deleted messages
      .offset(offset)
      .limit(limit)
      .toArray();

    return messages.map((dbMessage) => [dbMessage.actionHashB64, dbMessage.message]);
  }

  /**
   * Get oldest messages for loading previous pages
   * Filter out deleted messages (tombstones)
   */
  async getOlderMessages(
    cellIdB64: CellIdB64,
    olderThanTimestamp: number,
    limit: number = 50,
  ): Promise<Array<[ActionHashB64, MessageExtended]>> {
    const messages = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, olderThanTimestamp], false, false)
      .reverse()
      .filter(msg => !msg.deleted) // Filter out deleted messages
      .limit(limit)
      .toArray();

    return messages.map((dbMessage) => [dbMessage.actionHashB64, dbMessage.message]);
  }

  /**
   * Check if a message exists in the database
   */
  async hasMessage(actionHashB64: ActionHashB64): Promise<boolean> {
    const count = await this.messages.where("actionHashB64").equals(actionHashB64).count();
    return count > 0;
  }

  /**
   * Get the total count of messages for a conversation
   */
  async getMessageCount(cellIdB64: CellIdB64): Promise<number> {
    return await this.messages.where("cellIdB64").equals(cellIdB64).count();
  }

  /**
   * Delete a message from the database using tombstone pattern
   * Use tombstone instead of hard delete to prevent reappearance
   */
  async deleteMessage(actionHashB64: ActionHashB64): Promise<void> {
    try {
      const message = await this.messages.where("actionHashB64").equals(actionHashB64).first();
      
      if (message) {
        // Mark as deleted (tombstone) instead of removing
        await this.messages.put({
          ...message,
          deleted: true,
          deletedAt: Date.now(),
        });
        console.log(`Message ${actionHashB64} marked as deleted (tombstone)`);
      }
    } catch (error) {
      console.error('Failed to delete message:', error);
      throw error;
    }
  }

  /**
   * Get the latest message for a conversation
   * Filter out deleted messages
   */
  async getLatestMessage(
    cellIdB64: CellIdB64,
  ): Promise<[ActionHashB64, MessageExtended] | undefined> {
    const message = await this.messages
      .where("[cellIdB64+timestamp]")
      .between([cellIdB64, Dexie.minKey], [cellIdB64, Dexie.maxKey])
      .reverse()
      .filter(msg => !msg.deleted) // Filter out deleted messages
      .first();

    return message ? [message.actionHashB64, message.message] : undefined;
  }

  /**
   * Clear all messages for a conversation
   */
  async clearConversationMessages(cellIdB64: CellIdB64): Promise<void> {
    await this.messages.where("cellIdB64").equals(cellIdB64).delete();
  }

  /**
   * Evict old messages when quota is exceeded
   * Keeps most recent 1000 messages, removes older ones
   */
  async evictOldMessages(cellIdB64: CellIdB64, keepCount: number = 1000): Promise<void> {
    try {
      console.log(`Evicting old messages for ${cellIdB64}, keeping ${keepCount} most recent`);
      
      // Get all messages for this conversation, sorted by timestamp (oldest first)
      const allMessages = await this.messages
        .where("cellIdB64")
        .equals(cellIdB64)
        .sortBy("timestamp");
      
      if (allMessages.length > keepCount) {
        // Calculate how many to delete
        const deleteCount = allMessages.length - keepCount;
        const messagesToDelete = allMessages.slice(0, deleteCount);
        
        // Delete the oldest messages
        const idsToDelete = messagesToDelete.map(msg => msg.id!).filter(id => id !== undefined);
        await this.messages.bulkDelete(idsToDelete);
        
        console.log(`Evicted ${deleteCount} old messages`);
      } else {
        console.log(`No eviction needed, only ${allMessages.length} messages`);
      }
    } catch (error) {
      console.error('Failed to evict old messages:', error);
      // Don't throw - eviction failure shouldn't prevent message storage
    }
  }

  /**
   * Clean up old tombstones (deleted messages older than 30 days)
   * This should be called periodically to free up space
   */
  async cleanupOldTombstones(daysToKeep: number = 30): Promise<void> {
    try {
      const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
      
      const oldTombstones = await this.messages
        .filter(msg => msg.deleted === true && (msg.deletedAt || 0) < cutoffTime)
        .toArray();
      
      if (oldTombstones.length > 0) {
        const idsToDelete = oldTombstones.map(msg => msg.id!).filter(id => id !== undefined);
        await this.messages.bulkDelete(idsToDelete);
        console.log(`Cleaned up ${oldTombstones.length} old tombstones`);
      }
    } catch (error) {
      console.error('Failed to cleanup old tombstones:', error);
    }
  }
}

// Singleton instance
export const messageDB = new MessageDatabase();
