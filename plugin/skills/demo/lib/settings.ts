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
export const VOICES = ['clone', 'gemini'] as const;
export type VoiceKind = (typeof VOICES)[number];

export interface DemoSettings {
  /** Language of the narration, its captions and the report page. */
  language: NarrationLanguage;
  /**
   * Who speaks: `clone` is the owner's own voice, cloned on-device by `voiceProject`; `gemini` a
   * stock voice of Google's Gemini TTS.
   */
  voice: VoiceKind;
  /**
   * A uv project whose environment runs the narration: it carries the clone (`avatar.config`
   * names model and reference clip, `avatar.tts` synthesises) and Whisper for listening back.
   * Needed for `clone`; without it a stock voice is listened back in a throwaway environment.
   */
  voiceProject?: string;
  /** File holding the Gemini API key; `GEMINI_API_KEY` in the environment takes precedence. */
  geminiKeyFile?: string;
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = { language: 'de', voice: 'gemini' };
export const DEMO_SETTINGS_FILE = 'demo.json';

/** Obeya's home, where its settings live. */
export function obeyaHome(): string {
  return process.env.OBEYA_HOME || path.join(os.homedir(), '.obeya');
}

export const expandHome = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir());

/** Keeps what is a valid setting, drops the rest; trims paths and leaves out empty ones. */
export function tidyDemoSettings(input: unknown): DemoSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const language = NARRATION_LANGUAGES.find((l) => l === o.language) ?? DEFAULT_DEMO_SETTINGS.language;
  const voice = VOICES.find((v) => v === o.voice) ?? DEFAULT_DEMO_SETTINGS.voice;
  const voiceProject = str(o.voiceProject);
  const geminiKeyFile = str(o.geminiKeyFile);
  return { language, voice, ...(voiceProject ? { voiceProject } : {}), ...(geminiKeyFile ? { geminiKeyFile } : {}) };
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
 * The narration speaks in the first person only in the owner's own voice; any other voice
 * presents the work without an "I".
 */
export const narrationPerson = (voice: string): 'first' | 'third' => (voice === 'clone' ? 'first' : 'third');

const LANGUAGE_NAMES: Record<NarrationLanguage, string> = { de: 'German', en: 'English' };

/** What the agent writing a narration needs to know, in a few lines. */
export function describeDemoSettings(s: DemoSettings, voice: string = process.env.DEMO_VOICE || s.voice): string {
  const person = narrationPerson(voice);
  return [
    `language: ${s.language} — write every \`say\` text, the chapter titles and the report in ${LANGUAGE_NAMES[s.language]}`,
    person === 'first'
      ? `person: first — the voice is the owner's own clone, so the narration speaks as the owner ("I added …")`
      : `person: third — the voice is not the owner's, so the narration presents the work without "I" or "we" ("The card now shows …")`,
    `voice: ${voice}${voice === 'clone' ? ` (project ${s.voiceProject ?? 'not set: configure voiceProject'})` : ''}`,
    `from: ${path.join(obeyaHome(), DEMO_SETTINGS_FILE)}${process.env.DEMO_VOICE ? ' (voice from DEMO_VOICE)' : ''}`,
  ].join('\n');
}

if (import.meta.filename === process.argv[1] || (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename)) {
  console.log(describeDemoSettings(readDemoSettings()));
}
