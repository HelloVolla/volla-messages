<script lang="ts">
  import type { AgentPubKeyB64 } from "@holochain/client";
  import type { CellIdB64, MessageExtended } from "$lib/types";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import { t } from "$translations";
  import { getContext } from "svelte";
  import { type ConversationStore, deriveCellConversationStore } from "$store/ConversationStore";

  export let cellIdB64: CellIdB64;
  export let message: MessageExtended;

  const conversationStore = getContext<{ getStore: () => ConversationStore }>(
    "conversationStore",
  ).getStore();
  const conversation = deriveCellConversationStore(conversationStore, cellIdB64);

  // "" (legacy/join notices) or "<kind>:<targetAgentPubKeyB64>"
  $: [kind, targetAgentPubKeyB64] = message.message.content.split(":") as [
    string,
    AgentPubKeyB64 | undefined,
  ];

  // Message content is unauthenticated: anyone can post a message claiming to be
  // a moderation notice. Cross-check the claim against current on-chain role/
  // membership state so a forged notice can't assert a false moderation event.
  $: verifiedKind = !targetAgentPubKeyB64
    ? undefined
    : kind === "moderator_granted" && $conversation.moderators.includes(targetAgentPubKeyB64)
      ? kind
      : kind === "moderator_revoked" && !$conversation.moderators.includes(targetAgentPubKeyB64)
        ? kind
        : kind === "member_removed" && !$conversation.members.includes(targetAgentPubKeyB64)
          ? kind
          : undefined;
</script>

<div class="text-secondary-400 dark:text-secondary-300 my-2 flex items-center justify-center gap-1 px-4 text-xs">
  <AgentNickname {cellIdB64} agentPubKeyB64={message.authorAgentPubKeyB64} />
  {#if verifiedKind === "moderator_granted" && targetAgentPubKeyB64}
    <span>{$t("common.granted_moderator_to")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else if verifiedKind === "moderator_revoked" && targetAgentPubKeyB64}
    <span>{$t("common.revoked_moderator_from")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else if verifiedKind === "member_removed" && targetAgentPubKeyB64}
    <span>{$t("common.removed")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else}
    <span>{$t("common.joined_the_conversation")}</span>
  {/if}
</div>
