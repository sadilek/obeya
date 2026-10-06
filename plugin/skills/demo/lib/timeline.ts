// The video's timeline: the recording runs in real time, but stretches in which the demo only waits
// (an agent thinking, a build) are cut out of it (`Director.skip`). Everything placed on the video
// (frames, narration, chapters, captions) goes through `videoTime`.
import type { NarrationLanguage } from './settings.ts';

/** A stretch of real time, in seconds since the epoch, that the video leaves out. */
export interface Cut {
  from: number;
  to: number;
}

/** Where real time `t` lands in a video that starts at `t0` with `cuts` (all after `t0`) left out. */
export function videoTime(t: number, t0: number, cuts: Cut[]) {
  let v = t - t0;
  for (const c of cuts) v -= Math.max(0, Math.min(t, c.to) - c.from);
  return v;
}

export interface Frame {
  file: string;
  t: number;
  width: number;
  height: number;
}

/**
 * Each frame with how long it is held in the video, from `t0` to `tEnd`: until the next frame,
 * less what a cut takes out. A frame shown only inside a cut is dropped; the last one before a
 * cut ends carries on after it.
 */
export function frameDurations(frames: Frame[], t0: number, tEnd: number, cuts: Cut[]) {
  const at = (t: number) => videoTime(Math.max(t, t0), t0, cuts);
  const firstIdx = Math.max(0, frames.findLastIndex((f) => f.t <= t0));
  const used = frames.slice(firstIdx).filter((f) => f.t < tEnd);
  const held = used.map((f, i) => ({ file: f.file, seconds: (i + 1 < used.length ? at(used[i + 1]!.t) : at(tEnd)) - at(f.t) }));
  return held.filter((h, i) => h.seconds >= 0.0005 || i === held.length - 1).map((h) => ({ ...h, seconds: Math.max(0.001, h.seconds) }));
}

/** What the picture says during a cut: how much later it is when the demo goes on. */
export function laterLabel(seconds: number, language: NarrationLanguage) {
  const s = Math.max(1, Math.round(seconds));
  const m = Math.round(seconds / 60);
  if (language === 'en') {
    if (s < 60) return s === 1 ? 'a second later' : `${s} seconds later`;
    return m === 1 ? 'a minute later' : `${m} minutes later`;
  }
  if (s < 60) return s === 1 ? 'eine Sekunde später' : `${s} Sekunden später`;
  return m === 1 ? 'eine Minute später' : `${m} Minuten später`;
}
