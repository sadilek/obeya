// A card's demo: the directory the `demo` skill rendered into, or an HTML artifact the worker
// made instead, read and served by Obeya.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pagePolicy, withHeightReport, withMarkReport } from '../core/frame';
import { chapterAt, type DemoKind } from '../core/types';
import { filesKey, ownOrigin } from './access';
import { captionTracks, demoFile, esc, silentVideo } from './demo-page';
import type { FileAt } from './workspaces';
import { resource } from './resources';

/**
 * The plugin Obeya loads into its workers' sessions: it brings the demo skill (`obeya:demo`), the
 * pipeline that records a demo. A Claude Code session without Obeya reaches the same skill through
 * the plugin or a user skill that points to `plugin/skills/demo`.
 */
export const OBEYA_PLUGIN = resource('plugin');
export const DEMO_SKILL = 'obeya:demo';

/** The demo skill's instructions, for a session that does not know the skill to read. */
export const DEMO_SKILL_FILE = join(OBEYA_PLUGIN, 'skills', 'demo', 'SKILL.md');

/** What is wrong with the plugin workers load, for the log at start; null when nothing is. */
export function checkPlugin(dir = OBEYA_PLUGIN): string | null {
  for (const f of [join('.claude-plugin', 'plugin.json'), join('skills', 'demo', 'SKILL.md')])
    if (!existsSync(join(dir, f))) return `${join(dir, f)} is missing: workers' sessions have no demo skill`;
  return null;
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * The name of the demo skill in a worker's session on this machine. Claude Code lists a skill file
 * once: a user skill that links to the plugin's (`~/.claude/skills/demo` pointing to
 * `plugin/skills/demo`, as a session without Obeya reaches the skill) is listed under its own name
 * instead, and the session knows no `obeya:demo`.
 */
export function demoSkillName(skills = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills'), file = DEMO_SKILL_FILE): string {
  const own = realpath(file);
  if (!own || !existsSync(skills)) return DEMO_SKILL;
  return readdirSync(skills).find((name) => realpath(join(skills, name, 'SKILL.md')) === own) ?? DEMO_SKILL;
}

/** The files of a video demo the UI loads, beside a caption file per language (`captions.<language>.vtt`); nothing else in the directory is served. */
export const DEMO_FILES = ['demo.mp4', 'poster.jpg', 'captions.vtt'] as const;

/** Whether a file of a video demo's directory is one the UI loads (`DEMO_FILES`, a caption track). */
export const isDemoFile = (name: string) => (DEMO_FILES as readonly string[]).includes(name) || /^captions\.[A-Za-z0-9-]+\.vtt$/.test(name);

/** The files of a video demo's directory that are served, published and passed on: those of `DEMO_FILES` it has, and its caption tracks. */
export const demoFiles = (dir: string): string[] =>
  [...DEMO_FILES, ...captionTracks(dir).flatMap((t) => (t.language ? [t.file] : []))].filter((f) => demoFile(dir, f));

/**
 * What a player needs to know of a video demo beyond its files: the languages of its caption
 * tracks in their order (empty: no subtitles; none for a demo from before them, whose track is its
 * `captions.vtt`), and whether it is silent.
 */
export function videoFacts(dir: string): { tracks?: string[]; silent?: true } {
  const all = captionTracks(dir);
  const tracks = all.flatMap((t) => (t.language ? [t.language] : []));
  const video = demoFile(dir, 'demo.mp4');
  return { ...(all.some((t) => !t.language) ? {} : { tracks }), ...(video && silentVideo(video) ? { silent: true as const } : {}) };
}

/** The page of an HTML artifact; the files beside it (images, styles) are served too. */
export const ARTIFACT_PAGE = 'index.html';

/** What is wrong with an HTML artifact's directory, for the worker to fix; null when nothing is. */
export function checkArtifact(dir: string): string | null {
  return existsSync(join(dir, ARTIFACT_PAGE)) ? null : `${ARTIFACT_PAGE} is missing in ${dir}`;
}

/** The skill starts narration this long after its scene; a chapter starts at the scene. */
const NARRATION_LEAD = 0.35;

/**
 * Chapter marks for the scene titles, from `chapters.vtt` (one cue per scene, in order), or from
 * the captions of a demo without one, rendered when they had one cue per scene. Returns what is
 * wrong with the directory instead, for the worker to fix.
 */
export function readChapters(dir: string, titles: string[]): [number, string][] | string {
  for (const f of ['demo.mp4', 'captions.vtt']) if (!existsSync(join(dir, f))) return `${f} is missing in ${dir}`;
  const scenes = cues(dir, 'chapters.vtt').map((c) => c.start);
  if (scenes.length) {
    if (scenes.length !== titles.length) return `chapters.vtt has ${scenes.length} scenes but ${titles.length} chapter titles were given`;
    return titles.map((t, i) => [Math.max(0, Math.round(scenes[i]! * 100) / 100), t]);
  }
  const starts = cues(dir).map((c) => c.start);
  if (starts.length !== titles.length) return `captions.vtt has ${starts.length} cues but ${titles.length} chapter titles were given`;
  return titles.map((t, i) => [Math.max(0, Math.round((starts[i]! - NARRATION_LEAD) * 100) / 100), t]);
}

/**
 * The chapter marks of a video demo made anew in its directory (re-voiced, say), titles and all,
 * from its `chapters.vtt` (one cue per scene, its title). Returns what is wrong instead.
 */
export function rereadChapters(dir: string): [number, string][] | string {
  if (!existsSync(join(dir, 'chapters.vtt'))) return `chapters.vtt is missing in ${dir}`;
  return readChapters(dir, cues(dir, 'chapters.vtt').map((c) => c.text));
}

/** The cues of a demo's captions (one per sentence of its narration; per scene before 2026-11), or of another WebVTT file of it. */
function cues(dir: string, file = 'captions.vtt'): { start: number; end: number; text: string }[] {
  let vtt: string;
  try {
    vtt = readFileSync(join(dir, file), 'utf8');
  } catch {
    return [];
  }
  const time = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  return [...vtt.matchAll(/^(\d+):(\d{2}):(\d{2})\.(\d{3}) --> (\d+):(\d{2}):(\d{2})\.(\d{3})[^\n]*\n([\s\S]*?)(?:\n\s*\n|$)/gm)].map((c) => ({
    start: time(c[1]!, c[2]!, c[3]!, c[4]!),
    end: time(c[5]!, c[6]!, c[7]!, c[8]!),
    text: c[9]!.replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * The chapter at a place in a demo video and what its narration says around there: the sentence of
 * the scene's cue that the place falls on, by its share of the cue's time (the voice speaks evenly
 * enough for that); between cues, the last one's last sentence.
 */
export function placeIn(dir: string, chapters: [number, string][], at: number): { chapter?: string; narration?: string } {
  const chapter = chapters[chapterAt(chapters, at)]?.[1];
  const cue = cues(dir).findLast((c) => c.start <= at + 0.05);
  let narration: string | undefined;
  if (cue) {
    const sentences = cue.text.match(/[^.!?…]+(?:[.!?…]+[»«“”"']?|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [cue.text];
    const share = at >= cue.end ? 1 : (at - cue.start) / Math.max(0.1, cue.end - cue.start);
    const offset = Math.min(cue.text.length - 1, Math.max(0, share * cue.text.length));
    let passed = 0;
    narration = sentences.find((x) => (passed += x.length + 1) > offset) ?? sentences.at(-1);
  }
  return { ...(chapter ? { chapter } : {}), ...(narration ? { narration } : {}) };
}

/** The most of a demo file one byte-range answer carries: a minute and more of a demo video. */
const RANGE_BYTES = 8 << 20;

/** Serves one demo file: a video's with byte ranges so the player can seek, any file of an HTML artifact's directory. */
export function serveDemoFile(demo: { dir: string; kind: DemoKind }, name: string, req: Request, route = '/demo/'): Response {
  if (demo.kind === 'html') return serveSandboxed(demo.dir, name, req, route, (path) => path === demoFile(demo.dir, ARTIFACT_PAGE));
  const dir = demo.dir;
  if (!isDemoFile(name)) return notFound();
  const path = demoFile(dir, name);
  if (!path) return notFound();
  const type = name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.jpg') ? 'image/jpeg' : 'text/vtt; charset=utf-8';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  // The size and the read refer to the same open file: a retake may rewrite it meanwhile.
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (!range || (!range[1] && !range[2])) {
      // the poster and the captions, read at once as a range is
      if (size > RANGE_BYTES) return new Response(Bun.file(path), { headers: { 'content-type': type, 'accept-ranges': 'bytes' } });
      const body = readAt(fd, size, 0);
      return new Response(body, { headers: { 'content-type': type, 'content-length': String(body.length), 'accept-ranges': 'bytes' } });
    }
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    // the player asks again for what follows, so a part of the file at a time
    end = Math.min(end, size - 1, start + RANGE_BYTES - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    // Read at once: see "Demo files are read at once" in docs/design/demos.md.
    const part = readAt(fd, end - start + 1, start);
    // shorter than its size said: cut while it was read, so the answer carries what was there
    const total = part.length < end - start + 1 ? fstatSync(fd).size : size;
    if (!part.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    return new Response(part, {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(part.length),
        'content-range': `bytes ${start}-${start + part.length - 1}/${Math.max(total, start + part.length)}`,
        'accept-ranges': 'bytes',
      },
    });
  } finally {
    closeSync(fd);
  }
}

/** Up to `length` bytes of the open file from `position` on, fewer where it ends sooner. */
function readAt(fd: number, length: number, position: number): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, position + read);
    if (!got) break;
    read += got;
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
}

/**
 * Lets a worker's page read the files beside it, and no other page. Its sandboxed frame's origin is
 * `null`, so what its page loads in CORS mode (a module script, `fetch()`, a font) needs
 * `Access-Control-Allow-Origin: null`, which any sandboxed page on any site matches; a request from
 * that frame carries neither a referrer nor anything else of its own. Its address does: the page is
 * sent on to `<directory>/~<key>/index.html`, so whatever it loads relative to itself carries the
 * key, which nobody can know without Obeya's API; the server lets a request with it in without the
 * owner's cookie (access.ts). Only an address with the key gets the header.
 *
 * `route`: where the route's file path begins (`/demo/`, `/demos/2/` for an earlier demo); `name`: the file path after it, decoded.
 * Returns the file path without the key, or the redirect to the address with it.
 */
function keyed(req: Request, route: string, name: string): string | Response {
  const url = new URL(req.url);
  const at = url.pathname.indexOf(route);
  if (at < 0) return notFound();
  const base = url.pathname.slice(0, at + route.length);
  const key = filesKey(base);
  const given = /^~([0-9a-f]{32})\/(.*)$/s.exec(name);
  if (given?.[1] === key) return given[2]!;
  const file = (given ? given[2]! : name).split('/').map(encodeURIComponent).join('/');
  return new Response(null, { status: 302, headers: { location: `${base}~${key}/${file}${url.search}`, 'cache-control': 'no-store' } });
}

/**
 * A file a looked-up answer comes with, never one outside its thread's output directory. A page runs
 * sandboxed as an HTML artifact does, and tells its frame its height; `download`: as a file to save.
 */
export function serveAnswerFile(dir: string, asked: string, download: boolean, req: Request): Response {
  return serveSandboxed(dir, asked, req, '/files/', (path) => /\.html?$/i.test(path), download);
}

/**
 * What a worker's page may connect to beyond what its CSP covers (`Connection-Allowlist`, Chrome 152
 * on): only the address it was served from, so neither a `preconnect` nor WebRTC reaches another
 * server. It holds for the document, also once the page writes another into it.
 */
export const OWN_CONNECTIONS = '(response-origin)';

/** The headers of a page that loads nothing from the internet, nor files of its own where `own` (the address they are served from) is missing; see `pagePolicy`. */
function sealedHeaders(own?: string): Record<string, string> {
  return {
    'content-security-policy': `sandbox allow-scripts; ${pagePolicy(own)}`,
    'connection-allowlist': own ? OWN_CONNECTIONS : '()',
    'x-dns-prefetch-control': 'off',
  };
}

/** The address a request was sent to, for a policy: only as plain a scheme and host as `refusal` lets through. */
function servedFrom(req: Request): string | undefined {
  const origin = ownOrigin(req);
  return /^https?:\/\/[a-z0-9.\-[\]:]+$/.test(origin) ? origin : undefined;
}

/**
 * A file of a worker's directory (an HTML artifact's, a looked-up answer's), never one outside it.
 * It is the worker's, so it runs sandboxed: scripts yes, but in an origin of its own, without
 * Obeya's API or the canvas's storage, and connecting to nothing but the address of the files beside
 * it (`pagePolicy`, `OWN_CONNECTIONS`). A `page` tells its frame its height, so the frame grows to it
 * instead of scrolling inside, and what the owner marks in it, to quote it. Opened in a window of its own (a link on the card), a file that may run
 * scripts (HTML, SVG) comes in a frame of a page around it (`framed`): alone in its window a page
 * could navigate itself to another server, in the frame the page around it keeps it from that.
 */
function serveSandboxed(dir: string, asked: string, req: Request, route: string, page: (path: string) => boolean, download = false): Response {
  const name = keyed(req, route, asked);
  if (name instanceof Response) return name;
  const path = demoFile(dir, name);
  if (!path) return notFound();
  return sandboxed({ path }, basename(path), req, page(path), download);
}

/** A worker's file (on disk, or what a commit holds) as `serveSandboxed` sends it; `page`: it tells its frame its height. */
function sandboxed(file: FileAt, name: string, req: Request, page: boolean, download: boolean): Response {
  // the type by the name, for what a commit holds too
  const type = Bun.file(name).type;
  if (!download && req.headers.get('sec-fetch-dest') === 'document' && /html|svg|xml/.test(type)) return framed(name);
  const body = 'path' in file ? Bun.file(file.path) : file.data;
  // without an address to name, the page gets no files beside it rather than a policy that names something else
  const headers = { 'content-type': type, ...sealedHeaders(servedFrom(req)), 'cache-control': 'no-cache', 'access-control-allow-origin': 'null' };
  if (download) return new Response(body, { headers: { ...headers, 'content-disposition': attachment(name) } });
  if (page) return new Response(withMarkReport(withHeightReport('path' in file ? readFileSync(file.path, 'utf8') : new TextDecoder().decode(file.data))), { headers });
  return new Response(body, { headers });
}

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * A file a card's work made or changed (`Workers.file`), as its left column loads it: sandboxed as an
 * HTML artifact's files are, a page telling its frame its height. A PDF comes as a PDF for the
 * browser's viewer, which shows none in a sandboxed frame or under a CSP sandbox: without the
 * sandbox, with a policy that allows it nothing beyond, and `nosniff`, which keeps a file named
 * `.pdf` from being read as anything else.
 * `get`: the file by its path, once the key in the address is checked.
 */
export async function serveCardFile(asked: string, download: boolean, req: Request, get: (path: string) => Promise<FileAt | null>): Promise<Response> {
  const path = keyed(req, '/files/', asked);
  if (path instanceof Response) return path;
  const file = await get(path);
  if (!file) return notFound();
  const name = basename(path);
  if (/\.pdf$/i.test(name)) {
    const body = 'path' in file ? Bun.file(file.path) : file.data;
    // the viewer runs a PDF's scripts, and sent nothing on its own when tried (form submission, links, getURL, launchURL);
    // in case a later one does, the policies of a worker's page say no further, which leave the viewer as it is
    const headers: Record<string, string> = {
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; form-action 'none'; frame-ancestors 'self'",
      'connection-allowlist': OWN_CONNECTIONS,
      'x-dns-prefetch-control': 'off',
      'cache-control': 'no-cache',
      ...(download ? { 'content-disposition': attachment(name) } : {}),
    };
    return new Response(body, { headers });
  }
  return sandboxed(file, name, req, /\.html?$/i.test(name), download);
}

/** Points the frame at the page's own address, the part after `#` included, which never reaches the server. */
const FRAMED_SCRIPT = "document.querySelector('iframe').src = location.pathname + location.search + location.hash;";
const FRAMED_HASH = `'sha256-${new Bun.CryptoHasher('sha256').update(FRAMED_SCRIPT).digest('base64')}'`;

/** A page that holds the file at its own address in a sandboxed frame filling the window, and frames nothing from elsewhere. */
function framed(title: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="allow-scripts"></iframe><script>${FRAMED_SCRIPT}</script></body></html>`;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src ${FRAMED_HASH}; frame-src 'self'`, 'cache-control': 'no-cache' };
  return new Response(html, { headers });
}

/**
 * The frame an idea's mock is shown in (`MockFrame` in src/ui/detail.tsx): empty, sandboxed and
 * connecting to nothing, until the page around it sends the mock's page (`{ obeyaPage }`), which it
 * writes into itself; the policy stays with the document. A mock given as `srcdoc` would get no
 * `Connection-Allowlist`, which only a response can carry.
 */
const MOCK_FRAME = `<!doctype html><script>addEventListener('message', function once(e) {
  if (e.source !== parent || typeof (e.data && e.data.obeyaPage) !== 'string') return;
  removeEventListener('message', once);
  document.open();
  document.write(e.data.obeyaPage);
  document.close();
});</script>`;

export function serveMockFrame(): Response {
  return new Response(MOCK_FRAME, { headers: { 'content-type': 'text/html; charset=utf-8', ...sealedHeaders(), 'cache-control': 'no-cache' } });
}

const notFound = () => new Response('Not found', { status: 404 });
