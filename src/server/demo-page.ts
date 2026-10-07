// The page a demo is shared on, for people who have never seen Obeya, in the demo's language: title, text, the video with
// its chapters and captions (or an HTML artifact in a frame), the pull request. A repository's share
// command builds its site from it (through the adapter kit), and a repository without a share target exports it (share.ts): as a ZIP
// with the video or the artifact beside the page, or as one HTML file with everything inside.

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { withHeightReport } from '../core/frame';

export { withHeightReport };

/** The languages a page speaks: those a demo is narrated in. */
export type PageLanguage = 'de' | 'en';

/** The page's own words, in the demo's language. */
export const PAGE_WORDS: Record<
  PageLanguage,
  { locale: string; captions: string; play: string; pr: string; ownWindow: string; demoOf: (day: string) => string }
> = {
  de: {
    locale: 'de-DE',
    captions: 'Deutsch',
    play: 'Abspielen',
    pr: 'Pull Request ansehen',
    ownWindow: 'In eigenem Fenster öffnen',
    demoOf: (day) => `Demo vom ${day}`,
  },
  en: {
    locale: 'en-US',
    captions: 'English',
    play: 'Play',
    pr: 'View pull request',
    ownWindow: 'Open in its own window',
    demoOf: (day) => `Demo from ${day}`,
  },
};

export interface DemoPageParts {
  title: string;
  /** Paragraphs separated by blank lines. */
  text: string;
  chapters: [number, string][];
  pr: string | null;
  /** The line under the title (when it was shared). */
  when: string;
  /** The browser tab's title. */
  tabTitle: string;
  /** The demo's language, which the page's own words and the captions' name are in; German without one. */
  language?: PageLanguage;
  /** A link above the title (say, to all demos). */
  top?: { href: string; text: string };
  /** The video's URL, or its bytes in base64 for a page that holds everything. */
  video: { src: string } | { base64: string };
  poster?: string;
  /**
   * The captions' URL, or their text in the page: a page opened from disk may not load a `<track>`
   * (Chrome treats `file:` as another origin), so those come as cues from a script.
   */
  captions: { src: string } | { vtt: string };
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Text inside a `<script>` element must not close it. */
const inScript = (s: string) => s.replace(/<\//g, '<\\/');

export const day = (at: Date | string, language: PageLanguage = 'de') =>
  new Date(at).toLocaleDateString(PAGE_WORDS[language].locale, { day: 'numeric', month: 'long', year: 'numeric' });

export const PAGE_STYLE = `
  :root { --bg: #f4f2ee; --card: #fff; --ink: #1d1c1a; --muted: #75716a; --line: #e6e2da; --chip: #f1eee8; --accent: #0d9488; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151412; --card: #1f1e1b; --ink: #eeeae3; --muted: #a39e94; --line: #34312c; --chip: #2a2825; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  a { color: var(--accent); }
  .top { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 6px; }
  .when { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .text p { margin: 0 0 10px; max-width: 72ch; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; margin-top: 22px; align-items: start; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  video { width: 100%; border-radius: 12px; background: #000; display: block; }
  .player { position: relative; }
  .start { all: unset; position: absolute; inset: 0 0 56px 0; cursor: pointer; display: grid; place-items: center; }
  .start[hidden] { display: none; }
  .start span { margin-top: 56px; width: 88px; height: 88px; border-radius: 50%; background: rgba(0, 0, 0, 0.6); display: grid; place-items: center; transition: transform 0.15s, background 0.15s; }
  .start:hover span { background: rgba(0, 0, 0, 0.8); transform: scale(1.06); }
  .start svg { width: 36px; height: 36px; margin-left: 6px; fill: #fff; }
  ol { list-style: none; margin: 0; padding: 6px; background: var(--chip); border-radius: 12px; }
  ol button { all: unset; cursor: pointer; display: flex; gap: 10px; width: 100%; padding: 7px 9px; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
  ol button:hover, ol button.on { background: var(--card); }
  ol .t { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 34px; }
  .pr { margin-top: 14px; font-size: 14px; }
  ul.demos { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  ul.demos a { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; color: var(--ink); text-decoration: none; }
  ul.demos a:hover { border-color: var(--accent); }
  ul.demos b { display: block; font-size: 17px; }
  ul.demos span { color: var(--muted); font-size: 14px; }
  .artifact { margin-top: 22px; background: #fff; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .artifact iframe { display: block; width: 100%; height: 80vh; border: 0; }
  .links { margin-top: 10px; font-size: 14px; display: flex; gap: 18px; }
`;

// the cues of captions held in the page, for a page opened from disk
const CUES = (language: PageLanguage) => `
  const vtt = document.getElementById('captions').textContent;
  const track = v.addTextTrack('captions', ${JSON.stringify(PAGE_WORDS[language].captions)}, ${JSON.stringify(language)});
  const sec = (t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  for (const block of vtt.replace(/\\r/g, '').split(/\\n\\s*\\n/)) {
    const lines = block.split('\\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map((s) => sec(s.trim().split(/\\s+/)[0]));
    track.addCue(new VTTCue(from, to, lines.slice(at + 1).join('\\n')));
  }
`;

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
export interface ArtifactPageParts {
  title: string;
  /** Paragraphs separated by blank lines. */
  text: string;
  pr: string | null;
  when: string;
  tabTitle: string;
  language?: PageLanguage;
  top?: { href: string; text: string };
  /** The artifact's page beside this one, or its HTML for a page that holds everything. */
  artifact: { src: string } | { html: string };
}

/**
 * The artifact runs in a sandboxed frame, an origin of its own, so its scripts reach neither the
 * page nor the site. The frame grows to the artifact's height where the artifact says it
 * (`withHeightReport`); without that it stays at 80 % of the window and scrolls.
 */
export function artifactPageHtml(p: ArtifactPageParts): string {
  const language = p.language ?? 'de';
  const w = PAGE_WORDS[language];
  const frame =
    'src' in p.artifact
      ? `<iframe src="${esc(p.artifact.src)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" title="${esc(p.title)}"></iframe>`
      : `<iframe srcdoc="${esc(withHeightReport(p.artifact.html))}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" title="${esc(p.title)}"></iframe>`;
  const links = [
    'src' in p.artifact ? `<a href="${esc(p.artifact.src)}" target="_blank" rel="noopener">${w.ownWindow}</a>` : '',
    p.pr ? `<a href="${esc(p.pr)}">${w.pr}</a>` : '',
  ].filter(Boolean);
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.tabTitle)}</title><style>${PAGE_STYLE}</style></head>
<body><main>
${p.top ? `<div class="top"><a href="${esc(p.top.href)}">${esc(p.top.text)}</a></div>\n` : ''}<h1>${esc(p.title)}</h1>
<div class="when">${esc(p.when)}</div>
<div class="text">${paragraphs(p.text)}</div>
${links.length ? `<div class="links">${links.join('')}</div>\n` : ''}<div class="artifact">${frame}</div>
</main>
<script>
  // an artifact as high as its window (100vh plus a margin) would grow with each step: it stops after a few
  const f = document.querySelector('.artifact iframe');
  let steps = 0;
  addEventListener('message', (e) => {
    const h = e.source === f.contentWindow && e.data && e.data.obeyaHeight;
    if (typeof h === 'number' && h > 0 && steps++ < 30) f.style.height = Math.min(Math.ceil(h), 30000) + 'px';
  });
</script>
</body></html>
`;
}

export function demoPageHtml(p: DemoPageParts): string {
  const language = p.language ?? 'de';
  const w = PAGE_WORDS[language];
  const chapters = p.chapters.length
    ? `<ol>${p.chapters.map(([at, title], i) => `<li><button data-at="${at}"${i === 0 ? ' class="on"' : ''}><span class="t">${mmss(at)}</span>${esc(title)}</button></li>`).join('')}</ol>`
    : '';
  const src = 'src' in p.video ? ` src="${esc(p.video.src)}"` : '';
  const track = 'src' in p.captions ? `<track kind="captions" src="${esc(p.captions.src)}" srclang="${language}" label="${w.captions}">` : '';
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.tabTitle)}</title><style>${PAGE_STYLE}</style></head>
<body><main>
${p.top ? `<div class="top"><a href="${esc(p.top.href)}">${esc(p.top.text)}</a></div>\n` : ''}<h1>${esc(p.title)}</h1>
<div class="when">${esc(p.when)}</div>
<div class="text">${paragraphs(p.text)}</div>
<div class="grid">
  <div class="player"><video controls preload="metadata"${src}${p.poster ? ` poster="${esc(p.poster)}"` : ''}>${track}</video><button class="start" aria-label="${w.play}"><span><svg viewBox="0 0 24 24"><path d="M6 4l15 8-15 8z"/></svg></span></button></div>
  <div>${chapters}${p.pr ? `<div class="pr"><a href="${esc(p.pr)}">${w.pr}</a></div>` : ''}</div>
</div>
</main>
${'vtt' in p.captions ? `<script type="text/vtt" id="captions">${inScript(p.captions.vtt)}</script>\n` : ''}${'base64' in p.video ? `<script type="application/octet-stream" id="video">${p.video.base64}</script>\n` : ''}<script>
  const v = document.querySelector('video'), bs = [...document.querySelectorAll('ol button')];${'base64' in p.video ? `${BLOB}  const seekable = Promise.resolve();\n` : SEEKABLE(p.video.src)}${'vtt' in p.captions ? CUES(language) : ''}
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

/** An HTML artifact's directory on a page, beside the page's `index.html`. */
export const ARTIFACT_DIR = 'artifact';

/** The files of an HTML artifact's directory, relative to it, without hidden ones. */
export function artifactFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .filter((f) => !f.split('/').some((p) => p.startsWith('.')))
    .sort();
}
