<script lang="ts">
  import { getContext } from "svelte";
  import { writable, type Writable } from "svelte/store";
  import type { AgentPubKeyB64 } from "@holochain/client";
  import type { CellIdB64, ConferenceLog } from "$lib/types";
  import Avatar from "$lib/Avatar.svelte";
  import AgentNickname from "$lib/AgentNickname.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let log: ConferenceLog;
  export let cellIdB64: CellIdB64;

  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();

  const endedIds: Writable<Set<string>> =
    getContext("endedConferenceIds") ?? writable(new Set<string>());

  $: isInitiator = log.initiator === myPubKeyB64;
  $: isStarted = log.event === "started";
  $: suppressed = isStarted && $endedIds.has(log.conference_id);

  function formatDuration(seconds?: number): string {
    if (!seconds) return "";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    if (secs === 0) return `${mins}m`;
    return `${mins}m ${secs}s`;
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const minutesStr = minutes < 10 ? "0" + minutes : minutes;
    return `${hours}:${minutesStr} ${ampm}`;
  }
</script>

{#if !suppressed}
  <div class="my-0.5 flex justify-center px-2">
    <div
      class="inline-flex w-fit max-w-full items-center gap-2 rounded-xl bg-tertiary-400 px-3 py-1.5 text-xs dark:bg-secondary-500"
    >
      <div class="flex flex-shrink-0 -space-x-2">
        {#each log.participants.slice(0, 3) as participantPubKey, i}
          <div
            class="relative rounded-full ring-2 ring-tertiary-400 dark:ring-secondary-500"
            style="z-index: {log.participants.length - i}"
          >
            <Avatar {cellIdB64} agentPubKeyB64={participantPubKey} size={22} />
          </div>
        {/each}
      </div>

      <div class="flex min-w-0 items-center gap-1.5 text-secondary-500 dark:text-tertiary-300">
        <span class="truncate font-semibold">
          {#if isInitiator}You{:else}<AgentNickname
              {cellIdB64}
              agentPubKeyB64={log.initiator}
            />{/if}
        </span>
        <span class="whitespace-nowrap text-secondary-400 dark:text-tertiary-500">
          {isStarted ? "started a call" : "hosted a call"}
        </span>
      </div>

      {#if !isStarted && log.duration_seconds}
        <span
          class="flex-shrink-0 rounded-full bg-secondary-500/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-secondary-500 dark:bg-white/10 dark:text-tertiary-300"
        >
          {formatDuration(log.duration_seconds)}
        </span>
      {:else if isStarted}
        <span
          class="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-semibold text-success-500"
        >
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-success-500"></span>Ongoing
        </span>
      {/if}

      <span
        class="ml-auto flex-shrink-0 whitespace-nowrap pl-1 text-secondary-400 dark:text-tertiary-500"
      >
        <SvgIcon
          icon="people"
          size="h-3 w-3"
          moreClasses="mb-px mr-0.5 inline-block align-middle"
        />{log.participant_count}
      </span>
      <span
        class="flex-shrink-0 whitespace-nowrap text-[11px] text-secondary-400 dark:text-tertiary-600"
      >
        {formatTime(log.timestamp)}
      </span>
    </div>
  </div>
{/if}
