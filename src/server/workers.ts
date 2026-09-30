// Workers: one agent session per card, in a leased clone. Obeya is the mailbox between the
// worker, its project agent and the owner; every exchange lands in the card's log.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Item, Question } from '../core/types';
import { BadRequest, type Board } from './board';
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool } from './runtime';
import { branchName, WorkspaceError, type Workspaces } from './workspaces';

/** A project agent's reply to a worker's question. */
export type ProjectReply = { answer: string } | { escalate: Question };

export interface WorkerOptions {
  board: Board;
  runtime: AgentRuntime;
  workspaces: Workspaces;
  adapter: RepoAdapter;
  permissionMode?: 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'default';
  /** Answers a workstream's question on the owner's behalf, or escalates it. */
  askProject?: (project: Item, card: Item, q: Question) => Promise<ProjectReply>;
}

interface Live {
  session: AgentSession;
  /** Whether the worker called `ask` or `ready_for_review` in the current turn. */
  handedOver: boolean;
  nudged: boolean;
  lastText: string;
}

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

export class Workers {
  private live = new Map<string, Live>();

  constructor(private o: WorkerOptions) {}

  // ---------------------------------------------------------------- owner actions

  start(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') throw new BadRequest('a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('only a planned card can be started');
    const branch = branchName(card.title, card.id);
    let path: string;
    try {
      path = this.o.workspaces.lease(card.id, branch);
    } catch (e) {
      if (e instanceof WorkspaceError) throw new BadRequest(e.message);
      throw e;
    }
    this.o.board.work(card.id, { state: 'working', need: null, detail: null, status_line: null, workspace: path, branch, session_id: null });
    this.o.board.log(card.id, 'state', 'obeya', `Agent gestartet auf ${branch}.`);
    this.launch(card.id, this.briefing(card, branch));
  }

  /** A hint while the worker runs, or feedback on its review. */
  message(cardId: string, text: string) {
    const card = this.card(cardId);
    if (card.state === 'waiting' && card.need === 'review') {
      this.o.board.work(cardId, { state: 'working', need: null, detail: null });
      this.o.board.log(cardId, 'hint', 'owner', text);
      this.deliver(cardId, `Feedback from the owner on your work. Address it, then call ready_for_review again:\n\n${text}`);
    } else if (card.state === 'working' || (card.state === 'waiting' && card.need === 'question')) {
      this.o.board.log(cardId, 'hint', 'owner', text);
      this.deliver(cardId, `A note from the owner (it does not stop you; adjust your plan if it changes anything):\n\n${text}`);
    } else throw new BadRequest('no agent works on this card');
  }

  answer(cardId: string, text: string, by: 'owner' | 'project' = 'owner') {
    const card = this.card(cardId);
    if (!(card.state === 'waiting' && card.need === 'question') && by === 'owner') throw new BadRequest('the card has no open question');
    const row = this.o.board.row(cardId);
    const question = row.detail ? (JSON.parse(row.detail).question as Question | undefined) : undefined;
    const q = question?.text ?? this.pendingQuestion(cardId) ?? '';
    this.o.board.work(cardId, { state: 'working', need: null, detail: null });
    this.o.board.log(cardId, 'answer', by, text);
    this.recordDecision(card, q, text, by);
    this.deliver(cardId, `Answer to your question${by === 'project' ? ' (from the project agent, on the owner’s behalf)' : ' (from the owner)'}:\n\n${text}`);
  }

  async approve(cardId: string) {
    const card = this.card(cardId);
    if (!(card.state === 'waiting' && card.need === 'review')) throw new BadRequest('the card is not ready for review');
    const row = this.o.board.row(cardId);
    if (this.o.adapter.land === 'main') {
      const problem = this.o.workspaces.landOnMain(cardId, row.branch!);
      if (problem) {
        this.o.board.work(cardId, { state: 'working', need: null, detail: null });
        this.o.board.log(cardId, 'error', 'obeya', problem);
        this.deliver(cardId, `Your work could not land on main: ${problem}\nFix this in your clone, then call ready_for_review again.`);
        return;
      }
    }
    this.end(cardId);
    if (this.o.adapter.land !== 'main') this.o.workspaces.release(cardId);
    const state = this.o.adapter.land === 'main' ? 'live' : 'approved';
    this.o.board.work(cardId, { state, need: null, detail: null, ...(this.o.adapter.land === 'main' ? { workspace: null } : {}) });
    this.o.board.log(cardId, 'state', 'owner', this.o.adapter.land === 'main' ? 'Freigegeben und auf main.' : 'Freigegeben.');
  }

  stop(cardId: string) {
    const card = this.card(cardId);
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('no agent works on this card');
    this.end(cardId);
    this.o.workspaces.release(cardId);
    this.o.board.work(cardId, { state: 'planned', need: null, detail: null, workspace: null });
    this.o.board.log(cardId, 'state', 'owner', 'Angehalten.');
  }

  /** After a restart: resume every card whose worker was in the middle of a turn. */
  resumeAll() {
    for (const i of this.o.board.snapshot().items) {
      const row = this.o.board.row(i.id);
      if (i.state === 'working' && row.session_id) this.launch(i.id, 'Obeya was restarted. Continue where you left off.', row.session_id);
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.end(id);
  }

  // ---------------------------------------------------------------- sessions

  private launch(cardId: string, message: string, resume?: string) {
    const row = this.o.board.row(cardId);
    const live: Live = { session: undefined!, handedOver: false, nudged: false, lastText: '' };
    this.live.set(cardId, live);
    live.session = this.o.runtime.start(
      {
        cwd: row.workspace!,
        system: this.system(),
        tools: this.tools(cardId),
        ...(resume ? { resume } : {}),
        ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
        onEvent: (e) => this.onEvent(cardId, live, e),
      },
      message,
    );
    live.session.done.then(() => {
      if (this.live.get(cardId) === live) this.live.delete(cardId);
    });
  }

  private deliver(cardId: string, text: string) {
    const live = this.live.get(cardId);
    if (live) {
      live.session.send(text);
      return;
    }
    const row = this.o.board.row(cardId);
    this.launch(cardId, text, row.session_id ?? undefined);
  }

  private end(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    live?.session.close();
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    switch (e.type) {
      case 'session':
        this.o.board.work(cardId, { session_id: e.id });
        break;
      case 'text':
        live.lastText = e.text;
        // after handing over, the worker's closing words repeat what the card already shows
        if (!live.handedOver) this.o.board.log(cardId, 'say', 'worker', clip(e.text, 600));
        break;
      case 'tool':
        if (!e.name.startsWith('mcp__obeya__')) this.o.board.log(cardId, 'activity', 'worker', describeTool(e.name, e.input));
        break;
      case 'error':
        this.o.board.log(cardId, 'error', 'obeya', e.message);
        break;
      case 'idle':
        this.turnEnded(cardId, live);
        break;
    }
  }

  /** A turn that ends without handing over gets one nudge; after that the owner is asked. */
  private turnEnded(cardId: string, live: Live) {
    const handedOver = live.handedOver;
    live.handedOver = false;
    const card = this.o.board.item(cardId);
    if (!card || card.state !== 'working' || handedOver) return;
    if (!live.nudged) {
      live.nudged = true;
      live.session.send(
        'You ended your turn without handing over. If the work is done and the checks pass, call ready_for_review. If you need a decision, call ask. Otherwise continue.',
      );
      return;
    }
    live.nudged = false;
    this.toOwner(cardId, { text: live.lastText ? clip(live.lastText, 1200) : 'Der Agent hat angehalten, ohne fertig zu sein.', options: [] });
  }

  // ---------------------------------------------------------------- the worker's tools

  private tools(cardId: string): AgentTool[] {
    const handOver = () => {
      const live = this.live.get(cardId);
      if (live) {
        live.handedOver = true;
        live.nudged = false;
      }
    };
    return [
      {
        name: 'report',
        description: `Show the owner one short status line on your card (in ${OWNER_LANGUAGE}, at most ~80 characters). Use it at milestones, not for every step.`,
        schema: { status: z.string() },
        run: ({ status }) => {
          const s = clip(String(status), 200);
          this.o.board.work(cardId, { status_line: s });
          this.o.board.log(cardId, 'report', 'worker', s);
          return 'Shown on the card.';
        },
      },
      {
        name: 'ask',
        description: `Ask for a decision you should not make yourself: product behaviour, trade-offs, anything irreversible or external. Write the question in ${OWNER_LANGUAGE} for a reader who has not seen the code, and offer up to four short answer options when they exist. Then end your turn.`,
        schema: { question: z.string(), options: z.array(z.string()).max(4).optional() },
        run: ({ question, options }) => {
          handOver();
          this.routeQuestion(cardId, { text: clip(String(question), 2000), options: ((options as string[] | undefined) ?? []).map((x) => clip(x, 120)) });
          return END_TURN;
        },
      },
      {
        name: 'propose_card',
        description: `Propose a separate card for a problem you noticed that is outside your task, instead of fixing it here. Title, reason and suggestion in ${OWNER_LANGUAGE}.`,
        schema: { kind: z.enum(['bugfix', 'feature']), title: z.string(), reason: z.string(), suggestion: z.string() },
        run: (a) => {
          const p = this.o.board.propose(cardId, a as { kind: 'bugfix' | 'feature'; title: string; reason: string; suggestion: string });
          this.o.board.log(cardId, 'activity', 'worker', `Karte vorgeschlagen: ${p.title}`);
          return 'Proposed; the owner decides. Continue with your task.';
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it and running the checks. The summary (in ${OWNER_LANGUAGE}) says what changed from the user's point of view, what you verified and how, and anything the owner should know. Then end your turn.`,
        schema: { summary: z.string() },
        run: ({ summary }) => {
          handOver();
          const s = clip(String(summary), 6000);
          this.o.board.work(cardId, { state: 'waiting', need: 'review', detail: JSON.stringify({ summary: s }) });
          this.o.board.log(cardId, 'review', 'worker', s);
          return END_TURN;
        },
      },
    ];
  }

  private routeQuestion(cardId: string, q: Question) {
    const card = this.card(cardId);
    this.o.board.log(cardId, 'question', 'worker', formatQuestion(q));
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (!project || !this.o.askProject) return this.toOwner(cardId, q);
    this.o.board.work(cardId, { status_line: 'Frage beim Projekt-Agenten' });
    this.o
      .askProject(project, card, q)
      .then((reply) => {
        if ('answer' in reply) this.answer(cardId, reply.answer, 'project');
        else this.toOwner(cardId, reply.escalate);
      })
      .catch((e) => {
        this.o.board.log(cardId, 'error', 'obeya', `Projekt-Agent: ${e instanceof Error ? e.message : String(e)}`);
        this.toOwner(cardId, q);
      });
  }

  private toOwner(cardId: string, q: Question) {
    this.o.board.work(cardId, { state: 'waiting', need: 'question', detail: JSON.stringify({ question: q }) });
  }

  private pendingQuestion(cardId: string): string | undefined {
    return this.o.board
      .events(cardId)
      .filter((e) => e.kind === 'question')
      .at(-1)?.text;
  }

  private recordDecision(card: Item, question: string, answer: string, by: 'owner' | 'project') {
    this.o.board.decide({ project_id: card.parent ?? null, card_id: card.id, question, answer, by });
  }

  // ---------------------------------------------------------------- prompts

  private system(): string {
    return `
You are a worker agent directed through Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. You work on exactly one card, in a workspace of the repository (a clone or worktree) that belongs to that card, on your own branch. Other workers may work on other cards at the same time in their own workspaces.

The owner does not watch you work and does not read code. They see your card: status lines, questions, and your summary at the end. Talk to them only through the Obeya tools:
- report: a short status line at milestones.
- ask: a decision that is not yours (product behaviour, trade-offs, anything irreversible or external). Make routine judgement calls yourself. After ask, end your turn; the answer arrives as the next message.
- propose_card: a separate problem you noticed; do not widen your task.
- ready_for_review: the work is committed and the checks pass. Then end your turn.

Rules:
- Commit your work on your branch in this workspace. Do not push, do not open pull requests, do not switch branches.
- Follow the repository's own instructions (CLAUDE.md and docs).
- Owner-facing text (report, ask, propose_card, ready_for_review) is in ${OWNER_LANGUAGE}, short and concrete.
`.trim();
  }

  private briefing(card: Item, branch: string): string {
    const parts = [`Your card: ${card.kind === 'bugfix' ? 'bugfix' : 'feature'} “${card.title}”.`];
    if (card.body.trim()) parts.push(card.body.trim());
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (project?.plan) parts.push(`This is workstream ${card.label ?? ''} of the project “${project.title}”. Read its plan doc ${project.plan.file} first; it holds the context and decisions.`);
    parts.push(`You are on branch ${branch}, fresh from the default branch.`);
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the clone.`);
    if (this.o.adapter.checks?.length) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    return parts.join('\n\n');
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknown card');
    return i;
  }
}

function formatQuestion(q: Question): string {
  return q.options.length ? `${q.text}\n${q.options.map((o) => `– ${o}`).join('\n')}` : q.text;
}

/** One log line for a built-in tool call. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = (k: string) => s(k).split('/').slice(-2).join('/');
  switch (name) {
    case 'Read':
      return `Liest ${file('file_path')}`;
    case 'Edit':
    case 'MultiEdit':
      return `Ändert ${file('file_path')}`;
    case 'Write':
      return `Schreibt ${file('file_path')}`;
    case 'Bash':
      return `$ ${clip(s('command').split('\n')[0]!, 120)}`;
    case 'Grep':
      return `Sucht „${clip(s('pattern'), 60)}“`;
    case 'Glob':
      return `Sucht Dateien ${clip(s('pattern'), 60)}`;
    case 'TodoWrite':
      return 'Plant die nächsten Schritte';
    case 'Task':
    case 'Agent':
      return `Subagent: ${clip(s('description'), 80)}`;
    default:
      return name;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
