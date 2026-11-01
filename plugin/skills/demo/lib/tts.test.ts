// The line protocol between `tts.py` and a voice that stays loaded (`qwen3.py --serve`), against
// fake voices: one that counts its starts, one that dies, and Qwen3's own server with a fake
// mlx-audio that prints where the protocol runs; and the same voice held by Obeya across renders
// (`src/server/narration.ts`). Python through uv, as a render runs it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrationHost } from '../../../../src/server/narration';
import { serveNarration } from '../../../../src/server/server';
import { untagged } from './timeline';
import { voiceSpec } from './voices';

const LIB = import.meta.dirname;
const python = (args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync('uv', ['run', '--quiet', '--no-project', '--with', 'numpy', 'python', ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });

/**
 * A voice that serves until its stdin ends, writing a short silent WAV per request. Given a second
 * argument, it is loaded only once that file exists. `FAKE_HANG_AT` gives no answer to that
 * request, as a stuck Qwen3 voice did; it reports a sentence done first. Given the script as
 * written, it says it heard the text as said.
 */
const FAKE_VOICE = String.raw`
import json, os, sys, time, wave
log = os.environ.get("FAKE_LOG") or sys.argv[1]
open(log, "a").write("start\n")
print("loading weights ...", flush=True)  # a library talking on stdout: not the protocol
while len(sys.argv) > 2 and not os.path.exists(sys.argv[2]):
    time.sleep(0.01)
answer = lambda reply: (sys.stdout.write(json.dumps(reply) + "\n"), sys.stdout.flush())
if os.environ.get("FAKE_DIE_AT") == "0":
    sys.exit("cannot load the model")
answer({"ready": True})
asked = 0
while line := sys.stdin.readline():
    request = json.loads(line)
    asked += 1
    if os.environ.get("FAKE_DIE_AT") == str(asked):
        print("out of memory", file=sys.stderr, flush=True)
        os._exit(3)
    if os.environ.get("FAKE_HANG_AT") == str(asked):
        answer({"sentence": 1, "of": 2})
        print("generating " + request["text"], file=sys.stderr, flush=True)
        time.sleep(3600)
    with wave.open(request["out"], "wb") as fh:
        fh.setnchannels(1); fh.setsampwidth(2); fh.setframerate(24000); fh.writeframes(b"\0\0" * 2400)
    open(log, "a").write(request["language"] + ":" + request["text"] + "\n")
    heard = {"heard": [{"script": request["script"], "heard": request["text"]}]} if "script" in request else {}
    answer({"ok": True, "seconds": 0.01, **heard})
open(log, "a").write("end\n")
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-tts-'));
  writeFileSync(join(dir, 'voice.py'), FAKE_VOICE);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ kind: 'command', argv: ['false'], serve: ['python', join(dir, 'voice.py')], tag: 'fake', heavy: true }));
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify(['Eins.', 'Zwei.', 'Drei.'].map((text, i) => ({ id: `s${i}`, text }))));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const narrate = (env: Record<string, string> = {}) =>
  python([join(LIB, 'tts.py'), join(dir, 'spec.json'), 'de', join(dir, 'jobs.json'), join(dir, 'out')], { FAKE_LOG: join(dir, 'log'), ...env });
const log = () => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
/** tts.py's render with its time limits for a voice's answers cut to a fraction of a second. */
const impatient = (env: Record<string, string>) =>
  python(
    ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(LIB)}); import tts; tts.ANSWER_LIMITS = {"load": 5, "sentence": 0.5}; sys.argv[1:] = ${JSON.stringify([join(dir, 'spec.json'), 'de', join(dir, 'jobs.json'), join(dir, 'out')])}; tts.main()`],
    { FAKE_LOG: join(dir, 'log'), ...env },
  );

describe('a voice that stays loaded', () => {
  test('starts once for all clips of a render, and not at all when every clip is cached', () => {
    const r = narrate();
    expect(r.status).toBe(0);
    expect(log()).toEqual(['start', 'de:Eins.', 'de:Zwei.', 'de:Drei.', 'end']);
    const clips = JSON.parse(readFileSync(join(dir, 'out', 'tts.json'), 'utf8')).clips;
    expect(clips.map((c: { id: string }) => c.id)).toEqual(['s0', 's1', 's2']);
    for (const c of clips) expect(existsSync(c.file)).toBe(true);
    expect(r.stderr).toContain('voice: loading weights ...');
    expect(r.stderr).toMatch(/voice loaded in [\d.]+ s/);
    rmSync(join(dir, 'log'));
    expect(narrate().status).toBe(0);
    expect(existsSync(join(dir, 'log'))).toBe(false);
  });

  test('gets the script without its audio tags, which only ElevenLabs v3 and v4 read, and a pause tag as silence', () => {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify([{ id: 's0', text: 'Eins. [short pause] Zwei [whispers] drei. [long pause] Vier.' }]));
    expect(narrate().status).toBe(0);
    // the parts between the pauses one by one, other tags left out
    expect(log()).toEqual(['start', 'de:Eins.', 'de:Zwei drei.', 'de:Vier.', 'end']);
    // three parts of 0.1 s with 0.5 s and 1.5 s of silence between them
    const clip = JSON.parse(readFileSync(join(dir, 'out', 'tts.json'), 'utf8')).clips[0];
    expect(clip.seconds).toBeCloseTo(2.3, 2);
  });

  test('a sample starts it once and ends it', () => {
    const r = python([join(LIB, 'tts.py'), '--sample', join(dir, 'spec.json'), 'en', 'Hello.', join(dir, 'sample.wav')], { FAKE_LOG: join(dir, 'log') });
    expect(r.status).toBe(0);
    expect(log()).toEqual(['start', 'en:Hello.', 'end']);
    expect(existsSync(join(dir, 'sample.wav'))).toBe(true);
  });

  test('a voice that dies stops the render with its stderr instead of hanging', () => {
    const midway = narrate({ FAKE_DIE_AT: '2' });
    expect(midway.signal).toBeNull();
    expect(midway.status).not.toBe(0);
    expect(midway.stderr).toContain('the voice stopped (3): out of memory');
    const loading = narrate({ FAKE_DIE_AT: '0' });
    expect(loading.status).not.toBe(0);
    expect(loading.stderr).toContain('cannot load the model');
  });

  test('a voice that stops answering stops the render after a while, with its stderr, instead of waiting for good', () => {
    const started = performance.now();
    const r = impatient({ FAKE_HANG_AT: '2' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('the voice said nothing for 0.5 s while making a clip and was ended: generating Zwei.');
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(log()).toEqual(['start', 'de:Eins.']);
  });
});

describe('English terms in German narration', () => {
  const lexicon = JSON.parse(readFileSync(join(LIB, 'lexicon.de.json'), 'utf8')) as Record<string, string>;
  const spec = (respell: boolean) => {
    const s = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...s, respell }));
  };
  const jobs = (...texts: string[]) => writeFileSync(join(dir, 'jobs.json'), JSON.stringify(texts.map((text, i) => ({ id: `s${i}`, text }))));
  const said = () => log().filter((l) => l.startsWith('de:')).map((l) => l.slice(3));

  test('Piper and say respell them, the others do not', () => {
    for (const voice of ['piper', 'say'] as const) expect(voiceSpec({ language: 'de', voice })).toMatchObject({ respell: true });
    for (const voice of ['qwen3', 'command', 'elevenlabs', 'gemini', 'openai', 'azure', 'http'] as const)
      expect(voiceSpec({ language: 'de', voice })).not.toHaveProperty('respell');
  });

  test('a voice that respells gets the lexicon\'s spoken forms, as whole words in any case, longest first, and a mark before the lexicon', () => {
    spec(true);
    jobs(
      'Der Pull Request liegt auf dem branch. Pull-Request und Branchen.',
      'Ein {Branch|Brantsch} auf dem {Canvas|Leinwand}. [short pause] Fertig.',
    );
    expect(narrate().status).toBe(0);
    expect(said()).toEqual([
      `Der ${lexicon['Pull Request']} liegt auf dem ${lexicon.Branch}. ${lexicon['Pull Request']} und Branchen.`,
      'Ein Brantsch auf dem Leinwand.',
      'Fertig.',
    ]);
  }, 30_000);

  test('a voice with a lexicon of its own (Qwen3) gets the words it cannot read respelt from it, the rest as written', () => {
    expect(voiceSpec({ language: 'de', voice: 'qwen3' })).toMatchObject({ lexicon: 'qwen3' });
    const own = JSON.parse(readFileSync(join(LIB, 'lexicon.qwen3.de.json'), 'utf8')) as Record<string, string>;
    const s = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...s, lexicon: 'qwen3' }));
    jobs('Der Button Reauthenticate auf dem {Canvas|Kännwes}. [short pause] Reauthenticate!', 'Ohne Lexikon.');
    expect(narrate().status).toBe(0);
    expect(said()).toEqual([`Der Button ${own.Reauthenticate} auf dem Canvas.`, `${own.Reauthenticate}!`, 'Ohne Lexikon.']);
    // it hears each part against the script as written, and what it heard stays with the clip, cached too
    const heard = [
      { script: 'Der Button Reauthenticate auf dem Canvas.', heard: `Der Button ${own.Reauthenticate} auf dem Canvas.` },
      { script: 'Reauthenticate!', heard: `${own.Reauthenticate}!` },
    ];
    const clips = () => JSON.parse(readFileSync(join(dir, 'out', 'tts.json'), 'utf8')).clips;
    expect(clips()[0]).toMatchObject({ heard });
    expect(clips()[1]).not.toHaveProperty('heard');
    rmSync(join(dir, 'log'));
    expect(narrate().status).toBe(0);
    expect(existsSync(join(dir, 'log'))).toBe(false);
    expect(clips()[0]).toMatchObject({ heard });
  }, 30_000);

  test('a voice that reads English terms (Qwen3, the hosted ones) gets them as written, without marks', () => {
    spec(false);
    jobs('Der Pull Request liegt auf dem {Canvas|Kännwes}.');
    expect(narrate().status).toBe(0);
    expect(said()).toEqual(['Der Pull Request liegt auf dem Canvas.']);
  }, 30_000);

  test('a clip is cached by what the voice says, so only a changed spoken form synthesises again', () => {
    spec(true);
    jobs('Der Branch.', 'Das Canvas.');
    expect(narrate().status).toBe(0);
    rmSync(join(dir, 'log'));
    // the same spoken forms, from a mark instead of the lexicon: nothing to synthesise
    jobs(`Der {Branch|${lexicon.Branch}}.`, `Das {Canvas|${lexicon.Canvas}}.`);
    expect(narrate().status).toBe(0);
    expect(existsSync(join(dir, 'log'))).toBe(false);
    // another spoken form for one of them: that clip alone
    jobs('Der {Branch|Brantsch}.', 'Das Canvas.');
    expect(narrate().status).toBe(0);
    expect(said()).toEqual(['Der Brantsch.']);
  }, 60_000);

  test('a sample is respelt too, and captions show the term as written', () => {
    spec(true);
    const r = python([join(LIB, 'tts.py'), '--sample', join(dir, 'spec.json'), 'de', 'Ein Feature auf dem {Canvas|Kännwes}.', join(dir, 'sample.wav')], { FAKE_LOG: join(dir, 'log') });
    expect(r.status).toBe(0);
    expect(said()).toEqual([`Ein ${lexicon.Feature} auf dem Kännwes.`]);
    expect(untagged('Ein Feature auf dem {Canvas|Kännwes}. [short pause] Fertig.')).toBe('Ein Feature auf dem Canvas. Fertig.');
  }, 30_000);
});

describe('a voice Obeya holds', () => {
  const UV = ['uv', 'run', '--quiet', '--no-project', '--with', 'numpy', 'python'];
  /** A render while this process serves Obeya's narration: spawned, not spawnSync, which would block the server. */
  const render = (out: string, env: Record<string, string>, extra: string[] = []) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(UV[0]!, [...UV.slice(1), join(LIB, 'tts.py'), ...extra, join(dir, 'spec.json'), 'de', join(dir, 'jobs.json'), join(dir, out)], {
        env: { ...process.env, ...env },
      });
      let stderr = '';
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
      child.on('close', (status) => resolve({ status, stderr }));
    });
  const go = () => join(dir, 'go');
  let host: NarrationHost;
  let server: ReturnType<typeof serveNarration>;
  beforeEach(() => {
    // the voice loads at once; a test that removes `go` holds it
    writeFileSync(go(), '');
    host = new NarrationHost({ argv: () => [...UV, join(dir, 'voice.py'), join(dir, 'log'), go()] });
    // the narration server, as Obeya gives its workers in `OBEYA_URL`
    server = serveNarration(host);
    const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...spec, host: { speaker: 'ryan' } }));
  });
  afterEach(() => {
    server.stop(true);
    host.stop();
  });

  test('loads once for parallel renders, which take turns clip by clip, and stays loaded for the next', async () => {
    // the voice loads once both renders asked for their first clip: on a busy machine the second
    // render's Python started after the first's three clips were done
    rmSync(go());
    const clip = host.clip.bind(host);
    let asked = 0;
    host.clip = (request) => (++asked === 2 && writeFileSync(go(), ''), clip(request));
    const env = { OBEYA_URL: server.url.href };
    const [a, b] = await Promise.all([render('a', env), render('b', env)]);
    expect([a.status, b.status]).toEqual([0, 0]);
    expect(a.stderr).toMatch(/synthesised by Obeya in [\d.]+ s/);
    for (const out of ['a', 'b']) expect(JSON.parse(readFileSync(join(dir, out, 'tts.json'), 'utf8')).clips).toHaveLength(3);
    // the second render's clips came between the first's
    const clips = log().slice(1);
    expect(clips.toSorted()).toEqual(['de:Drei.', 'de:Drei.', 'de:Eins.', 'de:Eins.', 'de:Zwei.', 'de:Zwei.']);
    expect(clips.slice(0, 2)).toEqual(['de:Eins.', 'de:Eins.']);
    rmSync(join(dir, 'a'), { recursive: true });
    expect((await render('a', env)).status).toBe(0);
    expect(log().filter((l) => l === 'start')).toHaveLength(1);
  }, 60_000);

  // the lock is held here with flock, which Windows lacks
  test.skipIf(process.platform === 'win32')('a render does not wait for the machine to synthesise through Obeya, and falls back to its own voice without Obeya', async () => {
    // another render holds the lock, as one with a model of its own does
    const lock = join(dir, 'tts.lock');
    const holder = spawn(UV[0]!, [...UV.slice(1), '-c', `import fcntl, sys, time\nf = open(${JSON.stringify(lock)}, "a+b")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(60)`]);
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    try {
      const held = await render('a', { OBEYA_URL: server.url.href }, ['--lock', lock]);
      expect(held.status).toBe(0);
      expect(held.stderr).not.toContain('waiting for it');
    } finally {
      holder.kill();
    }
    const alone = await render('b', { OBEYA_URL: 'http://127.0.0.1:9', FAKE_LOG: join(dir, 'log') });
    expect(alone.status).toBe(0);
    expect(alone.stderr).toContain('Obeya does not hold the voice, it is not reachable');
    expect(alone.stderr).toMatch(/voice loaded in [\d.]+ s/);
    expect(log().filter((l) => l === 'start')).toHaveLength(2);
  }, 90_000);
});

describe('qwen3.py --serve', () => {
  test('loads once, answers line by line, keeps library output off the protocol, and survives a bad request', async () => {
    // A fake mlx-audio that prints on stdout from Python and from C level, as the real one does.
    const pkg = join(dir, 'fake', 'mlx_audio', 'tts');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'fake', 'mlx_audio', '__init__.py'), '');
    writeFileSync(join(pkg, '__init__.py'), '');
    writeFileSync(
      join(pkg, 'utils.py'),
      String.raw`
import os, numpy
class Segment:
    def __init__(self, n): self.audio = numpy.zeros(n, dtype=numpy.float32)
class Model:
    sample_rate = 24000
    def generate(self, text, **kwargs):
        print("generating", text)
        os.write(1, b"raw bytes on fd 1\n")
        open(os.environ["FAKE_LOG"], "a").write(kwargs["lang_code"] + "\n")
        yield Segment(2400)
def load_model(repo):
    print("loading", repo)
    open(os.environ["FAKE_LOG"], "a").write("load\n")
    return Model()
`,
    );
    writeFileSync(join(dir, 'ref.wav'), '');
    writeFileSync(join(dir, 'ref.txt'), 'Das ist meine Stimme.');
    const requests = [
      { text: 'Erster Satz. Zweiter Satz.', out: join(dir, 'a.wav'), id: 1 },
      { text: '   ', out: join(dir, 'b.wav'), id: 2 },
      { text: 'Third.', out: join(dir, 'c.wav'), language: 'en' },
    ];
    const r = python(
      [join(LIB, 'qwen3.py'), '--model', 'm', '--language', 'de', '--reference', join(dir, 'ref.wav'), '--serve'],
      { PYTHONPATH: join(dir, 'fake'), FAKE_LOG: join(dir, 'log') },
      requests.map((q) => JSON.stringify(q)).join('\n') + '\n',
    );
    expect(r.status).toBe(0);
    const replies = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(replies).toEqual([
      { ready: true },
      { id: 1, sentence: 1, of: 2 },
      { id: 1, sentence: 2, of: 2 },
      { id: 1, ok: true, seconds: expect.any(Number), unheard: expect.stringContaining('Parakeet did not load') },
      { id: 2, error: 'ValueError: nothing to say' },
      { sentence: 1, of: 1 },
      { ok: true, seconds: expect.any(Number), unheard: expect.any(String) },
    ]);
    expect(r.stderr).toContain('raw bytes on fd 1');
    expect(log()).toEqual(['load', 'german', 'german', 'english']);
    expect(existsSync(join(dir, 'a.wav')) && existsSync(join(dir, 'c.wav'))).toBe(true);
    expect(existsSync(join(dir, 'b.wav'))).toBe(false);
  });
  test('makes a sentence again that ran on to its last frame, and fails the clip when it keeps doing so', () => {
    // A fake mlx-audio that, for its first FAKE_RUNON calls, never ends the sentence: it fills every frame it may.
    const pkg = join(dir, 'fake', 'mlx_audio', 'tts');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'fake', 'mlx_audio', '__init__.py'), '');
    writeFileSync(join(pkg, '__init__.py'), '');
    writeFileSync(
      join(pkg, 'utils.py'),
      String.raw`
import os, numpy
class Segment:
    def __init__(self, n): self.audio = numpy.zeros(n, dtype=numpy.float32)
class Model:
    sample_rate = 24000
    calls = 0
    def generate(self, text, **kwargs):
        Model.calls += 1
        open(os.environ["FAKE_LOG"], "a").write(f"{text} {kwargs['max_tokens']}\n")
        yield Segment(kwargs["max_tokens"] * 1920 if Model.calls <= int(os.environ["FAKE_RUNON"]) else 2400)
def load_model(repo):
    return Model()
`,
    );
    writeFileSync(join(dir, 'ref.wav'), '');
    writeFileSync(join(dir, 'ref.txt'), 'Das ist meine Stimme.');
    const serve = (runOn: number) =>
      python(
        [join(LIB, 'qwen3.py'), '--model', 'm', '--language', 'en', '--reference', join(dir, 'ref.wav'), '--serve'],
        { PYTHONPATH: join(dir, 'fake'), FAKE_LOG: join(dir, 'log'), FAKE_RUNON: String(runOn) },
        `${JSON.stringify({ text: 'Click Reauthenticate.', out: join(dir, 'a.wav'), id: 1 })}\n`,
      );
    const once = serve(1);
    expect(once.status).toBe(0);
    expect(once.stdout).toContain('"ok": true');
    // frames for a slow reading of 21 characters and 3 s more, asked twice
    expect(log()).toEqual(['Click Reauthenticate. 70', 'Click Reauthenticate. 70']);
    expect(once.stderr).toContain('qwen3: ran on to 6 s in attempt 1: Click Reauthenticate.');
    rmSync(join(dir, 'log'));
    rmSync(join(dir, 'a.wav'));
    const always = serve(99);
    expect(log()).toHaveLength(5);
    expect(always.stdout).toContain('the voice ran on 5 times in a row');
    expect(existsSync(join(dir, 'a.wav'))).toBe(false);
  });

  test('hears each sentence back and makes one it stumbled over again; the take that differs least is kept', () => {
    // A fake mlx-audio that runs on for its first FAKE_RUNON calls, and a fake Parakeet that hears
    // what FAKE_HEARD lists, one transcript per take: the transcripts are Parakeet's of real takes.
    const pkg = join(dir, 'fake', 'mlx_audio', 'tts');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'fake', 'mlx_audio', '__init__.py'), '');
    writeFileSync(join(pkg, '__init__.py'), '');
    writeFileSync(
      join(pkg, 'utils.py'),
      String.raw`
import os, numpy
class Segment:
    def __init__(self, n): self.audio = numpy.zeros(n, dtype=numpy.float32)
class Model:
    sample_rate = 24000
    calls = 0
    def generate(self, text, **kwargs):
        Model.calls += 1
        open(os.environ["FAKE_LOG"], "a").write(text + "\n")
        yield Segment(kwargs["max_tokens"] * 1920 if Model.calls <= int(os.environ.get("FAKE_RUNON", "0")) else 2400)
def load_model(repo):
    return Model()
`,
    );
    writeFileSync(join(dir, 'fake', 'onnxruntime.py'), 'class SessionOptions:\n    intra_op_num_threads = 0\n');
    writeFileSync(
      join(dir, 'fake', 'onnx_asr.py'),
      String.raw`
import json, os
class Model:
    heard = json.loads(os.environ["FAKE_HEARD"])
    def recognize(self, samples, sample_rate):
        assert sample_rate == 24000
        heard = Model.heard.pop(0)
        if heard is None:
            raise RuntimeError("out of memory")
        return heard
def load_model(name, quantization, sess_options, providers):
    assert name == "nemo-parakeet-tdt-0.6b-v3" and quantization == "int8"
    return Model()
`,
    );
    writeFileSync(join(dir, 'ref.wav'), '');
    writeFileSync(join(dir, 'ref.txt'), 'Das ist meine Stimme.');
    const script = 'Before the fix, the error showed in the Last failed box with a Reauthenticate button.';
    const serve = (heard: (string | null)[], env: Record<string, string> = {}, fake = join(dir, 'fake')) => {
      rmSync(join(dir, 'log'), { force: true });
      const r = python(
        [join(LIB, 'qwen3.py'), '--model', 'm', '--language', 'en', '--reference', join(dir, 'ref.wav'), '--serve'],
        { PYTHONPATH: fake, FAKE_LOG: join(dir, 'log'), FAKE_HEARD: JSON.stringify(heard), ...env },
        `${JSON.stringify({ text: script.replace('Reauthenticate', 'Reauthentikayt'), script, out: join(dir, 'a.wav') })}\n`,
      );
      expect(r.status).toBe(0);
      return { reply: JSON.parse(r.stdout.trim().split('\n').at(-1)!), takes: log().length, stderr: r.stderr };
    };
    const stumbled = 'Before the fix, the error showed in the last failed box with a reauthentip uh reauthentipite button.';
    const wrongSound = 'Before the fix, the error showed in the last failed box with a reauthentipate button.';
    const clean = 'Before the fix the error show in the last failed box with a reauthenticate button.';
    // a stumble is made again; Parakeet's own "show" for "showed" is no reason to
    const again = serve([stumbled, clean]);
    expect(again.takes).toBe(2);
    expect(again.reply).toMatchObject({ ok: true, heard: [{ script, heard: clean }] });
    expect(again.reply.heard[0]).not.toHaveProperty('misheard');
    expect(again.stderr).toContain('qwen3: stumbled in attempt 1');
    // a single wrong sound is not a stumble: kept at once, the word named
    const once = serve([wrongSound]);
    expect(once.takes).toBe(1);
    expect(once.reply.heard).toEqual([{ script, heard: wrongSound, misheard: [['Reauthenticate', 'reauthentipate']] }]);
    // a stumble in every take keeps the least of them and says so, without failing the clip
    const babble = 'Before the fix, the error show in the last failed box with a reauthentip re auth a re a reauthentia reauth reauthentio button.';
    const always = serve([babble, stumbled, babble, babble, babble]);
    expect(always.takes).toBe(5);
    expect(always.reply).toMatchObject({ ok: true, heard: [{ script, heard: stumbled, stumbled: true }] });
    expect(existsSync(join(dir, 'a.wav'))).toBe(true);
    // runs on and stumbles share the attempts; a take that ran on is never kept
    const mixed = serve([stumbled], { FAKE_RUNON: '4' });
    expect(mixed.takes).toBe(5);
    expect(mixed.reply).toMatchObject({ ok: true, heard: [{ heard: stumbled, stumbled: true }] });
    // a take the recognition fails on is not kept over one it heard
    const failing = serve([stumbled, null]);
    expect(failing.takes).toBe(2);
    expect(failing.reply).toMatchObject({ ok: true, heard: [{ heard: stumbled, stumbled: true }] });
    // without Parakeet the sentences go unheard, and the reply says why
    rmSync(join(dir, 'fake', 'onnx_asr.py'));
    const deaf = serve([]);
    expect(deaf.takes).toBe(1);
    expect(deaf.reply).toMatchObject({ ok: true, unheard: expect.stringContaining('Parakeet did not load') });
  });

  test('compares letters: numbers said as the other text has them, spaces, punctuation and audio tags left out', () => {
    // Parakeet's transcripts of real takes beside their scripts
    const cases: [string, string, string][] = [
      ['de', 'Es kostet 15.200 Euro [short pause] im Jahr.', 'Es kostet fünfzehntausendzweihundert Euro im Jahr'],
      ['de', 'Höchstens elfhundert Pixel breit, am zwölften November.', 'Höchstens 1100 Pixel breit, am 12. November.'],
      ['en', 'It took two thousand five hundred runs, on the twenty-first day.', 'It took 2,500 runs, on the 21st day.'],
      // Parakeet's own noise: a compound heard together, an English word in German narration, a dropped word
      ['de', 'Vorher stand der Fehler im Kasten Last failed.', 'Vorher stand der Fehler im Kastenlast, Fällt.'],
      ['de', 'Eine neue Aufgabe startet sofort, außer ich sage ausdrücklich, dass sie warten soll.', 'Eine neue Aufgabe startet sofort, außer ausdrücklich, dass sie warten soll.'],
      // a wrong sound, a garbled word, a stumble
      ['en', 'Click the Reauthenticate button.', 'Click the reauthentipate button.'],
      ['de', 'Mit einem Button Reauthenticate.', 'Mit einem ButtonRare Templet.'],
      ['en', 'Click the Reauthenticate button.', 'Click the reauthentip uh reauthentipite button.'],
      // a short sentence not said at all
      ['en', 'Click save.', ''],
    ];
    const r = python(
      [
        '-c',
        `import sys, json; sys.path.insert(0, ${JSON.stringify(LIB)}); import qwen3
print(json.dumps([[qwen3.differing(s, h, l), qwen3.misheard(s, h, l)] for l, s, h in json.loads(sys.argv[1])]))`,
        JSON.stringify(cases),
      ],
      {},
    );
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual([
      [0, []],
      [0, []],
      [0, []],
      [2, [['failed', 'Fällt']]],
      [0, []],
      [1, [['Reauthenticate', 'reauthentipate']]],
      [5, [['Button Reauthenticate', 'ButtonRare Templet']]],
      [9, [['Reauthenticate', 'reauthentip uh reauthentipite']]],
      [9, []],
    ]);
  });

  test('ends quietly when whoever asked is gone before the clip is done', async () => {
    const pkg = join(dir, 'fake', 'mlx_audio', 'tts');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'fake', 'mlx_audio', '__init__.py'), '');
    writeFileSync(join(pkg, '__init__.py'), '');
    writeFileSync(
      join(pkg, 'utils.py'),
      String.raw`
import time, numpy
class Segment:
    def __init__(self, n): self.audio = numpy.zeros(n, dtype=numpy.float32)
class Model:
    sample_rate = 24000
    def generate(self, text, **kwargs):
        time.sleep(1)
        yield Segment(2400)
def load_model(repo):
    return Model()
`,
    );
    writeFileSync(join(dir, 'ref.wav'), '');
    writeFileSync(join(dir, 'ref.txt'), 'Das ist meine Stimme.');
    const p = Bun.spawn(['uv', 'run', '--quiet', '--no-project', '--with', 'numpy', 'python', join(LIB, 'qwen3.py'), '--model', 'm', '--language', 'de', '--reference', join(dir, 'ref.wav'), '--serve'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PYTHONPATH: join(dir, 'fake') },
    });
    const out = (p.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await out.read()).value)).toContain('"ready": true');
    p.stdin.write(`${JSON.stringify({ text: 'Ein Satz.', out: join(dir, 'a.wav'), id: 1 })}\n`);
    p.stdin.end();
    // Obeya stops while the clip is made: nobody reads the answer
    await out.cancel();
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).not.toContain('BrokenPipeError');
  }, 60_000);
});
