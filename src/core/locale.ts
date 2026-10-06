/** The languages Obeya speaks; the owner chooses one in the settings, else the system's applies. */
export const LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Obeya's language for a system with a language it does not speak. */
export const FALLBACK_LANGUAGE: Language = 'en';

/** The language a locale names (`de_DE.UTF-8`, `en-GB`, `de`), if Obeya speaks it. */
export function languageOf(locale: string | null | undefined): Language | undefined {
  const code = locale?.trim().toLowerCase().split(/[-_.@]/)[0];
  return LANGUAGES.find((l) => l === code);
}

/** A language's name as a prompt tells an agent which one to write the owner in. */
export const LANGUAGE_NAMES: Record<Language, string> = { de: 'German', en: 'English' };
