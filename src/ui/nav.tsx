// The navigation at the bar's left: the canvas's name, and under it the canvases with what waits
// for the owner on each ("Needs you", the phone's list), in one place. It opens as a list under its
// button, or stays pinned as a sidebar docked on the left, the canvas the rest. An entry opens its
// card, on this canvas or on its own; a canvas's section folds away under its head, which keeps its count.

import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasInfo, Item, Waiting } from '../core/types';
import { canvasPath } from './address';
import { api } from './api';
import { FoldArrow, toggleFolded, useFolded } from './fold';
import { forYouCount, forYouOf, ForYouRows, forYouTotal } from './forYou';
import { PauseMark, PlayMark } from './parts';
import { useMenuClose } from './menu';
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

// The canvases whose sections are folded, per browser as pinning is; shared by the list under the
// button and the sidebar, so that one folded in either stays folded in the other.
const FOLD_KEY = 'obeya-nav-folded';

/** The bar's button and the list under it. */
export function NavPill(p: ListProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(open, box, () => setOpen(false), true);
  const home = p.canvas.repos[0];
  const n = forYouTotal(p.canvases, p.waiting, p.underway);
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
        {n > 0 && <span className="waits">{n}</span>}
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
      <NavList {...p} docked titlebar={titlebar} />
    </aside>
  );
}

/**
 * "Needs you" and the canvases: with several, each canvas in the configuration's order heads what
 * waits on it, so a click on it switches there, and its arrow folds it; within a canvas in Tab's order.
 * Docked as the sidebar, its head counts what waits on every canvas, in the bar's button's stead; under
 * the button it leaves that to the button just above. Each canvas's head counts what waits on it.
 */
function NavList({ canvas, canvases, waiting, underway, open, pinned, pinnable, onPin, onOpen, onObeya, docked, titlebar }: ListProps & { docked?: boolean; titlebar?: boolean }) {
  // with one canvas, its name heads the list only where the bar's button with the name is not there
  const several = canvases.length > 1 || pinned;
  const n = forYouTotal(canvases, waiting, underway);
  const fold = useFolded(FOLD_KEY);
  const none: Waiting = { items: [], talk: [] };
  const rows = (c: CanvasInfo) => <ForYouRows light waiting={waiting[c.id] ?? none} canvas={c.id} underway={underway} open={c.id === canvas.id ? open : undefined} onOpen={(i) => onOpen(c.id, i)} onObeya={onObeya} />;
  return (
    <>
      <div className="nav-head" {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>
        <h2 {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>{t.phone.forYou}</h2>
        {docked && n > 0 && (
          <span className="waits" title={t.nav.waiting(n)}>
            {n}
          </span>
        )}
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
      {!n && <p className="ph-none">{t.phone.nothingWaits}</p>}
      {several ? (
        canvases.map((c) => {
          const w = waiting[c.id] ?? none;
          const listed = forYouOf(w, underway);
          const has = listed.cards.length > 0 || !!listed.obeya;
          const shut = fold.includes(c.id);
          const count = forYouCount(w, underway);
          return (
            <section key={c.id} className={['nav-canvas', c.id === canvas.id && 'on', shut && 'folded'].filter(Boolean).join(' ')}>
              <div className="nav-row">
                {has ? (
                  <button
                    type="button"
                    className="nav-fold"
                    aria-expanded={!shut}
                    aria-controls={`nav-${c.id}`}
                    aria-label={`${shut ? t.nav.unfold : t.nav.fold}: ${c.name}`}
                    title={shut ? t.nav.unfold : t.nav.fold}
                    onClick={() => toggleFolded(FOLD_KEY, c.id)}
                  >
                    <FoldArrow />
                  </button>
                ) : (
                  <span className="nav-fold" aria-hidden />
                )}
                <a href={canvasPath(c.id)}>
                  <CanvasIcon />
                  <b title={c.name}>{c.name}</b>
                  <span className="hint">{c.repos.map((r) => r.name).join(', ')}</span>
                  {count > 0 && (
                    <span className="waits" title={t.nav.waiting(count)}>
                      {count}
                    </span>
                  )}
                </a>
                <CanvasAgents canvas={c} />
              </div>
              {has && !shut && (
                <ul className="fy-rows" id={`nav-${c.id}`}>
                  {rows(c)}
                </ul>
              )}
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

/**
 * A canvas's agents on its row in the switcher (design: Pausing a canvas's agents): while one works
 * there, the moving line of a card at work, which turns into a pause for all of them while the
 * pointer is on the row; with none at work but some paused, a play that resumes them, on the same
 * hover. Where nothing hovers (touch), the button shows throughout.
 */
export function CanvasAgents({ canvas }: { canvas: CanvasInfo }) {
  const [asked, setAsked] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // a scroll moves the button from under the tip
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, [tip]);
  const a = canvas.agents;
  if (!a) return null;
  const pause = a.running > 0;
  const label = pause ? t.canvasPause.pause(a.running) : t.canvasPause.resume(a.paused);
  const click = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAsked(true);
    setTip(null);
    (pause ? api.pauseAgents(canvas.id) : api.resumeAgents(canvas.id)).catch(console.error).finally(() => setAsked(false));
  };
  const show = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.right + 10, y: r.top + r.height / 2 });
  };
  const hide = () => setTip(null);
  return (
    <span className={pause ? 'canvas-agents running' : 'canvas-agents'}>
      <button type="button" className="agents-turn" aria-label={`${label}: ${canvas.name}`} disabled={asked} onClick={click} onPointerEnter={show} onPointerLeave={hide} onFocus={(e) => e.currentTarget.matches(':focus-visible') && show(e)} onBlur={hide}>
        {pause ? <PauseMark /> : <PlayMark />}
      </button>
      {tip &&
        createPortal(
          <span className="agents-tip" style={{ left: tip.x, top: tip.y }}>
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
