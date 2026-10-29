// Light or dark as the owner chose in the settings, else as the system: the stylesheets read it from
// `data-theme` on the page's root (styles.css), so a choice applies without loading again.
// A page loads it together with its language before it first renders.

import { FALLBACK_LANGUAGE, languageOf } from '../core/locale';
import type { Theme } from '../core/types';
import { api, markQuiet } from './api';
import { setLanguage } from './strings';

export function applyTheme(theme: Theme | null) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/** The owner's choice from the server; one that does not answer leaves the system's. */
const loadTheme = () => api.theme().then((v) => applyTheme(v.chosen), () => {});

/**
 * The language and the look first, from the server (the owner's choice, else the system's), so a
 * page's first render is in them; a server that does not answer leaves the browser's, also one that
 * answers nothing within 3 s (a machine asleep, reached from the phone's home screen).
 */
export async function loadLanguageAndTheme() {
  const browser = languageOf(navigator.language) ?? FALLBACK_LANGUAGE;
  const [language] = await Promise.race([
    Promise.all([api.language().then((l) => l.language, () => browser), loadTheme()]),
    new Promise<[typeof browser]>((done) =>
      setTimeout(() => {
        markQuiet();
        done([browser]);
      }, 3000),
    ),
  ]);
  setLanguage(language);
}
