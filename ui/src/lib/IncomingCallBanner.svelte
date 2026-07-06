<script lang="ts">
  import { getContext } from "svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import type { SimplePeerConferenceStore } from "$store/SimplePeerConferenceStore";
  import type { ProfileStore } from "$store/ProfileStore";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import Avatar from "$lib/Avatar.svelte";

  const conferenceStore = getContext<{ getStore: () => SimplePeerConferenceStore }>(
    "conferenceStore",
  ).getStore();
  const profileStore = getContext<{ getStore: () => ProfileStore }>("profileStore").getStore();

  let confirmDeclineRoomId: string | null = null;
  $: declineCallerName = confirmDeclineRoomId
    ? getCallerName($conferenceStore?.data?.[confirmDeclineRoomId]?.invitedBy)
    : "The caller";

  $: incomingCalls = Object.entries($conferenceStore?.data || {})
    .filter(
      ([_, conf]) =>
        conf && !conf.ended && conf.invitationStatus === "pending" && !conf.showPreJoinScreen,
    )
    .map(([roomId, conf]) => ({ roomId, ...conf }));

  function getCallerName(agentPubKeyB64: string | undefined): string {
    if (!agentPubKeyB64) return "Someone";

    const allProfiles = $profileStore.data;
    for (const cellProfiles of Object.values(allProfiles)) {
      const profileExtended = cellProfiles[agentPubKeyB64];
      if (profileExtended?.profile?.fields) {
        const firstName = profileExtended.profile.fields.firstName || "";
        const lastName = profileExtended.profile.fields.lastName || "";
        return `${firstName} ${lastName}`.trim() || "Someone";
      }
    }
    return "Someone";
  }

  async function acceptCall(roomId: string, cellIdB64: string | undefined) {
    const active = conferenceStore.getMyActiveCall();
    if (active && active.roomId !== roomId) {
      toast.error("You're already in a call");
      return;
    }
    if (cellIdB64) {
      await goto(`/conversations/${cellIdB64}`);
    }
    conferenceStore.setMinimized(roomId, false);
    conferenceStore.setShowPreJoinScreen(roomId, true);
  }

  async function confirmDecline() {
    const roomId = confirmDeclineRoomId;
    confirmDeclineRoomId = null;
    if (!roomId) return;
    try {
      await conferenceStore.rejectConferenceInvitation(roomId);
    } catch (error) {
      console.error("Failed to decline call:", error);
    }
  }
</script>

{#each incomingCalls as call (call.roomId)}
  <div
    class="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-secondary-500 px-3 py-3 shadow-2xl ring-1 ring-white/10 sm:w-[380px]"
  >
    <div class="flex-shrink-0">
      <Avatar agentPubKeyB64={call.invitedBy ?? ""} size={44} cellIdB64={call.cellIdB64} />
    </div>

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-tertiary-100">
        {getCallerName(call.invitedBy)}
      </p>
      <p class="truncate text-xs text-tertiary-500">Incoming video call…</p>
    </div>

    <button
      on:click={() => (confirmDeclineRoomId = call.roomId)}
      class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
      aria-label="Decline"
    >
      <SvgIcon icon="close" moreClasses="h-5 w-5" />
    </button>

    <button
      on:click={() => acceptCall(call.roomId, call.cellIdB64)}
      class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-success-500 text-white transition-colors hover:bg-success-600"
      aria-label="Accept"
    >
      <SvgIcon icon="videoCall" moreClasses="h-5 w-5" />
    </button>
  </div>
{/each}

{#if confirmDeclineRoomId !== null}
  <div class="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center px-6">
    <button
      class="absolute inset-0 bg-black/60"
      aria-label="Close"
      on:click={() => (confirmDeclineRoomId = null)}
    ></button>
    <div
      class="relative z-10 w-full max-w-xs rounded-3xl bg-secondary-700 p-6 text-center shadow-2xl"
    >
      <div
        class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-500/10"
      >
        <SvgIcon icon="callEnd" moreClasses="h-6 w-6 text-primary-500" />
      </div>
      <h3 class="text-lg font-semibold text-white">Decline this call?</h3>
      <p class="mb-6 mt-2 text-sm text-tertiary-500">
        {declineCallerName} will be told you declined.
      </p>
      <div class="flex flex-col-reverse gap-2.5 sm:flex-row sm:gap-3">
        <button
          on:click={() => (confirmDeclineRoomId = null)}
          class="h-12 flex-1 rounded-full bg-secondary-400 font-semibold text-tertiary-100 transition-colors hover:bg-secondary-300"
        >
          Cancel
        </button>
        <button
          on:click={confirmDecline}
          class="h-12 flex-1 rounded-full bg-primary-500 font-semibold text-white transition-colors hover:bg-primary-600"
        >
          Decline
        </button>
      </div>
    </div>
  </div>
{/if}
