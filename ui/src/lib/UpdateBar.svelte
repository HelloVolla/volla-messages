<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import toast from "svelte-french-toast";
  import { t } from "$translations";
  import { openReleasePage, startUpdate, type AvailableUpdate } from "$lib/updateNotice";

  /**
   * Bar shown while a newer version is available. A major update is red and
   * cannot be dismissed: contacts who updated can no longer receive this
   * user's messages. A normal update is neutral and can be put off until the
   * next version. Neither blocks the app.
   */
  export let update: AvailableUpdate;
  /** Final migration export, run before a desktop build replaces itself. */
  export let flushExports: () => Promise<void>;

  const dispatch = createEventDispatcher<{ dismiss: void }>();
  let updating = false;

  async function onUpdate() {
    updating = true;
    try {
      await startUpdate(update, flushExports);
    } catch (e) {
      console.error("[update] failed", e);
      toast.error($t("common.update_failed"));
      // A desktop install that could not complete: fall back to a download.
      await openReleasePage(update).catch(() => {});
    } finally {
      updating = false;
    }
  }
</script>

<div
  role={update.major ? "alert" : "status"}
  class="flex w-full items-center justify-between gap-3 px-4 py-2 text-sm font-medium
    {update.major
    ? 'bg-red-600 text-white'
    : 'bg-tertiary-500 dark:bg-secondary-500 text-secondary-500 dark:text-tertiary-100'}"
>
  <span>
    {update.major
      ? $t("common.update_bar_text", { version: update.version })
      : $t("common.update_available_text", { version: update.version })}
  </span>
  <div class="flex shrink-0 items-center gap-2">
    {#if !update.major}
      <button class="px-2 py-1 underline" on:click={() => dispatch("dismiss")}>
        {$t("common.update_later")}
      </button>
    {/if}
    <button
      class="rounded-full px-4 py-1 font-bold disabled:opacity-60
        {update.major ? 'bg-white text-red-700' : 'bg-primary-500 text-white'}"
      disabled={updating}
      on:click={onUpdate}
    >
      {updating ? $t("common.updating") : $t("common.update_now")}
    </button>
  </div>
</div>
