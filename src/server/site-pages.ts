// The pages of a demo site besides the demos' own (demo-page.ts), and how a demo's page sits on
// it: its address, what its `meta.json` keeps, the page written from that, the overview with its
// filter, the answer to an address the site lacks, the feed, the sitemap and `robots.txt`, and the
// headers of an artifact's files. Pure functions from a page's `meta.json` to text; site.ts reads
// and writes the site's directory and deploys it.
//
// A host that reads a `_headers` file (Cloudflare Pages, Netlify) sends an artifact's files with the
// headers that keep it from the internet beyond what its CSP covers (`artifactHeaders`).

import { createHash } from 'node:crypto';
import { dimensions } from '../core/page-tags';
import type { DemoSite, PageTags } from '../core/types';
import { ARTIFACT_DIR, artifactPageHtml, credit, day, demoPageHtml, esc, OBEYA_URL, pageHead, type PageCommit, paragraphs, PAGE_WORDS, type PageLanguage, type StackedDemo, stackedPageHtml } from './demo-page';
import { jsonInScript, pagePolicy, sealed, withHeightReport } from '../core/frame';
import { type CaptionTrack } from './demo-files';
import { OWN_CONNECTIONS } from './serve-files';

/** The site's root, the overview's address. */
export const siteRoot = (site: DemoSite) => `${site.url.replace(/\/+$/, '')}/`;
/** The page's URL on the site. */
export const pageUrl = (site: DemoSite, slug: string) => `${siteRoot(site)}${slug}/`;

/** What a page's directory on the site keeps besides its files, for the overview. */
export interface Meta {
  /** Absent on video pages. */
  kind?: 'html';
  title: string;
  text: string;
  chapters: [number, string][];
  pr: string | null;
  /** Without a pull request: where the work landed on the default branch; absent before it did, and on pages from before (until 2026-10-30). */
  commit?: PageCommit;
  /** When it was first shared, and when its video or artifact last changed (the date the page and the overview show). */
  first: string;
  at: string;
  /** A hash of the video or the artifact's files as the demo has them. */
  source: string;
  language: PageLanguage;
  /** Who shared it: git's name (`user.name`) in the repository of the Obeya that published it; absent on pages from before (until 2026-10-20) or where git has none. */
  by?: string;
  /** The later demo versions on the page, in order of handover, each in a directory of the page's (`dir`). */
  more?: MoreMeta[];
  /** The page's tags from the site's vocabulary (`demo.site.tags`), by dimension; absent on pages without. */
  tags?: PageTags;
  /** The repository it was published from (`repoMark`); absent on pages from before (until 2026-11-03). */
  repo?: string;
}

/** A later demo version on a page: what its section shows, and when it was handed over (`handed`, its heading). */
export interface MoreMeta {
  kind?: 'html';
  title: string;
  text: string;
  chapters: [number, string][];
  dir: string;
  handed: string;
  at: string;
  source: string;
}

/** When the page's newest version last changed: the date the overview shows it with. */
export const newest = (m: Meta) => [m.at, ...(m.more ?? []).map((x) => x.at)].sort().at(-1)!;

/**
 * A hash of a sample page in each language, with everything a page can have, the video pages',
 * then the artifact pages': it changes with every change to Obeya's templates, and `PAGES_HASH`
 * (page-changes.ts) pins it, so a change is described for the viewers, or found to show nowhere.
 */
export function pagesHash(): { video: string; html: string; stacked: string } {
  const site = { title: 'Demos', url: 'https://demos.example.dev/', deploy: 'true' };
  const at = '2026-01-15T12:00:00.000Z';
  const sample: Meta = {
    title: 'Title',
    text: 'A sentence.\n\nAnother one.',
    chapters: [
      [0, 'Before'],
      [12.5, 'After'],
    ],
    pr: 'https://github.com/o/r/pull/1',
    first: at,
    at,
    source: '',
    language: 'de',
    by: 'Ada Lovelace',
    tags: { Area: ['Billing', 'Reports'], Audience: [] },
  };
  const hash = (pages: string[]) => createHash('sha256').update(pages.join('\0')).digest('hex').slice(0, 12);
  const languages: PageLanguage[] = ['de', 'en'];
  // without a pull request, the commit (the commits) the work landed as
  const commit = { url: 'https://github.com/o/r/commit/b' };
  const commits = { url: 'https://github.com/o/r/compare/a...b', several: true as const };
  const files = () => ({ poster: true, tracks: [{ file: 'captions.vtt' }] });
  const video = hash(languages.flatMap((language) => [pageHtml(site, 'title-1', { ...sample, language }, files), pageHtml(site, 'title-1', { ...sample, language, pr: null, commit }, files)]));
  const html = hash(languages.map((language) => pageHtml(site, 'title-1', { ...sample, kind: 'html', chapters: [], language }, () => ({ poster: false, tracks: [] })) + sealed(withHeightReport('<body></body>'), new URL(site.url).origin)));
  // a page with several versions: a video, then an artifact and a video as addenda
  const more: MoreMeta[] = [
    { kind: 'html', title: 'Second', text: 'A detail.', chapters: [], dir: '2', handed: at, at, source: '' },
    { title: 'Third', text: 'Another detail.', chapters: [[0, 'Only']], dir: '3', handed: at, at, source: '' },
  ];
  // the same on every machine: the time of an addendum is said in the machine's time zone
  const stacked = hash(languages.flatMap((language) => [pageHtml(site, 'title-1', { ...sample, language, more }, files, { timeZone: 'UTC' }), pageHtml(site, 'title-1', { ...sample, language, more, pr: null, commit: commits }, files, { timeZone: 'UTC' })]));
  return { video, html, stacked };
}

/** The file a host such as Cloudflare Pages or Netlify reads the headers of the site's files from; on another host it is a file nobody asks for. */
export const HEADERS = '_headers';
/** The page a host (Cloudflare Pages, GitHub Pages, Netlify) answers an address it lacks with. */
export const NOT_FOUND = '404.html';

/** Every file of an unlisted site is kept out of search engines, and a link leaving it says nothing of where it came from. */
export const unlistedHeaders = () => `/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
`;

/**
 * The headers of an artifact's files on the site, for a host that sends them: its policy again, now
 * with the sandbox, so a file opened directly does not run in the site's origin, and what no CSP
 * reaches, a connection opened ahead (`preconnect`) or WebRTC, kept to the site
 * (`Connection-Allowlist`, Chrome 152 on).
 */
export function artifactHeaders(site: DemoSite, unlisted = false): string {
  const u = new URL(site.url);
  // on an unlisted site, behind the random part of the page's address
  const path = u.pathname.replace(/\/+$/, '') + (unlisted ? '/:token' : '');
  // an artifact as the page's first version, and as a later one in a directory of its own
  return [`${path}/:slug/${ARTIFACT_DIR}/*`, `${path}/:slug/:n/${ARTIFACT_DIR}/*`]
    .map(
      (at) => `${at}
  Content-Security-Policy: sandbox allow-scripts; ${pagePolicy(u.origin)}
  Connection-Allowlist: ${OWN_CONNECTIONS}
  X-DNS-Prefetch-Control: off
`,
    )
    .join('');
}

/** What a video version's directory on the site holds beside its video: a poster, its caption tracks, and whether the video is silent. */
export interface VersionFiles {
  poster: boolean;
  tracks: CaptionTrack[];
  silent?: boolean;
}

/**
 * The page at `slug` of the site, in its language; `files`: what a version's directory (the page's
 * own: '') holds. A listed site's page names its address for search engines; a page of an unlisted
 * site links no overview and no tags, and keeps itself out of search engines. `theme`: the CSS of
 * the card's repository's theme.
 */
export function pageHtml(site: DemoSite, slug: string, m: Meta, files: (dir: string) => VersionFiles, { unlisted = false, theme, timeZone }: { unlisted?: boolean; theme?: string; timeZone?: string } = {}): string {
  const { language } = m;
  const w = PAGE_WORDS[language];
  const parts = {
    title: m.title,
    text: m.text,
    pr: m.pr,
    commit: m.commit ?? null,
    when: w.sharedOn(day(m.at, language), m.by),
    tabTitle: unlisted ? m.title : `${m.title} · ${site.title}`,
    language,
    ...(theme ? { theme } : {}),
    ...(unlisted
      ? { unlisted: true as const }
      : {
          canonical: pageUrl(site, slug),
          top: { href: '../', text: w.allDemos },
          // each links the overview showing the pages that have it
          tags: Object.entries(m.tags ?? {}).flatMap(([dimension, values]) => values.map((value) => ({ dimension, value, href: `../?${new URLSearchParams({ [dimension]: value })}` }))),
        }),
  };
  // a track from before the tracks is in the demo's language
  const tracks = (f: VersionFiles) => f.tracks.map((t) => ({ file: t.file, language: t.language ?? language }));
  if (m.more?.length) {
    const demo = (d: { kind?: 'html'; title: string; text: string; chapters: [number, string][] }, dir: string): StackedDemo => {
      if (d.kind === 'html') return { kind: 'html', title: d.title, text: d.text, base: dir ? `${dir}/` : '' };
      const f = files(dir);
      return { kind: 'video', title: d.title, text: d.text, base: dir ? `${dir}/` : '', chapters: d.chapters, poster: f.poster, tracks: tracks(f), ...(f.silent ? { silent: true } : {}) };
    };
    return stackedPageHtml({ ...parts, demos: [demo(m, ''), ...m.more.map((x) => ({ ...demo(x, x.dir), at: x.handed }))], ...(timeZone ? { timeZone } : {}) });
  }
  if (m.kind === 'html') return artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` } });
  const own = files('');
  return demoPageHtml({
    ...parts,
    chapters: m.chapters,
    video: { src: 'demo.mp4' },
    ...(own.poster ? { poster: 'poster.jpg' } : {}),
    tracks: tracks(own).map((t) => ({ language: t.language, src: t.file })),
    ...(own.silent ? { silent: true } : {}),
  });
}

/** The site's Atom feed, at its root beside the overview. */
export const FEED = 'feed.xml';

/** The first sentence of a page's text, as the overview shows it. */
const firstSentence = (t: string) => (t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t).slice(0, 240);

/** The style the overview adds: its filter (search, a row of chips per dimension), the count and "Copy links", each page's copy icon. */
const OVERVIEW_STYLE = `
  .filter { display: grid; gap: 10px; margin: 0 0 16px; }
  .filter input { font: inherit; font-size: 15px; width: 100%; padding: 7px 11px; border: 1px solid var(--line); border-radius: 3px; background: var(--card); color: var(--ink); }
  .filter input:focus { outline: none; border-color: var(--accent); }
  .dim { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .dim > span { color: var(--muted); font-size: 13px; min-width: 90px; }
  .chip { all: unset; cursor: pointer; font-size: 13px; line-height: 1.5; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); }
  .chip:hover { border-color: var(--accent); }
  .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--card); }
  .chip:focus-visible, .copy:focus-visible, .copy-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding: 10px 0 12px; font-size: 14px; color: var(--muted); }
  .copy-all, .copy { all: unset; cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 6px; }
  .copy-all svg, .copy svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  ul.demos li { position: relative; }
  ul.demos li[hidden] { display: none; }
  ul.demos a { padding-right: 52px; }
  ul.demos i { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; font-style: normal; }
  ul.demos i em { font-style: normal; font-size: 12px; padding: 0 8px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .copy { position: absolute; top: 12px; right: 12px; padding: 6px; border-radius: 3px; opacity: 0; transition: opacity 0.1s; }
  .copy:hover { background: var(--chip); }
  ul.demos li:hover .copy, .copy:focus-visible, .copy.done { opacity: 1; }
  .copy.done::after { content: attr(data-done); position: absolute; right: 100%; margin-right: 4px; font-size: 13px; white-space: nowrap; }
  @media (hover: none) { .copy { opacity: 1; } }
`;

/** Two overlapping sheets: the mark for copying. */
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

/**
 * Every page on the site, the most recently shared first, in the site's language. Above them a
 * filter: a search over title and text, and a row of chips per dimension of the site's vocabulary
 * (its values that some page has), any of a dimension's and all dimensions; it stands in the URL
 * (`?Area=Billing&q=pdf`), so a filtered list can be passed on. Each page's link is copied by its
 * icon, those shown all at once by "Copy links": as HTML links and as a Markdown list. It all
 * runs in the browser; the site stays static.
 */
export function overviewHtml(site: DemoSite, pages: (Meta & { slug: string })[], language: PageLanguage, theme?: string): string {
  const w = PAGE_WORDS[language];
  const has = (d: string, v: string) => pages.some((p) => p.tags?.[d]?.includes(v));
  const dims = dimensions(site.tags).flatMap(([d, values]) => {
    const on = values.filter((v) => has(d, v));
    return on.length ? [[d, on] as const] : [];
  });
  const search = (d: Meta) => [d.title, d.text, ...(d.more ?? []).flatMap((m) => [m.title, m.text])].join(' ').toLowerCase().replace(/\s+/g, ' ');
  const entry = (d: Meta & { slug: string }) => {
    const tags = dims.flatMap(([dim, values]) => values.filter((v) => d.tags?.[dim]?.includes(v)));
    const line = [day(newest(d), language), ...(d.by ? [w.by(d.by)] : []), firstSentence(d.text)].map(esc).join(' · ');
    return `<li data-tags="${esc(JSON.stringify(d.tags ?? {}))}" data-search="${esc(search(d))}"><a href="${d.slug}/"><b>${esc(d.title)}</b><span>${line}</span>${tags.length ? `<i>${tags.map((v) => `<em>${esc(v)}</em>`).join('')}</i>` : ''}</a><button class="copy" data-url="${esc(pageUrl(site, d.slug))}" data-done="${esc(w.copied)}" title="${esc(w.copyLink)}" aria-label="${esc(w.copyLink)}">${COPY_ICON}</button></li>`;
  };
  const filter = `<div class="filter">
<input type="search" id="q" placeholder="${esc(w.search)}" aria-label="${esc(w.search)}" autocomplete="off">
${dims.map(([d, values]) => `<div class="dim" role="group" aria-label="${esc(d)}"><span>${esc(d)}</span>${values.map((v) => `<button class="chip" data-d="${esc(d)}" data-v="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join('')}</div>`).join('\n')}
</div>
<div class="bar"><span id="count">${esc(w.shown.replace('{n}', String(pages.length)).replace('{m}', String(pages.length)))}</span><button class="copy-all" title="${esc(w.copyLinksHint)}">${COPY_ICON}<span>${esc(w.copyLinks)}</span></button></div>
`;
  return `${pageHead({ language, title: site.title, theme, links: `<link rel="canonical" href="${esc(siteRoot(site))}"><link rel="alternate" type="application/atom+xml" title="${esc(site.title)}" href="${FEED}">`, style: OVERVIEW_STYLE })}<h1>${esc(site.title)}</h1>
<div class="when">${esc(w.overview)} · <a href="${FEED}">${esc(w.feed)}</a></div>
${
  pages.length
    ? `${filter}<ul class="demos">${pages.map(entry).join('\n')}</ul>
<p class="none" hidden>${esc(w.noMatch)}</p>
<script>${overviewScript(w)}</script>`
    : `<p>${esc(w.noDemos)}</p>`
}
${credit(language)}</main></body></html>
`;
}

/**
 * A listed site's answer to an address it lacks, in the site's language and with the overview's
 * theme: no such page, or withdrawn, and a link to the overview. The host serves it at any address,
 * so it links the overview by its full address and holds everything it needs.
 */
export function notFoundHtml(site: DemoSite, language: PageLanguage, theme?: string): string {
  const w = PAGE_WORDS[language];
  return `${pageHead({ language, title: `${w.notFound} · ${site.title}`, theme, meta: '<meta name="robots" content="noindex">', style: ' .text { margin-top: 14px; }' })}<div class="top"><a href="${esc(siteRoot(site))}">${esc(w.allDemos)}</a></div>
<h1>${esc(w.notFound)}</h1>
<div class="text"><p>${esc(w.notFoundText)}</p></div>
${credit(language)}</main></body></html>
`;
}

/**
 * The overview's filter in the browser: the chips and the search from the URL, the pages that pass
 * them, the count, the URL kept in step; copying a page's link, and the links of those shown as
 * `text/html` and as a Markdown list (`text/plain`), as text alone where the browser has no `ClipboardItem`.
 */
const overviewScript = (w: (typeof PAGE_WORDS)[PageLanguage]) => `
  const words = ${jsonInScript({ shown: w.shown, copied: w.copied, copyLinks: w.copyLinks })};
  const q = document.getElementById('q'), chips = [...document.querySelectorAll('.chip')], items = [...document.querySelectorAll('ul.demos li')];
  const count = document.getElementById('count'), none = document.querySelector('.none'), all = document.querySelector('.copy-all');
  const params = new URLSearchParams(location.search);
  q.value = params.get('q') || '';
  for (const c of chips) c.setAttribute('aria-pressed', String(params.getAll(c.dataset.d).includes(c.dataset.v)));
  const tagsOf = (li) => { try { return JSON.parse(li.dataset.tags); } catch { return {}; } };
  const apply = () => {
    const chosen = {};
    for (const c of chips) if (c.getAttribute('aria-pressed') === 'true') (chosen[c.dataset.d] ||= []).push(c.dataset.v);
    const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let n = 0;
    for (const li of items) {
      const tags = tagsOf(li);
      // any of a dimension's chips, and every dimension with one
      const pass = Object.entries(chosen).every(([d, vs]) => vs.some((v) => (tags[d] || []).includes(v))) && terms.every((t) => li.dataset.search.includes(t));
      li.hidden = !pass;
      if (pass) n++;
    }
    count.textContent = words.shown.replace('{n}', n).replace('{m}', items.length);
    none.hidden = n > 0;
    all.disabled = n === 0;
    const next = new URLSearchParams();
    for (const [d, vs] of Object.entries(chosen)) for (const v of vs) next.append(d, v);
    if (q.value.trim()) next.set('q', q.value.trim());
    const search = next.toString();
    history.replaceState(null, '', search ? '?' + search : location.pathname);
  };
  for (const c of chips) c.addEventListener('click', () => { c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true')); apply(); });
  q.addEventListener('input', apply);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const copy = async (html, text) => {
    if (window.ClipboardItem && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        return;
      } catch {}
    }
    await navigator.clipboard.writeText(text);
  };
  for (const b of document.querySelectorAll('.copy')) b.addEventListener('click', async () => {
    const url = b.dataset.url;
    await copy('<a href="' + esc(url) + '">' + esc(url) + '</a>', url);
    b.classList.add('done');
    setTimeout(() => b.classList.remove('done'), 1500);
  });
  all.addEventListener('click', async () => {
    const shown = items.filter((li) => !li.hidden).map((li) => ({ title: li.querySelector('b').textContent, url: li.querySelector('.copy').dataset.url }));
    if (!shown.length) return;
    await copy('<ul>' + shown.map((d) => '<li><a href="' + esc(d.url) + '">' + esc(d.title) + '</a></li>').join('') + '</ul>', shown.map((d) => '- [' + d.title.replace(/([\\[\\]])/g, '\\\\$1') + '](' + d.url + ')').join('\\n'));
    const label = all.querySelector('span');
    label.textContent = words.copied;
    setTimeout(() => { label.textContent = words.copyLinks; }, 1500);
  });
  apply();
`;

/** Text without the control characters XML 1.0 does not allow. */
const printable = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
/** Text in XML. */
const xml = (s: string) => esc(printable(s));

/**
 * The site's pages as an Atom feed, in the order and with the dates of the overview: each page's
 * title, its text, its address as link and id. The feed is as old as its newest page; a site
 * without pages dates it now.
 */
export function feedXml(site: DemoSite, pages: (Meta & { slug: string })[], language: PageLanguage): string {
  const base = siteRoot(site);
  const updated = pages.length ? newest(pages[0]!) : new Date().toISOString();
  const entry = (d: Meta & { slug: string }) => {
    const url = xml(pageUrl(site, d.slug));
    const plain = printable(d.text);
    return `<entry xml:lang="${d.language}">
<title type="text">${xml(d.title)}</title>
<link rel="alternate" type="text/html" href="${url}"/>
<id>${url}</id>
<published>${xml(d.first)}</published>
<updated>${xml(newest(d))}</updated>
${d.by ? `<author><name>${xml(d.by)}</name></author>\n` : ''}${Object.entries(d.tags ?? {})
      .flatMap(([dim, values]) => values.map((v) => `<category term="${xml(v)}" label="${xml(`${dim}: ${v}`)}"/>\n`))
      .join('')}<summary type="text">${xml(firstSentence(plain))}</summary>
<content type="html">${xml(paragraphs(plain))}</content>
</entry>
`;
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${language}">
<title type="text">${xml(site.title)}</title>
<subtitle type="text">${xml(PAGE_WORDS[language].overview)}</subtitle>
<link rel="self" type="application/atom+xml" href="${xml(base + FEED)}"/>
<link rel="alternate" type="text/html" href="${xml(base)}"/>
<id>${xml(base)}</id>
<updated>${xml(updated)}</updated>
<author><name>${xml(site.title)}</name></author>
<generator uri="${OBEYA_URL}">Obeya</generator>
${pages.map(entry).join('')}</feed>
`;
}

/** The site's pages for search engines, at its root beside the overview. */
export const SITEMAP = 'sitemap.xml';
/** Where search engines look for the sitemap: read only at the root of a host. */
export const ROBOTS = 'robots.txt';

/**
 * The overview and every page, dated as the feed dates them: the overview by its newest page (an
 * empty site undated), each page by its newest version. A sitemap names only addresses under its
 * own, so a site under a path of its host has one all the same.
 */
export function sitemapXml(site: DemoSite, pages: (Meta & { slug: string })[]): string {
  const url = (loc: string, at?: string) => `<url><loc>${xml(loc)}</loc>${at ? `<lastmod>${xml(at)}</lastmod>` : ''}</url>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url(siteRoot(site), pages[0] && newest(pages[0]))}${pages.map((d) => url(pageUrl(site, d.slug), newest(d))).join('')}</urlset>
`;
}

/** Everything open to crawlers, and where the sitemap is. */
export const robotsTxt = (site: DemoSite) => `User-agent: *
Allow: /

Sitemap: ${siteRoot(site)}${SITEMAP}
`;
