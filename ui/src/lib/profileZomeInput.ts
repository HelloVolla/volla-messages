/**
 * The input the profiles zome's write functions take on the `main-0.7` line.
 *
 * `create_profile` and `update_profile` take `ZomeFnInput<Profile>` —
 * `{ input, local }` — not a bare profile (holochain-open-dev/profiles
 * 7e11bd7). `local` is left unset: it defaults to true, which keeps the
 * nickname path write off the network.
 *
 * Kept free of imports so the zome tests can use this exact function: a test
 * of the shape the app sends, not a copy of it. If the zome's input changes
 * again, `tests/src/relay/relay/profile.test.ts` fails in CI.
 */
export function profileZomeInput<T>(profile: T): { input: T } {
  return { input: profile };
}
