// What a card is in: the predicates over a card and its log that the server and the UI ask alike.

import { type Language, LANGUAGES } from './locale';
import { MESSAGES, type Messages } from './messages';
import type { Awaited, AwaitedState, CanvasSnapshot, CardEvent, CardState, Demo, Item, Question, Talk } from './types';

/** A card whose work is over: `live` once it landed, `done` when it needed no change to the code (a demo, an analysis). */
export const finished = (s: CardState) => s === 'live' || s === 'done';
/**
 * A card whose work is on the main branch: finished, or landed there while the card is in a pull
 * request in another repository that the work also needed (`Item.onMain`). What waits for the card
 * to land waits no longer.
 */
export const landedWork = (i: Pick<Item, 'state' | 'onMain'>) => finished(i.state) || !!i.onMain;
/** A card an agent worked on until the owner stopped it: planned again, its branch stays the card's. */
export const stopped = (i: Pick<Item, 'state' | 'branch' | 'unstarted'>) => i.state === 'planned' && !!i.branch && !i.unstarted;
/** A finished card of the owner's whose agent is done: the archive may take it. */
export const finishedArchivable = (i: Pick<Item, 'state' | 'source' | 'finishing'>) => finished(i.state) && i.source === 'manual' && !i.finishing;
/** Why the archive does not take a card (`archiveRefusal`), as the server's refusal names it. */
export type ArchiveRefusal = 'notDone' | 'holdsWork' | 'prototypeRunning' | 'planCard';
/**
 * Why the archive does not take the card; nothing where it does. It takes a finished card of the
 * owner's whose agent is done; a parked or dropped idea without a prototype on the canvas; a project
 * whose work is done; and a stopped task of the owner's that nothing waits to start, whose workspace
 * holds no work (a branch with commits or changes keeps it, and archiving would leave that work
 * unseen in a clone) or whose repository does not run on the canvas, where nothing shows that work
 * anyway. A workstream stays with its project.
 */
export function archiveRefusal(
  i: Pick<Item, 'kind' | 'state' | 'source' | 'idea' | 'prototypes' | 'branch' | 'unstarted' | 'prototypeOf' | 'queue' | 'workspace' | 'keptIn' | 'repoDown' | 'finishing'>,
): ArchiveRefusal | undefined {
  if (i.kind === 'project') return i.state === 'done' ? undefined : 'notDone';
  if (i.source === 'plan') return 'planCard';
  if (i.state === 'idea') return (i.idea?.status ?? 'open') === 'open' ? 'notDone' : i.prototypes?.some((p) => !p.archivedAt) ? 'prototypeRunning' : undefined;
  if (stopped(i) && i.kind === 'task' && !i.prototypeOf) return i.queue ? 'notDone' : (i.workspace || i.keptIn) && !i.repoDown ? 'holdsWork' : undefined;
  return finishedArchivable(i) ? undefined : 'notDone';
}
/**
 * A card the canvas's "Archive finished cards" takes, and so counts on its button: a finished one the
 * archive may take, but no Question card, which is done when the owner says so, not with the work;
 * and a project whose work is done.
 */
export const archivedWithDone = (i: Pick<Item, 'state' | 'source' | 'finishing' | 'kind'>) =>
  (finishedArchivable(i) && i.kind !== 'question') || (i.kind === 'project' && i.state === 'done');
/** A finished card whose agent still works: after the landing, or answering a follow-up question. */
export const finishingUp = (i: Pick<Item, 'state' | 'finishing'>) => !!i.finishing && finished(i.state);
/** The card's agent is snoozed (by itself or the owner, "Later …"): it stops until its time, and neither pauses nor resumes meanwhile. */
const snoozedAway = (i: Pick<Item, 'snoozed'>) => !!i.snoozed && !i.snoozed.waiting;

/** The card's agent runs a turn the owner can pause at once (the pause on the bubble of its turn), also while it is about to pause at a safe point. */
export const pausableNow = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'snoozed'>) =>
  !i.paused && !snoozedAway(i) && (i.kind === 'question' ? !!i.thread?.thinking : i.state === 'idea' && i.idea ? i.idea.thinking : !!i.inTurn);

/** The card's agent is at work and can be paused, at a safe point (the card's pause, the canvas's) or at once; not one about to pause already. */
export const pausable = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'pausing' | 'snoozed'>) => !i.pausing && pausableNow(i);

/** The owner paused the card's agent, and it waits for them to resume it; a snoozed one, which holds what comes for it as a paused one does, waits for its time instead. */
export const resumable = (i: Pick<Item, 'paused' | 'snoozed'>) => !!i.paused && !snoozedAway(i);

/** The card's agent is paused, or about to pause at a safe point: what the card's ▶ and the canvas's resume let go on. */
export const halted = (i: Pick<Item, 'paused' | 'pausing' | 'snoozed'>) => (!!i.paused || !!i.pausing) && !snoozedAway(i);

/**
 * A finished card an agent worked on, on the canvas, with no agent on it now: what the owner asks
 * about it resumes the agent that did the work, which answers and ends again.
 */
export const askable = (i: Pick<Item, 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  finished(i.state) && !!i.branch && !i.prototypeOf && !i.archivedAt && !i.finishing;

/**
 * How many cards of each group are still to be done: not finished, not archived, not a dropped
 * idea. A project counts by its workstreams, not as a card of its own.
 */
export function openPerGroup(items: Item[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const i of items)
    if (i.group && i.kind === 'task' && !finished(i.state) && !i.archivedAt && i.idea?.status !== 'dropped') open.set(i.group, (open.get(i.group) ?? 0) + 1);
  return open;
}

/** A workstream a prototype can be built for: nobody has worked on it yet, and the Coordinator does not hold it. */
export const buildableOn = (i: Item) => i.state === 'planned' && !i.branch && !i.queue;

/**
 * A planned task nobody has worked on yet, which the Coordinator may merge with others or delete:
 * no branch, no workspace, not with the Coordinator unless it waits there behind other cards (a
 * review's follow-up task waiting for the PR's merge, say), and no prototype nor becoming a project.
 */
export const untouched = (i: Item) =>
  i.kind === 'task' && i.source === 'manual' && i.state === 'planned' && !i.branch && !i.workspace && (!i.queue || 'behind' in i.queue) && !i.prototypeOf && !i.becomesProject;

/**
 * A task of the owner's that can still be planned as a project, as an idea can: planned, nobody has
 * worked on it, the Coordinator does not hold it, and it is no prototype nor decided as a project already.
 */
export const plannableAsProject = (i: Item) =>
  i.source === 'manual' && i.kind === 'task' && buildableOn(i) && !i.prototypeOf && !i.becomesProject;

/** A question as its card's log holds it: the text, then one line per option. */
export const formatQuestion = (q: Question, language: Language): string =>
  q.options.length ? `${q.text}${q.multiple ? ` (${MESSAGES[language].multiple})` : ''}\n${q.options.map((o) => `– ${o}`).join('\n')}` : q.text;

/** A question as the log holds it (`formatQuestion`), in whichever language it was written: its text and the options after it. */
export function parseQuestion(text: string): { text: string; options: string[] } {
  const lines = text.split('\n');
  let n = lines.length;
  while (n > 1 && lines[n - 1]!.startsWith('– ')) n--;
  const asked = lines.slice(0, n).join('\n');
  const marker = LANGUAGES.map((l) => ` (${MESSAGES[l].multiple})`).find((m) => asked.endsWith(m));
  return { text: marker ? asked.slice(0, -marker.length) : asked, options: lines.slice(n).map((l) => l.slice(2)) };
}

/** Stands for any text in a message of the table, for `lineOf`: `(m) => m.worker.started(ANY)`. */
export const ANY = '\0' as never;

/**
 * Recognises the lines that messages of the table (`MESSAGES`) write, in every language, by their
 * words: a line is one when it starts as a message `pick` gives, `ANY` in it standing for any text,
 * up to its last words (what a message ends with after its last `ANY` may have grown since older
 * lines were written: a link after the sentence). A log line carries its meaning only in its text,
 * in the language it was written in.
 */
export function lineOf(...picks: ((m: Messages) => string)[]): (text: string) => boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = (says: string) => {
    const parts = says.split(ANY);
    while (parts.length > 1 && !parts.at(-1)!.trim()) parts.pop();
    parts.push(parts.pop()!.trimEnd());
    return new RegExp(`^${parts.map(escape).join('.*?')}`, 's');
  };
  const patterns = [...new Set(LANGUAGES.flatMap((l) => picks.map((pick) => pick(MESSAGES[l]))))].map(pattern);
  return (text) => patterns.some((p) => p.test(text));
}

/** Its worker handed the work over: the card waits for the owner's approval or feedback. */
export const handedOver = (i: Pick<Item, 'state' | 'need'>) => i.state === 'waiting' && (i.need === 'demo' || i.need === 'review');

/** Its worker takes in the owner's words on its handover: meanwhile the card is at work, and still waits for approval. */
export const answering = (i: Pick<Item, 'state' | 'need' | 'answering'>) => handedOver(i) && !!i.answering;

/**
 * Whether an agent hears what the owner says or types on the card when it is open: its worker (at
 * work, waiting, in a pull request, finishing after the landing, or one a question resumes on a
 * finished card), an idea's exploration agent, or the agent that reworks a proposal (while it
 * does, the words wait for the rework after it). The words then go straight to it; on any other
 * card they go to the Coordinator.
 */
export const agentListens = (i: Pick<Item, 'kind' | 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  !i.archivedAt && (i.kind === 'question' || i.state === 'idea' || i.state === 'proposal' || i.state === 'working' || i.state === 'waiting' || i.state === 'inPr' || !!i.finishing || askable(i));

/**
 * A card the owner left without a title but with a task (text or screenshots): Obeya names it from
 * that (`Coordinator.name`). Without either it is an empty card, dropped when closed.
 */
export const nameless = (i: Pick<Item, 'kind' | 'title' | 'body' | 'images'>) => i.kind !== 'project' && !i.title.trim() && (!!i.body.trim() || !!i.images?.length);

/** A title from a task's first words, on a card not named yet, and when Obeya's naming fails. */
export function titleFrom(body: string): string {
  const line = body.trim().split('\n')[0]!.trim();
  if (line.length <= 70) return line;
  const cut = line.slice(0, 70);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 70)}…`;
}

/**
 * The questions on a card that wait for the owner's answer: its idea agent's while the idea is open
 * and the agent is not at work on a reply (which may settle them), its proposal's while it is not
 * reworked, its worker's, its demo report's. The one place where each kind of card says which of its
 * questions are open: its conversation shows them at its end with the field under it set to answer
 * them, the canvas card and the phone's count show them, the Coordinator hears of them.
 */
export function openQuestions(i: Pick<Item, 'archivedAt' | 'state' | 'need' | 'question' | 'idea' | 'proposal'>): Question[] {
  if (i.archivedAt) return [];
  if (i.state === 'idea') return i.idea?.status === 'open' && !i.idea.thinking ? i.idea.questions : [];
  if (i.state === 'proposal') return i.proposal && !i.proposal.revising ? i.proposal.questions : [];
  return i.state === 'waiting' && (i.need === 'question' || i.need === 'demo') && i.question ? [i.question] : [];
}

/**
 * A card needs the owner: it waits (but not while its worker takes in what the owner wrote on its
 * handover, nor once they approved it and its work lands), is a proposal or an accepted one its agent withdrew or
 * replaced since, has a pull request that only waits for the owner's merge, or is an open idea whose agent has replied
 * and is done.
 */
export const needsYou = (i: Item) =>
  !i.snoozed &&
  ((i.state === 'waiting' && !answering(i) && !i.landing) || (i.state === 'proposal' && !i.proposal?.revising) || !!i.superseded || (i.state === 'inPr' && [i.pr, ...(i.morePrs ?? [])].some((p) => p?.ready && !p.merged && !p.closed)) || (!!i.idea && i.idea.status === 'open' && i.idea.yourTurn && !i.idea.thinking));

/**
 * Whether the card a snoozed worker waits on gets it to wake: `reached` the state it waits for;
 * `gone`, `archived`, `stopped` (planned again by the owner), `dropped` (an idea let go) when it no
 * longer gets there by itself; null while it may still.
 */
export function awaited(card: Item | undefined, state: AwaitedState): Awaited | null {
  if (!card) return 'gone';
  if (finished(card.state) || (state === 'waitsForOwner' && needsYou({ ...card, snoozed: undefined }))) return 'reached';
  if (card.archivedAt) return 'archived';
  if (stopped(card)) return 'stopped';
  if (card.idea?.status === 'dropped') return 'dropped';
  return null;
}

/** A worker on the card is at work (whether or not in a turn right now): it has started on the card, opens or follows its pull request, finishes after the landing, or takes in the owner's words on its handover. */
const workerAtWork = (i: Item) => i.kind === 'task' && (i.state === 'working' || i.state === 'inPr' || !!i.finishing || answering(i));

/** A task planned and not with the Coordinator: snoozed, it starts at the time instead of now. */
export const plannedToStart = (i: Pick<Item, 'kind' | 'state' | 'queue' | 'archivedAt'>) => i.kind === 'task' && i.state === 'planned' && !i.queue && !i.archivedAt;

/**
 * A card the owner can snooze until a point in time ("Later …"): one at work (its worker stops
 * until then, as on a pause), one that waits for them (it leaves them until then), or one planned
 * (it starts then); a snoozed card's time can be changed.
 */
export const snoozable = (i: Item) => !i.archivedAt && (!!i.snoozed || needsYou(i) || workerAtWork(i) || plannedToStart(i));

/**
 * A review card the owner can set aside until its contributor writes on the pull request or pushes
 * ("Until amerlander responds" in "Later …"): it is handed over (whether snoozed until a time
 * meanwhile or not), and not snoozed so already.
 */
export const awaitsContributorNext = (i: Item) => !!i.contribution && !i.archivedAt && handedOver(i) && !answering(i) && !i.landing && !i.snoozed?.contributor && (!i.snoozed || !!i.snoozed.waiting);

/** Answers in the Coordinator's sheet the owner has not seen yet. */
export const unreadAnswers = (talk: Talk[]) => talk.filter((x) => x.unread).length;

/** Per project, its agent's answers to what the owner asked in its sheet that wait unread: its card shows them. */
export function unreadPerProject(talk: Talk[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of talk) if (x.unread && x.askedIn) m.set(x.askedIn, (m.get(x.askedIn) ?? 0) + 1);
  return m;
}

/** What on a canvas waits for the owner: the cards that need them, and the Coordinator while an answer waits unread. */
export const waitingOn = (s: Pick<CanvasSnapshot, 'items' | 'talk'>) => s.items.filter(needsYou).length + (unreadAnswers(s.talk) ? 1 : 0);

/**
 * What of a canvas "Needs you" lists (the phone's, and the navigation on every other canvas's page):
 * the cards that need the owner (none snoozed, which are put off), and the Coordinator's answers that
 * wait unread.
 */
export type Waiting = Pick<CanvasSnapshot, 'items' | 'talk'>;
export const waitingIn = (s: Pick<CanvasSnapshot, 'items' | 'talk'>): Waiting => ({
  items: s.items.filter(needsYou),
  talk: s.talk.filter((x) => x.unread),
});

/**
 * Who wrote a card's task: the owner (also through the Coordinator, from their words), the plan doc
 * of its workstream, Obeya (the work retrospective), the idea a prototype is for, or a worker whose
 * proposal the owner accepted. A decided idea's task is its brief, the idea's agent's.
 */
export type TaskAuthor = 'owner' | 'plan' | 'coordinator' | 'idea' | 'proposal';

export const taskAuthor = (item: Pick<Item, 'source' | 'prototypeOf' | 'retro' | 'proposed' | 'brief'>): TaskAuthor =>
  item.source === 'plan' ? 'plan' : item.prototypeOf || item.brief !== undefined ? 'idea' : item.retro ? 'coordinator' : item.proposed ? 'proposal' : 'owner';

/** A year: no card is snoozed longer, nor set to start later than that. */
const SNOOZE_LIMIT = 366 * 24 * 60 * 60_000;

/** Whether a card can be snoozed until or set to start at `at` (ms; NaN: no time): only within the coming year. */
export function laterTime(at: number, now = Date.now()): 'none' | 'past' | 'far' | 'ok' {
  if (Number.isNaN(at)) return 'none';
  if (at <= now) return 'past';
  return at > now + SNOOZE_LIMIT ? 'far' : 'ok';
}

/**
 * What goes on a shared page with the card's demo `i` (of its demos, the oldest first): that demo
 * and, while one supplements the demo before it (`follows`), that one too, the oldest first. A page
 * never shows a supplement without what it supplements.
 */
export function withSupplemented<T extends Pick<Demo, 'follows'>>(demos: T[], i: number): T[] {
  let first = i;
  while (first > 0 && demos[first]!.follows === 'supplements') first--;
  return demos.slice(first, i + 1);
}

/** Which of the demo's chapters plays at `at` seconds (the first before any starts); a seek lands a little before a chapter's start. */
export const chapterAt = (chapters: Demo['chapters'], at: number) => chapters.reduce((cur, [start], i) => (start <= at + 0.05 ? i : cur), 0);

const startedLine = lineOf(
  (m) => m.worker.started(ANY),
  (m) => m.worker.reviewStarted(ANY, ANY),
  (m) => m.worker.startedInFolder,
  // the wording until 2026-10-06, which older logs hold: „Agent gestartet: <branch> in <path>“
  () => 'Agent gestartet: ',
);

/** Obeya's line that a worker started on the card afresh: what it handed over before belongs to an earlier run. */
export const started = (e: Pick<CardEvent, 'kind' | 'author' | 'text'>) => e.kind === 'state' && e.author === 'obeya' && startedLine(e.text);

/** The owner's own words in an answer, without the options picked that lead it. */
export function ownWords(e: Pick<CardEvent, 'text' | 'picks'>): string {
  const lead = e.picks?.join(', ');
  return lead && e.text.startsWith(lead) ? e.text.slice(lead.length).trim() : e.text;
}
