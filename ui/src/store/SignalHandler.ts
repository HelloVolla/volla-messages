import { encodeHashToBase64, type Signal, SignalType, type AgentPubKeyB64 } from "@holochain/client";
import { RelayClient } from "$store/RelayClient";
import { type RelaySignal, type MessageSignal } from "$lib/types";
import { encodeCellIdToBase64 } from "$lib/utils";
import { type ConversationStore } from "./ConversationStore";
import type { ConversationMessageStore } from "./ConversationMessageStore";
import { page } from "$app/stores";
import { get, type Writable } from "svelte/store";

export function createSignalHandler(
  client: RelayClient,
  conversationStore: ConversationStore,
  conversationMessageStore: ConversationMessageStore,
  onlinePeers: Writable<Set<AgentPubKeyB64>>,
) {
  client.client.on("signal", _handleSignalReceived);

  async function _handleSignalReceived(signal: Signal) {
    if (signal.type !== SignalType.App) return;

    const payload = signal.value.payload as RelaySignal;
    const cellIdB64 = encodeCellIdToBase64(signal.value.cell_id);

    if (payload.type === "PeerPing" || payload.type === "PeerPong") {
      const fromAgent = encodeHashToBase64(payload.from_agent);
      onlinePeers.update((set) => new Set([...set, fromAgent]));
      return;
    }

    if (payload.type === "Message") {
      await conversationMessageStore.handleMessageSignalReceived(
        cellIdB64,
        signal.value.payload as MessageSignal,
      );
      const $page = get(page);
      if ($page.params.id !== cellIdB64 || $page.route.id !== "/conversations/[id]") {
        await conversationStore.updateUnread(cellIdB64, true);
      }
    } else if (payload.type === "MessageDeleted") {
      const originalActionHash = payload.original_action;
      const originalActionHashB64 = encodeHashToBase64(originalActionHash);
      conversationMessageStore.handleMessageDeletedSignalReceived(cellIdB64, originalActionHashB64);
    }
  }
}
