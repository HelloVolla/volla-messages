import { assert, test } from "vitest";

import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import { type ActionHash, type Record } from "@holochain/client";
import { decode } from "@msgpack/msgpack";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

const HISTORY_FORMAT = "volla.history.day";

function sampleInfo(part: number, format = HISTORY_FORMAT) {
  return {
    format,
    version: 1,
    part,
    data: new Uint8Array([1, 2, 3, part]),
  };
}

function entryOf(record: Record): any {
  return decode((record.entry as any).Present.entry);
}

test("private migration info is readable by its author only", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(1), shared: false },
    });

    const mine: Record[] = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_my_migration_info",
      payload: null,
    });
    assert.equal(mine.length, 1);
    const info = entryOf(mine[0]);
    assert.equal(info.format, HISTORY_FORMAT);
    assert.deepEqual(new Uint8Array(info.data), new Uint8Array([1, 2, 3, 1]));

    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    const seenByBob: Record[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_migration_info_for_agent",
      payload: { input: { agent: alice.agentPubKey, format: null }, local: false },
    });
    assert.equal(seenByBob.length, 0);
  });
});

test("shared migration info is readable by other members, filtered by format", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(7), shared: true },
    });
    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(8, "volla.images"), shared: true },
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const all: Record[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_migration_info_for_agent",
      payload: { input: { agent: alice.agentPubKey, format: null }, local: false },
    });
    assert.equal(all.length, 2);

    const history: Record[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_migration_info_for_agent",
      payload: { input: { agent: alice.agentPubKey, format: HISTORY_FORMAT }, local: false },
    });
    assert.equal(history.length, 1);
    assert.equal(entryOf(history[0]).part, 7);

    // The author sees both through their own chain as well.
    const mine: Record[] = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_my_migration_info",
      payload: HISTORY_FORMAT,
    });
    assert.equal(mine.length, 1);
  });
});

test("deleted migration info disappears, and only its author can delete it", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const shared: ActionHash = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(1), shared: true },
    });
    const privateHash: ActionHash = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(2), shared: false },
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    // Bob cannot delete Alice's entry.
    let rejection = "";
    try {
      await bob.cells[0].callZome({
        zome_name: "relay",
        fn_name: "delete_migration_info",
        payload: shared,
      });
    } catch (e) {
      rejection = String((e as any)?.message ?? e);
    }
    assert.include(rejection, "Only the author can delete migration info");

    // Alice deletes both: the shared one and the private one.
    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "delete_migration_info",
      payload: shared,
    });
    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "delete_migration_info",
      payload: privateHash,
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const mine: Record[] = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_my_migration_info",
      payload: null,
    });
    assert.equal(mine.length, 0);

    const seenByBob: Record[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_migration_info_for_agent",
      payload: { input: { agent: alice.agentPubKey, format: null }, local: false },
    });
    assert.equal(seenByBob.length, 0);
  });
});

test("another agent cannot delete a private migration info entry", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const privateHash: ActionHash = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(3), shared: false },
    });
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    let rejection = "";
    try {
      await bob.cells[0].callZome({
        zome_name: "relay",
        fn_name: "delete_migration_info",
        payload: privateHash,
      });
    } catch (e) {
      rejection = String((e as any)?.message ?? e);
    }
    assert.include(rejection, "Only the author can delete migration info");

    const mine: Record[] = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_my_migration_info",
      payload: null,
    });
    assert.equal(mine.length, 1);
  });
});

test("migration info format must be 1 to 64 bytes", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);

    for (const format of ["", "x".repeat(65)]) {
      let rejection = "";
      try {
        await alice.cells[0].callZome({
          zome_name: "relay",
          fn_name: "create_migration_info",
          payload: { info: sampleInfo(1, format), shared: true },
        });
      } catch (e) {
        rejection = String((e as any)?.message ?? e);
      }
      assert.include(rejection, "Migration info format must be 1 to 64 bytes");
    }

    // The boundary itself is allowed.
    await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "create_migration_info",
      payload: { info: sampleInfo(1, "x".repeat(64)), shared: true },
    });
  });
});
