// A repository Obeya creates for a card that is to be built in one that does not exist yet: the
// folder where there is none, then git as "Set up a git repository here" sets it up (the
// default .gitignore, a first commit under git's name and e-mail), local only. A folder that is a
// repository already is taken as it is. Or, where the card names an existing project to start from
// (`NewRepo.from`), a clone of it: of a GitHub repository the owner cannot push to, a fork of it in
// the owner's account, with the original as the remote `upstream`. What it did can be taken back
// while the steps after it (the canvas, the move) fail; a fork on GitHub stays.

import { existsSync, mkdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BadRequest } from './board';
import { setUpGit } from './git-setup';
import { expandHome } from '../../plugin/skills/demo/lib/settings.ts';
import { GIT, gitOrNull, gitRun, NO_PROMPT } from './git';
import { accountEnv, type GithubRepo, githubRepo } from './forge';
import { failureText, spawnOutput } from './spawn';
import type { Messages } from '../core/messages';

type Words = Messages['newRepo'];

export interface MadeRepo {
  /** The folder, absolute. */
  path: string;
  /** Obeya set git up in it (false: it was a repository already). */
  made: boolean;
  /** Takes back what was done: the folder where Obeya created it, else git and the `.gitignore` it wrote. */
  undo: () => unknown;
}

/** The folder a new repository's path names, absolute; refused where it is none Obeya could make one in. */
export function newRepoPath(path: string, t: Words): string {
  const p = path.trim();
  if (!p) throw new BadRequest('newRepoPath', t.noPath);
  if (!folderPath(p)) throw new BadRequest('newRepoPath', `${p}: an absolute path, or one from ~`);
  return resolve(expandHome(p));
}

/** Whether `p` names a folder on its own: absolute on this system, or from the home (`~`, `~/…`). */
export const folderPath = (p: string) => p === '~' || p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\')) || isAbsolute(p);

/**
 * Makes the folder at `path` (absolute) a repository: created where it is missing, git set up where
 * it has none. A folder inside another repository is refused, since git there would find that one.
 */
export function makeRepo(path: string, t: Words): MadeRepo {
  const existed = existsSync(path);
  if (existed && !statSync(path).isDirectory()) throw new BadRequest('newRepoPath', t.notFolder(path));
  if (existed) {
    const top = gitOrNull(path, 'rev-parse', '--show-toplevel');
    // git names the folder by its real path (on macOS the temp directory's /private/var, say)
    if (top && realpathSync(top) === realpathSync(path)) return { path, made: false, undo: () => {} };
    if (top) throw new BadRequest('newRepoPath', t.inside(path, top));
  } else notInside(path, t);
  // the topmost folder Obeya creates, to remove again
  let created: string | null = null;
  if (!existed) {
    created = topCreated(path);
    mkdirSync(path, { recursive: true });
  }
  const gitignore = `${path}/.gitignore`;
  const hadIgnore = existsSync(gitignore);
  const removeCreated = () => removeFolders(path, created);
  const undo = () => {
    if (created) return removeCreated();
    rmSync(`${path}/.git`, { recursive: true, force: true });
    if (!hadIgnore) rmSync(gitignore, { force: true });
  };
  try {
    setUpGit(path);
  } catch (e) {
    if (created) removeCreated();
    throw e;
  }
  return { path, made: true, undo };
}

/** Refuses a folder that does not exist yet where it would lie inside a repository: the nearest folder above it that exists decides. */
function notInside(path: string, t: Words) {
  let up = dirname(path);
  while (!existsSync(up) && dirname(up) !== up) up = dirname(up);
  const top = existsSync(up) && statSync(up).isDirectory() ? gitOrNull(up, 'rev-parse', '--show-toplevel') : null;
  if (top) throw new BadRequest('newRepoPath', t.inside(path, top));
}

/** The topmost folder that creating `path` (which does not exist) creates. */
function topCreated(path: string): string {
  let top = path;
  while (!existsSync(dirname(top)) && dirname(top) !== top) top = dirname(top);
  return top;
}

/** Removes the folder `path`, then the folders above it up to `created` that Obeya created, as long as nothing else came into them. */
function removeFolders(path: string, created: string | null) {
  rmSync(path, { recursive: true, force: true });
  for (let up = dirname(path); created && up.length >= created.length; up = dirname(up)) {
    try {
      rmdirSync(up);
    } catch {
      break;
    }
  }
}

// ------------------------------------------------------------------ from an existing project

/** The project a new repository starts from (`NewRepo.from`): a GitHub repository, or any other git URL or folder of this machine. */
export type Source = { github: GithubRepo } | { url: string };

/** `owner/name`, short for a repository on github.com. */
const SHORT_GITHUB = /^[\w.-]+\/[\w.-]+$/;

/** What `from` names, or a refusal where it is no repository git could clone. */
export function newRepoSource(from: string, t: Words): Source {
  const f = from.trim();
  if (SHORT_GITHUB.test(f) && !f.startsWith('.')) {
    const [owner = '', repo = ''] = f.split('/');
    return { github: { host: 'github.com', owner, repo: repo.replace(/\.git$/, '') } };
  }
  const gh = githubRepo(f);
  if (gh) return { github: gh };
  if (folderPath(f)) return { url: resolve(expandHome(f)) };
  // a URL git clones (https://, ssh://, git://, file://) or the scp-like user@host:path
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(f) || /^[^\s/:@]+@[^\s/:]+:\S+$/.test(f)) return { url: f };
  throw new BadRequest('newRepoFrom', t.badFrom(f));
}

/** A source as the owner reads it: `owner/name` on github.com, else as written. */
export const sourceName = (s: Source): string => ('github' in s ? `${s.github.host === 'github.com' ? '' : `${s.github.host}/`}${s.github.owner}/${s.github.repo}` : s.url);

/** What Obeya asks of GitHub to start a new repository from a repository there, as `account` (gh's active account where none is named). */
export interface GithubForNewRepo {
  /** The repository: whether the account may push to it, its full name, URL to clone and default branch. */
  look(repo: GithubRepo, account?: string): Promise<{ push: boolean; fullName: string; cloneUrl: string; defaultBranch: string }>;
  /** Forks it into the account (GitHub hands back the fork the account has already, where it has one). */
  fork(repo: GithubRepo, account?: string): Promise<{ fullName: string; cloneUrl: string }>;
  /** The environment git clones and fetches with, as the account. */
  env(host: string, account?: string): Promise<Record<string, string>>;
}

/** `GithubForNewRepo` through the GitHub CLI (`program`; a stand-in in tests). */
export function ghNewRepo(program = 'gh'): GithubForNewRepo {
  const api = async (host: string, account: string | undefined, ...args: string[]) => {
    const env = await accountEnv(host, account, program);
    const r = await spawnOutput([program, 'api', ...args], { env, stdin: 'ignore', timeout: 60_000 });
    if (r.code !== 0) throw new Error(`GitHub: ${failureText(r)}`);
    return JSON.parse(r.stdout) as { full_name: string; clone_url: string; default_branch: string; permissions?: { push?: boolean } };
  };
  return {
    look: async ({ host, owner, repo }, account) => {
      const r = await api(host, account, `repos/${owner}/${repo}`);
      return { push: !!r.permissions?.push, fullName: r.full_name, cloneUrl: r.clone_url, defaultBranch: r.default_branch };
    },
    fork: async ({ host, owner, repo }, account) => {
      const r = await api(host, account, '-X', 'POST', `repos/${owner}/${repo}/forks`);
      return { fullName: r.full_name, cloneUrl: r.clone_url };
    },
    env: async (host, account) => {
      const env = await accountEnv(host, account, program);
      return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && /^(GH_|GITHUB_)/.test(e[0])));
    },
  };
}

/** A new repository cloned from an existing project: what it was cloned from, and the fork Obeya made of it on GitHub, if it did. */
export interface ClonedRepo extends MadeRepo {
  from: string;
  /** The fork, `owner/name`, with the original's main branch as the remote `upstream` has it (`upstream/<branch>`). */
  fork?: { name: string; upstream: string };
}

/** How long a clone may take: a project with a long history over a slow line. */
const CLONE_TIMEOUT = 30 * 60_000;
/** How long a fork GitHub has just made may take before it can be cloned (GitHub makes it in the background). */
const FORK_READY_MS = 120_000;

/**
 * Makes the folder at `path` (absolute; none yet, or an empty one) a clone of `source`. A GitHub
 * repository `account` (gh's active one where none is named) may push to is cloned as it is; one
 * it may not is forked into the account first, the fork cloned and the original added as the
 * remote `upstream`, its main branch fetched, so the new repository is a fork whose cards may go
 * to the original as pull requests (see Pull requests to the original). Anything else is cloned
 * as it is. Its undo removes the folder; a fork on GitHub stays.
 */
export async function cloneRepo(path: string, source: Source, t: Words, github: GithubForNewRepo, account?: string): Promise<ClonedRepo> {
  const was = await stat(path).catch(() => null);
  const existed = !!was;
  if (was && !was.isDirectory()) throw new BadRequest('newRepoPath', t.notFolder(path));
  if (was && (await readdir(path)).length) throw new BadRequest('newRepoPath', t.notEmpty(path));
  notInside(path, t);
  const created = existed ? null : topCreated(path);
  // a project's files are many: removed without the server waiting; an empty folder the owner made stays, empty again.
  // Called once the clone stands, whose folder git made, or found empty, so all in it is the clone's
  const undo = async () => {
    await rm(path, { recursive: true, force: true });
    if (existed) return mkdir(path);
    for (let up = dirname(path); created && up.length >= created.length; up = dirname(up)) {
      try {
        await rmdir(up);
      } catch {
        break;
      }
    }
  };
  let url = 'url' in source ? source.url : '';
  let env: Record<string, string> = {};
  let fork: ClonedRepo['fork'];
  let original: { cloneUrl: string; defaultBranch: string } | undefined;
  if ('github' in source) {
    const there = await github.look(source.github, account);
    env = await github.env(source.github.host, account);
    if (there.push) url = there.cloneUrl;
    else {
      const made = await github.fork(source.github, account);
      url = made.cloneUrl;
      original = there;
      fork = { name: made.fullName, upstream: `upstream/${there.defaultBranch}` };
    }
  }
  await mkdir(dirname(path), { recursive: true });
  // git clone takes back what it made itself where it fails, and refuses a folder that has files in it by now:
  // only a clone that stands is Obeya's to remove
  let cloned = false;
  try {
    const clone = () => spawnOutput([GIT, 'clone', '--', url, path], { env: { ...process.env, ...env, ...NO_PROMPT }, stdin: 'ignore', timeout: CLONE_TIMEOUT });
    let r = await clone();
    // a fork just made is cloneable only once GitHub has made it
    for (const until = Date.now() + FORK_READY_MS; r.code !== 0 && fork && Date.now() < until; ) {
      await new Promise((go) => setTimeout(go, 3000));
      r = await clone();
    }
    if (r.signal) throw new Error(`git clone ${url}: no end within ${CLONE_TIMEOUT / 60_000} min`);
    if (r.code !== 0) throw new Error(`git clone ${url}: ${failureText(r)}`);
    cloned = true;
    if (original) {
      const step = async (...args: string[]) => {
        const s = await gitRun(path, args, { env: { ...env, ...NO_PROMPT }, timeout: CLONE_TIMEOUT });
        if (s.code !== 0) throw new Error(`git ${args.join(' ')}: ${failureText(s)}`);
      };
      await step('remote', 'add', 'upstream', original.cloneUrl);
      await step('fetch', 'upstream', original.defaultBranch);
      // the original's main branch, which Obeya detects as the fork's `upstream` (see `detectUpstream`)
      await step('remote', 'set-head', 'upstream', original.defaultBranch);
    }
  } catch (e) {
    if (cloned) await undo();
    throw e;
  }
  return { path, made: true, undo, from: sourceName(source), ...(fork ? { fork } : {}) };
}
