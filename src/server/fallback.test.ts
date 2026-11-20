import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentSetting, type Harness, replacement } from '../core/agents';
import { HarnessLimits } from './limits';
import { type AgentEvent, type Availability, placeAgent, withAgentSetting, withFallback, withLimitRecord, withLimitWait } from './runtime';
import { agentSetting, saveAgents } from './settings';
import { FakeRuntime } from './testing';

const claude: AgentSetting = { harness: 'claude', model: 'opus', effort: 'high', fallback: { harness: 'codex', model: 'gpt-#-sol' } };
const avail = (limited: Partial<Record<Harness, number>>, ready: Harness[] = ['claude', 'codex']): Availability => ({
  limit: (h) => (limited[h] ? { until: limited[h]! } : undefined),
  ready: (h) => ready.includes(h),
});

test("a group's fallback is the other harness's model, and a card on that harness falls back on the group's own", () => {
  expect(replacement(claude, 'claude')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'high' });
  expect(replacement(claude, 'codex', 'low')).toEqual({ harness: 'claude', model: 'opus', effort: 'low' });
  expect(replacement({ ...claude, fallback: undefined }, 'claude')).toBeUndefined();
});

test('a new agent whose harness is at its limit starts on the fallback where that is ready and free; a resumed one stays, with the fallback model', () => {
  const later = Date.now() + 60_000;
  expect(placeAgent({ cwd: '/r', role: 'worker' }, claude, avail({}))).toEqual({ harness: 'claude', model: 'opus', effort: 'high' });
  expect(placeAgent({ cwd: '/r', role: 'worker' }, claude, avail({ claude: later }))).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'high', moved: { from: 'claude', limit: { until: later } } });
  // no fallback, the fallback not set up, or at its limit too: it stays and waits
  expect(placeAgent({ cwd: '/r', role: 'worker' }, { ...claude, fallback: undefined }, avail({ claude: later })).harness).toBe('claude');
  expect(placeAgent({ cwd: '/r', role: 'worker' }, claude, avail({ claude: later }, ['claude'])).harness).toBe('claude');
  expect(placeAgent({ cwd: '/r', role: 'worker' }, claude, avail({ claude: later, codex: later })).harness).toBe('claude');
  // a card chosen for Codex goes to the group's own setting while Codex is at its limit
  expect(placeAgent({ cwd: '/r', role: 'worker', agent: { harness: 'codex', model: 'gpt-#-terra' } }, claude, avail({ codex: later }))).toMatchObject({ harness: 'claude', model: 'opus' });
  // resumed on the fallback's harness, it keeps the fallback's model, not that harness's preset
  expect(placeAgent({ cwd: '/r', role: 'worker', resume: 'codex:t1' }, { ...claude, fallback: { harness: 'codex', model: 'gpt-#-terra' } }, avail({}))).toEqual({ harness: 'codex', model: 'gpt-#-terra', effort: 'high' });
});

test('a Gemini group or fallback works as the others; on a host, where Gemini does not run, a Gemini group runs on its fallback, else on Claude Code', () => {
  const later = Date.now() + 60_000;
  const gemini = { harness: 'gemini' as const, model: 'gemini-#-neon', effort: 'high' as const, fallback: { harness: 'codex' as const, model: 'gpt-#-sol' } };
  expect(placeAgent({ cwd: '/r', role: 'worker' }, gemini, avail({}))).toEqual({ harness: 'gemini', model: 'gemini-#-neon', effort: 'high' });
  expect(placeAgent({ cwd: '/r', role: 'worker' }, gemini, avail({ gemini: later }))).toMatchObject({ harness: 'codex', model: 'gpt-#-sol', moved: { from: 'gemini' } });
  expect(placeAgent({ cwd: '/r', role: 'worker' }, { ...claude, fallback: { harness: 'gemini', model: 'gemini-#-flash' } }, avail({ claude: later }, ['claude', 'gemini']))).toMatchObject({ harness: 'gemini', model: 'gemini-#-flash' });
  expect(placeAgent({ cwd: 'ssh://box/w', role: 'worker' }, gemini, avail({}))).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'high' });
  expect(placeAgent({ cwd: 'ssh://box/w', role: 'worker' }, { ...gemini, fallback: undefined }, avail({}))).toEqual({ harness: 'claude', model: 'opus', effort: 'high' });
});

test('an agent placed on the fallback hears so first, and gets the system prompt of that harness', () => {
  const fake = new FakeRuntime();
  const runtime = withAgentSetting(fake, () => claude, avail({ claude: Date.now() + 60_000 }));
  const events: AgentEvent[] = [];
  runtime.start({ cwd: '/r', role: 'worker', system: 'any', systemFor: (h) => `waits as ${h} does`, tools: [], onEvent: (e) => events.push(e) }, 'Los.');
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-sol', system: 'waits as codex does' });
  expect(events).toEqual([{ type: 'moved', from: 'claude', to: { harness: 'codex', model: 'gpt-#-sol', effort: 'high' }, until: expect.any(Number) }]);
});

test("a new agent the limit stops before it did anything starts afresh on the fallback, with what it was sent; one that acted waits", () => {
  const fake = new FakeRuntime();
  const limits = new HarnessLimits();
  const a: Availability = { limit: (h) => limits.of(h), ready: () => true };
  const runtime = withFallback(withAgentSetting(withLimitRecord(fake, limits), () => claude, a), () => claude, a, limits);
  const events: AgentEvent[] = [];
  runtime.start({ cwd: '/r', role: 'coordinator', system: '', tools: [], onEvent: (e) => events.push(e) }, 'Schätze K12.');
  const first = fake.last;
  expect(first.spec.harness).toBe('claude');
  first.emit({ type: 'session', id: 'claude-1' });
  first.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 60_000 } });
  // the harness is at its limit for every agent now, and this one moved without its error
  expect(limits.of('claude')).toBeDefined();
  expect(first.closed).toBe(true);
  const second = fake.last;
  expect(second).not.toBe(first);
  expect(second.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-sol' });
  expect(second.inbox).toEqual(['Schätze K12.']);
  expect(events).toEqual([{ type: 'session', id: 'claude-1' }, { type: 'moved', from: 'claude', to: { harness: 'codex', model: 'gpt-#-sol', effort: 'high' }, until: expect.any(Number) }]);
  second.emit({ type: 'session', id: 'codex:t1' });
  second.emit({ type: 'text', text: 'K12 ändert src/a.ts.' });
  expect(events.slice(2)).toEqual([{ type: 'session', id: 'codex:t1' }, { type: 'text', text: 'K12 ändert src/a.ts.' }]);

  // one that started while the limit holds starts on the fallback at once
  runtime.start({ cwd: '/r', role: 'coordinator', system: '', tools: [], onEvent: () => {} }, 'Noch eine.');
  expect(fake.last.spec.harness).toBe('codex');

  // one that did something keeps its conversation where it is: the limit is its to wait for
  limits.lifted('claude');
  const own: AgentEvent[] = [];
  runtime.start({ cwd: '/r', role: 'coordinator', system: '', tools: [], onEvent: (e) => own.push(e) }, 'Lies das.');
  const s = fake.last;
  s.emit({ type: 'tool', name: 'Read', input: {} });
  s.emit({ type: 'error', message: 'limit', limit: { resetsAt: Date.now() + 60_000 } });
  expect(fake.last).toBe(s);
  expect(own.at(-1)).toMatchObject({ type: 'error' });
});

test('an agent that waits for the limit moves to the fallback once the owner sets one', async () => {
  const fake = new FakeRuntime();
  const limits = new HarnessLimits();
  let group: AgentSetting = { ...claude, fallback: undefined };
  const a: Availability = { limit: (h) => limits.of(h), ready: () => true };
  const runtime = withFallback(withLimitWait(withAgentSetting(withLimitRecord(fake, limits), () => group, a), 10), () => group, a, limits);
  const waits: (number | undefined)[] = [];
  runtime.start({ cwd: '/r', role: 'chores', system: '', tools: [], onLimit: (until) => waits.push(until), onEvent: () => {} }, 'Benenne die Karte.');
  const first = fake.last;
  first.emit({ type: 'error', message: 'limit', limit: { resetsAt: Date.now() + 60_000 } });
  first.emit({ type: 'idle' });
  // no fallback: it waits
  expect(waits).toHaveLength(1);
  expect(fake.last).toBe(first);
  group = claude;
  limits.changed();
  expect(first.closed).toBe(true);
  expect(fake.last.spec.harness).toBe('codex');
  expect(fake.last.inbox).toEqual(['Benenne die Karte.']);
  // it waits no more where it showed
  expect(waits.at(-1)).toBeUndefined();
});

test('the fallback is saved per group on the other harness, and a group moved onto that harness has none', () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-fallback-'));
  saveAgents(home, { worker: { fallback: { harness: 'codex', model: 'gpt-6.1-terra' } } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'claude', model: 'opus', effort: 'high', fallback: { harness: 'codex', model: 'gpt-#-terra' } });
  // without a model, that harness's preset
  saveAgents(home, { coordinator: { fallback: { harness: 'codex' } } });
  expect(agentSetting(home, 'coordinator').fallback).toEqual({ harness: 'codex', model: 'gpt-#-sol' });
  expect(() => saveAgents(home, { worker: { fallback: { harness: 'claude' } } })).toThrow('other harness');
  // with an effort of its own
  saveAgents(home, { worker: { fallback: { harness: 'codex', model: 'gpt-#-sol', effort: 'low' } } });
  expect(agentSetting(home, 'worker').fallback).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'low' });
  expect(replacement(agentSetting(home, 'worker'), 'claude')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'low' });
  saveAgents(home, { worker: { fallback: null } });
  expect(agentSetting(home, 'worker').fallback).toBeUndefined();
  saveAgents(home, { coordinator: { harness: 'codex' } });
  expect(agentSetting(home, 'coordinator').fallback).toBeUndefined();
});

test("a limit on a host is that host's: agents here keep their harness, and one on the host waits there", () => {
  const limits = new HarnessLimits();
  limits.hit('claude', Date.now() + 60_000, false, 'build-box');
  expect(limits.of('claude')).toBeUndefined();
  const a: Availability = { limit: (h) => limits.of(h), ready: () => true };
  limits.hit('claude', Date.now() + 60_000);
  expect(placeAgent({ cwd: 'ssh://build-box/repo', role: 'worker' }, claude, a).harness).toBe('claude');
  expect(placeAgent({ cwd: '/r', role: 'worker' }, claude, a).harness).toBe('codex');
});
