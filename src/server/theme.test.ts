import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShared } from '../adapters';
import { readTheme } from './theme';
import { gitRepo } from './testing';
import { GIT, markFolder } from './workspaces';

const root = mkdtempSync(join(tmpdir(), 'obeya-theme-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const b64 = (s: string) => Buffer.from(s).toString('base64');
const themeOf = (repo: string) => readTheme(repo, readShared(repo).obeyaTree);

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const CSS = `@import "fonts.css";
@import url("https://fonts.example.com/inter.css");
:root { --accent: #1d4ed8; }
.top::before { content: ""; background: url(logo.svg) no-repeat; }
h1 { background: url('../README.md'); }
main { background-image: url("https://cdn.example.com/bg.png"); }
.when { mask: url(#cut); }
`;

describe('a repository’s theme', () => {
  test('is read from its default branch, with the files of .obeya/ it names inside; what lies elsewhere goes', () => {
    const repo = gitRepo(join(root, 'shop'), {
      'README.md': 'not for the pages\n',
      '.obeya/theme.css': CSS,
      '.obeya/fonts.css': '@font-face { font-family: Acme; src: url(acme.woff2); }',
      '.obeya/acme.woff2': 'font',
      '.obeya/logo.svg': LOGO,
    });
    const theme = themeOf(repo)!;
    expect(theme.css).toContain('--accent: #1d4ed8;');
    expect(theme.css).toContain(`url(data:image/svg+xml;base64,${b64(LOGO)})`);
    // an imported stylesheet with what it names in turn
    expect(theme.css).toContain(`@import url(data:text/css;charset=utf-8;base64,${b64(`@font-face { font-family: Acme; src: url(data:font/woff2;base64,${b64('font')}); }`)});`);
    // a file outside .obeya/ and the internet: neither goes in, nor loads from where it is
    expect(theme.css).not.toContain(b64('not for the pages\n'));
    expect(theme.css).toContain(`h1 { background: url(""); }`);
    expect(theme.css).not.toContain('example.com');
    expect(theme.css).toContain('url(#cut)');
    expect(theme.hash).toMatch(/^[0-9a-f]{16}$/);

    // a card's branch changes nothing; main does, and the hash follows what the pages carry
    git(repo, 'checkout', '-q', '-b', 'obeya/card');
    writeFileSync(join(repo, '.obeya/logo.svg'), '<svg/>');
    git(repo, 'commit', '-qam', 'card');
    expect(themeOf(repo)).toEqual(theme);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', 'obeya/card');
    const now = themeOf(repo)!;
    expect(now.css).toContain(`url(data:image/svg+xml;base64,${b64('<svg/>')})`);
    expect(now.hash).not.toBe(theme.hash);
  }, 30_000);

  test('none without .obeya/theme.css', () => {
    expect(themeOf(gitRepo(join(root, 'plain')))).toBeNull();
    expect(themeOf(gitRepo(join(root, 'settings-only'), { '.obeya/settings.json': '{}' }))).toBeNull();
  }, 30_000);

  test('a link in .obeya/ is no file of the theme: the theme does not go in, nor what it links to', () => {
    const repo = gitRepo(join(root, 'linked'), { 'secret.txt': 'secret', '.obeya/settings.json': '{}' });
    // links as git stores them (mode 120000), whatever the platform makes of them in a checkout
    const link = (path: string, to: string) => {
      const blob = Bun.spawnSync([GIT, '-C', repo, 'hash-object', '-w', '--stdin'], { stdin: Buffer.from(to), stdout: 'pipe' }).stdout.toString().trim();
      git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
    };
    link('.obeya/logo.svg', '../secret.txt');
    git(repo, 'commit', '-qm', 'link');
    writeFileSync(join(repo, 'theme.css'), '.top { background: url(logo.svg); }');
    const blob = git(repo, 'hash-object', '-w', 'theme.css');
    git(repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},.obeya/theme.css`);
    git(repo, 'commit', '-qm', 'theme');
    expect(themeOf(repo)!.css).toBe('.top { background: url(""); }');
    link('.obeya/theme.css', '../secret.txt');
    git(repo, 'commit', '-qm', 'theme as a link');
    expect(themeOf(repo)).toBeNull();
  }, 30_000);

  test('of a folder without git: as the folder has it, a file linked from elsewhere left out', () => {
    const folder = join(root, 'folder');
    mkdirSync(join(folder, '.obeya'), { recursive: true });
    writeFileSync(join(root, 'elsewhere.svg'), 'secret');
    writeFileSync(join(folder, '.obeya/logo.svg'), LOGO);
    symlinkSync(join(root, 'elsewhere.svg'), join(folder, '.obeya/linked.svg'));
    writeFileSync(join(folder, '.obeya/theme.css'), 'a { background: url(logo.svg); } b { background: url(linked.svg); }');
    markFolder(folder, true);
    const theme = readTheme(folder, undefined)!;
    expect(theme.css).toBe(`a { background: url(data:image/svg+xml;base64,${b64(LOGO)}); } b { background: url(""); }`);
    // changed in the folder, read anew
    writeFileSync(join(folder, '.obeya/theme.css'), 'a { color: red; }');
    expect(readTheme(folder, undefined)!.css).toBe('a { color: red; }');
  });
});
