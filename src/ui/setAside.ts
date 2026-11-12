// Cards the owner swiped aside on the phone: out of "Needs you" and "Running" until they need the
// owner anew, in a list of their own meanwhile. Kept in the phone's browser, not on the server: it is
// how the owner sorts the phone's lists, and the canvas at the desk shows every card as before.

import type { Item } from '../core/types';
import { needsYou } from '../core/card';
import { local, readJson, writeJson } from './stored';

/**
 * Each card set aside: its canvas, and since when it waited for the owner as it was set aside
 * (`null`: it did not wait then).
 */
export type SetAside = Record<string, { canvas: string; since: string | null }>;

const KEY = 'obeya-phone-aside';
/** What could not be written to the browser's storage (full, or refused): kept for this page instead. */
let unsaved: SetAside | null = null;

/** What this browser keeps set aside, as it stands now: every tab of the phone view changes the same. */
export function loadAside(): SetAside {
  if (unsaved) return unsaved;
  const v = readJson<unknown>(local, KEY);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v).filter(([, x]) => !!x && typeof x === 'object' && typeof (x as { canvas?: unknown }).canvas === 'string' && ((x as { since?: unknown }).since === null || typeof (x as { since?: unknown }).since === 'string')),
  ) as SetAside;
}

/**
 * Changes what is set aside from what this browser keeps now, not from a tab's copy of it, so that a
 * second tab's change since stays; returns the result.
 */
export function changeAside(change: (a: SetAside) => SetAside): SetAside {
  const next = change(loadAside());
  unsaved = writeJson(local, KEY, Object.keys(next).length ? next : null) ? null : next;
  return next;
}

/** Calls `changed` with what is set aside whenever another tab changes it. */
export function onAsideElsewhere(changed: (a: SetAside) => void): () => void {
  const heard = (e: StorageEvent) => (e.key === KEY || e.key === null) && changed(loadAside());
  addEventListener('storage', heard);
  return () => removeEventListener('storage', heard);
}

/** What a card set aside now is noted with: its canvas, and since when it waits for the owner, if it does. */
export const asideMark = (i: Item, canvas: string) => ({ canvas, since: needsYou(i) ? (i.waitingSince ?? null) : null });

/**
 * Whether a card set aside stays so: until it needs the owner with a wait other than the one it was
 * set aside in. A card set aside while it ran, or while it waited and then went on at the desk, comes
 * back the next time it waits for the owner; one still waiting the same wait stays aside.
 */
export const staysAside = (aside: SetAside, i: Item): boolean => i.id in aside && !(needsYou(i) && (i.waitingSince ?? null) !== aside[i.id]!.since);

/**
 * The cards to forget: those back by themselves, and those gone from their canvas while its cards
 * are known (`cards` has it). A card whose canvas the phone does not hold now (stopped, or not loaded
 * yet) stays: it comes back with its canvas.
 */
export function forgotten(aside: SetAside, cards: Record<string, Item[]>): string[] {
  return Object.entries(aside).flatMap(([id, { canvas }]) => {
    const on = cards[canvas];
    if (!on) return [];
    const i = on.find((x) => x.id === id);
    return !i || !staysAside(aside, i) ? [id] : [];
  });
}
