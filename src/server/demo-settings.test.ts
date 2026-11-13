import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipProblems, demoSettingsProblems } from './demo-settings';
import { removeDir } from './testing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-demo-settings-'));
});
afterEach(() => removeDir(dir));

describe('the demo settings', () => {
  test('say what keeps a voice from speaking', () => {
    const missing = join(dir, 'nowhere');
    expect(demoSettingsProblems({ language: 'de', voice: 'piper' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'command' }, {})).toEqual(['noCommand']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http' }, {})).toEqual(['noUrl']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http', url: 'http://localhost:9' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'linux')).toEqual(['notHere']);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'darwin')).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, { GEMINI_API_KEY: 'k' })).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'azure', url: 'westeurope' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'openai', keyFile: missing }, {})).toEqual(['keyFileMissing']);
    writeFileSync(join(dir, 'key'), 'k');
    expect(demoSettingsProblems({ language: 'en', voice: 'elevenlabs', keyFile: join(dir, 'key') }, {})).toEqual([]);
  });

  test("say which of Qwen3's clips to clone does not work, by its language", () => {
    writeFileSync(join(dir, 'me.wav'), '');
    const s = { language: 'de', voice: 'qwen3', references: { de: join(dir, 'me.wav'), en: join(dir, 'me-en.wav') } } as const;
    expect(clipProblems(s)).toEqual({ de: 'noTranscript', en: 'referenceMissing' });
    writeFileSync(join(dir, 'me.txt'), 'Hallo.');
    expect(clipProblems(s)).toEqual({ en: 'referenceMissing' });
    // another voice clones nothing
    expect(clipProblems({ ...s, voice: 'piper' })).toEqual({});
  });
});
