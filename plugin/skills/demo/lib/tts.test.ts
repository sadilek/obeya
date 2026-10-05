// The line protocol between `tts.py` and a voice that stays loaded (`qwen3.py --serve`), against
// fake voices: one that counts its starts, one that dies, and Qwen3's own server with a fake
// mlx-audio that prints where the protocol runs. Python through uv, as a render runs it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = import.meta.dirname;
const python = (args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync('uv', ['run', '--quiet', '--no-project', '--with', 'numpy', 'python', ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });

/** A voice that serves until its stdin ends, writing a short silent WAV per request. */
const FAKE_VOICE = String.raw`
import json, os, sys, wave
log = os.environ["FAKE_LOG"]
open(log, "a").write("start\n")
print("loading weights ...", flush=True)  # a library talking on stdout: not the protocol
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
    with wave.open(request["out"], "wb") as fh:
        fh.setnchannels(1); fh.setsampwidth(2); fh.setframerate(24000); fh.writeframes(b"\0\0" * 2400)
    open(log, "a").write(request["language"] + ":" + request["text"] + "\n")
    answer({"ok": True, "seconds": 0.01})
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
  python([join(LIB, 'tts.py'), '--listen', 'off', join(dir, 'spec.json'), 'de', join(dir, 'jobs.json'), join(dir, 'out')], { FAKE_LOG: join(dir, 'log'), ...env });
const log = () => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');

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
      { id: 1, ok: true, seconds: expect.any(Number) },
      { id: 2, error: 'ValueError: nothing to say' },
      { ok: true, seconds: expect.any(Number) },
    ]);
    expect(r.stderr).toContain('raw bytes on fd 1');
    expect(log()).toEqual(['load', 'german', 'german', 'english']);
    expect(existsSync(join(dir, 'a.wav')) && existsSync(join(dir, 'c.wav'))).toBe(true);
    expect(existsSync(join(dir, 'b.wav'))).toBe(false);
  });
});
