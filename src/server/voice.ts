// Voice in and out: the Whisper sidecar transcribes (mlx-whisper on Apple Silicon, faster-whisper
// elsewhere), the speech sidecar speaks (the macOS synthesizer, else `say`, on a Mac; Piper elsewhere).

import type { Subprocess } from 'bun';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whisperKit } from '../../plugin/skills/demo/lib/setup.ts';
import type { DemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { installState, piperFiles } from '../../plugin/skills/demo/lib/voices.ts';

/** `doubtful`: Whisper itself counts the decode as failed (a loop, or too unsure of its words). */
export interface Transcript {
  text: string;
  doubtful: boolean;
}

export interface Transcriber {
  transcribe(audioPath: string, vocabulary: string): Promise<Transcript>;
  /** Gets ready for the next recording (the owner started speaking). */
  warm?(): void;
}

export interface Speaker {
  /** The text as WAV the browser plays; null when it could not be spoken. */
  speak(text: string): Promise<Uint8Array<ArrayBuffer> | null>;
  warm?(): void;
}

/**
 * Whisper's way of failing on a recording without audible speech, the card titles as prompt making
 * it likelier: one word, phrase or syllable over and over („Fall Fall Fall …“, „aufgingingingi…“).
 * Six times in a row is a loop; nobody says a command like that.
 */
export function looping(text: string): boolean {
  const plain = `${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return /(.{1,60}?)\1{5}/u.test(plain);
}

/**
 * What Whisper writes for a recording without speech instead of a loop: there was nothing to hear.
 * „Musik“, sure of itself and without the card titles, came from a 0.6 s press with room noise only.
 */
export const silence = (text: string) =>
  /^[[(*]?(vielen dank|danke fürs zuschauen|musik|untertitel(ung)? (im auftrag )?des zdf.*)[.!]?[\])*]?$/i.test(text.trim());

const VOICE = join(import.meta.dir, '../../voice');

export type ListenBackend = 'mlx' | 'faster';
export type SpeechBackend = 'macos' | 'piper';

/**
 * How Obeya hears and speaks on this machine: MLX and the macOS voice on a Mac (MLX on Apple
 * Silicon only), faster-whisper and Piper elsewhere. `OBEYA_WHISPER_BACKEND` (mlx, faster) and
 * `OBEYA_SPEECH` (macos, piper) choose otherwise, say Piper on a Mac.
 */
export function voiceBackends(env: Record<string, string | undefined> = process.env, platform: string = process.platform, arch: string = process.arch) {
  const listen: ListenBackend =
    env.OBEYA_WHISPER_BACKEND === 'mlx' || env.OBEYA_WHISPER_BACKEND === 'faster' ? env.OBEYA_WHISPER_BACKEND : platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'faster';
  const speech: SpeechBackend = env.OBEYA_SPEECH === 'macos' || env.OBEYA_SPEECH === 'piper' ? env.OBEYA_SPEECH : platform === 'darwin' ? 'macos' : 'piper';
  return { listen, speech };
}

/** The Piper voice the confirmations are spoken in: the demos' default German one. */
export const CONFIRMATION_VOICE: DemoSettings = { language: 'de', voice: 'piper' };

/**
 * A helper process in a process group of its own (POSIX): Ctrl-C in the terminal goes to the whole
 * foreground group, and a sidecar it reached died with a traceback while Obeya still waited for its
 * workers. Not on Windows, where a detached process has no console and every console program it
 * starts (ffmpeg) opens a window; the Python sidecars ignore Ctrl-C there themselves.
 */
export const OWN_GROUP = process.platform !== 'win32';

/** A helper process that stays up and answers JSON lines by id: `{id, …}` in, `{id, …}` or `{id, error}` out. */
class Sidecar {
  private proc: Subprocess<'pipe', 'pipe', 'inherit'> | null = null;
  private pending = new Map<number, { resolve: (msg: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private next = 1;
  /** Settles once the running process has loaded its model (`{"ready": true}`), or has ended before. */
  private loaded: Promise<void> = Promise.resolve();

  constructor(
    private name: string,
    private cmd: () => string[],
  ) {}

  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    // UTF-8 on stdin and stdout, also where Python would take the code page (Windows); out of the
    // terminal's process group, so its Ctrl-C reaches Obeya alone, which ends the sidecar itself
    const proc = Bun.spawn(this.cmd(), { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, detached: OWN_GROUP });
    this.proc = proc;
    let ready = () => {};
    let ended = (_: Error) => {};
    this.loaded = new Promise<void>((resolve, reject) => ((ready = resolve), (ended = reject)));
    this.loaded.catch(() => {});
    (async () => {
      let buf = '';
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { id?: number; error?: string; ready?: boolean };
          if (msg.ready) ready();
          const job = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (!job) continue;
          this.pending.delete(msg.id!);
          if (msg.error !== undefined) job.reject(new Error(msg.error));
          else job.resolve(msg);
        }
      }
      // the sidecar died: fail what waits, the next request starts a new one
      ended(new Error(`${this.name} sidecar exited (${await proc.exited})`));
      for (const [, job] of this.pending) job.reject(new Error(`${this.name} sidecar exited`));
      this.pending.clear();
    })();
    return proc;
  }

  /** Starts the process if needed and waits until it has loaded its model. */
  ready(): Promise<void> {
    this.ensure();
    return this.loaded;
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
 * `OBEYA_WHISPER_PYTHON` (one with `mlx_whisper` or `faster_whisper`), else from `uv` with the
 * backend's package (the same kit the demos listen back with).
 */
export class WhisperSidecar implements Transcriber {
  private sidecar: Sidecar;

  constructor(readonly backend: ListenBackend = voiceBackends().listen) {
    this.sidecar = new Sidecar('transcription', () => {
      const script = [join(VOICE, 'whisper_sidecar.py'), '--backend', backend];
      const python = process.env.OBEYA_WHISPER_PYTHON;
      return python ? [python, ...script] : ['uv', 'run', '--quiet', '--no-project', ...whisperKit(backend).uvArgs, 'python', ...script];
    });
  }

  /** Starts the sidecar, which loads the model before its first recording arrives. */
  warm() {
    this.sidecar.ensure();
  }

  /** Loads the model, which the first time fetches the package and the model. */
  prepare(): Promise<void> {
    return this.sidecar.ready();
  }

  async transcribe(audioPath: string, vocabulary: string): Promise<Transcript> {
    const { text, doubtful } = await this.sidecar.request({ path: audioPath, prompt: vocabulary });
    return { text: typeof text === 'string' ? text : '', doubtful: doubtful === true };
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

/**
 * The confirmation in Piper's voice, off the Mac: a sidecar in Piper's environment under Obeya's
 * home keeps the voice loaded. Without Piper installed nothing is spoken (the settings sheet
 * installs it); the written confirmation shows all the same.
 */
export class PiperSpeaker implements Speaker {
  private sidecar: Sidecar;
  private told = false;

  constructor(private home: string) {
    const { python, onnx } = piperFiles(CONFIRMATION_VOICE, home);
    this.sidecar = new Sidecar('Piper', () => [python, join(VOICE, 'piper_sidecar.py'), onnx]);
  }

  private installed() {
    if (installState(CONFIRMATION_VOICE, this.home).installed) return true;
    if (!this.told) console.log('Obeya: Piper is not installed, confirmations are not spoken (the settings sheet installs it)');
    this.told = true;
    return false;
  }

  warm() {
    if (this.installed()) this.sidecar.ensure();
  }

  async speak(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!this.installed()) return null;
    const dir = mkdtempSync(join(tmpdir(), 'obeya-piper-'));
    const wav = join(dir, 'ack.wav');
    try {
      // the first one may wait for the voice to load
      await within(15_000, this.sidecar.request({ text, path: wav }));
      return new Uint8Array(readFileSync(wav));
    } catch (e) {
      console.error('Piper sidecar:', e instanceof Error ? e.message : e);
      this.sidecar.stop();
      return null;
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
