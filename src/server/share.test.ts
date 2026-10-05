import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { EXPORT_HTML_MAX } from '../core/types';
import type { Forge } from './forge';
import { DEMO_MARKER, type SharePage, Sharing, shareArgv, shareProblem, withDemoLink } from './share';
import { FakeRuntime } from './testing';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let sharing: Sharing;
/** The descriptions of the fake forge's pull requests, and each edit Obeya made. */
let bodies: Map<string, string>;
let edits: string[];
/**
 * Each call of the fake share command: its arguments and what it got on stdin. Only whole lines:
 * the one without its newline yet is still being written.
 */
const calls = () =>
  existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf8')
        .split('\n')
        .slice(0, -1)
        .map((l) => JSON.parse(l) as { args: string[]; input: SharePage & { shared: string[] }; home: string })
    : [];

// prints the page's URL, or fails with some output while the file `fail` exists; `version` is not logged in `calls`
const FAKE = `
const { appendFileSync, existsSync } = require('node:fs');
const dir = ${'process.argv[2]'};
const args = process.argv.slice(3);
// the version of its pages while the file \`version\` holds one, else none
if (args[0] === 'version') { if (existsSync(dir + '/version')) console.log(require('node:fs').readFileSync(dir + '/version', 'utf8')); process.exit(existsSync(dir + '/version') ? 0 : 1); }
const input = JSON.parse(await Bun.stdin.text());
appendFileSync(dir + '/calls', JSON.stringify({ args, input, home: process.env.OBEYA_HOME }) + '\\n');
if (existsSync(dir + '/fail')) { console.error('upload refused: token expired'); process.exit(2); }
console.error('Uploading 3 files');
if (args[0] === 'publish') console.log('https://demos.example/' + input.slug + '/');
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-share-'));
  writeFileSync(join(dir, 'fake-share.ts'), FAKE);
  board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: dir, branch: 'main' }] }, () => []);
  runtime = new FakeRuntime();
  bodies = new Map();
  edits = [];
  sharing = make();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make() {
  return new Sharing({
    board,
    runtime,
    home: join(dir, 'home'),
    forge,
    commandFor: (card) => (card.title.startsWith('Ohne') ? null : { command: [process.execPath, join(dir, 'fake-share.ts'), dir], cwd: dir }),
  });
}

const forge: Forge = {
  status: () => ({}) as never,
  body: (_cwd, url) => {
    const b = bodies.get(url);
    if (b === undefined) throw new Error(`gh pr view: no pull request ${url}`);
    return b;
  },
  setBody: (_cwd, url, body) => {
    bodies.set(url, body);
    edits.push(url);
  },
  merge: () => {},
};

const PR = 'https://github.com/acme/app/pull/42';
/** The worker opened the card's pull request, with a description of its own. */
function openPr(id: string, body = 'Exportiert Zählerstände.') {
  bodies.set(PR, body);
  board.work(id, { pr: JSON.stringify({ url: PR, number: 42, seen: [], reported: [] }) });
}

/** A card with a video demo, as a worker hands it over. */
function card(title = 'Zählerstände exportieren', demo: Record<string, unknown> = {}) {
  const c = board.create({ title, x: 0, y: 0 });
  const d = join(dir, `demo-${c.id}`);
  mkdirSync(d);
  board.work(c.id, {
    state: 'live',
    demo: JSON.stringify({ kind: 'video', dir: d, chapters: [[0, 'Vorher']], shown: [], notShown: [], findings: [], page: { title: 'CSV-Export', text: 'Vermieter laden Zählerstände als CSV.' }, ...demo }),
  });
  return board.item(c.id)!;
}

const share = (id: string) => board.item(id)!.share;
async function until(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
}
const log = (id: string) => board.events(id).map((e) => e.text);

describe('sharing a demo', () => {
  test('publishes the page right away, keeps its link, and withdraws it', async () => {
    const c = card();
    sharing.share(c.id);
    expect(share(c.id)).toEqual({ state: 'publishing' });
    expect(log(c.id).at(-1)).toBe('Teilen: Die Seite geht online.');
    await until(() => share(c.id)?.state === 'shared');
    const slug = 'zahlerstande-exportieren-' + c.id.slice(0, 6);
    expect(share(c.id)).toEqual({ state: 'shared', url: `https://demos.example/${slug}/` });
    const [call] = calls();
    expect(call!.args).toEqual(['publish']);
    expect(call!.input).toEqual({ slug, title: 'CSV-Export', text: 'Vermieter laden Zählerstände als CSV.', chapters: [[0, 'Vorher']], pr: null, dir: join(dir, `demo-${c.id}`), shared: [] });
    expect(call!.home).toBe(join(dir, 'home'));
    // the command's output goes into the card's log
    expect(log(c.id)).toContain('Uploading 3 files');
    expect(log(c.id).at(-1)).toBe(`Geteilt: https://demos.example/${slug}/`);

    sharing.unshare(c.id);
    expect(share(c.id)!.state).toBe('withdrawing');
    await until(() => !share(c.id));
    expect(calls().at(-1)!.args).toEqual(['withdraw', slug]);
    expect(log(c.id).at(-1)).toBe('Die Seite ist zurückgezogen.');
    // shared again, under the same link
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.url).toBe(`https://demos.example/${slug}/`);
  });

  test('a newer demo is not shared on its own: the card says so, and "Neu teilen" replaces the page', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    const newer = join(dir, 'newer');
    mkdirSync(newer);
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [], shown: [], notShown: [], findings: [], page: { title: 'CSV-Export 2', text: 'T.' } }) });
    expect(share(c.id)).toMatchObject({ state: 'shared', stale: true });
    expect(calls()).toHaveLength(1);
    sharing.share(c.id);
    // the page stays up with its link while the new one is published
    expect(share(c.id)).toMatchObject({ state: 'publishing', url: expect.stringContaining('demos.example') });
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.stale).toBeUndefined();
    expect(calls().at(-1)!.input).toMatchObject({ slug: calls()[0]!.input.slug, title: 'CSV-Export 2', dir: newer });
  });

  test('a failed command leaves the card as it was, with the output in its log', async () => {
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

  test('tells the command which other pages it has shared, so a lost site is not deployed', async () => {
    const a = card('A');
    const b = card('B');
    sharing.share(a.id);
    await until(() => share(a.id)?.state === 'shared');
    sharing.share(b.id);
    await until(() => share(b.id)?.state === 'shared');
    expect(calls().at(-1)!.input.shared).toEqual([calls()[0]!.input.slug]);
  });

  test('only video demos, only where the repository shares, never twice at once', () => {
    const html = card('Logo', { kind: 'html' });
    expect(() => sharing.share(html.id)).toThrow(BadRequest);
    const none = card('Ohne Teilen');
    expect(() => sharing.share(none.id)).toThrow(BadRequest);
    const c = card();
    sharing.share(c.id);
    expect(() => sharing.share(c.id)).toThrow(BadRequest);
    expect(() => sharing.unshare(card('X').id)).toThrow(BadRequest);
  });

  test('a demo from before pages were written gets its text from a short session over the summary', async () => {
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
    expect(calls()[0]!.input).toMatchObject({ title: 'Zählerstände als CSV', text: 'Vermieter laden Zählerstände als CSV herunter.' });
    // kept with the demo: the next share needs no session
    expect(board.item(c.id)!.demo!.page).toEqual({ title: 'Zählerstände als CSV', text: 'Vermieter laden Zählerstände als CSV herunter.' });
  });

  test('after a restart, a share under way goes on, one held as shares were before too', async () => {
    const a = card('A');
    const b = card('B');
    board.work(a.id, { share: JSON.stringify({ slug: 'a', state: 'publishing' }) });
    board.work(b.id, { share: JSON.stringify({ slug: 'b', state: 'pending' }) });
    sharing.resume();
    await until(() => share(a.id)?.state === 'shared' && share(b.id)?.state === 'shared');
    expect(calls().map((c) => c.input.slug).sort()).toEqual(['a', 'b']);
  });
});

describe('a page published with an earlier version of the command', () => {
  const version = (v: string | null) => (v ? writeFileSync(join(dir, 'version'), v) : rmSync(join(dir, 'version'), { force: true }));
  const stored = (id: string) => JSON.parse(board.row(id).share!) as { version?: string; outdated?: true };

  test('is offered to share again once the command writes its pages differently, and "Erneut teilen" brings it up to date', async () => {
    version('v1');
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(stored(c.id).version).toBe('v1');
    await sharing.checkVersions();
    expect(share(c.id)!.outdated).toBeUndefined();

    version('v2');
    await sharing.checkVersions();
    expect(share(c.id)).toEqual({ state: 'shared', url: expect.stringContaining('demos.example'), outdated: true });
    expect(calls()).toHaveLength(1);
    sharing.share(c.id);
    expect(log(c.id).at(-1)).toBe('Erneut teilen: Die Seite wird mit dem neuen Stand erzeugt.');
    expect(share(c.id)).toMatchObject({ state: 'publishing', url: expect.stringContaining('demos.example') });
    await until(() => share(c.id)?.state === 'shared');
    expect(share(c.id)!.outdated).toBeUndefined();
    expect(stored(c.id).version).toBe('v2');
    expect(calls().at(-1)!.input).toMatchObject({ slug: calls()[0]!.input.slug, dir: join(dir, `demo-${c.id}`) });
  });

  test('a page shared before commands said their version counts as earlier; without one nothing is marked', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(stored(c.id).version).toBeUndefined();
    await sharing.checkVersions();
    expect(share(c.id)!.outdated).toBeUndefined();
    version('v1');
    await sharing.checkVersions();
    expect(share(c.id)!.outdated).toBe(true);
    // the command no longer says one: nothing to compare with
    version(null);
    await sharing.checkVersions();
    expect(share(c.id)!.outdated).toBeUndefined();
  });

  test('a newer demo is "Neu teilen", not "Erneut teilen"', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    version('v1');
    await sharing.checkVersions();
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: join(dir, 'newer'), chapters: [], shown: [], notShown: [], findings: [], page: { title: 'T', text: 'T.' } }) });
    expect(share(c.id)).toMatchObject({ stale: true });
    expect(share(c.id)!.outdated).toBeUndefined();
  });

  test('each page is brought up to date on its own: sharing one again leaves the others marked', async () => {
    version('v1');
    const a = card('A');
    const b = card('B');
    for (const c of [a, b]) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
    }
    version('v2');
    await sharing.checkVersions();
    sharing.share(a.id);
    await until(() => share(a.id)?.state === 'shared' && !share(a.id)!.outdated);
    expect(share(b.id)!.outdated).toBe(true);
    expect(stored(b.id).version).toBe('v1');
  });

  test('a version that changes while nobody looks is marked after the next call of the command', async () => {
    version('v1');
    const a = card('A');
    const b = card('B');
    for (const c of [a, b]) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
    }
    version('v2');
    sharing.unshare(b.id);
    await until(() => !share(b.id));
    expect(share(a.id)!.outdated).toBe(true);
  });

  test('marked after a restart', async () => {
    version('v2');
    const c = card();
    board.work(c.id, { share: JSON.stringify({ slug: 's', url: 'https://demos.example/s/', dir: join(dir, `demo-${c.id}`), version: 'v1' }) });
    sharing.resume();
    await until(() => !!share(c.id)?.outdated);
  });
});

describe('sharing many outdated pages again at once', () => {
  const version = (v: string) => writeFileSync(join(dir, 'version'), v);
  const reshare = () => board.snapshot().reshare;
  /** Cards shared with v1 whose demos were rendered `ages` minutes ago, then outdated by v2. */
  async function outdated(...ages: number[]) {
    version('v1');
    const cards = ages.map((age, n) => {
      const c = card(`Demo ${n}`);
      const video = join(dir, `demo-${c.id}`, 'demo.mp4');
      writeFileSync(video, 'video');
      const t = new Date(Date.now() - age * 60_000);
      utimesSync(video, t, t);
      return c;
    });
    for (const c of cards) {
      sharing.share(c.id);
      await until(() => share(c.id)?.state === 'shared');
    }
    version('v2');
    await sharing.checkVersions();
    return cards;
  }

  test('shares the newest again, one after the other, and says how far it got', async () => {
    const [old, newest, middle] = await outdated(30, 1, 10);
    expect(reshare()).toEqual({ outdated: 3 });
    const before = calls().length;
    sharing.reshareMany(2);
    expect(reshare()).toMatchObject({ outdated: 1, run: { total: 2, done: 0, left: 2, failed: [] } });
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 1, run: { total: 2, done: 2, failed: [], left: 0 } });
    const slug = (id: string) => (JSON.parse(board.row(id).share!) as { slug: string }).slug;
    expect(calls().slice(before).map((c) => c.input.slug)).toEqual([slug(newest!.id), slug(middle!.id)]);
    for (const c of [newest!, middle!]) {
      expect(share(c.id)!.outdated).toBeUndefined();
      expect(log(c.id)).toContain('Erneut teilen, mit anderen geteilten Demos: Die Seite wird mit dem neuen Stand erzeugt.');
      expect(log(c.id).at(-1)).toBe(`Erneut geteilt: ${share(c.id)!.url}`);
    }
    expect(share(old!.id)!.outdated).toBe(true);
    // the result stays until the owner puts it away
    sharing.dismissResharing();
    expect(reshare()).toEqual({ outdated: 1 });
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()).toEqual({ outdated: 0, run: { total: 1, done: 1, failed: [], left: 0 } });
    expect(() => sharing.reshareMany(null)).toThrow(BadRequest);
  });

  test('a page that fails stays outdated, with the reason in its log, and the rest go on', async () => {
    const [a, b] = await outdated(2, 1);
    writeFileSync(join(dir, 'fail'), '');
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(reshare()!.run).toEqual({ total: 2, done: 0, failed: [b, a].map((c) => ({ id: c!.id, title: c!.title })), left: 0 });
    expect(share(a!.id)).toMatchObject({ state: 'shared', outdated: true });
    expect(log(a!.id).at(-1)).toStartWith('Nicht erneut geteilt: Der Befehl zum Teilen ist gescheitert (Exit-Code 2).');
    expect(reshare()!.outdated).toBe(2);
  });

  test('one run at a time; stopped before a page went out, all stay as they were', async () => {
    await outdated(2, 1);
    const before = calls().length;
    sharing.reshareMany(null);
    expect(() => sharing.reshareMany(null)).toThrow(BadRequest);
    expect(() => sharing.dismissResharing()).toThrow(BadRequest);
    sharing.stopResharing();
    await new Promise((r) => setTimeout(r, 50));
    expect(reshare()).toEqual({ outdated: 2, run: { total: 2, done: 0, failed: [], left: 0, stopped: true } });
    expect(calls()).toHaveLength(before);
  });

  test('a card with a newer demo gets its page as it shows, the newer demo still waits for "Neu teilen"', async () => {
    const [c] = await outdated(1);
    const shown = join(dir, `demo-${c!.id}`);
    board.work(c!.id, { demo: JSON.stringify({ kind: 'video', dir: join(dir, 'newer'), chapters: [], shown: [], notShown: [], findings: [], page: { title: 'Neu', text: 'Neu.' } }) });
    expect(reshare()).toEqual({ outdated: 1 });
    sharing.reshareMany(null);
    await until(() => reshare()?.run?.left === 0);
    expect(calls().at(-1)!.input).toMatchObject({ dir: shown, title: 'CSV-Export' });
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
});

describe('the link in the pull request', () => {
  test('a page shared before the PR is published again with its link, and the description links the page', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(calls()[0]!.input.pr).toBeNull();
    openPr(c.id);
    sharing.prOpened(c.id);
    // the card goes on showing the page while it goes out again
    expect(share(c.id)).toMatchObject({ state: 'shared', url: expect.stringContaining('demos.example') });
    await until(() => calls().length === 2);
    await until(() => edits.length === 1);
    const url = share(c.id)!.url!;
    expect(calls()[1]!.input).toMatchObject({ slug: calls()[0]!.input.slug, title: 'CSV-Export', pr: PR });
    expect(bodies.get(PR)).toBe(`Exportiert Zählerstände.\n\nDemo-Video: ${url} ${DEMO_MARKER}\n`);
    expect(log(c.id)).toContain(`Die geteilte Seite verlinkt jetzt den Pull Request: ${url}`);
    expect(log(c.id).at(-1)).toBe('Den Link zur Demo in die Beschreibung von Pull Request #42 eingetragen.');
    // once: the PR is linked, and the description is not touched again
    sharing.prOpened(c.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toHaveLength(2);
    expect(edits).toHaveLength(1);
  });

  test('a page shared after the PR links it at once; a description that links the page already stays', async () => {
    const c = card();
    openPr(c.id, 'Exportiert Zählerstände.\n\nDemo: https://demos.example/zahlerstande-exportieren-' + c.id.slice(0, 6) + '/');
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.input.pr).toBe(PR);
    expect(edits).toEqual([]);
  });

  test('a PR opened while the page goes out gets a second round with its link', async () => {
    const c = card();
    sharing.share(c.id);
    // the command is running
    await until(() => calls().length === 1);
    openPr(c.id);
    sharing.prOpened(c.id);
    await until(() => calls().length === 2 && edits.length === 1);
    expect(calls().map((x) => x.input.pr)).toEqual([null, PR]);
  });

  test('a newer demo on the card is not put out with the link: the page goes out again as it is', async () => {
    const c = card();
    sharing.share(c.id);
    await until(() => share(c.id)?.state === 'shared');
    const newer = join(dir, 'newer');
    mkdirSync(newer);
    board.work(c.id, { demo: JSON.stringify({ kind: 'video', dir: newer, chapters: [[0, 'Neu']], shown: [], notShown: [], findings: [], page: { title: 'CSV-Export 2', text: 'T.' } }) });
    openPr(c.id);
    sharing.prOpened(c.id);
    await until(() => calls().length === 2);
    expect(calls()[1]!.input).toMatchObject({ title: 'CSV-Export', chapters: [[0, 'Vorher']], dir: join(dir, `demo-${c.id}`), pr: PR });
    await until(() => edits.length === 1);
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
  });
});

describe('exporting a demo, where the repository has no share target', () => {
  /** A demo directory as the demo skill leaves it. */
  function files(c: { id: string }, video = 'MP4DATA') {
    const d = join(dir, `demo-${c.id}`);
    writeFileSync(join(d, 'demo.mp4'), video);
    writeFileSync(join(d, 'poster.jpg'), 'JPEG');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.500\nDer Export </script> beginnt.\n');
  }

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

  test('only video demos', async () => {
    const html = card('Logo', { kind: 'html' });
    await expect(sharing.export(html.id, 'zip')).rejects.toMatchObject({ code: 'noShare' });
    // a video demo whose file is gone
    await expect(sharing.export(card('Weg').id, 'zip')).rejects.toMatchObject({ code: 'noShare' });
  });
});

describe('a share command from the configuration', () => {
  test('is split into words, its program found in the repository, a script run with Bun', () => {
    expect(shareArgv('scripts/share.sh --site "Unsere Demos"', '/repo')).toEqual(['/repo/scripts/share.sh', '--site', 'Unsere Demos']);
    expect(shareArgv('share.ts', '/repo')).toEqual([process.execPath, '/repo/share.ts']);
    expect(shareArgv('~/bin/share', '/repo')).toEqual([join(homedir(), 'bin/share')]);
    expect(shareArgv("rclone-share 'a b'", '/repo')).toEqual(['rclone-share', 'a b']);
    expect(shareArgv('', '/repo')).toEqual([]);
    expect(shareProblem(['git'])).toBeNull();
    expect(shareProblem(['/nowhere/share'])).toContain('does not exist');
    expect(shareProblem([process.execPath, '/nowhere/share.ts'])).toContain('does not exist');
    expect(shareProblem([])).toContain('empty');
  });
});
