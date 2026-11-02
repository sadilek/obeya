// The navigation at the bar's left: the canvas's name, and under it the canvases with what waits
// for the owner on each („Braucht dich“, the phone's list), in one place. It opens as a list under its
// button, or stays pinned as a sidebar docked on the left, the canvas the rest. An entry opens its
// card, on this canvas or on its own.

import { useRef, useState } from 'react';
import { type CanvasInfo, type Item, type Waiting, waitingOn } from '../core/types';
import { canvasPath } from './address';
import { forYouOf, ForYouRows } from './forYou';
import { CanvasAgents } from './parts';
import { useMenuClose } from './queue';
import { t } from './strings';

/** How wide the navigation is, pinned as a sidebar. */
export const NAV_W = 340;
/** The least room the canvas keeps beside the pinned navigation and a sheet on the right; with less, it folds back into its button. */
export const NAV_CANVAS_MIN = 480;
const PIN_KEY = 'obeya-nav-pinned';

export const loadPinned = () => {
  try {
    return localStorage.getItem(PIN_KEY) === '1';
  } catch {
    return false;
  }
};
export const savePinned = (on: boolean) => {
  try {
    if (on) localStorage.setItem(PIN_KEY, '1');
    else localStorage.removeItem(PIN_KEY);
  } catch {}
};

interface ListProps {
  canvas: CanvasInfo;
  canvases: CanvasInfo[];
  /** What waits on each canvas, this one's as this page sees it. */
  waiting: Record<string, Waiting>;
  underway: (id: string) => boolean;
  /** The card open on this canvas: its entry is marked. */
  open?: string;
  pinned: boolean;
  /** Pinning is offered: the window has room for the sidebar. */
  pinnable: boolean;
  onPin: (on: boolean) => void;
  onOpen: (canvas: string, i: Item) => void;
  onObeya: (canvas: string) => void;
}

/** The count of all that waits for the owner, on every canvas. */
export const waitingCount = (canvases: CanvasInfo[], waiting: Record<string, Waiting>) => canvases.reduce((n, c) => n + (waiting[c.id] ? waitingOn(waiting[c.id]!) : 0), 0);

/** The bar's button and the list under it. */
export function NavPill(p: ListProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(open, box, () => setOpen(false), true);
  const home = p.canvas.repos[0];
  const n = waitingCount(p.canvases, p.waiting);
  // a click on an entry goes elsewhere: the list closes
  const close = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    setOpen(false);
    fn(...a);
  };
  return (
    <div className="nav-pill" ref={box}>
      <button className={open ? 'pill switch on' : 'pill switch'} title={n ? `${t.nav.button} · ${t.nav.waiting(n)}` : t.nav.button} aria-expanded={open} onClick={() => setOpen(!open)}>
        <CanvasIcon />
        <b>{p.canvas.name}</b>
        <span className="hint lbl">{p.canvas.repos.length > 1 ? t.repos(p.canvas.repos.length) : home?.branch}</span>
        <span className="hint">▾</span>
        {n > 0 && <span className={open ? 'waits' : 'waits pulse'}>{n}</span>}
      </button>
      {open && (
        <div className="nav-menu">
          <NavList {...p} onOpen={close(p.onOpen)} onObeya={close(p.onObeya)} onPin={close(p.onPin)} />
        </div>
      )}
    </div>
  );
}

/** The navigation pinned as a sidebar on the left, sliding in and out. */
export function NavSheet({ on, ...p }: ListProps & { on: boolean }) {
  // in the app on a Mac it reaches up to the window's top: the traffic lights sit in its head, which moves the window as the bar does
  const titlebar = window.obeyaApp?.platform === 'macos';
  return (
    <aside id="nav" className={['nav-sheet', on && 'on', titlebar && 'titlebar'].filter(Boolean).join(' ')} aria-hidden={!on}>
      <NavList {...p} titlebar={titlebar} />
    </aside>
  );
}

/**
 * „Braucht dich“ and the canvases: with several, each canvas in the configuration's order heads what
 * waits on it, so a click on it switches there; within a canvas in Tab's order.
 */
function NavList({ canvas, canvases, waiting, underway, open, pinned, pinnable, onPin, onOpen, onObeya, titlebar }: ListProps & { titlebar?: boolean }) {
  // with one canvas, its name heads the list only where the bar's button with the name is not there
  const several = canvases.length > 1 || pinned;
  const waits = waitingCount(canvases, waiting) > 0;
  const none: Waiting = { items: [], talk: [] };
  const rows = (c: CanvasInfo) => <ForYouRows light waiting={waiting[c.id] ?? none} canvas={c.id} underway={underway} open={c.id === canvas.id ? open : undefined} onOpen={(i) => onOpen(c.id, i)} onObeya={onObeya} />;
  return (
    <>
      <div className="nav-head" {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>
        <h2 {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>{t.phone.forYou}</h2>
        {(pinnable || pinned) && (
          <button className={pinned ? 'nav-pin on' : 'nav-pin'} title={pinned ? t.nav.unpin : t.nav.pin} aria-label={pinned ? t.nav.unpin : t.nav.pin} aria-pressed={pinned} onClick={() => onPin(!pinned)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="1.5" />
              <path d="M9 4v16" />
              {pinned && <path d="M4.5 5.5h3v13h-3z" fill="currentColor" stroke="none" />}
            </svg>
          </button>
        )}
      </div>
      {!waits && <p className="ph-none">{t.phone.nothingWaits}</p>}
      {several ? (
        canvases.map((c) => {
          const w = waiting[c.id] ?? none;
          const listed = forYouOf(w, underway);
          return (
            <section key={c.id} className={c.id === canvas.id ? 'nav-canvas on' : 'nav-canvas'}>
              <div className="nav-row">
                <a href={canvasPath(c.id)}>
                  <CanvasIcon />
                  <b>{c.name}</b>
                  <span className="hint">{c.repos.map((r) => r.name).join(', ')}</span>
                </a>
                <CanvasAgents canvas={c} />
              </div>
              {(listed.cards.length > 0 || listed.obeya) && <ul className="fy-rows">{rows(c)}</ul>}
            </section>
          );
        })
      ) : (
        <ul className="fy-rows">{rows(canvas)}</ul>
      )}
    </>
  );
}

function CanvasIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-6 3-10 6" />
    </svg>
  );
}
