<script lang="ts">
  import toast from "svelte-french-toast";
  import { t } from "$translations";
  import SvgIcon from "./SvgIcon.svelte";
  import Button from "./Button.svelte";
  import { copyToClipboard } from "./utils";
  import {
    deviceAdmission,
    recheckDeviceAdmission,
    type AdmissionStatus,
  } from "$store/DeviceAdmissionStore";

  const BLOCKING: AdmissionStatus[] = ["pending", "denied", "unavailable"];

  let shown: AdmissionStatus | undefined;

  $: if (BLOCKING.includes($deviceAdmission.status)) shown = $deviceAdmission.status;
  $: if ($deviceAdmission.status === "approved" || $deviceAdmission.status === "disabled")
    shown = undefined;
  $: checking = $deviceAdmission.status === "checking";

  async function copyCode() {
    if (!$deviceAdmission.deviceCode) return;
    try {
      await copyToClipboard($deviceAdmission.deviceCode);
      toast.success($t("common.copy_success"));
    } catch (e) {
      toast.error(`${$t("common.copy_error")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function checkAgain() {
    try {
      await recheckDeviceAdmission();
    } catch (e) {
      toast.error(String(e));
    }
  }
</script>

{#if shown}
  <div
    class="mt-3 flex w-[calc(100%-2rem)] max-w-md shrink-0 flex-col items-center rounded-xl bg-tertiary-500 p-4 dark:bg-secondary-500"
    role="status"
  >
    <SvgIcon
      icon={shown === "pending" ? "lock" : "alertTriangle"}
      moreClasses="h-[28px] w-[28px] text-primary-500"
    />
    <h1 class="mt-2 text-lg font-bold text-secondary-500 dark:text-tertiary-100">
      {$t(`common.device_admission_${shown}_title`)}
    </h1>
    <p class="mt-2 text-center text-sm text-secondary-400 dark:text-tertiary-700">
      {$t(`common.device_admission_${shown}_description`)}
    </p>

    {#if $deviceAdmission.deviceCode && shown !== "unavailable"}
      <button
        class="mt-3 flex max-w-full items-center gap-2 rounded-lg bg-black/5 px-3 py-2 font-mono text-xs text-secondary-500 dark:bg-white/10 dark:text-tertiary-100"
        title={$t("common.device_admission_copy_code")}
        on:click={copyCode}
      >
        <span class="truncate">{$deviceAdmission.deviceCode}</span>
        <SvgIcon icon="copy" size="h-[16px] w-[16px]" moreClasses="shrink-0" />
      </button>
    {/if}

    <Button
      on:click={checkAgain}
      disabled={checking}
      loading={checking}
      moreClasses="mt-4 px-3 text-sm bg-tertiary-600 dark:bg-secondary-700"
    >
      {checking
        ? $t("common.device_admission_checking")
        : $t("common.device_admission_check_again")}
    </Button>
  </div>
{/if}
