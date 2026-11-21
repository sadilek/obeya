// Deleting a canvas (design: Deleting a canvas): what goes from disk once the canvas stopped and its
// rows left the database. Its repositories or folders, the clones the owner listed, pushed branches
// and open pull requests stay as they are.

import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { messageOf } from '../core/text';
import { usableId } from './canvas-config';
import { gitTry } from './git';

/** Obeya's own directories that hold something per canvas, each in a directory named by the canvas's id. */
export const CANVAS_DIRS = ['workspaces', 'read', 'images', 'files', 'answers', 'undo'] as const;

/** What deleting a stopped canvas removes from disk: per repository, what git has of its cards. */
export interface CanvasRemains {
  canvas: string;
  home: string;
  /** Every repository and listed clone of the configuration, on any canvas: nothing in them goes, wherever they lie. */
  keep: string[];
  repos: {
    /** The repository; a folder without git has nothing of the cards in git. */
    path: string;
    git: boolean;
    /** The clones the owner listed for it: never touched. */
    listed: string[];
    /** The branches its cards made in it: an adopted branch of the owner's is not among them. */
    branches: string[];
    /** Ends the apps and processes that run from the workspaces Obeya made for it (as they were when it stopped). */
    quiet: () => Promise<void>;
  }[];
}

/**
 * Removes what a deleted canvas left on disk: the processes running from its workspaces end, its
 * directories under Obeya's home (its clones and worktrees, read trees, images, files, looked-up
 * answers, a folder's undo snapshots) move aside at once, git forgets the worktrees among them and
 * the cards' local branches go. Settles then; the folders moved aside are removed in the
 * background (`removed`).
 */
export async function removeCanvasRemains(r: CanvasRemains): Promise<{ removed: Promise<void> }> {
  await Promise.all(r.repos.map((repo) => repo.quiet().catch((e) => console.error(`Obeya: ending what runs in the workspaces of ${repo.path}: ${messageOf(e)}`))));
  // each also as it really lies, where a link leads to it: what is kept is kept by either name
  const named = [...r.keep, ...r.repos.flatMap((repo) => [repo.path, ...repo.listed])].map((p) => resolve(p));
  const keep = [...new Set([...named, ...(await Promise.all(named.map((p) => realpath(p).catch(() => p))))])];
  // an id that is no folder of its own (empty, `.`, `..`) would name every canvas's folder, or Obeya's home: nothing goes
  const trash = usableId(r.canvas) ? (await Promise.all(CANVAS_DIRS.map((d) => moveAside(join(r.home, d, r.canvas), keep)))).flat() : [];
  if (!usableId(r.canvas)) console.error(`Obeya: the canvas id "${r.canvas}" names no folder of its own; its folders stay`);
  for (const repo of r.repos) {
    if (!repo.git || !(await there(repo.path))) continue;
    // the worktrees moved aside are no longer there: git forgets them, and then lets their branches go
    await gitTry(repo.path, 'worktree', 'prune');
    for (const branch of repo.branches) await gitTry(repo.path, 'branch', '-D', '--', branch);
  }
  const removed = Promise.all(trash.map((t) => rm(t, { recursive: true, force: true }).catch((e) => console.error(`Obeya: removing ${t}: ${messageOf(e)}`)))).then(() => {});
  return { removed };
}

/**
 * Moves `dir` aside under a name of its own beside it, so that a canvas added again under the same
 * id starts without it; returns where it went. Where a path in `keep` (a repository, a clone the
 * owner listed) lies inside it, only what is beside that path moves, level by level.
 */
async function moveAside(dir: string, keep: string[]): Promise<string[]> {
  const at = await lstat(dir).catch(() => null);
  if (!at) return [];
  // by its name here, and where it really lies (a folder of Obeya's home reached through a link)
  const real = await realpath(dir).catch(() => dir);
  const under = (k: string, d: string) => k === d || k.startsWith(d + sep);
  const inside = keep.filter((k) => under(k, dir) || under(k, real));
  if (inside.some((k) => k === dir || k === real)) return [];
  if (inside.length) {
    // a link is never followed: what it leads to is not Obeya's
    if (!at.isDirectory()) return [];
    const names = await readdir(dir).catch(() => [] as string[]);
    return (await Promise.all(names.map((name) => moveAside(join(dir, name), inside)))).flat();
  }
  const to = `${dir}.deleted-${Date.now()}`;
  try {
    await rename(dir, to);
    return [to];
  } catch (e) {
    console.error(`Obeya: moving ${dir} aside: ${messageOf(e)}`);
    return [];
  }
}

/** Whether something is at `path`. */
const there = (path: string) => lstat(path).then(
  () => true,
  () => false,
);
