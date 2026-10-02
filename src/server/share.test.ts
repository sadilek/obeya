import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** Each call of the fake share command: its arguments and what it got on stdin. */
const calls = () =>
  existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { args: string[]; input: SharePage & { shared: string[] }; home: string })
    : [];

// prints the page's URL, or fails with some output while the file `fail` exists
const FAKE = `
const { appendFileSync, existsSync } = require('node:fs');
const dir = ${'process.argv[2]'};
const args = process.argv.slice(3);
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
  sharing.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function make(holdMs = 30) {
  return new Sharing({
    board,
    runtime,
    home: join(dir, 'home'),
    holdMs,
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
};

const PR = 'https://github.com/acme/app/pull/42';
/** The worker opened the card's pull request, with a description of its own. */
function openPr(id: string, body = 'Exportiert Zählerstände.') {
  bodies.set(PR, body);
  board.work(id, { pr: JSON.stringify({ url: PR, number: 42, seen: [], reported: [] }) });
}

/** A card with a video demo, as a worker hands it over. */
function card(title = 'Zählerstände exportieren', demo: Record<string, unknown> = {}) {
  const c = board.create({ kind: 'feature', title, x: 0, y: 0 });
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
  test('is held for the owner to take back; nothing is published then', async () => {
    const c = card();
    sharing.share(c.id);
    expect(share(c.id)).toEqual({ state: 'pending' });
    sharing.unshare(c.id);
    expect(share(c.id)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(calls()).toEqual([]);
    expect(log(c.id).at(-1)).toBe('Teilen zurückgenommen.');
  });

  test('publishes the page after the hold, keeps its link, and withdraws it', async () => {
    const c = card();
    sharing.share(c.id);
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
    // the page stays up with its link while the new one is held and published
    expect(share(c.id)).toMatchObject({ state: 'pending', url: expect.stringContaining('demos.example') });
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

  test('after a restart, a held share goes on', async () => {
    const c = card();
    sharing.share(c.id);
    sharing.shutdown();
    sharing = make();
    sharing.resume();
    await until(() => share(c.id)?.state === 'shared');
    expect(calls()).toHaveLength(1);
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
    await until(() => share(c.id)?.state === 'publishing');
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
