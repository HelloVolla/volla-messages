<script lang="ts">
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";
  import type { ActionHashB64 } from "@holochain/client";
  import type { MessageExtended, CellIdB64 } from "$lib/types";
  import BaseMessage from "./Message.svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { LOAD_MORE_VIEWPORT } from "$config";
  import {
    afterUpdate,
    beforeUpdate,
    createEventDispatcher,
    onDestroy,
    onMount,
    tick,
  } from "svelte";

  const dispatch = createEventDispatcher<{
    scrollAtTop: null;
    scrollAtBottom: null;
  }>();

  export let messages: [ActionHashB64, MessageExtended][];
  export let cellIdB64: CellIdB64;
  export let loadingTop = false;

  let selected: ActionHashB64 | undefined;
  let containerEl: HTMLDivElement | null = null;
  let initialScrollReady = false;

  $: chronologicalMessages = messages;

  // Update virtualizer count when messages change
  $: if ($virtualizer) {
    $virtualizer.setOptions({ count: chronologicalMessages?.length });
  }
  const MESSAGE_FIXED_HEIGHT = 40;
  const UPDATE_TRIGGER_VIEW_OFFSET = 1000;
  const BUFFER_COUNT = 10;
  const SCROLL_DEBOUNCE_MS = 150; // Debounce scroll events to prevent multiple triggers

  let virtualizer = createVirtualizer({
    count: chronologicalMessages?.length,
    getScrollElement: () => containerEl,
    estimateSize: () => MESSAGE_FIXED_HEIGHT,
    overscan: BUFFER_COUNT,
    useAnimationFrameWithResizeObserver: true,
  });

  function measure(node: HTMLElement) {
    const index = Number(node.dataset.index);
    if (isNaN(index)) return;

    if (!$virtualizer) return;
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        $virtualizer.measureElement(node);
      });
    });

    observer.observe(node);

    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  let isAtBottom = true;
  let wasAtBottom = true;
  let isAtTop = false;
  let wasAtTop = false;
  let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollToBottomInProgress = false;
  let isMounted = false;
  let pendingInitialScroll = false;
  let revealFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(async () => {
    isMounted = true;
    isAtBottom = true;
    wasAtBottom = true;
    isAtTop = false;
    wasAtTop = false;

    // containerEl is now bound. Force the virtualizer to re-attach its ResizeObserver
    // to the scroll element — it was created before mount when containerEl was null.
    $virtualizer.setOptions({
      count: chronologicalMessages?.length ?? 0,
      getScrollElement: () => containerEl,
      estimateSize: () => MESSAGE_FIXED_HEIGHT,
      overscan: BUFFER_COUNT,
      useAnimationFrameWithResizeObserver: true,
    });
    // Force an immediate measurement cycle so virtual items are produced right away.
    $virtualizer.measure();

    if (pendingInitialScroll || chronologicalMessages.length > 0) {
      // Messages already available — scroll then reveal.
      pendingInitialScroll = false;
      await scrollToBottom();
    } else {
      // No messages yet — show the UI immediately (empty state is fine to show).
      // The reactive block will call scrollToBottom() when messages arrive.
      initialScrollReady = true;
    }

    // Safety net: if messages are still loading and scrollToBottom() never ran,
    // reveal the UI after 2s so the user never sees a permanently blank screen.
    revealFallbackTimer = setTimeout(() => {
      if (!initialScrollReady) initialScrollReady = true;
    }, 2000);
  });

  onDestroy(() => {
    clearTimeout(revealFallbackTimer);
    if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
  });

  let previousScrollHeight = 0;
  let previousScrollTop = 0;
  let previousItemCount = 0;
  let shouldMaintainScroll = false;
  // let isFirstFetch = true;
  let isRestoringScroll = false;
  let savedAnchor: { actionHash: ActionHashB64; offsetFromViewport: number } | null = null;

  beforeUpdate(() => {
    if (shouldMaintainScroll && containerEl && previousScrollHeight === 0) {
      previousScrollHeight = containerEl.scrollHeight;
      previousScrollTop = containerEl.scrollTop;
    }
  });

  /**
   * Capture the first visible message and its pixel offset from the viewport top.
   * Called right before dispatching scrollAtTop so data is fresh.
   */
  function captureScrollAnchor() {
    if (!containerEl || !$virtualizer) return;
    const { scrollTop } = containerEl;
    const virtualItems = $virtualizer.getVirtualItems();
    const firstVisible = virtualItems.find((item) => item.start + item.size > scrollTop);
    if (firstVisible && chronologicalMessages[firstVisible.index]) {
      savedAnchor = {
        actionHash: chronologicalMessages[firstVisible.index][0],
        offsetFromViewport: firstVisible.start - scrollTop,
      };
    }
  }

  afterUpdate(() => {
    // When new messages are loaded and loading spinner is gone, restore scroll position
    if (savedAnchor && !loadingTop && !isRestoringScroll) {
      restoreScrollPosition();
    }
  });

  /**
   * Restore scroll to the previously-visible message over multiple frames,
   * allowing the virtualizer to settle its measurements.
   */
  async function restoreScrollPosition() {
    if (!savedAnchor || !containerEl) return;

    const anchor = savedAnchor;
    isRestoringScroll = true;

    const targetIndex = chronologicalMessages.findIndex(([hash]) => hash === anchor.actionHash);

    if (targetIndex >= 0) {
      // Immediately jump close to the target
      $virtualizer.scrollToIndex(targetIndex, { align: "start" });

      // Fine-tune over several frames as the virtualizer measures real item sizes
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => requestAnimationFrame(r));

        const items = $virtualizer.getVirtualItems();
        const targetItem = items.find((item) => item.index === targetIndex);
        if (targetItem && containerEl) {
          containerEl.scrollTop = targetItem.start - anchor.offsetFromViewport;
        }
      }
    }

    savedAnchor = null;
    isRestoringScroll = false;
  }

  function handleScroll() {
    if (!containerEl || !initialScrollReady || isRestoringScroll) return;

    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;

    const isAtBottom = scrollBottom < 5;
    const isAtTop = scrollTop <= UPDATE_TRIGGER_VIEW_OFFSET;

    // Log how many messages are above the visible area (not yet scrolled into view)
    const virtualItems = $virtualizer.getVirtualItems();
    const firstVisibleItem = virtualItems.find((item) => item.start + item.size > scrollTop);
    const firstVisibleIndex = firstVisibleItem ? firstVisibleItem.index : 0;
    const totalMessages = chronologicalMessages?.length ?? 0;
    console.log(
      `[Scroll] ${firstVisibleIndex} of ${totalMessages} messages above viewport (scroll up to see)`,
    );

    // Trigger Infinite Scroll when fewer than LOAD_MORE_VIEWPORT messages remain above viewport
    if (firstVisibleIndex < LOAD_MORE_VIEWPORT && !loadingTop) {
      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);

      scrollDebounceTimer = setTimeout(() => {
        shouldMaintainScroll = true;
        captureScrollAnchor(); // Capture fresh anchor at dispatch time
        dispatch("scrollAtTop");
        scrollDebounceTimer = undefined;
      }, SCROLL_DEBOUNCE_MS);
    }

    wasAtBottom = isAtBottom;
    wasAtTop = isAtTop;
  }

  // logic for triggering fetch event, newly_added_items-scroll-down logic
  $: {
    const currentItemCount = chronologicalMessages?.length || 0;

    if (initialScrollReady && wasAtBottom && currentItemCount > previousItemCount) {
      scrollToBottom("smooth");
    }

    previousItemCount = currentItemCount;
  }

  async function scrollToBottom(behavior?: "auto" | "smooth") {
    await waitForListLoad();

    const lastIndex = chronologicalMessages.length - 1;
    if (lastIndex < 0) return;

    let attempts = 0;
    while (attempts < 5) {
      // making sure the initial scroll lands completely at bottom edge of the container
      $virtualizer.scrollToIndex(lastIndex + 999, {
        align: "start",
        behavior,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      attempts++;
    }

    requestAnimationFrame(() => {
      initialScrollReady = true;
    });
  }

  async function waitForListLoad() {
    await tick();

    return new Promise((resolve) => {
      const check = () => {
        const lastIndex = chronologicalMessages?.length - 1;

        if ($virtualizer.getVirtualItems().length > 0 && lastIndex >= 0) {
          resolve({});
        } else {
          requestAnimationFrame(check); // keep checking on next frame
        }
      };

      check();
    });
  }

  function handleClick(e: MouseEvent, actionHashB64: ActionHashB64) {
    e.stopPropagation();
    selected = selected === actionHashB64 ? undefined : isMobile() ? undefined : actionHashB64;
  }

  function handleClickOutside() {
    selected = undefined;
  }

  function handlePress(actionHashB64: ActionHashB64) {
    if (isMobile()) {
      selected = actionHashB64;
    }
  }

  function shouldShowDaySeparator(currentIndex: number) {
    if (currentIndex === 0) return true;

    const currentMsg = chronologicalMessages?.[currentIndex]?.[1];
    const prevMsg = chronologicalMessages?.[currentIndex - 1]?.[1];

    if (!currentMsg || !prevMsg) return true;

    return !isSameDay(new Date(currentMsg.timestamp / 1000), new Date(prevMsg.timestamp / 1000));
  }

  function shouldShowAuthor(currentIndex: number) {
    if (currentIndex === 0) return true;

    const currentMsg = chronologicalMessages[currentIndex][1];
    const prevMsg = chronologicalMessages[currentIndex - 1][1];

    if (!currentMsg || !prevMsg) return true;

    return (
      currentMsg.authorAgentPubKeyB64 !== prevMsg.authorAgentPubKeyB64 ||
      !isWithinFiveMinutes(
        new Date(currentMsg.timestamp / 1000),
        new Date(prevMsg.timestamp / 1000),
      )
    );
  }
</script>

<div
  class="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden"
  bind:this={containerEl}
  on:scroll={handleScroll}
  style={`overflow-anchor: none; ${initialScrollReady ? "opacity: 1" : "opacity: 0"}`}
>
  <div class="flex h-4 items-center justify-center"></div>
  <div class="flex h-4 items-center justify-center"></div>

  <!-- Loading indicator when fetching older messages (fixed height to avoid layout shift) -->
  <div
    class="flex h-12 items-center justify-center"
    style="visibility: {loadingTop ? 'visible' : 'hidden'}"
  >
    <div
      class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
    ></div>
  </div>

  <!-- This inner div effectively holds the virtualizer's content scroll height -->
  <div style="height: {$virtualizer.getTotalSize()}px; position: relative; width: 100%;">
    <!-- Virtualized message items -->
    {#each $virtualizer.getVirtualItems() as virtualRow (virtualRow.key)}
      {@const currentIndex = virtualRow.index}
      {@const [actionHashB64, messageExtended] = chronologicalMessages[currentIndex]}
      <div
        class="absolute left-0 top-0 w-full"
        style="transform: translateY({virtualRow.start}px);"
        data-index={virtualRow.index}
        use:measure
      >
        <div class="flex flex-shrink-0 flex-col">
          <!-- Day separator -->
          {#if shouldShowDaySeparator(currentIndex)}
            <div class="text-secondary-400 dark:text-secondary-300 my-4 px-4 text-center text-xs">
              {new Date(messageExtended.timestamp / 1000).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </div>
          {/if}

          <!-- Message content -->
          <div class="mt-3 px-4">
            <BaseMessage
              {cellIdB64}
              message={messageExtended}
              isSelected={selected === actionHashB64}
              showAuthor={shouldShowAuthor(currentIndex)}
              {actionHashB64}
              on:press={() => handlePress(actionHashB64)}
              on:click={(e) => handleClick(e, actionHashB64)}
              on:clickoutside={handleClickOutside}
              on:delete
            />
          </div>

          <!-- Padding at the very end of the chat -->
          {#if currentIndex === chronologicalMessages?.length - 1}
            <div class="flex h-4 items-center justify-center"></div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
