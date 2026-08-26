<script lang="ts">
  import type { ActionHashB64, AgentPubKeyB64 } from "@holochain/client";
  import { encodeHashToBase64 } from "@holochain/client";
  import { getContext, onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Header from "$lib/Header.svelte";
  import { t } from "$translations";
  import {
    Privacy,
    FileStatus,
    type LocalFile,
    type MessageExtended,
    type CellIdB64,
  } from "$lib/types";
  import { deriveCellFileStore, type FileStore } from "$store/FileStore";
  import ForwardDialog from "./ForwardDialog.svelte";
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

  const fileStore = getContext<{ getStore: () => FileStore }>("fileStore").getStore();

  let conversation = deriveCellConversationStore(conversationStore, $page.params.id);
  let messages = deriveCellConversationMessageStore(conversationMessageStore, $page.params.id);
  let profiles = deriveCellProfileStore(profileStore, $page.params.id);
  let conversationTitle = deriveCellConversationTitleStore(conversationTitleStore, $page.params.id);
  let joined = deriveCellMergedProfileContactInviteJoinedStore(
    mergedProfileContactInviteJoinedStore,
    $page.params.id,
  );
  let conversationNetwork = deriveConversationNetworkStore(networkStatsStore, $page.params.id);
  let cellFileStore = deriveCellFileStore(fileStore, $page.params.id);

  let showConversationNetworkPanel = false;

  // Message forwarding
  let showForwardDialog = false;
  let forwardMessage: MessageExtended | undefined = undefined;
  let isForwarding = false;

  // Enabled conversations other than the current one, as forwarding targets.
  $: forwardTargets = $conversationStore.list
    .filter(([cellIdB64, c]) => c.cellInfo.enabled && cellIdB64 !== $page.params.id)
    .map(([cellIdB64, c]) => ({
      cellIdB64,
      title: $conversationTitleStore[cellIdB64] || c.config?.title || c.cellInfo.name,
    }));

  let configTimeout: ReturnType<typeof setTimeout>;
  let agentTimeout: ReturnType<typeof setTimeout>;
  let messageTimeout: ReturnType<typeof setTimeout>;

  let conversationMessageInputRef: HTMLInputElement;
  let conversationMessagesRef: ConversationMessages;
  let sending = false;
  let loadingMessagesNew = false;
  let loadingMessagesOld = false;
  let userIsPagingHistory = false;

  let showDeleteDialog = false;
  let deleteMessageActionHashB64: ActionHashB64 | undefined = undefined;
  let isDeletingMessage = false;

  let showEditDialog = false;
  let editActionHashB64: ActionHashB64 | undefined = undefined;
  let editText = "";
  let isEditingMessage = false;

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

  function openForward(message: MessageExtended) {
    forwardMessage = message;
    showForwardDialog = true;
  }

  function openEdit(actionHashB64: ActionHashB64, content: string) {
    editActionHashB64 = actionHashB64;
    editText = content;
    showEditDialog = true;
  }

  async function handleEditMessage() {
    if (editActionHashB64 === undefined || isEditingMessage) return;
    const content = editText.trim();
    if (content.length === 0) return;

    isEditingMessage = true;
    try {
      await messages.updateMessage(editActionHashB64, content);
      showEditDialog = false;
      editActionHashB64 = undefined;
    } catch (err) {
      console.error(err);
      toast.error($t("common.edit_message_error"));
    }
    isEditingMessage = false;
  }

  async function handleForwardTo(targetCellIdB64: CellIdB64) {
    const message = forwardMessage;
    if (message === undefined || isForwarding) return;

    isForwarding = true;
    try {
      // Files are stored per-conversation, so reconstruct the bytes from the
      // source cell (downloading if needed) to re-upload into the target cell.
      const localFiles: LocalFile[] = [];
      for (const mf of message.message.images) {
        const hashB64 = encodeHashToBase64(mf.storage_entry_hash);
        let entry = get(cellFileStore).data[hashB64];
        if (entry?.status !== FileStatus.Loaded || entry.file === undefined) {
          await cellFileStore.download(hashB64);
          entry = get(cellFileStore).data[hashB64];
        }
        if (entry?.file !== undefined) {
          localFiles.push({ file: entry.file, dataURL: "", key: hashB64 });
        }
      }

      await conversationMessageStore.sendMessage(
        targetCellIdB64,
        message.message.content,
        localFiles,
        true,
      );

      toast.success($t("common.forward_success"));
      showForwardDialog = false;
      forwardMessage = undefined;
      await goto(`/conversations/${targetCellIdB64}`);
    } catch (e) {
      console.error("Failed to forward message", e);
      toast.error($t("common.forward_error"));
    }
    isForwarding = false;
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
      // Sent message should always scroll into view, regardless of
      // whether you were previously scrolled up reading history.
      conversationMessagesRef?.scrollToBottom("auto");
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
    {#if import.meta.env.DEV}
      <NetworkStatusDot
        connectionCount={$conversationNetwork?.peerCount || 0}
        onClick={() => (showConversationNetworkPanel = !showConversationNetworkPanel)}
      />
    {/if}
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

{#if import.meta.env.DEV && showConversationNetworkPanel}
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
          bind:this={conversationMessagesRef}
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
          on:forward={(e) => openForward(e.detail)}
          on:edit={(e) => openEdit(e.detail.actionHashB64, e.detail.content)}
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

<DialogConfirm
  bind:open={showEditDialog}
  title={$t("common.edit_message")}
  actionButtonLabel={$t("common.save")}
  loading={isEditingMessage}
  on:confirm={handleEditMessage}
>
  <textarea
    bind:value={editText}
    rows="3"
    class="bg-tertiary-500 dark:bg-secondary-500 w-full resize-none rounded-lg border-0 p-2 focus:ring-0"
  />
</DialogConfirm>

<ForwardDialog
  bind:open={showForwardDialog}
  loading={isForwarding}
  conversations={forwardTargets}
  on:select={(e) => handleForwardTo(e.detail)}
/>
