import { createRoot } from 'react-dom/client';
import { FALLBACK_LANGUAGE, languageOf } from '../core/locale';
import { api } from './api';
import { App } from './App';
import { setLanguage } from './strings';

// the language first, from the server (the owner's choice, else the system's), so the first
// render is in it; a server that does not answer leaves the browser's
const language = await api.language().then(
  (l) => l.language,
  () => languageOf(navigator.language) ?? FALLBACK_LANGUAGE,
);
setLanguage(language);
createRoot(document.getElementById('root')!).render(<App />);
