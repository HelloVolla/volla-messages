import { assert, test } from "vitest";

import { runScenario, dhtSync } from '@holochain/tryorama';
import { Record } from '@holochain/client';
import { decode } from '@msgpack/msgpack';

import { sampleConfig, setConfig } from './common.js';

const testAppPath = process.cwd() + '/../workdir/relay.happ';
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

test('set and get Config', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const sample = await sampleConfig(alice.cells[0]);
    await setConfig(alice.cells[0], sample);

    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const record: Record = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_config",
      payload: { input: null, local: true },
    });
    assert.ok(record);
    assert.deepEqual(sample, decode((record.entry as any).Present.entry) as any);
  });
});

test('get_config returns the most recently set Config', async () => {
  await runScenario(async scenario => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    await setConfig(alice.cells[0], await sampleConfig(alice.cells[0], { title: "First" }));
    const latest = await sampleConfig(alice.cells[0], { title: "Second" });
    await setConfig(alice.cells[0], latest);

    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const record: Record = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_config",
      payload: { input: null, local: true },
    });
    assert.deepEqual(latest, decode((record.entry as any).Present.entry) as any);
  });
});
