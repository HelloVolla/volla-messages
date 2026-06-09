<script lang="ts">
  import { getContext } from "svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import type { SimplePeerConferenceStore } from "$store/SimplePeerConferenceStore";
  import type { ProfileStore } from "$store/ProfileStore";
  import ButtonInline from "$lib/ButtonInline.svelte";

  const conferenceStore = getContext<{ getStore: () => SimplePeerConferenceStore }>(
    "conferenceStore",
  ).getStore();
  const profileStore = getContext<{ getStore: () => ProfileStore }>("profileStore").getStore();

  $: incomingCalls = Object.entries($conferenceStore?.data || {})
    .filter(([_, conf]) => conf && !conf.ended && conf.invitationStatus === "pending")
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

  async function declineCall(roomId: string) {
    try {
      await conferenceStore.rejectConferenceInvitation(roomId);
    } catch (error) {
      console.error("Failed to decline call:", error);
    }
  }
</script>

{#each incomingCalls as call (call.roomId)}
  <div class="pointer-events-auto w-full px-2 py-2 sm:px-4">
    <div
      class="mx-auto flex max-w-2xl items-center gap-2 rounded-2xl bg-zinc-800 px-3 py-2.5 shadow-lg sm:gap-3 sm:rounded-full sm:px-4 sm:py-3"
    >
      <div class="flex-shrink-0 rounded-full bg-zinc-700 p-2 sm:p-2.5">
        <svg
          class="h-4 w-4 text-zinc-300 sm:h-5 sm:w-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
          />
        </svg>
      </div>

      <div class="min-w-0 flex-1">
        <p class="truncate text-xs font-medium text-white sm:text-sm">
          {getCallerName(call.invitedBy)} is calling
        </p>
        <p class="text-[10px] text-zinc-400 sm:text-xs">Incoming call</p>
      </div>

      <ButtonInline
        moreClassesButton="flex-shrink-0 !bg-white hover:!bg-zinc-100 !text-black !h-8 !px-3 !py-1 !text-xs !min-w-0 sm:!h-9 sm:!px-4 sm:!py-1.5 sm:!text-sm"
        on:click={() => acceptCall(call.roomId, call.cellIdB64)}
      >
        Accept
      </ButtonInline>

      <button
        on:click={() => declineCall(call.roomId)}
        class="flex-shrink-0 rounded-full bg-red-500 p-2 text-white transition-colors hover:bg-red-600 sm:p-2.5"
        aria-label="Decline"
      >
        <svg class="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
{/each}
