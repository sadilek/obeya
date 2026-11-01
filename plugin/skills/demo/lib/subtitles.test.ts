import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knownLanguage, languageName, preferredTrack } from './locale.ts';
import { READING, readingSeconds, readingTimes, sentencesOf, sharedOut, type SubtitleSource, subtitleProblems, subtitleTracks, trackVtt } from './subtitles.ts';

describe('sentences', () => {
  test('a narration is split into its sentences, without its audio tags and respellings', () => {
    expect(sentencesOf('The card shows a link. [short pause] One click opens it! Does it? Yes …')).toEqual(['The card shows a link.', 'One click opens it!', 'Does it?', 'Yes …']);
    expect(sentencesOf('Der {Canvas|Kännwes} zeigt sie. Fertig.')).toEqual(['Der Canvas zeigt sie.', 'Fertig.']);
    expect(sentencesOf('„Teilen“ öffnet die Seite. Dann „Kopieren“.')).toEqual(['„Teilen“ öffnet die Seite.', 'Dann „Kopieren“.']);
  });

  test('a period after an abbreviation, an initial or an ordinal ends no sentence, nor one before a lower-case word', () => {
    expect(sentencesOf('Zum Beispiel z. B. eine Karte. Am 1. November geht es los.')).toEqual(['Zum Beispiel z. B. eine Karte.', 'Am 1. November geht es los.']);
    expect(sentencesOf('Some tools, e.g. Piper, run here. Version 2.5 does too.')).toEqual(['Some tools, e.g. Piper, run here.', 'Version 2.5 does too.']);
    expect(sentencesOf('It says ... and then stops.')).toEqual(['It says ... and then stops.']);
    expect(sentencesOf('[short pause]')).toEqual([]);
  });
});

describe('timing', () => {
  test('a silent sentence stays as long as it takes to read, at least a while; a wide character counts twice', () => {
    expect(readingSeconds('Fertig.')).toBe(READING.minSeconds);
    const long = 'The card now shows the link to the page, and one click opens it in a new tab.';
    expect(readingSeconds(long)).toBeCloseTo(long.length / READING.charsPerSecond);
    expect(readingSeconds('这是一个很长的句子，它需要比较长的时间来阅读和理解。')).toBeCloseTo((26 + 24) / READING.charsPerSecond);
  });

  test('each sentence of a silent scene takes as long as the language slowest to read', () => {
    const en = ['Short.', 'A longer sentence that takes a good while to read through.'];
    const de = ['Kurz.', 'Ein längerer Satz, der eine ganze Weile zum Durchlesen braucht, mehr als englisch.'];
    expect(readingTimes([en, de])).toEqual([READING.minSeconds, readingSeconds(de[1]!)]);
  });

  test("a voiced scene's clip is shared out over its sentences by their length", () => {
    expect(sharedOut(6, ['One.', 'One two.'])).toEqual([2, 4]);
    expect(sharedOut(3, [])).toEqual([]);
  });

  test('every track gets the same cue times, one cue per sentence', () => {
    const scenes = [
      { speechStart: 0.35, sentences: [2, 3] },
      { speechStart: 6.35, sentences: [2.5] },
    ];
    expect(trackVtt({ language: 'fr', scenes: [['Un.', 'Deux.'], ['Trois.']] }, scenes)).toBe(
      'WEBVTT\n\n00:00:00.350 --> 00:00:02.350\nUn.\n\n00:00:02.350 --> 00:00:05.350\nDeux.\n\n00:00:06.350 --> 00:00:08.850\nTrois.\n',
    );
  });
});

describe('translations for the subtitles', () => {
  let work: string;
  beforeEach(() => (work = mkdtempSync(join(tmpdir(), 'obeya-subtitles-'))));
  afterEach(() => rmSync(work, { recursive: true, force: true }));
  const source: SubtitleSource = {
    language: 'en',
    scenes: [
      { title: 'Before', sentences: ['The list.', 'It was long.'] },
      { title: 'Now', sentences: ['Now it is short.'] },
    ],
  };
  const fr = { scenes: [{ sentences: ['La liste.', 'Elle était longue.'] }, { sentences: ['Maintenant elle est courte.'] }] };

  test('the narration alone needs no translation', () => {
    expect(subtitleTracks(work, source, ['en'])).toEqual({ tracks: [{ language: 'en', scenes: [['The list.', 'It was long.'], ['Now it is short.']] }] });
    expect(existsSync(join(work, 'subtitles'))).toBe(false);
  });

  test('a language without its translation stops the render with where it goes; once there, it is a track', () => {
    const asked = subtitleTracks(work, source, ['en', 'fr', 'pt-BR']);
    expect('brief' in asked && asked.brief).toContain(join(work, 'subtitles', 'fr.json'));
    expect('brief' in asked && asked.brief).toContain('Brazilian Portuguese (pt-BR)');
    expect(JSON.parse(readFileSync(join(work, 'subtitles', 'source.json'), 'utf8'))).toEqual(source);
    writeFileSync(join(work, 'subtitles', 'fr.json'), JSON.stringify(fr));
    writeFileSync(join(work, 'subtitles', 'pt-BR.json'), JSON.stringify({ scenes: [{ sentences: ['A lista.', 'Era longa.'] }, { sentences: ['Agora é curta.'] }] }));
    const done = subtitleTracks(work, source, ['en', 'fr', 'pt-BR']);
    expect('tracks' in done && done.tracks.map((t) => [t.language, t.scenes[0]![0]])).toEqual([
      ['en', 'The list.'],
      ['fr', 'La liste.'],
      ['pt-BR', 'A lista.'],
    ]);
  });

  test('a translation with another number of sentences is refused', () => {
    expect(subtitleProblems(source, fr)).toEqual([]);
    expect(subtitleProblems(source, { scenes: [{ sentences: ['La liste. Elle était longue.'] }, fr.scenes[1]] })).toEqual([
      'scene 1: 2 sentences expected, 1 given (one per sentence of the source, so every language shares its cue times)',
    ]);
    expect(subtitleProblems(source, { scenes: [fr.scenes[0]] })).toEqual(['scenes: 2 expected, 1 given']);
    subtitleTracks(work, source, ['en', 'fr']);
    writeFileSync(join(work, 'subtitles', 'fr.json'), JSON.stringify({ scenes: [{ sentences: ['La liste.', ''] }, fr.scenes[1]] }));
    expect(() => subtitleTracks(work, source, ['en', 'fr'])).toThrow('scene 1: a sentence is empty');
  });

  test('a translation of a narration that has changed since is set aside and asked for again', () => {
    subtitleTracks(work, source, ['en', 'fr']);
    writeFileSync(join(work, 'subtitles', 'fr.json'), JSON.stringify(fr));
    expect('tracks' in subtitleTracks(work, source, ['en', 'fr'])).toBe(true);
    const changed = { ...source, scenes: [source.scenes[0]!, { title: 'Now', sentences: ['Now it is shorter.'] }] };
    const asked = subtitleTracks(work, changed, ['en', 'fr']);
    expect('brief' in asked && asked.brief).toContain('fr.stale.json');
    expect(existsSync(join(work, 'subtitles', 'fr.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(work, 'subtitles', 'fr.stale.json'), 'utf8'))).toEqual(fr);
  });
});

describe('subtitle languages', () => {
  test('a code is known when Intl names its language, written canonically', () => {
    expect(knownLanguage('fr')).toBe('fr');
    expect(knownLanguage('pt-br')).toBe('pt-BR');
    expect(knownLanguage('xx')).toBeUndefined();
    expect(knownLanguage('en-XX')).toBeUndefined();
    expect(knownLanguage('de_DE')).toBeUndefined();
  });

  test('a track is named in the language of the page or interface', () => {
    expect(languageName('fr', 'de')).toBe('Französisch');
    expect(languageName('fr', 'en')).toBe('French');
    expect(languageName('de', 'de')).toBe('Deutsch');
  });

  test("a silent video shows the track in the viewer's language, by the language alone where no track has the variant, else the narration's", () => {
    expect(preferredTrack(['en', 'de', 'fr'], ['fr-CA', 'en'])).toBe('fr');
    expect(preferredTrack(['en', 'pt-BR'], ['pt-PT'])).toBe('pt-BR');
    expect(preferredTrack(['en', 'de'], ['ja'])).toBe('en');
  });
});
