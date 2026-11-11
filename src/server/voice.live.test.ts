// Voice in on this machine, for real: Piper (the demos' voice) speaks a command, the speech
// recognition hears it. Runs with `OBEYA_LIVE_VOICE=<home>`: Piper is installed under that home if
// it is not yet, the recognition comes through uv (the first run fetches it). The backend is
// Parakeet unless `OBEYA_WHISPER_BACKEND` names Whisper (`mlx`, `faster`, `whisper`).

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { installVoice, piperFiles } from '../../plugin/skills/demo/lib/voices.ts';
import type { Language } from '../core/locale';
import { LocalTranscriber } from './voice';
import { CHECK_CLIP } from './voice-setup';
import { resource } from './resources';
import { silentWav } from './testing';

const home = process.env.OBEYA_LIVE_VOICE;

test.skipIf(!home)(
  'Piper speaks a command and the speech recognition hears it back',
  async () => {
    for (const language of ['de', 'en'] as const) await installVoice(piper(language), (line) => console.log(line), home);
    const ear = new LocalTranscriber();
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-live-'));
    try {
      let started = performance.now();
      await ear.prepare();
      console.log(`${ear.backend} loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      await speak('Starte die Karte Export für Vermieter.', 'de', join(dir, 'command.wav'));
      started = performance.now();
      const heard = await ear.transcribe(join(dir, 'command.wav'), 'Export für Vermieter');
      console.log(`heard in ${((performance.now() - started) / 1000).toFixed(1)} s: ${heard.text}`);
      // Parakeet, without the card titles, writes Piper's „Starte die Karte Export“ as „Startet die Karteexport“
      expect(heard.text.toLowerCase()).toMatch(/startet? die karte,? ?export für vermieter/);
      expect(heard.doubtful).toBe(false);
      // in English, Piper's English voice, which Whisper hears as English
      await speak('Start the task Export for landlords.', 'en', join(dir, 'english.wav'));
      const english = await ear.transcribe(join(dir, 'english.wav'), 'Export for landlords');
      console.log(`heard in English: ${english.text}`);
      expect(english.text.toLowerCase()).toMatch(/start the task,? export for landlords/);
      // a recording without a sound is not transcribed
      writeFileSync(join(dir, 'silence.wav'), silentWav(1));
      expect((await ear.transcribe(join(dir, 'silence.wav'), '')).text).toBe('');
      // the setup assistant's sentence, timed as it times it
      started = performance.now();
      const check = await ear.transcribe(resource('voice', CHECK_CLIP.file), '');
      const seconds = (performance.now() - started) / 1000;
      console.log(`the check's ${CHECK_CLIP.seconds} s sentence heard in ${seconds.toFixed(2)} s: ${check.text}`);
      expect(check.text.toLowerCase()).toContain('vermieter');
    } finally {
      ear.stop();
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
