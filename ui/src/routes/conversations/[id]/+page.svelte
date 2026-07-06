<script lang="ts">
  import { encodeHashToBase64, type ActionHashB64, type AgentPubKeyB64 } from "@holochain/client";
  import { getContext, onDestroy, onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Header from "$lib/Header.svelte";
  import { t } from "$translations";
  import { Privacy, type LocalFile, type MessageExtended } from "$lib/types";
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
  import {
    deriveCellMergedProfileContactInviteStore,
    type MergedProfileContactInviteStore,
  } from "$store/MergedProfileContactInviteStore";
  import { POLLING_INTERVAL_FAST, POLLING_INTERVAL_SLOW } from "$config";
  import { deriveThreadViewEnabled } from "$store/ThreadViewStore";
  import DialogConfirm from "$lib/DialogConfirm.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import InlineConferenceInvite from "./InlineConferenceInvite.svelte";
  import type { SimplePeerConferenceStore } from "$store/SimplePeerConferenceStore";
  import { sendConferenceStartedLog, sendConferenceEndedLog } from "$lib/conferenceLogging";
  import { deriveConversationNetworkStore, type NetworkStatsStore } from "$store/NetworkStatsStore";
  import NetworkStatusDot from "$lib/NetworkStatusDot.svelte";
  import NetworkStatusPanel from "$lib/NetworkStatusPanel.svelte";

  const conversationStore = getContext<{ getStore: () => ConversationStore }>(
    "conversationStore",
  ).getStore();

  const profileStore = getContext<{ getStore: () => ProfileStore }>("profileStore").getStore();

  const mergedProfileContactInviteJoinedStore = getContext<{
    getStore: () => MergedProfileContactInviteJoinedStore;
  }>("mergedProfileContactInviteJoinedStore").getStore();
  const mergedProfileContactInviteStore = getContext<{
    getStore: () => MergedProfileContactInviteStore;
  }>("mergedProfileContactInviteStore").getStore();
  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();

  const conversationTitleStore = getContext<{
    getStore: () => ConversationTitleStore;
  }>("conversationTitleStore").getStore();

  const conversationMessageStore = getContext<{
    getStore: () => ConversationMessageStore;
  }>("conversationMessageStore").getStore();
  const conferenceStore = getContext<{ getStore: () => SimplePeerConferenceStore }>(
    "conferenceStore",
  ).getStore();
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
  let mergedProfileContact = deriveCellMergedProfileContactInviteStore(
    mergedProfileContactInviteStore,
    $page.params.id,
    myPubKeyB64,
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

  // Reply state
  let replyToMessage: MessageExtended | undefined = undefined;
  let replyToActionHash: ActionHashB64 | undefined = undefined;

  let isStartingCall = false;

  let isFirstConfigLoad = true;
  let isFirstProfilesLoad = true;
  let isFirstLoadMessages = true;

  const threadViewEnabled = deriveThreadViewEnabled($page.params.id);
  let noMoreOlderMessages = false;

  $: iAmProgenitor = $conversation.dnaProperties.progenitor === myPubKeyB64;
  $: participantCount = $mergedProfileContact.list.length;
  $: isSmallConversation = participantCount <= 2 || !$threadViewEnabled;
  $: displayMessages = isSmallConversation
    ? $messages.list
    : $messages.list.filter(([, msg]) => !msg.message.reply_to);

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

  async function sendMessage(text: string, files: LocalFile[], replyTo?: ActionHashB64) {
    if (sending) return;

    conversationMessageInputRef?.focus();

    sending = true;
    try {
      await messages.sendMessage(text, files, replyTo);

      // Clear reply context
      replyToMessage = undefined;
      replyToActionHash = undefined;
    } catch (e) {
      console.error(e);
      toast.error(`${$t("common.error_sending_message")}: ${(e as Error).message || e}`);
    }
    sending = false;
  }

  function handleReply(event: CustomEvent<ActionHashB64>) {
    const actionHashB64 = event.detail;
    console.log("[+page] handleReply called:", {
      actionHashB64,
      participantCount,
      isSmallConversation,
    });

    if (isSmallConversation) {
      // Small conversation: show inline reply context
      replyToActionHash = actionHashB64;
      replyToMessage = $messages.data[actionHashB64];
      conversationMessageInputRef.focus();
    } else {
      // for arge conversation open thread view
      // don't set reply context
      openThreadView(actionHashB64);
    }
  }

  function openThreadView(rootMessageHash: ActionHashB64) {
    goto(`/conversations/${$page.params.id}/thread/${rootMessageHash}`);
  }

  function scrollToMessage(actionHashB64: ActionHashB64) {
    // TODO: Implement scroll-to-message functionality
    console.log("Scroll to message:", actionHashB64);
  }

  async function startVideoCall() {
    if (isStartingCall) return;

    console.log("[AV Call] ========== Starting Video Call ==========");
    console.log("[AV Call] Total members in chat ($joined.list):", $joined.list.length);
    console.log("[AV Call] My public key:", myPubKeyB64);
    console.log(
      "[AV Call] All members:",
      $joined.list.map(([pubKeyB64, profile]) => ({
        pubKey: pubKeyB64,
        name: profile.profile.nickname,
      })),
    );

    const otherParticipants = $joined.list
      .map(([pubKeyB64, _profile]) => pubKeyB64)
      .filter((p) => p !== myPubKeyB64);

    console.log("[AV Call] Other participants to invite:", otherParticipants);
    console.log("[AV Call] Number of participants to invite:", otherParticipants.length);

    if (otherParticipants.length === 0) {
      console.error("[AV Call] ERROR: No other participants found to call");
      toast.error("No participants to call");
      return;
    }

    isStartingCall = true;
    try {
      console.log("[AV Call] Step 1: Creating conference room...");
      const roomId = await conferenceStore.createConference(
        otherParticipants,
        $page.params.id,
        myPubKeyB64,
      );
      console.log("[AV Call] Step 1 COMPLETE: Conference room created with ID:", roomId);

      console.log("[AV Call] Step 2: Initializing WebRTC (requesting media permissions)...");
      await conferenceStore.initializeWebRTC(roomId);
      console.log("[AV Call] Step 2 COMPLETE: WebRTC initialized successfully");
      console.log("[AV Call] Step 4: Sending conference started log to chat...");
      const allParticipants = [myPubKeyB64, ...otherParticipants];
      await sendConferenceStartedLog(
        conversationMessageStore,
        $page.params.id,
        roomId,
        myPubKeyB64,
        allParticipants,
      );
      console.log("[AV Call] Step 4 COMPLETE: Conference log sent");

      console.log("[AV Call] ========== Video Call Started Successfully ==========");
    } catch (error) {
      console.error("[AV Call] ERROR: Failed to start call:", error);
      toast.error(
        "Failed to start call: " + (error instanceof Error ? error.message : String(error)),
      );
    }
    isStartingCall = false;
  }

  function handleAcceptCall(roomId: string) {
    const conference = $conferenceStore.data[roomId];
    if (!conference) {
      toast.error("Conference not found");
      return;
    }

    conferenceStore.setMinimized(roomId, false);
    conferenceStore.setShowPreJoinScreen(roomId, true);
  }

  async function handleRejectCall(roomId: string) {
    try {
      const conference = $conferenceStore.data[roomId];
      if (!conference) return;

      await conferenceStore.rejectConferenceInvitation(roomId);
    } catch (error) {
      console.error("Failed to reject call:", error);
      toast.error("Failed to reject call");
    }
  }

  let dhtActiveRoomId: string | null = null;
  let activeCallPollTimer: ReturnType<typeof setInterval> | undefined;

  $: myCellCalls = Object.entries($conferenceStore?.data || {}).filter(
    ([_, c]) => c && !c.ended && c.cellIdB64 === $page.params.id,
  );
  $: activeCallEntry = myCellCalls.find(
    ([_, c]) => c.invitationStatus === "accepted" || c.isInitiator || c.showPreJoinScreen,
  );
  $: amInCall = !!activeCallEntry;
  $: callOngoingElsewhere =
    !amInCall &&
    (!!dhtActiveRoomId ||
      myCellCalls.some(
        ([_, c]) =>
          c.invitationStatus === "pending" ||
          c.invitationStatus === "active" ||
          c.invitationStatus === "left",
      ));

  async function refreshActiveCall() {
    if (amInCall) {
      dhtActiveRoomId = null;
      return;
    }
    dhtActiveRoomId = await conferenceStore.getActiveConferenceRoom($page.params.id);
  }

  function handleCallButton() {
    if (isStartingCall || callOngoingElsewhere) return;
    if (activeCallEntry) {
      conferenceStore.setMinimized(activeCallEntry[0], false);
      return;
    }
    const active = conferenceStore.getMyActiveCall();
    if (active && active.cellIdB64 !== $page.params.id) {
      toast.error("You're already in a call in another conversation");
      return;
    }
    startVideoCall();
  }

  onMount(() => {
    conversationMessageInputRef?.focus();
    loadData();
    conversation.updateUnread(false);
    refreshActiveCall();
    activeCallPollTimer = setInterval(refreshActiveCall, 12000);
  });

  onDestroy(() => {
    clearTimeout(agentTimeout);
    clearTimeout(configTimeout);
    clearTimeout(messageTimeout);
    if (activeCallPollTimer) clearInterval(activeCallPollTimer);
  });

  async function dumpAll() {
    console.log("Dumping all");

    // Import and dump IndexedDB contents
    const { messageDB } = await import("$store/db/MessageDatabase");
    await messageDB.debugDumpAll();

    // Also get all messages from Holochain
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
    <ButtonIconBare
      moreClasses="h-[24px] w-[24px]"
      moreClassesButton="p-4 {isStartingCall || callOngoingElsewhere
        ? 'cursor-not-allowed opacity-40'
        : ''}"
      icon="videoCall"
      disabled={isStartingCall || callOngoingElsewhere}
      on:click={handleCallButton}
      title={amInCall
        ? "Return to call"
        : callOngoingElsewhere
          ? "Call in progress"
          : "Start video call"}
    />

    <ButtonIconBare
      moreClasses="!w-[18px] !h-auto"
      moreClassesButton="p-4"
      icon="archive"
      on:click={dumpAll}
    />
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
          messages={displayMessages}
          {participantCount}
          threadViewEnabled={$threadViewEnabled}
          on:delete={(e) => {
            deleteMessageActionHashB64 = e.detail;
            showDeleteDialog = true;
          }}
          on:reply={handleReply}
          on:openThread={(e) => openThreadView(e.detail)}
          on:scrollToMessage={(e) => scrollToMessage(e.detail)}
          on:scrollAtTop={loadMoreMessages}
        />
      </div>
    {/if}
  </div>
</div>

<InlineConferenceInvite onAccept={handleAcceptCall} onReject={handleRejectCall} />

<ConversationMessageInput
  bind:ref={conversationMessageInputRef}
  bind:replyToMessage
  bind:replyToActionHash
  cellIdB64={$page.params.id}
  disabled={sending}
  loading={sending}
  on:send={(e) =>
    sendMessage(
      e.detail.text,
      e.detail.files,
      e.detail.replyTo ? encodeHashToBase64(e.detail.replyTo) : undefined,
    )}
  on:cancelReply={() => {
    replyToMessage = undefined;
    replyToActionHash = undefined;
  }}
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
