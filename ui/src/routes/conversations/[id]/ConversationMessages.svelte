<script lang="ts">
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";
  import type { ActionHashB64 } from "@holochain/client";
  import type { MessageExtended, CellIdB64 } from "$lib/types";
  import BaseMessage from "./Message.svelte";
  import { createEventDispatcher, onMount } from "svelte";

  const dispatch = createEventDispatcher<{
    scrollAtTop: null;
    scrollAtBottom: null;
  }>();

  export let messages: [ActionHashB64, MessageExtended][];
  export let cellIdB64: CellIdB64;
  export let loadingTop = false;

  let selected: ActionHashB64 | undefined;
  let containerEl: HTMLDivElement | null = null;
  let scrollReady = false;

  // ===========================================
  // CONFIGURATION
  // ===========================================
  const SCROLL_TRIGGER_THRESHOLD = 1200; // Pixels from oldest messages to trigger loading (increased for fast scroll)
  const DEBOUNCE_MS = 150; // Reduced debounce for faster response

  // ===========================================
  // MESSAGE ORDER
  // Parent passes: messages={[...$messages.list].reverse()} which is [oldest...newest]
  // We reverse again to get [newest...oldest] so index 0 = newest
  // With flex-col-reverse, index 0 appears at the bottom (correct!)
  // ===========================================
  $: reversedMessages = [...messages].reverse();

  // ===========================================
  // SCROLL HANDLING
  // In flex-col-reverse:
  // - scrollTop = 0 means we're at the BOTTOM (newest messages visible)
  // - scrollTop increases as we scroll UP (toward older messages)
  // - maxScrollTop = scrollHeight - clientHeight = fully scrolled to TOP (oldest)
  // ===========================================
  let lastTriggerTime = 0;
  let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  function handleScroll() {
    if (!containerEl || !scrollReady) return;

    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const maxScrollTop = scrollHeight - clientHeight;

    // In flex-col-reverse:
    // - scrollTop = 0 means at BOTTOM (newest messages)
    // - scrollTop goes NEGATIVE as you scroll UP toward older messages
    // - At oldest messages, scrollTop approaches -maxScrollTop
    // So distanceFromOldest = maxScrollTop + scrollTop (will be small when near oldest)
    const distanceFromOldest = maxScrollTop + scrollTop;
    const isNearOldest = distanceFromOldest <= SCROLL_TRIGGER_THRESHOLD;

    // Load older messages when scrolling near the oldest messages (top of visual list)
    const now = Date.now();
    if (isNearOldest && !loadingTop && now - lastTriggerTime > DEBOUNCE_MS) {
      lastTriggerTime = now;
      dispatch("scrollAtTop");
    }

    // Also check when scrolling stops (for fast scroll detection)
    if (scrollEndTimer) clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => {
      checkAndTriggerLoad();
    }, 100);
  }

  // Check if we should load more messages (called after scroll stops or messages change)
  function checkAndTriggerLoad() {
    if (!containerEl || !scrollReady || loadingTop) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const maxScrollTop = scrollHeight - clientHeight;
    const distanceFromOldest = maxScrollTop + scrollTop;
    
    if (distanceFromOldest <= SCROLL_TRIGGER_THRESHOLD) {
      const now = Date.now();
      if (now - lastTriggerTime > DEBOUNCE_MS) {
        lastTriggerTime = now;
        dispatch("scrollAtTop");
      }
    }
  }

  // Re-check after messages change - if still near top and not loading, trigger again
  $: if (scrollReady && containerEl && messages.length > 0 && !loadingTop) {
    // Use tick to ensure DOM is updated before measuring
    setTimeout(() => {
      checkAndTriggerLoad();
    }, 100);
  }

  // ===========================================
  // MOUNT - No scrolling needed! Newest messages are already at bottom
  // ===========================================
  onMount(() => {
    
    if (containerEl) {
      containerEl.addEventListener("scroll", handleScroll, { passive: true });
    }

    // Small delay before enabling scroll detection
    setTimeout(() => {
      scrollReady = true;
      console.log("[MOUNT] Scroll detection enabled");
    }, 100);

    return () => {
      if (containerEl) {
        containerEl.removeEventListener("scroll", handleScroll);
      }
    };
  });

  // ===========================================
  // UTILITY FUNCTIONS
  // ===========================================
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

  // Messages are in reverse chronological order: index 0 = newest, index n-1 = oldest
  // Check the NEXT item in array (which is the PREVIOUS message chronologically)
  function shouldShowDaySeparator(index: number) {
    // index 0 = newest message, index n-1 = oldest message
    const currentMsg = reversedMessages?.[index]?.[1];
    const nextMsg = reversedMessages?.[index + 1]?.[1]; // This is chronologically BEFORE current

    if (!currentMsg) return false;

    // If there's no older message, this is the oldest - show its day
    if (!nextMsg) return true;

    // Show separator if current message is on a DIFFERENT day than the older message
    return !isSameDay(new Date(currentMsg.timestamp / 1000), new Date(nextMsg.timestamp / 1000));
  }

  function shouldShowAuthor(index: number) {
    const currentMsg = reversedMessages[index]?.[1];
    const nextMsg = reversedMessages[index + 1]?.[1]; // Chronologically BEFORE current

    if (!currentMsg) return true;
    if (!nextMsg) return true; // Oldest message always shows author

    // Show author if different from the previous message (chronologically)
    return (
      currentMsg.authorAgentPubKeyB64 !== nextMsg.authorAgentPubKeyB64 ||
      !isWithinFiveMinutes(
        new Date(currentMsg.timestamp / 1000),
        new Date(nextMsg.timestamp / 1000),
      )
    );
  }

  function getDayHeaderDate(index: number) {
    const msg = reversedMessages?.[index]?.[1];
    if (!msg) return null;
    return new Date(msg.timestamp / 1000);
  }
</script>

<div
  class="flex h-full w-full flex-col-reverse overflow-y-auto overflow-x-hidden"
  bind:this={containerEl}
  style="overflow-anchor: auto;"
>
  <!-- 
    FLEX-COL-REVERSE LAYOUT:
    - First items in DOM appear at the BOTTOM of the container
    - scrollTop = 0 means bottom (newest) is visible
    - Scrolling up increases scrollTop, showing older messages
    - No auto-scroll needed on page load!
  -->

  <!-- Messages list (index 0 = newest, rendered at bottom due to flex-col-reverse) -->
  <div class="flex flex-col-reverse">
    {#each reversedMessages as [actionHashB64, messageExtended], index (actionHashB64)}
      {@const isOldestMessage = index === reversedMessages.length - 1}

      <div class="flex flex-shrink-0 flex-col">
        <!-- Day separator - shown ABOVE the oldest message of each day -->
        {#if shouldShowDaySeparator(index)}
          {@const dayDate = getDayHeaderDate(index)}
          {#if dayDate}
            <div class="text-secondary-400 dark:text-secondary-300 my-4 px-4 text-center text-xs">
              {dayDate.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </div>
          {/if}
        {/if}

        <!-- Message content -->
        <div class="mt-3 px-4">
          <BaseMessage
            {cellIdB64}
            message={messageExtended}
            isSelected={selected === actionHashB64}
            showAuthor={shouldShowAuthor(index)}
            {actionHashB64}
            on:press={() => handlePress(actionHashB64)}
            on:click={(e) => handleClick(e, actionHashB64)}
            on:clickoutside={handleClickOutside}
            on:delete
          />
        </div>

        <!-- Spacer at the oldest message (top of the visual list) -->
        {#if isOldestMessage}
          <div class="flex h-4 items-center justify-center"></div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Bottom spacer (appears at visual bottom due to flex-col-reverse) -->
  <div class="flex h-4 flex-shrink-0 items-center justify-center"></div>
</div>
