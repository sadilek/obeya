// Checks that the installed app updates itself (app/src/update.rs) on this machine: it builds the
// app twice with scripts/build-app.ts, as version 0.0.1 and 0.0.2, both with an updater that asks
// a local server instead of GitHub and trusts a key pair made for the check; installs the first
// (macOS: the app in a scratch directory; Windows: the NSIS installer, silently, for this user;
// Linux: the AppImage in a scratch directory), and serves the second as the release the first
// finds. Then, on a scratch home:
//   - the app finds 0.0.2, downloads it and its server shows it (`GET /api/app-update`);
//   - installing it (`POST /api/app-update/install`, the bar's button) ends the server, the shell
//     installs the update and starts the app again: the installed program is now 0.0.2's, and a
//     server it started answers on the home;
//   - the new version finds nothing newer;
//   - `POST /api/stop` ends it.
// On Windows the installer starts the new version as the desktop's user, without this script's
// environment, so it runs on the default home (~/.obeya): run it there only where no Obeya uses it.
//
//   bun scripts/check-update.ts [--dir <dir>] [--reuse] [--keep]
//
// --dir keeps the builds there, and --reuse takes them from there instead of building again (each
// build takes some minutes). Needs what scripts/build-app.ts needs. Prints one line per check;
// exits 1 when one failed.

import { type Subprocess } from 'bun';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const BUNDLE = join(ROOT, 'app', 'target', 'release', 'bundle');
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: [process.env.PATH ?? '', ...(existsSync(cargoBin) ? [cargoBin] : [])].join(delimiter) };

let failed = 0;
const ok = (what: string, detail = '') => console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`);
const bad = (what: string, detail: string) => {
  failed++;
  console.log(`✗ ${what}: ${detail}`);
};
const check = async (what: string, fn: () => Promise<string | void> | string | void) => {
  try {
    ok(what, (await fn()) ?? '');
    return true;
  } catch (e) {
    bad(what, e instanceof Error ? e.message : String(e));
    return false;
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
    await sleep(500);
  }
}
const hash = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');
function run(cmd: string[], cwd = ROOT, more: Record<string, string> = {}) {
  console.log(`$ ${cmd.map((c) => (c.length > 80 ? `${c.slice(0, 77)}...` : c)).join(' ')}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', env: { ...env, ...more } });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (exit ${r.exitCode})`);
}

// ---------------------------------------------------------------- two versions, one key pair
// without symlinks (macOS's /tmp is one): Tauri refuses to run from a path that has one
const dir = (() => {
  const d = resolve(opt('dir') ?? mkdtempSync(join(tmpdir(), 'obeya-update-check-')));
  mkdirSync(d, { recursive: true });
  return realpathSync(d);
})();
const OLD = '0.0.1';
const NEW = '0.0.2';
/** What is installed of each version, and what the update of the new one is. */
const made = { old: join(dir, 'old'), new: join(dir, 'new') };
const reuse = args.includes('--reuse') && existsSync(join(dir, 'port')) && existsSync(made.old) && existsSync(made.new);
const port = reuse ? Number(readFileSync(join(dir, 'port'), 'utf8')) : await freePort();
async function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

/** The installer, the update and the program each build leaves, by platform. */
const one = (sub: string, end: string) => {
  const f = readdirSync(join(BUNDLE, sub)).find((f) => f.endsWith(end));
  if (!f) throw new Error(`no ${end} in ${join(BUNDLE, sub)}`);
  return join(BUNDLE, sub, f);
};
const UPDATE = { darwin: 'Obeya.app.tar.gz', windows: 'Obeya-setup.exe', linux: 'Obeya.AppImage' }[os];

if (!reuse) {
  run([process.execPath, 'x', 'tauri', 'signer', 'generate', '--ci', '-f', '-w', join(dir, 'check.key')], join(ROOT, 'app'));
  const pubkey = readFileSync(join(dir, 'check.key.pub'), 'utf8').trim();
  const config = (version: string) =>
    JSON.stringify({ version, plugins: { updater: { pubkey, endpoints: [`http://127.0.0.1:${port}/latest.json`], dangerousInsecureTransportProtocol: true } } });
  const bundles = { darwin: 'app', windows: 'nsis', linux: 'appimage' }[os];
  for (const [version, to] of [
    [OLD, made.old],
    [NEW, made.new],
  ] as const) {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    const signing: Record<string, string> = version === NEW ? { TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(dir, 'check.key'), 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' } : {};
    run([process.execPath, 'scripts/build-app.ts', '--bundles', bundles, '--config', config(version)], ROOT, signing);
    if (os === 'darwin') cpSync(join(BUNDLE, 'macos', 'Obeya.app'), join(to, 'Obeya.app'), { recursive: true, verbatimSymlinks: true });
    if (os === 'windows') cpSync(one('nsis', '-setup.exe'), join(to, 'Obeya-setup.exe'));
    if (os === 'linux') cpSync(one('appimage', '.AppImage'), join(to, 'Obeya.AppImage'));
    if (version === NEW) {
      const update = os === 'darwin' ? join(BUNDLE, 'macos', 'Obeya.app.tar.gz') : os === 'windows' ? one('nsis', '-setup.exe') : one('appimage', '.AppImage');
      cpSync(update, join(to, UPDATE));
      cpSync(`${update}.sig`, join(to, `${UPDATE}.sig`));
    }
  }
  writeFileSync(join(dir, 'port'), String(port));
}

// ---------------------------------------------------------------- the release the old one finds
const platform = { darwin: 'darwin', windows: 'windows', linux: 'linux' }[os] + '-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
let fetched = 0;
const releases = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/latest.json')
      return Response.json({
        version: NEW,
        notes: '- The check found this version.',
        pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        platforms: { [platform]: { url: `http://127.0.0.1:${port}/${UPDATE}`, signature: readFileSync(join(made.new, `${UPDATE}.sig`), 'utf8').trim() } },
      });
    if (path === `/${UPDATE}`) {
      fetched++;
      return new Response(Bun.file(join(made.new, UPDATE)));
    }
    return new Response('Not found', { status: 404 });
  },
});

// ---------------------------------------------------------------- the old version, installed
const home = join(dir, 'home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home);
const installed = join(dir, 'installed');
rmSync(installed, { recursive: true, force: true });
mkdirSync(installed);
let program: string;
/** What tells the versions apart once installed: the shell's program (the AppImage on Linux); on Windows its file version. */
let shell: string;
const ofNew: string | null = os === 'darwin' ? join(made.new, 'Obeya.app', 'Contents', 'MacOS', 'obeya') : os === 'windows' ? null : join(made.new, 'Obeya.AppImage');
const fileVersion = (exe: string) =>
  Bun.spawnSync(['powershell', '-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]).stdout.toString().trim();
/** Whether the installed program is the new version's. */
const isNew = () => (ofNew ? hash(shell) === hash(ofNew) : fileVersion(shell) === NEW);
if (os === 'darwin') {
  cpSync(join(made.old, 'Obeya.app'), join(installed, 'Obeya.app'), { recursive: true, verbatimSymlinks: true });
  program = shell = join(installed, 'Obeya.app', 'Contents', 'MacOS', 'obeya');
} else if (os === 'windows') {
  // the NSIS installer installs for this user, where the update's installer puts it again
  run([join(made.old, 'Obeya-setup.exe'), '/S']);
  program = shell = join(process.env.LOCALAPPDATA ?? '', 'Obeya', 'obeya.exe');
} else {
  cpSync(join(made.old, 'Obeya.AppImage'), join(installed, 'Obeya.AppImage'));
  program = shell = join(installed, 'Obeya.AppImage');
}
const before = hash(shell);

/** Where the app runs: the scratch home, and on Windows after the update the default one (see the top). */
let homeNow = home;
const serverEntry = () => {
  try {
    return JSON.parse(readFileSync(join(homeNow, 'server.json'), 'utf8')) as { pid: number; port: number; app?: boolean };
  } catch {
    return null;
  }
};
const api = async (method: string, path: string) => {
  const entry = serverEntry();
  if (!entry) return null;
  const res = await fetch(`http://127.0.0.1:${entry.port}${path}`, { method, signal: AbortSignal.timeout(5000) });
  return res.ok ? (res.status === 204 ? {} : await res.json()) : null;
};

let app: Subprocess | undefined;
try {
  await check(`the installed app is ${OLD}`, () => {
    expect(existsSync(program), `${program} is not there`);
    expect(!isNew(), `the installed program is ${NEW}'s already`);
    return program;
  });
  app = Bun.spawn([program], {
    env: { ...process.env, OBEYA_HOME: home, OBEYA_PORT: String(await freePort()), OBEYA_UPDATE_EVERY: '5', APPIMAGE_EXTRACT_AND_RUN: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const first = await until('the app starts its server', 120_000, () => serverEntry());
  const found = await check(`the app finds ${NEW}, downloads it, and its server shows it`, async () => {
    const update = await until('the update in the server', 120_000, async () => {
      const u = (await api('GET', '/api/app-update')) as { version?: string; download?: string } | null;
      return u?.version ? u : null;
    });
    expect(update.version === NEW, `the server shows ${update.version}`);
    expect(!update.download, 'the app says it cannot install it');
    expect(fetched === 1, `the update was fetched ${fetched} times`);
    return `pid ${first.pid}`;
  });
  if (found) {
    await check(`installing it ends the server, replaces the app with ${NEW} and starts it again`, async () => {
      const asked = (await api('POST', '/api/app-update/install')) as { updating?: boolean } | null;
      expect(asked?.updating, `the server answered ${JSON.stringify(asked)}`);
      const exited = await Promise.race([app!.exited, sleep(120_000).then(() => null)]);
      expect(exited !== null, 'the old app did not end');
      if (os === 'windows') homeNow = join(homedir(), '.obeya');
      // the Windows installer is still at work when the old app has ended
      await until(`the installed program as ${NEW}'s`, 120_000, () => existsSync(shell) && hash(shell) !== before && isNew()).catch((e) => {
        throw os === 'windows' ? new Error(`${e.message} (its version: ${fileVersion(shell)})`) : e;
      });
      const again = await until('a server of the new app', 180_000, async () => {
        const e = serverEntry();
        return e && e.pid !== first.pid && (await api('GET', '/api/canvases')) ? e : null;
      });
      return `exit ${exited}, then pid ${again.pid}`;
    });
    await check('the new version finds nothing newer', async () => {
      await sleep(12_000);
      const u = await api('GET', '/api/app-update');
      expect(u === null, `the server shows ${JSON.stringify(u)}`);
    });
  }
  await check('the app ends with its server', async () => {
    await api('POST', '/api/stop');
    await until('the home left', 60_000, () => !serverEntry());
  });
} finally {
  if (app && app.exitCode === null) app.kill();
  releases.stop(true);
  if (os === 'windows') Bun.spawnSync([join(process.env.LOCALAPPDATA ?? '', 'Obeya', 'uninstall.exe'), '/S']);
  if (!args.includes('--keep') && !opt('dir')) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
