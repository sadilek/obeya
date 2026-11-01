// Presentational pieces of the canvas. State and camera live in App.tsx.

import { memo, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Bounds, dependencyOrder, shapeOf } from '../core/layout';
import { clip } from '../core/text';
import { answering, type AppUpdate, type CanvasInfo, type BlockedClone, type ClonePool, finished, finishedArchivable, finishingUp, handedOver, type Item, needsYou, openQuestions, pausable, type PendingRestart, halted, type PoolHost, type ProjectHistory, type SourceUpdate, stoppedArchivable, titleFrom } from '../core/types';
import { ProjectTalk } from './koordinator';
import { api } from './api';
import type { Cam } from './camera';
import type { Shape } from './groups';
import { Doc, excerpt, Inline, plain } from './markdown';
import { Body } from './message';
import { useMenuClose, waitedOn } from './queue';
import { ClockMark, snoozeWho } from './snooze';
import { becomesLabel, clock, shortDay, snoozeWhen, stateLabel, t } from './strings';

/** The first line of a card's text that says something (not a bare "Ziel" label, as briefs start). */
const firstLine = (md: string) =>
  plain(md)
    .split('\n')
    .map((l) => l.replace(/^(Ziel|Goal)\s*:?\s*/i, '').trim())
    .find(Boolean) ?? '';

/** What of a workstream planned again has landed: its pull request, else its commit. */
/** The state whose colour an open card wears: a demo whose worker takes in the owner's answer is at work. */
/** The colour a card's state gives its unfolded sheet: a snoozed card's is pencil grey, as on the canvas. */
export const shownState = (i: Item) => (i.snoozed ? 'muted' : i.kind === 'question' ? 'question' : answering(i) ? 'working' : i.state);

export const landedRef = (l: NonNullable<Item['landedPart']>) => (l.pr ? `PR #${l.pr.number}` : (l.commit?.slice(0, 7) ?? ''));

/** The button for the conversation with Obeya (the canvas's top bar, the phone view's): a speech bubble. */
export function TalkIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" />
    </svg>
  );
}

// ------------------------------------------------------------------ cards

interface CardProps {
  item: Item;
  /** On a canvas with several repositories, cards name theirs. */
  showRepo: boolean;
  b: Bounds;
  lifted: boolean;
  dragging: boolean;
  pop: boolean;
  /** Its row in the search is under the pointer or picked: it lights up where it stands. */
  lit?: boolean;
  /** A prototype of this idea is on the canvas, which keeps the idea from the archive. */
  prototyped: boolean;
  els: Map<string, HTMLElement>;
  /** Starts a planned card, or one queued behind others despite the likely conflict. */
  onStart: (item: Item) => void;
  /** Takes a finished card or a parked or dropped idea off the canvas into the archive. */
  onArchive: (item: Item) => void;
  /** While the pointer is on a card with waits: this one is it, comes before it, or waits for it. */
  dep?: 'self' | 'before' | 'after';
  /** The pointer came onto the card (its id) or left it (null). */
  onHover: (id: string | null) => void;
  /** What the server is still doing with the card after the owner's click (pushing it onto main, say). */
  underway?: string;
}

/** A card's title as it shows: its own, else the start of its text. */
export const shownTitle = (i: Item) => (i.title ? <Inline md={i.title} /> : titleFrom(i.body) || t.titlePlaceholder);

/** The marks on the buttons that pause an agent and let it go on. */
export const PauseMark = () => (
  <svg className="btn-mark" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
    <rect x="2" y="1.5" width="2.6" height="9" rx=".6" fill="currentColor" />
    <rect x="7.4" y="1.5" width="2.6" height="9" rx=".6" fill="currentColor" />
  </svg>
);
export const PlayMark = () => (
  <svg className="btn-mark" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
    <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
  </svg>
);

/**
 * On a card on the canvas, the pause of its agent at work, at a safe point, or the resume of its
 * paused one (or of one about to pause, which then works on): where a card's play and archive
 * buttons stand, faint, while the pointer is on the card.
 */
function CardTurn({ item }: { item: Item }) {
  const paused = halted(item);
  if (!paused && !pausable(item)) return null;
  return (
    <button
      className={paused ? 'play turn resume' : 'play turn'}
      title={item.pausing ? t.pause.takeBackHint : paused ? t.pause.resumeHint : t.pause.safeHint}
      aria-label={paused ? t.pause.resume : t.pause.button}
      // the canvas would take the press as the start of a drag or a click that opens the card
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void api.act(item.id, paused ? { action: 'resume' } : { action: 'pause', safePoint: true }).catch(() => {});
      }}
    >
      {paused ? <PlayMark /> : <PauseMark />}
    </button>
  );
}

/** The play mark on the buttons that start a card or a project's workstreams. */
const PlayIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12">
    <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
  </svg>
);

/** How many of a project's workstreams its button starts: those planned and in no queue. */
const startableIn = (kids: Item[]) => kids.filter((k) => k.state === 'planned' && !k.queue).length;

/** A project is worth arranging by its dependencies with two cards or more standing open in it. */
const arrangeable = (kids: Item[]) => kids.filter((k) => shapeOf(k) !== 'chip').length > 1;

/** The columns mark on the button that arranges a project's workstreams by what builds on what. */
const ColumnsIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="0.6" y="1" width="3.6" height="3" rx="0.5" />
    <rect x="0.6" y="7" width="3.6" height="3" rx="0.5" />
    <rect x="7.8" y="4" width="3.6" height="3" rx="0.5" />
    <path d="M4.2 2.5 L7.8 5.5 M4.2 8.5 L7.8 5.5" />
  </svg>
);

const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** The classes that give a card its look: its state's colour, an idea's stock, the owner's turn, an agent at it. */
export const cardClass = (item: Item, underway?: string) =>
  [
    'card',
    `s-${item.state}`,
    item.idea && `idea-${item.idea.status}`,
    item.kind === 'question' && 'q-card',
    (item.idea?.thinking || item.proposal?.revising || item.thread?.thinking) && 'thinking',
    item.idea && needsYou(item) && 'your-turn',
    underway && 'underway',
    answering(item) && 'answering',
    finishingUp(item) && 'finishing',
    item.paused && 'paused',
    item.snoozed && 'snoozed',
    item.queue && 'queued',
  ]
    .filter(Boolean)
    .join(' ');

/**
 * What a card says on its face, on the canvas and in the phone view's lists alike: its kind (after
 * `where` it is, its repository or canvas), its title, a line of its text, its state line in its
 * state's colour (`since` after it) and the pin while it needs the owner. A `chip`, a delivered
 * workstream, shows only its title, after its label, so it still reads as its workstream.
 */
export function CardFace({ item, where, underway, since, chip }: { item: Item; where?: string; underway?: string; since?: string; chip?: boolean }) {
  const kind =
    item.label ??
    (item.contribution ? t.review.kind(item.contribution.number, item.contribution.author) : item.parent ? t.kind.workstream : item.kind === 'question' ? t.kind.question : item.idea || item.proposal?.idea ? t.kind.idea : item.becomesProject ? becomesLabel(item) : item.prototypeOf ? t.kind.prototype : item.kind === 'project' ? t.kind.project : '');
  // a plain task says nothing of its kind: that it is one shows
  const label = [item.state === 'proposal' && t.proposalMark, where, kind].filter(Boolean).join(' · ');
  // a card whose agent finishes after the landing, opens its PR or takes in the owner's words on its handover shows its line like one at work: the usage limit it waits on, its reports
  // a review card waiting for the contributor says so in its state; what its review found shows while it waits for the owner
  const results = item.contribution?.results && handedOver(item) && !answering(item) ? item.contribution.results : undefined;
  const findings = item.contribution?.findings ?? [];
  const open = findings.filter((f) => f.status === 'open');
  const status = results
    ? `${t.review.checks(results)} · ${t.review.findings(findings.length, open.length, open.filter((f) => f.security).length)}`
    : item.state === 'working' || item.finishing || answering(item) || (item.state === 'inPr' && (!item.pr || item.contribution))
      ? item.statusLine && excerpt(item.statusLine)
      : item.state === 'inPr' && item.pr
        ? t.pr.short(item.pr.number, item.pr.checks.filter((c) => c.state === 'failure').length, item.pr.conflict, item.pr.ready, item.pr.held?.score)
        : undefined;
  // a proposal being reworked says that in place of its state: the kind line above already calls it a proposal
  const revising = item.state === 'proposal' && item.proposal?.revising;
  const asked = openQuestions(item)[0]?.text;
  const meta =
    (item.repoDown ? t.repoDown.short : undefined) ??
    (item.snoozed ? snoozeWho(item.snoozed) : undefined) ??
    (item.superseded ? (item.superseded.by ? t.superseded.byShort(plain(item.superseded.title ?? '')) : t.superseded.withdrawnShort) : undefined) ??
    (item.limitedUntil ? t.limitedUntil(clock(item.limitedUntil)) : undefined) ??
    (item.kind === 'question' && item.thread ? t.question.count(item.thread.answers, item.thread.files) : undefined) ??
    (asked === undefined ? undefined : excerpt(asked)) ??
    (item.queue && 'behind' in item.queue ? excerpt(item.queue.reason) : undefined) ??
    (item.queue && 'workspace' in item.queue ? t.queue.workspaceWhy[item.queue.workspace] : undefined) ??
    (item.queue && 'paused' in item.queue ? t.queue.pausedWhy : undefined) ??
    status ??
    (item.idea ? firstLine(item.idea.brief) || firstLine(item.body) : firstLine(item.body));
  return (
    <>
      {label && (
        <div className="kind">
          <span>{label}</span>
        </div>
      )}
      <div className={item.title ? 'ttl' : 'ttl untitled'}>
        {chip && item.label && <span className="ws-no">{item.label}</span>}
        {shownTitle(item)}
      </div>
      {meta && <div className="meta">{meta}</div>}
      <div className="state">
        {item.snoozed && !underway && <ClockMark />}
        {/* one line on the card, cut short rather than running into the text above it */}
        <span className="state-text">
          {underway ?? (revising ? t.revisingShort : stateLabel(item))}
          {item.landedPart && <span className="landed-part">{t.landedPart.short} · {landedRef(item.landedPart)}</span>}
          {item.buildProposal && ` · ${t.idea.proposesBuild}`}
          {item.proposal?.acceptAfterRevision && ` · ${t.acceptsAfterRevision}`}
          {item.state === 'proposal' && item.proposal?.startAt && !item.proposal.idea && ` · ${t.startAt.short(snoozeWhen(item.proposal.startAt))}`}
          {item.idea?.buildAfterReply && ` · ${t.idea.buildsAfterReply}`}
          {item.idea?.next && needsYou(item) && ` · ${t.idea.suggests[item.idea.next.step]}`}
          {since && <span className="since"> · {since}</span>}
        </span>
      </div>
      {needsYou(item) && !underway && <div className="badge pulse">{item.state === 'proposal' ? '✦' : '!'}</div>}
    </>
  );
}

export const CardView = memo(
  function CardView({ item, b, lifted, dragging, pop, lit, prototyped, showRepo, els, onStart, onArchive, dep, onHover, underway }: CardProps) {
    const shape = shapeOf(item);
    // a card the Koordinator is checking has nothing to start yet
    const startable = item.state === 'planned' && (!item.queue || 'behind' in item.queue);
    // as "Archivieren" in the unfolded card: a finished card of the owner's whose agent is done, a
    // stopped task, or a parked or dropped idea without a prototype on the canvas
    const archivable =
      !item.archivedAt &&
      (finishedArchivable(item) || stoppedArchivable(item) || (!!item.idea && item.idea.status !== 'open' && !prototyped));
    const cls = [
      'item',
      cardClass(item, underway),
      shape,
      dep && `dep-${dep}`, lifted && 'lifted', dragging && 'dragging', pop && 'pop', lit && 'lit'].filter(Boolean).join(' ');
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
        <CardFace item={item} where={showRepo ? item.repo : undefined} underway={underway} chip={shape === 'chip'} />
        {!underway && <CardTurn item={item} />}
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
            <PlayIcon size={12} />
          </button>
        )}
        {archivable && (
          <button
            className={startable ? 'play archive beside' : 'play archive'}
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
    a.item === b.item && sameBounds(a.b, b.b) && a.lifted === b.lifted && a.dragging === b.dragging && a.pop === b.pop && a.lit === b.lit && a.prototyped === b.prototyped && a.showRepo === b.showRepo && a.onStart === b.onStart && a.onArchive === b.onArchive && a.dep === b.dep && a.onHover === b.onHover && a.underway === b.underway,
);

/**
 * The canvas's name and home branch; with several canvases, a switcher. Other canvases with cards
 * that need the owner carry their count in the menu, and while it is closed the pill carries the sum.
 */
export function CanvasPill({ canvas, canvases, waiting }: { canvas: CanvasInfo; canvases: CanvasInfo[]; waiting: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(open, box, () => setOpen(false), true);
  const home = canvas.repos[0];
  const many = canvases.length > 1;
  const elsewhere = canvases.reduce((n, c) => n + (c.id === canvas.id ? 0 : (waiting[c.id] ?? 0)), 0);
  return (
    <div className="canvas-pill" ref={box}>
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
        <span className="hint lbl">{canvas.repos.length > 1 ? t.repos(canvas.repos.length) : home?.branch}</span>
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
                <CanvasAgents canvas={c} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
  const a = canvas.agents;
  if (!a) return null;
  const pause = a.running > 0;
  const label = pause ? t.canvasPause.pause(a.running) : t.canvasPause.resume(a.paused);
  const click = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAsked(true);
    (pause ? api.pauseAgents(canvas.id) : api.resumeAgents(canvas.id)).catch(console.error).finally(() => setAsked(false));
  };
  return (
    <span className={pause ? 'canvas-agents running' : 'canvas-agents'}>
      <button type="button" className="agents-turn" aria-label={`${label}: ${canvas.name}`} disabled={asked} onClick={click}>
        {pause ? <PauseMark /> : <PlayMark />}
        <span className="tip">{label}</span>
      </button>
    </span>
  );
}

/** A restart that waits for workers or the owner: for whom and until when (on hover), and a button that has it go ahead now. */
export function RestartPill({ restart, items }: { restart: PendingRestart; items: Item[] }) {
  if (restart.repos) return <ReposRestartPill restart={restart} items={items} />;
  const n = restart.cards.length + restart.elsewhere.reduce((m, c) => m + c.cards.length, 0);
  const until = clock(restart.deadline);
  const owner = restart.owner;
  const stop = restart.reason === 'stop';
  const update = restart.reason === 'update';
  return (
    <Pill
      restart={restart}
      items={items}
      elsewhere={restart.elsewhere}
      go={api.restartNow}
      going={stop ? t.restart.goingStop : update ? t.restart.goingUpdate : t.restart.going}
      say={t.restart.pill(n, owner, restart.reason)}
      // the deadline does not cut the owner off
      until={!owner.length}
      now={stop ? t.restart.nowStop : update ? t.restart.nowUpdate : t.restart.now}
      risk={stop ? t.restart.nowRiskStop : n ? t.restart.nowRisk : t.restart.nowOwner}
      why={
        <>
          <p>{t.restart.reason[restart.reason]}</p>
          {owner.map((h) => (
            <p key={h}>{t.restart.owner[h]}</p>
          ))}
        </>
      }
      after={
        <>
          {(stop || update) && <p className="hint">{stop ? t.restart.keptStop : t.restart.keptUpdate}</p>}
          {n > 0 && <p className="hint">{stop ? t.restart.deadlineStop(until) : owner.length ? t.restart.deadlineOwner(until) : update ? t.restart.deadlineUpdate(until) : t.restart.deadline(until)}</p>}
        </>
      }
    />
  );
}

/** A restart of some repositories' agents alone, for a change to their configuration, that waits for them; Obeya runs on. */
function ReposRestartPill({ restart, items }: { restart: PendingRestart; items: Item[] }) {
  const r = t.restart.repos;
  return (
    <Pill
      restart={restart}
      items={items}
      go={api.restartReposNow}
      going={r.going}
      say={r.pill(restart.cards.length)}
      until
      now={r.now}
      risk={r.nowRisk}
      why={<p>{restart.leaving ? r.leaving : r.reason((restart.repos ?? []).join(', '), restart.reason === 'repository')}</p>}
      after={
        <>
          {!restart.leaving && <p className="hint">{r.kept}</p>}
          <p className="hint">{r.deadline(clock(restart.deadline))}</p>
        </>
      }
    />
  );
}

/**
 * The pill of either restart: what it waits for (`say`), with `until` until when, and a button
 * (`now`, its risk on hover) that has it go ahead through `go`, saying `going` once it does. On
 * hover why (`why`), the cards it waits for here and on the other canvases (`elsewhere`), and
 * what follows (`after`).
 */
function Pill({ restart, items, elsewhere = [], go, going, say, until, now, risk, why, after }: {
  restart: PendingRestart;
  items: Item[];
  elsewhere?: PendingRestart['elsewhere'];
  go: () => Promise<{ restarting: boolean }>;
  going: string;
  say: string;
  until: boolean;
  now: string;
  risk: string;
  why: ReactNode;
  after: ReactNode;
}) {
  const [on, setOn] = useState(false);
  const titles = restart.cards.map((id) => plain(items.find((i) => i.id === id)?.title ?? id));
  const click = () => {
    setOn(true);
    go().then(
      (r) => r.restarting || setOn(false),
      () => setOn(false),
    );
  };
  if (on)
    return (
      <div className="pill restart going" id="restart">
        <span className="spin">↻</span> {going}
      </div>
    );
  return (
    <div className="pill restart" id="restart">
      <span className="spin">↻</span>
      <span className="say">{say}</span>
      {until && <span className="hint">{t.restart.until(clock(restart.deadline))}</span>}
      <button onClick={click}>
        {now}
        <span className="tip risk" role="tooltip">
          {risk}
        </span>
      </button>
      <div className="tip why" role="tooltip">
        {why}
        {titles.length + elsewhere.length > 0 && (
          <>
            <p>{t.restart.waits}</p>
            {titles.length > 0 && (
              <ul>
                {titles.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            {elsewhere.map((c) => (
              <div key={c.canvas} className="elsewhere">
                <p className="hint">{t.restart.on(c.canvas)}</p>
                <ul>
                  {c.cards.map((x, i) => (
                    <li key={i}>{plain(x)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {after}
      </div>
    </div>
  );
}

/**
 * A newer version of the app, downloaded by its shell: what changed (on hover), and a button that
 * installs it once the workers paused, as a restart waits for them (then RestartPill shows the wait).
 * A .deb cannot be replaced by the app: the button opens the release to download it.
 */
export function UpdatePill({ update }: { update: AppUpdate }) {
  const [asked, setAsked] = useState(false);
  const install = () => {
    setAsked(true);
    api.installUpdate().catch(() => setAsked(false));
  };
  return (
    <div className="pill restart update" id="update">
      <span>{t.update.pill(update.version)}</span>
      {update.download ? (
        <button onClick={() => window.open(update.download, '_blank')}>{t.update.download}</button>
      ) : (
        <button onClick={install} disabled={asked}>
          {t.update.install}
        </button>
      )}
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.update.title(update.version, update.date ? shortDay(update.date) : null)}</b>
        </p>
        {update.notes && <Doc md={update.notes} />}
        <p className="hint">{update.download ? t.update.howDownload : t.update.how}</p>
      </div>
    </div>
  );
}

/**
 * New commits on the upstream of the checkout Obeya runs from (Obeya from source): which (on
 * hover), and a button that pulls them as a fast-forward, after which Obeya restarts with the new
 * code once the workers paused (then RestartPill shows the wait). Where Obeya cannot fast-forward,
 * there is no button, and the hover says what stands in the way.
 */
export function SourcePill({ source }: { source: SourceUpdate }) {
  const [asked, setAsked] = useState(false);
  // a pull that failed comes back with git's message: the button is there again
  useEffect(() => setAsked(false), [source]);
  const pull = () => {
    setAsked(true);
    api.pullSource().catch(() => setAsked(false));
  };
  const more = source.count - source.commits.length;
  const how = !source.blocked
    ? t.source.how(source.checkout)
    : source.blocked.why === 'diverged'
      ? t.source.diverged(source.checkout, source.upstream)
      : t.source.local(source.checkout, source.blocked.files.map((f) => `\`${f}\``).join(', '));
  return (
    <div className={source.blocked ? 'pill restart update source by-hand' : 'pill restart update source'} id="source-update">
      <span>{t.source.pill(source.count)}</span>
      {!source.blocked && (
        <button onClick={pull} disabled={asked}>
          {t.source.pull}
        </button>
      )}
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.source.title(source.count, source.upstream)}</b>
        </p>
        <ul>
          {source.commits.map((c, i) => (
            <li key={i}>
              {c.subject} <span className="hint">{shortDay(c.date)}</span>
            </li>
          ))}
        </ul>
        {more > 0 && <p className="hint">{t.source.more(more)}</p>}
        {source.error && <p className="warn">{t.source.failed(source.error)}</p>}
        <p className="hint">
          <Inline md={how} />
        </p>
      </div>
    </div>
  );
}

/**
 * The Bun the server runs on is too old (on Linux, before 1.3.14): it can deadlock, and then the
 * canvas stops loading. It stays in the bar for as long as the server runs on it; what to do, on hover.
 */
export function OldBunPill({ version }: { version: string }) {
  return (
    <div className="pill restart old-bun" id="old-bun">
      <span className="warn">⚠</span>
      <span className="say">{t.oldBun.pill(version)}</span>
      <div className="tip why" role="tooltip">
        <p>
          <b>{t.oldBun.title}</b>
        </p>
        <p>{t.oldBun.why(version)}</p>
        <p>
          <Inline md={t.oldBun.how} />
        </p>
      </div>
    </div>
  );
}

/**
 * Each repository's pool by machine: a dot per clone (solid while its card's worker is at work,
 * pale while the card holds it otherwise, orange while free but blocked), or per slot of a
 * repository in worktrees, and how many new cards could start now. Hovering or clicking it drops
 * down each machine's slots and each of its workspaces by path with the card in it, which opens
 * the card (`onOpen`; `onElsewhere` one on another canvas), and why a blocked clone goes to no card
 * and what to do about it. While every clone is taken and a card waits for one, a faint „⋯“ beside
 * a card opens what gives its clone to the one waiting longest (`onTake`); during the undo window
 * the row offers „Rückgängig“ (`onKeep`).
 */
export function WorkspacesPill({ pools, canvas, canvases, items, onOpen, onElsewhere, onTake, onKeep }: {
  pools: ClonePool[];
  canvas: CanvasInfo;
  canvases: CanvasInfo[];
  items: Item[];
  onOpen: (i: Item) => void;
  onElsewhere: (canvas: string, card: string) => void;
  onTake: (i: Item) => void;
  onKeep: (i: Item) => void;
}) {
  // open by a click (a tap) until one elsewhere or Escape; shut after a card is opened from it, until the pointer leaves
  const [open, setOpen] = useState(false);
  const [shut, setShut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // the pointer may still be over it: shut, not just unpinned
      setOpen(false);
      setShut(true);
    };
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  const several = pools.length > 1;
  const name = (repo: string) => canvas.repos.find((r) => r.id === repo)?.name ?? repo;
  const forWorkspace = items.filter((i) => (i.queue && 'workspace' in i.queue && i.queue.workspace !== 'slots') || i.waitsForClone).length;
  const forSlot = items.filter((i) => i.queue && 'workspace' in i.queue && i.queue.workspace === 'slots').length;
  // a clone is taken from its card only while none is free and a card of its repository waits for one
  const wanted = (p: ClonePool) =>
    p.hosts.every((h) => h.cards.length + blocked(h) >= h.total) && items.some((i) => i.repo === p.repo && ((i.queue && 'workspace' in i.queue) || i.waitsForClone));
  const blocked = (h: PoolHost) => h.blocked?.length ?? 0;
  // a new card takes a free clone that is not blocked, on a machine whose busy workers leave it a slot
  const room = (h: PoolHost) => Math.max(0, Math.min(h.slots - h.busy.length, h.total - h.cards.length - blocked(h)));
  const free = (p: ClonePool) => p.hosts.reduce((n, h) => n + room(h), 0);
  const total = (p: ClonePool) => p.hosts.reduce((n, h) => n + h.total, 0);
  const blockedIn = (p: ClonePool) => p.hosts.reduce((n, h) => n + blocked(h), 0);
  const full = pools.every((p) => free(p) === 0);
  // the machines a pool names: those with clones or a clone's folder kept, and every other machine than this one
  const named = (p: ClonePool) => p.hosts.filter((h) => h.total > 0 || !h.here || h.kept?.length);
  const opened = (go: () => void) => {
    setOpen(false);
    setShut(true);
    go();
  };
  return (
    <div
      ref={ref}
      className={['pill workspaces', full && 'full', open && 'open', shut && 'shut'].filter(Boolean).join(' ')}
      id="workspaces"
      onPointerLeave={() => setShut(false)}
    >
      <button className="face" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lbl">{t.workspaces.label}</span>
        {pools.map((p) => {
          const hosts = named(p);
          return (
            <span key={p.repo} className="pool">
              {several && <span className="hint">{name(p.repo)}</span>}
              {hosts.map((h) => (
                <span key={h.name} className="host">
                  {hosts.length > 1 && <span className="hint">{h.name}</span>}
                  <span className="slots" aria-hidden>
                    {Array.from({ length: h.total }, (_, i) => (
                      <i key={i} className={i < h.busy.length ? 'on' : i < h.cards.length ? 'held' : i < h.cards.length + blocked(h) ? 'blocked' : undefined} />
                    ))}
                  </span>
                </span>
              ))}
              <b>{t.workspaces.free(free(p), total(p), blockedIn(p))}</b>
              {blockedIn(p) > 0 && <b className="warn">{t.workspaces.blockedCount(blockedIn(p))}</b>}
            </span>
          );
        })}
        <span className="hint drop">▾</span>
      </button>
      <div className="tip" role="dialog" aria-label={t.workspaces.label}>
        {pools.map((p) => (
          <div key={p.repo}>
            {several && (
              <p>
                <b>{name(p.repo)}</b>
              </p>
            )}
            {named(p).map((h) => (
              <div key={h.name}>
                <p>
                  {h.worktrees
                    ? t.workspaces.worktreeSlots(h.name, h.busy.length, h.slots, h.workspaces.length > 0)
                    : t.workspaces.host(h.name, h.busy.length, h.slots, h.cards.length, h.total)}
                </p>
                {h.workspaces.length > 0 && (
                  <WorkspaceRows
                    host={h}
                    items={items}
                    canvases={canvases}
                    onOpen={(i) => opened(() => onOpen(i))}
                    onElsewhere={(c, card) => opened(() => onElsewhere(c, card))}
                    onTake={wanted(p) ? onTake : undefined}
                    onKeep={onKeep}
                  />
                )}
                {h.kept?.map((path) => (
                  <p key={path} className="hint">
                    {t.workspaces.kept(path)}
                  </p>
                ))}
                <BlockedClones host={h} />
              </div>
            ))}
          </div>
        ))}
        {forWorkspace > 0 && <p>{t.workspaces.waiting(forWorkspace)}</p>}
        {forSlot > 0 && <p>{t.workspaces.waitingSlot(forSlot)}</p>}
      </div>
    </div>
  );
}

/**
 * A machine's workspaces, one per line: the dot the pill shows for it, its path (cut at the front
 * where it is too long, so its end stays), and the card in it, which opens on a click; or that it
 * is free, or blocked. With `onTake` (a card waits, none is free), a faint „⋯“ beside each card
 * that may give its clone up, which opens the one action and what it does; a card giving it up has
 * „Rückgängig“ (`onKeep`) instead.
 */
function WorkspaceRows({ host, items, canvases, onOpen, onElsewhere, onTake, onKeep }: {
  host: PoolHost;
  items: Item[];
  canvases: CanvasInfo[];
  onOpen: (i: Item) => void;
  onElsewhere: (canvas: string, card: string) => void;
  onTake?: (i: Item) => void;
  onKeep: (i: Item) => void;
}) {
  const blocked = new Set(host.blocked?.map((b) => b.path));
  // the row whose „⋯“ is open
  const [more, setMore] = useState<string | null>(null);
  return (
    <ul className="ws-list">
      {host.workspaces.map((w) => {
        const item = w.card && !w.canvas ? items.find((i) => i.id === w.card) : undefined;
        const busy = !!w.card && host.busy.includes(w.card);
        const state = busy ? 'on' : w.card ? 'held' : blocked.has(w.path) ? 'blocked' : 'free';
        const there = w.canvas && canvases.find((c) => c.id === w.canvas);
        return (
          <li key={w.path} className={state}>
            <i aria-hidden />
            <span className="ws-path" title={w.path}>
              {/* the mark keeps the path's leading slash at its start in the right-to-left box that cuts it at the front */}
              {'\u200e' + w.path}
            </span>
            <span className="ws-card">
              {item ? (
                <a className="from" onClick={() => onOpen(item)}>
                  {plain(item.title)}
                </a>
              ) : w.card && there ? (
                <>
                  <a className="from" onClick={() => onElsewhere(there.id, w.card!)}>
                    {plain(w.title ?? '')}
                  </a>
                  <span className="hint"> · {t.workspaces.onCanvas(there.name)}</span>
                </>
              ) : w.card ? (
                <span className="hint">{w.title ? t.workspaces.notOnCanvas(plain(w.title)) : t.workspaces.offCanvas}</span>
              ) : (
                <span className={state === 'blocked' ? 'warn' : 'hint'}>{state === 'blocked' ? t.workspaces.blockedRow : t.workspaces.freeRow}</span>
              )}
              {busy && !w.leaving && <span className="hint"> · {t.workspaces.atWork}</span>}
              {item && w.leaving && (
                <>
                  <span className="hint"> · {t.workspaces.leaving}</span>
                  <button className="btn ws-take" onClick={() => onKeep(item)}>
                    {t.undo}
                  </button>
                </>
              )}
              {item && w.takeable && onTake && (
                <button className="ws-more" title={t.workspaces.more} aria-label={t.workspaces.more} aria-expanded={more === w.path} onClick={() => setMore(more === w.path ? null : w.path)}>
                  ⋯
                </button>
              )}
            </span>
            {item && w.takeable && onTake && more === w.path && (
              <div className="ws-menu">
                <button
                  className="btn ws-take"
                  onClick={() => {
                    setMore(null);
                    onTake(item);
                  }}
                >
                  {t.workspaces.take}
                </button>
                <span className="hint">{t.workspaces.takeWhat}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Why each of a machine's blocked clones goes to no card, and what the owner can do: a line per clone, one for all of an unreachable machine's. */
function BlockedClones({ host }: { host: PoolHost }) {
  const all = host.blocked ?? [];
  const away = all.filter((b) => b.why === 'unreachable').map((b) => b.path);
  const line = (b: BlockedClone) => {
    const tb = t.workspaces.blocked;
    switch (b.why) {
      case 'dirty':
        return tb.dirty(b.path, b.files ?? [], b.more ?? 0);
      case 'broken':
        return tb.broken(b.path, b.error ?? '', !!b.made);
      case 'missing':
        return tb.missing(b.path, !!b.made);
      case 'failed':
        return tb.failed(b.path, b.error ?? '');
      case 'unreachable':
        return tb.unreachable(host.name, away);
    }
  };
  return (
    <>
      {all
        .filter((b, i) => b.why !== 'unreachable' || all.findIndex((x) => x.why === 'unreachable') === i)
        .map((b) => (
          <p key={b.path} className="warn">
            {line(b)}
          </p>
        ))}
    </>
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
    /** It, or a workstream it holds folded, has its row in the search under the pointer or picked. */
    lit?: boolean;
  }) {
    const live = kids.filter((k) => finished(k.state)).length;
    const waiting = kids.filter(needsYou).length;
    const startable = startableIn(kids);
    const collapsed = !!item.collapsed;
    // the canvas would take the press as the start of a drag or a click that opens the project
    const own = (e: React.PointerEvent) => e.stopPropagation();
    return (
      <div className={`item project s-${item.state}${collapsed ? ' collapsed' : ''}${lit ? ' lit' : ''}`} data-id={item.id} style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 0 }}>
        <div className="head">
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
          <span className="ttl">{plain(item.title)}</span>
          <span className="kind">{t.kind.project}</span>
          <span className="progress">{t.progress(live, kids.length)}</span>
          {/* collapsed, its workstreams are not on the canvas to arrange; its sheet still has the button */}
          {!collapsed && (item.arranging || arrangeable(kids)) && (
            <button
              className="head-btn arrange"
              disabled={item.arranging}
              title={`${t.plan.arrangeLong}. ${t.plan.arrangeHint}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onArrange(item);
              }}
            >
              <ColumnsIcon size={11} />
              {item.arranging ? t.plan.arranging : t.plan.arrange}
            </button>
          )}
          {startable > 0 && (
            <button
              className="head-btn start-all"
              title={`${t.plan.startAll(startable)}. ${t.plan.startAllHint}`}
              onPointerDown={own}
              onClick={(e) => {
                e.stopPropagation();
                onStartAll(item, startable);
              }}
            >
              <PlayIcon size={10} />
              {t.plan.startAllShort(startable)}
            </button>
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
    sameBounds(a.b, b.b) &&
    a.kids.length === b.kids.length &&
    a.kids.every((k, i) => k === b.kids[i]),
);

/**
 * A curve between the facing sides of two cards: left and right when they stand more beside each
 * other than above each other, else bottom and top. It leaves and enters the cards square to their
 * sides. With a `head`, it stops that far short of `b`, where the base of an arrow head drawn along
 * its last direction goes, so the head ends on `b`'s side however sharply the curve bends.
 */
export function linkPath(a: Bounds, b: Bounds, head = 0): string {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const across = gapX > gapY;
  // The direction of travel along the axis the cards face each other on, and the ends on it.
  const dir = across ? Math.sign(b.x + b.w / 2 - (a.x + a.w / 2)) || 1 : Math.sign(b.y + b.h / 2 - (a.y + a.h / 2)) || 1;
  const [x1, y1] = across ? [dir > 0 ? a.x + a.w : a.x, a.y + a.h / 2] : [a.x + a.w / 2, dir > 0 ? a.y + a.h : a.y];
  const [x2, y2] = across ? [(dir > 0 ? b.x : b.x + b.w) - dir * head, b.y + b.h / 2] : [b.x + b.w / 2, (dir > 0 ? b.y : b.y + b.h) - dir * head];
  // How far the control points reach out from the cards: half the way, but with a head at least its
  // length (less where the curve hardly goes sideways), so that a short link still runs square into
  // the head instead of meeting it from the side.
  const along = across ? x2 - x1 : y2 - y1;
  const aside = across ? y2 - y1 : x2 - x1;
  const reach = dir * Math.max(dir * along / 2, Math.min(Math.abs(aside) / 2, head));
  return across ? `M${x1},${y1} C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${y1 + reach} ${x2},${y2 - reach} ${x2},${y2}`;
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

/** The length of the arrow head at the end of a wait's line, in canvas pixels. */
const DEP_HEAD = 15;

/** While the pointer is on a card with waits: a line for each wait, from the card waited for to the card waiting. */
export function DepLinks({ placed, edges }: { placed: { item: Item; b: Bounds }[]; edges: [string, string][] }) {
  const byId = new Map(placed.map((p) => [p.item.id, p.b]));
  return (
    <svg id="deps" width="1" height="1">
      <defs>
        {/* The line stops at the head's base (refX 0, a hair inside so no seam shows) and the head points on to the card. */}
        <marker id="dep-arrow" viewBox="0 0 9 8" refX="0.3" refY="4" markerUnits="userSpaceOnUse" markerWidth={DEP_HEAD} markerHeight={(DEP_HEAD * 8) / 9} orient="auto">
          <path d="M0,0 L9,4 L0,8 z" />
        </marker>
      </defs>
      {edges.flatMap(([from, to]) => {
        const a = byId.get(from);
        const b = byId.get(to);
        return a && b ? [<path key={`${from} ${to}`} d={linkPath(a, b, DEP_HEAD)} markerEnd="url(#dep-arrow)" />] : [];
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
  onArrange,
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
  /** Puts the workstreams in columns by what builds on what. */
  onArrange: (project: Item) => void;
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
          {!project.archivedAt && (project.arranging || arrangeable(kids)) && (
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
                      : [stateLabel(k), !finished(k.state) && k.buildsOn?.length && t.plan.buildsOn(k.buildsOn.map((id) => sibling(id, kids, all)))].filter(Boolean).join(' · ')}
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

// ------------------------------------------------------------------ overlays

/** Chips at the edge of the canvas pointing at off-screen cards that need the owner; `rightReserve`: the sheet docked on the right. */
/** Each target out of sight points to where it stands from the screen's edge; `lit` is the one picked in the search. */
export function Edges({ cam, targets, rightReserve, onOpen, lit }: { cam: Cam; targets: { item: Item; b: Bounds }[]; rightReserve: number; onOpen: (i: Item) => void; lit?: string | undefined }) {
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
          <button key={item.id} className={`edge s-${item.state}${item.id === lit ? ' lit' : ''}`} style={{ left: x, top: y, transform: `translate(${tx}, -50%)` }} onClick={() => onOpen(item)}>
            <span className="arr" style={{ transform: `rotate(${ang}deg)` }}>
              ➜
            </span>
            {clip(title, 30)}
          </button>
        );
      })}
    </div>
  );
}

export function Minimap({
  cam,
  viewW,
  all,
  placed,
  territories,
  onJump,
  onFollow,
}: {
  cam: Cam;
  /** How wide the canvas shows, left of the sheet docked on the right. */
  viewW: number;
  all: Bounds;
  placed: { item: Item; b: Bounds }[];
  territories: Shape[];
  onJump: (wx: number, wy: number) => void;
  onFollow: (wx: number, wy: number) => void;
}) {
  const W = 210;
  const H = 130;
  const pad = 10;
  const k = Math.min((W - 2 * pad) / all.w, (H - 2 * pad) / all.h);
  const ox = (W - all.w * k) / 2 - all.x * k;
  const oy = (H - all.h * k) / 2 - all.y * k;
  // a press that moves follows the pointer; one that does not jumps where it was let go
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const world = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k];
  };
  return (
    <div
      id="minimap"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p) return;
        if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 3) return;
        p.moved = true;
        onFollow(...world(e));
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (p && !p.moved) onJump(...world(e));
      }}
      onPointerCancel={() => (press.current = null)}
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
            rx={item.kind === 'project' ? 1.5 : 0.5}
            style={{ fill: item.kind === 'project' ? 'var(--container-line)' : `var(--${item.snoozed ? 'muted' : item.state})` }}
            opacity={item.kind === 'project' || needsYou(item) ? 1 : 0.55}
          />
        ))}
        <rect
          x={ox + (-cam.x / cam.s) * k}
          y={oy + (-cam.y / cam.s) * k}
          width={(viewW / cam.s) * k}
          height={(innerHeight / cam.s) * k}
          fill="none"
          style={{ stroke: 'var(--ink)' }}
          strokeWidth={1.2}
          rx={1}
          opacity={0.5}
        />
      </svg>
    </div>
  );
}
