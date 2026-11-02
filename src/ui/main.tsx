import { createRoot } from 'react-dom/client';
import { App } from './App';
import { upgradeAddress } from './address';
import { handOver, takeHandOver } from './api';
import { takeAppDrops } from './appDrop';
import { loadLanguageAndTheme } from './theme';

upgradeAddress();
await loadLanguageAndTheme();
if (window.obeyaApp) window.obeyaHandOver = handOver;
if (window.obeyaApp?.handedOver) await takeHandOver();
takeAppDrops();
createRoot(document.getElementById('root')!).render(<App />);
