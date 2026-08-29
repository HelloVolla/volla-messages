<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { pan } from "svelte-gestures";
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let threshold = 52;
  export let reveal = 72;
  export let icon = "reply";
  export let disabled = false;
  export let direction: "left" | "right" = "right";

  const dispatch = createEventDispatcher<{ trigger: void }>();

  let x = 0;
  let startX = 0;
  let dragging = false;

  $: dir = direction === "left" ? -1 : 1;

  function handleDown(e: CustomEvent<{ x: number }>) {
    if (disabled) return;
    startX = e.detail.x;
    dragging = false;
  }

  function handlePan(e: CustomEvent<{ x: number }>) {
    if (disabled) return;
    const effective = dir * (e.detail.x - startX);
    if (effective > 6) {
      dragging = true;
      x = Math.min(effective * 0.6, reveal);
    } else {
      x = 0;
    }
  }

  function handleUp() {
    if (disabled) return;
    const fire = x >= threshold;
    x = 0;
    if (fire) dispatch("trigger");
    setTimeout(() => (dragging = false), 220);
  }

  function suppressClick(e: MouseEvent) {
    if (dragging) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  $: progress = disabled ? 0 : Math.min(x / threshold, 1);
</script>

<div class="relative">
  <div
    class="pointer-events-none absolute inset-y-0 flex items-center {direction === 'left'
      ? 'right-1'
      : 'left-1'}"
    style="opacity: {progress}"
    aria-hidden="true"
  >
    <div
      class="flex h-8 w-8 items-center justify-center rounded-full bg-primary-500/15"
      style="transform: scaleX({dir}) scale({0.7 + progress * 0.3})"
    >
      <SvgIcon {icon} moreClasses="h-4 w-4 text-primary-500" />
    </div>
  </div>

  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    use:pan={{ delay: 10 }}
    on:pandown={handleDown}
    on:pan={handlePan}
    on:panup={handleUp}
    on:click|capture={suppressClick}
    style="transform: translateX({dir * x}px); transition: {dragging
      ? 'none'
      : 'transform 220ms cubic-bezier(0.22,1,0.36,1)'}"
  >
    <slot />
  </div>
</div>
