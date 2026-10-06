import { assert, test } from "vitest";

import { runScenario } from "@holochain/tryorama";
import { encodeHashToBase64, type ClonedCell, type DnaModifiersOpt } from "@holochain/client";
import { decode } from "@msgpack/msgpack";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

const ROLE_NAME = "relay";

/** `Privacy::Private`, as the UI sends it (a variant index, not a string). */
const PRIVACY_PRIVATE = 0;

/**
 * Modifiers for a private conversation, matching what
 * `RelayClient.createConversation()` sends — in particular `progenitor` is a
 * base64 string rather than raw bytes, which the DNA properties have depended
 * on since before the UI cloned cells directly.
 */
function privateConversationModifiers(networkSeed: string, progenitorB64: string): any {
  return {
    network_seed: networkSeed,
    properties: {
      created: Date.now(),
      privacy: PRIVACY_PRIVATE,
      progenitor: progenitorB64,
    },
  };
}

test("get_raw_membrane_proof returns the signed envelope an agent joined with", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const networkSeed = "membrane-proof-test-seed";
    const modifiers = privateConversationModifiers(
      networkSeed,
      encodeHashToBase64(alice.agentPubKey),
    );

    // Alice is the progenitor, so `check_agent` lets her in without a proof.
    const aliceClone: ClonedCell = await alice.appWs.createCloneCell({
      role_name: ROLE_NAME,
      name: "test conversation",
      modifiers: modifiers as DnaModifiersOpt,
    });

    // Alice signs a proof naming Bob and this conversation.
    const proof = await alice.appWs.callZome({
      cell_id: aliceClone.cell_id,
      zome_name: "relay",
      fn_name: "generate_membrane_proof",
      payload: {
        conversation_id: networkSeed,
        for_agent: bob.agentPubKey,
        as_role: 0,
      },
    });
    assert.ok(proof, "expected generate_membrane_proof to return an envelope");

    // Genesis validation runs `check_agent`, so an invalid proof would fail
    // here rather than in the assertions below.
    const bobClone: ClonedCell = await bob.appWs.createCloneCell({
      role_name: ROLE_NAME,
      name: "test conversation",
      modifiers: modifiers as DnaModifiersOpt,
      membrane_proof: proof,
    });

    const raw = await bob.appWs.callZome({
      cell_id: bobClone.cell_id,
      zome_name: "relay",
      fn_name: "get_raw_membrane_proof",
      payload: bob.agentPubKey,
    });
    assert.ok(raw, "expected a membrane proof for a conversation Bob did not create");

    // The migration export replays these bytes verbatim, so the signature has
    // to survive the round trip — `get_membrane_proof` drops it, which is why
    // this function exists.
    const envelope = decode(raw as Uint8Array) as any;
    assert.ok(envelope.signature, "envelope must retain the progenitor's signature");
    assert.equal(envelope.data.conversation_id, networkSeed);
    assert.deepEqual(
      new Uint8Array(envelope.data.for_agent),
      new Uint8Array(bob.agentPubKey),
      "proof must name Bob as the joining agent",
    );
  });
});

test("get_raw_membrane_proof returns nothing for the progenitor", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);

    const networkSeed = "membrane-proof-progenitor-seed";
    const aliceClone: ClonedCell = await alice.appWs.createCloneCell({
      role_name: ROLE_NAME,
      name: "test conversation",
      modifiers: privateConversationModifiers(
        networkSeed,
        encodeHashToBase64(alice.agentPubKey),
      ) as DnaModifiersOpt,
    });

    const raw = await alice.appWs.callZome({
      cell_id: aliceClone.cell_id,
      zome_name: "relay",
      fn_name: "get_raw_membrane_proof",
      payload: alice.agentPubKey,
    });

    // The export relies on this: it skips the proof lookup for the progenitor
    // and for public conversations, because neither needs one to re-join.
    assert.isNotOk(raw, "the progenitor joins without a proof, so there is none to read");
  });
});

test("a private conversation rejects an agent with no membrane proof", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const networkSeed = "membrane-proof-rejection-seed";
    const modifiers = privateConversationModifiers(
      networkSeed,
      encodeHashToBase64(alice.agentPubKey),
    );

    await alice.appWs.createCloneCell({
      role_name: ROLE_NAME,
      name: "test conversation",
      modifiers: modifiers as DnaModifiersOpt,
    });

    let rejected = false;
    try {
      await bob.appWs.createCloneCell({
        role_name: ROLE_NAME,
        name: "test conversation",
        modifiers: modifiers as DnaModifiersOpt,
      });
    } catch {
      rejected = true;
    }

    assert.ok(rejected, "joining a private conversation without a proof must fail genesis");
  });
});
