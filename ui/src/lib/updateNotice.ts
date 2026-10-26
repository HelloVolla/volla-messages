import { invoke } from "@tauri-apps/api/core";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enqueueNotification } from "$lib/utils";

/**
 * Tell 1.x users when 2.0 is out, and get them there.
 *
 * 2.0 runs on a new Holochain version that cannot talk to 1.x, so contacts who
 * have updated stop receiving a 1.x user's messages. The app is not blocked; a
 * red bar and a daily notification explain it and offer an Update button.
 *
 * Detection reads the latest *release* (not pre-release) from GitHub's API,
 * which, unlike release downloads, allows cross-origin requests from the
 * webview. Only a new major version counts. How the button updates depends on
 * how the app was installed (`install_kind` in app_update.rs).
 */

export type InstallKind = "windows" | "macos" | "appimage" | "deb" | "android" | "ubuntu-touch";

export interface AvailableUpdate {
  version: string;
  kind: InstallKind;
}

const LATEST_RELEASE_API =
  "https://api.github.com/repos/HelloVolla/volla-messages/releases/latest";
const RELEASES_PAGE = "https://github.com/HelloVolla/volla-messages/releases/latest";
/** Opens F-Droid on the app; Volla's repos and GitHub APKs share one signing key. */
const FDROID_URL = "market://details?id=com.volla.messages.bundled";
const OPENSTORE_URL = "openstore://volla-messages.volla";
const OPENSTORE_WEB_URL = "https://open-store.io/app/volla-messages.volla";

/** The Lite app (Android service runtime) has no 2.0 build yet. */
const LITE_IDENTIFIER = "com.volla.messages";

const DAY_MS = 24 * 60 * 60 * 1000;
/** F-Droid repos (and OpenStore) pick up a release on their nightly sync. */
const STORE_DELAY_MS = DAY_MS;

const LAST_CHECK_KEY = "UPDATE.LAST_CHECK";
const LATEST_KEY = "UPDATE.LATEST";
const LAST_NOTIFIED_KEY = "UPDATE.LAST_NOTIFIED";
/** Dev only: pretend this version is the latest release, to test the notice. */
const TEST_VERSION_KEY = "UPDATE.TEST_VERSION";

interface LatestRelease {
  version: string;
  /** Milliseconds since the epoch. */
  publishedAt: number;
}

function major(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".")[0], 10);
}

function readLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; the check simply runs again next time.
  }
}

/** The latest release, from GitHub at most once a day. */
async function latestRelease(): Promise<LatestRelease | undefined> {
  if (import.meta.env.DEV) {
    const test = localStorage.getItem(TEST_VERSION_KEY);
    if (test) return { version: test, publishedAt: 0 };
  }

  const lastCheck = readLocal<number>(LAST_CHECK_KEY) ?? 0;
  const cached = readLocal<LatestRelease>(LATEST_KEY);
  if (cached && Date.now() - lastCheck < DAY_MS) return cached;

  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return cached;

  const release = await response.json();
  const latest: LatestRelease = {
    version: String(release.tag_name ?? "").replace(/^v/, ""),
    publishedAt: Date.parse(release.published_at ?? "") || Date.now(),
  };
  writeLocal(LAST_CHECK_KEY, Date.now());
  writeLocal(LATEST_KEY, latest);
  return latest;
}

/** A newer major release this installation can be moved to, if there is one. */
export async function checkForUpdate(): Promise<AvailableUpdate | undefined> {
  try {
    if ((await getIdentifier()) === LITE_IDENTIFIER) return undefined;

    const latest = await latestRelease();
    if (!latest || !(major(latest.version) > major(await getVersion()))) return undefined;

    const kind = await invoke<InstallKind>("install_kind");
    // Store-updated installs only see the release after the store syncs.
    const viaStore = kind === "android" || kind === "ubuntu-touch";
    if (viaStore && Date.now() - latest.publishedAt < STORE_DELAY_MS) return undefined;

    return { version: latest.version, kind };
  } catch (e) {
    console.warn("[update] check failed", e);
    return undefined;
  }
}

/** A system notification about the update, at most once a day. */
export async function notifyAboutUpdate(title: string, body: string): Promise<void> {
  const lastNotified = readLocal<number>(LAST_NOTIFIED_KEY) ?? 0;
  if (Date.now() - lastNotified < DAY_MS) return;
  writeLocal(LAST_NOTIFIED_KEY, Date.now());
  await enqueueNotification(title, body);
}

/**
 * Start the update for this kind of installation.
 *
 * Self-updating desktop builds run `flushExports` first: after the restart the
 * 2.0 version runs, and only this one can still write the migration export.
 * Resolves for store/download links; for desktop installs the app restarts.
 */
export async function startUpdate(
  update: AvailableUpdate,
  flushExports: () => Promise<void>,
): Promise<void> {
  switch (update.kind) {
    case "windows":
    case "macos":
    case "appimage":
      await flushExports();
      await invoke("install_desktop_update");
      return;
    case "android":
      try {
        await openUrl(FDROID_URL);
      } catch {
        await openUrl(RELEASES_PAGE);
      }
      return;
    case "ubuntu-touch":
      try {
        await openUrl(OPENSTORE_URL);
      } catch {
        await openUrl(OPENSTORE_WEB_URL);
      }
      return;
    case "deb":
      await openUrl(RELEASES_PAGE);
      return;
  }
}

/** Where to send someone whose in-app installation failed. */
export function openReleasesPage(): Promise<void> {
  return openUrl(RELEASES_PAGE);
}
