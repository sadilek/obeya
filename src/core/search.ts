// How a search matches cards, shared by the canvas (the bar's search over the cards on the canvas)
// and the server (the archive's search, which runs where the archive is): every typed word, case and
// accents aside, anywhere in the card's text.

import { plain } from './plain';
import { type CardKind, type Idea, type Item, stopped } from './types';

/** Lower case without accents, so "uber" finds "Über". */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The words of a search, folded. */
export const searchWords = (query: string) => fold(query).split(/\s+/).filter(Boolean);

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

/** Whether the card's title holds every word of the search. */
export const inTitle = (i: Pick<Item, 'title'>, words: string[]) => {
  const title = fold(plain(i.title));
  return words.every((w) => title.includes(w));
};

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
