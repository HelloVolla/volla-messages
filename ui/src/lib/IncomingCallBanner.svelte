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

  async function declineCall(roomId: string) {
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
      <p class="truncate text-sm font-bold text-tertiary-100">
        {getCallerName(call.invitedBy)}
      </p>
      <p class="truncate text-xs text-tertiary-900">Incoming call</p>
    </div>

    <button
      on:click={() => acceptCall(call.roomId, call.cellIdB64)}
      class="flex h-[38px] flex-shrink-0 items-center gap-2 rounded-full bg-primary-500 px-4 text-[13.5px] font-bold text-white transition-colors hover:bg-primary-600"
    >
      <SvgIcon icon="phone" moreClasses="h-4 w-4" />
      <span>Accept</span>
    </button>

    <button
      on:click={() => declineCall(call.roomId)}
      class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-tertiary-900 transition-colors hover:bg-white/10 hover:text-tertiary-500"
      aria-label="Decline"
    >
      <SvgIcon icon="close" moreClasses="h-4 w-4" />
    </button>
  </div>
{/each}
