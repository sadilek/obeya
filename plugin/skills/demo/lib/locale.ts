// The languages Obeya speaks, to the owner and in a demo's narration. Without Node modules: the
// UI's bundle has them too (through `src/core/locale.ts`).

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

/**
 * A language code (BCP 47: `fr`, `pt-BR`, `sr-Latn`) as written canonically, if `Intl` knows the
 * language it names; undefined for one it does not (`xx`, `en-XX`) or a malformed one. A demo's
 * subtitles may be in any such language, not only those Obeya speaks.
 */
export function knownLanguage(code: string): string | undefined {
  try {
    const [tag] = Intl.getCanonicalLocales(code.trim());
    return tag && new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** A language's name for a captions menu, written in `in` (`fr` in German: „Französisch“); the code itself where `Intl` has no name. */
export function languageName(code: string, inLanguage: string): string {
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: 'language', fallback: 'none' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(inLanguage) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/**
 * Of a demo's caption tracks (their languages, the narration's first), the one to show without
 * being asked, for a viewer who prefers `preferred` (most preferred first): the first whose
 * language matches, by the language alone where no track has the very variant; else the narration's.
 */
export function preferredTrack(tracks: readonly string[], preferred: readonly string[]): string | undefined {
  const base = (l: string) => l.toLowerCase().split('-')[0];
  for (const p of preferred) {
    const exact = tracks.find((t) => t.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    const near = tracks.find((t) => base(t) === base(p));
    if (near) return near;
  }
  return tracks[0];
}
