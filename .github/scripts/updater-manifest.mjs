// Build the `latest.json` the in-app updater reads (src-tauri/src/app_update.rs).
//
// Every release, pre-releases included, carries its own manifest, and the app
// asks for exactly `releases/download/<tag>/latest.json`.
//
// The updater looks up `<os>-<arch>-<installer>` first and falls back to
// `<os>-<arch>` (tauri-plugin-updater 2.12, `get_urls`); the installer part is
// only known when the bundler stamped it into the binary, so both are written.

import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Check a Tauri updater signature the way the app will, so a release signed
 * with the wrong key, or changed after signing, fails here and not on users'
 * machines. Both values are base64 of minisign text files.
 *
 * @param {object} input
 * @param {string} input.pubkey     `plugins.updater.pubkey` from the app config
 * @param {string} input.signature  contents of the `.sig` file
 * @param {Buffer} input.data       the signed file
 */
export function verifySignature({ pubkey, signature, data }) {
  const key = minisignLine(pubkey, "public key");
  const sig = minisignLine(signature, "signature");
  if (key.length !== 42 || sig.length !== 74) throw new Error("Malformed key or signature");

  const keyId = key.subarray(2, 10);
  if (!sig.subarray(2, 10).equals(keyId)) {
    throw new Error(
      `Signed with key ${hex(sig.subarray(2, 10))}, but the app trusts ${hex(keyId)}`,
    );
  }

  // "ED" signs the BLAKE2b-512 hash of the file (what Tauri writes); "Ed" the file itself.
  const algorithm = sig.subarray(0, 2).toString("latin1");
  let message;
  if (algorithm === "ED") message = createHash("blake2b512").update(data).digest();
  else if (algorithm === "Ed") message = data;
  else throw new Error(`Unknown signature algorithm ${algorithm}`);

  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.subarray(10).toString("base64url") },
    format: "jwk",
  });
  if (!verify(null, message, publicKey, sig.subarray(10))) {
    throw new Error("Signature does not match the file");
  }
}

/** The binary second line of a minisign key or signature file. */
function minisignLine(base64Text, what) {
  const lines = Buffer.from(base64Text.trim(), "base64").toString("utf8").split("\n");
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[1]) {
    throw new Error(`Not a minisign ${what}`);
  }
  return Buffer.from(lines[1].trim(), "base64");
}

const hex = (bytes) => bytes.toString("hex").toUpperCase();

/** Signature file name pattern → the manifest keys it serves. */
const PLATFORMS = [
  { pattern: /_amd64\.AppImage\.sig$/, keys: ["linux-x86_64-appimage", "linux-x86_64"] },
  { pattern: /_aarch64\.AppImage\.sig$/, keys: ["linux-aarch64-appimage", "linux-aarch64"] },
  { pattern: /_aarch64\.app\.tar\.gz\.sig$/, keys: ["darwin-aarch64-app", "darwin-aarch64"] },
  { pattern: /_(x64|x86_64)\.app\.tar\.gz\.sig$/, keys: ["darwin-x86_64-app", "darwin-x86_64"] },
  // NSIS is the default for Windows: it can update in place without admin rights.
  { pattern: /_x64-setup\.exe\.sig$/, keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { pattern: /_x64_[A-Za-z-]+\.msi\.sig$/, keys: ["windows-x86_64-msi"] },
];

/**
 * Every platform a desktop release builds; a missing one fails the release.
 * The app asks for `windows-x86_64-msi` / `-nsis` by name (app_update.rs), and
 * an explicit target has no fallback, so both must be present.
 */
export const REQUIRED = [
  "windows-x86_64",
  "windows-x86_64-nsis",
  "windows-x86_64-msi",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
];

/**
 * @param {object} input
 * @param {string} input.repo      `owner/name`
 * @param {string} input.tag       release tag, e.g. `v1.0.4`
 * @param {string} input.notes
 * @param {string} input.pubDate   RFC 3339
 * @param {{ name: string, signature?: string }[]} input.assets
 *   release assets; `.sig` assets carry their file contents in `signature`
 */
export function buildManifest({ repo, tag, notes, pubDate, assets }) {
  const names = new Set(assets.map((a) => a.name));
  const platforms = {};

  for (const asset of assets) {
    const platform = PLATFORMS.find((p) => p.pattern.test(asset.name));
    if (!platform) continue;

    const target = asset.name.slice(0, -".sig".length);
    if (!names.has(target)) {
      throw new Error(`${asset.name} has no matching ${target} in the release`);
    }
    const signature = asset.signature?.trim();
    if (!signature) throw new Error(`${asset.name} is empty`);

    for (const key of platform.keys) {
      if (platforms[key]) throw new Error(`Two release assets claim ${key}`);
      platforms[key] = {
        signature,
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(target)}`,
      };
    }
  }

  const missing = REQUIRED.filter((key) => !platforms[key]);
  if (missing.length > 0) {
    throw new Error(`No signed update for: ${missing.join(", ")}`);
  }

  return {
    version: tag.replace(/^v/, ""),
    notes,
    pub_date: pubDate,
    platforms,
  };
}
