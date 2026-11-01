import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cuesByScene, cuesOf, frameListText, framesOf, keptTracks, reportOf, retimed, stretched, translationProblems, type Words } from './revoice.ts';

const source: Words = {
  title: 'Vorschläge lassen sich übernehmen',
  scenes: [
    { title: 'Vorher', say: 'Ein Vorschlag. [short pause] Bisher scheiterte das.' },
    { title: 'Jetzt', say: 'Jetzt geht es.' },
  ],
  report: { summary: 'Geht wieder.\n\nNicht geprüft: das Telefon.', meta: { Zweig: 'x' } },
};

describe('re-voicing a demo', () => {
  test('reads the cues of captions and chapters', () => {
    const vtt = 'WEBVTT\n\n00:00:00.352 --> 00:00:10.292\nEin Vorschlag.\n\n00:01:11.247 --> 00:01:22.467\nJetzt „geht“ es.\n';
    expect(cuesOf(vtt)).toEqual([
      { start: 0.352, end: 10.292, text: 'Ein Vorschlag.' },
      { start: 71.247, end: 82.467, text: 'Jetzt „geht“ es.' },
    ]);
  });

  test('a cue of several lines is read whole', () => {
    expect(cuesOf('WEBVTT\n\n00:00:00.002 --> 00:00:09.000\nVorher:\nkein Vorschlag\n\n00:00:09.000 --> 00:00:12.000\nJetzt\n')).toEqual([
      { start: 0.002, end: 9, text: 'Vorher:\nkein Vorschlag' },
      { start: 9, end: 12, text: 'Jetzt' },
    ]);
  });

  test('a narrated stretch plays as long as its new clip; the rest keeps its length and moves along', () => {
    const at = stretched([
      { from: 10, to: 20, ratio: 1.5 },
      { from: 30, to: 34, ratio: 0.5 },
    ]);
    expect(at(5)).toBe(5);
    expect(at(10)).toBe(10);
    // halfway through the words is halfway through the longer clip
    expect(at(15)).toBe(17.5);
    expect(at(20)).toBe(25);
    expect(at(30)).toBe(35);
    expect(at(34)).toBe(37);
    expect(at(40)).toBe(43);
  });

  test('a frame across the edge of a stretch takes a share of both', () => {
    const frames = framesOf("ffconcat version 1.0\nfile 'frames/1.jpg'\nduration 8.0000\nfile 'frames/2.jpg'\nduration 4.0000\nfile 'frames/3.jpg'\nduration 1.0000\nfile 'frames/3.jpg'\n");
    expect(frames).toEqual([
      { file: 'frames/1.jpg', seconds: 8 },
      { file: 'frames/2.jpg', seconds: 4 },
      { file: 'frames/3.jpg', seconds: 1 },
      { file: 'frames/3.jpg' },
    ]);
    const held = retimed(frames, stretched([{ from: 10, to: 12, ratio: 2 }]));
    expect(held.map((f) => f.seconds)).toEqual([8, 6, 1, undefined]);
  });

  test('the new frame list names the recorded frames from where it is written', () => {
    const text = frameListText([{ file: 'frames/1.jpg', seconds: 0.5 }, { file: 'frames/1.jpg' }], '/d/.work', '/d/.work/revoice');
    expect(text).toBe("ffconcat version 1.0\nfile '../frames/1.jpg'\nduration 0.5000\nfile '../frames/1.jpg'\n");
  });

  test('reads the report page back, a meta given as one line in one piece', () => {
    const html = `<!doctype html>
<html lang="de">
<main>
<h1>Vorschläge &amp; Ideen</h1>
<p class="summary">Geht &quot;wieder&quot;.</p>
<p class="summary">Nicht geprüft: das Telefon &lt;neu&gt;.</p>
<div class="decision"><h2>Offene Frage</h2>Was nun?</div>
<dl><dt>0</dt><dd>B</dd><dt>1</dt><dd>r</dd><dt>2</dt><dd> </dd><dt>3</dt><dd>x</dd></dl>
</main>`;
    expect(reportOf(html)).toEqual({
      language: 'de',
      title: 'Vorschläge & Ideen',
      report: { summary: 'Geht "wieder".\n\nNicht geprüft: das Telefon <neu>.', question: 'Was nun?', meta: { '': 'Br x' } },
    });
  });

  test('a page of an earlier director is read without its lists of what was shown, not shown and noticed', () => {
    const html = `<!doctype html>
<html lang="de">
<main>
<h1>Vorschläge</h1>
<p class="summary">Geht wieder.</p>
<div class="grid">
  <section class="card"><h2>Gezeigt</h2><ul><li>Vorher</li><li>Jetzt</li></ul></section>
  <section class="card"><h2>Nicht gezeigt</h2><p class="none">—</p></section>
  <section class="card"><h2>Auffälligkeiten</h2><ul><li>Eine</li></ul></section>
</div>
<dl><dt>Zweig</dt><dd>x</dd></dl>
</main>`;
    expect(reportOf(html)).toEqual({ language: 'de', title: 'Vorschläge', report: { summary: 'Geht wieder.', meta: { Zweig: 'x' } } });
  });

  test('a page without a summary is no report page', () => {
    expect(() => reportOf('<html lang="de"><h1>Logo</h1><p>Drei Entwürfe</p></html>')).toThrow('no report page');
  });

  test('a translation keeps the scenes, the audio tags and the summary’s paragraphs', () => {
    const good: Words = {
      title: 'Proposals can be accepted',
      scenes: [
        { title: 'Before', say: 'A proposal. [short pause] Until now, that failed.' },
        { title: 'Now', say: 'Now it works.' },
      ],
      report: { summary: 'Works again.\n\nNot checked: the phone.', meta: { Branch: 'x' } },
    };
    expect(translationProblems(source, good)).toEqual([]);
    expect(translationProblems(source, { ...good, scenes: [good.scenes[0]!] })).toEqual(['scenes: 2 expected, 1 given']);
    const untagged = { ...good, scenes: [{ title: 'Before', say: 'A proposal. Until now, that failed.' }, good.scenes[1]!] };
    expect(translationProblems(source, untagged)).toEqual(['scene 1: the audio tags differ from the source\'s ([short pause])']);
    expect(translationProblems(source, { ...good, report: { ...good.report, summary: 'Works again. Not checked: the phone.' } })).toEqual([
      'report.summary: 2 paragraphs expected, separated by a blank line',
    ]);
    // a sentence a caption: as many as the source has
    const merged = { ...good, scenes: [{ title: 'Before', say: 'A proposal [short pause] that failed until now.' }, good.scenes[1]!] };
    expect(translationProblems(source, merged)).toEqual([
      'scene 1: 2 sentences expected, 1 given (one per sentence of the source: each is a caption, shown at the same time as in the other languages)',
    ]);
  });

  test("the captions are grouped by scene: a cue per sentence, or one per scene in a demo from before", () => {
    const says = source.scenes.map((s) => s.say);
    expect(cuesByScene(['a', 'b', 'c'], says)).toEqual([['a', 'b'], ['c']]);
    expect(cuesByScene(['ab', 'c'], says)).toEqual([['ab'], ['c']]);
    expect(() => cuesByScene(['a'], says)).toThrow('does not add up');
  });

  test('the demo keeps the tracks its captions named, the new narration in the one of its language', () => {
    const original = mkdtempSync(join(tmpdir(), 'obeya-revoice-'));
    try {
      const says = source.scenes.map((s) => s.say);
      const cues = (texts: string[]) => `WEBVTT\n\n${texts.map((t, i) => `00:00:0${i}.000 --> 00:00:0${i + 1}.000\n${t}\n`).join('\n')}`;
      writeFileSync(join(original, 'captions.vtt'), cues(['Ein Vorschlag.', 'Bisher scheiterte das.', 'Jetzt geht es.']).replace('WEBVTT', 'WEBVTT - subtitles: fr en de'));
      writeFileSync(join(original, 'captions.fr.vtt'), cues(['Une proposition.', 'Cela échouait.', 'Maintenant ça marche.']));
      const narration = { language: 'en', scenes: [['A proposal.', 'It failed until now.'], ['Now it works.']] };
      expect(keptTracks(original, 'de', says, narration)).toEqual([
        { language: 'fr', scenes: [['Une proposition.', 'Cela échouait.'], ['Maintenant ça marche.']] },
        narration,
        { language: 'de', scenes: [['Ein Vorschlag.', 'Bisher scheiterte das.'], ['Jetzt geht es.']] },
      ]);
      // one from before its captions named tracks had the narration's alone
      writeFileSync(join(original, 'captions.vtt'), cues(['Ein Vorschlag.', 'Bisher scheiterte das.', 'Jetzt geht es.']));
      expect(keptTracks(original, 'de', says, narration)).toEqual([narration]);
      writeFileSync(join(original, 'captions.vtt'), 'WEBVTT - subtitles: none\n');
      expect(keptTracks(original, 'de', says, narration)).toEqual([]);
    } finally {
      rmSync(original, { recursive: true, force: true });
    }
  });
});
