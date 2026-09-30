// Project agents: one long-lived, read-only session per project that answers its workers'
// questions from the plan doc, the decision log and the repository, or passes them on to the owner.

import type { Item, Question } from '../core/types';
import { ADVICE_RULES, consult, decisionLog, type Reply } from './advisor';
import type { Board } from './board';
import type { AgentRuntime } from './runtime';

export class ProjectAgents {
  /** Questions to one project are answered one after the other, in one session. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private board: Board,
    private runtime: AgentRuntime,
    /** The checkout the plan docs are read from. */
    private repoPath: string,
    private preferences: () => string = () => '',
  ) {}

  ask(project: Item, card: Item, q: Question): Promise<Reply> {
    const prev = this.queues.get(project.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() =>
        consult({
          runtime: this.runtime,
          cwd: this.repoPath,
          resume: this.board.row(project.id).session_id ?? undefined,
          onSession: (id) => this.board.work(project.id, { session_id: id }),
          system: `You are the project agent of the project "${project.title}", directed through Obeya. Its plan doc is ${project.plan?.file ?? '(none)'} in this repository. Workers implement the project's workstreams and send you the questions they cannot decide themselves.\n\n${ADVICE_RULES}`,
          message: [
            `Question from the worker on ${card.label ?? 'a workstream'} "${card.title}":`,
            q.text,
            q.options.length ? `Options the worker suggests:\n${q.options.map((o) => `- ${o}`).join('\n')}` : '',
            `Decisions taken in this project so far:\n${decisionLog(this.board.decisions(project.id))}`,
            this.preferences(),
          ]
            .filter(Boolean)
            .join('\n\n'),
          fallback: q,
        }),
      );
    this.queues.set(project.id, next);
    return next;
  }
}
