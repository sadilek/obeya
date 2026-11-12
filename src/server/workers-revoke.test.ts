import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { Forge } from './forge';
import { git } from './git';
import { fromJson } from './row';
import { artifact, commit, gitClone, identify, noForge, until } from './testing';
import { board, dir, eachTest, handedOver, main, origin, rebuild, runtime, spaces, state, workers } from './workers-fixture';

const MAIN: RepoAdapter = { ...generic, land: 'main', workspaces: 'clones' };
const PR: RepoAdapter = { ...generic, land: 'pr', workspaces: 'clones' };
const DIRECT: RepoAdapter = { ...PR, direct: true };

/** A forge that records the pull requests closed and opened, opening each as the next number. */
function recordingForge() {
  const closed: string[] = [];
  const opened: { base: string; head: string; title: string; body: string }[] = [];
  const forge: Forge = {
    ...noForge,
    close: async (_cwd, url) => void closed.push(url),
    open: async (_cwd, pr) => {
      opened.push(pr);
      return `https://github.com/acme/app/pull/${42 + opened.length}`;
    },
  };
  return { forge, closed, opened };
}

/** Landed work, approved and live, its worker done. */
async function landed() {
  const { card: c, session } = await handedOver({ commit: 'x.ts' });
  await workers.approve(c.id);
  expect(state(c.id)).toBe('live');
  session.emit({ type: 'idle' });
  return { c, session };
}

describe('taking back an approval where work lands on main', () => {
  eachTest(MAIN);

  test('a revert commit lands on main, the work goes back onto the branch, and approving again lands it again', async () => {
    rebuild({ revokeHold: 0 });
    const { c, session } = await landed();
    expect(existsSync(join(main, 'x.ts'))).toBe(true);
    expect(board.item(c.id)!.revocable).toEqual({ how: 'revert' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Revert "x.ts"');
    expect(existsSync(join(main, 'x.ts'))).toBe(false);
    const row = board.row(c.id);
    expect(row.shipped).toBeNull();
    expect(board.item(c.id)!.revocable).toBeUndefined();
    // the branch holds the work again, on top of main
    expect(git(row.workspace!, 'log', '--format=%s', '-2').split('\n')).toEqual(['x.ts', 'Revert "x.ts"']);
    expect(board.events(c.id).some((e) => e.text.startsWith('Freigabe zurückgenommen: auf main rückgängig gemacht'))).toBe(true);
    const s = runtime.last;
    expect(s).not.toBe(session);
    expect(s.inbox.at(-1)).toContain('Obeya reverted it on main');
    expect(s.inbox.at(-1)).toContain('undo it where it no longer holds');
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(existsSync(join(main, 'x.ts'))).toBe(true);
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['x.ts', 'Revert "x.ts"', 'x.ts']);
  });

  test('"Undo" within the window leaves everything as it was', async () => {
    rebuild({ revokeHold: 60_000 });
    const { c } = await landed();
    workers.revoke(c.id);
    workers.keepApproval(c.id);
    expect(() => workers.keepApproval(c.id)).toThrow();
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('x.ts');
  });

  test('later work on main that builds on it stops the revert: the card stays live and says why', async () => {
    rebuild({ revokeHold: 0 });
    const { c } = await landed();
    identify(main);
    commit(main, 'x.ts', 'changed by hand\n', 'Builds on x');
    workers.revoke(c.id);
    await until(() => board.events(c.id).some((e) => e.kind === 'error'));
    expect(board.events(c.id).at(-1)!.text).toContain('Freigabe nicht zurückgenommen');
    expect(board.events(c.id).at(-1)!.text).toContain('x.ts');
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Builds on x');
    await workers.freed();
    expect(board.row(c.id).workspace).toBeNull();
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
    expect(board.item(c.id)!.revocable).toEqual({ how: 'revert' });
  });

  test('an approval that holds for the next handover is dropped: that handover waits for the owner', async () => {
    rebuild({ revokeHold: 0 });
    const { card: c } = await handedOver({ commit: 'x.ts' });
    board.work(c.id, { state: 'working', need: null, approved_at: new Date().toISOString() });
    expect(board.item(c.id)!.revocable).toEqual({ how: 'approval' });
    workers.revoke(c.id);
    await until(() => !board.row(c.id).approved_at);
    expect(fromJson(board.row(c.id).unheard)?.at(-1)?.text).toContain('it waits for their approval');
  });
});

describe('taking back an approval where work goes out as a pull request', () => {
  eachTest(PR, true);

  test('an open pull request is closed and the card waits for the owner again; the worker may not report it again', async () => {
    const { forge, closed } = recordingForge();
    rebuild({ revokeHold: 0, forge });
    const { card: c, session } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id);
    expect(board.item(c.id)!.revocable).toEqual({ how: 'closePr' });
    await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/7' });
    session.emit({ type: 'idle' });
    expect(board.item(c.id)!.revocable).toEqual({ how: 'closePr', pr: 7 });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    expect(closed).toEqual(['https://github.com/acme/app/pull/7']);
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.events(c.id).at(-1)!.text).toBe('Freigabe zurückgenommen: Pull Request #7 ohne Merge geschlossen. Die Aufgabe wartet wieder auf dich.');
    expect(fromJson(board.row(c.id).unheard)?.at(-1)?.text).toContain('Obeya closed your pull request #7 without merging');
    expect(await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/8' })).toContain('Not recorded');
  });

  test('a merged pull request gets a rollback PR; once it is merged, the work is back on the branch and the card waits for the owner', async () => {
    const { forge, opened } = recordingForge();
    rebuild({ revokeHold: 0, forge });
    const { card: c, session, workspace } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id);
    await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/7' });
    // the forge squashes it onto main
    const other = join(dir, 'merger');
    gitClone(origin, other);
    identify(other);
    git(other, 'fetch', '--quiet', workspace, `${board.row(c.id).branch}`);
    git(other, 'merge', '--squash', '--quiet', 'FETCH_HEAD');
    git(other, 'commit', '--quiet', '-m', 'Zählerstände exportieren (#7)');
    git(other, 'push', '--quiet', 'origin', 'main');
    workers.merged(c.id, git(other, 'rev-parse', 'HEAD'));
    expect(state(c.id)).toBe('live');
    session.emit({ type: 'idle' });
    expect(board.item(c.id)!.revocable).toEqual({ how: 'rollbackPr', pr: 7 });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'inPr');
    expect(board.events(c.id).at(-1)!.text).toBe('Freigabe zurückgenommen: Rollback-PR #43 macht PR #7 rückgängig. Obeya mergt ihn, sobald er bereit ist; danach wartet die Aufgabe wieder auf dich.');
    const branch = board.row(c.id).branch!;
    expect(opened).toEqual([{ base: 'main', head: `${branch}-rollback`, title: 'Revert "Zählerstände exportieren"', body: 'Reverts #7.' }]);
    expect(board.item(c.id)).toMatchObject({ rollbackOf: 7, pr: { number: 43 } });
    expect(board.item(c.id)!.revocable).toBeUndefined();
    expect(git(origin, 'log', '--format=%s', '-1', `${branch}-rollback`)).toBe('Revert "Zählerstände exportieren (#7)"');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya opened a pull request that reverts it');
    runtime.last.emit({ type: 'idle' });
    // the forge merges the rollback
    git(other, 'pull', '--quiet', 'origin', `${branch}-rollback`);
    git(other, 'push', '--quiet', 'origin', 'main');
    expect(existsSync(join(other, 'x.ts'))).toBe(false);
    workers.merged(c.id, git(other, 'rev-parse', 'HEAD'));
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    const ws = board.row(c.id).workspace!;
    expect(git(ws, 'log', '--format=%s', '-1')).toBe('Zählerstände exportieren');
    expect(existsSync(join(ws, 'x.ts'))).toBe(true);
    expect(git(ws, 'rev-parse', 'HEAD^')).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(runtime.last.inbox.at(-1)).toContain('is merged: main no longer has your work');
  });

  test('a rollback PR closed without a merge leaves the work on main: the card is live again', async () => {
    const { forge } = recordingForge();
    rebuild({ revokeHold: 0, forge });
    const { card: c, session, workspace } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id);
    await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/7' });
    const other = join(dir, 'merger');
    gitClone(origin, other);
    git(other, 'fetch', '--quiet', workspace, `${board.row(c.id).branch}`);
    git(other, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD');
    git(other, 'push', '--quiet', 'origin', 'main');
    workers.merged(c.id, git(other, 'rev-parse', 'HEAD'));
    session.emit({ type: 'idle' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'inPr');
    workers.prClosed(c.id);
    await until(() => state(c.id) === 'live' && !board.row(c.id).workspace);
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.events(c.id).at(-1)!.text).toBe('Rollback-PR #43 ohne Merge geschlossen: Die Arbeit bleibt auf main, die Aufgabe ist wieder live.');
    expect(board.item(c.id)!.revocable).toEqual({ how: 'rollbackPr', pr: 7 });
  });

  test('a rebase merge of several commits is rolled back whole, though the forge names only its last commit', async () => {
    const { forge } = recordingForge();
    rebuild({ revokeHold: 0, forge });
    const { card: c, session, workspace } = await handedOver({ commit: 'x.ts' });
    commit(workspace, 'y.ts');
    await workers.approve(c.id);
    await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/7' });
    const head = git(workspace, 'rev-parse', 'HEAD');
    // the forge rebases both commits onto main, which moved meanwhile
    const other = join(dir, 'merger');
    gitClone(origin, other);
    identify(other);
    commit(other, 'z.ts');
    git(other, 'fetch', '--quiet', workspace, `${board.row(c.id).branch}`);
    git(other, 'cherry-pick', 'FETCH_HEAD~1', 'FETCH_HEAD');
    git(other, 'push', '--quiet', 'origin', 'main');
    board.work(c.id, { pr: JSON.stringify({ ...fromJson(board.row(c.id).pr), mergedHead: head }) });
    workers.merged(c.id, git(other, 'rev-parse', 'HEAD'));
    session.emit({ type: 'idle' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'inPr');
    const branch = board.row(c.id).branch!;
    git(other, 'pull', '--quiet', 'origin', `${branch}-rollback`);
    expect(existsSync(join(other, 'x.ts'))).toBe(false);
    expect(existsSync(join(other, 'y.ts'))).toBe(false);
    expect(existsSync(join(other, 'z.ts'))).toBe(true);
  });

  test('a pull request the worker reports while the others are being closed is closed too', async () => {
    const closed: string[] = [];
    let first = true;
    const forge: Forge = {
      ...noForge,
      close: async (_cwd, url) => {
        closed.push(url);
        if (first) {
          first = false;
          await runtime.last.call('pr_opened', { url: 'https://github.com/acme/docs/pull/3' });
        }
      },
    };
    rebuild({ revokeHold: 0, forge, remote: 'git@github.com:acme/app.git' });
    const { card: c, session } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id);
    await session.call('pr_opened', { url: 'https://github.com/acme/app/pull/7' });
    session.emit({ type: 'idle' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    expect(closed).toEqual(['https://github.com/acme/app/pull/7', 'https://github.com/acme/docs/pull/3']);
  });
});

describe('taking back an approval that was pushed straight to main', () => {
  eachTest(DIRECT, true);

  test('the revert is pushed to the remote’s main too, without a pull request', async () => {
    const { forge, opened } = recordingForge();
    rebuild({ revokeHold: 0, forge });
    const { card: c, session } = await handedOver({ commit: 'x.ts' });
    await workers.approve(c.id, { direct: true });
    expect(state(c.id)).toBe('live');
    session.emit({ type: 'idle' });
    expect(fromJson(board.row(c.id).shipped)?.direct).toBe(true);
    expect(board.item(c.id)!.revocable).toEqual({ how: 'revert' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['Revert "x.ts"', 'x.ts', 'init']);
    expect(opened).toEqual([]);
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    expect(runtime.last.inbox.at(-1)).toContain('pushed to the remote');
  });
});

describe('taking back an approval where cards work in worktrees', () => {
  eachTest({ ...MAIN, workspaces: 'worktrees' });

  test('the revert lands on main from a worktree on the card’s branch, which holds the work again', async () => {
    rebuild({ revokeHold: 0 });
    const { card: c, session } = await handedOver();
    commit(board.row(c.id).workspace!, 'x.ts');
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    session.emit({ type: 'idle' });
    await workers.approve(c.id);
    session.emit({ type: 'idle' });
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    expect(git(main, 'log', '--format=%s', '-2').split('\n')).toEqual(['Revert "x.ts"', 'x.ts']);
    const branch = board.row(c.id).branch!;
    expect(git(main, 'log', '--format=%s', '-1', branch)).toBe('x.ts');
    expect(git(main, 'rev-parse', `${branch}^`)).toBe(git(main, 'rev-parse', 'main'));
  });
});

describe('taking back an approval that a restart cut off', () => {
  eachTest(MAIN);

  test('work already off main goes back onto the branch, and the card waits for the owner', async () => {
    rebuild({ revokeHold: 0 });
    const { c } = await landed();
    const s = fromJson(board.row(c.id).shipped)!;
    // Obeya stopped right after the revert landed
    workers.revoke(c.id);
    await until(() => state(c.id) === 'waiting:demo' && !board.row(c.id).landed);
    const ws = board.row(c.id).workspace!;
    git(ws, 'reset', '--quiet', '--hard', 'HEAD~1');
    board.work(c.id, { landed: JSON.stringify({ revoking: true, reapply: { base: s.base, commit: s.commit, onto: 'local' } }) });
    rebuild({ revokeHold: 0 });
    workers.resumeAll();
    await until(() => !board.row(c.id).landed);
    expect(state(c.id)).toBe('waiting:demo');
    expect(git(ws, 'log', '--format=%s', '-1')).toBe('x.ts');
    expect(board.events(c.id).at(-1)!.text).toContain('wieder auf dem Branch');
  });

  test('cut off before anything changed, the card stays live and says so', async () => {
    rebuild({ revokeHold: 0 });
    const { c } = await landed();
    board.work(c.id, { landed: JSON.stringify({ revoking: true }) });
    workers.resumeAll();
    await until(() => !board.row(c.id).landed);
    expect(state(c.id)).toBe('live');
    expect(board.events(c.id).at(-1)!.text).toContain('Obeya wurde dabei beendet');
  });
});
