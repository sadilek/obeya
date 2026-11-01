// The demo settings: in which language a demo is narrated and by which voice (or none, for a demo
// that only shows subtitles), so the person it speaks in follows, in which further languages its
// subtitles come, and the directory demos go into. Obeya's settings sheet edits them; they live in `demo.json` under Obeya's home
// (`OBEYA_HOME`, else `~/.obeya`), where a session without Obeya finds them as well. Missing
// entries take the defaults; the language without one is the owner's conversation language. A
// repository may name the language of its own demos (`demo.language` of its `.obeya/settings.json`):
// Obeya gives it to its workers as `DEMO_LANGUAGE`, and a session without Obeya finds it in the
// repository it runs in.
//
// Run on its own (`node settings.ts`), it prints the settings in effect for the agent writing a
// demo's narration. Plain Node with type stripping, like the director: no imports without
// extensions, no Bun APIs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './here.ts';
import { conversationLanguageIn } from './language.ts';
import { knownLanguage, type Language, LANGUAGE_NAMES, LANGUAGES } from './locale.ts';

/** The language a demo is narrated in: one Obeya speaks. */
export type NarrationLanguage = Language;
/**
 * The voice providers (`voices.ts` turns each into what `tts.py` runs). Local models Obeya
 * installs on request (`piper`, the default, and `qwen3`), macOS `say`, the owner's own command or
 * HTTP endpoint, and templates for four hosted services. `none`: no voice at all, a silent video
 * whose subtitles tell what the narration would; each scene lasts as long as its text takes to read.
 */
export const VOICES = ['none', 'piper', 'qwen3', 'say', 'command', 'http', 'gemini', 'openai', 'elevenlabs', 'azure'] as const;
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
  /**
   * `qwen3`: a clip to clone per narration language (`.wav`, its exact transcript beside it as
   * `.txt`) instead of a speaker. A clone speaks best in the language of its clip, so each language
   * has its own; one without a clip is spoken by a speaker.
   */
  references?: Partial<Record<NarrationLanguage, string>>;
  /** A service's API key, in a file; the service's environment variable takes precedence. */
  keyFile?: string;
  /** Where demos go, each into a directory of its own: an absolute path or one from `~`; `DEFAULT_DEMO_DIRECTORY` when left out. */
  directory?: string;
  /**
   * How many days after a demo's last render Obeya keeps the frames it was cut from (`.work/frames`),
   * which only re-voicing needs; `always` keeps them. Left out: Obeya's default (see `demo-space.ts`).
   */
  keepFrames?: number | 'always';
  /**
   * The languages a demo's subtitles come in beside the narration's (BCP 47 codes: `fr`, `pt-BR`),
   * each a caption track of its own, translated by the agent that renders it. The narration's
   * language is always one; left out or empty, it is the only one.
   */
  subtitles?: string[];
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = { language: 'de', voice: 'piper' };
export const DEMO_SETTINGS_FILE = 'demo.json';
export const DEFAULT_DEMO_DIRECTORY = '~/demos';

/** Obeya's home, where its settings live. */
export function obeyaHome(): string {
  return process.env.OBEYA_HOME || path.join(os.homedir(), '.obeya');
}

export const expandHome = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir());

/** Whether a demo directory names a place of its own: absolute, or from `~`; a relative one would land wherever the agent works. */
export const absoluteDirectory = (dir: string) => path.isAbsolute(expandHome(dir));

/** The directory demos go into on this machine: the settings', else `~/demos`; one that is not absolute counts as not set. */
export function demoDirectory(s: Pick<DemoSettings, 'directory'> = readDemoSettings()): string {
  return path.resolve(expandHome(s.directory && absoluteDirectory(s.directory) ? s.directory : DEFAULT_DEMO_DIRECTORY));
}

const TEXT_FIELDS = ['command', 'url', 'voiceName', 'keyFile', 'directory'] as const;

/**
 * Keeps what is a valid setting, drops the rest; trims texts and leaves out empty ones. The one clip
 * a file from before `references` names (`reference`) is the clip of its language.
 */
export function tidyDemoSettings(input: unknown, fallbackLanguage: NarrationLanguage = DEFAULT_DEMO_SETTINGS.language): DemoSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const language = LANGUAGES.find((l) => l === o.language) ?? fallbackLanguage;
  const voice = VOICES.find((v) => v === o.voice) ?? DEFAULT_DEMO_SETTINGS.voice;
  const out: DemoSettings = { language, voice };
  if (o.ownVoice === true) out.ownVoice = true;
  for (const k of TEXT_FIELDS) {
    const v = str(o[k]);
    if (v) out[k] = v;
  }
  const given = (o.references && typeof o.references === 'object' ? o.references : { [language]: o.reference }) as Record<string, unknown>;
  const references = Object.fromEntries(LANGUAGES.flatMap((l) => (str(given[l]) ? [[l, str(given[l])]] : [])));
  if (Object.keys(references).length) out.references = references;
  const subtitles = Array.isArray(o.subtitles) ? [...new Set(o.subtitles.flatMap((c) => (typeof c === 'string' && knownLanguage(c) ? [knownLanguage(c)!] : [])))] : [];
  if (subtitles.length) out.subtitles = subtitles;
  if (o.keepFrames === 'always' || (typeof o.keepFrames === 'number' && Number.isInteger(o.keepFrames) && o.keepFrames > 0)) out.keepFrames = o.keepFrames;
  return out;
}

/** The languages of a demo's caption tracks: the narration's first, then those the settings add. */
export const subtitleLanguages = (s: Pick<DemoSettings, 'language' | 'subtitles'>): string[] => [...new Set([s.language, ...(s.subtitles ?? [])])];

/** Whether a demo with these settings is silent: no voice, its subtitles alone tell what it shows. */
export const silent = (s: Pick<DemoSettings, 'voice'>) => s.voice === 'none';

/** The clip a Qwen3 voice clones for the narration language of these settings; none: a speaker. */
export const referenceOf = (s: Pick<DemoSettings, 'language' | 'references'>): string | undefined => s.references?.[s.language];

/** The settings as saved, or the defaults where nothing is: then the narration is in the owner's conversation language. */
export function readDemoSettings(home = obeyaHome()): DemoSettings {
  const file = path.join(home, DEMO_SETTINGS_FILE);
  const language = conversationLanguageIn(home);
  if (!fs.existsSync(file)) return { ...DEFAULT_DEMO_SETTINGS, language };
  try {
    return tidyDemoSettings(JSON.parse(fs.readFileSync(file, 'utf8')), language);
  } catch {
    return { ...DEFAULT_DEMO_SETTINGS, language };
  }
}

/** Where a repository's language for its demos comes from: Obeya, or the repository's own settings. */
export type LanguageSource = 'obeya' | 'repository';

/**
 * The language a repository names for its demos (`demo.language` of its settings): from Obeya,
 * which gives its workers the one of their card's repository as `DEMO_LANGUAGE`, else from the
 * `.obeya/settings.json` of the repository the directory `cwd` is in. None where neither names one.
 */
export function repositoryLanguage(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): { language: NarrationLanguage; from: LanguageSource; file?: string } | undefined {
  const given = LANGUAGES.find((l) => l === env.DEMO_LANGUAGE);
  if (given) return { language: given, from: 'obeya' };
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const file = path.join(dir, '.obeya', 'settings.json');
      try {
        const language = LANGUAGES.find((l) => l === (JSON.parse(fs.readFileSync(file, 'utf8')) as { demo?: { language?: unknown } }).demo?.language);
        return language ? { language, from: 'repository', file } : undefined;
      } catch {
        return undefined;
      }
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The settings of a demo of the repository: those saved, in the language the repository names for its demos, if it names one. */
export function inLanguage(s: DemoSettings, language: NarrationLanguage | undefined): DemoSettings {
  return language && language !== s.language ? { ...s, language } : s;
}

/** The settings a demo rendered here is narrated with: those saved, in the language of the repository (`repositoryLanguage`). */
export const demoSettingsHere = (home = obeyaHome()): DemoSettings => inLanguage(readDemoSettings(home), repositoryLanguage()?.language);

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
  if (voice.endsWith('.wav')) return { language: s.language, voice: 'qwen3', references: { [s.language]: voice } };
  const kind = VOICES.find((v) => v === voice);
  if (!kind) throw new Error(`unknown voice "${voice}"; use ${VOICES.join(', ')} or a .wav`);
  // another provider is not the owner's own voice just because the saved one is
  const { ownVoice: _, ...rest } = s;
  return { ...rest, voice: kind };
}

/**
 * The narration speaks in the first person only in the owner's own voice; any other voice
 * presents the work without an "I". A Qwen3 clone without a clip for the language speaks with a
 * stock speaker, which is nobody's own.
 */
export function narrationPerson(s: Partial<DemoSettings>): 'first' | 'third' {
  if (!s.ownVoice || s.voice === 'none') return 'third';
  return s.voice === 'qwen3' && !(s.language && s.references?.[s.language]) ? 'third' : 'first';
}

/** What the agent writing a narration needs to know, in a few lines; `repo` names the repository's language for its demos. */
export function describeDemoSettings(saved: DemoSettings, override: string | undefined = process.env.DEMO_VOICE, repo: ReturnType<typeof repositoryLanguage> = undefined): string {
  const s = withVoice(inLanguage(saved, repo?.language), override);
  const person = narrationPerson(s);
  const clip = referenceOf(s);
  return [
    `language: ${s.language} — write every \`say\` text, the chapter titles and the report in ${LANGUAGE_NAMES[s.language]}`,
    ...(repo?.from === 'repository'
      ? [`  (the repository's demo.language in ${repo.file}; render with DEMO_LANGUAGE=${repo.language} so the voice speaks it too)`]
      : repo
        ? [`  (the repository's demo.language, given by Obeya as DEMO_LANGUAGE)`]
        : []),
    person === 'first'
      ? `person: first — the voice is the owner's own, so the narration speaks as the owner ("I added …")`
      : `person: third — ${s.voice === 'none' ? 'no voice speaks' : "the voice is not the owner's"}, so the narration presents the work without "I" or "we" ("The card now shows …")`,
    s.voice === 'none'
      ? 'voice: none — a silent video with subtitles; each scene lasts as long as its text takes to read'
      : `voice: ${s.voice}${s.voiceName ? ` (${s.voiceName})` : ''}${clip ? ` (clone of ${clip})` : ''}`,
    `subtitles: ${subtitleLanguages(s).join(', ')}${subtitleLanguages(s).length > 1 ? ' — the render asks for a translation of the narration into each language but the first' : ''}`,
    `from: ${path.join(obeyaHome(), DEMO_SETTINGS_FILE)}${override ? ' (voice from DEMO_VOICE)' : ''}`,
    `directory: ${demoDirectory(saved)} — every demo goes into a directory of its own in it`,
  ].join('\n');
}

if (isMain(import.meta.filename)) {
  console.log(describeDemoSettings(readDemoSettings(), process.env.DEMO_VOICE, repositoryLanguage()));
}
