// Exploration agents: one session per idea with a worker's tools, resumed for every message, even
// days later. The owner and the agent talk on the card; the agent keeps the idea's brief, which is what
// remains of the conversation: whoever opens the card later reads the brief, not the talk. The
// brief holds the substance and the replies only the turns, so the two never say the same; how
// the agent got to a reply (what it read and thought) folds away under that reply.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type Language, ownersLanguage, repositoryLanguage } from '../core/locale';
import { MESSAGES } from '../core/messages';
import { type CardEvent, formatQuestion, type Item, type Mock, NEXT_STEPS, type NextStep, type PlannedPrototype, type Question, type SettledPart } from '../core/types';
import { type Asked, decisionLog, withPick } from './advisor';
import { BadRequest, type Board, type Message, replyNote, type Unread } from './board';
import { type AgentEvent, type AgentRuntime, type AgentSession, type AgentTool, BackgroundWait } from './runtime';
import { imageNote } from './images';
import { describeTool, SPOKEN } from './workers';
import { TO_OBEYA, toObeyaTool } from './to-obeya';
import { clip } from '../core/text';
import { folderPath } from './new-repo';

export interface ExplorerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the agent works in: the one of the idea's repository. */
  pathFor: (card: Item) => string;
  /** The language of what lands in the idea's repository (`language` of its settings); English when left out. */
  repoLanguage?: (card: Item) => Language;
  /** The workers' permission mode: the agent has their tools and runs as they do. */
  permissionMode?: PermissionMode;
  /** The owner's recorded preferences, as agents read them. */
  preferences?: () => string;
  /** Called with what the owner says, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, text: string) => void;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /** The agent answered all it was told and its session ended (`replied`), or its turn ended without (an error, a restart). */
  onReplied?: (cardId: string, replied: boolean) => void;
  /** Passes on to the Koordinator what the owner's words to the idea's agent ask of Obeya (`to_obeya`); without it the agent has no such tool. */
  toObeya?: (cardId: string, request: string) => Promise<string>;
  /** How long an ended turn waits for a sign of the agent once none of its background work runs (any more). */
  backgroundGrace?: number;
  /** How long an ended turn waits at most while the agent's background work still runs. */
  backgroundLimit?: number;
}

interface Live {
  session: AgentSession;
  /** The messages the running turn answers. */
  current: Message[];
  /** Messages that arrived during a turn; they go in together once it ends, unread until then. */
  queue: Message[];
  replied: boolean;
  lastText: string;
  /** The turn only takes something into the brief: words without a reply are no reply. */
  quiet?: boolean;
  /** The owner's preferences as the agent last heard them: in its instructions, or since then. */
  preferences: string;
  /** The agent heard that the owner clicked "So bauen" during its turn. */
  toldBuild?: boolean;
  /** The agent's background work, and a turn that ended without a reply waiting for it to wake the agent. */
  work: BackgroundWait;
  /** The last words of a turn that ended waiting for its background work: the reply, should it never wake the agent. */
  said?: string;
}

export class Explorers {
  private live = new Map<string, Live>();

  constructor(private o: ExplorerOptions) {}

  /**
   * The owner says something about the idea, maybe with screenshot files and in reply to a message
   * of its conversation (`replyTo`); a parked or dropped idea is open again.
   */
  discuss(cardId: string, text: string, spoken = false, images: string[] = [], replyTo?: number) {
    const card = this.idea(cardId);
    const idea = this.o.board.idea(cardId);
    if (idea.status !== 'open') {
      this.o.board.setIdea(cardId, { status: 'open' });
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.idea.reopened);
    }
    // words said while the agent works on a reply wait for its next turn, unread until then
    const said = this.o.board.log(cardId, 'talk', 'owner', text, { images, replyTo, unread: this.live.has(cardId) });
    this.o.board.setIdea(cardId, { yourTurn: false, questions: [], next: undefined });
    if (text) this.o.onOwnerInput?.(card, text);
    const quoted = replyTo ? this.o.board.quoted(cardId, replyTo) : undefined;
    this.send(card, `The owner says${spoken ? ` (${SPOKEN})` : ''}:\n\n${replyNote(quoted, 'explorer')}${text}${imageNote(images)}`, images, false, [said.id], true);
  }

  /**
   * The owner pauses the idea's agent while it works on a reply: its session ends at once, in the
   * middle of a step if need be, and what it has not answered yet stays with the idea (`interrupt`).
   * It goes on with those messages once the owner resumes it or says something more.
   */
  pause(cardId: string) {
    const card = this.idea(cardId);
    if (!this.live.has(cardId)) throw new BadRequest('noAgent', card.paused ? 'the agent is paused already' : 'the agent is not working on anything');
    this.interrupt(cardId, 'paused', true);
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.pausedByOwner);
  }

  /**
   * The owner pauses the idea's agent at a safe point (the card's pause, the canvas's): it finishes
   * the reply it works on, and is paused then, before it takes up what was said meanwhile.
   */
  pauseAtSafePoint(cardId: string) {
    const card = this.idea(cardId);
    if (!this.live.has(cardId) || card.pausing) throw new BadRequest('noAgent', card.paused || card.pausing ? 'the agent is paused already' : 'the agent is not working on anything');
    this.o.board.work(cardId, { pausing: new Date().toISOString() });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.pausing);
  }

  /** The owner lets the paused agent go on: it answers what it had not answered yet. One about to pause after its reply works on instead. */
  resume(cardId: string) {
    const card = this.idea(cardId);
    if (card.pausing) return this.pauseTakenBack(cardId);
    if (!card.paused) throw new BadRequest('notPaused', 'the agent is not paused');
    // a reply already given left nothing unanswered: it goes on with what it did after it, its words no new reply
    const unanswered = !!this.o.board.idea(cardId).unread;
    this.send(card, unanswered ? 'Answer them now.' : RESUMED, [], !unanswered, [], true);
  }

  /** The owner lets the agent about to pause after its reply go on after all (`resume`, or their words to it). */
  private pauseTakenBack(cardId: string) {
    this.o.board.work(cardId, { pausing: null });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.resumedByOwner);
  }

  /**
   * The owner takes back words the agent has not read: words waiting for its next turn, or left
   * unanswered by a turn that was cut off. They leave the conversation, and the agent never hears them.
   */
  unsay(cardId: string, id: number) {
    this.idea(cardId);
    if (!this.o.board.unread(cardId, id)) throw new BadRequest('notHeld', 'the agent has read these words already');
    const taken = (m: Message) => !m.said.includes(id);
    const live = this.live.get(cardId);
    const { unread } = this.o.board.idea(cardId);
    if (live?.queue.some((m) => !taken(m))) live.queue = live.queue.filter(taken);
    else if (unread?.messages.some((m) => !taken(m))) {
      const messages = unread.messages.filter(taken);
      this.o.board.setIdea(cardId, { unread: messages.length ? { ...unread, messages } : undefined });
    } else throw new BadRequest('notHeld', 'the agent has read these words already');
    this.o.board.withdraw(cardId, id);
  }

  /**
   * A planned card became an idea, or the owner took up an idea a worker proposed (`proposed`): its
   * agent opens the discussion with what the card says, before the owner writes, and with the notes
   * the owner left on the planned card for a worker (`notes`).
   */
  open(cardId: string, proposed?: 'idea' | 'task', notes?: { text: string; images: string[] }) {
    const card = this.o.board.item(cardId);
    if (!card || card.state !== 'idea') return;
    if (notes?.text) return this.send(card, `${OPENING_NOTES}\n\n---\n\n${notes.text}`, notes.images, false);
    this.send(card, proposed === 'idea' ? OPENING_PROPOSED : proposed === 'task' ? OPENING_PROPOSED_TASK : OPENING, [], false);
  }

  /**
   * Obeya tells the agent something the owner did not say (a prototype's result). `quiet`: it is
   * for the brief only (an answer given on a prototype), and the turn's words are no reply.
   */
  tell(cardId: string, text: string, quiet = false) {
    const card = this.o.board.item(cardId);
    if (!card || card.state !== 'idea') return;
    this.send(card, text, [], quiet);
  }

  /**
   * Ends the idea's session; its id stays, so the conversation can go on later. A pause ends with it
   * (the idea parked, dropped, decided), unless it ends for one (`paused`): then the idea is paused
   * in the same step, so the canvas never counts it as neither paused nor about to pause.
   */
  close(cardId: string, paused = false) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    live?.work.stop();
    live?.session.close();
    const card = this.o.board.item(cardId);
    if (card?.idea?.thinking) this.o.board.setIdea(cardId, { thinking: false });
    if (paused) this.o.board.work(cardId, { paused: '{}', pausing: null });
    else if (card?.paused || card?.pausing) this.o.board.work(cardId, { paused: null, pausing: null });
  }

  /**
   * Ends the idea's session in the middle of a turn (parked, dropped, an error): what the agent has
   * not answered yet stays with the idea and goes to it first when the conversation goes on.
   */
  interrupt(cardId: string, why: Unread['why'], paused = false) {
    const live = this.live.get(cardId);
    if (live) {
      // a reply already given answered the turn's messages
      const messages = [...(live.replied ? [] : live.current), ...live.queue];
      if (messages.length) this.o.board.setIdea(cardId, { unread: { why, messages } });
    } else {
      // parked or dropped while paused: that is what the agent hears when it goes on
      const { unread } = this.o.board.idea(cardId);
      if (unread?.why === 'paused') this.o.board.setIdea(cardId, { unread: { ...unread, why } });
    }
    this.close(cardId, paused);
  }

  /** After a restart: an idea whose agent was in the middle of a reply gets it. */
  resumeAll() {
    for (const i of this.o.board.items()) {
      if (i.state !== 'idea' || !i.idea?.thinking) continue;
      // about to pause after its reply, which the restart cut off: it stays paused, its words unanswered
      if (i.pausing) {
        this.o.board.setIdea(i.id, { thinking: false });
        this.o.board.work(i.id, { paused: '{}', pausing: null });
        this.o.board.log(i.id, 'state', 'owner', this.o.board.t.worker.pausedByOwner);
        continue;
      }
      // with its repository not on the canvas, what it has not answered waits for the owner's next words
      if (this.o.board.row(i.id).session_id && !i.repoDown) this.send(i, 'Obeya was restarted while you worked on your reply. Answer the owner’s last message now.');
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

  /** `owner`: the owner's words, which let a paused agent go on; what Obeya tells it waits with what it has not answered yet. */
  private send(card: Item, message: string, images: string[] = [], quiet = false, said: number[] = [], owner = false) {
    // the owner's words let an agent about to pause after its reply go on, as they do a paused one
    if (owner && this.o.board.row(card.id).pausing) this.pauseTakenBack(card.id);
    const live = this.live.get(card.id);
    if (live) {
      // queued, it goes in with whatever else came, which may well need a reply
      live.queue.push({ text: message, images, said });
      // a turn waiting for its background work ended: the message goes in at once, and the turn answers it too
      if (live.work.waiting) {
        live.work.stop();
        this.sendQueued(card.id, live, [...live.current]);
      }
      return;
    }
    const row = this.o.board.row(card.id);
    // what an interrupted turn left unanswered goes first
    const { unread } = this.o.board.idea(card.id);
    if (row.paused) {
      if (!owner) {
        this.o.board.setIdea(card.id, { unread: { why: unread?.why ?? 'paused', messages: [...(unread?.messages ?? []), { text: message, images, said }] } });
        return;
      }
      this.o.board.work(card.id, { paused: null });
      this.o.board.log(card.id, 'state', 'owner', this.o.board.t.worker.resumedByOwner);
    }
    const current = [...(unread?.messages ?? []), { text: message, images, said }];
    this.o.board.setIdea(card.id, { thinking: true, unread: undefined });
    this.o.board.readNow(card.id, current.flatMap((m) => m.said));
    const text = unread ? `${UNREAD_NOTE[unread.why]}\n\n${unread.messages.map((m) => m.text).join('\n\n')}\n\n---\n\n${message}` : message;
    const all = current.flatMap((m) => m.images);
    if (row.session_id) return this.launch(card, current, text, row.session_id, all, quiet);
    // a planned card that became an idea brings the screenshots of its task
    const shots = this.o.imageFiles?.(card.images) ?? [];
    this.launch(card, current, `${this.briefing(card, shots, current.flatMap((m) => m.said))}\n\n${text}`, undefined, [...shots, ...all], quiet);
  }

  private launch(card: Item, current: Message[], message: string, resume: string | undefined, images: string[], quiet = false) {
    // where it reads, first: without its repository on the canvas, nothing starts
    const cwd = this.o.pathFor(card);
    const preferences = this.o.preferences?.() ?? '';
    const live: Live = { session: undefined!, current, queue: [], replied: false, lastText: '', quiet, preferences, work: undefined! };
    // without a sign of the agent for a long while (the work ended, and nothing woke it), its turn is over
    live.work = new BackgroundWait(
      () => {
        if (this.live.get(card.id) === live) this.turnOver(card.id, live);
      },
      { grace: this.o.backgroundGrace, limit: this.o.backgroundLimit },
    );
    this.live.set(card.id, live);
    live.session = this.o.runtime.start(
      {
        cwd,
        role: 'explorer',
        ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
        system: system(this.o.board.conversation(), this.o.board.language(), this.o.repoLanguage?.(card) ?? 'en', !!this.o.toObeya) + (preferences ? `\n\n${preferences}` : ''),
        tools: this.tools(card.id, live),
        contextUpdate: () => [this.buildNote(card.id, live), this.preferencesUpdate(live)].filter(Boolean).join('\n\n') || undefined,
        ...(resume ? { resume } : {}),
        // the idea's agent waits for the usage limit, on the card, and the owner's words wait with it
        onLimit: (until) => this.o.board.waitsForLimit({ card: card.id }, until),
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
    if (e.type === 'background') return live.work.changed(e.tasks.length);
    // a turn may also start without a message from Obeya (a finished background command)
    live.work.stop();
    switch (e.type) {
      case 'session':
        this.o.board.work(cardId, { session_id: e.id });
        break;
      case 'text':
        live.lastText = e.text;
        // what it thinks on the way to its reply; words after the reply only close the turn
        if (!live.replied && e.text.trim()) this.o.board.log(cardId, 'say', 'explorer', clip(e.text.trim(), 12000));
        break;
      case 'tool':
        // its own tools show in the conversation and the brief, not as reading
        if (!e.name.startsWith('mcp__') && !OWN_TOOLS.includes(e.name)) this.o.board.log(cardId, 'activity', 'explorer', describeTool(e.name, e.input, this.o.board.t));
        break;
      case 'error':
        this.o.board.log(cardId, 'error', 'obeya', e.message, { token: e.token });
        this.interrupt(cardId, 'error');
        this.o.onReplied?.(cardId, false);
        break;
      case 'idle': {
        live.work.running = e.background ?? 0;
        // its background work still runs (a download, a watcher), and it wakes the agent when it ends:
        // the idea shows it at work until then, and it goes on from there; its words so far are no reply
        if (live.work.running > 0) {
          if (live.replied) {
            // a reply it gave (that it waits for the work, say) answered the turn's messages
            live.current = [];
            live.said = undefined;
            live.replied = false;
          } else if (live.lastText.trim()) live.said = live.lastText.trim();
          live.lastText = '';
          // what the owner said meanwhile goes in now, and the turn answers it too
          if (live.queue.length) this.sendQueued(cardId, live, [...live.current]);
          else live.work.start();
          return;
        }
        this.turnOver(cardId, live);
        break;
      }
    }
  }

  /** The agent's turn is over: what it said last is the reply, and the owner is next, unless more waits for it. */
  private turnOver(cardId: string, live: Live) {
    // a turn without reply still said something: that is the reply, unless the turn was for the brief only
    const said = live.lastText.trim() || live.said;
    if (!live.replied && !live.quiet && said) this.answer(cardId, said);
    live.replied = false;
    live.lastText = '';
    live.said = undefined;
    live.quiet = false;
    // the owner asked it to pause once its reply was given: what was said meanwhile waits for them to let it go on
    if (this.o.board.row(cardId).pausing) {
      live.current = [];
      this.interrupt(cardId, 'paused', true);
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.pausedByOwner);
      this.o.onReplied?.(cardId, true);
      return;
    }
    if (live.queue.length) return this.sendQueued(cardId, live, []);
    this.close(cardId);
    this.o.onReplied?.(cardId, true);
  }

  /** What the owner said during the turn starts the next one, which answers it after `unanswered`. */
  private sendQueued(cardId: string, live: Live, unanswered: Message[]) {
    const queued = live.queue.splice(0);
    live.current = [...unanswered, ...queued];
    this.o.board.readNow(cardId, queued.flatMap((m) => m.said));
    live.session.send(
      [...queued.map((m) => m.text), this.buildNote(cardId, live)].filter(Boolean).join('\n\n'),
      queued.flatMap((m) => m.images),
    );
  }

  /**
   * The agent's reply stands in the conversation, its mocks and questions below it; the owner is next,
   * unless the reply asks nothing while a prototype of the idea is still being built: then the owner
   * waits for that, and the agent's reply to its result gives them the turn.
   * Its questions stand in the conversation too, and stay there once answered, with the options picked.
   */
  private answer(cardId: string, text: string, questions: Question[] = [], next?: NextStep, mocks: Mock[] = []) {
    this.o.board.log(cardId, 'talk', 'explorer', text, { mocks });
    for (const q of questions) this.o.board.log(cardId, 'question', 'explorer', formatQuestion(q, this.o.board.language()));
    const building = this.o.board.items().some((i) => i.prototypeOf === cardId && (i.state === 'planned' || i.state === 'working'));
    this.o.board.setIdea(cardId, { yourTurn: questions.length > 0 || !building, questions, next });
  }

  private tools(cardId: string, live: Live): AgentTool[] {
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({ ...t, run: (args) => (this.live.get(cardId) === live ? t.run(args) : 'This conversation has ended. End your turn.') }));
    // the examples in the language the owner talks in by default, the names of the card's parts in the interface's
    const language = this.o.board.conversation();
    const OWNER_LANGUAGE = "the owner's language";
    const MOCKS = mocks(OWNER_LANGUAGE);
    const t = this.o.board.t.idea;
    return current([
      {
        name: 'reply',
        description: `Your turn in the conversation, shown on the card beside the brief (markdown, in ${OWNER_LANGUAGE}): a few sentences that do not repeat the brief. questions: the questions you ask now, each with its answer options (multiple: true when several may be chosen together); the card shows them under your reply for the owner to pick from, so the reply does not repeat them; pick: the options you would choose yourself if you had to decide (one, or several when multiple), and pick_why: why, in one short sentence in ${OWNER_LANGUAGE}. next: what you would do next in the owner's place, always: answer (the open questions come first), build, splitOff (with a part marked with plan_split), planDoc, prototype, park or drop, with why in one short sentence in ${OWNER_LANGUAGE}; the card marks that click for the owner. mocks: only when the owner asked to see something the brief has no place for; ${MOCKS}. Call it once per message, then end your turn.`,
        schema: {
          text: z.string(),
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
        run: ({ text, questions, next, mocks }) => {
          if (live.replied) return 'Already replied. End your turn now.';
          live.replied = true;
          const asked = ((questions as Asked[] | undefined) ?? []).map(withPick).filter((q) => q.text);
          this.answer(cardId, clip(String(text), 12000), asked, nextStep(next, asked, !!this.o.board.idea(cardId).split), mocksOf(mocks));
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
        name: 'plan_split',
        description: `When part of the idea is settled and part is still open (to be discussed further, or prototyped), the part to build now: the owner splits it off with "${t.splitOffButton}" as a task of its own, which a worker starts on at once, and the idea stays with what is open. title: that task's title, a few words in ${OWNER_LANGUAGE}. brief: its worker's task, in ${OWNER_LANGUAGE} markdown, standing on its own and holding only what is settled; what is still open is no part of it. The whole value each time; both empty when no part is settled apart from the rest any more.`,
        schema: { title: z.string(), brief: z.string() },
        run: ({ title, brief }) => {
          const part = settledPart(title, brief);
          this.o.board.setIdea(cardId, { split: part });
          this.o.board.log(cardId, 'activity', 'explorer', part ? t.plansSplit(part.title) : t.plansNoSplit);
          return part ? `Marked “${part.title}” to split off.` : 'No task marked to split off.';
        },
      },
      {
        name: 'plan_repo',
        description: `When the owner wants the idea built in a repository that does not exist yet ("in a new repo under ~/dev/super59"): path, its folder (absolute or from ~), and canvas: true for a canvas of its own (the default), false where the owner wants the repository on this canvas beside the others. The card's repository picker then shows it, and its button builds it there: Obeya creates the folder and a local git repository (no remote, nothing published), a canvas named after it, moves this idea there with all it holds (brief, conversation, mocks, decisions) and builds it there; the worker hears the repository is new and sets it up (CLAUDE.md, Obeya's settings). The whole value each time; an empty path when it is to be built in an existing repository again. What the owner picked on the card stands: you do not change it.`,
        schema: { path: z.string(), canvas: z.boolean().optional() },
        run: ({ path, canvas }) => {
          const p = clip(String(path ?? '').trim(), 1000);
          if (p && !folderPath(p)) return `${p} is no folder: give it absolute or from ~.`;
          const set = this.o.board.setNewRepo(cardId, p ? { path: p, canvas: canvas !== false, by: 'agent' } : null, 'agent');
          const now = this.o.board.newRepo(cardId);
          if (!set) return `The owner picked the repository on the card themselves${now?.path ? ` (a new one at ${now.path})` : ''}; it stays as they chose.`;
          this.o.board.log(cardId, 'activity', 'explorer', p ? t.plansRepo(p) : t.plansNoRepo);
          return p ? `The card now builds it in a new repository at ${p}${canvas === false ? ' on this canvas' : ', with a canvas of its own'}.` : 'No new repository: it is built where the card says.';
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
      ...(this.o.toObeya ? [toObeyaTool((request) => this.o.toObeya!(cardId, request))] : []),
    ]);
  }

  /**
   * The first message of a session from scratch: the card and the decisions, and for an idea discussed
   * before (its session gone, pruned after weeks, say) where it stands: the brief, its mocks, the
   * prototypes planned and built, and the conversation so far up to the messages this turn answers (`said`).
   */
  private briefing(card: Item, shots: string[], said: number[] = []): string {
    return [
      `The idea: “${card.title}”.`,
      card.body.trim(),
      shots.length ? `The owner attached ${shots.length === 1 ? 'a screenshot' : `${shots.length} screenshots`} to the card (shown with this message; files: ${shots.join(', ')}).` : '',
      `Decisions on cards without a project so far:\n${decisionLog(this.o.board.decisions(null))}`,
      this.standing(card, said),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Where an idea discussed before stands, for a session that starts without its earlier ones; empty
   * for an idea its agent has not taken up yet (new, or a Question card just turned into one).
   */
  private standing(card: Item, said: number[]): string {
    const { brief, mocks = [], variants = [], split } = this.o.board.idea(card.id);
    const repo = card.newRepo;
    // in the order the agent read them: words it read later stand after the reply it read them at
    const place = (e: CardEvent) => (e.readAfter ? e.readAfter + 0.5 : e.id);
    const talk = this.o.board
      .talkOf(card.id, EARLIER_MESSAGES + said.length)
      .filter((e) => !said.includes(e.id))
      .slice(-EARLIER_MESSAGES)
      .sort((a, b) => place(a) - place(b) || a.id - b.id);
    const prototypes = card.prototypes ?? [];
    const shown = prototypes.slice(-MAX_VARIANTS);
    if (!brief.trim() && !mocks.length && !variants.length && !split && !repo && !prototypes.length && !talk.some((e) => e.author === 'explorer')) return '';
    const who = (e: CardEvent) => (e.author === 'owner' ? 'Owner' : e.author === 'explorer' ? 'You' : 'Obeya');
    return [
      'This idea was discussed before, in a session of yours that is gone. Where it stands, as Obeya keeps it; go on from there, and keep in the brief what still holds:',
      brief.trim() ? `The brief as you left it:\n\n${brief.trim()}` : '',
      mocks.length ? `The brief's mocks, shown under it (update_brief without mocks keeps them): ${mocks.map((m) => `“${m.title}”`).join(', ')}.` : '',
      variants.length ? `The prototypes you planned (plan_prototypes):\n${variants.map((v) => `- ${v.approach}: ${v.show}`).join('\n')}` : '',
      split ? `The part you marked to split off (plan_split): “${split.title}”.\n\n${split.brief}` : '',
      repo ? `It is to be built in a new repository at ${repo.path || '(no folder named yet)'}${repo.canvas ? ', with a canvas of its own' : ' on this canvas'}, as ${repo.by === 'owner' ? 'the owner picked on the card' : 'you marked with plan_repo'}.` : '',
      shown.length
        ? `The idea's prototypes${prototypes.length > shown.length ? ` (the latest ${shown.length} of ${prototypes.length})` : ''}:\n${shown.map((p) => `- “${p.title}”, ${prototypeState(p)}${p.summary ? `. Its summary: ${clip(p.summary, 2000)}` : ''}`).join('\n')}`
        : '',
      talk.length
        ? `The conversation so far${talk.length === EARLIER_MESSAGES ? ' (its latest messages)' : ''}:\n\n${talk.map((e) => `${who(e)}${e.kind === 'question' ? ' (question)' : ''}: ${clip(e.text, 2000)}`).join('\n\n')}`
        : '',
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

const system = (language: Language, ui: Language, repository: Language, toObeya: boolean) => {
  const w = WORDS[language];
  const [goal, today, variants, decisions, open, effort] = w.parts.map((p) => `**${p}**`);
  return `
You are the exploration agent of one idea on Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. The owner wants to think the idea through with you before anything is planned or built. It is one long conversation; it may go on days later.

Your sources are the code, the repository's docs and plan docs, and what the messages give you (decisions taken so far, the owner's preferences). You have the tools a worker has: what the discussion depends on beyond the text (the git history, files on this machine and their dates, a release, pull request or CI run on GitHub with gh, a page on the web), check rather than guess. Nothing you do yourself starts work.${toObeya ? `\n\n${TO_OBEYA}` : ''}

The card shows the brief ("${MESSAGES[ui].idea.briefName}") and the conversation side by side. The brief holds the substance, the conversation only the turns: nothing stands in both.

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
- plan_split: whenever part of the idea is settled while the rest is still open, or that split changes or goes: the part to build now, as one worker's task.
- plan_repo: whenever the owner says the idea is to be built in a repository that does not exist yet, or where that changes.
- reply, last: your turn in the conversation. Exactly once per message, then end your turn.

The owner decides on the card whether to build the idea, build its settled part, turn it into a plan doc, have a throwaway prototype built, park it or drop it. With every reply, say through next what you would do in their place if you had to decide, and why; the card marks that click, so the owner sees at a glance where to go on:
- answer: an open question has to be settled before anything else makes sense. Then give your own pick for each question too, so the owner can follow it or overrule it.
- build: the brief is clear enough to be one worker's task, and what is still open is a judgement call the worker can make. Building ends this conversation: the brief becomes the task, and the idea's prototypes, planned and running, are dropped. Where you marked a new repository with plan_repo, building creates it first and the idea moves there.
- splitOff: part of the idea is settled and part is still open (to be discussed further, or prototyped). The part you marked with plan_split becomes a task of its own, which a worker starts on at once; the idea stays with this conversation, its open part and its prototypes, planned and running. Without a part marked with plan_split, the card has no such click.
- planDoc: it is too big for one card (several workstreams, or an order to work in). The idea's prototypes stay, for the workstream that builds on them.
- prototype: only seeing it will settle it (a layout, how it feels, a risky approach), and a throwaway build costs less than guessing.
- park or drop: it is not worth it now, or no longer.
Give your pick on every question with options, whatever next is. Do not hold the idea back with questions you could settle as well as the owner: settle them in the brief and say so. Several prototypes may try different approaches side by side, one per variant you planned with plan_prototypes; you hear each one's result, and the questions their workers asked with the owner's answers, which belong in the brief like answers given here. Once one convinces, the owner builds the idea on that prototype's branch.
Owner-facing text (your replies, the brief, its mocks, prototypes and split-off part, the decisions you record) is in the owner's language. ${ownersLanguage(language)} ${repositoryLanguage(repository)}
`.trim();
};

const OWN_TOOLS = ['reply', 'update_brief', 'plan_prototypes', 'plan_split', 'plan_repo', 'record_decision', 'to_obeya'];

/** At most this many prototypes are planned for one idea. */
const MAX_VARIANTS = 6;

/** How a mock is written, for both tools that take them. */
const mocks = (language: string) =>
  `each with a title (the variant in a few words, in ${language}) and html: a few lines of self-contained HTML with inline styles (no files, no network), shown in a sandboxed frame that may leave it only 240 px of width, so nothing in it is wider`;
const MOCK_SCHEMA = z.array(z.object({ title: z.string(), html: z.string() })).max(MAX_VARIANTS).optional();

/** How many messages of the conversation so far a session from scratch reads. */
const EARLIER_MESSAGES = 20;

/** A prototype's state, as a session from scratch hears it. */
function prototypeState(p: Item): string {
  if (p.prototypeEnd === 'discarded') return 'discarded';
  if (p.prototypeEnd === 'built') return 'the idea was built on it';
  if (p.state === 'planned' || p.state === 'working') return 'being built';
  if (p.state === 'waiting' && (p.need === 'demo' || p.need === 'review')) return 'handed over';
  return p.state;
}

/** How the agent opens the discussion of an idea the owner wrote, or one a worker proposed. */
const OPENING =
  'The owner wrote this as a card to be built, then chose to discuss it first. They have not said more yet: what the card says above is where the conversation starts. Look into it and open the discussion.';

const OPENING_NOTES =
  'The owner wrote this as a card to be built, left the notes below on it for the agent that would take it on, then chose to discuss it first. What the card says above and these notes are where the conversation starts. Look into them and open the discussion.';

const OPENING_PROPOSED =
  "A worker proposed this idea while on another card, and the owner took it up to discuss it. They have not said more yet: what the card says above is where the conversation starts, with what the owner decided on the proposal and the questions still open. Look into it and open the discussion.";

const OPENING_PROPOSED_TASK =
  "A worker proposed this as a task to build while on another card, and the owner chose to discuss it as an idea first. They have not said more yet: what the card says above is where the conversation starts, with what the owner decided on the proposal and the questions still open. Look into it and open the discussion.";

/** The owner let the paused agent go on after it had replied already. */
const RESUMED =
  'The owner paused you after your reply and has now let you go on. Pausing ended your session at once: whatever you had running was stopped with it (a command still running shows exit code 137). Go on where you stopped.';

/** The owner clicked "So bauen" during the agent's turn. */
const BUILD_AFTER_REPLY =
  'The owner clicked "So bauen" while you worked on this reply: once it is there, a worker builds the idea from the brief as you leave it, unless your reply asks questions; then nothing is built, and the owner decides again after answering them.';

/** How the agent hears the messages an interrupted turn left unanswered. */
const UNREAD_NOTE: Record<Unread['why'], string> = {
  parked: 'The owner parked the idea while you were working on a reply, which ended that turn. These messages are still unanswered; take them in with the one after them:',
  dropped: 'The owner dropped the idea while you were working on a reply, which ended that turn. These messages are still unanswered; take them in with the one after them:',
  error: 'Your last turn ended with an error before you replied. These messages are still unanswered; take them in with the one after them:',
  restart: 'Obeya was restarted while you worked on a reply. These messages are still unanswered; take them in with the one after them:',
  paused:
    'The owner paused you while you worked on a reply and has now let you go on. Pausing ended your session at once: whatever you had running was stopped with it (a command still running shows exit code 137). These messages are still unanswered; take them in with the one after them:',
};

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

/** The part to build now as the agent marked it: both a title and a brief, or no split. */
function settledPart(title: unknown, brief: unknown): SettledPart | undefined {
  const part = { title: clip(String(title ?? '').replace(/\s+/g, ' ').trim(), 160), brief: clip(String(brief ?? '').trim(), 20000) };
  return part.title && part.brief ? part : undefined;
}

/** The step the agent suggests; answering needs questions to answer, building the settled part a part marked. */
function nextStep(next: unknown, asked: Question[], split: boolean): NextStep | undefined {
  const n = next as { step?: unknown; why?: unknown } | undefined;
  if (!n || !NEXT_STEPS.includes(n.step as NextStep['step'])) return undefined;
  if (n.step === 'answer' && !asked.length) return undefined;
  if (n.step === 'splitOff' && !split) return undefined;
  return { step: n.step as NextStep['step'], why: clip(String(n.why ?? '').trim(), 400) };
}

