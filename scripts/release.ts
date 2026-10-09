// What a release holds, for the build workflow (.github/workflows/build.yml): each platform's build
// collects its installers, and the release job adds the checksums and the updater's latest.json.
//
//   bun scripts/release.ts collect <target> <dir>
//       copies the installers of <target> (darwin-arm64, …, as in scripts/build.ts) from
//       app/target/release/bundle/ (scripts/build-app.ts) into <dir> under the release's fixed
//       names, with the update artifact and its signature when there is one.
//   bun scripts/release.ts notes <tag> <file>
//       writes the release's notes: the subjects of the commits since the version tag before, those
//       that change what runs (not only docs or the site); the first release says that it is one.
//   bun scripts/release.ts manifest <dir> <tag> <owner/repo> [<notes>]
//       writes latest.json (the version, what changed for the bar's hover, and per platform the
//       update's URL in the tag's release and its signature) and SHA256SUMS over everything in <dir>.
//
// The names carry no version: the README and the site link the newest release's installers through
// `releases/latest/download/<name>`. Without the updater's key (TAURI_SIGNING_PRIVATE_KEY at the
// build) there are no update artifacts, and latest.json names no platform.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Asset = { from: string; ends: string; name: string };
type Release = { platform: string; installers: Asset[]; update: Asset };

/** Per target: where Tauri puts each installer, the name it has in the release, and the update. */
export const RELEASE: Record<string, Release> = {
  'darwin-arm64': {
    platform: 'darwin-aarch64',
    installers: [{ from: 'dmg', ends: '.dmg', name: 'Obeya-macOS-arm64.dmg' }],
    update: { from: 'macos', ends: '.app.tar.gz', name: 'Obeya-macOS-arm64.app.tar.gz' },
  },
  'darwin-x64': {
    platform: 'darwin-x86_64',
    installers: [{ from: 'dmg', ends: '.dmg', name: 'Obeya-macOS-x64.dmg' }],
    update: { from: 'macos', ends: '.app.tar.gz', name: 'Obeya-macOS-x64.app.tar.gz' },
  },
  'windows-x64': {
    platform: 'windows-x86_64',
    installers: [{ from: 'nsis', ends: '-setup.exe', name: 'Obeya-Windows-x64-setup.exe' }],
    update: { from: 'nsis', ends: '-setup.exe', name: 'Obeya-Windows-x64-setup.exe' },
  },
  'linux-x64': {
    platform: 'linux-x86_64',
    installers: [
      { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-x86_64.AppImage' },
      { from: 'deb', ends: '.deb', name: 'obeya_amd64.deb' },
    ],
    update: { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-x86_64.AppImage' },
  },
  'linux-arm64': {
    platform: 'linux-aarch64',
    installers: [
      { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-aarch64.AppImage' },
      { from: 'deb', ends: '.deb', name: 'obeya_arm64.deb' },
    ],
    update: { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-aarch64.AppImage' },
  },
};

/** Copies the installers of `target` in `bundle` (Tauri's bundle directory) into `dir`; returns their names. */
export function collect(target: string, bundle: string, dir: string): string[] {
  const release = RELEASE[target];
  if (!release) throw new Error(`unknown target ${target} (known: ${Object.keys(RELEASE).join(', ')})`);
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const find = (a: Asset) => {
    const sub = join(bundle, a.from);
    const f = existsSync(sub) ? readdirSync(sub).find((f) => f.endsWith(a.ends)) : undefined;
    return f && join(sub, f);
  };
  const put = (from: string, name: string) => {
    copyFileSync(from, join(dir, name));
    copied.push(name);
  };
  for (const a of release.installers) {
    const from = find(a);
    if (!from) throw new Error(`no ${a.ends} in ${join(bundle, a.from)}`);
    put(from, a.name);
  }
  const update = find(release.update);
  if (update && existsSync(`${update}.sig`)) {
    if (!copied.includes(release.update.name)) put(update, release.update.name);
    put(`${update}.sig`, `${release.update.name}.sig`);
  }
  return copied;
}

export type Latest = { version: string; notes?: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> };

/** What the bar's hover shows of the notes at most, in lines. */
const NOTES_SHOWN = 12;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

/**
 * The release's notes: one line per commit since the version tag before `tag` that changes what
 * runs. Other tags (`site-media`, which holds the site's video) do not count; the first release
 * would list the whole history, so it says that it is the first instead.
 */
export function notes(cwd: string, tag: string): string {
  const before = git(cwd, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`);
  if (!before) return '- The first release.\n';
  // as INERT in src/server/self-update.ts: docs, the site and the workflows change nothing that runs
  const subjects = git(cwd, 'log', '--no-merges', '--format=%s', `${before}..${tag}`, '--', '.', ':!docs', ':!design', ':!site', ':!.github', ':!*.md') ?? '';
  const lines = subjects.split('\n').filter(Boolean);
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') + '\n' : '- Small fixes.\n';
}

/** latest.json for Tauri's updater, from the signed update artifacts in `dir`, with the start of `changes` (the notes) for the bar. */
export function latest(dir: string, tag: string, repo: string, now = new Date(), changes?: string): Latest {
  const platforms: Latest['platforms'] = {};
  for (const { platform, update } of Object.values(RELEASE)) {
    const sig = join(dir, `${update.name}.sig`);
    if (!existsSync(join(dir, update.name)) || !existsSync(sig)) continue;
    platforms[platform] = {
      url: `https://github.com/${repo}/releases/download/${tag}/${update.name}`,
      signature: readFileSync(sig, 'utf8').trim(),
    };
  }
  const lines = changes?.trim().split('\n').filter(Boolean) ?? [];
  const shown = lines.length > NOTES_SHOWN ? [...lines.slice(0, NOTES_SHOWN - 1), `- … and ${lines.length - NOTES_SHOWN + 1} more`] : lines;
  return { version: tag.replace(/^v/, ''), ...(shown.length ? { notes: shown.join('\n') } : {}), pub_date: now.toISOString().replace(/\.\d+Z$/, 'Z'), platforms };
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
  if (command === 'collect' && rest[1]) {
    const copied = collect(rest[0]!, resolve(import.meta.dir, '..', 'app', 'target', 'release', 'bundle'), resolve(rest[1]));
    for (const f of copied) console.log(f);
  } else if (command === 'notes' && rest[1]) {
    writeFileSync(rest[1], notes(process.cwd(), rest[0]!));
  } else if (command === 'manifest' && rest[2]) {
    const [dirArg, tag, repo, notesFile] = rest as [string, string, string, string?];
    const dir = resolve(dirArg);
    const manifest = latest(dir, tag, repo, new Date(), notesFile ? readFileSync(notesFile, 'utf8') : undefined);
    writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(dir, 'SHA256SUMS'), sums(dir));
    const named = Object.keys(manifest.platforms);
    console.log(`latest.json: ${named.length ? named.join(', ') : 'no platform (the builds had no updater key)'}`);
  } else {
    console.error('usage: bun scripts/release.ts collect <target> <dir> | notes <tag> <file> | manifest <dir> <tag> <owner/repo> [<notes>]');
    process.exit(2);
  }
}
