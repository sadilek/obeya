import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = join(import.meta.dir, '..', '..', '..');

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'obeya-no-playwright-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Plain Node, as a demo runs, on a copy of the plugin where no Playwright is found up the tree. */
async function node(...args: string[]) {
  const p = Bun.spawn(['node', ...args], { cwd: dir, env: { ...process.env, OBEYA_HOME: join(dir, 'home') }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
}

test('without Playwright, a render lists what is missing and re-voicing gets as far as its usage, instead of failing at import', async () => {
  cpSync(PLUGIN, join(dir, 'plugin'), { recursive: true, filter: (f) => !f.includes('__pycache__') });
  const lib = join(dir, 'plugin', 'skills', 'demo', 'lib');
  mkdirSync(join(dir, 'demo'));
  const demo = join(dir, 'demo', 'demo.ts');
  // relative: an absolute path on Windows (C:\…) is no module specifier for Node
  writeFileSync(demo, `import { runDemo } from '../plugin/skills/demo/lib/director.ts';\nawait runDemo({ title: 'T', baseUrl: 'http://127.0.0.1:9/', scenes: [{ title: 'A', say: 'One.' }] }, import.meta.dirname);\n`);
  const render = await node(demo);
  expect(render.out).not.toContain('ERR_MODULE_NOT_FOUND');
  expect(render.out).toContain('cannot render yet');
  expect(render.out).toMatch(/✗ playwright +not found/);
  expect(render.code).not.toBe(0);
  const revoice = await node(join(lib, 'revoice.ts'));
  expect(revoice.out).toContain('usage: node revoice.ts');
}, 30_000);
