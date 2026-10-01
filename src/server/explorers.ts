// Exploration agents: one read-only session per idea, resumed for every message, even days later.
// The owner and the agent talk on the card; the agent keeps the idea's brief, which is what
// remains of the conversation: whoever opens the card later reads the brief, not the talk.

import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Item } from '../core/types';
import { decisionLog } from './advisor';
import { BadRequest, type Board } from './board';
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool } from './runtime';
import { describeTool } from './workers';

export interface ExplorerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the agent reads: the one of the idea's repository. */
  pathFor: (card: Item) => string;
  /** The owner's recorded preferences, as agents read them. */
  preferences?: () => string;
  /** Called with what the owner says, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, text: string) => void;
}

interface Live {
  session: AgentSession;
  /** Messages that arrived during a turn; they go in together once it ends. */
  queue: string[];
  replied: boolean;
  lastText: string;
  /** The owner spoke: the reply is summed up aloud. */
  speak: boolean;
}

export class Explorers {
  private live = new Map<string, Live>();

  constructor(private o: ExplorerOptions) {}

  /** The owner says something about the idea; a parked or dropped idea is open again. */
  discuss(cardId: string, text: string, spoken = false) {
    const card = this.idea(cardId);
    const idea = this.o.board.idea(cardId);
    if (idea.status !== 'open') {
      this.o.board.setIdea(cardId, { status: 'open' });
      this.o.board.log(cardId, 'state', 'owner', 'Idee wieder aufgenommen.');
    }
    this.o.board.log(cardId, 'talk', 'owner', text);
    this.o.board.setIdea(cardId, { yourTurn: false });
    this.o.onOwnerInput?.(card, text);
    this.send(card, `The owner says:\n\n${text}`, spoken);
  }

  /** Obeya tells the agent something the owner did not say (a spike's result). */
  tell(cardId: string, text: string) {
    const card = this.o.board.item(cardId);
    if (!card || card.state !== 'idea') return;
    this.send(card, text, false);
  }

  /** Ends the idea's session; its id stays, so the conversation can go on later. */
  close(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    live?.session.close();
    const card = this.o.board.item(cardId);
    if (card?.idea?.thinking) this.o.board.setIdea(cardId, { thinking: false });
  }

  /** After a restart: an idea whose agent was in the middle of a reply gets it. */
  resumeAll() {
    for (const i of this.o.board.snapshot().items) {
      if (i.state !== 'idea' || !i.idea?.thinking) continue;
      if (this.o.board.row(i.id).session_id) this.send(i, 'Obeya was restarted while you worked on your reply. Answer the owner’s last message now.', false);
      else this.o.board.setIdea(i.id, { thinking: false });
    }
  }

  shutdown() {
    for (const [, live] of this.live) live.session.close();
    this.live.clear();
  }

  private send(card: Item, message: string, spoken: boolean) {
    const live = this.live.get(card.id);
    if (live) {
      live.queue.push(message);
      live.speak ||= spoken;
      return;
    }
    const row = this.o.board.row(card.id);
    this.o.board.setIdea(card.id, { thinking: true });
    this.launch(card, row.session_id ? message : `${this.briefing(card)}\n\n${message}`, row.session_id ?? undefined, spoken);
  }

  private launch(card: Item, message: string, resume: string | undefined, speak: boolean) {
    const live: Live = { session: undefined!, queue: [], replied: false, lastText: '', speak };
    this.live.set(card.id, live);
    live.session = this.o.runtime.start(
      {
        cwd: this.o.pathFor(card),
        readOnly: true,
        system: SYSTEM + (this.o.preferences?.() ? `\n\n${this.o.preferences()}` : ''),
        tools: this.tools(card.id, live),
        ...(resume ? { resume } : {}),
        onEvent: (e) => this.onEvent(card.id, live, e),
      },
      message,
    );
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    switch (e.type) {
      case 'session':
        this.o.board.work(cardId, { session_id: e.id });
        break;
      case 'text':
        live.lastText = e.text;
        break;
      case 'tool':
        // its own tools show in the conversation and the brief, not as reading
        if (!e.name.startsWith('mcp__') && !OWN_TOOLS.includes(e.name)) this.o.board.log(cardId, 'activity', 'explorer', describeTool(e.name, e.input));
        break;
      case 'error':
        this.o.board.log(cardId, 'error', 'obeya', e.message);
        this.close(cardId);
        break;
      case 'idle': {
        // a turn without reply still said something: that is the reply
        if (!live.replied && live.lastText.trim()) this.answer(cardId, live.lastText.trim());
        live.replied = false;
        live.lastText = '';
        if (live.queue.length) {
          live.session.send(live.queue.splice(0).join('\n\n'));
          return;
        }
        this.close(cardId);
        break;
      }
    }
  }

  /** The agent's reply stands in the conversation; the owner is next. */
  private answer(cardId: string, text: string) {
    this.o.board.log(cardId, 'talk', 'explorer', text);
    this.o.board.setIdea(cardId, { yourTurn: true });
  }

  private tools(cardId: string, live: Live): AgentTool[] {
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({ ...t, run: (args) => (this.live.get(cardId) === live ? t.run(args) : 'This conversation has ended. End your turn.') }));
    return current([
      {
        name: 'reply',
        description: `Your reply to the owner, shown on the card (markdown, in ${OWNER_LANGUAGE}). spoken: one or two short sentences in ${OWNER_LANGUAGE} that sum it up for the ear. Call it once per message, then end your turn.`,
        schema: { text: z.string(), spoken: z.string() },
        run: ({ text, spoken }) => {
          if (live.replied) return 'Already replied. End your turn now.';
          live.replied = true;
          this.answer(cardId, clip(String(text), 12000));
          if (live.speak && String(spoken).trim()) this.o.board.speak(cardId, clip(String(spoken).trim(), 400));
          live.speak = false;
          return 'Shown to the owner. End your turn now; their next message arrives as a new one.';
        },
      },
      {
        name: 'update_brief',
        description: `Replace the brief of the idea ("Stand der Idee"), in ${OWNER_LANGUAGE} markdown, whenever the conversation changed it. Always the whole text, standing on its own.`,
        schema: { brief: z.string() },
        run: ({ brief }) => {
          this.o.board.setIdea(cardId, { brief: clip(String(brief).trim(), 20000) });
          return 'Brief updated.';
        },
      },
      {
        name: 'record_decision',
        description: `The owner decided something in the conversation: record it in the decision log (question and answer in ${OWNER_LANGUAGE}, short).`,
        schema: { question: z.string(), answer: z.string() },
        run: ({ question, answer }) => {
          this.o.board.decide({ project_id: null, card_id: cardId, question: clip(String(question), 500), answer: clip(String(answer), 500), by: 'owner' });
          this.o.board.log(cardId, 'state', 'explorer', `Entscheidung: ${clip(String(question), 200)} → ${clip(String(answer), 200)}`);
          return 'Recorded.';
        },
      },
    ]);
  }

  private briefing(card: Item): string {
    return [
      `The idea: “${card.title}”.`,
      card.body.trim(),
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

const SYSTEM = `
You are the exploration agent of one idea on Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. The owner wants to think the idea through with you before anything is planned or built. It is one long conversation; it may go on days later.

You can only read: the code, the plan docs (docs/plan.md and the plan directory), and what the messages give you (decisions taken so far, the owner's preferences). You cannot change files, and nothing you do starts work.

How to talk:
- Ask what you need to know, one or two questions at a time.
- Show variants with their trade-offs, and say what each would cost: what it touches, roughly how much agent work, the risks.
- Ground what you say in the code and the plan; say when you are guessing.
- Be brief. The owner reads your reply on the card and hears only a short spoken summary.

Tools, within a turn in this order:
- record_decision: when the owner decided something in the message. General preferences (how they like to work) are not decisions; Obeya learns those on its own.
- update_brief: keep the brief ("Stand der Idee") current whenever the conversation changed it. It has these parts, as short bold-labelled paragraphs or lists: **Ziel**, **Varianten** (open and dropped ones, each with why), **Entscheidungen**, **Offene Fragen**, and **Aufwand** once you can say. Whoever opens the card later reads only the brief, so it must stand on its own. When the owner builds the idea as it stands, the brief is the worker's task.
- reply, last: your answer to the message, and spoken, its summary for the ear. Exactly once per message, then end your turn.

The owner decides on the card whether to build the idea, turn it into a plan doc, have a throwaway prototype (spike) built, park it or drop it. You may suggest one of these when the time has come.
Owner-facing text is in ${OWNER_LANGUAGE}.
`.trim();

const OWN_TOOLS = ['reply', 'update_brief', 'record_decision'];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
