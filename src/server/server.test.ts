import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardAction, ClientMessage, ServerMessage } from '../core/types';
import type { Board } from './board';
import { CanvasRuntime } from './canvas';
import type { Command } from './commands';
import { Store } from './db';
import { Restarter } from './self-update';
import { serve } from './server';
import { FakeRuntime, gitRepo, noForge } from './testing';
import type { Transcript } from './voice';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let executed: Command[];
let heardAudio: string[];
/** What the fake Whisper writes, given the vocabulary it was prompted with. */
let whisper: (vocabulary: string) => string | Transcript;
let server: ReturnType<typeof serve>;
let canvas: CanvasRuntime;
let warmed: number;
const speaker = { speak: async (text: string) => new TextEncoder().encode(`WAV ${text}`) };
// how long a command waits for an undo; long enough that a loaded machine still undoes in time
const DELAY_MS = 200;

// A canvas in clone mode without any clone registered: every start fails for want of a workspace.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-server-'));
  const main = join(dir, 'main');
  gitRepo(main);
  runtime = new FakeRuntime();
  // the generic adapter: clones, none registered; the canvas is named after the directory
  canvas = new CanvasRuntime({ repos: [{ path: main }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge, commandDelayMs: DELAY_MS });
  board = canvas.board;
  executed = [];
  heardAudio = [];
  whisper = () => 'Neue Karte Export';
  canvas.run = (c) => void executed.push(c);
  warmed = 0;
  const transcriber = {
    transcribe: async (path: string, vocabulary: string) => {
      heardAudio.push(await Bun.file(path).text());
      const heard = whisper(vocabulary);
      return typeof heard === 'string' ? { text: heard, doubtful: false } : heard;
    },
    warm: () => void warmed++,
  };
  server = serve([canvas], { transcriber, speaker }, 0);
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Waits until `done` holds. A request reaches the server only after a round trip, which on a
 * loaded machine (other workers' test runs) takes longer than any fixed pause; a test that went
 * on too early failed and left its request open, and stopping the server reset it in the next test.
 */
const until = async (done: () => unknown, ms = 3000) => {
  for (const end = Date.now() + ms; !(await done()); await sleep(2)) if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${done}`);
};
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
    await until(() => board.events(c.id).at(-1)?.kind === 'error');
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
  /** The Koordinator's session once the command has reached it. */
  const briefed = async () => {
    await until(() => interpretation()?.inbox.length);
    return interpretation();
  };

  test('a recording is transcribed, read as one action, confirmed with speech, and runs after the delay', async () => {
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    expect(heardAudio).toEqual(['AUDIO']);
    expect(s.inbox[0]).toContain('"Neue Karte Export"');
    expect(s.spec).toMatchObject({ readOnly: true, effort: 'low' });
    s.call('act', { actions: [{ do: 'new_card', kind: 'feature', title: 'Export', body: 'CSV', start: true }], confirm: 'Neue Karte „Export“, der Agent fängt an.' });
    s.emit({ type: 'idle' });
    const body = (await (await res).json()) as { confirm: string; token: string; audio?: string };
    expect(body.confirm).toBe('Neue Karte „Export“, der Agent fängt an.');
    expect(body.token).toBeTruthy();
    expect((body as { undoMs?: number }).undoMs).toBe(DELAY_MS);
    expect(body.audio).toStartWith(api('/voice/speech/'));
    const speech = await fetch(new URL(body.audio!, server.url));
    expect(speech.headers.get('content-type')).toBe('audio/wav');
    expect(await speech.text()).toBe('WAV Neue Karte „Export“, der Agent fängt an.');
    expect(executed).toEqual([]);
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'newCard', kind: 'feature', title: 'Export', body: 'CSV', start: true }]);
  });

  test('a recording Whisper loops on is transcribed once more without the card titles', async () => {
    board.create({ kind: 'feature', title: 'Export für Vermieter', x: 0, y: 0 });
    const prompts: string[] = [];
    whisper = (vocabulary) => (prompts.push(vocabulary), vocabulary ? 'Fall '.repeat(40) : 'Starte Export');
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Export für Vermieter');
    expect(prompts[1]).toBe('');
    expect(heardAudio).toEqual(['AUDIO', 'AUDIO']);
    expect(s.inbox[0]).toContain('"Starte Export"');
    expect(s.inbox[0]).not.toContain('Fall Fall');
    s.call('act', { actions: [], confirm: 'Ok.' });
    s.emit({ type: 'idle' });
    await res;
  });

  test('a recording Whisper is unsure of is transcribed once more without the card titles', async () => {
    board.create({ kind: 'feature', title: 'Export für Vermieter', x: 0, y: 0 });
    const prompts: string[] = [];
    whisper = (vocabulary) => (prompts.push(vocabulary), vocabulary ? { text: 'www.pap.com', doubtful: true } : 'Starte Export');
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    expect(prompts).toEqual([expect.stringContaining('Export für Vermieter'), '']);
    expect(s.inbox[0]).toContain('"Starte Export"');
    expect(s.inbox[0]).not.toContain('pap');
    s.call('act', { actions: [], confirm: 'Ok.' });
    s.emit({ type: 'idle' });
    await res;
  });

  const unsure = (text: string): Transcript => ({ text, doubtful: true });
  for (const [what, first, again, confirm] of [
    ['loops on with and without the card titles is not understood', 'lächpt '.repeat(30), 'PLEASE PLEASE PLEASE PLEASE PLEASE PLEASE PLEASE', 'Das habe ich nicht verstanden.'],
    ['is unsure of with and without the card titles is not understood', unsure('www.pap.com'), unsure('Hm.'), 'Das habe ich nicht verstanden.'],
    ['is unsure of with the card titles and writes its words for silence on without them is nothing heard', unsure('!'), 'Vielen Dank.', 'Ich habe nichts gehört.'],
    ['writes its words for silence on without the card titles is nothing heard', 'lächpt '.repeat(30), 'Vielen Dank.', 'Ich habe nichts gehört.'],
    ['writes its words for silence on at once is nothing heard', 'Untertitelung des ZDF, 2020', 'Unused', 'Ich habe nichts gehört.'],
  ] as [string, string | Transcript, string | Transcript, string][]) {
    test(`a recording Whisper ${what}, and the Koordinator does not guess`, async () => {
      whisper = (vocabulary) => (vocabulary ? first : again);
      const body = (await (await fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' })).json()) as { confirm: string; token?: string; audio?: string };
      expect(body.confirm).toBe(confirm);
      expect(body.token).toBeUndefined();
      expect(await (await fetch(new URL(body.audio!, server.url))).text()).toBe(`WAV ${confirm}`);
      expect(runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act'))).toEqual([]);
    });
  }

  test('typed commands name cards by tag; undo takes one back before it runs', async () => {
    const c = card();
    board.work(c.id, { state: 'waiting', need: 'review' });
    const res = fetch(new URL(api(`/command?card=${c.id}`), server.url), { method: 'POST', body: JSON.stringify({ text: 'gib das frei' }) });
    const s = await briefed();
    expect(s.inbox[0]).toContain('The owner has this card open');
    s.call('act', { actions: [{ do: 'approve', card: 'K1' }], confirm: '„A“ freigegeben.' });
    s.emit({ type: 'idle' });
    const { token } = (await (await res).json()) as { token: string };
    const undo = await (await fetch(new URL(api('/command/undo'), server.url), { method: 'POST', body: JSON.stringify({ token }) })).json();
    expect(undo).toEqual({ undone: true });
    await sleep(DELAY_MS + 50);
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
    expect(await briefed()).toBe(k);
    expect(k.inbox[0]).toContain('"starte A"');
    k.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„A“ startet.' });
    await res;
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'start', card: c.id }]);
  });

  test('a session that fails is replaced by a fresh one for the same command', async () => {
    canvas.commander.warm();
    const k = interpretation();
    const heard = canvas.commander.hear('ähm', {});
    await until(() => k.inbox.length);
    k.emit({ type: 'error', message: 'stale' });
    expect(k.closed).toBe(true);
    await until(() => interpretation() !== k);
    const fresh = await briefed();
    expect(fresh.inbox[0]).toContain('"ähm"');
    fresh.call('reply', { confirm: 'Was genau soll ich tun?' });
    expect(await heard).toEqual({ confirm: 'Was genau soll ich tun?' });
  });

  test('nothing to do is just said', async () => {
    const res = fetch(new URL(api('/command'), server.url), { method: 'POST', body: JSON.stringify({ text: 'ähm' }) });
    (await briefed()).call('reply', { confirm: 'Was genau soll ich tun?' });
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

  test("a card keeps its task's screenshots; unknown ones are refused", async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    const res = await post(api('/cards'), JSON.stringify({ kind: 'bugfix', title: 'Seite bricht um', x: 0, y: 0, images: [id] }));
    const c = (await res.json()) as { id: string };
    expect(board.item(c.id)!.images).toEqual([id]);
    const patch = (p: unknown) => fetch(new URL(api(`/cards/${c.id}`), server.url), { method: 'PATCH', body: JSON.stringify(p) });
    expect((await patch({ images: [] })).status).toBe(204);
    expect(board.item(c.id)!.images).toBeUndefined();
    expect(await codeOf(patch({ images: ['0000.png'] }))).toBe('invalid');
    expect(await codeOf(post(api('/cards'), JSON.stringify({ kind: 'bugfix', title: 'x', x: 0, y: 0, images: 'a.png' })))).toBe('invalid');
  });

  test("a typed command's screenshots go to the Koordinator and to the cards it creates or concerns", async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    const c = card();
    board.work(c.id, { state: 'working', workspace: dir, session_id: 'sess-1' });
    const res = post(api('/command'), JSON.stringify({ text: 'Neue Karte: diese Seite bricht um, und sag A, dass es so aussieht', images: [id] }));
    const koordinator = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act')).at(-1);
    await until(() => koordinator()?.inbox.length);
    const k = koordinator()!;
    expect(k.images[0]).toEqual([canvas.images.path(id)!]);
    expect(k.inbox[0]).toContain('The owner attached a screenshot');
    k.call('act', {
      actions: [
        { do: 'new_card', kind: 'bugfix', title: 'Seite bricht um', body: 'diese Seite bricht um' },
        { do: 'note', card: 'K1', text: 'So sieht es aus.' },
        { do: 'stop', card: 'K1' },
      ],
      confirm: 'Neue Karte „Seite bricht um“; an „A“ weitergegeben.',
    });
    await res;
    await until(() => executed.length === 3, DELAY_MS + 3000);
    expect(executed).toEqual([
      { do: 'newCard', kind: 'bugfix', title: 'Seite bricht um', body: 'diese Seite bricht um', start: false, images: [id] },
      { do: 'note', card: c.id, text: 'So sieht es aus.', images: [id] },
      { do: 'stop', card: c.id },
    ]);
    expect(board.snapshot().talk.at(-1)).toMatchObject({ said: 'Neue Karte: diese Seite bricht um, und sag A, dass es so aussieht', images: [id] });
    expect(await codeOf(post(api('/command'), JSON.stringify({ text: 'x', images: ['0000.png'] })))).toBe('invalid');
  });

  test("a recording's screenshots go to the Koordinator and its actions; nothing heard leaves them unused", async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    const voice = (q = '') => fetch(new URL(api(`/voice${q}`), server.url), { method: 'POST', body: 'AUDIO' });
    expect(await codeOf(voice('?image=0000.png'))).toBe('invalid');
    expect(heardAudio).toEqual([]);
    const res = voice(`?image=${id}`);
    const koordinator = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act')).at(-1);
    await until(() => koordinator()?.inbox.length);
    const k = koordinator()!;
    expect(k.images[0]).toEqual([canvas.images.path(id)!]);
    k.call('act', { actions: [{ do: 'new_card', kind: 'bugfix', title: 'Export', body: 'bricht um' }], confirm: 'Neue Karte „Export“.' });
    expect(await (await res).json()).not.toHaveProperty('unheard');
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'newCard', kind: 'bugfix', title: 'Export', body: 'bricht um', start: false, images: [id] }]);
    expect(board.snapshot().talk.at(-1)).toMatchObject({ said: 'Neue Karte Export', images: [id] });

    whisper = () => '';
    expect(await (await voice(`?image=${id}`)).json()).toMatchObject({ confirm: 'Ich habe nichts gehört.', unheard: true });
  });

  test('a new card from a command keeps its screenshots; one said with a start goes to the task', async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    const run = CanvasRuntime.prototype.run.bind(canvas);
    run({ do: 'newCard', kind: 'bugfix', title: 'Seite bricht um', body: '', start: false, images: [id] });
    const made = board.snapshot().items.find((i) => i.title === 'Seite bricht um')!;
    expect(made.images).toEqual([id]);
    const c = card();
    run({ do: 'start', card: c.id, images: [id] });
    expect(board.item(c.id)!.images).toEqual([id]);
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

describe('„Merk dir“', () => {
  test('adds a rule, changes the one it replaces, and adds it anew when that one is gone', () => {
    const run = CanvasRuntime.prototype.run.bind(canvas);
    const c = card();
    run({ do: 'remember', text: 'Demos ohne Ton.', card: c.id });
    const [rule] = board.preferences('active');
    expect(rule).toMatchObject({ text: 'Demos ohne Ton.', cardId: c.id, state: 'active' });
    expect(board.preferencesText()).toContain('- Demos ohne Ton.');
    run({ do: 'remember', text: 'Demos mit Ton.', replaces: rule!.id });
    expect(board.preferences('active').map((p) => p.text)).toEqual(['Demos mit Ton.']);
    board.setPreference(rule!.id, null);
    run({ do: 'remember', text: 'Demos leise.', replaces: rule!.id });
    expect(board.preferences('active').map((p) => p.text)).toEqual(['Demos leise.']);
  });
});

describe('a restart that waits', () => {
  test('shows on the canvas with the cards it waits for, and goes ahead at the owner\'s word', async () => {
    let busy = [
      { canvas: 'main', card: 'k1' },
      { canvas: 'other', card: 'k2' },
    ];
    let gone = 0;
    const restarter = new Restarter({ busy: () => busy, go: () => gone++, patienceMs: 60_000, intervalMs: 10 });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) }, speaker }, 0, false, undefined, restarter);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const restarts = () => messages.filter((m): m is Extract<ServerMessage, { type: 'restart' }> => m.type === 'restart');
    await until(() => restarts().length === 1);
    expect(restarts()[0]!.restart).toBeNull();
    // nothing waits: the owner's word changes nothing
    expect(await (await post('/api/restart', '')).json()).toEqual({ restarting: false });

    restarter.request('code');
    await until(() => restarts().length === 2);
    expect(restarts()[1]!.restart).toMatchObject({ reason: 'code', cards: ['k1'], elsewhere: 1 });
    busy = [busy[0]!];
    await until(() => restarts().length === 3);
    expect(restarts()[2]!.restart).toMatchObject({ cards: ['k1'], elsewhere: 0 });

    expect(await (await post('/api/restart', '')).json()).toEqual({ restarting: true });
    await until(() => gone === 1);
    ws.close();
  });

  test('waits while the owner watches a video or dictates in an open page, and goes once that page lets go or closes', async () => {
    let gone = 0;
    const restarter = new Restarter({ busy: () => [], go: () => gone++, patienceMs: 0, intervalMs: 10 });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) }, speaker }, 0, false, undefined, restarter);
    const messages: ServerMessage[] = [];
    const connect = async () => {
      const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
      ws.onmessage = (e) => messages.push(JSON.parse(e.data));
      await until(() => ws.readyState === WebSocket.OPEN);
      return ws;
    };
    const watching = await connect();
    const dictating = await connect();
    const hold = (ws: WebSocket, hold: ClientMessage['hold']) => ws.send(JSON.stringify({ type: 'hold', hold } satisfies ClientMessage));
    const last = () => messages.filter((m): m is Extract<ServerMessage, { type: 'restart' }> => m.type === 'restart').at(-1)!.restart;
    hold(watching, ['video']);
    hold(dictating, ['voice']);
    await until(() => restarter['holds'].size === 2);

    // no worker is busy and the patience is out: only the owner holds it off
    restarter.request('code');
    await until(() => last()?.owner.length === 2);
    expect(last()).toMatchObject({ cards: [], elsewhere: 0, owner: ['video', 'voice'] });
    hold(watching, []);
    await until(() => last()?.owner.length === 1);
    expect(last()!.owner).toEqual(['voice']);
    await Bun.sleep(50);
    expect(gone).toBe(0);
    dictating.close();
    await until(() => gone === 1);
    watching.close();
  });
});

describe('cards that need the owner', () => {
  test('are counted per canvas on every canvas, so the switcher points to the others', async () => {
    const other = join(dir, 'other');
    gitRepo(other);
    const second = new CanvasRuntime({ repos: [{ path: other }] }, { store: new Store(':memory:'), home: join(dir, 'home2'), runtime, forge: noForge });
    const waiting = second.board.create({ kind: 'feature', title: 'B', x: 0, y: 0 });
    second.board.work(waiting.id, { state: 'waiting', need: 'review' });
    server.stop(true);
    server = serve([canvas, second], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) }, speaker }, 0);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const counts = () => messages.flatMap((m) => (m.type === 'waiting' ? [m.waiting] : []));
    await until(() => counts().length === 1);
    expect(counts()[0]).toEqual({ main: 0, other: 1 });

    // a change on the other canvas reaches this one; one that leaves the counts alone does not
    second.board.patch(waiting.id, { title: 'B2' });
    const c = second.board.create({ kind: 'feature', title: 'C', x: 0, y: 0 });
    second.board.work(c.id, { state: 'waiting', need: 'review' });
    await until(() => counts().length === 2);
    expect(counts()[1]).toEqual({ main: 0, other: 2 });
    second.board.work(waiting.id, { state: 'working' });
    await until(() => counts().length === 3);
    expect(counts()[2]).toEqual({ main: 0, other: 1 });
    ws.close();
  });
});
