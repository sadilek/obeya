// Preloaded by `bun test` (bunfig.toml): its hooks run once around all test files.

import { afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oneStartAtATime } from './spawn';
import { removeTemplates } from './testing';

// as the server does: a test's process started next to a slow one does not wait for it (Windows)
oneStartAtATime();

// Whatever the tests put in the temp directory goes into one of this run, removed after the run. A
// run that was killed (Obeya restarting stops its workers' test runs) never got there: the next run
// removes the directories of runs whose process is gone.
const RUN = 'obeya-test-';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
for (const name of readdirSync(tmpdir())) {
  const pid = Number(name.startsWith(RUN) && name.slice(RUN.length).split('-')[0]);
  if (!pid || alive(pid)) continue;
  try {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  } catch {
    // on Windows, a process the run left behind still has a file in it open: a later run removes it
  }
}
const run = mkdtempSync(join(tmpdir(), `${RUN}${process.pid}-`));
// TEMP and TMP are where Windows looks
process.env.TMPDIR = process.env.TEMP = process.env.TMP = run;

// the work retrospective looks for transcripts there: never the machine's own. The live tests need
// the machine's login from there, so they set it back while they run (from `OBEYA_MACHINE_CLAUDE_CONFIG_DIR`).
if (process.env.CLAUDE_CONFIG_DIR) process.env.OBEYA_MACHINE_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const claude = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'obeya-claude-')));

afterAll(() => {
  removeTemplates();
  rmSync(claude, { recursive: true, force: true });
  try {
    rmSync(run, { recursive: true, force: true });
  } catch {
    // a process a test left behind on Windows still has a file in it open: the next run removes it
  }
});
