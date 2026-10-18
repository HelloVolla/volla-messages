<script lang="ts">
  import type { AgentPubKeyB64 } from "@holochain/client";
  import type { CellIdB64, MessageExtended } from "$lib/types";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import { t } from "$translations";

  export let cellIdB64: CellIdB64;
  export let message: MessageExtended;

  // "" (legacy/join notices) or "<kind>:<targetAgentPubKeyB64>"
  $: [kind, targetAgentPubKeyB64] = message.message.content.split(":") as [
    string,
    AgentPubKeyB64 | undefined,
  ];
</script>

<div class="text-secondary-400 dark:text-secondary-300 my-2 flex items-center justify-center gap-1 px-4 text-xs">
  <AgentNickname {cellIdB64} agentPubKeyB64={message.authorAgentPubKeyB64} />
  {#if kind === "moderator_granted" && targetAgentPubKeyB64}
    <span>{$t("common.granted_moderator_to")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else if kind === "moderator_revoked" && targetAgentPubKeyB64}
    <span>{$t("common.revoked_moderator_from")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else if kind === "member_removed" && targetAgentPubKeyB64}
    <span>{$t("common.removed")}</span>
    <AgentNickname {cellIdB64} agentPubKeyB64={targetAgentPubKeyB64} />
  {:else}
    <span>{$t("common.joined_the_conversation")}</span>
  {/if}
</div>
