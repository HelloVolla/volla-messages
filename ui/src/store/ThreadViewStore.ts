import { writable, derived } from "svelte/store";
import type { CellIdB64 } from "$lib/types";

const STORAGE_KEY = (cellIdB64: CellIdB64) => `volla:threadView:${cellIdB64}`;

const threadViewStore = writable<Record<CellIdB64, boolean>>({});

function loadFromStorage(cellIdB64: CellIdB64): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY(cellIdB64)) === "true";
  } catch {
    return false;
  }
}

function ensureLoaded(cellIdB64: CellIdB64): void {
  threadViewStore.update((s) => {
    if (cellIdB64 in s) return s;
    return { ...s, [cellIdB64]: loadFromStorage(cellIdB64) };
  });
}

export function deriveThreadViewEnabled(cellIdB64: CellIdB64) {
  ensureLoaded(cellIdB64);
  return derived(threadViewStore, ($s) => $s[cellIdB64] ?? false);
}

export function toggleThreadView(cellIdB64: CellIdB64): void {
  ensureLoaded(cellIdB64);
  threadViewStore.update((s) => {
    const next = !(s[cellIdB64] ?? false);
    try {
      localStorage.setItem(STORAGE_KEY(cellIdB64), String(next));
    } catch {
      /* ignore storage errors */
    }
    return { ...s, [cellIdB64]: next };
  });
}
