// The language Obeya speaks to the owner: chosen in its settings sheet (`settings.json` under
// Obeya's home), else the system's. The server speaks it; a demo is narrated in it unless the demo
// settings name another. Plain Node, like the director: it runs without Obeya too.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_LANGUAGES = ['de', 'en'] as const;
export type OwnerLanguage = (typeof OWNER_LANGUAGES)[number];

/** Obeya's language for a system with a language it does not speak. */
export const FALLBACK_OWNER_LANGUAGE: OwnerLanguage = 'en';

export const OWNER_SETTINGS_FILE = 'settings.json';

const languageIn = (locale: string | null | undefined): OwnerLanguage | undefined => {
  const code = locale?.trim().toLowerCase().split(/[-_.@]/)[0];
  return OWNER_LANGUAGES.find((l) => l === code);
};

/** The language the owner chose in the settings sheet, if they did. */
export function chosenLanguage(home: string): OwnerLanguage | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(home, OWNER_SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
    return OWNER_LANGUAGES.find((l) => l === o.language);
  } catch {
    return undefined;
  }
}

/**
 * The system's language. On a Mac the one its interface is in (`AppleLanguages`), which a server
 * started outside a terminal has no `LANG` for; elsewhere the locale variables, in the order POSIX
 * gives them, then what the runtime reports (Windows). A language Obeya does not speak gives the
 * fallback.
 */
export function systemLanguage(env: Record<string, string | undefined> = process.env, platform: string = process.platform, apple = appleLanguage): OwnerLanguage {
  const fromEnv = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && v !== 'C' && v !== 'POSIX' && !v.startsWith('C.'));
  const locale = (platform === 'darwin' ? apple() : undefined) ?? fromEnv ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return languageIn(locale) ?? FALLBACK_OWNER_LANGUAGE;
}

let apple: string | null | undefined;
/** The first of the Mac's preferred languages, read once. */
function appleLanguage(): string | undefined {
  if (apple === undefined) {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      apple = /"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?/.exec(out.replace(/^\s*\(/, ''))?.[1] ?? null;
    } catch {
      apple = null;
    }
  }
  return apple ?? undefined;
}

/** The language that applies: the owner's choice, else the system's. */
export const ownerLanguageIn = (home: string): OwnerLanguage => chosenLanguage(home) ?? systemLanguage();
