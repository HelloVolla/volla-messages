import { assert, test } from "vitest";

import { runScenario } from "@holochain-open-dev/tryorama";
import { type Record } from "@holochain/client";
import { decode } from "@msgpack/msgpack";

// The function RelayClient uses to build profile writes: this tests the exact
// shape the app sends, not a copy of it.
import { profileZomeInput } from "../../../../ui/src/lib/profileZomeInput";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path", value: testAppPath } };

const profile = {
  nickname: "Alice Example",
  fields: { firstName: "Alice", lastName: "Example", avatar: "" },
};

/**
 * The profiles zome on `main-0.7` takes `{ input, local }` for writes. The app
 * kept sending a bare profile after the 0.7 upgrade, and every profile write
 * failed silently. This pins the contract, so an upstream change to the zome
 * input — or the app's payload drifting from it — fails here instead.
 */
test("profile writes take the shape the app sends, and reject a bare profile", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const cell = alice.cells[0];
    const readProfile = async () => {
      const record: Record | null = await cell.callZome({
        zome_name: "profiles",
        fn_name: "get_agent_profile",
        payload: { input: alice.agentPubKey, local: true },
      });
      return record ? (decode((record.entry as any).Present.entry) as any) : null;
    };

    // The 0.6 shape: rejected, and nothing is created.
    let rejection = "";
    try {
      await cell.callZome({ zome_name: "profiles", fn_name: "create_profile", payload: profile });
    } catch (e) {
      rejection = String((e as any)?.message ?? e);
    }
    assert.ok(rejection, "a bare profile must be rejected");
    assert.isNull(await readProfile());

    // The shape the app sends.
    await cell.callZome({
      zome_name: "profiles",
      fn_name: "create_profile",
      payload: profileZomeInput(profile),
    });
    assert.deepEqual(await readProfile(), profile);

    const updated = { ...profile, nickname: "Alice Updated" };
    await cell.callZome({
      zome_name: "profiles",
      fn_name: "update_profile",
      payload: profileZomeInput(updated),
    });
    assert.equal((await readProfile()).nickname, "Alice Updated");
  });
});

// The app repairs a conversation that is missing your profile by checking for
// it with a local-only lookup and writing it when absent
// (RelayClient.ensureMyProfileForConversation). create_profile does not refuse
// a second profile, so that lookup must find a profile you wrote yourself, with
// no network at all — otherwise every launch would add another one.
test("own profile is found by a local-only lookup, and a missing one is reported as missing", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const cell = alice.cells[0];
    const lookup = (): Promise<Record | null> =>
      cell.callZome({
        zome_name: "profiles",
        fn_name: "get_agent_profile",
        payload: { input: alice.agentPubKey, local: true },
      });

    assert.isNull(await lookup(), "no profile written yet");
    await cell.callZome({
      zome_name: "profiles",
      fn_name: "create_profile",
      payload: profileZomeInput(profile),
    });
    assert.ok(await lookup(), "own profile must be visible locally right after writing it");
  });
});

test("create_profile accepts a second profile for the same agent", async () => {
  // Documents why ensureMyProfileForConversation must check before writing.
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    const cell = alice.cells[0];
    for (let i = 0; i < 2; i++) {
      const record: Record = await cell.callZome({
        zome_name: "profiles",
        fn_name: "create_profile",
        payload: profileZomeInput(profile),
      });
      assert.ok(record);
    }
  });
});
