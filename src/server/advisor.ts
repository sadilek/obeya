// One consultation of an advising agent (a project agent, the Koordinator): a read-only turn that
// either answers a worker's question or escalates it to the owner.

import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Question } from '../core/types';
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
        ...(c.resume ? { resume: c.resume } : {}),
        system: c.system,
        tools: [
          {
            name: 'answer',
            description: `Answer the worker yourself, in ${OWNER_LANGUAGE} (the owner reads it too), briefly. Say which source the answer rests on (plan doc section, earlier decision, preference, code).`,
            schema: { text: z.string() },
            run: ({ text }) => settle({ answer: String(text) }),
          },
          {
            name: 'escalate',
            description: `Pass the question to the owner, rewritten in ${OWNER_LANGUAGE} for a reader who has not seen the code, with up to four short answer options when they exist.`,
            schema: { question: z.string(), options: z.array(z.string()).max(4).optional() },
            run: ({ question, options }) => settle({ escalate: { text: String(question), options: (options as string[] | undefined) ?? [] } }),
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
