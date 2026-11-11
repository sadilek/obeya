// Agents on Codex: the machine's own Codex CLI and its login, driven through `codex app-server`
// (JSON-RPC over stdio, one process per session), behind the same interface as Claude Code's
// (`AgentRuntime`, runtime.ts). Obeya's tools reach the session as dynamic tools of the namespace
// `obeya`, which Codex keeps with the thread, so a resumed thread has them again. A message sent
// during a turn steers it; one that comes as the turn ends starts the next.
//
// Codex works in its own sandbox: the workspace, the git directory a worktree commits into, the
// agent's extra directories and the temporary directory are writable, the network is open, and what
// goes beyond that Codex's automatic reviewer allows or refuses, as Claude Code's auto mode does. A
// request the reviewer leaves to a person reaches the owner (`AgentSpec.askOwner`). Read-only agents
// run in Codex's read-only sandbox.
//
// Codex's hooks, given on its command line, tell Obeya of each command and patch before it runs
// (and after, in a folder without git): a long wait in the foreground is refused, and a folder's
// watch reads the folder before a change, as Claude Code's hooks have it. On another machine the
// session runs there over SSH, its hooks reaching Obeya through a forwarded port.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { messageOf } from '../core/text';
import { within, withTimeout } from '../core/late';
import type { AgentEffort, HarnessModel, UsageLimit } from '../core/types';
import { AGENT_EFFORTS, codexFamily, codexFamilyName, nearestEffort, resolveCodexModel } from '../core/types';
import type { ToolCall } from './folder';
import { HostError, LOST, remote, sessionFiles, type SshHost } from './hosts';
import { which } from './path';
import { carryTo, CODEX_SESSION, type AgentEvent, type AgentRuntime, type AgentSession, type AgentSpec, cleanEnv, lostEvent, stderrTail, trackHere, withStderr } from './runtime';
import { BOUNDED_WAITS, FOREGROUND_SLEEP_LIMIT, refuseLongWait, waitRefusal } from './shell';
import { codexCost, type CodexTokens } from './prices';
import { OWN_GROUP, spawnOutput } from './spawn';
import type { PlanLimits, UsageSource } from './usage';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

/** The Codex CLI the agents run on: the one `OBEYA_CODEX` names, else `codex` on the PATH; null where there is none. */
export function codexExecutable(env: Env = process.env): string | null {
  return env.OBEYA_CODEX || which('codex', env) || null;
}

/**
 * How to start a program with `args`: npm's `codex.cmd` on Windows is no program to start but a
 * script for cmd, which takes the whole command line as one quoted string (`/s /c "…"`), passed on
 * verbatim (`spawnOptions`), so a path with spaces survives.
 */
export function startArgv(bin: string, args: string[]): string[] {
  if (!/\.(cmd|bat)$/i.test(bin)) return [bin, ...args];
  const quoted = [bin, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
  return ['cmd.exe', '/d', '/s', '/c', `"${quoted}"`];
}

/** What `spawn` needs besides for an argv of `startArgv`: cmd's command line as given. */
export const spawnOptions = (argv: string[]) => (argv[0] === 'cmd.exe' ? { windowsVerbatimArguments: true } : {});

/** Ends a process and what it started: on Windows its whole tree, which a kill of cmd alone would leave running. */
export function endTree(p: ChildProcess) {
  try {
    if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else if (OWN_GROUP && p.pid) process.kill(-p.pid, 'SIGTERM');
    else p.kill();
  } catch {
    p.kill();
  }
}


/** What the CLI says on stdout and stderr; null where it could not start, took too long or did not end well. */
export async function runCodex(bin: string, args: string[], env: Env, ms = 15_000): Promise<string | null> {
  const argv = startArgv(bin, args);
  // killed at the deadline, and not waited for past it: what it started may hold its output open
  const r = await within(spawnOutput(argv, { env, timeout: ms, killSignal: 'SIGKILL', ...spawnOptions(argv) }).catch(() => null), ms);
  return r?.code === 0 ? `${r.stdout}${r.stderr}`.trim() : null;
}

/** The CLI's version (`codex-cli 0.159.2`), or null where it does not answer. */
export async function codexVersion(bin: string, env: Env): Promise<string | null> {
  return (await runCodex(bin, ['--version'], env))?.match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
}

/** Whether the CLI is logged in, and how it says so ("Logged in using ChatGPT"). */
export async function codexLogin(bin: string, env: Env): Promise<{ loggedIn: boolean; how?: string }> {
  const out = await runCodex(bin, ['login', 'status'], env);
  if (out === null) return { loggedIn: false };
  const how = out.match(/logged in using (.+)/i)?.[1]?.trim();
  return { loggedIn: true, ...(how ? { how } : {}) };
}

/** A process that runs an app server: one started here, or one over `ssh` (`SshHost.session`). */
type Spawned = Pick<ChildProcess, 'stdin' | 'stdout' | 'kill'> & { stderr?: ChildProcess['stderr']; once(event: string, listener: (...a: any[]) => void): unknown };

/** A failure the app server reported for a request. */
export class CodexError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** What a request to an app server that has ended fails with. */
const ENDED = 'the Codex app server ended';

/** What a start fails with where Codex is not on this machine. */
const NOT_INSTALLED = 'Codex is not installed on this machine';

/**
 * A `codex app-server` process and the JSON-RPC connection over its stdio: requests out and their
 * answers, notifications in, and the server's own requests (a tool call, an approval), answered by
 * `onRequest`.
 */
export class AppServer {
  private proc: Spawned;
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  /** The process has ended: a request gets no answer any more. */
  private dead = false;
  /** Started here, rather than given (one over `ssh`, say). */
  private here: boolean;
  stderr = '';
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async (method) => {
    throw new CodexError(`${method} is not handled`);
  };
  /** Settles with the exit code once the process has ended. */
  readonly exited: Promise<number | null>;

  /** Starts `codex app-server` here, or speaks to one a process given runs (on another machine, say). */
  constructor(o: { bin: string; cwd: string; env: Env; args?: string[] } | { process: Spawned }) {
    this.here = !('process' in o);
    if ('process' in o) this.proc = o.process;
    else {
      const argv = startArgv(o.bin, ['app-server', ...(o.args ?? [])]);
      const p = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP, ...spawnOptions(argv) });
      trackHere(p);
      this.proc = p;
    }
    this.exited = new Promise((resolve) => {
      this.proc.once('error', (e: Error) => ((this.stderr += e.message), resolve(null)));
      // a process here has closed its pipes too once it is done; one given may have none of its own
      this.proc.once(this.here ? 'close' : 'exit', (code: number | null) => resolve(code));
    });
    void this.exited.then(() => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new CodexError(withStderr(ENDED, this.stderr)));
      this.pending.clear();
    });
    this.proc.stdout!.setEncoding('utf8').on('data', (d: string) => this.take(d));
    this.proc.stderr?.setEncoding('utf8').on('data', (d: string) => (this.stderr = stderrTail(this.stderr, d)));
    // a closed pipe as the process ends is no error of Obeya's
    this.proc.stdin!.on('error', () => {});
  }

  /** Initializes the connection, with the experimental API that dynamic tools need. */
  async init(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'obeya', title: 'Obeya', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify('initialized');
  }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    if (this.dead) return Promise.reject(new CodexError(withStderr(ENDED, this.stderr)));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Ends the process, and what it runs. */
  close() {
    if (this.here) endTree(this.proc as ChildProcess);
    else this.proc.kill();
  }

  private write(m: unknown) {
    if (this.proc.stdin!.writable) this.proc.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  private take(data: string) {
    this.buffer += data;
    let n: number;
    while ((n = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, n).trim();
      this.buffer = this.buffer.slice(n + 1);
      if (!line) continue;
      let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined) void this.answer(m.id, m.method, m.params ?? {});
      else if (m.method) this.onNotification(m.method, m.params ?? {});
      else if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new CodexError(m.error.message ?? 'error', m.error.code));
        else p?.resolve(m.result);
      }
    }
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>) {
    try {
      this.write({ id, result: await this.onRequest(method, params) });
    } catch (e) {
      this.write({ id, error: { code: -32000, message: messageOf(e) } });
    }
  }
}

/** A thread item as the app server reports it; only what Obeya reads of it. */
interface Item {
  type: string;
  id: string;
  text?: string;
  command?: string;
  changes?: { path: string; kind: string | { type?: string } }[];
  namespace?: string | null;
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
  prompt?: string | null;
}

/** A shell's own wrapper around a command (`/bin/zsh -lc 'git status'`), which the log line leaves out: the shell, then its flag. */
const WRAPPER = { shell: /(?:^|\/)(?:ba|z|da)?sh$/, flag: /^-l?c$/ };

/** A command as the app server reports it, a line, without its shell's wrapper. */
export function bareCommand(command: string): string {
  const m = /^(\S+)\s+(\S+)\s+(['"])([^]*)\3$/.exec(command.trim());
  return m && WRAPPER.shell.test(m[1]!) && WRAPPER.flag.test(m[2]!) ? m[4]!.replace(/'\\''/g, "'") : command;
}

/** A command as a thread's rollout file records it, an argv, without its shell's wrapper. */
export function bareArgv(argv: string[]): string {
  return argv.length === 3 && WRAPPER.shell.test(argv[0]!) && WRAPPER.flag.test(argv[1]!) ? argv[2]! : argv.join(' ');
}

/** A file a step added (`Write`) or changed, moved or deleted (`Edit`), as Claude Code's tool call would be: one per file, `index` its place in the step. */
export const fileCall = (step: string, index: number, path: string, added: boolean): ToolCall => ({ id: `${step}:${index}`, name: added ? 'Write' : 'Edit', input: { file_path: path } });

/** A tool of an MCP server, or of a dynamic tool's namespace (Obeya's own where it names none), as Claude Code names it. */
export const mcpTool = (server: string | null | undefined, tool: string | undefined) => `mcp__${server || 'obeya'}__${tool}`;

/** The tool calls an item stands for, named as Claude Code's are, so the card's log and a folder's watch read them alike. */
export function itemCalls(item: Item): ToolCall[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ id: item.id, name: 'Bash', input: { command: bareCommand(item.command ?? '') } }];
    case 'fileChange':
      return (item.changes ?? []).map((c, i) => fileCall(item.id, i, c.path, (typeof c.kind === 'string' ? c.kind : c.kind?.type) === 'add'));
    case 'dynamicToolCall':
      return [{ id: item.id, name: mcpTool(item.namespace, item.tool), input: (item.arguments ?? {}) as Record<string, unknown> }];
    case 'mcpToolCall':
      return [{ id: item.id, name: mcpTool(item.server, item.tool), input: (item.arguments ?? {}) as Record<string, unknown> }];
    case 'webSearch':
      return [{ id: item.id, name: 'WebSearch', input: { query: item.query ?? '' } }];
    case 'collabAgentToolCall':
      return [{ id: item.id, name: 'Agent', input: { description: item.prompt ?? '' } }];
    default:
      return [];
  }
}

/** A rate limit window as the app server reports it: share used, its length in minutes, when it starts anew (seconds). */
interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
interface RateSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  rateLimitReachedType?: string | null;
}

/** When the limit a turn ran into lifts (milliseconds): the earliest reset of a window used up, else of any. */
export function limitResets(snapshot: RateSnapshot | undefined): number | undefined {
  const windows = [snapshot?.primary, snapshot?.secondary].filter((w): w is RateWindow => !!w?.resetsAt);
  const full = windows.filter((w) => w.usedPercent >= 100);
  const at = (full.length ? full : windows).map((w) => w.resetsAt! * 1000);
  return at.length ? Math.min(...at) : undefined;
}

/** The text of a message and its images (files on this machine), as Codex takes a user's input. */
function input(text: string, images: string[] = []) {
  return [{ type: 'text', text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))];
}

/** The git directory a worktree commits into, outside the worktree itself; nothing for a clone. `host`: the machine `cwd` is on, if not this one. */
async function gitCommonDir(cwd: string, host?: SshHost): Promise<string | undefined> {
  const argv = ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'];
  try {
    let out: string;
    if (host) {
      const r = await host.run(argv, { cwd });
      if (r.code !== 0) return undefined;
      out = r.stdout.trim();
    } else {
      const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'ignore' });
      out = (await new Response(p.stdout).text()).trim();
      if ((await p.exited) !== 0) return undefined;
    }
    return out && !out.startsWith(cwd) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** A tool's input schema as JSON Schema, for a dynamic tool. */
function jsonSchema(shape: z.ZodRawShape): unknown {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

/** The files an `apply_patch` input touches, each as the tool call Claude Code's would be: a file added as `Write`, one changed, moved or deleted as `Edit`. */
export function patchCalls(id: string, patch: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    calls.push(fileCall(id, calls.length, (m[2] ?? m[3])!.trim(), m[1] === 'Add' || !!m[3]));
  }
  return calls;
}

/** What Codex's hooks pass about a tool call (`PreToolUse`, `PostToolUse`); only what Obeya reads of it. */
interface HookCall {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: unknown };
}

/** The tool calls a hook's call stands for, as a folder's watch reads them. */
function hookCalls(h: HookCall): ToolCall[] {
  const id = h.tool_use_id ?? '';
  const command = typeof h.tool_input?.command === 'string' ? h.tool_input.command : '';
  if (h.tool_name === 'Bash') return [{ id, name: 'Bash', input: { command } }];
  if (h.tool_name === 'apply_patch') return patchCalls(id, command);
  return [];
}

/** Why a command that waits too long in the foreground is not run, in Codex's terms: it has no background task that wakes the session. */
export const WAIT_REFUSED = waitRefusal(
  `Wait in commands that sleep ${FOREGROUND_SLEEP_LIMIT} seconds at most, e.g. \`${BOUNDED_WAITS[0]}\`, and run one again until what you wait for is there. For anything longer, snooze (snooze) and end your turn: Obeya wakes you then.`,
);

/**
 * Where Codex's hooks reach the session: a server on the loopback that only this session's token
 * opens, which hears of each command and patch before it runs (and, for a folder's watch, after)
 * and answers as a `PreToolUse` hook does. The hook itself is curl (past any proxy the environment names), which sends what Codex gives
 * it and prints the answer; a hook that fails (no curl) lets the call run.
 */
class Hooks {
  private server: ReturnType<typeof Bun.serve>;
  private token = randomBytes(18).toString('base64url');

  constructor(private on: (h: HookCall) => Promise<unknown>) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== `/${this.token}` || req.method !== 'POST') return new Response('', { status: 404 });
        let h: HookCall;
        try {
          h = (await req.json()) as HookCall;
        } catch {
          return new Response('', { status: 400 });
        }
        return Response.json((await this.on(h).catch((e) => console.error(`Obeya: a Codex hook failed: ${messageOf(e)}`))) ?? {});
      },
    });
  }

  get port(): number {
    return this.server.port!;
  }

  /** The `-c` overrides that make Codex call the hooks at `port` (where the session's Codex reaches this server): before every command and patch, and after them where `after`. */
  args(port: number, after: boolean, windows: boolean): string[] {
    const command = `${windows ? 'curl.exe' : 'curl'} -sf --noproxy 127.0.0.1 --data-binary @- http://127.0.0.1:${port}/${this.token}`;
    const hook = (matcher: string) => `[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=600}]}]`;
    const tools = after ? '^(Bash|apply_patch)$' : '^Bash$';
    return ['-c', `hooks.PreToolUse=${hook(tools)}`, ...(after ? ['-c', `hooks.PostToolUse=${hook(tools)}`] : [])];
  }

  close() {
    void this.server.stop(true);
  }
}

/**
 * The trust Codex needs before it runs hooks given on its command line (it keeps none for them):
 * their hashes as `hooks/list` reports them, as the thread's `hooks.state`. Nothing where it lists
 * none (a Codex without hooks).
 */
async function hookTrust(server: AppServer, cwd: string): Promise<Record<string, unknown>> {
  try {
    const r = await server.request<{ data: { hooks: { key: string; source: string; currentHash: string }[] }[] }>('hooks/list', { cwds: [cwd] });
    const own = r.data.flatMap((d) => d.hooks).filter((h) => h.source === 'sessionFlags');
    return own.length ? { 'hooks.state': Object.fromEntries(own.map((h) => [h.key, { trusted_hash: h.currentHash }])) } : {};
  } catch {
    return {};
  }
}

/** What a session that ends without a turn's result says: the server's last words on stderr. */
function ended(code: number | null, stderr: string): string {
  return withStderr(`the Codex app server exited${code === null ? '' : ` with code ${code}`}`, stderr);
}

/** Whether a turn's error says Codex is not logged in. */
export function codexLoginFailed(info: unknown, message: string): boolean {
  return info === 'unauthorized' || /\bcodex login\b|\bnot logged in\b|\b401 Unauthorized\b/i.test(message);
}

/** A failure for Codex's missing login on `host` (null: this machine), as `codexLoginLost` reads it on the card. */
export const notLoggedIn = (host: string | null, message: string) => `Codex is not logged in on ${host ?? 'this machine'}. (${message})`;

/** An app server's answer to a request it does not know (`model/list` before Codex had it): it lists every method it does know. */
export const tooOld = (e: CodexError) => /unknown variant `model\/list`/.test(e.message);

/** How long a session waits for Codex's list of models before it gives up starting. */
const MODELS_WAIT_MS = 30_000;

/**
 * Settles once Codex has fetched its remote plugins' catalog (`plugin/list` answers then, about a
 * second after the start), at most after 15 s. The skills of those plugins join its list only then,
 * and a turn that starts before has the next one add the whole list again, the change from the one
 * the conversation last saw: some 2,500 tokens the cache does not hold, at each start or resume.
 */
async function pluginsListed(server: AppServer): Promise<void> {
  await within(server.request('plugin/list', {}).then(() => {}, () => {}), 15_000);
}
/** A port on a host forwarded to a session's hooks here: one of its own per session, as for the narration (`SshHost.session`). */
const hookPortThere = () => 30_000 + Math.floor(Math.random() * 30_000);

/** Runs agents through `codex app-server`, on the Codex login of the machine they work on: this one, or a host's over SSH. */
export const codexRuntime: AgentRuntime = {
  start: (spec, firstMessage, images) => new CodexSession(spec, firstMessage, images),
};

class CodexSession implements AgentSession {
  readonly done: Promise<void>;
  private server: AppServer | undefined;
  private hooks: Hooks | undefined;
  private closed = false;
  private thread: string | undefined;
  /** The turn under way, once known; `starting` while its start is asked for. */
  private turn: string | undefined;
  private starting = false;
  /** Turns that have ended, so that a late answer to a turn's start does not count it as under way. */
  private ended = new Set<string>();
  /** A steer asked for and not answered yet; and whether a turn's end waits for it. */
  private steering: Promise<void> | undefined;
  private finishing = false;
  /** Messages no turn has taken yet. */
  private queue: { text: string; images?: string[] }[] = [];
  /** For a session on another machine: the images and files a message names, copied there, in the order the messages came. */
  private carry?: (text: string, images: string[]) => Promise<{ text: string; images: string[] }>;
  private carrying: Promise<void>;
  /** Lets messages to a host be carried, once the host is ready (or the session failed). */
  private carryable: () => void = () => {};
  private limits: RateSnapshot | undefined;
  /** The error a failed turn reports, as the server said it while it went (`error`, `willRetry: false`). */
  private failure: { message: string; info?: unknown } | undefined;
  /** A folder's watch hears of calls one after the other. */
  private watching: Promise<void> = Promise.resolve();
  /** The host the session runs on, if not here; and whether its connection failed. */
  private there: ReturnType<typeof remote> = null;
  private lost = false;
  /** The calls a hook told of before they ran, by Codex's item id: their items need no watch of their own. */
  private hooked = new Set<string>();
  /** The effort the turns run with: the one chosen, or the nearest the model takes (`model`). */
  private effort: AgentEffort | undefined;
  /** The model the thread runs on, as Codex named it at its start, which its tokens are priced at. */
  private modelId = '';
  /** The thread's tokens so far as Codex last reported them, until the turn's end reports their cost. */
  private tokens: CodexTokens | undefined;

  constructor(
    private spec: AgentSpec,
    firstMessage: string | undefined,
    images: string[] | undefined,
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
        if (this.there && (this.lost || e instanceof HostError)) this.emit(lostEvent(this.there!.host.name));
        else this.emit({ type: 'error', message: withStderr(messageOf(e), this.server?.stderr ?? '') });
        // a start that failed leaves no app server behind (nor a host's session with it)
        this.server?.close();
      })
      .finally(() => (this.carryable(), this.hooks?.close()));
  }

  send(text: string, images?: string[]) {
    if (this.closed) return;
    if (!this.carry && !this.there) {
      this.queue.push({ text, images });
      this.pump();
      return;
    }
    // copied there first, keeping the order: the session takes a message once its files are there
    this.carrying = this.carrying.then(async () => {
      const c = this.carry ? await this.carry(text, images ?? []) : { text, images: images ?? [] };
      if (this.closed) return;
      this.queue.push(c);
      this.pump();
    });
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.server?.close();
  }

  /**
   * The model the session starts or resumes on: the newest of the family it is to run on (the
   * preset's where it names none) in the catalog of the app server it talks to, which is the one of
   * the machine it runs on, else the catalog's default. Where the catalog cannot be had or has
   * neither, the session fails rather than leave the model to Codex's own configuration, which may
   * name one the login cannot use. An effort that model does not take becomes the nearest it does.
   */
  private async model(server: AppServer): Promise<string> {
    const family = codexFamily(this.spec.model ?? 'default');
    const where = this.there?.host.name ?? 'this machine';
    let catalog: HarnessModel[];
    try {
      catalog = await withTimeout(listModels(server), MODELS_WAIT_MS, `no answer in ${MODELS_WAIT_MS / 1000} seconds`);
    } catch (e) {
      if (e instanceof CodexError && codexLoginFailed(undefined, e.message)) throw new Error(notLoggedIn(this.there?.host.name ?? null, e.message));
      if (e instanceof CodexError && tooOld(e)) throw new Error(`Codex on ${where} is too old to list its models, so the agent did not start. Update Codex there.`);
      throw new Error(`Codex on ${where} did not list its models, so the agent did not start. (${messageOf(e)})`);
    }
    const model = resolveCodexModel(catalog, family);
    if (!model) throw new Error(`Codex on ${where} lists no model of the family ${codexFamilyName(family)} and no default, so the agent did not start.`);
    if (this.effort) this.effort = nearestEffort(this.effort, model.efforts);
    return model.id;
  }

  private emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }

  private async run() {
    const spec = this.spec;
    const there = this.there;
    const cwd = there ? there.path : spec.cwd;
    const bin = there ? 'codex' : codexExecutable({ ...process.env, ...spec.env });
    if (!bin) throw new Error(`${NOT_INSTALLED}: no \`codex\` on the PATH`);
    const hooks = (this.hooks = new Hooks((h) => this.hook(h)));
    const writable = [...(spec.dirs ?? []), ...(there ? [] : [tmpdir()])];
    const common = spec.readOnly ? undefined : await gitCommonDir(cwd, there?.host);
    if (common) writable.push(common);
    if (this.closed) return;
    let server: AppServer;
    let roots = spec.plugins ?? [];
    if (there) {
      const host = there.host;
      const files = sessionFiles(host.o.home, roots);
      // a host that cannot be made ready loses the connection rather than failing the session
      const dir = await host.prepare(files);
      if (this.closed) return;
      roots = roots.map((p) => `${dir}/${basename(p)}`);
      this.carry = (text, images) => carryTo(host, dir, text, images, join(host.o.home, 'files'));
      this.carryable();
      const port = hookPortThere();
      const start = host.session({
        cwd,
        files,
        login: false,
        forwards: [`127.0.0.1:${port}:127.0.0.1:${hooks.port}`],
        onExit: (code) => (this.lost = code === LOST && !this.closed),
        onStderr: (text) => this.server && (this.server.stderr = stderrTail(this.server.stderr, text)),
      });
      server = new AppServer({ process: start({ command: bin, args: ['app-server', ...hooks.args(port, !!spec.watch, false)], cwd, env: { ...spec.env }, signal: new AbortController().signal }) });
    } else {
      server = new AppServer({ bin, cwd, env: { ...cleanEnv(), ...spec.env }, args: hooks.args(hooks.port, !!spec.watch, process.platform === 'win32') });
    }
    this.server = server;
    server.onNotification = (method, params) => this.heard(method, params);
    server.onRequest = (method, params) => this.asked(method, params);
    const exited = server.exited;
    await server.init();
    const plugins = pluginsListed(server);
    if (roots.length) await server.request('skills/extraRoots/set', { extraRoots: roots.map((p) => `${p}/skills`) }).catch(() => {});
    const trust = await hookTrust(server, cwd);
    if (this.closed) return;
    const config: Record<string, unknown> = {
      // a repository that has a CLAUDE.md and no AGENTS.md is read as Claude Code reads it
      project_doc_fallback_filenames: ['CLAUDE.md'],
      // the environment as Claude Code's agents get it, keys and tokens included
      'shell_environment_policy.inherit': 'all',
      'shell_environment_policy.ignore_default_excludes': true,
      'sandbox_workspace_write.network_access': true,
      'sandbox_workspace_write.writable_roots': writable,
      // what the repository's instructions say comes with the system prompt where its own settings wait for the owner
      ...(spec.untrusted ? { project_doc_max_bytes: 0 } : {}),
      ...trust,
    };
    const model = await this.model(server);
    await plugins;
    if (this.closed) return;
    const settings = {
      cwd,
      model,
      approvalPolicy: spec.readOnly ? 'never' : 'on-request',
      ...(spec.readOnly ? {} : { approvalsReviewer: 'auto_review' }),
      sandbox: spec.readOnly ? 'read-only' : 'workspace-write',
      config,
      developerInstructions: spec.system,
    };
    let opened: { thread: { id: string }; model?: string };
    try {
      opened = spec.resume
        ? await server.request<{ thread: { id: string }; model?: string }>('thread/resume', { threadId: spec.resume.replace(CODEX_SESSION, ''), excludeTurns: true, ...settings })
        : await server.request<{ thread: { id: string }; model?: string }>('thread/start', {
            ...settings,
            dynamicTools: spec.tools.length
              ? [{ type: 'namespace', name: 'obeya', description: "Obeya's tools: how this agent talks to the owner and to Obeya.", tools: spec.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: jsonSchema(t.schema) })) }]
              : [],
          });
    } catch (e) {
      if (e instanceof CodexError && codexLoginFailed(undefined, e.message)) throw new Error(notLoggedIn(there?.host.name ?? null, e.message));
      throw e;
    }
    this.thread = opened.thread.id;
    this.modelId = opened.model ?? model;
    this.emit({ type: 'session', id: `${CODEX_SESSION}${this.thread}`, ...(opened.model ? { model: opened.model } : {}), ...(this.effort ? { effort: this.effort } : {}) });
    this.pump();
    const code = await exited;
    if (this.closed) return;
    if (this.lost) this.emit(lostEvent(there!.host.name));
    else if (there && code === 127) this.emit({ type: 'error', message: withStderr(`Codex is not installed on ${there.host.name}: no \`codex\` on its PATH`, server.stderr) });
    else this.emit({ type: 'error', message: ended(code, server.stderr) });
  }

  /**
   * A hook's call (`Hooks`): a command that would wait too long in the foreground is refused
   * before it runs, and a folder's watch hears of a command or patch before it runs and after.
   */
  private async hook(h: HookCall): Promise<unknown> {
    const calls = hookCalls(h);
    if (!calls.length || this.closed) return {};
    if (h.hook_event_name === 'PreToolUse') {
      const command = h.tool_name === 'Bash' ? String(calls[0]!.input.command) : '';
      const refused = command ? refuseLongWait(command, WAIT_REFUSED) : undefined;
      if (refused) {
        this.emit({ type: 'denied', name: 'Bash', input: { command }, by: 'obeya' });
        return refused;
      }
      if (!this.spec.watch) return {};
      this.hooked.add(h.tool_use_id ?? '');
      for (const call of calls) await this.watch((w) => w.before(call));
      return {};
    }
    if (h.hook_event_name === 'PostToolUse' && this.spec.watch) for (const call of calls) await this.watch((w) => w.after(call));
    return {};
  }

  /** Starts a turn with what waits, or steers the one under way with it. */
  private pump() {
    const server = this.server;
    // one steer at a time: what comes meanwhile follows it, in the order it came
    if (!server || !this.thread || this.closed || this.starting || this.finishing || this.steering || !this.queue.length) return;
    const waiting = this.queue.splice(0);
    const given = waiting.flatMap((m) => input(m.text, m.images));
    if (this.turn) {
      const turn = this.turn;
      const steer: Promise<void> = server.request('turn/steer', { threadId: this.thread, expectedTurnId: turn, input: given }).then(
        () => {},
        // the turn ended meanwhile, or takes no steering: the next one takes it, before what came since
        () => void (this.closed || this.queue.unshift(...waiting)),
      );
      this.steering = steer;
      void steer.then(() => {
        this.steering = undefined;
        if (!this.finishing) this.pump();
      });
      return;
    }
    this.starting = true;
    this.failure = undefined;
    server
      .request<{ turn: { id: string } }>('turn/start', { threadId: this.thread, input: given, ...(this.effort ? { effort: this.effort } : {}) })
      .then(
        (r) => {
          // a quick turn may have started and ended before its start's answer is read
          if (!this.ended.has(r.turn.id)) this.turn ??= r.turn.id;
        },
        (e) => {
          if (this.closed) return;
          this.emit({ type: 'error', message: messageOf(e) });
          this.emit({ type: 'idle', background: 0 });
        },
      )
      .finally(() => {
        this.starting = false;
        this.pump();
      });
  }

  private heard(method: string, p: Record<string, unknown>) {
    if (this.closed) return;
    if (p.threadId !== undefined && p.threadId !== this.thread) return;
    switch (method) {
      case 'turn/started':
        this.turn = (p.turn as { id: string }).id;
        return;
      case 'account/rateLimits/updated':
        this.limits = p.rateLimits as RateSnapshot;
        return;
      case 'thread/tokenUsage/updated':
        this.tokens = (p.tokenUsage as { total?: CodexTokens } | undefined)?.total ?? this.tokens;
        return;
      case 'error': {
        const e = p as { error: { message: string; codexErrorInfo?: unknown }; willRetry: boolean };
        if (!e.willRetry) this.failure = { message: e.error.message, info: e.error.codexErrorInfo };
        return;
      }
      case 'item/started': {
        const item = p.item as Item;
        // a call no hook told of (a Codex without hooks, a host without curl) is watched as late as Codex reports it
        const unhooked = this.spec.watch && (item.type === 'commandExecution' || item.type === 'fileChange') && !this.hooked.has(item.id);
        for (const call of itemCalls(item)) {
          this.emit({ type: 'tool', name: call.name, input: call.input });
          if (unhooked) void this.watch((w) => w.before(call));
        }
        return;
      }
      case 'item/completed': {
        const item = p.item as Item;
        if (item.type === 'agentMessage' && item.text?.trim()) this.emit({ type: 'text', text: item.text });
        if ((item.type === 'commandExecution' || item.type === 'fileChange') && this.spec.watch && !this.hooked.delete(item.id)) {
          for (const call of itemCalls(item)) void this.watch((w) => w.after(call));
        }
        // what changed meanwhile goes with the step, as Claude Code's agent reads it with a tool's result
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
          const update = this.spec.contextUpdate?.();
          if (update) this.send(update);
        }
        return;
      }
      case 'item/autoApprovalReview/completed': {
        const r = p as { review?: { status?: string; rationale?: string | null }; action?: { command?: string } };
        if (r.review?.status !== 'denied') return;
        const rationale = r.review.rationale?.trim();
        this.emit({ type: 'denied', name: 'Bash', input: r.action?.command ? { command: r.action.command } : {}, by: 'classifier', ...(rationale ? { reason: rationale } : {}) });
        return;
      }
      case 'turn/completed': {
        const turn = p.turn as { id: string; status: string; error?: { message: string; codexErrorInfo?: unknown } | null };
        this.ended.add(turn.id);
        if (this.turn === turn.id || !this.turn) this.turn = undefined;
        const failed = turn.status === 'failed' ? (turn.error ? { message: turn.error.message, info: turn.error.codexErrorInfo } : (this.failure ?? { message: 'the turn failed' })) : undefined;
        this.failure = undefined;
        // a steer still under way either went into this turn or waits for the next: the end says which
        this.finishing = true;
        void (this.steering ?? Promise.resolve()).then(() => {
          this.finishing = false;
          if (this.closed) return;
          const usd = this.tokens ? codexCost(this.modelId, this.tokens) : 0;
          if (usd > 0) this.emit({ type: 'spend', session: `${CODEX_SESSION}${this.thread}`, usd });
          if (failed) {
            const limited = failed.info === 'usageLimitExceeded';
            const resetsAt = limited ? limitResets(this.limits) : undefined;
            const message = codexLoginFailed(failed.info, failed.message) ? notLoggedIn(this.there?.host.name ?? null, failed.message) : failed.message;
            this.emit({ type: 'error', message, ...(limited ? { limit: resetsAt ? { resetsAt } : {} } : {}) });
          }
          this.emit({ type: 'idle', background: 0, ...(this.queue.length ? { more: true } : {}) });
          this.pump();
        });
        return;
      }
    }
  }

  /** Tells the folder's watch of a step, after those before it; settles once it is done. */
  private watch(step: (w: NonNullable<AgentSpec['watch']>) => Promise<void>): Promise<void> {
    const w = this.spec.watch!;
    this.watching = this.watching.then(() => step(w)).catch((e) => console.error(`Obeya: a folder's watch failed: ${messageOf(e)}`));
    return this.watching;
  }

  private async asked(method: string, p: Record<string, unknown>): Promise<unknown> {
    const spec = this.spec;
    switch (method) {
      case 'item/tool/call': {
        const tool = spec.tools.find((t) => t.name === p.tool);
        if (!tool) return { contentItems: [{ type: 'inputText', text: `No tool ${String(p.tool)} here.` }], success: false };
        let text: string;
        let success = true;
        try {
          text = await tool.run((p.arguments ?? {}) as Record<string, unknown>);
        } catch (e) {
          text = messageOf(e);
          success = false;
        }
        const update = spec.contextUpdate?.();
        return { contentItems: [{ type: 'inputText', text: update ? `${text}\n\n${update}` : text }], success };
      }
      case 'item/commandExecution/requestApproval': {
        const command = typeof p.command === 'string' ? bareCommand(p.command) : '';
        return { decision: (await this.ask('Bash', command ? { command } : {}, p.reason)) ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval':
        return { decision: (await this.ask('Edit', typeof p.grantRoot === 'string' ? { file_path: p.grantRoot } : {}, p.reason)) ? 'accept' : 'decline' };
      case 'item/permissions/requestApproval':
        return (await this.ask('Permissions', (p.permissions ?? {}) as Record<string, unknown>, p.reason)) ? { permissions: p.permissions ?? {}, scope: 'turn' } : { permissions: {}, scope: 'turn' };
      case 'execCommandApproval': {
        const command = Array.isArray(p.command) ? (p.command as string[]).join(' ') : String(p.command ?? '');
        return { decision: (await this.ask('Bash', { command: bareCommand(command) }, p.reason)) ? 'approved' : { denied: { rejection: 'The owner refused it.' } } };
      }
      case 'applyPatchApproval':
        return { decision: (await this.ask('Edit', {}, p.reason)) ? 'approved' : { denied: { rejection: 'The owner refused it.' } } };
      case 'item/tool/requestUserInput':
        // Codex's own question tool has nobody to answer it in Obeya; the agent's tools of Obeya do
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new CodexError(`${method} is not handled`);
    }
  }

  /** Asks the owner about a call that needs a person's permission; without anyone to ask it is refused. */
  private async ask(name: string, input: Record<string, unknown>, reason: unknown): Promise<boolean> {
    const why = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
    if (!this.spec.askOwner) {
      this.emit({ type: 'denied', name, input, by: 'mode', ...(why ? { reason: why } : {}) });
      return false;
    }
    const abort = new AbortController();
    void this.done.finally(() => abort.abort());
    const answer = await this.spec.askOwner({ name, input, ...(why ? { reason: why } : {}) }, abort.signal);
    return answer.allow;
  }
}

/** A model as `model/list` gives it. */
interface ListedModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
}

/** The models Codex offers the login, in its order, without hidden ones; the efforts each takes among Obeya's. */
export function modelsOf(listed: ListedModel[]): HarnessModel[] {
  return listed
    .filter((m) => !m.hidden)
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e): e is AgentEffort => AGENT_EFFORTS.some((x) => x === e));
      return { id: m.id, ...(m.displayName ? { name: m.displayName } : {}), ...(efforts.length ? { efforts } : {}), ...(m.isDefault ? { isDefault: true as const } : {}) };
    });
}

/** Asks a short-lived app server `ask` and closes it. */
async function once<T>(cwd: string, ask: (s: AppServer) => Promise<T>, env: Env = process.env): Promise<T> {
  const bin = codexExecutable(env);
  if (!bin) throw new Error(NOT_INSTALLED);
  const server = new AppServer({ bin, cwd, env: cleanEnv(env) });
  const timer = setTimeout(() => server.close(), 30_000);
  try {
    await server.init();
    return await ask(server);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** The models an app server offers its login, every page of them. */
async function listModels(server: AppServer): Promise<HarnessModel[]> {
  const models: ListedModel[] = [];
  let cursor: string | null | undefined;
  do {
    const r = await server.request<{ data: ListedModel[]; nextCursor?: string | null }>('model/list', cursor ? { cursor } : {});
    models.push(...r.data);
    cursor = r.nextCursor;
  } while (cursor);
  return modelsOf(models);
}

/** The models Codex offers the login on this machine. */
export const codexModels = (cwd: string): Promise<HarnessModel[]> => once(cwd, listModels);

/** The kind and group a window takes by its length: five hours is the session's, a week the week's. */
function windowKind(minutes: number | null): { kind: string; group: string } {
  if (minutes === 300) return { kind: 'session', group: 'session' };
  if (minutes === 10_080) return { kind: 'weekly_all', group: 'weekly' };
  if (minutes !== null && minutes < 1440) return { kind: 'session', group: 'session' };
  return { kind: 'weekly_all', group: 'weekly' };
}

/** The grade of a window, which Codex does not give: used up, close to it, or normal. */
const severity = (percent: number) => (percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'normal');

/**
 * The limits of a `account/rateLimits/read` answer: the five-hour and the weekly window of each
 * metered bucket, a bucket other than Codex's own (a model's) named as its scope. Null where the
 * login has none (an API key).
 */
export function codexUsageOf(r: { rateLimits?: RateSnapshot | null; rateLimitsByLimitId?: Record<string, RateSnapshot | undefined> | null }, now = new Date()): PlanLimits | null {
  const buckets = Object.values(r.rateLimitsByLimitId ?? {}).filter((b): b is RateSnapshot => !!b);
  if (!buckets.length && r.rateLimits) buckets.push(r.rateLimits);
  const limits = buckets.flatMap((b): UsageLimit[] => {
    const scope = b.limitId && b.limitId !== 'codex' ? (b.limitName ?? b.limitId) : undefined;
    return [b.primary, b.secondary].flatMap((w) => {
      if (!w) return [];
      const { kind, group } = windowKind(w.windowDurationMins);
      return [{ kind: scope ? 'weekly_scoped' : kind, group, ...(scope ? { scope } : {}), percent: w.usedPercent, ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}), ...(w.windowDurationMins ? { windowMinutes: w.windowDurationMins } : {}), severity: severity(w.usedPercent) }];
    });
  });
  return limits.length ? { limits, at: now.toISOString() } : null;
}

/** An idle app server in `cwd` asked for the login's rate limits; it sends no prompt, so it uses none of them. */
export function codexUsage(cwd: string): UsageSource {
  const bin = codexExecutable();
  let server: AppServer | undefined;
  let ready: Promise<AppServer> | undefined;
  const open = () => {
    if (!bin) return Promise.reject(new Error(NOT_INSTALLED));
    server = new AppServer({ bin, cwd, env: cleanEnv() });
    const s = server;
    return s.init().then(() => s);
  };
  return {
    fetch: async () => {
      const s = await (ready ??= open());
      return codexUsageOf(await s.request('account/rateLimits/read', null));
    },
    close: () => server?.close(),
  };
}

/** Where a login to Codex stands: waiting for the browser's return from the sign-in, done, or failed. */
export interface CodexLoginState {
  state: 'waiting' | 'done' | 'failed';
  error?: string;
}

/** How long a login waits for the owner to sign in before it gives up. */
const LOGIN_WAIT = 10 * 60_000;
/** The port Codex's sign-in returns to, on the loopback of the machine Codex runs on. */
const LOGIN_PORT = 1455;

/**
 * Logins to Codex started from a card whose session lost its login: an app server asked for
 * ChatGPT's sign-in (`account/login/start`), whose page the owner opens in the browser here; the
 * sign-in returns to a port on this machine, where Codex listens. For a host the app server runs
 * there, with that port forwarded to it, so its own login is renewed. One at a time, as the port is.
 */
export class CodexLogins {
  private logins = new Map<string, { state: CodexLoginState; server: AppServer }>();

  constructor(private env: Env = process.env) {}

  async start(host: SshHost | null): Promise<{ id: string; url: string }> {
    for (const [id, l] of this.logins) if (l.state.state === 'waiting') this.end(id, { state: 'failed', error: 'another login started' });
    let server: AppServer;
    if (host) {
      const argv = host.argv(['codex', 'app-server'], { local: `localhost:${LOGIN_PORT}:localhost:${LOGIN_PORT}` });
      server = new AppServer({ process: spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    } else {
      const bin = codexExecutable(this.env);
      if (!bin) throw new Error(NOT_INSTALLED);
      server = new AppServer({ bin, cwd: tmpdir(), env: cleanEnv(this.env) });
    }
    const id = randomBytes(9).toString('base64url');
    const login = { state: { state: 'waiting' } as CodexLoginState, server };
    let loginId: string | undefined;
    server.onNotification = (method, p) => {
      if (method !== 'account/login/completed' || (loginId && p.loginId && p.loginId !== loginId)) return;
      this.end(id, p.success ? { state: 'done' } : { state: 'failed', error: typeof p.error === 'string' ? p.error : 'the sign-in failed' });
    };
    try {
      await server.init();
      const r = await server.request<{ type: string; authUrl?: string; loginId?: string }>('account/login/start', { type: 'chatgpt' });
      if (!r.authUrl) throw new Error('Codex gave no sign-in page');
      loginId = r.loginId;
      this.logins.set(id, login);
      void server.exited.then(() => login.state.state === 'waiting' && this.end(id, { state: 'failed', error: withStderr(ENDED, server.stderr) }));
      setTimeout(() => login.state.state === 'waiting' && this.end(id, { state: 'failed', error: 'nobody signed in' }), LOGIN_WAIT).unref?.();
      return { id, url: r.authUrl };
    } catch (e) {
      server.close();
      throw new Error(withStderr(messageOf(e), server.stderr));
    }
  }

  /** Where the login `id` stands; one Obeya does not know (from before a restart, say) has failed. */
  state(id: string): CodexLoginState {
    return this.logins.get(id)?.state ?? { state: 'failed', error: 'no such login' };
  }

  private end(id: string, state: CodexLoginState) {
    const l = this.logins.get(id);
    if (!l) return;
    l.state = state;
    l.server.close();
  }
}
