// A card on the canvas (its face and the marks on it), the chips at the canvas's edges and the
// minimap. State and camera live in App.tsx.

import { memo, useRef } from 'react';
import { type Bounds, shapeOf } from '../core/layout';
import { clip } from '../core/text';
import type { Item, PullRequest } from '../core/types';
import { answering, archiveRefusal, finishingUp, handedOver, needsYou, openQuestions, pausable, halted, titleFrom } from '../core/card';
import { api } from './api';
import type { Cam, Sides } from './camera';
import type { Shape } from './groups';
import { excerpt, Inline, plain } from './markdown';
import { waitReason } from './queue';
import { ClockMark, snoozeWho } from './snooze';
import { cardTag } from '../core/card-number';
import { CardNumber } from './cardNumber';
import { clock, kindLabel, snoozeWhen, stateLabel, t } from './strings';

/** The first line of a card's text that says something (not a bare "Goal" label (or its German "Ziel"), as briefs start). */
const firstLine = (md: string) =>
  plain(md)
    .split('\n')
    .map((l) => l.replace(/^(Ziel|Goal)\s*:?\s*/i, '').trim())
    .find(Boolean) ?? '';

/**
 * The state whose colour an open card wears, and its unfolded sheet: a demo whose worker takes in
 * the owner's answer is at work, a snoozed card's is pencil grey, as on the canvas.
 */
export const shownState = (i: Item) => (i.snoozed ? 'muted' : i.kind === 'question' ? 'question' : answering(i) ? 'working' : i.state);

/** A card's pull requests still open as far as Obeya knows: its own and those in other repositories. */
export const openPrs = (item: Item): PullRequest[] => [...(item.pr ? [item.pr] : []), ...(item.morePrs ?? [])].filter((p) => !p.merged && !p.closed);

/** A pull request's line on the canvas: its checks, a conflict, whether it is ready, and else what it waits for first. */
const prShort = (p: PullRequest) => {
  // a red check and a conflict the line names already
  const wait = p.ready ? undefined : p.waits?.find((w) => w !== 'conflict' && w !== 'checksFailed');
  return t.pr.short(`${p.repo ? `${p.repo.split('/').pop()} ` : ''}#${p.number}`, p.checks.filter((c) => c.state === 'failure').length, p.conflict, p.ready, p.held?.score, wait && t.pr.waitShort[wait]);
};

/** What of a workstream planned again has landed: its pull request, else its commit. */
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
  /** On a canvas with several repositories, cards name theirs: the name of the card's repository. */
  repoName?: string;
  b: Bounds;
  lifted: boolean;
  dragging: boolean;
  pop: boolean;
  /** Its row in the search is under the pointer or picked: it lights up where it stands. */
  lit?: boolean;
  els: Map<string, HTMLElement>;
  /** Starts a planned card, or one queued behind others despite the likely conflict. */
  onStart: (item: Item) => void;
  /** Takes a finished card or a parked or dropped idea off the canvas into the archive. */
  onArchive: (item: Item) => void;
  /** While the pointer is on a card with waits: this one is it, comes before it, or waits for it. */
  dep?: 'self' | 'before' | 'after' | 'loop';
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
export const PlayIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12">
    <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
  </svg>
);

/** The box on the buttons that take a finished card or project into the archive. */
export const ArchiveIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
  </svg>
);

export const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

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
    (item.paused || item.restartPaused) && 'paused',
    item.snoozed && 'snoozed',
    item.queue && 'queued',
  ]
    .filter(Boolean)
    .join(' ');

/**
 * What a card says on its face, on the canvas and in the phone view's lists alike: its kind (after
 * `where` it is, its repository or canvas), its title, a line of its text, its state line in its
 * state's colour after its number (`since` after it) and the pin while it needs the owner. A `chip`, a delivered
 * workstream, shows only its title, after its label, so it still reads as its workstream. A face
 * `inButton` (a list's entry that opens the card) shows the number without copying it (its sheet does), in its top
 * right corner, so the state line starts with the state.
 */
export function CardFace({ item, where, underway, since, chip, inButton }: { item: Item; where?: string; underway?: string; since?: string; chip?: boolean; inButton?: boolean }) {
  const kind =
    item.label ??
    (item.contribution ? t.review.kind(item.contribution.number, item.contribution.author) : item.parent ? t.kind.workstream : kindLabel(item));
  // a plain task says nothing of its kind: that it is one shows
  const label = [item.state === 'proposal' && t.proposalMark, where, kind].filter(Boolean).join(' · ');
  // a card whose agent finishes after the landing, opens its PR or takes in the owner's words on its handover shows its line like one at work: the usage limit it waits on, its reports
  // a review card waiting for the contributor says so in its state; what its review found shows while it waits for the owner
  const results = item.contribution?.results && handedOver(item) && !answering(item) ? item.contribution.results : undefined;
  const findings = item.contribution?.findings ?? [];
  const open = findings.filter((f) => f.status === 'open');
  const status = results
    ? [t.review.checks(results), ...(item.contribution?.clash ? [t.review.clashShort] : []), t.review.findings(findings.length, open.length, open.filter((f) => f.security).length)].join(' · ')
    : item.state === 'working' || item.finishing || answering(item) || (item.state === 'inPr' && (!openPrs(item).length || item.contribution))
      ? item.statusLine && excerpt(item.statusLine)
      : item.state === 'inPr'
        ? `${item.rollbackOf ? `${t.pr.rollbackShort} · ` : ''}${openPrs(item).map(prShort).join(' | ')}`
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
    (item.queue && 'behind' in item.queue ? excerpt(waitReason(item.queue)) : undefined) ??
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
        {!chip && !inButton && <CardNumber n={item.number} />}
      </div>
      {inButton && <span className="card-no plain">{cardTag(item.number)}</span>}
      {needsYou(item) && !underway && <div className="badge pulse">{item.state === 'proposal' ? '✦' : '!'}</div>}
    </>
  );
}

export const CardView = memo(
  function CardView({ item, b, lifted, dragging, pop, lit, repoName, els, onStart, onArchive, dep, onHover, underway }: CardProps) {
    const shape = shapeOf(item);
    // a card the Coordinator is checking has nothing to start yet
    const startable = item.state === 'planned' && (!item.queue || 'behind' in item.queue);
    // as "Archive" in the unfolded card
    const archivable = !item.archivedAt && !archiveRefusal(item);
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
        {(dep === 'before' || dep === 'after' || dep === 'loop') && <div className="dep-tag">{t.deps[dep]}</div>}
        <CardFace item={item} where={repoName} underway={underway} chip={shape === 'chip'} />
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
            <ArchiveIcon size={14} />
          </button>
        )}
      </div>
    );
  },
  (a, b) =>
    a.item === b.item && sameBounds(a.b, b.b) && a.lifted === b.lifted && a.dragging === b.dragging && a.pop === b.pop && a.lit === b.lit && a.repoName === b.repoName && a.onStart === b.onStart && a.onArchive === b.onArchive && a.dep === b.dep && a.onHover === b.onHover && a.underway === b.underway,
);

// ------------------------------------------------------------------ overlays

/**
 * Chips at the edge of the canvas pointing at off-screen cards that need the owner, and at the one
 * picked in the search (`lit`, which lights up); `side`: the panels docked at the window's edges.
 * `cover`: the search's list, open over the canvas: a card half or more behind it is out of sight
 * too, and its chip, or one that would stand under the list, stands beside it instead.
 */
export function Edges({ cam, targets, side, onOpen, lit, cover }: { cam: Cam; targets: { item: Item; b: Bounds }[]; side: Sides; onOpen: (i: Item) => void; lit?: string | undefined; cover?: DOMRect | undefined }) {
  const top = 64;
  const bottom = innerHeight - 60;
  const m = side.left + 30;
  const right = innerWidth - side.right - 30;
  return (
    <div id="edges">
      {targets.map(({ item, b }) => {
        const cx = cam.x + (b.x + b.w / 2) * cam.s;
        const cy = cam.y + (b.y + b.h / 2) * cam.s;
        const under = (x: number, y: number) => !!cover && x >= cover.left && x <= cover.right && y >= cover.top && y <= cover.bottom;
        // half or more of the card behind the list: what shows of it beside the list is no help to find it
        const w = b.w * cam.s;
        const h = b.h * cam.s;
        const left = cam.x + b.x * cam.s;
        const up = cam.y + b.y * cam.s;
        const covered = !!cover && 2 * Math.max(0, Math.min(left + w, cover.right) - Math.max(left, cover.left)) * Math.max(0, Math.min(up + h, cover.bottom) - Math.max(up, cover.top)) >= w * h;
        if (cx > m && cx < right && cy > top && cy < bottom && !covered) return null;
        let x = Math.min(right, Math.max(m, cx));
        const y = Math.min(bottom, Math.max(top + 10, cy));
        const beside = covered || under(x, y);
        if (beside) x = cover!.right + 12;
        const ang = (Math.atan2(cy - y, cx - x) * 180) / Math.PI;
        // anchored on the side it points to, so it stays on screen; beside the list, on its left
        const tx = beside ? '0%' : cx >= right ? '-100%' : cx <= m ? '0%' : '-50%';
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
  side,
  all,
  placed,
  territories,
  onJump,
  onFollow,
}: {
  cam: Cam;
  /** The panels docked at the window's edges: the canvas shows between them. */
  side: Sides;
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
            style={{ fill: item.kind === 'project' ? 'var(--container-line)' : `var(--${shownState(item)})` }}
            opacity={item.kind === 'project' || needsYou(item) ? 1 : 0.55}
          />
        ))}
        <rect
          x={ox + ((side.left - cam.x) / cam.s) * k}
          y={oy + (-cam.y / cam.s) * k}
          width={((innerWidth - side.left - side.right) / cam.s) * k}
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
