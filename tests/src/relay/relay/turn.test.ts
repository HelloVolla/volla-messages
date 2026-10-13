import { assert, test } from "vitest";
import { createPublicKey, randomBytes, verify } from "node:crypto";

import { runScenario } from "@holochain/tryorama";
import { sliceCore32 } from "@holochain/client";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

interface TurnProof {
  space: Uint8Array;
  agent: Uint8Array;
  signature: Uint8Array;
}

function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
    format: "jwk",
  });
  return verify(null, message, key, signature);
}

test("sign_turn_challenge signs domain || nonce || space || agent with the raw agent key", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const nonce = new Uint8Array(randomBytes(32));

    const proof: TurnProof = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "sign_turn_challenge",
      payload: nonce,
    });

    const [dnaHash, agentPubKey] = alice.cells[0].cell_id;
    assert.deepEqual(new Uint8Array(proof.space), sliceCore32(dnaHash));
    assert.deepEqual(new Uint8Array(proof.agent), sliceCore32(agentPubKey));
    assert.equal(proof.signature.length, 64);

    const message = Buffer.concat([
      Buffer.from("k2-turn-cred-v1"),
      nonce,
      proof.space,
      proof.agent,
    ]);
    assert.isTrue(ed25519Verify(proof.agent, message, proof.signature));

    const otherNonce = new Uint8Array(randomBytes(32));
    const forged = Buffer.concat([
      Buffer.from("k2-turn-cred-v1"),
      otherNonce,
      proof.space,
      proof.agent,
    ]);
    assert.isFalse(ed25519Verify(proof.agent, forged, proof.signature));
  });
});

test("sign_turn_challenge rejects a nonce that is not 32 bytes", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);

    for (const len of [0, 31, 33, 64]) {
      await expectRejects(
        alice.cells[0].callZome({
          zome_name: "relay",
          fn_name: "sign_turn_challenge",
          payload: new Uint8Array(len),
        }),
      );
    }
  });
});

async function expectRejects(p: Promise<unknown>) {
  try {
    await p;
  } catch {
    return;
  }
  assert.fail("expected the zome call to be rejected");
}
