import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const script = join(import.meta.dir, 'build.ts');
// a target it knows would start a build of minutes: an unknown one shows which it took, at once
const build = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test('takes the targets named, with --out or without, and refuses an unknown one or option before it builds', () => {
  for (const args of [['linux-y64'], ['linux-y64', '--out', 'dist'], ['--out', 'dist', 'linux-y64']]) {
    const r = build(...args);
    expect(r.stderr).toContain('unknown target linux-y64');
    expect(r.status).toBe(1);
  }
  const typo = build('--al');
  expect(typo.stderr).toContain("build: Unknown option '--al'");
  expect(typo.status).toBe(1);
});
