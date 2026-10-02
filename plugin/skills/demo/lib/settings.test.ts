import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDemoSettings, narrationPerson, readDemoSettings, tidyDemoSettings, writeDemoSettings } from './settings.ts';

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), 'obeya-demo-settings-'))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('demo settings', () => {
  test('without a file, a demo is narrated in German by a stock voice', () => {
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'gemini' });
  });

  test('keep what is valid and fall back to the defaults for the rest', () => {
    expect(tidyDemoSettings({ language: 'fr', voice: 'clone', voiceProject: '  ', extra: 1 })).toEqual({ language: 'de', voice: 'clone' });
    writeFileSync(join(home, 'demo.json'), 'not json');
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'gemini' });
  });

  test('are written to and read from the home', () => {
    writeDemoSettings({ language: 'en', voice: 'clone', voiceProject: '~/voice' }, home);
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'clone', voiceProject: '~/voice' });
  });

  test("speak in the first person only in the owner's own voice", () => {
    expect(narrationPerson('clone')).toBe('first');
    expect(narrationPerson('gemini')).toBe('third');
    expect(narrationPerson('/tmp/someone.wav')).toBe('third');
    expect(describeDemoSettings({ language: 'en', voice: 'gemini' }, 'gemini')).toContain('in English');
    expect(describeDemoSettings({ language: 'de', voice: 'clone' }, 'clone')).toContain('person: first');
  });
});
