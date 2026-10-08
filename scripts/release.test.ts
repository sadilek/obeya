import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, latest, sums } from './release';

const tmp = mkdtempSync(join(tmpdir(), 'obeya-release-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function files(dir: string, names: Record<string, string>) {
  for (const [name, content] of Object.entries(names)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

test('collects the installers and update artifacts, the Mac one named with its architecture', () => {
  const bundle = join(tmp, 'bundle');
  files(bundle, {
    'dmg/Obeya_0.4.0_aarch64.dmg': 'dmg',
    'dmg/bundle_dmg.sh': 'script',
    'macos/Obeya.app.tar.gz': 'app',
    'macos/Obeya.app.tar.gz.sig': 'sig',
    'appimage/Obeya_0.4.0_amd64.AppImage': 'image',
    'appimage/Obeya_0.4.0_amd64.AppImage.sig': 'sig',
    'appimage/Obeya.AppDir/AppRun': 'run',
    'deb/Obeya_0.4.0_amd64.deb': 'deb',
  });
  const out = join(tmp, 'collected');
  collect(bundle, out, '0.4.0', 'arm64');
  expect(readdirSync(out).sort()).toEqual([
    'Obeya_0.4.0_aarch64.app.tar.gz',
    'Obeya_0.4.0_aarch64.app.tar.gz.sig',
    'Obeya_0.4.0_aarch64.dmg',
    'Obeya_0.4.0_amd64.AppImage',
    'Obeya_0.4.0_amd64.AppImage.sig',
    'Obeya_0.4.0_amd64.deb',
  ]);
});

test('latest.json names each platform with a signed update, at its URL in the release', () => {
  const dir = join(tmp, 'release');
  files(dir, {
    'Obeya_0.4.0_aarch64.app.tar.gz': 'a',
    'Obeya_0.4.0_aarch64.app.tar.gz.sig': 'SIG-MAC\n',
    'Obeya_0.4.0_aarch64.dmg': 'd',
    'Obeya_0.4.0_x64-setup.exe': 'w',
    'Obeya_0.4.0_x64-setup.exe.sig': 'SIG-WIN',
    'Obeya_0.4.0_aarch64.AppImage': 'unsigned',
    'Obeya_0.4.0_arm64.deb': 'deb',
  });
  expect(latest(dir, 'v0.4.0', 'someone/obeya', new Date('2026-10-08T12:00:00.123Z'))).toEqual({
    version: '0.4.0',
    pub_date: '2026-10-08T12:00:00Z',
    platforms: {
      'darwin-aarch64': { url: 'https://github.com/someone/obeya/releases/download/v0.4.0/Obeya_0.4.0_aarch64.app.tar.gz', signature: 'SIG-MAC' },
      'windows-x86_64': { url: 'https://github.com/someone/obeya/releases/download/v0.4.0/Obeya_0.4.0_x64-setup.exe', signature: 'SIG-WIN' },
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
