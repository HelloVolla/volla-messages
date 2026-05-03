<script lang="ts">
  import type { CellIdB64, MessageExtended } from "$lib/types";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import { t } from "$translations";

  export let cellIdB64: CellIdB64;
  export let message: MessageExtended;
</script>

<div class="text-secondary-400 dark:text-secondary-300 my-2 flex items-center justify-center gap-1 px-4 text-xs">
  <AgentNickname {cellIdB64} agentPubKeyB64={message.authorAgentPubKeyB64} />
  <span>{$t("common.joined_the_conversation")}</span>
</div>
