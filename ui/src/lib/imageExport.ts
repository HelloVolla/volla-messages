import { invoke } from "@tauri-apps/api/core";
import { decodeHashFromBase64, type AgentPubKeyB64, type CellId } from "@holochain/client";
import { FileStorageClient } from "@holochain-open-dev/file-storage";
import type { ConversationExtended } from "$lib/types";
import type { RelayClient } from "$store/RelayClient";
import { withArchivedCellEnabled } from "$lib/migrationExport";
import type { ExportedMessage } from "$lib/historyExport";

/**
 * Export the images referenced by the exported message history.
 *
 * Message history only carries image references; the bytes live in each
 * conversation's file_storage zome, which a 2.x release cannot read. Each image
 * is written once to `export/images/<storage entry hash>`, so later runs only
 * add new ones. `export/images/index.json` says what each file is, and lists
 * images left out — over the size ceiling, or not on this device — so 2.x can
 * tell a missing image from a broken one.
 *
 * Read from this device only. A real account's 13 MB of images read in under
 * a second.
 */

/** Bump when the index shape changes in a way an importer has to notice. */
export const IMAGE_INDEX_VERSION = 1;

/**
 * Safety ceiling for all exported images together. Everything is exported
 * newest first until it is reached; it exists to protect phones from an
 * extreme account, not to trim normal ones.
 */
export const IMAGE_EXPORT_CEILING_BYTES = 500 * 1024 * 1024;

const TAG = "[image-export]";

/** One conversation's history as it stands on disk after a history run. */
export interface ExportedConversation {
  conversation: ConversationExtended;
  cellIdB64: string;
  seed: string;
  archived: boolean;
  messages: ExportedMessage[];
}

interface ImageRef {
  hash: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  /** Send time of the newest message using this image, in microseconds. */
  newest: number;
  /** Conversations (network seeds) whose messages use it. */
  seeds: Set<string>;
  /** Where to read it from: the conversation of the newest message using it. */
  source: ExportedConversation;
}

interface ImageIndex {
  version: number;
  ceilingBytes: number;
  images: {
    [hash: string]: {
      name: string;
      type: string;
      size: number;
      lastModified: number;
      newest: number;
      seeds: string[];
    };
  };
  /** Left out because the ceiling was reached; newest images are kept first. */
  overCeiling: string[];
  /** Referenced, but not on this device (never received, or unreadable). */
  missing: string[];
}

function collectImages(conversations: ExportedConversation[]): ImageRef[] {
  const refs = new Map<string, ImageRef>();
  for (const source of conversations) {
    for (const message of source.messages) {
      for (const image of message.images) {
        const ref = refs.get(image.hash);
        if (!ref) {
          refs.set(image.hash, {
            ...image,
            newest: message.timestamp,
            seeds: new Set([source.seed]),
            source,
          });
          continue;
        }
        ref.seeds.add(source.seed);
        if (message.timestamp > ref.newest) {
          ref.newest = message.timestamp;
          ref.source = source;
        }
      }
    }
  }
  return [...refs.values()].sort((a, b) => b.newest - a.newest);
}

/** Read an image from this device and write it to the export. */
async function exportImage(
  relayClient: RelayClient,
  cellId: CellId,
  hash: string,
  myPubKeyB64: AgentPubKeyB64,
): Promise<void> {
  const files = new FileStorageClient(relayClient.client, "UNUSED ROLE NAME", "file_storage", cellId);
  const file = await files.downloadFile(decodeHashFromBase64(hash), true);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await invoke("write_export_image", bytes, {
    headers: { "x-image-hash": hash, "x-agent": myPubKeyB64 },
  });
}

/** Archived conversations already enabled for images this launch. */
const archivedImagesThisLaunch = new Set<string>();

/** Last index written, to skip rewriting an unchanged one. */
let lastIndex: string | undefined;

/** Export images for the given history. Never throws. */
export async function exportImages(
  relayClient: RelayClient,
  conversations: ExportedConversation[],
  myPubKeyB64: AgentPubKeyB64,
): Promise<void> {
  const started = performance.now();
  try {
    const refs = collectImages(conversations);
    const existing = new Set(await invoke<string[]>("list_export_images", { agent: myPubKeyB64 }));

    // Newest first until the ceiling, counting images already exported too so
    // the selection is the same on every run.
    const selected: ImageRef[] = [];
    const overCeiling: string[] = [];
    let total = 0;
    for (const ref of refs) {
      if (total + ref.size > IMAGE_EXPORT_CEILING_BYTES) {
        overCeiling.push(ref.hash);
        continue;
      }
      total += ref.size;
      selected.push(ref);
    }

    // Group what is still to be written by the conversation to read it from.
    const pending = new Map<ExportedConversation, ImageRef[]>();
    for (const ref of selected.filter((r) => !existing.has(r.hash))) {
      pending.set(ref.source, [...(pending.get(ref.source) ?? []), ref]);
    }

    const missing = new Set<string>();
    let written = 0;
    for (const [source, images] of pending) {
      const cellId = source.conversation.cellInfo.cell_id;
      const writeAll = async () => {
        for (const image of images) {
          try {
            await exportImage(relayClient, cellId, image.hash, myPubKeyB64);
            existing.add(image.hash);
            written++;
          } catch {
            missing.add(image.hash);
          }
        }
      };

      if (!source.archived) {
        await writeAll();
      } else if (!archivedImagesThisLaunch.has(source.cellIdB64)) {
        // Enabling an archived conversation is visible; once per launch.
        archivedImagesThisLaunch.add(source.cellIdB64);
        await withArchivedCellEnabled(relayClient, cellId, source.cellIdB64, myPubKeyB64, writeAll);
      } else {
        images.forEach((image) => missing.add(image.hash));
      }
    }

    const index: ImageIndex = {
      version: IMAGE_INDEX_VERSION,
      ceilingBytes: IMAGE_EXPORT_CEILING_BYTES,
      images: Object.fromEntries(
        selected
          .filter((r) => existing.has(r.hash))
          .map((r) => [
            r.hash,
            {
              name: r.name,
              type: r.type,
              size: r.size,
              lastModified: r.lastModified,
              newest: r.newest,
              seeds: [...r.seeds],
            },
          ]),
      ),
      overCeiling,
      missing: [...missing],
    };
    const serialized = JSON.stringify(index);
    if (serialized !== lastIndex) {
      await invoke("write_image_index", { contents: serialized, agent: myPubKeyB64 });
      lastIndex = serialized;
    }

    // Warn level: the release log drops webview info-level output.
    console.warn(
      `${TAG} done: ${refs.length} referenced, ${Object.keys(index.images).length} exported ` +
        `(${written} new, ${(total / 1024 / 1024).toFixed(1)} MB), ${overCeiling.length} over the ` +
        `ceiling, ${missing.size} missing, in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : JSON.stringify(e);
    console.error(`${TAG} failed: ${message}`);
  }
}
