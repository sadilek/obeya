import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { needsYou } from '../core/types';
import { artifact, identify, until } from './testing';
import { Board } from './board';
import { Workers } from './workers';
import { board, dir, doc, eachTest, flush, main, manual, merged, origin, runtime, setDocs, setup, setWorkers, spaces, state, store, workers, ws } from './workers-fixture';
import { git } from './workspaces';

eachTest();

describe('landing through a pull request', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
  });

  test('approval starts the PR phase: the branch stays in the clone, main is left alone', async () => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'x.ts'), '');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'X');
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

  test('approving work that changed nothing makes the card done: no pull request, the worker hears so and finishes', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    await s.call('ready_for_review', { summary: 'Demo aufgenommen, keine Code-Änderung.', demo: artifact() });
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

  test('a worker whose approved work turns out to change nothing closes the card itself instead of opening a pull request', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    expect(await s.call('close_unchanged', {})).toContain('only work the owner approved');
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'x.ts'), '');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'X');
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
  const settingUp = async (settings: object) => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    mkdirSync(join(clone, '.obeya'), { recursive: true });
    writeFileSync(join(clone, '.obeya/settings.json'), JSON.stringify(settings));
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Obeya settings');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    return c;
  };

  test('lands as the branch says: on main where the repository still has pull requests, which the owner sees before approving', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
    const c = await settingUp({ land: 'main' });
    expect(board.item(c.id)!.lands).toEqual({ land: 'main' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Obeya settings');
  });

  test('as a pull request where the repository still lands on main', async () => {
    const c = await settingUp({ land: 'pr' });
    expect(board.item(c.id)!.lands).toEqual({ land: 'pr' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
  });

  test('the settings of this machine go first', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'pr', workspaces: 'clones' }, machineSettings: () => ({ land: 'pr' }) }));
    const c = await settingUp({ land: 'main', checks: ['bun test'] });
    expect(board.item(c.id)!.lands).toBeUndefined();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
  });
});

describe('landing on main from a clone of the remote', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // the clone's origin is the remote, as one listed in the settings or made while work went out as pull requests
    setup({ ...generic, land: 'main', workspaces: 'clones' }, true);
  });

  test('main moved on in the checkout, not on the remote: the work is rebased onto the checkout’s main and lands', async () => {
    const c = board.create({ title: 'Zählerstände exportieren', x: 0, y: 0 });
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'k.ts'), 'k');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Zählerstände als CSV');
    // another card landed on the checkout's main meanwhile, which nobody pushed
    writeFileSync(join(main, 'other.ts'), 'other');
    git(main, 'add', '.');
    git(main, 'commit', '--quiet', '-m', 'Andere Karte');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Zählerstände als CSV', 'Andere Karte', 'init']);
  });
});

describe('approving directly onto main where work goes out as a pull request', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', direct: true, workspaces: 'clones' }, true);
  });

  const commitIn = (path: string, file: string, msg: string) => {
    writeFileSync(join(path, file), msg);
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', msg);
  };
  /** Someone else pushes a commit onto origin's main. */
  const pushElsewhere = (file: string, msg: string) => {
    const other = join(dir, `other-${msg}`);
    git(dir, 'clone', '--quiet', origin, other);
    identify(other);
    commitIn(other, file, msg);
    git(other, 'push', '--quiet', 'origin', 'main');
  };
  const handedOver = async (title = 'Zählerstände exportieren') => {
    const c = board.create({ title, x: 0, y: 0 });
    await workers.start(c.id);
    const session = runtime.last;
    return { c, session, clone: board.row(c.id).workspace! };
  };

  test('Obeya pushes the work onto origin/main itself: no pull request, the card is live, the Obeya checkout stays', async () => {
    const { c, session, clone } = await handedOver();
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
    const { c, session, clone } = await handedOver();
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
    const { c, session, clone } = await handedOver();
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
    const { c, session, clone } = await handedOver();
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

  test('without `direct` in the settings the approval is refused; where work lands on main anyway it is a plain approval', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'pr', workspaces: 'clones' } }));
    const { c, session, clone } = await handedOver();
    commitIn(clone, 'x.ts', 'X');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    const err = await workers.approve(c.id, { direct: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'noDirect' });
    expect(state(c.id)).toBe('waiting:demo');
    expect(git(origin, 'log', '--format=%s', 'main')).toBe('init');

    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones' });
    const d = await handedOver('Logo');
    commitIn(d.clone, 'logo.svg', 'Logo');
    await d.session.call('ready_for_review', { summary: 'S', demo: artifact() });
    await workers.approve(d.c.id, { direct: true });
    expect(state(d.c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Logo');
  });

  test('work that changed nothing closes as done, approved directly or not', async () => {
    const { c, session } = await handedOver();
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
  function withSite(adapter: Parameters<typeof setup>[0], withOrigin = false) {
    rmSync(dir, { recursive: true, force: true });
    setup(adapter, withOrigin);
    approvals = [];
    const onApproval = (id: string) => (approvals.push(id), board.item(id)!.title === 'Ohne Seite' ? null : PAGE);
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter, onApproval }));
  }
  /** A handed-over card whose last commit has a trailer of its own. */
  async function handedOver(title = 'Zählerstände exportieren', commit = true) {
    const c = board.create({ title, x: 0, y: 0 });
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    if (commit) {
      writeFileSync(join(clone, 'x.ts'), 'x');
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', 'Erste Hälfte');
      writeFileSync(join(clone, 'y.ts'), 'y');
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', 'Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    }
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    return c;
  }

  test('landing on main: the last commit gets the trailer beside its own, its author kept', async () => {
    withSite({ ...generic, land: 'main', workspaces: 'clones' });
    const c = await handedOver();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(approvals).toEqual([c.id]);
    expect(git(main, 'log', '-1', '--format=%B')).toBe(`Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${PAGE}`);
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Zählerstände als CSV', 'Erste Hälfte', 'init']);
    expect(git(main, 'log', '-1', '--format=%an <%ae>')).toBe('T <t@example.com>');
  });

  test('pushed directly onto origin’s main, the same', async () => {
    withSite({ ...generic, land: 'pr', direct: true, workspaces: 'clones' }, true);
    const c = await handedOver();
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('live');
    expect(git(origin, 'log', '-1', '--format=%(trailers:key=Demo-Video)', 'main')).toBe(PAGE);
  });

  test('a card without a page lands as it was', async () => {
    withSite({ ...generic, land: 'main', workspaces: 'clones' });
    const c = await handedOver('Ohne Seite');
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '-1', '--format=%B')).toBe('Zählerstände als CSV\n\nDer Export liest alle Zähler.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  });

  test('approved into a pull request, the demo goes out all the same', async () => {
    withSite({ ...generic, land: 'pr', workspaces: 'clones' });
    const c = await handedOver();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(approvals).toEqual([c.id]);
  });

  test('with nothing to land, too', async () => {
    withSite({ ...generic, land: 'main', workspaces: 'clones' });
    const c = await handedOver('Nur eine Analyse', false);
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(approvals).toEqual([c.id]);
  });
});

describe('the landing message names the demo’s page', () => {
  const URL_ = 'https://demos.example.dev/zahlerstande-exportieren-1/';
  /** Whether the repository has a demo site; on approval, the page goes out (`publishing`) unless `share` says otherwise. */
  let site: boolean;
  let onApproval: (id: string) => void;
  function withSite(adapter: Parameters<typeof setup>[0] = { ...generic, land: 'main', workspaces: 'clones' }) {
    rmSync(dir, { recursive: true, force: true });
    setup(adapter);
    site = true;
    onApproval = (id) => board.work(id, { share: JSON.stringify({ slug: 's', state: 'publishing', next: [{ dir: demoDir(id) }] }) });
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter, shares: () => site, onApproval: (id) => (onApproval(id), null) }));
  }
  async function handedOver(commit = true) {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    if (commit) {
      writeFileSync(join(clone, 'x.ts'), 'x');
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', 'X');
    }
    await runtime.last.call('ready_for_review', { summary: 'S', demo: { ...artifact(), page: { title: 'CSV export', text: 'Meter readings download as CSV.' } } });
    runtime.last.emit({ type: 'idle' });
    return c;
  }
  const demoDir = (id: string) => (JSON.parse(board.row(id).demo!) as { dir: string }).dir;
  /** The page went out, as the demo site tells it. */
  function published(id: string) {
    const dir = demoDir(id);
    board.work(id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir, shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });
    workers.pageSettled(id, { url: URL_ });
  }

  test('a page still going out when the work lands: the worker waits, and hears its address once it is online', async () => {
    withSite();
    const c = await handedOver();
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
    withSite();
    const c = await handedOver();
    const session = runtime.last;
    await workers.approve(c.id);
    board.work(c.id, { share: JSON.stringify({ slug: 's' }) });
    workers.pageSettled(c.id, { why: 'upload refused: token expired' });
    expect(session.inbox.at(-1)).toContain('did not go out (upload refused: token expired)');
    expect(session.inbox.at(-1)).toContain('ask the owner for a link');
  });

  test('a page that went out while the worker did not hear of it: its turn’s end tells it', async () => {
    withSite();
    const c = await handedOver();
    const session = runtime.last;
    await workers.approve(c.id);
    // the page went out while nobody told the workers (a restart in between, say)
    board.work(c.id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir: demoDir(c.id), shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });
    session.emit({ type: 'idle' });
    expect(session.inbox.at(-1)).toContain(`shared with the team on a page of its own: ${URL_}`);
    expect(session.closed).toBe(false);
  });

  test('a page online already: the landing message names it, and the worker finishes with its turn', async () => {
    withSite();
    onApproval = (id) => published(id);
    const c = await handedOver();
    const session = runtime.last;
    await workers.approve(c.id);
    expect(session.inbox.at(-1)).toContain(`Your demo is shared with the team on a page of its own: ${URL_}. Link it`);
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
  });

  test('without a shared page, or without a demo site, the message says so: the worker asks before it links nothing', async () => {
    withSite();
    onApproval = () => {};
    const c = await handedOver();
    await workers.approve(c.id);
    expect(runtime.last.inbox.at(-1)).toContain('Your demo is not shared on a page the team can open. Before you point anyone to your demo (an issue you close, say), ask the owner for a link.');
    withSite();
    site = false;
    const d = await handedOver();
    await workers.approve(d.id);
    expect(runtime.last.inbox.at(-1)).toContain('This repository has no demo site');
  });

  test('work its worker closes as needing no pull request names the page in the tool’s result, and waits for it the same way', async () => {
    withSite({ ...generic, land: 'pr', workspaces: 'clones' });
    const c = await handedOver(false);
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
    withSite();
    const c = await handedOver(false);
    const session = runtime.last;
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(session.inbox.at(-1)).toContain('Obeya tells you its address once it is online');
    published(c.id);
    expect(session.inbox.at(-1)).toContain(URL_);

    withSite({ ...generic, land: 'pr', workspaces: 'clones' });
    onApproval = (id) => published(id);
    const d = await handedOver();
    await workers.approve(d.id);
    workers.merged(d.id);
    expect(runtime.last.inbox.at(-1)).toContain(`Your pull request was merged; the card is live.\n\nYour demo is shared with the team on a page of its own: ${URL_}.`);
  });
});

describe('the worker hears what became of its demo’s page', () => {
  const URL_ = 'https://demos.example.dev/zahlerstande-exportieren-1/';
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones' });
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, shares: () => true, onApproval: () => null }));
  });
  async function handedOver() {
    const c = manual();
    await workers.start(c.id);
    await runtime.last.call('ready_for_review', { summary: 'S', demo: { ...artifact(), page: { title: 'CSV export', text: 'Meter readings download as CSV.' } } });
    runtime.last.emit({ type: 'idle' });
    return c;
  }
  const demoDir = (id: string) => (JSON.parse(board.row(id).demo!) as { dir: string }).dir;
  const going = (id: string) => board.work(id, { share: JSON.stringify({ slug: 's', state: 'publishing', next: [{ dir: demoDir(id) }] }) });
  const online = (id: string) => board.work(id, { share: JSON.stringify({ slug: 's', url: URL_, demos: [{ dir: demoDir(id), shown: { title: 'T', text: 'T', chapters: [], kind: 'html' } }] }) });

  test('shared by the owner after the handover: their next words come with the page’s address and where Obeya links it', async () => {
    const c = await handedOver();
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
    const c = await handedOver();
    const session = runtime.last;
    workers.message(c.id, 'One more column.');
    going(c.id);
    expect(session.toolStep()).toContain('it is going online right now');
    expect(session.toolStep()).toBeUndefined();
    online(c.id);
    expect(session.toolStep()).toContain(URL_);
  });

  test('a share that fails, and a page withdrawn, are news too', async () => {
    const c = await handedOver();
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
    const c = await handedOver();
    const session = runtime.last;
    online(c.id);
    await workers.approve(c.id);
    const told = session.inbox.at(-1)!;
    expect(told).toContain(`Your demo is shared with the team on a page of its own: ${URL_}.`);
    expect(told).not.toContain('The owner shared your demo');
  });
});

describe('a prototype built on in a clone', () => {
  test('the idea takes over the clone and the branch, renamed; the clone is busy until it is done', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' } }));
    const idea = board.create({ idea: true, title: 'Logo', x: 0, y: 0 });
    const prototype = board.addPrototype(idea.id, 'Prototyp: Logo', 'zeigen');
    await workers.start(prototype.id);
    const path = board.row(prototype.id).workspace!;
    const old = board.row(prototype.id).branch!;
    writeFileSync(join(path, 'logo.svg'), '<svg/>');
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', 'Prototyp');
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
  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** Starts W1, commits a file in its clone and hands it over. */
  const handOver = async () => {
    const w = w1();
    await workers.start(w.id);
    const clone = board.row(w.id).workspace!;
    writeFileSync(join(clone, 'config.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Config');
    await runtime.last.call('ready_for_review', { summary: 'Konfiguration vorbereitet.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    return w;
  };

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

  test('the last workstream ticked off: the project stays while its worker finishes, then goes into the archive', async () => {
    const w = await handOver();
    const project = board.snapshot().items.find((i) => i.kind === 'project')!;
    setDocs([{ ...doc, workstreams: [{ ...ws('W1'), done: true }] }]);
    await workers.approve(w.id);
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    runtime.last.emit({ type: 'idle' });
    expect(board.item(project.id)).toBeUndefined();
    expect(board.archived().map((i) => i.id)).toEqual([project.id, w.id]);
  });

  test('the last workstream lands and its doc goes: the project stays while its worker finishes, then goes into the archive', async () => {
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
    expect(board.item(project.id)).toBeUndefined();
    expect(board.archived().map((i) => i.id)).toEqual([project.id, w.id]);
  });

  describe('awaiting a restart', () => {
    const restarting = (b: Board) => new Workers({ board: b, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, restartsFor: () => 'obeya' });
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
      const b = new Board(store, board.canvas, () => ({ docs: [], dirs: [] }));
      setWorkers(restarting(b));
      workers.resumeAll();
      return b;
    };

    test('the project stays over the restart and goes into the archive once its worker is done', async () => {
      const w = await landWaiting();
      const project = board.snapshot().items.find((i) => i.kind === 'project')!;
      board.docsChanged();
      expect(board.item(w.id)!.finishing).toBe(true);
      const after = restart();
      expect(after.item(project.id)).toBeDefined();
      expect(runtime.last.spec.resume).toBe('sess-1');
      runtime.last.emit({ type: 'idle' });
      expect(spaces.leasedBy(w.id)).toBeNull();
      expect(after.item(project.id)).toBeUndefined();
      expect(after.archived().map((i) => i.id)).toEqual([project.id, w.id]);
    });

    test('a project archived while its workstream finished comes back, and goes once its worker is done', async () => {
      const w = await landWaiting();
      const project = board.snapshot().items.find((i) => i.kind === 'project')!;
      // as Obeya did before: archived at the landing, its worker unseen
      store.update(project.id, { archived_at: new Date().toISOString() });
      const after = restart();
      expect(after.item(project.id)).toBeDefined();
      expect(after.item(w.id)!.finishing).toBe(true);
      runtime.last.emit({ type: 'idle' });
      expect(spaces.leasedBy(w.id)).toBeNull();
      expect(after.item(project.id)).toBeUndefined();
      expect(after.archived().map((i) => i.id)).toEqual([project.id, w.id]);
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
    expect(state(w.id)).toBe('planned');
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
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
  });

  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** W1 in its pull request #821, its worker idle. */
  const inPr = async () => {
    const w = w1();
    await workers.start(w.id);
    const clone = board.row(w.id).workspace!;
    writeFileSync(join(clone, 'config.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Config');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(w.id);
    board.work(w.id, { pr: JSON.stringify({ url: 'https://github.com/acme/app/pull/821', number: 821, seen: [], reported: [] }) });
    return w;
  };

  test('stays live while the Lesestand lacks the merge commit, and is planned again once it holds it', async () => {
    const w = await inPr();
    // the merge as GitHub made it, not yet on the Lesestand's main
    git(main, 'checkout', '--quiet', '-b', 'merged');
    writeFileSync(join(main, 'config.ts'), 'export {}\n');
    git(main, 'add', '.');
    git(main, 'commit', '--quiet', '-m', 'Config (#821)');
    const commit = git(main, 'rev-parse', 'HEAD');
    git(main, 'checkout', '--quiet', 'main');
    workers.merged(w.id, commit);
    runtime.last.emit({ type: 'idle' });
    board.docsChanged();
    expect(state(w.id)).toBe('live');

    git(main, 'merge', '--quiet', '--ff-only', 'merged');
    board.docsChanged();
    expect(state(w.id)).toBe('planned');
    expect(w1().landedPart).toEqual({ commit, pr: { url: 'https://github.com/acme/app/pull/821', number: 821 } });
    // the pull request is history now: starting again opens a new one
    expect(w1().pr).toBeUndefined();
    await workers.start(w.id);
    expect(runtime.last.inbox[0]).toContain('pull request #821 (https://github.com/acme/app/pull/821)');
  });

  test('without the merge commit, the Lesestand after the next fetch stands in for it', async () => {
    const w = await inPr();
    workers.merged(w.id);
    runtime.last.emit({ type: 'idle' });
    board.docsChanged();
    expect(state(w.id)).toBe('live');
    board.lesestandMoved('home', git(main, 'rev-parse', 'HEAD'));
    expect(state(w.id)).toBe('planned');
    expect(w1().landedPart).toEqual({ commit: git(main, 'rev-parse', 'HEAD'), pr: { url: 'https://github.com/acme/app/pull/821', number: 821 } });
  });
});

describe('a workspace its card will not work in again goes back to the pool', () => {
  const w1 = () => board.snapshot().items.find((i) => i.label === 'W1')!;
  /** Starts the card, commits a file in its clone and stops it: the clone stays the card's. */
  const stoppedWithWork = async (id: string) => {
    await workers.start(id);
    const clone = board.row(id).workspace!;
    writeFileSync(join(clone, 'config.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Config');
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
    const fresh = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs: [{ ...doc, workstreams: [{ ...ws('W1'), done: true }, ws('W2')] }], dirs: [] }));
    new Workers({ board: fresh, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' } }).resumeAll();
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

  test('restored after another card took its clone, it starts in the next free one', async () => {
    const c = manual();
    await stoppedWithWork(c.id);
    board.remove(c.id);
    await flush();
    const other = manual();
    await workers.start(other.id);
    board.restore(c.id);
    workers.restored(c.id);
    expect(board.row(c.id).workspace).toBeNull();
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
    const fresh = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs: [doc], dirs: [] }));
    new Workers({ board: fresh, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' } }).resumeAll();
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
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
    const w = w1();
    await workers.start(w.id);
    const clone = board.row(w.id).workspace!;
    writeFileSync(join(clone, 'config.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Config');
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
});
