import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { ghHosts, oldLinuxBun, onGitHub, outsidePlanDir, readPlanDocs, remoteHost, repoInfo, repoInfoAsync, sameRemote, watchPlanDocs } from './repo';
import { gitRepo } from './testing';
import { git } from './workspaces';

const DOC = '# P\n\n## Workstreams\n\n- [ ] **W1:** One.\n';

describe('readPlanDocs', () => {
  test('reads the docs that are projects, and the others with their reason; the excluded ones not at all', () => {
    const repo = mkdtempSync(join(tmpdir(), 'obeya-read-'));
    try {
      expect(readPlanDocs(repo, generic)).toEqual({ docs: [], others: [] });
      mkdirSync(join(repo, 'docs/plan'), { recursive: true });
      writeFileSync(join(repo, 'docs/plan/p.md'), DOC);
      writeFileSync(join(repo, 'docs/plan/rollout.md'), '# Rollout\n\n## Phases\n\n- [ ] One\n');
      writeFileSync(join(repo, 'docs/plan/rfc.md'), '# RFC\n\n## Workstreams\n\nTo be cut.\n');
      writeFileSync(join(repo, 'docs/plan/TEMPLATE.md'), '# Template\n');
      writeFileSync(join(repo, 'docs/plan/notes.txt'), 'not markdown');
      const { docs, others } = readPlanDocs(repo, generic);
      expect(docs.map((d) => d.file)).toEqual(['docs/plan/p.md']);
      expect(others).toEqual([
        { file: 'docs/plan/rfc.md', reason: 'noChecklist' },
        { file: 'docs/plan/rollout.md', reason: 'noWorkstreams' },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('repoInfoAsync', () => {
  test('reads a repository as repoInfo does, without the server waiting for git; a folder without git is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-repo-info-'));
    try {
      const repo = gitRepo(join(dir, 'shop'));
      expect(await repoInfoAsync(repo)).toEqual({ path: repo, remote: null, branch: 'main' });
      git(repo, 'remote', 'add', 'origin', 'https://example.com/acme/shop.git');
      git(repo, 'branch', '-m', 'trunk');
      expect(await repoInfoAsync(repo)).toEqual(repoInfo(repo));
      expect(await repoInfoAsync(repo)).toEqual({ path: repo, remote: 'https://example.com/acme/shop.git', branch: 'trunk' });
      mkdirSync(join(dir, 'plain'));
      await expect(repoInfoAsync(join(dir, 'plain'))).rejects.toThrow('is not a git repository');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a plan folder outside the repository', () => {
  test('is an absolute path or one from ~, referred to with forward slashes; a path in the repository is none', () => {
    expect(outsidePlanDir('docs/plan', '/home/jo')).toBeNull();
    expect(outsidePlanDir('/home/jo/plans/', '/home/jo')).toBe('/home/jo/plans');
    expect(outsidePlanDir('~/plans/shop', '/home/jo')).toBe('/home/jo/plans/shop');
    expect(outsidePlanDir('~', '/home/jo')).toBe('/home/jo');
    expect(outsidePlanDir('~other/plans', '/home/jo')).toBeNull();
  });

  test('is read where it is, not from the repository, its docs by their absolute path; and watched there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obeya-outside-'));
    try {
      const repo = join(root, 'repo');
      const plans = join(root, 'private', 'plans');
      mkdirSync(join(repo, 'docs/plan'), { recursive: true });
      writeFileSync(join(repo, 'docs/plan/shared.md'), DOC);
      const adapter = { ...generic, planDocs: { dir: plans, exclude: [] } };
      expect(readPlanDocs(repo, adapter)).toEqual({ docs: [], others: [] });
      let calls = 0;
      const stop = watchPlanDocs(repo, adapter, () => calls++, { watches: false, poll: 20 });
      try {
        mkdirSync(plans, { recursive: true });
        writeFileSync(join(plans, 'mine.md'), DOC);
        for (let t = 0; !calls && t < 100; t++) await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBeGreaterThan(0);
      } finally {
        stop();
      }
      expect(readPlanDocs(repo, adapter).docs.map((d) => d.file)).toEqual([`${plans.replaceAll('\\', '/')}/mine.md`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('oldLinuxBun', () => {
  test('is Bun before 1.3.14 on Linux, and nothing elsewhere', () => {
    expect(oldLinuxBun('linux', '1.3.12')).toBe(true);
    expect(oldLinuxBun('linux', '1.3.14-canary.1')).toBe(true);
    expect(oldLinuxBun('linux', '1.3.14')).toBe(false);
    expect(oldLinuxBun('linux', '1.4.0')).toBe(false);
    expect(oldLinuxBun('darwin', '1.3.12')).toBe(false);
    expect(oldLinuxBun('win32', '1.3.12')).toBe(false);
  });
});

describe('watchPlanDocs', () => {
  /**
   * How long a step may go on. A saturated fseventsd loses most events: on this Mac (2026-10-14,
   * fseventsd at full CPU) Bun, Node and fswatch alike saw only one to four of ten writes to a fresh
   * directory, seconds late. The running Obeya has its safety-net poll for that; these tests check
   * the watches alone, so a step whose change the system lost is made again.
   */
  const budget = 120_000;
  /** A file the tests write at the repository's top, to learn that the events before it have come. */
  const marker = 'marker';
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((f) => f()));

  /** A repository directory with these files, watched from here on (by the watches alone, or as `options` say). */
  function watched(files: string[], options: Parameters<typeof watchPlanDocs>[3] = { poll: 0 }) {
    const repo = mkdtempSync(join(tmpdir(), 'obeya-watch-'));
    for (const f of files) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), DOC);
    }
    let fired = () => {};
    let calls = 0;
    const stop = watchPlanDocs(repo, generic, () => {
      calls++;
      fired();
    }, options);
    // a plain watch on the whole repository, in the same FSEvents stream as the watches, tells
    // whether a change reached the process at all
    let delivered = (_path: string) => {};
    const control = watch(repo, { recursive: true }, (_, file) => delivered(String(file).replaceAll('\\', '/')));
    cleanup.push(stop, () => control.close(), () => rmSync(repo, { recursive: true, force: true }));

    /**
     * What becomes of the change `make` makes to `path` (in the repository): the watches fire for
     * it, or the plain watch sees it and the watches do not within a moment ('missed'), or neither
     * sees it ('lost'). Events come in order, nearly always: the change counts as lost once a marker
     * written after it has come and a second more has passed without it.
     */
    const attempt = (path: string, make: () => void) =>
      new Promise<'fired' | 'missed' | 'lost'>((resolve) => {
        let missed: ReturnType<typeof setTimeout> | undefined;
        let lost: ReturnType<typeof setTimeout> | undefined;
        const done = (outcome: 'fired' | 'missed' | 'lost') => {
          clearInterval(marking);
          clearTimeout(missed);
          clearTimeout(lost);
          fired = () => {};
          delivered = () => {};
          resolve(outcome);
        };
        fired = () => done('fired');
        delivered = (file) => {
          if (file === path) {
            clearTimeout(lost);
            missed ??= setTimeout(() => done('missed'), 2000);
          } else if (file === marker && !missed) lost ??= setTimeout(() => done('lost'), 1000);
        };
        make();
        const marking = setInterval(() => writeFileSync(join(repo, marker), String(Date.now())), 100);
      });

    /**
     * Whether the watches fire for the change `make` makes to `path` (in the repository). While the
     * system loses it, `reset` puts back what it changed, and it is made again once the watches are
     * live. A lost event that comes after all is one of the same kind and lets a later try pass.
     */
    async function sees(path: string, make: () => void, reset = () => {}) {
      for (const end = Date.now() + budget; Date.now() < end; ) {
        const outcome = await attempt(path, make);
        if (outcome !== 'lost') return outcome === 'fired';
        reset();
        await live();
      }
      throw new Error(`the system lost every change of ${path} for ${budget / 1000} s`);
    }
    return { repo, sees, calls: () => calls };
  }

  /**
   * Waits until the watches opened so far are live, and what they have seen is reported. On macOS a
   * new watch takes a moment (more on a busy machine), and Bun has one FSEvents stream for all
   * watches of the process, started afresh for each new one: they are live once a watch opened
   * after them sees a change. A change made before that is lost for good. On Linux a watch is live
   * at once.
   */
  async function live() {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-probe-'));
    let seen = false;
    const probe = watch(dir, () => (seen = true));
    cleanup.push(() => probe.close(), () => rmSync(dir, { recursive: true, force: true }));
    for (const end = Date.now() + budget; !seen; await Bun.sleep(50)) {
      if (Date.now() > end) throw new Error(`a new watch saw nothing for ${budget / 1000} s`);
      writeFileSync(join(dir, 'probe'), String(Date.now()));
    }
    await Bun.sleep(300); // past the watches' debounce
  }

  test('sees a doc change', async () => {
    const { repo, sees } = watched(['docs/plan/a.md']);
    await live();
    expect(await sees('docs/plan/a.md', () => writeFileSync(join(repo, 'docs/plan/a.md'), `${DOC}- [ ] **W2:** Two.\n`))).toBe(true);
  }, 2 * budget);

  test('sees the last doc go with its directory, as git removes it, and a first one come back', async () => {
    const { repo, sees } = watched(['docs/design.md', 'docs/plan/a.md']);
    const plan = join(repo, 'docs/plan');
    const gone = () => {
      unlinkSync(join(plan, 'a.md'));
      rmdirSync(plan);
    };
    const back = () => {
      mkdirSync(plan);
      writeFileSync(join(plan, 'b.md'), DOC);
    };
    await live();
    expect(await sees('docs/plan', gone, () => {
      mkdirSync(plan);
      writeFileSync(join(plan, 'a.md'), DOC);
    })).toBe(true);

    // right after the watches were re-armed
    expect(await sees('docs/plan', back, () => rmSync(plan, { recursive: true }))).toBe(true);

    // the plan directory is watched again once it is back
    await live();
    expect(await sees('docs/plan/b.md', () => writeFileSync(join(plan, 'b.md'), `${DOC}- [ ] **W2:** Two.\n`))).toBe(true);
  }, 4 * budget);

  test('sees a first doc in a repository without a plan directory', async () => {
    const { repo, sees } = watched(['README.md']);
    await live();
    const first = () => {
      mkdirSync(join(repo, 'docs/plan'), { recursive: true });
      writeFileSync(join(repo, 'docs/plan/a.md'), DOC);
    };
    expect(await sees('docs', first, () => rmSync(join(repo, 'docs'), { recursive: true }))).toBe(true);
  }, 2 * budget);

  test('the safety-net poll alone sees docs change, come and go, and stays quiet otherwise', async () => {
    const { repo, sees, calls } = watched(['README.md'], { watches: false, poll: 50 });
    expect(await sees('docs/plan/a.md', () => {
      mkdirSync(join(repo, 'docs/plan'), { recursive: true });
      writeFileSync(join(repo, 'docs/plan/a.md'), DOC);
    })).toBe(true);

    expect(await sees('docs/plan/a.md', () => writeFileSync(join(repo, 'docs/plan/a.md'), `${DOC}- [ ] **W2:** Two.\n`))).toBe(true);

    // what it has reported once, it does not report again; nor anything that is not a plan doc
    const before = calls();
    writeFileSync(join(repo, 'docs/plan/notes.txt'), 'x');
    await Bun.sleep(400);
    expect(calls()).toBe(before);

    expect(await sees('docs/plan', () => rmSync(join(repo, 'docs/plan'), { recursive: true }))).toBe(true);
  }, 4 * budget);
});

describe('a remote on GitHub', () => {
  test('is told by the host of its URL, in every form git takes, and a path has none', () => {
    const hosts = (urls: string[]) => urls.map(remoteHost);
    expect(hosts(['https://github.com/acme/shop.git', 'ssh://git@GitHub.com:22/acme/shop.git', 'git@github.com:acme/shop.git', 'github.com:acme/shop'])).toEqual(['github.com', 'github.com', 'github.com', 'github.com']);
    expect(hosts(['/srv/git/shop', '../shop', 'file:///srv/git/shop', 'C:\\repos\\shop', 'C:/repos/shop'])).toEqual([null, null, null, null, null]);
    expect(onGitHub('https://github.com/acme/shop.git', () => [])).toBe(true);
    expect(onGitHub('git@ssh.github.com:acme/shop.git', () => [])).toBe(true);
    // Enterprise Cloud, which gh may reach through GH_TOKEN alone
    expect(onGitHub('https://acme.ghe.com/acme/shop.git', () => [])).toBe(true);
    expect(onGitHub('https://gitlab.com/acme/shop.git', () => [])).toBe(false);
    expect(onGitHub('https://git.acme.com/acme/shop.git', () => ['git.acme.com'])).toBe(true);
    expect(onGitHub('/srv/git/shop', () => ['github.com'])).toBe(false);
  });

  test('is the same repository over https and ssh, in every form git takes', () => {
    const forms = ['https://github.com/acme/shop.git', 'https://github.com/Acme/shop/', 'ssh://git@GitHub.com:22/acme/shop.git', 'git@github.com:acme/shop.git', 'github.com:acme/shop'];
    for (const a of forms) for (const b of forms) expect(sameRemote(a, b)).toBe(true);
    expect(sameRemote('git@github.com:acme/shop.git', 'https://github.com/acme/shop-api.git')).toBe(false);
    expect(sameRemote('git@github.com:acme/shop.git', 'https://gitlab.com/acme/shop.git')).toBe(false);
    expect(sameRemote('git@github.com:acme/shop.git', 'https://github.com/other/shop.git')).toBe(false);
    expect(sameRemote('/srv/git/shop', '/srv/git/shop.git/')).toBe(true);
    expect(sameRemote('/srv/git/shop', 'git@github.com:srv/git/shop')).toBe(false);
  });

  test("on another host counts where the GitHub CLI is logged into it, by its hosts.yml where gh keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-gh-'));
    try {
      const yml = 'github.com:\n    users:\n        t:\n    user: t\n    git_protocol: ssh\ngit.acme.com:\n    user: t\n';
      for (const d of ['own', 'xdg/gh', 'AppData/GitHub CLI']) {
        mkdirSync(join(dir, d), { recursive: true });
        writeFileSync(join(dir, d, 'hosts.yml'), yml);
      }
      expect(ghHosts({ GH_CONFIG_DIR: join(dir, 'own'), XDG_CONFIG_HOME: join(dir, 'none') })).toEqual(['github.com', 'git.acme.com']);
      expect(ghHosts({ XDG_CONFIG_HOME: join(dir, 'xdg') })).toEqual(['github.com', 'git.acme.com']);
      expect(ghHosts({ AppData: join(dir, 'AppData') }, 'win32')).toEqual(['github.com', 'git.acme.com']);
      expect(ghHosts({ GH_CONFIG_DIR: join(dir, 'none') })).toEqual([]);
      // logged in through the environment only
      expect(ghHosts({ GH_CONFIG_DIR: join(dir, 'none'), GH_HOST: 'github.example.com', GH_ENTERPRISE_TOKEN: 't' })).toEqual(['github.example.com']);
      expect(ghHosts({ GH_CONFIG_DIR: join(dir, 'none'), GH_HOST: 'github.example.com', GH_TOKEN: 't' })).toEqual([]);
      expect(ghHosts({ GH_CONFIG_DIR: join(dir, 'none'), GH_HOST: 'example.ghe.com', GH_TOKEN: 't' })).toEqual(['example.ghe.com']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
