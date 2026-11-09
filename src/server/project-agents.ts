// Project agents: one long-lived session per project that answers the owner's questions about it
// from the plan doc, the decision log and the repository, with a worker's tools to check what it says.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Item } from '../core/types';
import { oneAtATime } from '../core/one-at-a-time';
import { type Briefing, decisionLog, INFORM_RULES, inform, type OwnerAnswer } from './advisor';
import { type Board, pathOfRef } from './board';
import { outsidePlanDir } from './repo';
import type { AgentRuntime, AgentTool } from './runtime';
import { TO_OBEYA } from './to-obeya';

export class ProjectAgents {
  /** Questions about one project are answered one after the other, in one session. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private board: Board,
    private runtime: AgentRuntime,
    /** The repository's read tree, which the plan docs are read from (read-tree.ts). */
    private repoPath: () => string,
    private preferences: () => string = () => '',
    /** The workers' permission mode, which the project agent runs in too. */
    private permissionMode?: PermissionMode,
  ) {}

  /**
   * Answers a question the owner asked about the project or one of its workstreams, in the project's
   * session. `dir`: the output directory of the looked-up thread, which the answer's files are in;
   * `signal` ends the turn at once; `onLimit` shows where it waits for the usage limit; `onWaiting`
   * passes the owner's words in while it waits for its background work (`Briefing.onWaiting`).
   * Written in the project's sheet, straight to it: its screenshots (`images`), and `toObeya` for
   * what the words ask of Obeya rather than of it. `tools` and `rules`: what the look-up adds (a
   * walkthrough's).
   */
  inform(
    project: Item,
    message: string,
    onLimit: (until: number | undefined) => void,
    more: {
      onTool?: (name: string, input: Record<string, unknown>) => void;
      dir?: string;
      signal?: AbortSignal;
      onWaiting?: Briefing['onWaiting'];
      images?: string[];
      toObeya?: AgentTool;
      tools?: AgentTool[];
      rules?: string;
    } = {},
  ): Promise<OwnerAnswer> {
    const { onTool, dir, signal, onWaiting, images, toObeya, rules = '' } = more;
    const tools = [...(more.tools ?? []), ...(toObeya ? [toObeya] : [])];
    return this.queued(project, () =>
      inform({
        onLimit,
        runtime: this.runtime,
        cwd: this.repoPath(),
        resume: this.board.row(project.id).session_id ?? undefined,
        spendOn: project.id,
        onSession: (id, model) => this.board.work(project.id, { session_id: id, model: model ?? null }),
        ...(onTool ? { onTool } : {}),
        ...(dir ? { dir } : {}),
        ...(signal ? { signal } : {}),
        ...(onWaiting ? { onWaiting } : {}),
        ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
        ...(images?.length ? { images } : {}),
        ...(tools.length ? { tools } : {}),
        system: `You are the project agent of the project "${project.title}", directed through Obeya. Its plan doc is ${project.plan?.file ?? '(none)'}${project.plan && outsidePlanDir(pathOfRef(project.plan.file)) ? '' : ' in this repository'}; you know it and the history of its workstreams.\n\n${INFORM_RULES}${rules}${toObeya ? `\n\n${TO_OBEYA}` : ''}`,
        message: [message, `Decisions taken in this project so far:\n${decisionLog(this.board.decisions(project.id))}`, this.preferences()].filter(Boolean).join('\n\n'),
        language: this.board.conversation(),
      }),
    );
  }

  /** One question at a time per project, in one session. */
  private queued<T>(project: Item, fn: () => Promise<T>): Promise<T> {
    return oneAtATime(this.queues, project.id, fn);
  }
}
