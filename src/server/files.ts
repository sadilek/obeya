// Files the owner drops into what they write that are no screenshots (a PDF, a log, a spreadsheet):
// the field gets the file's own path, for the agent to read it there and to move or change it. The
// app knows that path; a browser does not tell it, so Obeya looks for the file by its name, size and
// time in the folders files are dropped from, and where it finds no single one, keeps a copy under
// its home and the field gets that copy's path.

import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { MAX_FILE_BYTES } from '../core/types';
import { BadRequest } from './board';
import { which } from './path';

/** What a browser tells of a dropped file: its name, its size, and when it was last changed (ms since the epoch). */
export interface Dropped {
  name: string;
  size: number;
  modified: number;
}

/** How far a file's time may lie from the one the browser gives (FAT keeps it to two seconds). */
const SAME_TIME_MS = 2000;
/** The most entries a search through the folders looks at, and how deep it goes into them. */
const WALK_MAX = 30_000;
const WALK_DEPTH = 4;
/** How long Spotlight may take. */
const SPOTLIGHT_MS = 3000;

/**
 * The file on this machine the owner dropped, by its name, size and time: found by Spotlight on a
 * Mac, else (or when that finds none) in the folders files are dragged from (Downloads, Desktop,
 * Documents, the home itself). Null unless exactly one file fits.
 */
export async function findDropped(f: Dropped, home = homedir()): Promise<string | null> {
  if (!f.name || /[\\/]/.test(f.name) || !Number.isFinite(f.size) || !Number.isFinite(f.modified)) return null;
  const fits = (p: string) => {
    try {
      const s = statSync(p);
      return s.isFile() && s.size === f.size && Math.abs(s.mtimeMs - f.modified) < SAME_TIME_MS;
    } catch {
      return false;
    }
  };
  const found = new Set<string>();
  const add = (p: string) => {
    if (basename(p) === f.name && fits(p)) found.add(realpathSync(p));
  };
  for (const p of await spotlight(f.name, home)) add(p);
  if (!found.size) {
    const walked = await walk(f.name, home);
    // a search cut short may have missed another that fits
    if (!walked.whole) return null;
    for (const p of walked.found) add(p);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** The files Spotlight knows of under `home` whose name holds `name`; none off a Mac. */
async function spotlight(name: string, home: string): Promise<string[]> {
  if (process.platform !== 'darwin' || !which('mdfind')) return [];
  const p = Bun.spawn(['mdfind', '-onlyin', home, '-name', name], { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => p.kill(), SPOTLIGHT_MS);
  try {
    return (await new Response(p.stdout).text()).split('\n').filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The files named `name` in the folders files are dragged from, a few levels deep, hidden ones and
 * dependencies left out; `whole` unless the search stopped at its most entries.
 */
async function walk(name: string, home: string): Promise<{ found: string[]; whole: boolean }> {
  const found: string[] = [];
  let seen = 0;
  const roots = ['Downloads', 'Desktop', 'Documents', join('OneDrive', 'Desktop'), join('OneDrive', 'Documents')].map((d) => ({ dir: join(home, d), depth: WALK_DEPTH }));
  const queue = [...roots, { dir: home, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > WALK_MAX) return { found, whole: false };
      if (e.name === name && e.isFile()) found.push(join(dir, e.name));
      else if (depth > 0 && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') queue.push({ dir: join(dir, e.name), depth: depth - 1 });
    }
  }
  return { found, whole: true };
}

/** The file's name as it goes into a path: one word an agent reads as a path, its letters and extension kept. */
export function safeName(name: string): string {
  const s = basename(name.replace(/\\/g, '/'))
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+(\.[^.]*)?$/, '$1');
  return s.slice(-120) || 'file';
}

export class Files {
  constructor(readonly dir: string) {}

  /** Stores an uploaded file, each in a directory of its own so its name stays; returns its path. */
  save(bytes: Uint8Array, name: string): string {
    if (bytes.length > MAX_FILE_BYTES) throw new BadRequest('fileTooLarge', `a file may have at most ${MAX_FILE_BYTES} bytes`);
    const dir = join(this.dir, crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName(name));
    writeFileSync(path, bytes);
    return path;
  }

  /** The stored file `name` in folder `id` (as `save` made them), for the owner to open; null for anything else. */
  async stored(id: string, name: string): Promise<string | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || safeName(name) !== name) return null;
    const path = join(this.dir, id, name);
    return (await stat(path).catch(() => null))?.isFile() ? path : null;
  }
}

/** The images a drop in the app may hand to the page by their path, for it to attach them as screenshots, with their media types. */
const LOCAL_IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff' };

/** An image on this machine dropped in the app, by its absolute path: its file and media type, or null for anything else. */
export function localImage(path: string): { file: string; type: string } | null {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  const type = Object.hasOwn(LOCAL_IMAGES, ext) ? LOCAL_IMAGES[ext] : undefined;
  if (!type || !isAbsolute(path)) return null;
  try {
    return statSync(path).isFile() ? { file: path, type } : null;
  } catch {
    return null;
  }
}

/** The stored files `text` names by path, under `root` (Obeya's `files` directory): the directory of each, which holds it alone. */
export function filesIn(text: string, root: string): string[] {
  const at = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dirs = [...text.matchAll(new RegExp(`${at}[\\\\/][^\\\\/\\s]+[\\\\/][0-9a-f-]{36}(?=[\\\\/])`, 'g'))].map((m) => m[0]);
  return [...new Set(dirs)];
}
