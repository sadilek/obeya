// A menu or list over the page, opened by a button: closing it on a press beside it, and keeping it
// on the screen beside its button.

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * A list under a bar's button: while it is `on`, a press anywhere beside `box` (beside each of them,
 * for a menu in a portal apart from its button) closes it, and Esc does with `esc`.
 */
export function useMenuClose(on: boolean, box: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[], close: () => void, esc = false) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!on) return;
    const boxes = Array.isArray(box) ? box : [box];
    const away = (e: PointerEvent) => boxes.some((b) => b.current?.contains(e.target as Node)) || latest.current();
    const key = (e: KeyboardEvent) => esc && e.key === 'Escape' && latest.current();
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', key);
    };
  }, [on]);
}

/** Room kept between the menu and the edges of the screen. */
const EDGE = 8;

/** Puts the menu (fixed) below the button where it fits on the screen, else above it, else as low as fits, centred on the button. */
export function placeOnScreen(menu: HTMLElement, button: DOMRect) {
  const { width, height } = menu.getBoundingClientRect();
  const below = button.bottom + 6;
  const above = button.top - 6 - height;
  const top = below + height <= innerHeight - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, innerHeight - EDGE - height);
  const left = Math.min(Math.max(EDGE, button.left + button.width / 2 - width / 2), innerWidth - EDGE - width);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(EDGE, left)}px`;
}

/** Keeps the fixed menu `menu` on the screen beside what `anchor` measures while `on`, as the page scrolls and resizes and the menu grows. */
export function usePlaced(on: boolean, menu: RefObject<HTMLElement | null>, anchor: () => DOMRect) {
  useLayoutEffect(() => {
    if (!on) return;
    const place = () => menu.current && placeOnScreen(menu.current, anchor());
    place();
    // what the menu holds can change while it is open (the field to pick a date and time, a list that loads)
    const grown = new ResizeObserver(place);
    if (menu.current) grown.observe(menu.current);
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      grown.disconnect();
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  }, [on]);
}
