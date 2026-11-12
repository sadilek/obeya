// Obeya's configuration: the canvases, their repositories and a repository's settings, as saved, resolved and checked.

import type { NarrationLanguage } from '../../plugin/skills/demo/lib/settings.ts';
import type { Language } from './locale';
import type { PageTags } from './types';

/** A repository on a canvas, as Obeya's configuration lists it (`canvases.json`). */
export interface RepoConfig {
  path: string;
  /**
   * `false`: a folder without git that is to stay one (a document archive, say): every card works in
   * the folder itself, nothing lands, and each card lists what it changed (design: Folders without git).
   */
  git?: false;
  /** Clones to register as workspaces (adapters that use clones). */
  workspaces?: string[];
  /** Clones to create under Obeya's home (adapters that use clones). */
  clones?: number;
  /** How many of its workers may be busy at once on this machine; left out, as many as it has clones, or any number in worktrees. */
  slots?: number;
  /**
   * Other machines its workers run on, reached over SSH (design: Hosts), in the order a new card
   * looks for a free slot after this one. Only for a repository whose workers use clones and whose work goes out through its
   * remote.
   */
  hosts?: HostConfig[];
  /** The settings the owner set for this machine in the configuration dialog; each goes before the repository's `.obeya/settings.json`. */
  settings?: RepoSettings;
}

/** How the repository's app runs (`app` of its settings): the recipe the workers read, and the two commands Obeya runs itself. */
export interface AppSettings {
  /**
   * How to run the app, in prose for a new colleague: how to start it, what to do after which kind
   * of change, where it gives its address, the login and test data for a demo. Every worker's brief
   * has it; empty, each worker finds it out from the repository.
   */
  run?: string;
  /**
   * Stops the app in a workspace, and does nothing where none runs. Obeya runs it there when the
   * card waits for the owner and its worker has nothing running (Parking), and tells the worker with
   * its next message.
   */
  stop?: string;
  /** Exits 0 when the workspace's app holds what must not be lost (a restored database, say): Obeya then leaves it running. */
  keep?: string;
}

/** A demo site being set up at a host, as the configuration follows it: its last lines, and how it ended. */
export interface SiteSetupJob {
  host: 'cloudflare' | 'github';
  running: boolean;
  lines: string[];
  error?: string;
  /** The host the dialog offers where this one refused (GitHub Pages from a private repository without Pro). */
  offer?: 'cloudflare';
  /** A repository's site once it is set up, for its settings. */
  site?: DemoSite;
}

/** A proposal for a demo site's tags (`demo.site.tags`), as the configuration follows it: running, then the tags and why, or the error. */
export interface TagProposalJob {
  running: boolean;
  tags?: PageTags;
  why?: string;
  error?: string;
}

/** The owner's personal demo site on this machine, as Configuration → Demos shows it. */
export interface PersonalSiteView {
  site: {
    host: 'cloudflare' | 'github';
    url: string;
    project: string;
    /** What a page's address looks like there (a fresh random part, for the dialog). */
    example: string;
    /** The env file with its credentials this machine lacks, relative to Obeya's home. */
    needs?: string;
    /** A public GitHub repository's site: listed, without a random part in its addresses. */
    listed?: true;
  } | null;
  job?: SiteSetupJob;
  /**
   * The private repositories (those on the canvases whose forge does not say they are public, and
   * those ticked), each with whether it is ticked to share there and whether it has a site of its
   * own this machine deploys to.
   */
  privateRepos: { path: string; name: string; allowed: boolean; ownSite?: true }[];
  /**
   * The repositories that share there (and those ticked for it), each with whether each approved
   * card's latest demo goes there by itself: ticked here, or by its site's settings (`bySettings`),
   * which the tick here cannot change.
   */
  approvedRepos: { path: string; name: string; on: boolean; bySettings?: true }[];
  /** The sites this machine deploys to on Cloudflare, each of another account: a new site may go into one of them. */
  cloudflareAccounts: string[];
}

/**
 * A static site the demos are shared on (`demo.site` of a repository's settings): Obeya keeps its
 * directory (one subdirectory per page, and the overview), writes the pages with its own templates
 * and runs the deploy command after each change.
 */
export interface DemoSite {
  /** The overview's heading, and the pages' tab titles. */
  title: string;
  /** Where the site is served; a page's URL is `url/<slug>/`. */
  url: string;
  /** The command line that deploys the site, run in `share/` under Obeya's home; `{dir}` stands for the site's directory. */
  deploy: string;
  /**
   * A file of `KEY=value` lines, relative to Obeya's home, added to the deploy's environment
   * (credentials, never in git). A machine without it exports demos instead of sharing them.
   */
  env?: string;
  /** Headers for reading the live site's manifest and pages (behind a login), values `${KEY}` from `env`. */
  headers?: Record<string, string>;
  /** The largest file the host takes, in bytes; 25 MiB without it. */
  maxFile?: number;
  /**
   * When a demo goes on the site: `approved`, the card's latest demo as the owner approves its work
   * (before it lands); without it, only when the owner clicks "Share".
   */
  publish?: 'approved';
  /**
   * The vocabulary pages are tagged from: each dimension with its values, in the order the overview
   * shows them. Workers and Obeya's reading session choose from it and add nothing to it.
   */
  tags?: PageTags;
}

/**
 * What Obeya needs to know about how a repository works, and its main branch, as the owner sets
 * them in the configuration dialog for this machine (design: Repository settings). Read where they
 * are used: saving them restarts nothing, but for `workspaces`, which restarts the repository's agents.
 */
export interface RepoSettings {
  /** Its main branch, where cards start from and work lands; detected where left out (`defaultBranch`). */
  branch?: string;
  /**
   * How approved work lands: `main` fast-forwards the checkout Obeya runs on to the worker's
   * branch (created clones then come from that checkout); `pr` leaves the branch for a pull
   * request and clones come from `origin`.
   */
  land?: 'main' | 'pr';
  /**
   * With `land: 'pr'`: the owner may approve a card's work directly onto the default branch
   * instead, without a pull request. Obeya rebases it onto `origin`'s default branch and pushes it
   * there (never forced); review and the CI of a pull request are skipped.
   */
  direct?: boolean;
  /**
   * With `land: 'pr'`: Obeya merges a pull request itself once nothing is left for the worker
   * (checks green, threads resolved, reviewers answered). `false` leaves the merge to the people
   * on the forge: the card then waits for the owner, ready to merge. Default: `true`.
   */
  autoMerge?: boolean;
  /** Checks a worker runs before it reports the card ready for review. */
  checks?: string[];
  /** Command a worker runs first in a fresh clone (dependencies). */
  setup?: string;
  /** Where plan docs live, relative to the repository root. */
  planDocs?: { dir: string; exclude: string[] };
  /**
   * Paths (a trailing `/` covers a directory) whose edits never count as a merge conflict between
   * two cards: they are resolved when a branch is rebased (docs, plan docs).
   */
  softPaths?: string[];
  /** Workers get full clones from a pool, or a worktree of the Obeya checkout per card. */
  workspaces?: 'clones' | 'worktrees';
  /** Accounts whose pull request comments are not review feedback (deploy bots and the like). */
  prNoise?: string[];
  /**
   * The language of what lands in the repository and lasts (code, comments, commit messages, docs,
   * plan docs, CLAUDE.md), whatever language the owner talks to its agents in; English where left out.
   */
  language?: Language;
  /** How the app runs: the recipe in every worker's brief, and how Obeya stops it while a card waits (Parking). */
  app?: AppSettings;
  /**
   * `site`: the static site Obeya keeps and deploys itself to share demos on (`src/server/site.ts`);
   * without one, "Share" exports a demo as a file. `language`: the language of the repository's
   * demos (narration, captions, report, shared pages) and of its site's overview, over the one of
   * the demo settings (`demo.json`), which applies without it.
   */
  demo?: { site?: DemoSite; language?: NarrationLanguage };
}

/**
 * A repository's settings for everyone who runs Obeya on it, in `.obeya/settings.json` as its
 * default branch has it (design: Repository settings): those for this machine but the main branch,
 * which says where the file is read from.
 */
export type SharedSettings = Omit<RepoSettings, 'branch'>;

/** How a card's own branch says its work lands, where it changes the repository's settings for that. */
export type CardLanding = Partial<Pick<RepoSettings, 'land' | 'direct'>>;

/** The fields of `SharedSettings`, in the dialog's order. */
export const SHARED_FIELDS = ['land', 'direct', 'autoMerge', 'checks', 'setup', 'planDocs', 'softPaths', 'workspaces', 'prNoise', 'language', 'app', 'demo'] as const satisfies readonly (keyof SharedSettings)[];
// every field of `SharedSettings` is in the list: one left out would be neither taken over nor read live
const everyShared: [Exclude<keyof SharedSettings, (typeof SHARED_FIELDS)[number]>] extends [never] ? true : false = true;
void everyShared;

/** The settings made of fields that are each set, layered and taken over on their own, and their fields. */
export const NESTED_SETTINGS = { app: ['run', 'stop', 'keep'], demo: ['site', 'language'] } as const satisfies { [K in keyof RepoSettings]?: readonly (keyof NonNullable<RepoSettings[K]>)[] };
export type NestedSetting = keyof typeof NESTED_SETTINGS;
export const isNested = (field: string): field is NestedSetting => field in NESTED_SETTINGS;

/** `over` in front of `under`, field by field; the fields of `app` and `demo` each on its own. */
export function layerSettings<T extends RepoSettings>(under: T | undefined, over: T | undefined): T | undefined {
  if (!under) return over;
  if (!over) return under;
  const out: RepoSettings = { ...under, ...over };
  for (const k of Object.keys(NESTED_SETTINGS) as NestedSetting[]) if (under[k] || over[k]) out[k] = { ...under[k], ...over[k] };
  return out as T;
}

/**
 * Where a repository's setting comes from where this machine sets none, highest first: the
 * repository's `.obeya/settings.json`, the clones the configuration names (`workspaces` only),
 * detection (main branch, landing), Obeya's default.
 */
export type SettingSource = 'repository' | 'clones' | 'detected' | 'default';

/** A setting's value without this machine's, and where it comes from. */
export interface SettingValue<T> {
  value: T;
  source: SettingSource;
  /** A command of the repository's that does not count until the owner confirms it (`RepoCommands`). */
  held?: true;
}

/**
 * What of a repository's own files Obeya runs or contacts on this machine without a click, or its
 * agents' sessions run outside Claude Code's permission checks, by group: one confirmed by the
 * owner counts as long as the default branch has it so (design: Trusting a repository's commands).
 */
export interface RepoCommands {
  /** `app.stop` and `app.keep` of `.obeya/settings.json`, which park a waiting card: one without the other could stop what `keep` keeps. */
  app?: { stop?: string; keep?: string };
  /** What of `demo.site` the deploy runs with and the live site is read from, and whether it deploys without a click on "Share". */
  site?: Pick<DemoSite, 'url' | 'deploy' | 'env' | 'headers' | 'publish'>;
  /** The repository's own Claude Code configuration by file (everything under `.claude/`, `.mcp.json`): hooks, MCP servers, helpers. */
  claude?: Record<string, ClaudeFile>;
}

/**
 * A file of a repository's Claude Code configuration: its git object, which tells one content from
 * another to the byte (a blob; a submodule's commit), and its text to read (a submodule's commit).
 */
export interface ClaudeFile {
  id: string;
  text: string;
}

export type TrustGroup = keyof RepoCommands;

/** The commands of a repository that do not count yet (`held`), as its default branch has them and as the owner last confirmed them. */
export interface RepoTrust {
  held: TrustGroup[];
  now: RepoCommands;
  before?: RepoCommands;
}

/** The lines of a group of commands, for the owner to read and compare: each field with its value, each file under its name. */
export function commandLines(c: RepoCommands | undefined, g: TrustGroup): string[] {
  const v = c?.[g];
  if (!v) return [];
  if (g === 'claude') return Object.entries(v as Record<string, ClaudeFile>).flatMap(([file, f]) => [`${file}:`, ...f.text.split('\n').map((l) => `  ${l}`)]);
  return Object.entries(v).map(([k, x]) => `${g === 'app' ? 'app' : 'demo.site'}.${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);
}

/**
 * A repository's settings as they stand without this machine's: what the dialog shows where the owner
 * set nothing. Each field has a value; a demo has no site or language of its own where none is set (`null`).
 */
export type RepoValues = { [K in Exclude<keyof RepoSettings, NestedSetting>]-?: SettingValue<NonNullable<RepoSettings[K]>> } & {
  app: { [F in keyof AppSettings]-?: SettingValue<NonNullable<AppSettings[F]>> };
  demo: { site: SettingValue<DemoSite | null>; language: SettingValue<NarrationLanguage | null> };
};

/**
 * A repository's entry in the configuration without what applies as it is read (its settings but
 * where its workers work): where it differs, the repository's agents restart with it.
 */
export function repoShape({ settings, ...r }: RepoConfig): string {
  return JSON.stringify({ ...r, workIn: settings?.workspaces });
}

/** The clones a repository gets whose settings say clones, the first canvas's or one added later: two cards run at once. */
export const CLONES = 2;

/** A machine reached over SSH that a repository's workers run on, in clones of their own there. */
export interface HostConfig {
  /** What the owner calls it; workspaces there are named by it. */
  name: string;
  /** What `ssh` connects to: `user@machine`, or a name from `~/.ssh/config`. */
  ssh: string;
  /** The directory there that holds the clones (`~/…` in that machine's home). */
  root: string;
  /** How many clones Obeya keeps there (`<root>/1`, `<root>/2`, …). */
  clones: number;
  /** How many of the repository's workers may be busy there at once; as many as it has clones when left out. */
  slots?: number;
}

/** A canvas in Obeya's configuration. */
export interface CanvasConfig {
  /** Names the canvas; its id follows. Without it, both are the first repository's name. */
  name?: string;
  /** Keeps the canvas's id, and with it its cards, whatever its name says: set when a canvas is renamed. */
  id?: string;
  repos: RepoConfig[];
}

/** What a configuration amounts to: each canvas's id and name, and its repositories with their settings. */
export interface ResolvedCanvas {
  id: string;
  name: string;
  repos: {
    id: string;
    workspaces: 'clones' | 'worktrees';
    /** A folder without git (`RepoConfig.git` false): no branch, landing, clones or hosts. */
    folder?: true;
    /**
     * It still has a `.obeya/adapter/` on its main branch, which Obeya no longer reads: its values
     * belong in `.obeya/settings.json` (problem `adapterGone`).
     */
    adapterGone?: boolean;
    /** Its settings without this machine's, with where each comes from. */
    values: RepoValues;
    /** Its commands that wait for the owner to confirm them (problem `untrusted`). */
    trust?: RepoTrust;
    /**
     * Where "Take over into the repository for everyone" puts `.obeya/settings.json`: a commit on the main
     * branch where work lands there, else a pull request.
     */
    shareTo: 'main' | 'pr';
    /** Where it goes out as a pull request, it may also be pushed straight onto `origin`'s main branch (`direct`). */
    shareDirect?: boolean;
    /**
     * On a canvas that runs: the clones its pool loses with this configuration (path on its machine,
     * the host where not here, the number where Obeya made it, the title of the card that holds it).
     */
    leaving?: LeavingClone[];
  }[];
}

/** A clone a repository's pool loses with a configuration (`ResolvedCanvas`). */
export interface LeavingClone {
  path: string;
  host?: string;
  /** Its number where Obeya made it; its folder goes once nothing in it would be lost. One the owner listed has none, and stays on disk. */
  made?: number;
  /** The title of the card that holds it: it leaves once that card gives it back. */
  card?: string;
}

/** Something in a configuration that keeps Obeya from starting with it; `canvas` and `repo` count from 0. */
export interface ConfigProblem {
  code: ConfigProblemCode;
  canvas?: number;
  repo?: number;
  /** In English, for developers and the Coordinator. */
  detail: string;
}

/** Problems of the running canvases, not of the configuration: a canvas or repository that did not start as it has them (`StartFailure`). Saving the configuration, or "Try again", has them try again. */
export const START_FAILED: ConfigProblemCode[] = ['canvasDown', 'repoDown', 'repoBefore'];

/** Whether a problem keeps the configuration from being saved: not one in the repository, which is fixed there. */
export const blocksSaving = (p: ConfigProblem) => !['demoSite', 'adapterGone', 'repoSettings', 'untrusted', ...START_FAILED].includes(p.code);

export type ConfigProblemCode =
  /** No canvas at all. */
  | 'noCanvas'
  | 'noRepo'
  /** A repository whose path is empty. */
  | 'noPath'
  /** A path that is no git repository. */
  | 'notRepo'
  /** A folder without git (`RepoConfig.git` false) whose path is no folder. */
  | 'noFolder'
  /** A repository the canvas has already, under this path or another. */
  | 'sameRepo'
  /** The repository still has a `.obeya/adapter/`, which Obeya no longer reads: its values belong in `.obeya/settings.json`. */
  | 'adapterGone'
  /** Two canvases with the same id. */
  | 'sameId'
  /** The repository the canvas was first served with is missing. */
  | 'homeMissing'
  /** A clone listed as a workspace that is no git repository. */
  | 'notClone'
  /** A clone listed as a workspace whose origin is another repository's. */
  | 'otherClone'
  /** The demo site the repository's settings name cannot be used: a field is missing, or its deploy command names a program that is not there. */
  | 'demoSite'
  /** A host that cannot work for the repository: its workers use worktrees, or its work does not go out through a remote. */
  | 'hostRepo'
  /** Two hosts of one name that connect to different machines. */
  | 'hostName'
  /** A main branch set for this machine that the repository does not have. */
  | 'noBranch'
  /** Something in the repository's `.obeya/settings.json` that does not count (fixed there, so it keeps nothing from being saved). */
  | 'repoSettings'
  /** Commands of the repository, new or changed on its default branch, that wait for the owner to confirm them (`RepoTrust`). */
  | 'untrusted'
  /** The canvas does not run: its home repository did not start (a git error, say). */
  | 'canvasDown'
  /** The repository did not start: it is left out of its canvas, its cards kept. */
  | 'repoDown'
  /** The repository's agents did not start as the configuration has them now: they work on as they were set up before. */
  | 'repoBefore'
  /** Malformed: a bug in whoever wrote it. */
  | 'invalid';

/**
 * Obeya's configuration as the owner sees and edits it, at once: what it amounts to and what is
 * wrong with it come after, from its check (`ConfigChecked`), which reads every repository.
 */
export interface ConfigView {
  /** The file it is saved in. */
  file: string;
  /** Where the running canvases come from: that file, or repositories named on the command line. */
  source: 'file' | 'args';
  /** As saved (or as given on the command line, before anything is saved). */
  canvases: CanvasConfig[];
  /** The ids of the canvases this server runs. */
  running: string[];
  /**
   * Settings of the running server, from its command line; its version (`package.json`), and the
   * commit of the checkout it runs from (null for the compiled binary).
   */
  server: { port: number; home: string; permissionMode: string; restarts: boolean; version: string; commit: string | null };
  /** Saved, and Obeya starts again with it once no agent is in the middle of a turn. */
  restarting: boolean;
}

/** A configuration checked: what it amounts to and what keeps it from working. */
export interface ConfigChecked {
  /** As saved, tidied. */
  canvases: CanvasConfig[];
  /** What they amount to, by index; null for a canvas with a problem. */
  resolved: (ResolvedCanvas | null)[];
  problems: ConfigProblem[];
}

/** What "Take over into the repository for everyone" did with a repository's settings for this machine. */
export type SettingsShared =
  /** Committed `.obeya/settings.json` on the main branch (pushed onto `origin`'s, where it went there directly): the settings now come from the repository. */
  | { committed: string; branch: string }
  /** The main branch's `.obeya/settings.json` (`origin`'s, where it would have gone there) held them already: nothing committed, pushed or opened; the settings come from the repository. */
  | { unchanged: true; branch: string }
  /** Opened a pull request with it: once it is merged, the settings come from the repository. */
  | { pr: string };

/** What saving the configuration did: Obeya starts again with it, or (repositories' settings alone) it applies at once. */
export interface ConfigSaved {
  restarting: boolean;
  /** Obeya runs with it now: canvases and repositories new in it started, settings apply as they are read, and agents whose repository's set-up changed restart once they paused. */
  applied?: boolean;
}
