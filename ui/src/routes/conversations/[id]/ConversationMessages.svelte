<script lang="ts">
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";
  import type { ActionHashB64 } from "@holochain/client";
  import { MessageType, type MessageExtended, type CellIdB64 } from "$lib/types";
  import BaseMessage from "./Message.svelte";
  import NoticeMessage from "./NoticeMessage.svelte";
  import ConversationHeader from "./ConversationHeader.svelte";
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

  $: chronologicalMessages = messages ?? [];

  const TOP_TRIGGER_PX = 160;
  const BOTTOM_EPSILON_PX = 8;
  const SCROLL_DEBOUNCE_MS = 120;

  let wasAtBottom = true;
  let previousItemCount = 0;
  let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  let anchorHash: ActionHashB64 | null = null;
  let anchorTopBeforeLoad = 0;
  let pendingAnchorRestore = false;
  let prevLoadingTop = false;

  const rowElements = new Map<ActionHashB64, HTMLElement>();

  $: {
  console.log("[ConversationMessages] received messages:", chronologicalMessages.length);
  if (chronologicalMessages.length > 0) {
    console.log("[ConversationMessages] oldest:", {
      hash: chronologicalMessages[0][0],
      timestamp: chronologicalMessages[0][1].timestamp,
      bucket: chronologicalMessages[0][1].message.bucket,
    });
    console.log("[ConversationMessages] newest:", {
      hash: chronologicalMessages[chronologicalMessages.length - 1][0],
      timestamp: chronologicalMessages[chronologicalMessages.length - 1][1].timestamp,
      bucket: chronologicalMessages[chronologicalMessages.length - 1][1].message.bucket,
    });
  }
}

function registerRow(node: HTMLElement, hash: ActionHashB64) {
  rowElements.set(hash, node);

  return {
    update(newHash: ActionHashB64) {
      if (newHash !== hash) {
        rowElements.delete(hash);
        hash = newHash;
        rowElements.set(hash, node);
      }
    },
    destroy() {
      rowElements.delete(hash);
    },
  };
}

  function clearScrollDebounce() {
    if (scrollDebounceTimer) {
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = undefined;
    }
  }

  function getDistanceFromBottom() {
    if (!containerEl) return 0;
    return containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight;
  }

  function updateBottomState() {
    wasAtBottom = getDistanceFromBottom() <= BOTTOM_EPSILON_PX;
  }

  function getFirstVisibleAnchor(): { hash: ActionHashB64; top: number } | null {
    if (!containerEl) return null;

    const containerTop = containerEl.getBoundingClientRect().top;
    for (const [hash] of chronologicalMessages) {
      const node = rowElements.get(hash);
      if (!node) continue;

      const rect = node.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        return {
          hash,
          top: rect.top - containerTop,
        };
      }
    }

    return null;
  }

  async function restoreAnchorPosition() {
    if (!containerEl || !anchorHash) return;

    await tick();

    let attempts = 0;
    while (attempts < 8) {
      const node = rowElements.get(anchorHash);
      if (node) {
        const containerTop = containerEl.getBoundingClientRect().top;
        const currentTop = node.getBoundingClientRect().top - containerTop;
        const delta = currentTop - anchorTopBeforeLoad;
        containerEl.scrollTop += delta;
          console.log("[ConversationMessages] anchor restored", {
          anchorHash,
          currentTop,
          anchorTopBeforeLoad,
          delta,
          newScrollTop: containerEl.scrollTop,
        });
        break;
      }

      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      attempts++;
    }

    pendingAnchorRestore = false;
    anchorHash = null;
  }

  onMount(async () => {
    if (chronologicalMessages.length > 0 && containerEl) {
      await scrollToBottom("auto");
      updateBottomState();
    } else {
      initialScrollReady = true;
    }
  });

  afterUpdate(async () => {
    if (pendingAnchorRestore && prevLoadingTop && !loadingTop) {
      await restoreAnchorPosition();
      updateBottomState();
    }

    prevLoadingTop = loadingTop;
  });

  function handleScroll() {
    if (!containerEl || !initialScrollReady) return;

    updateBottomState();

    if (wasAtBottom) {
      dispatch("scrollAtBottom");
    }

    const atTop = containerEl.scrollTop <= TOP_TRIGGER_PX;
    if (!atTop || loadingTop || pendingAnchorRestore) {
      clearScrollDebounce();
      return;
    }

    clearScrollDebounce();
    scrollDebounceTimer = setTimeout(() => {
      if (!containerEl || loadingTop || pendingAnchorRestore) return;
      if (containerEl.scrollTop > TOP_TRIGGER_PX) return;

      const anchor = getFirstVisibleAnchor();
      if (anchor) {
        anchorHash = anchor.hash;
        anchorTopBeforeLoad = anchor.top;
        pendingAnchorRestore = true;
      }
console.log("[ConversationMessages] scrollAtTop fired", {
  scrollTop: containerEl?.scrollTop,
  currentCount: chronologicalMessages.length,
  anchorHash,
  anchorTopBeforeLoad,
  loadingTop,
  pendingAnchorRestore,
});
      dispatch("scrollAtTop");
      scrollDebounceTimer = undefined;
    }, SCROLL_DEBOUNCE_MS);
  }

  $: {
    const currentItemCount = chronologicalMessages.length;

    if (
      initialScrollReady &&
      wasAtBottom &&
      currentItemCount > previousItemCount &&
      !loadingTop &&
      !pendingAnchorRestore
    ) {
      scrollToBottom("auto");
    }

    previousItemCount = currentItemCount;
  }

  async function scrollToBottom(behavior: ScrollBehavior = "auto") {
    await tick();
    if (!containerEl) return;

    containerEl.scrollTo({
      top: containerEl.scrollHeight,
      behavior,
    });

    requestAnimationFrame(() => {
      initialScrollReady = true;
      updateBottomState();
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

    const currentMsg = chronologicalMessages[currentIndex]?.[1];
    const prevMsg = chronologicalMessages[currentIndex - 1]?.[1];

    if (!currentMsg || !prevMsg) return true;

    return !isSameDay(new Date(currentMsg.timestamp / 1000), new Date(prevMsg.timestamp / 1000));
  }

  function shouldShowAuthor(currentIndex: number) {
    if (currentIndex === 0) return true;

    const currentMsg = chronologicalMessages[currentIndex]?.[1];
    const prevMsg = chronologicalMessages[currentIndex - 1]?.[1];

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

  {#if loadingTop}
    <div class="flex h-12 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
    </div>
  {/if}

  {#each chronologicalMessages as [actionHashB64, messageExtended], currentIndex (actionHashB64)}
    <div use:registerRow={actionHashB64} class="w-full">
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

        {#if currentIndex === chronologicalMessages.length - 1}
          <div class="flex h-4 items-center justify-center"></div>
        {/if}
      </div>
    </div>
  {/each}
</div>