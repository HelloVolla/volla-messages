<script lang="ts">
  import type { NetworkStatsStoreData, DiagnosticEvent } from "$store/NetworkStatsStore";
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
  export let onCopyDiagnostics: (() => void) | undefined = undefined;
  export let resolveAgentName: ((agentKeyB64: string) => string | undefined) | undefined = undefined;

  let detailed = false;
  let showEvents = false;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const hexToAgentKey = (hexKey: string): string => {
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
  };

  const truncateHash = (hash: string): string =>
    hash.length > 20 ? hash.slice(0, 10) + "..." + hash.slice(-10) : hash;

  const displayAgent = (agentKeyB64: string): string => {
    const name = resolveAgentName?.(agentKeyB64);
    return name ? `${name} (${truncateHash(agentKeyB64)})` : truncateHash(agentKeyB64);
  };

  const peerUrlToAgentKey = (peerUrl: string): string => {
    try {
      const match = peerUrl.match(/\/([0-9a-f]{64})$/i);
      if (match) return hexToAgentKey(match[1]);
    } catch {
      // fall through
    }
    return peerUrl;
  };

  const formatTimestamp = (ts: number | null | undefined): string => {
    if (ts == null) return "never";
    const ms = ts / 1000;
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  const formatLastUpdated = (ts: number | null): string => {
    if (ts === null) return "never";
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 5) return "just now";
    return `${seconds}s ago`;
  };

  const formatConnAge = (openedAtS: number): string => {
    const seconds = Math.floor(Date.now() / 1000 - openedAtS);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const eventColor = (type: DiagnosticEvent["type"]): string => {
    if (type === "gossip_error" || type === "poll_error") return "text-red-400";
    if (type === "gossip_timeout" || type === "peer_backoff" || type === "peer_lost" || type === "conn_closed") return "text-yellow-400";
    if (type === "peer_discovered" || type === "conn_opened" || type === "conn_direct_upgrade") return "text-green-400";
    if (type === "conductor_log") return "text-blue-400";
    return "text-neutral-400";
  };

  $: transport = stats.transportStats;
  $: connections = transport?.connections || [];
  $: peerUrls = transport?.peer_urls || [];
  $: directCount = connections.filter((c) => (c as any).is_direct).length;
  $: totalSent = connections.reduce((s, c) => s + c.send_bytes, 0);
  $: totalRecv = connections.reduce((s, c) => s + c.recv_bytes, 0);
  $: totalMsgSent = connections.reduce((s, c) => s + c.send_message_count, 0);
  $: totalMsgRecv = connections.reduce((s, c) => s + c.recv_message_count, 0);
  $: hasRecvData = totalRecv > 0 || totalMsgRecv > 0;

  $: peerMetaEntries = conversationInfo?.metrics
    ? Object.entries(conversationInfo.metrics.gossip_state_summary?.peer_meta || {})
    : [];

  $: allKnownPeerKeys = (() => {
    if (!stats.metricsPerDna) return [];
    const keys = new Set<string>();
    for (const m of Object.values(stats.metricsPerDna)) {
      const peerMeta = m.gossip_state_summary?.peer_meta || {};
      for (const url of Object.keys(peerMeta)) {
        keys.add(peerUrlToAgentKey(url));
      }
    }
    for (const conn of connections) {
      keys.add(hexToAgentKey(conn.pub_key));
    }
    return [...keys];
  })();

  $: events = [...stats.diagnosticEvents].reverse().slice(0, 30);
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
      {#if onCopyDiagnostics}
        <button
          class="rounded px-2 py-0.5 text-xs bg-neutral-700 text-neutral-300"
          on:click={onCopyDiagnostics}
        >
          Copy
        </button>
      {/if}
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
    <div class="font-medium text-xs uppercase tracking-wide text-neutral-500">
      Transport
    </div>
    <div class="flex justify-between">
      <span class="text-neutral-400">Backend</span>
      <span>{transport?.backend || "unknown"}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-neutral-400">Connections</span>
      <span>{connections.length} ({directCount} direct)</span>
    </div>
    <div class="flex justify-between">
      <span class="text-neutral-400">Known Peers</span>
      <span>{allKnownPeerKeys.length}</span>
    </div>
    {#if hasRecvData}
      <div class="flex justify-between">
        <span class="text-neutral-400">Network I/O</span>
        <span>{formatBytes(totalSent)} / {formatBytes(totalRecv)}</span>
      </div>
    {:else}
      <div class="flex justify-between">
        <span class="text-neutral-400">Network I/O</span>
        <span>{formatBytes(totalSent)} ({totalMsgSent} pkts)</span>
      </div>
    {/if}
    {#if detailed && hasRecvData}
      <div class="flex justify-between">
        <span class="text-neutral-400">Packets</span>
        <span>{totalMsgSent} tx / {totalMsgRecv} rx</span>
      </div>
    {/if}
    {#if detailed && peerUrls.length > 0}
      <div class="mt-1">
        <span class="text-neutral-400 text-xs">Reachable at:</span>
        {#each peerUrls as url}
          <div class="font-mono text-xs text-neutral-500 break-all">{url}</div>
        {/each}
      </div>
    {/if}
    {#if detailed && allKnownPeerKeys.length > 0}
      <div class="mt-1">
        <span class="text-neutral-400 text-xs">Known peer keys:</span>
        {#each allKnownPeerKeys as key}
          <div class="font-mono text-xs text-neutral-500 break-all" title={key}>{displayAgent(key)}</div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Conversation-specific stats -->
  {#if conversationInfo}
    <div class="mb-3 space-y-1 border-t border-neutral-700 pt-3">
      <div class="font-medium text-xs uppercase tracking-wide text-neutral-500">
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
      <div class="flex justify-between {conversationInfo.activeGossipRounds.length >= 8 ? 'text-yellow-400' : ''}">
        <span class="text-neutral-400" title="accepted rounds / max (10). Near 10 = this node is overloaded with gossip">Active Rounds</span>
        <span>{conversationInfo.activeGossipRounds.length} / 10</span>
      </div>
      <div class="flex justify-between {conversationInfo.pendingFetchCount > 10 ? 'text-yellow-400' : ''}">
        <span class="text-neutral-400" title="Ops queued for download. High = can't keep up with incoming data">Pending Fetches</span>
        <span>{conversationInfo.pendingFetchCount}</span>
      </div>
      {#if conversationInfo.metrics?.gossip_state_summary}
        <div class="flex justify-between">
          <span class="text-neutral-400">Local Ops</span>
          <span>{conversationInfo.metrics.gossip_state_summary["local_op_count"] ?? "?"}</span>
        </div>
      {/if}
      {#if conversationInfo.peersBehindCount > 0}
        <div class="flex justify-between text-yellow-400">
          <span>Peers Behind</span>
          <span>{conversationInfo.peersBehindCount} of {conversationInfo.peerCount}</span>
        </div>
      {/if}
      {#if conversationInfo.totalTimeouts > 0}
        <div class="flex justify-between text-yellow-400">
          <span>Timeouts</span>
          <span>{conversationInfo.totalTimeouts}</span>
        </div>
      {/if}
      {#if conversationInfo.totalBusy > 0}
        <div class="flex justify-between text-yellow-400">
          <span>Peer Busy</span>
          <span>{conversationInfo.totalBusy}</span>
        </div>
      {/if}
      {#if conversationInfo.totalErrors > 0}
        <div class="flex justify-between text-red-400">
          <span>Errors</span>
          <span>{conversationInfo.totalErrors}</span>
        </div>
      {/if}
    </div>

    <!-- Local agent arcs -->
    {#if detailed && conversationInfo.localAgents.length > 0}
      <div class="mb-3 space-y-1 border-t border-neutral-700 pt-3">
        <div class="font-medium text-xs uppercase tracking-wide text-neutral-500">
          Local Agents
        </div>
        {#each conversationInfo.localAgents as agent}
          <div class="rounded bg-neutral-800 p-2 text-xs space-y-0.5">
            <div class="font-mono text-neutral-500" title={encodeHashToBase64(agent.agent)}>
              {displayAgent(encodeHashToBase64(agent.agent))}
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Storage Arc</span>
              <span>{agent.storage_arc ? `[${agent.storage_arc[0]}, ${agent.storage_arc[1]}]` : "none"}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Target Arc</span>
              <span>{agent.target_arc ? `[${agent.target_arc[0]}, ${agent.target_arc[1]}]` : "none"}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Per-peer gossip details (detailed mode) -->
    {#if detailed && peerMetaEntries.length > 0}
      <div class="mb-3 space-y-2 border-t border-neutral-700 pt-3">
        <div class="font-medium text-xs uppercase tracking-wide text-neutral-500">
          Peer Gossip Details
        </div>
        {#each peerMetaEntries as [peerUrl, peer]}
          {@const agentKey = peerUrlToAgentKey(peerUrl)}
          <div class="rounded bg-neutral-800 p-2 text-xs space-y-0.5">
            <div class="font-mono text-neutral-500" title={agentKey}>
              {displayAgent(agentKey)}
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Last gossip</span>
              <span>{formatTimestamp(peer.last_gossip_timestamp)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-neutral-400">Rounds</span>
              <span>{(peer.completed_rounds || 0) + (peer.peer_terminated || 0)}</span>
            </div>
            {#if (peer.peer_busy || 0) > 0}
              <div class="flex justify-between text-yellow-400">
                <span>Busy</span>
                <span>{peer.peer_busy}</span>
              </div>
            {/if}
            {#if (peer.peer_timeouts || 0) > 0}
              <div class="flex justify-between text-yellow-400">
                <span>Timeouts</span>
                <span>{peer.peer_timeouts}</span>
              </div>
            {/if}
            {#if (peer.local_errors || 0) + (peer.peer_behavior_errors || 0) > 0}
              <div class="flex justify-between text-red-400">
                <span>Errors</span>
                <span>{(peer.local_errors || 0) + (peer.peer_behavior_errors || 0)}</span>
              </div>
            {/if}
            {#if peer.dht_op_count != null}
              {@const localOps = conversationInfo?.localOpCount || 0}
              {@const syncPct = localOps > 0 ? Math.round((peer.dht_op_count / localOps) * 100) : 100}
              <div class="flex justify-between">
                <span class="text-neutral-400" title="Peer's DHT ops / Our local DHT ops">DHT Ops</span>
                <span>{peer.dht_op_count} / {localOps}</span>
              </div>
              <div class="flex justify-between {syncPct < 90 ? 'text-yellow-400' : syncPct < 100 ? 'text-neutral-300' : 'text-green-400'}">
                <span title="peer ops ÷ local ops — 100% = fully synced, <90% = behind">Sync</span>
                <span>{syncPct}%</span>
              </div>
            {/if}
            {#if peer.storage_arc}
              <div class="flex justify-between">
                <span class="text-neutral-400">Arc</span>
                <span>[{peer.storage_arc[0]}, {peer.storage_arc[1]}]</span>
              </div>
            {/if}
            {#if peer["new_ops_bookmark"]}
              <div class="flex justify-between">
                <span class="text-neutral-400">Ops Bookmark</span>
                <span>{formatTimestamp(peer["new_ops_bookmark"])}</span>
              </div>
            {/if}
            {#if peer["is_tombstone"]}
              <div class="flex justify-between text-red-400">
                <span>Tombstone</span>
                <span>yes</span>
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
      <div class="font-medium text-xs uppercase tracking-wide text-neutral-500">
        Connections
      </div>
      {#each connections as conn}
        {@const agentKey = hexToAgentKey(conn.pub_key)}
        <div class="rounded bg-neutral-800 p-2 text-xs space-y-0.5">
          <div class="font-mono text-neutral-500" title={agentKey}>
            {displayAgent(agentKey)}
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">Sent</span>
            <span>{formatBytes(conn.send_bytes)} ({conn.send_message_count} pkts)</span>
          </div>
          {#if conn.recv_bytes > 0 || conn.recv_message_count > 0}
            <div class="flex justify-between">
              <span class="text-neutral-400">Received</span>
              <span>{formatBytes(conn.recv_bytes)} ({conn.recv_message_count} pkts)</span>
            </div>
          {/if}
          <div class="flex justify-between">
            <span class="text-neutral-400">Direct</span>
            <span>{conn["is_direct"] ? "yes" : "no"}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-400">Age</span>
            <span>{formatConnAge(conn.opened_at_s)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Diagnostic events -->
  {#if detailed}
    <div class="mb-3 border-t border-neutral-700 pt-3">
      <button
        class="font-medium text-xs uppercase tracking-wide text-neutral-500 mb-1"
        on:click={() => (showEvents = !showEvents)}
      >
        Events ({stats.diagnosticEvents.length}) {showEvents ? "▼" : "▶"}
      </button>
      {#if showEvents}
        <div class="space-y-0.5 max-h-48 overflow-y-auto">
          {#each events as event}
            <div class="text-xs {eventColor(event.type)} font-mono leading-tight">
              <span class="text-neutral-600">{new Date(event.timestamp).toLocaleTimeString()}</span>
              {event.detail}
            </div>
          {/each}
          {#if events.length === 0}
            <div class="text-xs text-neutral-600">No events yet</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Footer -->
  <div class="border-t border-neutral-700 pt-2 text-xs text-neutral-600 flex justify-between">
    <span>Poll #{stats.pollCount}</span>
    <span>Updated {formatLastUpdated(stats.lastUpdated)}</span>
  </div>
</div>
