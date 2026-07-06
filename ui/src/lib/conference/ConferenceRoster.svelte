<script lang="ts">
  import Avatar from "$lib/Avatar.svelte";
  import type { ParticipantData } from "./types";

  export let participants: ParticipantData[] = [];
  export let getName: (pubKey: string) => string = () => "Unknown";
  export let cellIdB64: string | undefined = undefined;

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
</script>

<div class="flex h-full w-full flex-col items-center justify-center gap-8 px-6">
  {#if single && primary}
    {@const s = statusOf(primary)}
    <div class="flex flex-col items-center gap-6">
      <div class="relative flex items-center justify-center">
        <span class="absolute h-44 w-44 rounded-full bg-tertiary-100/[0.04] blur-2xl"></span>
        <Avatar agentPubKeyB64={primary.pubKey} size={128} {cellIdB64} />
      </div>
      <div class="flex flex-col items-center gap-2 text-center">
        <p class="text-3xl font-semibold text-tertiary-100">{getName(primary.pubKey)}</p>
        <p class="flex items-center gap-2 text-sm text-tertiary-500">
          {#if s === "declined"}
            <span class="text-tertiary-400">Declined the call</span>
          {:else if s === "joined"}
            <span class="h-1.5 w-1.5 rounded-full bg-success-500"></span>Joined
          {:else}
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-tertiary-500"></span>Ringing…
          {/if}
        </p>
      </div>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-4">
      <div class="flex -space-x-3">
        {#each participants.slice(0, 4) as p (p.pubKey)}
          <div class="rounded-full ring-4 ring-secondary-900">
            <Avatar agentPubKeyB64={p.pubKey} size={48} {cellIdB64} />
          </div>
        {/each}
      </div>
      <p class="text-lg font-semibold text-tertiary-100">Waiting for others to join</p>
    </div>

    <div class="w-full max-w-xs">
      {#each participants as p (p.pubKey)}
        {@const s = statusOf(p)}
        <div class="flex items-center gap-3 border-b border-white/5 py-3 last:border-0">
          <Avatar agentPubKeyB64={p.pubKey} size={30} {cellIdB64} />
          <span class="flex-1 truncate text-sm text-tertiary-200">{getName(p.pubKey)}</span>
          <span
            class="flex items-center gap-1.5 text-xs
            {s === 'joined'
              ? 'text-success-500'
              : s === 'declined'
                ? 'text-tertiary-500'
                : 'text-tertiary-400'}"
          >
            {#if s === "ringing"}
              <span class="h-1 w-1 animate-pulse rounded-full bg-tertiary-500"></span>
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
