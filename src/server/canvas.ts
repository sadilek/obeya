// One canvas and everything that works on it: its repositories (each with adapter, workspaces,
// workers, project agents and PR watcher), the board, the Coordinator and the voice commands.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defaultsFor } from '../adapters';
import { Answers, answersDir, answerTag } from './answers';
import { type DefaultRead, keepCanvasId, keepRepoIds, listedClones, machineSettings, namesClones, originUrl, readRepos, readTreeOf, type RepoReads, type Resolved, resolveCanvas, setShare, SHARE_FIELDS, settled, shareRef, siteOf, upstreamOf, visibilityKey } from './canvas-config';
import type { Voicing } from './walkthrough';
import { demoDirectory, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { demoFile } from './demo-files';
import { openWithSystem } from './machine';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import type { CardDiff } from '../core/diff';
import type { Language } from '../core/locale';
import type { Awaited, CardAction, CardPatch, Item, PendingRestart, RepoRef, ProposedSetting, Skill, SpotInput } from '../core/types';
import { agentListens, awaited, awaitsContributorNext, untouched, finished, nameless, needsYou, pausable, halted, snoozable, laterTime, plannedToStart } from '../core/card';
import { AGENT_DEFAULTS, type AgentRole, type AgentSetting } from '../core/agents';
import { type CanvasConfig, layerSettings, type RepoConfig, repoShape, type RepoSettings, type SettingsShared, SHARED_FIELDS, type DemoSite } from '../core/config';
import { holdsNotes } from '../core/queue';
import { BadRequest, Board, TITLE_MAX, replyNote } from './board';
import { pathOfRef, repoOfRef } from './plan-ref';
import { DEMO_LOOK_MS } from './shared-pages';
import { fromJson, toJson, type StoredContribution } from './row';
import type { ChangeRoute } from '../core/types';
import { type Command, Commander, reaches } from './commands';
import type { Config } from './config';
import type { Store } from './db';
import { Explorers } from './explorers';
import { Files } from './files';
import { IdeaActions } from './idea-actions';
import { Images } from './images';
import { Learner } from './learner';
import { SettingsReads } from './settings-reads';
import { accountLogin, type ContributionInfo, type Forge, githubRepo, parsePrUrl, sameRepo, useGithubAccount } from './forge';
import { Coordinator } from './coordinator';
import { WorkRetro } from './work-retro';
import { PrWatcher } from './pr-watcher';
import { prepareReadTree, ReadTree } from './read-tree';
import { Revisions } from './revisions';
import { ProjectAgents } from './project-agents';
import { ghHosts, onGitHub, outsidePlanDir, planHistory, readPlanDocs, watchPlanDocs } from './repo';
import { boundsOf, GAP, type Place, planDirNoteBox, unionBounds } from '../core/layout';
import { type AgentRuntime, idleRuntime, withAgentSetting, withLimitWait, withRepoTrust, withSpend } from './runtime';
import { briefFull, type TagCard, tagCards } from './tag-proposal';
import { Skills } from './skills';

/** The skill lists of all canvases: several share a repository, and the user's skills are the same on each. */
const sharedSkills = new Skills();
import { OBEYA_PLUGIN } from './demo';
import { changesCode, RESTART_PATIENCE_MS, whenIdle } from './self-update';
import { Sharing } from './share';
import { dimensions } from '../core/page-tags';
import { type DueRestart, finishedRow, PLANNED_AGAIN, releaseHeld, Workers } from './workers';
import { type CardWorkspaces, type FileAt, type Landed, Workspaces } from './workspaces';
import { useBranchSetting } from './branches';
import { githubToken } from './git';
import { FolderWorkspaces } from './folder';
import { claudeToken, hostName, registerHost } from './hosts';
import { messageOf } from '../core/text';
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
  /** Propose the cards that set up a repository: its settings where it has none (`proposeSetup`), its pages' theme (`proposeTheme`); off in tests not about them. */
  setupProposals?: boolean;
  /** How long a voice command waits for undo. */
  commandDelayMs?: number;
  /** How long building or starting a card in a new repository waits for undo; UNDO_HOLD_MS when left out. */
  newRepoHoldMs?: number;
  /** The checkout this Obeya runs from, when it starts again for new code there (self-update.ts). */
  ownCheckout?: string | null;
  /** Obeya's configuration, which the Coordinator reads and changes on the owner's word. */
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
  /** The voice of looked-up answers told as walkthroughs, the server's one for every canvas; without it, answers come as text only. */
  voicing?: Voicing;
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
export class HomeDown extends Error {
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
  /** Its read tree: the default branch, where plan docs are read and the agents that only read work. */
  read: ReadTree;
  workspaces: CardWorkspaces;
  workers: Workers;
  projectAgents: ProjectAgents;
}

/** A repository as the canvas runs it, with what it was set up by and what stops what it set up. */
interface Repo extends RepoRuntime {
  /** Its entry in the configuration. */
  config: RepoConfig;
  /** Stops its read tree and the retries for clones on other machines. */
  stops: (() => void)[];
  /** Stops watching its plan docs. */
  docs?: () => void;
  /** Its plan docs as last read from its read tree: what the canvas shows while git moves the read tree. */
  planDocs?: ReturnType<typeof readPlanDocs>;
  /** Watches its pull requests, once its work went out as one; it stays for those still open. */
  prs?: PrWatcher;
  /** What the configuration's problems of the repository are read from on its default branch, as last seen (`problemSources`). */
  problemSources?: string;
  /** The resolved configuration it was set up by, its place there, and what was read of the workspaces it lists: what it starts again with where a new one fails. */
  from: { resolved: Resolved; index: number; listed: RepoReads['workspaces'] };
  /** Its settings read again (`moved`), the last of those under way. */
  moving?: Promise<unknown>;
  /** Settles once its read tree is in place and the clones it was to make are made (or failed). */
  ready: Promise<void>;
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
/** How many archived cards a proposal for a site's tags reads at a time, until its brief is full. */
const TAG_ARCHIVE_PAGE = 100;

/** What waits while a card's new repository is about to be made (`NewRepo.due`): every other way on. */
const DUE_REFUSES: CardAction['action'][] = ['start', 'force', 'build', 'planDoc', 'splitOff', 'prototype', 'snooze', 'startAt', 'accept'];

/** The owner's actions on a card that change only the board: they go also while its repository does not run on the canvas. */
const BOARD_ONLY: CardAction['action'][] = ['agent', 'name', 'dequeue', 'reorder', 'startAt', 'dismiss', 'keep', 'park', 'drop'];

/** The card's repository does not run on the canvas: nothing goes to its agents (`Item.repoDown`). */
const repoDown = (card: Pick<Item, 'repo'>) => new BadRequest('repoDown', `the repository ${card.repo} of the card does not run on this canvas`);

export class CanvasRuntime {
  readonly board: Board;
  readonly coordinator: Coordinator;
  /** The work retrospective: friction in the workers' runs, made into proposals. */
  readonly workRetro: WorkRetro;
  /** The learner and the retrospective: rules proposed from what the owner says and does. */
  readonly learner: Learner;
  readonly commander: Commander;
  readonly explorers: Explorers;
  /** Screenshots the owner attaches to what they write. */
  readonly images: Images;
  /** The other files the owner dropped into what they write, whose paths the agents get. */
  readonly files: Files;
  readonly answers: Answers;
  readonly revisions: Revisions;
  /** What the owner decides on proposals, ideas and their prototypes, and on a card's new repository. */
  private readonly ideas: IdeaActions;
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
  /** What it last read of its repositories' default branches: their settings for everyone, held commands, themes. */
  private readonly reads: SettingsReads;
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
  /** The owner paused the canvas's agents (kept across restarts, `paused` of its stored settings): cards the Coordinator lets start wait until they resume them. */
  private paused = false;
  private pendingListeners = new Set<() => void>();
  /** Set while the canvas leaves the configuration: called once its agents paused and it stopped. */
  private retiring: (() => void) | null = null;
  /** What the owner last said or typed to each card's agent, for the Coordinator to read beside a request the agent passes on. */
  private said = new Map<string, { text: string; spoken: boolean }>();
  /** Cards the owner is writing in, with their text before; a pause in typing hands it to the learner. */
  private writing = new Map<string, { before: string; timer: ReturnType<typeof setTimeout> }>();
  /**
   * The part of the canvas the owner last had in view in a page (its middle and its bounds): a new
   * card that comes without a place of its own (passed on by an agent, say) goes there.
   */
  inView: Place | undefined;

  /**
   * Starts a canvas: what it reads of its repositories with git (`readRepos`), and the read tree of
   * each where it is to be made or moved, without the server waiting for git meanwhile; then the
   * canvas, whose clones still to be made follow before this settles. Throws a ConfigError, or
   * `HomeDown`.
   */
  static async start(config: CanvasConfig, deps: CanvasDeps): Promise<CanvasRuntime> {
    const reads = await readRepos(config.repos, (r) => machineSettings(deps, r)()?.branch);
    const ahead = (() => {
      try {
        return resolveCanvas(config, deps.store, (r) => machineSettings(deps, r), undefined, (path) => reads.repos.get(path)?.read ?? null);
      } catch {
        // the canvas itself tells why
        return null;
      }
    })();
    if (ahead) await Promise.all(ahead.repos.map((x) => readTreeOf(deps.home, ahead.id, x)).map((l) => l && prepareReadTree(l.repoPath, l.dir)));
    const canvas = new CanvasRuntime(config, deps, reads);
    await Promise.all(canvas.repos.map((r) => r.ready));
    // its home repository's clones could not be made
    if (canvas.stopped) throw new HomeDown(canvas.id, canvas.failed.get(canvas.board.home)?.detail ?? 'its home repository did not start');
    return canvas;
  }

  constructor(config: CanvasConfig, private deps: CanvasDeps, reads: RepoReads) {
    const agents = deps.agents ?? ((role: AgentRole) => AGENT_DEFAULTS[role]);
    // the agents other than workers and Obeya's chat wait for the usage limit through it, each where it shows
    // and what each costs counts to the card it works for, else to the canvas
    const runtime = (r: AgentRuntime) =>
      withSpend(withLimitWait(withRepoTrust(withAgentSetting(r, agents), this.claudeHeld), deps.limitMargin), (card, session, usd) => this.board.spend(card, session, usd));
    const workerRuntime = deps.workerRuntime ?? (deps.idleWorkers ? idleRuntime : undefined);
    deps = { ...deps, runtime: runtime(deps.runtime), ...(workerRuntime ? { workerRuntime: runtime(workerRuntime) } : {}) };
    this.deps = deps;
    this.reads = new SettingsReads({
      store: deps.store,
      // the configuration as it runs may not have a repository new on the canvas yet; the file has it
      mine: (path) => (deps.settings ? deps.settings(path) : this.config?.repos.find((r) => resolve(r.path) === path)?.settings),
      takenOver: (path, before, now) => deps.config?.takenOver(path, before, now),
      themeRead: (path, changed) => {
        if (this.shutDown) return;
        if (changed) this.board.changed();
        const r = this.repos.find((x) => x.info.path === path);
        if (r) this.proposeTheme(r);
      },
    });
    this.skills = deps.skills ?? sharedSkills;
    // the main branch the owner set counts from the start: the repository's id, its settings and its read tree go by it
    for (const r of config.repos) this.useBranch(r);
    this.config = config;
    const resolved = this.resolve(config, reads);
    const { id, name, repos, stored, namedAfter } = resolved;
    this.config = resolved.config;
    const images = (this.images = new Images(join(deps.home, 'images', id)));
    this.files = new Files(join(deps.home, 'files', id));
    this.board = new Board(
      deps.store,
      { id, name, repos: [] },
      () => this.planDocs(),
      images,
      (repo, commit) => !!this.repo(repo)?.read.holds(commit, () => this.board.docsChanged()),
      deps.language,
      deps.conversation,
    );
    const board = this.board;
    if (!stored) deps.store.setSetting(id, 'home_repo', repos[0]!.ref.id);
    keepRepoIds(deps.store, id, repos.map((x) => x.ref));
    if (namedAfter) keepCanvasId(deps.store, id, namedAfter);
    if (deps.store.setting(id, 'paused') === '1') this.showPaused(true);

    this.workRetro = new WorkRetro({
      board,
      runtime: deps.runtime,
      pathFor: (repo) => (this.repo(repo) ?? this.repos[0]!).read.path,
      settingsFor: this.settingsNow,
      repoLanguage: (repo) => (this.repo(repo) ?? this.repos[0]!).adapter.language,
    });
    this.learner = new Learner({
      board,
      runtime: deps.runtime,
      home: () => this.repos[0]!.read.path,
      pathFor: (card) => this.repoOf(card).read.path,
    });
    board.showSettings(this.settingsNow);
    board.readPlanHistory((ref) => {
      const repo = this.repo(repoOfRef(ref, board.home));
      const path = pathOfRef(ref);
      // a plan folder outside the repository has no history in git
      return repo && !outsidePlanDir(path) ? planHistory(repo.read.path, path) : Promise.resolve([]);
    });
    // the Coordinator needs the workers, and the workers ask it: it is set right after them
    repos.forEach((x, i) => {
      try {
        this.addRepo(this.startRepo(resolved, i, reads.workspaces));
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
              !w.card ? w : this.coordinator?.evicting(w.card) ? { ...w, leaving: true as const } : r.workers.evictable(w.card) ? { ...w, takeable: true as const } : w,
            ),
          })),
        })),
    );
    for (const r of this.repos) r.workers.resumeAll();
    const coordinator = (this.coordinator = new Coordinator({
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
    coordinator.resume();
    // a card whose page closed before Obeya named it
    for (const i of board.items()) if (i.state === 'planned' && !i.queue && nameless(i)) void coordinator.name(i.id);
    this.explorers = new Explorers({
      board,
      runtime: deps.runtime,
      preferences: this.preferences,
      pathFor: (card) => this.repoOf(card).read.path,
      repoLanguage: (card) => this.repoOf(card).adapter.language,
      onOwnerInput: (card, text) => this.learner.learn(card, 'idea', text),
      imageFiles: this.imageFiles,
      onReplied: (cardId, replied) => this.ideas.replied(cardId, replied),
      toObeya: this.toObeya,
      ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
    });
    this.ideas = new IdeaActions({
      board,
      store: deps.store,
      explorers: this.explorers,
      coordinator,
      images,
      tell: (text) => this.commander.tell(text),
      repos: () => this.repos,
      repoOf: (card) => this.repoOf(card),
      ...(deps.canvases ? { canvases: deps.canvases } : {}),
      ...(deps.config ? { config: deps.config } : {}),
      ...(deps.newRepoHoldMs !== undefined ? { newRepoHoldMs: deps.newRepoHoldMs } : {}),
      forget: (cardId) => {
        clearTimeout(this.writing.get(cardId)?.timer);
        this.writing.delete(cardId);
        this.said.delete(cardId);
      },
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
      ...(deps.voicing ? { voicing: deps.voicing } : {}),
      onAnswer: (talk, question, answer) => {
        // looked up for an action: the Coordinator takes it now, hearing the answer with it
        if (this.commander.answerIn(talk)) return;
        // asked in a project's sheet, the question went to its project agent without Obeya reading it
        const sheet = board.sheet.exchange(talk)?.askedIn;
        const project = sheet ? board.item(sheet)?.title : undefined;
        this.commander.tell(
          project !== undefined
            ? `The owner asked the project agent of "${project}" in its sheet: “${question}”. Its answer ${answerTag(talk)} was shown to them there: ${answer}`
            : `The answer ${answerTag(talk)} you looked up for the owner's question “${question}” came in and was shown to them: ${answer}`,
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
      onOwnerInput: (card, kind, text, reply) => this.learner.learn((card && board.item(card)) || null, kind, text, { reply }),
      ...(deps.config ? { config: deps.config } : {}),
      canvases: () => (deps.canvases?.() ?? []).filter((c) => c !== this).map((c) => ({ id: c.id, name: c.board.canvas.name })),
      agentSetting: () => agents('coordinator'),
      ...(deps.commandDelayMs !== undefined ? { delayMs: deps.commandDelayMs } : {}),
      ...(deps.limitMargin !== undefined ? { limitMargin: deps.limitMargin } : {}),
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
      onRevised: (cardId, revised) => this.ideas.revised(cardId, revised),
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
        if (!r) return null;
        const path = r.info.path;
        return { site: r.site, repo: path, ...(r.isPublic ? { isPublic: true } : {}), theme: () => this.reads.themeOf(path) };
      },
      languageFor: (card) => (this.runs(card) ? this.repoOf(card).adapter.demo?.language : undefined),
      onPage: (cardId, r) => {
        const card = board.item(cardId);
        if (!card || !this.runs(card)) return;
        const repo = this.repoOf(card);
        repo.workers.pageSettled(cardId, r);
        if (r && 'url' in r) this.proposeTheme(repo);
      },
    });
    this.sharing.resume();
    // the pages without tags the Coordinator's sheet offers to tag, by each repository's site
    board.pages.showVocabulary((repo) => {
      const site = this.repo(repo)?.site;
      return site && dimensions(site.tags).length ? site.tags : undefined;
    });
    // the pages a repository's new theme leaves outdated
    board.pages.showThemes((repo) => {
      const r = this.repo(repo);
      if (!r) return undefined;
      const theme = this.reads.themeKnown(r.info.path);
      return theme === undefined ? undefined : (theme?.hash ?? null);
    });
    // snoozed cards wake at their time: one that passed while Obeya was not running, or the machine slept, at once
    this.wakeDue();
    this.waker = setInterval(() => this.wakeDue(), WAKE_EVERY_MS);
    this.waker.unref?.();
    // the owner deletes demos outside Obeya: the notice of outdated pages offers none whose files are gone
    this.demoLook = setInterval(() => void board.pages.lookAtDemos(), DEMO_LOOK_MS);
    this.demoLook.unref?.();
    // a card another waits on may pass through the state it waits for between two ticks (asked, and answered at once)
    const unwake = board.onChange(() => {
      if (this.wakeSoon) return;
      this.wakeSoon = setTimeout(() => {
        this.wakeSoon = undefined;
        this.wakeDue();
      }, 0);
    });
    const uncount = board.onChange(() => this.countAgents());
    // a project that has just taken its idea's place settles the idea's prototypes, as does one that stood before Obeya started
    const unsettle = board.onChange(() => this.ideas.settleLater());
    this.unwatch = () => {
      unwake();
      uncount();
      unsettle();
    };
    this.countAgents();
    this.ideas.settleLater();
  }

  /** Looks for snoozed cards whose time has come. */
  private waker: ReturnType<typeof setInterval>;
  /** Looks whether the demos of outdated pages are still on disk (`PageNotice.lookAtDemos`). */
  private demoLook: ReturnType<typeof setInterval>;
  /** A look for snoozed cards to wake after the board changed, and the subscription to its changes. */
  private wakeSoon: ReturnType<typeof setTimeout> | undefined;
  private unwatch: () => void;

  /** Wakes the snoozed cards whose time has come by `now`, and those whose card they wait on got there (or no longer can); so too the steps the Coordinator waits on cards for. */
  wakeDue(now = Date.now()) {
    const items = this.board.items();
    // and the Coordinator takes up the steps it waited on cards for
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

  /**
   * The owner sets a review card handed over aside until its contributor writes on the pull request
   * or pushes, counting from when it came to wait for them: what the contributor did since reaches
   * its worker, which reviews again (see the watcher). A time it was snoozed until stays as the latest.
   */
  private awaitContributor(cardId: string) {
    const card = this.board.item(cardId);
    if (!card?.contribution || !awaitsContributorNext(card)) throw new BadRequest('notSnoozable', 'only a review card handed over can wait for its contributor');
    const since = card.waitingSince ?? new Date().toISOString();
    this.board.snooze(cardId, { ...(card.snoozed ?? { by: 'owner', waiting: true }), contributor: { author: card.contribution.author, since } }, 'owner');
  }

  /** A time to snooze until or start at, as ISO: within the coming year. */
  private until(until: unknown): string {
    const at = typeof until === 'string' ? Date.parse(until) : NaN;
    if (laterTime(at) !== 'ok') throw new BadRequest('snoozeTime', 'until must be a time within the coming year');
    return new Date(at).toISOString();
  }

  /**
   * A snoozed card wakes: at its time (`timeUp`), as the card it waits on got there or no longer can
   * (`met`), or as the owner wakes it now. One that waited for the owner waits for them again; a
   * worker goes on; a planned one goes to the Coordinator as if started now.
   */
  private wake(cardId: string, timeUp: boolean, met?: Awaited) {
    const card = this.board.item(cardId);
    if (!card?.snoozed) throw new BadRequest('notSnoozed', 'the card is not snoozed');
    if (card.snoozed.waiting) return void this.board.unsnooze(cardId, timeUp ? 'time' : 'owner');
    if (card.snoozed.start) {
      this.repoOf(cardId).workers.startsNow(cardId, timeUp);
      // one to be started in a new repository makes it first
      if (card.newRepo) return this.ideas.intoNewRepo(cardId);
      return this.coordinator.request(cardId);
    }
    this.repoOf(cardId).workers.wake(cardId, timeUp, met);
  }

  get id() {
    return this.board.canvas.id;
  }

  private preferences = () => this.board.preferencesText();

  /** What an agent passes on to Obeya (`forward`). */
  private toObeya = (cardId: string, request: string) => this.forward(cardId, request);

  /** The settings of a repository the work retrospective may propose a value for, as they apply now. */
  private settingsNow = (repo: string): Record<ProposedSetting, string | string[]> | undefined => {
    const a = this.repo(repo)?.adapter;
    return a && { checks: a.checks ?? [], setup: a.setup ?? '', softPaths: a.softPaths, run: a.app?.run ?? '' };
  };

  private imageFiles = (ids: string[] = []) => ids.flatMap((i) => this.images.path(i) ?? []);

  /** The settings the owner set for a repository on this machine, read whenever they are used. */
  private settingsOf = (r: RepoConfig): (() => RepoSettings | undefined) => machineSettings(this.deps, r);

  /** Reads the repositories of `config` (`readRepos`), on the main branches the owner set. */
  private readRepos = (config: CanvasConfig) => readRepos(config.repos, (r) => this.settingsOf(r)()?.branch);

  /**
   * Whether an agent working in `cwd` works in a repository of the canvas (its checkout, its
   * read tree, a workspace of it; the most specific, since the home repository's workspaces hold
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
    return this.reads.claudeHeld(best.r.info.path, !!best.r.info.folder, this.settingsOf(best.r.config)());
  };

  /**
   * What a configuration of this canvas amounts to, with this machine's settings and the
   * repositories' (`resolveCanvas`): those of a repository new here as its read has them.
   */
  private resolve(config: CanvasConfig, reads: RepoReads) {
    return resolveCanvas(config, this.deps.store, this.settingsOf, this.reads.sharedOf, this.reads.took(reads));
  }

  /** Registers where the main branch the owner set for the repository is read, once per path. */
  private useBranch(r: RepoConfig) {
    const path = resolve(r.path);
    if (!this.branchSettings.has(path)) this.branchSettings.set(path, useBranchSetting(path, () => this.settingsOf(r)()?.branch));
  }

  /** The plan docs of all its repositories, each from its read tree: the home repository's by their bare path, the others' with the repository's id before it. */
  private planDocs() {
    const home = this.repos[0]?.ref.id;
    const read = this.repos.map((r) => {
      // while git is at work in the read tree (Obeya moving it, a pull or rebase in the checkout) its files are half the one
      // state and half the other, where a doc gone on main may be back for a moment: the docs read before stand until git is done
      if (!r.read.busy() || !r.planDocs) {
        const docs = readPlanDocs(r.read.path, r.adapter);
        // git began while they were read
        if (!r.planDocs || !r.read.busy()) r.planDocs = docs;
      }
      if (r.read.busy()) r.read.afterGit(() => this.board.docsChanged());
      return { r, ...r.planDocs };
    });
    return {
      docs: read.flatMap(({ r, docs }) => docs.map((d) => (r.ref.id === home ? d : { ...d, file: `${r.ref.id}:${d.file}` }))),
      dirs: read.map(({ r, others }) => ({ repo: r.ref.id, dir: r.adapter.planDocs.dir, others })),
    };
  }

  /**
   * Sets up the repository at `index` of a resolved configuration: its read tree, workspaces (clones
   * here and on other machines), project agents and workers. Its workers resume nothing yet.
   */
  private startRepo(resolved: Resolved, index: number, listed: RepoReads['workspaces']): Repo {
    const deps = this.deps;
    const board = this.board;
    const {
      config: rc,
      read: { info },
      adapter,
      ref,
    } = resolved.repos[index]!;
    const isHome = index === 0;
    for (const p of this.reads.sharedRead(info.path)?.problems ?? []) console.warn(`Obeya: ${info.path}: ${p} (ignored)`);
    const site = siteOf(adapter);
    // public as its forge said last time: workers resumed before it answers again get the tools of a repository that shares
    const isPublic = !info.folder && board.setting(visibilityKey(info.path)) === 'public';
    // whether the repository shares here, which the UI shows
    Object.assign(ref, shareRef(site, deps.home, info.path, isPublic));
    // until its set-up stops: what git finishes for it after that changes nothing
    let running = true;
    const stops: (() => void)[] = [() => (running = false)];
    // filled in below; what is set up here reaches it once it is
    const repo = { config: rc, stops, from: { resolved, index, listed }, ...(isPublic ? { isPublic } : {}) } as Repo;
    repo.problemSources = this.reads.problemSources(info.path, this.reads.adapterModule(info.path) ?? false);
    // where work lands on the local main, the checkout is the read tree; otherwise it is a pool clone on a card's branch
    const folder = !!info.folder;
    const read = new ReadTree({
      repoPath: info.path,
      dir: readTreeOf(deps.home, resolved.id, resolved.repos[index]!)?.dir ?? null,
      remote: !folder && !!info.remote,
      onChange: async () => {
        board.readTreeMoved(repo.ref.id, await read.head());
        if ((await this.moved(repo)) === 'follow') this.follow();
      },
    });
    stops.push(() => read.stop());
    // a read tree made afresh, or one that could not be made, is read from now on
    const readFrom = read.path;
    const placed = read.ready.then(() => {
      if (!running || read.path === readFrom) return;
      this.watch(repo);
      board.docsChanged();
    });
    const remoteHosts = !folder && info.remote && adapter.workspaces === 'clones' && adapter.land !== 'main' ? (rc.hosts ?? []) : [];
    // the GitHub account set for the repository on this machine: Obeya's gh calls on it, its agents' gh, and its clones on hosts work as that account
    const onGithub = !folder && rc.githubAccount && info.remote ? githubRepo(info.remote) : undefined;
    const githubLogin = onGithub && rc.githubAccount ? accountLogin(onGithub.host, rc.githubAccount) : undefined;
    if (onGithub && rc.githubAccount) stops.push(useGithubAccount(onGithub, rc.githubAccount));
    // the workers set up below say how many are busy where
    let workers!: Workers;
    let workspaces: CardWorkspaces;
    let cloned: Promise<void> = Promise.resolve();
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
          git.register(w, [info.remote, info.path].filter((x): x is string => !!x), listed.get(w));
          named.push(w);
        }
        // landing on main needs clones that see the local main; otherwise they track the remote; those still to be made follow in the background
        if (rc.clones) {
          named.push(...git.clonePaths(rc.clones));
          cloned = git.ensureClones(adapter.land === 'main' || !info.remote ? info.path : info.remote, rc.clones, () => running).then(
            () => board.changed(),
            (e) => void (running && this.clonesFailed(repo, e)),
          );
        }
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
      const token = githubLogin ?? githubToken(info.path, info.remote!);
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
      upstream: () => upstreamOf(info, adapter),
      otherBoards: () => (deps.canvases?.() ?? []).filter((c) => c !== this).map((c) => c.board),
      preferences: this.preferences,
      onOwnerInput: (card, kind, text, context) => this.learner.learn(card, kind, text, context),
      onPrOpened: (cardId) => {
        // a card whose own branch has its work go out as a pull request, where the repository's does not yet
        this.watchPrs(repo);
        // a fork's pull request to the original: the head it was opened with is looked at right away, before the worker pushes more onto it
        if (fromJson(board.row(cardId).pr)?.upstream) repo.prs?.soon(0);
        this.sharing.prOpened(cardId);
      },
      onApproval: (cardId) => this.sharing.approved(cardId),
      onLanded: (cardId) => void this.sharing.landed(cardId),
      onMerged: () => void read.refresh(),
      onFollowUpTask: (taskId, reviewId) => this.coordinator.followUp(taskId, reviewId),
      onPrototype: (prototype, summary, demo) => this.ideas.prototypeReady(prototype, summary, demo),
      onPrototypeAnswer: (prototype, question, answer) => this.ideas.prototypeAnswered(prototype, question, answer),
      // where work lands on the local main, the read tree is the checkout and moves with the landing;
      // a push leaves the checkout as it is: what it changes applies once the read tree fetches it
      restartsFor: async (l: Landed, pushedFrom?: string) => {
        if (pushedFrom) return false;
        if (deps.ownCheckout && sameDir(deps.ownCheckout, info.path) && (await changesCode(info.path, [l.from, l.to]))) return 'obeya';
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
      ...(workspaces instanceof Workspaces ? { pulls: workspaces } : {}),
      ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
      ...(deps.workerEnv ? { env: deps.workerEnv } : {}),
      ...(githubLogin ? { githubLogin } : {}),
      demoLanguage: () => readDemoSettings(deps.home).language,
      harness: () => (deps.agents ?? ((role: AgentRole) => AGENT_DEFAULTS[role]))('worker').harness,
      demoDirectory: () => demoDirectory(readDemoSettings(deps.home)),
      keptDemos: join(deps.home, 'kept-demos'),
      ...(deps.parkGrace !== undefined ? { parkGrace: deps.parkGrace } : {}),
    });
    Object.assign(repo, { ref, info, adapter, site, read, workspaces, workers, projectAgents, ready: Promise.all([placed, cloned]).then(() => {}) });
    void this.lookVisibility(repo);
    return repo;
  }

  /**
   * The clones a repository was to make could not be made: it does not run as the configuration has
   * it, as when its set-up fails as it starts. It leaves the canvas, its cards kept, with why shown at
   * it; "Try again" starts it again. Without its home repository the canvas stops.
   */
  private clonesFailed(r: Repo, e: unknown) {
    const at = this.repos.indexOf(r);
    if (this.shutDown || at < 0) return;
    console.error(`Obeya: ${r.info.path}: its clones cannot be made, left out of the canvas ${this.id}; its cards are kept: ${messageOf(e)}`);
    this.stopRepo(r);
    this.repos.splice(at, 1);
    this.showRepos();
    this.fail(r.ref.id, e);
    if (at === 0) this.homeDown(e);
    this.board.changed();
  }

  /** Its home repository does not run: the canvas stops, its cards kept, and is left out of those Obeya serves. */
  private homeDown(e: unknown) {
    this.stopped = true;
    this.shutdown();
    this.deps.stopped?.(this, messageOf(e));
  }

  /** The board lists the repositories that run, the home one first. */
  private showRepos() {
    this.board.canvas.repos.splice(0, this.board.canvas.repos.length, ...this.repos.map((r) => r.ref));
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
    this.proposeTheme(r);
  }

  /** Stops what the repository set up: its read tree, the watchers, its workers' sessions. Its cards stay. */
  private stopRepo(r: Repo) {
    for (const stop of r.stops) stop();
    r.docs?.();
    r.prs?.stop();
    r.workers.shutdown();
  }

  /**
   * Watches the plan docs of the repository in its read tree, afresh where they were watched (the
   * directory or the read tree moved), and its pull requests once its work goes out as one or a
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
   * work on, and their settings apply as they are read. What git reads of the repositories for it
   * it reads first, without the server waiting; configurations saved meanwhile apply one after the
   * other.
   */
  apply(next: CanvasConfig): Promise<void> {
    // back in the configuration before it left: it stays, and so do its repositories
    if (this.retiring) {
      this.retiring = null;
      this.cancelPending();
    }
    for (const r of next.repos) this.useBranch(r);
    const applied = this.applying.then(async () => {
      const reads = await this.readRepos(next);
      if (!this.shutDown) return this.applyRead(next, reads);
    });
    this.applying = applied.catch(() => {});
    return applied;
  }

  /** The configurations being applied (`apply`), one after the other. */
  private applying: Promise<void> = Promise.resolve();

  /** `apply`, with what was read of the repositories of `next`. */
  private applyRead(next: CanvasConfig, reads: RepoReads): Promise<void> | undefined {
    let resolved: Resolved;
    try {
      resolved = this.resolve(next, reads);
    } catch (e) {
      console.error(`Obeya: the new configuration of the canvas ${this.id} does not resolve; it runs on as it was: ${messageOf(e)}`);
      return;
    }
    keepRepoIds(this.deps.store, this.id, resolved.repos.map((x) => x.ref));
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
    const ready: Promise<void>[] = [];
    resolved.repos.forEach(({ read: { info } }, i) => {
      if (this.repos.some((r) => r.info.path === info.path) || this.pending?.paths.has(info.path)) return;
      let r: Repo;
      try {
        r = this.startRepo(resolved, i, reads.workspaces);
      } catch (e) {
        console.error(`Obeya: ${info.path} does not start, left out of the canvas ${this.id}: ${messageOf(e)}`);
        return this.fail(resolved.repos[i]!.ref.id, e);
      }
      this.addRepo(r);
      this.ran(r.ref.id);
      console.log(`Obeya: ${info.path} is on the canvas ${this.id} now`);
      if (this.obeyaDue) r.workers.restartDue(this.obeyaDue);
      r.workers.resumeAll(true);
      ready.push(r.ready);
    });
    // settles once the new ones' clones are made too
    return Promise.all([this.settingsChanged(), ...ready]).then(() => {});
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
        if (this.pending === pending) void this.restartRepos();
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
    this.undue(p);
    this.emitPending();
  }

  /** The restart of `p`'s repositories' agents does not happen: their workers hear that only one of all of Obeya may be due. */
  private undue(p: RepoRestart) {
    for (const r of this.repos) if (p.paths.has(r.info.path)) r.workers.restartDue(this.obeyaDue);
  }

  /**
   * Restarts the agents of the repositories the restart waited for: each one's set-up stops, and
   * starts again as the configuration has it now, its workers resuming where they paused; one that
   * left the canvas stays stopped, its cards kept. A canvas that left the configuration stops.
   */
  private async restartRepos(cut = false) {
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
    if (this.restarting) {
      // one restart at a time: this one is due again once the one under way is through, and waits
      // for the workers that one resumed to pause, unless the owner cuts them off
      await this.restarting;
      if (this.shutDown) return;
      this.due([...p.paths], p.reason);
      if (cut) void this.restartRepos(true);
      return;
    }
    const restarting = (this.restarting = this.restartAs(p).finally(() => {
      if (this.restarting === restarting) this.restarting = null;
    }));
    return restarting;
  }

  /** The restart of repositories' agents under way (`restartRepos`), until it is through. */
  private restarting: Promise<void> | null = null;

  /** `restartRepos` of the repositories `p` waited for. */
  private async restartAs(p: RepoRestart) {
    // git reads without the server waiting; a configuration applied meanwhile is read again
    let config: CanvasConfig;
    let reads: RepoReads;
    do reads = await this.readRepos((config = this.config));
    while (config !== this.config && !this.shutDown);
    if (this.shutDown) return;
    let resolved: Resolved;
    try {
      resolved = this.resolve(config, reads);
    } catch (e) {
      console.error(`Obeya: the configuration of the canvas ${this.id} does not resolve; its repositories run on as they were: ${messageOf(e)}`);
      this.undue(p);
      this.emitPending();
      return;
    }
    keepRepoIds(this.deps.store, this.id, resolved.repos.map((x) => x.ref));
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
        r = this.startRepo(resolved, i, reads.workspaces);
        this.ran(repo);
        console.log(`Obeya: restarted the agents of ${path}`);
      } catch (e) {
        // it starts again as it was set up before; where that fails too, it leaves the canvas, its cards kept
        console.error(`Obeya: the agents of ${path} do not start as the configuration has it now: ${messageOf(e)}`);
        try {
          if (was) {
            // its workspaces as git reads them now, where they are still listed
            r = this.startRepo(was.from.resolved, was.from.index, new Map([...was.from.listed, ...reads.workspaces]));
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
      console.error(`Obeya: the home repository of the canvas ${this.id} does not start; the canvas stopped, its cards are kept`);
      this.emitPending();
      this.homeDown(homeDown);
      return;
    }
    this.showRepos();
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
   * Coordinator lets start wait in the queue. With none at work, nothing changes.
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
    void this.restartRepos(true);
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
   * The read tree of the repository moved, or its settings were saved: reads its
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
    const known = r.moving ? undefined : this.reads.readNow(path);
    if (known) return this.movedTo(r, known);
    const now = (r.moving ?? Promise.resolve()).then(async () => this.movedTo(r, await this.reads.readSettings(path)));
    const moving: Promise<void> = (r.moving = now.then(
      () => {},
      () => {},
    ));
    void moving.then(() => r.moving === moving && delete r.moving);
    return now;
  }

  /** `moved`, with what was read of the repository on its default branch. */
  private movedTo(r: Repo, read: DefaultRead): Moved {
    const path = r.info.path;
    if (this.shutDown || !this.repos.includes(r)) return 'same';
    if (this.pending?.paths.has(path)) return 'due';
    // what the canvas follows (`follow`) goes by it
    r.info.branch = read.branch;
    const shared = this.reads.reread(path, read.shared);
    // a new theme leaves pages outdated; one read with the settings the server waited for is read now without waiting
    if (read.theme !== undefined) this.reads.setTheme(path, read.theme);
    else this.reads.readThemeOf(path, read.shared.obeyaTree);
    const held = this.reads.heldAgain(path);
    const sources = this.reads.problemSources(path, read.adapterModule);
    const problems = sources !== r.problemSources;
    if (problems) {
      // the page reads the configuration's problems again
      r.problemSources = sources;
      r.ref.configRev = (r.ref.configRev ?? 0) + 1;
      // the settings may be there now, or gone
      this.proposeSetup(r);
    }
    const layered = layerSettings<RepoSettings>(this.reads.sharedOf(path)(), this.settingsOf(r.config)());
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
   * What the canvas set up by the repositories' settings follows them: the read tree where work
   * now lands elsewhere, the watched plan directory, the pull requests, what the page shows of
   * each repository (its main branch as last read, `movedTo`).
   */
  private follow() {
    for (const r of this.repos) {
      for (const k of ['pullRequests', 'direct', 'forge', 'upstream'] as const) delete r.ref[k];
      Object.assign(r.ref, settled(r.info, r.adapter));
      // where work lands on the local main, the checkout is the read tree; otherwise a worktree on the default branch
      r.read.retarget(r.info.folder || r.adapter.land === 'main' ? null : join(this.deps.home, 'read', this.id, r.ref.id));
      this.watch(r);
    }
    this.board.docsChanged();
  }

  /** The canvas's repository of that id, where it runs here. */
  private repo(id: string | undefined): Repo | undefined {
    return this.repos.find((r) => r.ref.id === id);
  }

  /**
   * The repository a card belongs to. One that does not run on the canvas (it left the
   * configuration, or did not start) has no agents to take the card: it waits for it, rather than
   * going to another repository's.
   */
  repoOf(card: Pick<Item, 'repo'> | string): RepoRuntime {
    const item = typeof card === 'string' ? this.board.item(card) : card;
    if (!item) throw new BadRequest('unknownCard', 'unknown card');
    const r = this.repo(item.repo);
    if (!r) throw repoDown(item);
    return r;
  }

  /**
   * What a proposal for the tags of the site of the repository at `path` reads on this canvas,
   * where it runs here: its checkout, the agents' runtime, the language of its demos, and its cards
   * (`tagCards`), those on the canvas first, then the archive as far back as the brief has room for.
   */
  tagSource(path: string): { cwd: string; runtime: AgentRuntime; language?: Language; cards: TagCard[] } | null {
    const r = this.repos.find((x) => resolve(x.info.path) === resolve(path));
    if (!r) return null;
    const mine = (i: Item) => i.repo === r.ref.id;
    const summary = (id: string) => {
      try {
        return this.board.summary(id);
      } catch {
        return undefined;
      }
    };
    // the archive a page at a time, only as far back as the brief has room for
    const cards = tagCards(this.board.items().filter(mine), summary);
    for (let after: string | undefined, first = true; (first || after) && !briefFull(cards); first = false) {
      const page = this.board.archived.page(TAG_ARCHIVE_PAGE, after);
      cards.push(...tagCards(page.items.filter(mine), summary));
      after = page.next;
    }
    return {
      cwd: r.info.path,
      runtime: this.deps.runtime,
      ...(r.adapter.demo?.language ? { language: r.adapter.demo.language } : {}),
      cards,
    };
  }

  /** Whether the card's repository runs on the canvas. */
  private runs(card: Pick<Item, 'repo'> | string): boolean {
    const item = typeof card === 'string' ? this.board.card(card) : card;
    return !!item && !!this.repo(item.repo);
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
      void this.coordinator.name(cardId);
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
    if (card && text && text !== before) this.learner.learn(card, 'card', text, before ? { before } : {});
  }

  /** The owner accepts a rule proposal, maybe in their words or for another place (a repository's CLAUDE.md, or none). */
  acceptRule(id: number, text?: string, target?: string | null) {
    this.board.acceptProposal(id, text, target);
    this.fileRules();
  }

  /**
   * A rule the owner gives outright, by „Merk dir: …“ or in the sheet: one of theirs, active at once,
   * or with `repos` one for those repositories' CLAUDE.md, which goes straight into their cards
   * "Add to CLAUDE.md". `replaces`: the active rule it changes; `card`: the card open when it was said.
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
   * The owner takes a setting the work retrospective proposed, as it is or with their `value`: on
   * this machine, or into the repository's `.obeya/settings.json` for everyone (`Config.takeSetting`).
   */
  async takeSetting(id: number, where: unknown, value?: unknown): Promise<SettingsShared | null> {
    if (where !== 'machine' && where !== 'repository') throw new BadRequest('invalid', 'where is machine or repository');
    const p = this.board.settingProposal(id);
    const v = value === undefined ? p.value : typeof p.value === 'string' ? (typeof value === 'string' && value.trim() ? value.trim() : null) : Array.isArray(value) ? value.map(String).map((x) => x.trim()).filter(Boolean) : null;
    if (v === null || (Array.isArray(v) && !v.length)) throw new BadRequest('invalid', 'the value is missing');
    const r = this.repo(p.repo);
    if (!r || !this.deps.config) throw new BadRequest('invalid', 'no configuration to set it in');
    const done = await this.deps.config.takeSetting(resolve(r.config.path), p.field, v, where);
    this.board.decideSetting(id, where, v);
    const m = this.board.t.retro;
    const name = this.board.t.labels.settings[p.field];
    this.board.notify({ text: !done ? m.onMachine(name, r.ref.name) : 'pr' in done ? m.opened(name, r.ref.name, done.pr) : m.committed(name, r.ref.name, done.branch) });
    return done;
  }

  rejectSetting(id: number) {
    this.board.decideSetting(id, 'rejected');
  }

  /**
   * Once no proposal waits any more, the cards "Add to CLAUDE.md" start, with all the rules
   * accepted for them: a waiting proposal might yet become one of theirs.
   */
  private fileRules() {
    if (this.board.preferences('proposed').length) return;
    for (const r of this.board.canvas.repos) {
      const card = this.board.collecting(r.id);
      if (card) this.coordinator.request(card.id);
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
    // the agent passes a request on in its words; the Coordinator reads the owner's own beside them
    this.said.set(cardId, { text, spoken });
    if (card.kind === 'question') return this.act(cardId, { action: 'ask', ...said });
    if (card.state === 'idea') return this.act(cardId, { action: 'discuss', ...said });
    if (card.state === 'proposal') {
      this.learner.learn(card, 'note', text.trim());
      return this.act(cardId, { action: 'revise', ...said }, true);
    }
    if (card.state === 'waiting' && card.need === 'question') return this.act(cardId, { action: 'answer', ...said, ...(spot ? { spot } : {}) });
    return this.act(cardId, { action: 'message', ...said, ...(spot ? { spot } : {}) });
  }

  /**
   * A request a card's agent passes on from the owner's words (`to_obeya`): the Coordinator reads it
   * with those words and the card in focus, as a command, and its confirmation (or reply, or that it
   * looks the question up) is the agent's answer. Actions wait for "Undo" as usual; the owner
   * sees the confirmation above the microphone and in the card's conversation.
   */
  async forward(cardId: string, request: string): Promise<string> {
    // the owner's words go beside the request, also those before a restart; an agent that passes on
    // what nobody said (words in a file it read, say) has nothing to pass on
    const before = this.said.has(cardId) ? undefined : this.board.events(cardId).findLast((e) => e.author === 'owner' && e.kind !== 'state' && e.text.trim());
    // a step Obeya waits to take on this card itself, which its agent read in its task
    const steps = this.commander.waitsOn(cardId);
    // without them, the card's task once the owner gave it (typed it, the Coordinator wrote it from
    // their words, or they accepted an agent's proposal), not while it is a proposal; a step of the
    // task Obeya waits to take is Obeya's
    const card = this.board.item(cardId);
    const task = !steps.length && card && card.state !== 'proposal' && (card.body.trim() || card.title.trim());
    const said = this.said.get(cardId) ?? (before ? { text: before.text, spoken: false } : task ? { text: task, spoken: false, task: true } : undefined);
    const later = steps.length ? ` Obeya itself takes these steps once your card ${steps.map((w) => `${reaches(w.state)}: ${w.then.replace(/[.\s]+$/, '')}`).join('; ')}. If you asked for one of them, it is not missing: leave it to Obeya.` : '';
    if (!said) return `Nothing passed on: the owner has said nothing on your card. to_obeya passes on the owner's own words.${later}`;
    const h = await this.commander.forward(cardId, request, said);
    this.commander.announce(h, cardId);
    // the agent learns what the owner finds under the answer
    if (h.wish) return `${h.confirm} (A draft for Obeya's makers opened for the owner to check and send on GitHub.)`;
    if (h.cannot) return `${h.confirm} (Obeya lacks this; under this answer the owner finds a link to send it to Obeya's makers as a wish.)`;
    return h.confirm;
  }

  /** The issue a small job writes from the owner's words, for Obeya's makers; `footer` ends its body. */
  writeWish(w: WishInput, footer: string, images: string[] = []): Promise<WishDraft> {
    return writeWish(this.deps.runtime, w, footer, this.imageFiles(images));
  }

  /** A script acts as the card's agent, in a scratch Obeya whose workers are idle (`Workers.standIn`). */
  standIn(cardId: string, act: Parameters<Workers['standIn']>[1]) {
    if (!this.deps.idleWorkers) throw new BadRequest('invalid', 'only an Obeya with idle workers (--idle-workers) lets a script stand in for an agent');
    return this.repoOf(cardId).workers.standIn(cardId, act);
  }

  /** The owner clicks in the card's panel: a click without words the learner reads counts towards the retrospective. */
  press(cardId: string, a: CardAction) {
    // the options picked on a proposal go to its reviser without the Coordinator, which would have logged them
    const r = this.act(cardId, a, true);
    // the end of watching a demo is no click of the owner's
    if (a.action !== 'release' && a.action !== 'unsay' && a.action !== 'name' && !(['message', 'answer', 'discuss'].includes(a.action) && 'text' in a && a.text?.trim())) this.learner.noticed();
    return r;
  }

  /** What the owner decided for a review card's findings, as the browser sent it: by finding number, to the contributor, the worker's own change, a follow-up task or not pursued. */
  private decisions(findings: unknown): Record<number, ChangeRoute> | undefined {
    if (findings === undefined || findings === null) return undefined;
    if (typeof findings !== 'object') throw new BadRequest('invalid', 'findings must map finding numbers to contributor, self, later or drop');
    const out: Record<number, ChangeRoute> = {};
    for (const [id, route] of Object.entries(findings as Record<string, unknown>)) {
      if (!/^\d+$/.test(id) || !['contributor', 'self', 'later', 'drop'].includes(route as string)) throw new BadRequest('invalid', 'findings must map finding numbers to contributor, self, later or drop');
      out[Number(id)] = route as ChangeRoute;
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
    if (card?.repoDown && !BOARD_ONLY.includes(a.action) && a.action !== 'stop') throw repoDown(card);
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
        if (card?.newRepo) return this.ideas.intoNewRepo(cardId);
        // one snoozed to start later starts now
        if (card?.snoozed?.start) return this.wake(cardId, false);
        return this.coordinator.request(cardId);
      case 'stayHere':
        return this.ideas.stayHere(cardId);
      case 'name':
        return void this.coordinator.name(cardId);
      case 'force':
        return this.coordinator.force(cardId);
      case 'agent':
        return this.board.chooseAgent(cardId, a.agent);
      case 'dequeue':
        return this.coordinator.dequeue(cardId);
      case 'takeWorkspace':
        return this.coordinator.evict(cardId);
      case 'keepWorkspace':
        return this.coordinator.keep(cardId);
      case 'arrange':
        return this.coordinator.arrange(cardId);
      case 'reorder':
        return this.coordinator.reorder(cardId, !!a.earlier, a.places ?? 1);
      case 'stop':
        return card?.repoDown ? this.stopWithoutRepo(card) : this.repoOf(cardId).workers.stop(cardId);
      case 'pause':
        return a.safePoint ? this.agentOf(cardId).pauseAtSafePoint(cardId) : this.agentOf(cardId).pause(cardId);
      case 'resume':
        return this.agentOf(cardId).resume(cardId);
      case 'snooze':
        return this.snooze(cardId, a.until);
      case 'awaitContributor':
        return this.awaitContributor(cardId);
      case 'wake':
        return this.wake(cardId, false);
      case 'startAt':
        return this.board.startAt(cardId, a.at === null ? null : this.until(a.at));
      case 'message':
        // a note to a Question card is a question to its agent
        if (card?.kind === 'question') return this.answers.ask(cardId, text.trim(), { images, spoken: !!a.spoken, replyTo });
        return this.repoOf(cardId).workers.message(cardId, text.trim(), images, !!a.spoken, replyTo, this.spot(a.spot), this.decisions(a.findings));
      case 'release':
        return this.repoOf(cardId).workers.released(cardId, !!a.now);
      case 'unsay':
        // words the card's agent has not read yet, whichever agent it is
        return (card?.state === 'proposal' ? this.revisions : this.agentOf(cardId)).unsay(cardId, a.id);
      case 'answer':
        return this.repoOf(cardId).workers.answer(cardId, text.trim(), images, !!a.spoken, replyTo, picks, this.spot(a.spot));
      case 'approve':
        return this.repoOf(cardId).workers.approve(cardId, { direct: !!a.direct, findings: this.decisions(a.findings), ...(typeof a.upstream === 'boolean' ? { upstream: a.upstream } : {}) });
      case 'undo':
        return this.repoOf(cardId).workers.undo(cardId);
      case 'pushMain':
        return this.repoOf(cardId).workers.pushMainFor(cardId);
      case 'keepMain':
        return this.repoOf(cardId).workers.keepMainFor(cardId);
      case 'revoke':
        return this.repoOf(cardId).workers.revoke(cardId);
      case 'keepApproval':
        return this.repoOf(cardId).workers.keepApproval(cardId);
      case 'pushChanges':
        return this.repoOf(cardId).workers.pushContribution(cardId);
      case 'editHeld':
        return this.repoOf(cardId).workers.editHeld(cardId, a.body);
      case 'accept':
        return this.ideas.accept(cardId, a.picks, a.start !== false, a.idea);
      case 'unaccept':
        return this.ideas.unaccept(cardId);
      case 'dismiss':
        // a card its agent withdrew or replaced goes like a deleted one, its worker stopped
        if (card?.superseded) return this.remove(cardId);
        if (this.board.row(cardId).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return this.board.remove(cardId);
      case 'keep':
        return this.board.keep(cardId);
      case 'revise': {
        // said while it is reworked, they wait for the next rework, unread until then
        const later = !!card?.proposal?.revising;
        const said = log ? this.board.log(cardId, 'say', 'owner', text.trim(), { images, replyTo, unread: later }).id : undefined;
        return this.revisions.revise(cardId, `${replyNote(this.board.quoted(cardId, replyTo), 'coordinator')}${text.trim()}`, !!a.spoken, said, images);
      }
      case 'discuss':
        return this.explorers.discuss(cardId, text.trim(), !!a.spoken, images, replyTo);
      case 'build':
        return this.ideas.build(cardId);
      case 'unbuild':
        return this.ideas.unbuild(cardId);
      case 'splitOff':
        return this.ideas.splitOff(cardId);
      case 'planDoc':
        return this.ideas.planDoc(cardId);
      case 'park':
      case 'drop':
        return this.ideas.shelve(cardId, a.action);
      case 'prototype':
        if (a.variants !== undefined && (!Array.isArray(a.variants) || a.variants.length > 20 || a.variants.some((v) => typeof v !== 'string')))
          throw new BadRequest('invalid', 'variants must be a list of the planned approaches');
        return this.ideas.prototype(cardId, text.trim(), a.variants);
      case 'buildPrototype':
        return this.ideas.buildOnPrototype(cardId);
      case 'discard':
        return this.ideas.discard(cardId);
      case 'ask':
        return this.answers.ask(cardId, text.trim(), { images, spoken: !!a.spoken, replyTo });
      case 'consult': {
        // the agent passes a request on in its words; the Coordinator reads the owner's own beside them
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
    if (!Number.isInteger(thread) || !this.board.sheet.thread(thread).length) throw new BadRequest('invalid', 'unknown thread');
    return answersDir(this.deps.home, this.id, thread);
  }

  /** "Show in folder", or a click on an answer's file: opened with the system's app on this machine. */
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

  /** "Open on the computer" on a file of the card's work, or with `show` "Show in folder": with the system's app on this machine. */
  async openCardFile(cardId: string, path: string, show: boolean) {
    const file = await this.cardFile(cardId, path, true);
    if (!file || !('path' in file)) throw new BadRequest('noFile', 'the file is not on this machine');
    if (!(await openWithSystem(file.path, true, show))) throw new BadRequest('invalid', 'the system has no app to open it with');
  }

  /**
   * "Discuss as an idea" on a Question card: it becomes an idea, whose exploration agent starts from
   * the thread (questions, answers, the files in its output directory) instead of the look-up's session.
   */
  private questionAsIdea(cardId: string) {
    const card = this.board.item(cardId);
    if (card?.kind !== 'question') throw new BadRequest('notQuestion', 'the card is no Question card');
    if (card.thread?.thinking) throw new BadRequest('ideaThinking', 'its agent is still reading; discuss it as an idea once the answer is there');
    if (!this.runs(card)) throw repoDown(card);
    // a paused agent's question goes into the discussion with the rest of the thread
    this.board.work(cardId, { kind: 'task', state: 'idea', idea: toJson({ status: 'open', brief: '' }), session_id: null, paused: null, pausing: null });
    this.board.log(cardId, 'state', 'owner', this.board.t.answer.asIdea);
    this.explorers.tell(cardId, this.answers.opening(cardId));
  }

  /** Deletes a card of the owner's, stopping its worker first; a prototype is discarded into the archive instead. */
  remove(cardId: string) {
    clearTimeout(this.writing.get(cardId)?.timer);
    this.writing.delete(cardId);
    this.ideas.keepHere(cardId);
    const { state, landed, workspace, prototype_of } = this.board.row(cardId);
    if (prototype_of) return this.repoOf(cardId).workers.endPrototype(cardId, 'discarded');
    if ((state === 'working' || state === 'waiting' || (landed && workspace)) && this.runs(cardId)) void this.repoOf(cardId).workers.stop(cardId);
    if (state === 'idea') this.explorers.close(cardId);
    // work thrown away ended too (finished work counted when it landed); the retrospective reads in its repository
    else if ((!state || !finished(state)) && this.runs(cardId)) this.workRetro.ended(cardId, workspace);
    this.board.remove(cardId);
  }

  /**
   * "Stop" on a card whose repository does not run on the canvas (removed from the configuration,
   * moved, or failed to start): no agent of it can be reached, so only the board changes, as
   * `Workers.stop` and `Workers.finish` change it. The card is planned again (stopped), to be started
   * again, archived or deleted; one that finished after landing is done. Its workspace stays recorded,
   * for the repository's return, which frees it where its card no longer needs it (`Workers.settleLeases`).
   */
  private stopWithoutRepo(card: Item) {
    const t = this.board.t.worker;
    if (card.finishing) {
      this.board.log(card.id, 'state', 'owner', t.stopped);
      this.board.work(card.id, finishedRow(this.board.row(card.id)));
      return this.board.workDone(card.id);
    }
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('noAgent', 'no agent works on this card');
    // comments held back for the worker stay in the conversation
    releaseHeld(this.board, card.id);
    this.board.work(card.id, PLANNED_AGAIN);
    this.board.log(card.id, 'state', 'owner', card.pr ? t.stoppedPrOpen(card.pr.number) : t.stopped);
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
    const r = this.repo(repo);
    if (!r) throw new BadRequest('invalid', 'unknown repository');
    const open = this.board.openSetupCard(repo, r.ref.name);
    if (open?.state === 'proposal') this.ideas.accept(open.id, [], false);
    return open ? this.board.card(open.id)! : this.board.setupCard(repo, r.ref.name);
  }

  /**
   * Obeya proposes the card that fills in a repository's settings where it knows them not (nothing
   * of the repository's own in `.obeya/settings.json`, or an adapter module left on its main branch),
   * as the Configuration dialog offers it; a folder without git is left alone.
   */
  private proposeSetup(r: Repo) {
    if (!this.deps.setupProposals || r.info.folder) return;
    const settings = this.reads.sharedRead(r.info.path)?.settings ?? {};
    const own = SHARED_FIELDS.some((k) => settings[k] !== undefined);
    this.board.proposeSetup(r.ref.id, r.ref.name, !own || !!this.reads.adapterModule(r.info.path));
  }

  /**
   * Obeya proposes the card that gives a repository's shared pages a theme once a page of it is
   * online and its default branch has no `.obeya/theme.css`; it waits for the theme to be read.
   */
  private proposeTheme(r: RepoRuntime) {
    if (!this.deps.setupProposals) return;
    const theme = this.reads.themeKnown(r.info.path);
    if (theme === undefined) return;
    this.board.proposeTheme(r.ref.id, r.ref.name, { themed: theme !== null, shares: this.board.sharesPages(r.ref.id) });
  }

  /**
   * "Commit to a new branch and free the clone" in the Workspaces list: what is uncommitted in a
   * free clone of the repository (`path` there, on the machine the pool names `host`) goes into a
   * branch of its own, and the clone is free for the cards. Settles with that branch, '' where
   * nothing needed keeping.
   */
  async keepLeftovers(repo: string, host: string, path: string): Promise<{ branch: string }> {
    const r = this.repos.find((x) => x.ref.id === repo);
    const branch = r ? await r.workspaces.keepLeftovers(path, host) : null;
    if (branch === null) throw new BadRequest('notFreed', 'the clone is not a free one, holds what cannot be kept, or git failed there');
    return { branch };
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
    this.coordinator.request(card.id);
    return this.board.card(card.id)!;
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

  /** A card the Coordinator of another canvas makes here for the owner, following up on a card of its own. */
  followUp(c: Extract<Command, { do: 'newCard' }>, from: string): string {
    return this.created(this.board.create({ title: c.title, body: c.body, ...(c.images?.length ? { images: c.images } : {}), ...this.board.freeSpot(this.inView) }, from).id, c);
  }

  /**
   * A card the owner's command made: one for later waits until then, a time that passed in the undo
   * window starting it now; one to start goes to the Coordinator. Its id.
   */
  private created(cardId: string, c: Pick<Extract<Command, { do: 'newCard' }>, 'until' | 'start'>): string {
    this.board.log(cardId, 'state', 'owner', this.board.t.voice.created);
    if (c.until && Date.parse(c.until) > Date.now()) this.snooze(cardId, c.until);
    else if (c.start || c.until) this.coordinator.request(cardId);
    return cardId;
  }

  /** A voice (or typed) command, once its undo window has passed; a new card's id, for a wait on it in the same command. */
  run(c: Command) {
    switch (c.do) {
      case 'newCard': {
        if (c.canvas && c.canvas !== this.id) return this.elsewhere(c);
        const at = c.from ? { from: c.from } : this.board.freeSpot(c.place ?? this.inView);
        const card = this.board.create({
          title: c.title,
          body: c.body,
          ...(c.repo ? { repo: c.repo } : {}),
          ...(c.images?.length ? { images: c.images } : {}),
          ...at,
        });
        return this.created(card.id, c);
      }
      case 'newIdea': {
        if (c.canvas && c.canvas !== this.id) return this.elsewhere(c);
        const card = this.board.create({ idea: true, title: c.title, body: c.body, ...(c.repo ? { repo: c.repo } : {}), ...this.board.freeSpot(c.place ?? this.inView) });
        this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
        // the agent opens the discussion with what the owner said
        this.explorers.discuss(card.id, c.body.trim() || c.title, true, this.images.resolve(c.images));
        return;
      }
      case 'newRepo': {
        const card = this.board.item(c.card);
        if (!card) throw new BadRequest('unknownCard', 'unknown card');
        this.board.setNewRepo(c.card, { path: c.path, canvas: c.canvas, by: 'owner' });
        return this.act(c.card, { action: card.state === 'idea' ? 'build' : 'start' });
      }
      case 'reviewPr':
        return this.reviewPr(c);
      case 'discuss':
      case 'note':
      case 'feedback':
      case 'answer':
      case 'revise':
        return this.act(c.card, { action: c.do === 'note' || c.do === 'feedback' ? 'message' : c.do, text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'prototype':
        return this.act(c.card, { action: 'prototype', text: c.text });
      case 'accept':
        return this.act(c.card, { action: 'accept', ...(c.idea ? { idea: true } : {}) });
      case 'snooze':
        return this.act(c.card, { action: 'snooze', until: c.until });
      case 'start':
      case 'force':
      case 'buildPrototype':
      case 'discard':
      case 'build':
      case 'splitOff':
      case 'planDoc':
      case 'park':
      case 'drop':
      case 'approve':
      case 'dismiss':
      case 'keep':
      case 'dequeue':
      case 'stop':
      case 'pause':
      case 'resume':
      case 'wake':
      case 'awaitContributor':
        // screenshots said with the start belong to the task, so the worker gets them with it
        if ((c.do === 'start' || c.do === 'force') && c.images?.length) this.ideas.addTaskImages(c.card, c.images);
        return this.act(c.card, { action: c.do });
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

  /** A planned task nobody has worked on yet, still as when the Coordinator chose it; else why not. */
  private untouched(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (!untouched(card)) throw new BadRequest('notUntouched', `"${card.title}" is no planned task nobody has worked on any more`);
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
   * "Review PR #5": a review card for the pull request someone outside opened, started at once, the
   * owner's words with it as its task. A PR that has a card on the canvas already opens that one, and
   * the words go to its worker. What goes wrong (no such PR, one closed) the owner hears.
   */
  async reviewPr(c: Extract<Command, { do: 'reviewPr' }>): Promise<string | undefined> {
    const repo = c.repo ? this.repo(c.repo) : this.repos[0];
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
    const card = this.board.create({ title: `PR #${ref.number}: ${info.title}`.slice(0, TITLE_MAX), body: c.text, repo: repo.ref.id, ...this.board.freeSpot(c.place ?? this.inView) });
    const stored: StoredContribution = {
      url,
      number: ref.number,
      author: info.author,
      title: info.title,
      canModify: info.canModify,
      ...(info.headRepo ? { headRepo: info.headRepo } : {}),
      ...(info.headRef ? { headRef: info.headRef } : {}),
    };
    this.board.work(card.id, { contribution: toJson(stored) });
    this.board.log(card.id, 'state', 'owner', t.voice.created);
    this.watchPrs(repo);
    this.coordinator.request(card.id);
    // the card opens, so the owner sees its review begin
    this.board.notify({ text: t.review.started(ref.number, info.author), cardId: card.id, open: true });
    return card.id;
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
    clearInterval(this.demoLook);
    clearTimeout(this.wakeSoon);
    this.ideas.shutdown();
    this.unwatch();
    this.pending?.stop();
    this.pending = null;
    for (const [, w] of this.writing) clearTimeout(w.timer);
    for (const stop of this.branchSettings.values()) stop();
    for (const r of this.repos) this.stopRepo(r);
    this.coordinator.shutdown();
    this.commander.shutdown();
    this.explorers.shutdown();
  }
}



/** What `moved` came to (`moved`). */
type Moved = 'same' | 'follow' | 'due';


/** The restart of a repository's agents that waits, as its workers hear of it. */
const repoDue = (p: RepoRestart): DueRestart => ({ reason: p.reason, deadline: p.deadline, repo: true });

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** A workspace as a directory on this machine, for a program that runs here (gh on a pull request's URL); none for one on another machine. */
const localDir = (workspace: string | null) => (workspace && !hostName(workspace) ? workspace : null);
