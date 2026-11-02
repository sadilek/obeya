// The narration voice held across renders. A voice that loads a large model and can stay loaded
// (Qwen3-TTS, `qwen3.py --serve`) runs as a child of the Obeya server, which outlives every render
// and runs on every platform: `tts.py` sends each clip to `POST /api/narration/clip` when
// `OBEYA_URL` says where Obeya's narration server is (`serveNarration`; Obeya sets it for its
// workers and for the settings sheet's sample). The clips of all renders wait in one queue, served one at a time: each render asks
// for one clip at a time, so parallel renders take turns clip by clip. Once the queue is empty
// the voice stays loaded for a while (`idleMs`), then ends; a request for another voice (another
// reference, speaker or language) ends it at once. Between this server and the voice runs the
// line protocol of `qwen3.py`, unchanged. A voice that stops answering (on 2026-10-21 one sat at
// 0 % CPU with a clip in hand for 40 minutes, and every render and sample waited behind it) fails
// its clip once it has said nothing for a while (`NARRATION_LOAD_MS`, `NARRATION_SENTENCE_MS`):
// it is ended, and the next clip starts a new one.

import type { Subprocess } from 'bun';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { HeldVoice } from '../../plugin/skills/demo/lib/voices.ts';
import { endGently, lines, pythonSpawn } from './voice.ts';
import { messageOf } from '../core/text';

export interface ClipRequest {
  voice: HeldVoice;
  text: string;
  /** The text as written, where `text` has words respelt for the voice: what the voice hears its clip against. */
  script?: string;
  /** The WAV the voice writes. */
  out: string;
  language: 'de' | 'en';
  /**
   * The render runs on another machine (a worker on an SSH host, design: Hosts): the WAV comes
   * back in the reply (`wav`, base64) instead of being written to `out`, which is a path there.
   */
  inline?: boolean;
}

/**
 * What the voice heard of its clip (`qwen3.py`), passed on as it says it: a line per sentence, or
 * why it heard none.
 */
export type Hearing = { heard?: unknown[]; unheard?: string };

export type ClipReply = ({ ok: true; seconds: number; wav?: string } & Hearing) | { error: string };

/** How long the voice stays loaded after the last clip: the next render within it skips loading the model. */
export const NARRATION_IDLE_MS = 5 * 60_000;

/** How long the voice may take to load its model before it counts as stuck: a cold load took 17 s. */
export const NARRATION_LOAD_MS = 10 * 60_000;

/**
 * How long the voice may take for one sentence of a clip (it reports each, `qwen3.py`) before it
 * counts as stuck: a few seconds on a GPU, a minute or two on a slow CPU.
 */
export const NARRATION_SENTENCE_MS = 5 * 60_000;

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
      loadMs?: number;
      sentenceMs?: number;
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
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      // a clip that throws must not hold up the queue: the clips behind it would wait for good
      job.resolve(await this.synthesize(job).catch((e: unknown) => ({ error: `the clip failed: ${messageOf(e)}` })));
    }
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
      const { text, script, out, language } = request;
      voice.child.stdin.write(`${JSON.stringify({ text, ...(script ? { script } : {}), out, language })}\n`);
      voice.child.stdin.flush();
    } catch {
      return this.died(voice);
    }
    const reply = await this.reply(voice, this.o.sentenceMs ?? NARRATION_SENTENCE_MS);
    if (reply === 'stuck') return this.stuck(voice, 'making a clip', this.o.sentenceMs ?? NARRATION_SENTENCE_MS);
    if (!reply) return this.died(voice);
    if (typeof reply.error === 'string') return { error: reply.error };
    const hearing: Hearing = Array.isArray(reply.heard) ? { heard: reply.heard } : typeof reply.unheard === 'string' ? { unheard: reply.unheard } : {};
    return { ok: true, seconds: typeof reply.seconds === 'number' ? reply.seconds : 0, ...hearing };
  }

  private async start(key: string, argv: string[]): Promise<{ ok: true } | { error: string }> {
    const started = performance.now();
    let child: Running['child'];
    try {
      child = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ...pythonSpawn() });
    } catch (e) {
      return { error: `the voice did not start: ${messageOf(e)}` };
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
    const ready = await this.reply(voice, this.o.loadMs ?? NARRATION_LOAD_MS);
    if (ready === 'stuck') return this.stuck(voice, 'loading', this.o.loadMs ?? NARRATION_LOAD_MS);
    if (!ready) return this.died(voice);
    this.o.log?.(`Obeya: narration voice loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return { ok: true };
  }

  /**
   * The voice's next protocol line; null once it ended, 'stuck' when it said nothing for `ms`. A
   * line that is not the protocol is skipped, a sentence done (`{"sentence": n}`) starts the time anew.
   */
  private async reply(voice: Running, ms: number): Promise<Record<string, unknown> | null | 'stuck'> {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silent = new Promise<'stuck'>((resolve) => (timer = setTimeout(() => resolve('stuck'), ms)));
      const next = await Promise.race([voice.lines.next(), silent]).finally(() => clearTimeout(timer));
      if (next === 'stuck') return next;
      if (next.done) return null;
      let reply: unknown;
      try {
        reply = JSON.parse(next.value);
      } catch {}
      if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
        if ('sentence' in reply) continue;
        return reply as Record<string, unknown>;
      }
      this.o.log?.(`narration voice: ${next.value}`);
    }
  }

  /**
   * Ends a voice that stopped answering, so the clips behind it get their turn; the next voice
   * starts once this one has given back its memory.
   */
  private async stuck(voice: Running, doing: string, ms: number): Promise<{ error: string }> {
    if (this.voice === voice) this.voice = undefined;
    const gone = (wait: number) => Promise.race([voice.child.exited.then(() => true), Bun.sleep(wait).then(() => false)]);
    voice.child.kill();
    // one too stuck for SIGTERM
    if (!(await gone(5000))) {
      voice.child.kill('SIGKILL');
      await gone(5000);
    }
    const silence = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`;
    const why = voice.stderr.join('\n').trim().slice(-1500);
    const error = `the voice said nothing for ${silence} while ${doing} and was ended${why ? `: ${why}` : ''}`;
    this.o.log?.(`Obeya: ${error}`);
    return { error };
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

  /** Ends the voice gently. */
  private end(why: string) {
    const voice = this.voice;
    if (!voice) return;
    this.voice = undefined;
    this.o.log?.(`Obeya: narration voice ends (${why})`);
    endGently(voice.child);
  }
}

/**
 * A clip request as it comes over HTTP, checked: the voice writes a WAV where it says, so only an
 * absolute `.wav` path, and only a reference or a plain speaker name for the command line. An
 * `inline` request gets a file of its own in the temporary directory, whose WAV goes back in the reply.
 */
export function parseClipRequest(input: unknown): ClipRequest | string {
  if (!input || typeof input !== 'object') return 'a JSON object is expected';
  const { voice, text, script, language, inline } = input as Record<string, unknown>;
  let { out } = input as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) return 'text is missing';
  if (script !== undefined && typeof script !== 'string') return 'script must be a string when given';
  if (inline === true) out = join(tmpdir(), `obeya-clip-${crypto.randomUUID()}.wav`);
  else if (inline !== undefined) return 'inline must be true when given';
  if (typeof out !== 'string' || !isAbsolute(out) || !out.toLowerCase().endsWith('.wav')) return 'out must be an absolute path to a .wav';
  const back = { ...(inline === true ? { inline: true } : {}), ...(script ? { script } : {}) };
  if (language !== 'de' && language !== 'en') return 'language must be de or en';
  if (!voice || typeof voice !== 'object') return 'voice is missing';
  const { reference, speaker } = voice as Record<string, unknown>;
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !isAbsolute(reference) || !reference.toLowerCase().endsWith('.wav')) return 'voice.reference must be an absolute path to a .wav';
    return { voice: { reference }, text, out, language, ...back };
  }
  if (typeof speaker !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(speaker)) return 'voice needs a reference or a speaker';
  return { voice: { speaker }, text, out, language, ...back };
}
