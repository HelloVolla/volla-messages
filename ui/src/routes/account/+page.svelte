<script lang="ts">
  import { getContext, onMount } from "svelte";
  import { QRCodeImage } from "svelte-qrcode-image";
  import Header from "$lib/Header.svelte";
  import { t } from "$translations";
  import toast from "svelte-french-toast";
  import { MIN_FIRST_NAME_LENGTH } from "$config";
  import ButtonsCopyShare from "$lib/ButtonsCopyShare.svelte";
  import ProfileNameInput from "./ProfileNameInput.svelte";
  import type { AgentPubKeyB64 } from "@holochain/client";
  import ButtonIconBare from "$lib/ButtonIconBare.svelte";
  import InputImageAvatar from "$lib/InputImageAvatar.svelte";
  import { type CellProfileStore, type ProfileStore } from "$store/ProfileStore";
  import Button from "$lib/Button.svelte";
  import DialogConfirm from "$lib/DialogConfirm.svelte";
  import { canExportLogs, exportLogs, isLite } from "$lib/logsExport";

  const profileStore = getContext<{ getStore: () => ProfileStore }>("profileStore").getStore();
  const provisionedRelayCellProfileStore = getContext<{
    getProvisionedRelayCellProfileStore: () => CellProfileStore;
  }>("profileStore").getProvisionedRelayCellProfileStore();
  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();

  $: myProfileExtended = $provisionedRelayCellProfileStore.data[myPubKeyB64];

  let saving = false;
  let editingName = false;

  let logsExportable = false;
  let lite = false;
  let showExportLogsDialog = false;
  let exportingLogs = false;

  onMount(async () => {
    logsExportable = await canExportLogs();
    lite = await isLite();
  });

  async function handleExportLogs() {
    // Close the note first: the save dialog opens on top of the app.
    showExportLogsDialog = false;
    exportingLogs = true;
    try {
      if (await exportLogs($t("common.export_logs"))) {
        toast.success($t("common.export_logs_success"));
      }
    } catch (e) {
      console.error("[logs] export failed", e);
      toast.error(`${$t("common.export_logs_error")}: ${e}`);
    }
    exportingLogs = false;
  }

  async function save(firstNameVal: string, lastNameVal: string, avatarVal: string) {
    if (firstNameVal.length < MIN_FIRST_NAME_LENGTH) return;
    if (saving) return;

    saving = true;
    try {
      await profileStore.updateProfile({
        firstName: firstNameVal,
        lastName: lastNameVal,
        avatar: avatarVal,
      });
    } catch (e) {
      toast.error(`${$t("common.update_profile_error")}: ${e.message}`);
    }
    saving = false;
    editingName = false;
  }
</script>

<Header back />

<div class="flex w-full grow flex-col items-center">
  <InputImageAvatar
    value={myProfileExtended.profile.fields.avatar}
    loading={saving}
    disabled={saving}
    on:change={(e) =>
      save(
        myProfileExtended.profile.fields.firstName,
        myProfileExtended.profile.fields.lastName,
        e.detail,
      )}
  />

  <div class="mb-10 flex flex-row items-center justify-center py-2">
    {#if editingName}
      <ProfileNameInput
        initialFirstName={myProfileExtended.profile.fields.firstName}
        initialLastName={myProfileExtended.profile.fields.lastName}
        on:save={(e) =>
          save(e.detail.firstName, e.detail.lastName, myProfileExtended.profile.fields.avatar)}
        on:cancel={() => (editingName = false)}
        disabled={saving}
        loading={saving}
      />
    {:else}
      <h1 class="mr-2 flex-shrink-0 text-3xl">
        {myProfileExtended.profile.nickname}
      </h1>

      <ButtonIconBare
        on:click={() => (editingName = true)}
        disabled={saving}
        icon="write"
        moreClasses="text-gray-500"
      />
    {/if}
  </div>

  <QRCodeImage text={myPubKeyB64} width={7} />

  <p
    class="text-secondary-400 dark:text-tertiary-700 mb-4 mt-8 w-64 overflow-hidden text-ellipsis text-nowrap"
  >
    {myPubKeyB64}
  </p>

  <div class="mb-8">
    <ButtonsCopyShare
      text={myPubKeyB64}
      copyLabel={$t("common.copy_your_contact_code")}
      shareLabel={$t("common.share_your_contact_code")}
    />
  </div>

  {#if logsExportable}
    <div class="mb-8">
      <Button
        icon="download"
        loading={exportingLogs}
        disabled={exportingLogs}
        on:click={() => (showExportLogsDialog = true)}
      >
        {$t("common.export_logs")}
      </Button>
    </div>
  {/if}
</div>

<DialogConfirm
  bind:open={showExportLogsDialog}
  title={$t("common.export_logs")}
  actionButtonLabel={$t("common.export_logs_confirm")}
  actionButtonIcon="download"
  on:confirm={handleExportLogs}
>
  <p>{$t("common.export_logs_message")}</p>
  {#if lite}
    <p class="mt-2">{$t("common.export_logs_lite_message")}</p>
  {/if}
</DialogConfirm>
