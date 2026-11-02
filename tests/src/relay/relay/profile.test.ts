import { assert, test } from "vitest";

import { runScenario } from '@holochain/tryorama';
import { Record } from '@holochain/client';

const testAppPath = process.cwd() + '/../workdir/relay.happ';
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

// The app repairs a conversation that is missing your profile by checking for
// it with a local-only lookup and writing it when absent
// (ProfileStore.repairMyConversationProfiles). create_profile does not refuse a
// second profile, so that lookup must find a profile you wrote yourself, with
// no network at all — otherwise every launch would add another one.
test('own profile is found by a local-only lookup, and a missing one is reported as missing', async () => {
  await runScenario(async scenario => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const cell = alice.cells[0];
    const agent = cell.cell_id[1];

    const before: Record | null = await cell.callZome({
      zome_name: "profiles",
      fn_name: "get_agent_profile",
      payload: { input: agent, local: true },
    });
    assert.isNull(before, "no profile written yet");

    await cell.callZome({
      zome_name: "profiles",
      fn_name: "create_profile",
      payload: { nickname: "Alice", fields: {} },
    });

    const after: Record | null = await cell.callZome({
      zome_name: "profiles",
      fn_name: "get_agent_profile",
      payload: { input: agent, local: true },
    });
    assert.ok(after, "own profile must be visible locally right after writing it");
  });
});

test('create_profile accepts a second profile for the same agent', async () => {
  // Documents why the repair must check before writing.
  await runScenario(async scenario => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const cell = alice.cells[0];

    await cell.callZome({
      zome_name: "profiles",
      fn_name: "create_profile",
      payload: { nickname: "Alice", fields: {} },
    });
    const second: Record = await cell.callZome({
      zome_name: "profiles",
      fn_name: "create_profile",
      payload: { nickname: "Alice", fields: {} },
    });
    assert.ok(second);
  });
});
