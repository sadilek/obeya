import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSite } from '../adapters/types';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { EXPORT_HTML_MAX } from '../core/types';
import type { Forge } from './forge';
import { demoPageHtml } from './demo-page';
import { DEMO_MARKER, SHARE_CWD, Sharing, withDemoLink } from './share';
import { siteKey } from './site';
import { missedChanges, PAGE_CHANGES, pagesVersion } from '../core/page-changes';
import type { Theme } from './theme';
import { FakeRuntime, gitRepo, noContributions } from './testing';
import { git } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let sharing: Sharing;
/** The descriptions of the fake forge's pull requests, and each edit Obeya made. */
let bodies: Map<string, string>;
let edits: string[];
/** What the workers heard of each page that went out, or did not. */
let settled: [string, ({ url: string } | { why: string })?][];

/** A page in the site's manifest, as far as the tests look at it. */
interface Entry {
  rev: number;
  withdrawn?: true;
  meta?: { kind?: 'html'; title: string; text: string; chapters: [number, string][]; pr: string | null; language: string; tags?: Record<string, string[]> };
}
/**
 * Each deploy of the site: the pages of its manifest, those it changed (`wrote`), and where it
 * ran. Only whole lines: the one without its newline yet is still being written.
 */
const calls = () => {
  if (!existsSync(join(dir, 'calls'))) return [];
  const all = readFileSync(join(dir, 'calls'), 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((l) => JSON.parse(l) as { pages: Record<string, Entry>; home: string; cwd: string; repo: string });
  return all.map((c, i) => ({ ...c, wrote: Object.keys(c.pages).filter((slug) => c.pages[slug]!.rev !== all[i - 1]?.pages[slug]?.rev) }));
};

// the deploy line's stand-in: records the site's manifest, then copies the site's directory to
// `deployed/` (the host's snapshot), or fails with some output while the file `fail` exists. While
// the file `hold` exists, a deploy waits after it is recorded. Like `wrangler pages deploy`, it
// leaves its cache in its working directory.
const DEPLOY = `
const { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const [site, out] = process.argv.slice(2);
mkdirSync('.wrangler/cache', { recursive: true });
writeFileSync('.wrangler/cache/pages.json', '{}');
const { pages } = JSON.parse(readFileSync(site + '/obeya-site.json', 'utf8'));
appendFileSync(out + '/calls', JSON.stringify({ pages, home: process.env.OBEYA_HOME, cwd: process.cwd(), repo: process.env.OBEYA_REPO }) + '\\n');
while (existsSync(out + '/hold')) await Bun.sleep(10);
if (existsSync(out + '/fail')) { console.error('upload refused: token expired'); process.exit(2); }
console.error('Uploading 3 files');
rmSync(out + '/deployed', { recursive: true, force: true });
cpSync(site, out + '/deployed', { recursive: true });
`;

// the host: serves what was deployed last
const server = Bun.serve({
  port: 0,
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(dir, 'deployed', path);
    return !path.includes('..') && existsSync(file) && statSync(file).isFile() ? new Response(Bun.file(file)) : new Response('not found', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const SITE_URL = `http://localhost:${server.port}/`;
/** When the site's demos go out: on approval (`approved`), or only on "Teilen". */
let publish: DemoSite['publish'];
/** The site's vocabulary of tags (`demo.site.tags`); none without. */
let vocabulary: DemoSite['tags'];
/** The repository's theme (`.obeya/theme.css`); none without. */
let theme: Theme | null;
const site = (): DemoSite => ({ title: 'Demos', url: SITE_URL, deploy: `${join(dir, 'deploy.ts')} {dir} ${dir}`, ...(publish ? { publish } : {}), ...(vocabulary ? { tags: vocabulary } : {}) });

beforeEach(() => {
  publish = undefined;
  vocabulary = undefined;
  theme = null;
  dir = mkdtempSync(join(tmpdir(), 'obeya-share-'));
  writeFileSync(join(dir, 'deploy.ts'), DEPLOY);
  board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: dir, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  runtime = new FakeRuntime();
  bodies = new Map();
  edits = [];
  comments = [];
  settled = [];
  sharing = make();
  board.showVocabulary(() => vocabulary);
  board.showThemes(() => theme?.hash ?? null);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make(repo = dir) {
  return new Sharing({
    board,
    runtime,
    home: join(dir, 'home'),
    forge,
    // a repository with a theme and without a site still has its theme for the export
    sourceFor: (card) => (card.title.startsWith('Ohne') ? (theme ? { site: null, repo, theme } : null) : { site: site(), repo, ...(theme ? { theme } : {}) }),
    // the repository names English for its demos (`demo.language`) on cards so titled
    languageFor: (card) => (card.title.startsWith('In English') ? 'en' : undefined),
    onPage: (id, r) => void settled.push([id, r]),
  });
}

/** Comments Obeya wrote on pull requests: the URL, then the comment. */
let comments: string[] = [];

const forge: Forge = {
  ...noContributions,
  comment: async (_cwd, url, body) => `${url}#issuecomment-${comments.push(`${url} ${body}`)}`,
  open: async () => '',
  status: async () => ({}) as never,
  body: async (_cwd, url) => {
    const b = bodies.get(url);
    if (b === undefined) throw new Error(`gh pr view: no pull request ${url}`);
    return b;
  },
  setBody: async (_cwd, url, body) => {
    bodies.set(url, body);
    edits.push(url);
  },
  merge: async () => {},
};

const PR = 'https://github.com/acme/app/pull/42';
/** The worker opened the card's pull request, with a description of its own. */
function openPr(id: string, body = 'Exportiert Zählerstände.') {
  bodies.set(PR, body);
  board.work(id, { pr: JSON.stringify({ url: PR, number: 42, seen: [], reported: [] }) });
}

/** A card with a video demo, as a worker hands it over: its report page says the narration language. */
function card(title = 'Zählerstände exportieren', demo: Record<string, unknown> = {}, language: string | null = 'de') {
  const c = board.create({ title, x: 0, y: 0 });
  const d = join(dir, `demo-${c.id}`);
  if (demo.kind !== 'html') videoDir(d);
  else mkdirSync(d);
  if (demo.kind !== 'html' && language) writeFileSync(join(d, 'index.html'), `<!doctype html>\n<html lang="${language}">\n<head><title>Bericht</title></head></html>`);
  board.work(c.id, {
    state: 'live',
    demo: JSON.stringify({ kind: 'video', dir: d, chapters: [[0, 'Vorher']], page: { title: 'CSV-Export', text: 'Vermieter laden Zählerstände als CSV.' }, ...demo }),
  });
  return board.item(c.id)!;
}

/** A video demo's directory: the video and its captions. */
function videoDir(d: string) {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'demo.mp4'), 'video');
  writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n');
  return d;
}

const share = (id: string) => board.item(id)!.share;
/** The card's page on the site, by its slug. */
const slug = (id: string) => (JSON.parse(board.row(id).share!) as { slug: string }).slug;
/** What the latest deploy said of the card's page. */
const meta = (id: string) => calls().at(-1)!.pages[slug(id)]!.meta!;
async function until(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
}
const log = (id: string) => board.events(id).map((e) => e.text);

describe('sharing a demo', () => {
  test('publishes the page on the site right away, keeps its link, and withdraws it', async () => {
    const c = card();
    sharing.share(c.id);
    expect(share(c.id)).toEqual({ state: 'publishing' });
    expect(log(c.id).at(-1)).toBe('Teilen: Die Seite geht online.');
    await until(() => share(c.id)?.state === 'shared');
    const slug = 'zahlerstande-exportieren-' + c.id.slice(0, 6);
    expect(share(c.id)).toEqual({ state: 'shared', url: `${SITE_URL}${slug}/` });
    const [call] = calls();
    expect(call!.wrote).toEqual([slug]);
    expect(call!.pages[slug]!.meta).toMatchObject({ title: 'CSV-Export', text: 'Vermieter laden Zählerstände als CSV.', chapters: [[0, 'Vorher']], pr: null, language: 'de' });
    expect(readFileSync(join(dir, 'deployed', slug, 'demo.mp4'), 'utf8')).toBe('video');
    // the deploy runs under Obeya's home, and learns the checkout from the environment
    expect(call!.home).toBe(join(dir, 'home'));
    expect(call!.cwd).toBe(realpathSync(join(dir, 'home', SHARE_CWD)));
    expect(call!.repo).toBe(dir);
    // the deploy's output goes into the card's log
    expect(log(c.id)).toContain('Uploading 3 files');
    expect(log(c.id).at(-1)).toBe(`Geteilt: ${SITE_URL}${slug}/`);

    sharing.unshare(c.id);
    expect(share(c.id)!.state).toBe('withdrawing');
    await until(() => !share(c.id));
    expect(calls().at(-1)!.pages[slug]!.withdrawn).toBe(true);
    expect(existsSync(join(dir, 'deployed', slug))).toBe(false);
    expect(log(c.id).at(-1)).toBe('Die Seite ist zurückgezogen.');
    // shared again, under the same link
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.url).toBe(`${SITE_URL}${slug}/`);
  });

  test('a deploy that leaves files in its working directory leaves the checkout clean, so its workspace can still be leased', async () => {
    const repo = gitRepo(join(dir, 'checkout'));
    sharing = make(repo);
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    sharing.unshare(c.id);
    await until(() => !share(c.id));
    expect(calls().map((c) => c.repo)).toEqual([repo, repo]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(dir, 'home', SHARE_CWD, '.wrangler/cache/pages.json'))).toBe(true);
  });

  test('a newer demo is not shared on its own: the card says so, and "Neu teilen" replaces the page', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    const newer = videoDir(join(dir, 'newer'));
    writeFileSync(join(newer, 'demo.mp4'), 'newer video');
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [], page: { title: 'CSV-Export 2', text: 'T.' } }) });
    expect(share(c.id)).toMatchObject({ state: 'shared', stale: true });
    expect(calls()).toHaveLength(1);
    sharing.share(c.id);
    // the page stays up with its link while the new one is published
    expect(share(c.id)).toMatchObject({ state: 'publishing', url: expect.stringContaining(SITE_URL) });
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.stale).toBeUndefined();
    expect(calls().at(-1)!.wrote).toEqual([slug(c.id)]);
    expect(meta(c.id).title).toBe('CSV-Export 2');
    expect(readFileSync(join(dir, 'deployed', slug(c.id), 'demo.mp4'), 'utf8')).toBe('newer video');
  });

  test('a failed deploy leaves the card as it was, with the output in its log', async () => {
    const c = card();
    writeFileSync(join(dir, 'fail'), '');
    sharing.share(c.id);
    await until(() => !share(c.id));
    const err = board.events(c.id).at(-1)!;
    expect(err.kind).toBe('error');
    expect(err.text).toContain('Exit-Code 2');
    expect(err.text).toContain('token expired');
    // shared, then a failed withdrawal: the page stays shared
    rmSync(join(dir, 'fail'));
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    writeFileSync(join(dir, 'fail'), '');
    sharing.unshare(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(board.events(c.id).at(-1)!.text).toContain('Nicht zurückgezogen');
  });

  test('a site that lost a page shared from here is not deployed, so the page does not go offline', async () => {
    const a = card('A');
    sharing.share(a.id);
    await until(() => share(a.id)?.state === 'shared');
    // the site's directory on this machine and the host both lost it
    rmSync(join(dir, 'home', 'sites'), { recursive: true });
    rmSync(join(dir, 'deployed'), { recursive: true });
    const b = card('B');
    sharing.share(b.id);
    await until(() => !share(b.id));
    expect(log(b.id).at(-1)).toContain(`(${slug(a.id)})`);
    expect(calls()).toHaveLength(1);
  });

  test('an HTML artifact goes out as a page too, and the pull request names it as a page', async () => {
    const c = card('Auswertung', { kind: 'html', chapters: [], page: { title: 'Verlust und Zapfung', text: 'Geschätzt aus den Messdaten.' } });
    writeFileSync(join(dir, `demo-${c.id}`, 'index.html'), '<!doctype html><body>Chart</body>');
    openPr(c.id);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id)).toMatchObject({ kind: 'html', title: 'Verlust und Zapfung', chapters: [], pr: PR });
    expect(readFileSync(join(dir, 'deployed', slug(c.id), 'artifact', 'index.html'), 'utf8')).toContain('Chart');
    expect(bodies.get(PR)).toContain(`Demo-Seite: ${share(c.id)!.url} ${DEMO_MARKER}`);
  });

  test("writes the page in the demo's language: its report page's, else the repository's, else the demo settings'", async () => {
    const en = card('English', {}, 'en');
    sharing.share(en.id);
    await until(() => share(en.id)?.state === 'shared');
    expect(meta(en.id).language).toBe('en');
    // an artifact names its own; a demo without a page that names one takes the settings' narration language
    const artifact = card('Artifact', { kind: 'html', chapters: [], page: { title: 'Loss', text: 'From the readings.' } });
    writeFileSync(join(dir, `demo-${artifact.id}`, 'index.html'), '<html lang="en-GB"><body>Chart</body></html>');
    sharing.share(artifact.id);
    await until(() => share(artifact.id)?.state === 'shared');
    expect(meta(artifact.id).language).toBe('en');
    mkdirSync(join(dir, 'home'), { recursive: true });
    for (const language of ['en', 'de'] as const) {
      writeFileSync(join(dir, 'home', 'demo.json'), JSON.stringify({ language }));
      const c = card(`Without ${language}`, {}, null);
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
      expect(meta(c.id).language).toBe(language);
    }
    const c = card('In English, without a page that says so', {}, null);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id).language).toBe('en');
  });

  test('only where the repository shares, never twice at once', () => {
    const none = card('Ohne Teilen');
    expect(() => sharing.share(none.id)).toThrow(BadRequest);
    const c = card();
    sharing.share(c.id);
    expect(() => sharing.share(c.id)).toThrow(BadRequest);
    expect(() => sharing.unshare(card('X').id)).toThrow(BadRequest);
  });

  test('a demo handed over without its page gets its text from a short session over the summary', async () => {
    const c = card('Zähler', { page: undefined });
    board.log(c.id, 'review', 'worker', 'Export gebaut: CSV mit Semikolon.');
    sharing.share(c.id);
    await until(() => runtime.sessions.length === 1);
    const s = runtime.last;
    expect(s.spec.readOnly).toBe(true);
    expect(s.inbox[0]).toContain('Export gebaut: CSV mit Semikolon.');
    s.call('page', { title: 'Zählerstände als CSV', text: 'Vermieter laden Zählerstände als CSV herunter.' });
    s.emit({ type: 'idle' });
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id)).toMatchObject({ title: 'Zählerstände als CSV', text: 'Vermieter laden Zählerstände als CSV herunter.' });
    // kept with the demo: the next share needs no session
    expect(board.item(c.id)!.demo!.page).toEqual({ title: 'Zählerstände als CSV', text: 'Vermieter laden Zählerstände als CSV herunter.' });
  });

  test('after a restart, a share under way goes on', async () => {
    const a = card('A');
    board.work(a.id, { share: JSON.stringify({ slug: 'a', state: 'publishing' }) });
    sharing.resume();
    await until(() => share(a.id)?.state === 'shared');
    expect(calls().map((c) => c.wrote)).toEqual([['a']]);
  });
});

describe('the tags of a page', () => {
  beforeEach(() => {
    vocabulary = { Area: ['Billing', 'Reports', 'Settings'], Audience: ['Admins', 'Customers'] };
  });
  /** The card's page is online and nothing goes out for it. */
  const still = (id: string) => share(id)?.state === 'shared' && !JSON.parse(board.row(id).share!).state;
  /** A card whose worker gave its page these tags. */
  const tagged = (tags: Record<string, string[]>, title = 'Zählerstände exportieren') => card(title, { page: { title: 'CSV-Export', text: 'Vermieter laden Zählerstände als CSV.', tags } });

  test("the worker's go on the page, in the vocabulary's order, and the card shows them", async () => {
    const c = tagged({ Area: ['Reports', 'Billing'], Audience: [] });
    expect(board.item(c.id)!.tags).toEqual({ Area: ['Reports', 'Billing'], Audience: [] });
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(runtime.sessions).toHaveLength(0);
    expect(meta(c.id).tags).toEqual({ Area: ['Billing', 'Reports'], Audience: [] });
  });

  test('a page lacking them gets them from a short session over its title and text, for the dimensions it lacks only', async () => {
    const c = tagged({ Area: ['Billing'] });
    sharing.share(c.id);
    await until(() => runtime.sessions.length === 1);
    const s = runtime.last;
    expect(s.spec.readOnly).toBe(true);
    expect(s.inbox[0]).toContain('- Audience: Admins, Customers');
    expect(s.inbox[0]).not.toContain('- Area:');
    expect(s.inbox[0]).toContain('“CSV-Export”\nVermieter laden Zählerstände als CSV.');
    // what it gives outside the vocabulary, or for a dimension it was not asked about, does not count
    s.call('tags', { tags: { Audience: ['Customers', 'Tenants'], Area: ['Settings'] } });
    s.emit({ type: 'idle' });
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id).tags).toEqual({ Area: ['Billing'], Audience: ['Customers'] });
    expect(log(c.id)).toContain('Tags gewählt: Audience: Customers');
    // kept: the next share needs no session
    sharing.unshare(c.id);
    await until(() => !share(c.id));
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(runtime.sessions).toHaveLength(1);
    expect(meta(c.id).tags).toEqual({ Area: ['Billing'], Audience: ['Customers'] });
  });

  test('a page written for a demo without one chooses its tags in the same session', async () => {
    const c = card('Zähler', { page: undefined });
    sharing.share(c.id);
    await until(() => runtime.sessions.length === 1);
    runtime.last.call('page', { title: 'Zählerstände als CSV', text: 'Vermieter laden sie herunter.', tags: { Area: ['Reports'], Audience: ['Customers'] } });
    runtime.last.emit({ type: 'idle' });
    await until(() => share(c.id)?.state === 'shared');
    expect(runtime.sessions).toHaveLength(1);
    expect(meta(c.id).tags).toEqual({ Area: ['Reports'], Audience: ['Customers'] });
  });

  test('set by hand, they take effect at once and stay: a later worker sets only the others, the session none', async () => {
    const c = tagged({ Area: ['Billing'], Audience: ['Admins'] });
    // before sharing: kept for the page
    sharing.setTags(c.id, 'Area', ['Reports']);
    expect(board.item(c.id)!.tags).toEqual({ Area: ['Reports'], Audience: ['Admins'] });
    expect(log(c.id).at(-1)).toBe('Tags von Hand gesetzt, Area: Reports');
    expect(calls()).toHaveLength(0);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id).tags).toEqual({ Area: ['Reports'], Audience: ['Admins'] });
    // after sharing: the page goes out again right away, with the same demo
    sharing.setTags(c.id, 'Audience', []);
    // the card shows the page as shared meanwhile
    expect(JSON.parse(board.row(c.id).share!).state).toBe('publishing');
    await until(() => still(c.id));
    expect(calls()).toHaveLength(2);
    expect(meta(c.id).tags).toEqual({ Area: ['Reports'], Audience: [] });
    expect(log(c.id).at(-1)).toBe(`Die geteilte Seite zeigt jetzt ihre neuen Tags: ${share(c.id)!.url}`);
    // a later demo's worker
    const newer = videoDir(join(dir, 'newer'));
    board.work(c.id, { demos: board.row(c.id).demo!.replace(/^/, '[') + ']', demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [], page: { title: 'T', text: 'T.', tags: { Area: ['Settings'], Audience: ['Customers'] } } }) });
    expect(board.item(c.id)!.tags).toEqual({ Area: ['Reports'], Audience: [] });
    // a dimension the owner left alone comes from the newest worker
    vocabulary = { ...vocabulary, Plan: ['Free', 'Pro'] };
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [], page: { title: 'T', text: 'T.', tags: { Area: ['Settings'], Audience: ['Customers'], Plan: ['Pro'] } } }) });
    expect(board.item(c.id)!.tags).toEqual({ Area: ['Reports'], Audience: [], Plan: ['Pro'] });
  });

  test('set while the page goes out, it goes out once more with them', async () => {
    const c = tagged({ Area: ['Billing'], Audience: [] });
    writeFileSync(join(dir, 'hold'), '');
    sharing.share(c.id);
    await until(() => calls().length === 1);
    sharing.setTags(c.id, 'Area', ['Settings']);
    rmSync(join(dir, 'hold'));
    await until(() => calls().length === 2 && still(c.id));
    expect(meta(c.id).tags).toEqual({ Area: ['Settings'], Audience: [] });
  });

  test('only from the vocabulary', () => {
    const c = tagged({ Area: [], Audience: [] });
    expect(() => sharing.setTags(c.id, 'Area', ['Marketing'])).toThrow(BadRequest);
    expect(() => sharing.setTags(c.id, 'Team', ['A'])).toThrow(BadRequest);
    vocabulary = undefined;
    expect(() => sharing.setTags(c.id, 'Area', ['Billing'])).toThrow(BadRequest);
  });

  test('pages without tags, or with a value struck from the vocabulary, are tagged and shared again in one run; hand-set tags stay', async () => {
    const a = tagged({ Area: ['Billing'], Audience: ['Admins'] }, 'A');
    const b = tagged({ Area: ['Billing'], Audience: ['Admins'] }, 'B');
    const c = tagged({ Area: ['Reports'], Audience: ['Admins'] }, 'C');
    for (const x of [a, b, c]) {
      sharing.share(x.id);
      await until(() => share(x.id)?.state === 'shared');
    }
    sharing.setTags(b.id, 'Area', ['Billing']);
    await until(() => still(b.id));
    expect(calls()).toHaveLength(4);
    expect(board.snapshot().reshare).toBeUndefined();
    // Billing is struck: A and B lack their Area, C has its tags
    vocabulary = { Area: ['Invoices', 'Reports', 'Settings'], Audience: ['Admins', 'Customers'] };
    board.changed();
    expect(board.snapshot().reshare).toEqual({ outdated: 0, untagged: 2 });
    sharing.reshareMany(null, true);
    for (let i = 0; i < 2; i++) {
      await until(() => runtime.sessions.length === i + 1);
      expect(runtime.last.inbox[0]).toContain('- Area: Invoices, Reports, Settings');
      expect(runtime.last.inbox[0]).not.toContain('- Audience:');
      runtime.last.call('tags', { tags: { Area: ['Invoices'] } });
      runtime.last.emit({ type: 'idle' });
    }
    await until(() => board.snapshot().reshare?.run?.left === 0);
    expect(board.snapshot().reshare).toEqual({ outdated: 0, run: { total: 2, done: 2, failed: [], left: 0, tags: true } });
    for (const x of [a, b]) {
      expect(meta(x.id).tags).toEqual({ Area: ['Invoices'], Audience: ['Admins'] });
      expect(log(x.id)).toContain('Seiten ohne Tags taggen: Die Seite bekommt Tags und wird erneut geteilt.');
    }
    // the owner's choice for B was a struck value: the session's stands in for it, and the next owner's choice over that
    sharing.setTags(b.id, 'Area', ['Reports']);
    expect(board.item(b.id)!.tags!.Area).toEqual(['Reports']);
    // put away, a run tagging pages leaves the notice of outdated pages as it was
    await until(() => still(b.id));
    sharing.dismissResharing();
    expect(board.snapshot().reshare).toBeUndefined();
    expect(board.setting('reshare_dismissed')).toBeNull();
  });
});

/** The changes a page of the kind lacks when published before them all. */
describe('several demo versions on one page', () => {
  /** A card whose first demo came with handover 1. */
  const first = () => card('Filter bleiben', { handover: 1, at: '2026-10-16T09:00:00.000Z' });
  /** A later handover's demo: the one on the card goes to its earlier demos. */
  function later(id: string, handover: number, extra: Record<string, unknown> = {}) {
    const row = board.row(id);
    const d = videoDir(join(dir, `demo-${id}-${handover}`));
    writeFileSync(join(d, 'demo.mp4'), `video ${handover}`);
    board.work(id, {
      demos: JSON.stringify([...JSON.parse(row.demos ?? '[]'), JSON.parse(row.demo!)]),
      demo: JSON.stringify({ kind: 'video', dir: d, chapters: [[0, 'Nachher']], page: { title: `Ergänzung ${handover}`, text: 'Der Reset leert auch die Daten.' }, handover, at: '2026-10-16T11:37:00.000Z', ...extra }),
    });
  }
  const stored = (id: string) => JSON.parse(board.row(id).share!) as { demos?: { handover?: number; dir: string }[]; dir?: string; shown?: unknown };
  const page = (id: string) => readFileSync(join(dir, 'deployed', slug(id), 'index.html'), 'utf8');
  async function shared(id: string, act: () => void) {
    act();
    await until(() => share(id)?.state === 'shared');
  }

  test('"Zur Seite dazunehmen" puts a later demo below the shared one, under the same link', async () => {
    const c = first();
    await shared(c.id, () => sharing.share(c.id));
    expect(share(c.id)).toMatchObject({ on: [1] });
    const url = share(c.id)!.url;
    later(c.id, 2, { follows: 'supplements' });
    expect(share(c.id)).toMatchObject({ on: [1], stale: true });
    await shared(c.id, () => sharing.share(c.id, { add: true }));
    expect(share(c.id)).toEqual({ state: 'shared', url, on: [1, 2] });
    expect(stored(c.id).demos!.map((d) => d.handover)).toEqual([1, 2]);
    expect(log(c.id)).toContain('Zur Seite dazunehmen: Die Seite bekommt diese Demo als Ergänzung dazu.');
    // the first stays at the page's root, the later one in a directory of its own
    expect(readFileSync(join(dir, 'deployed', slug(c.id), 'demo.mp4'), 'utf8')).toBe('video');
    expect(readFileSync(join(dir, 'deployed', slug(c.id), '2', 'demo.mp4'), 'utf8')).toBe('video 2');
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', more: [{ title: 'Ergänzung 2', dir: '2', chapters: [[0, 'Nachher']], handed: '2026-10-16T11:37:00.000Z' }] });
    expect(page(c.id)).toContain('<h1>CSV-Export</h1>');
    expect(page(c.id)).toContain('<a href="#v2">2. Ergänzung vom ');
    expect(page(c.id)).toContain('<h3>Ergänzung 2</h3>');
    expect(page(c.id)).toContain('src="2/demo.mp4"');
  });

  test('"Teilen" on a supplement with no page yet puts the demo it supplements above it', async () => {
    const c = first();
    later(c.id, 2, { follows: 'supplements' });
    await shared(c.id, () => sharing.share(c.id));
    expect(share(c.id)).toMatchObject({ on: [1, 2] });
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', more: [{ title: 'Ergänzung 2' }] });
  });

  test('"Auf der Seite ersetzen" takes the shared ones off the page', async () => {
    const c = first();
    await shared(c.id, () => sharing.share(c.id));
    later(c.id, 2);
    await shared(c.id, () => sharing.share(c.id));
    expect(share(c.id)).toMatchObject({ on: [2] });
    expect(share(c.id)!.stale).toBeUndefined();
    expect(meta(c.id)).toMatchObject({ title: 'Ergänzung 2' });
    expect(meta(c.id)).not.toHaveProperty('more');
    expect(existsSync(join(dir, 'deployed', slug(c.id), '2'))).toBe(false);
    expect(log(c.id)).toContain('Auf der Seite ersetzen: Die Seite zeigt jetzt diese Demo statt der geteilten.');
  });

  test('an earlier demo shared goes onto the page in its place by handover', async () => {
    const c = first();
    later(c.id, 2);
    await shared(c.id, () => sharing.share(c.id));
    expect(share(c.id)).toMatchObject({ on: [2] });
    await shared(c.id, () => sharing.share(c.id, { demo: 1, add: true }));
    expect(share(c.id)).toMatchObject({ on: [1, 2] });
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', more: [{ title: 'Ergänzung 2' }] });
  });

  test('one version taken off goes out again without it; the last one takes the page down', async () => {
    const c = first();
    await shared(c.id, () => sharing.share(c.id));
    later(c.id, 2);
    await shared(c.id, () => sharing.share(c.id, { add: true }));
    await shared(c.id, () => sharing.unshare(c.id, 1));
    expect(share(c.id)).toMatchObject({ on: [2] });
    expect(meta(c.id)).toMatchObject({ title: 'Ergänzung 2' });
    expect(log(c.id)).toContain('Nicht mehr teilen: Die Seite geht ohne diese Demo wieder online.');
    expect(() => sharing.unshare(c.id, 1)).toThrow(BadRequest);
    sharing.unshare(c.id, 2);
    await until(() => !share(c.id));
    expect(calls().at(-1)!.pages[slug(c.id)]!.withdrawn).toBe(true);
  });

  test('a version already on the page goes out again with the others, and the PR link republishes them all', async () => {
    const c = first();
    await shared(c.id, () => sharing.share(c.id));
    later(c.id, 2);
    await shared(c.id, () => sharing.share(c.id, { add: true }));
    await shared(c.id, () => sharing.share(c.id, { demo: 1 }));
    expect(share(c.id)).toMatchObject({ on: [1, 2] });
    openPr(c.id);
    sharing.prOpened(c.id);
    await until(() => meta(c.id).pr === PR);
    expect(meta(c.id)).toMatchObject({ more: [{ title: 'Ergänzung 2' }] });
  });

  test('a page shared before several versions becomes a list of one, named by its handover', async () => {
    const c = first();
    await shared(c.id, () => sharing.share(c.id));
    const { demos, ...rest } = stored(c.id) as { demos: { dir: string; shown: unknown }[] };
    board.work(c.id, { share: JSON.stringify({ ...rest, dir: demos[0]!.dir, shown: demos[0]!.shown }) });
    later(c.id, 2);
    // read as a list of one before it is converted
    expect(share(c.id)).toMatchObject({ on: [1], stale: true });
    sharing.resume();
    expect(stored(c.id)).not.toHaveProperty('dir');
    expect(stored(c.id).demos!.map((d) => d.handover)).toEqual([1]);
  });
});

const lacking = (kind: 'video' | 'html' = 'video') => missedChanges('', kind, PAGE_CHANGES).map((c) => c.id);
/** The page went out before the changes since `version` ('': before them all). */
const backdate = (id: string, version = '') => board.work(id, { share: JSON.stringify({ ...JSON.parse(board.row(id).share!), version }) });

describe('a page published before a change to the pages', () => {
  const stored = (id: string) => JSON.parse(board.row(id).share!) as { version?: string; outdated?: true };

  test('is offered to share again with what changed since, and "Erneut teilen" brings it up to date', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(stored(c.id).version).toBe(pagesVersion());
    expect(share(c.id)!.outdated).toBeUndefined();

    backdate(c.id);
    expect(lacking().length).toBeGreaterThan(0);
    expect(share(c.id)).toEqual({ state: 'shared', url: expect.stringContaining(SITE_URL), outdated: lacking() });
    sharing.share(c.id);
    expect(log(c.id).at(-1)).toBe('Erneut teilen: Die Seite wird mit dem neuen Stand erzeugt.');
    expect(share(c.id)).toMatchObject({ state: 'publishing', url: expect.stringContaining(SITE_URL) });
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.outdated).toBeUndefined();
    expect(stored(c.id).version).toBe(pagesVersion());
    expect(calls().at(-1)!.wrote).toEqual([slug(c.id)]);
  });

  test('a change counts for the kinds of page it shows on', async () => {
    const v = card();
    const h = card('Auswertung', { kind: 'html', chapters: [] });
    writeFileSync(join(dir, `demo-${h.id}`, 'index.html'), '<!doctype html>');
    sharing.share(v.id);
    sharing.share(h.id);
    await until(() => share(v.id)?.state === 'shared' && share(h.id)?.state === 'shared');
    const first = PAGE_CHANGES[0].id;
    backdate(v.id, first);
    backdate(h.id, first);
    const ids = (kind: 'video' | 'html') => missedChanges(first, kind, PAGE_CHANGES).map((c) => c.id);
    expect([share(v.id)!.outdated, share(h.id)!.outdated]).toEqual([ids('video').length ? ids('video') : undefined, ids('html').length ? ids('html') : undefined]);
  });

  test('a newer demo is replaced on the page or added to it; the versions on the page still say what sharing them again brings', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    backdate(c.id);
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: join(dir, 'newer'), chapters: [], page: { title: 'T', text: 'T.' } }) });
    expect(share(c.id)).toMatchObject({ stale: true });
    expect(share(c.id)!.outdated).toEqual(missedChanges('', 'video', PAGE_CHANGES).map((c) => c.id));
  });

  test('each page is brought up to date on its own: sharing one again leaves the others outdated', async () => {
    const a = card('A');
    const b = card('B');
    for (const c of [a, b]) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
      backdate(c.id);
    }
    sharing.share(a.id);
    await until(() => share(a.id)?.state === 'shared' && !share(a.id)!.outdated);
    expect(share(b.id)!.outdated).toEqual(lacking());
    expect(stored(b.id).version).toBe('');
  });

  test('a page from before Obeya kept the page changes gets its change from the page as the site has it', async () => {
    const [a, b] = [card('A'), card('B')];
    for (const c of [a, b]) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
      board.work(c.id, { share: JSON.stringify({ ...stored(c.id), version: '9aef9b8395b7', outdated: true }) });
    }
    // b's page on the site is one from before the look of 2026-10-10
    const page = join(dir, 'home/sites', siteKey(SITE_URL), 'site', slug(b.id), 'index.html');
    writeFileSync(page, '<!doctype html><style>h1 { font-size: 28px; }</style>');
    sharing.resume();
    expect([stored(a.id), stored(b.id)].map((s) => [s.version, s.outdated])).toEqual([
      ['2026-10-16-alone', undefined],
      ['', undefined],
    ]);
    expect(share(b.id)!.outdated).toEqual(lacking());
  });
});

describe('sharing many outdated pages again at once', () => {
  const reshare = () => board.snapshot().reshare;
  /** What the outdated pages lack, for `n` of them. */
  const changes = (n: number) => lacking().map((id) => ({ id, pages: n }));
  /** Cards shared on the site whose demos were rendered `ages` minutes ago, published before every change to the pages. */
  async function outdated(...ages: number[]) {
    const cards = ages.map((age, n) => {
      const c = card(`Demo ${n}`);
      const video = join(dir, `demo-${c.id}`, 'demo.mp4');
      const t = new Date(Date.now() - age * 60_000);
      utimesSync(video, t, t);
      return c;
    });
    for (const c of cards) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
      backdate(c.id);
    }
    return cards;
  }
  /** The pages the deploys since the `before`th wrote. */
  const wrote = (before: number) => calls().slice(before).flatMap((c) => c.wrote);

  test('shares the newest again, one after the other, and says how far it got', async () => {
    const [old, newest, middle] = await outdated(30, 1, 10);
    expect(reshare()).toEqual({ outdated: 3, changes: changes(3) });
    const before = calls().length;
    sharing.reshareMany(2);
    expect(reshare()).toMatchObject({ outdated: 1, changes: changes(1), run: { total: 2, done: 0, left: 2, failed: [] } });
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 1, changes: changes(1), run: { total: 2, done: 2, failed: [], left: 0 } });
    expect(wrote(before)).toEqual([slug(newest!.id), slug(middle!.id)]);
    for (const c of [newest!, middle!]) {
      expect(share(c.id)!.outdated).toBeUndefined();
      expect(log(c.id)).toContain('Erneut teilen, mit anderen geteilten Demos: Die Seite wird mit dem neuen Stand erzeugt.');
      expect(log(c.id).at(-1)).toBe(`Erneut geteilt: ${share(c.id)!.url}`);
    }
    expect(share(old!.id)!.outdated).toEqual(lacking());
    // the result stays until the owner shares the rest again too
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 0, run: { total: 1, done: 1, failed: [], left: 0 } });
    expect(() => sharing.reshareMany(null)).toThrow(BadRequest);
  });

  test('"Ausblenden" puts the notice and the run away until a newer change leaves pages outdated', async () => {
    const [, video] = await outdated(1, 2);
    const html = card('Auswertung', { kind: 'html', chapters: [] });
    writeFileSync(join(dir, `demo-${html.id}`, 'index.html'), '<!doctype html>');
    sharing.share(html.id);
    await until(() => share(html.id)?.state === 'shared');
    sharing.reshareMany(1);
    await until(() => reshare()?.run?.left === 0);
    sharing.dismissResharing();
    expect(reshare()).toBeUndefined();
    // the card still offers it
    expect(share(video!.id)!.outdated).toEqual(lacking());
    expect(() => sharing.reshareMany(null)).toThrow(BadRequest);
    // put away before the newest change that marks pages came: the pages lacking that one show again, with all they lack
    const before = PAGE_CHANGES.filter((c) => !('tagged' in c)).at(-2)!.id;
    board.setSetting('reshare_dismissed', before);
    backdate(html.id);
    const lacksNewer = (kind: 'video' | 'html') => missedChanges(before, kind, PAGE_CHANGES).length > 0;
    const shown = [lacksNewer('video') && video, lacksNewer('html') && html].filter(Boolean);
    expect(reshare()!.outdated).toBe(shown.length);
  });

  test('a page that fails stays outdated, with the reason in its log, and the rest go on', async () => {
    const [a, b] = await outdated(2, 1);
    writeFileSync(join(dir, 'fail'), '');
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()!.run).toEqual({ total: 2, done: 0, failed: [b, a].map((c) => ({ id: c!.id, title: c!.title })), left: 0 });
    expect(share(a!.id)).toMatchObject({ state: 'shared', outdated: lacking() });
    expect(log(a!.id).at(-1)).toStartWith('Nicht erneut geteilt: Der Deploy der Site ist gescheitert (Exit-Code 2).');
    expect(reshare()!.outdated).toBe(2);
  });

  test('a page whose demo files were deleted is neither counted nor offered, and drops out of a run', async () => {
    const [a, b, c] = await outdated(3, 2, 1);
    rmSync(join(dir, `demo-${a!.id}`), { recursive: true });
    // the canvas shows it with its next change
    board.changed();
    expect(reshare()).toEqual({ outdated: 2, changes: changes(2) });
    expect(share(a!.id)).toEqual({ state: 'shared', url: expect.stringContaining(SITE_URL) });
    const before = calls().length;
    sharing.reshareMany(null);
    rmSync(join(dir, `demo-${b!.id}`, 'demo.mp4'));
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 0, run: { total: 1, done: 1, failed: [], left: 0 } });
    expect(wrote(before)).toEqual([slug(c!.id)]);
    sharing.dismissResharing();
    expect(reshare()).toBeUndefined();
  });

  test('one run at a time; stopped before a page went out, all stay as they were', async () => {
    await outdated(2, 1);
    const before = calls().length;
    sharing.reshareMany(null);
    expect(() => sharing.reshareMany(null)).toThrow(BadRequest);
    expect(() => sharing.dismissResharing()).toThrow(BadRequest);
    sharing.stopResharing();
    await new Promise((r) => setTimeout(r, 50));
    expect(reshare()).toEqual({ outdated: 2, changes: changes(2), run: { total: 2, done: 0, failed: [], left: 0, stopped: true } });
    expect(calls()).toHaveLength(before);
  });

  test('a card with a newer demo gets its page as it shows, the newer demo still waits for "Neu teilen"', async () => {
    const [c] = await outdated(1);
    board.work(c!.id, { demo: JSON.stringify({ kind: 'video', dir: join(dir, 'newer'), chapters: [], page: { title: 'Neu', text: 'Neu.' } }) });
    expect(reshare()).toEqual({ outdated: 1, changes: changes(1) });
    const before = calls().length;
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(wrote(before)).toEqual([slug(c!.id)]);
    expect(meta(c!.id).title).toBe('CSV-Export');
    expect(share(c!.id)).toMatchObject({ stale: true });
  });

  test('a page shared again on its own meanwhile no longer counts', async () => {
    const [a, b] = await outdated(2, 1);
    sharing.reshareMany(null);
    sharing.share(a!.id);
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()!.run).toMatchObject({ total: 1, done: 1 });
    expect(share(b!.id)!.outdated).toBeUndefined();
  });

  test('goes on after a restart', async () => {
    const [a, b] = await outdated(2, 1);
    // the restart came while b went out
    board.work(b!.id, { share: JSON.stringify({ ...JSON.parse(board.row(b!.id).share!), state: 'publishing', refresh: true, again: true }) });
    board.setReshareRun({ queue: [b!.id, a!.id], total: 2, done: 0, failed: [] });
    sharing = make();
    sharing.resume();
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()!.run).toMatchObject({ total: 2, done: 2 });
    expect(share(a!.id)!.outdated).toBeUndefined();
    expect(share(b!.id)!.outdated).toBeUndefined();
  });

  test('a restart keeps the marks of stored shares and the run under way as they were', async () => {
    const [a, b, c, d] = await outdated(4, 3, 2, 1);
    // d is up to date again on its own; the restart came while b went out, a still to go, c left out
    sharing.share(d!.id);
    await until(() => share(d!.id)?.state === 'shared' && !share(d!.id)!.outdated);
    board.work(b!.id, { share: JSON.stringify({ ...JSON.parse(board.row(b!.id).share!), state: 'publishing', refresh: true, again: true }) });
    board.setReshareRun({ queue: [b!.id, a!.id], total: 2, done: 0, failed: [] });
    const stored = (id: string) => board.row(id).share;
    const before = [a, c, d].map((x) => stored(x!.id));
    writeFileSync(join(dir, 'hold'), '');
    const n = calls().length;
    sharing = make();
    sharing.resume();
    // b goes out again once the versions were asked for
    await until(() => calls().length === n + 1);
    expect(wrote(n)).toEqual([slug(b!.id)]);
    expect([a, c, d].map((x) => stored(x!.id))).toEqual(before);
    expect(reshare()).toEqual({ outdated: 1, changes: changes(1), run: { total: 2, done: 0, failed: [], left: 2, current: b!.title } });
    rmSync(join(dir, 'hold'));
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 1, changes: changes(1), run: { total: 2, done: 2, failed: [], left: 0 } });
    expect([a, b, c, d].map((x) => !!share(x!.id)!.outdated)).toEqual([false, false, true, false]);
  });
});

describe('publishing on approval', () => {
  beforeEach(() => {
    publish = 'approved';
  });
  /** A later handover's demo, with what its worker said of it. */
  function later(id: string, handover: number, extra: Record<string, unknown> = {}) {
    const row = board.row(id);
    const d = videoDir(join(dir, `demo-${id}-${handover}`));
    writeFileSync(join(d, 'demo.mp4'), `video ${handover}`);
    board.work(id, {
      demos: JSON.stringify([...JSON.parse(row.demos ?? '[]'), JSON.parse(row.demo!)]),
      demo: JSON.stringify({ kind: 'video', dir: d, chapters: [], page: { title: `Demo ${handover}`, text: 'T.' }, handover, ...extra }),
    });
  }
  const on = (id: string) => (JSON.parse(board.row(id).share!) as { demos: { handover?: number }[] }).demos.map((d) => d.handover);

  test('the latest demo goes on its page, and the trailer names the page before the deploy is done', async () => {
    const c = card();
    writeFileSync(join(dir, 'hold'), '');
    const trailer = sharing.approved(c.id);
    expect(trailer).toBe(`Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    expect(share(c.id)).toEqual({ state: 'publishing' });
    expect(log(c.id)).toContain('Mit der Freigabe geteilt: Die Seite geht online.');
    rmSync(join(dir, 'hold'));
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.url).toBe(`${SITE_URL}${slug(c.id)}/`);
    expect(readFileSync(join(dir, 'deployed', slug(c.id), 'demo.mp4'), 'utf8')).toBe('video');
    // approved again (a landing that went back to the worker): the page has the demo already
    expect(sharing.approved(c.id)).toBe(trailer);
    await Bun.sleep(50);
    expect(calls()).toHaveLength(1);
  });

  test('a later demo goes beside the shared ones where its worker said it supplements them, else in their place', async () => {
    const c = card('Filter bleiben', { handover: 1 });
    sharing.approved(c.id);
    await until(() => share(c.id)?.state === 'shared');
    later(c.id, 2, { follows: 'supplements' });
    sharing.approved(c.id);
    expect(log(c.id).at(-1)).toBe('Mit der Freigabe zur Seite dazugenommen: Die Seite bekommt die neueste Demo als Ergänzung dazu.');
    await until(() => share(c.id)?.state === 'shared' && on(c.id).length === 2);
    expect(on(c.id)).toEqual([1, 2]);
    later(c.id, 3, { follows: 'replaces' });
    sharing.approved(c.id);
    await until(() => share(c.id)?.state === 'shared' && on(c.id)[0] === 3);
    expect(on(c.id)).toEqual([3]);
    // without the worker's word, the latest replaces the page, as "Teilen" offers first
    later(c.id, 4);
    sharing.approved(c.id);
    await until(() => share(c.id)?.state === 'shared' && on(c.id)[0] === 4);
    expect(on(c.id)).toEqual([4]);
    expect(log(c.id)).toContain('Mit der Freigabe auf der Seite ersetzt: Die Seite zeigt jetzt die neueste Demo statt der geteilten.');
  });

  test('a supplement goes out with the demos it supplements, though they were never shared', async () => {
    const c = card('Filter bleiben', { handover: 1 });
    later(c.id, 2, { follows: 'supplements' });
    later(c.id, 3, { follows: 'supplements' });
    sharing.approved(c.id);
    expect(log(c.id).at(-1)).toBe('Mit der Freigabe geteilt: Die Seite geht online.');
    await until(() => share(c.id)?.state === 'shared');
    expect(on(c.id)).toEqual([1, 2, 3]);
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', more: [{ title: 'Demo 2' }, { title: 'Demo 3' }] });
    // a demo recorded afresh ends what a later supplement takes along
    later(c.id, 4, { follows: 'replaces' });
    later(c.id, 5, { follows: 'supplements' });
    sharing.unshare(c.id);
    await until(() => !share(c.id));
    sharing.approved(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(on(c.id)).toEqual([4, 5]);
  });

  test('a share under way goes out first, the latest demo after it', async () => {
    publish = undefined;
    const c = card('Filter bleiben', { handover: 1 });
    later(c.id, 2);
    writeFileSync(join(dir, 'hold'), '');
    // the owner shares the first demo, then approves while it goes out
    sharing.share(c.id, { demo: 1 });
    publish = 'approved';
    expect(sharing.approved(c.id)).toBe(`Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    rmSync(join(dir, 'hold'));
    await until(() => share(c.id)?.state === 'shared' && on(c.id)[0] === 2);
    expect(on(c.id)).toEqual([2]);
    expect(calls()).toHaveLength(2);
  });

  test('a review card’s page is linked in a comment on the PR once approved, its description left to the contributor', async () => {
    const c = card('PR #5: Watcher im Hintergrund');
    const url = 'https://github.com/acme/app/pull/5';
    bodies.set(url, 'Contributor’s description.');
    const review = { url, number: 5, author: 'amerlander', title: 'Watcher', canModify: true, route: 'contributor' };
    board.work(c.id, { state: 'waiting', need: 'demo', pr: JSON.stringify({ url, number: 5, seen: [], reported: [] }), contribution: JSON.stringify(review) });
    // shared before the approval: nothing goes to the PR yet
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(comments).toEqual([]);
    board.work(c.id, { contribution: JSON.stringify({ ...review, approved: true }) });
    sharing.approved(c.id);
    await until(() => comments.length === 1);
    expect(comments[0]).toBe(`${url} Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    expect(edits).toEqual([]);
    expect(log(c.id)).toContain(`Den Link zur Demo als Kommentar an PR #5 geschrieben. ${url}#issuecomment-1`);
    // approved again: the same page is not linked twice
    sharing.approved(c.id);
    await Bun.sleep(50);
    expect(comments).toHaveLength(1);
  });

  test('the workers hear where the page is once it is online, or why it is not', async () => {
    const c = card();
    writeFileSync(join(dir, 'hold'), '');
    sharing.approved(c.id);
    await Bun.sleep(50);
    expect(settled).toEqual([]);
    rmSync(join(dir, 'hold'));
    await until(() => share(c.id)?.state === 'shared');
    expect(settled).toEqual([[c.id, { url: `${SITE_URL}${slug(c.id)}/` }]]);
    const d = card('Filter bleiben');
    writeFileSync(join(dir, 'fail'), '');
    sharing.approved(d.id);
    await until(() => settled.length === 2);
    expect(settled[1]![0]).toBe(d.id);
    expect((settled[1]![1] as { why: string }).why).toBeTruthy();
  });

  test('with a share under way, the workers hear of the page once the latest demo is on it, not before', async () => {
    publish = undefined;
    const c = card('Filter bleiben', { handover: 1 });
    later(c.id, 2);
    writeFileSync(join(dir, 'hold'), '');
    sharing.share(c.id, { demo: 1 });
    publish = 'approved';
    sharing.approved(c.id);
    rmSync(join(dir, 'hold'));
    await until(() => share(c.id)?.state === 'shared' && on(c.id)[0] === 2);
    expect(settled).toEqual([[c.id, { url: `${SITE_URL}${slug(c.id)}/` }]]);
  });

  test('a failed deploy goes into the log; the trailer still names the page', async () => {
    const c = card();
    writeFileSync(join(dir, 'fail'), '');
    expect(sharing.approved(c.id)).toBe(`Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    await until(() => !share(c.id));
    const err = board.events(c.id).at(-1)!;
    expect(err.kind).toBe('error');
    expect(err.text).toContain('Nicht geteilt');
  });

  test('an artifact is named as a page', async () => {
    const c = card('Varianten', { kind: 'html' });
    writeFileSync(join(JSON.parse(board.row(c.id).demo!).dir, 'index.html'), '<!doctype html><html lang="de"><p>Varianten</p></html>');
    expect(sharing.approved(c.id)).toBe(`Demo-Page: ${SITE_URL}${slug(c.id)}/`);
    await until(() => share(c.id)?.state === 'shared');
  });

  test('unticked „Mit der Freigabe teilen“ keeps the approval from sharing, through sharing now and withdrawing', async () => {
    const c = card('Filter bleiben', { handover: 1 });
    sharing.onApproval(c.id, false);
    expect(board.card(c.id)?.notOnApproval).toBe(true);
    expect(sharing.approved(c.id)).toBeNull();
    expect(share(c.id)).toBeUndefined();
    expect(log(c.id).at(-1)).toBe('Mit der Freigabe nicht geteilt: „Mit der Freigabe teilen“ war abgewählt.');
    // shared now, before the approval: the page goes out, and a later demo waits for the owner
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    later(c.id, 2);
    expect(sharing.approved(c.id)).toBe(`Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    await Bun.sleep(50);
    expect(calls()).toHaveLength(1);
    expect(on(c.id)).toEqual([1]);
    sharing.unshare(c.id);
    await until(() => !share(c.id));
    expect(board.card(c.id)?.notOnApproval).toBe(true);
    // ticked again, the approval shares as before
    sharing.onApproval(c.id, true);
    expect(board.card(c.id)?.notOnApproval).toBeUndefined();
    sharing.approved(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(on(c.id)).toEqual([2]);
  });

  test('a site that publishes only on "Teilen" puts nothing out; a page shared before still goes into the trailer', async () => {
    publish = undefined;
    const c = card();
    expect(sharing.approved(c.id)).toBeNull();
    expect(share(c.id)).toBeUndefined();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    later(c.id, 2);
    expect(sharing.approved(c.id)).toBe(`Demo-Video: ${SITE_URL}${slug(c.id)}/`);
    await Bun.sleep(50);
    expect(calls()).toHaveLength(1);
    // a card without a site or without a demo has no page
    expect(sharing.approved(card('Ohne Site').id)).toBeNull();
  });
});

describe('the link in the pull request', () => {
  test('a page shared before the PR is published again with its link, and the description links the page', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id).pr).toBeNull();
    openPr(c.id);
    sharing.prOpened(c.id);
    // the card goes on showing the page while it goes out again
    expect(share(c.id)).toMatchObject({ state: 'shared', url: expect.stringContaining(SITE_URL) });
    await until(() => calls().length === 2);
    await until(() => edits.length === 1);
    const url = share(c.id)!.url!;
    expect(calls()[1]!.wrote).toEqual([slug(c.id)]);
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', pr: PR });
    expect(bodies.get(PR)).toBe(`Exportiert Zählerstände.\n\nDemo-Video: ${url} ${DEMO_MARKER}\n`);
    expect(log(c.id)).toContain(`Die geteilte Seite verlinkt jetzt den Pull Request: ${url}`);
    expect(log(c.id).at(-1)).toBe(`Den Link zur Demo in die Beschreibung von Pull Request #42 eingetragen. ${PR}`);
    // once: the PR is linked, and the description is not touched again
    sharing.prOpened(c.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toHaveLength(2);
    expect(edits).toHaveLength(1);
  });

  test('a page shared after the PR links it at once; a description that links the page already stays', async () => {
    const c = card();
    openPr(c.id, `Exportiert Zählerstände.\n\nDemo: ${SITE_URL}zahlerstande-exportieren-${c.id.slice(0, 6)}/`);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(calls()).toHaveLength(1);
    expect(meta(c.id).pr).toBe(PR);
    expect(edits).toEqual([]);
  });

  test('a PR opened while the page goes out gets a second round with its link', async () => {
    const c = card();
    sharing.share(c.id);
    // the deploy is running
    await until(() => calls().length === 1);
    openPr(c.id);
    sharing.prOpened(c.id);
    await until(() => calls().length === 2 && edits.length === 1);
    expect(calls().map((x) => x.pages[slug(c.id)]!.meta!.pr)).toEqual([null, PR]);
  });

  test('a newer demo on the card is not put out with the link: the page goes out again as it is', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    const newer = videoDir(join(dir, 'newer'));
    writeFileSync(join(newer, 'demo.mp4'), 'newer video');
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [[0, 'Neu']], page: { title: 'CSV-Export 2', text: 'T.' } }) });
    openPr(c.id);
    sharing.prOpened(c.id);
    // the link goes in once the deploy is done: recorded, it is still copying the site
    await until(() => calls().length === 2 && edits.length === 1);
    expect(meta(c.id)).toMatchObject({ title: 'CSV-Export', chapters: [[0, 'Vorher']], pr: PR });
    expect(readFileSync(join(dir, 'deployed', slug(c.id), 'demo.mp4'), 'utf8')).toBe('video');
    expect(share(c.id)!.stale).toBe(true);
  });

  test('a description that cannot be read leaves the page shared, with the reason in the log', async () => {
    const c = card();
    board.work(c.id, { pr: JSON.stringify({ url: PR, number: 42, seen: [], reported: [] }) });
    sharing.share(c.id);
    await until(() => board.events(c.id).at(-1)!.kind === 'error');
    expect(share(c.id)!.state).toBe('shared');
    expect(log(c.id).at(-1)).toContain('nicht in Pull Request #42 eingetragen: gh pr view: no pull request');
  });

  test('withDemoLink adds a line once and replaces its own', () => {
    expect(withDemoLink('', 'https://d/a/')).toBe(`Demo-Video: https://d/a/ ${DEMO_MARKER}\n`);
    expect(withDemoLink('Text\n\n', 'https://d/a/')).toBe(`Text\n\nDemo-Video: https://d/a/ ${DEMO_MARKER}\n`);
    expect(withDemoLink('Siehe https://d/a/', 'https://d/a/')).toBeNull();
    expect(withDemoLink(`Text\n\nDemo-Video: https://d/old/ ${DEMO_MARKER}\n\nFooter`, 'https://d/a/')).toBe(`Text\n\nDemo-Video: https://d/a/ ${DEMO_MARKER}\n\nFooter`);
    expect(withDemoLink(`Text\n\nDemo-Video: https://d/old/ ${DEMO_MARKER}`, 'https://d/a/', 'html')).toBe(`Text\n\nDemo-Seite: https://d/a/ ${DEMO_MARKER}`);
  });
});

describe('the link to the commit, without a pull request', () => {
  let repo: string;
  beforeEach(() => {
    // a checkout whose `origin` is on GitHub
    repo = gitRepo(join(dir, 'checkout'));
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    sharing = make(repo);
  });
  /** The card's work lands in `n` commits: `shipped`, as a landing writes it. */
  function land(id: string, n = 1) {
    const base = git(repo, 'rev-parse', 'HEAD');
    for (let i = 0; i < n; i++) git(repo, 'commit', '--quiet', '--allow-empty', '-m', `Step ${i}`);
    const to = git(repo, 'rev-parse', 'HEAD');
    board.work(id, { shipped: JSON.stringify({ commit: to, base }) });
    return { base, to };
  }
  const commitOf = (id: string, at = -1) => (calls().at(at)!.pages[slug(id)]!.meta as { commit?: { url: string; several?: true } }).commit;
  const page = (id: string) => readFileSync(join(dir, 'deployed', slug(id), 'index.html'), 'utf8');

  test('a page shared before the work landed is published again with the commit', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(commitOf(c.id)).toBeUndefined();
    const { to } = land(c.id);
    await sharing.landed(c.id);
    // the card goes on showing the page while it goes out again
    expect(share(c.id)!.state).toBe('shared');
    await until(() => calls().length === 2 && !board.row(c.id).share!.includes('publishing'));
    expect(commitOf(c.id)).toEqual({ url: `https://github.com/acme/app/commit/${to}` });
    expect(page(c.id)).toContain(`<a href="https://github.com/acme/app/commit/${to}">Commit ansehen</a>`);
    expect(log(c.id)).toContain(`Die geteilte Seite verlinkt jetzt den Commit auf main: ${share(c.id)!.url}`);
    // once: the page links it already
    await sharing.landed(c.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toHaveLength(2);
  });

  test('work landed in several commits links the comparison over them; a page shared then links it at once', async () => {
    const c = card('In English', {}, null);
    const { base, to } = land(c.id, 3);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(calls()).toHaveLength(1);
    expect(commitOf(c.id)).toEqual({ url: `https://github.com/acme/app/compare/${base}...${to}`, several: true });
    expect(page(c.id)).toContain('>View commits</a>');
  });

  test('a landing while the page goes out gets a second round with the commit', async () => {
    const c = card();
    writeFileSync(join(dir, 'hold'), '');
    sharing.share(c.id);
    await until(() => calls().length === 1);
    const { to } = land(c.id);
    // the page is going out: it picks the commit up once it is done
    await sharing.landed(c.id);
    rmSync(join(dir, 'hold'));
    await until(() => calls().length === 2 && !board.row(c.id).share!.includes('publishing'));
    expect(commitOf(c.id, 0)).toBeUndefined();
    expect(commitOf(c.id)).toEqual({ url: `https://github.com/acme/app/commit/${to}` });
  });

  test('a card with a pull request links that, not the commit', async () => {
    const c = card();
    openPr(c.id);
    land(c.id);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id).pr).toBe(PR);
    expect(commitOf(c.id)).toBeUndefined();
  });

  test('a repository whose origin is a path links no commit', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(dir, 'elsewhere.git'));
    const c = card();
    land(c.id);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(commitOf(c.id)).toBeUndefined();
  });
});

describe('a demo narrated anew in its directory', () => {
  /** What `--revoice en` leaves in the demo's directory: the chapters and captions of the English take, the report page in English. */
  function revoiced(d: string) {
    writeFileSync(join(d, 'chapters.vtt'), 'WEBVTT\n\n00:00:00.002 --> 00:00:12.000\nBefore\n\n00:00:12.000 --> 00:00:20.000\nNow\n');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00:00.352 --> 00:00:11.400\nUntil now …\n\n00:00:12.352 --> 00:00:19.000\nNow …\n');
    writeFileSync(join(d, 'index.html'), '<!doctype html>\n<html lang="en">\n<head><title>Report</title></head></html>');
  }

  test('the card shows it with its new chapters, and its page is written again in its language when shared', async () => {
    const c = card('Zählerstände exportieren', { chapters: [[0, 'Vorher'], [9.5, 'Jetzt']] });
    const d = JSON.parse(board.row(c.id).demo!).dir as string;
    revoiced(d);
    sharing.rebuilt(c.id);
    const demo = JSON.parse(board.row(c.id).demo!);
    expect(demo.chapters).toEqual([[0, 'Before'], [12, 'Now']]);
    // the worker's page text spoke of the demo as it was
    expect(demo.page).toBeUndefined();
    expect(log(c.id).at(-1)).toBe('Das Demo ist in seinem Verzeichnis neu vertont, auf Englisch: Die Aufgabe zeigt es mit seinen neuen Kapiteln, und der Text seiner Seite wird beim Teilen neu geschrieben.');

    sharing.share(c.id);
    await until(() => runtime.sessions.length === 1);
    expect(runtime.last.spec.system).toContain('in English');
    runtime.last.call('page', { title: 'Meter readings as CSV', text: 'Landlords download meter readings as a CSV file.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => share(c.id)?.state === 'shared');
    expect(meta(c.id)).toMatchObject({ title: 'Meter readings as CSV', chapters: [[0, 'Before'], [12, 'Now']], language: 'en' });
  });

  test('a demo on a shared page is not changed under it', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    revoiced(JSON.parse(board.row(c.id).demo!).dir);
    expect(() => sharing.rebuilt(c.id)).toThrow('stop sharing it first');
    expect(JSON.parse(board.row(c.id).demo!).chapters).toEqual([[0, 'Vorher']]);
  });
});

describe('exporting a demo, where the repository has no demo site', () => {
  /** A demo directory as the demo skill leaves it. */
  function files(c: { id: string }, video = 'MP4DATA') {
    const d = join(dir, `demo-${c.id}`);
    writeFileSync(join(d, 'demo.mp4'), video);
    writeFileSync(join(d, 'poster.jpg'), 'JPEG');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.500\nDer Export </script> beginnt.\n');
  }

  test('the version shown goes into the file: an earlier one by its handover', async () => {
    const c = card('Ohne Ziel', { handover: 1 });
    files(c, 'FIRST');
    const d = videoDir(join(dir, `demo-${c.id}-2`));
    writeFileSync(join(d, 'demo.mp4'), 'SECOND');
    board.work(c.id, {
      demos: JSON.stringify([JSON.parse(board.row(c.id).demo!)]),
      demo: JSON.stringify({ kind: 'video', dir: d, chapters: [], page: { title: 'Ergänzung', text: 'Ein Detail.' }, handover: 2 }),
    });
    const html = async (handover?: number) => new TextDecoder().decode((await sharing.export(c.id, 'html', handover)).data);
    expect(await html()).toContain(Buffer.from('SECOND').toString('base64'));
    expect(await html(1)).toContain(Buffer.from('FIRST').toString('base64'));
    expect(await html(1)).toContain('<h1>CSV-Export</h1>');
  });

  test('as a ZIP: the page in a folder with the video, poster and captions beside it', async () => {
    const c = card('Ohne Ziel');
    files(c);
    const out = await sharing.export(c.id, 'zip');
    const slug = 'ohne-ziel-' + c.id.slice(0, 6);
    expect(out.name).toBe(`${slug}.zip`);
    writeFileSync(join(dir, out.name), out.data);
    // a ZIP every system opens: checked by unzip
    const p = Bun.spawnSync(['unzip', '-o', '-d', join(dir, 'unzipped'), join(dir, out.name)]);
    expect(p.exitCode).toBe(0);
    const at = join(dir, 'unzipped', slug);
    expect(readFileSync(join(at, 'demo.mp4'), 'utf8')).toBe('MP4DATA');
    expect(readFileSync(join(at, 'poster.jpg'), 'utf8')).toBe('JPEG');
    const html = readFileSync(join(at, 'index.html'), 'utf8');
    expect(html).toContain('<h1>CSV-Export</h1>');
    expect(html).toContain('<p>Vermieter laden Zählerstände als CSV.</p>');
    expect(html).toContain('src="demo.mp4"');
    expect(html).toContain('Vorher');
    // the captions are in the page too, for a page opened from disk; they cannot end its script
    expect(html).toContain('Der Export <\\/script> beginnt.');
    // a big play button over the video, so a click anywhere on it starts it
    expect(html).toContain('<button class="start" aria-label="Abspielen">');
    // in the demo's language throughout
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<div class="when">Demo vom ');
    expect(html).toContain('<script type="text/vtt" class="captions" data-lang="de" data-label="Deutsch">');
    expect(log(c.id).at(-1)).toBe(`Exportiert als ZIP: ${slug}.zip`);
    // exporting publishes nothing
    expect(calls()).toEqual([]);
    expect(share(c.id)).toBeUndefined();
  });

  test('as one HTML file holding the video, for short videos only', async () => {
    const c = card('Ohne Ziel');
    files(c);
    const out = await sharing.export(c.id, 'html');
    const html = new TextDecoder().decode(out.data);
    expect(out.name).toMatch(/^ohne-ziel-.*\.html$/);
    expect(html).toContain(Buffer.from('MP4DATA').toString('base64'));
    expect(html).toContain(`poster="data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}"`);
    expect(html).not.toContain('src="demo.mp4"');

    const big = card('Lang');
    files(big, 'x'.repeat(EXPORT_HTML_MAX + 1));
    await expect(sharing.export(big.id, 'html')).rejects.toMatchObject({ code: 'exportTooLarge' });
    expect((await sharing.export(big.id, 'zip')).name).toEndWith('.zip');
  });

  test('an English demo gets an English page throughout', async () => {
    const c = card('Ohne Ziel', { page: { title: 'CSV export', text: 'Landlords download meter readings as CSV.' } }, 'en');
    files(c);
    openPr(c.id);
    utimesSync(join(dir, `demo-${c.id}`, 'demo.mp4'), new Date('2026-10-07T12:00:00Z'), new Date('2026-10-07T12:00:00Z'));
    const html = new TextDecoder().decode((await sharing.export(c.id, 'html')).data);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<div class="when">Demo from October 7, 2026</div>');
    expect(html).toContain('<button class="start" aria-label="Play">');
    expect(html).toContain(`>View pull request</a>`);
    expect(html).toContain('<script type="text/vtt" class="captions" data-lang="en" data-label="English">');
    for (const german of ['Deutsch', 'Abspielen', 'Demo vom', 'ansehen', 'lang="de"']) expect(html).not.toContain(german);
    // a site's page, with the caption files beside it, names each track in its own language
    const parts = { title: 'CSV export', text: '', chapters: [], pr: null, when: '', tabTitle: '', video: { src: 'demo.mp4' }, tracks: [{ language: 'en', src: 'captions.en.vtt' }, { language: 'fr', src: 'captions.fr.vtt' }] };
    expect(demoPageHtml({ ...parts, language: 'en' })).toContain('<track kind="captions" src="captions.en.vtt" srclang="en" label="English"><track kind="captions" src="captions.fr.vtt" srclang="fr" label="French">');
    // without a language the page is German
    expect(demoPageHtml(parts)).toContain('<track kind="captions" src="captions.fr.vtt" srclang="fr" label="Französisch">');
    // a silent video shows its captions from the start
    expect(demoPageHtml(parts)).not.toContain('data-silent');
    expect(demoPageHtml({ ...parts, silent: true })).toContain(' data-silent>');
  });

  test('a demo without its page gets one written first, kept for the next time', async () => {
    const c = card('Zähler', { page: undefined });
    files(c);
    const out = sharing.export(c.id, 'zip');
    await until(() => runtime.sessions.length === 1);
    runtime.last.call('page', { title: 'Zählerstände als CSV', text: 'Vermieter laden sie herunter.' });
    runtime.last.emit({ type: 'idle' });
    expect((await out).name).toEndWith('.zip');
    expect(board.item(c.id)!.demo!.page).toEqual({ title: 'Zählerstände als CSV', text: 'Vermieter laden sie herunter.' });
  });

  test('an HTML artifact: beside its page in the ZIP, in one HTML file only when it is its index.html alone', async () => {
    const c = card('Ohne Ziel', { kind: 'html', chapters: [], page: { title: 'Auswertung', text: 'Verlust aus den Messdaten.' } });
    const d = join(dir, `demo-${c.id}`);
    writeFileSync(join(d, 'index.html'), '<html lang="de"><body><h2>Graph</h2></body></html>');
    const one = new TextDecoder().decode((await sharing.export(c.id, 'html')).data);
    expect(one).toContain('<h1>Auswertung</h1>');
    // the artifact in a sandboxed frame, telling the page its height
    expect(one).toContain('srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;meta charset=&quot;utf-8&quot;&gt;&lt;meta http-equiv=&quot;Content-Security-Policy&quot;');
    expect(one).toContain('&lt;html lang=&quot;de&quot;&gt;&lt;body&gt;&lt;h2&gt;Graph&lt;/h2&gt;');
    expect(one).toContain('obeyaHeight');
    expect(one).toContain('sandbox="allow-scripts" ');
    // with no files beside it, it loads nothing but what it holds; the page around shows no frame from elsewhere
    expect(one).toContain(`content=&quot;default-src data: blob:; script-src 'unsafe-inline'`);
    expect(one).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'self' file: data: blob:;`);

    mkdirSync(join(d, 'data'));
    writeFileSync(join(d, 'data', 'chart.js'), 'draw()');
    writeFileSync(join(d, '.DS_Store'), 'x');
    await expect(sharing.export(c.id, 'html')).rejects.toMatchObject({ code: 'exportNotAlone' });
    const out = await sharing.export(c.id, 'zip');
    writeFileSync(join(dir, out.name), out.data);
    expect(Bun.spawnSync(['unzip', '-o', '-d', join(dir, 'unzipped'), join(dir, out.name)]).exitCode).toBe(0);
    const at = join(dir, 'unzipped', out.name.replace(/\.zip$/, ''));
    // opened from disk, the frame keeps the page's origin: Chrome loads nothing beside a sandboxed page there
    expect(readFileSync(join(at, 'index.html'), 'utf8')).toContain('<iframe sandbox="allow-scripts');
    expect(readFileSync(join(at, 'index.html'), 'utf8')).toContain(`if (location.protocol === 'file:') f.sandbox.add('allow-same-origin');\n  f.src = "artifact/index.html";`);
    expect(readFileSync(join(at, 'index.html'), 'utf8')).toContain('>In eigenem Fenster öffnen</a>');
    expect(readFileSync(join(at, 'artifact/data/chart.js'), 'utf8')).toBe('draw()');
    expect(readFileSync(join(at, 'artifact/index.html'), 'utf8')).toMatch(/<h2>Graph<\/h2><script>[\s\S]*obeyaHeight[\s\S]*<\/script><\/body>/);
    // from disk, `'self'` may not match its files: `file:` does
    expect(readFileSync(join(at, 'artifact/index.html'), 'utf8')).toContain(`content="default-src 'self' file: data: blob:;`);
    expect(existsSync(join(at, 'artifact/.DS_Store'))).toBe(false);
  });

  test('an English artifact gets an English page around it', async () => {
    const c = card('Ohne Ziel', { kind: 'html', chapters: [], page: { title: 'Analysis', text: 'Loss from the readings.' } });
    writeFileSync(join(dir, `demo-${c.id}`, 'index.html'), '<!doctype html><html lang="en"><body><h2>Graph</h2></body></html>');
    openPr(c.id);
    const out = await sharing.export(c.id, 'zip');
    writeFileSync(join(dir, out.name), out.data);
    expect(Bun.spawnSync(['unzip', '-o', '-d', join(dir, 'unzipped'), join(dir, out.name)]).exitCode).toBe(0);
    const html = readFileSync(join(dir, 'unzipped', out.name.replace(/\.zip$/, ''), 'index.html'), 'utf8');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('>Open in its own window</a><a href="https://github.com/acme/app/pull/42">View pull request</a>');
    expect(html).toMatch(/<div class="when">Demo from \w+ \d+, \d{4}<\/div>/);
  });

  test('no demo, no export', async () => {
    // an artifact without its page, a video demo whose file is gone
    await expect(sharing.export(card('Logo', { kind: 'html' }).id, 'zip')).rejects.toMatchObject({ code: 'noShare' });
    const gone = card('Weg');
    rmSync(join(dir, `demo-${gone.id}`, 'demo.mp4'));
    await expect(sharing.export(gone.id, 'zip')).rejects.toMatchObject({ code: 'noShare' });
  });
});

describe('a repository’s theme', () => {
  const THEME = { css: ':root { --accent: #1d4ed8; } h1 { font-family: system-ui; }', hash: 'aaaaaaaaaaaaaaaa' };
  const pageOf = (id: string) => readFileSync(join(dir, 'deployed', slug(id), 'index.html'), 'utf8');

  test('goes into the page after Obeya’s style; a new theme leaves the page outdated, and sharing again brings it', async () => {
    theme = THEME;
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    const html = pageOf(c.id);
    expect(html.indexOf(`<style>${THEME.css}</style>`)).toBeGreaterThan(html.indexOf('</style>'));
    // nothing the theme names loads from elsewhere
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'self' file: data: blob:;`);
    expect(meta(c.id)).toMatchObject({ theme: THEME.hash });
    expect(readFileSync(join(dir, 'deployed', 'index.html'), 'utf8')).toContain(`<style>${THEME.css}</style>`);
    expect(share(c.id)!.outdated).toBeUndefined();

    // a new theme on the main branch: the canvas shows what it leaves outdated
    theme = { css: ':root { --accent: #b91c1c; }', hash: 'bbbbbbbbbbbbbbbb' };
    board.changed();
    expect(share(c.id)!.outdated).toEqual(['theme']);
    expect(board.snapshot().reshare).toEqual({ outdated: 1, changes: [{ id: 'theme', pages: 1 }] });
    // "Ausblenden" until the theme changes anew; the card still offers it
    sharing.dismissResharing();
    expect(board.snapshot().reshare).toBeUndefined();
    expect(share(c.id)!.outdated).toEqual(['theme']);
    theme = { css: ':root { --accent: #15803d; }', hash: 'cccccccccccccccc' };
    board.changed();
    expect(board.snapshot().reshare).toEqual({ outdated: 1, changes: [{ id: 'theme', pages: 1 }] });

    sharing.reshareMany(null);
    await until(() => board.snapshot().reshare?.run?.left === 0);
    expect(share(c.id)!.outdated).toBeUndefined();
    expect(pageOf(c.id)).toContain(`<style>${theme.css}</style>`);
    expect(pageOf(c.id)).not.toContain(THEME.css);

    // the theme taken away: the page goes back to Obeya's look
    theme = null;
    board.changed();
    expect(share(c.id)!.outdated).toEqual(['theme']);
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared' && !share(c.id)!.outdated);
    expect(pageOf(c.id)).not.toContain('Content-Security-Policy');
    expect(meta(c.id)).not.toHaveProperty('theme');
  });

  test('a page without a theme stays as it was, and a repository with none marks no page', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(pageOf(c.id)).not.toContain('Content-Security-Policy');
    expect(JSON.parse(board.row(c.id).share!)).not.toHaveProperty('theme');
    expect(share(c.id)!.outdated).toBeUndefined();
  });

  test('the export carries it, as one HTML file and in the ZIP', async () => {
    theme = THEME;
    const c = card('Ohne Ziel');
    const one = new TextDecoder().decode((await sharing.export(c.id, 'html')).data);
    expect(one).toContain(`<style>${THEME.css}</style>`);
    const out = await sharing.export(c.id, 'zip');
    expect(new TextDecoder().decode(out.data)).toContain(`<style>${THEME.css}</style>`);
    const art = card('Ohne Ziel, ein Artefakt', { kind: 'html', chapters: [] });
    writeFileSync(join(dir, `demo-${art.id}`, 'index.html'), '<!doctype html><p>Auswertung</p>');
    expect(new TextDecoder().decode((await sharing.export(art.id, 'html')).data)).toContain(`<style>${THEME.css}</style>`);
  });
});
