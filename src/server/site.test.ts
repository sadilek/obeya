import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSite } from '../adapters/types';
import { MESSAGES } from '../core/messages';
import { Board } from './board';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import type { SharePage, ShareTarget } from './share';
import { Sharing } from './share';
import { parseEnv, siteKey, siteMissing, siteTarget, siteVersions } from './site';
import { FakeRuntime, gitRepo, noForge } from './testing';

let dir: string;
let home: string;
let repo: string;
let demo: string;
let target: ShareTarget;

// the deploy line's stand-in, a script in the repository: copies the site's directory to `deployed/`
// (a host's snapshot), records it with the env file's TOKEN, and fails while the file `fail` exists
const DEPLOY = `
const { appendFileSync, cpSync, existsSync, readdirSync, rmSync } = require('node:fs');
const [site, out] = process.argv.slice(2);
appendFileSync(out + '/deploys', readdirSync(site).sort().join(' ') + ' token=' + (process.env.TOKEN ?? '') + '\\n');
console.log('Uploaded ' + readdirSync(site).length + ' entries');
if (existsSync(out + '/fail')) { console.error('upload refused: token expired'); process.exit(3); }
rmSync(out + '/deployed', { recursive: true, force: true });
cpSync(site, out + '/deployed', { recursive: true });
`;

const SITE = (extra: Partial<DemoSite> = {}): DemoSite => ({
  title: 'Team demos',
  url: 'https://demos.example.dev/',
  deploy: ['deploy.ts', '{dir}', '__OUT__'],
  env: 'sites/demos/deploy.env',
  language: 'de',
  ...extra,
});

const make = (site: DemoSite) => siteTarget({ ...site, deploy: site.deploy.map((a) => a.replace('__OUT__', dir)) }, repo, home, MESSAGES.en.share);
const siteDir = () => join(home, 'sites/demos.example.dev/site');
const deployed = () => join(dir, 'deployed');
const deploys = () => readFileSync(join(dir, 'deploys'), 'utf8').trim().split('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-site-'));
  home = join(dir, 'home');
  repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'deploy.ts'), DEPLOY);
  mkdirSync(join(home, 'sites/demos'), { recursive: true });
  writeFileSync(join(home, 'sites/demos/deploy.env'), '# for the host\nexport TOKEN="secret-1"\nOTHER=x\n');
  demo = join(dir, 'demo');
  mkdirSync(demo);
  writeFileSync(join(demo, 'demo.mp4'), 'video');
  writeFileSync(join(demo, 'poster.jpg'), 'poster');
  writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n');
  writeFileSync(join(demo, 'report.html'), 'not for colleagues');
  target = make(SITE());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const page = (slug: string, extra: Partial<SharePage> = {}): SharePage => ({
  slug,
  title: `Titel ${slug}`,
  text: 'Erster Satz <b>roh</b>. Zweiter Satz.',
  kind: 'video',
  chapters: [
    [0, 'Vorher'],
    [12.5, 'Nachher'],
  ],
  pr: null,
  language: 'de',
  dir: demo,
  shared: [],
  ...extra,
});
const meta = (slug: string) => JSON.parse(readFileSync(join(siteDir(), slug, 'meta.json'), 'utf8')) as { at: string; first: string; kind?: string; language?: string };
const overview = () => readFileSync(join(siteDir(), 'index.html'), 'utf8');

describe('a site Obeya keeps', () => {
  test('publishes a page with the video, lists it in the overview, and deploys the whole site with the env file', async () => {
    const r = await target.publish(page('csv-export-abc123', { pr: 'https://github.com/o/r/pull/7' }));
    expect(r).toEqual({ url: 'https://demos.example.dev/csv-export-abc123/', said: 'Uploaded 2 entries' });
    expect(readdirSync(join(siteDir(), 'csv-export-abc123')).sort()).toEqual(['captions.vtt', 'demo.mp4', 'index.html', 'meta.json', 'poster.jpg']);
    const html = readFileSync(join(siteDir(), 'csv-export-abc123/index.html'), 'utf8');
    expect(html).toContain('<h1>Titel csv-export-abc123</h1>');
    expect(html).toContain('Erster Satz &lt;b&gt;roh&lt;/b&gt;.');
    expect(html).toContain('data-at="12.5"');
    expect(html).toContain('<title>Titel csv-export-abc123 · Team demos</title>');
    expect(html).toContain('href="../">Alle Demos');
    expect(html).toMatch(/Geteilt am \d+\. \S+ \d{4}/);
    // a host without byte ranges: the page loads the video whole to seek in it
    expect(html).toContain("Range: 'bytes=0-'");
    expect(html).toContain('href="https://github.com/o/r/pull/7"');
    expect(deploys()).toEqual(['csv-export-abc123 index.html token=secret-1']);
    expect(readFileSync(join(deployed(), 'csv-export-abc123/demo.mp4'), 'utf8')).toBe('video');

    expect('url' in (await target.publish(page('zweite-def456', { shared: ['csv-export-abc123'] })))).toBe(true);
    // the most recently shared first
    expect(overview().indexOf('Titel zweite-def456')).toBeLessThan(overview().indexOf('Titel csv-export-abc123'));
    expect(overview()).toContain('<h1>Team demos</h1>');
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).toBe(overview());
  });

  test("writes each page in its demo's language and the overview in the site's", async () => {
    target = make(SITE({ language: 'en' }));
    await target.publish(page('english-abc123', { language: 'en', title: 'An English one' }));
    await target.publish(page('deutsch-def456', { shared: ['english-abc123'] }));
    const en = readFileSync(join(siteDir(), 'english-abc123/index.html'), 'utf8');
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('href="../">All demos');
    expect(en).toMatch(/Shared on [A-Z][a-z]+ \d+, \d{4}/);
    expect(meta('english-abc123').language).toBe('en');
    const de = readFileSync(join(siteDir(), 'deutsch-def456/index.html'), 'utf8');
    expect(de).toContain('href="../">Alle Demos');
    expect(overview()).toContain('<html lang="en">');
    expect(overview()).toContain('Videos and analyses of changes, the newest first.');
  });

  test('publishes an HTML artifact: its files beside the page, in a sandboxed frame that grows to it', async () => {
    const art = join(dir, 'artifact');
    mkdirSync(join(art, 'data'), { recursive: true });
    writeFileSync(join(art, 'index.html'), '<html><body><h2>Graph</h2><script src="data/chart.js"></script></body></html>');
    writeFileSync(join(art, 'data/chart.js'), 'draw()');
    const artifact = (extra: Partial<SharePage> = {}) => page('auswertung-abc123', { kind: 'html', chapters: [], dir: art, ...extra });
    expect(await target.publish(artifact())).toMatchObject({ url: 'https://demos.example.dev/auswertung-abc123/' });
    const at = join(siteDir(), 'auswertung-abc123');
    expect(readdirSync(at).sort()).toEqual(['artifact', 'index.html', 'meta.json']);
    expect(readFileSync(join(at, 'artifact/data/chart.js'), 'utf8')).toBe('draw()');
    expect(readFileSync(join(at, 'artifact/index.html'), 'utf8')).toContain('obeyaHeight');
    const html = readFileSync(join(at, 'index.html'), 'utf8');
    expect(html).toContain('<iframe src="artifact/index.html" sandbox="allow-scripts');
    expect(html).not.toContain('<video');
    expect(overview()).toContain('Titel auswertung-abc123');
    // published again unchanged it keeps its date; an artifact without its page is refused
    const first = meta('auswertung-abc123');
    expect(first.kind).toBe('html');
    await target.publish(artifact({ pr: 'https://github.com/o/r/pull/3' }));
    expect(meta('auswertung-abc123').at).toBe(first.at);
    // the page Obeya wraps around the artifact is not its content: written by an earlier template, it keeps its date
    writeFileSync(join(at, 'artifact/index.html'), 'written by an earlier template');
    await target.publish(artifact());
    expect(meta('auswertung-abc123').at).toBe(first.at);
    // a changed file of the artifact shares it anew
    writeFileSync(join(art, 'data/chart.js'), 'draw(more)');
    await target.publish(artifact());
    expect(meta('auswertung-abc123').at > first.at).toBe(true);
    rmSync(join(art, 'index.html'));
    expect(await target.publish(artifact())).toMatchObject({ why: `index.html is missing in ${art}.` });
  });

  test('leaves the pages shared earlier as they were written, until they are published again', async () => {
    await target.publish(page('a-111111'));
    writeFileSync(join(siteDir(), 'a-111111/index.html'), 'an earlier template');
    expect('url' in (await target.publish(page('b-222222', { shared: ['a-111111'] })))).toBe(true);
    expect(readFileSync(join(siteDir(), 'a-111111/index.html'), 'utf8')).toBe('an earlier template');
    expect(overview()).toContain('Titel a-111111');
    await target.publish(page('a-111111', { shared: ['b-222222'] }));
    expect(readFileSync(join(siteDir(), 'a-111111/index.html'), 'utf8')).toContain("Range: 'bytes=0-'");
  });

  test('reads pages written by the share command sites were kept with before, as they are', async () => {
    const old = join(siteDir(), 'alt-999999');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'demo.mp4'), 'old video');
    const at = '2026-03-01T10:00:00.000Z';
    writeFileSync(join(old, 'meta.json'), JSON.stringify({ title: 'Alte Demo', text: 'Von früher.', chapters: [], pr: null, first: at, at, source: 'x' }));
    await target.publish(page('neu-111111', { shared: ['alt-999999'] }));
    expect(overview()).toContain('Alte Demo');
    expect(overview()).toContain('1. März 2026');
    expect(existsSync(join(deployed(), 'alt-999999/demo.mp4'))).toBe(true);
  });

  test('a page published again with the same video keeps its date and its place in the overview', async () => {
    await target.publish(page('a-111111'));
    await target.publish(page('b-222222', { shared: ['a-111111'] }));
    const at = meta('a-111111').at;
    await target.publish(page('a-111111', { shared: ['b-222222'], pr: 'https://github.com/o/r/pull/7' }));
    expect(meta('a-111111').at).toBe(at);
    expect(overview().indexOf('Titel b-222222')).toBeLessThan(overview().indexOf('Titel a-111111'));
    // a new video is shared anew
    writeFileSync(join(demo, 'demo.mp4'), 'another video');
    await target.publish(page('a-111111', { shared: ['b-222222'] }));
    expect(meta('a-111111').at > at).toBe(true);
    expect(meta('a-111111').first).toBe(at);
    expect(overview().indexOf('Titel a-111111')).toBeLessThan(overview().indexOf('Titel b-222222'));
  });

  test('withdraws a page; a failed deployment puts the site back as it was', async () => {
    await target.publish(page('a-111111'));
    await target.publish(page('b-222222', { shared: ['a-111111'] }));
    writeFileSync(join(dir, 'fail'), '');
    const failed = await target.withdraw('a-111111', ['b-222222']);
    expect(failed.why).toBe('Not withdrawn: The site’s deploy failed (exit code 3).');
    expect(failed.said).toContain('upload refused: token expired');
    expect(existsSync(join(siteDir(), 'a-111111/demo.mp4'))).toBe(true);
    expect(overview()).toContain('Titel a-111111');
    rmSync(join(dir, 'fail'));
    expect(await target.withdraw('a-111111', ['b-222222'])).toEqual({ said: 'Uploaded 2 entries' });
    expect(existsSync(join(siteDir(), 'a-111111'))).toBe(false);
    expect(overview()).not.toContain('Titel a-111111');
    expect(deploys().at(-1)).toBe('b-222222 index.html token=secret-1');
    expect(readdirSync(deployed()).sort()).toEqual(['b-222222', 'index.html']);
    expect(readdirSync(join(home, 'sites/demos.example.dev/backup'))).toEqual([]);
  });

  test('a failed deployment of a page published again keeps the page it had', async () => {
    await target.publish(page('a-111111'));
    writeFileSync(join(dir, 'fail'), '');
    expect(await target.publish(page('a-111111', { title: 'Neu' }))).toMatchObject({ why: 'The site’s deploy failed (exit code 3).' });
    expect(readFileSync(join(siteDir(), 'a-111111/index.html'), 'utf8')).toContain('Titel a-111111');
    expect(overview()).toContain('Titel a-111111');
  });

  test('refuses a site that lost pages Obeya has as shared, and files larger than the site takes', async () => {
    const lost = await target.publish(page('c-333333', { shared: ['gone-999999'] }));
    expect('why' in lost && lost.why).toContain('lacks a page Obeya has as shared (gone-999999)');
    expect(existsSync(join(dir, 'deploys'))).toBe(false);
    expect(await make(SITE({ maxFile: 4 })).publish(page('c-333333'))).toMatchObject({ why: expect.stringContaining('demo.mp4 is 0.0 MiB; the site takes at most 0 MiB per file') });
    writeFileSync(join(demo, 'demo.mp4'), Buffer.alloc(25 * 1024 * 1024 + 1));
    expect(await target.publish(page('c-333333'))).toMatchObject({ why: 'demo.mp4 is 25.0 MiB; the site takes at most 25 MiB per file.' });
  });

  test('says the env file it lacks on this machine; a site without one deploys with the machine’s own login', async () => {
    rmSync(join(home, 'sites/demos/deploy.env'));
    expect(siteMissing(home, SITE())).toBe('sites/demos/deploy.env');
    expect(await target.publish(page('d-444444'))).toMatchObject({ why: `${join(home, 'sites/demos/deploy.env')} is missing on this machine.` });
    const { env: _, ...without } = SITE();
    expect(siteMissing(home, without)).toBeNull();
    expect(await make(without).publish(page('d-444444'))).toMatchObject({ url: 'https://demos.example.dev/d-444444/' });
    expect(deploys()).toEqual(['d-444444 index.html token=']);
  });

  test('computes the version of the pages it writes, which changes with what shows on them', async () => {
    const v = await target.version();
    expect(v).toEqual({ video: expect.stringMatching(/^[0-9a-f]{12}$/), html: expect.stringMatching(/^[0-9a-f]{12}$/) });
    await target.publish(page('d-555555'));
    expect(await target.version()).toEqual(v);
    expect(siteVersions(SITE({ title: 'Other demos' })).video).not.toBe(v!.video);
  });

  test('a site is named by its URL', () => {
    expect(siteKey('https://demos.example.dev/')).toBe('demos.example.dev');
    expect(siteKey('https://example.com/team/demos')).toBe('example.com-team-demos');
    expect(siteKey('http://localhost:8080')).toBe('localhost-8080');
    expect(parseEnv('# c\nexport A="1"\nB = two words \nC=\'3\'\nnot a line\n')).toEqual({ A: '1', B: 'two words', C: '3' });
  });
});

describe('sharing to a site', () => {
  let board: Board;
  let sharing: Sharing;

  beforeEach(() => {
    board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: repo, branch: 'main' }] }, () => []);
    sharing = new Sharing({
      board,
      runtime: new FakeRuntime(),
      home,
      forge: noForge,
      sourceFor: () => ({ site: { ...SITE(), deploy: ['deploy.ts', '{dir}', dir] }, repo }),
    });
  });

  const card = () => {
    const c = board.create({ title: 'Export als CSV', x: 0, y: 0 });
    board.work(c.id, { state: 'live', demo: JSON.stringify({ kind: 'video', dir: demo, chapters: [[0, 'Vorher']], page: { title: 'CSV-Export', text: 'Ein Satz.' } }) });
    return c.id;
  };
  const settled = async (id: string, state: string | undefined) => {
    for (let i = 0; i < 300 && board.item(id)!.share?.state !== state; i++) await Bun.sleep(10);
    return board.item(id)!.share;
  };

  test('publishes the card’s page there, marks it with the site’s version, and withdraws it', async () => {
    const id = card();
    sharing.share(id);
    const shared = await settled(id, 'shared');
    expect(shared).toMatchObject({ state: 'shared', url: expect.stringMatching(/^https:\/\/demos\.example\.dev\/export-als-csv-[0-9a-z]+\/$/) });
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).toContain('CSV-Export');
    expect(board.events(id).map((e) => e.text)).toContain('Uploaded 2 entries');
    sharing.unshare(id);
    await settled(id, undefined);
    expect(board.item(id)!.share).toBeUndefined();
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).not.toContain('CSV-Export');
  });

  test('without the env file on this machine the card exports instead', async () => {
    rmSync(join(home, 'sites/demos/deploy.env'));
    const id = card();
    expect(() => sharing.share(id)).toThrow('shares none');
    expect((await sharing.export(id, 'zip')).name).toMatch(/\.zip$/);
  });
});

test("a repository whose adapter names a site: the canvas says the env file it lacks, until it is there", () => {
  const shop = gitRepo(join(dir, 'shop'), {
    'docs/plan/plan.md': '# Laden\n\n## Goal\n\nG.\n',
    '.obeya/adapter/index.ts': `export default { name: 'shop', demo: { required: true, howToRun: 'bun dev', site: ${JSON.stringify(SITE())} } };\n`,
  });
  rmSync(join(home, 'sites/demos/deploy.env'));
  const canvas = new CanvasRuntime({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home, runtime: new FakeRuntime(), forge: noForge });
  try {
    expect(canvas.repos[0]!.share).toEqual({ site: SITE() });
    expect(canvas.board.canvas.repos[0]).toMatchObject({ shareNeeds: { site: 'demos.example.dev', file: 'sites/demos/deploy.env' } });
    expect(canvas.board.canvas.repos[0]!.share).toBeUndefined();
    writeFileSync(join(home, 'sites/demos/deploy.env'), 'TOKEN=1\n');
    canvas.ownerBack();
    expect(canvas.board.canvas.repos[0]!.share).toBe(true);
    expect(canvas.board.canvas.repos[0]!.shareNeeds).toBeUndefined();
  } finally {
    canvas.shutdown();
  }
});
