// The navigation at the bar's left: the canvas's name, and under it the canvases with what waits
// for the owner on each ("Needs you", the phone's list), then what runs on them (the phone's
// "Running"), in one place. It opens as a list under its button, or stays pinned as a sidebar docked
// on the left, the canvas the rest. An entry opens its card, on this canvas or on its own; a canvas's
// section folds away under its head, which keeps its count of what waits, and "Running" as a whole.

import { type ReactNode, useRef, useState } from 'react';
import type { CanvasInfo, Item, RunningCard, Waiting } from '../core/types';
import { canvasPath } from './address';
import { FoldArrow, toggleFolded, useFolded } from './fold';
import { forYouCount, forYouOf, ForYouRows, forYouTotal, when } from './forYou';
import { Inline } from './markdown';
import { ClockMark } from './snooze';
import { CanvasAgents } from './parts';
import { useMenuClose } from './queue';
import { stateLabel, t } from './strings';

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
  /** What waits and what runs on each canvas, this one's as this page sees it. */
  waiting: Record<string, Waiting>;
  underway: (id: string) => boolean;
  /** The card open on this canvas: its entry is marked. */
  open?: string;
  pinned: boolean;
  /** Pinning is offered: the window has room for the sidebar. */
  pinnable: boolean;
  onPin: (on: boolean) => void;
  onOpen: (canvas: string, i: Pick<Item, 'id' | 'short'>) => void;
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
      <NavList {...p} titlebar={titlebar} />
    </aside>
  );
}

/**
 * "Needs you" and the canvases, then "Running": with several canvases, each canvas in the
 * configuration's order heads what waits on it, so a click on it switches there, and its arrow folds
 * it; within a canvas in Tab's order. Under all of that, what runs, canvas by canvas as well (those
 * with nothing at work left out), which folds away as a whole: however much runs, it never pushes
 * down what waits. The head counts what waits on every canvas, each canvas's head what waits on it,
 * as the bar's button does: what runs waits for nobody.
 */
function NavList({ canvas, canvases, waiting, underway, open, pinned, pinnable, onPin, onOpen, onObeya, titlebar }: ListProps & { titlebar?: boolean }) {
  // with one canvas, its name heads the list only where the bar's button with the name is not there
  const several = canvases.length > 1 || pinned;
  const n = forYouTotal(canvases, waiting, underway);
  const fold = useFolded(FOLD_KEY);
  const none: Waiting = { items: [], talk: [] };
  const openOn = (c: CanvasInfo) => (c.id === canvas.id ? open : undefined);
  const waitRows = (c: CanvasInfo) => <ForYouRows light waiting={waiting[c.id] ?? none} canvas={c.id} underway={underway} open={openOn(c)} onOpen={(i) => onOpen(c.id, i)} onObeya={onObeya} />;
  const runningOf = (c: CanvasInfo) => waiting[c.id]?.running ?? [];
  const runRows = (c: CanvasInfo) => <RunningRows cards={runningOf(c)} open={openOn(c)} onOpen={(i) => onOpen(c.id, i)} />;
  // a canvas whose agents can be paused or resumed stands under "Running" even before its cards say they run
  const runs = (several ? canvases : [canvas]).filter((c) => runningOf(c).length || (several && c.agents));
  const running = runs.reduce((k, c) => k + runningOf(c).length, 0);
  const runShut = fold.includes(RUNNING_ALL);
  return (
    <>
      <div className="nav-head" {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>
        <h2 {...(titlebar ? { 'data-tauri-drag-region': '' } : {})}>{t.phone.forYou}</h2>
        {n > 0 && (
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
          const listed = forYouOf(waiting[c.id] ?? none, underway);
          return (
            <CanvasSection key={c.id} c={c} on={c.id === canvas.id} fold={c.id} shut={fold.includes(c.id)} has={listed.cards.length > 0 || !!listed.obeya} count={forYouCount(waiting[c.id] ?? none, underway)}>
              {waitRows(c)}
            </CanvasSection>
          );
        })
      ) : (
        <ul className="fy-rows">{waitRows(canvas)}</ul>
      )}
      {runs.length > 0 && (
        <section className={runShut ? 'nav-running folded' : 'nav-running'}>
          <h3>
            <button type="button" aria-expanded={!runShut} aria-controls="nav-running" title={runShut ? t.nav.unfold : t.nav.fold} onClick={() => toggleFolded(FOLD_KEY, RUNNING_ALL)}>
              <FoldArrow />
              {t.phone.running}
              {running > 0 && <span title={t.nav.running(running)}>{running}</span>}
            </button>
          </h3>
          {!runShut && (
            <div id="nav-running">
              {several
                ? runs.map((c) => {
                    const id = `${RUNNING}:${c.id}`;
                    return (
                      <CanvasSection key={c.id} c={c} on={c.id === canvas.id} fold={id} shut={fold.includes(id)} has={runningOf(c).length > 0} agents>
                        {runRows(c)}
                      </CanvasSection>
                    );
                  })
                : <ul className="fy-rows">{runRows(canvas)}</ul>}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** The prefix of each canvas's fold under "Running"; the key of the fold of "Running" as a whole, which no canvas's id is. */
const RUNNING = 'running';
const RUNNING_ALL = ':running';

/**
 * A canvas's section in the list: its shaded head, which switches there, counts what waits on it
 * (`count`) or carries its agents' pause (`agents`, under "Running", right above them), and folds
 * its rows away under the arrow, by `fold`.
 */
function CanvasSection({ c, on, fold, shut, has, count = 0, agents, children }: { c: CanvasInfo; on: boolean; fold: string; shut: boolean; has: boolean; count?: number; agents?: boolean; children: ReactNode }) {
  const rows = `nav-${fold.replace(':', '-')}`;
  return (
    <section className={['nav-canvas', on && 'on', shut && 'folded'].filter(Boolean).join(' ')}>
      <div className="nav-row">
        {has ? (
          <button type="button" className="nav-fold" aria-expanded={!shut} aria-controls={rows} aria-label={`${shut ? t.nav.unfold : t.nav.fold}: ${c.name}`} title={shut ? t.nav.unfold : t.nav.fold} onClick={() => toggleFolded(FOLD_KEY, fold)}>
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
        {agents && <CanvasAgents canvas={c} />}
      </div>
      {has && !shut && (
        <ul className="fy-rows" id={rows}>
          {children}
        </ul>
      )}
    </section>
  );
}

/** A canvas's running cards as light rows, each its title and its state line, since when it waits in the queue. */
function RunningRows({ cards, open, onOpen }: { cards: RunningCard[]; open?: string; onOpen: (i: RunningCard) => void }) {
  return (
    <>
      {cards.map((i) => (
        <li key={i.id}>
          <button className={i.id === open ? 'fy-row runs on' : 'fy-row runs'} aria-current={i.id === open || undefined} onClick={() => onOpen(i)}>
            <span className="fy-ttl">{i.title ? <Inline md={i.title} /> : t.titlePlaceholder}</span>
            <span className="fy-state">
              {i.snoozed && <ClockMark />}
              {stateLabel(i)}
              {i.queue && ` · ${t.phone.since(when(i.queue.since))}`}
            </span>
          </button>
        </li>
      ))}
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
