import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble, run } from './assemble.ts';

describe('assemble', () => {
  test('the video is limited range BT.709, so a player that ignores the range tag keeps light buttons on a white card apart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-'));
    const work = path.join(dir, '.work');
    fs.mkdirSync(work);
    // a white card (251 of 255, as Obeya's cards record) with a light button on it (238)
    const frame = path.join(work, '0.jpg');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xfbfbfb:s=160x96,drawbox=x=40:y=40:w=80:h=24:c=0xeeeeee:t=fill', '-frames:v', '1', '-q:v', '1', frame]);
    const list = path.join(work, 'frames.txt');
    fs.writeFileSync(list, "ffconcat version 1.0\nfile '0.jpg'\nduration 1.0000\nfile '0.jpg'\n");
    const silentLog = console.log;
    console.log = () => {};
    try {
      assemble({
        outDir: dir, work, list, marks: [{ title: 'Card', start: 0, speechStart: 0, speechEnd: 0, sentences: [] }], total: 1,
        viewport: { width: 160, height: 96 }, sharp: false, title: 'Colours', narration: { language: 'en', scenes: [[]] }, tracks: [],
        report: { summary: 'A card.', meta: {} }, language: 'en',
      });
    } finally {
      console.log = silentLog;
    }
    const video = path.join(dir, 'demo.mp4');
    const tags = run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'default=nw=1', video]);
    expect(tags.trim().split('\n').sort()).toEqual(['color_primaries=bt709', 'color_range=tv', 'color_space=bt709', 'color_transfer=bt709', 'pix_fmt=yuv420p']);
    // the stored luma, as a player reads it: card and button both below 235, the limit of white
    const luma = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-frames:v', '1', '-c:v', 'rawvideo', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']).stdout;
    const at = (x: number, y: number) => luma[y * 160 + x]!;
    const card = at(10, 80);
    const button = at(80, 52);
    expect(card).toBeLessThanOrEqual(235);
    expect(card - button).toBeGreaterThanOrEqual(8);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
