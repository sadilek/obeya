// The Chromium the plugin's skills drive: the demo skill records with it, the browser skill checks
// pages with it. Plain Node with type stripping, like the skills that import it; importing this
// module is what resolves Playwright, found up the tree from here (the checkout's node_modules, or
// the one beside the plugin among Obeya's resources and on a host).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

/** The init script every page of it gets: its `speechSynthesis` speaks nothing (`silent-speech.js`). */
export const SILENT_SPEECH = join(import.meta.dirname, 'silent-speech.js');

/**
 * Chromium launched by Playwright: `DEMO_CHROME` when set (the path of any Chromium-based browser),
 * else Chrome where it is installed, else Edge (on every Windows), else Playwright's own Chromium
 * (on Linux on ARM, where there is no Chrome). It shows scrollbars as the machine's browser does
 * (Playwright's headless launch hid them): classic ones on Windows and Linux, on a Mac set to
 * overlay scrollbars a bar that shows while a box scrolls and fades a second later. Its `close`
 * returns within seconds (`closingQuickly`).
 */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const ignored = Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : [];
  if (options.ignoreDefaultArgs !== true) options = { ...options, ignoreDefaultArgs: [...ignored, '--hide-scrollbars'] };
  if (process.env.DEMO_CHROME) return closingQuickly(await chromium.launch({ ...options, executablePath: process.env.DEMO_CHROME }));
  const missing: string[] = [];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return closingQuickly(await chromium.launch({ ...options, channel }));
    } catch (error) {
      const message = String((error as Error).message);
      if (!/is not found at|Executable doesn't exist|not supported on/i.test(message)) throw error;
      missing.push(channel ?? 'chromium');
    }
  }
  throw new Error(
    `no browser (tried ${missing.join(', ')}): install Google Chrome, or run \`npx playwright-core install --with-deps chromium\` in ${join(import.meta.dirname, '..', '..')}, or set DEMO_CHROME to a Chromium-based browser`,
  );
}

/** How long a closing browser has for its orderly shutdown before it is killed. */
export const CLOSE_GRACE_MS = 2000;

/**
 * Chrome's orderly shutdown hung on a busy Mac until its own teardown watchdog ended it ten
 * seconds later (Chrome 156, 2026-11-03), and Playwright's `close` waited for it. The profile is
 * temporary and nothing in it is kept, so after a short grace the browser's process tree is
 * killed: Playwright sees it exit, removes the profile and `close` returns.
 */
async function closingQuickly(browser: Browser): Promise<Browser> {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  const pid = processInfo.find((p) => p.type === 'browser')?.id;
  if (!pid) return browser;
  const close = browser.close.bind(browser);
  browser.close = async (options) => {
    const timer = setTimeout(() => killTree(pid), CLOSE_GRACE_MS);
    try {
      await close(options);
    } finally {
      clearTimeout(timer);
    }
  };
  return browser;
}

/** Kills a process and its children: on Windows with taskkill, elsewhere its process group (Playwright starts the browser in one of its own). */
function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
      return;
    } catch {
      // not a group of its own, or gone already
    }
  }
}
