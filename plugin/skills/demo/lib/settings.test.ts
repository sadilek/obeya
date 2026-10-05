import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDemoSettings, narrationPerson, readDemoSettings, tidyDemoSettings, withVoice, writeDemoSettings } from './settings.ts';

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), 'obeya-demo-settings-'))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('demo settings', () => {
  test('without a file, a demo is narrated in German by Piper', () => {
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'piper' });
  });

  test('keep what is valid and fall back to the defaults for the rest', () => {
    expect(tidyDemoSettings({ language: 'fr', voice: 'command', command: '  ', url: ' x ', extra: 1 })).toEqual({ language: 'de', voice: 'command', url: 'x' });
    expect(tidyDemoSettings({ voice: 'nope', ownVoice: 'yes' })).toEqual({ language: 'de', voice: 'piper' });
    writeFileSync(join(home, 'demo.json'), 'not json');
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'piper' });
  });

  test('keep listening back on unless it is turned off', () => {
    expect(tidyDemoSettings({ language: 'de', voice: 'piper', listenBack: true })).toEqual({ language: 'de', voice: 'piper' });
    expect(tidyDemoSettings({ language: 'de', voice: 'piper', listenBack: false })).toEqual({ language: 'de', voice: 'piper', listenBack: false });
    expect(withVoice({ language: 'de', voice: 'piper', listenBack: false }, 'gemini')).toMatchObject({ listenBack: false });
    expect(withVoice({ language: 'de', voice: 'piper', listenBack: false }, '/tmp/x.wav')).toMatchObject({ listenBack: false });
    expect(describeDemoSettings({ language: 'de', voice: 'piper' }, undefined)).toContain('listening back: on');
    expect(describeDemoSettings({ language: 'de', voice: 'piper', listenBack: false }, undefined)).toContain('listening back: off');
  });

  test('carry over what they said before the providers', () => {
    expect(tidyDemoSettings({ language: 'de', voice: 'gemini', geminiKeyFile: '~/k' })).toEqual({ language: 'de', voice: 'gemini', keyFile: '~/k' });
    // the clone becomes the owner's own command, which they still write
    expect(tidyDemoSettings({ language: 'de', voice: 'clone', voiceProject: '~/voice' })).toEqual({ language: 'de', voice: 'command', ownVoice: true });
  });

  test('are written to and read from the home', () => {
    writeDemoSettings({ language: 'en', voice: 'command', command: 'speak', ownVoice: true }, home);
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'command', command: 'speak', ownVoice: true });
  });

  test('take the voice of one render from DEMO_VOICE: a provider, or a clip to clone', () => {
    const saved = { language: 'en', voice: 'command', command: 'speak', ownVoice: true } as const;
    expect(withVoice(saved, undefined)).toBe(saved);
    expect(withVoice(saved, 'gemini')).toEqual({ language: 'en', voice: 'gemini', command: 'speak' });
    expect(withVoice(saved, '/tmp/someone.wav')).toEqual({ language: 'en', voice: 'qwen3', reference: '/tmp/someone.wav' });
    expect(() => withVoice(saved, 'clone')).toThrow('unknown voice');
  });

  test("speak in the first person only in the owner's own voice", () => {
    expect(narrationPerson({ ownVoice: true })).toBe('first');
    expect(narrationPerson({})).toBe('third');
    expect(describeDemoSettings({ language: 'en', voice: 'piper' }, undefined)).toContain('in English');
    expect(describeDemoSettings({ language: 'de', voice: 'command', ownVoice: true }, undefined)).toContain('person: first');
    // another voice for one render is nobody's own, unless the settings say so
    expect(describeDemoSettings({ language: 'de', voice: 'command', ownVoice: true }, '/tmp/x.wav')).toContain('person: third');
  });
});
