# Conversation moderation: role-enforcement design

Scopes the mechanism for #209, #210, #212, #214, #215, #217 (everything in
the moderation epic that needs to reject a write from an unauthorized agent).
#208 (role foundation) is done and merged-ready; this is about what comes
next before touching any of the above.

## The problem

`hdi` (integrity zomes, where `validate` runs) has no `get_links` and no
`get` — only deterministic `must_get_action`, `must_get_entry`,
`must_get_valid_record`, and `must_get_agent_activity`. That's why #208's
`get_role` (which does call `get_links`) lives in the *coordinator* zome:
it's a convenience read, not something validation can rely on.

Everything from here on needs the opposite: a check that runs inside
`validate_*` and therefore constrains every honest peer on the network, not
just the client that's supposed to call the gated coordinator fn. Example
from #214's own wording: "enforced at the integrity layer so honest peers
never propagate an unauthorized message." A coordinator-side check alone
doesn't give you that — it only stops a well-behaved UI, not a hand-crafted
zome call.

`RoleGrant` (#208) was originally a DHT *link* (`roles` anchor → agent, tag
`Moderator`). Validation can't query "does agent X have a live RoleGrant
link" — that's exactly the nondeterministic query HDI removed. So
`validate_update_config` (#209) can't ask "is this author a Moderator?" the
way `get_role` does.

**Update:** confirmed against lightningrodlabs/moss's `StewardPermission` —
a production Holochain app solving the identical problem for group roles.
It uses an *entry* rather than a link, exactly so other validators can cite
its ActionHash as evidence and confirm it with `must_get_valid_record`
without ever needing to enumerate links. `RoleGrant` was reworked from a
link into an entry to match (see `role.rs` in both zomes) — the mechanism
below is unchanged, just cleaner to point evidence at an entry than at a
`CreateLink` action.

## Why `must_get_agent_activity` doesn't save us

It looks like the deterministic escape hatch, but it needs a specific
`ActionHash` to anchor the chain walk (`ChainFilter::new(chain_top)`).
There's no "give me agent X's current chain tip" — you always need to
already know a hash. So it doesn't let validation discover a role grant it
wasn't told about; it only lets validation *confirm* a specific,
already-named action. Same fundamental requirement as the option below.

## The only deterministic option: evidence in the write

The write itself carries the `RoleGrant` entry's `ActionHash` as evidence.
`validate_update_config` (or whichever `validate_*`) then:

1. If `action.author == progenitor` (Owner): valid, no evidence needed.
2. Else: require an evidence `ActionHash`. Fetch it with
   `must_get_valid_record`, decode it as a `RoleGrant`, confirm
   `for_agent == action.author`. `must_get_valid_record` only returns
   entries the network has already run through `validate_create_role_grant`
   successfully, so the grant's own owner-only authorization is already
   covered — no need to re-derive it here.

This is deterministic. Its one real gap:
it can't prove the grant *hasn't since been revoked* — a validator that
hasn't yet seen the `DeleteLink` will accept stale evidence. That's the
same class of gap this epic already accepts by name for #212 ("hiding
already-shared content from a malicious peer is soft: P2P limitation") and
#217/#218 (soft, cooperative-only removal/ban). Treating revocation lag the
same way keeps one consistent security story across the epic instead of a
stronger guarantee in one place and a weaker one next to it.

## Cost

Every role-gated entry needs a small schema addition — an
`Option<ActionHash>` evidence field (name TBD, e.g. `role_evidence`):

- `Config` (#209) — new field on the entry.
- Grant/revoke Writer (#215) — evidence needed when a Moderator (not Owner)
  grants.
- `Message` (#212) — evidence needed when a Moderator deletes someone
  else's message.
- Read-only write enforcement (#214) — evidence needed for a Writer's
  message create.
- Removed-agent marker (#217) — evidence needed if a Moderator (not Owner)
  removes.
- #210 (grant/revoke Moderator) is Owner-only per #208, so no evidence field
  needed there — `owner_only` already covers it.

Coordinator fns absorb the plumbing: look up the caller's own current
`get_role`/evidence link locally (`GetStrategy::Local`, same pattern
`grant_moderator_role`/`revoke_moderator_role` already use in #208) and
attach the hash automatically, so the UI never has to know evidence exists.

## Status

#208 reworked (`RoleGrant` link → entry) and #209 landed as the reference
implementation: `Config.role_evidence: Option<ActionHash>`,
`require_owner_or_moderator` in `role.rs` (integrity), `find_role_grant` in
`role.rs` (coordinator) looked up automatically inside `set_config` so the
UI never has to know evidence exists. Reuse both for #210/#212/#214/#215/#217
rather than re-deriving the pattern per issue.

## #218 Ban and rejoin (partial enforcement)

Ban creates a Ban entry, removes the agent's membership and role grants, and the coordinator refuses to issue a membrane proof for a banned agent or to let them self-join.

Limits, which are enforced cooperatively and not by validation:
- A banned agent who already holds a valid membrane proof for a private conversation can still pass genesis. Genesis is only checked against the proof, and a proof can't be revoked deterministically.
- Public conversations have no membrane proof. Anyone can self-join by calling the membership coordinator function directly from a hand-built client, and validation can't reject it.
- Only the coordinator enforces the ban on honest clients. A modified client can bypass it.
