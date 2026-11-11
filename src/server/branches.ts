// A repository's main branch: the one the owner set for it on this machine, or the one git tells;
// the folders without git, which have none; and the branches Obeya names for cards.

import { resolve } from 'node:path';
import { gitTry, isAncestor } from './git';

/**
 * The main branches the owner set for repositories on this machine (`RepoSettings.branch`), by
 * the repository's path, each read when it is asked for: a running canvas registers its own.
 */
const branchSettings = new Map<string, () => string | undefined>();

/** Registers where the main branch the owner set for the repository at `repoPath` is read; returns what takes it back. */
export function useBranchSetting(repoPath: string, branch: () => string | undefined): () => void {
  const key = resolve(repoPath);
  branchSettings.set(key, branch);
  return () => {
    if (branchSettings.get(key) === branch) branchSettings.delete(key);
  };
}

/** The main branch the owner set on this machine for the repository at `path`; none where they set none. */
export const branchSetting = (path: string): string | undefined => branchSettings.get(resolve(path))?.()?.trim() || undefined;

/** The repository's main branch: the one the owner set for it on this machine, else the one git tells (`detectBranch`); none in a folder without git. */
export async function defaultBranch(path: string): Promise<string> {
  if (isFolder(path)) return '';
  return branchSetting(path) || (await detectBranch(path));
}

/**
 * The folders without git in the configuration (`RepoConfig.git` false), by path: they have no
 * branch, and what Obeya reads of them (`.obeya/settings.json`, plan docs) it reads as the folder has
 * it. Marked whenever a configuration is resolved.
 */
const folders = new Set<string>();

/** Marks the path as a folder without git, or as a repository again. */
export function markFolder(path: string, folder: boolean) {
  if (folder) folders.add(resolve(path));
  else folders.delete(resolve(path));
}

/** Whether the path is a folder without git in the configuration. */
export const isFolder = (path: string): boolean => folders.has(resolve(path));

/**
 * The main branch of the repository at `cwd` as git tells it, where cards start from and work
 * lands: `origin`'s HEAD where the checkout knows one. Else its only branch that is not a card's;
 * else the one of them named as git's `init.defaultBranch`, `main` or `master`, so that a branch the
 * owner checks out for a while does not take its place; else the branch the checkout is on, unless
 * that is a card's; else `init.defaultBranch`, else `main`. From `branches` where they were read
 * already.
 */
export async function detectBranch(cwd: string, branches?: Branches | null): Promise<string> {
  const b = branches !== undefined ? branches : await readBranches(cwd);
  if (b?.originHead) return b.originHead;
  const own = [...(b?.local.keys() ?? [])].filter((name) => !name.startsWith(CARD_BRANCH));
  if (own.length === 1) return own[0]!;
  const init = await gitTry(cwd, 'config', '--get', 'init.defaultBranch');
  const usual = [init, 'main', 'master'].find((name) => name && own.includes(name));
  if (usual) return usual;
  const current = await gitTry(cwd, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (current && !current.startsWith(CARD_BRANCH)) return current;
  return init || 'main';
}

/** A repository's branches, what its main branch and that branch's commit are read from. */
export interface Branches {
  /** The branch `origin`'s HEAD names, where the checkout knows one. */
  originHead?: string;
  /** The local branches and their commits. */
  local: Map<string, string>;
  /** `origin`'s branches as the checkout last fetched them, and their commits. */
  remote: Map<string, string>;
  /** The names of the tags, where they were asked for. */
  tags?: Set<string>;
}

/**
 * Reads the `Branches` of the repository at `cwd`, all with one call: Obeya reads them each time it
 * needs the main branch, and each call of git takes a few milliseconds. Null where there is no git
 * repository. `tags`: with the names of the tags.
 */
export async function readBranches(cwd: string, tags = false): Promise<Branches | null> {
  const refs = await gitTry(cwd, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/', 'refs/remotes/origin/', ...(tags ? ['refs/tags/'] : []));
  if (refs == null) return null;
  const b: Branches = { local: new Map(), remote: new Map(), ...(tags ? { tags: new Set<string>() } : {}) };
  const ORIGIN = 'refs/remotes/origin/';
  for (const line of refs.split('\n')) {
    const [ref = '', commit = '', symref = ''] = line.split('\0');
    if (ref === `${ORIGIN}HEAD`) {
      if (symref.startsWith(ORIGIN)) b.originHead = symref.slice(ORIGIN.length);
    } else if (ref.startsWith('refs/heads/')) b.local.set(ref.slice('refs/heads/'.length), commit);
    else if (ref.startsWith(ORIGIN)) b.remote.set(ref.slice(ORIGIN.length), commit);
    else if (ref.startsWith('refs/tags/')) b.tags?.add(ref.slice('refs/tags/'.length));
  }
  return b;
}

/** What every card's branch begins with. */
export const CARD_BRANCH = 'obeya/';

/** `obeya/<slug>` from a card title, kept short and unique by the card id. */
export function branchName(title: string, cardId: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `${CARD_BRANCH}${slug || 'card'}-${cardId.slice(0, 6)}`;
}

/**
 * The default branch (`defaultBranch`) of the repository at `repoPath` and its commit as Obeya
 * reads it: the local branch where it has everything `origin`'s has (work lands there first), else
 * `origin`'s; HEAD in a repository with neither.
 */
export async function defaultBranchCommit(repoPath: string): Promise<{ branch: string; commit: string }> {
  // a folder without git has neither
  if (isFolder(repoPath)) return { branch: '', commit: '' };
  const branches = await readBranches(repoPath);
  const branch = branchSetting(repoPath) || (await detectBranch(repoPath, branches));
  return { branch, commit: await branchCommit(repoPath, branch, branches) };
}

/** The commit of the default branch `branch` by `defaultBranchCommit`'s rule, from `branches` where they were read already. */
export async function branchCommit(cwd: string, branch: string, branches?: Branches | null): Promise<string> {
  const b = branches !== undefined ? branches : await readBranches(cwd);
  const local = b?.local.get(branch);
  const remote = b?.remote.get(branch);
  if (!local || !remote) return local ?? remote ?? 'HEAD';
  if (local === remote) return local;
  // where git cannot be asked there, origin's
  return (await isAncestor(cwd, remote, local, false).catch(() => false)) ? local : remote;
}
