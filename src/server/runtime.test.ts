import { expect, test } from 'bun:test';
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, askOwner, BOUNDED_WAITS, Inbox, backgroundWork, deniedBy, claudeExecutable, cleanEnv, FOREGROUND_SLEEP_LIMIT, failureReason, foregroundSleep, refuseForegroundWait, resetIn, resultFailure, spawnHere, endAgentsHere, usageLimit, withLimitWait, withRepoTrust, withStderr } from './runtime';
import { FakeRuntime } from './testing';
import { MESSAGES } from '../core/messages';

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

test('foreground sleep: sleep durations, loops, bounds and background', () => {
  const cases: [string, number][] = [
    ['sleep 290', 290],
    ['sleep 5m', 300],
    ['sleep 1m 30s', 90],
    ['sleep 0.5', 0.5],
    ['sleep 290 && curl -s https://example.com/health', 290],
    ['cd app; sleep 20; sleep 20', 40],
    ['sleep 60 2>&1', 60],
    // behind & it runs on while the command returns
    ['sleep 300 &', 0],
    ['(sleep 300; touch done) & echo started', 0],
    // loops: the body times the iterations, unbounded for while and until
    ['for i in $(seq 1 60); do curl -s x && break; sleep 5; done', 300],
    ['for i in {1..10}; do sleep 2; done', 20],
    ['for host in a b c; do ping -c1 $host; sleep 1; done', 3],
    ['until curl -s localhost:4000 >/dev/null; do sleep 0.5; done', Infinity],
    ['while true; do\n  gh run view 123 | grep -q completed && break\n  sleep 10\ndone', Infinity],
    ['for i in $(seq 1 5); do echo $i; done', 0],
    // timeout bounds the command it starts, wherever that stands, but not longer than it waits
    ["timeout 30 bash -c 'until curl -s localhost:4000; do sleep 1; done'", 30],
    ["cd app && timeout 28 bash -c 'until grep -q ready log; do sleep 2; done' && cat log", 28],
    ['PORT=4000 gtimeout -k 5 --foreground 20s bash -c "until curl -s localhost:\\$PORT; do sleep 1; done"', 20],
    ["for i in 1 2 3; do timeout 10 bash -c 'until test -f x; do sleep 1; done'; done", 30],
    ["timeout 20 bash -c 'until test -f x; do sleep 1; done'; sleep 60", 80],
    ['timeout 600 sleep 5', 5],
    ['timeout 5 curl -s x 2>&1 | head', 0],
    ['timeout 0 sleep 60', 60],
    ['timeout 300 sleep 300 &', 0],
    ['sleep infinity', Infinity],
    // a heredoc's text is data, unless a shell runs it
    ["cat > wait.sh <<'EOF'\nuntil curl -s x; do sleep 2; done\nEOF\nchmod +x wait.sh", 0],
    ['cat > wait.sh <<EOF\nuntil curl -s x; do sleep 2; done\nEOF\nsleep 5', 5],
    ['cat <<-END > f\n\twhile true; do sleep 1; done\n\tEND', 0],
    ['git commit -m "$(cat <<\'EOF\'\nWait until the server is up; do sleep 2; done\nEOF\n)"', 0],
    ["cat > a <<'A' && cat > b <<'B'\nsleep 100\nA\nsleep 200\nB\nsleep 3", 3],
    ["bash <<'EOF'\nuntil curl -s x; do sleep 2; done\nEOF", Infinity],
    ['ssh host bash -s <<EOF\nsleep 60\nEOF', 60],
    ["cat <<'EOF' | sh\nsleep 60\nEOF", 60],
    ["cat > f <<'EOF' && bash f\nsleep 60\nEOF", 0],
    // no heredoc: a here-string, `<<` in quotes or a comment, a shift
    ['grep -q x <<< "$out"; sleep 40', 40],
    ["echo 'a <<b'\nsleep 40\nb", 40],
    ['echo "a <<b"\nsleep 40\nb', 40],
    ['# cat <<EOF\nsleep 40\nEOF', 40],
    ['echo $((1<<4))\nsleep 40\n4', 40],
    ['bun test', 0],
    ['git log --oneline | head', 0],
  ];
  for (const [command, s] of cases) expect([command, foregroundSleep(command)]).toEqual([command, s]);
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

test('an agent with onLimit waits for the usage limit and goes on where it stopped once it lifts; one without fails on it', async () => {
  const fake = new FakeRuntime();
  const runtime = withLimitWait(fake, 10);
  const events: AgentEvent[] = [];
  const waits: (number | undefined)[] = [];
  const session = runtime.start({ cwd: '/r', system: '', tools: [], onLimit: (until) => waits.push(until), onEvent: (e) => events.push(e) }, 'Los.');
  const s = fake.last;
  const limit = (ms: number) => {
    s.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + ms } });
    s.emit({ type: 'idle' });
  };
  limit(20);
  // neither the error nor the end of the turn it stopped
  expect(events).toEqual([]);
  expect(waits).toHaveLength(1);
  expect(waits[0]! - Date.now()).toBeGreaterThan(20);
  await new Promise((r) => setTimeout(r, 50));
  expect(waits.at(-1)).toBeUndefined();
  expect(s.inbox).toEqual(['Los.', 'The usage limit that stopped your last turn has reset. Go on where you stopped.']);
  // a turn after it ends as ever; another error is one
  s.emit({ type: 'idle' });
  s.emit({ type: 'error', message: 'boom' });
  expect(events).toEqual([{ type: 'idle' }, { type: 'error', message: 'boom' }]);
  // closed while it waits, it waits no more
  limit(10_000);
  expect(waits).toHaveLength(3);
  session.close();
  expect(waits).toHaveLength(4);
  expect(waits.at(-1)).toBeUndefined();
  expect(s.closed).toBe(true);
  await new Promise((r) => setTimeout(r, 30));
  expect(s.inbox).toHaveLength(2);

  // without onLimit, the limit is the agent's to handle
  const plain: AgentEvent[] = [];
  runtime.start({ cwd: '/r', system: '', tools: [], onEvent: (e) => plain.push(e) }, 'Los.');
  fake.last.emit({ type: 'error', message: 'limit', limit: {} });
  expect(plain).toEqual([{ type: 'error', message: 'limit', limit: {} }]);
});

test("agents run the Agent SDK's Claude Code from the checkout, the machine's own from the binary", () => {
  expect(claudeExecutable({ PATH: '' }, false)).toBeUndefined();
  expect(claudeExecutable({ OBEYA_CLAUDE: '/opt/claude', PATH: '' }, true)).toBe('/opt/claude');
  // none on the PATH: where the official installer puts it, for the SDK to say it is missing
  expect(claudeExecutable({ PATH: '' }, true, 'linux')).toBe(join(homedir(), '.local', 'bin', 'claude'));
  expect(claudeExecutable({ PATH: '' }, true, 'win32')).toBe(join(homedir(), '.local', 'bin', 'claude.exe'));
});

test("an agent's environment keeps a machine's Claude login but not another session's marks", () => {
  const env = cleanEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', OBEYA_SUPERVISED: '1', OBEYA_FROM_APP: '1', BUN_BE_BUN: '1' });
  expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
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

test("an agent whose repository's trust takes git to tell starts once it is told, with what it was sent meanwhile; closed before, it never starts", async () => {
  const fake = new FakeRuntime();
  let tell!: (held: boolean) => void;
  const runtime = withRepoTrust(fake, () => new Promise<boolean>((r) => (tell = r)));
  const spec = { cwd: '/nowhere', system: 'Work.', tools: [], onEvent: () => {} };
  const session = runtime.start(spec, 'Start.');
  session.send('And this.');
  expect(fake.sessions).toHaveLength(0);
  tell(true);
  await Bun.sleep(0);
  expect(fake.last.spec.untrusted).toBe(true);
  expect(fake.last.inbox).toEqual(['Start.', 'And this.']);
  session.close();
  expect(fake.last.closed).toBe(true);
  await session.done;

  const closed = runtime.start(spec, 'Start.');
  closed.close();
  tell(false);
  await closed.done;
  expect(fake.sessions).toHaveLength(1);
});
