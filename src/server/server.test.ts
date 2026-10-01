import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('plan docs', () => {
  test("a project's plan doc is read as written; other cards have none", async () => {
    const md = '# Export\n\n## Goal\n\nCSV for landlords.\n\n## Workstreams\n\n- [ ] **W1:** CSV. Columns as in `docs/x.md`.\n\n## Notes\n\nMore.\n';
    mkdirSync(join(dir, 'main', 'docs', 'plan'), { recursive: true });
    writeFileSync(join(dir, 'main', 'docs', 'plan', 'export.md'), md);
    board.docsChanged();
    const project = board.snapshot().items.find((i) => i.kind === 'project')!;
    const get = (id: string) => fetch(new URL(api(`/cards/${id}/plan`), server.url));
    expect(await (await get(project.id)).json()).toEqual({ file: 'docs/plan/export.md', markdown: md });
    expect(await codeOf(get(card().id))).toBe('invalid');
    expect(await codeOf(get('nope'))).toBe('unknownCard');
  });
});

describe('voice', () => {
  const interpretation = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act')).at(-1)!;

  test('a recording is transcribed, read as one action, confirmed with speech, and runs after the delay', async () => {
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    await settle();
    expect(heardAudio).toEqual(['AUDIO']);
    const s = interpretation();
    expect(s.inbox[0]).toContain('"Neue Karte Export"');
    expect(s.spec).toMatchObject({ readOnly: true, effort: 'low' });
    s.call('act', { actions: [{ do: 'new_card', kind: 'feature', title: 'Export', body: 'CSV', start: true }], confirm: 'Neue Karte „Export“, der Agent fängt an.' });
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
    board.work(c.id, { state: 'waiting', need: 'review' });
    const res = fetch(new URL(api(`/command?card=${c.id}`), server.url), { method: 'POST', body: JSON.stringify({ text: 'gib das frei' }) });
    await settle();
    const s = interpretation();
    expect(s.inbox[0]).toContain('The owner has this card open');
    s.call('act', { actions: [{ do: 'approve', card: 'K1' }], confirm: '„A“ freigegeben.' });
    s.emit({ type: 'idle' });
    const { token } = (await (await res).json()) as { token: string };
    const undo = await (await fetch(new URL(api('/command/undo'), server.url), { method: 'POST', body: JSON.stringify({ token }) })).json();
    expect(undo).toEqual({ undone: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual([]);
  });

  test('pressing Space starts the Koordinator ahead; commands then only send it the brief', async () => {
    const c = card();
    expect((await post(api('/voice/warm'), '')).status).toBe(204);
    await post(api('/voice/warm'), '');
    expect(warmed).toBe(2);
    const k = interpretation();
    expect(runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act'))).toHaveLength(1);
    expect(k.inbox).toEqual([]);
    const res = fetch(new URL(api('/command'), server.url), { method: 'POST', body: JSON.stringify({ text: 'starte A' }) });
    await settle();
    expect(interpretation()).toBe(k);
    expect(k.inbox[0]).toContain('"starte A"');
    k.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„A“ startet.' });
    await res;
    await new Promise((r) => setTimeout(r, 60));
    expect(executed).toEqual([{ do: 'start', card: c.id }]);
  });

  test('a session that fails is replaced by a fresh one for the same command', async () => {
    canvas.commander.warm();
    const k = interpretation();
    const heard = canvas.commander.hear('ähm', {});
    await settle();
    k.emit({ type: 'error', message: 'stale' });
    expect(k.closed).toBe(true);
    await settle();
    const fresh = interpretation();
    expect(fresh).not.toBe(k);
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

describe('screenshots', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const upload = (body: Uint8Array<ArrayBuffer>, type = 'image/png') =>
    fetch(new URL(api('/images'), server.url), { method: 'POST', headers: { 'content-type': type }, body });
  const working = () => {
    const c = card();
    board.work(c.id, { state: 'working', workspace: dir, session_id: 'sess-1' });
    return c;
  };

  test('are uploaded, served, and reach the worker with the note and in the log', async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}\.png$/);
    const served = await fetch(new URL(api(`/images/${id}`), server.url));
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);

    const c = working();
    expect((await act(c.id, { action: 'message', text: 'Der Knopf hier ist zu klein', images: [id] })).status).toBe(204);
    const s = runtime.sessions.find((x) => x.spec.tools.some((t) => t.name === 'ready_for_review'))!;
    expect(s.inbox[0]).toContain('Der Knopf hier ist zu klein');
    expect(s.inbox[0]).toContain('attached a screenshot');
    expect(s.images[0]).toEqual([canvas.images.path(id)!]);
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'hint', author: 'owner', text: 'Der Knopf hier ist zu klein', images: [id] });
  });

  test('may stand without text; unknown ones, other files and too large ones are refused', async () => {
    const { id } = (await (await upload(png, 'image/jpeg')).json()) as { id: string };
    expect(id).toEndWith('.jpg');
    const c = working();
    expect((await act(c.id, { action: 'message', text: '', images: [id] })).status).toBe(204);
    expect(await codeOf(act(c.id, { action: 'message', text: '' }))).toBe('emptyText');
    expect(await codeOf(act(c.id, { action: 'message', text: 'x', images: ['0000.png'] } as CardAction))).toBe('invalid');
    expect(await codeOf(upload(png, 'text/html'))).toBe('imageType');
    expect(await codeOf(upload(new Uint8Array(4_000_000)))).toBe('imageTooLarge');
    expect((await fetch(new URL(api('/images/..%2Fobeya.db'), server.url))).status).toBe(404);
  });
});
