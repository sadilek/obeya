import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-theme-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PREVIEW = join(import.meta.dir, 'preview.ts');

/** Runs the preview in a checkout with these files of `.obeya/`, as a worker runs it. */
function preview(files: Record<string, string>): { code: number; out: string; err: string } {
  const repo = join(dir, 'shop');
  mkdirSync(join(repo, '.obeya'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, '.obeya', name), text);
  const r = Bun.spawnSync([process.execPath, PREVIEW, join(dir, 'out')], { cwd: repo, env: { ...process.env, DEMO_LANGUAGE: 'en' } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("writes sample pages with the checkout's theme as Obeya puts it in, beside the same pages in Obeya's own look", () => {
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  const theme = ":root { --accent: #5b3fd1; }\nmain::before { content: ''; background: url('logo.svg'); }\nbody { background: url('https://tracker.example/x.png'); }\n";
  const { code, out } = preview({ 'theme.css': theme, 'logo.svg': logo });
  expect(code).toBe(0);
  expect(out).toContain('overview:');
  const overview = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
  const page = readFileSync(join(dir, 'out', 'first', 'index.html'), 'utf8');
  for (const html of [overview, page]) {
    expect(html).toContain('--accent: #5b3fd1');
    // the logo in .obeya/ goes in, the address on the internet does not
    expect(html).toContain(`data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}`);
    expect(html).not.toContain('tracker.example');
  }
  expect(overview).toContain('shop demos');
  expect(page).toContain('Invoices export as PDF');
  expect(existsSync(join(dir, 'out', 'second', 'index.html'))).toBe(true);
  const plain = readFileSync(join(dir, 'out', 'without-theme', 'first', 'index.html'), 'utf8');
  expect(plain).not.toContain('#5b3fd1');
});

test('without a theme in the checkout, it says to write one first', () => {
  const { code, err } = preview({});
  expect(code).toBe(1);
  expect(err).toContain('no .obeya/theme.css');
});
