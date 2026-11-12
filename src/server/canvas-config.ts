// A canvas's configuration resolved: what git reads of its repositories (`readRepos`), what the
// configuration amounts to with them (`resolveCanvas`), and what a repository's settings say of
// how it runs and shares, without touching anything.

import { statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defaultsFor, hasAdapterModule, readSharedAt, readSharedFiles, repoValues, type SharedRead, withSettings } from '../adapters';
import { repoName } from '../adapters/generic';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import { dimensions } from '../core/page-tags';
import type { RepoRef, UpstreamRef } from '../core/types';
import { type CanvasConfig, type ConfigProblemCode, type DemoSite, layerSettings, type RepoConfig, type RepoSettings, type SharedSettings } from '../core/config';
import { branchCommit, branchSetting, defaultBranchCommit, detectBranch, markFolder, readBranches, detectUpstream, remoteUrls } from './branches';
import type { Store } from './db';
import { gitTry } from './git';
import { parseRemote } from './repo';
import { allowedHere, approvedHere, personalDemoSite, readPersonal } from './personal-site';
import { refsSeal } from './read-tree';
import { siteIncomplete, siteMissing, siteName } from './site';
import type { Theme } from './theme';

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
 * What resolving a repository reads of it with git (`readRepo`): where it is and its main
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
 * Reads a repository for `resolveCanvas`; null where `path` is no git repository. A folder without
 * git (`folder`) is read as it is, without git: null where it is no directory. Its main branch is
 * `branch` where the owner set one, else the one detected.
 */
async function readRepo(path: string, folder: boolean, branch: string | undefined): Promise<RepoRead | null> {
  markFolder(path, folder);
  if (folder) return readFolder(path);
  const [remote, origin, branches] = await Promise.all([gitTry(path, 'remote', 'get-url', 'origin'), gitTry(path, 'config', '--get', 'remote.origin.url'), readBranches(path)]);
  if (branches == null) return null;
  const detected = await detectBranch(path, branches);
  const main = branch || detected;
  const commit = await branchCommit(path, main, branches);
  const [adapterModule, shared, upstream, remotes] = await Promise.all([hasAdapterModule(path, commit), readSharedAt(path, commit), detectUpstream(path), remoteUrls(path)]);
  return { info: { path, remote: remote ?? null, branch: main, ...(remote && origin ? { origin } : {}), ...(upstream ? { upstream } : {}), ...(Object.keys(remotes).length ? { remotes } : {}) }, detected, adapterModule, shared };
}

/**
 * What a configuration's repositories are read for, by absolute path, without the server waiting
 * for git: each repository (`readRepo`, under the seal its refs had before, `refsSeal`), and
 * each workspace it lists (its `origin`; null where it is no git repository). All of them at once.
 */
export interface RepoReads {
  repos: Map<string, { seal: string | null; read: RepoRead | null }>;
  workspaces: Map<string, { origin: string | null } | null>;
}

/** Reads `repos` (`RepoReads`), each on the main branch `branchOf` says the owner set for it (none: the one detected). */
export async function readRepos(repos: RepoConfig[], branchOf: (r: RepoConfig) => string | undefined = () => undefined): Promise<RepoReads> {
  // a repository whose path is still empty is read nowhere (`resolveCanvas` finds its path missing)
  const named = repos.filter((r) => r.path.trim());
  const paths = new Map(named.map((r) => [resolve(r.path), r]));
  const workspaces = new Set(named.flatMap((r) => (r.workspaces ?? []).map((w) => resolve(w))));
  // one that is also a repository of the configuration is read as that
  const listed = [...workspaces].filter((w) => !paths.has(w));
  const [read, found] = await Promise.all([
    Promise.all(
      [...paths].map(async ([path, r]) => {
        const folder = r.git === false;
        const seal = folder ? null : refsSeal(path);
        return [path, { seal, read: await readRepo(path, folder, branchOf(r)?.trim() || branchSetting(path)) }] as const;
      }),
    ),
    Promise.all(
      listed.map(async (w) => {
        const [dir, origin] = await Promise.all([gitTry(w, 'rev-parse', '--git-dir'), gitTry(w, 'remote', 'get-url', 'origin')]);
        return [w, dir != null ? { origin: origin ?? null } : null] as const;
      }),
    ),
  ]);
  const repoRead = new Map(read);
  const asRepo = [...workspaces].filter((w) => paths.has(w)).map((w) => {
    const info = repoRead.get(w)?.read?.info;
    return [w, info && !info.folder ? { origin: info.remote } : null] as const;
  });
  return { repos: repoRead, workspaces: new Map([...found, ...asRepo]) };
}

/** What a repository's default branch has of its settings: its `.obeya/settings.json` and Claude Code configuration (`readShared`), and whether an adapter module is still there (`hasAdapterModule`). */
export interface DefaultRead {
  shared: SharedRead;
  adapterModule: boolean;
  /** The main branch it was read on (`defaultBranch`). */
  branch: string;
  /** The repository's theme (theme.ts), where it was read with the rest. */
  theme?: Theme | null;
}

/** `DefaultRead` of the git repository at `path`. */
export async function readDefault(path: string): Promise<DefaultRead> {
  const { branch, commit } = await defaultBranchCommit(path);
  const [adapterModule, shared] = await Promise.all([hasAdapterModule(path, commit), readSharedAt(path, commit)]);
  return { shared, adapterModule, branch };
}

/** A folder without git as `resolveCanvas` reads it: no remote, no branch, its `.obeya/settings.json` as the folder has it. */
function readFolder(path: string): RepoRead | null {
  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  return { info: { path, remote: null, branch: '', folder: true }, detected: '', adapterModule: false, shared: readSharedFiles(path) };
}

/**
 * What a canvas's configuration amounts to, without touching anything: its repositories (home
 * first), each with Obeya's defaults and in front of them the repository's `.obeya/settings.json`
 * (`shared`: where they are read, by the repository's path; as `read` read them when left out) and
 * this machine's settings (`settings`: where a repository's are read; its entry's when left out),
 * each with its id and its settings without this machine's (`values`), and the canvas's id and
 * name. `read` is what was read of each repository, by its absolute path (`readRepos`). Throws a
 * ConfigError.
 */
export function resolveCanvas(
  config: CanvasConfig,
  store: Store,
  settings: (r: RepoConfig) => () => RepoSettings | undefined = (r) => () => r.settings,
  shared: ((path: string) => () => SharedSettings | undefined) | undefined,
  read: (path: string, folder: boolean) => RepoRead | null,
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
  const id = config.id ? slug(config.id) : config.name ? slug(config.name) : slug(repoName(reads[0]!.info));
  const kept = keptRepoIds(store, id);
  const refsOf = () => uniqueRefs(repos.map((x) => x.read.info), repos.map((x) => x.adapter), kept, () => store.cardRepos(id).concat(store.setting(id, 'home_repo') ?? []));
  let refs = refsOf();
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
    repos: repos.map((x, i) => ({ ...x, ref: refs[i]!, values: () => repoValues(x.read.info, x.read.detected, namesClones(x.config, x.read.info, { land: x.adapter.land }), sharedOf(x.read.info.path)() ?? {}) })),
    stored,
  };
}

/** What `resolveCanvas` resolved. */
export type Resolved = ReturnType<typeof resolveCanvas>;

/** The settings the owner set for a repository on this machine (`CanvasDeps.settings`, else its entry's), read whenever they are used. */
export const machineSettings = (deps: { settings?: (repoPath: string) => RepoSettings | undefined }, r: RepoConfig): (() => RepoSettings | undefined) =>
  deps.settings ? () => deps.settings!(resolve(r.path)) : () => r.settings;

/**
 * Where a resolved repository's read tree is made, a worktree of its checkout under Obeya's home;
 * none where work lands on the local main (the checkout is the read tree), or in a folder without
 * git, which is read as it is.
 */
export function readTreeOf(home: string, canvas: string, x: Resolved['repos'][number]): { repoPath: string; dir: string } | null {
  return x.read.info.folder || x.adapter.land === 'main' ? null : { repoPath: x.read.info.path, dir: join(home, 'read', canvas, x.ref.id) };
}

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

/**
 * Repository ids unique on the canvas: each the one it was given on the canvas before (`kept`, by
 * its path), else its name, with a number when two share one. Where cards on the canvas (`held`)
 * still go by its directory's name and no repository of the canvas has that id, it gets that one:
 * its id from before ids were kept, when its `origin` came later.
 */
function uniqueRefs(infos: RepoInfo[], adapters: RepoAdapter[], kept: Record<string, string>, held: () => string[]): RepoRef[] {
  const ids: string[] = [];
  const taken = new Set<string>();
  infos.forEach((info, i) => {
    const id = kept[info.path];
    if (id && !taken.has(id)) taken.add((ids[i] = id));
  });
  const bases = infos.map((info, i) => slug(repoName(info)) || `repo${i + 1}`);
  let orphans: Set<string> | undefined;
  infos.forEach((info, i) => {
    if (ids[i]) return;
    const base = bases[i]!;
    const before = slug(basename(info.path));
    orphans ??= new Set(held());
    let id = base;
    if (before && before !== base && !taken.has(before) && !bases.some((b, j) => !ids[j] && b === before) && orphans.has(before)) id = before;
    else for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    taken.add((ids[i] = id));
  });
  return infos.map((info, i) => ({ id: ids[i]!, name: repoName(info), path: info.path, ...settled(info, adapters[i]!) }));
}

/** The ids the canvas's repositories were given, by their paths (`keepRepoIds`). */
function keptRepoIds(store: Store, canvas: string): Record<string, string> {
  try {
    return JSON.parse(store.setting(canvas, REPO_IDS) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const REPO_IDS = 'repo_ids';

/**
 * Keeps the ids the canvas's repositories have now (`refs`), so a repository keeps its id (and its
 * cards) when its name changes, with a new `origin`, say. An id another path had passes to the
 * repository that has it now: a repository moved to another folder keeps its cards.
 */
export function keepRepoIds(store: Store, canvas: string, refs: Pick<RepoRef, 'id' | 'path'>[]) {
  const kept = keptRepoIds(store, canvas);
  const next = { ...kept };
  for (const { id, path } of refs) {
    for (const [p, other] of Object.entries(next)) if (other === id && p !== path) delete next[p];
    next[path] = id;
  }
  if (JSON.stringify(next) !== JSON.stringify(kept)) store.setSetting(canvas, REPO_IDS, JSON.stringify(next));
}

/** The URL of the repository's `origin` as it is configured, before git's `insteadOf` rewrites it (as read with the rest, `readRepo`); null without one. */
export const originUrl = (info: RepoInfo): string | null => (info.remote ? (info.origin ?? info.remote) : null);

/** Whether the repository's `origin` is on a server, as it is configured (git's `insteadOf` aside), rather than a directory on this machine. */
function onServer(info: RepoInfo): boolean {
  const url = originUrl(info);
  return !!url && (/^(https?|ssh|git):\/\//i.test(url) || /^[^/\\\s:]{2,}:/.test(url));
}

/** What a repository's ref says of its settings, which may change while the canvas runs: its main branch, how work lands. */
export function settled(info: RepoInfo, adapter: RepoAdapter): Pick<RepoRef, 'branch' | 'pullRequests' | 'direct' | 'folder' | 'forge' | 'upstream'> {
  if (info.folder) return { branch: '', folder: true };
  const upstream = upstreamOf(info, adapter);
  return {
    branch: info.branch,
    // an origin on a server (not a directory on this machine) may get pull requests of others
    ...(onServer(info) ? { forge: true } : {}),
    ...(adapter.land === 'pr' ? { pullRequests: true, ...(adapter.direct ? { direct: true } : {}) } : {}),
    ...(upstream ? { upstream } : {}),
  };
}

/**
 * The original repository a fork's cards may go to as a pull request (`RepoSettings.upstream`):
 * only where work lands on the local main branch, which then takes what is pushed onto that pull
 * request. Its name is `owner/repo` of the remote's URL, else the remote's name.
 */
export function upstreamOf(info: RepoInfo, adapter: RepoAdapter): UpstreamRef | undefined {
  const set = adapter.upstream?.trim();
  if (!set || adapter.land !== 'main' || info.folder) return undefined;
  const slash = set.indexOf('/');
  const remote = set.slice(0, slash);
  const url = info.remotes?.[remote];
  const path = url ? parseRemote(url).path.split(/[/\\]/).slice(-2).join('/') : '';
  return { ref: set, remote, branch: set.slice(slash + 1), name: path || remote, ...(url ? { url } : {}), into: info.branch };
}

/** Where a repository shares demos: the site its settings name, once it is complete; null without one. */
export function siteOf(adapter: RepoAdapter): DemoSite | null {
  const site = adapter.demo?.site;
  return site && !siteIncomplete(site) ? site : null;
}

/** What the UI is told about sharing a repository's demos. */
export const SHARE_FIELDS = ['share', 'shareNeeds', 'shareOnApproval', 'shareTags', 'shareOnPersonal', 'shareUnlisted', 'sharePersonal'] as const;
type ShareRef = Pick<RepoRef, (typeof SHARE_FIELDS)[number]>;

/**
 * What the canvas tells the UI about it: a site to share on here (its own, where this machine has
 * its credentials, else the owner's personal one, where the repository may go there), the env file
 * its site lacks on this machine, and why the personal site does not take it (none set up, or the
 * repository is private and not ticked).
 */
export function shareRef(site: DemoSite | null, home: string, path: string, isPublic: boolean): ShareRef {
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
export const visibilityKey = (path: string) => `visibility:${path}`;

/** Tells the UI about sharing on the repository what `share` says, in place of what it was told before. */
export function setShare(ref: RepoRef, share: ShareRef) {
  for (const f of SHARE_FIELDS) delete ref[f];
  Object.assign(ref, share);
}

export const slug = (s: string) =>
  s
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-|-$/g, '');
