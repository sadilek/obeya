import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { geminiLoginLost } from '../core/login';
import type { ToolCall } from './folder';
import { GeminiDir, geminiCall, geminiLogin, geminiModels, geminiModelsOf, geminiRuntime, geminiUsageOf, hooksFile, quotaResets, resolveGeminiModel, WAIT_REFUSED } from './gemini';
import { findGemini, Harnesses } from './harnesses';
import { geminiCost } from './prices';
import type { AgentEvent, AgentSession, AgentSpec } from './runtime';
import { git } from './git';
import { gitRepo, until } from './testing';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-agy.ts');
const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-gemini-'));
  dirs.push(dir);
  return dir;
};

/** A session on the stand-in `agy acp`, with what it reports and what agy was asked. */
function start(o: Partial<AgentSpec> & { home?: string; cwd?: string } = {}, first?: string) {
  const home = o.home ?? scratch();
  const cwd = o.cwd ?? join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const log = join(home, `requests-${Math.random().toString(36).slice(2)}.jsonl`);
  const events: AgentEvent[] = [];
  const spec: AgentSpec = {
    cwd,
    system: 'You are a test agent.',
    tools: [{ name: 'report', description: 'A status line.', schema: { status: z.string() }, run: (a) => `shown: ${a.status}` }],
    onEvent: (e) => events.push(e),
    ...o,
    env: { OBEYA_AGY: FAKE, FAKE_AGY_LOG: log, ...o.env },
  };
  const runtime = geminiRuntime({ dir: join(home, 'gemini'), own: join(home, 'own-gemini') });
  const session = runtime.start(spec, first);
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
  return { session, events, requests, texts, idles, home, cwd };
}

describe.skipIf(process.platform === 'win32')('a Gemini session through agy acp', () => {
  test("starts with Obeya's instructions and tools, on the newest model of its family with the nearest effort it takes, in auto mode", async () => {
    const s = start({ model: 'gemini-#-neon', effort: 'max' }, 'hello');
    await until(() => s.idles() === 1);
    expect(s.texts()).toEqual(['echo: hello']);
    const opened = s.requests().find((r) => r.method === 'session/new')!.params;
    expect(opened.cwd).toBe(s.cwd);
    expect(opened._meta.antigravity.systemPrompt.append).toBe('You are a test agent.');
    expect(opened.mcpServers[0]).toMatchObject({ type: 'http', name: 'obeya', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/\S+$/) });
    const set = s.requests().filter((r) => r.method === 'session/set_config_option').map((r) => [r.params.configId, r.params.value]);
    expect(set).toEqual([
      ['model', 'gemini-4-neon'],
      ['thought_level', 'xhigh'],
    ]);
    expect(s.requests().find((r) => r.method === 'session/set_mode')!.params.modeId).toBe('auto');
    expect(s.events[0]).toEqual({ type: 'session', id: 'gemini:session-1', model: 'gemini-4-neon', effort: 'xhigh' });
    // agy runs with Obeya's own directory, with Obeya's hook in it
    expect(JSON.parse(readFileSync(join(s.home, 'gemini', 'config', 'hooks.json'), 'utf8'))).toEqual(hooksFile(false));
  });

  test('a family the session lists no model of does not start, rather than run on agy’s own choice', async () => {
    const s = start({ model: 'gemini-#-argon' }, 'hello');
    await until(() => s.events.some((e) => e.type === 'error'));
    expect(s.events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('lists no model of the family Argon') });
    expect(s.requests().some((r) => r.method === 'session/prompt')).toBe(false);
  });

  test("calls Obeya's tools through their MCP server, named as on every harness, with what changed meanwhile", async () => {
    let updates = 0;
    const s = start({ contextUpdate: () => (updates++ === 0 ? 'The owner wrote meanwhile.' : undefined) }, 'tool report {"status":"half done"}');
    await until(() => s.idles() === 1);
    expect(s.events.find((e) => e.type === 'tool')).toEqual({ type: 'tool', name: 'mcp__obeya__report', input: { status: 'half done' } });
    expect(s.texts()).toEqual(['tool said: shown: half done\n\nThe owner wrote meanwhile.']);
  });

  test("a tool's arguments are checked against its schema, as on Claude Code", async () => {
    const s = start({}, 'tool report {"status":5}');
    await until(() => s.idles() === 1);
    expect(s.texts()[0]).toStartWith('tool said: Invalid arguments for report');
  });

  test('a resumed session gets the tools anew, from a server of its own, and its mode set again', async () => {
    const s = start({ resume: 'gemini:session-7' }, 'tool report {"status":"again"}');
    await until(() => s.idles() === 1);
    const resumed = s.requests().find((r) => r.method === 'session/resume')!.params;
    expect(resumed.sessionId).toBe('session-7');
    expect(resumed.mcpServers[0].url).toMatch(/\/mcp\//);
    expect(s.requests().some((r) => r.method === 'session/new')).toBe(false);
    expect(s.requests().find((r) => r.method === 'tools/list answered')!.params.tools).toEqual(['report']);
    expect(s.requests().find((r) => r.method === 'session/set_mode')!.params.modeId).toBe('auto');
    expect(s.events[0]).toMatchObject({ type: 'session', id: 'gemini:session-7' });
  });

  test('a long wait in the foreground is refused before it runs, and the agent reads why', async () => {
    const s = start({}, 'run sleep 600');
    await until(() => s.idles() === 1);
    expect(s.texts()).toEqual([`denied: ${WAIT_REFUSED}`]);
    expect(s.events).toContainEqual({ type: 'denied', name: 'Bash', input: { command: 'sleep 600' }, by: 'obeya' });
    // a short command runs: the hook leaves it to agy
    const t = start({}, 'run echo fine');
    await until(() => t.idles() === 1);
    expect(t.texts()).toEqual(['ran: fine']);
    expect(t.events).toContainEqual({ type: 'tool', name: 'Bash', input: { command: 'echo fine' } });
  });

  test('a read-only agent runs in the default mode, and is refused every tool that does more than read', async () => {
    const s = start({ readOnly: true, tools: [] }, 'run echo no');
    await until(() => s.idles() === 1);
    expect(s.requests().find((r) => r.method === 'session/set_mode')!.params.modeId).toBe('default');
    expect(s.texts()).toEqual(['denied: This agent only reads: it changes no file and runs no command.']);
    expect(s.requests().find((r) => r.method === 'session/new')!.params.mcpServers).toEqual([]);
  });

  test('a folder’s watch hears of each call before it runs and after', async () => {
    const seen: string[] = [];
    const watch = { before: async (c: ToolCall) => void seen.push(`before ${c.name} ${String(c.input.file_path ?? c.input.command)}`), after: async (c: ToolCall) => void seen.push(`after ${c.name} ${String(c.input.file_path ?? c.input.command)}`) };
    const home = scratch();
    const file = join(home, 'work', 'notes.txt');
    const s = start({ home, watch }, `write ${file} one`);
    await until(() => s.idles() === 1);
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(seen).toEqual([`before Write ${file}`, `after Write ${file}`]);
  });

  test("what agy leaves to a person is the owner's question; a refusal reaches the agent with the next turn", async () => {
    const asked: unknown[] = [];
    let allow = true;
    const s = start({ askOwner: async (r) => (asked.push(r), allow ? { allow: true } : { allow: false, message: 'not now' }) }, 'bypass echo hi');
    await until(() => s.idles() === 1);
    expect(asked).toEqual([{ name: 'Bash', input: { command: 'echo hi' } }]);
    expect(s.texts()).toEqual(['ran']);
    allow = false;
    s.session.send('bypass rm -r build');
    // agy ends the turn without a word; the next turn tells the agent, without the owner writing
    await until(() => s.idles() === 3);
    expect(s.events.filter((e) => e.type === 'idle')[1]).toEqual({ type: 'idle', background: 0, more: true });
    const prompts = s.requests().filter((r) => r.method === 'session/prompt');
    expect(prompts[2]!.params.prompt[0].text).toBe('The owner refused `rm -r build`: not now. Go on without it.');
  });

  test('without anyone to ask, such a request is refused', async () => {
    const s = start({}, 'bypass echo hi');
    await until(() => s.idles() === 2);
    expect(s.events).toContainEqual({ type: 'denied', name: 'Bash', input: { command: 'echo hi' }, by: 'mode' });
  });

  test('a used-up quota stops the turn until the window that ran out resets, as agy reports it', async () => {
    const s = start({ env: { FAKE_AGY_FIVE_HOURS: '0' } }, 'quota');
    await until(() => s.idles() === 1);
    expect(s.events.find((e) => e.type === 'error')).toEqual({ type: 'error', message: expect.stringContaining('RESOURCE_EXHAUSTED'), limit: { resetsAt: Date.parse('2030-01-01T15:00:00Z') } });
  });

  test('a missing login says so, for the card to offer logging in again', async () => {
    const s = start({}, 'unauthorized');
    await until(() => s.idles() === 1);
    const error = s.events.find((e) => e.type === 'error') as { message: string };
    expect(geminiLoginLost(error.message)).toBe(true);
  });

  test("reports the session's cost so far after each turn, its tokens at Google's list prices", async () => {
    const s = start({}, 'costly');
    await until(() => s.idles() === 1);
    const spend = s.events.find((e) => e.type === 'spend') as { usd: number; session: string };
    expect(spend.session).toBe('gemini:session-1');
    // 100,000 uncached at $3, 900,000 cached at $0.15, 10,000 out at $15 per million
    expect(spend.usd).toBeCloseTo(0.585, 6);
  });

  test('a message during a turn steers it', async () => {
    const s = start({}, 'wait');
    await until(() => s.requests().filter((r) => r.method === 'session/prompt').length === 1);
    s.session.send('go on');
    await until(() => s.idles() === 1);
    expect(s.texts()).toEqual(['steered: go on']);
  });

  test("a repository without AGENTS.md or GEMINI.md brings its CLAUDE.md with the instructions; one with them, agy reads itself", async () => {
    const home = scratch();
    const cwd = gitRepo(join(home, 'repo'), { 'CLAUDE.md': 'Use tabs.\n' });
    const s = start({ home, cwd }, 'hello');
    await until(() => s.idles() === 1);
    expect(s.requests().find((r) => r.method === 'session/new')!.params._meta.antigravity.systemPrompt.append).toBe("You are a test agent.\n\nThe repository's CLAUDE.md:\n\nUse tabs.");
    writeFileSync(join(cwd, 'AGENTS.md'), 'Use spaces.\n');
    const t = start({ home, cwd }, 'hello');
    await until(() => t.idles() === 1);
    expect(t.requests().find((r) => r.method === 'session/new')!.params._meta.antigravity.systemPrompt.append).toBe('You are a test agent.');
  });

  test("a repository whose commands wait for the owner's trust and that brings Antigravity hooks of its own does not start", async () => {
    const home = scratch();
    const cwd = join(home, 'work');
    mkdirSync(join(cwd, '.agents'), { recursive: true });
    writeFileSync(join(cwd, '.agents', 'hooks.json'), '{}');
    const s = start({ home, cwd, untrusted: true }, 'hello');
    await until(() => s.events.some((e) => e.type === 'error'));
    expect(s.events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('.agents/hooks.json') });
    expect(s.requests()).toEqual([]);
  });

  test("the sandbox lets the agent write a worktree's git directory and read the git configuration, while it runs", async () => {
    const home = scratch();
    const repo = gitRepo(join(home, 'repo'));
    const worktree = join(home, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'card', worktree);
    const project = join(home, 'gemini', 'config', 'projects', 'default-cli-project.json');
    const s = start({ home, cwd: worktree }, 'hello');
    await until(() => s.idles() === 1);
    const allow: string[] = JSON.parse(readFileSync(project, 'utf8')).permissionGrants.permissionGrants.allow;
    expect(allow).toContain(`write_file(${join(realpathSync(repo), '.git')})`);
    expect(allow).toContain(`write_file(${tmpdir()})`);
    expect(allow.some((a) => /^read_file\(.*\.gitconfig\)$/.test(a)) || !existsSync(join(process.env.HOME!, '.gitconfig'))).toBe(true);
    // the next session's start leaves out the grants of one that has ended
    s.session.close();
    await s.session.done;
    const t = start({ home, readOnly: true, tools: [] }, 'hello');
    await until(() => t.idles() === 1);
    expect(JSON.parse(readFileSync(project, 'utf8')).permissionGrants.permissionGrants.allow).not.toContain(`write_file(${join(realpathSync(repo), '.git')})`);
  });

  test("the owner's own global rules and MCP servers come along into Obeya's directory, with the skills of Obeya's plugin", async () => {
    const home = scratch();
    mkdirSync(join(home, 'own-gemini', 'config'), { recursive: true });
    writeFileSync(join(home, 'own-gemini', 'GEMINI.md'), 'Be brief.\n');
    writeFileSync(join(home, 'own-gemini', 'config', 'mcp_config.json'), '{"mcpServers":{}}');
    const plugin = join(home, 'plugin');
    mkdirSync(join(plugin, 'skills', 'demo'), { recursive: true });
    const s = start({ home, plugins: [plugin] }, 'hello');
    await until(() => s.idles() === 1);
    expect(readFileSync(join(home, 'gemini', 'GEMINI.md'), 'utf8')).toBe('Be brief.\n');
    expect(readFileSync(join(home, 'gemini', 'config', 'mcp_config.json'), 'utf8')).toBe('{"mcpServers":{}}');
    expect(JSON.parse(readFileSync(join(home, 'gemini', 'config', 'skills.json'), 'utf8'))).toEqual({ entries: [{ path: join(plugin, 'skills') }] });
  });

  test('on a host, Gemini does not start', async () => {
    const s = start({ cwd: scratch() }, 'hello');
    await until(() => s.idles() === 1);
    const events: AgentEvent[] = [];
    const runtime = geminiRuntime({ dir: join(scratch(), 'gemini') });
    const h = runtime.start({ cwd: 'ssh://build-box/home/ada/work', system: '', tools: [], onEvent: (e) => events.push(e), env: { OBEYA_AGY: FAKE } }, 'hello');
    sessions.push(h);
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('only on this machine') });
  });
});

describe.skipIf(process.platform === 'win32')('Gemini on this machine', () => {
  test('is found with its version and login, and lists Gemini’s own models, each once with the efforts it takes', async () => {
    const env = { ...process.env, OBEYA_AGY: FAKE };
    expect(await findGemini(env)).toEqual({ version: '1.5.13', loggedIn: true, how: 'Google' });
    expect(await geminiLogin(FAKE, { ...env, FAKE_AGY_QUOTA: 'apikey' })).toEqual({ loggedIn: true, how: 'API key' });
    expect(await geminiLogin(FAKE, { ...env, FAKE_AGY_QUOTA: 'loggedout' })).toEqual({ loggedIn: false });
    expect(await geminiModels(env)).toEqual([
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high', 'xhigh'] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['medium', 'high'] },
    ]);
    expect(await findGemini({ ...process.env, OBEYA_AGY: join(scratch(), 'none') })).toBeNull();
  });

  test('offers its families in the Configuration, and is ready once a look found its login', async () => {
    const h = new Harnesses({ cwd: '/tmp', claude: async () => null, codex: async () => null, gemini: async () => ({ version: '1.5.13', loggedIn: true }), geminiModels: async () => geminiModelsOf([{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }]) });
    expect(h.ready('gemini')).toBe(false);
    await h.refresh();
    expect(h.ready('gemini')).toBe(true);
    expect(h.preferred()).toBe('gemini');
    const gemini = (await h.view()).find((v) => v.id === 'gemini')!;
    expect(gemini).toEqual({ id: 'gemini', ready: true, version: '1.5.13', models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['high'] }] });
  });
});

test("agy's models: Gemini's own, one per model with its efforts, the newest of a family resolving it", () => {
  const models = geminiModelsOf([
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'gemini-4.1-neon-medium', name: 'Gemini 4.1 Neon (Medium)' },
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ]);
  expect(models.map((m) => [m.id, m.efforts])).toEqual([
    ['gemini-4-neon', ['low', 'high']],
    ['gemini-4.1-neon', ['medium']],
  ]);
  expect(resolveGeminiModel(models, 'gemini-#-neon')?.id).toBe('gemini-4.1-neon');
  expect(resolveGeminiModel(models, 'gemini-4-neon')?.id).toBe('gemini-4.1-neon');
  expect(resolveGeminiModel(models, 'gemini-#-flash')).toBeUndefined();
});

test("the quota for the bar: Gemini's week and five hours, Argon's own week as a scope, agy's Claude and GPT group left out", () => {
  const report = {
    command: {
      data: {
        groups: [
          { name: 'Gemini Models', buckets: [{ id: 'w', window: 'weekly', remaining_fraction: 0.94, reset_time: '2026-11-25T19:22:45Z' }, { id: 'f', window: '5h', remaining_fraction: 0, reset_time: '2026-11-21T03:24:51Z' }] },
          { name: 'Claude and GPT models', buckets: [{ id: 'c', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-27T23:00:05Z' }] },
          { name: 'Gemini 4 Argon', buckets: [{ id: 'a', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-27T23:00:05Z' }] },
        ],
      },
    },
  };
  expect(geminiUsageOf(report, new Date('2026-11-21T00:00:00Z'))).toEqual({
    at: '2026-11-21T00:00:00.000Z',
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 6, resetsAt: '2026-11-25T19:22:45.000Z', windowMinutes: 10_080, severity: 'normal' },
      { kind: 'session', group: 'session', percent: 100, resetsAt: '2026-11-21T03:24:51.000Z', windowMinutes: 300, severity: 'critical' },
      { kind: 'weekly_scoped', group: 'weekly', scope: 'Gemini 4 Argon', percent: 50, resetsAt: '2026-11-27T23:00:05.000Z', windowMinutes: 10_080, severity: 'normal' },
    ],
  });
  // a turn on Neon waits for Gemini's five hours, which ran out; one on Argon for the earliest of what it counts against
  expect(quotaResets(report, 'gemini-4-neon')).toBe(Date.parse('2026-11-21T03:24:51Z'));
  expect(quotaResets({ command: { data: { groups: [report.command.data.groups[2]!] } } }, 'gemini-4-argon')).toBe(Date.parse('2026-11-27T23:00:05Z'));
  expect(geminiUsageOf({})).toBeNull();
});

test("agy's tool calls as Claude Code's", () => {
  expect(geminiCall('1', 'run_command', { CommandLine: 'bun test', BypassSandbox: false })).toEqual({ id: '1', name: 'Bash', input: { command: 'bun test' } });
  expect(geminiCall('2', 'write_file', { Path: '/w/a.txt', Content: 'x' })).toEqual({ id: '2', name: 'Write', input: { file_path: '/w/a.txt' } });
  expect(geminiCall('3', 'edit_file', { Path: '/w/a.txt', Target: 'x', Replacement: 'y' })).toEqual({ id: '3', name: 'Edit', input: { file_path: '/w/a.txt' } });
  expect(geminiCall('4', 'mcp_obeya_report', { status: 's' })).toEqual({ id: '4', name: 'mcp__obeya__report', input: { status: 's' } });
  expect(geminiCall('5', 'browser_click', { x: 1 })).toEqual({ id: '5', name: 'browser_click', input: { x: 1 } });
});

test("Obeya's hook acts only in Obeya's sessions, and lets a call run where it cannot reach Obeya", () => {
  const unix = hooksFile(false).obeya.PreToolUse[0]!.hooks[0]!.command;
  expect(unix).toContain('"$OBEYA_GEMINI_HOOK"');
  expect(unix).toEndWith('|| true');
  expect(hooksFile(true).obeya.PreToolUse[0]!.hooks[0]!.command).toContain('%OBEYA_GEMINI_HOOK%');
});

test("Gemini's tokens at Google's list prices of the day: Argon and Flash rise on the days named, an unknown model at its family's newest, else Neon's", () => {
  const tokens = { inputTokens: 1_000_000, cachedReadTokens: 1_000_000, outputTokens: 1_000_000 };
  expect(geminiCost('gemini-4-neon', tokens)).toBeCloseTo(3 + 0.15 + 15, 6);
  expect(geminiCost('gemini-4-argon', tokens, new Date('2026-11-30T12:00:00Z'))).toBeCloseTo(2 + 0.1 + 10, 6);
  expect(geminiCost('gemini-4-argon', tokens, new Date('2026-12-01T12:00:00Z'))).toBeCloseTo(4 + 0.2 + 20, 6);
  expect(geminiCost('gemini-3.8-flash', tokens, new Date('2027-01-01T12:00:00Z'))).toBeCloseTo(1.5 + 0.15 + 7.5, 6);
  expect(geminiCost('gemini-4.1-hydrogen', tokens)).toBeCloseTo(1.5 + 0.075 + 7.5, 6);
  expect(geminiCost('gemini-5-carbon', tokens)).toBeCloseTo(3 + 0.15 + 15, 6);
});

test("sessions starting at once each keep their sandbox grants: no start writes an older picture over another's", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-gemini-dir-'));
  try {
    const g = new GeminiDir(join(dir, 'gemini'), join(dir, 'own'));
    const a = {};
    const b = {};
    await Promise.all([g.prepare(a, { read: [], write: ['/a'] }, []), g.prepare(b, { read: [], write: ['/b'] }, [])]);
    const allow = () => JSON.parse(readFileSync(join(dir, 'gemini', 'config', 'projects', 'default-cli-project.json'), 'utf8')).permissionGrants.permissionGrants.allow;
    expect(allow()).toEqual(['write_file(/a)', 'write_file(/b)']);
    g.release(a);
    await g.prepare(b, { read: [], write: ['/b'] }, []);
    expect(allow()).toEqual(['write_file(/b)']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
