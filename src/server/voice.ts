// Voice in and out: the Whisper sidecar transcribes, the speech sidecar (else `say`) speaks.

import type { Subprocess } from 'bun';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Transcriber {
  transcribe(audioPath: string, vocabulary: string): Promise<string>;
  /** Gets ready for the next recording (the owner started speaking). */
  warm?(): void;
}

export interface Speaker {
  /** The text as WAV the browser plays; null when it could not be spoken. */
  speak(text: string): Promise<Uint8Array<ArrayBuffer> | null>;
  warm?(): void;
}

const VOICE = join(import.meta.dir, '../../voice');

/** A helper process that stays up and answers JSON lines by id: `{id, …}` in, `{id, …}` or `{id, error}` out. */
class Sidecar {
  private proc: Subprocess<'pipe', 'pipe', 'inherit'> | null = null;
  private pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private next = 1;

  constructor(
    private name: string,
    private cmd: () => string[],
  ) {}

  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = Bun.spawn(this.cmd(), { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    this.proc = proc;
    (async () => {
      let buf = '';
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { id?: number; error?: string };
          const job = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (!job) continue;
          this.pending.delete(msg.id!);
          if (msg.error !== undefined) job.reject(new Error(msg.error));
          else job.resolve(msg);
        }
      }
      // the sidecar died: fail what waits, the next request starts a new one
      for (const [, job] of this.pending) job.reject(new Error(`${this.name} sidecar exited`));
      this.pending.clear();
    })();
    return proc;
  }

  request(job: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proc = this.ensure();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ id, ...job })}\n`);
      proc.stdin.flush();
    });
  }

  stop() {
    this.proc?.kill();
  }
}

/**
 * The sidecar keeps the model loaded between recordings. Its Python comes from
 * `OBEYA_WHISPER_PYTHON` (one with `mlx_whisper`), else from `uv` with mlx-whisper.
 */
export class WhisperSidecar implements Transcriber {
  private sidecar = new Sidecar('transcription', () => {
    const script = join(VOICE, 'whisper_sidecar.py');
    const python = process.env.OBEYA_WHISPER_PYTHON;
    return python ? [python, script] : ['uv', 'run', '--quiet', '--with', 'mlx-whisper', 'python', script];
  });

  /** Starts the sidecar, which loads the model before its first recording arrives. */
  warm() {
    this.sidecar.ensure();
  }

  async transcribe(audioPath: string, vocabulary: string): Promise<string> {
    const { text } = await this.sidecar.request({ path: audioPath, prompt: vocabulary });
    return typeof text === 'string' ? text : '';
  }

  stop() {
    this.sidecar.stop();
  }
}

/**
 * The confirmation in the default system voice. A JXA sidecar keeps the synthesizer loaded (about
 * half a second a sentence); when it fails, `say` renders it (about a second and a half).
 */
export class SpeechSidecar implements Speaker {
  private sidecar = new Sidecar('speech', () => ['osascript', '-l', 'JavaScript', join(VOICE, 'speech_sidecar.js')]);

  warm() {
    this.sidecar.ensure();
  }

  async speak(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-say-'));
    const aiff = join(dir, 'ack.aiff');
    const wav = join(dir, 'ack.wav');
    try {
      await within(8000, this.sidecar.request({ text, path: aiff }));
      const convert = Bun.spawn(['afconvert', '-f', 'WAVE', '-d', 'LEI16', aiff, wav], { stdout: 'ignore', stderr: 'ignore' });
      if ((await convert.exited) !== 0) throw new Error('afconvert failed');
      return new Uint8Array(readFileSync(wav));
    } catch (e) {
      console.error('speech sidecar:', e instanceof Error ? e.message : e);
      // a stuck sidecar would hold up every confirmation after this one: the next starts afresh
      this.sidecar.stop();
      return say(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  stop() {
    this.sidecar.stop();
  }
}

/** The confirmation as speech: macOS `say` with the default voice, as WAV the browser plays. */
export async function say(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-say-'));
  const out = join(dir, 'ack.wav');
  try {
    const proc = Bun.spawn(['say', '-o', out, '--data-format=LEI16@22050', text], { stdout: 'ignore', stderr: 'ignore' });
    return (await within(8000, proc.exited)) === 0 ? new Uint8Array(readFileSync(out)) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
