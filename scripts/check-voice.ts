// Checks that the local demo voices Obeya installs on request work on this machine: each is
// installed as the settings' "Install" does, into a scratch home and a scratch Hugging Face cache
// (so everything is downloaded afresh), and then speaks the settings' sample sentence through
// `tts.py --sample`, as the settings' sample does. A clip counts when it is a 16-bit WAV of a few
// seconds that is not silence. Runs on macOS, Linux and Windows; needs uv and ffmpeg.
//
//   bun scripts/check-voice.ts [<voice>:<language> …] [--keep]
//
// Without arguments: Kokoro in English and Piper in German (umlauts on stdin). Prints one line per
// check; exits 1 when one failed. --keep leaves the scratch directory.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSettings } from '../plugin/skills/demo/lib/settings.ts';
import { installState, installVoice, sample } from '../plugin/skills/demo/lib/voices.ts';
import { check, expect, failed } from './check-harness';

const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));
const voices = (wanted.length ? wanted : ['kokoro:en', 'piper:de']).map((v) => {
  const [voice, language] = v.split(':');
  return { voice, language } as DemoSettings;
});

const dir = mkdtempSync(join(tmpdir(), 'obeya-check-voice-'));
const home = join(dir, 'home');
process.env.HF_HOME = join(dir, 'hf');
delete process.env.HF_HUB_CACHE;
// the voice of the scratch home, not one a running Obeya holds
delete process.env.OBEYA_URL;

/** Seconds of sound in a 16-bit PCM WAV, and its loudness (RMS, 0 to 1). */
function wavStats(file: string) {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE', 'not a WAV file');
  let at = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(at + 10);
      rate = b.readUInt32LE(at + 12);
      bits = b.readUInt16LE(at + 22);
    }
    if (id === 'data') {
      expect(bits === 16 && rate > 0, `${bits}-bit at ${rate} Hz`);
      const samples = Math.min(size, b.length - at - 8) / 2;
      let sum = 0;
      for (let i = 0; i < samples; i++) sum += (b.readInt16LE(at + 8 + i * 2) / 32768) ** 2;
      return { seconds: samples / channels / rate, rms: Math.sqrt(sum / samples), rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('a WAV without data');
}

for (const s of voices) {
  const name = `${s.voice} (${s.language})`;
  const installed = await check(`${name}: installs`, async () => {
    const before = installState(s, home);
    const lines: string[] = [];
    await installVoice(s, (line) => lines.push(line), home);
    const after = installState(s, home);
    expect(after.installed, `still missing ${after.missing.join(', ')}; last lines:\n${lines.slice(-10).join('\n')}`);
    return `${before.missing.join(', ')} (about ${before.mb} MB)`;
  });
  if (!installed) continue;
  await check(`${name}: speaks the sample sentence`, async () => {
    const out = join(dir, `${s.voice}-${s.language}.wav`);
    const started = performance.now();
    await sample(s, out, home);
    const took = (performance.now() - started) / 1000;
    const wav = wavStats(out);
    expect(wav.seconds > 3, `only ${wav.seconds.toFixed(1)} s of audio`);
    expect(wav.rms > 0.01, `silent (RMS ${wav.rms.toFixed(4)})`);
    return `${wav.seconds.toFixed(1)} s of speech at ${wav.rate} Hz in ${took.toFixed(1)} s, RMS ${wav.rms.toFixed(3)}`;
  });
}

if (args.includes('--keep')) console.log(`scratch: ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
