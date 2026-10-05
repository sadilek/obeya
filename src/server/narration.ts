// The narration voice held across renders. A voice that loads a large model and can stay loaded
// (Qwen3-TTS, `qwen3.py --serve`) runs as a child of the Obeya server, which outlives every render
// and runs on every platform: `tts.py` sends each clip to `POST /api/narration/clip` when
// `OBEYA_URL` says where Obeya is (Obeya sets it for its workers and for the settings sheet's
// sample). The clips of all renders wait in one queue, served one at a time: each render asks
// for one clip at a time, so parallel renders take turns clip by clip. Once the queue is empty
// the voice stays loaded for a while (`idleMs`), then ends; a request for another voice (another
// reference, speaker or language) ends it at once. Between this server and the voice runs the
// line protocol of `qwen3.py`, unchanged.

import type { Subprocess } from 'bun';
import { isAbsolute } from 'node:path';
import type { HeldVoice } from '../../plugin/skills/demo/lib/voices.ts';

export interface ClipRequest {
  voice: HeldVoice;
  text: string;
  /** The WAV the voice writes. */
  out: string;
  language: 'de' | 'en';
}

export type ClipReply = { ok: true; seconds: number } | { error: string };

/** How long the voice stays loaded after the last clip: the next render within it skips loading the model. */
export const NARRATION_IDLE_MS = 5 * 60_000;

interface Job {
  argv: string[];
  request: ClipRequest;
  resolve: (reply: ClipReply) => void;
}

interface Running {
  key: string;
  child: Subprocess<'pipe', 'pipe', 'pipe'>;
  lines: AsyncIterator<string>;
  /** The tail of its stderr: why, when it dies. */
  stderr: string[];
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
}

export class NarrationHost {
  private queue: Job[] = [];
  private serving = false;
  private voice?: Running;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(
    private o: {
      /** The command that serves this voice (`voices.ts`: `qwen3Serve`). */
      argv: (voice: HeldVoice, language: ClipRequest['language']) => string[];
      idleMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  /** Synthesises one clip once its turn comes; the voice starts first when it is not loaded. */
  clip(request: ClipRequest): Promise<ClipReply> {
    return new Promise((resolve) => {
      this.queue.push({ argv: this.o.argv(request.voice, request.language), request, resolve });
      void this.serve();
    });
  }

  /** Whether a voice is loaded (for tests and the log). */
  get loaded() {
    return !!this.voice;
  }

  /** Ends the voice now, for Obeya's shutdown. */
  stop() {
    clearTimeout(this.idle);
    this.voice?.child.kill();
    this.voice = undefined;
  }

  private async serve() {
    if (this.serving) return;
    this.serving = true;
    clearTimeout(this.idle);
    for (let job = this.queue.shift(); job; job = this.queue.shift()) job.resolve(await this.synthesize(job));
    this.serving = false;
    if (this.voice) this.idle = setTimeout(() => this.end('nothing more to say'), this.o.idleMs ?? NARRATION_IDLE_MS);
  }

  private async synthesize({ argv, request }: Job): Promise<ClipReply> {
    const key = JSON.stringify(argv);
    if (this.voice && this.voice.key !== key) this.end('another voice is asked for');
    if (!this.voice) {
      const started = await this.start(key, argv);
      if ('error' in started) return started;
    }
    const voice = this.voice!;
    try {
      voice.child.stdin.write(`${JSON.stringify({ text: request.text, out: request.out, language: request.language })}\n`);
      voice.child.stdin.flush();
    } catch {
      return this.died(voice);
    }
    const reply = await this.reply(voice);
    if (!reply) return this.died(voice);
    if (typeof reply.error === 'string') return { error: reply.error };
    return { ok: true, seconds: typeof reply.seconds === 'number' ? reply.seconds : 0 };
  }

  private async start(key: string, argv: string[]): Promise<{ ok: true } | { error: string }> {
    const started = performance.now();
    let child: Running['child'];
    try {
      child = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch (e) {
      return { error: `the voice did not start: ${e instanceof Error ? e.message : String(e)}` };
    }
    const voice: Running = { key, child, lines: lines(child.stdout)[Symbol.asyncIterator](), stderr: [] };
    // read all along, so a chatty voice never blocks on a full pipe
    void (async () => {
      for await (const line of lines(child.stderr)) {
        voice.stderr.push(line);
        if (voice.stderr.length > 40) voice.stderr.shift();
      }
    })();
    this.voice = voice;
    this.o.log?.(`Obeya: starting the narration voice (${argv.slice(-6).join(' ')})`);
    const ready = await this.reply(voice);
    if (!ready) return this.died(voice);
    this.o.log?.(`Obeya: narration voice loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return { ok: true };
  }

  /** The voice's next protocol line; null once it ended. A line that is not the protocol is skipped. */
  private async reply(voice: Running): Promise<Record<string, unknown> | null> {
    while (true) {
      const next = await voice.lines.next();
      if (next.done) return null;
      try {
        const reply = JSON.parse(next.value) as unknown;
        if (reply && typeof reply === 'object' && !Array.isArray(reply)) return reply as Record<string, unknown>;
      } catch {}
      this.o.log?.(`narration voice: ${next.value}`);
    }
  }

  private async died(voice: Running): Promise<{ error: string }> {
    if (this.voice === voice) this.voice = undefined;
    const code = await voice.child.exited;
    // the stderr reader may still hold the last lines
    await Bun.sleep(50);
    const error = `the voice stopped (${code}): ${voice.stderr.join('\n').trim().slice(-1500)}`;
    this.o.log?.(`Obeya: ${error}`);
    return { error };
  }

  /** Its stdin ends, and with it the voice; one that does not end within 30 s is killed. */
  private end(why: string) {
    const voice = this.voice;
    if (!voice) return;
    this.voice = undefined;
    this.o.log?.(`Obeya: narration voice ends (${why})`);
    try {
      voice.child.stdin.end();
    } catch {}
    const kill = setTimeout(() => voice.child.kill(), 30_000);
    void voice.child.exited.then(() => clearTimeout(kill));
  }
}

/**
 * A clip request as it comes over HTTP, checked: the voice writes a WAV where it says, so only an
 * absolute `.wav` path, and only a reference or a plain speaker name for the command line.
 */
export function parseClipRequest(input: unknown): ClipRequest | string {
  if (!input || typeof input !== 'object') return 'a JSON object is expected';
  const { voice, text, out, language } = input as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) return 'text is missing';
  if (typeof out !== 'string' || !isAbsolute(out) || !out.toLowerCase().endsWith('.wav')) return 'out must be an absolute path to a .wav';
  if (language !== 'de' && language !== 'en') return 'language must be de or en';
  if (!voice || typeof voice !== 'object') return 'voice is missing';
  const { reference, speaker } = voice as Record<string, unknown>;
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !isAbsolute(reference) || !reference.toLowerCase().endsWith('.wav')) return 'voice.reference must be an absolute path to a .wav';
    return { voice: { reference }, text, out, language };
  }
  if (typeof speaker !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(speaker)) return 'voice needs a reference or a speaker';
  return { voice: { speaker }, text, out, language };
}
