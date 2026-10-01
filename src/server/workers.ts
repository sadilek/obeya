// Workers: one agent session per card, in a leased clone. Obeya is the mailbox between the
// worker, its project agent and the owner; every exchange lands in the card's log.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { OWNER_LANGUAGE } from '../core/locale';
import type { Item, Question } from '../core/types';
import { BadRequest, type Board } from './board';
import type { Reply } from './advisor';
import { readChapters } from './demo';
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool } from './runtime';
import { branchName, WorkspaceError, type Workspaces } from './workspaces';
import type { PrState } from './board';
import { parsePrUrl } from './forge';

/** Who answers a worker's question before the owner does, and how. */
export type Advisor = { by: Adviser; ask: (q: Question) => Promise<Reply> };
export type Adviser = 'project' | 'koordinator';

export interface WorkerOptions {
  board: Board;
  runtime: AgentRuntime;
  workspaces: Workspaces;
  adapter: RepoAdapter;
  permissionMode?: 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'default';
  /** The owner's preferences, added to every worker's instructions. */
  preferences?: () => string;
  /** Called with everything the owner tells a worker, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, kind: 'answer' | 'note' | 'feedback', text: string, question?: string) => void;
  /** On a canvas with several repositories: the one these workers work in. */
  repo?: string;
  /** Who answers the card's questions on the owner's behalf, if anyone. */
  advisor?: (card: Item) => Advisor | null;
  /** A spike handed over its prototype: the idea gets the demo and the summary. */
  onSpike?: (spike: Item, summary: string, demo: string | undefined) => void;
}

interface Live {
  session: AgentSession;
  /** Whether the worker called `ask` or `ready_for_review` in the current turn. */
  handedOver: boolean;
  nudged: boolean;
  lastText: string;
  /** Between a message and the end of the turn it starts: a restart now would cut the worker off. */
  busy: boolean;
}

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

export class Workers {
  private live = new Map<string, Live>();
  /** Bumped whenever a card's work starts, stops or ends: replies and tool calls from before are stale. */
  private generation = new Map<string, number>();

  constructor(private o: WorkerOptions) {}

  // ---------------------------------------------------------------- owner actions

  start(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') throw new BadRequest('project', 'a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    // once work has begun the branch stays the card's, whatever the title says now
    const row = this.o.board.row(card.id);
    const branch = row.branch ?? branchName(card.title, card.id);
    let path: string;
    try {
      path = this.o.workspaces.lease(card.id, branch);
    } catch (e) {
      if (e instanceof WorkspaceError) throw new BadRequest(e.code, e.message);
      throw e;
    }
    this.bump(card.id);
    this.o.board.work(card.id, { state: 'working', need: null, detail: null, status_line: null, workspace: path, branch, session_id: null, pr: null });
    this.o.board.log(card.id, 'state', 'obeya', `Agent gestartet auf ${branch}.`);
    this.launch(card.id, this.briefing(card, branch, !!row.branch));
  }

  /** A hint while the worker runs, or feedback on its review. */
  message(cardId: string, text: string) {
    const card = this.card(cardId);
    if (card.state === 'waiting' && (card.need === 'review' || card.need === 'demo')) {
      this.o.board.work(cardId, { state: 'working', need: null, detail: null });
      this.o.board.log(cardId, 'hint', 'owner', text);
      this.o.onOwnerInput?.(card, 'feedback', text);
      this.deliver(
        cardId,
        `Feedback from the owner on your work. Address it${card.need === 'demo' ? ', render the demo again' : ''}, then call ready_for_review again:\n\n${text}`,
      );
    } else if (card.state === 'working' || card.state === 'inPr' || (card.state === 'waiting' && card.need === 'question')) {
      this.o.board.log(cardId, 'hint', 'owner', text);
      this.o.onOwnerInput?.(card, 'note', text);
      this.deliver(cardId, `A note from the owner (it does not stop you; adjust your plan if it changes anything):\n\n${text}`);
    } else throw new BadRequest('noAgent', 'no agent works on this card');
  }

  answer(cardId: string, text: string, by: 'owner' | Adviser = 'owner') {
    const card = this.card(cardId);
    if (!(card.state === 'waiting' && card.need === 'question') && by === 'owner') throw new BadRequest('noQuestion', 'the card has no open question');
    const row = this.o.board.row(cardId);
    const question = row.detail ? (JSON.parse(row.detail).question as Question | undefined) : undefined;
    const q = question?.text ?? this.pendingQuestion(cardId) ?? '';
    this.o.board.work(cardId, { state: row.pr ? 'inPr' : 'working', need: null, detail: null });
    this.o.board.log(cardId, 'answer', by, text);
    this.recordDecision(card, q, text, by);
    if (by === 'owner') this.o.onOwnerInput?.(card, 'answer', text, q);
    const from = { owner: 'from the owner', project: 'from the project agent, on the owner\u2019s behalf', koordinator: 'from the Koordinator, on the owner\u2019s behalf' }[by];
    this.deliver(cardId, `Answer to your question (${from}):\n\n${text}`);
  }

  async approve(cardId: string) {
    const card = this.card(cardId);
    if (!(card.state === 'waiting' && (card.need === 'review' || card.need === 'demo'))) throw new BadRequest('notReady', 'the card is not ready for review');
    const row = this.o.board.row(cardId);
    if (card.spikeOf) return this.discard(card);
    if (this.o.adapter.land === 'main') {
      const problem = this.o.workspaces.landOnMain(cardId, row.branch!);
      if (problem && !problem.worker) throw new BadRequest(problem.code, problem.detail);
      if (problem) {
        this.o.board.work(cardId, { state: 'working', need: null, detail: null });
        this.o.board.log(cardId, 'error', 'obeya', problem.detail, problem.code);
        this.deliver(cardId, `Your work could not land on main: ${problem.detail}\nFix this in your workspace (rebase onto main and resolve conflicts, or commit), then call ready_for_review again.`);
        return;
      }
    }
    if (this.o.adapter.land === 'pr') {
      // the worker opens the PR the way the repository does it, then Obeya watches it
      const pr: PrState = { url: null, seen: [], reported: [] };
      this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, pr: JSON.stringify(pr) });
      this.o.board.log(cardId, 'state', 'owner', 'Freigegeben. Der Agent öffnet den Pull Request.');
      this.deliver(
        cardId,
        [
          'The owner approved your work. Now push your branch and open the pull request the way this repository does it (its own skills and conventions; the description must stand on its own: no local paths, no plan-doc workstream labels).',
          'Then call pr_opened with the pull request URL and end your turn.',
          'From now on you may push this branch; after a rebase push with --force-with-lease. Obeya watches the pull request and sends you review comments, failed checks and conflicts; handle each, push, and end your turn. Use ask when a comment questions a decision or a conflict needs a product call. Do not call ready_for_review again.',
        ].join('\n\n'),
      );
      return;
    }
    this.end(cardId);
    this.bump(cardId);
    this.o.board.work(cardId, { state: 'live', need: null, detail: null, workspace: null });
    this.o.board.log(cardId, 'state', 'owner', 'Freigegeben und auf main.');
  }

  /** A spike has served its purpose: its prototype is thrown away with the card; the idea keeps the demo. */
  private discard(card: Item) {
    this.end(card.id);
    this.bump(card.id);
    try {
      this.o.workspaces.discard(card.id, this.o.board.row(card.id).branch ?? '');
    } catch (e) {
      // the card goes anyway; a leftover worktree does no harm
      console.error('discarding a spike:', e);
    }
    this.o.board.remove(card.id);
    if (this.o.board.item(card.spikeOf!)) this.o.board.log(card.spikeOf!, 'state', 'owner', `Prototyp „${card.title}“ verworfen; die Demo bleibt hier.`);
  }

  /** The card's pull request was merged: the work is live, the workspace free. */
  merged(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    this.o.workspaces.release(cardId);
    this.o.board.work(cardId, { state: 'live', need: null, detail: null, workspace: null });
    this.o.board.log(cardId, 'state', 'obeya', 'Pull Request gemergt. Live.');
  }

  /** Passes what happened on the pull request to the worker; the owner's log gets `note`. */
  prEvent(cardId: string, note: string, message: string) {
    this.o.board.log(cardId, 'state', 'obeya', note);
    this.deliver(cardId, message);
  }

  /** The pull request was closed without a merge: the owner decides what happens. */
  prClosed(cardId: string) {
    this.o.board.log(cardId, 'state', 'obeya', 'Pull Request ohne Merge geschlossen.');
    this.toOwner(cardId, {
      text: 'Der Pull Request wurde geschlossen, ohne gemergt zu werden. Wie geht es weiter?',
      options: ['Neu eröffnen', 'Die Arbeit verwerfen'],
    });
  }

  stop(cardId: string) {
    const card = this.card(cardId);
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('noAgent', 'no agent works on this card');
    this.end(cardId);
    this.bump(cardId);
    // work on the branch keeps its workspace, so starting again goes on from there
    const keep = this.o.workspaces.hasWork(cardId);
    if (!keep) this.o.workspaces.release(cardId);
    this.o.board.work(cardId, { state: 'planned', need: null, detail: null, pr: null, ...(keep ? {} : { workspace: null }) });
    this.o.board.log(cardId, 'state', 'owner', card.pr ? `Angehalten. Pull Request #${card.pr.number} bleibt auf GitHub offen.` : 'Angehalten.');
  }

  /** After a restart: resume every card whose worker was in the middle of a turn. */
  resumeAll() {
    for (const i of this.o.board.snapshot().items) {
      if (this.o.repo && i.repo !== this.o.repo) continue;
      if (i.state !== 'working' && i.state !== 'inPr') continue;
      const row = this.o.board.row(i.id);
      if (!row.workspace) continue;
      if (row.session_id)
        this.launch(
          i.id,
          'Obeya was restarted. Commands you had running (background commands, servers you started) were stopped with it: check what is still needed, start it again, and continue where you left off.',
          row.session_id,
        );
      // it never reported a session: start one with the card
      else if (i.state === 'working') this.launch(i.id, this.briefing(i, row.branch ?? '', true));
    }
  }

  /** Whether a worker is in the middle of a turn. */
  busy(): boolean {
    return [...this.live.values()].some((l) => l.busy);
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.end(id);
  }

  // ---------------------------------------------------------------- sessions

  private launch(cardId: string, message: string, resume?: string) {
    const row = this.o.board.row(cardId);
    if (!row.workspace) throw new Error(`card ${cardId} has no workspace to work in`);
    const live: Live = { session: undefined!, handedOver: false, nudged: false, lastText: '', busy: true };
    this.live.set(cardId, live);
    live.session = this.o.runtime.start(
      {
        cwd: row.workspace,
        system: this.system(),
        tools: this.tools(cardId, live),
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
      live.busy = true;
      live.session.send(text);
      return;
    }
    const row = this.o.board.row(cardId);
    if (row.session_id) return this.launch(cardId, text, row.session_id);
    // no session to resume (it never reported one): a new one needs the card first
    this.launch(cardId, `${this.briefing(this.card(cardId), row.branch ?? '', true)}\n\n${text}`);
  }

  private bump(cardId: string) {
    this.generation.set(cardId, (this.generation.get(cardId) ?? 0) + 1);
  }

  private end(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    live?.session.close();
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    // a turn may also start without a message from Obeya (a finished background command)
    live.busy = e.type !== 'idle';
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
    if (!card || handedOver) return;
    // in the PR phase a turn ends normally once the PR is open
    if (card.state === 'inPr' && card.pr) return;
    if (card.state !== 'working' && card.state !== 'inPr') return;
    if (!live.nudged) {
      live.nudged = true;
      live.busy = true;
      live.session.send(
        card.state === 'inPr'
          ? 'You ended your turn without reporting the pull request. Open it, then call pr_opened with its URL.'
          : 'You ended your turn without handing over. If the work is done and the checks pass, call ready_for_review. If you need a decision, call ask. Otherwise continue.',
      );
      return;
    }
    live.nudged = false;
    this.toOwner(cardId, { text: live.lastText ? clip(live.lastText, 1200) : 'Der Agent hat angehalten, ohne fertig zu sein.', options: [] });
  }

  // ---------------------------------------------------------------- the worker's tools

  private tools(cardId: string, live: Live): AgentTool[] {
    const handOver = () => {
      live.handedOver = true;
      live.nudged = false;
    };
    // a session the owner stopped or replaced may still call its tools: those calls change nothing
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({ ...t, run: (args) => (this.live.get(cardId) === live ? t.run(args) : 'This session has ended. Stop working and end your turn.') }));
    return current([
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
        name: 'pr_opened',
        description: 'After the owner approved: report the pull request you opened for this card (its GitHub URL). Then end your turn; Obeya watches it.',
        schema: { url: z.string() },
        run: ({ url }) => {
          const row = this.o.board.row(cardId);
          if (!row.pr) return 'Not recorded: the owner has not approved this card yet. Do not open a pull request before that.';
          const ref = parsePrUrl(String(url));
          if (!ref) return 'Not recorded: that is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>).';
          handOver();
          const pr = { ...(JSON.parse(row.pr) as PrState), url: String(url).trim(), number: ref.number };
          this.o.board.work(cardId, { pr: JSON.stringify(pr) });
          this.o.board.log(cardId, 'state', 'worker', `Pull Request #${ref.number} geöffnet.`);
          return 'Recorded. End your turn now; Obeya watches the pull request.';
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it, running the checks${this.o.adapter.demo ? ' and recording the demo' : ''}. The summary (in ${OWNER_LANGUAGE}) says what changed from the user's point of view, what you verified and how, and anything the owner should know. ${this.o.adapter.demo?.required ? 'The demo is required: ' : 'With a demo, pass '}its directory, the chapter titles in scene order and its report (in ${OWNER_LANGUAGE}). Then end your turn.`,
        schema: {
          summary: z.string(),
          demo: z
            .object({
              dir: z.string().describe('absolute path of the rendered demo (holds demo.mp4 and captions.vtt)'),
              chapters: z.array(z.string()).describe('scene titles, in order'),
              shown: z.array(z.string()),
              not_shown: z.array(z.string()).describe('behaviours not in the video, each with why'),
              findings: z.array(z.string()),
              question: z.string().optional().describe('only when something needs the owner beyond approve or feedback'),
            })
            .optional(),
        },
        run: ({ summary, demo }) => {
          const s = clip(String(summary), 6000);
          const d = demo as { dir: string; chapters: string[]; shown: string[]; not_shown: string[]; findings: string[]; question?: string } | undefined;
          if (!d && this.o.adapter.demo?.required) return 'Not handed over: this repository requires a demo. Record it with the demo skill, then call ready_for_review again with it.';
          let demoJson: string | undefined;
          if (d) {
            const chapters = readChapters(d.dir, d.chapters);
            if (typeof chapters === 'string') return `Not handed over: ${chapters}. Fix the demo, then call ready_for_review again.`;
            demoJson = JSON.stringify({ dir: d.dir, chapters, shown: d.shown, notShown: d.not_shown, findings: d.findings, ...(d.question ? { question: d.question } : {}) });
          }
          handOver();
          this.o.board.work(cardId, {
            state: 'waiting',
            need: d ? 'demo' : 'review',
            detail: JSON.stringify({ summary: s }),
            ...(demoJson ? { demo: demoJson } : {}),
          });
          this.o.board.log(cardId, 'review', 'worker', s);
          const card = this.o.board.item(cardId);
          if (card?.spikeOf) this.o.onSpike?.(card, s, demoJson);
          return END_TURN;
        },
      },
    ]);
  }

  private routeQuestion(cardId: string, q: Question) {
    const card = this.card(cardId);
    this.o.board.log(cardId, 'question', 'worker', formatQuestion(q));
    const advisor = this.o.advisor?.(card);
    if (!advisor) return this.toOwner(cardId, q);
    const name = advisor.by === 'project' ? 'Projekt-Agent' : 'Koordinator';
    // the owner may stop the card, or answer, before the advisor does
    const asked = this.generation.get(cardId);
    const stale = () => this.generation.get(cardId) !== asked || this.o.board.item(cardId)?.state === 'waiting';
    this.o.board.work(cardId, { status_line: advisor.by === 'project' ? 'Frage beim Projekt-Agenten' : 'Frage beim Koordinator' });
    advisor
      .ask(q)
      .then((reply) => {
        if (stale()) return;
        if ('answer' in reply) this.answer(cardId, reply.answer, advisor.by);
        else this.toOwner(cardId, reply.escalate);
      })
      .catch((e) => {
        if (stale()) return;
        this.o.board.log(cardId, 'error', 'obeya', `${name}: ${e instanceof Error ? e.message : String(e)}`);
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

  private recordDecision(card: Item, question: string, answer: string, by: 'owner' | Adviser) {
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
- Owner-facing text (report, ask, propose_card, ready_for_review) is in ${OWNER_LANGUAGE}, short and concrete. What you write between tool calls also shows in the card's log for the owner: keep it brief and in ${OWNER_LANGUAGE} too.
`.trim() + (this.o.preferences?.() ? `\n\n${this.o.preferences()}` : '');
  }

  private briefing(card: Item, branch: string, resumed = false): string {
    const parts = [`Your card: ${card.kind === 'bugfix' ? 'bugfix' : 'feature'} “${card.title}”.`];
    const idea = card.spikeOf ? this.o.board.item(card.spikeOf) : undefined;
    if (card.spikeOf)
      parts.push(
        [
          `This card is a spike for the idea “${idea?.title ?? ''}”: a throwaway prototype, so the owner can see the idea before deciding on it. It never lands; approving it throws it away.`,
          'So build only what the demo needs to show, as quickly as you can: no tests, no polish, no docs or plan changes, and do not run the checks. Commit it on your branch anyway, so the demo can be reproduced. The demo only needs to make the idea visible (30–60 s).',
          idea?.idea?.brief ? `The idea as discussed so far:

${idea.idea.brief}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    if (card.body.trim()) parts.push(card.body.trim());
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (project?.plan) parts.push(`This is workstream ${card.label ?? ''} of the project “${project.title}”. Read its plan doc ${project.plan.file} first; it holds the context and decisions.`);
    parts.push(
      resumed
        ? `You are on branch ${branch}, which already holds earlier work on this card: look at its log and diff first and go on from there.`
        : `You are on branch ${branch}, fresh from the default branch.`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the clone.`);
    if (this.o.adapter.checks?.length && !card.spikeOf) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    if (this.o.adapter.demo)
      parts.push(
        `${this.o.adapter.demo.required ? 'Then record' : 'Where it helps the owner, record'} a demo of the change with the demo skill, as its instructions say, and hand it over with ready_for_review (directory, chapter titles, report). Skip the skill's last steps (opening the page, the notification, the chat reply): Obeya shows the demo on the card. How to run the app for the demo: ${this.o.adapter.demo.howToRun}`,
      );
    return parts.join('\n\n');
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
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
