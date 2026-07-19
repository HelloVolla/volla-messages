<script lang="ts">
  import Avatar from "$lib/Avatar.svelte";
  import type { ParticipantData } from "./types";

  export let participants: ParticipantData[] = [];
  export let getName: (pubKey: string) => string = () => "Unknown";
  export let cellIdB64: string | undefined = undefined;
  export let connecting: boolean = false;

  type Status = "joined" | "declined" | "ringing";
  function statusOf(p: ParticipantData): Status {
    if (p.declined) return "declined";
    if (p._connected || p.hasJoined) return "joined";
    return "ringing";
  }
  function statusText(s: Status): string {
    return s === "joined" ? "Joined" : s === "declined" ? "Declined" : "Ringing";
  }

  $: single = participants.length === 1;
  $: primary = participants[0];
  $: joinedCount = participants.filter((p) => statusOf(p) === "joined").length;
  $: ringingCount = participants.filter((p) => statusOf(p) === "ringing").length;
</script>

<div class="flex h-full w-full flex-col justify-center px-8">
  {#if single && primary}
    {@const s = statusOf(primary)}
    <div class="h-[9px] w-[9px] rounded-full bg-primary-500 opacity-45"></div>

    <p class="mt-8 text-[32px] font-bold leading-tight tracking-tight text-tertiary-100">
      {getName(primary.pubKey)}
    </p>

    <p class="mt-2 flex items-center gap-2 text-[15px] text-tertiary-900">
      {#if connecting}
        <span class="h-[5px] w-[5px] animate-pulse rounded-full bg-tertiary-900"></span>
        <span>Connecting</span>
      {:else if s === "declined"}
        <span>Declined</span>
      {:else if s === "joined"}
        <span class="h-[5px] w-[5px] rounded-full bg-success-500"></span>
        <span class="text-success-500">Joined</span>
      {:else}
        <span class="h-[5px] w-[5px] animate-pulse rounded-full bg-tertiary-900"></span>
        <span>Ringing</span>
      {/if}
    </p>
  {:else}
    <p class="text-[22px] font-bold leading-tight tracking-tight text-tertiary-100">Group call</p>
    <p class="mt-1 text-[13px] text-tertiary-900">
      {joinedCount} joined · {ringingCount} ringing
    </p>

    <div class="mt-7">
      {#each participants as p (p.pubKey)}
        {@const s = statusOf(p)}
        <div class="flex items-center gap-3 border-b border-white/5 py-2.5 last:border-0">
          <div class={s === "declined" ? "opacity-50" : ""}>
            <Avatar agentPubKeyB64={p.pubKey} size={32} {cellIdB64} />
          </div>
          <span
            class="flex-1 truncate text-sm {s === 'declined'
              ? 'text-tertiary-900'
              : 'text-tertiary-200'}"
          >
            {getName(p.pubKey)}
          </span>
          <span
            class="flex items-center gap-1.5 text-xs {s === 'joined'
              ? 'text-success-500'
              : 'text-tertiary-900'}"
          >
            {#if s === "ringing"}
              <span class="h-1 w-1 animate-pulse rounded-full bg-tertiary-900"></span>
            {:else if s === "joined"}
              <span class="h-1 w-1 rounded-full bg-success-500"></span>
            {/if}
            {statusText(s)}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
