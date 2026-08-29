<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "$translations/index";
  import ConferenceControlButton from "$lib/ConferenceControlButton.svelte";
  import ConferenceDeviceControl from "./ConferenceDeviceControl.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let isMuted: boolean = false;
  export let isVideoEnabled: boolean = true;
  export let screenShareEnabled: boolean = false;
  export let isScreenSharing: boolean = false;
  export let audioDeviceId: string = "";
  export let videoDeviceId: string = "";
  export let leaveLabel: string = "Leave";

  const dispatch = createEventDispatcher<{
    toggleMute: void;
    toggleVideo: void;
    toggleScreenShare: void;
    endCall: void;
    switchDevice: { kind: "audio" | "video"; deviceId: string };
  }>();

  const isMac = typeof navigator !== "undefined" && navigator.platform?.includes("Mac");
  const screenShareSupported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

  $: muteLabel = isMuted ? "Unmute" : "Mute";
  $: videoLabel = isVideoEnabled ? "Stop video" : "Start video";
  $: shareLabel = isScreenSharing ? "Sharing" : "Share";
  $: muteShortcut = `${muteLabel} (${isMac ? "⌘" : "Ctrl"}+M)`;
  $: videoShortcut = `${videoLabel} (${isMac ? "⌘" : "Ctrl"}+V)`;
</script>

<footer
  class="relative z-40 flex flex-shrink-0 justify-center border-t border-white/5 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4"
>
  <div class="flex items-start gap-6 sm:gap-8">
    <ConferenceDeviceControl
      kind="audio"
      icon="mic"
      iconOff="micOff"
      active={isMuted}
      label={muteLabel}
      title={muteShortcut}
      menuTitle="Microphone"
      menuAlign="left"
      currentDeviceId={audioDeviceId}
      on:toggle={() => dispatch("toggleMute")}
      on:switchDevice
    />

    <ConferenceDeviceControl
      kind="video"
      icon="videocam"
      iconOff="videocamOff"
      active={!isVideoEnabled}
      label={videoLabel}
      title={videoShortcut}
      menuTitle="Camera"
      menuAlign="center"
      currentDeviceId={videoDeviceId}
      on:toggle={() => dispatch("toggleVideo")}
      on:switchDevice
    />

    {#if screenShareEnabled && screenShareSupported}
      <ConferenceControlButton
        icon="screenShare"
        active={isScreenSharing}
        showLabel
        label={shareLabel}
        title={isScreenSharing ? "Stop sharing" : "Share screen"}
        on:click={() => dispatch("toggleScreenShare")}
      />
    {/if}

    <div class="mx-1 hidden h-[52px] w-px self-start bg-white/10 sm:block md:h-14"></div>

    <div class="flex flex-col items-center gap-1">
      <button
        on:click={() => dispatch("endCall")}
        title="{$t('common.conference_endCall')} (Esc)"
        aria-label={leaveLabel}
        class="flex h-[52px] w-[52px] items-center justify-center gap-2 rounded-2xl bg-primary-500 text-white transition-all hover:scale-105 hover:bg-primary-600 active:scale-95 sm:w-auto sm:px-6 md:h-14"
      >
        <SvgIcon icon="callEnd" moreClasses="h-5 w-5 md:h-6 md:w-6" />
        <span class="hidden text-[15px] font-semibold sm:inline">{leaveLabel}</span>
      </button>
      <span class="text-[10px] font-medium text-tertiary-900 sm:hidden">{leaveLabel}</span>
    </div>
  </div>
</footer>
