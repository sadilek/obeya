import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMain } from '../../plugin/skills/demo/lib/here.ts';
import { COMPILED, embedded, resourcesDir } from './resources';

test("paths in Bun's embedded file system, on POSIX and Windows", () => {
  expect(embedded('/$bunfs/root/obeya')).toBe(true);
  expect(embedded('B:\\~BUN\\root\\obeya.exe')).toBe(true);
  expect(embedded('/Users/me/obeya/src/server/main.ts')).toBe(false);
  expect(COMPILED).toBe(false);
});

test('the resources: the checkout, beside the binary, or in a macOS app bundle', () => {
  expect(resourcesDir({}, false)).toBe(resolve(import.meta.dir, '..', '..'));
  expect(resourcesDir({ OBEYA_RESOURCES: '/opt/obeya/res' }, true)).toBe(resolve('/opt/obeya/res'));
  const dir = mkdtempSync(join(tmpdir(), 'obeya-resources-'));
  try {
    mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true });
    const binary = join(dir, 'Contents', 'MacOS', 'obeya');
    // neither there yet: beside the binary is where they belong
    expect(resourcesDir({}, true, binary)).toBe(join(dir, 'Contents', 'MacOS', 'resources'));
    mkdirSync(join(dir, 'Contents', 'Resources'));
    expect(resourcesDir({}, true, binary)).toBe(join(dir, 'Contents', 'Resources'));
    mkdirSync(join(dir, 'Contents', 'MacOS', 'resources'));
    expect(resourcesDir({}, true, binary)).toBe(join(dir, 'Contents', 'MacOS', 'resources'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the demo skill's scripts run their own main only when started, never inside the binary", () => {
  expect(isMain('/$bunfs/root/obeya')).toBe(false);
  expect(isMain('B:\\~BUN\\root\\obeya.exe')).toBe(false);
  // a module imported, not the one Bun runs (the test file)
  expect(isMain(join(import.meta.dir, 'resources.ts'))).toBe(false);
  expect(isMain(process.argv[1]!)).toBe(true);
});
