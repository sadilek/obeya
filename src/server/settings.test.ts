import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf } from '../core/locale';
import { withAgentChoice } from './runtime';
import { agentChoice, agentsView, saveAgents, saveLanguage, SETTINGS_FILE, systemLanguage } from './settings';
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

test("the owner's model and effort per group of agents: saved beside the language, one group at a time, null is Obeya's own again", () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-settings-'));
  expect(agentsView(home).chosen).toEqual({ koordinator: {}, worker: {}, explorer: {}, chores: {} });
  saveLanguage(home, { language: 'en' });
  saveAgents(home, { worker: { model: 'opus', effort: 'xhigh' } });
  saveAgents(home, { koordinator: { model: 'haiku', effort: null } });
  expect(agentChoice(home, 'worker')).toEqual({ model: 'opus', effort: 'xhigh' });
  expect(agentChoice(home, 'koordinator')).toEqual({ model: 'haiku' });
  expect(agentChoice(home, 'explorer')).toEqual({});
  saveAgents(home, { worker: { model: null, effort: 'high' } });
  expect(agentsView(home).chosen.worker).toEqual({ effort: 'high' });
  saveLanguage(home, { language: 'de' });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de', agents: { koordinator: { model: 'haiku' }, worker: { effort: 'high' } } });
  // nothing chosen any more: the file keeps no empty list
  saveAgents(home, { koordinator: { model: null, effort: null }, worker: {} });
  expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8'))).toEqual({ language: 'de' });
  for (const bad of [{ boss: {} }, { worker: { model: 'gpt' } }, { worker: { effort: 'huge' } }, { worker: { model: 'opus', fast: true } }]) expect(() => saveAgents(home, bad)).toThrow();
  // what the file holds beyond the known choices is left out
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ agents: { worker: { model: 'gpt', effort: 'low' }, boss: { model: 'opus' } } }));
  expect(agentsView(home).chosen).toEqual({ koordinator: {}, worker: { effort: 'low' }, explorer: {}, chores: {} });
});

test("an agent starts with the owner's choice for its group, asked at every start; what is left open stays as the job sets it", () => {
  const fake = new FakeRuntime();
  let worker: { model?: 'opus'; effort?: 'max' } = { model: 'opus' };
  const runtime = withAgentChoice(fake, (role) => (role === 'worker' ? worker : {}));
  const spec = { cwd: '/r', system: '', tools: [], onEvent: () => {} };
  runtime.start({ ...spec, role: 'worker', effort: 'medium' });
  expect(fake.last.spec).toMatchObject({ model: 'opus', effort: 'medium' });
  worker = { effort: 'max' };
  runtime.start({ ...spec, role: 'worker', model: 'sonnet' });
  expect(fake.last.spec).toMatchObject({ model: 'sonnet', effort: 'max' });
  runtime.start({ ...spec, role: 'chores', model: 'sonnet', effort: 'low' });
  expect(fake.last.spec).toMatchObject({ model: 'sonnet', effort: 'low' });
  runtime.start(spec);
  expect(fake.last.spec.model).toBeUndefined();
});
