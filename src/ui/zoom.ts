// Showing a demo video or a walkthrough large over the greyed page, short of full screen: the same
// element (it keeps playing) grows out of its place and goes back into it. Z or the magnifier on it
// toggles it, Esc or a click beside it ends it. Z takes the zoomed one, else the one playing, else
// the one under the pointer, else the first one in sight. Hovering the magnifier shows the key
// until the owner first used it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useKnown } from './stored';
import { type Box, onto, ZOOM_EASE, ZOOM_MS } from './zoomBox';

/** Set once the owner zoomed with Z: the magnifier stops showing the key beside it. */
const ZOOM_KEY_KNOWN = 'obeya-zoom-key-known';

/** A key with no modifier, pressed outside a text field and with nothing over the page: one for what plays. */
export function plainKey(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return false;
  return !document.querySelector('#help, #config.on, .lightbox, .diff-view');
}

interface Zoomable {
  el: () => HTMLElement | null;
  zoomed: () => boolean;
  playing: () => boolean;
  toggle: () => void;
  keyed: () => void;
}
const zoomables = new Set<Zoomable>();

/** Whether the middle of `el` is in the window and not covered by something else. */
function inSight(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (!r.width || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const top = document.elementFromPoint(x, y);
  return !!top && el.contains(top);
}

/** Where the pointer was last, for the one under it. */
let pointer: { x: number; y: number } | undefined;

/** Whether the pointer is over `el`, and nothing else covers it there. */
function underPointer(el: HTMLElement) {
  const top = pointer && document.elementFromPoint(pointer.x, pointer.y);
  return !!top && el.contains(top);
}

/** What Z zooms: the zoomed one, else the one playing, else the one under the pointer, else the first in sight. */
function keyedZoomable() {
  const all = [...zoomables].filter((z) => z.el()?.isConnected);
  all.sort((a, b) => (a.el()!.compareDocumentPosition(b.el()!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return all.find((z) => z.zoomed()) ?? all.find((z) => z.playing()) ?? all.find((z) => underPointer(z.el()!)) ?? all.find((z) => inSight(z.el()!));
}

// once per page; a test without a window imports it too
if (typeof window !== 'undefined') window.addEventListener('pointermove', (e: PointerEvent) => void (pointer = { x: e.clientX, y: e.clientY }), { passive: true });
if (typeof window !== 'undefined') window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    for (const z of zoomables) if (z.zoomed()) z.toggle();
    return;
  }
  if ((e.key !== 'z' && e.key !== 'Z') || e.repeat || !plainKey(e)) return;
  const z = keyedZoomable();
  if (!z) return;
  e.preventDefault();
  z.toggle();
  z.keyed();
});

/**
 * Zooms the element `screen` holds; `player` keeps its place (and its height while it is zoomed),
 * `backdrop` greys the page behind it. `box`: where it stands zoomed in a window `w`×`h`;
 * `playing`: whether it plays, for which one Z takes.
 */
export function useZoom<T extends HTMLElement = HTMLDivElement>(o: { box: (w: number, h: number) => Box; playing: () => boolean }) {
  const player = useRef<HTMLDivElement>(null);
  const screen = useRef<T>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ from: Box; to: Box; closing?: boolean } | null>(null);
  const [keyKnown, knowKey] = useKnown(ZOOM_KEY_KNOWN);
  const boxRef = useRef(box);
  boxRef.current = box;
  const opts = useRef(o);
  opts.current = o;
  const toggle = () => {
    const cur = boxRef.current;
    const el = screen.current;
    if (!el || cur?.closing) return;
    if (!cur) {
      const from = el.getBoundingClientRect();
      setBox({ from: { left: from.left, top: from.top, width: from.width, height: from.height }, to: opts.current.box(innerWidth, innerHeight) });
      return;
    }
    // back into its place, wherever that is by now
    const r = player.current!.getBoundingClientRect();
    const back = { left: r.left, top: r.top, width: r.width, height: cur.from.height * (r.width / cur.from.width) };
    setBox({ ...cur, closing: true });
    el.animate([{ transform: 'none' }, { transform: onto(back, cur.to) }], { duration: ZOOM_MS, easing: ZOOM_EASE, fill: 'forwards' }).onfinish = () => setBox(null);
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const z: Zoomable = {
      el: () => screen.current,
      zoomed: () => !!boxRef.current && !boxRef.current.closing,
      playing: () => opts.current.playing(),
      toggle: () => toggleRef.current(),
      keyed: knowKey,
    };
    zoomables.add(z);
    return () => void zoomables.delete(z);
  }, []);
  // grows out of where it stood; back in its place, it lets go of the shrinking's last frame only
  // once it no longer stands zoomed, so the large one does not show for a frame in between
  const zoomed = !!box;
  useLayoutEffect(() => {
    const cur = boxRef.current;
    if (!screen.current) return;
    if (!cur) return screen.current.getAnimations().forEach((a) => a.cancel());
    screen.current.animate([{ transform: onto(cur.from, cur.to) }, { transform: 'none' }], { duration: ZOOM_MS, easing: ZOOM_EASE });
  }, [zoomed]);
  /** Where the zoomed one stands anew, once the window or what stands in it (a caption) changed. */
  const refit = () => {
    const cur = boxRef.current;
    if (cur && !cur.closing) setBox({ ...cur, to: opts.current.box(innerWidth, innerHeight) });
  };
  const refitRef = useRef(refit);
  refitRef.current = refit;
  // a resized window resizes the zoomed one; a wheel over it does not scroll what is behind
  useEffect(() => {
    if (!zoomed) return;
    const resize = () => refitRef.current();
    const still = (e: Event) => e.preventDefault();
    const els = [screen.current, backdrop.current];
    addEventListener('resize', resize);
    els.forEach((el) => el?.addEventListener('wheel', still, { passive: false }));
    return () => {
      removeEventListener('resize', resize);
      els.forEach((el) => el?.removeEventListener('wheel', still));
    };
  }, [zoomed]);
  return { player, screen, backdrop, box, toggle, refit, keyKnown };
}
