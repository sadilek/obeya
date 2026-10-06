// Voice in and out on this machine, for real: Piper speaks a command, Whisper hears it back. Runs
// with `OBEYA_LIVE_VOICE=<home>`: Piper is installed under that home if it is not yet, Whisper
// comes through uv (the first run fetches it). The backends are this platform's unless
// `OBEYA_WHISPER_BACKEND` names another (faster-whisper runs on a Mac too).

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installVoice } from '../../plugin/skills/demo/lib/voices.ts';
import { CONFIRMATION_VOICE, PiperSpeaker, WhisperSidecar } from './voice';

const home = process.env.OBEYA_LIVE_VOICE;

test.skipIf(!home)(
  'Piper speaks a command and Whisper hears it back',
  async () => {
    await installVoice(CONFIRMATION_VOICE, (line) => console.log(line), home);
    const speaker = new PiperSpeaker(home!);
    const whisper = new WhisperSidecar();
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-live-'));
    try {
      let started = performance.now();
      await whisper.prepare();
      console.log(`${whisper.backend} loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      started = performance.now();
      const wav = await speaker.speak('Starte die Karte Export für Vermieter.');
      console.log(`Piper spoke in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      expect(new TextDecoder().decode(wav!.slice(0, 4))).toBe('RIFF');
      const again = performance.now();
      expect(await speaker.speak('Ok.')).not.toBeNull();
      console.log(`a second sentence in ${((performance.now() - again) / 1000).toFixed(2)} s`);
      writeFileSync(join(dir, 'command.wav'), wav!);
      started = performance.now();
      const heard = await whisper.transcribe(join(dir, 'command.wav'), 'Export für Vermieter');
      console.log(`heard in ${((performance.now() - started) / 1000).toFixed(1)} s: ${heard.text}`);
      expect(heard.text.toLowerCase()).toMatch(/starte die karte,? export für vermieter/);
      expect(heard.doubtful).toBe(false);
      // a recording without a sound is not transcribed
      writeFileSync(join(dir, 'silence.wav'), silentWav(1));
      expect(await whisper.transcribe(join(dir, 'silence.wav'), '')).toEqual({ text: '', doubtful: false });
    } finally {
      speaker.stop();
      whisper.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20 * 60_000,
);

function silentWav(seconds: number) {
  const n = 16000 * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}
