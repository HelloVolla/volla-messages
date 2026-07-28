<script lang="ts">
  import SvgIcon from "$lib/SvgIcon.svelte";
  import { DeliveryStatus } from "$lib/types";

  export let status: DeliveryStatus;
  export let deliveredCount: number = 0;
  export let recipientCount: number = 0;

  $: delivered =
    status === DeliveryStatus.DeliveredPartial || status === DeliveryStatus.DeliveredAll;
  $: colorClass =
    status === DeliveryStatus.DeliveredAll
      ? "text-secondary-700 dark:text-tertiary-500"
      : "text-secondary-400 dark:text-secondary-300";
  $: showCount =
    status === DeliveryStatus.DeliveredPartial && recipientCount > 1;
</script>

<span
  class="ml-1 inline-flex translate-y-px items-center gap-0.5 align-middle text-xxs {colorClass}"
  aria-label="delivery status {status}"
>
  <SvgIcon
    icon={delivered ? "doubleCheck" : "checkMark"}
    size={delivered ? "h-2.5 w-[15.3px]" : "h-2.5 w-2.5"}
  />
  {#if showCount}
    <span class="ml-0.5 text-xxs leading-none">{deliveredCount}/{recipientCount}</span>
  {/if}
</span>
