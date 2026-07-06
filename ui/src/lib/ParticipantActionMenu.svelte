<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { t } from "$translations/index";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let isOpen: boolean = false;
  export let canKick: boolean = false;

  const dispatch = createEventDispatcher<{
    toggle: void;
    kick: void;
  }>();
</script>

{#if canKick}
  <div class="relative" transition:fade={{ duration: 150 }}>
    <button
      on:click|stopPropagation={() => dispatch("toggle")}
      class="flex h-8 w-8 items-center justify-center rounded-lg bg-black/40 text-white/80 backdrop-blur-md transition-all duration-200 hover:bg-black/60 hover:text-white active:scale-95"
      aria-label="Participant options"
    >
      <SvgIcon icon="moreVert" moreClasses="h-5 w-5" />
    </button>

    {#if isOpen}
      <div
        class="absolute right-0 top-full z-50 mt-1 min-w-[180px] origin-top-right overflow-hidden rounded-xl bg-secondary-500 shadow-xl ring-1 ring-black/20"
        transition:scale={{ duration: 150, start: 0.9, easing: cubicOut }}
      >
        <button
          on:click={() => dispatch("kick")}
          class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-primary-500 transition-colors hover:bg-secondary-400"
        >
          <SvgIcon icon="userRemove" moreClasses="h-4 w-4" />
          {$t("common.conference_removeFromCall") || "Remove from call"}
        </button>
      </div>
    {/if}
  </div>
{/if}
