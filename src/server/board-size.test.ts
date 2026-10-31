import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime, gitRepo, heard, noForge } from './testing';

// A canvas the size of a long-used one: hundreds of archived cards, a few hundred of them with a
// shared page, a hundred on the canvas. Many cards landing one after the other change it dozens of
// times in a row; the server answers nothing while that runs.

let dir: string;
let canvas: CanvasRuntime;
let store: Store;
let onCanvas: string[];
let archived: string[];

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
  // the server sends each change to the pages that show the canvas
  canvas.board.onChange(() => JSON.stringify(canvas.board.snapshot()));
  canvas.board.changed();
});

afterAll(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('a canvas with hundreds of archived and shared cards: a run of changes holds the server up for far less than half a second', async () => {
  await heard();
  const board = canvas.board;
  // the time the server's process computes, not the time on the clock: beside other test files
  // (`bun test --parallel`) on a runner with few cores, it also waits for a core, which says
  // nothing about the code (a run that takes under 100 ms on a laptop took 700 ms on the clock in CI)
  let longest = 0;
  for (let round = 0; round < 3; round++) {
    const start = process.cpuUsage();
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
    const used = process.cpuUsage(start);
    longest = Math.max(longest, (used.user + used.system) / 1000);
  }
  expect(longest).toBeLessThan(500);
});
