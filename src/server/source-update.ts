// Obeya from a clone of its repository (README: From source): the clone's upstream, `origin/main`
// as a rule, gets new commits that the clone has only once its owner pulls them. This fetches the
// upstream at the start and every hour and tells the bar while commits that change code wait there
// (docs alone do not count, as for the self-update). The owner's "git pull" fast-forwards the
// checkout to them, and the self-update (watchOwnCode) restarts Obeya with the new code as after a
// landing, once the workers paused. Where a fast-forward cannot go (commits of the checkout's own,
// uncommitted changes in the way) the bar says so, and the owner pulls by hand.

import { inert } from '../core/inert';
import type { SourceUpdate } from '../core/types';
import { Watched } from '../core/watched';
import { BadRequest } from './board';
import { worktreeNames } from './workspaces';
import { gitRun, NO_PROMPT } from './git';

/** How often the upstream is fetched. */
export const FETCH_EVERY_MS = 60 * 60_000;
/** A fetch that hangs (a network that answers nothing) is given up after this long. */
const FETCH_TIMEOUT_MS = 60_000;
/** How many of the new commits the bar names. */
const SHOWN = 10;

type Git = (...args: string[]) => Promise<{ ok: boolean; out: string }>;

/** The new commits there are to pull (`current`), while there are. */
export class SourceUpdates extends Watched<SourceUpdate> {
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | null = null;
  private pulling = false;
  private readonly git: Git;

  constructor(
    readonly checkout: string,
    private o: { fetchEveryMs?: number } = {},
  ) {
    super();
    this.git = async (...args) => {
      // a remote that asks for a password asks no one: the fetch fails and is tried again next time
      const r = await gitRun(checkout, args, { env: NO_PROMPT, timeout: FETCH_TIMEOUT_MS });
      return { ok: r.code === 0, out: (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim() };
    };
  }

  /** Looks now, and again every hour; returns what stops it. */
  start(): () => void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.o.fetchEveryMs ?? FETCH_EVERY_MS);
    this.timer.unref?.();
    return () => clearInterval(this.timer);
  }

  /** Fetches the upstream (unless `fetch` is false) and works out what waits there; one check at a time. */
  check(fetch = true): Promise<void> {
    this.checking ??= this.look(fetch).finally(() => (this.checking = null));
    return this.checking;
  }

  /**
   * The owner's "git pull": fetches once more and fast-forwards the checkout to its upstream. What
   * git refuses stays on the update (`error`) for the bar to show; nothing there to pull, or a pull
   * that cannot be a fast-forward, is refused.
   */
  async pull(): Promise<void> {
    if (this.pulling) return;
    await this.check();
    const u = this.current();
    if (!u) throw new BadRequest('invalid', 'nothing to pull');
    if (u.blocked) throw new BadRequest('invalid', `${u.upstream} cannot be pulled by Obeya: ${u.blocked.why}`);
    this.pulling = true;
    try {
      const r = await this.git('merge', '--ff-only', '--quiet', '@{upstream}');
      if (!r.ok) return this.set({ ...u, error: r.out || 'git merge --ff-only failed' });
      console.log(`Obeya: pulled ${u.count} ${u.count === 1 ? 'commit' : 'commits'} from ${u.upstream} into ${this.checkout}`);
      await this.check(false);
    } finally {
      this.pulling = false;
    }
  }

  private async look(fetch: boolean) {
    const upstream = await this.git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    // a detached HEAD, or a branch that follows nothing (a card's): nothing to pull
    if (!upstream.ok) return this.set(null);
    if (fetch) await this.fetch();
    const count = Number((await this.git('rev-list', '--count', 'HEAD..@{upstream}')).out) || 0;
    if (!count) return this.set(null);
    // what the upstream changed since the checkout branched off it, not what the checkout changed itself
    const changed = (await this.git('-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD...@{upstream}')).out.split('\n').filter(Boolean);
    if (!changed.some((f) => !inert(f))) return this.set(null);
    const log = await this.git('log', `-n${SHOWN}`, '--format=%ct%x09%s', 'HEAD..@{upstream}');
    const commits = log.out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { subject: line.slice(tab + 1), date: Number(line.slice(0, tab)) * 1000 };
      });
    const update: SourceUpdate = { upstream: upstream.out, checkout: this.checkout, count, commits };
    const blocked = await this.blocked();
    if (blocked) update.blocked = blocked;
    // a failed pull's message stays until the next pull, unless what it was about has changed
    const last = this.current();
    if (last?.error && last.count === count && JSON.stringify(last.blocked) === JSON.stringify(blocked)) update.error = last.error;
    this.set(update);
  }

  /** Why a fast-forward to the upstream would not go, if it would not. */
  private async blocked(): Promise<SourceUpdate['blocked'] | undefined> {
    if (!(await this.git('merge-base', '--is-ancestor', 'HEAD', '@{upstream}')).ok) return { why: 'diverged' };
    const theirs = new Set((await this.git('-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD', '@{upstream}')).out.split('\n').filter(Boolean));
    // uncommitted changes, staged or not, to a file the pull would change: git refuses to overwrite them
    const mine = await worktreeNames(this.checkout, 'HEAD').catch(() => []);
    const files = mine.filter((f) => theirs.has(f));
    return files.length ? { why: 'local', files } : undefined;
  }

  /** Fetches the branch the upstream is (`refs/remotes/<remote>/<branch>`) and nothing else, without FETCH_HEAD, as the read tree does. */
  private async fetch() {
    const branch = (await this.git('symbolic-ref', '--quiet', '--short', 'HEAD')).out;
    const remote = (await this.git('config', `branch.${branch}.remote`)).out;
    const merge = (await this.git('config', `branch.${branch}.merge`)).out;
    const tracking = (await this.git('rev-parse', '--symbolic-full-name', '@{upstream}')).out;
    // an upstream that is a local branch (`remote` is `.`) has nothing to fetch
    if (!remote || remote === '.' || !merge || !tracking.startsWith('refs/remotes/')) return;
    const r = await this.git('fetch', '--quiet', '--no-write-fetch-head', remote, `+${merge}:${tracking}`);
    if (!r.ok) console.error(`Obeya: git fetch ${remote} in ${this.checkout}: ${r.out}`);
  }
}
