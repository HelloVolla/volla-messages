<script lang="ts">
  import Dialog from "$lib/Dialog.svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import { t } from "$translations";
  import type { CellIdB64 } from "$lib/types";
  import { createEventDispatcher } from "svelte";

  export let open = false;
  export let loading = false;
  export let conversations: { cellIdB64: CellIdB64; title: string }[] = [];

  const dispatch = createEventDispatcher<{ select: CellIdB64; cancel: null }>();
</script>

<Dialog bind:open title={$t("common.forward_to")}>
  {#if conversations.length === 0}
    <p class="text-secondary-300 py-4 text-center text-sm">
      {$t("common.no_conversations_to_forward")}
    </p>
  {:else}
    <ul class="-mx-2 max-h-72 overflow-y-auto">
      {#each conversations as { cellIdB64, title } (cellIdB64)}
        <li>
          <button
            class="hover:bg-tertiary-400 dark:hover:bg-secondary-500 flex w-full flex-row items-center gap-3 rounded-lg px-2 py-3 text-left disabled:opacity-50"
            disabled={loading}
            on:click={() => dispatch("select", cellIdB64)}
          >
            <span
              class="bg-tertiary-500 dark:bg-secondary-500 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
            >
              <SvgIcon icon="group" moreClasses="text-primary-500" size="h-[18px] w-[18px]" />
            </span>
            <span class="min-w-0 flex-1 truncate">{title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Dialog>
