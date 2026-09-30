import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { CardAction } from '../core/types';
import { Board } from './board';
import { Store } from './db';
import { Koordinator } from './koordinator';
import { serve } from './server';
import { FakeRuntime, type FakeSession } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let server: ReturnType<typeof serve>;

// A canvas in clone mode without any clone registered: every start fails for want of a workspace.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-server-'));
  const main = join(dir, 'main');
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', main]);
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repoPath: main, branch: 'main' }, () => []);
  const adapter = { ...generic, workspaces: 'clones' as const };
  const workspaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir: join(dir, 'ws') });
  runtime = new FakeRuntime();
  const workers = new Workers({ board, runtime, workspaces, adapter });
  const koordinator = new Koordinator({ board, runtime, workers, workspaces, adapter, repoPath: main });
  server = serve(board, workers, koordinator, 0);
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 5));
const card = () => board.create({ kind: 'feature', title: 'A', x: 0, y: 0 });
const post = (path: string, body: string) => fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const codeOf = async (res: Promise<Response>) => ((await (await res).json()) as { code: string }).code;
const act = (id: string, a: CardAction | { action: string; text?: unknown }) => post(`/api/cards/${id}/act`, JSON.stringify(a));

describe('refused requests', () => {
  test('carry a stable code and an English detail', async () => {
    const res = await act(card().id, { action: 'stop' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'noAgent', error: 'no agent works on this card' });
  });

  test('each refusal the owner can meet has its code', async () => {
    const c = card();
    expect(await codeOf(act(c.id, { action: 'answer', text: 'x' }))).toBe('noQuestion');
    expect(await codeOf(act(c.id, { action: 'answer', text: '  ' }))).toBe('emptyText');
    expect(await codeOf(act(c.id, { action: 'approve' }))).toBe('notReady');
    expect(await codeOf(act(c.id, { action: 'force' }))).toBe('notQueued');
    expect(await codeOf(act(c.id, { action: 'dismiss' }))).toBe('notProposal');
    expect(await codeOf(act('nope', { action: 'start' }))).toBe('unknownCard');
    expect(await codeOf(act(c.id, { action: 'fly' }))).toBe('invalid');
    expect(await codeOf(post(`/api/cards/${c.id}/act`, '{'))).toBe('invalid');
    expect(await codeOf(post('/api/cards', JSON.stringify({ kind: 'project', title: 'x', x: 0, y: 0 })))).toBe('invalid');
  });

  test('a card already with the Koordinator cannot be started again', async () => {
    const c = card();
    board.work(c.id, { queue: JSON.stringify({ checking: true }) });
    expect(await codeOf(act(c.id, { action: 'start' }))).toBe('queued');
  });

  test('a start that fails without a free workspace is logged with its code', async () => {
    const c = card();
    expect((await act(c.id, { action: 'start' })).status).toBe(204);
    await settle();
    const events = (await (await fetch(new URL(`/api/cards/${c.id}/events`, server.url))).json()) as { kind: string; code?: string; text: string }[];
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'noWorkspace', text: 'no workspace registered or all are leased' });
    expect(board.item(c.id)!.state).toBe('planned');
  });
});
