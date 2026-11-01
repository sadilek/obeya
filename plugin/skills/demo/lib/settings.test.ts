import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoDirectory, describeDemoSettings, inLanguage, narrationPerson, readDemoSettings, referenceOf, repositoryLanguage, subtitleLanguages, tidyDemoSettings, withVoice, writeDemoSettings } from './settings.ts';

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), 'obeya-demo-settings-'))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('demo settings', () => {
  test("without a file, a demo is narrated by Piper in the owner's conversation language, else the interface's", () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'de' }));
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'piper' });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'de', conversationLanguage: 'en' }));
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'piper' });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'en' }));
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'piper' });
    // a file without a language takes it from there too
    writeFileSync(join(home, 'demo.json'), JSON.stringify({ voice: 'say' }));
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'say' });
  });

  test('keep what is valid and fall back to the defaults for the rest', () => {
    expect(tidyDemoSettings({ language: 'fr', voice: 'command', command: '  ', url: ' x ', extra: 1 })).toEqual({ language: 'de', voice: 'command', url: 'x' });
    expect(tidyDemoSettings({ voice: 'nope', ownVoice: 'yes' })).toEqual({ language: 'de', voice: 'piper' });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'de' }));
    writeFileSync(join(home, 'demo.json'), 'not json');
    expect(readDemoSettings(home)).toEqual({ language: 'de', voice: 'piper' });
  });

  test('keep frames a whole number of days, or always', () => {
    const keep = (keepFrames: unknown) => tidyDemoSettings({ language: 'en', voice: 'piper', keepFrames }).keepFrames;
    expect(keep(14)).toBe(14);
    expect(keep('always')).toBe('always');
    for (const v of [0, -3, 1.5, '14', 'never', null]) expect(keep(v)).toBeUndefined();
  });

  test('are written to and read from the home', () => {
    writeDemoSettings({ language: 'en', voice: 'command', command: 'speak', ownVoice: true }, home);
    expect(readDemoSettings(home)).toEqual({ language: 'en', voice: 'command', command: 'speak', ownVoice: true });
  });

  test('name the directory demos go into: absolute or from ~, else ~/demos', () => {
    const demos = join(home, 'work', 'demos');
    writeDemoSettings({ language: 'en', voice: 'piper', directory: ` ${demos} ` }, home);
    expect(readDemoSettings(home).directory).toBe(demos);
    expect(demoDirectory(readDemoSettings(home))).toBe(demos);
    expect(demoDirectory({})).toBe(join(homedir(), 'demos'));
    expect(demoDirectory({ directory: '~/work/demos' })).toBe(join(homedir(), 'work', 'demos'));
    // a relative path would land wherever the agent works
    expect(demoDirectory({ directory: 'demos' })).toBe(join(homedir(), 'demos'));
    expect(describeDemoSettings({ language: 'en', voice: 'piper', directory: demos }, undefined)).toContain(`directory: ${demos}`);
  });

  test('hold a clip to clone per language; a file with one clip has it for its language', () => {
    expect(tidyDemoSettings({ language: 'en', voice: 'qwen3', references: { de: ' /de.wav ', en: '', fr: '/fr.wav' } })).toEqual({ language: 'en', voice: 'qwen3', references: { de: '/de.wav' } });
    writeFileSync(join(home, 'demo.json'), JSON.stringify({ language: 'de', voice: 'qwen3', reference: '/de.wav' }));
    const s = readDemoSettings(home);
    expect(s).toEqual({ language: 'de', voice: 'qwen3', references: { de: '/de.wav' } });
    expect(referenceOf(s)).toBe('/de.wav');
    expect(referenceOf(inLanguage(s, 'en'))).toBeUndefined();
  });

  test("take a repository's language for its demos from Obeya, else from the repository's settings", () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(repositoryLanguage({}, join(repo, 'src', 'deep'))).toBeUndefined();
    mkdirSync(join(repo, '.obeya'));
    writeFileSync(join(repo, '.obeya', 'settings.json'), JSON.stringify({ demo: { language: 'en' } }));
    expect(repositoryLanguage({}, join(repo, 'src', 'deep'))).toEqual({ language: 'en', from: 'repository', file: join(repo, '.obeya', 'settings.json') });
    expect(repositoryLanguage({ DEMO_LANGUAGE: 'de' }, join(repo, 'src'))).toEqual({ language: 'de', from: 'obeya' });
    // a language Obeya does not speak is none
    writeFileSync(join(repo, '.obeya', 'settings.json'), JSON.stringify({ demo: { language: 'fr' } }));
    expect(repositoryLanguage({ DEMO_LANGUAGE: 'fr' }, repo)).toBeUndefined();
    const saved = { language: 'de', voice: 'qwen3', ownVoice: true, references: { de: '/de.wav', en: '/en.wav' } } as const;
    const text = describeDemoSettings(saved, undefined, { language: 'en', from: 'obeya' });
    expect(text).toContain('in English');
    expect(text).toContain('clone of /en.wav');
  });

  test('take the voice of one render from DEMO_VOICE: a provider, or a clip to clone', () => {
    const saved = { language: 'en', voice: 'command', command: 'speak', ownVoice: true } as const;
    expect(withVoice(saved, undefined)).toBe(saved);
    expect(withVoice(saved, 'gemini')).toEqual({ language: 'en', voice: 'gemini', command: 'speak' });
    expect(withVoice(saved, '/tmp/someone.wav')).toEqual({ language: 'en', voice: 'qwen3', references: { en: '/tmp/someone.wav' } });
    expect(() => withVoice(saved, 'robot')).toThrow('unknown voice');
  });

  test('name the languages of the subtitles: the known codes given, in their order, the narration only where listed', () => {
    const s = tidyDemoSettings({ language: 'de', voice: 'none', subtitles: ['en', 'pt-br', 'xx', 'en', 'de', 7] });
    expect(s).toEqual({ language: 'de', voice: 'none', subtitles: ['en', 'pt-BR', 'de'] });
    expect(subtitleLanguages(s)).toEqual(['en', 'pt-BR', 'de']);
    expect(describeDemoSettings(s, undefined)).toContain('subtitles: en, pt-BR, de — the render asks for a translation of the narration into en, pt-BR');
    expect(subtitleLanguages({ language: 'en', voice: 'piper', subtitles: ['de', 'fr'] })).toEqual(['de', 'fr']);
    expect(tidyDemoSettings({ language: 'en', voice: 'piper', subtitles: [] })).toEqual({ language: 'en', voice: 'piper' });
    expect(withVoice({ language: 'en', voice: 'piper' }, 'none')).toEqual({ language: 'en', voice: 'none' });
  });

  test("list no subtitles: a voiced demo gets none, a silent one the narration's", () => {
    expect(subtitleLanguages({ language: 'en', voice: 'piper' })).toEqual([]);
    expect(describeDemoSettings({ language: 'en', voice: 'piper' }, undefined)).toContain('subtitles: none');
    expect(subtitleLanguages({ language: 'en', voice: 'none' })).toEqual(['en']);
    expect(describeDemoSettings({ language: 'en', voice: 'piper' }, 'none')).toContain("subtitles: en — none are listed, so a silent demo shows the narration's");
  });

  test("speak in the first person only in the owner's own voice", () => {
    // without a voice nobody speaks: the subtitles present the work
    expect(narrationPerson({ voice: 'none', ownVoice: true })).toBe('third');
    expect(describeDemoSettings({ language: 'en', voice: 'none' }, undefined)).toContain('voice: none');
    expect(narrationPerson({ ownVoice: true })).toBe('first');
    expect(narrationPerson({})).toBe('third');
    expect(describeDemoSettings({ language: 'en', voice: 'piper' }, undefined)).toContain('in English');
    expect(describeDemoSettings({ language: 'de', voice: 'command', ownVoice: true }, undefined)).toContain('person: first');
    // another voice for one render is nobody's own, unless the settings say so
    expect(describeDemoSettings({ language: 'de', voice: 'command', ownVoice: true }, '/tmp/x.wav')).toContain('person: third');
    // a clone without a clip for the language speaks with a stock speaker
    expect(narrationPerson({ language: 'en', voice: 'qwen3', ownVoice: true, references: { de: '/de.wav' } })).toBe('third');
    expect(narrationPerson({ language: 'de', voice: 'qwen3', ownVoice: true, references: { de: '/de.wav' } })).toBe('first');
  });
});
