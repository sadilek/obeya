// The message a field's words reply to, as in chat apps: the field under a card's conversation or
// in Obeya's sheet shows it as a quote, and what the owner types or says next goes with it. It is
// part of the field's draft (`draft.ts`), so it outlives closing the card and a page load.

import type { CardEvent, TalkQuote, TalkRef } from '../core/types';
import { draftOf, updateDraft, useDraft } from './draft';
import { plain } from './markdown';
import { parseQuestion } from '../core/card';
import { oneLine } from '../core/text';

/** A message as a quote shows it: who said it, what it was, its text, and where it stands in the conversation (`data-ev`). */
export interface Quoted {
  by: CardEvent['author'];
  what?: 'question' | 'handover';
  text: string;
  ev: string;
}

/** A reply: the message it goes to, as the server knows it (a card's event, or a message of the sheet), and its quote. */
export interface Reply {
  to: number | TalkRef;
  quote: Quoted;
}

/** As much of a message as a quote keeps: it shows a few lines. */
const KEPT = 400;
const clean = (md: string) => oneLine(plain(md)).slice(0, KEPT);

/** A message of a card's conversation as a quote: the owner's also for an answer given in their name. */
export const eventQuote = (e: CardEvent): Quoted => ({
  by: e.author === 'owner' || e.kind === 'answer' ? 'owner' : e.author,
  ...(e.kind === 'question' ? { what: 'question' as const } : e.kind === 'review' ? { what: 'handover' as const } : {}),
  text: clean(e.kind === 'question' ? parseQuestion(e.text).text : e.text),
  ev: String(e.id),
});

/** Where a message of the sheet stands in it (`data-ev`). */
export const talkEv = (r: TalkRef) => `t${r.talk}.${r.part}`;

/** A message of the sheet as a quote. */
export const talkQuote = (q: TalkQuote): Quoted => ({ by: q.by, text: clean(q.text), ev: talkEv(q) });

/** Replies with the field's words to the message, or with null to none. */
export const setReply = (draft: string, r: Reply | null) => {
  if (draftOf(draft).reply !== (r ?? undefined)) updateDraft(draft, { reply: r ?? undefined });
};

/** The message the field's words reply to, if any. */
export const replyOn = (draft: string): Reply | null => draftOf(draft).reply ?? null;

/** The same, live. */
export const useReply = (draft: string): Reply | null => useDraft(draft).reply ?? null;
