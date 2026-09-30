import { expect, test } from 'bun:test';
import { SpeechSidecar } from './voice';

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
