# Tests

Backend (zome) tests for the `relay` DNA. They spin up real Holochain
conductors with [Tryorama](https://github.com/holochain/tryorama) and run
under [Vitest](https://vitest.dev/).

## Running

From the repo root:

```sh
npm test
```

That builds the zomes to wasm, packs `workdir/relay.happ`, then runs the suite
here against that happ. You need the nix dev shell for the build step:

```sh
nix develop --command npm test
```

To run a single file while iterating (the happ must already be built):

```sh
npm test -w tests -- src/relay/relay/message.test.ts
```

## Layout

```
src/relay/relay/
  common.ts            helpers: sampleX() builds a payload, createX() calls the zome
  message.test.ts      message create/read/update/delete + delivery
  all-messages.test.ts message links
  config.test.ts       conversation config
```

Tests load the happ from `../workdir/relay.happ`, so it must be packed before
they run (`npm test` does this for you).

## Adding a test

Each test runs inside `runScenario`. The usual shape:

```ts
test("does the thing", async () => {
  await runScenario(async (scenario) => {
    const appSource = {
      appBundleSource: { type: "path", value: process.cwd() + "/../workdir/relay.happ" },
    };

    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();

    // Alice writes
    const record = await createMessage(alice.cells[0]);
    assert.ok(record);

    // Wait for it to reach Bob before reading on his side
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const read = await bob.cells[0].callZome({
      zome_name: "relay",
      fn_name: "get_original_message",
      payload: record.signed_action.hashed.hash,
    });
    assert.ok(read);
  });
});
```

Anything read on a second agent needs a `dhtSync` first, otherwise the entry
may not have gossiped over yet.

## Watch out for

- **Payloads must match the zome structs.** `callZome` sends MessagePack; if a
  field name or shape is off, the zome fails with a `Deserialize` wasm error
  instead of a nice message. Keep the helpers in `common.ts` in sync with the
  Rust structs in `dnas/relay/zomes`. Note the input structs use
  `#[serde(rename_all = "camelCase")]`, so multi-word fields go over the wire as
  e.g. `messageRecord`, not `message_record`.
- **Timeouts are bumped** to 4 minutes in `vitest.config.ts` because conductors
  boot and DHT sync is slow. Don't lower them.
- Tests start fresh conductors every run, so there's no shared state to reset.
