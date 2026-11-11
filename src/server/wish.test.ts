import { expect, test } from 'bun:test';
import { withLimitWait } from './runtime';
import { FakeRuntime, settle } from './testing';
import { footerOf, writeWish } from './wish';


test('a small job writes the issue in English from the owner’s words; the footer ends the body', async () => {
  const runtime = new FakeRuntime();
  const draft = writeWish(runtime, { said: 'Die Karten sollen sich nach Datum sortieren lassen.' }, 'Obeya 0.3.0 · macOS · app', ['/i/1.png']);
  await settle();
  const s = runtime.last;
  expect(s.spec).toMatchObject({ readOnly: true, role: 'chores' });
  expect(s.spec.system).toContain('in English');
  expect(s.inbox[0]).toContain('“Die Karten sollen sich nach Datum sortieren lassen.”');
  expect(s.inbox[0]).toContain('a screenshot');
  expect(s.images[0]).toEqual(['/i/1.png']);
  s.call('issue', { title: 'Sort cards by date', body: 'Cards should sort by date.' });
  expect(await draft).toEqual({ title: 'Sort cards by date', body: 'Cards should sort by date.\n\nObeya 0.3.0 · macOS · app' });
  expect(s.closed).toBe(true);
});

test('a "can’t" answer is written as a wish; new words rework the draft so far', async () => {
  const runtime = new FakeRuntime();
  void writeWish(runtime, { said: 'sortier nach Datum', answer: 'Das kann ich nicht.' }, 'F');
  await settle();
  expect(runtime.last.inbox[0]).toContain('Obeya answered that it cannot do this: “Das kann ich nicht.”');
  void writeWish(runtime, { said: 'nur auf dem Mac', title: 'Sort cards', body: 'Sort them.\n\nObeya 0.3.0 · macOS · app' }, 'F');
  await settle();
  const brief = runtime.last.inbox[0]!;
  expect(brief).toContain('Title: Sort cards\n\nSort them.');
  expect(brief).not.toContain('Obeya 0.3.0');
  expect(brief).toContain('The user adds: “nur auf dem Mac”');
});

test('without a written issue, the owner’s own words stand in the draft', async () => {
  const runtime = new FakeRuntime();
  const draft = writeWish(runtime, { said: 'Die Leiste soll sich ausblenden lassen' }, 'F');
  await settle();
  runtime.last.emit({ type: 'error', message: 'not logged in' });
  expect(await draft).toEqual({ title: 'Die Leiste soll sich ausblenden lassen', body: 'Die Leiste soll sich ausblenden lassen\n\nF', raw: true });
});

test('stopped by the usage limit, the draft is the owner’s words, and says when the job can write it', async () => {
  const runtime = new FakeRuntime();
  const draft = writeWish(withLimitWait(runtime, 10), { said: 'Die Leiste soll sich ausblenden lassen' }, 'F');
  await settle();
  const resetsAt = Date.now() + 60_000;
  runtime.last.emit({ type: 'error', message: "You've hit your session limit · resets 2:40pm (Europe/Berlin)", limit: { resetsAt } });
  expect(await draft).toEqual({ title: 'Die Leiste soll sich ausblenden lassen', body: 'Die Leiste soll sich ausblenden lassen\n\nF', raw: true, limitedUntil: new Date(resetsAt + 10).toISOString() });
  expect(runtime.last.closed).toBe(true);
});

test('the footer says how this Obeya runs', () => {
  expect(footerOf('0.3.0', 'abcdef1234', false)).toMatch(/^Obeya 0\.3\.0 · \S+ · checkout abcdef1$/);
  expect(footerOf('0.3.0', null, true)).toEndWith(' · app');
  expect(footerOf('0.3.0', null, false)).toEndWith(' · binary');
});
