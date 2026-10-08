// Obeya as an app: the compiled server (scripts/build.ts) as the sidecar of the Tauri shell in app/,
// bundled into what installs on this platform. Unsigned (signing is the release's job): a DMG on
// macOS (the app inside signed ad hoc), an NSIS installer on Windows, an AppImage and a .deb on Linux.
//
//   bun scripts/build-app.ts [<target>] [--bundles <dmg,app,nsis,appimage,deb>] [--debug]
//
// The target is this machine's by default (see scripts/build.ts); another needs Rust's target for it
// and Tauri's tools for cross-building. Needs Rust (rustup) and, on Linux, WebKitGTK's development
// files (libwebkit2gtk-4.1-dev and the rest Tauri lists). The bundles end up in
// app/target/[<triple>/]release/bundle/.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

const cross = target !== here;
const tauri = [process.execPath, 'x', 'tauri', 'build', '--bundles', bundles, ...(cross ? ['--target', triple] : []), ...(args.includes('--debug') ? ['--debug'] : [])];
run(tauri, APP, { CI: 'true' });

const out = join(APP, 'target', ...(cross ? [triple] : []), args.includes('--debug') ? 'debug' : 'release', 'bundle');
if (!existsSync(out)) fail(`${out} was not written`);
console.log(`\n${out}\nbuilt in ${((Date.now() - started) / 1000).toFixed(0)} s`);
