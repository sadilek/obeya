// Obeya's configuration: the canvases it serves, saved in `canvases.json` under its home. The owner
// reads and edits it in its sheet, the Coordinator on their word. A saved change applies while
// Obeya runs (`Canvases.apply`, see Live configuration in
// docs/design/repositories-and-configuration.md): what a repository's agents are set up by
// restarts that repository's agents alone, once they paused. The
// repositories' settings (`RepoSettings`) are read where they are used, apply at once, and saving
// them alone restarts nothing but where they change where the workers work.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readShared, REPO_ADAPTER_DIR, REPO_SETTINGS_FILE } from '../adapters';
import { settingsShape, withoutGone as goneSettings } from '../adapters/schema';
import { blocksSaving, type CanvasConfig, type DemoSite, type ConfigChecked, type ConfigProblem, type ConfigSaved, type ConfigView, type RepoSettings, SHARED_FIELDS, NESTED_SETTINGS, type NestedSetting, isNested, type SettingsShared, type SharedSettings, type ResolvedCanvas, layerSettings, type ProposedSetting, type RepoTrust, type RepoValues, settingPatch, commandLines } from '../core/types';
import { expandHome } from '../../plugin/skills/demo/lib/settings.ts';
import { BadRequest } from './board';
import { ConfigError, readRepos, resolveCanvas, type StartFailure } from './canvas';
import type { Store } from './db';
import { sameRemote } from './repo';
import type { Forge } from './forge';
import { commitShared, proposeShared, pushShared } from './shared-settings';
import { leavingClones } from './workspaces';
import { gitTry } from './git';
import { VERSION } from './resources';
import { siteProblem } from './site';
import { canonical, commandsOf, heldGroups, trustHeld, trustTakenOver } from './trust';

export const CONFIG_FILE = 'canvases.json';

/** Whether the configuration's repository `r` is the one at `path` (absolute). */
const isAt = (r: { path: string }, path: string) => resolve(expandHome(r.path)) === path;

/** The first repository of the configuration that `match` takes, with the index of its canvas and its own. */
function locate(canvases: CanvasConfig[], match: (r: CanvasConfig['repos'][number]) => boolean) {
  return canvases.flatMap((c, canvas) => c.repos.map((r, repo) => ({ r, canvas, repo }))).find(({ r }) => match(r));
}

/** The configuration with its paths as the server uses them. */
export function expandConfig(canvases: CanvasConfig[]): CanvasConfig[] {
  return canvases.map((c) => ({
    ...c,
    repos: c.repos.map((r) => ({ ...r, path: expandHome(r.path), ...(r.workspaces ? { workspaces: r.workspaces.map(expandHome) } : {}) })),
  }));
}

/**
 * A repository's settings as they are saved: lists without empty lines, no main branch or plan
 * directory that is empty; none at all where nothing is set. An empty list or command is a value
 * of its own (no checks, no setup), unlike one left out.
 */
function tidySettings(s: z.infer<typeof settingsShape> | undefined): RepoSettings | undefined {
  if (!s) return undefined;
  const list = (l?: string[]) => l?.map((x) => x.trim()).filter(Boolean);
  const dir = s.planDocs?.dir.trim().replace(/\/+$/, '');
  const site = tidySite(s.demo?.site);
  const demo = { ...(site ? { site } : {}), ...(s.demo?.language ? { language: s.demo.language } : {}) };
  // what is not normalised here goes as it came
  const out: RepoSettings = {
    ...s,
    branch: s.branch?.trim() || undefined,
    checks: list(s.checks),
    setup: s.setup?.trim(),
    planDocs: dir ? { dir, exclude: list(s.planDocs!.exclude)! } : undefined,
    softPaths: list(s.softPaths),
    prNoise: list(s.prNoise),
    app: tidyApp(s.app),
    demo: Object.keys(demo).length ? demo : undefined,
  };
  // in the dialog's order, without what is left unset
  const kept = (['branch', ...SHARED_FIELDS] as const).filter((k) => out[k] !== undefined).map((k) => [k, out[k]]);
  return kept.length ? (Object.fromEntries(kept) as RepoSettings) : undefined;
}

/**
 * How the app runs, as it is saved: each field trimmed. An empty recipe is a value of its own (none,
 * over the repository's); an empty command is none and goes. None where nothing is left.
 */
function tidyApp(s: RepoSettings['app']): RepoSettings['app'] {
  if (!s) return undefined;
  const out = { ...(s.run !== undefined ? { run: s.run.trim() } : {}), ...(s.stop?.trim() ? { stop: s.stop.trim() } : {}), ...(s.keep?.trim() ? { keep: s.keep.trim() } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** A demo site as it is saved: its fields trimmed, those left empty out; none where nothing is filled in. */
function tidySite(s: DemoSite | undefined): DemoSite | undefined {
  if (!s) return undefined;
  const headers = Object.entries(s.headers ?? {}).filter(([k]) => k.trim());
  const out: DemoSite = {
    title: s.title.trim(),
    url: s.url.trim(),
    deploy: s.deploy.trim(),
    ...(s.env?.trim() ? { env: s.env.trim() } : {}),
    ...(headers.length ? { headers: Object.fromEntries(headers.map(([k, v]) => [k.trim(), v.trim()])) } : {}),
    ...(s.maxFile ? { maxFile: s.maxFile } : {}),
    ...(s.publish ? { publish: s.publish } : {}),
    ...(s.tags && Object.keys(s.tags).length ? { tags: s.tags } : {}),
  };
  return out.title || out.url || out.deploy || Object.keys(out).length > 3 ? out : undefined;
}

/** The canvases as the configuration lists them, from the dialog, the file and the Coordinator alike. */
export const configShape = z.array(
  z
    .object({
      name: z.string().optional(),
      id: z.string().optional(),
      repos: z.array(
        z
          .object({
            path: z.string(),
            git: z.literal(false).optional(),
            workspaces: z.array(z.string()).optional(),
            clones: z.number().int().min(0).max(20).optional(),
            slots: z.number().int().min(0).max(20).optional(),
            hosts: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .regex(/^\s*[\w.-]*\s*$/, 'a host name is letters, digits, dots, dashes and underscores')
                      // a directory of its own under Obeya's home holds the host's copies
                      .refine((n) => !/^\.{1,2}$/.test(n.trim()), 'a host name is more than dots'),
                    // read by ssh as an option when it starts with a dash
                    ssh: z.string().refine((s) => !s.trim().startsWith('-'), 'an ssh target does not start with a dash'),
                    root: z.string(),
                    clones: z.number().int().min(0).max(20),
                    slots: z.number().int().min(0).max(20).optional(),
                  })
                  .strict(),
              )
              .optional(),
            settings: settingsShape.optional(),
          })
          .strict(),
      ),
    })
    .strict(),
);

/** The configuration as it is saved: no empty names, clone lists or counts. */
function tidy(canvases: z.infer<typeof configShape>): CanvasConfig[] {
  return canvases.map((c) => ({
    ...(c.name?.trim() ? { name: c.name.trim() } : {}),
    ...(c.id?.trim() ? { id: c.id.trim() } : {}),
    repos: c.repos.map((r) => {
      const workspaces = (r.workspaces ?? []).map((w) => w.trim()).filter(Boolean);
      // a host without a name or a machine is a row still being filled in
      const hosts = (r.hosts ?? []).map((h) => ({ name: h.name.trim(), ssh: h.ssh.trim(), root: h.root.trim() || '~/obeya', clones: h.clones, ...(h.slots !== undefined ? { slots: h.slots } : {}) })).filter((h) => h.name && h.ssh);
      const settings = tidySettings(r.settings);
      // a folder without git has neither clones nor other machines: its cards all work in it
      if (r.git === false) return { path: r.path.trim(), git: false as const, ...(settings ? { settings } : {}) };
      return {
        path: r.path.trim(),
        ...(workspaces.length ? { workspaces } : {}),
        ...(r.clones ? { clones: r.clones } : {}),
        ...(r.slots !== undefined ? { slots: r.slots } : {}),
        ...(hosts.length ? { hosts } : {}),
        ...(settings ? { settings } : {}),
      };
    }),
  }));
}

/** Reads a configuration file; throws when it is no list of canvases. */
export function readConfigFile(file: string): CanvasConfig[] {
  return tidy(configShape.parse(withoutGone(JSON.parse(readFileSync(file, 'utf8')))));
}

/**
 * A file as read, without the settings Obeya no longer has: a repository's share command (its demo
 * site took its place; `file` only), and its site's language (`demo.language` took its place).
 */
function withoutGone(made: unknown, file = true): unknown {
  if (Array.isArray(made))
    for (const c of made)
      for (const r of Array.isArray(c?.repos) ? c.repos : []) {
        if (!r || typeof r !== 'object') continue;
        if (file) delete r.share;
        if (r.settings && typeof r.settings === 'object') r.settings = goneSettings(r.settings).settings;
      }
  return made;
}

export interface ConfigOptions {
  /** Where it is saved. */
  file: string;
  /** Whether the running canvases come from that file or from the command line. */
  source: 'file' | 'args';
  /** The configuration the server started with, paths as given. */
  started: CanvasConfig[];
  store: Store;
  /** The ids of the canvases the server runs. */
  running: () => string[];
  /** The running server's settings; `commit` the one its checkout stands at (none for the compiled binary). */
  server: { port: number; home: string; permissionMode: string; commit?: string | null };
  /**
   * Starts Obeya again with the saved configuration, for canvases that came from the command line
   * (the file is the configuration from then on); absent where nothing restarts it (--dev).
   */
  restart?: () => void;
  /**
   * The running canvases take the saved configuration over without a restart (`Canvases.apply`):
   * `ids` are its canvases' ids, null where one does not resolve.
   */
  apply?: (canvases: CanvasConfig[], ids: (string | null)[]) => void | Promise<void>;
  /** The canvases, and repositories of those that run, that do not run as the configuration has them (`Canvases.failures`). */
  failures?: () => StartFailure[];
  /** Repositories' settings for everyone were committed: the running canvases read them again. */
  onSettings?: () => void;
  /** Where "Take over into the repository for everyone" opens its pull request. */
  forge?: Forge;
}

/** Where settings for everyone went, for the log: `origin` where they went to `origin`'s main branch, or would have. */
function sharedHow(done: SettingsShared, origin: boolean): string {
  if ('pr' in done) return `as a pull request: ${done.pr}`;
  if ('unchanged' in done) return `which ${origin ? "origin's " : ''}${done.branch} had already`;
  return origin ? `pushed onto origin's ${done.branch}` : `committed on ${done.branch}`;
}

/** Whether the repository has the branch, locally or as `origin`'s. */
async function hasBranch(path: string, branch: string): Promise<boolean> {
  const found = await Promise.all(['refs/heads/', 'refs/remotes/origin/'].map((ref) => gitTry(path, 'rev-parse', '--verify', '--quiet', `${ref}${branch}^{commit}`)));
  return found.some((x) => x !== null);
}

/** The repository's commands that wait for the owner's confirmation (`heldGroups`), with what they were when last confirmed; none where none do. */
function trustOf(path: string, read: Parameters<typeof commandsOf>[0], mine: RepoSettings | undefined, store: Store): RepoTrust | undefined {
  const now = commandsOf(read);
  const before = store.trustedCommands(path);
  const held = heldGroups(now, before, mine);
  return held.length ? { held, now, ...(before ? { before } : {}) } : undefined;
}

/** The repository's values with those of the commands it holds marked (`SettingValue.held`). */
function markHeld(values: RepoValues, trust: RepoTrust | undefined): RepoValues {
  if (!trust) return values;
  const mark = <T>(v: { value: T; source: string }) => (v.source === 'repository' ? { ...v, held: true as const } : v);
  return {
    ...values,
    app: trust.held.includes('app') ? { ...values.app, stop: mark(values.app.stop), keep: mark(values.app.keep) } : values.app,
    demo: trust.held.includes('site') ? { ...values.demo, site: mark(values.demo.site) } : values.demo,
  } as RepoValues;
}

export class Config {
  private restarting = false;
  /** The file as last read, by its time and size: repositories' settings are read from it whenever they are used. */
  private read?: { stamp: string; canvases: CanvasConfig[] };

  constructor(private o: ConfigOptions) {}

  /** The configuration as saved, or as started when nothing is saved yet (or the file no longer reads). */
  current(): CanvasConfig[] {
    if (this.o.source === 'file' && existsSync(this.o.file)) {
      try {
        const { mtimeMs, size } = statSync(this.o.file);
        const stamp = `${mtimeMs}:${size}`;
        if (this.read?.stamp === stamp) return this.read.canvases;
        const canvases = readConfigFile(this.o.file);
        this.read = { stamp, canvases };
        return canvases;
      } catch {}
    }
    return this.o.started;
  }

  /** The settings the owner set for the repository at `path` (absolute) on this machine, as saved now; none where they set none. */
  repoSettings(path: string): RepoSettings | undefined {
    return locate(this.current(), (r) => isAt(r, path))?.r.settings;
  }

  /**
   * The repository's `.obeya/settings.json` changed from `before` to `after`: this machine's values
   * that it now holds, and did not before, were taken over for everyone (here, or by whoever
   * merged the same values), so they go from this machine's settings and come from the
   * repository. Saved without anything following; the caller follows.
   */
  takenOver(path: string, before: SharedSettings | undefined, after: SharedSettings | undefined) {
    if (!after) return;
    // commands the owner set here are theirs in the file too: they need no confirming
    const trusted = trustTakenOver(this.o.store.trustedCommands(path), after, this.repoSettings(path));
    if (trusted) this.o.store.trustCommands(path, trusted);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const changed = this.dropSettings(path, (s) => {
      for (const k of SHARED_FIELDS) {
        if (isNested(k)) {
          const [mine, theirs, was] = [s[k], after[k], before?.[k]] as (Record<string, unknown> | undefined)[];
          for (const f of NESTED_SETTINGS[k]) if (mine?.[f] !== undefined && same(mine[f], theirs?.[f]) && !same(was?.[f], theirs?.[f])) delete mine[f];
        } else if (s[k] !== undefined && same(s[k], after[k]) && !same(before?.[k], after[k])) delete s[k];
      }
    });
    if (changed) console.log(`Obeya: settings of ${path} now come from its ${REPO_SETTINGS_FILE}; removed from this machine's`);
  }

  /**
   * Removes from this machine's settings for the repository at `path` what `drop` deletes from a
   * copy of them, saved without anything following; whether something went.
   */
  private dropSettings(path: string, drop: (s: RepoSettings) => void): boolean {
    if (this.o.source !== 'file' || !existsSync(this.o.file)) return false;
    let changed = false;
    const canvases = this.current().map((c) => ({
      ...c,
      repos: c.repos.map((r) => {
        if (!isAt(r, path) || !r.settings) return r;
        const s: RepoSettings = { ...r.settings };
        for (const k of Object.keys(NESTED_SETTINGS) as NestedSetting[]) if (s[k]) (s as Record<string, unknown>)[k] = { ...s[k] };
        drop(s);
        for (const k of Object.keys(NESTED_SETTINGS) as NestedSetting[]) if (s[k] && !Object.keys(s[k]).length) delete s[k];
        if (JSON.stringify(s) === JSON.stringify(r.settings)) return r;
        changed = true;
        const { settings: _, ...rest } = r;
        return Object.keys(s).length ? { ...rest, settings: s } : rest;
      }),
    }));
    if (!changed) return false;
    writeFileSync(this.o.file, `${JSON.stringify(canvases, null, 2)}\n`);
    this.read = undefined;
    return true;
  }

  /**
   * A value for a repository's setting that the work retrospective proposed, taken by the owner for
   * the repository at `path` (absolute): on this machine, or into its `.obeya/settings.json` for
   * everyone, the way "Take over into the repository for everyone" goes, with this value alone. Committed
   * on the main branch, this machine's own value for it goes, so the repository's applies here
   * too; as a pull request, it is set on this machine as well until the pull request is merged
   * (`takenOver` then removes it). Says where it went for everyone; nothing for this machine.
   */
  async takeSetting(path: string, field: ProposedSetting, value: string | string[], where: 'machine' | 'repository'): Promise<SettingsShared | null> {
    const canvases = this.current();
    const at = locate(canvases, (r) => isAt(r, path));
    if (!at) throw new BadRequest('invalid', `no repository ${path} in the configuration`);
    const patch = settingPatch(field, value);
    // on the configuration as it is then: a pull request opened meanwhile may have taken a while
    const onMachine = () => {
      const now = this.current();
      const here = locate(now, (r) => isAt(r, path)) ?? at;
      return this.save(now.map((c, i) => (i !== here.canvas ? c : { ...c, repos: c.repos.map((r, j) => (j !== here.repo ? r : { ...r, settings: layerSettings(r.settings, patch) })) })));
    };
    if (where === 'machine') {
      await onMachine();
      return null;
    }
    const to = (await this.landing(canvases, at))?.shareTo ?? 'main';
    const done = await this.share(path, patch, to, field);
    if ('pr' in done) {
      await onMachine();
      return done;
    }
    // where this machine set another value, the repository's applies here as well from now on
    this.dropSettings(path, (s) => {
      if (field === 'run') delete s.app?.run;
      else delete s[field];
    });
    this.o.onSettings?.();
    return done;
  }

  /**
   * "Take over into the repository for everyone": the settings saved for the repository at `path` (as the
   * configuration names it) on this machine, but its main branch, go into its
   * `.obeya/settings.json`: committed on the main branch where work lands there (they then come
   * from the repository, here too), else as a pull request (once it is merged), or with `direct`,
   * where work may also go straight to main, pushed onto `origin`'s main branch.
   */
  async shareSettings(input: unknown): Promise<SettingsShared> {
    const parsed = z.object({ path: z.string(), direct: z.boolean().optional() }).safeParse(input);
    if (!parsed.success) throw new BadRequest('invalid', 'expected { path, direct? }');
    const canvases = this.current();
    const at = locate(canvases, (r) => r.path === parsed.data.path);
    if (!at) throw new BadRequest('noSettings', `no repository ${parsed.data.path} in the configuration`);
    const { branch: _, ...mine } = at.r.settings ?? {};
    if (!Object.keys(mine).length) throw new BadRequest('noSettings', `${at.r.path}: nothing set on this machine to take over`);
    const repoPath = resolve(expandHome(at.r.path));
    const landing = await this.landing(canvases, at);
    const to = landing?.shareTo ?? 'main';
    if (to === 'pr' && parsed.data.direct) {
      if (!landing?.shareDirect) throw new BadRequest('noDirect', `${repoPath}: work goes to main only through pull requests`);
      const { after, ...done } = await pushShared(repoPath, mine);
      console.log(`Obeya: settings of ${repoPath} for everyone, ${sharedHow(done, true)}`);
      // origin's had them already: only what the main branch Obeya reads has goes (the local one may be ahead of origin's)
      this.takenOver(repoPath, undefined, 'unchanged' in done ? (await readShared(repoPath)).settings : after);
      this.o.onSettings?.();
      return done;
    }
    const done = await this.share(repoPath, mine, to, 'settings');
    if (!('pr' in done)) this.o.onSettings?.();
    return done;
  }

  /** The repository `at` of the configuration as it resolves: where its work lands, so where settings for everyone go. */
  private async landing(canvases: CanvasConfig[], at: { canvas: number; repo: number }) {
    return (await this.check(canvases)).resolved[at.canvas]?.repos[at.repo];
  }

  /**
   * `patch` goes into the `.obeya/settings.json` of the repository at `path` for everyone: as a pull
   * request, or committed on the main branch, after which all of it comes from the repository, here
   * too; where the file there holds it already, neither, and it comes from the repository at once.
   * The caller follows.
   */
  private async share(path: string, patch: SharedSettings, to: 'main' | 'pr', what: string): Promise<SettingsShared> {
    if (to === 'pr') {
      if (!this.o.forge) throw new BadRequest('settingsShare', 'no forge to open a pull request with');
      const done = await proposeShared(path, patch, this.o.forge);
      console.log(`Obeya: ${what} of ${path} for everyone, ${sharedHow(done, true)}`);
      if ('pr' in done) return done;
      // only what the main branch Obeya reads has: the local one may be ahead of origin's
      this.takenOver(path, undefined, (await readShared(path)).settings);
      return done;
    }
    const { before: _, after, ...done } = await commitShared(path, patch);
    console.log(`Obeya: ${what} of ${path} for everyone, ${sharedHow(done, false)}`);
    // all of it is in the file now, also what it held already
    this.takenOver(path, undefined, after);
    return done;
  }

  /**
   * The owner confirmed the commands of the repository at `path` (as the configuration names it,
   * saved or still in the dialog's draft, a new canvas's say) that the dialog showed them: the
   * groups `held` of `seen` (`RepoTrust`), which count from now on, as long as its default branch
   * has them so. Commands that changed there since are refused (`trustChanged`).
   */
  async trust(input: unknown) {
    const parsed = z.object({ path: z.string().min(1), seen: z.unknown(), held: z.array(z.enum(['app', 'site', 'claude'])) }).safeParse(input);
    if (!parsed.success) throw new BadRequest('invalid', 'expected { path, seen, held }');
    const repoPath = resolve(expandHome(parsed.data.path));
    if (!existsSync(repoPath)) throw new BadRequest('invalid', `no repository at ${parsed.data.path}`);
    const now = commandsOf(await readShared(repoPath));
    if (canonical(now) !== canonical(parsed.data.seen)) throw new BadRequest('trustChanged', `${repoPath}: its commands changed on the default branch since they were shown`);
    // only the groups the dialog showed: one this machine's values (saved or in the draft) stand in for it did not
    this.o.store.trustCommands(repoPath, trustHeld(this.o.store.trustedCommands(repoPath), now, parsed.data.held.filter((g) => now[g] !== undefined)));
    console.log(`Obeya: the owner confirmed the commands of ${repoPath}`);
    this.o.onSettings?.();
  }

  /** The configuration as saved, at once: what it amounts to and what is wrong with it come from `check`, which takes longer. */
  view(): ConfigView {
    return {
      file: this.o.file,
      source: this.o.source,
      canvases: this.current(),
      running: this.o.running(),
      server: { commit: null, ...this.o.server, version: VERSION, restarts: !!this.o.restart },
      restarting: this.restarting,
    };
  }

  /** The check of the configuration as saved while one runs: a page that loads and the dialog opening at the same time share it. */
  private checking?: { canvases: CanvasConfig[]; done: Promise<ConfigChecked> };

  /** `check` of the configuration as saved. */
  checkSaved(): Promise<ConfigChecked> {
    const canvases = this.current();
    if (this.checking?.canvases !== canvases) {
      const done = this.check(canvases).finally(() => {
        if (this.checking?.done === done) this.checking = undefined;
      });
      this.checking = { canvases, done };
    }
    return this.checking.done;
  }

  /**
   * Checks a configuration without saving it: every canvas resolves, and no two share an id. What
   * it reads of the repositories with git it reads once for each, all of them at once, without
   * blocking the server meanwhile.
   */
  async check(input: unknown): Promise<ConfigChecked> {
    // a draft the dialog kept from before may hold a site's language (the dialog never sends a share command)
    const parsed = configShape.safeParse(withoutGone(input, false));
    if (!parsed.success) return { canvases: [], resolved: [], problems: [{ code: 'invalid', detail: z.prettifyError(parsed.error) }] };
    const canvases = tidy(parsed.data);
    const expanded = expandConfig(canvases);
    const repos = expanded.flatMap((c) => c.repos);
    const branches = repos.flatMap((r) => (r.path && r.settings?.branch && existsSync(r.path) ? [{ path: resolve(r.path), branch: r.settings.branch }] : []));
    const [reads, found] = await Promise.all([
      readRepos(repos),
      Promise.all(branches.map(async (b) => [`${b.path}\0${b.branch}`, await hasBranch(b.path, b.branch)] as const)).then((x) => new Map(x)),
    ]);
    // a workspace needs only to be a git repository
    const isRepo = (path: string) => !!reads.workspaces.get(path);
    /** The `origin` of a workspace that is a git repository. */
    const originOf = (path: string) => reads.workspaces.get(path)?.origin ?? null;
    const read = (path: string) => reads.repos.get(path)?.read ?? null;
    const problems: ConfigProblem[] = [];
    if (!canvases.length) problems.push({ code: 'noCanvas', detail: 'Obeya needs at least one canvas' });
    // a host's name stands for one machine across the configuration: its workspaces are named by it
    const machines = new Map<string, string>();
    const resolved = expanded.map((c, canvas): ResolvedCanvas | null => {
      c.repos.forEach((r, repo) =>
        (r.workspaces ?? []).forEach((w) => {
          if (!isRepo(resolve(w))) {
            problems.push({ code: 'notClone', canvas, repo, detail: `workspace ${w} is not a git repository` });
            return;
          }
          // the repository itself, or a clone of it: its origin is the repository's, or the repository (as `Workspaces.register` has it)
          const own = read(resolve(r.path))?.info;
          const origins = [own?.remote, own?.path].filter((x): x is string => !!x);
          const origin = originOf(resolve(w)) ?? '';
          if (own && !own.folder && resolve(w) !== own.path && !origins.some((o) => sameRemote(o, origin)))
            problems.push({ code: 'otherClone', canvas, repo, detail: `${w} is not a clone of ${origins.join(' or ')} (its origin is ${origin || 'unset'})` });
        }),
      );
      c.repos.forEach((r, repo) => {
        const branch = r.settings?.branch;
        if (branch && found.get(`${resolve(r.path)}\0${branch}`) === false) problems.push({ code: 'noBranch', canvas, repo, detail: `${r.path} has no branch ${branch}, neither here nor on origin` });
      });
      c.repos.forEach((r, repo) =>
        (r.hosts ?? []).forEach((h) => {
          const other = machines.get(h.name);
          if (other !== undefined && other !== h.ssh) problems.push({ code: 'hostName', canvas, repo, detail: `host ${h.name} connects to ${other} elsewhere, here to ${h.ssh}` });
          machines.set(h.name, h.ssh);
        }),
      );
      try {
        const { id, name, repos } = resolveCanvas(c, this.o.store, undefined, undefined, read);
        // the repositories in the order given, though the home one runs first
        const given = c.repos.map((r) => repos.find((x) => x.config === r)!);
        // the commands each repository holds until the owner confirms them, read once
        const trusts = given.map(({ config: r, read: got }) => trustOf(got.info.path, got.shared, r.settings, this.o.store));
        // what is wrong in a repository's settings for everyone is fixed there, not here: it keeps nothing from being saved
        c.repos.forEach((r, repo) => {
          const { adapter, read: got } = given[repo]!;
          if (got.adapterModule)
            problems.push({ code: 'adapterGone', canvas, repo, detail: `${REPO_ADAPTER_DIR}/ on the main branch is no longer read; what it says belongs in ${REPO_SETTINGS_FILE}` });
          if (r.hosts?.length) {
            const why = adapter.land === 'main' ? 'its work lands on the main of this checkout' : !got.info.remote ? 'it has no remote to clone from' : null;
            if (why) problems.push({ code: 'hostRepo', canvas, repo, detail: `the repository cannot have workers on other machines: ${why}` });
          }
          const site = adapter.demo?.site;
          const wrong = site && siteProblem(site, resolve(r.path));
          if (wrong) problems.push({ code: 'demoSite', canvas, repo, detail: wrong });
          for (const detail of got.shared.problems) problems.push({ code: 'repoSettings', canvas, repo, detail });
          const trust = trusts[repo];
          if (trust)
            problems.push({ code: 'untrusted', canvas, repo, detail: `held until the owner confirms them: ${trust.held.flatMap((g) => commandLines(trust.now, g)).join('; ')}` });
        });
        return {
          id,
          name,
          repos: given.map(({ config: r, ref, adapter, read: got, values }, repo) => {
            const trust = trusts[repo];
            const leaving = got.info.folder ? [] : this.leaving(id, ref.id === repos[0]!.ref.id ? null : ref.id, r, adapter.workspaces);
            return {
            id: ref.id,
            workspaces: adapter.workspaces,
            ...(got.info.folder ? { folder: true as const } : {}),
            ...(got.adapterModule ? { adapterGone: true } : {}),
            values: markHeld(values(), trust),
            ...(trust ? { trust } : {}),
            shareTo: adapter.land === 'main' ? 'main' : 'pr',
            ...(adapter.land === 'pr' && adapter.direct ? { shareDirect: true } : {}),
            ...(leaving.length ? { leaving } : {}),
            };
          }),
        };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        problems.push({ code: e.code, canvas, ...(e.repo !== undefined ? { repo: e.repo } : {}), detail: e.message });
        return null;
      }
    });
    const failures = this.o.failures?.() ?? [];
    resolved.forEach((r, canvas) => {
      const first = resolved.findIndex((x) => x?.id === r?.id);
      if (r && first !== canvas) problems.push({ code: 'sameId', canvas, detail: `canvas ${canvas + 1} has the id "${r.id}" of canvas ${first + 1}; give it another name` });
      // what does not run as it is configured, by the canvases and repositories it resolves to
      for (const f of failures.filter((f) => f.canvas === r?.id)) {
        if (f.repo === undefined) {
          problems.push({ code: 'canvasDown', canvas, detail: f.detail });
          continue;
        }
        const repo = r!.repos.findIndex((x) => x.id === f.repo);
        if (repo >= 0) problems.push({ code: f.before ? 'repoBefore' : 'repoDown', canvas, repo, detail: f.detail });
      }
    });
    return { canvases, resolved, problems };
  }

  /** The clones of a repository's pool (`repo` null: the canvas's home repository) that the configuration `r` no longer names. */
  private leaving(canvas: string, repo: string | null, r: CanvasConfig['repos'][number], mode: 'clones' | 'worktrees') {
    const rows = this.o.store.workspaces(canvas, repo);
    if (!rows.length) return [];
    const dir = join(this.o.server.home, 'workspaces', canvas, ...(repo ? [repo] : []));
    const hosts = (r.hosts ?? []).map((h) => ({ name: h.name, clones: h.clones }));
    return leavingClones(rows, { dir, mode, listed: (r.workspaces ?? []).map((w) => resolve(w)), clones: r.clones ?? 0, hosts }).map((c) => {
      const title = c.card ? (this.o.store.card(c.card)?.title ?? undefined) : undefined;
      const { card: _, ...rest } = c;
      return { ...rest, ...(title !== undefined ? { card: title } : {}) };
    });
  }

  /**
   * Obeya's home, whose `settings.json` holds the owner's own settings (settings.ts): the language,
   * light or dark, the agents' models.
   */
  get home(): string {
    return this.o.server.home;
  }

  /** The running canvases take `canvases` over, each by the id it resolved to. */
  private async applyNow(canvases: CanvasConfig[], resolved: (ResolvedCanvas | null)[]) {
    await this.o.apply?.(expandConfig(canvases), resolved.map((r) => r?.id ?? null));
  }

  /**
   * "Try again": the running canvases take the saved configuration over again, as after a
   * save, so what did not start as it has them tries again.
   */
  async retry(): Promise<{}> {
    if (!this.o.apply) throw new BadRequest('config', 'this Obeya does not apply its configuration while it runs');
    const { canvases, resolved } = await this.check(this.current());
    await this.applyNow(canvases, resolved);
    return {};
  }

  /**
   * Saves a configuration that works, and the running canvases take it over (design: Live
   * configuration). Where they came from the command line, Obeya starts again with it where
   * something restarts it.
   */
  async save(input: unknown): Promise<ConfigSaved> {
    const { canvases, resolved, problems: all } = await this.check(input);
    const problems = all.filter(blocksSaving);
    if (problems.length) throw new BadRequest('config', problems.map((p) => p.detail).join('; '));
    mkdirSync(dirname(this.o.file), { recursive: true });
    writeFileSync(this.o.file, `${JSON.stringify(canvases, null, 2)}\n`);
    this.read = undefined;
    if (this.o.source === 'file' && !this.restarting && this.o.apply) {
      console.log(`Obeya: configuration saved to ${this.o.file}; it applies at once`);
      // settles once the canvases took it over, git read without the server waiting
      await this.applyNow(canvases, resolved);
      return { restarting: false, applied: true };
    }
    console.log(`Obeya: configuration saved to ${this.o.file}`);
    if (this.o.restart && !this.restarting) {
      this.restarting = true;
      this.o.restart();
    }
    return { restarting: this.restarting };
  }
}
