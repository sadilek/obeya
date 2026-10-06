// Presentational pieces of the canvas. State and camera live in App.tsx.

import { memo, useEffect, useRef, useState } from 'react';
import { type Bounds, shapeOf } from '../core/layout';
import { type CanvasInfo, type ClonePool, finished, type Item, needsYou, type PendingRestart, type ProjectHistory } from '../core/types';
import { api } from './api';
import type { Cam } from './camera';
import type { Shape } from './groups';
import { Doc, Inline, plain } from './markdown';
import { clock, shortDay, stateLabel, t } from './strings';

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
  /** A prototype of this idea is on the canvas, which keeps the idea from the archive. */
  prototyped: boolean;
  els: Map<string, HTMLElement>;
  /** Starts a planned card, or one queued behind others despite the likely conflict. */
  onStart: (item: Item) => void;
  /** Takes a finished card or a dropped idea off the canvas into the archive. */
  onArchive: (item: Item) => void;
  /** While the pointer is on a card with waits: this one is it, comes before it, or waits for it. */
  dep?: 'self' | 'before' | 'after';
  /** The pointer came onto the card (its id) or left it (null). */
  onHover: (id: string | null) => void;
}

const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const CardView = memo(
  function CardView({ item, b, lifted, dragging, pop, prototyped, showRepo, els, onStart, onArchive, dep, onHover }: CardProps) {
    const shape = shapeOf(item);
    // a card the Koordinator is checking or cutting has nothing to start yet
    const startable = item.state === 'planned' && (!item.queue || 'behind' in item.queue);
    // as "Archivieren" in the unfolded card: a finished card of the owner's whose agent is done, or
    // a dropped idea without a prototype on the canvas
    const archivable =
      !item.archivedAt &&
      ((finished(item.state) && item.source === 'manual' && !item.finishing) || (item.idea?.status === 'dropped' && !prototyped));
    const kind =
      item.label ??
      (item.parent ? t.kind.workstream : item.idea || item.proposal?.idea ? t.kind.idea : item.becomesProject ? t.kind.becomesProject : item.prototypeOf ? t.kind.prototype : item.kind === 'project' ? t.kind.project : '');
    // a plain task says nothing of its kind: that it is one shows
    const label = [item.state === 'proposal' && t.proposalMark, showRepo && item.repo, kind].filter(Boolean).join(' · ');
    // a card whose agent finishes after the landing shows its line like one at work: the usage limit it waits on, its reports
    const status =
      item.state === 'working' || item.finishing
        ? item.statusLine
        : item.state === 'inPr' && item.pr
          ? t.pr.short(item.pr.number, item.pr.checks.filter((c) => c.state === 'failure').length, item.pr.conflict, item.pr.ready, item.pr.held?.score)
          : undefined;
    const meta =
      item.question?.text ??
      (item.idea?.yourTurn ? item.idea.questions[0]?.text : undefined) ??
      (item.queue && 'behind' in item.queue ? item.queue.reason : undefined) ??
      (item.queue && 'workspace' in item.queue ? t.queue.workspaceWhy[item.queue.workspace] : undefined) ??
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
      item.queue && 'queued', dep && `dep-${dep}`, lifted && 'lifted', dragging && 'dragging', pop && 'pop'].filter(Boolean).join(' ');
    return (
      <div
        className={cls}
        data-id={item.id}
        ref={(el) => void (el ? els.set(item.id, el) : els.delete(item.id))}
        style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 2 }}
        onPointerEnter={() => onHover(item.id)}
        onPointerLeave={() => onHover(null)}
      >
        {(dep === 'before' || dep === 'after') && <div className="dep-tag">{t.deps[dep]}</div>}
        {label && (
          <div className="kind">
            <span>{label}</span>
          </div>
        )}
        <div className={item.title ? 'ttl' : 'ttl untitled'}>{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>
        {meta && <div className="meta">{meta}</div>}
        <div className="state">
          {stateLabel(item)}
          {item.buildProposal && ` · ${t.idea.proposesBuild}`}
          {item.idea?.buildAfterReply && ` · ${t.idea.buildsAfterReply}`}
          {item.idea?.next && needsYou(item) && ` · ${t.idea.suggests[item.idea.next.step]}`}
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
    a.item === b.item && sameBounds(a.b, b.b) && a.lifted === b.lifted && a.dragging === b.dragging && a.pop === b.pop && a.prototyped === b.prototyped && a.showRepo === b.showRepo && a.onStart === b.onStart && a.onArchive === b.onArchive && a.dep === b.dep && a.onHover === b.onHover,
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
  const until = clock(restart.deadline);
  const titles = restart.cards.map((id) => plain(items.find((i) => i.id === id)?.title ?? id));
  const owner = restart.owner;
  const stop = restart.reason === 'stop';
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
        <span className="spin">↻</span> {stop ? t.restart.goingStop : t.restart.going}
      </div>
    );
  return (
    <div className="pill restart" id="restart">
      <span className="spin">↻</span>
      <span>{t.restart.pill(n, owner, stop)}</span>
      {/* the deadline does not cut the owner off */}
      {!owner.length && <span className="hint">{t.restart.until(until)}</span>}
      <button onClick={now}>
        {stop ? t.restart.nowStop : t.restart.now}
        <span className="tip risk" role="tooltip">
          {stop ? t.restart.nowRiskStop : n ? t.restart.nowRisk : t.restart.nowOwner}
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
        <p className="hint">{stop ? t.restart.keptStop : t.restart.kept}</p>
        {n > 0 && <p className="hint">{stop ? t.restart.deadlineStop(until) : owner.length ? t.restart.deadlineOwner(until) : t.restart.deadline(until)}</p>}
      </div>
    </div>
  );
}

/** How many clones each repository's pool has taken and whether one is free; over it, the cards that hold them. */
export function WorkspacesPill({ pools, canvas, items }: { pools: ClonePool[]; canvas: CanvasInfo; items: Item[] }) {
  const several = pools.length > 1;
  const name = (repo: string) => canvas.repos.find((r) => r.id === repo)?.name ?? repo;
  const waiting = items.filter((i) => i.queue && 'workspace' in i.queue).length;
  const full = pools.every((p) => p.cards.length >= p.total);
  return (
    <div className={full ? 'pill workspaces full' : 'pill workspaces'} id="workspaces">
      <span>{t.workspaces.label}</span>
      {pools.map((p) => (
        <span key={p.repo} className="pool">
          {several && <span className="hint">{name(p.repo)}</span>}
          <span className="slots" aria-hidden>
            {Array.from({ length: p.total }, (_, i) => (
              <i key={i} className={i < p.cards.length ? 'on' : undefined} />
            ))}
          </span>
          <b>{t.workspaces.free(p.total - p.cards.length, p.total)}</b>
        </span>
      ))}
      <div className="tip" role="tooltip">
        {pools.map((p) => (
          <div key={p.repo}>
            <p>{t.workspaces.taken(p.cards.length, p.total, several ? name(p.repo) : null)}</p>
            {p.cards.length > 0 && (
              <ul>
                {p.cards.map((id) => {
                  const item = items.find((i) => i.id === id);
                  return <li key={id}>{item ? plain(item.title) : <span className="hint">{t.workspaces.offCanvas}</span>}</li>;
                })}
              </ul>
            )}
          </div>
        ))}
        {waiting > 0 && <p>{t.workspaces.waiting(waiting)}</p>}
      </div>
    </div>
  );
}

export const ProjectView = memo(
  function ProjectView({ item, b, kids, onStartAll }: { item: Item; b: Bounds; kids: Item[]; onStartAll: (project: Item, count: number) => void }) {
    const live = kids.filter((k) => finished(k.state)).length;
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

/**
 * A curve between the facing sides of two cards: left and right when they stand more beside each
 * other than above each other, else bottom and top.
 */
export function linkPath(a: Bounds, b: Bounds): string {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX > gapY) {
    const right = b.x + b.w / 2 > a.x + a.w / 2;
    const x1 = right ? a.x + a.w : a.x;
    const x2 = right ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const down = b.y + b.h / 2 > a.y + a.h / 2;
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y : b.y + b.h;
  const my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}

/**
 * A dashed line from each proposal and each follow-up not yet started to the card it came from, and
 * from each prototype to its idea, or to the project that took the idea's place.
 */
export function Links({ placed }: { placed: { item: Item; b: Bounds }[] }) {
  const byId = new Map(placed.map((p) => [p.item.id, p]));
  const projectOf = new Map(placed.flatMap((p) => (p.item.kind === 'project' && p.item.origin ? [[p.item.origin, p]] : [])));
  const paths = placed.flatMap(({ item, b }) => {
    const src =
      (item.state === 'proposal' || item.state === 'planned' || item.prototypeOf) && item.from ? (byId.get(item.from) ?? (item.prototypeOf ? projectOf.get(item.prototypeOf) : undefined)) : undefined;
    if (!src) return [];
    return [<path key={item.id} d={linkPath(src.b, b)} />];
  });
  return (
    <svg id="links" width="1" height="1">
      {paths}
    </svg>
  );
}

/** While the pointer is on a card with waits: a line for each wait, from the card waited for to the card waiting. */
export function DepLinks({ placed, edges }: { placed: { item: Item; b: Bounds }[]; edges: [string, string][] }) {
  const byId = new Map(placed.map((p) => [p.item.id, p.b]));
  return (
    <svg id="deps" width="1" height="1">
      <defs>
        <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" />
        </marker>
      </defs>
      {edges.flatMap(([from, to]) => {
        const a = byId.get(from);
        const b = byId.get(to);
        return a && b ? [<path key={`${from} ${to}`} d={linkPath(a, b)} markerEnd="url(#dep-arrow)" />] : [];
      })}
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
                    {t.decidedBy[d.by]} · {shortDay(d.at)}
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

export function Minimap({
  cam,
  all,
  placed,
  territories,
  onJump,
}: {
  cam: Cam;
  all: Bounds;
  placed: { item: Item; b: Bounds }[];
  territories: Shape[];
  onJump: (wx: number, wy: number) => void;
}) {
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
        <g transform={`translate(${ox} ${oy}) scale(${k})`}>
          {territories.map(({ g, t: x }) => (
            <path key={g.id} className="mterr" d={x.main} fillRule="evenodd" style={{ '--h': g.hue } as React.CSSProperties} />
          ))}
        </g>
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
