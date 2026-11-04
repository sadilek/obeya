#!/usr/bin/env bun
// A stand-in for `codex app-server` in tests (codex.test.ts): it speaks the app server's JSON-RPC
// over stdio and plays a turn by what the user's text asks for. Every request it gets goes to the
// file `FAKE_CODEX_LOG` names, a JSON line each.
//
// - `tool <name> <json>`: calls the dynamic tool and says what it returned.
// - `command <cmd>`: runs a shell command, asks for its approval, and says the decision.
// - `limit`: the usage limit stops the turn.
// - `wait`: the turn goes on until a message steers it.
// - `late`: the turn goes on until a message comes, then ends before it could take it.
// - anything else: says `echo: <text>`.

import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_CODEX_LOG;
let next = 1000;
let turns = 0;
let thread = 'thread-1';
/** The turn that waits for a steer, if one does, and whether it ends before taking it. */
let waiting: string | null = null;
let late = false;
const answers = new Map<number, (result: unknown) => void>();

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
      case 'thread/start':
        send({ id: m.id, result: { thread: { id: thread }, model: m.params.model ?? 'gpt-5.5' } });
        break;
      case 'thread/resume':
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
