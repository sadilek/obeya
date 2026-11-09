import { afterAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGES } from '../core/messages';
import { MANIFEST, siteKey, siteTarget } from './site';
import { STALL_MS } from './stalls';
import { removeDir } from './testing';

// Sharing a page on a site of some hundred pages holds the server up no longer than a page of its
// own needs: the pages already there are neither read nor checked one by one, the files are read
// and written without blocking (the stalls of 2026-11-02 to -05, 0.5–1.1 s each).

const PAGES = 400;
/**
 * The longest the event loop may go without a turn while a page is shared: short of a stall
 * (stalls.ts). It goes 10–80 ms here, up to 170 ms on a busy CI runner; a share that goes back to
 * reading the site page by page, synchronously, the count of such calls below finds (5258 then, 8 now).
 */
const LONGEST_MS = STALL_MS;

const dir = mkdtempSync(join(tmpdir(), 'obeya-site-stalls-'));
afterAll(async () => {
  server.stop(true);
  await removeDir(dir);
});

// the host: serves what the deploy line copied to `deployed/`, without a synchronous call of its own
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = Bun.file(join(dir, 'deployed', path));
    return !path.includes('..') && (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});

/** What waits for the disk or another process while nothing else runs. */
const BLOCKING = ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'writeFileSync', 'mkdirSync', 'copyFileSync', 'renameSync', 'rmSync', 'openSync', 'readSync'] as const;
const url = `http://localhost:${server.port}/`;

const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

test('sharing a page on a site of some hundred pages keeps the server answering', async () => {
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const site = join(home, 'sites', siteKey(url), 'site');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'deploy.ts'), `require('node:fs').cpSync(process.argv[2], process.argv[3], { recursive: true });`);

  // the pages an earlier Obeya wrote, here and on the live site, each with its files in the manifest
  const pages: Record<string, unknown> = {};
  for (let i = 0; i < PAGES; i++) {
    const slug = `page-${String(i).padStart(4, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString();
    const meta = {
      title: `Page ${i}`,
      text: `What changes on page ${i}, and why it matters to the people using it. `.repeat(6),
      chapters: [
        [0, 'Before'],
        [20, 'After'],
      ],
      pr: null,
      first: at,
      at,
      source: sha(slug),
      language: i % 2 ? 'en' : 'de',
      by: 'Ada Lovelace',
      tags: { Area: ['Billing'], Kind: ['Bug fix'] },
      repo: 'abcdef0123456789',
    };
    const files: Record<string, string> = { 'meta.json': JSON.stringify(meta, null, 2), 'index.html': `<h1>Page ${i}</h1>`.repeat(50), 'demo.mp4': 'video'.repeat(200), 'captions.vtt': 'WEBVTT\n', 'poster.jpg': 'poster' };
    mkdirSync(join(site, slug), { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(site, slug, f), text);
    pages[slug] = { rev: 1, machine: 'b', at, meta, files: Object.fromEntries(Object.entries(files).map(([f, text]) => [f, { size: text.length, hash: sha(text) }])) };
  }
  writeFileSync(join(site, MANIFEST), JSON.stringify({ deploy: 'before', machine: 'b', at: new Date().toISOString(), pages }, null, 1));
  cpSync(site, join(dir, 'deployed'), { recursive: true });

  const demo = join(dir, 'demo');
  mkdirSync(demo);
  writeFileSync(join(demo, 'demo.mp4'), Buffer.alloc(8 * 1024 * 1024, 7));
  writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n');
  const target = siteTarget({ title: 'Team demos', url, deploy: `deploy.ts {dir} ${join(dir, 'deployed')}` }, repo, home, MESSAGES.en.share, { machine: 'a', checkWaits: [0], language: 'en' });
  const share = (slug: string) =>
    target.publish({ slug, title: `Title ${slug}`, text: 'A sentence.', kind: 'video', chapters: [], pr: null, language: 'en', dir: demo, shared: [] });

  // the longest the event loop went without a turn, the way stalls.ts looks for it
  // and the synchronous calls it made meanwhile: on a busy machine each may take milliseconds
  const measure = async (fn: () => Promise<unknown>) => {
    const spies = [...BLOCKING.map((name) => spyOn(fs, name)), spyOn(Bun, 'spawnSync')];
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    try {
      const result = await fn();
      return { result, longest: Math.max(longest, performance.now() - last), blocking: spies.reduce((n, s) => n + s.mock.calls.length, 0) };
    } finally {
      clearInterval(tick);
      for (const s of spies) s.mockRestore();
    }
  };

  // the first share after a start reads every page once, the way it reads files: without blocking;
  // each one after reads its own page alone
  for (const slug of ['first-aaaaaa', 'second-bbbbbb']) {
    const { result, longest, blocking } = await measure(() => share(slug));
    expect(result).toMatchObject({ url: `${url}${slug}/` });
    console.log(`sharing ${slug} on a site of ${PAGES} pages: longest block ${longest.toFixed(0)} ms, ${blocking} synchronous calls`);
    expect(longest).toBeLessThan(LONGEST_MS);
    // what the new page alone needs, not a call for each page on the site
    expect(blocking).toBeLessThan(PAGES / 10);
  }
  // the overview lists every page, the new one first
  const overview = readFileSync(join(site, 'index.html'), 'utf8');
  expect(overview.match(/<li /g)?.length).toBe(PAGES + 2);
  expect(overview.indexOf('Title second-bbbbbb')).toBeLessThan(overview.indexOf('Title first-aaaaaa'));
  expect(overview.indexOf('Title first-aaaaaa')).toBeLessThan(overview.indexOf('Page 399'));
  expect(JSON.parse(readFileSync(join(dir, 'deployed', MANIFEST), 'utf8')).pages['second-bbbbbb'].rev).toBe(1);
}, 60_000);
