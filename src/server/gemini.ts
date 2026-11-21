// Agents on Gemini: the machine's own Antigravity CLI (`agy`) and its Google login, driven through
// `agy acp`, the Agent Client Protocol over stdio (acp.ts), one process per session, behind the same
// interface as Claude Code's and Codex's (`AgentRuntime`, runtime.ts). The menus offer Gemini's own
// families (Neon, Argon, Hydrogen, Flash), each resolved to its newest model as the session starts,
// as Codex's are; Antigravity's Claude and GPT models are left out, since they only repeat what the
// other harnesses run directly.
//
// Every session runs agy with a Gemini directory of Obeya's own (`--gemini-dir <OBEYA_HOME>/gemini`):
// the login stays the owner's (agy keeps it in the system's keyring), the owner's global rules,
// skills and MCP servers are carried over into it, and what Obeya needs agy to do goes there without
// touching the owner's configuration. There: Obeya's hook (`hooks.json`), which agy runs before and
// after every tool call and which posts the call to the session's own server on the loopback (the URL
// with its token in `OBEYA_GEMINI_HOOK`, set for that agy process alone); the sandbox's grants
// (`projects/default-cli-project.json`), which make readable the global git configuration and the
// files it includes, and writable the git directory a worktree commits into, the agent's extra
// directories and the temporary directory, for every session that runs; and the skills of Obeya's
// plugin (`skills.json`).
//
// Agents run in agy's auto mode: commands run in its terminal sandbox, and what would leave it agy's
// own reviewer allows or refuses; what the reviewer leaves to a person becomes the question the card
// waits on (`AgentSpec.askOwner`). Read-only agents run in agy's default mode, and the hook refuses
// them every tool that does more than read. Obeya's tools reach the session as an MCP server over
// HTTP, given anew with each start and resume. A message during a turn steers it.
//
// On another machine the session runs there over SSH, on that host's own agy login, with Obeya's
// Gemini directory there (written over the connection), its hook and Obeya's tools reaching their
// servers here through forwarded ports.

import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { messageOf } from '../core/text';
import { within } from '../core/late';
import type { UsageLimit } from '../core/types';
import { AGENT_EFFORTS, type AgentEffort, GEMINI_MODEL, GEMINI_PRESET, type HarnessModel, familyName, modelFamily, newestOfFamilies } from '../core/agents';
import { AcpConnection, AcpError, type AcpModel, type AcpProcess, type AcpPermissionOption, type AcpSessionOpened, type AcpToolCall, type AcpUsage, McpToolServer, pickPermission, promptOf } from './acp';
import { nearestEffort, startArgv, spawnOptions } from './codex';
import type { ToolCall } from './folder';
import { HostError, LOST, remote, sessionFiles, sh, type SshHost } from './hosts';
import { which } from './path';
import { geminiCost, type GeminiTokens } from './prices';
import { type AgentEvent, type AgentRuntime, type AgentSession, type AgentSpec, carryTo, cleanEnv, GEMINI_SESSION, lostEvent, stderrTail, withStderr } from './runtime';
import { BOUNDED_WAITS, FOREGROUND_SLEEP_LIMIT, foregroundSleep, waitRefusal } from './shell';
import { failureText, spawnOutput } from './spawn';
import type { PlanLimits, UsageSource } from './usage';

type Env = Record<string, string | undefined>;

/** Whether a file or directory is there. */
const exists = (path: string) => stat(path).then(() => true, () => false);

/** The Antigravity CLI the agents run on: the one `OBEYA_AGY` names, else `agy` on the PATH or where its installer puts it; null where there is none. */
export async function geminiExecutable(env: Env = process.env): Promise<string | null> {
  if (env.OBEYA_AGY) return env.OBEYA_AGY;
  const found = which('agy', env);
  if (found) return found;
  // the installer's directory, which a shell started before the installation has not on its PATH yet
  const home = env.HOME || env.USERPROFILE;
  const installed = home && join(home, '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  return installed && (await exists(installed)) ? installed : null;
}

/** What the CLI said (stdout, then stderr) and its exit code; null where it could not start or took too long. */
async function runAgy(bin: string, args: string[], env: Env, ms = 20_000, cwd?: string): Promise<{ code: number | null; out: string } | null> {
  const argv = startArgv(bin, args);
  const r = await within(spawnOutput(argv, { env, timeout: ms, killSignal: 'SIGKILL', ...(cwd ? { cwd } : {}), ...spawnOptions(argv) }).catch(() => null), ms);
  return r ? { code: r.code, out: `${r.stdout}${r.stderr}`.trim() } : null;
}

/** The CLI's version (`1.5.13`), or null where it does not answer. */
export async function geminiVersion(bin: string, env: Env): Promise<string | null> {
  const r = await runAgy(bin, ['--version'], env);
  return r?.code === 0 ? (r.out.match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null) : null;
}

/** Whether a message says agy is not logged in, as agy words it ("Authentication required", "authentication required", "Authentication expired"). */
export function geminiLoginFailed(message: string): boolean {
  return /\bauthentication (?:required|expired)\b|\bnot (?:logged|signed) in\b|\bagy acp --login\b/i.test(message);
}

/** A failure for agy's missing login on `host` (null: this machine), as `geminiLoginLost` reads it on the card. */
export const notLoggedIn = (host: string | null, message: string) => `Gemini is not logged in on ${host ?? 'this machine'}. (${message})`;

/** What `agy -p /quota --output-format json` reports; only what Obeya reads of it. */
interface QuotaReport {
  status?: string;
  error?: string;
  command?: { data?: { groups?: QuotaGroup[] } };
}
interface QuotaGroup {
  name: string;
  description?: string;
  buckets?: QuotaBucket[];
}
interface QuotaBucket {
  id: string;
  name?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}

/**
 * When a window starts anew (milliseconds), where it has begun. A window starts with its first use,
 * so one untouched (all of it left) has no reset yet: agy then reports the time of asking plus the
 * window's length, which moves with every look, or the epoch.
 */
function resetOf(b: QuotaBucket): number | undefined {
  if ((b.remaining_fraction ?? 1) >= 1 || !b.reset_time) return undefined;
  const at = Date.parse(b.reset_time);
  return at > 0 ? at : undefined;
}

/**
 * Asks agy for the login's quota, which starts no turn and uses none of it: the report, `apiKey`
 * where the login is an API key (which has no quota: agy exits with 2), or why it failed.
 */
async function quota(bin: string, env: Env): Promise<Quota> {
  // from a directory of its own: a print run in a repository would read the repository's settings
  return quotaOf(await runAgy(bin, ['-p', '/quota', '--output-format', 'json'], env, 20_000, tmpdir()));
}

/** What agy answered to `/quota`: the login's quota, `apiKey` for an API key's none, or why it failed. */
type Quota = { report: QuotaReport } | { apiKey: true } | { failed: string };

/** `/quota`'s answer read: its exit code and what it said; null where agy did not answer. */
function quotaOf(r: { code: number | null; out: string } | null): Quota {
  if (!r) return { failed: 'agy did not answer' };
  if (r.code === 2) return { apiKey: true };
  const json = r.out.slice(r.out.indexOf('{'));
  try {
    const report = JSON.parse(json) as QuotaReport;
    if (r.code === 0 && report.status === 'SUCCESS') return { report };
    return { failed: report.error || r.out };
  } catch {
    return { failed: r.out || `agy exited with code ${r.code}` };
  }
}

/** Whether agy is logged in, by its answer to `/quota`: an account's quota, or an API key's none. */
export async function geminiLogin(bin: string, env: Env): Promise<{ loggedIn: boolean; how?: string }> {
  const q = await quota(bin, env);
  if ('apiKey' in q) return { loggedIn: true, how: 'API key' };
  if ('report' in q) return { loggedIn: true, how: 'Google' };
  return { loggedIn: false };
}

/** The share of a window used up, as a meter shows it (agy reports what remains). */
const usedPercent = (remaining: number | undefined) => Math.round((1 - Math.min(1, Math.max(0, remaining ?? 1))) * 1000) / 10;

/** The grade of a window, which agy does not give: used up, close to it, or normal. */
const severity = (percent: number) => (percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'normal');

/** The group of Gemini's own models in agy's quota report, which every model of the menus but Argon counts against. */
const GEMINI_GROUP = /^gemini models$/i;

/**
 * The limits of a quota report: the weekly and the five-hour window of Gemini's models, and the week
 * of a model that has a quota of its own (Argon on a Pro plan) as a scope of its own. The group of
 * Antigravity's Claude and GPT models is left out: no agent of Obeya's runs on them.
 */
export function geminiUsageOf(report: QuotaReport, now = new Date()): PlanLimits | null {
  const groups = (report.command?.data?.groups ?? []).filter((g) => /gemini/i.test(g.name));
  const limits = groups.flatMap((g): UsageLimit[] => {
    const scope = GEMINI_GROUP.test(g.name) ? undefined : g.name;
    return (g.buckets ?? []).map((b) => {
      const session = b.window === '5h';
      const percent = usedPercent(b.remaining_fraction);
      const resets = resetOf(b);
      return {
        kind: scope ? 'weekly_scoped' : session ? 'session' : 'weekly_all',
        group: session ? 'session' : 'weekly',
        ...(scope ? { scope } : {}),
        percent,
        ...(resets ? { resetsAt: new Date(resets).toISOString() } : {}),
        windowMinutes: session ? 300 : 10_080,
        severity: severity(percent),
      };
    });
  });
  return limits.length ? { limits, at: now.toISOString() } : null;
}

/**
 * When the quota a turn on `model` ran into lifts (milliseconds): the earliest reset of a window used
 * up among those the model counts against (its own group, else Gemini's), else the earliest of those
 * begun.
 */
export function quotaResets(report: QuotaReport, model: string): number | undefined {
  const groups = report.command?.data?.groups ?? [];
  const name = familyName(modelFamily(model)).toLowerCase();
  const own = groups.filter((g) => !GEMINI_GROUP.test(g.name) && g.name.toLowerCase().includes(name));
  const counted = [...own, ...groups.filter((g) => GEMINI_GROUP.test(g.name))];
  const windows = counted.flatMap((g) => g.buckets ?? []).filter((b) => resetOf(b) !== undefined);
  const full = windows.filter((b) => (b.remaining_fraction ?? 1) <= 0);
  const at = (full.length ? full : windows).map((b) => resetOf(b)!);
  return at.length ? Math.min(...at) : undefined;
}

/** The quota of the login on this machine, for the bar: agy asked as it is when the bar asks (`/quota`, no turn). Null for an API key's, which has none. */
export function geminiUsage(): UsageSource {
  return {
    fetch: async () => {
      const bin = await geminiExecutable();
      if (!bin) throw new Error(NOT_INSTALLED);
      const q = await quota(bin, cleanEnv());
      if ('apiKey' in q) return null;
      if ('failed' in q) throw new Error(q.failed);
      return geminiUsageOf(q.report);
    },
    close: () => {},
  };
}

/** `/quota` asked of agy on a host, over its connection, from a directory of its own there (as here). Fails where the host does not answer. */
export async function geminiQuotaOn(host: SshHost): Promise<Quota> {
  const r = await host.run('cd "${TMPDIR:-/tmp}" && exec agy -p /quota --output-format json 2>&1', { timeout: 30_000 });
  if (r.code === LOST) throw new HostError(`${host.name} does not answer`);
  return quotaOf({ code: r.code, out: `${r.stdout}${r.stderr}`.trim() });
}

/**
 * agy on a host, asked over its connection: its version and whether it is logged in there (its own
 * login, by its answer to `/quota`, as here); null where it is not installed there. Each such look
 * is a run of agy as a command there, which has it look for a newer version of itself. Fails where
 * the host does not answer.
 */
export async function geminiOn(host: SshHost): Promise<{ version: string; loggedIn: boolean; how?: string } | null> {
  const r = await host.run('v=$(agy --version 2>/dev/null) || exit 3; printf \'%s\\n\' "$v"', { timeout: 30_000 });
  if (r.code === 3) return null;
  if (r.code !== 0) throw new HostError(`${host.name}: ${failureText(r)}`);
  const version = r.stdout.match(/(\d+\.\d+\.\d+\S*)/)?.[1];
  if (!version) return null;
  const q = await geminiQuotaOn(host);
  return { version, loggedIn: !('failed' in q), ...('apiKey' in q ? { how: 'API key' } : 'report' in q ? { how: 'Google' } : {}) };
}

/** What a start fails with where agy is not on this machine. */
const NOT_INSTALLED = 'Gemini (the Antigravity CLI) is not installed on this machine';

/** The efforts agy takes, by the suffix of its model ids (`gemini-4-neon-xhigh`). */
const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;

/**
 * Gemini's own models in a list of agy's (`agy models`, a session's `availableModels`), one per model
 * with the efforts it takes: `gemini-4-neon-high` and `gemini-4-neon-low` are `gemini-4-neon`, taking
 * high and low. Models of other makers and agy's orchestrators (no version, no effort) are left out.
 */
export function geminiModelsOf(listed: AcpModel[]): HarnessModel[] {
  const models = new Map<string, HarnessModel & { efforts: AgentEffort[] }>();
  for (const m of listed) {
    const effort = EFFORT_SUFFIX.exec(m.modelId)?.[1] as AgentEffort | undefined;
    const id = effort ? m.modelId.slice(0, -effort.length - 1) : m.modelId;
    if (!effort || !GEMINI_MODEL.test(id) || !/\d/.test(id)) continue;
    const name = m.name?.replace(/\s*\([^)]*\)\s*$/, '');
    const model = models.get(id) ?? { id, ...(name ? { name } : {}), efforts: [] };
    if (!model.efforts.includes(effort)) model.efforts.push(effort);
    models.set(id, model);
  }
  return [...models.values()].map((m) => ({ ...m, efforts: AGENT_EFFORTS.filter((e) => m.efforts.includes(e)) }));
}

/** The models agy offers the login on this machine (`agy models`, a line per model and effort: its id, a tab, its name). */
export async function geminiModels(env: Env = process.env): Promise<HarnessModel[]> {
  const bin = await geminiExecutable(env);
  if (!bin) throw new Error(NOT_INSTALLED);
  const r = await runAgy(bin, ['models'], cleanEnv(env), 30_000, tmpdir());
  if (!r || r.code !== 0) throw new Error(r?.out || 'agy did not list its models');
  const listed = r.out.split('\n').flatMap((line) => {
    const [modelId, name] = line.split('\t');
    return modelId && name ? [{ modelId: modelId.trim(), name: name.trim() }] : [];
  });
  return geminiModelsOf(listed);
}

/**
 * The model a family runs on in a session's catalog: the newest of the family; none where the
 * catalog has none of it (the session then does not start, rather than leave the model to agy's own
 * settings).
 */
export function resolveGeminiModel(models: HarnessModel[], family: string): HarnessModel | undefined {
  const key = modelFamily(family);
  return newestOfFamilies(models).find((m) => modelFamily(m.id) === key);
}

/** Why a command that waits too long in the foreground is not run, in agy's terms: the agent waits in short commands or snoozes. */
export const WAIT_REFUSED = waitRefusal(
  `Wait in commands that sleep ${FOREGROUND_SLEEP_LIMIT} seconds at most, e.g. \`${BOUNDED_WAITS[0]}\`, and run one again until what you wait for is there. For anything longer, snooze (snooze) and end your turn: Obeya wakes you then.`,
);

/** agy's tools that only read, the ones a read-only agent may call. */
const READS = /^(?:view_[a-z_]+|read_file|grep_search|list_dir|find_by_name|codebase_search)$/;

/** Obeya's tools as agy names them (`mcp_<server>_<tool>`). */
const OBEYA_TOOL = /^mcp_obeya_(.+)$/;

/** An agy tool call as Claude Code's would be (the card's log and a folder's watch read them alike): Obeya's tools as `mcp__obeya__…`, a command as `Bash`, a file written as `Write`, edited as `Edit`, read as `Read`. */
export function geminiCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const obeya = OBEYA_TOOL.exec(name);
  // agy adds a summary of its own to every call, which the tool never gets
  if (obeya) {
    const { toolSummary: _, ...input } = args;
    return { id, name: `mcp__obeya__${obeya[1]}`, input };
  }
  switch (name) {
    case 'run_command':
      return { id, name: 'Bash', input: { command: str(args.CommandLine) } };
    case 'write_file':
    case 'write_to_file':
      return { id, name: 'Write', input: { file_path: str(args.Path ?? args.TargetFile) } };
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return { id, name: 'Edit', input: { file_path: str(args.Path ?? args.TargetFile) } };
    case 'view_file':
    case 'read_file':
      return { id, name: 'Read', input: { file_path: str(args.AbsolutePath ?? args.Path) } };
    case 'grep_search':
      return { id, name: 'Grep', input: { pattern: str(args.Query ?? args.Pattern) } };
    case 'list_dir':
    case 'find_by_name':
      return { id, name: 'Glob', input: { pattern: str(args.DirectoryPath ?? args.Pattern ?? args.SearchDirectory) } };
    case 'search_web':
      return { id, name: 'WebSearch', input: { query: str(args.query ?? args.Query) } };
    case 'read_url_content':
      return { id, name: 'WebFetch', input: { url: str(args.Url ?? args.url) } };
    default:
      return { id, name, input: args };
  }
}

/** Where agy keeps a workspace's own customizations: hooks, MCP servers, plugins among them, which run outside any check. */
const CUSTOMIZATION_ROOTS = ['.agents', '.agent', '_agents', '_agent'];

/** Whether `cwd` has agy customizations that would run something of the repository's (hooks, MCP servers, plugins): the first found. */
async function runsOwn(cwd: string): Promise<string | undefined> {
  for (const root of CUSTOMIZATION_ROOTS) {
    for (const what of ['hooks.json', 'mcp_config.json', 'plugins']) if (await exists(join(cwd, root, what))) return `${root}/${what}`;
  }
  return undefined;
}

/** The repository's own instructions agy reads itself, in a workspace and the directories up to its repository's root. */
const AGY_RULES = ['AGENTS.md', 'GEMINI.md'];

/**
 * The repository's CLAUDE.md, for a workspace that has no instructions agy reads (AGENTS.md,
 * GEMINI.md) between it and its repository's root: agy reads only those, as Codex reads CLAUDE.md
 * only as a fallback name.
 */
async function claudeNotes(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    for (const f of AGY_RULES) if (await exists(join(dir, f))) return undefined;
    if ((await exists(join(dir, '.git'))) || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  const text = await readFile(join(cwd, 'CLAUDE.md'), 'utf8').catch(() => '');
  return text.trim() || undefined;
}

/** The global git configuration and the files it includes, as git would read them for `cwd`: what the sandbox has to let commands read. */
async function gitConfigFiles(cwd: string): Promise<string[]> {
  const files = new Set<string>();
  const home = homedir();
  for (const f of [join(home, '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config')]) if (await exists(f)) files.add(f);
  try {
    const p = Bun.spawn(['git', 'config', '--global', '--includes', '--list', '--show-origin', '--name-only'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    for (const line of (await new Response(p.stdout).text()).split('\n')) {
      const origin = /^file:(.+?)\t/.exec(line)?.[1];
      if (origin) files.add(origin);
    }
    await p.exited;
  } catch {}
  // an include that git could not read (the sandbox's very case) names no origin: read the paths themselves
  for (const f of [...files]) {
    const text = await readFile(f, 'utf8').catch(() => '');
    for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
      const p = m[1]!.replace(/^"(.*)"$/, '$1').replace(/^~(?=\/|$)/, home);
      files.add(isAbsolute(p) ? p : join(dirname(f), p));
    }
  }
  return [...files];
}

/** The git directory a worktree commits into, outside the worktree itself; nothing for a clone. */
async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0) return undefined;
    return out && !out.startsWith(resolve(cwd)) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** What one session needs the sandbox to grant: files to read, directories to write. */
interface Grants {
  read: string[];
  write: string[];
}

/**
 * The path with the links in it resolved, as far as it exists (the rest as given): agy matches a
 * grant against the real path of what a tool touches, so a grant of `/tmp/x` lets nothing into
 * `/private/tmp/x`, which is what `/tmp/x` is on macOS (measured 2026-11-21).
 */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPath(parent), basename(path));
  }
}

/** `grants` with each path also as its real path (`realPath`), where that differs. */
async function withRealPaths(grants: Grants): Promise<Grants> {
  const both = async (paths: string[]) => [...new Set((await Promise.all(paths.map(async (p) => [p, await realPath(p)]))).flat())];
  return { read: await both(grants.read), write: await both(grants.write) };
}

/**
 * `withRealPaths` for paths on a host, resolved there (a path that does not exist there stays as
 * given): with `realpath` or GNU's `readlink -f`, else (an older macOS) by the shell, a directory
 * whole and a file by its directory.
 */
async function realPathsThere(host: SshHost, grants: Grants): Promise<Grants> {
  const all = [...new Set([...grants.read, ...grants.write])];
  const r = await host.run(`for p in ${all.map(sh).join(' ')}; do r=$(realpath "$p" 2>/dev/null || readlink -f "$p" 2>/dev/null || { [ -d "$p" ] && cd "$p" 2>/dev/null && pwd -P; } || { [ -e "$p" ] && cd "$(dirname "$p")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$p")"; }) || r=; printf '%s\\t%s\\n' "$p" "$r"; done`);
  if (r.code === LOST) throw new HostError(`${host.name} does not answer`);
  const real = new Map(r.stdout.split('\n').flatMap((l) => {
    const [p, to] = l.split('\t');
    return p && to ? [[p, to] as const] : [];
  }));
  const both = (paths: string[]) => [...new Set(paths.flatMap((p) => [p, real.get(p) ?? p]))];
  return { read: both(grants.read), write: both(grants.write) };
}

/**
 * Obeya's own Gemini directory (`--gemini-dir`), shared by every session of this Obeya: Obeya's hook,
 * the sandbox's grants of the sessions that run, the skills of their plugins, and what of the owner's
 * own global configuration agy would read (`~/.gemini`: rules, skills, MCP servers), carried over at
 * each start.
 */
export class GeminiDir {
  private grants = new Map<object, Grants>();
  private plugins = new Set<string>();

  constructor(
    readonly dir: string,
    private own = join(homedir(), '.gemini'),
  ) {}

  /** Starts one after the other, so a start never writes an older picture of the grants over a later one's. */
  private writing: Promise<unknown> = Promise.resolve();

  /** Makes it ready for a session that needs `grants` and loads `plugins`; the grants stay until `release`. */
  prepare(key: object, grants: Grants, plugins: string[], windows = process.platform === 'win32'): Promise<void> {
    this.grants.set(key, grants);
    for (const p of plugins) this.plugins.add(p);
    const done = this.writing.then(() => this.write(windows));
    this.writing = done.catch(() => {});
    return done;
  }

  private async write(windows: boolean): Promise<void> {
    const config = join(this.dir, 'config');
    await mkdir(join(config, 'projects'), { recursive: true });
    await writeIfChanged(join(config, 'hooks.json'), `${JSON.stringify(hooksFile(windows), null, 2)}\n`);
    await this.writeGrants();
    const skills: string[] = [];
    for (const d of [...[...this.plugins].map((p) => join(p, 'skills')), join(this.own, 'config', 'skills')]) if (await exists(d)) skills.push(d);
    await writeIfChanged(join(config, 'skills.json'), skillsFile(skills));
    // the owner's own global rules and MCP servers, as agy reads them without Obeya
    await carry(join(this.own, 'GEMINI.md'), join(this.dir, 'GEMINI.md'));
    await carry(join(this.own, 'config', 'mcp_config.json'), join(config, 'mcp_config.json'));
    await linkLogin(join(this.own, LOGIN_FILE), join(this.dir, LOGIN_FILE));
  }

  /** The session no longer runs: its grants go with the next start. */
  release(key: object): void {
    this.grants.delete(key);
  }

  /** The sandbox's grants of every session that runs, as agy reads them for the project its ACP sessions belong to. */
  private async writeGrants() {
    await writeIfChanged(join(this.dir, 'config', 'projects', 'default-cli-project.json'), grantsFile([...this.grants.values()]));
  }
}

/** The project agy's ACP sessions belong to, with the sandbox's grants of every session given. */
function grantsFile(all: Grants[]): string {
  const read = [...new Set(all.flatMap((g) => g.read))].map((p) => `read_file(${p})`);
  const write = [...new Set(all.flatMap((g) => g.write))].map((p) => `write_file(${p})`);
  const project = { id: 'default-cli-project', name: 'CLI Project', projectResources: {}, permissionGrants: { permissionGrants: { allow: [...read, ...write] } } };
  return `${JSON.stringify(project, null, 2)}\n`;
}

/** The skills agy lists beside its own: the directories given. */
const skillsFile = (dirs: string[]) => `${JSON.stringify({ entries: dirs.map((path) => ({ path })) }, null, 2)}\n`;

/**
 * Obeya's Gemini directory on a host (`gemini` in Obeya's directory there), shared by every session
 * of this Obeya on that host as `GeminiDir` is here, and written over the connection at each start:
 * Obeya's hook, the sandbox's grants of the sessions that run there, the skills of their plugins (as
 * copied there) and the host's own, and the global rules and MCP servers of agy's own configuration
 * there (`~/.gemini`).
 */
class HostGeminiDir {
  private grants = new Map<object, Grants>();
  private skills = new Set<string>();
  /** Starts one after the other, so a start never writes an older picture of the grants over a later one's. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private host: SshHost,
    readonly dir: string,
  ) {}

  /** Makes it ready for a session that needs `grants` and lists `skills` (directories there); the grants stay until `release`. */
  prepare(key: object, grants: Grants, skills: string[]): Promise<void> {
    this.grants.set(key, grants);
    for (const d of skills) this.skills.add(d);
    const done = this.writing.then(() => this.write());
    this.writing = done.catch(() => {});
    return done;
  }

  release(key: object): void {
    this.grants.delete(key);
  }

  private async write() {
    const config = `${this.dir}/config`;
    // each file written whole and moved into place, so a session reading it meanwhile sees the old or the new one
    const put = (file: string, text: string) => `printf %s ${sh(text)} > ${sh(`${file}.obeya`)} && mv ${sh(`${file}.obeya`)} ${sh(file)}`;
    // as agy reads them there without Obeya
    const carry = (from: string, to: string) => `if [ -f "$HOME/.gemini/${from}" ]; then cp "$HOME/.gemini/${from}" ${sh(`${to}.obeya`)} && mv ${sh(`${to}.obeya`)} ${sh(to)}; else rm -f ${sh(to)}; fi`;
    const script = [
      // for the owner alone: the MCP servers' configuration may hold their keys
      'umask 077',
      `mkdir -p ${sh(`${config}/projects`)}`,
      put(`${config}/hooks.json`, `${JSON.stringify(hooksFile(false), null, 2)}\n`),
      put(`${config}/projects/default-cli-project.json`, grantsFile([...this.grants.values()])),
      put(`${config}/skills.json`, skillsFile([...this.skills])),
      carry('GEMINI.md', `${this.dir}/GEMINI.md`),
      carry('config/mcp_config.json', `${config}/mcp_config.json`),
      // the host's own login, where agy keeps it as a file (no keyring over SSH), read through a link (see `linkLogin`)
      `if [ -f "$HOME/.gemini/${LOGIN_THERE}" ] && [ "$(readlink ${sh(`${this.dir}/${LOGIN_THERE}`)})" != "$HOME/.gemini/${LOGIN_THERE}" ]; then mkdir -p ${sh(`${this.dir}/antigravity-cli`)} && ln -sfn "$HOME/.gemini/${LOGIN_THERE}" ${sh(`${this.dir}/${LOGIN_THERE}`)}; fi`,
    ].join(' && ');
    const r = await this.host.run(script);
    if (r.code === LOST) throw new HostError(`${this.host.name} does not answer`);
    if (r.code !== 0) throw new Error(`Obeya's Gemini directory on ${this.host.name} could not be written: ${failureText(r)}`);
  }
}

/** `LOGIN_FILE` on a host, which is no Windows machine. */
const LOGIN_THERE = 'antigravity-cli/antigravity-oauth-token';

/** Obeya's Gemini directory on each host, once a session there needed it. */
const hostDirs = new WeakMap<SshHost, HostGeminiDir>();

/** What a session on a host needs to know of the machine and its workspace before it starts, asked in one command (`survey`). */
interface HostSurvey {
  /** The temporary directory there, and the home. */
  tmp: string;
  home: string;
  /** The global git configuration there and the files it includes. */
  git: string[];
  /** The git directory a worktree commits into, outside it. */
  common?: string;
  /** The first of the repository's own agy customizations that would run something, where they wait for the owner. */
  own?: string;
  /** Of the skill directories asked about, and the host's own (`~/.gemini/config/skills`), those that are there. */
  skills: string[];
  /** The repository's CLAUDE.md, where agy reads no instructions of its own there. */
  notes?: string;
}

/** Marks the start of a section of `survey`'s answer. */
const SECTION = '@@obeya-survey:';

/** Asks the host in one command what `HostSurvey` holds, for a session in `cwd` there that lists `skills` (directories there). */
async function survey(host: SshHost, cwd: string, o: { skills: string[]; untrusted: boolean }): Promise<HostSurvey> {
  const section = (name: string) => `printf '%s\\n' ${sh(`${SECTION}${name}`)}`;
  const script = [
    // where demos go there, which the sandbox grants by its real path, so it has to be there
    'mkdir -p "$HOME/demos"',
    section('tmp'),
    'printf \'%s\\n\' "${TMPDIR:-/tmp}"',
    section('home'),
    'printf \'%s\\n\' "$HOME"',
    section('git'),
    'for f in "$HOME/.gitconfig" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config"; do [ -f "$f" ] && printf \'%s\\n\' "$f"; done',
    'git config --global --includes --list --show-origin --name-only 2>/dev/null | sed -n \'s/^file:\\([^\t]*\\)\t.*/\\1/p\'',
    section('common'),
    'git rev-parse --path-format=absolute --git-common-dir 2>/dev/null',
    ...(o.untrusted ? [section('own'), `for r in ${CUSTOMIZATION_ROOTS.join(' ')}; do for w in hooks.json mcp_config.json plugins; do [ -e "$r/$w" ] && printf '%s\\n' "$r/$w"; done; done`] : []),
    section('skills'),
    `for d in ${[...o.skills.map(sh), '"$HOME/.gemini/config/skills"'].join(' ')}; do [ -d "$d" ] && printf '%s\\n' "$d"; done`,
    ...(o.untrusted
      ? []
      : [
          // agy reads AGENTS.md and GEMINI.md between the workspace and its repository's root; without them, CLAUDE.md comes with the instructions
          `d=$(pwd -P); while :; do for f in ${AGY_RULES.join(' ')}; do [ -e "$d/$f" ] && exit 0; done; [ -e "$d/.git" ] || [ "$d" = / ] && break; d=$(dirname "$d"); done`,
          section('notes'),
          'cat CLAUDE.md 2>/dev/null',
        ]),
    'true',
  ].join('\n');
  const r = await host.run(script, { cwd, timeout: 60_000 });
  if (r.code === LOST) throw new HostError(`${host.name} does not answer`);
  if (r.code !== 0) throw new Error(`${host.name}: ${failureText(r)}`);
  const sections = new Map<string, string[]>();
  let at: string[] | undefined;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith(SECTION)) sections.set(line.slice(SECTION.length), (at = []));
    else at?.push(line);
  }
  const lines = (name: string) => (sections.get(name) ?? []).map((l) => l.trim()).filter(Boolean);
  const home = lines('home')[0] ?? '';
  const common = lines('common')[0];
  const notes = (sections.get('notes') ?? []).join('\n').trim();
  return {
    tmp: lines('tmp')[0] || '/tmp',
    home,
    git: [...new Set(lines('git'))],
    ...(common && !common.startsWith(cwd) ? { common } : {}),
    ...(lines('own')[0] ? { own: lines('own')[0] } : {}),
    skills: lines('skills'),
    ...(notes ? { notes } : {}),
  };
}

/**
 * Where agy keeps its login in its Gemini directory where the system has no keyring it reaches (a
 * Linux machine without one, any machine over SSH): a file, which a session on another Gemini
 * directory would not find.
 */
const LOGIN_FILE = join('antigravity-cli', 'antigravity-oauth-token');

/**
 * Obeya's Gemini directory reads the owner's login where agy keeps it as a file: a link to it, through
 * which agy also writes the token it renews, so the two never part. Nothing where the owner's
 * configuration has none (the login is in the keyring); a link that cannot be made leaves it so.
 */
async function linkLogin(own: string, obeya: string) {
  try {
    if (!(await exists(own))) return;
    const st = await lstat(obeya).catch(() => null);
    if (st?.isSymbolicLink() && (await readlink(obeya)) === own) return;
    await mkdir(dirname(obeya), { recursive: true });
    await rm(obeya, { force: true });
    await symlink(own, obeya);
  } catch {}
}

/** Writes `text` to `file` unless it holds it already. */
async function writeIfChanged(file: string, text: string) {
  if ((await readFile(file, 'utf8').catch(() => null)) === text) return;
  // whole, and moved into place: a session reading it meanwhile sees the old or the new file
  await writeFile(`${file}.obeya`, text);
  // Windows refuses replacing a file another process holds open: then in place
  await rename(`${file}.obeya`, file).catch(() => writeFile(file, text));
}

/** A file of the owner's configuration copied to Obeya's directory, or removed there where the owner has none. */
async function carry(from: string, to: string) {
  try {
    if (await exists(from)) await copyFile(from, to);
    else await rm(to, { force: true });
  } catch {}
}

/**
 * Obeya's hook in agy's terms: before and after every tool call, curl posts what agy passes to the
 * session's server (`OBEYA_GEMINI_HOOK`) and prints the answer. A hook that prints nothing leaves the
 * call to agy (an answer of `{}`, or one that fails, would refuse it): without curl, or without the
 * variable (a session agy started itself), the call runs as without the hook.
 */
export function hooksFile(windows: boolean) {
  const command = windows
    ? 'if defined OBEYA_GEMINI_HOOK (curl.exe -sf --noproxy 127.0.0.1 --data-binary @- "%OBEYA_GEMINI_HOOK%" || exit /b 0)'
    : '[ -n "$OBEYA_GEMINI_HOOK" ] && curl -sf --noproxy 127.0.0.1 --data-binary @- "$OBEYA_GEMINI_HOOK" || true';
  const hooks = [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 600 }] }];
  return { obeya: { PreToolUse: hooks, PostToolUse: hooks } };
}

/** What Obeya's hook passes about a tool call; only what Obeya reads of it. */
interface HookCall {
  hookEventName?: string;
  toolCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

/**
 * Where a session's hook posts (`hooksFile`): a server on the loopback that only this session's token
 * opens, answering as agy reads a hook's output. An empty answer leaves the call to agy.
 */
class Hooks {
  private server: ReturnType<typeof Bun.serve>;
  private token = randomBytes(18).toString('base64url');

  constructor(private on: (h: HookCall) => Promise<unknown>) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== `/${this.token}` || req.method !== 'POST') return new Response('', { status: 404 });
        let h: HookCall;
        try {
          h = (await req.json()) as HookCall;
        } catch {
          return new Response('');
        }
        const answer = await this.on(h).catch((e) => console.error(`Obeya: a Gemini hook failed: ${messageOf(e)}`));
        return answer ? Response.json(answer) : new Response('');
      },
    });
  }

  get port(): number {
    return this.server.port!;
  }

  /** Where the hook posts to reach this server: here, or at the port forwarded to it from a host (`port`). */
  url(port = this.port): string {
    return `http://127.0.0.1:${port}/${this.token}`;
  }

  close() {
    void this.server.stop(true);
  }
}

/** How agy names an effort (`thought_level`): its highest is `xhigh`, which `max` goes to. */
const thoughtLevel = (e: AgentEffort) => (e === 'max' ? 'xhigh' : e);

/** Whether a turn's error says the login's quota is used up (the weekly one, the five-hour one, a spend cap), as agy and Google's API word it. */
export function quotaExhausted(message: string): boolean {
  return /RESOURCE_EXHAUSTED|\bquota\b|\b429\b|exhausted your capacity|rate.?limit|spend.?cap|prepaid balance/i.test(message);
}

/** Obeya's tools for every Gemini session, one server for all of them. */
const toolServer = new McpToolServer();

/** The Gemini directories of the runtimes made, where their sessions' transcripts lie (`geminiTranscript`). */
const runtimeDirs = new Set<string>();

/**
 * Where agy keeps the transcript of a session (`<gemini dir>/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`):
 * in the Gemini directory of each runtime of this process, one of which ran it.
 */
export function geminiTranscripts(session: string): string[] {
  const id = session.slice(GEMINI_SESSION.length);
  if (!session.startsWith(GEMINI_SESSION) || !/^[\w-]+$/.test(id)) return [];
  return [...runtimeDirs].map((dir) => join(dir, 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'));
}

/**
 * Runs agents through `agy acp` on the Antigravity login of the machine they work on: this one, with
 * `dir` as Obeya's own Gemini directory, or a host's over SSH, with Obeya's Gemini directory there.
 * `writable`: directories outside every workspace here that agents which act write to as well (the
 * demo directory, where their demos and artifacts go), asked at each start; on a host, demos go
 * into its `~/demos`.
 */
export function geminiRuntime(o: { dir: string; own?: string; writable?: () => string[] }): AgentRuntime {
  runtimeDirs.add(o.dir);
  const dir = new GeminiDir(o.dir, o.own);
  return { start: (spec, firstMessage, images) => new GeminiSession(spec, dir, firstMessage, images, o.writable) };
}

/** A port on a host forwarded to a session's server here: one of its own per session and server, as for Codex's hooks. */
const portThere = () => 30_000 + Math.floor(Math.random() * 30_000);

/** What a session on a host without agy fails with. */
const notInstalledOn = (host: string, stderr: string) => withStderr(`Gemini (the Antigravity CLI) is not installed on ${host}: no \`agy\` on its PATH`, stderr);

/** Why an agent does not start where the repository's own agy configuration waits for the owner. */
const ownConfig = (own: string) =>
  new Error(`This repository's own Antigravity configuration (${own}) waits for your confirmation, and Gemini would run it unchecked, so the agent did not start. Confirm the repository's commands, or run the card on another harness.`);

class GeminiSession implements AgentSession {
  readonly done: Promise<void>;
  private acp: AcpConnection | undefined;
  private hooks: Hooks | undefined;
  private tools: { url: string; close: () => void } | undefined;
  private closed = false;
  private id: string | undefined;
  /** The session is open, its model, effort and mode set: prompts may go. */
  private open = false;
  /** Messages no turn has taken yet. */
  private queue: { text: string; images?: string[] }[] = [];
  /** The prompts of the turn under way not answered yet: the first started it, the others steer it. */
  private prompts = 0;
  /** The agent's words since its last tool call. */
  private text = '';
  /** The tool calls reported so far, by agy's id. */
  private seen = new Set<string>();
  /** The model the session runs on (`gemini-4-neon`) and the effort it thinks with. */
  private model = '';
  private effort: AgentEffort | undefined;
  /** The session's tokens so far, from its turns. */
  private tokens: GeminiTokens = { inputTokens: 0, cachedReadTokens: 0, outputTokens: 0 };
  /** The error the turn under way ends with, once every prompt of it has its answer. */
  private failure: { message: string; limit?: { resetsAt?: number } } | undefined;
  /** What a refused permission tells the agent at its next turn: agy ends a turn without a word to it. */
  private refusals: string[] = [];
  /** A folder's watch hears of calls one after the other. */
  private watching: Promise<void> = Promise.resolve();
  /** The prompts sent, one after the other. */
  private sending: Promise<unknown> = Promise.resolve();
  /** The host the session runs on, if not here; and whether its connection failed. */
  private there: ReturnType<typeof remote> = null;
  private lost = false;
  /** agy was not found there (the shell's exit code 127). */
  private missing = false;
  /** Obeya's Gemini directory on that host, which holds the session's grants while it runs. */
  private hostDir: HostGeminiDir | undefined;
  /** For a session on a host: the files a message names, copied there, in the order the messages came. */
  private carry?: (text: string, images: string[]) => Promise<{ text: string; images: string[] }>;
  private carrying: Promise<void>;
  /** Lets messages to a host be carried, once the host is ready (or the session failed). */
  private carryable: () => void = () => {};

  constructor(
    private spec: AgentSpec,
    private dir: GeminiDir,
    firstMessage: string | undefined,
    images: string[] | undefined,
    private writable: () => string[] = () => [],
  ) {
    this.effort = spec.effort;
    this.carrying = new Promise((r) => (this.carryable = r));
    let unknownHost: unknown;
    try {
      this.there = remote(spec.cwd);
    } catch (e) {
      unknownHost = e;
    }
    if (firstMessage !== undefined) this.send(firstMessage, images);
    this.done = (unknownHost ? Promise.reject(unknownHost) : this.run())
      .catch((e) => {
        if (this.closed) return;
        if (this.there && (this.lost || e instanceof HostError)) this.emit(lostEvent(this.there.host.name));
        else if (this.there && this.missing) this.emit({ type: 'error', message: notInstalledOn(this.there.host.name, this.acp?.stderr ?? '') });
        else this.emit({ type: 'error', message: withStderr(messageOf(e), this.acp?.stderr ?? '') });
        this.acp?.close();
      })
      .finally(() => {
        this.carryable();
        this.hooks?.close();
        this.tools?.close();
        this.dir.release(this);
        this.hostDir?.release(this);
      });
  }

  send(text: string, images?: string[]) {
    if (this.closed) return;
    const message = { text, ...(images?.length ? { images } : {}) };
    if (!this.there) {
      this.queue.push(message);
      this.pump();
      return;
    }
    // the files it names copied there first, keeping the order; its images go inline, read here
    this.carrying = this.carrying.then(async () => {
      const carried = this.carry ? (await this.carry(text, images ?? [])).text : text;
      if (this.closed) return;
      this.queue.push({ ...message, text: carried });
      this.pump();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    const acp = this.acp;
    if (acp && this.id) acp.request('session/close', { sessionId: this.id }).catch(() => {});
    // what the agent left running (a dev server) ends with the session
    setTimeout(() => acp?.close(), 1500).unref?.();
  }

  private emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }

  /** The name of the machine the session runs on, for what it says: the host's, else none. */
  private get host(): string | null {
    return this.there?.host.name ?? null;
  }

  /**
   * agy here, on Obeya's own Gemini directory with the session's grants in it, its hook posting to
   * the session's server on the loopback: the connection, the workspace, and the repository's
   * CLAUDE.md where agy reads no instructions of its own there.
   */
  private async startHere(): Promise<{ acp: AcpConnection; cwd: string; notes?: string; tools?: string } | undefined> {
    const spec = this.spec;
    const bin = await geminiExecutable({ ...process.env, ...spec.env });
    if (!bin) throw new Error(`${NOT_INSTALLED}: no \`agy\` on the PATH`);
    const own = spec.untrusted ? await runsOwn(spec.cwd) : undefined;
    if (own) throw ownConfig(own);
    const common = spec.readOnly ? undefined : await gitCommonDir(spec.cwd);
    const grants: Grants = await withRealPaths({
      read: await gitConfigFiles(spec.cwd),
      write: spec.readOnly ? [] : [...(spec.dirs ?? []), tmpdir(), ...(common ? [common] : []), ...this.writable()],
    });
    if (this.closed) return undefined;
    await this.dir.prepare(this, grants, spec.plugins ?? []);
    if (this.closed) return undefined;
    const hooks = (this.hooks = new Hooks((h) => this.hook(h)));
    this.tools = spec.tools.length ? toolServer.open({ tools: spec.tools, after: () => spec.contextUpdate?.() }) : undefined;
    const acp = new AcpConnection({ bin, args: ['acp', '--gemini-dir', this.dir.dir], cwd: spec.cwd, env: { ...cleanEnv(), ...spec.env, OBEYA_GEMINI_HOOK: hooks.url() } });
    const notes = spec.untrusted ? undefined : await claudeNotes(spec.cwd);
    return { acp, cwd: spec.cwd, ...(notes ? { notes } : {}), ...(this.tools ? { tools: this.tools.url } : {}) };
  }

  /**
   * agy on a host, started there over the connection (`SshHost.session`) once the host has what
   * the session needs (the plugins, Obeya's Gemini directory there with the session's grants), its
   * hook and Obeya's tools reaching their servers here through ports forwarded from there. It runs
   * on the host's own agy login: none travels.
   */
  private async startThere(there: NonNullable<ReturnType<typeof remote>>): Promise<{ acp: AcpConnection; cwd: string; notes?: string; tools?: string } | undefined> {
    const spec = this.spec;
    const { host, path: cwd } = there;
    const files = sessionFiles(host.o.home, spec.plugins ?? []);
    // a host that cannot be made ready loses the connection rather than failing the session
    const dir = await host.prepare(files);
    if (this.closed) return undefined;
    this.carry = (text, images) => carryTo(host, dir, text, images, join(host.o.home, 'files'));
    this.carryable();
    const found = await survey(host, cwd, { skills: (spec.plugins ?? []).map((p) => `${dir}/${basename(p)}/skills`), untrusted: !!spec.untrusted });
    if (found.own) throw ownConfig(found.own);
    const grants: Grants = await realPathsThere(host, {
      read: found.git,
      write: spec.readOnly ? [] : [...(spec.dirs ?? []), found.tmp, ...(found.common ? [found.common] : []), `${found.home}/demos`],
    });
    let gemini = hostDirs.get(host);
    if (!gemini) hostDirs.set(host, (gemini = new HostGeminiDir(host, `${dir}/gemini`)));
    this.hostDir = gemini;
    await gemini.prepare(this, grants, found.skills);
    if (this.closed) return undefined;
    const hooks = (this.hooks = new Hooks((h) => this.hook(h)));
    this.tools = spec.tools.length ? toolServer.open({ tools: spec.tools, after: () => spec.contextUpdate?.() }) : undefined;
    const hookPort = portThere();
    let toolPort = portThere();
    // two forwards of one session on one port would end it as a lost connection
    while (toolPort === hookPort) toolPort = portThere();
    const tools = this.tools ? new URL(this.tools.url) : undefined;
    const start = host.session({
      cwd,
      files,
      login: false,
      forwards: [`127.0.0.1:${hookPort}:127.0.0.1:${hooks.port}`, ...(tools ? [`127.0.0.1:${toolPort}:127.0.0.1:${tools.port}`] : [])],
      onExit: (code) => {
        this.lost = code === LOST && !this.closed;
        this.missing = code === 127;
      },
      onStderr: (text) => this.acp && (this.acp.stderr = stderrTail(this.acp.stderr, text)),
    });
    const proc = start({ command: 'agy', args: ['acp', '--gemini-dir', gemini.dir], cwd, env: { ...spec.env, OBEYA_GEMINI_HOOK: hooks.url(hookPort) }, signal: new AbortController().signal });
    const acp = new AcpConnection({ process: proc as unknown as AcpProcess });
    if (tools) tools.port = String(toolPort);
    return { acp, cwd, ...(found.notes ? { notes: found.notes } : {}), ...(tools ? { tools: tools.href } : {}) };
  }

  private async run() {
    const spec = this.spec;
    const there = this.there;
    const started = there ? await this.startThere(there) : await this.startHere();
    if (!started) return;
    const acp = (this.acp = started.acp);
    // closed while it started: what it started goes with it
    if (this.closed) return acp.close();
    acp.onNotification = (method, params) => this.heard(method, params);
    acp.onRequest = (method, params) => this.asked(method, params);
    await acp.initialize();
    const system = started.notes ? `${spec.system}\n\nThe repository's CLAUDE.md:\n\n${started.notes}` : spec.system;
    const session = {
      cwd: started.cwd,
      mcpServers: started.tools ? [{ type: 'http', name: 'obeya', url: started.tools, headers: [] }] : [],
      ...(spec.dirs?.length ? { additionalDirectories: spec.dirs } : {}),
      _meta: { antigravity: { systemPrompt: { append: system } } },
    };
    let opened: AcpSessionOpened;
    try {
      if (spec.resume) {
        this.id = spec.resume.slice(GEMINI_SESSION.length);
        opened = await acp.request<AcpSessionOpened>('session/resume', { sessionId: this.id, ...session });
      } else {
        opened = await acp.request<AcpSessionOpened>('session/new', session);
        this.id = opened.sessionId;
      }
    } catch (e) {
      if (geminiLoginFailed(messageOf(e))) throw new Error(notLoggedIn(this.host, messageOf(e)));
      throw e;
    }
    if (!this.id) throw new Error('agy opened no session');
    this.model = this.resolveModel(opened);
    await acp.request('session/set_config_option', { sessionId: this.id, configId: 'model', value: this.model });
    if (this.effort) await acp.request('session/set_config_option', { sessionId: this.id, configId: 'thought_level', value: thoughtLevel(this.effort) });
    // the mode is the session's own, and a resumed one is back at the default: set at every start
    await acp.request('session/set_mode', { sessionId: this.id, modeId: spec.readOnly ? 'default' : 'auto' });
    if (this.closed) return acp.close();
    this.open = true;
    this.emit({ type: 'session', id: `${GEMINI_SESSION}${this.id}`, model: this.model, ...(this.effort ? { effort: this.effort } : {}) });
    this.pump();
    const code = await acp.exited;
    if (!this.closed) {
      if (this.lost) this.emit(lostEvent(there!.host.name));
      else if (there && code === 127) this.emit({ type: 'error', message: notInstalledOn(there.host.name, acp.stderr) });
      else this.emit({ type: 'error', message: withStderr(`agy acp exited${code === null ? '' : ` with code ${code}`}`, acp.stderr) });
    }
    // what agy started (a dev server sent off with `&`) goes with it
    acp.close();
  }

  /**
   * The model the session runs on: the newest of the family it is to run on (the preset's where it
   * names none) in the session's own catalog, with the effort nearest the one chosen that it takes.
   * Where the catalog has none of the family, the session fails rather than run on agy's own choice.
   */
  private resolveModel(opened: AcpSessionOpened): string {
    const family = modelFamily(this.spec.model && this.spec.model !== 'default' ? this.spec.model : GEMINI_PRESET);
    const catalog = geminiModelsOf(opened.models?.availableModels ?? []);
    const model = resolveGeminiModel(catalog, family);
    if (!model) throw new Error(`Gemini on ${this.host ?? 'this machine'} lists no model of the family ${familyName(family)}, so the agent did not start.`);
    if (this.effort) this.effort = nearestEffort(this.effort, model.efforts);
    return model.id;
  }

  /** Starts a turn with what waits, or steers the one under way with it. */
  private pump() {
    const acp = this.acp;
    if (!acp || !this.open || this.closed || !this.queue.length) return;
    const waiting = this.queue.splice(0);
    const said = this.refusals.splice(0);
    const id = this.id;
    this.prompts++;
    // in the order they came: a prompt's images are read before it goes, the next one goes after it (not after its answer)
    this.sending = this.sending.then(async () => {
      // closed while its images were read: nothing goes to a session that ends
      if (this.closed) return;
      const prompt = [...(said.length ? [{ type: 'text', text: said.join('\n\n') }] : []), ...(await Promise.all(waiting.map((m) => promptOf(m.text, m.images)))).flat()];
      if (this.closed) return;
      acp.request<{ stopReason?: string; usage?: AcpUsage }>('session/prompt', { sessionId: id, prompt }).then(
        (r) => this.answered(r.usage),
        (e) => void this.failed(messageOf(e)),
      );
    });
  }

  /** A prompt's answer: the turn ends once every prompt of it has its answer. */
  private answered(usage: AcpUsage | undefined) {
    if (usage) {
      this.tokens = {
        inputTokens: this.tokens.inputTokens + (usage.inputTokens ?? 0),
        cachedReadTokens: this.tokens.cachedReadTokens + (usage.cachedReadTokens ?? 0),
        outputTokens: this.tokens.outputTokens + (usage.outputTokens ?? 0),
      };
    }
    this.settled();
  }

  /** A prompt that failed: the turn's error once it ends, a quota's with when it resets. */
  private async failed(message: string) {
    // the connection to the host dropped: the session ends as lost, and its turn with it
    if (this.lost) return;
    let limit: { resetsAt?: number } | undefined;
    if (quotaExhausted(message) && !this.closed) {
      // the quota of the login the session runs on: the host's own there
      const there = this.there;
      const bin = there ? undefined : await geminiExecutable({ ...process.env, ...this.spec.env });
      const q = there ? await geminiQuotaOn(there.host).catch(() => undefined) : bin ? await quota(bin, cleanEnv()) : undefined;
      const resetsAt = q && 'report' in q ? quotaResets(q.report, this.model) : undefined;
      limit = resetsAt ? { resetsAt } : {};
    }
    // a steer that failed with the turn says nothing new: the turn's own error counts
    this.failure ??= { message: geminiLoginFailed(message) ? notLoggedIn(this.host, message) : message, ...(limit ? { limit } : {}) };
    this.settled();
  }

  /** One prompt of the turn has its answer; the last one ends the turn, with its cost and its error, if any. */
  private settled() {
    if (--this.prompts > 0 || this.closed) return;
    this.flush();
    const usd = geminiCost(this.model, this.tokens);
    if (usd > 0) this.emit({ type: 'spend', session: `${GEMINI_SESSION}${this.id}`, usd });
    const failure = this.failure;
    this.failure = undefined;
    if (failure) this.emit({ type: 'error', ...failure });
    this.emit({ type: 'idle', background: 0, ...(this.queue.length || this.refusals.length ? { more: true } : {}) });
    if (!this.queue.length && this.refusals.length) this.queue.push({ text: 'Go on with your work.' });
    this.pump();
  }

  private flush() {
    const text = this.text.trim();
    this.text = '';
    if (text) this.emit({ type: 'text', text });
  }

  private heard(method: string, p: Record<string, unknown>) {
    if (method !== 'session/update' || this.closed || p.sessionId !== this.id) return;
    const u = p.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } & AcpToolCall & { args?: Record<string, unknown> };
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text' && u.content.text) this.text += u.content.text;
        return;
      case 'tool_call': {
        if (this.seen.has(u.toolCallId)) return;
        this.seen.add(u.toolCallId);
        this.flush();
        const call = geminiCall(u.toolCallId, u.name ?? u.title ?? '', u.args ?? u.rawInput ?? {});
        this.emit({ type: 'tool', name: call.name, input: call.input });
        return;
      }
    }
  }

  /**
   * A hook's call: a command that would wait too long in the foreground is refused, a read-only agent
   * is refused every tool that does more than read, Obeya's own tools run without asking, and a
   * folder's watch hears of each call before it runs and after. Anything else is agy's to decide.
   */
  private async hook(h: HookCall): Promise<unknown> {
    // the session has ended: nothing of it runs any more
    if (this.closed) return h.hookEventName === 'PreToolUse' ? { decision: 'deny', reason: 'The session has ended.' } : {};
    const name = h.toolCall?.name ?? '';
    const call = geminiCall(h.toolCall?.id ?? '', name, h.toolCall?.args ?? {});
    if (h.hookEventName === 'PostToolUse') {
      if (this.spec.watch) await this.watch((w) => w.after(call));
      return {};
    }
    if (h.hookEventName !== 'PreToolUse') return undefined;
    if (OBEYA_TOOL.test(name)) return { decision: 'allow' };
    if (this.spec.readOnly && !READS.test(name)) {
      this.emit({ type: 'denied', name: call.name, input: call.input, by: 'mode' });
      return { decision: 'deny', reason: 'This agent only reads: it changes no file and runs no command.' };
    }
    const command = call.name === 'Bash' ? String(call.input.command ?? '') : '';
    if (command && foregroundSleep(command) > FOREGROUND_SLEEP_LIMIT) {
      this.emit({ type: 'denied', name: 'Bash', input: { command }, by: 'obeya' });
      return { decision: 'deny', reason: WAIT_REFUSED };
    }
    if (this.spec.watch) await this.watch((w) => w.before(call));
    return undefined;
  }

  /** Tells the folder's watch of a step, after those before it; settles once it is done. */
  private watch(step: (w: NonNullable<AgentSpec['watch']>) => Promise<void>): Promise<void> {
    const w = this.spec.watch!;
    this.watching = this.watching.then(() => step(w)).catch((e) => console.error(`Obeya: a folder's watch failed: ${messageOf(e)}`));
    return this.watching;
  }

  private async asked(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method !== 'session/request_permission') throw new AcpError(`${method} is not handled`, -32601);
    const options = (p.options ?? []) as AcpPermissionOption[];
    const tool = (p.toolCall ?? {}) as AcpToolCall & { args?: Record<string, unknown> };
    const name = tool.name ?? '';
    // Obeya's own tools are the agent's way to Obeya: never a question to the owner
    if (OBEYA_TOOL.test(name)) return pickPermission(options, 'allow_once');
    const call = geminiCall(tool.toolCallId ?? '', name || tool.title || '', tool.args ?? tool.rawInput ?? {});
    const input = call.name === 'Bash' ? { command: call.input.command } : call.input;
    let answer: { allow: boolean; message?: string };
    if (this.spec.askOwner && !this.closed) {
      const abort = new AbortController();
      void this.done.finally(() => abort.abort());
      answer = await this.spec.askOwner({ name: call.name, input }, abort.signal);
    } else {
      this.emit({ type: 'denied', name: call.name, input, by: 'mode' });
      answer = { allow: false };
    }
    if (answer.allow) return pickPermission(options, 'allow_once');
    // agy ends the turn on a refusal without telling the agent: the next turn does
    const what = call.name === 'Bash' ? `\`${String(input.command ?? '')}\`` : `${tool.title ?? call.name}`;
    const why = answer.message?.trim();
    this.refusals.push(`${this.spec.askOwner ? 'The owner refused' : 'Nobody could allow'} ${what}${why ? `: ${why}${/[.!?]$/.test(why) ? '' : '.'}` : '.'} Go on without it.`);
    return pickPermission(options, 'reject_once');
  }
}
