// Camera math, from the mock: a world transform (translate, then scale) and animated flights.

import type { Bounds, Place } from '../core/layout';

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

/**
 * What the panels docked at the window's edges take of it: the navigation pinned on the left, a
 * sheet on the right. The canvas is the rest between them.
 */
export interface Sides {
  left: number;
  right: number;
}
export const NO_SIDES: Sides = { left: 0, right: 0 };
/** Where the middle of the canvas is on the screen, between the panels at its sides. */
export const midX = (side: Sides) => side.left + (innerWidth - side.left - side.right) / 2;

/** Fits `b`, with a margin, into the viewport between the panels at its sides and above a strip at the bottom. */
export function camFor(b: Bounds, side = NO_SIDES): Cam {
  const pad = 40;
  const vw = innerWidth - side.left - side.right;
  const vh = innerHeight - TOP - 60;
  const s = Math.min(1.6, (vw - 2 * pad) / b.w, (vh - 2 * pad) / b.h);
  return { s, x: side.left + (vw - b.w * s) / 2 - b.x * s, y: TOP + (vh - b.h * s) / 2 - b.y * s };
}

/** Everything if it fits at a readable size; otherwise the middle of it at that size; between the panels at its sides. */
export function overviewCam(all: Bounds, side = NO_SIDES): Cam {
  return centreOn(all, Math.max(MIN_ZOOM, camFor(all, side).s), side);
}

/** `b` in the middle of the canvas between the panels at its sides, at scale `s`. */
export function centreOn(b: Bounds, s: number, side = NO_SIDES): Cam {
  return { s, x: midX(side) - (b.x + b.w / 2) * s, y: TOP + (innerHeight - TOP) / 2 - (b.y + b.h / 2) * s };
}

/** `c` laid out for the panels `to` instead of `from`: the middle of the canvas stays its middle. */
export const besideSheet = (c: Cam, from: Sides, to: Sides): Cam => {
  const d = to.right - to.left - (from.right - from.left);
  return d === 0 ? c : { ...c, x: c.x - d / 2 };
};

/** How near an edge of the view, in screen pixels, a dragged card starts it scrolling. */
export const EDGE_ZONE = 60;
/** Screen pixels per second at the very edge; it slows towards the inner side of the zone. */
const EDGE_SPEED = 1200;
/** World room kept beside the content for the dragged card, beyond its own size. */
export const DROP_ROOM = 40;

/** A rectangle of the screen, in pixels. */
export interface View {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far the view may scroll while `card` is dragged: the rest of the content plus room to drop it beside. */
export const dragLimit = (content: Bounds, card: { w: number; h: number }): Bounds => ({
  x: content.x - card.w - DROP_ROOM,
  y: content.y - card.h - DROP_ROOM,
  w: content.w + 2 * (card.w + DROP_ROOM),
  h: content.h + 2 * (card.h + DROP_ROOM),
});

/**
 * The camera after `ms` of scrolling while a card is dragged to an edge of `view`. It scrolls
 * faster the nearer the pointer is to the edge, only towards an edge the pointer moved towards
 * since `from` (a card picked up near an edge does not run off), and shows no more of the world
 * than `limit`. A view already beyond the limit stays where it is rather than jump back.
 */
export function edgeScroll(cam: Cam, pointer: { x: number; y: number }, from: { x: number; y: number }, view: View, limit: Bounds, ms: number): Cam {
  const step = (EDGE_SPEED * ms) / 1000;
  const near = (d: number) => Math.min(1, Math.max(0, (EDGE_ZONE - d) / EDGE_ZONE)) ** 2;
  const axis = (c: number, p: number, p0: number, lo: number, hi: number, wlo: number, whi: number) => {
    // towards the low edge the world moves forward, until its low limit reaches the edge
    if (p < p0) return Math.min(c + step * near(p - lo), Math.max(c, lo - wlo * cam.s));
    if (p > p0) return Math.max(c - step * near(hi - p), Math.min(c, hi - whi * cam.s));
    return c;
  };
  return {
    s: cam.s,
    x: axis(cam.x, pointer.x, from.x, view.left, view.right, limit.x, limit.x + limit.w),
    y: axis(cam.y, pointer.y, from.y, view.top, view.bottom, limit.y, limit.y + limit.h),
  };
}

/**
 * Where a new card made by a command goes: the canvas point under `pointer` when it is over `view`
 * (the part of the screen the canvas shows in), else the middle of the view; with the canvas in view.
 */
export function placeIn(cam: Cam, view: View, pointer: { x: number; y: number } | null): Place {
  const a = toWorld(cam, view.left, view.top);
  const b = toWorld(cam, view.right, view.bottom);
  const on = pointer && pointer.x >= view.left && pointer.x <= view.right && pointer.y >= view.top && pointer.y <= view.bottom;
  const at = on ? toWorld(cam, pointer.x, pointer.y) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { ...at, view: { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y } };
}

/** Whether `b` lies wholly in `view` under `cam`. */
export const shows = (cam: Cam, view: View, b: Bounds) =>
  b.x * cam.s + cam.x >= view.left && b.y * cam.s + cam.y >= view.top && (b.x + b.w) * cam.s + cam.x <= view.right && (b.y + b.h) * cam.s + cam.y <= view.bottom;

/** Screen pixels of content the view keeps when panned or zoomed (all of a smaller card). */
export const KEEP = 120;
/** The bottom strip the minimap and the microphone cover; content kept in view lies above it. */
export const BOTTOM = 150;

/**
 * `cam`, moved by as little as it takes for `view` to show at least KEEP pixels of one of `boxes`
 * in both directions, so panning and zooming never end on an empty view. No boxes, no limit.
 */
export function keepInView(cam: Cam, boxes: Bounds[], view: View): Cam {
  // how far a box spanning lo..lo+size on screen has to move to show k of it between vlo and vhi
  const shift = (lo: number, size: number, vlo: number, vhi: number) => {
    const k = Math.min(KEEP, size, vhi - vlo);
    if (lo + size < vlo + k) return vlo + k - lo - size;
    if (lo > vhi - k) return vhi - k - lo;
    return 0;
  };
  let best: { dx: number; dy: number } | null = null;
  for (const b of boxes) {
    const dx = shift(cam.x + b.x * cam.s, b.w * cam.s, view.left, view.right);
    const dy = shift(cam.y + b.y * cam.s, b.h * cam.s, view.top, view.bottom);
    if (!dx && !dy) return cam;
    if (!best || Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy)) best = { dx, dy };
  }
  return best ? { s: cam.s, x: cam.x + best.dx, y: cam.y + best.dy } : cam;
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

/** Whether the camera is in a flight. */
export const flying = () => settle !== null;

/** Ends a running flight where it is; whoever awaits it continues. */
export function stopFlight() {
  cancelAnimationFrame(frame);
  chased = null;
  settle?.();
  settle = null;
}

/** How long the camera takes to close nearly two thirds of the way to a chased target. */
export const CHASE_MS = 70;

/** One frame of a chase: `dt` ms closer to `to`, there once less than half a pixel is left. */
export function chaseStep(c: Cam, to: Cam, dt: number): Cam {
  const f = 1 - Math.exp(-dt / CHASE_MS);
  const next = { s: to.s, x: c.x + (to.x - c.x) * f, y: c.y + (to.y - c.y) * f };
  return Math.hypot(to.x - next.x, to.y - next.y) < 0.5 ? to : next;
}

let chased: Cam | null = null;

/**
 * Lets the camera glide after a target that keeps moving (the pointer held on the minimap): a call
 * with a new target while it glides only changes where it is heading, so the view neither jumps
 * nor restarts its easing. It counts as a flight and ends with `stopFlight`.
 */
export function chase(from: Cam, to: Cam, set: (c: Cam) => void) {
  const running = chased !== null;
  chased = to;
  if (running) return;
  stopFlight();
  chased = to;
  settle = () => {};
  let cur = from;
  let last = performance.now();
  const step = (now: number) => {
    if (!chased) return;
    cur = chaseStep(cur, chased, Math.min(now - last, 50));
    last = now;
    set(cur);
    if (cur === chased) {
      chased = null;
      settle = null;
    } else frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
