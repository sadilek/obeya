// Spoken (or typed) commands: the Koordinator reads what the owner said as one action, confirms
// it, and runs it after a short delay unless the owner takes it back.

import { z } from 'zod';
import type { Item } from '../core/types';
import { BadRequest, type Board } from './board';
import type { AgentRuntime, AgentSession, AgentTool } from './runtime';

export type Command =
  | { do: 'newCard'; kind: 'bugfix' | 'feature'; title: string; body: string; start: boolean; repo?: string }
  | { do: 'start' | 'approve' | 'accept' | 'dismiss' | 'split' | 'stop'; card: string }
  | { do: 'note' | 'answer' | 'feedback'; card: string; text: string };

export interface Heard {
  /** What the owner hears and reads back. */
  confirm: string;
  /** Takes the command back while it waits; absent when there was nothing to do. */
  token?: string;
}

export interface Focus {
  card?: string;
  project?: string;
}

export interface CommanderOptions {
  board: Board;
  runtime: AgentRuntime;
  cwd: string;
  /** Runs a command; what it throws is logged on the card. */
  execute: (c: Command) => unknown | Promise<unknown>;
  /** How long a command waits for "Rückgängig". */
  delayMs?: number;
}

interface Reader {
  session: AgentSession;
  ended: boolean;
  /** The command being read; absent while the agent waits for one. */
  reading?: {
    tags: Map<string, string>;
    finish: (command: Command | null, confirm: string) => string;
    fail: (e: Error) => void;
  };
}

export class Commander {
  /** Commands between being understood and running; the timer is set once the owner has the confirmation. */
  private waiting = new Map<string, { command: Command; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private o: CommanderOptions) {}

  /** Understands the command; it runs only after `arm`, so the undo window starts when the owner hears back. */
  async hear(transcript: string, focus: Focus): Promise<Heard> {
    const { command, confirm } = await this.interpret(transcript, focus);
    if (!command) return { confirm };
    const token = crypto.randomUUID();
    this.waiting.set(token, { command });
    return { confirm, token };
  }

  /** How long a command waits for undo once armed. */
  get delayMs(): number {
    return this.o.delayMs ?? 5000;
  }

  arm(token: string) {
    const w = this.waiting.get(token);
    if (!w || w.timer) return;
    w.timer = setTimeout(async () => {
      this.waiting.delete(token);
      try {
        await this.o.execute(w.command);
      } catch (e) {
        const card = 'card' in w.command ? w.command.card : undefined;
        if (card) this.o.board.log(card, 'error', 'obeya', e instanceof Error ? e.message : String(e), e instanceof BadRequest ? e.code : undefined);
        else console.error('voice command:', e);
      }
    }, this.delayMs);
  }

  /** Takes a waiting command back; false when it already ran. */
  undo(token: string): boolean {
    const w = this.waiting.get(token);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(token);
    return true;
  }

  /** Words Whisper should expect: Obeya's own, and the titles on the canvas. */
  vocabulary(): string {
    const titles = this.o.board
      .snapshot()
      .items.filter((i) => i.state !== 'live')
      .map((i) => i.title.replace(/[`*_]/g, ''));
    return ['Obeya, Koordinator, Karte, Workstream, Bugfix, Feature, Demo, freigeben, Pull Request, Agent.', ...titles].join(' ').slice(0, 900);
  }

  /**
   * Starts the next reading's agent ahead, so a command does not wait for its start-up. Called
   * when the owner starts speaking, and after each command for the next one.
   */
  warm() {
    if (!this.spare) this.spare = this.open();
  }

  /** The agent waiting for the next command, if any. */
  private spare: Reader | null = null;

  /** An agent that reads one command; its tools act on whatever `reading` it has been given. */
  private open(): Reader {
    const r: Reader = { session: null as unknown as AgentSession, ended: false };
    const tagged = (tag: unknown) => r.reading?.tags.get(String(tag)) ?? null;
    const finish = (command: Command | null, confirm: string) => (r.reading ? r.reading.finish(command, confirm) : 'No command to read.');
    const onCard = (name: Exclude<Command['do'], 'newCard' | 'note' | 'answer' | 'feedback'>, what: string): AgentTool => ({
      name,
      description: `${what} Pass the card's tag and the confirmation.`,
      schema: { card: z.string(), confirm: z.string() },
      run: ({ card: tag, confirm }) => {
        const id = tagged(tag);
        return id ? finish({ do: name, card: id }, String(confirm)) : `Unknown tag ${String(tag)}.`;
      },
    });
    const withText = (name: 'note' | 'answer' | 'feedback', what: string): AgentTool => ({
      name,
      description: `${what} Pass the card's tag, the text as the owner meant it (fix obvious recognition errors), and the confirmation.`,
      schema: { card: z.string(), text: z.string(), confirm: z.string() },
      run: ({ card: tag, text, confirm }) => {
        const id = tagged(tag);
        return id ? finish({ do: name, card: id, text: String(text) }, String(confirm)) : `Unknown tag ${String(tag)}.`;
      },
    });
    r.session = this.o.runtime.start({
      cwd: this.o.cwd,
      readOnly: true,
      effort: 'low',
      system: SYSTEM,
      tools: [
        {
          name: 'new_card',
          description: `A new card. Title short and precise; body what the owner asked for, in their words. start: whether the owner wants work to begin right away.${this.o.board.canvas.repos.length > 1 ? ' repo: the repository it belongs to (an id from the list).' : ''}`,
          schema: { kind: z.enum(['bugfix', 'feature']), title: z.string(), body: z.string(), start: z.boolean(), repo: z.string().optional(), confirm: z.string() },
          run: (a) => {
            const repos = this.o.board.canvas.repos;
            const repo = repos.length > 1 && repos.some((r) => r.id === a.repo) ? String(a.repo) : undefined;
            return finish(
              { do: 'newCard', kind: a.kind as 'bugfix' | 'feature', title: String(a.title), body: String(a.body), start: Boolean(a.start), ...(repo ? { repo } : {}) },
              String(a.confirm),
            );
          },
        },
        onCard('start', 'Start work on a planned card.'),
        withText('note', "A note to the agent working on a card; it doesn't stop it."),
        withText('answer', "The answer to the card's open question."),
        withText('feedback', 'Feedback on work that waits for review (demo or summary); the agent works on it again.'),
        onCard('approve', 'Approve work that waits for review (demo or summary).'),
        onCard('accept', 'Accept a proposed card.'),
        onCard('dismiss', 'Dismiss a proposed card.'),
        onCard('split', 'Let the Koordinator cut a planned card into packages.'),
        onCard('stop', 'Stop the agent working on a card.'),
        {
          name: 'reply',
          description: 'Nothing to do, or unclear what is meant: just say so (ask what is meant, briefly).',
          schema: { confirm: z.string() },
          run: ({ confirm }) => finish(null, String(confirm)),
        },
      ],
      onEvent: (e) => {
        if (e.type === 'error') {
          r.session.close();
          r.reading?.fail(new Error(e.message));
        } else if (e.type === 'idle') {
          r.session.close();
          r.reading?.finish(null, 'Das habe ich nicht verstanden.');
        }
      },
    });
    r.session.done.then(() => {
      r.ended = true;
      if (this.spare === r) this.spare = null;
    });
    return r;
  }

  private interpret(transcript: string, focus: Focus, retry = true): Promise<{ command: Command | null; confirm: string }> {
    const items = this.o.board.snapshot().items;
    const relevant = items.filter((i) => i.kind !== 'project' && (i.state !== 'live' || i.id === focus.card));
    const tags = new Map(relevant.map((i, n) => [`K${n + 1}`, i.id]));
    const tagOf = new Map([...tags].map(([t, id]) => [id, t]));
    const waited = this.spare && !this.spare.ended ? this.spare : null;
    const reader = waited ?? this.open();
    this.spare = null;
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = () => {
        done = true;
        this.warm();
      };
      reader.reading = {
        tags,
        finish: (command, confirm) => {
          if (done) return 'Already decided.';
          settle();
          resolve({ command, confirm: confirm.trim().slice(0, 300) });
          return 'Done. End your turn now.';
        },
        fail: (e) => {
          if (done) return;
          done = true;
          // an agent that waited long may have gone stale: read the command once more on a fresh one
          if (waited && retry) return resolve(this.interpret(transcript, focus, false));
          settle();
          reject(e);
        },
      };
      reader.session.send(this.brief(transcript, focus, items, relevant, tagOf));
    });
  }

  private brief(transcript: string, focus: Focus, items: Item[], relevant: Item[], tagOf: Map<string, string>): string {
    const describe = (i: Item) => {
      const project = i.parent ? items.find((p) => p.id === i.parent) : undefined;
      const state = i.queue ? 'queued' : i.need ? `${i.state}: ${i.need}` : i.state;
      const repo = this.o.board.canvas.repos.length > 1 ? ` in ${i.repo}` : '';
      return `${tagOf.get(i.id)} [${state}] ${i.kind} "${i.title}"${repo}${project ? ` (project "${project.title}")` : ''}${i.question ? ` — open question: ${i.question.text}` : ''}`;
    };
    const focused = focus.card ? relevant.find((i) => i.id === focus.card) : undefined;
    const project = focus.project ? items.find((i) => i.id === focus.project) : undefined;
    return [
      `The owner said (speech recognition, may contain errors): "${transcript}"`,
      focused ? `The owner has this card open, so "it", "this" and a bare answer refer to it: ${describe(focused)}` : project ? `The owner is looking at the project "${project.title}".` : 'No card is open: the owner speaks to you, the Koordinator.',
      `Cards on the canvas:\n${relevant.map(describe).join('\n') || '(none)'}`,
      ...(this.o.board.canvas.repos.length > 1
        ? [`Repositories on this canvas (the first is the default for a new card): ${this.o.board.canvas.repos.map((r) => `${r.id} (${r.name})`).join(', ')}`]
        : []),
    ].join('\n\n');
  }
}

const SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents by voice. You get what the owner just said, transcribed by speech recognition: words may be misheard, so read for what they most likely meant, using the card titles as vocabulary.

Call exactly one tool, then end your turn:
- the action the owner asked for, on the card they meant (the open card unless they name another), or new_card;
- reply, when nothing fits or it is unclear which card or what is meant.
Every tool takes confirm: one short German sentence the owner hears back, saying what will happen, naming the card ("Neue Karte „Zählerstände als CSV“, der Agent fängt an." / "„Rabatt“ freigegeben." / "An den Agenten von „Export“ weitergegeben."). No preamble, no questions back unless you use reply.
`.trim();
