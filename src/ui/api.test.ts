import { afterEach, expect, test } from 'bun:test';
import { api, beforeReload, cardsOn, handOver, setCanvas, takeHandOver } from './api';

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
