import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// publish.ts against a fake gh on PATH that logs each call with the token it got, and the files it
// was handed, so no release or workflow on GitHub is touched
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-publish-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const out = path.join(dir, 'out');
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'demo.mp4'), 'video');
fs.writeFileSync(path.join(out, 'captions.vtt'), 'WEBVTT');
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
const log = path.join(dir, 'gh.log');
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "[$GH_TOKEN] $*" >> "${log}"
for f in "$@"; do case "$f" in /*/hero.*) echo "$(basename "$f"): $(cat "$f")" >> "${log}";; esac; done
case "$1 $2" in
  "auth token") echo "token-of-$4";;
  "release view") exit $FAKE_RELEASE_MISSING;;
esac
`, { mode: 0o755 });

function publish(releaseMissing: boolean) {
  fs.rmSync(log, { force: true });
  const r = Bun.spawnSync(['node', path.join(import.meta.dirname, 'publish.ts')], {
    env: { ...process.env, GH_TOKEN: 'from-the-shell', PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERO_OUT: out, FAKE_RELEASE_MISSING: releaseMissing ? '1' : '0' },
  });
  expect(r.exitCode).toBe(0);
  return fs.readFileSync(log, 'utf8').replaceAll(/\/\S*\/hero\./g, 'hero.').trim().split('\n');
}

test.skipIf(process.platform === 'win32')('replaces the assets of the release, then runs the Pages workflow, as sadilek', () => {
  expect(publish(false)).toEqual([
    '[] auth token --user sadilek',
    '[token-of-sadilek] release view site-media --repo sadilek/obeya',
    '[token-of-sadilek] release upload site-media hero.mp4 hero.vtt --clobber --repo sadilek/obeya',
    'hero.mp4: video',
    'hero.vtt: WEBVTT',
    '[token-of-sadilek] workflow run pages.yml --repo sadilek/obeya',
  ]);
});

test.skipIf(process.platform === 'win32')('creates the release when it is missing', () => {
  const calls = publish(true);
  expect(calls[2]).toStartWith('[token-of-sadilek] release create site-media hero.mp4 hero.vtt --repo sadilek/obeya --title Site media');
  expect(calls[2]).toEndWith('--latest=false');
  expect(calls.at(-1)).toBe('[token-of-sadilek] workflow run pages.yml --repo sadilek/obeya');
});
