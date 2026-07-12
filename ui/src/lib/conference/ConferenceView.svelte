<script lang="ts">
  import { onMount, onDestroy, getContext } from "svelte";
  import { get } from "svelte/store";
  import { fade, scale } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { t } from "$translations/index";
  import type { SimplePeerConferenceStore } from "$store/SimplePeerConferenceStore";
  import type { AgentPubKeyB64 } from "@holochain/client";
  import { type CellIdB64 } from "$lib/types";
  import Dialog from "$lib/Dialog.svelte";
  import Button from "$lib/Button.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import Avatar from "$lib/Avatar.svelte";
  import {
    deriveCellMergedProfileContactInviteStore,
    type MergedProfileContactInviteStore,
  } from "$store/MergedProfileContactInviteStore";

  import {
    ParticipantTile,
    ConferenceHeader,
    ConferenceRoster,
    ConferenceFooter,
    PreJoinScreen,
    ResizablePip,
  } from "./index";
  import {
    createActiveSpeakerStore,
    createLocalLevelMeter,
    type LocalLevelMeter,
  } from "./activeSpeakerDetection";
  import type { ParticipantData } from "./types";

  export let roomId: string;
  export let onClose: () => void;
  export let onConferenceEnded: ((roomId: string) => void) | undefined = undefined;
  export let showPreJoin: boolean = false; // Enable pre-join screen

  const conferenceStoreBase = getContext<{ getStore: () => SimplePeerConferenceStore }>(
    "conferenceStore",
  ).getStore();
  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();
  const mergedProfileContactInviteStore = getContext<{
    getStore: () => MergedProfileContactInviteStore;
  }>("mergedProfileContactInviteStore").getStore();
  const provisionedRelayCellIdB64 = getContext<{ getCellIdB64: () => CellIdB64 }>(
    "provisionedRelayCellId",
  ).getCellIdB64();

  const conferenceStore = conferenceStoreBase.deriveConferenceStore(roomId);

  let conferenceEndedLogged = false;

  let isGridView = true;
  let callDurationSeconds = 0;
  let callStartTime: number | null = null;
  let durationInterval: ReturnType<typeof setInterval> | null = null;
  $: videoEnabled = $conferenceStore?.videoEnabled ?? true;
  $: audioEnabled = $conferenceStore?.audioEnabled ?? true;
  let showPreJoinScreen = showPreJoin;
  let pipExpanded = false; // When true, local video is main and remote is PiP

  const activeSpeakerStore = createActiveSpeakerStore();
  let localMeter: LocalLevelMeter | null = null;
  let localMeterStream: MediaStream | null = null;

  let showEndCallDialog = false;
  let showErrorDialog = false;

  let errorDialogMessage = "";
  let errorDialogTitle = "";
  let errorDialogActionLabel = "";
  let suppressErrorDialog = false;


  $: profiles = $conferenceStore?.cellIdB64
    ? deriveCellMergedProfileContactInviteStore(
        mergedProfileContactInviteStore,
        $conferenceStore.cellIdB64,
        myPubKeyB64,
      )
    : deriveCellMergedProfileContactInviteStore(
        mergedProfileContactInviteStore,
        provisionedRelayCellIdB64,
        myPubKeyB64,
      );

  $: isMuted = !audioEnabled;
  $: isVideoEnabled = videoEnabled;
  $: isScreenSharing = $conferenceStore?.isScreenSharing ?? false;
  $: currentAudioDeviceId =
    $conferenceStore?.localStream?.getAudioTracks()[0]?.getSettings().deviceId ?? "";
  $: currentVideoDeviceId =
    $conferenceStore?.localStream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";

  function handleSwitchDevice(e: CustomEvent<{ kind: "audio" | "video"; deviceId: string }>) {
    conferenceStoreBase.switchDevice(roomId, e.detail.kind, e.detail.deviceId);
  }
  $: hostPubKey = $conferenceStore?.initiatorPubKeyB64;
  $: canEndForAll = conferenceStoreBase.canEndConference(roomId);
  $: currentError = $conferenceStore?.error;

  $: fullList = buildParticipantList($conferenceStore, myPubKeyB64, hostPubKey);
  $: allRemote = fullList.filter((p) => !p.isLocal);
  $: allParticipants = fullList.filter((p) => !p.declined);
  $: remoteParticipants = allParticipants.filter((p) => !p.isLocal);
  $: showWaitingRoster =
    allRemote.length > 0 && !remoteParticipants.some((p) => p._connected || p.hasJoined);
  $: callTitle =
    allRemote.length === 1
      ? getParticipantName(allRemote[0].pubKey)
      : allRemote.length > 1
        ? "Group call"
        : "Call";
  $: gridClass =
    allParticipants.length <= 1
      ? "grid-cols-1"
      : allParticipants.length === 2
        ? "grid-cols-1 grid-rows-2 landscape:grid-cols-2 landscape:grid-rows-1"
        : allParticipants.length <= 4
          ? "grid-cols-2 grid-rows-2"
          : "grid-cols-2 grid-rows-3 landscape:grid-cols-3 landscape:grid-rows-2";

  $: activeSpeakerId = $activeSpeakerStore.activeSpeaker;
  $: activeParticipant =
    (activeSpeakerId && activeSpeakerId !== myPubKeyB64
      ? remoteParticipants.find((p) => p.pubKey === activeSpeakerId)
      : undefined) ||
    remoteParticipants.find((p) => p._stream && p._connected) ||
    remoteParticipants[0];

  // Show PreJoinScreen for:
  // 1. Non-initiators receiving an invitation
  // 2. Anyone rejoining after leaving (invitationStatus === "left")
  $: shouldShowPreJoinScreen =
    $conferenceStore &&
    $conferenceStore.showPreJoinScreen &&
    (!$conferenceStore.isInitiator || $conferenceStore.invitationStatus === "left");

  $: if (!suppressErrorDialog && currentError && currentError !== errorDialogMessage) {
    const isRejected = $conferenceStore?.invitationStatus === "rejected";
    errorDialogMessage = currentError;
    errorDialogTitle = isRejected
      ? $t("common.conference_callDeclined")
      : $t("common.conference_connectionError");
    errorDialogActionLabel = isRejected
      ? $t("common.conference_close")
      : $t("common.conference_closeConference");
    showErrorDialog = true;
  }

  $: if ($conferenceStore?.ended && !conferenceEndedLogged) {
    conferenceEndedLogged = true;
    if (onConferenceEnded && roomId) {
      onConferenceEnded(roomId);
    }
  }

  function buildParticipantList(
    store: typeof $conferenceStore,
    myPubKey: string,
    hostKey: string | undefined,
  ): ParticipantData[] {
    if (!store?.participants) return [];

    const remote = [...store.participants.entries()].map(([pubKey, participant]) => ({
      pubKey,
      publicKey: pubKey,
      isLocal: false,
      hasJoined: participant.hasJoined,
      connectionStatus: participant.connectionStatus,
      videoEnabled: participant.videoEnabled,
      audioEnabled: participant.audioEnabled,
      connectionQuality: participant.connectionQuality,
      isHost: pubKey === hostKey,
      declined: participant.declined,
      _stream: getParticipantStream(participant),
      _connected: isParticipantConnected(participant),
    }));

    const local: ParticipantData = {
      pubKey: myPubKey,
      publicKey: myPubKey,
      isLocal: true,
      hasJoined: true,
      connectionStatus: "connected",
      videoEnabled,
      audioEnabled,
      connectionQuality: undefined,
      isHost: myPubKey === hostKey,
      _stream: store?.localStream ?? null,
      _connected: true,
    };

    return [local, ...remote.filter((p) => p.pubKey !== myPubKey)];
  }

  function getParticipantStream(participant: any): MediaStream | null {
    return participant.stream ?? null;
  }

  function isParticipantConnected(participant: any): boolean {
    return participant.peer?.connected === true || !!participant.stream;
  }

  function getParticipantName(agentPubKeyB64: string): string {
    const profile = $profiles?.data[agentPubKeyB64];
    if (profile?.profile?.fields) {
      const firstName = profile.profile.fields.firstName || "";
      const lastName = profile.profile.fields.lastName || "";
      return `${firstName} ${lastName}`.trim() || "Unknown";
    }
    return "Unknown";
  }

  function toggleMute() {
    if ($conferenceStore?.localStream) {
      const audioTracks = $conferenceStore.localStream.getAudioTracks();
      const nextState = !audioEnabled;
      audioTracks.forEach((track: MediaStreamTrack) => {
        track.enabled = nextState;
      });
      conferenceStoreBase.setMediaEnabled(roomId, videoEnabled, nextState);
      conferenceStoreBase.sendMediaStateToAll(roomId, videoEnabled, nextState);
    }
  }

  function toggleVideo() {
    if ($conferenceStore?.localStream) {
      const nextState = !videoEnabled;
      conferenceStoreBase.setLocalVideo(roomId, nextState);
    }
  }

  function handleToggleScreenShare() {
    if (!roomId) return;
    if (isScreenSharing) {
      conferenceStoreBase.stopScreenShare(roomId);
    } else {
      conferenceStoreBase.startScreenShare(roomId);
    }
  }

  async function endCall() {
    if (!roomId) return;
    const othersInCall = remoteParticipants.some((p) => p.hasJoined || p._connected);
    if (canEndForAll && othersInCall) {
      showEndCallDialog = true;
    } else if (canEndForAll) {
      conferenceStoreBase.cleanupWebRTC(roomId);
      await conferenceStoreBase.endConferenceForAll(roomId);
    } else {
      await conferenceStoreBase.leaveConference(roomId);
      conferenceStoreBase.cleanupWebRTC(roomId);
    }
  }

  async function confirmEndForAll() {
    showEndCallDialog = false;
    if (roomId) {
      conferenceStoreBase.cleanupWebRTC(roomId);

      await conferenceStoreBase.endConferenceForAll(roomId);
      conferenceEndedLogged = true;
      if (onConferenceEnded) {
        try {
          await onConferenceEnded(roomId);
        } catch (error) {
          console.warn("[ConferenceView] Failed to send conference ended log:", error);
        }
      }
    }
  }

  async function confirmJustLeave() {
    showEndCallDialog = false;
    if (roomId) {
      await conferenceStoreBase.leaveConference(roomId);
      conferenceStoreBase.cleanupWebRTC(roomId);
    }
  }

  async function handleRejectCall() {
    await conferenceStoreBase.rejectConferenceInvitation(roomId);
    // Don't call onClose() - state change (invitationStatus: "rejected") closes view automatically
  }

  async function handleErrorClose() {
    suppressErrorDialog = true;
    showErrorDialog = false;
    if (roomId) {
      conferenceStoreBase.cleanupWebRTC(roomId);
      await conferenceStoreBase.leaveConference(roomId);
    }
  }

  function handlePreJoinComplete(
    event: CustomEvent<{ videoEnabled: boolean; audioEnabled: boolean }>,
  ) {
    conferenceStoreBase.setMediaEnabled(
      roomId,
      event.detail.videoEnabled,
      event.detail.audioEnabled,
    );
    conferenceStoreBase.setShowPreJoinScreen(roomId, false);
    conferenceStoreBase.acceptConferenceInvitation(roomId);
  }

  function handlePreJoinCancel() {
    conferenceStoreBase.setShowPreJoinScreen(roomId, false);
  }

  function handleKeyboardShortcuts(event: KeyboardEvent) {
    if (event.code === "Escape") endCall();
    if (event.code === "KeyM" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleMute();
    }
    if (event.code === "KeyV" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleVideo();
    }
  }

  $: {
    const ls = $conferenceStore?.localStream ?? null;
    if (ls !== localMeterStream) {
      localMeter?.destroy();
      localMeter = ls ? createLocalLevelMeter(ls) : null;
      localMeterStream = ls;
    }
  }

  onMount(() => {
    callStartTime = Date.now();
    durationInterval = setInterval(() => {
      if (callStartTime) {
        callDurationSeconds = Math.floor((Date.now() - callStartTime) / 1000);
      }
    }, 1000);

    activeSpeakerStore.setLevelProvider(() => {
      const levels = new Map<string, number>();
      if (localMeter) levels.set(myPubKeyB64, localMeter.getLevel());
      const store = get(conferenceStore);
      if (store?.participants) {
        for (const [pk, part] of store.participants) {
          if (pk === myPubKeyB64) continue;
          levels.set(pk, part.conn?.getAudioLevel?.() ?? 0);
        }
      }
      return levels;
    });

    if ($conferenceStore?.localStream) {
      const storedVideoEnabled = $conferenceStore.videoEnabled ?? true;
      const storedAudioEnabled = $conferenceStore.audioEnabled ?? true;

      $conferenceStore.localStream.getVideoTracks().forEach((track: MediaStreamTrack) => {
        track.enabled = storedVideoEnabled;
      });
      $conferenceStore.localStream.getAudioTracks().forEach((track: MediaStreamTrack) => {
        track.enabled = storedAudioEnabled;
      });
    }
  });

  onDestroy(() => {
    if (durationInterval) clearInterval(durationInterval);
    activeSpeakerStore.destroy();
    localMeter?.destroy();
  });
</script>

<svelte:window on:keydown={handleKeyboardShortcuts} />

{#if showPreJoinScreen && shouldShowPreJoinScreen}
  <PreJoinScreen
    callerName={$conferenceStore?.invitedBy ? getParticipantName($conferenceStore.invitedBy) : ""}
    on:join={handlePreJoinComplete}
    on:cancel={handlePreJoinCancel}
  />
{:else}
  <div
    class="fixed inset-0 z-50 flex flex-col bg-secondary-900"
    transition:fade={{ duration: 200 }}
  >
    {#if $conferenceStore && !$conferenceStore.localStream && $conferenceStore.invitationStatus === "accepted"}
      <div
        class="absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-gradient-to-b from-secondary-900 to-secondary-800"
        transition:fade={{ duration: 200 }}
      >
        <div class="relative flex items-center justify-center">
          <span class="absolute h-[104px] w-[104px] animate-ping rounded-full bg-primary-500/25"
          ></span>
          {#if allRemote[0]}
            <div class="relative rounded-full ring-4 ring-primary-500/40">
              <Avatar
                agentPubKeyB64={allRemote[0].pubKey}
                size={88}
                cellIdB64={$conferenceStore?.cellIdB64}
              />
            </div>
          {:else}
            <div class="relative h-[88px] w-[88px] rounded-full bg-secondary-400"></div>
          {/if}
        </div>
        <div class="text-center">
          <p class="text-xl font-semibold text-tertiary-100">Connecting…</p>
          <p class="mt-1.5 text-sm text-tertiary-500">Setting up your secure call</p>
        </div>
        <SvgIcon icon="gear" moreClasses="h-5 w-5 text-tertiary-600 animate-spin" />
      </div>
    {/if}

    <ConferenceHeader
      {callDurationSeconds}
      participantCount={allParticipants.length}
      title={callTitle}
      {isGridView}
      on:toggleView={() => (isGridView = !isGridView)}
      on:minimize={onClose}
    />

    <div class="relative flex min-h-0 w-full flex-1 flex-col p-2 sm:p-3 md:p-4 lg:p-6">
      {#if showWaitingRoster}
        <ConferenceRoster
          participants={allRemote}
          getName={getParticipantName}
          cellIdB64={$conferenceStore?.cellIdB64}
        />
      {:else if isGridView}
        <div class="mx-auto grid h-full w-full gap-2 sm:gap-3 {gridClass}">
          {#each allParticipants.slice(0, 6) as participant (participant.pubKey)}
            <div class="min-h-0 min-w-0" animate:flip={{ duration: 250 }}>
              <ParticipantTile
                {participant}
                variant="grid"
                isActiveSpeaker={participant._connected && participant.pubKey === activeSpeakerId}
                localStream={$conferenceStore?.localStream}
                isLocalVideoEnabled={isVideoEnabled}
                isLocalMuted={isMuted}
                getName={getParticipantName}
                cellIdB64={$conferenceStore?.cellIdB64}
              />
            </div>
          {/each}
        </div>
      {:else}
        <div class="relative mx-auto h-full w-full max-w-7xl">
          {#if pipExpanded}
            <ParticipantTile
              participant={{
                pubKey: myPubKeyB64,
                publicKey: myPubKeyB64,
                isLocal: true,
                hasJoined: true,
                connectionStatus: "connected",
                _stream: $conferenceStore?.localStream ?? null,
                _connected: true,
                isHost: myPubKeyB64 === hostPubKey,
                videoEnabled,
                audioEnabled,
              }}
              variant="main"
              isActiveSpeaker={activeSpeakerId === myPubKeyB64}
              localStream={$conferenceStore?.localStream}
              isLocalVideoEnabled={isVideoEnabled}
              isLocalMuted={isMuted}
              getName={getParticipantName}
              cellIdB64={$conferenceStore?.cellIdB64}
            />
          {:else if activeParticipant}
            <ParticipantTile
              participant={activeParticipant}
              variant="main"
              isActiveSpeaker={activeParticipant.pubKey === activeSpeakerId}
              localStream={$conferenceStore?.localStream}
              isLocalVideoEnabled={isVideoEnabled}
              isLocalMuted={isMuted}
              getName={getParticipantName}
              cellIdB64={$conferenceStore?.cellIdB64}
            />
          {:else}
            <ParticipantTile
              participant={{
                pubKey: myPubKeyB64,
                publicKey: myPubKeyB64,
                isLocal: true,
                hasJoined: true,
                connectionStatus: "connected",
                _stream: $conferenceStore?.localStream ?? null,
                _connected: true,
                isHost: myPubKeyB64 === hostPubKey,
              }}
              variant="main"
              isActiveSpeaker={activeSpeakerId === myPubKeyB64}
              localStream={$conferenceStore?.localStream}
              isLocalVideoEnabled={isVideoEnabled}
              isLocalMuted={isMuted}
              getName={getParticipantName}
              cellIdB64={$conferenceStore?.cellIdB64}
            />
          {/if}

          {#if activeParticipant}
            <ResizablePip
              initialWidth={190}
              initialHeight={143}
              minWidth={130}
              minHeight={98}
              maxWidth={320}
              maxHeight={240}
              boundsPadding={16}
              keepAspectRatio={true}
              persistKey="conference-pip-v4"
              on:click={() => (pipExpanded = !pipExpanded)}
            >
              {#if pipExpanded}
                <ParticipantTile
                  participant={activeParticipant}
                  variant="pip"
                  isActiveSpeaker={activeParticipant.pubKey === activeSpeakerId}
                  localStream={$conferenceStore?.localStream}
                  isLocalVideoEnabled={isVideoEnabled}
                  isLocalMuted={isMuted}
                  getName={getParticipantName}
                  cellIdB64={$conferenceStore?.cellIdB64}
                />
              {:else}
                <ParticipantTile
                  isActiveSpeaker={activeSpeakerId === myPubKeyB64}
                  participant={{
                    pubKey: myPubKeyB64,
                    publicKey: myPubKeyB64,
                    isLocal: true,
                    hasJoined: true,
                    connectionStatus: "connected",
                    _stream: $conferenceStore?.localStream ?? null,
                    _connected: true,
                    isHost: myPubKeyB64 === hostPubKey,
                    videoEnabled,
                    audioEnabled,
                  }}
                  variant="pip"
                  localStream={$conferenceStore?.localStream}
                  isLocalVideoEnabled={isVideoEnabled}
                  isLocalMuted={isMuted}
                  getName={getParticipantName}
                  cellIdB64={$conferenceStore?.cellIdB64}
                />
              {/if}
            </ResizablePip>
          {/if}
        </div>
      {/if}
    </div>

    <ConferenceFooter
      {isMuted}
      {isVideoEnabled}
      {isScreenSharing}
      screenShareEnabled={false}
      audioDeviceId={currentAudioDeviceId}
      videoDeviceId={currentVideoDeviceId}
      on:toggleMute={toggleMute}
      on:toggleVideo={toggleVideo}
      on:toggleScreenShare={handleToggleScreenShare}
      on:switchDevice={handleSwitchDevice}
      on:endCall={endCall}
    />
  </div>
{/if}

{#if showEndCallDialog}
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center px-6"
    transition:fade={{ duration: 150 }}
  >
    <button
      class="absolute inset-0 bg-black/60"
      aria-label="Close"
      on:click={() => (showEndCallDialog = false)}
    ></button>
    <div
      class="relative z-10 w-full max-w-xs rounded-3xl bg-secondary-700 p-6 text-center shadow-2xl"
      transition:scale={{ duration: 150, start: 0.95 }}
    >
      <div
        class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-500/10"
      >
        <SvgIcon icon="callEnd" moreClasses="h-6 w-6 text-primary-500" />
      </div>
      <h3 class="text-lg font-semibold text-white">Leave the call?</h3>
      <p class="mb-6 mt-2 text-sm text-tertiary-500">
        You're the host. End the call for everyone, or step out and let the others keep talking.
      </p>
      <div class="flex flex-col gap-2.5">
        <button
          class="h-12 rounded-full bg-primary-500 font-semibold text-white transition-colors hover:bg-primary-600"
          on:click={confirmEndForAll}
        >
          End for everyone
        </button>
        <button
          class="h-12 rounded-full bg-secondary-400 font-semibold text-tertiary-100 transition-colors hover:bg-secondary-300"
          on:click={confirmJustLeave}
        >
          Just leave
        </button>
        <button
          class="h-11 rounded-full font-medium text-tertiary-500 transition-colors hover:text-tertiary-300"
          on:click={() => (showEndCallDialog = false)}
        >
          {$t("common.cancel")}
        </button>
      </div>
    </div>
  </div>
{/if}

<Dialog bind:open={showErrorDialog} title={errorDialogTitle}>
  <div class="flex flex-col items-center gap-4 text-center">
    <div class="flex h-12 w-12 items-center justify-center rounded-full bg-error-500/10">
      <SvgIcon icon="alertTriangle" moreClasses="h-6 w-6 text-error-500" />
    </div>
    <p class="text-sm text-secondary-500 dark:text-tertiary-500">{errorDialogMessage}</p>
  </div>
  <div class="mt-6 flex justify-center">
    <Button
      moreClasses="w-full sm:w-auto !bg-error-500 hover:!bg-error-600 !text-white"
      on:click={handleErrorClose}
    >
      {errorDialogActionLabel}
    </Button>
  </div>
</Dialog>
