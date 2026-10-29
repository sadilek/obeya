import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { BadRequest, Board } from './board';
import { artifact, until } from './testing';
import { Workers } from './workers';
import { board, dir, doc, eachTest, flush, main, manual, runtime, setDocs, setup, setWorkers, spaces, state, store, workers, ws } from './workers-fixture';
import { GIT, git, gitOrNull } from './workspaces';

eachTest();

describe('a worktree per card', () => {
  beforeEach(async () => {
    await workers?.freed();
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees' });
  });

  const commitIn = (path: string, file: string, msg: string) => {
    writeFileSync(join(path, file), msg);
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', msg);
  };

  test('a worktree git cannot add puts the card back as planned, its conversation saying why', async () => {
    const c = manual();
    // the Obeya checkout is on it: git adds no second worktree there
    board.work(c.id, { branch: 'main' });
    await workers.start(c.id);
    expect(board.item(c.id)!.state).toBe('planned');
    expect(board.row(c.id)).toMatchObject({ workspace: null, branch: 'main', status_line: null });
    expect(spaces.list()).toEqual([]);
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'error', author: 'obeya', text: expect.stringContaining('git worktree add') });
    expect(runtime.sessions).toHaveLength(0);
  });

  test('where git fails, what came meanwhile does not keep the card at work: a snooze goes, the owner’s words wait for the next start', async () => {
    const c = manual();
    board.work(c.id, { branch: 'main' });
    const started = workers.start(c.id);
    workers.message(c.id, 'Auch die alten Zählerstände.');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'hint', unread: true });
    workers.snooze(c.id, new Date(Date.now() + 3_600_000).toISOString());
    await started;
    expect(board.item(c.id)).toMatchObject({ state: 'planned' });
    expect(board.item(c.id)!.snoozed).toBeUndefined();
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.events(c.id).some((e) => e.kind === 'error')).toBe(true);
    // started again on a branch of its own, its worker hears the words with its task
    board.work(c.id, { branch: null });
    await workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('Auch die alten Zählerstände.');
    expect(board.events(c.id).find((e) => e.text === 'Auch die alten Zählerstände.')!.unread).toBeUndefined();
  });

  test('shut down while git adds a worktree, the workers start nobody once it is there', async () => {
    mkdirSync(join(main, '.git/hooks'), { recursive: true });
    writeFileSync(join(main, '.git/hooks/post-checkout'), '#!/bin/sh\nsleep 0.3\n', { mode: 0o755 });
    const c = manual();
    const started = workers.start(c.id);
    workers.shutdown();
    await started;
    expect(runtime.sessions).toHaveLength(0);
  });

  test('stopped while git adds its worktree, the card gives it back once git is done; words meanwhile wait for the worker', async () => {
    mkdirSync(join(main, '.git/hooks'), { recursive: true });
    writeFileSync(join(main, '.git/hooks/post-checkout'), '#!/bin/sh\nsleep 0.3\n', { mode: 0o755 });
    const c = manual();
    const started = workers.start(c.id);
    expect(board.item(c.id)).toMatchObject({ state: 'working', statusLine: 'Bereitet den Workspace vor …' });
    // it holds a slot, and a restart waits for it
    expect(workers.inTurn()).toEqual([c.id]);
    expect(workers.busyCards()).toEqual([c.id]);
    await workers.stop(c.id);
    expect(board.item(c.id)!.state).toBe('planned');
    expect(board.row(c.id).workspace).toBeNull();
    await started;
    expect(runtime.sessions).toHaveLength(0);
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    expect(spaces.list().map((w) => w.card_id)).toEqual([null]);
    expect(workers.inTurn()).toEqual([]);

    // started again, its worktree is there: its worker starts at once
    await workers.start(c.id);
    expect(runtime.last.spec.cwd).toBe(board.row(c.id).workspace!);

    // the owner's words while git works go to the worker that starts
    const d = board.create({ title: 'Ablesung importieren', x: 0, y: 0 });
    const started2 = workers.start(d.id);
    workers.message(d.id, 'Auch die alten Zählerstände.');
    expect(runtime.sessions).toHaveLength(1);
    await started2;
    const s = runtime.last;
    expect(s.inbox[0]).toContain('Ablesung importieren');
    expect([...s.inbox, s.toolStep() ?? ''].join('\n')).toContain('Auch die alten Zählerstände.');
  });

  test('cards work in parallel and land one after the other on main', async () => {
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(a.id);
    await workers.start(b.id);
    const wa = board.row(a.id).workspace!;
    const wb = board.row(b.id).workspace!;
    expect(wa).not.toBe(wb);
    commitIn(wa, 'a.ts', 'A');
    commitIn(wb, 'b.ts', 'B');
    for (const c of [a, b]) {
      const session = runtime.sessions.find((s) => s.spec.cwd === board.row(c.id).workspace)!;
      await session.call('ready_for_review', { summary: 'S', demo: artifact() });
      session.emit({ type: 'idle' });
      await workers.approve(c.id);
      expect(state(c.id)).toBe('live');
      session.emit({ type: 'idle' });
    }
    // B was rebased onto A before the fast-forward
    await workers.freed();
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['B', 'A', 'init']);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', 'obeya/*')).toBe('');
  });

  test('a repository on master without a remote: cards start from master and land there', async () => {
    git(main, 'branch', '-m', 'master');
    commitIn(main, 'base.ts', 'Auf master');
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    expect(git(wa, 'log', '--format=%s', '-1')).toBe('Auf master');
    commitIn(wa, 'a.ts', 'A');
    expect((await spaces.changes(a.id)).map((c) => c.file)).toEqual(['a.ts']);
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(a.id);
    expect(state(a.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-3', 'master').split('\n')).toEqual(['A', 'Auf master', 'init']);
    expect(git(main, 'branch', '--list', 'main')).toBe('');
  });

  test("a card built on a long-lived branch counts only its own work, not that branch's commits ahead of main", async () => {
    git(main, 'checkout', '--quiet', '-b', 'feature');
    for (const n of [1, 2, 3]) commitIn(main, `feature${n}.ts`, `Feature ${n}`);
    git(main, 'checkout', '--quiet', 'main');
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    // the worker goes onto the long-lived branch and builds on it
    git(wa, 'reset', '--quiet', '--hard', 'feature');
    commitIn(wa, 'a.ts', 'A');
    writeFileSync(join(wa, 'feature1.ts'), 'changed by the card');
    writeFileSync(join(wa, 'new.ts'), 'not added yet');
    expect((await spaces.changes(a.id)).map((c) => c.file)).toEqual(['a.ts', 'feature1.ts', 'new.ts']);
    expect((await spaces.diff(a.id, true))!.files.map((f) => f.file)).toEqual(['a.ts', 'feature1.ts', 'new.ts']);
    expect(await spaces.changedFiles(a.id)).toEqual(['a.ts', 'feature1.ts', 'new.ts']);
    // main merged into a card's branch since does not count as the card's either
    commitIn(main, 'main.ts', 'On main');
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(b.id);
    const wb = board.row(b.id).workspace!;
    git(wb, 'reset', '--quiet', '--hard', 'HEAD~1');
    commitIn(wb, 'b.ts', 'B');
    git(wb, 'merge', '--quiet', '--no-edit', 'main');
    expect((await spaces.changes(b.id)).map((c) => c.file)).toEqual(['b.ts']);
    // nor on the card built on the long-lived branch
    git(wa, 'add', '.');
    git(wa, 'commit', '--quiet', '-m', 'more');
    git(wa, 'merge', '--quiet', '--no-edit', 'main');
    expect((await spaces.changes(a.id)).map((c) => c.file)).toEqual(['a.ts', 'feature1.ts', 'new.ts']);
    expect((await spaces.diff(a.id, true))!.files.map((f) => f.file)).toEqual(['a.ts', 'feature1.ts', 'new.ts']);
  });

  test("a card's branch that another card is built on still holds the first card's work", async () => {
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    commitIn(wa, 'a.ts', 'A');
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(b.id);
    const wb = board.row(b.id).workspace!;
    git(wb, 'reset', '--quiet', '--hard', board.row(a.id).branch!);
    commitIn(wb, 'b.ts', 'B');
    expect((await spaces.changes(a.id)).map((c) => c.file)).toEqual(['a.ts']);
    expect((await spaces.changes(b.id)).map((c) => c.file)).toEqual(['a.ts', 'b.ts']);
  });

  test('a branch that changes thousands of files gives the Koordinator the changed lines of the first 200', async () => {
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    for (let n = 0; n < 250; n++) writeFileSync(join(wa, `f${String(n).padStart(3, '0')}.ts`), 'one\ntwo\n');
    git(wa, 'add', '.');
    git(wa, 'commit', '--quiet', '-m', 'many');
    const changes = await spaces.changes(a.id);
    expect(changes).toHaveLength(200);
    expect(changes[199]).toEqual({ file: 'f199.ts', regions: ['1-2'] });
  });

  test("an idea built on a prototype takes over its worktree and branch, and lands from there", async () => {
    const idea = board.create({ idea: true, title: 'Logo', x: 0, y: 0 });
    const prototype = board.addPrototype(idea.id, 'Prototyp: Logo – Wortmarke', 'Wortmarke');
    await workers.start(prototype.id);
    const path = board.row(prototype.id).workspace!;
    const old = board.row(prototype.id).branch!;
    commitIn(path, 'logo.svg', 'Prototyp Wortmarke');
    const moved = await workers.buildOn(prototype.id, board.item(idea.id)!);
    // the worktree stays where it is; its branch now has the idea's name
    expect(moved.path).toBe(path);
    expect(moved.branch).toMatch(/^obeya\/logo-/);
    expect(git(path, 'branch', '--show-current')).toBe(moved.branch);
    expect(git(main, 'branch', '--list', old)).toBe('');
    expect(spaces.leasedBy(idea.id)).toBe(path);
    expect(spaces.leasedBy(prototype.id)).toBeNull();
    expect(board.item(prototype.id)).toBeUndefined();
    expect(board.archived().find((i) => i.id === prototype.id)).toMatchObject({ prototypeEnd: 'built' });

    board.work(idea.id, { state: 'planned', workspace: moved.path, branch: moved.branch, built_on: prototype.id });
    await workers.start(idea.id);
    expect(board.row(idea.id).workspace).toBe(path);
    const session = runtime.last;
    expect(session.spec.cwd).toBe(path);
    commitIn(path, 'logo.test.ts', 'Logo mit Tests');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    session.emit({ type: 'idle' });
    await workers.approve(idea.id);
    expect(state(idea.id)).toBe('live');
    session.emit({ type: 'idle' });
    // the prototype's commits are part of what landed; worktree and branch are gone
    await workers.freed();
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Logo mit Tests', 'Prototyp Wortmarke', 'init']);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', 'obeya/*')).toBe('');
  });

  test('a rebase conflict goes back to the worker with the files; a blocked checkout stays with the owner', async () => {
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(a.id);
    await workers.start(b.id);
    commitIn(board.row(a.id).workspace!, 'same.ts', 'A');
    commitIn(board.row(b.id).workspace!, 'same.ts', 'B');
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a.id).workspace)!;
    const sb = runtime.sessions.find((s) => s.spec.cwd === board.row(b.id).workspace)!;
    await sa.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(a.id);
    await sb.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(b.id);
    expect(state(b.id)).toBe('working');
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'error', code: 'landConflict' });
    expect(sb.inbox.at(-1)).toContain('conflicts in same.ts');

    // the owner has local edits in the Obeya checkout on a file the card changes
    const c = board.create({ title: 'Dritte', x: 0, y: 0 });
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'mine.ts', 'C');
    writeFileSync(join(main, 'mine.ts'), 'local edit');
    const sc = runtime.sessions.find((s) => s.spec.cwd === board.row(c.id).workspace)!;
    await sc.call('ready_for_review', { summary: 'S', demo: artifact() });
    sc.emit({ type: 'idle' });
    const err = await workers.approve(c.id).catch((e) => e);
    expect(err).toMatchObject({ code: 'landMerge' });
    expect(state(c.id)).toBe('waiting:demo');
    // the worker hears it with the owner's next words, rather than telling them the card still waits as if nothing had happened
    workers.message(c.id, 'Warum ist das nicht gelandet?');
    expect(sc.inbox.at(-1)).toContain('the owner approved your work, but Obeya could not land it on main');
    expect(sc.inbox.at(-1)).toContain('Warum ist das nicht gelandet?');
    // approved again in vain, then once the owner cleared the checkout: the worker hears it landed, not an earlier failure
    sc.emit({ type: 'idle' });
    await workers.approve(c.id).catch(() => {});
    rmSync(join(main, 'mine.ts'));
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(sc.inbox.at(-1)).toContain('is on main now');
    expect(sc.inbox.at(-1)).not.toContain('could not land');
  });

  test('an approval while a restart is due that cannot land: the worker leaves the conflict until Obeya resumes it', async () => {
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(a.id);
    await workers.start(b.id);
    commitIn(board.row(a.id).workspace!, 'same.ts', 'A');
    commitIn(board.row(b.id).workspace!, 'same.ts', 'B');
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a.id).workspace)!;
    const sb = runtime.sessions.find((s) => s.spec.cwd === board.row(b.id).workspace)!;
    await sa.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(a.id);
    await sb.call('ready_for_review', { summary: 'S', demo: artifact() });
    sb.emit({ type: 'idle' });
    // the landing of the first card is about to restart Obeya; the owner approves the second meanwhile
    workers.restartDue({ reason: 'code', deadline: Date.now() + 12 * 60_000 });
    expect(board.events(b.id).at(-1)).not.toMatchObject({ kind: 'state', text: expect.stringContaining('Neustart') });
    await workers.approve(b.id);
    expect(state(b.id)).toBe('working');
    expect(sb.inbox.at(-1)).toContain('conflicts in same.ts');
    expect(sb.inbox.at(-1)).toContain('Obeya is about to restart (new code landed on main)');
    expect(sb.inbox.at(-1)).toContain('leave the work it asks for until Obeya resumes you, and end your turn, without handing over');
    expect(sb.inbox.at(-1)).not.toContain('finish the step you are in');
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya', text: 'Obeya wartet auf einen Neustart; der Agent macht danach weiter.' });
    // it ends the turn at once: paused, the approval still held for the handover after the restart
    sb.emit({ type: 'idle' });
    expect(workers.busyCards()).not.toContain(b.id);
    expect(state(b.id)).toBe('working');
    expect(board.row(b.id).approved_at).toBeTruthy();
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
  });

  test('an approval that could not land holds: the worker brings the branch up to date and it lands', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees', app: { run: 'bun start' } });
    const demo = join(dir, 'demo');
    mkdirSync(demo);
    writeFileSync(join(demo, 'demo.mp4'), '0');
    writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEins.\n');
    const handOver = { summary: 'S', demo: { dir: demo, chapters: ['Eins'] } };
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
    await workers.start(a.id);
    await workers.start(b.id);
    const wb = board.row(b.id).workspace!;
    commitIn(board.row(a.id).workspace!, 'same.ts', 'A');
    commitIn(wb, 'same.ts', 'B');
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a.id).workspace)!;
    const sb = runtime.sessions.find((s) => s.spec.cwd === wb)!;
    await sa.call('ready_for_review', handOver);
    await workers.approve(a.id);
    await sb.call('ready_for_review', handOver);
    await workers.approve(b.id);
    expect(state(b.id)).toBe('working');
    expect(sb.inbox.at(-1)).toContain('without asking the owner again');

    // the worker resolves the conflict and hands over again, without a new demo
    expect(() => git(wb, 'rebase', '--quiet', 'main')).toThrow();
    writeFileSync(join(wb, 'same.ts'), 'A and B');
    git(wb, 'add', '.');
    Bun.spawnSync([GIT, '-C', wb, '-c', 'core.editor=true', 'rebase', '--continue']);
    expect(await sb.call('ready_for_review', { summary: 'Konflikt gelöst', demo: artifact() })).toContain('lands your work');
    expect(state(b.id)).toBe('working');
    sb.emit({ type: 'idle' });
    await until(() => state(b.id) === 'live');
    expect(git(main, 'show', 'HEAD:same.ts')).toBe('A and B');
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya', text: 'Nach der Freigabe auf main gelandet.' });
    expect(board.row(b.id).approved_at).toBeNull();
  });

  test('feedback instead of an approval is reviewed again; a blocked checkout waits for the owner', async () => {
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    commitIn(main, 'c.ts', 'main');
    const sc = runtime.last;
    await sc.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(c.id);
    expect(board.row(c.id).approved_at).toBeTruthy();
    git(wc, 'reset', '--quiet', '--hard', 'main');
    commitIn(wc, 'c.ts', 'C on main');

    // the Obeya checkout moved off main in the meantime: the card waits and needs a new approval
    git(main, 'checkout', '--quiet', '-b', 'elsewhere');
    await sc.call('ready_for_review', { summary: 'S', demo: artifact() });
    expect(state(c.id)).toBe('working');
    sc.emit({ type: 'idle' });
    await until(() => state(c.id) === 'waiting:demo');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'error', code: 'landCheckout' });
    expect(board.row(c.id).approved_at).toBeNull();

    // feedback while it waits: what comes back is reviewed, not landed
    git(main, 'checkout', '--quiet', 'main');
    workers.message(c.id, 'Bitte noch anders.');
    await sc.call('ready_for_review', { summary: 'S', demo: artifact() });
    sc.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:demo');
  });

  test('commits that conflict one by one but not as a whole land as one commit', async () => {
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    const trailer = 'Co-Authored-By: W <w@example.com>';
    writeFileSync(join(wc, 'same.ts'), 'C draft');
    git(wc, 'add', '.');
    git(wc, 'commit', '--quiet', '-m', 'C draft', '-m', trailer);
    git(wc, 'rm', '--quiet', 'same.ts');
    writeFileSync(join(wc, 'c.ts'), 'C');
    git(wc, 'add', '.');
    git(wc, 'commit', '--quiet', '-m', 'C', '-m', trailer);
    commitIn(main, 'same.ts', 'main');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['C draft', 'main', 'init']);
    expect(git(main, 'log', '--format=%B', '-1')).toBe(`C draft\n\nC\n\n${trailer}`);
    expect(git(main, 'show', 'HEAD:same.ts')).toBe('main');
    expect(git(main, 'show', 'HEAD:c.ts')).toBe('C');
  });

  test('after landing, the worker finishes what remains in its worktree; then worktree and branch go', async () => {
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    const branch = board.row(c.id).branch!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.inbox.at(-1)).toContain('is on main now');
    expect(s.inbox.at(-1)).not.toContain('after_restart');
    // its worktree is still there, at what landed
    expect(git(wc, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'HEAD'));
    expect(await s.call('ready_for_review', { summary: 'S', demo: artifact() })).toContain('on main already');
    // the owner can still reach it, and it works on
    workers.message(c.id, 'Auch die alten Karten nachtragen.');
    expect(s.toolStep()).toContain('Auch die alten Karten nachtragen.');
    expect(s.call('after_restart', {})).toContain('does not start again');
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
    await workers.freed();
    expect(board.row(c.id).workspace).toBeNull();
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', branch)).toBe('');
  });

  test('asked about a live card, its worker is resumed in a fresh workspace, answers, and ends again', async () => {
    const ended: string[] = [];
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, onWorkEnded: (id) => void ended.push(id) }));
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(ended).toEqual([c.id]);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.finishing).toBeUndefined();

    workers.message(c.id, 'Wie lade ich das Video hoch?', [], true);
    await workers.prepared();
    const f = runtime.last;
    expect(f).not.toBe(s);
    expect(f.spec.resume).toBe('sess-1');
    expect(board.row(c.id).workspace).toBe(f.spec.cwd);
    expect(f.inbox[0]).toContain('The owner asks about this card (spoken');
    expect(f.inbox[0]).toContain('Its work is on main');
    expect(f.inbox[0]).toContain('Wie lade ich das Video hoch?');
    expect(board.item(c.id)).toMatchObject({ state: 'live', finishing: true, followUp: true });
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'hint', author: 'owner', text: 'Wie lade ich das Video hoch?' });
    // a second word while it answers reaches the same session
    workers.message(c.id, 'Und die Untertitel?');
    expect(runtime.last).toBe(f);
    expect(f.toolStep()).toContain('Und die Untertitel?');
    expect(f.call('reply', { text: 'Mit gh release upload.' })).toContain('Shown');
    // its closing words repeat the reply: they fold under it
    f.emit({ type: 'text', text: 'Mit gh release upload, wie gesagt.' });
    f.emit({ type: 'idle' });
    expect(board.events(c.id).filter((e) => e.author === 'worker').slice(-2)).toMatchObject([
      { kind: 'talk', text: 'Mit gh release upload.' },
      { kind: 'closing', text: 'Mit gh release upload, wie gesagt.' },
    ]);
    expect(f.closed).toBe(true);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.finishing).toBeUndefined();
    expect(board.item(c.id)!.followUp).toBeUndefined();
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).landed).toBeNull();
    // the Arbeitsrückschau read the card's runs when its work ended
    expect(ended).toEqual([c.id]);
  });

  test('a card closed without a change can be asked about too; it stays done', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 'sess-1' });
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Warum?');
    await workers.prepared();
    expect(runtime.last.inbox[0]).toContain('closed without a change');
    expect(board.item(c.id)).toMatchObject({ state: 'done', finishing: true, followUp: true });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('done');
    expect(board.item(c.id)!.finishing).toBeUndefined();
  });

  /** A card whose work landed from the only clone, which another card holds now. */
  async function landedWithoutClone() {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones' });
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    const branch = board.row(c.id).branch!;
    commitIn(clone, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    s.emit({ type: 'idle' });
    const d = board.create({ title: 'Andere Karte', x: 0, y: 200 });
    await workers.start(d.id);
    expect(board.row(d.id).workspace).toBe(clone);
    return { c, d, clone, branch };
  }

  test('asked about a finished card while no clone is free, its worker answers in a temporary worktree at its branch', async () => {
    const { c, clone, branch } = await landedWithoutClone();
    workers.message(c.id, 'Wie lade ich das Video hoch?');
    await workers.prepared();
    const f = runtime.last;
    expect(f.spec.resume).toBe('sess-1');
    const tree = board.row(c.id).workspace!;
    expect(f.spec.cwd).toBe(tree);
    expect(tree).toBe(join(dir, 'ws', 'follow-up', c.id.slice(0, 8)));
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', branch));
    // it took no clone
    expect(spaces.list().map((w) => w.card_id)).not.toContain(c.id);
    expect(f.inbox[0]).toContain('temporary worktree');
    expect(f.inbox[0]).toContain('need_clone');
    expect(f.spec.tools.map((t) => t.name)).toContain('need_clone');
    expect(board.item(c.id)).toMatchObject({ state: 'live', finishing: true, followUp: true });
    f.call('reply', { text: 'Mit gh release upload.' });
    f.emit({ type: 'idle' });
    expect(f.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
    expect(board.row(c.id).workspace).toBeNull();
    // removed in the background, its entry in the clone pruned
    await until(() => !existsSync(tree) && gitOrNull(clone, 'worktree', 'list')?.split('\n').length === 1);
  });

  test('a follow-up whose agent needs a full clone waits for the next free one and goes on there by itself', async () => {
    const { c, d, clone } = await landedWithoutClone();
    workers.message(c.id, 'Läuft die Demo noch?');
    await workers.prepared();
    const f = runtime.last;
    const tree = board.row(c.id).workspace!;
    expect(f.call('need_clone', {})).toContain('Recorded');
    f.emit({ type: 'idle' });
    expect(f.closed).toBe(true);
    await until(() => !existsSync(tree));
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.item(c.id)).toMatchObject({ state: 'live', finishing: true, followUp: true, waitsForClone: true, statusLine: 'Wartet auf Workspace' });
    // the owner's words meanwhile wait for it
    workers.message(c.id, 'Und die Untertitel?');
    expect(runtime.last).toBe(f);
    expect(workers.takeClone(c.id)).toBe(false);
    await workers.stop(d.id);
    expect(workers.takeClone(c.id)).toBe(true);
    await workers.prepared();
    const g = runtime.last;
    expect(g).not.toBe(f);
    expect(g.spec.resume).toBe('sess-1');
    expect(g.spec.cwd).toBe(clone);
    expect(g.spec.tools.map((t) => t.name)).not.toContain('need_clone');
    expect(g.inbox[0]).toContain('A clone is free now');
    expect(g.inbox[0]).toContain('Und die Untertitel?');
    expect(board.item(c.id)!.waitsForClone).toBeUndefined();
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    g.call('reply', { text: 'Ja.' });
    g.emit({ type: 'idle' });
    expect(g.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
    expect(spaces.list().map((w) => w.card_id)).toEqual([null]);
  });

  test('a follow-up waiting for a clone ends when the owner stops it', async () => {
    const { c } = await landedWithoutClone();
    workers.message(c.id, 'Läuft die Demo noch?');
    await workers.prepared();
    runtime.last.call('need_clone', {});
    runtime.last.emit({ type: 'idle' });
    await workers.stop(c.id);
    expect(board.item(c.id)!.finishing).toBeUndefined();
    expect(workers.takeClone(c.id)).toBe(false);
  });

  test('a finished card no agent worked on cannot be asked about', () => {
    const c = manual();
    board.work(c.id, { state: 'live' });
    expect(() => workers.message(c.id, 'Warum?')).toThrow(BadRequest);
  });

  test('a worker whose remaining work needs the new code waits for the restart and goes on after it', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees' });
    const restarting = (b: Board) =>
      new Workers({ board: b, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, restartsFor: () => 'obeya' });
    setWorkers(restarting(board));
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(s.inbox.at(-1)).toContain('call after_restart');
    expect(s.call('after_restart', {})).toContain('Recorded');
    s.emit({ type: 'idle' });
    // it waits, and is no reason to put off the restart
    expect(s.closed).toBe(false);
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.finishing).toBe(true);

    // Obeya starts again: the worker resumes its session in the worktree it had
    workers.shutdown();
    const after = restarting(new Board(store, board.canvas, () => ({ docs: [doc], dirs: [] })));
    after.resumeAll();
    const resumed = runtime.last;
    expect(resumed).not.toBe(s);
    expect(resumed.spec.resume).toBe('sess-1');
    expect(resumed.spec.cwd).toBe(wc);
    expect(resumed.inbox[0]).toContain('runs main with your change now');
    resumed.emit({ type: 'idle' });
    expect(resumed.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).landed).toBeNull();
    await after.freed();
  });

  test('approving work without commits lands nothing: the card is done, main untouched, worktree and branch go', async () => {
    const c = manual();
    await workers.start(c.id);
    const branch = board.row(c.id).branch!;
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    s.emit({ type: 'idle' });
    await workers.freed();
    expect(s.closed).toBe(true);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', branch)).toBe('');
  });

  test('work approved while its worker ends a reply lands, and the worker still hears so and finishes what remains', async () => {
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    // the owner says yes to publishing after the landing, and approves while the worker still answers
    workers.message(c.id, 'ja');
    s.call('reply', { text: 'I will publish once it is on main.' });
    await workers.approve(c.id);
    expect(s.inbox.at(-1)).toContain('is on main now');
    // the notice came too late for the reply's turn: the session takes it in a turn of its own
    s.emit({ type: 'text', text: 'Nothing is published yet.' });
    s.emit({ type: 'idle', more: true });
    expect(s.closed).toBe(false);
    expect(board.row(c.id).workspace).toBe(wc);
    expect(board.item(c.id)!.finishing).toBe(true);
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'node scripts/publish.ts' } });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
  });

  test('stopping a worker that finishes after the landing frees its worktree; the card stays live', async () => {
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    await workers.stop(c.id);
    expect(state(c.id)).toBe('live');
    expect(runtime.last.closed).toBe(true);
    await workers.freed();
    expect(board.row(c.id).workspace).toBeNull();
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a turn after the landing that an error cut off is tried once more, then goes to the owner; the card does not finish', async () => {
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(false);
    expect(workers.busyCards().length).toBeGreaterThan(0);
    expect(s.inbox.at(-1)).toContain('go on with what remained after the landing');
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toContain('529 Overloaded');
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.closed).toBe(false);
    // the question is no reason to put off a restart
    expect(workers.busyCards()).toEqual([]);
    // the owner's answer has the worker try again; once it gets through, the card finishes
    workers.answer(c.id, 'Nochmal versuchen');
    expect(state(c.id)).toBe('live');
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
  });

  test('a worker that works on by itself after its failed turn went to the owner takes the question back, and the card stays live', async () => {
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    for (let i = 0; i < 2; i++) {
      s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
      s.emit({ type: 'idle' });
    }
    expect(state(c.id)).toBe('waiting:question');
    s.emit({ type: 'text', text: 'Weiter.' });
    expect(state(c.id)).toBe('live');
  });

  test('a worker that pauses after the landing for a restart it was told of keeps its workspace, and goes on after the restart', async () => {
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    // a restart Obeya does not start for this landing (another repository's adapter, say) comes while it finishes
    workers.restartDue({ reason: 'repository', deadline: Date.now() + 60_000 });
    expect(s.inbox.at(-1)).toContain('Pause at the next safe point');
    s.emit({ type: 'text', text: 'Pausing for the restart.' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(false);
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(board.row(c.id).workspace).toBe(wc);
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'obeya', kind: 'state' });

    workers.shutdown();
    const after = new Workers({ board: new Board(store, board.canvas, () => ({ docs: [doc], dirs: [] })), runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' } });
    after.resumeAll();
    const resumed = runtime.last;
    expect(resumed).not.toBe(s);
    expect(resumed.spec.resume).toBe('sess-1');
    expect(resumed.spec.cwd).toBe(wc);
    expect(resumed.inbox[0]).toContain('If you had paused for the restart, go on from there.');
    resumed.emit({ type: 'idle' });
    expect(resumed.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    await after.freed();
  });

  test('after the landing, a worker waiting for a deploy in the background keeps its workspace until the watcher wakes it', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, backgroundGrace: 5 }));
    const c = manual();
    await workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'until deployed; do sleep 30; done', run_in_background: true } });
    s.emit({ type: 'background', tasks: [{ id: 'w1', description: 'Wait for the deploy' }] });
    s.emit({ type: 'text', text: 'Ich warte auf den Prod-Deploy und bereite danach das Senden vor.' });
    s.emit({ type: 'idle', background: 1 });
    // the deploy takes longer than a sign of life would: the watcher still runs
    await Bun.sleep(40);
    expect(s.closed).toBe(false);
    expect(workers.busyCards().length).toBeGreaterThan(0);
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(board.row(c.id).workspace).toBe(wc);
    // the deploy is done: the watcher ends and wakes the worker, which does what remained
    s.emit({ type: 'background', tasks: [] });
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/send.ts' } });
    s.emit({ type: 'idle', background: 0 });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
  });

  test('a turn after the landing that an error cut off while a restart is due waits for the restart, which resumes it', async () => {
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    workers.restartDue({ reason: 'code', deadline: Date.now() + 60_000 });
    const sent = s.inbox.length;
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    // no second try that holds off the restart, and no end of the card either
    expect(s.inbox).toHaveLength(sent);
    expect(workers.busyCards()).toEqual([]);
    expect(s.closed).toBe(false);
    expect(board.item(c.id)!.finishing).toBe(true);
    workers.shutdown();
    const after = new Workers({ board: new Board(store, board.canvas, () => ({ docs: [doc], dirs: [] })), runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' } });
    after.resumeAll();
    expect(runtime.last).not.toBe(s);
    expect(runtime.last.spec.resume).toBe('sess-1');
  });

  test('a turn after the landing that the usage limit stopped waits for the limit and goes on; the card does not finish', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, limitMargin: 30 }));
    const c = manual();
    await workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'S', demo: artifact() });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
    s.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 20 } });
    s.emit({ type: 'idle' });
    const sent = s.inbox.length;
    // no try that runs into the limit again, no question to the owner, and no end of the card either
    expect(state(c.id)).toBe('live');
    expect(s.closed).toBe(false);
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    await Bun.sleep(60);
    expect(s.inbox).toHaveLength(sent + 1);
    expect(s.inbox.at(-1)).toContain('usage limit');
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // once it has done what remained, the card finishes
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
  });

  test("an idea's plan doc that lands is remembered for the project it becomes", async () => {
    const i = board.create({ idea: true, title: 'Groß', x: 0, y: 0 });
    board.work(i.id, { state: 'planned' });
    await workers.start(i.id);
    const wi = board.row(i.id).workspace!;
    mkdirSync(join(wi, 'docs/plan'), { recursive: true });
    writeFileSync(join(wi, 'docs/plan/README.md'), 'x');
    commitIn(wi, 'docs/plan/gross.md', '# Groß');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(i.id);
    expect(state(i.id)).toBe('live');
    expect(JSON.parse(board.row(i.id).plan_docs!)).toEqual(['docs/plan/README.md', 'docs/plan/gross.md']);
    // the project takes the idea's place; the idea goes once its worker is done after the landing
    setDocs([doc, { file: 'docs/plan/gross.md', title: 'Groß', goal: 'G', workstreams: [ws('W1')], markdown: '' }]);
    board.docsChanged();
    expect(board.snapshot().items.find((p) => p.title === 'Groß' && p.kind === 'project')).toMatchObject({ origin: i.id, x: 0, y: 0 });
    expect(board.item(i.id)).toBeDefined();
    runtime.last.emit({ type: 'idle' });
    expect(board.item(i.id)).toMatchObject({ finishing: true });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(i.id)).toBeUndefined();
    expect(board.archived().map((a) => a.id)).toContain(i.id);
  });

  test('a stopped card keeps its worktree and picks it up again', async () => {
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'draft.ts'), 'draft');
    await workers.stop(a.id);
    await workers.start(a.id);
    expect(board.row(a.id).workspace).toBe(wa);
    expect(git(wa, 'status', '--porcelain')).toContain('draft.ts');
  });

  test('a deleted card loses its worktree once nothing in it is uncommitted; its branch stays, and a restored card starts there again', async () => {
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    const branch = board.row(a.id).branch!;
    commitIn(wa, 'a.ts', 'A');
    await workers.stop(a.id);
    board.remove(a.id);
    await flush();
    await workers.freed();
    expect(existsSync(wa)).toBe(false);
    expect(spaces.leasedBy(a.id)).toBeNull();
    expect(git(main, 'branch', '--list', branch)).toContain(branch);
    board.restore(a.id);
    workers.restored(a.id);
    await workers.start(a.id);
    expect(git(board.row(a.id).workspace!, 'log', '--format=%s', '-1')).toBe('A');
  });

  test('a deleted card whose worktree holds uncommitted changes keeps it as it is', async () => {
    const a = manual();
    await workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'draft.ts'), 'draft');
    await workers.stop(a.id);
    board.remove(a.id);
    await flush();
    expect(git(wa, 'status', '--porcelain')).toContain('draft.ts');
    expect(spaces.leasedBy(a.id)).toBe(wa);
  });
});
