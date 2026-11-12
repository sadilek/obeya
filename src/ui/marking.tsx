// Marking cards on the canvas: Shift + drag draws a lasso, Shift + click on a card takes it in or
// out. What is marked moves together, and goes into a group at once through the colour ring, which a
// right click on a card opens too.

import { useEffect, useRef, useState } from 'react';
import { type Bounds, centre, unionBounds } from '../core/layout';
import type { Group, Item } from '../core/types';
import { openPerGroup } from '../core/card';
import { api } from './api';
import { type Cam, type Sides, TOP, toWorld } from './camera';
import { growFrom, inside, Lasso, MarkHint, Marked, Ring } from './groups';
import type { Pos } from './optimistic';
import { addAll, MARK_KNOWN, markable, MOVE_MARKED_KNOWN, toggle } from './selection';
import { useKnown } from './stored';
import { t } from './strings';

/** The room the line for what is marked takes above or below the marked cards, and its least width. */
const MARKED_ROOM = 90;
const MARKED_W = 270;

type Placed = { item: Item; b: Bounds }[];

export function useMarking({ placed, byId, cam, showAck, fail }: { placed: Placed; byId: (id: string) => Item | undefined; cam: { readonly current: Cam }; showAck: (text: string, undo?: () => unknown) => void; fail: (e: unknown) => void }) {
  const lassoRef = useRef<Pos[] | null>(null);
  const [lasso, setLasso] = useState<Pos[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const marked = selection.filter((id) => placed.some((p) => p.item.id === id));
  // how to mark shows after a card was moved alone, until the owner has marked cards; how to move them beside them, until they have
  const [markKnown, knowMark] = useKnown(MARK_KNOWN);
  const [moveKnown, knowMove] = useKnown(MOVE_MARKED_KNOWN);
  const [markHint, setMarkHint] = useState<{ at: Pos; key: number } | null>(null);
  useEffect(() => {
    if (!marked.length || markKnown) return;
    knowMark();
    setMarkHint(null);
  }, [marked.length]);
  useEffect(() => {
    if (!markHint) return;
    const h = setTimeout(() => setMarkHint(null), 7000);
    return () => clearTimeout(h);
  }, [markHint]);
  const [ring, setRing] = useState<{ at: Pos; ids: string[] } | null>(null);

  /** Shift + press on the empty canvas: a lasso starts. */
  const startLasso = (e: React.PointerEvent) => {
    lassoRef.current = [{ x: e.clientX, y: e.clientY }];
    setLasso(lassoRef.current);
  };
  /** The pointer moves on with the lasso; true while there is one. */
  const drawLasso = (e: React.PointerEvent) => {
    if (!lassoRef.current) return false;
    lassoRef.current = [...lassoRef.current, { x: e.clientX, y: e.clientY }];
    setLasso(lassoRef.current);
    return true;
  };
  /** Let go: what the lasso caught is marked; true where there was a lasso. */
  const endLasso = () => {
    const l = lassoRef.current;
    if (!l) return false;
    lassoRef.current = null;
    setLasso([]);
    const c = cam.current;
    // a Shift + click on a project beside its workstreams marks the project
    if (l.every((p) => Math.hypot(p.x - l[0]!.x, p.y - l[0]!.y) < 5)) {
      const el = document.elementFromPoint(l[0]!.x, l[0]!.y)?.closest<HTMLElement>('.item');
      const i = el && byId(el.dataset.id!);
      if (i) setSelection((sel) => toggle(sel, markable(i)));
      return true;
    }
    // what the lasso caught: each card whose middle lies inside, a workstream as its project
    const ids = [...new Set(placed.filter(({ b }) => inside({ x: c.x + (b.x + b.w / 2) * c.s, y: c.y + (b.y + b.h / 2) * c.s }, l)).map(({ item }) => markable(item)))];
    setSelection((sel) => addAll(sel, ids));
    return true;
  };
  /** A Shift + click on a card takes it in or out. */
  const flip = (i: Item) => setSelection((sel) => toggle(sel, markable(i)));
  /** Cards dropped at `at`, with the marked ones (`along`) or alone: how to mark shows beside them until the owner knows. */
  const dropped = (along: boolean, at: Pos) => {
    if (along) knowMove();
    else if (!markKnown) setMarkHint({ at, key: Date.now() });
  };
  /** A right click on a card opens the colour ring for it (a workstream's is its project's), on a marked one for all marked. */
  function ringAt(e: React.MouseEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.item');
    let i = el && byId(el.dataset.id!);
    if (i?.parent) i = byId(i.parent);
    if (!i) return;
    e.preventDefault();
    setRing({ at: { x: e.clientX, y: e.clientY }, ids: marked.includes(i.id) ? marked : [i.id] });
  }
  async function assignGroup(to: { group: string | null } | { name: string }) {
    const r = ring!;
    setRing(null);
    // the territory grows from the pointer, or from the one card it is for
    const one = r.ids.length === 1 ? placed.find((p) => p.item.id === r.ids[0])?.b : undefined;
    growFrom(r.ids, one ? centre(one) : toWorld(cam.current, r.at.x, r.at.y));
    try {
      if ('name' in to) await api.createGroup(to.name, r.ids);
      else await api.assign(r.ids, to.group);
    } catch (e) {
      fail(e);
    }
  }
  /** The × on a group's name in the colour ring: its cards belong to none, with a moment to undo. */
  async function deleteGroup(g: Group) {
    setRing(null);
    try {
      const gone = await api.deleteGroup(g.id);
      showAck(t.groups.removed(g.name), () => api.createGroup(gone.group.name, gone.cards, gone.group.hue));
    } catch (e) {
      fail(e);
    }
  }
  return {
    lasso,
    marked,
    ring,
    moveKnown,
    markHint,
    /** Whether a lasso is being drawn. */
    lassoing: () => !!lassoRef.current,
    startLasso,
    drawLasso,
    endLasso,
    flip,
    dropped,
    clear: () => setSelection([]),
    ringAt,
    groupMarked: (at: Pos) => setRing({ at, ids: marked }),
    closeRing: () => setRing(null),
    assignGroup,
    deleteGroup,
  };
}

/**
 * What marking shows over the canvas: the lasso, the line for what is marked (`still` while cards
 * move or a card is open: then it hides), how to mark, and the colour ring.
 */
export function MarkingLayer({ m, placed, cam, side, still, groups, items }: { m: ReturnType<typeof useMarking>; placed: Placed; cam: Cam; side: Sides; still: boolean; groups: Group[]; items: Item[] }) {
  const box = unionBounds(placed.filter((p) => m.marked.includes(p.item.id)).map((p) => p.b));
  /** Where the line for what is marked stands: over its top right corner, below it where the bar leaves no room, always in view. */
  const markedAt = (b: Bounds) => {
    const top = cam.y + b.y * cam.s;
    const below = top < TOP + MARKED_ROOM;
    const y = below ? cam.y + (b.y + b.h) * cam.s : top;
    return { at: { x: Math.min(innerWidth - side.right - 12, Math.max(side.left + MARKED_W, cam.x + (b.x + b.w) * cam.s)), y: Math.min(innerHeight - MARKED_ROOM, Math.max(TOP + MARKED_ROOM, y)) }, below };
  };
  return (
    <>
      {!m.ring && <Lasso pts={m.lasso} />}
      {box && !m.ring && !still && !m.lasso.length && <Marked {...markedAt(box)} count={m.marked.length} hint={!m.moveKnown && m.marked.length > 1} onGroup={m.groupMarked} />}
      {m.markHint && <MarkHint key={m.markHint.key} at={m.markHint.at} />}
      {m.ring && (
        <Ring
          at={m.ring.at}
          count={m.ring.ids.length}
          groups={groups}
          open={openPerGroup(items)}
          onPick={(group) => m.assignGroup({ group })}
          onCreate={(name) => m.assignGroup({ name })}
          onDelete={m.deleteGroup}
          onClose={m.closeRing}
        />
      )}
    </>
  );
}
