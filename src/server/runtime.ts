// Agent sessions behind a small interface, so the orchestration can be tested without a model.

import {
  createSdkMcpServer,
  type HookInput,
  type HookJSONOutput,
  type PermissionMode,
  query,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { LOST, remote, sessionFiles, type SshHost } from './hosts';
import { localBin, which } from './path';
import type { z } from 'zod';
import { filesIn } from './files';
import { mediaType } from './images';
import { COMPILED } from './resources';
import { OWN_GROUP } from './spawn';
import { withoutHeredocs } from './shell';
import type { Messages } from '../core/messages';
import type { ToolCall, ToolWatch } from './folder';
import { agentDefault, type AgentEffort, type AgentRole, type AgentSetting, type CardAgent, type Harness, storedModel } from '../core/types';
import { messageOf } from '../core/text';
import { within } from '../core/late';
import { claudeLoginFailed, codexLoginLost } from '../core/login';

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Returns the text the agent sees as the tool result. */
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export type AgentEvent =
  /** The session's id, once it started or resumed, and the model it runs on as the harness names it, where it says. */
  | { type: 'session'; id: string; model?: string; effort?: AgentEffort }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  /**
   * A tool call was refused without anyone being asked: by a rule of the settings, auto mode's
   * classifier, the permission mode, a hook (`obeya`: Obeya's own, `refuseForegroundWait`).
   * `reason`: the deciding component's own words, when it gave any.
   */
  | { type: 'denied'; name: string; input: Record<string, unknown>; by: DeniedBy; reason?: string }
  /**
   * The turn ended; the session waits for the next message. `background` counts the agent's
   * background tasks still running: when one ends, the session wakes itself for a new turn.
   * `more`: a message sent during the turn came too late for it and starts a turn of its own,
   * which follows without another message.
   */
  | { type: 'idle'; background?: number; more?: boolean }
  /**
   * What the session cost so far in US dollars, as its harness estimates it at API list prices
   * (Claude Code's own estimate; Codex's tokens at `codexCost`'s), after each of its turns: a running
   * total, which a resumed session goes on from where its harness kept it. `withSpend` takes it.
   */
  | { type: 'spend'; session: string; usd: number }
  /**
   * The agent's background tasks still running changed, in a turn or between turns: a deploy
   * watcher that ends, say, which then wakes the session. `tasks`: all that run now, by the SDK's id.
   */
  | { type: 'background'; tasks: { id: string; description: string }[] }
  /**
   * The session's machine is out of reach (a worker on an SSH host whose connection failed or
   * dropped): the session has ended, and resumes by its id once the host answers again.
   */
  | { type: 'lost'; message: string }
  /**
   * The turn failed. `limit` when the account's usage limit stopped it (the five-hour session
   * limit, say): it lifts again at `resetsAt` (milliseconds) when the API said when. `token` when
   * the session signed in with a token rather than this machine's account (`CardEvent.token`).
   */
  | { type: 'error'; message: string; limit?: { resetsAt?: number }; token?: true };

/** Who refused a tool call (`SDKPermissionDeniedMessage.decision_reason_type`, sorted). */
export type DeniedBy = 'rule' | 'classifier' | 'mode' | 'hook' | 'obeya' | 'other';

/** A tool call the settings want a person to confirm (an `ask` rule, a safety check). */
export interface PermissionRequest {
  name: string;
  input: Record<string, unknown>;
  /** Why it is asked, when Claude Code says. */
  reason?: string;
}

export type PermissionAnswer = { allow: true } | { allow: false; message: string };

export interface AgentSpec {
  /** Where the agent works; a workspace on another machine (`ssh://<host>/…`) runs it there (`hosts.ts`). */
  cwd: string;
  /** Appended to the default system prompt. */
  system: string;
  /** Tools the agent reaches as `mcp__obeya__<name>`. */
  tools: AgentTool[];
  /** Resume this session instead of starting one. */
  resume?: string;
  /** Directories outside `cwd` the agent works in as in its own (a looked-up thread's output directory). */
  dirs?: string[];
  /** Read-only agents get no tools that change files or run commands. */
  readOnly?: boolean;
  /**
   * The repository's own Claude Code settings in `cwd` wait for the owner to confirm them
   * (`withRepoTrust`): the session reads the user's settings alone, none of the repository's.
   */
  untrusted?: boolean;
  /** Directories of local Claude Code plugins loaded into the session (skills, mainly). */
  plugins?: string[];
  permissionMode?: PermissionMode;
  /** Added to the agent's environment (Obeya's own, cleaned). */
  env?: Record<string, string>;
  /** How much the model thinks; low for quick, small jobs. */
  effort?: AgentEffort;
  /** The model, when not the default: a smaller one for small, frequent jobs; for Codex a family, its newest model on the machine the agent runs on. */
  model?: string;
  /** The group the agent belongs to, whose harness, model and effort the owner chooses (`withAgentSetting`). */
  role?: AgentRole;
  /** The harness, model and effort the owner chose for this one agent (a card's), over its group's where it names them. */
  agent?: CardAgent;
  /** The card the agent works for (a worker's, an idea's, a project's): its cost counts to that card; without one, to the canvas alone (`withSpend`). */
  spendOn?: string;
  /** The harness it runs on (`byHarness`): Claude Code where none is named. */
  harness?: Harness;
  /**
   * Asked after every tool step of the agent's own (not a subagent's): what changed since the
   * session's instructions were built, or what waited for its next step, for the agent to read with
   * that step's result without being stopped; nothing when nothing did. Asking takes it: it is read.
   */
  contextUpdate?: () => string | undefined;
  /**
   * Told before and after each tool call of the agent and its subagents, and waited for: what a
   * call changes in a folder without git becomes the card's (`FolderWorkspaces.watch`).
   */
  watch?: ToolWatch;
  /**
   * Asked when a tool call needs a person's permission; settles with their answer. Without it such a
   * call is refused, as in any session without someone to ask.
   */
  askOwner?: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
  /**
   * The agent waits for the account's usage limit instead of failing on it (`withLimitWait`): a turn
   * the limit stops is neither an error nor over, and this hears when the agent goes on by itself,
   * and nothing once it does or its session ends. Without it, the turn fails with the error's `limit`.
   */
  onLimit?: (until: number | undefined) => void;
  onEvent: (e: AgentEvent) => void;
}

export interface AgentSession {
  /** Sends a user message, with images (files) after the text; the session takes it at the next opportunity. */
  send(text: string, images?: string[]): void;
  /** Ends the session after the current step. */
  close(): void;
  /** Settles when the session has ended. */
  done: Promise<void>;
}

export interface AgentRuntime {
  /** Without a first message the agent starts up and waits, so a later `send` skips the start-up. */
  start(spec: AgentSpec, firstMessage?: string, images?: string[]): AgentSession;
}

/** A Codex thread's id as Obeya keeps it for a session (`AgentEvent` `session`), told apart from a Claude Code session's. */
export const CODEX_SESSION = 'codex:';

/** The harness a kept session runs on: Codex's threads carry their mark (`CODEX_SESSION`). */
export const sessionHarness = (session: string): Harness => (session.startsWith(CODEX_SESSION) ? 'codex' : 'claude');

/**
 * A runtime that starts each agent of a group on its group's harness, model and effort
 * (`agentSetting`), asked at every start, or on the harness and model and the effort chosen for that
 * agent alone (a card's), each where it names one. Claude Code's default model is no model given;
 * a Codex agent always gets a family (`codexFamily`), which its session resolves to a model. A session
 * resumed stays on the harness it began on, with that harness's preset model if the choice has
 * moved on since, so a card goes on with its conversation.
 */
export function withAgentSetting(runtime: AgentRuntime, setting: (role: AgentRole) => AgentSetting): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      if (!spec.role) return runtime.start(spec, firstMessage, images);
      const group = setting(spec.role);
      const own = spec.agent;
      const chosen: AgentSetting = { ...group, ...(own?.harness && own.model ? { harness: own.harness, model: own.model } : {}), ...(own?.effort ? { effort: own.effort } : {}) };
      const on: Harness = spec.resume ? sessionHarness(spec.resume) : chosen.harness;
      const { harness, model, effort } = on === chosen.harness ? chosen : { ...agentDefault(spec.role, on), effort: chosen.effort };
      const { model: _, agent: __, ...rest } = spec;
      const given = storedModel(harness, model);
      return runtime.start({ ...rest, harness, effort, ...(given === 'default' ? {} : { model: given }) }, firstMessage, images);
    },
  };
}

/**
 * A runtime whose agents' costs go to `record` (`spend` events, which the agent's own handler never
 * hears): by the card each works for (`AgentSpec.spendOn`), else as the canvas's own.
 */
export function withSpend(runtime: AgentRuntime, record: (card: string | undefined, session: string, usd: number) => void): AgentRuntime {
  return {
    start: (spec, firstMessage, images) =>
      runtime.start({ ...spec, onEvent: (e) => (e.type === 'spend' ? record(spec.spendOn, e.session, e.usd) : spec.onEvent(e)) }, firstMessage, images),
  };
}

/** A runtime that starts each agent on the harness its spec names (`withAgentSetting`), else the one of the session it resumes, else Claude Code. */
export function byHarness(runtimes: Record<Harness, AgentRuntime>): AgentRuntime {
  return { start: (spec, firstMessage, images) => runtimes[spec.harness ?? (spec.resume ? sessionHarness(spec.resume) : 'claude')].start(spec, firstMessage, images) };
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** From the checkout: the machine's own Claude Code, once a look found it newer than the SDK's (`findClaude`). */
let newerHere: string | undefined;

/** Has the checkout's agents run on the machine's own Claude Code (`path`), or on the SDK's again (none). */
export function runClaudeHere(path: string | undefined) {
  newerHere = path;
}

/**
 * The Claude Code the agents run on: the one `OBEYA_CLAUDE` names; from the checkout, the binary
 * the Agent SDK brings for this platform (undefined: the SDK finds it itself), unless the machine's
 * own installation is newer (`runClaudeHere`); in the compiled binary, which carries none, the
 * machine's own installation (`machineClaude`).
 */
export function claudeExecutable(env: Record<string, string | undefined> = process.env, compiled = COMPILED, platform: string = process.platform): string | undefined {
  if (env.OBEYA_CLAUDE) return env.OBEYA_CLAUDE;
  if (!compiled) return newerHere;
  return machineClaude(env, platform);
}

/**
 * The machine's own Claude Code: on the PATH or where the official installer puts it (a path that
 * does not exist when there is none, for the SDK to say so).
 */
export function machineClaude(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const installed = join(localBin(), platform === 'win32' ? 'claude.exe' : 'claude');
  const onPath = which('claude', env);
  // npm's `claude.cmd` on Windows is no program to start; the installer's binary is
  return onPath && !/\.(cmd|bat|ps1)$/i.test(onPath) ? onPath : installed;
}

/**
 * Whether a session here gets Claude in Chrome (`--chrome`): when Claude Code's own config shows the
 * extension (found in a browser profile, or paired) and the integration is not turned off there or
 * in `CLAUDE_CODE_ENABLE_CFC`. Without the extension the flag would only have Claude Code write its
 * native-host manifests for every browser it knows, and it would override the owner's "off".
 */
export function chromeAvailable(env: Record<string, string | undefined> = process.env, home = homedir()): boolean {
  if (/^(0|false|no|off)$/i.test(env.CLAUDE_CODE_ENABLE_CFC ?? '')) return false;
  let config: { claudeInChromeDefaultEnabled?: boolean; cachedChromeExtensionInstalled?: boolean; chromeExtension?: { pairedDeviceId?: string } };
  try {
    config = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), 'utf8'));
  } catch {
    return false;
  }
  if (config?.claudeInChromeDefaultEnabled === false) return false;
  return config?.cachedChromeExtensionInstalled === true || Boolean(config?.chromeExtension?.pairedDeviceId);
}

/**
 * A runtime that starts each agent working in a repository whose own Claude Code settings wait for
 * the owner's confirmation (`untrusted`, by the agent's `cwd`) without them: their hooks, MCP
 * servers and helpers would run outside the permission checks. Claude Code then reads none of the
 * repository's files, its CLAUDE.md neither, so the agent gets that in its instructions instead.
 * Where finding that out takes git, the agent starts once git has answered (`startingLater`): the
 * server does not wait for it.
 */
export function withRepoTrust(runtime: AgentRuntime, untrusted: (cwd: string) => boolean | Promise<boolean>): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      // one already started without them (a review card's) brings its notes from elsewhere
      if (spec.untrusted) return runtime.start(spec, firstMessage, images);
      const start = (held: boolean) => {
        if (!held) return runtime.start(spec, firstMessage, images);
        const file = join(spec.cwd, 'CLAUDE.md');
        const notes = !remote(spec.cwd) && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
        const system = notes ? `${spec.system}\n\nThe repository's CLAUDE.md:\n\n${notes}` : spec.system;
        return runtime.start({ ...spec, untrusted: true, system }, firstMessage, images);
      };
      const held = untrusted(spec.cwd);
      if (typeof held === 'boolean') return start(held);
      // where it cannot be told, the repository's settings are not read
      return startingLater(
        held.catch(() => true).then((h) => () => start(h)),
        spec,
      );
    },
  };
}

/**
 * A session that starts once `starting` settles with how to start it: what it is sent meanwhile
 * reaches it then. Closed before, it never starts. One that fails to start ends with the error.
 */
export function startingLater(starting: Promise<() => AgentSession>, spec: AgentSpec): AgentSession {
  let session: AgentSession | undefined;
  let closed = false;
  const waiting: { text: string; images?: string[] }[] = [];
  const done = starting.then(async (start) => {
    if (closed) return;
    try {
      session = start();
    } catch (e) {
      spec.onEvent({ type: 'error', message: messageOf(e) });
      return;
    }
    for (const m of waiting.splice(0)) session.send(m.text, m.images);
    await session.done;
  });
  return {
    send: (text, images) => (session ? session.send(text, images) : void waiting.push({ text, images })),
    close: () => {
      closed = true;
      session?.close();
    },
    done,
  };
}

/** What an agent the usage limit stopped is told once it lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped your last turn has reset. Go on where you stopped.';

/** For an agent that waits for the usage limit with nowhere to show it (`AgentSpec.onLimit`): nobody waits for its result. */
export const waitQuietly = () => {};

/**
 * A runtime whose agents with `onLimit` wait for the account's usage limit: the turn it stopped
 * waits, without its error and its end, and `margin` after the limit lifts (`limitLifts`) the
 * session is told to go on where it stopped; one that runs into the limit again waits anew.
 */
export function withLimitWait(runtime: AgentRuntime, margin = 10_000): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      const onLimit = spec.onLimit;
      if (!onLimit) return runtime.start(spec, firstMessage, images);
      let lifts: ReturnType<typeof setTimeout> | undefined;
      // the end of the turn the limit stopped is not the end of its work
      let stopped = false;
      let closed = false;
      const session: AgentSession = runtime.start(
        {
          ...spec,
          onEvent: (e) => {
            if (e.type === 'error' && e.limit) {
              stopped = true;
              if (closed) return;
              const until = limitLifts(e.limit, margin);
              clearTimeout(lifts);
              // a timer runs at most about 24 days
              lifts = setTimeout(
                () => {
                  lifts = undefined;
                  onLimit(undefined);
                  session.send(LIMIT_LIFTED);
                },
                Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1),
              );
              onLimit(until);
            } else if (e.type === 'idle' && stopped) stopped = false;
            else spec.onEvent(e);
          },
        },
        firstMessage,
        images,
      );
      return {
        send: (text, images) => session.send(text, images),
        close: () => {
          closed = true;
          if (lifts) onLimit(undefined);
          clearTimeout(lifts);
          lifts = undefined;
          session.close();
        },
        done: session.done,
      };
    },
  };
}

/**
 * How long an agent waits before its process goes (`withRest`): past the longest prompt-cache
 * lifetime Claude Code uses (an hour, on a subscription; measured 2026-11-09), with a margin for the
 * time between the turn's last request and its end. Codex too: its cache has no fixed lifetime (hits
 * after four hours and misses after two, measured 2026-11-09), and a resumed Codex session reads it
 * as well as the process kept would have.
 */
export const REST_AFTER_MS = 65 * 60_000;

/**
 * A runtime whose sessions give up their process once they have waited `after` with nothing running
 * (their turn over, no background work), so a session waiting for the owner holds no memory. The
 * next message resumes the session by its id, as after a restart: its callers see one session
 * throughout. The resumed session pays for its conversation what the process kept would have paid
 * then: `after` lies past Claude Code's prompt-cache lifetime, so its cache is gone either way, and
 * Codex's is read by a resumed session as by a kept one.
 */
export function withRest(runtime: AgentRuntime, after = REST_AFTER_MS): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      let id = spec.resume;
      let session: AgentSession | undefined;
      // which process's events count: one given up says nothing more
      let generation = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      // the process given up last, which a resumed one waits for, so two never run on one session
      let gone: Promise<void> = Promise.resolve();
      // its turn is over, and no other follows by itself
      let waiting = false;
      let ended!: () => void;
      const done = new Promise<void>((r) => (ended = r));
      const rest = () => {
        timer = undefined;
        if (!session || !id || closed) return;
        const resting = session;
        session = undefined;
        generation++;
        resting.close();
        gone = resting.done;
      };
      const begin = (text?: string, given?: string[]) => {
        const mine = ++generation;
        const resumed: AgentSpec = {
            ...spec,
            ...(id ? { resume: id } : {}),
            onEvent: (e) => {
              if (mine !== generation) return;
              clearTimeout(timer);
              timer = undefined;
              if (e.type === 'session') id = e.id;
              if (e.type === 'idle') waiting = !e.more;
              else if (e.type !== 'background') waiting = false;
              // waiting with nothing of its own running: the next message may be long in coming
              if (waiting && (e.type === 'idle' ? !e.background : e.type === 'background' && !e.tasks.length)) timer = setTimeout(rest, after);
              spec.onEvent(e);
            },
        };
        const s = mine === 1 ? runtime.start(resumed, text, given) : startingLater(gone.then(() => () => runtime.start(resumed, text, given)), resumed);
        session = s;
        void s.done.then(() => {
          // a process given up for rest has not ended the session
          if (mine !== generation) return;
          clearTimeout(timer);
          session = undefined;
          ended();
        });
      };
      begin(firstMessage, images);
      return {
        send(text, given) {
          if (closed) return;
          clearTimeout(timer);
          timer = undefined;
          waiting = false;
          if (session) session.send(text, given);
          else begin(text, given);
        },
        close() {
          closed = true;
          clearTimeout(timer);
          if (session) session.close();
          else ended();
        },
        done,
      };
    },
  };
}

/** Runs agents through the Claude Agent SDK, on the Claude Code login of the machine. */
export const sdkRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    const inbox = new Inbox();
    const there = remote(spec.cwd);
    // a session on another machine: whether its connection was lost, rather than the session failing
    let lost = false;
    // not on this machine's account: on another machine, or here on CLAUDE_CODE_OAUTH_TOKEN
    const token = there || ({ ...cleanEnv(), ...spec.env }).CLAUDE_CODE_OAUTH_TOKEN ? { token: true as const } : {};
    const files = there ? sessionFiles(there.host.o.home, spec.plugins ?? []) : undefined;
    if (there && files) {
      const dir = there.host.prepare(files);
      inbox.carry = async (text, images) => (await carryTo(there.host, dir, text, images, join(there.host.o.home, 'files'))).text;
    }
    if (firstMessage !== undefined) inbox.push(firstMessage, images);
    const abort = new AbortController();
    const obeya = createSdkMcpServer({
      name: 'obeya',
      version: '1.0.0',
      // the agent needs these from the first step, not behind a tool search
      alwaysLoad: true,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.schema, async (args) => ({ content: [{ type: 'text' as const, text: await t.run(args as Record<string, unknown>) }] })),
      ),
    });
    const ownTools = spec.tools.map((t) => `mcp__obeya__${t.name}`);
    const claude = there ? 'claude' : claudeExecutable();
    // a watched call's end is waited for before the agent goes on
    const watched = spec.watch ? [{ hooks: [async (input: HookInput) => (await spec.watch!.after(toolCall(input)), {})] }] : [];
    // what Claude Code here last said on stderr, for a session that ends with an error
    let stderr = '';
    const q = query({
      prompt: inbox,
      options: {
        cwd: there ? there.path : spec.cwd,
        abortController: abort,
        ...(claude ? { pathToClaudeCodeExecutable: claude } : {}),
        spawnClaudeCodeProcess:
          there && files
            ? there.host.session({
                cwd: there.path,
                files,
                onExit: (code) => (lost = code === LOST && !abort.signal.aborted),
              })
            : spawnHere((text) => (stderr = (stderr + text).slice(-STDERR_TAIL))),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.system },
        mcpServers: { obeya },
        ...(spec.plugins?.length ? { plugins: spec.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
        ...(spec.readOnly
          ? { tools: READ_ONLY_TOOLS, allowedTools: [...READ_ONLY_TOOLS, ...ownTools], permissionMode: 'dontAsk' as const }
          : // a worker's own tools are allowed by the hook below: as allowedTools they would have the SDK warn that they pass by canUseTool
            { ...(spec.askOwner ? {} : { allowedTools: ownTools }), permissionMode: spec.permissionMode ?? 'auto' }),
        // without the repository's settings, which Claude Code reads with its CLAUDE.md
        ...(spec.untrusted ? { settingSources: ['user' as const] } : {}),
        // the owner's own Chrome, signed in; a session elsewhere or reading only has no use for it
        ...(!there && !spec.readOnly && chromeAvailable() ? { extraArgs: { chrome: null } } : {}),
        ...(spec.resume ? { resume: spec.resume } : {}),
        ...(spec.dirs?.length ? { additionalDirectories: spec.dirs } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        // on another machine only what the session itself needs: that machine has its own PATH and home
        env: there ? { ...spec.env } : { ...cleanEnv(), ...spec.env },
        ...(spec.askOwner ? { canUseTool: (name: string, input: Record<string, unknown>, o: { signal: AbortSignal; decisionReason?: string }) => askOwner(spec.askOwner!, name, input, o) } : {}),
        hooks: {
          PreToolUse: [
            { matcher: 'mcp__obeya__.*', hooks: [async () => ownToolAllowed] },
            ...(spec.watch ? [{ hooks: [async (input: HookInput) => (await spec.watch!.before(toolCall(input)), {})] }] : []),
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  const out = refuseForegroundWait(input);
                  if (input.hook_event_name === 'PreToolUse' && 'hookSpecificOutput' in out)
                    spec.onEvent({ type: 'denied', name: input.tool_name, input: (input.tool_input ?? {}) as Record<string, unknown>, by: 'obeya' });
                  return out;
                },
              ],
            },
          ],
          // a subagent's step would pass it to the subagent, which the agent may never hear of
          PostToolUse: [
            ...watched,
            { hooks: [async (input) => withContext('PostToolUse', input.agent_id ? undefined : spec.contextUpdate?.())] },
          ],
          PostToolUseFailure: [
            ...watched,
            { hooks: [async (input) => withContext('PostToolUseFailure', input.agent_id ? undefined : spec.contextUpdate?.())] },
          ],
        },
      },
    });
    // the conversation names the MCP servers it had, and a message taken before they connect has Claude Code tell the agent they are gone, then back
    if (spec.resume) inbox.held = mcpSettled(q);
    let background: { id: string; description: string }[] = [];
    // what the agent's tool calls were called with, by id: a denial names only the call
    const inputs = new Map<string, Record<string, unknown>>();
    // the account's usage limits as last reported, and whether the turn's request was refused for one
    let limits: SDKRateLimitInfo | undefined;
    let limited = false;
    const done = (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') spec.onEvent({ type: 'session', id: m.session_id, model: m.model, ...(spec.effort ? { effort: spec.effort } : {}) });
          else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
            const running = backgroundWork(m.tasks);
            if (JSON.stringify(running) !== JSON.stringify(background)) spec.onEvent({ type: 'background', tasks: running });
            background = running;
          }
          else if (m.type === 'rate_limit_event') limits = m.rate_limit_info;
          else if (m.type === 'system' && m.subtype === 'permission_denied') {
            if (!m.agent_id) spec.onEvent({ type: 'denied', name: m.tool_name, input: inputs.get(m.tool_use_id) ?? {}, by: deniedBy(m.decision_reason_type), ...(m.decision_reason?.trim() ? { reason: m.decision_reason.trim() } : {}) });
          }
          // an API error the CLI words as the agent's reply; the turn's result reports it
          else if (m.type === 'assistant' && m.error) limited ||= m.error === 'rate_limit';
          else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text.trim()) spec.onEvent({ type: 'text', text: block.text });
              else if (block.type === 'tool_use') inputs.set(block.id, (block.input ?? {}) as Record<string, unknown>), spec.onEvent({ type: 'tool', name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
            }
          } else if (m.type === 'result') {
            const failed = resultFailure(m);
            const limit = failed ? usageLimit(failed, limited, limits) : undefined;
            limited = false;
            // a result of a crash or a failed start may carry no cost: nothing to count
            if (m.total_cost_usd > 0) spec.onEvent({ type: 'spend', session: m.session_id, usd: m.total_cost_usd });
            if (failed) spec.onEvent({ type: 'error', message: failed, ...(limit ? { limit } : {}), ...token });
            spec.onEvent({ type: 'idle', background: background.length, ...(inbox.taken(m) ? {} : { more: true }) });
          }
        }
      } catch (e) {
        if (!abort.signal.aborted && !lost) spec.onEvent({ type: 'error', message: withStderr(messageOf(e), stderr), ...token });
      }
      if (lost && !abort.signal.aborted) spec.onEvent({ type: 'lost', message: `the connection to ${there!.host.name} was lost` });
    })();
    return {
      send: (text, images) => inbox.push(text, images),
      close: () => {
        inbox.end();
        abort.abort();
      },
      done,
    };
  },
};

/** How long a resumed session's first message waits at most for its MCP servers to connect. */
const MCP_WAIT_MS = 15_000;

/**
 * Settles once the session's MCP servers are all listed, Obeya's own (`own`) among them, and none
 * is still connecting, or after `ms`. claude.ai's connectors take a second or two after the start,
 * and are listed only after a moment, before Obeya's own; a resumed session that takes a message
 * before they connected has Claude Code tell the agent their tools are gone and, once connected,
 * back again: about 2,300 tokens more than the process kept would have paid (measured 2026-11-09,
 * `measure-resume-cache.ts`).
 */
export async function mcpSettled(q: { mcpServerStatus(): Promise<{ name: string; status: string }[]> }, own = 'obeya', ms = MCP_WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const servers = await within(q.mcpServerStatus().catch(() => null), deadline - Date.now());
    // a CLI that does not answer holds the message no longer
    if (!servers) return;
    if (servers.some((s) => s.name === own) && !servers.some((s) => s.status === 'pending')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Claude Code and Codex processes started on this machine that still run. */
const here = new Set<ChildProcess>();

/** Counts a process among the agents' that `endAgentsHere` ends as Obeya stops. */
export function trackHere(p: ChildProcess) {
  here.add(p);
  p.once('exit', () => here.delete(p));
}

/** How much of what Claude Code said last on stderr a session that ended with an error reports. */
const STDERR_TAIL = 2000;

/**
 * Starts Claude Code on this machine as the SDK would, but out of the terminal's process group
 * (`OWN_GROUP`), so that Ctrl-C reaches Obeya alone, which waits for the agent to pause. Its stderr
 * goes to `stderr`, which the SDK reads only from a process it started itself.
 */
export function spawnHere(stderr: (text: string) => void): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const p = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP });
    trackHere(p);
    p.stderr!.setEncoding('utf8').on('data', stderr);
    return p as SpawnedProcess;
  };
}

/** A session's error with what Claude Code said last on stderr, unless the error names it already. */
export function withStderr(message: string, stderr: string): string {
  const tail = stderr.trim();
  return tail && !message.includes(tail) ? `${message}. stderr: ${tail}` : message;
}

/**
 * Ends the Claude Code processes started on this machine, and what each runs, as Obeya stops: once
 * they paused for it, or at once when the owner would not wait. Without a terminal's Ctrl-C reaching
 * them, they would otherwise go on with a turn that nobody hears any more. Not on Windows, where they
 * stay in the console (`OWN_GROUP`) and a kill would end them at once, before they end what they run:
 * there they end as before, with their stdin.
 */
export function endAgentsHere() {
  if (!OWN_GROUP) return;
  for (const p of here) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  }
}

/**
 * What made a turn fail, or nothing when it did not. A turn that failed on the API (not logged in,
 * say) ends as a `success` with `is_error` and the error in `result`.
 */
export function resultFailure(m: SDKResultMessage): string | undefined {
  if (m.subtype === 'success') return m.is_error ? m.result.trim() || 'error' : undefined;
  return m.errors?.filter((e) => e.trim()).join('; ') || m.subtype;
}

/**
 * Whether a failed turn hit the account's usage limit, and when that lifts: the request was refused
 * for it, the limits last reported say so, or (from a CLI that reports neither) the message does
 * ("You've hit your session limit · resets 2:40pm").
 */
export function usageLimit(failure: string, refused: boolean, limits: SDKRateLimitInfo | undefined, now = Date.now()): { resetsAt?: number } | undefined {
  const rejected = limits?.status === 'rejected';
  if (!refused && !rejected && !/\bhit your .*limit\b/i.test(failure)) return undefined;
  // the API gives seconds
  if (rejected && limits.resetsAt) return { resetsAt: limits.resetsAt * 1000 };
  const said = resetIn(failure, now);
  return said ? { resetsAt: said } : {};
}

/**
 * When the message says the limit resets, as the CLI words it ("resets 7:20pm (Europe/Berlin)"):
 * the next such time in that zone, or one that passed within the hour. Nothing for a message that
 * names no time, or a day as well (a weekly limit).
 */
export function resetIn(message: string, now = Date.now()): number | undefined {
  const m = /\bresets (\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i.exec(message);
  if (!m) return undefined;
  const hour = (Number(m[1]) % 12) + (m[3]!.toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(m[2] ?? 0);
  let zone = m[4]?.trim();
  try {
    if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = undefined;
  }
  // the date there now, and that time on it or the next day
  const day = wallClock(now, zone);
  for (const add of [0, 1]) {
    const at = fromWallClock(day.year, day.month, day.day + add, hour, minute, zone);
    if (at > now - 3_600_000) return at;
  }
  return undefined;
}

/** The date and time a clock in `zone` (the machine's own without one) shows at `at`, as UTC fields. */
function wallClock(at: number, zone: string | undefined) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

/** The moment a clock in `zone` shows that date and time. */
function fromWallClock(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const w = wallClock(at, zone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000;
  };
  // once more with the offset at the result, across a change of summer time
  const guess = wanted - offset(wanted);
  return wanted - offset(guess);
}

/** A usage limit that does not say when it lifts is tried again after this. */
const LIMIT_RETRY = 15 * 60_000;
/** A usage limit that should have lifted already is tried again after this. */
const LIMIT_AGAIN = 60_000;

/** When to go on after the usage limit stopped a turn: `margin` after it lifts, so that clocks a little apart do not matter. */
export function limitLifts(limit: { resetsAt?: number }, margin: number, now = Date.now()): number {
  const reset = limit.resetsAt;
  return !reset ? now + LIMIT_RETRY : reset > now ? reset + margin : now + LIMIT_AGAIN;
}

/** Sorts the SDK's `decision_reason_type` of a denial. */
export function deniedBy(type: string | undefined): DeniedBy {
  switch (type) {
    case 'rule':
    // a Bash command whose parts the rules decided one by one
    case 'subcommandResults':
      return 'rule';
    case 'classifier':
      return 'classifier';
    case 'mode':
    // a session with nobody to ask
    case 'asyncAgent':
      return 'mode';
    case 'hook':
      return 'hook';
    default:
      return 'other';
  }
}

/**
 * Passes a tool call that needs a person's permission to the owner. Claude Code's own question tool
 * has nobody to answer it in Obeya; the agent's tools of Obeya do.
 */
export async function askOwner(
  ask: NonNullable<AgentSpec['askOwner']>,
  name: string,
  input: Record<string, unknown>,
  o: { signal: AbortSignal; decisionReason?: string },
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
  if (name === 'AskUserQuestion') return { behavior: 'deny', message: 'Nobody answers this tool here. Ask the owner with the ask tool of Obeya (mcp__obeya__ask) instead.' };
  const answer = await ask({ name, input, ...(o.decisionReason?.trim() ? { reason: o.decisionReason.trim() } : {}) }, o.signal);
  return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message };
}

/** A session's failure in the owner's words. */
export function failureReason(message: string, t: Messages): string {
  if (claudeLoginFailed(message)) return t.failure.notLoggedIn;
  const codex = codexLoginLost(message);
  if (codex) return t.failure.codexNotLoggedIn(codex.host);
  return t.failure.session(message);
}

/** Background work that ended wakes the agent within this; a turn that waits longer without a sign counts as ended. */
export const BACKGROUND_GRACE = 10 * 60_000;
/**
 * Background work ends by its own limit well within this (a command run in the background after two
 * hours at most, a watcher after half an hour): it is only for a session that never says the work ended.
 */
export const BACKGROUND_LIMIT = 3 * 60 * 60_000;

/**
 * A turn of an agent that answers the owner (an idea's, a look-up's) that ended while its background
 * work runs: that work wakes the agent when it ends, so the turn waits for it, and the owner's words
 * meanwhile go into the session at once. Without a sign of the agent for a long while
 * (BACKGROUND_LIMIT while the work runs, BACKGROUND_GRACE after it ended), `over` ends the turn.
 */
export class BackgroundWait {
  /** How many of the agent's background tasks run, as the session last said. */
  running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private over: () => void,
    private limits: { grace?: number; limit?: number } = {},
    /** The turn starts or stops waiting. */
    private onChange?: (waiting: boolean) => void,
  ) {}

  get waiting(): boolean {
    return this.timer !== undefined;
  }

  /** The turn ended: it waits for the agent's background work to wake it. */
  start() {
    const was = this.waiting;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.onChange?.(false);
        this.over();
      },
      this.running > 0 ? (this.limits.limit ?? BACKGROUND_LIMIT) : (this.limits.grace ?? BACKGROUND_GRACE),
    );
    if (!was) this.onChange?.(true);
  }

  /** The agent's background work started or ended: a turn waiting for it waits as long as it runs. */
  changed(running: number) {
    this.running = running;
    if (this.waiting) this.start();
  }

  /** The agent goes on (a message, its work woke it), or its session ends: the turn waits no more. */
  stop() {
    if (!this.waiting) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onChange?.(false);
  }
}

/** A foreground command may sleep this long; anything longer keeps the owner's notes from the agent. */
export const FOREGROUND_SLEEP_LIMIT = 30;

/** Short waits the refusal suggests; both pass it (tested), the first also where `timeout` is missing (macOS). */
export const BOUNDED_WAITS = [
  'for i in $(seq 1 15); do curl -sf localhost:3000 && break; sleep 2; done',
  "timeout 30 bash -c 'until curl -sf localhost:3000; do sleep 2; done'",
];

/**
 * Refuses a foreground Bash command that sleeps longer than the limit: a message sent meanwhile
 * reaches the agent only once the command is done.
 */
export function refuseForegroundWait(input: HookInput): HookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { command, run_in_background } = (input.tool_input ?? {}) as { command?: unknown; run_in_background?: unknown };
  if (run_in_background || typeof command !== 'string' || foregroundSleep(command) <= FOREGROUND_SLEEP_LIMIT) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Not run: this command sleeps in the foreground for more than ${FOREGROUND_SLEEP_LIMIT} seconds (or in a loop with no bound), and a note from the owner reaches you only once a command is done. Wait in the background instead: run it with run_in_background, or watch for the condition with Monitor, and end your turn; you are woken when it finishes or fires. A short wait may stay in the foreground if bounded to ${FOREGROUND_SLEEP_LIMIT} seconds, e.g. \`${BOUNDED_WAITS[0]}\` or, where \`timeout\` is installed, \`${BOUNDED_WAITS[1]}\`.`,
    },
  };
}

/** A tool call as the hooks of `AgentSpec.watch` hear of it. */
function toolCall(input: HookInput): ToolCall {
  const i = input as { tool_use_id?: string; tool_name?: string; tool_input?: unknown };
  return { id: i.tool_use_id ?? '', name: i.tool_name ?? '', input: (i.tool_input ?? {}) as Record<string, unknown> };
}

/** Obeya's own tools run without asking anyone. */
const ownToolAllowed: HookJSONOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };

function withContext(event: 'PostToolUse' | 'PostToolUseFailure', text: string | undefined): HookJSONOutput {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
}

/**
 * How many seconds a shell command sleeps in the foreground, read from the command line alone:
 * `sleep` with its durations (`sleep 90`, `sleep 5m`, `sleep 1m 30s`), times the iterations of the
 * loop it is in (a `for` over a word list, `seq` or `{a..b}`; `while` and `until` have no bound).
 * A command that `timeout N` starts counts at most N, wherever it stands (`cd app && timeout 30 bash
 * -c 'until …; do sleep 2; done'`). What runs behind `&` does not count, nor does the text of a
 * heredoc unless a shell runs it (`bash <<EOF`, `cat <<EOF | sh`). Commands that only sleep inside
 * scripts or programs they call are not seen.
 */
export function foregroundSleep(command: string): number {
  // redirections such as 2>&1 are words, not `&`
  const tokens = boundTimeouts(withoutHeredocs(command)).replace(/['"`]/g, ' ').match(/\d*[<>]&\d*-?|&>>?|&&|\|\||[;&|(){}\n]|[^\s;&|(){}<>]+|[<>]+/g) ?? [];
  // per open loop or group (and the command line itself): seconds of finished commands, and of the one in progress
  type Frame = { done: number; current: number; iterations: number; closer: string };
  const stack: Frame[] = [{ done: 0, current: 0, iterations: 1, closer: '' }];
  const top = () => stack.at(-1)!;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === 'sleep') {
      let s = 0;
      while (i + 1 < tokens.length && /^(\d+(\.\d+)?[smhd]?|inf(inity)?)$/.test(tokens[i + 1]!)) s += seconds(tokens[++i]!);
      top().current += s;
    } else if (t === 'while' || t === 'until') stack.push({ done: 0, current: 0, iterations: Infinity, closer: 'done' });
    else if (t === '(' || t === '{') stack.push({ done: 0, current: 0, iterations: 1, closer: t === '(' ? ')' : '}' });
    else if (t === 'for') {
      // the words up to `do` say how often the body runs
      const header: string[] = [];
      while (i + 1 < tokens.length && tokens[i + 1] !== 'do') header.push(tokens[++i]!);
      stack.push({ done: 0, current: 0, iterations: iterations(header), closer: 'done' });
    } else if (t === top().closer) {
      const loop = stack.pop()!;
      const body = loop.done + loop.current;
      top().current += body > 0 ? body * loop.iterations : 0;
    } else if (t === '&') top().current = 0;
    else if (t === ';' || t === '&&' || t === '||' || t === '\n') {
      top().done += top().current;
      top().current = 0;
    }
  }
  // loops left open (a command line cut off) count as they stand
  let total = 0;
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k]!;
    const body = f.done + f.current + total;
    total = body > 0 ? body * f.iterations : 0;
  }
  return total;
}

/** `timeout` (or coreutils' `gtimeout` on macOS) where a command begins: variables set for it, options, then the duration. */
const TIMEOUT = /^(?:\w+=\S*\s+)*g?timeout(?:\s+(?:-[ks]\s*\S+|--?[a-zA-Z][\w-]*(?:=\S+)?))*\s+(\d+(?:\.\d+)?[smhd]?)(?=\s)/;

/** Words after which a command begins, as after `;`. */
const COMMAND_BEFORE = new Set(['do', 'then', 'else', 'elif', '!', 'time']);

/**
 * The command line with each command that `timeout N` starts replaced by a `sleep` as long as it
 * can wait: N, or less if what it runs sleeps less (`timeout 0` sets no bound). Quotes count here,
 * so a loop handed to `bash -c '…'` stays in the command it belongs to.
 */
function boundTimeouts(command: string): string {
  let out = '';
  let start = true;
  for (let i = 0; i < command.length; ) {
    const rest = command.slice(i);
    const t = start ? TIMEOUT.exec(rest) : null;
    if (t) {
      const end = i + commandEnd(rest);
      const bound = seconds(t[1]!) || Infinity;
      out += `sleep ${Math.min(bound, foregroundSleep(command.slice(i + t[0].length, end)))} `;
      i = end;
      start = false;
      continue;
    }
    const unit = rest.match(/^(?:[ \t]+|\d*[<>]&\d*-?|&>>?|[<>]+|[;&|(){}\n]|'[^']*'?|"(?:\\.|[^"\\])*"?|\\.|[^\s;&|(){}<>'"\\]+)/)?.[0] ?? rest[0]!;
    out += unit;
    i += unit.length;
    if (/^[;&|({\n]$/.test(unit)) start = true;
    else if (!/^[ \t]+$/.test(unit) && !/^\d*[<>]/.test(unit)) start = COMMAND_BEFORE.has(unit);
  }
  return out;
}

/** Where the command at the start of `text` ends: at `;`, `&`, `|`, a line break or a `)` it did not open, outside quotes. */
function commandEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') i++;
    else if (c === "'") i = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1);
    else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) return i;
    else if (c === '&' && (/[<>]/.test(text[i - 1] ?? '') || text[i + 1] === '>')) continue;
    else if (/[;&|\n]/.test(c) && depth === 0) return i;
  }
  return text.length;
}

function seconds(d: string): number {
  if (d.startsWith('inf')) return Infinity;
  const n = Number.parseFloat(d);
  return n * ({ m: 60, h: 3600, d: 86400 }[d.at(-1)!] ?? 1);
}

/** How often a `for` runs from its header (`i in a b c`, `i in $(seq 1 60)`, `i in {1..60}`); unknown counts as unbounded. */
function iterations(header: string[]): number {
  const at = header.indexOf('in');
  if (at < 0) return Infinity;
  const words = header.slice(at + 1).filter((w) => !/^(&&|\|\||[;&|(){}\n])$/.test(w));
  const list = words.join(' ');
  const range = list.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (range) return Math.abs(Number(range[2]) - Number(range[1])) + 1;
  const seq = list.match(/^\$? ?seq (-?\d+)(?: (-?\d+))?(?: (-?\d+))?$/);
  if (seq) {
    const [first, step, last] =
      seq[3] !== undefined ? [Number(seq[1]), Number(seq[2]), Number(seq[3])] : seq[2] !== undefined ? [Number(seq[1]), 1, Number(seq[2])] : [1, 1, Number(seq[1])];
    return step === 0 ? Infinity : Math.max(0, Math.floor((last - first) / step) + 1);
  }
  return words.some((w) => w.startsWith('$')) ? Infinity : words.length;
}

/**
 * Workers of a scratch Obeya for a demo (`--idle-workers`): a started card is in progress, but no
 * agent works on it, so it stays as staged and costs nothing. What a worker is told goes into the
 * server's log, for a demo to show what reaches the agent.
 */
export const idleRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    let end!: () => void;
    const done = new Promise<void>((r) => (end = r));
    const heard = (text: string, images: string[] = []) =>
      console.log(`idle worker in ${spec.cwd} is told${images.length ? ` (with ${images.length} image${images.length === 1 ? '' : 's'})` : ''}:\n${text}\n---`);
    if (firstMessage) heard(firstMessage, images);
    return { send: heard, close: () => end(), done };
  },
};

/**
 * The agent's background tasks that wake it when they finish or fire: a render, a test run, a
 * watcher. The SDK marks watchers `ambient` (no activity to show), like its own housekeeping,
 * which wakes no one and does not count.
 */
export function backgroundWork(tasks: { task_id: string; task_type: string; description: string; ambient?: boolean }[]): { id: string; description: string }[] {
  return tasks.filter((t) => !t.ambient || t.task_type.startsWith('monitor')).map((t) => ({ id: t.task_id, description: t.description }));
}

/**
 * Obeya's own environment minus what belongs to a Claude Code session that may have started it (but
 * the login of a machine without a keychain, `CLAUDE_CODE_OAUTH_TOKEN`), minus the supervisor's
 * mark (an Obeya an agent starts, a scratch one for a demo, supervises itself), and minus what has
 * the compiled binary run scripts as Bun.
 */
export function cleanEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|OBEYA_SUPERVISED$|OBEYA_FROM_APP$|BUN_BE_BUN$)/.test(k)));
}

/**
 * Copies a message's images and the dropped files its text names (under `files` here) into Obeya's
 * directory `dir` on the host (awaited only when there is something to copy): the text with their
 * paths there, and the images' paths there. What cannot be copied keeps its path here; a directory
 * that cannot be made ready leaves the message as it was (the session sees the images in it all the
 * same).
 */
export async function carryTo(host: SshHost, dir: string | Promise<string>, text: string, images: string[], files: string): Promise<{ text: string; images: string[] }> {
  const dropped = filesIn(text, files);
  if (!images.length && !dropped.length) return { text, images };
  try {
    const at = await dir;
    const to = `${at}/images`;
    if (images.length) await host.copyFiles(images, to);
    const there = `${at}/files`;
    if (dropped.length) await host.copyFiles(dropped, there);
    const carried = images.reduce((t, f) => t.split(f).join(`${to}/${basename(f)}`), text);
    return { text: dropped.reduce((t, d) => t.split(d).join(`${there}/${basename(d)}`), carried), images: images.map((f) => `${to}/${basename(f)}`) };
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return { text, images };
  }
}

/** The session's input: an async stream of user messages that stays open until ended. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: { uuid: string; content: Promise<SDKUserMessage['message']['content']> }[] = [];
  /** The messages sent that no turn has taken yet, by their uuid. */
  private untaken = new Set<string>();
  private wake: (() => void) | null = null;
  private ended = false;
  /** What the first message waits for: a resumed session's MCP servers connecting (`mcpSettled`). */
  held: Promise<void> = Promise.resolve();
  /** For a session on another machine: copies the images and the files the text names there and returns the text with their paths there. */
  carry?: (text: string, images: string[]) => Promise<string>;

  push(text: string, images: string[] = []) {
    // read now: the files may be gone by the time the session takes the message
    const blocks = images.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType(f), data: readFileSync(f).toString('base64') } }));
    const carried = this.carry ? this.carry(text, images) : Promise.resolve(text);
    const uuid = randomUUID();
    this.untaken.add(uuid);
    this.queue.push({ uuid, content: carried.then((t) => (blocks.length ? [{ type: 'text' as const, text: t }, ...blocks] : t)) });
    this.wake?.();
  }

  /**
   * Whether every message sent has been taken by the turn that `result` ends or one before it. A
   * message sent while the turn ends comes too late for it and starts a turn of its own; one taken
   * in the middle of a turn is listed with the turn's result. A CLI that lists none is taken at its word.
   */
  taken(result: { user_message_uuid?: string; user_message_uuids?: string[] }): boolean {
    const took = result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : undefined);
    if (!took) this.untaken.clear();
    for (const uuid of took ?? []) this.untaken.delete(uuid);
    return this.untaken.size === 0;
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    await this.held;
    while (true) {
      while (this.queue.length) {
        const { uuid, content } = this.queue.shift()!;
        // the CLI names the messages a turn took by their uuid (`taken`); the SDK's type leaves the field out
        yield { type: 'user', message: { role: 'user', content: await content }, parent_tool_use_id: null, uuid } as SDKUserMessage;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}
