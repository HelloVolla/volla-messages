import { invoke } from "@tauri-apps/api/core";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enqueueNotification } from "$lib/utils";

/**
 * Tell users about new versions, and get them there.
 *
 * Two levels:
 * - **Major** (1.x → 2.0): 2.0 runs on a Holochain version that cannot talk to
 *   1.x, so contacts who updated stop receiving this user's messages. Red bar
 *   that cannot be dismissed, and a notification at most once a day.
 * - **Normal** (e.g. 1.0.4 → 1.0.5): a neutral bar the user can dismiss until
 *   the next version, and one notification per version.
 *
 * Channels follow GitHub: an installation whose own version is published as a
 * pre-release is on the tester channel and is offered pre-releases too;
 * everyone else only sees releases. Promoting a pre-release moves everyone on
 * it to the regular channel.
 *
 * Releases are read from GitHub's API, which (unlike release downloads) allows
 * cross-origin requests from the webview, at most once a day.
 */

export type InstallKind = "windows" | "macos" | "appimage" | "deb" | "android" | "ubuntu-touch";

export interface AvailableUpdate {
  version: string;
  tag: string;
  /** A new major version: the network changes, so it is urgent. */
  major: boolean;
  kind: InstallKind;
}

interface Release {
  tag: string;
  version: string;
  prerelease: boolean;
  /** Milliseconds since the epoch. */
  publishedAt: number;
}

const REPO = "HelloVolla/volla-messages";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const releasePage = (tag: string) => `https://github.com/${REPO}/releases/tag/${tag}`;
/** The Lite app runs on the Android service runtime and has no 2.0 build yet. */
const LITE_IDENTIFIER = "com.volla.messages";
/** Opens F-Droid on this app; Volla's repos and GitHub APKs share one signing key. */
const fdroidUrl = (identifier: string) => `market://details?id=${identifier}`;
const OPENSTORE_URL = "openstore://volla-messages.volla";
const OPENSTORE_WEB_URL = "https://open-store.io/app/volla-messages.volla";

const DAY_MS = 24 * 60 * 60 * 1000;
/** F-Droid repos and OpenStore pick a release up on their nightly sync. */
const STORE_DELAY_MS = DAY_MS;

const LAST_CHECK_KEY = "UPDATE.LAST_CHECK";
const RELEASES_KEY = "UPDATE.RELEASES";
const LAST_NOTIFIED_KEY = "UPDATE.LAST_NOTIFIED";
const NOTIFIED_VERSION_KEY = "UPDATE.NOTIFIED_VERSION";
const DISMISSED_VERSION_KEY = "UPDATE.DISMISSED_VERSION";
/** Dev only: pretend this version is released (`"2.0.0"`, or `"1.9.0-pre"` for a pre-release). */
const TEST_VERSION_KEY = "UPDATE.TEST_VERSION";

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

/** `[major, minor, patch]` of a version such as `1.0.4` or `v2.0.0`. */
function parts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((p) => Number.parseInt(p, 10) || 0);
}

function compare(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Published releases and pre-releases, from GitHub at most once a day. */
async function releases(): Promise<Release[]> {
  if (import.meta.env.DEV) {
    const test = localStorage.getItem(TEST_VERSION_KEY);
    if (test) {
      const prerelease = test.endsWith("-pre");
      const version = test.replace(/-pre$/, "");
      return [{ tag: `v${version}`, version, prerelease, publishedAt: 0 }];
    }
  }

  const lastCheck = readLocal<number>(LAST_CHECK_KEY) ?? 0;
  const cached = readLocal<Release[]>(RELEASES_KEY);
  if (cached && Date.now() - lastCheck < DAY_MS) return cached;

  const response = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return cached ?? [];

  // Only app releases: the repository also publishes happ releases (`happ-v…`).
  const fetched: Release[] = (await response.json())
    .filter((r: any) => !r.draft && /^v\d/.test(String(r.tag_name)))
    .map((r: any) => ({
      tag: String(r.tag_name),
      version: String(r.tag_name).replace(/^v/, ""),
      prerelease: Boolean(r.prerelease),
      publishedAt: Date.parse(r.published_at ?? "") || Date.now(),
    }));
  writeLocal(LAST_CHECK_KEY, Date.now());
  writeLocal(RELEASES_KEY, fetched);
  return fetched;
}

/** The newest version this installation can move to, if there is one. */
export async function checkForUpdate(): Promise<AvailableUpdate | undefined> {
  try {
    const [identifier, current, all] = await Promise.all([
      getIdentifier(),
      getVersion(),
      releases(),
    ]);
    const onTesterChannel = all.find((r) => r.version === current)?.prerelease ?? false;

    const newest = all
      .filter((r) => (onTesterChannel || !r.prerelease) && compare(r.version, current) > 0)
      .sort((a, b) => compare(b.version, a.version))[0];
    if (!newest) return undefined;

    const major = parts(newest.version)[0] > parts(current)[0];
    if (major && identifier === LITE_IDENTIFIER) return undefined;

    const kind = await invoke<InstallKind>("install_kind");
    // Store-updated installs only see a release after the store has synced.
    const viaStore = kind === "android" || kind === "ubuntu-touch";
    if (viaStore && Date.now() - newest.publishedAt < STORE_DELAY_MS) return undefined;

    return { version: newest.version, tag: newest.tag, major, kind };
  } catch (e) {
    console.warn("[update] check failed", e);
    return undefined;
  }
}

/** A normal update the user chose to hide stays hidden until a newer one. */
export function isDismissed(update: AvailableUpdate): boolean {
  return !update.major && readLocal<string>(DISMISSED_VERSION_KEY) === update.version;
}

export function dismiss(update: AvailableUpdate): void {
  writeLocal(DISMISSED_VERSION_KEY, update.version);
}

/** A system notification: daily for a major update, once per version otherwise. */
export async function notifyAboutUpdate(
  update: AvailableUpdate,
  title: string,
  body: string,
): Promise<void> {
  if (update.major) {
    const lastNotified = readLocal<number>(LAST_NOTIFIED_KEY) ?? 0;
    if (Date.now() - lastNotified < DAY_MS) return;
    writeLocal(LAST_NOTIFIED_KEY, Date.now());
  } else {
    if (readLocal<string>(NOTIFIED_VERSION_KEY) === update.version) return;
    writeLocal(NOTIFIED_VERSION_KEY, update.version);
  }
  await enqueueNotification(title, body);
}

/**
 * Start the update for this kind of installation.
 *
 * Self-updating desktop builds run `flushExports` first: after the restart the
 * new version runs, and for a major update only this one can still write the
 * migration export. Resolves for store/download links; desktop installs restart.
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
      await invoke("install_desktop_update", { tag: update.tag });
      return;
    case "android":
      try {
        await openUrl(fdroidUrl(await getIdentifier()));
      } catch {
        await openUrl(releasePage(update.tag));
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
      await openUrl(releasePage(update.tag));
      return;
  }
}

/** Where to send someone whose in-app installation failed. */
export function openReleasePage(update: AvailableUpdate): Promise<void> {
  return openUrl(releasePage(update.tag));
}
