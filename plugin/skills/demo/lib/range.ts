// The colours of a demo video: limited range BT.709, tagged so (docs/design/demos.md, Decisions).
// The frames are full-range JPEGs; a video encoded from them as they came is full range and
// tagged as such, which a phone's player that ignores the tag shows with everything brighter than
// 235 of 255 as white. `assemble` encodes every new video this way, and `toTvRange` brings a video
// encoded before into the same range with the same tags (`scripts/video-range.ts`).

import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';

/** The filters scaling the picture to `width` × `height` in limited range BT.709, tagged so. */
export const tvRange = (width: number | string, height: number | string) =>
  `scale=${width}:${height}:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709`;

/** CRF of a demo video: 30 keeps text sharp at about 2.5 MB per minute; a public one (`sharp`) gets 18. */
export const crfFor = (sharp: boolean) => (sharp ? 18 : 30);

/** Whether the video's picture is limited range BT.709 already, as `tvRange` makes it. */
export function inTvRange(video: string): boolean {
  const tags = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space', '-of', 'default=nw=1', video], { encoding: 'utf8' });
  return /color_range=tv/.test(tags) && /color_space=bt709/.test(tags);
}

/** The CRF libx264 encoded the video with, from the settings it writes into the stream; null where it names none. */
export function crfOf(video: string): number | null {
  // the settings are near the start, in the first frame's SEI; the index may come first (faststart)
  const fd = openSync(video, 'r');
  try {
    const buf = Buffer.alloc(4 << 20);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const crf = /x264 - core [^\0]*?\bcrf=(\d+(?:\.\d+)?)/.exec(buf.subarray(0, n).toString('latin1'))?.[1];
    return crf ? Number(crf) : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Encodes the picture of `video` anew into `out`, in limited range BT.709, with the CRF it had
 * (`crfOf`; a video that names none is taken as an ordinary demo's); its sound and everything else
 * is copied as it is.
 */
export function toTvRange(video: string, out: string) {
  const crf = crfOf(video) ?? crfFor(false);
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', video,
      '-map', '0', '-c', 'copy',
      '-vf', tvRange('iw', 'ih'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-tune', 'stillimage',
      '-movflags', '+faststart',
      '-f', 'mp4', out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}
