import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoInfo } from '../server/repo';
import { gitRepo } from '../server/testing';
import { git } from '../server/workspaces';
import { layerSettings, type RepoSettings } from '../core/types';
import { defaultsFor, hasAdapterModule, parseShared, readShared, repoValues, withSettings } from '.';
import { generic } from './generic';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-adapters-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('defaultsFor', () => {
  test("Obeya's own repository brings its settings like any other, with no problems in them", () => {
    const root = join(import.meta.dir, '../..');
    const read = parseShared(readFileSync(join(root, '.obeya/settings.json'), 'utf8'));
    expect(read.problems).toEqual([]);
    expect(read.settings).toMatchObject({ land: 'main', workspaces: 'worktrees', checks: ['bun test --parallel', 'bun run typecheck'] });
  });

  test('lands through pull requests where origin is on GitHub, else on the main branch', () => {
    const repo = gitRepo(join(dir, 'shop'));
    const land = () => defaultsFor(repoInfo(repo)).land;
    expect(land()).toBe('main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    expect(land()).toBe('pr');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/shop.git');
    expect(land()).toBe('main');
    // a GitHub Enterprise host the GitHub CLI is logged into
    const gh = join(dir, 'gh');
    mkdirSync(gh);
    writeFileSync(join(gh, 'hosts.yml'), 'github.acme.com:\n    user: t\n    git_protocol: https\n');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.acme.com/acme/shop.git');
    const was = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = gh;
    try {
      expect(land()).toBe('pr');
    } finally {
      if (was === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = was;
    }
  });
});

describe('withSettings', () => {
  test("reads the settings whenever a field is asked for; clones or worktrees once", () => {
    let s: RepoSettings | undefined = { land: 'main', workspaces: 'clones' };
    const a = withSettings({ ...generic, checks: ['bun test'] }, () => s);
    expect([a.land, a.checks, a.workspaces]).toEqual(['main', ['bun test'], 'clones']);
    s = { checks: [], workspaces: 'worktrees' };
    expect([a.land, a.checks, a.workspaces]).toEqual(['pr', [], 'clones']);
    // the defaults say nothing about the app or the demo site
    expect([a.app, a.demo]).toEqual([undefined, undefined]);
    s = { app: { run: 'Start it with `bun dev`.' } };
    expect(a.app).toEqual({ run: 'Start it with `bun dev`.' });
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'git {dir}' };
    s = { demo: { site } };
    expect(a.demo).toEqual({ site });
    // the configuration's clones go before the setting
    expect(withSettings(generic, () => ({ workspaces: 'worktrees' }), true).workspaces).toBe('clones');
  });

  test("the app's fields each come from where they are set", () => {
    const shared: RepoSettings = { app: { run: 'Start it with `docker compose up -d`.', stop: 'docker compose down' } };
    const a = withSettings(generic, () => layerSettings<RepoSettings>(shared, { app: { stop: './stop.sh' } }));
    expect(a.app).toEqual({ run: 'Start it with `docker compose up -d`.', stop: './stop.sh' });
  });
});

describe('.obeya/settings.json', () => {
  test('is read from the default branch, not the checkout; a field that is wrong does not count, the rest does', () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/settings.json': '{ "land": "main", "checks": ["bun test"] }\n' });
    // with the tree of .obeya/ there, which the repository's theme is read from (theme.ts)
    expect(readShared(repo)).toEqual({ settings: { land: 'main', checks: ['bun test'] }, raw: { land: 'main', checks: ['bun test'] }, problems: [], obeyaTree: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    // the checkout's own change counts once it is committed on the default branch
    writeFileSync(join(repo, '.obeya/settings.json'), '{ "land": "pr" }\n');
    expect(readShared(repo).settings).toEqual({ land: 'main', checks: ['bun test'] });
    expect(readShared(gitRepo(join(dir, 'plain'))).settings).toBeUndefined();

    const read = parseShared('{ "check": ["x"], "land": "sideways", "branch": "develop", "setup": "bun install", "app": { "run": "bun dev" } }');
    expect(read.settings).toEqual({ setup: 'bun install', app: { run: 'bun dev' } });
    expect(read.problems).toEqual([
      '.obeya/settings.json, land: expected one of "main"|"pr"',
      '.obeya/settings.json, check: no such field (did you mean checks?)',
      '.obeya/settings.json, branch: the main branch is set on each machine (or detected), not in the repository',
    ]);
    expect(parseShared('{ land: main }').problems[0]).toStartWith('.obeya/settings.json is no JSON');
    expect(parseShared('[]').problems).toEqual(['.obeya/settings.json holds no JSON object']);
  });

  test('holds the app, the demo site and language; a field misspelt in them is named and the whole field does not count', () => {
    const app = { run: 'Start it with `bun dev`; the URL is in `.env` under URL.', stop: 'pkill -F .pid', keep: 'test -f .keep' };
    const site = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'bunx wrangler pages deploy {dir}', env: 'sites/demos.env', headers: { 'X-Key': '${KEY}' } };
    expect(parseShared(JSON.stringify({ app, demo: { site, language: 'en' } }))).toMatchObject({ settings: { app, demo: { site, language: 'en' } }, problems: [] });
    expect(parseShared(JSON.stringify({ demo: { language: 'fr' } })).settings).toEqual({});
    // the language of what lands in the repository stands beside that of its demos
    expect(parseShared(JSON.stringify({ language: 'de', demo: { language: 'en' } })).settings).toEqual({ language: 'de', demo: { language: 'en' } });
    expect(parseShared(JSON.stringify({ language: 'fr' })).problems).toHaveLength(1);
    // the site's language from before demo.language goes alone: the site stays
    const old = parseShared(JSON.stringify({ demo: { site: { ...site, language: 'de' } } }));
    expect(old.settings).toEqual({ demo: { site } });
    expect(old.problems).toEqual(['.obeya/settings.json, demo.site.language: no longer read; demo.language names the language of the demos and of the overview']);
    const read = parseShared(JSON.stringify({ app: { ...app, stp: 'x' }, demo: { site, howToRun: 'bun dev' }, stack: { start: 'bun dev' } }));
    expect(read.settings).toEqual({});
    expect(read.problems).toEqual([
      '.obeya/settings.json, app.stp: no such field (did you mean stop?)',
      '.obeya/settings.json, demo.howToRun: no such field',
      '.obeya/settings.json, stack: no such field',
    ]);
  });

  test("its values come after this machine's and before the defaults, and say they come from the repository", () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n' });
    const shared = { checks: ['bun test'], setup: 'bun install', app: { run: 'bun dev', stop: 'pkill -F .pid' } };
    const mine: RepoSettings = { setup: '', app: { run: 'bun dev --port 4000' } };
    const a = withSettings(defaultsFor(repoInfo(repo)), () => layerSettings<RepoSettings>(shared, mine));
    expect([a.checks, a.setup, a.land, a.app]).toEqual([['bun test'], '', 'main', { run: 'bun dev --port 4000', stop: 'pkill -F .pid' }]);
    expect(repoValues(repoInfo(repo), false, shared)).toMatchObject({
      checks: { value: ['bun test'], source: 'repository' },
      setup: { value: 'bun install', source: 'repository' },
      land: { value: 'main', source: 'detected' },
      planDocs: { value: { dir: 'docs/plan' }, source: 'default' },
      app: { run: { value: 'bun dev', source: 'repository' }, stop: { value: 'pkill -F .pid', source: 'repository' }, keep: { value: '', source: 'default' } },
      language: { value: 'en', source: 'default' },
      demo: { site: { value: null, source: 'default' }, language: { value: null, source: 'default' } },
    });
    // a repository that names German for what lands in it
    expect(withSettings(defaultsFor(repoInfo(repo)), () => ({ language: 'de' })).language).toBe('de');
    expect(repoValues(repoInfo(repo), false, { language: 'de' }).language).toEqual({ value: 'de', source: 'repository' });
  });
});

describe('hasAdapterModule', () => {
  test('finds an adapter module from before on the default branch, not in the checkout', () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/adapter/index.ts': "export default { name: 'shop' };\n" });
    expect(hasAdapterModule(repo)).toBe(true);
    git(repo, 'checkout', '--quiet', '-b', 'card');
    git(repo, 'rm', '--quiet', '-r', '.obeya');
    git(repo, 'commit', '--quiet', '-m', 'no module on this branch');
    expect(hasAdapterModule(repo)).toBe(true);
    git(repo, 'checkout', '--quiet', 'main');
    git(repo, 'merge', '--quiet', 'card');
    expect(hasAdapterModule(repo)).toBe(false);
    expect(hasAdapterModule(gitRepo(join(dir, 'plain')))).toBe(false);
  });
});

describe("a repository's Claude Code configuration", () => {
  test('is every file under .claude/ and .mcp.json on the default branch, each told apart to the byte; a submodule by its commit', () => {
    const repo = gitRepo(join(dir, 'claude'), { 'README.md': 'x\n', '.claude/skills/probe/SKILL.md': 'hooks\n', '.mcp.json': '{}\n', 'src/a.ts': '\n' });
    const before = readShared(repo).claude!;
    expect(Object.keys(before)).toEqual(['.claude/skills/probe/SKILL.md', '.mcp.json']);
    expect(before['.mcp.json']!.text).toBe('{}');
    // a blank line before the frontmatter is what decides whether a skill's hook runs
    writeFileSync(join(repo, '.claude/skills/probe/SKILL.md'), '\nhooks\n');
    git(repo, 'commit', '--quiet', '-am', 'blank line');
    expect(readShared(repo).claude!['.claude/skills/probe/SKILL.md']!.id).not.toBe(before['.claude/skills/probe/SKILL.md']!.id);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},.claude/skills/other`);
    git(repo, 'commit', '--quiet', '-m', 'submodule');
    expect(readShared(repo).claude!['.claude/skills/other']).toEqual({ id: head, text: `(commit ${head})` });
  });
});
