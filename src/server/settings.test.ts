import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf } from '../core/locale';
import { AGENT_DEFAULTS, type AgentSetting } from '../core/types';
import { withAgentSetting } from './runtime';
import { OWNER_SETTINGS_FILE as SETTINGS_FILE, systemLanguage } from '../../plugin/skills/demo/lib/language.ts';
import { agentSetting, agentsView, conversationLanguage, languageView, ownerLanguage, saveAgents, saveLanguage, saveTheme, saveUsageMeter, themeView, usageMeterView } from './settings';
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

test("the model and effort per group of agents: preset, chosen one group at a time beside the language, the file keeping only what differs", () => {
  const home = scratchHome();
  expect(agentsView(home).agents).toEqual({
    koordinator: { model: 'opus', effort: 'medium' },
    worker: { model: 'opus', effort: 'high' },
    explorer: { model: 'opus', effort: 'high' },
    chores: { model: 'opus', effort: 'medium' },
  });
  saveLanguage(home, { language: 'en' });
  saveAgents(home, { worker: { model: 'fable', effort: 'xhigh' } });
  saveAgents(home, { koordinator: { model: 'haiku' }, chores: { model: 'default' } });
  expect(agentSetting(home, 'worker')).toEqual({ model: 'fable', effort: 'xhigh' });
  expect(agentSetting(home, 'koordinator')).toEqual({ model: 'haiku', effort: 'medium' });
  expect(agentSetting(home, 'chores')).toEqual({ model: 'default', effort: 'medium' });
  saveAgents(home, { worker: { model: 'opus' } });
  saveLanguage(home, { language: 'de' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de', agents: { koordinator: { model: 'haiku' }, worker: { effort: 'xhigh' }, chores: { model: 'default' } } });
  // back to the presets: the file keeps no list
  saveAgents(home, { koordinator: { model: 'opus' }, worker: { effort: 'high' }, chores: { model: 'opus' } });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de' });
  for (const bad of [{ boss: {} }, { worker: { model: 'gpt' } }, { worker: { effort: null } }, { worker: { effort: 'huge' } }, { worker: { model: 'opus', fast: true } }]) expect(() => saveAgents(home, bad)).toThrow();
  // what the file holds beyond the known choices is left out
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { worker: { model: 'gpt', effort: 'low' }, boss: { model: 'opus' } } }));
  expect(agentSetting(home, 'worker')).toEqual({ model: 'opus', effort: 'low' });
});

test("an agent of a group starts with the group's model and effort, asked at every start; Claude Code's default model is none given", () => {
  const fake = new FakeRuntime();
  let worker: AgentSetting = { model: 'opus', effort: 'high' };
  const runtime = withAgentSetting(fake, (role) => (role === 'worker' ? worker : AGENT_DEFAULTS[role]));
  const spec = { cwd: '/r', system: '', tools: [], onEvent: () => {} };
  runtime.start({ ...spec, role: 'worker' });
  expect(fake.last.spec).toMatchObject({ model: 'opus', effort: 'high' });
  worker = { model: 'default', effort: 'max' };
  runtime.start({ ...spec, role: 'worker', model: 'sonnet', effort: 'low' });
  expect(fake.last.spec.effort).toBe('max');
  expect('model' in fake.last.spec).toBe(false);
  runtime.start({ ...spec, role: 'chores' });
  expect(fake.last.spec).toMatchObject({ model: 'opus', effort: 'medium' });
  // an agent of no group starts as its job says
  runtime.start({ ...spec, effort: 'low' });
  expect(fake.last.spec.effort).toBe('low');
  expect(fake.last.spec.model).toBeUndefined();
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
