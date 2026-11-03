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
// What Claude Code gives Obeya and Codex does not: a long wait in the foreground is not refused
// before it runs, and a folder without git hears of a change as Codex reports it, not before.

import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { messageOf } from '../core/text';
import type { AgentEffort, HarnessModel, UsageLimit } from '../core/types';
import { AGENT_EFFORTS } from '../core/types';
import type { ToolCall } from './folder';
import { hostName } from './hosts';
import { which } from './path';
import { CODEX_SESSION, type AgentEvent, type AgentRuntime, type AgentSession, type AgentSpec, cleanEnv, trackHere, withStderr } from './runtime';
import { OWN_GROUP } from './spawn';
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


/** What the CLI says on stdout and stderr, and whether it ended well; null where it could not start or took too long. */
export function runCodex(bin: string, args: string[], env: Env, ms = 15_000): Promise<{ ok: boolean; out: string } | null> {
  return new Promise((done) => {
    const argv = startArgv(bin, args);
    let out = '';
    let p: ChildProcess;
    try {
      p = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...spawnOptions(argv) });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => (p.kill(), done(null)), ms);
    p.stdout!.on('data', (d) => (out += d));
    p.stderr!.on('data', (d) => (out += d));
    p.on('error', () => (clearTimeout(timer), done(null)));
    p.on('close', (code) => (clearTimeout(timer), done({ ok: code === 0, out: out.trim() })));
  });
}

/** The CLI's version (`codex-cli 0.159.2`), or null where it does not answer. */
export async function codexVersion(bin: string, env: Env): Promise<string | null> {
  const r = await runCodex(bin, ['--version'], env);
  return r?.ok ? (r.out.match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null) : null;
}

/** Whether the CLI is logged in, and how it says so („Logged in using ChatGPT“). */
export async function codexLogin(bin: string, env: Env): Promise<{ loggedIn: boolean; how?: string }> {
  const r = await runCodex(bin, ['login', 'status'], env);
  if (!r?.ok) return { loggedIn: false };
  const how = r.out.match(/logged in using (.+)/i)?.[1]?.trim();
  return { loggedIn: true, ...(how ? { how } : {}) };
}

/** A failure the app server reported for a request. */
export class CodexError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** How much of what the app server said last on stderr a session that ended reports. */
const STDERR_TAIL = 2000;

/**
 * A `codex app-server` process and the JSON-RPC connection over its stdio: requests out and their
 * answers, notifications in, and the server's own requests (a tool call, an approval), answered by
 * `onRequest`.
 */
export class AppServer {
  private proc: ChildProcess;
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  /** The process has ended: a request gets no answer any more. */
  private dead = false;
  stderr = '';
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async (method) => {
    throw new CodexError(`${method} is not handled`);
  };
  /** Settles with the exit code once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(o: { bin: string; cwd: string; env: Env; args?: string[] }) {
    const argv = startArgv(o.bin, ['app-server', ...(o.args ?? [])]);
    this.proc = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP, ...spawnOptions(argv) });
    trackHere(this.proc);
    this.exited = new Promise((resolve) => {
      this.proc.once('error', (e) => ((this.stderr += e.message), resolve(null)));
      this.proc.once('close', (code) => resolve(code));
    });
    void this.exited.then(() => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new CodexError(withStderr('the Codex app server ended', this.stderr)));
      this.pending.clear();
    });
    this.proc.stdout!.setEncoding('utf8').on('data', (d: string) => this.take(d));
    this.proc.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-STDERR_TAIL)));
    // a closed pipe as the process ends is no error of Obeya's
    this.proc.stdin!.on('error', () => {});
  }

  /** Initializes the connection, with the experimental API that dynamic tools need. */
  async init(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'obeya', title: 'Obeya', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify('initialized');
  }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    if (this.dead) return Promise.reject(new CodexError(withStderr('the Codex app server ended', this.stderr)));
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
    endTree(this.proc);
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

/** A shell's own wrapper around a command (`/bin/zsh -lc 'git status'`), which the log line leaves out. */
export function bareCommand(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([^]*)\1$/.exec(command.trim());
  return m ? m[2]!.replace(/'\\''/g, "'") : command;
}

/** The tool calls an item stands for, named as Claude Code's are, so the card's log and a folder's watch read them alike. */
export function itemCalls(item: Item): ToolCall[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ id: item.id, name: 'Bash', input: { command: bareCommand(item.command ?? '') } }];
    case 'fileChange':
      return (item.changes ?? []).map((c, i) => {
        const kind = typeof c.kind === 'string' ? c.kind : (c.kind?.type ?? '');
        return { id: `${item.id}:${i}`, name: kind === 'add' ? 'Write' : 'Edit', input: { file_path: c.path } };
      });
    case 'dynamicToolCall':
      return [{ id: item.id, name: `mcp__${item.namespace ?? 'obeya'}__${item.tool}`, input: (item.arguments ?? {}) as Record<string, unknown> }];
    case 'mcpToolCall':
      return [{ id: item.id, name: `mcp__${item.server}__${item.tool}`, input: (item.arguments ?? {}) as Record<string, unknown> }];
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

/** The git directory a worktree commits into, outside the worktree itself; nothing for a clone. */
async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && out && !out.startsWith(cwd) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** A tool's input schema as JSON Schema, for a dynamic tool. */
function jsonSchema(shape: z.ZodRawShape): unknown {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

/** What a session that ends without a turn's result says: the server's last words on stderr. */
function ended(code: number | null, stderr: string): string {
  return withStderr(`the Codex app server exited${code === null ? '' : ` with code ${code}`}`, stderr);
}

/** Whether a turn's error says Codex is not logged in. */
export function codexLoginFailed(info: unknown, message: string): boolean {
  return info === 'unauthorized' || /\bcodex login\b|\bnot logged in\b|\b401 Unauthorized\b/i.test(message);
}

/** Runs agents through `codex app-server`, on the Codex login of this machine. */
export const codexRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    if (hostName(spec.cwd) !== null) {
      // hosts run Claude Code (withAgentSetting); a session that gets here anyway says why it does not start
      const done = Promise.resolve().then(() => spec.onEvent({ type: 'error', message: 'Codex runs only on the machine Obeya runs on' }));
      return { send: () => {}, close: () => {}, done };
    }
    return new CodexSession(spec, firstMessage, images);
  },
};

class CodexSession implements AgentSession {
  readonly done: Promise<void>;
  private server: AppServer | undefined;
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
  private limits: RateSnapshot | undefined;
  /** The error a failed turn reports, as the server said it while it went (`error`, `willRetry: false`). */
  private failure: { message: string; info?: unknown } | undefined;
  /** A folder's watch hears of calls one after the other. */
  private watching: Promise<void> = Promise.resolve();

  constructor(
    private spec: AgentSpec,
    firstMessage: string | undefined,
    images: string[] | undefined,
  ) {
    if (firstMessage !== undefined) this.queue.push({ text: firstMessage, images });
    this.done = this.run().catch((e) => {
      if (!this.closed) this.emit({ type: 'error', message: withStderr(messageOf(e), this.server?.stderr ?? '') });
    });
  }

  send(text: string, images?: string[]) {
    if (this.closed) return;
    this.queue.push({ text, images });
    this.pump();
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.server?.close();
  }

  private emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }

  private async run() {
    const spec = this.spec;
    const bin = codexExecutable({ ...process.env, ...spec.env });
    if (!bin) throw new Error('Codex is not installed on this machine: no `codex` on the PATH');
    const writable = [...(spec.dirs ?? []), tmpdir()];
    const common = spec.readOnly ? undefined : await gitCommonDir(spec.cwd);
    if (common) writable.push(common);
    if (this.closed) return;
    const server = (this.server = new AppServer({ bin, cwd: spec.cwd, env: { ...cleanEnv(), ...spec.env } }));
    server.onNotification = (method, params) => this.heard(method, params);
    server.onRequest = (method, params) => this.asked(method, params);
    const exited = server.exited;
    await server.init();
    if (spec.plugins?.length) await server.request('skills/extraRoots/set', { extraRoots: spec.plugins.map((p) => `${p}/skills`) }).catch(() => {});
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
    };
    const settings = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      approvalPolicy: spec.readOnly ? 'never' : 'on-request',
      ...(spec.readOnly ? {} : { approvalsReviewer: 'auto_review' }),
      sandbox: spec.readOnly ? 'read-only' : 'workspace-write',
      config,
      developerInstructions: spec.system,
    };
    const opened = spec.resume
      ? await server.request<{ thread: { id: string } }>('thread/resume', { threadId: spec.resume.replace(CODEX_SESSION, ''), excludeTurns: true, ...settings })
      : await server.request<{ thread: { id: string } }>('thread/start', {
          ...settings,
          dynamicTools: spec.tools.length
            ? [{ type: 'namespace', name: 'obeya', description: "Obeya's tools: how this agent talks to the owner and to Obeya.", tools: spec.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: jsonSchema(t.schema) })) }]
            : [],
        });
    this.thread = opened.thread.id;
    this.emit({ type: 'session', id: `${CODEX_SESSION}${this.thread}` });
    this.pump();
    const code = await exited;
    if (!this.closed) this.emit({ type: 'error', message: ended(code, server.stderr) });
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
      .request<{ turn: { id: string } }>('turn/start', { threadId: this.thread, input: given, ...(this.spec.effort ? { effort: this.spec.effort } : {}) })
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
      case 'error': {
        const e = p as { error: { message: string; codexErrorInfo?: unknown }; willRetry: boolean };
        if (!e.willRetry) this.failure = { message: e.error.message, info: e.error.codexErrorInfo };
        return;
      }
      case 'item/started': {
        const item = p.item as Item;
        for (const call of itemCalls(item)) {
          this.emit({ type: 'tool', name: call.name, input: call.input });
          if (this.spec.watch && (item.type === 'commandExecution' || item.type === 'fileChange')) this.watch((w) => w.before(call));
        }
        return;
      }
      case 'item/completed': {
        const item = p.item as Item;
        if (item.type === 'agentMessage' && item.text?.trim()) this.emit({ type: 'text', text: item.text });
        if (item.type === 'commandExecution' || item.type === 'fileChange') {
          if (this.spec.watch) for (const call of itemCalls(item)) this.watch((w) => w.after(call));
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
          if (failed) {
            const limited = failed.info === 'usageLimitExceeded';
            const resetsAt = limited ? limitResets(this.limits) : undefined;
            const message = codexLoginFailed(failed.info, failed.message) ? `Codex is not logged in on this machine: run “codex login” in a terminal. (${failed.message})` : failed.message;
            this.emit({ type: 'error', message, ...(limited ? { limit: resetsAt ? { resetsAt } : {} } : {}) });
          }
          this.emit({ type: 'idle', background: 0, ...(this.queue.length ? { more: true } : {}) });
          this.pump();
        });
        return;
      }
    }
  }

  private watch(step: (w: NonNullable<AgentSpec['watch']>) => Promise<void>) {
    const w = this.spec.watch!;
    this.watching = this.watching.then(() => step(w)).catch((e) => console.error(`Obeya: a folder's watch failed: ${messageOf(e)}`));
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
  if (!bin) throw new Error('Codex is not installed on this machine');
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

/** The models Codex offers the login on this machine. */
export async function codexModels(cwd: string): Promise<HarnessModel[]> {
  return once(cwd, async (s) => {
    const models: ListedModel[] = [];
    let cursor: string | null | undefined;
    do {
      const r = await s.request<{ data: ListedModel[]; nextCursor?: string | null }>('model/list', cursor ? { cursor } : {});
      models.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
    return modelsOf(models);
  });
}

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
      return [{ kind: scope ? 'weekly_scoped' : kind, group, ...(scope ? { scope } : {}), percent: w.usedPercent, ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}), severity: severity(w.usedPercent) }];
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
    if (!bin) return Promise.reject(new Error('Codex is not installed on this machine'));
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
