// Setting up git in a folder that has none, for the first canvas and "+ Repository" in the
// configuration: first a preview of what the first commit holds (computed against a git directory
// of its own in the temp directory, so looking changes nothing in the folder), then, once the owner
// confirms, `git init`, a default `.gitignore` where the folder has none, and the first commit with
// every file not ignored, since workers only see committed files.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GitSetupPreview, LARGE_FILE } from '../core/types';
import { BadRequest } from './board';
import { GIT } from './git';

/** What Obeya writes as `.gitignore` where the folder has none: build output, dependencies, secrets. */
export const DEFAULT_GITIGNORE = `# Build output
dist/
build/
out/
target/
*.log

# Dependencies
node_modules/
.venv/
venv/
__pycache__/
vendor/

# Secrets
.env*
!.env.example
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*

# The system's own
.DS_Store
Thumbs.db
`;

// with the environment as it is now: on Windows each check reads PATH afresh (path.ts)
const run = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync([GIT, ...args], { cwd, env: process.env, stderr: 'pipe' });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};

/** Whether the path is a folder in which git finds no repository. */
export function withoutGit(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return !run(['-C', path, 'rev-parse', '--git-dir']).ok;
}

const needsFolder = (path: string) => {
  if (!withoutGit(path)) throw new BadRequest('invalid', `${path} is no folder without a git repository`);
};

/** The branch a new repository starts on: git's `init.defaultBranch`, else `main`. */
export function initialBranch(): string {
  return run(['config', '--get', 'init.defaultBranch']).out.trim() || 'main';
}

/** What the first commit of the folder would hold, and what stays out; changes nothing in the folder. */
export function previewGitSetup(path: string): GitSetupPreview {
  needsFolder(path);
  const own = existsSync(join(path, '.gitignore'));
  const scratch = mkdtempSync(join(tmpdir(), 'obeya-git-setup-'));
  try {
    const gitDir = join(scratch, 'git');
    if (!run(['init', '--quiet', '--bare', gitDir]).ok) throw new Error(`git init in ${scratch} failed`);
    const exclude = join(scratch, 'gitignore');
    writeFileSync(exclude, own ? '' : DEFAULT_GITIGNORE);
    const list = (...more: string[]) => {
      const r = run([`--git-dir=${gitDir}`, `--work-tree=${path}`, 'ls-files', '-z', '--others', '--exclude-standard', `--exclude-from=${exclude}`, ...more], path);
      if (!r.ok) throw new Error(`git ls-files in ${path}: ${r.err}`);
      return r.out.split('\0').filter(Boolean);
    };
    const files = list().map((f) => ({ path: f, bytes: size(join(path, f)) }));
    // the default .gitignore goes in with the files
    if (!own) files.push({ path: '.gitignore', bytes: Buffer.byteLength(DEFAULT_GITIGNORE) });
    const entries = new Map<string, { path: string; dir: boolean; files: number; bytes: number }>();
    for (const f of files) {
      const [top, ...rest] = f.path.split('/');
      const e = entries.get(top!) ?? { path: rest.length ? `${top}/` : top!, dir: rest.length > 0, files: 0, bytes: 0 };
      e.files++;
      e.bytes += f.bytes;
      entries.set(top!, e);
    }
    return {
      path,
      branch: initialBranch(),
      ...(own ? {} : { gitignore: DEFAULT_GITIGNORE }),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      entries: [...entries.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path)),
      large: files.filter((f) => f.bytes >= LARGE_FILE).sort((a, b) => b.bytes - a.bytes),
      ignored: list('--ignored', '--directory').sort(),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function size(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Makes the folder a repository with its first commit: on git's `init.defaultBranch` (else
 * `main`), with the default `.gitignore` where it has none, every file not ignored, under git's
 * name and e-mail. Undone where the commit fails, so the folder is as it was.
 */
export function setUpGit(path: string): { branch: string } {
  needsFolder(path);
  const name = run(['config', '--get', 'user.name']).out.trim();
  const email = run(['config', '--get', 'user.email']).out.trim();
  if (!name || !email) throw new BadRequest('noIdentity', "git has no name and e-mail for commits (user.name, user.email)");
  const branch = initialBranch();
  const gitignore = join(path, '.gitignore');
  const wrote = !existsSync(gitignore);
  if (wrote) writeFileSync(gitignore, DEFAULT_GITIGNORE);
  const steps = [
    ['init', '--quiet', `--initial-branch=${branch}`],
    ['add', '--all'],
    ['commit', '--quiet', '--allow-empty', '-m', 'First commit'],
  ];
  for (const step of steps) {
    const r = run(['-C', path, ...step]);
    if (r.ok) continue;
    rmSync(join(path, '.git'), { recursive: true, force: true });
    if (wrote) rmSync(gitignore, { force: true });
    throw new BadRequest('gitSetup', `git ${step[0]} in ${path}: ${r.err}`);
  }
  console.log(`Obeya: set up git in ${path} on ${branch}`);
  return { branch };
}
