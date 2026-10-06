// Obeya's own settings, in `settings.json` under its home beside `canvases.json` and `demo.json`:
// the language Obeya speaks to the owner. The owner chooses it in the settings sheet; until then
// the system's applies. Saving restarts nothing: the page loads again in the new language, and the
// server reads the file whenever it needs the language.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_SETTINGS_FILE, systemLanguage } from '../../plugin/skills/demo/lib/language.ts';
import { type Language, LANGUAGES } from '../core/locale';
import type { LanguageView } from '../core/types';
import { BadRequest } from './board';

export { systemLanguage };

export const SETTINGS_FILE = OWNER_SETTINGS_FILE;

interface Settings {
  language?: Language;
}

function read(home: string): Settings {
  try {
    const o = JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
    const language = LANGUAGES.find((l) => l === o.language);
    return { ...o, ...(language ? { language } : { language: undefined }) };
  } catch {
    return {};
  }
}

export function languageView(home: string, system = systemLanguage()): LanguageView {
  const chosen = read(home).language ?? null;
  return { file: join(home, SETTINGS_FILE), chosen, system, language: chosen ?? system };
}

/** The language that applies: the owner's choice, else the system's. */
export const ownerLanguage = (home: string) => languageView(home).language;

/** Saves the owner's choice; `null` follows the system again. Other settings in the file stay. */
export function saveLanguage(home: string, input: unknown): LanguageView {
  const language = (input as { language?: unknown } | null)?.language;
  if (language !== null && !LANGUAGES.some((l) => l === language)) throw new BadRequest('invalid', `language must be one of ${LANGUAGES.join(', ')} or null`);
  const { language: _, ...rest } = existsSync(join(home, SETTINGS_FILE)) ? read(home) : {};
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, SETTINGS_FILE), `${JSON.stringify(language ? { ...rest, language } : rest, null, 2)}\n`);
  console.log(`Obeya: language ${language ?? 'of the system'} saved to ${join(home, SETTINGS_FILE)}`);
  return languageView(home);
}
