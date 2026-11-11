import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasRuntime } from './canvas';
import type { Session } from './commands';
import type { Store } from './db';
import { appCanvas, type History, writeHistory } from './fixtures/history';
import { cpuTime, heard, removeDir } from './testing';

// The server's rounds that ran into its history: with every change of the canvas, every command to
// the Coordinator and every pass over the shared pages, they read whole tables, and the history
// grows with each day Obeya is used. Over a history ten times as long as the owner's Obeya had on
// 9 November 2026 (1.6 million events over 400 days, 9,000 archived cards on the canvas, 4,500 of
// them with a shared page, 10,000 exchanges with the Coordinator), each round costs about what it
// costs on a canvas with the same cards on it and no history at all: a rebuild of that canvas's
// view after a change to one card is the unit each round's budget is given in. Before the rounds
// read by index and kept what they read, the history cost the brief and the learner over a second
// each, and a pass over the shared pages a dozen of those units.

/** The history's length, in multiples of the owner's on 9 November 2026. */
const SCALE = 10;
/** The archived cards a page of the archive brings as the owner scrolls. */
const ARCHIVE_PAGE = 50;

interface Setup {
  dir: string;
  store: Store;
  canvas: CanvasRuntime;
  history: History;
}

let long: Setup;
let fresh: Setup;

async function setup(scale: number): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-long-history-'));
  const { store, canvas } = await appCanvas(dir);
  const history = writeHistory(store, canvas.board.canvas.id, dir, scale);
  const board = canvas.board;
  // the Coordinator waits on a card for a step, and a card is snoozed until another one is done
  const talk = store.addTalk(board.canvas.id, 'Tell me once it is done.', 'I will.', null);
  store.waitTalk(talk, [{ card: history.onCanvas[0]!, title: 'Card', state: 'done', then: 'tell the owner' }]);
  board.work(history.onCanvas[1]!, { snoozed: JSON.stringify({ by: 'owner', on: { card: history.onCanvas[2]!, state: 'done' } }) });
  board.changed();
  await heard();
  return { dir, store, canvas, history };
}

beforeAll(async () => {
  fresh = await setup(0);
  long = await setup(SCALE);
  // writing a long history takes seconds, more on a busy machine
}, 300_000);

afterAll(async () => {
  for (const s of [fresh, long]) {
    s?.canvas.shutdown();
    // Windows removes no file that is open
    s?.store.db.close();
    if (s) await removeDir(s.dir);
  }
});

let n = 0;

/** A change to one card on the canvas, and the rebuild of the canvas view the server sends its pages. */
const rebuild = (s: Setup) => async () => {
  s.canvas.board.work(s.history.onCanvas[3 + (n++ % 100)]!, { status_line: `Working ${n}` });
  await heard();
};

/**
 * The round's cost on the long history in units of a rebuild of the canvas view without history:
 * the two by turns, so that both meet the machine as busy; a noisy measurement only makes one cost
 * more, so the fastest of each counts.
 */
async function inUnits(round: () => unknown): Promise<number> {
  const units: number[] = [];
  const rounds: number[] = [];
  for (let k = 0; k < 5; k++) {
    units.push(await cpuTime(rebuild(fresh)));
    rounds.push(await cpuTime(round));
  }
  const ratio = Math.min(...rounds) / Math.min(...units);
  // OBEYA_SHOW_UNITS=1 prints what each round cost
  if (process.env.OBEYA_SHOW_UNITS) console.log(`${ratio.toFixed(2)} units of ${Math.min(...units).toFixed(2)} ms`);
  return ratio;
}

test('a change to a card on the canvas: the canvas view is rebuilt (each change, the first listener: the count of agents)', async () => {
  expect(await inUnits(rebuild(long))).toBeLessThan(3);
});

test('a change to a shared card: the notice of outdated pages is made anew with the canvas view', async () => {
  const shared = long.history.shared.filter((id) => long.history.onCanvas.includes(id));
  expect(shared.length).toBeGreaterThan(10);
  expect(
    await inUnits(async () => {
      long.canvas.board.work(shared[n++ % shared.length]!, { title: `Renamed ${n}` });
      await heard();
    }),
  ).toBeLessThan(8);
  expect(long.canvas.board.snapshot().reshare!.outdated).toBeGreaterThan(4000);
});

test('asking the sites which shared pages are gone, after a change', async () => {
  expect(
    await inUnits(async () => {
      await rebuild(long)();
      await long.canvas.sharing.checkSites();
    }),
  ).toBeLessThan(10);
});

test('the snoozed cards and the steps the Coordinator waits to take are looked at (every change, and each minute)', async () => {
  expect(await inUnits(() => long.canvas.wakeDue())).toBeLessThan(0.25);
});

test('the Coordinator’s brief for a command: its first in a session, with the history of the last days, and one later', async () => {
  const brief = (s: Pick<Session, 'read' | 'since' | 'rules'>) => long.canvas.commander['brief'](s as Session, 'What happened today?', {}, { typed: true });
  const first = brief({ read: 0, rules: [] });
  expect(first).toContain('What happened on the canvas in the last');
  // of the steps read, those of cards still on the canvas
  expect(first.split('\n').filter((l) => / "Card \d+": /.test(l)).length).toBeGreaterThan(5);
  expect(await inUnits(() => brief({ read: 0, rules: [] }))).toBeLessThan(2);
  const since = long.canvas.board.mark();
  expect(await inUnits(() => brief({ read: 1, since, rules: [] }))).toBeLessThan(2);
});

test('what the learner reads around an input of the owner’s: what they said in the last days', async () => {
  const around = () => long.canvas.coordinator['around'](null, 'talk', 'Start it.', {});
  expect(around().join('\n')).toContain('What the owner said in the last');
  expect(await inUnits(around)).toBeLessThan(1);
});

test('the archive opened and scrolled: a page of its cards, at its start and far down', async () => {
  const board = long.canvas.board;
  const first = board.archivePage(ARCHIVE_PAGE);
  expect(first.items.map((i) => i.id)).toEqual(long.history.archived.slice(0, ARCHIVE_PAGE));
  // the page the owner scrolled to after thousands of cards
  const r = long.store.card(long.history.archived[8000]!)!;
  const far = JSON.stringify([r.archived_at, r.created_at, r.id]);
  expect(board.archivePage(ARCHIVE_PAGE, far).items.map((i) => i.id)).toEqual(long.history.archived.slice(8001, 8001 + ARCHIVE_PAGE));
  expect(await inUnits(() => board.archivePage(ARCHIVE_PAGE))).toBeLessThan(3);
  expect(await inUnits(() => board.archivePage(ARCHIVE_PAGE, far))).toBeLessThan(3);
});

test('a search through the archive: the first reads it a slice at a time, the server free in between; the next only searches', async () => {
  const board = long.canvas.board;
  const units: number[] = [];
  for (let k = 0; k < 5; k++) units.push(await cpuTime(rebuild(fresh)));
  const unit = Math.min(...units);
  // each slice: a page of the archive's rows, and what the search reads of their cards
  const slices: number[] = [];
  const store = long.store;
  const page = store.archivePage.bind(store);
  const read = spyOn(store, 'archivePage').mockImplementation((...a) => {
    const at = performance.now();
    const rows = page(...a);
    slices.push(performance.now() - at);
    return rows;
  });
  const entries = board['indexEntries'].bind(board);
  const built = spyOn(board as unknown as { indexEntries: typeof entries }, 'indexEntries').mockImplementation((rows) => {
    const at = performance.now();
    const out = entries(rows);
    slices[slices.length - 1]! += performance.now() - at;
    return out;
  });
  let between = 0;
  let ready = false;
  const search = board.archiveSearch('card 1234', { count: ARCHIVE_PAGE }).finally(() => (ready = true));
  // what else waits for the server gets its turn between two slices
  while (!ready) {
    await new Promise((r) => setImmediate(r));
    between++;
  }
  read.mockRestore();
  built.mockRestore();
  expect((await search).items.map((i) => i.title)).toEqual(['Card 1234']);
  expect(slices.length).toBeGreaterThan(50);
  expect(between).toBeGreaterThanOrEqual(slices.length - 1);
  // a slow moment of the machine makes one slice cost more: the typical one counts
  const typical = slices.sort((a, b) => a - b)[slices.length >> 1]! / unit;
  if (process.env.OBEYA_SHOW_UNITS) console.log(`${slices.length} slices, typically ${typical.toFixed(2)} units`);
  expect(typical).toBeLessThan(3);
  const words = ['card 9', 'cards few sentences owner'];
  expect(await inUnits(() => board.archiveSearch(words[n++ % 2]!, { count: ARCHIVE_PAGE }))).toBeLessThan(5);
  expect(await inUnits(() => board.archiveSearch('card 12', { count: 30, everywhere: true }))).toBeLessThan(5);
});
