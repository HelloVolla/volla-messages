<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade } from "svelte/transition";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let callerName: string = "";
  export let participantCount: number = 0;

  const dispatch = createEventDispatcher<{
    join: { videoEnabled: boolean; audioEnabled: boolean };
    cancel: void;
  }>();

  let videoEnabled = false;
  let audioEnabled = true;

  $: subtitle = participantCount > 2 ? `is calling · ${participantCount} people` : "is calling";

  function handleAccept() {
    dispatch("join", { videoEnabled, audioEnabled });
  }

  function handleLater() {
    dispatch("cancel");
  }
</script>

<div
  class="fixed inset-0 z-50 flex flex-col bg-black px-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]"
  transition:fade={{ duration: 200 }}
>
  <div class="flex min-h-0 flex-1 flex-col justify-center">
    <div class="h-[9px] w-[9px] rounded-full bg-primary-500"></div>

    <h2 class="mt-8 text-[32px] font-bold leading-tight tracking-tight text-tertiary-100">
      {callerName || "Unknown"}
    </h2>
    <p class="mt-2 text-[15px] text-tertiary-900">{subtitle}</p>

    <div class="mt-9 flex flex-wrap gap-2.5">
      <button
        on:click={() => (audioEnabled = !audioEnabled)}
        aria-pressed={audioEnabled}
        class="flex items-center gap-2 rounded-full border px-4 py-2 text-[12.5px] transition-colors {audioEnabled
          ? 'border-success-500/60 text-success-500 hover:border-success-500'
          : 'border-white/15 text-tertiary-900 hover:border-white/25'}"
      >
        <SvgIcon icon={audioEnabled ? "mic" : "micOff"} size="h-[13px] w-[13px]" />
        <span>{audioEnabled ? "Mic on" : "Mic off"}</span>
      </button>

      <button
        on:click={() => (videoEnabled = !videoEnabled)}
        aria-pressed={videoEnabled}
        class="flex items-center gap-2 rounded-full border px-4 py-2 text-[12.5px] transition-colors {videoEnabled
          ? 'border-success-500/60 text-success-500 hover:border-success-500'
          : 'border-white/15 text-tertiary-900 hover:border-white/25'}"
      >
        <SvgIcon icon={videoEnabled ? "videocam" : "videocamOff"} size="h-[13px] w-[13px]" />
        <span>{videoEnabled ? "Camera on" : "Camera off"}</span>
      </button>
    </div>
  </div>

  <div class="flex flex-shrink-0 items-center gap-5">
    <button
      on:click={handleAccept}
      aria-label="Accept call"
      class="flex h-[74px] w-[74px] flex-shrink-0 items-center justify-center rounded-full bg-primary-500 text-white transition-transform hover:bg-primary-600 active:scale-95"
    >
      <SvgIcon icon="phone" size="h-[27px] w-[27px]" />
    </button>
    <span class="text-[15px] font-bold text-tertiary-500">Accept</span>

    <button
      on:click={handleLater}
      class="ml-auto rounded-full px-3 py-2 text-[14.5px] text-tertiary-900 transition-colors hover:text-tertiary-500"
    >
      Later
    </button>
  </div>
</div>
