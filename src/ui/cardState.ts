// What a card's state means for how the page shows it: the owner's field, whether an agent or Obeya
// is at it, the layout beside its conversation, the phone's lists. Predicates over a card that read
// none of its events (those are in talk.ts).

import { holdsNotes } from '../core/queue';
import { answering, askable, finishingUp, type Item, needsYou, openQuestions, pausableNow, type Talk as Exchange } from '../core/types';

/**
 * The one field a card has for the owner's words, by its state: the answer to its agent's question,
 * a note while the agent works, feedback on work waiting for review; under a demo whose report asks
 * a question, the answer and feedback together, sorted out by the Coordinator as spoken words are.
 * Null where no agent hears it. Ideas and proposals have fields of their own.
 */
export function ownerField(item: Pick<Item, 'state' | 'need' | 'question' | 'finishing' | 'branch' | 'prototypeOf' | 'archivedAt' | 'queue'>): 'note' | 'answer' | 'feedback' | 'demo' | null {
  if (item.state === 'waiting') return item.need === 'question' ? 'answer' : item.need === 'demo' && item.question ? 'demo' : 'feedback';
  // a finished card's agent is resumed for what the owner asks about it; a planned card holds the note for the agent that takes it on
  return item.state === 'working' || item.state === 'inPr' || item.finishing || askable(item) || holdsNotes(item) ? 'note' : null;
}

/**
 * A card an agent or Obeya is at (working on it, taking in the owner's words on its handover,
 * landing it, finding it a turn in the queue), and that waits for nobody: the phone's "Running".
 */
export const runs = (i: Item) =>
  !needsYou(i) &&
  !i.snoozed?.waiting &&
  (i.state === 'working' || answering(i) || !!i.finishing || !!i.landing || !!i.queue || (i.state === 'inPr' && !!i.pr) || !!i.idea?.thinking || !!i.thread?.thinking);

/**
 * Whether the phone opens a card with its conversation up: while its agent works on it, what the
 * agent says is what there is to see, and a card that waits for answers to its questions shows them,
 * with options to pick or without. Until 2026-10-19 a question without options opened on the page.
 */
export const opensWithTalk = (i: Item) => (i.state === 'working' && !i.archivedAt) || openQuestions(i).length > 0;

/**
 * Whether the card's agent is at work on it, so its conversation ends with the agent at work: an
 * agent working on something, which the owner can pause (`pausableNow`), or a proposal reworked.
 */
export const agentWorks = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'snoozed' | 'proposal'>) =>
  pausableNow(i) || (i.state === 'proposal' && !!i.proposal?.revising);

/**
 * Whether Obeya's conversation shows it at work: reading the owner's words, or looking a question up
 * (not while the usage limit holds it). Words asked in a project's sheet went straight to its project
 * agent: Obeya never replies to them, only their answer is awaited.
 */
export const obeyaWorks = (talk: Exchange[]) =>
  talk.some((x) => (x.reply === undefined && !x.heldUntil && !x.askedIn) || (x.question !== undefined && x.answer === undefined && !x.movedTo && !x.limitedUntil));

/**
 * A task an agent has worked on, stopped ones included: what came of it stands beside its
 * conversation. A workstream planned again after a part of it landed has no branch until its rest
 * starts, and still shows what landed.
 */
export const worked = (i: Pick<Item, 'state' | 'branch' | 'landedPart'>) => i.state !== 'idea' && i.state !== 'proposal' && (!!i.branch || !!i.landedPart);

/** What decides a card's layout. */
type Laid = Pick<Item, 'state' | 'branch' | 'prototypeEnd' | 'demo' | 'files' | 'pr' | 'landedPart' | 'finishing' | 'brief' | 'prototypes' | 'queue'> & Partial<Pick<Item, 'source' | 'id' | 'archivedAt'>>;

/**
 * What a task an agent worked on shows beside its conversation: a demo, the files it named as the
 * result (or, in a folder, the files it changed there), a pull request, what landed, what remains
 * after the landing, a decided idea's brief, a workstream's text in its plan doc.
 */
export const result = (i: Laid) =>
  !!i.demo ||
  !!i.files ||
  i.state === 'inPr' ||
  (!!i.pr && i.state === 'waiting') ||
  !!i.landedPart ||
  finishingUp(i) ||
  (i.brief !== undefined && (!!i.brief.trim() || !!i.prototypes?.length)) ||
  i.source === 'plan';

/**
 * A card laid out with its conversation beside what it is about (`Split` in conversation.tsx): an idea, a
 * proposal, a task waiting for its first start (its text beside the conversation, where notes wait
 * for its agent), a task an agent worked on once there is a result.
 */
export const split = (i: Laid) => i.state === 'idea' || i.state === 'proposal' || waitsFirstStart(i) || ((!!i.prototypeEnd || worked(i)) && result(i));

/**
 * A task no agent has worked on yet, planned or in the queue: its text stands beside its
 * conversation, where notes wait for the agent that takes it on. Not while the owner writes a card
 * they have just created (`beingWritten`) and has not started yet: its text alone, so the task goes
 * into the text, not into a note.
 */
export const waitsFirstStart = (i: Pick<Item, 'state' | 'branch' | 'landedPart' | 'queue'> & Partial<Pick<Item, 'id' | 'archivedAt'>>) =>
  holdsNotes(i) && !worked(i) && (!!i.queue || !(i.id && beingWritten.has(i.id)));

/** The cards created on this page that have stayed open since: the owner is writing their task. */
export const beingWritten = new Set<string>();

/** A task an agent works or worked on without a result yet: its conversation stands alone, the card only as wide as it. */
export const talkAlone = (i: Laid) => (!!i.prototypeEnd || worked(i)) && !result(i);
