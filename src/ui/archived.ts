// The archived cards the canvas's page holds, as the archive's pages, the search or an address
// brought them: by id, and each project's workstreams in its doc's order. Archived cards are not on
// the canvas; they unfold from their row.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Item } from '../core/types';
import { named } from './address';
import { api } from './api';

/**
 * `rev`: the archive's mark in the snapshot, which changes with anything it lists; `onCanvas`: the
 * cards on the canvas; `open`: the cards and projects open now, read again once the archive changed:
 * one that left it (deleted, say) is forgotten, and closes as a card gone from the canvas does.
 */
export function useArchivedCards(rev: string | undefined, onCanvas: { readonly current: Item[] }, open: () => (string | null | undefined)[]) {
  const byId = useRef(new Map<string, Item>()).current;
  const kids = useRef(new Map<string, Item[]>()).current;
  const [, came] = useReducer((n: number) => n + 1, 0);
  /** Takes in archived cards as the server sent them, each project with all its workstreams. */
  const learn = useCallback((items: Item[]) => {
    const of = Map.groupBy(items.filter((i) => i.parent), (i) => i.parent!);
    for (const i of items) {
      if (i.parent) continue;
      for (const k of kids.get(i.id) ?? []) byId.delete(k.id);
      kids.delete(i.id);
      if (i.kind === 'project') kids.set(i.id, of.get(i.id) ?? []);
    }
    for (const i of items) byId.set(i.id, i);
    if (items.length) came();
  }, []);
  /** Forgets an archived card no longer in the archive, with its workstreams. */
  const forget = (id: string) => {
    for (const k of kids.get(id) ?? []) byId.delete(k.id);
    kids.delete(id);
    byId.delete(id);
  };
  useEffect(() => {
    const ids = open().flatMap((id) => {
      const i = id && !onCanvas.current.some((x) => x.id === id) ? byId.get(id) : undefined;
      return i ? [i.parent ?? i.id] : [];
    });
    if (!ids.length) return;
    let current = true;
    api.archiveEntries([...new Set(ids)]).then((items) => {
      if (!current) return;
      for (const id of ids) if (!items.some((i) => i.id === id)) forget(id);
      learn(items);
      came();
    }, console.error);
    return () => void (current = false);
  }, [rev]);
  /** The card or project an address (or an id) names, on the canvas or in the archive, which it loads where it has to. */
  async function namedBy(code: string) {
    const here = named(onCanvas.current, code) ?? named([...byId.values()], code);
    if (here) return here;
    const entry = await api.archiveEntry(code).catch(() => []);
    learn(entry);
    return named(entry, code);
  }
  return {
    get: (id: string) => byId.get(id),
    /** An archived project's workstreams. */
    kidsOf: (id: string) => kids.get(id) ?? [],
    learn,
    namedBy,
  };
}
