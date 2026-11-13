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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recorded } from '../src/server/instance';
import { ownerHeaders } from '../src/server/owner';
import { check, exited, expect, finish, sleep, until } from './check-harness';
import { cargoPath, ROOT, script } from './common';
import { bundled, here, TARGETS } from './targets';

const { fail, args, run } = script('check-update');
const { values: options } = args({ dir: { type: 'string' }, reuse: { type: 'boolean' }, keep: { type: 'boolean' } });
const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const BUNDLE = join(ROOT, 'app', 'target', 'release', 'bundle');
const PATH = cargoPath();

const hash = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');

// ---------------------------------------------------------------- two versions, one key pair
// without symlinks (macOS's /tmp is one): Tauri refuses to run from a path that has one
const dir = (() => {
  const d = resolve(options.dir ?? mkdtempSync(join(tmpdir(), 'obeya-update-check-')));
  mkdirSync(d, { recursive: true });
  return realpathSync(d);
})();
const OLD = '0.0.1';
const NEW = '0.0.2';
/** What is installed of each version, and what the update of the new one is. */
const made = { old: join(dir, 'old'), new: join(dir, 'new') };
const reuse = !!options.reuse && existsSync(join(dir, 'port')) && existsSync(made.old) && existsSync(made.new);
const port = reuse ? Number(readFileSync(join(dir, 'port'), 'utf8')) : await freePort();
async function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

const { platform, update } = TARGETS[here()];
/** The update of this platform, as the new version is served and, but on macOS, as each version is installed. */
const UPDATE = `Obeya${update.ends}`;
const built = () => bundled(BUNDLE, update) ?? fail(`no ${update.ends} in ${join(BUNDLE, update.from)}`);

if (!reuse) {
  run([process.execPath, 'x', 'tauri', 'signer', 'generate', '--ci', '-f', '-w', join(dir, 'check.key')], { cwd: join(ROOT, 'app'), env: { PATH } });
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
    run([process.execPath, 'scripts/build-app.ts', '--bundles', bundles, '--config', config(version)], { env: { PATH, ...signing } });
    // what is installed: the app on macOS; elsewhere the update is the installer
    if (os === 'darwin') cpSync(join(BUNDLE, 'macos', 'Obeya.app'), join(to, 'Obeya.app'), { recursive: true, verbatimSymlinks: true });
    if (os !== 'darwin' || version === NEW) cpSync(built(), join(to, UPDATE));
    if (version === NEW) cpSync(`${built()}.sig`, join(to, `${UPDATE}.sig`));
  }
  writeFileSync(join(dir, 'port'), String(port));
}

// ---------------------------------------------------------------- the release the old one finds
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
const serverEntry = () => recorded(homeNow);
/** What the app's server answers, null when none runs or it refuses. */
const api = async (method: string, path: string) => {
  const entry = serverEntry();
  if (!entry) return null;
  const res = await fetch(`${entry.url}${path}`, { method, headers: ownerHeaders(homeNow), signal: AbortSignal.timeout(5000) });
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
      const code = await exited(app!, 120_000);
      expect(code !== null, 'the old app did not end');
      if (os === 'windows') homeNow = join(homedir(), '.obeya');
      // the Windows installer is still at work when the old app has ended
      await until(`the installed program as ${NEW}'s`, 120_000, () => existsSync(shell) && hash(shell) !== before && isNew()).catch((e) => {
        throw os === 'windows' ? new Error(`${e.message} (its version: ${fileVersion(shell)})`) : e;
      });
      const again = await until('a server of the new app', 180_000, async () => {
        const e = serverEntry();
        return e && e.pid !== first.pid && (await api('GET', '/api/canvases')) ? e : null;
      });
      return `exit ${code}, then pid ${again.pid}`;
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
  if (!options.keep && !options.dir) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
finish();
