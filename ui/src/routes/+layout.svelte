<script lang="ts">
  import type { AgentPubKeyB64, AppClient, CellId } from "@holochain/client";
  import { AppWebsocket, CellType, encodeHashToBase64 } from "@holochain/client";
  import { writable, type Writable } from "svelte/store";
  import { onMount, onDestroy, setContext } from "svelte";
  import { t } from "$translations";
  import { createSignalHandler } from "$store/SignalHandler";
  import toast, { Toaster } from "svelte-french-toast";
  import { initLightDarkModeSwitcher } from "$lib/utils";
  import { RelayClient } from "$store/RelayClient";
  import AppLanding from "$lib/AppLanding.svelte";
  import { MIN_FIRST_NAME_LENGTH, ROLE_NAME, ZOME_NAME } from "$config";
  import Button from "$lib/Button.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import ProfileSetupName from "./ProfileSetupName.svelte";
  import ProfileSetupAvatar from "./ProfileSetupAvatar.svelte";
  import { createContactStore, type ContactStore } from "$store/ContactStore";
  import {
    type CellProfileStore,
    type ProfileStore,
    createProfileStore,
    deriveCellProfileStore,
  } from "$store/ProfileStore";
  import { encodeCellIdToBase64, setupCallNotifications } from "$lib/utils";
  import { goto } from "$app/navigation";
  import {
    createMergedProfileContactInviteStore,
    type MergedProfileContactInviteStore,
  } from "$store/MergedProfileContactInviteStore";
  import { createConversationStore, type ConversationStore } from "$store/ConversationStore";
  import {
    createConversationTitleStore,
    type ConversationTitleStore,
  } from "$store/ConversationTitleStore";
  import type { CellIdB64, CreateProfileInputUI } from "$lib/types";
  import { createInviteStore, type InviteStore } from "$store/InviteStore";
  import "../app.postcss";
  import {
    type ConversationLatestMessageStore,
    createConversationLatestMessageStore,
  } from "$store/ConversationLatestMessageStore";
  import {
    type ConversationMessageStore,
    createConversationMessageStore,
  } from "$store/ConversationMessageStore";
  import {
    createMergedProfileContactInviteJoinedStore,
    createMergedProfileContactInviteUnjoinedStore,
    type MergedProfileContactInviteJoinedStore,
    type MergedProfileContactInviteUnjoinedStore,
  } from "$store/MergedProfileContactInviteJoinedStore";
  import { createFileStore, type FileStore } from "$store/FileStore";
  import {
    createSimplePeerConferenceStore,
    type SimplePeerConferenceStore,
  } from "$store/SimplePeerConferenceStore";
  import { createNetworkStatsStore, type NetworkStatsStore } from "$store/NetworkStatsStore";
  import Dialog from "$lib/Dialog.svelte";
  // Use the refactored ConferenceView with extracted components
  import { ConferenceView, ResizablePip } from "$lib/conference";
  import IncomingCallBanner from "$lib/IncomingCallBanner.svelte";
  import { sendConferenceEndedLog } from "$lib/conferenceLogging";

  // Svelte action to set video srcObject
  function setVideoStream(videoElement: HTMLVideoElement, stream: MediaStream) {
    videoElement.srcObject = stream;
    return {
      update(newStream: MediaStream) {
        if (videoElement.srcObject !== newStream) {
          videoElement.srcObject = newStream;
        }
      },
    };
  }

  // Holochain client
  let client: AppClient;
  let provisionedRelayCellId: CellId;
  let provisionedRelayCellIdB64: CellIdB64;
  let myPubKeyB64: AgentPubKeyB64;

  // Frontend store singletons
  let profileStore: ProfileStore;
  let contactStore: ContactStore;
  let mergedProfileContactInviteStore: MergedProfileContactInviteStore;
  let conversationStore: ConversationStore;
  let fileStore: FileStore;
  let conversationTitleStore: ConversationTitleStore;
  let conversationMessageStore: ConversationMessageStore;
  let conversationLatestMessageStore: ConversationLatestMessageStore;
  let inviteStore: InviteStore;
  let provisionedRelayCellProfileStore: CellProfileStore;
  let mergedProfileContactInviteUnjoinedStore: MergedProfileContactInviteUnjoinedStore;
  let mergedProfileContactInviteJoinedStore: MergedProfileContactInviteJoinedStore;
  let conferenceStore: SimplePeerConferenceStore;
  let networkStatsStore: NetworkStatsStore;
  let relayClient: RelayClient;
  let onlinePeers: Writable<Set<AgentPubKeyB64>> = writable(new Set());

  // Is the holochain client connected?
  let isClientConnected = false;
  let isClientConnectionFailed = false;

  // Are the frontend stores initialized?
  let isStoresSetup = false;

  // Has the user clicked the "create account" button?
  let isUserCreatingProfile = false;

  // Profile create data
  let profileCreateInput: CreateProfileInputUI = {
    firstName: "",
    lastName: "",
    avatar: "",
  };

  $: myProfile =
    provisionedRelayCellProfileStore && $provisionedRelayCellProfileStore.data[myPubKeyB64]
      ? $provisionedRelayCellProfileStore.data[myPubKeyB64]
      : undefined;
  $: myProfileExists = myProfile !== undefined;

  $: activeConference =
    conferenceStore && $conferenceStore
      ? Object.entries($conferenceStore.data).find(
          ([_, conf]) =>
            conf &&
            !conf.ended &&
            !conf.isMinimized &&
            conf.invitationStatus !== "rejected" &&
            (conf.invitationStatus === "accepted" || conf.showPreJoinScreen),
        )?.[0]
      : null;

  // Find minimized conference (for PiP view)
  $: minimizedConference =
    conferenceStore && $conferenceStore
      ? Object.entries($conferenceStore.data).find(
          ([_, conf]) =>
            conf &&
            !conf.ended &&
            conf.isMinimized &&
            (conf.isInitiator || conf.invitationStatus === "accepted"),
        )?.[0]
      : null;

  function minimizedPeerName(conf: (typeof $conferenceStore.data)[string]): string {
    if (!conf?.participants) return "In call";
    const all = profileStore ? $profileStore.data : {};
    for (const [pk, p] of conf.participants) {
      if (pk === myPubKeyB64 || !p.hasJoined) continue;
      for (const cellProfiles of Object.values(all)) {
        const fields = cellProfiles?.[pk]?.profile?.fields;
        if (fields) return `${fields.firstName || ""} ${fields.lastName || ""}`.trim() || "In call";
      }
    }
    return "In call";
  }

  // Track which conferences we've already logged to prevent duplicates
  // This is necessary because the ConferenceView component may unmount before its reactive
  // statement can fire (due to activeConference becoming null when ended: true)
  const loggedConferenceEnds = new Set<string>();

  $: if (conferenceStore && $conferenceStore) {
    for (const [roomId, conf] of Object.entries($conferenceStore.data)) {
      if (conf && conf.ended && conf.endedByMe) {
        handleConferenceEnded(roomId);
      }
    }
  }

  function handleCloseConference() {
    // Minimize the conference to PiP mode instead of closing
    if (activeConference) {
      console.log("[+layout] Minimizing conference:", activeConference);
      conferenceStore.setMinimized(activeConference, true);
    }
  }

  function handleMaximizeConference() {
    // Restore the conference from PiP to full view
    if (minimizedConference) {
      console.log("[+layout] Maximizing conference:", minimizedConference);
      conferenceStore.setMinimized(minimizedConference, false);
    }
  }

  async function handleConferenceEnded(roomId: string) {
    if (loggedConferenceEnds.has(roomId)) {
      console.log("[ConferenceLog] Already logged conference end for:", roomId);
      return;
    }
    loggedConferenceEnds.add(roomId);

    let conference;
    try {
      conference = conferenceStore.getConference(roomId);
    } catch (error) {
      console.warn("[ConferenceLog] Conference not found in store:", roomId);
      return;
    }

    if (
      !conference ||
      !conference.cellIdB64 ||
      !conference.startTime ||
      !conference.initiatorPubKeyB64
    ) {
      console.warn("[ConferenceLog] Cannot send ended log - missing metadata");
      return;
    }

    const durationSeconds = Math.floor((Date.now() - conference.startTime) / 1000);
    const allParticipants = Array.from(conference.participants.keys());

    try {
      await sendConferenceEndedLog(
        conversationMessageStore,
        conference.cellIdB64,
        roomId,
        conference.initiatorPubKeyB64,
        allParticipants,
        durationSeconds,
      );
      console.log("[ConferenceLog] Successfully sent conference ended log");
    } catch (error) {
      console.error("[ConferenceLog] Failed to send conference ended log:", error);
    }
  }

  async function initHolochainClient() {
    try {
      console.log("__HC_LAUNCHER_ENV__ is", window.__HC_LAUNCHER_ENV__);

      // Connect to holochain
      client = await AppWebsocket.connect({ defaultTimeout: 30000 });

      // Call 'ping' with very long timeout
      // This should be the first zome call after the client connects,
      // as subsequent zome calls will be much faster and can use the default timeout.
      console.log("Awaiting relay cell launch");
      await client.callZome(
        {
          role_name: ROLE_NAME,
          zome_name: ZOME_NAME,
          fn_name: "ping",
          payload: null,
        },

        // 5m timeout
        5 * 60 * 1000,
      );
      const appInfo = await client.appInfo();
      if (appInfo === null) throw new Error("Failed to get appInfo");
      console.log("Relay cell ready. App Info is ", appInfo);

      // Get provisioned relay CellId
      const provisionedRelayCellInfo = appInfo.cell_info[ROLE_NAME].find(
        (c) => c.type === CellType.Provisioned,
      );
      if (provisionedRelayCellInfo === undefined)
        throw new Error("Failed to get CellInfo for cell 'relay'");
      provisionedRelayCellId = provisionedRelayCellInfo.value.cell_id;
      provisionedRelayCellIdB64 = encodeCellIdToBase64(provisionedRelayCellId);

      isClientConnected = true;
      console.log("Connected");
    } catch (e) {
      isClientConnectionFailed = true;
      console.error("Failed to init holochain", e);
      // toast.error(`${$t("common.holochain_connect_error")}: ${e}`);
      throw e;
    }
  }

  async function initStores() {
    try {
      // Setup stores
      relayClient = new RelayClient(client, provisionedRelayCellId);
      myPubKeyB64 = encodeHashToBase64(client.myPubKey);
      contactStore = createContactStore(relayClient);
      profileStore = createProfileStore(relayClient);
      provisionedRelayCellProfileStore = deriveCellProfileStore(
        profileStore,
        provisionedRelayCellIdB64,
      );
      inviteStore = createInviteStore();
      mergedProfileContactInviteStore = createMergedProfileContactInviteStore(
        profileStore,
        contactStore,
        inviteStore,
      );
      conversationStore = createConversationStore(relayClient);
      fileStore = createFileStore(relayClient);
      conversationMessageStore = createConversationMessageStore(
        relayClient,
        conversationStore,
        mergedProfileContactInviteStore,
        fileStore,
      );
      conversationLatestMessageStore = createConversationLatestMessageStore(
        conversationStore,
        conversationMessageStore,
      );
      mergedProfileContactInviteUnjoinedStore = createMergedProfileContactInviteUnjoinedStore(
        profileStore,
        inviteStore,
        mergedProfileContactInviteStore,
      );
      mergedProfileContactInviteJoinedStore = createMergedProfileContactInviteJoinedStore(
        profileStore,
        inviteStore,
        mergedProfileContactInviteStore,
      );
      conversationTitleStore = createConversationTitleStore(
        conversationStore,
        mergedProfileContactInviteStore,
        myPubKeyB64,
      );
      conferenceStore = createSimplePeerConferenceStore(relayClient);

      setupCallNotifications(
        async (roomId, cellIdB64) => {
          const active = conferenceStore.getMyActiveCall();
          if (active && active.roomId !== roomId) return;
          if (cellIdB64) await goto(`/conversations/${cellIdB64}`);
          conferenceStore.setMinimized(roomId, false);
          conferenceStore.setShowPreJoinScreen(roomId, true);
        },
        (roomId) => {
          conferenceStore.rejectConferenceInvitation(roomId).catch((e) => {
            console.error("[Layout] Failed to reject call from notification:", e);
          });
        },
      );

      // Initialize network stats store
      networkStatsStore = createNetworkStatsStore(client, relayClient);
      networkStatsStore.start();

      // Initialize store data
      await contactStore.initialize();
      await profileStore.initialize();
      await conversationStore.initialize();
      await conversationMessageStore.initialize();

      // Initialize signal handler
      createSignalHandler(
        relayClient,
        conversationStore,
        conversationMessageStore,
        conferenceStore,
        onlinePeers,
      );

      isStoresSetup = true;
    } catch (e) {
      console.error("Failed to init stores", e);
      toast.error(`${$t("common.stores_setup_error")}: ${e}`);
    }
  }

  // Track when app was backgrounded (for detecting Android Doze scenarios)
  let lastBackgroundTime = 0;

  async function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      lastBackgroundTime = Date.now();
      console.log(`[visibility] backgrounded at ${lastBackgroundTime}`);
      return;
    }

    const now = Date.now();
    const backgroundDurationMs = now - lastBackgroundTime;
    const backgroundDurationMin = Math.round(backgroundDurationMs / 1000 / 60);
    const isLikelyDoze = backgroundDurationMs > 10 * 60 * 1000;

    if (isLikelyDoze) {
      console.log(
        `[visibility] [doze] Reloading app after ${backgroundDurationMin} minute(s) in background...`,
      );
      window.location.reload();
      return;
    }
  }

  async function setupApp() {
    initLightDarkModeSwitcher();
    await initHolochainClient();
    await initStores();
  }

  onMount(async () => {
    await setupApp();
    document.addEventListener("visibilitychange", handleVisibilityChange);
  });

  onDestroy(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  onDestroy(() => {
    conferenceStore?.cleanupAll();
    networkStatsStore?.stop();
  });

  setContext("myPubKey", {
    getMyPubKey: () => client.myPubKey,
    getMyPubKeyB64: () => myPubKeyB64,
  });

  setContext("provisionedRelayCellId", {
    getCellId: () => provisionedRelayCellId,
    getCellIdB64: () => provisionedRelayCellIdB64,
  });

  setContext("profileStore", {
    getStore: () => profileStore,
    getProvisionedRelayCellProfileStore: () => provisionedRelayCellProfileStore,
  });

  setContext("contactStore", {
    getStore: () => contactStore,
  });

  setContext("mergedProfileContactInviteStore", {
    getStore: () => mergedProfileContactInviteStore,
  });

  setContext("mergedProfileContactInviteJoinedStore", {
    getStore: () => mergedProfileContactInviteJoinedStore,
  });

  setContext("mergedProfileContactInviteUnjoinedStore", {
    getStore: () => mergedProfileContactInviteUnjoinedStore,
  });

  setContext("conversationStore", {
    getStore: () => conversationStore,
  });

  setContext("fileStore", {
    getStore: () => fileStore,
  });

  setContext("conversationTitleStore", {
    getStore: () => conversationTitleStore,
  });

  setContext("conversationMessageStore", {
    getStore: () => conversationMessageStore,
  });

  setContext("conversationLatestMessageStore", {
    getStore: () => conversationLatestMessageStore,
  });

  setContext("inviteStore", {
    getStore: () => inviteStore,
  });

  setContext("conferenceStore", {
    getStore: () => conferenceStore,
  });

  setContext("networkStatsStore", {
    getStore: () => networkStatsStore,
  });

  setContext("onlinePeers", {
    getStore: () => onlinePeers,
  });

  setContext("relayClient", {
    getClient: () => relayClient,
  });
</script>

<div class="mx-auto flex h-screen w-full max-w-screen-lg flex-col items-center">
  {#if isClientConnected && isStoresSetup && myProfileExists}
    <slot />
  {:else if isClientConnected && isStoresSetup && !myProfileExists && !isUserCreatingProfile}
    <AppLanding>
      <Button
        icon="lock"
        on:click={() => (isUserCreatingProfile = true)}
        moreClasses="!font-normal"
      >
        {$t("common.create_an_account")}
      </Button>
    </AppLanding>
  {:else if isClientConnected && isStoresSetup && !myProfileExists && isUserCreatingProfile && profileCreateInput.firstName === ""}
    <ProfileSetupName bind:value={profileCreateInput} />
  {:else if isClientConnected && isStoresSetup && !myProfileExists && isUserCreatingProfile && profileCreateInput.firstName.length >= MIN_FIRST_NAME_LENGTH}
    <ProfileSetupAvatar bind:value={profileCreateInput} />
  {:else if isClientConnected && !isStoresSetup}
    <AppLanding>
      {$t("common.stores_setup")}
    </AppLanding>
  {:else}
    <AppLanding>
      {$t("common.connecting_to_holochain")}
    </AppLanding>
  {/if}
</div>

{#if isStoresSetup && conferenceStore}
  <div
    class="pointer-events-none fixed inset-x-0 top-0 flex justify-center px-2 pt-[max(0.6rem,env(safe-area-inset-top))] sm:justify-end sm:px-4"
    style="z-index: 55;"
  >
    <IncomingCallBanner />
  </div>
{/if}

{#if activeConference}
  <ConferenceView
    roomId={activeConference}
    onClose={handleCloseConference}
    onConferenceEnded={handleConferenceEnded}
    showPreJoin={true}
  />
{/if}

{#if minimizedConference}
  {@const conf = $conferenceStore.data[minimizedConference]}
  <div class="pointer-events-none fixed inset-0" style="z-index: 50;">
    <ResizablePip
      initialWidth={180}
      initialHeight={135}
      minWidth={120}
      minHeight={90}
      maxWidth={320}
      maxHeight={240}
      persistKey="conference-pip-position"
      on:click={handleMaximizeConference}
    >
      <div
        class="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-secondary-800 shadow-2xl ring-1 ring-white/10"
      >
        {#if conf?.localStream}
          <!-- svelte-ignore a11y-media-has-caption -->
          <video
            autoplay
            playsinline
            muted
            class="h-full w-full object-cover"
            use:setVideoStream={conf.localStream}
          />
        {:else}
          <div class="text-xs text-tertiary-500">In call</div>
        {/if}

        {#if conf?.participants}
          {@const participantCount = Array.from(conf.participants.values()).filter(
            (p) => p.hasJoined,
          ).length}
          <div
            class="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-1 text-[11px] font-medium text-white"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-success-500"></span>
            {Math.max(participantCount, 1)} in call
          </div>
        {/if}

        <div
          class="absolute bottom-2 left-2 truncate rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white"
        >
          {conf ? minimizedPeerName(conf) : "In call"}
        </div>

        <div
          class="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white"
        >
          <SvgIcon icon="expand" moreClasses="h-4 w-4" />
        </div>
      </div>
    </ResizablePip>
  </div>
{/if}

<Toaster position="bottom-end" />

<Dialog title="Failed to Connect" open={isClientConnectionFailed}>
  <p>Failed to connect to Holochain.</p>

  <div class="mt-8 flex items-center justify-center">
    <Button on:click={() => window.location.reload()}>Relaunch App</Button>
  </div>
</Dialog>
