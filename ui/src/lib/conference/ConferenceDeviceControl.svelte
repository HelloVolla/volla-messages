<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let kind: "audio" | "video";
  export let icon: string;
  export let iconOff: string;
  export let active: boolean = false; // muted / video off
  export let label: string = "";
  export let title: string = "";
  export let menuTitle: string = "";
  export let currentDeviceId: string = "";
  export let menuAlign: "left" | "center" | "right" = "center";

  const dispatch = createEventDispatcher<{
    toggle: void;
    switchDevice: { kind: "audio" | "video"; deviceId: string };
  }>();

  const wantedKind = kind === "audio" ? "audioinput" : "videoinput";

  let devices: MediaDeviceInfo[] = [];
  let open = false;
  let root: HTMLElement;

  async function loadDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === wantedKind && d.deviceId);
    } catch {
      devices = [];
    }
  }

  function select(deviceId: string) {
    open = false;
    dispatch("switchDevice", { kind, deviceId });
  }

  function onDocPointer(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
    document.addEventListener("pointerdown", onDocPointer, true);
  });
  onDestroy(() => {
    navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
    document.removeEventListener("pointerdown", onDocPointer, true);
  });

  $: menuPosition =
    menuAlign === "left"
      ? "left-0"
      : menuAlign === "right"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";
</script>

<div class="relative flex flex-col items-center gap-1" bind:this={root}>
  <div class="relative">
    <button
      on:click={() => dispatch("toggle")}
      {title}
      aria-label={label}
      aria-pressed={active}
      class="flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-secondary-400 text-white transition-all hover:scale-105 hover:bg-secondary-300 active:scale-95 md:h-14 md:w-14"
    >
      <SvgIcon
        icon={active ? iconOff : icon}
        moreClasses="h-[22px] w-[22px] md:h-6 md:w-6 {active ? 'text-primary-500' : ''}"
      />
    </button>

    {#if devices.length > 1}
      <button
        class="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-secondary-200 text-secondary-900 shadow-md transition-colors hover:bg-white"
        aria-label={menuTitle ? `Change ${menuTitle.toLowerCase()}` : "Change device"}
        on:click={() => (open = !open)}
      >
        <SvgIcon icon="caretDown" moreClasses="h-3 w-3 rotate-180" />
      </button>
    {/if}
  </div>

  <span class="text-[10px] font-medium text-tertiary-500 sm:text-xs">{label}</span>

  {#if open}
    <div
      class="absolute bottom-full z-40 mb-3 w-60 rounded-xl bg-secondary-600 p-1.5 shadow-2xl ring-1 ring-white/10 {menuPosition}"
    >
      {#if menuTitle}
        <p class="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-tertiary-500">
          {menuTitle}
        </p>
      {/if}
      {#each devices as d (d.deviceId)}
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary-500 {d.deviceId ===
          currentDeviceId
            ? 'text-success-500'
            : 'text-tertiary-200'}"
          on:click={() => select(d.deviceId)}
        >
          <SvgIcon
            icon={d.deviceId === currentDeviceId ? "checkMark" : icon}
            moreClasses="h-3.5 w-3.5 flex-shrink-0"
          />
          <span class="truncate">{d.label || menuTitle || "Device"}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
