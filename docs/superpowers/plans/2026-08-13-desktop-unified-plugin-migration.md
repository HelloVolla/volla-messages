# Desktop Migration to Unified tauri-plugin-holochain (as part of the hc 0.7 update) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move volla off darksoil's p2p-shipyard plugin and onto the unified in-process `tauri-plugin-holochain` from `holochain/android-service-runtime` (direct Tauri-IPC client, no loopback websocket) — executed **as part of the holochain 0.6.1 → 0.7.0 update**, with a small immediate de-risking phase so the 0.6 line stays buildable in the meantime.

**Architecture:** Part 0 (now): pin/mirror the darksoil git dependency and replace volla's flake with a self-contained dev shell (carries the WebkitGTK 2.52 + EGL fixes from android-service-runtime). Part 1 (0.7 track): bump the happ and workspace to holochain 0.7.0. Part 2 (same track): switch the `holochain_bundled` feature to upstream `android-service-runtime`'s plugin at `main-0.7`, rewrite `builder/holochain_bundled.rs`, implement the coordinator-update path volla needs (app-side, via the runtime's admin port), and upgrade the UI to `@holochain/client` 0.21.0 — version-aligned with the 0.7 conductor, so no wire-compat gate is needed.

**Tech Stack:** Rust (holochain 0.7.0, hdk 0.7.0, hdi 0.8.0, tauri 2.x), TypeScript/Svelte (`@holochain/client` 0.21.0), Nix (holonix main-0.6 → main-0.7).

**Spec:** This document doubles as the spec; "Decision record" below captures the validation.

## Decision record (2026-08-13)

**Decision: defer the plugin migration to the hc 0.7 update instead of backporting the plugin to 0.6.1.** Validated on these facts:

1. **The 0.6 desktop line is not blocked.** `darksoil-studio/tauri-plugin-holochain` (branch `main-0.6.1`, pinned commit `387bf70`) exists and resolves today; it was the separate `p2p-shipyard` repo whose availability was the problem. The darksoil plugin remains usable for 0.6-series volla releases, so there is no forcing function to migrate now.
2. **The client-version mismatch disappears at 0.7.** `@holochain/client` 0.21.0 (which carries the direct Tauri-IPC transport) targets holochain 0.7's App API. Using it against a 0.6.1 conductor needed a wire-compat gate with a messy fallback (backporting the transport onto a 0.20.4 client fork). At 0.7 the client and conductor are release-aligned — the entire risk item vanishes.
3. **The backport itself vanishes.** android-service-runtime `main-0.7` (pushed upstream, holochain-org maintained) builds against holochain 0.7.0 (published stable on crates.io, as are hdk 0.7.0 / hdi 0.8.0). Consuming it directly deletes the four backport tasks (runtime methods + plugin crate port into the volla-cloud-services fork) from the previous plan revision.
4. **The 0.7 update is already a network break.** holochain 0.7 nodes cannot gossip with 0.6.1 nodes, so the 0.7 release is a coordinated cutover for the user base regardless. Folding the plugin/transport swap into it adds no additional user-facing break.
5. **Zome dependencies are ready.** `holochain-open-dev/profiles` and `holochain-open-dev/file-storage` both have `main-0.7` branches.

**Residual risks accepted with mitigations (Part 0):** darksoil availability has flapped once already, and volla's flake.nix still pulls darksoil's dev shell (with the stale WebkitGTK 2.42 pin). Part 0 removes both exposures cheaply and is independent of the 0.7 schedule.

**Open product decisions (flag before Part 1 starts, do not resolve in code):**
- **Message history at 0.7:** volla's `holochain_dir()` is versioned by app major version; the 0.7 release must ship as app version 2.0.0 so the conductor gets a fresh data dir (0.7 cannot open 0.6 databases). Existing conversations/messages do NOT carry over unless an export/import or `restore_from_dht`-based migration is built. This needs a product call; this plan assumes fresh-start (no migration).
- **Android service coordination:** on Volla phones the conductor lives in the system runtime app. The 0.7 client app requires a 0.7 service runtime on-device; that rollout (and syncing/retiring the `volla-cloud-services` 0.6.1 fork in favor of upstream `main-0.7` crates) is tracked as Task 10 but its device-rollout sequencing is a release-management decision.

## Global Constraints

- Part 0 changes nothing about volla's holochain version: `0.6.1-rc.7` stays until Part 1.
- Part 1/2 target versions (exact): `holochain 0.7.0`, `holochain_types 0.7.0`, `hdk 0.7.0`, `hdi 0.8.0`, `@holochain/client 0.21.0`, holonix `main-0.7`. Keep volla's holochain features `["sqlite-encrypted", "wasmer_sys", "transport-iroh"]` (verify the 0.7 feature names in the crate before assuming — android-service-runtime's 0.7 shell builds iroh, so the transport exists).
- Network endpoints (unchanged): bootstrap `https://relay2.volla.tech/`, signal `wss://relay2.volla.tech/`, iroh relay `https://iroh-relay.volla.tech/`, ICE `stun://stun.nextcloud.com:443`. (Confirm relay2/iroh-relay server versions support 0.7 clients — infra task, see Task 5 Step 3.)
- The 0.7 release bumps volla to version `2.0.0` (fresh conductor data dir via `get_version()`).
- Upstream dependency pinning: all git deps on `holochain/android-service-runtime` pin an exact `rev`, not a branch.
- Do not modify `android-service-runtime` locally except via upstream PRs (Task 8 offers one, with a volla-local fallback).
- Commit messages: no Claude co-author footers.

## Repos and paths

| Alias | Path |
|---|---|
| `volla` | `/home/eric/code/metacurrency/holochain/volla` |
| `asr` | `/home/eric/code/metacurrency/holochain/android-service-runtime` (branch `main-0.7` = upstream; local is 1 commit ahead — push `81193a9` first or pin the pushed `791b15e`) |
| `dsp` | `/home/eric/code/metacurrency/holochain/tauri-plugin-holochain` (darksoil checkout `main-0.6.1` — source for the coordinator-update port, read-only) |
| `vcs` | `/home/eric/code/metacurrency/holochain/volla-cloud-services` (HelloVolla fork, 0.6.1 — Android service track only) |

---

# Part 0: Immediate de-risking (independent of the 0.7 schedule)

Branch in `volla`: `git checkout -b chore/de-risk-darksoil-dep develop`.

### Task 1: Pin the darksoil dependency

**Files:**
- Modify: `volla/src-tauri/Cargo.toml:23`

- [x] **Step 1:** Change the dep from a branch to the exact rev already in Cargo.lock:

```toml
tauri-plugin-holochain = { git = "https://github.com/darksoil-studio/tauri-plugin-holochain", rev = "387bf70ca4b7b388fbbaa76b62d3ac7e23e7e651", optional = true }
```

Run `cargo check --features holochain_bundled` in `src-tauri`; expected: clean (the lock's source line changes from `?branch=` to `?rev=`, same commit).

- [x] **Step 2:** Deletion insurance: no GitHub mirror (org permissions don't allow it, and one isn't needed) — the local checkout at `../tauri-plugin-holochain` (branch `main-0.6.1`) serves as the backup copy. If the darksoil repo becomes unfetchable, push that clone to a HelloVolla-controlled remote and swap the Cargo `git` URL to it (same rev).

- [x] **Step 3:** Document the fallback in `volla/README.md` (one paragraph after the p2pShipyard mention).

- [x] **Step 4:** Commit — `build: pin darksoil plugin dependency to exact rev`

### Task 2: Self-contained flake.nix (WebkitGTK 2.52 + EGL fixes, drop darksoil dev shells)

**Files:**
- Modify: `volla/flake.nix` (full replacement)
- Create: `volla/rust-toolchain.toml`
- Modify: `volla/package.json` (possibly drop `WEBKIT_DISABLE_DMABUF_RENDERER=1` from `start:desktop`)

- [x] **Step 1:** Write `volla/rust-toolchain.toml`: modeled on `vcs/rust-toolchain.toml` but with channel **1.89.0** (matching the toolchain volla's release workflows already install, so CI is unaffected), Android targets, and `wasm32-unknown-unknown` (volla's `build:zomes` needs it).

- [x] **Step 2:** Replace `volla/flake.nix`, based on `vcs/flake.nix` at commit `988835a` (verified working today: holonix `main-0.6`, rust via rust-overlay from rust-toolchain.toml, webkitgtk 2.52 tauriDeps, the EGL vendor-discovery + GIO + XDG_DATA_DIRS shellHook, Android SDK/NDK, HOST_CC/CXX/AR exports). Volla adaptations:
  - `devShells.default`: desktop shell — holonix packages (`holochain`, `hc`, `lair-keystore`, `bootstrap-srv` — npm scripts call `kitsune2-bootstrap-srv`), rust, nodejs_22, cmake, pkg-config, binaryen, shared-mime-info, gsettings-desktop-schemas, tauriDeps as buildInputs, and the full shellHook **minus** the Android exports.
  - `devShells.androidDev`: everything in default plus androidSdk (platforms 34+35, buildTools 34.0.0+35.0.0 — volla's gradle configs use compileSdk 35 / targetSdk 34), cargo-ndk, jdk17 and the ANDROID_*/NDK/HOST_* exports.
  - Keep the holonix input at `main-0.6` (Part 1 bumps it).

- [x] **Step 3:** Verify: `nix flake lock && grep -c darksoil flake.lock` → `0`; `nix develop --command bash -c "hc --version && rustc --version"` → holochain 0.6.1-rc.7, rust 1.89.0; androidDev shell exposes NDK/platforms/cargo-ndk/jdk.

- [ ] **Step 4:** Smoke test the webview fix (interactive; not done in the automated pass — the shellHook is verbatim from the vcs commit the author verified): `nix develop --command bash -c "npm install && npm run start:desktop"` — window renders. Try once with `WEBKIT_DISABLE_DMABUF_RENDERER=1` removed from the `start:desktop` script; if the webview stays blank, restore the variable. `package.json` was left untouched pending this check.

- [x] **Step 5:** Confirm CI still works: `test.yaml` and the Android job in `release-tauri-app.yaml` (`nix develop .#androidDev`) reference shell names that still exist. Push branch; expected green.

- [x] **Step 6:** Commit — `build: self-contained dev shell (webkitgtk 2.52, EGL vendor discovery); drop darksoil flake input`

- [ ] **Step 7:** PR to `develop`, merge. **Part 0 done — 0.6.x releases are now insulated. Everything below rides the 0.7 release train.**

---

# Part 1: holochain 0.7.0 platform bump

Branch in `volla`: `git checkout -b feat/holochain-0.7 develop`. Tasks 3–5 produce a working 0.6-feature-parity app on 0.7 **still using the darksoil-pattern only insofar as nothing below replaces it yet** — the plugin swap (Part 2) lands on this same branch before it merges.

### Task 3: Zome and workspace dependency bump

**Files:**
- Modify: `volla/Cargo.toml` (workspace: hdi `0.8.0`, hdk `0.7.0`, `holochain_serialized_bytes` to the version hdk 0.7 resolves, profiles → `branch = "main-0.7"`, file-storage → a rev on its `main-0.7` branch)
- Modify: `volla/dnas/relay/**` zome code as the compiler demands
- Modify: `volla/src-tauri/Cargo.toml` (holochain `0.7.0`, holochain_types `0.7.0`, lair_keystore + holochain_client to the versions the 0.7 workspace resolves — check whether `holochain_client` is actually used anywhere first; drop it if dead)

- [ ] **Step 1:** Bump the versions listed above. `npm run build:zomes` (in the Part 0 dev shell with holonix still main-0.6 — the wasm target doesn't care, but if `hc` CLI version matters for packing, do Task 5 Step 1's flake bump first). Fix compile errors mechanically; consult the hdk 0.6→0.7 changelog (`gh api repos/holochain/holochain/contents/crates/hdk/CHANGELOG.md`) for renames.
- [ ] **Step 2:** `npm run build:happ` packs `workdir/relay.happ` cleanly.
- [ ] **Step 3:** Run the integration tests: `npm test` (tryorama tests — bump `@holochain/tryorama` in `tests/package.json` to the 0.7-compatible release; find it via `npm view @holochain/tryorama versions` and the tryorama README compatibility table). Expected: PASS.
- [ ] **Step 4:** Commit — `feat!: happ to holochain 0.7 (hdk 0.7.0 / hdi 0.8.0)`

### Task 4: App version and data dir

**Files:**
- Modify: `volla/src-tauri/Cargo.toml:3` (version → `2.0.0`), `volla/src-tauri/tauri.conf.json` + `tauri.desktop.conf.json` version fields, root/ui `package.json` versions (match the repo's existing version-bump conventions — see the 1.0.0 bump commit `47f6dc0` for the file list)

- [ ] **Step 1:** Bump to 2.0.0 everywhere the 1.0.0 bump touched. `get_version()` in the builder then yields data dir suffix `2` — verify by reading the function; do not change its logic.
- [ ] **Step 2:** Commit — `chore: bump to 2.0.0 (fresh conductor data dir for holochain 0.7)`

### Task 5: Toolchain, flake, and infra for 0.7

- [ ] **Step 1:** `volla/flake.nix`: change the holonix input to `github:holochain/holonix/main-0.7`; `nix flake lock`; verify `nix develop --command hc --version` reports 0.7.x. (The rest of the flake is version-agnostic.)
- [ ] **Step 2:** `cargo check --features holochain_bundled` in `src-tauri` — this may FAIL against the darksoil plugin (it is 0.6-only). That's expected and fine: Part 2's Task 6/7 replaces it; proceed.
- [ ] **Step 3:** Infra check (coordinate, don't code): confirm `relay2.volla.tech` (kitsune2 bootstrap+signal) and `iroh-relay.volla.tech` versions serve holochain 0.7 clients; upgrade servers if needed. Record the outcome in the PR description.
- [ ] **Step 4:** Commit — `build: holonix main-0.7 dev shell`

---

# Part 2: Plugin migration (on the same `feat/holochain-0.7` branch)

### Task 6: Depend on upstream android-service-runtime's unified plugin

**Files:**
- Modify: `volla/src-tauri/Cargo.toml`

- [ ] **Step 1:** Push the local asr commit `81193a9` upstream first (or coordinate with the team), then pin volla to the pushed rev:

```toml
tauri-plugin-holochain = { git = "https://github.com/holochain/android-service-runtime", rev = "<pushed main-0.7 tip>", optional = true }
```

If upstream tags a plugin release before this lands (none exist yet — current tags stop at `tauri-plugin-client-v0.2.3`), prefer the tag. Ask upstream to tag; don't block on it.

- [ ] **Step 2:** Remove the now-unused `tauri-runtime` optional dep and its mention in the `holochain_bundled` feature list if the Task 7 rewrite compiles without it (it should — the old where-clause was the only user).

### Task 7: Rewrite `builder/holochain_bundled.rs` against the new plugin API

**Files:**
- Modify: `volla/src-tauri/src/builder/holochain_bundled.rs` (full rewrite below)
- Modify: `volla/src-tauri/src/builder.rs` (only compile-driven fallout)

**Interfaces:**
- Consumes (from the asr plugin, see `asr/crates/tauri-plugin-holochain/src/lib.rs` and the example app `asr/apps/holochain-runtime-example/src-tauri/src/lib.rs`): `init(passphrase, HolochainPluginConfig)`, `HolochainExt::holochain()`, `HolochainPluginConfig::new(data_dir, NetworkConfig)` (native holochain 0.7 `NetworkConfig` re-export), `WindowOptions { url, title, use_app_websocket }`, `runtime().{setup_app, is_app_installed, admin_port}`, `vec_to_locked`, events `holochain://ready` (`EVENT_READY`) / `holochain://setup-failed` (`EVENT_SETUP_FAILED`).
- Produces: same `setup_builder` export; plus consumes Task 8's `update_app_if_necessary`.

- [ ] **Step 1: Rewrite the module**

```rust
use crate::config::{APP_ID, HAPP_BUNDLE_BYTES};
#[cfg(target_os = "android")]
use crate::android_barcode_scanner;
use crate::happ_update;
use holochain_types::prelude::{AppBundleSource, InstallAppPayload};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Builder, Listener, Manager, Runtime};
use tauri_plugin_holochain::{
    vec_to_locked, HolochainExt, HolochainPluginConfig, NetworkConfig, WindowOptions,
    EVENT_READY, EVENT_SETUP_FAILED,
};
use uuid::Uuid;
use serde_json::json;

pub const SIGNAL_URL: &'static str = "wss://relay2.volla.tech/";
pub const BOOTSTRAP_URL: &'static str = "https://relay2.volla.tech/";
pub const IROH_RELAY_URL: &'static str = "https://iroh-relay.volla.tech/";
pub static ICE_URLS: &'static [&str] = &["stun://stun.nextcloud.com:443"];

pub fn setup_builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_holochain::init(
            vec_to_locked(vec![]),
            HolochainPluginConfig::new(holochain_dir(), network_config()),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let handle_fail = app.handle().clone();
            app.handle().listen(EVENT_SETUP_FAILED, move |event| {
                log::error!("holochain setup failed: {}", event.payload());
                handle_fail.exit(1);
            });
            app.handle().listen(EVENT_READY, move |_event| {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    setup(handle.clone()).await.expect("Failed to setup");

                    let mut window_options = WindowOptions::default();
                    #[cfg(desktop)]
                    {
                        window_options.title = Some(String::from("Volla Messages"));
                    }

                    let main_window = handle
                        .holochain()
                        .expect("Failed to get holochain")
                        .main_window_builder(
                            String::from("main"),
                            Some(APP_ID.into()),
                            window_options,
                        )
                        .await
                        .expect("Failed to build window")
                        .build()
                        .expect("Failed to open main window");

                    // Open devtools for debugging
                    main_window.open_devtools();

                    #[cfg(desktop)]
                    {
                        if let Some(splashscreen_window) =
                            handle.get_webview_window("splashscreen")
                        {
                            let _ = splashscreen_window.close();
                        }
                    }

                    // Loaded after the 'main' webview exists; it calls into it.
                    #[cfg(target_os = "android")]
                    handle
                        .plugin(android_barcode_scanner::init())
                        .expect("Failed to initialize android_barcode_scanner");

                    #[cfg(all(mobile, not(target_os = "android")))]
                    handle
                        .plugin(tauri_plugin_barcode_scanner::init())
                        .expect("Failed to initialize tauri_plugin_barcode_scanner");
                });
            });
            Ok(())
        })
}

async fn setup<R: Runtime>(handle: AppHandle<R>) -> anyhow::Result<()> {
    let runtime = handle.holochain()?.runtime();

    if !runtime.is_app_installed(APP_ID.into()).await? {
        runtime
            .setup_app(
                InstallAppPayload {
                    source: AppBundleSource::Bytes(HAPP_BUNDLE_BYTES.to_vec().into()),
                    agent_key: None,
                    installed_app_id: Some(APP_ID.into()),
                    // Random seed: every user gets a private DHT for contacts
                    network_seed: Some(Uuid::new_v4().to_string()),
                    roles_settings: Some(HashMap::new()),
                    ignore_genesis_failure: false,
                    restore_from_dht: false,
                },
                true,
            )
            .await?;
        happ_update::record_installed_bundle_hash(&holochain_dir(), APP_ID, HAPP_BUNDLE_BYTES)?;
    } else {
        happ_update::update_app_if_necessary(&runtime, &holochain_dir(), APP_ID, HAPP_BUNDLE_BYTES)
            .await?;
    }
    Ok(())
}

fn network_config() -> NetworkConfig {
    let mut config = NetworkConfig::default();
    config.signal_url = url2::url2!("{}", SIGNAL_URL);
    config.bootstrap_url = url2::url2!("{}", BOOTSTRAP_URL);
    config.relay_url = url2::url2!("{}", IROH_RELAY_URL);
    config.webrtc_config = Some(json!({ "iceServers": [ { "urls": ICE_URLS }]}));
    config
}
```

Keep `holochain_dir()` and `get_version()` verbatim from the current file. Compile-driven adjustments allowed: the exact `InstallAppPayload` field set for 0.7.0 and the `NetworkConfig` field names (asr's 0.7 code and holochain 0.7 docs are the reference); the `happ_update` API is defined in Task 8 — implement Tasks 7 and 8 together, they compile as a unit.

- [ ] **Step 2:** `cargo check --features holochain_bundled` — expected clean (with Task 8 in place).
- [ ] **Step 3:** Commit (with Task 6) — `feat(desktop)!: unified tauri-plugin-holochain from android-service-runtime (direct Tauri IPC)`

### Task 8: Coordinator-update path (`happ_update` module)

The asr runtime has `setup_app` but **no** `update_app_if_necessary`, and volla needs coordinator-zome updates when a release ships a changed happ into an existing data dir (2.0 → 2.1 keeps dir `2`). Implement app-side against the conductor's admin websocket (the runtime exposes `admin_port()`), porting darksoil's algorithm.

**Files:**
- Create: `volla/src-tauri/src/happ_update.rs`
- Modify: `volla/src-tauri/src/lib.rs` (add `mod happ_update;`), `volla/src-tauri/Cargo.toml` (add `holochain_client = "0.9"` — the 0.7-compatible rust client; verify exact version via `cargo search holochain_client` / the holochain 0.7 release notes; add `sha2 = "0.10"`)

**Interfaces:**
- Produces:
  - `pub fn record_installed_bundle_hash(data_dir: &Path, app_id: &str, bundle_bytes: &[u8]) -> anyhow::Result<()>` — writes `data_dir/happ-hashes/<app_id>` containing hex sha256 of the bundle bytes.
  - `pub async fn update_app_if_necessary(runtime: &tauri_plugin_holochain::Runtime, data_dir: &Path, app_id: &str, bundle_bytes: &[u8]) -> anyhow::Result<()>` — no-op when the stored hash matches; otherwise runs the coordinator update, then records the new hash.

- [ ] **Step 1:** Implement the hash gate exactly as specified above (`std::fs`, `sha2`).
- [ ] **Step 2:** Port the update algorithm from `dsp/crates/holochain_runtime/src/happs/update.rs` (`update_app` + `resolve_dna_files`): connect `holochain_client::AdminWebsocket` to `("127.0.0.1", runtime.admin_port())`, then per role: `get_dna_definition(cell_id)`, diff coordinator zomes (name + wasm hash) against the new bundle's DNA files, and issue `update_coordinators` for changed cells. Adapt 0.6→0.7 type renames compile-driven (`CellInfo` variants, `ZomeManifest`/`ZomeDependency` paths).
- [ ] **Step 3:** Unit-test the hash gate (pure fs logic): same bytes → second call returns without connecting (structure the function so the gate check precedes the websocket connect; test with a bogus port + matching hash → Ok). Run `cargo test -p volla_messages`; expected PASS.
- [ ] **Step 4:** (Optional, after it works) Upstream this as a PR to `holochain/android-service-runtime` (`Runtime::update_app_if_necessary`); switch volla to the upstream method when merged. Not a blocker.
- [ ] **Step 5:** Commit — `feat(desktop): coordinator-zome update path for in-place happ upgrades`

### Task 9: UI — `@holochain/client` 0.21.0

**Files:**
- Modify: `volla/ui/package.json:22` → `"@holochain/client": "0.21.0"`
- Modify: compile-flagged UI files (expect: `ui/src/routes/+layout.svelte`, `ui/src/store/NetworkStatsStore.ts`, scattered type imports)

- [ ] **Step 1:** Bump, `npm install`, run the UI typecheck (`npm run -w ui check` or equivalent script in `ui/package.json`); fix breaks mechanically per the client 0.20→0.21 changelog. `AppWebsocket.connect()` needs no code change — 0.21 auto-detects `__HC_TAURI_HOLOCHAIN__` (desktop direct IPC) and falls back to `__HC_LAUNCHER_ENV__` (Android service path).
- [ ] **Step 2:** Commit — `feat(ui)!: @holochain/client 0.21.0 (direct Tauri IPC transport)`

### Task 10: Android service path at 0.7 (coordination task)

- [ ] **Step 1:** Repoint `tauri-plugin-holochain-service-client` in `volla/src-tauri/Cargo.toml` from the `vcs` 0.6.1 tag to upstream `holochain/android-service-runtime` at the same pinned rev as Task 6. `cargo check --features holochain_service`; fix compile-driven API drift in `builder/holochain_service.rs`.
- [ ] **Step 2:** Decide the fork's future with the team: sync `vcs` to upstream `main-0.7` (if HelloVolla still needs volla-specific defaults) or depend on upstream everywhere and retire the fork's plugin crates. Record the decision in `vcs/README.md`.
- [ ] **Step 3:** Build the 0.7 android-service-runtime app and verify the volla client APK connects to it on a device/emulator. Device rollout sequencing (runtime app update must precede or accompany the volla 2.0 APK) goes in the release notes.

### Task 11: End-to-end verification and merge

- [ ] **Step 1: Fresh install (desktop):** `npm run start:desktop` — logs show the install path; devtools Network tab shows **no** localhost websocket; conversations UI loads; NetworkStatusPanel renders (`dumpNetworkStats` over IPC).
- [ ] **Step 2: Two-agent messaging:** `npm start` (2 agents, local bootstrap) — message delivery both ways (exercises signals over the `holochain://signal` bridge).
- [ ] **Step 3: Upgrade path:** run a release-profile build against a persistent data dir, quit, rebuild with a trivially changed coordinator zome (different bundle hash), run again — logs show `update_app_if_necessary` updating coordinators; existing data still loads.
- [ ] **Step 4: Android:** Task 10 Step 3's device check passes.
- [ ] **Step 5: Release workflow dry-run:** trigger `release-tauri-app.yaml` on the branch (prerelease tag or workflow_dispatch); desktop artifacts build on all matrix targets in the new dev shell/apt setup.
- [ ] **Step 6:** Update `README.md` (drop the p2pShipyard deployment claim; describe android-service-runtime plugin + direct IPC) and `CHANGELOG.md` (2.0.0: holochain 0.7, network cutover, fresh data dir, plugin/transport migration).
- [ ] **Step 7:** PR `feat/holochain-0.7` → `develop` referencing this plan; merge after review and green CI.

---

## Self-review notes

- The previous plan revision's Part 1 (backport of the plugin + runtime methods into `vcs` at 0.6.1, and the client wire-compat gate/fallback) is deleted per the decision record — superseded, not deferred.
- Task 7's code references `happ_update` (Task 8) — the two tasks compile as a unit and are committed in sequence on the same branch; interfaces match (`record_installed_bundle_hash`, `update_app_if_necessary` signatures identical in both tasks).
- Deliberate compile-driven placeholders (0.7 struct field sets, exact `holochain_client` version, client-js changelog renames) are named with their authoritative reference sources rather than guessed — verifying them is each task's Step.
- Open product decisions (message history, Android rollout) are flagged at the top and NOT resolved by any task; Part 1 must not start until the history question has an owner.
