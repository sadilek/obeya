// Obeya as one file: the server compiled with Bun (`bun build --compile`) into a binary that needs
// no Bun and no checkout, with the UI and SQLite in it, and beside it the resources other
// processes run or import (src/server/resources.ts): the plugin with the demo skill and the
// Playwright it records with, and the voice sidecars;
// the skills' scripts that read a repository's settings or theme (`recipe.ts`, `check.ts`, `preview.ts`) are bundled with them in place.
//
//   bun scripts/build.ts [<target>…] [--all] [--out <dir>]
//
// Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64 (scripts/targets.ts); by
// default this machine's. Each goes into <out>/obeya-<version>-<target>/ (default out: dist/), holding `obeya`
// (`obeya.exe`) and `resources/`. Bun compiles for another platform too, fetching that platform's
// Bun once. A macOS binary is signed ad hoc on a Mac: as Bun writes it, macOS kills it at start.
// Claude Code is not part of it: the binary runs the machine's own installation
// (`claudeExecutable` in src/server/claude.ts).

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import pkg from '../package.json';
import { ROOT, script } from './common';
import { here, isTarget, type Target, TARGETS, unknownTarget } from './targets';

const { fail, args, run } = script('build');
const { values, positionals: named } = args({ out: { type: 'string' }, all: { type: 'boolean' } });
const out = resolve(values.out ?? join(ROOT, 'dist'));
const targets = values.all ? (Object.keys(TARGETS) as Target[]) : named.length ? named : [here()];
for (const t of targets) if (!isTarget(t)) fail(unknownTarget(t));

/** What goes among the resources: everything another process runs or imports, tests left out. */
function resources(dir: string) {
  const notTests = (src: string) => !/\.test\.ts$|__pycache__|\.DS_Store$/.test(src);
  cpSync(join(ROOT, 'plugin'), join(dir, 'plugin'), { recursive: true, filter: notTests });
  cpSync(join(ROOT, 'voice'), join(dir, 'voice'), { recursive: true, filter: notTests });
  // the director imports it from the plugin, which finds it up the tree as it does in the checkout
  cpSync(join(ROOT, 'node_modules', 'playwright-core'), join(dir, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
  // the plugin's TypeScript runs on plain Node, which reads it as ES modules by this
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'obeya-resources', version: pkg.version, private: true, type: 'module' }, null, 2)}\n`);
  cpSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
  // the settings and theme skills read the reference up the tree, as in the checkout
  cpSync(join(ROOT, 'docs', 'settings.md'), join(dir, 'docs', 'settings.md'));
  cpSync(join(ROOT, 'docs', 'design', 'sharing-demos.md'), join(dir, 'docs', 'design', 'sharing-demos.md'));
  for (const file of ['plugin/skills/demo/lib/recipe.ts', 'plugin/skills/settings/lib/check.ts', 'plugin/skills/theme/lib/preview.ts'])
    run([process.execPath, 'build', file, '--target', 'bun', '--outfile', join(dir, file)], { quiet: true });
}

const started = Date.now();
mkdirSync(out, { recursive: true });
for (const target of targets) {
  const dir = join(out, `obeya-${pkg.version}-${target}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, target.startsWith('windows') ? 'obeya.exe' : 'obeya');
  // Bun (1.3.12) leaves a copy of its runtime in the working directory (`.<hex>.bun-build`): there it goes
  // the UI it carries is bundled now, not when it is served: as `bun start` serves it, React's production build
  const production = ['--define', 'process.env.NODE_ENV="production"'];
  // a Worker's script goes in as an entrypoint of its own, or the binary has none to start
  const workers = ['src/server/windows-processes.ts'].map((f) => join(ROOT, f));
  run([process.execPath, 'build', '--compile', `--target=bun-${target}`, ...production, join(ROOT, 'src/server/main.ts'), ...workers, '--outfile', binary], { cwd: dir, quiet: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.bun-build')) rmSync(join(dir, f), { force: true });
  if (target.startsWith('darwin')) {
    if (process.platform === 'darwin') {
      run(['codesign', '--remove-signature', binary], { quiet: true });
      run(['codesign', '--sign', '-', '--force', binary], { quiet: true });
    } else console.warn(`build: ${target} is not signed (only a Mac signs): macOS kills it at start until it is`);
  }
  resources(join(dir, 'resources'));
  if (!existsSync(binary)) fail(`${binary} was not written`);
  console.log(`${relative(process.cwd(), dir) || '.'}  (${Math.round(Bun.file(binary).size / 1e6)} MB)`);
}
console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
