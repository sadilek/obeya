// The owner's inbox: everything that waits for them, across every canvas, as one list of entries
// the server keeps current and every page shows.

import { type CanvasSnapshot, handedOver, type Item, needsYou, type Question, unreadAnswers } from './types';

/** What an entry waits for. */
export type InboxKind = 'question' | 'demo' | 'review' | 'proposal' | 'superseded' | 'pr' | 'idea' | 'obeya';

export interface InboxEntry {
  canvas: string;
  canvasName: string;
  /** The card that needs the owner; absent for Obeya's answers waiting unread in its sheet. */
  card?: string;
  title: string;
  kind: InboxKind;
  /** The question, the summary or whatever else the card says it waits for (inline markdown). */
  text: string;
  /** Since when it waits (ISO). */
  since: string;
  /** A single question with few options: each is a quick reply. `pick` is the one its agent would choose. */
  options?: string[];
  pick?: string;
  /** A proposal with questions of its own: accepting it takes the owner's answers, so not in one click. */
  asks?: true;
  /** The approval closes the card without a change to the code. */
  noChange?: true;
  /** The approval merges this contributor's pull request. */
  contribution?: number;
}

/** Options that fit as buttons in the list; a longer choice is made on the card. */
export const QUICK_OPTIONS = 4;

/** The one question a card asks with options that can be answered by one click, or none. */
function quick(questions: Question[]): Pick<InboxEntry, 'options' | 'pick'> {
  const q = questions.length === 1 ? questions[0]! : undefined;
  if (!q || q.multiple || q.stuck || !q.options.length || q.options.length > QUICK_OPTIONS) return {};
  const pick = q.pick?.options.length === 1 ? q.pick.options[0] : undefined;
  return { options: q.options, ...(pick && q.options.includes(pick) ? { pick } : {}) };
}

function entry(i: Item): Pick<InboxEntry, 'kind' | 'text'> & Partial<InboxEntry> {
  if (i.superseded) return { kind: 'superseded', text: i.superseded.why ?? '' };
  if (i.state === 'proposal') {
    const q = i.proposal?.questions ?? [];
    return { kind: 'proposal', text: q[0]?.text ?? i.body, ...(q.length ? { asks: true as const } : {}) };
  }
  if (i.state === 'inPr') return { kind: 'pr', text: i.statusLine ?? '' };
  if (i.idea && i.state === 'idea') return { kind: 'idea', text: i.idea.questions[0]?.text ?? i.statusLine ?? '' };
  if (handedOver(i))
    return {
      kind: i.need === 'demo' ? 'demo' : 'review',
      text: i.question?.text ?? i.summary ?? i.statusLine ?? '',
      ...(i.question ? quick([i.question]) : {}),
      ...(i.noChange ? { noChange: true as const } : {}),
      ...(i.contribution ? { contribution: i.contribution.number } : {}),
    };
  return { kind: 'question', text: i.question?.text ?? i.statusLine ?? '', ...(i.question ? quick([i.question]) : {}) };
}

/** What waits for the owner on one canvas, as the list shows it. */
export function inboxOf(canvas: { id: string; name: string }, s: Pick<CanvasSnapshot, 'items' | 'talk'>): InboxEntry[] {
  const here = { canvas: canvas.id, canvasName: canvas.name };
  const now = new Date().toISOString();
  const cards = s.items.filter(needsYou).map((i): InboxEntry => ({ ...here, card: i.id, title: i.title, since: i.waitingSince ?? now, ...entry(i) }));
  const unread = unreadAnswers(s.talk) ? s.talk.filter((x) => x.unread) : [];
  const last = unread.at(-1);
  return last ? [...cards, { ...here, title: '', kind: 'obeya', text: last.answer ?? last.reply ?? last.question ?? last.said, since: last.at }] : cards;
}

/** The entries of every canvas, the one that has waited for the shortest time first. */
export const inboxOrder = (entries: InboxEntry[]): InboxEntry[] => [...entries].sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
