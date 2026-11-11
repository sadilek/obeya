// What a demo's directory holds, read by Obeya: a file by its real path inside it, an HTML
// artifact's files, a video demo's files and caption tracks, whether its video is silent and how
// large, and the copy Obeya keeps of a demo handed over.

import { closeSync, constants, copyFileSync, type Dirent, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { DemoKind } from '../core/types';
import { listedTracks, trackFile } from '../../plugin/skills/demo/lib/subtitles.ts';
import { messageOf } from '../core/text';

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

/** A caption track of a video demo's directory: its file, and its language, unknown for a demo from before the tracks. */
export interface CaptionTrack {
  file: string;
  language?: string;
}

/**
 * The caption tracks of a video demo's directory: those its `captions.vtt` names (`listedTracks`), a
 * file per language (`captions.<language>.vtt`) in their order, none where it names none; one from
 * before it named them has its `captions.vtt` alone.
 */
export function captionTracks(dir: string): CaptionTrack[] {
  let narration: string;
  try {
    narration = readFileSync(join(dir, 'captions.vtt'), 'utf8');
  } catch {
    return [];
  }
  const listed = namedTracks(narration);
  if (!listed) return [{ file: 'captions.vtt' }];
  return listed.filter((t) => existsSync(join(dir, t.file)));
}

/** `captionTracks` without blocking the server. */
export async function captionTracksAsync(dir: string): Promise<CaptionTrack[]> {
  let narration: string;
  try {
    narration = await readFile(join(dir, 'captions.vtt'), 'utf8');
  } catch {
    return [];
  }
  const listed = namedTracks(narration);
  if (!listed) return [{ file: 'captions.vtt' }];
  const there = await Promise.all(listed.map((t) => stat(join(dir, t.file)).then(() => true, () => false)));
  return listed.filter((_, i) => there[i]);
}

/** The tracks a `captions.vtt` names (`listedTracks`), each by its file, whether there or not; null where it names none. */
function namedTracks(narration: string): Required<CaptionTrack>[] | null {
  const listed = listedTracks(narration);
  return listed ? listed.flatMap((language) => (/^[A-Za-z0-9-]+$/.test(language) ? [{ file: trackFile(language), language }] : [])) : null;
}

/** How much of an MP4's start is searched for its tracks: the director writes them there (`+faststart`). */
const MP4_HEAD = 4 << 20;

/** The start of an MP4 (`MP4_HEAD`), where its track list is; null where it cannot be read. */
function mp4Head(file: string): Buffer | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(MP4_HEAD);
      return head.subarray(0, readSync(fd, head, 0, MP4_HEAD, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Whether a demo video has no sound: an MP4 whose track list, at its start, holds no audio
 * track (a handler of type `soun`). One whose list is not at its start counts as having sound.
 */
export const silentVideo = (file: string): boolean => silentHead(mp4Head(file));

/** `silentVideo` without blocking the server. */
export async function silentVideoAsync(file: string): Promise<boolean> {
  let head: Buffer | null = null;
  try {
    const f = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(MP4_HEAD);
      head = buffer.subarray(0, (await f.read(buffer, 0, MP4_HEAD, 0)).bytesRead);
    } finally {
      await f.close();
    }
  } catch {}
  return silentHead(head);
}

/** `silentVideo` of an MP4's start (`mp4Head`). */
function silentHead(head: Buffer | null): boolean {
  const text = head?.toString('latin1');
  if (!text?.includes('moov')) return false;
  // a `hdlr` box: its type, four bytes of version and flags, four predefined, then the handler's type
  return !/hdlr[\s\S]{8}soun/.test(text);
}

/**
 * A demo video's width and height in pixels: those of the first track in the list at the MP4's
 * start that has a picture (its `tkhd` box); null where there is none.
 */
export function videoSize(file: string): [number, number] | null {
  const head = mp4Head(file);
  if (!head) return null;
  for (let at = head.indexOf('tkhd'); at >= 0; at = head.indexOf('tkhd', at + 4)) {
    // after the type: version and flags, then times, track and duration (wider in version 1), reserved,
    // layer, group, volume, reserved and the matrix, then width and height as 16.16 fixed point
    const box = at + 4;
    const size = box + 4 + (head[box] === 1 ? 32 : 20) + 52;
    if (size + 8 > head.length) return null;
    const w = Math.round(head.readUInt32BE(size) / 65536);
    const h = Math.round(head.readUInt32BE(size + 4) / 65536);
    if (w > 0 && h > 0) return [w, h];
  }
  return null;
}

/** The files of a video demo the UI loads, beside a caption file per language (`captions.<language>.vtt`); nothing else in the directory is served. */
export const DEMO_FILES = ['demo.mp4', 'poster.jpg', 'captions.vtt'] as const;

/** Whether a file of a video demo's directory is one the UI loads (`DEMO_FILES`, a caption track). */
export const isDemoFile = (name: string) => (DEMO_FILES as readonly string[]).includes(name) || /^captions\.[A-Za-z0-9-]+\.vtt$/.test(name);

/** The files of a video demo's directory that are served, published and passed on: those of `DEMO_FILES` it has, and its caption tracks. */
export const demoFiles = (dir: string): string[] =>
  [...DEMO_FILES, ...captionTracks(dir).flatMap((t) => (t.language ? [t.file] : []))].filter((f) => demoFile(dir, f));

/**
 * Copies the files of a demo handed over into `to`, replacing what was there, with their times
 * (a page names the day its demo was made): a video's that are served and published
 * (`demoFiles`) and its report page, whose language a page takes; an artifact's (`artifactFiles`).
 * A worker renders a later demo of the card into the same directory as often as not, which
 * overwrites this one; the card goes back to it, and shares it, from the copy. Copy-on-write where
 * the file system has it. Whether the copy is whole.
 */
export function keepDemo(demo: { dir: string; kind: DemoKind }, to: string): boolean {
  try {
    rmSync(to, { recursive: true, force: true });
    const files = demo.kind === 'html' ? artifactFiles(demo.dir) : [...demoFiles(demo.dir), ...(demoFile(demo.dir, 'index.html') ? ['index.html'] : [])];
    if (!files.length) return false;
    for (const f of files) {
      const from = demoFile(demo.dir, f)!;
      mkdirSync(dirname(join(to, f)), { recursive: true });
      copyFileSync(from, join(to, f), constants.COPYFILE_FICLONE);
      const { atime, mtime } = statSync(from);
      utimesSync(join(to, f), atime, mtime);
    }
    return true;
  } catch (e) {
    console.error(`keeping a copy of the demo in ${demo.dir}:`, messageOf(e));
    rmSync(to, { recursive: true, force: true });
    return false;
  }
}

/**
 * What a player needs to know of a video demo beyond its files: the languages of its caption
 * tracks in their order (empty: no subtitles; none for a demo from before them, whose track is its
 * `captions.vtt`), whether it is silent, and its width and height.
 */
export function videoFacts(dir: string): { tracks?: string[]; silent?: true; size?: [number, number] } {
  const all = captionTracks(dir);
  const tracks = all.flatMap((t) => (t.language ? [t.language] : []));
  const video = demoFile(dir, 'demo.mp4');
  const size = video && videoSize(video);
  return { ...(all.some((t) => !t.language) ? {} : { tracks }), ...(video && silentVideo(video) ? { silent: true as const } : {}), ...(size ? { size } : {}) };
}
