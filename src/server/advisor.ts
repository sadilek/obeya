// One consultation of an advising agent (a project agent, the Koordinator): a read-only turn that
// either answers a worker's question or escalates it to the owner.

import { z } from 'zod';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import type { AgentEffort, Question } from '../core/types';
import type { AgentRuntime } from './runtime';

/** An advisor's reply to a worker's question. */
export type Reply = { answer: string } | { escalate: Question };

export interface Consultation {
  runtime: AgentRuntime;
  cwd: string;
  system: string;
  message: string;
  /** Resume the advisor's session, so it remembers earlier questions. */
  resume?: string;
  onSession: (id: string) => void;
  /** Returned when the turn ends without a reply. */
  fallback: Question;
  /** The owner's language, which the answer and the question to the owner are in. */
  language: Language;
}

export function consult(c: Consultation): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let reply: Reply | null = null;
    const settle = (r: Reply) => {
      if (reply) return 'Only the first reply counts.';
      reply = r;
      resolve(r);
      return 'Delivered. End your turn now.';
    };
    const session = c.runtime.start(
      {
        cwd: c.cwd,
        readOnly: true,
        role: 'koordinator',
        ...(c.resume ? { resume: c.resume } : {}),
        system: c.system,
        tools: [
          {
            name: 'answer',
            description: `Answer the worker yourself, in ${LANGUAGE_NAMES[c.language]} (the owner reads it too), briefly. Say which source the answer rests on (plan doc section, earlier decision, preference, code).`,
            schema: { text: z.string() },
            run: ({ text }) => settle({ answer: String(text) }),
          },
          {
            name: 'escalate',
            description: `Pass the question to the owner, rewritten in ${LANGUAGE_NAMES[c.language]} for a reader who has not seen the code, with up to four short answer options when they exist (multiple: true when several may be chosen together).`,
            schema: { question: z.string(), options: z.array(z.string()).max(4).optional(), multiple: z.boolean().optional() },
            run: ({ question, options, multiple }) => settle({ escalate: toQuestion(question, options, multiple) }),
          },
        ],
        onEvent: (e) => {
          if (e.type === 'session') c.onSession(e.id);
          else if (e.type === 'error' && !reply) {
            session.close();
            reject(new Error(e.message));
          } else if (e.type === 'idle') {
            session.close();
            // a turn without a reply: the owner decides
            if (!reply) settle({ escalate: c.fallback });
          }
        },
      },
      c.message,
    );
  });
}

/** An answer to a question the owner asked: in full for the card or the sheet, and short for the ear. */
export interface OwnerAnswer {
  text: string;
  spoken: string;
}

export interface Briefing {
  runtime: AgentRuntime;
  cwd: string;
  system: string;
  message: string;
  resume?: string;
  onSession?: (id: string) => void;
  /** What the agent reads, as it reads it. */
  onTool?: (name: string, input: Record<string, unknown>) => void;
  effort?: AgentEffort;
  /** The owner's language, which the answer is in. */
  language: Language;
}

/** A read-only turn that answers the owner's question; a turn that ends without the tool answers with its last words. */
export function inform(b: Briefing): Promise<OwnerAnswer> {
  return new Promise((resolve, reject) => {
    let answer: OwnerAnswer | null = null;
    let last = '';
    const settle = (a: OwnerAnswer) => {
      if (answer) return 'Only the first answer counts.';
      answer = a;
      resolve(a);
      return 'Delivered. End your turn now.';
    };
    const session = b.runtime.start(
      {
        cwd: b.cwd,
        readOnly: true,
        role: 'koordinator',
        ...(b.resume ? { resume: b.resume } : {}),
        ...(b.effort ? { effort: b.effort } : {}),
        system: b.system,
        tools: [
          {
            name: 'answer_owner',
            description: `Your answer to the owner, in ${LANGUAGE_NAMES[b.language]}: text in full (markdown, short paragraphs or a list; it stands in the card's log), spoken one or two short sentences that sum it up for the ear.`,
            schema: { text: z.string(), spoken: z.string() },
            run: ({ text, spoken }) => settle({ text: String(text).trim(), spoken: String(spoken).trim() }),
          },
        ],
        onEvent: (e) => {
          if (e.type === 'session') b.onSession?.(e.id);
          else if (e.type === 'text') last = e.text;
          else if (e.type === 'tool') b.onTool?.(e.name, e.input);
          else if (e.type === 'error' && !answer) {
            session.close();
            reject(new Error(e.message));
          } else if (e.type === 'idle') {
            session.close();
            if (answer) return;
            if (last.trim()) settle({ text: last.trim(), spoken: '' });
            else reject(new Error('no answer'));
          }
        },
      },
      b.message,
    );
  });
}

/** How to answer a question of the owner's, the same for every agent that answers one. */
export const INFORM_RULES = `
The owner asked a question about the canvas by voice. The Koordinator, which reads every command in a quick turn, could not answer it from the cards alone and passed it to you; it told the owner the answer comes in a moment. Take the time to look it up: the repository's docs and plan docs, CLAUDE.md, the code, and what the message gives you.
- "What would the agent do on this card?": the message holds the task the card's worker gets at its start. Derive from it, the plan doc and the repository's instructions the concrete steps the worker would take, in order, and what it would ask the owner. Say what it would change, and where the plan leaves it open.
- Answer what was asked, concretely and grounded in what you read; name the source (plan doc section, file). Say where you are guessing. Never answer that you cannot know: say what the sources say.
- The owner does not read code: no code blocks, file paths only where they help.
Read what you need, then call answer_owner exactly once and end your turn. You cannot change files.
`.trim();

/**
 * A question from an agent's tool call, as the owner gets it: the options the card offers to choose
 * from (the owner can always write something else), several of them when `multiple`.
 */
export function toQuestion(text: unknown, options: unknown, multiple?: unknown): Question {
  const opts = [...new Set((Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean))];
  return { text: clip(String(text).trim(), 2000), options: opts, ...(multiple === true && opts.length > 1 ? { multiple: true } : {}) };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** When to answer and when to escalate, the same for every advisor. */
export const ADVICE_RULES = `
For each question, either answer it or escalate it to the owner:
- Answer when the plan doc, an earlier decision, a recorded preference of the owner or the code settles it, or when it is a technical judgement call a senior engineer on the team would make without asking.
- Escalate product decisions, trade-offs nothing settles, anything irreversible or external (money, customers, other teams, production data), and anything you are unsure about.
Your answers are shown to the owner, who may overrule them. Read what you need, then call exactly one of answer or escalate, and end your turn. You cannot change files.
`.trim();

/** The decisions so far, as the advisor reads them. */
export function decisionLog(decisions: { question: string; answer: string; by: string }[]): string {
  return decisions.length
    ? decisions.map((d) => `- ${d.question.split('\n')[0]} → ${d.answer} (${d.by === 'owner' ? 'owner' : 'an agent'})`).join('\n')
    : '(none yet)';
}
