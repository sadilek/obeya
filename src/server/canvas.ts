// One canvas and everything that works on it: its repositories (each with adapter, workspaces,
// workers, project agents and PR watcher), the board, the Koordinator and the voice commands.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defaultsFor, hasAdapterModule, readingAdapterModule, readingShared, readShared, readSharedFiles, repoValues, type SharedRead, withSettings } from '../adapters';
import { Answers, answersDir, answerTag } from './answers';
import { demoDirectory, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { demoFile } from './demo-page';
import { openWithSystem } from './machine';
import { repoName } from '../adapters/generic';
import type { DemoSite, RepoAdapter, RepoInfo } from '../adapters/types';
import type { CardDiff } from '../core/diff';
import type { Language } from '../core/locale';
import { AGENT_DEFAULTS, agentListens, type AgentRole, awaited, type Awaited, type AgentSetting, buildableOn, type CanvasConfig, prototypeWorkstream, type CardAction, untouched, type CardPatch, type ConfigProblemCode, finished, type Item, layerSettings, nameless, needsYou, NEW_REPO_HOLD_MS, pausable, halted, snoozable, SNOOZE_LIMIT, type PendingRestart, plannableAsProject, plannedToStart, type RepoConfig, type RepoRef, repoShape, type ProposedSetting, type RepoSettings, type SettingsShared, SHARED_FIELDS, type SharedSettings, type Skill, type SpotInput, type TrustGroup } from '../core/types';
import { holdsNotes } from '../core/queue';
import { BadRequest, Board, pathOfRef, replyNote, type StoredContribution } from './board';
import type { ChangeRoute } from '../core/types';
import { type Command, Commander } from './commands';
import type { Config } from './config';
import type { Store } from './db';
import { Explorers } from './explorers';
import { Files } from './files';
import { Images, MAX_IMAGES } from './images';
import { makeRepo, newRepoPath, realPath } from './new-repo';
import { type ContributionInfo, type Forge, parsePrUrl, sameRepo } from './forge';
import { Koordinator } from './koordinator';
import { WorkRetro } from './work-retro';
import { PrWatcher } from './pr-watcher';
import { branchCommit, readingDefaultBranch, ReadTree, refsSeal } from './read-tree';
import { Revisions } from './revisions';
import { ProjectAgents } from './project-agents';
import { ghHosts, onGitHub, outsidePlanDir, readPlanDocs, watchPlanDocs } from './repo';
import { boundsOf, GAP, type Place, planDirNoteBox, unionBounds } from '../core/layout';
import { type AgentRuntime, idleRuntime, withAgentSetting, withLimitWait, withRepoTrust } from './runtime';
import { commandsOf, heldGroups, withoutHeld } from './trust';
import { Skills } from './skills';

/** The skill lists of all canvases: several share a repository, and the user's skills are the same on each. */
const sharedSkills = new Skills();
import { OBEYA_PLUGIN } from './demo';
import { changesCode, RESTART_PATIENCE_MS, whenIdle } from './self-update';
import { Sharing, siteIncomplete } from './share';
import { siteMissing, siteName } from './site';
import { allowedHere, approvedHere, personalDemoSite, readPersonal } from './personal-site';
import { dimensions } from '../core/page-tags';
import { type DueRestart, Workers } from './workers';
import { branchSetting, type CardWorkspaces, defaultBranch, type FileAt, detectingBranch, gitCalls, gitOrNull, type GitSteps, gitSteps, gitStepsSync, isFolder, type Landed, markFolder, readingBranches, together, useBranchSetting, Workspaces } from './workspaces';
import { FolderWorkspaces } from './folder';
import { claudeToken, githubToken, hostName, registerHost } from './hosts';
import { clip, messageOf, oneLine } from '../core/text';
import { type WishDraft, type WishInput, writeWish } from './wish';

export type { CanvasConfig, RepoConfig };

export interface CanvasDeps {
  store: Store;
  /** Obeya's data directory (workspaces live under it). */
  home: string;
  runtime: AgentRuntime;
  /** The skills the cards' agents know (`skillsOf`); Claude Code on this machine tells, when left out. */
  skills?: Skills;
  /** Runs the cards' workers; `runtime` when left out. */
  workerRuntime?: AgentRuntime;
  /**
   * No agent works on a started card (`idleRuntime`, for a scratch Obeya): a script stands in for a
   * card's agent instead (`standIn`).
   */
  idleWorkers?: boolean;
  forge: Forge;
  permissionMode?: PermissionMode;
  /** Watch plan docs and pull requests; off in tests. */
  watch?: boolean;
  /** Propose the card that fills in a repository's settings where it has none (`proposeSetup`); off in tests not about it. */
  setupProposals?: boolean;
  /** How long a voice command waits for undo. */
  commandDelayMs?: number;
  /** How long building or starting a card in a new repository waits for undo; NEW_REPO_HOLD_MS when left out. */
  newRepoHoldMs?: number;
  /** The checkout this Obeya runs from, when it starts again for new code there (self-update.ts). */
  ownCheckout?: string | null;
  /** Obeya's configuration, which the Koordinator reads and changes on the owner's word. */
  config?: Config;
  /** How long the owner stops typing in a card before what they wrote counts as written. */
  writingPauseMs?: number;
  /** Added to every worker's environment (`OBEYA_URL`). */
  workerEnv?: Record<string, string>;
  /** How long a waiting card's app runs on before it is stopped (Parking); five minutes when left out. */
  parkGrace?: number;
  /** How often the watcher looks at open pull requests; two minutes when left out. */
  prPollMs?: number;
  /** The language of Obeya's interface now (`ownerLanguage`): its own words; German when left out (the tests). */
  language?: () => Language;
  /** The owner's conversation language now (`conversationLanguage`): the agents', until the owner's words say otherwise; the interface's when left out. */
  conversation?: () => Language;
  /** How long after the usage limit lifts the agents that wait for it go on; ten seconds when left out. */
  limitMargin?: number;
  /** The model and effort of a group of agents (`agentSetting`), asked whenever one starts; the defaults when left out. */
  agents?: (role: AgentRole) => AgentSetting;
  /** How long a restart of a repository's agents waits for them to pause at most; Obeya's patience for a restart when left out. */
  restartPatienceMs?: number;
  /** How often that restart looks whether they paused; every two seconds when left out. */
  restartIntervalMs?: number;
  /**
   * The settings the owner set for a repository on this machine, by its path, read whenever one is
   * used (`Config.repoSettings`); those the canvas started with when left out.
   */
  settings?: (repoPath: string) => RepoSettings | undefined;
  /** The canvas stopped while it ran: its home repository no longer starts (`Canvases` leaves it out). */
  stopped?: (c: CanvasRuntime, why: string) => void;
  /** The canvases that run now, this one among them (`Canvases`): a card goes to another one, or Obeya makes one there. */
  canvases?: () => CanvasRuntime[];
}

/**
 * A canvas or one of its repositories that does not run as the configuration has it, by their ids,
 * with why: a repository left out of its canvas (`repo`), or one that runs on as it was set up
 * before (`before`); without `repo`, the canvas is left out (its home repository did not start).
 */
export interface StartFailure {
  canvas: string;
  repo?: string;
  detail: string;
  before?: true;
}

/** The home repository of a canvas did not start: the canvas does not run. */
class HomeDown extends Error {
  constructor(
    readonly canvas: string,
    cause: unknown,
  ) {
    super(messageOf(cause));
  }
}

export interface RepoRuntime {
  ref: RepoRef;
  info: RepoInfo;
  adapter: RepoAdapter;
  /** The demo site of its settings, where its demos are shared; null where they go to the owner's personal site, or are exported. */
  site: DemoSite | null;
  /** Its forge says it is public: its demos may go to the owner's personal site without the owner's tick. */
  isPublic?: boolean;
  /** Its Lesestand: the default branch, where plan docs are read and the agents that only read work. */
  read: ReadTree;
  workspaces: CardWorkspaces;
  workers: Workers;
  projectAgents: ProjectAgents;
}

/** A repository as the canvas runs it, with what it was set up by and what stops what it set up. */
interface Repo extends RepoRuntime {
  /** Its entry in the configuration. */
  config: RepoConfig;
  /** Stops its Lesestand and the retries for clones on other machines. */
  stops: (() => void)[];
  /** Stops watching its plan docs. */
  docs?: () => void;
  /** Its plan docs as last read from its Lesestand: what the canvas shows while git moves the Lesestand. */
  planDocs?: ReturnType<typeof readPlanDocs>;
  /** Watches its pull requests, once its work went out as one; it stays for those still open. */
  prs?: PrWatcher;
  /** What the configuration's problems of the repository are read from on its default branch, as last seen (`problemSources`). */
  problemSources?: string;
  /** The resolved configuration it was set up by, and its place there: what it starts again with where a new one fails. */
  from: { resolved: Resolved; index: number };
  /** Its settings read again (`moved`), the last of those under way. */
  moving?: Promise<unknown>;
}

/**
 * A restart of some repositories' agents that waits for them to pause (their configuration
 * changed where they work, or they leave the canvas): the repositories by path, why, and until when
 * at most.
 */
interface RepoRestart {
  paths: Set<string>;
  reason: 'config' | 'repository';
  deadline: number;
  /** The cards it waits for, as the page was last told. */
  waiting: string[];
  stop: () => void;
}

/** How long a host that could not be reached at start (or failed to clone) waits before Obeya tries again. */
const HOST_RETRY_MS = 2 * 60_000;
/** How often Obeya looks for snoozed cards whose time has come. */
const WAKE_EVERY_MS = 15_000;

/** The owner's actions on a card that change only the board: they go also while its repository does not run on the canvas. */
/** What waits while a card's new repository is about to be made (`NewRepo.due`): every other way on. */
const DUE_REFUSES: CardAction['action'][] = ['start', 'force', 'build', 'planDoc', 'splitOff', 'prototype', 'snooze', 'startAt', 'accept'];

const BOARD_ONLY: CardAction['action'][] = ['name', 'dequeue', 'reorder', 'startAt', 'dismiss', 'keep', 'park', 'drop'];

/** The card's repository does not run on the canvas: nothing goes to its agents (`Item.repoDown`). */
const repoDown = (card: Item) => new BadRequest('repoDown', `the repository ${card.repo} of the card does not run on this canvas`);

/** New repositories being made, one after the other (`makeNewRepo`). */
let making: Promise<unknown> = Promise.resolve();

export class CanvasRuntime {
  readonly board: Board;
  readonly koordinator: Koordinator;
  /** The Arbeitsrückschau: friction in the workers' runs, made into proposals. */
  readonly workRetro: WorkRetro;
  readonly commander: Commander;
  readonly explorers: Explorers;
  /** Screenshots the owner attaches to what they write. */
  readonly images: Images;
  /** The other files the owner dropped into what they write, whose paths the agents get. */
  readonly files: Files;
  readonly answers: Answers;
  readonly revisions: Revisions;
  /** The skills of the cards' agents, by repository. */
  private readonly skills: Skills;
  /** Demos shared with colleagues, on the demo site of the card's repository. */
  readonly sharing: Sharing;
  /** Its repositories, the home one first. */
  readonly repos: Repo[] = [];
  /** Its configuration as it runs now (the home repository first). */
  private config: CanvasConfig;
  /** By repository's path: what takes back where the main branch the owner set is read. */
  private branchSettings = new Map<string, () => void>();
  /** By repository's path: its `.obeya/settings.json` as the Lesestand last had it. */
  private shared = new Map<string, SharedRead>();
  /** By repository's path: its commands that do not count until the owner confirms them, as last worked out (`heldOf`). */
  private held = new Map<string, TrustGroup[]>();
  /** By repository's path: whether its main branch had an adapter module as the configuration was last resolved, which a repository starting takes. */
  private adapterModules = new Map<string, boolean>();
  /** The restart of some repositories' agents that waits, if one does. */
  private pending: RepoRestart | null = null;
  /** Set once the canvas stopped because its home repository did not start again. */
  private stopped = false;
  /** Set once the canvas shut down: what git reads for it after that changes nothing. */
  private shutDown = false;
  /** By repository's id: why it does not run as the configuration has it (`StartFailure`). */
  private failed = new Map<string, { detail: string; before?: true }>();
  /** The restart of all of Obeya that waits, if one does: it covers the repositories' too. */
  private obeyaDue: DueRestart | null = null;
  /** The owner paused the canvas's agents (kept across restarts, `paused` of its stored settings): cards the Koordinator lets start wait until they resume them. */
  private paused = false;
  private pendingListeners = new Set<() => void>();
  /** Set while the canvas leaves the configuration: called once its agents paused and it stopped. */
  private retiring: (() => void) | null = null;
  /** What the owner last said or typed to each card's agent, for the Koordinator to read beside a request the agent passes on. */
  private said = new Map<string, { text: string; spoken: boolean }>();
  /** Cards the owner is writing in, with their text before; a pause in typing hands it to the learner. */
  private writing = new Map<string, { before: string; timer: ReturnType<typeof setTimeout> }>();
  /**
   * The part of the canvas the owner last had in view in a page (its middle and its bounds): a new
   * card that comes without a place of its own (passed on by an agent, say) goes there.
   */
  inView: Place | undefined;

  constructor(config: CanvasConfig, private deps: CanvasDeps) {
    const agents = deps.agents ?? ((role: AgentRole) => AGENT_DEFAULTS[role]);
    // the agents other than workers and Obeya's chat wait for the usage limit through it, each where it shows
    const runtime = (r: AgentRuntime) => withLimitWait(withRepoTrust(withAgentSetting(r, agents), this.claudeHeld), deps.limitMargin);
    const workerRuntime = deps.workerRuntime ?? (deps.idleWorkers ? idleRuntime : undefined);
    deps = { ...deps, runtime: runtime(deps.runtime), ...(workerRuntime ? { workerRuntime: runtime(workerRuntime) } : {}) };
    this.deps = deps;
    this.skills = deps.skills ?? sharedSkills;
    // the main branch the owner set counts from the start: the repository's id, its settings and its Lesestand go by it
    for (const r of config.repos) this.useBranch(r);
    this.config = config;
    const resolved = this.resolve(config);
    const { id, name, repos, stored } = resolved;
    this.config = resolved.config;
    const images = (this.images = new Images(join(deps.home, 'images', id)));
    this.files = new Files(join(deps.home, 'files', id));
    this.board = new Board(
      deps.store,
      { id, name, repos: [] },
      () => this.planDocs(),
      images,
      (repo, commit) => !!this.repos.find((r) => r.ref.id === repo)?.read.holds(commit),
      deps.language,
      deps.conversation,
    );
    const board = this.board;
    if (!stored) deps.store.setSetting(id, 'home_repo', repos[0]!.ref.id);
    if (deps.store.setting(id, 'paused') === '1') this.showPaused(true);

    this.workRetro = new WorkRetro({
      board,
      runtime: deps.runtime,
      pathFor: (repo) => (this.repos.find((r) => r.ref.id === repo) ?? this.repos[0]!).read.path,
      settingsFor: this.settingsNow,
      repoLanguage: (repo) => (this.repos.find((r) => r.ref.id === repo) ?? this.repos[0]!).adapter.language,
    });
    board.showSettings(this.settingsNow);
    // the Koordinator needs the workers, and the workers ask it: it is set right after them
    repos.forEach((x, i) => {
      try {
        this.addRepo(this.startRepo(resolved, i));
      } catch (e) {
        // without its home repository the canvas does not start; another one is left out, its cards kept
        if (i === 0) throw new HomeDown(id, e);
        console.error(`Obeya: ${x.read.info.path} does not start, left out of the canvas ${id}: ${messageOf(e)}`);
        this.fail(x.ref.id, e);
      }
    });
    board.showPools(() =>
      this.repos
        .filter((r) => r.workspaces.pooled)
        .map((r) => ({
          repo: r.ref.id,
          hosts: r.workspaces.pool(r.workers.inTurn()).map((h) => ({
            ...h,
            // what the owner may take from its card for a card waiting for one, and what goes once the undo window is through
            workspaces: h.workspaces.map((w) =>
              !w.card ? w : this.koordinator?.evicting(w.card) ? { ...w, leaving: true as const } : r.workers.evictable(w.card) ? { ...w, takeable: true as const } : w,
            ),
          })),
        })),
    );
    for (const r of this.repos) r.workers.resumeAll();
    const koordinator = (this.koordinator = new Koordinator({
      board,
      runtime: deps.runtime,
      home: () => this.repos[0]!.read.path,
      paused: () => this.paused,
      repoFor: (card) => {
        const r = this.repoOf(card);
        return { workers: r.workers, workspaces: r.workspaces, adapter: r.adapter, path: r.read.path, folder: !!r.info.folder };
      },
      imageFiles: this.imageFiles,
    }));
    koordinator.resume();
    // a card whose page closed before Obeya named it
    for (const i of board.items()) if (i.state === 'planned' && !i.queue && nameless(i)) void koordinator.name(i.id);
    this.explorers = new Explorers({
      board,
      runtime: deps.runtime,
      preferences: this.preferences,
      pathFor: (card) => this.repoOf(card).read.path,
      repoLanguage: (card) => this.repoOf(card).adapter.language,
      onOwnerInput: (card, text) => koordinator.learn(card, 'idea', text),
      imageFiles: this.imageFiles,
      onReplied: (cardId, replied) => this.replied(cardId, replied),
      toObeya: this.toObeya,
      ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
    });
    this.explorers.resumeAll();
    this.answers = new Answers({
      board,
      runtime: deps.runtime,
      preferences: this.preferences,
      // a question about a card whose repository does not run is looked up in the home repository
      pathFor: (card) => (card && this.runs(card) ? this.repoOf(card) : this.repos[0]!).read.path,
      startBrief: (card) => (this.runs(card) ? this.repoOf(card).workers.startBrief(card) : undefined),
      projectAgent: (project) => this.repoOf(project).projectAgents,
      ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
      dirOf: (thread) => answersDir(deps.home, id, thread),
      imageFiles: this.imageFiles,
      toObeya: this.toObeya,
      onAnswer: (talk, question, answer) => {
        // looked up for an action: the Koordinator takes it now, hearing the answer with it
        if (this.commander.answerIn(talk)) return;
        // asked in a project's sheet, the question went to its project agent without Obeya reading it
        const sheet = board.exchange(talk)?.askedIn;
        const project = sheet ? board.item(sheet)?.title : undefined;
        this.commander.tell(
          project !== undefined
            ? `The owner asked the project agent of "${project}" in its sheet: „${question}“. Its answer ${answerTag(talk)} was shown to them there: ${answer}`
            : `The answer ${answerTag(talk)} you looked up for the owner's question „${question}“ came in and was shown to them: ${answer}`,
        );
      },
    });
    this.commander = new Commander({
      board,
      runtime: deps.runtime,
      cwd: this.repos[0]!.read.path,
      execute: (c) => this.run(c),
      imageFiles: this.imageFiles,
      lookUp: (talk) => this.answers.lookUp(talk),
      onOwnerInput: (card, kind, text, reply) => this.koordinator.learn((card && board.item(card)) || null, kind, text, { reply }),
      ...(deps.config ? { config: deps.config } : {}),
      canvases: () => (deps.canvases?.() ?? []).filter((c) => c !== this).map((c) => ({ id: c.id, name: c.board.canvas.name })),
      agentSetting: () => agents('koordinator'),
      ...(deps.commandDelayMs !== undefined ? { delayMs: deps.commandDelayMs } : {}),
    });
    board.interruptTalk();
    // the undo window of a new repository is not kept across a restart: the card stays as it was
    for (const i of board.items()) if (i.newRepo?.due) board.setNewRepo(i.id, { ...i.newRepo, due: undefined });
    this.commander.resume();
    this.answers.resumeAll();
    this.revisions = new Revisions({
      board,
      runtime: deps.runtime,
      preferences: this.preferences,
      pathFor: (card) => this.repoOf(card).read.path,
      imageFiles: this.imageFiles,
      toObeya: this.toObeya,
      onRevised: (cardId, revised) => this.revised(cardId, revised),
    });
    this.revisions.resume();
    this.sharing = new Sharing({
      board,
      runtime: deps.runtime,
      home: deps.home,
      forge: deps.forge,
      // the site of a repository not running is not known meanwhile
      sourceFor: (card) => {
        const r = this.runs(card) ? this.repoOf(card) : undefined;
        return r ? { site: r.site, repo: r.info.path, ...(r.isPublic ? { isPublic: true } : {}) } : null;
      },
      languageFor: (card) => (this.runs(card) ? this.repoOf(card).adapter.demo?.language : undefined),
      onPage: (cardId, r) => {
        const card = board.item(cardId);
        if (card && this.runs(card)) this.repoOf(card).workers.pageSettled(cardId, r);
      },
    });
    this.sharing.resume();
    // the pages without tags the Koordinator's sheet offers to tag, by each repository's site
    board.showVocabulary((repo) => {
      const site = this.repos.find((r) => r.ref.id === repo)?.site;
      return site && dimensions(site.tags).length ? site.tags : undefined;
    });
    // snoozed cards wake at their time: one that passed while Obeya was not running, or the machine slept, at once
    this.wakeDue();
    this.waker = setInterval(() => this.wakeDue(), WAKE_EVERY_MS);
    this.waker.unref?.();
    // a card another waits on may pass through the state it waits for between two ticks (asked, and answered at once)
    const unwake = board.onChange(() => {
      if (this.wakeSoon) return;
      this.wakeSoon = setTimeout(() => {
        this.wakeSoon = undefined;
        this.wakeDue();
      }, 0);
    });
    const uncount = board.onChange(() => this.countAgents());
    this.unwatch = () => {
      unwake();
      uncount();
    };
    this.countAgents();
  }

  /** Looks for snoozed cards whose time has come. */
  private waker: ReturnType<typeof setInterval>;
  /** A look for snoozed cards to wake after the board changed, and the subscription to its changes. */
  private wakeSoon: ReturnType<typeof setTimeout> | undefined;
  private unwatch: () => void;

  /** Wakes the snoozed cards whose time has come by `now`, and those whose card they wait on got there (or no longer can); so too the steps the Koordinator waits on cards for. */
  wakeDue(now = Date.now()) {
    const items = this.board.items();
    // and the Koordinator takes up the steps it waited on cards for
    this.commander.due(items);
    for (const i of items) {
      // one whose repository does not run wakes once it is back
      if (!i.snoozed || i.repoDown) continue;
      const on = i.snoozed.on;
      const met = on ? awaited(items.find((x) => x.id === on.card), on.state) : null;
      if (!met && !(i.snoozed.until && Date.parse(i.snoozed.until) <= now)) continue;
      try {
        this.wake(i.id, true, met ?? undefined);
      } catch (e) {
        console.error(`waking the card ${i.id}:`, e);
      }
    }
  }

  /**
   * The owner snoozes a card until `until` (ISO): one waiting for them leaves them until then, and
   * nothing goes to its agent; one at work has its worker stop until then; a planned one starts
   * then. A snoozed card gets the new time.
   */
  private snooze(cardId: string, until: unknown) {
    const iso = this.until(until);
    const card = this.board.item(cardId);
    if (!card || !snoozable(card)) throw new BadRequest('notSnoozable', 'the card is neither planned, at work nor waiting for the owner');
    if (card.snoozed?.waiting || (!card.snoozed && needsYou(card))) return this.board.snooze(cardId, { ...(card.snoozed ?? { by: 'owner', waiting: true }), until: iso }, 'owner');
    if (card.snoozed?.start || (!card.snoozed && plannedToStart(card))) return this.board.snooze(cardId, { ...(card.snoozed ?? { by: 'owner', start: true }), until: iso }, 'owner');
    this.repoOf(cardId).workers.snooze(cardId, iso);
  }

  /** A time to snooze until or start at, as ISO: within the coming year. */
  private until(until: unknown): string {
    const at = typeof until === 'string' ? Date.parse(until) : NaN;
    if (Number.isNaN(at) || at <= Date.now() || at > Date.now() + SNOOZE_LIMIT) throw new BadRequest('snoozeTime', 'until must be a time within the coming year');
    return new Date(at).toISOString();
  }

  /**
   * A snoozed card wakes: at its time (`timeUp`), as the card it waits on got there or no longer can
   * (`met`), or as the owner wakes it now. One that waited for the owner waits for them again; a
   * worker goes on; a planned one goes to the Koordinator as if started now.
   */
  private wake(cardId: string, timeUp: boolean, met?: Awaited) {
    const card = this.board.item(cardId);
    if (!card?.snoozed) throw new BadRequest('notSnoozed', 'the card is not snoozed');
    if (card.snoozed.waiting) return void this.board.unsnooze(cardId, timeUp ? 'time' : 'owner');
    if (card.snoozed.start) {
      this.repoOf(cardId).workers.startsNow(cardId, timeUp);
      // one to be started in a new repository makes it first
      if (card.newRepo) return this.intoNewRepo(cardId);
      return this.koordinator.request(cardId);
    }
    this.repoOf(cardId).workers.wake(cardId, timeUp, met);
  }

  get id() {
    return this.board.canvas.id;
  }

  private preferences = () => this.board.preferencesText();

  /** What an agent passes on to Obeya (`forward`). */
  private toObeya = (cardId: string, request: string) => this.forward(cardId, request);

  /** The settings of a repository the Arbeitsrückschau may propose a value for, as they apply now. */
  private settingsNow = (repo: string): Record<ProposedSetting, string | string[]> | undefined => {
    const a = this.repos.find((r) => r.ref.id === repo)?.adapter;
    return a && { checks: a.checks ?? [], setup: a.setup ?? '', softPaths: a.softPaths, run: a.app?.run ?? '' };
  };

  private imageFiles = (ids: string[] = []) => ids.flatMap((i) => this.images.path(i) ?? []);

  /** The settings the owner set for a repository on this machine, read whenever they are used. */
  private settingsOf = (r: RepoConfig): (() => RepoSettings | undefined) => (this.deps.settings ? () => this.deps.settings!(resolve(r.path)) : () => r.settings);

  /**
   * The repository's settings for everyone, as its Lesestand last had them (read again whenever it
   * moves, `reread`), without the commands that wait for the owner's confirmation (`heldOf`).
   */
  private sharedOf = (path: string): (() => SharedSettings | undefined) => {
    if (!this.shared.has(path)) this.shared.set(path, readShared(path));
    return () => withoutHeld(this.shared.get(path)!.settings, this.heldOf(path));
  };

  /**
   * The groups of the repository's commands that do not count until the owner confirms them: new
   * or changed on its default branch since (`heldGroups`). Worked out again whenever it moves or
   * its settings are saved (`moved`).
   */
  private heldOf(path: string): TrustGroup[] {
    let held = this.held.get(path);
    if (!held) {
      // the configuration as it runs may not have a repository new on the canvas yet; the file has it
      const mine = this.deps.settings ? this.deps.settings(path) : this.config?.repos.find((r) => resolve(r.path) === path)?.settings;
      held = heldGroups(commandsOf(this.shared.get(path)), this.deps.store.trustedCommands(path), mine);
      this.held.set(path, held);
      if (held.length) console.warn(`Obeya: ${path}: ${held.join(', ')} of its settings wait for the owner's confirmation in Konfiguration (held)`);
    }
    return held;
  }

  /**
   * Whether an agent working in `cwd` works in a repository of the canvas (its checkout, its
   * Lesestand, a workspace of it; the most specific, since the home repository's workspaces hold
   * the others') whose own Claude Code configuration waits for the owner's trust. As the default
   * branch has it now, not as the canvas last read it: a commit there that the canvas did not notice
   * (on the checkout's main, from outside Obeya) is in the files the session reads. Agents start
   * often, many at once when work lands: what was read stands while the repository's refs did not
   * move (`refsSeal`), and git reads it again without the server waiting for it.
   */
  private claudeHeld = (cwd: string): boolean | Promise<boolean> => {
    const depth = (dir: string) => (cwd === dir || cwd.startsWith(dir.endsWith(sep) || dir.endsWith('/') ? dir : `${dir}${dir.includes('://') ? '/' : sep}`) ? dir.length : -1);
    let best: { r: Repo; at: number } | undefined;
    for (const r of this.repos)
      for (const dir of [r.info.path, r.read.path, r.workspaces.dir, ...r.workspaces.list().map((w) => w.path)]) {
        const at = depth(dir);
        if (at >= 0 && (!best || at > best.at)) best = { r, at };
      }
    if (!best) return false;
    const path = best.r.info.path;
    const mine = this.deps.settings ? this.deps.settings(path) : best.r.config.settings;
    const trusted = this.deps.store.trustedCommands(path);
    const held = (read: SharedRead) => heldGroups(commandsOf(read), trusted, mine).includes('claude');
    // a folder without git is read as it is
    if (best.r.info.folder) return held(readSharedFiles(path));
    const seal = refsSeal(path);
    const known = this.defaultRead.get(path);
    const read = seal && known?.seal === seal ? known.read : this.readSettings(path);
    return read instanceof Promise ? read.then((r) => held(r.shared)) : held(read.shared);
  };

  /**
   * By repository's path: what its default branch had when last read (`claudeHeld`, `moved`), or as
   * it is being read, under the seal its refs had before (`refsSeal`).
   */
  private defaultRead = new Map<string, { seal: string; read: DefaultRead | Promise<DefaultRead> }>();

  /** Keeps `read`, read from the default branch after its refs had `seal`; a read since (another seal) is not undone. */
  private readAt(path: string, seal: string, read: DefaultRead | Promise<DefaultRead>) {
    const entry = { seal, read };
    this.defaultRead.set(path, entry);
    if (read instanceof Promise) void read.then((r) => this.defaultRead.get(path) === entry && this.defaultRead.set(path, { seal, read: r }), () => this.defaultRead.get(path) === entry && this.defaultRead.delete(path));
  }

  /**
   * What a configuration of this canvas amounts to, with this machine's settings and the
   * repositories' (`resolveCanvas`): those of a repository new here as its read has them.
   */
  private resolve(config: CanvasConfig) {
    return resolveCanvas(config, this.deps.store, this.settingsOf, this.sharedOf, (path, folder) => {
      const seal = folder ? null : refsSeal(path);
      const read = readRepo(path, folder);
      if (read && seal) this.readAt(path, seal, { shared: read.shared, adapterModule: read.adapterModule });
      if (read && !this.shared.has(path)) this.shared.set(path, read.shared);
      if (read) this.adapterModules.set(path, read.adapterModule);
      return read;
    });
  }

  /** Registers where the main branch the owner set for the repository is read, once per path. */
  private useBranch(r: RepoConfig) {
    const path = resolve(r.path);
    if (!this.branchSettings.has(path)) this.branchSettings.set(path, useBranchSetting(path, () => this.settingsOf(r)()?.branch));
  }

  /** The plan docs of all its repositories, each from its Lesestand: the home repository's by their bare path, the others' with the repository's id before it. */
  private planDocs() {
    const home = this.repos[0]?.ref.id;
    const read = this.repos.map((r) => {
      // while git moves the Lesestand its files are half the one commit and half the other: the docs read before stand
      if (!r.read.moving || !r.planDocs) r.planDocs = readPlanDocs(r.read.path, r.adapter);
      return { r, ...r.planDocs };
    });
    return {
      docs: read.flatMap(({ r, docs }) => docs.map((d) => (r.ref.id === home ? d : { ...d, file: `${r.ref.id}:${d.file}` }))),
      dirs: read.map(({ r, others }) => ({ repo: r.ref.id, dir: r.adapter.planDocs.dir, others })),
    };
  }

  /**
   * Sets up the repository at `index` of a resolved configuration: its Lesestand, workspaces (clones
   * here and on other machines), project agents and workers. Its workers resume nothing yet.
   */
  private startRepo(resolved: Resolved, index: number): Repo {
    const deps = this.deps;
    const board = this.board;
    const {
      config: rc,
      read: { info },
      adapter,
      ref,
    } = resolved.repos[index]!;
    const isHome = index === 0;
    for (const p of this.shared.get(info.path)?.problems ?? []) console.warn(`Obeya: ${info.path}: ${p} (ignored)`);
    const site = siteOf(adapter);
    // public as its forge said last time: workers resumed before it answers again get the tools of a repository that shares
    const isPublic = !info.folder && board.setting(visibilityKey(info.path)) === 'public';
    // whether the repository shares here, which the UI shows
    Object.assign(ref, shareRef(site, deps.home, info.path, isPublic));
    const stops: (() => void)[] = [];
    // filled in below; what is set up here reaches it once it is
    const repo = { config: rc, stops, from: { resolved, index }, ...(isPublic ? { isPublic } : {}) } as Repo;
    repo.problemSources = this.problemSources(info.path, this.adapterModules.get(info.path));
    // where work lands on the local main, the checkout is the Lesestand; otherwise it is a pool clone on a card's branch
    const folder = !!info.folder;
    const read = new ReadTree({
      repoPath: info.path,
      // a folder without git is read as it is
      dir: folder || adapter.land === 'main' ? null : join(deps.home, 'read', resolved.id, ref.id),
      remote: !folder && !!info.remote,
      onChange: () => {
        board.lesestandMoved(repo.ref.id, read.head());
        return Promise.resolve(this.moved(repo)).then((m) => void (m === 'follow' && this.follow()));
      },
    });
    stops.push(() => read.stop());
    const remoteHosts = !folder && info.remote && adapter.workspaces === 'clones' && adapter.land !== 'main' ? (rc.hosts ?? []) : [];
    // the workers set up below say how many are busy where
    let workers!: Workers;
    let workspaces: CardWorkspaces;
    if (folder)
      // every card works in the folder itself; what each changed, and its undo, under Obeya's home
      workspaces = new FolderWorkspaces(deps.store, { path: info.path, dir: join(deps.home, 'undo', resolved.id, ref.id) });
    else {
      const git = new Workspaces(deps.store, resolved.id, {
        mode: adapter.workspaces,
        repoPath: info.path,
        dir: isHome ? join(deps.home, 'workspaces', resolved.id) : join(deps.home, 'workspaces', resolved.id, ref.id),
        repo: isHome ? null : ref.id,
        machines: [{ host: null, ...(rc.slots !== undefined ? { slots: rc.slots } : {}) }, ...remoteHosts.map((h) => ({ host: h.name, ...(h.slots !== undefined ? { slots: h.slots } : {}) }))],
        busy: (host) => workers.busyOn(host),
        ...(adapter.app?.stop ? { stop: adapter.app.stop } : {}),
        origins: [info.remote, info.path].filter((x): x is string => !!x),
        changed: () => board.changed(),
      });
      const named: string[] = [];
      if (adapter.workspaces === 'clones') {
        // a clone registered for this repository must be one of it
        for (const w of listedClones(rc, info, { land: adapter.land })) {
          git.register(w, [info.remote, info.path].filter((x): x is string => !!x));
          named.push(w);
        }
        // landing on main needs clones that see the local main; otherwise they track the remote
        if (rc.clones) named.push(...git.ensureClones(adapter.land === 'main' || !info.remote ? info.path : info.remote, rc.clones));
      }
      // the pool is what the configuration names now (in worktrees, no clone): clones here it no longer names leave it,
      // and those on hosts no longer in use (on a host still in use, once its clones are in place); worktrees are the cards' own
      // a folder moved or deleted by hand leaves at once, and its card takes another at its next start
      for (const { card, path } of git.keepOnly(null, named)) board.workspaceGone(card, path);
      const hosts = new Set(remoteHosts.map((h) => h.name));
      for (const host of new Set(git.list().map((w) => hostName(w.path)))) if (host !== null && !hosts.has(host)) git.keepOnly(host, []);
      // the folders of Obeya's clones that left the pool earlier go once nothing in them would be lost
      git.sweep();
      workspaces = git;
    }
    // clones on other machines, made in the background: a host that is off now gets them once it answers
    if (remoteHosts.length) {
      const token = githubToken(info.path, info.remote!);
      let stopped = false;
      stops.push(() => (stopped = true));
      for (const h of remoteHosts) {
        const host = registerHost({ name: h.name, ssh: h.ssh, home: deps.home, claudeToken: () => claudeToken(deps.home) });
        // cards that wait for a clone look again once the host answers after it did not
        stops.push(host.onBack(() => board.changed()));
        // the log tells what goes wrong once, not at every try while the host stays off
        let told: string | null = null;
        const ensure = async () => {
          const wrong = await (workspaces as Workspaces).ensureHostClones(host, h.root, info.remote!, h.clones, token);
          if (stopped) return;
          if (!wrong) {
            if (told) console.log(`clones on ${h.name}: in place`);
            return board.changed();
          }
          if (wrong !== told) console.error(`clones on ${h.name}: ${wrong}; trying again every ${HOST_RETRY_MS / 60_000} minutes`);
          told = wrong;
          const retry = setTimeout(ensure, HOST_RETRY_MS);
          stops.push(() => clearTimeout(retry));
        };
        void ensure();
      }
    }
    const projectAgents = new ProjectAgents(board, deps.runtime, () => read.path, this.preferences, deps.permissionMode);
    workers = new Workers({
      board,
      runtime: deps.workerRuntime ?? deps.runtime,
      workspaces,
      adapter,
      machineSettings: this.settingsOf(rc),
      shares: () => !!repo.ref.share,
      repo: ref.id,
      otherBoards: () => (deps.canvases?.() ?? []).filter((c) => c !== this).map((c) => c.board),
      preferences: this.preferences,
      onOwnerInput: (card, kind, text, context) => this.koordinator.learn(card, kind, text, context),
      onPrOpened: (cardId) => {
        // a card whose own branch has its work go out as a pull request, where the repository's does not yet
        this.watchPrs(repo);
        this.sharing.prOpened(cardId);
      },
      onApproval: (cardId) => this.sharing.approved(cardId),
      onLanded: (cardId) => void this.sharing.landed(cardId),
      onMerged: () => void read.refresh(),
      onPrototype: (prototype, summary, demo) => this.prototypeReady(prototype, summary, demo),
      onPrototypeAnswer: (prototype, question, answer) => this.prototypeAnswered(prototype, question, answer),
      // where work lands on the local main, the Lesestand is the checkout and moves with the landing;
      // a push leaves the checkout as it is: what it changes applies once the Lesestand fetches it
      restartsFor: async (l: Landed, pushedFrom?: string) => {
        if (pushedFrom) return false;
        if (deps.ownCheckout && sameDir(deps.ownCheckout, info.path) && (await changesCode(info.path, l.from, l.to))) return 'obeya';
        const moved = await this.moved(repo);
        if (moved === 'follow') this.follow();
        return moved === 'due' ? 'repo' : false;
      },
      imageFiles: this.imageFiles,
      onWorkEnded: (cardId, workspace) => this.workRetro.ended(cardId, workspace),
      toObeya: this.toObeya,
      forge: deps.forge,
      repoPath: info.path,
      remote: originUrl(info),
      ...(workspaces instanceof Workspaces ? { pullMain: () => (workspaces as Workspaces).pullMain() } : {}),
      ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
      ...(deps.workerEnv ? { env: deps.workerEnv } : {}),
      demoLanguage: () => readDemoSettings(deps.home).language,
      demoDirectory: () => demoDirectory(readDemoSettings(deps.home)),
      ...(deps.parkGrace !== undefined ? { parkGrace: deps.parkGrace } : {}),
    });
    Object.assign(repo, { ref, info, adapter, site, read, workspaces, workers, projectAgents });
    void this.lookVisibility(repo);
    return repo;
  }

  /**
   * Asks the repository's forge whether it is public: a public one shares on the owner's personal
   * site without a tick. Until the answer it is as the forge said last time (kept across restarts),
   * private where it never answered; where the forge cannot tell, it counts as private. A question
   * that fails leaves the last answer standing.
   */
  private async lookVisibility(r: Repo) {
    if (r.info.folder || !this.deps.forge.visibility) return;
    let v: 'public' | 'private' | null;
    try {
      v = await this.deps.forge.visibility(r.info.path);
    } catch {
      return;
    }
    this.board.setSetting(visibilityKey(r.info.path), v ?? 'unknown');
    if ((v === 'public') === !!r.isPublic) return;
    r.isPublic = v === 'public';
    this.siteCredentials();
  }

  /** Puts a repository set up by `startRepo` on the canvas, last. */
  private addRepo(r: Repo) {
    this.repos.push(r);
    this.board.canvas.repos.push(r.ref);
    this.watch(r);
    this.proposeSetup(r);
  }

  /** Stops what the repository set up: its Lesestand, the watchers, its workers' sessions. Its cards stay. */
  private stopRepo(r: Repo) {
    for (const stop of r.stops) stop();
    r.docs?.();
    r.prs?.stop();
    r.workers.shutdown();
  }

  /**
   * Watches the plan docs of the repository in its Lesestand, afresh where they were watched (the
   * directory or the Lesestand moved), and its pull requests once its work goes out as one or a
   * card is in one (its own branch said so); a watcher of pull requests stays, for those still open.
   */
  private watch(r: Repo) {
    if (!this.deps.watch) return;
    r.docs?.();
    r.docs = watchPlanDocs(r.read.path, r.adapter, () => this.board.docsChanged());
    // a review card's pull request is watched in any repository, also one that lands on main
    if (r.adapter.land === 'pr' || this.board.items().some((i) => (i.state === 'inPr' || (i.contribution && !finished(i.state))) && i.repo === r.ref.id)) this.watchPrs(r);
  }

  /** Watches the repository's pull requests, unless it does already. */
  private watchPrs(r: Repo) {
    if (!this.deps.watch || r.prs) return;
    const board = this.board;
    r.prs = new PrWatcher(board, r.workers, this.deps.forge, (cardId) => localDir(board.row(cardId).workspace) ?? r.info.path, () => r.adapter, r.ref.id, () => void r.read.refresh());
    r.prs.start(this.deps.prPollMs);
  }

  /**
   * The configuration of the canvas changed while it runs (design: Live configuration). A new name
   * applies at once, and so does a repository new on it. A repository whose agents now work
   * elsewhere (other clones, other machines, another adapter, worktrees instead of clones) or that
   * left the canvas has its agents restarted once they paused, or stopped; the other repositories
   * work on, and their settings apply as they are read.
   */
  apply(next: CanvasConfig): Promise<void> | undefined {
    // back in the configuration before it left: it stays, and so do its repositories
    if (this.retiring) {
      this.retiring = null;
      this.cancelPending();
    }
    for (const r of next.repos) this.useBranch(r);
    let resolved: Resolved;
    try {
      resolved = this.resolve(next);
    } catch (e) {
      console.error(`Obeya: the new configuration of the canvas ${this.id} does not resolve; it runs on as it was: ${messageOf(e)}`);
      return;
    }
    this.config = resolved.config;
    if (resolved.name !== this.board.canvas.name) {
      this.board.canvas.name = resolved.name;
      this.deps.store.ensureCanvas(this.id, resolved.name);
      console.log(`Obeya: the canvas ${this.id} is called ${resolved.name} now`);
    }
    const changed = this.repos.filter((r) => {
      const now = resolved.repos.find((x) => x.read.info.path === r.info.path);
      if (!now || repoShape(r.config) !== repoShape(now.config) || r.ref.id !== now.ref.id) return true;
      r.config = now.config;
      return false;
    });
    if (changed.length) this.due(changed.map((r) => r.info.path), 'config');
    // the restart went at once, and its home repository did not start: the canvas stopped
    if (this.stopped) return;
    // a repository that did not start and left the configuration is no longer wrong
    for (const repo of this.failed.keys()) if (!resolved.repos.some((x) => x.ref.id === repo)) this.ran(repo);
    // a repository new on the canvas starts at once; one whose restart waits starts with it
    resolved.repos.forEach(({ read: { info } }, i) => {
      if (this.repos.some((r) => r.info.path === info.path) || this.pending?.paths.has(info.path)) return;
      let r: Repo;
      try {
        r = this.startRepo(resolved, i);
      } catch (e) {
        console.error(`Obeya: ${info.path} does not start, left out of the canvas ${this.id}: ${messageOf(e)}`);
        return this.fail(resolved.repos[i]!.ref.id, e);
      }
      this.addRepo(r);
      this.ran(r.ref.id);
      console.log(`Obeya: ${info.path} is on the canvas ${this.id} now`);
      if (this.obeyaDue) r.workers.restartDue(this.obeyaDue);
      r.workers.resumeAll(true);
    });
    return this.settingsChanged();
  }

  /** The configuration no longer has the canvas: it stops once its agents paused, and then `done`. */
  retire(done: () => void) {
    this.retiring = done;
    this.due(
      this.repos.map((r) => r.info.path),
      'config',
    );
  }

  /**
   * Restarts the agents of the repositories at `paths` once they paused (`restartRepos`), at most
   * after Obeya's patience for a restart; Obeya and the other repositories' agents work on. They
   * hear of it and pause at a safe point, unless a restart of all of Obeya is due already.
   */
  private due(paths: string[], reason: RepoRestart['reason']) {
    if (!paths.length) return;
    let p = this.pending;
    const fresh = !p;
    if (p) for (const path of paths) p.paths.add(path);
    else {
      const patience = this.deps.restartPatienceMs ?? RESTART_PATIENCE_MS;
      p = this.pending = { paths: new Set(paths), reason, deadline: Date.now() + patience, waiting: [], stop: () => {} };
    }
    const due = repoDue(p);
    for (const r of this.repos) if (paths.includes(r.info.path) && !this.obeyaDue) r.workers.restartDue(due);
    console.log(`Obeya: ${this.retiring ? `the canvas ${this.id} leaves the configuration; it stops` : `restarting the agents of ${paths.join(', ')}`}${this.pendingBusy().length ? ' once they paused' : ''}`);
    p.waiting = this.pendingBusy();
    this.emitPending();
    if (!fresh) return;
    const pending = p;
    pending.stop = whenIdle(
      () => {
        const now = this.pendingBusy();
        if (this.pending === pending && now.join() !== pending.waiting.join()) {
          pending.waiting = now;
          this.emitPending();
        }
        return now.length > 0;
      },
      () => {
        if (this.pending === pending) this.restartRepos();
      },
      pending.deadline - Date.now(),
      this.deps.restartIntervalMs,
    );
  }

  /** The cards whose worker the restart of repositories' agents waits for. */
  private pendingBusy(): string[] {
    const p = this.pending;
    return p ? this.repos.filter((r) => p.paths.has(r.info.path)).flatMap((r) => r.workers.busyCards()) : [];
  }

  /** The restart of repositories' agents that waits is off (the canvas came back into the configuration): their workers hear so. */
  private cancelPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.stop();
    for (const r of this.repos) if (p.paths.has(r.info.path)) r.workers.restartDue(this.obeyaDue);
    this.emitPending();
  }

  /**
   * Restarts the agents of the repositories the restart waited for: each one's set-up stops, and
   * starts again as the configuration has it now, its workers resuming where they paused; one that
   * left the canvas stays stopped, its cards kept. A canvas that left the configuration stops.
   */
  private restartRepos() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.stop();
    if (this.retiring) {
      const done = this.retiring;
      this.retiring = null;
      this.shutdown();
      console.log(`Obeya: the canvas ${this.id} stopped; its cards are kept`);
      done();
      return;
    }
    let resolved: Resolved;
    try {
      resolved = this.resolve(this.config);
    } catch (e) {
      console.error(`Obeya: the configuration of the canvas ${this.id} does not resolve; its repositories run on as they were: ${messageOf(e)}`);
      for (const r of this.repos) if (p.paths.has(r.info.path)) r.workers.restartDue(this.obeyaDue);
      this.emitPending();
      return;
    }
    const started: Repo[] = [];
    let homeDown: unknown = null;
    for (const path of p.paths) {
      const at = this.repos.findIndex((r) => r.info.path === path);
      const was = at >= 0 ? this.repos[at]! : undefined;
      if (was) this.stopRepo(was);
      const i = resolved.repos.findIndex((x) => x.read.info.path === path);
      if (i < 0) {
        if (at >= 0) this.repos.splice(at, 1);
        if (was) this.ran(was.ref.id);
        this.branchSettings.get(path)?.();
        this.branchSettings.delete(path);
        console.log(`Obeya: ${path} left the canvas ${this.id}; its cards are kept`);
        continue;
      }
      const repo = resolved.repos[i]!.ref.id;
      let r: Repo | null = null;
      try {
        r = this.startRepo(resolved, i);
        this.ran(repo);
        console.log(`Obeya: restarted the agents of ${path}`);
      } catch (e) {
        // it starts again as it was set up before; where that fails too, it leaves the canvas, its cards kept
        console.error(`Obeya: the agents of ${path} do not start as the configuration has it now: ${messageOf(e)}`);
        try {
          if (was) {
            r = this.startRepo(was.from.resolved, was.from.index);
            console.log(`Obeya: the agents of ${path} work on as they were set up before`);
          }
        } catch (again) {
          console.error(`Obeya: nor as they were set up before: ${messageOf(again)}`);
        }
        this.fail(repo, e, !!r);
        if (!r && i === 0) homeDown = e;
      }
      if (!r) {
        if (at >= 0) this.repos.splice(at, 1);
        if (!homeDown) console.log(`Obeya: ${path} is left out of the canvas ${this.id}; its cards are kept`);
        continue;
      }
      if (at >= 0) this.repos.splice(at, 1, r);
      else this.repos.push(r);
      started.push(r);
    }
    if (homeDown) {
      // without its home repository the canvas does not run: it stops, its cards kept
      this.stopped = true;
      this.shutdown();
      console.error(`Obeya: the home repository of the canvas ${this.id} does not start; the canvas stopped, its cards are kept`);
      this.emitPending();
      this.deps.stopped?.(this, messageOf(homeDown));
      return;
    }
    this.board.canvas.repos.splice(0, this.board.canvas.repos.length, ...this.repos.map((r) => r.ref));
    for (const r of started) {
      this.watch(r);
      if (this.obeyaDue) r.workers.restartDue(this.obeyaDue);
      r.workers.resumeAll(true);
    }
    this.board.docsChanged();
    this.emitPending();
  }

  /** The repositories of the canvas that do not run as the configuration has it. */
  failures(): StartFailure[] {
    return [...this.failed].map(([repo, f]) => ({ canvas: this.id, repo, ...f }));
  }

  /** The repository did not start as the configuration has it (`before`: it runs on as it was set up before): the page reads the configuration's problems again. */
  private fail(repo: string, e: unknown, before = false) {
    this.failed.set(repo, { detail: messageOf(e), ...(before ? { before: true as const } : {}) });
    this.failuresChanged();
  }

  /** The repository runs as the configuration has it, or left it. */
  private ran(repo: string) {
    if (this.failed.delete(repo)) this.failuresChanged();
  }

  private failuresChanged() {
    this.board.canvas.configRev = (this.board.canvas.configRev ?? 0) + 1;
    this.board.changed();
  }

  /**
   * The owner pauses the canvas's agents (design: Pausing a canvas's agents): each one at work now
   * pauses at a safe point as its card's own pause has it, and until they resume them, the cards the
   * Koordinator lets start wait in the queue. With none at work, nothing changes.
   */
  pauseAgents() {
    let paused = 0;
    for (const i of this.board.items().filter(pausable)) {
      try {
        this.agentOf(i.id).pauseAtSafePoint(i.id);
        paused++;
      } catch (e) {
        console.error(`Obeya: the agent of ${i.id} did not pause: ${messageOf(e)}`);
      }
    }
    // set once they paused: until then the canvas would count none paused, which ends its pause
    if (!paused) return;
    this.showPaused(true);
    this.board.changed();
  }

  /**
   * The owner resumes the canvas's paused agents, and those about to pause: each goes on as its
   * card's own resume has it, and the cards waiting for it start. Snoozed ones sleep on; one that
   * cannot go on (its repository is down) stays paused, and so the canvas's pause lasts.
   */
  resumeAgents() {
    for (const i of this.board.items().filter(halted)) {
      try {
        this.agentOf(i.id).resume(i.id);
      } catch (e) {
        console.error(`Obeya: the agent of ${i.id} did not resume: ${messageOf(e)}`);
      }
    }
    if (!this.paused || this.board.items().some(halted)) return;
    this.showPaused(false);
    this.board.changed();
  }

  /** Whichever agent works on the card: a Question card's, an idea's, or its worker. */
  private agentOf(cardId: string) {
    const card = this.board.item(cardId);
    return card?.kind === 'question' ? this.answers : card?.state === 'idea' ? this.explorers : this.repoOf(cardId).workers;
  }

  /** The canvas's pause as it is stored and as the switchers show it. */
  private showPaused(on: boolean) {
    this.paused = on;
    this.deps.store.setSetting(this.id, 'paused', on ? '1' : '');
    if (on) this.board.canvas.paused = true;
    else delete this.board.canvas.paused;
  }

  /**
   * Counts the canvas's agents at work and those the owner paused (or that are about to pause), for
   * the switchers. Once none is either any more (the owner resumed each on its card, or their cards
   * went), the canvas's pause ends.
   */
  private countAgents() {
    const items = this.board.items();
    const running = items.filter(pausable).length;
    const paused = items.filter(halted).length;
    if (this.paused && !paused) this.showPaused(false);
    if (running || paused) this.board.canvas.agents = { running, paused };
    else delete this.board.canvas.agents;
  }

  /** Restarts the repositories' agents the restart waits for at once, cutting off those still in a turn; false when none waits. */
  restartNow(): boolean {
    if (!this.pending) return false;
    this.restartRepos();
    return true;
  }

  /** The restart of repositories' agents that waits, as the page shows it; null when none does. */
  pendingRestart(): PendingRestart | null {
    const p = this.pending;
    if (!p) return null;
    return {
      reason: p.reason,
      deadline: p.deadline,
      cards: p.waiting,
      elsewhere: [],
      owner: [],
      repos: this.repos.filter((r) => p.paths.has(r.info.path)).map((r) => r.ref.name),
      ...(this.retiring ? { leaving: true } : {}),
    };
  }

  /** Calls `fn` whenever the restart of repositories' agents begins to wait, waits for others, or happened. */
  onPending(fn: () => void): () => void {
    this.pendingListeners.add(fn);
    return () => this.pendingListeners.delete(fn);
  }

  private emitPending() {
    for (const fn of this.pendingListeners) fn();
  }

  /**
   * The owner saved settings of the repositories (`RepoSettings`), or committed them for everyone
   * (`.obeya/settings.json`): they are read where they are used; what the canvas set up
   * by them follows (`follow`), and a repository whose agents now work elsewhere restarts them.
   */
  settingsChanged(): Promise<void> {
    const moved = [...this.repos].map((r) => this.moved(r));
    // where no repository's refs moved, at once
    if (moved.every((m) => typeof m === 'string')) {
      this.follow();
      return Promise.resolve();
    }
    return Promise.all(moved).then(() => void (!this.shutDown && this.follow()));
  }

  /**
   * The Lesestand of the repository moved, or its settings were saved: reads its
   * `.obeya/settings.json` again from the default branch; the settings apply where they are read.
   * Where the repository's agents now work elsewhere (clones or worktrees, set up when they start),
   * they restart once they paused (`due`); where demos are shared may have changed, and so may the
   * configuration's problems of the repository (`configRev`). Says which of these it came to:
   * `follow` where the canvas follows what changed. What was read stands while the repository's
   * refs did not move (`refsSeal`): the owner saved settings, say. Otherwise git reads without the
   * server waiting for it, the reads of a repository one after the other, so that one git answers
   * sooner does not undo a later one.
   */
  private moved(r: Repo): Moved | Promise<Moved> {
    const path = r.info.path;
    const known = r.moving ? undefined : this.readNow(path);
    if (known) return this.movedTo(r, known);
    const now = (r.moving ?? Promise.resolve()).then(async () => this.movedTo(r, await this.readSettings(path)));
    const moving: Promise<void> = (r.moving = now.then(
      () => {},
      () => {},
    ));
    void moving.then(() => r.moving === moving && delete r.moving);
    return now;
  }

  /** What `moved` read of the repository at `path` last, where its refs did not move since; a folder without git as it is now. */
  private readNow(path: string): DefaultRead | undefined {
    if (isFolder(path)) return { shared: readSharedFiles(path), adapterModule: false };
    const seal = refsSeal(path);
    const known = this.defaultRead.get(path);
    return seal && known?.seal === seal && !(known.read instanceof Promise) ? known.read : undefined;
  }

  /**
   * Reads the repository at `path` on its default branch again, without the server waiting for git,
   * and keeps that (`defaultRead`). Where its refs moved while git read, what it read may be the
   * commit before: it reads again, a few times at most.
   */
  private readSettings(path: string, tries = READ_TRIES): Promise<DefaultRead> {
    const seal = refsSeal(path);
    const read = gitSteps(path, readingSettings(path)).then((r) => (seal && tries > 1 && refsSeal(path) !== seal ? this.readSettings(path, tries - 1) : r));
    if (seal) this.readAt(path, seal, read);
    return read;
  }

  /** `moved`, with what was read of the repository on its default branch. */
  private movedTo(r: Repo, read: DefaultRead): Moved {
    const path = r.info.path;
    if (this.shutDown || !this.repos.includes(r)) return 'same';
    if (this.pending?.paths.has(path)) return 'due';
    const shared = this.reread(r, read.shared);
    const was = this.held.get(path);
    this.held.delete(path);
    const held = JSON.stringify(this.heldOf(path)) !== JSON.stringify(was ?? []);
    const sources = this.problemSources(path, read.adapterModule);
    const problems = sources !== r.problemSources;
    if (problems) {
      // the page reads the configuration's problems again
      r.problemSources = sources;
      r.ref.configRev = (r.ref.configRev ?? 0) + 1;
      // the settings may be there now, or gone
      this.proposeSetup(r);
    }
    const layered = layerSettings<RepoSettings>(this.sharedOf(path)(), this.settingsOf(r.config)());
    const workIn = r.info.folder ? 'folder' : namesClones(r.config, r.info, layered) ? 'clones' : (layered?.workspaces ?? defaultsFor(r.info).workspaces);
    if (workIn !== r.workspaces.mode) {
      this.due([path], shared ? 'repository' : 'config');
      return 'due';
    }
    const site = siteOf(r.adapter);
    if (JSON.stringify(site) !== JSON.stringify(r.site)) {
      r.site = site;
      setShare(r.ref, shareRef(site, this.deps.home, r.info.path, !!r.isPublic));
      return 'follow';
    }
    return shared || problems || held ? 'follow' : 'same';
  }

  /**
   * What the configuration's problems of the repository are read from on its default branch: its
   * `.obeya/settings.json` as the file has it (a field that does not count included), and whether a
   * leftover `.obeya/adapter/` is there (`adapterModule`, where it was just read), noted for
   * `proposeSetup`.
   */
  private problemSources(path: string, adapterModule = hasAdapterModule(path)): string {
    this.adapterModules.set(path, adapterModule);
    const read = this.shared.get(path);
    return JSON.stringify([read?.raw, read?.problems, read?.claude, this.heldOf(path), adapterModule]);
  }

  /**
   * The repository's `.obeya/settings.json` as its default branch has it now (`now`). Where it
   * changed, this machine's values that it now holds as well go (they were taken over for everyone,
   * see `Config.takenOver`). Says whether it changed.
   */
  private reread(r: Repo, now: SharedRead): boolean {
    const path = r.info.path;
    const before = this.shared.get(path);
    if (JSON.stringify([now.settings, now.claude]) === JSON.stringify([before?.settings, before?.claude])) {
      // a field that does not count changed alone: the problems change, the settings do not
      this.shared.set(path, now);
      return false;
    }
    this.shared.set(path, now);
    for (const p of now.problems) console.warn(`Obeya: ${path}: ${p} (ignored)`);
    this.deps.config?.takenOver(path, before?.settings, now.settings);
    return true;
  }

  /**
   * What the canvas set up by the repositories' settings follows them: the Lesestand where work
   * now lands elsewhere, the watched plan directory, the pull requests, what the page shows of
   * each repository.
   */
  private follow() {
    for (const r of this.repos) {
      r.info.branch = defaultBranch(r.info.path);
      for (const k of ['pullRequests', 'direct', 'forge'] as const) delete r.ref[k];
      Object.assign(r.ref, settled(r.info, r.adapter));
      // where work lands on the local main, the checkout is the Lesestand; otherwise a worktree on the default branch
      r.read.retarget(r.info.folder || r.adapter.land === 'main' ? null : join(this.deps.home, 'read', this.id, r.ref.id));
      this.watch(r);
    }
    this.board.docsChanged();
  }

  /**
   * The repository a card belongs to. One that does not run on the canvas (it left the
   * configuration, or did not start) has no agents to take the card: it waits for it, rather than
   * going to another repository's.
   */
  repoOf(card: Item | string): RepoRuntime {
    const item = typeof card === 'string' ? this.board.item(card) : card;
    if (!item) throw new BadRequest('unknownCard', 'unknown card');
    const r = this.repos.find((x) => x.ref.id === item.repo);
    if (!r) throw repoDown(item);
    return r;
  }

  /** Whether the card's repository runs on the canvas. */
  private runs(card: Item | string): boolean {
    const item = typeof card === 'string' ? this.board.card(card) : card;
    return !!item && this.repos.some((r) => r.ref.id === item.repo);
  }

  /** What the card's work changes (`Workers.diff`), for an archived card too. */
  diff(cardId: string, full: boolean): Promise<CardDiff | null> {
    return this.repoOf(this.board.card(cardId) ?? cardId).workers.diff(cardId, full);
  }

  /**
   * The skills the owner can ask the card's agent for by `/name` in their words: those of its
   * repository (as its default branch has them), the user's, and those of the plugins it loads.
   * None on a card whose agent works outside a repository (a Question card's) or that none takes.
   */
  async skillsOf(cardId: string): Promise<Skill[]> {
    const card = this.board.item(cardId);
    if (!card || card.kind === 'question' || !this.runs(card)) return [];
    const cwd = this.repoOf(card).read.path;
    // an idea's agent loads no plugins; a review card's reads none of the repository's settings
    const idea = card.state === 'idea';
    return this.skills.of({ cwd, plugins: idea ? [] : [OBEYA_PLUGIN], untrusted: (!idea && !!card.contribution) || (await this.claudeHeld(cwd)) });
  }

  /** Whether the app in the card's workspace answers, for the owner to try it by hand (`Workers.appUp`). */
  async appUp(cardId: string): Promise<{ up: boolean }> {
    return { up: await this.repoOf(cardId).workers.appUp(cardId) };
  }

  /** The address of the card's app as the owner opens it, which keeps it running a while (`Workers.openApp`); none once it no longer runs. */
  openApp(cardId: string): Promise<string | null> {
    return this.repoOf(cardId).workers.openApp(cardId);
  }

  /** The owner edits a card; what they write in it is offered for learning once they have written it. */
  patch(cardId: string, p: CardPatch) {
    const { body: before, state } = this.board.row(cardId);
    // an idea's agent reads in its repository
    if (p.state === 'idea' && state !== 'idea' && !this.runs(cardId)) throw repoDown(this.board.item(cardId)!);
    this.board.patch(cardId, p);
    if (p.body !== undefined) {
      const w = this.writing.get(cardId);
      clearTimeout(w?.timer);
      this.writing.set(cardId, { before: w?.before ?? before ?? '', timer: setTimeout(() => this.written(cardId), this.deps.writingPauseMs ?? 60_000) });
    }
    // an idea's agent starts from the card's text and the notes left on it for a worker, and opens the discussion with them
    if (p.state === 'idea' && state !== 'idea') {
      this.written(cardId);
      void this.koordinator.name(cardId);
      this.explorers.open(cardId, undefined, this.repoOf(cardId).workers.takeNotes(cardId));
    }
  }

  /** The owner has written in the card (a pause, or they act on it): the learner gets what they wrote. */
  private written(cardId: string) {
    const w = this.writing.get(cardId);
    if (!w) return;
    clearTimeout(w.timer);
    this.writing.delete(cardId);
    const card = this.board.item(cardId);
    const [text, before] = [card?.body.trim() ?? '', w.before.trim()];
    if (card && text && text !== before) this.koordinator.learn(card, 'card', text, before ? { before } : {});
  }

  /** The owner accepts a rule proposal, maybe in their words or for another place (a repository's CLAUDE.md, or none). */
  acceptRule(id: number, text?: string, target?: string | null) {
    this.board.acceptProposal(id, text, target);
    this.fileRules();
  }

  /**
   * A rule the owner gives outright, by „Merk dir: …“ or in the sheet: one of theirs, active at once,
   * or with `repos` one for those repositories' CLAUDE.md, which goes straight into their cards
   * „CLAUDE.md ergänzen“. `replaces`: the active rule it changes; `card`: the card open when it was said.
   */
  remember(text: string, o: { repos?: string[]; replaces?: number; card?: string } = {}) {
    // the rule it changes may have been deleted in the meantime: then it is a new one
    const replaces = o.replaces !== undefined && this.board.preferences('active').some((p) => p.id === o.replaces) ? o.replaces : undefined;
    if (o.repos?.length) {
      this.board.fileRule(text, o.repos, o.card ?? null, replaces);
      this.fileRules();
    } else if (replaces !== undefined) this.board.setPreference(replaces, text);
    else this.board.addPreference(text, o.card ?? null);
  }

  rejectRule(id: number) {
    this.board.rejectProposal(id);
    this.fileRules();
  }

  /**
   * The owner takes a setting the Arbeitsrückschau proposed, as it is or with their `value`: on
   * this machine, or into the repository's `.obeya/settings.json` for everyone (`Config.takeSetting`).
   */
  async takeSetting(id: number, where: unknown, value?: unknown): Promise<SettingsShared | null> {
    if (where !== 'machine' && where !== 'repository') throw new BadRequest('invalid', 'where is machine or repository');
    const p = this.board.settingProposal(id);
    const v = value === undefined ? p.value : typeof p.value === 'string' ? (typeof value === 'string' && value.trim() ? value.trim() : null) : Array.isArray(value) ? value.map(String).map((x) => x.trim()).filter(Boolean) : null;
    if (v === null || (Array.isArray(v) && !v.length)) throw new BadRequest('invalid', 'the value is missing');
    const r = this.repos.find((x) => x.ref.id === p.repo);
    if (!r || !this.deps.config) throw new BadRequest('invalid', 'no configuration to set it in');
    const done = await this.deps.config.takeSetting(resolve(r.config.path), p.field, v, where);
    this.board.decideSetting(id, where, v);
    const m = this.board.t.retro;
    const name = m.settings[p.field];
    this.board.notify({ text: !done ? m.onMachine(name, r.ref.name) : 'pr' in done ? m.opened(name, r.ref.name, done.pr) : m.committed(name, r.ref.name, done.branch) });
    return done;
  }

  rejectSetting(id: number) {
    this.board.decideSetting(id, 'rejected');
  }

  /**
   * Once no proposal waits any more, the cards „CLAUDE.md ergänzen“ start, with all the rules
   * accepted for them: a waiting proposal might yet become one of theirs.
   */
  private fileRules() {
    if (this.board.preferences('proposed').length) return;
    for (const r of this.board.canvas.repos) {
      const card = this.board.collecting(r.id);
      if (card) this.koordinator.request(card.id);
    }
  }

  /**
   * What the owner says or types with a card open that an agent listens on (`agentListens`) goes
   * straight to that agent, by the card's state: talk to an idea, words a proposal is reworked by,
   * the answer to its worker's question, or else words the worker takes in (a note while it works,
   * words on its handover, a question once its work is done, a note held for the agent that takes on
   * a planned card). The agent passes on what asks Obeya for something (`to_obeya`).
   * `replyTo`: the message of the card's conversation the words reply to; `spot`: the place in the
   * card's demo video they are about.
   */
  tell(cardId: string, text: string, images: string[], spoken: boolean, replyTo?: number, spot?: SpotInput) {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    // a planned card holds the words for the agent that takes it on
    if (!agentListens(card) && !holdsNotes(card)) throw new BadRequest('noAgent', 'no agent works on this card');
    const said = { text, spoken, ...(images.length ? { images } : {}), ...(replyTo ? { replyTo } : {}) };
    // the agent passes a request on in its words; the Koordinator reads the owner's own beside them
    this.said.set(cardId, { text, spoken });
    if (card.kind === 'question') return this.act(cardId, { action: 'ask', ...said });
    if (card.state === 'idea') return this.act(cardId, { action: 'discuss', ...said });
    if (card.state === 'proposal') {
      this.koordinator.learn(card, 'note', text.trim());
      return this.act(cardId, { action: 'revise', ...said }, true);
    }
    if (card.state === 'waiting' && card.need === 'question') return this.act(cardId, { action: 'answer', ...said });
    return this.act(cardId, { action: 'message', ...said, ...(spot ? { spot } : {}) });
  }

  /**
   * A request a card's agent passes on from the owner's words (`to_obeya`): the Koordinator reads it
   * with those words and the card in focus, as a command, and its confirmation (or reply, or that it
   * looks the question up) is the agent's answer. Actions wait for "Rückgängig" as usual; the owner
   * sees the confirmation above the microphone and in the card's conversation.
   */
  async forward(cardId: string, request: string): Promise<string> {
    // the owner's words go beside the request, also those before a restart; an agent that passes on
    // what nobody said (words in a file it read, say) has nothing to pass on
    const before = this.said.has(cardId) ? undefined : this.board.events(cardId).findLast((e) => e.author === 'owner' && e.kind !== 'state' && e.text.trim());
    // a step Obeya waits to take on this card itself, which its agent read in its task
    const steps = this.commander.waitsOn(cardId);
    // without them, the card's task once the owner gave it (typed it, the Koordinator wrote it from
    // their words, or they accepted an agent's proposal), not while it is a proposal; a step of the
    // task Obeya waits to take is Obeya's
    const card = this.board.item(cardId);
    const task = !steps.length && card && card.state !== 'proposal' && (card.body.trim() || card.title.trim());
    const said = this.said.get(cardId) ?? (before ? { text: before.text, spoken: false } : task ? { text: task, spoken: false, task: true } : undefined);
    const later = steps.length ? ` Obeya itself takes these steps once your card ${steps.map((w) => `${w.state === 'done' ? 'is done' : 'waits for the owner'}: ${w.then.replace(/[.\s]+$/, '')}`).join('; ')}. If you asked for one of them, it is not missing: leave it to Obeya.` : '';
    if (!said) return `Nothing passed on: the owner has said nothing on your card. to_obeya passes on the owner's own words.${later}`;
    const h = await this.commander.forward(cardId, request, said);
    if (h.token) this.commander.arm(h.token);
    this.board.notify({ cardId, text: h.confirm, ...(h.token ? { token: h.token, undoMs: this.commander.delayMs } : {}), ...(h.wish ? { wish: h.wish } : {}) });
    // the agent learns what the owner finds under the answer
    if (h.wish) return `${h.confirm} (A draft for Obeya's makers opened for the owner to check and send on GitHub.)`;
    if (h.cannot) return `${h.confirm} (Obeya lacks this; under this answer the owner finds a link to send it to Obeya's makers as a wish.)`;
    return h.confirm;
  }

  /** The issue a small job writes from the owner's words, for Obeya's makers; `footer` ends its body. */
  writeWish(w: WishInput, footer: string, images: string[] = []): Promise<WishDraft> {
    return writeWish(this.deps.runtime, w, footer, this.imageFiles(images));
  }

  /** The owner clicks in the card's panel: a click without words the learner reads counts towards the Rückschau. */
  /** A script acts as the card's agent, in a scratch Obeya whose workers are idle (`Workers.standIn`). */
  standIn(cardId: string, act: Parameters<Workers['standIn']>[1]) {
    if (!this.deps.idleWorkers) throw new BadRequest('invalid', 'only an Obeya with idle workers (--idle-workers) lets a script stand in for an agent');
    return this.repoOf(cardId).workers.standIn(cardId, act);
  }

  press(cardId: string, a: CardAction) {
    // the options picked on a proposal go to its reviser without the Koordinator, which would have logged them
    const r = this.act(cardId, a, true);
    // the end of watching a demo is no click of the owner's
    if (a.action !== 'release' && a.action !== 'unsay' && a.action !== 'name' && !(['message', 'answer', 'discuss'].includes(a.action) && 'text' in a && a.text?.trim())) this.koordinator.noticed();
    return r;
  }

  /** What the owner decided for a review card's findings, as the browser sent it: by finding number, to the contributor, the worker's own change or a follow-up task. */
  private decisions(findings: unknown): Record<number, ChangeRoute> | undefined {
    if (findings === undefined || findings === null) return undefined;
    if (typeof findings !== 'object') throw new BadRequest('invalid', 'findings must map finding numbers to contributor, self or later');
    const out: Record<number, ChangeRoute> = {};
    for (const [id, route] of Object.entries(findings as Record<string, unknown>)) {
      if (!/^\d+$/.test(id) || (route !== 'contributor' && route !== 'self' && route !== 'later')) throw new BadRequest('invalid', 'findings must map finding numbers to contributor, self or later');
      out[Number(id)] = route;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** A place in the demo video as the browser sent it: a frame Obeya does not have is left out; `demo` names the demo it is in. */
  private spot(spot: unknown): SpotInput | undefined {
    if (!spot || typeof spot !== 'object') return;
    const { at, still, demo } = spot as Record<string, unknown>;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) throw new BadRequest('invalid', 'spot.at must be a time in the video, in seconds');
    return { at, ...(typeof still === 'string' && this.images.path(still) ? { still } : {}), ...(Number.isInteger(demo) ? { demo: demo as number } : {}) };
  }

  /**
   * An owner action from the card's panel, or from a spoken command. `log`: words to a proposal's
   * reviser go into its conversation (a spoken command's stand there already).
   */
  act(cardId: string, a: CardAction, log = false) {
    this.written(cardId);
    // the card's agents work in its repository: while that does not run, only the board changes
    const card = this.board.item(cardId);
    if (card?.repoDown && !BOARD_ONLY.includes(a.action)) throw repoDown(card);
    // while its new repository is about to be made, the card is not decided otherwise
    if (card?.newRepo?.due && DUE_REFUSES.includes(a.action)) throw new BadRequest('newRepoDue', 'the card is about to be built in its new repository; take that back first');
    const text = 'text' in a ? (a.text ?? '') : '';
    const images = this.images.resolve('images' in a ? a.images : undefined);
    // a reply to anything but a message of this card's conversation is the words alone
    const replyTo = 'replyTo' in a ? this.board.quoted(cardId, a.replyTo)?.id : undefined;
    // a prototype may leave it to the idea's brief what it shows; a screenshot or an option picked may speak for itself
    const picks = a.action === 'answer' && Array.isArray(a.picks) ? a.picks.filter((o): o is string => typeof o === 'string') : [];
    const decided = a.action === 'message' && !!a.findings && typeof a.findings === 'object' && Object.keys(a.findings).length > 0;
    if ('text' in a && (typeof text !== 'string' || (!text.trim() && a.action !== 'prototype' && !images.length && !picks.length && !decided) || text.length > 20000))
      throw new BadRequest('emptyText', 'text must be a non-empty string');
    switch (a.action) {
      case 'start':
        if (card?.newRepo) return this.intoNewRepo(cardId);
        // one snoozed to start later starts now
        if (this.board.item(cardId)?.snoozed?.start) return this.wake(cardId, false);
        return this.koordinator.request(cardId);
      case 'stayHere':
        return this.stayHere(cardId);
      case 'name':
        return void this.koordinator.name(cardId);
      case 'force':
        return this.koordinator.force(cardId);
      case 'dequeue':
        return this.koordinator.dequeue(cardId);
      case 'takeWorkspace':
        return this.koordinator.evict(cardId);
      case 'keepWorkspace':
        return this.koordinator.keep(cardId);
      case 'arrange':
        return this.koordinator.arrange(cardId);
      case 'reorder':
        return this.koordinator.reorder(cardId, !!a.earlier, a.places ?? 1);
      case 'stop':
        return this.repoOf(cardId).workers.stop(cardId);
      case 'pause':
        return a.safePoint ? this.agentOf(cardId).pauseAtSafePoint(cardId) : this.agentOf(cardId).pause(cardId);
      case 'resume':
        return this.agentOf(cardId).resume(cardId);
      case 'snooze':
        return this.snooze(cardId, a.until);
      case 'wake':
        return this.wake(cardId, false);
      case 'startAt':
        return this.board.startAt(cardId, a.at === null ? null : this.until(a.at));
      case 'message':
        // a note to a Question card is a question to its agent
        if (this.board.item(cardId)?.kind === 'question') return this.answers.ask(cardId, text.trim(), images, !!a.spoken, replyTo);
        return this.repoOf(cardId).workers.message(cardId, text.trim(), images, !!a.spoken, replyTo, this.spot(a.spot), this.decisions(a.findings));
      case 'release':
        return this.repoOf(cardId).workers.released(cardId, !!a.now);
      case 'unsay': {
        // words the card's agent has not read yet, whichever agent it is
        const card = this.board.item(cardId);
        if (card?.kind === 'question') return this.answers.unsay(cardId, a.id);
        if (card?.state === 'idea') return this.explorers.unsay(cardId, a.id);
        if (card?.state === 'proposal') return this.revisions.unsay(cardId, a.id);
        return this.repoOf(cardId).workers.unsay(cardId, a.id);
      }
      case 'answer':
        return this.repoOf(cardId).workers.answer(cardId, text.trim(), images, !!a.spoken, replyTo, picks);
      case 'approve':
        return this.repoOf(cardId).workers.approve(cardId, { direct: !!a.direct });
      case 'undo':
        return this.repoOf(cardId).workers.undo(cardId);
      case 'accept':
        return this.accept(cardId, a.picks, a.start !== false, a.idea);
      case 'unaccept':
        return this.unaccept(cardId);
      case 'dismiss':
        // a card its agent withdrew or replaced goes like a deleted one, its worker stopped
        if (this.board.item(cardId)?.superseded) return this.remove(cardId);
        if (this.board.row(cardId).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return this.board.remove(cardId);
      case 'keep':
        return this.board.keep(cardId);
      case 'revise': {
        // said while it is reworked, they wait for the next rework, unread until then
        const later = !!this.board.item(cardId)?.proposal?.revising;
        const said = log ? this.board.log(cardId, 'say', 'owner', text.trim(), { images, replyTo, unread: later }).id : undefined;
        return this.revisions.revise(cardId, `${replyNote(this.board.quoted(cardId, replyTo), 'koordinator')}${text.trim()}`, !!a.spoken, said, images);
      }
      case 'discuss':
        return this.explorers.discuss(cardId, text.trim(), !!a.spoken, images, replyTo);
      case 'build':
        return this.build(cardId);
      case 'unbuild':
        return this.unbuild(cardId);
      case 'splitOff':
        return this.splitOff(cardId);
      case 'planDoc':
        return this.planDoc(cardId);
      case 'park':
      case 'drop':
        return this.shelve(cardId, a.action);
      case 'prototype':
        if (a.variants !== undefined && (!Array.isArray(a.variants) || a.variants.length > 20 || a.variants.some((v) => typeof v !== 'string')))
          throw new BadRequest('invalid', 'variants must be a list of the planned approaches');
        return this.prototype(cardId, text.trim(), a.variants);
      case 'buildPrototype':
        return this.buildOnPrototype(cardId, a.workstream);
      case 'discard':
        return this.repoOf(this.prototypeCard(cardId)).workers.endPrototype(cardId, 'discarded');
      case 'ask':
        return this.answers.ask(cardId, text.trim(), images, !!a.spoken, replyTo);
      case 'consult': {
        // the agent passes a request on in its words; the Koordinator reads the owner's own beside them
        this.said.set(cardId, { text: text.trim(), spoken: !!a.spoken });
        const ids = Array.isArray(a.images) ? a.images.filter((i): i is string => typeof i === 'string') : [];
        return void this.answers.askProject(cardId, text.trim(), ids, a.replyTo);
      }
      case 'asIdea':
        return this.questionAsIdea(cardId);
      case 'share':
        return this.sharing.share(cardId, { demo: Number.isInteger(a.demo) ? a.demo : undefined, add: a.add === true });
      case 'unshare':
        return this.sharing.unshare(cardId, Number.isInteger(a.demo) ? a.demo : undefined);
      case 'shareOnApproval':
        if (typeof a.on !== 'boolean') throw new BadRequest('invalid', 'on must be true or false');
        return this.sharing.onApproval(cardId, a.on);
      case 'pageTags':
        if (typeof a.dimension !== 'string' || !Array.isArray(a.values) || !a.values.every((v) => typeof v === 'string')) throw new BadRequest('invalid', 'dimension must be a string, values a list of strings');
        return this.sharing.setTags(cardId, a.dimension, a.values);
      default:
        throw new BadRequest('invalid', 'unknown action');
    }
  }

  /** The output directory of a looked-up thread of this canvas. */
  answerDir(thread: number): string {
    if (!Number.isInteger(thread) || !this.board.threadTalk(thread).length) throw new BadRequest('invalid', 'unknown thread');
    return answersDir(this.deps.home, this.id, thread);
  }

  /** "Im Ordner zeigen", or a click on an answer's file: opened with the system's app on this machine. */
  async openAnswerFile(thread: number, file?: string) {
    const dir = this.answerDir(thread);
    mkdirSync(dir, { recursive: true });
    // a file by its real path: a link out of the directory is no file of the answer's
    const path = file === undefined ? dir : demoFile(dir, String(file));
    if (!path) throw new BadRequest('noFile', 'no such file in the answer’s directory');
    if (!(await openWithSystem(path, path !== dir))) throw new BadRequest('invalid', 'the system has no app to open it with');
  }

  /** A file of the card's work as its left column shows it (`Workers.file`); `local`: on disk, to open it. */
  cardFile(cardId: string, path: string, local = false): Promise<FileAt | null> {
    return this.repoOf(this.board.card(cardId) ?? cardId).workers.file(cardId, path, local);
  }

  /** „Auf dem Rechner öffnen“ on a file of the card's work, or with `show` „Im Ordner zeigen“: with the system's app on this machine. */
  async openCardFile(cardId: string, path: string, show: boolean) {
    const file = await this.cardFile(cardId, path, true);
    if (!file || !('path' in file)) throw new BadRequest('noFile', 'the file is not on this machine');
    if (!(await openWithSystem(file.path, true, show))) throw new BadRequest('invalid', 'the system has no app to open it with');
  }

  /**
   * "Als Idee besprechen" on a Question card: it becomes an idea, whose exploration agent starts from
   * the thread (questions, answers, the files in its output directory) instead of the look-up's session.
   */
  private questionAsIdea(cardId: string) {
    const card = this.board.item(cardId);
    if (card?.kind !== 'question') throw new BadRequest('notQuestion', 'the card is no Question card');
    if (card.thread?.thinking) throw new BadRequest('ideaThinking', 'its agent is still reading; discuss it as an idea once the answer is there');
    if (!this.runs(card)) throw repoDown(card);
    // a paused agent's question goes into the discussion with the rest of the thread
    this.board.work(cardId, { kind: 'task', state: 'idea', idea: JSON.stringify({ status: 'open', brief: '' }), session_id: null, paused: null, pausing: null });
    this.board.log(cardId, 'state', 'owner', this.board.t.answer.asIdea);
    this.explorers.tell(cardId, this.answers.opening(cardId));
  }

  /** Deletes a card of the owner's, stopping its worker first; a prototype is discarded into the archive instead. */
  remove(cardId: string) {
    clearTimeout(this.writing.get(cardId)?.timer);
    this.writing.delete(cardId);
    this.keepHere(cardId);
    const { state, landed, workspace, prototype_of } = this.board.row(cardId);
    if (prototype_of) return this.repoOf(cardId).workers.endPrototype(cardId, 'discarded');
    if ((state === 'working' || state === 'waiting' || (landed && workspace)) && this.runs(cardId)) void this.repoOf(cardId).workers.stop(cardId);
    if (state === 'idea') this.explorers.close(cardId);
    // work thrown away ended too (finished work counted when it landed); the retrospective reads in its repository
    else if ((!state || !finished(state)) && this.runs(cardId)) this.workRetro.ended(cardId, workspace);
    this.board.remove(cardId);
  }

  /** Brings a deleted card back (the owner's undo), with the workspace it had where that is still free. */
  restore(cardId: string) {
    this.board.restore(cardId);
    if (this.runs(cardId)) this.repoOf(cardId).workers.restored(cardId);
  }

  /**
   * The card whose worker fills in a repository's settings for everyone (`.obeya/settings.json`)
   * with the `settings` skill, for one that has none yet or still has an adapter module; one still
   * open for it is returned rather than a second made, Obeya's proposal of it taken on as planned.
   * It goes right of everything on the canvas, at the top.
   */
  adapterSetupCard(repo: string): Item {
    const r = this.repos.find((x) => x.ref.id === repo);
    if (!r) throw new BadRequest('invalid', 'unknown repository');
    const open = this.board.openSetupCard(repo, r.ref.name);
    if (open?.state === 'proposal') this.accept(open.id, [], false);
    return open ? this.board.card(open.id)! : this.board.setupCard(repo, r.ref.name);
  }

  /**
   * Obeya proposes the card that fills in a repository's settings where it knows them not (nothing
   * of the repository's own in `.obeya/settings.json`, or an adapter module left on its main branch),
   * as the Konfiguration dialog offers it; a folder without git is left alone.
   */
  private proposeSetup(r: Repo) {
    if (!this.deps.setupProposals || r.info.folder) return;
    const settings = this.shared.get(r.info.path)?.settings ?? {};
    const own = SHARED_FIELDS.some((k) => settings[k] !== undefined);
    this.board.proposeSetup(r.ref.id, r.ref.name, !own || !!this.adapterModules.get(r.info.path));
  }

  /**
   * A doc in the plan directory that is not a project: a card whose worker adds the workstream
   * checklist, started at once; once its change lands, the doc is a project. It goes right of
   * everything on the canvas, at the top, clear of the note on the plan directory at the left (and
   * of a note the owner put elsewhere).
   */
  preparePlanDoc(repo: string, file: string): Item {
    const dir = this.board.snapshot().planDirs?.find((d) => d.repo === repo);
    const doc = dir?.others.find((o) => o.file === file);
    if (!doc) throw new BadRequest('invalid', 'not a doc in the plan directory that is not a project');
    if (doc.preparing) return this.board.card(doc.preparing)!;
    const { title, body } = this.board.t.preparePlanDoc;
    const { items, planDirs = [] } = this.board.snapshot();
    const box = unionBounds([...items.filter((i) => !i.parent).map((i) => boundsOf(i, items)), ...planDirs.flatMap((d) => planDirNoteBox(d) ?? [])]);
    const card = this.board.create({ title: title(file), body: body(file), repo, ...(box ? { x: box.x + box.w + 2 * GAP, y: box.y } : { x: 0, y: 0 }) });
    this.koordinator.request(card.id);
    return this.board.card(card.id)!;
  }

  // ---------------------------------------------------------------- proposals

  /**
   * Accepting a proposal is the owner's go unless they keep it to edit first (`start` false): the
   * card goes to the Koordinator like a started one, a proposed idea, or a task the owner takes as
   * one (`asIdea`), to its exploration agent. Clicked while the proposal is reworked, it is accepted
   * once the new text is there, unless that asks questions.
   */
  private accept(cardId: string, picks: string[][] | undefined, start: boolean, asIdea?: boolean) {
    const card = this.board.item(cardId);
    if (card?.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    // one the Arbeitsrückschau made before it stored proposal data has none
    const proposal = card.proposal ?? { questions: [] };
    if ((start || asIdea) && proposal.revising) {
      // the owner knows what comes; the new text still may ask what must be settled first
      if (this.board.acceptAfterRevision(cardId, asIdea ? 'idea' : true))
        this.board.log(cardId, 'state', 'owner', this.board.t.proposal.acceptAfterRevision(asIdea ? 'asIdea' : proposal.idea ? 'discuss' : 'start'));
      return;
    }
    const idea = !!asIdea || (start && !!proposal.idea);
    this.board.accept(cardId, picks, idea);
    if (idea) this.explorers.open(cardId, proposal.idea ? 'idea' : 'task');
    // one its agent proposed to start later waits until then, unless that time has passed
    else if (start && proposal.startAt && Date.parse(proposal.startAt) > Date.now())
      this.board.snooze(cardId, { until: proposal.startAt, by: 'agent', start: true, ...(proposal.reason ? { why: clip(oneLine(proposal.reason), 200) } : {}) });
    else if (start) {
      if (proposal.startAt) this.repoOf(cardId).workers.startsAt(cardId, proposal.startAt, 'agent', true);
      this.koordinator.request(cardId);
    }
  }

  /** Accepting after the revision is taken back: the proposal stays one. */
  private unaccept(cardId: string) {
    if (this.board.acceptAfterRevision(cardId, false)) this.board.log(cardId, 'state', 'owner', this.board.t.proposal.notAccepting);
  }

  /** The revision is over (`revised`, or the agent ended without a text): a proposal accepted meanwhile is accepted now, unless it asks questions. */
  private revised(cardId: string, revised: boolean) {
    const card = this.board.item(cardId);
    // words the owner said meanwhile are reworked in first
    const armed = card?.proposal?.acceptAfterRevision;
    if (card?.state !== 'proposal' || !armed || card.proposal!.revising) return;
    this.board.acceptAfterRevision(cardId, false);
    const asks = card.proposal!.questions.length;
    if (revised && !asks) return this.accept(cardId, [], true, armed === 'idea');
    const t = this.board.t.proposal;
    this.board.log(cardId, 'state', 'obeya', !revised ? t.notAcceptedNoRevision : asks > 1 ? t.notAcceptedQuestions : t.notAcceptedQuestion);
  }

  // ---------------------------------------------------------------- ideas

  /**
   * The idea is built as it stands: its brief becomes the card's task, and the card goes to the
   * Koordinator to start. A prototype still running for it is discarded: what is built now is the brief.
   */
  private build(cardId: string) {
    const card = this.ideaCard(cardId);
    if (card.idea?.thinking) {
      // the owner knows what comes; the reply still may ask what must be settled first
      if (card.idea.buildAfterReply) return;
      this.board.setIdea(cardId, { buildAfterReply: true });
      this.board.log(cardId, 'state', 'owner', this.board.t.idea.buildAfterReply);
      return;
    }
    if (card.newRepo) return this.intoNewRepo(cardId);
    this.decided(card, { answer: this.board.t.idea.buildAnswer, log: this.board.t.idea.buildLog });
    this.koordinator.request(cardId);
  }

  // ---------------------------------------------------------------- a new repository

  /** Cards whose new repository Obeya makes once the undo window is through (`NewRepo.due`). */
  private newRepos = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * „So bauen“ or „Agent starten“ on a card to be built in a repository that does not exist yet:
   * after a few seconds in which `stayHere` takes it back, Obeya makes that repository and builds or
   * starts the card there (`makeNewRepo`). What it cannot do is refused at once where it can tell.
   */
  private intoNewRepo(cardId: string) {
    const card = this.board.item(cardId);
    const target = card?.newRepo;
    if (!card || !target) throw new BadRequest('invalid', 'the card has no new repository');
    if (target.due) return;
    const t = this.board.t.newRepo;
    const path = newRepoPath(target.path, t);
    if (this.deps.config && this.deps.config.view().source !== 'file') throw new BadRequest('newRepoPath', t.fromCommandLine);
    this.taken(path);
    const due = Date.now() + (this.deps.newRepoHoldMs ?? NEW_REPO_HOLD_MS);
    this.board.setNewRepo(cardId, { ...target, due: new Date(due).toISOString() });
    this.newRepos.set(
      cardId,
      setTimeout(() => {
        this.newRepos.delete(cardId);
        // one after the other, on any canvas: each adds to the configuration as the one before left it
        making = making.then(() => this.makeNewRepo(cardId));
      }, due - Date.now()),
    );
  }

  /** The owner takes back building or starting the card in its new repository while the undo window runs. */
  private stayHere(cardId: string) {
    if (!this.keepHere(cardId)) throw new BadRequest('newRepoGone', 'the new repository is being made already');
    this.board.log(cardId, 'state', 'owner', this.board.t.newRepo.stayed);
  }

  /** Building or starting the card in its new repository does not happen after all, if its undo window still runs; whether it did. */
  private keepHere(cardId: string): boolean {
    const timer = this.newRepos.get(cardId);
    const target = this.board.newRepo(cardId);
    if (!timer || !target?.due) return false;
    clearTimeout(timer);
    this.newRepos.delete(cardId);
    this.board.setNewRepo(cardId, { ...target, due: undefined });
    return true;
  }

  /** Refuses a folder that is a repository of a canvas already: the card is to be built there instead. */
  private taken(path: string) {
    const real = realPath(path);
    for (const c of this.deps.canvases?.() ?? [this]) {
      const r = c.repos.find((x) => realPath(x.info.path) === real);
      if (r) throw new BadRequest('newRepoPath', this.board.t.newRepo.taken(path, c.board.canvas.name));
    }
  }

  /**
   * Makes the card's new repository and builds or starts the card there, one step after the other:
   * the folder and git (`makeRepo`), the configuration with a canvas of its own named after it (or
   * the repository on this canvas), then the card: an idea is decided as „So bauen“ decides it, and
   * moves, with its history and decisions, to the new canvas, where it starts. A step that fails takes
   * back those before it, and the card says why.
   */
  private async makeNewRepo(cardId: string) {
    const t = this.board.t.newRepo;
    const target = this.board.newRepo(cardId);
    const card = this.board.item(cardId);
    if (!card || !target?.due) return;
    const undo: (() => unknown)[] = [];
    try {
      const path = newRepoPath(target.path, t);
      this.taken(path);
      const config = this.deps.config;
      if (!config) throw new Error('no configuration to add the repository to');
      const repo = makeRepo(path, t);
      undo.push(repo.undo);
      const { resolved } = await config.check(config.current());
      const here = resolved.findIndex((r) => r?.id === this.id);
      if (here < 0) throw new Error(`the canvas ${this.id} is not in the configuration`);
      // on the configuration as it is now, and taken back from it as it is then: changes meanwhile stay
      const added = { path: target.path.trim() };
      const now = config.current();
      const after = target.canvas ? [...now, { repos: [added] }] : now.map((c, i) => (i === here ? { ...c, repos: [...c.repos, added] } : c));
      await config.save(after);
      const without = () =>
        config.current().flatMap((c) => {
          const repos = c.repos.filter((r) => r.path !== added.path);
          return repos.length ? [{ ...c, repos }] : [];
        });
      undo.push(() => config.save(without()));
      if (!target.canvas) return this.joined(cardId, path, repo.made);
      const checked = await config.check(after);
      const id = checked.resolved.at(-1)?.id;
      const there = id ? this.deps.canvases?.().find((c) => c.id === id) : undefined;
      if (!there) throw new Error(t.notStarted(checked.problems.filter((p) => p.canvas === after.length - 1).map((p) => p.detail).join('; ') || path));
      this.moveTo(cardId, there, repo.made);
    } catch (e) {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (u) {
          console.error(`Obeya: taking back a step of the new repository of ${cardId}:`, u);
        }
      }
      if (!this.board.item(cardId)) return;
      this.board.setNewRepo(cardId, { ...target, due: undefined });
      this.board.log(cardId, 'error', 'obeya', t.failed(messageOf(e)), { code: e instanceof BadRequest ? e.code : undefined });
    }
  }

  /** The new repository joined this canvas: the card works in it, an idea built as „So bauen“ builds it. */
  private joined(cardId: string, path: string, made: boolean) {
    const r = this.repos.find((x) => x.info.path === path);
    if (!r) throw new Error(`${path} does not run on the canvas`);
    const card = this.board.item(cardId)!;
    const target = this.board.newRepo(cardId)!;
    this.board.patch(cardId, { repo: r.ref.id });
    this.board.setNewRepo(cardId, { path: target.path, canvas: false, by: target.by, made: true });
    this.board.log(cardId, 'state', 'obeya', this.board.t.newRepo.joined(target.path.trim(), made));
    if (card.state === 'idea') this.decided(card, { answer: this.board.t.newRepo.buildAnswer(target.path.trim()), log: this.board.t.idea.buildLog });
    this.koordinator.request(cardId);
  }

  /**
   * The card leaves for the canvas `there`, whose home repository was made for it: an idea is
   * decided here first (its agent's session ends, its prototypes are discarded), then the card goes
   * with its history, decisions and screenshots, out of its group, and starts there. This canvas's
   * sheet says where it went, and a page that has it open follows it.
   */
  private moveTo(cardId: string, there: CanvasRuntime, made: boolean) {
    const card = this.board.item(cardId)!;
    const target = this.board.newRepo(cardId)!;
    const shown = target.path.trim();
    // the screenshots of the task and of its conversation, which the new canvas keeps under its own name
    const row = this.board.row(cardId);
    const shots = [...(row.images ? (JSON.parse(row.images) as string[]) : []), ...this.board.events(cardId).flatMap((e) => e.images ?? [])];
    this.images.copyTo(there.images, shots);
    if (card.state === 'idea') this.decided(card, { answer: this.board.t.newRepo.buildAnswer(shown), log: this.board.t.idea.buildLog });
    clearTimeout(this.writing.get(cardId)?.timer);
    this.writing.delete(cardId);
    this.said.delete(cardId);
    const at = there.board.freeSpot(there.inView);
    this.deps.store.moveCard(cardId, there.id, at, { new_repo: JSON.stringify({ path: target.path, canvas: true, by: target.by, made: true }) });
    this.deps.store.dropEmptyGroups(this.id);
    there.board.log(cardId, 'state', 'obeya', there.board.t.newRepo.movedHere(this.board.canvas.name, shown, made));
    const moved = { card: cardId, title: card.title, canvas: there.id, canvasName: there.board.canvas.name };
    this.board.moved(moved);
    this.commander.tell(`The card "${card.title}" moved to the canvas "${there.board.canvas.name}", in its new repository ${shown}, and is built there.`);
    this.board.notify({ cardId, text: this.board.t.newRepo.movedAway(card.title, there.board.canvas.name), movedTo: there.id });
    there.board.changed();
    there.koordinator.request(cardId);
  }

  /**
   * "Teilaufgabe abtrennen": the part its agent marked as settled becomes a task of its own beside the idea,
   * in its group and linked to it, with the screenshots of the discussion, and starts at once. The
   * idea stays open with its conversation and its prototypes; its agent hears what became of the part.
   * Not while the agent works on a reply, which may change the split.
   */
  private splitOff(cardId: string) {
    const idea = this.settledIdea(cardId);
    const { split } = this.board.idea(cardId);
    if (!split) throw new BadRequest('noSplit', 'the idea’s agent has marked no task to split off');
    const t = this.board.t.idea;
    const shown = this.board.events(cardId).flatMap((e) => (e.kind === 'talk' && e.author === 'owner' ? (e.images ?? []) : []));
    const images = [...new Set([...(idea.images ?? []), ...shown])].slice(-MAX_IMAGES);
    const task = this.board.create({ title: split.title, body: `${split.brief}\n\n${t.settledTask(idea.title)}`, from: cardId, ...(images.length ? { images } : {}) });
    this.board.log(task.id, 'state', 'owner', t.settledFrom(idea.title));
    this.board.setIdea(cardId, { split: undefined });
    this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(idea.title), answer: t.splitOffAnswer(split.title), by: 'owner' });
    this.board.log(cardId, 'state', 'owner', t.splitOffLog(split.title));
    this.koordinator.request(task.id);
    this.explorers.tell(
      cardId,
      `The owner clicked "${t.splitOffButton}": the part you marked as settled is now the task “${split.title}”, on a card of its own beside this idea, and a worker starts on it. Obeya has cleared the split. This idea stays open, with this conversation and its prototypes, planned and running, for what is still open. Trim the brief to what is open (the built part a line under decisions, as the task “${split.title}”), then reply to the owner in a sentence or two.`,
    );
  }

  /** Building after the reply is taken back: the idea stays in its discussion. */
  private unbuild(cardId: string) {
    if (!this.ideaCard(cardId).idea?.buildAfterReply) return;
    this.board.setIdea(cardId, { buildAfterReply: false });
    this.board.log(cardId, 'state', 'owner', this.board.t.idea.unbuild);
  }

  /**
   * The idea's agent has answered all it was told (`replied`), or its turn ended without (an error,
   * a restart): an idea to build after the reply is built now, unless the reply asks questions.
   */
  private replied(cardId: string, replied: boolean) {
    const card = this.board.item(cardId);
    if (card?.state !== 'idea' || !card.idea?.buildAfterReply) return;
    this.board.setIdea(cardId, { buildAfterReply: false });
    const asks = card.idea.questions.length;
    if (replied && !asks && card.idea.status === 'open') return this.build(cardId);
    const t = this.board.t.idea;
    this.board.log(cardId, 'state', 'obeya', !replied ? t.notBuiltNoReply : asks > 1 ? t.notBuiltQuestions : t.notBuiltQuestion);
  }

  /**
   * The idea is built on this prototype: the prototype's workspace and branch become the idea's,
   * whose worker goes on from there with the brief, the prototype's handover and the owner's answers
   * on it. The prototype goes into the archive as built, the idea's other prototypes as discarded.
   * What stands in the way is thrown at once; git renames the branch in the background.
   */
  private buildOnPrototype(prototypeId: string, workstreamId?: string) {
    const prototype = this.prototypeCard(prototypeId);
    const project = this.board.projectOf(prototype.prototypeOf!);
    if (project) return this.buildWorkstreamOn(prototype, project, workstreamId);
    const planning = this.board.item(prototype.prototypeOf!);
    if (planning?.becomesProject) throw new BadRequest('projectPending', 'the idea becomes a project; build on the prototype once its plan doc has landed');
    if (!planning) throw new BadRequest('ideaGone', 'the prototype’s idea is no longer on the canvas, and no project of it is');
    const idea = this.settledIdea(prototype.prototypeOf!);
    const { workers } = this.repoOf(prototype);
    return workers.buildOn(prototype.id, idea).then(() => {
      this.decided(idea, { answer: this.board.t.idea.buildOnAnswer(prototype.title), log: this.board.t.idea.buildOnLog(prototype.title) });
      this.koordinator.request(idea.id);
    });
  }

  /**
   * The idea has become a project: the workstream the owner chose, or else the one its plan doc
   * builds on the prototypes with, is built on the prototype's branch and starts at once; the
   * idea's other prototypes are discarded. As `buildOnPrototype`, what stands in the way is thrown at once.
   */
  private buildWorkstreamOn(prototype: Item, project: Item, workstreamId?: string) {
    const ws = workstreamId ? this.board.item(workstreamId) : prototypeWorkstream(this.board.items(), project.id);
    if (!ws && !workstreamId) throw new BadRequest('workstreamMissing', 'the plan doc does not say which workstream builds on the prototype: choose it');
    if (!ws || ws.parent !== project.id) throw new BadRequest('invalid', 'not a workstream of the project the idea became');
    if (!buildableOn(ws)) throw new BadRequest('workstreamStarted', 'only a workstream nobody has started can be built on a prototype');
    const named = `${ws.label ? `${ws.label} ` : ''}${this.board.t.quote(ws.title)}`;
    return this.repoOf(prototype)
      .workers.buildOn(prototype.id, ws, named)
      .then(() => {
        this.discardPrototypes(prototype.prototypeOf!);
        const t = this.board.t.idea;
        this.board.decide({ project_id: project.id, card_id: ws.id, question: t.whichPrototype(named), answer: t.onPrototype(prototype.title), by: 'owner' });
        this.board.log(ws.id, 'state', 'owner', t.workstreamOnLog(prototype.title));
        this.koordinator.request(ws.id);
      });
  }

  /** The idea's prototypes still on the canvas go into the archive as discarded. */
  private discardPrototypes(ideaId: string) {
    for (const p of this.board.items().filter((i) => i.prototypeOf === ideaId)) this.repoOf(p).workers.endPrototype(p.id, 'discarded', 'obeya');
  }

  /** The idea is decided for building: its agent's conversation ends, the brief becomes the task, the other prototypes are discarded. */
  private decided(idea: Item, how: { answer: string; log: string }) {
    const { brief } = this.board.idea(idea.id);
    this.explorers.close(idea.id);
    this.discardPrototypes(idea.id);
    this.board.work(idea.id, { state: 'planned', ...(brief.trim() ? { body: brief.trim() } : {}) });
    // the screenshots the owner showed in the discussion belong to what is built
    const shown = this.board.events(idea.id).flatMap((e) => (e.kind === 'talk' && e.author === 'owner' ? (e.images ?? []) : []));
    if (shown.length) this.addTaskImages(idea.id, shown);
    this.board.decide({ project_id: null, card_id: idea.id, question: this.board.t.idea.howOn(idea.title), answer: how.answer, by: 'owner' });
    this.board.log(idea.id, 'state', 'owner', how.log);
  }

  /**
   * A big idea becomes a project: a worker writes its plan doc on the idea's card at once, and once
   * the doc lands, the project takes the idea's place. Its prototypes stay: the worker hears what
   * they showed, and the owner builds a workstream on one of them once the project stands.
   */
  private planDoc(cardId: string) {
    const task = this.board.item(cardId);
    if (task && task.state !== 'idea') return this.planTaskDoc(task);
    const card = this.settledIdea(cardId);
    const idea = this.board.idea(cardId);
    const dir = this.repoOf(card).adapter.planDocs.dir;
    const outside = this.outsidePlanDoc(card);
    const prototypes = this.board.items().filter((i) => i.prototypeOf === cardId);
    const t = this.board.t.idea;
    this.explorers.close(cardId);
    this.board.work(cardId, {
      state: 'planned',
      becomes_project: 1,
      ...outside?.row,
      body: [
        t.planDocTask(dir, false, outside?.file),
        t.planDocIdea(card.title),
        idea.brief.trim() || card.body.trim(),
        prototypes.length
          ? [
              t.planDocPrototypes(prototypes.length),
              ...prototypes.map((p) => {
                const summary = this.board.summary(p.id)?.trim();
                return summary ? t.planDocHandedOver(p.title, summary) : t.planDocInProgress(p.title);
              }),
            ].join('\n\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(card.title), answer: t.planDocAnswer, by: 'owner' });
    this.board.log(cardId, 'state', 'owner', t.planDocLog);
    this.koordinator.request(cardId);
  }

  /**
   * A planned task of the owner's that nobody has worked on becomes a project the same way: its
   * worker writes the plan doc from the task, with its screenshots, on the task's card.
   */
  private planTaskDoc(card: Item) {
    if (!plannableAsProject(card))
      throw new BadRequest('notPlannable', 'only an idea, or a planned task of your own nobody has worked on yet, can be planned as a project');
    const t = this.board.t.idea;
    const dir = this.repoOf(card).adapter.planDocs.dir;
    const outside = this.outsidePlanDoc(card);
    this.board.work(card.id, { becomes_project: 1, ...outside?.row, body: [t.planDocTask(dir, true, outside?.file), t.planDocCard(card.title), card.body.trim()].filter(Boolean).join('\n\n') });
    this.board.decide({ project_id: null, card_id: card.id, question: t.howOnTask(card.title), answer: t.planDocAnswer, by: 'owner' });
    this.board.log(card.id, 'state', 'owner', t.planDocTaskLog);
    this.koordinator.request(card.id);
  }

  /**
   * The doc a card planned as a project writes where the plan directory is a folder outside the
   * repository: named after the card, beside the docs there. Nothing of that folder lands, so the
   * card names its doc from the start (`plan_docs`), and the project takes its place once the
   * owner has approved the card (`linkOrigins`). None for a plan directory in the repository.
   */
  private outsidePlanDoc(card: Item): { file: string; row: { plan_docs: string } } | undefined {
    const r = this.repoOf(card);
    const outside = outsidePlanDir(r.adapter.planDocs.dir);
    // in a folder without git nothing lands either: the doc is there as soon as it is written
    const dir = outside ?? (r.info.folder ? r.adapter.planDocs.dir.replace(/[/\\]+$/, '') : null);
    if (!dir) return;
    const at = (file: string) => (outside ? file : join(r.info.path, file));
    const name = slug(card.title).slice(0, 60).replace(/^[.-]+|[.-]+$/g, '') || 'plan';
    // nor one another card was given and has not written yet
    const given = new Set(this.deps.store.withPlanDocs(this.id).flatMap((row) => (JSON.parse(row.plan_docs!) as string[]).map(pathOfRef)));
    let file = `${dir}/${name}.md`;
    for (let n = 2; existsSync(at(file)) || given.has(file); n++) file = `${dir}/${name}-${n}.md`;
    const ref = r.ref.id === this.repos[0]!.ref.id ? file : `${r.ref.id}:${file}`;
    return { file, row: { plan_docs: JSON.stringify([ref]) } };
  }

  /** Parked or dropped, the idea stays on the canvas with its brief; what its agent has not answered yet waits for the conversation to go on. */
  private shelve(cardId: string, how: 'park' | 'drop') {
    const card = this.ideaCard(cardId);
    // parked or dropped in the undo window of its new repository: it is not built there
    this.keepHere(cardId);
    this.explorers.interrupt(cardId, how === 'park' ? 'parked' : 'dropped');
    this.board.setIdea(cardId, { status: how === 'park' ? 'parked' : 'dropped', buildAfterReply: false });
    const t = this.board.t.idea;
    if (how === 'drop') this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(card.title), answer: t.dropped, by: 'owner' });
    this.board.log(cardId, 'state', 'owner', how === 'park' ? t.parked : t.dropped);
  }

  /**
   * Workers build throwaway prototypes for the idea, each in its own workspace; they never land
   * themselves. One per planned variant chosen, each with its approach in its title, and one for
   * what the owner wrote. Neither chosen nor written: the planned variants that have no prototype
   * on the canvas, or, with none planned, the idea as it stands.
   */
  private prototype(cardId: string, what: string, chosen?: string[]) {
    const card = this.ideaCard(cardId);
    // a prototype is a branch thrown away or built on: a folder without git has none
    if (this.repoOf(card).info.folder) throw new BadRequest('inFolder', 'a folder without git has no prototypes: its cards change the folder itself');
    const { variants = [] } = this.board.idea(cardId);
    const t = this.board.t.idea;
    const running = new Set(this.board.items().flatMap((i) => (i.prototypeOf === cardId && i.variant ? [i.variant] : [])));
    const picked = chosen ? variants.filter((v) => chosen.includes(v.approach)) : what ? [] : variants.filter((v) => !running.has(v.approach));
    if (chosen?.length && !picked.length && !what) throw new BadRequest('invalid', 'none of the chosen variants is planned');
    if (!chosen && !what && variants.length && !picked.length) throw new BadRequest('variantsRunning', 'every planned variant has its prototype on the canvas');
    const runs = picked.map((v) => {
      const others = variants.filter((o) => o !== v).map((o) => o.approach);
      return { approach: v.approach, task: others.length ? `${v.show}\n\n${t.onlyThisVariant(others.join(', '))}` : v.show, variant: v.approach };
    });
    if (what || !runs.length) runs.push({ approach: approachOf(what), task: what || t.showAsItStands, variant: '' });
    const taken = new Set((this.board.item(cardId)?.prototypes ?? []).map((p) => p.title));
    const started: string[] = [];
    try {
      for (const run of runs) {
        const base = t.prototypeTitle(`${card.title}${run.approach ? ` – ${run.approach}` : ''}`);
        let title = base;
        for (let n = 2; taken.has(title); n++) title = `${base} (${n})`;
        taken.add(title);
        const prototype = this.board.addPrototype(cardId, title, run.task, run.variant || undefined);
        try {
          void this.repoOf(prototype).workers.start(prototype.id).catch((e: unknown) => this.board.log(prototype.id, 'error', 'obeya', messageOf(e)));
        } catch (e) {
          this.board.remove(prototype.id);
          throw e;
        }
        started.push(title);
      }
    } finally {
      if (started.length) {
        // the owner now waits for the prototypes, not the other way round; the agent's reply to a result gives the turn back
        this.board.setIdea(cardId, { yourTurn: false });
        this.board.log(
          cardId,
          'state',
          'owner',
          started.length > 1 ? t.prototypesStarted(started.map((s) => this.board.t.quote(s)).join(', ')) : t.prototypeStarted(started[0]!, what && !picked.length ? what.replace(/[.!?]$/, '') : ''),
        );
      }
    }
  }

  /** A prototype handed over: its demo shows on the idea beside those of the other prototypes, and the idea's agent hears what it found. */
  private prototypeReady(prototype: Item, summary: string, demo: string | undefined) {
    const idea = this.board.item(prototype.prototypeOf!);
    if (!idea) return;
    this.board.log(idea.id, 'state', 'worker', this.board.t.idea.prototypeReady(prototype.title, !!demo));
    if (idea.state === 'idea')
      this.explorers.tell(
        idea.id,
        `A worker built the throwaway prototype “${prototype.title}” for this idea. Its summary:\n\n${summary}\n\nTake what it showed and what it means for the idea into the brief, then reply to the owner in a sentence or two.`,
      );
  }

  /** A question on a prototype was answered: the idea's agent takes it into the brief, so the idea does not ask it again. */
  private prototypeAnswered(prototype: Item, question: string, answer: string) {
    this.explorers.tell(
      prototype.prototypeOf!,
      `On the prototype “${prototype.title}”, its worker asked: „${question}“\n\nThe owner answered: ${answer}\n\nTake what this settles into the brief (decisions, open questions), so it is not asked again. Do not reply to the owner for it; end your turn without a reply unless it raises something they must decide now.`,
      true,
    );
  }

  private prototypeCard(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (!card.prototypeOf) throw new BadRequest('notPrototype', 'the card is not a prototype');
    return card;
  }

  private ideaCard(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (card.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return card;
  }

  /**
   * A new card or idea the owner asked for on another canvas: made there as there, its screenshots
   * copied over; a follow-up of a card here goes there in no group and names that card. Its id, for
   * a wait in the same command.
   */
  private elsewhere(c: Extract<Command, { do: 'newCard' | 'newIdea' }>): unknown {
    const there = this.deps.canvases?.().find((x) => x.id === c.canvas);
    if (!there) throw new Error(`the canvas ${c.canvas} does not run`);
    if (c.images?.length) this.images.copyTo(there.images, c.images);
    const { canvas: _, place: __, repo: ___, ...rest } = c;
    if (rest.do === 'newIdea') return there.run(rest);
    const { from, ...card } = rest;
    return from ? there.followUp(card, from) : there.run(card);
  }

  /** A card the Koordinator of another canvas makes here for the owner, following up on a card of its own. */
  followUp(c: Extract<Command, { do: 'newCard' }>, from: string): string {
    const card = this.board.create({ title: c.title, body: c.body, ...(c.images?.length ? { images: c.images } : {}), ...this.board.freeSpot(this.inView) }, from);
    this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
    if (c.until && Date.parse(c.until) > Date.now()) this.snooze(card.id, c.until);
    else if (c.start || c.until) this.koordinator.request(card.id);
    return card.id;
  }

  /** An idea to build or plan: not while its agent works on a reply, which will change the brief the owner decides on. */
  private settledIdea(cardId: string): Item {
    const card = this.ideaCard(cardId);
    if (card.idea?.thinking) throw new BadRequest('ideaThinking', 'the idea’s agent is still working on its reply; decide once it is there');
    return card;
  }

  /** A voice (or typed) command, once its undo window has passed; a new card's id, for a wait on it in the same command. */
  run(c: Command) {
    switch (c.do) {
      case 'newCard':
      case 'newIdea':
        if (c.canvas && c.canvas !== this.id) return this.elsewhere(c);
        break;
      case 'newRepo': {
        const card = this.board.item(c.card);
        if (!card) throw new BadRequest('unknownCard', 'unknown card');
        this.board.setNewRepo(c.card, { path: c.path, canvas: c.canvas, by: 'owner' });
        return this.act(c.card, { action: card.state === 'idea' ? 'build' : 'start' });
      }
    }
    switch (c.do) {
      case 'newCard': {
        const at = c.from ? { from: c.from } : this.board.freeSpot(c.place ?? this.inView);
        const card = this.board.create({
          title: c.title,
          body: c.body,
          ...(c.repo ? { repo: c.repo } : {}),
          ...(c.images?.length ? { images: c.images } : {}),
          ...at,
        });
        this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
        // one for later waits until then; a time that passed in the undo window starts it now
        if (c.until && Date.parse(c.until) > Date.now()) this.snooze(card.id, c.until);
        else if (c.start || c.until) this.koordinator.request(card.id);
        return card.id;
      }
      case 'reviewPr':
        return this.reviewPr(c);
      case 'newIdea': {
        const card = this.board.create({ idea: true, title: c.title, body: c.body, ...(c.repo ? { repo: c.repo } : {}), ...this.board.freeSpot(c.place ?? this.inView) });
        this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
        // the agent opens the discussion with what the owner said
        this.explorers.discuss(card.id, c.body.trim() || c.title, true, this.images.resolve(c.images));
        return;
      }
      case 'discuss':
        return this.act(c.card, { action: 'discuss', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'prototype':
        return this.act(c.card, { action: 'prototype', text: c.text });
      case 'buildPrototype':
        return this.act(c.card, { action: 'buildPrototype', ...(c.workstream ? { workstream: c.workstream } : {}) });
      case 'discard':
        return this.act(c.card, { action: 'discard' });
      case 'build':
      case 'splitOff':
      case 'planDoc':
      case 'park':
      case 'drop':
        return this.act(c.card, { action: c.do });
      case 'start':
      case 'force':
        // screenshots said with the start belong to the task, so the worker gets them with it
        if (c.images?.length) this.addTaskImages(c.card, c.images);
        return this.act(c.card, { action: c.do });
      case 'note':
      case 'feedback':
        return this.act(c.card, { action: 'message', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'answer':
        return this.act(c.card, { action: 'answer', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'revise':
        return this.act(c.card, { action: 'revise', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'accept':
        return this.act(c.card, { action: 'accept', ...(c.idea ? { idea: true } : {}) });
      case 'approve':
      case 'dismiss':
      case 'keep':
      case 'dequeue':
      case 'stop':
      case 'pause':
      case 'resume':
      case 'wake':
        return this.act(c.card, { action: c.do });
      case 'snooze':
        return this.act(c.card, { action: 'snooze', until: c.until });
      case 'configure':
        return this.deps.config?.save(c.canvases);
      case 'remember':
        return this.remember(c.text, c);
      case 'workRetro':
        return this.workRetro.now(c.repo);
      case 'group':
        return void this.board.createGroup(c.name, c.cards);
      case 'ungroup':
        return this.board.group(c.cards, null);
      case 'renameGroup':
        return this.board.renameGroup(c.group, c.name);
      case 'merge':
        return this.merge(c.card, c.others, c.title);
      case 'delete':
        this.untouched(c.card);
        return this.remove(c.card);
    }
  }

  /** A planned task nobody has worked on yet, still as when the Koordinator chose it; else why not. */
  private untouched(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (!untouched(card)) throw new BadRequest('notUntouched', `„${card.title}“ is no planned task nobody has worked on any more`);
    return card;
  }

  /** Planned tasks nobody has worked on merged into the first (`Board.merge`); the others go. */
  private merge(keep: string, others: string[], title: string) {
    const cards = [keep, ...others].map((id) => this.untouched(id));
    if (new Set(cards.map((c) => c.repo)).size > 1) throw new BadRequest('otherRepos', 'only tasks of one repository can be merged');
    this.board.merge(keep, others, title);
    for (const id of others) this.remove(id);
  }

  /**
   * „Review PR #5“: a review card for the pull request someone outside opened, started at once, the
   * owner's words with it as its task. A PR that has a card on the canvas already opens that one, and
   * the words go to its worker. What goes wrong (no such PR, one closed) the owner hears.
   */
  async reviewPr(c: Extract<Command, { do: 'reviewPr' }>): Promise<string | undefined> {
    const repo = c.repo ? this.repos.find((r) => r.ref.id === c.repo) : this.repos[0];
    const t = this.board.t;
    const fail = (why: string) => void this.board.notify({ text: t.review.failed(c.pr, why) });
    if (!repo) return fail('no repository');
    let url: string;
    try {
      url = /^\d+$/.test(c.pr) ? await this.deps.forge.urlOf(repo.info.path, Number(c.pr)) : c.pr.trim();
    } catch (e) {
      return fail(messageOf(e));
    }
    // gh's logins read once for this URL and those of the cards it is compared with
    const hosts = ghHosts();
    const github = (u: string) => onGitHub(u, () => hosts);
    const ref = parsePrUrl(url, github);
    if (!ref) return fail(url);
    url = ref.url;
    // a pull request of another repository would be merged there, from a workspace of this one
    const origin = originUrl(repo.info);
    if (origin && !sameRepo(origin, ref.owner, ref.repo)) return fail(t.review.otherRepo(repo.ref.id));
    // a card of the PR's own (one of Obeya's workers opened it) is the card for it too, also where
    // its URL was recorded in another form (a slash at the end, the host in capitals, `/pull/` on Forgejo)
    const same = (other?: string) => !!other && (parsePrUrl(other, github)?.url ?? other) === url;
    const had = this.board.items().find((i) => (same(i.contribution?.url) || same(i.pr?.url)) && !i.archivedAt);
    if (had) {
      if (c.text) this.act(had.id, { action: 'message', text: c.text, spoken: !!c.spoken });
      this.board.notify({ text: t.review.opened(ref.number), cardId: had.id, open: true });
      return had.id;
    }
    let info: ContributionInfo;
    try {
      info = await this.deps.forge.contribution(repo.info.path, url);
    } catch (e) {
      return fail(messageOf(e));
    }
    if (info.state !== 'OPEN') return fail(t.review.notOpen(info.state === 'MERGED'));
    const card = this.board.create({ title: `PR #${ref.number}: ${info.title}`.slice(0, 200), body: c.text, repo: repo.ref.id, ...this.board.freeSpot(c.place ?? this.inView) });
    const stored: StoredContribution = {
      url,
      number: ref.number,
      author: info.author,
      title: info.title,
      canModify: info.canModify,
      ...(info.headRepo ? { headRepo: info.headRepo } : {}),
      ...(info.headRef ? { headRef: info.headRef } : {}),
    };
    this.board.work(card.id, { contribution: JSON.stringify(stored) });
    this.board.log(card.id, 'state', 'owner', t.voice.created);
    this.watchPrs(repo);
    this.koordinator.request(card.id);
    // the card opens, so the owner sees its review begin
    this.board.notify({ text: t.review.started(ref.number, info.author), cardId: card.id, open: true });
    return card.id;
  }

  /** Adds screenshots to a card's task, keeping the latest when there are more than a message takes. */
  private addTaskImages(cardId: string, images: string[]) {
    const had = this.board.item(cardId)?.images ?? [];
    this.board.work(cardId, { images: JSON.stringify([...had.filter((i) => !images.includes(i)), ...images].slice(-MAX_IMAGES)) });
  }

  /** The cards whose worker is in the middle of a turn, which a restart would cut off. */
  busy(): string[] {
    return this.repos.flatMap((r) => r.workers.busyCards());
  }

  /** The owner came back to a page of this canvas: its open pull requests are looked at now, and its demo sites. */
  ownerBack() {
    for (const r of this.repos) r.prs?.soon();
    this.sharing.soon();
    this.siteCredentials();
  }

  /** The owner's personal demo site was set up, connected, removed, or a private repository ticked for it: the cards share there, or export. */
  personalSiteChanged() {
    this.siteCredentials();
  }

  /** A site's env file placed or removed on this machine since, or the personal site changed: its repository's cards share again, or export. */
  private siteCredentials() {
    let changed = false;
    for (const r of this.repos) {
      const next = shareRef(r.site, this.deps.home, r.info.path, !!r.isPublic);
      if (JSON.stringify(SHARE_FIELDS.map((f) => r.ref[f])) !== JSON.stringify(SHARE_FIELDS.map((f) => next[f]))) {
        setShare(r.ref, next);
        changed = true;
      }
    }
    if (changed) this.board.changed();
  }

  /** Obeya is about to restart, or no longer is: the workers hear so and pause for it (or for their repository's restart that waits). */
  restartDue(due: DueRestart | null) {
    this.obeyaDue = due;
    const p = this.pending;
    for (const r of this.repos) r.workers.restartDue(due ?? (p?.paths.has(r.info.path) ? repoDue(p) : null));
  }

  shutdown() {
    this.shutDown = true;
    clearInterval(this.waker);
    clearTimeout(this.wakeSoon);
    this.unwatch();
    this.pending?.stop();
    this.pending = null;
    for (const [, w] of this.writing) clearTimeout(w.timer);
    for (const stop of this.branchSettings.values()) stop();
    for (const r of this.repos) this.stopRepo(r);
    this.koordinator.shutdown();
    this.explorers.shutdown();
  }
}

/** A prototype's approach, for its title: the first sentence of what it is to show, kept short. */
export function approachOf(what: string, max = 40): string {
  const text = what.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  const first = (text.match(/^.+?[.!?;:](?=\s|$)/)?.[0] ?? text).replace(/[.;:]$/, '');
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

/**
 * Starts the canvases; one that does not start is left out, with why in Obeya's log and in
 * "Konfiguration" (which checks the configuration again, and shows `failed` of one whose home
 * repository did not start), and the others run.
 */
export function startCanvases(configs: CanvasConfig[], deps: CanvasDeps, failed: (f: StartFailure) => void = () => {}): CanvasRuntime[] {
  return configs.flatMap((c) => {
    try {
      return new CanvasRuntime(c, deps);
    } catch (e) {
      const why = e instanceof ConfigError || e instanceof HomeDown ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`Obeya: the canvas ${c.name ?? c.id ?? c.repos[0]?.path} does not start, left out: ${why}`);
      if (e instanceof HomeDown) failed({ canvas: e.canvas, detail: e.message });
      return [];
    }
  });
}

/**
 * The canvases Obeya serves, as its configuration has them while it runs (design: Live
 * configuration): a canvas new in it starts at once, one that changed takes the change
 * (`CanvasRuntime.apply`), one no longer in it stops once its agents paused, its cards kept.
 */
export class Canvases {
  private list: CanvasRuntime[];
  private listeners = new Set<() => void>();
  /** By canvas's id: why one in the configuration does not run (its home repository did not start). */
  private down = new Map<string, string>();

  constructor(
    configs: CanvasConfig[],
    private deps: CanvasDeps,
    /** A canvas started while Obeya runs. */
    private started: (c: CanvasRuntime) => void = () => {},
  ) {
    this.deps = {
      ...deps,
      stopped: (c, why) => {
        this.list = this.list.filter((x) => x !== c);
        this.down.set(c.id, why);
        this.emit();
      },
      canvases: () => this.list,
    };
    this.list = this.start(configs);
  }

  /** Starts canvases, keeping why one did not. */
  private start(configs: CanvasConfig[]): CanvasRuntime[] {
    const list = startCanvases(configs, this.deps, (f) => this.down.set(f.canvas, f.detail));
    for (const c of list) this.down.delete(c.id);
    return list;
  }

  /** The canvases, and repositories of those that run, that do not run as the configuration has them. */
  failures(): StartFailure[] {
    return [...[...this.down].map(([canvas, detail]) => ({ canvas, detail })), ...this.list.flatMap((c) => c.failures())];
  }

  all(): CanvasRuntime[] {
    return this.list;
  }

  get(id: string): CanvasRuntime | undefined {
    return this.list.find((c) => c.id === id);
  }

  /** Calls `fn` whenever a canvas starts, stops, or changes its name or repositories. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The configuration saved: `ids` are its canvases' ids as its check resolved them (null where one
   * does not resolve; then no canvas leaves, since which one it is stays unknown).
   */
  apply(configs: CanvasConfig[], ids: (string | null)[]) {
    configs.forEach((config, i) => {
      const id = ids[i];
      if (!id) return;
      const running = this.get(id);
      if (running) return running.apply(config);
      const [c] = this.start([config]);
      if (!c) return;
      this.list.push(c);
      console.log(`Obeya: the canvas ${c.board.canvas.name} (/c/${c.id}) runs now`);
      this.started(c);
    });
    // the configuration's order is the order canvases are listed in (the switcher, the phone); one leaving goes last
    const at = (c: CanvasRuntime) => (ids.includes(c.id) ? ids.indexOf(c.id) : ids.length);
    this.list.sort((a, b) => at(a) - at(b));
    if (!ids.includes(null)) {
      // a canvas that did not start and left the configuration is no longer wrong
      for (const id of [...this.down.keys()]) if (!ids.includes(id)) this.down.delete(id);
      for (const c of [...this.list])
        if (!ids.includes(c.id))
          c.retire(() => {
            this.list = this.list.filter((x) => x !== c);
            this.emit();
          });
    }
    this.emit();
  }

  /** Stops every canvas, for Obeya to end. */
  shutdown() {
    for (const c of this.list) c.shutdown();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Why a canvas's configuration does not work; `repo` is the index of the repository in question. */
export class ConfigError extends Error {
  constructor(
    readonly code: ConfigProblemCode,
    message: string,
    readonly repo?: number,
  ) {
    super(message);
  }
}

/**
 * What resolving a repository reads of it with git (`readingRepo`): where it is and its main
 * branch (`info`), that branch as git tells it whatever the owner set (`detected`), whether its
 * main branch still has an adapter module (`hasAdapterModule`), and its `.obeya/settings.json`
 * there (`readShared`).
 */
export interface RepoRead {
  info: RepoInfo;
  detected: string;
  adapterModule: boolean;
  shared: SharedRead;
}

/**
 * Reads a repository for `resolveCanvas`, as git steps; null where `path` is no git repository. A
 * folder without git (`folder`) is read as it is, without git: null where it is no directory.
 */
export function* readingRepo(path: string, folder = false): GitSteps<RepoRead | null> {
  markFolder(path, folder);
  if (folder) return readFolder(path);
  const [[remote], branches] = yield* together(gitCalls(['remote', 'get-url', 'origin']), readingBranches());
  if (branches == null) return null;
  const detected = yield* detectingBranch(branches);
  const branch = branchSetting(path) || detected;
  const commit = yield* branchCommit(branch, branches);
  const [adapterModule, shared] = yield* together(readingAdapterModule(commit), readingShared(commit));
  return { info: { path, remote: remote ?? null, branch }, detected, adapterModule, shared };
}

/** How often `readSettings` reads a repository whose refs move while git reads it. */
const READ_TRIES = 5;

/** What `moved` came to (`moved`). */
type Moved = 'same' | 'follow' | 'due';

/** What a repository's default branch has of its settings: its `.obeya/settings.json` and Claude Code configuration (`readShared`), and whether an adapter module is still there (`hasAdapterModule`). */
interface DefaultRead {
  shared: SharedRead;
  adapterModule: boolean;
}

/** `DefaultRead` of the git repository at `path` as git steps. */
function* readingSettings(path: string): GitSteps<DefaultRead> {
  const { commit } = yield* readingDefaultBranch(path);
  const [adapterModule, shared] = yield* together(readingAdapterModule(commit), readingShared(commit));
  return { shared, adapterModule };
}

/** Reads a repository for `resolveCanvas`, the server waiting; null where `path` is no git repository (no directory, for a `folder`). */
export const readRepo = (path: string, folder = false): RepoRead | null => gitStepsSync(path, readingRepo(path, folder));

/** A folder without git as `resolveCanvas` reads it: no remote, no branch, its `.obeya/settings.json` as the folder has it. */
function readFolder(path: string): RepoRead | null {
  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  return { info: { path, remote: null, branch: '', folder: true }, detected: '', adapterModule: false, shared: readShared(path) };
}

/**
 * What a canvas's configuration amounts to, without touching anything: its repositories (home
 * first), each with Obeya's defaults and in front of them the repository's `.obeya/settings.json`
 * (`shared`: where they are read, by the repository's path; as `read` read them when left out) and
 * this machine's settings (`settings`: where a repository's are read; its entry's when left out),
 * each with its id and its settings without this machine's (`values`), and the canvas's id and
 * name. `read` reads each repository, by its absolute path (git, waiting for it, when left out).
 * Throws a ConfigError.
 */
export function resolveCanvas(
  config: CanvasConfig,
  store: Store,
  settings: (r: RepoConfig) => () => RepoSettings | undefined = (r) => () => r.settings,
  shared?: (path: string) => () => SharedSettings | undefined,
  read: (path: string, folder: boolean) => RepoRead | null = readRepo,
) {
  if (!config.repos.length) throw new ConfigError('noRepo', 'a canvas needs at least one repository');
  const reads = config.repos.map((r, i) => {
    // an empty path names nothing: resolved, it would be the server's own working directory
    if (!r.path.trim()) throw new ConfigError('noPath', 'a repository needs a path', i);
    const folder = r.git === false;
    const got = read(resolve(r.path), folder);
    if (!got) throw folder ? new ConfigError('noFolder', `${r.path} is no folder`, i) : new ConfigError('notRepo', `${r.path} is not a git repository`, i);
    return got;
  });
  // a repository runs once on a canvas: twice, it would have two of everything, its plan docs' note too
  reads.forEach(({ info }, i) => {
    if (reads.findIndex((x) => x.info.path === info.path) < i) throw new ConfigError('sameRepo', `${config.repos[i]!.path} is on the canvas already`, i);
  });
  const sharedOf =
    shared ??
    ((path: string) => {
      const settings = reads.find((x) => x.info.path === path)?.shared.settings;
      return () => settings;
    });
  let repos = config.repos.map((r, i) => ({ config: r, read: reads[i]!, adapter: repoAdapter(r, reads[i]!.info, settings(r), sharedOf(reads[i]!.info.path)) }));
  const refsOf = () => uniqueRefs(repos.map((x) => x.read.info), repos.map((x) => x.adapter));
  let refs = refsOf();
  const id = config.id ? slug(config.id) : config.name ? slug(config.name) : slug(repoName(reads[0]!.info));
  // the home repository is fixed when the canvas is first served: bare plan references, cards
  // without a repository and the home workspace directory are its, whatever the order later
  const stored = store.setting(id, 'home_repo');
  if (stored && stored !== refs[0]!.id) {
    const at = refs.findIndex((r) => r.id === stored);
    if (at < 0) throw new ConfigError('homeMissing', `canvas ${id}: its home repository "${stored}" is not configured; list it (first or anywhere)`);
    repos = [repos[at]!, ...repos.filter((_, i) => i !== at)];
    refs = refsOf();
  }
  const name = config.name ?? repoName(repos[0]!.read.info);
  return {
    config: { ...config, repos: repos.map((x) => x.config) },
    id,
    name,
    repos: repos.map((x, i) => ({ ...x, ref: refs[i]!, values: () => repoValues(x.read.info, namesClones(x.config, x.read.info, { land: x.adapter.land }), sharedOf(x.read.info.path)() ?? {}, x.read.detected) })),
    stored,
  };
}

/** What `resolveCanvas` resolved. */
type Resolved = ReturnType<typeof resolveCanvas>;

/**
 * How a canvas runs a repository: Obeya's defaults with the repository's `shared` settings and this
 * machine's `settings` in front, each read when it is asked for; its workers work in clones where
 * the configuration names some.
 */
export function repoAdapter(r: RepoConfig, info: RepoInfo, settings: () => RepoSettings | undefined, shared: () => SharedSettings | undefined): RepoAdapter {
  const layered = () => layerSettings<RepoSettings>(shared(), settings());
  return withSettings(defaultsFor(info), layered, namesClones(r, info, layered()));
}

/**
 * The existing clones a repository's configuration lists for its workers: all of them, but for the
 * checkout itself where work lands on its main, which is always on main (see `landOnMain`).
 */
export function listedClones(r: RepoConfig, info: RepoInfo, layered: RepoSettings | undefined): string[] {
  const landsHere = (layered?.land ?? defaultsFor(info).land) === 'main';
  return (r.workspaces ?? []).map((w) => resolve(w)).filter((w) => !landsHere || w !== resolve(info.path));
}

/** Whether a repository's configuration names clones for its workers (to create, existing ones, on other machines). */
export const namesClones = (r: RepoConfig, info: RepoInfo, layered: RepoSettings | undefined) => !!r.clones || !!listedClones(r, info, layered).length || !!r.hosts?.length;

/** Repository ids unique on the canvas: the repository's name, with a number when two share one. */
function uniqueRefs(infos: RepoInfo[], adapters: RepoAdapter[]): RepoRef[] {
  const seen = new Map<string, number>();
  return infos.map((info, i) => {
    const base = slug(repoName(info)) || `repo${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}${n}`,
      name: repoName(info),
      path: info.path,
      ...settled(info, adapters[i]!),
    };
  });
}

/** The URL of the repository's `origin` as it is configured, before git's `insteadOf` rewrites it; null without one. */
const originUrl = (info: RepoInfo): string | null => (info.remote ? (gitOrNull(info.path, 'config', '--get', 'remote.origin.url') ?? info.remote) : null);

/** Whether the repository's `origin` is on a server, as it is configured (git's `insteadOf` aside), rather than a directory on this machine. */
function onServer(info: RepoInfo): boolean {
  const url = originUrl(info);
  return !!url && (/^(https?|ssh|git):\/\//i.test(url) || /^[^/\\\s:]{2,}:/.test(url));
}

/** What a repository's ref says of its settings, which may change while the canvas runs: its main branch, how work lands. */
function settled(info: RepoInfo, adapter: RepoAdapter): Pick<RepoRef, 'branch' | 'pullRequests' | 'direct' | 'folder' | 'forge'> {
  if (info.folder) return { branch: '', folder: true };
  return {
    branch: info.branch,
    // an origin on a server (not a directory on this machine) may get pull requests of others
    ...(onServer(info) ? { forge: true } : {}),
    ...(adapter.land === 'pr' ? { pullRequests: true, ...(adapter.direct ? { direct: true } : {}) } : {}),
  };
}

/** Where a repository shares demos: the site its settings name, once it is complete; null without one. */
function siteOf(adapter: RepoAdapter): DemoSite | null {
  const site = adapter.demo?.site;
  return site && !siteIncomplete(site) ? site : null;
}

/** What the UI is told about sharing a repository's demos. */
const SHARE_FIELDS = ['share', 'shareNeeds', 'shareOnApproval', 'shareTags', 'shareOnPersonal', 'shareUnlisted', 'sharePersonal'] as const;
type ShareRef = Pick<RepoRef, (typeof SHARE_FIELDS)[number]>;

/**
 * What the canvas tells the UI about it: a site to share on here (its own, where this machine has
 * its credentials, else the owner's personal one, where the repository may go there), the env file
 * its site lacks on this machine, and why the personal site does not take it (none set up, or the
 * repository is private and not ticked).
 */
function shareRef(site: DemoSite | null, home: string, path: string, isPublic: boolean): ShareRef {
  const missing = site && siteMissing(home, site);
  if (site && !missing) {
    const tags = dimensions(site.tags).length ? { shareTags: Object.fromEntries(dimensions(site.tags)) } : {};
    return { share: true, ...(site.publish === 'approved' ? { shareOnApproval: true as const } : {}), ...tags };
  }
  const needs = site && missing ? { shareNeeds: { site: siteName(site), file: missing } } : {};
  const p = readPersonal(home);
  if (!p || siteMissing(home, personalDemoSite(p))) return { ...needs, sharePersonal: 'none' };
  if (!allowedHere(p, path, isPublic)) return { ...needs, sharePersonal: 'private' };
  // a repository whose site publishes each approved demo does so on the personal site too, as does one the owner ticked there for it
  const approved = site?.publish === 'approved' || approvedHere(p, path);
  return { share: true, shareOnPersonal: true, ...(p.secret ? { shareUnlisted: true as const } : {}), ...(approved ? { shareOnApproval: true as const } : {}) };
}

/** The canvas setting that keeps the forge's last answer on whether the repository at `path` is public. */
const visibilityKey = (path: string) => `visibility:${path}`;

/** Tells the UI about sharing on the repository what `share` says, in place of what it was told before. */
function setShare(ref: RepoRef, share: ShareRef) {
  for (const f of SHARE_FIELDS) delete ref[f];
  Object.assign(ref, share);
}

/** The restart of a repository's agents that waits, as its workers hear of it. */
const repoDue = (p: RepoRestart): DueRestart => ({ reason: p.reason, deadline: p.deadline, repo: true });

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const slug = (s: string) =>
  s
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-|-$/g, '');

/** A workspace as a directory on this machine, for a program that runs here (gh on a pull request's URL); none for one on another machine. */
const localDir = (workspace: string | null) => (workspace && !hostName(workspace) ? workspace : null);
