// The skills of a card's agent, for the menu that `/` opens in the field under its conversation:
// typed at the start of a word, it lists the skills whose names fit what follows, and the one picked
// stands in the text as `/name `, which the agent reads as the owner asking for it. Each card's list
// is asked of the server when its field shows, and again after a while.

import { useEffect, useSyncExternalStore } from 'react';
import type { Skill } from '../core/types';
import { api } from './api';
import { know, known } from './stored';

/** Set once the owner has used the menu (moved through it with the arrow keys, or picked a skill): its hint under the field goes. */
export const SKILLS_KNOWN = 'obeya-skills-known';

/** How long a card's list serves before it is asked again. */
const FRESH_MS = 60_000;

/** The card's list as asked, undefined until it came. */
const lists = new Map<string, { skills?: Skill[]; at: number }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function ask(cardId: string) {
  const kept = lists.get(cardId);
  if (kept && Date.now() - kept.at < FRESH_MS) return;
  lists.set(cardId, { skills: kept?.skills, at: Date.now() });
  api
    .skills(cardId)
    .then((skills) => lists.set(cardId, { skills, at: Date.now() }))
    // none to offer, as if the agent knew none; asked again next time
    .catch(() => lists.set(cardId, { skills: kept?.skills ?? [], at: 0 }))
    .finally(changed);
}

const NONE: Skill[] = [];

/** The skills of the card's agent (undefined while they are asked); none without a card. Asks again when `fresh` changes. */
export function useSkills(cardId: string | undefined, fresh?: unknown): Skill[] | undefined {
  useEffect(() => {
    if (cardId) ask(cardId);
  }, [cardId, fresh]);
  return useSyncExternalStore(subscribe, () => (cardId ? lists.get(cardId)?.skills : NONE));
}

/** The owner used the menu: they know it. */
export const usedSkills = () => know(SKILLS_KNOWN);
export const knowsSkills = () => known(SKILLS_KNOWN);

/** A `/` word the cursor stands at the end of: where it starts in the text, and what follows the slash. */
export interface Slash {
  start: number;
  query: string;
}

/** The `/` word ending at `caret`, at the start of the text or after a space; a path (`/a/b`) is none. */
export function slashAt(text: string, caret: number): Slash | null {
  const m = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]! };
}

/**
 * The skills that fit `query`, case aside: those whose name, or its part after a plugin's prefix
 * (`obeya:demo`), starts with it first, then those that contain it; each group as listed.
 */
export function matching(skills: Skill[], query: string): Skill[] {
  const q = query.toLowerCase();
  const starts = (s: Skill) => {
    const name = s.name.toLowerCase();
    return name.startsWith(q) || name.slice(name.indexOf(':') + 1).startsWith(q);
  };
  const first = skills.filter(starts);
  return [...first, ...skills.filter((s) => !first.includes(s) && s.name.toLowerCase().includes(q))];
}

/**
 * What picking a skill types over the `/` word (from its slash to the cursor): its name and a space,
 * or none where a space follows already, which the cursor then steps over (`skip`).
 */
export function skillWord(text: string, slash: Slash, caret: number, name: string): { from: number; to: number; word: string; skip: number } {
  const spaced = text.slice(caret).startsWith(' ');
  return { from: slash.start, to: caret, word: `/${name}${spaced ? '' : ' '}`, skip: spaced ? 1 : 0 };
}
