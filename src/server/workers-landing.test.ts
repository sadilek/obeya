import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { PlanDoc } from '../core/plan-doc';
import { needsYou, stopped } from '../core/types';
import { artifact, commit, gitClone, identify, testBoard, until, ws } from './testing';
import type { Board } from './board';
import { board, dir, doc, eachTest, flush, handedOver, main, manual, merged, newWorkers, origin, rebuild, runtime, setDocs, setup, setWorkers, spaces, state, store, workers } from './workers-fixture';
import { git } from './workspaces';
import { type RepoAdapter } from '../adapters/types';

const MAIN: RepoAdapter = { ...generic, land: 'main', workspaces: 'clones' };
const PR: RepoAdapter = { ...generic, land: 'pr', workspaces: 'clones' };
const DIRECT: RepoAdapter = { ...PR, direct: true };

describe('landing through a pull request', () => {
  eachTest(PR);

  test('approval starts the PR phase: the branch stays in the clone, main is left alone', async () => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    commit(clone, 'x.ts', '', 'X');
    runtime.last.call('report', { status: 'Demo fertig, übergebe' });
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    expect(board.item(c.id)!.noChange).toBeUndefined();
    // the line was about the work handed over: it would show again once the card is at work
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    expect(board.row(c.id).branch).toBeTruthy();
  });

  test('a session that ends by itself before opening the pull request asks the owner, the approval standing', async () => {
    const { card: c } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id);
    runtime.last.emit({ type: 'error', message: 'API Error: 500' });
    runtime.last.close();
    await until(() => state(c.id) === 'waiting:question');
    expect(board.item(c.id)!.question).toMatchObject({ text: expect.stringContaining('API Error: 500'), options: [board.t.worker.tryAgain] });
    workers.answer(c.id, board.t.worker.tryAgain);
    expect(state(c.id)).toBe('inPr');
  });

  test('approving work that changed nothing makes the card done: no pull request, the worker hears so and finishes', async () => {
    const { card: c, session: s } = await handedOver({ summary: 'Demo aufgenommen, keine Code-Änderung.', idle: false });
    // the owner sees before approving that approval ends the card
    expect(board.item(c.id)!.noChange).toBe(true);
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(board.item(c.id)!.noChange).toBeUndefined();
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.inbox.at(-1)).toContain('nothing lands and there is no pull request: the card is done');
    expect(board.events(c.id).at(-1)!.text).toContain('erledigt');
    // a question while it finishes, answered, returns the card to done, not live
    s.call('ask', { question: 'Stack stoppen?' });
    s.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(s.closed).toBe(false);
    workers.answer(c.id, 'Ja.');
    expect(state(c.id)).toBe('done');
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
    // done counts as finished: it can be archived
    board.archive([c.id]);
    expect(board.item(c.id)).toBeUndefined();
  });

  test('work approved without a change while a restart is due shows its agent waiting for the restart, not at work, until the restart resumes it', async () => {
    const { card: c, session: s } = await handedOver({ summary: 'Repo angelegt, nichts in der Ablage geändert.' });
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(s.inbox.at(-1)).toContain('leave the work it asks for until Obeya resumes you');
    // while it takes in the approval, it is at work
    expect(board.item(c.id)).toMatchObject({ finishing: true, inTurn: true });
    expect(board.item(c.id)!.restartPaused).toBeUndefined();
    s.emit({ type: 'text', text: 'Danke, es bleibt nichts zu tun.' });
    s.emit({ type: 'idle' });
    // it paused for the restart: its session stays for it, but nobody is at work on the card
    expect(s.closed).toBe(false);
    expect(board.item(c.id)).toMatchObject({ finishing: true, restartPaused: true });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
    // a restart called off leaves nothing to wait for
    workers.restartDue(null);
    expect(board.item(c.id)!.restartPaused).toBeUndefined();
  });

  test('a worker whose approved work turns out to change nothing closes the card itself instead of opening a pull request', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    expect(await s.call('close_unchanged', {})).toContain('only work the owner approved');
    const clone = board.row(c.id).workspace!;
    commit(clone, 'x.ts', '', 'X');
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    // with work on the branch, it goes out as a pull request
    expect(await s.call('close_unchanged', {})).toContain('holds commits');
    git(clone, 'reset', '--quiet', '--hard', 'HEAD~1');
    expect(await s.call('close_unchanged', {})).toContain('the card is done');
    expect(state(c.id)).toBe('done');
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'worker', text: 'Ohne Änderung am Code abgeschlossen: erledigt.' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
  });
});

describe('a card whose own branch changes how work lands', () => {
  eachTest(PR);
  const settingUp = async (settings: object) => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    commit(clone, '.obeya/settings.json', JSON.stringify(settings), 'Obeya settings');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    return c;
  };

  test('lands as the branch says: on main where the repository still has pull requests, which the owner sees before approving', async () => {
    const c = await settingUp({ land: 'main' });
    expect(board.item(c.id)!.lands).toEqual({ land: 'main' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Obeya settings');
  });

  test('as a pull request where the repository still lands on main', async () => {
    await setup();
    const c = await settingUp({ land: 'pr' });
    expect(board.item(c.id)!.lands).toEqual({ land: 'pr' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
  });

  test('the settings of this machine go first', async () => {
    rebuild({ machineSettings: () => ({ land: 'pr' }) });
    const c = await settingUp({ land: 'main', checks: ['bun test'] });
    expect(board.item(c.id)!.lands).toBeUndefined();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
  });
});

describe('landing on main from a clone of the remote', () => {
  // the clone's origin is the remote, as one listed in the settings or made while work went out as pull requests
  eachTest(MAIN, true);

  test('main moved on in the checkout, not on the remote: the work is rebased onto the checkout’s main and lands', async () => {
    const c = board.create({ title: 'Zählerstände exportieren', x: 0, y: 0 });
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    commit(clone, 'k.ts', 'k', 'Zählerstände als CSV');
    // another card landed on the checkout's main meanwhile, which nobody pushed
    commit(main, 'other.ts', 'other', 'Andere Karte');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Zählerstände als CSV', 'Andere Karte', 'init']);
  });
});

describe('approving directly onto main where work goes out as a pull request', () => {
  eachTest(DIRECT, true);

  /** A commit of `file` in `path` with `msg` as its text and message. */
  const commitIn = (path: string, file: string, msg: string) => commit(path, file, msg, msg);
  /** Someone else pushes a commit onto origin's main. */
  const pushElsewhere = (file: string, msg: string) => {
    const other = join(dir, `other-${msg}`);
    gitClone(origin, other);
    identify(other);
    commitIn(other, file, msg);
    git(other, 'push', '--quiet', 'origin', 'main');
  };
  const started = async (title = 'Zählerstände exportieren') => {
    const c = board.create({ title, x: 0, y: 0 });
    await workers.start(c.id);
    const session = runtime.last;
    return { c, session, clone: board.row(c.id).workspace! };
  };

  test('Obeya pushes the work onto origin/main itself: no pull request, the card is live, the Obeya checkout stays', async () => {
    const { c, session, clone } = await started();
    commitIn(clone, 'x.ts', 'X');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    session.emit({ type: 'idle' });
    const approved = workers.approve(c.id, { direct: true });
    // the click ends the owner's turn: the card no longer needs them while the push runs
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', landing: true });
    expect(needsYou(board.item(c.id)!)).toBe(false);
    await approved;
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.landing).toBeUndefined();
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['X', 'init']);
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'owner', text: 'Freigegeben und direkt auf main gepusht.' });
    expect(session.inbox.at(-1)).toContain('Obeya pushed it there without a pull request');
    expect(merged).toEqual([c.id]);
    // the worker may finish what remains; then its clone is free again
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
  });

  test('main moved on: the work is rebased onto it, also when it moves again between fetch and push', async () => {
    const { c, session, clone } = await started();
    commitIn(clone, 'x.ts', 'X');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    pushElsewhere('y.ts', 'Y');
    // the first push finds main moved once more, as when someone pushes while Obeya rebases
    const hook = join(clone, '.git/hooks/pre-push');
    mkdirSync(join(clone, '.git/hooks'), { recursive: true });
    const other = join(dir, 'other-Y');
    writeFileSync(
      hook,
      `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\nif [ ! -f "${dir}/raced" ]; then\n  touch "${dir}/raced"\n  echo z > "${other}/z.ts" && git -C "${other}" add . && git -C "${other}" commit --quiet -m Z && git -C "${other}" push --quiet origin main\nfi\n`,
      { mode: 0o755 },
    );
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('live');
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['X', 'Z', 'Y', 'init']);
  });

  test('a conflict goes back to the worker with the approval kept: its next handover is pushed directly too', async () => {
    const { c, session, clone } = await started();
    commitIn(clone, 'same.ts', 'A');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    pushElsewhere('same.ts', 'B');
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'error', code: 'landConflict' });
    expect(session.inbox.at(-1)).toContain('conflicts in same.ts');
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['B', 'init']);
    // the worker brings its branch up to date and hands over again
    git(clone, 'reset', '--quiet', '--hard', 'origin/main');
    commitIn(clone, 'same.ts', 'A nach B');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    expect(board.item(c.id)!.statusLine).toBe('Landet auf main');
    session.emit({ type: 'idle' });
    await until(() => state(c.id) === 'live');
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['A nach B', 'B', 'init']);
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'obeya', text: 'Nach der Freigabe direkt auf main gepusht.' });
    expect(board.item(c.id)!.pr).toBeUndefined();
  });

  test('a push the remote turns away (a protected branch) stays with the owner, who approves again', async () => {
    const { c, session, clone } = await started();
    commitIn(clone, 'x.ts', 'X');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    writeFileSync(join(origin, 'hooks/pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    const approved = workers.approve(c.id, { direct: true }).catch((e) => e);
    expect(needsYou(board.item(c.id)!)).toBe(false);
    const err = await approved;
    expect(err).toMatchObject({ code: 'landPush' });
    expect(err.message).toContain('protected branch');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.row(c.id).approved_at).toBeNull();
    // the card is the owner's again
    expect(needsYou(board.item(c.id)!)).toBe(true);
    // approved the usual way, it goes out as a pull request
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
  });

  test('without `direct` in the settings the approval is refused', async () => {
    rebuild({ adapter: PR });
    const { c, session, clone } = await started();
    commitIn(clone, 'x.ts', 'X');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    const err = await workers.approve(c.id, { direct: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'noDirect' });
    expect(state(c.id)).toBe('waiting:demo');
    expect(git(origin, 'log', '--format=%s', 'main')).toBe('init');
  });

  test('where work lands on main anyway, approving directly is a plain approval', async () => {
    await setup(MAIN);
    const d = await started('Logo');
    commitIn(d.clone, 'logo.svg', 'Logo');
    await d.session.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(d.c.id, { direct: true });
    expect(state(d.c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Logo');
  });

  test('work that changed nothing closes as done, approved directly or not', async () => {
    const { c, session } = await started();
    await session.call('ready_for_review', { summary: 'Nur eine Analyse.', demo: artifact() });
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('done');
    expect(git(origin, 'log', '--format=%s', 'main')).toBe('init');
  });
});

describe('the landed commit names the demo’s page', () => {
  const PAGE = 'Demo-Video: https://demos.example.dev/zahlerstande-exportieren-1/';
  /** The cards approved, as the demo site heard of them; a card titled „Ohne Seite“ has no page. */
  let approvals: string[];
  /** The cards whose work landed without a pull request, with what they shipped then, as the demo site heard of them. */
  let landings: [string, string | null][];
  eachTest(MAIN);
  beforeEach(withSite);
  function withSite() {
    approvals = [];
    landings = [];
    const onApproval = (id: string) => (approvals.push(id), board.item(id)!.title === 'Ohne Seite' ? null : PAGE);
    const onLanded = (id: string) => void landings.push([id, board.row(id).shipped]);
    rebuild({ onApproval, onLanded });
  }
  /** A handed-over card whose last commit has a trailer of its own. */
  async function trailered(title = 'Zählerstände exportieren', commits = true) {
    const c = board.create({ title, x: 0, y: 0 });
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    if (commits) {
      commit(clone, 'x.ts', 'x', 'Erste Hälfte');
      commit(clone, 'y.ts', 'y', 'Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    }
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    return c;
  }

  test('landing on main: the last commit gets the trailer beside its own, its author kept', async () => {
    const c = await trailered();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(approvals).toEqual([c.id]);
    expect(git(main, 'log', '-1', '--format=%B')).toBe(`Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${PAGE}`);
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Zählerstände als CSV', 'Erste Hälfte', 'init']);
    expect(git(main, 'log', '-1', '--format=%an <%ae>')).toBe('T <t@example.com>');
    // the page then links where it landed
    expect(landings).toEqual([[c.id, JSON.stringify({ commit: git(main, 'rev-parse', 'HEAD'), base: git(main, 'rev-parse', 'HEAD~2') })]]);
  });

  test('pushed directly onto origin’s main, the same', async () => {
    await setup(DIRECT, true);
    withSite();
    const c = await trailered();
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('live');
    expect(git(origin, 'log', '-1', '--format=%(trailers:key=Demo-Video)', 'main')).toBe(PAGE);
    expect(landings.map(([id]) => id)).toEqual([c.id]);
  });

  test('a card without a page lands as it was', async () => {
    const c = await trailered('Ohne Seite');
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '-1', '--format=%B')).toBe('Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  });

  test('approved into a pull request, the demo goes out all the same', async () => {
    await setup(PR);
    withSite();
    const c = await trailered();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(approvals).toEqual([c.id]);
    expect(landings).toEqual([]);
  });

  test('with nothing to land, too', async () => {
    const c = await trailered('Nur eine Analyse', false);
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(approvals).toEqual([c.id]);
  });
});

/** A demo's page, as the worker describes it in its handover. */
const DEMO_PAGE = { title: 'CSV export', text: 'Meter readings download as CSV.' };

describe('the landing message names the demo’s page', () => {
  const URL_ = 'https://demos.example.dev/zahlerstande-exportieren-1/';
  /** Whether the repository has a demo site; on approval, the page goes out (`publishing`) unless `share` says otherwise. */
  let site: boolean;
  let onApproval: (id: string) => void;
  eachTest(MAIN);
  beforeEach(withSite);
  function withSite() {
    site = true;
    onApproval = (id) => board.work(id, { share: JSON.stringify({ slug: 's', state: 'publishing', next: [{ dir: demoDir(id) }] }) });
    rebuild({ shares: () => site, onApproval: (id) => (onApproval(id), null) });
  }
  const withPage = async (commits = true) => (await handedOver({ commit: commits ? 'x.ts' : undefined, demo: { ...artifact(), page: DEMO_PAGE } })).card;
  const demoDir = (id: string) => (JSON.parse(board.row(id).demo!) as { dir: string }).dir;
  /** The page went out, as the demo site tells it. */
  function published(id: string) {
    const dir = demoDir(id);
    board.work(id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir, shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });
    workers.pageSettled(id, { url: URL_ });
  }

  test('a page still going out when the work lands: the worker waits, and hears its address once it is online', async () => {
    const c = await withPage();
    const session = runtime.last;
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(session.inbox.at(-1)).toContain('is on main now');
    expect(session.inbox.at(-1)).toContain('Obeya tells you its address once it is online');
    // the turn ends before the page is online: the session stays for it
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(false);
    expect(board.row(c.id).workspace).toBeTruthy();
    published(c.id);
    expect(session.inbox.at(-1)).toBe(`Your demo is online on a page of its own for the team: ${URL_}. Link it wherever you point people at this work (an issue you close, say).`);
    // having heard it, its next turn's end finishes it
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
    expect(board.row(c.id).landed).toBeNull();
  });

  test('a page that does not go out: the worker hears why, and asks the owner for a link', async () => {
    const c = await withPage();
    const session = runtime.last;
    await workers.approve(c.id);
    board.work(c.id, { share: JSON.stringify({ slug: 's' }) });
    workers.pageSettled(c.id, { why: 'upload refused: token expired' });
    expect(session.inbox.at(-1)).toContain('did not go out (upload refused: token expired)');
    expect(session.inbox.at(-1)).toContain('ask the owner for a link');
  });

  test('a page that went out while the worker did not hear of it: its turn’s end tells it', async () => {
    const c = await withPage();
    const session = runtime.last;
    await workers.approve(c.id);
    // the page went out while nobody told the workers (a restart in between, say)
    board.work(c.id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir: demoDir(c.id), shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });
    session.emit({ type: 'idle' });
    expect(session.inbox.at(-1)).toContain(`shared with the team on a page of its own: ${URL_}`);
    expect(session.closed).toBe(false);
  });

  test('a page online already: the landing message names it, and the worker finishes with its turn', async () => {
    onApproval = (id) => published(id);
    const c = await withPage();
    const session = runtime.last;
    await workers.approve(c.id);
    expect(session.inbox.at(-1)).toContain(`Your demo is shared with the team on a page of its own: ${URL_}. Link it`);
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
  });

  test('without a shared page, or without a demo site, the message says so: the worker asks before it links nothing', async () => {
    onApproval = () => {};
    const c = await withPage();
    await workers.approve(c.id);
    expect(runtime.last.inbox.at(-1)).toContain('Your demo is not shared on a page the team can open. Before you point anyone to your demo (an issue you close, say), ask the owner for a link.');
    await setup(MAIN);
    withSite();
    site = false;
    const d = await withPage();
    await workers.approve(d.id);
    expect(runtime.last.inbox.at(-1)).toContain('This repository has no demo site');
  });

  test('work its worker closes as needing no pull request names the page in the tool’s result, and waits for it the same way', async () => {
    await setup(PR);
    withSite();
    const c = await withPage(false);
    const session = runtime.last;
    // the approval sees work (the commit is made after the handover), so it goes into a pull request
    writeFileSync(join(board.row(c.id).workspace!, 'x.ts'), 'x');
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    rmSync(join(board.row(c.id).workspace!, 'x.ts'));
    expect(await session.call('close_unchanged', {})).toContain('Obeya tells you its address once it is online');
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(false);
    published(c.id);
    expect(session.inbox.at(-1)).toContain(URL_);
  });

  test('work that changed nothing, and a pull request merged, name the page the same way', async () => {
    const c = await withPage(false);
    const session = runtime.last;
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(session.inbox.at(-1)).toContain('Obeya tells you its address once it is online');
    published(c.id);
    expect(session.inbox.at(-1)).toContain(URL_);

    await setup(PR);
    withSite();
    onApproval = (id) => published(id);
    const d = await withPage();
    await workers.approve(d.id);
    workers.merged(d.id);
    expect(runtime.last.inbox.at(-1)).toContain(`Your pull request was merged; the card is live.\n\nYour demo is shared with the team on a page of its own: ${URL_}.`);
  });
});

describe('the worker hears what became of its demo’s page', () => {
  const URL_ = 'https://demos.example.dev/zahlerstande-exportieren-1/';
  eachTest(MAIN);
  beforeEach(() => rebuild({ shares: () => true, onApproval: () => null }));
  const withPage = async () => (await handedOver({ demo: { ...artifact(), page: DEMO_PAGE } })).card;
  const demoDir = (id: string) => (JSON.parse(board.row(id).demo!) as { dir: string }).dir;
  const going = (id: string) => board.work(id, { share: JSON.stringify({ slug: 's', state: 'publishing', next: [{ dir: demoDir(id) }] }) });
  const online = (id: string) => board.work(id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir: demoDir(id), shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });

  test('shared by the owner after the handover: their next words come with the page’s address and where Obeya links it', async () => {
    const c = await withPage();
    const session = runtime.last;
    online(c.id);
    workers.message(c.id, 'Is the demo linked in the commit?');
    const told = session.inbox.at(-1)!;
    expect(told).toStartWith(`The owner shared your demo with the team on a page of its own: ${URL_}.`);
    expect(told).toContain('a `Demo-Page: <url>` trailer on the commit that lands on main');
    expect(told).toEndWith('Is the demo linked in the commit?');
    // heard once
    expect(session.toolStep()).toBeUndefined();
    session.call('reply', { text: 'Yes.' });
    session.emit({ type: 'idle' });
    workers.message(c.id, 'Thanks.');
    expect(session.inbox.at(-1)).not.toContain('The owner shared your demo');
  });

  test('during a turn, the next tool step carries it; a page still going out first, its address once it is online', async () => {
    const c = await withPage();
    const session = runtime.last;
    workers.message(c.id, 'One more column.');
    going(c.id);
    expect(session.toolStep()).toContain('it is going online right now');
    expect(session.toolStep()).toBeUndefined();
    online(c.id);
    expect(session.toolStep()).toContain(URL_);
  });

  test('a share that fails, and a page withdrawn, are news too', async () => {
    const c = await withPage();
    const session = runtime.last;
    workers.message(c.id, 'Go on.');
    going(c.id);
    session.toolStep();
    board.work(c.id, { share: JSON.stringify({ slug: 's' }) });
    expect(session.toolStep()).toContain('Sharing your demo did not work');
    online(c.id);
    session.toolStep();
    board.work(c.id, { share: JSON.stringify({ slug: 's', url: URL_, state: 'withdrawing', demos: [] }) });
    expect(session.toolStep()).toContain('The owner stopped sharing your demo');
    board.work(c.id, { share: JSON.stringify({ slug: 's' }) });
    expect(session.toolStep()).toBeUndefined();
  });

  test('the landing message that names the page is all the worker hears of it', async () => {
    const c = await withPage();
    const session = runtime.last;
    online(c.id);
    await workers.approve(c.id);
    const told = session.inbox.at(-1)!;
    expect(told).toContain(`Your demo is shared with the team on a page of its own: ${URL_}.`);
    expect(told).not.toContain('The owner shared your demo');
  });
});

describe('a prototype built on in a clone', () => {
  eachTest();
  test('the idea takes over the clone and the branch, renamed; the clone is busy until it is done', async () => {
    const idea = board.create({ idea: true, title: 'Logo', x: 0, y: 0 });
    const prototype = board.addPrototype(idea.id, 'Prototyp: Logo', 'zeigen');
    await workers.start(prototype.id);
    const path = board.row(prototype.id).workspace!;
    const old = board.row(prototype.id).branch!;
    commit(path, 'logo.svg', '<svg/>', 'Prototyp');
    const moved = await workers.buildOn(prototype.id, board.item(idea.id)!);
    expect(moved.path).toBe(path);
    expect(git(path, 'branch', '--show-current')).toBe(moved.branch);
    expect(git(path, 'branch', '--list', old)).toBe('');
    expect(git(path, 'log', '--format=%s', '-1')).toBe('Prototyp');
    expect(spaces.leasedBy(idea.id)).toBe(path);
    // the only clone is the idea's now
    expect(() => spaces.lease(board.create({ title: 'X', x: 0, y: 0 }).id, 'obeya/x')).toThrow('all are leased');
    // a prototype without a workspace has nothing to build on
    const bare = board.addPrototype(idea.id, 'Prototyp: leer', 'zeigen');
    expect(() => workers.buildOn(bare.id, board.item(idea.id)!)).toThrow(expect.objectContaining({ code: 'noWorkspace' }));
  });
});

describe('a workstream whose plan doc keeps it open after its work landed', () => {
  eachTest();
  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** Starts W1, commits a file in its clone and hands it over. */
  const handOver = async () => (await handedOver({ card: w1(), commit: 'config.ts', summary: 'Konfiguration vorbereitet.' })).card;

  test('landed and ticked off in the doc: live', async () => {
    const w = await handOver();
    // the worker ticked it off on its branch
    setDocs([{ ...doc, workstreams: [{ ...ws('W1'), done: true }, ws('W2')] }]);
    await workers.approve(w.id);
    runtime.last.emit({ type: 'idle' });
    expect(board.row(w.id).landed).toBeNull();
    board.docsChanged();
    expect(state(w.id)).toBe('live');
  });

  test('the last workstream ticked off: the project stays at work while its worker finishes, then its work is done', async () => {
    const w = await handOver();
    const project = board.snapshot().items.find((i) => i.kind === 'project')!;
    setDocs([{ ...doc, workstreams: [{ ...ws('W1'), done: true }] }]);
    await workers.approve(w.id);
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    runtime.last.emit({ type: 'idle' });
    expect(board.item(project.id)!.state).toBe('done');
    expect(board.archived()).toEqual([]);
  });

  test('the last workstream lands and its doc goes: the project stays at work while its worker finishes, then its work is done', async () => {
    const w = await handOver();
    const project = board.snapshot().items.find((i) => i.kind === 'project')!;
    // the landing takes the done doc away
    setDocs([]);
    await workers.approve(w.id);
    board.docsChanged();
    expect(board.item(project.id)).toBeDefined();
    expect(board.item(w.id)!.finishing).toBe(true);
    runtime.last.emit({ type: 'idle' });
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(board.item(project.id)!.state).toBe('done');
    expect(board.archived()).toEqual([]);
  });

  describe('awaiting a restart', () => {
    const restarting = (b: Board) => newWorkers({ board: b, restartsFor: () => 'obeya' });
    /** Lands W1 with its doc gone; its worker waits for the restart. */
    const landWaiting = async () => {
      setWorkers(restarting(board));
      const w = await handOver();
      runtime.last.emit({ type: 'session', id: 'sess-1' });
      setDocs([]);
      await workers.approve(w.id);
      runtime.last.call('after_restart', {});
      runtime.last.emit({ type: 'idle' });
      return w;
    };
    /** Obeya starts again, the doc still gone, and the worker resumes. */
    const restart = () => {
      workers.shutdown();
      const b = testBoard({ store, path: main });
      setWorkers(restarting(b));
      workers.resumeAll();
      return b;
    };

    test('the project stays over the restart, its work done once its worker is', async () => {
      const w = await landWaiting();
      const project = board.snapshot().items.find((i) => i.kind === 'project')!;
      board.docsChanged();
      expect(board.item(w.id)!.finishing).toBe(true);
      const after = restart();
      expect(after.item(project.id)).toBeDefined();
      expect(runtime.last.spec.resume).toBe('sess-1');
      runtime.last.emit({ type: 'idle' });
      expect(spaces.leasedBy(w.id)).toBeNull();
      expect(after.item(project.id)!.state).toBe('done');
      expect(after.archived()).toEqual([]);
    });

    test('a project archived while its workstream finished comes back, its work done once its worker is', async () => {
      const w = await landWaiting();
      const project = board.snapshot().items.find((i) => i.kind === 'project')!;
      // as Obeya did before: archived at the landing, its worker unseen
      store.update(project.id, { archived_at: new Date().toISOString() });
      const after = restart();
      expect(after.item(project.id)).toBeDefined();
      expect(after.item(w.id)!.finishing).toBe(true);
      runtime.last.emit({ type: 'idle' });
      expect(spaces.leasedBy(w.id)).toBeNull();
      expect(after.item(project.id)!.state).toBe('done');
      expect(after.archived()).toEqual([]);
    });
  });

  test('landed on main, the box still empty: once its worker is done, the card is planned again and starts for the rest', async () => {
    const w = await handOver();
    await workers.approve(w.id);
    // its worker still finishes: the card stays live until then
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    runtime.last.emit({ type: 'idle' });
    const commit = git(main, 'rev-parse', 'HEAD');
    // git tells in the background that the read tree holds it
    await until(() => state(w.id) === 'planned');
    expect(w1().landedPart).toEqual({ commit });
    expect(board.events(w.id).at(-1)).toMatchObject({ author: 'obeya', text: 'Teil gelandet, im Plan-Doc weiter offen.' });
    // the handover stays in the log, the summary with it
    expect(board.events(w.id).some((e) => e.text.includes('Freigegeben'))).toBe(true);

    await workers.start(w.id);
    expect(state(w.id)).toBe('working');
    // a fresh branch from main, not the landed one
    expect(board.row(w.id).branch).toEndWith(`-${commit.slice(0, 7)}`);
    expect(git(board.row(w.id).workspace!, 'rev-parse', 'HEAD')).toBe(commit);
    expect(runtime.last.inbox[0]).toContain(`A part of this workstream has landed already (commit ${commit.slice(0, 7)})`);
    // what landed stays on the card while the rest is done
    expect(w1().landedPart).toEqual({ commit });
  });
});

describe('a workstream merged as a pull request, its box still empty', () => {
  eachTest(PR);

  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** W1 in its pull request #821, its worker idle. */
  const inPr = async () => {
    const { card: w } = await handedOver({ card: w1(), commit: 'config.ts' });
    await workers.approve(w.id);
    board.work(w.id, { pr: JSON.stringify({ url: 'https://github.com/acme/app/pull/821', number: 821, seen: [], reported: [] }) });
    return w;
  };

  test('stays live while the read tree lacks the merge commit, and is planned again once it holds it', async () => {
    const w = await inPr();
    // the merge as GitHub made it, not yet on the read tree's main
    git(main, 'checkout', '--quiet', '-b', 'merged');
    const head = commit(main, 'config.ts', 'export {}\n', 'Config (#821)');
    git(main, 'checkout', '--quiet', 'main');
    workers.merged(w.id, head);
    runtime.last.emit({ type: 'idle' });
    board.docsChanged();
    expect(state(w.id)).toBe('live');

    git(main, 'merge', '--quiet', '--ff-only', 'merged');
    board.docsChanged();
    await until(() => state(w.id) === 'planned');
    expect(w1().landedPart).toEqual({ commit: head, pr: { url: 'https://github.com/acme/app/pull/821', number: 821 } });
    // the pull request is history now: starting again opens a new one
    expect(w1().pr).toBeUndefined();
    await workers.start(w.id);
    expect(runtime.last.inbox[0]).toContain('pull request #821 (https://github.com/acme/app/pull/821)');
  });

  test('without the merge commit, the read tree after the next fetch stands in for it', async () => {
    const w = await inPr();
    workers.merged(w.id);
    runtime.last.emit({ type: 'idle' });
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    board.readTreeMoved('home', git(main, 'rev-parse', 'HEAD'));
    await until(() => state(w.id) === 'planned');
    expect(w1().landedPart).toEqual({ commit: git(main, 'rev-parse', 'HEAD'), pr: { url: 'https://github.com/acme/app/pull/821', number: 821 } });
  });
});

describe('a workspace its card will not work in again goes back to the pool', () => {
  eachTest();
  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** Starts the card, commits a file in its clone and stops it: the clone stays the card's. */
  const stoppedWithWork = async (id: string) => {
    await workers.start(id);
    const clone = board.row(id).workspace!;
    commit(clone, 'config.ts', 'export {}\n', 'Config');
    await workers.stop(id);
    expect(spaces.leasedBy(id)).toBe(clone);
    return clone;
  };
  const ticked = () => {
    setDocs([{ ...doc, workstreams: [{ ...ws('W1'), done: true }, ws('W2')] }]);
    board.docsChanged();
  };

  test('a stopped workstream the plan doc ticks off frees its clone; its branch stays there', async () => {
    const w = w1();
    const clone = await stoppedWithWork(w.id);
    const branch = board.row(w.id).branch!;
    expect(spaces.leasable()).toBe(false);
    ticked();
    await flush();
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(board.row(w.id).workspace).toBeNull();
    expect(state(w.id)).toBe('live');
    expect(board.events(w.id).at(-1)!.text).toBe('Im Plan-Doc abgehakt: Workspace freigegeben.');
    expect(git(clone, 'branch', '--list', branch)).toContain(branch);
    expect(spaces.leasable()).toBe(true);
  });

  test('one left taken before Obeya started is freed when it starts', async () => {
    const w = w1();
    await stoppedWithWork(w.id);
    // the doc was ticked off while an Obeya ran that did not free it; this one starts on the same database
    const fresh = testBoard({ store, path: main, docs: () => [{ ...doc, workstreams: [{ ...ws('W1'), done: true }, ws('W2')] }] });
    newWorkers({ board: fresh }).resumeAll();
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(fresh.item(w.id)!.state).toBe('live');
  });

  test('a workstream still open in its doc keeps the clone it was stopped with', async () => {
    const w = w1();
    const clone = await stoppedWithWork(w.id);
    board.docsChanged();
    await flush();
    expect(spaces.leasedBy(w.id)).toBe(clone);
    expect(state(w.id)).toBe('planned');
  });

  test('a deleted card frees its clone; restored, it takes the clone back while that is free', async () => {
    const c = manual();
    const clone = await stoppedWithWork(c.id);
    board.showPools(() => [{ repo: 'home', hosts: spaces.pool([]) }]);
    const taken = () => board.snapshot().workspaces![0]!.hosts[0]!.cards;
    expect(taken()).toEqual([c.id]);
    board.remove(c.id);
    await flush();
    expect(spaces.leasedBy(c.id)).toBeNull();
    expect(spaces.leasable()).toBe(true);
    // the pool the canvas shows has it free
    expect(taken()).toEqual([]);
    board.restore(c.id);
    workers.restored(c.id);
    expect(spaces.leasedBy(c.id)).toBe(clone);
    expect(taken()).toEqual([c.id]);
    await workers.start(c.id);
    expect(git(clone, 'log', '--format=%s', '-1')).toBe('Config');
  });

  test('deleted again while git puts its clone back on its branch, it frees the clone once git is done', async () => {
    const c = manual();
    await stoppedWithWork(c.id);
    board.remove(c.id);
    await flush();
    board.restore(c.id);
    workers.restored(c.id);
    board.remove(c.id);
    await flush();
    await workers.freed();
    await until(() => spaces.leasedBy(c.id) === null);
    expect(spaces.leasable()).toBe(true);
  });

  test('restored after another card took its clone, it starts in the next free one, with its branch from that clone', async () => {
    const c = manual();
    const clone = await stoppedWithWork(c.id);
    board.remove(c.id);
    await flush();
    const other = manual();
    await workers.start(other.id);
    board.restore(c.id);
    workers.restored(c.id);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).kept_in).toBe(clone);
    const second = join(dir, 'ws', '2');
    gitClone(main, second);
    await spaces.ensureClones(main, 2);
    identify(second);
    await workers.start(c.id);
    expect(board.row(c.id).workspace).toBe(second);
    expect(git(second, 'log', '--format=%s', '-1')).toBe('Config');
    // the other card's clone stays on its own branch
    expect(git(clone, 'branch', '--show-current')).toBe(board.row(other.id).branch!);
  });

  test('restored after another card worked in its clone and gave it back, it works on its own branch there', async () => {
    const c = manual();
    const clone = await stoppedWithWork(c.id);
    const branch = board.row(c.id).branch!;
    board.remove(c.id);
    await flush();
    const other = board.create({ title: 'Export readings', x: 0, y: 0 });
    await workers.start(other.id);
    expect(board.row(other.id).workspace).toBe(clone);
    commit(clone, 'other.ts', 'export {}\n', 'Other');
    await workers.stop(other.id);
    board.remove(other.id);
    await flush();
    await workers.freed();
    expect(spaces.leasedBy(other.id)).toBeNull();
    board.restore(c.id);
    workers.restored(c.id);
    await workers.start(c.id);
    expect(board.row(c.id).workspace).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe(branch);
    expect(git(clone, 'log', '--format=%s', '-1')).toBe('Config');
  });

  /** Deletes the card, whose clone another card then takes, commits its own work in and is deleted too. */
  const workedInByAnother = async (id: string) => {
    const clone = await stoppedWithWork(id);
    board.remove(id);
    await flush();
    const other = board.create({ title: 'Export readings', x: 0, y: 0 });
    await workers.start(other.id);
    commit(clone, 'other.ts', 'export {}\n', 'Other');
    await workers.stop(other.id);
    board.remove(other.id);
    await flush();
    await workers.freed();
    return clone;
  };

  test('started and stopped right after its restore, before git put its clone back on its branch, it keeps the clone', async () => {
    const c = manual();
    const clone = await workedInByAnother(c.id);
    board.restore(c.id);
    workers.restored(c.id);
    const started = workers.start(c.id);
    await workers.stop(c.id);
    await started;
    await workers.freed();
    expect(spaces.leasedBy(c.id)).toBe(clone);
    expect(board.row(c.id).workspace).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe(board.row(c.id).branch!);
  });

  test('its clone taken for another card right after its restore, before git put it back on its branch, it keeps its branch there', async () => {
    const c = manual();
    const clone = await workedInByAnother(c.id);
    board.restore(c.id);
    workers.restored(c.id);
    await workers.evict(c.id);
    await workers.freed();
    expect(spaces.leasedBy(c.id)).toBeNull();
    expect(board.row(c.id).kept_in).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe(board.row(c.id).branch!);
  });

  test('where git fails to put its clone back on its branch, its next start takes the branch from there', async () => {
    const c = manual();
    const clone = await workedInByAnother(c.id);
    // another git process at work there
    writeFileSync(join(clone, '.git', 'index.lock'), '');
    board.restore(c.id);
    workers.restored(c.id);
    await workers.freed();
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).kept_in).toBe(clone);
    rmSync(join(clone, '.git', 'index.lock'));
    await workers.start(c.id);
    expect(board.row(c.id).workspace).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe(board.row(c.id).branch!);
    expect(git(clone, 'log', '--format=%s', '-1')).toBe('Config');
  });

  /** Deletes the card, whose clone another card then takes, leaves uncommitted changes in and is deleted too; a second clone is free. */
  const leftDirtyByAnother = async (id: string) => {
    const clone = await stoppedWithWork(id);
    board.remove(id);
    await flush();
    const other = board.create({ title: 'Export readings', x: 0, y: 0 });
    await workers.start(other.id);
    expect(board.row(other.id).workspace).toBe(clone);
    writeFileSync(join(clone, 'other.ts'), 'export {}\n');
    await workers.stop(other.id);
    board.remove(other.id);
    await flush();
    await workers.freed();
    const second = join(dir, 'ws', '2');
    gitClone(main, second);
    await spaces.ensureClones(main, 2);
    identify(second);
    return { clone, second };
  };

  test('restored after another card left uncommitted changes in its clone, it starts in another, with its branch from there', async () => {
    const c = manual();
    const { clone, second } = await leftDirtyByAnother(c.id);
    board.restore(c.id);
    workers.restored(c.id);
    await until(() => board.row(c.id).kept_in === clone);
    expect(board.row(c.id).workspace).toBeNull();
    expect(spaces.leasedBy(c.id)).toBeNull();
    // the other card's work stays as it was
    expect(git(clone, 'status', '--porcelain')).toBe('?? other.ts');
    await workers.start(c.id);
    expect(board.row(c.id).workspace).toBe(second);
    expect(git(second, 'log', '--format=%s', '-1')).toBe('Config');
  });

  test('started right after its restore, before git found its clone taken by another card’s changes, it is queued and starts in another', async () => {
    const c = manual();
    const { clone, second } = await leftDirtyByAnother(c.id);
    board.restore(c.id);
    workers.restored(c.id);
    await expect(workers.start(c.id)).rejects.toMatchObject({ code: 'dirtyWorkspaces' });
    expect(state(c.id)).toBe('planned');
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).kept_in).toBe(clone);
    await workers.start(c.id);
    expect(board.row(c.id).workspace).toBe(second);
    expect(git(second, 'log', '--format=%s', '-1')).toBe('Config');
  });

  test('a stopped workstream its plan doc no longer has frees its clone; its branch stays there', async () => {
    const w = w1();
    const clone = await stoppedWithWork(w.id);
    const branch = board.row(w.id).branch!;
    setDocs([{ ...doc, workstreams: [ws('W2')] }]);
    board.docsChanged();
    await flush();
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(board.row(w.id).workspace).toBeNull();
    expect(board.events(w.id).at(-1)!.text).toBe('Nicht mehr im Plan-Doc auf dem Hauptbranch: Workspace freigegeben.');
    expect(git(clone, 'branch', '--list', branch)).toContain(branch);
    expect(spaces.leasable()).toBe(true);
  });

  test('so does one whose plan doc went from the default branch', async () => {
    const w = w1();
    await stoppedWithWork(w.id);
    setDocs([]);
    board.docsChanged();
    await flush();
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(spaces.leasable()).toBe(true);
  });

  /** An Obeya started anew on the same database, which settles the leases as it starts. */
  const restart = () => {
    const fresh = testBoard({ store, path: main, docs: () => [doc] });
    newWorkers({ board: fresh }).resumeAll();
    return fresh;
  };

  test('a finished card whose worker is done gives back the clone the pool still counts taken, at the latest when Obeya starts', async () => {
    const c = manual();
    await workers.start(c.id);
    // closed as done, its worker through, and only the lease left behind (by an Obeya before this one)
    store.update(c.id, { state: 'done', landed: null });
    expect(spaces.leasable()).toBe(false);
    const fresh = restart();
    await flush();
    expect(spaces.leasedBy(c.id)).toBeNull();
    expect(fresh.row(c.id).workspace).toBeNull();
    expect(spaces.leasable()).toBe(true);
  });

  test('a lease its card knows nothing of goes back to the pool; the card keeps what it names', async () => {
    const c = manual();
    await workers.start(c.id);
    store.update(c.id, { state: 'planned', workspace: null });
    restart();
    expect(spaces.leasedBy(c.id)).toBeNull();
    expect(spaces.leasable()).toBe(true);
  });

  test('a card whose worker still finishes after the landing keeps its clone', async () => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    await flush();
    expect(spaces.leasedBy(c.id)).toBe(clone);
    runtime.last.emit({ type: 'idle' });
    expect(spaces.leasedBy(c.id)).toBeNull();
  });

  test('a workstream in its pull request that the doc on the default branch ticks off counts as merged', async () => {
    await setup(PR);
    const w = w1();
    await workers.start(w.id);
    const clone = board.row(w.id).workspace!;
    commit(clone, 'config.ts', 'export {}\n', 'Config');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(w.id);
    board.work(w.id, { pr: JSON.stringify({ url: 'https://github.com/acme/app/pull/821', number: 821, seen: [], reported: [] }) });
    runtime.last.emit({ type: 'idle' });
    expect(state(w.id)).toBe('inPr');
    ticked();
    await flush();
    expect(state(w.id)).toBe('live');
    expect(merged).toEqual([w.id]);
    expect(runtime.last.inbox.at(-1)).toContain('Your pull request was merged');
    runtime.last.emit({ type: 'idle' });
    expect(spaces.leasedBy(w.id)).toBeNull();
    expect(board.item(w.id)!.finishing).toBeUndefined();
  });

  /** Approves the workstream's handed-over work into its pull request phase; the PR is not reported yet. */
  const approvedIntoPr = async (id: string) => {
    await workers.start(id);
    const clone = board.row(id).workspace!;
    commit(clone, 'config.ts', 'export {}\n', 'Config');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(id);
    expect(state(id)).toBe('inPr');
    return clone;
  };

  test('a workstream the doc on the default branch ticks off counts as merged though its worker never reported the pull request', async () => {
    await setup(PR);
    const w = w1();
    await approvedIntoPr(w.id);
    // the worker opened the pull request without reporting it, and someone merged it by hand
    ticked();
    await flush();
    expect(state(w.id)).toBe('live');
    expect(merged).toEqual([w.id]);
  });

  test('a box ticked in a plan folder outside the repository does not count as the pull request merged', async () => {
    await setup(PR);
    const outside: PlanDoc = { ...doc, file: '/plans/a.md' };
    setDocs([outside]);
    board.docsChanged();
    const w = board.snapshot().items.find((i) => i.label === 'W1' && board.row(i.id).plan_ref?.startsWith('/plans/'))!;
    const clone = await approvedIntoPr(w.id);
    // the worker ticks its box in the folder, which takes effect at once, then opens the pull request
    setDocs([{ ...outside, workstreams: [{ ...ws('W1'), done: true }] }]);
    board.docsChanged();
    await flush();
    expect(state(w.id)).toBe('inPr');
    expect(runtime.last.inbox.at(-1) ?? '').not.toContain('Your pull request was merged');
    board.work(w.id, { pr: JSON.stringify({ url: 'https://github.com/acme/app/pull/822', number: 822, seen: [], reported: [] }) });
    runtime.last.emit({ type: 'idle' });
    await flush();
    expect(state(w.id)).toBe('inPr');
    expect(merged).toEqual([]);
    expect(spaces.leasedBy(w.id)).toBe(clone);
  });
  test('a box ticked in a plan folder outside the repository leaves a stopped workstream stopped until its work lands', async () => {
    const outside: PlanDoc = { ...doc, file: '/plans/a.md' };
    setDocs([outside]);
    board.docsChanged();
    const w = board.snapshot().items.find((i) => i.label === 'W1' && board.row(i.id).plan_ref?.startsWith('/plans/'))!;
    const clone = await stoppedWithWork(w.id);
    // the worker ticked its box in the folder before it was stopped, which took effect at once
    setDocs([{ ...outside, workstreams: [{ ...ws('W1'), done: true }] }]);
    board.docsChanged();
    await flush();
    expect(stopped(board.item(w.id)!)).toBe(true);
    expect(spaces.leasedBy(w.id)).toBe(clone);
    expect(board.events(w.id).map((e) => e.text)).not.toContain('Im Plan-Doc abgehakt: Workspace freigegeben.');
    // its project, every box ticked, stays on the canvas with it
    expect(board.item(w.parent!)).toBeDefined();
    // started again, its work lands, and the box counts: the project's work is done once its worker is
    await workers.start(w.id);
    expect(board.row(w.id).workspace).toBe(clone);
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(w.id);
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    expect(git(main, 'log', '--format=%s')).toContain('Config');
    runtime.last.emit({ type: 'idle' });
    expect(board.item(w.parent!)!.state).toBe('done');
  });
});
