import { assert, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";

import { runScenario, dhtSync, CallableCell, PlayerApp } from '@holochain/tryorama';
import { AgentPubKey, encodeHashToBase64 } from '@holochain/client';

const testAppPath = process.cwd() + '/../workdir/relay.happ';
const appSource = { appBundleSource: { type: "path" as const, value: testAppPath } };

async function getRole(cell: CallableCell, agent: AgentPubKey): Promise<string> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "get_role",
    payload: { input: agent, local: true },
  });
}

// A conversation is a clone of the "relay" role with its own network seed and
// progenitor, mirroring RelayClient.createConversation/joinConversation — the
// provisioned base cell (player.cells[0]) is never a conversation itself.
// Public privacy so a non-owner can join without a membrane proof.
async function createConversationCell(
  player: PlayerApp,
  networkSeed: string,
  progenitor: AgentPubKey,
  created: number,
): Promise<CallableCell> {
  const clonedCell = await player.appWs.createCloneCell({
    role_name: "relay",
    modifiers: {
      network_seed: networkSeed,
      properties: {
        created,
        privacy: "Public",
        progenitor: encodeHashToBase64(progenitor),
      },
    },
  });
  return {
    ...clonedCell,
    callZome: (request, timeout) =>
      player.appWs.callZome({ ...request, cell_id: clonedCell.cell_id }, timeout),
  };
}

test('progenitor resolves to Owner without any grant', async () => {
  await runScenario(async scenario => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const conversation = await createConversationCell(alice, uuidv4(), alice.agentPubKey, Date.now());
    const role = await getRole(conversation, alice.agentPubKey);
    assert.equal(role, "Owner");
  });
});

test('progenitor can grant Moderator, and it is visible to other agents', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    const aliceConversation = await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);

    assert.equal(await getRole(bobConversation, bob.agentPubKey), "Moderator");
    assert.equal(await getRole(aliceConversation, bob.agentPubKey), "Moderator");
  });
});

test('a non-owner cannot grant Moderator', async () => {
  await runScenario(async scenario => {
    const [alice, bob, carol] = await scenario.addPlayersWithApps([appSource, appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    await expect(
      bobConversation.callZome({
        zome_name: "relay",
        fn_name: "grant_moderator_role",
        payload: carol.agentPubKey,
      }),
    ).rejects.toThrow();
  });
});

test('the owner can revoke a Moderator grant', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    const aliceConversation = await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);
    assert.equal(await getRole(aliceConversation, bob.agentPubKey), "Moderator");

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "revoke_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);
    assert.equal(await getRole(aliceConversation, bob.agentPubKey), "Member");
  });
});

test('a non-owner cannot revoke a Moderator grant', async () => {
  await runScenario(async scenario => {
    const [alice, bob, carol] = await scenario.addPlayersWithApps([appSource, appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    const aliceConversation = await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);
    const carolConversation = await createConversationCell(carol, networkSeed, alice.agentPubKey, created);

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: carol.agentPubKey,
    });
    await dhtSync([alice, bob, carol], aliceConversation.cell_id[0]);

    await expect(
      bobConversation.callZome({
        zome_name: "relay",
        fn_name: "revoke_moderator_role",
        payload: carol.agentPubKey,
      }),
    ).rejects.toThrow();
  });
});
