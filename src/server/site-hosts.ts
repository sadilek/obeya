// Setting up a demo site at a host, and the deploy Obeya builds in for GitHub Pages. Cloudflare
// Pages goes through wrangler (with the credentials of a site this machine already deploys to, else
// the machine's own `wrangler login`), GitHub Pages through gh's login and git. Everything runs as a
// program with its arguments, never through a shell, so it works on Windows and Linux alike.
//
// The personal site on GitHub Pages lives in a private repository, always: a public one would show
// every page's random address in its file list. Pages from a private repository needs GitHub Pro;
// where GitHub refuses, the setup says why and offers Cloudflare.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUN_ENV } from './resources';
import { spawnOutput } from './spawn';
import { AS_OBEYA } from './git';

/** The deploy line's word for the deploy Obeya builds in: `obeya:github-pages <owner>/<repository>`. */
export const GITHUB_PAGES = 'obeya:github-pages';
/** GitHub's limit on one file (100 MiB); a site stays under about 1 GB. */
export const GITHUB_PAGES_MAX = 100 * 1024 * 1024;

/** Runs a program; a stand-in in tests. */
export type Exec = (argv: string[], o?: { env?: Record<string, string | undefined>; timeout?: number; cwd?: string }) => Promise<{ code: number; out: string; err: string }>;

export const exec: Exec = async (argv, o = {}) => {
  try {
    const r = await spawnOutput(argv, { stdin: 'ignore', env: { ...process.env, ...o.env }, timeout: o.timeout ?? 120_000, ...(o.cwd ? { cwd: o.cwd } : {}) });
    return { code: r.code, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: -1, out: '', err: e instanceof Error ? e.message : String(e) };
  }
};

/** A setup refused, with what it says to the owner; `offer`: the host the dialog offers instead. */
export class SetupRefused extends Error {
  constructor(
    message: string,
    readonly offer?: 'cloudflare',
  ) {
    super(message);
  }
}

/** wrangler, run by Obeya's own Bun, so no `npx` or `bunx` need be on the PATH. */
const wrangler = (...args: string[]) => [process.execPath, 'x', 'wrangler@4', ...args];
const wranglerEnv = (env: Record<string, string>) => ({ ...BUN_ENV, ...env });

/**
 * The Cloudflare accounts of the sites this machine deploys to already (an env file under `sites/`
 * with an API token or an account's id), by site, each account once: a new site may go into one of
 * them.
 */
export function cloudflareAccounts(home: string): { site: string; env: Record<string, string> }[] {
  const sites = join(home, 'sites');
  if (!existsSync(sites)) return [];
  const found: { site: string; env: Record<string, string> }[] = [];
  for (const d of readdirSync(sites, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(sites, d.name)).sort()) {
      if (!f.endsWith('.env')) continue;
      const env: Record<string, string> = {};
      for (const line of readFileSync(join(sites, d.name, f), 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
        if (m) env[m[1]!] = m[2]!;
      }
      const same = (e: Record<string, string>) => e.CLOUDFLARE_ACCOUNT_ID ? e.CLOUDFLARE_ACCOUNT_ID === env.CLOUDFLARE_ACCOUNT_ID : e.CLOUDFLARE_API_TOKEN === env.CLOUDFLARE_API_TOKEN;
      // a site may name its account alone and deploy with the machine's wrangler login
      if ((env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ACCOUNT_ID) && !found.some((x) => same(x.env))) found.push({ site: d.name, env });
    }
  }
  return found;
}

/**
 * Creates a Cloudflare Pages project: in the account of a site this machine deploys to (`account`,
 * the site's directory under `sites/`; its credentials are returned, for the new site's env file),
 * or without one with the machine's wrangler login, logging in through the browser first where there
 * is none. A name taken gets a suffix. Returns its address.
 */
export async function setupCloudflare(o: { home: string; name: string; account?: string; token?: Record<string, string>; log: (line: string) => void; x?: Exec; wait?: number[] }): Promise<{ url: string; project: string; env?: Record<string, string> }> {
  // wrangler runs in an empty directory of its own: in another one it reads (and writes) what it
  // finds there, and a command it hands on to Workers uploads that directory (2026-10-29: Obeya's
  // checkout went up as a Worker)
  const cwd = mkdtempSync(join(tmpdir(), 'obeya-wrangler-'));
  try {
    return await cloudflareIn(cwd, o);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function cloudflareIn(cwd: string, o: Parameters<typeof setupCloudflare>[0]): Promise<{ url: string; project: string; env?: Record<string, string> }> {
  const base = o.x ?? exec;
  const x: Exec = (argv, opts) => base(argv, { ...opts, cwd });
  // another account's API token, the account of a site this machine deploys to, or the machine's login
  const env = o.token ?? (o.account ? cloudflareAccounts(o.home).find((a) => a.site === o.account)?.env : undefined);
  if (!o.token && o.account && !env) throw new SetupRefused(`no Cloudflare credentials of ${o.account} on this machine`);
  if (o.token) o.log('Using the API token given.');
  else if (env) o.log(`Using the Cloudflare account of ${o.account}.`);
  // without a token of the site's, the machine's own wrangler login deploys, in the site's account
  if (!env?.CLOUDFLARE_API_TOKEN) {
    o.log('Checking the Cloudflare login on this machine…');
    const who = await x(wrangler('whoami'), { env: wranglerEnv(env ?? {}) });
    if (who.code !== 0 || /not authenticated|wrangler login/i.test(who.out + who.err)) {
      o.log('Opening the Cloudflare login in the browser…');
      const login = await x(wrangler('login'), { env: wranglerEnv(env ?? {}), timeout: 5 * 60_000 });
      if (login.code !== 0) throw new SetupRefused(`wrangler login failed: ${lastLine(login)}`);
    }
  }
  for (let i = 0; i < 4; i++) {
    const project = i ? `${o.name}-${Math.random().toString(36).slice(2, 6)}` : o.name;
    o.log(`Creating the Cloudflare Pages project ${project}…`);
    // --force: a Pages project, as the deploy line deploys to; without it wrangler 4.15x hands the
    // command on to Workers, which makes a Worker of whatever its directory holds
    const r = await x(wrangler('pages', 'project', 'create', project, '--production-branch', 'main', '--force'), { env: wranglerEnv(env ?? {}) });
    const said = r.out + r.err;
    if (r.code === 0) {
      // Cloudflare gives a name taken elsewhere a subdomain of its own
      const url = /https:\/\/[a-z0-9-]+\.pages\.dev/.exec(said)?.[0];
      if (!url || /workers\.dev/.test(said)) throw new SetupRefused(`wrangler made no Pages project: ${lastLine(r)}`);
      // the address resolves only once something is deployed there: a blank page first
      const first = mkdtempSync(join(tmpdir(), 'obeya-pages-'));
      try {
        writeFileSync(join(first, 'index.html'), BLANK_PAGE);
        writeFileSync(join(first, '404.html'), BLANK_PAGE);
        o.log('Deploying a first, empty page…');
        const d = await x(wrangler('pages', 'deploy', first, '--project-name', project, '--branch', 'main', '--commit-dirty=true'), { env: wranglerEnv(env ?? {}), timeout: 5 * 60_000 });
        if (d.code !== 0) throw new SetupRefused(`wrangler pages deploy failed: ${lastLine(d)}`);
      } finally {
        rmSync(first, { recursive: true, force: true });
      }
      await answering(url, o.log, o.wait);
      return { url, project, ...(env ? { env } : {}) };
    }
    if (!/already exists|8000002/i.test(said)) throw new SetupRefused(`wrangler pages project create failed: ${lastLine(r)}`);
  }
  throw new SetupRefused('every name tried is taken at Cloudflare');
}

/**
 * Creates a GitHub repository with a Pages site under the gh login's account: `private` for the
 * personal site (and never public then), public for a repository's listed site. A name already
 * taken gets a number; GitHub's answer on the repository's visibility is checked before anything
 * goes into it. Returns the site's address and the repository.
 */
export async function setupGithub(o: { name: string; private: boolean; log: (line: string) => void; x?: Exec; wait?: number[] }): Promise<{ url: string; project: string }> {
  const x = o.x ?? exec;
  const gh = async (...args: string[]) => {
    const r = await x(['gh', ...args]);
    if (r.code !== 0) throw Object.assign(new Error(lastLine(r)), { said: `${r.out}\n${r.err}` });
    return r.out;
  };
  o.log('Checking the GitHub login on this machine…');
  let user: { login: string; plan?: { name?: string } };
  try {
    user = JSON.parse(await gh('api', 'user'));
  } catch (e) {
    throw new SetupRefused(`gh is not logged in to GitHub (gh auth login): ${e instanceof Error ? e.message : e}`);
  }
  if (o.private && user.plan?.name === 'free') throw new SetupRefused(NEEDS_PRO, 'cloudflare');
  let name = o.name;
  for (let i = 2; ; i++) {
    const taken = await x(['gh', 'api', `repos/${user.login}/${name}`]);
    if (taken.code !== 0) break;
    if (i > 9) throw new SetupRefused(`every name tried is taken under ${user.login}`);
    name = `${o.name}-${i}`;
  }
  const project = `${user.login}/${name}`;
  o.log(`Creating the ${o.private ? 'private' : 'public'} repository ${project}…`);
  await gh('repo', 'create', project, o.private ? '--private' : '--public', '--description', o.private ? 'Unlisted demo pages, published by Obeya' : 'Demo pages, published by Obeya');
  const visibility = (await gh('repo', 'view', project, '--json', 'visibility', '--jq', '.visibility')).trim().toUpperCase();
  if (o.private && visibility !== 'PRIVATE') throw new SetupRefused(`GitHub created ${project} as ${visibility.toLowerCase() || 'unknown'}, not private; Obeya does not use it. Delete it on GitHub.`);
  // Pages needs a branch to serve: a first commit with an empty page
  const first = mkdtempSync(join(tmpdir(), 'obeya-pages-'));
  try {
    writeFileSync(join(first, 'index.html'), BLANK_PAGE);
    o.log('Pushing a first, empty page…');
    await githubPagesDeploy(first, project, join(first, '..', `${name}.git-${Date.now()}`), x, { private: o.private });
  } finally {
    rmSync(first, { recursive: true, force: true });
  }
  o.log('Turning on GitHub Pages…');
  let pages: { html_url?: string };
  try {
    pages = JSON.parse(await gh('api', '-X', 'POST', `repos/${project}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/'));
  } catch (e) {
    const said = (e as { said?: string }).said ?? String(e);
    if (o.private && /plan|upgrade|not available|422/i.test(said)) throw new SetupRefused(`${NEEDS_PRO} (GitHub: ${lastLine({ out: '', err: said }).replace(/^gh: /, '')}) The repository ${project} stays, private; delete it on GitHub if Cloudflare is to host the site.`, 'cloudflare');
    throw new SetupRefused(`GitHub did not turn on Pages for ${project}: ${lastLine({ out: '', err: said })}`);
  }
  const url = pages.html_url ?? `https://${user.login.toLowerCase()}.github.io/${name}/`;
  await answering(url, o.log, o.wait);
  return { url, project };
}

/**
 * Waits until a new site's address answers (its name resolves, the host serves it): a site that
 * does not answer yet cannot be read before the first share, which would refuse to deploy blind.
 * About two minutes at most; after that the setup counts all the same.
 */
async function answering(url: string, log: (line: string) => void, waits = [0, 2000, 3000, 5000, 5000, 10000, 15000, 20000, 30000, 30000]) {
  log(`Waiting for ${url} to answer…`);
  for (const w of waits) {
    await Bun.sleep(w);
    try {
      await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      return;
    } catch {}
  }
  log(`${url} does not answer yet; the first share may need a minute more.`);
}

const NEEDS_PRO = 'GitHub Pages from a private repository needs GitHub Pro, which this account does not have.';

/** A page that says nothing: the root of an unlisted site, and its answer to every address it lacks. */
export const BLANK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title></title></head><body></body></html>
`;

/**
 * Deploys a directory to a GitHub repository's `main` as a single commit without history, pushed
 * with force, so videos do not pile up in the repository. git runs with gh's token in its
 * environment (never on the command line, where other users of the machine could read it), in a
 * repository of its own made afresh each time (`gitDir`), with nothing of the machine's git
 * configuration that could leave files out or stop the commit (ignores, hooks, signing).
 */
export async function githubPagesDeploy(dir: string, repo: string, gitDir: string, x: Exec = exec, o: { private?: boolean } = {}): Promise<string> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`${GITHUB_PAGES}: expected <owner>/<repository>, got ${repo || 'nothing'}`);
  // an unlisted site goes only into a private repository: a public one lists every page's address
  if (o.private) {
    const v = await x(['gh', 'repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility']);
    const visibility = v.out.trim().toUpperCase();
    if (v.code !== 0 || visibility !== 'PRIVATE') throw new Error(`${repo} is ${v.code === 0 ? visibility.toLowerCase() || 'of unknown visibility' : `not readable (${lastLine(v)})`}, not private: Obeya puts no unlisted page there`);
  }
  const token = await x(['gh', 'auth', 'token']);
  if (token.code !== 0 || !token.out.trim()) throw new Error(`gh is not logged in to GitHub (gh auth login): ${lastLine(token)}`);
  // served as it is, without Jekyll (which leaves out files starting with _)
  writeFileSync(join(dir, '.nojekyll'), '');
  rmSync(gitDir, { recursive: true, force: true });
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token.out.trim()}`).toString('base64')}`,
  };
  const git = ['git', `--git-dir=${gitDir}`, `--work-tree=${dir}`, ...AS_OBEYA, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${join(gitDir, 'none')}`, '-c', `core.excludesFile=${join(gitDir, 'none')}`];
  const step = async (argv: string[], what: string) => {
    const r = await x(argv, { env, timeout: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`${what}: ${lastLine(r)}`);
    return r.out + r.err;
  };
  try {
    await step(['git', '-c', 'init.defaultBranch=main', 'init', '-q', '--bare', gitDir], 'git init');
    await step([...git, 'add', '-A', '-f'], 'git add');
    await step([...git, 'commit', '-q', '--no-verify', '-m', 'Demos'], 'git commit');
    const said = await step([...git, 'push', '-q', '--force', '--no-verify', `https://github.com/${repo}.git`, 'HEAD:main'], 'git push');
    return said.trim() || `Pushed to github.com/${repo}.`;
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

const lastLine = (r: { out: string; err: string }) =>
  (r.err.trim() || r.out.trim())
    .split('\n')
    .filter((l) => l.trim())
    .at(-1)
    ?.trim()
    .slice(0, 400) ?? 'no output';
