// Waits the owner draws by hand between cards: a dot at a card's edge starts an arrow, a click on
// another card makes it a wait. An arrow the owner drew has a trash button that removes it at once,
// with "Undo"; a loop of waits has a button that has Obeya resolve it.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bounds } from '../core/layout';
import type { Item } from '../core/types';
import { titleFrom } from '../core/card';
import { clip } from '../core/text';
import { api, ApiError, failText } from './api';
import type { Cam } from './camera';
import { toWorld } from './camera';
import { handleAt, nearestHandle, type Side, SIDES } from './deps';
import { ArrowMarker, depHead, depWidth, linkPath, linkSpot, type Shift } from './links';
import { plain } from './markdown';
import { cardClass } from './parts';
import { useKnown } from './stored';
import { t } from './strings';
import { ACK_MS } from './tell';

/** Set once the owner has drawn their first arrow between cards: what an arrow does no longer shows while drawing. */
const DEP_KNOWN = 'obeya-dep-known';
/** The size of a loop's button on screen, at every zoom. */
const LOOP_W = 132;
const LOOP_H = 26;

type Placed = { item: Item; b: Bounds }[];
/** An arrow being drawn from the side `side` of the card `from`, its end at `x`, `y` (in the world), over the card `target`. */
type Connection = { from: string; side: Side; x: number; y: number; target?: string };
type Loop = { cards: string[]; edges: [string, string][] };

/** Whether the owner draws waits from and to the card: neither a project nor a workstream of a plan doc. */
export const connectable = (item: Item) => item.source !== 'plan' && item.kind !== 'project';

/**
 * Drawing and removing waits: `placed` are the cards on the canvas, `byId` finds one, `cam` is the
 * camera as it is now.
 */
export function useDepDrawing({ placed, byId, cam, showAck, fail }: { placed: Placed; byId: (id: string) => Item | undefined; cam: { readonly current: Cam }; showAck: (text: string, undo?: () => unknown) => void; fail: (e: unknown) => void }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  // the dot under the pointer: the canvas renders again only when it changes
  const [handle, setHandle] = useState<{ id: string; side: Side } | null>(null);
  const handleRef = useRef(handle);
  const showHandle = (h: { id: string; side: Side } | null) => {
    const was = handleRef.current;
    if (was?.id === h?.id && was?.side === h?.side) return;
    handleRef.current = h;
    setHandle(h);
  };
  // what covers an arrow's trash button: the cards, which lie above the arrows
  const cardBoxes = useMemo(() => placed.flatMap(({ item, b }) => (item.kind === 'project' ? [] : [b])), [placed]);
  const titleOf = (id: string) => {
    const i = byId(id);
    return clip(i ? plain(i.title) || titleFrom(i.body) || t.titlePlaceholder : '…', 50);
  };
  // what an arrow does shows while the owner draws one, until they have drawn their first
  const [known, know] = useKnown(DEP_KNOWN);
  // arrows the owner removed that the server may still have: one holding a queued card goes there only
  // once "Undo" has run out (`sent` from then on), so that taking it back never leaves the card started
  const [removing, setRemoving] = useState<{ key: string; sent?: true }[]>([]);
  // those removals while "Undo" runs, each with its timer and what sends it
  const pendingRemovals = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: (keepalive?: boolean) => void }>());
  // what the owner removed goes to the server even when the page goes before "Undo" has run out
  useEffect(() => {
    const away = () => {
      for (const p of pendingRemovals.current.values()) {
        clearTimeout(p.timer);
        p.send(true);
      }
      pendingRemovals.current.clear();
    };
    addEventListener('pagehide', away);
    return () => {
      removeEventListener('pagehide', away);
      away();
    };
  }, []);
  /** A removal still waiting for "Undo" to run out is taken back: the arrow stays. */
  function keep(key: string) {
    const p = pendingRemovals.current.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pendingRemovals.current.delete(key);
    setRemoving((r) => r.filter((x) => x.key !== key));
  }
  /** The trash button on an owner-drawn arrow: it goes at once, with "Undo". */
  function remove(from: string, to: Item) {
    const key = `${from}:${to.id}`;
    if (!(to.queue && 'behind' in to.queue && to.queue.behind.includes(from))) {
      api.dependency(from, to.id, true).then(
        () => showAck(t.deps.removed, () => api.dependency(from, to.id).catch(fail)),
        fail,
      );
      return;
    }
    setRemoving((r) => [...r, { key }]);
    const send = (keepalive = false) => {
      setRemoving((r) => r.map((x) => (x.key === key ? { key, sent: true } : x)));
      api.dependency(from, to.id, true, keepalive).catch((e) => {
        setRemoving((r) => r.filter((x) => x.key !== key));
        fail(e);
      });
    };
    const timer = setTimeout(() => {
      pendingRemovals.current.delete(key);
      send();
    }, ACK_MS);
    pendingRemovals.current.set(key, { timer, send });
    showAck(t.deps.removed, () => keep(key));
  }
  // a removal the server has done is shown by the snapshot from then on
  useEffect(() => {
    const drawn = new Set(placed.flatMap(({ item }) => (item.manualDependsOn ?? []).map((from) => `${from}:${item.id}`)));
    if (removing.some((x) => x.sent && !drawn.has(x.key))) setRemoving((r) => r.filter((x) => !x.sent || drawn.has(x.key)));
  }, [placed, removing]);

  /** A press while an arrow is drawn ends it, on a card as a wait; true where it did. */
  function down(e: React.PointerEvent) {
    if (!connection) return false;
    e.stopPropagation();
    if (connection.target) {
      const { from, target } = connection;
      // the arrow drawn again while its removal waits for "Undo" to run out: it simply stays
      if (pendingRemovals.current.has(`${from}:${target}`)) keep(`${from}:${target}`);
      else api.dependency(from, target).catch((err) => showAck(err instanceof ApiError && err.code === 'dependencyCycle' ? t.deps.cycle(titleOf(from), titleOf(target)) : failText(err)));
      know();
    }
    setConnection(null);
    return true;
  }
  /**
   * The pointer moves: a drawn arrow follows it to the card nearest, true then; else the dot under it
   * shows, unless the canvas is `busy` (something dragged, lassoed or panned, a card open).
   */
  function move(e: React.PointerEvent, busy: boolean) {
    const c = cam.current;
    const p = toWorld(c, e.clientX, e.clientY);
    if (connection) {
      const near = placed
        .filter(({ item }) => item.id !== connection.from && connectable(item))
        .map(({ item, b }) => ({ id: item.id, area: b.w * b.h, d: Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.w), Math.max(b.y - p.y, 0, p.y - b.y - b.h)) }))
        .filter((x) => x.d <= 8 / c.s)
        .sort((a, b) => a.d - b.d || a.area - b.area)[0];
      setConnection({ ...connection, x: p.x, y: p.y, target: near?.id });
      return true;
    }
    if (busy) showHandle(null);
    else showHandle(nearestHandle(placed.flatMap(({ item, b }) => (connectable(item) ? [{ id: item.id, b }] : [])), p, 16 / c.s));
    return false;
  }
  /** Esc: the arrow being drawn goes; true where there was one. */
  const cancel = () => !!connection && (setConnection(null), true);
  const start = (from: string, side: Side, e: React.MouseEvent) => setConnection({ from, side, ...toWorld(cam.current, e.clientX, e.clientY) });
  /** Whether the owner is removing the wait of `to` on `from`: its line goes at once. */
  const removed = (from: string, to: string) => removing.some((x) => x.key === `${from}:${to}`);
  return { connection, handle, known, removing, removed, cardBoxes, titleOf, down, move, cancel, start, remove };
}

type Drawing = ReturnType<typeof useDepDrawing>;

/**
 * Within the waits' lines (children of `DepLinks`): on an arrow the owner drew, under the pointer, a
 * trash button that removes it, where no card covers it; on a loop of waits, a button that has Obeya
 * resolve it. Both keep their size on screen at every zoom.
 */
export function ManualEdges({ dep, placed, waitKeys, loops, standsFor, s, shift, onLoop }: { dep: Drawing; placed: Placed; waitKeys: Set<string>; loops: Loop[]; standsFor: (id: string) => string; s: number; shift: (from: string, to: string) => Shift | undefined; onLoop: (loop: Loop) => void }) {
  const head = depHead(s);
  const at = (id: string) => placed.find((p) => p.item.id === standsFor(id))?.b;
  return (
    <>
      {placed.flatMap(({ item, b }) =>
        (connectable(item) ? (item.manualDependsOn ?? []) : [])
          .filter((from) => waitKeys.has(`${from}:${item.id}`) && !dep.removed(from, item.id))
          .flatMap((from) => {
            const a = placed.find((p) => p.item.id === from && connectable(p.item))?.b;
            if (!a) return [];
            const r = 13 / s;
            const { x, y } = linkSpot(a, b, head, dep.cardBoxes, r, shift(from, item.id));
            return [
              <g className="manual-edge" key={`${from}:${item.id}`}>
                <path className="manual-hit" d={linkPath(a, b, head, shift(from, item.id))} strokeWidth={22 / s} />
                <foreignObject x={x - r} y={y - r} width={2 * r} height={2 * r}>
                  <button title={t.deps.remove} aria-label={t.deps.remove} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), dep.remove(from, item))}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
                    </svg>
                  </button>
                </foreignObject>
              </g>,
            ];
          }),
      )}
      {loops.flatMap((loop) => {
        const edge = loop.edges.find(([from, to]) => at(from) && at(to) && at(from) !== at(to));
        if (!edge) return [];
        const [w, h] = [LOOP_W / s, LOOP_H / s];
        const { x, y } = linkSpot(at(edge[0])!, at(edge[1])!, head, dep.cardBoxes, w / 2, shift(edge[0], edge[1]));
        return [
          <foreignObject key={`loop ${loop.cards.join(' ')}`} className="loop-fix" x={x - w / 2} y={y - h / 2} width={w} height={h}>
            <button style={{ transform: `scale(${1 / s})` }} title={t.deps.loopTitle(loop.cards.map(dep.titleOf))} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), onLoop(loop))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
              </svg>
              {t.deps.loopFix}
            </button>
          </foreignObject>,
        ];
      })}
    </>
  );
}

/** The arrow being drawn: to the card it would wait on, else to the pointer. */
export function ConnectionGhost({ dep, placed, s }: { dep: Drawing; placed: Placed; s: number }) {
  const c = dep.connection;
  const a = c && placed.find((p) => p.item.id === c.from)?.b;
  let ghost = null;
  if (c && a) {
    const start = handleAt(a, c.side);
    const b = placed.find((p) => p.item.id === c.target)?.b;
    const path = b ? linkPath({ ...start, w: 0, h: 0 }, b, depHead(s)) : `M${start.x},${start.y} L${c.x},${c.y}`;
    ghost = <path className="manual-ghost" d={path} strokeWidth={depWidth(s)} markerEnd={b ? 'url(#manual-arrow)' : 'url(#ghost-arrow)'} />;
  }
  return (
    <svg className="manual-deps" width="1" height="1">
      <defs>
        <ArrowMarker id="manual-arrow" />
        <ArrowMarker id="ghost-arrow" refX={9} />
      </defs>
      {ghost}
    </svg>
  );
}

/** The dots at the edges of each card an arrow starts from; the one under the pointer shows. */
export function ConnectionDots({ dep, placed, underway, depOf }: { dep: Drawing; placed: Placed; underway: Record<string, string>; depOf: (id: string) => string | undefined }) {
  const { connection, handle } = dep;
  return placed
    .filter(({ item }) => connectable(item))
    .map(({ item, b }) => (
      <div key={`handles:${item.id}`} data-id={item.id} className={`connection-handles ${cardClass(item, underway[item.id]).replace(/^card\s*/, '')}${depOf(item.id) ? ' dep-highlight' : ''}${connection?.target === item.id ? ' target' : ''}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
        {SIDES.map((side) => (
          <button key={side} className={`connection-dot ${side}${!connection && handle?.id === item.id && handle.side === side ? ' visible' : ''}`} title={t.deps.connect} aria-label={t.deps.connect} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), dep.start(item.id, side, e))} />
        ))}
      </div>
    ));
}

/** While the owner draws their first arrows: what the arrow will mean, beside its end. */
export function ConnectionHint({ dep, cam }: { dep: Drawing; cam: Cam }) {
  const c = dep.connection;
  if (!c || dep.known) return null;
  return (
    <p id="dephint" style={{ left: cam.x + c.x * cam.s, top: cam.y + c.y * cam.s }}>
      {c.target ? t.deps.waits(dep.titleOf(c.from), dep.titleOf(c.target)) : t.deps.pick(dep.titleOf(c.from))}
    </p>
  );
}
