import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import type { Session } from './commands';
import { Store } from './db';
import { type History, writeHistory } from './fixtures/history';
import { cpuTime, FakeRuntime, gitRepo, heard, noForge, removeDir } from './testing';

// The server's rounds that ran into its history: with every change of the canvas, every command to
// the Koordinator and every pass over the shared pages, they read whole tables, and the history
// grows with each day Obeya is used. Over a history ten times as long as the owner's Obeya had on
// 9 November 2026 (1.6 million events over 400 days, 9,000 archived cards on the canvas, 4,500 of
// them with a shared page, 10,000 exchanges with the Koordinator), each round costs about what it
// costs on a canvas with the same cards on it and no history at all: a rebuild of that canvas's
// view after a change to one card is the unit each round's budget is given in. Before the rounds
// read by index and kept what they read, the history cost the brief and the learner over a second
// each, and a pass over the shared pages a dozen of those units.

/** The history's length, in multiples of the owner's on 9 November 2026. */
const SCALE = 10;

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
  // a site nobody answers at: asking it which pages are gone finds none
  const site = { title: 'Demos', url: 'http://127.0.0.1:9/', deploy: 'true {dir}' };
  const repo = gitRepo(join(dir, 'app'), {
    'docs/plan/plan.md': '# App\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** One.\n- [ ] **W2:** Two.\n',
    '.obeya/settings.json': JSON.stringify({ demo: { site } }),
  });
  const store = new Store(join(dir, 'obeya.db'));
  store.trustCommands(repo, { site: { url: site.url, deploy: site.deploy } });
  const canvas = await CanvasRuntime.start({ name: 'App', repos: [{ path: repo, clones: 2 }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge });
  const history = writeHistory(store, canvas.board.canvas.id, dir, scale);
  const board = canvas.board;
  // the Koordinator waits on a card for a step, and a card is snoozed until another one is done
  const talk = store.addTalk(board.canvas.id, 'Tell me once it is done.', 'I will.', null);
  store.waitTalk(talk, [{ card: history.onCanvas[0]!, title: 'Card', state: 'done', then: 'tell the owner' }]);
  board.work(history.onCanvas[1]!, { snoozed: JSON.stringify({ by: 'owner', on: { card: history.onCanvas[2]!, state: 'done' } }) });
  // the server sends each change to the pages that show the canvas
  board.onChange(() => JSON.stringify(board.snapshot()));
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

test('the snoozed cards and the steps the Koordinator waits to take are looked at (every change, and each minute)', async () => {
  expect(await inUnits(() => long.canvas.wakeDue())).toBeLessThan(0.25);
});

test('the Koordinator’s brief for a command: its first in a session, with the history of the last days, and one later', async () => {
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
  const around = () => long.canvas.koordinator['around'](null, 'talk', 'Start it.', {});
  expect(around().join('\n')).toContain('What the owner said in the last');
  expect(await inUnits(around)).toBeLessThan(1);
});


