import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { defaultBranchCommit } from '../server/read-tree';
import { GIT } from '../server/workspaces';
import { generic } from './generic';
import * as kit from './kit';
import { obeya } from './obeya';
import type { RepoAdapter, RepoInfo } from './types';

/** Specific adapters first; the generic one matches every repository. */
const ADAPTERS: RepoAdapter[] = [obeya, generic];

/** Where a repository keeps its own adapter (`index.ts` in it), like `.vscode/` or `.claude/`. */
export const REPO_ADAPTER_DIR = '.obeya/adapter';

/** The module an adapter's own processes import Obeya's helpers from; passed to them as `OBEYA_KIT`. */
export const KIT_PATH = join(import.meta.dir, 'kit.ts');

export const adapterNames = () => ADAPTERS.map((a) => a.name);

/**
 * The repository's adapter: the one the configuration names (a built-in one's name, or the path of
 * a module, relative to the repository), else the repository's own (`.obeya/adapter/`), else the
 * first built-in one that matches.
 */
export function pickAdapter(repo: RepoInfo, name?: string): RepoAdapter {
  if (name) {
    const a = ADAPTERS.find((x) => x.name === name);
    if (a) return a;
    if (!/[/\\]|\.[cm]?[jt]s$/.test(name)) throw new Error(`Unknown adapter "${name}" (known: ${adapterNames().join(', ')}, or the path of a module)`);
    const file = isAbsolute(name) ? name : resolve(repo.path, name);
    if (!existsSync(file)) throw new Error(`adapter module ${file} does not exist`);
    return loadAdapter(file);
  }
  const own = repoAdapterFile(repo.path);
  if (own) return loadAdapter(own);
  return ADAPTERS.find((a) => a.matches(repo))!;
}

/**
 * Loads an adapter module: its default export is the adapter, or a function that makes it from
 * Obeya's helpers (`kit.ts`). What it leaves out comes from the generic adapter.
 */
function loadAdapter(file: string): RepoAdapter {
  let made: unknown;
  try {
    const mod = require(file) as { default?: unknown };
    made = typeof mod.default === 'function' ? mod.default(kit) : mod.default;
  } catch (e) {
    throw new Error(`adapter module ${file} does not load: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!made || typeof made !== 'object' || typeof (made as RepoAdapter).name !== 'string')
    throw new Error(`adapter module ${file} exports no adapter (a default export with a name, or a function returning one)`);
  return { ...generic, ...(made as Partial<RepoAdapter>) } as RepoAdapter;
}

/**
 * The repository's own adapter as its default branch has it, not as the checkout has it: a clone
 * is on a card's branch most of the time, and a branch from before the adapter came would take it
 * away; which commit of the default branch counts is `defaultBranchCommit`'s rule. Its files are
 * written once per version into the repository's git directory (`obeya/adapter-<tree>/`), where
 * checkouts and `git clean` do not reach, and an earlier version's files go. Null when the default branch has no `.obeya/adapter/index.ts`.
 */
export function repoAdapterFile(repoPath: string): string | null {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync([GIT, '-C', repoPath, ...args], { stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  };
  const { commit } = defaultBranchCommit(repoPath);
  const tree = git('rev-parse', '--verify', '--quiet', `${commit}:${REPO_ADAPTER_DIR}`)?.trim();
  if (!tree || git('cat-file', '-e', `${tree}:index.ts`) === null) return null;
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')?.trim();
  if (!common) return null;
  const versions = join(common, 'obeya');
  const dir = join(versions, `adapter-${tree.slice(0, 12)}`);
  if (!existsSync(join(dir, 'index.ts'))) {
    const files = (git('ls-tree', '-r', '-z', '--name-only', tree) ?? '').split('\0').filter(Boolean);
    const temp = `${dir}.${process.pid}-${Date.now()}`;
    for (const f of files) {
      const r = Bun.spawnSync([GIT, '-C', repoPath, 'cat-file', 'blob', `${tree}:${f}`], { stderr: 'ignore' });
      if (r.exitCode !== 0) continue;
      mkdirSync(dirname(join(temp, f)), { recursive: true });
      writeFileSync(join(temp, f), r.stdout);
    }
    // another process may have written the same version meanwhile: then its files stand
    try {
      renameSync(temp, dir);
    } catch {
      rmSync(temp, { recursive: true, force: true });
    }
    for (const d of readdirSync(versions)) if (/^adapter-[0-9a-f]{12}$/.test(d) && join(versions, d) !== dir) rmSync(join(versions, d), { recursive: true, force: true });
  }
  return join(dir, 'index.ts');
}
