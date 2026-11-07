// What the phone lets the owner swipe aside, to either side: a line above the microphone, to be rid
// of it before it goes by itself (Obeya's reply, a confirmation, a command still being read), and a
// card in the phone's lists, to set it aside on the phone. Until the owner has swiped one of a kind
// away in this browser, it nudges aside and back once after it appears.

import { type ReactNode, useRef, useState } from 'react';

/** How far a finger moves before the line follows it sideways, or the move counts as one up or down. */
const SLOP = 8;
/** How long the line takes to fly out or spring back. */
const SETTLE_MS = 180;
/** In this browser the owner has swiped a line aside: the lines no longer nudge. */
const SWIPED = 'obeya.swipedAside';
/** The same for the phone's cards. */
export const SWIPED_CARD = 'obeya.swipedCard';

/**
 * Whether a line let go `dx` px aside (moving at `v` px/ms when let go) goes, `width` px wide:
 * pulled past a third of its width, or flicked the way it was pulled.
 */
export function goesAside(dx: number, v: number, width: number): boolean {
  if (Math.abs(dx) > width / 3) return true;
  return Math.abs(dx) > 24 && Math.abs(v) > 0.4 && Math.sign(v) === Math.sign(dx);
}

/** Whether the owner has swiped one aside in this browser of the kind kept under `key`. */
export function swipedOnce(key = SWIPED): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Which way a line or card went: to the right (1) or to the left (-1). */
export type Side = 1 | -1;

/**
 * A line above the microphone (or a card); with `on` (the phone) the owner swipes it aside and
 * `onGone` drops it. Without `on` it is a plain line. `learnt`: where this browser keeps that the
 * owner has swiped one of its kind, after which none nudges; with `nudge` false, this one never does.
 * `behind`: what a swipe to each side does, shown behind it as it moves that way; `flies`: whether
 * it flies out that way (by default it does), else it springs back before `onGone` (the swipe opens
 * something, a menu, rather than taking it away).
 */
export function Aside({
  on,
  onGone,
  id,
  className,
  learnt = SWIPED,
  nudge = true,
  behind,
  flies = () => true,
  children,
}: {
  on: boolean;
  onGone: (side: Side) => void;
  id?: string;
  className: string;
  learnt?: string;
  nudge?: boolean;
  behind?: Partial<Record<'right' | 'left', ReactNode>>;
  flies?: (side: Side) => boolean;
  children: ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const [held, setHeld] = useState(false);
  const press = useRef<{ id: number; x: number; y: number; dragging: boolean; last: { x: number; t: number }; v: number } | null>(null);
  const dragged = useRef(false);
  if (!on) return <div id={id} className={className}>{children}</div>;

  function letGo(e: React.PointerEvent<HTMLDivElement>) {
    const p = press.current;
    press.current = null;
    if (!p?.dragging) return;
    const now = e.clientX - p.x;
    const width = e.currentTarget.offsetWidth;
    setSettling(true);
    // a finger that stood still before it lifted flicked nothing
    const v = e.timeStamp - p.last.t > 80 ? 0 : p.v;
    if (e.type === 'pointerup' && goesAside(now, v, width)) {
      try {
        localStorage.setItem(learnt, '1');
      } catch {}
      const side: Side = now > 0 ? 1 : -1;
      const out = flies(side);
      setDx(out ? side * window.innerWidth : 0);
      setTimeout(() => {
        onGone(side);
        setSettling(false);
        setDx(0);
        setHeld(false);
      }, SETTLE_MS);
    } else {
      setDx(0);
      setTimeout(() => {
        setSettling(false);
        setHeld(false);
      }, SETTLE_MS);
    }
  }

  const style = dx || settling
    ? { transform: `translateX(${dx}px)`, opacity: 1 - Math.min(1, Math.abs(dx) / (window.innerWidth * 0.8)), transition: settling ? `transform ${SETTLE_MS}ms ease-out, opacity ${SETTLE_MS}ms ease-out` : 'none' }
    : undefined;
  const moving = (
    <div
      id={id}
      className={`${className} aside${!held && nudge && !swipedOnce(learnt) ? ' nudge' : ''}`}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0 || settling) return;
        dragged.current = false;
        press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, last: { x: e.clientX, t: e.timeStamp }, v: 0 };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        const mx = e.clientX - p.x;
        const my = e.clientY - p.y;
        if (!p.dragging) {
          if (Math.abs(my) > SLOP && Math.abs(my) > Math.abs(mx)) return void (press.current = null);
          if (Math.abs(mx) <= SLOP) return;
          p.dragging = true;
          dragged.current = true;
          setHeld(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        const dt = e.timeStamp - p.last.t;
        if (dt > 0) p.v = (e.clientX - p.last.x) / dt;
        p.last = { x: e.clientX, t: e.timeStamp };
        setDx(mx);
      }}
      onPointerUp={letGo}
      onPointerCancel={letGo}
      // a line pulled aside and let go is no tap on its „Rückgängig“, a card no tap that opens it
      onClickCapture={(e) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </div>
  );
  if (!behind) return moving;
  // what the swipe does stands on the side the line uncovers
  const shown = dx > 0 ? behind.right : dx < 0 ? behind.left : undefined;
  return (
    <div className="aside-track">
      {shown && <div className={`aside-behind ${dx > 0 ? 'at-left' : 'at-right'}`}>{shown}</div>}
      {moving}
    </div>
  );
}
