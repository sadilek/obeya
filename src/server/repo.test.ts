import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { watchPlanDocs } from './repo';

const DOC = '# P\n\n## Workstreams\n\n- [ ] **W1:** One.\n';

describe('watchPlanDocs', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((f) => f()));

  /** A repository directory with these files, watched from here on. */
  function watched(files: string[]) {
    const repo = mkdtempSync(join(tmpdir(), 'obeya-watch-'));
    for (const f of files) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), DOC);
    }
    let resolve = () => {};
    const stop = watchPlanDocs(repo, generic, () => resolve());
    cleanup.push(stop, () => rmSync(repo, { recursive: true, force: true }));
    /** Whether the watch fires within a while from now. */
    const next = () =>
      Promise.race([new Promise<boolean>((r) => (resolve = () => r(true))), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
    return { repo, next };
  }

  test('sees a doc change', async () => {
    const { repo, next } = watched(['docs/plan/a.md']);
    await Bun.sleep(100);
    const seen = next();
    writeFileSync(join(repo, 'docs/plan/a.md'), `${DOC}- [ ] **W2:** Two.\n`);
    expect(await seen).toBe(true);
  });

  test('sees the last doc go with its directory, as git removes it, and a first one come back', async () => {
    const { repo, next } = watched(['docs/design.md', 'docs/plan/a.md']);
    await Bun.sleep(100);
    const gone = next();
    unlinkSync(join(repo, 'docs/plan/a.md'));
    rmdirSync(join(repo, 'docs/plan'));
    expect(await gone).toBe(true);

    const back = next();
    mkdirSync(join(repo, 'docs/plan'));
    writeFileSync(join(repo, 'docs/plan/b.md'), DOC);
    expect(await back).toBe(true);

    // the plan directory is watched again once it is back
    await Bun.sleep(300);
    const changed = next();
    writeFileSync(join(repo, 'docs/plan/b.md'), `${DOC}- [ ] **W2:** Two.\n`);
    expect(await changed).toBe(true);
  });

  test('sees a first doc in a repository without a plan directory', async () => {
    const { repo, next } = watched(['README.md']);
    await Bun.sleep(100);
    const seen = next();
    mkdirSync(join(repo, 'docs/plan'), { recursive: true });
    writeFileSync(join(repo, 'docs/plan/a.md'), DOC);
    expect(await seen).toBe(true);
  });
});
