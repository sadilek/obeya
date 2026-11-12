// `kokoro.py`'s copy of espeak-ng's data for a package under a path too long for espeak-ng, against
// fake data: made complete, and made complete again once files of it are gone, as macOS's cleaner
// of its temporary directory leaves it after three days (the directories without their files).
// Python through uv, as a render runs it, with a temporary directory of the test's own.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const LIB = import.meta.dirname;
const UV = ['uv', 'run', '--quiet', '--no-project', 'python'];
/** Calls `espeak_data` on the package's data and prints the path espeak-ng is to read. */
const CALL = `import sys; sys.path.insert(0, sys.argv[1]); import kokoro; print(kokoro.espeak_data(sys.argv[2]))`;

// uv's first run on a machine finds its Python: done here, outside the time limit of any test
beforeAll(() => {
  expect(spawnSync(UV[0]!, [...UV.slice(1), '-c', 'pass'], { timeout: 600_000 }).status).toBe(0);
}, 600_000);

let dir: string;
let temp: string;
let data: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-kokoro-'));
  temp = join(dir, 'tmp');
  mkdirSync(temp);
  // a package's data under a path longer than espeak-ng takes
  data = join(dir, 'x'.repeat(160), 'espeakng_loader', 'espeak-ng-data');
  for (const [file, text] of Object.entries(DATA)) {
    mkdirSync(join(data, file, '..'), { recursive: true });
    writeFileSync(join(data, file), text);
  }
  // tempfile.gettempdir() reads TMPDIR on macOS and Linux, TMP on Windows
  env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp } as Record<string, string>;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DATA: Record<string, string> = {
  phontab: 'phonemes',
  phonindex: 'index',
  en_dict: 'english',
  'lang/gmw/en-US': 'name English (America)',
  'lang/roa/it': 'name Italian',
  'voices/!v/f1': 'variant',
};

const files = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).replaceAll('\\', '/'))
    .sort();

function espeakData() {
  const r = spawnSync(UV[0]!, [...UV.slice(1), '-c', CALL, LIB, data], { env, encoding: 'utf8', timeout: 60_000 });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

function expectComplete(copy: string) {
  expect(files(copy)).toEqual(Object.keys(DATA).sort());
  for (const [file, text] of Object.entries(DATA)) expect(readFileSync(join(copy, file), 'utf8')).toBe(text);
}

describe('espeak_data', () => {
  test('copies data under a long path into the temporary directory, the parts it copied through gone', () => {
    const copy = espeakData();
    expect(copy).toBe(join(temp, 'obeya-espeak-ng-data'));
    expectComplete(copy);
    expect(readdirSync(temp)).toEqual(['obeya-espeak-ng-data']);
  });

  test('a copy pruned to its directories is made complete again', () => {
    const copy = espeakData();
    for (const file of files(copy)) rmSync(join(copy, file));
    expect(espeakData()).toBe(copy);
    expectComplete(copy);
  });

  test('a copy that lost one file other than phontab gets it back', () => {
    const copy = espeakData();
    rmSync(join(copy, 'lang/roa/it'));
    espeakData();
    expectComplete(copy);
  });

  test('a file the package changed is copied anew', () => {
    const copy = espeakData();
    writeFileSync(join(data, 'en_dict'), 'english, newer');
    espeakData();
    expect(readFileSync(join(copy, 'en_dict'), 'utf8')).toBe('english, newer');
  });

  test('clips that start at once on a pruned copy all succeed and leave it complete', async () => {
    const copy = espeakData();
    for (const file of files(copy)) rmSync(join(copy, file));
    const runs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<{ code: number | null; out: string }>((done) => {
            const p = spawn(UV[0]!, [...UV.slice(1), '-c', CALL, LIB, data], { env });
            let out = '';
            p.stdout.on('data', (b) => (out += b));
            p.stderr.on('data', (b) => (out += b));
            p.on('close', (code) => done({ code, out: out.trim() }));
          }),
      ),
    );
    for (const r of runs) expect(r).toEqual({ code: 0, out: copy });
    expectComplete(copy);
    expect(readdirSync(temp)).toEqual(['obeya-espeak-ng-data']);
  });

  test('data under a short path is read where it is', () => {
    data = join(dir, 'data');
    mkdirSync(data);
    expect(espeakData()).toBe(data);
    expect(readdirSync(temp)).toEqual([]);
  });
});
