// Checks the adapter of the repository in the working directory as it stands in the checkout
// (`.obeya/adapter/index.ts`, committed or not), the way Obeya will load it once it is on the
// default branch: it loads, every field is known and of the right type, the share command's
// program is there. Prints what Obeya makes of it; exits with 1 when something is wrong.
// Run with Bun (`bun check.ts [<module>]`), since it loads the adapter as Obeya does.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adapterProblems, loadAdapter, REPO_ADAPTER_DIR } from '../../../../src/adapters/index.ts';
import { repoInfo } from '../../../../src/server/repo.ts';
import { shareProblem } from '../../../../src/server/share.ts';

const repo = repoInfo(process.cwd());
const file = resolve(process.argv[2] ?? join(repo.path, REPO_ADAPTER_DIR, 'index.ts'));
if (!existsSync(file)) {
  console.log(`No adapter at ${file}: write ${REPO_ADAPTER_DIR}/index.ts in the repository first.`);
  process.exit(1);
}
let adapter;
try {
  adapter = loadAdapter(file);
} catch (e) {
  console.log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const problems = [...adapterProblems(adapter)];
const share = adapter.demo?.share && shareProblem(adapter.demo.share);
if (share) problems.push(`demo.share: ${share}`);

let canvas: string;
try {
  canvas = `${adapter.canvasName(repo)} (id ${adapter.canvasId(repo)})`;
} catch (e) {
  canvas = `canvasId/canvasName throw: ${e instanceof Error ? e.message : String(e)}`;
  problems.push(canvas);
}
const show = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v));
console.log(
  [
    `adapter ${adapter.name}, from ${file}`,
    `canvas: ${canvas}`,
    `setup: ${show(adapter.setup)}`,
    `checks: ${show(adapter.checks)}`,
    `land: ${adapter.land}${adapter.direct ? ' (direct allowed)' : ''}, workspaces: ${adapter.workspaces}`,
    `planDocs: ${show(adapter.planDocs)}, softPaths: ${show(adapter.softPaths)}`,
    `demo: ${adapter.demo ? `required ${adapter.demo.required}; share ${show(adapter.demo.share)}\nhowToRun: ${adapter.demo.howToRun}` : '(none: a written summary is enough)'}`,
    ...(adapter.prNoise ? [`prNoise: ${show(adapter.prNoise)}`] : []),
    ...(adapter.stack ? [`stack: ${show(adapter.stack)}`] : []),
  ].join('\n'),
);
if (problems.length) {
  console.log(`\nProblems (a field that is unknown or of the wrong type does not count: the generic adapter's value stands in its place):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nNo problems.');
