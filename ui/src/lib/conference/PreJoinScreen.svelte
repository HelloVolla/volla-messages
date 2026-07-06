<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { fade } from "svelte/transition";
  import { t } from "$translations/index";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let callerName: string = "";

  const dispatch = createEventDispatcher<{
    join: { videoEnabled: boolean; audioEnabled: boolean };
    cancel: void;
  }>();

  let videoEnabled = true;
  let audioEnabled = true;
  let localStream: MediaStream | null = null;
  let videoElement: HTMLVideoElement;
  let audioLevel = 0;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let animationFrameId: number | null = null;
  let devices: MediaDeviceInfo[] = [];
  let selectedVideoDevice = "";
  let selectedAudioDevice = "";
  let isLoadingDevices = true;
  let permissionError = "";

  $: if (videoElement && localStream && videoEnabled) {
    videoElement.srcObject = localStream;
    videoElement.play().catch((e) => console.warn("[PreJoin] Video autoplay failed:", e));
  }

  onMount(async () => {
    await loadDevices();
    await initializeStream();
  });

  onDestroy(() => {
    cleanup();
  });

  async function loadDevices() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      tempStream.getTracks().forEach((track) => track.stop());

      devices = await navigator.mediaDevices.enumerateDevices();

      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      const audioDevices = devices.filter((d) => d.kind === "audioinput");

      if (videoDevices.length > 0) {
        selectedVideoDevice = videoDevices[0].deviceId;
      }
      if (audioDevices.length > 0) {
        selectedAudioDevice = audioDevices[0].deviceId;
      }

      isLoadingDevices = false;
    } catch (error) {
      console.error("[PreJoin] Error loading devices:", error);
      permissionError = "Camera/microphone permission denied. Please allow access to continue.";
      isLoadingDevices = false;
    }
  }

  async function initializeStream() {
    try {
      cleanup();

      const constraints: MediaStreamConstraints = {
        video: videoEnabled
          ? { deviceId: selectedVideoDevice ? { exact: selectedVideoDevice } : undefined }
          : false,
        audio: audioEnabled
          ? { deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined }
          : false,
      };

      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (videoElement && localStream) {
        videoElement.srcObject = localStream;
      }

      if (audioEnabled && localStream) {
        setupAudioMeter(localStream);
      }

      permissionError = "";
    } catch (error) {
      console.error("[PreJoin] Error initializing stream:", error);
      permissionError = "Failed to access camera/microphone. Please check permissions.";
    }
  }

  function setupAudioMeter(stream: MediaStream) {
    try {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function updateLevel() {
        if (!analyser) return;

        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        audioLevel = Math.min(100, (average / 128) * 100);

        animationFrameId = requestAnimationFrame(updateLevel);
      }

      updateLevel();
    } catch (error) {
      console.error("[PreJoin] Error setting up audio meter:", error);
    }
  }

  function cleanup() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyser = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    audioLevel = 0;
  }

  async function toggleVideo() {
    videoEnabled = !videoEnabled;

    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      if (videoEnabled && videoTracks.length === 0) {
        // Need to get a new stream with video
        await initializeStream();
      } else {
        videoTracks.forEach((track) => {
          track.enabled = videoEnabled;
        });
      }
    } else if (videoEnabled) {
      await initializeStream();
    }
  }

  async function toggleAudio() {
    audioEnabled = !audioEnabled;

    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = audioEnabled;
      });

      if (!audioEnabled) {
        audioLevel = 0;
      }
    }
  }

  async function handleDeviceChange(kind: "video" | "audio", deviceId: string) {
    if (kind === "video") {
      selectedVideoDevice = deviceId;
    } else {
      selectedAudioDevice = deviceId;
    }
    await initializeStream();
  }

  function handleJoin() {
    cleanup();
    dispatch("join", { videoEnabled, audioEnabled });
  }

  function handleCancel() {
    cleanup();
    dispatch("cancel");
  }

  $: videoDevices = devices.filter((d) => d.kind === "videoinput");
  $: audioDevices = devices.filter((d) => d.kind === "audioinput");
  $: hasAudio = audioLevel > 5;
</script>

<div
  class="fixed inset-0 z-50 overflow-y-auto bg-secondary-900 sm:flex sm:items-center sm:justify-center sm:bg-secondary-900/80 sm:p-4 sm:backdrop-blur-md"
  transition:fade={{ duration: 200 }}
>
  <div
    class="mx-auto flex min-h-full w-full max-w-md flex-col justify-center p-5 pt-[max(1.5rem,env(safe-area-inset-top))] sm:min-h-0 sm:rounded-3xl sm:bg-secondary-700 sm:p-6 sm:pt-6 sm:shadow-2xl"
  >
    <div class="mb-4 text-center">
      <h2 class="text-xl font-semibold text-white">Ready to join?</h2>
      <p class="mt-1 text-sm text-tertiary-500">
        {callerName ? `${callerName} is in the call` : "Set up your camera and microphone"}
      </p>
    </div>

    <div
      class="relative mb-4 aspect-[3/4] w-full overflow-hidden rounded-2xl bg-secondary-800 sm:aspect-video"
    >
      {#if videoEnabled && localStream}
        <video
          bind:this={videoElement}
          autoplay
          muted
          playsinline
          class="h-full w-full object-cover"
          style="transform: scaleX(-1);"
        >
          <track kind="captions" />
        </video>
      {:else}
        <div class="flex h-full w-full items-center justify-center">
          <div
            class="flex h-[clamp(56px,16vw,88px)] w-[clamp(56px,16vw,88px)] items-center justify-center rounded-full bg-secondary-600"
          >
            <SvgIcon icon="videocamOff" moreClasses="h-8 w-8 text-tertiary-500" />
          </div>
        </div>
      {/if}

      <div
        class="absolute bottom-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white"
      >
        You
      </div>

      <div class="absolute bottom-2 right-2 hidden gap-2 sm:flex">
        <button
          on:click={toggleAudio}
          aria-label={audioEnabled ? "Mute" : "Unmute"}
          class="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors {audioEnabled
            ? 'bg-black/50 hover:bg-black/70'
            : 'bg-primary-500 hover:bg-primary-600'}"
        >
          <SvgIcon icon={audioEnabled ? "mic" : "micOff"} moreClasses="h-5 w-5" />
        </button>
        <button
          on:click={toggleVideo}
          aria-label={videoEnabled ? "Stop video" : "Start video"}
          class="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors {videoEnabled
            ? 'bg-black/50 hover:bg-black/70'
            : 'bg-primary-500 hover:bg-primary-600'}"
        >
          <SvgIcon icon={videoEnabled ? "videocam" : "videocamOff"} moreClasses="h-5 w-5" />
        </button>
      </div>

      {#if permissionError}
        <div class="absolute inset-0 flex items-center justify-center bg-secondary-800/95 p-4">
          <div class="text-center">
            <SvgIcon icon="alertCircle" moreClasses="mx-auto h-12 w-12 text-error-500" />
            <p class="mt-3 text-sm text-tertiary-400">{permissionError}</p>
          </div>
        </div>
      {/if}

      {#if isLoadingDevices}
        <div class="absolute inset-0 flex items-center justify-center bg-secondary-800/95">
          <div class="text-center">
            <SvgIcon icon="spinner" moreClasses="mx-auto h-10 w-10 animate-spin text-primary-500" />
            <p class="mt-3 text-sm text-tertiary-400">Loading devices…</p>
          </div>
        </div>
      {/if}
    </div>

    <div class="mb-4">
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium text-tertiary-400">Microphone</span>
        <span class={hasAudio ? "text-success-500" : "text-tertiary-500"}>
          {hasAudio ? "Audio working" : "No audio"}
        </span>
      </div>
      <div class="mt-2 flex gap-1.5">
        {#each Array(6) as _, i}
          <div
            class="h-2 flex-1 rounded-full {audioEnabled && audioLevel > i * 16.6
              ? 'bg-success-500'
              : 'bg-secondary-500'}"
          ></div>
        {/each}
      </div>
    </div>

    {#if !isLoadingDevices && !permissionError}
      <div class="mb-5 flex flex-col gap-2 sm:flex-row">
        {#if videoDevices.length > 0}
          <div class="relative flex-1">
            <SvgIcon
              icon="videocam"
              moreClasses="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary-500"
            />
            <select
              aria-label="Camera"
              class="w-full appearance-none rounded-xl bg-secondary-500 py-2.5 pl-9 pr-8 text-sm text-tertiary-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
              bind:value={selectedVideoDevice}
              on:change={(e) => handleDeviceChange("video", e.currentTarget.value)}
            >
              {#each videoDevices as device}
                <option value={device.deviceId}>
                  {device.label || `Camera ${videoDevices.indexOf(device) + 1}`}
                </option>
              {/each}
            </select>
            <SvgIcon
              icon="caretDown"
              moreClasses="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary-500"
            />
          </div>
        {/if}

        {#if audioDevices.length > 0}
          <div class="relative flex-1">
            <SvgIcon
              icon="mic"
              moreClasses="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary-500"
            />
            <select
              aria-label="Microphone"
              class="w-full appearance-none rounded-xl bg-secondary-500 py-2.5 pl-9 pr-8 text-sm text-tertiary-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
              bind:value={selectedAudioDevice}
              on:change={(e) => handleDeviceChange("audio", e.currentTarget.value)}
            >
              {#each audioDevices as device}
                <option value={device.deviceId}>
                  {device.label || `Microphone ${audioDevices.indexOf(device) + 1}`}
                </option>
              {/each}
            </select>
            <SvgIcon
              icon="caretDown"
              moreClasses="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary-500"
            />
          </div>
        {/if}
      </div>
    {/if}

    <div class="mb-5 flex justify-center gap-3 sm:hidden">
      <button
        on:click={toggleAudio}
        aria-label={audioEnabled ? "Mute" : "Unmute"}
        class="flex h-12 w-12 items-center justify-center rounded-full text-white transition-colors {audioEnabled
          ? 'bg-secondary-500 hover:bg-secondary-400'
          : 'bg-primary-500 hover:bg-primary-600'}"
      >
        <SvgIcon icon={audioEnabled ? "mic" : "micOff"} moreClasses="h-5 w-5" />
      </button>
      <button
        on:click={toggleVideo}
        aria-label={videoEnabled ? "Stop video" : "Start video"}
        class="flex h-12 w-12 items-center justify-center rounded-full text-white transition-colors {videoEnabled
          ? 'bg-secondary-500 hover:bg-secondary-400'
          : 'bg-primary-500 hover:bg-primary-600'}"
      >
        <SvgIcon icon={videoEnabled ? "videocam" : "videocamOff"} moreClasses="h-5 w-5" />
      </button>
    </div>

    <div class="flex gap-3">
      <button
        on:click={handleCancel}
        class="h-12 flex-1 rounded-full bg-secondary-500 font-semibold text-tertiary-200 transition-colors hover:bg-secondary-400"
      >
        {$t("common.cancel")}
      </button>
      <button
        on:click={handleJoin}
        disabled={!!permissionError}
        class="flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-success-500 font-semibold text-white transition-colors hover:bg-success-600 disabled:opacity-50"
      >
        <SvgIcon icon="videoCall" moreClasses="h-5 w-5" />
        <span>Join call</span>
      </button>
    </div>
  </div>
</div>
