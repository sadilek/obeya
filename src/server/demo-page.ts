// The page a demo is shared on, for people who have never seen Obeya, in the demo's language: title, text, the video with
// its chapters and captions (or an HTML artifact in a frame), the pull request, or without one the
// commit it landed as. A repository's demo site is built from it (site.ts), and a repository
// without one exports it (share.ts): as a ZIP with the video or the artifact beside the page, or as
// one HTML file with everything inside.

import { closeSync, type Dirent, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pagePolicy, sealed, withHeightReport } from '../core/frame';
import { languageName, preferredTrack } from '../../plugin/skills/demo/lib/locale.ts';
import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';

/** The languages a page speaks: those a demo is narrated in. */
export type PageLanguage = 'de' | 'en';

/** The page's own words, in the demo's language. */
export const PAGE_WORDS: Record<
  PageLanguage,
  {
    locale: string;
    play: string;
    pr: string;
    /** The link to work that landed without a pull request: its commit, or the comparison over its commits. */
    commit: string;
    commits: string;
    ownWindow: string;
    demoOf: (day: string) => string;
    /** A page on a site (`site.ts`): when it was shared and by whom (git's name of the one whose Obeya shared it), the link to the overview; the overview's own words. */
    sharedOn: (day: string, by?: string) => string;
    allDemos: string;
    /** On the overview, after a page's date: who shared it. */
    by: (name: string) => string;
    overview: string;
    noDemos: string;
    /** A page with several demo versions: the first one's name in the list at the top, and the heading of each later one. */
    first: string;
    addendum: (at: string, timeZone?: string) => string;
    /** The line every page and the overview end in, before the link to Obeya's site; the overview's link to its feed. */
    recordedWith: string;
    feed: string;
    /** The overview's filter: its search field, how many of the pages it shows, copying their links, a page's link, none passing. */
    search: string;
    shown: string;
    copyLinks: string;
    copyLinksHint: string;
    copyLink: string;
    copied: string;
    noMatch: string;
  }
> = {
  de: {
    locale: 'de-DE',
    play: 'Abspielen',
    pr: 'Pull Request ansehen',
    commit: 'Commit ansehen',
    commits: 'Commits ansehen',
    ownWindow: 'In eigenem Fenster öffnen',
    demoOf: (day) => `Demo vom ${day}`,
    sharedOn: (day, by) => (by ? `Geteilt von ${by} am ${day}` : `Geteilt am ${day}`),
    allDemos: 'Alle Demos',
    by: (name) => `von ${name}`,
    overview: 'Videos und Auswertungen zu Änderungen, die neuesten zuerst.',
    noDemos: 'Noch keine Demos geteilt.',
    first: 'Demo',
    addendum: (at, timeZone) => {
      const t = timeParts(at, 'de-DE', 'numeric', timeZone);
      return `Ergänzung vom ${t.day}.${t.month}., ${t.hour}:${t.minute}`;
    },
    recordedWith: 'Aufgenommen mit',
    feed: 'Feed abonnieren',
    search: 'Suchen …',
    shown: '{n} von {m}',
    copyLinks: 'Links kopieren',
    copyLinksHint: 'Kopiert die gezeigten Demos als Liste aus Titel und Link, für eine Mail, ein Dokument oder Markdown',
    copyLink: 'Link kopieren',
    copied: 'Kopiert',
    noMatch: 'Keine Demo passt zum Filter.',
  },
  en: {
    locale: 'en-US',
    play: 'Play',
    pr: 'View pull request',
    commit: 'View commit',
    commits: 'View commits',
    ownWindow: 'Open in its own window',
    demoOf: (day) => `Demo from ${day}`,
    sharedOn: (day, by) => (by ? `Shared by ${by} on ${day}` : `Shared on ${day}`),
    allDemos: 'All demos',
    by: (name) => `by ${name}`,
    overview: 'Videos and analyses of changes, the newest first.',
    noDemos: 'No demos shared yet.',
    first: 'Demo',
    addendum: (at, timeZone) => {
      const t = timeParts(at, 'en-US', 'short', timeZone);
      return `Addendum of ${t.month} ${t.day} at ${t.hour}:${t.minute}`;
    },
    recordedWith: 'Recorded with',
    feed: 'Subscribe to the feed',
    search: 'Search …',
    shown: '{n} of {m}',
    copyLinks: 'Copy links',
    copyLinksHint: 'Copies the demos shown as a list of titles and links, for a mail, a document or Markdown',
    copyLink: 'Copy link',
    copied: 'Copied',
    noMatch: 'No demo matches the filter.',
  },
};

/**
 * The day, month, hour and minute of a time in a time zone (the machine's without one), each as the
 * locale writes it; the page joins them itself, since how a platform's ICU data joins them differs
 * (macOS says "Jan 15 at 12:00", Linux "Jan 15, 12:00").
 */
function timeParts(at: string, locale: string, month: 'numeric' | 'short', timeZone?: string): Record<'day' | 'month' | 'hour' | 'minute', string> {
  const f = new Intl.DateTimeFormat(locale, { month, day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { day: parts.day ?? '', month: parts.month ?? '', hour: parts.hour ?? '', minute: parts.minute ?? '' };
}

/** Work that landed without a pull request, on its forge: its commit, or the comparison over its commits (`several`). */
export interface PageCommit {
  url: string;
  several?: true;
}

/** What a page shows of every demo, a video or an HTML artifact. */
interface PageParts {
  title: string;
  /** Paragraphs separated by blank lines. */
  text: string;
  pr: string | null;
  /** Without a pull request: where the work landed on the default branch, once it has. */
  commit?: PageCommit | null;
  /** The line under the title (when it was shared, and by whom). */
  when: string;
  /** The browser tab's title. */
  tabTitle: string;
  /** The demo's language, which the page's own words and the captions' name are in; German without one. */
  language?: PageLanguage;
  /** A link above the title (say, to all demos). */
  top?: { href: string; text: string };
  /** The page's tags, by dimension, each a link (say, to the overview showing the pages with it). */
  tags?: { dimension: string; value: string; href: string }[];  /** A page of an unlisted site: kept out of search engines, and its links send no referrer. */
  unlisted?: true;
}

/**
 * A caption track on a page: its language, and its file's URL or its text in the page: a page
 * opened from disk may not load a `<track>` (Chrome treats `file:` as another origin), so those come
 * as cues from a script.
 */
export type PageTrack = { language: string } & ({ src: string } | { vtt: string });

export interface DemoPageParts extends PageParts {
  chapters: [number, string][];
  /** The video's URL, or its bytes in base64 for a page that holds everything. */
  video: { src: string } | { base64: string };
  poster?: string;
  /** Its caption tracks, the narration's first. */
  tracks: PageTrack[];
  /** A video without sound: its captions show from the start. */
  silent?: boolean;
}

/** A caption track of a video demo's directory: its file, and its language, unknown for a demo from before the tracks. */
export interface CaptionTrack {
  file: string;
  language?: string;
}

/**
 * The caption tracks of a video demo's directory: a file per language (`captions.<language>.vtt`),
 * the narration's first (the one `captions.vtt` holds as well), or, from before those, `captions.vtt` alone.
 */
export function captionTracks(dir: string): CaptionTrack[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const tracks = files.flatMap((f) => {
    const language = /^captions\.([A-Za-z0-9-]+)\.vtt$/.exec(f)?.[1];
    return language ? [{ file: f, language }] : [];
  });
  if (!files.includes('captions.vtt')) return tracks;
  if (!tracks.length) return [{ file: 'captions.vtt' }];
  const narration = readFileSync(join(dir, 'captions.vtt'), 'utf8');
  const first = tracks.find((t) => readFileSync(join(dir, t.file), 'utf8') === narration);
  return first ? [first, ...tracks.filter((t) => t !== first)] : tracks;
}

/** How much of an MP4's start is searched for its tracks: the director writes them there (`+faststart`). */
const MP4_HEAD = 4 << 20;

/**
 * Whether a demo video has no sound: an MP4 whose track list, at its start, holds no audio
 * track (a handler of type `soun`). One whose list is not at its start counts as having sound.
 */
export function silentVideo(file: string): boolean {
  let head: Buffer;
  try {
    const fd = openSync(file, 'r');
    try {
      head = Buffer.alloc(MP4_HEAD);
      head = head.subarray(0, readSync(fd, head, 0, MP4_HEAD, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const text = head.toString('latin1');
  if (!text.includes('moov')) return false;
  // a `hdlr` box: its type, four bytes of version and flags, four predefined, then the handler's type
  return !/hdlr[\s\S]{8}soun/.test(text);
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The text's paragraphs as HTML. */
export const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
/** The link to the change: its pull request, or without one the commit (the commits) it landed as; '' before either. */
const changeLink = (p: Pick<PageParts, 'pr' | 'commit'>, w: (typeof PAGE_WORDS)[PageLanguage]) =>
  p.pr ? `<a href="${esc(p.pr)}">${w.pr}</a>` : p.commit ? `<a href="${esc(p.commit.url)}">${p.commit.several ? w.commits : w.commit}</a>` : '';
/** Text inside a `<script>` element must not close it. */
const inScript = (s: string) => s.replace(/<\//g, '<\\/');

export const day = (at: Date | string, language: PageLanguage = 'de') =>
  new Date(at).toLocaleDateString(PAGE_WORDS[language].locale, { day: 'numeric', month: 'long', year: 'numeric' });

export const PAGE_STYLE = `
  :root { --bg: #e8e2d4; --card: #fdfbf5; --ink: #1f1b14; --muted: #776e5e; --line: #e2dccd; --chip: #f0ebdf; --accent: #08888e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121110; --card: #23211d; --ink: #efe9dc; --muted: #a69e8e; --line: #36322b; --chip: #2c2925; --accent: #27b9b6; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 "IBM Plex Sans Condensed", ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  a { color: var(--accent); }
  .top { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
  h1 { font: 600 31px/1.15 Newsreader, "Iowan Old Style", Georgia, serif; margin: 0 0 6px; }
  .when { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .text p { margin: 0 0 10px; max-width: 72ch; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; margin-top: 22px; align-items: start; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  video { width: 100%; border-radius: 4px; background: #000; display: block; }
  .player { position: relative; }
  .start { all: unset; position: absolute; inset: 0 0 56px 0; cursor: pointer; display: grid; place-items: center; }
  .start[hidden] { display: none; }
  .start span { margin-top: 56px; width: 88px; height: 88px; border-radius: 50%; background: rgba(0, 0, 0, 0.6); display: grid; place-items: center; transition: transform 0.15s, background 0.15s; }
  .start:hover span { background: rgba(0, 0, 0, 0.8); transform: scale(1.06); }
  .start svg { width: 36px; height: 36px; margin-left: 6px; fill: #fff; }
  ol { list-style: none; margin: 0; padding: 6px; background: var(--chip); border-radius: 3px; }
  ol button { all: unset; cursor: pointer; display: flex; gap: 10px; width: 100%; padding: 7px 9px; border-radius: 2px; font-size: 14px; box-sizing: border-box; }
  ol button:hover, ol button.on { background: var(--card); }
  ol .t { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 34px; }
  .pr { margin-top: 14px; font-size: 14px; }
  ul.demos { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  ul.demos a { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 2px; padding: 14px 18px; color: var(--ink); text-decoration: none; }
  ul.demos a:hover { border-color: var(--accent); }
  ul.demos b { display: block; font: 600 19px/1.25 Newsreader, "Iowan Old Style", Georgia, serif; }
  ul.demos span { color: var(--muted); font-size: 14px; }
  .artifact { margin-top: 22px; background: #fff; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .artifact iframe { display: block; width: 100%; height: 80vh; border: 0; }
  body.alone main { max-width: none; padding: 0; }
  body.alone main > :not(.artifact) { display: none; }
  body.alone .artifact { margin: 0; border: 0; border-radius: 0; }
  body.alone .artifact iframe { height: 100vh; }
  .links { margin-top: 10px; font-size: 14px; display: flex; gap: 18px; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: -6px 0 18px; }
  .tag { font-size: 13px; line-height: 1.5; padding: 2px 10px; border-radius: 999px; background: var(--chip); color: var(--ink); text-decoration: none; border: 1px solid transparent; }
  a.tag:hover { border-color: var(--accent); }
  .tag span { color: var(--muted); }
  .credit { margin-top: 48px; font-size: 13px; color: var(--muted); }
`;

/** Obeya's site, which every page and the overview link at their end. */
export const OBEYA_URL = 'https://obeya.si';

/** The line every page and the overview end in: what made them, linking Obeya's site. */
export const credit = (language: PageLanguage) => `<footer class="credit">${PAGE_WORDS[language].recordedWith} <a href="${OBEYA_URL}">Obeya</a></footer>
`;

// the cues of captions held in the page, for a page opened from disk: a track per script
const CUES = `
  const sec = (t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  for (const held of document.querySelectorAll('script.captions')) {
    const track = v.addTextTrack('captions', held.dataset.label, held.dataset.lang);
    for (const block of held.textContent.replace(/\\r/g, '').split(/\\n\\s*\\n/)) {
      const lines = block.split('\\n');
      const at = lines.findIndex((l) => l.includes('-->'));
      if (at < 0) continue;
      const [from, to] = lines[at].split('-->').map((s) => sec(s.trim().split(/\\s+/)[0]));
      track.addCue(new VTTCue(from, to, lines.slice(at + 1).join('\\n')));
    }
  }
`;

// a silent video shows its captions from the start: in the viewer's language where it has a track in it, else the narration's (its first)
const SILENT_CAPTIONS = `
  for (const sv of document.querySelectorAll('video[data-silent]')) {
    const tracks = [...sv.textTracks], pick = (${preferredTrack.toString()})(tracks.map((t) => t.language), navigator.languages);
    for (const t of tracks) t.mode = t.language === pick ? 'showing' : 'disabled';
  }
`;

/** A video's `<track>` elements, each named in the page's language. */
const trackTags = (tracks: { language: string; src: string }[], language: PageLanguage) =>
  tracks.map((t) => `<track kind="captions" src="${esc(t.src)}" srclang="${esc(t.language)}" label="${esc(languageName(t.language, language))}">`).join('');

// A host that serves no byte ranges (Cloudflare Pages answers a range request with the whole file)
// leaves a video a browser cannot seek in (it jumps back): then the page loads the video once and
// plays it from memory. A page opened from disk cannot fetch it and needs not.
const SEEKABLE = (src: string) => `
  const seekable = fetch(${JSON.stringify(src)}, { headers: { Range: 'bytes=0-' } }).then(async (r) => {
    if (r.status === 206) return r.body?.cancel();
    const url = URL.createObjectURL(await r.blob()), at = v.currentTime, playing = !v.paused;
    v.src = url; v.currentTime = at;
    if (playing) v.play();
  }).catch(() => {});
`;

// the video's bytes held in the page, played from a blob so it can seek
const BLOB = `
  const b64 = document.getElementById('video').textContent.trim();
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
`;

/** The page of an HTML artifact: title and text above it, the artifact in a frame below. */
export interface ArtifactPageParts extends PageParts {
  /** The artifact's page beside this one, or its HTML for a page that holds everything. */
  artifact: { src: string } | { html: string };
  /** A page passed on as a file (the ZIP), opened from disk. */
  disk?: boolean;
}

/** Where the files beside a page opened from disk (the ZIP) are: `'self'` need not match `file:`. */
export const ON_DISK = 'file:';

/**
 * The artifact runs in a sandboxed frame, an origin of its own, so its scripts reach neither the
 * page nor the site; it opens no window, and "In eigenem Fenster öffnen" is this page with the
 * frame alone (`?alone`), not the artifact's own file, which would run in the site's origin. The
 * frame grows to the artifact's height where the artifact says it (`withHeightReport`); without
 * that it stays at 80 % of the window and scrolls. Opened from disk (`disk`), the frame keeps the
 * page's origin: there is no site to keep it from, and Chrome loads nothing beside a sandboxed page
 * from disk, not even its stylesheets and images. The artifact sends nothing elsewhere: its copy
 * starts with its policy (`sealed` in src/core/frame.ts, `pagePolicy` there), and the page's own policy lets the frame show nothing but
 * the page's own files, so the artifact cannot navigate it to another server either (a frame given
 * as `srcdoc` has the page's policy as well as its own).
 */
export function artifactPageHtml(p: ArtifactPageParts): string {
  const language = p.language ?? 'de';
  const w = PAGE_WORDS[language];
  const frame =
    'src' in p.artifact
      ? `<iframe ${p.disk ? '' : `src="${esc(p.artifact.src)}" `}sandbox="allow-scripts" title="${esc(p.title)}"></iframe>`
      : `<iframe srcdoc="${esc(sealed(withHeightReport(p.artifact.html)))}" sandbox="allow-scripts" title="${esc(p.title)}"></iframe>`;
  const links = [
    'src' in p.artifact ? `<a href="?alone" target="_blank" rel="noopener">${w.ownWindow}</a>` : '',
    changeLink(p, w),
  ].filter(Boolean);
  return `${pageStart(p, language, pagePolicy(ON_DISK))}${links.length ? `<div class="links">${links.join('')}</div>\n` : ''}<div class="artifact">${frame}</div>
${credit(language)}</main>
<script>
  // an artifact as high as its window (100vh plus a margin) would grow with each step: it stops after a few
  const f = document.querySelector('.artifact iframe');${
    p.disk && 'src' in p.artifact
      ? `
  if (location.protocol === 'file:') f.sandbox.add('allow-same-origin');
  f.src = ${JSON.stringify(p.artifact.src)};`
      : ''
  }
  const alone = new URLSearchParams(location.search).has('alone');
  if (alone) document.body.classList.add('alone');
  let steps = alone ? 30 : 0;
  addEventListener('message', (e) => {
    const h = e.source === f.contentWindow && e.data && e.data.obeyaHeight;
    if (typeof h === 'number' && h > 0 && steps++ < 30) f.style.height = Math.min(Math.ceil(h), 30000) + 'px';
  });
</script>
</body></html>
`;
}

/** What an unlisted page's head says: no index, no referrer (the meta tags hold where a host sends no headers of the site's own, GitHub Pages). */
const UNLISTED_META = '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">';

/** A page's start, down to the demo's text: its head (with its `policy`, if it has one), the link above the title, the title, when it was shared. */
function pageStart(p: PageParts, language: PageLanguage, policy?: string, style = '', list = ''): string {
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8">${policy ? `<meta http-equiv="Content-Security-Policy" content="${policy}">` : ''}<meta name="viewport" content="width=device-width, initial-scale=1">${p.unlisted ? UNLISTED_META : ''}
<title>${esc(p.tabTitle)}</title><style>${PAGE_STYLE}${style}</style></head>
<body><main>
${p.top ? `<div class="top"><a href="${esc(p.top.href)}">${esc(p.top.text)}</a></div>\n` : ''}<h1>${esc(p.title)}</h1>
<div class="when">${esc(p.when)}</div>
${p.tags?.length ? `<div class="tags">${p.tags.map((x) => `<a class="tag" href="${esc(x.href)}"><span>${esc(x.dimension)}</span> ${esc(x.value)}</a>`).join('')}</div>\n` : ''}${list}<div class="text">${paragraphs(p.text)}</div>
`;
}

export function demoPageHtml(p: DemoPageParts): string {
  const language = p.language ?? 'de';
  const w = PAGE_WORDS[language];
  const chapters = p.chapters.length
    ? `<ol>${p.chapters.map(([at, title], i) => `<li><button data-at="${at}"${i === 0 ? ' class="on"' : ''}><span class="t">${mmss(at)}</span>${esc(title)}</button></li>`).join('')}</ol>`
    : '';
  const src = 'src' in p.video ? ` src="${esc(p.video.src)}"` : '';
  const link = changeLink(p, w);
  const linked = p.tracks.flatMap((t) => ('src' in t ? [t] : []));
  const held = p.tracks.flatMap((t) => ('vtt' in t ? [t] : []));
  return `${pageStart(p, language)}<div class="grid">
  <div class="player"><video controls preload="metadata"${src}${p.poster ? ` poster="${esc(p.poster)}"` : ''}${p.silent ? ' data-silent' : ''}>${trackTags(linked, language)}</video><button class="start" aria-label="${w.play}"><span><svg viewBox="0 0 24 24"><path d="M6 4l15 8-15 8z"/></svg></span></button></div>
  <div>${chapters}${link ? `<div class="pr">${link}</div>` : ''}</div>
</div>
${credit(language)}</main>
${held.map((t) => `<script type="text/vtt" class="captions" data-lang="${esc(t.language)}" data-label="${esc(languageName(t.language, language))}">${inScript(t.vtt)}</script>\n`).join('')}${'base64' in p.video ? `<script type="application/octet-stream" id="video">${p.video.base64}</script>\n` : ''}<script>
  const v = document.querySelector('video'), bs = [...document.querySelectorAll('ol button')];${'base64' in p.video ? `${BLOB}  const seekable = Promise.resolve();\n` : SEEKABLE(p.video.src)}${held.length ? CUES : ''}${p.silent ? SILENT_CAPTIONS : ''}
  bs.forEach((b) => b.addEventListener('click', () => seekable.then(() => { v.currentTime = Number(b.dataset.at); v.play(); })));
  // a big play button over the video until it first plays: a click anywhere on it but its
  // controls starts it, instead of the small button in the corner
  const start = document.querySelector('.start');
  start.addEventListener('click', () => v.play());
  v.addEventListener('play', () => { start.hidden = true; });
  v.addEventListener('timeupdate', () => {
    let on = 0; bs.forEach((b, i) => { if (Number(b.dataset.at) <= v.currentTime + 0.05) on = i; });
    bs.forEach((b, i) => b.classList.toggle('on', i === on));
  });
</script>
</body></html>
`;
}

/** A demo version on a page with several: its title and text, and where its files are, relative to the page. */
export type StackedDemo = { title: string; text: string; base: string } & (
  | { kind: 'video'; chapters: [number, string][]; poster: boolean; tracks: { file: string; language: string }[]; silent?: boolean }
  | { kind: 'html' }
);

export interface StackedPageParts extends Omit<PageParts, 'title' | 'text'> {
  /** The first version, with the page's title and text, then each later one, with when it was handed over. */
  demos: [StackedDemo, ...(StackedDemo & { at: string })[]];
  /** The time zone the later ones' headings say the time in; this machine's without. */
  timeZone?: string;
}

/** The style a page with several demo versions adds: the list at the top, and each later version as an addendum. */
const STACK_STYLE = `
  .sections { font-size: 14px; color: var(--muted); margin: -10px 0 18px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  section.addendum { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line); }
  section.addendum h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  section.addendum h3 { font: 600 25px/1.2 Newsreader, "Iowan Old Style", Georgia, serif; margin: 0 0 10px; }
  body.alone main > section.alone { display: block; }
  body.alone section.alone > :not(.artifact) { display: none; }
`;

/**
 * A page with several demo versions of one change, in order of handover: the first with the page's
 * title and text on top, each later one below as an addendum („Ergänzung vom …“) with its own
 * title, text and video or artifact, and a list of them at the top. A page with one version is
 * `demoPageHtml` or `artifactPageHtml`. "In eigenem Fenster öffnen" shows an artifact alone
 * (`?alone=<n>`, its place on the page).
 */
export function stackedPageHtml(p: StackedPageParts): string {
  const language = p.language ?? 'de';
  const w = PAGE_WORDS[language];
  const [first, ...later] = p.demos;
  const name = (i: number) => (i === 0 ? w.first : w.addendum(later[i - 1]!.at, p.timeZone));
  const list = `<nav class="sections">${p.demos.map((_, i) => `<a href="#v${i + 1}">${i + 1}. ${esc(name(i))}</a>`).join('')}</nav>
`;
  const block = (d: StackedDemo, i: number) => {
    const link = i === 0 ? changeLink(p, w) : '';
    if (d.kind === 'html')
      return `<div class="links"><a href="?alone=${i + 1}" target="_blank" rel="noopener">${w.ownWindow}</a>${link}</div>
<div class="artifact"><iframe src="${esc(d.base + ARTIFACT_DIR)}/index.html" sandbox="allow-scripts" title="${esc(d.title)}"></iframe></div>`;
    const chapters = d.chapters.length
      ? `<ol>${d.chapters.map(([at, title], j) => `<li><button data-at="${at}"${j === 0 ? ' class="on"' : ''}><span class="t">${mmss(at)}</span>${esc(title)}</button></li>`).join('')}</ol>`
      : '';
    return `<div class="grid">
  <div class="player"><video controls preload="metadata" src="${esc(d.base)}demo.mp4"${d.poster ? ` poster="${esc(d.base)}poster.jpg"` : ''}${d.silent ? ' data-silent' : ''}>${trackTags(
    d.tracks.map((t) => ({ language: t.language, src: d.base + t.file })),
    language,
  )}</video><button class="start" aria-label="${w.play}"><span><svg viewBox="0 0 24 24"><path d="M6 4l15 8-15 8z"/></svg></span></button></div>
  <div>${chapters}${link ? `<div class="pr">${link}</div>` : ''}</div>
</div>`;
  };
  const artifacts = p.demos.some((d) => d.kind === 'html');
  return `${pageStart({ ...p, title: first.title, text: first.text }, language, artifacts ? pagePolicy(ON_DISK) : undefined, STACK_STYLE, list)}<section id="v1">
${block(first, 0)}
</section>
${later
  .map(
    (d, i) => `<section id="v${i + 2}" class="addendum">
<h2>${esc(name(i + 1))}</h2>
<h3>${esc(d.title)}</h3>
<div class="text">${paragraphs(d.text)}</div>
${block(d, i + 1)}
</section>`,
  )
  .join('\n')}
${credit(language)}</main>
<script>
  // each video: seekable on a host without byte ranges, its chapters, its big play button
  for (const g of document.querySelectorAll('.grid')) {
    const v = g.querySelector('video'), bs = [...g.querySelectorAll('ol button')], src = v.getAttribute('src');
    const seekable = fetch(src, { headers: { Range: 'bytes=0-' } }).then(async (r) => {
      if (r.status === 206) return r.body?.cancel();
      const url = URL.createObjectURL(await r.blob()), at = v.currentTime, playing = !v.paused;
      v.src = url; v.currentTime = at;
      if (playing) v.play();
    }).catch(() => {});
    bs.forEach((b) => b.addEventListener('click', () => seekable.then(() => { v.currentTime = Number(b.dataset.at); v.play(); })));
    const start = g.querySelector('.start');
    start.addEventListener('click', () => v.play());
    v.addEventListener('play', () => { start.hidden = true; });
    v.addEventListener('timeupdate', () => {
      let on = 0; bs.forEach((b, i) => { if (Number(b.dataset.at) <= v.currentTime + 0.05) on = i; });
      bs.forEach((b, i) => b.classList.toggle('on', i === on));
    });
  }
  // each artifact grows to its height, at most 30 steps; ?alone=<n> shows the one at that place alone
  const alone = new URLSearchParams(location.search).get('alone');
  const shown = alone === null ? null : document.getElementById('v' + (alone || '1'));
  if (shown && shown.querySelector('.artifact')) { document.body.classList.add('alone'); shown.classList.add('alone'); }
  const steps = new Map([...document.querySelectorAll('.artifact iframe')].map((f) => [f, shown && shown.contains(f) ? 30 : 0]));
  addEventListener('message', (e) => {
    const f = [...steps.keys()].find((f) => f.contentWindow === e.source);
    const h = f && e.data && e.data.obeyaHeight;
    if (typeof h === 'number' && h > 0 && steps.get(f) < 30) { steps.set(f, steps.get(f) + 1); f.style.height = Math.min(Math.ceil(h), 30000) + 'px'; }
  });${p.demos.some((d) => d.kind === 'video' && d.silent) ? SILENT_CAPTIONS : ''}
</script>
</body></html>
`;
}

/** An HTML artifact's directory on a page, beside the page's `index.html`. */
export const ARTIFACT_DIR = 'artifact';

/**
 * A file of a demo's directory by its path there: the file itself where it is one and lies inside the
 * directory, else null. A link to a file outside counts as outside: the worker made the directory,
 * and what is in it is served, published and passed on.
 */
export function demoFile(dir: string, name: string): string | null {
  try {
    const root = realpathSync(dir);
    const path = realpathSync(resolve(root, name));
    return path.startsWith(root + sep) && statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The files of an HTML artifact's directory, relative to it, without hidden ones; links only to a file inside it. */
export function artifactFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  // its own walk: one that follows a link to a directory may walk the whole disk
  const walk = (sub: string) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true }) as Dirent[]) {
      if (e.name.startsWith('.')) continue;
      const f = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(f);
      else if (e.isFile() || (e.isSymbolicLink() && demoFile(dir, f))) out.push(f);
    }
  };
  walk('');
  return out.sort();
}
