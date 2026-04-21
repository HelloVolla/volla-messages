# Reticulum P2P Topology

How "peer-to-peer" works in the Reticulum transport used by Volla — and how it
differs from the hole-punching model used by iroh / WebRTC.

## TCP sockets are bidirectional once connected

When a `TcpClient` dials a `TcpServer`, TCP creates a single socket that carries
data both ways for the lifetime of the connection. Packets flow *in* through
the same pipe they flow *out*. A node with only
`TcpClient { target: S }` doesn't need a listener to receive data — the socket
it opened to S is already the receive path.

That socket is **persistent**: it's opened when the interface starts and kept
open as long as `rns_transport` is running. There's no per-packet dial-redial.
TCP keepalives handle dead-connection detection. The Reticulum-layer
`link_idle_timeout_s` is a *different* thing — it's the cryptographic Link
session on top, not the underlying TCP socket.

A `TcpClient`-only node receives packets **exclusively** through the TCP
socket(s) it opened. If you configure
`interfaces: vec![TcpClient { target: S }]`, that box's only window onto the
Reticulum network is through S. If S goes down, that node is isolated until S
comes back up.

## The "P2P" is logical, not topological

Four layers worth separating:

- **TCP layer (physical)**: A → S and B → S. A and B have no direct TCP link
  to each other. Every byte they exchange physically transits the S box.
- **Reticulum layer (routing)**: S's `rns_transport` inspects incoming
  packets, reads the destination hash, looks up the path table, and re-sends
  the packet out a different interface. For an A→B packet arriving on the
  A↔S socket, S looks up "I have a path to B via the B↔S socket," and writes
  the packet there. S is acting as a store-and-forward router, packet by
  packet.
- **Reticulum Link layer (cryptographic)**: A and B do an end-to-end Link
  handshake (1-RTT) that establishes a shared symmetric key. From that point,
  payloads in A↔B packets are encrypted with a key S does not hold. S sees the
  routing envelope (destination hash, Link ID, timing, size) but not the
  content.
- **kitsune2 / holochain layer**: sees A and B as peers with a direct,
  encrypted, bidirectional channel. Has no knowledge that S exists as an
  intermediary.

So "P2P" in this model is: cryptographically end-to-end, topologically
possibly routed through intermediaries. This is the tor-ish / overlay-network
model, not the WebRTC hole-punch model.

## How a "P2P connection" actually forms

The sequence for A and B both behind TcpClient→S:

1. **Announce propagation.** B announces itself. The announce packet hops:
   B → (B↔S socket) → S → (S↔A socket) → A. A's path table now has an entry
   for B's destination hash, marked as "reachable via the S interface."
2. **Link request** (when A wants to talk to B). A's kitsune2 asks the
   transport to send a frame to B. The transport sees no existing Link,
   triggers a Link request packet, routed via the path table — goes to S,
   then to B.
3. **Link proof.** B responds with a Link proof packet. Same path in reverse.
4. **Key derivation.** Both sides derive the shared Link key from the
   handshake. This is end-to-end; S saw the handshake go by but doesn't hold
   the shared secret (it's ECDH between A's and B's Reticulum identities).
5. **Data packets.** Subsequent frames encrypted with the Link key, routed
   via S, decrypted on arrival. kitsune2 sees bidirectional message flow.

From kitsune2's point of view this all happens under the hood of
`transport.send(to: B_url, frame)`. It never learns the topology.

## When is there actually a direct socket between peers?

Only when at least one of them has a listener the other can reach, and the two
sides establish a direct TCP interface-level connection. Reticulum doesn't do
hole-punching — there's no STUN, no ICE, no relay→direct upgrade. If A is
`TcpClient`-only and B is `TcpClient`-only, they will *never* have a direct
TCP connection to each other, even if the network would allow it. Every A↔B
packet goes through S for the entire lifetime of those processes.

Contrast with iroh / tx5:

- iroh / tx5 start with a relay path (through the signaling/relay server) and
  then probe for direct reachability. If they find a working direct path via
  hole-punched UDP, they migrate the connection to the direct path and stop
  using the relay. Server load drops to zero steady-state for that pair.
- Reticulum does not do this. Every A↔B packet traverses the configured
  topology for its entire session. If you want a direct A↔B path, you
  configure it explicitly: give one of them a `TcpServer` and the other a
  `TcpClient` pointing at it, and the Reticulum path table will prefer the
  shorter (direct) route over the longer (through-S) route when an announce
  reveals both.

## Practical consequences

1. **Server S bandwidth is load-bearing.** In a 3-peer TCP-rendezvous topology
   with A, B, C all dialing S, every pairwise message between any two of them
   hits S's NIC twice (once in, once out). If you're testing file transfers or
   media, S's uplink is the bottleneck.
2. **No graceful degradation if S dies.** Unlike iroh where peers can survive
   the signal server going offline once direct connections are established,
   here *every* message stops flowing the moment S disappears. For sustained
   testing, consider running a second `TcpServer` on a different machine and
   giving each peer *two* `TcpClient` interfaces — Reticulum will route via
   whichever is reachable, so S going down just means falling over to the
   backup.
3. **If you want real P2P (direct sockets) between two specific machines**,
   put `TcpServer` on one of them and `TcpClient` on the other. They become
   adjacent in the topology, no intermediary.
4. **Mixed topologies work.** On a dev laptop you can run
   `TcpClient → VPS-S` *and* `TcpServer { bind: "0.0.0.0:4242" }` at the same
   time. You reach distant peers through S; you reach LAN peers (who dial you
   directly on 4242) without S in the path. Reticulum picks the shorter route
   per-destination.
5. **UDP multicast gives you symmetric LAN discovery.** On the same LAN, a
   `Udp` interface needs no listener/dialer role — every node broadcasts and
   every node receives. No intermediary, no single point of failure, no
   configuration beyond "include the Udp interface." Fails silently when
   multicast is blocked (some WiFi APs, most cloud VPCs, Docker bridge
   networks), so it's safe to always include — it either works or it's a
   no-op.

## Glossary

- **Announce**: a Reticulum broadcast packet advertising a destination's
  existence and providing path-discovery information. Holochain emits one per
  joined kitsune2 space, on a cadence set by `announce_interval_s` (default
  300s).
- **Destination hash**: 32-byte hash of a Reticulum `Destination`. The unit
  Reticulum routes by. The hex encoding is what appears in `ret://` URLs.
- **Link**: encrypted bidirectional session between two Reticulum
  destinations. Established by request + proof handshake; torn down after
  `link_idle_timeout_s` of inactivity.
- **Path table**: each node's cache of "which interface do I send to, to
  reach destination X?" Populated by announces; entries expire.
- **Interface**: one I/O attachment to the outside world (`TcpServer`,
  `TcpClient`, `Udp`, `LoRa`, etc.). A node can run several simultaneously.
