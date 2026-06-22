import { defineConfig } from "vitest/config";

// Tryorama scenarios boot real Holochain conductors and wait for DHT sync,
// so the default 5s test/hook timeouts are far too short. Give them room.
export default defineConfig({
  test: {
    testTimeout: 60 * 1000 * 4,
    hookTimeout: 60 * 1000 * 4,
  },
});
