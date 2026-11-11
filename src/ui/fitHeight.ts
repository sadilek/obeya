import { type RefObject, useLayoutEffect } from 'react';
import { useLatest } from './latest';

/** The scroll positions of the panes `el` stands in, as they are now: called, it puts them back. */
export function keepScroll(el: Element) {
  const scrolled: [Element, number][] = [];
  for (let e = el.parentElement; e; e = e.parentElement) if (e.scrollTop) scrolled.push([e, e.scrollTop]);
  return () => {
    for (const [e, top] of scrolled) e.scrollTop = top;
  };
}

/**
 * The height (border included) that holds a text box's text, or its placeholder, at its width as it
 * stands. Measuring shrinks the box for a moment, which shortens what scrolls around it: WebKit then
 * scrolls a pane standing at its end up, and a space typed by script (Space held to talk) brings no
 * caret back into view, so the box gets its height back and the panes their scroll positions.
 */
export function textHeight(el: HTMLTextAreaElement) {
  const restore = keepScroll(el);
  const height = el.style.height;
  el.style.height = 'auto';
  const h = el.scrollHeight + el.offsetHeight - el.clientHeight;
  el.style.height = height;
  restore();
  return h;
}

/**
 * Sets a text box's height. Below its CSS max-height it does not scroll: `scrollHeight` is rounded,
 * and the fraction of a pixel it left over showed the box's scrollbar beside a text that fit.
 */
export function setHeight(el: HTMLTextAreaElement, h: number) {
  el.style.height = `${h}px`;
  el.style.overflowY = h < parseFloat(getComputedStyle(el).maxHeight) ? 'hidden' : '';
}

/**
 * Keeps a text box as tall as its text (within its CSS min- and max-height), on every change and
 * when its width changes. A card's content renders before its panel shows: a hidden box has no
 * height to measure and keeps its one line until it shows. `fit` replaces the plain fitting (the
 * composer's lays out its buttons too).
 */
export function useFitHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  on = true,
  fit: (el: HTMLTextAreaElement) => void = (el) => setHeight(el, textHeight(el)),
) {
  const fitting = useLatest(fit);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const refit = () => {
      if (el.clientWidth) fitting.current(el);
    };
    refit();
    // the panel unfolds from the card's width, and a narrower box needs more lines
    let width = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // in the next frame: changing the height inside the callback makes it a resize loop
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [text, on]);
}
