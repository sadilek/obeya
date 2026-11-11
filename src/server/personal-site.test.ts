import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MESSAGES } from '../core/messages';
import type { Board } from './board';
import { Store } from './db';
import { allowedHere, allowPrivate, approvedHere, connect, connectionCode, newToken, type PersonalSite, readPersonal, shareApproved, writePersonal } from './personal-site';
import type { SharePage, ShareSource } from './share';
import { Sharing } from './share';
import { MANIFEST, siteKey, siteTarget } from './site';
import { cloudflareAccounts, type Exec, exec, githubPagesDeploy, setupCloudflare, setupGithub, SetupRefused } from './site-hosts';
import { SiteSetup } from './site-setup';
import { CanvasRuntime } from './canvas';
import { FakeRuntime, gitRepo, identify, noForge, removeDir, testBoard, until } from './testing';

let dir: string;
let home: string;
let repo: string;
let demo: string;

// the deploy line's stand-in: copies the site's directory to `deployed/`, the host's snapshot
const DEPLOY = `
const { cpSync, rmSync } = require('node:fs');
const [site, out] = process.argv.slice(2);
rmSync(out + '/deployed', { recursive: true, force: true });
cpSync(site, out + '/deployed', { recursive: true });
`;

// the host: serves what was deployed last, `404.html` for what it lacks (as Cloudflare and GitHub Pages do)
const server = Bun.serve({
  port: 0,
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(dir, 'deployed', path);
    if (!path.includes('..') && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    const missing = join(dir, 'deployed', '404.html');
    return new Response(existsSync(missing) ? Bun.file(missing) : 'not found', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const URL_ = `http://localhost:${server.port}/`;

const personal = (extra: Partial<PersonalSite> = {}): PersonalSite => ({ host: 'cloudflare', url: URL_, project: 'obeya-ada', secret: 's3cr3tdirectory000000000', ...extra });
/** The personal site as a target, deploying with the stand-in in place of wrangler. */
const unlisted = (at = home, machine = 'a') =>
  siteTarget({ title: 'Demos', url: URL_, deploy: `deploy.ts {dir} ${dir}` }, repo, at, MESSAGES.en.share, { machine, checkWaits: [0, 10, 10], by: 'Ada Lovelace', unlisted: { secret: personal().secret! } });
const siteDir = (at = home) => join(at, 'sites', siteKey(URL_), 'site');
const deployed = () => join(dir, 'deployed');
const page = (slug: string, extra: Partial<SharePage> = {}): SharePage => ({ slug, title: `Title ${slug}`, text: 'One sentence.', kind: 'video', chapters: [[0, 'Before']], pr: null, language: 'en', dir: demo, shared: [], ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-personal-'));
  home = join(dir, 'home');
  repo = join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(join(repo, 'deploy.ts'), DEPLOY);
  demo = join(dir, 'demo');
  mkdirSync(demo);
  writeFileSync(join(demo, 'demo.mp4'), 'video');
  writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n');
});
afterEach(() => removeDir(dir));

const A = 'k7f3q9w2m4xa8b1c';
const B = 'z9y8x7w6v5u4t3s2';

describe('an unlisted site', () => {
  test('gives away no list of its pages: not at its root, its 404 page, a manifest at the root, a feed or a sitemap', async () => {
    expect(await unlisted().publish(page(`${A}/sync-button`))).toMatchObject({ url: `${URL_}${A}/sync-button/` });
    expect(await unlisted().publish(page(`${B}/csv-export`, { shared: [`${A}/sync-button`] }))).toMatchObject({ url: `${URL_}${B}/csv-export/` });
    const files = readdirSync(deployed()).sort();
    expect(files).toEqual(['404.html', '_headers', A, B, 's3cr3tdirectory000000000', 'index.html'].sort());
    for (const f of ['index.html', '404.html', '_headers']) {
      const text = readFileSync(join(deployed(), f), 'utf8');
      for (const leak of [A, B, 'sync-button', 'csv-export', 'Title', 's3cr3t']) expect(text).not.toContain(leak);
    }
    // the host's answers: nothing at the root, nothing one level up from a page, no manifest, feed, sitemap or robots.txt where a listed site has them
    const get = async (path: string) => {
      const r = await fetch(`${URL_}${path}`);
      return { status: r.status, text: await r.text() };
    };
    for (const path of ['', `${A}/`, MANIFEST, 'feed.xml', 'sitemap.xml', 'robots.txt', 'nothing/']) {
      const r = await get(path);
      for (const leak of [A, B, 'sync-button', 'csv-export']) expect(r.text).not.toContain(leak);
      if (path) expect(r.status).toBe(404);
    }
    // the manifest only under the secret directory, the pages in it by their whole place
    const m = JSON.parse((await get(`s3cr3tdirectory000000000/${MANIFEST}`)).text) as { pages: Record<string, unknown> };
    expect(Object.keys(m.pages).sort()).toEqual([`${A}/sync-button`, `${B}/csv-export`]);
  });

  test('its pages keep search engines out, send no referrer, and link no overview or tags', async () => {
    await unlisted().publish(page(`${A}/sync-button`, { tags: { Area: ['Billing'] } }));
    const html = readFileSync(join(siteDir(), A, 'sync-button/index.html'), 'utf8');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toContain('href="../');
    expect(html).not.toContain('All demos');
    expect(html).not.toContain('class="tags"');
    expect(html).not.toContain(' · Demos</title>');
    // nor names its address for them: it is in no index to be listed once
    expect(html).not.toContain('rel="canonical"');
    // the credit line stays, and goes without a referrer
    expect(html).toContain('href="https://obeya.si"');
    const headers = readFileSync(join(siteDir(), '_headers'), 'utf8');
    expect(headers).toContain('/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n');
    expect(headers).toContain('/:token/:slug/artifact/*');
  });

  test('refuses a page outside a random part of its address', async () => {
    expect(await unlisted().publish(page('sync-button'))).toMatchObject({ why: expect.stringContaining('not a slug') });
    expect(await unlisted().publish(page('short/sync-button'))).toMatchObject({ why: expect.stringContaining('not a slug') });
  });

  test('a second machine connected with the code pulls the pages under the secret path, and keeps them when it publishes', async () => {
    await unlisted().publish(page(`${A}/sync-button`));
    writePersonal(home, personal({ env: 'sites/p/cloudflare.env' }));
    mkdirSync(join(home, 'sites/p'), { recursive: true });
    writeFileSync(join(home, 'sites/p/cloudflare.env'), 'CLOUDFLARE_API_TOKEN=t0k\nCLOUDFLARE_ACCOUNT_ID=acc\n');
    const code = connectionCode(home, readPersonal(home)!);
    const other = join(dir, 'other');
    const joined = connect(other, code);
    expect(joined.credentials).toBe(true);
    expect(readPersonal(other)).toMatchObject({ host: 'cloudflare', url: URL_, secret: personal().secret });
    expect(readFileSync(join(other, readPersonal(other)!.env!), 'utf8')).toContain('CLOUDFLARE_API_TOKEN=t0k');
    expect(await unlisted(other, 'b').publish(page(`${B}/csv-export`))).toMatchObject({ url: `${URL_}${B}/csv-export/` });
    expect(existsSync(join(deployed(), A, 'sync-button/demo.mp4'))).toBe(true);
    expect(existsSync(join(deployed(), B, 'csv-export/demo.mp4'))).toBe(true);
    expect(() => connect(other, 'something else')).toThrow('not a connection code');
  });
});

test('the random part of an address carries at least 80 bits', () => {
  const t = newToken();
  expect(t).toMatch(/^[a-z0-9]{16,}$/);
  expect(t.length * Math.log2(36)).toBeGreaterThanOrEqual(80);
  expect(new Set(Array.from({ length: 50 }, () => newToken())).size).toBe(50);
});

describe('sharing without a site of the repository', () => {
  let board: Board;
  let source: ShareSource;
  let sharing: Sharing;
  beforeEach(() => {
    board = testBoard({ path: repo });
    source = { site: null, repo, isPublic: true };
    writePersonal(home, personal());
    sharing = new Sharing({
      board,
      runtime: new FakeRuntime(),
      home,
      forge: noForge,
      sourceFor: () => source,
      // the personal site deploying with the stand-in, in place of wrangler
      personalSite: (p) => ({ title: 'Demos', url: p.url, deploy: `deploy.ts {dir} ${dir}` }),
    });
  });
  const card = () => {
    const c = board.create({ title: 'Sync button', x: 0, y: 0 });
    board.work(c.id, { state: 'live', demo: JSON.stringify({ kind: 'video', dir: demo, chapters: [[0, 'Before']], page: { title: 'Sync button', text: 'A sentence.' } }) });
    return c.id;
  };
  const settled = async (id: string, state: string | undefined) => {
    for (let i = 0; i < 300 && board.item(id)!.share?.state !== state; i++) await Bun.sleep(10);
    return board.item(id)!.share;
  };

  test('a public repository shares on the personal site, under a random part drawn once for the card', async () => {
    const id = card();
    sharing.share(id);
    const first = await settled(id, 'shared');
    expect(first?.url).toMatch(new RegExp(`^${URL_}[a-z0-9]{16,}/sync-button-[0-9a-z]+/$`));
    sharing.unshare(id);
    await settled(id, undefined);
    expect(existsSync(join(deployed(), first!.url!.slice(URL_.length)))).toBe(false);
    sharing.share(id);
    // shared again, the same link
    expect((await settled(id, 'shared'))?.url).toBe(first!.url!);
  });

  test('a private repository shares nothing until the owner ticks it', async () => {
    source = { site: null, repo };
    const id = card();
    expect(() => sharing.share(id)).toThrow('shares none');
    expect(existsSync(join(dir, 'deployed'))).toBe(false);
    allowPrivate(home, repo, true);
    sharing.share(id);
    expect((await settled(id, 'shared'))?.url).toStartWith(URL_);
    allowPrivate(home, repo, false);
    expect(allowedHere(readPersonal(home)!, repo, false)).toBe(false);
    expect(allowedHere(readPersonal(home)!, repo, true)).toBe(true);
  });

  test('a private repository unticked after sharing: nothing more goes out, but its page can be withdrawn', async () => {
    source = { site: null, repo };
    allowPrivate(home, repo, true);
    const id = card();
    sharing.share(id);
    const url = (await settled(id, 'shared'))!.url!;
    allowPrivate(home, repo, false);
    expect(() => sharing.share(id)).toThrow('not allowed');
    sharing.unshare(id);
    await settled(id, undefined);
    expect(existsSync(join(deployed(), url.slice(URL_.length), 'demo.mp4'))).toBe(false);
  });

  test('a page on a personal site this machine is no longer connected to is left alone', async () => {
    const id = card();
    sharing.share(id);
    await settled(id, 'shared');
    writePersonal(home, personal({ url: 'https://other.example.dev' }));
    expect(() => sharing.unshare(id)).not.toThrow();
    await settled(id, 'shared');
    expect(board.events(id).some((e) => e.kind === 'error')).toBe(true);
  });

  test('a listed personal site (a public GitHub repository): no random part, an overview listing the page', async () => {
    const { secret: _, ...listed } = personal({ host: 'github', project: 'ada/obeya-demos' });
    writePersonal(home, listed);
    const id = card();
    sharing.share(id);
    const url = (await settled(id, 'shared'))!.url!;
    expect(url).toMatch(new RegExp(`^${URL_}sync-button-[0-9a-z]+/$`));
    expect(board.item(id)!.share!.unlisted).toBeUndefined();
    expect(readFileSync(join(deployed(), 'index.html'), 'utf8')).toContain('Sync button');
    expect(existsSync(join(deployed(), MANIFEST))).toBe(true);
  });

  test('approving shares nothing there until the owner ticks the repository for it, then the latest demo goes out unless the card opts out', async () => {
    const id = card();
    expect(sharing.approved(id)).toBeNull();
    expect(board.item(id)!.share).toBeUndefined();
    shareApproved(home, repo, true);
    expect(sharing.approved(id)).toStartWith(`Demo-Video: ${URL_}`);
    expect((await settled(id, 'shared'))?.url).toStartWith(URL_);
    // the card that opted out stays here
    const other = card();
    sharing.onApproval(other, false);
    expect(sharing.approved(other)).toBeNull();
    expect(board.item(other)!.share?.url).toBeUndefined();
    shareApproved(home, repo, false);
    expect(approvedHere(readPersonal(home)!, repo)).toBe(false);
    expect(readPersonal(home)!.approved).toBeUndefined();
  });

  test('a page shared there by hand, the repository not ticked for approval: the landing commit links it all the same', async () => {
    const id = card();
    sharing.share(id);
    const url = (await settled(id, 'shared'))!.url!;
    expect(sharing.approved(id)).toBe(`Demo-Video: ${url}`);
    // nothing more went out for the approval
    expect(board.item(id)!.share?.state).toBe('shared');
  });

  test('the tick for approval does not reach a repository whose card shares on its own site', async () => {
    shareApproved(home, repo, true);
    const own = { title: 'Team', url: 'https://demos.example.dev', deploy: 'true' };
    source = { site: own, repo, isPublic: true };
    const id = card();
    expect(sharing.approved(id)).toBeNull();
    expect(board.item(id)!.share).toBeUndefined();
  });

  test('a repository whose site this machine cannot deploy to falls back to the personal site', async () => {
    source = { site: { title: 'Team', url: 'https://demos.example.dev', deploy: 'true', env: 'sites/team/cloudflare.env' }, repo, isPublic: true };
    const id = card();
    sharing.share(id);
    expect((await settled(id, 'shared'))?.url).toStartWith(URL_);
  });
});

describe('setting up at GitHub', () => {
  /** gh's answers by the start of its arguments; every call recorded. */
  let calls: string[][];
  let answers: [string, { code: number; out: string; err?: string }][];
  const x: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'git') return { code: 0, out: '', err: '' };
    const line = argv.slice(1).join(' ');
    const a = answers.find(([start]) => line.startsWith(start))?.[1] ?? { code: 0, out: '' };
    return { code: a.code, out: a.out, err: a.err ?? '' };
  };
  beforeEach(() => {
    calls = [];
    answers = [
      ['api user', { code: 0, out: JSON.stringify({ login: 'ada', plan: { name: 'pro' } }) }],
      ['api repos/ada/obeya-demos', { code: 1, out: '', err: 'Not Found (HTTP 404)' }],
      ['repo view', { code: 0, out: 'PRIVATE\n' }],
      ['auth token', { code: 0, out: 'gho_secret\n' }],
      ['api -X POST repos/ada/obeya-demos/pages', { code: 0, out: JSON.stringify({ html_url: 'https://ada.github.io/obeya-demos/' }) }],
    ];
  });
  const gh = () => calls.filter((c) => c[0] === 'gh').map((c) => c.slice(1).join(' '));

  test('the personal site lives in a private repository, created as private and checked to be', async () => {
    const r = await setupGithub({ name: 'obeya-demos', private: true, log: () => {}, x, wait: [] });
    expect(r).toEqual({ url: 'https://ada.github.io/obeya-demos/', project: 'ada/obeya-demos' });
    const create = calls.find((c) => c[1] === 'repo' && c[2] === 'create')!;
    expect(create).toContain('--private');
    expect(calls.flat()).not.toContain('--public');
    expect(gh()).toContain('repo view ada/obeya-demos --json visibility --jq .visibility');
  });

  test('a free account is refused before anything is created, with Cloudflare offered', async () => {
    answers[0] = ['api user', { code: 0, out: JSON.stringify({ login: 'ada', plan: { name: 'free' } }) }];
    const r = setupGithub({ name: 'obeya-demos', private: true, log: () => {}, x, wait: [] });
    await expect(r).rejects.toBeInstanceOf(SetupRefused);
    await expect(r).rejects.toMatchObject({ offer: 'cloudflare', message: expect.stringContaining('GitHub Pro') });
    expect(gh().some((c) => c.startsWith('repo create'))).toBe(false);
  });

  test('Pages refused for the private repository: the reason, and Cloudflare offered', async () => {
    answers[4] = ['api -X POST', { code: 1, out: '', err: 'gh: Your current plan does not support GitHub Pages for this repository. (HTTP 422)' }];
    answers[0] = ['api user', { code: 0, out: JSON.stringify({ login: 'ada' }) }];
    await expect(setupGithub({ name: 'obeya-demos', private: true, log: () => {}, x, wait: [] })).rejects.toMatchObject({ offer: 'cloudflare', message: expect.stringContaining('does not support GitHub Pages') });
  });

  test('a repository GitHub did not make private is not used', async () => {
    answers[2] = ['repo view', { code: 0, out: 'PUBLIC\n' }];
    await expect(setupGithub({ name: 'obeya-demos', private: true, log: () => {}, x, wait: [] })).rejects.toThrow('not private');
    expect(calls.some((c) => c[0] === 'git')).toBe(false);
  });

  test('a name taken gets a number, and is never reused', async () => {
    answers.splice(1, 1, ['api repos/ada/obeya-demos-2', { code: 1, out: '' }], ['api repos/ada/obeya-demos', { code: 0, out: '{}' }]);
    answers.push(['api -X POST repos/ada/obeya-demos-2/pages', { code: 0, out: JSON.stringify({ html_url: 'https://ada.github.io/obeya-demos-2/' }) }]);
    expect((await setupGithub({ name: 'obeya-demos', private: true, log: () => {}, x, wait: [] })).project).toBe('ada/obeya-demos-2');
  });

  test('a public repository, as chosen: any account, no check of the plan, a listed site', async () => {
    answers[0] = ['api user', { code: 0, out: JSON.stringify({ login: 'ada', plan: { name: 'free' } }) }];
    const setup = new SiteSetup({ home, changed: () => {}, x, wait: [] });
    setup.setupPersonal({ host: 'github', public: true });
    for (let i = 0; i < 100 && setup.view().job?.running; i++) await Bun.sleep(5);
    expect(setup.view().site).toMatchObject({ host: 'github', listed: true });
    expect(calls.find((c) => c[2] === 'create')).toContain('--public');
    expect(readPersonal(home)!.secret).toBeUndefined();
  });

  test('every setup through the configuration without the public choice makes the personal site private', async () => {
    const setup = new SiteSetup({ home, changed: () => {}, x, wait: [] });
    setup.setupPersonal({ host: 'github' });
    for (let i = 0; i < 100 && setup.view().job?.running; i++) await Bun.sleep(5);
    expect(setup.view().site).toMatchObject({ host: 'github', url: 'https://ada.github.io/obeya-demos/' });
    expect(calls.find((c) => c[2] === 'create')).toContain('--private');
    expect(readPersonal(home)!.secret).toMatch(/^[a-z0-9]{25,}$/);
  });
});

test('the deploy of an unlisted site to GitHub Pages refuses a repository that is not private', async () => {
  const calls: string[][] = [];
  const x: Exec = async (argv) => {
    calls.push(argv);
    return argv.includes('view') ? { code: 0, out: 'PUBLIC\n', err: '' } : { code: 0, out: 'tok\n', err: '' };
  };
  await expect(githubPagesDeploy(join(dir, 'site'), 'ada/obeya-demos', join(dir, 'git'), x, { private: true })).rejects.toThrow('not private');
  expect(calls.some((c) => c[0] === 'git')).toBe(false);
});

test('the deploy to GitHub Pages pushes one commit without history, with gh’s token kept off the command line', async () => {
  const site = join(dir, 'site');
  mkdirSync(join(site, 'a/b'), { recursive: true });
  writeFileSync(join(site, 'index.html'), 'root');
  writeFileSync(join(site, 'a/b/demo.mp4'), 'video');
  // a machine's own git configuration that would leave files out: none of it applies
  writeFileSync(join(dir, 'ignore'), '*.mp4\n');
  const pushes: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const x: Exec = async (argv, o) => {
    if (argv[0] === 'gh') return { code: 0, out: 'gho_secret\n', err: '' };
    if (argv.includes('push')) {
      pushes.push({ argv, env: o?.env ?? {} });
      // what the commit holds
      const gitDir = argv.find((a) => a.startsWith('--git-dir='))!.slice('--git-dir='.length);
      const ls = await exec(['git', `--git-dir=${gitDir}`, 'ls-tree', '-r', '--name-only', 'HEAD']);
      const count = await exec(['git', `--git-dir=${gitDir}`, 'rev-list', '--count', 'HEAD']);
      return { code: 0, out: `${ls.out}commits ${count.out}`, err: '' };
    }
    return exec(argv, { ...o, env: { ...o?.env, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') } });
  };
  writeFileSync(join(dir, 'gitconfig'), `[core]\n\texcludesFile = ${JSON.stringify(join(dir, 'ignore'))}\n[commit]\n\tgpgsign = true\n`);
  const said = await githubPagesDeploy(site, 'ada/obeya-demos', join(dir, 'git'), x);
  expect(said).toContain('a/b/demo.mp4');
  expect(said).toContain('.nojekyll');
  expect(said).toContain('commits 1');
  const [push] = pushes;
  expect(push!.argv.slice(-4)).toEqual(['--force', '--no-verify', 'https://github.com/ada/obeya-demos.git', 'HEAD:main']);
  expect(push!.argv.join(' ')).not.toContain('gho_secret');
  expect(push!.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:gho_secret').toString('base64')}`);
  // its repository is made afresh each time and goes afterwards
  expect(existsSync(join(dir, 'git'))).toBe(false);
  await expect(githubPagesDeploy(site, 'not a repository', join(dir, 'git'), x)).rejects.toThrow('expected <owner>/<repository>');
});

describe('setting up at Cloudflare', () => {
  let calls: string[][];
  // where wrangler ran: an empty directory, never the server's own (a command wrangler hands on to Workers uploads it)
  let cwds: string[];
  const x =
    (answer: (args: string) => { code: number; out: string }): Exec =>
    async (argv, o) => {
      calls.push(argv);
      cwds.push(o?.cwd ?? process.cwd());
      if (!argv.includes('deploy')) expect(readdirSync(o!.cwd!)).toEqual([]);
      return { ...answer(argv.slice(3).join(' ')), err: '' };
    };
  beforeEach(() => {
    calls = [];
    cwds = [];
  });
  afterEach(() => {
    expect(cwds.length).toBeGreaterThan(0);
    for (const c of cwds) {
      expect(c).not.toBe(process.cwd());
      expect(existsSync(c)).toBe(false);
    }
  });

  test('takes the account of a site this machine deploys to, as chosen, and a suffix where the name is taken', async () => {
    mkdirSync(join(home, 'sites/demos.example.dev'), { recursive: true });
    writeFileSync(join(home, 'sites/demos.example.dev/cloudflare.env'), 'CLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_ACCOUNT_ID=acc\n');
    // another site of the same account, and one of another
    mkdirSync(join(home, 'sites/more.example.dev'), { recursive: true });
    writeFileSync(join(home, 'sites/more.example.dev/cloudflare.env'), 'CLOUDFLARE_API_TOKEN=tok2\nCLOUDFLARE_ACCOUNT_ID=acc\n');
    mkdirSync(join(home, 'sites/work.example.dev'), { recursive: true });
    writeFileSync(join(home, 'sites/work.example.dev/cloudflare.env'), 'export CLOUDFLARE_API_TOKEN="w"\nCLOUDFLARE_ACCOUNT_ID=work\n');
    expect(cloudflareAccounts(home).map((a) => a.site)).toEqual(['demos.example.dev', 'work.example.dev']);
    let first = true;
    const r = await setupCloudflare({
      home,
      name: 'obeya-ada',
      account: 'demos.example.dev',
      wait: [],
      log: () => {},
      x: x((args) => {
        if (args.startsWith('pages project create') && first) {
          first = false;
          return { code: 1, out: 'A project with this name already exists. [code: 8000002]' };
        }
        return { code: 0, out: "✨ Successfully created the 'obeya-ada-x1y2' project. It will be available at https://obeya-ada-x1y2.pages.dev/ once you create your first deployment." };
      }),
    });
    expect(r).toMatchObject({ url: 'https://obeya-ada-x1y2.pages.dev', env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' } });
    expect(r.project).toMatch(/^obeya-ada-[a-z0-9]{1,4}$/);
    expect(calls.some((c) => c.includes('login'))).toBe(false);
  });

  test('another account by its API token: no login, the token for the new site', async () => {
    const r = await setupCloudflare({ home, name: 'obeya-ada', token: { CLOUDFLARE_API_TOKEN: 'another-token-0123456789' }, log: () => {}, wait: [], x: x(() => ({ code: 0, out: 'created https://obeya-ada.pages.dev/' })) });
    expect(calls.some((c) => c.includes('login') || c.includes('whoami'))).toBe(false);
    expect(r.env).toEqual({ CLOUDFLARE_API_TOKEN: 'another-token-0123456789' });
  });

  test('without one, logs in through the browser with wrangler', async () => {
    const r = await setupCloudflare({ home, name: 'obeya-ada', log: () => {}, wait: [], x: x((args) => (args === 'whoami' ? { code: 0, out: 'You are not authenticated. Please run `wrangler login`.' } : { code: 0, out: 'created https://obeya-ada.pages.dev/' })) });
    expect(calls.map((c) => c.slice(3, 7).join(' '))).toEqual(['whoami', 'login', 'pages project create obeya-ada', 'pages deploy ' + calls[3]![5] + ' --project-name']);
    expect(calls[2]).toContain('--force');
    expect(r).toEqual({ url: 'https://obeya-ada.pages.dev', project: 'obeya-ada' });
  });
});

test('the canvas says where a repository without a site shares: nowhere without a personal site, after a tick when private, else there', async () => {
  const shop = gitRepo(join(dir, 'shop'), { 'docs/plan/plan.md': '# Shop\n\n## Goal\n\nG.\n' });
  let visibility: 'public' | 'private' = 'private';
  const canvas = await CanvasRuntime.start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home, runtime: new FakeRuntime(), forge: { ...noForge, visibility: async () => visibility } });
  const ref = () => canvas.board.canvas.repos[0]!;
  try {
    expect(ref()).toMatchObject({ sharePersonal: 'none' });
    expect(ref().share).toBeUndefined();
    writePersonal(home, personal());
    canvas.personalSiteChanged();
    expect(ref()).toMatchObject({ sharePersonal: 'private' });
    allowPrivate(home, shop, true);
    canvas.personalSiteChanged();
    expect(ref()).toMatchObject({ share: true, shareUnlisted: true });
    expect(ref().sharePersonal).toBeUndefined();
    expect(ref().shareOnPersonal).toBe(true);
    expect(ref().shareOnApproval).toBeUndefined();
    // ticked on the personal site, its approved cards share there by themselves
    shareApproved(home, shop, true);
    canvas.personalSiteChanged();
    expect(ref()).toMatchObject({ share: true, shareOnApproval: true });
    allowPrivate(home, shop, false);
    canvas.personalSiteChanged();
    expect(ref().share).toBeUndefined();
    expect(ref().shareOnApproval).toBeUndefined();
    // a public repository needs no tick, once its forge says so
    visibility = 'public';
    const again = await CanvasRuntime.start({ repos: [{ path: shop }] }, { store: new Store(':memory:'), home, runtime: new FakeRuntime(), forge: { ...noForge, visibility: async () => visibility } });
    try {
      for (let i = 0; i < 100 && !again.board.canvas.repos[0]!.share; i++) await Bun.sleep(5);
      expect(again.board.canvas.repos[0]).toMatchObject({ share: true, shareUnlisted: true });
    } finally {
      again.shutdown();
    }
  } finally {
    canvas.shutdown();
  }
});

test("a worker resumed after a restart on a public repository writes the page, though the forge answers only later", async () => {
  const shop = gitRepo(join(dir, 'shop'), { 'docs/plan/plan.md': '# Shop\n\nG.\n', '.obeya/settings.json': '{ "land": "main" }\n' });
  identify(shop);
  writePersonal(home, personal());
  const store = new Store(':memory:');
  // the page a handover sends, as the agent's runtime lets it through the tool's schema (it drops what the schema does not take)
  const page = (r: FakeRuntime) => {
    const tool = r.last.spec.tools!.find((t) => t.name === 'ready_for_review')!;
    const sent = { title: 'Orders as CSV', text: 'Shop owners download their orders as a CSV file.' };
    return (z.object(tool.schema as z.ZodRawShape).parse({ summary: 'S', demo: { dir: demo, chapters: ['Before'], page: sent } }) as { demo: { page?: unknown } }).demo.page;
  };
  const before = new FakeRuntime();
  const canvas = await CanvasRuntime.start({ repos: [{ path: shop }] }, { store, home, runtime: new FakeRuntime(), workerRuntime: before, forge: { ...noForge, visibility: async () => 'public' } });
  let card: string;
  try {
    await until(() => canvas.board.canvas.repos[0]!.share);
    card = canvas.board.create({ title: 'A', x: 0, y: 0 }).id;
    await canvas.repos[0]!.workers.start(card);
    expect(page(before)).toBeDefined();
    before.last.emit({ type: 'session', id: 'sess-a' });
  } finally {
    canvas.shutdown();
  }
  // after the restart the forge takes its time to answer
  let answer!: (v: 'public') => void;
  const after = new FakeRuntime();
  const again = await CanvasRuntime.start({ repos: [{ path: shop }] }, { store, home, runtime: new FakeRuntime(), workerRuntime: after, forge: { ...noForge, visibility: () => new Promise((r) => (answer = r)) } });
  try {
    await until(() => after.sessions.length);
    expect(after.last.spec.resume).toBe('sess-a');
    expect(page(after)).toBeDefined();
    expect(again.board.canvas.repos[0]).toMatchObject({ share: true, shareOnPersonal: true });
    answer('public');
  } finally {
    again.shutdown();
  }
});

test('the configuration lists the repositories that share on the personal site with their tick for approval, and a connection keeps the ticks', () => {
  writePersonal(home, personal());
  let changed = 0;
  const repos = [
    { path: join(dir, 'shop'), name: 'shop', isPublic: true, ownSite: false, onPersonal: true },
    { path: join(dir, 'team'), name: 'team', isPublic: true, ownSite: false, onPersonal: true, siteApproved: true },
    { path: join(dir, 'site'), name: 'site', isPublic: true, ownSite: true },
  ];
  const setup = new SiteSetup({ home, changed: () => changed++, repos: () => repos });
  expect(setup.view().approvedRepos).toEqual([
    { path: join(dir, 'shop'), name: 'shop', on: false },
    { path: join(dir, 'team'), name: 'team', on: true, bySettings: true },
  ]);
  expect(setup.approved({ path: join(dir, 'shop'), on: true }).approvedRepos[0]).toMatchObject({ name: 'shop', on: true });
  expect(changed).toBe(1);
  expect(() => setup.approved({ path: 1, on: true })).toThrow();
  // the code carries no ticks; connecting again keeps this machine's
  const code = connectionCode(home, readPersonal(home)!);
  expect(JSON.parse(Buffer.from(code.slice('obeya-site:'.length), 'base64url').toString()).approved).toBeUndefined();
  connect(home, code);
  expect(approvedHere(readPersonal(home)!, join(dir, 'shop'))).toBe(true);
});
