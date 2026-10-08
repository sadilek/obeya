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

/** A narration as it is shown (captions) and checked: without audio tags ("[short pause]"), which only some voices read. */
export function untagged(say: string) {
  return say.replace(/\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** The clock strip `overlay.js` paints: its cells, their size and where it sits. */
export const CLOCK = { bits: 24, cell: 3, left: 2, bottom: 3 };

/**
 * The time a frame was painted, from one row of gray pixels across its clock strip (`CLOCK.cell`
 * pixels per cell, the row through the middle of the strip), and the frame's stamp to place the
 * code's 46 hours in. Null where a cell is neither clearly black nor clearly white: the strip is
 * missing (a page without the overlay) or caught mid-change.
 */
export function readClock(row: Uint8Array, stamp: number): number | null {
  let code = 0;
  for (let i = 0; i < CLOCK.bits; i++) {
    const v = row[i * CLOCK.cell + 1]!;
    if (v > 80 && v < 175) return null;
    code = code * 2 + (v <= 80 ? 1 : 0);
  }
  const span = 2 ** CLOCK.bits;
  const k = Math.round((stamp * 100 - code) / span);
  return (code + k * span) / 100;
}

/**
 * Frames on the time they were painted, where their clock strip says it (`times`; null where it
 * cannot be read: the frame's stamp less the delay last read), never earlier than the frame
 * before. On a busy machine the screencast handed frames over up to 5 s after they were painted
 * (8 Oct 2026), and their stamps are the hand-over: the picture trailed the narration by as much.
 */
export function onPaintTime(frames: Frame[], times: (number | null)[]): Frame[] {
  let last = -Infinity;
  let delay = 0;
  return frames.map((f, i) => {
    const painted = times[i];
    if (painted != null) delay = f.t - painted;
    last = Math.max(last, painted ?? f.t - delay);
    return { ...f, t: last };
  });
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
