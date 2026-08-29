<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import SvgIcon from "$lib/SvgIcon.svelte";
  import { t } from "$translations";

  export let enabled: boolean = false;

  const dispatch = createEventDispatcher<{ toggle: void }>();
</script>

<li class="mb-2 flex flex-row items-center rounded-full p-2">
  <span class="inline-block flex h-10 w-10 items-center justify-center rounded-full bg-tertiary-500">
    <SvgIcon icon="speechBubble" moreClasses="text-primary-600 !w-4 !h-4" />
  </span>

  <span class="ml-4 flex-1 text-sm font-bold">{$t("common.thread_view")}</span>

  <button
    class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200
      {enabled ? 'bg-primary-500' : 'bg-secondary-400 dark:bg-secondary-600'}"
    on:click={() => dispatch("toggle")}
    aria-checked={enabled}
    role="switch"
  >
    <span
      class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200
        {enabled ? 'translate-x-6' : 'translate-x-1'}"
    />
  </button>
</li>
