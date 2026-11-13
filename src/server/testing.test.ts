import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitClone, gitRepo, identify, removeDir } from './testing';
import { git } from './git';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'obeya-testing-'))));
afterEach(() => removeDir(dir));

describe('gitClone, a copy where it can be', () => {
  test('has what `git clone` makes: a bare one takes hooks', () => {
    const repo = gitRepo(join(dir, 'repo'));
    const origin = gitClone(repo, join(dir, 'origin.git'), { bare: true });
    writeFileSync(join(origin, 'hooks/pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    git(repo, 'remote', 'add', 'origin', origin);
    expect(() => git(repo, 'push', '--quiet', 'origin', 'main:other')).toThrow('protected branch');
  });

  test("pushes go to its source, also where the path has a # or a ; (which git writes quoted)", () => {
    const odd = join(dir, 'a #b;c');
    mkdirSync(odd);
    const source = gitRepo(join(odd, 'source'));
    const clone = gitClone(source, join(odd, 'clone'));
    expect(git(clone, 'config', 'remote.origin.url')).toBe(source);
    identify(clone);
    git(clone, 'push', '--quiet', 'origin', 'HEAD:pushed');
    expect(git(source, 'branch', '--list', 'pushed')).toContain('pushed');
  });

  test('a repository in reftable (a user\'s init.defaultRefFormat) whose branch moved is cloned, not copied', () => {
    // in a process of its own: git sees only the environment a process started with
    const script = `
      import { gitClone, gitRepo, identify, removeTemplates } from ${JSON.stringify(join(import.meta.dir, 'testing.ts'))};
      import { git } from ${JSON.stringify(join(import.meta.dir, 'git.ts'))};
      import { existsSync, writeFileSync } from 'node:fs';
      const source = gitRepo(${JSON.stringify(join(dir, 'source'))});
      if (!existsSync(${JSON.stringify(join(dir, 'source', '.git', 'reftable'))})) { console.log('no reftable'); process.exit(0); }
      identify(source);
      writeFileSync(source + '/later.md', 'later');
      git(source, 'add', '.');
      git(source, 'commit', '--quiet', '-m', 'later');
      console.log(git(gitClone(source, ${JSON.stringify(join(dir, 'clone'))}), 'log', '--format=%s', '-1'));
      removeTemplates();
    `;
    const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
    const env = { ...process.env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'init.defaultRefFormat', [`GIT_CONFIG_VALUE_${n}`]: 'reftable' };
    const r = Bun.spawnSync([process.execPath, '-e', script], { env, stderr: 'pipe' });
    expect(r.stderr.toString()).toBe('');
    // a git before 2.45 knows no reftable: nothing to guard against there
    expect(['later', 'no reftable']).toContain(r.stdout.toString().trim());
  });
});
