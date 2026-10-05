// A card's conversation, from its events.

import { type CardEvent, formatQuestion, type Question } from '../core/types';

/** One entry of the conversation: a message, with how the agent got to it folded under it, or a small line. */
export interface Turn {
  e: CardEvent;
  /** What led to the message: tool calls, thoughts, status lines, the Koordinator's confirmations. */
  steps: CardEvent[];
  /** A state change or an error between the messages. */
  line?: true;
  /** A worker's question: the answer it got. */
  answer?: string;
  /** A worker's question the owner's note took back instead of an answer. */
  settled?: true;
}

export interface Talk {
  shown: Turn[];
  /** The steps of a turn without a message yet. */
  pending: CardEvent[];
  /** The question the card waits on, with the steps that led to it: it stands at the end, to be answered. */
  asked?: Turn;
}

/** Obeya's lines that mark where the work stands; its other notes (restarts, sessions, what happens on the pull request) fold away. */
const MILESTONE = /^(Agent gestartet|Pull Request gemergt|Nach der Freigabe auf main gelandet|Pull Request ohne Merge geschlossen|Das Projekt steht jetzt)/;

/** What the owner says to the card's agent. */
const toAgent = (e: CardEvent) => (e.kind === 'hint' || e.kind === 'answer' || e.kind === 'talk') && (e.author === 'owner' || e.kind === 'answer');

const place = (e: CardEvent, prev: CardEvent | undefined): 'owner' | 'agent' | 'aside' | 'line' | 'step' => {
  if (toAgent(e)) return 'owner';
  switch (e.kind) {
    case 'talk':
    case 'question':
    case 'review':
      return 'agent';
    case 'say':
      // the Koordinator's confirmation of what the owner just said folds away; what it looked up for them stands
      if (e.author === 'owner') return 'owner';
      return (e.author === 'koordinator' || e.author === 'project') && !(prev?.kind === 'say' && prev.author === 'owner') ? 'aside' : 'step';
    case 'error':
      return 'line';
    case 'state':
      return e.author === 'explorer' || (e.author === 'obeya' && !MILESTONE.test(e.text)) ? 'step' : 'line';
    default:
      return 'step';
  }
};

/**
 * A card's events as its conversation: what the owner says, the agents' replies, questions and
 * handovers, each with the steps that led to it, and the state changes between them. A worker's
 * note that got no `reply` is answered by its last words before the owner's next message, or
 * before the end once it no longer works (`working`). `asking`: the question the card waits on.
 */
export function talkTurns(events: CardEvent[], opts: { asking?: Question; working?: boolean } = {}): Talk {
  const shown: Turn[] = [];
  let steps: CardEvent[] = [];
  // the owner said something to the agent, and the worker has not answered yet
  let open = false;
  const derive = () => {
    if (!open) return;
    const i = steps.findLastIndex((s) => s.kind === 'say' && s.author === 'worker');
    if (i < 0) return;
    shown.push({ e: steps[i]!, steps: steps.slice(0, i) });
    steps = steps.slice(i + 1);
    open = false;
  };
  events.forEach((e, i) => {
    const where = place(e, events[i - 1]);
    if (where === 'step') steps.push(e);
    else if (where === 'line' || where === 'aside') shown.push({ e, steps: [], ...(where === 'line' ? { line: true as const } : {}) });
    else if (where === 'agent') {
      // a turn that ended without a reply took its last words as the reply
      shown.push({ e, steps: steps.filter((s) => !(s.kind === 'say' && s.text === e.text.trim())) });
      steps = [];
      open = false;
    } else {
      // a spoken command that became a note or an answer stands once, as that
      if (e.kind === 'say' && duplicate(events, i)) return;
      derive();
      shown.push({ e, steps: [] });
      if (toAgent(e)) open = true;
    }
  });
  if (!opts.working) derive();
  for (const turn of shown) if (turn.e.kind === 'question') Object.assign(turn, outcome(events, turn.e));
  const asked = opts.asking ? openQuestion(shown, opts.asking) : undefined;
  if (asked) {
    shown.splice(shown.indexOf(asked), 1);
    delete asked.settled;
  }
  return { shown, pending: steps, ...(asked ? { asked } : {}) };
}

/** Whether the owner's words at `i` reached the agent as the note or answer that follows, in the same words. */
function duplicate(events: CardEvent[], i: number): boolean {
  const said = events[i]!.text.trim();
  const next = events.slice(i + 1).find((e) => e.author === 'owner' && (e.kind === 'say' || toAgent(e)));
  return !!next && next.kind !== 'say' && next.text.trim() === said;
}

/** How a question ended: answered, or taken back by a note of the owner's before anything else was asked. */
function outcome(events: CardEvent[], q: CardEvent): Pick<Turn, 'answer' | 'settled'> {
  const after = events.slice(events.indexOf(q) + 1);
  const until = after.findIndex((e) => e.kind === 'question');
  const before = until < 0 ? after : after.slice(0, until);
  const answer = before.find((e) => e.kind === 'answer');
  if (answer) return { answer: answer.text };
  return before.some((e) => e.kind === 'hint' && e.author === 'owner') ? { settled: true } : {};
}

/**
 * The card's last question, if it is the one the card waits on: nothing answered it, and no note
 * took it back (a card from before notes did so still waits on it, in the same words).
 */
function openQuestion(shown: Turn[], asking: Question): Turn | undefined {
  const last = shown.findLast((x) => x.e.kind === 'question');
  if (!last || last.answer !== undefined) return;
  return !last.settled || last.e.text === formatQuestion(asking) ? last : undefined;
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
      .replace(/ \(Mehrfachauswahl\)$/, ''),
    options: lines.slice(n).map((l) => l.slice(2)),
  };
}
