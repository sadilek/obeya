// The app's shell (app/) started from the checkout, for its push-to-talk key anywhere on the
// machine: it opens a window on the Obeya that runs on the home, or starts this checkout's server
// (`bun src/server/main.ts`, which updates itself from the checkout as `bun start` does) and stops
// it when the app quits. No compiled server and no installer: those are scripts/build-app.ts.
//
//   bun run app [--debug]
//
// Needs Rust (rustup) and, on Linux, WebKitGTK's development files, as scripts/build-app.ts says.
// The first build takes some minutes; it goes into app/target/checkout/ and is reused after that.
// On a Mac the key needs the "Input Monitoring" permission for the program the shell runs in:
// started from a terminal, macOS asks for the terminal.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const APP = join(ROOT, 'app');
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const target = join(APP, 'target', 'checkout');
const cargoBin = join(homedir(), '.cargo', 'bin');
const PATH = [process.env.PATH ?? '', ...(existsSync(cargoBin) ? [cargoBin] : [])].join(delimiter);

// the shell alone: the server is this checkout's, not a sidecar, and there are no resources to bundle
const config = JSON.stringify({ bundle: { externalBin: null, resources: null } });
const build = Bun.spawnSync([process.execPath, 'x', 'tauri', 'build', '--no-bundle', '--config', config, ...(debug ? ['--debug'] : [])], {
  cwd: APP,
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, PATH, CARGO_TARGET_DIR: target, CI: 'true' },
});
if (build.exitCode !== 0) {
  console.error('app: the shell did not build (Rust from https://rustup.rs is needed)');
  process.exit(1);
}

const program = join(target, debug ? 'debug' : 'release', process.platform === 'win32' ? 'obeya.exe' : 'obeya');
const shell = Bun.spawn([program], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, OBEYA_CHECKOUT: ROOT, OBEYA_BUN: process.execPath },
});
process.exit(await shell.exited);
