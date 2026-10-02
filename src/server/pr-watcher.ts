// Watches the open pull requests of a canvas and passes what happens on them to the card's
// worker: new review comments, failed checks, conflicts. A merge makes the card live.

import type { Board, PrState } from './board';
import type { Forge, PrStatus } from './forge';
import type { Workers } from './workers';

export class PrWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

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
  ) {}

  start(everyMs = 120_000) {
    this.timer = setInterval(() => this.poll(), everyMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One round over every card with an open pull request. */
  poll() {
    if (this.polling) return;
    this.polling = true;
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
  }

  private react(cardId: string, state: string, pr: PrState, s: PrStatus) {
    if (s.state === 'MERGED') return this.workers.merged(cardId);
    const next: PrState = { ...pr, checks: s.checks };
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
            'New review comments on your pull request. Address them the way the repository does it (its own skill for review comments, if it has one; otherwise fix each, or leave it where a change is not right, and push). Each comment gets a reply in its own thread, not one comment for all: what you changed, or why not. Then resolve each thread, unless you still want the reviewer’s answer. End your turn. Use ask if one questions a decision only the owner can make.',
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
    }
    this.save(cardId, next);
  }

  private save(cardId: string, pr: PrState) {
    const row = this.board.row(cardId);
    if (row.pr !== JSON.stringify(pr)) this.board.work(cardId, { pr: JSON.stringify(pr) });
  }
}
