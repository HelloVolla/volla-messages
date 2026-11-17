import { assert, test } from "vitest";
import { createPublicKey, randomBytes, verify } from "node:crypto";

import { runScenario } from "@holochain-open-dev/tryorama";
import { sliceCore32 } from "@holochain/client";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

const DOMAIN = Buffer.from("volla-turn-cred-v2");

interface TurnProof {
  device: Uint8Array;
  signature: Uint8Array;
}

function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
    format: "jwk",
  });
  return verify(null, message, key, signature);
}

test("sign_turn_challenge signs domain || nonce || device with the device key, not the agent key", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const device = await alice.conductor.adminWs().generateAgentPubKey();
    const nonce = new Uint8Array(randomBytes(32));

    const proof: TurnProof = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "sign_turn_challenge",
      payload: { nonce, device },
    });

    const deviceCore = sliceCore32(device);
    assert.deepEqual(new Uint8Array(proof.device), deviceCore);
    assert.equal(proof.signature.length, 64);

    const message = Buffer.concat([DOMAIN, nonce, deviceCore]);
    assert.isTrue(ed25519Verify(deviceCore, message, proof.signature));
    assert.isFalse(ed25519Verify(sliceCore32(alice.agentPubKey), message, proof.signature));

    const forged = Buffer.concat([DOMAIN, new Uint8Array(randomBytes(32)), deviceCore]);
    assert.isFalse(ed25519Verify(deviceCore, forged, proof.signature));
  });
});

test("sign_turn_challenge rejects a nonce that is not 32 bytes", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const device = await alice.conductor.adminWs().generateAgentPubKey();

    for (const len of [0, 31, 33, 64]) {
      await expectRejects(
        alice.cells[0].callZome({
          zome_name: "relay",
          fn_name: "sign_turn_challenge",
          payload: { nonce: new Uint8Array(len), device },
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
