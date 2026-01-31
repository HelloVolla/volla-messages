<script lang="ts">
  import toast from "svelte-french-toast";
  import ButtonInline from "$lib/ButtonInline.svelte";
  import { copyToClipboard, isMobile, shareText } from "./utils";
  import { t } from "$translations";

  export let text: string;
  export let copyLabel: string;
  export let shareLabel: string;

  async function copy() {
    try {
      await copyToClipboard(text);
      toast.success(`${$t("common.copy_success")}`);
    } catch (e) {
      toast.error(`${$t("common.copy_error")}: ${e.message}`);
    }
  }

  async function share() {
    try {
      await shareText(text);
    } catch (e) {
      toast.error(`${$t("common.share_code_error")}: ${e.message}`);
    }
  }
</script>

<div class="flex shrink-0 items-center justify-center gap-1 sm:gap-2">
  <ButtonInline
    on:click={copy}
    icon="copy"
    iconSize="h-[18px] w-[18px] sm:h-[24px] sm:w-[24px]"
    moreClassesButton="h-7 sm:h-8 px-2 sm:px-3 text-xs !space-x-1 sm:!space-x-2"
  >
    <span class="hidden truncate sm:inline">{copyLabel}</span>
  </ButtonInline>

  {#if isMobile()}
    <ButtonInline
      on:click={share}
      icon="share"
      iconSize="h-[18px] w-[18px] sm:h-[24px] sm:w-[24px]"
      moreClassesButton="h-7 sm:h-8 px-2 sm:px-3 text-xs !space-x-1 sm:!space-x-2"
    >
      <span class="hidden truncate sm:inline">{shareLabel}</span>
    </ButtonInline>
  {/if}
</div>
