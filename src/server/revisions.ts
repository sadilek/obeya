// A proposal reworked by what the owner said about it: an agent rewrites its text, reason and
// questions in one read-only turn, and the proposal waits for it. What the owner did not touch stays.

import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Item } from '../core/types';
import { toQuestion } from './advisor';
import type { Board } from './board';
import type { AgentRuntime } from './runtime';

export interface RevisionOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the agent may read in: the card's repository. */
  pathFor: (card: Item) => string;
  preferences?: () => string;
  /** The revision is over: the new text stands (`revised`), or the agent ended without one and the old text stays. */
  onRevised?: (cardId: string, revised: boolean) => void;
}

/** A proposal as the agent writes it back. */
interface Revised {
  title: string;
  task: string;
  reason?: string;
  idea?: boolean;
  questions: { question: string; options?: string[]; multiple?: boolean }[];
}

export class Revisions {
  /** Proposals being reworked, so a resume does not start a second agent. */
  private busy = new Set<string>();

  constructor(private o: RevisionOptions) {}

  /** The owner's words on a proposal: it waits while an agent reworks it by them. */
  revise(cardId: string, words: string, spoken: boolean) {
    this.o.board.revising(cardId, words, spoken);
    this.run(cardId);
  }

  /** After a restart: proposals still being reworked are reworked again. */
  resume() {
    for (const i of this.o.board.snapshot().items) if (i.proposal?.revising) this.run(i.id);
  }

  private run(cardId: string) {
    if (this.busy.has(cardId)) return;
    const card = this.o.board.item(cardId);
    const said = card?.proposal?.revising;
    if (!card || !said) return;
    this.busy.add(cardId);
    this.ask(card, said)
      .then(
        (r) => {
          const questions = r.questions.map((q) => toQuestion(q.question, q.options, q.multiple));
          if (!this.o.board.revised(cardId, { title: r.title, task: r.task, ...(r.reason ? { reason: r.reason } : {}), idea: !!r.idea, questions })) return;
          this.o.board.log(cardId, 'state', 'koordinator', 'Vorschlag überarbeitet.');
          return true;
        },
        (e) => {
          if (!this.o.board.revised(cardId)) return;
          this.o.board.log(cardId, 'error', 'koordinator', `Überarbeiten ging nicht: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      )
      .then((revised) => revised !== undefined && this.o.onRevised?.(cardId, revised))
      .catch((e) => console.error('revision:', e))
      .finally(() => this.busy.delete(cardId));
  }

  private ask(card: Item, said: { words: string; spoken?: boolean }): Promise<Revised> {
    return new Promise((resolve, reject) => {
      let done = false;
      const session = this.o.runtime.start(
        {
          cwd: this.o.pathFor(card),
          readOnly: true,
          effort: 'medium',
          system: [SYSTEM, this.o.preferences?.() ?? ''].filter(Boolean).join('\n\n'),
          tools: [
            {
              name: 'revise_proposal',
              description: [
                `The whole proposal as it is to stand now, in ${OWNER_LANGUAGE}.`,
                `title: short and precise. task: the card's text, written for the agent who will take it on, which has seen neither the card it came from nor this conversation: what is wrong or wanted, where (files, names), what done looks like; as the owner would write a card: no "I", no "my question"; other cards named by their title.`,
                `reason: for the owner only, why it is proposed, a sentence or two (keep it unless what the owner said changes it). idea: true for something to think through with the owner before anyone builds it.`,
                `questions: what the owner still has to decide, each with up to four short options; keep them out of task. A question the owner's words settle goes, and its decision goes into task.`,
              ].join(' '),
              schema: {
                title: z.string(),
                task: z.string(),
                reason: z.string().optional(),
                idea: z.boolean().optional(),
                questions: z.array(z.object({ question: z.string(), options: z.array(z.string()).max(4).optional(), multiple: z.boolean().optional() })).max(5),
              },
              run: (r) => {
                if (done) return 'Only the first one counts.';
                if (!String(r.title).trim() || !String(r.task).trim()) return 'Not recorded: title and task must not be empty.';
                done = true;
                resolve(r as unknown as Revised);
                return 'Recorded. End your turn now.';
              },
            },
          ],
          onEvent: (e) => {
            if (e.type === 'error' && !done) {
              session.close();
              reject(new Error(e.message));
            } else if (e.type === 'idle') {
              session.close();
              if (!done) reject(new Error('der Agent hat keinen neuen Text geliefert'));
            }
          },
        },
        this.message(card, said),
      );
    });
  }

  private message(card: Item, said: { words: string; spoken?: boolean }): string {
    const p = card.proposal!;
    const from = card.from ? this.o.board.item(card.from) : undefined;
    const summary = from ? this.o.board.summary(from.id)?.trim() : undefined;
    return [
      `The proposal as it stands${p.idea ? ' (proposed as an idea)' : ''}:\n\n<title>${card.title}</title>\n\n<task>\n${card.body}\n</task>`,
      p.reason ? `Why it was proposed (for the owner only): ${p.reason}` : '',
      card.retro ? `The Arbeitsrückschau proposed it, resting on: ${card.retro}` : '',
      p.questions.length
        ? `Its questions to the owner:\n${p.questions.map((q) => `- ${q.text}${q.options.length ? ` (options: ${q.options.join(' / ')}${q.multiple ? '; several may be chosen' : ''})` : ''}`).join('\n')}`
        : 'It has no questions to the owner.',
      from ? `It came from the card "${from.title}"${summary ? `, whose worker handed over:\n\n${summary}` : '.'}` : '',
      `What the owner ${said.spoken ? 'said about it (speech recognition, may contain errors)' : 'wrote about it'}:\n\n<owner>\n${said.words}\n</owner>`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

const SYSTEM = `
You rework a card an agent proposed on Obeya, a canvas on which the owner directs coding agents. The owner read the proposal and said what should change: what to add, drop, decide or put differently. Rewrite the proposal by their words: what they did not touch stays as it was, in its wording; what they said goes in, as they meant it, in the card's text and not as a quote of them. Spoken words may be misheard: read them for what they most likely meant.
The card's text is all the agent who takes it on gets, so it must stand on its own. Read in the repository only where the owner's words need it (a file, a name they mention). Then call revise_proposal once with the whole proposal and end your turn. You cannot change files.
`.trim();
