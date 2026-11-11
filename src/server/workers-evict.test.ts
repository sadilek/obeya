import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequest } from './board';
import { commit, identify, until } from './testing';
import { board, eachTest, main, manual, runtime, spaces, state, workers } from './workers-fixture';
import { git } from './workspaces';

eachTest();

/** Waits until `done` holds: git keeps the card's work and frees its clone in the background. */
async function freed(done: () => boolean) {
  await until(done);
  await workers.freed();
}

describe("taking a card's workspace", () => {
  test('the worker stops, its uncommitted work goes into a commit on its branch, and the clone is free and clean', async () => {
    const c = manual();
    await workers.start(c.id);
    const { workspace, branch } = board.row(c.id);
    commit(workspace!, 'work.ts', 'x', 'Work');
    writeFileSync(join(workspace!, 'README.md'), 'changed\n');
    writeFileSync(join(workspace!, 'new.ts'), 'new');

    expect(await workers.evict(c.id)).toBe(true);
    expect(state(c.id)).toBe('planned');
    expect(runtime.last.closed).toBe(true);
    expect(board.row(c.id)).toMatchObject({ workspace: null, branch, kept_in: workspace });
    expect(spaces.list()).toEqual([{ path: workspace!, card_id: null }]);
    expect(git(workspace!, 'status', '--porcelain')).toBe('');
    expect(git(workspace!, 'log', '--format=%s', '-2', branch!).split('\n')).toEqual(['Uncommitted work, kept by Obeya as the card\'s workspace went to another card', 'Work']);
    expect(board.events(c.id).at(-1)!.text).toContain(workspace!);
    // a card holding no clone has none to give
    expect(workers.evictable(c.id)).toBe(false);
    await expect(workers.evict(c.id)).rejects.toThrow(BadRequest);
  });

  test('the card goes on in another clone of the machine, which takes the branch from the one that kept it, the work uncommitted again', async () => {
    await spaces.ensureClones(main, 2);
    for (const w of spaces.list()) identify(w.path);
    const c = manual();
    await workers.start(c.id);
    const { workspace: first, branch } = board.row(c.id);
    commit(first!, 'work.ts', 'x', 'Work');
    writeFileSync(join(first!, 'README.md'), 'changed\n');
    writeFileSync(join(first!, 'new.ts'), 'new');
    const e = manual();
    await workers.start(e.id);
    await workers.evict(c.id);

    // another card takes the clone the branch was kept in, and the other one is free again
    const d = manual();
    await workers.start(d.id);
    expect(board.row(d.id).workspace).toBe(first);
    await workers.stop(e.id);
    await workers.start(c.id);
    await workers.prepared();
    const second = board.row(c.id).workspace!;
    expect(second).not.toBe(first);
    expect(board.row(c.id).kept_in).toBeNull();
    expect(git(second, 'branch', '--show-current')).toBe(branch!);
    expect(git(second, 'log', '--format=%s', '-1')).toBe('Work');
    expect(git(second, 'diff', '--name-only')).toBe('README.md');
    expect(git(second, 'ls-files', '--others', '--exclude-standard')).toBe('new.ts');
    expect(runtime.last.inbox[0]).toContain('already holds earlier work');
    // the copy in the first clone goes: the card's branch is where it works
    await freed(() => git(first!, 'branch', '--list', branch!) === '');
    expect(git(first!, 'branch', '--list', branch!)).toBe('');
  });

  test('a card stopped while git takes its branch to another clone leaves that clone clean, and the one that kept the branch keeps it', async () => {
    await spaces.ensureClones(main, 2);
    for (const w of spaces.list()) identify(w.path);
    const c = manual();
    await workers.start(c.id);
    const { workspace: first, branch } = board.row(c.id);
    writeFileSync(join(first!, 'new.ts'), 'new');
    const e = manual();
    await workers.start(e.id);
    await workers.evict(c.id);
    const d = manual();
    await workers.start(d.id);
    await workers.stop(e.id);

    void workers.start(c.id);
    const second = board.row(c.id).workspace!;
    await workers.stop(c.id);
    await freed(() => !spaces.list().some((w) => w.card_id === c.id));
    expect(second).not.toBe(first);
    expect(git(second, 'status', '--porcelain')).toBe('');
    expect(board.row(c.id).kept_in).toBe(first);
    expect(git(first!, 'branch', '--list', branch!)).toContain(branch!);
  });

  test('a card that waits for the owner, or was stopped with work, gives its clone up too; one whose work landed does not', async () => {
    const c = manual();
    await workers.start(c.id);
    await runtime.last.call('ask', { question: 'Welche Farbe?' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(workers.evictable(c.id)).toBe(true);
    expect(await workers.evict(c.id)).toBe(true);
    expect(state(c.id)).toBe('planned');

    await workers.start(c.id);
    await workers.prepared();
    const { workspace } = board.row(c.id);
    writeFileSync(join(workspace!, 'new.ts'), 'new');
    await workers.stop(c.id);
    expect(board.row(c.id).workspace).toBe(workspace);
    // a stopped card stays where it was: no worker was on it
    expect(await workers.evict(c.id)).toBe(false);
    expect(board.row(c.id)).toMatchObject({ workspace: null, kept_in: workspace });

    board.work(c.id, { workspace, landed: JSON.stringify({}) });
    expect(workers.evictable(c.id)).toBe(false);
  });
});
