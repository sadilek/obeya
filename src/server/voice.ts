// Voice in and out: the Whisper sidecar transcribes, macOS `say` speaks.

import type { Subprocess } from 'bun';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Transcriber {
  transcribe(audioPath: string, vocabulary: string): Promise<string>;
}

const SIDECAR = join(import.meta.dir, '../../voice/whisper_sidecar.py');

/**
 * The sidecar keeps the model loaded between recordings. Its Python comes from
 * `OBEYA_WHISPER_PYTHON` (one with `mlx_whisper`), else from `uv` with mlx-whisper.
 */
export class WhisperSidecar implements Transcriber {
  private proc: Subprocess<'pipe', 'pipe', 'inherit'> | null = null;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  private next = 1;

  private ensure() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const python = process.env.OBEYA_WHISPER_PYTHON;
    const cmd = python ? [python, SIDECAR] : ['uv', 'run', '--quiet', '--with', 'mlx-whisper', 'python', SIDECAR];
    const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
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
          const msg = JSON.parse(line) as { id?: number; text?: string; error?: string };
          const job = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (!job) continue;
          this.pending.delete(msg.id!);
          if (msg.error !== undefined) job.reject(new Error(msg.error));
          else job.resolve(msg.text ?? '');
        }
      }
      // the sidecar died: fail what waits, the next recording starts a new one
      for (const [, job] of this.pending) job.reject(new Error('transcription sidecar exited'));
      this.pending.clear();
    })();
    return proc;
  }

  transcribe(audioPath: string, vocabulary: string): Promise<string> {
    const proc = this.ensure();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ id, path: audioPath, prompt: vocabulary })}\n`);
      proc.stdin.flush();
    });
  }

  stop() {
    this.proc?.kill();
  }
}

/** The confirmation as speech: macOS `say` with the default voice, as WAV the browser plays. */
export function speak(text: string): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-say-'));
  const out = join(dir, 'ack.wav');
  try {
    const r = Bun.spawnSync(['say', '-o', out, '--data-format=LEI16@22050', text], { stderr: 'ignore' });
    return r.exitCode === 0 ? new Uint8Array(readFileSync(out)) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
