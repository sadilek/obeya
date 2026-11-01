// Spoken (or typed) commands: the Koordinator reads what the owner said as one or more actions,
// confirms them in one sentence, and runs them after a short delay unless the owner takes them back.

import { z } from 'zod';
import { type AgentSetting, agentListens, answering, askable, type Awaited, awaited, type AwaitedState, blocksSaving, type CanvasConfig, finished, handedOver, type Item, type NextStep, type Notice, openQuestions, pausableNow, plannableAsProject, halted, untouched, prototypeWorkstream, snoozable, SNOOZE_LIMIT, type Queue, type SpotInput, type Talk, type TalkAfter, type TalkQuote, type TalkRef } from '../core/types';
import { holdsNotes, notStarted } from '../core/queue';
import { answerTag, fromAnswerTag } from './answers';
import { BadRequest, type Board, excerpt, replyNote } from './board';
import type { Place } from '../core/layout';
import { type Config, configShape } from './config';
import { parsePrUrl } from './forge';
import { folderPath } from './new-repo';
import type { Mark, Moment, TalkWaitRow } from './db';
import { type AgentRuntime, type AgentSession, failureReason, limitLifts } from './runtime';
import { type Language, LANGUAGES, ownersLanguage } from '../core/locale';
import { MESSAGES } from '../core/messages';
import { clip, oneLine, messageOf } from '../core/text';
import type { Wish } from '../core/wish';

export type Command = (
  /**
   * `from`: the card it follows up on; `place`: where the owner was on the canvas, for one without;
   * `until` (ISO): it is planned and starts by itself then, as a planned card the owner snoozed.
   */
  /** `canvas`: another canvas of this Obeya, where the card goes instead (into its home repository). */
  | { do: 'newCard'; title: string; body: string; start: boolean; until?: string; repo?: string; from?: string; place?: Place; canvas?: string }
  | { do: 'newIdea'; title: string; body: string; repo?: string; place?: Place; canvas?: string }
  /**
   * An idea is built, or a planned task started, in a repository that does not exist yet, at `path`:
   * with a canvas of its own (`canvas`), or on this one.
   */
  | { do: 'newRepo'; card: string; path: string; canvas: boolean }
  /**
   * A review card for someone outside's pull request (`pr`: its number in the repository, or its
   * URL), started; `text`: what the owner added for the review. Where the PR has a card, that one
   * opens instead and its worker gets the text.
   */
  | { do: 'reviewPr'; pr: string; text: string; repo?: string; spoken?: boolean; place?: Place }
  /** `force` starts a card that waits behind others now, despite the likely merge conflict. */
  | { do: 'start' | 'force' | 'approve' | 'dequeue' | 'dismiss' | 'keep' | 'stop' | 'pause' | 'resume' | 'wake' | 'build' | 'splitOff' | 'planDoc' | 'park' | 'drop'; card: string }
  /** Set aside until `until` (ISO), or a snoozed card's time changed. */
  | { do: 'snooze'; card: string; until: string }
  /** `idea`: a proposed task is taken as an idea to discuss first. */
  | { do: 'accept'; card: string; idea?: boolean }
  /** On a prototype: build its idea on it (or `workstream`, of the project the idea became), or throw it away. */
  | { do: 'buildPrototype'; card: string; workstream?: string }
  | { do: 'discard'; card: string }
  /** `spoken`: the words came through speech recognition (the default), not typed. */
  /** `revise`: the owner's words on a proposal, which an agent reworks it by. */
  | { do: 'note' | 'answer' | 'feedback' | 'discuss' | 'prototype' | 'revise'; card: string; text: string; spoken?: boolean }
  /** Saves Obeya's configuration, which then starts again with it. */
  | { do: 'configure'; canvases: CanvasConfig[] }
  /**
   * Records a rule every agent follows, active at once, or with `repos` files it for those
   * repositories' CLAUDE.md; `replaces`: the rule (id) it changes, `card`: the card open when the owner said it.
   */
  | { do: 'remember'; text: string; replaces?: number; card?: string; repos?: string[] }
  /** Runs the Arbeitsrückschau of a repository now. */
  | { do: 'workRetro'; repo: string }
  /** Puts the cards into the group of that name, a new one when the canvas has none of that name. */
  | { do: 'group'; cards: string[]; name: string }
  | { do: 'ungroup'; cards: string[] }
  | { do: 'renameGroup'; group: string; name: string }
  /**
   * The Koordinator waits until the card is done or waits for the owner, and then takes the step
   * `then`; `newCard`: instead of `card`, the card of that title a new card action of the same command creates.
   */
  | { do: 'waitFor'; card?: string; newCard?: string; state: AwaitedState; then: string }
  /** It no longer waits on the card. */
  | { do: 'stopWaiting'; card: string }
  /** Planned tasks nobody has worked on (`others`) merged into `card`, which stays, titled `title`; the others go. */
  | { do: 'merge'; card: string; others: string[]; title: string }
  /** A planned task nobody has worked on, deleted. */
  | { do: 'delete'; card: string }
) & {
  /** Screenshots that came with the command (image ids), on the actions that take them (`TAKES_IMAGES`). */
  images?: string[];
};

/**
 * Actions whose words reach the learner on their own way (a note, an idea's discussion) or are a
 * rule already: a command with one of them is not offered for learning again.
 */
const LEARNED: Command['do'][] = ['note', 'answer', 'feedback', 'discuss', 'newIdea', 'remember'];

/** An idea's suggested next step, as the Koordinator reads it: the action it would take, or answering the questions. */
const NEXT_ACTION: Record<NextStep['step'], string> = {
  answer: 'have the owner answer its open questions (discuss)',
  build: 'build',
  splitOff: 'split_off',
  planDoc: 'plan_doc',
  prototype: 'prototype',
  park: 'park',
  drop: 'drop',
};

/** The questions the card waits on, as every kind of card has them (`openQuestions`): each with what its agent would pick. */
const asks = (i: Item) => {
  const open = openQuestions(i);
  const each = open.map((q) => `"${clip(oneLine(q.text), 600)}"${q.pick ? ` (its agent would pick: ${q.pick.options.join(', ')})` : ''}`);
  return open.length ? ` — open question${open.length > 1 ? 's' : ''}${i.state === 'waiting' && i.need === 'demo' ? ' in its demo report' : ''}: ${each.join(' | ')}` : '';
};

/** The actions a command's screenshots go with: those that create a card, start one or say something to its agent. */
const TAKES_IMAGES: Command['do'][] = ['newCard', 'newIdea', 'start', 'force', 'note', 'answer', 'feedback', 'discuss', 'revise'];

/** Actions whose text goes to an agent: a card's, or the one that reworks a proposal. */
const TO_AGENT: Command['do'][] = ['note', 'answer', 'feedback', 'discuss', 'revise'];

export interface Heard {
  /** What the owner reads back. */
  confirm: string;
  /** Takes the actions back while they wait; absent when there was nothing to do. */
  token?: string;
  /** Said to the agent of the card the owner has open: it went straight there and stands in the card's conversation, which is confirmation enough. */
  quiet?: boolean;
  /** The owner asked to tell Obeya's makers something: the page opens the draft for them with it. */
  wish?: Wish;
  /** The reply says Obeya cannot do what the owner asked: a link under it offers to report that as a wish. */
  cannot?: true;
  /** The exchange of Obeya's sheet the reply stands in (none with a card open): a page that shows the sheet needs no line above the microphone. */
  talk?: number;
}

export interface Focus {
  card?: string;
  project?: string;
  /** Where on the canvas the owner was: a new card goes there. */
  place?: Place;
}

/** The field on the open card a typed command came from. */
export type Field = 'note' | 'answer' | 'feedback' | 'demo' | 'discuss' | 'revise';
const FIELDS: Record<Field, string> = {
  note: "the field for a note to the card's agent",
  answer: "the field for an answer to the card's open question",
  feedback: "the field for feedback on the card's work",
  demo: "the one field under the card's demo, for the answer to the question in its report, feedback on the work, or both",
  discuss: "the idea's conversation",
  revise: 'the field for what should change in the proposal',
};
export const isField = (f: unknown): f is Field => typeof f === 'string' && f in FIELDS;

/**
 * How the owner gave a command: spoken (the default) or typed, and then in which field of the open
 * card; `forwarded`: the request the open card's agent passed on from the owner's words to it.
 */
export interface Input {
  typed?: boolean;
  field?: Field;
  forwarded?: string;
  /** The owner's words beside a forwarded request are the card's task, which the owner gave: they said nothing on the card since. */
  task?: boolean;
  /** The message of the open card's conversation the words reply to, or with no card open the message of the sheet (`TalkRef`). */
  replyTo?: number | TalkRef;
  /** The place in the open card's demo video the words are about; only its agent hears of it. */
  spot?: SpotInput;
  /** When the owner said the words, read only now since the usage limit held them (ISO time). */
  heldSince?: string;
  /** No words: a card the Koordinator waited on got there (or no longer can), and it takes up the step it said it would take then. */
  after?: AfterWait;
  /** No words: the answer the Koordinator looked up for an action is in, and it takes up the step it said it would take with it. */
  answered?: AfterAnswer;
}

/** The step the Koordinator takes up once the answer it looked up is in: the exchange that asked, its answer, and the step. */
export interface AfterAnswer {
  from: number;
  question: string;
  answer: string;
  then: string;
  /** The owner's words and the Koordinator's reply that said it would look it up, and when. */
  said: string;
  promised: string;
  at: string;
}

/** The step the Koordinator takes up once the card it waited on got there: what it was, and the exchange it said so in. */
export interface AfterWait extends TalkAfter {
  card: string;
  then: string;
  /** The owner's words and the Koordinator's reply that said it would wait, and when. */
  said: string;
  promised: string;
  at: string;
}

export interface CommanderOptions {
  board: Board;
  runtime: AgentRuntime;
  cwd: string;
  /** Runs a command; what it throws is logged on the card. */
  execute: (c: Command) => unknown | Promise<unknown>;
  /** How long a command waits for "Rückgängig". */
  delayMs?: number;
  /** Commands one session reads; the next one starts from the stored memory. */
  sessionCommands?: number;
  /** A question the Koordinator could not answer at once: looked up, and answered later. */
  lookUp?: (talk: number) => void;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /** Obeya's configuration: the Koordinator reads it, and changes it on the owner's word. */
  config?: Pick<Config, 'view' | 'check' | 'checkSaved'>;
  /** The other canvases that run now: a new card or idea may go there. */
  canvases?: () => { id: string; name: string }[];
  /** How long after the usage limit lifts the Koordinator reads the words it held, so that clocks a little apart do not matter. */
  limitMargin?: number;
  /** The Koordinator's model and effort; another one chosen since takes a new session. */
  agentSetting?: () => AgentSetting;
  /**
   * Called with what the owner said, so lasting preferences can be learned: a question or remark
   * the Koordinator replied to (`talk`), or a command once it runs; `card` is the one open.
   */
  onOwnerInput?: (card: string | undefined, kind: 'command' | 'talk', text: string, reply: string) => void;
}

/** The Koordinator's conversation with the owner: one agent session that reads command after command. */
interface Session {
  agent: AgentSession;
  ended: boolean;
  /** The interface and conversation languages it started with (`ui/conversation`); others chosen since take a new session. */
  languages: string;
  /** The model and effort it started with, as JSON. */
  choice: string;
  /** Tags of the cards it has seen; they stay the same for the session, so earlier messages stay right. */
  tags: Map<string, string>;
  tagOf: Map<string, string>;
  /** Commands it has read so far; the first one brings the memory. */
  read: number;
  /** Up to where it knows the canvas's history; none before the first command. */
  since?: Mark;
  /** The rules as numbered in the latest message (their ids), for `remember` to name the one it changes. */
  rules: number[];
  /** The command being read; `from`: the card whose agent passed it on. */
  reading?: {
    from?: string;
    finish: (commands: Command[], confirm: string, lookUp?: LookUp, more?: More) => string;
    /** The turn ended, with the error that ended it. */
    end: (error?: Error) => void;
  };
}

/**
 * A question to look up: what the owner asked, the card it is about, the answer it follows up on (an
 * exchange), and the step to take once the answer is in, when the owner asked for an action that needs it.
 */
type LookUp = { question: string; about?: string; follows?: number; then?: string };
/** `wish`: what the owner wants Obeya's makers told; `cannot`: the reply says Obeya cannot do what they asked. */
type More = { wish?: string; cannot?: boolean };
type Decision = { commands: Command[]; confirm: string; lookUp?: LookUp } & More;

/** The actions `act` takes, as the Koordinator names them. */
const ACTIONS = ['new_card', 'new_idea', 'review_pr', 'start', 'dequeue', 'note', 'answer', 'feedback', 'approve', 'accept', 'dismiss', 'keep', 'revise', 'stop', 'pause', 'resume', 'snooze', 'wake', 'discuss', 'build', 'split_off', 'plan_doc', 'prototype', 'park', 'drop', 'remember', 'work_retro', 'group', 'ungroup', 'rename_group', 'merge', 'delete', 'wait_for', 'stop_waiting', 'wish'] as const;

/** What `act` gets for one action. */
const ACTION = z.object({
  do: z.enum(ACTIONS),
  card: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  start: z.boolean().optional(),
  repo: z.string().optional(),
  replaces: z.number().int().optional(),
  repos: z.array(z.string()).optional(),
  cards: z.array(z.string()).optional(),
  group: z.string().optional(),
  direct: z.boolean().optional(),
  idea: z.boolean().optional(),
  until: z.string().optional(),
  state: z.enum(['done', 'waits_for_owner']).optional(),
  on: z.string().optional(),
  pr: z.string().optional(),
  canvas: z.string().optional(),
  path: z.string().optional(),
  own_canvas: z.boolean().optional(),
});
type ActionArgs = z.infer<typeof ACTION>;

/** Actions in one command, at most: "start all queued cards" may name many. */
const MAX_ACTIONS = 20;

/** How far back a fresh session's memory reaches. */
const REMEMBERED_EXCHANGES = 20;
/** Looked-up answers a fresh session gets in full, the newest; older ones are clipped. */
const FULL_ANSWERS = 5;
const HISTORY_DAYS = 14;
const HISTORY_STEPS = 60;
/** What happened between two commands, at most. */
const NEWS_STEPS = 40;

/**
 * Commands understood from the owner's words, as they wait for "Rückgängig". `said`: the owner's
 * words, to learn from once they run, unless they reach the learner another way.
 */
interface Waiting {
  commands: Command[];
  said?: string;
  talk: number;
  confirm: string;
  card?: string;
}

/** A command whose undo window ends sooner than this is not offered for undo again. */
const UNDO_SHOWN_MS = 1000;

/** Words the usage limit kept the Koordinator from reading, and how it reads them once the limit lifts. */
interface Held {
  transcript: string;
  images: string[];
  focus: Focus;
  input: Input;
  /** When the owner said them (ISO time). */
  at: string;
}

/** The Koordinator's turn failed on the account's usage limit, which lifts at `resetsAt` when the API said when. */
class LimitError extends Error {
  constructor(
    message: string,
    readonly limit: { resetsAt?: number },
  ) {
    super(message);
  }
}

export class Commander {
  /**
   * Commands between being understood and having run; the timer is set once the owner has the
   * confirmation, and from then on they are kept in the database too, so a restart in the undo
   * window does not lose them.
   */
  private waiting = new Map<string, Waiting & { due?: number; timer?: ReturnType<typeof setTimeout>; running?: boolean }>();
  private session: Session | null = null;
  /** Commands are read one after the other, each once the previous turn has ended. */
  private turns: Promise<unknown> = Promise.resolve();
  /** What the Koordinator hears with the next command: actions the owner took back. */
  private news: string[] = [];
  /** Words the usage limit holds, by their exchange, in the order the owner said them; read once it lifts. */
  private held = new Map<number, Held>();
  /** When the Koordinator tries again to read what the usage limit holds. */
  private heldUntil = 0;
  private heldTimer?: ReturnType<typeof setTimeout>;
  private draining?: Promise<void>;

  constructor(private o: CommanderOptions) {}

  /**
   * Understands the command; its actions run only after `arm`, so the undo window starts when the
   * owner hears back. The exchange goes into the open card's log, or without one into the
   * Koordinator's sheet. Screenshots (image ids) go with the actions that create or concern a card.
   */
  async hear(transcript: string, focus: Focus, images: string[] = [], input: Input = {}): Promise<Heard> {
    const card = focus.card && this.o.board.item(focus.card) ? focus.card : undefined;
    // passed on by the card's agent: the owner's words stand in the card's conversation already
    const said = input.forwarded ? undefined : transcript;
    const replyTo = card ? this.o.board.quoted(card, input.replyTo)?.id : undefined;
    const quoted = card ? undefined : this.o.board.quotedTalk(input.replyTo);
    // the owner's words stand in the conversation at once, the Koordinator's reply follows once it has read them
    const talk = this.o.board.addTalk(transcript, '', card ?? null, undefined, images, quoted);
    if (card && said) this.o.board.log(card, 'say', 'owner', said, { images, replyTo });
    const held: Held = { transcript, images, focus, input, at: new Date().toISOString() };
    // what the usage limit held is read first, in the order it was said; while the limit holds, these words wait with it
    await this.drain();
    const h = this.held.size ? this.hold(talk, held) : ((await this.answer(talk, held)) ?? this.hold(talk, held));
    return card ? h : { ...h, talk };
  }

  /** Reads the words of exchange `talk` and acts on them; nothing when the usage limit kept the Koordinator from reading them. */
  private async answer(talk: number, { transcript, focus, images, input }: Held): Promise<Heard | undefined> {
    const card = focus.card && this.o.board.item(focus.card) ? focus.card : undefined;
    const said = input.forwarded ? undefined : transcript;
    const replyTo = card ? this.o.board.quoted(card, input.replyTo)?.id : undefined;
    // a reply that only answers (no actions to take back, no answer to look up) waits in the sheet
    // until the owner sees it, as a looked-up answer does: it may come once the sheet is closed; on a
    // card it stands in the conversation, where a confirmation folds away
    const reply = (confirm: string, lookUp?: { question: string; about: string | null }, wish?: Wish, waits = false) => {
      this.o.board.replyTalk(talk, confirm, lookUp, wish, waits);
      if (card) this.o.board.log(card, 'say', 'koordinator', confirm, { ...(wish ? { wish } : {}), ...(waits ? { reply: true as const } : {}), ...(input.forwarded ? { forwarded: true as const } : {}) });
    };
    let decision: Decision;
    try {
      decision = await this.interpret(transcript, focus, images, input);
    } catch (e) {
      if (e instanceof LimitError) {
        this.heldUntil = limitLifts(e.limit, this.o.limitMargin ?? 10_000);
        return undefined;
      }
      // the Koordinator's session failed (not logged in, say): the owner hears why, not that they went unheard
      const t = this.o.board.t;
      const confirm = t.voice.couldNotRead(failureReason(messageOf(e), t));
      reply(confirm, undefined, undefined, true);
      return { confirm };
    }
    const { confirm, lookUp } = decision;
    // a draft for Obeya's makers: what the owner wants them told, or what they asked and Obeya could not do
    const wish: Wish | undefined = decision.wish ? { said: decision.wish } : decision.cannot && !lookUp ? { said: transcript, answer: confirm } : undefined;
    const drafted = { ...(decision.wish ? { wish: wish! } : {}), ...(wish && !decision.wish ? { cannot: true as const } : {}) };
    // a proposal is reworked by what the owner said of it in their own words, however the Koordinator put them
    const verbatim = !input.forwarded && !input.after && !input.answered && decision.commands.length === 1 && decision.commands[0]!.do === 'revise';
    const commands = decision.commands.map((c): Command => {
      // a rule said with a card open has that card as its occasion
      if (c.do === 'remember') return card ? { ...c, card } : c;
      // a new card lands where the owner was on the canvas; a follow-up goes beside the card it follows
      if (focus.place && ((c.do === 'newCard' && !c.from) || c.do === 'newIdea' || c.do === 'reviewPr')) c = { ...c, place: focus.place };
      if (c.do === 'reviewPr') return { ...c, spoken: !input.typed };
      const told =
        TO_AGENT.includes(c.do) && 'text' in c
          ? { ...c, spoken: !input.typed, ...(verbatim && c.card === card ? { text: `${replyNote(replyTo ? this.o.board.quoted(card!, replyTo) : undefined, 'koordinator')}${transcript}` } : {}) }
          : c;
      return images.length && TAKES_IMAGES.includes(c.do) ? { ...told, images } : told;
    });
    if (lookUp) {
      // nothing to take back: the answer follows once it is looked up
      const about = lookUp.about ?? card ?? (focus.project && this.o.board.item(focus.project) ? focus.project : undefined);
      reply(confirm, { question: lookUp.question, about: about ?? null });
      if (lookUp.follows) this.o.board.followTalk(talk, lookUp.follows);
      if (lookUp.then) this.o.board.thenTalk(talk, lookUp.then);
      this.o.lookUp?.(talk);
      if (said) this.o.onOwnerInput?.(card, 'talk', said, confirm);
      return { confirm };
    }
    // talking about an idea changes nothing that would need taking back: it goes on at once
    const talking = commands.filter((c) => c.do === 'discuss');
    const rest = commands.filter((c) => !talking.includes(c));
    reply(confirm, undefined, wish, !commands.length);
    for (const c of talking) await this.run(c);
    if (!commands.length && said && !decision.wish) this.o.onOwnerInput?.(card, 'talk', said, confirm);
    if (!rest.length) return { confirm, ...drafted };
    const token = crypto.randomUUID();
    // the words reach the learner as the agent's note when an agent passed them on
    const learn = said && !commands.some((c) => LEARNED.includes(c.do)) ? { said } : {};
    this.waiting.set(token, { commands: rest, ...learn, talk, confirm, ...(card ? { card } : {}) });
    return { confirm, token, ...drafted };
  }

  /**
   * The usage limit keeps the Koordinator from reading the words of exchange `talk`: they wait, with
   * those it holds already, and are read by themselves once it lifts. Meanwhile the sheet says so
   * under them, and the open card's conversation once.
   */
  private hold(talk: number, h: Held): Heard {
    const t = this.o.board.t;
    const confirm = t.voice.held(t.when(this.heldUntil));
    const card = h.focus.card && this.o.board.item(h.focus.card) ? h.focus.card : undefined;
    if (!this.held.has(talk) && card) this.o.board.log(card, 'say', 'koordinator', confirm, { reply: true, ...(h.input.forwarded ? { forwarded: true as const } : {}) });
    this.held.set(talk, h);
    const until = new Date(this.heldUntil).toISOString();
    for (const [id, { focus, input }] of this.held) this.o.board.holdTalk(id, { until, reading: { focus, input } });
    this.waitForLimit();
    return { confirm };
  }

  private waitForLimit() {
    clearTimeout(this.heldTimer);
    // a timer runs at most about 24 days
    this.heldTimer = setTimeout(() => void this.drain(), Math.min(Math.max(0, this.heldUntil - Date.now()), 2 ** 31 - 1));
  }

  /**
   * Reads what the usage limit held, in order, until it holds again; each reply reaches the owner as
   * a notice, with „Rückgängig“ where it has actions. One drain at a time.
   */
  private drain(): Promise<void> {
    if (!this.held.size) return Promise.resolve();
    return (this.draining ??= (async () => {
      clearTimeout(this.heldTimer);
      for (const [talk, h] of [...this.held]) {
        // read now: „liest …“ under the words
        this.o.board.holdTalk(talk, null);
        const heard = await this.answer(talk, { ...h, input: { ...h.input, heldSince: h.at } });
        if (!heard) {
          this.hold(talk, h);
          return;
        }
        this.held.delete(talk);
        if (heard.token) this.arm(heard.token);
        const card = h.focus.card && this.o.board.item(h.focus.card) ? h.focus.card : undefined;
        this.o.board.notify({ text: heard.confirm, ...(card ? { cardId: card } : { talk }), ...(heard.token ? { token: heard.token, undoMs: this.delayMs } : {}), ...(heard.wish ? { wish: heard.wish } : {}) });
      }
    })().finally(() => (this.draining = undefined)));
  }

  /**
   * A request the agent of `card` passes on from the owner's words to it (`to_obeya`): read like a
   * command, with the card in focus and the owner's own words beside the agent's, as they were said or typed.
   */
  forward(card: string, request: string, said?: { text: string; spoken: boolean; task?: boolean }): Promise<Heard> {
    // a project's agent passes on what was written in its sheet: Obeya reads it with the project open
    const focus = this.o.board.item(card)?.kind === 'project' ? { project: card } : { card };
    return this.hear(said?.text ?? request, focus, [], { typed: !said?.spoken, forwarded: request, ...(said?.task ? { task: true } : {}) });
  }

  /** How long a command waits for undo once armed. */
  get delayMs(): number {
    return this.o.delayMs ?? 5000;
  }

  /** Starts the undo window: the owner has the confirmation now. */
  arm(token: string) {
    const w = this.waiting.get(token);
    if (!w || w.timer) return;
    const due = Date.now() + this.delayMs;
    const { commands, said, talk, confirm, card } = w;
    this.o.board.holdCommand(token, due, { commands, ...(said ? { said } : {}), talk, confirm, ...(card ? { card } : {}) } satisfies Waiting);
    this.schedule(token, w, due);
  }

  /**
   * After a restart: the commands the stopped server held in their undo window run once it is
   * over, at once when it is over already. The owner had their confirmation.
   */
  resume() {
    for (const { token, due, body } of this.o.board.heldCommands()) {
      const w = body as Waiting;
      this.waiting.set(token, w);
      this.schedule(token, w, due);
    }
    // and the words the usage limit held are read once it lifts
    for (const x of this.o.board.heldTalk()) {
      const { focus, input } = x.held.reading as Pick<Held, 'focus' | 'input'>;
      this.held.set(x.id, { transcript: x.said, images: x.images ?? [], focus, input, at: x.at });
      this.heldUntil = Math.max(this.heldUntil, Date.parse(x.held.until));
    }
    if (this.held.size) this.waitForLimit();
    // and the steps whose answer came in before the stop, but were not decided yet
    for (const x of this.o.board.answeredSteps()) this.answerIn(x.id);
  }

  private schedule(token: string, w: Waiting & { due?: number; timer?: ReturnType<typeof setTimeout>; running?: boolean }, due: number) {
    w.due = due;
    w.timer = setTimeout(async () => {
      w.running = true;
      // a restart while they run cuts them off rather than running them twice
      this.o.board.dropCommand(token);
      // what the owner takes back is not learned from either
      if (w.said) this.o.onOwnerInput?.(w.card, 'command', w.said, w.confirm);
      // in the order the owner said them; one that fails does not hold up the others
      const made = new Map<string, string>();
      for (const command of w.commands) {
        const id = await this.run(command, w.talk, made);
        if (id && command.do === 'newCard') made.set(command.title, id);
      }
      this.waiting.delete(token);
    }, Math.max(0, due - Date.now()));
  }

  /** Whether commands the owner has the confirmation of wait for "Rückgängig" or run: a restart waits for them. */
  holding(): boolean {
    return [...this.waiting.values()].some((w) => w.timer);
  }

  /** The commands that still wait for "Rückgängig", for a page that opens (a reload) to offer it again. */
  undoable(): Notice[] {
    const now = Date.now();
    return [...this.waiting.entries()]
      .filter(([, w]) => w.due && !w.running && w.due - now > UNDO_SHOWN_MS)
      .map(([token, w]) => ({ text: w.confirm, token, undoMs: w.due! - now, ...(w.card ? { cardId: w.card } : {}) }));
  }

  /**
   * Runs one command; what it throws is logged on its card. Returns the id of the card a new card
   * command created, for a wait in the same command (`made`, by title) to name; `talk` is the
   * exchange the command came from.
   */
  private async run(command: Command, talk?: number, made = new Map<string, string>()): Promise<string | undefined> {
    try {
      if (command.do === 'waitFor') return void this.waitFor(command, talk, made);
      if (command.do === 'stopWaiting') return void this.stopWaiting(command.card);
      const r = await this.o.execute(command);
      return command.do === 'newCard' && typeof r === 'string' ? r : undefined;
    } catch (e) {
      const card = 'card' in command ? command.card : undefined;
      if (card) this.o.board.log(card, 'error', 'obeya', messageOf(e), { code: e instanceof BadRequest ? e.code : undefined });
      else console.error('voice command:', e);
    }
  }

  /** Takes a waiting command back; false when it already ran. */
  undo(token: string): boolean {
    const w = this.waiting.get(token);
    if (!w || w.running) return false;
    clearTimeout(w.timer);
    this.waiting.delete(token);
    this.o.board.dropCommand(token);
    this.o.board.undoTalk(w.talk);
    if (w.card && this.o.board.item(w.card)) this.o.board.log(w.card, 'state', 'owner', this.o.board.t.voice.undone);
    this.news.push(`The owner took back what you confirmed with „${w.confirm}“; it did not happen.`);
    return true;
  }

  /** Something the Koordinator hears with the owner's next command: an answer it looked up. */
  tell(text: string) {
    this.news.push(text);
  }

  /** The cards the Koordinator waits on, each with the exchange whose reply said so. */
  private waits(): { talk: Talk; wait: TalkWaitRow }[] {
    return this.o.board.waitingTalk().flatMap(({ waiting, ...talk }) => waiting.map((wait) => ({ talk, wait })));
  }

  /** The steps the Koordinator waits to take once the card gets somewhere. */
  waitsOn(card: string): TalkWaitRow[] {
    return this.waits().flatMap(({ wait }) => (wait.card === card ? [wait] : []));
  }

  /** Waits after the exchange `talk` until the card gets there (`waitFor`); a new card of the same command by the id it got. */
  private waitFor(c: Extract<Command, { do: 'waitFor' }>, talk: number | undefined, made: Map<string, string>) {
    const id = c.card ?? (c.newCard !== undefined ? made.get(c.newCard) : undefined);
    const card = id ? this.o.board.item(id) : undefined;
    if (talk === undefined || !card) throw new Error(`the card to wait on is not there: ${c.then}`);
    const before = this.o.board.waitingTalk().find((x) => x.id === talk)?.waiting ?? [];
    // several steps on one card each stand
    this.o.board.waitTalk(talk, [...before, { card: card.id, title: card.title, state: c.state, then: c.then }]);
  }

  /** It no longer waits on the card, after whichever exchange it said so. */
  private stopWaiting(card: string) {
    for (const x of this.o.board.waitingTalk()) if (x.waiting.some((w) => w.card === card)) this.o.board.waitTalk(x.id, x.waiting.filter((w) => w.card !== card));
  }

  /** The owner no longer wants the step the Koordinator waits on the card for, after exchange `talk` („Nicht mehr warten“); false when it no longer waits. */
  unwait(talk: number, card: string): boolean {
    const x = this.o.board.waitingTalk().find((t) => t.id === talk);
    const dropped = x?.waiting.filter((y) => y.card === card) ?? [];
    if (!x || !dropped.length) return false;
    this.o.board.waitTalk(talk, x.waiting.filter((y) => y.card !== card));
    this.news.push(`The owner told you to stop waiting on „${dropped[0]!.title}“: you do not take the step you would have taken then (${dropped.map((w) => w.then).join('; ')}).`);
    return true;
  }

  /** The waits being taken up, by exchange, card and step. */
  private following = new Set<string>();

  /**
   * Takes up the steps the Koordinator said it would take once a card gets somewhere, for the cards
   * among `items` that got there or no longer can. Called on every change of the board.
   */
  due(items: Item[]) {
    for (const { talk, wait } of this.waits()) {
      const key = JSON.stringify([talk.id, wait.card, wait.then]);
      const met = this.following.has(key) ? null : awaited(items.find((i) => i.id === wait.card), wait.state);
      if (!met) continue;
      this.following.add(key);
      void this.follow(talk, wait, met)
        .catch((e) => console.error('taking up a wait:', e))
        .finally(() => this.following.delete(key));
    }
  }

  /**
   * A card the Koordinator waited on got there, or no longer can: a new exchange, with no words of
   * the owner's, takes the step up where the waiting one was (the sheet, or the card open then). The
   * wait stands until the step is decided (or held by the usage limit, which keeps it), so a restart
   * meanwhile takes it up again, and the owner can still drop it: then what was decided is taken
   * back. Its reply reaches the owner as a notice, with „Rückgängig“ where it has actions.
   */
  private async follow(x: Talk, w: TalkWaitRow, met: Awaited) {
    const card = x.cardId && this.o.board.item(x.cardId) ? x.cardId : undefined;
    // a card that got done also counts for a wait until it needs the owner: it is done, not waiting
    const reached = met === 'reached' && finished(this.o.board.item(w.card)?.state ?? 'planned') ? 'done' : w.state;
    const after: TalkAfter = { title: w.title, state: reached, met, from: x.id };
    /** Takes the wait off its exchange; false when the owner dropped it meanwhile. */
    const consume = () => {
      const now = this.o.board.waitingTalk().find((t) => t.id === x.id)?.waiting ?? [];
      const n = now.findIndex((y) => y.card === w.card && y.then === w.then);
      if (n >= 0) this.o.board.waitTalk(x.id, now.filter((_, i) => i !== n));
      return n >= 0;
    };
    const talk = this.o.board.addTalk('', '', card ?? null, undefined, [], undefined, after);
    const h: Held = {
      transcript: '',
      images: [],
      focus: card ? { card } : {},
      input: { after: { ...after, card: w.card, then: w.then, said: x.said, promised: x.reply ?? '', at: x.at } },
      at: new Date().toISOString(),
    };
    await this.drain();
    const heard = this.held.size ? undefined : await this.answer(talk, h);
    if (!consume()) {
      // dropped while it was read: what it decided does not happen
      if (heard?.token) this.undo(heard.token);
      else if (!heard) {
        this.o.board.replyTalk(talk, this.o.board.t.voice.undone);
        this.o.board.undoTalk(talk);
      }
      return;
    }
    if (!heard) return void this.hold(talk, h);
    if (heard.token) this.arm(heard.token);
    this.o.board.notify({ text: heard.confirm, ...(card ? { cardId: card } : { talk }), ...(heard.token ? { token: heard.token, undoMs: this.delayMs } : {}), ...(heard.wish ? { wish: heard.wish } : {}) });
  }

  /** Looked-up answers whose step is being taken up, by exchange. */
  private takingUp = new Set<number>();

  /**
   * The answer of exchange `id` is in. When the Koordinator looked it up for an action (`LookUp.then`),
   * a new exchange, with no words of the owner's, takes that step up where the asking one was (the
   * sheet, or the card open then). The step stands until it is decided (or held by the usage limit,
   * which keeps it), so a restart meanwhile takes it up again. Its reply reaches the owner as a
   * notice, with „Rückgängig“ where it has actions. Returns whether a step was taken up.
   */
  answerIn(id: number): boolean {
    const x = this.o.board.exchange(id);
    if (!x?.then || x.answer === undefined || x.question === undefined || this.takingUp.has(id)) return false;
    this.takingUp.add(id);
    void this.takeUp({ ...x, then: x.then, answer: x.answer, question: x.question })
      .catch((e) => console.error('taking up a looked-up step:', e))
      .finally(() => this.takingUp.delete(id));
    return true;
  }

  private async takeUp(x: Talk & { then: string; answer: string; question: string }) {
    const card = x.cardId && this.o.board.item(x.cardId) ? x.cardId : undefined;
    const talk = this.o.board.addTalk('', '', card ?? null, undefined, x.images ?? [], undefined, undefined, undefined, x.id);
    const h: Held = {
      transcript: '',
      // the screenshots of the owner's words go with the cards the step creates
      images: x.images ?? [],
      focus: card ? { card } : {},
      input: { answered: { from: x.id, question: x.question, answer: x.answer, then: x.then, said: x.said, promised: x.reply ?? '', at: x.at } },
      at: new Date().toISOString(),
    };
    await this.drain();
    const heard = this.held.size ? undefined : await this.answer(talk, h);
    this.o.board.thenTalk(x.id, null);
    if (!heard) return void this.hold(talk, h);
    if (heard.token) this.arm(heard.token);
    this.o.board.notify({ text: heard.confirm, ...(card ? { cardId: card } : { talk }), ...(heard.token ? { token: heard.token, undoMs: this.delayMs } : {}), ...(heard.wish ? { wish: heard.wish } : {}) });
  }

  /** Words Whisper should expect: Obeya's own, and the titles on the canvas. */
  vocabulary(): string {
    const titles = this.o.board
      .snapshot()
      .items.filter((i) => !finished(i.state))
      .map((i) => i.title.replace(/[`*_]/g, ''));
    return [this.o.board.t.vocabulary, ...titles].join(' ').slice(0, 900);
  }

  /** Starts the Koordinator's session ahead, so a command does not wait for its start-up. Called when the owner starts speaking. */
  warm() {
    if (!this.live()) this.session = this.open();
  }

  private choice = () => JSON.stringify(this.o.agentSetting?.() ?? {});

  private languages = () => `${this.o.board.language()}/${this.o.board.conversation()}`;

  /** The session that reads the next command, if it is still up, speaks the owner's languages and runs as they chose. */
  private live(): Session | null {
    const s = this.session;
    if (s && !s.ended && !s.reading && (s.languages !== this.languages() || s.choice !== this.choice())) {
      s.ended = true;
      s.agent.close();
      this.session = null;
    }
    return this.session && !this.session.ended ? this.session : null;
  }

  /** A session whose tools act on whatever command it is reading. */
  private open(): Session {
    // the examples in the owner's conversation language, the names of Obeya's own cards in the interface's
    const language = this.o.board.conversation();
    const ui = this.o.board.language();
    const t = MESSAGES[ui];
    const say = CONFIRM[language];
    const s: Session = { agent: null as unknown as AgentSession, ended: false, languages: this.languages(), choice: this.choice(), tags: new Map(), tagOf: new Map(), read: 0, rules: [] };
    const finish = (commands: Command[], confirm: string, lookUp?: LookUp, more?: More) => (s.reading ? s.reading.finish(commands, confirm, lookUp, more) : 'No command to read.');
    const repos = this.o.board.canvas.repos;
    const config = this.o.config;
    s.agent = this.o.runtime.start({
      cwd: this.o.cwd,
      readOnly: true,
      role: 'koordinator',
      system: system(language, ui),
      tools: [
        {
          name: 'act',
          description: [
            'Do what the owner asked: one or more actions, in the order the owner said them. They run together after a short undo window, with one confirmation for all.',
            'Actions (card: the tag of the card; new_card and new_idea take none, except a follow-up):',
            `- new_card: a new card. title short and precise, body what the owner asked for in their words, start false only when the owner says it should wait („nur notieren“, „für später“, „noch nicht starten“), else true: work on it begins right away, as with a click on "Agent starten" (checked for conflicts with work in progress, queued if need be); until when the owner names a time for the work („Anfang Dezember“, „erst am Montag“, „in zwei Wochen“): it is planned now and starts by itself then, as with snooze on a planned card (the local time as for snooze, 08:00 on a day without an hour, the first of a month for its beginning)${repos.length > 1 ? ', repo the repository it belongs to (an id from the list)' : ''}; canvas: where the owner wants it on another canvas of this Obeya („leg auf Super 59 eine Aufgabe an“), that canvas's name from the list, and it goes into that canvas's first repository. A follow-up of a card (for one of its findings, or something from its summary): card the tag of that card, and body the finding or passage in full, then what the owner added.`,
            "- start: start work on a planned card; path and own_canvas as for build on an idea, where the owner wants a planned task of theirs nobody has worked on yet started in a repository that does not exist yet. On a queued card (waiting behind cards in progress or queued ahead of it) it starts it now, despite the likely merge conflict; a card Obeya is still checking starts by itself unless its changes likely conflict with work in progress. On a project: all its planned workstreams go to Obeya together, which decides their order and which of them wait (for a dependency or a likely conflict); use it when the owner wants a project's workstreams started (\"starte das Projekt\", \"alle Workstreams\") rather than starting them one by one.",
            '- dequeue: take a card out of the queue (waiting behind other cards, for a free workspace, or still being checked by Obeya); it goes back to planned and does not start until started again („nimm … aus der Warteschlange“, „lass … doch noch nicht starten“).',
            "- note: text to the agent working on a card (working, in PR, waiting, or live or done while its agent finishes after the landing), or for the agent that will take on a planned card (in the queue or not, stopped too), which gets it with the task once it starts; it doesn't stop it. Whatever the owner says to the agent: an instruction, a remark on its work, a question to it; never a question the owner asks you about the canvas.",
            "- answer: text as the answer to the card's open question: the agent's, or the one in its demo report (the demo then still waits for approval). A bare „ja“ or „nein“ to a card with an open question is an answer, not an approval.",
            '- feedback: text as feedback on work waiting for review (demo or summary), a question about that work included; its agent takes it in while the work still waits for approval, and hands over anew when it changes something.',
            '- approve: approve work waiting for review; it lands the way its repository sets (on main, or as a pull request), also where the words of the owner release it („deploy it“, „ship it“, „raus damit“, „freigeben“). direct: true where the words ask to bypass the pull request itself („ohne PR“, „direkt auf main“, „am PR vorbei“). accept: take a proposed card and start it (a proposed idea: its discussion opens; the open questions on it go along); idea: true when the owner wants a proposed task discussed as an idea first rather than built („als Idee“, „erst besprechen“). dismiss: discard a proposed card, or one its agent withdrew or replaced since (the list says so; it goes, its worker stopped). keep: keep such a withdrawn or replaced card as it is. revise: text what the owner wants changed in a proposed card, or their thoughts on it (added, dropped, decided, put differently); an agent rewrites its text and questions by it in a minute or so, and accepting it waits for that (by a click once it is there).',
            '- pause: pause the agent on a card at once, only while it is working on something (the card list says so): a worker at work, or in any other state while the list says its agent is working on something; an idea\'s agent working on its reply; a Question card\'s agent reading. Nothing of it runs, its session stays, and it goes on where it stopped with resume, or with what the owner says to it, which it goes on with („halt mal an“, „pausier …“, „warte mal kurz“). resume: let a paused agent go on („mach weiter“, „lass ihn weitermachen“). stop: end the agent on a card for good, which plans the card again („stopp“, „brich ab“).',
            "- wait_for: a step you take later, once a card gets somewhere (start a card once another has landed; pass the owner's words on once a card waits for them). on: the card to wait on, its tag, or the title of a new_card in this same act (in „starte Login, sobald Export fertig ist“: Export). state: done (the default: its work is on main, or it was closed without a change) or waits_for_owner (it asks the owner or hands its work over). text: the step, standing on its own, with what the owner asked for (names, paths, values) and cards by their titles (tags may change by then). Obeya wakes you once that card gets there, or no longer can (stopped, removed), and you take the step then; confirm says that you will. Nothing else wakes you for a later step. A new card you wait on gets in its body only its agent's part, without your step: its agent would try that step itself, and Obeya would refuse it. stop_waiting: you no longer wait on the card (on), when the owner no longer wants that step.",
            '- snooze: set a card aside until a point in time („stell das bis morgen früh zurück“, „erinner mich Montag daran“, „das später“), on a card at work (its agent stops until then, as on a pause, and goes on at the time), one waiting for the owner (it leaves their list until then; nothing goes to its agent), or a planned one not yet with Obeya (it starts at the time instead of now: „erst am Montag starten“); on a snoozed card it changes the time. until: the local time as YYYY-MM-DDTHH:MM, from Now above („heute Abend“ 18:00, „morgen früh“ 08:00, „Montag“ 08:00 next Monday). wake: a snoozed card now („hol … zurück“, „weck … auf“); a planned one starts then, as start does.',
            `- review_pr (no card): review a pull request someone outside opened („Review PR #5“, „schau dir den PR an“ with its link). pr: its number or URL; text: what the owner adds for this review in their words („schau besonders auf Security“, „die Demo nur auf dem Handy“), else empty${repos.length > 1 ? ', repo the repository whose pull request it is (an id from the list)' : ''}. A review card starts on it: its agent reviews the code, records a demo before and after, runs the checks, and the owner merges it from the card. A PR that has a card already opens that one, and the text goes to its agent. confirm e.g. ${say.reviewPr}`,
            `- new_idea: a new idea to think through with an exploration agent before anything is planned ("Ich will über … nachdenken", "Idee: …"). title short and precise, body what the owner said about it, in their words${repos.length > 1 ? ', repo as for new_card' : ''}; canvas as for new_card.`,
            `- remember (no card): a rule the owner wants kept for all future work („Merk dir: …“, „ab jetzt immer …“). text: the rule, short and general, in the owner's language; replaces: the number of a rule of the owner it changes or contradicts, also when it moves that rule into a CLAUDE.md. It goes to one of two places. The owner's rules, for how the agents work with the owner through Obeya whatever the repository (what to ask and what to decide alone, how to report, hand over and demo): leave repos out; it applies at once. A repository's CLAUDE.md, for anything about a repository (its conventions, product, tools, how its code is written, tested and landed, its UI and wording, taste in code even when it holds in every repository): repos the ids of the repositories it concerns (usually the open card's; every one when it holds in all of them); it goes into the repository's card ${t.quote(t.claudeMd.title)}, whose worker writes it into the CLAUDE.md. confirm says where it goes (${say.remember}).`,
            `- work_retro (no card): the Arbeitsrückschau of a repository, now („Mach eine Arbeitsrückschau für den Shop“): it reads the friction noted on the workers' runs of its finished cards since the last one and proposes cards (a script, a skill), CLAUDE.md lines or values for the repository's settings (checks, setup, soft paths, how to run the app for a demo) for what recurs on several cards; they come as proposals for the owner, and the owner hears when it is done. It also runs by itself: in a new repository after its first finished card, then after 2 more and 4 more, then every 10. repo: the repository's id (the one the owner names, else the open card's, else the first). confirm e.g. ${say.retro}`,
            "- On a card in state idea: discuss (text: what the owner says in its discussion: a thought, a question, an answer to the idea's agent; it goes on at once, without undo), build (its brief becomes the task and a worker starts on it at once; while its agent works on a reply, or starts on one with a discuss in the same command, once that reply is there, unless the reply asks questions; it ends the discussion, and the idea's prototypes, planned and running, are thrown away; path: where the owner wants it built in a repository that does not exist yet („bau das in einem neuen Repo unter ~/dev/super59“), its folder, absolute or from ~: Obeya creates the folder and a local git repository (no remote), a canvas of its own named after it, moves the idea there with its brief, conversation and decisions, and builds it there, after a few seconds in which the owner can take it back on the card; own_canvas: false where the owner wants the new repository on this canvas instead; the list says where the idea's agent or the owner chose a new repository already, and build without path builds it there), split_off (only where the list says its agent marked a part as settled: that part becomes a task of its own beside the idea, which a worker starts on at once, and the idea stays open with its discussion and its prototypes for what is still open), plan_doc (a big idea becomes a project: an agent starts at once on its plan doc, and the project then takes the idea's place), prototype (a worker builds a throwaway prototype shown as a demo on it, beside any others; text: what it should show, its approach first in a few words; empty: one prototype for each variant its agent planned that has none running yet, all at once, or without planned variants one of the idea as it stands), park (for later), drop (it stays on the canvas with its brief). Planning an idea, or splitting a task off it, waits for its agent's reply while it works on one, or starts on one in the same command: then pass what the owner said with discuss, and say that it goes by a click once the reply is there.",
            "- plan_doc also on a planned task of the owner's that nobody has worked on yet (not with Obeya, no branch): an agent starts at once on a plan doc with workstreams from the task, and the project then takes the task's place („plane das als Projekt“).",
            `- group: put cards into a group, shown on the canvas as a coloured territory behind them. cards: their tags; text: the group's name (group is only for rename_group), one the canvas has (see the list) or a new one, which is then created. A card is in one group at most, so this takes it out of its group. A workstream stands for its project: the whole project goes into the group. ungroup: take cards (cards) out of their group. rename_group: group the group's current name, text its new name. A group no card belongs to any more goes. confirm e.g. ${say.group}`,
            `- merge: planned tasks that are one task (dictated twice, say, or follow-ups that belong together) become one. cards: their tags, the one that stays first (it keeps its place and group); title: a new title for the merged task, short and precise, that covers what all of them are about. Their texts go into it unchanged, each under its title, and the others go. delete: a planned task the owner no longer wants (card). Both only on planned tasks nobody has worked on yet (no branch, not queued), merge only within one repository; a proposal is dismissed instead, an idea dropped. confirm e.g. ${say.merge}`,
            '- On a prototype (a card marked prototype of an idea): build (the idea is built on this prototype\'s branch; its other prototypes are thrown away; when the idea became a project, one of its workstreams is built on the branch instead: the one its plan doc builds on the prototype with, or cards: the tag of the one the owner names), drop (the prototype is thrown away into the archive). approve on a prototype also throws it away.',
            `- wish (no card): the owner wants Obeya's makers told something about Obeya itself: a wish, something missing, a bug („Obeya, Feedback: …“, „Sag den Entwicklern …“, „Wunsch an Obeya: …“). text: what they want the makers to know, in their words. It opens a draft for the owner to check and send on GitHub themselves; nothing goes out. Feedback on a card's work is feedback, and the developers of the repository's own app are the agents (a new card), not this. confirm e.g. ${say.wish}`,
            "Texts for a card's agent (note, answer, feedback) and for revise in the owner's own words, not rephrased: all they said, or with several actions in one sentence the part for that action. Other texts (a new card's body, a rule, talk to an idea) as the owner meant them (fix obvious recognition errors).",
          ].join('\n'),
          schema: {
            actions: z.array(ACTION).min(1).max(MAX_ACTIONS),
            confirm: z.string(),
          },
          run: ({ actions, confirm }) => {
            const commands: Command[] = [];
            const problems: string[] = [];
            // what the owner wants Obeya's makers told goes into a draft on their page, not into the actions that run
            const wishes = (actions as ActionArgs[]).filter((a) => a.do === 'wish').map((a) => a.text?.trim() ?? '');
            if (wishes.some((w) => !w)) problems.push("wish: the text is missing (what the owner wants Obeya's makers told)");
            const given = (actions as ActionArgs[]).filter((a) => a.do !== 'wish');
            const problem = (n: number, why: string) => {
              const a = given[n]!;
              problems.push(`action ${n + 1} (${a.do}${a.card ? ` on ${a.card}` : ''}): ${why}`);
            };
            given.forEach((a, n) => {
              const r = this.command(a, s, given);
              if (typeof r === 'string') problem(n, r);
              else commands.push(r);
            });
            if (!problems.length)
              commands.forEach((c, n) => {
                const r = this.waitsForReply(c, commands, s.reading?.from);
                if (r) problem(n, r);
              });
            if (problems.length)
              return `Nothing recorded: ${problems.join('; ')}. Fix or drop what does not fit and call act again, or use reply (a question the owner asks is answered with reply, or with look_up when it needs reading).`;
            return finish(commands, String(confirm), undefined, wishes.length ? { wish: wishes.join('\n\n') } : {});
          },
        },
        {
          name: 'reply',
          description:
            [
              'No action: answer a question from what this conversation gives you (the cards, their states and history, what was said), or say that it is unclear what is meant (ask what is meant, briefly).',
              "wish: true when the reply says Obeya cannot do what the owner asked because Obeya has no such feature (sorting cards by date, say, where nothing in Obeya does that); the owner then gets a link to send it to Obeya's makers as a wish. Not when it is unclear what they mean, when something failed just now (git, the network, a refused tool call), when the request does not fit a card's state (an action that waits, a card that is not there), or for a question of fact.",
            ].join('\n'),
          schema: { confirm: z.string(), wish: z.boolean().optional() },
          run: ({ confirm, wish }) => finish([], String(confirm), undefined, wish === true ? { cannot: true } : {}),
        },
        ...(config
          ? [
              {
                name: 'config',
                description: [
                  "Read Obeya's configuration: the canvases this Obeya serves (canvases), each with its repositories (path; git: false for a folder without git, whose cards work in it directly, with neither clones nor hosts; clones: clones to create, workspaces: existing clones to use, slots: how many of its workers may be busy at once on this machine (as many as there are clones when left out, any number for repositories whose workers use worktrees), hosts: other machines over SSH its workers run on (name, ssh target, root directory there, clones, slots), a new card going to the first machine with a free slot, this one first; all but slots only for repositories whose workers use clones; settings: the values the owner set for this machine in front of the repository's .obeya/settings.json: main branch (branch), how approved work lands (land: main or pr; direct; autoMerge: false where the people on the forge merge a ready pull request instead of Obeya), checks, setup, planDocs, softPaths, workspaces, prNoise, app (run: the recipe for running the app that every worker reads, in prose; stop and keep: the commands Obeya runs to stop a waiting card's app), language (of what lands in the repository: code, docs, commit messages; en or de, English when left out), demo's language, demo's site (title, url, deploy command line with {dir}, env, headers, maxFile, publish: approved where each approved card's latest demo goes on the site by itself; without one, \"Teilen\" exports a demo as a ZIP or one HTML file)), what they amount to (resolved: canvas id, as in /c/<id>, name, repository ids, whether workers use clones or worktrees, adapterGone where the repository still has an adapter module Obeya no longer reads, trust where commands of its settings or its own Claude Code settings are new or changed on its default branch and wait for the owner to trust them in the Konfiguration dialog (held: which groups; now and before: the commands), and values: each setting as it stands without this machine's, with its source), problems, which canvases run now (running), where it is saved (file; source: whether the running canvases come from that file or from the command line), and the server's settings from its command line (port, data directory, the agents' permission mode, whether it restarts by itself).",
                  'Call it for any question about the configuration, and before configure.',
                ].join('\n'),
                schema: {},
                run: async () => JSON.stringify({ ...config.view(), ...(await config.checkSaved()) }, null, 1),
              },
              {
                name: 'configure',
                description: [
                  "Change Obeya's configuration on the owner's word: canvases is the whole new list as config shows it (keep what the owner did not ask to change). It is saved after the undo window and applies while Obeya runs, without a restart: a new canvas or repository starts at once; a repository whose agents now work elsewhere (clones, workspaces, slots, hosts, workspaces in its settings) or that leaves has its agents restarted or stopped once they paused, the others working on.",
                  "A canvas's id follows its name (without one, the first repository's name), unless id is set: to rename a canvas, set id to its current id (from resolved), or it becomes a new, empty canvas and its cards stay under the old id, unseen. The first repository a canvas was served with stays its home and must stay listed. Server settings (port, permission mode) are not part of it; they come from the command line.",
                  `confirm: one short sentence in the owner's language saying what changes and, where a repository's agents restart for it, that they do once they paused, e.g. ${say.configure}`,
                ].join('\n'),
                schema: {
                  canvases: configShape,
                  confirm: z.string(),
                },
                run: async ({ canvases, confirm }: Record<string, unknown>) => {
                  const { problems: all, canvases: checked } = await config.check(canvases);
                  const problems = all.filter(blocksSaving);
                  if (problems.length)
                    return `Nothing recorded, the configuration does not work: ${problems.map((p) => p.detail).join('; ')}. Fix it and call configure again, or reply to the owner.`;
                  return finish([{ do: 'configure', canvases: checked }], String(confirm));
                },
              },
            ]
          : []),
        {
          name: 'look_up',
          description: [
            'No action: a question of fact that needs reading or checking you cannot do in this quick turn: what an agent would do on a card if it were started, what the plan doc says about a workstream, how something works in the code, why something is the way it is, what only the machine or GitHub shows (files and their dates, the git history, a release, a pull request or CI run).',
            "Never for a question about the work of an agent on a card (working, waiting for review, in PR, waiting, or finishing what remains, or a live or done card a note resumes its agent on): that agent knows its work, which is on its branch and not in the checkout look_up reads; pass the question to it (note, or feedback when it waits for review).",
            "An agent with a worker's tools (the shell, gh, the web) that reads the plan docs, the repository and the card's start task answers it in a few seconds; a question about a workstream goes to its project agent.",
            `question: the question in full, standing on its own, in the owner's language (it becomes the title of a Question card when the owner moves the thread onto one). card: the tag of the card it is about, if any (the open one unless the owner means another). confirm: a short acknowledgement in the owner's language, e.g. ${say.lookUp}`,
            "follows: when the owner's words follow up on an answer you looked up (asking on, wanting more of it, a file made of it: „und im Oktober?“, „mach mir ein Excel daraus“), that answer's tag (A12): the agent that found it goes on with all it read and computed. In doubt, the newest answer. Left out, a fresh agent starts from nothing.",
            `then: when the owner asks you to do something whose actions depend on what needs reading first („leg für jedes offene Issue eine Aufgabe an“, „starte die Aufgaben, deren Pull Request grün ist“), the step to take with the answer, standing on its own (cards named by title); question then asks for what the step needs (for a task per issue: each one's number, title, link and what it asks for). Once the answer is in, you take that step yourself with act, and the owner can take it back. confirm says both, e.g. ${say.lookUpThen}`,
          ].join('\n'),
          schema: { question: z.string(), card: z.string().optional(), follows: z.string().optional(), then: z.string().optional(), confirm: z.string() },
          run: ({ question, card, follows, then, confirm }) => {
            const q = String(question).trim();
            if (!q) return 'The question is missing.';
            const followed = follows ? fromAnswerTag(String(follows)) : undefined;
            if (follows && (!followed || !this.o.board.exchange(followed)?.thread))
              return `Unknown answer ${String(follows)}; call look_up again with the tag of an answer you looked up (A12), or without follows.`;
            const about = card ? s.tags.get(String(card)) : undefined;
            if (card && (!about || !this.o.board.item(about))) return `Unknown tag ${String(card)}; call look_up again with a tag from the list, or without card.`;
            const agent = about ? this.o.board.item(about)! : undefined;
            if (agent && hasAgent(agent) && agent.id !== s.reading?.from)
              return `An agent is on ${String(card)} (${agent.need ?? agent.state}): it answers what is asked about its work, which is on its branch and not in the checkout look_up reads. Pass the owner's words to it with act (${handedOver(agent) ? 'feedback' : 'note'}).`;
            const step = typeof then === 'string' ? then.trim() : '';
            return finish([], String(confirm), { question: q, ...(about ? { about } : {}), ...(followed ? { follows: followed } : {}), ...(step ? { then: step } : {}) });
          },
        },
      ],
      onEvent: (e) => {
        if (e.type === 'error') {
          s.ended = true;
          s.agent.close();
          s.reading?.end(e.limit ? new LimitError(e.message, e.limit) : new Error(e.message));
        } else if (e.type === 'idle') s.reading?.end();
      },
    });
    s.agent.done.then(() => {
      s.ended = true;
      s.reading?.end(new Error('the session ended'));
      if (this.session === s) this.session = null;
    });
    return s;
  }

  /**
   * Planning an idea, or building it on a prototype, waits for its agent's reply, which changes the
   * brief the owner decides on: what the owner said goes to the agent, and they click once the reply
   * is there. Building it as it stands goes ahead after the reply, unless that asks questions.
   */
  private waitsForReply(c: Command, all: Command[], from?: string): string | undefined {
    if (c.do === 'accept' && all.some((d) => d.do === 'revise' && d.card === c.card))
      return 'accepting a proposal waits for its reworked text, so the owner sees what they take: drop this action, keep revise, and say in confirm that accepting goes by a click once the new text is there';
    if (c.do !== 'planDoc' && c.do !== 'buildPrototype' && c.do !== 'splitOff') return;
    const id = c.do === 'buildPrototype' ? this.o.board.item(c.card)?.prototypeOf : c.card;
    const idea = id ? this.o.board.item(id) : undefined;
    if (!idea) return;
    const talked = all.some((d) => d.do === 'discuss' && d.card === idea.id);
    if (!idea.idea?.thinking && !talked) return;
    const what = { planDoc: 'planning', buildPrototype: 'building on a prototype', splitOff: 'splitting off a task' }[c.do];
    if (idea.id === from) return `${what} waits for the reply the idea's agent is working on, which changes the brief the owner decides on: drop this action and say in confirm that it goes by a click on the card once the reply is there.`;
    return `the idea's agent ${talked ? 'starts on a reply with the discuss in this command' : 'is still working on its reply'}, and building or planning waits for that reply, so the owner decides on the brief it leaves. Drop this action and pass what the owner said to the idea with discuss (one per idea), then say in confirm that ${c.do === 'planDoc' ? 'planning' : 'building'} goes by a click on the card once the reply is there.`;
  }

  /** The other canvas an action names (by its name or id), or why there is none such; nothing where it names none or this one. */
  private otherCanvas(name?: string): string | undefined {
    const n = name?.trim().toLowerCase();
    if (!n || n === this.o.board.canvas.id.toLowerCase() || n === this.o.board.canvas.name.toLowerCase()) return undefined;
    const others = this.o.canvases?.() ?? [];
    const c = others.find((x) => x.id.toLowerCase() === n || x.name.toLowerCase() === n);
    if (c) return c.id;
    return `unknown canvas ${name}; ${others.length ? `the other canvases are ${others.map((x) => `"${x.name}"`).join(', ')}` : 'there is no other canvas'}`;
  }

  /** The repository an action names for a new card, where the canvas has more than one and it is among them. */
  private newCardRepo(a: ActionArgs): string | undefined {
    const repos = this.o.board.canvas.repos;
    return repos.length > 1 && repos.some((r) => r.id === a.repo) ? a.repo : undefined;
  }

  /** Why an action cannot be done: the repositories it names that the canvas does not have. */
  private unknownRepo(names: string[]): string {
    return `unknown repository ${names.join(', ')}; the canvas has ${this.o.board.canvas.repos.map((r) => r.id).join(', ')}`;
  }

  /** One action as a command, or why it cannot be done. */
  private command(a: ActionArgs, s: Session, all: ActionArgs[] = [a]): Command | string {
    // taken out before: it opens a draft, it does not run
    if (a.do === 'wish') return 'a wish is no action that runs';
    if (a.do === 'wait_for') {
      // cards by their titles: the tags of this session may name others by then
      const then = a.text
        ?.trim()
        // a tag beside the title it names goes; a bare one becomes that title
        .replace(/\s*\(K\d+\)/g, '')
        .replace(/\bK\d+\s+(?=["„“])/g, '')
        .replace(/\bK\d+\b/g, (tag) => {
          const named = this.o.board.item(s.tags.get(tag) ?? '');
          return named ? `"${named.title}"` : tag;
        });
      if (!then) return 'the step you take then is missing (text)';
      const state: AwaitedState = a.state === 'waits_for_owner' ? 'waitsForOwner' : 'done';
      const on = (a.on ?? a.card ?? a.title)?.trim();
      const id = on ? s.tags.get(on) : undefined;
      if (!id) {
        const title = on?.toLowerCase();
        const newCard = title ? all.find((x) => x.do === 'new_card' && x.title?.trim().toLowerCase() === title)?.title?.trim() : undefined;
        if (!newCard) return `${on ? `no card ${on}` : 'no card named'}: give with on the tag of the card to wait on, or the title of a new_card in this act`;
        return { do: 'waitFor', newCard, state, then };
      }
      const card = this.o.board.item(id);
      if (!card) return `unknown tag ${on}`;
      const met = awaited(card, state);
      if (met === 'reached') return `the card ${state === 'done' ? 'is done' : 'waits for the owner'} already: take the step now`;
      if (met) return `the card no longer gets there by itself (${met}): reply to the owner instead`;
      return { do: 'waitFor', card: card.id, state, then };
    }
    if (a.do === 'stop_waiting') {
      const on = a.on ?? a.card;
      const id = on ? s.tags.get(on) : undefined;
      if (!id || !this.waits().some(({ wait }) => wait.card === id)) return `you do not wait on ${on ?? '(no card named)'}; the cards you wait on are in the message`;
      return { do: 'stopWaiting', card: id };
    }
    if (a.do === 'remember') {
      const text = a.text?.trim();
      if (!text) return 'the rule is missing';
      if (text.length > 500) return 'a rule has at most 500 characters';
      const repos = [...new Set(a.repos ?? [])];
      const unknown = repos.filter((r) => !this.o.board.canvas.repos.some((x) => x.id === r));
      if (unknown.length) return this.unknownRepo(unknown);
      const to = repos.length ? { repos } : {};
      if (a.replaces === undefined) return { do: 'remember', text, ...to };
      const replaces = s.rules[a.replaces - 1];
      if (replaces === undefined) return `there is no rule ${a.replaces}; give the number of one of the owner's rules, or none`;
      return { do: 'remember', text, replaces, ...to };
    }
    if (a.do === 'work_retro') {
      if (a.repo && !this.o.board.canvas.repos.some((r) => r.id === a.repo)) return this.unknownRepo([a.repo]);
      const open = a.card ? this.o.board.item(s.tags.get(a.card) ?? '')?.repo : undefined;
      return { do: 'workRetro', repo: a.repo ?? open ?? this.o.board.home };
    }
    if (a.do === 'group' || a.do === 'ungroup') {
      const tags = [...new Set([...(a.cards ?? []), ...(a.card ? [a.card] : [])])];
      if (!tags.length) return 'name the cards with cards (their tags)';
      const cards: string[] = [];
      for (const t of tags) {
        const id = s.tags.get(t);
        if (!id || !this.o.board.item(id)) return `unknown tag ${t}`;
        cards.push(id);
      }
      if (a.do === 'ungroup') return { do: 'ungroup', cards };
      // the name may come where rename_group takes the group
      const name = (a.text || a.group)?.replace(/\s+/g, ' ').trim();
      if (!name) return "the group's name is missing (text)";
      if (name.length > 60) return "a group's name has at most 60 characters";
      return { do: 'group', cards, name };
    }
    if (a.do === 'rename_group') {
      const groups = this.o.board.snapshot().groups;
      const g = groups.find((x) => x.name.toLowerCase() === a.group?.trim().toLowerCase());
      if (!g) return `there is no group ${a.group ?? '(none named)'}; the canvas has ${groups.map((x) => `"${x.name}"`).join(', ') || 'none'}`;
      const name = a.text?.replace(/\s+/g, ' ').trim();
      if (!name) return 'the new name is missing (text)';
      if (name.length > 60) return "a group's name has at most 60 characters";
      if (groups.some((x) => x.id !== g.id && x.name.toLowerCase() === name.toLowerCase())) return `there is a group "${name}" already`;
      return { do: 'renameGroup', group: g.id, name };
    }
    if (a.do === 'merge' || a.do === 'delete') {
      const tags = [...new Set([...(a.card ? [a.card] : []), ...(a.cards ?? [])])];
      if (!tags.length) return a.do === 'merge' ? 'name the cards with cards (their tags, the one that stays first)' : 'name the card (its tag)';
      const cards: Item[] = [];
      for (const t of tags) {
        const card = this.o.board.item(s.tags.get(t) ?? '');
        if (!card) return `unknown tag ${t}`;
        const why = notUntouched(card);
        if (why) return `only a planned task nobody has worked on yet can be ${a.do === 'merge' ? 'merged' : 'deleted'}: ${t} "${card.title}" ${why}`;
        cards.push(card);
      }
      if (a.do === 'delete') return cards.length === 1 ? { do: 'delete', card: cards[0]!.id } : 'delete takes one card; give one delete action for each';
      if (cards.length < 2) return 'name at least two cards to merge (cards)';
      if (new Set(cards.map((c) => c.repo)).size > 1) return `only tasks of one repository can be merged: ${cards.map((c) => `"${c.title}" is in ${c.repo}`).join(', ')}`;
      const title = (a.title || a.text)?.replace(/\s+/g, ' ').trim();
      if (!title) return "the merged task's title is missing (title)";
      if (title.length > 200) return 'a title has at most 200 characters';
      return { do: 'merge', card: cards[0]!.id, others: cards.slice(1).map((c) => c.id), title };
    }
    if (a.do === 'review_pr') {
      const pr = a.pr?.trim().replace(/^#/, '') ?? '';
      if (!pr) return 'the pull request is missing (pr: its number, or its URL)';
      if (!/^\d+$/.test(pr) && !parsePrUrl(pr)) return `${pr} is neither the number of a pull request nor its URL`;
      const repo = this.newCardRepo(a);
      return { do: 'reviewPr', pr, text: (a.text || a.body || '').trim(), ...(repo ? { repo } : {}) };
    }
    const elsewhere = a.do === 'new_idea' || a.do === 'new_card' ? this.otherCanvas(a.canvas) : undefined;
    if (typeof elsewhere === 'string' && elsewhere.startsWith('unknown')) return elsewhere;
    const there = elsewhere ? { canvas: elsewhere } : {};
    if (a.do === 'new_idea') {
      if (!a.title?.trim()) return 'a new idea needs a title';
      const repo = elsewhere ? undefined : this.newCardRepo(a);
      return { do: 'newIdea', title: a.title.trim(), body: a.body ?? '', ...(repo ? { repo } : {}), ...there };
    }
    if (a.do === 'new_card') {
      if (!a.title?.trim()) return 'a new card needs a title';
      const repo = elsewhere ? undefined : this.newCardRepo(a);
      const from = a.card ? s.tags.get(a.card) : undefined;
      if (a.card && (!from || !this.o.board.item(from))) return `unknown tag ${a.card}; give the card a follow-up comes from, or none`;
      const until = a.until?.trim() ? localTime(a.until) : undefined;
      if (until !== undefined && Number.isNaN(until)) return 'until is no time: the local time as YYYY-MM-DDTHH:MM';
      if (until !== undefined && until <= Date.now()) return 'that time has passed: leave until out to start it now';
      if (until !== undefined && until > Date.now() + SNOOZE_LIMIT) return 'until lies more than a year ahead';
      return { do: 'newCard', title: a.title.trim(), body: a.body ?? '', start: a.start !== false, ...(until !== undefined ? { until: new Date(until).toISOString() } : {}), ...(repo ? { repo } : {}), ...(from ? { from } : {}), ...there };
    }
    const id = a.card ? s.tags.get(a.card) : undefined;
    const card = id ? this.o.board.item(id) : undefined;
    if (!card) return `unknown tag ${a.card ?? '(none)'}`;
    const reviewable = handedOver(card);
    const is = `it is ${card.need ? `${card.state}: ${card.need}` : card.state}`;
    // an accepted proposal its agent withdrew or replaced goes or stays, whatever it is now
    if (card.superseded && (a.do === 'dismiss' || a.do === 'keep')) return { do: a.do, card: card.id };
    if (a.do === 'keep') return `its agent has not withdrawn or replaced the card (${is})`;
    if (card.prototypeOf && a.do === 'drop') return { do: 'discard', card: card.id };
    if (card.prototypeOf && a.do === 'build') {
      const project = this.o.board.projectOf(card.prototypeOf);
      if (!project) return { do: 'buildPrototype', card: card.id };
      if (!a.cards?.length && prototypeWorkstream(this.o.board.items(), project.id)) return { do: 'buildPrototype', card: card.id };
      const ws = a.cards?.length === 1 ? s.tags.get(a.cards[0]!) : undefined;
      if (!ws || this.o.board.item(ws)?.parent !== project.id)
        return `the prototype's idea is the project "${project.title}" now, and its plan doc does not say which workstream builds on the prototype: name the one with cards (its tag)`;
      return { do: 'buildPrototype', card: card.id, workstream: ws };
    }
    // the agent that passed the request on has the owner's words already
    if (card.id === s.reading?.from && (TO_AGENT as string[]).includes(a.do))
      return "the owner's words reached this card's agent already, which passed on what it asks of Obeya: do that, or reply";
    // a planned task of the owner's can be planned as a project too
    if (a.do === 'plan_doc' && card.state !== 'idea') {
      if (!plannableAsProject(card)) return `only an idea, or a planned task of the owner's that nobody has worked on yet, can be planned as a project (${is})`;
    } else if (['discuss', 'build', 'split_off', 'plan_doc', 'prototype', 'park', 'drop'].includes(a.do) !== (card.state === 'idea'))
      return card.state === 'idea' ? `the card is an idea: discuss it, or build, split_off, plan_doc, prototype, park or drop it` : `only an idea can be discussed, built, prototyped, parked or dropped (${is})`;
    // built or started in a repository that does not exist yet
    if ((a.do === 'build' || a.do === 'start') && a.path?.trim()) {
      const path = a.path.trim();
      if (!folderPath(path)) return `${path} is no folder: give it absolute or from ~`;
      if (card.state !== 'idea' && (card.state !== 'planned' || card.source !== 'manual' || card.prototypeOf || card.queue || card.workspace || card.branch))
        return `only an idea, or a planned task of the owner's nobody has worked on yet and not with Obeya, is built in a new repository (${is})`;
      return { do: 'newRepo', card: card.id, path, canvas: a.own_canvas !== false };
    }
    switch (a.do) {
      case 'discuss':
        if (!a.text?.trim()) return 'the text is missing';
        return { do: 'discuss', card: card.id, text: a.text.trim() };
      case 'prototype':
        return { do: 'prototype', card: card.id, text: a.text?.trim() ?? '' };
      case 'plan_doc':
        return { do: 'planDoc', card: card.id };
      case 'split_off':
        if (!card.idea?.split) return "its agent has marked no task to split off the idea: build it all (build), or pass on to it what the owner wants built now (discuss)";
        return { do: 'splitOff', card: card.id };
      case 'note':
      case 'answer':
      case 'feedback': {
        if (!a.text?.trim()) return 'the text is missing';
        // a card waiting to start holds the note for the worker that takes it on
        if (a.do === 'note' && !['working', 'inPr', 'waiting'].includes(card.state) && !card.finishing && !askable(card) && !holdsNotes(card)) return `no agent works on this card (${is}), a note cannot reach it`;
        if (a.do === 'answer' && !card.question) return `the card has no open question (${is})`;
        if (a.do === 'feedback' && !reviewable) return `the card does not wait for review (${is})`;
        return { do: a.do, card: card.id, text: a.text.trim() };
      }
      case 'start':
        if (card.kind === 'project') {
          if (!this.o.board.items().some((i) => i.parent === card.id && i.state === 'planned' && !i.queue))
            return 'the project has no planned workstream left that is not already with Obeya';
          break;
        }
        if (card.state !== 'planned') return `only a planned card can be started (${is})`;
        if (card.queue && 'behind' in card.queue) return { do: 'force', card: card.id };
        if (card.queue && 'workspace' in card.queue) return 'the card waits for a free workspace and starts by itself once one is free';
        if (card.queue && 'paused' in card.queue) return "the owner paused this canvas's agents: the card starts by itself once they resume them";
        if (card.queue) return 'Obeya is still checking the card; it starts by itself unless it collides';
        break;
      case 'dequeue':
        if (card.state !== 'planned' || !card.queue) return `the card is not in the queue (${is})`;
        break;
      case 'approve': {
        if (!reviewable) return `the card does not wait for review (${is})`;
        const repo = this.o.board.canvas.repos.find((r) => r.id === card.repo);
        // where work lands on main anyway, approving it directly is approving it
        if (!a.direct || !repo?.pullRequests) break;
        if (card.prototypeOf) return 'a prototype never lands; approving it throws it away';
        // the owner hears why rather than getting a pull request they did not want
        if (!repo.direct) return `the repository ${card.repo} lands approved work only through a pull request; it does not allow pushing it directly onto main. Tell the owner so with reply, and approve without direct only once they want the pull request`;
        // past the pull request goes only by the card's button, never by word
        const button = MESSAGES[this.o.board.language()].quote(MESSAGES[this.o.board.language()].approveDirect);
        return `nothing was approved: approval by word never pushes past the pull request. Tell the owner so with reply: straight onto main goes by the button ${button} on the card; approved without direct, the work goes out as a pull request`;
      }
      case 'accept':
      case 'dismiss':
        if (card.state !== 'proposal') return `the card is no proposal (${is})`;
        // passed on by its reviser, accepting waits for the reworked text, as the button does
        if (a.do === 'accept' && card.proposal?.revising && card.id !== s.reading?.from)
          return 'the proposal is being reworked by what the owner said; accepting it goes by a click, which waits for the new text: drop this action and say so in confirm';
        if (a.do === 'accept' && a.idea) return { do: 'accept', card: card.id, idea: true };
        break;
      case 'revise':
        if (card.state !== 'proposal') return `only a proposed card can be revised (${is})`;
        if (!a.text?.trim()) return 'the text is missing';
        if (card.proposal?.revising) return 'the proposal is still being reworked by what the owner said before; reply that the new text comes in a moment, and to say it again then';
        return { do: 'revise', card: card.id, text: a.text.trim() };
      case 'stop':
        if (card.state !== 'working' && card.state !== 'waiting' && !card.finishing) return `no agent works on this card (${is})`;
        break;
      case 'pause':
        if (card.paused) return 'its agent is paused already';
        if (!pausableNow(card)) return `its agent is not working on anything right now, so there is nothing to pause (${is})`;
        break;
      case 'resume':
        if (!halted(card)) return card.snoozed ? `its agent is snoozed, not paused: wake wakes it (${is})` : `its agent is not paused (${is})`;
        break;
      case 'snooze': {
        if (!snoozable(card)) return `the card is neither planned, at work nor waiting for the owner, so there is nothing to snooze (${is})`;
        const at = a.until ? localTime(a.until) : NaN;
        if (Number.isNaN(at)) return 'until is missing: the local time as YYYY-MM-DDTHH:MM';
        if (at <= Date.now()) return 'that time has passed';
        return { do: 'snooze', card: card.id, until: new Date(at).toISOString() };
      }
      case 'wake':
        if (!card.snoozed) return `the card is not snoozed (${is})`;
        break;
    }
    return { do: a.do, card: card.id };
  }

  private interpret(transcript: string, focus: Focus, images: string[], input: Input): Promise<Decision> {
    return new Promise((decide, fail) => {
      this.turns = this.turns.then(() => this.read(transcript, focus, images, input, decide)).catch(fail);
    });
  }

  /** Reads one command; settles when the turn has ended, while the decision goes out as soon as it is taken. */
  private async read(transcript: string, focus: Focus, images: string[], input: Input, decide: (d: Decision) => void, retry = true): Promise<void> {
    const warmed = this.live();
    const s = warmed ?? (this.session = this.open());
    let decided = false;
    const ended = new Promise<Error | undefined>((end) => {
      s.reading = {
        ...(input.forwarded && focus.card ? { from: focus.card } : {}),
        finish: (commands, confirm, lookUp, more) => {
          if (decided) return 'Already decided.';
          decided = true;
          decide({ commands, confirm: confirm.trim(), ...(lookUp ? { lookUp } : {}), ...more });
          return 'Done. End your turn now.';
        },
        end,
      };
    });
    const files = this.o.imageFiles?.(images) ?? [];
    s.agent.send(this.brief(s, transcript, focus, input, files.length), files);
    const error = await ended;
    s.reading = undefined;
    if (error && !decided) {
      // a session that waited or talked before may have gone stale: read the command once more in a fresh one
      if (warmed && retry && !(error instanceof LimitError)) return this.read(transcript, focus, images, input, decide, false);
      throw error;
    }
    if (!decided) decide({ commands: [], confirm: this.o.board.t.voice.notUnderstood });
    if (s.read >= (this.o.sessionCommands ?? 30)) {
      // long enough: the next session starts from the stored memory, so the context stays short
      s.ended = true;
      s.agent.close();
      this.session = null;
      this.warm();
    }
  }

  /** The card a wait was on, as it stands now, with its worker's summary; none once it is gone. */
  private awaitedCard(id: string, items: Item[], describe: (i: Item) => string): string {
    const card = items.find((i) => i.id === id);
    return card ? `\nThe card now: ${describe(card)}${this.report(card)}` : '';
  }

  /** What the open card's worker handed over: its summary in full, so a follow-up carries what it is about. */
  private report(card: Item): string {
    const summary = this.o.board.summary(card.id)?.trim();
    return summary ? `\n\nIts worker's summary:\n${summary}` : '';
  }

  /** The message for one command: what the Koordinator needs to know besides what it already knows. */
  private brief(s: Session, transcript: string, focus: Focus, input: Input, shots = 0): string {
    const { items, groups: groupList } = this.o.board.snapshot();
    const groups = new Map(groupList.map((g) => [g.id, g.name]));
    const relevant = items.filter((i) => i.kind !== 'project' && (!finished(i.state) || i.finishing || i.kind === 'question' || i.id === focus.card));
    const tag = (id: string) => {
      let t = s.tagOf.get(id);
      if (!t) {
        t = `K${s.tags.size + 1}`;
        s.tags.set(t, id);
        s.tagOf.set(id, t);
      }
      return t;
    };
    const describe = (i: Item) => {
      const project = i.parent ? items.find((p) => p.id === i.parent) : undefined;
      const state = i.queue
        ? queued(i.queue, items)
        : i.need
          ? `${i.state}: ${i.need}${answering(i) ? ", its agent works on the owner's answer to the question in its demo report" : i.answered ? ', its agent answered what the owner wrote on its handover' : ''}`
          : i.idea && i.idea.status !== 'open'
            ? `idea: ${i.idea.status}`
            : i.idea?.thinking
              ? `idea, its agent is working on its reply${i.idea.buildAfterReply ? '; built once the reply is there, unless it asks questions' : ''}`
            : i.kind === 'question'
              ? `question card: a thread of answers you looked up, moved onto a card; its agent ${i.thread?.thinking ? 'is reading' : 'answers what the owner asks on it (note)'}`
            : i.finishing
              ? i.followUp
                ? `${i.state}, its agent answers the owner's follow-up${i.waitsForClone ? '; it needs a full clone for that and waits for the next free one, then goes on by itself' : ''}`
                : `${i.state}, its agent finishes what remains${i.state === 'done' ? ' (nothing to land: the work changed no code)' : ' after the landing'}`
              : askable(i)
                ? `${i.state}, its agent's session has ended; a note resumes it to answer`
                : i.state;
      const paused = i.snoozed
        ? `; snoozed by ${i.snoozed.by === 'agent' ? 'its agent' : 'the owner'} until ${i.snoozed.on ? `the card „${i.snoozed.on.title}“ ${i.snoozed.on.state === 'done' ? 'is done' : 'waits for the owner'}${i.snoozed.until ? `, ${when(i.snoozed.until)} at the latest` : ''}` : when(i.snoozed.until!)}${i.snoozed.why ? ` (then: ${clip(oneLine(i.snoozed.why), 120)})` : ''}${i.snoozed.waiting ? ': it waits for the owner again then, and is not on their list until then' : i.snoozed.start ? ': it starts then; start or wake starts it now' : ': nothing of its agent runs until then; a note or wake wakes it earlier'}`
        : i.paused
        ? '; its agent is paused by the owner: nothing of it runs until resume or what the owner says to it, which it goes on with'
        : i.pausing
        ? '; the owner asked its agent to pause at a safe point: it ends its turn once the step it is in is done, and is paused then; resume or what the owner says to it lets it work on instead'
        : i.inTurn && i.state !== 'working'
          ? '; its agent is working on something right now'
          : i.background?.length
            ? `; its agent's turn is over, its background work still runs (${i.background.map((b) => clip(oneLine(b.description), 80)).join('; ')})`
            : '';
      const repo = this.o.board.canvas.repos.length > 1 ? ` in ${i.repo}` : '';
      const idea = i.prototypeOf ? items.find((x) => x.id === i.prototypeOf) : undefined;
      const became = i.prototypeOf ? items.find((x) => x.kind === 'project' && x.origin === i.prototypeOf) : undefined;
      const builds = became && prototypeWorkstream(items, became.id);
      const group = i.group ? groups.get(i.group) : undefined;
      return `${tag(i.id)} [${state}${paused}] "${i.title}"${repo}${project ? ` (project "${project.title}")` : ''}${group ? ` (group "${group}")` : ''}${became ? ` (prototype of the idea "${i.ideaTitle ?? ''}", which became the project ${tag(became.id)} "${became.title}"${builds ? `; build starts its workstream ${tag(builds.id)} "${builds.title}" on it` : ''}${i.buildProposal ? '; its worker proposes to build on it' : ''})` : idea ? ` (prototype of ${tag(idea.id)} "${idea.title}"${i.buildProposal ? '; its worker proposes to build the idea on it' : ''})` : ''}${i.proposal ? ` — proposed ${i.proposal.idea ? 'idea' : 'task'}${i.proposal.startAt && i.state === 'proposal' ? `, to start ${when(i.proposal.startAt)} once accepted (it waits until then)` : ''}${i.proposal.revising ? `, being reworked by what the owner said${i.proposal.acceptAfterRevision ? `; accepted${i.proposal.acceptAfterRevision === 'idea' ? ' as an idea' : ''} once the new text is there, unless it asks questions` : ''}` : ''}` : ''}${i.superseded ? ` — the agent that proposed it ${i.superseded.by ? `replaced it by "${i.superseded.title ?? ''}"` : 'withdrew it'}${i.superseded.why ? ` (${clip(oneLine(i.superseded.why), 200)})` : ''}; the owner removes it (dismiss) or keeps it (keep)` : ''}${i.statusLine ? ` — status: ${clip(oneLine(i.statusLine), 160)}` : ''}${asks(i)}${i.idea?.next ? ` — its agent would ${NEXT_ACTION[i.idea.next.step]} next: ${clip(oneLine(i.idea.next.why), 200)}` : ''}${i.idea?.variants.length ? ` — prototypes its agent planned: ${i.idea.variants.map((v) => v.approach).join(', ')}` : ''}${i.idea?.split ? ` — task its agent marked to split off now (split_off): "${clip(oneLine(i.idea.split.title), 160)}"` : ''}${i.newRepo ? ` — to be built in a new repository ${i.newRepo.path || '(no folder named yet)'}${i.newRepo.canvas ? ' with a canvas of its own' : ' on this canvas'}, as ${i.newRepo.by === 'owner' ? 'the owner' : "its idea's agent"} chose${i.newRepo.due ? '; Obeya creates it in a few seconds unless the owner takes it back on the card' : ''}` : ''}`;
    };
    const step = (m: Moment) => {
      const card = items.find((i) => i.id === m.cardId);
      // a card no longer shown (its plan doc is gone) is no longer talked about
      if (!card) return [];
      const what =
        m.kind === 'created'
          ? m.author === 'owner'
            ? 'new card'
            : 'proposed by an agent'
          : `${STEP[m.kind] ?? ''}${clip(oneLine(m.text), 200)}`;
      return [`- ${when(m.at)} ${tag(m.cardId)} "${card.title}": ${what}`];
    };
    const now = new Date().toISOString();
    // what is written from here on comes with the next command
    const mark = this.o.board.mark();
    const first = s.read === 0;
    let history: string[];
    if (first) {
      // without the words being read now
      const talk = this.o.board.talk(REMEMBERED_EXCHANGES).filter((t) => t.reply !== undefined);
      const full = new Set(talk.filter((t) => t.answer !== undefined).slice(-FULL_ANSWERS));
      const steps = this.o.board.timeline(new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString(), HISTORY_STEPS);
      history = [
        talk.length
          ? `Your conversation with the owner before this session (oldest first; card tags did not exist then):\n${talk
              .map((t) => {
                const open = t.cardId ? items.find((i) => i.id === t.cardId) : undefined;
                const later =
                  t.answer !== undefined
                    ? ` → the answer ${answerTag(t.id)} you looked up${t.follows ? ` (following up on ${answerTag(t.follows)})` : ''}: "${full.has(t) ? t.answer : clip(oneLine(t.answer), 400)}"${t.then ? ` (you are about to take the step you looked it up for: ${t.then})` : ''}`
                    : t.question
                      ? ' (you were looking it up; no answer came)'
                      : '';
                if (t.moved) return `- ${when(t.at)} the card "${t.moved.title}" moved to the canvas "${t.moved.canvasName}", in a new repository, and is built there`;
                const words = t.after
                  ? `${became(t.after)}, and you took up the step you had waited on it for`
                  : t.answered
                    ? `the answer ${answerTag(t.answered)} came in, and you took up the step you had looked it up for`
                    : `the owner: "${t.said}"`;
                return `- ${when(t.at)}${open ? ` (with "${open.title}" open)` : ''} ${words} → you: "${t.reply}"${t.undone ? ' (the owner took it back)' : ''}${t.waits?.length ? ` (you wait on ${t.waits.map((w) => `"${w.title}"`).join(', ')} for it)` : ''}${later}`;
              })
              .join('\n')}`
          : 'You have not talked with the owner before.',
        `What happened on the canvas in the last ${HISTORY_DAYS} days (oldest first):\n${steps.flatMap(step).join('\n') || '(nothing)'}`,
      ];
    } else {
      const steps = this.o.board.timeline(s.since!, NEWS_STEPS + 1);
      const more = steps.length > NEWS_STEPS ? steps.splice(0, steps.length - NEWS_STEPS).length : 0;
      history = steps.length ? [`What happened on the canvas since the owner's last command:\n${more ? `- (${more} earlier steps left out)\n` : ''}${steps.flatMap(step).join('\n')}`] : [];
    }
    s.read++;
    s.since = mark;
    const news = this.news.splice(0);
    const rules = this.o.board.preferences('active');
    s.rules = rules.map((r) => r.id);
    const focused = focus.card ? relevant.find((i) => i.id === focus.card) : undefined;
    const project = focus.project ? items.find((i) => i.id === focus.project) : undefined;
    // projects with workstreams to start: start on one hands them all to the Koordinator
    const projects = items.flatMap((p) => {
      if (p.kind !== 'project') return [];
      const open = items.filter((i) => i.parent === p.id && i.state === 'planned' && !i.queue);
      return open.length ? [`${tag(p.id)} [project] "${p.title}" — planned workstreams not yet started: ${open.map((i) => i.label ?? i.title).join(', ')}`] : [];
    });
    return [
      `Now: ${when(now)}.`,
      ...history,
      ...news,
      ...(input.answered
        ? [
            `No words of the owner's this time: you take up a step you said you would take once you had looked something up. ${when(input.answered.at)} the owner ${input.answered.said ? `said: "${input.answered.said}"` : 'asked'}, and you answered: "${input.answered.promised}", looking up: "${input.answered.question}", to then: ${input.answered.then}`,
            `The answer ${answerTag(input.answered.from)} is in (the owner sees it too): ${input.answered.answer}`,
            "Take that step now with act, as you said you would, from what the answer says. Where the answer does not allow it (the look-up failed, or found nothing to act on), tell the owner with reply instead. The owner reads your confirm as a notice and can take the actions back.",
          ]
        : input.after
        ? [
            `No words of the owner's this time: you take up a step you said you would take. ${when(input.after.at)} the owner ${input.after.said ? `said: "${input.after.said}"` : 'had a step of yours waiting'}, and you answered: "${input.after.promised}", waiting until the card "${input.after.title}" ${until(input.after.state)}, to then: ${input.after.then}`,
            `Now ${became(input.after)}.${this.awaitedCard(input.after.card, items, describe)}`,
            input.after.met === 'reached'
              ? 'Take that step now, with act (and config before configure), as you said you would. Where it no longer fits what happened since (the card\'s summary, the canvas), tell the owner with reply instead. The owner reads your confirm as a notice and can take the actions back.'
              : 'The step waited for something that did not happen: tell the owner with reply what became of the card and that you did not take the step, unless taking it still makes sense.',
          ]
        : input.forwarded
        ? [
            `The agent of the open card passes on a request from what the owner told it, asking Obeya for something: "${input.forwarded}"`,
            input.forwarded === transcript
              ? ''
              : input.task
                ? `The owner said nothing on the card yet; its task counts as the owner's own words (they typed it, you wrote it from what they said, or they accepted it from an agent's proposal): "${transcript}"`
                : `The owner's own words to it, ${input.typed ? 'typed (as written, no recognition errors)' : 'spoken (speech recognition, may contain errors)'}: "${transcript}"`,
          ].filter(Boolean)
        : [
            input.typed
              ? `The owner typed${focused && input.field ? ` into ${FIELDS[input.field]}` : ''} (as written, no recognition errors): "${transcript}"`
              : `The owner said (speech recognition, may contain errors): "${transcript}"`,
            // in reply to a message of the open card's conversation, or of the sheet
            (focused ? replyNote(this.o.board.quoted(focused.id, input.replyTo), 'koordinator') : focus.card ? '' : talkReplyNote(this.o.board.quotedTalk(input.replyTo))).trim(),
          ].filter(Boolean)),
      ...(input.heldSince
        ? [`The owner said this ${when(input.heldSince)}, but the account's usage limit kept you from reading it until now; the canvas may have changed since. Obeya told them it would read it once the limit lifted.`]
        : []),
      ...(shots
        ? [
            `The owner attached ${shots === 1 ? 'a screenshot' : `${shots} screenshots`} (shown below). Obeya gives ${shots === 1 ? 'it' : 'them'} to every new_card, new_idea, start, note, answer, feedback, discuss and revise action you take for this message; a title for a new card may say what ${shots === 1 ? 'it shows' : 'they show'}.`,
          ]
        : []),
      focused && (input.after || input.answered) ? `They said it with this card open: ${describe(focused)}` : focused ? `The owner has this card open, so "it", "this" and a bare answer refer to it: ${describe(focused)}${this.report(focused)}` : project ? `The owner is looking at the project ${tag(project.id)} "${project.title}".` : 'No card is open: the owner speaks to you.',
      `Cards on the canvas now:\n${relevant.map(describe).join('\n') || '(none)'}`,
      ...(projects.length ? [`Projects with workstreams to start:\n${projects.join('\n')}`] : []),
      ...(this.waits().length
        ? [`Cards you wait on, to take a step once each gets there (wait_for; stop_waiting drops one):\n${this.waits().map(({ talk, wait }) => `- ${tag(wait.card)} "${wait.title}" until it ${until(wait.state)} (since ${when(talk.at)}), then: ${wait.then}`).join('\n')}`]
        : []),
      `Groups on the canvas: ${groupList.map((g) => `"${g.name}"`).join(', ') || '(none yet)'}`,
      rules.length
        ? `The owner's rules, which every agent follows (follow them yourself too):\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}`
        : 'The owner has recorded no rules yet.',
      ...(this.o.canvases?.().length ? [`Other canvases of this Obeya (new_card and new_idea go there with canvas): ${this.o.canvases().map((c) => `"${c.name}"`).join(', ')}`] : []),
      `Repositories on this canvas (the first is the default for a new card): ${this.o.board.canvas.repos.map((r) => `${r.id} (${r.name}${r.pullRequests ? `; approved work goes out as a pull request${r.direct ? ", or directly onto main by the card's button" : ''}` : ''})`).join(', ')}`,
    ].join('\n\n');
  }
}

/** How a step of a card's history reads. */
const STEP: Partial<Record<Moment['kind'], string>> = {
  question: 'the agent asked: ',
  answer: 'answer: ',
  review: 'handed over for review: ',
  hint: "the owner's note: ",
  error: 'error: ',
};

/**
 * What the Koordinator reads above the owner's words that reply to a message of its sheet: which
 * one, whole, since it reads each command afresh; a looked-up answer by its tag, to follow up on it.
 */
export function talkReplyNote(quoted: TalkQuote | undefined): string {
  if (!quoted) return '';
  const whose =
    quoted.part === 'said'
      ? 'their own earlier message'
      : quoted.part === 'reply'
        ? 'your reply'
        : `the answer ${answerTag(quoted.talk)}${quoted.by === 'project' ? " the project's agent" : ' you'} looked up`;
  return `[In reply to ${whose}: „${excerpt(quoted.text.replace(/\s+/g, ' ').trim(), 2000)}“]\n\n`;
}

/** A queued card's state as the Koordinator reads it. */
function queued(q: Queue, items: Item[]): string {
  if ('checking' in q) return 'queued: Obeya checks it for merge conflicts';
  if ('paused' in q) return "waits for the owner to resume this canvas's paused agents; starts by itself then";
  if ('workspace' in q && q.workspace === 'slots') return 'waits for a free slot (every machine with a free workspace has as many workers busy as it has slots); starts by itself once one is done';
  if ('workspace' in q) return `waits for a free workspace (${q.workspace === 'dirty' ? 'every free one has uncommitted changes' : 'all are leased'}); starts by itself once one is free`;
  const titles = q.behind
    .map((id) => {
      const i = items.find((x) => x.id === id);
      return `"${i?.title ?? id}"${i && notStarted(i) ? ' (not started yet)' : ''}${q.buildsOn?.includes(id) ? ' (builds on it)' : ''}`;
    })
    .join(', ');
  return `queued behind ${titles}`;
}


/** What became of a card the Koordinator waited on, as it reads it. */
const became = (a: Pick<TalkAfter, 'title' | 'met' | 'state'>) =>
  `the card "${a.title}" ${{ reached: a.state === 'done' ? 'is done' : 'waits for the owner', gone: 'is gone (removed)', archived: 'was archived', stopped: 'was stopped by the owner (planned again)', dropped: 'was dropped' }[a.met]}`;

/** What the Koordinator waits for a card to reach. */
const until = (state: AwaitedState) => (state === 'done' ? 'is done' : 'waits for the owner');

/**
 * A time the Koordinator gives (`until`), in ms: local, as it is told to write it; a day without an
 * hour is 08:00 that day, where `Date.parse` would read it as midnight in UTC.
 */
const localTime = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? `${s.trim()}T08:00` : s.trim());

/** A time as the Koordinator reads it: local, to the minute, with the weekday. */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Examples of the confirmations the Koordinator speaks, and the owner's words for its cards, per language. */
const CONFIRM: Record<Language, { act: string; words: string; remember: string; retro: string; reviewPr: string; group: string; merge: string; configure: string; lookUp: string; lookUpThen: string; idea: string; wish: string }> = {
  de: {
    act: '"Neue Aufgabe „Zählerstände als CSV“, der Agent fängt an." / "„Rabatt“ freigegeben, und die Folgeaufgabe „Archiv“ ist angelegt." / "An den Agenten von „Export“ weitergegeben."',
    words: 'In German, a card is an „Aufgabe“ (a follow-up: „Folgeaufgabe“), an idea „Idee“, a project „Projekt“; never say „Karte“. The owner may still say „Karte“ and means the same.',
    remember: '„Gemerkt, gilt ab sofort für alle Agenten.“ / „Kommt in die CLAUDE.md von <repository name>, über die Aufgabe „CLAUDE.md ergänzen“.“',
    retro: '„Ich mache die Arbeitsrückschau für den Shop; Vorschläge erscheinen als Karten.“',
    reviewPr: '„Ich lege eine Review-Karte für PR #5 an, mit Blick auf Security.“',
    group: '„„Export“ und „Rabatt“ gehören jetzt zur Gruppe Abrechnung.“',
    merge: '„Ich führe „Login-Fehler“ und „Neu anmelden“ zu „Neu anmelden, wann und wo“ zusammen.“',
    configure: '„Das Repository shop-web kommt auf die Leinwand Shop.“ / „shop-web bekommt einen dritten Klon; seine Agenten starten neu, sobald sie pausieren.“',
    lookUp: '„Ich schaue im Plan nach.“ / „Moment, ich lese nach, was der Agent bei „…“ tun würde.“',
    lookUpThen: '„Ich lese die offenen Issues auf GitHub und lege dann für jedes eine Aufgabe an.“',
    idea: '„Neue Idee „Erlaubte Datenbankabfragen“, zum Durchdenken mit dir.“',
    wish: '„Der Entwurf für die Macher von Obeya ist offen: prüf ihn und schick ihn auf GitHub ab.“',
  },
  en: {
    act: '"New task “Meter readings as CSV”, the agent starts." / "“Discount” approved, and the follow-up “Archive” is created." / "Passed on to the agent of “Export”."',
    words: 'In English, a card is a “task” (a follow-up: “follow-up”), an idea “idea”, a project “project”; never say “card”. The owner may still say “card” and means the same.',
    remember: '“Noted, it applies to all agents from now on.” / “It goes into the CLAUDE.md of <repository name>, through the task “Add to CLAUDE.md”.”',
    retro: '“I am running the work retrospective for the shop; proposals appear as cards.”',
    reviewPr: '“I am starting a review card for PR #5, with an eye on security.”',
    group: '““Export” and “Discount” now belong to the group Billing.”',
    merge: '“I am merging “Login error” and “Sign in again” into “Sign in again: when and where”.”',
    configure: '“The repository shop-web joins the canvas Shop.” / “shop-web gets a third clone; its agents restart once they paused.”',
    lookUp: '“Let me look at the plan.” / “One moment, I am reading what the agent would do on “…”.”',
    lookUpThen: '“I am reading the open issues on GitHub and will then create a task for each.”',
    idea: '“New idea “Allowed database queries”, to think through with you.”',
    wish: '“The draft for Obeya’s makers is open: check it and submit it on GitHub.”',
  },
};

const system = (language: Language, ui: Language) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents by voice or typing; the owner knows you simply as Obeya. Each message brings what the owner just said or typed. Speech is transcribed by speech recognition: words may be misheard, so read for what they most likely meant, using the card titles as vocabulary. Typed text stands as written.

This is one ongoing conversation. The owner refers back to it ("the card from before", "no, the other one", "that one too"), and to how the canvas developed: each message says what happened since the previous one, and the first brings your memory of earlier conversations and the canvas's recent history. Card tags (K1, K2, …) stay the same throughout this conversation. No agent works on a planned, live or done card (done: finished without any change to the code, so nothing landed), but a note to a live or done card whose line says so resumes the agent that did its work, to answer; a workstream of a project takes its state from the project's plan doc (checked off there means live).

For each message, call act, reply or look_up once, then end your turn:
- act, with every action the owner asked for, in their order, on the cards they meant (the open card unless they name another). One sentence may hold several ("gib das frei und mach eine Folgeaufgabe …" is approve and new_card, with the open card as the one it follows up on): leave none out. A step that can only follow once a card gets somewhere (a canvas for the repository a new task creates, a start once another card has landed) is wait_for in the same act: Obeya wakes you when the card gets there, and you take the step then.
- reply, when the owner asks you a question of fact you can answer from what you know (the cards, their states and history, this conversation), also about the open card, or when nothing fits or it is unclear which card or what is meant.
- look_up, when the answer needs reading or checking: what an agent would do on a card ("Was würde der Agent hier machen, wenn ich starte?"), what the plan says, how or why something works, what is on the machine or on GitHub (which file is newest, whether a script ran, what a release holds). Never reply that you cannot know or predict it; look it up. The answer follows in a few seconds. Also when the actions the owner asks for depend on such reading (a task for each open GitHub issue): look_up with then, and you take the actions yourself once the answer is in; confirm names both, the reading and the actions to follow.
All three take confirm: one short sentence in the owner's language (two at most for an answer or several actions) the owner hears back, saying what will happen, naming the cards (${CONFIRM[language].act}). No preamble, no questions back unless you use reply. ${ownersLanguage(language)} A new card's or idea's title is in the owner's language too.
${LANGUAGES.map((l) => CONFIRM[l].words).join('\n')}
A card's agent is Claude Code with the shell, git, gh and the web, on the machine its repository's workers run on: with the owner's permission it does any work there, in its repository or outside it (create a new repository, install a tool, convert files, run a script). Work the owner asks to have done is new_card, also when it is no change to code.
What the owner wants Obeya's makers told (a wish for Obeya, a bug in it) is act with wish: it opens the owner's draft for them, which they send themselves. When what they ask of you is something Obeya has no feature for, reply that it cannot, with wish: the owner gets a link to send that to the makers.
Questions about Obeya's configuration (which canvases and repositories it serves, their settings, clones, port) you answer with reply after reading it with config; a change to it the owner asks for is configure.
When the owner wants something kept for all future work ("Merk dir …", "ab jetzt immer …", "nie wieder …"), that is remember, not a note to the open card's agent. Decide where it goes: only a rule on how the agents work with the owner through Obeya, whatever the repository, is one of the owner's rules (no repos); anything about a repository (named, "hier", "in diesem Repo", or about its code, UI, wording, tests, tools or product) goes into that repository's CLAUDE.md: pass repos. Leave the place out of the rule's text, and say in confirm where it went (for a CLAUDE.md: into the repository's card ${MESSAGES[ui].quote(MESSAGES[ui].claudeMd.title)}, which writes it into the file).
What the owner says or types with a card open that an agent works on (working, in PR, waiting, waiting for review, finishing what remains, a live or done card a note resumes its agent on, an idea with its exploration agent) goes straight to that agent, not to you. The agent passes on to you what asks Obeya for something rather than the agent: approve, pause, stop, start, a follow-up or new card, a new idea, remember, grouping cards, an action on another card, a question about the canvas or another card, a wish or a bug for Obeya's makers. Such a message brings the agent's request and the owner's own words; that card is the open one. Do what the owner asked of Obeya, as with any command (act, reply or look_up); the agent has their words already, so pass nothing back to it as note, answer, feedback or discuss. Your confirm goes back to the agent and to the owner.
When the open card is a proposal, what the owner says about it (what should be added, dropped, decided or put differently, or their thoughts on it) is revise with their words, unless they clearly accept or dismiss it or ask for something else.
On an idea, "Mach, was du vorschlägst" takes the step its agent would take next, as its line says; when that is answering, discuss with the options its agent would pick for its open questions. Wanting to think about something, rather than have it done, is new_idea. So is asking you for an opinion or a way forward rather than a fact ("Was meinst du, was wir da jetzt machen sollen?", "Wie sollten wir … angehen?", "Was hältst du davon, …?"): such a discussion belongs on an idea card, where its exploration agent opens it. body: the owner's words as they are (their screenshots go along); confirm names the idea (${CONFIRM[language].idea}). A question of fact (what the plan says, what happened, what an agent would do) stays reply or look_up. A wrong guess costs one idea card, which the owner takes back with undo, so go ahead.
`.trim();

/** Whether an agent is on the card: working on it, waiting for the owner, in a PR, or finishing what remains after the landing. */
const hasAgent = (i: Item) => agentListens(i) && i.state !== 'idea' && i.state !== 'proposal';

/** Why a card is no planned task nobody has worked on yet (`untouched`), as the Koordinator reads it; none where it is one. */
function notUntouched(i: Item): string | undefined {
  if (untouched(i)) return undefined;
  if (i.state === 'proposal') return 'is a proposal (dismiss it instead)';
  if (i.state === 'idea') return 'is an idea (drop it instead)';
  if (i.kind !== 'task') return `is a ${i.kind}`;
  if (i.state !== 'planned') return `is ${i.state}`;
  if (i.source === 'plan') return 'is a workstream of a plan doc (changed there)';
  if (i.prototypeOf) return 'is a prototype';
  if (i.queue) return 'is with Obeya to start (dequeue it first)';
  if (i.becomesProject) return 'is being planned as a project';
  return 'was worked on already (it has a branch or a workspace)';
}
