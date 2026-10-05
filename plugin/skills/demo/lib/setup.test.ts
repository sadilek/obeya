import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPaths, checkSetup, describeSetup, installHint, linuxFamily, type SetupCheck } from './setup.ts';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'obeya-demo-setup-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A directory of fake programs, each printing `out`, first on the PATH (the system's after it, for `cat`). */
function fakePath(programs: Record<string, string>) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, out] of Object.entries(programs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
}

describe('demo setup', () => {
  test('says how to install each piece on each platform', () => {
    expect(installHint('ffmpeg', 'darwin', 'arm64')?.commands).toEqual(['brew install ffmpeg']);
    expect(installHint('ffmpeg', 'win32', 'x64')?.commands).toEqual(['winget install Gyan.FFmpeg']);
    expect(installHint('ffmpeg', 'linux', 'x64', 'apt')?.commands).toEqual(['sudo apt install ffmpeg']);
    // Fedora's own ffmpeg has no libx264
    expect(installHint('ffmpeg', 'linux', 'x64', 'dnf')?.url).toContain('rpmfusion');
    expect(installHint('ffmpeg', 'linux', 'x64', null)).toEqual({ commands: [], url: 'https://ffmpeg.org/download.html' });
    expect(installHint('uv', 'linux', 'arm64')?.commands[0]).toContain('astral.sh/uv/install.sh');
    expect(installHint('uv', 'win32', 'x64')?.commands[0]).toContain('winget');
    // no Chrome for Linux on ARM: Playwright's own Chromium
    expect(installHint('browser', 'linux', 'arm64')).toEqual({ commands: [expect.stringContaining('playwright-core install --with-deps chromium')] });
    expect(installHint('browser', 'linux', 'x64')?.url).toContain('google.com/chrome');
    expect(installHint('node', 'linux', 'x64')).toEqual({ commands: [], url: 'https://nodejs.org/en/download' });
    expect(installHint('whisper', 'darwin', 'arm64')).toBeUndefined();
  });

  test('tells the Linux family by /etc/os-release', () => {
    expect(linuxFamily('ID=ubuntu\nID_LIKE=debian\n')).toBe('apt');
    expect(linuxFamily('ID="fedora"\n')).toBe('dnf');
    expect(linuxFamily('ID=rocky\nID_LIKE="rhel centos fedora"\n')).toBe('dnf');
    expect(linuxFamily('ID=arch\n')).toBe('pacman');
    expect(linuxFamily('ID=alpine\n')).toBeNull();
    expect(linuxFamily('')).toBeNull();
  });

  test('looks for Chrome and Edge where Playwright does', () => {
    expect(browserPaths('chrome', 'linux', {})).toEqual(['/opt/google/chrome/chrome']);
    expect(browserPaths('msedge', 'win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' })).toEqual([
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
    expect(browserPaths('chrome', 'freebsd', {})).toEqual([]);
  });

  test('finds nothing on an empty PATH, and says how to install each', async () => {
    const check = await checkSetup({ language: 'de', voice: 'piper' }, { env: { PATH: join(dir, 'none'), HOME: dir, DEMO_CHROME: join(dir, 'no-chrome') }, home: dir });
    const by = Object.fromEntries(check.items.map((i) => [i.id, i]));
    for (const id of ['node', 'ffmpeg', 'uv', 'browser', 'voice'] as const) {
      expect(by[id]?.state).toBe('missing');
      expect(by[id]?.install).toBeDefined();
    }
    expect(by.voice?.found).toContain('Piper');
    expect(by.voice?.mb).toBeGreaterThan(0);
    expect(by.playwright?.state).toBe('ok');
    // without uv, Whisper is still to come, not missing: the first render fetches it
    expect(by.whisper?.state).toBe(by.whisper?.mb ? 'later' : 'ok');
  });

  test.skipIf(process.platform === 'win32')('takes an old Node and an ffmpeg without libx264 as missing', async () => {
    const env = fakePath({ node: 'v20.11.0', ffmpeg: 'ffmpeg version 6.1 Copyright\n V..... libopenh264', uv: 'uv 0.8.0 (abc)' });
    const check = await checkSetup({ language: 'de', voice: 'say', listenBack: false }, { env, home: dir, narrationOnly: true });
    expect(check.items.map((i) => i.id)).toEqual(['node', 'ffmpeg', 'uv', 'voice', 'whisper']);
    const by = Object.fromEntries(check.items.map((i) => [i.id, i]));
    expect(by.node).toMatchObject({ state: 'missing', found: 'v20.11.0', need: '>= 22.18' });
    expect(by.ffmpeg).toMatchObject({ state: 'missing', found: '6.1', need: 'libx264' });
    expect(by.uv).toMatchObject({ state: 'ok', found: '0.8.0' });
    expect(by.voice).toMatchObject({ state: 'ok', found: 'say' });
    expect(by.whisper).toEqual({ id: 'whisper', state: 'off' });
  });

  test.skipIf(process.platform === 'win32')('takes a current Node and an ffmpeg with libx264', async () => {
    const env = fakePath({ node: 'v24.1.0', ffmpeg: 'ffmpeg version 7.1 Copyright\n V....D libx264  H.264', uv: 'uv 0.8.0' });
    const check = await checkSetup({ language: 'de', voice: 'say', listenBack: false }, { env, home: dir, narrationOnly: true });
    expect(check.items.filter((i) => i.state === 'missing')).toEqual([]);
  });

  test('prints what is missing with the commands under it', () => {
    const check: SetupCheck = {
      platform: 'linux',
      arch: 'x64',
      items: [
        { id: 'node', state: 'ok', found: 'v24.1.0' },
        { id: 'ffmpeg', state: 'missing', found: '6.1', need: 'libx264', install: { commands: ['sudo apt install ffmpeg'] } },
        { id: 'whisper', state: 'later', found: 'faster-whisper', mb: 1850 },
      ],
    };
    expect(describeSetup(check)).toBe(
      [
        'Demo setup on Linux (x64):',
        '  ✓ node       v24.1.0',
        '  ✗ ffmpeg     6.1, needs libx264 — not usable',
        '      sudo apt install ffmpeg',
        '  … whisper    faster-whisper — fetched on the first render, about 1850 MB',
        'Missing: ffmpeg. A render stops until they are installed.',
      ].join('\n'),
    );
  });
});
