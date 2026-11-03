import { beforeEach, expect, test } from 'bun:test';
import { api } from './api';
import { closeWish, keepWish, openWish, wishNow } from './wish';

const m = new Map<string, string>();
const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
const KEY = 'obeya-wish-shop';
(globalThis as { window?: object }).window ??= {};

const calls: Parameters<typeof api.writeWish>[0][] = [];
api.writeWish = async (w) => {
  calls.push(w);
  return { title: `Issue: ${w.said}`, body: `${w.said}\n\nObeya 0.4.0 · macOS · app` };
};
const written = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  closeWish();
});

const misaligned = { said: 'Die Zeile „Wunsch oder Fehler melden“ ist nicht horizontal ausgerichtet.' };

test('a draft with only a title gives way to the wish Obeya drafted, which is written from its words alone', async () => {
  // the draft the page kept, back after a reload
  m.set(KEY, JSON.stringify({ title: 'Archive filter loses focus', body: '', images: [] }));
  keepWish(store, 'shop');
  openWish(misaligned);
  expect(wishNow().pending).toBeUndefined();
  await written();
  expect(calls).toEqual([{ said: misaligned.said, app: false }]);
  expect(wishNow().issue).toMatchObject({ title: `Issue: ${misaligned.said}`, from: misaligned });
  // its link opens that draft again as it stands, after a reload too
  closeWish();
  openWish(misaligned);
  expect(wishNow()).toMatchObject({ open: true, pending: undefined, writing: false });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(m.get(KEY)!).from).toEqual(misaligned);
});

test('a draft with text or screenshots stays, and the new wish waits for the owner to decide', () => {
  for (const issue of [
    { title: 'Archive filter loses focus', body: 'Typing in the filter loses focus.\n\nObeya 0.4.0 · macOS · app' },
    { title: '', body: 'Obeya 0.4.0 · macOS · app', images: ['shot-1'] },
  ]) {
    wishNow().issue = { images: [], ...issue };
    openWish(misaligned);
    expect(wishNow()).toMatchObject({ open: true, pending: misaligned, issue });
    expect(calls).toHaveLength(0);
  }
});

test("another canvas in the same page brings its own draft of a wish, and closes the dialog", () => {
  wishNow().issue = null;
  openWish({ said: 'x' });
  closeWish();
  m.set('obeya-wish-web', JSON.stringify({ title: 'On the website', body: '', images: [] }));
  const shop = m.get(KEY);
  keepWish(store, 'web');
  expect(wishNow()).toMatchObject({ open: false, issue: { title: 'On the website' } });
  expect(m.get(KEY)).toBe(shop);
  keepWish(store, 'shop');
  expect(wishNow().issue?.title).toBe(shop ? JSON.parse(shop).title : undefined);
});

test('a wish still being written when the page switches canvas goes into the draft of the canvas it was asked on', async () => {
  keepWish(store, 'shop');
  wishNow().issue = null;
  m.delete(KEY);
  m.delete('obeya-wish-web');
  const write = api.writeWish;
  let answer: (v: Awaited<ReturnType<typeof api.writeWish>>) => void = () => {};
  api.writeWish = () => new Promise((r) => (answer = r));
  openWish({ said: 'Late wish' });
  keepWish(store, 'web');
  answer({ title: 'Issue: Late wish', body: 'Late wish' });
  await written();
  expect(wishNow()).toMatchObject({ issue: null, writing: false });
  expect(m.get('obeya-wish-web')).toBeUndefined();
  expect(JSON.parse(m.get(KEY)!).title).toBe('Issue: Late wish');
  keepWish(store, 'shop');
  expect(wishNow().issue?.title).toBe('Issue: Late wish');
  api.writeWish = write;
});
