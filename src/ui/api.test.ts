import { afterEach, expect, test } from 'bun:test';
import type { CanvasInfo, CanvasSnapshot } from '../core/types';
import { api, beforeReload, cardsOn, everyCanvasHeard, handOver, setCanvas, takeHandOver } from './api';

const fetched: string[] = [];
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  fetched.length = 0;
});

test('a call about a card goes to its canvas, though another is in view as it goes out', async () => {
  globalThis.fetch = (async (url: string) => {
    fetched.push(url);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  // the phone view: a card of the website's canvas closes, Obeya's conversation is with the shop's
  cardsOn('website', ['c1']);
  setCanvas('shop');
  await api.act('c1', { action: 'release' });
  await api.command('Das Logo ist zu klein.', { card: 'c1' });
  // a card the page knows no canvas for, and words about nothing: the canvas in view
  await api.act('c2', { action: 'release' });
  await api.command('Neue Karte', null);
  expect(fetched).toEqual(['/api/c/website/cards/c1/act', '/api/c/website/command?card=c1', '/api/c/shop/cards/c2/act', '/api/c/shop/command']);
});

test('the connection to every canvas drops the cards of a canvas that stopped, and with none left the page goes to the start', () => {
  let snapshots: Record<string, CanvasSnapshot> = {};
  const lists: CanvasInfo[][] = [];
  let left = 0;
  const hear = everyCanvasHeard({ snapshots: (f) => void (snapshots = f(snapshots)), usage: () => {}, canvases: (c) => void lists.push(c) }, () => void left++);
  const canvas = (id: string) => ({ id, name: id }) as CanvasInfo;
  const snapshot = { items: [] } as unknown as CanvasSnapshot;
  hear({ type: 'canvases', canvases: [canvas('shop'), canvas('website')] });
  hear({ type: 'snapshot', canvas: 'shop', snapshot });
  hear({ type: 'snapshot', canvas: 'website', snapshot });
  hear({ type: 'canvases', canvases: [canvas('website')] });
  expect(Object.keys(snapshots)).toEqual(['website']);
  expect(left).toBe(0);
  // the last canvas stopped (its repository gone): no empty list for the phone view to show
  hear({ type: 'canvases', canvases: [] });
  expect(left).toBe(1);
  expect(lists.map((l) => l.map((c) => c.id))).toEqual([['shop', 'website'], ['website']]);
});

/** A tab's session storage, as the page has it. */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

test('before the app starts again, the page hands what a reload keeps to the server, and the new page takes it back', async () => {
  const real = globalThis.sessionStorage;
  let handed: unknown = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') handed = JSON.parse(String(init.body));
    return Response.json(init?.method === 'POST' ? { ok: true } : (handed as { entries: unknown }).entries);
  }) as typeof fetch;
  try {
    globalThis.sessionStorage = storage();
    sessionStorage.setItem('obeya-drafts-shop', '{"card:k1":{"text":"half a sentence"}}');
    // what is written down just before a reload goes along
    const off = beforeReload(() => sessionStorage.setItem('obeya-kept-shop', '{"card":"k1"}'));
    await handOver('17');
    off();
    expect(handed).toEqual({ token: '17', entries: [['obeya-drafts-shop', '{"card:k1":{"text":"half a sentence"}}'], ['obeya-kept-shop', '{"card":"k1"}']] });

    // the new shell's webview: an empty tab
    globalThis.sessionStorage = storage();
    await takeHandOver();
    expect(sessionStorage.getItem('obeya-kept-shop')).toBe('{"card":"k1"}');
    expect(sessionStorage.getItem('obeya-drafts-shop')).toBe('{"card:k1":{"text":"half a sentence"}}');
  } finally {
    globalThis.sessionStorage = real;
  }
});
