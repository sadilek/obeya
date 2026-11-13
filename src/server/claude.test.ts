import { expect, test } from 'bun:test';
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { askOwner, backgroundWork, chromeAvailable, claudeExecutable, deniedBy, Inbox, mcpSettled, outage, refuseForegroundWait, resetIn, resultFailure, spawnHere, usageLimit } from './claude';
import { endAgentsHere, failureReason, withStderr } from './runtime';
import { MESSAGES } from '../core/messages';
import { BOUNDED_WAITS, FOREGROUND_SLEEP_LIMIT } from './shell';

test('background work counts renders, test runs and watchers, not housekeeping', () => {
  expect(
    backgroundWork([
      { task_id: 'b1', task_type: 'local_bash', description: 'Run the test suite' },
      { task_id: 'a1', task_type: 'local_agent', description: 'Review the diff' },
      // a watcher the SDK marks as no activity still wakes the agent when it fires
      { task_id: 'm1', task_type: 'monitor_ws', description: 'Watch the deploy', ambient: true },
      { task_id: 'd1', task_type: 'dream', description: 'Consolidate memory', ambient: true },
    ]),
  ).toEqual([
    { id: 'b1', description: 'Run the test suite' },
    { id: 'a1', description: 'Review the diff' },
    { id: 'm1', description: 'Watch the deploy' },
  ]);
  expect(backgroundWork([])).toEqual([]);
});

test('the refusal lets through the bounded waits it suggests and a loop under timeout 28', () => {
  const hook = (command: string) =>
    refuseForegroundWait({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as unknown as HookInput) as {
      hookSpecificOutput?: { permissionDecisionReason: string };
    };
  const refused = (command: string) => hook(command).hookSpecificOutput !== undefined;
  for (const command of [...BOUNDED_WAITS, "timeout 28 bash -c 'until curl -sf localhost:4417/api/state; do sleep 2; done'"])
    expect([command, refused(command)]).toEqual([command, false]);
  expect(refused('until curl -sf localhost:3000; do sleep 2; done')).toBe(true);
  expect(refused(`timeout ${FOREGROUND_SLEEP_LIMIT + 1} bash -c 'until curl -sf localhost:3000; do sleep 2; done'`)).toBe(true);
  const reason = hook('sleep 300').hookSpecificOutput!.permissionDecisionReason;
  for (const command of BOUNDED_WAITS) expect(reason).toContain(command);
});

test('a turn that failed on the API counts as failed, with its error', () => {
  const result = (r: Record<string, unknown>) => ({ type: 'result', ...r }) as unknown as SDKResultMessage;
  expect(resultFailure(result({ subtype: 'success', is_error: false, result: 'Fertig.' }))).toBeUndefined();
  expect(resultFailure(result({ subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))).toBe('Not logged in · Please run /login');
  expect(resultFailure(result({ subtype: 'error_during_execution', is_error: true, errors: ['overloaded'] }))).toBe('overloaded');
  expect(resultFailure(result({ subtype: 'error_max_turns', is_error: true, errors: [] }))).toBe('error_max_turns');
  expect(failureReason('Not logged in · Please run /login', MESSAGES.de)).toContain('nicht angemeldet');
  expect(failureReason('Not logged in · Please run /login', MESSAGES.en)).toContain('not logged in');
  expect(failureReason('overloaded', MESSAGES.en)).toContain('overloaded');
  expect(failureReason('Claude Code process exited with code 1. stderr: not logged in', MESSAGES.en)).toBe(MESSAGES.en.failure.notLoggedIn);
  expect(failureReason('Invalid API key · Please run /login', MESSAGES.en)).toBe(MESSAGES.en.failure.notLoggedIn);
  // another tool's login error is not Claude's
  expect(failureReason('gh: OAuth token expired', MESSAGES.en)).toContain('gh: OAuth token expired');
});

test('a turn the usage limit stopped says when the limit lifts', () => {
  const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
  const rejected = { status: 'rejected', resetsAt: 1_791_211_200, rateLimitType: 'five_hour' } as const;
  expect(usageLimit(hit, true, rejected)).toEqual({ resetsAt: 1_791_211_200_000 });
  // refused, but the limits reported say nothing of when: the message does
  const now = Date.parse('2026-10-16T12:05:00Z');
  expect(usageLimit(hit, true, undefined, now)).toEqual({ resetsAt: Date.parse('2026-10-16T12:40:00Z') });
  // a CLI that reports neither: the message alone
  expect(usageLimit(hit, false, undefined, now)).toEqual({ resetsAt: Date.parse('2026-10-16T12:40:00Z') });
  expect(usageLimit("You've hit your weekly limit", false, undefined, now)).toEqual({});
  expect(usageLimit('overloaded', false, { status: 'allowed' })).toBeUndefined();
  expect(usageLimit('Not logged in · Please run /login', false, undefined)).toBeUndefined();
});

test('a turn that failed because the Claude API could not be reached waits for an outage, sooner the first time; the usage limit goes first', () => {
  const now = Date.parse('2026-11-13T10:15:00Z');
  const blocked = 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare';
  expect(outage(blocked, false, 0, now)).toEqual({ resetsAt: now + 60_000, outage: true });
  expect(outage(blocked, false, 2, now)).toEqual({ resetsAt: now + 5 * 60_000, outage: true });
  // the request failed as overloaded, whatever the result says
  expect(outage('error_during_execution', true, 0, now)).toEqual({ resetsAt: now + 60_000, outage: true });
  expect(outage('Not logged in · Please run /login', false, 0, now)).toBeUndefined();
  expect(outage('API Error: 400 prompt is too long', false, 0, now)).toBeUndefined();
});

test('the reset time a limit message names is the next such time in its zone', () => {
  const at = (iso: string) => Date.parse(iso);
  // 19:18 in Berlin (summer time, UTC+2): later the same day
  expect(resetIn('resets 7:20pm (Europe/Berlin)', at('2026-10-16T17:18:00Z'))).toBe(at('2026-10-16T17:20:00Z'));
  // past midnight there, and in winter time (UTC+1)
  expect(resetIn('resets 1am (Europe/Berlin)', at('2026-12-01T21:00:00Z'))).toBe(at('2026-12-02T00:00:00Z'));
  // a few minutes past: it should have lifted, not tomorrow
  expect(resetIn('resets 7:20pm (Europe/Berlin)', at('2026-10-16T17:25:00Z'))).toBe(at('2026-10-16T17:20:00Z'));
  expect(resetIn('resets 12pm (America/New_York)', at('2026-10-16T13:00:00Z'))).toBe(at('2026-10-16T16:00:00Z'));
  // a day named too, or no time: unknown
  expect(resetIn('resets Oct 20, 3pm (Europe/Berlin)')).toBeUndefined();
  expect(resetIn("You've hit your session limit")).toBeUndefined();
  // a zone the machine does not know: its own
  expect(resetIn('resets 3pm (Nowhere/Else)')).toBeNumber();
});

test("agents run the Agent SDK's Claude Code from the checkout, the machine's own from the binary", () => {
  expect(claudeExecutable({ PATH: '' }, false)).toBeUndefined();
  expect(claudeExecutable({ OBEYA_CLAUDE: '/opt/claude', PATH: '' }, true)).toBe('/opt/claude');
  // none on the PATH: where the official installer puts it, for the SDK to say it is missing
  expect(claudeExecutable({ PATH: '' }, true, 'linux')).toBe(join(homedir(), '.local', 'bin', 'claude'));
  expect(claudeExecutable({ PATH: '' }, true, 'win32')).toBe(join(homedir(), '.local', 'bin', 'claude.exe'));
});

test("agents get Claude in Chrome where Claude Code knows the extension and it is not turned off", () => {
  const home = mkdtempSync(join(tmpdir(), 'chrome-'));
  const config = (c: object) => writeFileSync(join(home, '.claude.json'), JSON.stringify(c));
  // no Claude Code config, or none that shows the extension: no browser, or it was never set up
  expect(chromeAvailable({}, home)).toBe(false);
  config({ claudeInChromeDefaultEnabled: true });
  expect(chromeAvailable({}, home)).toBe(false);
  config({ cachedChromeExtensionInstalled: true });
  expect(chromeAvailable({}, home)).toBe(true);
  config({ chromeExtension: { pairedDeviceId: 'd1' } });
  expect(chromeAvailable({}, home)).toBe(true);
  // turned off in Claude Code's settings or its environment
  config({ cachedChromeExtensionInstalled: true, claudeInChromeDefaultEnabled: false });
  expect(chromeAvailable({}, home)).toBe(false);
  config({ cachedChromeExtensionInstalled: true });
  expect(chromeAvailable({ CLAUDE_CODE_ENABLE_CFC: 'false' }, home)).toBe(false);
  // the config where CLAUDE_CONFIG_DIR puts it
  expect(chromeAvailable({ CLAUDE_CONFIG_DIR: join(home, 'none') }, home)).toBe(false);
  writeFileSync(join(home, '.claude.json'), '{');
  expect(chromeAvailable({}, home)).toBe(false);
});

test("a denial's reason type is sorted into who refused the call", () => {
  // a Bash command whose parts the rules decided one by one, as a deny rule reports it
  expect(deniedBy('subcommandResults')).toBe('rule');
  expect(deniedBy('rule')).toBe('rule');
  expect(deniedBy('classifier')).toBe('classifier');
  expect(deniedBy('asyncAgent')).toBe('mode');
  expect(deniedBy(undefined)).toBe('other');
});

test("a call that needs permission goes to the owner with Claude Code's reason; its own question tool is refused", async () => {
  const signal = new AbortController().signal;
  const asked: unknown[] = [];
  const ask = async (r: unknown) => (asked.push(r), { allow: true as const });
  expect(await askOwner(ask, 'Bash', { command: 'ls' }, { signal, decisionReason: ' write access ' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  expect(asked).toEqual([{ name: 'Bash', input: { command: 'ls' }, reason: 'write access' }]);
  expect(await askOwner(async () => ({ allow: false, message: 'no' }), 'Bash', { command: 'ls' }, { signal })).toEqual({ behavior: 'deny', message: 'no' });
  const q = await askOwner(ask, 'AskUserQuestion', {}, { signal });
  expect(q.behavior === 'deny' && q.message).toContain('mcp__obeya__ask');
  expect(asked).toHaveLength(1);
});

test("a resumed session's first message waits for its MCP servers to connect, at most a while", async () => {
  const inbox = new Inbox();
  let connect!: () => void;
  inbox.held = new Promise((r) => (connect = r));
  inbox.push('Feedback.');
  let got: unknown;
  void inbox[Symbol.asyncIterator]().next().then((m) => (got = m.value));
  await Bun.sleep(10);
  expect(got).toBeUndefined();
  connect();
  await Bun.sleep(0);
  expect((got as { message: { content: string } }).message.content).toBe('Feedback.');

  // the claude.ai connectors are listed only after a moment, before Obeya's own server, then connect
  let asked = 0;
  const listed = (n: number) => ({
    mcpServerStatus: async () => {
      asked++;
      const chrome = { name: 'claude-in-chrome', status: 'connected' };
      if (asked === 1) return [chrome];
      if (asked === 2) return [chrome, { name: 'claude.ai Docs', status: 'pending' }];
      return [chrome, { name: 'claude.ai Docs', status: asked > n ? 'connected' : 'pending' }, { name: 'claude.ai Mail', status: 'failed' }, { name: 'obeya', status: 'connected' }];
    },
  });
  await mcpSettled(listed(3), 'obeya', 5000);
  expect(asked).toBe(4);
  // one that never connects, or a CLI that never answers, holds the message no longer than the bound
  const started = Date.now();
  asked = 0;
  await mcpSettled(listed(Infinity), 'obeya', 300);
  await mcpSettled({ mcpServerStatus: () => new Promise(() => {}) }, 'obeya', 100);
  expect(Date.now() - started).toBeLessThan(1500);
});

test('a message sent while a turn ends is still to come; one the turn took mid-way is not', async () => {
  const inbox = new Inbox();
  const sent = inbox[Symbol.asyncIterator]();
  const uuid = async () => ((await sent.next()).value as { uuid: string }).uuid;
  inbox.push('Reply.');
  const reply = await uuid();
  inbox.push('Your work is on main now.');
  const landed = await uuid();
  // the reply's turn ended before the landing came: a turn of its own follows
  expect(inbox.taken({ user_message_uuids: [reply] })).toBe(false);
  expect(inbox.taken({ user_message_uuids: [landed] })).toBe(true);
  // taken in the middle of the turn, it is listed with the turn's result
  inbox.push('Go on.');
  inbox.push('A note.');
  expect(inbox.taken({ user_message_uuids: [await uuid(), await uuid()] })).toBe(true);
  // a CLI that lists nothing is taken at its word
  inbox.push('More.');
  expect(inbox.taken({})).toBe(true);
});

test.skipIf(process.platform === 'win32')("Claude Code here runs out of the terminal's process group: Ctrl-C reaches Obeya alone, which ends it and what it runs as it stops", async () => {
  let stderr = '';
  // the agent and a command it runs, each saying its process group
  const p = spawnHere((t) => (stderr += t))({ command: 'sh', args: ['-c', 'echo "$(ps -o pgid= -p $$) $$"; sh -c \'echo "$(ps -o pgid= -p $$)"; sleep 30\' & echo "not logged in" >&2; wait'], env: { PATH: process.env.PATH }, cwd: process.cwd(), signal: new AbortController().signal });
  const out: string[] = [];
  p.stdout.setEncoding('utf8').on('data', (d: string) => out.push(...d.split('\n').filter(Boolean)));
  while (out.length < 2) await Bun.sleep(20);
  const [group = '', pid] = out[0]!.trim().split(/\s+/);
  expect(group).toBe(pid!);
  expect(group).not.toBe(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout.toString().trim());
  expect(out[1]!.trim()).toBe(group);
  const exited = new Promise<string | null>((r) => p.once('exit', (_code: number | null, signal: NodeJS.Signals | null) => r(signal)));
  endAgentsHere();
  expect(await exited).toBe('SIGTERM');
  // the command it ran went with it: it got the signal too, and is gone once it was reaped, which
  // may come a moment after the agent's own exit
  const alive = () => {
    try {
      return process.kill(-Number(group), 0);
    } catch {
      return false;
    }
  };
  for (const end = Date.now() + 2000; alive() && Date.now() < end; ) await Bun.sleep(20);
  expect(alive()).toBe(false);
  expect(withStderr('Claude Code process exited with code 1', stderr)).toBe('Claude Code process exited with code 1. stderr: not logged in');
  expect(withStderr('x. stderr: not logged in', stderr)).toBe('x. stderr: not logged in');
});
