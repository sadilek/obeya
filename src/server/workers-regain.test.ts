// A card waiting for the owner, or in its pull request, that lost its workspace without being planned
// again: what comes for its worker takes it a fresh workspace on its branch, and the session goes on there.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { git } from './git';
import { fromJson } from './row';
import { commit, heard, identify } from './testing';
import { PLANNED_AGAIN } from './workers';
import { board, defaultAdapter, eachTest, handedOver, manual, origin, rebuild, runtime, spaces, workers } from './workers-fixture';

const unread = (id: string) => board.events(id).filter((e) => e.unread);

describe('a card in its pull request restored after another card took its clone', () => {
  eachTest();

  /** A card in its pull request with a commit, deleted, its clone taken by another card, and restored. */
  async function restoredWithoutClone() {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    const clone = board.row(c.id).workspace!;
    const branch = board.row(c.id).branch!;
    identify(clone);
    const head = commit(clone, 'a.ts');
    s.emit({ type: 'idle' });
    board.work(c.id, { state: 'inPr', need: null });
    board.remove(c.id);
    await heard();
    await workers.freed();
    const other = board.create({ title: 'Export readings', x: 0, y: 200 });
    await workers.start(other.id);
    expect(board.row(other.id).workspace).toBe(clone);
    board.restore(c.id);
    workers.restored(c.id);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).kept_in).toBe(clone);
    // its session, open in a clone that is another card's now, ends
    expect(s.closed).toBe(true);
    return { c, other, clone, branch, head };
  }

  test('news of its pull request and a note wait for the next free clone, and the session goes on there with them, on the card’s branch', async () => {
    const { c, other, clone, branch, head } = await restoredWithoutClone();
    const n = runtime.sessions.length;
    workers.prEvent(c.id, 'Check rot.', 'Checks failed on your pull request: test.');
    workers.message(c.id, 'Bitte auch als CSV.');
    // no clone is free: no agent works on them yet, and the card says what it waits for
    expect(runtime.sessions.length).toBe(n);
    expect(board.item(c.id)).toMatchObject({ state: 'inPr', waitsForClone: true, statusLine: 'Wartet auf Workspace' });
    expect(unread(c.id).map((e) => e.text)).toEqual(['Bitte auch als CSV.']);
    expect(board.events(c.id).filter((e) => e.text === board.t.worker.awaitsClone)).toHaveLength(1);
    expect(workers.takeClone(c.id)).toBe(false);
    // the other card gives the clone back
    await workers.stop(other.id);
    board.remove(other.id);
    await heard();
    await workers.freed();
    expect(workers.takeClone(c.id)).toBe(true);
    await workers.prepared();
    const g = runtime.last;
    expect(runtime.sessions.length).toBe(n + 1);
    expect(g.spec.resume).toBe('sess-1');
    expect(g.spec.cwd).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe(branch);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    for (const said of ['Your workspace is gone', 'Checks failed on your pull request: test.', 'Bitte auch als CSV.']) expect(g.inbox.join('\n')).toContain(said);
    expect(board.item(c.id)!.waitsForClone).toBeUndefined();
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    expect(board.row(c.id).kept_in).toBeNull();
    expect(unread(c.id)).toEqual([]);
  });

  test('stopped while it waits for a clone, it waits no more', async () => {
    const { c } = await restoredWithoutClone();
    workers.message(c.id, 'Bitte auch als CSV.');
    expect(board.item(c.id)!.waitsForClone).toBe(true);
    // "Stop" on a card in its pull request plans it again (`Canvas.stop`)
    board.work(c.id, PLANNED_AGAIN);
    expect(board.item(c.id)!.waitsForClone).toBeUndefined();
    expect(workers.takeClone(c.id)).toBe(false);
  });
});

describe('a handed-over card whose clone’s folder was deleted', () => {
  eachTest(defaultAdapter, true);

  test('a note takes a fresh clone, with the branch as origin has it, and the session goes on there', async () => {
    const { card: c, session: s, workspace: clone } = await handedOver({ commit: 'a.ts' });
    s.emit({ type: 'session', id: 'sess-1' });
    const branch = board.row(c.id).branch!;
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'push', '--quiet', 'origin', branch);
    // Obeya starts anew with a configuration that no longer names the clone, its folder deleted by hand
    rebuild();
    rmSync(clone, { recursive: true, force: true });
    for (const l of spaces.keepOnly(null, [])) board.workspaceGone(l.card, l.path);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo' });
    expect(board.events(c.id).at(-1)!.text).toBe(board.t.worker.workspaceGone(clone, 'agent'));
    // the clones the configuration names now, made afresh
    for (const w of await spaces.ensureClones(origin, 2)) identify(w);
    const n = runtime.sessions.length;
    workers.message(c.id, 'Bitte auch als CSV.');
    const second = board.row(c.id).workspace!;
    expect(spaces.list().map((w) => w.path)).toContain(second);
    // what comes before git has the workspace ready goes with it
    workers.message(c.id, 'Und mit Kopfzeile.');
    await workers.prepared();
    const g = runtime.last;
    expect(runtime.sessions.length).toBe(n + 1);
    expect(g.spec.resume).toBe('sess-1');
    expect(g.spec.cwd).toBe(second);
    expect(git(second, 'branch', '--show-current')).toBe(branch);
    expect(git(second, 'rev-parse', 'HEAD')).toBe(head);
    for (const said of ['Your workspace is gone', 'Bitte auch als CSV.', 'Und mit Kopfzeile.']) expect(g.inbox.join('\n')).toContain(said);
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', answering: true });
    expect(unread(c.id)).toEqual([]);
    // its reply ends the taking in, the handover still waiting for approval
    g.emit({ type: 'text', text: 'Mache ich.' });
    g.emit({ type: 'idle' });
    expect(board.item(c.id)!.answering).toBeUndefined();
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', answered: true });
  });
});

describe('a card waiting for the owner whose branch is nowhere any more', () => {
  eachTest();

  test('says so in its conversation, the note waiting for a later try, and nothing on the card says an agent works', async () => {
    const c = manual();
    board.work(c.id, { state: 'waiting', need: 'demo', branch: 'obeya/zaehlerstaende', detail: JSON.stringify({ summary: 'S' }) as never });
    const n = runtime.sessions.length;
    workers.message(c.id, 'Bitte auch als CSV.');
    await workers.prepared();
    expect(runtime.sessions.length).toBe(n);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.events(c.id).some((e) => e.kind === 'error' && e.text.includes('obeya/zaehlerstaende'))).toBe(true);
    expect(board.item(c.id)!.answering).toBeUndefined();
    expect((fromJson(board.row(c.id).unheard) ?? []).map((u) => u.text).join('\n')).toContain('Bitte auch als CSV.');
  });
});
