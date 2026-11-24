<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { onBackButtonPress } from "@tauri-apps/api/app";
  import type { PluginListener } from "@tauri-apps/api/core";
  import { platform } from "@tauri-apps/plugin-os";
  import ButtonIconBare from "$lib/ButtonIconBare.svelte";

  export let back: boolean = false;
  export let backUrl: string | undefined = undefined;
  export let title: string | undefined = undefined;

  function gotoBack() {
    if (backUrl !== undefined) {
      goto(backUrl);
    } else {
      history.back();
    }
  }

  // Android's back gesture. Tauri's own handling asks the hidden splashscreen
  // web view whether it can go back; it has no history, so the gesture closed
  // the app from every page. A page with a back arrow takes the gesture over
  // and does what the arrow does. Pages without one register nothing, so
  // there the gesture still leaves the app.
  let backListener: PluginListener | undefined;
  let destroyed = false;

  onMount(async () => {
    if (backUrl === undefined && !back) return;
    try {
      if (platform() !== "android") return;
      const listener = await onBackButtonPress(() => gotoBack());
      if (destroyed) {
        await listener.unregister();
      } else {
        backListener = listener;
      }
    } catch (e) {
      console.warn("[back] could not take over the back gesture", e);
    }
  });

  onDestroy(() => {
    destroyed = true;
    backListener?.unregister().catch(() => {});
  });
</script>

<div class="flex w-full items-center">
  <div class="min-w-14 flex-none">
    <slot name="left">
      {#if backUrl !== undefined || back}
        <ButtonIconBare
          on:click={gotoBack}
          icon="caretLeft"
          moreClasses="!h-[16px] !w-[16px] text-base"
          moreClassesButton="p-4"
        />
      {/if}
    </slot>
  </div>

  <div class="flex grow items-center justify-center">
    <slot name="center">
      {#if title !== undefined}
        <h1 class="py-2">{title}</h1>
      {/if}
    </slot>
  </div>

  <div class="min-w-14 flex-none">
    <slot name="right"></slot>
  </div>
</div>
