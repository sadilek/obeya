// Voice in: a sidecar on this machine transcribes (Parakeet by default, Whisper where asked for),
// or a cloud service where the owner chose one (voice-cloud.ts). Obeya does not speak; its
// confirmations and answers are written.

import type { Subprocess } from 'bun';
import { join } from 'node:path';
import { LANGUAGES, type Language } from '../core/locale';
import type { ListenBackend } from '../core/types';
import { resource } from './resources';
import { OWN_GROUP } from './spawn';
import { cloudInUse, transcribeInCloud } from './voice-cloud';

/**
 * `doubtful`: Whisper itself counts the decode as failed (a loop, or too unsure of its words).
 * `unprompted`: the card titles did not go in as vocabulary (Parakeet takes none), so hearing it
 * once more without them would change nothing.
 */
export interface Transcript {
  text: string;
  doubtful: boolean;
  unprompted?: true;
}

export interface Transcriber {
  /**
   * In the language spoken, of the ones Obeya speaks: the owner may speak another than the
   * interface's, and Whisper told to expect that one translated into it.
   */
  transcribe(audioPath: string, vocabulary: string): Promise<Transcript>;
  /**
   * Gets ready for the next recording: the owner started speaking, or with `ahead` may speak soon
   * (the cursor went into Obeya's field).
   */
  warm?(ahead?: boolean): void;
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

/**
 * What the owner said in the recording at `file`: the words, `''` where they said nothing, `null`
 * where the recognition understood nothing it could write down. The card titles (`vocabulary`) talk
 * Whisper into loops or guesses on a recording without speech, so it hears such a one once more
 * without them. `on`: where it was said, for the log.
 */
export async function hear(transcriber: Transcriber, file: string, vocabulary: string, on: string): Promise<string | null> {
  const first = await transcriber.transcribe(file, vocabulary);
  const text = first.text.trim();
  if (silence(text)) return console.log(`voice on ${on}: ${text}`), '';
  if (!looping(text) && !first.doubtful) return text;
  if (first.unprompted) return console.log(`voice ${looping(text) ? 'looped' : 'was unsure'} on ${on}: ${text.slice(0, 80)}`), null;
  console.log(`whisper ${looping(text) ? 'looped' : 'was unsure'} on ${on}: ${text.slice(0, 80)}; once more without the card titles`);
  const again = await transcriber.transcribe(file, '');
  const second = again.text.trim();
  if (!looping(second) && !again.doubtful && !silence(second)) return second;
  console.log(`whisper on ${on} without the card titles${again.doubtful ? ', unsure' : ''}: ${second.slice(0, 80)}`);
  return silence(second) ? '' : null;
}

const VOICE = resource('voice');

/**
 * Speech recognition as uv brings it, for the sidecar (`voice/transcribe_sidecar.py`): Parakeet by
 * default, Whisper where asked for (CTranslate2 and ONNX Runtime have wheels for released Pythons
 * only, so 3.12). `model`: its Hugging Face repository; `mb`: about what the package and the model
 * download.
 */
export function listenKit(backend: ListenBackend = 'parakeet') {
  if (backend === 'parakeet')
    return { backend, uvArgs: ['--python', '3.12', '--with', 'onnx-asr[cpu,hub]'], module: 'onnx_asr', name: 'Parakeet', model: 'istupakov/parakeet-tdt-0.6b-v3-onnx', mb: { package: 70, model: 640 } };
  return backend === 'mlx'
    ? { backend, uvArgs: ['--with', 'mlx-whisper'], module: 'mlx_whisper', name: 'mlx-whisper', model: 'mlx-community/whisper-large-v3-turbo', mb: { package: 150, model: 1600 } }
    : { backend, uvArgs: ['--python', '3.12', '--with', 'faster-whisper'], module: 'faster_whisper', name: 'faster-whisper', model: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', mb: { package: 250, model: 1600 } };
}

/**
 * How Obeya hears on this machine: Parakeet, everywhere. `OBEYA_WHISPER_BACKEND` chooses Whisper
 * instead: `mlx`, `faster`, or `whisper` for this platform's (MLX on Apple Silicon, faster-whisper
 * elsewhere).
 */
export function listenBackend(env: Record<string, string | undefined> = process.env, platform: string = process.platform, arch: string = process.arch): ListenBackend {
  const asked = env.OBEYA_WHISPER_BACKEND;
  return asked === 'mlx' || asked === 'faster' ? asked : asked === 'whisper' ? (platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'faster') : 'parakeet';
}

/**
 * How a Python helper process starts (the transcription sidecar, the narration voice): UTF-8 on
 * stdin and stdout, also where Python would take the code page (Windows), and out of the
 * terminal's process group (`OWN_GROUP`). The Python sidecars ignore Ctrl-C on Windows themselves.
 */
export const pythonSpawn = () => ({ env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, detached: OWN_GROUP });

/** A helper process's output, line by line (without the line break). */
export async function* lines(stream: ReadableStream<Uint8Array>) {
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

/**
 * Ends a helper process gently: its stdin ends, and with it the process, which finishes what it is
 * on; one still there after 30 s is killed. Killed at once, Python leaves the semaphore of its
 * model download's progress bar behind, and its resource tracker warns about it on the terminal.
 */
export function endGently(proc: Pick<Subprocess<'pipe', 'pipe', 'pipe'>, 'stdin' | 'kill' | 'exited'>) {
  try {
    proc.stdin.end();
  } catch {}
  const kill = setTimeout(() => proc.kill(), 30_000);
  void proc.exited.then(() => clearTimeout(kill));
}

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
    const proc = Bun.spawn(this.cmd(), { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', ...pythonSpawn() });
    this.proc = proc;
    let ready = () => {};
    let ended = (_: Error) => {};
    this.loaded = new Promise<void>((resolve, reject) => ((ready = resolve), (ended = reject)));
    this.loaded.catch(() => {});
    (async () => {
      for await (const line of lines(proc.stdout)) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; error?: string; ready?: boolean };
        if (msg.ready) ready();
        const job = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!job) continue;
        this.pending.delete(msg.id!);
        if (msg.error !== undefined) job.reject(new Error(msg.error));
        else job.resolve(msg);
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

  /** Ends the sidecar gently, which finishes a recording it is on. */
  stop() {
    if (this.proc && this.proc.exitCode === null) endGently(this.proc);
  }
}

/**
 * The sidecar keeps the model loaded between recordings. Its Python comes from
 * `OBEYA_WHISPER_PYTHON` (one with the backend's package: `onnx_asr`, `mlx_whisper` or
 * `faster_whisper`), else from `uv` with the backend's package (`listenKit`).
 */
export class LocalTranscriber implements Transcriber {
  private sidecar: Sidecar;

  constructor(readonly backend: ListenBackend = listenBackend()) {
    this.sidecar = new Sidecar('transcription', () => {
      const script = [join(VOICE, 'transcribe_sidecar.py'), '--backend', backend];
      const python = process.env.OBEYA_WHISPER_PYTHON;
      return python ? [python, ...script] : ['uv', 'run', '--quiet', '--no-project', ...listenKit(backend).uvArgs, 'python', ...script];
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
    return { text: typeof text === 'string' ? text : '', doubtful: doubtful === true, ...(this.backend === 'parakeet' || !vocabulary ? { unprompted: true as const } : {}) };
  }

  /**
   * A clip heard back for the times of its words (a walkthrough's sentence, walkthrough.ts): what was
   * heard in pieces, each with the second it starts at.
   */
  async timed(audioPath: string, language: Language): Promise<[string, number][]> {
    const { timed } = await this.sidecar.request({ path: audioPath, languages: [language], timed: true });
    return Array.isArray(timed) ? timed.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') : [];
  }

  stop() {
    this.sidecar.stop();
  }
}

/**
 * Voice in as the owner set it up: through the cloud service of `voice.json` when they chose one,
 * else on this machine. Read with every recording, so a change in the settings applies to the next.
 */
export class VoiceIn implements Transcriber {
  constructor(
    private home: string,
    readonly local: LocalTranscriber,
    /** `lazy`: loads the recognition only once the owner speaks, not ahead (a scratch Obeya, scratch.ts). */
    private o: { fetcher?: typeof fetch; lazy?: boolean } = {},
  ) {}

  transcribe(audioPath: string, vocabulary: string): Promise<Transcript> {
    const cloud = cloudInUse(this.home);
    return cloud ? transcribeInCloud(cloud, audioPath, vocabulary, this.o.fetcher ?? fetch) : this.local.transcribe(audioPath, vocabulary);
  }

  warm(ahead = false) {
    if (!(ahead && this.o.lazy) && !cloudInUse(this.home)) this.local.warm();
  }

  stop() {
    this.local.stop();
  }
}
