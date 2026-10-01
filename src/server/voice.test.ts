import { expect, test } from 'bun:test';
import { looping, silence, SpeechSidecar } from './voice';

test.skipIf(process.platform !== 'darwin')('the speech sidecar renders confirmations as WAV, one after another', async () => {
  const speaker = new SpeechSidecar();
  try {
    const [a, b] = await Promise.all([speaker.speak('Ok.'), speaker.speak('Neue Karte „Export“, der Agent fängt an.')]);
    for (const wav of [a, b]) expect(new TextDecoder().decode(wav!.slice(0, 4))).toBe('RIFF');
    expect(b!.length).toBeGreaterThan(a!.length);
  } finally {
    speaker.stop();
  }
});

test('a loop is one word, phrase or syllable six times in a row, whatever the case and punctuation', () => {
  for (const loop of [
    'Fall '.repeat(40),
    'PLEASE PLEASE PLEASE PLEASE PLEASE PLEASE',
    `Pann ${'quarterback '.repeat(20)}`,
    `${'lächpt '.repeat(30)}lä`,
    `Ich finde, ${'ihr arbeitet dafür als ihr arbeitet, '.repeat(6)}`,
    'An aktuellen An aktuellen An aktuellen An aktuellen An aktuellen An aktuellen',
    `auf${'ging'.repeat(40)}`,
  ])
    expect(looping(loop)).toBe(true);
  for (const speech of [
    'Starte alle Karten, die noch in der Warteschlange sind.',
    'Nein, nein, nein, nicht diese Karte, die andere.',
    'Was ist der Stand? Was ist der Stand bei Export?',
    'Ja, ja, ja, ja, mach das.',
    'Die Zählerstände der Zähler 1111 und 2222 exportieren.',
    '',
  ])
    expect(looping(speech)).toBe(false);
});

test("Whisper's words for silence are told from a command", () => {
  for (const s of ['Vielen Dank.', ' vielen Dank ', 'Untertitelung des ZDF, 2020', 'Danke fürs Zuschauen!']) expect(silence(s)).toBe(true);
  for (const s of ['Vielen Dank, das war gut.', 'Danke, gib das frei.']) expect(silence(s)).toBe(false);
});
