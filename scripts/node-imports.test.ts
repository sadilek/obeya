// Some scripts run under Node, not Bun: the hero video's render and publishing, the demo skill's
// scripts, the browser skill. Node resolves a relative import only with its file extension, and
// loads no `bun:` module; Bun takes both. An import that breaks this in a module such a script
// reaches (an extensionless import in a server module the hero video's director imports, say)
// shows only when that script next runs. This test walks the runtime imports reachable from each
// of them, without running them (importing render.ts would start a render).
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** The scripts run with `node`, by their READMEs, skills and docs. */
const NODE_ENTRIES = [
  'scripts/hero-video/render.ts',
  'scripts/hero-video/demo.ts',
  'scripts/hero-video/publish.ts',
  'scripts/hero-video/stage.ts',
  'scripts/hero-video/load.ts',
  'plugin/skills/demo/lib/director.ts',
  'plugin/skills/demo/lib/revoice.ts',
  'plugin/skills/demo/lib/settings.ts',
  'plugin/skills/demo/lib/setup.ts',
  'plugin/skills/demo/lib/voices.ts',
  'plugin/skills/demo/example/demo.ts',
  'plugin/skills/browser/lib/browser.ts',
];

/**
 * The specifiers a module loads at runtime under Node's type stripping: every import and
 * re-export except `import type` and `export type`, which Node drops whole. An import of types
 * only by inline `type` (`import { type A } from './a'`) still loads its module under Node,
 * as `import {} from './a'`, so it counts.
 */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  const statement = /^[ \t]*(import|export)\b(\s+type\b(?!\s*[,}]))?[^;]*?\bfrom\s*(['"])([^'"\n]+)\3/gm;
  for (const m of source.matchAll(statement)) if (!m[2]) found.push(m[4]!);
  for (const m of source.matchAll(/^[ \t]*import\s*(['"])([^'"\n]+)\1/gm)) found.push(m[2]!);
  for (const m of source.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)) found.push(m[2]!);
  return found;
}

/** What Node can't load among a module's imports, with the specifier as written. */
function nodeProblem(specifier: string, from: string): string | undefined {
  if (specifier.startsWith('bun:')) return 'is a Bun module';
  if (!specifier.startsWith('.')) return undefined;
  if (!/\.(ts|mts|js|mjs|cjs|json)$/.test(specifier)) return 'has no file extension';
  if (!existsSync(resolve(dirname(from), specifier))) return 'names no file';
  return undefined;
}

/** Each problem as `<file>: '<specifier>' <why>`, over every module reachable from the entries. */
function problemsFrom(entries: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = entries.map((e) => join(ROOT, e));
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
      const why = nodeProblem(specifier, file);
      if (why) problems.push(`${relative(ROOT, file)}: '${specifier}' ${why}`);
      else if (specifier.startsWith('.') && /\.(ts|mts|js|mjs)$/.test(specifier)) queue.push(resolve(dirname(file), specifier));
    }
  }
  return problems;
}

test('the scripts that run under Node reach only imports Node can load', () => {
  for (const entry of NODE_ENTRIES) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
  expect(problemsFrom(NODE_ENTRIES)).toEqual([]);
});

test('runtime imports are told from those Node drops as types', () => {
  const source = [
    "import type { A } from './a';",
    "import { type B } from './b';",
    "import { type C, d } from './c';",
    "import {\n  e,\n  type F,\n} from './e';",
    "import './side';",
    "export { g } from './g';",
    "export type { H } from './h';",
    "export * from './star';",
    "export const list = Array.from('xy');",
    "const lazy = await import('./lazy');",
    "// import gone from './comment';",
  ].join('\n');
  expect(runtimeImports(source)).toEqual(['./b', './c', './e', './g', './star', './side', './lazy']);
});

test('an import without its extension, of a Bun module or of a missing file is named', () => {
  const from = join(ROOT, 'src/server/owner.ts');
  expect(nodeProblem('../core/frame', from)).toBe('has no file extension');
  expect(nodeProblem('../core/frame.ts', from)).toBeUndefined();
  expect(nodeProblem('../core/nothing.ts', from)).toBe('names no file');
  expect(nodeProblem('bun:sqlite', from)).toBe('is a Bun module');
  expect(nodeProblem('node:fs', from)).toBeUndefined();
});
