import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './assemble.ts';
import { crfOf, inTvRange, toTvRange } from './range.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'range-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A video as demos were encoded before: full range from the JPEG frames, tagged so, with a sound track; a light button (238) on a white card (251). */
function fullRange(crf: number): string {
  const video = path.join(dir, 'before.mp4');
  run('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xfbfbfb:s=160x96:d=1,drawbox=x=40:y=40:w=80:h=24:c=0xeeeeee:t=fill,format=yuvj420p',
    '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-shortest', video,
  ]);
  return video;
}

const tags = (video: string) => run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'default=nw=1', video]).trim().split(/\r?\n/).sort();
const sound = (video: string) => spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).stdout.toString();

describe('a demo video brought into limited range BT.709', () => {
  test('keeps the CRF it had, copies the sound, and tags the picture as new renders are', () => {
    const before = fullRange(18);
    expect(inTvRange(before)).toBe(false);
    expect(crfOf(before)).toBe(18);
    const after = path.join(dir, 'after.mp4');
    toTvRange(before, after);
    expect(tags(after)).toEqual(['color_primaries=bt709', 'color_range=tv', 'color_space=bt709', 'color_transfer=bt709', 'pix_fmt=yuv420p']);
    expect(inTvRange(after)).toBe(true);
    expect(crfOf(after)).toBe(18);
    expect(sound(after)).toBe(sound(before));
    // a player that ignores the tag reads the stored luma: card and button both below 235, apart
    const luma = spawnSync('ffmpeg', ['-v', 'error', '-i', after, '-frames:v', '1', '-c:v', 'rawvideo', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']).stdout;
    const card = luma[80 * 160 + 10]!;
    const button = luma[52 * 160 + 80]!;
    expect(card).toBeLessThanOrEqual(235);
    expect(card - button).toBeGreaterThanOrEqual(8);
  });

  test('an ordinary demo keeps CRF 30', () => {
    const after = path.join(dir, 'after.mp4');
    toTvRange(fullRange(30), after);
    expect(crfOf(after)).toBe(30);
  });
});
