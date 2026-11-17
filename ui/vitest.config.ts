import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import path from "path";

// Standalone config for component/unit tests. It deliberately does NOT load the app's
// vite.config.ts (SvelteKit plugin, node polyfills, internal-ip) — those pull in the whole
// dev server. Components under test only need the Svelte compiler and the path aliases.
export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
      $store: path.resolve("./src/store"),
      $config: path.resolve("./src/config"),
      $translations: path.resolve("./src/translations"),
    },
    // Use the browser build of Svelte so components mount in jsdom.
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.ts"],
  },
});
