// Checks on a real phone browser: Chrome in the Android emulator, driven from the shell, for what
// headless Chromium can't reproduce (the on-screen keyboard and `visualViewport`, video fullscreen,
// screen rotation). Every wait inside is bounded and ends with an error that says what it waited
// for, so callers write no sleep loops of their own.
//
//   bun scripts/android-phone.ts start [--avd <name>] [--serial <device>] [--window] [--timeout <s>]
//   bun scripts/android-phone.ts open <url> [--timeout <s>]
//   bun scripts/android-phone.ts eval <js> [--timeout <s>]
//   bun scripts/android-phone.ts tap <selector> [--timeout <s>]
//   bun scripts/android-phone.ts type <text>
//   bun scripts/android-phone.ts rotate portrait|landscape
//   bun scripts/android-phone.ts screenshot <file.png>
//   bun scripts/android-phone.ts record start [<file.mp4>]
//   bun scripts/android-phone.ts record stop [<file.mp4>]
//   bun scripts/android-phone.ts stop
//
// The SDK is the one ANDROID_HOME or ANDROID_SDK_ROOT names, else Android Studio's default place
// (~/Library/Android/sdk, ~/Android/Sdk, %LOCALAPPDATA%\Android\Sdk); it needs `platform-tools`,
// `emulator` and an AVD with Chrome (a Google Play or Google APIs system image).
//
// `start` boots an emulator of the AVD (`--avd`, else the first one) in the background, headless
// unless `--window`, and waits until Android has booted (default up to 300 s: a fresh AVD boots
// cold). It boots it with -read-only, so that several checkouts can each run one of the same AVD
// at once: nothing the check does stays in the AVD. An AVD that already runs without -read-only
// (started by hand, say) can't be booted again; `--serial <device>` (as `adb devices` lists it)
// uses a running emulator or a phone on USB instead, shared with whoever else uses it, and `stop`
// leaves it running. Started again, `start` reuses the emulator this checkout started.
//
// `open` reaches a server on this machine as on localhost (`adb reverse` of the URL's port),
// opens the URL in Chrome as its only tab and waits until the page has loaded and stayed (a
// sign-in link's redirect followed; default up to 60 s). The first `open` on a device turns off
// what Chrome and Android lay over a page on their own (first-run screens, the notification
// prompt, the offers to translate or install the page, the hint at the first fullscreen): Chrome
// as the debug app reads /data/local/tmp/chrome-command-line.
// `eval` runs JS in that page over the DevTools protocol (awaits promises; `await` works at the
// top) and prints the result as JSON, e.g. `eval 'visualViewport.height'`.
// `tap` taps the centre of the first element the selector matches (scrolled into view, once it has
// stopped moving) as a real touch through `adb shell input tap`, so the on-screen keyboard and the
// APIs that need a user's gesture (fullscreen) behave as on a phone. Where the page lies on the
// screen comes from the device's view hierarchy (`uiautomator dump`, about a second). The keyboard
// takes a moment to open: on a text field, `tap` returns once it is open and the page has settled
// around it.
// `type` types into the focused element: ASCII as key presses (`input text`), a newline as Enter,
// other characters (umlauts) inserted as the keyboard's input method would (`Input.insertText`).
// `rotate` turns the emulator's acceleration sensor, as a hand turns the phone (on a USB phone it
// sets the rotation), and waits until the screen and the page have turned.
// `screenshot` writes the device's screen as PNG, `record start` records it until `record stop`,
// which writes the MP4 (taps show as dots in both, on an emulator `start` booted).
// `stop` shuts down the emulator `start` booted and removes the port forwards.
//
// What this checkout's commands share (the device, its DevTools port, the open page, a recording)
// is kept in <tmp>/obeya-android-phone-<user>/<hash of the checkout>.json.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { alive } from './common';

export type Command =
  | { cmd: 'start'; avd?: string; serial?: string; window: boolean; timeout: number }
  | { cmd: 'open'; url: string; timeout: number }
  | { cmd: 'eval'; js: string; timeout: number }
  | { cmd: 'tap'; selector: string; timeout: number }
  | { cmd: 'type'; text: string }
  | { cmd: 'rotate'; to: 'portrait' | 'landscape' }
  | { cmd: 'screenshot'; file: string }
  | { cmd: 'record'; action: 'start' | 'stop'; file?: string }
  | { cmd: 'stop' };

/** A mistake on the command line or a missing precondition: printed as it is, without a trace. */
export class Fail extends Error {}

const USAGE = `usage: bun scripts/android-phone.ts <command>
  start [--avd <name>] [--serial <device>] [--window] [--timeout <s>]
  open <url> [--timeout <s>]
  eval <js> [--timeout <s>]
  tap <selector> [--timeout <s>]
  type <text>
  rotate portrait|landscape
  screenshot <file.png>
  record start [<file.mp4>] | record stop [<file.mp4>]
  stop`;

/** Seconds a command waits by default before it gives up. */
const DEFAULT_TIMEOUT = { start: 300, open: 60, eval: 30, tap: 30 } as const;

/** The command line, checked: a Fail with the usage for anything it can't take. */
export function parseArgs(argv: string[]): Command {
  const flags = new Set(['window']);
  const valued = new Set(['avd', 'serial', 'timeout']);
  const pos: string[] = [];
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    const name = a.startsWith('--') ? a.slice(2) : undefined;
    if (name && flags.has(name)) o[name] = true;
    else if (name && valued.has(name)) {
      const v = argv[++i];
      if (v === undefined) throw new Fail(`--${name} needs a value\n${USAGE}`);
      o[name] = v;
    } else if (name && /^[a-z]/.test(name)) throw new Fail(`unknown option --${name}\n${USAGE}`);
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  const allow = (...names: string[]) => {
    const extra = Object.keys(o).find((k) => !names.includes(k));
    if (extra) throw new Fail(`${cmd} takes no --${extra}\n${USAGE}`);
  };
  const count = (n: number, what: string) => {
    if (rest.length !== n) throw new Fail(`${cmd} needs ${what}\n${USAGE}`);
  };
  const timeout = (fallback: number) => {
    if (o.timeout === undefined) return fallback;
    const s = Number(o.timeout);
    if (!(s > 0) || !Number.isFinite(s)) throw new Fail(`--timeout takes seconds, not ${o.timeout}`);
    return s;
  };
  switch (cmd) {
    case 'start':
      allow('avd', 'serial', 'window', 'timeout');
      count(0, 'no arguments');
      if (o.avd && o.serial) throw new Fail('start takes --avd or --serial, not both');
      return {
        cmd,
        avd: o.avd as string | undefined,
        serial: o.serial as string | undefined,
        window: o.window === true,
        timeout: timeout(DEFAULT_TIMEOUT.start),
      };
    case 'open': {
      allow('timeout');
      count(1, 'a URL');
      const url = rest[0]!;
      if (!/^https?:\/\//.test(url) || !URL.canParse(url)) throw new Fail(`open takes an http(s) URL, not ${url}`);
      return { cmd, url, timeout: timeout(DEFAULT_TIMEOUT.open) };
    }
    case 'eval':
      allow('timeout');
      count(1, 'the JS to run, as one argument');
      return { cmd, js: rest[0]!, timeout: timeout(DEFAULT_TIMEOUT.eval) };
    case 'tap':
      allow('timeout');
      count(1, 'a CSS selector, as one argument');
      return { cmd, selector: rest[0]!, timeout: timeout(DEFAULT_TIMEOUT.tap) };
    case 'type':
      allow();
      count(1, 'the text, as one argument');
      if (!rest[0]) throw new Fail('type needs some text');
      return { cmd, text: rest[0] };
    case 'rotate': {
      allow();
      count(1, 'portrait or landscape');
      const to = rest[0];
      if (to !== 'portrait' && to !== 'landscape') throw new Fail(`rotate takes portrait or landscape, not ${to}`);
      return { cmd, to };
    }
    case 'screenshot':
      allow();
      count(1, 'a file to write');
      return { cmd, file: rest[0]! };
    case 'record': {
      allow();
      const [action, file, ...more] = rest;
      if ((action !== 'start' && action !== 'stop') || more.length) throw new Fail(`record takes start or stop and a file\n${USAGE}`);
      return { cmd, action, file };
    }
    case 'stop':
      allow();
      count(0, 'no arguments');
      return { cmd };
    default:
      throw new Fail(cmd ? `unknown command ${cmd}\n${USAGE}` : USAGE);
  }
}

/** What the page says of a point on it: CSS pixels of the layout viewport, as getBoundingClientRect gives them. */
export interface PagePoint {
  x: number;
  y: number;
  dpr: number;
  /** The visual viewport: its offset into the layout viewport and its height (CSS px), its pinch zoom. */
  vv: { left: number; top: number; height: number; scale: number };
}

/** A rectangle on the device's screen, in its pixels as the current rotation lays them out. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where a point of the page lies on the screen, given where the page's visible area lies there. */
export function toDevice(p: PagePoint, page: ScreenRect) {
  const f = p.dpr * p.vv.scale;
  return { x: Math.round(page.left + (p.x - p.vv.left) * f), y: Math.round(page.top + (p.y - p.vv.top) * f) };
}

const nodeBounds = (node: string): ScreenRect | undefined => {
  const b = /\bbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(node);
  if (!b) return undefined;
  const [left, top, right, bottom] = b.slice(1).map(Number) as [number, number, number, number];
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
};
const area = (r: ScreenRect) => (r.right - r.left) * (r.bottom - r.top);

/**
 * The page's visible area in a `uiautomator dump`. Chrome shows web content as a WebView node (the
 * largest, if several), but not always: after the screen has turned it leaves it out for a while.
 * Then the area ends where Chrome's content view ends (above the keyboard, if open) and is as high
 * as the page's visual viewport (`p`), which lies under the toolbar.
 */
export function pageOnScreen(xml: string, p: PagePoint): ScreenRect | undefined {
  let best: ScreenRect | undefined;
  for (const m of xml.matchAll(/<node\b[^>]*\bclass="android\.webkit\.WebView"[^>]*>/g)) {
    const r = nodeBounds(m[0]);
    if (r && (!best || area(r) > area(best))) best = r;
  }
  if (best) return best;
  const holder = /<node\b[^>]*\bresource-id="[\w.]+:id\/compositor_view_holder"[^>]*>/.exec(xml);
  const content = holder && nodeBounds(holder[0]);
  if (!content) return undefined;
  const high = Math.round(p.vv.height * p.vv.scale * p.dpr);
  return { ...content, top: Math.max(content.top, content.bottom - high) };
}

/** `s` quoted for the device's shell, which `adb shell` hands its command line to. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** How `type` sends text: printable ASCII as key presses, a newline as Enter, anything else (and %) inserted. */
export type TextRun = { keys: string } | { enter: true } | { insert: string };

export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // `input text` reads %s as a space, so a % goes in with the rest
  for (const m of text.replaceAll('\r\n', '\n').matchAll(/([\x20-\x24\x26-\x7e]+)|(\n)|([^\x20-\x24\x26-\x7e\n]+)/g)) {
    if (m[1]) runs.push({ keys: m[1] });
    else if (m[2]) runs.push({ enter: true });
    else runs.push({ insert: m[3]! });
  }
  return runs;
}

/** The argument of `adb shell input text` for printable ASCII: a space as %s, quoted for the device's shell. */
export const inputTextArg = (keys: string) => shq(keys.replaceAll(' ', '%s'));

/** The emulator's acceleration sensor (x:y:z, m/s²) for a phone held upright or turned to the left. */
export const ACCELERATION = { portrait: '0:9.81:0', landscape: '9.81:0:0' } as const;

/** Where the SDK is: ANDROID_HOME, ANDROID_SDK_ROOT, then Android Studio's default place on this OS. */
export function sdkCandidates(env: Record<string, string | undefined>, platform: string, home: string): string[] {
  const defaults =
    platform === 'darwin'
      ? [join(home, 'Library', 'Android', 'sdk')]
      : platform === 'win32'
        ? [join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk')]
        : [join(home, 'Android', 'Sdk')];
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...defaults].filter((d): d is string => !!d);
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** adb and the emulator of the SDK on this machine, or a Fail that says what is missing and how to get it. */
export function findSdk(env = process.env, platform: string = process.platform, home = homedir()) {
  const tried = sdkCandidates(env, platform, home);
  const root = tried.find((d) => existsSync(d));
  if (!root)
    throw new Fail(
      `no Android SDK: set ANDROID_HOME to one (looked in ${tried.join(', ')}). Android Studio installs one; ` +
        'or the command-line tools: sdkmanager "platform-tools" "emulator" "system-images;android-35;google_apis_playstore;<x86_64|arm64-v8a>"',
    );
  const adb = join(root, 'platform-tools', exe('adb'));
  const emulator = join(root, 'emulator', exe('emulator'));
  for (const [tool, path, pkg] of [
    ['adb', adb, 'platform-tools'],
    ['emulator', emulator, 'emulator'],
  ] as const)
    if (!existsSync(path)) throw new Fail(`the Android SDK in ${root} has no ${tool} (${path}): install it with sdkmanager "${pkg}"`);
  return { root, adb, emulator };
}

// ---- running things, every wait bounded ----

interface Ran {
  code: number | null;
  out: string;
  bytes: Uint8Array;
  err: string;
  timedOut: boolean;
}

async function run(cmd: string[], ms = 20_000): Promise<Ran> {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    p.kill('SIGKILL');
  }, ms);
  const output = Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  // a child of the killed process may hold its output open: give up on that a second later
  const [bytes, err] = await Promise.race([
    output,
    new Promise<[Uint8Array, string]>((ok) => setTimeout(() => timedOut && ok([new Uint8Array(), '']), ms + 1000)),
  ]);
  clearTimeout(t);
  return { code: timedOut ? null : p.exitCode, out: new TextDecoder().decode(bytes).trim(), bytes, err: err.trim(), timedOut };
}

const sleep = (ms: number) => Bun.sleep(ms);

/** Polls `check` until it gives a value or `ms` have passed; then a Fail naming what it waited for. */
async function until<T>(what: string, ms: number, check: () => Promise<T | undefined>, every = 500): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() >= end) throw new Fail(`gave up after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(every);
  }
}

// ---- what this checkout's commands share ----

interface State {
  serial: string;
  /** The emulator `start` booted (stop shuts it down), not one it found running. */
  booted?: { pid: number; avd: string; log: string };
  devtools?: number;
  reverses?: number[];
  browser?: string;
  target?: string;
  record?: { remote: string; file?: string; pid: number };
}

const CHECKOUT = resolve(import.meta.dir, '..');
const STATE_DIR = join(tmpdir(), `obeya-android-phone-${userInfo().username}`);
const STATE_FILE = join(STATE_DIR, `${createHash('sha1').update(CHECKOUT).digest('hex').slice(0, 12)}.json`);

const readState = (): State | undefined => (existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : undefined);
/** Written whole (a reader never sees half of it), in a directory of this user's only. */
const writeState = (s: State) => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const part = `${STATE_FILE}.${process.pid}`;
  writeFileSync(part, JSON.stringify(s, null, 2));
  renameSync(part, STATE_FILE);
};

class Phone {
  constructor(
    readonly sdk: ReturnType<typeof findSdk>,
    public state: State,
  ) {}

  adb(args: string[], ms?: number) {
    return run([this.sdk.adb, '-s', this.state.serial, ...args], ms);
  }

  /** adb, failing with its message when it does. */
  async must(args: string[], ms?: number) {
    const r = await this.adb(args, ms);
    if (r.timedOut) throw new Fail(`adb ${args.join(' ')}: no answer within ${Math.round((ms ?? 20_000) / 1000)} s`);
    if (r.code !== 0) throw new Fail(`adb ${args.join(' ')}: ${r.err || r.out || `exit ${r.code}`}`);
    return r;
  }

  async shell(cmd: string, ms?: number) {
    return (await this.must(['shell', cmd], ms)).out;
  }

  save() {
    writeState(this.state);
  }

  // ---- the browser and its page ----

  async browser() {
    if (this.state.browser) return this.state.browser;
    const installed = (await this.shell('pm list packages')).split('\n').map((l) => l.trim().replace(/^package:/, ''));
    const pkg = ['com.android.chrome', 'org.chromium.chrome', 'com.chrome.beta', 'com.chrome.dev', 'com.chrome.canary'].find((p) => installed.includes(p));
    if (!pkg) throw new Fail(`no Chrome on ${this.state.serial}: use an AVD with a Google Play or Google APIs system image`);
    // no first-run screens, no notification prompt, no offers to translate or install the page over its top:
    // Chrome as the debug app reads its command line from this file
    const flags = '_ --disable-fre --no-default-browser-check --no-first-run --disable-features=Translate,InstallableAmbientBadgeMessage,InstallableAmbientBadgeInfoBar';
    await this.shell(`echo ${shq(flags)} > /data/local/tmp/chrome-command-line`);
    await this.shell(`am set-debug-app --persistent ${pkg}`);
    await this.adb(['shell', `pm grant ${pkg} android.permission.POST_NOTIFICATIONS`]);
    // nor Android's hint over the first fullscreen, whose window hides the page from `uiautomator dump`
    await this.adb(['shell', 'settings put secure immersive_mode_confirmations confirmed']);
    await this.shell(`am force-stop ${pkg}`);
    this.state.browser = pkg;
    this.save();
    return pkg;
  }

  /** The local port that reaches Chrome's DevTools on the device. */
  async devtools() {
    const listed = (await this.must(['forward', '--list'])).out;
    const port = this.state.devtools;
    if (port && listed.includes(`${this.state.serial} tcp:${port} localabstract:chrome_devtools_remote`)) return port;
    const fresh = Number((await this.must(['forward', 'tcp:0', 'localabstract:chrome_devtools_remote'])).out);
    if (!(fresh > 0)) throw new Fail('adb forward gave no port for Chrome DevTools');
    this.state.devtools = fresh;
    this.save();
    return fresh;
  }

  async pages(): Promise<Target[] | undefined> {
    try {
      const r = await fetch(`http://127.0.0.1:${await this.devtools()}/json/list`, { signal: AbortSignal.timeout(2000) });
      return ((await r.json()) as Target[]).filter((t) => t.type === 'page');
    } catch {
      return undefined; // Chrome is not running (yet)
    }
  }

  async open(url: string, ms: number) {
    const u = new URL(url);
    const pkg = await this.browser();
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      await this.must(['reverse', `tcp:${port}`, `tcp:${port}`]);
      this.state.reverses = [...new Set([...(this.state.reverses ?? []), port])];
      this.save();
    }
    const devtools = await this.devtools();
    for (const t of (await this.pages()) ?? []) await fetch(`http://127.0.0.1:${devtools}/json/close/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    await this.adb(['shell', 'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS']);
    await this.shell(`am start -a android.intent.action.VIEW -d ${shq(url)} ${pkg}`);
    const page = await until(`${url} to load in Chrome on ${this.state.serial}`, ms, async () => {
      for (const t of (await this.pages()) ?? []) {
        if (/^(about|chrome|chrome-native):/.test(t.url)) continue;
        // loaded, and for long enough that a redirect from the page (a sign-in link's) would have begun
        const r = await evaluate(t, SETTLED_JS, 2000).catch(() => undefined);
        const v = r?.result.value as { visible: boolean; settled: boolean; href: string } | undefined;
        if (v?.visible && v.settled) return { id: t.id, href: v.href };
      }
      return undefined;
    });
    // the tabs Chrome restored when it started again, which the closing before could not reach
    for (const t of (await this.pages()) ?? [])
      if (t.id !== page.id) await fetch(`http://127.0.0.1:${devtools}/json/close/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    this.state.target = page.id;
    this.save();
    return page.href;
  }

  /** The page `open` opened, or else the one on the screen. */
  async page(): Promise<Target> {
    const pages = await this.pages();
    if (!pages?.length) throw new Fail('no page open in Chrome: run `open <url>` first');
    const mine = pages.find((t) => t.id === this.state.target);
    if (mine) return mine;
    for (const t of pages) if ((await evaluate(t, 'document.visibilityState', 2000).catch(() => undefined))?.result.value === 'visible') return t;
    return pages[0]!;
  }

  // ---- input ----

  async tap(selector: string, ms: number) {
    const target = await this.page();
    const r = await evaluate(target, tapPointJs(selector), ms);
    if (r.exceptionDetails) throw new Fail(`tap ${selector}: ${describe(r)}`);
    const p = r.result.value as (PagePoint & { w: number; h: number }) | null;
    if (!p) throw new Fail(`no element matches ${selector}`);
    if (!p.w || !p.h) throw new Fail(`${selector} takes no space on the page (hidden?)`);
    // Chrome builds the page's node once a dump has turned accessibility on, so the first dump may lack it
    const dump = async () => (await this.must(['exec-out', 'uiautomator', 'dump', '/dev/tty'], ms)).out;
    let xml = '';
    const page =
      (await until('the WebView node', 3000, async () => ((xml = await dump()).includes('"android.webkit.WebView"') ? pageOnScreen(xml, p) : undefined)).catch(
        () => undefined,
      )) ?? pageOnScreen(xml, p);
    if (!page) throw new Fail(`the page is not on the screen (is Chrome in front?): ${xml.slice(-300)}`);
    const at = toDevice(p, page);
    if (at.x < page.left || at.x >= page.right || at.y < page.top || at.y >= page.bottom)
      throw new Fail(`the centre of ${selector} lies at ${at.x},${at.y}, off the page's visible area ${JSON.stringify(page)} (under the keyboard?)`);
    await this.shell(`input tap ${at.x} ${at.y}`);
    // a text field the tap focused opens the keyboard, which takes a moment: return once it is open
    // and the page has settled around it, so that what is measured next is the page with the keyboard
    // (a date or time field opens a picker instead)
    const editable = `(() => { const a = document.activeElement; return !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(a.type))); })()`;
    const focused = await until('a text field to take the focus', 600, async () =>
      (await evaluate(target, editable, 2000)).result.value === true ? true : undefined,
    ).catch(() => false);
    if (!focused) return { ...at, keyboard: undefined };
    const keyboard = await until('the keyboard', 10_000, async () =>
      /mInputShown=true/.test(await this.shell('dumpsys input_method')) ? true : undefined,
    ).catch(() => false);
    await evaluate(target, STEADY_JS, 10_000);
    return { ...at, keyboard };
  }

  async type(text: string) {
    for (const run of textRuns(text)) {
      if ('keys' in run) await this.shell(`input text ${inputTextArg(run.keys)}`, 60_000);
      else if ('enter' in run) await this.shell('input keyevent 66');
      else await send(await this.page(), 'Input.insertText', { text: run.insert }, 10_000);
    }
  }

  async rotate(to: 'portrait' | 'landscape') {
    const emulator = this.state.serial.startsWith('emulator-');
    await this.shell(`settings put system accelerometer_rotation ${emulator ? 1 : 0}`);
    if (emulator) await this.must(['emu', 'sensor', 'set', 'acceleration', ACCELERATION[to]]);
    else await this.shell(`settings put system user_rotation ${to === 'portrait' ? 0 : 1}`);
    // what the screen shows, not the window manager's rotation, which turns up to a second earlier
    // (with the keyboard open): the size of a screenshot, read on the device (the header of the raw image)
    const raw = '/data/local/tmp/obeya-android-phone.raw';
    await until(`the screen to turn ${to} (the app in front may hold its orientation)`, 10_000, async () => {
      const [w, h] = (await this.shell(`screencap ${raw} && od -An -tu4 -N8 ${raw}; rm -f ${raw}`)).trim().split(/\s+/).map(Number);
      return w && h && w > h === (to === 'landscape') ? true : undefined;
    });
    const pages = await this.pages();
    if (pages?.length) {
      const target = await this.page();
      await until(`the page to turn ${to}`, 10_000, async () => {
        const r = await evaluate(target, `matchMedia('(orientation: ${to})').matches`, 2000).catch(() => undefined);
        return r?.result.value === true ? true : undefined;
      });
      // and has laid itself out anew: its viewport has kept its size for half a second (the keyboard
      // closes with the turn), and painted that
      await evaluate(target, STEADY_JS, 10_000);
    }
  }

  // ---- the screen ----

  async screenshot(file: string) {
    const r = await this.must(['exec-out', 'screencap', '-p'], 30_000);
    writeFileSync(file, r.bytes);
  }

  async recordStart(file?: string) {
    if (this.state.record && alive(this.state.record.pid)) throw new Fail('a recording runs already: `record stop <file.mp4>` first');
    const remote = '/sdcard/obeya-android-phone.mp4';
    const sdk = Number(await this.shell('getprop ro.build.version.sdk'));
    // Android 14 records without a limit; before, 180 s at most
    const limit = sdk >= 34 ? 0 : 180;
    await this.adb(['shell', `rm -f ${remote}`]);
    const p = spawn(this.sdk.adb, ['-s', this.state.serial, 'shell', `screenrecord --bit-rate 8000000 --time-limit ${limit} ${remote}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    p.unref();
    this.state.record = { remote, file: file && resolve(file), pid: p.pid! };
    this.save();
    await until('the recording to start', 10_000, async () => ((await this.adb(['shell', 'pidof screenrecord'])).out ? true : undefined));
  }

  async recordStop(file?: string) {
    const rec = this.state.record;
    if (!rec) throw new Fail('no recording runs: `record start` first');
    const out = file ?? rec.file;
    if (!out) throw new Fail('record stop needs the file to write (record stop <file.mp4>)');
    await this.adb(['shell', 'pkill -INT screenrecord']);
    // screenrecord finishes the file once it has stopped
    await until('the recording to end', 15_000, async () => ((await this.adb(['shell', 'pidof screenrecord'])).out ? undefined : true));
    await this.must(['pull', rec.remote, resolve(out)], 120_000);
    await this.adb(['shell', `rm -f ${rec.remote}`]);
    delete this.state.record;
    this.save();
    return resolve(out);
  }
}

// ---- the DevTools protocol ----

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface Evaluated {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

function send(target: Target, method: string, params: object, ms: number): Promise<any> {
  return new Promise((ok, no) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const t = setTimeout(() => {
      ws.close();
      no(new Fail(`${method}: no answer from the page within ${Math.round(ms / 1000)} s`));
    }, ms);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== 1) return;
      clearTimeout(t);
      ws.close();
      if (d.error) no(new Fail(`${method}: ${d.error.message}`));
      else ok(d.result);
    };
    ws.onerror = () => {
      clearTimeout(t);
      no(new Fail(`no DevTools connection to the page (${target.webSocketDebuggerUrl})`));
    };
  });
}

/** `repl` for the caller's JS: `await` at the top and the last expression's value, as in DevTools' console. */
const evaluate = (target: Target, expression: string, ms: number, repl = false): Promise<Evaluated> =>
  send(target, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: repl }, ms);

const describe = (r: Evaluated) => r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? '';

const SETTLED_JS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return { visible: document.visibilityState === 'visible', href: location.href,
    settled: document.readyState === 'complete' && !!nav && nav.loadEventEnd > 0 && performance.now() - nav.loadEventEnd > 700 };
})()`;

const STEADY_JS = `(async () => {
  const size = () => [innerWidth, innerHeight, visualViewport.width, visualViewport.height].join();
  const end = performance.now() + 5000;
  let last = size(), since = performance.now();
  while (performance.now() - since < 500 && performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    if (size() !== last) (last = size()), (since = performance.now());
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;

/** JS for the page: the centre of the element, scrolled into the visual viewport if it is outside. */
function tapPointJs(selector: string) {
  return `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const vv = visualViewport;
    // where the element rests: a panel sliding in, a scroll, moves it for a moment
    const rest = async () => {
      const at = () => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, vv.offsetLeft, vv.offsetTop, vv.scale].join(); };
      const end = performance.now() + 3000;
      let last = at(), since = performance.now();
      while (performance.now() - since < 200 && performance.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
        if (at() !== last) (last = at()), (since = performance.now());
      }
    };
    await rest();
    const r0 = el.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    if (cx < vv.offsetLeft || cx > vv.offsetLeft + vv.width || cy < vv.offsetTop || cy > vv.offsetTop + vv.height) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await rest();
    }
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, dpr: devicePixelRatio,
      vv: { left: vv.offsetLeft, top: vv.offsetTop, height: vv.height, scale: vv.scale } };
  })()`;
}

// ---- start and stop ----

async function devices(adb: string) {
  const r = await run([adb, 'devices'], 20_000);
  return r.out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 2)
    .map(([serial, state]) => ({ serial: serial!, state: state! }));
}

async function portFree(port: number) {
  try {
    const s = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function avds(emulator: string) {
  const r = await run([emulator, '-list-avds'], 30_000);
  return r.out.split('\n').map((l) => l.trim()).filter((l) => l && !/^(INFO|WARNING|ERROR)\b/.test(l));
}

async function start(sdk: ReturnType<typeof findSdk>, c: Extract<Command, { cmd: 'start' }>) {
  const running = await devices(sdk.adb);
  const had = readState();
  if (had && running.some((d) => d.serial === had.serial && d.state === 'device') && (!c.serial || c.serial === had.serial)) {
    const phone = new Phone(sdk, had);
    if ((await phone.adb(['shell', 'getprop sys.boot_completed'])).out === '1') return phone;
  }
  // (alive and still listed: a pid alone may since name another process)
  if (had?.booted && alive(had.booted.pid) && running.some((d) => d.serial === had.serial))
    throw new Fail(`this checkout's emulator (${had.serial}) still runs but does not answer: \`stop\` it first`);
  if (c.serial) {
    const d = running.find((d) => d.serial === c.serial);
    if (!d) throw new Fail(`no device ${c.serial}; adb devices lists: ${running.map((d) => `${d.serial} (${d.state})`).join(', ') || 'none'}`);
    if (d.state !== 'device') throw new Fail(`${c.serial} is ${d.state}${d.state === 'unauthorized' ? ': allow USB debugging on the phone' : ''}`);
    const phone = new Phone(sdk, { serial: c.serial });
    phone.save();
    return phone;
  }

  const names = await avds(sdk.emulator);
  if (!names.length)
    throw new Fail(
      'no AVD (Android Virtual Device): create one with a Google Play system image in Android Studio\'s Device Manager, or with ' +
        'avdmanager create avd -n phone -d pixel_7 -k "system-images;android-35;google_apis_playstore;<x86_64|arm64-v8a>"',
    );
  const avd = c.avd ?? names[0]!;
  if (!names.includes(avd)) throw new Fail(`no AVD named ${avd}; there are: ${names.join(', ')}`);

  let port = 5554;
  while (running.some((d) => d.serial === `emulator-${port}`) || !(await portFree(port)) || !(await portFree(port + 1))) {
    port += 2;
    if (port > 5682) throw new Fail('no free emulator console port between 5554 and 5682');
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const log = STATE_FILE.replace(/\.json$/, '-emulator.log');
  const fd = openSync(log, 'w');
  const args = ['-avd', avd, '-port', String(port), '-read-only', '-no-audio', '-no-boot-anim', ...(c.window ? [] : ['-no-window'])];
  const child = spawn(sdk.emulator, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  closeSync(fd);
  const phone = new Phone(sdk, { serial: `emulator-${port}`, booted: { pid: child.pid!, avd, log } });
  phone.save();

  const begun = Date.now();
  try {
    await until(`${avd} to boot (log: ${log})`, c.timeout * 1000, async () => {
      if (!alive(child.pid!)) {
        const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n');
        const other = /Another emulator instance is running/.test(tail) ? await runningAvd(sdk.adb, running, avd) : undefined;
        throw new Fail(
          other
            ? `${avd} already runs as ${other}, booted without -read-only, so no second one can boot: use it with \`start --serial ${other}\` (shared with whoever started it), or another AVD`
            : `the emulator exited while booting ${avd}:\n${tail}`,
        );
      }
      const r = await phone.adb(['shell', 'getprop sys.boot_completed'], 5000);
      return r.out === '1' ? true : undefined;
    }, 1000);
  } catch (e) {
    if (alive(child.pid!)) process.kill(child.pid!);
    rmSync(STATE_FILE, { force: true });
    throw e;
  }
  // awake, unlocked, no dialogs of apps that answer slowly while the system settles (and none shown already),
  // the on-screen keyboard despite the host's keyboard, taps shown in screenshots and recordings
  for (const cmd of [
    'settings put system screen_off_timeout 2147483647',
    'svc power stayon true',
    'wm dismiss-keyguard',
    'settings put global hide_error_dialogs 1',
    'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS',
    'settings put secure show_ime_with_hard_keyboard 1',
    'settings put system accelerometer_rotation 1',
    'settings put system show_touches 1',
  ])
    await phone.adb(['shell', cmd]);
  return Object.assign(phone, { bootedIn: Math.round((Date.now() - begun) / 1000) });
}

/** The serial of the running emulator of `avd`, if one runs. */
async function runningAvd(adb: string, running: { serial: string }[], avd: string) {
  for (const d of running.filter((d) => d.serial.startsWith('emulator-'))) {
    const r = await run([adb, '-s', d.serial, 'emu', 'avd', 'name'], 5000);
    if (r.out.split('\n')[0]?.trim() === avd) return d.serial;
  }
  return undefined;
}

async function stop(sdk: ReturnType<typeof findSdk>) {
  const s = readState();
  if (!s) return 'nothing to stop: no `start` in this checkout';
  const phone = new Phone(sdk, s);
  if (s.record) await phone.adb(['shell', 'pkill -INT screenrecord']);
  if (s.devtools) await phone.adb(['forward', '--remove', `tcp:${s.devtools}`]);
  if (!s.booted) {
    for (const p of s.reverses ?? []) await phone.adb(['reverse', '--remove', `tcp:${p}`]);
    rmSync(STATE_FILE, { force: true });
    return `left ${s.serial} running (not booted here); removed the port forwards`;
  }
  const { pid } = s.booted;
  // the pid is the emulator's only while adb still lists it; else it may since name another process
  if (alive(pid) && (await devices(sdk.adb)).some((d) => d.serial === s.serial)) {
    await phone.adb(['emu', 'kill'], 10_000);
    const gone = await until('the emulator to shut down', 30_000, async () => (alive(pid) ? undefined : true)).catch(() => false);
    if (!gone) process.kill(pid, 'SIGKILL');
  }
  rmSync(STATE_FILE, { force: true });
  return `stopped ${s.serial} (${s.booted.avd})`;
}

// ---- the command line ----

async function main(c: Command) {
  const sdk = findSdk();
  if (c.cmd === 'start') {
    const phone = await start(sdk, c);
    const how = 'bootedIn' in phone ? `booted ${phone.state.booted!.avd} in ${phone.bootedIn} s` : phone.state.booted ? 'already running' : 'running, not booted here';
    return `ready: ${phone.state.serial} (${how})`;
  }
  if (c.cmd === 'stop') return stop(sdk);

  const s = readState();
  if (!s) throw new Fail('no phone: run `start` first');
  const phone = new Phone(sdk, s);
  const state = (await devices(sdk.adb)).find((d) => d.serial === s.serial)?.state;
  if (state !== 'device') throw new Fail(`${s.serial} is ${state ?? 'gone'}: run \`stop\`, then \`start\` again`);

  switch (c.cmd) {
    case 'open':
      return `loaded ${await phone.open(c.url, c.timeout * 1000)}`;
    case 'eval': {
      const r = await evaluate(await phone.page(), c.js, c.timeout * 1000, true);
      if (r.exceptionDetails) throw new Fail(describe(r));
      return r.result.type === 'undefined' ? 'undefined' : JSON.stringify(r.result.value ?? null);
    }
    case 'tap': {
      const at = await phone.tap(c.selector, c.timeout * 1000);
      const keyboard = at.keyboard === undefined ? '' : at.keyboard ? ', the keyboard is open' : ', a text field but no keyboard within 10 s';
      return `tapped ${c.selector} at ${at.x},${at.y}${keyboard}`;
    }
    case 'type':
      await phone.type(c.text);
      return `typed ${c.text.length} characters`;
    case 'rotate':
      await phone.rotate(c.to);
      return `turned ${c.to}`;
    case 'screenshot':
      await phone.screenshot(c.file);
      return `wrote ${resolve(c.file)}`;
    case 'record':
      if (c.action === 'start') {
        await phone.recordStart(c.file);
        return 'recording';
      }
      return `wrote ${await phone.recordStop(c.file)}`;
  }
}

if (import.meta.main) {
  try {
    console.log(await main(parseArgs(process.argv.slice(2))));
    process.exit(0);
  } catch (e) {
    console.error(`android-phone: ${e instanceof Fail ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  }
}
