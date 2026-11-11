import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot } from '../src/core/types';
import { ownerHeaders } from '../src/server/owner';
import { PATIENCE, removeDir } from '../src/server/testing';
import { worked } from '../src/ui/talk';
import { scratchBase } from './common';

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

test('scratch dirs and port claims go under /tmp on macOS and Linux, under the system temp folder on Windows', () => {
  expect(scratchBase('darwin', '/var/folders/xy/T')).toBe('/tmp');
  expect(scratchBase('linux', '/tmp')).toBe('/tmp');
  expect(scratchBase('win32', 'C:\\Users\\dev\\AppData\\Local\\Temp')).toBe('C:\\Users\\dev\\AppData\\Local\\Temp');
});

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
      canvases: ['Website'],
      cards: [
        { key: 'P', project: 'docs/plan/werkzeug.md', x: 520, y: 10 },
        { key: 'W1', workstream: 'W1', state: 'working', statusLine: 'Liest ein' },
        { key: 'A', title: 'Einlesen', x: 500, y: 40, state: 'working', statusLine: 'Tests laufen', createdAgo: '2h' },
        { key: 'B', title: 'Optionen', queue: { behind: ['A'], reason: 'Beide ändern src/config.ts.' }, events: [{ kind: 'state', author: 'obeya', text: 'wartet', ago: '10m' }] },
        { key: 'C', title: 'Frage', state: 'waiting', need: 'question', question: { text: 'Lang oder kurz?', options: ['Lang', 'Kurz'] } },
        { key: 'D', title: 'Folge', from: 'C' },
        { key: 'H', title: 'Entwürfe', state: 'waiting', need: 'demo', summary: 'Zwei Entwürfe.', demo: { kind: 'html', dir: artifact, chapters: [] } },
        { key: 'S', title: 'Startseite', canvas: 'Website', state: 'working' },
        { key: 'T', title: 'Footer', canvas: 'Website', state: 'working', workspace: true },
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
  expect(card('P')).toMatchObject({ kind: 'project', x: 520, y: 10 });
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
  // a card the stage puts on another canvas is there, and staged.json says so
  const { canvasOf } = staged as unknown as { canvasOf: Record<string, string> };
  expect(canvasOf.S).not.toBe(staged.canvas);
  expect(canvasOf.A).toBe(staged.canvas);
  expect(items.some((i) => i.id === staged.cards.S)).toBe(false);
  const website = (await (await fetch(`http://127.0.0.1:${port}/api/c/${canvasOf.S}/canvas`, { headers })).json()) as CanvasSnapshot;
  expect(website.items.find((i) => i.id === staged.cards.S)).toMatchObject({ title: 'Startseite', state: 'working' });
  const db = new Database(join(dir, 'home/obeya.db'), { readonly: true });
  // a card on another canvas with a workspace works in a worktree of that canvas's repository, registered under it
  const space = db.query<{ path: string; canvas_id: string; repo: string | null }, [string]>('SELECT path, canvas_id, repo FROM workspaces WHERE card_id = ?').get(staged.cards.T!)!;
  expect(space).toMatchObject({ canvas_id: canvasOf.T, repo: null });
  expect(canvasOf.T).toBe(canvasOf.S!);
  expect(website.items.find((i) => i.id === staged.cards.T)!.workspace).toBe(space.path);
  const common = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: space.path }).stdout.toString().trim();
  expect(realpathSync(common)).toBe(realpathSync(join(dir, 'repo-2', '.git')));
  const created = db.query<{ created_at: string }, [string]>('SELECT created_at FROM cards WHERE id = ?').get(staged.cards.A!)!.created_at;
  db.close();
  expect(Date.now() - Date.parse(created)).toBeGreaterThan(7000_000);
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
  // words of the text that look like options are the text's, given one by one or as one
  expect(run('--say', String(port), 'A', 'say', 'Ran', 'it', 'with', '--dry', 'first.').stderr.toString()).toBe('');
  expect(run('--say', String(port), 'A', 'say', '--force is gone.').stderr.toString()).toBe('');
  const events = await api<{ kind: string; author: string; text: string }[]>(`/cards/${staged.cards.A}/events`);
  expect(events.filter((e) => e.author === 'worker').map((e) => [e.kind, e.text])).toEqual([
    ['say', 'Reading the parser first.'],
    ['report', 'Writing tests'],
    ['talk', 'Done with the parser.'],
    ['say', 'Ran it with --dry first.'],
    ['say', '--force is gone.'],
  ]);
  expect((await card('A')).statusLine).toBe('Writing tests');
  expect(run('--say', String(port), 'A', 'shout', 'x').stderr.toString()).toContain('usage');
  // the artifact handed over again, its file rewritten in the scratch Obeya's copy, not in the stage's
  const before = (await card('H')).demo!;
  const next = join(tmp, 'index.html');
  writeFileSync(next, '<h1>Second draft</h1>');
  const handed = run('--artifact', String(port), 'H', next, 'The', 'second', 'draft,', 'without', '--force.');
  expect(handed.stderr.toString()).toBe('');
  const after = await card('H');
  expect(after.demo).toMatchObject({ kind: 'html' });
  expect(after.demo!.handover).toBeGreaterThan(before.handover ?? 0);
  expect(after).toMatchObject({ state: 'waiting', need: 'demo' });
  expect(readFileSync(join(dir, 'artifacts/H/index.html'), 'utf8')).toBe('<h1>Second draft</h1>');
  expect(readFileSync(join(artifact, 'index.html'), 'utf8')).toBe('<h1>First draft</h1>');
  const review = (await api<{ kind: string; text: string }[]>(`/cards/${staged.cards.H}/events`)).at(-1)!;
  expect(review).toMatchObject({ kind: 'review', text: 'The second draft, without --force.' });
  // a card on the second canvas: --say reaches it there
  const other = run('--say', String(port), 'S', 'report', 'Drawing the hero');
  expect(other.stderr.toString()).toBe('');
  expect(other.stdout.toString()).toContain('Shown on the card.');
  const on = (JSON.parse(readFileSync(join(dir, 'staged.json'), 'utf8')) as { canvasOf: Record<string, string> }).canvasOf.S;
  const website = (await (await fetch(`http://127.0.0.1:${port}/api/c/${on}/canvas`, { headers })).json()) as CanvasSnapshot;
  expect(website.items.find((i) => i.id === staged.cards.S)!.statusLine).toBe('Drawing the hero');
}, 20_000);

test('without a port, stagings at the same time each pick a free one, and staging afresh takes the same again', async () => {
  const stages = ['one', 'two'].map((n) => {
    const f = join(tmp, `${n}.json`);
    writeFileSync(f, JSON.stringify({ cards: [{ key: 'A', title: n }] }));
    return f;
  });
  const stageAt = async (f: string) => {
    // with the run's temp directory (`test-setup.ts`), which a process started without `env` lacks on Windows
    const p = Bun.spawn([process.execPath, script, f], { stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(err).toBe('');
    return JSON.parse(out) as { url: string; port: number; dir: string; pid: number };
  };
  const [one, two] = await Promise.all(stages.map(stageAt));
  try {
    expect(one!.port).not.toBe(two!.port);
    for (const s of [one!, two!]) {
      expect(s.port).not.toBe(4417);
      expect(s.dir).toBe(join(scratchBase(), `obeya-scratch-${s.port}`));
      expect((await fetch(s.url, { redirect: 'manual' })).status).toBe(200);
    }
    const again = await stageAt(stages[0]!);
    expect(again.port).toBe(one!.port);
    expect(again.pid).not.toBe(one!.pid);
    expect(() => process.kill(one!.pid, 0)).toThrow();
  } finally {
    for (const s of [one!, two!]) Bun.spawnSync([process.execPath, script, '--stop', String(s.port)], { env: process.env });
    for (const s of [one!, two!]) await removeDir(s.dir);
  }
}, 30_000 * PATIENCE);

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

test('a scratch Obeya nothing uses ends by itself, and --login says so', async () => {
  const stage = join(tmp, 'idle.json');
  const idleDir = join(tmp, 'idle');
  writeFileSync(stage, JSON.stringify({ dir: idleDir, cards: [{ key: 'A', title: 'Export' }] }));
  const r = Bun.spawnSync([process.execPath, script, stage], { env: { ...process.env, OBEYA_SCRATCH_IDLE: '2' } });
  expect(r.stderr.toString()).toBe('');
  const staged = JSON.parse(r.stdout.toString()) as { port: number; pid: number; endsItself: boolean };
  expect(staged.endsItself).toBe(true);
  try {
    for (const end = Date.now() + 15_000 * PATIENCE; Date.now() < end; await Bun.sleep(200))
      try {
        process.kill(staged.pid, 0);
      } catch {
        break;
      }
    expect(() => process.kill(staged.pid, 0)).toThrow();
    const login = Bun.spawnSync([process.execPath, script, '--login', String(staged.port), '--dir', idleDir]);
    expect(login.exitCode).toBe(1);
    expect(login.stderr.toString()).toMatch(/it ended by itself \(nothing used it for \d+ seconds\); stage it afresh/);
  } finally {
    Bun.spawnSync([process.execPath, script, '--stop', String(staged.port), '--dir', idleDir]);
  }
}, 30_000 * PATIENCE);

test.skipIf(process.platform === 'win32')('--sweep stops a scratch Obeya of older code once the folder it ran from is gone, and leaves a young one whose folder is there', async () => {
  // servers as such code runs them: `bun src/server/main.ts` on a scratch dir, without OBEYA_SCRATCH
  const server = (name: string) => {
    const from = join(tmp, name);
    mkdirSync(join(from, 'src/server'), { recursive: true });
    writeFileSync(join(from, 'src/server/main.ts'), 'setInterval(() => {}, 1000);');
    return { from, p: spawn(process.execPath, ['src/server/main.ts', '--config', '/tmp/obeya-scratch-49998/canvases.json'], { cwd: from, stdio: 'ignore' }) };
  };
  const gone = server('gone-workspace');
  const kept = server('kept-workspace');
  try {
    await Bun.sleep(300);
    rmSync(gone.from, { recursive: true, force: true });
    const r = Bun.spawnSync([process.execPath, script, '--sweep']);
    expect(r.stderr.toString()).toBe('');
    const ended = await Promise.race([new Promise((done) => (gone.p.exitCode !== null || gone.p.signalCode ? done(true) : gone.p.once('exit', () => done(true)))), Bun.sleep(3000).then(() => false)]);
    expect(ended).toBe(true);
    expect(() => process.kill(kept.p.pid!, 0)).not.toThrow();
  } finally {
    gone.p.kill('SIGKILL');
    kept.p.kill('SIGKILL');
  }
}, 30_000 * PATIENCE);
