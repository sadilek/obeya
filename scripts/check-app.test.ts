import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const script = join(import.meta.dir, 'check-app.ts');
const check = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 });

test("takes the program from the arguments, not --screenshot's file, and asks for one that is not there before it checks", () => {
  const program = resolve('no-such-dir', 'obeya');
  for (const args of [['--screenshot', 'out.png', program], [program, '--screenshot', 'out.png', '--keep']]) {
    const r = check(...args);
    expect(r.stderr).toContain(`check-app: no program at ${program}`);
    expect(r.status).toBe(2);
  }
  const without = check('--screenshot', 'out.png');
  expect(without.stderr).toContain('usage: bun scripts/check-app.ts');
  expect(without.status).toBe(2);
});
