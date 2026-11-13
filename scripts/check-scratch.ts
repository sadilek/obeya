// Checks that a scratch Obeya stages on this machine as a demo stages one: from a stage file alone,
// without --port or --dir, so that the script picks the port and puts the scratch dir and its port
// claims where this platform keeps them (/tmp on macOS and Linux, the system temp folder on
// Windows, where /tmp would be \tmp on the current drive). Then a card's agent speaks through
// --say, and --stop ends the server. Runs on macOS, Linux and Windows.
//
//   bun scripts/check-scratch.ts
//
// Prints one line per check; exits 1 when one failed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { check, expect, finish, until } from './check-harness';
import { alive, scratchBase, scratchDir } from './common';

const script = join(import.meta.dir, 'scratch-obeya.ts');
const dir = mkdtempSync(join(tmpdir(), 'obeya-check-scratch-'));
const stage = join(dir, 'stage.json');
writeFileSync(stage, JSON.stringify({ cards: [{ key: 'A', title: 'Check the scratch dir', state: 'working' }] }));

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
};

let staged: { url: string; port: number; dir: string; pid: number } | undefined;
const driveTmp = join(parse(process.cwd()).root, 'tmp');

await check('stages without --port or --dir', () => {
  staged = JSON.parse(run(stage));
  return `port ${staged!.port}, ${staged!.dir}${process.platform === 'win32' ? `; ${driveTmp} ${existsSync(driveTmp) ? 'exists' : 'does not exist'}` : ''}`;
});

if (staged) {
  const s = staged;
  await check('the scratch dir lies where this platform keeps it', () => {
    expect(s.dir === scratchDir(s.port), `${s.dir} is not in ${scratchBase()}`);
    if (process.platform === 'win32') expect(s.dir.startsWith(tmpdir()), `${s.dir} is not in the system temp folder ${tmpdir()}`);
    expect(existsSync(join(s.dir, 'staged.json')), 'no staged.json in it');
    // the claim goes once the staging is done
    expect(!existsSync(`${s.dir}.claim`), `${s.dir}.claim is left behind`);
  });
  await check('its page answers', async () => {
    const r = await fetch(s.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    expect(r.status === 200, `status ${r.status}`);
  });
  await check("--say speaks as the card's agent", () => run('--say', String(s.port), 'A', 'say', 'Reading the stage file.').trim());
  await check('--stop ends the server', async () => {
    run('--stop', String(s.port));
    await until('the server ends', 10_000, () => !alive(s.pid));
  });
  rmSync(s.dir, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
finish();
