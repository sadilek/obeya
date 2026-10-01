import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasConfig, ConfigView } from '../core/types';
import { CanvasRuntime } from './canvas';
import { Config, readConfigFile } from './config';
import { Store } from './db';
import { serve } from './server';
import { FakeRuntime } from './testing';
import { git } from './workspaces';

let dir: string;
let store: Store;
let web: string;
let api: string;
let file: string;
let restarts: number;

function repo(name: string) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', path]);
  git(path, 'config', 'user.email', 't@example.com');
  git(path, 'config', 'user.name', 'T');
  writeFileSync(join(path, 'README.md'), 'hello\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'init');
  return path;
}

const config = (source: 'file' | 'args', started: CanvasConfig[], running: string[] = []) =>
  new Config({
    file,
    source,
    started,
    store,
    running: () => running,
    server: { port: 4417, home: dir, permissionMode: 'auto' },
    restart: () => void restarts++,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-config-'));
  store = new Store(':memory:');
  web = repo('web');
  api = repo('api');
  file = join(dir, 'home', 'canvases.json');
  restarts = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Obeya's configuration", () => {
  test('says what each canvas amounts to: its id, name, repositories and their adapters', () => {
    const c = config('args', [{ name: 'Produkt', repos: [{ path: web }, { path: api, adapter: 'obeya' }] }], ['produkt']);
    const v = c.view();
    expect(v).toMatchObject({ file, source: 'args', running: ['produkt'], problems: [], restarting: false, server: { port: 4417, restarts: true } });
    expect(v.adapters).toContain('acme');
    expect(v.resolved).toEqual([
      {
        id: 'produkt',
        name: 'Produkt',
        repos: [
          { id: 'web', adapter: 'generic', workspaces: 'clones' },
          { id: 'api', adapter: 'obeya', workspaces: 'worktrees' },
        ],
      },
    ]);
  });

  test('finds what keeps a configuration from working, by canvas and repository', () => {
    const c = config('file', []);
    const { problems } = c.check([
      { name: 'A', repos: [{ path: web }, { path: join(dir, 'nowhere') }] },
      { name: 'B', repos: [{ path: api, adapter: 'nope', workspaces: [join(dir, 'nowhere')] }] },
      { name: 'Leer', repos: [] },
    ]);
    expect(problems.map(({ code, canvas, repo }) => ({ code, canvas, repo }))).toEqual([
      { code: 'notRepo', canvas: 0, repo: 1 },
      { code: 'notClone', canvas: 1, repo: 0 },
      { code: 'unknownAdapter', canvas: 1, repo: 0 },
      { code: 'noRepo', canvas: 2, repo: undefined },
    ]);
    // the id follows the name, unless it is kept
    expect(c.check([{ name: 'Neuer Name', id: 'web', repos: [{ path: web }] }]).resolved[0]).toMatchObject({ id: 'web', name: 'Neuer Name' });
    expect(c.check([{ name: 'Web', repos: [{ path: web }] }, { name: 'web', repos: [{ path: api }] }]).problems).toMatchObject([{ code: 'sameId', canvas: 1 }]);
    expect(c.check([]).problems.map((p) => p.code)).toEqual(['noCanvas']);
    expect(c.check([{ repos: [{ path: web, color: 'red' }] }]).problems.map((p) => p.code)).toEqual(['invalid']);
    expect(c.check({}).problems.map((p) => p.code)).toEqual(['invalid']);
  });

  test("keeps a canvas's home repository: leaving it out is a problem, moving it is not", () => {
    store.ensureCanvas('produkt', 'Produkt');
    store.setSetting('produkt', 'home_repo', 'web');
    const c = config('file', []);
    expect(c.check([{ name: 'Produkt', repos: [{ path: api }] }]).problems.map((p) => p.code)).toEqual(['homeMissing']);
    const moved = c.check([{ name: 'Produkt', repos: [{ path: api }, { path: web }] }]);
    expect(moved.problems).toEqual([]);
    // listed in the order given, though the home one runs first
    expect(moved.resolved[0]!.repos.map((r) => r.id)).toEqual(['api', 'web']);
  });

  test('saves a configuration that works, tidied, and starts Obeya again; one with problems is refused', () => {
    const c = config('args', [{ repos: [{ path: web }] }]);
    expect(() => c.save([{ repos: [{ path: join(dir, 'nowhere') }] }])).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(restarts).toBe(0);

    expect(c.save([{ name: ' ', repos: [{ path: web, adapter: '', workspaces: [' '], clones: 0 }, { path: api, clones: 2 }] }])).toEqual({ restarting: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(restarts).toBe(1);
    expect(c.view().restarting).toBe(true);
    // saved again before the restart: the file has the latest, and the restart is already on its way
    c.save([{ repos: [{ path: api }] }]);
    expect(restarts).toBe(1);
  });

  test('shows the file when Obeya runs from it, the command line until something is saved', () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ name: 'Aus Datei', repos: [{ path: web }] }]));
    expect(config('file', []).view().canvases).toEqual([{ name: 'Aus Datei', repos: [{ path: web }] }]);
    expect(config('args', [{ repos: [{ path: api }] }]).view().canvases).toEqual([{ repos: [{ path: api }] }]);
  });

  test('expands ~ in paths', () => {
    const home = process.env.HOME!;
    if (!web.startsWith(`${home}/`)) return;
    expect(config('file', []).check([{ repos: [{ path: `~${web.slice(home.length)}` }] }]).problems).toEqual([]);
  });
});

describe('the configuration over HTTP', () => {
  let server: ReturnType<typeof serve>;
  let canvas: CanvasRuntime;
  beforeEach(() => {
    const c = config('args', [{ repos: [{ path: web }] }], ['web']);
    canvas = new CanvasRuntime({ repos: [{ path: web }] }, { store, home: dir, runtime: new FakeRuntime(), forge: { status: () => ({}) as never }, config: c });
    server = serve([canvas], { transcriber: { transcribe: async () => '' }, speaker: { speak: async () => null } }, 0, false, c);
  });
  afterEach(() => {
    server.stop(true);
    canvas.shutdown();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url), { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('reads, checks and saves it', async () => {
    const view = (await call('GET', '/api/config')).body as unknown as ConfigView;
    expect(view.canvases).toEqual([{ repos: [{ path: web }] }]);
    expect(view.running).toEqual(['web']);

    const checked = await call('POST', '/api/config/check', [{ name: 'Zwei', repos: [{ path: web }, { path: join(dir, 'nowhere') }] }]);
    expect(checked.body.problems).toMatchObject([{ code: 'notRepo', canvas: 0, repo: 1 }]);

    const refused = await call('PUT', '/api/config', [{ repos: [{ path: join(dir, 'nowhere') }] }]);
    expect(refused).toMatchObject({ status: 400, body: { code: 'config' } });

    expect((await call('PUT', '/api/config', [{ repos: [{ path: web }, { path: api }] }])).body).toEqual({ restarting: true });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api }] }]);
  });

  test('a configuration command of the Koordinator saves it after the undo window', () => {
    canvas.run({ do: 'configure', canvases: [{ name: 'Neu', repos: [{ path: web }] }] });
    expect(readConfigFile(file)).toEqual([{ name: 'Neu', repos: [{ path: web }] }]);
    expect(restarts).toBe(1);
  });
});
