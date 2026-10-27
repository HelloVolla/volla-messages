// Turn on Tauri's signed updater files for a desktop release build.
//
// Kept out of tauri.desktop.conf.json on purpose: with it on, every
// `tauri build` needs TAURI_SIGNING_PRIVATE_KEY, which only CI has.
// Run after the desktop config has been copied to src-tauri/tauri.conf.json.
import { readFileSync, writeFileSync } from "node:fs";

const path = "src-tauri/tauri.conf.json";
const config = JSON.parse(readFileSync(path, "utf8"));

if (!config.plugins?.updater?.pubkey) {
  throw new Error(`${path} has no updater public key; is it the desktop config?`);
}

config.bundle = { ...config.bundle, createUpdaterArtifacts: true };
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Enabled updater artifacts in ${path}`);
