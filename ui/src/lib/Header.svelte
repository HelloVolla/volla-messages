<script lang="ts">
  import { goto } from "$app/navigation";
  import ButtonIconBare from "$lib/ButtonIconBare.svelte";

  export let back: boolean = false;
  export let backUrl: string | undefined = undefined;
  export let title: string | undefined = undefined;
  export let rail: string = "min-w-14";

  function gotoBack() {
    if (backUrl !== undefined) {
      goto(backUrl);
    } else {
      history.back();
    }
  }
</script>

<div class="flex w-full items-center">
  <div class="{rail} flex flex-none justify-start">
    <slot name="left">
      {#if backUrl !== undefined || back}
        <ButtonIconBare
          on:click={gotoBack}
          icon="caretLeft"
          moreClasses="!h-[16px] !w-[16px] text-base"
          moreClassesButton="p-4"
        />
      {/if}
    </slot>
  </div>

  <div class="flex min-w-0 grow items-center justify-center">
    <slot name="center">
      {#if title !== undefined}
        <h1 class="truncate py-2">{title}</h1>
      {/if}
    </slot>
  </div>

  <div class="{rail} flex flex-none justify-end">
    <slot name="right"></slot>
  </div>
</div>
