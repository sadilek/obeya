// A project on the canvas (its frame, head and "…" menu) and its open sheet.

import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Bounds, dependencyOrder, shapeOf } from '../core/layout';
import type { Item, ProjectHistory } from '../core/types';
import { archiveRefusal, finished, needsYou } from '../core/card';
import { ProjectTalk } from './coordinator';
import { costLabel, ProjectSpent, useCostsShown } from './costs';
import { api } from './api';
import { Body, Doc, Inline, plain } from './markdown';
import { placeOnScreen, useMenuClose } from './menu';
import { waitedOn } from './queue';
import { CardNumber } from './cardNumber';
import { shortDay, stateLabel, t } from './strings';
import { ArchiveIcon, PlayIcon, sameBounds, shownState, TalkIcon } from './parts';

/** How many of a project's workstreams its button starts: those planned and in no queue. */
const startableIn = (kids: Item[]) => kids.filter((k) => k.state === 'planned' && !k.queue).length;

/** A project's workstreams can be arranged by what builds on what while it is not done: with two cards or more standing open in it, or while that runs. */
const arrangeable = (project: Item, kids: Item[]) => project.state !== 'done' && (!!project.arranging || kids.filter((k) => shapeOf(k) !== 'chip').length > 1);

/** The columns mark on the button that arranges a project's workstreams by what builds on what. */
const ColumnsIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="0.6" y="1" width="3.6" height="3" rx="0.5" />
    <rect x="0.6" y="7" width="3.6" height="3" rx="0.5" />
    <rect x="7.8" y="4" width="3.6" height="3" rx="0.5" />
    <path d="M4.2 2.5 L7.8 5.5 M4.2 8.5 L7.8 5.5" />
  </svg>
);

/** One of the buttons in a project's head: beside its title where they all fit, else in its "…" menu. */
interface HeadAct {
  key: string;
  icon: ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Whether a project's buttons fit beside its title (`roomy`): only where the title and what follows
 * it take one line and end short of where the buttons start. Measured after each render and whenever
 * the head or the buttons change size; the title's layout never depends on the answer, so it settles.
 */
function useHeadFit(hasActs: boolean) {
  const head = useRef<HTMLDivElement>(null);
  const ttl = useRef<HTMLSpanElement>(null);
  const meta = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [roomy, setRoomy] = useState(true);
  const [menu, setMenu] = useState(false);
  const fit = useRef(() => {});
  fit.current = () => {
    const [h, tl, m, r] = [head.current, ttl.current, meta.current, row.current];
    // a row not laid out has no size to compare
    if (!h || !tl || !m || !r || !r.offsetWidth) return;
    const zoom = h.getBoundingClientRect().width / h.offsetWidth || 1;
    const lines = tl.getClientRects();
    const after = m.getBoundingClientRect();
    const oneLine = lines.length === 1 && after.top < lines[0]!.bottom;
    const fits = oneLine && after.right + 10 * zoom <= r.getBoundingClientRect().left;
    setRoomy(fits);
    if (fits) setMenu(false);
  };
  useLayoutEffect(() => fit.current());
  useEffect(() => {
    const seen = new ResizeObserver(() => fit.current());
    for (const el of [head.current, row.current]) if (el) seen.observe(el);
    document.fonts?.ready.then(() => fit.current());
    return () => seen.disconnect();
  }, [hasActs]);
  return { head, ttl, meta, row, moreBtn, roomy, menu, setMenu };
}

/** A project's "…" menu: its buttons as entries, over the canvas; a press elsewhere, Escape or moving the view closes it. */
function HeadMenu({ acts, at, close }: { acts: HeadAct[]; at: React.RefObject<HTMLButtonElement | null>; close: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useMenuClose(true, [at, menu], close, true);
  useLayoutEffect(() => {
    if (menu.current && at.current) placeOnScreen(menu.current, at.current.getBoundingClientRect());
    addEventListener('wheel', close, { passive: true });
    return () => removeEventListener('wheel', close);
  }, []);
  // a portal passes its events up the tree it is written in: the canvas would take them as its own
  const own = (e: React.SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div className="snooze-menu project-menu" role="menu" ref={menu} onPointerDown={own} onClick={own}>
      {acts.map((a) => (
        <button
          key={a.key}
          className={`snooze-opt ${a.key}`}
          role="menuitem"
          disabled={a.disabled}
          title={a.title}
          onClick={() => {
            close();
            a.run();
          }}
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export const ProjectView = memo(
  function ProjectView({
    item,
    b,
    kids,
    replies,
    els,
    onStartAll,
    onArrange,
    onCollapse,
    onOpen,
    onArchive,
    lit,
  }: {
    item: Item;
    b: Bounds;
    kids: Item[];
    /** Answers of its project agent that wait unread. */
    replies: number;
    els: Map<string, HTMLElement>;
    onStartAll: (project: Item, count: number) => void;
    onArrange: (project: Item) => void;
    onCollapse: (project: Item, collapsed: boolean) => void;
    onOpen: (i: Item) => void;
    /** Takes the project, its work done, into the archive. */
    onArchive: (project: Item) => void;
    /** It, or a workstream it holds folded, has its row in the search under the pointer or picked. */
    lit?: boolean;
  }) {
    const live = kids.filter((k) => finished(k.state)).length;
    const waiting = kids.filter(needsYou).length;
    const startable = startableIn(kids);
    const collapsed = !!item.collapsed;
    // the canvas would take the press as the start of a drag or a click that opens the project
    const own = (e: React.PointerEvent) => e.stopPropagation();
    const acts: HeadAct[] = [];
    // collapsed, its workstreams are not on the canvas to arrange; its sheet still has the button
    if (!collapsed && arrangeable(item, kids))
      acts.push({ key: 'arrange', icon: <ColumnsIcon size={11} />, label: item.arranging ? t.plan.arranging : t.plan.arrange, title: `${t.plan.arrangeLong}. ${t.plan.arrangeHint}`, disabled: item.arranging, run: () => onArrange(item) });
    if (startable > 0)
      acts.push({ key: 'start-all', icon: <PlayIcon size={10} />, label: t.plan.startAllShort(startable), title: `${t.plan.startAll(startable)}. ${t.plan.startAllHint}`, run: () => onStartAll(item, startable) });
    if (!archiveRefusal(item)) acts.push({ key: 'archive', icon: <ArchiveIcon size={11} />, label: t.plan.archive, title: `${t.plan.archiveLong}. ${t.plan.archiveHint}`, run: () => onArchive(item) });
    const { head, ttl, meta, row, moreBtn, roomy, menu, setMenu } = useHeadFit(acts.length > 0);
    return (
      <div className={`item project s-${item.state}${collapsed ? ' collapsed' : ''}${lit ? ' lit' : ''}`} data-id={item.id} style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 0 }}>
        <div className={['head', acts.length > 0 && 'has-acts', roomy && 'roomy'].filter(Boolean).join(' ')} ref={head}>
          <button
            className="fold"
            title={collapsed ? t.plan.expand : t.plan.collapse}
            aria-label={collapsed ? t.plan.expand : t.plan.collapse}
            aria-expanded={!collapsed}
            onPointerDown={own}
            onClick={(e) => {
              e.stopPropagation();
              onCollapse(item, !collapsed);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d={collapsed ? 'M4 2l4 4-4 4' : 'M2 4l4 4 4-4'} />
            </svg>
          </button>
          {/* the title wraps where the project is narrow; what follows it flows after its last word */}
          <div className="name">
            <span className="ttl" ref={ttl}>
              {plain(item.title)}
            </span>{' '}
            <span className="meta" ref={meta}>
              <span className="kind">{t.kind.project}</span>
              <span className="progress">{t.progress(live, kids.length)}</span>
              <CardNumber n={item.number} className="head-no" />
            </span>
          </div>
          {acts.length > 0 && (
            <>
              {/* measured even while hidden: whether they fit beside the title decides between them and the menu */}
              <div className="acts" ref={row}>
                {acts.map((a) => (
                  <button
                    key={a.key}
                    className={`head-btn ${a.key}`}
                    disabled={a.disabled}
                    title={a.title}
                    onPointerDown={own}
                    onClick={(e) => {
                      e.stopPropagation();
                      a.run();
                    }}
                  >
                    {a.icon}
                    {a.label}
                  </button>
                ))}
              </div>
              <button
                className="more"
                ref={moreBtn}
                title={t.plan.more}
                aria-label={t.plan.more}
                aria-haspopup="menu"
                aria-expanded={menu}
                onPointerDown={own}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(!menu);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <circle cx="2.5" cy="7" r="1.3" />
                  <circle cx="7" cy="7" r="1.3" />
                  <circle cx="11.5" cy="7" r="1.3" />
                </svg>
              </button>
            </>
          )}
        </div>
        {/* a collapsed project's workstreams, a mark each in its state's colour: a click opens one, unfolding from its mark */}
        {collapsed && (
          <div className="marks">
            {kids.map((k) => (
              <button
                key={k.id}
                ref={(el) => void (el ? els.set(k.id, el) : els.delete(k.id))}
                className={needsYou(k) ? 'mark yours' : 'mark'}
                title={plain(k.title)}
                aria-label={plain(k.title)}
                style={{ background: `var(--${shownState(k)})` }}
                onPointerDown={own}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(k);
                }}
              />
            ))}
          </div>
        )}
        {(replies > 0 || waiting > 0) && (
          <div className="badges">
            {/* its project agent's answers: a speech bubble, unlike the count of workstreams that need the owner */}
            {replies > 0 && (
              <button
                className="badge replied pulse"
                title={t.plan.replied(replies)}
                aria-label={t.plan.replied(replies)}
                onPointerDown={own}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(item);
                }}
              >
                <TalkIcon />
                {replies > 1 && <span>{replies}</span>}
              </button>
            )}
            {waiting > 0 && <div className="badge">{waiting}</div>}
          </div>
        )}
        {menu && acts.length > 0 && <HeadMenu acts={acts} at={moreBtn} close={() => setMenu(false)} />}
      </div>
    );
  },
  (a, b) =>
    a.item === b.item &&
    a.lit === b.lit &&
    a.replies === b.replies &&
    a.onStartAll === b.onStartAll &&
    a.onArrange === b.onArrange &&
    a.onCollapse === b.onCollapse &&
    a.onOpen === b.onOpen &&
    a.onArchive === b.onArchive &&
    sameBounds(a.b, b.b) &&
    a.kids.length === b.kids.length &&
    a.kids.every((k, i) => k === b.kids[i]),
);

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
  onArrange,
  onArchive,
  onUnarchive,
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
  /** Hands all planned workstreams to the Coordinator, which orders them. */
  onStartAll: (project: Item, count: number) => void;
  /** Puts the workstreams in columns by what builds on what. */
  onArrange: (project: Item) => void;
  /** Takes the project, its work done, into the archive. */
  onArchive: (project: Item) => void;
  /** Puts the archived project, its work done, back on the canvas. */
  onUnarchive: (project: Item) => void;
  /** Where the cards opened from the sheet unfold from (an archived project's are not on the canvas). */
  els: Map<string, HTMLElement>;
  /** Changes when the canvas does, so the decisions are read again. */
  version: unknown;
}) {
  const [loaded, setLoaded] = useState<{ id: string; h: ProjectHistory; opening: number } | null>(null);
  const id = project?.id;
  // each time the sheet opens: the history loaded before stands until this opening's comes
  const [opening, setOpening] = useState({ n: 0, on });
  if (opening.on !== on) setOpening({ n: on ? opening.n + 1 : opening.n, on });
  useEffect(() => {
    if (!id || !on) return;
    let current = true;
    const n = opening.n;
    api.history(id).then((h) => current && setLoaded({ id, h, opening: n }), console.error);
    return () => void (current = false);
  }, [id, on, version]);
  // never another project's
  const history = loaded && loaded.id === id ? loaded.h : null;
  // its conversation counts as in view once this opening's is there: answers that waited for it are marked then
  const talkLoaded = !!history && loaded!.opening === opening.n;
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
  const startable = startableIn(kids);
  const costsShown = useCostsShown();
  // once Obeya has read what builds on what, the workstreams in the order they stand arranged in
  const inOrder = kids.some((k) => k.buildsOn) ? dependencyOrder(kids).map((id) => kids.find((k) => k.id === id)!) : kids;
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
          {project.archivedAt && <p className="hint">{(project.state === 'done' ? t.archive.projectDone : t.archive.projectGone)(new Date(project.archivedAt))}</p>}
          <div className="goal">
            <Inline md={project.plan.goal} />
          </div>
          <div className="src">{project.plan.file}</div>
          <ProjectSpent item={project} />
          {!project.archivedAt && (
            <button className="btn read" onClick={() => onRead({})}>
              {t.plan.read}
            </button>
          )}
          {project.state === 'done' && (
            <div className="archive">
              {project.archivedAt ? (
                <button className="btn" onClick={() => onUnarchive(project)}>
                  {t.archive.unarchive}
                </button>
              ) : (
                <>
                  <p>{t.plan.done}</p>
                  <button className="btn primary" onClick={() => onArchive(project)}>
                    <ArchiveIcon size={12} />
                    {t.plan.archiveLong}
                  </button>
                  <p className="hint">{t.plan.archiveHint}</p>
                </>
              )}
            </div>
          )}
          {!project.archivedAt && startable > 0 && (
            <div className="start-all">
              <button className="btn primary" onClick={() => onStartAll(project, startable)}>
                {t.plan.startAll(startable)}
              </button>
              <p className="hint">{t.plan.startAllHint}</p>
            </div>
          )}
          {!project.archivedAt && arrangeable(project, kids) && (
            <div className="arrange">
              <button className="btn" disabled={project.arranging} onClick={() => onArrange(project)}>
                <ColumnsIcon size={12} />
                {project.arranging ? t.plan.arranging : t.plan.arrangeLong}
              </button>
              <p className="hint">{t.plan.arrangeHint}</p>
            </div>
          )}
          {history?.origin && (
            <button className="origin" ref={ref(history.origin.id)} onClick={() => onOpen(history.origin!)}>
              <span className="hint">{t.fromIdea}</span>
              <span>{plain(history.origin.title.replace(/^Plan-Doc:\s*/, ''))}</span>
            </button>
          )}
          <ol>
            {inOrder.map((k) => (
              <li key={k.id} ref={ref(k.id)} className={`s-${k.state}`} onClick={() => onOpen(k)}>
                <span className="dot" />
                <span className="w">{k.label}</span>
                <span className="ws">
                  <span className="ws-title">
                    <Inline md={k.title} />
                  </span>
                  {k.body.trim() && (
                    <div className="ws-text">
                      <Body md={k.body} />
                    </div>
                  )}
                  <span className="hint">
                    {k.queue && 'behind' in k.queue
                      ? t.queue.behind(waitedOn(k.queue.behind, all, (id) => sibling(id, kids, all)))
                      : [stateLabel(k), !finished(k.state) && k.buildsOn?.length && t.plan.buildsOn(k.buildsOn.map((id) => sibling(id, kids, all))), costsShown && k.spent && costLabel(k.spent)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <ProjectTalk on={on && !reading && talkLoaded} project={project} talk={history?.talk ?? []} items={all} onOpen={onOpen} />
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
