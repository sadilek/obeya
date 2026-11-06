// Cards the owner swiped aside on the phone: out of „Braucht dich“ and „Läuft“ until they need the
// owner anew, in a list of their own meanwhile. Kept in the phone's browser, not on the server: it is
// how the owner sorts the phone's lists, and the canvas at the desk shows every card as before.

import { type Item, needsYou } from '../core/types';

/** Each card set aside, with since when it waited for the owner as it was set aside (`null`: it did not wait then). */
export type SetAside = Record<string, string | null>;

const KEY = 'obeya-phone-aside';

export function loadAside(): SetAside {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, since]) => since === null || typeof since === 'string')) as SetAside;
  } catch {
    return {};
  }
}

export function saveAside(aside: SetAside) {
  try {
    if (Object.keys(aside).length) localStorage.setItem(KEY, JSON.stringify(aside));
    else localStorage.removeItem(KEY);
  } catch {}
}

/** What a card set aside now is noted with: since when it waits for the owner, if it does. */
export const asideMark = (i: Item): string | null => (needsYou(i) ? (i.waitingSince ?? null) : null);

/**
 * Whether a card set aside stays so: until it needs the owner with a wait other than the one it was
 * set aside in. A card set aside while it ran, or while it waited and then went on at the desk, comes
 * back the next time it waits for the owner; one still waiting the same wait stays aside.
 */
export const staysAside = (aside: SetAside, i: Item): boolean => i.id in aside && !(needsYou(i) && (i.waitingSince ?? null) !== aside[i.id]);
