import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSite } from '../adapters/types';
import { MESSAGES } from '../core/messages';
import { Board } from './board';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import type { SharePage, ShareTarget } from './share';
import { Sharing } from './share';
import { MANIFEST, parseEnv, siteKey, siteMissing, siteName, siteTarget, siteVersions } from './site';
import { FakeRuntime, gitRepo, noForge } from './testing';

let dir: string;
let home: string;
let repo: string;
let demo: string;
let target: ShareTarget;

// the deploy line's stand-in, a script in the repository: copies the site's directory to `deployed/`
// (a host's snapshot), records it with the env file's TOKEN, and fails while the file `fail` exists.
// While `lag` exists the host keeps serving the deployment before; each line of `race` is another
// machine's snapshot, deployed right after this one (one per deploy)
const DEPLOY = `
const { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const [site, out] = process.argv.slice(2);
appendFileSync(out + '/deploys', readdirSync(site).sort().join(' ') + ' token=' + (process.env.TOKEN ?? '') + '\\n');
console.log('Uploaded ' + readdirSync(site).length + ' entries');
if (existsSync(out + '/fail')) { console.error('upload refused: token expired'); process.exit(3); }
if (existsSync(out + '/lag')) process.exit(0);
rmSync(out + '/deployed', { recursive: true, force: true });
cpSync(site, out + '/deployed', { recursive: true });
if (existsSync(out + '/race')) {
  const [other, ...rest] = readFileSync(out + '/race', 'utf8').trim().split('\\n');
  if (rest.length) writeFileSync(out + '/race', rest.join('\\n'));
  else rmSync(out + '/race');
  rmSync(out + '/deployed', { recursive: true, force: true });
  cpSync(other, out + '/deployed', { recursive: true });
}
`;

// the host: serves what was deployed last; `down` answers 503, `token` sends a request without it to a login;
// `onManifest` runs before a read of the manifest is answered; `fallback` answers a missing file with the
// root's index.html (as Cloudflare Pages does for a site without a 404.html), `garbled` the manifest with it
const host: { down?: boolean; token?: string; onManifest?: () => void; fallback?: boolean; garbled?: boolean } = {};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (host.down) return new Response('down', { status: 503 });
    if (host.token && req.headers.get('X-Token') !== host.token) return Response.redirect('https://login.example.dev/', 302);
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === `/${MANIFEST}`) host.onManifest?.();
    if (path.endsWith('/')) path += 'index.html';
    const file = join(dir, 'deployed', path);
    const root = join(dir, 'deployed', 'index.html');
    if (host.garbled && path === `/${MANIFEST}`) return new Response(Bun.file(root));
    if (!path.includes('..') && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    return host.fallback && existsSync(root) ? new Response(Bun.file(root)) : new Response('not found', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const URL_ = `http://localhost:${server.port}/`;

const SITE = (extra: Partial<DemoSite> = {}): DemoSite => ({
  title: 'Team demos',
  url: URL_,
  deploy: ['deploy.ts', '{dir}', '__OUT__'],
  env: 'sites/demos/deploy.env',
  language: 'de',
  ...extra,
});

const make = (site: DemoSite, at = home, machine = 'a') =>
  siteTarget({ ...site, deploy: site.deploy.map((a) => a.replace('__OUT__', dir)) }, repo, at, MESSAGES.en.share, { machine, checkWaits: [0, 10, 10] });
const siteDir = (at = home) => join(at, 'sites', siteKey(URL_), 'site');
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
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete host.down;
  delete host.token;
  delete host.onManifest;
  delete host.fallback;
  delete host.garbled;
});

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
const manifest = (at = siteDir()) => JSON.parse(readFileSync(join(at, MANIFEST), 'utf8')) as { deploy: string; pages: Record<string, { rev: number; machine: string; withdrawn?: true }> };
/** A file of a page as an earlier Obeya wrote it: here, on the site, and in both manifests. */
const earlier = (path: string, text: string) => {
  const [slug, file] = path.split(/\/(.*)/) as [string, string];
  for (const at of [siteDir(), deployed()]) {
    writeFileSync(join(at, path), text);
    const m = JSON.parse(readFileSync(join(at, MANIFEST), 'utf8'));
    m.pages[slug].files[file] = { size: text.length, hash: new Bun.CryptoHasher('sha256').update(text).digest('hex') };
    writeFileSync(join(at, MANIFEST), JSON.stringify(m));
  }
};

describe('a site Obeya keeps', () => {
  test('publishes a page with the video, lists it in the overview, and deploys the whole site with the env file', async () => {
    const r = await target.publish(page('csv-export-abc123', { pr: 'https://github.com/o/r/pull/7' }));
    expect(r).toEqual({ url: `${URL_}csv-export-abc123/`, said: 'Uploaded 3 entries', gone: [] });
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
    expect(deploys()).toEqual(['csv-export-abc123 index.html obeya-site.json token=secret-1']);
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
    expect(await target.publish(artifact())).toMatchObject({ url: `${URL_}auswertung-abc123/` });
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
    earlier('auswertung-abc123/artifact/index.html', 'written by an earlier template');
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
    earlier('a-111111/index.html', 'an earlier template');
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
    expect(await target.withdraw('a-111111', ['b-222222'])).toEqual({ said: 'Uploaded 3 entries', gone: [] });
    expect(existsSync(join(siteDir(), 'a-111111'))).toBe(false);
    expect(overview()).not.toContain('Titel a-111111');
    expect(deploys().at(-1)).toBe('b-222222 index.html obeya-site.json token=secret-1');
    expect(readdirSync(deployed()).sort()).toEqual(['b-222222', 'index.html', MANIFEST]);
    expect(readdirSync(join(siteDir(), '../backup'))).toEqual([]);
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
    expect(await make(without).publish(page('d-444444'))).toMatchObject({ url: `${URL_}d-444444/` });
    expect(deploys()).toEqual(['d-444444 index.html obeya-site.json token=']);
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

describe('several machines publishing to one site', () => {
  let other: string;
  let b: ShareTarget;
  beforeEach(() => {
    other = join(dir, 'other');
    mkdirSync(join(other, 'sites/demos'), { recursive: true });
    writeFileSync(join(other, 'sites/demos/deploy.env'), 'TOKEN=secret-2\n');
    b = make(SITE(), other, 'b');
  });
  const live = () => manifest(deployed());
  // a snapshot of what the site shows now, as another machine's deployment that lacks what comes next
  const snapshot = (name: string) => {
    const to = join(dir, name);
    cpSync(deployed(), to, { recursive: true });
    writeFileSync(join(to, MANIFEST), JSON.stringify({ ...manifest(to), deploy: name }));
    return to;
  };
  const lands = (from: string) => {
    rmSync(deployed(), { recursive: true, force: true });
    cpSync(from, deployed(), { recursive: true });
  };

  test('each pulls the pages the other published before it deploys, so neither takes the other’s offline', async () => {
    await target.publish(page('a-111111'));
    const said: string[] = [];
    expect(await b.publish(page('b-222222'), (l) => said.push(l))).toMatchObject({ url: `${URL_}b-222222/` });
    expect(said).toEqual([expect.stringMatching(/^Downloading a page other machines shared from the site \(0\.0 MiB\)/)]);
    expect(readFileSync(join(siteDir(other), 'a-111111/demo.mp4'), 'utf8')).toBe('video');
    expect(readdirSync(deployed()).sort()).toEqual(['a-111111', 'b-222222', 'index.html', MANIFEST]);
    expect(live().pages).toMatchObject({ 'a-111111': { rev: 1, machine: 'a' }, 'b-222222': { rev: 1, machine: 'b' } });
    // the first machine gets the second one's page with its next share, and nothing it has already
    const again: string[] = [];
    await target.publish(page('c-333333'), (l) => again.push(l));
    expect(again).toEqual([expect.stringContaining('Downloading a page')]);
    expect(readdirSync(deployed()).sort()).toEqual(['a-111111', 'b-222222', 'c-333333', 'index.html', MANIFEST]);
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).toContain('Titel b-222222');
    // a page published again comes over with its new revision
    writeFileSync(join(demo, 'demo.mp4'), 'another video');
    await target.publish(page('a-111111'));
    await b.publish(page('b-222222'));
    expect(readFileSync(join(siteDir(other), 'a-111111/demo.mp4'), 'utf8')).toBe('another video');
    expect(live().pages['a-111111']!.rev).toBe(2);
  });

  test('a page withdrawn on one machine stays withdrawn: the other removes it and says so', async () => {
    await target.publish(page('a-111111'));
    await b.publish(page('b-222222'));
    expect(await target.withdraw('a-111111', [])).toMatchObject({ gone: [] });
    expect(live().pages['a-111111']).toMatchObject({ withdrawn: true, rev: 2, machine: 'a' });
    // the other machine still has its files: they do not come back, and its card would lose its link
    expect(existsSync(join(siteDir(other), 'a-111111'))).toBe(true);
    expect(await b.audit!(['a-111111'])).toEqual({ gone: [{ slug: 'a-111111', machine: 'a' }], missing: [] });
    expect(await b.publish(page('b-222222', { shared: ['a-111111'] }))).toMatchObject({ url: `${URL_}b-222222/`, gone: [{ slug: 'a-111111', machine: 'a' }] });
    expect(existsSync(join(siteDir(other), 'a-111111'))).toBe(false);
    expect(readdirSync(deployed()).sort()).toEqual(['b-222222', 'index.html', MANIFEST]);
    expect(live().pages['a-111111']).toMatchObject({ withdrawn: true });
    expect(await b.audit!([])).toEqual({ gone: [], missing: [] });
    // shared again, it is back for both
    await target.publish(page('a-111111', { shared: [] }));
    expect(live().pages['a-111111']).toMatchObject({ rev: 3, machine: 'a' });
    await b.publish(page('b-222222'));
    expect(existsSync(join(siteDir(other), 'a-111111/demo.mp4'))).toBe(true);
  });

  test('refuses to deploy when the manifest cannot be read; a site with nothing there yet is the first deploy', async () => {
    host.down = true;
    expect(await target.publish(page('a-111111'))).toMatchObject({ why: `The site’s manifest could not be read (${URL_}${MANIFEST}: HTTP 503). Without it a deploy might take pages other machines shared offline.` });
    expect(existsSync(join(dir, 'deploys'))).toBe(false);
    expect(existsSync(join(siteDir(), 'a-111111'))).toBe(false);
    delete host.down;
    // behind a login: read with the site's headers, their values from the env file
    host.token = 'secret-1';
    expect(await target.publish(page('a-111111'))).toMatchObject({ why: expect.stringContaining('HTTP 302, a redirect to a login') });
    expect(await make(SITE({ headers: { 'X-Token': '${NOPE}' } })).publish(page('a-111111'))).toMatchObject({ why: 'The site’s header X-Token needs NOPE, which the site’s env file lacks.' });
    const behind = make(SITE({ headers: { 'X-Token': '${TOKEN}' } }));
    expect(await behind.publish(page('a-111111'))).toMatchObject({ url: `${URL_}a-111111/` });
    expect(await behind.withdraw('a-111111', [])).toMatchObject({ said: 'Uploaded 2 entries' });
    expect(live().pages['a-111111']).toMatchObject({ withdrawn: true });
  });

  test('a site deployed before it had a manifest deploys only from a machine that has the pages it shows', async () => {
    mkdirSync(deployed(), { recursive: true });
    writeFileSync(join(deployed(), 'index.html'), '<ul><li><a href="alt-999999/">Alte Demo</a></li></ul>');
    expect(await b.publish(page('b-222222'))).toMatchObject({ why: expect.stringContaining('the site shows a page this machine lacks (alt-999999) and has no manifest yet') });
    const old = join(siteDir(), 'alt-999999');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'demo.mp4'), 'old video');
    writeFileSync(join(old, 'meta.json'), JSON.stringify({ title: 'Alte Demo', text: 'Von früher.', chapters: [], pr: null, first: '2026-03-01T10:00:00.000Z', at: '2026-03-01T10:00:00.000Z', source: 'x' }));
    expect(await target.publish(page('a-111111'))).toMatchObject({ url: `${URL_}a-111111/` });
    expect(live().pages['alt-999999']).toMatchObject({ rev: 1, machine: 'a', files: { 'demo.mp4': { size: 9 } } });
    expect(await b.publish(page('b-222222'))).toMatchObject({ url: `${URL_}b-222222/` });
    expect(readFileSync(join(siteDir(other), 'alt-999999/demo.mp4'), 'utf8')).toBe('old video');
  });

  test('a host that answers a missing file with its overview: a site without a manifest yet, not an unreadable one', async () => {
    host.fallback = true;
    mkdirSync(deployed(), { recursive: true });
    writeFileSync(join(deployed(), 'index.html'), '<ul><li><a href="alt-999999/">Alte Demo</a></li></ul>');
    expect(await target.publish(page('a-111111'))).toMatchObject({ why: expect.stringContaining('the site shows a page this machine lacks (alt-999999) and has no manifest yet') });
    writeFileSync(join(deployed(), 'index.html'), '<ul></ul>');
    expect(await target.publish(page('a-111111'))).toMatchObject({ url: `${URL_}a-111111/` });
    expect(live().pages['a-111111']).toMatchObject({ rev: 1, machine: 'a' });
    expect(await b.publish(page('b-222222'))).toMatchObject({ url: `${URL_}b-222222/` });
    // a manifest answered with something else than the missing files get is still refused
    host.fallback = false;
    host.garbled = true;
    expect(await target.publish(page('c-333333'))).toMatchObject({ why: `The site’s manifest could not be read (${URL_}${MANIFEST}: not a manifest). Without it a deploy might take pages other machines shared offline.` });
  });

  test('another machine’s deploy coming in between: one more round, and a failure after the second', async () => {
    await target.publish(page('a-111111'));
    await b.publish(page('b-222222'));
    writeFileSync(join(dir, 'race'), snapshot('other-1'));
    const said: string[] = [];
    const r = await target.publish(page('c-333333', { shared: ['a-111111'] }), (l) => said.push(l));
    expect(r).toMatchObject({ url: `${URL_}c-333333/` });
    expect(said).toContain('Another machine’s deploy came in between; one more round.');
    expect(readdirSync(deployed()).sort()).toEqual(['a-111111', 'b-222222', 'c-333333', 'index.html', MANIFEST]);

    writeFileSync(join(dir, 'race'), `${snapshot('other-2')}\n${snapshot('other-3')}`);
    expect(await target.publish(page('d-444444', { shared: ['a-111111', 'c-333333'] }))).toMatchObject({
      why: 'Another machine’s deploy came in between twice; the site does not show the change. Please try again.',
    });
    // undone here, as it is on the site
    expect(existsSync(join(siteDir(), 'd-444444'))).toBe(false);
    expect(manifest().pages['d-444444']).toBeUndefined();
    expect(overview()).not.toContain('Titel d-444444');
  });

  test('another machine’s deploy landing between the pull and the deploy: pulled again before deploying', async () => {
    await target.publish(page('a-111111'));
    await b.publish(page('b-222222'));
    const before = snapshot('before');
    await b.publish(page('b2-222222'));
    const theirs = snapshot('theirs');
    lands(before);
    // this machine pulls the site without b2; the other machine's deployment with it lands right after
    let reads = 0;
    host.onManifest = () => {
      if (++reads === 1) lands(theirs);
    };
    const deploysBefore = deploys().length;
    expect(await target.publish(page('c-333333'))).toMatchObject({ url: `${URL_}c-333333/` });
    expect(deploys().length).toBe(deploysBefore + 1);
    expect(readdirSync(deployed()).sort()).toEqual(['a-111111', 'b-222222', 'b2-222222', 'c-333333', 'index.html', MANIFEST]);
  });

  test('a page another machine’s late deploy took offline is found missing and deployed again', async () => {
    await target.publish(page('a-111111'));
    const pulled = snapshot('pulled');
    await target.publish(page('c-333333', { shared: ['a-111111'] }));
    // the other machine pulled before c and deployed after this machine had checked
    lands(pulled);
    expect(await target.audit!(['a-111111', 'c-333333'])).toEqual({ gone: [], missing: ['c-333333'] });
    expect(await target.repair!(['a-111111', 'c-333333'])).toMatchObject({ said: 'Uploaded 4 entries', gone: [] });
    expect(readdirSync(deployed()).sort()).toEqual(['a-111111', 'c-333333', 'index.html', MANIFEST]);
    expect(await target.audit!(['a-111111', 'c-333333'])).toEqual({ gone: [], missing: [] });
  });

  test('a deployment the site does not show yet counts, with a line saying so', async () => {
    await target.publish(page('a-111111'));
    writeFileSync(join(dir, 'lag'), '');
    expect(await target.publish(page('b-222222', { shared: ['a-111111'] }))).toMatchObject({
      url: `${URL_}b-222222/`,
      said: 'Uploaded 4 entries\nThe site does not show the new state yet; the next deploy checks again.',
    });
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
    expect(shared).toMatchObject({ state: 'shared', url: expect.stringMatching(new RegExp(`^${URL_}export-als-csv-[0-9a-z]+/$`)) });
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).toContain('CSV-Export');
    expect(board.events(id).map((e) => e.text)).toContain('Uploaded 3 entries');
    sharing.unshare(id);
    await settled(id, undefined);
    expect(board.item(id)!.share).toBeUndefined();
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).not.toContain('CSV-Export');
  });

  test('a page another machine withdrew: its card here loses its link, with the next share or when the owner comes back', async () => {
    const other = join(dir, 'other');
    mkdirSync(join(other, 'sites/demos'), { recursive: true });
    writeFileSync(join(other, 'sites/demos/deploy.env'), 'TOKEN=secret-2\n');
    const elsewhere = make(SITE(), other, 'laptop');
    const slugOf = (id: string) => board.item(id)!.share!.url!.split('/').at(-2)!;
    const [one, two, three] = [card(), card(), card()];
    for (const id of [one, two]) {
      sharing.share(id);
      await settled(id, 'shared');
    }
    await elsewhere.withdraw(slugOf(one), []);
    await sharing.checkVersions();
    expect(board.item(one)!.share).toBeUndefined();
    expect(board.events(one).map((e) => e.text)).toContain('Die Seite wurde auf einem anderen Rechner (laptop) zurückgezogen; der Link ist weg.');
    await elsewhere.withdraw(slugOf(two), []);
    sharing.share(three);
    await settled(three, 'shared');
    expect(board.item(two)!.share).toBeUndefined();
    expect(board.events(two).map((e) => e.text)).toContain('Die Seite wurde auf einem anderen Rechner (laptop) zurückgezogen; der Link ist weg.');
    expect(readdirSync(deployed()).sort()).toEqual([slugOf(three), 'index.html', MANIFEST]);
  });

  test('a page another machine’s deploy took offline: deployed again when the owner comes back, with a line on its card', async () => {
    const [one, two] = [card(), card()];
    for (const id of [one, two]) {
      sharing.share(id);
      await settled(id, 'shared');
    }
    const slug = board.item(two)!.share!.url!.split('/').at(-2)!;
    // another machine's deployment that pulled before the second page went out
    const m = manifest(deployed());
    delete m.pages[slug];
    rmSync(join(deployed(), slug), { recursive: true });
    writeFileSync(join(deployed(), MANIFEST), JSON.stringify({ ...m, deploy: 'theirs' }));
    await sharing.checkVersions();
    expect(board.events(two).map((e) => e.text)).toContain('Die Seite fehlte auf der Site: Der Deploy eines anderen Rechners hatte sie offline genommen. Obeya hat sie wieder deployt.');
    expect(board.events(one).map((e) => e.text)).not.toContain('Die Seite fehlte auf der Site: Der Deploy eines anderen Rechners hatte sie offline genommen. Obeya hat sie wieder deployt.');
    expect(existsSync(join(deployed(), slug, 'demo.mp4'))).toBe(true);
    expect(board.item(two)!.share).toMatchObject({ state: 'shared' });
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
    expect(canvas.board.canvas.repos[0]).toMatchObject({ shareNeeds: { site: siteName(SITE()), file: 'sites/demos/deploy.env' } });
    expect(canvas.board.canvas.repos[0]!.share).toBeUndefined();
    writeFileSync(join(home, 'sites/demos/deploy.env'), 'TOKEN=1\n');
    canvas.ownerBack();
    expect(canvas.board.canvas.repos[0]!.share).toBe(true);
    expect(canvas.board.canvas.repos[0]!.shareNeeds).toBeUndefined();
  } finally {
    canvas.shutdown();
  }
});
