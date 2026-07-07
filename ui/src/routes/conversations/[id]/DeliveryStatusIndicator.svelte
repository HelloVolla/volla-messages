<script lang="ts">
  import SvgIcon from "$lib/SvgIcon.svelte";
  import { DeliveryStatus } from "$lib/types";

  export let status: DeliveryStatus;
  export let deliveredCount: number = 0;
  export let recipientCount: number = 0;

  $: showDouble =
    status === DeliveryStatus.DeliveredPartial || status === DeliveryStatus.DeliveredAll;
  $: colorClass =
    status === DeliveryStatus.DeliveredAll
      ? "text-primary-500"
      : "text-secondary-400 dark:text-secondary-300";
  $: showCount =
    status === DeliveryStatus.DeliveredPartial && recipientCount > 1;
</script>

<span
  class="inline-flex items-center gap-0.5 text-xxs {colorClass}"
  aria-label="delivery status {status}"
>
  <SvgIcon icon="checkMark" size="h-2.5 w-2.5" />
  {#if showDouble}
    <SvgIcon icon="checkMark" size="h-2.5 w-2.5" moreClasses="-ml-1" />
  {/if}
  {#if showCount}
    <span class="ml-0.5 text-xxs leading-none">{deliveredCount}/{recipientCount}</span>
  {/if}
</span>
