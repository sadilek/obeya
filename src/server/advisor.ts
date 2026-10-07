// What the agents that answer the owner's questions (the Koordinator, a project agent) share, and
// how an agent's question to the owner is put together.

import { z } from 'zod';
import { type Language, LANGUAGE_NAMES } from '../core/locale';
import type { Question } from '../core/types';
import type { AgentRuntime } from './runtime';

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

/** A question as an agent asks it through a tool: with its own pick, the options it would choose if it had to decide, and why. */
export interface Asked {
  question: string;
  options?: string[];
  multiple?: boolean;
  pick?: string[];
  pick_why?: string;
}

/** A question as the card shows it, with the agent's own pick when that names its options. */
export function withPick(a: Asked): Question {
  const q = toQuestion(a.question, a.options, a.multiple);
  const picked = (a.pick ?? []).map((o) => String(o).trim()).filter((o) => q.options.includes(o));
  const options = q.multiple ? [...new Set(picked)] : picked.slice(0, 1);
  return options.length ? { ...q, pick: { options, why: clip(String(a.pick_why ?? '').trim(), 400) } } : q;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The decisions so far, as an agent reads them. */
export function decisionLog(decisions: { question: string; answer: string; by: string }[]): string {
  return decisions.length
    ? decisions.map((d) => `- ${d.question.split('\n')[0]} → ${d.answer} (${d.by === 'owner' ? 'owner' : 'an agent'})`).join('\n')
    : '(none yet)';
}
