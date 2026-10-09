// Obeya as an app: the compiled server (scripts/build.ts) as the sidecar of the Tauri shell in app/,
// bundled into what installs on this platform: a DMG on macOS (the app inside signed ad hoc, or with
// a Developer ID and notarised, see below), an NSIS installer on Windows, an AppImage and a .deb on
// Linux (both unsigned).
//
//   bun scripts/build-app.ts [<target>] [--bundles <dmg,app,nsis,appimage,deb>] [--config <json>] [--debug] [--verbose]
//
// --config merges into app/tauri.conf.json for this build (scripts/check-update.ts gives the app
// another version and another updater that way).
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
//
// On macOS, with a Developer ID Application certificate it signs the app with it instead of ad hoc:
// the shell and the server with the hardened runtime and app/entitlements.plist, then the DMG.
// The certificate is in the keychain, named by APPLE_SIGNING_IDENTITY ("Developer ID Application:
// Name (TEAMID)"), or (in CI) in APPLE_CERTIFICATE as a base64 .p12 with APPLE_CERTIFICATE_PASSWORD,
// which Tauri imports into a keychain of its own. With an App Store Connect API key it then has the
// DMG notarised (one submission covers the app and the server inside) and staples the ticket to the
// DMG and to the app beside it, which the updater's archive packs: APPLE_NOTARY_KEY (the .p8, its
// contents or its path), APPLE_NOTARY_KEY_ID, and APPLE_NOTARY_ISSUER for a team key (an
// individual key has none). docs/release.md says how to get them. Tauri's own notarisation is not
// used: it notarises the app but not the DMG, and needs an issuer.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
const target = (args.find((a, i) => !a.startsWith('--') && !['--bundles', '--config'].includes(args[i - 1] ?? '')) ?? here) as Target;
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

/** What `cmd` prints, failing with what it said when it fails. */
function output(cmd: string[], cwd = ROOT): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const said = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) fail(`${cmd.slice(0, 3).join(' ')} failed (exit ${r.exitCode})\n${said}`);
  return said;
}

// a workflow passes an absent secret as an empty variable, which Tauri would take for a certificate
const APPLE = ['APPLE_SIGNING_IDENTITY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_NOTARY_KEY', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER'];
for (const name of APPLE) if (!process.env[name]) delete process.env[name];

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
const developerId = os === 'darwin' && !!(process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_CERTIFICATE);
// without a name, Tauri takes the certificate's own (null removes the ad hoc "-" of tauri.conf.json)
const signing = developerId ? ['--config', JSON.stringify({ bundle: { macOS: { signingIdentity: process.env.APPLE_SIGNING_IDENTITY ?? null } } })] : [];
const tauri = (bundles: string, ...more: string[]) =>
  run(
    [process.execPath, 'x', 'tauri', 'build', '--bundles', bundles, ...(cross ? ['--target', triple] : []), ...(args.includes('--debug') ? ['--debug'] : []), ...(args.includes('--verbose') ? ['--verbose'] : []), ...(opt('config') ? ['--config', opt('config')!] : []), ...signing, ...more],
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

if (developerId && process.env.APPLE_NOTARY_KEY && process.env.APPLE_NOTARY_KEY_ID) notarise();
else if (developerId) console.warn('build-app: signed with the Developer ID, but not notarised (no APPLE_NOTARY_KEY and APPLE_NOTARY_KEY_ID)');

/** Has Apple notarise the DMG (else the app, zipped) and staples the ticket to the DMG and the app. */
function notarise() {
  const tmp = mkdtempSync(join(tmpdir(), 'obeya-notary-'));
  try {
    const given = process.env.APPLE_NOTARY_KEY!;
    const key = given.includes('BEGIN PRIVATE KEY') ? join(tmp, 'key.p8') : given;
    if (key !== given) writeFileSync(key, given);
    const auth = ['--key', key, '--key-id', process.env.APPLE_NOTARY_KEY_ID!, ...(process.env.APPLE_NOTARY_ISSUER ? ['--issuer', process.env.APPLE_NOTARY_ISSUER] : [])];
    const app = join(out, 'macos', 'Obeya.app');
    const dmg = existsSync(join(out, 'dmg')) ? readdirSync(join(out, 'dmg')).find((f) => f.endsWith('.dmg')) : undefined;
    let submitted = dmg && join(out, 'dmg', dmg);
    if (!submitted) {
      submitted = join(tmp, 'Obeya.zip');
      run(['ditto', '-c', '-k', '--keepParent', app, submitted]);
    }
    console.log(`$ xcrun notarytool submit ${submitted} --wait`);
    const answer = JSON.parse(output(['xcrun', 'notarytool', 'submit', submitted, ...auth, '--wait', '--timeout', '1h', '--output-format', 'json'])) as { id: string; status: string };
    if (answer.status !== 'Accepted') {
      console.error(output(['xcrun', 'notarytool', 'log', answer.id, ...auth]));
      fail(`notarisation ${answer.id}: ${answer.status}`);
    }
    console.log(`notarised (${answer.id})`);
    // the DMG's ticket covers the app inside it, so the app beside it (there when the updater's
    // archive is made of it; Tauri removes it after a DMG alone) staples from it too
    for (const file of [...(dmg ? [submitted] : []), ...(existsSync(app) ? [app] : [])]) {
      run(['xcrun', 'stapler', 'staple', file]);
      run(['xcrun', 'stapler', 'validate', file]);
    }
    // what Gatekeeper says on the user's Mac, of the DMG and of the app in it: "source=Notarized Developer ID"
    const assess = (...check: string[]) => {
      const said = output(['spctl', '--assess', '-vv', ...check]);
      if (!said.includes('Notarized Developer ID')) fail(`Gatekeeper: ${said}`);
      console.log(said.trim());
    };
    if (dmg) {
      assess('--type', 'open', '--context', 'context:primary-signature', submitted);
      const mounted = join(tmp, 'dmg');
      output(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mounted, submitted]);
      try {
        assess('--type', 'execute', join(mounted, 'Obeya.app'));
      } finally {
        run(['hdiutil', 'detach', mounted]);
      }
    } else assess('--type', 'execute', app);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
