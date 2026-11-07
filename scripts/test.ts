// The test suite as the checks run it (`bun run test`), a file per process, on macOS, Linux and
// Windows alike:
//
//   bun scripts/test.ts [bun test args…]
//       e.g. `bun scripts/test.ts src/server/workers.test.ts`
//
// `bun test --parallel` starts a process per core. On Windows that overloads the machine: the
// suite is bound by starting processes (git, above all), which costs 50 ms to over a second there
// (the virus scanner looks at each), and the machine starts only so many at a time whatever the
// cores: eleven of the slowest test files took 40 minutes in a process each on a 16-core laptop,
// half their tests timing out, and 14 minutes in 4 processes. So on Windows it is a quarter of the
// cores (at least 2); elsewhere one per core, as Bun picks. A test and its hooks get Bun's 5 s
// times `PATIENCE` (five on Windows), unless the args give a `--timeout` of their own. git runs
// without its automatic maintenance (a git process more after each commit and fetch): set here, in
// the environment the test processes start with, since what a test or the preload sets in
// `process.env` reaches no process they start. The args, the output and the exit code pass through.
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { PATIENCE } from '../src/server/patience';

const args = process.argv.slice(2);
const parallel = process.platform === 'win32' ? `--parallel=${Math.max(2, Math.floor(availableParallelism() / 4))}` : '--parallel';
const timeout = PATIENCE !== 1 && !args.some((a) => a === '--timeout' || a.startsWith('--timeout=')) ? [`--timeout=${5000 * PATIENCE}`] : [];
const env = { ...process.env };
const count = Number(env.GIT_CONFIG_COUNT) || 0;
for (const [i, [key, value]] of [['maintenance.auto', 'false'], ['gc.auto', '0']].entries()) {
  env[`GIT_CONFIG_KEY_${count + i}`] = key;
  env[`GIT_CONFIG_VALUE_${count + i}`] = value;
}
env.GIT_CONFIG_COUNT = String(count + 2);
const r = spawnSync(process.execPath, ['test', parallel, ...timeout, ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
