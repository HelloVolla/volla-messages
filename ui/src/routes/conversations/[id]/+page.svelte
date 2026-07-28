<script lang="ts">
  import type { ActionHashB64, type AgentPubKeyB64 } from "@holochain/client";
  import { getContext, onDestroy, onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Header from "$lib/Header.svelte";
  import { t } from "$translations";
  import { Privacy, type LocalFile } from "$lib/types";
  import ConversationMessageInput from "./ConversationMessageInput.svelte";
  import ConversationEmpty from "./ConversationEmpty.svelte";
  import ConversationMessages from "./ConversationMessages.svelte";
  import ButtonIconBare from "$lib/ButtonIconBare.svelte";
  import { deriveCellConversationStore, type ConversationStore } from "$store/ConversationStore";
  import { deriveCellProfileStore, type ProfileStore } from "$store/ProfileStore";
  import { toast } from "svelte-french-toast";
  import {
    type ConversationTitleStore,
    deriveCellConversationTitleStore,
  } from "$store/ConversationTitleStore";
  import {
    deriveCellConversationMessageStore,
    type ConversationMessageStore,
  } from "$store/ConversationMessageStore";
  import {
    deriveCellMergedProfileContactInviteJoinedStore,
    type MergedProfileContactInviteJoinedStore,
  } from "$store/MergedProfileContactInviteJoinedStore";
  import { POLLING_INTERVAL_FAST, POLLING_INTERVAL_SLOW } from "$config";
  import DialogConfirm from "$lib/DialogConfirm.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import {
    deriveConversationNetworkStore,
    type NetworkStatsStore,
  } from "$store/NetworkStatsStore";
  import NetworkStatusDot from "$lib/NetworkStatusDot.svelte";
  import NetworkStatusPanel from "$lib/NetworkStatusPanel.svelte";

  const conversationStore = getContext<{ getStore: () => ConversationStore }>(
    "conversationStore",
  ).getStore();

  const profileStore = getContext<{ getStore: () => ProfileStore }>("profileStore").getStore();

  const mergedProfileContactInviteJoinedStore = getContext<{
    getStore: () => MergedProfileContactInviteJoinedStore;
  }>("mergedProfileContactInviteJoinedStore").getStore();

  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();

  const conversationTitleStore = getContext<{
    getStore: () => ConversationTitleStore;
  }>("conversationTitleStore").getStore();

  const conversationMessageStore = getContext<{
    getStore: () => ConversationMessageStore;
  }>("conversationMessageStore").getStore();

  const networkStatsStore = getContext<{
    getStore: () => NetworkStatsStore;
  }>("networkStatsStore").getStore();

  let conversation = deriveCellConversationStore(conversationStore, $page.params.id);
  let messages = deriveCellConversationMessageStore(conversationMessageStore, $page.params.id);
  let profiles = deriveCellProfileStore(profileStore, $page.params.id);
  let conversationTitle = deriveCellConversationTitleStore(conversationTitleStore, $page.params.id);
  let joined = deriveCellMergedProfileContactInviteJoinedStore(
    mergedProfileContactInviteJoinedStore,
    $page.params.id,
  );
  let conversationNetwork = deriveConversationNetworkStore(networkStatsStore, $page.params.id);

  let showConversationNetworkPanel = false;

  let configTimeout: ReturnType<typeof setTimeout>;
  let agentTimeout: ReturnType<typeof setTimeout>;
  let messageTimeout: ReturnType<typeof setTimeout>;

  let conversationMessageInputRef: HTMLInputElement;
  let sending = false;
  let loadingMessagesNew = false;
  let loadingMessagesOld = false;
  let userIsPagingHistory = false;

  let showDeleteDialog = false;
  let deleteMessageActionHashB64: ActionHashB64 | undefined = undefined;
  let isDeletingMessage = false;

  let isFirstConfigLoad = true;
  let isFirstProfilesLoad = true;
  let isFirstLoadMessages = true;

  let noMoreOlderMessages = false;

  $: iAmProgenitor = $conversation.dnaProperties.progenitor === myPubKeyB64;

  $: if ($page.params.id) {
  noMoreOlderMessages = false;
}

  async function handleDeleteMessage() {
    if (deleteMessageActionHashB64 === undefined) return;

    isDeletingMessage = true;
    try {
      await messages.deleteMessage(deleteMessageActionHashB64);
      toast.success($t("common.delete_message_success"));
    } catch (err) {
      console.error(err);
      toast.error($t("common.delete_message_error"));
    }
    isDeletingMessage = false;
    showDeleteDialog = false;
    deleteMessageActionHashB64 = undefined;
  }

  async function loadProfiles() {
    await profiles.load(true);
    isFirstProfilesLoad = false;
    clearTimeout(agentTimeout);

    if ($joined.count < 2) {
      agentTimeout = setTimeout(() => {
        loadProfiles();
      }, POLLING_INTERVAL_FAST);
    } else {
      agentTimeout = setTimeout(() => {
        loadProfiles();
      }, POLLING_INTERVAL_SLOW);
    }
  }

  async function loadConfig() {
    await conversation.loadConfig(true);
    isFirstConfigLoad = false;
    clearTimeout(configTimeout);

    if ($conversation.config === undefined) {
      configTimeout = setTimeout(() => {
        loadConfig();
      }, POLLING_INTERVAL_FAST);
    } else {
      configTimeout = setTimeout(() => {
        loadConfig();
      }, POLLING_INTERVAL_SLOW);
    }
  }

  async function loadMessages() {
     clearTimeout(messageTimeout);

  if (!loadingMessagesOld && !userIsPagingHistory && !loadingMessagesNew) {
    await loadMessagesInCurrentBucket(true);
    isFirstLoadMessages = false;
  }

  messageTimeout = setTimeout(
    loadMessages,
    $messages.count === 0 ? POLLING_INTERVAL_FAST : POLLING_INTERVAL_SLOW,
  );
  }

  const loadData = () => {
    loadProfiles();
    loadConfig();
    loadMessages();
  };

async function loadMoreMessages() {
  if (loadingMessagesOld || noMoreOlderMessages) return;

  loadingMessagesOld = true;
  userIsPagingHistory = true;

  try {
    const loadedCount = await messages.loadMoreMessages();
    console.log("loadedCount:", loadedCount);

    if (loadedCount === 0) {
      noMoreOlderMessages = true;
      console.log("History exhausted at UI level");
    }
  } catch (e) {
    console.error("Error loading more messages:", e);
  } finally {
    loadingMessagesOld = false;

    setTimeout(() => {
      userIsPagingHistory = false;
    }, 1200);
  }
}

  async function loadMessagesInCurrentBucket(local: boolean) {
    if (loadingMessagesNew) return;

    console.log("loadMessagesInCurrentBucket");
    loadingMessagesNew = true;
    try {
      await messages.loadMessagesInCurrentBucketTargetCount(local);
    } catch (e) {
      console.error(e);
    }
    loadingMessagesNew = false;
  }

  async function sendMessage(text: string, files: LocalFile[]) {
    if (sending) return;

    conversationMessageInputRef?.focus();

    sending = true;
    try {
      await messages.sendMessage(text, files);
    } catch (e) {
      console.error(e);
      toast.error(`${$t("common.error_sending_message")}: ${(e as Error).message || e}`);
    }
    sending = false;
  }

  onMount(() => {
    conversationMessageInputRef?.focus();
    loadData();
    conversation.updateUnread(false);
  });

  onDestroy(() => {
    clearTimeout(agentTimeout);
    clearTimeout(configTimeout);
    clearTimeout(messageTimeout);
  });

  async function dumpAll() {
    console.log("Dumping all");

    const { messageDB } = await import("$store/db/MessageDatabase");
    await messageDB.debugDumpAll();

    await messages.debugGetAllMessages();
  }
</script>

<Header backUrl="/conversations">
  <div slot="center" class="flex items-center justify-center gap-1 overflow-hidden px-4">
    <NetworkStatusDot
      connectionCount={$conversationNetwork?.peerCount || 0}
      onClick={() => (showConversationNetworkPanel = !showConversationNetworkPanel)}
    />
    <h1 class="overflow-hidden text-ellipsis whitespace-nowrap text-center">
      {$conversationTitle}
    </h1>
  </div>

  <div class="flex items-center justify-center" slot="right">
    <!-- <ButtonIconBare
      moreClasses="!w-[18px] !h-auto"
      moreClassesButton="p-4"
      icon="archive"
      on:click={dumpAll}
    /> -->
    <ButtonIconBare
      moreClasses="!w-[18px] !h-auto"
      moreClassesButton="p-4"
      icon="gear"
      on:click={() => goto(`/conversations/${$page.params.id}/details`)}
    />

    {#if $conversation.dnaProperties.privacy === Privacy.Private && iAmProgenitor}
      <ButtonIconBare
        moreClasses="h-[24px] w-[24px]"
        moreClassesButton="p-4"
        icon="addPerson"
        on:click={() => goto(`/conversations/${$page.params.id}/invite`)}
      />
    {/if}
  </div>
</Header>

{#if showConversationNetworkPanel}
  <NetworkStatusPanel
    stats={$networkStatsStore}
    conversationInfo={$conversationNetwork}
    onClose={() => (showConversationNetworkPanel = false)}
    onCopyDiagnostics={() => {
      const text = networkStatsStore.copyDiagnostics();
      navigator.clipboard.writeText(text).then(
        () => console.log("[NET] diagnostics copied to clipboard"),
        () => console.log("[NET] diagnostics:\n" + text),
      );
    }}
    resolveAgentName={(key) => $profiles.data[key]?.profile?.nickname}
  />
{/if}

<div class="mx-auto flex w-full flex-1 flex-col items-center justify-center overflow-hidden">
  <div class="relative flex w-full grow flex-col items-center overflow-hidden pt-6">
    {#if $messages.count === 0 && iAmProgenitor && $joined.count === 1}
      <ConversationEmpty cellIdB64={$page.params.id} />
    {:else if $messages.count === 0}
      <ConversationHeader cellIdB64={$page.params.id} />
    {:else}
      <div class="w-full flex-1 overflow-hidden">
        <ConversationMessages
          loadingTop={loadingMessagesOld}
          cellIdB64={$page.params.id}
          messages={$messages.list}
          recipientPubKeyB64s={$joined.list
            .map(([k]) => k)
            .filter((k) => k !== myPubKeyB64)}
          on:delete={(e) => {
            deleteMessageActionHashB64 = e.detail;
            showDeleteDialog = true;
          }}
          on:scrollAtTop={loadMoreMessages}
        />
      </div>
    {/if}
  </div>
</div>

<ConversationMessageInput
  bind:ref={conversationMessageInputRef}
  disabled={sending}
  loading={sending}
  on:send={(e) => sendMessage(e.detail.text, e.detail.files)}
/>

<DialogConfirm
  bind:open={showDeleteDialog}
  title={$t("common.delete_message")}
  actionButtonLabel={$t("common.delete")}
  actionButtonIcon="delete"
  loading={isDeletingMessage}
  on:confirm={handleDeleteMessage}
>
  <p>{$t("common.delete_message_dialog_message")}</p>
</DialogConfirm>