<script lang="ts">
  import Avatar from "$lib/Avatar.svelte";
  import { MessageType, type CellIdB64, type MessageExtended } from "$lib/types";
  import { t } from "$translations";
  import DOMPurify from "dompurify";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import { getContext } from "svelte";
  import { type ConversationStore, deriveCellConversationStore } from "$store/ConversationStore";
  import { verifyModerationNotice } from "$lib/utils";

  export let messageExtended: MessageExtended;
  export let cellIdB64: CellIdB64;

  const conversationStore = getContext<{ getStore: () => ConversationStore }>(
    "conversationStore",
  ).getStore();
  const conversation = deriveCellConversationStore(conversationStore, cellIdB64);

  // Separate images from other files based on MIME type
  $: imageFiles = messageExtended.message.images.filter((file) =>
    file.file_type.startsWith("image/"),
  );
  $: otherFiles = messageExtended.message.images.filter(
    (file) => !file.file_type.startsWith("image/"),
  );
  $: hasImages = imageFiles.length > 0;
  $: hasFiles = otherFiles.length > 0;

  // "" (legacy/join notices) or "<kind>:<targetAgentPubKeyB64>"
  $: [noticeKind, noticeTargetAgentPubKeyB64] = messageExtended.message.content.split(":");

  $: verifiedNoticeKind = verifyModerationNotice(
    noticeKind,
    noticeTargetAgentPubKeyB64,
    messageExtended.authorAgentPubKeyB64,
    $conversation,
  );
</script>

{#if messageExtended.message.message_type === MessageType.System}
  <div class="mt-1 flex items-center space-x-1 italic text-secondary-400">
    <AgentNickname {cellIdB64} agentPubKeyB64={messageExtended.authorAgentPubKeyB64} />
    {#if verifiedNoticeKind === "moderator_granted"}
      <span>{$t("common.granted_moderator")}</span>
    {:else if verifiedNoticeKind === "moderator_revoked"}
      <span>{$t("common.revoked_moderator")}</span>
    {:else if verifiedNoticeKind === "member_removed"}
      <span>{$t("common.removed_a_member")}</span>
    {:else}
      <span>{$t("common.joined_the_conversation")}</span>
    {/if}
  </div>
{:else}
  <div class="line-clamp-1 break-words">
    <span class="inline-flex items-center align-middle">
      <Avatar agentPubKeyB64={messageExtended.authorAgentPubKeyB64} {cellIdB64} size={14} />
      <span class="ml-1"
        ><AgentNickname {cellIdB64} agentPubKeyB64={messageExtended.authorAgentPubKeyB64} /></span
      >
    </span>
    <span>{@html DOMPurify.sanitize(messageExtended.message.content)}</span>

    {#if hasImages || hasFiles}
      <div class="italic text-secondary-400">
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
      </div>
    {/if}
  </div>
{/if}
