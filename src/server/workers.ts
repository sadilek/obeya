// Workers: one agent session per card, in a leased clone. Obeya is the mailbox between the
// worker and the owner; every exchange lands in the card's conversation.

import { z } from 'zod';
import type { CardDiff } from '../core/diff';
import { LANGUAGE_NAMES, LANGUAGES } from '../core/locale';
import { MESSAGES, type Messages, type Pause } from '../core/messages';
import { existsSync } from 'node:fs';
import { realPath } from './path';
import { isAbsolute, join } from 'node:path';
import { type CardFile, changeSize, docImages, fileKind, isImage, normalPath, shownFiles } from '../core/files';
import { answering, askable, type Awaited, AWAITED_STATES, awaited, type BackgroundTask, pausable, pausableNow, type WorkerTurn, type CardLanding, type ChangeSize, type Demo, type DemoKind, type DemoPage, finished, formatQuestion, handedOver, type Item, pickedAnswer, prototypeBuild, prototypeName, type Question, type RepoRef, type RestartReason, type Share, type Snooze, laterTime, type Spot, type Superseded, type SpotInput, started, cardAgentOf, type ChangeRoute, type PageTags } from '../core/types';
import { BadRequest, type Board, notPaused, pauseRefused, replyNote, type Retracted, titleKey } from './board';
import { pathOfRef } from './plan-ref';
import { fromJson, type AskedPermission, type HeldComment, type LandedState, type PageHeard, type PausedState, type PrState, type Resolving, type Shipped, type Json, type StoredDemo, type Unheard, toJson } from './row';
import { parsePlanDoc } from '../core/plan-doc';
import { type Asked, decisionLog, withPick } from './advisor';
import { checkArtifact, OBEYA_PLUGIN, placeIn, readChapters } from './demo';
import { artifactFiles, keepDemo, videoFacts } from './demo-files';
import { imageNote } from './images';
import { outsidePlanDir, remoteHost } from './repo';
import { type AgentEvent, type AgentSession, type AgentSpec, type AgentTool, BACKGROUND_GRACE, BACKGROUND_LIMIT, failureReason, LIMIT_LIFTED, limitLifts, type PermissionAnswer, type PermissionRequest, sessionHarness, startingLater } from './runtime';
import { toObeyaTool } from './to-obeya';
import { hostName, remote } from './hosts';
import { runAppCommand } from './app-command';
import { readSettingsAt, REPO_SETTINGS_FILE } from '../adapters';
import { BranchGone, type FileAt, type Lease, shortageOf } from './workspaces';
import { branchName } from './branches';
import { WorkspaceError } from './git';
import type { FolderWorkspaces, UndoReport } from './folder';
import { dimensions, outside, tagsOf } from '../core/page-tags';
import type { CardRow, RowUpdate } from './db';
import { parsePrUrl, sameRepo } from './forge';
import { clip, messageOf, tooLong, oneLine } from '../core/text';
import { within } from '../core/late';
import { holdsNotes } from '../core/queue';
import { CardApps } from './card-app';
import { type OwnCommits, ReviewCards } from './review-cards';
import { WorkerBriefing } from './worker-briefing';
import { folderOf, sharesOf, type WorkerOptions } from './worker-options';
import { describeTool, permissionWhat, SPOKEN } from './agent-lines';
import { PROPOSAL_QUESTIONS, proposalQuestions, proposalTask, retractedText } from './proposals';
import { AFTER_DONE, AFTER_LANDING, AFTER_RESTART, answerNote, FOLLOW_UP, FOLLOW_UP_FOLDER, hostResumed, IN_WORKTREE, NOT_LANDED, PAUSE_STILL, PAUSE_TAKEN_BACK, pauseNotice, REPO_RESTARTED, RESTARTED, RESUMED, restartNotice, restartWaits, snoozedUntil, spotNote, stillDue, wokeNote } from './worker-texts';

export type { WorkerOptions } from './worker-options';

/** The owner's comments on places in the demo video that go with their approval, as the worker reads them. */
export type Comments = { text: string; images: string[] };

/** Landed work's state once what it waited for (the restart) has happened. */
const settled = ({ restarts: _, waits: __, ...l }: LandedState): LandedState => l;

/** Where a live card's landed work starts and ends, where both are known: `base..commit` is what it changed. */
function landedAt(row: CardRow): { base: string; commit: string } | undefined {
  const s = row.state === 'live' ? fromJson(row.shipped) : null;
  return s?.commit && s.base ? { base: s.base, commit: s.commit } : undefined;
}

/** What the card's row becomes when it is planned again, its worker stopped (`Workers.stop`, also where its repository does not run). */
export const PLANNED_AGAIN = { state: 'planned', need: null, detail: null, pr: null, approved_at: null, paused: null, pausing: null, snoozed: null, app: null } satisfies RowUpdate;

/** What the card's row becomes once landed work's worker is done (`Workers.finish`, also where its repository does not run). */
export const finishedRow = (row: CardRow): RowUpdate => ({
  landed: null,
  workspace: null,
  status_line: null,
  parked: null,
  paused: null,
  pausing: null,
  snoozed: null,
  app: null,
  ...(row.state === 'waiting' ? { state: fromJson(row.landed)?.unchanged ? 'done' : 'live', need: null, detail: null } : {}),
});

/**
 * The comments held back for the card's worker (`CardRow.held`) are held no more: they stand in the
 * conversation as read where they go now, never shown meanwhile as words waiting for a step. Returns them.
 */
export function releaseHeld(board: Board, cardId: string): HeldComment[] {
  const comments = fromJson(board.row(cardId).held) ?? [];
  if (!comments.length) return [];
  board.readNow(cardId, comments.map((h) => h.id));
  board.work(cardId, { held: null });
  return comments;
}

/** What `f` returns; a workspace it cannot have is the request's error. */
function asBadRequest<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof WorkspaceError) throw new BadRequest(e.code, e.message);
    throw e;
  }
}

/** `asBadRequest` for what settles later. */
async function asBadRequestAsync<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof WorkspaceError) throw new BadRequest(e.code, e.message);
    throw e;
  }
}

function pageHeardOf(share: Share | undefined): PageHeard {
  if (share?.state === 'publishing') return { page: 'going' };
  if (share?.state === 'shared' && share.url) return { page: 'online', url: share.url, ...(share.stale ? { stale: true as const } : {}) };
  return { page: 'none' };
}

/**
 * A background task of the worker as Obeya follows it: whether it runs since an earlier turn, and
 * whether it serves the app the worker said runs, which wakes nobody: the worker waits for no app.
 */
interface RunningTask extends BackgroundTask {
  earlier?: true;
  app?: true;
}

/**
 * The worker said its app runs (or no longer does). The work it started in this turn and runs now
 * serves it (the dev server it started, then checked); work from an earlier turn (a test run it
 * waits for) does not. The SDK links no task to the app, so this is what tells the two apart.
 */
function appRunning(live: Live, url: string) {
  // an address app_running refuses changes nothing
  if (url && !APP_URL.test(url)) return;
  for (const t of live.tasks.values()) {
    if (!url) delete t.app;
    else if (!t.earlier) t.app = true;
  }
}

/** An app's address as app_running takes it. */
const APP_URL = /^https?:\/\/[^\s/]+/i;

/** Whether all the worker's background work that runs serves its app. */
function onlyApp(live: Live): boolean {
  return live.tasks.size > 0 && [...live.tasks.values()].every((t) => t.app);
}

interface Live {
  session: AgentSession;
  /** The machine its workspace is on (null: the one Obeya runs on), where it holds a slot while in a turn. */
  host: string | null;
  /** Whether the worker called `ask` or `ready_for_review` in the current turn. */
  handedOver: boolean;
  /** Whether the worker answered the owner with `reply` in the current turn. */
  answered?: boolean;
  /** Whether the worker had words for the owner in the current turn: said something, replied, or passed their words on to Obeya. */
  spoke?: boolean;
  /** Whether the worker snoozed in the current turn: its session ends with the turn, and its closing words repeat the snooze. */
  snoozed?: boolean;
  /** The worker's words since its reply: its words once a step follows them, its closing words at the turn's end. */
  held?: string;
  /**
   * Whether the worker said or did anything in the current turn. A resumed session may first end a
   * turn of its own, over what the previous session left (a background command the restart stopped).
   */
  acted: boolean;
  /** Whether the session said or did anything since it started: one that ends by itself after that has a conversation worth resuming. */
  ran?: boolean;
  nudged: boolean;
  /**
   * The last of Obeya's tools that refused the worker's call, with its words, until the same tool
   * takes a call: the nudge at the turn's end repeats them, for a worker that never read them.
   */
  refused?: { tool: string; text: string };
  lastText: string;
  /** The error the worker's last turn failed with (not logged in, say); gone once it says or does something. */
  failed?: string;
  /** Between a message and the end of the turn it starts: a restart now would cut the worker off. */
  busy: boolean;
  /** Set while an ended turn waits for the worker's background work to wake it. */
  waiting?: ReturnType<typeof setTimeout>;
  /** Set while the worker waits for a usage limit to lift: it then goes on where it stopped. */
  lifts?: ReturnType<typeof setTimeout>;
  /** How many of the worker's background tasks run, as the session last said. */
  background: number;
  /** Those tasks by the session's id, as the agent described them and since when Obeya saw them run, the oldest first: on the card while they run. */
  tasks: Map<string, RunningTask>;
  /** When the usage limit that stopped the worker lifts (or, not knowing, when to try again); gone once it works. */
  limited?: number;
  /** The card's status line from before the worker waited for the limit, back once it works again. */
  statusBefore?: string | null;
  /** Whether the card's open question is the worker having stopped, not a question it asked. */
  stalled: boolean;
  /** Whether the worker has heard of the restart that is due, so that it pauses for it. */
  toldRestart?: boolean;
  /** The card's status line from when the worker heard of the restart, back once it paused: a line about pausing is stale once it goes on. */
  statusBeforeRestart?: string | null;
  /** The worker ended a turn for the restart that is due: a turn that starts before the restart (its background work woke it) hears that Obeya still waits. */
  restartPaused?: boolean;
  /** The worker ended a turn for the owner's pause at a safe point while its background work runs on: a turn that work starts hears that the owner still waits. */
  pauseHeld?: boolean;
  /** The owner's preferences as the worker last heard them: in its instructions, or since then. */
  preferences: string;
  /** The project the card is a workstream of, and the last of its decisions the worker has heard of. */
  project?: { id: string; decision: number };
  /** Stands in for the agent of a card that has no session (`standIn`): its tools run all the same. */
  standIn?: true;
  /** A tool call waits for the owner's permission, the question the card waits on: settles it with their answer. */
  permission?: (answer: PermissionAnswer) => void;
  /** The permission asked last, which the next one waits for: the card holds one question at a time. */
  asking?: Promise<unknown>;
  /** The message that started the current turn, until the worker shows it has taken it: a session on another machine that is cut off before gets it again. */
  pending?: { text: string; images: string[] };
}

/** A restart that waits for workers to finish their turns: why, and when it goes ahead at the latest. */
export interface DueRestart {
  reason: RestartReason;
  deadline: number;
  /** Only the agents of these workers' repository restart, for a change to its configuration; Obeya runs on. */
  repo?: boolean;
}

/** What the worker pauses for, as the card's log says it. */
const pauseOf = (due: DueRestart): Pause => (due.reason === 'stop' ? 'stop' : due.repo ? 'repo' : 'restart');

/** The owner may pause the demo video for a while; a browser gone away leaves no other sign. */
const HOLD_GRACE = 10 * 60_000;
/** Closing the card with "Approve" also ends the watching: the approval takes the comments then. */
const RELEASE_DELAY = 1500;
/** Whether the card's status line is the one it shows while its worker waits for a usage limit, in either language. */
const limitLine = (line: string | null | undefined) => !!line && LANGUAGES.some((l) => line.startsWith(MESSAGES[l].worker.limitStatus));

/** The question of a demo report as the demo keeps it: its text, options and the worker's pick, as `ask` takes them. */
function demoQuestion(q: { text: string } & Omit<Asked, 'question'>): Pick<Demo, 'question' | 'options' | 'multiple' | 'pick'> {
  const { text, options, multiple, pick } = withPick({ ...q, question: q.text });
  return { question: text, ...(options.length ? { options } : {}), ...(multiple ? { multiple } : {}), ...(pick ? { pick } : {}) };
}

/** How many files a worker may name as its result at a handover. */
const MAX_RESULT_FILES = 12;

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

/** How often Obeya asks whether a machine whose connection was lost answers again. */
const RECONNECT_MS = 30_000;

/** How long a worker asked to pause at a safe point has for it at most, as a due restart waits for it. */
const PAUSE_LIMIT = 15 * 60_000;

/** How long taking a card's workspace waits for its ended session to finish its step before git keeps its work. */
const EVICT_SESSION_WAIT = 30_000;

export class Workers {
  private live = new Map<string, Live>();
  /** Cards whose approved work is landing: the server answers meanwhile, but approving again is refused, and a restart waits. */
  private landing = new Set<string>();
  /** Cards approved while git tells what the approval does (`approve`), or while a review card's pull request is pushed to and merged (`mergeContribution`): a restart waits for them too. */
  private approving = new Set<string>();
  /** Merged cards whose branch git reads the added plan docs of: their workspace goes once it has (`finish`). */
  private reading = new Map<string, Promise<void>>();
  /**
   * Cards whose workspace git is making ready before their worker goes on (`whenReady`), with the
   * machine it is on: the server answers meanwhile, the card holds a slot there, and a restart waits.
   */
  private preparing = new Map<string, { host: string | null; done: Promise<void> }>();
  /** Whether these workers were shut down: a workspace made ready afterwards starts no worker. */
  private shut = false;
  /** Bumped whenever a card's work starts, stops or ends: replies and tool calls from before are stale. */
  private generation = new Map<string, number>();
  /** The last run handed out to a card (`bump`). */
  private runs = 0;
  /** The restart that waits for workers, if one does. */
  private restart: DueRestart | null = null;
  /** Cards whose session on another machine was cut off, waiting for that machine to answer again. */
  private reconnecting = new Map<string, ReturnType<typeof setTimeout>>();
  /** When Obeya pauses at once a worker that the owner asked to pause at a safe point, by card. */
  private pausing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tool calls the owner allowed after the session that asked was gone (a restart), by card: each runs once, without asking again. */
  private granted = new Map<string, Set<string>>();
  /** Whether settling the leases is due once the change at hand is through (`settleLater`). */
  private settling = false;
  /** Worktrees their cards are done with that still hold uncommitted changes: they stay (`settleLeases`). */
  private kept = new Set<string>();
  /**
   * Workspaces git is freeing now (a landed card's, a discarded prototype's, one its card is done
   * with), by path, with the card that held them: the server answers meanwhile, and a restart waits.
   */
  private freeing = new Map<string, { card: string; done: Promise<void> }>();
  /** Cards whose clone the owner is taking from them (`evict`) while git keeps their work there: they do not start meanwhile. */
  private evicting = new Set<string>();
  /** Cards with comments on places in the demo video held back: when they go to the worker without the owner's sign. */
  private holding = new Map<string, ReturnType<typeof setTimeout>>();

  /** Ends the subscription to the board's changes. */
  private unwatch: () => void;
  /** What the card's worker is told before it does anything: its instructions and its task. */
  private brief: WorkerBriefing;
  /** The app in the card's workspace while its worker is away from it. */
  private apps: CardApps;
  /** Review cards: the contributor's pull request, its findings, push and merge. */
  private reviews: ReviewCards;

  constructor(private o: WorkerOptions) {
    this.apps = new CardApps(o, { busy: (id) => !!this.live.get(id)?.busy, run: (id) => this.generation.get(id), shut: () => this.shut });
    this.reviews = new ReviewCards(o, {
      run: (id) => this.generation.get(id),
      shut: () => this.shut,
      approving: this.approving,
      card: (id) => this.card(id),
      deliver: (id, text, images, owner) => this.deliver(id, text, images, owner),
      unheard: (id) => this.unheard(id),
      unheardBut: (id, prefix) => this.unheardBut(id, prefix),
      held: (id) => this.held(id),
      holdOff: (id) => {
        clearTimeout(this.holding.get(id));
        this.holding.delete(id);
      },
      releaseSoon: (id) => this.releaseLater(id, this.o.releaseDelay ?? RELEASE_DELAY),
      approvalComments: (id) => this.approvalComments(id),
      merged: (id, commit, note, comments) => this.merged(id, commit, note, comments),
      resumeFinished: (...args) => this.resumeFinished(...args),
      toOwner: (id, q) => this.toOwner(id, q),
      refuseAsked: (id, why) => this.refuseAsked(id, why),
    });
    this.brief = new WorkerBriefing(o, { prSource: (c) => this.reviews.prSource(c), proposalBoards: () => this.proposalBoards() });
    // what a worker does shows on its card while it is in a turn, and only then can it be paused
    o.board.showTurns(() => this.turnsShown());
    // a forward to a card's app ends once the card no longer offers it: cleared, parked, its workspace gone
    this.unwatch = o.board.onChange(() => {
      // a forward to a card's app ends once the card no longer offers it: cleared, parked, its workspace gone
      this.apps.unforwardGone();
      this.forget();
      this.settleLater();
    });
  }

  /** What is kept by card goes once its card is deleted or archived: the maps would otherwise grow for the life of the process. */
  private forget() {
    const maps = [this.generation, this.apps.tried, this.granted];
    const ids = [...new Set(maps.flatMap((m) => [...m.keys()]))];
    if (!ids.length) return;
    // one look at the rows alone: reading the items here would make the board's own notes on them earlier
    const gone = new Set(this.o.board.gone(ids));
    for (const m of maps) for (const id of gone) m.delete(id);
  }

  /** The folder without git the cards work in, where the repository is one (design: Folders without git). */
  private get folder(): FolderWorkspaces | null {
    return folderOf(this.o);
  }

  /** Whether a video demo here may go to a page for colleagues, which the worker then writes. */
  private get shares(): boolean {
    return sharesOf(this.o);
  }

  // ---------------------------------------------------------------- owner actions

  /**
   * Starts the card's worker. The card is at work at once, its workspace taken; the worker starts
   * once git has made that ready, which the promise waits for. Refusals (`notPlanned`, no workspace
   * free) throw at once; where the clone it took turns out not to be clean and no other is, the card
   * is planned again and the promise rejects with that shortage.
   */
  start(cardId: string): Promise<void> {
    const card = this.card(cardId);
    if (card.kind === 'project') throw new BadRequest('project', 'a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    if (this.evicting.has(card.id)) throw new BadRequest('evicting', 'its workspace is being given to another card');
    // once work has begun the branch stays the card's, whatever the title says now
    const row = this.o.board.row(card.id);
    // a workstream planned again after a part landed: the branch of that part may still be in a clone
    const shipped = fromJson(row.shipped);
    const branch = row.branch ?? `${branchName(card.title, card.id)}${shipped ? `-${shipped.commit?.slice(0, 7) ?? 'rest'}` : ''}`;
    const { path, ready } = asBadRequest(() => this.o.workspaces.lease(card.id, branch, { from: row.kept_in }));
    this.bump(card.id);
    // the run before is not resumed, but the work retrospective still reads it
    if (row.session_id) this.o.board.log(card.id, 'state', 'obeya', this.o.board.t.worker.restarted(this.o.board.t.worker.earlierRun(row.session_id)));
    // a review card's pull request is watched from the start, afresh
    const contribution = fromJson(row.contribution);
    const pr = contribution ? toJson<PrState>({ url: contribution.url, number: contribution.number, seen: [], reported: [] }) : null;
    // a fresh session knows of no app that was stopped
    this.o.board.work(card.id, { state: 'working', need: null, detail: null, status_line: null, workspace: path, branch, session_id: null, pr, approved_at: null, parked: null, paused: null, pausing: null, snoozed: null, app: null });
    const t = this.o.board.t.worker;
    this.o.board.log(card.id, 'state', 'obeya', this.folder ? t.startedInFolder : contribution ? t.reviewStarted(contribution.number, contribution.author) : t.started(branch));
    const launch = (headProblem?: string | null) => this.launch(card.id, this.brief.briefing(card, branch, !!row.branch, headProblem), undefined, this.brief.taskImages(card));
    return this.whenReady(
      card.id,
      ready,
      () => {
        // the branch is in this workspace now
        if (row.kept_in) this.o.board.work(card.id, { kept_in: null });
        // a review card's workspace stands on the pull request's head before its worker starts
        if (contribution) this.reviews.onPrHead(card.id, branch, contribution, launch);
        else launch();
      },
      // planned again, as before the start
      () => this.o.board.work(card.id, { state: 'planned', workspace: null, branch: row.branch, paused: null, pausing: null, snoozed: null }),
      true,
    );
  }

  /**
   * Runs `go` (the worker starts, or goes on) once git has made the card's workspace ready
   * (`Lease.ready`; at once when it is), unless the card was stopped, snoozed or started anew
   * meanwhile; until then its status line says that its workspace is being prepared. Where git
   * fails, `undo` puts the card back as it was, whatever came meanwhile, as long as the card still
   * names the workspace, and its conversation says why. `queues`: where no clean clone was left, the
   * promise rejects with the shortage instead, for the Coordinator to queue the card as when there is
   * none at once.
   */
  private whenReady(cardId: string, ready: Promise<string> | null, go: () => void, undo: () => void, queues = false): Promise<void> {
    if (!ready) {
      go();
      return Promise.resolve();
    }
    const generation = this.generation.get(cardId);
    const line = this.o.board.t.worker.preparingWorkspace;
    const path = this.o.board.row(cardId).workspace;
    const settle = (then: () => void, always = false) => {
      if (this.preparing.get(cardId)?.done === waited) this.preparing.delete(cardId);
      // Obeya stopped meanwhile: a new run takes the card on
      if (this.shut) return;
      // a deleted card keeps its row, to be restored
      if (this.o.board.row(cardId).status_line === line) this.o.board.work(cardId, { status_line: null });
      else this.o.board.changed();
      // what was given back meanwhile (the card deleted, say) is freed now
      this.settleLater();
      if (!this.o.board.item(cardId) || !(always || this.generation.get(cardId) === generation)) return;
      try {
        then();
      } catch (e) {
        console.error(`starting the worker of ${cardId}:`, e);
        this.o.board.log(cardId, 'error', 'obeya', messageOf(e));
      }
    };
    const done: Promise<void> = ready.then(
      (at) => {
        // the clone it was given had uncommitted changes when git looked again: it holds the one that took its place,
        // also where it was snoozed or started anew meanwhile
        if (at !== path && !this.shut && this.o.board.row(cardId).workspace === path) this.o.board.work(cardId, { workspace: at });
        settle(go);
      },
      (e: unknown) => {
        const short = queues && e instanceof WorkspaceError && !!shortageOf(e.code);
        let undone = false;
        settle(() => {
          if (this.o.board.row(cardId).workspace !== path) return;
          undo();
          undone = true;
          if (!short) this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.workspaceFailed(messageOf(e)));
        }, true);
        if (short && undone) throw new BadRequest((e as WorkspaceError).code, messageOf(e));
      },
    );
    const waited = done.catch(() => {});
    this.preparing.set(cardId, { host: hostName(path), done: waited });
    this.o.board.work(cardId, { status_line: line });
    return done;
  }

  /**
   * A hint while the worker runs, words on its handover, or a question once its work is done;
   * `images` are screenshot files the owner attached; `replyTo`: the message of the card's
   * conversation the words reply to, which the worker reads above them; `spot`: the place in the
   * demo video they are about. Such words on a handover are held back while the owner watches (`hold`).
   */
  message(cardId: string, text: string, images: string[] = [], spoken = false, replyTo?: number, spot?: SpotInput, findings?: Record<number, ChangeRoute>) {
    const card = this.card(cardId);
    const place = spot ? this.place(cardId, spot) : undefined;
    const handover = handedOver(card);
    if (place && handover && !findings) return this.hold(card, text, images, spoken, replyTo, place);
    // on a review card, what the owner decided for its findings goes with the words, above them
    const decided = findings ? this.reviews.decide(cardId, findings) : undefined;
    // findings ignored, and nothing else: done as they stand, the worker hears it with its next message or step
    if (decided?.quiet && !text && !images.length) {
      this.o.board.log(cardId, 'hint', 'owner', decided.log, { replyTo });
      this.o.board.work(cardId, { unheard: toJson([...this.unheard(cardId), { said: [], text: decided.note, images: [] }]) });
      return;
    }
    const words = `${decided ? `${decided.note}\n\n` : ''}${this.words(cardId, text, images, replyTo, place)}`;
    // the log shows the owner's screenshots, not the stills that join them below
    const shots = images;
    const said = [decided?.log, text].filter(Boolean).join('\n\n');
    // words that reach the worker in the middle of a turn wait for its next step, unread until then
    const log = (later = false) => [this.o.board.log(cardId, 'hint', 'owner', said, { images: shots, replyTo, spot: place, unread: later && this.takesLater(cardId) }).id];
    // the worker sees the frame the words are about
    images = [...this.stills(place), ...images];
    if (handover) {
      // under a demo whose report asks a question, the words answer it, whatever else they say
      if (card.question) return this.answerDemo(card, decided ? `${decided.note}\n\n${text}` : text, images, spoken, replyTo, []);
      // the work still waits for approval while the worker takes the words in; a change they call for comes as a new handover
      this.takingIn(cardId);
      // words without a place end the watching: the comments held back come first, and go with them
      const held = this.takeHeld(cardId);
      const said = log(!held);
      if (text) this.o.onOwnerInput?.(card, 'feedback', text);
      this.deliver(
        cardId,
        `The owner wrote on your handover${spoken ? ` (${SPOKEN})` : ''}. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held ? `${held.text}\n\nThen they wrote:\n\n` : ''}${words}`,
        [...(held?.images ?? []), ...images],
        true,
        held ? [] : said,
      );
    } else if (card.state === 'waiting' && card.need === 'question') {
      // a note instead of an answer takes the question back: it may have settled it, else the worker asks anew
      const waiting = this.live.get(cardId)?.permission;
      this.backToWork(cardId);
      if (waiting) {
        // the tool call waits for the owner, so the worker reads nothing else meanwhile: the note refuses it
        log();
        if (text) this.o.onOwnerInput?.(card, 'note', text);
        waiting({ allow: false, message: `Not run: the owner wrote a note instead of allowing it${spoken ? ` (${SPOKEN})` : ''}. If the note settles it, go on; if not, ask again.\n\n${words}` });
        if (images.length) this.live.get(cardId)!.session.send('The screenshots of the owner’s note.', images);
        return;
      }
      // comments on the demo video still held back, made before the question came, go first, and stand above the note
      const held = this.takeHeld(cardId);
      const said = log(true);
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.deliver(
        cardId,
        `A note from the owner instead of an answer${spoken ? ` (${SPOKEN})` : ''}. It withdraws your question (“${card.question?.text ?? ''}”): if the note settles it, go on; if not, ask again.\n\n${held ? `${held.text}\n\nThen they wrote:\n\n` : ''}${words}`,
        [...(held?.images ?? []), ...images],
        true,
        said,
      );
    } else if (holdsNotes(card)) {
      // no agent works on the card yet: the words go with the task to the one that takes it on
      const said = [this.o.board.log(cardId, 'hint', 'owner', text, { images: shots, replyTo, spot: place, unread: true }).id];
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.o.board.work(cardId, { unheard: toJson([...this.unheard(cardId), { said, text: `A note the owner left on the card while no agent worked on it${spoken ? ` (${SPOKEN})` : ''}:\n\n${words}`, images }]) });
    } else if (this.waitsForClone(cardId)) {
      // no session to take them in now: they go with the message that resumes it in the clone
      const said = [this.o.board.log(cardId, 'hint', 'owner', text, { images: shots, replyTo, spot: place, unread: true }).id];
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.o.board.work(cardId, { unheard: toJson([...this.unheard(cardId), { said, text: `A note from the owner while you waited for the clone${spoken ? ` (${SPOKEN})` : ''}:\n\n${words}`, images }]) });
    } else if (card.state === 'working' || card.state === 'inPr' || card.finishing) {
      // comments on the demo video still held back from its handover go first, and stand above the note
      const held = this.takeHeld(cardId);
      const said = log(true);
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      // a note to a paused worker lets it go on, with the note
      const how = card.paused ? 'with which they let you go on' : 'it does not stop you; adjust your plan if it changes anything';
      this.deliver(cardId, `A note from the owner${spoken ? ` (${SPOKEN})` : ''} (${how}):\n\n${held ? `${held.text}\n\nThen they wrote:\n\n` : ''}${words}`, [...(held?.images ?? []), ...images], true, said);
    } else if (askable(card)) this.followUp(card, text, images, spoken, replyTo, place);
    else throw new BadRequest('noAgent', 'no agent works on this card');
  }

  /**
   * The owner asks about a card whose work is over: its worker's session is resumed in a fresh
   * workspace on the card's branch, as after a landing, and ends again once the worker has answered.
   */
  private followUp(card: Item, text: string, images: string[], spoken: boolean, replyTo?: number, place?: Spot) {
    const row = this.o.board.row(card.id);
    const commit = fromJson(row.shipped)?.commit;
    const stills = this.stills(place);
    this.resumeFinished(
      card,
      {},
      (path, worktree) =>
        [
          this.folder
            ? `The owner asks about this card${spoken ? ` (${SPOKEN})` : ''}. It is done, and your session had ended; it goes on in the folder ${path}, which other cards and the owner may have changed since.`
            : `The owner asks about this card${spoken ? ` (${SPOKEN})` : ''}. ${card.state === 'done' ? 'It was closed without a change to the repository' : `Its work is on main${commit ? ` (${commit.slice(0, 7)})` : ''}`}, and your session had ended; it goes on in a fresh workspace ${worktree ? 'at the head of' : 'on'} the branch ${row.branch}, where main may have moved on since.`,
          this.words(card.id, text, images.slice(stills.length), replyTo, place),
          this.folder ? FOLLOW_UP_FOLDER : FOLLOW_UP,
          ...(worktree ? [IN_WORKTREE] : []),
        ].join('\n\n'),
      images,
      () => {
        this.o.board.log(card.id, 'hint', 'owner', text, { images: images.slice(stills.length), replyTo, spot: place });
        if (text) this.o.onOwnerInput?.(card, 'note', text);
      },
    );
  }

  /**
   * Resumes the session of a card whose work is over in a fresh workspace on its branch, a temporary
   * worktree where no clone is free (the worker hears `message` for it), `extra` in its landed state
   * (`followUp`). `before` runs once the workspace is taken, before the worker hears anything.
   * Throws where the card can have no workspace.
   */
  private resumeFinished(card: Item, extra: LandedState, message: (path: string, worktree: boolean) => string, images: string[] = [], before?: () => void, failed?: () => void) {
    const row = this.o.board.row(card.id);
    let lease: Lease;
    let worktree = false;
    try {
      // the owner's question does not wait for a slot
      lease = this.o.workspaces.lease(card.id, row.branch!, { overSlots: true });
    } catch (e) {
      if (!(e instanceof WorkspaceError)) throw e;
      if (!shortageOf(e.code)) throw new BadRequest(e.code, e.message);
      // nor for a clone: a worktree takes none
      lease = asBadRequest(() => this.o.workspaces.followUpTree(card.id, row.branch!));
      worktree = true;
    }
    const { path, ready } = lease;
    this.bump(card.id);
    const commit = fromJson(row.shipped)?.commit;
    const landed: LandedState = { ...(card.state === 'done' ? { unchanged: true } : commit ? { commit } : {}), followUp: true, ...(worktree ? { worktree } : {}), ...extra };
    this.o.board.work(card.id, { workspace: path, landed: toJson(landed), status_line: null, app: null });
    before?.();
    const text = message(path, worktree);
    void this.whenReady(
      card.id,
      ready,
      () => {
        // a card that never reported a session: a new one needs the card first
        if (row.session_id) this.launch(card.id, text, row.session_id, images);
        else this.launch(card.id, `You worked on the card “${card.title}”:\n\n${card.body}\n\n${text}`, undefined, [...this.brief.taskImages(card), ...images]);
      },
      // the question stands in the conversation, without a workspace to answer it in
      () => {
        this.o.workspaces.release(card.id);
        this.o.board.work(card.id, { workspace: null, landed: row.landed });
        failed?.();
      },
    );
  }

  /** Whether the card's follow-up waits for a full clone, its worker without a workspace. */
  private waitsForClone(cardId: string): boolean {
    const row = this.o.board.row(cardId);
    return !row.workspace && !!fromJson(row.landed)?.needsClone;
  }

  /**
   * The follow-up's worker asked for a full clone (`need_clone`) and ended its turn: its session and
   * temporary worktree end, and the card waits for the next free clone, which resumes the session.
   */
  private awaitClone(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    const row = this.o.board.row(cardId);
    const { worktree: _, ...landed } = fromJson(row.landed)!;
    this.removeTree(row.workspace);
    this.o.board.work(cardId, { workspace: null, landed: toJson(landed), status_line: this.o.board.t.worker.waitsForWorkspace });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.waitsForClone);
    this.takeClone(cardId);
  }

  /**
   * A follow-up waiting for a full clone takes the next clean free one, on any machine whatever its
   * slots, and its worker goes on there. Returns whether it did; the Coordinator asks again as the board changes.
   */
  takeClone(cardId: string): boolean {
    if (!this.waitsForClone(cardId)) return false;
    const row = this.o.board.row(cardId);
    let lease: Lease;
    try {
      lease = this.o.workspaces.lease(cardId, row.branch!, { overSlots: true });
    } catch (e) {
      if (!(e instanceof WorkspaceError && shortageOf(e.code))) console.error(`a clone for the follow-up on ${cardId}:`, e);
      return false;
    }
    const { needsClone: _, ...landed } = fromJson(row.landed)!;
    this.bump(cardId);
    this.o.board.work(cardId, { workspace: lease.path, landed: toJson(landed), status_line: null, app: null });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.cloneFree);
    void this.whenReady(
      cardId,
      lease.ready,
      () => this.deliver(cardId, `A clone is free now: you go on in it, a full clone on the branch ${row.branch}. Answer the owner's question there.\n\n${FOLLOW_UP}`),
      // it waits for the next free clone again
      () => this.o.board.work(cardId, { workspace: null, landed: row.landed, status_line: this.o.board.t.worker.waitsForWorkspace }),
    );
    return true;
  }

  /** Whether the card's follow-up runs in a temporary worktree. */
  private inWorktree(cardId: string): boolean {
    return !!fromJson(this.o.board.row(cardId).landed)?.worktree;
  }

  /** Removes a follow-up's temporary worktree; one left behind does no harm. */
  private removeTree(path: string | null) {
    if (!path) return;
    this.o.workspaces.removeFollowUpTree(path).catch((e: unknown) => console.error(`removing the follow-up worktree ${path}:`, e));
  }

  /**
   * The owner answered the card's question: `words` are their own, `picks` the options they picked
   * (those not among the question's are dropped). The log holds both as one text, picks first
   * (`pickedAnswer`); the worker reads which is which.
   */
  answer(cardId: string, words: string, images: string[] = [], spoken = false, replyTo?: number, picks: string[] = [], spot?: SpotInput) {
    const card = this.card(cardId);
    const options = card.question?.options ?? [];
    const picked = options.filter((o) => picks.includes(o));
    const text = pickedAnswer(picked, words);
    if (card.state === 'waiting' && card.need === 'demo' && card.question) return this.answerDemo(card, text, images, spoken, replyTo, picked);
    if (!(card.state === 'waiting' && card.need === 'question')) throw new BadRequest('noQuestion', 'the card has no open question');
    const row = this.o.board.row(cardId);
    const detail = fromJson(row.detail) ?? {};
    if (detail.permission) return this.answerPermission(card, detail.permission, text, images, spoken, replyTo);
    const question = detail.question;
    const q = question?.text ?? this.pendingQuestion(cardId) ?? '';
    // an answer given at a place in the demo video (one the question brought, say) is about that place
    const place = spot ? this.place(cardId, spot) : undefined;
    // comments on the demo video still held back, made before the question came, go first, and stand above the answer
    const held = this.takeHeld(cardId);
    this.backToWork(cardId);
    this.recordAnswer(card, q, text, images, replyTo, picked, place);
    this.deliver(
      cardId,
      `Answer to your question (from the owner${spoken ? `; ${SPOKEN}` : ''}):\n\n${held ? `${held.text}\n\nThen they answered:\n\n` : ''}${this.words(cardId, answerNote(picked, text), images, replyTo, place)}`,
      [...(held?.images ?? []), ...this.stills(place), ...images],
      true,
    );
  }

  /**
   * The owner answered whether a tool call may run: the call waiting for it runs or is refused, with
   * their words. Allowed after the session that asked was gone (a restart), it runs once the worker
   * makes it again. No decision for the log: it is about one call, not the work.
   */
  private answerPermission(card: Item, asked: AskedPermission, text: string, images: string[], spoken: boolean, replyTo?: number) {
    const [first = '', ...rest] = text.split('\n\n');
    const is = (option: (t: Messages) => string) => LANGUAGES.some((l) => option(MESSAGES[l]).toLowerCase() === first.trim().toLowerCase());
    const allowed = is((t) => t.worker.allow);
    const words = (allowed || is((t) => t.worker.deny) ? rest.join('\n\n') : text).trim();
    this.backToWork(card.id);
    this.o.board.log(card.id, 'answer', 'owner', text, { images, replyTo });
    if (words) this.o.onOwnerInput?.(card, 'answer', words, { question: card.question?.text ?? '' });
    const said = words ? `${spoken ? ` (${SPOKEN})` : ''}:\n\n${this.words(card.id, words, images, replyTo)}` : images.length ? `, with screenshots:${imageNote(images)}` : '.';
    const live = this.live.get(card.id);
    if (live?.permission) {
      live.permission(allowed ? { allow: true } : { allow: false, message: `Not run: the owner did not allow it${said}` });
      // the call's result can carry no words, the next message can
      if (allowed && (words || images.length)) live.session.send(`The owner allowed it${said}`, images);
      else if (images.length) live.session.send('The screenshots of the owner’s answer.', images);
      return;
    }
    // the session that asked is gone: the worker hears the answer when it goes on, and the call runs once it makes it again
    if (allowed) this.granted.set(card.id, (this.granted.get(card.id) ?? new Set()).add(permissionKey(asked)));
    const call = describeTool(asked.name, asked.input, this.o.board.t);
    this.deliver(
      card.id,
      allowed
        ? `Before Obeya restarted, a tool call of yours (${call}) waited for the owner's permission. The owner allowed it${said}\n\nMake the call again if you still need it; it runs without asking again.`
        : `Before Obeya restarted, a tool call of yours (${call}) waited for the owner's permission. The owner did not allow it${said}`,
      images,
      true,
    );
  }

  /**
   * The question in a demo report, answered: the worker hears it, and the demo still waits for
   * approval. While the worker takes in the answer (it may rework the demo), the card is not the
   * owner's; once its turn ends without a new handover, the demo is theirs again.
   */
  private answerDemo(card: Item, text: string, images: string[], spoken: boolean, replyTo: number | undefined, picks: string[]) {
    const q = card.question!.text;
    const held = this.takeHeld(card.id);
    const demo = fromJson(this.o.board.row(card.id).demo!);
    this.o.board.work(card.id, { demo: toJson({ ...demo, answer: text || '(Screenshot)' }) });
    this.takingIn(card.id);
    this.recordAnswer(card, q, text, images, replyTo, picks);
    this.deliver(
      card.id,
      `The owner answered the question in your demo report (“${q}”)${spoken ? ` (${SPOKEN})` : ''}. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held ? `${held.text}\n\nThen they answered:\n\n` : ''}${this.words(card.id, answerNote(picks, text), images, replyTo)}`,
      [...(held?.images ?? []), ...images],
      true,
    );
  }

  /**
   * The owner's words as the worker reads them: the place in the demo video and the message they
   * reply to above them, the frame's and the screenshots' files below.
   */
  private words(cardId: string, text: string, images: string[], replyTo?: number, place?: Spot) {
    const still = this.stills(place);
    return `${place ? `${spotNote(place)}\n` : ''}${replyNote(replyTo ? this.o.board.quoted(cardId, replyTo) : undefined, 'worker')}${text}${this.o.board.numbersNote(text, cardId)}${still.length ? `\n\nThe frame at that place in the video is shown below (file: ${still[0]}).` : ''}${imageNote(images)}`;
  }

  /**
   * A place in the card's demo video, with the chapter there and what the narration says: in the
   * card's demo, or in an earlier one the owner went back to (`spot.demo`).
   */
  private place(cardId: string, spot: SpotInput): Spot {
    const at = Math.max(0, Math.round(spot.at * 10) / 10);
    const row = this.o.board.row(cardId);
    const current = fromJson(row.demo) ?? undefined;
    const earlier = spot.demo !== undefined && spot.demo !== current?.handover ? (fromJson(row.demos) ?? []).findLast((d) => d.handover === spot.demo) : undefined;
    const d = earlier ?? current;
    return {
      at,
      ...(d && d.kind !== 'html' ? placeIn(d.dir, d.chapters, at) : {}),
      ...(spot.still ? { still: spot.still } : {}),
      ...(d?.handover !== undefined ? { demo: d.handover } : {}),
      ...(earlier ? { earlier: true as const } : {}),
    };
  }

  /**
   * The card's earlier demos with the one a new handover replaces added, as `CardRow.demos` keeps
   * them. A demo from before handovers named theirs gets the last one before now: its time, and the
   * places in it the owner's comments are about.
   */
  private earlier(cardId: string, row: CardRow): Json<StoredDemo[]> {
    const { kept, ...replaced } = fromJson(row.demo!);
    const e = replaced.handover === undefined ? this.o.board.events(cardId).findLast((e) => e.kind === 'review') : undefined;
    // from its copy: the new demo may have been rendered over its files
    const dir = kept && existsSync(kept) ? kept : replaced.dir;
    return toJson([...(fromJson(row.demos) ?? []), { ...replaced, dir, ...(e ? { handover: e.id, at: e.at } : {}) }]);
  }

  /** The demo handed over with the event `handover`, with where Obeya keeps a copy of its files (`keepDemo`) where it could make one. */
  private keep<D extends { dir: string; kind: DemoKind }>(cardId: string, handover: number, demo: D): D & { kept?: string } {
    if (!this.o.keptDemos) return demo;
    const kept = join(this.o.keptDemos, cardId, String(handover));
    return keepDemo(demo, kept) ? { ...demo, kept } : demo;
  }

  /** The file of the frame at a place in the video, if it has one. */
  private stills(place: Spot | undefined): string[] {
    return place?.still ? (this.o.imageFiles?.([place.still]) ?? []) : [];
  }

  /**
   * Words on a place in the demo video, while the card waits for the owner's approval: they stand in
   * the conversation at once, but reach the worker together once the owner has finished watching
   * (`release`, words without a place, an approval), so that it reworks the demo once rather than
   * for each comment. Ten minutes after the last one without a sign, they go anyway.
   */
  private hold(card: Item, text: string, images: string[], spoken: boolean, replyTo: number | undefined, place: Spot) {
    // unread until they go: they stand below whatever the worker does meanwhile, and where they went once sent
    const e = this.o.board.log(card.id, 'hint', 'owner', text, { images, replyTo, spot: place, unread: true });
    if (text) this.o.onOwnerInput?.(card, 'feedback', text);
    this.o.board.work(card.id, { held: toJson([...this.held(card.id), { id: e.id, ...(spoken ? { spoken: true } : {}) }]) });
    this.releaseLater(card.id, this.o.holdGrace ?? HOLD_GRACE);
  }

  private held(cardId: string): HeldComment[] {
    return fromJson(this.o.board.row(cardId).held) ?? [];
  }

  private releaseLater(cardId: string, ms: number) {
    clearTimeout(this.holding.get(cardId));
    this.holding.set(
      cardId,
      setTimeout(() => {
        this.holding.delete(cardId);
        // no request to answer with the error: it goes into the card's log
        try {
          this.release(cardId);
        } catch (e) {
          if (this.o.board.item(cardId)) this.o.board.log(cardId, 'error', 'obeya', messageOf(e));
        }
      }, ms),
    );
  }

  /**
   * The owner has finished watching the demo video (it ended, the card closed, it stood still for a
   * while): the comments held back go to the worker, after a moment in which an approval clicked
   * with the closing takes them instead.
   */
  released(cardId: string, now = false) {
    this.card(cardId);
    if (!this.held(cardId).length) return;
    // sent by the owner ("Send now"): no approval is on its way to take them instead
    if (now) this.release(cardId);
    else this.releaseLater(cardId, this.o.releaseDelay ?? RELEASE_DELAY);
  }

  /**
   * The owner takes back words the worker has not taken in: a comment on a place in the demo video
   * that is still held back, or words Obeya holds until its next step. They leave the conversation,
   * and the worker never hears them.
   */
  unsay(cardId: string, id: number) {
    this.card(cardId);
    const unheard = this.unheard(cardId);
    const words = unheard.find((u) => u.said.includes(id));
    if (words && this.o.board.unread(cardId, id)) {
      const rest = unheard.filter((u) => u !== words);
      this.o.board.work(cardId, { unheard: rest.length ? toJson(rest) : null });
      for (const said of words.said) this.o.board.withdraw(cardId, said);
      return;
    }
    const held = this.held(cardId);
    if (!held.some((h) => h.id === id)) throw new BadRequest('notHeld', 'the comment is not held back: the worker has it already');
    const rest = held.filter((h) => h.id !== id);
    this.o.board.work(cardId, { held: rest.length ? toJson(rest) : null });
    if (!rest.length) {
      clearTimeout(this.holding.get(cardId));
      this.holding.delete(cardId);
    }
    this.o.board.unlog(cardId, id);
  }

  /**
   * The comments held back go to the worker as one message, the card still waiting for approval.
   * Once it no longer waits (its worker, taking in earlier words, asked a question or went back to
   * work), they go as a note, or with the answer to the question that is open.
   */
  private release(cardId: string) {
    const card = this.o.board.item(cardId);
    if (!card) return void this.takeHeld(cardId);
    if (!handedOver(card)) {
      if (card.state === 'waiting' && card.need === 'question') return;
      if (!(card.state === 'working' || card.state === 'inPr' || card.finishing)) return void this.takeHeld(cardId);
      const held = this.takeHeld(cardId);
      if (!held) return;
      const how = card.paused ? 'with which they let you go on' : 'it does not stop you; adjust your plan if it changes anything';
      return this.deliver(cardId, `The owner watched your demo video and commented on places in it (${how}):\n\n${held.text}`, held.images, true);
    }
    const held = this.takeHeld(cardId);
    if (!held) return;
    this.takingIn(cardId);
    this.deliver(
      cardId,
      `The owner watched your demo video and commented on places in it. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held.text}`,
      held.images,
      true,
    );
  }

  /** The comments held back as the worker reads them, each with its place, and their frames and screenshots; none are held afterwards. */
  private takeHeld(cardId: string): { text: string; images: string[] } | null {
    clearTimeout(this.holding.get(cardId));
    this.holding.delete(cardId);
    const held = releaseHeld(this.o.board, cardId);
    if (!held.length) return null;
    const events = new Map(this.o.board.events(cardId).map((e) => [e.id, e]));
    const images: string[] = [];
    const comments = held.flatMap(({ id, spoken }) => {
      const e = events.get(id);
      if (!e) return [];
      const still = this.stills(e.spot);
      const shots = this.o.imageFiles?.(e.images) ?? [];
      images.push(...still, ...shots);
      const files = [...still.map((f) => `frame: ${f}`), ...shots.map((f) => `screenshot: ${f}`)];
      return [
        `${e.spot ? spotNote(e.spot) : ''}${spoken ? ` (${SPOKEN})` : ''}\n${replyNote(e.replyTo ? this.o.board.quoted(cardId, e.replyTo) : undefined, 'worker')}${e.text}${this.o.board.numbersNote(e.text, cardId)}${files.length ? `\n(${files.join('; ')})` : ''}`,
      ];
    });
    if (!comments.length) return null;
    const many = comments.length > 1;
    return {
      text: `${many ? `${comments.length} comments` : 'A comment'} on places in your demo video${images.length ? ` (${many ? 'their frames and screenshots are' : 'its frame is'} shown below, in this order)` : ''}:\n\n${comments.join('\n\n')}`,
      images,
    };
  }

  /** Comments on places in the demo video the owner made before approving: they go with the approval. */
  private approvalComments(cardId: string): Comments | undefined {
    const held = this.takeHeld(cardId);
    return held
      ? { text: `Before approving, the owner watched your demo video. ${held.text}\n\nThey approved the work as it is all the same: what still matters of these comments, propose as a card of its own (propose_card).`, images: held.images }
      : undefined;
  }

  /**
   * `direct`: the work goes onto the default branch at once instead of into a pull request, where
   * the repository's settings allow it. `findings`: on a review card, what the owner decided for its
   * findings and had not sent yet, which goes with the approval (`mergeContribution`).
   */
  async approve(cardId: string, { direct = false, findings }: { direct?: boolean; findings?: Record<number, ChangeRoute> | undefined } = {}) {
    const card = this.card(cardId);
    if (!handedOver(card) || this.landing.has(cardId) || this.approving.has(cardId)) throw new BadRequest('notReady', 'the card is not ready for review');
    if (card.contribution) {
      if (direct) throw new BadRequest('noDirect', 'a review card merges its pull request');
      return this.reviews.mergeContribution(cardId, findings && Object.keys(findings).length ? { findings } : {});
    }
    if (findings && Object.keys(findings).length) throw new BadRequest('notReview', 'only a review card has findings to decide on');
    if (direct && card.prototypeOf) throw new BadRequest('noDirect', 'a prototype never lands');
    // a prototype never lands: approving it is having seen enough
    if (card.prototypeOf) {
      this.takeHeld(cardId);
      return this.endPrototype(cardId, 'discarded');
    }
    // approved, a card its worker snoozed on its handover wakes no more: the check it was to make again is done with
    const unsnooze = () => card.snoozed && this.o.board.work(cardId, { snoozed: null });
    // in a folder without git, what it changed is in the folder already
    if (this.folder) {
      unsnooze();
      return void this.close(cardId, 'owner', this.approvalComments(cardId));
    }
    // git tells where the work lands and whether there is any, without blocking the server; the click ends the owner's turn meanwhile,
    // and the comments held back wait for the approval
    clearTimeout(this.holding.get(cardId));
    this.holding.delete(cardId);
    const before = this.o.board.row(cardId).approved_at;
    this.o.board.work(cardId, { approved_at: new Date().toISOString() });
    this.approving.add(cardId);
    const generation = this.generation.get(cardId);
    let lands: { land: 'main' | 'pr'; direct: boolean };
    let work: boolean;
    try {
      [lands, work] = await Promise.all([this.landingOf(cardId), this.o.workspaces.hasWork(cardId)]);
    } finally {
      this.approving.delete(cardId);
    }
    // stopped meanwhile (and perhaps started and handed over anew: that is not what the owner approved)
    if (!handedOver(this.card(cardId)) || this.generation.get(cardId) !== generation) throw new BadRequest('notReady', 'the card is not ready for review');
    // where work lands on main anyway, approving it directly is approving it
    if (direct && lands.land === 'pr' && !lands.direct) {
      this.o.board.work(cardId, { approved_at: before });
      if (this.held(cardId).length) this.releaseLater(cardId, this.o.releaseDelay ?? RELEASE_DELAY);
      throw new BadRequest('noDirect', 'this repository lands approved work only through a pull request; its settings do not allow pushing it directly');
    }
    unsnooze();
    const comments = this.approvalComments(cardId);
    // work that changed nothing (a demo, an analysis) has nothing to land and no pull request to open
    if (!work) return void this.close(cardId, 'owner', comments);
    if (lands.land === 'main' || direct) return this.land(cardId, 'owner', comments);
    // the worker opens the PR the way the repository does it, then Obeya watches it
    const pr: PrState = { url: null, seen: [], reported: [] };
    // the line the worker reported before handing over is about work that is done
    this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, status_line: null, approved_at: null, pr: toJson(pr) });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.approvedPr);
    // a page that goes out now gets the pull request's link from Obeya once both are there
    this.o.onApproval?.(cardId);
    // a demo shared later gets its line from Obeya once the pull request is open
    const shared = card.share?.url;
    if (shared) this.pageHeard(cardId);
    this.deliver(
      cardId,
      [
        `The owner approved your work. In this repository it goes out as a pull request, opened the way the repository does it (its own skills and conventions): from now on you may push this branch. Whoever reads the pull request has not seen Obeya, the card or the plan doc. Do not merge it: ${this.o.adapter.autoMerge === false ? 'the people on the forge merge it' : 'Obeya merges it'} once its checks have passed and its review is through.`,
        shared ? `Your demo video is shared with the team on a page of its own: ${shared}. Link it in the pull request's description.` : '',
        'Once you report its URL with pr_opened, Obeya watches it and passes you review comments, failed checks and conflicts; you handle them the way the repository does (its skill for review comments, if it has one). A comment that questions a decision, or a conflict that needs a product call, is the owner’s (ask). Where the work also needs a pull request in another repository, report that one with pr_opened too: Obeya watches each, and the card is live once all are merged.',
        comments?.text ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      true,
    );
  }

  /**
   * "Discard changes" in a folder without git, on a card waiting for approval: what its worker
   * changed there is put back as it was (`FolderWorkspaces.undo`), but what someone changed since
   * and what no copy was kept of. The card goes on waiting for the owner, its log says what was put
   * back and what not, and its worker hears it with its next message.
   */
  async undo(cardId: string): Promise<UndoReport> {
    const card = this.card(cardId);
    if (!this.folder) throw new BadRequest('notFolder', 'only the changes of a card in a folder without git are undone');
    if (!handedOver(card) || this.landing.has(cardId)) throw new BadRequest('notReady', 'only a card waiting for approval has its changes discarded');
    const report = await this.folder.undo(cardId);
    const t = this.o.board.t.worker;
    const files = (list: string[]) => list.join(', ');
    this.o.board.log(
      cardId,
      'state',
      'owner',
      [t.undone(report.undone.filter((p) => !p.endsWith('/')).length), report.changedSince.length ? t.undoChangedSince(files(report.changedSince)) : '', report.lost.length ? t.undoLost(files(report.lost)) : '', report.shared.length ? t.undoShared(files(report.shared)) : ''].filter(Boolean).join(' '),
    );
    const row = this.o.board.row(cardId);
    const detail = fromJson(row.detail) ?? {};
    const told = [
      `The owner discarded your changes in the folder: Obeya put back what your card changed (${report.undone.join(', ') || 'nothing'}) as it was before.`,
      report.changedSince.length ? `Left as they are, since someone changed them after you: ${files(report.changedSince)}.` : '',
      report.lost.length ? `Left as they are, since no copy from before your change was kept: ${files(report.lost)}.` : '',
      report.shared.length ? `Left as they are, since another card's agent was at work when they changed: ${files(report.shared)}.` : '',
      'The card still waits for the owner.',
    ];
    this.o.board.work(cardId, {
      detail: toJson({ ...detail, noChange: !this.folder.changed(cardId).length || undefined }),
      unheard: toJson([...this.unheard(cardId), { said: [], text: told.filter(Boolean).join(' '), images: [] }]),
    });
    return report;
  }

  /**
   * How the card's work lands: as the repository's settings say, except where its own branch
   * changes that in `.obeya/settings.json` (the card that sets up the settings, say) and the
   * settings of this machine do not say otherwise. Then as the branch says: the owner approves the
   * change with the work, and has answered how work lands in the card that makes it. `own` holds
   * what the branch decides.
   */
  private async landingOf(cardId: string): Promise<{ land: 'main' | 'pr'; direct: boolean; own?: CardLanding }> {
    const repo = { land: this.o.adapter.land, direct: !!this.o.adapter.direct };
    const fork = await this.o.workspaces.forkPoint(cardId, REPO_SETTINGS_FILE);
    if (!fork) return repo;
    const [now, before] = await Promise.all([readSettingsAt(fork.ws, 'HEAD'), readSettingsAt(fork.ws, fork.base)]);
    const machine = this.o.machineSettings?.();
    const own: CardLanding = {};
    for (const field of ['land', 'direct'] as const) {
      const v = now.settings?.[field];
      if (v !== undefined && v !== before.settings?.[field] && machine?.[field] === undefined) Object.assign(own, { [field]: v });
    }
    if (own.land === undefined && own.direct === undefined) return repo;
    return { land: own.land ?? repo.land, direct: own.direct ?? repo.direct, own };
  }

  /**
   * Lands approved work on main: on the Obeya checkout, or, where work otherwise goes out as a pull
   * request, pushed directly onto `origin`'s default branch. What the worker can fix (main moved on
   * and the change conflicts, uncommitted work) goes back to it with the approval kept: its next
   * handover lands without the owner approving again, the same way. What blocks the Obeya checkout,
   * or a push turned away, stays with the owner and needs a new approval.
   */
  private async land(cardId: string, by: 'owner' | 'obeya', comments?: Comments) {
    if (this.landing.has(cardId)) return;
    this.landing.add(cardId);
    try {
      await this.landNow(cardId, by, comments);
    } catch (e) {
      // a landing that broke off gives the card back to the owner, who approves again
      if (this.o.board.row(cardId).state === 'waiting') this.o.board.work(cardId, { approved_at: null });
      throw e;
    } finally {
      this.landing.delete(cardId);
    }
  }

  private async landNow(cardId: string, by: 'owner' | 'obeya', comments?: Comments) {
    const row = this.o.board.row(cardId);
    // only a direct approval is held where work goes out as a pull request
    const direct = (await this.landingOf(cardId)).land === 'pr';
    // read before landing: the landed branch adds nothing against main
    const added = await this.planDocsAdded(cardId);
    // the demo goes out with the approval, also where it holds for the worker's next handover
    const trailer = this.o.onApproval?.(cardId) ?? undefined;
    const result = await (direct ? this.o.workspaces.pushToMain(cardId, trailer) : this.o.workspaces.landOnMain(cardId, row.branch!, trailer));
    if ('code' in result && !result.worker) {
      // the worker hears it with its next step, so it does not tell the owner the card still waits for their approval as if nothing had happened
      const text = `${NOT_LANDED} ${result.detail}\n\nThat is not in your work: the owner sees on the card what to do, and the card waits for their approval again.`;
      this.o.board.work(cardId, { approved_at: null, unheard: toJson([...this.unheardBut(cardId, NOT_LANDED), { said: [], text, images: [] }]) });
      throw new BadRequest(result.code, result.detail);
    }
    if ('code' in result) {
      this.o.board.work(cardId, { state: 'working', need: null, detail: null, approved_at: row.approved_at ?? new Date().toISOString() });
      this.o.board.log(cardId, 'error', 'obeya', result.detail, { code: result.code });
      this.deliver(
        cardId,
        [
          `The owner approved your work, but it could not land on main: ${result.detail}`,
          'The approval holds for what it takes to land the work: once you hand over again, Obeya lands it without asking the owner again, with the demo already on the card. A change to what the owner approved is theirs to decide.',
          ...(comments ? [comments.text] : []),
        ].join('\n\n'),
        comments?.images,
        by === 'owner',
      );
      return;
    }
    // an earlier approval that could not land is no news any more
    if (this.unheard(cardId).some((u) => u.text.startsWith(NOT_LANDED))) this.o.board.work(cardId, { unheard: toJson(this.unheardBut(cardId, NOT_LANDED)) });
    this.o.board.planDocsLanded(cardId, added);
    this.bump(cardId);
    const restartFor = (await this.o.restartsFor?.(result, direct ? (row.workspace ?? undefined) : undefined)) ?? false;
    const restarts = !!restartFor;
    const page = this.pageNote(cardId);
    this.o.board.work(cardId, {
      state: 'live',
      need: null,
      detail: null,
      status_line: null,
      approved_at: null,
      landed: toJson({ commit: result.to, ...(restarts ? { restarts } : {}), ...(page.waits ? { page: true } : {}) }),
      shipped: toJson({ commit: result.to, base: result.from }),
    });
    const t = this.o.board.t.worker;
    if (direct) this.o.board.log(cardId, 'state', by, by === 'owner' ? t.approvedDirect : t.landedDirect);
    else this.o.board.log(cardId, 'state', by, by === 'owner' ? t.approvedMain : t.landedMain);
    const sw = result.switched;
    if (sw) this.o.board.log(cardId, 'state', 'obeya', t.switchedToMain(sw.branch, sw.commit));
    if (direct) this.o.onMerged?.(cardId);
    else this.reviews.reprobeClashes();
    this.o.onLanded?.(cardId);
    this.afterLanding(
      cardId,
      [
        direct
          ? `${by === 'owner' ? 'The owner approved your work to go directly onto main, and Obeya' : 'Obeya'} pushed it there without a pull request (${result.to.slice(0, 7)}); the card is live.`
          : `${by === 'owner' ? 'The owner approved your work, and it' : 'Your work'} is on main now (${result.to.slice(0, 7)}); the card is live.`,
        sw
          ? `The Obeya checkout was on ${sw.branch ? `the branch ${sw.branch}` : `a detached HEAD at ${sw.commit}`}, not on main: Obeya switched it to main to land your work.` +
            (sw.commits
              ? ` ${sw.branch ?? sw.commit} has ${sw.commits === 1 ? 'a commit' : `${sw.commits} commits`} main does not: if ${sw.commits === 1 ? 'it is' : 'they are'} work of yours, made there instead of in your workspace, ${sw.commits === 1 ? 'it' : 'they'} did not land with it; tell the owner.`
              : '')
          : '',
        restartFor === 'obeya'
          ? `Obeya runs from that checkout and starts again with your change as soon as no worker is in the middle of a turn, which stops whatever you run then. ${AFTER_RESTART}`
          : restartFor === 'repo'
            ? `Your change moves where this repository's agents work: Obeya restarts them with it as soon as none of them is in the middle of a turn, you among them, which stops whatever you run then. ${AFTER_RESTART}`
            : '',
        page.text,
        comments?.text ?? '',
        AFTER_LANDING,
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      by === 'owner',
    );
  }

  /**
   * Approved work that changed nothing in the repository: nothing lands, and the card is `done`.
   * Its worker hears so and may finish what remains, as after a landing. Returns what it hears of
   * its demo's page.
   */
  private close(cardId: string, by: 'owner' | 'worker', comments?: Comments): string {
    // a demo, an analysis: what the approval was for goes public as any approved demo
    if (by === 'owner') this.o.onApproval?.(cardId);
    this.bump(cardId);
    const page = this.pageNote(cardId);
    this.o.board.work(cardId, { state: 'done', need: null, detail: null, status_line: null, approved_at: null, pr: null, landed: toJson({ unchanged: true, ...(page.waits ? { page: true } : {}) }) });
    const t = this.o.board.t.worker;
    const folder = !!this.folder?.changed(cardId).length;
    // what it changed in the folder stays: nothing of it is undone any more
    this.folder?.done(cardId);
    this.o.board.log(cardId, 'state', by, by === 'owner' ? (folder ? t.approvedFolder : t.approvedUnchanged) : t.doneUnchanged);
    // the worker that closed it is told by the tool's result, and its turn's end finishes it (unless it waits for its demo's page)
    if (by === 'owner')
      this.afterLanding(
        cardId,
        [
          folder ? 'The owner approved your work. Your changes stay in the folder as they are, and the card is done: they can no longer be undone from the card.' : 'The owner approved your work. It changed nothing in the repository, so nothing lands and there is no pull request: the card is done.',
          page.text,
          comments?.text ?? '',
          this.folder ? AFTER_DONE : AFTER_LANDING,
        ]
          .filter(Boolean)
          .join('\n\n'),
        comments?.images,
        true,
      );
    return page.text;
  }

  /**
   * What the worker of work that landed (or closed) hears about its demo's page, which it links
   * wherever it points people at the work (an issue it closes, say), and whether it waits for that
   * page to go out: Obeya tells it the address once the page is online (`pageSettled`). Without a
   * page, it hears so, and asks the owner rather than leave the link out.
   */
  private pageNote(cardId: string): { text: string; waits?: boolean } {
    const card = this.card(cardId);
    if (!card.demo || card.prototypeOf) return { text: '' };
    this.pageHeard(cardId);
    const ask = 'Before you point anyone to your demo (an issue you close, say), ask the owner for a link.';
    if (!this.shares) return { text: `This repository has no demo site, so your demo is on no page the team can open. ${ask}` };
    const s = card.share;
    if (s?.state === 'publishing')
      return { text: 'Your demo is going out on a page of its own for the team right now. Obeya tells you its address once it is online: wait for that before you link the demo anywhere (an issue you close, say).', waits: true };
    if (s?.state === 'shared' && s.url)
      return {
        text: s.stale
          ? `Your demo's page for the team shows an earlier demo of yours, not the latest: ${s.url}. Link it wherever you point people at this work (an issue you close, say), or ask the owner to share the latest first.`
          : `Your demo is shared with the team on a page of its own: ${s.url}. Link it wherever you point people at this work (an issue you close, say).`,
      };
    return { text: `Your demo is not shared on a page the team can open. ${ask}` };
  }

  /**
   * The card's demo page went out (`url`), or did not (`why`): landed work's worker that waits for
   * it hears so, and its session ends once it has done what that leads to.
   */
  pageSettled(cardId: string, r?: { url: string } | { why: string }) {
    if (!this.o.board.card(cardId)) return;
    const l = fromJson(this.o.board.row(cardId).landed);
    if (!l?.page) return;
    const { page: _, ...rest } = l;
    this.o.board.work(cardId, { landed: toJson(rest) });
    if (r) this.pageHeard(cardId);
    this.deliver(
      cardId,
      !r
        ? this.pageNote(cardId).text
        : 'url' in r
          ? `Your demo is online on a page of its own for the team: ${r.url}. Link it wherever you point people at this work (an issue you close, say).`
          : `Your demo's page did not go out (${r.why}); the owner sees why on the card. Before you point anyone to your demo (an issue you close, say), ask the owner for a link.`,
    );
  }

  /**
   * What became of the card's demo page since its worker last heard of it: the owner shared it or
   * stopped sharing it, a share went online or failed. The worker hears it with its next message or
   * tool step (no turn of its own: nothing waits on it), so it knows where its demo is when the
   * owner asks, and where Obeya links it once the work lands.
   */
  private pageNews(cardId: string): string | undefined {
    const card = this.o.board.item(cardId);
    if (!card || card.prototypeOf || !card.demo) return;
    const now = pageHeardOf(card.share);
    const row = this.o.board.row(cardId);
    const before: PageHeard = fromJson(row.page_heard) ?? { page: 'none' };
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    this.o.board.work(cardId, { page_heard: toJson(now) });
    if (now.page === 'going') return 'The owner is sharing your demo with the team on a page of its own; it is going online right now. You hear its address once it is there.';
    if (now.page === 'online') {
      const trailer = card.demo.kind === 'html' ? 'Demo-Page' : 'Demo-Video';
      return [
        `The owner shared your demo with the team on a page of its own: ${now.url}.`,
        now.stale ? 'It shows an earlier demo of yours, not the latest.' : '',
        fromJson(row.contribution)
          ? 'Once the owner approves, Obeya comments its link on the pull request.'
          : `Obeya links it in what your work lands with: a \`${trailer}: <url>\` trailer on the commit that lands on main, or a line in the pull request's description.`,
        'Link it wherever you point people at this work (an issue you close, say).',
      ]
        .filter(Boolean)
        .join(' ');
    }
    if (before.page === 'going' && !card.share?.url) return 'Sharing your demo did not work (the owner sees why on the card): it is on no page the team can open.';
    return 'The owner stopped sharing your demo: it is on no page the team can open any more.';
  }

  /** The worker has just heard where its demo's page stands (the landing's message, say): no news of it follows. */
  private pageHeard(cardId: string) {
    const card = this.o.board.item(cardId);
    if (card) this.o.board.work(cardId, { page_heard: toJson(pageHeardOf(card.share)) });
  }

  /** A message that starts a turn, with what became of the demo's page before it. */
  private withPageNews(cardId: string, text: string): string {
    const news = this.pageNews(cardId);
    return news ? [news, text].filter(Boolean).join('\n\n') : text;
  }

  /**
   * Landed work's worker hears about it and may finish what remains (a migration, say) in its
   * workspace, which stays until then. Without a session to tell, the workspace goes at once.
   */
  private afterLanding(cardId: string, message: string, images: string[] = [], owner = false) {
    const row = this.o.board.row(cardId);
    if (!row.workspace || (!this.live.has(cardId) && !row.session_id)) return this.finish(cardId);
    this.deliver(cardId, message, images, owner);
  }

  /** Landed work's worker is done: its session ends and its workspace is freed. */
  private finish(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    const row = this.o.board.row(cardId);
    const worktree = this.inWorktree(cardId);
    // the plan docs its branch adds are read before its workspace goes
    const reading = this.reading.get(cardId);
    if (worktree) {
      if (reading) void reading.finally(() => this.removeTree(row.workspace));
      else this.removeTree(row.workspace);
    } else if (row.workspace) {
      const removeLanded = () => this.o.workspaces.removeLanded(cardId, row.branch ?? '');
      // the card is done either way; a leftover worktree does no harm
      this.whileFreeing(cardId, row.workspace, reading ? reading.catch(() => {}).then(removeLanded) : removeLanded(), 'freeing a landed workspace');
    }
    const landed = fromJson(row.landed);
    this.o.board.work(cardId, finishedRow(row));
    this.o.board.workDone(cardId);
    // the work retrospective read the card's runs when its work ended
    if (!landed?.followUp) this.o.onWorkEnded?.(cardId, row.workspace);
  }

  /**
   * Why the plan doc an idea's card writes does not say clearly which of the idea's prototypes the
   * project builds on (`prototypeBuild`), as the worker reads it at its handover; undefined where it
   * does, or the card writes no plan doc for an idea with prototypes.
   */
  private prototypesUnclear(cardId: string): Promise<string | undefined> | undefined {
    const row = this.o.board.row(cardId);
    const prototypes = this.o.board.items().filter((i) => i.prototypeOf === cardId);
    if (!row.becomes_project || !row.idea || !prototypes.length) return undefined;
    return this.planDocsWritten(cardId).then((docs) => {
      const workstreams = docs.flatMap((d) => {
        const doc = parsePlanDoc(d.file, d.markdown);
        return 'workstreams' in doc ? doc.workstreams.filter((w) => !w.done) : [];
      });
      const build = prototypeBuild(workstreams, prototypes);
      const label = (ws: typeof workstreams) => ws.map((w) => w.label ?? `“${w.title}”`).join(', ');
      if ('none' in build || ('also' in build && !build.also.length)) return undefined;
      const what =
        'also' in build
          ? `the workstreams ${label([build.workstream, ...build.also])} each name or mention a prototype`
          : { several: `the workstreams ${label(build.workstreams)} each name or mention a prototype`, many: `the workstream ${label(build.workstreams)} names several prototypes`, unnamed: `the workstream ${label(build.workstreams)} mentions a prototype without naming which` }[build.unclear];
      return `Not handed over: in your plan doc, ${what}. Once the project stands, Obeya gives the chosen prototype's branch to the one workstream that names it by its name in quotes (${prototypes.map((p) => `“${prototypeName(p)}”`).join(', ')}), and discards the other prototypes; no other workstream names or mentions a prototype, and where the plan builds on none, none mentions one. If it is not clear which prototype the plan builds on, ask the owner. Then call ready_for_review again.`;
    });
  }

  /** The plan docs the card writes, as its branch holds them now (or the folder outside the repository). */
  private async planDocsWritten(cardId: string): Promise<{ file: string; markdown: string }[]> {
    const row = this.o.board.row(cardId);
    const { dir, exclude } = this.o.adapter.planDocs;
    const outside = outsidePlanDir(dir);
    const files = outside
      ? (fromJson(row.plan_docs) ?? []).map(pathOfRef)
      : (await this.o.workspaces.addedFiles(cardId, dir)).filter((f) => f.endsWith('.md') && !exclude.some((x) => f.endsWith(`/${x}`)));
    const read = async (file: string): Promise<string | null> => {
      if (outside) return Bun.file(file).text().catch(() => null);
      const at = await this.o.workspaces.fileOf(cardId, file, row.branch ?? undefined);
      return at && ('path' in at ? Bun.file(at.path).text() : new TextDecoder().decode(at.data));
    };
    const docs = await Promise.all(files.map(async (file) => ({ file, markdown: await read(file) })));
    return docs.flatMap((d) => (d.markdown === null ? [] : [{ file: d.file, markdown: d.markdown }]));
  }

  /** The plan docs the card's branch adds, as plan references of the canvas. */
  private async planDocsAdded(cardId: string): Promise<string[]> {
    // a plan folder outside the repository has nothing in the branch: such a card named its doc when it started
    if (!this.o.board.row(cardId).idea || outsidePlanDir(this.o.adapter.planDocs.dir)) return [];
    const home = !this.o.repo || this.o.repo === this.o.board.home;
    return (await this.o.workspaces.addedFiles(cardId, this.o.adapter.planDocs.dir))
      .filter((f) => f.endsWith('.md') && !this.o.adapter.planDocs.exclude.some((x) => f.endsWith(`/${x}`)))
      .map((f) => (home ? f : `${this.o.repo}:${f}`));
  }

  /**
   * A prototype has served its purpose, whatever its state: its worker stops and the card goes into
   * the archive with its log, demo and summary. Discarded, its workspace and branch are thrown away;
   * built, they went to its idea, or the workstream `into`, before (`buildOn`). Git cleans the
   * workspace in the background; it is free once git is done.
   */
  endPrototype(cardId: string, end: 'discarded' | 'built', by: 'owner' | 'obeya' = 'owner', into?: string) {
    const card = this.card(cardId);
    if (!card.prototypeOf) throw new BadRequest('notPrototype', 'not a prototype');
    this.o.onWorkEnded?.(cardId, this.o.board.row(cardId).workspace);
    this.end(cardId);
    this.bump(cardId);
    this.o.board.work(cardId, { paused: null, pausing: null, snoozed: null });
    const workspace = this.o.workspaces.leasedBy(cardId);
    const { branch } = this.o.board.row(cardId);
    // the card goes anyway, its workspace once git has cleaned it; a leftover worktree does no harm
    if (workspace) this.whileFreeing(cardId, workspace, this.o.workspaces.discard(cardId, branch ?? ''), 'discarding a prototype');
    const idea = this.o.board.card(card.prototypeOf);
    const t = this.o.board.t.worker;
    this.o.board.log(cardId, 'state', by, end === 'discarded' ? t.prototypeDiscarded : into ? t.prototypeBuiltInto(into) : t.prototypeBuilt(idea?.title ?? ''));
    this.o.board.endPrototype(cardId, end, into);
    if (end === 'discarded' && this.o.board.item(card.prototypeOf)) this.o.board.log(card.prototypeOf, 'state', by, t.prototypeDiscardedOnIdea(card.title));
  }

  /**
   * The idea, or the workstream `into` names of the project it became (as its plan doc says, `by`
   * Obeya), is built on this prototype: its workspace and branch (renamed for that card) go to the
   * card, which names them before the prototype ends as built (a lease its card does not name is
   * freed). Settles with the workspace and branch the card has now, once git has renamed the branch.
   */
  buildOn(prototypeId: string, idea: Item, into?: string, by: 'owner' | 'obeya' = 'owner'): Promise<{ path: string; branch: string }> {
    const { workspace, branch } = this.o.board.row(prototypeId);
    if (!workspace || !branch) throw new BadRequest('noWorkspace', 'the prototype has no workspace to build on');
    const built = asBadRequestAsync(this.o.workspaces.transfer(prototypeId, idea.id, branch, branchName(idea.title, idea.id))).then((moved) => {
      this.o.board.work(idea.id, { workspace: moved.path, branch: moved.branch, built_on: prototypeId });
      this.endPrototype(prototypeId, 'built', by, into);
      return moved;
    });
    // until the card names the workspace, its lease is not settled, and a restart waits for git
    this.whileFreeing(prototypeId, workspace, built, 'building on a prototype');
    return built;
  }

  /**
   * What the card's work changes: once it landed, what the landing put on the default branch;
   * before, its branch in its workspace so far. Null when neither is there to read.
   */
  async diff(cardId: string, full: boolean): Promise<CardDiff | null> {
    const landed = landedAt(this.o.board.row(cardId));
    // landed work's workspace, while its worker finishes, has nothing left against the default branch
    const diff = landed ? await this.o.workspaces.landedDiff(landed.base, landed.commit, full) : await this.o.workspaces.diff(cardId, full);
    // its size, for the page to lay out the card's change list before it has read the change
    const size = diff && toJson<ChangeSize>(changeSize(diff));
    try {
      if (size && size !== this.o.board.row(cardId).change_size) this.o.board.work(cardId, { change_size: size });
    } catch {
      // the card went while its change was read
    }
    return diff;
  }

  /** The files of the card's change as they are now, as `diff` reads it, by a list no file name can pass for another in (`CardWorkspaces.changedFiles`). */
  changedFiles(cardId: string): Promise<string[]> {
    const landed = landedAt(this.o.board.row(cardId));
    return landed ? this.o.workspaces.changedFiles(cardId, landed) : this.o.workspaces.changedFiles(cardId);
  }

  /**
   * A file of the card's work, as its left column shows it: only one its change made or changed
   * (`changedFiles`), or an image a Markdown file of it shows from beside it, never any other file
   * of the workspace or the folder, nor a link standing for one. From its workspace (or the folder)
   * while it has one here, else from the commit it landed with or its branch. `local`: a file on
   * disk to open, for a landed card the checkout's copy. Null where it is none of those, or nothing
   * holds it.
   */
  async file(cardId: string, asked: string, local = false): Promise<FileAt | null> {
    const path = normalPath(asked);
    if (!path) return null;
    const row = this.o.board.row(cardId);
    const shipped = fromJson(row.shipped);
    const landed = row.state === 'live' && shipped?.commit ? shipped.commit : undefined;
    // to open: the checkout's copy only of what landed there, never for a branch elsewhere
    const ref = landed ?? (local ? undefined : (row.branch ?? undefined));
    const changed = await this.changedFiles(cardId);
    const at = (p: string, onDisk = local) => this.o.workspaces.fileOf(cardId, p, ref, onDisk);
    if (changed.includes(path)) return at(path);
    if (!isImage(path)) return null;
    for (const doc of changed.filter((p) => fileKind(p) === 'markdown')) {
      const md = await at(doc, false);
      const text = md && ('path' in md ? await Bun.file(md.path).text() : new TextDecoder().decode(md.data));
      if (text && docImages(doc, text).includes(path)) return at(path);
    }
    return null;
  }

  /**
   * The files a worker names as its result at its handover, as paths of its change relative to the
   * workspace (or folder), and what the worker hears of those it named outside its change, which
   * are left out: refusing the handover for them held back the rest of it, also from a worker that
   * never read the refusal (Codex's code mode drops a result its script does not print).
   * `named` is undefined where none of them is of the change, so that earlier ones stand.
   */
  private async namedFiles(cardId: string, files: { path: string; caption: string }[]): Promise<{ named?: CardFile[]; left?: string }> {
    const ws = (this.o.board.row(cardId).workspace ?? '').replace(/^ssh:\/\/[^/]+/, '');
    const roots = [ws, ...(ws && !hostName(this.o.board.row(cardId).workspace) ? [realPath(ws)] : [])].filter(Boolean);
    const changed = await this.changedFiles(cardId);
    const out: CardFile[] = [];
    const outside: string[] = [];
    for (const f of files) {
      let given = String(f.path).trim();
      // a path of the workspace, with backslashes where it is one of Windows
      const root = roots.find((r) => given.startsWith(r) && /^[\\/]/.test(given.slice(r.length)));
      if (root) given = given.slice(root.length + 1);
      const path = isAbsolute(given) ? null : normalPath(given);
      if (!path || !changed.includes(path)) outside.push(String(f.path));
      else if (!out.some((o) => o.path === path)) out.push({ path, caption: clip(oneLine(String(f.caption ?? '')), 200) });
    }
    if (!outside.length) return { named: out };
    const list = changed.length ? `(${changed.slice(0, 30).join(', ')}${changed.length > 30 ? ', …' : ''})` : '(none)';
    const left = `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among the files your card made or changed ${list}, so the card does not show ${outside.length === 1 ? 'it' : 'them'}.`;
    return { named: out.length ? out : files.length ? undefined : out, left };
  }

  /**
   * The card's pull request was merged, with `commit` the merge put on the base branch where GitHub
   * said: the work is live, the workspace free.
   */
  merged(cardId: string, commit?: string, note = this.o.board.t.worker.merged, comments?: Comments) {
    this.bump(cardId);
    this.refuseAsked(cardId, 'meanwhile your pull request was merged, and the card is live.');
    // a review card's PR where work lands on the local main: the checkout gets the merge, as the owner would pull it
    if (fromJson(this.o.board.row(cardId).contribution) && this.reviews.pulls()) void this.reviews.pullAfterMerge(cardId);
    // git reads them without blocking the server; the workspace goes only once it has (`finish`)
    const added = this.planDocsAdded(cardId).then((a) => this.o.board.planDocsLanded(cardId, a));
    this.reading.set(cardId, added);
    void added.finally(() => this.reading.get(cardId) === added && this.reading.delete(cardId));
    const { url, number } = fromJson(this.o.board.row(cardId).pr) ?? { url: null, number: undefined };
    const shipped: Shipped = { ...(commit ? { commit, base: `${commit}^` } : { fetch: true }), ...(url && number ? { pr: { url, number } } : {}) };
    const page = this.pageNote(cardId);
    this.o.board.work(cardId, {
      state: 'live',
      need: null,
      detail: null,
      status_line: null,
      approved_at: null,
      landed: toJson({ ...(commit ? { commit } : {}), ...(page.waits ? { page: true } : {}) }),
      shipped: toJson(shipped),
    });
    this.o.board.log(cardId, 'state', 'obeya', note);
    this.o.onMerged?.(cardId);
    const review = !!fromJson(this.o.board.row(cardId).contribution);
    this.afterLanding(
      cardId,
      [review ? 'The owner approved your handover, and Obeya merged the pull request; the card is live. Leave the PR as it is: Obeya comments the demo’s link on it.' : 'Your pull request was merged; the card is live.', page.text, comments?.text ?? '', AFTER_LANDING].filter(Boolean).join('\n\n'),
      comments?.images,
      !!comments,
    );
  }

  /** "Push only" on a review card (`ReviewCards.pushContribution`). */
  pushContribution(cardId: string) {
    return this.reviews.pushContribution(cardId);
  }

  /** The owner's own wording of the text that goes onto the PR with the worker's held changes (`ReviewCards.editHeld`). */
  editHeld(cardId: string, body: unknown) {
    this.reviews.editHeld(cardId, body);
  }

  /** A review card's pull request was closed without a merge (`ReviewCards.contributionClosed`). */
  contributionClosed(cardId: string, comments: string[] = []) {
    this.reviews.contributionClosed(cardId, comments);
  }

  /** The contributor answered while the review card waited for them, or pushed (`ReviewCards.contributorAnswered`). */
  contributorAnswered(cardId: string, note: string, message: string) {
    this.reviews.contributorAnswered(cardId, note, message);
  }

  /** "Push main, adapt the PR" on a review card (`ReviewCards.pushMainFor`). */
  pushMainFor(cardId: string) {
    this.reviews.pushMainFor(cardId);
  }

  /** The owner takes back "Push main" within its undo window (`ReviewCards.keepMainFor`). */
  keepMainFor(cardId: string) {
    this.reviews.keepMainFor(cardId);
  }

  /** A review card waiting for the owner looks again at whether its PR collides with the local main (`ReviewCards.recheckClash`). */
  recheckClash(cardId: string) {
    this.reviews.recheckClash(cardId);
  }

  /** Passes what happened on the pull request to the worker; the owner's log gets `note`. */
  prEvent(cardId: string, note: string, message: string) {
    this.o.board.log(cardId, 'state', 'obeya', note);
    this.deliver(cardId, message);
  }

  /** The pull request was closed without a merge: the owner decides what happens. */
  prClosed(cardId: string) {
    const t = this.o.board.t.worker;
    this.o.board.log(cardId, 'state', 'obeya', t.prClosed);
    this.toOwner(cardId, {
      text: t.prClosedQuestion,
      options: [t.reopen, t.discardWork],
    });
  }

  /**
   * The owner stops the card's worker: the card is planned again at once. Its workspace stays with
   * it where it holds work, so that starting again goes on from there, and is given back otherwise
   * once git has told (`hasWork`, without blocking the server), unless the card started again meanwhile.
   */
  stop(cardId: string): Promise<void> {
    const card = this.card(cardId);
    if (card.finishing) {
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.stopped);
      this.finish(cardId);
      return Promise.resolve();
    }
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('noAgent', 'no agent works on this card');
    return this.planAgain(cardId, () => this.o.board.log(cardId, 'state', 'owner', card.pr ? this.o.board.t.worker.stoppedPrOpen(card.pr.number) : this.o.board.t.worker.stopped));
  }

  /**
   * The card is planned again, its worker ended (`stop`), after `said` logged why. Its workspace
   * stays with it where it holds work, and is given back otherwise once git has told.
   */
  private planAgain(cardId: string, said: () => void): Promise<void> {
    // comments held back for the worker stay in the conversation
    this.takeHeld(cardId);
    this.end(cardId);
    this.bump(cardId);
    const generation = this.generation.get(cardId);
    const path = this.o.board.row(cardId).workspace;
    this.o.board.work(cardId, PLANNED_AGAIN);
    said();
    return this.o.workspaces.hasWork(cardId).then((keep) => {
      if (keep || this.generation.get(cardId) !== generation || this.o.board.row(cardId).workspace !== path) return;
      this.o.workspaces.release(cardId);
      this.o.board.work(cardId, { workspace: null });
    });
  }

  /**
   * Whether the owner may take the card's workspace from it for another card (`evict`): a clone it
   * holds while at work, waiting for the owner, or stopped with work in it; not once its work has
   * landed, nor a prototype's.
   */
  evictable(cardId: string): boolean {
    if (this.o.workspaces.mode !== 'clones' || this.evicting.has(cardId)) return false;
    // from the row: the pools the board's snapshot shows ask for each card
    let row: CardRow;
    try {
      row = this.o.board.row(cardId);
    } catch {
      return false;
    }
    const state = row.state ?? 'planned';
    return !!row.workspace && !row.landed && !row.prototype_of && (state === 'working' || state === 'waiting' || state === 'planned');
  }

  /**
   * The owner takes the card's clone from it for a card waiting for one: its worker stops as with
   * `stop` (the card planned), the app there stops (`app.stop`, whatever `app.keep` says: another
   * card works there next), and its uncommitted work goes into a commit on its branch, which stays in
   * that clone (`kept_in`) until the card's next start takes it to the clone it gets then, the work
   * uncommitted again (`Workspaces.evict`). Settles once the clone is free, with whether the card's
   * worker was on it (the Coordinator queues it again then); where git fails, the card keeps the
   * clone, as a stopped card with work does.
   */
  async evict(cardId: string): Promise<boolean> {
    if (!this.evictable(cardId)) throw new BadRequest('notEvictable', 'the card holds no clone that can be taken from it');
    const card = this.card(cardId);
    const active = card.state !== 'planned';
    const path = this.o.board.row(cardId).workspace!;
    this.evicting.add(cardId);
    try {
      // its session ends before git keeps its work, and a stop still asking git (`stop`) gives nothing back afterwards
      const session = this.live.get(cardId)?.session;
      if (active) {
        // comments held back for the worker stay in the conversation
        this.takeHeld(cardId);
        this.end(cardId);
        this.o.board.work(cardId, PLANNED_AGAIN);
      }
      this.bump(cardId);
      this.o.board.work(cardId, { status_line: this.o.board.t.worker.evicting });
      await within(session?.done.catch(() => {}) ?? Promise.resolve(), EVICT_SESSION_WAIT);
      // parking the app may be under way already: it is through before the clone changes hands
      await this.apps.stopping.get(cardId)?.catch(() => {});
      const stop = this.o.adapter.app?.stop;
      if (stop) {
        const result = await runAppCommand(path, stop);
        if (!result.ok) this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.parkFailed(clip(result.output, 600)));
      }
      let kept: string | null;
      try {
        kept = await this.o.workspaces.evict(cardId);
      } catch (e) {
        this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.evictFailed(messageOf(e)));
        return false;
      }
      // deleted meanwhile: its row stays, to be restored without the clone
      this.o.board.work(cardId, { workspace: null, parked: null, app: null, ...(kept ? { kept_in: kept } : {}) });
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.evicted(path));
      return active;
    } finally {
      this.evicting.delete(cardId);
      if (this.o.board.row(cardId).status_line === this.o.board.t.worker.evicting) this.o.board.work(cardId, { status_line: null });
    }
  }

  /**
   * The owner pauses the card's worker while it is in a turn: its session ends at once, in the
   * middle of a step if need be, and whatever it ran with it (background work included). Card,
   * state, workspace, branch and session stay; the slot it held is free. It goes on where it stopped
   * once the owner resumes it or writes to it (`deliver`); what Obeya has for it meanwhile waits
   * until then, and its app is parked like a waiting card's. A worker taking in the owner's
   * words on its handover is paused the same way: the card still waits for approval, and the
   * worker finishes taking them in once it goes on.
   */
  pause(cardId: string) {
    const card = this.card(cardId);
    if (!pausableNow(card)) throw pauseRefused(card, true);
    this.halt(cardId);
  }

  /**
   * The owner pauses the card's worker at a safe point (the card's pause, the canvas's): it hears so
   * and ends its turn once the step it is in is done, as for a restart, and is paused then as on
   * `pause`. Should it not have ended its turn after a while, it is paused at once. One with nothing
   * running that could be cut off midway (its workspace is being made ready, it waits for the usage
   * limit) is paused at once.
   */
  pauseAtSafePoint(cardId: string) {
    const card = this.card(cardId);
    if (!pausable(card)) throw pauseRefused(card, false);
    const live = this.live.get(cardId);
    if (!live?.busy || live.limited) return this.halt(cardId);
    const limit = this.o.pauseLimit ?? PAUSE_LIMIT;
    this.o.board.pausing(cardId);
    live.session.send(pauseNotice(limit));
    clearTimeout(this.pausing.get(cardId));
    this.pausing.set(
      cardId,
      setTimeout(() => {
        this.pausing.delete(cardId);
        if (this.o.board.item(cardId)?.pausing) this.halt(cardId);
      }, limit),
    );
  }

  /**
   * Pauses the card's worker: its session ends at once with whatever it ran, and the message it had
   * not taken in yet goes to it with the rest once it goes on.
   */
  private halt(cardId: string) {
    const pending = this.live.get(cardId)?.pending;
    this.end(cardId);
    this.bump(cardId);
    clearTimeout(this.reconnecting.get(cardId));
    this.reconnecting.delete(cardId);
    clearTimeout(this.pausing.get(cardId));
    this.pausing.delete(cardId);
    this.o.board.paused(cardId, pending ? { held: [pending] } : {});
    this.apps.parkLater(cardId);
  }

  /**
   * The worker ended its turn while the owner waited for it to pause at a safe point: it is paused
   * now. What its turn did stands: words for the owner on its handover answer theirs, and work the
   * owner approved already lands once handed over.
   */
  private pausedAtSafePoint(cardId: string, card: Item, approved: boolean, handedOver: boolean, spoke: boolean) {
    if (answering(card) && (handedOver || spoke)) this.answerTaken(cardId, spoke);
    this.halt(cardId);
    if (handedOver && card.state === 'working' && approved) void this.landApproved(cardId);
  }

  /**
   * The owner lets the paused worker go on, whatever the card's state; it hears what came for it
   * meanwhile. One about to pause at a safe point hears that it works on instead.
   */
  resume(cardId: string) {
    const card = this.card(cardId);
    if (card.pausing) {
      this.pauseTakenBack(cardId);
      this.live.get(cardId)?.session.send(PAUSE_TAKEN_BACK);
      return;
    }
    if (!card.paused) throw notPaused();
    this.deliver(cardId, '', [], true);
  }

  /** The owner lets the worker about to pause at a safe point go on after all (`resume`, or their words to it). */
  private pauseTakenBack(cardId: string) {
    clearTimeout(this.pausing.get(cardId));
    this.pausing.delete(cardId);
    this.o.board.pauseTakenBack(cardId);
    const live = this.live.get(cardId);
    if (live) live.pauseHeld = false;
  }

  /**
   * A scratch Obeya's idle workers (`--idle-workers`): a script acts as the card's agent
   * (`scripts/scratch-obeya.ts --say`), for a check of what the owner sees while one works. Its
   * words go into the conversation as an agent's text does, and its tools (report, reply, ask,
   * ready_for_review, …) run as the agent's do, through the same code; no turn starts or ends by
   * itself, `end` ends the one under way as the agent would. A card without a session (one staged at
   * work) gets a stand-in for it. Returns what the agent would have read as the tool's result.
   */
  async standIn(cardId: string, act: { say: string } | { tool: string; args?: Record<string, unknown> } | { end: true }): Promise<string> {
    const card = this.card(cardId);
    const live = this.live.get(cardId);
    // the agent ends its turn, as an idle worker never does by itself
    if ('end' in act) {
      if (live) this.onEvent(cardId, live, { type: 'idle' });
      return 'Turn ended.';
    }
    if ('say' in act) {
      const text = String(act.say).trim();
      if (!text) throw new BadRequest('emptyText', 'say must be a non-empty string');
      if (live) this.onEvent(cardId, live, { type: 'text', text });
      else this.o.board.log(cardId, 'say', 'worker', clip(text, 12000));
      return 'Shown on the card.';
    }
    const stand: Live = live ?? {
      session: undefined!,
      host: null,
      handedOver: false,
      acted: true,
      nudged: false,
      lastText: '',
      busy: false,
      background: 0,
      tasks: new Map(),
      stalled: false,
      preferences: '',
      standIn: true,
    };
    const tool = this.tools(cardId, stand, !!card.prototypeOf).find((t) => t.name === act.tool);
    if (!tool) throw new BadRequest('invalid', `the card's agent has no tool ${act.tool}`);
    // as the SDK checks a call against the tool's schema
    const args = z.object(tool.schema).safeParse(act.args ?? {});
    if (!args.success) throw new BadRequest('invalid', `${act.tool}: ${args.error.message}`);
    // a tool call is a step of the turn, as the agent's own calls are
    if (live) live.acted = true;
    return await tool.run(args.data);
  }

  /**
   * The card of the canvas a worker means by `title`, to wait on: the one by that title (the open
   * one, of several), else the one whose title holds it, if only one does; else why there is none.
   */
  private cardTitled(cardId: string, title: string): Item | string {
    const items = this.o.board.items().filter((i) => i.id !== cardId && i.kind !== 'project');
    const key = titleKey(title);
    const exact = items.filter((i) => titleKey(i.title) === key);
    const pick = (of: Item[]) => of.findLast((i) => !i.archivedAt && !finished(i.state)) ?? of.at(-1)!;
    if (exact.length) return pick(exact);
    const near = items.filter((i) => !i.archivedAt && !finished(i.state) && titleKey(i.title).includes(key));
    if (near.length === 1) return near[0]!;
    if (near.length > 1) return `several cards have “${title}” in their title (${near.map((i) => `“${i.title}”`).join(', ')}); give one's full title.`;
    return `no card on the canvas is called “${title}”.`;
  }

  /**
   * The owner snoozes the card's worker until `until` (ISO), whether it is in a turn or between
   * turns: as on a pause, its session ends at once and what Obeya has for it meanwhile waits; at the
   * time it goes on where it stopped. A worker snoozed already only gets the new time.
   */
  snooze(cardId: string, until: string) {
    const card = this.card(cardId);
    if (card.snoozed) return this.o.board.snooze(cardId, { ...card.snoozed, until, ...(card.snoozed.by === 'agent' ? { moved: true as const } : {}) }, 'owner');
    // a message the worker had not taken in yet goes to it with the rest, after what a pause held already
    const pending = this.live.get(cardId)?.pending;
    const held = this.pausedOf(cardId)?.held ?? [];
    this.end(cardId);
    this.bump(cardId);
    clearTimeout(this.reconnecting.get(cardId));
    this.reconnecting.delete(cardId);
    clearTimeout(this.pausing.get(cardId));
    this.pausing.delete(cardId);
    this.o.board.work(cardId, { paused: toJson({ held: [...held, ...(pending ? [pending] : [])] }), pausing: null });
    this.o.board.snooze(cardId, { until, by: 'owner' });
    this.apps.parkLater(cardId);
  }

  /** The snoozed worker wakes and goes on: at its time (`timeUp`), as the card it waits on got there or no longer can (`met`), or because the owner wakes it now. */
  wake(cardId: string, timeUp = false, met?: Awaited) {
    this.card(cardId);
    const s = this.o.board.snoozedOf(cardId);
    if (!s || s.waiting) throw new BadRequest('notSnoozed', 'the agent is not snoozed');
    this.deliver(cardId, '', [], true, [], timeUp, met);
  }

  /**
   * A planned card snoozed to start later starts now: at its time (`timeUp`), or because the owner
   * starts it earlier. Its worker hears with its task when the card was to start, so a task that
   * says "in two weeks" is read as due now.
   */
  startsNow(cardId: string, timeUp: boolean) {
    const s = this.o.board.unsnooze(cardId, timeUp ? 'time' : 'owner');
    if (s?.until) this.startsAt(cardId, s.until, s.by, timeUp);
  }

  /**
   * What the card's worker hears with its task: when the card was set to start (`by` its proposing
   * agent or the owner), and that the time has come (`due`) or the owner started it earlier.
   */
  startsAt(cardId: string, until: string, by: Snooze['by'], due: boolean) {
    const at = MESSAGES.en.at(Date.parse(until));
    const who = by === 'agent' ? 'The agent that proposed this card set it to start' : 'The owner set this card aside to start';
    const text = due ? `${who} at ${at}, and that time has come: what the task leaves for later is due now.` : `${who} at ${at}; the owner started it earlier, now.`;
    this.o.board.work(cardId, { unheard: toJson([...this.unheard(cardId), { said: [], text, images: [] }]) });
  }

  /** What the owner's pause holds for the worker, or null when it is not paused. */
  private pausedOf(cardId: string): PausedState | null {
    return fromJson(this.o.board.row(cardId).paused);
  }

  /** After a restart (`repo`: of this repository's agents alone): resume every card whose worker was in the middle of a turn. */
  resumeAll(repo = false) {
    const restarted = repo ? REPO_RESTARTED : RESTARTED;
    this.reviews.reprobeClashes();
    for (const i of this.o.board.items()) {
      if (this.o.repo && i.repo !== this.o.repo) continue;
      // the page reloaded: the owner may watch on, or have gone
      if (i.held?.length) this.releaseLater(i.id, this.o.holdGrace ?? HOLD_GRACE);
      const row = this.o.board.row(i.id);
      const landed = fromJson(row.landed);
      // a snoozed worker sleeps on until its time, a restart notwithstanding
      if (row.snoozed && !fromJson(row.snoozed).waiting) {
        // the owner's snooze holds what Obeya has for the worker, as a pause does
        if (row.paused) this.pausedOverRestart(i.id, landed);
        else {
          this.apps.parkLater(i.id);
          // a restart it waited for after the landing has happened: that wakes it
          if (landed?.restarts) {
            this.o.board.work(i.id, { landed: toJson(settled(landed)) });
            this.deliver(i.id, 'Obeya has started again and runs main with your change now.');
          }
        }
        continue;
      }
      // about to pause at a safe point, it paused for the restart: it stays paused (an idea's or
      // Question card's agent, which a restart of this repository's agents leaves running, pauses by itself)
      if (row.pausing && !row.paused && i.kind !== 'question' && i.state !== 'idea') this.o.board.paused(i.id);
      // the owner's pause holds across the restart
      if (row.paused || (row.pausing && i.kind !== 'question' && i.state !== 'idea')) {
        this.pausedOverRestart(i.id, landed);
        continue;
      }
      if (landed && row.workspace) {
        this.resumeLanded(i, landed, row.session_id, repo);
        continue;
      }
      // a worker taking in the owner's words on its handover was in the middle of a turn too
      if (answering(i)) {
        if (row.workspace && row.session_id) this.launch(i.id, restarted, row.session_id);
        else this.answerTaken(i.id);
        continue;
      }
      // a landing the restart cut off: the card waits for the owner's approval again
      if (i.landing) this.o.board.work(i.id, { approved_at: null });
      if (this.apps.waitsForOwner(i.id)) {
        this.apps.parkLater(i.id);
        continue;
      }
      if (i.state !== 'working' && i.state !== 'inPr') continue;
      if (!row.workspace) continue;
      if (row.session_id) this.launch(i.id, restarted, row.session_id);
      // it never reported a session: start one with the card
      else if (i.state === 'working') this.launch(i.id, this.brief.briefing(i, row.branch ?? '', true), undefined, this.brief.taskImages(i));
    }
    // what stood taken for good before the restart is freed now, not only at the next change
    this.settleLeases();
    void this.listFiles();
  }

  /**
   * A folder's cards handed over without a demo before Obeya kept which of them have files to show
   * (`files` empty), on the canvas or archived: those whose change still has some get the list.
   */
  private async listFiles() {
    if (!this.folder) return;
    const unlisted = (items: Item[]) => items.filter((i) => i.kind === 'task' && (!this.o.repo || i.repo === this.o.repo) && !i.files && !i.demo && i.state !== 'working');
    const list = async (cards: Item[]) => {
      for (const i of cards) {
        if (!this.o.board.events(i.id).some((e) => e.kind === 'review')) continue;
        if (!(await this.showsFiles(i.id))) continue;
        const row = this.o.board.row(i.id);
        if (!row.files && !row.demo) this.o.board.work(i.id, { files: '[]' });
      }
    };
    await list(unlisted(this.o.board.items()));
    // the archive a page at a time, the server answering between them
    for await (const page of this.o.board.archived.pages()) await list(unlisted(page));
  }

  /** Whether the card's change has files its left column shows (`shownFiles`), beside the ones its worker named. */
  private async showsFiles(cardId: string): Promise<boolean> {
    return shownFiles(await this.diff(cardId, false).catch(() => null)).length > 0;
  }

  /** Settles the leases once the change that called is through, not in the middle of it. */
  private settleLater() {
    if (this.settling) return;
    this.settling = true;
    queueMicrotask(() => {
      this.settling = false;
      this.settleLeases();
    });
  }

  /**
   * Frees the workspaces of cards that will not work in them again, which would otherwise stay
   * taken for good, a restart notwithstanding (`leaseEnded`): one its card no longer names or is done
   * with, a deleted card's, and a workstream's that no worker is on (stopped, say, and its work
   * merged by hand) once the plan doc on the default branch ticks it off or no longer has it. A
   * workstream still in its pull request then counts as merged, which its worker hears as from the
   * pull request's watcher: the doc says so, though the watcher may not see it.
   */
  private settleLeases() {
    if (this.folder) return;
    for (const { path, card_id: id } of this.o.workspaces.list()) {
      // a workspace being made ready is freed once git is done, and so is one git is freeing
      if (!id || this.kept.has(path) || this.preparing.has(id) || this.freeing.has(path)) continue;
      const ended = this.o.board.leaseEnded(id, path);
      if (!ended) continue;
      if (ended === 'archived') {
        this.whileFreeing(id, path, this.archivedLease(id, path), 'giving back the workspace of an archived card');
        continue;
      }
      if (ended === 'merged') {
        this.merged(id, undefined, this.o.board.t.worker.mergedTicked);
        continue;
      }
      const abandoned = this.o.workspaces.abandon(path).then(
        (freed) => {
          // a worktree with uncommitted changes stays, and is not looked at again until Obeya starts anew
          if (!freed) return void this.kept.add(path);
          // a deleted card brought back and started meanwhile works there again: its worktree is made anew
          if (!this.o.board.leaseEnded(id, path)) return;
          this.o.board.freed(id, path);
          if (ended === 'ticked') this.o.board.log(id, 'state', 'obeya', this.o.board.t.worker.tickedFreed);
          if (ended === 'gone') this.o.board.log(id, 'state', 'obeya', this.o.board.t.worker.goneFreed);
        },
        (e: unknown) => {
          console.error('freeing the workspace of a card done with it:', e);
          this.kept.add(path);
        },
      );
      this.whileFreeing(id, path, abandoned, 'freeing the workspace of a card done with it');
    }
  }

  /**
   * The archive took a stopped card with its workspace at `path` while its repository did not run on
   * the canvas; now that it runs, the workspace goes back to the pool. A clone goes as when the owner
   * takes it for another card (`Workspaces.evict`): the card's branch stays there, its uncommitted
   * work in a commit on it, for its next start; where git cannot reach it, the clone stays the card's.
   * A worktree takes nothing from the pool: it goes where it holds no work, and stays the card's
   * otherwise. The card does not start meanwhile (`evicting`), brought back onto the canvas or not.
   */
  private async archivedLease(cardId: string, path: string) {
    const still = () => this.o.board.leaseEnded(cardId, path) === 'archived';
    this.evicting.add(cardId);
    try {
      if (this.o.workspaces.mode === 'clones') {
        const kept = await this.o.workspaces.evict(cardId);
        if (!kept) return;
        // brought back and deleted meanwhile, the card keeps where its branch is, for its restore
        this.o.board.keptIn(cardId, kept);
        this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.archivedFreed(kept));
        return;
      }
      const work = await this.o.workspaces.hasWork(cardId);
      if (!still()) return;
      if (work) return void this.kept.add(path);
      this.o.workspaces.release(cardId);
      this.o.board.work(cardId, { workspace: null, parked: null, app: null });
    } catch (e) {
      this.kept.add(path);
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.evictFailed(messageOf(e)));
    } finally {
      this.evicting.delete(cardId);
    }
  }

  /**
   * Git frees the card's workspace at `path` in the background (`freeing`), or puts it back on the
   * branch of a restored card: the board changes once it is done, the pool having a workspace more
   * where it was freed. What goes wrong is logged under `what`.
   */
  private whileFreeing(cardId: string, path: string, done: Promise<unknown>, what: string) {
    const freeing: { card: string; done: Promise<void> } = { card: cardId, done: Promise.resolve() };
    freeing.done = done
      .then(() => {})
      .catch((e: unknown) => console.error(`${what}:`, e))
      .finally(() => {
        if (this.freeing.get(path) === freeing) this.freeing.delete(path);
        this.o.board.changed();
      });
    this.freeing.set(path, freeing);
  }

  /** Settles once the workspaces git is freeing now are free: for tests, as `prepared`. */
  async freed(): Promise<void> {
    while (this.freeing.size) await Promise.all([...this.freeing.values()].map((f) => f.done));
  }

  /**
   * A deleted card is restored: it takes back the workspace it had, where it can, on its own branch;
   * else its next start takes another, with its branch from that clone where it is still there.
   */
  restored(cardId: string) {
    const row = this.o.board.row(cardId);
    const path = row.workspace;
    if (!path) return;
    this.kept.delete(path);
    const retaken = row.branch ? this.o.workspaces.retake(cardId, path, row.branch) : null;
    if (!retaken) {
      // another card works in that clone now: the card's branch stays there, for its next start to take from it
      const taken = this.o.workspaces.mode === 'clones' && this.o.workspaces.list().some((w) => w.path === path && w.card_id);
      return void this.o.board.work(cardId, { workspace: null, app: null, parked: null, ...(taken ? { kept_in: path } : {}) });
    }
    this.o.board.changed();
    if (!retaken.ready) return;
    const back = retaken.ready.then(
      () => {},
      (e: unknown) => {
        if (this.o.board.row(cardId).workspace !== path) return;
        // the card's branch stays in that clone, unless it is gone, for the next start to take from it
        const kept = e instanceof BranchGone ? {} : { kept_in: path };
        // a start waiting for it puts the card back itself
        this.o.board.work(cardId, this.preparing.has(cardId) ? kept : { workspace: null, app: null, parked: null, ...kept });
      },
    );
    // deleted again meanwhile, the card gives it back once git is done
    this.whileFreeing(cardId, path, back, 'taking back the workspace of a restored card');
  }

  /** After a restart, a paused worker stays paused: a restart it waited for has happened, which it hears once it goes on. */
  private pausedOverRestart(cardId: string, l: LandedState | null) {
    this.apps.parkLater(cardId);
    if (!l?.restarts) return;
    this.o.board.work(cardId, { landed: toJson(settled(l)) });
    this.deliver(cardId, 'Obeya has started again and runs main with your change now.');
  }

  /** After a restart (`repo`: of this repository's agents alone): landed work's worker goes on with what remains; the restart it waited for has happened. */
  private resumeLanded(card: Item, l: LandedState, session: string | null, repo: boolean) {
    if (!session) return this.finish(card.id);
    this.o.board.work(card.id, { landed: toJson(settled(l)) });
    // an open question waits for its answer, which resumes the session
    if (card.state === 'waiting') return this.apps.parkLater(card.id);
    const restarted = repo ? REPO_RESTARTED : RESTARTED;
    this.launch(card.id, l.restarts ? `${repo ? 'Obeya runs' : 'Obeya has started again and runs'} main with your change now. ${restarted}` : restarted, session);
  }

  /** Settles once the workspaces git is making ready now are ready (or failed), their workers started: for a start begun elsewhere (the Coordinator, the owner's question). */
  async prepared(): Promise<void> {
    while (this.preparing.size) await Promise.all([...this.preparing.values()].map((p) => p.done));
  }

  /** The cards whose worker is in a turn, and those whose workspace is made ready for it, each holding a slot on its machine. */
  inTurn(): string[] {
    return [...new Set([...[...this.live].filter(([, l]) => l.busy).map(([id]) => id), ...this.preparing.keys()])];
  }

  /** The cards whose worker is in a turn, each with its background work that runs and whether the turn waits only for that work, and those whose worker paused for the restart that is due. */
  private turnsShown(): Map<string, WorkerTurn> {
    const turns = new Map<string, WorkerTurn>();
    for (const [id, l] of this.live) {
      if (l.busy) turns.set(id, { tasks: [...l.tasks.values()].map(({ description, since }) => ({ description, since })), over: !!l.waiting });
      else if (this.pausedForDue(l)) turns.set(id, { tasks: [], over: true, restart: true });
    }
    return turns;
  }

  /**
   * Whether the worker ended its turn for the restart that is due and waits for it: not while its
   * background work still runs, which the restart waits for in turn.
   */
  private pausedForDue(l: Live): boolean {
    return !!this.restart && !!l.restartPaused && !l.busy;
  }

  /** How many of these workers are in a turn on a machine (null: the one Obeya runs on). */
  busyOn(host: string | null): number {
    const on = (id: string) => {
      const live = this.live.get(id);
      if (live) return live.host;
      // a clone that turned out dirty gave way to one on another machine, perhaps
      const at = this.o.workspaces.leasedBy(id);
      return at ? hostName(at) : this.preparing.get(id)!.host;
    };
    return this.inTurn().filter((id) => on(id) === host).length;
  }

  /**
   * The cards whose worker is in the middle of a turn (or whose ended turn waits for its background
   * work), and those whose workspace is being made ready, freed or taken from them (`evict`) or whose work is landing or being
   * approved (a review card's push, comment and merge): a restart would cut off git, or the forge, midway.
   */
  busyCards(): string[] {
    return [...new Set([...this.inTurn(), ...this.landing, ...this.approving, ...[...this.freeing.values()].map((f) => f.card), ...this.evicting])];
  }

  /**
   * Obeya is about to restart (or no longer is): workers in the middle of a turn hear so and pause
   * at a safe point, and those that start a turn before the restart hear it with their message.
   */
  restartDue(due: DueRestart | null) {
    this.restart = due;
    if (!due) {
      // a card whose worker paused for it showed so while it was due
      const paused = [...this.live.values()].filter((l) => l.restartPaused);
      for (const live of paused) live.restartPaused = false;
      if (paused.length) this.o.board.changed();
      // a worker that paused for it goes on with the owner's words that waited meanwhile
      for (const cardId of this.live.keys()) if (!this.takesLater(cardId) && this.unheard(cardId).length) this.deliver(cardId, '');
      return;
    }
    for (const [cardId, live] of this.live) {
      if (!live.busy || live.toldRestart) continue;
      this.tellRestart(cardId, live);
      live.session.send(restartNotice(due));
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartDue(pauseOf(due)));
    }
  }

  shutdown() {
    // workers of a repository started afresh are its new ones: these settle no lease any more
    this.unwatch();
    this.shut = true;
    for (const id of [...this.live.keys()]) this.end(id);
    for (const timer of this.reconnecting.values()) clearTimeout(timer);
    this.reconnecting.clear();
    for (const timer of this.pausing.values()) clearTimeout(timer);
    this.pausing.clear();
    // comments held back go from the new workers, which hold them again as they resume
    for (const timer of this.holding.values()) clearTimeout(timer);
    this.holding.clear();
    // a "Push main" still in its undo window goes undone: the new workers could not take it back
    this.reviews.shutdown();
    this.apps.shutdown();
  }

  // ---------------------------------------------------------------- sessions

  /** What a worker's environment gets: where Obeya is, and the language the repository names for its demos (`DEMO_LANGUAGE`, read by the demo skill). */
  private env(): Record<string, string> | undefined {
    const language = this.o.adapter.demo?.language;
    return language ? { ...this.o.env, DEMO_LANGUAGE: language } : this.o.env;
  }

  private launch(cardId: string, message: string, resume?: string, images: string[] = []) {
    const row = this.o.board.row(cardId);
    if (!row.workspace) throw new Error(`card ${cardId} has no workspace to work in`);
    const preferences = this.o.preferences?.() ?? '';
    const live: Live = { session: undefined!, host: hostName(row.workspace), handedOver: false, acted: false, nudged: false, lastText: '', busy: true, background: 0, tasks: new Map(), stalled: false, preferences };
    const project = this.o.board.item(cardId)?.parent;
    if (project) live.project = { id: project, decision: this.o.board.decisions(project).at(-1)?.id ?? 0 };
    this.live.set(cardId, live);
    this.o.board.changed();
    ({ text: message, images } = this.withUnheard(cardId, message, images));
    message = this.withRestart(cardId, live, this.withPageNews(cardId, message));
    live.pending = { text: message, images };
    const env = this.env();
    // a plan folder outside the repository is the worker's to tick its workstream in, on this machine
    const plans = live.host ? null : outsidePlanDir(this.o.adapter.planDocs.dir);
    // a review card's workspace holds a stranger's code: its Claude Code settings (hooks, MCP servers) and
    // CLAUDE.md are the contributor's, so the session reads none of them, the default branch's CLAUDE.md instead
    const review = !!fromJson(row.contribution);
    const notes = review ? this.reviews.mainNotes() : '';
    // the harness and model the owner chose for this card, over the group's; a session resumed stays on its own harness
    const agent = row.agent ? cardAgentOf(row.agent) : undefined;
    const harness = resume ? sessionHarness(resume) : (agent?.harness ?? this.o.harness?.() ?? 'claude');
    const spec: AgentSpec = {
      cwd: row.workspace,
      role: 'worker',
      spendOn: cardId,
      ...(agent ? { agent } : {}),
      ...(plans ? { dirs: [plans] } : {}),
      ...(review ? { untrusted: true } : {}),
      system: this.brief.system(preferences, harness, !!row.prototype_of, this.o.board.item(cardId)),
      tools: this.tools(cardId, live, !!row.prototype_of),
      plugins: [OBEYA_PLUGIN],
      ...(env ? { env } : {}),
      contextUpdate: () =>
        [this.restartStillDue(cardId, live), this.pauseStillDue(live), this.pageNewsNow(cardId, live), this.unheardNow(cardId, live), this.preferencesUpdate(live), this.decisionsUpdate(cardId, live)].filter(Boolean).join('\n\n') || undefined,
      askOwner: (request, signal) => this.askOwner(cardId, live, request, signal),
      ...(this.folder ? { watch: this.folder.watch(cardId) } : {}),
      ...(resume ? { resume } : {}),
      ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
      onEvent: (e) => this.onEvent(cardId, live, e),
    };
    const start = (notes: string) => this.o.runtime.start(notes ? { ...spec, system: `${spec.system}\n\nThe repository's CLAUDE.md, as its default branch has it:\n\n${notes}` } : spec, message, images);
    // what git still reads of the default branch, the session starts once it has; what it is sent meanwhile reaches it then
    live.session = typeof notes === 'string' ? start(notes) : startingLater(notes.then((n) => () => start(n)), spec);
    live.session.done.then(() => {
      if (this.live.get(cardId) !== live) return;
      this.live.delete(cardId);
      // the card no longer shows its worker in a turn (an error after its turn ended counted as one)
      this.o.board.changed();
      // a session that ended without ending its turn takes in no answer any more
      this.answerTaken(cardId);
      if (!this.shut) this.endedByItself(cardId, live);
    });
  }

  /**
   * The worker's session ended without Obeya ending it (it failed to start, its harness died in a
   * turn): no agent works on the card any more. At work, a session that had worked is the owner's to
   * try again, resumed with its conversation; one that never did (it failed to start, or to resume)
   * has the card planned again as if the owner had stopped it, its log ending with the error (or
   * that the agent stopped), which the card then shows as why it does not run. After the landing,
   * or approved with its pull request still to open, the owner hears what was left undone. A card
   * waiting for the owner needs no session until their next words, nor one its worker snoozed until
   * the snooze wakes it.
   */
  private endedByItself(cardId: string, live: Live) {
    const card = this.o.board.item(cardId);
    const row = this.o.board.row(cardId);
    // it snoozed before its session ended: the snooze resumes it
    if (!card || row.snoozed) return;
    const landed = fromJson(row.landed);
    const t = this.o.board.t;
    const reason = live.failed ? failureReason(clip(live.failed, 1200), t) : t.worker.stalled;
    const ended = `${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
    if (landed) {
      if (card.state === 'waiting' || landed.waits || landed.page || landed.needsClone) return;
      this.toOwner(cardId, { text: t.worker.remainsUndone(ended), options: [t.worker.tryAgain], stuck: true });
      return;
    }
    // approved, its pull request still to open: the owner's "Try again" has it opened, the approval standing
    if (card.state === 'inPr' && !card.pr && !card.contribution) {
      this.toOwner(cardId, { text: t.worker.prNotOpened(ended), options: [t.worker.tryAgain], stuck: true });
      return;
    }
    if (card.state !== 'working') return;
    // it had worked: the owner's "Try again" resumes its session, keeping the conversation
    if (row.session_id && live.ran) {
      this.toOwner(cardId, { text: t.worker.sessionEnded(ended), options: [t.worker.tryAgain], stuck: true });
      return;
    }
    void this.planAgain(cardId, () => {
      if (this.o.board.events(cardId).at(-1)?.kind !== 'error') this.o.board.log(cardId, 'error', 'obeya', live.failed ?? t.worker.stalled);
    }).catch((e) => console.error(`giving back the workspace of ${cardId}:`, e));
  }

  /**
   * Passes a message to the worker, resuming its session if it has none. While the owner has paused
   * it, Obeya's messages wait (`owner` false); the owner's let it go on, after what waited. The
   * owner's words of the log's lines `said` wait for the worker's next step while it is in a turn
   * (`takesLater`), unread until then; other words go into the session's input at once.
   */
  private deliver(cardId: string, text: string, images: string[] = [], owner = false, said: number[] = [], timeUp = false, met?: Awaited) {
    const paused = this.pausedOf(cardId);
    if (paused && !owner) {
      this.o.board.work(cardId, { paused: toJson({ held: [...(paused.held ?? []), { text, images }] }) });
      return;
    }
    // a snoozed worker wakes: at its time, by the owner's words, or (snoozed by itself) by whatever Obeya has for it
    const snoozed = this.o.board.snoozedOf(cardId);
    const woke = snoozed && !snoozed.waiting ? snoozed : null;
    if (woke) {
      this.o.board.unsnooze(cardId, met ? { met } : timeUp ? 'time' : owner ? 'owner' : 'news');
      const live = this.live.get(cardId);
      if (live) live.snoozed = false;
      // snoozed on its handover, it goes on towards what it told the owner: the card is at work again
      const card = this.o.board.item(cardId);
      if (card && handedOver(card)) this.takingIn(cardId, true);
    }
    const wokeText = woke ? wokeNote(woke, timeUp, owner, !!text, met) : '';
    // the owner's words let a worker about to pause go on, as they do a paused one
    if (owner && this.o.board.row(cardId).pausing) {
      this.pauseTakenBack(cardId);
      text = [PAUSE_TAKEN_BACK, text].filter(Boolean).join('\n\n');
    }
    if (paused) {
      this.o.board.resumed(cardId, !woke);
      const held = paused.held ?? [];
      text = [woke ? wokeText : RESUMED, ...(held.length ? [`While you were ${woke ? 'snoozed' : 'paused'}, Obeya had this for you:\n\n${held.map((h) => h.text).join('\n\n---\n\n')}`] : []), ...(text ? [`Then:\n\n${text}`] : [])].join('\n\n');
      images = [...held.flatMap((h) => h.images), ...images];
    } else if (woke) text = [wokeText, text].filter(Boolean).join('\n\n');
    this.apps.unpark(cardId);
    const stopping = this.apps.stopping.get(cardId);
    if (stopping) {
      // the worker might start the app again while the stop still runs, and lose it
      const generation = this.generation.get(cardId);
      void stopping.then(() => {
        if (this.generation.get(cardId) === generation) this.deliver(cardId, text, images, false, said);
      });
      return;
    }
    // its worker starts once its workspace is ready and hears them then, or, should git fail, the next start's does
    if ((said.length && this.takesLater(cardId)) || this.preparingFor(cardId)) {
      this.o.board.work(cardId, { unheard: toJson([...this.unheard(cardId), { said, text, images }]) });
      return;
    }
    this.o.board.readNow(cardId, said);
    const parked = this.o.board.row(cardId).parked;
    if (parked) {
      this.o.board.work(cardId, { parked: null });
      text = `${text}\n\n${this.apps.parkedNote()}`;
    }
    const live = this.live.get(cardId);
    if (live) {
      // the turn this starts reports the background work that is still running
      this.stopWaiting(live);
      clearTimeout(live.lifts);
      live.lifts = undefined;
      this.setBusy(live, true);
      ({ text, images } = this.withUnheard(cardId, text, images));
      const message = this.withRestart(cardId, live, this.withPageNews(cardId, text));
      live.pending = { text: message, images };
      live.session.send(message, images);
      return;
    }
    const row = this.o.board.row(cardId);
    if (row.session_id) return this.launch(cardId, text, row.session_id, images);
    // no session to resume (it never reported one): a new one needs the card first
    const card = this.card(cardId);
    this.launch(cardId, `${this.brief.briefing(card, row.branch ?? '', true)}\n\n${text}`, undefined, [...this.brief.taskImages(card), ...images]);
  }

  /** Whether the worker is in the middle of a turn, so that the owner's words wait for its next step. */
  private takesLater(cardId: string): boolean {
    if (this.preparingFor(cardId)) return true;
    const live = this.live.get(cardId);
    return !!live && live.busy && !live.waiting && !this.apps.stopping.has(cardId) && !this.pausedOf(cardId);
  }

  /** Whether the card's worker waits for git to make its workspace ready, without a session yet. */
  private preparingFor(cardId: string): boolean {
    return this.preparing.has(cardId) && !this.live.has(cardId);
  }

  /** What waits for the worker, without what starts with `prefix` (news an event since has made stale). */
  private unheardBut(cardId: string, prefix: string): Unheard[] {
    return this.unheard(cardId).filter((u) => !u.text.startsWith(prefix));
  }

  private unheard(cardId: string): Unheard[] {
    return fromJson(this.o.board.row(cardId).unheard) ?? [];
  }

  /** The owner's words Obeya held for the worker, taken out: they are read from now on. */
  private takeUnheard(cardId: string): Unheard[] {
    const unheard = this.unheard(cardId);
    if (!unheard.length) return [];
    this.o.board.work(cardId, { unheard: null });
    this.o.board.readNow(cardId, unheard.flatMap((u) => u.said));
    return unheard;
  }

  /** The planned card became an idea: the notes the owner left on it for a worker go to its exploration agent instead. */
  takeNotes(cardId: string): { text: string; images: string[] } {
    return this.withUnheard(cardId, '', []);
  }

  /** A message that starts a turn, with the owner's words that waited for the worker's next step after it. */
  private withUnheard(cardId: string, text: string, images: string[]): { text: string; images: string[] } {
    const unheard = this.takeUnheard(cardId);
    if (!unheard.length) return { text, images };
    return { text: [text, ...unheard.map((u) => u.text)].filter(Boolean).join('\n\n---\n\n'), images: [...images, ...unheard.flatMap((u) => u.images)] };
  }

  /**
   * The owner's words that waited for the worker's next step, passed with that step's result. A
   * tool result carries no images: the worker opens the screenshots' files itself.
   */
  private unheardNow(cardId: string, live: Live): string | undefined {
    if (this.live.get(cardId) !== live) return;
    const unheard = this.takeUnheard(cardId);
    if (!unheard.length) return;
    const images = unheard.flatMap((u) => u.images);
    return [...unheard.map((u) => u.text), ...(images.length ? [`The screenshots cannot come with a tool result: read their files to see them (${images.join(', ')}).`] : [])].join('\n\n---\n\n');
  }

  /**
   * The worker's turn ended before a step took in the owner's words that waited for it: they start
   * its next turn. Not while it stops for a restart or a usage limit, which it goes on from with them.
   */
  private unheardStarts(cardId: string, live: Live): boolean {
    if (this.restart || live.limited || !this.unheard(cardId).length) return false;
    const { text: words, images } = this.withUnheard(cardId, '', []);
    const text = this.withPageNews(cardId, words);
    this.setBusy(live, true);
    live.pending = { text, images };
    live.session.send(text, images);
    return true;
  }

  /** What became of the demo's page since the worker last heard of it, passed with its next tool result. */
  private pageNewsNow(cardId: string, live: Live): string | undefined {
    if (this.live.get(cardId) !== live) return;
    return this.pageNews(cardId);
  }

  /** Preferences the owner gave or changed since the worker last heard them, passed with its next tool result. */
  private preferencesUpdate(live: Live): string | undefined {
    const now = this.o.preferences?.() ?? '';
    if (now === live.preferences) return;
    live.preferences = now;
    return now ? `The owner's preferences changed while you work; they now read:\n\n${now}` : 'The owner withdrew their standing preferences; none apply any more.';
  }

  /** Decisions taken in the card's project since the worker last heard of them, passed with its next tool result; those on its own card it heard as answers. */
  private decisionsUpdate(cardId: string, live: Live): string | undefined {
    if (!live.project) return;
    const fresh = this.o.board.decisions(live.project.id).filter((d) => d.id > live.project!.decision);
    if (!fresh.length) return;
    live.project.decision = fresh.at(-1)!.id;
    const others = fresh.filter((d) => d.card_id !== cardId);
    return others.length ? `Decisions taken in this project while you work:\n${decisionLog(others)}` : undefined;
  }

  /**
   * A message that starts a turn while a restart is due tells the worker of it, once: that the
   * work the message asks for waits until Obeya resumes it (workers in a turn heard of it already).
   */
  private withRestart(cardId: string, live: Live, text: string): string {
    const still = this.restartStillDue(cardId, live);
    if (still) return `${text}\n\n${still}`;
    if (!this.restart || live.toldRestart) return text;
    this.tellRestart(cardId, live);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartWaits(pauseOf(this.restart)));
    return `${text}\n\n${restartWaits(this.restart)}`;
  }

  /**
   * A turn that starts after the worker paused for the restart, before it happened, hears once that
   * Obeya still waits: with its message, or with its first tool step when nothing of Obeya's started
   * it (a background command that finished, which the worker would otherwise go on from).
   */
  private restartStillDue(cardId: string, live: Live): string | undefined {
    if (!this.restart || !live.restartPaused) return;
    live.restartPaused = false;
    this.o.board.changed();
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartStillDue(pauseOf(this.restart)));
    return stillDue(this.restart);
  }

  /** A turn that the worker's background work starts after it ended one for the owner's pause hears once, with its first tool step, that the owner still waits. */
  private pauseStillDue(live: Live): string | undefined {
    if (!live.pauseHeld) return;
    live.pauseHeld = false;
    return PAUSE_STILL;
  }

  private tellRestart(cardId: string, live: Live) {
    live.toldRestart = true;
    live.statusBeforeRestart = this.o.board.row(cardId).status_line;
  }

  /** The worker ended its turn for the restart: the card says so, and its status line is again the one from before it heard of it. */
  private pausedForRestart(cardId: string, live: Live) {
    if (live.statusBeforeRestart !== undefined) this.o.board.work(cardId, { status_line: live.statusBeforeRestart });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.paused(pauseOf(this.restart!)));
  }

  private bump(cardId: string) {
    // counted across cards, so a card's run forgotten (`forget`) is never taken for a later one
    this.generation.set(cardId, ++this.runs);
    this.apps.unpark(cardId);
  }

  private end(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    clearTimeout(live?.waiting);
    clearTimeout(live?.lifts);
    live?.session.close();
    // its slot is free again
    if (live?.busy) this.o.board.changed();
  }

  /**
   * Whether the worker is in a turn. It holds a slot on its machine meanwhile: the board hears of
   * each change, so the Workspaces pill shows it and a card waiting for a slot starts once one frees.
   */
  private setBusy(live: Live, busy: boolean) {
    if (live.busy === busy) return;
    live.busy = busy;
    if ([...this.live.values()].includes(live)) this.o.board.changed();
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    if (e.type === 'background') return this.backgroundChanged(cardId, live, e.tasks);
    // a turn may also start without a message from Obeya (a finished background command)
    this.setBusy(live, e.type !== 'idle');
    this.stopWaiting(live);
    clearTimeout(live.lifts);
    live.lifts = undefined;
    if (e.type === 'text' || e.type === 'tool') {
      // a turn of its own (a finished background command woke it) after it answered the owner's
      // words on its handover: it works on towards what it told them, so the card is at work again
      if (!live.acted && this.o.board.item(cardId)?.answered) this.takingIn(cardId, true);
      this.resumed(cardId, live);
      this.unlimited(cardId, live);
      live.failed = undefined;
      live.ran = true;
    }
    if (e.type === 'text' || e.type === 'tool' || e.type === 'error') live.acted = true;
    if (e.type === 'text' || e.type === 'tool' || (e.type === 'idle' && !e.more)) live.pending = undefined;
    switch (e.type) {
      case 'session': {
        // a session that replaces another (none resumed, say) keeps the one before for the work retrospective
        const before = this.o.board.row(cardId).session_id;
        if (before && before !== e.id) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.newSession(this.o.board.t.worker.earlierRun(before)));
        this.o.board.work(cardId, { session_id: e.id, model: e.model ?? null, effort: e.effort ?? null });
        break;
      }
      case 'text':
        live.lastText = e.text;
        // after handing over the worker's closing words repeat the handover the card shows: the
        // conversation leaves them out; after a reply its words wait to see whether work follows them
        // or they close the turn, repeating the reply
        if (live.handedOver || live.snoozed) break;
        live.spoke = true;
        if (live.answered) live.held = clip(e.text, 12000);
        else this.o.board.log(cardId, 'say', 'worker', clip(e.text, 12000));
        break;
      case 'tool':
        if (live.held !== undefined) this.o.board.log(cardId, 'say', 'worker', live.held);
        live.held = undefined;
        if (!e.name.startsWith('mcp__obeya__')) this.o.board.log(cardId, 'activity', 'worker', describeTool(e.name, e.input, this.o.board.t));
        else if (e.name === 'mcp__obeya__app_running') appRunning(live, String(e.input.url ?? '').trim());
        break;
      case 'denied': {
        const t = this.o.board.t;
        this.o.board.log(cardId, 'denied', 'worker', t.worker.denied(describeTool(e.name, e.input, t), t.worker.deniedBy[e.by], e.reason && clip(e.reason, 600)));
        break;
      }
      case 'error':
        if (e.limit) {
          live.limited = limitLifts(e.limit, this.o.limitMargin ?? 10_000);
          const t = this.o.board.t;
          this.o.board.log(cardId, 'state', 'obeya', `${e.message}. ${e.limit.resetsAt ? t.worker.limitResumes(t.when(live.limited)) : t.worker.limitRetries(t.when(live.limited))}`);
          break;
        }
        live.failed = e.message;
        this.o.board.log(cardId, 'error', 'obeya', e.message, { token: e.token });
        break;
      case 'lost':
        this.lost(cardId, live);
        break;
      case 'idle':
        live.background = e.background ?? 0;
        if (!live.background) live.tasks.clear();
        this.turnEnded(cardId, live, live.background, false, this.unheardStarts(cardId, live) || e.more);
        this.apps.parkLater(cardId);
        break;
    }
  }

  private async landApproved(cardId: string) {
    if (this.o.board.row(cardId).contribution) return this.reviews.mergeApproved(cardId);
    try {
      await this.land(cardId, 'obeya');
    } catch (e) {
      // the Obeya checkout is in the way: the card waits for the owner, who approves again
      if (!(e instanceof BadRequest)) return this.o.board.log(cardId, 'error', 'obeya', messageOf(e));
      this.o.board.work(cardId, { state: 'waiting', need: this.o.board.row(cardId).demo ? 'demo' : 'review', status_line: null });
      this.o.board.log(cardId, 'error', 'obeya', e.message, { code: e.code });
    }
  }

  /**
   * A turn that ends without handing over gets one nudge; after that the owner is asked. A turn
   * that ends while the worker's background work runs (a demo render, say) waits for that work
   * to wake the worker instead, unless nothing happens for a long while; so does a turn in which
   * the worker did nothing, as it never ended a turn of its own there. A turn that ends with a
   * message from Obeya still to come (`more`) is not the worker's last: the turn that message starts
   * is, so the landing of its work, told while the worker ended its reply, is not lost with the session.
   */
  private turnEnded(cardId: string, live: Live, background: number, waited = false, more = false) {
    // calls whose end its hooks never heard of (refused, cut off) end with the turn
    void this.folder?.settle(cardId);
    const handedOver = live.handedOver;
    const acted = live.acted || waited;
    // what runs now was started before any later turn
    for (const t of live.tasks.values()) t.earlier = true;
    const closing = live.held;
    const snoozed = live.snoozed;
    const spoke = !!live.spoke;
    live.handedOver = false;
    live.answered = false;
    live.spoke = false;
    // a snooze holds across a turn a message from Obeya still starts (a restart notice): its session ends after that one
    if (!more) live.snoozed = false;
    live.held = undefined;
    live.acted = false;
    // a turn that took in the restart pauses for it, whatever else keeps the worker busy
    if (this.restart && live.toldRestart && !more) {
      live.restartPaused = true;
      this.o.board.changed();
    }
    const card = this.o.board.item(cardId);
    if (!card) return;
    if (closing !== undefined) this.o.board.log(cardId, 'closing', 'worker', closing);
    const row = this.o.board.row(cardId);
    // it snoozed: its session ends (its background work with it), and Obeya resumes it at the time;
    // on its handover the snooze answers the owner's words, so waking it is at work again
    if (snoozed && !handedOver && !more && row.snoozed) {
      if (answering(card)) this.answerTaken(cardId, true);
      return this.end(cardId);
    }
    if (row.pausing && !more) {
      // it paused at a safe point, as the owner asked: its session ends, and it goes on once they let it
      if (!background) return this.pausedAtSafePoint(cardId, card, !!row.approved_at, handedOver, spoke);
      // its background work keeps the owner waiting, and the turn it starts hears so
      live.pauseHeld = true;
    }
    if (background > 0) {
      // the usage limit cut the worker's turn off while its work runs on: the card says so, and the
      // worker goes on once it lifts, without waiting for that work to wake it
      if (live.limited && !handedOver && this.goesOnAfterLimit(cardId)) return this.waitForLimit(cardId, live, live.limited, background);
      // the background work still belongs to the turn, whatever the card's state (a worker may ask
      // while its render runs): a restart now would cut it off
      this.waitForWorker(cardId, live);
      if (!handedOver) {
        // words for the owner on its handover answer theirs though the app it serves for them to try
        // runs on: the card is theirs again. Other work (a test run, a render) wakes the worker to go
        // on towards what it told them, so the card stays at work while it runs.
        if (spoke && answering(card) && onlyApp(live)) this.answerTaken(cardId, true);
        return;
      }
    }
    if (more && !handedOver) return this.waitForWorker(cardId, live);
    if (answering(card)) {
      // a resumed session may first end a turn of its own before it takes in the owner's words
      if (!acted && !handedOver) return this.waitForWorker(cardId, live);
      // it paused for the restart, which resumes it, still taking in the answer
      if (this.restart && live.toldRestart && !handedOver) return this.pausedForRestart(cardId, live);
      // the usage limit cut it off: it goes on by itself once the limit lifts, still taking in the answer
      if (live.limited && !handedOver) return this.waitForLimit(cardId, live, live.limited);
      this.answerTaken(cardId, spoke);
    }
    if (handedOver) {
      // work the owner approved already lands once its worker handed over what stood in the way
      if (card.state === 'working' && row.approved_at) void this.landApproved(cardId);
      return;
    }
    const landed = fromJson(row.landed);
    // in the PR phase a turn ends normally once the PR is open
    if (card.state === 'inPr' && card.pr) return;
    if (card.state !== 'working' && card.state !== 'inPr' && !landed) return;
    if (landed) {
      // what remained after the landing is done, unless the worker waits for its question, the restart, its demo's page or the usage limit
      if (card.state === 'waiting' || landed.waits) return;
      if (landed.page) {
        // the page went out (or did not) without the worker hearing it (Obeya was not running, say): it hears now
        if (card.share?.state !== 'publishing') this.pageSettled(cardId);
        return;
      }
      if (landed.needsClone) return this.awaitClone(cardId);
      if (landed.resolve && !live.failed && !live.limited && !(this.restart && live.toldRestart)) return this.unresolved(cardId, live, landed.resolve);
      // it paused for the restart, which resumes it with its workspace
      if (this.restart && live.toldRestart && !live.failed) return this.pausedForRestart(cardId, live);
      if (live.limited) return this.waitForLimit(cardId, live, live.limited);
      if (live.failed) return this.failedAfterLanding(cardId, live);
      this.finish(cardId);
      return;
    }
    // it paused for the restart, which resumes it
    if (this.restart && live.toldRestart) return this.pausedForRestart(cardId, live);
    if (live.limited) return this.waitForLimit(cardId, live, live.limited);
    if (!acted && !live.nudged) {
      // the worker's own turn is still to come; should it not, it counts as ended after a while
      // (silence after a nudge, though, is the worker having stopped)
      this.waitForWorker(cardId, live);
      return;
    }
    if (!live.nudged) {
      live.nudged = true;
      this.setBusy(live, true);
      // a refusal its worker never read (Codex's code mode drops a result its script does not print) reaches it here
      const refused = live.refused ? `\n\nYour last call of ${live.refused.tool} came back with: ${clip(live.refused.text, 1500)}` : '';
      live.session.send(
        (card.state === 'inPr'
          ? 'Your turn ended, and Obeya has no pull request for this card yet (pr_opened), nor did you close it as needing none (close_unchanged).'
          : 'Your turn ended without a handover (ready_for_review) or a question (ask), so the card still shows you at work. Should you end your turn again like this, Obeya passes your last words to the owner as a question.') + refused,
      );
      live.refused = undefined;
      return;
    }
    live.nudged = false;
    live.stalled = true;
    // a session that fails again after the nudge cannot go on by itself: the owner hears why, not its last words
    const text = live.failed ? failureReason(clip(live.failed, 1200), this.o.board.t) : live.lastText ? clip(live.lastText, 1200) : this.o.board.t.worker.stalled;
    this.toOwner(cardId, { text, options: [], stuck: true });
  }

  /**
   * The worker resolving a stopped pull (`resolvePull`) ended its turn without handing the
   * resolution over: it is reminded once; ending again, it gives the pull up, and the review card
   * says what is left to do.
   */
  private unresolved(cardId: string, live: Live, r: Resolving) {
    const landed = fromJson(this.o.board.row(cardId).landed)!;
    if (!r.reminded) {
      this.o.board.work(cardId, { landed: toJson({ ...landed, resolve: { ...r, reminded: true } }) });
      this.setBusy(live, true);
      live.session.send(
        `Your turn ended, and the pull of pull request #${r.pr} into the local main is still stopped: resolve it and hand it over with ready_for_review, or ask the owner where it needs their decision. Should you end your turn again like this, Obeya leaves the pull to the owner.`,
      );
      return;
    }
    const { resolve: _, ...rest } = landed;
    this.o.board.work(cardId, { landed: toJson(rest), status_line: null });
    const t = this.o.board.t.worker;
    if (this.o.board.card(r.card)) this.o.board.log(r.card, 'error', 'obeya', t.pullUnresolved(r.stopped.subject, r.stopped.files.join(', '), t.resolverGaveUp));
    this.finish(cardId);
  }

  /**
   * A turn after the landing that an error cut off (the API overloaded, say) has not done what
   * remained: it is tried once more, then the owner hears why. A restart that is due tries it
   * again by resuming the worker, and need not wait for a turn that may fail the same way.
   */
  private failedAfterLanding(cardId: string, live: Live) {
    if (this.restart) {
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.paused(pauseOf(this.restart)));
      return;
    }
    if (!live.nudged) {
      live.nudged = true;
      this.setBusy(live, true);
      live.session.send(`Your last turn broke off with an error (${clip(live.failed!, 300)}). Your work is on main; go on with what remained after the landing.`);
      return;
    }
    live.nudged = false;
    live.stalled = true;
    const t = this.o.board.t;
    const reason = failureReason(clip(live.failed!, 1200), t);
    this.toOwner(cardId, { text: t.worker.remainsUndone(`${reason}${/[.!?]$/.test(reason) ? '' : '.'}`), options: [t.worker.tryAgain], stuck: true });
  }

  /**
   * The worker takes in the owner's words on its handover: the card is at work meanwhile, and still
   * waits for approval. New words are not answered yet; a worker that its background work woke
   * after it answered (`woke`) works on towards that answer, which stands.
   */
  private takingIn(cardId: string, woke = false) {
    const { answered, ...rest } = fromJson(this.o.board.row(cardId).detail) ?? {};
    this.o.board.work(cardId, { detail: toJson({ ...rest, ...(woke && answered ? { answered } : {}), answering: true }) });
  }

  /**
   * The worker has taken in the owner's words on its handover: work still waiting is the owner's
   * again, `answered` when its turn ended with words for them rather than a new demo (or a turn
   * before did, `takingIn`). Without any (its session ended, its turn broke off) the owner hears
   * that their words went unanswered.
   */
  private answerTaken(cardId: string, spoke = false) {
    const detail = fromJson(this.o.board.row(cardId).detail);
    if (!detail) return;
    const { answering, answered: before, ...rest } = detail;
    if (!answering) return;
    const answered = spoke || !!before;
    this.o.board.work(cardId, { detail: toJson({ ...rest, ...(answered ? { answered: true } : {}) }) });
    if (!answered) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.unanswered);
  }

  /**
   * Waits for a sign of life from the worker; without one for a long while, its turn counts as ended.
   * While its background work runs (a watcher waiting for a deploy, say) that may take long: the
   * wait is the work's own, which wakes the worker when it ends.
   */
  private waitForWorker(cardId: string, live: Live) {
    this.setBusy(live, true);
    const began = !live.waiting;
    clearTimeout(live.waiting);
    live.waiting = setTimeout(() => {
      live.waiting = undefined;
      this.setBusy(live, false);
      if (this.live.get(cardId) !== live) return;
      this.turnEnded(cardId, live, 0, true);
      this.apps.parkLater(cardId);
    }, live.background > 0 ? (this.o.backgroundLimit ?? BACKGROUND_LIMIT) : (this.o.backgroundGrace ?? BACKGROUND_GRACE));
    // a card waiting for the owner shows nobody at work once only its background work holds the turn
    if (began && [...this.live.values()].includes(live)) this.o.board.changed();
  }

  /** The worker gave a sign of life: an ended turn that waited for it is a turn again, which the card shows. */
  private stopWaiting(live: Live) {
    if (!live.waiting) return;
    clearTimeout(live.waiting);
    live.waiting = undefined;
    if (live.busy && [...this.live.values()].includes(live)) this.o.board.changed();
  }

  /** The worker's background work started or ended: an ended turn waiting for it waits as long as it runs. */
  private backgroundChanged(cardId: string, live: Live, running: { id: string; description: string }[]) {
    live.background = running.length;
    // what it changes in a folder without git meanwhile is the card's
    this.folder?.background(cardId, running.length > 0);
    const now = Date.now();
    live.tasks = new Map(running.map((t) => [t.id, { ...live.tasks.get(t.id), description: t.description, since: live.tasks.get(t.id)?.since ?? now }]));
    // the card shows what runs while the worker is in a turn
    if (live.busy) this.o.board.changed();
    if (live.waiting) this.waitForWorker(cardId, live);
  }

  // ---------------------------------------------------------------- parking

  /**
   * The connection to the machine the card's workspace is on is gone, and the session with it (as
   * at a restart of Obeya): once that machine answers again, the session resumes by its id, with
   * the message it had not yet taken, else told what happened if it was at work (or waited for its
   * background work). A session that never started there (the host could not be reached to get
   * it ready) has no id: a new one starts with the message it was to begin with. A card that waits
   * for the owner meanwhile needs no session until their next message.
   */
  private lost(cardId: string, live: Live) {
    const there = remote(this.o.board.row(cardId).workspace);
    if (!there) return;
    this.live.delete(cardId);
    clearTimeout(live.waiting);
    clearTimeout(live.lifts);
    const pending = live.pending;
    // in a turn, or its ended turn waiting for background work that woke it: that work went with the session
    const busy = live.busy;
    const generation = this.generation.get(cardId);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.hostLost(there.host.name));
    const again = async () => {
      this.reconnecting.delete(cardId);
      const current = () => this.generation.get(cardId) === generation && !this.live.has(cardId);
      if (!current()) return;
      if (!(await there.host.reachable())) {
        if (current()) this.reconnecting.set(cardId, setTimeout(again, this.o.reconnectMs ?? RECONNECT_MS));
        return;
      }
      const row = this.o.board.row(cardId);
      const card = this.o.board.item(cardId);
      if (!current() || !card || !row.workspace || (!row.session_id && !pending) || card.snoozed) return;
      const working = busy || card.state === 'working' || card.state === 'inPr' || answering(card) || !!row.landed;
      if (!pending && !working) return;
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.hostBack(there.host.name));
      if (pending) this.launch(cardId, pending.text, row.session_id ?? undefined, pending.images);
      else this.launch(cardId, hostResumed(there.host.name), row.session_id!);
    };
    this.reconnecting.set(cardId, setTimeout(again, this.o.reconnectMs ?? RECONNECT_MS));
  }

  /**
   * A demo directory as the server reads it: the worker's own on this machine; from a worker on
   * another machine, its copy here (design: Hosts), taken afresh at each handover.
   */
  private async demoHere(cardId: string, dir: string): Promise<{ dir: string } | { wrong: string }> {
    try {
      const there = remote(this.o.board.row(cardId).workspace);
      if (!there) return { dir };
      const copy = there.host.localCopy(dir);
      await there.host.copyFrom(dir, copy);
      return { dir: copy };
    } catch (e) {
      return { wrong: messageOf(e) };
    }
  }

  /**
   * The usage limit stopped the worker, at work, taking in the owner's words on its handover or after
   * the landing: it goes on by itself once the limit lifts. Meanwhile it is not busy (a restart need
   * not wait for it, and resumes it into the same limit), unless its `background` work runs on,
   * which a restart would cut off; a message from the owner reaches it at once and finds out whether
   * the limit still holds.
   */
  private waitForLimit(cardId: string, live: Live, at: number, background = 0) {
    if (background > 0) this.waitForWorker(cardId, live);
    else this.setBusy(live, false);
    if (live.statusBefore === undefined) {
      // after a restart the line may still be the one this shows
      const line = this.o.board.row(cardId).status_line;
      live.statusBefore = line && limitLine(line) ? null : line;
    }
    this.o.board.work(cardId, { status_line: this.o.board.t.worker.limitStatusUntil(this.o.board.t.when(at)) });
    clearTimeout(live.lifts);
    // a timer runs at most about 24 days
    live.lifts = setTimeout(() => {
      live.lifts = undefined;
      if (this.live.get(cardId) !== live || !this.goesOnAfterLimit(cardId)) return;
      this.deliver(cardId, LIMIT_LIFTED);
    }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
  }

  /** Whether the card's worker goes on by itself once the usage limit lifts: it is at work on the card, not waiting for the owner. */
  private goesOnAfterLimit(cardId: string): boolean {
    const card = this.o.board.item(cardId);
    if (!card) return false;
    const landed = !!this.o.board.row(cardId).landed;
    return card.state === 'working' || card.state === 'inPr' || answering(card) || (landed && card.state !== 'waiting');
  }

  /** A worker that waited for the usage limit works again: its status line is back. */
  private unlimited(cardId: string, live: Live) {
    live.limited = undefined;
    const before = live.statusBefore;
    live.statusBefore = undefined;
    if (before !== undefined) this.o.board.work(cardId, { status_line: before });
    // it waited before a restart
    else if (limitLine(this.o.board.row(cardId).status_line)) this.o.board.work(cardId, { status_line: null });
  }

  /** A worker that went to the owner for having stopped and then works on by itself takes the question back. */
  private resumed(cardId: string, live: Live) {
    if (!live.stalled) return;
    live.stalled = false;
    const card = this.o.board.item(cardId);
    if (card?.state !== 'waiting' || card.need !== 'question') return;
    this.backToWork(cardId);
  }

  /** Whether the app the card's worker said runs answers at its address now (`CardApps.appUp`). */
  appUp(cardId: string): Promise<boolean> {
    return this.apps.appUp(cardId);
  }

  /** The owner opens the card's app to try it by hand: its address (`CardApps.openApp`). */
  openApp(cardId: string): Promise<string | null> {
    return this.apps.openApp(cardId);
  }

  // ---------------------------------------------------------------- the worker's tools

  private tools(cardId: string, live: Live, prototype: boolean): AgentTool[] {
    // the system prompt says which language that is (`ownersLanguage`)
    const language = "the owner's language";
    // the page goes to colleagues: in the language of the repository's demos where it names one
    const pageLanguage = LANGUAGE_NAMES[this.brief.demoLanguage()];
    // whether the repository shares, as the session's tools have it from their start on: the schema drops a page they do not
    // take, so the handover asks for one only where they take it (where sharing began since, the page is written once shared)
    const shares = this.shares;
    // the vocabulary the page's tags come from, where the repository's site names one
    const vocabulary = shares ? dimensions(this.o.adapter.demo?.site?.tags) : [];
    // a proposal may go to another repository than the card's: of this canvas, or of another canvas this Obeya runs
    const repos = this.o.board.canvas.repos;
    const ownRepo = this.o.repo ?? this.o.board.home;
    const others = this.otherBoards().filter((b) => b.canvas.repos.length);
    const anotherRepo = repos.length > 1 || others.length > 0;
    const handOver = () => {
      live.handedOver = true;
      live.nudged = false;
      // a question or a handover after a snooze in the same turn: the card waits for the owner instead
      if (live.snoozed) {
        live.snoozed = false;
        this.o.board.work(cardId, { snoozed: null });
      }
    };
    /**
     * The result of a call that ends the worker's turn (`plain`). The owner's words that waited for
     * this step come with the result itself, with what to do about them, so that the worker takes
     * them in before its turn ends rather than ending it in silence: `stands` is what holds of the
     * call meanwhile, `change` what follows if their words change it.
     */
    const ending = (plain: string, stands: string, change?: string): string => {
      const words = this.unheardNow(cardId, live);
      if (!words) return plain;
      return `${stands} The owner wrote to you while you worked, and their words reach you only now, with this result: take them in as at any other step. Answer them with reply where they call for an answer, and do what they ask${change ? `; ${change}` : ''}. Then end your turn.\n\n${words}`;
    };
    // a session the owner stopped or replaced may still call its tools: those calls change nothing
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({
        ...t,
        run: (args) => {
          if (this.live.get(cardId) !== live && !live.standIn) return 'This session has ended. Stop working and end your turn.';
          const heard = (text: string) => {
            if (/^Not [a-z ]+:/.test(text)) live.refused = { tool: t.name, text };
            else if (live.refused?.tool === t.name) live.refused = undefined;
            return text;
          };
          const result = t.run(args);
          return typeof result === 'string' ? heard(result) : result.then(heard);
        },
      }));
    // a review card's tools to the contributor's pull request
    const review = fromJson(this.o.board.row(cardId).contribution);
    return current([
      {
        name: 'report',
        description: `Show the owner one short status line on your card (in ${language}, at most ~80 characters). Use it at milestones, not for every step.`,
        schema: { status: z.string() },
        run: ({ status }) => {
          const s = clip(String(status), 200);
          this.o.board.work(cardId, { status_line: s });
          this.o.board.log(cardId, 'report', 'worker', s);
          return 'Shown on the card.';
        },
      },
      {
        name: 'reply',
        description: `Answer a note or feedback from the owner in your card's conversation: a sentence or two in ${language}, what you change because of it or why nothing. The reply does not end your turn: if work remains, carry on with it; if none does (your work is handed over and the note changes nothing), your turn ends with the reply, and the card goes on waiting for the owner's approval.`,
        schema: { text: z.string() },
        run: ({ text }) => {
          const s = String(text).trim();
          if (!s) return 'Not shown: the reply is empty.';
          const long = tooLong(s, 12000, 'reply');
          if (long) return long;
          // a reply may end the turn on a handover: what the owner chose for later is made before it
          const owed = this.reviews.owedTasks(cardId);
          if (owed) return `Not shown: first make the follow-up tasks the owner chose, for ${owed}; then reply.`;
          this.o.board.log(cardId, 'talk', 'worker', s);
          live.answered = true;
          live.spoke = true;
          return 'Shown to the owner.';
        },
      },
      {
        name: 'ask',
        description: `Ask for a decision you should not make yourself: product behaviour, trade-offs, anything irreversible or external. Write the question in ${language} for a reader who has not seen the code, and offer up to four short answer options when they exist; the owner picks one on the card (several when multiple is true) or writes their own. pick: the options you would choose yourself if you had to decide (one, or several when multiple), and pick_why: why, in one short sentence in ${language}; the card marks them for the owner. Then end your turn.`,
        schema: {
          question: z.string(),
          options: z.array(z.string()).max(4).optional(),
          multiple: z.boolean().optional(),
          pick: z.array(z.string()).optional(),
          pick_why: z.string().optional(),
          demo: z
            .object({
              kind: z.enum(['video', 'html']).optional().describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at"),
              dir: z.string().describe('absolute path: a video holds demo.mp4 and captions.vtt, an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
            })
            .optional()
            .describe(
              "what the owner is to look at to answer, when there is something to see (drafts or variants side by side, as an HTML artifact, say): the card shows it beside your question as it shows a handover's demo. It is no handover: the handover still brings its own demo.",
            ),
        },
        run: (args) => {
          const asked = (shown?: StoredDemo): string => {
            handOver();
            const q = withPick(args as unknown as Asked);
            const e = this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
            if (shown) {
              // the demo it replaces stays with the card, for the owner to go back to
              const row = this.o.board.row(cardId);
              this.o.board.work(cardId, { demo: toJson({ ...this.keep(cardId, e.id, shown), asked: true, handover: e.id, at: e.at }), ...(row.demo ? { demos: this.earlier(cardId, row) } : {}) });
            }
            this.toOwner(cardId, q);
            return ending(
              END_TURN,
              'Recorded: your question waits for the owner on the card, and their answer arrives as your next message.',
              'if they change your question, ask it anew (the card shows the earlier one as asked again further below)',
            );
          };
          const given = args.demo as { kind?: DemoKind; dir: string; chapters?: string[] } | undefined;
          if (!given) return asked();
          // a demo made on another machine is shown from its copy here
          return this.demoHere(cardId, given.dir).then((here) => {
            if ('wrong' in here) return `Not asked: the demo could not be copied to the owner's machine (${here.wrong}). Check the directory, then ask again.`;
            // copying it takes a while, in which the owner may stop or replace the session
            if (this.live.get(cardId) !== live && !live.standIn) return 'This session has ended. Stop working and end your turn.';
            const kind = given.kind ?? 'video';
            if (kind === 'html') {
              const wrong = checkArtifact(here.dir);
              if (wrong) return `Not asked: ${wrong}. Fix the artifact, then ask again.`;
              return asked({ kind, dir: here.dir, chapters: [], ...(artifactFiles(here.dir).length === 1 ? { single: true as const } : {}) });
            }
            const chapters = readChapters(here.dir, given.chapters ?? []);
            if (typeof chapters === 'string') return `Not asked: ${chapters}. Fix the demo, then ask again.`;
            return asked({ kind, dir: here.dir, chapters });
          });
        },
      },
      // a prototype makes no cards of its own: what it proposes is building its idea on it
      prototype
        ? {
            name: 'propose_build',
            description: `Propose that the idea be built on this prototype: a worker then goes on from your branch, takes over what carries and brings it to production quality, and the idea's other prototypes are discarded. Use it when your approach convinced (the owner said so, or it clearly settles the idea). It shows on your card, where the owner accepts it or not. reason: why, in ${language}, a sentence or two.`,
            schema: { reason: z.string() },
            run: ({ reason }) => {
              this.o.board.proposeBuild(cardId, clip(String(reason).trim(), 2000));
              this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.proposesBuild(clip(String(reason).trim(), 300)));
              return 'Shown on your card; the owner decides. Continue with your task.';
            },
          }
        : {
            name: 'propose_card',
            description: [
              `Propose a separate card for something you noticed that is outside your task, instead of doing it here, or for a follow-up to your own task that can only be done later (start_at); the owner decides on it.`,
              `idea: true for something to think through with the owner before anyone builds it (it becomes an idea, discussed with an agent of its own); leave it out for a task that is clear enough to build.`,
              proposalTask('your card nor your session'),
              `reason: for the owner only, why you propose it, a sentence or two; it does not go to that agent.`,
              `questions: what the owner has to decide first (product behaviour, a trade-off), each with up to four short options; keep them out of task. The owner may answer them on the proposal; what they decided and what stays open go to the agent with the task.`,
              `replaces: the title of an earlier proposal of yours this one takes the place of; Obeya takes that one off the canvas, or, if the owner has taken it on already, marks it as replaced and offers to remove it.`,
              `start_at: when the card is to start, ISO 8601 with your timezone's offset (2026-11-04T08:00:00+01:00), for a task that can only be done later (whether a bank has registered a form two weeks on, say): accepted, it waits until then and starts by itself. Its agent then checks what it can and asks the owner for what only they can see.`,
              ...(anotherRepo
                ? [
                    `repo: the repository the change is to be made in, by its id: ${repos.map((r) => `${r.id} (${r.path}${r.id === ownRepo ? ', yours' : ''})`).join(', ')}${others.length ? `; on other canvases, where the proposal then waits for the owner: ${others.map((b) => `on “${b.canvas.name}” ${b.canvas.repos.map((r) => `${r.id} (${r.path})`).join(', ')}`).join('; ')}` : ''}; yours when left out.`,
                  ]
                : []),
              `Everything in ${language}.`,
            ].join(' '),
            schema: {
              title: z.string(),
              task: z.string(),
              reason: z.string(),
              idea: z.boolean().optional(),
              questions: PROPOSAL_QUESTIONS.optional(),
              replaces: z.string().optional(),
              start_at: z.string().optional(),
              ...(anotherRepo ? { repo: z.string().optional() } : {}),
            },
            run: ({ title, task, reason, idea, questions, replaces, start_at, repo }) => {
              const wanted = typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
              const into = wanted ? this.proposalRepo(wanted) : undefined;
              if (typeof into === 'string') return into;
              const board = into?.board ?? this.o.board;
              const named = typeof start_at === 'string' && start_at.trim() ? start_at.trim() : undefined;
              const at = named ? Date.parse(named) : NaN;
              const when = named ? laterTime(at) : 'ok';
              if (when === 'none') return 'Not proposed: give start_at as ISO 8601 with your timezone offset (2026-11-04T08:00:00+01:00).';
              if (when === 'past') return `Not proposed: start_at has passed (it is ${new Date().toISOString()} now).`;
              if (when === 'far') return 'Not proposed: start_at lies more than a year ahead.';
              const p = board.propose(cardId, {
                title: String(title),
                task: String(task),
                reason: String(reason),
                idea: !!idea,
                questions: proposalQuestions(questions as z.infer<typeof PROPOSAL_QUESTIONS> | undefined),
                ...(named ? { startAt: new Date(at).toISOString() } : {}),
                ...(into ? { repo: into.repo } : {}),
              });
              const there = board === this.o.board ? undefined : board.canvas.name;
              this.o.board.log(cardId, 'activity', 'worker', idea ? this.o.board.t.worker.proposedIdea(p.title, there) : this.o.board.t.worker.proposedCard(p.title, there));
              const old = typeof replaces === 'string' && replaces.trim() ? replaces.trim() : undefined;
              return old ? `Proposed. ${this.retract(cardId, old, { by: p.id, title: p.title })}` : 'Proposed; the owner decides. Continue with your task.';
            },
          },
      // a prototype makes no cards, so it has none to take back
      ...(prototype
        ? []
        : [
            {
              name: 'withdraw_proposal',
              description: [
                `Take back a card you proposed earlier (propose_card) that turned out wrong or needless, by its title. Still open, it goes from the canvas at once; if the owner has taken it on already, Obeya marks it as withdrawn and offers to remove it.`,
                `replaced_by: the title of a proposal of yours that takes its place, when you made one already (a new one names the old with replaces instead).`,
                `why: for the owner, a sentence, in ${language}.`,
              ].join(' '),
              schema: { title: z.string(), why: z.string(), replaced_by: z.string().optional() },
              run: (args: Record<string, unknown>) => {
                const { title, why, replaced_by } = args as { title: string; why: string; replaced_by?: string };
                // the latest by that title, as retract takes the latest it replaces: of two alike, the newer replaces the older
                const by = replaced_by?.trim()
                  ? this.proposalBoards()
                      .map((b) => b.items().findLast((i) => i.from === cardId && (!!i.proposal || !!i.proposed) && titleKey(i.title) === titleKey(replaced_by)))
                      .find(Boolean)
                  : undefined;
                if (replaced_by?.trim() && !by) return `No card you proposed is called “${replaced_by.trim()}”. Nothing was withdrawn.`;
                return this.retract(cardId, String(title).trim(), { ...(by ? { by: by.id, title: by.title } : {}), ...(why?.trim() ? { why: clip(why.trim(), 1000) } : {}) });
              },
            },
          ]),
      ...(review
        ? ([
            {
              name: 'findings',
              description: `Record your review's findings for the owner, the whole list as it stands now (you keep it like a brief: call it after your review, and again whenever a finding changes, from the owner's words or a push). Each: a short title, a sentence or two in ${language}, whether it is about security, and its status: open; sent (to the contributor, with the review's url); fixed (by you, committed on your branch; Obeya pushes it with the owner's approval); resolved (a push of the contributor's fixed it, or it no longer applies); dropped (the owner does not pursue it); later (a follow-up task you made with follow_up_task, which Obeya keeps as it is). Give the id of a finding you had; a new one gets the next free number, in the order of the list. with: the ids of the other findings it would make one follow-up task with, should the owner choose that for them: only what one worker would sensibly do in one go (the same cause, the same files), else none. The card shows them beside the demo, bundles together, and the owner decides on each there.`,
              schema: {
                findings: z.array(
                  z.object({
                    id: z.number().int().positive().optional(),
                    title: z.string(),
                    text: z.string(),
                    security: z.boolean().optional(),
                    status: z.enum(['open', 'sent', 'fixed', 'resolved', 'dropped', 'later']).optional(),
                    url: z.string().optional(),
                    with: z.array(z.number().int()).optional(),
                  }),
                ),
              },
              run: ({ findings }) => this.reviews.setFindings(cardId, findings as Parameters<ReviewCards['setFindings']>[1]),
            },
            {
              name: 'follow_up_task',
              description: `Make findings the owner chose as follow-up tasks (or asked for in words) a task of its own, beside your card and following up on it, outside this PR; it waits in the queue behind your card and starts once the PR is merged. findings: the numbers of the findings it is made of, one or several that belong together; title: short and precise, in ${language}; task: what is to be done, in ${language}, written for the agent who will take it on and has seen neither this PR nor your review: what is wrong and why, the files concerned, what done looks like, and the PR's link (${review.url}). Obeya marks those findings later, linking the task.`,
              schema: { findings: z.array(z.number().int()), title: z.string(), task: z.string() },
              run: ({ findings, title, task }) => this.reviews.followUpTask(cardId, String(title).trim(), String(task).trim(), (findings as number[]) ?? []),
            },
            {
              name: 'request_changes',
              description: `Send change requests to ${review.author} as one review of the pull request that asks for changes, posted with the owner's account. body: in the PR's language, as the owner's words to the contributor; findings: the numbers of the findings it holds, which Obeya marks as sent. Then end your turn: the card waits for ${review.author}.`,
              schema: { body: z.string(), findings: z.array(z.number().int()).optional() },
              run: async ({ body, findings }) => {
                const owed = this.reviews.owedTasks(cardId);
                if (owed) return `Not sent: first make the follow-up tasks the owner chose, for ${owed}; then call request_changes again.`;
                const own = fromJson(this.o.board.row(cardId).contribution);
                if (own?.changing || own?.held)
                  return `Not sent: your own changes to the PR wait for the owner's approval, and a request to ${review.author} goes with them as one message. Write it into pr_draft with your handover (ready_for_review): Obeya posts it once the owner approves.`;
                const sent = await this.reviews.requestChanges(cardId, String(body), (findings as number[] | undefined) ?? []);
                if (sent) return sent;
                handOver();
                return ending(
                  `Sent. End your turn now: the card waits for ${review.author}, and Obeya passes you what they answer or push.`,
                  `Sent: the card waits for ${review.author}.`,
                  'a change request in them goes to the contributor the same way, or to you as their switch says',
                );
              },
            },
          ] satisfies AgentTool[])
        : []),
      {
        name: 'pr_opened',
        description:
          'After the owner approved: report the pull request you opened for this card (its URL); where the work also needed one in another repository, report that one too, a call for each. Then end your turn; Obeya watches them, and the card is live once all are merged.',
        schema: { url: z.string() },
        run: ({ url }) => {
          const row = this.o.board.row(cardId);
          if (!row.pr) return 'Not recorded: the owner has not approved this card yet. Do not open a pull request before that.';
          const ref = parsePrUrl(String(url));
          if (!ref) return 'Not recorded: that is not the URL of a pull request (on GitHub or GitHub Enterprise https://<host>/<owner>/<repo>/pull/<number>, on Forgejo or Gitea such as Codeberg https://<host>/<owner>/<repo>/pulls/<number>).';
          handOver();
          const root = fromJson(row.pr);
          // the card's own is the one in its repository, which the landing is about; one in another
          // repository is watched beside it, and reported again (opened again after it was closed) as before
          const host = this.o.remote && remoteHost(this.o.remote)?.toLowerCase().replace(/^ssh\.github\.com$/, 'github.com');
          const elsewhere = !!this.o.remote && (!sameRepo(this.o.remote, ref.owner, ref.repo) || (!!host && host !== ref.host.toLowerCase()));
          const known = elsewhere ? root.more?.find((m) => parsePrUrl(m.url ?? '')?.url === ref.url) : undefined;
          let pr: PrState;
          // the card's own reported again keeps what was told of it; another in its place starts afresh
          if (!elsewhere) pr = parsePrUrl(root.url ?? '')?.url === ref.url || !root.url ? { ...root, url: ref.url, number: ref.number } : { url: ref.url, number: ref.number, seen: [], reported: [], ...(root.more ? { more: root.more } : {}) };
          else if (known) {
            const { closed: _, ...open } = known;
            pr = { ...root, more: root.more!.map((m) => (m === known ? { ...open, url: ref.url } : m)) };
          } else pr = { ...root, more: [...(root.more ?? []), { url: ref.url, number: ref.number, repo: `${ref.owner}/${ref.repo}`, seen: [], reported: [] }] };
          this.o.board.work(cardId, { pr: toJson(pr) });
          this.o.board.log(cardId, 'state', 'worker', this.o.board.t.worker.prOpened(elsewhere ? `${ref.repo} #${ref.number}` : `#${ref.number}`));
          this.o.onPrOpened?.(cardId);
          return ending('Recorded. End your turn now; Obeya watches the pull request.', 'Recorded: Obeya watches the pull request.', 'a change to the work goes onto the pull request');
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it, running the checks and making the demo. The summary (in ${language}) is what this handover tells the owner beyond what the card's conversation already holds: on your first handover, what changed from the user's point of view and what they really need to know (something left open or not verified, a decision you took for them), in a few short paragraphs at most; on a later one, only what your last handover and your replies since have not said yet, often a sentence. Obeya keeps your handovers and replies together as the card's report for whoever reads it later. A problem you noticed outside the task goes to propose_card, not into the summary, as does a follow-up to your task that is due only later (start_at). The demo: a video's directory and chapter titles in scene order, or an HTML artifact's directory, with its report (in the language of its narration); without a new one, the demo already on the card stands. Then end your turn.`,
        schema: {
          summary: z.string(),
          demo: z
            .object({
              kind: z
                .enum(['video', 'html'])
                .optional()
                .describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at, for results that are seen rather than watched happening"),
              dir: z.string().describe('absolute path of the demo: a video holds demo.mp4 and captions.vtt (and a captions.<language>.vtt per subtitle language), an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
              question: z
                .object({
                  text: z.string(),
                  options: z.array(z.string()).max(4).optional(),
                  multiple: z.boolean().optional(),
                  pick: z.array(z.string()).optional(),
                  pick_why: z.string().optional(),
                })
                .optional()
                .describe(
                  `only when something needs the owner beyond approve or feedback${review ? ' or the choice on each finding, which the card offers beside it' : ''}; the owner can answer it on the card before approving. As with ask: up to four short answer options when they exist, which the owner picks with a click (several when multiple is true) or answers in their own words; pick and pick_why: the options you would choose and why, in one short sentence in ${language}`,
                ),
              ...(shares
                ? {
                    page: z
                      .object({
                        title: z.string(),
                        text: z.string(),
                        ...(vocabulary.length
                          ? {
                              tags: z
                                .record(z.string(), z.array(z.string()))
                                .optional()
                                .describe(
                                  `required: for each of these dimensions, the values that fit the change (an empty list where none does), only from those given, so colleagues find the page by them: ${vocabulary.map(([d, v]) => `${d}: ${v.join(', ')}`).join('; ')}`,
                                ),
                            }
                          : {}),
                      })
                      .optional()
                      .describe(
                        `required: the page on which the owner may share the demo (the video, or the HTML artifact below the text) with colleagues, in ${pageLanguage}. They know the product but have never seen Obeya, this card or the plan doc. title: what changes, in a few words; text: two to five sentences on what changes for the user and why, without findings, tests or internal process${vocabulary.length ? '; tags: see there' : ''}`,
                      ),
                    follows: z
                      .enum(['replaces', 'supplements'])
                      .optional()
                      .describe(
                        "when the card has a demo from an earlier handover: 'replaces' if this one shows the change afresh, so a shared page should show it instead; 'supplements' if it only shows what was corrected or explained since, to stand on the shared page beside the one before",
                      ),
                  }
                : {}),
            })
            .optional(),
          ...(review
            ? {
                review: z
                  .object({
                    checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
                    mergeable: z.boolean().describe('the PR merges into the current default branch without conflicts (your merge probe)'),
                  })
                  .optional()
                  .describe("required: the checks on the PR's head and your merge probe; the findings you record with findings"),
                pr_draft: z
                  .string()
                  .optional()
                  .describe(
                    "when your branch holds commits of your own that are not on the PR yet: the text Obeya posts on the PR once the owner approves, after pushing them onto its branch. What you changed and why, in the PR's language, as the owner's words to the contributor, without mentioning Obeya or agents; with findings the owner sends the contributor along with your changes, the request for them in the same text. The card shows it to the owner first, who may edit it there. Without it, the text on the card stands.",
                  ),
              }
            : {}),
          files: z
            .array(z.object({ path: z.string(), caption: z.string() }))
            .max(MAX_RESULT_FILES)
            .optional()
            .describe(
              `the files your card made or changed ${this.folder ? 'in the folder' : 'on your branch'} that are the result for the owner (a document, a report, a spreadsheet, a page; not the code or configuration behind it), each with its path and a one-line caption in ${language}. The card shows them beside the demo: Markdown formatted, a PDF in the browser's viewer, any other file to open on the owner's computer. Without them, the ones named at your last handover stand.`,
            ),
        },
        run: ({ summary, demo, files, review: results, pr_draft: draft }) => {
          // a stopped pull this worker resolved lands as it hands it over, without the owner
          const long = tooLong(String(summary), 6000, 'ready_for_review');
          if (long) return long;
          const resolving = fromJson(this.o.board.row(cardId).landed)?.resolve;
          if (resolving) return this.reviews.landResolved(cardId, resolving);
          type Demo = { kind?: DemoKind; dir: string; chapters?: string[]; question?: { text: string } & Omit<Asked, 'question'>; page?: DemoPage; follows?: 'replaces' | 'supplements' };
          const given = demo as Demo | undefined;
          // whether the branch holds work and decides where it lands, which git tells without blocking the server
          // a review card hands over the PR's head it reviewed, which is all Obeya ever merges
          // with the commits of its own on top of the PR's head, which Obeya pushes on the owner's approval
          const handOverWork = (d: Demo | undefined, named: CardFile[] | undefined, shows: boolean): Promise<string> =>
            review
              ? this.reviews.ownCommits(cardId, review).then((mine) => (typeof mine === 'string' ? mine : handOverNow(d, named, shows, true, undefined, mine)))
              : Promise.all([this.o.workspaces.hasWork(cardId), this.landingOf(cardId)]).then(async ([work, { own }]) =>
                  handOverNow(d, named, shows, work, own, undefined, work && !this.folder ? await this.o.workspaces.changedFiles(cardId) : undefined),
                );
          const handOverNow = (
            d: Demo | undefined,
            named: CardFile[] | undefined,
            shows: boolean,
            work: boolean,
            own: CardLanding | undefined,
            mine?: OwnCommits,
            changed?: string[],
          ): string => {
            // reading what the change shows takes a while, in which the owner may stop or replace the session
            if (this.live.get(cardId) !== live && !live.standIn) return 'This session has ended. Stop working and end your turn.';
            const s = String(summary);
            const row = this.o.board.row(cardId);
            if (row.landed) return 'Not handed over: your work is on main already.';
            if (row.pr && !review) return 'Not handed over: the work is in its pull request, where Obeya follows it.';
            const checked = results as { checks: { name: string; passed: boolean }[]; mergeable: boolean } | undefined;
            if (review && !checked) return "Not handed over: a review card's handover says what the checks and the merge probe found (review). Call ready_for_review again with it.";
            if (review && !fromJson(row.contribution)?.findings) return 'Not handed over: record your findings first (findings; an empty list where your review found nothing), then call ready_for_review again.';
            const owed = review && this.reviews.owedTasks(cardId);
            if (owed) return `Not handed over: first make the follow-up tasks the owner chose, for ${owed}; then call ready_for_review again.`;
            // what goes onto the PR with the owner's approval: the worker's own commits and their text, with the requests to the contributor decided meanwhile
            const held = review && mine ? this.reviews.heldAt(cardId, mine, typeof draft === 'string' ? draft : undefined) : undefined;
            if (typeof held === 'string') return held;
            // approved work that could not land comes back to be landed, not reviewed: its demo stands
            const approved = !!row.approved_at;
            // a handover in answer to the owner's words that brings no new demo is an answer to them, not a demo to watch
            const answered = !d && !!row.detail && !!fromJson(row.detail).answering;
            // without a new demo, the one on the card stands, unless it only came with a question
            const asked = !!row.demo && !!fromJson(row.demo).asked;
            const kept = !d && !!row.demo && !asked;
            // in a folder without git the card's change list shows what changed, where often nothing can be shown on screen
            if (!d && !kept && !approved && !this.folder)
              return `Not handed over: every handover brings a demo${row.demo ? ' (the one you showed with your question is not one)' : ''}. Record it with ${this.brief.demoSkill(cardId)}, or make an HTML artifact when the result is something to look at, then call ready_for_review again with it.`;
            let newDemo: StoredDemo | undefined;
            if (d) {
              const kind = d.kind ?? 'video';
              // what the worker says of it beside the demo before, for the owner's buttons when the page shows that one
              const report = { ...(d.question?.text.trim() ? demoQuestion(d.question) : {}), ...(row.demo && (d.follows === 'replaces' || d.follows === 'supplements') ? { follows: d.follows } : {}) };
              const tags = vocabulary.length && d.page?.tags && typeof d.page.tags === 'object' ? (d.page.tags as PageTags) : undefined;
              const page =
                d.page && d.page.title.trim() && d.page.text.trim() ? { title: clip(d.page.title.trim(), 200), text: clip(d.page.text.trim(), 2000), ...(tags ? { tags: tagsOf(tags, Object.fromEntries(vocabulary)) } : {}) } : undefined;
              if (shares && !page)
                return 'Not handed over: a demo here needs its page (title and text) for colleagues, in case the owner shares it. Call ready_for_review again with demo.page.';
              if (vocabulary.length) {
                const wrong = tags ? outside(tags, Object.fromEntries(vocabulary)) : [];
                const lacking = vocabulary.filter(([dim]) => !tags?.[dim]).map(([dim]) => dim);
                if (wrong.length) return `Not handed over: the page's tags come from the site's alone, and these are not among them: ${wrong.join(', ')}. Call ready_for_review again with demo.page.tags from those its description gives.`;
                if (lacking.length) return `Not handed over: the page's tags lack ${lacking.join(', ')}. Give each dimension its values (an empty list where none fits), then call ready_for_review again.`;
              }
              if (kind === 'html') {
                const wrong = checkArtifact(d.dir);
                if (wrong) return `Not handed over: ${wrong}. Fix the artifact, then call ready_for_review again.`;
                // an artifact that is its index.html alone also goes out as one HTML file
                const single = artifactFiles(d.dir).length === 1;
                newDemo = { kind, dir: d.dir, chapters: [], ...report, ...(page ? { page } : {}), ...(single ? { single } : {}) };
              } else {
                const chapters = readChapters(d.dir, d.chapters ?? []);
                if (typeof chapters === 'string') return `Not handed over: ${chapters}. Fix the demo, then call ready_for_review again.`;
                newDemo = { kind, dir: d.dir, chapters, ...videoFacts(d.dir), ...report, ...(page ? { page } : {}) };
              }
            }
            handOver();
            if (review && checked) {
              const now = fromJson(this.o.board.row(cardId).contribution) ?? review;
              const { requested: _, held: __, changing: ___, ...rest } = now;
              const results = { checks: checked.checks.slice(0, 20).map((c) => ({ name: clip(c.name, 60), passed: !!c.passed })), mergeable: !!checked.mergeable };
              const findings = held && rest.findings?.map((f) => (held.asks.includes(f.id) ? { ...f, withChanges: true as const } : f));
              this.o.board.work(cardId, {
                contribution: toJson({ ...rest, reviewed: mine?.head, results, ...(held ? { held, ...(findings ? { findings } : {}) } : {}) }),
                ...(row.state === 'inPr' ? { state: 'working' } : {}),
              });
              // what the pull after the merge would run into on the local main, for the owner to see before approving
              void this.reviews.probeClash(cardId);
            }
            const report = this.report(cardId, s);
            const e = this.o.board.log(cardId, 'review', 'worker', s);
            // the demo report's question goes with the handover it came with, also once a later one keeps the demo
            if (newDemo) newDemo = { ...this.keep(cardId, e.id, newDemo), handover: e.id, at: e.at };
            // the demo it replaces stays with the card, for the owner to go back to; so do a question's drafts, which are no handover's result
            const demos = (newDemo || asked) && row.demo ? this.earlier(cardId, row) : undefined;
            // approved work does not wait for the owner again: it stays with Obeya until its turn has ended
            this.o.board.work(cardId, {
              // the worker's last status line is about the work it hands over: it would show again once the card is at work
              ...(approved ? { status_line: review ? this.o.board.t.worker.mergingPr(review.number) : this.o.board.t.worker.landing } : { state: 'waiting', need: d || kept ? 'demo' : 'review', status_line: null }),
              // approving work that changes nothing makes the card done, which the owner sees before approving; where work
              // lands that its own branch decides, likewise
              detail: toJson({ summary: report, ...(work ? (own ? { lands: own } : {}) : { noChange: true }), ...(answered && !approved ? { answered: true } : {}) }),
              ...(newDemo ? { demo: toJson(newDemo) } : asked ? { demo: null } : {}),
              ...(demos ? { demos } : {}),
              // the files named stand until a later handover names others (an empty list named clears them); a folder's card handed
              // over without a demo shows what it changed, while there are files of it to show
              ...(named?.length
                ? { files: toJson(named) }
                : this.folder && !d && !kept && (named || !row.files || row.files === '[]')
                  ? { files: shows ? '[]' : null }
                  : named
                    ? { files: null }
                    : {}),
            });
            // the size of the change handed over, for the page to lay out its change list from the first time it opens the card
            void this.diff(cardId, false).catch(() => {});
            const card = this.o.board.item(cardId);
            if (card?.prototypeOf) this.o.onPrototype?.(card, report, newDemo);
            if (approved)
              return review
                ? ending(
                    'Recorded. End your turn now; once it has ended, Obeya pushes your commits onto the pull request and merges it.',
                    'Recorded: once your turn has ended, Obeya pushes your commits onto the pull request and merges it.',
                    'a change to the work is to be committed by then',
                  )
                : ending(
                    'Recorded. End your turn now; once it has ended, Obeya lands your work on main.',
                    'Recorded: once your turn has ended, Obeya lands your work on main.',
                    'a change to the work is to be committed by then',
                  );
            // what the owner's button does, as Obeya sees the branch: the worker may know of no commit on it but its own
            const lands =
              review || this.folder
                ? ''
                : !work
                  ? ' Obeya sees no change on your branch: approving closes the card, and nothing lands.'
                  : changed?.length
                    ? ` Approving lands your branch's change to ${changed.length === 1 ? '1 file' : `${changed.length} files`}: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', …' : ''}.`
                    : '';
            return ending(`${END_TURN}${lands}`, `Recorded: your handover waits for the owner's approval.${lands}`, 'if they change what you handed over, hand it over again');
          };
          // a demo made on another machine is served and shared from its copy here
          const handOverWith = (named?: CardFile[]): string | Promise<string> => {
            if (given && hostName(this.o.board.row(cardId).workspace))
              return this.demoHere(cardId, given.dir).then((here) =>
                'wrong' in here
                  ? `Not handed over: the demo could not be copied to the owner's machine (${here.wrong}). Check the directory, then call ready_for_review again.`
                  : handOverWork({ ...given, dir: here.dir }, named, false),
              );
            // in a folder, what the change has to show decides whether a handover without a demo shows it beside the conversation
            if (this.folder && !given) return this.showsFiles(cardId).then((shows) => handOverWork(given, named, shows));
            return handOverWork(given, named, false);
          };
          // the files named as the result, checked against what the card changed before anything is handed over
          const withFiles = () =>
            files !== undefined
              ? this.namedFiles(cardId, files as { path: string; caption: string }[]).then(async ({ named, left }) => {
                  const result = await handOverWith(named);
                  return left && !result.startsWith('Not ') ? `${result}\n\n${left}` : result;
                })
              : handOverWith();
          // a plan doc for an idea with prototypes says clearly which one it builds on, before it goes to the owner
          const unclear = this.prototypesUnclear(cardId);
          return unclear ? unclear.then((why) => why ?? withFiles()) : withFiles();
        },
      },
      {
        name: 'close_unchanged',
        description: `After the owner approved: your work changed nothing in the repository (no commits, nothing uncommitted), because the task needed no change to the code (a demo, an analysis, an answer). Then nothing lands and there is no pull request to open: this closes the card as done instead. Then end your turn.`,
        schema: {},
        run: async () => {
          const row = this.o.board.row(cardId);
          if (row.landed) return 'Not recorded: the card is finished already.';
          // a review card whose pull request was closed lands nothing, whatever its branch holds
          if (fromJson(row.contribution)?.closed) return [`Recorded: the card is done.`, this.close(cardId, 'worker'), AFTER_LANDING].filter(Boolean).join(' ');
          const work = await this.o.workspaces.hasWork(cardId);
          const pr = fromJson(row.pr);
          if (!row.approved_at && !(pr && !pr.url)) return 'Not recorded: only work the owner approved can be closed, and only before its pull request is open. Hand it over with ready_for_review first.';
          if (work)
            return 'Not recorded: your branch holds commits or uncommitted changes. Work that changes the repository lands (or goes out as a pull request); throw away what is not meant to land first, if nothing is.';
          const page = this.close(cardId, 'worker');
          return [`Recorded: the card is done.`, page, AFTER_LANDING].filter(Boolean).join(' ');
        },
      },
      {
        name: 'after_restart',
        description: 'Only after your work has landed and Obeya said it starts again for it: what remains needs Obeya to run your change. Then end your turn; Obeya tells you once it runs your change.',
        schema: {},
        run: () => {
          const l = fromJson(this.o.board.row(cardId).landed);
          if (!l) return 'Not recorded: your work has not landed.';
          if (!l.restarts) return 'Not recorded: Obeya does not start again for this landing; what runs now is what you get.';
          this.o.board.work(cardId, { landed: toJson({ ...l, waits: true }) });
          this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.waitsForRestart);
          return ending('Recorded. End your turn now.', 'Recorded: Obeya tells you once it runs your change.');
        },
      },
      {
        name: 'snooze',
        description: [
          `Snooze while there is nothing to do until a point in time further off than a background command can wait (a check at midnight, a test that runs for days, a report on the 31st), or until another card on this canvas gets somewhere (its fix is on main, its demo is ready).`,
          `until: that time, ISO 8601 with your timezone's offset (2026-10-31T08:00:00+01:00). card: the title of the card to wait on; state: what it is to reach, 'done' (its work is on main, or it closed without a change; the default) or 'waits_for_owner' (it asks the owner or hands its work over). Give until, card or both: Obeya wakes you at whichever comes first, and also when that card can no longer get there (stopped, archived, removed).`,
          `why: what you do then, in a few words in ${language}, shown on the card. Your session ends with your turn, and whatever you still run in the background with it; workspace and branch stay. Obeya resumes this session then, or earlier with a note from the owner or whatever else comes for you (a review, the landing). For checkpoints one after the other, snooze to the next one each time you wake. Then end your turn.`,
        ].join(' '),
        schema: { until: z.string().optional(), why: z.string(), card: z.string().optional(), state: z.enum(['done', 'waits_for_owner']).optional() },
        run: ({ until, why, card: title, state }) => {
          const card = this.o.board.item(cardId);
          if (!card) return 'Not snoozed: the card is gone.';
          if (live.handedOver) return 'Not snoozed: you asked or handed over in this turn, so the card waits for the owner.';
          // taking in the owner's words on its handover, it may snooze as they ask (check again in three days): the handover stands meanwhile
          if (!(card.state === 'working' || card.state === 'inPr' || card.finishing || answering(card))) return 'Not snoozed: the card waits for the owner; their answer or approval comes as your next message.';
          if (card.pausing) return 'Not snoozed: the owner pauses you; end your turn, and once they let you go on, snooze then if it is still due.';
          const named = typeof until === 'string' && until.trim() !== '';
          const at = named ? Date.parse(String(until)) : NaN;
          const when = named ? laterTime(at) : 'ok';
          if (when === 'none') return 'Not snoozed: give the time as ISO 8601 with your timezone offset (2026-10-31T08:00:00+01:00).';
          if (when === 'past') return `Not snoozed: that time has passed (it is ${new Date().toISOString()} now).`;
          if (when === 'far') return 'Not snoozed: snooze for a year at most.';
          let on: Snooze['on'];
          if (typeof title === 'string' && title.trim()) {
            const found = this.cardTitled(cardId, title.trim());
            if (typeof found === 'string') return `Not snoozed: ${found}`;
            const awaits = state === 'waits_for_owner' ? 'waitsForOwner' : AWAITED_STATES[0];
            const now = awaited(found, awaits);
            if (now === 'reached') return `Not snoozed: the card “${found.title}” ${awaits === 'done' ? 'is done already' : 'waits for the owner already'}.`;
            if (now) return `Not snoozed: the card “${found.title}” cannot get there now (${now}).`;
            on = { card: found.id, title: found.title, state: awaits };
          } else if (!named) return 'Not snoozed: give until, card, or both.';
          live.snoozed = true;
          live.nudged = false;
          const s: Snooze = { ...(named ? { until: new Date(at).toISOString() } : {}), ...(on ? { on } : {}), by: 'agent', ...(String(why).trim() ? { why: clip(String(why).trim(), 200) } : {}) };
          this.o.board.snooze(cardId, s);
          return ending(
            `Snoozed until ${snoozedUntil(s)}. End your turn now; Obeya resumes this session then.`,
            `Snoozed until ${snoozedUntil(s)}: Obeya resumes this session then.`,
            'if they change what you wait for, snooze anew',
          );
        },
      },
      {
        name: 'app_running',
        description: `The app runs in your workspace and opens in a browser: its address as you open it (http://localhost:5173, say), so the owner can open it from the card to try it by hand while it runs. Again each time you start it anew or its address changes; an empty url once you stop it.`,
        schema: { url: z.string() },
        run: ({ url }) => {
          const u = String(url).trim();
          if (!u) {
            this.o.board.work(cardId, { app: null });
            return 'Recorded: the card no longer offers the app.';
          }
          if (!APP_URL.test(u)) return 'Not recorded: give the address as http(s)://host:port/….';
          this.o.board.work(cardId, { app: u });
          return 'Recorded: the card offers the app to the owner while it answers there.';
        },
      },
      ...(this.inWorktree(cardId)
        ? [
            {
              name: 'need_clone',
              description: "Only in a follow-up in a temporary worktree: answering the owner needs a full clone (the repository's app or tooling, which may not run here). Then end your turn; Obeya resumes you in the next free clone.",
              schema: {},
              run: () => {
                const l = fromJson(this.o.board.row(cardId).landed);
                if (!l?.worktree) return 'Not recorded: you work in a full clone already.';
                this.o.board.work(cardId, { landed: toJson({ ...l, needsClone: true }) });
                this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.needsClone);
                return 'Recorded. Tell the owner with reply that you go on once a clone is free, then end your turn: Obeya resumes you in the next free clone.';
              },
            } satisfies AgentTool,
          ]
        : []),
      ...(this.o.toObeya
        ? [
            toObeyaTool((request) => {
              // what Obeya does or replies is shown to the owner as the answer to their words
              live.spoke = true;
              return this.o.toObeya!(cardId, request);
            }),
          ]
        : []),
    ]);
  }

  /**
   * The card's report for whoever reads it beyond its conversation (a follow-up's worker, the
   * Coordinator, a shared page): a later handover holds only what changed, so the first one since
   * the worker started comes with what it said in the conversation after it, its replies and later
   * handovers, `latest` last.
   */
  private report(cardId: string, latest: string): string {
    const events = this.o.board.events(cardId);
    const since = events.slice(events.findLastIndex(started) + 1).filter((e) => e.author === 'worker' && (e.kind === 'review' || e.kind === 'talk'));
    const first = since.findIndex((e) => e.kind === 'review');
    if (first < 0) return latest;
    return [since[first]!.text, this.o.board.t.worker.laterInConversation, ...since.slice(first + 1).map((e) => e.text), latest].join('\n\n');
  }

  /**
   * A tool call that needs a person's permission becomes the question the card waits on; the call
   * runs or is refused with the owner's answer. Meanwhile the worker waits for the owner as after
   * `ask`: a restart need not wait for it.
   */
  private askOwner(cardId: string, live: Live, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const asked = (live.asking ?? Promise.resolve()).then(() => this.askNow(cardId, live, request, signal));
    live.asking = asked.catch(() => {});
    return asked;
  }

  private askNow(cardId: string, live: Live, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const asked: AskedPermission = { name: request.name, input: request.input };
    if (this.granted.get(cardId)?.delete(permissionKey(asked))) return Promise.resolve({ allow: true });
    if (this.live.get(cardId) !== live || signal.aborted) return Promise.resolve({ allow: false, message: 'This session has ended. Stop working and end your turn.' });
    const t = this.o.board.t;
    const q: Question = { text: t.worker.permission(permissionWhat(request.name, request.input, t), request.reason && clip(request.reason, 600)), options: [t.worker.allow, t.worker.deny] };
    this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
    this.wokenForOwner(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: 'question', detail: toJson({ question: q, permission: asked }) });
    this.setBusy(live, false);
    return new Promise((resolve) => {
      live.permission = (answer) => {
        live.permission = undefined;
        this.setBusy(live, true);
        resolve(answer);
      };
      // the session ended (stopped, Obeya restarting): the question stays on the card for the next one
      signal.addEventListener('abort', () => (live.permission = undefined), { once: true });
    });
  }

  /**
   * The card moves on without the owner's answer (its PR merged, a review card's closed) while a tool call of its
   * worker waits for their permission: the call is refused with `why`, so that the worker's turn goes
   * on and it hears what happened, instead of waiting for an answer to a question no longer on the card.
   */
  private refuseAsked(cardId: string, why: string) {
    this.live.get(cardId)?.permission?.({ allow: false, message: `Not run: ${why} If you still need the call, make it again; the owner is asked anew.` });
  }

  /** The boards a card's proposals may be on: this canvas's, then those of the other canvases. */
  private proposalBoards(): Board[] {
    return [this.o.board, ...this.otherBoards()];
  }

  private otherBoards(): Board[] {
    return (this.o.otherBoards?.() ?? []).filter((b) => b !== this.o.board);
  }

  /**
   * The repository a worker names for its proposal (by id, name or path) and the board of its
   * canvas: this canvas's first, then another canvas's; or why there is none.
   */
  private proposalRepo(wanted: string): { board: Board; repo: string } | string {
    const w = wanted.toLowerCase();
    const dir = (path: string) => path.replace(/[/\\]+$/, '');
    const named = (r: RepoRef) => r.id.toLowerCase() === w || r.name.toLowerCase() === w || dir(r.path) === dir(wanted);
    const here = this.o.board.canvas.repos.find(named);
    if (here) return { board: this.o.board, repo: here.id };
    const found = this.otherBoards().flatMap((board) => board.canvas.repos.filter(named).map((r) => ({ board, repo: r.id, path: r.path })));
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return `Not proposed: several canvases have a repository ${wanted}; give its path instead: ${found.map((f) => f.path).join(', ')}.`;
    const all = this.proposalBoards().flatMap((b) => b.canvas.repos.map((r) => r.id));
    return `Not proposed: Obeya has no repository ${wanted}; give one of ${all.join(', ')}.`;
  }

  /** The worker takes back one of its proposals by title, or marks it replaced (`s.by`): what became of it, as the tool's result. */
  private retract(cardId: string, title: string, s: Superseded): string {
    // the proposal may be on another canvas: where none of this card's has the title, the next one is asked
    const mine: Extract<Retracted, { kind: 'unknown' }>['mine'] = [];
    let r: Retracted = { kind: 'unknown', mine };
    for (const b of this.proposalBoards()) {
      const there = b.retract(cardId, title, s);
      if (there.kind !== 'unknown') {
        r = there;
        break;
      }
      mine.push(...there.mine);
    }
    if (r.kind === 'gone' || r.kind === 'marked') this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.withdrewProposal(r.title, s.why, s.title));
    return retractedText(r, !!s.by);
  }

  private toOwner(cardId: string, q: Question) {
    this.wokenForOwner(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: 'question', detail: toJson({ question: q }) });
  }

  /**
   * The card needs the owner now (its pull request closed, a tool call to allow): a snooze of its
   * worker's is over, so the card reaches them. One the owner snoozed stays paused, holding what
   * came for it meanwhile, until their answer lets it go on.
   */
  private wokenForOwner(cardId: string) {
    const s = this.o.board.snoozedOf(cardId);
    if (s && !s.waiting) this.o.board.unsnooze(cardId, 'needsYou');
  }

  private pendingQuestion(cardId: string): string | undefined {
    return this.o.board
      .events(cardId)
      .filter((e) => e.kind === 'question')
      .at(-1)?.text;
  }

  /** The owner's answer to the question `q`: in the card's log, as a decision, and for whoever learns from it. */
  private recordAnswer(card: Item, q: string, text: string, images: string[], replyTo: number | undefined, picks: string[], place?: Spot) {
    this.o.board.log(card.id, 'answer', 'owner', text, { images, replyTo, picks, ...(place ? { spot: place } : {}) });
    this.o.board.decide({ project_id: card.parent ?? null, card_id: card.id, question: q, answer: text || '(Screenshot)', by: 'owner' });
    if (text) this.o.onOwnerInput?.(card, 'answer', text, { question: q });
    if (card.prototypeOf) this.o.onPrototypeAnswer?.(card, q, text || '(Screenshot)');
  }

  /** The card's question is settled: it goes back to its work, in its pull request, or finished (`done` when nothing landed, else `live`). */
  private backToWork(cardId: string) {
    const row = this.o.board.row(cardId);
    const landed = fromJson(row.landed);
    // a review card has its pull request from the start: it waits in it only for the contributor
    const contribution = fromJson(row.contribution);
    const inPr = !!row.pr && (!contribution || !!contribution.requested);
    this.o.board.work(cardId, { state: landed ? (landed.unchanged ? 'done' : 'live') : inPr ? 'inPr' : 'working', need: null, detail: null });
  }

  /** The task the card's worker gets at its start, as Obeya would send it now (one that already ran goes on from its branch). */
  startBrief(card: Item): string {
    const row = this.o.board.row(card.id);
    return this.brief.briefing(card, row.branch ?? branchName(card.title, card.id), !!row.branch);
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

const permissionKey = (p: AskedPermission) => JSON.stringify([p.name, p.input]);
