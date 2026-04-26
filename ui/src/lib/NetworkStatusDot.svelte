<script lang="ts">
  import type { TransportStats } from "@holochain/client";

  export let connectionCount: number = 0;
  export let onClick: (() => void) | undefined = undefined;

  $: status =
    connectionCount > 0 ? "connected" : "disconnected";
  $: color =
    status === "connected"
      ? "bg-green-500"
      : "bg-red-500";
  $: title =
    status === "connected"
      ? `${connectionCount} connection${connectionCount !== 1 ? "s" : ""}`
      : "Disconnected";
</script>

<button
  class="relative flex items-center justify-center rounded-full p-1"
  on:click={onClick}
  {title}
>
  <span class="relative flex h-2.5 w-2.5">
    {#if status === "connected"}
      <span
        class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-50"
        style="animation-duration: 3s"
      ></span>
    {/if}
    <span class="relative inline-flex h-2.5 w-2.5 rounded-full {color}"></span>
  </span>
</button>
