import { persisted } from "./generic/GenericPersistedStore";
import type { ActionHashB64 } from "@holochain/client";

// Starred messages, kept locally and keyed by message action hash (which is
// globally unique). Purely a personal bookmark; nothing is shared with peers.
export const starredMessages = persisted<{ [actionHashB64: ActionHashB64]: boolean }>(
  "MESSAGE.STARRED",
  {},
);

export function toggleStar(actionHashB64: ActionHashB64): void {
  starredMessages.update((s) => {
    if (s[actionHashB64]) {
      const next = { ...s };
      delete next[actionHashB64];
      return next;
    }
    return { ...s, [actionHashB64]: true };
  });
}
