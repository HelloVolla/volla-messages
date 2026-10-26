<script lang="ts">
  import toast from "svelte-french-toast";
  import { t } from "$translations";
  import {
    openReleasesPage,
    startUpdate,
    type AvailableUpdate,
  } from "$lib/updateNotice";

  /**
   * Red bar shown while a newer major version is available: contacts who
   * updated can no longer receive this user's messages. Never dismissible and
   * never blocking; the app stays fully usable.
   */
  export let update: AvailableUpdate;
  /** Final migration export, run before a desktop build replaces itself. */
  export let flushExports: () => Promise<void>;

  let updating = false;

  async function onUpdate() {
    updating = true;
    try {
      await startUpdate(update, flushExports);
    } catch (e) {
      console.error("[update] failed", e);
      toast.error($t("common.update_failed"));
      // A desktop install that could not complete: fall back to a download.
      await openReleasesPage().catch(() => {});
    } finally {
      updating = false;
    }
  }
</script>

<div
  role="alert"
  class="flex w-full items-center justify-between gap-3 bg-red-600 px-4 py-2 text-sm font-medium text-white"
>
  <span>{$t("common.update_bar_text", { version: update.version })}</span>
  <button
    class="shrink-0 rounded-full bg-white px-4 py-1 font-bold text-red-700 disabled:opacity-60"
    disabled={updating}
    on:click={onUpdate}
  >
    {updating ? $t("common.updating") : $t("common.update_now")}
  </button>
</div>
