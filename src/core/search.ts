// How a search matches cards, shared by the canvas (the bar's search over the cards on the canvas)
// and the server (the archive's search, which runs where the archive is): every typed word, case and
// accents aside, anywhere in the card's text; a word that is a card number (`K42`) also finds
// the card with that number.

import { plain } from './plain';
import type { CardKind, Idea, Item } from './types';
import { stopped } from './card';

/** Lower case without accents, so "uber" finds "Über". */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The words of a search, folded; a card number typed apart (`K 42`, `K-42`) as one word, `k42`. */
export const searchWords = (query: string) =>
  fold(query)
    .replace(/(^|\s)k[ -](\d{1,9})(?=\s|$)/g, '$1k$2')
    .split(/\s+/)
    .filter(Boolean);

/** Whether a word of the search names the card numbered `n`: `k42`; a bare `42` is a word of the text (a year, a port). */
export const namesNumber = (n: number | undefined, w: string) => {
  const m = /^k(\d{1,9})$/.exec(w);
  return !!m && n !== undefined && Number(m[1]) === n;
};

/** Whether some word of the search names the card by its number. */
export const byNumber = (i: Pick<Item, 'number'>, words: string[]) => words.some((w) => namesNumber(i.number, w));

/**
 * A card's text that a search looks through, folded: its title, text, summary, last status, open
 * question, a proposal's reason, its `label` (as the list shows it); a project's goal and its
 * workstreams too.
 */
export function searchText(i: Item, workstreams: Item[] = [], label = '') {
  return fold(
    [i.title, i.body, i.summary, i.statusLine, i.question?.text, i.proposal?.reason, label, i.plan?.goal, ...workstreams.flatMap((w) => [w.title, w.body])].filter(Boolean).join('\n'),
  );
}

/** Whether the card's title holds every word of the search, its number counting as part of it. */
export const inTitle = (i: Pick<Item, 'title' | 'number'>, words: string[]) => {
  const title = fold(plain(i.title));
  return words.every((w) => title.includes(w) || namesNumber(i.number, w));
};

/** Where a search lists a card it found: 0 one a word names by its number, 1 one with every word in its title, 2 the rest. */
export const rank = (i: Pick<Item, 'title' | 'number'>, words: string[]) => (byNumber(i, words) ? 0 : inTitle(i, words) ? 1 : 2);

/** What a search found, by `rank`, each rank in the given order. */
export const ranked = <T>(found: T[], rankOf: (x: T) => number): T[] =>
  found
    .map((x, n) => ({ x, n, r: rankOf(x) }))
    .sort((a, b) => a.r - b.r || a.n - b.n)
    .map((e) => e.x);

/**
 * What the archive labels an archived card with beside its title, as a key the canvas puts in its
 * owner's words: how an idea or a prototype ended, a stopped task, a card about to become a project,
 * a kind other than a task; none for a plain finished task, nearly every entry.
 */
export type ArchiveLabel = `idea ${Idea['status']}` | `prototype ${NonNullable<Item['prototypeEnd']>}` | 'stopped' | 'becomesProject' | 'taskBecomesProject' | `kind ${Exclude<CardKind, 'task'>}`;

/** Every label the archive gives, for the canvas to say each in its owner's words. */
export const ARCHIVE_LABELS: ArchiveLabel[] = [
  'idea open',
  'idea parked',
  'idea dropped',
  'prototype discarded',
  'prototype built',
  'stopped',
  'becomesProject',
  'taskBecomesProject',
  'kind project',
  'kind question',
];

export function archiveLabel(i: Item): ArchiveLabel | undefined {
  if (i.prototypeEnd) return `prototype ${i.prototypeEnd}`;
  if (i.idea) return `idea ${i.idea.status}`;
  if (stopped(i)) return 'stopped';
  if (i.becomesProject) return i.brief !== undefined ? 'becomesProject' : 'taskBecomesProject';
  return i.kind === 'task' ? undefined : `kind ${i.kind}`;
}
