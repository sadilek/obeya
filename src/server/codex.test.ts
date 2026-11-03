import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { bareCommand, codexRuntime, codexUsageOf, itemCalls, limitResets, modelsOf } from './codex';
import type { AgentEvent, AgentSession, AgentSpec } from './runtime';
import { until } from './testing';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-codex.ts');
const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A session on the stand-in app server, with what it reports and what the server was asked. */
function start(o: Partial<AgentSpec> = {}, first?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-codex-'));
  dirs.push(dir);
  const log = join(dir, 'requests.jsonl');
  const events: AgentEvent[] = [];
  const spec: AgentSpec = {
    cwd: dir,
    system: 'You are a test agent.',
    tools: [{ name: 'report', description: 'A status line.', schema: { status: z.string() }, run: (a) => `shown: ${a.status}` }],
    env: { OBEYA_CODEX: FAKE, FAKE_CODEX_LOG: log },
    onEvent: (e) => events.push(e),
    ...o,
  };
  const session = codexRuntime.start(spec, first);
  sessions.push(session);
  const requests = () => {
    try {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, any> });
    } catch {
      return [];
    }
  };
  const texts = () => events.flatMap((e) => (e.type === 'text' ? [e.text] : []));
  const idles = () => events.filter((e) => e.type === 'idle').length;
  return { session, events, requests, texts, idles };
}

describe.skipIf(process.platform === 'win32')('a Codex session through the app server', () => {
  test("starts a thread with Obeya's tools, the instructions and the sandbox, says what the agent says and when its turn ends", async () => {
    const s = start({}, 'hello');
    await until(() => s.idles() === 1);
    // kept marked as Codex's, so that a resume goes to Codex whatever the group runs on by then
    expect(s.events[0]).toEqual({ type: 'session', id: 'codex:thread-1' });
    expect(s.texts()).toEqual(['echo: hello']);
    const thread = s.requests().find((r) => r.method === 'thread/start')!.params;
    expect(thread).toMatchObject({ developerInstructions: 'You are a test agent.', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' });
    expect(thread.config['sandbox_workspace_write.network_access']).toBe(true);
    expect(thread.config.project_doc_fallback_filenames).toEqual(['CLAUDE.md']);
    expect(thread.dynamicTools[0]).toMatchObject({ type: 'namespace', name: 'obeya', tools: [{ type: 'function', name: 'report', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } }] });
  });

  test("a tool call runs Obeya's tool, with what changed meanwhile after its result, and shows in the log as Claude Code's would", async () => {
    let update: string | undefined = 'The owner wrote meanwhile: go on.';
    const s = start({ contextUpdate: () => [update, (update = undefined)][0] }, 'tool report {"status":"Half done"}');
    await until(() => s.idles() === 1);
    expect(s.events).toContainEqual({ type: 'tool', name: 'mcp__obeya__report', input: { status: 'Half done' } });
    expect(s.texts()).toEqual(['tool said: shown: Half done\n\nThe owner wrote meanwhile: go on.']);
  });

  test('a message during a turn steers it; one after it starts the next turn, with the effort chosen', async () => {
    const s = start({ effort: 'high', model: 'gpt-6.1-sol' }, 'wait');
    await until(() => s.requests().some((r) => r.method === 'turn/start'));
    await Bun.sleep(50);
    s.session.send('stop waiting');
    await until(() => s.idles() === 1);
    expect(s.texts()).toEqual(['steered: stop waiting']);
    s.session.send('next');
    await until(() => s.idles() === 2);
    expect(s.texts().at(-1)).toBe('echo: next');
    const turns = s.requests().filter((r) => r.method === 'turn/start');
    expect(turns.map((t) => t.params.effort)).toEqual(['high', 'high']);
    expect(s.requests().find((r) => r.method === 'thread/start')!.params.model).toBe('gpt-6.1-sol');
  });

  test('a message that comes as the turn ends starts the next turn, and the end says one follows', async () => {
    const s = start({}, 'late');
    await until(() => s.requests().some((r) => r.method === 'turn/start'));
    await Bun.sleep(50);
    s.session.send('too late');
    await until(() => s.idles() === 2);
    const idles = s.events.filter((e) => e.type === 'idle');
    expect(idles).toEqual([{ type: 'idle', background: 0, more: true }, { type: 'idle', background: 0 }]);
    expect(s.texts()).toEqual(['echo: too late']);
  });

  test('resumes a thread by its id, whose tools Codex keeps', async () => {
    const s = start({ resume: 'codex:thread-7' }, 'again');
    await until(() => s.idles() === 1);
    expect(s.events[0]).toEqual({ type: 'session', id: 'codex:thread-7' });
    const resume = s.requests().find((r) => r.method === 'thread/resume')!.params;
    expect(resume.threadId).toBe('thread-7');
    expect(resume.dynamicTools).toBeUndefined();
    expect(s.requests().some((r) => r.method === 'thread/start')).toBe(false);
  });

  test('a turn the usage limit stops fails with when the limit lifts', async () => {
    const s = start({}, 'limit');
    await until(() => s.idles() === 1);
    expect(s.events).toContainEqual({ type: 'error', message: "You've hit your usage limit.", limit: { resetsAt: 1_900_000_000_000 } });
  });

  test("a command Codex asks a person about goes to the owner; without anyone to ask it is refused", async () => {
    const asked: unknown[] = [];
    const s = start({ askOwner: async (r) => (asked.push(r), { allow: true }) }, 'command rm -rf build');
    await until(() => s.idles() === 1);
    expect(asked).toEqual([{ name: 'Bash', input: { command: 'rm -rf build' }, reason: 'outside the sandbox' }]);
    expect(s.texts()).toEqual(['approval: accept']);
    expect(s.events).toContainEqual({ type: 'tool', name: 'Bash', input: { command: 'rm -rf build' } });
    const alone = start({}, 'command rm -rf build');
    await until(() => alone.idles() === 1);
    expect(alone.texts()).toEqual(['approval: decline']);
    expect(alone.events).toContainEqual({ type: 'denied', name: 'Bash', input: { command: 'rm -rf build' }, by: 'mode', reason: 'outside the sandbox' });
  });

  test("a read-only agent runs in Codex's read-only sandbox and is never asked", async () => {
    const s = start({ readOnly: true }, 'look');
    await until(() => s.idles() === 1);
    const thread = s.requests().find((r) => r.method === 'thread/start')!.params;
    expect(thread).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(thread.approvalsReviewer).toBeUndefined();
  });

  test('a repository whose settings wait for the owner: Codex reads none of its instructions', async () => {
    const s = start({ untrusted: true }, 'hi');
    await until(() => s.idles() === 1);
    expect(s.requests().find((r) => r.method === 'thread/start')!.params.config.project_doc_max_bytes).toBe(0);
  });

  test('closed, the session ends without an error', async () => {
    const s = start({}, 'wait');
    await until(() => s.requests().some((r) => r.method === 'turn/start'));
    s.session.close();
    await s.session.done;
    expect(s.events.some((e) => e.type === 'error')).toBe(false);
  });

  test('without Codex on the machine the session says so', async () => {
    const s = start({ env: { OBEYA_CODEX: '', PATH: '' } }, 'hi');
    await s.session.done;
    expect(s.events).toEqual([{ type: 'error', message: 'Codex is not installed on this machine: no `codex` on the PATH' }]);
  });
});

test("a command without its shell's wrapper, as the card's log shows it", () => {
  expect(bareCommand("/bin/zsh -lc 'git status'")).toBe('git status');
  expect(bareCommand(`bash -c "bun test"`)).toBe('bun test');
  expect(bareCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
  expect(bareCommand('ls -la')).toBe('ls -la');
});

test("Codex's items as Claude Code's tool calls: a command, files written and edited, Obeya's tools", () => {
  expect(itemCalls({ type: 'commandExecution', id: 'a', command: "/bin/zsh -lc 'ls'" })).toEqual([{ id: 'a', name: 'Bash', input: { command: 'ls' } }]);
  expect(
    itemCalls({
      type: 'fileChange',
      id: 'b',
      changes: [
        { path: '/r/new.ts', kind: { type: 'add' } },
        { path: '/r/old.ts', kind: 'update' },
      ],
    }),
  ).toEqual([
    { id: 'b:0', name: 'Write', input: { file_path: '/r/new.ts' } },
    { id: 'b:1', name: 'Edit', input: { file_path: '/r/old.ts' } },
  ]);
  expect(itemCalls({ type: 'dynamicToolCall', id: 'c', namespace: 'obeya', tool: 'report', arguments: { status: 'x' } })).toEqual([{ id: 'c', name: 'mcp__obeya__report', input: { status: 'x' } }]);
  expect(itemCalls({ type: 'reasoning', id: 'd' })).toEqual([]);
});

test("a rate limit's reset: the earliest of the windows used up, else of any", () => {
  expect(limitResets({ limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 } })).toBe(900_000);
  expect(limitResets({ limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 }, secondary: null })).toBe(100_000);
  expect(limitResets(undefined)).toBeUndefined();
});

test("Codex's rate limits as the bar's: the five hours as the session, the week, a model's bucket by its name", () => {
  const at = new Date('2026-11-03T08:00:00Z');
  const codex = { limitId: 'codex', limitName: null, primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_793_710_855 }, secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1_793_776_281 } };
  const mini = { limitId: 'codex_mini', limitName: 'GPT-6-Luna', primary: null, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_793_776_281 } };
  expect(codexUsageOf({ rateLimits: codex, rateLimitsByLimitId: { codex, codex_mini: mini } }, at)).toEqual({
    at: at.toISOString(),
    limits: [
      { kind: 'session', group: 'session', percent: 28, resetsAt: new Date(1_793_710_855_000).toISOString(), severity: 'normal' },
      { kind: 'weekly_all', group: 'weekly', percent: 85, resetsAt: new Date(1_793_776_281_000).toISOString(), severity: 'warning' },
      { kind: 'weekly_scoped', group: 'weekly', scope: 'GPT-6-Luna', percent: 100, resetsAt: new Date(1_793_776_281_000).toISOString(), severity: 'critical' },
    ],
  });
  // an API key: no windows
  expect(codexUsageOf({ rateLimits: { limitId: null, limitName: null, primary: null, secondary: null }, rateLimitsByLimitId: null })).toBeNull();
});

test('the models Codex lists, without hidden ones, each with the efforts it takes among Obeya’s', () => {
  expect(
    modelsOf([
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({ reasoningEffort })) },
      { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }] },
      { id: 'internal', hidden: true },
    ]),
  ).toEqual([
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low'] },
  ]);
});
