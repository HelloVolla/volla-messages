# Two-Node Reticulum Test — Build & Launch

Minimal recipe for bringing up two Volla peers over the Reticulum transport,
first via LAN UDP multicast, then via TCP Dial/Listen. Covers both the
LXMF-rs backend (default) and the Beechat backend.

For the dual-backend rationale and feature flags, see
[compiling.md](compiling.md). For the topology model (why TCP is
rendezvous-routed, not hole-punched), see [p2p-topology.md](p2p-topology.md).

## Prerequisites — checkouts

Three sibling checkouts are required; the same set works for both
backends. The `-lrl` suffix on the directory names is required —
`volla/src-tauri/Cargo.toml` path deps reference `../../holochain-lrl/...`
and `../../kitsune2-lrl/...` literally, so the clone destinations must
match.

```
~/code/.../holochain/
├── volla/              (branch: reticulum)
├── holochain-lrl/      (branch: transport-reticulum)
└── kitsune2-lrl/       (branch: transport-reticulum)
```

Both backend crates (`reticulum-rs-transport` for LXMF-rs and `reticulum`
for Beechat) are pulled from git by Cargo; no additional checkouts are
needed.

Clone from scratch into an empty `holochain/` parent directory:

```sh
mkdir -p ~/code/holochain && cd ~/code/holochain

git clone https://github.com/HelloVolla/volla-messages volla
git clone https://github.com/lightningrodlabs/holochain holochain-lrl
git clone https://github.com/lightningrodlabs/kitsune2  kitsune2-lrl

cd volla         && git checkout reticulum           && cd ..
cd holochain-lrl && git checkout transport-reticulum && cd ..
cd kitsune2-lrl  && git checkout transport-reticulum
```

## Extra prerequisite for Beechat — `protoc`

Beechat's underlying `reticulum` crate generates protobuf code via
`tonic-build`, so building with the Beechat backend needs the protobuf
compiler. (LXMF-rs has no such requirement.)

```sh
# Debian / Ubuntu
sudo apt install -y protobuf-compiler
# Fedora
sudo dnf install -y protobuf-compiler
# macOS
brew install protobuf
# Nix one-off
nix shell nixpkgs#protobuf
```

Verify: `protoc --version` should print 3.x.

## Build

One-time, from `volla/`:

```sh
cd volla
nix develop
npm install
```

The first launch compiles the full holochain + kitsune2 + reticulum stack
and takes several minutes. Subsequent runs are incremental. The first
Beechat build takes an extra 3–5 min over LXMF because the `reticulum`
crate and its proto-generated code are new to the build cache.

## Shared launch settings

**Announce cadence is essentially required for a usable test.** The
default is 300 s, which means a late-joining peer can wait up to 5 min
before it even hears the other's first announce — long enough that the
examples below will look broken. Drop it to ~15 s while testing:

```sh
export VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15
export VOLLA_RUST_LOG=warn,kitsune2_transport_reticulum=debug,rns_transport=debug
```

Run those `export`s in **every terminal** you'll launch a node from.
The launch commands in the mode sections below also show the env vars
inlined so you can copy-paste one line and get a working invocation
even in a fresh shell.

Each node must run from its own user profile / data directory, otherwise
they'll share the same Holochain DB and Reticulum identity. On a single
dev box, run the two nodes as different OS users, or override Tauri's
data dir per node; on two machines the default locations are already
distinct.

## Choosing the backend at launch time

Feature selection is driven by the npm script, not a Cargo.toml edit:

```sh
npm run start:desktop           # LXMF-rs (feature: reticulum-lxmf)
npm run start:desktop:beechat   # Beechat (feature: reticulum-beechat)
```

The two features are mutually exclusive — a `compile_error!` in
`kitsune2_transport_reticulum` blocks enabling both. All launch commands
below work with either script; substitute whichever matches the backend
you're testing.

---

## Mode 1 — UDP multicast (zero-config LAN)

UDP multicast on `224.0.0.224:4242` is enabled automatically when
neither `VOLLA_RETICULUM_LISTEN` nor `VOLLA_RETICULUM_DIAL` is set —
i.e. it's the default when you launch with no TCP env vars, exactly the
case below. Both peers must be on the same LAN subnet and the network
must allow link-local multicast (most home LANs do; corporate WiFi and
cloud VPCs often don't).

### LXMF-rs

Node A:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 npm run start:desktop
```

Node B (same LAN, different machine or different user):
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 npm run start:desktop
```

### Beechat

Node A:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 npm run start:desktop:beechat
```

Node B:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 npm run start:desktop:beechat
```

### What to look for

Within ~15s of both nodes being up, each terminal should log lines like:

```
kitsune2_transport_reticulum::node [INFO] ReticulumNode ready identity_hash=<hex> num_interfaces=1
kitsune2_transport_reticulum::backend_lxmf [INFO] Started Reticulum UDP interface bind=0.0.0.0:0 group=224.0.0.224:4242
```

(On Beechat the backend module name is `backend_beechat` instead of
`backend_lxmf`.) An announce from the other node should follow shortly
and a kitsune2 peer entry should appear. Sending a message from one
Volla UI should land in the other.

---

## Mode 2 — TCP Dial / Listen

Use when multicast is blocked, when the two nodes are on different LANs,
or when you want the path to go through a known rendezvous for debugging.
One node listens, the other dials it. The listener must be reachable from
the dialer at the chosen address and port.

Setting `VOLLA_RETICULUM_LISTEN` or `VOLLA_RETICULUM_DIAL` also
auto-disables UDP multicast for that node — running both paths to the
same peer on the same LAN triggers an rns-transport Link iface-affinity
drop that stalls gossip. See the "Link iface affinity" caveat in
[brief.md](brief.md) for details.

Pick the listener's IP (use `ip addr` / `ifconfig` — the LAN-routable
address, not `127.0.0.1` unless both nodes are on the same box).

### LXMF-rs

Node A — listener:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 VOLLA_RETICULUM_LISTEN=0.0.0.0:4242 \
  npm run start:desktop
```

Node B — dialer:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 VOLLA_RETICULUM_DIAL=<A-ip>:4242 \
  npm run start:desktop
```

### Beechat

Node A — listener:
```sh
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 VOLLA_RETICULUM_LISTEN=0.0.0.0:4242 \
  npm run start:desktop:beechat
```

Node B — dialer:
```sh:
VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S=15 VOLLA_RETICULUM_DIAL=<A-ip>:4242 \
  npm run start:desktop:beechat
```

Substitute `<A-ip>` with A's reachable address. The env vars are read by
the same `reticulum_config()` regardless of backend.

### What to look for

On A:
```
Started Reticulum TCP server interface bind=0.0.0.0:4242
```

On B:
```
Started Reticulum TCP client interface target=<A-ip>:4242
```

Once B's announce reaches A (and vice versa) via the TCP socket, kitsune2
will mark them as peers.

### Topology note

A `TcpClient`-only node receives packets **only** through sockets it
opened. If B is `TcpClient`-only and A goes down, B is isolated until A
returns. For a symmetric direct-peer test where neither needs an explicit
rendezvous, give both sides a listener and have each dial the other — or
rely on multicast (Mode 1). See [p2p-topology.md](p2p-topology.md) for
details.

---

## Teardown & reset

Each node persists its Reticulum identity to
`<holochain-data-dir>/reticulum.identity`. Delete that file to force a
fresh peer URL on next launch (useful when a peer "remembers" a stale
identity). The Holochain DB and agent keys live in the same data dir and
are independent of the Reticulum identity.

## Swapping backends between runs

No Cargo.toml edit required — just switch npm scripts. Cargo will
recompile the changed feature flags. If you see

```
warning: patch "kitsune2_transport_reticulum ..." was not used in the crate graph
```

after a build, neither reticulum feature is actually on — re-check the
script you launched.
