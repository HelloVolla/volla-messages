import { assert, expect, test } from "vitest";

import { runScenario, dhtSync, CallableCell } from '@holochain/tryorama';
import { AgentPubKey } from '@holochain/client';

const testAppPath = process.cwd() + '/../workdir/relay.happ';
const appSource = { appBundleSource: { type: "path" as const, value: testAppPath } };

async function getRole(cell: CallableCell, agent: AgentPubKey): Promise<string> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "get_role",
    payload: { input: agent, local: true },
  });
}

test('progenitor resolves to Owner without any grant', async () => {
  await runScenario(async scenario => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const role = await getRole(alice.cells[0], alice.agentPubKey);
    assert.equal(role, "Owner");
  });
});

test('progenitor can grant Moderator, and it is visible to other agents', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    assert.equal(await getRole(bob.cells[0], bob.agentPubKey), "Moderator");
    assert.equal(await getRole(alice.cells[0], bob.agentPubKey), "Moderator");
  });
});

test('a non-owner cannot grant Moderator', async () => {
  await runScenario(async scenario => {
    const [alice, bob, carol] = await scenario.addPlayersWithApps([appSource, appSource, appSource]);
    await scenario.shareAllAgents();

    await expect(
      bob.cells[0].callZome({
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

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    assert.equal(await getRole(alice.cells[0], bob.agentPubKey), "Moderator");

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "revoke_moderator_role",
      payload: bob.agentPubKey,
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    assert.equal(await getRole(alice.cells[0], bob.agentPubKey), "Member");
  });
});

test('a non-owner cannot revoke a Moderator grant', async () => {
  await runScenario(async scenario => {
    const [alice, bob, carol] = await scenario.addPlayersWithApps([appSource, appSource, appSource]);
    await scenario.shareAllAgents();

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "grant_moderator_role",
      payload: carol.agentPubKey,
    });
    await dhtSync([alice, bob, carol], alice.cells[0].cell_id[0]);

    await expect(
      bob.cells[0].callZome({
        zome_name: "relay",
        fn_name: "revoke_moderator_role",
        payload: carol.agentPubKey,
      }),
    ).rejects.toThrow();
  });
});
