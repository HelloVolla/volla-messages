<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "$translations/index";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let callDurationSeconds: number = 0;
  export let participantCount: number = 0;
  export let isGridView: boolean = false;
  export let title: string = "";
  export let status: string = "";

  const dispatch = createEventDispatcher<{
    toggleView: void;
    minimize: void;
  }>();

  function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  $: formatted = formatTime(callDurationSeconds);
  $: peopleLabel = `${participantCount} ${participantCount === 1 ? "person" : "people"}`;
</script>

<header
  class="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/5 px-4 pb-3 pt-[max(0.85rem,env(safe-area-inset-top))] sm:px-5 md:px-6"
>
  <div class="min-w-0">
    <p class="truncate text-[15px] font-semibold text-tertiary-100 sm:text-base">
      {title || "Call"}
    </p>
    <p class="truncate text-xs tabular-nums text-tertiary-900">
      {status || `${formatted} · ${peopleLabel}`}
    </p>
  </div>

  <div class="flex flex-shrink-0 items-center gap-2">
    <button
      on:click={() => dispatch("toggleView")}
      class="flex h-10 items-center gap-2 rounded-full bg-secondary-400 px-3.5 transition-colors hover:bg-secondary-300 active:scale-95"
      aria-label={isGridView
        ? $t("common.conference_switchToSpeaker")
        : $t("common.conference_switchToGrid")}
      title={isGridView
        ? $t("common.conference_switchToSpeaker")
        : $t("common.conference_switchToGrid")}
    >
      <SvgIcon icon={isGridView ? "user" : "gridView"} moreClasses="h-4 w-4 text-tertiary-200" />
      <span class="text-sm font-medium text-tertiary-200">
        {isGridView ? "Speaker" : "Grid"}
      </span>
    </button>

    <button
      on:click={() => dispatch("minimize")}
      class="flex h-10 w-10 items-center justify-center rounded-full bg-secondary-400 transition-colors hover:bg-secondary-300 active:scale-95"
      aria-label={$t("common.conference_minimize")}
      title={$t("common.conference_minimize")}
    >
      <SvgIcon icon="caretDown" moreClasses="h-5 w-5 text-tertiary-200" />
    </button>
  </div>
</header>
