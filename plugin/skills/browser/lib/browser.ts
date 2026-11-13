// A headless Chromium of the session's own, driven from the shell over the Chrome DevTools Protocol
// (CDP). Plain Node with type stripping, like the demo skill; on macOS, Linux and Windows.
//
// Usage: node browser.ts <command> [args]; the commands and input steps are in ../SKILL.md.
//
// Each Claude Code session has a browser of its own: its state (port, pid) is in a file named by
// the session's process (`CLAUDE_PID`), and the process holding the browser (`serve`, started by
// `start`) closes it once that process has ended. Without `CLAUDE_PID` (a terminal) there is one
// browser per user, until `stop`. Playwright launches it (`plugin/lib/chromium.ts`), so it is the
// Chromium the demo skill records with, with a fresh profile that goes with it.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, isMain } from '../../../lib/process.ts';

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The process of the Claude Code session that runs this command, whose browser it drives. */
export function sessionPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The session's state file: in the OS temp directory, named by the session's process. */
export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  const pid = sessionPid(env);
  return path.join(os.tmpdir(), 'obeya-browser', `${pid ?? `user-${os.userInfo().username}`}.json`);
}

/** What the process holding the browser prints, beside the state: why it did not come up. */
const logFile = (state: string) => state.replace(/\.json$/, '.log');

interface State {
  port: number;
  /** The process holding the browser (`serve`). */
  pid: number;
  /** The session's process, the browser closes when it ends; null: only at `stop`. */
  owner: number | null;
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function isAlive(port: number, ms = 1000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the session's browser still runs. One that does not answer within a second is given ten
 * while its holder lives: on a busy machine (a Mac runner with the test suite beside it) Chrome took
 * longer to answer, and its state was cleaned up as stale while it ran.
 */
async function stillRunning(state: State): Promise<boolean> {
  return (await isAlive(state.port)) || (alive(state.pid) && (await isAlive(state.port, 10_000)));
}

async function http(port: number, path: string, method = 'GET'): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  if (!res.ok) fail(`CDP ${method} ${path} failed: ${res.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

function readState(file: string): State | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  } catch {
    return null;
  }
}

async function loadState(): Promise<State> {
  const file = stateFile();
  const state = readState(file);
  if (!state) return fail('No browser running in this session — run `start` first.');
  if (!(await stillRunning(state))) {
    fs.rmSync(file, { force: true });
    fail('The browser is no longer running (stale state cleaned up) — run `start` again.');
  }
  return state;
}

interface Tab {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

async function pageTabs(port: number): Promise<Tab[]> {
  const targets: (Tab & { type: string })[] = await http(port, '/json/list');
  return targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

async function pickTab(port: number, tabId?: string): Promise<Tab> {
  const tabs = await pageTabs(port);
  if (tabs.length === 0) fail('No open tabs — run `open <url>` first.');
  if (!tabId) return tabs[0]!;
  const tab = tabs.find((t) => t.id === tabId || t.id.startsWith(tabId));
  if (!tab) fail(`No tab ${tabId}. Open tabs:\n` + tabs.map((t) => `${t.id}  ${t.url}`).join('\n'));
  return tab!;
}

interface Connection {
  /** A command's result; rejects on an error, or when no answer came within 30 s. */
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  /** What the browser sends that answers no command: its events. */
  on(handler: (event: { method: string; params: any; sessionId?: string }) => void): void;
  close(): void;
}

/** A CDP connection to a tab or the browser (`webSocketDebuggerUrl`). */
async function connect(wsUrl: string): Promise<Connection> {
  const ws = new WebSocket(wsUrl);
  const failed = () => new Error(`WebSocket connection to ${wsUrl} failed`);
  // the connection gets the same 30 s as a command
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout connecting to ${wsUrl}`));
      ws.close();
    }, 30_000);
    ws.onopen = () => resolve(clearTimeout(timer));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(failed());
    };
  });
  let id = 0;
  const pending = new Map<number, { method: string; timer: NodeJS.Timeout; resolve: (result: any) => void; reject: (error: Error) => void }>();
  /** The command `i` that waits for its answer, which no longer waits once taken. */
  const take = (i: number) => {
    const call = pending.get(i);
    clearTimeout(call?.timer);
    pending.delete(i);
    return call;
  };
  let handler: Parameters<Connection['on']>[0] = () => {};
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    const call = take(msg.id);
    if (!call) {
      if (msg.method) handler(msg);
    } else if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
    else call.resolve(msg.result);
  };
  ws.onerror = () => {
    for (const i of [...pending.keys()]) take(i)!.reject(failed());
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => take(i)?.reject(new Error(`Timeout waiting for ${method}`)), 30_000);
        pending.set(i, { method, timer, resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    on: (h) => (handler = h),
    close: () => ws.close(),
  };
}

/** One command on a connection of its own. */
async function cdp(wsUrl: string, method: string, params: object = {}): Promise<any> {
  const connection = await connect(wsUrl);
  try {
    return await connection.send(method, params);
  } finally {
    connection.close();
  }
}

/** The value of `expression` in the page, promises awaited; an exception in it ends the command. */
async function evaluate(connection: Connection, expression: string): Promise<any> {
  const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true });
  if (result.exceptionDetails) {
    fail(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function evalInTab(tab: Tab, expression: string): Promise<any> {
  const connection = await connect(tab.webSocketDebuggerUrl);
  try {
    return await evaluate(connection, expression);
  } finally {
    connection.close();
  }
}

async function waitForLoad(port: number, tabId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = (await pageTabs(port)).find((t) => t.id === tabId);
      if (tab && (await evalInTab(tab, 'document.readyState')) === 'complete') return;
    } catch {
      // page mid-navigation; retry
    }
    await sleep(250);
  }
  console.error(`Warning: page not fully loaded after ${timeoutMs / 1000} s — continuing anyway.`);
}

const KEYS: Record<string, { code: string; key: string; vk: number }> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Space: { code: 'Space', key: ' ', vk: 32 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Shift: { code: 'ShiftLeft', key: 'Shift', vk: 16 },
  Control: { code: 'ControlLeft', key: 'Control', vk: 17 },
  Alt: { code: 'AltLeft', key: 'Alt', vk: 18 },
  Meta: { code: 'MetaLeft', key: 'Meta', vk: 91 },
};
/** The CDP modifier bit of each modifier key: held with `down:`, it goes with the mouse and key events until `up:`. */
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function keyOf(name: string) {
  if (KEYS[name]) return KEYS[name];
  if (name.length !== 1) fail(`Unknown key ${name}`);
  const up = name.toUpperCase();
  const code = /[a-z]/i.test(name) ? `Key${up}` : /[0-9]/.test(name) ? `Digit${name}` : '';
  return { code, key: name, vk: up.charCodeAt(0) };
}

/** Trusted input over one CDP connection, so a key held down stays down across steps. */
async function runInput(tab: Tab, steps: string[]) {
  const connection = await connect(tab.webSocketDebuggerUrl);
  const { send } = connection;
  /** `X,Y…` numbers, where one `@selector` stands for the centre of that element (two numbers). */
  const coords = async (arg: string): Promise<number[]> => {
    if (!arg.startsWith('@')) return arg.split(',').map(Number);
    const sel = arg.slice(1);
    const p = await evaluate(connection, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) fail(`No element matches ${sel}`);
    return p;
  };
  let modifiers = 0;
  const mouse = (type: string, x: number, y: number, extra: object = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers, ...extra });
  for (const step of steps) {
    const colon = step.indexOf(':');
    const cmd = colon < 0 ? step : step.slice(0, colon);
    const arg = colon < 0 ? '' : step.slice(colon + 1);
    switch (cmd) {
      case 'click':
      case 'dbl': {
        const [x = 0, y = 0] = await coords(arg);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
        await mouse('mousePressed', x, y);
        await mouse('mouseReleased', x, y);
        if (cmd === 'dbl') {
          await mouse('mousePressed', x, y, { clickCount: 2 });
          await mouse('mouseReleased', x, y, { clickCount: 2 });
        }
        break;
      }
      case 'drag': {
        // `@selector,X2,Y2` or `X1,Y1,X2,Y2[,X3,Y3…]`
        const parts = arg.startsWith('@') ? [...(await coords(arg.slice(0, arg.lastIndexOf(',', arg.lastIndexOf(',') - 1)))), ...arg.split(',').slice(-2).map(Number)] : arg.split(',').map(Number);
        // more points after the end draw a path through them (a lasso), each leg in 10 steps
        const [x1, y1] = parts as [number, number];
        let at = [x1, y1];
        await mouse('mousePressed', x1, y1);
        for (let p = 2; p + 1 < parts.length; p += 2) {
          const [ax, ay] = at as [number, number];
          const bx = parts[p]!;
          const by = parts[p + 1]!;
          for (let i = 1; i <= 10; i++) {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ax + ((bx - ax) * i) / 10, y: ay + ((by - ay) * i) / 10, button: 'left', buttons: 1, modifiers });
            await sleep(16);
          }
          at = [bx, by];
        }
        await mouse('mouseReleased', at[0]!, at[1]!);
        break;
      }
      case 'wheel': {
        const [x, y, dx, dy, ctrl] = arg.split(',').map(Number) as number[];
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers: modifiers | (ctrl ? 2 : 0) });
        break;
      }
      case 'key':
      case 'down':
      case 'up': {
        const k = keyOf(arg);
        const text = k.key.length === 1 ? k.key : k.code === 'Enter' ? '\r' : undefined;
        const bit = MODIFIERS[k.key] ?? 0;
        if (cmd !== 'up') {
          modifiers |= bit;
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(text ? { text } : {}) });
        }
        if (cmd !== 'down') {
          modifiers &= ~bit;
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
        }
        break;
      }
      case 'type':
        await send('Input.insertText', { text: arg });
        break;
      case 'wait':
        await sleep(Number(arg));
        break;
      case 'shot':
        save(arg, (await send('Page.captureScreenshot', { format: 'png' })).data, 'Screenshot');
        break;
      case 'eval': {
        const v = await evaluate(connection, arg);
        console.log(typeof v === 'string' ? v : JSON.stringify(v));
        break;
      }
      default:
        fail(`Unknown input step ${step}`);
    }
  }
  connection.close();
}

interface ServeSpec {
  state: string;
  owner: number | null;
  windowSize: string;
  fakeMic?: string;
}

/**
 * The process that holds the session's browser: launches it, writes the state, and closes it when
 * the session's process has ended, on a signal (`stop` sends one), or when the browser went (on
 * Windows `stop` closes it over CDP: killing this process there would leave the browser behind).
 */
async function serve(spec: ServeSpec) {
  const { launchChromium, SILENT_SPEECH } = await import('../../../lib/chromium.ts');
  const port = await freePort();
  const micFlags = spec.fakeMic
    ? [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${spec.fakeMic}`,
        '--autoplay-policy=no-user-gesture-required',
      ]
    : [];
  const browser = await launchChromium({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // a headless browser plays sound through the machine's speakers: a page's videos stay silent
    args: [`--remote-debugging-port=${port}`, `--window-size=${spec.windowSize}`, '--mute-audio', ...micFlags],
  });
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    clearInterval(watch);
    await browser.close().catch(() => {});
    if (readState(spec.state)?.pid === process.pid) {
      fs.rmSync(spec.state, { force: true });
      fs.rmSync(logFile(spec.state), { force: true });
    }
    process.exit(0);
  };
  await silenceSpeech(port, fs.readFileSync(SILENT_SPEECH, 'utf8'));
  browser.on('disconnected', end);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, end);
  const watch = setInterval(() => {
    if (spec.owner && !alive(spec.owner)) end();
  }, 1000);
  const state: State = { port, pid: process.pid, owner: spec.owner };
  fs.writeFileSync(`${spec.state}.tmp`, JSON.stringify(state));
  fs.renameSync(`${spec.state}.tmp`, spec.state);
}

/**
 * Gives every page of the browser, and every frame in a process of its own, the init script that
 * keeps its `speechSynthesis` silent, whoever opens it (`open`, a page's `window.open`, a link).
 * The connection stays open while the browser runs: CDP holds each new target until this
 * connection has added the script, so not even a page's first script speaks.
 */
async function silenceSpeech(port: number, source: string) {
  const { webSocketDebuggerUrl } = await http(port, '/json/version');
  const connection = await connect(webSocketDebuggerUrl);
  // sent without waiting for the answers: a target may be gone before it answers
  const send = (method: string, params: object = {}, sessionId?: string) => void connection.send(method, params, sessionId).catch(() => {});
  const autoAttach = (sessionId?: string) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  connection.on((msg) => {
    if (msg.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = msg.params;
    if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
      // without Page.enable, the script ran only in the document the target opened with
      send('Page.enable', {}, sessionId);
      send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId);
      autoAttach(sessionId);
      send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    } else {
      send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      send('Target.detachFromTarget', { sessionId });
    }
  });
  autoAttach();
}

async function start(args: string[]) {
  const file = stateFile();
  const running = readState(file);
  if (running) {
    if (await stillRunning(running)) {
      console.log(`Already running on CDP port ${running.port} (pid ${running.pid}).`);
      return;
    }
    fs.rmSync(file, { force: true });
  }
  const windowSize = takeFlag(args, '--window-size') ?? '1280,900';
  const fakeMic = takeFlag(args, '--fake-mic');
  if (fakeMic && !fs.existsSync(fakeMic)) fail(`No file ${fakeMic}.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const log = logFile(file);
  const spec: ServeSpec = { state: file, owner: sessionPid(), windowSize, ...(fakeMic ? { fakeMic: path.resolve(fakeMic) } : {}) };
  const out = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, 'serve', JSON.stringify(spec)], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  fs.closeSync(out);
  let exited = false;
  child.on('exit', () => (exited = true));
  child.unref();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = readState(file);
    if (state && (await isAlive(state.port))) {
      console.log(`Headless browser running on CDP port ${state.port} (pid ${state.pid}), muted.`);
      return;
    }
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill();
      const why = fs.readFileSync(log, 'utf8').trim();
      fs.rmSync(log, { force: true });
      fail(`The browser did not come up${exited ? '' : ' within 30 s'}:\n${why}`);
    }
    await sleep(200);
  }
}

async function stop() {
  const file = stateFile();
  const state = readState(file);
  if (!state) {
    console.log('Nothing to stop.');
    return;
  }
  // Its holder closes it, killing it after a short grace (Chrome's own shutdown, asked over CDP,
  // hung for ten seconds on a busy Mac); on Windows a signal would kill the holder, which leaves the
  // browser behind, so there it is asked over CDP.
  if (process.platform !== 'win32' && alive(state.pid)) process.kill(state.pid, 'SIGTERM');
  else if (await isAlive(state.port)) {
    const { webSocketDebuggerUrl } = await http(state.port, '/json/version');
    await cdp(webSocketDebuggerUrl, 'Browser.close').catch(() => {});
  }
  const deadline = Date.now() + 10_000;
  while (alive(state.pid) && Date.now() < deadline) await sleep(100);
  if (alive(state.pid)) process.kill(state.pid);
  fs.rmSync(file, { force: true });
  console.log('Browser stopped.');
}

/**
 * The module a script imports Playwright from: `plugin/lib/playwright.mjs`, the `playwright-core`
 * this browser is launched with (found up the tree from there: a checkout's node_modules, or the one
 * beside the plugin among Obeya's resources and on a host), whose browsers play no sound. A file
 * URL, which an import takes on Windows too.
 */
export function playwrightModule(): string {
  return new URL('../../../lib/playwright.mjs', import.meta.url).href;
}

/**
 * `playwright`: the import line and which of Playwright's own WebKit and Firefox are installed (its
 * Chromium is left out: a launch takes its headless shell, which `executablePath` does not name);
 * `playwright install …` installs them.
 */
async function playwright(args: string[]) {
  if (args[0] === 'install') {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve('playwright-core'))), 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'install', ...args.slice(1)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const url = playwrightModule();
  const pw = (await import(url)) as typeof import('playwright-core');
  console.log(`import { chromium, firefox, webkit } from ${JSON.stringify(url)};`);
  for (const name of ['webkit', 'firefox'] as const) {
    console.log(fs.existsSync(pw[name].executablePath()) ? `${name}: installed` : `${name}: not installed (playwright install ${name})`);
  }
}

async function listTabs(port: number) {
  for (const tab of await pageTabs(port)) console.log(`${tab.id}  ${tab.url}  ${JSON.stringify(tab.title)}`);
}

/** Sends `tab` to `url` and prints its id, once the page has loaded unless `noWait`. */
async function navigate(port: number, tab: Tab, url: string, noWait: boolean) {
  await cdp(tab.webSocketDebuggerUrl, 'Page.navigate', { url });
  if (!noWait) await waitForLoad(port, tab.id);
  console.log(tab.id);
}

/** Writes what CDP returned in base64 (`data`) to `file`, and says so. */
function save(file: string, data: string, what: string) {
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`${what} saved to ${file}.`);
}

async function main([command, ...args]: string[]) {
  const tabId = takeFlag(args, '--tab');
  const tab = async () => pickTab((await loadState()).port, tabId);
  switch (command) {
    case 'serve':
      return serve(JSON.parse(args[0]!) as ServeSpec);

    case 'start':
      return start(args);

    case 'stop':
      return stop();

    case 'status': {
      const state = await loadState();
      const owner = state.owner ? `, closes when process ${state.owner} ends` : ', until `stop`';
      console.log(`Running on CDP port ${state.port} (pid ${state.pid}${owner}).`);
      return listTabs(state.port);
    }

    case 'tabs':
      return listTabs((await loadState()).port);

    case 'open': {
      const noWait = takeBoolFlag(args, '--no-wait');
      const url = args[0] ?? fail('Usage: open <url> [--no-wait]');
      const { port } = await loadState();
      // /json/new URL-decodes its query inconsistently across versions; opening
      // about:blank and navigating via CDP sidesteps that.
      return navigate(port, await http(port, '/json/new', 'PUT'), url, noWait);
    }

    case 'nav': {
      const noWait = takeBoolFlag(args, '--no-wait');
      const url = args[0] ?? fail('Usage: nav <url> [--tab id] [--no-wait]');
      const { port } = await loadState();
      return navigate(port, await pickTab(port, tabId), url, noWait);
    }

    case 'close': {
      const id = args[0] ?? fail('Usage: close <tabId>');
      const { port } = await loadState();
      const closing = await pickTab(port, id);
      await fetch(`http://127.0.0.1:${port}/json/close/${closing.id}`);
      console.log(`Closed ${closing.id}.`);
      return;
    }

    case 'eval': {
      const expression = args[0] ?? fail('Usage: eval <js> [--tab id]');
      const value = await evalInTab(await tab(), expression);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return;
    }

    case 'text':
      console.log(await evalInTab(await tab(), 'document.body.innerText'));
      return;

    case 'html':
      console.log(await evalInTab(await tab(), 'document.documentElement.outerHTML'));
      return;

    case 'screenshot': {
      const fullPage = takeBoolFlag(args, '--full');
      const file = args[0] ?? fail('Usage: screenshot <file.png> [--tab id] [--full]');
      const { data } = await cdp((await tab()).webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      return save(file, data, 'Screenshot');
    }

    case 'pdf': {
      const file = args[0] ?? fail('Usage: pdf <file.pdf> [--tab id]');
      const { data } = await cdp((await tab()).webSocketDebuggerUrl, 'Page.printToPDF', { printBackground: true });
      return save(file, data, 'PDF');
    }

    case 'input':
      if (!args.length) fail('Usage: input <step>… [--tab id] — the steps are in SKILL.md.');
      // a step that fails or gets no answer ends the command with its message alone
      return runInput(await tab(), args).catch((error: Error) => fail(error.message));

    case 'playwright':
      return playwright(args);

    default:
      fail('Usage: browser.ts <start|stop|status|tabs|open|nav|close|eval|text|html|screenshot|pdf|input|playwright> — see SKILL.md for details.');
  }
}

if (isMain(import.meta.filename)) await main(process.argv.slice(2));
