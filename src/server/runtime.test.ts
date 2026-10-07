import { expect, test } from 'bun:test';
import type { HookInput, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BOUNDED_WAITS, backgroundWork, claudeExecutable, cleanEnv, FOREGROUND_SLEEP_LIMIT, failureReason, foregroundSleep, refuseForegroundWait, resultFailure, usageLimit } from './runtime';
import { MESSAGES } from '../core/messages';

test('background work counts renders, test runs and watchers, not housekeeping', () => {
  expect(
    backgroundWork([
      { task_type: 'local_bash' },
      { task_type: 'local_agent' },
      // a watcher the SDK marks as no activity still wakes the agent when it fires
      { task_type: 'monitor_ws', ambient: true },
      { task_type: 'dream', ambient: true },
    ]),
  ).toBe(3);
  expect(backgroundWork([])).toBe(0);
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
});

test('a turn the usage limit stopped says when the limit lifts', () => {
  const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
  const rejected = { status: 'rejected', resetsAt: 1_791_211_200, rateLimitType: 'five_hour' } as const;
  expect(usageLimit(hit, true, rejected)).toEqual({ resetsAt: 1_791_211_200_000 });
  // refused, but the limits reported say nothing of when
  expect(usageLimit(hit, true, undefined)).toEqual({});
  // a CLI that reports neither: the message alone
  expect(usageLimit(hit, false, undefined)).toEqual({});
  expect(usageLimit('overloaded', false, { status: 'allowed' })).toBeUndefined();
  expect(usageLimit('Not logged in · Please run /login', false, undefined)).toBeUndefined();
});

test("agents run the Agent SDK's Claude Code from the checkout, the machine's own from the binary", () => {
  expect(claudeExecutable({ PATH: '' }, false)).toBeUndefined();
  expect(claudeExecutable({ OBEYA_CLAUDE: '/opt/claude', PATH: '' }, true)).toBe('/opt/claude');
  // none on the PATH: where the official installer puts it, for the SDK to say it is missing
  expect(claudeExecutable({ PATH: '' }, true, 'linux')).toBe(join(homedir(), '.local', 'bin', 'claude'));
  expect(claudeExecutable({ PATH: '' }, true, 'win32')).toBe(join(homedir(), '.local', 'bin', 'claude.exe'));
});

test("an agent's environment keeps a machine's Claude login but not another session's marks", () => {
  const env = cleanEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', OBEYA_SUPERVISED: '1', BUN_BE_BUN: '1' });
  expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
});
