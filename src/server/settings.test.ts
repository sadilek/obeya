import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf } from '../core/locale';
import { AGENT_DEFAULTS, type AgentSetting } from '../core/types';
import { byHarness, withAgentSetting } from './runtime';
import { OWNER_SETTINGS_FILE as SETTINGS_FILE, systemLanguage } from '../../plugin/skills/demo/lib/language.ts';
import { agentSetting, agentsView, conversationLanguage, languageView, ownerLanguage, saveAgents, saveLanguage, saveTheme, saveUsageMeter, themeView, usageMeterView, costsView, saveCosts } from './settings';
import { FakeRuntime } from './testing';

const homes: string[] = [];
const scratchHome = () => homes[homes.push(mkdtempSync(join(tmpdir(), 'obeya-settings-'))) - 1]!;
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })));

test('a locale names a language Obeya speaks, or none', () => {
  expect(languageOf('de_DE.UTF-8')).toBe('de');
  expect(languageOf('en-GB')).toBe('en');
  expect(languageOf('DE')).toBe('de');
  expect(languageOf('fr_FR')).toBeUndefined();
  expect(languageOf('')).toBeUndefined();
});

test('the system language: the Mac interface first, else the locale variables in POSIX order, else English', () => {
  const none = () => undefined;
  expect(systemLanguage({ LANG: 'de_DE.UTF-8' }, 'linux', none)).toBe('de');
  expect(systemLanguage({ LC_ALL: 'en_US.UTF-8', LANG: 'de_DE.UTF-8' }, 'linux', none)).toBe('en');
  expect(systemLanguage({ LC_MESSAGES: 'de_AT', LANG: 'en_GB' }, 'linux', none)).toBe('de');
  // C names no language: the next variable decides
  expect(systemLanguage({ LC_ALL: 'C', LANG: 'de_DE.UTF-8' }, 'linux', none)).toBe('de');
  expect(systemLanguage({ LANG: 'fr_FR.UTF-8' }, 'linux', none)).toBe('en');
  expect(systemLanguage({ LANG: 'en_US.UTF-8' }, 'darwin', () => 'de-DE')).toBe('de');
  expect(systemLanguage({ LANG: 'de_DE.UTF-8' }, 'darwin', none)).toBe('de');
  // the Mac's preference is only asked on a Mac
  expect(systemLanguage({ LANG: 'en_US.UTF-8' }, 'linux', () => 'de-DE')).toBe('en');
});

test('the conversation language follows the interface until chosen, each saved on its own beside the other settings', () => {
  const home = scratchHome();
  expect(languageView(home, 'de')).toMatchObject({ chosen: null, language: 'de', conversationChosen: null, conversation: 'de' });
  saveLanguage(home, { language: 'en' });
  expect(languageView(home, 'de')).toMatchObject({ chosen: 'en', language: 'en', conversationChosen: null, conversation: 'en' });
  expect(conversationLanguage(home)).toBe('en');
  saveLanguage(home, { conversation: 'de' });
  expect(languageView(home, 'de')).toMatchObject({ chosen: 'en', language: 'en', conversationChosen: 'de', conversation: 'de' });
  expect([ownerLanguage(home), conversationLanguage(home)]).toEqual(['en', 'de']);
  // the interface switched back and forth leaves the conversation where it is
  saveLanguage(home, { language: 'de' });
  saveLanguage(home, { language: 'en' });
  expect(conversationLanguage(home)).toBe('de');
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en', conversationLanguage: 'de' });
  saveLanguage(home, { conversation: null });
  expect(conversationLanguage(home)).toBe('en');
  for (const bad of [{}, { conversation: 'fr' }, { language: 'de', conversation: 'fr' }, null]) expect(() => saveLanguage(home, bad)).toThrow();
});

test("the harness, model and effort per group of agents: preset, chosen one group at a time beside the language, the file keeping only what differs", () => {
  const home = scratchHome();
  expect(agentsView(home).agents).toEqual({
    coordinator: { harness: 'claude', model: 'opus', effort: 'medium' },
    worker: { harness: 'claude', model: 'opus', effort: 'high' },
    explorer: { harness: 'claude', model: 'opus', effort: 'high' },
    chores: { harness: 'claude', model: 'opus', effort: 'medium' },
  });
  saveLanguage(home, { language: 'en' });
  saveAgents(home, { worker: { model: 'fable', effort: 'xhigh' } });
  saveAgents(home, { coordinator: { model: 'haiku' }, chores: { model: 'default' } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'claude', model: 'fable', effort: 'xhigh' });
  expect(agentSetting(home, 'coordinator')).toEqual({ harness: 'claude', model: 'haiku', effort: 'medium' });
  expect(agentSetting(home, 'chores')).toEqual({ harness: 'claude', model: 'default', effort: 'medium' });
  saveAgents(home, { worker: { model: 'opus' } });
  saveLanguage(home, { language: 'de' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de', agents: { coordinator: { model: 'haiku' }, worker: { effort: 'xhigh' }, chores: { model: 'default' } } });
  // back to the presets: the file keeps no list
  saveAgents(home, { coordinator: { model: 'opus' }, worker: { effort: 'high' }, chores: { model: 'opus' } });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de' });
  for (const bad of [{ boss: {} }, { worker: { model: 'gpt' } }, { worker: { effort: null } }, { worker: { effort: 'huge' } }, { worker: { model: 'opus', fast: true } }, { worker: { harness: 'pi' } }, { worker: { harness: 'codex', model: 'gpt 6 sol' } }])
    expect(() => saveAgents(home, bad)).toThrow();
  // what the file holds beyond the known choices is left out
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { worker: { model: 'gpt', effort: 'low' }, boss: { model: 'opus' } } }));
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'claude', model: 'opus', effort: 'low' });
});

test("the Coordinator's choice written under its German name `koordinator` still holds, and goes under `coordinator` with the next save", () => {
  const home = scratchHome();
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { koordinator: { model: 'haiku' } } }));
  expect(agentSetting(home, 'coordinator')).toEqual({ harness: 'claude', model: 'haiku', effort: 'medium' });
  saveAgents(home, { worker: { effort: 'xhigh' } });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')).agents).toEqual({ coordinator: { model: 'haiku' }, worker: { effort: 'xhigh' } });
});

test("a group on Codex: another harness starts from its preset family (Sol), keeps the effort, and stores a family, a model id as its family", () => {
  const home = scratchHome();
  saveAgents(home, { worker: { model: 'fable', effort: 'xhigh' } });
  saveAgents(home, { worker: { harness: 'codex' } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'xhigh' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')).agents).toEqual({ worker: { harness: 'codex', effort: 'xhigh' } });
  saveAgents(home, { worker: { model: 'gpt-#-luna' } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'codex', model: 'gpt-#-luna', effort: 'xhigh' });
  saveAgents(home, { worker: { model: 'gpt-6.1-terra' } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'codex', model: 'gpt-#-terra', effort: 'xhigh' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')).agents).toEqual({ worker: { harness: 'codex', model: 'gpt-#-terra', effort: 'xhigh' } });
  // a Claude alias is no Codex model
  expect(() => saveAgents(home, { worker: { model: 'opus' } })).toThrow();
  // back on Claude Code, its default model again
  saveAgents(home, { worker: { harness: 'claude' } });
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'claude', model: 'opus', effort: 'xhigh' });
});

test('a settings file from before families: a Codex model id reads as its family, `default` as the preset; the next save writes the family', () => {
  const home = scratchHome();
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { worker: { harness: 'codex', model: 'gpt-6.1-terra' }, explorer: { harness: 'codex', model: 'default' }, chores: { harness: 'codex', model: 'gpt-5.6-sol' } } }));
  expect(agentSetting(home, 'worker')).toEqual({ harness: 'codex', model: 'gpt-#-terra', effort: 'high' });
  expect(agentSetting(home, 'explorer')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'high' });
  expect(agentSetting(home, 'chores')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'medium' });
  saveAgents(home, { worker: { effort: 'low' } });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')).agents).toEqual({ worker: { harness: 'codex', model: 'gpt-#-terra', effort: 'low' }, explorer: { harness: 'codex' }, chores: { harness: 'codex' } });
  // the API takes `default` as the preset too
  saveAgents(home, { worker: { model: 'default' } });
  expect(agentSetting(home, 'worker').model).toBe('gpt-#-sol');
});

test('a group the owner chose no harness for runs on the fallback (Codex on a machine with only Codex), without a Claude model it would not take', () => {
  const home = scratchHome();
  saveAgents(home, { coordinator: { model: 'haiku' } });
  expect(agentSetting(home, 'coordinator', 'codex')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'medium' });
  expect(agentSetting(home, 'worker', 'codex')).toEqual({ harness: 'codex', model: 'gpt-#-sol', effort: 'high' });
  expect(agentsView(home, [], 'codex').agents.chores.harness).toBe('codex');
  // the configuration names that preset
  expect(agentsView(home, [], 'codex').preset).toBe('codex');
  expect(agentsView(home).preset).toBe('claude');
  // Claude Code chosen outright stays, whatever the fallback
  saveAgents(home, { worker: { harness: 'claude' } }, [], 'codex');
  expect(agentSetting(home, 'worker', 'codex')).toEqual({ harness: 'claude', model: 'opus', effort: 'high' });
});

test("an agent of a group starts on the group's harness with its model and effort, asked at every start; Claude Code's default model is none given, Codex always gets a family", () => {
  const fake = new FakeRuntime();
  let worker: AgentSetting = { harness: 'claude', model: 'opus', effort: 'high' };
  const runtime = withAgentSetting(fake, (role) => (role === 'worker' ? worker : AGENT_DEFAULTS[role]));
  const spec = { cwd: '/r', system: '', tools: [], onEvent: () => {} };
  runtime.start({ ...spec, role: 'worker' });
  expect(fake.last.spec).toMatchObject({ harness: 'claude', model: 'opus', effort: 'high' });
  worker = { harness: 'claude', model: 'default', effort: 'max' };
  runtime.start({ ...spec, role: 'worker', model: 'sonnet', effort: 'low' });
  expect(fake.last.spec.effort).toBe('max');
  expect('model' in fake.last.spec).toBe(false);
  runtime.start({ ...spec, role: 'chores' });
  expect(fake.last.spec).toMatchObject({ model: 'opus', effort: 'medium' });
  worker = { harness: 'codex', model: 'gpt-#-terra', effort: 'high' };
  runtime.start({ ...spec, role: 'worker' });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-terra', effort: 'high' });
  // a worker on another machine runs on its group's harness too, the family resolved there
  runtime.start({ ...spec, cwd: 'ssh://mini/r', role: 'worker' });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-terra', effort: 'high' });
  // a session resumed stays on its harness: a Claude Code one after the group moved to Codex, and back
  runtime.start({ ...spec, role: 'worker', resume: 'b9e1c0de-claude-session' });
  expect(fake.last.spec).toMatchObject({ harness: 'claude', model: 'opus', effort: 'high' });
  worker = { harness: 'claude', model: 'fable', effort: 'low' };
  runtime.start({ ...spec, role: 'worker', resume: 'codex:01a1a0cf-thread' });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-sol', effort: 'low' });
  // an agent of no group starts as its job says
  runtime.start({ ...spec, effort: 'low' });
  expect(fake.last.spec.effort).toBe('low');
  expect(fake.last.spec.model).toBeUndefined();
});

test("an agent with a harness, model or effort of its own (a card's) starts on them, the rest its group's, and resumes on its session's harness", () => {
  const fake = new FakeRuntime();
  const runtime = withAgentSetting(fake, (role) => (role === 'worker' ? { harness: 'claude', model: 'opus', effort: 'xhigh' } : AGENT_DEFAULTS[role]));
  const spec = { cwd: '/r', system: '', tools: [], onEvent: () => {}, role: 'worker' as const };
  runtime.start({ ...spec, agent: { harness: 'codex', model: 'gpt-#-luna' } });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-luna', effort: 'xhigh' });
  expect('agent' in fake.last.spec).toBe(false);
  runtime.start({ ...spec, agent: { harness: 'claude', model: 'default' } });
  expect(fake.last.spec).toMatchObject({ harness: 'claude', effort: 'xhigh' });
  expect('model' in fake.last.spec).toBe(false);
  // its later turns keep the card's model, not the group's
  runtime.start({ ...spec, agent: { harness: 'claude', model: 'sonnet' }, resume: 'b9e1c0de-claude-session' });
  expect(fake.last.spec).toMatchObject({ harness: 'claude', model: 'sonnet' });
  // a session on another harness than the one chosen goes on there, on its default model
  runtime.start({ ...spec, agent: { harness: 'claude', model: 'sonnet' }, resume: 'codex:01a1a0cf-thread' });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-sol', effort: 'xhigh' });
  // an effort of its own, on the group's harness and model or on its own
  runtime.start({ ...spec, agent: { effort: 'low' } });
  expect(fake.last.spec).toMatchObject({ harness: 'claude', model: 'opus', effort: 'low' });
  runtime.start({ ...spec, agent: { harness: 'codex', model: 'gpt-#-sol', effort: 'medium' } });
  expect(fake.last.spec).toMatchObject({ harness: 'codex', model: 'gpt-#-sol', effort: 'medium' });
});

test('byHarness starts each agent on the runtime of the harness its spec names, Claude Code where it names none', () => {
  const claude = new FakeRuntime();
  const codex = new FakeRuntime();
  const runtime = byHarness({ claude, codex });
  const spec = { cwd: '/r', system: '', tools: [], onEvent: () => {} };
  runtime.start({ ...spec, harness: 'codex' });
  runtime.start(spec);
  runtime.start({ ...spec, resume: 'codex:thread-1' });
  expect(codex.sessions.length).toBe(2);
  expect(claude.sessions.length).toBe(1);
});


test('light or dark: as the system until chosen, beside the other settings, and back to the system with null', () => {
  const home = scratchHome();
  expect(themeView(home).chosen).toBeNull();
  saveLanguage(home, { language: 'en' });
  expect(saveTheme(home, { theme: 'dark' }).chosen).toBe('dark');
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en', theme: 'dark' });
  saveLanguage(home, { language: 'de' });
  expect(themeView(home).chosen).toBe('dark');
  expect(saveTheme(home, { theme: null }).chosen).toBeNull();
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de' });
  for (const bad of [{ theme: 'sepia' }, {}, null]) expect(() => saveTheme(home, bad)).toThrow();
  // an unknown look in the file follows the system
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ theme: 'sepia' }));
  expect(themeView(home).chosen).toBeNull();
});

test('the usage limits in the bar: shown until turned off, which alone stands in the file', () => {
  const home = scratchHome();
  expect(usageMeterView(home).on).toBe(true);
  saveLanguage(home, { language: 'en' });
  expect(saveUsageMeter(home, { on: false }).on).toBe(false);
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en', usageMeter: false });
  expect(saveUsageMeter(home, { on: true }).on).toBe(true);
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en' });
  for (const bad of [{ on: 'no' }, {}, null]) expect(() => saveUsageMeter(home, bad)).toThrow();
  // anything else in the file shows them
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ usageMeter: 'off' }));
  expect(usageMeterView(home).on).toBe(true);
});

test('costs: not shown until turned on, which alone stands in the file', () => {
  const home = scratchHome();
  expect(costsView(home).on).toBe(false);
  saveLanguage(home, { language: 'en' });
  expect(saveCosts(home, { on: true }).on).toBe(true);
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en', costs: true });
  expect(saveCosts(home, { on: false }).on).toBe(false);
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en' });
  for (const bad of [{ on: 'yes' }, {}, null]) expect(() => saveCosts(home, bad)).toThrow();
  // anything else in the file shows none
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ costs: 'on' }));
  expect(costsView(home).on).toBe(false);
});
