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
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { mediaType } from './images';

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Returns the text the agent sees as the tool result. */
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  /**
   * The turn ended; the session waits for the next message. `background` counts the agent's
   * background tasks still running: when one ends, the session wakes itself for a new turn.
   */
  | { type: 'idle'; background?: number }
  /**
   * The turn failed. `limit` when the account's usage limit stopped it (the five-hour session
   * limit, say): it lifts again at `resetsAt` (milliseconds) when the API said when.
   */
  | { type: 'error'; message: string; limit?: { resetsAt?: number } };

export interface AgentSpec {
  cwd: string;
  /** Appended to the default system prompt. */
  system: string;
  /** Tools the agent reaches as `mcp__obeya__<name>`. */
  tools: AgentTool[];
  /** Resume this session instead of starting one. */
  resume?: string;
  /** Read-only agents get no tools that change files or run commands. */
  readOnly?: boolean;
  /** Directories of local Claude Code plugins loaded into the session (skills, mainly). */
  plugins?: string[];
  permissionMode?: PermissionMode;
  /** Added to the agent's environment (Obeya's own, cleaned). */
  env?: Record<string, string>;
  /** How much the model thinks; low for quick, small jobs. */
  effort?: 'low' | 'medium' | 'high';
  /** The model, when not the default: a smaller one for small, frequent jobs. */
  model?: string;
  /**
   * Asked after every tool step: what changed since the session's instructions were built, for the
   * agent to read with that step's result without being stopped; nothing when nothing did.
   */
  contextUpdate?: () => string | undefined;
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

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** Runs agents through the Claude Agent SDK, on the Claude Code login of the machine. */
export const sdkRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    const inbox = new Inbox();
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
    const q = query({
      prompt: inbox,
      options: {
        cwd: spec.cwd,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.system },
        mcpServers: { obeya },
        ...(spec.plugins?.length ? { plugins: spec.plugins.map((path) => ({ type: 'local' as const, path })) } : {}),
        ...(spec.readOnly
          ? { tools: READ_ONLY_TOOLS, allowedTools: [...READ_ONLY_TOOLS, ...ownTools], permissionMode: 'dontAsk' as const }
          : { allowedTools: ownTools, permissionMode: spec.permissionMode ?? 'auto' }),
        ...(spec.resume ? { resume: spec.resume } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        env: { ...cleanEnv(), ...spec.env },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [async (input) => refuseForegroundWait(input)] }],
          PostToolUse: [{ hooks: [async () => withContext('PostToolUse', spec.contextUpdate?.())] }],
          PostToolUseFailure: [{ hooks: [async () => withContext('PostToolUseFailure', spec.contextUpdate?.())] }],
        },
      },
    });
    let background = 0;
    // the account's usage limits as last reported, and whether the turn's request was refused for one
    let limits: SDKRateLimitInfo | undefined;
    let limited = false;
    const done = (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') spec.onEvent({ type: 'session', id: m.session_id });
          else if (m.type === 'system' && m.subtype === 'background_tasks_changed') background = backgroundWork(m.tasks);
          else if (m.type === 'rate_limit_event') limits = m.rate_limit_info;
          // an API error the CLI words as the agent's reply; the turn's result reports it
          else if (m.type === 'assistant' && m.error) limited ||= m.error === 'rate_limit';
          else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text.trim()) spec.onEvent({ type: 'text', text: block.text });
              else if (block.type === 'tool_use') spec.onEvent({ type: 'tool', name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
            }
          } else if (m.type === 'result') {
            const failed = resultFailure(m);
            const limit = failed ? usageLimit(failed, limited, limits) : undefined;
            limited = false;
            if (failed) spec.onEvent({ type: 'error', message: failed, ...(limit ? { limit } : {}) });
            spec.onEvent({ type: 'idle', background });
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) spec.onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
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
 * („You've hit your session limit · resets 2:40pm“).
 */
export function usageLimit(failure: string, refused: boolean, limits: SDKRateLimitInfo | undefined): { resetsAt?: number } | undefined {
  const rejected = limits?.status === 'rejected';
  if (!refused && !rejected && !/\bhit your .*limit\b/i.test(failure)) return undefined;
  // the API gives seconds
  return rejected && limits.resetsAt ? { resetsAt: limits.resetsAt * 1000 } : {};
}

/** A session's failure in German words for the owner. */
export function failureReason(message: string): string {
  if (/not logged in|\/login/i.test(message)) return 'Claude ist auf diesem Rechner nicht angemeldet: im Terminal „claude“ starten und „/login“ ausführen.';
  return `Die Claude-Sitzung brach mit einem Fehler ab: ${message}`;
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

/** A command word that runs what it reads as shell code: a shell, or `ssh` running it elsewhere. */
const SHELL = /^(?:\S*\/)?(?:(?:ba|z|da|k|mk)?sh|ssh)$/;

/**
 * The command line without the text of its heredocs (`cat > f <<'EOF' … EOF`, a commit message in
 * `"$(cat <<'EOF' … EOF)"`): only data, unless the command it is fed to, or one the heredoc's
 * command pipes into, is a shell. Single quotes hide `<<`, double quotes too, except within `$(…)`.
 */
function withoutHeredocs(command: string): string {
  // what the scanner is in: code (the line itself or a `$(…)`/`(…)`, closed by `)`) or a double-quoted string
  const modes: ('line' | 'paren' | 'dq')[] = ['line'];
  const pending: { delimiter: string; tabs: boolean; keep: boolean }[] = [];
  let out = '';
  for (let i = 0; i < command.length; ) {
    const mode = modes.at(-1)!;
    const c = command[i]!;
    let unit = c;
    if (c === '\\') unit = command.slice(i, i + 2);
    else if (mode === 'dq') {
      if (c === '"') modes.pop();
      else if (command.startsWith('$(', i)) (unit = '$('), modes.push('paren');
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      unit = command.slice(i, end < 0 ? command.length : end + 1);
    } else if (c === '"') modes.push('dq');
    else if (c === '(') modes.push('paren');
    else if (c === ')' && mode === 'paren') modes.pop();
    else if (c === '#' && /^$|[\s;&|()]$/.test(out.slice(-1))) unit = command.slice(i).match(/^[^\n]*/)![0];
    else if (command.startsWith('<<<', i)) unit = '<<<';
    else if (command.startsWith('<<', i)) {
      const op = command.slice(i).match(/^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|()<>'"\\])+)/);
      const delimiter = op?.[2]!.replace(/['"\\]/g, '');
      if (op && delimiter && /[A-Za-z_]/.test(delimiter)) {
        unit = op[0];
        // the pipeline the heredoc belongs to: back to the last command separator, on to the next one in its line
        const before = out.split(/[;&\n(]|\|\|/).at(-1)!;
        const after = command.slice(i + unit.length).split(/[;&\n)]|\|\|/)[0]!;
        const words = `${before} ${after}`.replace(/['"]/g, ' ').split(/[\s|]+/);
        pending.push({ delimiter, tabs: op[1] === '-', keep: words.some((w) => SHELL.test(w)) });
      }
    } else if (c === '\n' && pending.length > 0) {
      // the bodies follow this line, one after another, each up to the line that is its delimiter
      out += '\n';
      i++;
      for (const h of pending.splice(0)) {
        let end = i;
        for (;;) {
          const next = command.indexOf('\n', end);
          const line = command.slice(end, next < 0 ? command.length : next);
          if (next < 0 || (h.tabs ? line.replace(/^\t+/, '') : line) === h.delimiter) {
            end = next < 0 ? command.length : next + 1;
            break;
          }
          end = next + 1;
        }
        if (h.keep) out += command.slice(i, end);
        i = end;
      }
      continue;
    }
    out += unit;
    i += unit.length;
  }
  return out;
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
 * agent works on it, so it stays as staged and costs nothing.
 */
export const idleRuntime: AgentRuntime = {
  start() {
    let end!: () => void;
    const done = new Promise<void>((r) => (end = r));
    return { send: () => {}, close: () => end(), done };
  },
};

/**
 * How many of the agent's background tasks wake it when they finish or fire: a render, a test run,
 * a watcher. The SDK marks watchers `ambient` (no activity to show), like its own housekeeping,
 * which wakes no one and does not count.
 */
export function backgroundWork(tasks: { task_type: string; ambient?: boolean }[]): number {
  return tasks.filter((t) => !t.ambient || t.task_type.startsWith('monitor')).length;
}

/**
 * Obeya's own environment minus what belongs to a Claude Code session that may have started it, and
 * minus the supervisor's mark: an Obeya an agent starts (a scratch one for a demo) supervises itself.
 */
function cleanEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|OBEYA_SUPERVISED$)/.test(k)));
}

/** The session's input: an async stream of user messages that stays open until ended. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage['message']['content'][] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(text: string, images: string[] = []) {
    // read now: the files may be gone by the time the session takes the message
    this.queue.push(
      images.length
        ? [
            { type: 'text', text },
            ...images.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType(f), data: readFileSync(f).toString('base64') } })),
          ]
        : text,
    );
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.queue.length) yield { type: 'user', message: { role: 'user', content: this.queue.shift()! }, parent_tool_use_id: null };
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}
