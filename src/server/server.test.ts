import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardAction } from '../core/types';
import type { Board } from './board';
import { CanvasRuntime } from './canvas';
import type { Command } from './commands';
import { Store } from './db';
import { serve } from './server';
import { FakeRuntime } from './testing';
import { git } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let executed: Command[];
let heardAudio: string[];
let server: ReturnType<typeof serve>;
let canvas: CanvasRuntime;
let warmed: number;
const speaker = { speak: async (text: string) => new TextEncoder().encode(`WAV ${text}`) };

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
  runtime = new FakeRuntime();
  // the generic adapter: clones, none registered; the canvas is named after the directory
  canvas = new CanvasRuntime({ repos: [{ path: main }] }, { store: new Store(':memory:'), home: dir, runtime, forge: { status: () => { throw new Error('no forge'); } }, commandDelayMs: 30 });
  board = canvas.board;
  executed = [];
  heardAudio = [];
  canvas.run = (c) => void executed.push(c);
  warmed = 0;
  const transcriber = { transcribe: async (path: string) => (heardAudio.push(await Bun.file(path).text()), 'Neue Karte Export'), warm: () => void warmed++ };
  server = serve([canvas], { transcriber, speaker }, 0);
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 5));
const card = () => board.create({ kind: 'feature', title: 'A', x: 0, y: 0 });
const post = (path: string, body: string) => fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const codeOf = async (res: Promise<Response>) => ((await (await res).json()) as { code: string }).code;
const api = (path: string) => `/api/c/main${path}`;
const act = (id: string, a: CardAction | { action: string; text?: unknown }) => post(api(`/cards/${id}/act`), JSON.stringify(a));

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
    expect(await codeOf(post(api(`/cards/${c.id}/act`), '{'))).toBe('invalid');
    expect(await codeOf(post(api('/cards'), JSON.stringify({ kind: 'project', title: 'x', x: 0, y: 0 })))).toBe('invalid');
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
    const events = (await (await fetch(new URL(api(`/cards/${c.id}/events`), server.url))).json()) as { kind: string; code?: string; text: string }[];
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'noWorkspace', text: 'no workspace registered or all are leased' });
    expect(board.item(c.id)!.state).toBe('planned');
  });
});

describe('archive', () => {
  test('a finished card goes into the archive and back', async () => {
    const c = card();
    expect(await codeOf(post(api(`/cards/${c.id}/archive`), ''))).toBe('notDone');
    board.patch(c.id, { state: 'live' });
    expect((await post(api(`/cards/${c.id}/archive`), '')).status).toBe(204);
    const archive = (await (await fetch(new URL(api('/archive'), server.url))).json()) as { id: string; archivedAt: string }[];
    expect(archive.map((i) => i.id)).toEqual([c.id]);
    expect(board.item(c.id)).toBeUndefined();
    expect((await post(api(`/cards/${c.id}/unarchive`), '')).status).toBe(204);
    expect(board.item(c.id)!.state).toBe('live');
    expect(await (await post(api('/archive'), '')).json()).toEqual({ ids: [c.id] });
  });
});

describe('voice', () => {
  const interpretation = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'new_card')).at(-1)!;

  test('a recording is transcribed, read as one action, confirmed with speech, and runs after the delay', async () => {
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    await settle();
    expect(heardAudio).toEqual(['AUDIO']);
    const s = interpretation();
    expect(s.inbox[0]).toContain('"Neue Karte Export"');
    expect(s.spec).toMatchObject({ readOnly: true, effort: 'low' });
    s.call('new_card', { kind: 'feature', title: 'Export', body: 'CSV', start: true, confirm: 'Neue Karte „Export“, der Agent fängt an.' });
    s.emit({ type: 'idle' });
    const body = (await (await res).json()) as { confirm: string; token: string; audio?: string };
    expect(body.confirm).toBe('Neue Karte „Export“, der Agent fängt an.');
    expect(body.token).toBeTruthy();
    expect((body as { undoMs?: number }).undoMs).toBe(30);
    expect(body.audio).toStartWith(api('/voice/speech/'));
    const speech = await fetch(new URL(body.audio!, server.url));
    expect(speech.headers.get('content-type')).toBe('audio/wav');
    expect(await speech.text()).toBe('WAV Neue Karte „Export“, der Agent fängt an.');
    expect(executed).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual([{ do: 'newCard', kind: 'feature', title: 'Export', body: 'CSV', start: true }]);
  });

  test('typed commands name cards by tag; undo takes one back before it runs', async () => {
    const c = card();
    const res = fetch(new URL(api(`/command?card=${c.id}`), server.url), { method: 'POST', body: JSON.stringify({ text: 'gib das frei' }) });
    await settle();
    const s = interpretation();
    expect(s.inbox[0]).toContain('The owner has this card open');
    s.call('approve', { card: 'K1', confirm: '„A“ freigegeben.' });
    s.emit({ type: 'idle' });
    const { token } = (await (await res).json()) as { token: string };
    const undo = await (await fetch(new URL(api('/command/undo'), server.url), { method: 'POST', body: JSON.stringify({ token }) })).json();
    expect(undo).toEqual({ undone: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual([]);
  });

  test('pressing Space starts the agent for the command ahead; the command then only sends it the brief', async () => {
    const c = card();
    expect((await post(api('/voice/warm'), '')).status).toBe(204);
    await post(api('/voice/warm'), '');
    expect(warmed).toBe(2);
    const spare = interpretation();
    expect(runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'new_card'))).toHaveLength(1);
    expect(spare.inbox).toEqual([]);
    const res = fetch(new URL(api('/command'), server.url), { method: 'POST', body: JSON.stringify({ text: 'starte A' }) });
    await settle();
    expect(interpretation()).toBe(spare);
    expect(spare.inbox[0]).toContain('"starte A"');
    spare.call('start', { card: 'K1', confirm: '„A“ startet.' });
    await res;
    // the next command's agent is already starting
    expect(interpretation()).not.toBe(spare);
    expect(interpretation().inbox).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual([{ do: 'start', card: c.id }]);
  });

  test('an agent that waited and then fails is replaced by a fresh one for the same command', async () => {
    canvas.commander.warm();
    const spare = interpretation();
    const heard = canvas.commander.hear('ähm', {});
    spare.emit({ type: 'error', message: 'stale' });
    expect(spare.closed).toBe(true);
    const fresh = interpretation();
    expect(fresh).not.toBe(spare);
    expect(fresh.inbox[0]).toContain('"ähm"');
    fresh.call('reply', { confirm: 'Was genau soll ich tun?' });
    expect(await heard).toEqual({ confirm: 'Was genau soll ich tun?' });
  });

  test('nothing to do is just said', async () => {
    const res = fetch(new URL(api('/command'), server.url), { method: 'POST', body: JSON.stringify({ text: 'ähm' }) });
    await settle();
    interpretation().call('reply', { confirm: 'Was genau soll ich tun?' });
    interpretation().emit({ type: 'idle' });
    const body = (await (await res).json()) as { confirm: string; token?: string };
    expect(body).toMatchObject({ confirm: 'Was genau soll ich tun?' });
    expect(body.token).toBeUndefined();
  });
});
