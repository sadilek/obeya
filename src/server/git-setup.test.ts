import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GITIGNORE, previewGitSetup, setUpGit, withoutCommit, withoutGit } from './git-setup';
import { gitRepo, ownGlobalGitConfig, removeDir } from './testing';
import { git } from './git';

let dir: string;
let folder: string;

/** git's global configuration for the test, as the setup assistant's step for name and e-mail leaves it. */
const globalGit = ownGlobalGitConfig('[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-git-setup-test-'));
  // a project that never had git: dependencies, a secret, its code and one large file
  folder = join(dir, 'shop');
  for (const [file, text] of Object.entries({
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    '.env': 'TOKEN=secret\n',
    'src/app.ts': 'export {};\n',
    'README.md': '# Shop\n',
  })) {
    mkdirSync(join(folder, file, '..'), { recursive: true });
    writeFileSync(join(folder, file), text);
  }
  writeFileSync(join(folder, 'data.bin'), Buffer.alloc(2_000_000));
});
afterEach(() => removeDir(dir));

describe('setting up git in a folder', () => {
  test('the preview shows what goes in and what stays out, and changes nothing', () => {
    const before = readdirSync(folder).sort();
    const p = previewGitSetup(folder);
    expect(p).toMatchObject({ path: folder, branch: 'main', gitignore: DEFAULT_GITIGNORE, files: 4 });
    expect(p.entries.map((e) => e.path)).toEqual(['src/', '.gitignore', 'data.bin', 'README.md']);
    expect(p.entries[0]).toMatchObject({ dir: true, files: 1 });
    expect(p.large).toEqual([{ path: 'data.bin', bytes: 2_000_000 }]);
    expect(p.ignored).toEqual(['.env', 'node_modules/']);
    expect(readdirSync(folder).sort()).toEqual(before);
  });

  test('the first commit holds every file not ignored, without node_modules and .env', () => {
    expect(setUpGit(folder)).toEqual({ branch: 'main' });
    expect(git(folder, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(['.gitignore', 'README.md', 'data.bin', 'src/app.ts']);
    expect(git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(folder, 'log', '-1', '--format=%an <%ae>')).toBe('Ada Lovelace <ada@example.com>');
    expect(git(folder, 'status', '--porcelain')).toBe('');
    expect(withoutGit(folder)).toBe(false);
  });

  test("starts on git's init.defaultBranch, and keeps the folder's own .gitignore", () => {
    globalGit('[user]\n\tname = Ada\n\temail = ada@example.com\n[init]\n\tdefaultBranch = trunk\n');
    writeFileSync(join(folder, '.gitignore'), 'node_modules/\n');
    const p = previewGitSetup(folder);
    expect(p.branch).toBe('trunk');
    expect(p.gitignore).toBeUndefined();
    expect(p.ignored).toEqual(['node_modules/']);
    setUpGit(folder);
    expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(git(folder, 'ls-tree', '-r', '--name-only', 'trunk')).toContain('.env');
  });

  test('without a name and e-mail for commits nothing happens', () => {
    globalGit('');
    expect(() => setUpGit(folder)).toThrow(expect.objectContaining({ code: 'noIdentity' }));
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(existsSync(join(folder, '.gitignore'))).toBe(false);
  });

  test('a repository without a commit gets its first one on the branch HEAD names, with what was staged', () => {
    git(folder, 'init', '--quiet', '--initial-branch=trunk');
    git(folder, 'add', 'README.md');
    writeFileSync(join(folder, '.git', 'info', 'exclude'), 'data.bin\n');
    expect(withoutCommit(folder)).toBe('trunk');
    const p = previewGitSetup(folder);
    expect(p).toMatchObject({ repo: true, branch: 'trunk', gitignore: DEFAULT_GITIGNORE, files: 3 });
    expect(p.ignored).toEqual(['.env', 'data.bin', 'node_modules/']);
    expect(setUpGit(folder)).toEqual({ branch: 'trunk' });
    expect(git(folder, 'ls-tree', '-r', '--name-only', 'trunk').split('\n')).toEqual(['.gitignore', 'README.md', 'src/app.ts']);
    expect(withoutCommit(folder)).toBeNull();
    expect(() => setUpGit(folder)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  test('a failed first commit in a repository leaves what was staged as it was', () => {
    git(folder, 'init', '--quiet', '--initial-branch=main');
    git(folder, 'add', 'README.md');
    // a hook that refuses the commit
    writeFileSync(join(folder, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => setUpGit(folder)).toThrow(expect.objectContaining({ code: 'gitSetup' }));
    expect(git(folder, 'diff', '--cached', '--name-only')).toBe('README.md');
    expect(existsSync(join(folder, '.gitignore'))).toBe(false);
    expect(withoutCommit(folder)).toBe('main');
  });

  test('a clone of an empty repository is one without a commit; a folder inside a repository is not', () => {
    const origin = join(dir, 'origin.git');
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=trunk', origin);
    git(dir, 'clone', '--quiet', origin, 'clone');
    expect(withoutCommit(join(dir, 'clone'))).toBe('trunk');
    mkdirSync(join(dir, 'clone', 'sub'));
    expect(withoutCommit(join(dir, 'clone', 'sub'))).toBeNull();
    expect(withoutCommit(gitRepo(join(dir, 'repo')))).toBeNull();
  });

  test('only in a folder without git', () => {
    const repo = gitRepo(join(dir, 'repo'));
    expect(withoutGit(repo)).toBe(false);
    expect(withoutGit(join(dir, 'nirgends'))).toBe(false);
    expect(() => previewGitSetup(repo)).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => setUpGit(join(dir, 'nirgends'))).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
