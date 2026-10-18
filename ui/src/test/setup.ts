import "@testing-library/jest-dom/vitest";
import { readable } from "svelte/store";
import { vi } from "vitest";

// The i18n store is initialised by the SvelteKit app at runtime; in unit tests we stub it so
// components that call $t render the key back instead of booting the loader.
vi.mock("$translations/index", () => ({
  t: readable((key: string) => key),
}));
vi.mock("$translations", () => ({
  t: readable((key: string) => key),
}));

// jsdom does not implement media APIs; components that touch them should not crash under test.
if (!("srcObject" in HTMLMediaElement.prototype)) {
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() {
      return this._srcObject ?? null;
    },
    set(v) {
      this._srcObject = v;
    },
  });
}
HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
HTMLMediaElement.prototype.pause = vi.fn();
