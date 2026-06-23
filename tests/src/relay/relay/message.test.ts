import { assert, test } from "vitest";

import { runScenario, dhtSync, CallableCell } from '@holochain/tryorama';
import {
  NewEntryAction,
  ActionHash,
  Record,
  Link,
  CreateLink,
  DeleteLink,
  SignedActionHashed,
  AppBundleSource,
  fakeActionHash,
  fakeAgentPubKey,
  fakeEntryHash
} from '@holochain/client';
import { decode } from '@msgpack/msgpack';

import { createMessage, sampleMessage } from './common.js';

test('create Message', async () => {
  await runScenario(async scenario => {
    // Construct proper paths for your app.
    // This assumes app bundle created by the `hc app pack` command.
    const testAppPath = process.cwd() + '/../workdir/relay.happ';

    // Set up the app to be installed 
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);

    // Shortcut peer discovery through gossip and register all agents in every
    // conductor of the scenario.
    await scenario.shareAllAgents();

    // Alice creates a Message
    const record: Record = await createMessage(alice.cells[0]);
    assert.ok(record);
  });
});

test('create and read Message', async () => {
  await runScenario(async scenario => {
    // Construct proper paths for your app.
    // This assumes app bundle created by the `hc app pack` command.
    const testAppPath = process.cwd() + '/../workdir/relay.happ';

    // Set up the app to be installed 
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);

    // Shortcut peer discovery through gossip and register all agents in every
    // conductor of the scenario.
    await scenario.shareAllAgents();

    const sample = await sampleMessage(alice.cells[0]);

    // Alice creates a Message
    const record: Record = await createMessage(alice.cells[0], sample);
    assert.ok(record);

    // Wait for the created entry to be propagated to the other node.
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    // Bob gets the created Message
    const createReadOutput: Record = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_original_message",
      payload: record.signed_action.hashed.hash,
    });
    assert.deepEqual(sample, decode((createReadOutput.entry as any).Present.entry) as any);

  });
});

test('create and update Message', async () => {
  await runScenario(async scenario => {
    // Construct proper paths for your app.
    // This assumes app bundle created by the `hc app pack` command.
    const testAppPath = process.cwd() + '/../workdir/relay.happ';

    // Set up the app to be installed 
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);

    // Shortcut peer discovery through gossip and register all agents in every
    // conductor of the scenario.
    await scenario.shareAllAgents();

    // Alice creates a Message
    const record: Record = await createMessage(alice.cells[0]);
    assert.ok(record);
        
    const originalActionHash = record.signed_action.hashed.hash;
 
    // Alice updates the Message
    let contentUpdate: any = await sampleMessage(alice.cells[0]);
    let updateInput = {
      original_message_hash: originalActionHash,
      previous_message_hash: originalActionHash,
      updated_message: contentUpdate,
    };

    let updatedRecord: Record = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "update_message",
      payload: updateInput,
    });
    assert.ok(updatedRecord);

    // Wait for the updated entry to be propagated to the other node.
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
        
    // Bob gets the updated Message
    const readUpdatedOutput0: any = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_latest_message",
      payload: { input: updatedRecord.signed_action.hashed.hash, local: true },
    });
    assert.deepEqual(contentUpdate, readUpdatedOutput0.message);

    // Alice updates the Message again
    contentUpdate = await sampleMessage(alice.cells[0]);
    updateInput = { 
      original_message_hash: originalActionHash,
      previous_message_hash: updatedRecord.signed_action.hashed.hash,
      updated_message: contentUpdate,
    };

    updatedRecord = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "update_message",
      payload: updateInput,
    });
    assert.ok(updatedRecord);

    // Wait for the updated entry to be propagated to the other node.
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
        
    // Bob gets the updated Message
    const readUpdatedOutput1: any = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_latest_message",
      payload: { input: updatedRecord.signed_action.hashed.hash, local: true },
    });
    assert.deepEqual(contentUpdate, readUpdatedOutput1.message);

    // Bob gets all the revisions for Message
    const revisions: Record[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_all_revisions_for_message",
      payload: originalActionHash,
    });
    assert.equal(revisions.length, 3);
    assert.deepEqual(contentUpdate, decode((revisions[2].entry as any).Present.entry) as any);
  });
});

test('create and delete Message', async () => {
  await runScenario(async scenario => {
    // Construct proper paths for your app.
    // This assumes app bundle created by the `hc app pack` command.
    const testAppPath = process.cwd() + '/../workdir/relay.happ';

    // Set up the app to be installed 
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);

    // Shortcut peer discovery through gossip and register all agents in every
    // conductor of the scenario.
    await scenario.shareAllAgents();

    const sample = await sampleMessage(alice.cells[0]);

    // Alice creates a Message
    const record: Record = await createMessage(alice.cells[0], sample);
    assert.ok(record);

    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);


    // Alice deletes the Message
    const deleteActionHash = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "delete_message",
      payload: {
        original_message_hash: record.signed_action.hashed.hash,
        agents: [],
      },
    });
    assert.ok(deleteActionHash);

    // Wait for the entry deletion to be propagated to the other node.
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
        
    // Bob gets the oldest delete for the Message
    const oldestDeleteForMessage: SignedActionHashed = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_oldest_delete_for_message",
      payload: record.signed_action.hashed.hash,
    });
    assert.ok(oldestDeleteForMessage);
        
    // Bob gets the deletions for the Message
    const deletesForMessage: SignedActionHashed[] = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_all_deletes_for_message",
      payload: record.signed_action.hashed.hash,
    });
    assert.equal(deletesForMessage.length, 1);


  });
});

function buildSendMessageInput(agents: any[] = []) {
  return {
    message: {
      content: "Hello, world!",
      bucket: 0,
      images: [],
      message_type: "User",
    },
    agents,
  };
}

async function createMessageWithInput(cell: CallableCell, agents: any[] = []): Promise<Record> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "create_message",
    payload: buildSendMessageInput(agents),
  });
}

function recordToMessageRecord(record: Record) {
  return {
    original_action: record.signed_action.hashed.hash,
    signed_action: record.signed_action,
    message: decode((record.entry as any).Present.entry),
  };
}

test('notify_message_delivery returns true when recipient is online', async () => {
  await runScenario(async scenario => {
    const testAppPath = process.cwd() + '/../workdir/relay.happ';
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const record = await createMessageWithInput(alice.cells[0]);
    assert.ok(record);

    const delivered: boolean = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "notify_message_delivery",
      payload: {
        agent: bob.agentPubKey,
        messageRecord: recordToMessageRecord(record),
      },
    });

    assert.equal(delivered, true);
  });
});

test('notify_message_delivery returns false when notifying self', async () => {
  await runScenario(async scenario => {
    const testAppPath = process.cwd() + '/../workdir/relay.happ';
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    const [alice] = await scenario.addPlayersWithApps([appSource]);
    await scenario.shareAllAgents();

    const record = await createMessageWithInput(alice.cells[0]);
    assert.ok(record);

    const delivered: boolean = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "notify_message_delivery",
      payload: {
        agent: alice.agentPubKey,
        messageRecord: recordToMessageRecord(record),
      },
    });

    assert.equal(delivered, false);
  });
});

test('notify_message_delivery returns false when recipient is offline', async () => {
  await runScenario(async scenario => {
    const testAppPath = process.cwd() + '/../workdir/relay.happ';
    const appSource = { appBundleSource: { type: "path", value: testAppPath } };

    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    const record = await createMessageWithInput(alice.cells[0]);
    assert.ok(record);

    await bob.conductor.shutDown();

    const delivered: boolean = await alice.cells[0].callZome({
      zome_name: "relay",
      fn_name: "notify_message_delivery",
      payload: {
        agent: bob.agentPubKey,
        messageRecord: recordToMessageRecord(record),
      },
    }, 240000);

    assert.equal(delivered, false);
  });
}, 300000);
