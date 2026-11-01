import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot } from '../src/core/types';
import { ownerHeaders } from '../src/server/owner';
import { worked } from '../src/ui/talk';

const script = join(import.meta.dir, 'scratch-obeya.ts');
const tmp = mkdtempSync(join(tmpdir(), 'obeya-stage-'));
const free = Bun.serve({ port: 0, fetch: () => new Response() });
const port = free.port!;
free.stop(true);
const dir = join(tmp, 'scratch');

afterAll(() => {
  Bun.spawnSync([process.execPath, script, '--stop', String(port), '--dir', dir]);
  rmSync(tmp, { recursive: true, force: true });
});

const artifact = join(tmp, 'artifact');

test('stages a scratch Obeya with its cards in the states the stage file gives', async () => {
  const stage = join(tmp, 'stage.json');
  mkdirSync(artifact);
  writeFileSync(join(artifact, 'index.html'), '<h1>First draft</h1>');
  writeFileSync(
    stage,
    JSON.stringify({
      port,
      dir,
      plans: { 'docs/plan/werkzeug.md': '# Werkzeug\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Konfiguration.\n' },
      cards: [
        { key: 'P', project: 'docs/plan/werkzeug.md', x: 0, y: 0 },
        { key: 'W1', workstream: 'W1', state: 'working', statusLine: 'Liest ein' },
        { key: 'A', title: 'Einlesen', x: 500, y: 40, state: 'working', statusLine: 'Tests laufen', createdAgo: '2h' },
        { key: 'B', title: 'Optionen', queue: { behind: ['A'], reason: 'Beide ändern src/config.ts.' }, events: [{ kind: 'state', author: 'obeya', text: 'wartet', ago: '10m' }] },
        { key: 'C', title: 'Frage', state: 'waiting', need: 'question', question: { text: 'Lang oder kurz?', options: ['Lang', 'Kurz'] } },
        { key: 'D', title: 'Folge', from: 'C' },
        { key: 'H', title: 'Entwürfe', state: 'waiting', need: 'demo', summary: 'Zwei Entwürfe.', demo: { kind: 'html', dir: artifact, chapters: [] } },
      ],
    }),
  );
  const r = Bun.spawnSync([process.execPath, script, stage]);
  expect(r.stderr.toString()).toBe('');
  const staged = JSON.parse(r.stdout.toString()) as { url: string; canvas: string; cards: Record<string, string> };
  // a link that signs a browser in and opens the canvas
  expect(staged.url).toStartWith(`http://127.0.0.1:${port}/login?token=`);
  const signed = await fetch(staged.url, { redirect: 'manual' });
  expect(await signed.text()).toContain('location.replace("/c/repo")');
  // again, in another browser
  expect((await fetch(staged.url, { redirect: 'manual' })).status).toBe(200);
  // the same from --login
  expect(Bun.spawnSync([process.execPath, script, '--login', String(port), '--dir', dir]).stdout.toString().trim()).toBe(staged.url);
  // the API with the owner's key of its home
  const headers = ownerHeaders(join(dir, 'home'));
  const { items } = (await (await fetch(`http://127.0.0.1:${port}/api/c/${staged.canvas}/canvas`, { headers })).json()) as CanvasSnapshot;
  const card = (key: string) => items.find((i) => i.id === staged.cards[key])!;
  expect(card('P')).toMatchObject({ kind: 'project', x: 0, y: 0 });
  expect(card('W1')).toMatchObject({ label: 'W1', state: 'working', statusLine: 'Liest ein' });
  expect(card('A')).toMatchObject({ title: 'Einlesen', state: 'working', statusLine: 'Tests laufen' });
  expect(card('B').queue).toMatchObject({ behind: [staged.cards.A], reason: 'Beide ändern src/config.ts.' });
  expect(card('C')).toMatchObject({ state: 'waiting', need: 'question', question: { text: 'Lang oder kurz?', options: ['Lang', 'Kurz'] } });
  // cards at work or waiting have the branch their start gave them: only then does the card show the
  // conversation with the question and the field to answer it, on the canvas and on the phone
  expect(card('C').branch).toBe(`obeya/frage-${staged.cards.C!.slice(0, 6)}`);
  expect(card('W1').branch).toStartWith('obeya/konfiguration-');
  for (const key of ['A', 'C', 'H', 'W1']) expect(worked(card(key))).toBe(true);
  expect(card('B').branch).toBeUndefined();
  expect(card('D').from).toBe(staged.cards.C!);
  const created = Bun.spawnSync(['sqlite3', join(dir, 'home/obeya.db'), `SELECT created_at FROM cards WHERE id = '${staged.cards.A}'`]).stdout.toString();
  expect(Date.now() - Date.parse(created.trim())).toBeGreaterThan(7000_000);
  const events = (await (await fetch(`http://127.0.0.1:${port}/api/c/${staged.canvas}/cards/${staged.cards.B}/events`, { headers })).json()) as { text: string }[];
  expect(events.map((e) => e.text)).toContain('wartet');
}, 20_000);

test("--say and --artifact act as a staged card's agent, through the server", async () => {
  const staged = JSON.parse(readFileSync(join(dir, 'staged.json'), 'utf8')) as { canvas: string; cards: Record<string, string> };
  const headers = ownerHeaders(join(dir, 'home'));
  const api = async <T,>(path: string) => (await (await fetch(`http://127.0.0.1:${port}/api/c/${staged.canvas}${path}`, { headers })).json()) as T;
  const card = async (key: string) => (await api<CanvasSnapshot>('/canvas')).items.find((i) => i.id === staged.cards[key])!;
  const run = (...a: string[]) => Bun.spawnSync([process.execPath, script, ...a, '--dir', dir]);
  const say = run('--say', String(port), 'A', 'say', 'Reading the parser first.');
  expect(say.stderr.toString()).toBe('');
  expect(run('--say', String(port), 'A', 'report', 'Writing tests').stdout.toString()).toContain('Shown on the card.');
  expect(run('--say', String(port), 'A', 'talk', 'Done with the parser.').stdout.toString()).toContain('Shown to the owner.');
  const events = await api<{ kind: string; author: string; text: string }[]>(`/cards/${staged.cards.A}/events`);
  expect(events.filter((e) => e.author === 'worker').map((e) => [e.kind, e.text])).toEqual([
    ['say', 'Reading the parser first.'],
    ['report', 'Writing tests'],
    ['talk', 'Done with the parser.'],
  ]);
  expect((await card('A')).statusLine).toBe('Writing tests');
  expect(run('--say', String(port), 'A', 'shout', 'x').stderr.toString()).toContain('usage');
  // the artifact handed over again, its file rewritten in the scratch Obeya's copy, not in the stage's
  const before = (await card('H')).demo!;
  const next = join(tmp, 'index.html');
  writeFileSync(next, '<h1>Second draft</h1>');
  const handed = run('--artifact', String(port), 'H', next, 'The second draft.');
  expect(handed.stderr.toString()).toBe('');
  const after = await card('H');
  expect(after.demo).toMatchObject({ kind: 'html' });
  expect(after.demo!.handover).toBeGreaterThan(before.handover ?? 0);
  expect(after).toMatchObject({ state: 'waiting', need: 'demo' });
  expect(readFileSync(join(dir, 'artifacts/H/index.html'), 'utf8')).toBe('<h1>Second draft</h1>');
  expect(readFileSync(join(artifact, 'index.html'), 'utf8')).toBe('<h1>First draft</h1>');
  const review = (await api<{ kind: string; text: string }[]>(`/cards/${staged.cards.H}/events`)).at(-1)!;
  expect(review).toMatchObject({ kind: 'review', text: 'The second draft.' });
}, 20_000);

test('without a port, stagings at the same time each pick a free one, and staging afresh takes the same again', async () => {
  const stages = ['one', 'two'].map((n) => {
    const f = join(tmp, `${n}.json`);
    writeFileSync(f, JSON.stringify({ cards: [{ key: 'A', title: n }] }));
    return f;
  });
  const stageAt = async (f: string) => {
    const p = Bun.spawn([process.execPath, script, f], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(err).toBe('');
    return JSON.parse(out) as { url: string; port: number; dir: string; pid: number };
  };
  const [one, two] = await Promise.all(stages.map(stageAt));
  try {
    expect(one!.port).not.toBe(two!.port);
    for (const s of [one!, two!]) {
      expect(s.port).not.toBe(4417);
      expect(s.dir).toBe(`/tmp/obeya-scratch-${s.port}`);
      expect((await fetch(s.url, { redirect: 'manual' })).status).toBe(200);
    }
    const again = await stageAt(stages[0]!);
    expect(again.port).toBe(one!.port);
    expect(again.pid).not.toBe(one!.pid);
    expect(() => process.kill(one!.pid, 0)).toThrow();
  } finally {
    for (const s of [one!, two!]) Bun.spawnSync([process.execPath, script, '--stop', String(s.port)]);
    for (const s of [one!, two!]) rmSync(s.dir, { recursive: true, force: true });
  }
}, 30_000);

test('--stop ends the server it staged, but not another process that has its number by now', async () => {
  const staged = JSON.parse(readFileSync(join(dir, 'staged.json'), 'utf8')) as { pid: number };
  const stopped = Bun.spawnSync([process.execPath, script, '--stop', String(port), '--dir', dir]);
  expect(stopped.stderr.toString()).toBe('');
  expect(stopped.exitCode).toBe(0);
  expect(() => process.kill(staged.pid, 0)).toThrow();
  // a server.pid from before a reboot, its number now another program's that leads a process group of its own
  const stale = join(tmp, 'stale');
  mkdirSync(stale);
  const hourAgo = new Date(Date.now() - 3600_000);
  const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  try {
    writeFileSync(join(stale, 'server.pid'), String(other.pid));
    utimesSync(join(stale, 'server.pid'), hourAgo, hourAgo);
    const r = Bun.spawnSync([process.execPath, script, '--stop', '4999', '--dir', stale]);
    expect(r.stderr.toString()).toBe('');
    expect(r.exitCode).toBe(0);
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
  } finally {
    other.kill('SIGKILL');
  }
}, 20_000);
