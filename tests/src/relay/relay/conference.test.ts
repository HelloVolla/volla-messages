import { assert, expect, test } from "vitest";

import { runScenario, dhtSync } from "@holochain/tryorama";
import { encodeHashToBase64, fakeAgentPubKey } from "@holochain/client";

import {
  captureSignals,
  createConference,
  endConferenceForAll,
  joinConference,
  rejectConference,
  signalsOfType,
  waitFor,
} from "./common.js";

const testAppPath = process.cwd() + "/../workdir/relay.happ";
const appSource = { appBundleSource: { type: "path" as const, value: testAppPath } };

test("create Conference returns a room and does not signal the creator", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const aliceSignals = captureSignals(alice);
    const bobSignals = captureSignals(bob);

    const outcome = await createConference(alice.cells[0], [bob.agentPubKey]);

    assert.ok(outcome.room_id, "expected a room_id");
    assert.equal(outcome.joined_existing, false);

    await waitFor(() => signalsOfType(bobSignals, "ConferenceInvite").length > 0);

    assert.equal(
      signalsOfType(bobSignals, "ConferenceInvite").length,
      1,
      "bob should be invited exactly once",
    );
    assert.equal(
      signalsOfType(aliceSignals, "ConferenceInvite").length,
      0,
      "alice must not invite herself to her own conference",
    );
  });
});

// Regression test. reject_conference used to forward its recipient list verbatim, and that list
// is built from the participant roster, which includes the rejecter. The rejecter therefore
// received their own Reject signal and marked themselves declined.
test("rejecting a conference signals the other participants but never the rejecter", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const outcome = await createConference(alice.cells[0], [bob.agentPubKey]);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const aliceSignals = captureSignals(alice);
    const bobSignals = captureSignals(bob);

    // The roster the client passes includes bob himself, exactly as the UI does.
    await rejectConference(bob.cells[0], outcome.room_id, [alice.agentPubKey, bob.agentPubKey]);

    await waitFor(() => signalsOfType(aliceSignals, "ConferenceRejected").length > 0);

    const aliceRejects = signalsOfType(aliceSignals, "ConferenceRejected");
    assert.equal(aliceRejects.length, 1, "alice should be told once that bob declined");
    assert.equal(
      encodeHashToBase64(aliceRejects[0].agent as Uint8Array),
      encodeHashToBase64(bob.agentPubKey),
      "the reject should name bob as the decliner",
    );

    assert.equal(
      signalsOfType(bobSignals, "ConferenceRejected").length,
      0,
      "bob must not be told that he himself declined",
    );
  });
});

test("joining a conference signals the other participants but never the joiner", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const outcome = await createConference(alice.cells[0], [bob.agentPubKey]);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const aliceSignals = captureSignals(alice);
    const bobSignals = captureSignals(bob);

    await joinConference(bob.cells[0], outcome.room_id, [alice.agentPubKey, bob.agentPubKey]);

    await waitFor(() => signalsOfType(aliceSignals, "ConferenceJoined").length > 0);

    assert.equal(signalsOfType(aliceSignals, "ConferenceJoined").length, 1);
    assert.equal(
      signalsOfType(bobSignals, "ConferenceJoined").length,
      0,
      "bob must not be told that he himself joined",
    );
  });
});

test("ending a conference signals the other participants but never the ender", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const outcome = await createConference(alice.cells[0], [bob.agentPubKey]);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    await joinConference(bob.cells[0], outcome.room_id, [alice.agentPubKey, bob.agentPubKey]);

    const aliceSignals = captureSignals(alice);
    const bobSignals = captureSignals(bob);

    await endConferenceForAll(alice.cells[0], outcome.room_id, [
      alice.agentPubKey,
      bob.agentPubKey,
    ]);

    await waitFor(() => signalsOfType(bobSignals, "ConferenceEnded").length > 0);

    assert.equal(signalsOfType(bobSignals, "ConferenceEnded").length, 1);
    assert.equal(
      signalsOfType(aliceSignals, "ConferenceEnded").length,
      0,
      "alice must not be told that she herself ended the call",
    );
  });
});

test("a second create call joins the existing conference rather than opening a new one", async () => {
  await runScenario(async (scenario) => {
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const first = await createConference(alice.cells[0], [bob.agentPubKey]);
    const second = await createConference(alice.cells[0], [bob.agentPubKey]);

    assert.equal(second.room_id, first.room_id, "should reuse the active room");
    assert.equal(second.joined_existing, true);
  });
});

test("a conference cannot exceed the mesh participant limit", async () => {
  await runScenario(async (scenario) => {
    const [alice] = await scenario.addPlayersWithApps([appSource]);
    await scenario.shareAllAgents();

    // MAX_CONFERENCE_PARTICIPANTS is 6 and counts the creator, so 6 invitees is 7 total.
    // The guard runs before any signal is sent, so fake keys are enough — spinning up six more
    // conductors would make this the slowest test in the suite for no extra coverage.
    const tooMany = await Promise.all(Array.from({ length: 6 }, () => fakeAgentPubKey()));

    await expect(createConference(alice.cells[0], tooMany)).rejects.toThrow();
  });
});
