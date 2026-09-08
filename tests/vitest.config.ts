import { defineConfig } from "vitest/config";

// Tryorama scenarios boot real Holochain conductors and wait for DHT sync,
// so the default 5s test/hook timeouts are far too short. Give them room.
// Run test files sequentially: each file boots multiple conductors, and
// running the files concurrently starves them into flaky timeouts.
export default defineConfig({
  test: {
    testTimeout: 60 * 1000 * 4,
    hookTimeout: 60 * 1000 * 4,
    fileParallelism: false,
  },
});
