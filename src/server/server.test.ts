import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CardAction, ClientMessage, ServerMessage } from '../core/types';
import type { Board } from './board';
import { Canvases, CanvasRuntime } from './canvas';
import type { Command } from './commands';
import { Store } from './db';
import { AppUpdates } from './app-update';
import { Restarter } from './self-update';
import { SourceUpdates } from './source-update';
import { UsageMeter } from './usage';
import type { NarrationHost } from './narration';
import { Stalls } from './stalls';
import { serve, serveNarration } from './server';
import { artifact, asOwner, FakeRuntime, gitRepo, identify, noForge, until } from './testing';
import { git, RECHECK_MS } from './workspaces';
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
// how long a command waits for an undo; long enough that a loaded machine still undoes in time
const DELAY_MS = 200;

// A canvas in clone mode without any clone registered: every start fails for want of a workspace.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-server-'));
  const main = join(dir, 'main');
  // settings of its own that work in clones, none registered; the canvas is named after the directory
  gitRepo(main, { 'README.md': 'hi\n', '.obeya/settings.json': '{ "workspaces": "clones" }\n' });
  runtime = new FakeRuntime();
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
  server = serve([canvas], { transcriber }, 0);
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  setSystemTime();
});

// what the page, the app's shell and scripts send: the owner's key (owner.ts)
const { fetch, WebSocket } = asOwner(() => server);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = () => board.create({ title: 'A', x: 0, y: 0 });
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
    // an option picked is an answer without words
    expect(await codeOf(act(c.id, { action: 'answer', text: '', picks: ['Ja'] }))).toBe('noQuestion');
    expect(await codeOf(act(c.id, { action: 'approve' }))).toBe('notReady');
    expect(await codeOf(act(c.id, { action: 'force' }))).toBe('notQueued');
    expect(await codeOf(act(c.id, { action: 'dismiss' }))).toBe('notProposal');
    expect(await codeOf(act('nope', { action: 'start' }))).toBe('unknownCard');
    expect(await codeOf(act(c.id, { action: 'fly' }))).toBe('invalid');
    expect(await codeOf(post(api(`/cards/${c.id}/act`), '{'))).toBe('invalid');
    expect(await codeOf(post(api('/cards'), JSON.stringify({ title: 'x', x: 'links', y: 0 })))).toBe('invalid');
  });

  test('a card already with the Koordinator cannot be started again', async () => {
    const c = card();
    board.work(c.id, { queue: JSON.stringify({ checking: true }) });
    expect(await codeOf(act(c.id, { action: 'start' }))).toBe('queued');
  });

  test('a start without a free workspace waits for one', async () => {
    const c = card();
    expect((await act(c.id, { action: 'start' })).status).toBe(204);
    await until(() => board.item(c.id)!.queue && 'workspace' in board.item(c.id)!.queue!);
    expect(board.item(c.id)).toMatchObject({ state: 'planned', queue: { workspace: 'none' } });
    expect(board.events(c.id).some((e) => e.kind === 'error')).toBe(false);
  });
});

describe('who may', () => {
  const at = (path: string, headers: Record<string, string>, init: RequestInit = {}) => fetch(new URL(path, server.url), { ...init, headers });
  // what any web page may send without a preflight
  const newCard = (headers: Record<string, string>) =>
    at(api('/cards'), { 'content-type': 'text/plain', ...headers }, { method: 'POST', body: JSON.stringify({ title: 'Fremd', x: 0, y: 0 }) });
  const own = () => server.url.origin;
  const opens = (headers: Record<string, string>) =>
    new Promise<boolean>((done) => {
      const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')), { headers } as unknown as string[]);
      ws.onopen = () => (ws.close(), done(true));
      ws.onerror = () => done(false);
    });

  test("another site's page in the owner's browser creates no card, nor does a DNS name rebound to this machine", async () => {
    expect((await newCard({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await newCard({ host: 'rebound.evil.example', origin: 'http://rebound.evil.example', 'sec-fetch-site': 'same-origin' })).status).toBe(421);
    expect((await newCard({ host: `rebound.evil.example:${server.port}` })).status).toBe(421);
    // a foreign origin without Sec-Fetch-Site (an older browser), and one of another port on this machine
    expect((await newCard({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await newCard({ origin: `http://127.0.0.1:${server.port! + 1}` })).status).toBe(403);
    expect((await newCard({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(board.snapshot().items).toEqual([]);
  });

  test("Obeya's own page, the app's shell and scripts are answered, under each name of this machine", async () => {
    expect((await newCard({ origin: own(), 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await newCard({ host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` })).status).toBe(200);
    expect((await newCard({ host: `[::1]:${server.port}` })).status).toBe(200);
    // a worker on another machine, through a forwarded port of its own
    expect((await newCard({ host: '127.0.0.1:41234' })).status).toBe(200);
    // the app quitting: no Origin, no Sec-Fetch-Site
    expect(await (await at('/api/stop', {}, { method: 'POST' })).json()).toEqual({ stopping: false });
    expect((await at('/api/stop', { origin: 'https://evil.example' }, { method: 'POST' })).status).toBe(403);
    expect(board.snapshot().items.length).toBe(4);
  });

  test('the page and its WebSocket only for Obeya itself', async () => {
    const page = await at('/', { 'sec-fetch-site': 'none' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<html');
    expect((await at('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' })).status).toBe(403);
    // a link on another site opens the page in the window, but not the API
    const link = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect((await at('/', link)).status).toBe(200);
    expect((await at(api('/cards'), link)).status).toBe(403);
    expect((await at('/', link, { method: 'POST' })).status).toBe(403);
    expect((await at('/', { host: 'rebound.evil.example' })).status).toBe(421);
    expect((await at('/nothing', { host: 'rebound.evil.example' })).status).toBe(421);
    expect(await opens({ origin: own() })).toBe(true);
    expect(await opens({ origin: 'https://evil.example' })).toBe(false);
    expect(await opens({ host: 'rebound.evil.example', origin: 'http://rebound.evil.example' })).toBe(false);
  });

  test("a worker's HTML artifact loads its own files in its sandboxed frame", async () => {
    const c = card();
    const demo = artifact();
    writeFileSync(join(demo.dir, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    board.work(c.id, { state: 'waiting', need: 'review', demo: JSON.stringify(demo) });
    // the frame itself, from the canvas, with the owner's cookie: to the path with its directory's cap
    const frame = await at(api(`/cards/${c.id}/demo/index.html`), { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }, { redirect: 'manual' });
    expect(frame.status).toBe(302);
    const capped = frame.headers.get('location')!;
    expect(capped).toMatch(new RegExp(`^${api(`/cards/${c.id}/demo/~`)}[0-9a-f]{32}/index\\.html$`));
    // what the page in it loads: from an origin of its own, without the cookie, beside it under the cap
    const frameless = (path: string, headers: Record<string, string> = {}) => globalThis.fetch(new URL(path, server.url), { headers: { origin: 'null', 'sec-fetch-site': 'cross-site', ...headers } });
    expect((await frameless(capped)).status).toBe(200);
    expect(await (await frameless(capped.replace('index.html', 'chart.svg'))).text()).toContain('<svg');
    // nothing without the cap, nor with another card's
    expect((await frameless(api(`/cards/${c.id}/demo/chart.svg`))).status).toBe(401);
    expect((await frameless(capped.replace(c.id, card().id))).status).toBe(401);
    expect((await frameless(capped.replace('index.html', 'chart.svg'), { host: 'rebound.evil.example' })).status).toBe(421);
    rmSync(demo.dir, { recursive: true, force: true });
  });

  test('a demo a later handover replaced is served beside the latest, each from its own directory', async () => {
    const c = card();
    const [earlier, latest] = [artifact(), artifact()];
    writeFileSync(join(earlier.dir, 'index.html'), '<p>Vorher</p>');
    board.work(c.id, { state: 'waiting', need: 'review', demo: JSON.stringify(latest), demos: JSON.stringify([earlier]) });
    const page = async (path: string) => {
      const first = await at(api(path), { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }, { redirect: 'manual' });
      return first.status === 302 ? at(first.headers.get('location')!, { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }) : first;
    };
    expect(await (await page(`/cards/${c.id}/demos/0/index.html`)).text()).toStartWith('<p>Vorher</p>');
    expect(await (await page(`/cards/${c.id}/demo/index.html`)).text()).toStartWith('<p>Ergebnis</p>');
    expect((await at(api(`/cards/${c.id}/demos/1/index.html`), {})).status).toBe(404);
    for (const d of [earlier, latest]) rmSync(d.dir, { recursive: true, force: true });
  });

  test("a new handover's artifact rendered into the same directory loads afresh at the address with its handover", async () => {
    const c = card();
    const demo = artifact();
    board.work(c.id, { state: 'waiting', need: 'review', demo: JSON.stringify({ ...demo, handover: 1 }) });
    const page = async (path: string) => {
      const first = await at(api(path), { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }, { redirect: 'manual' });
      expect(first.status).toBe(302);
      const capped = first.headers.get('location')!;
      // the handover stays in the address the frame ends up at
      expect(capped).toEndWith(new URL(path, 'http://x').search);
      const res = await at(capped, { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' });
      expect(res.headers.get('cache-control')).toBe('no-cache');
      return res.text();
    };
    expect(await page(`/cards/${c.id}/demo/index.html?v=1`)).toStartWith('<p>Ergebnis</p>');
    writeFileSync(join(demo.dir, 'index.html'), '<p>Neu</p>');
    board.work(c.id, { demo: JSON.stringify({ ...demo, handover: 2 }) });
    expect(await page(`/cards/${c.id}/demo/index.html?v=2`)).toStartWith('<p>Neu</p>');
    rmSync(demo.dir, { recursive: true, force: true });
  });
});

describe('only the owner', () => {
  // another program or account on this machine: neither the key nor the cookie
  const bare = (path: string, init: RequestInit = {}) => globalThis.fetch(new URL(path, server.url), { redirect: 'manual', ...init });
  const opens = (headers: Record<string, string>) =>
    new Promise<boolean>((done) => {
      const ws = new globalThis.WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')), { headers } as unknown as string[]);
      ws.onopen = () => (ws.close(), done(true));
      ws.onerror = () => done(false);
    });
  /** Where a signed-in page goes on to: from a page of its own, not a redirect (owner.ts). */
  const onward = async (res: Response) => (await res.text()).match(/location\.replace\("([^"]*)"\)/)?.[1];
  const link = async (next?: string, once = false) => ((await (await post('/api/login-link', JSON.stringify({ ...(next ? { next } : {}), ...(once ? { once } : {}) }))).json()) as { url: string }).url;

  test('nothing without the key: not the API, not the page, not the WebSocket', async () => {
    const res = await bare(api('/cards'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Fremd', x: 0, y: 0 }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('notOwner');
    expect((await bare('/api/demo-settings/sample', { method: 'POST', body: JSON.stringify({ voice: 'command', command: 'touch /tmp/x' }) })).status).toBe(401);
    expect((await bare('/api/stop', { method: 'POST' })).status).toBe(401);
    expect((await bare('/api/login-link', { method: 'POST' })).status).toBe(401);
    expect((await bare('/api/c/main/cards/x/act', { method: 'POST', headers: { 'x-obeya-key': 'guessed' } })).status).toBe(401);
    const page = await bare('/');
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('nicht bei Obeya angemeldet');
    expect(await opens({})).toBe(false);
    expect(board.snapshot().items).toEqual([]);
  });

  test('a link signs browsers in: its cookie carries the key, to the page, the API and the WebSocket', async () => {
    const url = await link('/?c=main');
    expect(url).toStartWith(`${server.url.origin}/login?token=`);
    const signed = await bare(url);
    expect(signed.status).toBe(200);
    const set = signed.headers.get('set-cookie')!;
    expect(await onward(signed)).toBe('/?c=main');
    expect(set).toContain(`obeya-${server.port}=`);
    expect(set).toContain('HttpOnly; SameSite=Strict');
    const cookie = set.split(';')[0]!;
    expect((await bare('/', { headers: { cookie } })).status).toBe(200);
    expect((await bare(api('/canvas'), { headers: { cookie } })).status).toBe(200);
    expect(await opens({ cookie, origin: server.url.origin })).toBe(true);
    // another browser (Chrome beside Safari) with the same link, until the server stops; the same link from a second start
    expect((await bare(url)).headers.get('set-cookie')).toBe(set);
    expect(await link('/?c=main')).toBe(url);
    expect(await onward(await bare(url, { headers: { cookie } }))).toBe('/?c=main');
    // a cookie of the Obeya on another port, or with another key, names nobody
    expect((await bare(api('/canvas'), { headers: { cookie: cookie.replace(`obeya-${server.port}`, `obeya-${server.port! + 1}`) } })).status).toBe(401);
    expect((await bare(api('/canvas'), { headers: { cookie: `obeya-${server.port}=guessed` } })).status).toBe(401);
  });

  test('a link for one browser (through the system’s `open`) signs in only the first', async () => {
    const url = await link('/?c=main', true);
    expect(url).not.toBe(await link('/?c=main'));
    const cookie = (await bare(url)).headers.get('set-cookie')!.split(';')[0]!;
    expect((await bare(api('/canvas'), { headers: { cookie } })).status).toBe(200);
    const again = await bare(url);
    expect(again.status).toBe(401);
    expect(await again.text()).toContain('für einen einzigen Browser');
    expect(await onward(await bare(url, { headers: { cookie } }))).toBe('/?c=main');
  });

  test('a page a link from another site opened goes there again from its own, which carries the cookie', async () => {
    const cookie = (await bare(await link())).headers.get('set-cookie')!.split(';')[0]!;
    const opened = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    // the browser does not send the Strict cookie with it
    expect(await onward(await bare('/?c=main', { headers: opened }))).toBe('/?c=main');
    // a path that looks like another host stays one of Obeya's
    expect(await onward(await bare(`${server.url.origin}//evil.example/`, { headers: opened }))).toBe('/evil.example/');
    expect((await bare('/?c=main', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' } })).status).toBe(401);
    expect((await bare('/?c=main', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', cookie } })).status).toBe(200);
  });

  test('a canvas’s and a card’s address serve the page, to the owner only', async () => {
    const cookie = (await bare(await link())).headers.get('set-cookie')!.split(';')[0]!;
    const page = await bare('/c/main/card/a1b2c3', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    expect((await bare('/c/main', { headers: { cookie } })).status).toBe(200);
    expect((await bare('/c/main/card/a1b2c3')).status).toBe(401);
  });

  test('a link leads only to a path of Obeya’s', async () => {
    for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example/'])
      expect(await onward(await bare(await link(next)))).toBe('/');
    expect((await bare(`${server.url.origin}/login?token=made-up`)).status).toBe(401);
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

describe("a card's app", () => {
  test('opens at its address while its worker says it runs; after that the browser hears it no longer does', async () => {
    const c = card();
    const open = () => fetch(new URL(api(`/cards/${c.id}/app/open`), server.url), { redirect: 'manual' });
    const app = Bun.serve({ port: 0, fetch: () => new Response('Shop') });
    try {
      board.work(c.id, { state: 'waiting', need: 'review', workspace: join(dir, 'ws'), app: `http://localhost:${app.port}/` });
      expect(await (await fetch(new URL(api(`/cards/${c.id}/app`), server.url))).json()).toEqual({ up: true });
      const there = await open();
      expect(there.status).toBe(302);
      expect(there.headers.get('location')).toBe(`http://localhost:${app.port}/`);
      board.work(c.id, { parked: new Date().toISOString() });
      const gone = await open();
      expect(gone.status).toBe(404);
      expect(await gone.text()).toBe(board.t.worker.appGone);
    } finally {
      await app.stop(true);
    }
  });
});

describe('the log', () => {
  test('a line taken out of it leaves every page', async () => {
    const c = card();
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await until(() => ws.readyState === WebSocket.OPEN && messages.some((m) => m.type === 'snapshot'));
    const e = board.log(c.id, 'hint', 'owner', 'Doch nicht.');
    board.unlog(c.id, e.id);
    await until(() => messages.some((m) => m.type === 'eventGone'));
    expect(messages.find((m) => m.type === 'eventGone')).toEqual({ type: 'eventGone', cardId: c.id, id: e.id });
    expect(board.events(c.id).some((x) => x.id === e.id)).toBe(false);
    ws.close();
  });
});

describe('groups', () => {
  test('are created with cards, renamed and assigned, and every page hears of it', async () => {
    const [a, b] = [card(), card()];
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await until(() => ws.readyState === WebSocket.OPEN && messages.some((m) => m.type === 'snapshot'));
    const g = (await (await post(api('/groups'), JSON.stringify({ name: 'Abrechnung', cards: [a.id] }))).json()) as { id: string; name: string; hue: number };
    expect(g).toMatchObject({ name: 'Abrechnung', hue: expect.any(Number) });
    const patch = (id: string, body: string) => fetch(new URL(api(`/groups/${id}`), server.url), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
    expect((await patch(g.id, JSON.stringify({ name: 'Billing' }))).status).toBe(204);
    expect((await post(api('/assign'), JSON.stringify({ cards: [b.id], group: g.id }))).status).toBe(204);
    await until(() => {
      const last = messages.findLast((m) => m.type === 'snapshot');
      return last?.type === 'snapshot' && last.snapshot.items.find((i) => i.id === b.id)?.group === g.id;
    });
    const last = messages.findLast((m) => m.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }>;
    expect(last.snapshot.groups).toEqual([{ ...g, name: 'Billing' }]);
    expect((await post(api('/assign'), JSON.stringify({ cards: [a.id, b.id], group: null }))).status).toBe(204);
    expect(board.snapshot().groups).toEqual([]);
    expect(await codeOf(patch(g.id, JSON.stringify({ name: 'X' })))).toBe('unknownGroup');
    const h = (await (await post(api('/groups'), JSON.stringify({ name: 'Infra', cards: [a.id], hue: 77 }))).json()) as { id: string };
    const del = await fetch(new URL(api(`/groups/${h.id}`), server.url), { method: 'DELETE' });
    expect(await del.json()).toEqual({ group: { id: h.id, name: 'Infra', hue: 77 }, cards: [a.id] });
    expect(board.snapshot().groups).toEqual([]);
    expect(await codeOf(post(api('/groups'), JSON.stringify({ name: '', cards: [a.id] })))).toBe('emptyText');
    expect(await codeOf(post(api('/assign'), 'null'))).toBe('invalid');
    ws.close();
  });
});

describe('plan docs', () => {
  test("a project's plan doc is read as written; other cards have none", async () => {
    const md = '# Export\n\n## Goal\n\nCSV for landlords.\n\n## Workstreams\n\n- [ ] **W1:** CSV. Columns as in `docs/x.md`.\n\n## Notes\n\nMore.\n';
    // where plan docs are read: the Lesestand of the repository (a worktree on its default branch)
    const read = canvas.repos[0]!.read.path;
    mkdirSync(join(read, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(read, 'docs', 'plan', 'export.md'), md);
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

  test('a recording is transcribed, read as one action, confirmed in writing, and runs after the delay', async () => {
    const res = fetch(new URL(api('/voice'), server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    expect(heardAudio).toEqual(['AUDIO']);
    expect(s.inbox[0]).toContain('"Neue Karte Export"');
    expect(s.spec).toMatchObject({ readOnly: true, effort: 'medium' });
    s.call('act', { actions: [{ do: 'new_card', title: 'Export', body: 'CSV', start: true }], confirm: 'Neue Karte „Export“, der Agent fängt an.' });
    s.emit({ type: 'idle' });
    const body = (await (await res).json()) as { confirm: string; token: string; audio?: string };
    expect(body.confirm).toBe('Neue Karte „Export“, der Agent fängt an.');
    expect(body.token).toBeTruthy();
    expect((body as { undoMs?: number }).undoMs).toBe(DELAY_MS);
    // Obeya does not speak
    expect(body.audio).toBeUndefined();
    expect(executed).toEqual([]);
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'newCard', title: 'Export', body: 'CSV', start: true }]);
  });

  test('a card a recording makes carries where the owner was on the canvas; a follow-up does not', async () => {
    const res = fetch(new URL(`${api('/voice')}?place=400,300,0,0,1200,800`, server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    s.call('act', { actions: [{ do: 'new_card', title: 'Export', body: 'CSV', start: false }, { do: 'new_idea', title: 'Mieter', body: '' }], confirm: 'Zwei neue Karten.' });
    s.emit({ type: 'idle' });
    await res;
    await until(() => executed.length === 2);
    const place = { x: 400, y: 300, view: { x: 0, y: 0, w: 1200, h: 800 } };
    expect(executed).toEqual([
      { do: 'newCard', title: 'Export', body: 'CSV', start: false, place },
      { do: 'newIdea', title: 'Mieter', body: '', place },
    ]);
  });

  test('a page that lost the answer learns whether its recording arrived, while Obeya still reads it', async () => {
    const arrived = async (id: string) => (await (await fetch(new URL(api(`/voice/arrived/${id}`), server.url))).json()) as { arrived: boolean };
    expect(await arrived('r1')).toEqual({ arrived: false });
    const res = fetch(new URL(`${api('/voice')}?sent=r1`, server.url), { method: 'POST', body: 'AUDIO' });
    const s = await briefed();
    expect(await arrived('r1')).toEqual({ arrived: true });
    expect(await arrived('r2')).toEqual({ arrived: false });
    s.call('act', { actions: [], confirm: 'Ok.' });
    s.emit({ type: 'idle' });
    await res;
  });

  test('a recording Whisper loops on is transcribed once more without the card titles', async () => {
    board.create({ title: 'Export für Vermieter', x: 0, y: 0 });
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
    board.create({ title: 'Export für Vermieter', x: 0, y: 0 });
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
      expect(runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act'))).toEqual([]);
    });
  }

  test('typed commands name cards by tag; undo takes one back before it runs', async () => {
    const c = card();
    const res = fetch(new URL(api(`/command?card=${c.id}`), server.url), { method: 'POST', body: JSON.stringify({ text: 'starte das' }) });
    const s = await briefed();
    expect(s.inbox[0]).toContain('The owner has this card open');
    s.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„A“ startet.' });
    s.emit({ type: 'idle' });
    const { token } = (await (await res).json()) as { token: string };
    const undo = await (await fetch(new URL(api('/command/undo'), server.url), { method: 'POST', body: JSON.stringify({ token }) })).json();
    expect(undo).toEqual({ undone: true });
    await sleep(DELAY_MS + 50);
    expect(executed).toEqual([]);
  });

  test('a page that opens while a command waits for undo (a reload) offers "Rückgängig" again', async () => {
    const c = card();
    canvas.commander.undoable = () => [{ text: '„A“ startet.', token: 'tok', undoMs: 3000, cardId: c.id }];
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await until(() => messages.some((m) => m.type === 'notice'));
    expect(messages.find((m) => m.type === 'notice')).toEqual({ type: 'notice', text: '„A“ startet.', token: 'tok', undoMs: 3000, cardId: c.id });
    ws.close();
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
    expect(await heard).toEqual({ confirm: 'Was genau soll ich tun?', talk: 1 });
  });

  test('a session that fails again tells the owner why, not that they went unheard', async () => {
    const c = card();
    canvas.commander.warm();
    const k = interpretation();
    const heard = canvas.commander.hear('starte A', { card: c.id });
    await until(() => k.inbox.length);
    k.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    await until(() => interpretation() !== k);
    const fresh = await briefed();
    fresh.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    const { confirm } = await heard;
    expect(confirm).toStartWith('Ich konnte das nicht lesen.');
    expect(confirm).toContain('/login');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'say', author: 'koordinator', text: confirm });
  });

  test("on a card an agent listens on, typed and spoken words go straight to it, without the Koordinator", async () => {
    const told: [string, string, string[], boolean][] = [];
    canvas.tell = (cardId, text, images, spoken) => void told.push([cardId, text, images, spoken]);
    const c = card();
    board.work(c.id, { state: 'waiting', need: 'review' });
    const typed = (await (await post(api(`/command?card=${c.id}`), JSON.stringify({ text: 'gib das frei', field: 'feedback' }))).json()) as { quiet?: boolean };
    expect(typed).toMatchObject({ quiet: true });
    whisper = () => 'Mach den Knopf größer';
    const spoken = (await (await fetch(new URL(api(`/voice?card=${c.id}`), server.url), { method: 'POST', body: 'AUDIO' })).json()) as { quiet?: boolean };
    expect(spoken).toMatchObject({ quiet: true });
    expect(told).toEqual([
      [c.id, 'gib das frei', [], false],
      [c.id, 'Mach den Knopf größer', [], true],
    ]);
    // an idea's exploration agent listens too; a planned card has nobody but the Koordinator
    const idea = board.create({ title: 'Export', x: 0, y: 0, idea: true });
    await post(api(`/command?card=${idea.id}`), JSON.stringify({ text: 'Was kostet das?' }));
    expect(told.at(-1)).toEqual([idea.id, 'Was kostet das?', [], false]);
    expect(runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act'))).toEqual([]);
    const planned = card();
    const res = post(api(`/command?card=${planned.id}`), JSON.stringify({ text: 'starte das' }));
    (await briefed()).call('reply', { confirm: 'Ok.' });
    interpretation().emit({ type: 'idle' });
    await res;
    expect(told).toHaveLength(3);
  });

  test('words typed or spoken in reply to a message of the card go to its agent with it', async () => {
    const told: (number | undefined)[] = [];
    canvas.tell = (_cardId, _text, _images, _spoken, replyTo) => void told.push(replyTo);
    const c = card();
    board.work(c.id, { state: 'working' });
    await post(api(`/command?card=${c.id}`), JSON.stringify({ text: 'nein, so', field: 'note', replyTo: 7 }));
    whisper = () => 'genau so';
    await fetch(new URL(api(`/voice?card=${c.id}&replyTo=8`), server.url), { method: 'POST', body: 'AUDIO' });
    await post(api(`/command?card=${c.id}`), JSON.stringify({ text: 'ohne', field: 'note' }));
    expect(told).toEqual([7, 8, undefined]);
  });

  test('words typed or spoken in reply to a message of the sheet go to the Koordinator with it', async () => {
    const heard: unknown[] = [];
    canvas.commander.hear = async (_text, _focus, _images, input = {}) => {
      heard.push(input.replyTo);
      return { confirm: 'Ok.' };
    };
    await post(api('/command'), JSON.stringify({ text: 'und dann?', replyTo: { talk: 3, part: 'answer' } }));
    whisper = () => 'und dann';
    await fetch(new URL(api('/voice?replyTo=4.reply'), server.url), { method: 'POST', body: 'AUDIO' });
    await post(api('/command'), JSON.stringify({ text: 'so', replyTo: { talk: 3, part: 'other' } }));
    expect(heard).toEqual([{ talk: 3, part: 'answer' }, { talk: 4, part: 'reply' }, undefined]);
  });

  test('words dictated into a field come back without going anywhere; spoken at once, the field’s words go first', async () => {
    const told: string[] = [];
    canvas.tell = (_cardId, text) => void told.push(text);
    const c = card();
    board.work(c.id, { state: 'working' });
    whisper = () => 'und hier fehlt der zweite Knopf';
    const voice = (q: string, body: BodyInit) => fetch(new URL(api(`/voice?card=${c.id}${q}`), server.url), { method: 'POST', body }).then((r) => r.json());
    expect(await voice('&listen', 'AUDIO')).toEqual({ confirm: '', quiet: true, text: 'und hier fehlt der zweite Knopf' });
    expect(told).toEqual([]);
    const form = (text: string) => {
      const f = new FormData();
      f.set('audio', new Blob(['AUDIO']));
      f.set('text', text);
      return f;
    };
    expect(await voice('', form(' Siehe Log: '))).toMatchObject({ quiet: true });
    // a browser sends the form's line breaks as CRLF
    await voice('', form('Zwei Dinge.\r\n- erstens'));
    expect(told).toEqual(['Siehe Log: und hier fehlt der zweite Knopf', 'Zwei Dinge.\n- erstens\n\nund hier fehlt der zweite Knopf']);
    expect(heardAudio).toEqual(['AUDIO', 'AUDIO', 'AUDIO']);
    // nothing heard: nothing goes out, and the field keeps its words
    whisper = () => '';
    expect(await voice('&listen', 'AUDIO')).toMatchObject({ unheard: true, confirm: 'Ich habe nichts gehört.' });
    expect(await voice('', form('Siehe Log:'))).toMatchObject({ unheard: true });
    expect(told).toHaveLength(2);
  });

  test('words typed or spoken about a place in the demo video go to its agent with it', async () => {
    const told: unknown[] = [];
    canvas.tell = (_cardId, _text, _images, _spoken, _replyTo, spot) => void told.push(spot);
    const c = card();
    board.work(c.id, { state: 'working' });
    await post(api(`/command?card=${c.id}`), JSON.stringify({ text: 'hier', field: 'note', spot: { at: 83.2 } }));
    whisper = () => 'und hier';
    await fetch(new URL(api(`/voice?card=${c.id}&at=12.5&still=x.jpg`), server.url), { method: 'POST', body: 'AUDIO' });
    await fetch(new URL(api(`/voice?card=${c.id}`), server.url), { method: 'POST', body: 'AUDIO' });
    // in an earlier demo, named by the handover it came with
    await fetch(new URL(api(`/voice?card=${c.id}&at=3&demo=7`), server.url), { method: 'POST', body: 'AUDIO' });
    expect(told).toEqual([{ at: 83.2 }, { at: 12.5, still: 'x.jpg' }, undefined, { at: 3, demo: 7 }]);
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
    const res = await post(api('/cards'), JSON.stringify({ title: 'Seite bricht um', x: 0, y: 0, images: [id] }));
    const c = (await res.json()) as { id: string };
    expect(board.item(c.id)!.images).toEqual([id]);
    const patch = (p: unknown) => fetch(new URL(api(`/cards/${c.id}`), server.url), { method: 'PATCH', body: JSON.stringify(p) });
    expect((await patch({ images: [] })).status).toBe(204);
    expect(board.item(c.id)!.images).toBeUndefined();
    expect(await codeOf(patch({ images: ['0000.png'] }))).toBe('invalid');
    expect(await codeOf(post(api('/cards'), JSON.stringify({ title: 'x', x: 0, y: 0, images: 'a.png' })))).toBe('invalid');
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
        { do: 'new_card', title: 'Seite bricht um', body: 'diese Seite bricht um' },
        { do: 'note', card: 'K1', text: 'So sieht es aus.' },
        { do: 'stop', card: 'K1' },
      ],
      confirm: 'Neue Karte „Seite bricht um“; an „A“ weitergegeben.',
    });
    await res;
    await until(() => executed.length === 3, DELAY_MS + 3000);
    expect(executed).toEqual([
      { do: 'newCard', title: 'Seite bricht um', body: 'diese Seite bricht um', start: true, images: [id] },
      { do: 'note', card: c.id, text: 'So sieht es aus.', spoken: false, images: [id] },
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
    k.call('act', { actions: [{ do: 'new_card', title: 'Export', body: 'bricht um' }], confirm: 'Neue Karte „Export“.' });
    expect(await (await res).json()).not.toHaveProperty('unheard');
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'newCard', title: 'Export', body: 'bricht um', start: true, images: [id] }]);
    expect(board.snapshot().talk.at(-1)).toMatchObject({ said: 'Neue Karte Export', images: [id] });

    whisper = () => '';
    expect(await (await voice(`?image=${id}`)).json()).toMatchObject({ confirm: 'Ich habe nichts gehört.', unheard: true });
  });

  test('a new card from a command keeps its screenshots; one said with a start goes to the task', async () => {
    const { id } = (await (await upload(png)).json()) as { id: string };
    const run = CanvasRuntime.prototype.run.bind(canvas);
    run({ do: 'newCard', title: 'Seite bricht um', body: '', start: false, images: [id] });
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

describe('other files', () => {
  const upload = (body: Uint8Array<ArrayBuffer>, name: string) =>
    fetch(new URL(api(`/files?name=${encodeURIComponent(name)}`), server.url), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });

  test('are kept under their name, which goes into a path, and their path comes back', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const { path } = (await (await upload(pdf, 'Rechnung März 2026.pdf')).json()) as { path: string };
    expect(path.startsWith(join(canvas.files.dir, ''))).toBe(true);
    expect(path).toMatch(/[0-9a-f-]{36}\/Rechnung-März-2026\.pdf$/);
    expect(new Uint8Array(readFileSync(path))).toEqual(pdf);
    // the same name twice: two files
    const again = (await (await upload(pdf, 'Rechnung März 2026.pdf')).json()) as { path: string };
    expect(again.path).not.toBe(path);
    // a name cannot lead out of its directory
    const out = (await (await upload(pdf, '../../obeya.db')).json()) as { path: string };
    expect(dirname(dirname(out.path))).toBe(canvas.files.dir);
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

  test('a rule about a repository goes straight into its card „CLAUDE.md ergänzen“, which starts once no proposal waits', async () => {
    const run = CanvasRuntime.prototype.run.bind(canvas);
    const repo = board.canvas.repos[0]!.id;
    const c = card();
    const waiting = board.proposePreference('Fragen mit höchstens drei Optionen.', {});
    const moved = board.addPreference('Tests auf Deutsch.');
    // said with a card open, and moving one of the owner's rules
    run({ do: 'remember', text: 'Tests auf Deutsch benennen.', repos: [repo], replaces: moved, card: c.id });
    expect(board.preferences('active')).toEqual([]);
    expect(board.preferences('filed')).toMatchObject([{ text: 'Tests auf Deutsch benennen.', target: repo, cardId: c.id }]);
    const collect = board.collecting(repo)!;
    expect(collect).toMatchObject({ title: 'CLAUDE.md ergänzen', repo });
    expect(collect.body).toEndWith('- Tests auf Deutsch benennen.');
    // written in the sheet; a proposal still waits, so the card collects on
    expect((await post(api('/preferences'), JSON.stringify({ text: 'Commits auf Englisch.', target: repo }))).status).toBe(204);
    expect(board.collecting(repo)!.body).toEndWith('- Tests auf Deutsch benennen.\n- Commits auf Englisch.');
    expect(await codeOf(post(api('/preferences'), JSON.stringify({ text: 'X.', target: 'nope' })))).toBe('invalid');
    expect(board.preferencesText()).toBe('');
    canvas.rejectRule(waiting);
    expect(board.item(collect.id)!.queue).toBeTruthy();
    expect(board.collecting(repo)).toBeUndefined();
  });
});

describe('a newer version of the app', () => {
  test('shows on the canvas while the shell reports it, and installing it waits like a restart', async () => {
    const gone: string[] = [];
    let busy = [{ canvas: 'main', card: 'k1' }];
    const restarter = new Restarter({ busy: () => busy, go: (reason) => gone.push(reason), patienceMs: 60_000, intervalMs: 10 });
    const updates = new AppUpdates();
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter, undefined, undefined, undefined, updates);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const shown = () => messages.filter((m): m is Extract<ServerMessage, { type: 'update' }> => m.type === 'update');
    await until(() => shown().length === 1);
    expect(shown()[0]!.update).toBeNull();
    // nothing to install yet
    expect(await codeOf(post('/api/app-update/install', ''))).toBe('invalid');

    expect(await codeOf(post('/api/app-update', JSON.stringify({ notes: 'x' })))).toBe('invalid');
    const report = { version: '0.2.0', notes: '- Faster.\n- Smaller.', date: Date.UTC(2026, 9, 12), download: null };
    expect(await (await post('/api/app-update', JSON.stringify(report))).json()).toEqual({ version: '0.2.0', notes: '- Faster.\n- Smaller.', date: Date.UTC(2026, 9, 12) });
    await until(() => shown().length === 2);
    expect(shown()[1]!.update).toMatchObject({ version: '0.2.0' });
    // the same again every few seconds tells the page nothing new
    await post('/api/app-update', JSON.stringify(report));
    await sleep(50);
    expect(shown()).toHaveLength(2);

    expect(await (await post('/api/app-update/install', '')).json()).toEqual({ updating: true });
    await until(() => restarter.due()?.reason === 'update');
    expect(gone).toEqual([]);
    busy = [];
    await until(() => gone.length === 1);
    expect(gone).toEqual(['update']);
    ws.close();
  });

  test('one the app cannot install (a .deb) is only shown, with where to get it', async () => {
    const restarter = new Restarter({ busy: () => [], go: () => {} });
    const updates = new AppUpdates();
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter, undefined, undefined, undefined, updates);
    await post('/api/app-update', JSON.stringify({ version: '0.2.0', download: 'https://github.com/sadilek/obeya/releases/tag/v0.2.0' }));
    expect(updates.current()).toEqual({ version: '0.2.0', download: 'https://github.com/sadilek/obeya/releases/tag/v0.2.0' });
    expect(await codeOf(post('/api/app-update/install', ''))).toBe('invalid');
    expect(restarter.due()).toBeNull();
    // the bar leads to Obeya's releases only, whoever reports another address
    await post('/api/app-update', JSON.stringify({ version: '9.9.9', download: 'https://example.com/obeya.deb' }));
    expect(updates.current()).toEqual({ version: '9.9.9' });
  });

  test('a shell installed from a checkout that built itself anew is installed without asking, as landed code is', async () => {
    const gone: string[] = [];
    let busy = [{ canvas: 'main', card: 'k1' }];
    const restarter = new Restarter({ busy: () => busy, go: (reason) => gone.push(reason), patienceMs: 60_000, intervalMs: 10 });
    const updates = new AppUpdates();
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter, undefined, undefined, undefined, updates);
    expect(await (await post('/api/app-update', JSON.stringify({ rebuilt: true }))).json()).toEqual({ updating: true });
    // no button in the bar: the restart shows what it waits for
    expect(updates.current()).toBeNull();
    expect(restarter.due()?.reason).toBe('update');
    // the shell says it again every few seconds while it waits
    await post('/api/app-update', JSON.stringify({ rebuilt: true }));
    busy = [];
    await until(() => gone.length === 1);
    expect(gone).toEqual(['update']);
  });

  test('the app taking over an Obeya that runs without it ends it once the workers paused, also when a restart for new code waits', async () => {
    const gone: string[] = [];
    let busy = [{ canvas: 'main', card: 'k1' }];
    const restarter = new Restarter({ busy: () => busy, go: (reason) => gone.push(reason), patienceMs: 60_000, intervalMs: 10 });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter, undefined, undefined, undefined, new AppUpdates());
    restarter.request('code');
    expect(await (await post('/api/app-takeover', '')).json()).toEqual({ taking: true });
    await until(() => restarter.due()?.reason === 'takeover');
    // the supervisor would start it again in place, still without the app: it ends for the app instead
    expect(restarter.due()?.reason).toBe('takeover');
    restarter.request('code');
    expect(restarter.due()?.reason).toBe('takeover');
    expect(gone).toEqual([]);
    busy = [];
    await until(() => gone.length === 1);
    expect(gone).toEqual(['takeover']);
  });

  test('a new build of the shell starts again without the server, not while the owner speaks, and the page hands over what a reload keeps', async () => {
    const gone: string[] = [];
    const restarter = new Restarter({ busy: () => [{ canvas: 'main', card: 'k1' }], go: (reason) => gone.push(reason) });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter, undefined, undefined, undefined, new AppUpdates());
    const ask = async (kept = '') => (await post('/api/app-rebuilt', JSON.stringify({ kept }))).json();
    // a worker in the middle of a turn does not hold it off: the server and its workers run on
    expect(await ask()).toEqual({ now: true, kept: false });
    restarter.hold('page1', ['voice']);
    expect(await ask()).toEqual({ now: false, kept: false });
    restarter.hold('page1');

    const entries = [['obeya-kept-main', '{"card":"k1"}'], ['obeya-drafts-main', '{"k1":{"text":"half a sentence"}}']];
    expect(await codeOf(post('/api/app-rebuilt/handover', JSON.stringify({ token: '7', entries: [['a', 1]] })))).toBe('invalid');
    await post('/api/app-rebuilt/handover', JSON.stringify({ token: '7', entries }));
    expect(await ask('6')).toEqual({ now: true, kept: false });
    expect(await ask('7')).toEqual({ now: true, kept: true });
    // the page of the new shell takes it, once
    expect(await (await fetch(new URL('/api/app-rebuilt/handover', server.url))).json()).toEqual(entries);
    expect(await (await fetch(new URL('/api/app-rebuilt/handover', server.url))).json()).toBeNull();
    // and the server never ended for it
    expect(gone).toEqual([]);
    expect(restarter.due()).toBeNull();
  });
});

describe('new commits on the upstream of the checkout Obeya runs from', () => {
  test('show on the canvas, and the owner pulls them into the checkout', async () => {
    const up = join(dir, 'up');
    gitRepo(up, { 'src/a.ts': 'a\n' });
    const clone = join(dir, 'clone');
    git(dir, 'clone', '--quiet', up, clone);
    writeFileSync(join(up, 'src/a.ts'), 'b\n');
    identify(up);
    git(up, 'commit', '--quiet', '-am', 'Faster');
    const sources = new SourceUpdates(clone);
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sources);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const shown = () => messages.filter((m): m is Extract<ServerMessage, { type: 'source' }> => m.type === 'source');
    await until(() => shown().length === 1);
    expect(shown()[0]!.source).toBeNull();
    await sources.check();
    await until(() => shown().length === 2);
    expect(shown()[1]!.source).toMatchObject({ upstream: 'origin/main', count: 1, commits: [{ subject: 'Faster' }] });
    // an edit of the owner's in the way; once they come back from the terminal where they undid it, Obeya looks again
    writeFileSync(join(clone, 'src/a.ts'), 'mine\n');
    await sources.check(false);
    await until(() => shown().length === 3);
    expect(shown()[2]!.source?.blocked).toEqual({ why: 'local', files: ['src/a.ts'] });
    expect(await codeOf(post('/api/source-update/pull', ''))).toBe('invalid');
    git(clone, 'checkout', '--', 'src/a.ts');
    ws.send(JSON.stringify({ type: 'back' } satisfies ClientMessage));
    await until(() => shown().length === 4);
    expect(shown()[3]!.source?.blocked).toBeUndefined();
    expect(await (await post('/api/source-update/pull', '')).json()).toEqual({ source: null });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(up, 'rev-parse', 'HEAD'));
    await until(() => shown().length === 5);
    expect(shown()[4]!.source).toBeNull();
    // nothing left to pull
    expect(await codeOf(post('/api/source-update/pull', ''))).toBe('invalid');
    ws.close();
  });

  test('an Obeya that runs from no checkout has none', async () => {
    expect((await post('/api/source-update/pull', '')).status).toBe(404);
    expect(await (await fetch(new URL('/api/source-update', server.url))).json()).toBeNull();
  });
});

describe('the usage limits in the bar', () => {
  test('a page gets them once fetched for it, and its closing ends the session that fetched them', async () => {
    let closed = 0;
    const usage = new UsageMeter(() => ({ fetch: async () => ({ at: '2026-10-28T08:00:00.000Z', limits: [{ kind: 'session', group: 'session', percent: 7, severity: 'normal' }] }), close: () => void closed++ }), { on: true, lingerMs: 10 });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, usage);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const shown = () => messages.filter((m): m is Extract<ServerMessage, { type: 'usage' }> => m.type === 'usage');
    await until(() => shown().length === 2);
    expect(shown()[0]!.usage).toBeNull();
    expect(shown()[1]!.usage?.limits[0]?.percent).toBe(7);
    ws.close();
    await until(() => closed === 1);
    expect(usage.current()).toBeNull();
  });
});

test('a page that froze has its stall logged, with this machine and the canvas as where', async () => {
  const lines: string[] = [];
  server.stop(true);
  server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Stalls({ home: dir, log: (l) => lines.push(l) }));
  const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: 'stall', ms: 200, scripts: [], before: [] } satisfies ClientMessage));
  ws.send(JSON.stringify({ type: 'stall', ms: 1300, scripts: [{ what: 'WebSocket.onmessage: (anonymous)', ms: 1200 }], before: [] } satisfies ClientMessage));
  await until(() => lines.length > 0);
  ws.close();
  expect(lines).toEqual(['Obeya: a page (this machine, canvas main) stalled for 1.3 s; meanwhile it took no click or key', '  1.2 s WebSocket.onmessage: (anonymous)']);
});

describe('a restart that waits', () => {
  test('shows on the canvas with the cards it waits for, here and by title on the others, and goes ahead at the owner\'s word', async () => {
    const other = join(dir, 'other');
    gitRepo(other);
    const second = new CanvasRuntime({ repos: [{ path: other }] }, { store: new Store(':memory:'), home: join(dir, 'home2'), runtime, forge: noForge });
    const there = second.board.create({ title: 'Export als CSV', x: 0, y: 0 });
    let busy = [
      { canvas: 'main', card: 'k1' },
      { canvas: second.id, card: there.id },
    ];
    let gone = 0;
    const restarter = new Restarter({ busy: () => busy, go: () => gone++, patienceMs: 60_000, intervalMs: 10 });
    server.stop(true);
    server = serve([canvas, second], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter);
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
    expect(restarts()[1]!.restart).toMatchObject({ reason: 'code', cards: ['k1'], elsewhere: [{ canvas: second.board.canvas.name, cards: ['Export als CSV'] }] });
    busy = [busy[0]!];
    await until(() => restarts().length === 3);
    expect(restarts()[2]!.restart).toMatchObject({ cards: ['k1'], elsewhere: [] });

    expect(await (await post('/api/restart', '')).json()).toEqual({ restarting: true });
    await until(() => gone === 1);
    ws.close();
  });

  test('waits while the owner watches a video or dictates in an open page, and goes once that page lets go or closes', async () => {
    let gone = 0;
    const restarter = new Restarter({ busy: () => [], go: () => gone++, patienceMs: 0, intervalMs: 10 });
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, restarter);
    const messages: ServerMessage[] = [];
    const connect = async () => {
      const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
      ws.onmessage = (e) => messages.push(JSON.parse(e.data));
      await until(() => ws.readyState === WebSocket.OPEN);
      return ws;
    };
    const watching = await connect();
    const dictating = await connect();
    const hold = (ws: WebSocket, hold: Extract<ClientMessage, { type: 'hold' }>['hold']) => ws.send(JSON.stringify({ type: 'hold', hold } satisfies ClientMessage));
    const last = () => messages.filter((m): m is Extract<ServerMessage, { type: 'restart' }> => m.type === 'restart').at(-1)!.restart;
    hold(watching, ['video']);
    hold(dictating, ['voice']);
    await until(() => restarter['holds'].size === 2);

    // no worker is busy and the patience is out: only the owner holds it off
    restarter.request('code');
    await until(() => last()?.owner.length === 2);
    expect(last()).toMatchObject({ cards: [], elsewhere: [], owner: ['video', 'voice'] });
    hold(watching, []);
    await until(() => last()?.owner.length === 1);
    expect(last()!.owner).toEqual(['voice']);
    await Bun.sleep(50);
    expect(gone).toBe(0);
    dictating.close();
    await until(() => gone === 1);
    watching.close();
  });

  test('waits for a dictation the server is still writing down, also when no page holds it off', async () => {
    let gone = 0;
    const restarter = new Restarter({ busy: () => [], go: () => gone++, patienceMs: 0, intervalMs: 10 });
    let written = (_: string) => {};
    const writing = new Promise<string>((resolve) => (written = resolve));
    server.stop(true);
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: await writing, doubtful: false }) } }, 0, false, undefined, restarter);
    const dictated = fetch(new URL(api('/voice?listen'), server.url), { method: 'POST', body: 'AUDIO' });
    await until(() => restarter['holds'].size === 1);
    restarter.request('code');
    expect(restarter.due()).toMatchObject({ owner: ['voice'] });
    await Bun.sleep(50);
    expect(gone).toBe(0);
    written('Ein langes Diktat');
    expect(await (await dictated).json()).toMatchObject({ text: 'Ein langes Diktat' });
    await until(() => gone === 1);
  });
});

describe('cards that need the owner', () => {
  test('are counted per canvas on every canvas, so the switcher points to the others', async () => {
    const other = join(dir, 'other');
    gitRepo(other);
    const second = new CanvasRuntime({ repos: [{ path: other }] }, { store: new Store(':memory:'), home: join(dir, 'home2'), runtime, forge: noForge });
    const waiting = second.board.create({ title: 'B', x: 0, y: 0 });
    second.board.work(waiting.id, { state: 'waiting', need: 'review' });
    server.stop(true);
    server = serve([canvas, second], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const counts = () => messages.flatMap((m) => (m.type === 'waiting' ? [m.waiting] : []));
    await until(() => counts().length === 1);
    expect(counts()[0]).toEqual({ main: 0, other: 1 });

    // a change on the other canvas reaches this one; one that leaves the counts alone does not
    second.board.patch(waiting.id, { title: 'B2' });
    const c = second.board.create({ title: 'C', x: 0, y: 0 });
    second.board.work(c.id, { state: 'waiting', need: 'review' });
    await until(() => counts().length === 2);
    expect(counts()[1]).toEqual({ main: 0, other: 2 });
    second.board.work(waiting.id, { state: 'working' });
    await until(() => counts().length === 3);
    expect(counts()[2]).toEqual({ main: 0, other: 1 });
    ws.close();
  });
});

describe('canvases that start and stop while Obeya runs', () => {
  test('a new canvas is served at once and every page hears of it; the pages of one that stopped go elsewhere', async () => {
    const other = join(dir, 'other');
    gitRepo(other);
    const set = new Canvases([], { store: new Store(':memory:'), home: join(dir, 'home2'), runtime, forge: noForge, restartIntervalMs: 5 });
    const list = [canvas];
    server.stop(true);
    server = serve({ all: () => [...list, ...set.all()], onChange: (fn) => set.onChange(fn) }, { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(new URL(api('/ws'), server.url.href.replace('http', 'ws')));
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await until(() => messages.some((m) => m.type === 'snapshot'));

    set.apply([{ name: 'Andere', repos: [{ path: other }] }], ['andere']);
    await until(() => messages.some((m) => m.type === 'canvases'));
    expect(messages.find((m) => m.type === 'canvases')).toMatchObject({ canvases: [{ id: 'main' }, { id: 'andere', name: 'Andere' }] });
    const listed = (await (await fetch(new URL('/api/canvases', server.url))).json()) as { id: string }[];
    expect(listed.map((c) => c.id)).toEqual(['main', 'andere']);
    const theirs = new WebSocket(new URL('/api/c/andere/ws', server.url.href.replace('http', 'ws')));
    let closed = false;
    theirs.onclose = () => (closed = true);
    await until(() => theirs.readyState === WebSocket.OPEN);

    // it leaves the configuration: nobody works on it, so it stops at once and its page is closed
    set.apply([], []);
    await until(() => closed);
    expect(messages.filter((m) => m.type === 'canvases').at(-1)).toMatchObject({ canvases: [{ id: 'main' }] });
    expect((await post('/api/c/andere/cards', JSON.stringify({ title: 'X', x: 0, y: 0 }))).status).toBe(404);
    ws.close();
  });
});

describe('landing approved work', () => {
  test('a slow push onto main leaves the server answering, and two approvals at once land one after the other', async () => {
    // a repository whose origin takes its time with every push
    const repo = join(dir, 'pushed');
    gitRepo(repo);
    const origin = join(dir, 'origin.git');
    git(dir, 'clone', '--quiet', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '--quiet', 'origin');
    const pushing = join(dir, 'pushing');
    writeFileSync(join(origin, 'hooks/pre-receive'), `#!/bin/sh\ntouch '${pushing}'\nsleep 1\n`, { mode: 0o755 });
    const pushed = new CanvasRuntime({ repos: [{ path: repo, clones: 2, settings: { land: 'pr', direct: true, workspaces: 'clones' } }] }, { store: new Store(':memory:'), home: join(dir, 'home2'), runtime, forge: noForge });
    server.stop(true);
    server = serve([canvas, pushed], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);
    const handedOver = async (title: string) => {
      const c = pushed.board.create({ title, x: 0, y: 0 });
      await pushed.repoOf(c.id).workers.start(c.id);
      const session = runtime.last;
      const clone = pushed.board.row(c.id).workspace!;
      identify(clone);
      writeFileSync(join(clone, `${title}.ts`), title);
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', title);
      await session.call('ready_for_review', { summary: 'S', demo: artifact() });
      session.emit({ type: 'idle' });
      return c;
    };
    const a = await handedOver('A');
    const b = await handedOver('B');
    const approve = (id: string) => post(`/api/c/${pushed.board.canvas.id}/cards/${id}/act`, JSON.stringify({ action: 'approve', direct: true }));

    let answered = 0;
    const landings = [approve(a.id), approve(b.id)].map((r) => r.then((res) => (answered++, res)));
    // while git pushes, the server answers other requests, on this canvas and the others
    await until(() => existsSync(pushing));
    expect((await fetch(new URL(`/api/c/${pushed.board.canvas.id}/canvas`, server.url))).status).toBe(200);
    expect((await fetch(new URL(api('/canvas'), server.url))).status).toBe(200);
    expect(answered).toBe(0);
    // approving again while it lands is refused
    expect(await codeOf(approve(a.id))).toBe('notReady');

    for (const res of await Promise.all(landings)) expect(res.ok).toBe(true);
    expect(pushed.board.item(a.id)!.state).toBe('live');
    expect(pushed.board.item(b.id)!.state).toBe('live');
    expect(git(origin, 'log', '--format=%s', 'main').split('\n').sort()).toEqual(['A', 'B', 'init']);
    pushed.shutdown();
  }, 15_000);
});

describe('starting a card', () => {
  test('while git makes its worktree or clone ready, slowly, the server answers and the card says so', async () => {
    // git that takes its time: adding a worktree (a large repository), fetching into a clone (a slow network)
    const marks = join(dir, 'marks');
    mkdirSync(marks);
    const slow = (mark: string, then = '') => `#!/bin/sh\ntouch '${join(marks, mark)}'\nsleep 2\n${then}`;
    const trees = gitRepo(join(dir, 'trees'));
    mkdirSync(join(trees, '.git/hooks'), { recursive: true });
    writeFileSync(join(trees, '.git/hooks/post-checkout'), slow('worktree'), { mode: 0o755 });
    const cloned = gitRepo(join(dir, 'cloned'));
    const uploadPack = join(dir, 'slow-upload-pack');
    writeFileSync(uploadPack, slow('fetch', 'exec git-upload-pack "$@"\n'), { mode: 0o755 });
    const deps = (home: string) => ({ store: new Store(':memory:'), home: join(dir, home), runtime, forge: noForge });
    const worktrees = new CanvasRuntime({ name: 'Worktrees', repos: [{ path: trees, settings: { workspaces: 'worktrees' } }] }, deps('home-trees'));
    const clones = new CanvasRuntime({ name: 'Clones', repos: [{ path: cloned, clones: 1, settings: { workspaces: 'clones' } }] }, deps('home-clones'));
    const [clone] = clones.repos[0]!.workspaces.list();
    git(clone!.path, 'config', 'remote.origin.uploadpack', uploadPack);
    server.stop(true);
    server = serve([canvas, worktrees, clones], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);

    const starts = [worktrees, clones].map((c) => {
      const card = c.board.create({ title: 'Langsamer Start', x: 0, y: 0 });
      const before = Date.now();
      const started = c.repos[0]!.workers.start(card.id);
      // the start takes the workspace and returns; git goes on in the background
      expect(Date.now() - before).toBeLessThan(1000);
      return { c, card, started };
    });
    await until(() => existsSync(join(marks, 'worktree')) && existsSync(join(marks, 'fetch')));
    for (const { c, card } of starts) {
      const before = Date.now();
      const res = await fetch(new URL(`/api/c/${c.board.canvas.id}/canvas`, server.url));
      expect(res.status).toBe(200);
      expect(Date.now() - before).toBeLessThan(1000);
      const shown = ((await res.json()) as { items: { id: string; state: string; statusLine?: string }[] }).items.find((i) => i.id === card.id);
      expect(shown).toMatchObject({ state: 'working', statusLine: c.board.t.worker.preparingWorkspace });
      // its worker waits for the workspace
      expect(runtime.sessions.some((s) => s.spec.cwd === c.board.row(card.id).workspace)).toBe(false);
    }
    expect((await fetch(new URL(api('/canvas'), server.url))).status).toBe(200);

    for (const { c, card, started } of starts) {
      await started;
      const ws = c.board.row(card.id).workspace!;
      expect(git(ws, 'branch', '--show-current')).toBe(c.board.row(card.id).branch!);
      expect(runtime.sessions.find((s) => s.spec.cwd === ws)!.inbox[0]).toContain('Langsamer Start');
      expect(c.board.item(card.id)!.statusLine).toBeUndefined();
    }
    worktrees.shutdown();
    clones.shutdown();
  }, 15_000);
});

describe('the Lesestand and the free clones', () => {
  test('while git moves the Lesestand or looks at a free clone, slowly, the server answers', async () => {
    const marks = join(dir, 'marks');
    mkdirSync(marks);
    const doc = (title: string) => `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Eins.\n`;
    const origin = gitRepo(join(dir, 'shop'), { 'docs/plan/export.md': doc('Export'), '.gitattributes': '*.md filter=slow\n' });
    const checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    // work goes out as pull requests: the Lesestand is a worktree of the checkout, apart from the pool's clone
    const shop = new CanvasRuntime(
      { name: 'Shop', repos: [{ path: checkout, clones: 1, settings: { land: 'pr', workspaces: 'clones' } }] },
      { store: new Store(':memory:'), home: join(dir, 'home-shop'), runtime, forge: noForge },
    );
    const projects = () => shop.board.snapshot().items.filter((i) => i.kind === 'project').map((p) => p.title).sort();
    expect(projects()).toEqual(['Export']);
    // git that takes its time: a checkout writing the plan docs into the Lesestand (a repository of thousands of files),
    // `git status` in a free clone (a large repository, or one on another machine); each goes on once the test lets it
    const slow = (mark: string, then: string) => {
      const script = join(dir, `slow-${mark}`);
      writeFileSync(script, `#!/bin/sh\ntouch '${join(marks, mark)}'\nwhile [ ! -e '${join(marks, `${mark}.go`)}' ]; do sleep 0.05; done\ntouch '${join(marks, `${mark}.done`)}'\n${then}\n`, { mode: 0o755 });
      return script;
    };
    const go = (mark: string) => writeFileSync(join(marks, `${mark}.go`), '');
    const hold = (mark: string) => rmSync(join(marks, `${mark}.go`), { force: true });
    git(checkout, 'config', 'filter.slow.smudge', slow('checkout', 'cat'));
    const [clone] = shop.repos[0]!.workspaces.list();
    git(clone!.path, 'config', 'core.fsmonitor', slow('status', 'exit 1'));
    server.stop(true);
    server = serve([canvas, shop], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);
    const answers = async () => {
      for (const c of [shop, canvas]) {
        const before = Date.now();
        expect((await fetch(new URL(`/api/c/${c.board.canvas.id}/canvas`, server.url))).status).toBe(200);
        expect(Date.now() - before).toBeLessThan(1000);
      }
    };

    // main moves: the Lesestand follows in the background, the plan docs read before standing meanwhile
    writeFileSync(join(origin, 'docs/plan/import.md'), doc('Import'));
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '-m', 'import');
    let moved = false;
    const refreshed = shop.repos[0]!.read.refresh().then(() => (moved = true));
    await until(() => existsSync(join(marks, 'checkout')));
    await answers();
    expect([moved, projects()]).toEqual([false, ['Export']]);
    go('checkout');
    await refreshed;
    expect(projects()).toEqual(['Export', 'Import']);

    // a minute on (the canvas shown before looked at the free clone for the Workspaces pill), whether a card
    // may take it is answered at once, while git looks at it again in the background
    setSystemTime(new Date(Date.now() + RECHECK_MS));
    const before = Date.now();
    expect(shop.repos[0]!.workspaces.leasable()).toBe(true);
    expect(Date.now() - before).toBeLessThan(1000);
    await until(() => existsSync(join(marks, 'status')));
    await answers();
    go('status');
    await until(() => existsSync(join(marks, 'status.done')));
    hold('status');
    for (const f of ['status', 'status.done']) rmSync(join(marks, f));
    // a card takes it at once; git looks at it again before its worker starts there
    const card = shop.board.create({ title: 'Langsamer Blick', x: 0, y: 0 });
    const starting = Date.now();
    const started = shop.repos[0]!.workers.start(card.id);
    expect(Date.now() - starting).toBeLessThan(1000);
    expect(shop.board.row(card.id).workspace).toBe(clone!.path);
    await until(() => existsSync(join(marks, 'status')));
    await answers();
    expect(runtime.sessions.some((s) => s.spec.cwd === clone!.path)).toBe(false);
    go('status');
    await started;
    expect(runtime.sessions.find((s) => s.spec.cwd === clone!.path)!.inbox[0]).toContain('Langsamer Blick');
    shop.shutdown();
  }, 15_000);
});

describe('freeing and discarding workspaces', () => {
  test('while git frees a worktree or cleans a discarded prototype’s clone, slowly, the server answers; the workspace is free once git is done', async () => {
    const marks = join(dir, 'marks');
    mkdirSync(marks);
    // git that takes its time (a large repository, a clone on another machine): it goes on once the test lets it
    const slow = (mark: string, then: string) => {
      const script = join(dir, `slow-${mark}`);
      writeFileSync(script, `#!/bin/sh\ntouch '${join(marks, mark)}'\nwhile [ ! -e '${join(marks, `${mark}.go`)}' ]; do sleep 0.05; done\n${then}\n`, { mode: 0o755 });
      return script;
    };
    const go = (mark: string) => writeFileSync(join(marks, `${mark}.go`), '');
    const hold = (mark: string) => {
      rmSync(join(marks, `${mark}.go`), { force: true });
      rmSync(join(marks, mark), { force: true });
    };
    go('checkout');
    go('status');
    // a prototype in the pool's only clone, and a card in a worktree of its own
    const origin = gitRepo(join(dir, 'shop'), { 'guide.md': 'Guide\n', '.gitattributes': '*.md filter=slow\n' });
    const shop = new CanvasRuntime(
      { name: 'Shop', repos: [{ path: origin, clones: 1, settings: { land: 'pr', workspaces: 'clones' } }] },
      { store: new Store(':memory:'), home: join(dir, 'home-shop'), runtime, forge: noForge },
    );
    const tools = new CanvasRuntime(
      { name: 'Tools', repos: [{ path: gitRepo(join(dir, 'tools')), settings: { land: 'main', workspaces: 'worktrees' } }] },
      { store: new Store(':memory:'), home: join(dir, 'home-tools'), runtime, forge: noForge },
    );
    const [clone] = shop.repos[0]!.workspaces.list();
    // writing a file of the default branch back into the clone, and `git status` in the worktree, wait for the test
    git(clone!.path, 'config', 'filter.slow.smudge', slow('checkout', 'cat'));
    git(clone!.path, 'config', 'filter.slow.clean', 'cat');
    git(tools.repos[0]!.ref.path, 'config', 'core.fsmonitor', slow('status', 'exit 1'));
    server.stop(true);
    server = serve([canvas, shop, tools], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0);
    const answers = async () => {
      for (const c of [shop, tools, canvas]) {
        const before = Date.now();
        expect((await fetch(new URL(`/api/c/${c.board.canvas.id}/canvas`, server.url))).status).toBe(200);
        expect(Date.now() - before).toBeLessThan(1000);
      }
    };

    // the prototype changed the guide on its branch; discarded, its clone goes back to the default branch
    const idea = shop.board.create({ idea: true, title: 'Export', x: 0, y: 0 });
    const prototype = shop.board.addPrototype(idea.id, 'Prototype: Export – button', 'Button');
    await shop.repos[0]!.workers.start(prototype.id);
    await shop.repos[0]!.workers.prepared();
    writeFileSync(join(clone!.path, 'guide.md'), 'Guide with a button\n');
    identify(clone!.path);
    git(clone!.path, 'commit', '--quiet', '-am', 'Button');
    hold('checkout');
    const discarding = Date.now();
    const discarded = await fetch(new URL(`/api/c/${shop.board.canvas.id}/cards/${prototype.id}/act`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'discard' }),
    });
    expect(discarded.ok).toBe(true);
    expect(Date.now() - discarding).toBeLessThan(1000);
    expect(shop.board.archived().find((i) => i.id === prototype.id)).toMatchObject({ prototypeEnd: 'discarded' });
    await until(() => existsSync(join(marks, 'checkout')));
    await answers();
    // half cleaned, the clone is no other card's yet
    expect(shop.repos[0]!.workspaces.list()).toEqual([{ path: clone!.path, card_id: prototype.id }]);
    expect(shop.repos[0]!.workspaces.leasable()).toBe(false);
    go('checkout');
    await shop.repos[0]!.workers.freed();
    expect(shop.repos[0]!.workspaces.list()).toEqual([{ path: clone!.path, card_id: null }]);
    expect(git(clone!.path, 'branch', '--list', 'obeya/*')).toBe('');
    expect(git(clone!.path, 'status', '--porcelain')).toBe('');

    // a card deleted after it stopped with work committed: git looks whether its worktree holds anything uncommitted before it goes
    const card = tools.board.create({ title: 'Lint', x: 0, y: 0 });
    await tools.repos[0]!.workers.start(card.id);
    await tools.repos[0]!.workers.prepared();
    const tree = tools.board.row(card.id).workspace!;
    writeFileSync(join(tree, 'lint.ts'), 'lint\n');
    git(tree, 'add', '.');
    git(tree, 'commit', '--quiet', '-m', 'Lint');
    await tools.repos[0]!.workers.stop(card.id);
    hold('status');
    const deleting = Date.now();
    tools.board.remove(card.id);
    expect(Date.now() - deleting).toBeLessThan(1000);
    await until(() => existsSync(join(marks, 'status')));
    await answers();
    expect(existsSync(tree)).toBe(true);
    expect(tools.repos[0]!.workspaces.leasedBy(card.id)).toBe(tree);
    go('status');
    await until(() => !existsSync(tree));
    await tools.repos[0]!.workers.freed();
    expect(tools.repos[0]!.workspaces.list()).toEqual([]);
    shop.shutdown();
    tools.shutdown();
  }, 20_000);
});

test("what a worker on another machine reaches: Obeya's narration clips, inline, and nothing else", async () => {
  const asked: unknown[] = [];
  const narration = {
    clip: async (r: { out: string }) => {
      asked.push(r);
      writeFileSync(r.out, 'RIFF');
      return { ok: true as const, seconds: 1 };
    },
  } as unknown as NarrationHost;
  const s = serveNarration(narration);
  try {
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${s.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const clip = { voice: { speaker: 'ryan' }, text: 'Hallo.', language: 'de' };
    expect((await post('/api/demo-settings/sample', { language: 'en', voice: 'command', command: 'touch /tmp/x' })).status).toBe(404);
    expect((await post('/api/config', {})).status).toBe(404);
    // a WAV written to a path on this machine: not from there
    expect((await post('/api/narration/clip', { ...clip, out: '/tmp/x.wav' })).status).toBe(400);
    expect(asked).toEqual([]);
    expect((await post('/api/narration/clip', { ...clip, inline: true })).status).toBe(200);
    expect(asked).toHaveLength(1);
  } finally {
    s.stop(true);
  }
});
