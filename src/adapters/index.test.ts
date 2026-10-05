import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoInfo } from '../server/repo';
import { gitRepo } from '../server/testing';
import { git } from '../server/workspaces';
import { pickAdapter } from '.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-adapters-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// an adapter as a repository carries it: Obeya's helpers come as the argument
const OWN = (name: string) => `export default (kit) => ({ name: '${name}', canvasId: () => 'shop', canvasName: () => kit.esc('Shop & Co'), land: 'main' });\n`;

describe('pickAdapter', () => {
  test("takes the repository's own adapter, filled from the generic one", () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/adapter/index.ts': OWN('shop') });
    const a = pickAdapter(repoInfo(repo));
    expect(a.name).toBe('shop');
    expect(a.canvasName(repoInfo(repo))).toBe('Shop &amp; Co');
    expect(a.land).toBe('main');
    // what it leaves out comes from the generic adapter
    expect(a.planDocs.dir).toBe('docs/plan');
    expect(a.workspaces).toBe('clones');
  });

  test('reads it from the default branch, whatever the checkout is on', () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/adapter/index.ts': OWN('first') });
    // a card's branch from before the adapter changed, and an edit not committed
    git(repo, 'checkout', '--quiet', '-b', 'card');
    git(repo, 'rm', '--quiet', '-r', '.obeya');
    git(repo, 'commit', '--quiet', '-m', 'no adapter on this branch');
    mkdirSync(join(repo, '.obeya/adapter'), { recursive: true });
    writeFileSync(join(repo, '.obeya/adapter/index.ts'), OWN('uncommitted'));
    expect(pickAdapter(repoInfo(repo)).name).toBe('first');

    // a new version on main: its files are written anew, the earlier version's go
    rmSync(join(repo, '.obeya'), { recursive: true });
    git(repo, 'checkout', '--quiet', 'main');
    writeFileSync(join(repo, '.obeya/adapter/index.ts'), OWN('second'));
    git(repo, 'commit', '--quiet', '-am', 'second adapter');
    expect(pickAdapter(repoInfo(repo)).name).toBe('second');
    expect(readdirSync(join(repo, '.git/obeya')).length).toBe(1);
    // the checkout stays as it was
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('takes a module the configuration names by its path, relative to the repository', () => {
    const repo = gitRepo(join(dir, 'shop'));
    writeFileSync(join(dir, 'outside.ts'), OWN('outside'));
    expect(pickAdapter(repoInfo(repo), '../outside.ts').name).toBe('outside');
    expect(pickAdapter(repoInfo(repo), join(dir, 'outside.ts')).name).toBe('outside');
    expect(() => pickAdapter(repoInfo(repo), '../missing.ts')).toThrow('does not exist');
    writeFileSync(join(dir, 'empty.ts'), 'export const x = 1;\n');
    expect(() => pickAdapter(repoInfo(repo), join(dir, 'empty.ts'))).toThrow('exports no adapter');
    expect(() => pickAdapter(repoInfo(repo), 'nonesuch')).toThrow('Unknown adapter "nonesuch"');
  });

  test('a built-in name wins over the repository, and a repository without its own gets the generic one', () => {
    const repo = gitRepo(join(dir, 'shop'), { 'README.md': 'hi\n', '.obeya/adapter/index.ts': OWN('shop') });
    expect(pickAdapter(repoInfo(repo), 'generic').name).toBe('generic');
    const plain = gitRepo(join(dir, 'plain'));
    expect(pickAdapter(repoInfo(plain)).name).toBe('generic');
    expect(existsSync(join(plain, '.git/obeya'))).toBe(false);
  });
});
