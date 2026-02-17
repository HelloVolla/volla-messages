<script lang="ts">
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";
  import type { ActionHashB64 } from "@holochain/client";
  import type { MessageExtended, CellIdB64 } from "$lib/types";
  import BaseMessage from "./Message.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { afterUpdate, beforeUpdate, createEventDispatcher, onMount, tick } from "svelte";

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

  const MESSAGE_FIXED_HEIGHT = 80; //Increased from 40 to 80 (more realistic average)
  const UPDATE_TRIGGER_VIEW_OFFSET = 250;
  const BUFFER_COUNT = 10;

  let virtualizer = createVirtualizer({
    count: chronologicalMessages?.length,
    getScrollElement: () => containerEl,
    estimateSize: () => MESSAGE_FIXED_HEIGHT,
    overscan: BUFFER_COUNT,
    useAnimationFrameWithResizeObserver: true,
  });
  // Update virtualizer count when messages change
  $: if ($virtualizer) $virtualizer.setOptions({ count: chronologicalMessages?.length });

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

  onMount(async () => {
    if (chronologicalMessages.length > 0 && containerEl) {
      isAtBottom = true;
      wasAtBottom = true;
      isAtTop = false;
      wasAtTop = false;

      await scrollToBottom();
    }
  });

  // to resolve glitch when (fetching older msgs from hc + loading msgs to store from localDB)
  let previousScrollHeight = 0;
  let previousItemCount = 0;
  let shouldMaintainScroll = false;
  let isFirstFetch = true;


  beforeUpdate(() => {
    // only capture the scrollHeight if a maintenance request is active.
    if (shouldMaintainScroll && containerEl) {
      previousScrollHeight = containerEl.scrollHeight;
    }
  });

  // applying manual scroll maintainance
  afterUpdate(() => {
    if (shouldMaintainScroll && containerEl) {
      shouldMaintainScroll = false;

      const newScrollHeight = containerEl.scrollHeight;
      
      // The magic number (20 * 40 = 800px) was wrong when fewer/more messages loaded
      const actualLoadedCount = chronologicalMessages.length - previousItemCount;
      const estimatedHeightAdded = actualLoadedCount * MESSAGE_FIXED_HEIGHT;

      const heightDifference =
        newScrollHeight - previousScrollHeight + (!isFirstFetch ? estimatedHeightAdded : 0);

      if (isFirstFetch) isFirstFetch = false;

      containerEl.scrollTop = heightDifference;
    }
  });

  //Debounced scroll handler to prevent excessive reactive updates
  let scrollCheckTimeout: ReturnType<typeof setTimeout> | null = null;
  
  function checkScrollPosition() {
    if (!containerEl || !initialScrollReady) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;

    isAtBottom = scrollBottom < 5;
    isAtTop = scrollTop <= UPDATE_TRIGGER_VIEW_OFFSET;

    // Trigger fetch when reaching top (debounced automatically by the timeout)
    if (isAtTop && !wasAtTop && !loadingTop) {
      shouldMaintainScroll = true;
      dispatch("scrollAtTop");
    }

    wasAtBottom = isAtBottom;
    wasAtTop = isAtTop;
  }
  
  // Listen to scroll events with debouncing
  $: if (containerEl) {
    const handleScroll = () => {
      if (scrollCheckTimeout) clearTimeout(scrollCheckTimeout);
      scrollCheckTimeout = setTimeout(checkScrollPosition, 150); // 150ms debounce
    };
    
    containerEl.addEventListener('scroll', handleScroll, { passive: true });
  }

  // logic for newly_added_items-scroll-down logic
  $: {
    const currentItemCount = chronologicalMessages.length;

    if (containerEl && initialScrollReady && wasAtBottom && currentItemCount > previousItemCount) {
      scrollToBottom("smooth");
    }

    previousItemCount = currentItemCount;
  }

  async function scrollToBottom(behavior?: "auto" | "smooth") {
    await waitForListLoad();

    const lastIndex = chronologicalMessages.length - 1;
    if (lastIndex < 0) return;

    // Proper scroll to bottom without hacks
    // Wait for all measurements to complete
    await waitForMeasurements();
    
    // Scroll to actual last item using proper alignment
    $virtualizer.scrollToIndex(lastIndex, {
      align: "end", // Use "end" alignment for last item
      behavior,
    });

    // Wait for scroll to complete
    await tick();
    
    // Verify we reached bottom, force if needed
    if (containerEl) {
      const { scrollTop, scrollHeight, clientHeight } = containerEl;
      const scrollBottom = scrollHeight - scrollTop - clientHeight;
      
      if (scrollBottom > 5) {
        // Still not at bottom, force scroll
        containerEl.scrollTop = scrollHeight;
      }
    }

    requestAnimationFrame(() => {
      initialScrollReady = true;
    });
  }

  async function waitForMeasurements() {
    return new Promise<void>((resolve) => {
      const check = () => {
        const items = $virtualizer.getVirtualItems();
        // Check if virtualizer has measured items with actual sizes
        const hasMeasurements = items.length > 0 && items.every(item => item.size > 0);
        
        if (hasMeasurements || items.length === 0) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
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
  style={`overflow-anchor: none; opacity: ${initialScrollReady ? 1 : 0}; transition: opacity 200ms ease-in-out;`}
>
  <!-- Fixed Conversation Header (not virtualized) -->
  <div class="flex h-4 items-center justify-center"></div>
  <ConversationHeader {cellIdB64} />
  <div class="flex h-4 items-center justify-center"></div>

  <!-- Loading indicator when fetching older messages -->
  {#if loadingTop}
    <div class="flex h-12 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
    </div>
  {/if}

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