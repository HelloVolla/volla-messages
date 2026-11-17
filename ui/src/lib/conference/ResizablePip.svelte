<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";

  export let initialWidth: number = 160;
  export let initialHeight: number = 120;
  export let boundsPadding: number = 16;
  export let persistKey: string | null = null;
  export let zIndex: number = 20;

  const dispatch = createEventDispatcher<{
    click: void;
    positionChange: { x: number; y: number };
  }>();

  const TAP_THRESHOLD = 6;
  const BOTTOM_RESERVED = 50;

  let container: HTMLDivElement;
  let x = 0;
  let y = 0;
  let mounted = false;

  let dragging = false;
  let moved = 0;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  function loadPersisted(): { x: number; y: number } | null {
    if (!persistKey) return null;
    try {
      const stored = localStorage.getItem(persistKey);
      return stored ? JSON.parse(stored) : null;
    } catch (e) {
      console.warn("[ResizablePip] Failed to load persisted state:", e);
      return null;
    }
  }

  function savePersisted() {
    if (!persistKey) return;
    try {
      localStorage.setItem(persistKey, JSON.stringify({ x, y }));
    } catch (e) {
      console.warn("[ResizablePip] Failed to save persisted state:", e);
    }
  }

  function clamp() {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    x = Math.max(boundsPadding, Math.min(rect.width - initialWidth - boundsPadding, x));
    y = Math.max(boundsPadding, Math.min(rect.height - initialHeight - boundsPadding - BOTTOM_RESERVED, y));
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startY = e.clientY;
    originX = x;
    originY = y;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    moved = Math.max(moved, Math.hypot(dx, dy));
    x = originX + dx;
    y = originY + dy;
    clamp();
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved < TAP_THRESHOLD) {
      dispatch("click");
    } else {
      savePersisted();
      dispatch("positionChange", { x, y });
    }
  }

  function onWindowResize() {
    clamp();
  }

  onMount(() => {
    const persisted = loadPersisted();
    if (container) {
      const rect = container.getBoundingClientRect();
      if (persisted) {
        x = persisted.x;
        y = persisted.y;
      } else {
        x = rect.width - initialWidth - boundsPadding;
        y = rect.height - initialHeight - boundsPadding - BOTTOM_RESERVED;
      }
      clamp();
    }
    mounted = true;
    window.addEventListener("resize", onWindowResize);
  });

  onDestroy(() => {
    window.removeEventListener("resize", onWindowResize);
  });
</script>

<div bind:this={container} class="absolute inset-0" style="z-index: {zIndex}; pointer-events: none;">
  {#if mounted}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="absolute cursor-move touch-none select-none"
      style="left: {x}px; top: {y}px; width: {initialWidth}px; height: {initialHeight}px; pointer-events: auto;"
      on:pointerdown={onPointerDown}
      on:pointermove={onPointerMove}
      on:pointerup={onPointerUp}
      on:pointercancel={onPointerUp}
    >
      <slot />
    </div>
  {/if}
</div>
