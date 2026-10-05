// What a demo needs on this machine, checked: Node, Playwright and a browser to record with,
// ffmpeg (with libx264) to cut, uv for the Python parts (it brings Python itself), the voice of
// the settings, and Whisper for listening back. Each missing piece comes with how to install it on
// this platform. Obeya's settings sheet shows the check, and a render runs it before anything
// else, so it stops at once with the whole list instead of minutes in.
//
// Run on its own (`node setup.ts`), it prints the check and exits 1 when something is missing.
// Plain Node with type stripping, like the director; Obeya's server (Bun) imports it too.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type DemoSettings, readDemoSettings, withVoice } from './settings.ts';
import { hfModelPresent, installState, onMlx } from './voices.ts';

const LIB = import.meta.dirname;
/** The Obeya checkout the skill lives in: Playwright comes from its `node_modules`. */
const ROOT = path.resolve(LIB, '..', '..', '..', '..');

/** Node runs the director's TypeScript without flags from here on. */
export const NODE_MIN = [22, 18] as const;

export type SetupId = 'node' | 'playwright' | 'browser' | 'ffmpeg' | 'uv' | 'voice' | 'whisper';

export interface SetupItem {
  id: SetupId;
  /**
   * `ok`: there. `missing`: a render stops without it. `later`: the first render fetches it
   * (Whisper), which takes a while. `off`: not used (listening back turned off).
   */
  state: 'ok' | 'missing' | 'later' | 'off';
  /** What was found: a version, a path, the voice's missing parts. */
  found?: string;
  /** What it lacks when something is there but does not do (Node too old, ffmpeg without libx264). */
  need?: string;
  /** About this many megabytes still to download (`later`, a voice to install). */
  mb?: number;
  /** How to install it here: commands to run in a terminal, and a page that says more. */
  install?: { commands: string[]; url?: string };
}

export interface SetupCheck {
  platform: string;
  arch: string;
  items: SetupItem[];
}

/** Which Linux a package hint is for, from `/etc/os-release`. */
export type LinuxFamily = 'apt' | 'dnf' | 'pacman' | null;

export function linuxFamily(osRelease = readOsRelease()): LinuxFamily {
  const ids = (osRelease.match(/^ID(?:_LIKE)?=(.*)$/gm) ?? []).flatMap((l) => l.split('=')[1]!.replace(/"/g, '').split(/\s+/));
  if (ids.some((id) => ['debian', 'ubuntu'].includes(id))) return 'apt';
  if (ids.some((id) => ['fedora', 'rhel', 'centos'].includes(id))) return 'dnf';
  if (ids.includes('arch')) return 'pacman';
  return null;
}

function readOsRelease() {
  try {
    return fs.readFileSync('/etc/os-release', 'utf8');
  } catch {
    return '';
  }
}

/** How to install a missing piece on a platform. */
export function installHint(id: SetupId, platform: string, arch: string, family: LinuxFamily = null): SetupItem['install'] {
  const mac = platform === 'darwin';
  const win = platform === 'win32';
  switch (id) {
    case 'node':
      return {
        commands: mac ? ['brew install node'] : win ? ['winget install OpenJS.NodeJS'] : [],
        url: 'https://nodejs.org/en/download',
      };
    case 'playwright':
      return { commands: [`bun install --cwd "${ROOT}"`] };
    case 'browser': {
      if (mac) return { commands: ['brew install --cask google-chrome'], url: 'https://www.google.com/chrome/' };
      if (win) return { commands: ['winget install Google.Chrome'], url: 'https://www.google.com/chrome/' };
      // Google builds Chrome for Linux on x64 only; elsewhere Playwright's own Chromium records.
      const chromium = `cd "${ROOT}" && npx playwright-core install --with-deps chromium`;
      return arch === 'x64' ? { commands: [chromium], url: 'https://www.google.com/chrome/' } : { commands: [chromium] };
    }
    case 'ffmpeg':
      if (mac) return { commands: ['brew install ffmpeg'], url: 'https://ffmpeg.org/download.html' };
      if (win) return { commands: ['winget install Gyan.FFmpeg'], url: 'https://ffmpeg.org/download.html' };
      if (family === 'apt') return { commands: ['sudo apt install ffmpeg'] };
      // Fedora's own ffmpeg-free has no libx264; RPM Fusion's ffmpeg has.
      if (family === 'dnf') return { commands: ['sudo dnf install ffmpeg --allowerasing'], url: 'https://rpmfusion.org/Configuration' };
      if (family === 'pacman') return { commands: ['sudo pacman -S ffmpeg'] };
      return { commands: [], url: 'https://ffmpeg.org/download.html' };
    case 'uv':
      return {
        commands: mac ? ['brew install uv'] : win ? ['winget install --id=astral-sh.uv -e'] : ['curl -LsSf https://astral.sh/uv/install.sh | sh'],
        url: 'https://docs.astral.sh/uv/getting-started/installation/',
      };
    case 'voice':
      return { commands: [`node "${path.join(LIB, 'voices.ts')}" install`] };
    case 'whisper':
      return undefined;
  }
}

/**
 * Whisper for listening back, as the render brings it with uv: mlx-whisper on Apple Silicon,
 * faster-whisper elsewhere (CTranslate2 has wheels for released Pythons only, so 3.12). The
 * models are those `tts.py` loads (`STT_MODELS`).
 */
export function whisperKit() {
  return onMlx()
    ? { backend: 'mlx' as const, uvArgs: ['--with', 'mlx-whisper'], module: 'mlx_whisper', model: 'mlx-community/whisper-large-v3-turbo' }
    : { backend: 'faster' as const, uvArgs: ['--python', '3.12', '--with', 'faster-whisper'], module: 'faster_whisper', model: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo' };
}

/** Runs a program; `null` when it is not there or fails. */
function output(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 30_000, maxBuffer: 1 << 22, windowsHide: true }, (error, stdout, stderr) => resolve(error ? null : `${stdout}${stderr}`));
  });
}

const atLeast = (version: string, [major, minor]: readonly [number, number]) => {
  const [a = 0, b = 0] = version.replace(/^v/, '').split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

/** Where Playwright looks for Chrome and Edge (its registry's paths), and its own Chromium. */
export function browserPaths(channel: 'chrome' | 'msedge', platform: string, env: NodeJS.ProcessEnv): string[] {
  const at = {
    chrome: { linux: '/opt/google/chrome/chrome', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', win32: '\\Google\\Chrome\\Application\\chrome.exe' },
    msedge: { linux: '/opt/microsoft/msedge/msedge', darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', win32: '\\Microsoft\\Edge\\Application\\msedge.exe' },
  }[channel][platform as 'linux' | 'darwin' | 'win32'];
  if (!at) return [];
  if (platform !== 'win32') return [at];
  const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files`, env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files (x86)`];
  return prefixes.filter(Boolean).map((p) => path.win32.join(p!, at));
}

/** The browser the director would record with, in its order: `DEMO_CHROME`, Chrome, Edge, Playwright's Chromium. */
async function browser(platform: string, env: NodeJS.ProcessEnv, playwright: string | null): Promise<string | null> {
  if (env.DEMO_CHROME) return fs.existsSync(env.DEMO_CHROME) ? env.DEMO_CHROME : null;
  for (const channel of ['chrome', 'msedge'] as const) {
    const found = browserPaths(channel, platform, env).find((p) => fs.existsSync(p));
    if (found) return found;
  }
  if (!playwright) return null;
  try {
    const { chromium } = (await import(playwright)) as typeof import('playwright-core');
    const own = chromium.executablePath();
    return own && fs.existsSync(own) ? own : null;
  } catch {
    return null;
  }
}

function resolvePlaywright(): string | null {
  try {
    return createRequire(path.join(LIB, 'director.ts')).resolve('playwright-core');
  } catch {
    return null;
  }
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** Leave out what only the recording needs (browser, Playwright): `node demo.ts --narration`. */
  narrationOnly?: boolean;
  home?: string;
}

/** Checks everything a render of a demo with these settings needs, side by side. */
export async function checkSetup(s: DemoSettings, o: SetupOptions = {}): Promise<SetupCheck> {
  const env = o.env ?? process.env;
  const { platform, arch } = process;
  const family = platform === 'linux' ? linuxFamily() : null;
  const hint = (id: SetupId) => installHint(id, platform, arch, family);
  const missing = (id: SetupId, rest: Partial<SetupItem> = {}): SetupItem => ({ id, state: 'missing', install: hint(id), ...rest });

  const whisper = whisperKit();
  const [nodeOut, ffmpegOut, encoders, uvOut, whisperOut] = await Promise.all([
    output('node', ['--version'], env),
    output('ffmpeg', ['-hide_banner', '-version'], env),
    output('ffmpeg', ['-hide_banner', '-encoders'], env),
    output('uv', ['--version'], env),
    // offline: only what uv has in its cache counts as there
    s.listenBack === false
      ? Promise.resolve(null)
      : output('uv', ['run', '--offline', '--quiet', '--no-project', ...whisper.uvArgs, 'python', '-c', `import importlib.util,sys; sys.exit(not importlib.util.find_spec(${JSON.stringify(whisper.module)}))`], env),
  ]);
  const items: SetupItem[] = [];

  const node = nodeOut?.trim();
  if (!node) items.push(missing('node'));
  else if (!atLeast(node, NODE_MIN)) items.push(missing('node', { found: node, need: `>= ${NODE_MIN.join('.')}` }));
  else items.push({ id: 'node', state: 'ok', found: node });

  if (!o.narrationOnly) {
    const playwright = resolvePlaywright();
    items.push(playwright ? { id: 'playwright', state: 'ok' } : missing('playwright'));
    const found = await browser(platform, env, playwright);
    if (found) items.push({ id: 'browser', state: 'ok', found });
    else items.push(missing('browser', env.DEMO_CHROME ? { found: env.DEMO_CHROME } : {}));
  }

  const ffmpeg = ffmpegOut?.match(/ffmpeg version (\S+)/)?.[1];
  if (!ffmpeg) items.push(missing('ffmpeg'));
  else if (!/\blibx264\b/.test(encoders ?? '')) items.push(missing('ffmpeg', { found: ffmpeg, need: 'libx264' }));
  else items.push({ id: 'ffmpeg', state: 'ok', found: ffmpeg });

  const uv = uvOut?.match(/uv (\S+)/)?.[1];
  items.push(uv ? { id: 'uv', state: 'ok', found: uv } : missing('uv'));

  const voice = installState(s, o.home);
  items.push(voice.installed ? { id: 'voice', state: 'ok', found: s.voice } : missing('voice', { found: `${s.voice}: ${voice.missing.join(', ')}`, mb: voice.mb }));

  if (s.listenBack === false) items.push({ id: 'whisper', state: 'off' });
  else {
    // the package from uv (with its dependencies), the model from Hugging Face
    const mb = (whisperOut === null ? (whisper.backend === 'mlx' ? 150 : 250) : 0) + (hfModelPresent(whisper.model) ? 0 : 1600);
    items.push({ id: 'whisper', state: mb ? 'later' : 'ok', found: whisper.module.replace('_', '-'), ...(mb ? { mb } : {}) });
  }
  return { platform, arch, items };
}

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
export const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

/** The check as the agent reads it, one line per piece and the commands under a missing one. */
export function describeSetup(check: SetupCheck): string {
  const mark = { ok: '✓', missing: '✗', later: '…', off: '–' };
  const what = (i: SetupItem) => {
    const found = [i.found, i.need && `needs ${i.need}`].filter(Boolean).join(', ');
    if (i.state === 'later') return `${found} — fetched on the first render, about ${i.mb} MB`;
    if (i.state === 'off') return 'listening back is off in the settings';
    if (i.state === 'missing') return found ? `${found} — ${i.id === 'voice' ? 'not installed' : 'not usable'}` : 'not found';
    return found;
  };
  const lines = [`Demo setup on ${platformName(check.platform)} (${check.arch}):`];
  for (const i of check.items) {
    lines.push(`  ${mark[i.state]} ${i.id.padEnd(10)} ${what(i)}`.trimEnd());
    if (i.state !== 'missing' || !i.install) continue;
    for (const c of i.install.commands) lines.push(`      ${c}`);
    if (i.install.url) lines.push(`      see ${i.install.url}`);
    if (i.id === 'voice') lines.push("      or install it in Obeya's settings (Konfiguration → Demos)");
  }
  const missing = check.items.filter((i) => i.state === 'missing');
  lines.push(missing.length ? `Missing: ${missing.map((i) => i.id).join(', ')}. A render stops until they are installed.` : 'Ready to record.');
  return lines.join('\n');
}

if (import.meta.filename === process.argv[1] || (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename)) {
  const check = await checkSetup(withVoice(readDemoSettings(), process.env.DEMO_VOICE));
  console.log(describeSetup(check));
  process.exitCode = check.items.some((i) => i.state === 'missing') ? 1 : 0;
}
