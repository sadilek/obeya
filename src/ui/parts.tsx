// Presentational pieces of the canvas. State and camera live in App.tsx.

import { memo, useEffect, useRef, useState } from 'react';
import { type Bounds, shapeOf } from '../core/layout';
import { type CanvasInfo, type Item, needsYou, type PendingRestart, type ProjectHistory } from '../core/types';
import { api } from './api';
import type { Cam } from './camera';
import { Doc, Inline, plain } from './markdown';
import { stateLabel, t } from './strings';

/** The first line of a card's text that says something (not a bare "Ziel" label, as briefs start). */
const firstLine = (md: string) =>
  plain(md)
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').replace(/^(Ziel|Goal)\s*:?\s*/i, '').trim())
    .find(Boolean) ?? '';

// ------------------------------------------------------------------ cards

interface CardProps {
  item: Item;
  /** On a canvas with several repositories, cards name theirs. */
  showRepo: boolean;
  b: Bounds;
  lifted: boolean;
  dragging: boolean;
  pop: boolean;
  els: Map<string, HTMLElement>;
  /** Starts a planned card, or one queued behind others despite the likely conflict. */
  onStart: (item: Item) => void;
  /** Takes a finished card off the canvas into the archive. */
  onArchive: (item: Item) => void;
}

const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const CardView = memo(
  function CardView({ item, b, lifted, dragging, pop, showRepo, els, onStart, onArchive }: CardProps) {
    const shape = shapeOf(item);
    // a card the Koordinator is checking or cutting has nothing to start yet
    const startable = item.state === 'planned' && (!item.queue || 'behind' in item.queue);
    // as "Archivieren" in the unfolded card: a finished card of the owner's whose agent is done
    const archivable = item.state === 'live' && item.source === 'manual' && !item.finishing && !item.archivedAt;
    const kind =
      item.label ??
      (item.parent ? t.kind.workstream : item.idea ? t.kind.idea : item.becomesProject ? t.kind.becomesProject : item.prototypeOf ? t.kind.prototype : t.kind[item.kind]);
    const status =
      item.state === 'working'
        ? item.statusLine
        : item.state === 'inPr' && item.pr
          ? t.pr.short(item.pr.number, item.pr.checks.filter((c) => c.state === 'failure').length, item.pr.conflict)
          : undefined;
    const meta =
      item.question?.text ??
      (item.idea?.yourTurn ? item.idea.questions[0]?.text : undefined) ??
      (item.queue && 'behind' in item.queue ? item.queue.reason : undefined) ??
      status ??
      (item.idea ? firstLine(item.idea.brief) || firstLine(item.body) : firstLine(item.body));
    const cls = [
      'item',
      'card',
      shape,
      `s-${item.state}`,
      item.idea && `idea-${item.idea.status}`,
      item.idea?.thinking && 'thinking',
      item.idea && needsYou(item) && 'your-turn',
      item.queue && 'queued', lifted && 'lifted', dragging && 'dragging', pop && 'pop'].filter(Boolean).join(' ');
    return (
      <div
        className={cls}
        data-id={item.id}
        ref={(el) => void (el ? els.set(item.id, el) : els.delete(item.id))}
        style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 2 }}
      >
        <div className="kind">
          <span>
            {item.state === 'proposal' ? t.proposalMark : ''}
            {showRepo ? `${item.repo} · ` : ''}
            {kind}
          </span>
        </div>
        <div className={item.title ? 'ttl' : 'ttl untitled'}>{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>
        {meta && <div className="meta">{meta}</div>}
        <div className="state">
          {stateLabel(item)}
          {item.buildProposal && ` · ${t.idea.proposesBuild}`}
        </div>
        {needsYou(item) && <div className="badge pulse">{item.state === 'proposal' ? '✦' : '!'}</div>}
        {startable && (
          <button
            className="play"
            title={item.queue ? t.queue.force : t.start}
            aria-label={item.queue ? t.queue.force : t.start}
            // the canvas would take the press as the start of a drag or a click that opens the card
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onStart(item);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
            </svg>
          </button>
        )}
        {archivable && (
          <button
            className="play archive"
            title={t.archive.archive}
            aria-label={t.archive.archive}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onArchive(item);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="5" rx="1" />
              <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
            </svg>
          </button>
        )}
      </div>
    );
  },
  (a, b) =>
    a.item === b.item && sameBounds(a.b, b.b) && a.lifted === b.lifted && a.dragging === b.dragging && a.pop === b.pop && a.showRepo === b.showRepo && a.onStart === b.onStart && a.onArchive === b.onArchive,
);

/**
 * The canvas's name and home branch; with several canvases, a switcher. Other canvases with cards
 * that need the owner carry their count in the menu, and while it is closed the pill carries the sum.
 */
export function CanvasPill({ canvas, canvases, waiting }: { canvas: CanvasInfo; canvases: CanvasInfo[]; waiting: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const home = canvas.repos[0];
  const many = canvases.length > 1;
  const elsewhere = canvases.reduce((n, c) => n + (c.id === canvas.id ? 0 : (waiting[c.id] ?? 0)), 0);
  return (
    <div className="canvas-pill">
      <button
        className={many ? 'pill switch' : 'pill'}
        title={many ? (elsewhere ? `${t.switchCanvas} · ${t.waitingElsewhere(elsewhere)}` : t.switchCanvas) : undefined}
        onClick={() => many && setOpen(!open)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="8" r="2.5" />
          <path d="M6 8.5v7M18 10.5c0 4-6 3-10 6" />
        </svg>
        <b>{canvas.name}</b>
        <span className="hint">{canvas.repos.length > 1 ? t.repos(canvas.repos.length) : home?.branch}</span>
        {many && <span className="hint">▾</span>}
        {!open && elsewhere > 0 && <span className="waits pulse">{elsewhere}</span>}
      </button>
      {open && (
        <ul className="canvas-menu">
          {canvases.map((c) => {
            const n = c.id === canvas.id ? 0 : (waiting[c.id] ?? 0);
            return (
              <li key={c.id} className={c.id === canvas.id ? 'on' : ''}>
                <a href={`?c=${encodeURIComponent(c.id)}`} title={n ? t.waitingThere(n) : undefined}>
                  <b>{c.name}</b>
                  <span className="hint">{c.repos.map((r) => r.name).join(', ')}</span>
                  {n > 0 && <span className="waits">{n}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A restart that waits for workers or the owner: for whom and until when (on hover), and a button that has it go ahead now. */
export function RestartPill({ restart, items }: { restart: PendingRestart; items: Item[] }) {
  const [going, setGoing] = useState(false);
  const n = restart.cards.length + restart.elsewhere;
  const until = new Date(restart.deadline).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const titles = restart.cards.map((id) => plain(items.find((i) => i.id === id)?.title ?? id));
  const owner = restart.owner;
  const now = () => {
    setGoing(true);
    api.restartNow().then(
      (r) => r.restarting || setGoing(false),
      () => setGoing(false),
    );
  };
  if (going)
    return (
      <div className="pill restart going" id="restart">
        <span className="spin">↻</span> {t.restart.going}
      </div>
    );
  return (
    <div className="pill restart" id="restart">
      <span className="spin">↻</span>
      <span>{t.restart.pill(n, owner)}</span>
      {/* the deadline does not cut the owner off */}
      {!owner.length && <span className="hint">{t.restart.until(until)}</span>}
      <button onClick={now}>
        {t.restart.now}
        <span className="tip risk" role="tooltip">
          {n ? t.restart.nowRisk : t.restart.nowOwner}
        </span>
      </button>
      <div className="tip why" role="tooltip">
        <p>{t.restart.reason[restart.reason]}</p>
        {owner.map((h) => (
          <p key={h}>{t.restart.owner[h]}</p>
        ))}
        {n > 0 && (
          <>
            <p>{t.restart.waits}</p>
            <ul>
              {titles.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
              {restart.elsewhere > 0 && <li className="hint">{t.restart.elsewhere(restart.elsewhere)}</li>}
            </ul>
          </>
        )}
        <p className="hint">{t.restart.kept}</p>
        {n > 0 && <p className="hint">{owner.length ? t.restart.deadlineOwner(until) : t.restart.deadline(until)}</p>}
      </div>
    </div>
  );
}

export const ProjectView = memo(
  function ProjectView({ item, b, kids, onStartAll }: { item: Item; b: Bounds; kids: Item[]; onStartAll: (project: Item, count: number) => void }) {
    const live = kids.filter((k) => k.state === 'live').length;
    const waiting = kids.filter(needsYou).length;
    const startable = kids.filter((k) => k.state === 'planned' && !k.queue).length;
    return (
      <div className={`item project s-${item.state}`} data-id={item.id} style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 0 }}>
        <div className="head">
          <span className="ttl">{plain(item.title)}</span>
          <span className="kind">{t.kind.project}</span>
          <span className="progress">{t.progress(live, kids.length)}</span>
          {startable > 0 && (
            <button
              className="start-all"
              title={`${t.plan.startAll(startable)}. ${t.plan.startAllHint}`}
              // the canvas would take the press as the start of a drag or a click that opens the project
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onStartAll(item, startable);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
              </svg>
              {t.plan.startAllShort(startable)}
            </button>
          )}
        </div>
        {waiting > 0 && <div className="badge">{waiting}</div>}
      </div>
    );
  },
  (a, b) => a.item === b.item && a.onStartAll === b.onStartAll && sameBounds(a.b, b.b) && a.kids.length === b.kids.length && a.kids.every((k, i) => k === b.kids[i]),
);

/** A dashed line from each proposal and each follow-up not yet started to the card it came from, and from each prototype to its idea. */
export function Links({ placed }: { placed: { item: Item; b: Bounds }[] }) {
  const byId = new Map(placed.map((p) => [p.item.id, p]));
  const paths = placed.flatMap(({ item, b }) => {
    const src = (item.state === 'proposal' || item.state === 'planned' || item.prototypeOf) && item.from ? byId.get(item.from) : undefined;
    if (!src) return [];
    const x1 = src.b.x + src.b.w / 2;
    const y1 = src.b.y + src.b.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const my = (y1 + y2) / 2;
    return [<path key={item.id} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />];
  });
  return (
    <svg id="links" width="1" height="1">
      {paths}
    </svg>
  );
}

// ------------------------------------------------------------------ plan sheet

/** A card a workstream waits for: a sibling by its label, any other by its title. */
function sibling(id: string, kids: Item[], all: Item[]): string {
  const k = kids.find((x) => x.id === id);
  return k?.label ?? plain((k ?? all.find((x) => x.id === id))?.title ?? '…');
}

/**
 * The open project: its goal and workstreams (as the doc last stood, for an archived one), the idea
 * it came from and the decisions taken in it; or, while `reading`, its plan doc as written, with the
 * workstream `reading.mark` (a label) in view.
 */
export function Sheet({
  project,
  kids,
  all,
  on,
  reading,
  onOpen,
  onRead,
  onStartAll,
  els,
  version,
}: {
  project?: Item;
  kids: Item[];
  /** Every card on the canvas, to name the cards a workstream waits for. */
  all: Item[];
  on: boolean;
  reading: { mark?: string } | null;
  onOpen: (i: Item) => void;
  /** Reads the plan doc (`{}`), or goes back to the workstreams (`null`). */
  onRead: (r: { mark?: string } | null) => void;
  /** Hands all planned workstreams to the Koordinator, which orders them. */
  onStartAll: (project: Item, count: number) => void;
  /** Where the cards opened from the sheet unfold from (an archived project's are not on the canvas). */
  els: Map<string, HTMLElement>;
  /** Changes when the canvas does, so the decisions are read again. */
  version: unknown;
}) {
  const [loaded, setLoaded] = useState<{ id: string; h: ProjectHistory } | null>(null);
  const id = project?.id;
  useEffect(() => {
    if (!id || !on) return;
    let current = true;
    api.history(id).then((h) => current && setLoaded({ id, h }), console.error);
    return () => void (current = false);
  }, [id, on, version]);
  // never another project's
  const history = loaded && loaded.id === id ? loaded.h : null;
  const ref = (key: string) => (el: HTMLElement | null) => void (el ? els.set(key, el) : els.delete(key));
  const [doc, setDoc] = useState<{ id: string; markdown: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // read again whenever the project changes, which includes an edit of its doc
  useEffect(() => {
    if (!reading || !project) return;
    let current = true;
    setFailed(false);
    api.planDoc(project.id).then(
      (d) => current && setDoc({ id: project.id, markdown: d.markdown }),
      () => current && setFailed(true),
    );
    return () => void (current = false);
  }, [!!reading, project]);
  const box = useRef<HTMLElement>(null);
  const markEl = useRef<HTMLElement | null>(null);
  const shown = reading && doc?.id === project?.id ? doc : null;
  const startable = kids.filter((k) => k.state === 'planned' && !k.queue).length;
  // the doc opens at its top, or at the workstream it was opened for
  useEffect(() => {
    if (!shown || !box.current) return;
    box.current.scrollTop = 0;
    if (!markEl.current) return;
    // the sheet widens first: the workstream is where it ends up once the text has settled
    const h = setTimeout(() => markEl.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 480);
    return () => clearTimeout(h);
  }, [shown?.id, reading, !!shown]);
  return (
    <aside
      id="sheet"
      ref={box}
      className={['sheet', on && 'on', reading && 'reading'].filter(Boolean).join(' ')}
    >
      {project?.plan && reading && (
        <>
          <div className="read-head">
            <button className="back" onClick={() => onRead(null)}>
              ‹ {t.plan.back}
            </button>
            <span className="src">{project.plan.file}</span>
          </div>
          {shown ? (
            <Doc md={shown.markdown} mark={reading.mark} markRef={(el) => void (markEl.current = el)} />
          ) : (
            <p className="hint">{failed ? t.plan.failed : t.plan.loading}</p>
          )}
        </>
      )}
      {project?.plan && !reading && (
        <>
          <div className="p-kind">{project.archivedAt ? t.archivedProject : t.planSheet}</div>
          <h2>{plain(project.title)}</h2>
          {project.archivedAt && <p className="hint">{t.archive.projectGone(new Date(project.archivedAt))}</p>}
          <div className="goal">
            <Inline md={project.plan.goal} />
          </div>
          <div className="src">{project.plan.file}</div>
          {!project.archivedAt && (
            <button className="btn read" onClick={() => onRead({})}>
              {t.plan.read}
            </button>
          )}
          {!project.archivedAt && startable > 0 && (
            <div className="start-all">
              <button className="btn primary" onClick={() => onStartAll(project, startable)}>
                {t.plan.startAll(startable)}
              </button>
              <p className="hint">{t.plan.startAllHint}</p>
            </div>
          )}
          {history?.origin && (
            <button className="origin" ref={ref(history.origin.id)} onClick={() => onOpen(history.origin!)}>
              <span className="hint">{t.fromIdea}</span>
              <span>{plain(history.origin.title.replace(/^Plan-Doc:\s*/, ''))}</span>
            </button>
          )}
          <ol>
            {kids.map((k) => (
              <li key={k.id} ref={ref(k.id)} className={`s-${k.state}`} onClick={() => onOpen(k)}>
                <span className="dot" />
                <span className="w">{k.label}</span>
                <span>
                  <Inline md={k.title} />
                  <br />
                  <span className="hint">
                    {k.queue && 'behind' in k.queue ? t.queue.behind(k.queue.behind.map((id) => sibling(id, kids, all))) : stateLabel(k)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <h4 className="p-h">{t.decisions}</h4>
          {history && history.decisions.length === 0 && <p className="hint">{t.noDecisions}</p>}
          {history && history.decisions.length > 0 && (
            <ul className="decisions">
              {history.decisions.map((d) => (
                <li key={d.id}>
                  <div className="q">{d.question}</div>
                  <div className="a">{d.answer}</div>
                  <div className="hint">
                    {t.decidedBy[d.by]} · {new Date(d.at).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ overlays

/** Chips at the screen edge pointing at off-screen cards that need the owner. */
export function Edges({ cam, targets, rightReserve, onOpen }: { cam: Cam; targets: { item: Item; b: Bounds }[]; rightReserve: number; onOpen: (i: Item) => void }) {
  const m = 30;
  const top = 64;
  const bottom = innerHeight - 60;
  const right = innerWidth - rightReserve - m;
  return (
    <div id="edges">
      {targets.map(({ item, b }) => {
        const cx = cam.x + (b.x + b.w / 2) * cam.s;
        const cy = cam.y + (b.y + b.h / 2) * cam.s;
        if (cx > m && cx < right && cy > top && cy < bottom) return null;
        const x = Math.min(right, Math.max(m, cx));
        const y = Math.min(bottom, Math.max(top + 10, cy));
        const ang = (Math.atan2(cy - y, cx - x) * 180) / Math.PI;
        // anchored on the side it points to, so it stays on screen
        const tx = cx >= right ? '-100%' : cx <= m ? '0%' : '-50%';
        const title = plain(item.title);
        return (
          <button key={item.id} className={`edge s-${item.state}`} style={{ left: x, top: y, transform: `translate(${tx}, -50%)` }} onClick={() => onOpen(item)}>
            <span className="arr" style={{ transform: `rotate(${ang}deg)` }}>
              ➜
            </span>
            {title.length > 30 ? title.slice(0, 28) + '…' : title}
          </button>
        );
      })}
    </div>
  );
}

export function Minimap({ cam, all, placed, onJump }: { cam: Cam; all: Bounds; placed: { item: Item; b: Bounds }[]; onJump: (wx: number, wy: number) => void }) {
  const W = 210;
  const H = 130;
  const pad = 10;
  const k = Math.min((W - 2 * pad) / all.w, (H - 2 * pad) / all.h);
  const ox = (W - all.w * k) / 2 - all.x * k;
  const oy = (H - all.h * k) / 2 - all.y * k;
  return (
    <div
      id="minimap"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump((e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k);
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`}>
        {placed.map(({ item, b }) => (
          <rect
            key={item.id}
            x={ox + b.x * k}
            y={oy + b.y * k}
            width={b.w * k}
            height={b.h * k}
            rx={item.kind === 'project' ? 4 : 1.5}
            style={{ fill: item.kind === 'project' ? 'var(--container-line)' : `var(--${item.state})` }}
            opacity={item.kind === 'project' || needsYou(item) ? 1 : 0.55}
          />
        ))}
        <rect
          x={ox + (-cam.x / cam.s) * k}
          y={oy + (-cam.y / cam.s) * k}
          width={(innerWidth / cam.s) * k}
          height={(innerHeight / cam.s) * k}
          fill="none"
          style={{ stroke: 'var(--ink)' }}
          strokeWidth={1.2}
          rx={3}
          opacity={0.5}
        />
      </svg>
    </div>
  );
}
