import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TagProposalJob } from '../core/types';
import { CanvasRuntime } from './canvas';
import { Config } from './config';
import { Store } from './db';
import { serve } from './server';
import { asOwner, FakeRuntime, gitRepo, noForge, until } from './testing';

let dir: string;
let repo: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let server: ReturnType<typeof serve>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-tags-'));
  repo = gitRepo(join(dir, 'shop'), { 'README.md': 'A shop with a cart and invoices.\n' });
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  const file = join(dir, 'canvases.json');
  writeFileSync(file, JSON.stringify([{ repos: [{ path: repo }] }]));
  const config = new Config({
    file,
    source: 'file',
    started: [{ repos: [{ path: repo }] }],
    store,
    running: () => ['shop'],
    server: { port: 4417, home: dir, permissionMode: 'auto' },
    restart: () => {},
    apply: () => {},
  });
  canvas = new CanvasRuntime({ repos: [{ path: repo }] }, { store, home: dir, runtime, forge: noForge, config });
  server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, config);
  // a finished card with its demo, archived; an open one; a Question card, which is no change
  const c = canvas.board.canvas.id;
  const [done] = store.insert([
    { canvas_id: c, kind: 'task', state: 'live', title: 'Invoices as PDF', body: 'Customers download their invoice.', x: 0, y: 0 },
    { canvas_id: c, kind: 'task', state: 'working', title: 'Coupons in the cart', body: 'A coupon code field in the cart.', x: 400, y: 0 },
    { canvas_id: c, kind: 'question', state: 'done', title: 'How many orders last week?', body: '', x: 800, y: 0 },
  ]);
  const demo = join(dir, 'demos', done!.id);
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, 'demo.mp4'), 'video');
  store.update(done!.id, {
    demo: JSON.stringify({ dir: demo, kind: 'video', chapters: [[0, 'Download']], page: { title: 'Invoices to download', text: 'Customers get their invoice as a PDF from the order page.' } }),
    archived_at: new Date().toISOString(),
  });
  canvas.board.changed();
});

afterEach(() => {
  server.stop(true);
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const { fetch } = asOwner(() => server);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(new URL(path, server.url), { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  return { status: res.status, body: (await res.json()) as { job: TagProposalJob | null; available?: boolean } };
};
const at = (path: string) => `/api/tag-proposal?path=${encodeURIComponent(path)}`;
const proposer = () => runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'tags'))!;

describe('a proposal for the tags of a site', () => {
  test('reads the repository and its cards, finished and open, archived ones too, with their demos, and its proposal goes to the dialog', async () => {
    expect((await call('GET', at(repo))).body).toEqual({ job: null, available: true });
    expect((await call('GET', at(join(dir, 'elsewhere')))).body.available).toBe(false);

    const started = await call('POST', '/api/tag-proposal', { path: repo, current: { Area: ['Cart'] }, language: 'en' });
    expect(started.body.job).toEqual({ running: true });
    await until(() => proposer());
    const s = proposer();
    expect(s.spec.readOnly).toBe(true);
    expect(s.spec.cwd).toBe(repo);
    const brief = s.inbox[0]!;
    expect(brief).toContain('Area: Cart');
    expect(brief).toContain('[done] Invoices as PDF');
    expect(brief).toContain('Demo: Invoices to download: Customers get their invoice as a PDF');
    expect(brief).toContain('[open] Coupons in the cart');
    expect(brief).not.toContain('How many orders');
    expect(s.spec.system).toContain('in English');

    // a dimension without values is no proposal; colons and commas would break the field's lines
    expect(await s.call('tags', { tags: { Area: [] }, why: '' })).toContain('again');
    await s.call('tags', { tags: { 'Area: of the app': ['Cart', 'Invoices, PDF', ' '], Audience: ['Customers'] }, why: 'The cards change the cart and the invoices.' });
    await until(async () => !(await call('GET', at(repo))).body.job?.running);
    expect((await call('GET', at(repo))).body.job).toEqual({
      running: false,
      tags: { 'Area  of the app': ['Cart', 'Invoices  PDF'], Audience: ['Customers'] },
      why: 'The cards change the cart and the invoices.',
    });

    // taken into the field, it goes
    await call('DELETE', at(repo));
    expect((await call('GET', at(repo))).body.job).toBeNull();
  });

  test('a session that ends without one leaves an error, and a repository on no canvas is refused', async () => {
    await call('POST', '/api/tag-proposal', { path: repo });
    await until(() => proposer());
    proposer().emit({ type: 'idle' });
    await until(async () => !(await call('GET', at(repo))).body.job?.running);
    expect((await call('GET', at(repo))).body.job).toEqual({ running: false, error: 'the agent proposed nothing' });
    expect((await call('POST', '/api/tag-proposal', { path: join(dir, 'elsewhere') })).status).toBe(400);
  });
});
