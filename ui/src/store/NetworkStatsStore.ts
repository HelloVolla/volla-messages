import { writable, derived, get } from "svelte/store";
import type {
  AppClient,
  AppDumpNetworkStatsResponse,
  DumpNetworkMetricsResponse,
  TransportStats,
  NetworkMetrics,
  DnaHash,
  DnaHashB64,
} from "@holochain/client";
import { encodeHashToBase64 } from "@holochain/client";
import { Base64 } from "js-base64";
import { NETWORK_STATS_POLL_INTERVAL } from "$config";
import type { CellIdB64 } from "$lib/types";

export interface ConversationNetworkInfo {
  metrics: NetworkMetrics | null;
  peerCount: number;
  lastGossipTimestamp: number | null;
  pendingFetchCount: number;
  totalGossipRounds: number;
  totalErrors: number;
}

export interface NetworkStatsStoreData {
  transportStats: TransportStats | null;
  metricsPerDna: DumpNetworkMetricsResponse | null;
  lastUpdated: number | null;
}

export interface NetworkStatsStore {
  subscribe: typeof store.subscribe;
  start: () => void;
  stop: () => void;
  refresh: () => Promise<void>;
  getConversationNetworkInfo: (cellIdB64: CellIdB64) => ConversationNetworkInfo | null;
}

let store: ReturnType<typeof writable<NetworkStatsStoreData>>;

export function createNetworkStatsStore(client: AppClient): NetworkStatsStore {
  store = writable<NetworkStatsStoreData>({
    transportStats: null,
    metricsPerDna: null,
    lastUpdated: null,
  });

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  async function fetchStats() {
    try {
      const [stats, metrics] = await Promise.allSettled([
        client.dumpNetworkStats(),
        client.dumpNetworkMetrics({ include_dht_summary: false }),
      ]);

      store.update((s) => ({
        ...s,
        transportStats:
          stats.status === "fulfilled" ? stats.value : s.transportStats,
        metricsPerDna:
          metrics.status === "fulfilled" ? metrics.value : s.metricsPerDna,
        lastUpdated: Date.now(),
      }));
    } catch (e) {
      console.error("Failed to fetch network stats:", e);
    }
  }

  function start() {
    if (pollInterval) return;
    fetchStats();
    pollInterval = setInterval(fetchStats, NETWORK_STATS_POLL_INTERVAL);
  }

  function stop() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function getConversationNetworkInfo(
    cellIdB64: CellIdB64,
  ): ConversationNetworkInfo | null {
    const state = get(store);
    if (!state.metricsPerDna) return null;

    // cellIdB64 encodes [dnaHash, agentPubKey] - extract dna hash (first 39 bytes)
    // We need to find the matching DNA in the metrics response
    const dnaHashB64 = cellIdB64ToDnaHashB64(cellIdB64);
    const metrics = state.metricsPerDna[dnaHashB64];
    if (!metrics) return null;

    const peerMeta = metrics.gossip_state_summary?.peer_meta || {};
    const peerCount = Object.keys(peerMeta).length;

    let lastGossipTimestamp: number | null = null;
    let totalGossipRounds = 0;
    let totalErrors = 0;

    for (const peer of Object.values(peerMeta)) {
      if (
        peer.last_gossip_timestamp != null &&
        (lastGossipTimestamp === null ||
          peer.last_gossip_timestamp > lastGossipTimestamp)
      ) {
        lastGossipTimestamp = peer.last_gossip_timestamp;
      }
      totalGossipRounds +=
        (peer.completed_rounds || 0) + (peer.peer_terminated || 0);
      totalErrors +=
        (peer.local_errors || 0) + (peer.peer_behavior_errors || 0);
    }

    const pendingFetchCount = Object.keys(
      metrics.fetch_state_summary?.pending_requests || {},
    ).length;

    return {
      metrics,
      peerCount,
      lastGossipTimestamp,
      pendingFetchCount,
      totalGossipRounds,
      totalErrors,
    };
  }

  return {
    subscribe: store.subscribe,
    start,
    stop,
    refresh: fetchStats,
    getConversationNetworkInfo,
  };
}

// Derive a store scoped to a specific conversation
export function deriveConversationNetworkStore(
  networkStatsStore: NetworkStatsStore,
  cellIdB64: CellIdB64,
) {
  return derived(networkStatsStore, ($stats) => {
    if (!$stats.metricsPerDna) return null;

    const dnaHashB64 = cellIdB64ToDnaHashB64(cellIdB64);
    const metrics = $stats.metricsPerDna[dnaHashB64];
    if (!metrics) return null;

    const peerMeta = metrics.gossip_state_summary?.peer_meta || {};
    const peerCount = Object.keys(peerMeta).length;

    let lastGossipTimestamp: number | null = null;
    let totalGossipRounds = 0;
    let totalErrors = 0;

    for (const peer of Object.values(peerMeta)) {
      if (
        peer.last_gossip_timestamp != null &&
        (lastGossipTimestamp === null ||
          peer.last_gossip_timestamp > lastGossipTimestamp)
      ) {
        lastGossipTimestamp = peer.last_gossip_timestamp;
      }
      totalGossipRounds +=
        (peer.completed_rounds || 0) + (peer.peer_terminated || 0);
      totalErrors +=
        (peer.local_errors || 0) + (peer.peer_behavior_errors || 0);
    }

    const pendingFetchCount = Object.keys(
      metrics.fetch_state_summary?.pending_requests || {},
    ).length;

    return {
      metrics,
      peerCount,
      lastGossipTimestamp,
      pendingFetchCount,
      totalGossipRounds,
      totalErrors,
    } as ConversationNetworkInfo;
  });
}

function cellIdB64ToDnaHashB64(cellIdB64: CellIdB64): string {
  // CellIdB64 is Base64 of [dnaHash(39 bytes) + agentPubKey(39 bytes)]
  // We need just the dnaHash portion encoded as Base64
  const bytes = Base64.toUint8Array(cellIdB64);
  const dnaHashBytes = bytes.slice(0, 39);
  return encodeHashToBase64(dnaHashBytes);
}
