import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { codexExecutable } from './codex';
import { addToPath, which } from './path';

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
