<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade } from "svelte/transition";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let callerName: string = "";
  export let participantCount: number = 0;
  // The store's pre-join preview stream; adopted as the call's localStream on accept.
  export let localStream: MediaStream | null = null;

  const dispatch = createEventDispatcher<{
    join: { videoEnabled: boolean; audioEnabled: boolean };
    media: { videoEnabled: boolean; audioEnabled: boolean };
    cancel: void;
  }>();

  let videoEnabled = false;
  let audioEnabled = true;
  let videoEl: HTMLVideoElement;

  $: subtitle = participantCount > 2 ? `is calling · ${participantCount} people` : "is calling";
  $: if (videoEl && localStream) videoEl.srcObject = localStream;

  function emitMedia() {
    dispatch("media", { videoEnabled, audioEnabled });
  }

  function toggleAudio() {
    audioEnabled = !audioEnabled;
    emitMedia();
  }

  function toggleVideo() {
    videoEnabled = !videoEnabled;
    emitMedia();
  }

  function handleAccept() {
    dispatch("join", { videoEnabled, audioEnabled });
  }

  function handleLater() {
    dispatch("cancel");
  }
</script>

<div
  class="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black px-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]"
  transition:fade={{ duration: 200 }}
>
  {#if videoEnabled && localStream}
    <!-- svelte-ignore a11y-media-has-caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      muted
      class="absolute inset-0 h-full w-full object-cover"
      style="transform: scaleX(-1);"
    ></video>
    <div class="absolute inset-0 bg-gradient-to-b from-black/70 via-black/25 to-black/85"></div>
  {/if}

  <div class="relative z-10 flex min-h-0 flex-1 flex-col justify-center">
    <div class="h-[9px] w-[9px] rounded-full bg-primary-500"></div>

    <h2 class="mt-8 text-[32px] font-bold leading-tight tracking-tight text-tertiary-100">
      {callerName || "Unknown"}
    </h2>
    <p class="mt-2 text-[15px] {videoEnabled ? 'text-tertiary-300' : 'text-tertiary-900'}">
      {subtitle}
    </p>

    <div class="mt-9 flex flex-wrap gap-2.5">
      <button
        on:click={toggleAudio}
        aria-pressed={audioEnabled}
        class="flex items-center gap-2 rounded-full border px-4 py-2 text-[12.5px] transition-colors {audioEnabled
          ? 'border-success-500/60 text-success-500 hover:border-success-500'
          : 'border-white/15 text-tertiary-900 hover:border-white/25'}"
      >
        <SvgIcon icon={audioEnabled ? "mic" : "micOff"} size="h-[13px] w-[13px]" />
        <span>{audioEnabled ? "Mic on" : "Mic off"}</span>
      </button>

      <button
        on:click={toggleVideo}
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

  <div class="relative z-10 flex flex-shrink-0 items-center gap-3">
    <button
      on:click={handleAccept}
      class="flex h-14 items-center gap-2.5 rounded-full bg-success-500 px-7 text-base font-bold text-white transition-colors hover:bg-success-600 active:scale-95"
    >
      <SvgIcon icon="phone" size="h-5 w-5" />
      <span>Accept</span>
    </button>

    <button
      on:click={handleLater}
      aria-label="Cancel"
      class="flex h-14 w-14 items-center justify-center rounded-full text-primary-500 transition-colors hover:text-primary-600 active:scale-95"
    >
      <SvgIcon icon="close" size="h-5 w-5" />
    </button>
  </div>
</div>
