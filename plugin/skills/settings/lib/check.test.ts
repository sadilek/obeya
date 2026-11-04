import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRepo } from '../../../../src/server/testing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-check-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHECK = join(import.meta.dir, 'check.ts');

/** Runs the check in a repository with these settings (and files), as a worker runs it. */
function check(settings: Record<string, unknown>, files: Record<string, string> = {}): { code: number; out: string } {
  const repo = gitRepo(join(dir, 'shop'), { '.obeya/settings.json': JSON.stringify(settings), ...files });
  const r = Bun.spawnSync([process.execPath, CHECK], { cwd: repo });
  return { code: r.exitCode, out: r.stdout.toString() };
}

const SITE = { title: 'Demos', url: 'https://demos.example.dev', deploy: 'git {dir}' };

describe('check.ts', () => {
  test('shows the settings and finds nothing wrong with them', () => {
    const { code, out } = check({ setup: 'bun install', app: { run: 'Start it with `bun dev`.', stop: 'pkill -F .pid' }, demo: { site: SITE } });
    expect(out).toContain('setup: "bun install"');
    expect(out).toContain('app.run: Start it with `bun dev`.');
    expect(out).toContain('app.stop: "pkill -F .pid", app.keep: (none)');
    expect(out).toContain('demo site: Demos at https://demos.example.dev, deploy "git {dir}"');
    expect(out).toContain('No problems.');
    expect(code).toBe(0);
  });

  test('reports what is wrong in them', () => {
    const { code, out } = check({ checks: ['bun test'], land: 'main', chekcs: [] });
    expect(out).toContain('checks: ["bun test"]');
    expect(out).toContain('land: main');
    expect(out).toContain('- .obeya/settings.json, chekcs: no such field (did you mean checks?)');
    expect(code).toBe(1);
  });

  test("reports a site's deploy program that is not there", () => {
    const { code, out } = check({ demo: { site: { ...SITE, deploy: 'scripts/no-such-deploy.sh {dir}' } } });
    expect(out).toContain(`- demo.site.deploy: the deploy command's program ${join(realpathSync(dir), 'shop', 'scripts/no-such-deploy.sh')} does not exist`);
    expect(code).toBe(1);
  });

  test('reports an adapter module that is still there', () => {
    const { code, out } = check({}, { '.obeya/adapter/index.ts': "export default { name: 'shop' };\n" });
    expect(out).toContain('- .obeya/adapter/ is no longer read: take over what it says into .obeya/settings.json and delete it');
    expect(code).toBe(1);
  });

  test('says which docs in the plan directory are projects and why the others are not', () => {
    expect(check({}).out).toContain('plan docs: docs/plan/ does not exist yet');
    rmSync(join(dir, 'shop'), { recursive: true, force: true });
    const { code, out } = check({}, {
      'docs/plan/shop.md': '# Shop\n\n## Workstreams\n\n- [ ] **W1:** Cart.\n',
      'docs/plan/search.md': '# Search\n\n## Workstreams\n\n- [x] **W1:** Index.\n',
      'docs/plan/rollout.md': '# Rollout\n\n## Phases\n\n- [ ] Vienna\n',
    });
    expect(out).toContain('plan docs in docs/plan/: 2 are projects (search.md, done: archived; shop.md), 1 is not\n- rollout.md: no `## Workstreams` (or `## Arbeitspakete`) section');
    expect(code).toBe(0);
  });

  test('without settings, says to write them', () => {
    const repo = gitRepo(join(dir, 'plain'), { 'README.md': 'hi\n' });
    const r = Bun.spawnSync([process.execPath, CHECK], { cwd: repo });
    expect(r.stdout.toString()).toContain("write the repository's settings first");
    expect(r.exitCode).toBe(1);
  });
});
