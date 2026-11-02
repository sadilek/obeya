// Watches the open pull requests of a canvas and passes what happens on them to the card's
// worker: new review comments, failed checks, conflicts. Once nothing is left for the worker, Obeya
// merges it (the owner's approval covered that), unless the repository's settings leave the merge
// to the people on the forge (`autoMerge` off); a merge makes the card live.

import type { RepoAdapter } from '../adapters/types';
import { type Board, contributionOf, type PrState, type StoredContribution } from './board';
import { confidence, lastAsked, readyToMerge, reviewOf, reviewStale, type Forge, type PrStatus } from './forge';

/** Below this share of a reviewer's confidence (4 of 5), Obeya leaves the merge to the owner. */
const MIN_CONFIDENCE = 0.8;
/** How long reading a PR fails before its card says so. */
const READ_ERROR_AFTER_MS = 10 * 60_000;
import type { Workers } from './workers';
import { messageOf } from '../core/text';

const watched = (state: string | undefined) => state === 'inPr' || state === 'waiting';

export class PrWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  /** Stopped (its canvas closed): a round still waiting for the forge leaves the cards alone. */
  private stopped = false;
  /** When the last round began. */
  private polled = 0;

  constructor(
    private board: Board,
    private workers: Workers,
    private forge: Forge,
    /** Where the forge's calls run for a card (its workspace, else the Obeya checkout). */
    private cwd: (cardId: string) => string,
    /**
     * The repository's settings, asked each round since they may change while the watcher runs:
     * accounts whose comments are not review feedback (`prNoise`), and whether Obeya merges (`autoMerge`).
     */
    private settings: () => Pick<RepoAdapter, 'prNoise' | 'autoMerge'> = () => ({}),
    /** On a canvas with several repositories: the one whose pull requests this watches. */
    private repo?: string,
    /** Called at the end of every round (the Lesestand fetches then). */
    private onRound?: () => void,
  ) {}

  start(everyMs = 120_000) {
    this.stopped = false;
    this.timer = setInterval(() => this.round(), everyMs);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /**
   * A round right away, unless one began within `gapMs`: the owner came back to Obeya, perhaps from
   * merging the PR, and should not wait for the next tick to see it.
   */
  soon(gapMs = 15_000) {
    if (this.polling || Date.now() - this.polled < gapMs) return;
    this.polled = Date.now();
    setTimeout(() => this.round());
  }

  /** A round from a timer: what goes wrong in it is logged. */
  private round() {
    this.poll().catch((e) => console.error('PR watcher:', messageOf(e)));
  }

  /**
   * One round over every card with an open pull request. The forge is asked for all of them side by
   * side, in the background: the server answers meanwhile, and a PR slow to read holds up only its
   * own card. Each card is handled as its answer comes in.
   */
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.polled = Date.now();
    try {
      const open = this.board
        .snapshot()
        // a card whose PR is merged already may wait for the owner again (its worker asks while it finishes): it is not watched again
        .items.filter((i) => watched(i.state) && !this.board.row(i.id).landed && (!this.repo || i.repo === this.repo))
        .flatMap((i) => {
          const url = this.prOf(i.id)?.url;
          return url ? [{ id: i.id, url }] : [];
        });
      await Promise.all(open.map(({ id, url }) => this.check(id, url).catch((e) => console.error(`PR ${url}:`, messageOf(e)))));
    } finally {
      this.polling = false;
    }
    if (!this.stopped) this.onRound?.();
  }

  /** Reads the card's pull request and reacts to what it says, on the card as it is by then. */
  private async check(cardId: string, url: string) {
    let status: PrStatus | undefined;
    let error: unknown;
    try {
      status = await this.forge.status(this.cwd(cardId), url);
    } catch (e) {
      error = e;
    }
    const now = this.current(cardId, url);
    if (!now) return;
    const { state, pr } = now;
    if (!status) {
      // failing for a while (a login missing, say, not the network gone for a moment), the card
      // says why once: otherwise it would wait for a merge it never sees
      const reason = messageOf(error);
      console.error(`PR ${url}:`, reason);
      const failing = pr.readError ?? { since: Date.now() };
      if (!failing.shown && Date.now() - failing.since >= READ_ERROR_AFTER_MS) {
        this.board.log(cardId, 'error', 'obeya', this.board.t.pr.unreadable(reason));
        failing.shown = true;
      }
      this.save(cardId, { ...pr, readError: failing });
      return;
    }
    if (pr.readError) delete pr.readError;
    await this.react(cardId, state, pr, status);
  }

  /**
   * The card with its pull request at `url`, as it is after a wait for the forge; none where it
   * moved on meanwhile (approved, stopped, deleted, another PR) or the watcher stopped (its canvas
   * closed).
   */
  private current(cardId: string, url: string): { state: string; pr: PrState } | null {
    const item = this.board.item(cardId);
    if (this.stopped || !item || !watched(item.state) || this.board.row(cardId).landed) return null;
    const pr = this.prOf(cardId);
    return pr?.url === url ? { state: item.state, pr } : null;
  }

  private prOf(cardId: string): PrState | null {
    const row = this.board.row(cardId);
    return row.pr ? (JSON.parse(row.pr) as PrState) : null;
  }

  private async react(cardId: string, state: string, pr: PrState, s: PrStatus) {
    if (s.state === 'MERGED') return this.workers.merged(cardId, s.mergeCommit);
    const settings = this.settings();
    const noise = settings.prNoise ?? [];
    const contribution = contributionOf(this.board.row(cardId));
    if (contribution) return this.reactToContributor(cardId, state, pr, s, contribution, noise);
    const next: PrState = { ...pr, checks: s.checks, review: reviewOf(s, noise) };
    // while the owner is being asked, news waits: it is passed on once the card is back in the PR
    if (state === 'inPr') {
      if (s.state === 'CLOSED') {
        this.save(cardId, next);
        return this.workers.prClosed(cardId);
      }
      const comments = s.comments.filter((c) => !pr.seen.includes(c.id) && c.author !== s.author && !noise.includes(c.author));
      if (comments.length) {
        next.seen = [...pr.seen, ...comments.map((c) => c.id)];
        this.workers.prEvent(
          cardId,
          this.board.t.pr.comments(comments.length, comments[0]!.author),
          [
            'New review comments on your pull request. Address them the way the repository does it (its own skill for review comments, if it has one; otherwise fix each, or leave it where a change is not right, and push). Each comment gets a reply in its own thread, not one comment for all: what you changed, or why not. Then resolve each thread, unless you still want the reviewer’s answer. Once you pushed, ask the reviewers for a new review the way the repository does it: Obeya merges only on a review of the latest commit. End your turn. Use ask if one questions a decision only the owner can make.',
            ...comments.map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}${c.url ? ` (${c.url})` : ''}:\n${c.body}`),
          ].join('\n\n'),
        );
      }
      const failed = s.checks.filter((c) => c.state === 'failure' && !pr.reported.includes(`${c.name}@${s.head}`));
      if (failed.length) {
        next.reported = [...pr.reported, ...failed.map((c) => `${c.name}@${s.head}`)];
        this.workers.prEvent(
          cardId,
          this.board.t.pr.checkFailed(failed.map((c) => c.name).join(', ')),
          ['Checks failed on your pull request. Find the cause (on GitHub, gh run view --log-failed helps), fix it, push, and end your turn.', ...failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`)].join('\n'),
        );
      }
      if (s.mergeable === 'CONFLICTING' && pr.conflictHead !== s.head) {
        next.conflictHead = s.head;
        this.workers.prEvent(
          cardId,
          this.board.t.pr.conflict,
          'Your pull request conflicts with its base branch. Bring it up to date with the latest base the way the repository does it (merge or rebase; push a rebase with --force-with-lease), resolve the conflicts, run the checks, push, and end your turn. Use ask if a conflict needs a product decision.',
        );
      } else if (s.mergeable === 'MERGEABLE') delete next.conflictHead;
      // ready only while the worker has nothing in hand: what it was told may still change the PR
      const idle = !comments.length && !failed.length && !this.workers.busyCards().includes(cardId);
      // a push the reviewer has not seen, and nobody asked for another look: the worker asks, once per commit
      if (idle && reviewStale(s, noise) && lastAsked(s) < s.changedAt! && pr.staleHead !== s.head) {
        next.staleHead = s.head;
        this.workers.prEvent(
          cardId,
          this.board.t.pr.stale,
          'Your pull request has commits its reviewers have not seen: their last word is older than the head commit, and nobody asked for another look since. Their verdict is about an older state, so Obeya does not merge on it. Ask them for a new review the way the repository does it (its own skill or script for this, if it has one; otherwise a comment mentioning the review bot), and end your turn.',
        );
      }
      const low = confidence(s, noise);
      const ready = idle && readyToMerge(s, noise);
      if (ready && low && low.score / low.of < MIN_CONFIDENCE) {
        // the reviewer doubts it: the owner decides, and merges or tells the worker what is missing
        const held = { score: `${low.score}/${low.of}`, by: low.by };
        if (pr.readyHead !== s.head || pr.held?.score !== held.score)
          this.board.log(cardId, 'state', 'obeya', this.board.t.pr.held(held.by, held.score));
        next.readyHead = s.head;
        next.held = held;
        delete next.mergeError;
        delete next.manual;
      } else if (ready && settings.autoMerge === false) {
        // the repository leaves the merge to the people on the forge: the owner merges there
        if (pr.readyHead !== s.head || pr.held || !pr.manual) this.board.log(cardId, 'state', 'obeya', this.board.t.pr.readyManual);
        next.readyHead = s.head;
        next.manual = true;
        delete next.held;
        delete next.mergeError;
      } else if (ready) {
        if (pr.readyHead !== s.head || pr.held || pr.manual) this.board.log(cardId, 'state', 'obeya', this.board.t.pr.ready);
        next.readyHead = s.head;
        delete next.held;
        delete next.manual;
        // the owner's approval covered the merge: Obeya merges, and tries again each round while the forge refuses
        let commit: string | void;
        try {
          commit = await this.forge.merge(this.cwd(cardId), pr.url!, s.head);
        } catch (e) {
          if (!this.current(cardId, pr.url!)) return;
          const reason = (messageOf(e)).replace(/^gh pr merge \S+: /, '');
          if (pr.mergeError !== reason || pr.readyHead !== s.head) this.board.log(cardId, 'state', 'obeya', this.board.t.pr.mergeFailed(reason));
          next.mergeError = reason;
          return this.save(cardId, next);
        }
        // merged on the forge: a card that moved on meanwhile, or one on a canvas closed since, sees it at its next round
        if (!this.current(cardId, pr.url!)) return;
        delete next.mergeError;
        this.save(cardId, next);
        return this.workers.merged(cardId, commit || undefined);
      } else {
        delete next.readyHead;
        delete next.mergeError;
        delete next.held;
        delete next.manual;
      }
    }
    this.save(cardId, next);
  }

  /**
   * A review card's pull request, which someone outside opened: Obeya never merges it here (only the
   * owner's approval of a reviewed head does), and what the contributor does reaches the worker only
   * while the card waits for them. Their comments count, not the PR author's being skipped as on the
   * worker's own PRs: skipped are the owner's (the account Obeya acts as, the worker's too) and
   * `prNoise`. A new head counts once, whatever the worker reviewed before.
   */
  private reactToContributor(cardId: string, state: string, pr: PrState, s: PrStatus, c: StoredContribution, noise: string[]) {
    const self = s.viewer ?? '';
    const next: PrState = { ...pr, checks: s.checks, review: reviewOf(s, noise, self) };
    if (s.mergeable === 'CONFLICTING') next.conflictHead = s.head;
    else if (s.mergeable === 'MERGEABLE') delete next.conflictHead;
    if (s.state === 'CLOSED') {
      this.save(cardId, next);
      if (!c.closed) this.workers.contributionClosed(cardId);
      return;
    }
    if (state === 'inPr') {
      const since = c.requested?.at ?? '';
      const comments = s.comments.filter((x) => !pr.seen.includes(x.id) && x.author !== self && !noise.includes(x.author) && (x.edited ?? x.at ?? '') > since);
      const reviewed = c.reviewed ?? pr.headSeen ?? s.head;
      next.headSeen ??= s.head;
      const pushed = s.head !== reviewed && pr.pushedHead !== s.head;
      if (comments.length || pushed) {
        next.seen = [...pr.seen, ...comments.map((x) => x.id)];
        if (pushed) next.pushedHead = s.head;
        this.save(cardId, next);
        const t = this.board.t.pr;
        return this.workers.contributorAnswered(
          cardId,
          pushed ? t.contributorPushed(c.author) : t.comments(comments.length, comments[0]!.author),
          [
            pushed
              ? `${c.author} pushed to the pull request since your review: its head is ${s.head.slice(0, 7)} now.`
              : `${c.author} answered on the pull request without pushing.`,
            pushed
              ? `Review the new head as you did the first: fetch it (refs/pull/${c.number}/head) into your branch, look at what changed before you run any of it, then the code review, a new demo before and after, the checks and the merge probe against the current main. Hand over again.`
              : 'Tell the owner what they said and what it means for the review: hand over again (the demo on the card stands), or ask where the owner has to decide.',
            ...comments.map((x) => `- ${x.author}${x.path ? ` on ${x.path}${x.line ? `:${x.line}` : ''}` : ''}${x.url ? ` (${x.url})` : ''}:\n${x.body}`),
          ].join('\n\n'),
        );
      }
    }
    this.save(cardId, next);
    // the remote's main moves with others' pushes, the local one with landings: what the merge would collide with, looked at afresh
    if (state === 'waiting') this.workers.recheckClash(cardId);
  }

  private save(cardId: string, pr: PrState) {
    const row = this.board.row(cardId);
    if (row.pr !== JSON.stringify(pr)) this.board.work(cardId, { pr: JSON.stringify(pr) });
  }
}
