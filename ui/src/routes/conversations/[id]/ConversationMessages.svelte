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

  // A conservatively large estimated height. Real heights are measured
  // by ResizeObserver; this value only affects the very first render frame.
  const MESSAGE_ESTIMATED_HEIGHT = 80;
  // How close to the top (px) before we start loading older messages.
  const UPDATE_TRIGGER_VIEW_OFFSET = 1000;
  const BUFFER_COUNT = 10;
  const SCROLL_DEBOUNCE_MS = 150;

  let virtualizer = createVirtualizer({
    count: chronologicalMessages?.length,
    getScrollElement: () => containerEl,
    estimateSize: () => MESSAGE_ESTIMATED_HEIGHT,
    overscan: BUFFER_COUNT,
    useAnimationFrameWithResizeObserver: true,
  });

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

    return { destroy() { observer.disconnect(); } };
  }

  let wasAtBottom = true;
  let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let previousItemCount = 0;

  // ── Scroll-up anchor ────────────────────────────────────────────────────────
  //
  // Instead of raw scrollHeight arithmetic (which relies on estimated heights
  // that are inaccurate until ResizeObserver fires), we anchor to the HASH of
  // the first item visible at the trigger moment.  After older messages are
  // prepended and measured, we call virtualizer.scrollToIndex() for that item's
  // new index, which uses the virtualizer's own (measurement-aware) positioning.
  //
  // Flow:
  //   1. debounce fires → capture anchorHash = first-visible item hash
  //                      → needsScrollAnchor = true, dispatch("scrollAtTop")
  //   2. loadMoreMessages runs (loadingTop: false→true→false)
  //   3. afterUpdate detects the false→true→false transition
  //      → find anchorHash's new index in chronologicalMessages
  //      → scrollToIndex(newIndex, { align:'start' })
  //
  // Clearing needsScrollAnchor before scrollToIndex ensures the synchronous
  // scroll event from scrollToIndex can safely restart the debounce.
  // ──────────────────────────────────────────────────────────────────────────
  let anchorHash: ActionHashB64 | null = null;
  let needsScrollAnchor = false;
  let prevLoadingTop = false;

  onMount(async () => {
    if (chronologicalMessages.length > 0 && containerEl) {
      wasAtBottom = true;
      await scrollToBottom();
    }
  });

  afterUpdate(() => {
    // Detect the loadingTop true→false transition (load just completed).
    if (needsScrollAnchor && prevLoadingTop && !loadingTop && anchorHash) {
      const newIndex = chronologicalMessages.findIndex(([hash]) => hash === anchorHash);

      // Clear before scrollToIndex so the resulting scroll event can
      // immediately restart the debounce for the next page.
      needsScrollAnchor = false;
      anchorHash = null;

      if (newIndex >= 0) {
        // scrollToIndex is measurement-aware: it uses the virtualizer's
        // internally cached item sizes (updated by ResizeObserver), not
        // the raw estimated heights.
        $virtualizer.scrollToIndex(newIndex, { align: "start", behavior: "auto" });
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

    // Trigger infinite-scroll upward.
    // Guards: not already loading, no pending anchor restore.
    if (atTop && !loadingTop && !needsScrollAnchor) {
      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);

      scrollDebounceTimer = setTimeout(() => {
        // Capture the first visible item's hash as the scroll anchor.
        // This is measurement-independent: we scroll to this item's new
        // index after the load, regardless of estimated item heights.
        if (containerEl && $virtualizer) {
          const items = $virtualizer.getVirtualItems();
          // Find the first item whose bottom edge is past the scrollTop
          // (i.e., actually in the viewport, not just overscan).
          const currentScrollTop = containerEl.scrollTop;
          const firstVisible = items.find(
            (item) => item.start + item.size > currentScrollTop,
          );
          if (firstVisible != null) {
            anchorHash = chronologicalMessages[firstVisible.index]?.[0] ?? null;
          }
        }

        needsScrollAnchor = true;
        dispatch("scrollAtTop");
        scrollDebounceTimer = undefined;
      }, SCROLL_DEBOUNCE_MS);
    }

    wasAtBottom = atBottom;
  }

  // Auto-scroll to bottom when new messages arrive while the user is at bottom.
  $: {
    const currentItemCount = chronologicalMessages?.length || 0;

    if (
      initialScrollReady &&
      wasAtBottom &&
      currentItemCount > previousItemCount &&
      !needsScrollAnchor
    ) {
      scrollToBottom("smooth");
    }

    previousItemCount = currentItemCount;
  }

  async function scrollToBottom(behavior?: "auto" | "smooth") {
    await waitForListLoad();

    const lastIndex = chronologicalMessages.length - 1;
    if (lastIndex < 0) return;

    // Overshoot to guarantee we land at the very bottom of the container.
    let attempts = 0;
    while (attempts < 5) {
      $virtualizer.scrollToIndex(lastIndex + 999, { align: "start", behavior });
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
    }

    requestAnimationFrame(() => { initialScrollReady = true; });
  }

  async function waitForListLoad() {
    await tick();

    return new Promise((resolve) => {
      const check = () => {
        const lastIndex = chronologicalMessages?.length - 1;
        if ($virtualizer.getVirtualItems().length > 0 && lastIndex >= 0) {
          resolve({});
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  function handleClick(e: MouseEvent, actionHashB64: ActionHashB64) {
    e.stopPropagation();
    selected = selected === actionHashB64 ? undefined : isMobile() ? undefined : actionHashB64;
  }

  function handleClickOutside() { selected = undefined; }

  function handlePress(actionHashB64: ActionHashB64) {
    if (isMobile()) selected = actionHashB64;
  }

  function shouldShowDaySeparator(currentIndex: number) {
    if (currentIndex === 0) return true;
    const currentMsg = chronologicalMessages?.[currentIndex]?.[1];
    const prevMsg = chronologicalMessages?.[currentIndex - 1]?.[1];
    if (!currentMsg || !prevMsg) return true;
    return !isSameDay(
      new Date(currentMsg.timestamp / 1000),
      new Date(prevMsg.timestamp / 1000),
    );
  }

  function shouldShowAuthor(currentIndex: number) {
    if (currentIndex === 0) return true;
    const currentMsg = chronologicalMessages[currentIndex][1];
    const prevMsg = chronologicalMessages[currentIndex - 1][1];
    if (!currentMsg || !prevMsg) return true;
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

  <!-- Virtualizer content container -->
  <div style="height: {$virtualizer.getTotalSize()}px; position: relative; width: 100%;">
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
          {#if shouldShowDaySeparator(currentIndex)}
            <div class="text-secondary-400 dark:text-secondary-300 my-4 px-4 text-center text-xs">
              {new Date(messageExtended.timestamp / 1000).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </div>
          {/if}

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

          {#if currentIndex === chronologicalMessages?.length - 1}
            <div class="flex h-4 items-center justify-center"></div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
