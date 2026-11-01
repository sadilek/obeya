// The copy of an HTML artifact on a shared page (a site's page, a ZIP). There the artifact runs in
// a sandboxed frame whose origin is `null`, so what it loads in CORS mode (a module script, a
// `fetch()` of a file beside it, a font) needs the site to answer with `Access-Control-Allow-Origin`,
// and from a ZIP opened from disk none of them loads at all. Behind a login (Cloudflare Access, say)
// no request of the frame for a file beside it gets through: the browser sends them as cross-site,
// without the login's cookie (Firefox never, Chrome where the cookie is not `SameSite=None`), and
// the login answers with its own page, an image as much as a module script. Inside Obeya the files
// are served under a keyed address instead (`keyed` in demo.ts); a static site cannot do that. So
// the copy's pages load no file beside them: their module scripts are bundled into the page, the
// files they name (an image, a stylesheet with what it loads in turn, a classic script, a font,
// media) go in as `data:` URLs, and the files their scripts may fetch go into the page, answered by
// `fetch` and `XMLHttpRequest` without asking the site. Only the frame's own navigation (a link to
// another page or to an image) still asks the site, and that one carries the cookie. Nor does the
// copy load anything from elsewhere or send anything there: it starts with the policy of a shared
// artifact (`sealed` in src/core/frame.ts).
//
// What goes into the copy comes from the artifact's directory only: a file there that is a link to
// elsewhere, or a module import that leads out of it, would publish a file of this machine.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { sealed, withHeightReport } from '../core/frame';
import { demoFile } from './demo-page';

/** What a page names in its markup or its styles, which the copy inlines there, so it stays out of the table of files to fetch. */
const LOADED = /\.(?:[cm]?js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mp3|wav|ogg|oga|m4a|flac)$/i;

/** A file of the artifact's directory, read where its real path lies inside it, else null. */
function read(dir: string, f: string): Buffer | null {
  const path = demoFile(dir, f);
  return path ? readFileSync(path) : null;
}

/**
 * The artifact's files whose copy differs from the artifact's own: its `index.html` (with the height
 * report, see `withHeightReport`, and the policy that lets it load its own files alone, those at
 * `own`) and its other pages (with that policy too: the artifact may open one in its frame), each
 * with the files it names inside it.
 */
export async function artifactCopy(dir: string, files: string[], own: string): Promise<Map<string, string>> {
  const copy = new Map<string, string>();
  for (const f of files) if (f !== 'index.html' && /\.html?$/i.test(f)) {
    const page = read(dir, f);
    if (page) copy.set(f, sealed(withData(page.toString('utf8'), dir, dirname(f)), own));
  }
  const embedded = files.filter((f) => f !== 'index.html' && !LOADED.test(f));
  const index = read(dir, 'index.html');
  if (!index) throw new Error(`${join(dir, 'index.html')} is no file of the artifact`);
  let html = withData(await withModules(index.toString('utf8'), dir), dir, '.');
  if (embedded.length) html = withFiles(html, dir, embedded);
  copy.set('index.html', sealed(withHeightReport(html), own));
  return copy;
}

/** A file's path relative to the artifact's directory, when it lies inside it. */
function inside(dir: string, from: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(ref)) return null;
  let path: string;
  try {
    path = relative(dir, join(dir, from, decodeURIComponent(ref.replace(/[?#].*$/, ''))));
  } catch {
    return null;
  }
  return path && !path.startsWith('..') ? path.split('\\').join('/') : null;
}

/**
 * How much of `data:` URLs one page may carry: stylesheets that import each other several times
 * over would otherwise grow it beyond any memory. Past it the files left stay the URLs they were,
 * and a page this large is refused by the host's limit for one file anyway.
 */
const DATA_BUDGET = 64 * 1024 * 1024;

/**
 * What inlining one page goes by: the directory its files are in, how a file of it is read (by its
 * path relative to it; null for one that may not go in), and what is left of the page's budget.
 * `strict`: a reference that does not go in is dropped rather than left to load from wherever it
 * leads (a repository's theme, see `themeData`).
 */
interface Inlining {
  dir: string;
  read: (path: string) => Buffer | null;
  left: number;
  strict?: true;
}

/**
 * A file of the artifact's directory as a `data:` URL (with the reference's `#` part, which names a
 * part of an SVG, say), named by `ref` from `from` (where the page or stylesheet naming it sits);
 * null for one that is not there. A stylesheet comes with what it names inside it in turn
 * (`outer`: the stylesheets it is named from, so one that names itself ends).
 */
function dataUrl(at: Inlining, from: string, ref: string, outer: string[] = []): string | null {
  const path = inside(at.dir, from, ref);
  const data = path && !outer.includes(path) && at.left > 0 ? at.read(path) : null;
  if (!path || !data) return null;
  const bytes = /\.css$/i.test(path) ? Buffer.from(withStyleData(data.toString('utf8'), at, dirname(path), [...outer, path])) : data;
  const url = `data:${Bun.file(path).type};base64,${bytes.toString('base64')}${/#.*$/.exec(ref)?.[0] ?? ''}`;
  // past the budget nothing more goes in: a page grown this far goes out too large anyway
  at.left = url.length > at.left ? 0 : at.left - url.length;
  return at.left > 0 ? url : null;
}

/** A reference that loads nothing, or what is in the page already: a `data:` URL, a part of the page (`#id`, an SVG's gradient). */
const HELD = /^(?:data:|#)/i;

/**
 * CSS with the files of the directory it names (`url()`, `@import`) as `data:` URLs; one has no
 * quote, space or parenthesis to end the text around it early. `strict`, the others go: an
 * `@import` with its rule, a `url()` as an empty one, which loads nothing.
 */
function withStyleData(css: string, at: Inlining, from: string, outer: string[] = []): string {
  return css
    .replace(/(@import\s+)(?:(['"])([^'"]+)\2|url\(\s*(['"]?)([^'")\s]+)\4\s*\))([^;{}@]*;?)/gi, (all, start: string, _q, quoted: string | undefined, _u, bare: string | undefined, rest: string) => {
      const ref = quoted ?? bare ?? '';
      const url = dataUrl(at, from, ref, outer);
      return url ? `${start}url(${url})${rest}` : at.strict && !HELD.test(ref) ? '' : all;
    })
    .replace(/url\(\s*(?:(['"])([^'"]*)\1|([^'")\s]+))\s*\)/gi, (all, q: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const ref = quoted ?? bare ?? '';
      const url = dataUrl(at, from, ref, outer);
      return url ? `url(${q ?? ''}${url}${q ?? ''})` : at.strict && !HELD.test(ref) ? 'url("")' : all;
    });
}

/**
 * A stylesheet of its own (a repository's theme, theme.ts) with the files it names as `data:` URLs,
 * each read by `read` (by its path relative to `dir`, where the stylesheet lies; null for one that
 * may not go in); what it names that does not go in, a file elsewhere or an address on the internet,
 * is dropped.
 */
export function themeData(css: string, dir: string, read: (path: string) => Buffer | null): string {
  return withStyleData(css, { dir, read, left: DATA_BUDGET, strict: true }, '.');
}

/**
 * A `srcset`'s candidates with their files of the directory as `data:` URLs, read as browsers read
 * it: a candidate's URL runs to the next white space (a `data:` URL's comma included), its
 * descriptors to the next comma.
 */
function srcsetData(srcset: string, at: Inlining, from: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
    if (i >= srcset.length) break;
    const start = i;
    while (i < srcset.length && !/\s/.test(srcset[i]!)) i++;
    let ref = srcset.slice(start, i);
    let size = '';
    if (ref.endsWith(',')) ref = ref.replace(/,+$/, '');
    else {
      const end = srcset.indexOf(',', i);
      size = srcset.slice(i, end < 0 ? srcset.length : end).trim();
      i = end < 0 ? srcset.length : end + 1;
    }
    out.push([dataUrl(at, from, ref) ?? ref, size].filter(Boolean).join(' '));
  }
  return out.join(', ');
}

/** What a page names as a file to load, by element and attribute (a module script's comes bundled, see `withModules`). */
const NAMED: [string, string][] = [
  ['img', 'src'],
  ['img', 'srcset'],
  ['source', 'src'],
  ['source', 'srcset'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['track', 'src'],
  ['input', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
  ['image', 'href'],
  ['image', 'xlink:href'],
  ['script', 'src'],
  ['link', 'href'],
];

/** `<link rel>` values that load the file they name. */
const LINKED = /^(?:stylesheet|icon|apple-touch-icon|preload|prefetch)$/i;

/**
 * A page with the files of the directory it names as `data:` URLs: in its markup (an image, a
 * classic script, a stylesheet, media), in its styles (a `<style>`, a `style` attribute) and in its
 * scripts' text where it reads as a CSS `url()`. `from` is where the page sits; a `<base>` of the
 * page moves it, and one that leads out of the directory or to another server leaves the page as
 * it is.
 */
function withData(html: string, dir: string, from: string): string {
  const base = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (base) {
    const folder = (base[1] ?? base[2] ?? base[3] ?? '').replace(/[^/]*$/, '');
    if (folder) {
      const file = inside(dir, from, `${folder}x`);
      if (file === null) return html;
      from = dirname(file);
    }
  }
  const at: Inlining = { dir, read: (path) => read(dir, path), left: DATA_BUDGET };
  const rewriter = new HTMLRewriter();
  for (const [element, attribute] of NAMED)
    rewriter.on(`${element}[${attribute.replace(':', '\\:')}]`, {
      element(el) {
        if (element === 'script' && el.getAttribute('type')?.trim().toLowerCase() === 'module') return;
        if (element === 'link' && !(el.getAttribute('rel') ?? '').split(/\s+/).some((rel) => LINKED.test(rel))) return;
        const value = el.getAttribute(attribute)!;
        const url = attribute === 'srcset' ? srcsetData(value, at, from) : dataUrl(at, from, value);
        if (url && url !== value) el.setAttribute(attribute, url);
      },
    });
  return rewriter.transform(withStyleData(html, at, from));
}

/** Text inside a `<script>` element must not close it. */
const inScript = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1');

/**
 * The page with each module script that loads files of the directory bundled into it: one with a
 * `src` there, an inline one that imports a file there. Imports from elsewhere (a CDN, a package
 * an import map names) stay imports. A script that does not bundle stays as it is.
 */
async function withModules(html: string, dir: string): Promise<string> {
  const scripts: { src: string | null; text: string }[] = [];
  let current: { src: string | null; text: string } | null = null;
  new HTMLRewriter()
    .on('script', {
      element(el) {
        current = null;
        if (el.getAttribute('type')?.trim().toLowerCase() !== 'module') return;
        current = { src: el.getAttribute('src'), text: '' };
        scripts.push(current);
      },
      text(chunk) {
        if (current && current.src === null) current.text += chunk.text;
      },
    })
    .transform(html);
  const bundles = await Promise.all(
    scripts.map(async (s, i) => {
      if (s.src !== null) {
        const path = inside(dir, '.', s.src);
        return path ? bundle(dir, join(dir, path)) : null;
      }
      if (!/(?:\bfrom|\bimport)\s*\(?\s*['"]\.{1,2}\//.test(s.text)) return null;
      const entry = join(dir, `.obeya-module-${i}.js`);
      return bundle(dir, entry, { [entry]: s.text });
    }),
  );
  if (bundles.every((b) => b === null)) return html;
  let i = 0;
  return new HTMLRewriter()
    .on('script', {
      element(el) {
        if (el.getAttribute('type')?.trim().toLowerCase() !== 'module') return;
        const code = bundles[i++];
        if (code === null || code === undefined) return;
        el.removeAttribute('src');
        el.setInnerContent(inScript(code), { html: true });
      },
    })
    .transform(html);
}

/**
 * The bundle of a module script, built as Bun builds it for a browser; none where it took in a
 * module whose real path lies outside the artifact's directory (a path out of it, a link, a path a
 * `tsconfig.json` maps a package to). Bun reads those while it builds, but nothing of it leaves.
 */
async function bundle(dir: string, entry: string, files?: Record<string, string>): Promise<string | null> {
  try {
    const r = await Bun.build({
      entrypoints: [entry],
      ...(files ? { files } : {}),
      root: dir,
      target: 'browser',
      format: 'esm',
      packages: 'external',
      external: ['http://*', 'https://*'],
      // a macro (`import … with { type: 'macro' }`) would run code of the artifact here, at the build
      macros: false,
      metafile: true,
      throw: false,
    } as Bun.BuildConfig);
    // a module that loads a stylesheet or splits into chunks needs files the copy does not have
    if (!r.success || r.outputs.length !== 1 || !r.metafile) return null;
    // the modules it read, relative to the working directory
    const root = realpathSync(dir) + sep;
    for (const input of Object.keys(r.metafile.inputs)) {
      const path = resolve(input);
      if (files && path === resolve(entry)) continue;
      if (!realpathSync(path).startsWith(root)) return null;
    }
    // the comments naming each module's path, which would tell where the artifact lay on this machine
    const slashes = (path: string) => path.split('\\').join('/');
    const inputs = new Set(Object.keys(r.metafile.inputs).map((input) => `// ${slashes(input)}`));
    return (await r.outputs[0]!.text())
      .split('\n')
      .filter((line) => !inputs.has(slashes(line)))
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * The page with the files its scripts may fetch inside it, as the first script of its head: GET
 * requests through `fetch` and `XMLHttpRequest` for a file of the directory are answered from there.
 */
function withFiles(html: string, dir: string, files: string[]): string {
  const table = Object.fromEntries(
    files.flatMap((f) => {
      const data = read(dir, f);
      return data ? [[f, [Bun.file(f).type, data.toString('base64')]]] : [];
    }),
  );
  const script = `<script>(() => {
  const files = ${inScript(JSON.stringify(table))};
  const base = new URL('.', location.href);
  const file = (url, method) => {
    if (String(method || 'GET').toUpperCase() !== 'GET') return null;
    let u;
    try { u = new URL(url, document.baseURI); } catch { return null; }
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
    let f;
    try { f = files[decodeURIComponent(u.pathname.slice(base.pathname.length))]; } catch { return null; }
    return f && { type: f[0], blob: new Blob([Uint8Array.from(atob(f[1]), (c) => c.charCodeAt(0))], { type: f[0] }) };
  };
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    const req = input instanceof Request ? input : null;
    const f = file(req ? req.url : input, (init && init.method) || (req && req.method));
    return f ? Promise.resolve(new Response(f.blob, { headers: { 'content-type': f.type } })) : fetch0.apply(this, arguments);
  };
  const open0 = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const f = file(url, method);
    return open0.call(this, method, f ? URL.createObjectURL(f.blob) : url, ...rest);
  };
})();</script>`;
  const head = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length) : script + html;
}
