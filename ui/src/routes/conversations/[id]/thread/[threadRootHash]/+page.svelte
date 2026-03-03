<script lang="ts">
  import { encodeHashToBase64, type ActionHashB64, type AgentPubKeyB64 } from "@holochain/client";
  import { getContext, onMount } from "svelte";
  import { page } from "$app/stores";
  import Header from "$lib/Header.svelte";
  import type { LocalFile, MessageExtended } from "$lib/types";
  import ConversationMessageInput from "../../ConversationMessageInput.svelte";
  import Message from "../../Message.svelte";
  import {
    deriveCellConversationMessageStore,
    type ConversationMessageStore,
  } from "$store/ConversationMessageStore";
  import { toast } from "svelte-french-toast";
  import { isMobile, isSameDay, isWithinFiveMinutes } from "$lib/utils";

  const conversationMessageStore = getContext<{
    getStore: () => ConversationMessageStore;
  }>("conversationMessageStore").getStore();
  const myPubKeyB64 = getContext<{ getMyPubKeyB64: () => AgentPubKeyB64 }>(
    "myPubKey",
  ).getMyPubKeyB64();

  let messages = deriveCellConversationMessageStore(conversationMessageStore, $page.params.id);

  let threadMessages: [ActionHashB64, MessageExtended][] = [];
  let loading = true;
  let sending = false;
  let messageInputRef: HTMLElement;
  let selected: ActionHashB64 | undefined;

  let replyToMessage: MessageExtended | undefined = undefined;
  let replyToActionHash: ActionHashB64 | undefined = undefined;

  $: threadRootHash = $page.params.threadRootHash as ActionHashB64;
  $: conversationId = $page.params.id;

  async function loadThread() {
    try {
      threadMessages = await messages.getThreadMessages(threadRootHash);
    } catch (e) {
      console.error("Failed to load thread:", e);
      toast.error("Failed to load thread");
    }
    loading = false;
  }

  // Reactively re-derives thread on store changes (new signals update $messages).
  // Builds a parent→children map first so BFS lookups are O(1) instead of O(n) per node.
  $: if ($messages.data && threadRootHash) {
    const allData = $messages.data;

    const childrenMap: Record<ActionHashB64, ActionHashB64[]> = {};
    for (const [hash, msg] of Object.entries(allData)) {
      if (msg.message?.reply_to) {
        const parent = encodeHashToBase64(msg.message.reply_to);
        if (!childrenMap[parent]) childrenMap[parent] = [];
        childrenMap[parent].push(hash);
      }
    }

    const result: [ActionHashB64, MessageExtended][] = [];
    const seen = new Set<ActionHashB64>();
    const queue: ActionHashB64[] = [threadRootHash];

    while (queue.length > 0) {
      const currentHash = queue.shift()!;
      if (seen.has(currentHash)) continue;
      seen.add(currentHash);

      const message = allData[currentHash];
      if (message) result.push([currentHash, message]);

      for (const child of (childrenMap[currentHash] || [])) {
        if (!seen.has(child)) queue.push(child);
      }
    }

    result.sort(([hashA, a], [hashB, b]) => {
      if (hashA === threadRootHash) return -1;
      if (hashB === threadRootHash) return 1;
      return a.timestamp - b.timestamp;
    });

    if (result.length > 0) {
      threadMessages = result;
    }
  }

  async function handleSend(event: CustomEvent) {
    if (sending) return;

    const { text, files, replyTo } = event.detail;
    sending = true;

    try {
        // reply_to: the specific message being replied to, or the root if none selected
      await messages.sendMessage(
        text,
        files as LocalFile[],
        replyTo ? encodeHashToBase64(replyTo) : threadRootHash,
      );
      replyToMessage = undefined;
      replyToActionHash = undefined;
      await loadThread();
    } catch (e) {
      console.error("Failed to send thread reply:", e);
      toast.error("Failed to send reply");
    }

    sending = false;
  }

  function handleReply(event: CustomEvent<ActionHashB64>) {
    const actionHashB64 = event.detail;
    // Find the message being replied to so we can show the preview
    const found = threadMessages.find(([hash]) => hash === actionHashB64);
    if (found) {
      replyToActionHash = actionHashB64;
      replyToMessage = found[1];
    }
    selected = undefined;
  }

  function handlePress(actionHashB64: ActionHashB64) {
    if (isMobile()) {
      selected = actionHashB64;
    }
  }

  function handleClick(e: MouseEvent, actionHashB64: ActionHashB64) {
    e.stopPropagation();
    selected = selected === actionHashB64 ? undefined : isMobile() ? undefined : actionHashB64;
  }

  function handleClickOutside() {
    selected = undefined;
  }

  function shouldShowDaySeparator(currentIndex: number) {
    if (currentIndex === 0) return true;
    const currentMsg = threadMessages[currentIndex]?.[1];
    const prevMsg = threadMessages[currentIndex - 1]?.[1];
    if (!currentMsg || !prevMsg) return true;
    return !isSameDay(new Date(currentMsg.timestamp / 1000), new Date(prevMsg.timestamp / 1000));
  }

  function shouldShowAuthor(currentIndex: number) {
    if (currentIndex === 0) return true;
    const currentMsg = threadMessages[currentIndex]?.[1];
    const prevMsg = threadMessages[currentIndex - 1]?.[1];
    if (!currentMsg || !prevMsg) return true;
    return (
      currentMsg.authorAgentPubKeyB64 !== prevMsg.authorAgentPubKeyB64 ||
      !isWithinFiveMinutes(
        new Date(currentMsg.timestamp / 1000),
        new Date(prevMsg.timestamp / 1000),
      )
    );
  }

  onMount(() => {
    loadThread();
  });
</script>

<Header backUrl="/conversations/{conversationId}">
  <h1 slot="center" class="overflow-hidden text-ellipsis whitespace-nowrap p-4 text-center">
    Thread
  </h1>
</Header>

<div class="mx-auto flex w-full flex-1 flex-col items-center justify-center overflow-hidden">
  <div class="relative flex w-full grow flex-col items-center overflow-hidden">
    {#if loading}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-secondary-400 text-sm">Loading...</span>
      </div>
    {:else if threadMessages.length === 0}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-secondary-400 text-sm">Failed to load thread</span>
      </div>
    {:else}
      {@const [rootHash, rootMessage] = threadMessages[0]}
      {@const replies = threadMessages.slice(1)}

      <div class="flex w-full flex-1 flex-col overflow-y-auto">
        <!-- Root message: always shown at the top with a clear label -->
        <div class="bg-secondary-100 dark:bg-secondary-800 border-b border-secondary-200 dark:border-secondary-600">
          <div class="px-4 pt-3 pb-0.5">
            <span class="text-xxs font-semibold tracking-widest text-secondary-500 dark:text-secondary-400 uppercase">
              Original message
            </span>
          </div>
          <div class="px-4 pb-2">
            <Message
              cellIdB64={conversationId}
              message={rootMessage}
              isSelected={selected === rootHash}
              showAuthor={true}
              actionHashB64={rootHash}
              participantCount={0}
              on:press={() => handlePress(rootHash)}
              on:click={(e) => handleClick(e, rootHash)}
              on:clickoutside={handleClickOutside}
              on:reply={handleReply}
            />
          </div>
        </div>

        <!-- Replies section -->
        {#if replies.length === 0}
          <div class="flex flex-1 items-center justify-center">
            <span class="text-secondary-400 text-sm">No replies yet. Be the first!</span>
          </div>
        {:else}
          <!-- Replies count label -->
          <div class="flex items-center gap-2 px-4 py-2">
            <span class="text-xxs font-semibold tracking-widest text-secondary-500 dark:text-secondary-400 uppercase">
              {replies.length}
              {replies.length === 1 ? "reply" : "replies"}
            </span>
            <div class="border-secondary-200 dark:border-secondary-600 flex-1 border-t"></div>
          </div>

          {#each replies as [actionHashB64, messageExtended], idx}
            {@const replyingToRoot =
              messageExtended.message.reply_to &&
              encodeHashToBase64(messageExtended.message.reply_to) === threadRootHash}
            {@const displayMessage = replyingToRoot
              ? { ...messageExtended, replyToMessage: undefined }
              : messageExtended}

            {#if shouldShowDaySeparator(idx + 1)}
              <div class="text-secondary-400 dark:text-secondary-300 my-4 px-4 text-center text-xs">
                {new Date(messageExtended.timestamp / 1000).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </div>
            {/if}

            <div class="mt-3 px-4">
              <Message
                cellIdB64={conversationId}
                message={displayMessage}
                isSelected={selected === actionHashB64}
                showAuthor={shouldShowAuthor(idx + 1)}
                {actionHashB64}
                participantCount={0}
                on:press={() => handlePress(actionHashB64)}
                on:click={(e) => handleClick(e, actionHashB64)}
                on:clickoutside={handleClickOutside}
                on:reply={handleReply}
              />
            </div>
          {/each}

          <div class="flex h-4 items-center justify-center"></div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<ConversationMessageInput
  bind:ref={messageInputRef}
  bind:replyToMessage
  bind:replyToActionHash
  cellIdB64={conversationId}
  disabled={sending}
  loading={sending}
  on:send={handleSend}
  on:cancelReply={() => {
    replyToMessage = undefined;
    replyToActionHash = undefined;
  }}
/>
