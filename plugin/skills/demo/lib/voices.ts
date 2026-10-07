// The voice providers: what each needs installed, how Obeya installs it, and the spec `tts.py`
// synthesises with. Every voice is text in, WAV out. A local one runs as a command (Piper, the
// Qwen3-TTS helper `qwen3.py`, macOS `say`, the owner's own command), once per clip, or once per
// render for one that can stay loaded (Qwen3-TTS), which a running Obeya holds loaded across
// renders instead (`src/server/narration.ts`); a hosted one is an HTTP request `tts.py`
// makes from a template (Gemini, OpenAI, ElevenLabs, Azure, or the owner's own endpoint).
//
// Piper and Qwen3-TTS are installed on request into `voices/` in Obeya's home, each in a Python
// environment of its own made by uv; Piper's voice files go beside it, Qwen3's models into the
// Hugging Face cache, where a model downloaded before is found again. Run on its own,
// `node voices.ts status` says whether the voice of the settings is installed and
// `node voices.ts install` installs it, for a session without Obeya.
//
// Plain Node with type stripping, like the director.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain, lib } from './here.ts';
import { type DemoSettings, expandHome, type NarrationLanguage, obeyaHome, readDemoSettings, SERVICES } from './settings.ts';

/** Piper's voices: one per language unless the settings name another. */
export const PIPER_VOICES: Record<NarrationLanguage, string> = { de: 'de_DE-thorsten-high', en: 'en_US-ryan-high' };
const PIPER_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
/** Qwen3-TTS: a stock speaker from the CustomVoice model, or a clone of a clip with the Base model. */
export const QWEN3_SPEAKER = 'ryan';
/** Apple Silicon runs Qwen3-TTS on MLX; elsewhere it is PyTorch, in practice only with a GPU. */
export const onMlx = () => process.platform === 'darwin' && process.arch === 'arm64';
const qwen3Model = (clone: boolean) =>
  onMlx()
    ? `mlx-community/Qwen3-TTS-12Hz-1.7B-${clone ? 'Base' : 'CustomVoice'}-bf16`
    : `Qwen/Qwen3-TTS-12Hz-1.7B-${clone ? 'Base' : 'CustomVoice'}`;
/** `say`'s voice per language when the settings name none. */
export const SAY_VOICES: Record<NarrationLanguage, string> = { de: 'Anna', en: 'Samantha' };

/** A Qwen3 voice: a clone of a reference clip (its transcript beside it), or a stock speaker. */
export interface HeldVoice {
  reference?: string;
  speaker?: string;
}

/** What `tts.py` gets: a command to run per clip, or a service to call. */
export type VoiceSpec =
  | {
      kind: 'command';
      /** Run directly, `{out}` replaced by the WAV to write; or `shell`, through the shell, with `$DEMO_WAV`. */
      argv?: string[];
      shell?: string;
      /** For the clip cache: changes when the voice does. */
      tag: string;
      /** Loads a large model: one such synthesis at a time on the machine. */
      heavy: boolean;
      /**
       * The voice can stay loaded: this command starts once per render and answers clip by clip
       * over its stdin and stdout (the protocol is in `qwen3.py`). Without it, `argv` or `shell`
       * runs once per clip.
       */
      serve?: string[];
      /**
       * Obeya can hold this voice loaded across renders: `tts.py` asks Obeya for each clip when
       * `OBEYA_URL` is set, and serves it itself otherwise (or when Obeya does not answer).
       */
      host?: HeldVoice;
    }
  | {
      kind: 'http';
      service: (typeof SERVICES)[number] | 'http';
      url?: string;
      voiceName?: string;
      keyFile?: string;
    };

/** Something a voice needs on this machine before it can speak. */
export interface Component {
  /** Shown to the owner: what is downloaded. */
  label: string;
  /** About this many megabytes, downloaded and on disk. */
  mb: number;
  installed: () => boolean;
  install: (log: (line: string) => void) => Promise<void>;
}

export const voicesHome = (home = obeyaHome()) => path.join(home, 'voices');
const envPython = (dir: string) =>
  path.join(dir, 'env', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const INSTALLED = '.obeya-installed';

function piperVoice(s: DemoSettings) {
  const name = s.voiceName || PIPER_VOICES[s.language];
  const [locale = '', ...rest] = name.split('-');
  const quality = rest.pop() ?? '';
  return { name, url: `${PIPER_BASE}/${locale.split('_')[0]}/${locale}/${rest.join('-')}/${quality}/${name}.onnx` };
}

/** Piper's Python and the voice file of these settings, as installed under Obeya's home. */
export function piperFiles(s: DemoSettings, home = obeyaHome()) {
  const dir = path.join(voicesHome(home), 'piper');
  return { python: envPython(dir), onnx: path.join(dir, `${piperVoice(s).name}.onnx`) };
}

/** The Hugging Face cache, where Qwen3's models go (and where an earlier download already is). */
function hfHub() {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  return path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
}

/** Whether a model is in the Hugging Face cache: its config and its weights (safetensors, or CTranslate2's `model.bin`). */
export function hfModelPresent(repo: string) {
  const snapshots = path.join(hfHub(), `models--${repo.replace('/', '--')}`, 'snapshots');
  if (!fs.existsSync(snapshots)) return false;
  return fs.readdirSync(snapshots).some((snap) => {
    const files = fs.readdirSync(path.join(snapshots, snap));
    return files.includes('config.json') && files.some((f) => f.endsWith('.safetensors') || f === 'model.bin');
  });
}

/** Runs a program to its end, its output line by line into `log`; rejects with the last lines. */
function exec(cmd: string, args: string[], log: (line: string) => void, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
    const tail: string[] = [];
    const take = (b: Buffer) => {
      for (const line of b.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        log(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} failed (${code}):\n${tail.join('\n')}`))));
  });
}

/** A Python environment of its own, made by uv, with `packages` in it. */
function pythonEnv(dir: string, packages: string[], label: string, mb: number): Component {
  return {
    label,
    mb,
    installed: () => fs.existsSync(path.join(dir, 'env', INSTALLED)),
    install: async (log) => {
      fs.mkdirSync(dir, { recursive: true });
      await exec('uv', ['venv', '--quiet', '--allow-existing', '--python', '3.12', path.join(dir, 'env')], log);
      await exec('uv', ['pip', 'install', '--python', envPython(dir), ...packages], log);
      fs.writeFileSync(path.join(dir, 'env', INSTALLED), `${packages.join(' ')}\n`);
    },
  };
}

async function download(url: string, file: string, log: (line: string) => void) {
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
}

/** The names of what a voice needs, in the narration language: the settings show them as missing. */
const PART_WORDS: Record<NarrationLanguage, { piperVoice: (name: string) => string; model: (repo: string) => string }> = {
  de: { piperVoice: (name) => `Piper-Stimme ${name}`, model: (repo) => `Modell ${repo}` },
  en: { piperVoice: (name) => `Piper voice ${name}`, model: (repo) => `Model ${repo}` },
};

/** What the voice of these settings needs installed; empty for a voice that needs nothing from Obeya. */
export function components(s: DemoSettings, home = obeyaHome()): Component[] {
  if (s.voice === 'piper') {
    const dir = path.join(voicesHome(home), 'piper');
    const voice = piperVoice(s);
    const onnx = path.join(dir, `${voice.name}.onnx`);
    return [
      pythonEnv(dir, ['piper-tts'], 'Piper', 150),
      {
        label: PART_WORDS[s.language].piperVoice(voice.name),
        mb: 115,
        installed: () => fs.existsSync(onnx) && fs.existsSync(`${onnx}.json`),
        install: async (log) => {
          await download(`${voice.url}.json`, `${onnx}.json`, log);
          await download(voice.url, onnx, log);
        },
      },
    ];
  }
  if (s.voice === 'qwen3') {
    const dir = path.join(voicesHome(home), 'qwen3');
    const repo = qwen3Model(!!s.reference);
    return [
      onMlx() ? pythonEnv(dir, ['mlx-audio'], 'Qwen3-TTS (MLX)', 450) : pythonEnv(dir, ['qwen-tts'], 'Qwen3-TTS (PyTorch)', 4000),
      {
        label: PART_WORDS[s.language].model(repo),
        mb: 4300,
        installed: () => hfModelPresent(repo),
        install: (log) =>
          exec(envPython(dir), ['-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)})`], log),
      },
    ];
  }
  return [];
}

/** Whether the voice can speak without installing anything more, and how much is missing. */
export function installState(s: DemoSettings, home = obeyaHome()) {
  const missing = components(s, home).filter((c) => !c.installed());
  return { installed: !missing.length, missing: missing.map((c) => c.label), mb: missing.reduce((n, c) => n + c.mb, 0) };
}

/** Installs what the voice is missing, one part after the other. */
export async function installVoice(s: DemoSettings, log: (line: string) => void = () => {}, home = obeyaHome()) {
  for (const c of components(s, home)) {
    if (c.installed()) continue;
    log(`installing ${c.label} (about ${c.mb} MB)`);
    await c.install(log);
  }
}

/** `qwen3.py` for a clone of `reference` or a stock `speaker`, before `--out` or `--serve`. */
function qwen3Command(voice: HeldVoice, language: NarrationLanguage, home: string) {
  const who = voice.reference ? ['--reference', voice.reference] : ['--speaker', voice.speaker || QWEN3_SPEAKER];
  return [envPython(path.join(voicesHome(home), 'qwen3')), lib('qwen3.py'), '--model', qwen3Model(!!voice.reference), '--language', language, ...who];
}

/** The command Obeya holds a Qwen3 voice with across renders (`src/server/narration.ts`). */
export const qwen3Serve = (voice: HeldVoice, language: NarrationLanguage, home = obeyaHome()) => [...qwen3Command(voice, language, home), '--serve'];

/** The spec `tts.py` synthesises the voice of these settings with. */
export function voiceSpec(s: DemoSettings, home = obeyaHome()): VoiceSpec {
  const keyFile = s.keyFile ? expandHome(s.keyFile) : undefined;
  switch (s.voice) {
    case 'piper': {
      const { python, onnx } = piperFiles(s, home);
      return { kind: 'command', argv: [python, '-m', 'piper', '-m', onnx, '-f', '{out}'], tag: `piper|${piperVoice(s).name}`, heavy: false };
    }
    case 'qwen3': {
      const reference = s.reference && expandHome(s.reference);
      const voice = reference ? { reference } : { speaker: s.voiceName || QWEN3_SPEAKER };
      const run = qwen3Command(voice, s.language, home);
      return {
        kind: 'command',
        argv: [...run, '--out', '{out}'],
        serve: [...run, '--serve'],
        host: voice,
        tag: `qwen3|${qwen3Model(!!reference)}|${reference ?? s.voiceName ?? QWEN3_SPEAKER}`,
        heavy: true,
      };
    }
    case 'say': {
      const voice = s.voiceName || SAY_VOICES[s.language];
      return { kind: 'command', argv: ['say', '-v', voice, '-o', '{out}', '--file-format=WAVE', '--data-format=LEI16@24000', '-f', '-'], tag: `say|${voice}`, heavy: false };
    }
    case 'command':
      // The owner's command may load a large model (a clone does), so it takes the machine's turn.
      return { kind: 'command', shell: s.command ?? '', tag: `command|${s.command ?? ''}`, heavy: true };
    case 'http':
      return { kind: 'http', service: 'http', url: s.url, keyFile };
    default:
      return { kind: 'http', service: s.voice, url: s.url, voiceName: s.voiceName, keyFile };
  }
}

/** The environment variable a service reads its key from before the key file. */
export const KEY_ENV: Record<(typeof SERVICES)[number] | 'http', string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  azure: 'AZURE_SPEECH_KEY',
  http: 'DEMO_TTS_API_KEY',
};

/** A sentence to hear a voice by in the settings, in the narration language. */
export const SAMPLE_TEXT: Record<NarrationLanguage, string> = {
  de: 'So klingt diese Stimme in einer Demo: Die Karte zeigt jetzt den Link, und ein Klick öffnet die Seite.',
  en: 'This is how the voice sounds in a demo: the card now shows the link, and one click opens the page.',
};

/**
 * Synthesises one sample with `tts.py`, without listening back, into `out`. For the settings
 * sheet, so the owner hears a voice before choosing it; with `obeyaUrl`, Obeya holds a voice that
 * can stay loaded, so the next sample (and the next render) skips loading it. A heavy voice waits
 * for `lock`, the machine's TTS_LOCK unless a test gives its own.
 */
export function sample(s: DemoSettings, out: string, home = obeyaHome(), obeyaUrl?: string, lockFile = TTS_LOCK): Promise<void> {
  const spec = voiceSpec(s, home);
  const specFile = `${out}.spec.json`;
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const lock = spec.kind === 'command' && spec.heavy ? ['--lock', lockFile] : [];
  const args = ['run', '--quiet', '--no-project', 'python', lib('tts.py'), ...lock, '--sample', specFile, s.language, SAMPLE_TEXT[s.language], out];
  return exec('uv', args, () => {}, obeyaUrl ? { OBEYA_URL: obeyaUrl } : undefined).finally(() => fs.rmSync(specFile, { force: true }));
}

/**
 * One large model loaded by a render at a time on the machine: each loaded a voice model (and the
 * render Whisper, 7–12 GB in all), and parallel demos from several agents swapped the machine to a
 * halt. `tts.py --lock` holds it (flock, on Windows a byte-range lock) from the moment it loads a
 * model itself: at once for a voice it runs, but for a voice Obeya holds only once Whisper is to
 * listen back, so parallel renders synthesise turn by turn through Obeya and listen one after the
 * other. The system drops the lock when its holder dies, so no stale lock survives a crash.
 */
export const TTS_LOCK = path.join(os.homedir(), '.cache', 'demo-skill', 'tts.lock');

if (isMain(import.meta.filename)) {
  const s = readDemoSettings();
  const state = installState(s);
  if (process.argv[2] === 'install') {
    await installVoice(s, (line) => console.log(line));
    console.log(`${s.voice}: installed`);
  } else {
    console.log(state.installed ? `${s.voice}: ready` : `${s.voice}: missing ${state.missing.join(', ')} (about ${state.mb} MB); run \`node voices.ts install\``);
  }
}
