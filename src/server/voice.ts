// Voice in: the Whisper sidecar transcribes (mlx-whisper on Apple Silicon, faster-whisper elsewhere).
// Obeya does not speak; its confirmations and answers are written.

import type { Subprocess } from 'bun';
import { join } from 'node:path';
import { whisperKit } from '../../plugin/skills/demo/lib/setup.ts';
import { LANGUAGES } from '../core/locale';
import { resource } from './resources';

/** `doubtful`: Whisper itself counts the decode as failed (a loop, or too unsure of its words). */
export interface Transcript {
  text: string;
  doubtful: boolean;
}

export interface Transcriber {
  /**
   * In the language Whisper hears spoken, of the ones Obeya speaks: the owner may speak another
   * than the interface's, and Whisper told to expect that one translated into it.
   */
  transcribe(audioPath: string, vocabulary: string): Promise<Transcript>;
  /** Gets ready for the next recording (the owner started speaking). */
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
 * „Musik“, sure of itself and without the card titles, came from a 0.6 s press with room noise only;
 * in English it thanks for watching, as it learnt from subtitles.
 */
export const silence = (text: string) =>
  /^[[(*]?(vielen dank|danke fürs zuschauen|musik|untertitel(ung)? (im auftrag )?des zdf.*|thank you|thanks for watching|music)[.!]?[\])*]?$/i.test(text.trim());

const VOICE = resource('voice');

export type ListenBackend = 'mlx' | 'faster';

/**
 * How Obeya hears on this machine: MLX on Apple Silicon, faster-whisper elsewhere.
 * `OBEYA_WHISPER_BACKEND` (mlx, faster) chooses otherwise.
 */
export function voiceBackends(env: Record<string, string | undefined> = process.env, platform: string = process.platform, arch: string = process.arch) {
  const listen: ListenBackend =
    env.OBEYA_WHISPER_BACKEND === 'mlx' || env.OBEYA_WHISPER_BACKEND === 'faster' ? env.OBEYA_WHISPER_BACKEND : platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'faster';
  return { listen };
}

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
    const { text, doubtful } = await this.sidecar.request({ path: audioPath, prompt: vocabulary, languages: LANGUAGES });
    return { text: typeof text === 'string' ? text : '', doubtful: doubtful === true };
  }

  stop() {
    this.sidecar.stop();
  }
}
