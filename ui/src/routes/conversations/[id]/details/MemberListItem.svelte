<script lang="ts">
  import Avatar from "$lib/Avatar.svelte";
  import type { CellIdB64 } from "$lib/types";
  import { type ConversationStore, deriveCellConversationStore } from "$store/ConversationStore";
  import { t } from "$translations";
  import type { AgentPubKeyB64 } from "@holochain/client";
  import { getContext } from "svelte";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import type { Writable } from "svelte/store";

  const conversationStore = getContext<{ getStore: () => ConversationStore }>(
    "conversationStore",
  ).getStore();
  const onlinePeers = getContext<{ getStore: () => Writable<Set<AgentPubKeyB64>> }>(
    "onlinePeers",
  ).getStore();

  export let cellIdB64: CellIdB64;
  export let agentPubKeyB64: AgentPubKeyB64;

  let conversation = deriveCellConversationStore(conversationStore, cellIdB64);

  $: isAdmin = agentPubKeyB64 === $conversation.dnaProperties.progenitor;
  $: isOnline = $onlinePeers.has(agentPubKeyB64);
</script>

<li class="mb-4 flex flex-row items-center px-2 text-xl">
  <div class="relative shrink-0">
    <Avatar {cellIdB64} {agentPubKeyB64} size={38} />
    {#if isOnline}
      <span
        class="absolute -bottom-1 -right-1 block h-4 w-4 rounded-full border-2 border-white bg-green-500 dark:border-neutral-900"
        title="Online"
      ></span>
    {/if}
  </div>

  <span class="ml-2 min-w-0 flex-1 truncate text-sm font-bold sm:ml-4">
    <AgentNickname {cellIdB64} {agentPubKeyB64} />
  </span>

  {#if isAdmin}
    <span class="text-secondary-300 ml-2 shrink-0 text-xs">{$t("common.admin")}</span>
  {/if}

  <slot></slot>
</li>
