// Workers: one agent session per card, in a leased clone. Obeya is the mailbox between the
// worker, its project agent and the owner; every exchange lands in the card's log.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { OWNER_LANGUAGE } from '../core/locale';
import { basename } from 'node:path';
import type { DemoKind, DemoPage, Item, Question, RestartReason } from '../core/types';
import { BadRequest, type Board } from './board';
import { type Reply, toQuestion } from './advisor';
import { checkArtifact, DEMO_SKILL, OBEYA_PLUGIN, readChapters } from './demo';
import { imageNote } from './images';
import type { InputContext } from './koordinator';
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool } from './runtime';
import { branchName, type Landed, WorkspaceError, type Workspaces } from './workspaces';
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
  /** The repository shares video demos on a page (the configuration's command or the adapter's); the adapter's alone when left out. */
  shares?: boolean;
  permissionMode?: 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'default';
  /** The owner's preferences, added to every worker's instructions. */
  preferences?: () => string;
  /** Called with everything the owner tells a worker, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, kind: 'answer' | 'note' | 'feedback', text: string, context: InputContext) => void;
  /** On a canvas with several repositories: the one these workers work in. */
  repo?: string;
  /** Who answers the card's questions on the owner's behalf, if anyone. */
  advisor?: (card: Item) => Advisor | null;
  /** The worker reported the card's pull request: a demo shared before gets its link. */
  onPrOpened?: (cardId: string) => void;
  /** A prototype was handed over: the idea's agent hears the summary. */
  onPrototype?: (prototype: Item, summary: string, demo: string | undefined) => void;
  /** A question on a prototype was answered: the idea's agent hears both, so its brief holds them. */
  onPrototypeAnswer?: (prototype: Item, question: string, answer: string, by: 'owner' | Adviser) => void;
  /** How long a turn that ended while the worker's background work runs waits for it to wake the worker. */
  backgroundGrace?: number;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /** Whether Obeya starts again for work that landed: it runs from this repository's checkout and the work changed code. */
  restartsFor?: (landed: Landed) => boolean;
}

/** What is stored while landed work's worker finishes (`CardRow.landed`). */
interface LandedState {
  commit?: string;
  /** Nothing landed: the work changed nothing in the repository, and the card is `done` rather than `live`. */
  unchanged?: boolean;
  /** Obeya starts again for the landing. */
  restarts?: boolean;
  /** The worker waits for that restart. */
  waits?: boolean;
}

interface Live {
  session: AgentSession;
  /** Whether the worker called `ask` or `ready_for_review` in the current turn. */
  handedOver: boolean;
  nudged: boolean;
  lastText: string;
  /** Between a message and the end of the turn it starts: a restart now would cut the worker off. */
  busy: boolean;
  /** Set while an ended turn waits for the worker's background work to wake it. */
  waiting?: ReturnType<typeof setTimeout>;
  /** Whether the card's open question is the worker having stopped, not a question it asked. */
  stalled: boolean;
  /** Whether the worker has heard of the restart that is due, so that it pauses for it. */
  toldRestart?: boolean;
  /** The owner's preferences as the worker last heard them: in its instructions, or since then. */
  preferences: string;
}

/** A restart that waits for workers to finish their turns: why, and when it goes ahead at the latest. */
export interface DueRestart {
  reason: RestartReason;
  deadline: number;
}

/** A render or a test suite finishes well within this; a turn that waits longer counts as ended. */
const BACKGROUND_GRACE = 10 * 60_000;

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

const RESTARTED =
  'Obeya was restarted. Whatever you had running then was stopped with it: background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need. If you had paused for the restart, go on from there.';

/** Tells a worker that Obeya is about to restart, so that it pauses at a safe point instead of being cut off. */
const restartNotice = (due: DueRestart) => {
  const minutes = Math.max(1, Math.round((due.deadline - Date.now()) / 60_000));
  return `Obeya is about to restart (${due.reason === 'code' ? 'new code landed on main' : 'the owner saved a new configuration'}) and stops whatever its workers run at that moment. It waits until no worker is in the middle of a turn, at most ${minutes} more minute${minutes === 1 ? '' : 's'}. Pause at the next safe point: finish the step you are in, start nothing long (a test run, a demo render, a measurement), and end your turn, without handing over if you are not done. Background commands still running keep Obeya waiting: let those you need finish, stop the others (a scratch server you can start again). Obeya resumes you once it runs again, and you go on from there.`;
};

const AFTER_LANDING =
  'Your workspace and this session stay until you end a turn with nothing left to wait for (a question, the restart); then both end. Commits you make here no longer land.';

export class Workers {
  private live = new Map<string, Live>();
  /** Bumped whenever a card's work starts, stops or ends: replies and tool calls from before are stale. */
  private generation = new Map<string, number>();
  /** The restart that waits for workers, if one does. */
  private restart: DueRestart | null = null;

  constructor(private o: WorkerOptions) {}

  /** Whether a video demo here may go to a page for colleagues, which the worker then writes. */
  private get shares(): boolean {
    return this.o.shares ?? !!this.o.adapter.demo?.share;
  }

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
    this.o.board.work(card.id, { state: 'working', need: null, detail: null, status_line: null, workspace: path, branch, session_id: null, pr: null, approved_at: null });
    this.o.board.log(card.id, 'state', 'obeya', `Agent gestartet auf ${branch}.`);
    this.launch(card.id, this.briefing(card, branch, !!row.branch), undefined, this.taskImages(card));
  }

  /** A hint while the worker runs, or feedback on its review; `images` are screenshot files the owner attached. */
  message(cardId: string, text: string, images: string[] = []) {
    const card = this.card(cardId);
    const overruled = this.overruled(cardId);
    if (card.state === 'waiting' && (card.need === 'review' || card.need === 'demo')) {
      // feedback instead of an approval: what comes back is reviewed again
      this.o.board.work(cardId, { state: 'working', need: null, detail: null, approved_at: null });
      this.o.board.log(cardId, 'hint', 'owner', text, undefined, images.map((f) => basename(f)));
      if (text) this.o.onOwnerInput?.(card, 'feedback', text, overruled ? { overruled } : {});
      this.deliver(
        cardId,
        `Feedback from the owner instead of an approval; the card is back with you${card.need === 'demo' ? ', and your demo stays on it until you hand over another' : ''}:\n\n${text}${imageNote(images)}`,
        images,
      );
    } else if (card.state === 'working' || card.state === 'inPr' || (card.state === 'waiting' && card.need === 'question') || card.finishing) {
      this.o.board.log(cardId, 'hint', 'owner', text, undefined, images.map((f) => basename(f)));
      if (text) this.o.onOwnerInput?.(card, 'note', text, overruled ? { overruled } : {});
      this.deliver(cardId, `A note from the owner (it does not stop you; adjust your plan if it changes anything, and say briefly what you change or why nothing):\n\n${text}${imageNote(images)}`, images);
    } else throw new BadRequest('noAgent', 'no agent works on this card');
  }

  answer(cardId: string, text: string, by: 'owner' | Adviser = 'owner', images: string[] = []) {
    const card = this.card(cardId);
    if (card.state === 'waiting' && card.need === 'demo' && card.question && by === 'owner') return this.answerDemo(card, text, images);
    if (!(card.state === 'waiting' && card.need === 'question') && by === 'owner') throw new BadRequest('noQuestion', 'the card has no open question');
    const row = this.o.board.row(cardId);
    const question = row.detail ? (JSON.parse(row.detail).question as Question | undefined) : undefined;
    const q = question?.text ?? this.pendingQuestion(cardId) ?? '';
    this.o.board.work(cardId, { state: row.landed ? landedState(row.landed) : row.pr ? 'inPr' : 'working', need: null, detail: null });
    this.o.board.log(cardId, 'answer', by, text, undefined, images.map((f) => basename(f)));
    this.recordDecision(card, q, text || '(Screenshot)', by);
    if (by === 'owner' && text) this.o.onOwnerInput?.(card, 'answer', text, { question: q });
    if (card.prototypeOf) this.o.onPrototypeAnswer?.(card, q, text || '(Screenshot)', by);
    const from = { owner: 'from the owner', project: 'from the project agent, on the owner\u2019s behalf', koordinator: 'from the Koordinator, on the owner\u2019s behalf' }[by];
    this.deliver(cardId, `Answer to your question (${from}):\n\n${text}${imageNote(images)}`, images);
  }

  /** The question in a demo report, answered: the worker hears it, and the demo still waits for approval. */
  private answerDemo(card: Item, text: string, images: string[]) {
    const q = card.question!.text;
    const demo = JSON.parse(this.o.board.row(card.id).demo!) as Record<string, unknown>;
    this.o.board.work(card.id, { demo: JSON.stringify({ ...demo, answer: text || '(Screenshot)' }) });
    this.o.board.log(card.id, 'answer', 'owner', text, undefined, images.map((f) => basename(f)));
    this.recordDecision(card, q, text || '(Screenshot)', 'owner');
    if (text) this.o.onOwnerInput?.(card, 'answer', text, { question: q });
    if (card.prototypeOf) this.o.onPrototypeAnswer?.(card, q, text || '(Screenshot)', 'owner');
    this.deliver(
      card.id,
      `The owner answered the question in your demo report („${q}“). The card still waits for their approval of what you handed over:\n\n${text}${imageNote(images)}`,
      images,
    );
  }

  async approve(cardId: string) {
    const card = this.card(cardId);
    if (!(card.state === 'waiting' && (card.need === 'review' || card.need === 'demo'))) throw new BadRequest('notReady', 'the card is not ready for review');
    // a prototype never lands: approving it is having seen enough
    if (card.prototypeOf) return this.endPrototype(cardId, 'discarded');
    // work that changed nothing (a demo, an analysis) has nothing to land and no pull request to open
    if (!this.o.workspaces.hasWork(cardId)) return this.close(cardId, 'owner');
    if (this.o.adapter.land === 'main') return this.land(cardId, 'owner');
    // the worker opens the PR the way the repository does it, then Obeya watches it
    const pr: PrState = { url: null, seen: [], reported: [] };
    this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, pr: JSON.stringify(pr) });
    this.o.board.log(cardId, 'state', 'owner', 'Freigegeben. Der Agent öffnet den Pull Request.');
    // a demo shared later gets its line from Obeya once the pull request is open
    const shared = card.share?.url;
    this.deliver(
      cardId,
      [
        'The owner approved your work. In this repository it goes out as a pull request, opened the way the repository does it (its own skills and conventions): from now on you may push this branch. Whoever reads the pull request has not seen Obeya, the card or the plan doc. Do not merge it; merging is not part of your task.',
        shared ? `Your demo video is shared with the team on a page of its own: ${shared}. Link it in the pull request's description.` : '',
        'Once you report its URL with pr_opened, Obeya watches it and passes you review comments, failed checks and conflicts; you handle them the way the repository does (its skill for review comments, if it has one). A comment that questions a decision, or a conflict that needs a product call, is the owner’s (ask).',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  /**
   * Lands approved work on main. What the worker can fix (main moved on and the change conflicts,
   * uncommitted work) goes back to it with the approval kept: its next handover lands without the
   * owner approving again. What blocks the Obeya checkout stays with the owner and needs a new approval.
   */
  private land(cardId: string, by: 'owner' | 'obeya') {
    const row = this.o.board.row(cardId);
    // read before landing: the landed branch adds nothing against main
    const added = this.planDocsAdded(cardId);
    const result = this.o.workspaces.landOnMain(cardId, row.branch!);
    if ('code' in result && !result.worker) {
      this.o.board.work(cardId, { approved_at: null });
      throw new BadRequest(result.code, result.detail);
    }
    if ('code' in result) {
      this.o.board.work(cardId, { state: 'working', need: null, detail: null, approved_at: row.approved_at ?? new Date().toISOString() });
      this.o.board.log(cardId, 'error', 'obeya', result.detail, result.code);
      this.deliver(
        cardId,
        [
          `The owner approved your work, but it could not land on main: ${result.detail}`,
          'The approval holds for what it takes to land the work: once you hand over again, Obeya lands it without asking the owner again, with the demo already on the card. A change to what the owner approved is theirs to decide.',
        ].join('\n\n'),
      );
      return;
    }
    this.o.board.planDocsLanded(cardId, added);
    this.bump(cardId);
    const restarts = this.o.restartsFor?.(result) ?? false;
    this.o.board.work(cardId, { state: 'live', need: null, detail: null, status_line: null, approved_at: null, landed: JSON.stringify({ commit: result.to, ...(restarts ? { restarts } : {}) } satisfies LandedState) });
    this.o.board.log(cardId, 'state', by, by === 'owner' ? 'Freigegeben und auf main.' : 'Nach der Freigabe auf main gelandet.');
    this.afterLanding(
      cardId,
      [
        `${by === 'owner' ? 'The owner approved your work, and it' : 'Your work'} is on main now (${result.to.slice(0, 7)}); the card is live.`,
        restarts
          ? 'Obeya runs from that checkout and starts again with your change as soon as no worker is in the middle of a turn, which stops whatever you run then. If something that remains needs Obeya to run your change, call after_restart and end your turn: Obeya tells you once it runs it.'
          : '',
        AFTER_LANDING,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  /**
   * Approved work that changed nothing in the repository: nothing lands, and the card is `done`.
   * Its worker hears so and may finish what remains, as after a landing.
   */
  private close(cardId: string, by: 'owner' | 'worker') {
    this.bump(cardId);
    this.o.board.work(cardId, { state: 'done', need: null, detail: null, status_line: null, approved_at: null, pr: null, landed: JSON.stringify({ unchanged: true } satisfies LandedState) });
    this.o.board.log(cardId, 'state', by, by === 'owner' ? 'Freigegeben. Ohne Änderung am Code gibt es nichts zu landen: erledigt.' : 'Ohne Änderung am Code abgeschlossen: erledigt.');
    // the worker that closed it is told by the tool's result, and its turn's end finishes it
    if (by === 'owner')
      this.afterLanding(cardId, `The owner approved your work. It changed nothing in the repository, so nothing lands and there is no pull request: the card is done.\n\n${AFTER_LANDING}`);
  }

  /**
   * Landed work's worker hears about it and may finish what remains (a migration, say) in its
   * workspace, which stays until then. Without a session to tell, the workspace goes at once.
   */
  private afterLanding(cardId: string, message: string) {
    const row = this.o.board.row(cardId);
    if (!row.workspace || (!this.live.has(cardId) && !row.session_id)) return this.finish(cardId);
    this.deliver(cardId, message);
  }

  /** Landed work's worker is done: its session ends and its workspace is freed. */
  private finish(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    const row = this.o.board.row(cardId);
    try {
      this.o.workspaces.removeLanded(cardId, row.branch ?? '');
    } catch (e) {
      // the card is done either way; a leftover worktree does no harm
      console.error('freeing a landed workspace:', e);
    }
    this.o.board.work(cardId, { landed: null, workspace: null, status_line: null, ...(row.state === 'waiting' ? { state: row.landed ? landedState(row.landed) : 'live', need: null, detail: null } : {}) });
    this.o.board.workDone(cardId);
  }

  /** The plan docs the card's branch adds, as plan references of the canvas. */
  private planDocsAdded(cardId: string): string[] {
    if (!this.o.board.row(cardId).idea) return [];
    const home = !this.o.repo || this.o.repo === this.o.board.home;
    return this.o.workspaces
      .addedFiles(cardId, this.o.adapter.planDocs.dir)
      .filter((f) => f.endsWith('.md') && !this.o.adapter.planDocs.exclude.some((x) => f.endsWith(`/${x}`)))
      .map((f) => (home ? f : `${this.o.repo}:${f}`));
  }

  /**
   * A prototype has served its purpose, whatever its state: its worker stops and the card goes into
   * the archive with its log, demo and summary. Discarded, its workspace and branch are thrown away;
   * built, they went to its idea before (`buildOn`).
   */
  endPrototype(cardId: string, end: 'discarded' | 'built', by: 'owner' | 'obeya' = 'owner') {
    const card = this.card(cardId);
    if (!card.prototypeOf) throw new BadRequest('notPrototype', 'not a prototype');
    this.end(cardId);
    this.bump(cardId);
    try {
      this.o.workspaces.discard(cardId, this.o.board.row(cardId).branch ?? '');
    } catch (e) {
      // the card goes anyway; a leftover worktree does no harm
      console.error('discarding a prototype:', e);
    }
    const idea = this.o.board.card(card.prototypeOf);
    this.o.board.log(cardId, 'state', by, end === 'built' ? `Gebaut: Die Idee „${idea?.title ?? ''}“ wird auf diesem Prototyp gebaut.` : 'Verworfen; der Code ist weg, Demo und Log bleiben im Archiv.');
    this.o.board.endPrototype(cardId, end);
    if (end === 'discarded' && this.o.board.item(card.prototypeOf)) this.o.board.log(card.prototypeOf, 'state', by, `Prototyp „${card.title}“ verworfen; er liegt mit seiner Demo im Archiv.`);
  }

  /**
   * The idea is built on this prototype: its workspace and branch (renamed for the idea) go to the
   * idea, and the prototype ends as built. Returns the workspace and branch the idea has now.
   */
  buildOn(prototypeId: string, idea: Item): { path: string; branch: string } {
    const row = this.o.board.row(prototypeId);
    if (!row.workspace || !row.branch) throw new BadRequest('noWorkspace', 'the prototype has no workspace to build on');
    let moved: { path: string; branch: string };
    try {
      moved = this.o.workspaces.transfer(prototypeId, idea.id, row.branch, branchName(idea.title, idea.id));
    } catch (e) {
      if (e instanceof WorkspaceError) throw new BadRequest(e.code, e.message);
      throw e;
    }
    this.endPrototype(prototypeId, 'built');
    return moved;
  }

  /** The card's pull request was merged: the work is live, the workspace free. */
  merged(cardId: string) {
    this.bump(cardId);
    this.o.board.planDocsLanded(cardId, this.planDocsAdded(cardId));
    this.o.board.work(cardId, { state: 'live', need: null, detail: null, status_line: null, landed: JSON.stringify({} satisfies LandedState) });
    this.o.board.log(cardId, 'state', 'obeya', 'Pull Request gemergt. Live.');
    this.afterLanding(cardId, `Your pull request was merged; the card is live.\n\n${AFTER_LANDING}`);
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
    if (card.finishing) {
      this.o.board.log(cardId, 'state', 'owner', 'Angehalten.');
      this.finish(cardId);
      return;
    }
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('noAgent', 'no agent works on this card');
    this.end(cardId);
    this.bump(cardId);
    // work on the branch keeps its workspace, so starting again goes on from there
    const keep = this.o.workspaces.hasWork(cardId);
    if (!keep) this.o.workspaces.release(cardId);
    this.o.board.work(cardId, { state: 'planned', need: null, detail: null, pr: null, approved_at: null, ...(keep ? {} : { workspace: null }) });
    this.o.board.log(cardId, 'state', 'owner', card.pr ? `Angehalten. Pull Request #${card.pr.number} bleibt auf GitHub offen.` : 'Angehalten.');
  }

  /** After a restart: resume every card whose worker was in the middle of a turn. */
  resumeAll() {
    for (const i of this.o.board.snapshot().items) {
      if (this.o.repo && i.repo !== this.o.repo) continue;
      const row = this.o.board.row(i.id);
      if (row.landed && row.workspace) {
        this.resumeLanded(i, row.landed, row.session_id);
        continue;
      }
      if (i.state !== 'working' && i.state !== 'inPr') continue;
      if (!row.workspace) continue;
      if (row.session_id) this.launch(i.id, RESTARTED, row.session_id);
      // it never reported a session: start one with the card
      else if (i.state === 'working') this.launch(i.id, this.briefing(i, row.branch ?? '', true), undefined, this.taskImages(i));
    }
  }

  /** After a restart: landed work's worker goes on with what remains; the restart it waited for has happened. */
  private resumeLanded(card: Item, stored: string, session: string | null) {
    const l = JSON.parse(stored) as LandedState;
    if (!session) return this.finish(card.id);
    this.o.board.work(card.id, { landed: JSON.stringify({ ...(l.commit ? { commit: l.commit } : {}), ...(l.unchanged ? { unchanged: true } : {}) } satisfies LandedState) });
    // an open question waits for its answer, which resumes the session
    if (card.state === 'waiting') return;
    this.launch(card.id, l.restarts ? `Obeya has started again and runs main with your change now. ${RESTARTED}` : RESTARTED, session);
  }

  /** Whether a worker is in the middle of a turn, or its ended turn waits for its background work. */
  busy(): boolean {
    return this.busyCards().length > 0;
  }

  /** The cards whose worker is busy, as `busy` means it. */
  busyCards(): string[] {
    return [...this.live].filter(([, l]) => l.busy).map(([id]) => id);
  }

  /**
   * Obeya is about to restart (or no longer is): workers in the middle of a turn hear so and pause
   * at a safe point, and those that start a turn before the restart hear it with their message.
   */
  restartDue(due: DueRestart | null) {
    this.restart = due;
    if (!due) return;
    for (const [cardId, live] of this.live) {
      if (!live.busy || live.toldRestart) continue;
      live.toldRestart = true;
      live.session.send(restartNotice(due));
      this.o.board.log(cardId, 'state', 'obeya', 'Neustart von Obeya angekündigt; der Agent pausiert beim nächsten sicheren Punkt.');
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.end(id);
  }

  // ---------------------------------------------------------------- sessions

  private launch(cardId: string, message: string, resume?: string, images: string[] = []) {
    const row = this.o.board.row(cardId);
    if (!row.workspace) throw new Error(`card ${cardId} has no workspace to work in`);
    const preferences = this.o.preferences?.() ?? '';
    const live: Live = { session: undefined!, handedOver: false, nudged: false, lastText: '', busy: true, stalled: false, preferences };
    this.live.set(cardId, live);
    message = this.withRestart(live, message);
    live.session = this.o.runtime.start(
      {
        cwd: row.workspace,
        system: this.system(preferences, !!row.prototype_of),
        tools: this.tools(cardId, live, !!row.prototype_of),
        ...(this.o.adapter.demo ? { plugins: [OBEYA_PLUGIN] } : {}),
        contextUpdate: () => this.preferencesUpdate(live),
        ...(resume ? { resume } : {}),
        ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
        onEvent: (e) => this.onEvent(cardId, live, e),
      },
      message,
      images,
    );
    live.session.done.then(() => {
      if (this.live.get(cardId) === live) this.live.delete(cardId);
    });
  }

  private deliver(cardId: string, text: string, images: string[] = []) {
    const live = this.live.get(cardId);
    if (live) {
      // the turn this starts reports the background work that is still running
      clearTimeout(live.waiting);
      live.waiting = undefined;
      live.busy = true;
      live.session.send(this.withRestart(live, text), images);
      return;
    }
    const row = this.o.board.row(cardId);
    if (row.session_id) return this.launch(cardId, text, row.session_id, images);
    // no session to resume (it never reported one): a new one needs the card first
    const card = this.card(cardId);
    this.launch(cardId, `${this.briefing(card, row.branch ?? '', true)}\n\n${text}`, undefined, [...this.taskImages(card), ...images]);
  }

  /** Preferences the owner gave or changed since the worker last heard them, passed with its next tool result. */
  private preferencesUpdate(live: Live): string | undefined {
    const now = this.o.preferences?.() ?? '';
    if (now === live.preferences) return;
    live.preferences = now;
    return now ? `The owner's preferences changed while you work; they now read:\n\n${now}` : 'The owner withdrew their standing preferences; none apply any more.';
  }

  /** A message that starts a turn while a restart is due tells the worker of it, once. */
  private withRestart(live: Live, text: string): string {
    if (!this.restart || live.toldRestart) return text;
    live.toldRestart = true;
    return `${text}\n\n${restartNotice(this.restart)}`;
  }

  private bump(cardId: string) {
    this.generation.set(cardId, (this.generation.get(cardId) ?? 0) + 1);
  }

  private end(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    clearTimeout(live?.waiting);
    live?.session.close();
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    // a turn may also start without a message from Obeya (a finished background command)
    live.busy = e.type !== 'idle';
    clearTimeout(live.waiting);
    live.waiting = undefined;
    if (e.type === 'text' || e.type === 'tool') this.resumed(cardId, live);
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
        this.turnEnded(cardId, live, e.background ?? 0);
        break;
    }
  }

  private landApproved(cardId: string) {
    try {
      this.land(cardId, 'obeya');
    } catch (e) {
      // the Obeya checkout is in the way: the card waits for the owner, who approves again
      if (!(e instanceof BadRequest)) throw e;
      this.o.board.work(cardId, { state: 'waiting', need: this.o.board.row(cardId).demo ? 'demo' : 'review', status_line: null });
      this.o.board.log(cardId, 'error', 'obeya', e.message, e.code);
    }
  }

  /**
   * A turn that ends without handing over gets one nudge; after that the owner is asked. A turn
   * that ends while the worker's background work runs (a demo render, say) waits for that work
   * to wake the worker instead, unless nothing happens for a long while.
   */
  private turnEnded(cardId: string, live: Live, background: number) {
    const handedOver = live.handedOver;
    live.handedOver = false;
    const card = this.o.board.item(cardId);
    if (!card) return;
    const row = this.o.board.row(cardId);
    if (background > 0) {
      // the background work still belongs to the turn, whatever the card's state (a worker may ask
      // while its render runs): a restart now would cut it off
      live.busy = true;
      live.waiting = setTimeout(() => {
        live.waiting = undefined;
        live.busy = false;
        if (this.live.get(cardId) === live) this.turnEnded(cardId, live, 0);
      }, this.o.backgroundGrace ?? BACKGROUND_GRACE);
      if (!handedOver) return;
    }
    if (handedOver) {
      // work the owner approved already lands once its worker handed over what stood in the way
      if (card.state === 'working' && row.approved_at) this.landApproved(cardId);
      return;
    }
    const landed = row.landed ? (JSON.parse(row.landed) as LandedState) : null;
    // in the PR phase a turn ends normally once the PR is open
    if (card.state === 'inPr' && card.pr) return;
    if (card.state !== 'working' && card.state !== 'inPr' && !landed) return;
    if (landed) {
      // what remained after the landing is done, unless the worker waits for its question or the restart
      if (card.state !== 'waiting' && !landed.waits) this.finish(cardId);
      return;
    }
    if (this.restart && live.toldRestart) {
      // it paused for the restart, which resumes it
      this.o.board.log(cardId, 'state', 'obeya', 'Pausiert bis zum Neustart von Obeya.');
      return;
    }
    if (!live.nudged) {
      live.nudged = true;
      live.busy = true;
      live.session.send(
        card.state === 'inPr'
          ? 'Your turn ended, and Obeya has no pull request for this card yet (pr_opened), nor did you close it as needing none (close_unchanged).'
          : 'Your turn ended without a handover (ready_for_review) or a question (ask), so the card still shows you at work. Should you end your turn again like this, Obeya passes your last words to the owner as a question.',
      );
      return;
    }
    live.nudged = false;
    live.stalled = true;
    this.toOwner(cardId, { text: live.lastText ? clip(live.lastText, 1200) : 'Der Agent hat angehalten, ohne fertig zu sein.', options: [] });
  }

  /** A worker that went to the owner for having stopped and then works on by itself takes the question back. */
  private resumed(cardId: string, live: Live) {
    if (!live.stalled) return;
    live.stalled = false;
    const card = this.o.board.item(cardId);
    if (card?.state === 'waiting' && card.need === 'question') this.o.board.work(cardId, { state: card.pr ? 'inPr' : 'working', need: null, detail: null });
  }

  // ---------------------------------------------------------------- the worker's tools

  private tools(cardId: string, live: Live, prototype: boolean): AgentTool[] {
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
        description: `Ask for a decision you should not make yourself: product behaviour, trade-offs, anything irreversible or external. Write the question in ${OWNER_LANGUAGE} for a reader who has not seen the code, and offer up to four short answer options when they exist; the owner picks one on the card (several when multiple is true) or writes their own. Then end your turn.`,
        schema: { question: z.string(), options: z.array(z.string()).max(4).optional(), multiple: z.boolean().optional() },
        run: ({ question, options, multiple }) => {
          handOver();
          this.routeQuestion(cardId, toQuestion(question, options, multiple));
          return END_TURN;
        },
      },
      // a prototype makes no cards of its own: what it proposes is building its idea on it
      prototype
        ? {
            name: 'propose_build',
            description: `Propose that the idea be built on this prototype: a worker then goes on from your branch, takes over what carries and brings it to production quality, and the idea's other prototypes are discarded. Use it when your approach convinced (the owner said so, or it clearly settles the idea). It shows on your card, where the owner accepts it or not. reason: why, in ${OWNER_LANGUAGE}, a sentence or two.`,
            schema: { reason: z.string() },
            run: ({ reason }) => {
              this.o.board.proposeBuild(cardId, clip(String(reason).trim(), 2000));
              this.o.board.log(cardId, 'activity', 'worker', `Schlägt vor, die Idee auf diesem Prototyp zu bauen: ${clip(String(reason).trim(), 300)}`);
              return 'Shown on your card; the owner decides. Continue with your task.';
            },
          }
        : {
            name: 'propose_card',
            description: `Propose a separate card for a problem you noticed that is outside your task, instead of fixing it here. Title, reason and suggestion in ${OWNER_LANGUAGE}.`,
            schema: { title: z.string(), reason: z.string(), suggestion: z.string() },
            run: (a) => {
              const p = this.o.board.propose(cardId, a as { title: string; reason: string; suggestion: string });
              this.o.board.log(cardId, 'activity', 'worker', `Aufgabe vorgeschlagen: ${p.title}`);
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
          this.o.onPrOpened?.(cardId);
          return 'Recorded. End your turn now; Obeya watches the pull request.';
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it, running the checks${this.o.adapter.demo ? ' and making the demo' : ''}. The summary (in ${OWNER_LANGUAGE}) says what changed from the user's point of view, what you verified and how, and anything the owner should know. ${this.o.adapter.demo?.required ? 'The demo is required: ' : 'With a demo, pass '}a video's directory and chapter titles in scene order, or an HTML artifact's directory, with its report (in ${OWNER_LANGUAGE}); without a new one, the demo already on the card stands. Only when there is nothing to show at all, pass no_demo instead. Then end your turn.`,
        schema: {
          summary: z.string(),
          demo: z
            .object({
              kind: z
                .enum(['video', 'html'])
                .optional()
                .describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at, for results that are seen rather than watched happening"),
              dir: z.string().describe('absolute path of the demo: a video holds demo.mp4 and captions.vtt, an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
              shown: z.array(z.string()),
              not_shown: z.array(z.string()).describe('behaviours not in the demo, each with why'),
              findings: z.array(z.string()),
              question: z.string().optional().describe('only when something needs the owner beyond approve or feedback; the owner can answer it on the card before approving'),
              ...(this.shares
                ? {
                    page: z
                      .object({ title: z.string(), text: z.string() })
                      .optional()
                      .describe(
                        `video only, required for one: the page on which the owner may share the video with colleagues, in ${OWNER_LANGUAGE}. They know the product but have never seen Obeya, this card or the plan doc. title: what changes, in a few words; text: two to five sentences on what changes for the user and why, without findings, tests or internal process`,
                      ),
                  }
                : {}),
            })
            .optional(),
          no_demo: z
            .string()
            .optional()
            .describe(`the exception, for when there is nothing to show (the work turned out to be done already, say): why, in ${OWNER_LANGUAGE}; the summary then stands alone`),
        },
        run: ({ summary, demo, no_demo }) => {
          const s = clip(String(summary), 6000);
          const d = demo as
            | { kind?: DemoKind; dir: string; chapters?: string[]; shown: string[]; not_shown: string[]; findings: string[]; question?: string; page?: DemoPage }
            | undefined;
          const none = typeof no_demo === 'string' && no_demo.trim() ? clip(no_demo.trim(), 1000) : undefined;
          const row = this.o.board.row(cardId);
          if (row.landed) return 'Not handed over: your work is on main already.';
          if (row.pr) return 'Not handed over: the work is in its pull request, where Obeya follows it.';
          if (d && none) return 'Not handed over: pass either a demo or no_demo, not both.';
          // approved work that could not land comes back to be landed, not reviewed: its demo stands
          const approved = !!row.approved_at;
          // without a new demo, the one on the card stands, unless the worker says there is nothing to show
          const kept = !d && !none && !!row.demo;
          if (!d && !kept && !none && this.o.adapter.demo?.required && !approved)
            return `Not handed over: this repository requires a demo. Record it with the demo skill (${DEMO_SKILL}), or make an HTML artifact when the result is something to look at, then call ready_for_review again with it. Only if there is nothing to show at all, pass no_demo with the reason.`;
          let demoJson: string | undefined;
          if (d) {
            const kind = d.kind ?? 'video';
            const report = { shown: d.shown, notShown: d.not_shown, findings: d.findings, ...(d.question ? { question: d.question } : {}) };
            if (kind === 'html') {
              const wrong = checkArtifact(d.dir);
              if (wrong) return `Not handed over: ${wrong}. Fix the artifact, then call ready_for_review again.`;
              demoJson = JSON.stringify({ kind, dir: d.dir, chapters: [], ...report });
            } else {
              const chapters = readChapters(d.dir, d.chapters ?? []);
              if (typeof chapters === 'string') return `Not handed over: ${chapters}. Fix the demo, then call ready_for_review again.`;
              const page = d.page && d.page.title.trim() && d.page.text.trim() ? { title: clip(d.page.title.trim(), 200), text: clip(d.page.text.trim(), 2000) } : undefined;
              if (this.shares && !page)
                return 'Not handed over: a video demo here needs its page (title and text) for colleagues, in case the owner shares it. Call ready_for_review again with demo.page.';
              demoJson = JSON.stringify({ kind, dir: d.dir, chapters, ...report, ...(page ? { page } : {}) });
            }
          }
          handOver();
          // approved work does not wait for the owner again: it stays with Obeya until its turn has ended
          this.o.board.work(cardId, {
            ...(approved ? { status_line: 'Landet auf main' } : { state: 'waiting', need: d || kept ? 'demo' : 'review' }),
            detail: JSON.stringify({ summary: s, ...(none ? { noDemo: none } : {}) }),
            ...(demoJson ? { demo: demoJson } : {}),
            // an earlier demo would show on the finished card as if it were this work's
            ...(none && !approved ? { demo: null } : {}),
          });
          this.o.board.log(cardId, 'review', 'worker', none ? `${s}\n\nOhne Demo: ${none}` : s);
          const card = this.o.board.item(cardId);
          if (card?.prototypeOf) this.o.onPrototype?.(card, s, demoJson);
          if (approved) return 'Recorded. End your turn now; once it has ended, Obeya lands your work on main.';
          return END_TURN;
        },
      },
      {
        name: 'close_unchanged',
        description: `After the owner approved: your work changed nothing in the repository (no commits, nothing uncommitted), because the task needed no change to the code (a demo, an analysis, an answer). Then nothing lands and there is no pull request to open: this closes the card as done instead. Then end your turn.`,
        schema: {},
        run: () => {
          const row = this.o.board.row(cardId);
          if (row.landed) return 'Not recorded: the card is finished already.';
          const pr = row.pr ? (JSON.parse(row.pr) as PrState) : null;
          if (!row.approved_at && !(pr && !pr.url)) return 'Not recorded: only work the owner approved can be closed, and only before its pull request is open. Hand it over with ready_for_review first.';
          if (this.o.workspaces.hasWork(cardId))
            return 'Not recorded: your branch holds commits or uncommitted changes. Work that changes the repository lands (or goes out as a pull request); throw away what is not meant to land first, if nothing is.';
          this.close(cardId, 'worker');
          return `Recorded: the card is done. ${AFTER_LANDING}`;
        },
      },
      {
        name: 'after_restart',
        description: 'Only after your work has landed and Obeya said it starts again for it: what remains needs Obeya to run your change. Then end your turn; Obeya tells you once it runs your change.',
        schema: {},
        run: () => {
          const row = this.o.board.row(cardId);
          if (!row.landed) return 'Not recorded: your work has not landed.';
          const l = JSON.parse(row.landed) as LandedState;
          if (!l.restarts) return 'Not recorded: Obeya does not start again for this landing; what runs now is what you get.';
          this.o.board.work(cardId, { landed: JSON.stringify({ ...l, waits: true } satisfies LandedState) });
          this.o.board.log(cardId, 'activity', 'worker', 'Wartet auf den Neustart von Obeya mit der neuen Version');
          return 'Recorded. End your turn now.';
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

  /**
   * The answer given in the owner's name to the card's last question, as long as the owner has not
   * said anything on the card since: what they say next may overrule it.
   */
  private overruled(cardId: string): InputContext['overruled'] {
    const events = this.o.board.events(cardId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.author === 'owner' && (e.kind === 'hint' || e.kind === 'answer')) return undefined;
      // a question asked later is the card's last one
      if (e.kind === 'question') return undefined;
      if (e.kind !== 'answer' || (e.author !== 'project' && e.author !== 'koordinator')) continue;
      const question = events.slice(0, i).findLast((q) => q.kind === 'question');
      return { question: question?.text ?? '', answer: e.text, by: e.author };
    }
    return undefined;
  }

  private recordDecision(card: Item, question: string, answer: string, by: 'owner' | Adviser) {
    this.o.board.decide({ project_id: card.parent ?? null, card_id: card.id, question, answer, by });
  }

  // ---------------------------------------------------------------- prompts

  private system(preferences: string, prototype = false): string {
    return `
You are a worker agent directed through Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. You work on exactly one card, in a workspace of the repository (a clone or worktree) that belongs to that card, on your own branch. Other workers may work on other cards at the same time in their own workspaces.

The owner does not watch you work and does not read code. They see your card: status lines, questions, and your summary at the end. Talk to them only through the Obeya tools:
- report: a short status line at milestones.
- ask: a decision that is not yours (product behaviour, trade-offs, anything irreversible or external). Make routine judgement calls yourself. After ask, end your turn; the answer arrives as the next message.
${prototype ? '- propose_build: propose that the idea be built on your prototype, once it convinced. You make no other cards; mention other problems you noticed in your summary.' : '- propose_card: a separate problem you noticed; do not widen your task.'}
- ready_for_review: the work is committed and the checks pass. Then end your turn.

Obeya's messages tell you what happened: feedback, an answer, a note from the owner, a landing that failed, your work landing. What to do about it is yours to judge. Approved work lands (or goes out as a pull request) and Obeya tells you once it is on main; your session ends with the turn after that, so whatever was waiting for the landing can still be done then. Work that changed nothing in the repository (the task needed only a demo, an analysis or an answer) lands nothing: approving it makes the card done, and Obeya tells you so the same way.

Rules:
- Commit your work on your branch in this workspace. Do not push, do not open pull requests, do not switch branches.
- Follow the repository's own instructions (CLAUDE.md and docs).
- Owner-facing text (report, ask, ${prototype ? 'propose_build' : 'propose_card'}, ready_for_review) is in ${OWNER_LANGUAGE}, short and concrete. What you write between tool calls also shows in the card's log for the owner: keep it brief and in ${OWNER_LANGUAGE} too.
- Wait for anything external (a deploy, a CI run, a point in time, a process to finish) in the background: run_in_background or Monitor, then end your turn; Obeya wakes you when it finishes or fires. Never wait with sleep or a polling loop in the foreground: a note from the owner reaches you only once the running command is done.
- When a note from the owner arrives, answer it in a sentence or two of text (it shows in the card's log): what you change because of it, or why nothing. If it is unclear what they want, ask.
`.trim() + (preferences ? `\n\n${preferences}` : '');
  }

  /** The task the card's worker gets at its start, as Obeya would send it now (one that already ran goes on from its branch). */
  startBrief(card: Item): string {
    const row = this.o.board.row(card.id);
    return this.briefing(card, row.branch ?? branchName(card.title, card.id), !!row.branch);
  }

  /** The files of the screenshots the owner attached to the card's task. */
  private taskImages(card: Item): string[] {
    return this.o.imageFiles?.(card.images) ?? [];
  }

  private briefing(card: Item, branch: string, resumed = false): string {
    const parts = [`Your card: “${card.title}”.`];
    const idea = card.prototypeOf ? this.o.board.item(card.prototypeOf) : undefined;
    if (card.prototypeOf)
      parts.push(
        [
          `This card is a throwaway prototype for the idea “${idea?.title ?? ''}”, so the owner can see the idea before deciding on it; other prototypes may try other approaches beside it. It never lands itself: the owner either discards it (its code is thrown away, its demo stays in the archive) or has the idea built on its branch, by a worker who takes over what carries and brings it to production quality.`,
          'So build only what the demo needs to show, as quickly as you can: no tests, no polish, no docs or plan changes, and do not run the checks. Commit it on your branch anyway, so the demo can be reproduced and the idea can be built on it. The demo only needs to make the idea visible: a video of 30–60 s, or an HTML artifact when the idea is something to look at (drafts of a logo, say).',
          "Your questions and the owner's answers also reach the idea's exploration agent, so ask on this card; the idea will not ask them again.",
          idea?.idea?.brief ? `The idea as discussed so far:

${idea.idea.brief}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    if (card.body.trim()) parts.push(card.body.trim());
    if (card.builtOn) parts.push(this.builtOnPrototype(card.builtOn));
    const from = card.from && !card.prototypeOf ? this.o.board.item(card.from) ?? this.o.board.archived().find((i) => i.id === card.from) : undefined;
    if (from) {
      const summary = this.o.board.summary(from.id)?.trim();
      parts.push(`This card follows up on the card “${from.title}”.${summary ? ` Its worker handed it over with this summary:\n\n${summary}` : ''}`);
    }
    const shots = this.taskImages(card);
    if (shots.length)
      parts.push(`${shots.length === 1 ? 'The owner attached a screenshot' : `The owner attached ${shots.length} screenshots`} to the card (shown with this message; files: ${shots.join(', ')}).`);
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (project?.plan) parts.push(`This is workstream ${card.label ?? ''} of the project “${project.title}”. Read its plan doc ${project.plan.file} first; it holds the context and decisions.`);
    parts.push(
      card.builtOn
        ? `You are on branch ${branch}, which holds the prototype's commits (and any earlier work on this card): look at its log and diff first.`
        : resumed
          ? `You are on branch ${branch}, which already holds earlier work on this card: look at its log and diff first and go on from there.`
          : `You are on branch ${branch}, fresh from the default branch.`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the clone.`);
    if (this.o.adapter.checks?.length && !card.prototypeOf) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    if (this.o.adapter.demo)
      parts.push(
        [
          `${this.o.adapter.demo.required ? 'Then show' : 'Where it helps the owner, show'} the owner the result, so they can judge at a glance whether the work is done, and hand it over with ready_for_review (with its report).`,
          `Usually that is a demo of the change, recorded with the demo skill (\`${DEMO_SKILL}\`) as its instructions say (directory, chapter titles). Its length follows the size of the change, never padded: 30–60 s for a small one (a fix: the broken behaviour, then the fixed one), 1½–3 min for a larger one. Skip the skill's last steps (opening the page, the notification, the chat reply): Obeya shows the demo on the card.${this.shares ? ' The owner may share a video with colleagues of the team on a page of its own: hand it over with that page (title, text), written for them.' : ''} How to run the app for the demo: ${this.o.adapter.demo.howToRun}`,
          "When the result is something to look at rather than something that happens (drafts of a logo or a layout side by side, a comparison of variants, an analysis), make an HTML artifact instead: an index.html in a new directory under ~/demos/ (never in git), self-contained or with the files it loads beside it, made for the owner to decide on, and hand it over with kind 'html'. It shows in a sandboxed frame on the card, about 800 px wide, without Obeya's API.",
          `Only when there is nothing to show at all (the task turned out to be done already, say), hand over with no_demo and why instead. That is the exception: the owner wants something to see.`,
        ].join(' '),
      );
    return parts.join('\n\n');
  }

  /** What the worker of an idea built on a prototype hears of it: what the branch holds, the prototype's handover and the owner's answers on it. */
  private builtOnPrototype(prototypeId: string): string {
    const prototype = this.o.board.card(prototypeId);
    const summary = this.o.board.summary(prototypeId)?.trim();
    const answers = this.o.board.decisionsOn(prototypeId);
    return [
      `The owner chose to build this idea on its prototype “${prototype?.title ?? ''}”, and your branch is that prototype's. It is a throwaway prototype: built quickly to show the idea, without tests, polish or docs, with shortcuts. Take over what carries and bring it to production quality: tests, the repository's checks, the design doc and other docs, shortcuts removed. Rewrite or drop what does not hold up; nothing on the branch counts as reviewed code. The task is the idea's brief above; the prototype is a means to it, not the result.`,
      summary ? `The prototype's worker handed it over with this summary:\n\n${summary}` : '',
      answers.length ? `What the owner answered on the prototype:\n${answers.map((d) => `- ${d.question} → ${d.answer}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

function formatQuestion(q: Question): string {
  return q.options.length ? `${q.text}${q.multiple ? ' (Mehrfachauswahl)' : ''}\n${q.options.map((o) => `– ${o}`).join('\n')}` : q.text;
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

/** The state a finished card goes back to after a question: `done` when nothing landed, else `live`. */
const landedState = (landed: string) => ((JSON.parse(landed) as LandedState).unchanged ? 'done' : 'live');

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
