// A card's conversation, from its events.

import { LANGUAGES } from '../core/locale';
import { MESSAGES } from '../core/messages';
import { inQueue } from '../core/queue';
import { answering, askable, type CardEvent, type Demo, finishingUp, type Item, needsYou, openQuestions, ownWords, pausable, type Question, started, type Talk as Exchange } from '../core/types';
import { readAnswer } from './answer';
import type { Field } from './api';

/** One entry of the conversation: a message, with how the agent got to it folded under it, or a small line. */
export interface Turn {
  e: CardEvent;
  /** What led to the message: tool calls, thoughts, status lines, the Koordinator's confirmations. */
  steps: CardEvent[];
  /** A state change or an error between the messages. */
  line?: true;
  /** A worker's question: the answer it got. */
  answer?: string;
  /** A question: the options the owner picked for it, marked on it. */
  picks?: string[];
  /** The owner's answer whose picks its question marks: what the message says beside them, their own words. */
  words?: string;
  /**
   * A question nobody waits on any more that the owner picked nothing for: how it ended (`ended`).
   * `again`: the agent asked it again further down (`next`, that event's id); `settled`: the owner's
   * words after it, which the agent replied to without asking it again; `left`: the owner said
   * nothing to it before the card went on.
   */
  end?: 'again' | 'settled' | 'left';
  /** A question asked again further down: where. */
  next?: number;
  /** Only the agent's steps, without words: a turn it ended silently, in a conversation nobody works on any more. */
  quiet?: true;
  /**
   * A worker's reply: the handover that came next in the same turn, after an earlier one, with the
   * steps that led to it. It says only what changed since that one, so it stands under the reply.
   */
  then?: Turn;
}

export interface Talk {
  shown: Turn[];
  /** The steps of a turn without a message yet. */
  pending: CardEvent[];
  /** What the owner said that the agent has not read yet, in the order said: it stands below its work, until it reads it. */
  unread: CardEvent[];
  /**
   * Obeya's reply to what the agent at work passed on (`to_obeya`), and what Obeya said after it,
   * while no message of the agent's came yet: it stands below the agent's work, until that message.
   */
  passedOn: Turn[];
  /** The questions the card waits on (`openQuestions`), each with the steps that led to it: they stand at the end, to be answered. */
  asked: Turn[];
  /** What came after the last of them, when none of it is the agents': the owner's words the agent read after asking, which stay below the questions. */
  below: Turn[];
}

/** Obeya's lines that mark where the work stands (the demo linked on the pull request among them), or why an idea clicked to build was not; its other notes (restarts, sessions, what happens on the pull request) fold away. */
const MILESTONE =
  /^(Agent gestartet|Agent started|Pull Request gemergt|Pull request merged|Nach der Freigabe auf main gelandet|Landed on main after the approval|Pull Request ohne Merge geschlossen|Pull request closed without a merge|Das Projekt steht jetzt|The project now stands|Nicht gebaut|Not built|Teil gelandet|Part landed|Im Plan-Doc|Ticked off in the plan doc|Den Link zur Demo (als Kommentar|in die Beschreibung)|Commented the demo’s link|Added the demo’s link)/;

/** The agent that works on the card or thinks the idea through. */
const agentAuthor = (e: CardEvent) => e.author === 'worker' || e.author === 'explorer';

/** The agent Obeya looks the owner's questions up with (`answers.ts`): on a card whose own agent it is not, its steps are not that agent's. */
const lookUpAuthor = (e: CardEvent) => e.author === 'koordinator' || e.author === 'project';

/** What the owner says to the card's agent. */
const toAgent = (e: CardEvent) => (e.kind === 'hint' || e.kind === 'answer' || e.kind === 'talk') && (e.author === 'owner' || e.kind === 'answer');

const place = (e: CardEvent, prev: CardEvent | undefined): 'owner' | 'agent' | 'aside' | 'line' | 'step' | 'after' => {
  if (toAgent(e)) return 'owner';
  switch (e.kind) {
    case 'closing':
      return 'after';
    case 'talk':
    case 'question':
    case 'review':
      return 'agent';
    case 'say':
      // the Koordinator's confirmation of what the owner just said folds away; what it looked up for
      // them stands, and so does a reply that answers them without acting (a question of theirs, why
      // it could not read them), and its answer that Obeya cannot do what they asked, with its link to report that
      if (e.author === 'owner') return 'owner';
      if (e.wish || e.reply) return 'aside';
      return (e.author === 'koordinator' || e.author === 'project') && !(prev?.kind === 'say' && prev.author === 'owner') ? 'aside' : 'step';
    case 'error':
    case 'denied':
      return 'line';
    case 'state':
      return e.author === 'explorer' || (e.author === 'obeya' && !MILESTONE.test(e.text) && !limitLine(e) && !wokeLine(e) && !unansweredLine(e)) ? 'step' : 'line';
    default:
      return 'step';
  }
};

/** The handover a demo came with: a later one may keep it. */
export function demoHandover(demo: Demo, shown: Turn[]): Turn | undefined {
  return demo.handover === undefined ? undefined : shown.find((x) => x.e.id === demo.handover || x.then?.e.id === demo.handover);
}

/**
 * A card's events as its conversation, in the order the agent saw them: what the owner says, where
 * the agent read it (`CardEvent.readAfter`), the agents' replies, questions and handovers, each with
 * the steps that led to it (and a worker's closing words after it, which mostly repeat it, with
 * the steps it took between the two), and the
 * state changes between them. The agent's steps before it read the owner's words close above them
 * (`closed`). What the owner says to a worker that does not `reply` is answered by the first words
 * it says after it; words before its reply are steps on the way to it. What the agent has not read yet stands apart (`unread`).
 * `open`: the questions the card waits on, which leave where they were last asked; the others show how they ended (`ended`). `over`: no agent works on the card, so no message will
 * come for the steps without one (`settle`). `paused`: the agent is paused now, at the last line that says so.
 * `working`: the agent is at work, so the owner's last words may still get a question asked again.
 * Obeya's reply to what the agent passed on (`CardEvent.forwarded`) answers one of its steps: it
 * stands under the agent's message those steps lead to, with what Obeya said after it until then
 * (an answer it looked up), unless the owner's words or a line come first (`passedOn`).
 * What Obeya read to look a question up (its steps) is not the agent's work: it folds under the
 * answer it looked up, and while it still looks, under its reply that it does; `answers`: a Question
 * card, whose own agent Obeya's is, so its steps are the card's agent's.
 */
export function talkTurns(all: CardEvent[], opts: { open?: Question[]; over?: boolean; paused?: boolean; working?: boolean; answers?: boolean } = {}): Talk {
  const shown: Turn[] = [];
  let steps: CardEvent[] = [];
  // the owner said something to the agent, and the worker has not answered yet
  let open = false;
  const events = closedBeforeLimit(asRead(all.filter((e) => !e.unread)));
  const lastPause = events.findLast(pauseLine);
  // the usage limit holds at its last line while nothing of the agent's came after it
  const lastLimit = events.findLast(limitLine);
  const limitHolds = !!lastLimit && !events.slice(events.indexOf(lastLimit) + 1).some(agentAuthor);
  // the worker handed over since it started
  let handedOver = false;
  // Obeya's replies to what the agent passed on, held for the agent's next message
  let held: Turn[] = [];
  // the steps of Obeya's look-up, for the answer it looks up
  let looking: CardEvent[] = [];
  // Obeya's reply that it looks the question up, where it stands
  let lookingUnder: Turn | undefined;
  const lookUp = (e: CardEvent) => !opts.answers && e.kind === 'activity' && lookUpAuthor(e);
  const looked = (e: CardEvent) => {
    if (!lookUpAuthor(e)) return [];
    const run = looking;
    looking = [];
    return run;
  };
  const moved = new Set<Turn>();
  const release = () => {
    for (const x of held) moved.add(x);
    shown.push(...held);
    held = [];
  };
  // the agent's last message, past the replies of Obeya's that moved under it
  const lastAgent = () => shown.findLast((x) => !moved.has(x));
  // the agent's steps so far, closed above what comes next
  const close = () => {
    const run = closed(steps);
    if (run) {
      shown.push(run);
      steps = [];
    }
  };
  events.forEach((e, i) => {
    if (started(e)) handedOver = false;
    const where = place(e, events[i - 1]);
    if (where === 'step' && open && e.kind === 'say' && e.author === 'worker' && !repliesLater(events, i)) {
      shown.push({ e, steps });
      steps = [];
      open = false;
      release();
    } else if (where === 'step' && lookUp(e)) {
      if (!looking.length) lookingUnder = [...shown, ...held].at(-1);
      looking.push(e);
    }
    else if (where === 'step') steps.push(e);
    else if (where === 'after') {
      // closing words after a reply or handover fold under it, the last of its steps; so do the
      // steps the agent took after it in the same turn (a card it proposed, say)
      const last = shown.findLast((x) => !x.line && agentAuthor(x.e));
      if (last && last === lastAgent()) {
        (last.then ?? last).steps.push(...steps, e);
        steps = [];
      } else if (last) (last.then ?? last).steps.push(e);
      else steps.push(e);
    }
    else if (where === 'aside' && (e.forwarded || held.length)) held.push({ e, steps: looked(e) });
    else if (where === 'line' || where === 'aside') {
      release();
      // what the agent did until the owner or the usage limit paused it stays above that line once it
      // went on; while it is paused there, its bubble shows it
      if ((pauseLine(e) && !(opts.paused && e === lastPause)) || snoozeLine(e) || (limitLine(e) && !(limitHolds && e === lastLimit))) close();
      shown.push({ e, steps: where === 'aside' ? looked(e) : [], ...(where === 'line' ? { line: true as const } : {}) });
    }
    else if (where === 'agent') {
      const prev = lastAgent();
      // a later handover right after the worker's reply says what changed since the one before: it
      // stands under the reply
      if (e.kind === 'review' && handedOver && prev?.e.kind === 'talk' && prev.e.author === 'worker' && !prev.then) prev.then = { e, steps };
      // a turn that ended without a reply took its last words as the reply
      else {
        const own = steps.filter((s) => !(s.kind === 'say' && s.text === e.text.trim()));
        // Obeya's own message (its answer on a proposal) has its look-up's steps among its steps
        const lookedUp = looked(e);
        shown.push({ e, steps: lookedUp.length ? [...own, ...lookedUp].sort((x, y) => events.indexOf(x) - events.indexOf(y)) : own });
      }
      steps = [];
      open = false;
      if (e.kind === 'review') handedOver = true;
      release();
    } else {
      // a spoken command that became a note or an answer stands once, as that
      if (e.kind === 'say' && duplicate(all, all.indexOf(e))) return;
      if (toAgent(e)) close();
      release();
      shown.push({ e, steps: [] });
      if (toAgent(e)) open = true;
    }
  });
  // a look-up not answered yet: its steps so far under Obeya's reply that it looks it up
  if (looking.length && lookingUnder && !lookingUnder.line && lookUpAuthor(lookingUnder.e)) lookingUnder.steps.push(...looking);
  // while the agent works, they wait below its work for its message; else its steps since stand as one
  let passedOn: Turn[] = [];
  if (opts.working) passedOn = held;
  else if (held.length) {
    if (opts.over) close();
    release();
  }
  // an idea's and a proposal's questions are answered in the owner's words; a worker's on their own
  named(shown);
  for (const turn of shown) if (turn.e.kind === 'question' && !turn.picks) Object.assign(turn, answered(events, turn.e));
  marked(shown);
  const asked = askedLast(shown, opts.open ?? []);
  const at = new Map(events.map((e, i) => [e, i]));
  for (const turn of shown) if (turn.e.kind === 'question' && !asked.includes(turn)) Object.assign(turn, ended(turn, events, at, shown, !!opts.working));
  const below = afterAsking(shown, asked);
  for (const x of [...asked, ...below]) shown.splice(shown.indexOf(x), 1);
  if (opts.over && !asked.length) {
    settle(shown, steps, events);
    steps = [];
  }
  return { shown, pending: steps, passedOn, unread: all.filter((e) => e.unread), asked, below };
}

/**
 * A card's conversation as it shows: the questions it waits on at the end, where they are answered
 * (`openQuestions`, the same on every kind of card), and steps without a message settled once nobody
 * works on it (`past`: nobody does any more).
 */
export function cardTalk(item: Item, events: CardEvent[], past = false): Talk {
  const { working, paused, open } = talkState(item, past);
  return talkTurns(events, { open, over: !working && !paused, paused, working, answers: item.kind === 'question' });
}

/**
 * What a card's conversation is laid out by, beside its log: whether its agent works (it ends with
 * the agent at work), is paused (its steps stand still where it stopped), and the questions open
 * (at the end). `key` changes with any of them.
 */
export function talkState(item: Item, past = false) {
  const working = !past && agentWorks(item);
  const paused = !past && !!item.paused && !item.snoozed;
  const open = past ? [] : openQuestions(item);
  return { working, paused, open, key: JSON.stringify([working, paused, open]) };
}

/** Whether the worker replies after its words at `i`, before the owner says anything more: then those words were a step on the way to the reply. */
function repliesLater(events: CardEvent[], i: number): boolean {
  for (const e of events.slice(i + 1)) {
    if (toAgent(e)) return false;
    if (e.kind === 'talk' && agentAuthor(e)) return true;
  }
  return false;
}

/** The line that the owner paused the card's agent. */
const pauseLine = (e: CardEvent) => e.kind === 'state' && e.author === 'owner' && LANGUAGES.some((l) => e.text === MESSAGES[l].worker.pausedByOwner);

/** The line that the card was snoozed until a time (or its time changed), by its agent or the owner. */
export const snoozeLine = (e: CardEvent) => e.kind === 'state' && (e.author === 'worker' || e.author === 'owner') && LANGUAGES.some((l) => e.text.startsWith(MESSAGES[l].worker.snoozed('\0').split('\0')[0]!));

/** The line that a snoozed card woke, and why (or, until 2026-10-17, who had snoozed it: „Wieder da (vom Agenten zurückgestellt)“). */
const wokeLine = (e: CardEvent) => e.kind === 'state' && LANGUAGES.some((l) => e.text.startsWith(MESSAGES[l].worker.woke('\0').split('\0')[0]!) || e.text.startsWith(`${MESSAGES[l].worker.woke('').replace(/: $/, '')} (`));

/** Obeya's line that the agent stopped without answering the owner's words: they write again. */
const unansweredLine = (e: CardEvent) => e.kind === 'state' && e.author === 'obeya' && LANGUAGES.some((l) => e.text === MESSAGES[l].worker.unanswered);

/** Obeya's line that the usage limit stopped the agent's turn, and when it goes on. */
const limitLine = (e: CardEvent) =>
  e.kind === 'state' &&
  e.author === 'obeya' &&
  LANGUAGES.some((l) =>
    [MESSAGES[l].worker.limitResumes, MESSAGES[l].worker.limitRetries].some((says) => {
      const [before, after] = says('\0').split('\0') as [string, string];
      return e.text.includes(before) && e.text.endsWith(after);
    }),
  );

/** The worker's closing words of a turn the usage limit stopped belong to that turn: Obeya logs them after its line on the limit. */
function closedBeforeLimit(events: CardEvent[]): CardEvent[] {
  if (!events.some(limitLine)) return events;
  const out = [...events];
  for (let i = 1; i < out.length; i++) if (out[i]!.kind === 'closing' && limitLine(out[i - 1]!)) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
  return out;
}

/** The events in the order the agent saw them: the owner's words it read later stand after the line it read them at, in the order said. */
function asRead(events: CardEvent[]): CardEvent[] {
  if (!events.some((e) => e.readAfter)) return events;
  const place = (e: CardEvent) => (e.readAfter ? e.readAfter + 0.5 : e.id);
  return [...events].sort((a, b) => place(a) - place(b) || a.id - b.id);
}

/**
 * The agent's steps before it read the owner's words, closed above them: its last words in them as
 * its message, or, without words, as its steps. Steps only Obeya and the Koordinator noted go on to
 * the next message.
 */
function closed(steps: CardEvent[]): Turn | undefined {
  const words = steps.findLast((s) => s.kind === 'say' && agentAuthor(s));
  if (words) return { e: words, steps: steps.filter((s) => s !== words) };
  const own = steps.find(agentAuthor);
  return own ? { e: own, steps, quiet: true } : undefined;
}

/**
 * Where the open questions were asked, the last time each was, unless something answered it there
 * (on the owner's behalf, say, or options the owner picked that the agent has not taken in, as when a
 * proposal's rework failed: whatever the card says, the answer stays in view): those stand at the
 * end, to be answered.
 */
function askedLast(shown: Turn[], open: Question[]): Turn[] {
  const asked = new Set(open.map((q) => shown.findLast((x) => x.e.kind === 'question' && parseQuestion(x.e.text).text === q.text)));
  return shown.filter((x) => asked.has(x) && x.answer === undefined && !x.picks);
}

/**
 * What stands after the last question the card waits on, when it holds the owner's words and nothing
 * of the agents': words the agent read only after it asked (said while it worked, they reached it
 * with the result of its step that asked). They go to the end with the question, below it, as they were read;
 * above it they would read as words the question already took into account.
 */
function afterAsking(shown: Turn[], asked: Turn[]): Turn[] {
  const last = asked.at(-1);
  if (!last) return [];
  const tail = shown.slice(shown.indexOf(last) + 1);
  return tail.some((x) => toAgent(x.e)) && tail.every((x) => x.line || x.e.author === 'owner') ? tail : [];
}

/**
 * Steps no message came after, in a conversation nobody works on any more, go where they happened,
 * before what came later. Each run of them between two turns ends with the agent's last words in
 * it, as its message; a run without words stands as the agent's steps; what only Obeya and the
 * Koordinator noted there goes.
 */
function settle(shown: Turn[], pending: CardEvent[], events: CardEvent[]) {
  const at = new Map(events.map((e, i) => [e, i]));
  const runs = new Map<number, CardEvent[]>();
  for (const s of pending) {
    const k = shown.findIndex((x) => at.get(x.e)! > at.get(s)!);
    const where = k < 0 ? shown.length : k;
    runs.set(where, [...(runs.get(where) ?? []), s]);
  }
  for (const [where, run] of [...runs].reverse()) {
    const turn = closed(run);
    if (turn) shown.splice(where, 0, turn);
  }
}

/** Whether the owner's words at `i` reached the agent as the note or answer that follows, in the same words. */
function duplicate(events: CardEvent[], i: number): boolean {
  const said = events[i]!.text.trim();
  const next = events.slice(i + 1).find((e) => e.author === 'owner' && (e.kind === 'say' || toAgent(e)));
  return !!next && next.kind !== 'say' && next.text.trim() === said;
}

/** The answer a question got before anything else was asked (only a worker's question is answered on its own). */
function answered(events: CardEvent[], q: CardEvent): Pick<Turn, 'answer' | 'picks'> {
  const after = events.slice(events.indexOf(q) + 1);
  const until = after.findIndex((e) => e.kind === 'question');
  const answer = (until < 0 ? after : after.slice(0, until)).find((e) => e.kind === 'answer');
  return answer ? { answer: answer.text, ...(answer.picks ? { picks: answer.picks } : {}) } : {};
}

/** What the owner says on a card, to its agent or about a proposal (`revise` logs it as their spoken words). */
const ownerSays = (e: CardEvent) => toAgent(e) || (e.kind === 'say' && e.author === 'owner');

/**
 * How a question that nobody waits on any more ended, the same on every kind of card, by what came
 * after it: options picked for it stand ticked (an answer in the owner's own words ticks the options
 * it names); asked again later, it points there; with the owner's words after it, they settled it
 * once the agent replied without asking it again (while the agent still works on that reply, it may
 * yet, so nothing shows); without, it was left open when the card went on (built, taken on, parked,
 * archived). Until 2026-10-21 only a
 * worker's question taken back by a note showed how it ended: an idea's or a proposal's the owner's
 * words passed over stood with its options as if it waited, and one asked again stood twice alike.
 */
function ended(turn: Turn, events: CardEvent[], at: Map<CardEvent, number>, shown: Turn[], working: boolean): Pick<Turn, 'end' | 'next'> {
  const q = parseQuestion(turn.e.text);
  if (turn.picks || (turn.answer !== undefined && q.options.some((o) => turn.answer!.includes(o)))) return {};
  const after = events.slice(at.get(turn.e)! + 1);
  const again = after.find((e) => e.kind === 'question' && parseQuestion(e.text).text === q.text);
  if (again) return { end: 'again', next: again.id };
  // the agent at work is still the one that asked, not a worker started on the idea built or the proposal taken on
  const still = working && !after.some(started);
  const words = after.find(ownerSays);
  if (!words) return still ? {} : { end: 'left' };
  const said = at.get(words)!;
  const replied = shown.some((x) => !x.line && agentAuthor(x.e) && (at.get(x.e) ?? -1) > said);
  return still && !replied ? {} : { end: 'settled' };
}

/**
 * The options an answer picked stand once, marked on the question it answers: its message keeps the
 * owner's own words, and an answer that was nothing but a pick stands as no message of its own.
 */
function marked(shown: Turn[]) {
  for (const q of shown.filter((x) => x.picks && x.answer !== undefined)) {
    const i = shown.findIndex((x, j) => j > shown.indexOf(q) && x.e.kind === 'answer');
    const a = shown[i];
    if (!a?.e.picks) continue;
    a.words = ownWords(a.e);
    if (!a.words && !a.e.images?.length) shown.splice(i, 1);
  }
}

/**
 * The options the owner's words picked for an idea's or a proposal's questions, which they name
 * (`answerText`), stand marked on each question too: the message keeps the owner's own words, and one
 * that was nothing but picks stands as no message of its own. Until 2026-10-20 an idea's questions
 * stood in its conversation only while open, and the picks in the owner's message only.
 */
function named(shown: Turn[]) {
  for (let i = 0; i < shown.length; i++) {
    const a = shown[i]!;
    if (a.line || a.e.author !== 'owner' || a.e.picks || !a.e.text.startsWith('**')) continue;
    // the questions asked so far, the last time each was
    const asked = [...new Map(shown.slice(0, i).filter((x) => x.e.kind === 'question').map((x) => [parseQuestion(x.e.text).text, x])).values()];
    const { picks, words } = readAnswer(a.e.text, asked.map((x) => parseQuestion(x.e.text)));
    if (!picks.length) continue;
    picks.forEach((p, k) => p && (asked[k]!.picks = p));
    a.words = words;
    if (!words && !a.e.images?.length) shown.splice(i--, 1);
  }
}

/** A question as the log holds it (`formatQuestion`): its text and the options after it. */
export function parseQuestion(text: string): { text: string; options: string[] } {
  const lines = text.split('\n');
  let n = lines.length;
  while (n > 1 && lines[n - 1]!.startsWith('– ')) n--;
  return {
    text: lines
      .slice(0, n)
      .join('\n')
      .replace(/ \((Mehrfachauswahl|multiple choice)\)$/, ''),
    options: lines.slice(n).map((l) => l.slice(2)),
  };
}

/**
 * The one field a card has for the owner's words, by its state: the answer to its agent's question,
 * a note while the agent works, feedback on work waiting for review; under a demo whose report asks
 * a question, the answer and feedback together, sorted out by the Koordinator as spoken words are.
 * Null where no agent hears it. Ideas and proposals have fields of their own.
 */
export function ownerField(item: Pick<Item, 'state' | 'need' | 'question' | 'finishing' | 'branch' | 'prototypeOf' | 'archivedAt' | 'queue'>): Field | null {
  if (item.state === 'waiting') return item.need === 'question' ? 'answer' : item.need === 'demo' && item.question ? 'demo' : 'feedback';
  // a finished card's agent is resumed for what the owner asks about it; a card waiting to start holds the note for the agent that takes it on
  return item.state === 'working' || item.state === 'inPr' || item.finishing || askable(item) || inQueue(item) ? 'note' : null;
}

/**
 * A card an agent or Obeya is at (working on it, taking in the owner's words on its handover,
 * landing it, finding it a turn in the queue), and that waits for nobody: the phone's „Läuft“.
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
 * The messages of a card's conversation the owner has not seen: those it shows (`talk`, not the words
 * folded into a message's steps) after the last event they saw (`seen`, an event id), and never those
 * before their own last words, which they wrote having read them. A reply and the handover that follows
 * it in the same message (`then`) count once, as the one message the owner sees. Until 2026-10-17 every
 * word an agent said counted, also those between its tool calls, and a card with two handovers counted
 * 81; until 2026-10-22 such a reply and its handover counted two.
 */
export const unseen = (talk: Talk, events: CardEvent[], seen = -1): number => {
  const turns = new Set(unseenTurns(talk, events, seen));
  return [...talk.shown, ...talk.passedOn].filter((x) => turns.has(x) || (x.then && turns.has(x.then))).length;
};

/** Those messages themselves, a handover that follows its reply in the same message (`then`) on its own. */
export function unseenTurns(talk: Talk, events: CardEvent[], seen = -1): Turn[] {
  const spoke = events.findLast((e) => e.author === 'owner')?.id ?? -1;
  const from = Math.max(seen, spoke);
  const message = (x: Turn) => !x.line && !x.quiet && x.e.author !== 'owner' && x.e.id > from;
  return [...talk.shown, ...talk.passedOn].flatMap((x) => [x, ...(x.then ? [x.then] : [])]).filter(message);
}

/**
 * Whether the card's agent is at work on it, so its conversation ends with the agent at work: an
 * agent working on something, which the owner can pause (`pausable`), or a proposal reworked.
 */
export const agentWorks = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'snoozed' | 'proposal'>) =>
  pausable(i) || (i.state === 'proposal' && !!i.proposal?.revising);

/**
 * Whether the Koordinator still reads what the owner said on the card: their words stand in the log
 * at once, its confirmation follows them. (Options picked on a proposal go to its reviser, which
 * notes when it is done.)
 */
export const koordinatorReads = (events: CardEvent[]) => {
  const last = events.at(-1);
  return last?.kind === 'say' && last.author === 'owner';
};

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
type Laid = Pick<Item, 'state' | 'branch' | 'prototypeEnd' | 'demo' | 'files' | 'pr' | 'landedPart' | 'finishing' | 'brief' | 'prototypes' | 'queue'> & Partial<Pick<Item, 'source'>>;

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
 * A card laid out with its conversation beside what it is about (`Split` in detail.tsx): an idea, a
 * proposal, a task waiting for its first start (its text beside the conversation, where notes wait
 * for its agent), a task an agent worked on once there is a result.
 */
export const split = (i: Laid) => i.state === 'idea' || i.state === 'proposal' || waitsFirstStart(i) || ((!!i.prototypeEnd || worked(i)) && result(i));

/** A task waiting in the queue for its first start: no agent has worked on it yet. */
export const waitsFirstStart = (i: Pick<Item, 'state' | 'branch' | 'landedPart' | 'queue'>) => inQueue(i) && !worked(i);

/** A task an agent works or worked on without a result yet: its conversation stands alone, the card only as wide as it. */
export const talkAlone = (i: Laid) => (!!i.prototypeEnd || worked(i)) && !result(i);

