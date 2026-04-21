# Compiling Volla with Reticulum transport

Volla Messages can be built with Reticulum replacing iroh/tx5 as the p2p
transport. Two backends are available — LXMF-rs (default) and Beechat —
selectable at build time. Features are mutually exclusive; you can't
compile both into one binary.

For the underlying architecture and the dual-backend rationale, see
[../../../holochain-lrl/docs/reticulum.md](../../../holochain-lrl/docs/reticulum.md)
in the sibling holochain-lrl checkout.

## Prerequisites

Three sibling checkouts, side-by-side:

```
~/code/.../holochain/
├── volla/              (branch: reticulum)
├── holochain-lrl/      (branch: transport-reticulum)
└── kitsune2-lrl/       (branch: transport-reticulum)
```

On a fresh clone:

```sh
cd holochain-lrl && git checkout transport-reticulum
cd ../kitsune2-lrl && git checkout transport-reticulum
cd ../volla && git checkout reticulum
```

The path dependencies in `volla/src-tauri/Cargo.toml` resolve relative to
these locations — they must be siblings with those exact directory names.

## LXMF-rs backend (default)

The reticulum branch ships configured for LXMF-rs out of the box. No
manifest edits required.

```sh
cd volla
nix develop
npm install
npm run start:desktop
```

Runtime topology is controlled by env vars (see
[../../README-reticulum.md](../../README-reticulum.md) if you've added
one, or the `reticulum_config()` function in
[../../src-tauri/src/builder/holochain_bundled.rs](../../src-tauri/src/builder/holochain_bundled.rs)):

```sh
# pure LAN multicast (default — always on)
npm run start:desktop

# direct TCP rendezvous
VOLLA_RETICULUM_LISTEN=0.0.0.0:4242 npm run start:desktop   # server
VOLLA_RETICULUM_DIAL=host:4242      npm run start:desktop   # client
```

## Beechat backend

Switching to Beechat requires one `Cargo.toml` edit plus a system
dependency. Beechat targets mesh / multihop topologies; for a single
direct LAN pair, LXMF-rs is lower-overhead.

### Step 1 — install `protoc`

Beechat's underlying `reticulum` crate generates protobuf code via
`tonic-build`. The LXMF-rs backend has no such requirement.

```sh
# Debian / Ubuntu
sudo apt install -y protobuf-compiler

# Fedora
sudo dnf install -y protobuf-compiler

# macOS
brew install protobuf

# Nix
# Add `pkgs.protobuf` to the devShell inputs in volla's flake.nix, or
# `nix shell nixpkgs#protobuf` in a one-off.
```

Verify: `protoc --version` should print 3.x.

### Step 2 — swap the holochain feature

Edit [../../src-tauri/Cargo.toml](../../src-tauri/Cargo.toml), line with
the `holochain` dep. Change `"transport-reticulum"` to
`"transport-reticulum-beechat"`:

```diff
- holochain = {version = "0.6.1-rc.7", default-features = false, features = ["sqlite-encrypted", "wasmer_sys", "transport-iroh", "transport-reticulum"] }
+ holochain = {version = "0.6.1-rc.7", default-features = false, features = ["sqlite-encrypted", "wasmer_sys", "transport-iroh", "transport-reticulum-beechat"] }
```

**Both features cannot coexist.** The
`kitsune2_transport_reticulum` crate has a `compile_error!` guard that
refuses a build with both `backend-lxmf` and `backend-beechat` enabled.
Swap, don't append.

### Step 3 — build

```sh
npm install     # idempotent; skip if node_modules is fresh
npm run start:desktop
```

First Beechat build takes 3–5 min extra vs LXMF because the
`reticulum-rs` crate and its proto-generated code are new to the build
cache.

## Backend comparison

| Concern                      | LXMF-rs                                       | Beechat                                             |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Per-packet MDU               | ~464 B                                        | ~2048 B                                             |
| Payload chunking             | via Resource abstraction                      | same                                                |
| Mesh / multihop routing      | basic                                         | richer (`PathTable`, retransmit)                    |
| Link restart policy          | fixed                                         | configurable via `beechat.restart_outlinks`         |
| `link_idle_timeout_s` honored | yes                                           | no (compile-time constants)                         |
| rusqlite dep                 | yes (chokes on version mismatches; see patch) | no                                                  |
| System deps                  | none                                          | `protoc`                                            |
| Pick for                     | simple LAN / direct TCP                       | real mesh; LoRa; long-haul multihop; radio links    |

## Runtime config notes

Volla's current `reticulum_config()` does not expose the
Beechat-specific tuning fields (`retransmit`, `broadcast`,
`reroute_eager`, `restart_outlinks`, `announce_forever` under
`ReticulumTransportConfig.beechat`). If you're running Beechat and want
those, add them to the struct literal in
[../../src-tauri/src/builder/holochain_bundled.rs](../../src-tauri/src/builder/holochain_bundled.rs):

```rust
ReticulumTransportConfig {
    interfaces,
    identity_path: Some(holochain_dir().join("reticulum.identity")),
    beechat: ReticulumBeechatConfig {
        retransmit: Some(true),          // act as a transport node
        reroute_eager: Some(true),       // prefer newer equal-length routes
        restart_outlinks: Some(true),    // auto-rebuild closed outbound links
        ..Default::default()
    },
    ..Default::default()
}
```

These fields are silently ignored on LXMF-rs, so leaving them set when
you swap back doesn't break anything — they just become no-ops.

## Verifying the build

Volla's default log level is `Warn`, which suppresses the reticulum
`info!` lines that confirm the transport came up. Set
`VOLLA_RUST_LOG` to raise it. The filter accepts env_logger-style
directives: a bare level sets the base filter, and `module=level`
pairs override per-module. Examples:

```sh
# just the reticulum + transport chatter you'd usually want
VOLLA_RUST_LOG=warn,kitsune2_transport_reticulum=debug,rns_transport=debug \
  npm run start:desktop 2>&1 | tee /tmp/volla.log

# everything at info — louder, rarely needed
VOLLA_RUST_LOG=info npm run start:desktop

# turn the firehose on
VOLLA_RUST_LOG=debug npm run start:desktop
```

With the first one in place, the terminal should show, shortly after
`HOLOCHAIN_SETUP_END`:

```
kitsune2_transport_reticulum::node [INFO] Generated and persisted new Reticulum identity path=...
kitsune2_transport_reticulum::backend_lxmf [INFO] Started Reticulum UDP interface bind=0.0.0.0:0 group=None
kitsune2_transport_reticulum::node [INFO] ReticulumNode ready identity_hash=... num_interfaces=1
rns_transport::iface::udp [INFO] udp_interface bound to <0.0.0.0:0>
```

and, if you set the env vars for TCP:

```
Started Reticulum TCP server interface bind=0.0.0.0:4242
Started Reticulum TCP client interface target=host:4242
```

To confirm which backend is actually live, grep for the backend module
in the `Compiling` lines during `cargo check` / `cargo build`:

- **LXMF-rs**: `reticulum-rs-transport v0.2.0 (github.com/lightningrodlabs/LXMF-rs?branch=udp-multicast#...)`
- **Beechat**: `reticulum v... (github.com/lightningrodlabs/Reticulum-rs?rev=...)`

Only one of those will appear in a given build.

## Switching back

The reverse — beechat → LXMF-rs — is the same edit in reverse.

If you leave both reticulum features *off*, the build still succeeds
but no reticulum code is compiled in; the conductor silently uses its
configured iroh/tx5 URLs (the `relay2.volla.tech` / `iroh-relay.volla.tech`
endpoints in [../../src-tauri/src/builder/holochain_bundled.rs](../../src-tauri/src/builder/holochain_bundled.rs))
and behaves like a normal non-reticulum build. The tell is a cargo
warning: `warning: patch "kitsune2_transport_reticulum ..." was not
used in the crate graph` — if you see that after a build you were
expecting to be reticulum, the feature isn't on.

If you try to enable *both* `transport-reticulum` and
`transport-reticulum-beechat` at once, the build fails fast with a
`compile_error!` from `kitsune2_transport_reticulum`. Swap, don't
append.
