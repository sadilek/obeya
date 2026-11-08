import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime, gitRepo, heard, noForge, removeDir } from './testing';

// A canvas the size of a long-used one: hundreds of archived cards, a few hundred of them with a
// shared page on its repository's site, a hundred on the canvas, ideas with hundreds of prototypes.
// Many cards landing one after the other change it dozens of times in a row, and sharing a demo or
// asking the site which pages another machine withdrew looks up every shared card; the server
// answers nothing while that runs.

let dir: string;
let canvas: CanvasRuntime;
let store: Store;
let onCanvas: string[];
let archived: string[];
let ideas: string[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-board-size-'));
  // a site nobody answers at: asking it which pages are gone finds none
  const site = { title: 'Demos', url: 'http://127.0.0.1:9/', deploy: 'true {dir}' };
  const repo = gitRepo(join(dir, 'app'), {
    'docs/plan/plan.md': '# App\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** One.\n- [ ] **W2:** Two.\n',
    '.obeya/settings.json': JSON.stringify({ demo: { site } }),
  });
  store = new Store(join(dir, 'obeya.db'));
  store.trustCommands(repo, { site: { url: site.url, deploy: site.deploy } });
  canvas = await CanvasRuntime.start({ name: 'App', repos: [{ path: repo, clones: 2 }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge });
  const c = canvas.board.canvas.id;
  const body = 'What the card asks for, in a few sentences, as the owner wrote it. '.repeat(6);
  const rows = store.insert(Array.from({ length: 900 }, (_, n) => ({ canvas_id: c, kind: 'task' as const, state: 'live' as const, title: `Card ${n}`, body, x: (n % 30) * 400, y: Math.floor(n / 30) * 300 })));
  rows.forEach((r, n) => {
    const demo = join(dir, 'demos', r.id);
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, 'demo.mp4'), 'video');
    if (n % 2) writeFileSync(join(demo, 'poster.jpg'), 'poster');
    const shown = { kind: 'video' as const, chapters: [[0, 'Before'], [20, 'After']], page: { title: `Card ${n}`, text: body } };
    store.update(r.id, {
      demo: JSON.stringify({ dir: demo, ...shown }),
      ...(n < 800 ? { archived_at: new Date(Date.now() - n * 60_000).toISOString() } : {}),
      // a page published before the newest page changes: the Koordinator's sheet offers to share it again
      ...(n % 3 === 0 ? { share: JSON.stringify({ slug: `card-${n}`, url: `http://127.0.0.1:9/card-${n}/`, demos: [{ dir: demo, shown }], version: '' }) } : {}),
    });
  });
  archived = rows.slice(0, 800).map((r) => r.id);
  onCanvas = rows.slice(800).map((r) => r.id);
  // ideas tried out in prototypes, most of them in the archive by now with their prototypes, many of those shared
  const idea = store.insert(Array.from({ length: 80 }, (_, n) => ({ canvas_id: c, kind: 'task' as const, state: 'idea' as const, title: `Idea ${n}`, body, x: n * 400, y: 9000 })));
  ideas = idea.map((r) => r.id);
  const prototypes = store.insert(idea.flatMap((r, n) => Array.from({ length: 4 }, (_, v) => ({ canvas_id: c, kind: 'task' as const, state: 'live' as const, title: `Idea ${n}, variant ${v}`, body, x: n * 400 + v * 100, y: 9300, from_id: r.id, prototype_of: r.id }))));
  prototypes.forEach((r, n) => {
    const demo = join(dir, 'demos', r.id);
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, 'demo.mp4'), 'video');
    const shown = { kind: 'video' as const, chapters: [[0, 'Variant']], page: { title: r.title, text: body } };
    store.update(r.id, {
      demo: JSON.stringify({ dir: demo, ...shown }),
      ...(n < 280 ? { archived_at: new Date(Date.now() - n * 60_000).toISOString() } : {}),
      ...(n % 2 === 0 ? { share: JSON.stringify({ slug: `prototype-${n}`, url: `http://127.0.0.1:9/prototype-${n}/`, demos: [{ dir: demo, shown }], version: '' }) } : {}),
    });
  });
  idea.slice(0, 70).forEach((r, n) => store.update(r.id, { archived_at: new Date(Date.now() - n * 60_000).toISOString() }));
  // the server sends each change to the pages that show the canvas
  canvas.board.onChange(() => JSON.stringify(canvas.board.snapshot()));
  canvas.board.changed();
  // over a thousand cards and their demo folders take more than the default 5 s on a busy machine
}, 30_000);

/**
 * Windows counts a thread's CPU time in ticks of about 15.6 ms, coarser than a read of the cards;
 * the clock's time counted the waits for a core with it, which a busy runner made the larger part
 * of a run's cost or a rebuild's, by turns. The CPU cycles the thread ran are exact there, and
 * only their ratios count.
 */
const cycles = (() => {
  if (process.platform !== 'win32') return null;
  const { symbols } = dlopen('kernel32.dll', { QueryThreadCycleTime: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 } });
  const out = new BigUint64Array(1);
  // GetCurrentThread's handle, which stands for the calling thread
  return () => (symbols.QueryThreadCycleTime(-2n, ptr(out)), Number(out[0]));
})();

// What a run costs is measured against a rebuild of the canvas view on the same machine, in the
// CPU time of the thread that runs the server's code: on a CI runner the same run counts four to
// eight times the CPU time it counts on a laptop, more with other test files beside it
// (`bun test --parallel`), and the time on the clock also waits for a core. A noisy measurement
// only makes a run cost more, so the fastest of three rounds counts.
async function cpuTime(run: () => Promise<void>): Promise<number> {
  await heard();
  if (cycles) {
    const start = cycles();
    await run();
    return cycles() - start;
  }
  const start = process.threadCpuUsage();
  await run();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** A rebuild of the canvas view as the server sends it to its pages after a change, the median of five. */
async function rebuildTime(): Promise<number> {
  const times: number[] = [];
  for (let n = 0; n < 5; n++)
    times.push(await cpuTime(async () => {
      canvas.board.changed();
      JSON.stringify(canvas.board.snapshot());
    }));
  return times.sort((a, b) => a - b)[2]!;
}

afterAll(async () => {
  canvas.shutdown();
  // Windows removes no file that is open
  store.db.close();
  await removeDir(dir);
});

test('a canvas with hundreds of archived and shared cards: a run of changes costs a few rebuilds of the canvas view, not one per write', async () => {
  const board = canvas.board;
  const rebuild = await rebuildTime();
  const rounds: number[] = [];
  for (let round = 0; round < 3; round++) {
    rounds.push(await cpuTime(async () => {
      // a landing: each card moves on, says so, and is read back between the writes, as the workers do
      for (const id of onCanvas.slice(round * 30, round * 30 + 30)) {
        board.work(id, { status_line: `Landing ${round}` });
        board.item(id);
        board.log(id, 'state', 'obeya', 'Landed on main.');
        board.item(id);
        board.work(id, { landed: JSON.stringify({}) });
        // its page is looked up among the archived ones
        board.card(archived[(round * 30 + onCanvas.indexOf(id)) % archived.length]!);
      }
      // what listens to the board hears of it once the run is through
      await heard();
    }));
  }
  // 90 writes: about thirty rebuilds' worth; with the listeners rebuilding the view after each write, over a hundred
  expect(Math.min(...rounds) / rebuild).toBeLessThan(60);
});

test('sharing looks up every shared card, archived ones with their prototypes, after a change for the cost of a few rebuilds of the canvas view', async () => {
  const board = canvas.board;
  const shared = board.sharedRows().map((r) => r.id);
  expect(shared.length).toBeGreaterThan(400);
  const rebuild = await rebuildTime();
  const rounds: number[] = [];
  for (let round = 0; round < 3; round++) {
    rounds.push(await cpuTime(async () => {
      // a landing shares its demo: the board changed, and the pass over the shared pages looks up each card
      board.work(onCanvas[round]!, { status_line: `Sharing ${round}` });
      expect(shared.filter((id) => board.card(id)).length).toBe(shared.length);
      await heard();
    }));
  }
  // about five rebuilds' worth: a lookup per card that built the archive or its prototypes anew costs one each, hundreds
  expect(Math.min(...rounds) / rebuild).toBeLessThan(15);
});

test('asking the site which shared pages are gone builds the shared cards once, not each on its own, for the cost of a few rebuilds of the canvas view', async () => {
  const board = canvas.board;
  const rebuild = await rebuildTime();
  const rounds: number[] = [];
  for (let round = 0; round < 3; round++) {
    rounds.push(await cpuTime(async () => {
      // as after a start or a share: the board changed since the last pass
      board.work(onCanvas[round]!, { status_line: `Checking ${round}` });
      await canvas.sharing.checkSites();
    }));
  }
  // about three rebuilds' worth; looking up each card on its own, and again for each question asked of it, costs over fifteen
  expect(Math.min(...rounds) / rebuild).toBeLessThan(8);
});

test('an archived card looked up on its own is the card the archive lists, with its prototypes', () => {
  const board = canvas.board;
  board.changed();
  const idea = ideas[3]!;
  const prototype = store.prototypes(board.canvas.id).find((r) => r.prototype_of === idea)!.id;
  const alone = [board.card(idea), board.card(prototype)];
  expect(alone[0]!.prototypes!.map((p) => p.title)).toEqual([0, 1, 2, 3].map((v) => `Idea 3, variant ${v}`));
  expect(alone[1]!.ideaTitle).toBe('Idea 3');
  const archive = board.archived();
  expect(alone).toEqual([archive.find((i) => i.id === idea), archive.find((i) => i.id === prototype)]);
});

test('a rebuild of the canvas view reads the shared cards again only after one changed, and never looks at their demos’ files', async () => {
  const board = canvas.board;
  const shared = new Set(board.sharedRows().map((r) => r.id));
  // the archived cards' pages, outdated by the newest page changes: only the notice of outdated pages looks at them
  const files = new Set(archived.filter((id) => shared.has(id)).map((id) => join(dir, 'demos', id, 'demo.mp4')));
  board.changed();
  expect(board.snapshot().reshare!.outdated).toBeGreaterThan(400);
  await board.lookAtDemos();
  const looked = spyOn(fs, 'existsSync');
  const read = spyOn(store, 'shared');
  const lookedAtPages = () => looked.mock.calls.filter(([path]) => files.has(String(path))).length;
  try {
    // a card without a page moves on, and something else changes
    const plain = onCanvas.find((id) => !shared.has(id))!;
    board.work(plain, { status_line: 'Working' });
    board.snapshot();
    board.changed();
    board.snapshot();
    expect(read).not.toHaveBeenCalled();
    expect(lookedAtPages()).toBe(0);
    // a shared card renamed: the notice is made anew, from the files as last looked at
    board.work(onCanvas.find((id) => shared.has(id))!, { title: 'Renamed' });
    expect(board.snapshot().reshare!.outdated).toBeGreaterThan(400);
    expect(read).toHaveBeenCalledTimes(1);
    expect(lookedAtPages()).toBe(0);
  } finally {
    looked.mockRestore();
    read.mockRestore();
  }
});

test('the shared cards built at once are those looked up one by one, archived ones and prototypes too', () => {
  const board = canvas.board;
  board.changed();
  const rows = board.sharedRows();
  const once = board.cards(rows);
  board.changed();
  expect(rows.map((r) => once.get(r.id))).toEqual(rows.map((r) => board.card(r.id)));
  expect(once.size).toBe(rows.length);
});

test('a rebuild of the canvas view after a change to one card reads the canvas’s cards once, and the archive not at all', () => {
  const board = canvas.board;
  board.changed();
  board.snapshot();
  const reads = [spyOn(store, 'cards'), spyOn(store, 'projects'), spyOn(store, 'withPlanDocs'), spyOn(store, 'archivedPlans'), spyOn(store, 'archived')];
  try {
    board.work(onCanvas[5]!, { status_line: 'Working' });
    const first = board.snapshot();
    expect(reads.map((r) => r.mock.calls.length)).toEqual([1, 0, 0, 0, 0]);
    // a card archived: the archive's projects and cards with plan docs are read again, once
    board.work(onCanvas[6]!, { archived_at: new Date().toISOString() });
    const second = board.snapshot();
    expect(second.archive).not.toBe(first.archive);
    expect(reads.map((r) => r.mock.calls.length)).toEqual([2, 0, 0, 1, 0]);
  } finally {
    for (const r of reads) r.mockRestore();
    board.work(onCanvas[6]!, { archived_at: null });
  }
});

test('a rebuild of the canvas view costs about as much as reading the canvas’s cards a few times', async () => {
  // a read and a rebuild by turns, so that both meet the machine as busy; a single read is over too
  // quickly for a median, and noise only adds: the fastest of each counts
  const reads: number[] = [];
  const rebuilds: number[] = [];
  for (let n = 0; n < 10; n++) {
    reads.push(await cpuTime(async () => void store.cards(canvas.board.canvas.id)));
    rebuilds.push(await cpuTime(async () => {
      canvas.board.changed();
      JSON.stringify(canvas.board.snapshot());
    }));
  }
  // three to five reads' worth; going over the archive for its revision and reading the cards and projects again for each part of the view cost seven or eight
  // on Windows the view's look for each demo's files costs several times as much: six to eleven reads' worth there
  expect(Math.min(...rebuilds) / Math.min(...reads)).toBeLessThan(process.platform === 'win32' ? 14 : 6);
});
