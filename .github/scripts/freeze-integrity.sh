#!/usr/bin/env bash
# Give a freshly built 1.x happ the integrity zomes Volla Messages 1.0.3 shipped.
#
# The DNA hash comes from the integrity zomes' wasm bytes, and those depend on
# the compiler: happ-v0.12.2 (embedded in 1.0.3) was built with rustc 1.94.0,
# while this branch now pins 1.89.0 (rust-toolchain.toml). Rebuilding the same
# integrity source with another compiler gives a new DNA hash, and fresh
# installs would then sit on a network no existing user is on.
#
# Integrity on the 1.x line is frozen, so we keep the shipped integrity wasm and
# take only the newly built coordinators. That is the exact combination existing
# installs run once their coordinators are updated in place.
#
# Usage: freeze-integrity.sh [path/to/relay.happ]   (needs `hc`, from the nix shell)
set -euo pipefail

REFERENCE_URL="https://github.com/HelloVolla/volla-messages/releases/download/happ-v0.12.2/relay.happ"
REFERENCE_SHA256="94e8f726b197a3fcc89e62d773b6cde9362327234880fa9972ef35dd5c55049c"
# DNA hash of the relay role every 1.x install has; never changes on this line.
EXPECTED_DNA_HASH="uhC0kC2rQgOpuxJtKhEghaT4j_jQlzVH7pVdpUI8DBJ9_PtcA0zns"
INTEGRITY_ZOMES=(profiles_integrity file_storage_integrity relay_integrity)

happ="${1:-workdir/relay.happ}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

dna_hash() { hc dna hash "$1" | grep -o 'uhC0k[A-Za-z0-9_-]*' | tail -1; }

curl -sfL "$REFERENCE_URL" -o "$work/reference.happ"
echo "$REFERENCE_SHA256  $work/reference.happ" | sha256sum -c --quiet -

hc app unpack "$work/reference.happ" -o "$work/reference-app" >/dev/null
hc dna unpack "$work/reference-app/relay.dna" -o "$work/reference-dna" >/dev/null
hc app unpack "$happ" -o "$work/app" >/dev/null
hc dna unpack "$work/app/relay.dna" -o "$work/dna" >/dev/null

# Same zomes, same order, same manifests: anything else is not a coordinator-only release.
diff -u "$work/reference-dna/dna.yaml" "$work/dna/dna.yaml"
diff -u "$work/reference-app/happ.yaml" "$work/app/happ.yaml"

echo "Built DNA hash:    $(dna_hash "$work/app/relay.dna")"
for zome in "${INTEGRITY_ZOMES[@]}"; do
  cp "$work/reference-dna/$zome.wasm" "$work/dna/$zome.wasm"
done

rm "$work/app/relay.dna"
hc dna pack "$work/dna" -o "$work/app/relay.dna" >/dev/null
actual="$(dna_hash "$work/app/relay.dna")"
echo "Shipped DNA hash:  $actual"
if [ "$actual" != "$EXPECTED_DNA_HASH" ]; then
  echo "DNA hash $actual is not the 1.x hash $EXPECTED_DNA_HASH" >&2
  exit 1
fi

hc app pack "$work/app" -o "$happ" >/dev/null
echo "Wrote $happ with the 1.0.3 integrity zomes"
