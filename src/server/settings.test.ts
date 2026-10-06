import { expect, test } from 'bun:test';
import { languageOf } from '../core/locale';
import { systemLanguage } from './settings';

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
