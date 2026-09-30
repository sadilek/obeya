// Camera math, from the mock: a world transform (translate, then scale) and animated flights.

import type { Bounds } from '../core/layout';

export interface Cam {
  x: number;
  y: number;
  s: number;
}

/** Cards keep a readable size; zooming out stops here, and a small screen shows a section. */
export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 2;
/** Below this scale cards drop their details. */
export const FAR = 0.72;
/** Height of the top bar the camera keeps content clear of. */
export const TOP = 70;

export const toWorld = (cam: Cam, sx: number, sy: number) => ({ x: (sx - cam.x) / cam.s, y: (sy - cam.y) / cam.s });

/** Fits `b` into the viewport minus the reserved right and bottom strips. */
export function camFor(b: Bounds, pad = 60, reserveRight = 0, reserveBottom = 60): Cam {
  const vw = innerWidth - reserveRight;
  const vh = innerHeight - TOP - reserveBottom;
  const s = Math.min(1.6, (vw - 2 * pad) / b.w, (vh - 2 * pad) / b.h);
  return { s, x: (vw - b.w * s) / 2 - b.x * s, y: TOP + (vh - b.h * s) / 2 - b.y * s };
}

/** Everything if it fits at a readable size; otherwise the middle of it at that size. */
export function overviewCam(all: Bounds): Cam {
  const fit = camFor(all, 40, 0, 60);
  const s = Math.min(1.6, Math.max(MIN_ZOOM, fit.s));
  return centreOn(all, s);
}

export function centreOn(b: Bounds, s: number): Cam {
  return { s, x: innerWidth / 2 - (b.x + b.w / 2) * s, y: TOP + (innerHeight - TOP) / 2 - (b.y + b.h / 2) * s };
}

let frame = 0;
let settle: (() => void) | null = null;

/** Animates the camera; interpolates the world point under the screen centre so it reads as a camera move. */
export function flyTo(from: Cam, to: Cam, set: (c: Cam) => void, ms = 650): Promise<void> {
  stopFlight();
  return new Promise((resolve) => {
    settle = resolve;
    const t0 = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    // zoom out a little on long flights, so the eye keeps the map
    const dist = Math.hypot((to.x - from.x) / from.s, (to.y - from.y) / from.s);
    const bump = Math.min(0.35, dist / 6000);
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const wf = toWorld(from, cx, cy);
    const wt = toWorld(to, cx, cy);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      const s = (from.s + (to.s - from.s) * e) * (1 - bump * Math.sin(Math.PI * t));
      const wx = wf.x + (wt.x - wf.x) * e;
      const wy = wf.y + (wt.y - wf.y) * e;
      if (t < 1) {
        set({ s, x: cx - wx * s, y: cy - wy * s });
        frame = requestAnimationFrame(step);
      } else {
        set(to);
        settle = null;
        resolve();
      }
    };
    frame = requestAnimationFrame(step);
  });
}

/** Ends a running flight where it is; whoever awaits it continues. */
export function stopFlight() {
  cancelAnimationFrame(frame);
  settle?.();
  settle = null;
}
