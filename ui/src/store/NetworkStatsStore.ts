import { writable, derived, get } from "svelte/store";
import type {
  AppClient,
  DumpNetworkMetricsResponse,
  TransportStats,
  NetworkMetrics,
  LocalAgentSummary,
  GossipRoundStateSummary,
  AgentInfoResponse,
} from "@holochain/client";
import { AppWebsocket } from "@holochain/client";
import { encodeHashToBase64 } from "@holochain/client";
import { Base64 } from "js-base64";
import { NETWORK_STATS_POLL_INTERVAL } from "$config";
import type { CellIdB64 } from "$lib/types";
import type { RelayClient } from "$store/RelayClient";

const TAG = "[NET]";
const MAX_EVENTS = 500;

export type DiagnosticEventType =
  | "peer_discovered"
  | "peer_lost"
  | "conn_opened"
  | "conn_closed"
  | "conn_direct_upgrade"
  | "gossip_completed"
  | "gossip_error"
  | "gossip_timeout"
  | "peer_backoff"
  | "poll_error"
  | "conductor_log";

export interface DiagnosticEvent {
  timestamp: number;
  type: DiagnosticEventType;
  dna?: string;
  peer?: string;
  detail: string;
}

export interface ConversationNetworkInfo {
  metrics: NetworkMetrics | null;
  peerCount: number;
  lastGossipTimestamp: number | null;
  pendingFetchCount: number;
  totalGossipRounds: number;
  totalErrors: number;
  totalTimeouts: number;
  totalBusy: number;
  peersBehindCount: number;
  localOpCount: number;
  activeGossipRounds: GossipRoundStateSummary[];
  localAgents: LocalAgentSummary[];
}

export interface NetworkStatsStoreData {
  transportStats: TransportStats | null;
  metricsPerDna: DumpNetworkMetricsResponse | null;
  agentInfo: AgentInfoResponse | null;
  lastUpdated: number | null;
  diagnosticEvents: DiagnosticEvent[];
  pollCount: number;
}

export interface NetworkStatsStore {
  subscribe: typeof store.subscribe;
  start: () => void;
  stop: () => void;
  refresh: () => Promise<void>;
  getConversationNetworkInfo: (cellIdB64: CellIdB64) => ConversationNetworkInfo | null;
  copyDiagnostics: () => string;
}

let store: ReturnType<typeof writable<NetworkStatsStoreData>>;

export function createNetworkStatsStore(client: AppClient, relayClient?: RelayClient): NetworkStatsStore {
  store = writable<NetworkStatsStoreData>({
    transportStats: null,
    metricsPerDna: null,
    agentInfo: null,
    lastUpdated: null,
    diagnosticEvents: [],
    pollCount: 0,
  });

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let prevConnKeys = new Set<string>();
  let prevDirectKeys = new Set<string>();
  let prevPeersByDna = new Map<string, Set<string>>();
  let prevRoundsByDna = new Map<string, number>();
  let prevErrorsByDna = new Map<string, number>();
  let prevTimeoutsByDna = new Map<string, number>();
  let prevLocalOpsByDna = new Map<string, number>();
  let prevPeerOpsByDna = new Map<string, Map<string, number>>();
  let prevBookmarkByDna = new Map<string, Map<string, number>>();
  let prevPeerBusyByDna = new Map<string, Map<string, number>>();

  const emit = (event: Omit<DiagnosticEvent, "timestamp">) => {
    const full: DiagnosticEvent = { ...event, timestamp: Date.now() };
    store.update((s) => ({
      ...s,
      diagnosticEvents: [...s.diagnosticEvents, full].slice(-MAX_EVENTS),
    }));
  };

  const diffTransport = (transport: TransportStats) => {
    const currentKeys = new Set(transport.connections.map((c) => c.pub_key));

    for (const conn of transport.connections) {
      if (!prevConnKeys.has(conn.pub_key)) {
        const age = Math.floor(Date.now() / 1000 - conn.opened_at_s);
        const msg = `Connected to ${shortKey(conn.pub_key)} (direct=${(conn as any).is_direct}, age=${age}s)`;
        emit({ type: "conn_opened", peer: conn.pub_key, detail: msg });
        console.log(`${TAG} ${msg}`);
      }
      if ((conn as any).is_direct && !prevDirectKeys.has(conn.pub_key)) {
        const msg = `Direct connection upgrade: ${shortKey(conn.pub_key)}`;
        emit({ type: "conn_direct_upgrade", peer: conn.pub_key, detail: msg });
        console.log(`${TAG} ${msg}`);
      }
    }

    for (const key of prevConnKeys) {
      if (!currentKeys.has(key)) {
        const msg = `Disconnected from ${shortKey(key)}`;
        emit({ type: "conn_closed", peer: key, detail: msg });
        console.warn(`${TAG} ${msg}`);
      }
    }

    prevConnKeys = currentKeys;
    prevDirectKeys = new Set(transport.connections.filter((c) => (c as any).is_direct).map((c) => c.pub_key));
  };

  const diffMetrics = (metricsPerDna: DumpNetworkMetricsResponse) => {
    for (const [dna, metrics] of Object.entries(metricsPerDna)) {
      const d = dna.slice(0, 8);
      const peerMeta = metrics.gossip_state_summary?.peer_meta || {};
      const currentPeers = new Set(Object.keys(peerMeta));
      const prevPeers = prevPeersByDna.get(dna) || new Set();

      for (const url of currentPeers) {
        if (!prevPeers.has(url)) {
          emit({ type: "peer_discovered", dna, peer: url, detail: `${d}: new gossip peer` });
          console.log(`${TAG} ${d}: new gossip peer discovered`);
        }
      }
      for (const url of prevPeers) {
        if (!currentPeers.has(url)) {
          emit({ type: "peer_lost", dna, peer: url, detail: `${d}: gossip peer lost` });
          console.warn(`${TAG} ${d}: gossip peer lost`);
        }
      }

      let rounds = 0, errors = 0, timeouts = 0;
      for (const peer of Object.values(peerMeta)) {
        rounds += (peer.completed_rounds || 0) + (peer.peer_terminated || 0);
        errors += (peer.local_errors || 0) + (peer.peer_behavior_errors || 0);
        timeouts += peer.peer_timeouts || 0;
      }

      const prevR = prevRoundsByDna.get(dna) || 0;
      if (rounds > prevR) {
        emit({ type: "gossip_completed", dna, detail: `${d}: +${rounds - prevR} gossip round(s) (total: ${rounds})` });
      }
      const prevE = prevErrorsByDna.get(dna) || 0;
      if (errors > prevE) {
        emit({ type: "gossip_error", dna, detail: `${d}: +${errors - prevE} error(s) (total: ${errors})` });
        console.warn(`${TAG} ${d}: +${errors - prevE} gossip error(s)`);
      }
      const prevT = prevTimeoutsByDna.get(dna) || 0;
      if (timeouts > prevT) {
        emit({ type: "gossip_timeout", dna, detail: `${d}: +${timeouts - prevT} timeout(s) (total: ${timeouts})` });
        console.warn(`${TAG} ${d}: +${timeouts - prevT} timeout(s)`);
      }

      const localOps = (metrics.gossip_state_summary as any)?.local_op_count ?? 0;
      const prevLocalOps = prevLocalOpsByDna.get(dna) || 0;
      const localOpDelta = localOps - prevLocalOps;
      if (localOpDelta > 0 && prevLocalOps > 0) {
        const msg = `${d}: +${localOpDelta} local ops (${prevLocalOps} → ${localOps})`;
        emit({ type: "gossip_completed", dna, detail: msg });
        console.log(`${TAG} ${msg}`);
      }

      const prevPeerOps = prevPeerOpsByDna.get(dna) || new Map<string, number>();
      const prevBookmarks = prevBookmarkByDna.get(dna) || new Map<string, number>();
      const prevPeerBusy = prevPeerBusyByDna.get(dna) || new Map<string, number>();
      const curPeerOps = new Map<string, number>();
      const curBookmarks = new Map<string, number>();
      const curPeerBusy = new Map<string, number>();

      for (const [url, p] of Object.entries(peerMeta) as [string, any][]) {
        const peerOps = p.dht_op_count ?? 0;
        const prevOps = prevPeerOps.get(url) || 0;
        const peerOpDelta = peerOps - prevOps;
        curPeerOps.set(url, peerOps);

        const bookmark = p.new_ops_bookmark ?? 0;
        const prevBm = prevBookmarks.get(url) || 0;
        curBookmarks.set(url, bookmark);

        const busy = p.peer_busy || 0;
        const prevBusy = prevPeerBusy.get(url) || 0;
        curPeerBusy.set(url, busy);

        const gap = localOps - peerOps;
        const syncPct = localOps > 0 ? Math.round((peerOps / localOps) * 100) : 100;
        const bookmarkAgeS = bookmark ? Math.floor((Date.now() - bookmark / 1000) / 1000) : -1;
        const bookmarkAdvanced = bookmark > prevBm;

        if (peerOpDelta > 0 && prevOps > 0) {
          console.log(`${TAG} ${d}: peer ..${url.slice(-12)} +${peerOpDelta} ops (${prevOps} → ${peerOps}, sync=${syncPct}%)`);
        }

        if (busy > prevBusy) {
          const msg = `${d}: peer ..${url.slice(-12)} BUSY +${busy - prevBusy} (total=${busy}) — peer at max accepted rounds`;
          emit({ type: "peer_backoff", dna, peer: url, detail: msg });
          console.warn(`${TAG} ${msg}`);
        }

        if (gap > 0) {
          const msg = `${d}: peer ..${url.slice(-12)} behind by ${gap} ops (sync=${syncPct}%, local=${localOps} peer=${peerOps})`;
          emit({ type: "peer_backoff", dna, peer: url, detail: msg });
          if (gap > 5) console.warn(`${TAG} ${msg}`);
        }

        if (bookmarkAgeS > 120 && !bookmarkAdvanced && gap > 0) {
          const msg = `${d}: peer ..${url.slice(-12)} bookmark stale ${bookmarkAgeS}s with ${gap} ops gap, gossip may be stuck`;
          emit({ type: "peer_backoff", dna, peer: url, detail: msg });
          console.warn(`${TAG} ${msg}`);
        }
      }

      prevPeersByDna.set(dna, currentPeers);
      prevRoundsByDna.set(dna, rounds);
      prevErrorsByDna.set(dna, errors);
      prevTimeoutsByDna.set(dna, timeouts);
      prevLocalOpsByDna.set(dna, localOps);
      prevPeerOpsByDna.set(dna, curPeerOps);
      prevBookmarkByDna.set(dna, curBookmarks);
      prevPeerBusyByDna.set(dna, curPeerBusy);
      prevBookmarkByDna.set(dna, curBookmarks);
    }
  };

  const fetchStats = async () => {
    const t0 = Date.now();
    try {
      const ws = client as AppWebsocket;
      const [stats, metrics, agents] = await Promise.allSettled([
        client.dumpNetworkStats(),
        client.dumpNetworkMetrics({ include_dht_summary: true }),
        ws.agentInfo({ dna_hashes: null }),
      ]);

      if (relayClient) {
        try {
          const cellInfos = await relayClient.getRelayClonedCellInfos();
          console.log(`${TAG} ZOME diagnostics: ${cellInfos.length} cloned cell(s)`);
          for (const cellInfo of cellInfos) {
            try {
              const diag = await relayClient.getNetworkDiagnostics(cellInfo.cell_id);
              const dnaB64 = encodeHashToBase64(cellInfo.cell_id[0]).slice(0, 8);
              console.log(
                `${TAG} ZOME ${dnaB64}: ` +
                `chain=${diag.source_chain_length} creates=${diag.create_count} ` +
                `updates=${diag.update_count} deletes=${diag.delete_count} ` +
                `links=${diag.create_link_count} unlinks=${diag.delete_link_count}`
              );
            } catch (e) {
              console.error(`${TAG} ZOME call failed:`, e);
            }
          }
        } catch (e) {
          console.error(`${TAG} ZOME getRelayClonedCellInfos failed:`, e);
        }
      } else {
        console.log(`${TAG} ZOME diagnostics: no relayClient`);
      }

      const dt = Date.now() - t0;
      const prev = get(store);
      const pollCount = prev.pollCount + 1;

      if (stats.status === "fulfilled") {
        const t = stats.value.transport_stats;
        console.log(`${TAG} RAW dumpNetworkStats:`, JSON.parse(JSON.stringify(t)));
        const sent = t.connections.reduce((s, c) => s + c.send_bytes, 0);
        const recv = t.connections.reduce((s, c) => s + c.recv_bytes, 0);
        const direct = t.connections.filter((c) => (c as any).is_direct).length;
        console.log(
          `${TAG} #${pollCount} (${dt}ms) ${t.backend} | ` +
          `${t.connections.length} conn (${direct} direct) | ` +
          `tx=${fmtBytes(sent)} rx=${fmtBytes(recv)} | ` +
          `urls=${t.peer_urls?.length || 0}`
        );
        diffTransport(t);
      } else {
        console.error(`${TAG} #${pollCount} dumpNetworkStats failed:`, stats.reason);
        emit({ type: "poll_error", detail: `dumpNetworkStats: ${stats.reason}` });
      }

      if (metrics.status === "fulfilled") {
        console.log(`${TAG} RAW dumpNetworkMetrics:`, JSON.parse(JSON.stringify(metrics.value)));
        diffMetrics(metrics.value);
        for (const [dna, m] of Object.entries(metrics.value)) {
          const gossip = m.gossip_state_summary as any;
          const peerMeta = gossip?.peer_meta || {};
          const peerCount = Object.keys(peerMeta).length;
          const pending = Object.keys(m.fetch_state_summary?.pending_requests || {}).length;
          const initiated = gossip?.initiated_round ? 1 : 0;
          const accepted = gossip?.accepted_rounds?.length || 0;
          const localOps = gossip?.local_op_count ?? "?";
          console.log(
            `${TAG}   ${dna.slice(0, 8)}: ${peerCount} peer(s), ` +
            `${pending} pending, ${initiated}+${accepted} rounds (init+accept), ` +
            `local_ops=${localOps}`
          );
          if (accepted >= 8) {
            const msg = `${dna.slice(0, 8)}: accepted rounds at ${accepted}/10 — nearing capacity`;
            emit({ type: "peer_backoff", dna, detail: msg });
            console.warn(`${TAG} ${msg}`);
          }
          if (pending > 10) {
            const msg = `${dna.slice(0, 8)}: ${pending} ops in fetch queue — slow sync`;
            emit({ type: "peer_backoff", dna, detail: msg });
            console.warn(`${TAG} ${msg}`);
          }
          for (const [url, p] of Object.entries(peerMeta) as [string, any][]) {
            const age = p.last_gossip_timestamp
              ? `${Math.floor((Date.now() - p.last_gossip_timestamp / 1000) / 1000)}s ago`
              : "never";
            const bookmark = p.new_ops_bookmark
              ? `${Math.floor((Date.now() - p.new_ops_bookmark / 1000) / 1000)}s ago`
              : "never";
            console.log(
              `${TAG}     peer ..${url.slice(-12)}: ` +
              `rounds=${p.completed_rounds || 0} term=${p.peer_terminated || 0} ` +
              `errs=${(p.local_errors || 0) + (p.peer_behavior_errors || 0)} ` +
              `timeouts=${p.peer_timeouts || 0} busy=${p.peer_busy || 0} ` +
              `ops=${p.dht_op_count ?? "?"} tombstone=${p.is_tombstone ?? "?"} ` +
              `last_gossip=${age} bookmark=${bookmark}`
            );
          }
        }
      } else {
        console.error(`${TAG} #${pollCount} dumpNetworkMetrics failed:`, metrics.reason);
        emit({ type: "poll_error", detail: `dumpNetworkMetrics: ${metrics.reason}` });
      }

      if (agents.status === "fulfilled") {
        console.log(`${TAG} RAW agentInfo (${agents.value.length} entries across all DNAs):`, JSON.parse(JSON.stringify(agents.value)));
      }

      store.update((s) => ({
        ...s,
        transportStats: stats.status === "fulfilled" ? stats.value.transport_stats : s.transportStats,
        metricsPerDna: metrics.status === "fulfilled" ? metrics.value : s.metricsPerDna,
        agentInfo: agents.status === "fulfilled" ? agents.value : s.agentInfo,
        lastUpdated: Date.now(),
        pollCount,
      }));
    } catch (e) {
      console.error(`${TAG} poll failed:`, e);
      emit({ type: "poll_error", detail: `${e}` });
    }
  }

  let detachLogger: (() => void) | null = null;

  const CONDUCTOR_LOG_FILTERS = [
    "kitsune2_gossip", "kitsune2_core", "kitsune2_dht", "kitsune2_api",
    "kitsune2_bootstrap", "kitsune2_transport", "holochain_p2p",
    "gossip", "fetch", "peer", "round", "ops", "sync", "publish",
    "connect", "disconnect", "timeout", "backoff", "tombstone",
  ];

  const attachConductorLogs = async () => {
    try {
      const { attachLogger } = await import("@tauri-apps/plugin-log");
      detachLogger = await attachLogger(({ level, message }) => {
        const lower = message.toLowerCase();
        const match = CONDUCTOR_LOG_FILTERS.some((f) => lower.includes(f));
        if (!match) return;

        const levelStr = level <= 2 ? "DBG" : level === 3 ? "INF" : level === 4 ? "WRN" : "ERR";
        const short = message.length > 200 ? message.slice(0, 200) + "…" : message;
        emit({ type: "conductor_log", detail: `[${levelStr}] ${short}` });
      });
      console.log(`${TAG} conductor log listener attached`);
    } catch (_) {
      // not in Tauri context
    }
  };

  const start = () => {
    if (pollInterval) return;
    console.log(`${TAG} polling started (interval=${NETWORK_STATS_POLL_INTERVAL}ms)`);
    attachConductorLogs();
    fetchStats();
    pollInterval = setInterval(fetchStats, NETWORK_STATS_POLL_INTERVAL);
  };

  const stop = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
      console.log(`${TAG} polling stopped`);
    }
    if (detachLogger) {
      detachLogger();
      detachLogger = null;
    }
  };

  const getConversationNetworkInfo = (cellIdB64: CellIdB64): ConversationNetworkInfo | null => {
    const state = get(store);
    if (!state.metricsPerDna) return null;

    const dnaHashB64 = cellIdB64ToDnaHashB64(cellIdB64);
    const metrics = state.metricsPerDna[dnaHashB64];
    if (!metrics) return null;

    return extractConversationNetworkInfo(metrics);
  };

  const copyDiagnostics = (): string => {
    const state = get(store);
    const snap: Record<string, unknown> = {
      capturedAt: new Date().toISOString(),
      pollCount: state.pollCount,
      transport: null as unknown,
      dna: {} as Record<string, unknown>,
      events: state.diagnosticEvents.slice(-50).map((e) => ({
        ...e,
        time: new Date(e.timestamp).toISOString(),
      })),
    };

    if (state.transportStats) {
      const t = state.transportStats;
      snap.transport = {
        backend: t.backend,
        peerUrls: t.peer_urls || [],
        connections: t.connections.map((c) => ({
          pubKey: c.pub_key,
          direct: (c as any).is_direct,
          ageSec: Math.floor(Date.now() / 1000 - c.opened_at_s),
          tx: c.send_bytes,
          rx: c.recv_bytes,
          txMsgs: c.send_message_count,
          rxMsgs: c.recv_message_count,
        })),
      };
    }

    if (state.metricsPerDna) {
      for (const [dna, m] of Object.entries(state.metricsPerDna)) {
        const peerMeta = m.gossip_state_summary?.peer_meta || {};
        const localOps = (m.gossip_state_summary as any)?.local_op_count;

        (snap.dna as Record<string, unknown>)[dna] = {
          localOpCount: localOps,
          peers: Object.entries(peerMeta).map(([url, p]: [string, any]) => ({
            url,
            lastGossip: p.last_gossip_timestamp ? new Date(p.last_gossip_timestamp / 1000).toISOString() : null,
            opsBookmark: p.new_ops_bookmark ? new Date(p.new_ops_bookmark / 1000).toISOString() : null,
            rounds: p.completed_rounds || 0,
            terminated: p.peer_terminated || 0,
            errors: (p.local_errors || 0) + (p.peer_behavior_errors || 0),
            timeouts: p.peer_timeouts || 0,
            busy: p.peer_busy || 0,
            dhtOps: p.dht_op_count,
            tombstone: p.is_tombstone,
            opGap: localOps != null && p.dht_op_count != null ? localOps - p.dht_op_count : null,
          })),
          activeRounds: (m.gossip_state_summary?.initiated_round ? 1 : 0) + (m.gossip_state_summary?.accepted_rounds?.length || 0),
          pendingFetches: Object.keys(m.fetch_state_summary?.pending_requests || {}).length,
          agents: (m.local_agents || []).map((a) => ({
            agent: encodeHashToBase64(a.agent),
            storageArc: a.storage_arc,
            targetArc: a.target_arc,
          })),
        };
      }
    }

    return JSON.stringify(snap, null, 2);
  };

  return {
    subscribe: store.subscribe,
    start,
    stop,
    refresh: fetchStats,
    getConversationNetworkInfo,
    copyDiagnostics,
  };
}

export const deriveConversationNetworkStore = (
  networkStatsStore: NetworkStatsStore,
  cellIdB64: CellIdB64,
) => {
  return derived(networkStatsStore, ($stats) => {
    if (!$stats.metricsPerDna) return null;

    const dnaHashB64 = cellIdB64ToDnaHashB64(cellIdB64);
    const metrics = $stats.metricsPerDna[dnaHashB64];
    if (!metrics) return null;

    return extractConversationNetworkInfo(metrics);
  });
};

const extractConversationNetworkInfo = (metrics: NetworkMetrics): ConversationNetworkInfo => {
  const peerMeta = metrics.gossip_state_summary?.peer_meta || {};
  const peerCount = Object.keys(peerMeta).length;

  let lastGossipTimestamp: number | null = null;
  let totalGossipRounds = 0;
  let totalErrors = 0;
  let totalTimeouts = 0;
  let totalBusy = 0;

  for (const peer of Object.values(peerMeta)) {
    if (peer.last_gossip_timestamp != null &&
      (lastGossipTimestamp === null || peer.last_gossip_timestamp > lastGossipTimestamp)) {
      lastGossipTimestamp = peer.last_gossip_timestamp;
    }
    totalGossipRounds += (peer.completed_rounds || 0) + (peer.peer_terminated || 0);
    totalErrors += (peer.local_errors || 0) + (peer.peer_behavior_errors || 0);
    totalTimeouts += peer.peer_timeouts || 0;
    totalBusy += peer.peer_busy || 0;
  }

  const pendingFetchCount = Object.keys(metrics.fetch_state_summary?.pending_requests || {}).length;

  const localOps = (metrics.gossip_state_summary as any)?.local_op_count ?? 0;
  let peersBehinCount = 0;
  for (const p of Object.values(peerMeta) as any[]) {
    if (p.dht_op_count != null && localOps > p.dht_op_count) peersBehinCount++;
  }

  const initiated = metrics.gossip_state_summary?.initiated_round;
  const accepted = metrics.gossip_state_summary?.accepted_rounds || [];

  return {
    metrics,
    peerCount,
    lastGossipTimestamp,
    pendingFetchCount,
    totalGossipRounds,
    totalErrors,
    totalTimeouts,
    totalBusy,
    peersBehindCount: peersBehinCount,
    localOpCount: localOps,
    activeGossipRounds: [...(initiated ? [initiated] : []), ...accepted],
    localAgents: metrics.local_agents || [],
  };
};

const cellIdB64ToDnaHashB64 = (cellIdB64: CellIdB64): string => {
  const bytes = Base64.toUint8Array(cellIdB64);
  const dnaHashBytes = bytes.slice(0, 39);
  return encodeHashToBase64(dnaHashBytes);
};

const shortKey = (key: string): string =>
  key.length > 16 ? key.slice(0, 8) + ".." + key.slice(-6) : key;

const fmtBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};
