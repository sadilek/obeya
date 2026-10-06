// Watches the open pull requests of a canvas and passes what happens on them to the card's
// worker: new review comments, failed checks, conflicts. Once nothing is left for the worker, Obeya
// merges it (the owner's approval covered that); a merge makes the card live.

import type { Board, PrState } from './board';
import { confidence, lastAsked, readyToMerge, reviewOf, reviewStale, type Forge, type PrStatus } from './forge';

/** Below this share of a reviewer's confidence (4 of 5), Obeya leaves the merge to the owner. */
const MIN_CONFIDENCE = 0.8;
import type { Workers } from './workers';

export class PrWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  /** When the last round began. */
  private polled = 0;

  constructor(
    private board: Board,
    private workers: Workers,
    private forge: Forge,
    /** Where `gh` runs for a card (its workspace, else the Obeya checkout). */
    private cwd: (cardId: string) => string,
    /** Accounts whose comments are not review feedback. */
    private noise: string[] = [],
    /** On a canvas with several repositories: the one whose pull requests this watches. */
    private repo?: string,
    /** Called at the end of every round (the Lesestand fetches then). */
    private onRound?: () => void,
  ) {}

  start(everyMs = 120_000) {
    this.timer = setInterval(() => this.poll(), everyMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * A round right away, unless one began within `gapMs`: the owner came back to Obeya, perhaps from
   * merging on GitHub, and should not wait for the next tick to see it.
   */
  soon(gapMs = 15_000) {
    if (this.polling || Date.now() - this.polled < gapMs) return;
    this.polled = Date.now();
    setTimeout(() => this.poll());
  }

  /** One round over every card with an open pull request. */
  poll() {
    if (this.polling) return;
    this.polling = true;
    this.polled = Date.now();
    try {
      for (const item of this.board.snapshot().items) {
        if (item.state !== 'inPr' && item.state !== 'waiting') continue;
        if (this.repo && item.repo !== this.repo) continue;
        const row = this.board.row(item.id);
        const pr = row.pr ? (JSON.parse(row.pr) as PrState) : null;
        if (!pr?.url) continue;
        let status: PrStatus;
        try {
          status = this.forge.status(this.cwd(item.id), pr.url);
        } catch (e) {
          console.error(`PR ${pr.url}:`, e instanceof Error ? e.message : e);
          continue;
        }
        this.react(item.id, item.state, pr, status);
      }
    } finally {
      this.polling = false;
    }
    this.onRound?.();
  }

  private react(cardId: string, state: string, pr: PrState, s: PrStatus) {
    if (s.state === 'MERGED') return this.workers.merged(cardId);
    const next: PrState = { ...pr, checks: s.checks, review: reviewOf(s, this.noise) };
    // while the owner is being asked, news waits: it is passed on once the card is back in the PR
    if (state === 'inPr') {
      if (s.state === 'CLOSED') {
        this.save(cardId, next);
        return this.workers.prClosed(cardId);
      }
      const comments = s.comments.filter((c) => !pr.seen.includes(c.id) && c.author !== s.author && !this.noise.includes(c.author));
      if (comments.length) {
        next.seen = [...pr.seen, ...comments.map((c) => c.id)];
        this.workers.prEvent(
          cardId,
          comments.length === 1 ? `Neuer Review-Kommentar von ${comments[0]!.author}, an den Agenten weitergegeben.` : `${comments.length} neue Review-Kommentare, an den Agenten weitergegeben.`,
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
          `Check fehlgeschlagen: ${failed.map((c) => c.name).join(', ')}. Der Agent sieht nach.`,
          ['Checks failed on your pull request. Find the cause (gh run view --log-failed helps), fix it, push, and end your turn.', ...failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`)].join('\n'),
        );
      }
      if (s.mergeable === 'CONFLICTING' && pr.conflictHead !== s.head) {
        next.conflictHead = s.head;
        this.workers.prEvent(
          cardId,
          'Konflikt mit dem Zielbranch. Der Agent bringt den Branch auf Stand.',
          'Your pull request conflicts with its base branch. Bring it up to date with the latest base the way the repository does it (merge or rebase; push a rebase with --force-with-lease), resolve the conflicts, run the checks, push, and end your turn. Use ask if a conflict needs a product decision.',
        );
      } else if (s.mergeable === 'MERGEABLE') delete next.conflictHead;
      // ready only while the worker has nothing in hand: what it was told may still change the PR
      const idle = !comments.length && !failed.length && !this.workers.busyCards().includes(cardId);
      // a push the reviewer has not seen, and nobody asked for another look: the worker asks, once per commit
      if (idle && reviewStale(s, this.noise) && lastAsked(s) < s.changedAt! && pr.staleHead !== s.head) {
        next.staleHead = s.head;
        this.workers.prEvent(
          cardId,
          'Neuer Stand seit dem letzten Review, um ein neues hat niemand gebeten. Der Agent fragt danach.',
          'Your pull request has commits its reviewers have not seen: their last word is older than the head commit, and nobody asked for another look since. Their verdict is about an older state, so Obeya does not merge on it. Ask them for a new review the way the repository does it (its own skill or script for this, if it has one; otherwise a comment mentioning the review bot), and end your turn.',
        );
      }
      const low = confidence(s, this.noise);
      if (idle && readyToMerge(s, this.noise) && low && low.score / low.of < MIN_CONFIDENCE) {
        // the reviewer doubts it: the owner decides, and merges on GitHub or tells the worker what is missing
        const held = { score: `${low.score}/${low.of}`, by: low.by };
        if (pr.readyHead !== s.head || pr.held?.score !== held.score)
          this.board.log(cardId, 'state', 'obeya', `Bereit zum Mergen, aber ${held.by} gibt nur ${held.score}: Unter 4/5 mergt Obeya nicht selbst. Du entscheidest.`);
        next.readyHead = s.head;
        next.held = held;
        delete next.mergeError;
      } else if (idle && readyToMerge(s, this.noise)) {
        if (pr.readyHead !== s.head || pr.held) this.board.log(cardId, 'state', 'obeya', 'Bereit zum Mergen: Checks grün, alle Anmerkungen erledigt, das Review ist durch. Obeya mergt.');
        next.readyHead = s.head;
        delete next.held;
        // the owner's approval covered the merge: Obeya merges, and tries again each round while GitHub refuses
        try {
          this.forge.merge(this.cwd(cardId), pr.url!, s.head);
          delete next.mergeError;
          this.save(cardId, next);
          return this.workers.merged(cardId);
        } catch (e) {
          const reason = (e instanceof Error ? e.message : String(e)).replace(/^gh pr merge \S+: /, '');
          if (pr.mergeError !== reason || pr.readyHead !== s.head) this.board.log(cardId, 'state', 'obeya', `Obeya konnte nicht mergen: ${reason}`);
          next.mergeError = reason;
        }
      } else {
        delete next.readyHead;
        delete next.mergeError;
        delete next.held;
      }
    }
    this.save(cardId, next);
  }

  private save(cardId: string, pr: PrState) {
    const row = this.board.row(cardId);
    if (row.pr !== JSON.stringify(pr)) this.board.work(cardId, { pr: JSON.stringify(pr) });
  }
}
