// Voice in on this machine, for real: Piper (the demos' voice) speaks a command, Whisper hears it.
// Runs with `OBEYA_LIVE_VOICE=<home>`: Piper is installed under that home if it is not yet, Whisper
// comes through uv (the first run fetches it). The backend is this platform's unless
// `OBEYA_WHISPER_BACKEND` names another (faster-whisper runs on a Mac too).

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { installVoice, piperFiles } from '../../plugin/skills/demo/lib/voices.ts';
import type { Language } from '../core/locale';
import { WhisperSidecar } from './voice';

const home = process.env.OBEYA_LIVE_VOICE;

test.skipIf(!home)(
  'Piper speaks a command and Whisper hears it back',
  async () => {
    for (const language of ['de', 'en'] as const) await installVoice(piper(language), (line) => console.log(line), home);
    const whisper = new WhisperSidecar();
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-live-'));
    try {
      let started = performance.now();
      await whisper.prepare();
      console.log(`${whisper.backend} loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      await speak('Starte die Karte Export für Vermieter.', 'de', join(dir, 'command.wav'));
      started = performance.now();
      const heard = await whisper.transcribe(join(dir, 'command.wav'), 'Export für Vermieter');
      console.log(`heard in ${((performance.now() - started) / 1000).toFixed(1)} s: ${heard.text}`);
      expect(heard.text.toLowerCase()).toMatch(/starte die karte,? export für vermieter/);
      expect(heard.doubtful).toBe(false);
      // in English, Piper's English voice, which Whisper hears as English
      await speak('Start the task Export for landlords.', 'en', join(dir, 'english.wav'));
      const english = await whisper.transcribe(join(dir, 'english.wav'), 'Export for landlords');
      console.log(`heard in English: ${english.text}`);
      expect(english.text.toLowerCase()).toMatch(/start the task,? export for landlords/);
      // a recording without a sound is not transcribed
      writeFileSync(join(dir, 'silence.wav'), silentWav(1));
      expect(await whisper.transcribe(join(dir, 'silence.wav'), '')).toEqual({ text: '', doubtful: false });
    } finally {
      whisper.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20 * 60_000,
);

const piper = (language: Language): DemoSettings => ({ language, voice: 'piper' });

/** `text` in Piper's voice of `language`, as a WAV file. */
async function speak(text: string, language: Language, out: string) {
  const { python, onnx } = piperFiles(piper(language), home);
  const proc = Bun.spawn([python, '-c', 'import sys, wave; from piper import PiperVoice; PiperVoice.load(sys.argv[1]).synthesize_wav(sys.argv[2], wave.open(sys.argv[3], "wb"))', onnx, text, out]);
  expect(await proc.exited).toBe(0);
}

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
