// The Claude Code runtime: agents run through the Claude Agent SDK, on the Claude Code login of the
// machine (`AgentRuntime`, runtime.ts), and how Obeya finds and starts Claude Code.

import {
  createSdkMcpServer,
  type HookInput,
  type HookJSONOutput,
  type Options,
  query,
  type Query,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOST, remote, sessionFiles, type SshHost } from './hosts';
import { localBin, which } from './path';
import { mediaType } from './images';
import { COMPILED } from './resources';
import { OWN_GROUP } from './spawn';
import { BOUNDED_WAITS, FOREGROUND_SLEEP_LIMIT, refuseLongWait, waitRefusal } from './shell';
import { type AgentRuntime, type AgentSpec, carryTo, claudeUnreachable, cleanEnv, type DeniedBy, lostEvent, outageRetry, stderrTail, trackHere, type TurnLimit, withStderr } from './runtime';
import type { ToolCall } from './folder';
import { messageOf } from '../core/text';
import { within } from '../core/late';

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
            : spawnHere((text) => (stderr = stderrTail(stderr, text))),
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
    // whether the turn's request failed as overloaded, and how many turns in a row failed for an outage
    let unavailable = false;
    let outages = 0;
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
          else if (m.type === 'assistant' && m.error) {
            limited ||= m.error === 'rate_limit';
            // not `server_error`, which also stands for a certificate or proxy this machine refuses: the failure's words tell a server's error apart
            unavailable ||= m.error === 'overloaded';
          }
          else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text.trim()) spec.onEvent({ type: 'text', text: block.text });
              else if (block.type === 'tool_use') inputs.set(block.id, (block.input ?? {}) as Record<string, unknown>), spec.onEvent({ type: 'tool', name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
            }
          } else if (m.type === 'result') {
            const failed = resultFailure(m);
            const limit = failed ? (usageLimit(failed, limited, limits) ?? outage(failed, unavailable, outages)) : undefined;
            outages = limit?.outage ? outages + 1 : 0;
            limited = false;
            unavailable = false;
            // a result of a crash or a failed start may carry no cost: nothing to count
            if (m.total_cost_usd > 0) spec.onEvent({ type: 'spend', session: m.session_id, usd: m.total_cost_usd });
            if (failed) spec.onEvent({ type: 'error', message: failed, ...(limit ? { limit } : {}), ...token });
            spec.onEvent({ type: 'idle', background: background.length, ...(inbox.taken(m) ? {} : { more: true }) });
          }
        }
      } catch (e) {
        if (!abort.signal.aborted && !lost) spec.onEvent({ type: 'error', message: withStderr(messageOf(e), stderr), ...token });
      }
      if (lost && !abort.signal.aborted) spec.onEvent(lostEvent(there!.host.name));
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

/**
 * A Claude Code session in `cwd` that waits for a prompt that never comes, for what its control
 * requests answer (the plan's usage, the models, the skills): no message, no tokens. `there`: the
 * session on a host, started over its connection. What it says unasked is not needed. It runs until
 * `close`.
 */
export function idleClaude(cwd: string, options: Options = {}, there?: SshHost): { q: Query; close: () => void } {
  const abort = new AbortController();
  const prompt = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  })() as AsyncIterable<never>;
  const claude = there ? 'claude' : claudeExecutable();
  const q = query({
    prompt,
    options: {
      ...options,
      cwd,
      abortController: abort,
      // on another machine only what the session itself needs: that machine has its own PATH and home
      env: there ? {} : cleanEnv(),
      ...(claude ? { pathToClaudeCodeExecutable: claude } : {}),
      spawnClaudeCodeProcess: there ? there.session({}) : spawnHere(() => {}),
    },
  });
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  return { q, close: () => abort.abort() };
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
 * Whether a failed turn failed because the Claude API could not be reached or did not serve it
 * (`claudeUnreachable`, or the turn's request failed as `overloaded`), and when
 * to try again: after the `streak` of such turns before it (`outageRetry`).
 */
export function outage(failure: string, unavailable: boolean, streak: number, now = Date.now()): TurnLimit | undefined {
  return unavailable || claudeUnreachable(failure) ? { resetsAt: outageRetry(streak, now), outage: true } : undefined;
}

/**
 * Whether a failed turn hit the account's usage limit, and when that lifts: the request was refused
 * for it, the limits last reported say so, or (from a CLI that reports neither) the message does
 * ("You've hit your session limit · resets 2:40pm").
 */
export function usageLimit(failure: string, refused: boolean, limits: SDKRateLimitInfo | undefined, now = Date.now()): TurnLimit | undefined {
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

/** Why a command that waits too long in the foreground is not run, in Claude Code's terms: its background tasks wake the session. */
const WAIT_REFUSED = waitRefusal(
  `Wait in the background instead: run it with run_in_background, or watch for the condition with Monitor, and end your turn; you are woken when it finishes or fires. A short wait may stay in the foreground if bounded to ${FOREGROUND_SLEEP_LIMIT} seconds, e.g. \`${BOUNDED_WAITS[0]}\` or, where \`timeout\` is installed, \`${BOUNDED_WAITS[1]}\`.`,
);

/**
 * Refuses a foreground Bash command that sleeps longer than the limit: a message sent meanwhile
 * reaches the agent only once the command is done.
 */
export function refuseForegroundWait(input: HookInput): HookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const { command, run_in_background } = (input.tool_input ?? {}) as { command?: unknown; run_in_background?: unknown };
  if (run_in_background || typeof command !== 'string') return {};
  return refuseLongWait(command, WAIT_REFUSED) ?? {};
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
 * The agent's background tasks that wake it when they finish or fire: a render, a test run, a
 * watcher. The SDK marks watchers `ambient` (no activity to show), like its own housekeeping,
 * which wakes no one and does not count.
 */
export function backgroundWork(tasks: { task_id: string; task_type: string; description: string; ambient?: boolean }[]): { id: string; description: string }[] {
  return tasks.filter((t) => !t.ambient || t.task_type.startsWith('monitor')).map((t) => ({ id: t.task_id, description: t.description }));
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
