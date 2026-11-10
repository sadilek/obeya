import { expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

test('the Pages workflow publishes again when any file the site player is built from changes', async () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, '.github/workflows/pages.yml'), 'utf8')) as { on: { push: { paths: string[] } } };
  const paths = workflow.on.push.paths;
  const covered = (file: string) => paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : file === p));
  const built = await Bun.build({ entrypoints: [join(ROOT, 'scripts/site-player.ts')], target: 'bun', metafile: true, throw: true });
  const sources = Object.keys(built.metafile!.inputs)
    .map((f) => relative(ROOT, join(ROOT, f)).replaceAll('\\', '/'))
    .filter((f) => !f.startsWith('node_modules/'));
  expect(sources).toContain('src/server/demo-page.ts');
  expect(sources.filter((f) => !covered(f))).toEqual([]);
});
