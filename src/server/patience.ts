// Imported by the tests (`testing.ts`) and by `scripts/test.ts`, which runs them: nothing else.

/**
 * How many times as long as elsewhere a test may take on Windows, where starting a process (git,
 * above all) costs ten times as much and more: a virus scanner looks at each. Tests that pass in a
 * second elsewhere took over five there with the other test files running beside them.
 * `OBEYA_TEST_PATIENCE` sets it; `bun run test` gives Bun's timeout by it (`scripts/test.ts`).
 */
export const PATIENCE = Number(process.env.OBEYA_TEST_PATIENCE) || (process.platform === 'win32' ? 5 : 1);
