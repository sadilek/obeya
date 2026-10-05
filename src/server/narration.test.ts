// The voice Obeya holds across renders, against a fake voice that speaks qwen3.py's protocol: one
// queue for every render's clips, one start while clips keep coming, an end after the idle time.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClipRequest, NarrationHost, parseClipRequest } from './narration';
import { serve } from './server';

/** Logs its start, each clip and its end; `dies` as the speaker makes it die at the second clip. */
const FAKE_VOICE = `
import { appendFileSync, writeFileSync } from 'node:fs';
const [log, who] = process.argv.slice(2);
appendFileSync(log, 'start ' + who + '\\n');
console.log('loading weights ...');
if (who === 'stumm') { console.error('cannot load the model'); process.exit(2); }
console.log(JSON.stringify({ ready: true }));
let asked = 0;
for await (const line of console) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (who === 'dies' && ++asked === 2) { console.error('out of memory'); process.exit(3); }
  writeFileSync(request.out, 'RIFF');
  appendFileSync(log, request.language + ':' + request.text + '\\n');
  console.log(JSON.stringify({ ok: true, seconds: 0.01 }));
}
appendFileSync(log, 'end ' + who + '\\n');
`;

let dir: string;
let host: NarrationHost;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-narration-'));
  writeFileSync(join(dir, 'voice.ts'), FAKE_VOICE);
});
afterEach(() => {
  host?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const hold = (idleMs = 60_000) =>
  (host = new NarrationHost({ argv: (voice) => ['bun', join(dir, 'voice.ts'), join(dir, 'log'), voice.speaker ?? voice.reference ?? ''], idleMs }));
const log = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
const clip = (text: string, speaker = 'ryan'): ClipRequest => ({ voice: { speaker }, text, out: join(dir, `${text}.wav`), language: 'de' });
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(50);
};

describe('the voice Obeya holds', () => {
  test('starts once for the clips of several renders, which take turns in the order they asked', async () => {
    hold();
    // two renders, each asking for its next clip once the last is done
    const render = async (name: string) => {
      const replies = [];
      for (const n of [1, 2, 3]) replies.push(await host.clip(clip(`${name}${n}`)));
      return replies;
    };
    const [a, b] = await Promise.all([render('a'), render('b')]);
    expect([...a, ...b]).toEqual(Array(6).fill({ ok: true, seconds: 0.01 }));
    expect(log()).toEqual(['start ryan', 'de:a1', 'de:b1', 'de:a2', 'de:b2', 'de:a3', 'de:b3']);
    expect(existsSync(join(dir, 'b3.wav'))).toBe(true);
  });

  test('stays loaded for the idle time after the last clip, then ends; the next clip starts it again', async () => {
    hold(300);
    await host.clip(clip('eins'));
    await Bun.sleep(100);
    await host.clip(clip('zwei'));
    expect(log()).toEqual(['start ryan', 'de:eins', 'de:zwei']);
    await until(() => log().includes('end ryan'));
    expect(host.loaded).toBe(false);
    await host.clip(clip('drei'));
    expect(log()).toEqual(['start ryan', 'de:eins', 'de:zwei', 'end ryan', 'start ryan', 'de:drei']);
  });

  test('another voice ends the one loaded', async () => {
    hold();
    await host.clip(clip('eins'));
    await host.clip(clip('zwei', 'vivian'));
    await until(() => log().includes('end ryan'));
    // the first ends as the second loads: their lines interleave
    expect(log().toSorted()).toEqual(['de:eins', 'de:zwei', 'end ryan', 'start ryan', 'start vivian']);
    expect(log().filter((l) => l.startsWith('start'))).toEqual(['start ryan', 'start vivian']);
  });

  test('a voice that dies fails its clip with its stderr, and the next clip starts a new one', async () => {
    hold();
    expect(await host.clip(clip('eins', 'dies'))).toEqual({ ok: true, seconds: 0.01 });
    expect(await host.clip(clip('zwei', 'dies'))).toEqual({ error: expect.stringContaining('the voice stopped (3): out of memory') });
    expect(await host.clip(clip('drei', 'dies'))).toEqual({ ok: true, seconds: 0.01 });
    expect(await host.clip(clip('vier', 'stumm'))).toEqual({ error: expect.stringContaining('the voice stopped (2): cannot load the model') });
    expect(log().filter((l) => l.startsWith('start'))).toEqual(['start dies', 'start dies', 'start stumm']);
  });
});

describe('a clip over HTTP', () => {
  test('is taken as JSON only, with an absolute WAV and a plain voice', async () => {
    hold();
    const server = serve([], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) }, speaker: { speak: async () => null } }, 0, false, undefined, undefined, host);
    try {
      const post = (body: unknown, type = 'application/json') =>
        fetch(new URL('/api/narration/clip', server.url), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': type } });
      const done = await post(clip('eins'));
      expect(await done.json()).toEqual({ ok: true, seconds: 0.01 });
      // a page elsewhere can send text/plain without asking first
      expect((await post(clip('zwei'), 'text/plain')).status).toBe(415);
      expect((await post({ ...clip('zwei'), out: 'relativ.wav' })).status).toBe(400);
      expect(log()).toEqual(['start ryan', 'de:eins']);
    } finally {
      server.stop(true);
    }
  });

  test('refuses what the voice would not take', () => {
    const ok = clip('Hallo.');
    expect(parseClipRequest(ok)).toEqual(ok);
    expect(parseClipRequest({ ...ok, voice: { reference: join(dir, 'ich.wav') } })).toMatchObject({ voice: { reference: join(dir, 'ich.wav') } });
    expect(parseClipRequest({ ...ok, out: join(dir, 'x.txt') })).toContain('.wav');
    expect(parseClipRequest({ ...ok, language: 'fr' })).toContain('language');
    expect(parseClipRequest({ ...ok, text: ' ' })).toContain('text');
    expect(parseClipRequest({ ...ok, voice: { speaker: '--model evil' } })).toContain('voice');
    expect(parseClipRequest({ ...ok, voice: { reference: 'ich.wav' } })).toContain('reference');
  });
});
