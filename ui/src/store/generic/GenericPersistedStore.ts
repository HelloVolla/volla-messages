import { writable } from "svelte/store";
import { get as svelteGet } from "svelte/store";
import { encode, decode } from "@msgpack/msgpack";
import { Base64 } from "js-base64";

/** Encode a value the way `persisted` stores it in localStorage. */
export function encodePersisted<T>(val: T): string {
  return Base64.fromUint8Array(encode(val), true);
}

/** Decode a value `persisted` stored in localStorage. */
export function decodePersisted<T>(val: string): T {
  return decode(Base64.toUint8Array(val)) as T;
}

export function persisted<T>(key: string, defaultValue: T) {
  const savedValue = localStorage.getItem(key);
  const data = writable<T>(savedValue ? decodePersisted<T>(savedValue) : defaultValue);
  set(svelteGet(data));

  function set(val: T): void {
    localStorage.setItem(key, encodePersisted(val));
    data.set(val);
  }

  function update(updater: (val: T) => T): void {
    const newVal = updater(svelteGet(data));
    set(newVal);
  }

  return {
    set,
    update,
    subscribe: data.subscribe,
  };
}
