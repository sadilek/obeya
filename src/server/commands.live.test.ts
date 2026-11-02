// The Koordinator's prompt against the real model: requests the agent of an open card passes on from
// the owner's words, in each state an agent is on; sentences said or typed with a card open that no
// agent works on; new tasks that start, wait, or start at a time the owner names; questions with no card open (an opinion becomes
// an idea, a fact stays in the conversation, work on the machine such as a new repository is a task);
// actions that depend on reading first, looked up with the step to take then;
// requests Obeya cannot do, or words for its makers; a step promised for once a card is done,
// which it waits for and then takes by itself; and reviews of pull requests, a review card each.
// Runs only with OBEYA_LIVE=1 (it uses the machine's
// Claude login and takes about a minute): `OBEYA_LIVE=1 bun test src/server/commands.live.test.ts`.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Config } from './config';
import { Store } from './db';
import { AGENT_DEFAULTS, type CanvasConfig, type ConfigView } from '../core/types';
import { type AgentRuntime, sdkRuntime, withAgentSetting } from './runtime';
import { gitRepo } from './testing';

// the sessions need the machine's Claude login, which the test setup hides behind a scratch config
const scratch = process.env.CLAUDE_CONFIG_DIR;
const machine = process.env.OBEYA_MACHINE_CLAUDE_CONFIG_DIR;
const setConfig = (dir: string | undefined) => (dir === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = dir));
beforeAll(() => void (process.env.OBEYA_LIVE && setConfig(machine)));
afterAll(() => void setConfig(scratch));

// each Koordinator works in a directory of its own, removed once all have run
const cwds: string[] = [];
const cwd = () => cwds[cwds.push(mkdtempSync(join(tmpdir(), 'obeya-live-'))) - 1]!;
afterAll(() => cwds.forEach((d) => rmSync(d, { recursive: true, force: true })));

const DEMO = JSON.stringify({ kind: 'video', dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' });
const STATES: Record<string, Record<string, string>> = {
  working: { state: 'working' },
  question: { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV oder Excel?', options: ['CSV', 'Excel'] } }) },
  demo: { state: 'waiting', need: 'demo', demo: DEMO },
  review: { state: 'waiting', need: 'review' },
  inPr: { state: 'inPr' },
  finishing: { state: 'live', workspace: '/w', landed: '{}' },
  planned: { state: 'planned' },
  // LOGIN: the card „Login“, which it waits for
  queued: { state: 'planned', queue: JSON.stringify({ behind: ['LOGIN'], reason: 'Beide ändern die Sitzungsverwaltung.' }) },
  proposal: { state: 'proposal', proposal: JSON.stringify({ reason: 'Beim Login aufgefallen.', questions: [{ text: 'Welche Kodierung?', options: ['UTF-8', 'Latin-1'] }] }) },
};

/**
 * State of the open card, what the owner says (or types), the request its agent passes on (`to_obeya`;
 * none: the card has no agent, and the words reach the Koordinator themselves), whether typed, and
 * the actions expected. What the owner says to an agent never comes back to it as a note, an answer or feedback.
 */
const CASES: [string, string, string | null, boolean, Command['do'][]][] = [
  ['working', 'mach eine Folgeaufgabe für den Excel-Export', 'Create a follow-up card for an Excel export of this card.', false, ['newCard']],
  ['working', 'Merk dir: Exporte immer mit Kopfzeile', 'The owner wants Obeya to remember: exports always with a header row.', true, ['remember']],
  ['working', 'halt an, ich will das anders angehen', 'Stop the agent on this card.', false, ['stop']],
  ['working', 'Was ist seit gestern auf der Leinwand passiert?', 'What happened on the canvas since yesterday?', true, []],
  ['working', 'starte auch gleich Login', 'Start the card Login.', false, ['start']],
  ['working', 'pack das in die Gruppe Abrechnung', 'Put this card into the group Abrechnung.', false, ['group']],
  ['question', 'mach eine Folgeaufgabe: Import aus CSV', 'Create a follow-up card: import from CSV.', true, ['newCard']],
  ['demo', 'gib frei', 'The owner approves my work.', false, ['approve']],
  ['demo', 'gib frei und mach eine Folgeaufgabe für die Auffälligkeit mit dem Datum', 'Approve my work, and create a follow-up card for the date anomaly from my summary.', true, ['approve', 'newCard']],
  ['demo', 'Merk dir: Demos immer mit Ton', 'Remember for all demos: always with sound.', false, ['remember']],
  ['review', 'gib das frei', 'Approve my work.', false, ['approve']],
  ['review', 'Export und Login gehören zur Gruppe Konto', 'Put the cards Export als CSV and Login into the group Konto.', true, ['group']],
  ['inPr', 'Merk dir: in diesem Repo nie force pushen', 'Remember for this repository: never force-push.', true, ['remember']],
  ['finishing', 'leg eine Aufgabe an: Branches nach dem Merge aufräumen', 'Create a new task: clean up branches after the merge.', false, ['newCard']],
  ['planned', 'Was würde der Agent hier machen, wenn ich starte?', null, false, []],
  ['queued', 'nimm das aus der Warteschlange', null, false, ['dequeue']],
  ['queued', 'Das soll doch noch nicht starten, lass es erst mal liegen', null, true, ['dequeue']],
  ['queued', 'starte das trotzdem', null, false, ['force']],
  ['proposal', 'Nimm den Excel-Export gleich mit dazu, und die Kodierung ist UTF-8', null, false, ['revise']],
  ['proposal', 'Ich glaube, das Problem liegt eher beim Import, der Export ist in Ordnung', null, true, ['revise']],
  ['proposal', 'übernimm das', null, false, ['accept']],
  ['proposal', 'das brauchen wir nicht, weg damit', null, false, ['dismiss']],
];

/** What the Koordinator makes of one sentence, or of a request passed on with it: the actions as they run. */
async function hear(state: string, text: string, request: string | null, typed: boolean) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  const login = board.create({ title: 'Login', x: 0, y: 0 });
  if (state === 'queued') board.work(login.id, { state: 'working' });
  const card = board.create({ title: 'Export als CSV', x: 0, y: 0 });
  board.work(card.id, Object.fromEntries(Object.entries(STATES[state]!).map(([k, v]) => [k, v.replace('LOGIN', login.id)])));
  const executed: Command[] = [];
  // what the session said: a command not understood shows why (not logged in, an API error)
  const said: string[] = [];
  const runtime: AgentRuntime = { start: (spec, ...rest) => sdkRuntime.start({ ...spec, onEvent: (e) => (e.type === 'text' && said.push(e.text), spec.onEvent(e)) }, ...rest) };
  const k = new Commander({ board, runtime, cwd: cwd(), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = request ? await k.forward(card.id, request, { text, spoken: !typed }) : await k.hear(text, { card: card.id }, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), executed, confirm: heard.confirm, said };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'the Koordinator does what an agent passes on, and knows Obeya’s commands on a card without one',
  async () => {
    const results = await Promise.all(CASES.map(async ([state, text, request, typed, want]) => ({ state, text, request, typed, want, got: await hear(state, text, request, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want));
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} [${r.state}] ${r.typed ? 'getippt' : 'gesprochen'} „${r.text}“${r.request ? ` (vom Agenten: ${r.request})` : ''} → ${r.got.did.join(', ') || 'reply'} · ${JSON.stringify(r.got.executed.map((c) => ('text' in c ? c.text : 'title' in c ? c.title : 'name' in c ? c.name : '')))} · ${r.got.confirm}${r.got.confirm !== 'Das habe ich nicht verstanden.' ? '' : ` · Sitzung: ${r.got.said.join(' ').slice(0, 200)}`}`);
    expect(wrong.map((r) => `[${r.state}] ${r.text}`)).toEqual([]);
  },
  300_000,
);

/** What the owner says for a new task, in which language, and whether it starts now, later (at a time the owner named) or not. */
const NEW_TASKS: [string, 'de' | 'en', boolean | 'later'][] = [
  ['Tipjar should split the bill Add a field for how many people there are and show what each person pays', 'en', true],
  ['Tipjar soll die Rechnung aufteilen ein Feld für die Personenzahl und zeig was jede Person zahlt', 'de', true],
  ['Das Trinkgeld soll man auch frei in Prozent eingeben können', 'de', true],
  ['Neue Aufgabe für später: Tipjar soll die Rechnung aufteilen', 'de', false],
  ['Just note it down for later: a field for how many people there are', 'en', false],
  ['Neue Aufgabe Export als PDF aber noch nicht starten', 'de', false],
  ['Leg eine Aufgabe an, dass ich mich Anfang Dezember um den Export als PDF kümmere, wenn es bis dahin bessere Bibliotheken gibt', 'de', 'later'],
  ['Make a card to add the tip presets in two weeks, once the new prices are out', 'en', 'later'],
];

/** The new card one sentence makes on a canvas like the one in the hero video: whether it starts. */
async function newTask(text: string, language: 'de' | 'en') {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'Tipjar', repos: [{ id: 'tipjar', name: 'Tipjar', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }), undefined, undefined, () => language);
  board.work(board.create({ title: 'Dark mode', x: 0, y: 0 }).id, { state: 'live' });
  board.work(board.create({ title: 'Run the tests on every push', x: 0, y: 0 }).id, { state: 'working' });
  board.create({ title: 'Round the total up', x: 0, y: 0 });
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const k = new Commander({ board, runtime, cwd: cwd(), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = await k.hear(text, {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  const card = executed.find((c) => c.do === 'newCard');
  const until = card?.do === 'newCard' ? card.until : undefined;
  return { start: card?.do === 'newCard' ? (until ? 'later' : card.start) : undefined, until, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'a new task starts at once unless the owner says it should wait, or later when they name a time',
  async () => {
    const runs = NEW_TASKS.flatMap((c) => [c, c, c]);
    const results = await Promise.all(runs.map(async ([text, language, want]) => ({ text, want, got: await newTask(text, language) })));
    const wrong = results.filter((r) => r.got.start !== r.want);
    for (const r of results) console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.start === undefined ? 'no new card' : r.got.start === 'later' ? `starts ${r.got.until}` : r.got.start ? 'starts' : 'planned'} · ${r.got.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/** What the owner says with no card open, whether typed, and the actions expected (none: a reply or a look-up). */
const NO_CARD: [string, boolean, Command['do'][]][] = [
  ['Nochmal zu den nicht erlaubten Datenbankabfragen: das Skript steht in der eingecheckten Datei, reicht aber nicht. Was meinst du, was wir da jetzt machen sollen?', false, ['newIdea']],
  ['Wie sollten wir das Onboarding angehen?', true, ['newIdea']],
  ['Was hältst du davon, die Exporte nachts laufen zu lassen?', false, ['newIdea']],
  ['Was steht im Plan zu den Exporten?', true, []],
  ['Was ist seit gestern passiert?', false, []],
  ['Kannst du mir ein neues repo in ~/dev/kassenbuch und einen entsprechenden Obeya canvas anlegen? Privater account, erstmal nicht nach GitHub.', true, ['newCard']],
  ['Installier mir ffmpeg auf dem Rechner', false, ['newCard']],
];

/** What the Koordinator makes of one sentence with no card open. */
async function noCard(text: string, typed: boolean) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  board.work(board.create({ title: 'Export als CSV', x: 0, y: 0 }).id, { state: 'live' });
  board.work(board.create({ title: 'Login', x: 0, y: 0 }).id, { state: 'working' });
  board.create({ title: 'Zählerstände nachtragen', x: 0, y: 0 });
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  // the configuration as Obeya serves it, one canvas on a repository that exists
  const home = cwd();
  const started = [{ name: 'C', repos: [{ path: gitRepo(join(home, 'home')) }] }];
  const config = new Config({ file: join(home, 'canvases.json'), source: 'file', started, store: new Store(':memory:'), running: () => ['c'], server: { port: 4417, home, permissionMode: 'auto' } });
  const k = new Commander({ board, runtime, cwd: cwd(), config, execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = await k.hear(text, {}, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), executed, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'with no card open, a question for an opinion becomes an idea, a question of fact stays in the conversation, and work on the machine is a task',
  async () => {
    const results = await Promise.all(NO_CARD.map(async ([text, typed, want]) => ({ text, want, got: await noCard(text, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want));
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.did.join(', ') || 'reply or look-up'} · ${JSON.stringify(r.got.executed.map((c) => ('title' in c ? `${c.title}: ${'body' in c ? c.body : ''}` : '')))} · ${r.got.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/**
 * What the owner asks to have done with no card open, whether the actions depend on reading first
 * (a task per open issue: looked up with the step to take then, no card that would only make cards),
 * and the actions expected at once.
 */
const READ_FIRST: [string, boolean, Command['do'][]][] = [
  ['Es gibt im Moment drei offene Issues bei GitHub, erstelle für jedes eine eigene Karte.', true, []],
  ['Leg für jedes offene Issue auf GitHub eine Aufgabe an', true, []],
  ['There are three open issues on GitHub right now, create a card for each.', true, []],
  ['Behebe Issue 27 auf GitHub', false, ['newCard']],
];

test.skipIf(!process.env.OBEYA_LIVE)(
  'actions that depend on reading are looked up with the step to take then; work on one named issue is a task',
  async () => {
    const results = await Promise.all(
      READ_FIRST.map(async ([text, then, want]) => {
        const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
        board.work(board.create({ title: 'Login', x: 0, y: 0 }).id, { state: 'working' });
        const executed: Command[] = [];
        const asked: number[] = [];
        const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
        const k = new Commander({ board, runtime, cwd: cwd(), execute: (c) => void executed.push(c), lookUp: (t) => void asked.push(t), delayMs: 1 });
        const heard = await k.hear(text, {}, [], { typed: true });
        if (heard.token) k.arm(heard.token);
        await new Promise((r) => setTimeout(r, 20));
        const step = asked.length ? board.exchange(asked[0]!)?.then : undefined;
        return { text, then, want, did: executed.map((c) => c.do), step, confirm: heard.confirm };
      }),
    );
    const wrong = results.filter((r) => JSON.stringify(r.did) !== JSON.stringify(r.want) || !!r.step !== r.then);
    for (const r of results) console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.did.join(', ') || 'reply or look-up'}${r.step ? ` · then: ${r.step}` : ''} · ${r.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/**
 * What the owner says with no card open, and what comes of it: a reply that Obeya cannot do it
 * (`cannot`, with a link to report it as a wish), a draft for Obeya's makers they asked for (`wish`),
 * or neither (unclear, a fact, a request that fails for the moment or does not fit a card's state).
 */
const WISHES: [string, 'cannot' | 'wish' | null][] = [
  ['Sortier die Karten auf der Leinwand nach Erstellungsdatum', 'cannot'],
  ['Exportier die ganze Leinwand als PDF', 'cannot'],
  ['Schick mir eine SMS, sobald eine Demo fertig ist', 'cannot'],
  ['Zeig mir für jede Aufgabe, wie viele Tokens sie gekostet hat, als Diagramm', null],
  ['Obeya, Feedback: die Minikarte soll sich ausblenden lassen', 'wish'],
  ['Sag den Entwicklern von Obeya, dass der Start zu lange dauert', 'wish'],
  ['mach das Ding da mal weg', null],
  ['Was ist seit gestern passiert?', null],
  ['Starte Login', null],
];

/** What the Koordinator makes of one sentence with no card open: whether it says Obeya cannot do it, or opens a draft for the makers. */
async function wishOf(text: string) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  board.work(board.create({ title: 'Export als CSV', x: 0, y: 0 }).id, { state: 'live' });
  board.work(board.create({ title: 'Login', x: 0, y: 0 }).id, { state: 'working' });
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const k = new Commander({ board, runtime, cwd: cwd(), execute: () => {}, delayMs: 1 });
  const heard = await k.hear(text, {}, [], { typed: true });
  return { got: heard.wish ? ('wish' as const) : heard.cannot ? ('cannot' as const) : null, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  "a reply says when Obeya lacks what the owner asked, and words for Obeya's makers open a draft; nothing else does",
  async () => {
    const results = await Promise.all(WISHES.flatMap((c) => [c, c]).map(async ([text, want]) => ({ text, want, ...(await wishOf(text)) })));
    const wrong = results.filter((r) => r.got !== r.want);
    for (const r of results) console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got ?? 'neither'} · ${r.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/** What the owner asked for a step that can only follow once a card is done, the actions expected now, and the card waited on (null: the new one). */
const LATER: [string, Command['do'][], string | null][] = [
  ['Hmm, with my permission you should be able to do that, no? Create a card and let the agent try it', ['newCard', 'waitFor'], null],
  ['Starte Login, sobald Export als CSV fertig ist', ['waitFor'], 'Export als CSV'],
];

/**
 * The owner's request from the conversation before (a repository and a canvas for it), which only a
 * card's agent can begin: the Koordinator waits on that card, and takes the step once it is done.
 */
async function later(text: string) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }), undefined, undefined, () => 'en');
  board.work(board.create({ title: 'Export als CSV', x: 0, y: 0 }).id, { state: 'working' });
  board.create({ title: 'Login', x: 0, y: 0 });
  board.addTalk(
    'Kannst du mir ein neues Repo in ~/dev/leserina und einen entsprechenden Obeya canvas anlegen? Privater Account, erstmal nicht nach GitHub.',
    "I can't create a repository myself; Obeya can only put a canvas on one that already exists. Run `mkdir -p ~/dev/leserina && cd ~/dev/leserina && git init -b main && git commit --allow-empty -m \"Start\"`. Tell me once it's there, and I'll add the canvas “Leserina”.",
  );
  const view = { file: '/h/canvases.json', source: 'file', canvases: [{ name: 'Obeya', repos: [{ path: '/r' }] }], running: ['obeya'] } as unknown as ConfigView;
  const config = { view: () => view, check: async (canvases: unknown) => ({ canvases: canvases as CanvasConfig[], resolved: [], problems: [] }), checkSaved: async () => ({ canvases: view.canvases, resolved: [], problems: [] }) };
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const k = new Commander({
    board,
    runtime,
    cwd: cwd(),
    config,
    delayMs: 1,
    execute: (c) => {
      executed.push(c);
      if (c.do === 'newCard') return board.create({ title: c.title, x: 0, y: 0 }).id;
    },
  });
  const heard = await k.hear(text, {}, [], { typed: true });
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  // a wait is the Koordinator's own: it stands on the exchange rather than running
  const wait = board.waitingTalk()[0]?.waiting[0];
  const made = executed.length;
  const now = [...executed.map((c) => c.do), ...(wait ? ['waitFor' as const] : [])];
  if (!wait) return { now, confirm: heard.confirm };
  // the card gets done: the Koordinator takes the step by itself
  board.work(wait.card, { state: 'done' });
  const notices: string[] = [];
  board.onNotice((n) => void notices.push(n.text));
  k.due(board.snapshot().items);
  for (const end = Date.now() + 120_000; !notices.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 20));
  const body = executed.flatMap((c) => (c.do === 'newCard' ? [c.body] : [])).join(' ');
  return { now, confirm: heard.confirm, on: wait.title, then: wait.then, body, after: executed.slice(made), notice: notices[0] };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'a step that can only follow once a card is done is waited for, and taken by itself once it is',
  async () => {
    const results = await Promise.all(LATER.flatMap((c) => [c, c, c]).map(async ([text, want, on]) => ({ text, want, on, got: await later(text) })));
    const configured = (r: (typeof results)[number]) =>
      r.want.includes('newCard')
        ? r.got.after?.some((c) => c.do === 'configure' && c.canvases.some((x) => x.repos.some((y) => y.path.includes('leserina'))))
        : r.got.after?.some((c) => c.do === 'start');
    const wrong = results.filter((r) => JSON.stringify(r.got.now) !== JSON.stringify(r.want) || (r.on !== null && r.got.on !== r.on) || !configured(r));
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.now.join(', ')} · ${r.got.confirm} · body: ${r.got.body} · waits on: ${r.got.on}, then: ${r.got.then} → ${r.got.after?.map((c) => c.do).join(', ')} · ${r.got.notice}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/**
 * What the owner says to have pull requests reviewed (several in one sentence, or the step taken
 * once the open ones are looked up), on a canvas whose history holds tasks titled like reviews
 * beside a review card, and the number of review cards expected: one for each pull request.
 */
const REVIEWS: [string, number][] = [
  ['Mach Reviews der Pull Requests 5, 6 und 7.', 3],
  ['Review Pull Requests 5 und 6, jeweils auf ihrer eigenen Karte.', 2],
  ['Review PR 5', 1],
  ['Mach eine Reviewkarte für die neuen Pull-Requests.', 3],
];

/** What the Koordinator makes of one request for reviews: the actions as they run. */
async function reviews(text: string) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'Shop', repos: [{ id: 'shop', name: 'Shop', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  board.work(board.create({ title: 'Checkout button looks disabled', x: 0, y: 0 }).id, { state: 'live' });
  const contribution = { url: 'https://github.com/acme/shop/pull/4', number: 4, author: 'alice', title: 'Round totals to cents', canModify: true };
  board.work(board.create({ title: 'PR #4: Round totals to cents', x: 0, y: 0 }).id, { state: 'done', contribution: JSON.stringify(contribution) });
  board.addTalk('Review bitte Pull Request Nummer 4.', 'Neue Aufgabe für das Review von Pull Request 4, der Agent prüft ihn.');
  // tasks made for reviews before, which only look like review cards
  board.work(board.create({ title: 'Review PR #2', body: 'Review Pull Request 2.', x: 0, y: 0 }).id, { state: 'done' });
  board.work(board.create({ title: 'Review PR #3', body: 'Review Pull Request 3.', x: 0, y: 0 }).id, { state: 'waiting', need: 'demo', demo: DEMO });
  board.addTalk('Review Pull Requests 2 und 3, jeweils auf ihrer eigenen Karte.', 'Neue Aufgaben „Review PR #2“ und „Review PR #3“, die Agenten starten.');
  board.addPreference('When a request of mine contains several separate tasks (e.g. a release and a website update), create a separate card for each instead of one card for all.');
  board.addPreference("When I ask for a review of a pull request, the review checks the changes (including anything hidden that doesn't belong there) and records no demo video if the PR already contains one.");
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const asked: number[] = [];
  const k = new Commander({ board, runtime, cwd: cwd(), execute: (c) => void executed.push(c), lookUp: (t) => void asked.push(t), delayMs: 1 });
  const heard = await k.hear(text, {}, [], { typed: true });
  if (heard.token) k.arm(heard.token);
  // the open pull requests, looked up: the Koordinator takes the step it looked them up for
  if (asked.length) {
    board.answerTalk(asked[0]!, 'Three open pull requests are newer than PR #4:\n- #5 "Empty cart shows a hint" by bob: https://github.com/acme/shop/pull/5\n- #6 "Discount codes" by carol: https://github.com/acme/shop/pull/6\n- #7 "Currency symbol per locale" by dave: https://github.com/acme/shop/pull/7', 'koordinator');
    k.answerIn(asked[0]!);
    for (const end = Date.now() + 120_000; !executed.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), executed };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'every pull request the owner asks to have reviewed gets a review card of its own, also beside tasks titled like reviews',
  async () => {
    const results = await Promise.all(REVIEWS.flatMap((c) => [c, c, c]).map(async ([text, want]) => ({ text, want, got: await reviews(text) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(Array(r.want).fill('reviewPr')));
    for (const r of results) console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.did.join(', ') || 'nothing'} · ${JSON.stringify(r.got.executed.map((c) => (c.do === 'reviewPr' ? c.pr : 'title' in c ? c.title : '')))}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);
