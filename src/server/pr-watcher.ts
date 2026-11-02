// Watches the open pull requests of a canvas and passes what happens on them to the card's
// worker: new review comments, failed checks, conflicts. Once nothing is left for the worker, Obeya
// merges it (the owner's approval covered that), unless the repository's settings leave the merge
// to the people on the forge (`autoMerge` off). A card may have several pull requests (one in
// another repository its work also needed): each is watched alike, and the card is live once all of
// them are merged.

import type { RepoAdapter } from '../adapters/types';
import { type Board, contributionOf, type PrState, type StoredContribution } from './board';
import { confidence, lastAsked, MIN_CONFIDENCE, passing, reviewOf, reviewStale, waitsOf, type Forge, type PrStatus } from './forge';
import type { PrWait } from '../core/types';

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
        .flatMap((i) => this.openPrs(i.id).map((url) => ({ id: i.id, url })));
      // a card whose PRs are all merged but one closed meanwhile, which the owner left closed: nothing holds it up
      for (const i of this.board.snapshot().items) {
        if (i.state !== 'inPr' || this.board.row(i.id).landed || (this.repo && i.repo !== this.repo) || this.openPrs(i.id).length) continue;
        if (!this.allMerged(i.id) || this.workers.busyCards().includes(i.id)) continue;
        const first = this.prsOf(i.id)[0]!;
        this.workers.merged(i.id, typeof first.merged === 'string' ? first.merged : undefined);
      }
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
   * moved on meanwhile (approved, stopped, deleted, another PR, that one merged or closed) or the
   * watcher stopped (its canvas closed).
   */
  private current(cardId: string, url: string): { state: string; pr: PrState } | null {
    const item = this.board.item(cardId);
    if (this.stopped || !item || !watched(item.state) || this.board.row(cardId).landed) return null;
    const pr = this.prsOf(cardId).find((p) => p.url === url);
    return pr && !pr.merged && !pr.closed ? { state: item.state, pr } : null;
  }

  /** The card's first pull request as stored, with the further ones in `more`. */
  private stored(cardId: string): PrState | null {
    const row = this.board.row(cardId);
    return row.pr ? (JSON.parse(row.pr) as PrState) : null;
  }

  /** Each of the card's pull requests on its own (the first without `more`), the first first. */
  private prsOf(cardId: string): PrState[] {
    const root = this.stored(cardId);
    if (!root) return [];
    const { more, ...first } = root;
    return [first, ...(more ?? [])];
  }

  /** The URLs of the card's pull requests still open as far as Obeya knows. */
  private openPrs(cardId: string): string[] {
    return this.prsOf(cardId).flatMap((p) => (p.url && !p.merged && !p.closed ? [p.url] : []));
  }

  /** Whether the card's work is merged: its first pull request and each further one not closed. */
  private allMerged(cardId: string): boolean {
    const [first, ...more] = this.prsOf(cardId);
    return !!first?.url && !!first.merged && more.every((m) => m.merged || m.closed);
  }

  /**
   * The pull request at `url` merged, with `commit` the merge put on its base where the forge said:
   * once the card's others are merged too, the card is live, with the first one's merge as its
   * landing; until then the card's log says what it still waits for.
   */
  private mergedPr(cardId: string, pr: PrState, commit?: string) {
    if (this.prsOf(cardId).length === 1) return this.workers.merged(cardId, commit);
    this.save(cardId, { ...pr, merged: commit ?? true });
    if (this.allMerged(cardId)) {
      const first = this.prsOf(cardId)[0]!;
      return this.workers.merged(cardId, typeof first.merged === 'string' ? first.merged : undefined);
    }
    const left = this.prsOf(cardId).filter((p) => !p.merged && !p.closed);
    this.board.log(cardId, 'state', 'obeya', this.board.t.pr.mergedOne(prLabel(pr), left.map((p) => (p.url ? prLabel(p) : null))));
  }

  private async react(cardId: string, state: string, pr: PrState, s: PrStatus) {
    const contribution = contributionOf(this.board.row(cardId));
    if (s.state === 'MERGED') return contribution ? this.workers.merged(cardId, s.mergeCommit) : this.mergedPr(cardId, pr, s.mergeCommit);
    const settings = this.settings();
    const noise = settings.prNoise ?? [];
    if (contribution) return this.reactToContributor(cardId, state, pr, s, contribution, noise);
    const next: PrState = { ...pr, checks: s.checks, review: reviewOf(s, noise) };
    // which pull request a message is about, where the card has several
    const which = this.prsOf(cardId).length > 1 ? ` (${pr.url})` : '';
    // while the owner is being asked, news waits: it is passed on once the card is back in the PR
    if (state === 'inPr') {
      if (s.state === 'CLOSED') {
        // a further one, closed, holds up nothing: the owner says whether it is opened again
        this.save(cardId, which && this.prsOf(cardId)[0]?.url !== pr.url ? { ...next, closed: true } : next);
        return this.workers.prClosed(cardId);
      }
      // an approval without words asks the worker for nothing
      // a comment rewritten into something other than a passing verdict is news again (a summary that now asks for a fix)
      const key = (c: PrStatus['comments'][number]) => (c.edited && !passing(c) ? `${c.id}@${c.edited}` : c.id);
      const comments = s.comments.filter((c) => !pr.seen.includes(key(c)) && c.author !== s.author && !noise.includes(c.author) && (c.body.trim() || c.verdict === 'changes'));
      if (comments.length) {
        next.seen = [...new Set([...pr.seen, ...comments.flatMap((c) => [c.id, key(c)])])];
        this.workers.prEvent(
          cardId,
          this.board.t.pr.comments(comments.length, comments[0]!.author),
          [
            `New review comments on your pull request${which}. Address them the way the repository does it (its own skill for review comments, if it has one; otherwise fix each, or leave it where a change is not right, and push). Each comment on the code gets a reply in its own thread, not one comment for all: what you changed, or why not. Then resolve each thread, unless you still want the reviewer’s answer. A summary or verdict that asks for nothing (a review without findings, an approval) needs no reply. Once you pushed, ask the reviewers for a new review the way the repository does it: Obeya merges only on a review of the latest commit. A comment of yours that mentions an account counts as such a request, and Obeya waits for its answer before it merges. End your turn. Use ask if one questions a decision only the owner can make.`,
            ...comments.map((c) => `- ${c.author}${c.verdict === 'changes' ? ' (requests changes)' : ''}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}${c.url ? ` (${c.url})` : ''}:\n${c.body}`),
          ].join('\n\n'),
        );
      }
      const failed = s.checks.filter((c) => c.state === 'failure' && !pr.reported.includes(`${c.name}@${s.head}`));
      if (failed.length) {
        next.reported = [...pr.reported, ...failed.map((c) => `${c.name}@${s.head}`)];
        this.workers.prEvent(
          cardId,
          this.board.t.pr.checkFailed(failed.map((c) => c.name).join(', ')),
          [`Checks failed on your pull request${which}. Find the cause (on GitHub, gh run view --log-failed helps), fix it, push, and end your turn.`, ...failed.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`)].join('\n'),
        );
      }
      let told = !!(comments.length || failed.length);
      if (s.mergeable === 'CONFLICTING' && pr.conflictHead !== s.head) {
        next.conflictHead = s.head;
        told = true;
        this.workers.prEvent(
          cardId,
          this.board.t.pr.conflict,
          `Your pull request${which} conflicts with its base branch. Bring it up to date with the latest base the way the repository does it (merge or rebase; push a rebase with --force-with-lease), resolve the conflicts, run the checks, push, and end your turn. Use ask if a conflict needs a product decision.`,
        );
      } else if (s.mergeable === 'MERGEABLE') delete next.conflictHead;
      // a branch protection that wants the branch up to date with its base before a merge
      if (s.mergeState === 'BEHIND' && s.mergeable !== 'CONFLICTING' && pr.behindHead !== s.head) {
        next.behindHead = s.head;
        told = true;
        this.workers.prEvent(
          cardId,
          this.board.t.pr.behind,
          `Your pull request${which} is behind its base branch, and the repository merges only a branch that is up to date with it. Bring it up to date the way the repository does it (merge or rebase; push a rebase with --force-with-lease), run the checks, push, and end your turn.`,
        );
      }
      // ready only while the worker has nothing in hand: what it was told may still change the PR
      const idle = !told && !this.workers.busyCards().includes(cardId);
      // a push the reviewer has not seen, and nobody asked for another look: the worker asks, once per commit
      if (idle && reviewStale(s, noise) && lastAsked(s, noise) < s.changedAt! && pr.staleHead !== s.head) {
        next.staleHead = s.head;
        told = true;
        this.workers.prEvent(
          cardId,
          this.board.t.pr.stale,
          `Your pull request${which} has commits its reviewers have not seen: their last word is older than the head commit, and nobody asked for another look since. Their verdict is about an older state, so Obeya does not merge on it. Ask them for a new review the way the repository does it (its own skill or script for this, if it has one; otherwise a comment mentioning the review bot), and end your turn.`,
        );
      }
      const waits: PrWait[] = [...waitsOf(s, noise), ...(idle && !told ? [] : (['agent'] as const))];
      const low = confidence(s, noise);
      const ready = !waits.length;
      if (ready) delete next.waits;
      else next.waits = waits;
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
          // the worker took up something meanwhile (on another of the card's PRs, say): not ready while it is at it
          if (this.workers.busyCards().includes(cardId)) {
            delete next.readyHead;
            next.waits = ['agent'];
            return this.save(cardId, next);
          }
          const reason = (messageOf(e)).replace(/^gh pr merge \S+: /, '');
          if (pr.mergeError !== reason || pr.readyHead !== s.head) this.board.log(cardId, 'state', 'obeya', this.board.t.pr.mergeFailed(reason));
          next.mergeError = reason;
          return this.save(cardId, next);
        }
        // merged on the forge: a card that moved on meanwhile, or one on a canvas closed since, sees it at its next round
        if (!this.current(cardId, pr.url!)) return;
        delete next.mergeError;
        this.save(cardId, next);
        return this.mergedPr(cardId, next, commit || undefined);
      } else {
        delete next.readyHead;
        delete next.mergeError;
        delete next.held;
        delete next.manual;
      }
    } else {
      const waits = waitsOf(s, noise);
      if (waits.length) next.waits = waits;
      else delete next.waits;
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

  /** Stores `pr` in its place among the card's pull requests, leaving the others as they are now. */
  private save(cardId: string, pr: PrState) {
    const row = this.board.row(cardId);
    const root = this.stored(cardId);
    if (!root) return;
    const { more: _, ...own } = pr;
    const next: PrState =
      root.url === pr.url ? { ...own, ...(root.more ? { more: root.more } : {}) } : { ...root, more: (root.more ?? []).map((m) => (m.url === pr.url ? own : m)) };
    if (row.pr !== JSON.stringify(next)) this.board.work(cardId, { pr: JSON.stringify(next) });
  }
}

/** A pull request as the card's log names it: its number, after its repository where that is another than the card's. */
export const prLabel = (pr: Pick<PrState, 'number' | 'repo'>) => `${pr.repo ? `${pr.repo.split('/').pop()} ` : ''}#${pr.number}`;
