<script lang="ts">
  import type { NetworkStatsStoreData } from "$store/NetworkStatsStore";
  import type { ConversationNetworkInfo } from "$store/NetworkStatsStore";
  import type { PeerMeta } from "@holochain/client";
  import {
    encodeHashToBase64,
    hashFrom32AndType,
    HoloHashType,
  } from "@holochain/client";

  export let stats: NetworkStatsStoreData;
  export let conversationInfo: ConversationNetworkInfo | null = null;
  export let onClose: (() => void) | undefined = undefined;

  let detailed = false;

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function hexToAgentKey(hexKey: string): string {
    try {
      const coreBytes = new Uint8Array(
        hexKey.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [],
      );
      if (coreBytes.length === 32) {
        const fullHash = hashFrom32AndType(coreBytes, HoloHashType.Agent);
        return encodeHashToBase64(fullHash);
      }
    } catch {
      // fall through
    }
    return hexKey;
  }

  function truncateHash(hash: string): string {
    return hash.length > 20
      ? hash.slice(0, 10) + "..." + hash.slice(-10)
      : hash;
  }

  // Extract the node ID hex from a peer URL like "http://1.2.3.4:5555/abcdef0123..."
  // The peer_meta keys are URLs; the last path segment is the node ID
  function peerUrlToAgentKey(peerUrl: string): string {
    try {
      // Try to extract hex node ID from end of URL path
      const match = peerUrl.match(/\/([0-9a-f]{64})$/i);
      if (match) {
        return hexToAgentKey(match[1]);
      }
    } catch {
      // fall through
    }
    return peerUrl;
  }

  function formatTimestamp(ts: number | null | undefined): string {
    if (ts == null) return "never";
    // Holochain timestamps are in microseconds
    const ms = ts / 1000;
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  function formatLastUpdated(ts: number | null): string {
    if (ts === null) return "never";
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 5) return "just now";
    return `${seconds}s ago`;
  }

  $: transport = stats.transportStats;
  $: connections = transport?.connections || [];
  $: totalSent = connections.reduce((s, c) => s + c.send_bytes, 0);
  $: totalRecv = connections.reduce((s, c) => s + c.recv_bytes, 0);
  $: totalMsgSent = connections.reduce(
    (s, c) => s + c.send_message_count,
    0,
  );
  $: totalMsgRecv = connections.reduce(
    (s, c) => s + c.recv_message_count,
    0,
  );
  $: hasRecvData = totalRecv > 0 || totalMsgRecv > 0;

  $: peerMetaEntries = conversationInfo?.metrics
    ? Object.entries(
        conversationInfo.metrics.gossip_state_summary?.peer_meta || {},
      )
    : [];
</script>

<div
  class="fixed bottom-4 right-4 z-50 w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-neutral-600 bg-neutral-900 text-neutral-100 p-4 shadow-xl text-sm"
>
  <div class="mb-3 flex items-center justify-between">
    <h3 class="font-semibold text-neutral-50">Network Status</h3>
    <div class="flex items-center gap-2">
      <button
        class="rounded px-2 py-0.5 text-xs {detailed
          ? 'bg-primary-500 text-white'
          : 'bg-neutral-700 text-neutral-300'}"
        on:click={() => (detailed = !detailed)}
      >
        {detailed ? "Simple" : "Detailed"}
      </button>
      {#if onClose}
        <button
          class="text-neutral-400 hover:text-neutral-100"
          on:click={onClose}
        >
          ✕
        </button>
      {/if}
    </div>
  </div>

  <!-- Transport Stats -->
  <div class="mb-3 space-y-1">
    <div
      class="font-medium text-xs uppercase tracking-wide text-neutral-500"
    >
      Transport
    </div>
    <div class="flex justify-between">
      <span class="text-neutral-400">Backend</span>
      <span>{transport?.backend || "unknown"}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-neutral-400">Connections</span>
      <span>{connections.length}</span>
    </div>
    {#if hasRecvData}
      <div class="flex justify-between">
        <span class="text-neutral-400">Sent / Received</span>
        <span>{formatBytes(totalSent)} / {formatBytes(totalRecv)}</span>
      </div>
    {:else}
      <div class="flex justify-between">
        <span class="text-neutral-400">Sent</span>
        <span>{formatBytes(totalSent)} ({totalMsgSent} msgs)</span>
      </div>
    {/if}
    {#if detailed && hasRecvData}
      <div class="flex justify-between">
        <span class="text-neutral-400">Messages</span>
        <span>{totalMsgSent} sent / {totalMsgRecv} recv</span>
      </div>
    {/if}
  </div>

  <!-- Conversation-specific stats -->
  {#if conversationInfo}
    <div class="mb-3 space-y-1 border-t border-neutral-700 pt-3">
      <div
        class="font-medium text-xs uppercase tracking-wide text-neutral-500"
      >
        Conversation Network
      </div>
      <div class="flex justify-between">
        <span class="text-neutral-400">Gossip Peers</span>
        <span>{conversationInfo.peerCount}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-neutral-400">Last Gossip</span>
        <span>{formatTimestamp(conversationInfo.lastGossipTimestamp)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-neutral-400">Gossip Rounds</span>
        <span>{conversationInfo.totalGossipRounds}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-neutral-400">Pending Fetches</span>
        <span>{conversationInfo.pendingFetchCount}</span>
      </div>
      {#if conversationInfo.totalErrors > 0}
        <div class="flex justify-between text-yellow-400">
          <span>Errors</span>
          <span>{conversationInfo.totalErrors}</span>
        </div>
      {/if}
    </div>

    <!-- Per-peer gossip details (detailed mode only) -->
    {#if detailed && peerMetaEntries.length > 0}
      <div class="mb-3 space-y-2 border-t border-neutral-700 pt-3">
        <div
          class="font-medium text-xs uppercase tracking-wide text-neutral-500"
        >
          Peer Gossip Details
        </div>
        {#each peerMetaEntries as [peerUrl, peer]}
          {@const agentKey = peerUrlToAgentKey(peerUrl)}
          <div class="rounded bg-neutral-800 p-2 text-xs space-y-0.5">
            <div class="font-mono text-neutral-500" title={agentKey}>
              {truncateHash(agentKey)}
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Last gossip</span>
              <span>{formatTimestamp(peer.last_gossip_timestamp)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Rounds</span>
              <span
                >{(peer.completed_rounds || 0) +
                  (peer.peer_terminated || 0)}</span
              >
            </div>
            {#if (peer.peer_timeouts || 0) > 0}
              <div class="flex justify-between text-yellow-400">
                <span>Timeouts</span>
                <span>{peer.peer_timeouts}</span>
              </div>
            {/if}
            {#if (peer.local_errors || 0) + (peer.peer_behavior_errors || 0) > 0}
              <div class="flex justify-between text-red-400">
                <span>Errors</span>
                <span
                  >{(peer.local_errors || 0) +
                    (peer.peer_behavior_errors || 0)}</span
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Per-connection details (detailed mode) -->
  {#if detailed && connections.length > 0}
    <div class="mb-3 space-y-2 border-t border-neutral-700 pt-3">
      <div
        class="font-medium text-xs uppercase tracking-wide text-neutral-500"
      >
        Connections
      </div>
      {#each connections as conn}
        {@const agentKey = hexToAgentKey(conn.pub_key)}
        <div class="rounded bg-neutral-800 p-2 text-xs space-y-0.5">
          <div class="font-mono text-neutral-500" title={agentKey}>
            {truncateHash(agentKey)}
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">Sent</span>
            <span
              >{formatBytes(conn.send_bytes)} ({conn.send_message_count} msgs)</span
            >
          </div>
          {#if conn.recv_bytes > 0 || conn.recv_message_count > 0}
            <div class="flex justify-between">
              <span class="text-neutral-400">Received</span>
              <span
                >{formatBytes(conn.recv_bytes)} ({conn.recv_message_count} msgs)</span
              >
            </div>
          {/if}
          <div class="flex justify-between">
            <span class="text-neutral-400">Direct</span>
            <span>{conn.is_direct ? "yes" : "no"}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Footer -->
  <div class="border-t border-neutral-700 pt-2 text-xs text-neutral-600 text-right">
    Updated {formatLastUpdated(stats.lastUpdated)}
  </div>
</div>
