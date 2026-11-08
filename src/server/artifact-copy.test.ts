import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactCopy } from './artifact-copy';
import { artifactFiles } from './demo-page';

const root = mkdtempSync(join(tmpdir(), 'obeya-artifact-copy-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** An artifact's directory with these files (and these links to files elsewhere), and its copy. */
async function copyOf(files: Record<string, string>, links: Record<string, string> = {}) {
  const dir = join(root, `a${n++}`);
  for (const [f, data] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), data);
  }
  for (const [f, to] of Object.entries(links)) symlinkSync(to, join(dir, f));
  return { dir, copy: await artifactCopy(dir, artifactFiles(dir), 'https://demos.example.com') };
}

/** The page's first script, the one answering requests for its files, run with this page address. */
function answering(index: string, href: string) {
  const code = /<script>(\(\(\) => \{\n {2}const files[\s\S]*?)<\/script>/.exec(index)![1]!;
  const asked: string[] = [];
  const window = { fetch: async (input: RequestInfo) => (asked.push(String(input instanceof Request ? input.url : input)), new Response('from the site')) };
  const opened: string[] = [];
  class XMLHttpRequest {
    open(_method: string, url: string) {
      opened.push(url);
    }
  }
  new Function('window', 'location', 'document', 'XMLHttpRequest', code)(window, { href }, { baseURI: href }, XMLHttpRequest);
  return { fetch: window.fetch as (input: RequestInfo, init?: RequestInit) => Promise<Response>, xhr: () => new XMLHttpRequest(), asked, opened };
}

describe('artifactCopy', () => {
  test('gives its other pages the same policy, which it may open in its frame', async () => {
    const { copy } = await copyOf({ 'index.html': '<a href="more/second.html">more</a>', 'more/second.html': '<script>fetch("https://elsewhere.example/")</script>' });
    expect(copy.get('more/second.html')).toStartWith(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' https://demos.example.com data: blob:;`);
    expect(copy.get('more/second.html')).toEndWith('<script>fetch("https://elsewhere.example/")</script>');
    expect(copy.get('more/second.html')).not.toContain('obeyaHeight');
  });

  test('starts with the policy that lets the page load its own files alone, ahead of anything of its own', async () => {
    const { copy } = await copyOf({ 'index.html': '<!-- a comment --><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>' });
    const index = copy.get('index.html')!;
    expect(index).toStartWith(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' https://demos.example.com data: blob:; script-src 'self' https://demos.example.com 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src 'self' https://demos.example.com 'unsafe-inline' data: blob:; form-action 'none'"><meta http-equiv="x-dns-prefetch-control" content="off"><!-- a comment -->`,
    );
  });

  test('bundles module scripts into the page, without the paths of this machine', async () => {
    const { dir, copy } = await copyOf({
      'index.html': `<html><body><script type="module" src="app.js"></script>
<script type="module">import { label } from './lib/label.js'; document.title = label;</script>
<script type="module">document.title = 'alone';</script>
<script>var classic = 1;</script></body></html>`,
      'app.js': "import { label } from './lib/label.js';\nimport * as d3 from 'https://cdn.example/d3.js';\ndocument.body.append(label, '</script>');",
      'lib/label.js': "export const label = 'from the module';",
    });
    const index = copy.get('index.html')!;
    expect(index).not.toContain('src="app.js"');
    expect(index).toMatch(/<script type="module">var label = "from the module";[\s\S]*document\.body\.append\(label, "<\\\/script>"\);\n<\/script>/);
    // an import from elsewhere stays one; an inline module that imports a file beside it is bundled, one that imports none stays as it is
    expect(index).toContain('import * as d3 from "https://cdn.example/d3.js"');
    expect(index).toMatch(/<script type="module">var label = "from the module";\s*document\.title = label;/);
    expect(index).toContain(`<script type="module">document.title = 'alone';</script>`);
    expect(index).toContain('<script>var classic = 1;</script>');
    expect(index).not.toContain(dir);
    expect(index).not.toMatch(/^\/\/ .*label\.js$/m);
    expect(index).toContain('obeyaHeight');
    // scripts and stylesheets load without CORS: no table of files to fetch
    expect(index).not.toContain('const files');
    expect([...copy.keys()]).toEqual(['index.html']);
  });

  test('a module script that does not bundle stays as it is', async () => {
    const { copy } = await copyOf({ 'index.html': '<script type="module" src="app.js"></script>', 'app.js': "import './missing.js';" });
    expect(copy.get('index.html')).toContain('<script type="module" src="app.js"></script>');
  });

  test('a module script that loads an image or a stylesheet stays as it is', async () => {
    const { copy } = await copyOf({
      'index.html': '<script type="module" src="app.js"></script><script type="module" src="style.js"></script>',
      'app.js': "import logo from './logo.png'; document.body.append(logo);",
      'style.js': "import './site.css';",
      'logo.png': 'png',
      'site.css': 'body { margin: 0; }',
    });
    expect(copy.get('index.html')).toContain('<script type="module" src="app.js"></script><script type="module" src="style.js"></script>');
  });

  test('a module script that imports a file as a type keeps the type', async () => {
    const { copy } = await copyOf({
      'index.html': '<script type="module" src="app.js"></script>',
      'app.js': "import text from './data.json' with { type: 'text' };\nimport json from './data.txt' with { type: 'json' };\ndocument.title = text.trim() + json.title;",
      'data.json': '{"title":"from the file"}',
      'data.txt': '{"title":"from the file"}',
    });
    const index = copy.get('index.html')!;
    expect(index).toContain(`var data_default = '{"title":"from the file"}';`);
    expect(index).toContain('title: "from the file"');
    expect(index).not.toMatch(/^\/\/ /m);
  });

  test('the files a page names go into it, so it asks the site for none of them', async () => {
    const { copy } = await copyOf({
      'index.html': `<style>@font-face { font-family: T; src: url("fonts/t.woff2") format("woff2"); } body { background: url(bg.png); }</style>
<link rel="stylesheet" href="css/site.css" media="print"><link rel="icon" href="bg.png"><link rel="canonical" href="bg.png">
<img src="shots/a%20b.png?v=1" alt="A"><img srcset="bg.png 1x,shots/a%20b.png 2x" src="missing.png">
<div style="background: url('bg.png')"></div><svg><image xlink:href="bg.png"/></svg>
<video src="clip.mp4" poster="bg.png"></video><script src="app.js" defer></script>
<script>el.style.background = 'url(bg.png)';</script><a href="bg.png">full size</a>`,
      'css/site.css': "@import 'more.css'; @font-face { font-family: U; src: url('../fonts/t.woff2?v=2'); }",
      'css/more.css': "@import 'site.css'; p { background: url(../bg.png) }",
      'fonts/t.woff2': 'wOF2',
      'bg.png': 'png',
      'shots/a b.png': 'shot',
      'clip.mp4': 'mp4',
      'app.js': 'var classic = 1;',
      'more/second.html': '<img src="../bg.png"><img src="bg.png">',
      'more/bg.png': 'more',
    });
    const index = copy.get('index.html')!;
    const png = 'data:image/png;base64,cG5n';
    const shot = 'data:image/png;base64,c2hvdA==';
    expect(index).toContain(`src: url("data:font/woff2;base64,d09GMg==") format("woff2")`);
    expect(index).toContain(`body { background: url(${png}); }`);
    // a stylesheet with what it names, the stylesheets it imports too, but not one that imports itself again
    const css = /<link rel="stylesheet" href="data:text\/css;charset=utf-8;base64,([^"]+)" media="print">/.exec(index)![1]!;
    const site = Buffer.from(css, 'base64').toString();
    expect(site).toEndWith("@font-face { font-family: U; src: url('data:font/woff2;base64,d09GMg=='); }");
    const more = Buffer.from(/^@import url\(data:text\/css;charset=utf-8;base64,([^)]+)\);/.exec(site)![1]!, 'base64').toString();
    expect(more).toBe(`@import 'site.css'; p { background: url(${png}) }`);
    expect(index).toContain(`<link rel="icon" href="${png}"><link rel="canonical" href="bg.png">`);
    expect(index).toContain(`<img src="${shot}" alt="A"><img srcset="${png} 1x, ${shot} 2x" src="missing.png">`);
    expect(index).toContain(`<div style="background: url('${png}')"></div><svg><image xlink:href="${png}" /></svg>`);
    expect(index).toContain(`<video src="data:video/mp4;base64,bXA0" poster="${png}"></video><script src="data:text/javascript;charset=utf-8;base64,dmFyIGNsYXNzaWMgPSAxOw==" defer></script>`);
    expect(index).toContain(`<script>el.style.background = 'url(${png})';</script>`);
    // a link navigates the frame, which carries the login's cookie
    expect(index).toContain('<a href="bg.png">full size</a>');
    // another page names its files from where it sits
    expect(copy.get('more/second.html')).toEndWith(`<img src="${png}"><img src="data:image/png;base64,bW9yZQ==">`);
    expect(copy.has('css/site.css')).toBe(false);
  });

  test('reads a srcset as browsers do, keeps the part a # names, and finds a URL in quotes with a space', async () => {
    const { copy } = await copyOf({
      'index.html': `<img srcset="data:image/png;base64,eA== 1x, a.png 2x,b.png, a.png  300w">
<style>p { filter: URL("fx.svg#blur"); background: url( 'a b.png' ) }</style>`,
      'a.png': 'a',
      'b.png': 'b',
      'fx.svg': '<svg/>',
      'a b.png': 'ab',
    });
    const index = copy.get('index.html')!;
    expect(index).toContain('<img srcset="data:image/png;base64,eA== 1x, data:image/png;base64,YQ== 2x, data:image/png;base64,Yg==, data:image/png;base64,YQ== 300w">');
    expect(index).toContain(`filter: url("data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}#blur")`);
    expect(index).toContain("background: url('data:image/png;base64,YWI=')");
  });

  test('names files from where a <base> of the page puts them, and leaves a page whose <base> leads elsewhere as it is', async () => {
    const { copy } = await copyOf({
      'index.html': '<base href="assets/"><img src="logo.png">',
      'logo.png': 'root',
      'assets/logo.png': 'assets',
      'away.html': '<base href="https://elsewhere.example/"><img src="logo.png">',
    });
    expect(copy.get('index.html')).toContain(`<img src="data:image/png;base64,${Buffer.from('assets').toString('base64')}">`);
    expect(copy.get('away.html')).toEndWith('<img src="logo.png">');
  });

  test('stylesheets that import each other many times over stop growing the page', async () => {
    const files: Record<string, string> = { 'index.html': '<link rel="stylesheet" href="s0.css">' };
    for (let i = 0; i < 14; i++) files[`s${i}.css`] = `@import "s${i + 1}.css"; @import "s${i + 1}.css"; @import "s${i + 1}.css"; @import "s${i + 1}.css";`;
    files['s14.css'] = `p { content: "${'x'.repeat(1000)}" }`;
    const { copy } = await copyOf(files);
    expect(copy.get('index.html')!.length).toBeLessThan(70 * 1024 * 1024);
  });

  test('answers fetch and XMLHttpRequest for the files beside the page from inside it', async () => {
    const { copy } = await copyOf({
      'index.html': '<!doctype html><html lang="en"><head><title>T</title><script>first()</script></head><body></body></html>',
      'data.json': '{"rows":[1,2,3],"end":"</script>"}',
      'nested/table.csv': 'a,b\n1,2\n',
      'chart.png': 'png',
    });
    const index = copy.get('index.html')!;
    // before any script of the page
    expect(index.indexOf('const files')).toBeLessThan(index.indexOf('first()'));
    expect(index).toContain('<!doctype html><html lang="en"><head><script>');
    expect(index).not.toContain('chart.png');
    const page = answering(index, 'https://demos.example/page-1/artifact/index.html');
    expect(await (await page.fetch('data.json')).json()).toEqual({ rows: [1, 2, 3], end: '</script>' });
    const csv = await page.fetch(new Request('https://demos.example/page-1/artifact/nested/table.csv?v=3'));
    expect([csv.headers.get('content-type'), await csv.text()]).toEqual(['text/csv', 'a,b\n1,2\n']);
    page.xhr().open('GET', './data.json');
    expect(page.opened[0]).toStartWith('blob:');
    // anything else goes to the site: another file, another directory, a POST
    for (const [url, init] of [['chart.png'], ['../index.html'], ['https://other.example/page-1/artifact/data.json'], ['data.json', { method: 'POST' }]] as const)
      expect(await (await page.fetch(url, init)).text()).toBe('from the site');
    expect(page.asked).toEqual(['chart.png', '../index.html', 'https://other.example/page-1/artifact/data.json', 'data.json']);
    page.xhr().open('POST', 'data.json');
    expect(page.opened[1]).toBe('data.json');
  });

  describe('takes in no file from outside its directory', () => {
    const file = join(root, 'secret.json');
    writeFileSync(file, '{"token":"of the owner"}');
    // as a module names it, with slashes on Windows too: a backslash in a string escapes
    const secret = file.replaceAll('\\', '/');
    writeFileSync(join(root, 'secret.woff2'), 'the owner');

    test('a module script that imports one stays as it is', async () => {
      const { copy } = await copyOf({
        'index.html': `<script type="module" src="app.js"></script>
<script type="module">import { label } from './label.js'; import s from '${secret}'; document.title = label + s.token;</script>`,
        'app.js': "import { label } from './label.js';\nimport s from '../secret.json';\ndocument.title = label + s.token;",
        'label.js': "export const label = 'from the module';",
      });
      const index = copy.get('index.html')!;
      expect(index).toContain('<script type="module" src="app.js"></script>');
      expect(index).toContain(`import s from '${secret}';`);
      expect(index).not.toContain('of the owner');
    });

    test('nor one that leads out through a link', async () => {
      const outside = join(root, 'outside.js');
      writeFileSync(outside, "export const token = 'of the owner';");
      const { copy } = await copyOf(
        {
          'index.html': '<script type="module" src="app.js"></script><script type="module" src="linked.js"></script>',
          'app.js': "import { token } from './lib.js'; document.title = token;",
        },
        { 'lib.js': outside, 'linked.js': outside },
      );
      expect(copy.get('index.html')).toContain('<script type="module" src="app.js"></script><script type="module" src="linked.js"></script>');
      expect(copy.get('index.html')).not.toContain('of the owner');
    });

    test('nor one with a macro, which would run at the build', async () => {
      const ran = join(root, 'macro-ran');
      const { copy } = await copyOf({
        'index.html': '<script type="module" src="app.js"></script>',
        'app.js': "import { steal } from './macro.js' with { type: 'macro' };\ndocument.title = steal();",
        'macro.js': `import { readFileSync, writeFileSync } from 'node:fs';\nexport const steal = () => (writeFileSync(${JSON.stringify(ran)}, ''), readFileSync(${JSON.stringify(secret)}, 'utf8'));`,
      });
      expect(copy.get('index.html')).toContain('<script type="module" src="app.js"></script>');
      expect(copy.get('index.html')).not.toContain('of the owner');
      expect(existsSync(ran)).toBe(false);
    });

    test('nor one that imports a package a tsconfig.json maps there', async () => {
      const { copy } = await copyOf({
        'index.html': '<script type="module" src="app.js"></script>',
        'app.js': "import { label } from './label.js'; import s from 'secret'; document.title = label + s.token;",
        'label.js': "export const label = 'from the module';",
        'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { secret: [secret] } } }),
      });
      expect(copy.get('index.html')).toContain('<script type="module" src="app.js"></script>');
      expect(copy.get('index.html')).not.toContain('of the owner');
    });

    // where `C:` is a folder like any other: the path the check goes by is the one Bun read
    test.skipIf(process.platform === 'win32')('nor one in a folder named like a Windows drive, where a link of that name in the working directory leads into the artifact', async () => {
      const drive = join(root, 'outside', 'C:');
      mkdirSync(drive, { recursive: true });
      writeFileSync(join(drive, 'secret.js'), "export const token = 'of the owner';");
      const cwd = process.cwd();
      const work = mkdtempSync(join(root, 'cwd-'));
      try {
        process.chdir(work);
        const dir = join(root, `a${n}`);
        symlinkSync(dir, join(work, 'C:'));
        const { copy } = await copyOf({
          'index.html': '<script type="module" src="app.js"></script>',
          'app.js': `import { token } from '${join(drive, 'secret.js')}'; document.title = token;`,
          'secret.js': "export const token = 'harmless';",
        });
        expect(copy.get('index.html')).not.toContain('of the owner');
      } finally {
        process.chdir(cwd);
      }
    });

    test("a package.json's paths for browsers hold inside it, and fail the bundle where they lead out", async () => {
      const { copy } = await copyOf({
        'index.html': '<script type="module" src="app.js"></script><script type="module" src="out.js"></script>',
        'app.js': "import { label } from './lib'; document.title = label;",
        'lib/package.json': JSON.stringify({ main: './node.js', browser: './browser.js' }),
        'lib/node.js': "export const label = 'for node';",
        'lib/browser.js': "export const label = 'for browsers';",
        'out.js': "import * as label from './label.js'; document.title = JSON.stringify(label);",
        'label.js': "export const label = 'from the module';",
        'package.json': JSON.stringify({ browser: { './label.js': '../secret.json' } }),
      });
      const index = copy.get('index.html')!;
      expect(index).toContain('var label = "for browsers"');
      expect(index).toContain('<script type="module" src="out.js"></script>');
      expect(index).not.toContain('of the owner');
    });

    test('a font that is a link to elsewhere stays a URL, a file to fetch that is one stays out', async () => {
      const { dir, copy } = await copyOf(
        {
          'index.html': '<style>@font-face { font-family: T; src: url("t.woff2"); }</style>',
          'css/site.css': "@font-face { font-family: U; src: url('../t.woff2'); }",
          'data.json': '{}',
        },
        { 't.woff2': join(root, 'secret.woff2') },
      );
      expect(copy.get('index.html')).toContain('src: url("t.woff2")');
      expect(copy.has('css/site.css')).toBe(false);
      // a list of files that names a link anyway
      symlinkSync(secret, join(dir, 'secret.json'));
      const index = (await artifactCopy(dir, [...artifactFiles(dir), 'secret.json'], 'https://demos.example.com')).get('index.html')!;
      expect(index).toContain('"data.json"');
      expect(index).not.toContain('secret.json');
      expect(index).not.toContain(Buffer.from('the owner').toString('base64'));
    });
  });
});
