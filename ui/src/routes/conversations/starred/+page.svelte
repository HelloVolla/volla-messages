<script lang="ts">
  import { getContext } from "svelte";
  import { goto } from "$app/navigation";
  import Header from "$lib/Header.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import { t } from "$translations";
  import Time from "svelte-time";
  import type { ConversationMessageStore } from "$store/ConversationMessageStore";
  import type { ConversationTitleStore } from "$store/ConversationTitleStore";
  import { starredMessages, toggleStar } from "$store/StarStore";
  import type { ActionHashB64 } from "@holochain/client";
  import type { CellIdB64 } from "$lib/types";

  const conversationMessageStore = getContext<{
    getStore: () => ConversationMessageStore;
  }>("conversationMessageStore").getStore();
  const conversationTitleStore = getContext<{
    getStore: () => ConversationTitleStore;
  }>("conversationTitleStore").getStore();

  // Gather starred messages that are currently loaded, newest first. Ones not
  // yet loaded into a conversation won't appear until that chat is opened.
  $: starred = Object.entries($conversationMessageStore.data)
    .flatMap(([cellIdB64, byHash]) =>
      Object.entries(byHash ?? {})
        .filter(([hashB64]) => $starredMessages[hashB64])
        .map(([hashB64, message]) => ({ cellIdB64: cellIdB64 as CellIdB64, hashB64, message })),
    )
    .sort((a, b) => b.message.timestamp - a.message.timestamp);
</script>

<Header backUrl="/conversations" title={$t("common.starred_messages")}></Header>

<div class="mx-auto flex w-full flex-1 flex-col overflow-y-auto px-4 pt-4">
  {#if starred.length === 0}
    <p class="text-secondary-300 mt-10 text-center text-sm">
      {$t("common.no_starred_messages")}
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each starred as { cellIdB64, hashB64, message } (hashB64)}
        <li
          class="bg-surface-100 dark:bg-surface-900 flex items-start gap-2 rounded-lg p-3"
        >
          <button
            class="min-w-0 flex-1 text-left"
            on:click={() => goto(`/conversations/${cellIdB64}`)}
          >
            <div class="text-primary-500 truncate text-xs font-medium">
              {$conversationTitleStore[cellIdB64] ?? ""}
            </div>
            <div class="overflow-wrap-anywhere whitespace-pre-wrap break-words text-sm">
              {message.message.content || $t("common.attachment")}
            </div>
            <div class="text-secondary-400 mt-1 text-xxs">
              <Time timestamp={message.timestamp / 1000} format="MMM D, h:mma" />
            </div>
          </button>

          <button
            class="text-primary-500 shrink-0 p-1"
            on:click={() => toggleStar(hashB64)}
            aria-label={$t("common.unstar")}
          >
            <SvgIcon icon="starFilled" size="h-[16px] w-[16px]" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
