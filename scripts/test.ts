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
// cores (at least 2); elsewhere one per core, as Bun picks. The args, the output and the exit code
// pass through.
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const parallel = process.platform === 'win32' ? `--parallel=${Math.max(2, Math.floor(availableParallelism() / 4))}` : '--parallel';
const r = spawnSync(process.execPath, ['test', parallel, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
