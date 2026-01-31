<script lang="ts">
  import { svgIcons } from "$lib/svgIcons";

  export let icon: string;
  export let moreClasses: string = "";
  export let style: string = "";
  export let size: string = "h-[24px] w-[24px]";
</script>

<div class="inline-block {size} {moreClasses}" {style}>
  {@html svgIcons[icon]}
</div>
