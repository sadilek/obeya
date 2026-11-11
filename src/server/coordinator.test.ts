import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, type Board } from './board';
import type { StoredContribution } from './row';
import { Store } from './db';
import { Coordinator, overlaps } from './coordinator';
import { Learner } from './learner';
import { move, queueOrder, reach } from '../core/queue';
import { artifact, commit, FakeRuntime, type FakeSession, gitClone, gitRepo, PATIENCE, removeDir, tag, testBoard, until } from './testing';
import { Workers } from './workers';
import { HERE, parseChanges, Workspaces } from './workspaces';
import { git } from './git';
import { withLimitWait } from './runtime';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let workspaces: Workspaces;
let k: Coordinator;
let docs: PlanDoc[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-k-'));
  const main = join(dir, 'main');
  gitRepo(main);
  const store = new Store(':memory:');
  docs = [];
  board = testBoard({ store, docs: () => docs, path: main });
  const adapter = { ...generic, land: 'main' as const, workspaces: 'worktrees' as const, softPaths: ['docs/'] };
  workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  runtime = new FakeRuntime();
  workers = new Workers({ board, runtime, workspaces, adapter });
  k = new Coordinator({ board, runtime, home: () => main, repoFor: () => ({ workers, workspaces, adapter, path: main }), holdMs: 0 });
});
afterEach(async () => {
  workers.shutdown();
  await removeDir(dir);
});

/**
 * Lets the Coordinator go on until it waits for an estimate or has decided, and the cards it started
 * have their workspace: before an estimate, git reads the branches of the cards in progress, which
 * takes a moment, a few seconds on a busy Windows machine.
 */
async function settle() {
  await Bun.sleep(5);
  const asking = () => runtime.sessions.some((s) => !s.closed && s.spec.tools.some((t) => t.name === 'scope' || t.name === 'schedule'));
  const judging = () => (k.deciding || board.snapshot().items.some((i) => i.queue && 'checking' in i.queue)) && !asking();
  for (const end = Date.now() + 1000 * PATIENCE; judging() && Date.now() < end; ) await Bun.sleep(2);
  // the workers it started at work in their workspaces
  await workers.prepared();
}
const card = (title: string) => board.create({ title, x: 0, y: 0 });
const item = (id: string) => board.item(id)!;
const estimates = () => runtime.withTool('scope');
const workerOf = (id: string) => runtime.sessions.find((s) => s.spec.cwd === board.row(id).workspace)!;

/** Answers the latest open estimate. */
async function scope(files: string[], conflicts: string[] = [], reason = 'Grund.', buildsOn: string[] = []) {
  await settle();
  const s = estimates().at(-1) as FakeSession;
  s.call('scope', { files, conflicts_with: conflicts, builds_on: buildsOn, reason });
  s.emit({ type: 'idle' });
  await settle();
}

const schedules = () => runtime.withTool('schedule');

/** Answers the latest open joint turn: one entry per card, [tag, files, builds on, conflicts with, reason]. */
async function schedule(entries: [string, string[], string[], string[], string][]) {
  await settle();
  const s = schedules().at(-1)!;
  const r = s.call('schedule', { workstreams: entries.map(([card, files, builds_on, conflicts_with, reason]) => ({ card, files, builds_on, conflicts_with, reason })) });
  s.emit({ type: 'idle' });
  await settle();
  return r;
}

describe('Coordinator', () => {
  test('a card with nothing in progress starts at once; its scope is estimated afterwards', async () => {
    const a = card('A');
    k.request(a.id);
    expect(item(a.id).queue).toMatchObject({ checking: true });
    await settle();
    expect(item(a.id).state).toBe('working');
    await scope(['src/a.ts']);
    expect(item(a.id)).toMatchObject({ state: 'working', scope: ['src/a.ts'] });
    expect(item(a.id).queue).toBeUndefined();
    expect(estimates()[0]!.spec).toMatchObject({ readOnly: true });
  });

  test('a card likely to conflict waits and starts when the other one has landed', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    expect(estimates().at(-1)!.inbox[0]).toContain('"A"');
    await scope(['src/a.ts', 'src/b.ts'], [tag(a)], 'Beide ändern decide() in src/a.ts.');
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { behind: [a.id], reason: 'Beide ändern decide() in src/a.ts.' } });

    const wa = board.row(a.id).workspace!;
    commit(wa, 'a.ts', 'a', 'A');
    await workerOf(a.id).call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('sharing a file is not enough: without a likely conflict the card starts, and says why', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/strings.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/strings.ts'], [], 'Beide ergänzen src/strings.ts, an verschiedenen Stellen.');
    expect(item(b.id).state).toBe('working');
    expect(board.events(b.id).some((e) => e.text.includes('Kein Merge-Konflikt') && e.text.includes('an verschiedenen Stellen'))).toBe(true);
  });

  test('the estimate sees where a card in progress has changed its files, without soft paths', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts', 'docs/plan.md']);
    const wa = board.row(a.id).workspace!;
    commit(wa, 'README.md', 'hello\nworld\n', 'A');
    writeFileSync(join(wa, 'x.ts'), 'x');
    const b = card('B');
    k.request(b.id);
    await settle();
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('expected to change: src/a.ts\n');
    expect(brief).toContain('changed so far: README.md (lines 2 in hello), x.ts (new)');
    expect(brief).toContain('Changes under docs/ never count');
  });

  test('work approved into a pull request still holds its files until it is merged', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    board.work(a.id, { state: 'inPr' });
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], [tag(a)]);
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
    board.work(a.id, { state: 'live' });
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('a waiting card is judged again against what started while it waited', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], [tag(a)]);
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts']);
    expect(item(c.id).state).toBe('working');
    await workers.stop(a.id);
    await settle();
    expect(item(b.id).queue).toMatchObject({ checking: true });
    expect(estimates().at(-1)!.inbox[0]).toContain('"C"');
    await scope(['src/a.ts'], [tag(c)], 'Beide ändern dieselbe Funktion.');
    expect(item(b.id).queue).toMatchObject({ behind: [c.id] });
    await workers.stop(c.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('two cards requested together are decided one after the other', async () => {
    const a = card('A');
    const b = card('B');
    k.request(a.id);
    k.request(b.id);
    await settle();
    expect(estimates()).toHaveLength(1);
    await scope(['src/shared.ts']);
    await scope(['src/shared.ts'], [tag(a)]);
    expect(item(a.id).state).toBe('working');
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('force starts a waiting card, dequeue takes it out, stop frees the queue', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], [tag(a)]);
    k.dequeue(b.id);
    expect(item(b.id).queue).toBeUndefined();

    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts'], [tag(a)]);
    k.force(c.id);
    expect(item(c.id).state).toBe('working');

    const d = card('D');
    k.request(d.id);
    await scope(['src/a.ts'], [tag(a), tag(c)]);
    expect(item(d.id).queue).toMatchObject({ behind: [a.id, c.id] });
    await workers.stop(a.id);
    await settle();
    expect(item(d.id).queue).toMatchObject({ behind: [c.id] });
    await workers.stop(c.id);
    await settle();
    expect(item(d.id).state).toBe('working');
  });

  test('cards freed at once are judged together, in their order in the queue, and keep their places', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    // the later card comes first on the board: its turn must still come second
    const later = card('Später');
    const first = card('Zuerst');
    k.request(first.id);
    await scope(['src/a.ts'], [tag(a)]);
    k.request(later.id);
    await scope(['src/a.ts'], [tag(a)]);
    expect(item(first.id).queue).toMatchObject({ behind: [a.id] });
    const since = item(later.id).queue!.since;
    expect(since! > item(first.id).queue!.since!).toBe(true);

    await workers.stop(a.id);
    await settle();
    // neither starts before the joint turn has seen both
    expect(item(first.id).queue).toMatchObject({ checking: true });
    expect(item(later.id).queue).toMatchObject({ checking: true, since });
    expect(board.events(first.id).at(-1)!.text).toContain('zusammen mit den anderen Aufgaben');
    const brief = schedules().at(-1)!.inbox[0]!;
    expect(brief.indexOf('"Zuerst"')).toBeLessThan(brief.indexOf('"Später"'));
    expect(schedules().at(-1)!.spec.system).toContain('what they waited for has landed now');
    await schedule([
      [tag(first), ['src/a.ts'], [], [], 'Kann sofort laufen.'],
      [tag(later), ['src/a.ts'], [], [tag(first)], 'Beide ändern dieselbe Funktion.'],
    ]);
    expect(item(first.id).state).toBe('working');
    expect(board.events(first.id).some((e) => e.text.includes('Zusammen mit den anderen frei gewordenen Aufgaben geprüft'))).toBe(true);
    expect(item(later.id).queue).toEqual({ behind: [first.id], reason: 'Beide ändern dieselbe Funktion.', since });

    await workers.stop(first.id);
    await settle();
    expect(item(later.id).state).toBe('working');
  });

  test('a new card likely to conflict with a queued one waits behind it instead of overtaking it', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts', 'src/b.ts'], [tag(a)]);
    const c = card('C');
    k.request(c.id);
    await settle();
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('Cards queued ahead of this one');
    expect(brief).toContain(`- ${tag(b)}: "B"\n  expected to change: src/a.ts, src/b.ts\n  waits for: "A"`);
    await scope(['src/b.ts'], [tag(b)], 'Beide ändern render() in src/b.ts.');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id], reason: 'Beide ändern render() in src/b.ts.' });
    expect(board.events(c.id).some((e) => e.text.includes('„B“ (wartet selbst und ist vorher dran)'))).toBe(true);

    // B goes first; C waits for it to land, not only to start
    await workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
    await workers.stop(b.id);
    await settle();
    expect(item(c.id).state).toBe('working');
  });

  test('a queued card judged again does not wait for cards queued after it', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], [tag(a)]);
    const d = card('D');
    k.request(d.id);
    await scope(['src/d.ts']);
    expect(item(d.id).state).toBe('working');
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts'], [tag(b)]);
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });

    await workers.stop(a.id);
    await settle();
    expect(item(b.id).queue).toMatchObject({ checking: true });
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('"D"');
    expect(brief).not.toContain('"C"');
    await scope(['src/a.ts']);
    expect(item(b.id).state).toBe('working');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
  });

  test('a card queued behind a waiting one starts when that one is taken out of the queue', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts', 'src/b.ts'], [tag(a)]);
    const c = card('C');
    k.request(c.id);
    await scope(['src/b.ts'], [tag(b)]);
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
    k.dequeue(b.id);
    await settle();
    expect(item(c.id).queue).toMatchObject({ checking: true });
    await scope(['src/b.ts']);
    expect(item(c.id).state).toBe('working');
  });

  test('a card keeps its place in the queue while what it waits for changes', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts', 'src/b.ts'], [tag(a), tag(b)]);
    const since = item(c.id).queue!.since;
    expect(since).toBeString();
    await workers.stop(a.id);
    await settle();
    expect(item(c.id).queue).toEqual({ behind: [b.id], reason: 'Grund.', since });
  });

  test('the owner moves a waiting card past those it has no wait with, and its turn comes in the new order', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const [b, c, d] = [card('B'), card('C'), card('D')];
    k.request(b.id);
    await scope(['src/a.ts'], [tag(a)]);
    k.request(c.id);
    await scope(['src/a.ts'], [tag(a)]);
    k.request(d.id);
    await scope(['src/c.ts'], [tag(c)]);
    expect(item(d.id).queue).toMatchObject({ behind: [c.id] });
    const order = () => queueOrder(board.snapshot().items).map((i) => i.title);
    expect(order()).toEqual(['B', 'C', 'D']);

    k.reorder(c.id, true);
    expect(order()).toEqual(['C', 'B', 'D']);
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'owner', text: 'In der Warteschlange vor „B“ gezogen.' });
    k.reorder(d.id, true);
    expect(order()).toEqual(['C', 'D', 'B']);
    // D waits for C, which stays ahead of it, and C is first already
    expect(() => k.reorder(d.id, true)).toThrow(expect.objectContaining({ code: 'notMovable' }));
    expect(() => k.reorder(c.id, false)).toThrow(expect.objectContaining({ code: 'notMovable' }));
    expect(() => k.reorder(c.id, true)).toThrow(expect.objectContaining({ code: 'notMovable' }));
    expect(move(d.id, true, board.snapshot().items)).toMatchObject({ past: { id: c.id }, why: 'waitsFor' });
    expect(move(c.id, false, board.snapshot().items)).toMatchObject({ past: { id: d.id }, why: 'waitedOn' });

    // a card being judged is passed by none, nor does it move
    const e = card('E');
    k.request(e.id);
    await settle();
    expect(move(b.id, false, board.snapshot().items)).toMatchObject({ past: { id: e.id }, why: 'checking' });
    expect(() => k.reorder(e.id, true)).toThrow(expect.objectContaining({ code: 'notQueued' }));
    await scope(['src/e.ts']);
    expect(item(e.id).state).toBe('working');
    await workers.stop(e.id);

    // C now comes first: it and B are judged together in that order
    await workers.stop(a.id);
    await settle();
    const brief = schedules().at(-1)!.inbox[0]!;
    expect(brief.indexOf('"C"')).toBeLessThan(brief.indexOf('"B"'));
    await schedule([
      [tag(c), ['src/a.ts'], [], [], 'Kann sofort laufen.'],
      [tag(b), ['src/a.ts'], [], [tag(c)], 'Beide ändern src/a.ts.'],
    ]);
    expect(item(c.id).state).toBe('working');
    expect(item(b.id).queue).toMatchObject({ behind: [c.id] });
    expect(item(d.id).queue).toMatchObject({ behind: [c.id] });
  });

  test('the owner moves a waiting card several places at once, as far as its waits let it', () => {
    const t0 = Date.parse('2026-10-01T10:00:00.000Z');
    const wait = (title: string, ms: number, behind?: string) => {
      const c = card(title);
      const since = new Date(t0 + ms).toISOString();
      board.work(c.id, { queue: JSON.stringify(behind ? { behind: [behind], reason: 'Grund.', since } : { workspace: 'none', since }) });
      return c;
    };
    // B and C came in the same millisecond; E waits for B
    const a = wait('A', 0);
    const b = wait('B', 10);
    const c = wait('C', 10);
    const d = wait('D', 20);
    const e = wait('E', 30, b.id);
    const order = () => queueOrder(board.snapshot().items).map((i) => i.title);
    expect(order()).toEqual(b.id < c.id ? ['A', 'B', 'C', 'D', 'E'] : ['A', 'C', 'B', 'D', 'E']);
    const [first, second] = b.id < c.id ? ['B', 'C'] : ['C', 'B'];

    k.reorder(d.id, true, 3);
    expect(order()).toEqual(['D', 'A', first, second, 'E']);
    expect(board.events(d.id).at(-1)).toMatchObject({ author: 'owner', text: 'In der Warteschlange vor „A“ gezogen.' });
    k.reorder(a.id, false, 3);
    expect(order()).toEqual(['D', first, second, 'E', 'A']);
    expect(board.events(a.id).at(-1)).toMatchObject({ text: 'In der Warteschlange hinter „E“ gestellt.' });

    // E goes no farther up than right behind B, the card it waits for
    const items = () => board.snapshot().items;
    expect(reach(e.id, true, items())).toMatchObject({ places: first === 'B' ? 1 : 0, stop: { id: b.id }, why: 'waitsFor' });
    expect(reach(b.id, false, items())).toMatchObject({ places: first === 'B' ? 1 : 0, stop: { id: e.id }, why: 'waitedOn' });
    expect(reach(a.id, false, items())).toEqual({ places: 0 });
    expect(reach(d.id, false, items())).toEqual({ places: 4 });
    expect(() => k.reorder(e.id, true, 3)).toThrow(expect.objectContaining({ code: 'notMovable' }));
    expect(() => k.reorder(e.id, true, 0)).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(order()).toEqual(['D', first, second, 'E', 'A']);
    // every card keeps a time of its own, so the order no longer hangs on the ids
    const times = queueOrder(items()).map((i) => i.queue!.since);
    expect(new Set(times).size).toBe(times.length);
  });

  test('an estimate the usage limit stops waits on the card, and the card is judged once the limit lifts', async () => {
    k = new Coordinator({ board, runtime: withLimitWait(runtime, 10), home: () => dir, repoFor: () => ({ workers, workspaces, adapter: generic, path: dir }), holdMs: 0 });
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    const s = estimates().at(-1)!;
    s.emit({ type: 'error', message: "You've hit your session limit · resets 2:40pm (Europe/Berlin)", limit: { resetsAt: Date.now() + 20 } });
    s.emit({ type: 'idle' });
    await settle();
    // it does not start without an estimate: it waits with the Coordinator, and says until when
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { checking: true } });
    expect(item(b.id).limitedUntil).toBeDefined();
    expect(board.events(b.id).some((e) => e.kind === 'error')).toBe(false);
    await until(() => item(b.id).limitedUntil === undefined);
    expect(s.inbox.at(-1)).toContain('usage limit');
    await scope(['src/a.ts'], [tag(a)]);
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('without an estimate the card still starts, and says why', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    estimates().at(-1)!.emit({ type: 'idle' });
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(board.events(b.id).some((e) => e.kind === 'error' && e.text.includes('nicht schätzen'))).toBe(true);
  });
});

describe("Coordinator queues a review's follow-up tasks", () => {
  /** A review card of PR #34 that is under way, without an agent of its own. */
  function review(state: 'working' | 'waiting' | 'live' = 'working') {
    const r = card('PR #34: Manual dependencies');
    const c: StoredContribution = { url: 'https://github.com/acme/app/pull/34', number: 34, author: 'amerlander', title: 'Manual dependencies', canModify: true };
    board.work(r.id, { contribution: JSON.stringify(c), state });
    return r;
  }

  test('a follow-up task waits behind its review card at once, without an estimate, and starts once the PR is merged', async () => {
    const r = review('waiting');
    const f = board.create({ title: 'Explain the arrows', from: r.id });
    k.followUp(f.id, r.id);
    expect(item(f.id)).toMatchObject({ state: 'planned', queue: { behind: [r.id], buildsOn: [r.id] } });
    expect(board.events(f.id).at(-1)!.text).toBe('Obeya: wartet auf „PR #34: Manual dependencies“. Folgeaufgabe aus dem Review von PR #34; startet, sobald der PR gemergt ist.');
    await settle();
    expect(estimates()).toEqual([]);
    // the owner stopping the review does not free it: the PR is not merged
    board.work(r.id, { state: 'planned' });
    await settle();
    expect(item(f.id).state).toBe('planned');
    board.work(r.id, { state: 'live' });
    await settle();
    expect(item(f.id).state).toBe('working');
  });

  test('follow-up tasks freed by the merge are judged together: one may wait for another that came later in the queue', async () => {
    const r = review();
    const f1 = board.create({ title: 'Explain the arrows', body: 'Tooltips on the arrows.', from: r.id });
    const f2 = board.create({ title: 'Say why a link is refused', body: 'A message beside the arrow.', from: r.id });
    k.followUp(f1.id, r.id);
    k.followUp(f2.id, r.id);
    board.work(r.id, { state: 'live' });
    await settle();
    // the first does not start before the turn has seen the second
    expect(item(f1.id).queue).toMatchObject({ checking: true });
    const brief = schedules().at(-1)!.inbox[0]!;
    expect(brief).toContain(`${tag(f1)}: task "Explain the arrows" — Tooltips on the arrows.`);
    expect(brief).toContain(`${tag(f2)}: task "Say why a link is refused"`);
    await schedule([
      [tag(f2), ['src/ui/arrow.tsx'], [], [], 'Bringt die Meldung neben dem Pfeil.'],
      [tag(f1), ['src/ui/arrow.tsx'], [tag(f2)], [], 'Die Tooltips bauen auf der Meldung auf.'],
    ]);
    expect(item(f2.id).state).toBe('working');
    expect(item(f1.id).queue).toMatchObject({ behind: [f2.id], buildsOn: [f2.id], reason: 'Die Tooltips bauen auf der Meldung auf.' });
    expect(board.events(f1.id).at(-1)!.text).toBe('Obeya: wartet auf „Say why a link is refused“. Die Tooltips bauen auf der Meldung auf.');
  });

  test('a review closed without a merge takes its follow-up tasks back to planned, for the owner to decide on', async () => {
    const r = review();
    const f = board.create({ title: 'Explain the arrows', from: r.id });
    k.followUp(f.id, r.id);
    const c = JSON.parse(board.row(r.id).contribution!) as StoredContribution;
    board.work(r.id, { contribution: JSON.stringify({ ...c, closed: true } satisfies StoredContribution), state: 'done' });
    await settle();
    expect(item(f.id).state).toBe('planned');
    expect(item(f.id).queue).toBeUndefined();
    expect(board.events(f.id).at(-1)!.text).toContain('ohne Merge geschlossen');
  });

  test('of a review already merged, a follow-up task is judged as any card', async () => {
    const r = review('live');
    const f = board.create({ title: 'Explain the arrows', from: r.id });
    k.followUp(f.id, r.id);
    await settle();
    expect(item(f.id).state).toBe('working');
  });
});

describe('Coordinator names a card the owner left without a title', () => {
  const namings = () => runtime.withTool('title');
  const task = (body: string) => board.create({ title: '', body, x: 0, y: 0 });

  test('from its text, by a short read-only session; asked twice, one session answers', async () => {
    const a = task('Der Dialog soll den Cursor ins Textfeld setzen.');
    const naming = k.name(a.id);
    void k.name(a.id);
    expect(namings()).toHaveLength(1);
    expect(namings()[0]!.spec).toMatchObject({ readOnly: true, role: 'chores' });
    expect(namings()[0]!.inbox[0]).toContain('Der Dialog soll den Cursor ins Textfeld setzen.');
    namings()[0]!.call('title', { title: '  Cursor startet\nim Textfeld ' });
    namings()[0]!.emit({ type: 'idle' });
    await naming;
    expect(item(a.id).title).toBe('Cursor startet im Textfeld');
  });

  test('a title the owner types meanwhile stands; without an answer the text’s start stands in', async () => {
    const a = task('Erste Zeile\nmehr');
    const naming = k.name(a.id);
    board.patch(a.id, { title: 'Meiner' });
    namings()[0]!.call('title', { title: 'Obeyas' });
    namings()[0]!.emit({ type: 'idle' });
    await naming;
    expect(item(a.id).title).toBe('Meiner');

    const b = task('Erste Zeile\nmehr');
    const failed = k.name(b.id);
    namings().at(-1)!.emit({ type: 'error', message: 'down' });
    await failed;
    expect(item(b.id).title).toBe('Erste Zeile');
  });

  test('a naming the usage limit stops waits on the card, and names it once the limit lifts', async () => {
    k = new Coordinator({ board, runtime: withLimitWait(runtime, 10), home: () => dir, repoFor: () => ({ workers, workspaces, adapter: generic, path: dir }), holdMs: 0 });
    const a = task('Erste Zeile\nmehr');
    const naming = k.name(a.id);
    const s = namings()[0]!;
    s.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 20 } });
    s.emit({ type: 'idle' });
    await settle();
    expect(item(a.id).title).toBe('');
    expect(item(a.id).limitedUntil).toBeDefined();
    await until(() => item(a.id).limitedUntil === undefined);
    s.call('title', { title: 'Zeilen zählen' });
    await naming;
    expect(item(a.id).title).toBe('Zeilen zählen');
  });

  test('an empty card or one with a title is not named', async () => {
    await k.name(task('').id);
    await k.name(card('Titel').id);
    expect(namings()).toHaveLength(0);
  });

  test('a card started without a title is named before it is judged', async () => {
    const a = task('Mach was.');
    k.request(a.id);
    await settle();
    expect(item(a.id).state).toBe('planned');
    namings()[0]!.call('title', { title: 'Etwas machen' });
    namings()[0]!.emit({ type: 'idle' });
    await settle();
    expect(item(a.id)).toMatchObject({ title: 'Etwas machen', state: 'working' });
    expect(board.row(a.id).branch).toContain('etwas-machen');
  });
});

describe('Coordinator waits for a free workspace', () => {
  let clones: string[];

  /** A pool of `n` clones instead of worktrees: cards wait when all are leased, or with `slots` when that many workers are busy. */
  async function pool(n: number, slots?: number) {
    const main = join(dir, 'main');
    const store = new Store(':memory:');
    board = testBoard({ store, docs: () => docs, path: main });
    const adapter = { ...generic, land: 'main' as const, workspaces: 'clones' as const };
    workspaces = new Workspaces(store, 'c', {
      mode: 'clones',
      repoPath: main,
      dir: join(dir, 'clones'),
      ...(slots !== undefined ? { machines: [{ host: null, slots }], busy: () => workers.busyOn(null) } : {}),
    });
    for (let i = 1; i <= n; i++) gitClone(main, join(dir, 'clones', String(i)));
    await workspaces.ensureClones(main, n);
    clones = workspaces.list().map((w) => w.path);
    workers.shutdown();
    workers = new Workers({ board, runtime, workspaces, adapter });
    k = new Coordinator({ board, runtime, home: () => main, repoFor: () => ({ workers, workspaces, adapter, path: main }), holdMs: 0 });
  }

  test('a card the Coordinator lets start waits for a workspace, and starts once one is free', async () => {
    await pool(1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none' } });
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'state', text: expect.stringContaining('sobald einer frei wird') });
    expect(board.events(b.id).some((e) => e.kind === 'error')).toBe(false);

    await workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(board.row(b.id).workspace).toBe(clones[0]!);
    expect(item(b.id).queue).toBeUndefined();
    expect(board.events(b.id).some((e) => e.text.includes('Ein Workspace ist frei'))).toBe(true);
  });

  test("a follow-up whose agent needs a full clone takes the next free one, before a queued card", async () => {
    await pool(1);
    const f = card('F');
    await workers.start(f.id);
    workerOf(f.id).emit({ type: 'session', id: 'sess-f' });
    await workerOf(f.id).call('ready_for_review', { summary: 'S', demo: artifact() });
    workerOf(f.id).emit({ type: 'idle' });
    await workers.approve(f.id);
    workerOf(f.id).emit({ type: 'idle' });
    expect(item(f.id).state).toBe('done');
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none' } });

    workers.message(f.id, 'Läuft die Demo?');
    await workers.prepared();
    expect(board.row(f.id).workspace).not.toBe(clones[0]!);
    workerOf(f.id).call('need_clone', {});
    workerOf(f.id).emit({ type: 'idle' });
    await settle();
    expect(item(f.id).waitsForClone).toBe(true);

    await workers.stop(a.id);
    await settle();
    expect(board.row(f.id).workspace).toBe(clones[0]!);
    expect(runtime.last.spec).toMatchObject({ cwd: clones[0]!, resume: 'sess-f' });
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none' } });
  });

  test('a card waits for a slot while the busy workers fill them, and starts once a turn ends', async () => {
    await pool(3, 1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { workspace: 'slots' } });
    expect(board.events(b.id).at(-1)!.text).toContain('Kein Slot frei');
    expect(workspaces.pool(workers.inTurn())).toEqual([expect.objectContaining({ here: true, slots: 1, total: 3, cards: [a.id], busy: [a.id] })]);

    // A asks the owner: its clone stays its own, its slot is free
    await workerOf(a.id).call('ask', { question: 'Welche Farbe?' });
    workerOf(a.id).emit({ type: 'idle' });
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(board.row(b.id).workspace).not.toBe(board.row(a.id).workspace);
    expect(board.events(b.id).some((e) => e.text.includes('wieder einen Slot frei'))).toBe(true);
    expect(workspaces.pool(workers.inTurn())[0]).toMatchObject({ cards: [a.id, b.id], busy: [b.id] });
  });

  test('in worktrees, a card waits for a slot only once the repository has slots', async () => {
    const main = join(dir, 'main');
    const store = new Store(':memory:');
    board = testBoard({ store, docs: () => docs, path: main });
    workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws'), machines: [{ host: null, slots: 1 }], busy: () => workers.busyOn(null) });
    const adapter = { ...generic, land: 'main' as const, workspaces: 'worktrees' as const };
    workers.shutdown();
    workers = new Workers({ board, runtime, workspaces, adapter });
    k = new Coordinator({ board, runtime, home: () => main, repoFor: () => ({ workers, workspaces, adapter, path: main }), holdMs: 0 });
    expect(workspaces.pooled).toBe(true);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { workspace: 'slots' } });
    expect(board.events(b.id).at(-1)!.text).toContain('Kein Slot frei');
    expect(workspaces.pool(workers.inTurn())).toEqual([
      { name: HERE, here: true, worktrees: true, slots: 1, total: 1, cards: [a.id], busy: [a.id], workspaces: [{ path: expect.any(String), card: a.id }] },
    ]);

    // A asks the owner: its worktree stays its own, its slot is free
    await workerOf(a.id).call('ask', { question: 'Welche Farbe?' });
    workerOf(a.id).emit({ type: 'idle' });
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(board.events(b.id).some((e) => e.text.includes('wieder einen Slot frei'))).toBe(true);
    expect(workspaces.pool(workers.inTurn())[0]).toMatchObject({ cards: [b.id], busy: [b.id] });
  });

  test('in worktrees without slots, any number of cards work at once', async () => {
    expect(workspaces.pooled).toBe(false);
    const cards = ['A', 'B', 'C'].map((t) => card(t));
    for (const [i, c] of cards.entries()) {
      k.request(c.id);
      await scope([`src/${i}.ts`]);
    }
    expect(cards.map((c) => item(c.id).state)).toEqual(['working', 'working', 'working']);
  });

  test('the card waiting longest gets the workspace; a card behind a waiting one waits too', async () => {
    await pool(1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    const c = card('C');
    k.request(c.id);
    await settle();
    // B is ahead of C in the queue, so C is judged against it
    expect(estimates().at(-1)!.inbox[0]).toContain('a free workspace');
    await scope(['src/c.ts']);
    const d = card('D');
    k.request(d.id);
    await scope(['src/b.ts'], [tag(b)]);
    expect(item(c.id).queue).toMatchObject({ workspace: 'none' });
    expect(item(d.id).queue).toMatchObject({ behind: [b.id] });

    await workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(item(c.id).queue).toMatchObject({ workspace: 'none' });
    expect(item(d.id).queue).toMatchObject({ behind: [b.id] });
  });

  test('every free workspace with uncommitted changes: the card waits until one is clean', async () => {
    await pool(2);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const free = clones.find((p) => p !== board.row(a.id).workspace)!;
    writeFileSync(join(free, 'stray.txt'), 'x');
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id).queue).toMatchObject({ workspace: 'dirty' });

    rmSync(join(free, 'stray.txt'));
    // a dirty clone is not asked again on every change of the board, but once another one frees up
    await workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('taken out of the queue, it no longer starts', async () => {
    await pool(1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    k.dequeue(b.id);
    expect(item(b.id).queue).toBeUndefined();
    await workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('planned');
  });
  /** Waits until `done` holds: git keeps a card's work and frees its clone in the background. */
  async function freed(done: () => boolean) {
    await until(done, 5000 * PATIENCE);
    await settle();
  }

  test("taking a card's clone gives it to the card waiting; the card it was taken from waits behind and goes on with its work, uncommitted again", async () => {
    await pool(1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const at = board.row(a.id).workspace!;
    writeFileSync(join(at, 'a.ts'), 'halb fertig\n');
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    expect(item(b.id)).toMatchObject({ queue: { workspace: 'none' } });
    expect(workers.evictable(a.id)).toBe(true);

    k.evict(a.id);
    await freed(() => item(b.id).state === 'working');
    expect(board.row(b.id).workspace).toBe(clones[0]!);
    expect(item(a.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none' } });
    expect(board.row(a.id)).toMatchObject({ workspace: null, kept_in: clones[0]! });
    expect(runtime.sessions.find((s) => s.spec.cwd === at && s.closed)).toBeDefined();
    // the work A had not committed is in a commit on its branch
    expect(git(at, 'show', '--stat', '--format=%B', board.row(a.id).branch!)).toContain('a.ts');
    expect(board.events(a.id).some((e) => e.text.startsWith('Workspace entzogen'))).toBe(true);

    await workers.stop(b.id);
    await freed(() => item(a.id).state === 'working');
    expect(board.row(a.id)).toMatchObject({ workspace: clones[0]!, kept_in: null });
    expect(git(at, 'status', '--porcelain')).toBe('?? a.ts');
    expect(git(at, 'log', '-1', '--format=%B')).not.toContain('Obeya-Kept');
  });

  test("a card whose clone was taken goes on once one is free, whatever arrows the owner drew meanwhile", async () => {
    await pool(1);
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    board.connect(card('Prerequisite').id, a.id);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    k.evict(a.id);
    await freed(() => item(b.id).state === 'working');
    expect(item(a.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none', begun: true } });
    await workers.stop(b.id);
    await freed(() => item(a.id).state === 'working');
  });

  test("taking a card's clone waits a few seconds, in which the owner takes it back", async () => {
    await pool(1);
    k = new Coordinator({ board, runtime, home: () => join(dir, 'main'), repoFor: () => ({ workers, workspaces, adapter: generic, path: join(dir, 'main') }), holdMs: 40 });
    const a = card('A');
    await workers.start(a.id);
    await workers.prepared();
    k.evict(a.id);
    expect(k.evicting(a.id)).toBe(true);
    expect(() => k.evict(a.id)).toThrow(BadRequest);
    k.keep(a.id);
    await Bun.sleep(80);
    expect(item(a.id).state).toBe('working');
    expect(board.row(a.id).workspace).toBe(clones[0]!);
    expect(() => k.keep(a.id)).toThrow(BadRequest);
  });
});

describe('Coordinator starts all workstreams of a project', () => {
  const ws = (key: string, done = false) => ({ key, label: key, title: `Titel ${key}`, body: `Text ${key}`, done, inReview: false });
  /** A project with W1 live and W2 to W4 planned. */
  function project() {
    docs = [{ file: 'docs/plan/p.md', title: 'P', goal: 'Ziel P', workstreams: [ws('W1', true), ws('W2'), ws('W3'), ws('W4')], markdown: '' }];
    board.docsChanged();
    const [p, , w2, w3, w4] = board.snapshot().items;
    return { p: p!, w2: w2!, w3: w3!, w4: w4! };
  }

  test('one turn sees them all with the plan doc and decides which start and which wait for what', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const { p, w2, w3, w4 } = project();
    k.request(p.id);
    // in the plan's order until the Coordinator has decided
    expect([w2, w3, w4].map((w) => item(w.id).queue)).toEqual([0, 1, 2].map(() => expect.objectContaining({ checking: true, together: p.id })));
    await settle();
    expect(schedules()).toHaveLength(1);
    expect(estimates()).toHaveLength(1);
    const brief = schedules()[0]!.inbox[0]!;
    expect(brief).toContain('plan doc docs/plan/p.md');
    expect(brief).toContain(`- ${tag(w2)}: W2 "Titel W2" — Text W2`);
    expect(brief).toContain(`- ${tag(a)}: "A"`);
    // W4 goes first, W2 builds on it, W3 collides with A
    await schedule([
      [tag(w4), ['src/w4.ts'], [], [], 'W4 ist unabhängig.'],
      [tag(w2), ['src/w2.ts'], [tag(w4)], [], 'W2 baut auf der API aus W4 auf.'],
      [tag(w3), ['src/a.ts'], [], [tag(a)], 'W3 und „A“ ändern dieselbe Funktion.'],
    ]);
    expect(item(w4.id)).toMatchObject({ state: 'working', scope: ['src/w4.ts'] });
    expect(item(w2.id)).toMatchObject({ state: 'planned', scope: ['src/w2.ts'], queue: { behind: [w4.id], buildsOn: [w4.id], reason: 'W2 baut auf der API aus W4 auf.' } });
    expect(item(w3.id)).toMatchObject({ state: 'planned', queue: { behind: [a.id] } });
    expect(item(w3.id).queue).not.toHaveProperty('buildsOn');
    expect(board.events(w2.id).at(-1)!.text).toBe('Obeya: wartet auf W4 „Titel W4“. W2 baut auf der API aus W4 auf.');
    // the Coordinator's order is the queue's
    expect(k.ahead(item(w3.id)).map((i) => i.id)).toEqual([w2.id]);
    expect(board.events(p.id).at(-1)!.text).toContain('1 von 3 Workstreams starten jetzt');

    await workers.stop(a.id);
    await settle();
    // what runs now is W4: W3 is judged again against it
    expect(item(w3.id).queue).toMatchObject({ checking: true });
  });

  test('a workstream snoozed to start later stays so when its plan doc changes, and the project’s start takes it along', async () => {
    const { p, w2, w3, w4 } = project();
    const until = new Date(Date.now() + 86_400_000).toISOString();
    board.snooze(w2.id, { until, by: 'owner', start: true });
    docs = [{ ...docs[0]!, workstreams: [ws('W1', true), { ...ws('W2'), body: 'Text W2, neu' }, ws('W3'), ws('W4')] }];
    board.docsChanged();
    expect(item(w2.id)).toMatchObject({ state: 'planned', body: 'Text W2, neu', snoozed: { until, start: true } });
    k.request(p.id);
    // a workstream that builds on it can wait for it
    expect(item(w2.id).snoozed).toBeUndefined();
    expect([w2, w3, w4].map((w) => item(w.id).queue)).toEqual([0, 1, 2].map(() => expect.objectContaining({ checking: true, together: p.id })));
  });

  test('a workstream snoozed to start later whose plan doc goes is snoozed no longer when the doc comes back', () => {
    const { w2 } = project();
    board.snooze(w2.id, { until: new Date(Date.now() + 86_400_000).toISOString(), by: 'owner', start: true });
    const kept = docs;
    docs = [];
    board.docsChanged();
    board.snapshot();
    docs = kept;
    board.docsChanged();
    expect(item(w2.id)).toMatchObject({ state: 'planned' });
    expect(item(w2.id).snoozed).toBeUndefined();
  });

  test('a workstream waits only for what comes before it, and every one has to be scheduled', async () => {
    const { p, w2, w3, w4 } = project();
    k.request(p.id);
    await settle();
    const s = schedules()[0]!;
    expect(s.call('schedule', { workstreams: [{ card: tag(w2), files: [], builds_on: [], conflicts_with: [], reason: '' }] })).toContain(`missing ${tag(w3)}, ${tag(w4)}`);
    await schedule([
      [tag(w2), ['src/w2.ts'], [tag(w4)], [], 'Wartet auf W4.'],
      [tag(w3), ['src/w3.ts'], [], [tag(w3)], ''],
      [tag(w4), ['src/w4.ts'], [tag(w2)], [], 'Baut auf W2 auf.'],
    ]);
    expect(item(w2.id).state).toBe('working');
    expect(item(w3.id).state).toBe('working');
    expect(item(w4.id).queue).toMatchObject({ behind: [w2.id] });
  });

  test('without a schedule each is judged on its own', async () => {
    const { p, w2, w3, w4 } = project();
    k.request(p.id);
    await settle();
    schedules()[0]!.emit({ type: 'idle' });
    await settle();
    expect(board.events(p.id).at(-1)!.text).toContain('prüft sie einzeln');
    // each sees the others it may build on
    await settle();
    expect(estimates().at(-1)!.inbox[0]).toMatch(/W3 "Titel W3" \(queued after this card\)/);
    await scope(['src/w2.ts']);
    expect(item(w2.id).state).toBe('working');
    await scope(['src/w3.ts']);
    expect(item(w3.id).state).toBe('working');
    expect(item(w4.id).queue).toMatchObject({ checking: true });
  });

  test('after a restart the joint turn runs again', async () => {
    const { p, w2, w3 } = project();
    board.work(w2.id, { queue: JSON.stringify({ checking: true, together: p.id, since: '1' }) });
    board.work(w3.id, { queue: JSON.stringify({ checking: true, together: p.id, since: '2' }) });
    k.resume();
    await settle();
    expect(schedules()).toHaveLength(1);
    expect(schedules()[0]!.inbox[0]).toContain('Titel W3');
    expect(schedules()[0]!.inbox[0]).not.toContain('Titel W4');
  });

  test('a single workstream is judged as any card; none left to start is refused', async () => {
    const { p, w2, w3, w4 } = project();
    k.request(w2.id);
    k.request(w3.id);
    await settle();
    k.request(p.id);
    await scope(['src/w2.ts']);
    await scope(['src/w3.ts']);
    await settle();
    expect(schedules()).toHaveLength(0);
    expect(estimates().at(-1)!.inbox[0]).toContain('"Titel W4"');
    expect(item(w4.id).queue).toMatchObject({ checking: true });
    expect(item(w4.id).queue).not.toHaveProperty('together');
    expect(() => k.request(p.id)).toThrow(expect.objectContaining({ code: 'nothingToStart' }));
  });

  /** Lands a card in progress: a commit in its workspace, handed over and approved. */
  async function land(id: string) {
    const w = board.row(id).workspace!;
    commit(w, `${id}.ts`, id, id);
    await workerOf(id).call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(id);
    await settle();
  }

  test('a workstream started alone waits for one it builds on that is not started, until that one has landed', async () => {
    const { w2, w3, w4 } = project();
    k.request(w3.id);
    await settle();
    // nothing runs, but the workstreams not started are there to build on
    expect(item(w3.id).state).toBe('planned');
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('W2 "Titel W2" (not started) — Text W2');
    expect(brief).toContain('W4 "Titel W4" (not started)');
    expect(estimates().at(-1)!.spec.system).toContain('builds_on');
    await scope(['src/w3.ts'], [], 'W3 nutzt die API aus W2.', [tag(w2)]);
    expect(item(w3.id)).toMatchObject({ state: 'planned', queue: { behind: [w2.id], buildsOn: [w2.id], reason: 'W3 nutzt die API aus W2.' } });
    expect(board.events(w3.id).at(-1)!.text).toBe('Obeya: wartet auf W2 „Titel W2“ (noch nicht gestartet). W3 nutzt die API aus W2.');

    // the owner starts W2: W3 waits for it, so W2 does not wait for W3
    k.request(w2.id);
    await settle();
    expect(estimates().at(-1)!.inbox[0]).not.toContain('Titel W3');
    await scope(['src/w2.ts']);
    expect(item(w2.id).state).toBe('working');
    expect(item(w3.id).queue).toMatchObject({ behind: [w2.id] });

    // W3 is queued ahead of W4, and no workstream is left unstarted
    k.request(w4.id);
    await settle();
    expect(estimates().at(-1)!.inbox[0]).toContain(`- ${tag(w3)}: "Titel W3"`);
    expect(estimates().at(-1)!.inbox[0]).not.toContain('not started');
    await scope(['src/w4.ts']);
    expect(item(w4.id).state).toBe('working');

    await land(w2.id);
    expect(item(w2.id).state).toBe('live');
    // W4 runs still: W3 is judged again against it
    expect(item(w3.id).queue).toMatchObject({ checking: true });
    await scope(['src/w3.ts']);
    expect(item(w3.id).state).toBe('working');
  });

  test('taken out of the queue or stopped, a workstream still holds back what builds on it; a conflict does not', async () => {
    const { w2, w3, w4 } = project();
    k.request(w2.id);
    await scope(['src/w2.ts']);
    k.request(w3.id);
    await scope(['src/w3.ts'], [], 'Baut auf W2 auf.', [tag(w2)]);
    k.request(w4.id);
    await scope(['src/w2.ts'], [tag(w2)], 'Beide ändern src/w2.ts.');
    expect(item(w3.id).queue).toMatchObject({ behind: [w2.id], buildsOn: [w2.id] });
    expect(item(w4.id).queue).toMatchObject({ behind: [w2.id] });

    await workers.stop(w2.id);
    await settle();
    // W4 only collided with W2, and nothing runs now: it starts
    expect(item(w4.id).state).toBe('working');
    // W3 builds on it: it waits until W2 has landed, which the owner sees
    expect(item(w3.id).queue).toMatchObject({ behind: [w2.id], buildsOn: [w2.id] });
    expect(item(w2.id)).toMatchObject({ state: 'planned' });
    expect(item(w2.id).queue).toBeUndefined();

    // started anyway, it goes without waiting
    k.force(w3.id);
    await settle();
    expect(item(w3.id).state).toBe('working');
    expect(board.events(w3.id).some((e) => e.text === 'Trotzdem gestartet, ohne zu warten.')).toBe(true);
  });

  test('the start waits a few seconds, in which the owner can take it back', async () => {
    k = new Coordinator({ board, runtime, home: () => dir, repoFor: () => ({ workers, workspaces, adapter: generic, path: dir }), holdMs: 40 });
    const { p, w2, w3, w4 } = project();
    k.request(p.id);
    await Bun.sleep(5);
    expect(schedules()).toHaveLength(0);
    k.dequeue(p.id);
    expect([w2, w3, w4].map((w) => item(w.id).queue)).toEqual([undefined, undefined, undefined]);
    expect(board.events(p.id).at(-1)!.text).toBe('Start zurückgenommen: W2, W3, W4.');
    await new Promise((r) => setTimeout(r, 60));
    expect(schedules()).toHaveLength(0);
    expect(() => k.dequeue(p.id)).toThrow(expect.objectContaining({ code: 'notQueued' }));

    // once the Coordinator has planned them, it is too late
    k.request(p.id);
    await new Promise((r) => setTimeout(r, 60));
    await schedule([
      [tag(w2), [], [], [], ''],
      [tag(w3), [], [], [], ''],
      [tag(w4), [], [], [], ''],
    ]);
    expect(() => k.dequeue(p.id)).toThrow(expect.objectContaining({ code: 'notQueued' }));
  });
});

describe('preference memory', () => {
  let l: Learner;
  beforeEach(() => {
    l = new Learner({ board, runtime, home: () => board.canvas.repos[0]!.path, pathFor: () => board.canvas.repos[0]!.path });
  });
  const learnSession = () => runtime.withTool('propose').at(-1)!;
  const learn = async (tool: string, args: Record<string, unknown>) => {
    learnSession().call(tool, args);
    learnSession().emit({ type: 'idle' });
    await settle();
  };
  const texts = (...states: ('proposed' | 'active' | 'rejected')[]) => board.preferences(...states).map((p) => p.text);

  test('a lasting preference is proposed with its occasion and applies once the owner accepts it; a one-off is not', async () => {
    const a = card('Labels');
    l.learn(item(a.id), 'answer', 'Präzise, auch wenn es länger wird. Das gilt immer.', { question: 'Kurz oder präzise?' });
    await settle();
    expect(learnSession().inbox[0]).toContain('Kurz oder präzise?');
    await learn('propose', { rule: 'Beschriftungen: präzise vor kurz.' });
    expect(board.preferences()).toEqual([
      { id: 1, text: 'Beschriftungen: präzise vor kurz.', state: 'proposed', cardId: a.id, quote: 'Präzise, auch wenn es länger wird. Das gilt immer.' },
    ]);
    expect(board.events(a.id).at(-1)!.text).toBe('Schlägt vor: „Beschriftungen: präzise vor kurz.“');
    // agents do not follow it yet, and the next learner does not count it among the rules
    expect(board.preferencesText()).toBe('');
    expect(board.snapshot().preferences.map((p) => p.state)).toEqual(['proposed']);

    board.acceptProposal(1);
    expect(texts('active')).toEqual(['Beschriftungen: präzise vor kurz.']);
    expect(board.preferencesText()).toContain('- Beschriftungen: präzise vor kurz.');

    l.learn(item(a.id), 'answer', 'Donnerstag.', { question: 'Wann ist der Termin?' });
    await settle();
    await learn('nothing', {});
    expect(board.preferences()).toHaveLength(1);
  });

  test('a learned change to a rule takes its place once accepted, in the owner\'s words if they edit it', async () => {
    board.addPreference('Tests immer auf Deutsch benennen.');
    const old = board.addPreference('Beschriftungen: präzise vor kurz.');
    const a = card('Labels');
    l.learn(item(a.id), 'feedback', 'Und immer mit Einheit.');
    await settle();
    expect(learnSession().inbox[0]).toContain('2. Beschriftungen: präzise vor kurz.');
    await learn('propose', { rule: 'Beschriftungen: präzise vor kurz, mit Einheit.', replaces: 2 });
    const [p] = board.preferences('proposed');
    expect(p).toMatchObject({ replaces: old, quote: 'Und immer mit Einheit.' });
    // until then, the old rule stands
    expect(board.preferencesText()).toEndWith('- Beschriftungen: präzise vor kurz.');

    board.acceptProposal(p!.id, 'Beschriftungen: präzise vor kurz, Zahlen immer mit Einheit.');
    expect(texts('active')).toEqual(['Tests immer auf Deutsch benennen.', 'Beschriftungen: präzise vor kurz, Zahlen immer mit Einheit.']);
    expect(texts()).not.toContain('Beschriftungen: präzise vor kurz.');
    expect(() => board.acceptProposal(p!.id)).toThrow();
  });

  test('a rejected proposal is kept but applies nowhere; a rule the owner writes applies at once', async () => {
    const a = card('A');
    l.learn(item(a.id), 'note', 'Bitte nie wieder Emojis.');
    await settle();
    await learn('propose', { rule: 'Keine Emojis in Texten.' });
    const [p] = board.preferences('proposed');
    board.rejectProposal(p!.id);
    expect(texts('rejected')).toEqual(['Keine Emojis in Texten.']);
    // the learner sees it, and the proposals still waiting, so neither comes back
    board.proposePreference('Commits auf Englisch.', { cardId: a.id });
    l.learn(item(a.id), 'note', 'Wirklich keine Emojis, und Commits auf Englisch.');
    await settle();
    expect(learnSession().inbox[0]).toContain('rejected (do not propose them again):\n- Keine Emojis in Texten.');
    expect(learnSession().inbox[0]).toContain('waiting for the owner (do not propose them again):\n- Commits auf Englisch.');
    await learn('propose', { rule: 'Commits auf Englisch.' });
    expect(texts('proposed')).toEqual(['Commits auf Englisch.']);
    board.rejectProposal(board.preferences('proposed')[0]!.id);
    expect(board.snapshot().preferences).toEqual([]);
    expect(board.preferencesText()).toBe('');
    expect(() => board.rejectProposal(p!.id)).toThrow();

    board.addPreference('Commits auf Englisch.');
    expect(board.preferences()).toMatchObject([{ state: 'rejected' }, { state: 'rejected' }, { text: 'Commits auf Englisch.', state: 'active' }]);
  });

  test('what the owner says without a card is read in the home checkout and proposed without one', async () => {
    l.learn(null, 'talk', 'Warum fragt der Agent immer nach Kleinkram?', { reply: 'Weil die Karte offen lässt, wie weit er gehen soll.' });
    await settle();
    const brief = learnSession().inbox[0]!;
    expect(learnSession().spec.cwd).toBe(board.canvas.repos[0]!.path);
    expect(brief).not.toContain('Card');
    expect(brief).toContain("The owner's question or remark to you: Warum fragt der Agent immer nach Kleinkram?");
    expect(brief).toContain('You replied: Weil die Karte offen lässt');
    await learn('propose', { rule: 'Kleinkram selbst entscheiden.' });
    expect(board.preferences()).toEqual([{ id: 1, text: 'Kleinkram selbst entscheiden.', state: 'proposed', quote: 'Warum fragt der Agent immer nach Kleinkram?' }]);
  });

  test('a rule about a repository is proposed for its CLAUDE.md, accepted into its card "Add to CLAUDE.md", and reaches no agent', async () => {
    const a = card('Export');
    l.learn(item(a.id), 'note', 'Tests schreiben wir hier immer auf Deutsch.');
    await settle();
    expect(learnSession().inbox[0]).toContain(`The canvas's repositories (ids for repos):\n- home: Home, at ${board.canvas.repos[0]!.path} (the card's)`);
    expect(learnSession().spec.system).toContain("A repository's CLAUDE.md, for anything about a repository");
    // a repository the canvas does not have is refused, and the learner may try again
    expect(learnSession().call('propose', { rule: 'Tests auf Deutsch benennen.', repos: ['web'] })).toContain('Unknown repository web');
    await learn('propose', { rule: 'Tests auf Deutsch benennen.', repos: ['home'] });
    const [p] = board.preferences('proposed');
    expect(p).toMatchObject({ text: 'Tests auf Deutsch benennen.', target: 'home', cardId: a.id });

    board.acceptProposal(p!.id);
    expect(board.preferences('filed')).toMatchObject([{ id: p!.id, state: 'filed', target: 'home' }]);
    expect(board.preferencesText()).toBe('');
    expect(board.snapshot().preferences).toEqual([]);
    const collect = board.collecting('home')!;
    expect(collect).toMatchObject({ title: 'CLAUDE.md ergänzen', state: 'planned', kind: 'task' });
    expect(collect.body).toEndWith('\n\n- Tests auf Deutsch benennen.');

    // the next learner knows it is on its way; a rule for the preferences can be moved to a CLAUDE.md, and back
    l.learn(item(a.id), 'note', 'Und Commits auf Englisch, immer.');
    await settle();
    expect(learnSession().inbox[0]).toContain("Rules the owner accepted for a repository's CLAUDE.md (in it or on their way; do not propose them again):\n- Tests auf Deutsch benennen. (for the CLAUDE.md of home)");
    await learn('propose', { rule: 'Commits auf Englisch.' });
    board.acceptProposal(board.preferences('proposed')[0]!.id, undefined, 'home');
    const back = board.proposePreference('Fragen mit höchstens drei Optionen.', {}, undefined, 'home');
    board.acceptProposal(back, undefined, null);
    expect(board.preferencesText()).toContain('- Fragen mit höchstens drei Optionen.');
    expect(board.collecting('home')!.id).toBe(collect.id);
    expect(board.collecting('home')!.body).toEndWith('- Tests auf Deutsch benennen.\n- Commits auf Englisch.');

    // once it runs, the next rule starts a new card
    k.request(collect.id);
    expect(board.collecting('home')).toBeUndefined();
    board.acceptProposal(board.proposePreference('Keine any-Typen.', {}, undefined, 'home'));
    expect(board.collecting('home')!.id).not.toBe(collect.id);
    expect(() => board.proposePreference('X.', {}, undefined, 'web')).toThrow();
  });

  test('the learner sees the text a card had before the owner wrote in it', async () => {
    const a = card('Export');
    l.learn(item(a.id), 'card', 'Befund: Datum fehlt.\n\nImmer ISO-Datum.', { before: 'Befund: Datum fehlt.' });
    await settle();
    expect(learnSession().inbox[0]).toContain("Before the owner wrote in it, the card's text read:\nBefund: Datum fehlt.");
    expect(learnSession().inbox[0]).toContain("The owner's text of a card they wrote, the task for an agent: Befund: Datum fehlt.");
  });

  test('the learner reads an input with the card, what the owner said in the last days and the agent\'s last message, and proposes once', async () => {
    const before = card('Import');
    board.log(before.id, 'hint', 'owner', 'Frag nicht nach jedem Dateinamen.');
    board.undoTalk(board.addTalk('Starte alles.', 'Gestartet.'));
    board.addTalk('Wie weit ist der Export?', 'Fast fertig.');
    const a = board.create({ title: 'Export', body: 'CSV-Export der Rechnungen.', x: 0, y: 0 });
    board.log(a.id, 'say', 'worker', 'Soll die Datei rechnungen.csv oder export.csv heißen?');
    board.log(a.id, 'activity', 'worker', 'Liest src/export.ts');
    board.log(a.id, 'hint', 'owner', 'Schon wieder: entscheide Dateinamen selbst.');
    l.learn(item(a.id), 'note', 'Schon wieder: entscheide Dateinamen selbst.');
    // the worker answers before the learner's turn: the learner still reads what the note answered
    board.log(a.id, 'say', 'worker', 'Gut, export.csv.');
    await settle();
    const brief = learnSession().inbox[0]!;
    expect(brief).toContain("The card's text:\nCSV-Export der Rechnungen.");
    expect(brief).toContain("The agent's last message on the card before it:\nSoll die Datei rechnungen.csv oder export.csv heißen?");
    const recent = brief.slice(brief.indexOf('What the owner said in the last'), brief.indexOf("The agent's last message"));
    expect(recent).toContain('to the agent on "Import": Frag nicht nach jedem Dateinamen.');
    expect(recent).toContain('to you: Wie weit ist der Export?');
    // neither what was taken back nor the input itself
    expect(recent).not.toContain('Starte alles.');
    expect(recent).not.toContain('Schon wieder');
    expect(brief).toContain("The owner's note to the worker: Schon wieder: entscheide Dateinamen selbst.");

    learnSession().call('propose', { rule: 'Dateinamen entscheidet der Agent selbst.' });
    await learn('propose', { rule: 'Nicht nach Kleinkram fragen.' });
    expect(texts('proposed')).toEqual(['Dateinamen entscheidet der Agent selbst.']);
  });

  test('workers get the rules, and what the owner tells them is offered for learning', async () => {
    board.addPreference('Tests immer auf Deutsch benennen.');
    const heard: string[] = [];
    const w = new Workers({
      board,
      runtime,
      workspaces,
      adapter: { ...generic, land: 'main', workspaces: 'worktrees', softPaths: [] },
      preferences: () => board.preferencesText(),
      onOwnerInput: (_c, kind, text) => heard.push(`${kind}:${text}`),
    });
    const a = card('A');
    await w.start(a.id);
    const s = workerOf(a.id);
    expect(s.spec.system).toContain('Tests immer auf Deutsch benennen.');
    s.call('ask', { question: 'Q?' });
    w.answer(a.id, 'Ja.');
    w.message(a.id, 'Bitte kleiner schneiden.');
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    w.message(a.id, 'Noch die Einheit.');
    s.call('ask', { question: 'Zeitzone?' });
    w.message(a.id, 'UTC.');
    expect(heard).toEqual([
      'answer:Ja.',
      'note:Bitte kleiner schneiden.',
      'feedback:Noch die Einheit.',
      'note:UTC.',
    ]);
    w.shutdown();
  });
});

describe('retrospective', () => {
  const texts = (state: 'proposed' | 'active') => board.preferences(state).map((p) => p.text);
  const reviews = () => runtime.withTool('done');
  const newLearner = () => new Learner({ board, runtime, home: () => board.canvas.repos[0]!.path, pathFor: () => board.canvas.repos[0]!.path, reviewEvery: 4 });

  test('after enough inputs, counted across a restart, it reads the history since the last one and proposes rules from it', async () => {
    let l1 = newLearner();
    l1.noticed();
    // what the owner said and clicked meanwhile
    const a = card('Export');
    board.log(a.id, 'hint', 'owner', 'Bitte ohne Emojis.');
    board.log(a.id, 'state', 'owner', 'Trotz Überschneidung gestartet.');
    const p = board.propose(a.id, { title: 'Emoji-Picker', task: 'S.', reason: 'R.' });
    board.remove(p.id);
    board.undoTalk(board.addTalk('Lösch die Karte Export.', 'Mache ich.', { card: a.id }));
    board.rejectProposal(board.proposePreference('Commits auf Englisch.', { cardId: a.id, quote: 'Englisch bitte.' }));
    l1.noticed();
    expect(board.setting('review_inputs')).toBe('2');

    // Obeya starts again: the count goes on
    l1 = newLearner();
    l1.noticed();
    expect(reviews()).toHaveLength(0);
    // the input that completes the count is read on its own first
    board.log(a.id, 'hint', 'owner', 'Wieder Emojis. Lass das.');
    l1.learn(item(a.id), 'note', 'Wieder Emojis. Lass das.');
    await settle();
    expect(reviews()).toHaveLength(0);
    const learner = runtime.sessions.at(-1)!;
    learner.call('nothing', {});
    learner.emit({ type: 'idle' });
    await settle();
    expect(reviews()).toHaveLength(1);
    expect(board.setting('review_inputs')).toBe('0');

    const s = reviews()[0]!;
    expect(s.spec).toMatchObject({ cwd: board.canvas.repos[0]!.path, readOnly: true });
    const brief = s.inbox[0]!;
    for (const line of [
      '"Export": the owner created the card',
      '"Export": the owner wrote to the agent: Bitte ohne Emojis.',
      '"Export": the owner: Trotz Überschneidung gestartet.',
      'the owner dismissed the card an agent proposed: "Emoji-Picker"',
      'the owner to you (with "Export" open): Lösch die Karte Export. → Mache ich. (the owner took it back)',
      'the owner rejected the proposed rule "Commits auf Englisch." (its occasion: Englisch bitte.)',
      '"Export": the owner wrote to the agent: Wieder Emojis. Lass das.',
      'Proposals the owner rejected (do not propose them again):\n- Commits auf Englisch.',
    ])
      expect(brief).toContain(line);
    s.call('propose', { rule: 'Keine Emojis in Texten.', why: 'Auf „Export“ zweimal gesagt, den Emoji-Picker verworfen.' });
    s.call('propose', { rule: 'Keine Emojis in Texten.', why: 'Doppelt.' });
    s.call('done', {});
    s.emit({ type: 'idle' });
    await settle();
    expect(board.preferences('proposed')).toEqual([{ id: 2, text: 'Keine Emojis in Texten.', state: 'proposed', quote: 'Auf „Export“ zweimal gesagt, den Emoji-Picker verworfen.', review: true }]);

    // the next one reads only what came after
    for (let n = 0; n < 3; n++) l1.noticed();
    expect(reviews()).toHaveLength(1);
    board.log(a.id, 'hint', 'owner', 'Und kürzer.');
    l1.noticed();
    await settle();
    expect(reviews()).toHaveLength(2);
    expect(reviews()[1]!.inbox[0]).toContain('Und kürzer.');
    expect(reviews()[1]!.inbox[0]).not.toContain('Bitte ohne Emojis.');
    expect(reviews()[1]!.inbox[0]).toContain('Proposals waiting for the owner (do not propose them again):\n- Keine Emojis in Texten.');
  });

  test('it proposes at most three rules, and nothing when nothing happened', async () => {
    const l1 = newLearner();
    for (let n = 0; n < 4; n++) l1.noticed();
    await settle();
    // nothing on the canvas since: no session
    expect(reviews()).toHaveLength(0);
    board.log(card('A').id, 'hint', 'owner', 'X.');
    for (let n = 0; n < 4; n++) l1.noticed();
    await settle();
    const s = reviews()[0]!;
    for (const rule of ['Eins.', 'Zwei.', 'Drei.', 'Vier.']) s.call('propose', { rule, why: 'W.' });
    expect(texts('proposed')).toEqual(['Eins.', 'Zwei.', 'Drei.']);
  });

  test('it proposes a rule about a repository for its CLAUDE.md, and reads an accepted one as such', async () => {
    const l1 = newLearner();
    const a = card('A');
    board.acceptProposal(board.proposePreference('Tests auf Deutsch.', { cardId: a.id }, undefined, 'home'));
    for (let n = 0; n < 4; n++) l1.noticed();
    await settle();
    const s = reviews()[0]!;
    expect(s.inbox[0]).toContain('the owner accepted the proposed rule "Tests auf Deutsch." for the CLAUDE.md of home');
    s.call('propose', { rule: 'Keine any-Typen.', why: 'W.', repos: ['home'] });
    expect(board.preferences('proposed')).toMatchObject([{ text: 'Keine any-Typen.', target: 'home', review: true }]);
  });
});

test('parseChanges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,2 +10,4 @@ function decide() {',
    '+--- a/not-a-file',
    '@@ -30 +32 @@',
    '@@ -40,3 +41,0 @@ class K {',
    'diff --git a/old.ts b/old.ts',
    'deleted file mode 100644',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
  ].join('\n');
  expect(parseChanges(diff)).toEqual([
    { file: 'src/a.ts', regions: ['10-13 in function decide() {', '32', '41 (lines removed) in class K {'] },
    { file: 'old.ts', regions: ['deleted'] },
  ]);
});

test('overlaps', () => {
  expect(overlaps('src/a.ts', 'src/a.ts')).toBe(true);
  expect(overlaps('src/', 'src/a.ts')).toBe(true);
  expect(overlaps('src/ui/a.ts', 'src/')).toBe(true);
  expect(overlaps('src/a.ts', 'src/ab.ts')).toBe(false);
  expect(overlaps('src', 'src/a.ts')).toBe(false);
});

describe('Coordinator arranges a project by what builds on what', () => {
  const ws = (key: string, done = false) => ({ key, label: key, title: `Titel ${key}`, body: `Text ${key}`, done, inReview: false });
  const readings = () => runtime.withTool('dependencies');
  /** A project with W1 live and W2 to W4 planned, just come. */
  function project() {
    docs = [{ file: 'docs/plan/p.md', title: 'P', goal: 'Ziel P', workstreams: [ws('W1', true), ws('W2'), ws('W3'), ws('W4')], markdown: '' }];
    board.docsChanged();
    const [p, w1, w2, w3, w4] = board.snapshot().items;
    return { p: p!, w1: w1!, w2: w2!, w3: w3!, w4: w4! };
  }
  /** Answers the latest open reading: what each tag builds on. */
  async function read(on: Record<string, string[]>) {
    await settle();
    const s = readings().at(-1)!;
    const r = s.call('dependencies', { workstreams: Object.entries(on).map(([card, builds_on]) => ({ card, builds_on })) });
    s.emit({ type: 'idle' });
    await settle();
    return r;
  }

  test('a project just come is read without anything else looking at the canvas first', async () => {
    docs = [{ file: 'docs/plan/p.md', title: 'P', goal: 'Ziel P', workstreams: [ws('W1'), ws('W2')], markdown: '' }];
    board.docsChanged();
    await settle();
    expect(readings()).toHaveLength(1);
  });

  test('a project just come is read and stands in columns: what can start at once on the left', async () => {
    const { p, w1, w2, w3, w4 } = project();
    expect(item(p.id).arranging).toBe(true);
    await settle();
    expect(readings()).toHaveLength(1);
    const brief = readings()[0]!.inbox[0]!;
    expect(brief).toContain('plan doc docs/plan/p.md');
    expect(brief).toContain(`- ${tag(w1)} (delivered): W1 "Titel W1"`);
    expect(brief).toContain(`- ${tag(w3)}: W3 "Titel W3" — Text W3`);
    // W2 builds on W4, W3 on W2 and on the delivered W1
    await read({ [tag(w2)]: [tag(w4)], [tag(w3)]: [tag(w2), tag(w1)], [tag(w4)]: [] });
    expect(item(p.id).arranging).toBeUndefined();
    expect(item(w2.id).buildsOn).toEqual([w4.id]);
    expect(item(w3.id).buildsOn).toEqual([w2.id, w1.id]);
    const x = (id: string) => item(id).x;
    expect(x(w4.id)).toBeLessThan(x(w2.id));
    expect(x(w2.id)).toBeLessThan(x(w3.id));
    expect(item(w1.id).y).toBeLessThan(item(w4.id).y);
  });

  test('every open workstream once: a reading that leaves one out is asked again', async () => {
    const { w2, w3, w4 } = project();
    await settle();
    expect(readings()[0]!.call('dependencies', { workstreams: [{ card: tag(w2), builds_on: [] }] })).toContain(`missing ${tag(w3)}, ${tag(w4)}`);
  });

  test('a card the owner moved before the reading came keeps its place; the reading is kept', async () => {
    const { p, w2, w3, w4 } = project();
    board.patch(w3.id, { x: 900, y: 500 });
    await read({ [tag(w2)]: [tag(w4)], [tag(w3)]: [], [tag(w4)]: [] });
    expect(item(w3.id)).toMatchObject({ x: 900, y: 500 });
    expect(item(w2.id).x).toBe(w2.x);
    expect(item(w2.id).buildsOn).toEqual([w4.id]);
    expect(board.deps(p.id).current).toBe(true);
  });

  test('asked to arrange, it uses what it read for the doc as it stands, and reads again once the doc changed', async () => {
    const { p, w2, w3, w4 } = project();
    board.patch(w2.id, { x: 900, y: 500 });
    await read({ [tag(w2)]: [tag(w4)], [tag(w3)]: [], [tag(w4)]: [] });
    await k.arrange(p.id);
    expect(readings()).toHaveLength(1);
    expect(item(w2.id).x).toBeGreaterThan(item(w4.id).x);

    docs = [{ ...docs[0]!, workstreams: [ws('W1', true), ws('W2'), ws('W3'), { ...ws('W4'), body: 'Baut auf W3 auf.' }] }];
    board.docsChanged();
    expect(board.deps(p.id).current).toBe(false);
    const done = k.arrange(p.id);
    expect(item(p.id).arranging).toBe(true);
    await read({ [tag(w2)]: [tag(w4)], [tag(w3)]: [], [tag(w4)]: [tag(w3)] });
    await done;
    expect(readings()).toHaveLength(2);
    // W3, then W4, then W2: three columns
    expect(item(w4.id).x).toBeGreaterThan(item(w3.id).x);
    expect(item(w2.id).x).toBeGreaterThan(item(w4.id).x);
  });

  test('a reading that fails leaves the cards where they are and says so', async () => {
    const { p, w2 } = project();
    board.patch(w2.id, { x: 900, y: 500 });
    await settle();
    readings()[0]!.emit({ type: 'error', message: 'kaputt' });
    await settle();
    expect(item(p.id).arranging).toBeUndefined();
    const done = k.arrange(p.id);
    await settle();
    readings()[1]!.emit({ type: 'error', message: 'kaputt' });
    await expect(done).rejects.toMatchObject({ code: 'arrangeFailed' });
    expect(item(w2.id)).toMatchObject({ x: 900, y: 500 });
  });
});
