// Project agents: one long-lived, read-only session per project that answers its workers'
// questions from the plan doc, the decision log and the repository, or passes them on to the owner.

import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Item, Question } from '../core/types';
import type { Board } from './board';
import type { AgentRuntime } from './runtime';
import type { ProjectReply } from './workers';


export class ProjectAgents {
  /** Questions to one project are answered one after the other, in one session. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private board: Board,
    private runtime: AgentRuntime,
    /** The checkout the plan docs are read from. */
    private repoPath: string,
  ) {}

  ask(project: Item, card: Item, q: Question): Promise<ProjectReply> {
    const prev = this.queues.get(project.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.run(project, card, q));
    this.queues.set(project.id, next);
    return next;
  }

  private run(project: Item, card: Item, q: Question): Promise<ProjectReply> {
    return new Promise((resolve, reject) => {
      let reply: ProjectReply | null = null;
      const settle = (r: ProjectReply) => {
        if (reply) return 'Only the first reply counts.';
        reply = r;
        resolve(r);
        return 'Delivered. End your turn now.';
      };
      const row = this.board.row(project.id);
      const session = this.runtime.start(
        {
          cwd: this.repoPath,
          readOnly: true,
          ...(row.session_id ? { resume: row.session_id } : {}),
          system: this.system(project),
          tools: [
            {
              name: 'answer',
              description: `Answer the worker yourself, in ${OWNER_LANGUAGE} (the owner reads it too), briefly. Say which source the answer rests on (plan doc section, earlier decision, code).`,
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
            if (e.type === 'session') this.board.work(project.id, { session_id: e.id });
            else if (e.type === 'error' && !reply) {
              session.close();
              reject(new Error(e.message));
            } else if (e.type === 'idle') {
              session.close();
              // a turn without a reply: the owner decides
              if (!reply) settle({ escalate: q });
            }
          },
        },
        this.message(project, card, q),
      );
    });
  }

  private system(project: Item): string {
    return `
You are the project agent of the project "${project.title}", directed through Obeya. Its plan doc is ${project.plan?.file ?? '(none)'} in this repository. Workers implement the project's workstreams and send you the questions they cannot decide themselves.

For each question, either answer it or escalate it to the owner:
- Answer when the plan doc, an earlier decision or the code settles it, or when it is a technical judgement call the plan leaves open and a senior engineer on the team would make it without asking.
- Escalate product decisions, trade-offs the plan does not settle, anything irreversible or external (money, customers, other teams, production data), and anything you are unsure about.
Your answers are shown to the owner, who may overrule them. Read what you need (plan doc first), then call exactly one of answer or escalate, and end your turn. You cannot change files.
`.trim();
  }

  private message(project: Item, card: Item, q: Question): string {
    const decisions = this.board.decisions(project.id);
    const log = decisions.length
      ? decisions.map((d) => `- ${d.question.split('\n')[0]} → ${d.answer} (${d.by === 'owner' ? 'owner' : 'you'})`).join('\n')
      : '(none yet)';
    return [
      `Question from the worker on ${card.label ?? 'a workstream'} "${card.title}":`,
      q.text,
      q.options.length ? `Options the worker suggests:\n${q.options.map((o) => `- ${o}`).join('\n')}` : '',
      `Decisions taken in this project so far:\n${log}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
