import { afterAll, expect, test } from 'bun:test';
import { waitUp } from './wait-up';

// a server that answers 503 until `readyAt`, like one whose port is open before it is ready
let readyAt = Infinity;
const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: Date.now() >= readyAt ? 200 : 503 }) });
const url = `http://127.0.0.1:${server.port}/`;
afterAll(() => server.stop(true));

test('waits while the process lives until the server answers', async () => {
  readyAt = Date.now() + 800;
  let slow = 0;
  expect(await waitUp(url, { exited: () => null, limit: 5000, slowAfter: 300, onSlow: () => slow++ })).toEqual({ up: true });
  expect(Date.now()).toBeGreaterThanOrEqual(readyAt);
  expect(slow).toBe(1);
});

test('gives up at once when the process exits', async () => {
  readyAt = Infinity;
  const start = Date.now();
  const r = await waitUp(url, { exited: () => 3, limit: 60_000 });
  expect(r).toMatchObject({ up: false, exit: 3 });
  expect(Date.now() - start).toBeLessThan(1000);
});

test('gives up after the limit and says how long it waited', async () => {
  readyAt = Infinity;
  const r = await waitUp(url, { exited: () => null, limit: 600 });
  expect(r).toMatchObject({ up: false, exit: null });
  expect(r.up || r.waited).toBeGreaterThanOrEqual(600);
});
