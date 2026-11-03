import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShared } from '../adapters';
import { readingTheme, readTheme } from './theme';
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

  test('read without the server waiting for git, the same as with it', async () => {
    const files = {
      '.obeya/theme.css': CSS,
      '.obeya/fonts.css': '@font-face { font-family: Acme; src: url(acme.woff2); }',
      '.obeya/acme.woff2': 'font',
      '.obeya/logo.svg': LOGO,
    };
    const waited = themeOf(gitRepo(join(root, 'waited'), files));
    const repo = gitRepo(join(root, 'not-waited'), files);
    expect(await readingTheme(repo, readShared(repo).obeyaTree)).toEqual(waited);
    expect(await readingTheme(gitRepo(join(root, 'not-waited-plain')), undefined)).toBeNull();
  }, 30_000);

  test('no way of writing a reference brings in what lies elsewhere', () => {
    const tricks = [
      // an escape in the function's name, upper case, white space inside
      String.raw`a { background: \75 rl(https://x.example/a.png); }`,
      String.raw`b { background: U\52L( "https://x.example/b.png" ); }`,
      // strings that name images
      `c { background: image-set("https://x.example/c.png" 1x, "logo.svg" 2x); }`,
      `d { background: -webkit-image-set('https://x.example/d.png' 1x); }`,
      `@import /* first */ "https://x.example/e.css" screen;`,
      String.raw`@\69mport url(https://x.example/f.css);`,
      // escapes inside the address
      String.raw`g { background: url(https\3a //x.example/g.png); }`,
      // an `@import` that goes, its neighbours then joined into a `url(`
      `i { background: u@import "x";rl("/outside.png"); }`,
      `u@import "https://x.example/j.css";rl("/outside.png") {}`,
      // a value put in where the page is drawn, and a stylesheet in a data: URL
      `k { --x: "/outside.png"; background: image-set(var(--x, "/outside.png") 1x); }`,
      `@import "data:text/css,l%7Bbackground:url(https://x.example/l.png)%7D";`,
      // a fallback holding a block, and a string in another function inside a reference
      `m { background: image-set(var(--x, {)}) "/outside.png"); }`,
      `n { background: image-set(random-item(1, "/outside.png") type("image/png") 1x); }`,
      // the `#` part of a file that goes in, ending its string early
      String.raw`h { background: url("logo.svg#\22 ) url(https://x.example/h.png) \22"); }`,
    ].join('\n');
    const repo = gitRepo(join(root, 'tricks'), { '.obeya/theme.css': tricks, '.obeya/logo.svg': LOGO });
    const css = themeOf(repo)!.css;
    // the `#` part stays inside its URL, its quote and parentheses encoded
    const part = '#%22%29%20url%28https://x.example/h.png%29%20%22"';
    expect(css).toContain(part);
    expect(css.replace(part, '')).not.toContain('x.example');
    expect(css).toContain(`"data:image/svg+xml;base64,${b64(LOGO)}" 2x`);
    // no rule imports anything (one inside a block is none, and stays as it is)
    expect(css).not.toMatch(/^\s*@import/m);
    // none of them a reference any more: no `url(` with it, no `image-set()` taking it
    expect(css).not.toMatch(/url\(\s*["']?\/outside/);
    expect(css).toContain('image-set("" 1x)');
    expect(css).toContain('random-item(1, "") type("image/png") 1x');
    expect(css).toContain('m { background: image-set("" ""); }');
    expect(css).toContain(' rl("/outside.png") {}');
    // a character beyond the basic plane in the `#` part
    expect(themeOf(gitRepo(join(root, 'astral'), { '.obeya/theme.css': 'a { background: url("logo.svg#😀"); }', '.obeya/logo.svg': LOGO }))!.css).toContain('#%F0%9F%98%80');
    // what is no reference stays as it was
    const plain = 'h1::before { content: "url(https://x.example/h.png)"; } /* url(https://x.example/i.png) */ .p { width: 2em; }';
    expect(themeOf(gitRepo(join(root, 'plain-strings'), { '.obeya/theme.css': plain }))!.css).toBe(plain);
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
