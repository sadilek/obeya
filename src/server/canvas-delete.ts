// Deleting a canvas (design: Deleting a canvas): what goes from disk once the canvas stopped and its
// rows left the database. Its repositories or folders, the clones the owner listed, pushed branches
// and open pull requests stay as they are.

import { existsSync, readdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { messageOf } from '../core/text';
import { gitTry } from './git';

/** Obeya's own directories that hold something per canvas, each in a directory named by the canvas's id. */
export const CANVAS_DIRS = ['workspaces', 'read', 'images', 'files', 'answers', 'undo'] as const;

/** What deleting a stopped canvas removes from disk: per repository, what git has of its cards. */
export interface CanvasRemains {
  canvas: string;
  home: string;
  repos: {
    /** The repository; a folder without git has nothing of the cards in git. */
    path: string;
    git: boolean;
    /** The clones the owner listed for it: never touched. */
    listed: string[];
    /** The branches its cards made in it: an adopted branch of the owner's is not among them. */
    branches: string[];
    /** Ends the apps and processes that run from the workspaces Obeya made for it. */
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
  const keep = r.repos.flatMap((repo) => [repo.path, ...repo.listed]).map((p) => resolve(p));
  const trash = CANVAS_DIRS.flatMap((d) => moveAside(join(r.home, d, r.canvas), keep));
  for (const repo of r.repos) {
    if (!repo.git || !existsSync(repo.path)) continue;
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
function moveAside(dir: string, keep: string[]): string[] {
  if (!existsSync(dir)) return [];
  const inside = keep.filter((k) => k === dir || k.startsWith(dir + sep));
  if (inside.includes(dir)) return [];
  if (inside.length) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    return names.flatMap((name) => moveAside(join(dir, name), inside));
  }
  const to = `${dir}.deleted-${Date.now()}`;
  try {
    renameSync(dir, to);
    return [to];
  } catch (e) {
    console.error(`Obeya: moving ${dir} aside: ${messageOf(e)}`);
    return [];
  }
}
