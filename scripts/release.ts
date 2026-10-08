// What a release holds, for the build workflow (.github/workflows/build.yml): each platform's build
// collects its installers, and the release job adds the checksums and the updater's latest.json.
//
//   bun scripts/release.ts collect <dir>
//       copies this machine's installers from app/target/release/bundle/ (scripts/build-app.ts)
//       into <dir>, with the update artifacts and their signatures when there are any; the macOS
//       one gets its architecture into its name (Tauri calls it Obeya.app.tar.gz on both).
//   bun scripts/release.ts manifest <dir> <tag> <owner/repo>
//       writes latest.json (the version, and per platform the update's URL in the tag's release
//       and its signature) and SHA256SUMS over everything in <dir>.
//
// Without the updater's key (TAURI_SIGNING_PRIVATE_KEY at the build) there are no update artifacts,
// and latest.json names no platform.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import pkg from '../package.json';

/** Tauri's platform keys in latest.json, by how the update artifact's name ends. */
const PLATFORMS: [RegExp, string][] = [
  [/_aarch64\.app\.tar\.gz$/, 'darwin-aarch64'],
  [/_x64\.app\.tar\.gz$/, 'darwin-x86_64'],
  [/_x64-setup\.exe$/, 'windows-x86_64'],
  [/_amd64\.AppImage$/, 'linux-x86_64'],
  [/_aarch64\.AppImage$/, 'linux-aarch64'],
];

const INSTALLERS = /\.(dmg|AppImage|deb)$|-setup\.exe$/;

/** Copies the installers in `bundle` (Tauri's bundle directory) into `dir`; returns their names. */
export function collect(bundle: string, dir: string, version = pkg.version, arch = process.arch): string[] {
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const put = (from: string, name = basename(from)) => {
    copyFileSync(from, join(dir, name));
    copied.push(name);
  };
  for (const sub of ['dmg', 'nsis', 'appimage', 'deb']) {
    if (!existsSync(join(bundle, sub))) continue;
    for (const f of readdirSync(join(bundle, sub))) {
      const path = join(bundle, sub, f);
      if (INSTALLERS.test(f)) put(path);
      else if (f.endsWith('.sig') && INSTALLERS.test(f.slice(0, -4))) put(path);
    }
  }
  const app = join(bundle, 'macos', 'Obeya.app.tar.gz');
  if (existsSync(app)) {
    const name = `Obeya_${version}_${arch === 'arm64' ? 'aarch64' : 'x64'}.app.tar.gz`;
    put(app, name);
    if (existsSync(`${app}.sig`)) put(`${app}.sig`, `${name}.sig`);
  }
  return copied;
}

export type Latest = { version: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> };

/** latest.json for Tauri's updater, from the signed update artifacts in `dir`. */
export function latest(dir: string, tag: string, repo: string, now = new Date()): Latest {
  const platforms: Latest['platforms'] = {};
  for (const f of readdirSync(dir).sort()) {
    const platform = PLATFORMS.find(([end]) => end.test(f))?.[1];
    if (!platform || !existsSync(join(dir, `${f}.sig`))) continue;
    platforms[platform] = {
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(f)}`,
      signature: readFileSync(join(dir, `${f}.sig`), 'utf8').trim(),
    };
  }
  return { version: tag.replace(/^v/, ''), pub_date: now.toISOString().replace(/\.\d+Z$/, 'Z'), platforms };
}

/** SHA256SUMS as `sha256sum` writes it, over the files in `dir` (but itself). */
export function sums(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f !== 'SHA256SUMS')
    .sort()
    .map((f) => `${new Bun.CryptoHasher('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}\n`)
    .join('');
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'collect' && rest[0]) {
    const copied = collect(resolve(import.meta.dir, '..', 'app', 'target', 'release', 'bundle'), resolve(rest[0]));
    if (!copied.length) {
      console.error('release: no installers in app/target/release/bundle (run scripts/build-app.ts first)');
      process.exit(1);
    }
    for (const f of copied) console.log(f);
  } else if (command === 'manifest' && rest[2]) {
    const [dirArg, tag, repo] = rest as [string, string, string];
    const dir = resolve(dirArg);
    const manifest = latest(dir, tag, repo);
    writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(dir, 'SHA256SUMS'), sums(dir));
    const named = Object.keys(manifest.platforms);
    console.log(`latest.json: ${named.length ? named.join(', ') : 'no platform (the builds had no updater key)'}`);
  } else {
    console.error('usage: bun scripts/release.ts collect <dir> | manifest <dir> <tag> <owner/repo>');
    process.exit(2);
  }
}
