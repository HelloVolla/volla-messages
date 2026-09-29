import { assert, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";

import { runScenario, dhtSync, CallableCell, PlayerApp } from '@holochain/tryorama';
import { AgentPubKey, encodeHashToBase64, Record } from '@holochain/client';

import { createMessage } from './common.js';

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

test('a plain member cannot set_config', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    await expect(
      bobConversation.callZome({
        zome_name: "relay",
        fn_name: "set_config",
        payload: { title: "Renamed by a member", image: "" },
      }),
    ).rejects.toThrow();
  });
});

test('a Moderator can set_config', async () => {
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

    await bobConversation.callZome({
      zome_name: "relay",
      fn_name: "set_config",
      payload: { title: "Renamed by a moderator", image: "" },
    });
  });
});

test('a plain member cannot delete another agent\'s message', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    const aliceConversation = await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    const message: Record = await createMessage(aliceConversation);
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);

    await expect(
      bobConversation.callZome({
        zome_name: "relay",
        fn_name: "delete_message",
        payload: { original_message_hash: message.signed_action.hashed.hash, agents: [] },
      }),
    ).rejects.toThrow();
  });
});

test('a Moderator can delete another agent\'s message', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const networkSeed = uuidv4();
    const created = Date.now();
    const aliceConversation = await createConversationCell(alice, networkSeed, alice.agentPubKey, created);
    const bobConversation = await createConversationCell(bob, networkSeed, alice.agentPubKey, created);

    const message: Record = await createMessage(aliceConversation);
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], aliceConversation.cell_id[0]);

    await bobConversation.callZome({
      zome_name: "relay",
      fn_name: "delete_message",
      payload: { original_message_hash: message.signed_action.hashed.hash, agents: [] },
    });
  });
});

test('get_moderators lists current grants and drops revoked ones', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const aliceConversation = await createConversationCell(alice, uuidv4(), alice.agentPubKey, Date.now());

    assert.deepEqual(
      await aliceConversation.callZome({ zome_name: "relay", fn_name: "get_moderators", payload: null }),
      [],
    );

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    const moderators: AgentPubKey[] = await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "get_moderators",
      payload: null,
    });
    assert.equal(moderators.length, 1);
    assert.equal(encodeHashToBase64(moderators[0]), encodeHashToBase64(bob.agentPubKey));

    await aliceConversation.callZome({
      zome_name: "relay",
      fn_name: "revoke_moderator_role",
      payload: bob.agentPubKey,
    });
    assert.deepEqual(
      await aliceConversation.callZome({ zome_name: "relay", fn_name: "get_moderators", payload: null }),
      [],
    );
  });
});
