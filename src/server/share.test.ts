import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { type SharePage, Sharing } from './share';
import { FakeRuntime } from './testing';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let sharing: Sharing;
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
    commandFor: (card) => (card.title.startsWith('Ohne') ? null : { command: [process.execPath, join(dir, 'fake-share.ts'), dir], cwd: dir }),
  });
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
