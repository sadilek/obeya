import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeWorkstreams } from '../core/layout';
import { type PlanDoc, parsePlanDoc } from '../core/plan-doc';
import { Board, LEAVE_AFTER_MS } from './board';
import { Store } from './db';
import { planHistory } from './repo';
import { gitRepo } from './testing';
import { branchName, git } from './workspaces';

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
  const branch = branchName(title, id);
  store.update(id, { session_id: 's', ...fields });
  board.log(id, 'state', 'obeya', `Agent gestartet auf ${branch}.`);
  board.docsChanged();
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

describe('a sibling dropped or added changes no card’s workstream', () => {
  test('a code alone in the doc stops being a label, and the card stays', () => {
    const [a, b] = read(parse(['[ ] **4A Sitzungen.** Revoke.', '[ ] **3B Auth.** One.']));
    work(a!.id, '4A Sitzungen', { state: 'planned' });
    const after = read(parse(['[ ] **4A Sitzungen.** Revoke.']));
    expect(after.map((k) => [k.id, k.title])).toEqual([[a!.id, '4A Sitzungen']]);
    expect(board.archived()).toEqual([]);
    // and back: a second code makes it a label again
    expect(read(parse(['[ ] **4A Sitzungen.** Revoke.', '[ ] **5C Neu.** New.'])).map((k) => [k.label, k.id === a!.id])).toEqual([
      ['4A', true],
      ['5C', false],
    ]);
    expect(b).toBeDefined();
  });

  test('a label given twice: the one left keeps its card, and a second one added finds the card by its title', () => {
    const [up, down] = read(parse(['[ ] **W1:** Upload. x', '[ ] **W1:** Download. y']));
    work(down!.id, 'W1 Download', { state: 'planned' });
    expect(read(parse(['[ ] **W1:** Download. y'])).map((k) => k.id)).toEqual([down!.id]);
    const again = read(parse(['[ ] **W1:** Upload. x', '[ ] **W1:** Download. y']));
    expect(again.map((k) => [k.title, k.id === down!.id])).toEqual([
      ['Upload', false],
      ['Download', true],
    ]);
    expect(board.archived()).toEqual([]);
    expect(up).toBeDefined();
  });
});

describe('a card follows its own workstream, not one that would have had its key', () => {
  test('a hidden card of a dropped workstream gives way to the card with the log', () => {
    const [up, down] = read(parse(['[ ] **W1:** Upload. x', '[ ] **W1:** Download. y']));
    read(parse(['[ ] **W1:** Download. y']));
    // the doc rewords the one left, and an agent works on it
    expect(read(parse(['[ ] **W1:** Upload. x'])).map((k) => k.id)).toEqual([down!.id]);
    work(down!.id, 'W1 Upload', { state: 'planned' });
    const after = read(parse(['[ ] **W1:** Upload. x', '[ ] **W1:** Download. y']));
    expect(after.map((k) => [k.title, k.id === down!.id])).toEqual([
      ['Upload', true],
      ['Download', false],
    ]);
    expect(after.some((k) => k.id === up!.id)).toBe(false);
  });

  test('cards of titles without a Latin letter keep their places through the repair', () => {
    const was = parse(['[ ] **登录.** a', '[ ] **退出.** b']);
    docs = [positional(was)];
    const [a, b] = kids();
    work(a!.id, '登录', { state: 'working' });
    work(b!.id, '退出', { state: 'done' });
    const after = read(was);
    expect(after.map((k) => [k.title, k.id, k.state])).toEqual([
      ['登录', a!.id, 'working'],
      ['退出', b!.id, 'done'],
    ]);
  });
});

describe('a doc in a plan folder outside the repository', () => {
  const OUT = '/plans/audit.md';
  const outside = (items: string[]) => parsePlanDoc(OUT, md(items)) as PlanDoc;
  afterEach(() => setSystemTime());

  test('a workstream away for a moment keeps its card; one that stays away lets it go, with its title and text', () => {
    const [g, b] = read(outside(OLD));
    work(g!.id, '1G Testlücken schließen', { state: 'done' });
    work(b!.id, '3B Auth zusammenführen', { state: 'planned' });
    // the doc is saved in two edits: 3B is missing for a moment
    read(outside([OLD[0]!, OLD[2]!]));
    expect(board.archived()).toEqual([]);
    expect(read(outside(OLD)).find((k) => k.label === '3B')!.id).toBe(b!.id);
    // now 1G goes for good
    const t = Date.now();
    read(outside(OLD.slice(1)));
    read(outside(OLD.slice(1)));
    expect(board.archived()).toEqual([]);
    setSystemTime(new Date(t + LEAVE_AFTER_MS + 1000));
    board.changed();
    board.snapshot();
    expect(board.archived().find((i) => i.id === g!.id)).toMatchObject({ title: '1G Testlücken schließen', body: 'Only tests.', state: 'done' });
  });

  test('a stopped card leaves once it gave its workspace back, under the title and text the doc had', () => {
    const [, b] = read(outside(OLD));
    work(b!.id, '3B Auth zusammenführen', { state: 'planned', branch: `obeya/3b-auth-zusammenfuhren-${b!.id.slice(0, 6)}`, workspace: '/ws/1' });
    const t = Date.now();
    read(outside([OLD[0]!, OLD[2]!]));
    setSystemTime(new Date(t + LEAVE_AFTER_MS + 1000));
    board.changed();
    board.snapshot();
    expect(board.snapshot().items.some((i) => i.id === b!.id)).toBe(false);
    store.update(b!.id, { workspace: null });
    board.changed();
    expect(board.snapshot().items.find((i) => i.id === b!.id)).toMatchObject({ title: '3B Auth zusammenführen', body: 'One auth service.', state: 'planned', source: 'manual' });
  });

  test('a workstream back under another key finds its waiting card by what the card remembered', () => {
    const [u] = read(outside(['[ ] **W1:** Upload. x', '[ ] **W2:** Other. z']));
    work(u!.id, 'W1 Upload', { state: 'planned' });
    read(outside(['[ ] **W2:** Other. z']));
    const after = read(outside(['[ ] **W1:** Upload. x', '[ ] **W1:** Download. y', '[ ] **W2:** Other. z']));
    expect(after.find((k) => k.title === 'Upload')!.id).toBe(u!.id);
  });

  test('the repair lets a card whose workstream is away for a moment wait too', () => {
    const was = outside(OLD);
    docs = [positional(was)];
    const [g] = kids();
    work(g!.id, '1G Testlücken schließen', { state: 'planned' });
    read(outside(OLD.slice(1)));
    expect(board.archived()).toEqual([]);
    expect(board.snapshot().items.some((i) => i.id === g!.id)).toBe(false);
    expect(read(outside(OLD)).find((k) => k.label === '1G')!.id).toBe(g!.id);
  });

  test('the repair finds a reworded labelled title by the doc as last kept, without git', () => {
    const was = outside(['[ ] **S1: Foundation.** Base', '[ ] **S2: Sign-in.** Rest']);
    docs = [positional(was)];
    const [s1] = kids();
    work(s1!.id, 'S1: Foundation', { state: 'live' });
    const after = read(outside(['[x] **S1: Foundation layer.** Base', '[ ] **S2: Sign-in.** Rest']));
    expect(after[0]!.id).toBe(s1!.id);
    expect(board.archived()).toEqual([]);
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
    // 3B is a fresh card, and the project lays out afresh in the doc's order
    expect(after[1]!.id).not.toBe(b!.id);
    expect(after.map((k) => ({ x: k.x, y: k.y }))).toEqual(placeWorkstreams(parse(NEW).workstreams));
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

describe('cards of a doc read by an older Obeya, as workers left it', () => {
  test('a card stays when its worker put the pull request before the title, or the doc reworded a labelled title', () => {
    const was = parse(['[ ] Ship the thing. Details', '[ ] **S1: Foundation.** Base', '[ ] **S2: Sign-in.** Rest']);
    history = [was];
    docs = [positional(was)];
    const [ship, s1] = kids();
    work(ship!.id, 'Ship the thing', { state: 'live' });
    work(s1!.id, 'S1: Foundation', { state: 'live' });
    const since = new Date(Date.now() - 1000).toISOString();
    const after = read(parse(['[x] #12. Ship the thing. Details', '[x] **S1: Foundation layer.** Base', '[ ] **S2: Sign-in.** Rest']));
    expect(after.map((k) => [k.label ?? k.title, k.id])).toEqual([
      ['#12. Ship the thing', ship!.id],
      ['S1', s1!.id],
      ['S2', expect.any(String)],
    ]);
    expect(board.archived()).toEqual([]);
    // no card the move dropped reads as one the owner deleted
    expect(store.removed('c', since)).toEqual([]);
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

  test('a commit that only ticks a box gives the whole item, with its details', () => {
    const items = ['[ ] **W1:** Upload. Details\n  - first\n  - second', '[ ] **W2:** Download.'];
    const repo = gitRepo(join(dir, 't'), { [FILE]: md(items) });
    writeFileSync(join(repo, FILE), md([items[0]!.replace('[ ]', '[x]'), items[1]!]));
    git(repo, 'commit', '-qam', 'tick W1');
    expect(planHistory(repo, FILE)[0]).toMatchObject({ label: 'W1', done: true, title: 'Upload' });
    expect(planHistory(repo, FILE)[0]!.body).toContain('second');
  });
});
