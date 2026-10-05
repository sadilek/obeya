// The demo settings: in which language a demo is narrated and by which voice, so the person it
// speaks in follows. Obeya's settings sheet edits them; they live in `demo.json` under Obeya's home
// (`OBEYA_HOME`, else `~/.obeya`), where a session without Obeya finds them as well. Missing
// entries take the defaults.
//
// Run on its own (`node settings.ts`), it prints the settings in effect for the agent writing a
// demo's narration. Plain Node with type stripping, like the director: no imports without
// extensions, no Bun APIs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NARRATION_LANGUAGES = ['de', 'en'] as const;
export type NarrationLanguage = (typeof NARRATION_LANGUAGES)[number];
/**
 * The voice providers (`voices.ts` turns each into what `tts.py` runs). Local models Obeya
 * installs on request (`piper`, the default, and `qwen3`), macOS `say`, the owner's own command or
 * HTTP endpoint, and templates for four hosted services.
 */
export const VOICES = ['piper', 'qwen3', 'say', 'command', 'http', 'gemini', 'openai', 'elevenlabs', 'azure'] as const;
export type VoiceKind = (typeof VOICES)[number];
/** The hosted services `tts.py` has a template for. */
export const SERVICES = ['gemini', 'openai', 'elevenlabs', 'azure'] as const satisfies readonly VoiceKind[];

export interface DemoSettings {
  /** Language of the narration, its captions and the report page. */
  language: NarrationLanguage;
  /** Who speaks: one of `VOICES`. */
  voice: VoiceKind;
  /**
   * The voice is the owner's own (a clone behind a command, a cloned voice at a service), so the
   * narration speaks in the first person.
   */
  ownVoice?: boolean;
  /** `command`: run through the shell, the text on stdin; it writes the WAV to `$DEMO_WAV`. */
  command?: string;
  /** `http`: the endpoint; `openai`: another base URL; `azure`: the region or the endpoint. */
  url?: string;
  /** Which of the provider's voices: a Piper voice, a Qwen3 speaker, a `say` voice, a service's voice. */
  voiceName?: string;
  /** `qwen3`: a clip to clone (`.wav`, its exact transcript beside it as `.txt`) instead of a speaker. */
  reference?: string;
  /** A service's API key, in a file; the service's environment variable takes precedence. */
  keyFile?: string;
  /**
   * `false`: the clips are not heard back with Whisper, so they go unchecked (and the report says
   * so). For a machine where Whisper is too slow or too large. Absent means on.
   */
  listenBack?: false;
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = { language: 'de', voice: 'piper' };
export const DEMO_SETTINGS_FILE = 'demo.json';

/** Obeya's home, where its settings live. */
export function obeyaHome(): string {
  return process.env.OBEYA_HOME || path.join(os.homedir(), '.obeya');
}

export const expandHome = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir());

const TEXT_FIELDS = ['command', 'url', 'voiceName', 'reference', 'keyFile'] as const;

/**
 * Keeps what is a valid setting, drops the rest; trims texts and leaves out empty ones. Settings
 * from before the providers (`clone` with a voice project, `gemini` with `geminiKeyFile`) carry
 * over as far as they can: the clone becomes the owner's own command, still to be written.
 */
export function tidyDemoSettings(input: unknown): DemoSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const language = NARRATION_LANGUAGES.find((l) => l === o.language) ?? DEFAULT_DEMO_SETTINGS.language;
  const legacyClone = o.voice === 'clone';
  const voice = legacyClone ? 'command' : (VOICES.find((v) => v === o.voice) ?? DEFAULT_DEMO_SETTINGS.voice);
  const out: DemoSettings = { language, voice };
  if (o.ownVoice === true || legacyClone) out.ownVoice = true;
  if (o.listenBack === false) out.listenBack = false;
  for (const k of TEXT_FIELDS) {
    const v = str(o[k]);
    if (v) out[k] = v;
  }
  if (!out.keyFile && voice === 'gemini' && str(o.geminiKeyFile)) out.keyFile = str(o.geminiKeyFile);
  return out;
}

/** The settings as saved, or the defaults where nothing is. */
export function readDemoSettings(home = obeyaHome()): DemoSettings {
  const file = path.join(home, DEMO_SETTINGS_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_DEMO_SETTINGS };
  try {
    return tidyDemoSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_DEMO_SETTINGS };
  }
}

export function writeDemoSettings(settings: DemoSettings, home = obeyaHome()) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, DEMO_SETTINGS_FILE), `${JSON.stringify(tidyDemoSettings(settings), null, 2)}\n`);
}

/**
 * The settings with the voice of one render: `DEMO_VOICE` names a provider (its other settings
 * as saved) or a `.wav` to clone with Qwen3-TTS.
 */
export function withVoice(s: DemoSettings, voice: string | undefined): DemoSettings {
  if (!voice || voice === s.voice) return s;
  if (voice.endsWith('.wav')) return { language: s.language, voice: 'qwen3', reference: voice, ...(s.listenBack === false && { listenBack: false }) };
  const kind = VOICES.find((v) => v === voice);
  if (!kind) throw new Error(`unknown voice "${voice}"; use ${VOICES.join(', ')} or a .wav`);
  // another provider is not the owner's own voice just because the saved one is
  const { ownVoice: _, ...rest } = s;
  return { ...rest, voice: kind };
}

/**
 * The narration speaks in the first person only in the owner's own voice; any other voice
 * presents the work without an "I".
 */
export const narrationPerson = (s: Pick<DemoSettings, 'ownVoice'>): 'first' | 'third' => (s.ownVoice ? 'first' : 'third');

const LANGUAGE_NAMES: Record<NarrationLanguage, string> = { de: 'German', en: 'English' };

/** What the agent writing a narration needs to know, in a few lines. */
export function describeDemoSettings(saved: DemoSettings, override: string | undefined = process.env.DEMO_VOICE): string {
  const s = withVoice(saved, override);
  const person = narrationPerson(s);
  return [
    `language: ${s.language} — write every \`say\` text, the chapter titles and the report in ${LANGUAGE_NAMES[s.language]}`,
    person === 'first'
      ? `person: first — the voice is the owner's own, so the narration speaks as the owner ("I added …")`
      : `person: third — the voice is not the owner's, so the narration presents the work without "I" or "we" ("The card now shows …")`,
    `voice: ${s.voice}${s.voiceName ? ` (${s.voiceName})` : ''}${s.reference ? ` (clone of ${s.reference})` : ''}`,
    `listening back: ${s.listenBack === false ? 'off — the clips go unchecked; say so in the report\'s findings' : 'on, with Whisper'}`,
    `from: ${path.join(obeyaHome(), DEMO_SETTINGS_FILE)}${override ? ' (voice from DEMO_VOICE)' : ''}`,
  ].join('\n');
}

if (import.meta.filename === process.argv[1] || (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename)) {
  console.log(describeDemoSettings(readDemoSettings()));
}
