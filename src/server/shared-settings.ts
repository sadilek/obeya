// "Take over into the repository for everyone": a repository's settings for this machine go into its
// `.obeya/settings.json`, which a fresh clone brings with it. Where work lands on the main branch
// they are committed there; where it goes through pull requests, the commit goes out as one, or,
// where work may go straight to main as well, is pushed there. None of them touches what the
// checkout has beside the file, nor a card's workspace.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShared, REPO_SETTINGS_FILE } from '../adapters';
import { layerSettings, SHARED_FIELDS, type SettingsShared, type SharedSettings } from '../core/types';
import { BadRequest } from './board';
import type { Forge } from './forge';
import { defaultBranchAsync } from './branches';
import { GIT, LOOK } from './git';
import { messageOf } from '../core/text';
import { spawnOutput } from './spawn';
import { canonical } from './trust';

interface Run {
  code: number;
  out: string;
  err: string;
}

/** git, without blocking the server: a fetch or push waits for the remote. */
async function gitRun(repoPath: string, args: string[], o: { env?: Record<string, string>; stdin?: string } = {}): Promise<Run> {
  const r = await spawnOutput([GIT, '-C', repoPath, ...args], {
    stdin: o.stdin !== undefined ? new Blob([o.stdin]) : 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...o.env },
  });
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

async function must(repoPath: string, args: string[], o?: Parameters<typeof gitRun>[2]): Promise<string> {
  const r = await gitRun(repoPath, args, o);
  if (r.code !== 0) throw new BadRequest('settingsShare', `git ${args[0]}: ${r.err || r.out || `exit code ${r.code}`}`);
  return r.out;
}

/**
 * The text of `.obeya/settings.json` with `mine` in front of what the file at `commit` holds: its
 * fields in the dialog's order, what else it holds after them, as it was. `same` where that holds
 * nothing the file does not (however it orders its fields): then there is nothing to commit.
 */
export async function sharedText(repoPath: string, commit: string, mine: SharedSettings): Promise<{ text: string; same: boolean; before?: SharedSettings; after: SharedSettings }> {
  const r = await gitRun(repoPath, ['cat-file', 'blob', `${commit}:${REPO_SETTINGS_FILE}`]);
  const read = r.code === 0 ? parseShared(r.out) : { problems: [] };
  const raw = read.raw ?? {};
  const merged = layerSettings<Record<string, unknown>>(raw, mine as Record<string, unknown>)!;
  const ordered: Record<string, unknown> = {};
  for (const k of SHARED_FIELDS) if (merged[k] !== undefined) ordered[k] = merged[k];
  for (const [k, v] of Object.entries(merged)) if (!(k in ordered)) ordered[k] = v;
  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  const same = r.code === 0 && canonical(raw) === canonical(ordered);
  return { text, same, ...(read.settings ? { before: read.settings } : {}), after: parseShared(text).settings ?? {} };
}

/** A commit with `text` as `.obeya/settings.json` on top of `parent`, made beside the checkout (its index and files stay as they are). */
async function commitBeside(repoPath: string, parent: string, text: string, message: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-settings-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const blob = await must(repoPath, ['hash-object', '-w', '--stdin'], { stdin: text });
    await must(repoPath, ['read-tree', parent], { env });
    await must(repoPath, ['update-index', '--add', '--cacheinfo', `100644,${blob},${REPO_SETTINGS_FILE}`], { env });
    const tree = await must(repoPath, ['write-tree'], { env });
    const commit = await gitRun(repoPath, ['commit-tree', tree, '-p', parent, '-m', message]);
    if (commit.code !== 0) {
      if (/user\.email|user\.name|identity/i.test(commit.err)) throw new BadRequest('noIdentity', "git has no name and e-mail for commits (user.name, user.email)");
      throw new BadRequest('settingsShare', `git commit-tree: ${commit.err}`);
    }
    return commit.out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The subject of a change of settings' commit and pull request, which names its fields: `…: checks, land`. */
const subjectOf = (mine: SharedSettings) => `Obeya settings for everyone: ${Object.keys(mine).join(', ')}`;

/**
 * Commits `mine` into the repository's `.obeya/settings.json` on its main branch (the local one,
 * where work lands): beside the checkout, which, where it is on that branch, then has the file as
 * committed. Refused where the checkout has changes of its own in the file; nothing committed where
 * the file holds them already.
 */
export async function commitShared(repoPath: string, mine: SharedSettings): Promise<SettingsShared & { before?: SharedSettings; after: SharedSettings }> {
  const branch = await defaultBranchAsync(repoPath);
  const parent = (await gitRun(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).out;
  if (!parent) throw new BadRequest('settingsShare', `the repository has no local branch ${branch}`);
  const onIt = (await gitRun(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out === branch;
  if (onIt && (await gitRun(repoPath, [...LOOK, 'status', '--porcelain', '--', REPO_SETTINGS_FILE])).out)
    throw new BadRequest('settingsDirty', `${REPO_SETTINGS_FILE} has changes of its own in ${repoPath}; commit or discard them first`);
  const { text, same, before, after } = await sharedText(repoPath, parent, mine);
  if (same) return { unchanged: true, branch, ...(before ? { before } : {}), after };
  const commit = await commitBeside(repoPath, parent, text, subjectOf(mine));
  await must(repoPath, ['update-ref', '-m', 'obeya: settings for everyone', `refs/heads/${branch}`, commit, parent]);
  // the checkout on the branch gets the file as committed, in its index and among its files
  if (onIt) await must(repoPath, ['checkout', commit, '--', REPO_SETTINGS_FILE]);
  return { committed: commit, branch, ...(before ? { before } : {}), after };
}

/** A commit with `mine` in `.obeya/settings.json` on top of `origin`'s main branch, as just fetched; none where it holds them already. */
async function onOrigin(repoPath: string, mine: SharedSettings) {
  const branch = await defaultBranchAsync(repoPath);
  await must(repoPath, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const parent = await must(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  const { text, same, after } = await sharedText(repoPath, parent, mine);
  return { branch, text, after, commit: same ? undefined : await commitBeside(repoPath, parent, text, subjectOf(mine)) };
}

/**
 * Pushes `mine` in `.obeya/settings.json` straight onto `origin`'s main branch, for a repository
 * whose work goes out as pull requests but may go straight to main (`direct`): a commit on top of
 * it, pushed without force, so a protected branch, or one that moved meanwhile, refuses it.
 */
export async function pushShared(repoPath: string, mine: SharedSettings): Promise<Exclude<SettingsShared, { pr: string }> & { after: SharedSettings }> {
  const { branch, commit, after } = await onOrigin(repoPath, mine);
  if (!commit) return { unchanged: true, branch, after };
  await must(repoPath, ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]);
  await must(repoPath, ['update-ref', `refs/remotes/origin/${branch}`, commit]);
  return { committed: commit, branch, after };
}

/**
 * Puts `mine` into the repository's `.obeya/settings.json` as a pull request against `origin`'s
 * main branch: a commit on top of it, pushed to a branch of its own, and the pull request opened.
 * None where that branch holds them already.
 */
export async function proposeShared(repoPath: string, mine: SharedSettings, forge: Forge, now = new Date()): Promise<SettingsShared> {
  const { branch, text, commit } = await onOrigin(repoPath, mine);
  if (!commit) return { unchanged: true, branch };
  const head = `obeya-settings-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
  await must(repoPath, ['push', '--quiet', 'origin', `${commit}:refs/heads/${head}`]);
  try {
    const pr = await forge.open(repoPath, {
      base: branch,
      head,
      title: subjectOf(mine),
      body: `Takes the Obeya settings set on one machine over into \`${REPO_SETTINGS_FILE}\`, so that everyone who runs Obeya on this repository gets them (a fresh clone too):\n\n\`\`\`json\n${text}\`\`\``,
    });
    return { pr };
  } catch (e) {
    throw new BadRequest('settingsShare', messageOf(e));
  }
}
