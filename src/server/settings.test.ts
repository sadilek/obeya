import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf } from '../core/locale';
import { AGENT_DEFAULTS, type AgentSetting } from '../core/types';
import { withAgentSetting } from './runtime';
import { agentSetting, agentsView, pushKeyChoice, saveAgents, saveLanguage, savePushKey, SETTINGS_FILE, systemLanguage } from './settings';
import { FakeRuntime } from './testing';

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

test("the model and effort per group of agents: preset, chosen one group at a time beside the language, the file keeping only what differs", () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-settings-'));
  expect(agentsView(home).agents).toEqual({
    koordinator: { model: 'default', effort: 'medium' },
    worker: { model: 'default', effort: 'high' },
    explorer: { model: 'default', effort: 'high' },
    chores: { model: 'sonnet', effort: 'high' },
  });
  saveLanguage(home, { language: 'en' });
  saveAgents(home, { worker: { model: 'opus', effort: 'xhigh' } });
  saveAgents(home, { koordinator: { model: 'haiku' }, chores: { model: 'default' } });
  expect(agentSetting(home, 'worker')).toEqual({ model: 'opus', effort: 'xhigh' });
  expect(agentSetting(home, 'koordinator')).toEqual({ model: 'haiku', effort: 'medium' });
  expect(agentSetting(home, 'chores')).toEqual({ model: 'default', effort: 'high' });
  saveAgents(home, { worker: { model: 'default' } });
  saveLanguage(home, { language: 'de' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de', agents: { koordinator: { model: 'haiku' }, worker: { effort: 'xhigh' }, chores: { model: 'default' } } });
  // back to the presets: the file keeps no list
  saveAgents(home, { koordinator: { model: 'default' }, worker: { effort: 'high' }, chores: { model: 'sonnet' } });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de' });
  for (const bad of [{ boss: {} }, { worker: { model: 'gpt' } }, { worker: { effort: null } }, { worker: { effort: 'huge' } }, { worker: { model: 'opus', fast: true } }]) expect(() => saveAgents(home, bad)).toThrow();
  // what the file holds beyond the known choices is left out
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { worker: { model: 'gpt', effort: 'low' }, boss: { model: 'opus' } } }));
  expect(agentSetting(home, 'worker')).toEqual({ model: 'default', effort: 'low' });
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
  expect(fake.last.spec).toMatchObject({ model: 'sonnet', effort: 'high' });
  // an agent of no group starts as its job says
  runtime.start({ ...spec, effort: 'low' });
  expect(fake.last.spec.effort).toBe('low');
  expect(fake.last.spec.model).toBeUndefined();
});

test('the push-to-talk key in another app: the default until chosen, beside the other settings, which stay', () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-settings-'));
  expect(pushKeyChoice(home, 'darwin')).toEqual({ key: 'AltRight', chosen: null, default: 'AltRight' });
  saveLanguage(home, { language: 'en' });
  expect(savePushKey(home, { key: 'Shift+Control+Space' }, 'darwin')).toEqual({ key: 'Control+Shift+Space', chosen: 'Control+Shift+Space', default: 'AltRight' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en', pushKey: 'Control+Shift+Space' });
  for (const bad of [{ key: 'KeyA' }, { key: 'Space' }, {}, { key: 3 }]) expect(() => savePushKey(home, bad, 'darwin')).toThrow();
  // the default chosen is no choice: a changed default reaches it
  savePushKey(home, { key: 'AltRight' }, 'darwin');
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'en' });
  savePushKey(home, { key: 'F13' }, 'darwin');
  expect(savePushKey(home, { key: null }, 'darwin').chosen).toBeNull();
  // a key the file holds that cannot be one is left out
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ pushKey: 'KeyA' }));
  expect(pushKeyChoice(home, 'linux').key).toBe('ControlRight');
});
