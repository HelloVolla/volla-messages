<script lang="ts">
  import {
    scan,
    cancel,
    checkPermissions,
    requestPermissions,
    openAppSettings,
    Format,
  } from "@tauri-apps/plugin-barcode-scanner";
  import Button from "$lib/Button.svelte";
  import { t } from "$translations";
  import { scanStore } from "$store/ScanStore";
  import { getPlatform } from "$lib/utils";
  import { onDestroy } from "svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import toast from "svelte-french-toast";

  let needsPermission = false;
  const isAndroid = getPlatform() === "android";
  const usesWindowedOverlay = !isAndroid;

  async function ensurePermissions() {
    try {
      let permissionsState = await checkPermissions();
      if (permissionsState === "granted") return;

      permissionsState = await requestPermissions();
      if (permissionsState === "granted") return;
    } catch (e) {
      // Do not abort scan flow here. On some custom Android plugin setups,
      // permission helper calls can fail while invoke scan() still works and
      // reports permission status from native side.
      console.error("check/request permissions error", e);
      toast.error($t("common.camera_permission_error"));
    }

    needsPermission = true;
  }

  async function executeScan() {
    try {
      // Our Android-local ZXing implementation currently renders reliably in fullscreen mode.
      // Keep windowed mode for other platforms that support transparent webview overlay.
      const res = await scan({ windowed: usesWindowedOverlay, formats: [Format.QRCode] });
      scanStore.complete(res.content);
    } catch (e) {
      if (String(e).includes("cancelled")) {
        scanStore.complete();
        return;
      }
      console.error("executeScan error", e);
      toast.error($t("common.scan_error"));
    }
  }

  async function scanCancel() {
    try {
      await cancel();
    } catch (e) {
      console.error(e);
    }
    scanStore.complete();
  }

  async function load() {
    await ensurePermissions();
    await executeScan();
  }

  load();

  function setBackgroundColor(backgroundColor: string): () => void {
    // Save current bg color
    const current = document.body.style["background-color" as any];
    const reset = () => (document.body.style["background-color" as any] = current);

    // Update bg color
    document.body.style["background-color" as any] = backgroundColor;

    return reset;
  }

  // For platforms using windowed overlay mode (e.g. iOS), the scanner runs behind
  // the webview so we need a transparent body to expose camera preview.
  // Android currently runs scanner fullscreen (windowed=false), so this is unnecessary there.
  let resetBackgroundColor: (() => void) | undefined;
  if (usesWindowedOverlay) {
    resetBackgroundColor = setBackgroundColor("transparent");
  }

  onDestroy(() => {
    resetBackgroundColor?.();
  });
</script>

{#if $scanStore.isSupported}
  <div class="fixed left-0 top-0 z-10 h-screen w-screen text-black">
    <div class="flex h-screen w-screen flex-col items-center justify-center">
      <!-- Scanning Area -->
      <div class="shadow-full h-64 w-64 rounded-lg border-2 border-solid border-white">
        {#if needsPermission}
          <div class="flex h-full w-full items-center justify-center">
            <SvgIcon icon="warning" moreClasses="w-[120px] h-[120px]" />
          </div>
        {/if}
      </div>

      <!-- Action Buttons -->
      {#if needsPermission}
        <div class="mt-4">
          <p class="text-error-500 mt-2 text-sm">
            {$t("common.need_camera_permission")}
          </p>
        </div>
      {/if}

      <div class="my-8 flex items-center justify-center space-x-4">
        <Button on:click={() => scanCancel()}>
          {$t("common.cancel")}
        </Button>

        {#if needsPermission}
          <Button
            on:click={() => {
              scanCancel();
              openAppSettings();
            }}
          >
            {$t("common.open_app_settings")}
          </Button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .shadow-full {
    box-shadow: 0 0 0 100vh rgba(0, 0, 0, 0.7);
  }
</style>
