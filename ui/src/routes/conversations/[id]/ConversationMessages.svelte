<script lang="ts">
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";
  import type { ActionHashB64 } from "@holochain/client";
  import { MessageType, type MessageExtended, type CellIdB64 } from "$lib/types";
  import BaseMessage from "./Message.svelte";
  import NoticeMessage from "./NoticeMessage.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { afterUpdate, createEventDispatcher, onMount, tick } from "svelte";

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

  const MESSAGE_FIXED_HEIGHT = 40;
  const UPDATE_TRIGGER_VIEW_OFFSET = 1000;
  const BUFFER_COUNT = 10;
  const SCROLL_DEBOUNCE_MS = 150;

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
  let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Scroll-anchor state for prepending older messages ──
  let anchorScrollTop = 0;
  let anchorScrollHeight = 0;
  let needsScrollAnchor = false;
  let previousItemCount = 0;
  // Track whether the previous loadingTop was true so we can detect the
  // transition from loading → done and apply the scroll anchor at that moment.
  let prevLoadingTop = false;

  onMount(async () => {
    if (chronologicalMessages.length > 0 && containerEl) {
      isAtBottom = true;
      wasAtBottom = true;
      await scrollToBottom();
    }
  });

  // ── Scroll-anchor restoration ──
  // We captured scrollTop / scrollHeight *before* the load started (no spinner,
  // fewer messages).  We restore when the load finishes (loadingTop transitions
  // true → false) so the spinner height cancels out and we only compensate for
  // the new messages that were prepended.
  //
  // IMPORTANT: needsScrollAnchor must be cleared *before* assigning scrollTop.
  // Setting scrollTop fires the scroll event synchronously in the browser.
  // If needsScrollAnchor were still true at that point, handleScroll would see
  // it and skip the debounce, leaving the user stranded in the trigger zone
  // without an automatic re-trigger for the next page.
  afterUpdate(() => {
    if (needsScrollAnchor && containerEl && prevLoadingTop && !loadingTop) {
      const newScrollHeight = containerEl.scrollHeight;
      const heightDiff = newScrollHeight - anchorScrollHeight;
      // Clear the flag first so the synchronous scroll event fired by the
      // scrollTop assignment below can start the next debounce immediately.
      needsScrollAnchor = false;
      if (heightDiff > 0) {
        containerEl.scrollTop = anchorScrollTop + heightDiff;
      }
    }
    prevLoadingTop = loadingTop;
  });

  function handleScroll() {
    if (!containerEl || !initialScrollReady) return;

    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;

    const atBottom = scrollBottom < 5;
    const atTop = scrollTop <= UPDATE_TRIGGER_VIEW_OFFSET;

    // Trigger infinite-scroll when near the top.
    // Guards: not already loading, no pending anchor restoration.
    if (atTop && !loadingTop && !needsScrollAnchor) {
      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);

      scrollDebounceTimer = setTimeout(() => {
        // Capture scroll state *before* the spinner appears or data loads
        if (containerEl) {
          anchorScrollTop = containerEl.scrollTop;
          anchorScrollHeight = containerEl.scrollHeight;
          needsScrollAnchor = true;
        }
        dispatch("scrollAtTop");
        scrollDebounceTimer = undefined;
      }, SCROLL_DEBOUNCE_MS);
    }

    wasAtBottom = atBottom;
  }

  // Auto-scroll to bottom when new messages arrive while the user was already
  // at the bottom (e.g. incoming message or own send).
  $: {
    const currentItemCount = chronologicalMessages?.length || 0;

    if (initialScrollReady && wasAtBottom && currentItemCount > previousItemCount && !needsScrollAnchor) {
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

    // Always show author after a system notice
    if (prevMsg.message.message_type === MessageType.System) return true;

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
          {#if messageExtended.message.message_type === MessageType.System}
            <NoticeMessage {cellIdB64} message={messageExtended} />
          {:else}
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
          {/if}

          <!-- Padding at the very end of the chat -->
          {#if currentIndex === chronologicalMessages?.length - 1}
            <div class="flex h-4 items-center justify-center"></div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
