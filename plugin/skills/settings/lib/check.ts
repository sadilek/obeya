// Checks the settings of the repository in the working directory as they stand in the checkout
// (`.obeya/settings.json`, committed or not), the way Obeya will read them once they are on the
// default branch: every field is known and of the right type, the demo site can be used (the
// problems the configuration sheet reports), and no adapter module is left. Prints what Obeya makes
// of them, the docs in the plan directory among it: which are projects and which are not, and why;
// exits with 1 when something is wrong. Run with Bun (`bun check.ts`).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultsFor, parseShared, REPO_ADAPTER_DIR, REPO_SETTINGS_FILE, withSettings } from '../../../../src/adapters/index.ts';
import { allTicked, type NotAProject } from '../../../../src/core/plan-doc.ts';
import { outsidePlanDir, readPlanDocs, repoInfo } from '../../../../src/server/repo.ts';
import { siteProblem } from '../../../../src/server/site.ts';

const repo = await repoInfo(process.cwd());
const settingsFile = join(repo.path, REPO_SETTINGS_FILE);
if (!existsSync(settingsFile)) {
  console.log(`No ${settingsFile}: write the repository's settings first.`);
  process.exit(1);
}
const shared = parseShared(readFileSync(settingsFile, 'utf8'));
const adapter = withSettings(defaultsFor(repo), () => shared.settings);
const site = adapter.demo?.site;
const siteWrong = site && siteProblem(site, repo.path);
const problems = [
  ...shared.problems,
  ...(siteWrong ? [siteWrong] : []),
  ...(existsSync(join(repo.path, REPO_ADAPTER_DIR)) ? [`${REPO_ADAPTER_DIR}/ is no longer read: take over what it says into ${REPO_SETTINGS_FILE} and delete it`] : []),
];

const plans = readPlanDocs(repo.path, adapter);
const why: Record<NotAProject, string> = { noWorkstreams: 'no `## Workstreams` (or `## Arbeitspakete`) section', noChecklist: 'no checklist under `## Workstreams`' };
const name = (file: string) => file.slice(file.lastIndexOf('/') + 1);
const planLines = !existsSync(outsidePlanDir(adapter.planDocs.dir) ?? join(repo.path, adapter.planDocs.dir))
  ? [`plan docs: ${adapter.planDocs.dir}/ does not exist yet; the first plan doc ("Plan as a project" on an idea or task card) creates it`]
  : [
      `plan docs in ${adapter.planDocs.dir}/: ${plans.docs.length} ${plans.docs.length === 1 ? 'is a project' : 'are projects'}${plans.docs.length ? ` (${plans.docs.map((d) => `${name(d.file)}${allTicked(d) ? ', done: archived' : ''}`).join('; ')})` : ''}, ${plans.others.length} ${plans.others.length === 1 ? 'is not' : 'are not'}`,
      ...plans.others.map((o) => `- ${name(o.file)}: ${why[o.reason]}`),
    ];
const show = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v));
console.log(
  [
    `settings from ${settingsFile}: ${Object.keys(shared.settings ?? {}).join(', ') || '(none)'}`,
    `setup: ${show(adapter.setup)}`,
    `checks: ${show(adapter.checks)}`,
    `land: ${adapter.land}${adapter.land === 'main' && adapter.push ? ' (pushed to origin after each landing)' : ''}${adapter.land === 'main' && adapter.upstream ? ` (cards may go to ${adapter.upstream} as a pull request too)` : ''}${adapter.direct ? ' (direct allowed)' : ''}${adapter.land === 'pr' && adapter.autoMerge === false ? ' (merged by its team, not by Obeya)' : ''}, workspaces: ${adapter.workspaces}`,
    `planDocs: ${show(adapter.planDocs)}, softPaths: ${show(adapter.softPaths)}`,
    ...planLines,
    `app.run: ${adapter.app?.run || '(none: each worker finds out from the repository how to run the app)'}`,
    `app.stop: ${show(adapter.app?.stop)}, app.keep: ${show(adapter.app?.keep)}`,
    `demo site: ${site ? `${site.title} at ${site.url}, deploy ${show(site.deploy)}${site.publish === 'approved' ? ', each approved demo published' : ''}` : '(none: demos are exported as a file)'}`,
    ...(adapter.prNoise ? [`prNoise: ${show(adapter.prNoise)}`] : []),
  ].join('\n'),
);
if (problems.length) {
  console.log(`\nProblems (a field that is unknown or of the wrong type does not count: Obeya's default stands in its place):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nNo problems.');
