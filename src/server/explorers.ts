// Exploration agents: one read-only session per idea, resumed for every message, even days later.
// The owner and the agent talk on the card; the agent keeps the idea's brief, which is what
// remains of the conversation: whoever opens the card later reads the brief, not the talk. The
// brief holds the substance and the replies only the turns, so the two never say the same; how
// the agent got to a reply (what it read and thought) folds away under that reply.

import { basename } from 'node:path';
import { z } from 'zod';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES } from '../core/messages';
import { type Item, type Mock, NEXT_STEPS, type NextStep, type PlannedPrototype, type Question } from '../core/types';
import { decisionLog, toQuestion } from './advisor';
import { BadRequest, type Board, type Message, type Unread } from './board';
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool } from './runtime';
import { imageNote } from './images';
import { describeTool, SPOKEN } from './workers';

export interface ExplorerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the agent reads: the one of the idea's repository. */
  pathFor: (card: Item) => string;
  /** The owner's recorded preferences, as agents read them. */
  preferences?: () => string;
  /** Called with what the owner says, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, text: string) => void;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /** The agent answered all it was told and its session ended (`replied`), or its turn ended without (an error, a restart). */
  onReplied?: (cardId: string, replied: boolean) => void;
}

interface Live {
  session: AgentSession;
  /** The messages the running turn answers. */
  current: Message[];
  /** Messages that arrived during a turn; they go in together once it ends. */
  queue: Message[];
  replied: boolean;
  lastText: string;
  /** The owner spoke: the reply is summed up aloud. */
  speak: boolean;
  /** The turn only takes something into the brief: words without a reply are no reply. */
  quiet?: boolean;
  /** The owner's preferences as the agent last heard them: in its instructions, or since then. */
  preferences: string;
  /** The agent heard that the owner clicked "So bauen" during its turn. */
  toldBuild?: boolean;
}

export class Explorers {
  private live = new Map<string, Live>();

  constructor(private o: ExplorerOptions) {}

  /** The owner says something about the idea, maybe with screenshot files; a parked or dropped idea is open again. */
  discuss(cardId: string, text: string, spoken = false, images: string[] = []) {
    const card = this.idea(cardId);
    const idea = this.o.board.idea(cardId);
    if (idea.status !== 'open') {
      this.o.board.setIdea(cardId, { status: 'open' });
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.idea.reopened);
    }
    this.o.board.log(cardId, 'talk', 'owner', text, undefined, images.map((f) => basename(f)));
    this.o.board.setIdea(cardId, { yourTurn: false, questions: [], next: undefined });
    if (text) this.o.onOwnerInput?.(card, text);
    this.send(card, `The owner says${spoken ? ` (${SPOKEN})` : ''}:\n\n${text}${imageNote(images)}`, spoken, images);
  }

  /**
   * A planned card became an idea, or the owner took up an idea a worker proposed (`proposed`): its
   * agent opens the discussion with what the card says, before the owner writes.
   */
  open(cardId: string, proposed = false) {
    this.tell(cardId, proposed ? OPENING_PROPOSED : OPENING);
  }

  /**
   * Obeya tells the agent something the owner did not say (a prototype's result). `quiet`: it is
   * for the brief only (an answer given on a prototype), and the turn's words are no reply.
   */
  tell(cardId: string, text: string, quiet = false) {
    const card = this.o.board.item(cardId);
    if (!card || card.state !== 'idea') return;
    this.send(card, text, false, [], quiet);
  }

  /** Ends the idea's session; its id stays, so the conversation can go on later. */
  close(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    live?.session.close();
    const card = this.o.board.item(cardId);
    if (card?.idea?.thinking) this.o.board.setIdea(cardId, { thinking: false });
  }

  /**
   * Ends the idea's session in the middle of a turn (parked, dropped, an error): what the agent has
   * not answered yet stays with the idea and goes to it first when the conversation goes on.
   */
  interrupt(cardId: string, why: Unread['why']) {
    const live = this.live.get(cardId);
    if (live) {
      // a reply already given answered the turn's messages
      const messages = [...(live.replied ? [] : live.current), ...live.queue];
      if (messages.length) this.o.board.setIdea(cardId, { unread: { why, messages } });
    }
    this.close(cardId);
  }

  /** After a restart: an idea whose agent was in the middle of a reply gets it. */
  resumeAll() {
    for (const i of this.o.board.snapshot().items) {
      if (i.state !== 'idea' || !i.idea?.thinking) continue;
      if (this.o.board.row(i.id).session_id) this.send(i, 'Obeya was restarted while you worked on your reply. Answer the owner’s last message now.', false);
      else {
        this.o.board.setIdea(i.id, { thinking: false });
        this.o.onReplied?.(i.id, false);
      }
    }
  }

  /**
   * Obeya stops: a session that started resumes with the message of its turn, but what waited for
   * it would be lost; a session that never started loses its turn too.
   */
  shutdown() {
    for (const [cardId, live] of this.live) {
      live.session.close();
      if (this.o.board.item(cardId)?.state !== 'idea') continue;
      const messages = this.o.board.row(cardId).session_id ? live.queue : [...live.current, ...live.queue];
      if (messages.length) this.o.board.setIdea(cardId, { unread: { why: 'restart', messages } });
    }
    this.live.clear();
  }

  private send(card: Item, message: string, spoken: boolean, images: string[] = [], quiet = false) {
    const live = this.live.get(card.id);
    if (live) {
      // queued, it goes in with whatever else came, which may well need a reply
      live.queue.push({ text: message, images });
      live.speak ||= spoken;
      return;
    }
    const row = this.o.board.row(card.id);
    // what an interrupted turn left unanswered goes first
    const { unread } = this.o.board.idea(card.id);
    const current = [...(unread?.messages ?? []), { text: message, images }];
    this.o.board.setIdea(card.id, { thinking: true, unread: undefined });
    const text = unread ? `${UNREAD_NOTE[unread.why]}\n\n${unread.messages.map((m) => m.text).join('\n\n')}\n\n---\n\n${message}` : message;
    const all = current.flatMap((m) => m.images);
    if (row.session_id) return this.launch(card, current, text, row.session_id, spoken, all, quiet);
    // a planned card that became an idea brings the screenshots of its task
    const shots = this.o.imageFiles?.(card.images) ?? [];
    this.launch(card, current, `${this.briefing(card, shots)}\n\n${text}`, undefined, spoken, [...shots, ...all], quiet);
  }

  private launch(card: Item, current: Message[], message: string, resume: string | undefined, speak: boolean, images: string[], quiet = false) {
    const preferences = this.o.preferences?.() ?? '';
    const live: Live = { session: undefined!, current, queue: [], replied: false, lastText: '', speak, quiet, preferences };
    this.live.set(card.id, live);
    live.session = this.o.runtime.start(
      {
        cwd: this.o.pathFor(card),
        readOnly: true,
        role: 'explorer',
        system: system(this.o.board.language()) + (preferences ? `\n\n${preferences}` : ''),
        tools: this.tools(card.id, live),
        contextUpdate: () => [this.buildNote(card.id, live), this.preferencesUpdate(live)].filter(Boolean).join('\n\n') || undefined,
        ...(resume ? { resume } : {}),
        onEvent: (e) => this.onEvent(card.id, live, e),
      },
      message,
      images,
    );
  }

  /** The owner clicked "So bauen" while the agent works: it hears so once, as the brief it leaves becomes the task. */
  private buildNote(cardId: string, live: Live): string | undefined {
    if (live.toldBuild || !this.o.board.item(cardId)?.idea?.buildAfterReply) return;
    live.toldBuild = true;
    return BUILD_AFTER_REPLY;
  }

  /** A preference learned or changed during the session reaches the agent once, with its next tool call. */
  private preferencesUpdate(live: Live): string | undefined {
    const now = this.o.preferences?.() ?? '';
    if (now === live.preferences) return;
    live.preferences = now;
    return now ? `The owner's preferences changed during this conversation; they now read:\n\n${now}` : 'The owner withdrew their standing preferences; none apply any more.';
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    switch (e.type) {
      case 'session':
        this.o.board.work(cardId, { session_id: e.id });
        break;
      case 'text':
        live.lastText = e.text;
        // what it thinks on the way to its reply; words after the reply only close the turn
        if (!live.replied && e.text.trim()) this.o.board.log(cardId, 'say', 'explorer', clip(e.text.trim(), 4000));
        break;
      case 'tool':
        // its own tools show in the conversation and the brief, not as reading
        if (!e.name.startsWith('mcp__') && !OWN_TOOLS.includes(e.name)) this.o.board.log(cardId, 'activity', 'explorer', describeTool(e.name, e.input, this.o.board.t));
        break;
      case 'error':
        this.o.board.log(cardId, 'error', 'obeya', e.message);
        this.interrupt(cardId, 'error');
        this.o.onReplied?.(cardId, false);
        break;
      case 'idle': {
        // a turn without reply still said something: that is the reply, unless the turn was for the brief only
        if (!live.replied && !live.quiet && live.lastText.trim()) this.answer(cardId, live.lastText.trim());
        live.replied = false;
        live.lastText = '';
        live.quiet = false;
        live.current = [];
        if (live.queue.length) {
          const queued = live.queue.splice(0);
          live.current = queued;
          live.session.send(
            [...queued.map((m) => m.text), this.buildNote(cardId, live)].filter(Boolean).join('\n\n'),
            queued.flatMap((m) => m.images),
          );
          return;
        }
        this.close(cardId);
        this.o.onReplied?.(cardId, true);
        break;
      }
    }
  }

  /** The agent's reply stands in the conversation, its mocks and questions below it; the owner is next. */
  private answer(cardId: string, text: string, questions: Question[] = [], next?: NextStep, mocks: Mock[] = []) {
    this.o.board.log(cardId, 'talk', 'explorer', text, undefined, undefined, mocks);
    this.o.board.setIdea(cardId, { yourTurn: true, questions, next });
  }

  private tools(cardId: string, live: Live): AgentTool[] {
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({ ...t, run: (args) => (this.live.get(cardId) === live ? t.run(args) : 'This conversation has ended. End your turn.') }));
    const language = this.o.board.language();
    const OWNER_LANGUAGE = LANGUAGE_NAMES[language];
    const MOCKS = mocks(language);
    const t = MESSAGES[language].idea;
    return current([
      {
        name: 'reply',
        description: `Your turn in the conversation, shown on the card beside the brief (markdown, in ${OWNER_LANGUAGE}): a few sentences that do not repeat the brief. spoken: one or two short sentences in ${OWNER_LANGUAGE} for the ear, with the question you need answered next. questions: the questions you ask now, each with its answer options (multiple: true when several may be chosen together); the card shows them under your reply for the owner to pick from, so the reply does not repeat them; pick: the options you would choose yourself if you had to decide (one, or several when multiple), and pick_why: why, in one short sentence in ${OWNER_LANGUAGE}. next: what you would do next in the owner's place, always: answer (the open questions come first), build, planDoc, prototype, park or drop, with why in one short sentence in ${OWNER_LANGUAGE}; the card marks that click for the owner. mocks: only when the owner asked to see something the brief has no place for; ${MOCKS}. Call it once per message, then end your turn.`,
        schema: {
          text: z.string(),
          spoken: z.string(),
          questions: z
            .array(
              z.object({
                question: z.string(),
                options: z.array(z.string()).max(6),
                multiple: z.boolean().optional(),
                pick: z.array(z.string()).optional(),
                pick_why: z.string().optional(),
              }),
            )
            .max(4)
            .optional(),
          next: z.object({ step: z.enum(NEXT_STEPS), why: z.string() }).optional(),
          mocks: MOCK_SCHEMA,
        },
        run: ({ text, spoken, questions, next, mocks }) => {
          if (live.replied) return 'Already replied. End your turn now.';
          live.replied = true;
          const asked = ((questions as Asked[] | undefined) ?? []).map(withPick).filter((q) => q.text);
          this.answer(cardId, clip(String(text), 12000), asked, nextStep(next, asked), mocksOf(mocks));
          if (live.speak && String(spoken).trim()) this.o.board.speak(cardId, clip(String(spoken).trim(), 400));
          live.speak = false;
          return 'Shown to the owner. End your turn now; their next message arrives as a new one.';
        },
      },
      {
        name: 'update_brief',
        description: `Replace the brief of the idea ("${t.briefName}"), in ${OWNER_LANGUAGE} markdown, whenever the conversation changed it. Always the whole text, standing on its own. mocks: how the brief's variants look, one per variant, shown under the brief; ${MOCKS}. The whole list whenever it changes; leave it out to keep the mocks as they are, an empty list removes them.`,
        schema: { brief: z.string(), mocks: MOCK_SCHEMA },
        run: ({ brief, mocks }) => {
          this.o.board.setIdea(cardId, { brief: clip(String(brief).trim(), 20000), ...(mocks === undefined ? {} : { mocks: mocksOf(mocks) }) });
          this.o.board.log(cardId, 'activity', 'explorer', t.briefUpdated);
          return 'Brief updated.';
        },
      },
      {
        name: 'plan_prototypes',
        description: `The throwaway prototypes the brief plans, one per variant to be seen side by side: the whole list each time, empty when none are planned any more. When the owner clicks "${t.prototypeButton}", the card offers them, all chosen, and starts one worker per variant at once; without this list it starts one prototype of the idea as it stands. approach: the variant in a few words, in ${OWNER_LANGUAGE} (${WORDS[language].approach}); it becomes the prototype's title. show: that prototype's task, in ${OWNER_LANGUAGE}: what it builds and what its demo shows, for this variant only; its worker also reads the brief.`,
        schema: { prototypes: z.array(z.object({ approach: z.string(), show: z.string() })).max(MAX_VARIANTS) },
        run: ({ prototypes }) => {
          const variants = plannedPrototypes(prototypes);
          this.o.board.setIdea(cardId, { variants });
          this.o.board.log(cardId, 'activity', 'explorer', variants.length ? t.plansPrototypes(variants.map((v) => v.approach).join(', ')) : t.plansNoPrototypes);
          return variants.length ? `Planned ${variants.length} prototype${variants.length > 1 ? 's' : ''}.` : 'No prototypes planned.';
        },
      },
      {
        name: 'record_decision',
        description: `The owner decided something in the conversation: record it in the decision log (question and answer in ${OWNER_LANGUAGE}, short).`,
        schema: { question: z.string(), answer: z.string() },
        run: ({ question, answer }) => {
          this.o.board.decide({ project_id: null, card_id: cardId, question: clip(String(question), 500), answer: clip(String(answer), 500), by: 'owner' });
          this.o.board.log(cardId, 'state', 'explorer', t.decision(clip(String(question), 200), clip(String(answer), 200)));
          return 'Recorded.';
        },
      },
    ]);
  }

  private briefing(card: Item, shots: string[]): string {
    return [
      `The idea: “${card.title}”.`,
      card.body.trim(),
      shots.length ? `The owner attached ${shots.length === 1 ? 'a screenshot' : `${shots.length} screenshots`} to the card (shown with this message; files: ${shots.join(', ')}).` : '',
      `Decisions on cards without a project so far:\n${decisionLog(this.o.board.decisions(null))}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private idea(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    if (i.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return i;
  }
}

/** The words of the card the idea's agent writes into: the parts of the brief, and examples in the owner's language. */
const WORDS: Record<Language, { parts: [string, string, string, string, string, string]; changed: string; pointer: string; approach: string }> = {
  de: { parts: ['Ziel', 'Ist-Stand', 'Varianten', 'Entscheidungen', 'Offene Fragen', 'Aufwand'], changed: 'Varianten A bis C ergänzt', pointer: 'Zwei offene Fragen, siehe Stand', approach: '"A Plasma-Felder"' },
  en: { parts: ['Goal', 'Today', 'Variants', 'Decisions', 'Open questions', 'Effort'], changed: 'Added variants A to C', pointer: 'Two open questions, see the brief', approach: '"A Plasma fields"' },
};

const system = (language: Language) => {
  const w = WORDS[language];
  const [goal, today, variants, decisions, open, effort] = w.parts.map((p) => `**${p}**`);
  return `
You are the exploration agent of one idea on Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. The owner wants to think the idea through with you before anything is planned or built. It is one long conversation; it may go on days later.

You can only read: the code, the repository's docs and plan docs, and what the messages give you (decisions taken so far, the owner's preferences). You cannot change files, and nothing you do starts work.

The card shows the brief ("${MESSAGES[language].idea.briefName}") and the conversation side by side. The brief holds the substance, the conversation only the turns: nothing stands in both.

How to work:
- Put what you find and propose into the brief, not into your reply: what the code does today, variants with their trade-offs and what each would cost (what it touches, roughly how much agent work, the risks), decisions, open questions, effort.
- Ground it in the code and the plan; say when you are guessing.
- Ask what you need to know, one or two questions at a time, under ${open} in the brief, numbered, and pass the same questions to reply as questions, with two to five short answer options each when the answer is a choice; when options can be combined, set multiple instead of offering combinations as options. The card shows them as choices under your reply; the owner picks or writes their own answer. A question without options gets a written answer.
- Your reply is your turn in the conversation, a few sentences at most: react to what the owner said, name in a few words what changed in the brief ("${w.changed}", not the variants again, and no finding from it summed up), and say what you need from them next by pointing to the open questions ("${w.pointer}"), without repeating them. Only what has no place in the brief (an explanation the owner asked for, a remark on the side) is said in the reply itself.
- Do not confirm recorded decisions one by one; the brief shows them.
- When a variant is something to look at (a layout, a card, a dialog), show it with a mock in the brief: a few lines of HTML the card shows beside the brief. A mock is a sketch of how it looks, not working code; a prototype is for what a sketch cannot show.

Tools, within a turn in this order:
- record_decision: when the owner decided something in the message. General preferences (how they like to work) are not decisions; Obeya learns those on its own.
- update_brief: keep the brief current whenever the conversation changed it. It has these parts, as short bold-labelled paragraphs or lists: ${goal}, ${today} (what the code does today, when it matters), ${variants} (open and dropped ones, each with why), ${decisions}, ${open}, and ${effort} once you can say. An answered question leaves the open questions; what it decided goes where it belongs. Whoever opens the card later reads only the brief, so it must stand on its own. When the owner builds the idea as it stands, the brief is the worker's task.
- plan_prototypes: whenever the brief plans prototypes you have not passed to it yet, or the plan changes (which variants are to be seen side by side, and what each is to show). The owner then starts them all with one click, one worker per variant.
- reply, last: your turn in the conversation, and spoken, its summary for the ear. Exactly once per message, then end your turn.

The owner decides on the card whether to build the idea, turn it into a plan doc, have a throwaway prototype built, park it or drop it. With every reply, say through next what you would do in their place if you had to decide, and why; the card marks that click, so the owner sees at a glance where to go on:
- answer: an open question has to be settled before anything else makes sense. Then give your own pick for each question too, so the owner can follow it or overrule it.
- build: the brief is clear enough to be one worker's task, and what is still open is a judgement call the worker can make.
- planDoc: it is too big for one card (several workstreams, or an order to work in).
- prototype: only seeing it will settle it (a layout, how it feels, a risky approach), and a throwaway build costs less than guessing.
- park or drop: it is not worth it now, or no longer.
Give your pick on every question with options, whatever next is. Do not hold the idea back with questions you could settle as well as the owner: settle them in the brief and say so. Several prototypes may try different approaches side by side, one per variant you planned with plan_prototypes; you hear each one's result, and the questions their workers asked with the owner's answers, which belong in the brief like answers given here. Once one convinces, the owner builds the idea on that prototype's branch.
Owner-facing text is in ${LANGUAGE_NAMES[language]}.
`.trim();
};

const OWN_TOOLS = ['reply', 'update_brief', 'plan_prototypes', 'record_decision'];

/** At most this many prototypes are planned for one idea. */
const MAX_VARIANTS = 6;

/** How a mock is written, for both tools that take them. */
const mocks = (language: Language) =>
  `each with a title (the variant in a few words, in ${LANGUAGE_NAMES[language]}) and html: a few lines of self-contained HTML with inline styles (no files, no network), shown in a sandboxed frame that may leave it only 240 px of width, so nothing in it is wider`;
const MOCK_SCHEMA = z.array(z.object({ title: z.string(), html: z.string() })).max(MAX_VARIANTS).optional();

/** How the agent hears the messages an interrupted turn left unanswered. */
const OPENING =
  'The owner wrote this as a card to be built, then chose to discuss it first. They have not said more yet: what the card says above is where the conversation starts. Look into it and open the discussion.';

const OPENING_PROPOSED =
  "A worker proposed this idea while on another card, and the owner took it up to discuss it. They have not said more yet: what the card says above is where the conversation starts, with what the owner decided on the proposal and the questions still open. Look into it and open the discussion.";

/** The owner clicked "So bauen" during the agent's turn. */
const BUILD_AFTER_REPLY =
  'The owner clicked "So bauen" while you worked on this reply: once it is there, a worker builds the idea from the brief as you leave it, unless your reply asks questions; then nothing is built, and the owner decides again after answering them.';

const UNREAD_NOTE: Record<Unread['why'], string> = {
  parked: 'The owner parked the idea while you were working on a reply, which ended that turn. These messages are still unanswered; take them in with the one after them:',
  dropped: 'The owner dropped the idea while you were working on a reply, which ended that turn. These messages are still unanswered; take them in with the one after them:',
  error: 'Your last turn ended with an error before you replied. These messages are still unanswered; take them in with the one after them:',
  restart: 'Obeya was restarted while you worked on a reply. These messages are still unanswered; take them in with the one after them:',
};

interface Asked {
  question: string;
  options: string[];
  multiple?: boolean;
  pick?: string[];
  pick_why?: string;
}

/** A question as the card shows it, with the agent's own pick when that names its options. */
function withPick(a: Asked): Question {
  const q = toQuestion(a.question, a.options, a.multiple);
  const picked = (a.pick ?? []).map((o) => String(o).trim()).filter((o) => q.options.includes(o));
  const options = q.multiple ? [...new Set(picked)] : picked.slice(0, 1);
  return options.length ? { ...q, pick: { options, why: clip(String(a.pick_why ?? '').trim(), 400) } } : q;
}

/** The prototypes as the agent planned them: each with an approach of its own, and a task. */
function plannedPrototypes(list: unknown): PlannedPrototype[] {
  const seen = new Set<string>();
  const out: PlannedPrototype[] = [];
  for (const p of (list as { approach?: unknown; show?: unknown }[] | undefined) ?? []) {
    const approach = clip(String(p.approach ?? '').replace(/\s+/g, ' ').trim(), 60);
    const show = clip(String(p.show ?? '').trim(), 4000);
    if (!approach || !show || seen.has(approach.toLowerCase())) continue;
    seen.add(approach.toLowerCase());
    out.push({ approach, show });
  }
  return out.slice(0, MAX_VARIANTS);
}

/** The mocks as the agent wrote them: each with a title and some HTML, at most one per variant. */
function mocksOf(list: unknown): Mock[] {
  return ((list as { title?: unknown; html?: unknown }[] | undefined) ?? [])
    .map((m) => ({ title: clip(String(m.title ?? '').replace(/\s+/g, ' ').trim(), 80), html: String(m.html ?? '').trim() }))
    .filter((m) => m.html && m.html.length <= MOCK_MAX)
    .slice(0, MAX_VARIANTS);
}

/** A mock is a sketch, not a page: longer ones are left out rather than cut off mid-tag. */
const MOCK_MAX = 20000;

/** The step the agent suggests; answering needs questions to answer. */
function nextStep(next: unknown, asked: Question[]): NextStep | undefined {
  const n = next as { step?: unknown; why?: unknown } | undefined;
  if (!n || !NEXT_STEPS.includes(n.step as NextStep['step'])) return undefined;
  if (n.step === 'answer' && !asked.length) return undefined;
  return { step: n.step as NextStep['step'], why: clip(String(n.why ?? '').trim(), 400) };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
