import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PlanDoc, parsePlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { planHistory } from './repo';
import { gitRepo } from './testing';
import { git } from './workspaces';

const FILE = 'docs/plan/audit.md';
const md = (items: string[]) => `# Audit\n\n## Goal\n\nFix the findings.\n\n## Workstreams\n\n${items.map((i) => `- ${i}`).join('\n')}\n`;
const parse = (items: string[]) => parsePlanDoc(FILE, md(items)) as PlanDoc;
/** The doc as an older Obeya read it: each workstream keyed by its place (`#n`). */
const positional = (doc: PlanDoc): PlanDoc => ({ ...doc, workstreams: doc.workstreams.map((w, i) => ({ ...w, key: `#${i + 1}`, label: undefined, title: w.label ? `${w.label} ${w.title}` : w.title })) });

const OLD = ['[x] **1G Testlücken schließen.** Only tests.', '[ ] **3B Auth zusammenführen.** One auth service.', '[ ] **3C Gleichzeitige Bearbeitung.** Row versions.'];
const NEW = ['[ ] **4A Sitzungen und Mandantensperre.** Revoke tokens.', '[ ] **3B Auth zusammenführen.** One auth service.', '[ ] **3C Gleichzeitige Bearbeitung.** Row versions.'];

let store: Store;
let docs: PlanDoc[];
let board: Board;
let history: PlanDoc[];

beforeEach(() => {
  store = new Store(':memory:');
  history = [];
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs, dirs: [] }));
  board.readPlanHistory(() => history.flatMap((d) => d.workstreams));
});

const kids = () => board.snapshot().items.filter((i) => i.parent);
const read = (d: PlanDoc) => {
  docs = [d];
  board.docsChanged();
  return kids();
};
/** An agent worked on the card while it showed `title`: its branch is named after it. */
const work = (id: string, title: string, fields: Parameters<Store['update']>[1] = {}) => {
  const branch = `obeya/${title.toLowerCase().replace(/ü/g, 'u').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}`;
  store.update(id, { session_id: 's', ...fields });
  board.log(id, 'state', 'obeya', `Agent gestartet auf ${branch}.`);
};

describe('a workstream card keeps its workstream', () => {
  test('cards stay with their labels when the doc drops, adds and reorders workstreams', () => {
    const [g, b, c] = read(parse(OLD));
    expect([g, b, c].map((k) => [k!.label, k!.title])).toEqual([
      ['1G', 'Testlücken schließen'],
      ['3B', 'Auth zusammenführen'],
      ['3C', 'Gleichzeitige Bearbeitung'],
    ]);
    work(b!.id, 'Auth zusammenführen', { state: 'planned' });
    const after = read(parse(NEW));
    expect(after.map((k) => k.label)).toEqual(['4A', '3B', '3C']);
    expect(after.find((k) => k.label === '3B')!.id).toBe(b!.id);
    expect(after.find((k) => k.label === '3C')!.id).toBe(c!.id);
    expect(after.find((k) => k.label === '4A')!.id).not.toBe(g!.id);
  });

  test('an unlabelled workstream is known by its title, also with a pull request before it', () => {
    const [one, two] = read(parse(['[ ] First thing. Details', '[ ] Second thing. Details']));
    const after = read(parse(['[ ] New thing on top', '[x] #12. Second thing. Details', '[ ] First thing. Details']));
    expect(after.map((k) => [k.title, k.id === one!.id, k.id === two!.id])).toEqual([
      ['New thing on top', false, false],
      ['#12. Second thing', false, true],
      ['First thing', true, false],
    ]);
  });

  test('a card an agent worked on leaves the project when its workstream leaves the doc; finished, into the archive', () => {
    const [g, b, c] = read(parse(OLD));
    work(g!.id, '1G Testlücken schließen', { state: 'done' });
    work(c!.id, 'Gleichzeitige Bearbeitung', { state: 'working' });
    read(parse([NEW[0]!]));
    expect(board.archived().find((i) => i.id === g!.id)).toMatchObject({ title: '1G Testlücken schließen', body: 'Only tests.', state: 'done' });
    expect(board.events(g!.id).at(-1)!.text).toBe('Hat das Projekt „Audit“ verlassen: Das Plan-Doc führt diesen Workstream nicht mehr.');
    // at work, it stands beside the project
    const items = board.snapshot().items;
    const project = items.find((i) => i.kind === 'project')!;
    expect(items.find((i) => i.id === c!.id)).toMatchObject({ title: '3C Gleichzeitige Bearbeitung', state: 'working', source: 'manual' });
    expect(items.find((i) => i.id === c!.id)!.x).toBeGreaterThan(project.x);
    // nobody worked on it: it just goes
    expect(items.some((i) => i.id === b!.id)).toBe(false);
    expect(board.archived().some((i) => i.id === b!.id)).toBe(false);
  });
});

describe('cards of a doc read by an older Obeya', () => {
  test('a card holding another workstream’s log leaves the project, and the workstream gets a fresh card in its place', () => {
    // as the bug left it: the doc was read anew, and 3B took the card of 1G at its place
    history = [parse(OLD)];
    docs = [positional(parse(NEW))];
    const [a, b, c] = kids();
    expect(b!.title).toBe('3B Auth zusammenführen');
    work(b!.id, '1G Testlücken schließen', { state: 'done' });
    work(a!.id, '4A Sitzungen und Mandantensperre', { state: 'planned' });
    board.patch(b!.id, { x: 900, y: 500 });

    // the new Obeya reads the same doc
    const after = read(parse(NEW));
    expect(after.map((k) => [k.label, k.state])).toEqual([
      ['4A', 'planned'],
      ['3B', 'planned'],
      ['3C', 'planned'],
    ]);
    expect(after[0]!.id).toBe(a!.id);
    expect(after[2]!.id).toBe(c!.id);
    // 3B is a fresh card where the old one stood
    expect(after[1]!.id).not.toBe(b!.id);
    expect(after[1]).toMatchObject({ x: 900, y: 500 });
    expect(board.events(after[1]!.id)).toEqual([]);
    // the card with 1G's log is done, in the archive, under 1G's title
    expect(board.archived().find((i) => i.id === b!.id)).toMatchObject({ title: '1G Testlücken schließen', state: 'done', source: 'manual' });
    expect(board.events(b!.id).at(-1)!.text).toContain('Dieser Verlauf gehört zu einem Workstream, den das Plan-Doc nicht mehr führt');
  });

  test('a card whose workstream moved in the doc follows it there', () => {
    docs = [positional(parse(OLD))];
    const [g, b] = kids();
    work(b!.id, '3B Auth zusammenführen', { state: 'planned' });
    // the doc changed while the older Obeya did not look: 3B is first now
    const moved = parse([OLD[1]!, OLD[0]!, OLD[2]!]);
    store.update(store.projects('c')[0]!.id, { plan: JSON.stringify(positional(moved)) });
    const after = read(moved);
    expect(after.find((k) => k.label === '3B')!.id).toBe(b!.id);
    expect(after.find((k) => k.label === '1G')!.id).not.toBe(b!.id);
    expect(g).toBeDefined();
  });
});

describe('taking a workstream card out of its project', () => {
  test('the card stands beside the project with its log, the workstream gets a fresh card; undo puts it back', () => {
    const [, b] = read(parse(OLD));
    work(b!.id, '1G Testlücken schließen', { state: 'done' });
    history = [parse(OLD)];
    const { ref } = board.detach(b!.id);
    const items = board.snapshot().items;
    expect(items.find((i) => i.id === b!.id)).toMatchObject({ title: '1G Testlücken schließen', state: 'done', source: 'manual' });
    expect(items.find((i) => i.id === b!.id)!.parent).toBeUndefined();
    const fresh = items.find((i) => i.label === '3B')!;
    expect(fresh).toMatchObject({ state: 'planned', x: b!.x, y: b!.y });
    expect(board.events(b!.id).at(-1)!.text).toBe('Vom Projekt „Audit“ gelöst; der Workstream hat dort eine neue Karte.');

    board.attach(b!.id, ref);
    const back = kids().find((k) => k.label === '3B')!;
    expect(back).toMatchObject({ id: b!.id, x: b!.x, y: b!.y });
    expect(board.snapshot().items.some((i) => i.id === fresh.id)).toBe(false);
  });

  test('a workstream an agent is at work on stays; a card that is no workstream cannot be detached', () => {
    const [g] = read(parse(OLD));
    store.update(g!.id, { state: 'working' });
    expect(() => board.detach(g!.id)).toThrow(BadRequest);
    const own = board.create({ title: 'Own', x: 0, y: 0 });
    expect(() => board.detach(own.id)).toThrow(BadRequest);
  });
});

describe('planHistory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-plan-history-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads every workstream a doc was given, the newest first', () => {
    const repo = gitRepo(join(dir, 'r'), { [FILE]: md(OLD) });
    writeFileSync(join(repo, FILE), md(NEW));
    git(repo, 'commit', '-qam', 'new workstreams');
    const seen = planHistory(repo, FILE).map((w) => w.label);
    expect(seen.indexOf('4A')).toBeLessThan(seen.indexOf('1G'));
    expect(planHistory(repo, FILE).find((w) => w.label === '1G')).toMatchObject({ title: 'Testlücken schließen', body: 'Only tests.' });
    expect(planHistory(repo, 'docs/plan/none.md')).toEqual([]);
  });
});
