import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, latest, notes, sums } from './release';

const tmp = mkdtempSync(join(tmpdir(), 'obeya-release-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function files(dir: string, names: Record<string, string>) {
  for (const [name, content] of Object.entries(names)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

test('collects the installers under the names the site links, with the signed update', () => {
  const bundle = join(tmp, 'bundle-linux');
  files(bundle, {
    'appimage/Obeya_0.4.0_amd64.AppImage': 'image',
    'appimage/Obeya_0.4.0_amd64.AppImage.sig': 'sig',
    'appimage/Obeya.AppDir/AppRun': 'run',
    'deb/Obeya_0.4.0_amd64.deb': 'deb',
  });
  const out = join(tmp, 'collected-linux');
  collect('linux-x64', bundle, out);
  expect(readdirSync(out).sort()).toEqual(['Obeya-Linux-x86_64.AppImage', 'Obeya-Linux-x86_64.AppImage.sig', 'obeya_amd64.deb']);
});

test('the Mac update is the app packed beside the DMG; without its signature it stays out', () => {
  const bundle = join(tmp, 'bundle-mac');
  files(bundle, { 'dmg/Obeya_0.4.0_aarch64.dmg': 'dmg', 'dmg/bundle_dmg.sh': 'script', 'macos/Obeya.app.tar.gz': 'app' });
  const out = join(tmp, 'collected-mac');
  collect('darwin-arm64', bundle, out);
  expect(readdirSync(out)).toEqual(['Obeya-macOS-arm64.dmg']);
  files(bundle, { 'macos/Obeya.app.tar.gz.sig': 'sig' });
  collect('darwin-arm64', bundle, out);
  expect(readdirSync(out).sort()).toEqual(['Obeya-macOS-arm64.app.tar.gz', 'Obeya-macOS-arm64.app.tar.gz.sig', 'Obeya-macOS-arm64.dmg']);
});

test('a missing installer stops the collection', () => {
  expect(() => collect('windows-x64', join(tmp, 'nothing'), join(tmp, 'collected-win'))).toThrow('-setup.exe');
});

test('latest.json names each platform with a signed update, at its URL in the release', () => {
  const dir = join(tmp, 'release');
  files(dir, {
    'Obeya-macOS-arm64.app.tar.gz': 'a',
    'Obeya-macOS-arm64.app.tar.gz.sig': 'SIG-MAC\n',
    'Obeya-macOS-arm64.dmg': 'd',
    'Obeya-Windows-x64-setup.exe': 'w',
    'Obeya-Windows-x64-setup.exe.sig': 'SIG-WIN',
    'Obeya-Linux-aarch64.AppImage': 'unsigned',
    'obeya_arm64.deb': 'deb',
  });
  expect(latest(dir, 'v0.4.0', 'someone/obeya', new Date('2026-10-08T12:00:00.123Z'))).toEqual({
    version: '0.4.0',
    pub_date: '2026-10-08T12:00:00Z',
    platforms: {
      'darwin-aarch64': { url: 'https://github.com/someone/obeya/releases/download/v0.4.0/Obeya-macOS-arm64.app.tar.gz', signature: 'SIG-MAC' },
      'windows-x86_64': { url: 'https://github.com/someone/obeya/releases/download/v0.4.0/Obeya-Windows-x64-setup.exe', signature: 'SIG-WIN' },
    },
  });
});

test('the checksums read as sha256sum writes them', () => {
  const dir = join(tmp, 'sums');
  files(dir, { 'b.deb': 'b', 'a.dmg': 'a', SHA256SUMS: 'old' });
  expect(sums(dir)).toBe(
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.dmg\n' +
      '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.deb\n',
  );
});

test('the notes list the commits since the tag before that change what runs; the bar gets their start', () => {
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { stderr: 'pipe' });
  const commit = (file: string, subject: string) => {
    files(repo, { [file]: subject });
    git('add', '.');
    git('commit', '-qm', subject);
  };
  git('init', '-q', '-b', 'main');
  commit('src/a.ts', 'First');
  git('tag', 'v0.1.0');
  commit('src/b.ts', 'Faster canvas');
  commit('docs/design.md', 'Record the plan');
  commit('README.md', 'Reword the README');
  commit('app/src/main.rs', 'Quit cleanly');
  git('tag', 'v0.2.0');
  expect(notes(repo, 'v0.2.0')).toBe('- Quit cleanly\n- Faster canvas\n');
  expect(notes(repo, 'v0.1.0')).toBe('- First\n');

  const many = Array.from({ length: 20 }, (_, i) => `- Change ${i + 1}`).join('\n');
  const dir = join(tmp, 'empty-release');
  mkdirSync(dir);
  const shown = latest(dir, 'v0.2.0', 'someone/obeya', new Date(), many).notes!.split('\n');
  expect(shown).toHaveLength(12);
  expect(shown.at(-1)).toBe('- … and 9 more');
  expect(latest(dir, 'v0.2.0', 'someone/obeya', new Date())).not.toHaveProperty('notes');
});
