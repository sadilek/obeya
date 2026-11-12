// A long list of which only the rows in view, and a margin around them, are on the page: the rest
// stand in as space of the height they had or will roughly have. The archive's list, which grows to
// thousands of cards.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';

/** How far beyond what is in view rows are on the page, so that scrolling shows no gap before they come. */
const MARGIN = 800;

/** Where each row of these heights begins, and after them where the last one ends. */
export function offsets(heights: number[]): number[] {
  const starts = [0];
  for (const h of heights) starts.push(starts.at(-1)! + h);
  return starts;
}

/** The rows, from the first to before the last, that reach into the stretch from `top` to `bottom`, by where each begins (`offsets`). */
export function visible(starts: number[], top: number, bottom: number): [number, number] {
  const n = starts.length - 1;
  // the first row that ends below `top`
  let lo = 0;
  for (let hi = n; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (starts[mid + 1]! > top) hi = mid;
    else lo = mid + 1;
  }
  // past the end: the last row
  lo = Math.max(0, Math.min(lo, n - 1));
  let end = lo;
  while (end < n && starts[end]! < bottom) end++;
  return [lo, Math.max(end, Math.min(lo + 1, n))];
}

/**
 * The rows of a list that are on the page, `from` up to `to`, with where each row begins (`starts`,
 * for the space above and below them). `scroller` goes on the box that scrolls, `list` on the list in
 * it, `rowRef(key)` and `data-k={key}` on each row on the page, `onScroll` on the scroller. A row
 * keeps its place in the view while rows above it change height; `keep`, the key of a row brought
 * into view once (a card that unfolds from it); a change of `top` (a new search) starts at the top;
 * `on`: the list shows, and opens with the height it has then.
 */
export function useWindowedRows<R>({ rows, keyOf, guess, keep, top, on }: { rows: R[]; keyOf: (r: R) => string; guess: (r: R) => number; keep: string | undefined; top: string; on: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The rows' heights once on the page, by key; they stay for the next opening. */
  const sizes = useRef(new Map<string, number>()).current;
  const rowEls = useRef(new Map<string, HTMLElement>()).current;
  const [, measured] = useReducer((n: number) => n + 1, 0);
  // the part of the list in view, from its top
  const [view, setView] = useState({ top: 0, height: innerHeight });
  const starts = offsets(rows.map((r) => sizes.get(keyOf(r)) ?? guess(r)));
  const [from, to] = visible(starts, view.top - MARGIN, view.top + view.height + MARGIN);
  /** The row at the top of the view and where it began, to keep it in its place in the view while rows above it change height. */
  const anchor = useRef<{ key: string; at: number } | null>(null);
  /** The card in `keep` whose row has been brought into view: the owner may scroll on from there. */
  const revealed = useRef<string | undefined>(undefined);
  // in fractions of a pixel: rounded heights add up to a list of another height than the rows on the page,
  // and a row going off the page then moves the others by a pixel, which moves the view, which brings it back
  const placeOf = (el: HTMLElement) => el.getBoundingClientRect().top - list.current!.getBoundingClientRect().top;
  const remember = (key: string, h: number) => h > 0 && Math.abs((sizes.get(key) ?? 0) - h) > 0.5 && !!sizes.set(key, h);
  const look = () => {
    const m = scroller.current;
    const l = list.current;
    if (!m || !l) return;
    const top = m.scrollTop - l.offsetTop;
    setView((v) => (v.top === top && v.height === m.clientHeight ? v : { top, height: m.clientHeight }));
    anchor.current = null;
    // at the very top, a card archived meanwhile shows above the rest
    const viewTop = m.getBoundingClientRect().top;
    if (m.scrollTop > 0) for (const r of rows.slice(from, to)) {
      const el = rowEls.get(keyOf(r));
      if (el && el.getBoundingClientRect().bottom > viewTop) {
        anchor.current = { key: keyOf(r), at: placeOf(el) };
        break;
      }
    }
  };
  // a row whose height changes later (the fonts come, the window narrows) is measured again
  const watch = useMemo(
    () =>
      new ResizeObserver((es) => {
        let changed = false;
        for (const e of es) if (remember((e.target as HTMLElement).dataset.k!, e.borderBoxSize[0]!.blockSize)) changed = true;
        if (changed) measured();
      }),
    [],
  );
  useEffect(() => () => watch.disconnect(), []);
  const row = (key: string) => (el: HTMLElement | null) => {
    const was = rowEls.get(key);
    if (was && was !== el) watch.unobserve(was);
    if (el) {
      rowEls.set(key, el);
      watch.observe(el);
    } else rowEls.delete(key);
  };
  // a new search starts at the top of what it found
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    anchor.current = null;
  }, [top]);
  // the list opens at its top, with the height it has now
  useLayoutEffect(() => void (on && look()), [on]);
  useLayoutEffect(() => {
    const m = scroller.current;
    if (!m) return;
    // the rows on the page as high as they are, and the row at the top where it was
    let changed = false;
    for (const r of rows.slice(from, to)) {
      const el = rowEls.get(keyOf(r));
      if (el && remember(keyOf(r), el.getBoundingClientRect().height)) changed = true;
    }
    const a = anchor.current && rowEls.get(anchor.current.key);
    const moved = a ? placeOf(a) - anchor.current!.at : 0;
    if (Math.abs(moved) >= 1) {
      m.scrollTop += moved;
      anchor.current!.at += moved;
    }
    if (changed) return measured();
    // the card that unfolds from its row, or is open, has it on the page and in view, once
    const el = keep && rowEls.get(keep);
    const k = keep && keep !== revealed.current ? rows.findIndex((r) => keyOf(r) === keep) : -1;
    if (el && el.offsetTop >= m.scrollTop && el.offsetTop + el.offsetHeight <= m.scrollTop + m.clientHeight) revealed.current = keep;
    else if (k >= 0) {
      m.scrollTop = list.current!.offsetTop + starts[k]! - m.clientHeight / 3;
      anchor.current = null;
    }
    if (!keep) revealed.current = undefined;
    look();
  });

  return { scroller, list, from, to, starts, rowRef: row, onScroll: look };
}
