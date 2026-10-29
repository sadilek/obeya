// The app's shell (app/) started from the checkout: it opens a window on the Obeya that runs on
// the home, or starts this checkout's server (`bun src/server/main.ts`, which updates itself from
// the checkout as `bun start` does) and stops it when the app quits. No compiled server and no
// installer: those are scripts/build-app.ts.
//
//   bun run app [--debug]            builds the shell and runs it from this terminal
//   bun run app install [--no-open]  installs it as an app of its own, "Obeya (checkout)", and opens it
//
// install builds the shell with this checkout, the bun that runs it and the version of app/ on HEAD
// (and the commit, which the settings show) compiled in, and puts it where the system starts apps from: ~/Applications on a Mac (Spotlight,
// Launchpad, the Dock), the applications menu on Linux (~/.local/share/obeya-checkout and a .desktop
// file in ~/.local/share/applications), the Start menu on Windows (%LOCALAPPDATA%\Programs\Obeya
// checkout). Started from there, it runs this checkout's server as `bun run app` does. Once app/ on
// HEAD is another than it was built from, the installed shell runs `install --no-open` itself in the
// background and starts again with the new build (app/src/update.rs); everything else follows HEAD
// through the server's own self-update. --build-only builds it without installing.
//
// Needs Rust (rustup) and, on Linux, WebKitGTK's development files, as scripts/build-app.ts says.
// The first build takes some minutes; it goes into app/target/checkout/ and is reused after that.

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { replace } from './app-replace';
import { cargoPath } from './common';

const ROOT = resolve(import.meta.dir, '..');
const APP = join(ROOT, 'app');
const args = process.argv.slice(2);
const install = args[0] === 'install';
const debug = args.includes('--debug');
const target = join(APP, 'target', 'checkout');
/** What the installed app is called; its identifier keeps it apart from an installed release of Obeya (permissions, single instance). */
const NAME = 'Obeya (checkout)';
const IDENTIFIER = 'si.obeya.checkout';

function fail(msg: string): never {
  console.error(`app: ${msg}`);
  process.exit(1);
}

// the shell alone: the server is this checkout's, not a sidecar, and there are no resources to bundle
const config: Record<string, unknown> = { bundle: { externalBin: null, resources: null } };
const env: Record<string, string | undefined> = { ...process.env, PATH: cargoPath(), CARGO_TARGET_DIR: target, CI: 'true' };
if (install) {
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(['git', ...a], { cwd: ROOT, stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString().trim() : '';
  };
  Object.assign(config, { identifier: IDENTIFIER });
  Object.assign(env, {
    // compiled in (option_env! in app/src/main.rs and update.rs): started from the desktop, the shell gets no environment of ours
    OBEYA_BUILT_CHECKOUT: ROOT,
    // the one the installed shell names when it builds itself anew (started from the desktop, its PATH
    // has none), else the PATH's (Homebrew's link, say) rather than the binary it points at, which an upgrade removes
    OBEYA_BUILT_BUN: process.env.OBEYA_BUN || Bun.which('bun') || process.execPath,
    OBEYA_BUILT_TREE: git('rev-parse', 'HEAD:app'),
    // for the settings, which show it
    OBEYA_BUILT_COMMIT: git('rev-parse', 'HEAD'),
  });
}
// on a Mac an app bundle (Info.plist, icon, the system's permissions for it); elsewhere the program is all there is
const bundle = install && process.platform === 'darwin' ? ['--bundles', 'app'] : ['--no-bundle'];
const build = Bun.spawnSync([process.execPath, 'x', 'tauri', 'build', ...bundle, '--config', JSON.stringify(config), ...(debug ? ['--debug'] : [])], {
  cwd: APP,
  stdout: 'inherit',
  stderr: 'inherit',
  env,
});
if (build.exitCode !== 0) fail('the shell did not build (Rust from https://rustup.rs is needed)');

const built = join(target, debug ? 'debug' : 'release');
const program = join(built, process.platform === 'win32' ? 'obeya.exe' : 'obeya');

if (!install) {
  const shell = Bun.spawn([program], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, OBEYA_CHECKOUT: ROOT, OBEYA_BUN: process.execPath },
  });
  process.exit(await shell.exited);
}

if (args.includes('--build-only')) process.exit(0);

/** Puts `from` at `to`, also while the app at `to` runs (app-replace.ts). */
function put(from: string, to: string) {
  try {
    replace(from, to);
  } catch (e) {
    fail((e as Error).message);
  }
}

let start: string[];
if (process.platform === 'darwin') {
  const apps = join(homedir(), 'Applications');
  mkdirSync(apps, { recursive: true });
  const dest = join(apps, `${NAME}.app`);
  put(join(built, 'bundle', 'macos', 'Obeya.app'), dest);
  console.log(`app: installed ${dest}`);
  start = ['open', dest];
} else if (process.platform === 'win32') {
  const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Obeya checkout');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'obeya.exe');
  put(program, exe);
  const menu = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const link = join(menu, `${NAME}.lnk`);
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const made = Bun.spawnSync([
    'powershell',
    '-NoProfile',
    '-Command',
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(link)}); $s.TargetPath = ${quote(exe)}; $s.WorkingDirectory = ${quote(dir)}; $s.Save()`,
  ]);
  if (made.exitCode !== 0) fail(`could not put ${NAME} into the Start menu: ${made.stderr.toString().trim()}`);
  console.log(`app: installed ${exe}, in the Start menu as ${NAME}`);
  start = [exe];
} else {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const dir = join(data, 'obeya-checkout');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'obeya');
  put(program, exe);
  const icon = join(dir, 'obeya.png');
  copyFileSync(join(APP, 'icons', '128x128@2x.png'), icon);
  const entries = join(data, 'applications');
  mkdirSync(entries, { recursive: true });
  const desktop = ['[Desktop Entry]', 'Type=Application', `Name=${NAME}`, 'Comment=A canvas for directing AI coding agents', `Exec="${exe}"`, `Icon=${icon}`, 'Terminal=false', 'Categories=Development;', 'StartupWMClass=obeya', ''];
  writeFileSync(join(entries, 'obeya-checkout.desktop'), desktop.join('\n'));
  if (Bun.which('update-desktop-database')) Bun.spawnSync(['update-desktop-database', entries]);
  console.log(`app: installed ${exe}, in the applications menu as ${NAME}`);
  start = [exe];
}

if (!args.includes('--no-open')) {
  // on its own, not as a child of this script, which ends now
  spawn(start[0]!, start.slice(1), { detached: true, stdio: 'ignore' }).unref();
}
