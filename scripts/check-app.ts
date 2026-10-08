// Checks the installed app (scripts/build-app.ts) on this machine, in the webview it has here
// (WKWebView, WebView2, WebKitGTK): what the page needs from the webview, and how the shell starts,
// shares and stops Obeya.
//
//   bun scripts/check-app.ts <the app's program> [--fake-mic] [--screenshot <png>] [--keep]
//
// The program is Obeya.app/Contents/MacOS/obeya, obeya.exe where the installer put it, the AppImage,
// or /usr/bin/obeya from the .deb. On a scratch repository and a scratch home it checks:
//   - the app starts its server and its window shows the canvas, which knows it runs in the app;
//   - the microphone: the page gets a stream without being asked, and MediaRecorder records it, as
//     voice.tsx does (--fake-mic gives WebView2 Chromium's fake device, for a machine without one;
//     on Linux a PulseAudio source is needed, a null sink's monitor will do);
//   - a demo video (H.264 and AAC in MP4, as the demo skill renders it) plays;
//   - the settings offer "Im Browser öffnen" (--screenshot takes the window with them open);
//   - starting the app a second time brings the first to the front and ends;
//   - `POST /api/stop` ends the server and then the app, and the home has no entry left;
//   - with an Obeya already running on the home (started from a terminal), the app opens a window
//     on it instead of starting another, and quitting the app leaves it running.
// The page reports through OBEYA_APP_CHECK (app/src/main.rs), which imports this script's module.
// Prints one line per check; exits 1 when one failed. Needs ffmpeg (for the video) and git.

import { type Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const programArg = args.find((a) => !a.startsWith('--'));
if (!programArg) {
  console.error('usage: bun scripts/check-app.ts <the app\'s program> [--fake-mic] [--screenshot <png>] [--keep]');
  process.exit(2);
}
const program = resolve(programArg);
const win = process.platform === 'win32';

let failed = 0;
const ok = (what: string, detail = '') => console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`);
const bad = (what: string, detail: string) => {
  failed++;
  console.log(`✗ ${what}: ${detail}`);
};
const check = async (what: string, fn: () => Promise<string | void> | string | void) => {
  try {
    ok(what, (await fn()) ?? '');
  } catch (e) {
    bad(what, e instanceof Error ? e.message : String(e));
  }
};
const expect = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
    await sleep(250);
  }
}
const exited = (p: Subprocess, ms: number) => Promise.race([p.exited, sleep(ms).then(() => null)]);

// ---------------------------------------------------------------- a scratch repository and home
const dir = mkdtempSync(join(tmpdir(), 'obeya-app-check-'));
const repo = join(dir, 'repo');
const home = join(dir, 'home');
mkdirSync(join(repo, 'docs', 'plan'), { recursive: true });
writeFileSync(join(repo, 'docs', 'plan', 'check.md'), '# The app check\n\n## Workstreams\n\n- [ ] **W1:** Something to show.\n');
const git = (...a: string[]) => {
  const r = Bun.spawnSync(['git', '-C', repo, ...a], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`);
};
git('init', '-q', '-b', 'main');
git('-c', 'user.name=Check', '-c', 'user.email=check@example.com', 'add', '.');
git('-c', 'user.name=Check', '-c', 'user.email=check@example.com', 'commit', '-qm', 'init');
mkdirSync(home);
writeFileSync(join(home, 'canvases.json'), JSON.stringify([{ name: 'App check', repos: [{ path: repo }] }]));

// a demo video as the skill renders one: H.264 and AAC in MP4
const video = join(dir, 'demo.mp4');
const ff = Bun.spawnSync(
  ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', video],
  { stderr: 'pipe' },
);
if (ff.exitCode !== 0) {
  console.error(`ffmpeg could not make the video: ${ff.stderr.toString()}`);
  process.exit(2);
}

// ---------------------------------------------------------------- what the page runs, and where it reports
const reports: Record<string, unknown>[] = [];
const MODULE = `
const report = (r) => fetch(new URL('/result', import.meta.url), { method: 'POST', body: JSON.stringify(r) });
const out = { app: window.obeyaApp ?? null, location: location.href, userAgent: navigator.userAgent };
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start();
  await new Promise((r) => setTimeout(r, 1500));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  out.mic = { ok: true, mimeType: recorder.mimeType, bytes: chunks.reduce((n, c) => n + c.size, 0), device: stream.getAudioTracks()[0]?.label ?? '' };
} catch (e) {
  out.mic = { ok: false, error: String(e) };
}
try {
  const v = document.createElement('video');
  v.muted = true;
  v.src = new URL('/demo.mp4', import.meta.url).href;
  out.video = { canPlay: v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') };
  await v.play();
  await new Promise((r) => setTimeout(r, 1500));
  out.video = { ...out.video, ok: v.currentTime > 0.5 && v.videoWidth === 640, currentTime: v.currentTime, width: v.videoWidth };
  v.pause();
} catch (e) {
  out.video = { ...out.video, ok: false, error: String(e) };
}
// the settings, opened as the owner would, offer the browser
const button = [...document.querySelectorAll('#bar button')].find((b) => /^(Konfiguration|Configuration)$/.test(b.textContent));
button?.click();
await new Promise((r) => setTimeout(r, 1000));
out.browserButton = [...document.querySelectorAll('button')].some((b) => /^(Im Browser öffnen|Open in browser)$/.test(b.textContent));
await report(out);
`;
const harness = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const cors = { 'access-control-allow-origin': '*' };
    const path = new URL(req.url).pathname;
    if (path === '/check.js') return new Response(MODULE, { headers: { ...cors, 'content-type': 'text/javascript' } });
    if (path === '/demo.mp4') return new Response(Bun.file(video), { headers: { ...cors, 'content-type': 'video/mp4' } });
    if (path === '/result' && req.method === 'POST') {
      reports.push(JSON.parse(await req.text()));
      return new Response(null, { status: 204, headers: cors });
    }
    return new Response('Not found', { status: 404 });
  },
});

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  OBEYA_HOME: home,
  OBEYA_APP_CHECK: `${harness.url.href}check.js`,
  // a port of its own, so a running Obeya on this machine is not in the way
  OBEYA_PORT: String(4600 + Math.floor(Math.random() * 300)),
  ...(args.includes('--fake-mic') && win ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--use-fake-device-for-media-stream' } : {}),
};
delete env.OBEYA_SUPERVISED;
const entry = () => {
  try {
    return JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')) as { pid: number; port: number; url: string; app: boolean };
  } catch {
    return null;
  }
};
const startApp = () => Bun.spawn([program], { env, stdout: 'ignore', stderr: 'ignore' });
const answers = async (url: string) => (await fetch(`${url}/api/canvases`, { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok === true;

/** The app's window (macOS), else the screen, as a PNG. */
async function screenshot(pid: number, file: string) {
  await sleep(1500);
  let cmd: string[];
  if (process.platform === 'darwin') {
    const jxa = `ObjC.import('CoreGraphics');
      const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0));
      let id = '';
      for (let i = 0; i < list.count; i++) {
        const w = list.objectAtIndex(i);
        if (w.objectForKey('kCGWindowOwnerPID').js === ${pid} && w.objectForKey('kCGWindowLayer').js === 0) id = String(w.objectForKey('kCGWindowNumber').js);
      }
      id`;
    const id = Bun.spawnSync(['osascript', '-l', 'JavaScript', '-e', jxa]).stdout.toString().trim();
    expect(id, 'no window of the app');
    cmd = ['screencapture', '-x', '-o', `-l${id}`, file];
  } else if (win) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $p = New-Object System.Drawing.Bitmap $b.Width, $b.Height; [System.Drawing.Graphics]::FromImage($p).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $p.Save('${file}')`;
    cmd = ['powershell', '-NoProfile', '-Command', ps];
  } else cmd = ['import', '-window', 'root', file];
  const r = Bun.spawnSync(cmd, { stderr: 'pipe' });
  expect(r.exitCode === 0 && existsSync(file), r.stderr.toString() || 'no file');
  return file;
}

let app: Subprocess | undefined;
let server: Subprocess | undefined;
try {
  // ---------------------------------------------------------------- the app with its own server
  app = startApp();
  let url = '';
  await check('the app starts its server', async () => {
    const e = await until('an entry in the home', 60_000, entry);
    expect(e.app, 'the entry does not say the app started it');
    url = e.url;
    return `${e.url}, pid ${e.pid}`;
  });
  const page = await until('the page to report', 90_000, () => reports[0]).catch((e) => {
    bad('the window shows the canvas', String(e.message));
    return null;
  });
  if (page) {
    await check('the window shows the canvas, which knows it runs in the app', () => {
      expect(String(page.location).startsWith(url), `the window shows ${page.location}`);
      expect(page.app, 'window.obeyaApp is missing');
      return String(page.userAgent);
    });
    await check('the microphone records', () => {
      const mic = page.mic as { ok: boolean; error?: string; mimeType?: string; bytes?: number; device?: string };
      expect(mic.ok, mic.error ?? 'no stream');
      expect(mic.bytes! > 0, 'MediaRecorder recorded nothing');
      return `${mic.bytes} bytes of ${mic.mimeType || 'audio'} from ${mic.device || 'the default device'}`;
    });
    await check('a demo video plays', () => {
      const v = page.video as { ok: boolean; error?: string; canPlay?: string; currentTime?: number };
      expect(v.ok, v.error ?? `stood at ${v.currentTime} s`);
      return `canPlayType "${v.canPlay}", ${v.currentTime?.toFixed(1)} s in 1.5 s`;
    });
    await check('the settings offer "Im Browser öffnen"', () => expect(page.browserButton, 'no such button'));
    const shot = args[args.indexOf('--screenshot') + 1];
    if (args.includes('--screenshot') && shot) await check('a screenshot of the window', () => screenshot(app!.pid, resolve(shot)));
  }
  await check('starting the app again leaves the first in front and ends', async () => {
    const pid = entry()?.pid;
    const second = startApp();
    const code = await exited(second, 20_000);
    expect(code !== null, 'the second start is still running');
    expect(entry()?.pid === pid, 'the server changed');
    expect(app!.exitCode === null, 'the first app ended');
    return `exit ${code}`;
  });
  await check('stopping over HTTP ends the server, then the app', async () => {
    const res = await fetch(`${url}/api/stop`, { method: 'POST' });
    expect(res.ok, `POST /api/stop: ${res.status}`);
    const code = await exited(app!, 30_000);
    expect(code !== null, 'the app is still running');
    expect(!entry(), 'the home still names a server');
    return `the app ended with ${code}`;
  });

  // ---------------------------------------------------------------- an Obeya from a terminal on the same home
  const sidecar = [join(dirname(program), win ? 'obeya-server.exe' : 'obeya-server'), resolve(dirname(program), '..', 'lib', 'Obeya', 'obeya-server')].find((f) => existsSync(f)) ?? '';
  if (existsSync(sidecar)) {
    reports.length = 0;
    const resources = [join(dirname(program), 'resources'), resolve(dirname(program), '..', 'Resources', 'resources'), resolve(dirname(program), '..', 'lib', 'Obeya', 'resources')].find((d) => existsSync(d));
    server = Bun.spawn([sidecar, '--port', env.OBEYA_PORT!], { env: { ...env, ...(resources ? { OBEYA_RESOURCES: resources } : {}) }, stdout: 'ignore', stderr: 'ignore' });
    const e = await until('the terminal\'s Obeya', 60_000, () => entry()?.pid === server!.pid && entry());
    app = startApp();
    await check('with an Obeya running on the home, the app opens a window on it', async () => {
      const page = await until('the page to report', 90_000, () => reports[0]);
      expect(String(page.location).startsWith(e.url), `the window shows ${page.location}`);
      expect(entry()?.pid === server!.pid, 'another server took the home');
    });
    await check('quitting the app leaves that Obeya running', async () => {
      app!.kill();
      await exited(app!, 10_000);
      expect(await answers(e.url), 'it does not answer');
    });
    await fetch(`${e.url}/api/stop`, { method: 'POST' }).catch(() => {});
    await exited(server, 30_000);
  } else console.log('- the app beside an Obeya from a terminal: not checked (the AppImage keeps its server inside)');
} finally {
  app?.kill();
  server?.kill();
  harness.stop(true);
  if (args.includes('--keep')) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
