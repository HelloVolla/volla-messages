<script lang="ts">
  import { Alignment } from "$lib/types";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let moreClasses = "";
  export let moreClassesButton = "";
  export let loading = false;
  export let icon: string | undefined = undefined;
  export let iconAlign: Alignment = Alignment.Left;
  export let iconSize: string = "h-[24px] w-[24px]";
</script>

<button
  class="bg-tertiary-500 text-tertiary-900 dark:bg-secondary-500 dark:text-tertiary-400 flex h-12 cursor-pointer items-center space-x-4 rounded-full px-5 py-2 font-bold disabled:opacity-50
  {iconAlign === Alignment.Left ? 'flex-row' : 'flex-row-reverse'}
  {moreClassesButton}"
  on:click
  {...$$restProps}
>
  {#if loading}
    <SvgIcon icon="spinner" size={iconSize} moreClasses="text-primary-500 {moreClasses}" />
  {:else if icon !== undefined}
    <SvgIcon {icon} size={iconSize} moreClasses="text-primary-500 {moreClasses}" />
  {/if}

  <span class="inline-flex items-center">
    <slot />
  </span>
</button>
