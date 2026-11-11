// The canvas's cards as the page shows them: the snapshot, with what the owner did here and the
// server has not echoed back yet laid over it (positions, folds, new cards, approvals under way).

import { useEffect, useMemo, useState } from 'react';
import type { CanvasSnapshot, Item } from '../core/types';
import { useLatest } from './latest';

export type Pos = { x: number; y: number };

/** What is dragged right now: a card (with the marked cards it takes along), or the note on a plan directory. */
type Dragged = { readonly current: { id: string; with: { id: string }[]; note?: string } | null };

export function useOptimisticItems(snapshot: CanvasSnapshot, dragRef: Dragged) {
  // Local positions win over the snapshot until the server echoes them back.
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  // Projects collapsed or expanded here, until the server echoes it back.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // Cards created here, until the snapshot carries them.
  const [pending, setPending] = useState<Item[]>([]);
  // Approved cards the server is still landing, with what the card says meanwhile, until it moves on.
  const [underway, setUnderway] = useState<Record<string, string>>({});
  useEffect(() => {
    const byId = new Map(snapshot.items.map((i) => [i.id, i]));
    setMoved((m) => {
      const keep = Object.entries(m).filter(([id, p]) => {
        const i = byId.get(id);
        const d = dragRef.current;
        return i && (d?.id === id || d?.with.some((w) => w.id === id) || i.x !== p.x || i.y !== p.y);
      });
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
    setFolded((f) => {
      const keep = Object.entries(f).filter(([id, c]) => byId.has(id) && !!byId.get(id)!.collapsed !== c);
      return keep.length === Object.keys(f).length ? f : Object.fromEntries(keep);
    });
    setPending((p) => (p.some((i) => byId.has(i.id)) ? p.filter((i) => !byId.has(i.id)) : p));
    setUnderway((u) => {
      const keep = Object.entries(u).filter(([id]) => byId.get(id)?.state === 'waiting');
      return keep.length === Object.keys(u).length ? u : Object.fromEntries(keep);
    });
  }, [snapshot]);

  const items = useMemo((): Item[] => {
    // the snapshot may carry a new card before its creation answers: then it is there once
    const ids = new Set(snapshot.items.map((i) => i.id));
    const all = [...snapshot.items, ...pending.filter((i) => !ids.has(i.id))];
    return all.map((i) => {
      const at = moved[i.id] ? { ...i, ...moved[i.id] } : i;
      const c = folded[i.id];
      if (c === undefined) return at;
      const { collapsed: _, ...open } = at;
      return c ? { ...open, collapsed: true as const } : open;
    });
  }, [snapshot, pending, moved, folded]);
  const itemsRef = useLatest(items);

  // where notes on plan directories were moved here, by repository, until the server echoes it back
  const [notesMoved, setNotesMoved] = useState<Record<string, Pos>>({});
  useEffect(() => {
    const at = new Map(snapshot.planDirs?.map((d) => [d.repo, d.at]));
    setNotesMoved((m) => {
      const keep = Object.entries(m).filter(([repo, p]) => dragRef.current?.note === repo || at.get(repo)?.x !== p.x || at.get(repo)?.y !== p.y);
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
  }, [snapshot]);

  return { items, itemsRef, setMoved, setFolded, setPending, underway, setUnderway, notesMoved, setNotesMoved };
}
