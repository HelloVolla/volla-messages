# Holochain over Reticulum — Proof-of-Concept Brief

## Purpose

This brief describes a proof-of-concept in which Holochain, as consumed
by the Volla messaging app, runs over a Reticulum mesh network in place
of (or alongside) the default Iroh/QUIC transport. The stack spans four
layers: the Rust Reticulum protocol library (with two interchangeable
backends), Holochain's p2p layer (kitsune2), Holochain itself, and the
Volla app. Each is a fork or patched build of its upstream.

---

## Layers

### 1. Rust Reticulum protocol — two backend options

The kitsune2 Reticulum transport can be compiled against either of two
Rust implementations of the Reticulum mesh protocol, selected via Cargo
features. Both provide the same core primitives — X25519/Ed25519
identities, packet-level crypto, destination addressing, link lifecycle,
announce/path tables, and a pluggable interface abstraction for TCP
client/server and UDP — but differ in maturity and feature coverage.

**`LXMF-rs` / `rns-transport` (default, `backend-lxmf`).**
A Rust port of Reticulum plus LXMF's application layer —
[lightningrodlabs/LXMF-rs @ `udp-multicast`](https://github.com/lightningrodlabs/LXMF-rs/tree/udp-multicast).
Of the several crates in the repo, the PoC uses only `rns-transport`
(published as `reticulum-rs-transport`) and its `rns-core` dependency.
The LXMF application layer, `reticulumd` daemon, JSON-RPC bridge, and
LXMF SDK are not consumed. `rns-transport` is what Volla ships by
default; it provides the `Resource` abstraction for large payloads
and working UDP multicast.

**`Reticulum-rs` (alternative, `backend-beechat`).**
A fork of Beechat Network Systems' `reticulum` crate —
[lightningrodlabs/Reticulum-rs @ `udp-multicast`](https://github.com/lightningrodlabs/Reticulum-rs/tree/udp-multicast).
Covers the same core protocol and includes flexible multi-interface
routing, multicast-aware UDP socket binding, richer `AnnounceEvent`
metadata (hop count, timestamps, interface), a `Link::peer_identity()`
accessor, configurable announce retransmission, and several
TCP-server-mode interface-flag and dedup fixes. It carries gossip
traffic end-to-end but has not been exercised in the app at the same
depth as the LXMF backend.

### 2. `kitsune2` — Reticulum transport for Holochain's p2p layer

A fork of kitsune2 (Holochain's gossip/DHT layer) —
[lightningrodlabs/kitsune2 @ `transport-reticulum`](https://github.com/lightningrodlabs/kitsune2/tree/transport-reticulum) —
that adds a `transport_reticulum` crate implementing kitsune2's
`Transport` and `Bootstrap` traits on top of Reticulum. Key modules: `node.rs` (shared
identity + announce state), `peer_state.rs` (per-peer / per-space link
maps), `bootstrap.rs` (announce-driven peer discovery, replacing the
HTTP bootstrap server), `announce.rs`, `link.rs`, `destination.rs`, and
`config.rs`. The crate can be compiled against either backend via Cargo
features: `backend-lxmf` (default, using `rns-transport`) or
`backend-beechat` (using the raw `reticulum` crate). Each kitsune2 space
gets its own Reticulum Destination with aspect `kitsune2/<space_hash>`;
peer URLs use a fixed scheme `ret://reticulum:1/<identity-hash-hex>` so
routing is by hash, not IP. The separate `bootstrap_mdns` crate on this
fork implements a privacy-preserving LAN bootstrap (see Security below).

### 3. Holochain

The Holochain conductor consumes `kitsune2` and exposes a
`transport-reticulum` cargo feature —
[lightningrodlabs/holochain @ `transport-reticulum`](https://github.com/lightningrodlabs/holochain/tree/transport-reticulum).
When enabled, the conductor accepts an optional `ReticulumTransportConfig`
in its network config and instantiates the `transport_reticulum` factory
in place of (or alongside) the default Iroh-based transport.

### 4. Volla (`reticulum` branch)

The Tauri-based Volla messaging app builds on the Reticulum-enabled
Holochain —
[HelloVolla/volla-messages @ `reticulum`](https://github.com/HelloVolla/volla-messages/tree/reticulum).
`src-tauri/Cargo.toml` pins `holochain` with the `transport-reticulum`
feature, redirects the entire `holochain` and `kitsune2` stacks to the
forks above, and pulls `reticulum-rs-transport` from the `udp-multicast`
branch of the LXMF fork. Wiring lives in
`src-tauri/src/builder/holochain_bundled.rs`, which assembles a
`ReticulumTransportConfig` from environment variables:

- `VOLLA_RETICULUM_LISTEN=0.0.0.0:4242` — TCP server (rendezvous role)
- `VOLLA_RETICULUM_DIAL=host1:4242,host2:4242` — outbound TCP clients
- UDP multicast is always enabled on `224.0.0.224:4242` for zero-config
  LAN discovery (link-local, never leaves the subnet)
- `VOLLA_RETICULUM_ANNOUNCE_INTERVAL_S` — override default 300s cadence
- `VOLLA_RUST_LOG` — per-module tracing log level

The Reticulum identity is persisted to `reticulum.identity` in the
holochain data directory so the peer URL survives restarts.

---

## What kitsune2 needs from the Reticulum layer, and how each backend provides it

Both upstreams targeted LXMF's messaging use case, which doesn't need
everything kitsune2 does. The two most load-bearing pieces are
large-message chunking and UDP multicast discovery; each backend
provides them differently.

### Chunking (gossip messages routinely exceed MDU)

Reticulum's packet MDU is ~464 bytes (LXMF's plaintext ceiling is
400 after Fernet overhead), and kitsune2 gossip payloads — including
preflight frames that carry a signed `AgentInfo` per local agent —
routinely exceed that. `transport_reticulum::routers::send_over_link`
picks a strategy per backend:

- **LXMF backend → rns `Resource`.** `rns-transport` exposes
  Reticulum's `Resource` abstraction: `send_over_link` hands the
  whole encoded frame to `Endpoint::send_resource`, and the
  transport takes care of the advertise/request/fragments/proof
  round-trip, retransmits missing fragments on demand, and
  delivers the reassembled payload as a single
  `ResourceEventKind::Complete` event. A resource-event bridge
  funnels that into the same mpsc as single-packet frames, so the
  receive path (`route_data` → `decode_frame`) is one code path
  for both sizes.
- **Beechat backend → chunker added inside kitsune2 as a workaround**
  (`transport_reticulum/src/chunking.rs`). Beechat has no `Resource`
  type, so fragmentation can't live in the Reticulum library — it
  has to be bolted on above the transport trait, inside kitsune2's
  own tree. Oversized `TAG_DATA` frames are split into MDU-sized
  `TAG_CHUNKED` packets carrying `sequence_id` / `frag_index` /
  `frag_count`, sent as a burst via `Link::send_small` and
  reassembled at the receiver into sparse per-link vectors with
  timeout-based eviction. Dispatch is capability-gated: the
  `Endpoint::supports_resource_transfer()` trait method — `true`
  for LXMF, `false` (default) for Beechat — decides which path
  oversized frames take.

**Capability gap.** The two paths are not equivalent, and the
difference is a real protocol-library capability difference, not
just an implementation choice:

- The Beechat-backend chunker added to kitsune2 is strictly
  **fire-and-forget**: no
  proof-of-receipt, no per-fragment retransmit, no ACKs, no flow
  control. A single dropped fragment silently kills the entire
  payload at the 30 s reassembly timeout. On a clean localhost TCP
  link that's rare; on a real lossy mesh (UDP multicast, radio
  links, congested Wi-Fi) it will be a dominant performance
  problem — a 131-fragment 50 KiB gossip message only needs to
  lose one packet to be retried whole, 30 seconds later, when
  kitsune2 reattempts at its own layer.
- The chunker additionally paces fragments at **100 ms apart** as a
  workaround for an upstream Beechat bug — its `LinkEvent::Data`
  broadcast channel has a hard-coded 16-slot capacity, and bursts
  of fragments overflow it and get silently `RecvError::Lagged`-
  dropped. That pacing multiplies the cost of any dropped
  fragment on the chunker path: the same 131-fragment payload
  takes ~13 seconds to put on the wire even before considering
  retries.
- rns's `Resource` handles all of the above natively:
  per-fragment proofs, selective retransmit of missing fragments
  (not the whole payload), fragment batching with its own flow
  control, and no artificial pacing floor. It's a mature piece of
  the Reticulum protocol ecosystem that the LXMF backend gets for
  free.
- On the LXMF side there was a distinct bug in rns's resource
  manager — the first `Resource` transfer on a freshly-Active link
  could hit `DroppedNoRoute` because the internal `path_table`
  hadn't yet learned the Link ID route. That's mitigated in this
  PoC by setting `broadcast: true` on the `TransportConfig`
  (`backend_lxmf.rs::create_endpoint_from_config`), which makes
  rns fall back to sending on all interfaces when no route is
  known — for a point-to-point TCP link that just means "deliver
  to the one peer on the other end." `tests/two_node_tcp_preflight.rs`
  regresses this.

Net: for large payloads on unreliable links, LXMF/`rns-transport`
is substantially better-suited than Beechat. The Beechat chunker
is sufficient for LAN / localhost gossip but is a known weak spot
for real-world mesh deployment.

### UDP multicast (zero-config LAN discovery)

- **LXMF backend.** Multicast is end-to-end: the socket layer joins
  the group, announces go out on the multicast address, and the
  `AnnounceTable` auto-derives per-peer unicast UDP interfaces from
  the multicast announces it receives.
- **Beechat backend.** `Reticulum-rs`'s `UdpInterface` joins the
  multicast group (`join_multicast_v4` / `_v6`), and
  `Transport::add_multicast_udp_interface()` spawns that interface
  together with a bidirectional `PeerRouting` map (SocketAddr ↔
  AddressHash) shared between the rx/tx tasks. The kitsune2
  `backend-beechat` wrapper routes multicast UDP interfaces through
  this entry point, so peers discovered via multicast announces get
  per-peer unicast traffic routed back through the same socket
  rather than flooded to the group.

### Other things the LXMF backend (`rns-transport`) provides

- **Richer `AnnounceEvent`** exposing `name_hash`, hop count, and the
  receiving interface, so the transport can filter, dedup, and
  prefer-path based on announce metadata.
- **Built-in `AnnounceTable`** — cache/dedup by `rand_hash` + timestamp.
- **Serial and BLE interface support** alongside TCP/UDP, using
  cross-platform serial plus `btleplug` for BLE on desktop.
- **Link liveness parity** with the Python Reticulum reference
  implementation (keep-alives, timeouts, teardown timing).
- **Interface-scoped announce ingress control** and admission policies,
  which the PoC uses to separate multicast vs unicast UDP interfaces.
- **Ratchet key support** for forward-secret announces (with strict
  parsing gating so older peers aren't broken).

### Other things the Beechat backend (`Reticulum-rs`) provides

- Flexible multi-interface routing strategy (multiple concurrent
  interfaces of different types on one node).
- `Link::peer_identity()` accessor (needed by kitsune2 to map links
  back to stable peer URLs).
- Richer `AnnounceEvent` metadata (hop count, timestamps, interface).
- Configurable announce propagation / retransmission.
- TCP-server `ifac` open-flag fix and announce / path-request dedup.
- `path_table::handle_announce()` uses `checked_add(1)` on the hop
  count so a malformed or cyclic peer reaching 255 hops doesn't
  panic the tokio runtime.

---

## Security: Iroh vs Reticulum, and the DNA-hash leak

### What Iroh gives you

With the Iroh transport, peers are addressed by `NodeId` (an Ed25519
public key) and Holochain's network space / DNA hash is not broadcast
on the wire. Space membership is negotiated at the application layer
after a connection is established; an observer who is not already a
peer cannot tell which DNAs a given node participates in from its
traffic alone.

### What Reticulum leaks

Reticulum routes by Destination hash, where a Destination is named by an
aspect string. In `kitsune2/crates/transport_reticulum/src/node.rs`
the aspect is built as:

```rust
let space_hash = hex::encode_to_string(space_id);
let name = DestinationName::new("kitsune2", &space_hash);
```

i.e. `kitsune2/<hex(space_id)>`. This aspect name (and the `name_hash`
derived deterministically from it) is broadcast in every Reticulum
announce. Consequences:

- Any passive listener on the mesh learns exactly which DNA/space this
  node is participating in.
- The mapping is stable across restarts because it is derived purely
  from the space id, so presence can be correlated over time.
- A listener who has a candidate list of known DNA hashes can
  precompute the matching aspect names and confirm a node is in a
  specific space from its announces alone.

This is a strict regression vs Iroh for the confidentiality of space
membership.

### The fix — same algorithm as `bootstrap_mdns`

The `kitsune2/crates/bootstrap_mdns` crate solves the same problem for
LAN discovery and its algorithm applies directly to the Reticulum
transport:

1. **Fingerprint instead of raw hash.** Broadcast
   `SHA-256(space_id || domain_tag)` — e.g. with a `"k2-reticulum-v1"`
   tag — as the aspect identifier, never the raw space id. Locally,
   every node keeps a `fingerprint -> space_id` map for its own spaces
   and uses that to filter incoming announces.
2. **Proof-of-knowledge handshake before data.** When establishing a
   link, both sides exchange fresh random nonces and then an
   `HMAC-SHA256(space_id, domain_tag || n_self || n_peer)`. The HMAC
   key is the raw space id, so only actual members can produce a valid
   proof; fingerprint-only observers cannot. Nonces are per-session to
   prevent replay.
3. **Signed peer-info exchange** after the proof succeeds, reusing
   kitsune2's existing `AgentInfoSigned` / `Verifier` machinery, so a
   passing proof still can't inject fake agent metadata.

Caveat, inherited from the mDNS design: deterministic fingerprints are
still precomputable against a known candidate list of DNAs. Mitigation
via time-bucketed rotation (e.g. `HMAC(space_id, epoch)` where `epoch`
advances on a schedule) is listed as future work on `bootstrap_mdns`
and would apply identically here.

---

## Caveats — open issues and limitations

- **DNA-hash leak in the Reticulum transport.** The space hash is
  broadcast in every announce (see Security section above). The fix
  is the fingerprint + HMAC + nonce handshake used by
  `bootstrap_mdns`; factoring those helpers into a shared module and
  applying them in `node.rs` is open work.
- **No time-bucketed fingerprint rotation.** Neither `bootstrap_mdns`
  nor the proposed Reticulum fix rotates the fingerprint over time;
  an adversary with a candidate list of DNA hashes can confirm
  presence by precomputation.
- **Backend maturity.** Volla ships `backend-lxmf` by default.
  `backend-beechat` carries gossip traffic end-to-end but is less
  exercised in real app scenarios, and its chunker is simpler than
  LXMF's Resource path (no compression, no per-fragment retransmit),
  which may matter under loss — this needs measurement.
- **Link iface affinity breaks multi-path reachability.** An
  rns-transport `Link` is bound to the interface it was established
  on, and packets arriving on any other interface for the same Link
  are dropped with `dropping packet from iface X expected Y`. When a
  peer is reachable via more than one interface simultaneously — e.g.
  a node on the same LAN running both a TCP Dial/Listen path and UDP
  multicast — the remote's path table may route Resource packets out
  a different interface than the one the Link was established on, and
  gossip stalls with `kitsune2_gossip::timeout` even though the link
  is active. Volla works around this by only enabling UDP multicast
  when neither `VOLLA_RETICULUM_LISTEN` nor `VOLLA_RETICULUM_DIAL` is
  set, so an explicit TCP topology gets a single interface to each
  peer. The proper fix is in `rns-transport`: relax the Link iface
  check to accept packets on any interface the path table currently
  marks as reachable for the remote destination, or have the
  link-establishment handshake negotiate the iface for the session.
- **No NAT traversal; every hop is on your dime.** Reticulum does no
  hole-punching — no STUN, no ICE, no relay→direct upgrade. If two
  peers are both `TcpClient`-only behind NAT, they never establish
  a direct socket even when the network would allow it; every packet
  between them traverses the shared `TcpServer` rendezvous (`S`) for
  the entire session. The kitsune2/Holochain layer still sees A and B
  as end-to-end encrypted peers (S holds no Link key), but
  topologically S is a store-and-forward router on the hot path.

  This is a meaningful operational difference from Iroh/tx5, which
  start on a relay and then migrate to a direct hole-punched UDP path
  whenever one is reachable. With Iroh, the relay's bandwidth cost
  drops to ~zero steady-state per peer pair. With Reticulum, the
  rendezvous' uplink carries every byte of every pairwise session for
  its lifetime, and if S dies every A↔B flow stops — there's no
  "already migrated to direct, keep going" fallback. Mitigations
  (multiple rendezvous servers, giving LAN peers a listener so they
  go direct, relying on UDP multicast within a LAN) are available
  but have to be configured explicitly. See
  [`p2p-topology.md`](p2p-topology.md) for the full walkthrough.

- **Bootstrap strategy.** Peer discovery relies on kitsune2's
  announce-driven Reticulum bootstrap plus hard-coded TCP dial
  targets via `VOLLA_RETICULUM_DIAL`. There is no integration with a
  Reticulum-native rendezvous service or with Volla's existing
  bootstrap services.
- **Transport selection / coexistence.** A node runs either with or
  without Reticulum based on config. Running Iroh and Reticulum
  concurrently and letting kitsune2 choose per-peer is unvalidated.
- **Mobile builds.** The Reticulum feature is wired for desktop
  builds of Volla only. Android/iOS builds are not configured, and
  BLE as a physical-layer interface — the interesting one for
  mobile mesh — is supported in `rns-transport` but not exposed in
  Volla's config surface.
- **Performance.** There are no measurements of gossip latency,
  fetch throughput, or announce-storm behavior under realistic mesh
  topologies. The default announce cadence (300s) is a dev-time
  tuning knob, not a measured value.
- **Operational concerns.** Identity rotation, multiple identities
  per app install, and recovery from a lost `reticulum.identity`
  file are not covered. A lost identity file means a new peer URL
  and a fresh announce.

