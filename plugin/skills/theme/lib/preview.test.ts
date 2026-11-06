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

/** Runs the preview in a checkout (`repo`, by default `shop`) with these files of `.obeya/`, as a worker runs it, into `out`. */
function preview(files: Record<string, string>, o: { repo?: string; out?: string; args?: string[] } = {}): { code: number; out: string; err: string } {
  const repo = join(dir, o.repo ?? 'shop');
  mkdirSync(join(repo, '.obeya'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, '.obeya', name), text);
  const r = Bun.spawnSync([process.execPath, PREVIEW, o.out ?? join(dir, 'out'), ...(o.args ?? [])], { cwd: repo, env: { ...process.env, DEMO_LANGUAGE: 'en' } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const THEME = { 'theme.css': ':root { --accent: #5b3fd1; }\n' };

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

test('it empties only a directory an earlier preview wrote, and refuses one with other files, the checkout itself too', () => {
  expect(preview(THEME).code).toBe(0);
  // again into the same directory: it is the preview's, and written afresh
  writeFileSync(join(dir, 'out', 'stale.html'), '');
  expect(preview(THEME).code).toBe(0);
  expect(existsSync(join(dir, 'out', 'stale.html'))).toBe(false);
  // a directory with other files stays as it is
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'todo.md'), 'keep\n');
  const other = preview(THEME, { out: join(dir, 'notes') });
  expect(other.code).toBe(1);
  expect(other.err).toContain('holds other files');
  expect(readFileSync(join(dir, 'notes', 'todo.md'), 'utf8')).toBe('keep\n');
  // so does the checkout
  expect(preview(THEME, { out: '.' }).code).toBe(1);
  expect(existsSync(join(dir, 'shop', '.obeya', 'theme.css'))).toBe(true);
});

test("with --video, every version's player has it, the later version's in its own directory too", () => {
  const video = join(dir, 'app.mp4');
  writeFileSync(video, 'mp4');
  expect(preview(THEME, { args: ['--video', video] }).code).toBe(0);
  const page = readFileSync(join(dir, 'out', 'second', 'index.html'), 'utf8');
  expect(page).toContain('src="v2/demo.mp4"');
  for (const version of ['', 'v2']) {
    expect(readFileSync(join(dir, 'out', 'second', version, 'demo.mp4'), 'utf8')).toBe('mp4');
    expect(existsSync(join(dir, 'out', 'second', version, 'captions.vtt'))).toBe(true);
  }
});

test("in a worker's workspace, the overview is named after the repository, not the workspace's directory", () => {
  const repo = join(dir, 'b5cb5da6');
  mkdirSync(repo);
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: repo });
  Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:acme/storefront.git'], { cwd: repo });
  expect(preview(THEME, { repo: 'b5cb5da6' }).code).toBe(0);
  expect(readFileSync(join(dir, 'out', 'index.html'), 'utf8')).toContain('storefront demos');
});
