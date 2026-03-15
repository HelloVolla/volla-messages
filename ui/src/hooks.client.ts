import type { HandleClientError } from "@sveltejs/kit";
import { info, warn, error as logError, debug, trace } from "@tauri-apps/plugin-log";

// Forward JS console logs to the Tauri native log plugin.
// On Android this routes to logcat. Requires "log:default" in capabilities/main.json.
function patchConsoleForLogcat() {
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);
  const _debug = console.debug.bind(console);

  const stringify = (...args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  console.log = (...args: unknown[]) => {
    _log(...args);
    info(stringify(...args)).catch(() => {});
  };
  console.warn = (...args: unknown[]) => {
    _warn(...args);
    warn(stringify(...args)).catch(() => {});
  };
  console.error = (...args: unknown[]) => {
    _error(...args);
    logError(stringify(...args)).catch(() => {});
  };
  console.debug = (...args: unknown[]) => {
    _debug(...args);
    debug(stringify(...args)).catch(() => {});
  };

  // Emit a test log immediately so we can confirm the bridge works
  info("[VollaMessages:Boot] JS→logcat bridge active").catch(() => {});
}

try {
  patchConsoleForLogcat();
} catch {
  // Not in a Tauri context — ignore silently.
}

export const handleError: HandleClientError = async ({ error, event, status, message }) => {
  const errorId = crypto.randomUUID();

  console.error(`Error ID: ${errorId}`, error, event, status, message);

  return {
    message: `An error occurred: ${message} ${error}`,
    errorId,
  };
};
