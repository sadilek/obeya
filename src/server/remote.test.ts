import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessView, Pairing } from '../core/types';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { Access, deviceName, machineAddresses, PAIRING_MS, UNUSED_MS } from './remote';
import { serve } from './server';
import { Tailscale } from './tailscale';
import { Push } from './push';
import { asOwner, fakeTailscale, gitRepo, noForge, tailscaleStatus, until } from './testing';
import { b64u } from './webpush';

const NAME = 'mac.tail1234.ts.net';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let dir: string;
let ts: string;
let store: Store;
let access: Access;
let server: ReturnType<typeof serve>;
let clock: number;
let canvas: CanvasRuntime;
let push: Push;
/** What went to the push service: to where. */
let pushed: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-remote-'));
  const main = gitRepo(join(dir, 'main'), { 'README.md': 'hi\n', '.obeya/settings.json': '{ "workspaces": "clones" }\n' });
  ts = join(dir, 'ts');
  store = new Store(':memory:');
  clock = Date.now();
  access = new Access({ store, home: dir, tailscale: new Tailscale(fakeTailscale(ts)), now: () => clock });
  canvas = new CanvasRuntime({ repos: [{ path: main }] }, { store, home: dir, runtime: undefined as never, forge: noForge });
  pushed = [];
  push = new Push({
    store,
    post: async (url) => {
      pushed.push(url);
      return { status: 201, text: async () => '' };
    },
  });
  server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, undefined, undefined, undefined, undefined, undefined, undefined, access, push);
});
afterEach(() => {
  access.stop();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

// on this machine: with the owner's key
const local = (path: string, init: RequestInit = {}) => asOwner(() => server).fetch(new URL(path, server.url), init);
/** What `tailscale serve` sends on: from 127.0.0.1, under the tailnet name, forwarded. */
const viaTailnet = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(new URL(path, server.url), { redirect: 'manual', ...init, headers: { host: NAME, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-host': NAME, 'x-forwarded-proto': 'https', 'user-agent': IPHONE, ...headers } });
const view = async () => (await (await local('/api/access')).json()) as AccessView;
const turnOn = async (remote: unknown = { via: 'tailscale' }) =>
  (await (await local('/api/access', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remote }) })).json()) as AccessView;
const pairing = async () => (await (await local('/api/access/pair', { method: 'POST' })).json()) as Pairing;
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const opens = (headers: Record<string, string>) =>
  new Promise<WebSocket | null>((done) => {
    const ws = new WebSocket(new URL('/api/c/main/ws', server.url.href.replace('http', 'ws')), { headers } as unknown as string[]);
    ws.onopen = () => done(ws);
    ws.onerror = () => done(null);
  });

describe('keeping the machine awake', () => {
  test('off while other devices may not reach Obeya; while a worker works by default, or always as the owner sets it', async () => {
    expect(access.awake()).toBe('off');
    await turnOn({ via: 'tailscale' });
    expect(access.awake()).toBe('works');
    expect((await turnOn({ via: 'tailscale', awake: 'always' })).remote).toEqual({ via: 'tailscale', awake: 'always' });
    expect(access.awake()).toBe('always');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).remote).toEqual({ via: 'tailscale', awake: 'always' });
    await turnOn({ via: 'tailscale', awake: 'sometimes' });
    expect(access.awake()).toBe('works');
    await turnOn(null);
    expect(access.awake()).toBe('off');
  });
});

describe('through Tailscale', () => {
  test('off by default: the tailnet name is not one of Obeya’s', async () => {
    expect((await view()).remote).toBeNull();
    expect((await viaTailnet('/')).status).toBe(421);
    expect(existsSync(join(ts, 'calls')) && readFileSync(join(ts, 'calls'), 'utf8')).not.toContain('serve --bg');
  });

  test('turned on, Obeya serves its port over HTTPS at the tailnet name, and off removes only that entry', async () => {
    // something else serves on 443 already: Obeya takes the next port and leaves it be
    writeFileSync(join(ts, 'serve.json'), JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }));
    const on = await turnOn();
    expect(on.tailscale).toEqual({ state: 'ready', name: NAME, account: 'owner@example.com', others: 1 });
    expect(on.address).toBe(`https://${NAME}:8443`);
    const config = () => JSON.parse(readFileSync(join(ts, 'serve.json'), 'utf8'));
    expect(config().Web[`${NAME}:8443`].Handlers['/'].Proxy).toBe(`http://127.0.0.1:${server.port}`);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).remote).toEqual({ via: 'tailscale' });
    const off = await turnOn(null);
    expect(off.address).toBeNull();
    expect(config().Web[`${NAME}:8443`]).toBeUndefined();
    expect(config().Web[`${NAME}:443`].Handlers['/'].Proxy).toBe('http://127.0.0.1:3000');
  });

  test('stopping, Obeya removes its entry: what takes the port next is not served to the tailnet', async () => {
    await turnOn();
    access.release();
    expect(JSON.parse(readFileSync(join(ts, 'serve.json'), 'utf8')).Web[`${NAME}:443`]).toBeUndefined();
    expect(existsSync(join(dir, 'tailscale-serve.json'))).toBe(false);
  });

  test('says what the network lacks: Tailscale logged out, HTTPS off in the tailnet, missing', async () => {
    tailscaleStatus(ts, { state: 'NeedsLogin', name: NAME, https: false });
    expect((await turnOn()).tailscale).toEqual({ state: 'loggedOut' });
    tailscaleStatus(ts, { state: 'Running', name: NAME, https: false });
    const v = await view();
    expect(v.tailscale).toEqual({ state: 'noHttps', name: NAME });
    expect(v.address).toBeNull();
    expect(readFileSync(join(ts, 'calls'), 'utf8')).not.toContain('serve --bg');
    // once HTTPS is on, the section's next look serves Obeya
    tailscaleStatus(ts, { state: 'Running', name: NAME, https: true });
    expect((await view()).address).toBe(`https://${NAME}`);
    const missing = new Access({ store, tailscale: new Tailscale(null) });
    expect((await missing.view()).tailscale).toEqual({ state: 'missing' });
  });

  test('says the account and that no other device is in the tailnet yet, until the phone joins it', async () => {
    tailscaleStatus(ts, { state: 'Running', name: NAME, https: true, account: 'me@example.com', others: 0 });
    const alone = await turnOn();
    expect(alone.tailscale).toEqual({ state: 'ready', name: NAME, account: 'me@example.com', others: 0 });
    expect(alone.address).toBe(`https://${NAME}`);
    tailscaleStatus(ts, { state: 'Running', name: NAME, https: true, account: 'me@example.com', others: 1 });
    const joined = await view();
    expect(joined.tailscale).toMatchObject({ others: 1 });
    expect(joined.address).toBe(`https://${NAME}`);
  });

  test('a Tailscale slow to answer under load keeps the state it had; one that never answered is stopped', async () => {
    const tailscale = new Tailscale(join(ts, 'tailscale'), process.platform, 500);
    writeFileSync(join(ts, 'slow'), '');
    expect(await tailscale.state()).toEqual({ state: 'stopped' });
    rmSync(join(ts, 'slow'));
    expect(await tailscale.state()).toMatchObject({ state: 'ready', name: 'mac.tail1234.ts.net' });
    writeFileSync(join(ts, 'slow'), '');
    expect(await tailscale.state()).toMatchObject({ state: 'ready', name: 'mac.tail1234.ts.net' });
  });

  test('on Linux without the operator right, the section says so', async () => {
    writeFileSync(join(ts, 'fail'), 'sending serve config: Access denied: serve config denied');
    const linux = new Access({ store, tailscale: new Tailscale(join(ts, 'tailscale'), 'linux') });
    linux.start(4417, () => {});
    expect((await linux.save({ remote: { via: 'tailscale' } })).problem).toEqual({ code: 'operator' });
  });
});

describe('pairing', () => {
  test('a device without a cookie gets the page that says how to connect, and no API', async () => {
    await turnOn();
    const page = await viaTailnet('/');
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Dieses Gerät ist nicht mit Obeya verbunden');
    expect(await (await viaTailnet('/api/canvases')).json()).toMatchObject({ code: 'notPaired' });
    expect(await opens({ host: NAME, 'x-forwarded-for': '100.64.0.7', origin: `https://${NAME}` })).toBeNull();
    // this machine itself needs none
    expect((await local('/api/canvases')).status).toBe(200);
  });

  test('the code from the QR code pairs the phone once; it then opens the canvas, until it is removed', async () => {
    expect((await local('/api/access/pair', { method: 'POST' })).status).toBe(400);
    await turnOn();
    const p = await pairing();
    expect(p.code).toMatch(/^\d{6}$/);
    expect(p.url).toBe(`https://${NAME}/pair?code=${p.code}`);
    // the scanner app opens the address from a page of its own: a navigation from another site
    const paired = await viaTailnet(`/pair?code=${p.code}`, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    expect(paired.status).toBe(303);
    expect(paired.headers.get('location')).toBe('/');
    expect(paired.headers.get('set-cookie')).toContain('HttpOnly');
    expect(paired.headers.get('set-cookie')).toContain('Secure');
    const cookie = cookieOf(paired);
    // a second device with the same code gets nothing
    expect((await viaTailnet(`/pair?code=${p.code}`)).status).toBe(401);
    const v = await view();
    expect(v.devices.map((d) => d.name)).toEqual(['iPhone · Safari']);
    expect(v.pairing?.paired?.name).toBe('iPhone · Safari');

    const page = await viaTailnet('/', { cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<html');
    // a card from the phone's page
    const card = await viaTailnet('/api/c/main/cards', { cookie, origin: `https://${NAME}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ title: 'Vom Telefon', x: 0, y: 0 }) });
    expect(card.status).toBe(200);
    const ws = await opens({ host: NAME, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', origin: `https://${NAME}`, cookie });
    expect(ws).not.toBeNull();
    const closed = new Promise((r) => (ws!.onclose = r));

    // „Entfernen“ takes effect at once
    expect(await (await local(`/api/access/devices/${v.devices[0]!.id}`, { method: 'DELETE' })).json()).toEqual({ removed: true });
    await closed;
    expect((await viaTailnet('/', { cookie })).status).toBe(401);
    expect((await view()).devices).toEqual([]);
  });

  test('a code typed into the page pairs too; a wrong one says so, and five spend it', async () => {
    await turnOn();
    const p = await pairing();
    const typed = (code: string) =>
      viaTailnet('/pair', { origin: `https://${NAME}`, 'content-type': 'application/x-www-form-urlencoded' }, { method: 'POST', body: `code=${encodeURIComponent(code)}` });
    const wrong = await typed('000000' === p.code ? '111111' : '000000');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Dieser Code stimmt nicht');
    expect((await typed(`${p.code.slice(0, 3)} ${p.code.slice(3)}`)).status).toBe(303);
    const q = await pairing();
    const other = q.code === '999999' ? '888888' : '999999';
    // another site sending the browser here with wrong codes spends none of the tries
    const link = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (let i = 0; i < 5; i++) expect((await viaTailnet(`/pair?code=${other}`, link)).status).toBe(401);
    for (let i = 0; i < 4; i++) await typed(other);
    expect((await typed(q.code)).status).toBe(303);
    const s = await pairing();
    for (let i = 0; i < 5; i++) await typed(s.code === '999999' ? '888888' : '999999');
    expect((await typed(s.code)).status).toBe(401);
  });

  test('a code holds five minutes; a device unused for 90 days is no longer paired', async () => {
    await turnOn();
    const p = await pairing();
    clock += PAIRING_MS + 1;
    expect((await viaTailnet(`/pair?code=${p.code}`)).status).toBe(401);
    expect((await view()).pairing).toBeNull();
    const cookie = cookieOf(await viaTailnet(`/pair?code=${(await pairing()).code}`));
    clock += UNUSED_MS - 1000;
    expect((await viaTailnet('/', { cookie })).status).toBe(200);
    // used just now: the 90 days count from here
    clock += UNUSED_MS - 1000;
    expect((await viaTailnet('/', { cookie })).status).toBe(200);
    clock += UNUSED_MS + 1;
    expect((await viaTailnet('/', { cookie })).status).toBe(401);
  });

  test('a paired phone may not pair others, remove devices or change the setting', async () => {
    await turnOn();
    const cookie = cookieOf(await viaTailnet(`/pair?code=${(await pairing()).code}`));
    const own = { cookie, origin: `https://${NAME}`, 'content-type': 'application/json' };
    expect(await (await viaTailnet('/api/access', { cookie })).json()).toEqual({ local: false });
    expect((await viaTailnet('/api/access/pair', own, { method: 'POST' })).status).toBe(403);
    expect((await viaTailnet('/api/access', own, { method: 'PUT', body: JSON.stringify({ remote: null }) })).status).toBe(403);
    const id = (await view()).devices[0]!.id;
    expect((await viaTailnet(`/api/access/devices/${id}`, own, { method: 'DELETE' })).status).toBe(403);
    // another site in the phone's browser gets nothing either
    expect((await viaTailnet('/api/c/main/cards', { ...own, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, { method: 'POST', body: '{}' })).status).toBe(403);
    // nor does the page over plain HTTP under the same name
    expect((await viaTailnet('/api/c/main/cards', { ...own, origin: `http://${NAME}` }, { method: 'POST', body: '{}' })).status).toBe(403);
  });
});

describe('push', () => {
  /** A subscription as a phone's browser makes it. */
  const subscription = async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    return { endpoint: 'https://web.push.apple.com/QGx', keys: { p256dh: b64u(await crypto.subtle.exportKey('raw', keys.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
  };

  test("the manifest's icons and the service worker need no pairing and no key", async () => {
    await turnOn();
    for (const path of ['/icons/180.png', '/icons/512.png', '/sw.js']) {
      expect((await viaTailnet(path)).status).toBe(200);
      expect((await fetch(new URL(path, server.url))).status).toBe(200);
    }
    expect(await (await viaTailnet('/sw.js')).text()).toContain("addEventListener(\"push\"");
    // the rest still does
    expect((await viaTailnet('/api/push')).status).toBe(401);
  });

  test('a paired phone turns notifications on; a card that starts waiting is pushed to it, but not while the owner uses a page here', async () => {
    await turnOn();
    const cookie = cookieOf(await viaTailnet(`/pair?code=${(await pairing()).code}`));
    const own = { cookie, origin: `https://${NAME}`, 'content-type': 'application/json' };
    const before = (await (await viaTailnet('/api/push', { cookie })).json()) as { key: string; on: boolean };
    expect(before.on).toBe(false);
    expect(Buffer.from(before.key, 'base64url')).toHaveLength(65);
    expect((await viaTailnet('/api/push', own, { method: 'PUT', body: JSON.stringify(await subscription()) })).status).toBe(204);
    expect(await (await viaTailnet('/api/push', { cookie })).json()).toEqual({ key: before.key, on: true });
    expect((await view()).devices[0]!.push).toBe(true);
    // this machine gets none
    expect(await (await local('/api/push', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await subscription()) })).json()).toMatchObject({ code: 'onlyDevices' });

    const card = (title: string) => canvas.board.create({ title, body: '', x: 0, y: 0 }).id;
    const a = card('Login');
    canvas.board.work(a, { state: 'waiting', need: 'demo' });
    await until(async () => (await push.settled(), pushed.length === 1));
    expect(pushed).toEqual(['https://web.push.apple.com/QGx']);

    // the owner at a page here: what starts waiting meanwhile stays on the canvas
    const page = new (asOwner(() => server).WebSocket)(new URL('/api/c/main/ws', server.url.href.replace('http', 'ws')));
    await new Promise((r) => (page.onopen = r));
    page.send(JSON.stringify({ type: 'here' }));
    await until(() => push.atDesk());
    canvas.board.work(card('Export'), { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV?', options: [] } }) });
    await push.settled();
    expect(pushed).toHaveLength(1);
    page.close();

    // „Entfernen“ takes the subscription with it
    expect(push.subscribed((await view()).devices[0]!.id)).toBe(true);
    await local(`/api/access/devices/${(await view()).devices[0]!.id}`, { method: 'DELETE' });
    expect(store.pushes()).toEqual([]);
  });

  test("the phone's page in view holds pushes off until it goes out of view or closes, without counting as the machine", async () => {
    await turnOn();
    const cookie = cookieOf(await viaTailnet(`/pair?code=${(await pairing()).code}`));
    const phone = () => opens({ host: NAME, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', origin: `https://${NAME}`, cookie }).then((ws) => ws!);
    const ws = await phone();
    ws.send(JSON.stringify({ type: 'here' }));
    await until(() => push.onADevice());
    expect(push.atDesk()).toBe(false);
    ws.send(JSON.stringify({ type: 'away' }));
    await until(() => !push.onADevice());
    ws.send(JSON.stringify({ type: 'back' }));
    await until(() => push.onADevice());
    // a second page of the phone closing leaves the first holding them off; the last one closing lets go
    const other = await phone();
    other.close();
    await Bun.sleep(50);
    expect(push.onADevice()).toBe(true);
    ws.close();
    await until(() => !push.onADevice());
  });
});

describe('on another address', () => {
  const lan = machineAddresses().find((a) => !a.includes(':'));

  test.skipIf(!lan)("Obeya listens there too, in plain HTTP, and a phone there pairs as through Tailscale", async () => {
    const on = await turnOn({ via: 'address', address: lan });
    expect(on.address).toBe(`http://${lan}:${server.port}`);
    const there = (path: string, headers: Record<string, string> = {}) => fetch(`http://${lan}:${server.port}${path}`, { redirect: 'manual', headers: { 'user-agent': IPHONE, ...headers } });
    expect((await there('/')).status).toBe(401);
    const paired = await there(`/pair?code=${(await pairing()).code}`);
    expect(paired.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(paired.headers.get('set-cookie')).not.toContain('Secure');
    expect((await there('/', { cookie: cookieOf(paired) })).status).toBe(200);
    expect((await turnOn(null)).address).toBeNull();
    expect(await there('/').then(() => 'answered', () => 'gone')).toBe('gone');
  });

  test('an address that is not this machine’s is refused with a reason', async () => {
    expect((await turnOn({ via: 'address', address: '203.0.113.9' })).problem).toMatchObject({ code: 'listen' });
  });
});

test('a device is named by its browser', () => {
  expect(deviceName(IPHONE)).toBe('iPhone · Safari');
  expect(deviceName('Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
  expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Chrome');
});
