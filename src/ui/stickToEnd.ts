import { type RefObject, type UIEvent, useEffect, useRef } from 'react';

/**
 * Keeps a conversation's newest message in view, on a card and in the Koordinator's sheet alike.
 * While the box stands at its end it stays there as the conversation grows (a new message, an
 * agent's next step, a question, a comment's video frame loading, text wrapping anew once the font
 * is in) or as the box shrinks; scrolled up to read further back, the owner stays where they are.
 * A change of `said` (the owner said something) takes the box to its end. `content` is what the box
 * shows. `start`: the message the box opens at instead of its end, once its content is in, at its
 * top as far as the box scrolls; it stays there in the same way until the owner scrolls or says
 * something, and when it stood at the end, what is said after it is followed there.
 * Only the owner's own scrolling leaves the end: Safari's engine (the Mac app's) moves the box by
 * itself as a message is replaced, before the box is put back at the end, and a move like that, with
 * the content's height changed and no wheel, touch or key of the owner's in the box, is followed.
 * Returns the box's onScroll.
 */
export function useStickToEnd(box: RefObject<HTMLElement | null>, said: unknown, content: unknown, start?: (box: HTMLElement) => HTMLElement | null) {
  const atEnd = useRef(true);
  const seen = useRef<unknown>(undefined);
  const anchor = useRef<HTMLElement | null>(null);
  const started = useRef(false);
  // where the box was put last: the scroll event that follows is that move, not the owner's, also
  // when it arrives after the box shrank on (a panel coming up), which would read as scrolled up
  const put = useRef<number | null>(null);
  // the content's height when the box was put or scrolled last, and when the owner last turned the
  // wheel, touched or pressed a key in it
  const height = useRef(0);
  const touched = useRef(-Infinity);
  const place = (el: HTMLElement) => {
    if (anchor.current?.isConnected) {
      el.scrollTop += anchor.current.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    } else if (atEnd.current) el.scrollTop = el.scrollHeight;
    else return;
    put.current = el.scrollTop;
    height.current = el.scrollHeight;
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (said !== seen.current) {
      atEnd.current = true;
      anchor.current = null;
    } else if (anchor.current && atEnd.current) anchor.current = null;
    seen.current = said;
    if (content && !started.current) {
      started.current = true;
      anchor.current = start?.(el) ?? null;
    }
    place(el);
  }, [said, content, box.current]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const touch = () => void (touched.current = performance.now());
    const kinds = ['wheel', 'touchmove', 'keydown'] as const;
    for (const k of kinds) el.addEventListener(k, touch, { passive: true });
    return () => {
      for (const k of kinds) el.removeEventListener(k, touch);
    };
  }, [box.current]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const follow = () => place(el);
    const keep = new ResizeObserver(follow);
    keep.observe(el);
    for (const x of el.children) keep.observe(x);
    // the note under the comments held back, say
    const rows = new MutationObserver((changes) => {
      for (const c of changes) for (const x of c.addedNodes) if (x instanceof Element) keep.observe(x);
      follow();
    });
    rows.observe(el, { childList: true });
    return () => {
      keep.disconnect();
      rows.disconnect();
    };
  }, [content, box.current]);
  return (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (put.current !== null && Math.abs(el.scrollTop - put.current) < 2) return;
    // the content changed under the box, not the owner's hand
    const moved = el.scrollHeight !== height.current;
    height.current = el.scrollHeight;
    if (moved && (atEnd.current || anchor.current) && performance.now() - touched.current > 1000) return place(el);
    put.current = null;
    anchor.current = null;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };
}
