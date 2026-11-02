import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '../core/types';
import { Store } from './db';
import { UNUSED_MS } from './remote';
import { DESK_MS, DEVICE_MS, kindOf, plainTitle, Push, startedWaiting, type Waits } from './push';
import { b64u, type Bytes, fromB64u, type Post } from './webpush';

const subtle = crypto.subtle;

/** A paired device with a push subscription whose keys the test holds, and what its push service got. */
async function setup(o: { status?: number } = {}) {
  const store = new Store(':memory:');
  const at = new Date().toISOString();
  store.addDevice({ id: 'phone', name: 'iPhone · Safari', pairedAt: at, lastSeen: at, tokenHash: 'h' });
  const keys = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sent: { url: string; body: Uint8Array }[] = [];
  const post: Post = async (url, init) => {
    sent.push({ url, body: init.body });
    return { status: o.status ?? 201, text: async () => '' };
  };
  let now = Date.now();
  const timers: (() => void)[] = [];
  const push = new Push({ store, post, now: () => now, later: (fn) => void timers.push(fn) });
  push.subscribe('phone', { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: b64u(await subtle.exportKey('raw', keys.publicKey)), auth: b64u(auth) } });
  /** What the phone shows of each push: decrypted as its browser does. */
  const shown = async () => {
    await push.settled();
    return Promise.all(sent.map((s) => open(s.body, keys, auth)));
  };
  return { store, push, sent, shown, timers, tick: (ms: number) => (now += ms), endWindow: () => timers.shift()!() };
}

async function open(body: Uint8Array, keys: CryptoKeyPair, auth: Bytes) {
  const asPublic: Bytes = new Uint8Array(body.slice(21, 86));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, keys.privateKey, 256);
  const hk = async (salt: Bytes, ikm: ArrayBuffer | Bytes, info: string | Bytes, n: number) =>
    new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? new TextEncoder().encode(info) : info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const ua = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  const ikm = await hk(auth, shared, new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...ua, ...asPublic]), 32);
  const salt: Bytes = new Uint8Array(body.slice(0, 16));
  const cek = await subtle.importKey('raw', await hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: await hk(salt, ikm, 'Content-Encoding: nonce\0', 12) }, cek, new Uint8Array(body.slice(86))));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

const waits = (card: string, kind: Waits['kind'] = 'demo', still = true): Waits => ({ card, title: `**${card}**`, kind, still: () => still });

const item = (o: Partial<Item>): Item => ({ id: 'c', kind: 'task', state: 'working', title: 'T', body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...o }) as Item;

describe('what starts waiting', () => {
  test('a card whose needsYou turns true, with what it waits for', () => {
    const before = new Map([
      ['a', item({ id: 'a' })],
      ['b', item({ id: 'b', state: 'waiting', need: 'demo' })],
      ['l', item({ id: 'l', state: 'waiting', need: 'demo', landing: true })],
      ['s', item({ id: 's' })],
      ['r', item({ id: 'r', state: 'waiting', need: 'demo', proposed: true })],
    ]);
    const after = [
      item({ id: 'a', state: 'waiting', need: 'demo' }),
      // waited before already
      item({ id: 'b', state: 'waiting', need: 'demo' }),
      // its landing was refused: the owner approves again
      item({ id: 'l', state: 'waiting', need: 'demo' }),
      item({ id: 's', state: 'waiting', need: 'question', question: { text: 'Fehler', options: [], stuck: true } }),
      item({ id: 'n', state: 'proposal' }),
      item({ id: 'w' }),
      // waited before already, and its agent withdrew it now
      item({ id: 'r', state: 'waiting', need: 'demo', proposed: true, superseded: { why: 'x' } }),
    ];
    expect(startedWaiting(before, after).map((x) => [x.item.id, x.kind])).toEqual([
      ['a', 'demo'],
      ['l', 'landing'],
      ['s', 'stuck'],
      ['n', 'proposal'],
      ['r', 'superseded'],
    ]);
  });

  test('kinds', () => {
    expect(kindOf(item({ state: 'waiting', need: 'question', question: { text: 'x', options: [] } }))).toBe('question');
    expect(kindOf(item({ state: 'waiting', need: 'review' }))).toBe('review');
    expect(kindOf(item({ state: 'working', proposed: true, superseded: { why: 'x' } }))).toBe('superseded');
    expect(kindOf(item({ state: 'waiting', need: 'demo', answered: true }))).toBe('answered');
    expect(kindOf(item({ state: 'inPr', pr: { url: 'u', number: 1, checks: [], conflict: false, ready: true } }))).toBe('pr');
    expect(plainTitle('**Login** mit `OAuth` [hier](https://x)')).toBe('Login mit OAuth hier');
  });
});

describe('Push', () => {
  test('a card that starts waiting is pushed at once, encrypted for the phone, and opens that card', async () => {
    const { push, sent, shown } = await setup();
    push.waits([{ ...waits('c1'), canvas: 'Obeya' }]);
    expect(await shown()).toEqual([{ title: 'c1', body: 'Demo bereit · Obeya', url: '/?card=c1', tag: 'c1' }]);
    expect(sent[0]!.url).toBe('https://web.push.apple.com/abc');
  });

  test('the push of a card opens it at its address on its canvas, by its short code', async () => {
    const { store, push, shown } = await setup();
    store.ensureCanvas('shop', 'Shop');
    const [card] = store.insert([{ canvas_id: 'shop', kind: 'task', state: 'waiting', x: 0, y: 0 }]);
    push.waits([waits(card!.id)]);
    expect((await shown())[0]!.url).toBe(`/c/shop/card/${card!.short}`);
  });

  test('nothing is pushed while the owner used a page at the machine in the last minutes', async () => {
    const { push, shown, tick } = await setup();
    push.here();
    tick(DESK_MS - 1000);
    push.waits([waits('c1')]);
    expect(await shown()).toEqual([]);
    tick(2000);
    push.waits([waits('c2')]);
    expect((await shown()).map((m) => m.tag)).toEqual(['c2']);
  });

  test('nothing is pushed while a page on the phone is in view, and again from when it goes out of view', async () => {
    const { push, shown, tick } = await setup();
    push.onDevice('phone');
    push.waits([waits('c1')]);
    tick(DEVICE_MS - 1000);
    push.waits([waits('c2')]);
    expect(await shown()).toEqual([]);
    push.away('phone');
    push.waits([waits('c3')]);
    expect((await shown()).map((m) => m.tag)).toEqual(['c3']);
  });

  test('a phone page that stopped saying it is in view (locked before it could say so) holds nothing off', async () => {
    const { push, shown, tick } = await setup();
    push.onDevice('phone');
    tick(DEVICE_MS);
    push.waits([waits('c1')]);
    expect((await shown()).map((m) => m.tag)).toEqual(['c1']);
  });

  test('what starts waiting within the minute after a push goes out as one push at its end, without what no longer waits', async () => {
    const { push, shown, timers, endWindow } = await setup();
    push.waits([waits('c1')]);
    push.waits([waits('c2', 'question')]);
    push.waits([waits('c3', 'proposal'), waits('c4', 'demo', false)]);
    push.waits([waits('c5', 'idea')]);
    expect(await shown()).toHaveLength(1);
    expect(timers).toHaveLength(1);
    endWindow();
    expect((await shown())[1]).toEqual({ title: '3 Karten warten auf dich', body: 'c2 · c3 · c5', url: '/', tag: 'several' });
    // a new minute: one more within it waits for its end
    push.waits([waits('c6', 'question')]);
    expect(await shown()).toHaveLength(2);
    endWindow();
    expect((await shown())[2]).toEqual({ title: 'c6', body: 'Frage an dich', url: '/?card=c6', tag: 'c6' });
    // a quiet minute ends it: the next goes out at once
    endWindow();
    expect(timers).toHaveLength(0);
    push.waits([waits('c7')]);
    expect(await shown()).toHaveLength(4);
  });

  test('the owner back at the machine within the minute: what it collected stays there', async () => {
    const { push, shown, endWindow } = await setup();
    push.waits([waits('c1')]);
    push.waits([waits('c2')]);
    push.here();
    endWindow();
    expect(await shown()).toHaveLength(1);
  });

  test('a subscription its push service no longer knows goes', async () => {
    const { push, store } = await setup({ status: 410 });
    expect(push.subscribed('phone')).toBe(true);
    expect(store.devices()[0]!.push).toBe(true);
    push.waits([waits('c1')]);
    await push.settled();
    expect(push.subscribed('phone')).toBe(false);
    expect(store.devices()[0]!.push).toBeUndefined();
  });

  test('a device unused for 90 days gets nothing, though it is not removed yet', async () => {
    const { push, sent, tick } = await setup();
    tick(UNUSED_MS + 1000);
    expect(push.subscribed('phone')).toBe(false);
    push.waits([waits('c1')]);
    await push.settled();
    expect(sent).toHaveLength(0);
  });

  test('a push stays within what every push service takes, however long the titles', async () => {
    const { push, shown, sent, endWindow } = await setup();
    const long = (card: string): Waits => ({ ...waits(card), title: 'Ä'.repeat(3000) });
    push.waits([long('c1')]);
    push.waits(Array.from({ length: 30 }, (_, i) => long(`c${i + 2}`)));
    endWindow();
    const [one, several] = await shown();
    expect(one.title.length).toBeLessThanOrEqual(160);
    expect(several.title).toBe('30 Karten warten auf dich');
    for (const s of sent) expect(s.body.length).toBeLessThanOrEqual(4096);
  });

  test('a device removed takes its subscription with it', async () => {
    const { push, store } = await setup();
    store.removeDevice('phone');
    expect(push.subscribed('phone')).toBe(false);
  });

  test('no device with notifications: nothing to send', async () => {
    const { push, sent, store, timers } = await setup();
    push.unsubscribe('phone');
    expect(store.devices()[0]!.push).toBeUndefined();
    push.waits([waits('c1')]);
    await push.settled();
    expect(sent).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  test('the VAPID key stays in Obeya’s home, readable by the owner alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'obeya-push-'));
    const store = new Store(':memory:');
    const key = await new Push({ store, home }).key();
    expect(fromB64u(key)).toHaveLength(65);
    expect(await new Push({ store, home }).key()).toBe(key);
    if (process.platform !== 'win32') expect(statSync(join(home, 'vapid.json')).mode & 0o777).toBe(0o600);
  });

  test('a subscription that is none is refused', async () => {
    const { push } = await setup();
    expect(() => push.subscribe('phone', { endpoint: 'http://127.0.0.1/x', keys: { p256dh: 'a', auth: 'b' } })).toThrow();
  });
});
