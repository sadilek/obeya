#!/usr/bin/env bun
// A stand-in for Antigravity's CLI (`agy`) in tests (gemini.test.ts): `agy acp` speaks the Agent
// Client Protocol over stdio and plays a turn by what the user's text asks for, its hooks run as agy
// runs them (the `hooks.json` under `--gemini-dir`'s `config`, before and after each tool call, a
// tool refused where one answers anything but nothing at all, `{}` included). Every request it gets
// goes to the file `FAKE_AGY_LOG` names, a JSON line each.
//
// - `tool <name> <json>`: calls Obeya's tool through the session's MCP server and says what it returned.
// - `run <cmd>`: runs a shell command, the hooks around it, and says what came of it.
// - `write <path> <text>`: writes a file with agy's file tool, the hooks around it.
// - `bypass <cmd>`: asks for the permission to run a command outside the sandbox; allowed, it says
//   `ran`; refused, the turn ends without a word, as agy's does.
// - `quota`: the turn fails as for a used-up quota.
// - `unauthorized`: the turn fails for a missing login.
// - `costly`: says `done` and reports the turn's tokens.
// - `wait`: the turn goes on until another prompt comes, which steers it: it says `steered: <text>`.
// - anything else: says `echo: <text>`.
//
// As the CLI: `--version` says 1.5.13; `models` lists Gemini 4 Neon, 3.8 Flash and agy's others,
// or the lines of `FAKE_AGY_MODELS`; `-p /quota --output-format json` reports a quota, an API key's
// none where `FAKE_AGY_QUOTA` is `apikey`, a missing login where it is `loggedout`.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const MODELS = (
  process.env.FAKE_AGY_MODELS ??
  [
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  ].join('\n')
)
  .split('\n')
  .map((l) => {
    const [modelId, name] = l.split('\t');
    return { modelId: modelId!, name: name! };
  });

if (args[0] === '--version') {
  console.log('1.5.13');
  process.exit(0);
}
if (args[0] === 'models') {
  console.log('Fetching available models...');
  for (const m of MODELS) console.log(`${m.modelId}\t${m.name}`);
  process.exit(0);
}
if (args[0] === '-p' && args[1] === '/quota') {
  if (process.env.FAKE_AGY_QUOTA === 'apikey') {
    console.error('/quota is not available with an API key');
    process.exit(2);
  }
  if (process.env.FAKE_AGY_QUOTA === 'loggedout') {
    console.log(JSON.stringify({ status: 'ERROR', error: 'authentication required: run agy to sign in' }));
    process.exit(1);
  }
  const bucket = (id: string, window: string, remaining: number, reset: string) => ({ id, name: id, window, remaining_fraction: remaining, reset_time: reset });
  const groups = [
    { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash', buckets: [bucket('gemini-weekly', 'weekly', 0.75, '2030-01-07T10:00:00Z'), bucket('gemini-5h', '5h', Number(process.env.FAKE_AGY_FIVE_HOURS ?? 0.5), '2030-01-01T15:00:00Z')] },
    { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 'weekly', 1, '2030-01-07T10:00:00Z')] },
    { name: 'Gemini 4 Argon', buckets: [bucket('argon-weekly', 'weekly', 0.9, '2030-01-05T10:00:00Z')] },
  ];
  console.log(JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: '', command: { name: 'usage', data: { groups } } }));
  process.exit(0);
}
if (args[0] !== 'acp') {
  console.error(`fake agy: no ${args.join(' ')}`);
  process.exit(1);
}

const geminiDir = args[args.indexOf('--gemini-dir') + 1]!;
const log = (m: unknown) => process.env.FAKE_AGY_LOG && appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(m)}\n`);
const write = (m: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(m as object) })}\n`);
let next = 1000;
const asked = new Map<number, (r: any) => void>();
/** Asks the client, as agy asks for a permission. */
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = next++;
    asked.set(id, resolve);
    write({ id, method, params });
  });
const update = (sessionId: string, u: unknown) => write({ method: 'session/update', params: { sessionId, update: u } });
const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** The session's MCP server, as `session/new` or `session/resume` gave it. */
const servers = new Map<string, string>();
let sessions = 0;
/** A turn that waits for another prompt to steer it. */
let waiting: ((text: string) => void) | undefined;

/** Runs the hooks of `event` for a tool call: the decision of the first that answers anything, `run` where none does. */
function hook(event: 'PreToolUse' | 'PostToolUse', name: string, toolArgs: Record<string, unknown>): { decision: string; reason?: string } {
  const file = join(geminiDir, 'config', 'hooks.json');
  if (!existsSync(file)) return { decision: 'run' };
  const hooks = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, { matcher: string; hooks: { command: string }[] }[]>>;
  for (const spec of Object.values(hooks)) {
    for (const group of spec[event] ?? []) {
      for (const h of group.hooks) {
        const input = JSON.stringify({ hookEventName: event, toolCall: { id: `call-${next}`, name, args: toolArgs }, conversationId: 'c', cwd: process.cwd() });
        const r = spawnSync('sh', ['-c', h.command], { input, encoding: 'utf8', cwd: dirname(file) });
        if (r.status !== 0) return { decision: 'deny', reason: `hook failed: exit status ${r.status}` };
        const out = r.stdout.trim();
        if (event === 'PostToolUse' || !out) continue;
        const answer = JSON.parse(out) as { decision?: string; reason?: string };
        // agy refuses a call whose hook answers without a decision it knows
        if (answer.decision !== 'allow' && answer.decision !== 'ask') return { decision: 'deny', reason: answer.reason ?? '' };
        return { decision: answer.decision, ...(answer.reason ? { reason: answer.reason } : {}) };
      }
    }
  }
  return { decision: 'run' };
}

function dirname(f: string) {
  return f.slice(0, f.lastIndexOf('/'));
}

async function turn(id: number, sessionId: string, text: string) {
  const [what, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  const end = (usage?: unknown) => write({ id, result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) } });
  const fail = (code: number, message: string) => write({ id, error: { code, message } });
  const call = `call-${next++}`;
  switch (what) {
    case 'tool': {
      const [name, ...json] = rest;
      const input = JSON.parse(json.join(' ') || '{}');
      const decision = hook('PreToolUse', `mcp_obeya_${name}`, input);
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, name: `mcp_obeya_${name}`, args: input, status: 'in_progress', kind: 'other', title: name });
      if (decision.decision === 'deny') {
        say(sessionId, `denied: ${decision.reason}`);
        return end();
      }
      const url = servers.get(sessionId)!;
      const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
      await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      log({ method: 'tools/list answered', params: { tools: listed.result.tools.map((t: { name: string }) => t.name) } });
      const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: input } });
      say(sessionId, `tool said: ${r.result.content[0].text}`);
      return end();
    }
    case 'run':
    case 'write': {
      const name = what === 'run' ? 'run_command' : 'write_file';
      const [path, ...words] = rest;
      const toolArgs = what === 'run' ? { CommandLine: arg, BypassSandbox: false } : { Path: path, Content: words.join(' ') };
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, name, args: toolArgs, status: 'in_progress', kind: what === 'run' ? 'execute' : 'edit', title: arg });
      const decision = hook('PreToolUse', name, toolArgs);
      if (decision.decision === 'deny') {
        say(sessionId, `denied: ${decision.reason}`);
        return end();
      }
      let output = '';
      if (what === 'run') output = spawnSync('sh', ['-c', arg], { encoding: 'utf8' }).stdout.trim();
      else await Bun.write(path!, words.join(' '));
      hook('PostToolUse', name, toolArgs);
      say(sessionId, what === 'run' ? `ran: ${output}` : `wrote ${path}`);
      return end();
    }
    case 'bypass': {
      const toolCall = { toolCallId: call, name: 'run_command', args: { CommandLine: arg, BypassSandbox: true }, status: 'pending', kind: 'execute', title: arg };
      update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
      const answer = await ask('session/request_permission', { sessionId, toolCall, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
      if (answer.outcome?.optionId === 'allow') say(sessionId, 'ran');
      return end();
    }
    case 'quota':
      return fail(-32603, 'RESOURCE_EXHAUSTED: You have exhausted your weekly quota for Gemini models.');
    case 'unauthorized':
      return fail(-32000, 'Authentication required');
    case 'costly':
      say(sessionId, 'done');
      return end({ inputTokens: 100_000, cachedReadTokens: 900_000, outputTokens: 10_000, thoughtTokens: 4_000, totalTokens: 1_010_000 });
    case 'wait': {
      const steer = await new Promise<string>((resolve) => (waiting = resolve));
      say(sessionId, `steered: ${steer}`);
      return end();
    }
    default:
      say(sessionId, `echo: ${text}`);
      return end({ inputTokens: 10, cachedReadTokens: 0, outputTokens: 2, totalTokens: 12 });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8').on('data', (d: string) => {
  buffer += d;
  let n: number;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n).trim();
    buffer = buffer.slice(n + 1);
    if (!line) continue;
    const m = JSON.parse(line) as { id?: number; method?: string; params?: any; result?: unknown };
    if (!m.method) {
      asked.get(m.id!)?.(m.result);
      asked.delete(m.id!);
      continue;
    }
    log({ method: m.method, params: m.params });
    const ok = (result: unknown) => write({ id: m.id, result });
    switch (m.method) {
      case 'initialize':
        ok({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' } });
        break;
      case 'session/new':
      case 'session/resume': {
        const sessionId = m.method === 'session/new' ? `session-${++sessions}` : m.params.sessionId;
        if (m.params.mcpServers?.[0]) servers.set(sessionId, m.params.mcpServers[0].url);
        ok({ ...(m.method === 'session/new' ? { sessionId } : {}), models: { availableModels: MODELS, currentModelId: 'gemini-4-neon-high' } });
        break;
      }
      case 'session/prompt': {
        const text = (m.params.prompt as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        // a prompt while a turn waits steers it, and is answered with it
        if (waiting) {
          const steer = waiting;
          waiting = undefined;
          steer(text);
          ok({ stopReason: 'end_turn' });
          break;
        }
        void turn(m.id!, m.params.sessionId, text);
        break;
      }
      case 'session/set_config_option':
      case 'session/set_mode':
      case 'session/close':
        ok({});
        break;
      default:
        write({ id: m.id, error: { code: -32601, message: `${m.method} not found` } });
    }
  }
});
