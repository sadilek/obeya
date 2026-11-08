#!/usr/bin/env bun
// A stand-in for `codex app-server` in tests (codex.test.ts): it speaks the app server's JSON-RPC
// over stdio and plays a turn by what the user's text asks for. Every request it gets goes to the
// file `FAKE_CODEX_LOG` names, a JSON line each. It lists a few models (`model/list`), or the ones
// `FAKE_CODEX_MODELS` gives. Its process id goes to the file `FAKE_CODEX_PID` names, where one does.
//
// - `tool <name> <json>`: calls the dynamic tool and says what it returned.
// - `command <cmd>`: runs a shell command, asks for its approval, and says the decision.
// - `run <cmd>`: runs a shell command as Codex does, its hooks before and after it (the hooks given
//   with `-c hooks.PreToolUse=…` and `hooks.PostToolUse=…`, run only once the thread trusts their
//   hashes as `hooks/list` gives them), and says what came of it.
// - `patch <path> <text>`: adds a file through `apply_patch`, with the hooks around it.
// - `unauthorized`: the turn fails for a missing login.
// - `limit`: the usage limit stops the turn.
// - `wait`: the turn goes on until a message steers it.
// - `late`: the turn goes on until a message comes, then ends before it could take it.
// - anything else: says `echo: <text>`.
//
// With `FAKE_CODEX_REFUSE_START` set, `thread/start` fails with its text.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const log = process.env.FAKE_CODEX_LOG;
if (process.env.FAKE_CODEX_PID) writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
const efforts = (...e: string[]) => e.map((reasoningEffort) => ({ reasoningEffort }));
/** The models it lists unless `FAKE_CODEX_MODELS` names others. */
const CATALOG = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedReasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', supportedReasoningEfforts: efforts('low', 'medium', 'high') },
  { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedReasoningEfforts: efforts('low', 'medium', 'high') },
];
let next = 1000;
let turns = 0;
let thread = 'thread-1';
/** The turn that waits for a steer, if one does, and whether it ends before taking it. */
let waiting: string | null = null;
let late = false;
const answers = new Map<number, (result: unknown) => void>();

/** The hooks given on the command line, by event, as `hooks/list` names them; and the hashes the thread trusts. */
const hooks = process.argv.flatMap((a, i) => {
  const m = /^hooks\.(PreToolUse|PostToolUse)=.*matcher="([^"]*)".*command="([^"]*)"/.exec(process.argv[i - 1] === '-c' ? a : '');
  if (!m) return [];
  const event = m[1]!;
  return [{ event, matcher: new RegExp(m[2]!), command: m[3]!, key: `/<session-flags>/config.toml:${event === 'PreToolUse' ? 'pre_tool_use' : 'post_tool_use'}:0:0`, hash: `sha256:${createHash('sha256').update(m[3]!).digest('hex')}` }];
});
let trusted: Record<string, { trusted_hash?: string }> = {};

/** Runs the trusted hooks of `event` for a tool call: the reason a `PreToolUse` hook denied it, if one did. */
function runHooks(event: string, tool: string, id: string, input: Record<string, unknown>): string | undefined {
  for (const h of hooks) {
    if (h.event !== event || !h.matcher.test(tool) || trusted[h.key]?.trusted_hash !== h.hash) continue;
    const r = spawnSync('sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: event, tool_name: tool, tool_use_id: id, tool_input: input, cwd: process.cwd() }) });
    try {
      const out = JSON.parse(r.stdout.toString() || '{}');
      if (out.hookSpecificOutput?.permissionDecision === 'deny') return out.hookSpecificOutput.permissionDecisionReason;
    } catch {}
  }
  return undefined;
}

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method: string, params: Record<string, unknown>) => send({ method, params: { threadId: thread, ...params } });
const ask = (method: string, params: Record<string, unknown>) =>
  new Promise<any>((resolve) => {
    const id = ++next;
    answers.set(id, resolve);
    send({ id, method, params: { threadId: thread, ...params } });
  });
const say = (turn: string, text: string) => notify('item/completed', { turnId: turn, item: { type: 'agentMessage', id: `m${++next}`, text } });
const complete = (turn: string, error?: { message: string; codexErrorInfo: string }) =>
  notify('turn/completed', { turn: { id: turn, items: [], status: error ? 'failed' : 'completed', error: error ?? null } });

async function play(turn: string, text: string) {
  notify('turn/started', { turn: { id: turn, items: [], status: 'inProgress' } });
  const [word, ...rest] = text.split(' ');
  if (word === 'tool') {
    const [name, args] = [rest[0]!, rest.slice(1).join(' ')];
    notify('item/started', { turnId: turn, item: { type: 'dynamicToolCall', id: `c${++next}`, namespace: 'obeya', tool: name, arguments: JSON.parse(args || '{}') } });
    const r = await ask('item/tool/call', { turnId: turn, callId: 'call', namespace: 'obeya', tool: name, arguments: JSON.parse(args || '{}') });
    say(turn, `tool said: ${r.contentItems.map((c: { text: string }) => c.text).join(' ')}`);
    complete(turn);
  } else if (word === 'command') {
    const command = rest.join(' ');
    const item = { type: 'commandExecution', id: `x${++next}`, command: `/bin/zsh -lc '${command}'` };
    notify('item/started', { turnId: turn, item });
    const r = await ask('item/commandExecution/requestApproval', { turnId: turn, itemId: item.id, command, reason: 'outside the sandbox' });
    notify('item/completed', { turnId: turn, item });
    say(turn, `approval: ${r.decision}`);
    complete(turn);
  } else if (word === 'run') {
    const command = rest.join(' ');
    const id = `exec-${++next}`;
    const denied = runHooks('PreToolUse', 'Bash', id, { command });
    if (denied) {
      say(turn, `blocked: ${denied}`);
      return complete(turn);
    }
    const item = { type: 'commandExecution', id, command: `/bin/zsh -lc '${command}'` };
    notify('item/started', { turnId: turn, item });
    const r = spawnSync('sh', ['-c', command]);
    runHooks('PostToolUse', 'Bash', id, { command });
    notify('item/completed', { turnId: turn, item });
    say(turn, `ran: ${r.stdout.toString().trim()}`);
    complete(turn);
  } else if (word === 'patch') {
    const [path, ...words] = rest;
    const id = `exec-${++next}`;
    const patch = `*** Begin Patch\n*** Add File: ${path}\n+${words.join(' ')}\n*** End Patch`;
    const denied = runHooks('PreToolUse', 'apply_patch', id, { command: patch });
    if (denied) {
      say(turn, `blocked: ${denied}`);
      return complete(turn);
    }
    const item = { type: 'fileChange', id, changes: [{ path, kind: { type: 'add' } }] };
    notify('item/started', { turnId: turn, item });
    writeFileSync(path!, `${words.join(' ')}\n`);
    runHooks('PostToolUse', 'apply_patch', id, { command: patch });
    notify('item/completed', { turnId: turn, item });
    say(turn, 'patched');
    complete(turn);
  } else if (word === 'unauthorized') {
    complete(turn, { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' });
  } else if (word === 'limit') {
    notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_900_500_000 } } });
    complete(turn, { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' });
  } else if (word === 'wait' || word === 'late') {
    waiting = turn;
    late = word === 'late';
  }
  else {
    say(turn, `echo: ${text}`);
    complete(turn);
  }
}

const textOf = (input: { type: string; text?: string; path?: string }[]) => input.map((i) => (i.type === 'text' ? i.text : `[image ${i.path}]`)).join(' | ');

let buffer = '';
process.stdin.setEncoding('utf8').on('data', (d: string) => {
  buffer += d;
  let n: number;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (log && m.method) appendFileSync(log, `${JSON.stringify({ method: m.method, params: m.params })}\n`);
    if (m.id !== undefined && !m.method) {
      answers.get(m.id)?.(m.result ?? m.error);
      continue;
    }
    switch (m.method) {
      case 'initialize':
        send({ id: m.id, result: { userAgent: 'fake' } });
        break;
      case 'account/login/start':
        // the owner signs in a moment later
        send({ id: m.id, result: { type: 'chatgpt', authUrl: 'https://auth.openai.com/oauth/authorize?fake', loginId: 'login-1' } });
        setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } }), 50);
        break;
      case 'model/list':
        // `FAKE_CODEX_MODELS`: the catalog as `model/list` gives it (JSON), `fail` for a list that fails, `old` for a Codex without it
        if (process.env.FAKE_CODEX_MODELS === 'fail') send({ id: m.id, error: { code: -32603, message: 'models unavailable' } });
        else if (process.env.FAKE_CODEX_MODELS === 'old') send({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant `model/list`, expected one of `initialize`, `thread/start`, `turn/start`' } });
        else send({ id: m.id, result: { data: process.env.FAKE_CODEX_MODELS ? JSON.parse(process.env.FAKE_CODEX_MODELS) : CATALOG, nextCursor: null } });
        break;
      case 'hooks/list':
        send({ id: m.id, result: { data: [{ cwd: process.cwd(), hooks: hooks.map((h) => ({ key: h.key, source: 'sessionFlags', currentHash: h.hash, trustStatus: 'untrusted' })), warnings: [], errors: [] }] } });
        break;
      case 'thread/start':
        if (process.env.FAKE_CODEX_REFUSE_START) {
          send({ id: m.id, error: { code: -32600, message: process.env.FAKE_CODEX_REFUSE_START } });
          break;
        }
        trusted = m.params.config?.['hooks.state'] ?? {};
        send({ id: m.id, result: { thread: { id: thread }, model: m.params.model ?? 'gpt-5.5' } });
        break;
      case 'thread/resume':
        trusted = m.params.config?.['hooks.state'] ?? {};
        thread = m.params.threadId;
        send({ id: m.id, result: { thread: { id: thread }, model: m.params.model ?? 'gpt-5.5' } });
        break;
      case 'turn/start': {
        const turn = `turn-${++turns}`;
        send({ id: m.id, result: { turn: { id: turn, items: [], status: 'inProgress' } } });
        void play(turn, textOf(m.params.input));
        break;
      }
      case 'turn/steer':
        if (!waiting || m.params.expectedTurnId !== waiting) {
          send({ id: m.id, error: { code: -32600, message: 'no active turn' } });
          break;
        }
        if (late) {
          complete(waiting);
          waiting = null;
          send({ id: m.id, error: { code: -32600, message: 'no active turn' } });
          break;
        }
        send({ id: m.id, result: { turnId: waiting } });
        say(waiting, `steered: ${textOf(m.params.input)}`);
        complete(waiting);
        waiting = null;
        break;
      default:
        if (m.id !== undefined) send({ id: m.id, result: {} });
    }
  }
});
