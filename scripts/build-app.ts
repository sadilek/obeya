// Obeya as an app: the compiled server (scripts/build.ts) as the sidecar of the Tauri shell in app/,
// bundled into what installs on this platform. Unsigned (signing is the release's job): a DMG on
// macOS (the app inside signed ad hoc), an NSIS installer on Windows, an AppImage and a .deb on Linux.
//
//   bun scripts/build-app.ts [<target>] [--bundles <dmg,app,nsis,appimage,deb>] [--debug] [--verbose]
//
// The target is this machine's by default (see scripts/build.ts); another needs Rust's target for it
// and Tauri's tools for cross-building. Needs Rust (rustup) and, on Linux, WebKitGTK's development
// files (libwebkit2gtk-4.1-dev and the rest Tauri lists) and ALSA's (libasound2-dev, for the
// push-to-talk key's microphone). The bundles end up in
// app/target/[<triple>/]release/bundle/.
//
// With TAURI_SIGNING_PRIVATE_KEY set (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, if the key has one),
// it also signs what Tauri's updater installs, each with a `.sig` beside it: Obeya.app.tar.gz on
// macOS (packed here), the NSIS installer on Windows, the AppImage on Linux (a .deb is not updated).
// It signs them itself: Tauri's own update artifacts need the updater plugin's configuration, and
// its signature of the AppImage would be of the one without the server.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import pkg from '../package.json';

const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'windows-x64': 'x86_64-pc-windows-msvc',
} as const;
type Target = keyof typeof TRIPLES;

const ROOT = resolve(import.meta.dir, '..');
const APP = join(ROOT, 'app');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}` as Target;
const target = (args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--bundles')) ?? here) as Target;
if (!(target in TRIPLES)) fail(`unknown target ${target} (known: ${Object.keys(TRIPLES).join(', ')})`);
const triple = TRIPLES[target];
const os = target.split('-')[0];
const bundles = opt('bundles') ?? (os === 'darwin' ? 'dmg' : os === 'windows' ? 'nsis' : 'appimage,deb');

function fail(msg: string): never {
  console.error(`build-app: ${msg}`);
  process.exit(1);
}

function run(cmd: string[], cwd = ROOT, env: Record<string, string> = {}) {
  console.log(`$ ${cmd.join(' ')}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } });
  if (r.exitCode !== 0) fail(`${cmd[0]} failed (exit ${r.exitCode})`);
}

const started = Date.now();
const dist = join(ROOT, 'dist');
run([process.execPath, 'scripts/build.ts', target, '--out', dist]);
const built = join(dist, `obeya-${pkg.version}-${target}`);
const exe = os === 'windows' ? '.exe' : '';

// where tauri.conf.json takes them from: the sidecar by Tauri's naming, the resources as they are
mkdirSync(join(APP, 'binaries'), { recursive: true });
cpSync(join(built, `obeya${exe}`), join(APP, 'binaries', `obeya-server-${triple}${exe}`));
rmSync(join(APP, 'staged'), { recursive: true, force: true });
cpSync(join(built, 'resources'), join(APP, 'staged', 'resources'), { recursive: true });
// on Linux the server goes among the resources (app/tauri.linux.conf.json), not into usr/bin
if (os === 'linux') cpSync(join(built, 'obeya'), join(APP, 'staged', 'obeya-server'));

const cross = target !== here;
const out = join(APP, 'target', ...(cross ? [triple] : []), args.includes('--debug') ? 'debug' : 'release', 'bundle');
// a bundle of an earlier build is no part of this one (the AppImage's AppDir would be reused)
rmSync(out, { recursive: true, force: true });
const tauri = (bundles: string, ...more: string[]) =>
  run(
    [process.execPath, 'x', 'tauri', 'build', '--bundles', bundles, ...(cross ? ['--target', triple] : []), ...(args.includes('--debug') ? ['--debug'] : []), ...(args.includes('--verbose') ? ['--verbose'] : []), ...more],
    APP,
    { CI: 'true' },
  );
const wanted = bundles.split(',');
// the updater's archive is of the app, which a DMG's build does not leave in bundle/macos
if (os === 'darwin' && process.env.TAURI_SIGNING_PRIVATE_KEY && !wanted.includes('app')) wanted.unshift('app');
if (wanted.includes('appimage')) {
  if (wanted.length > 1) tauri(wanted.filter((b) => b !== 'appimage').join(','));
  // linuxdeploy sets the library path of every program in the AppDir, which breaks Bun's compiled
  // binary (its code sits after the ELF's end): the AppImage is built without the server, which goes
  // into the AppDir afterwards, and packed again
  tauri('appimage', '--config', JSON.stringify({ bundle: { resources: { 'staged/obeya-server': null } } }));
  const appdir = join(out, 'appimage', `Obeya.AppDir`);
  const server = join(appdir, 'usr', 'lib', 'Obeya', 'obeya-server');
  cpSync(join(APP, 'staged', 'obeya-server'), server);
  chmodSync(server, 0o755);
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'tauri');
  const packer = readdirSync(cache).find((f) => f.startsWith('linuxdeploy-plugin-appimage') && f.endsWith('.AppImage'));
  if (!packer) fail(`no linuxdeploy-plugin-appimage in ${cache}`);
  const image = readdirSync(join(out, 'appimage')).find((f) => f.endsWith('.AppImage'));
  if (!image) fail('Tauri wrote no AppImage');
  run([join(cache, packer), '--appdir', appdir], join(out, 'appimage'), { OUTPUT: image, ARCH: target.endsWith('arm64') ? 'aarch64' : 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' });
} else tauri(wanted.join(','));

if (!existsSync(out)) fail(`${out} was not written`);

if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const sign = (file: string) => run([process.execPath, 'x', 'tauri', 'signer', 'sign', file], APP);
  const one = (sub: string, end: string) => {
    const f = existsSync(join(out, sub)) && readdirSync(join(out, sub)).find((f) => f.endsWith(end));
    return f ? join(out, sub, f) : fail(`no ${end} in ${join(out, sub)} to sign for the updater`);
  };
  if (os === 'darwin') {
    // as Tauri packs it: the app at the archive's top, without macOS's ._ files
    run(['tar', '-czf', 'Obeya.app.tar.gz', 'Obeya.app'], join(out, 'macos'), { COPYFILE_DISABLE: '1' });
    sign(join(out, 'macos', 'Obeya.app.tar.gz'));
  } else if (os === 'windows' && wanted.includes('nsis')) sign(one('nsis', '-setup.exe'));
  else if (wanted.includes('appimage')) sign(one('appimage', '.AppImage'));
}
console.log(`\n${out}\nbuilt in ${((Date.now() - started) / 1000).toFixed(0)} s`);
