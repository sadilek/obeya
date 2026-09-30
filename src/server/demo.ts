// A card's demo: the directory the `demo` skill rendered into, read and served by Obeya.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The files of a demo the UI loads; nothing else in the directory is served. */
export const DEMO_FILES = ['demo.mp4', 'poster.jpg', 'captions.vtt'] as const;

/** The skill starts narration this long after its scene; a chapter starts at the scene. */
const NARRATION_LEAD = 0.35;

/**
 * Chapter marks for the scene titles, from the captions (one cue per scene, in order).
 * Returns what is wrong with the directory instead, for the worker to fix.
 */
export function readChapters(dir: string, titles: string[]): [number, string][] | string {
  for (const f of ['demo.mp4', 'captions.vtt']) if (!existsSync(join(dir, f))) return `${f} is missing in ${dir}`;
  const starts = [...readFileSync(join(dir, 'captions.vtt'), 'utf8').matchAll(/^(\d+):(\d{2}):(\d{2})\.(\d{3}) -->/gm)].map(
    ([, h, m, s, ms]) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000,
  );
  if (starts.length !== titles.length) return `captions.vtt has ${starts.length} cues but ${titles.length} chapter titles were given`;
  return titles.map((t, i) => [Math.max(0, Math.round((starts[i]! - NARRATION_LEAD) * 100) / 100), t]);
}

/** Serves one demo file, with byte ranges so the player can seek. */
export function serveDemoFile(dir: string, name: string, req: Request): Response {
  if (!(DEMO_FILES as readonly string[]).includes(name)) return new Response('Not found', { status: 404 });
  const path = join(dir, name);
  if (!existsSync(path)) return new Response('Not found', { status: 404 });
  const size = statSync(path).size;
  const file = Bun.file(path);
  const type = name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.jpg') ? 'image/jpeg' : 'text/vtt; charset=utf-8';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (!range || (!range[1] && !range[2])) {
    return new Response(file, { headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' } });
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
    },
  });
}
