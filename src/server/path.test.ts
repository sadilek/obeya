import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { codexExecutable } from './codex';
import { addToPath, freshPath, loginShellPath, putFirst, terminalPath, which } from './path';

const dir = mkdtempSync(join(tmpdir(), 'obeya-path-'));
const bin = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
writeFileSync(bin, '', { mode: 0o755 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('program lookup in copied environments', () => {
  test('finds a program on PATH', () => expect(which('codex', { PATH: dir })).toBe(bin));
  test('does not fall back to the process PATH when absent', () => expect(which('codex', {})).toBeNull());
  test('an explicitly empty PATH stays empty', () => expect(which('codex', { PATH: '' })).toBeNull());

  if (process.platform === 'win32') {
    for (const key of ['Path', 'path', 'pAtH']) {
      test(`a Codex session finds npm's command in a copied ${key}`, () => {
        expect(codexExecutable({ [key]: dir })).toBe(bin);
      });
    }
    test('explicit PATH takes precedence over a differently cased key', () => {
      expect(which('codex', { Path: dir, PATH: '' })).toBeNull();
    });
    test('of two other spellings, the one a spawned process gets wins', () => {
      expect(which('codex', { path: '', Path: dir })).toBe(bin);
      const env = { path: '', Path: dir };
      addToPath(env, ['extra']);
      expect(env).toEqual({ path: '', Path: [dir, 'extra'].join(delimiter) });
    });
    test('appending directories preserves the existing spelling and entries', () => {
      const env = { Path: dir };
      addToPath(env, [dir, 'extra']);
      expect(env).toEqual({ Path: [dir, 'extra'].join(delimiter) });
    });
  } else {
    test('Unix environments remain case sensitive', () => expect(which('codex', { Path: dir })).toBeNull());
  }

  test('appending to PATH preserves precedence and avoids duplicate directories', () => {
    const env = { PATH: dir };
    addToPath(env, [dir, 'extra', 'extra']);
    expect(env.PATH).toBe([dir, 'extra'].join(delimiter));
  });
});

if (process.platform !== 'win32') {
  /** A stand-in for the owner's login shell: as a terminal starts it, it runs the command on the PATH its files would build. */
  const shell = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "-l -i -c" ] || exit 9\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const terminal = shell('terminal-shell', 'PATH="/usr/local/share/dotnet:~/.dotnet/tools:$PATH:/usr/local/share/dotnet"; export PATH; eval "$4"');

  describe('the PATH a new terminal has', () => {
    test('is what the login shell builds, with `~` as the home', async () => {
      const dirs = await loginShellPath({ SHELL: terminal, HOME: '/home/owner', PATH: '/usr/bin:/bin' });
      expect(dirs).toEqual(['/usr/local/share/dotnet', '/home/owner/.dotnet/tools', '/usr/bin', '/bin', '/usr/local/share/dotnet']);
    });

    test('goes first, each directory once, the ones Obeya had after it', async () => {
      const env = { SHELL: terminal, HOME: '/home/owner', PATH: '/usr/bin:/bin:/opt/homebrew/bin' };
      await terminalPath(env, 'darwin', true);
      expect(env.PATH).toBe('/usr/local/share/dotnet:/home/owner/.dotnet/tools:/usr/bin:/bin:/opt/homebrew/bin');
      // asked again, as before a check, it stays the same
      await freshPath(env, 'darwin', true);
      expect(env.PATH).toBe('/usr/local/share/dotnet:/home/owner/.dotnet/tools:/usr/bin:/bin:/opt/homebrew/bin');
    });

    test('is not asked for where Obeya was started from a terminal: it has that PATH already', async () => {
      const env = { SHELL: terminal, HOME: '/home/owner', PATH: '/custom:/usr/bin' };
      await terminalPath(env, 'darwin', false);
      await freshPath(env, 'linux', false);
      expect(env.PATH).toBe('/custom:/usr/bin');
    });

    test('a shell that fails, is missing or does not finish in time leaves the PATH as it was', async () => {
      expect(await loginShellPath({ SHELL: shell('failing-shell', 'exit 1'), PATH: '/usr/bin' })).toBeNull();
      expect(await loginShellPath({ SHELL: join(dir, 'no-such-shell'), PATH: '/usr/bin' })).toBeNull();
      expect(await loginShellPath({ PATH: '/usr/bin' })).toBeNull();
      const started = Date.now();
      expect(await loginShellPath({ SHELL: shell('hanging-shell', 'sleep 30'), PATH: '/usr/bin:/bin' }, 200)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test('a program the rc files leave running is not waited for', async () => {
      const started = Date.now();
      const dirs = await loginShellPath({ SHELL: shell('agent-shell', '(sleep 5 &) ; eval "$4"'), PATH: '/usr/bin:/bin' });
      expect(dirs).toEqual(['/usr/bin', '/bin']);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  test('putting directories first keeps the others in their order', () => {
    const env = { PATH: '/a:/b:/c' };
    putFirst(env, ['/c', '/d']);
    expect(env.PATH).toBe('/c:/d:/a:/b');
  });
}
