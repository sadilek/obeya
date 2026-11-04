import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime, gitRepo, heard, noForge } from './testing';

// A canvas the size of a long-used one: hundreds of archived cards, a few hundred of them with a
// shared page, a hundred on the canvas, ideas with hundreds of prototypes. Many cards landing one
// after the other change it dozens of times in a row, and sharing a demo looks up every shared card;
// the server answers nothing while that runs.

let dir: string;
let canvas: CanvasRuntime;
let store: Store;
let onCanvas: string[];
let archived: string[];
let ideas: string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-board-size-'));
  const repo = gitRepo(join(dir, 'app'), { 'docs/plan/plan.md': '# App\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** One.\n- [ ] **W2:** Two.\n' });
  store = new Store(join(dir, 'obeya.db'));
  canvas = new CanvasRuntime({ name: 'App', repos: [{ path: repo, clones: 2 }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge });
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
      ...(n % 3 === 0 ? { share: JSON.stringify({ slug: `card-${n}`, url: `https://demos.example/card-${n}`, demos: [{ dir: demo, shown }], version: '' }) } : {}),
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
      ...(n % 2 === 0 ? { share: JSON.stringify({ slug: `prototype-${n}`, url: `https://demos.example/prototype-${n}`, demos: [{ dir: demo, shown }], version: '' }) } : {}),
    });
  });
  idea.slice(0, 70).forEach((r, n) => store.update(r.id, { archived_at: new Date(Date.now() - n * 60_000).toISOString() }));
  // the server sends each change to the pages that show the canvas
  canvas.board.onChange(() => JSON.stringify(canvas.board.snapshot()));
  canvas.board.changed();
  // over a thousand cards and their demo folders take more than the default 5 s on a busy machine
}, 30_000);

// What a run costs is measured against a rebuild of the canvas view on the same machine, in the
// CPU time of the thread that runs the server's code: on a CI runner the same run counts four to
// eight times the CPU time it counts on a laptop, more with other test files beside it
// (`bun test --parallel`), and the time on the clock also waits for a core. A noisy measurement
// only makes a run cost more, so the fastest of three rounds counts.
async function cpuTime(run: () => Promise<void>): Promise<number> {
  await heard();
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

afterAll(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
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
  // 90 writes: about ten rebuilds' worth; with the listeners rebuilding the view after each write, over fifty
  expect(Math.min(...rounds) / rebuild).toBeLessThan(30);
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
  // about two rebuilds' worth: a lookup per card that built the archive or its prototypes anew costs one each, hundreds
  expect(Math.min(...rounds) / rebuild).toBeLessThan(10);
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
