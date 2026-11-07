import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListenBackend } from '../core/types';
import { resource } from './resources';
import { listenBackend, LocalTranscriber, looping, silence, VoiceIn } from './voice';
import { CloudError, cloudInUse, readVoiceFile, VOICE_FILE } from './voice-cloud';
import { CHECK_CLIP, VoiceSetup } from './voice-setup';
import { fakeProgram, removeDir } from './testing';

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
  for (const s of ['Vielen Dank.', ' vielen Dank ', 'Untertitelung des ZDF, 2020', 'Danke fürs Zuschauen!', 'Musik', '[Musik]', '*Musik*']) expect(silence(s)).toBe(true);
  for (const s of ['Vielen Dank, das war gut.', 'Danke, gib das frei.', 'Musik im Demo-Video leiser.']) expect(silence(s)).toBe(false);
});

test('every machine hears with Parakeet, unless Whisper is asked for', () => {
  expect(listenBackend({}, 'darwin', 'arm64')).toBe('parakeet');
  expect(listenBackend({}, 'win32', 'x64')).toBe('parakeet');
  expect(listenBackend({ OBEYA_WHISPER_BACKEND: 'faster' }, 'darwin', 'arm64')).toBe('faster');
  expect(listenBackend({ OBEYA_WHISPER_BACKEND: 'mlx' }, 'darwin', 'arm64')).toBe('mlx');
  expect(listenBackend({ OBEYA_WHISPER_BACKEND: 'whisper' }, 'darwin', 'arm64')).toBe('mlx');
  expect(listenBackend({ OBEYA_WHISPER_BACKEND: 'whisper' }, 'linux', 'x64')).toBe('faster');
  expect(listenBackend({ OBEYA_WHISPER_BACKEND: 'nope' }, 'linux', 'x64')).toBe('parakeet');
});

/** A recognition on this machine that hears `text` after `ms`. */
const hearing = (text: string, ms = 0, loaded = () => {}) => ({
  backend: 'parakeet' as ListenBackend,
  prepare: async () => loaded(),
  transcribe: async () => (await Bun.sleep(ms), { text, doubtful: false }),
});

test('the voice check names what is missing, how to install it here, and what "Installieren" fetches', async () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-voice-setup-'));
  try {
    const setup = new VoiceSetup({ home, local: hearing(''), env: { PATH: join(home, 'none') } });
    const view = await setup.view();
    const by = Object.fromEntries(view.items.map((i) => [i.id, i]));
    // uv first: it brings the recognition
    expect(view.items.map((i) => i.id)).toEqual(['uv', 'recognition', 'ffmpeg']);
    expect(by.ffmpeg).toMatchObject({ state: 'missing' });
    expect(by.ffmpeg!.install?.commands.length || by.ffmpeg!.install?.url).toBeTruthy();
    expect(by.uv).toMatchObject({ state: 'missing' });
    expect(by.uv!.install?.url).toContain('astral');
    // without uv the package is not in its cache: fetched by "Installieren" or the first command, once uv is there
    expect(by.recognition).toMatchObject({ state: 'later', found: 'Parakeet', waits: 'uv' });
    await expect(setup.install()).rejects.toThrow('uv');
    expect(view.fetch.mb).toBe(by.recognition!.mb!);

    // a Python of one's own without the package is missing
    const own = new VoiceSetup({ home, local: { ...hearing(''), backend: 'mlx' }, env: { PATH: join(home, 'none'), OBEYA_WHISPER_PYTHON: join(home, 'python') } });
    const mac = Object.fromEntries((await own.view()).items.map((i) => [i.id, i]));
    expect(mac.recognition).toMatchObject({ state: 'missing', need: 'mlx-whisper' });
    expect(mac.uv).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('"Installieren" loads the recognition and times it on a short sentence, and says why when it fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-voice-setup-'));
  try {
    let loaded = 0;
    // uv is there; the package is not in its cache
    fakeProgram(home, 'uv', 'case "$1" in --version) echo "uv 0.9.2";; *) exit 1;; esac');
    // it loads once the test has seen it running: a look at the machine (uv) may take longer than the loading
    const { promise: seen, resolve: go } = Promise.withResolvers<void>();
    const setup = new VoiceSetup({ home, local: { ...hearing('Starte die Karte', 30), prepare: () => seen.then(() => void loaded++) }, env: { PATH: home } });
    await setup.install();
    expect((await setup.view()).job).toMatchObject({ running: true });
    go();
    await setup.finished();
    expect(loaded).toBe(1);
    const view = await setup.view();
    expect(view.job).toEqual({ running: false, step: 'measure' });
    const speed = view.items.find((i) => i.id === 'recognition')!.speed;
    expect(speed).toMatchObject({ backend: 'parakeet', slow: false });
    expect(typeof speed === 'object' && speed.seconds).toBeGreaterThan(0.02);
    // kept for the next start, for this backend only
    expect(readVoiceFile(home).speed?.backend).toBe('parakeet');
    const whisper = new VoiceSetup({ home, local: { ...hearing(''), backend: 'faster' }, env: { PATH: home } });
    expect((await whisper.view()).items.find((i) => i.id === 'recognition')!.speed).toBeUndefined();

    const failing = new VoiceSetup({ home, local: { ...hearing(''), prepare: () => Promise.reject(new Error('transcription sidecar exited (1)')) }, env: { PATH: home } });
    await failing.install();
    await failing.finished().catch(() => {});
    expect((await failing.view()).job).toMatchObject({ running: false, error: 'transcription sidecar exited (1)' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a recognition slower than the sentence lasts counts as too slow', async () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-voice-setup-'));
  try {
    const setup = new VoiceSetup({ home, local: hearing('Starte', 60), clip: join(home, 'clip.ogg'), env: { PATH: home } });
    // a sentence of 4.1 s heard in 60 ms is fast; as if it lasted 0.05 s, the same is slow
    CHECK_CLIP.seconds = 0.05;
    try {
      await setup.measure();
      await setup.finished();
    } finally {
      CHECK_CLIP.seconds = 4.1;
    }
    expect((await setup.view()).items.find((i) => i.id === 'recognition')!.speed).toMatchObject({ slow: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a cloud service is tested with the sentence, then hears every recording; a refusal says why', async () => {
  const home = mkdtempSync(join(tmpdir(), 'obeya-voice-cloud-'));
  try {
    writeFileSync(join(home, 'clip.ogg'), 'OggS');
    const sent: { url: string; auth: string | null; form: FormData }[] = [];
    let refuse = false;
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, auth: new Headers(init.headers).get('authorization'), form: init.body as FormData });
      return refuse ? Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 }) : Response.json({ text: ' Starte die Karte Export für Vermieter. ' });
    }) as unknown as typeof fetch;
    const local = new LocalTranscriber('parakeet');
    const setup = new VoiceSetup({ home, local: hearing('lokal'), clip: join(home, 'clip.ogg'), env: { PATH: home }, fetcher });
    await expect(setup.useCloud({ preset: 'groq' })).rejects.toThrow('an API key');
    refuse = true;
    await expect(setup.useCloud({ preset: 'groq', key: 'gsk_wrong' })).rejects.toThrow('401: Invalid API Key');
    expect(cloudInUse(home)).toBeNull();
    refuse = false;
    const view = await setup.useCloud({ preset: 'groq', key: 'gsk_right' });
    expect(sent.at(-1)!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(sent.at(-1)!.auth).toBe('Bearer gsk_right');
    expect(sent.at(-1)!.form.get('model')).toBe('whisper-large-v3-turbo');
    expect((sent.at(-1)!.form.get('file') as File).name).toBe('clip.ogg');
    // nothing on this machine is needed any more; the page never sees the key
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ id: 'recognition', state: 'ok', found: 'Groq', cloud: { preset: 'groq', key: true, used: true, tested: { seconds: expect.any(Number) } } });
    expect(JSON.stringify(view)).not.toContain('gsk_right');
    if (process.platform !== 'win32') expect(statSync(join(home, VOICE_FILE)).mode & 0o777).toBe(0o600);

    // a recording goes to the service, with the card titles as a prompt; the key stays when another test leaves it out
    const voice = new VoiceIn(home, local, fetcher);
    writeFileSync(join(home, 'speech.webm'), 'webm');
    expect(await voice.transcribe(join(home, 'speech.webm'), 'Export für Vermieter')).toEqual({ text: 'Starte die Karte Export für Vermieter.', doubtful: false });
    expect(sent.at(-1)!.form.get('prompt')).toBe('Export für Vermieter');
    expect((sent.at(-1)!.form.get('file') as File).type).toBe('audio/webm');
    refuse = true;
    const failed = await voice.transcribe(join(home, 'speech.webm'), '').catch((e) => e);
    expect(failed).toBeInstanceOf(CloudError);
    expect(failed).toMatchObject({ service: 'Groq', message: '401: Invalid API Key' });

    // Mistral takes no prompt; an endpoint of one's own is named by its host
    refuse = false;
    await setup.useCloud({ preset: 'mistral', key: 'm-key' });
    await voice.transcribe(join(home, 'speech.webm'), 'Export');
    expect(sent.at(-1)!.form.get('prompt')).toBeNull();
    expect(sent.at(-1)!.form.get('model')).toBe('voxtral-mini-latest');
    await setup.useCloud({ preset: 'openai', key: 'k', baseUrl: 'http://gpu.local:8000/v1/', model: 'large-v3' });
    expect(sent.at(-1)!.url).toBe('http://gpu.local:8000/v1/audio/transcriptions');
    expect((await setup.view()).items[0]!.found).toBe('gpu.local:8000');
    // the stored key goes to no other endpoint unless typed for it
    await expect(setup.useCloud({ preset: 'openai', baseUrl: 'https://elsewhere.example/v1', model: 'large-v3' })).rejects.toThrow('an API key');
    expect(sent.at(-1)!.url).toBe('http://gpu.local:8000/v1/audio/transcriptions');

    // back to this machine; the service stays set up
    const back = await setup.useLocal();
    expect(back.items.map((i) => i.id)).toEqual(['uv', 'recognition', 'ffmpeg']);
    expect(back.items[1]!.cloud).toMatchObject({ preset: 'openai', used: false });
    expect(cloudInUse(home)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the recognition sidecar ends quietly when Obeya is gone before it has written a recording down', async () => {
  // a fake mlx-whisper that takes a moment for a recording longer than the warm-up's second
  const dir = mkdtempSync(join(tmpdir(), 'obeya-sidecar-'));
  try {
    writeFileSync(join(dir, 'mlx_whisper.py'), 'import time\ndef transcribe(audio, **kw):\n    time.sleep(1 if len(audio) > 16000 else 0)\n    return {"text": "Hallo"}\n');
    expect(Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', join(dir, 'speech.wav')]).exitCode).toBe(0);
    const p = Bun.spawn(['uv', 'run', '--quiet', '--no-project', '--with', 'numpy', 'python', join(resource('voice'), 'transcribe_sidecar.py'), '--backend', 'mlx'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PYTHONPATH: dir },
    });
    const out = (p.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await out.read()).value)).toContain('"ready": true');
    p.stdin.write(`${JSON.stringify({ id: 1, path: join(dir, 'speech.wav') })}\n`);
    // Obeya ends the sidecar's stdin as it stops, and is gone before the words are written
    p.stdin.end();
    await out.cancel();
    expect(await p.exited).toBe(0);
    const log = await new Response(p.stderr).text();
    expect(log).toContain('voice: 3.0 s');
    expect(log).not.toContain('BrokenPipeError');
  } finally {
    await removeDir(dir);
  }
}, 60_000);
