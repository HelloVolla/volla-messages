<script lang="ts">
  import Avatar from "$lib/Avatar.svelte";
  import type { CellIdB64, MessageExtended } from "$lib/types";
  import { t } from "$translations";
  import DOMPurify from "dompurify";
  import AgentNickname from "$lib/AgentNickname.svelte";

  export let messageExtended: MessageExtended;
  export let cellIdB64: CellIdB64;

  // Separate images from other files based on MIME type
  $: imageFiles = messageExtended.message.images.filter((file) =>
    file.file_type.startsWith("image/"),
  );
  $: otherFiles = messageExtended.message.images.filter(
    (file) => !file.file_type.startsWith("image/"),
  );
  $: hasImages = imageFiles.length > 0;
  $: hasFiles = otherFiles.length > 0;
</script>

<div class="line-clamp-2 break-words">
  <span class="inline-flex items-center align-middle">
    <Avatar agentPubKeyB64={messageExtended.authorAgentPubKeyB64} {cellIdB64} size={14} />
    <span class="ml-1"><AgentNickname {cellIdB64} agentPubKeyB64={messageExtended.authorAgentPubKeyB64} /></span>
  </span>
  <span>{@html DOMPurify.sanitize(messageExtended.message.content)}</span>
  {#if hasImages || hasFiles}
    <span class="text-secondary-400 italic">
      ({#if hasImages}
        {$t("common.images", {
          count: imageFiles.length,
        })}
      {/if}
      {#if hasImages && hasFiles},
      {/if}
      {#if hasFiles}
        {$t("common.files", {
          count: otherFiles.length,
        })}
      {/if})
    </span>
  {/if}
</div>
