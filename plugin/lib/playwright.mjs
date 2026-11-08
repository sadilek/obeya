// Playwright for a worker's script of its own, as the browser skill's `playwright` names it: the
// `playwright-core` found up the tree from here, whose browsers play no sound through the machine's
// speakers. Chromium starts with `--mute-audio` (Playwright's default, kept when a script drops the
// defaults with `ignoreDefaultArgs`), Firefox with its volume at zero; WebKit has no such switch, so every page of every engine also gets `silent-media.js` (its media muted, Web Audio at
// zero gain) and `silent-speech.js` (its speechSynthesis speaks nothing: no engine mutes that).
// A launched Chromium closes within seconds, as the plugin's own does (`closingQuickly`). `node`
// (22.18 or newer, which strips the types of `chromium.ts`) and `bun` import it from anywhere.

import { join } from 'node:path';
import playwright from 'playwright-core';
import { closingQuickly } from './chromium.ts';

export * from 'playwright-core';

const SCRIPTS = ['silent-speech.js', 'silent-media.js'].map((name) => join(import.meta.dirname, name));

/** The launch options of `engine` with its switch that mutes the browser, where it has one. */
function muting(engine, options = {}) {
  if (engine === 'chromium') return { ...options, args: [...(options.args ?? []), '--mute-audio'] };
  if (engine === 'firefox') return { ...options, firefoxUserPrefs: { ...options.firefoxUserPrefs, 'media.volume_scale': '0.0' } };
  return options;
}

const silenced = new WeakSet();

/** Gives the context's pages, and every frame in them, the silencing scripts before their own. */
async function silentContext(context) {
  if (silenced.has(context)) return context;
  silenced.add(context);
  for (const path of SCRIPTS) await context.addInitScript({ path });
  return context;
}

/** The browser's contexts, those it has and those it makes (`newPage` makes one through `newContext`). */
async function silentBrowser(browser) {
  for (const context of browser.contexts()) await silentContext(context);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => silentContext(await newContext(...args));
  return browser;
}

/** `chromium`, `firefox` or `webkit`, whose browsers, launched or connected to, stay silent. */
function silentType(type) {
  const engine = type.name();
  const wrapped = {
    launch: async (options) => {
      const browser = await type.launch(muting(engine, options));
      return silentBrowser(engine === 'chromium' ? await closingQuickly(browser) : browser);
    },
    launchPersistentContext: async (dir, options) => silentContext(await type.launchPersistentContext(dir, muting(engine, options))),
    launchServer: (options) => type.launchServer(muting(engine, options)),
    connect: async (...args) => silentBrowser(await type.connect(...args)),
    connectOverCDP: async (...args) => silentBrowser(await type.connectOverCDP(...args)),
  };
  return new Proxy(type, {
    get(target, key) {
      if (Object.hasOwn(wrapped, key)) return wrapped[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const chromium = silentType(playwright.chromium);
export const firefox = silentType(playwright.firefox);
export const webkit = silentType(playwright.webkit);
export default { ...playwright, chromium, firefox, webkit };
