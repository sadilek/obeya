import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
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
    /** Whether the watch fires within a while from now (seconds when fseventsd is swamped). */
    const next = () =>
      Promise.race([new Promise<boolean>((r) => (resolve = () => r(true))), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    return { repo, next };
  }

  /**
   * Waits until the watches opened so far are live. On macOS a new watch takes a moment (more on a
   * busy machine), and Bun has one FSEvents stream for all watches of the process, started afresh
   * for each new one: they are live once a watch opened after them sees a change. On Linux a watch
   * is live at once.
   */
  async function live() {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-probe-'));
    let seen = false;
    const probe = watch(dir, () => (seen = true));
    cleanup.push(() => probe.close(), () => rmSync(dir, { recursive: true, force: true }));
    for (let i = 0; !seen && i < 100; i++) {
      writeFileSync(join(dir, 'probe'), String(i));
      await Bun.sleep(20);
    }
  }

  test('sees a doc change', async () => {
    const { repo, next } = watched(['docs/plan/a.md']);
    await live();
    const seen = next();
    writeFileSync(join(repo, 'docs/plan/a.md'), `${DOC}- [ ] **W2:** Two.\n`);
    expect(await seen).toBe(true);
  }, 20_000);

  test('sees the last doc go with its directory, as git removes it, and a first one come back', async () => {
    const { repo, next } = watched(['docs/design.md', 'docs/plan/a.md']);
    await live();
    const gone = next();
    unlinkSync(join(repo, 'docs/plan/a.md'));
    rmdirSync(join(repo, 'docs/plan'));
    expect(await gone).toBe(true);

    // right after the watches were re-armed
    const back = next();
    mkdirSync(join(repo, 'docs/plan'));
    writeFileSync(join(repo, 'docs/plan/b.md'), DOC);
    expect(await back).toBe(true);

    // the plan directory is watched again once it is back
    await live();
    const changed = next();
    writeFileSync(join(repo, 'docs/plan/b.md'), `${DOC}- [ ] **W2:** Two.\n`);
    expect(await changed).toBe(true);
  }, 20_000);

  test('sees a first doc in a repository without a plan directory', async () => {
    const { repo, next } = watched(['README.md']);
    await live();
    const seen = next();
    mkdirSync(join(repo, 'docs/plan'), { recursive: true });
    writeFileSync(join(repo, 'docs/plan/a.md'), DOC);
    expect(await seen).toBe(true);
  }, 20_000);
});
