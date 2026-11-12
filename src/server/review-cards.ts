// Review cards: a contributor's pull request reviewed by a worker, and what Obeya does with it on
// the owner's word: the findings the owner decides on, the worker's own commits pushed onto the PR
// with their text, the merge on the forge, and the local main pulled after it (design: Review cards).

import { isAbsolute } from 'node:path';
import { answering, askable, finished, handedOver, type Item, type Question, type ApproveResult, type ChangeRoute, type Clash, type Finding, type FindingStatus, type HeldChanges, PUSH_HOLD_MS } from '../core/types';
import { BadRequest } from './board';
import { fromJson, type HeldComment, type Json, type LandedState, type Resolving, type StoredContribution, type Unheard, toJson } from './row';
import { hostName } from './hosts';
import type { PullStopped } from './workspaces';
import { defaultBranchCommit, isFolder } from './branches';
import { gitAsync, gitTry, hasCommit, isAncestor } from './git';
import { headSeal, refsSeal } from './read-tree';
import { parsePrUrl, sameRepo } from './forge';
import { clip, messageOf } from '../core/text';
import type { WorkerOptions } from './worker-options';
import { IN_WORKTREE } from './worker-texts';
import type { Comments } from './workers';

/** A review card's branch against its pull request: its `head`, the PR's head on the forge (`base`), and the worker's own commits between them. */
export interface OwnCommits {
  head: string;
  base: string;
  commits: number;
}

/** How the worker hears that the owner rewrote the text that goes onto the PR with its own changes. */
const HELD_EDITED = 'While your handover waits, the owner edited the text that goes onto the pull request with the approval.';

const heldEdited = (body: string) =>
  body
    ? `${HELD_EDITED} It reads now:\n\n${body}\n\nThat is the text that goes out with your commits. Should you hand over again with pr_draft, start from it and keep the owner's wording where nothing calls for a change.`
    : `${HELD_EDITED} They removed it: your commits go onto the pull request without a comment. Should you hand over again, leave pr_draft out, unless the owner asks for a text.`;

/** How the worker hears that the owner ignored findings of its review, and nothing else; until it has, its list keeps them dropped. */
const FINDINGS_IGNORED = 'The owner ignored findings of your review, on the card:';

/** How gh words a merge GitHub refused for a conflict with the base branch. */
const CONFLICT = /cannot be cleanly created|merge conflict/i;

/** What review cards need of the workers. */
export interface ReviewHost {
  /** Whether what began now is still under way when asked later (`Workers.sameRun`). */
  sameRun(cardId: string): () => boolean;
  /** Cards approved while git or the forge tells what the approval does (`Workers.approving`): a restart waits for them. */
  approving: Set<string>;
  card(id: string): Item;
  deliver(cardId: string, text: string, images?: string[], owner?: boolean): void;
  unheard(cardId: string): Unheard[];
  unheardBut(cardId: string, prefix: string): Unheard[];
  unheardWith(cardId: string, text: string, o?: { replaces?: string }): Json<Unheard[]>;
  untell(cardId: string, prefix: string): void;
  /** The comments on places in the demo video held back for the worker. */
  held(cardId: string): HeldComment[];
  /** Those comments wait for no timer any more: what follows takes them, or gives them back (`releaseSoon`). */
  holdOff(cardId: string): void;
  /** Those comments go to the worker after a moment, unless an approval takes them. */
  releaseSoon(cardId: string): void;
  approvalComments(cardId: string): Comments | undefined;
  merged(cardId: string, commit?: string, note?: string, comments?: Comments): void;
  resumeFinished(card: Item, extra: LandedState, message: (path: string, worktree: boolean) => string, images?: string[], before?: () => void, failed?: () => void): void;
  toOwner(cardId: string, q: Question): void;
  refuseAsked(cardId: string, why: string): void;
}

export class ReviewCards {
  /** Review cards whose "Push main" waits out its undo window (`pushMainFor`), or runs. */
  private pushingMain = new Map<string, ReturnType<typeof setTimeout> | true>();
  /** What `mainNotes` read last (or is reading), under the seal the refs had before. */
  private notesRead: { seal: string; notes: string | Promise<string> } | null = null;

  constructor(
    private o: WorkerOptions,
    private w: ReviewHost,
  ) {}

  /**
   * Puts the review card's workspace on the head of its pull request (`refs/pull/<n>/head`, which
   * GitHub and Forgejo both have), fetched from the repository's `origin` where that is the PR's
   * repository, else from the PR's repository on its forge; then `then` runs, with what went wrong
   * where git could not, unless the card was stopped or started anew meanwhile.
   */
  onPrHead(cardId: string, branch: string, c: StoredContribution, then: (problem: string | null) => void) {
    const same = this.w.sameRun(cardId);
    const ws = this.o.board.row(cardId).workspace;
    const source = this.prSource(c);
    // stopped while git fetched, the workspace may be another card's by now: it is left as it is
    const still = () => same() && this.o.board.row(cardId).workspace === ws;
    const fetched = ws
      ? gitAsync(ws, 'fetch', '--quiet', source, `refs/pull/${c.number}/head`).then(() => (still() ? gitAsync(ws, 'checkout', '--quiet', '-B', branch, 'FETCH_HEAD') : ''))
      : Promise.reject(new Error('the card has no workspace'));
    void fetched.then(
      () => null,
      (e: unknown) => messageOf(e),
    ).then((problem) => {
      if (!same()) return;
      if (problem) this.o.board.log(cardId, 'error', 'obeya', problem);
      then(problem);
    });
  }

  /** Where a review card's PR head is fetched from: `origin` where it is the PR's repository, else that repository on its forge; without `origin`, the checkout. */
  prSource(c: StoredContribution): string {
    const ref = parsePrUrl(c.url);
    if (!ref) return c.url;
    const remote = this.o.remote?.trim();
    if (remote && sameRepo(remote, ref.owner, ref.repo)) return remote;
    // a repository without a remote has its pull requests' heads in itself, where any (a scratch Obeya's played forge)
    if (!remote && this.o.repoPath) return this.o.repoPath;
    return `${ref.base}/${ref.owner}/${ref.repo}.git`;
  }

  /**
   * The CLAUDE.md of the repository's default branch, as the checkout has it; empty where it has
   * none. Git reads it without the server waiting; what was read stands while the refs and HEAD do
   * (`refsSeal`, `headSeal`).
   */
  mainNotes(): string | Promise<string> {
    const path = this.o.repoPath;
    // a folder without git has no default branch
    if (!path || isFolder(path)) return '';
    // where no branch is found, HEAD is read, which the refs' seal leaves out
    const refs = refsSeal(path);
    const head = headSeal(path);
    const seal = refs && head ? `${refs}\n${head}` : null;
    const known = this.notesRead;
    if (seal && known?.seal === seal) return known.notes;
    const read = readNotes(path).catch(() => '');
    if (seal) {
      const entry: { seal: string; notes: string | Promise<string> } = { seal, notes: read };
      this.notesRead = entry;
      void read.then((notes) => this.notesRead === entry && (this.notesRead = { seal, notes }));
    }
    return read;
  }

  /** The head of the review card's pull request as the forge tells it now; empty where it does not. */
  private prHead(cardId: string, c: StoredContribution): Promise<string> {
    return this.o.forge!.status(this.forgeCwd(cardId), c.url).then(
      (s) => s.head,
      () => '',
    );
  }

  /** Where a review card's forge calls run: its workspace on this machine, else the repository's checkout. */
  private forgeCwd(cardId: string): string {
    const ws = this.o.board.row(cardId).workspace;
    return ws && !hostName(ws) ? ws : (this.o.repoPath ?? process.cwd());
  }

  /**
   * What the owner decided for findings of a review card (by number: to the contributor, the
   * worker's own change, a follow-up task, or ignored), as the worker reads it above their words.
   * Each is marked as decided until the worker records what came of it; a follow-up task the worker
   * makes itself (`followUpTask`), bundling the findings as the owner's words say, else as it bundled
   * them. One the owner ignores is not pursued from now on, which asks nothing of the worker (`quiet`
   * where that is all). Refuses a finding that is not open, and the worker's own change where the
   * contributor allows no maintainers' edits.
   */
  decide(cardId: string, decisions: Record<number, ChangeRoute>): { note: string; log: string; quiet: boolean } {
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!c) throw new BadRequest('notReview', 'only a review card has findings to decide on');
    const t = this.o.board.t.worker;
    const picked = Object.entries(decisions).map(([id, route]) => {
      const f = c.findings?.find((x) => x.id === Number(id) && x.status === 'open' && !x.decided);
      if (!f) throw new BadRequest('noFinding', `finding ${id} is not open`);
      if (route === 'self' && !c.canModify) throw new BadRequest('noEdits', 'the contributor does not allow maintainers to push to the pull request');
      return { f, route };
    });
    const of = (route: ChangeRoute) => picked.filter((p) => p.route === route);
    // a request to the contributor while the worker's own changes are under way or held goes with them, as one message
    const changing = of('self').length > 0;
    const withChanges = changing || !!c.changing || !!c.held;
    const findings = c.findings!.map((f): Finding => {
      const p = picked.find((x) => x.f.id === f.id);
      if (!p) return f;
      if (p.route === 'drop') return { ...f, status: 'dropped' };
      return { ...f, decided: p.route, ...(p.route === 'contributor' && withChanges ? { withChanges: true as const } : {}) };
    });
    this.o.board.work(cardId, { contribution: toJson({ ...c, findings, ...(changing ? { changing: true as const } : {}) }) });
    const name = (f: Finding) => `#${f.id} “${f.title}”`;
    const what = (p: (typeof picked)[number]) => (p.route === 'self' ? t.findingSelf : p.route === 'later' ? t.findingLater : p.route === 'drop' ? t.findingDrop : t.findingTo(c.author));
    const later = of('later');
    const ids = new Set(later.map((p) => p.f.id));
    // the worker's own bundles, as far as they hold among the findings the owner chose for later
    const bundles = [
      ...new Set(
        later
          .map((p) => [p.f.id, ...(p.f.with ?? []).filter((x) => ids.has(x))].sort((a, b) => a - b))
          .filter((b) => b.length > 1)
          .map((b) => b.join(' + ')),
      ),
    ];
    return {
      note: [
        picked.every((p) => p.route === 'drop') ? FINDINGS_IGNORED : 'The owner decided on findings of your review, on the card; do it now:',
        of('contributor').length
          ? withChanges
            ? `- To ${c.author}: ${of('contributor').map((p) => name(p.f)).join(', ')}. ${changing ? 'They go with your own changes below' : 'Your own changes wait for the owner’s approval, and these go with them'}, as one message: write the request into the same pr_draft as what you changed, and do not send it now. Obeya posts it as one review asking for changes once the owner approves.${changing ? '' : ' Hand over again with that pr_draft; the demo on the card stands.'}`
            : `- To ${c.author}: ${of('contributor').map((p) => name(p.f)).join(', ')}. Write them as one review asking for changes (request_changes, with their numbers).`
          : '',
        changing
          ? `- Yourself: ${of('self').map((p) => name(p.f)).join(', ')}. Make the change and commit it on your branch, mark them fixed (findings), and hand over again with a new demo and pr_draft. Obeya pushes your commits onto the PR's branch and posts pr_draft once the owner approves.`
          : '',
        later.length
          ? `- As follow-up tasks: ${later.map((p) => name(p.f)).join(', ')}. Make them tasks of their own with follow_up_task, outside this PR, before anything else ends your turn. Findings that belong together become one task: as the owner's words below say first (“2 and 3 together”, “combine them as you see fit”, “all separate”); without a word on it, ${bundles.length ? `as you bundled them (${bundles.map((b) => `findings ${b}`).join('; ')}), the others one each` : 'one task each'}. Write each task from what your review knows (the files concerned, the cause, the PR's link). They go neither to ${c.author} nor into your changes.`
          : '',
        of('drop').length
          ? `- Ignored: ${of('drop').map((p) => name(p.f)).join(', ')}. The owner does not pursue ${of('drop').length === 1 ? 'it' : 'them'}, and Obeya marked ${of('drop').length === 1 ? 'it' : 'them'} dropped: nothing to do for ${of('drop').length === 1 ? 'it' : 'them'}, neither for ${c.author} nor in your changes.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      log: picked.map((p) => t.findingDecided(p.f.id, p.f.title, what(p))).join('\n'),
      quiet: picked.every((p) => p.route === 'drop'),
    };
  }

  /**
   * A follow-up task the worker of a review card makes of findings, on the owner's word: beside the
   * card, following up on it, with the worker's text and the PR's link, and started at once, waiting
   * in the queue for the PR's merge. The findings are settled for the PR and link it; several may
   * link one task.
   */
  followUpTask(cardId: string, title: string, task: string, ids: number[]): string {
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!c) return 'Not made: this card reviews no pull request.';
    if (!title) return 'Not made: the title is missing.';
    if (!task) return 'Not made: the task is missing.';
    const named = [...new Set(ids)];
    if (!named.length) return 'Not made: name the findings it is made of (findings, their numbers).';
    const missing = named.filter((id) => !c.findings?.some((f) => f.id === id));
    if (missing.length) return `Not made: there is no finding ${missing.join(', ')}.`;
    const settled = named.map((id) => c.findings!.find((f) => f.id === id)!).filter((f) => f.status !== 'open');
    if (settled.length) return `Not made: ${settled.map((f) => `finding ${f.id} is ${f.status}${f.card ? ' (a follow-up task already)' : ''}`).join('; ')}.`;
    const t = this.o.board.t.worker;
    const body = clip(task, 19000);
    const card = this.o.board.create({ title: clip(title, 200), body: body.includes(c.url) ? body : `${body}\n\n${t.findingTask(c.number, c.url)}`, from: cardId });
    this.o.board.log(card.id, 'state', 'obeya', t.findingTaskMade(c.number));
    const findings = c.findings!.map((f): Finding => {
      if (!named.includes(f.id)) return f;
      const { decided: _, ...rest } = f;
      return { ...rest, status: 'later', card: card.id };
    });
    this.o.board.work(cardId, { contribution: toJson({ ...c, findings }) });
    this.o.onFollowUpTask?.(card.id, cardId);
    const owed = this.owedTasks(cardId);
    return `Made: “${card.title}”, beside your card and queued behind it until the PR is merged, linked from ${named.length === 1 ? `finding ${named[0]}` : `findings ${named.join(', ')}`}.${owed ? ` Still to make: ${owed}.` : ''}`;
  }

  /** The findings of a review card the owner chose as follow-up tasks that have none yet, as the worker reads them; none: undefined. */
  owedTasks(cardId: string): string | undefined {
    const owed = fromJson(this.o.board.row(cardId).contribution)?.findings?.filter((f) => f.status === 'open' && f.decided === 'later') ?? [];
    return owed.length ? `${owed.length === 1 ? 'finding' : 'findings'} ${owed.map((f) => `#${f.id} “${f.title}”`).join(', ')} (follow_up_task)` : undefined;
  }

  /**
   * A review card's findings as its worker writes them: the whole list as it stands, each kept by its
   * number (a new one gets the next), with what the owner decided while it stays open. `with` names
   * the findings it would make one follow-up task with, kept in both directions and across a chain.
   */
  setFindings(cardId: string, given: { id?: number; title: string; text: string; security?: boolean; status?: FindingStatus; url?: string; with?: number[] }[]): string {
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!c) return 'Not recorded: this card reviews no pull request.';
    const had = c.findings ?? [];
    // a list written before the worker heard the owner ignore findings keeps them ignored
    const ignoring = this.w.unheard(cardId).some((u) => u.text.startsWith(FINDINGS_IGNORED));
    let next = Math.max(0, ...had.map((f) => f.id)) + 1;
    const seen = new Set<number>();
    const findings: Finding[] = [];
    const named: [number, number[]][] = [];
    for (const g of given.slice(0, 30)) {
      const id = g.id !== undefined && !seen.has(g.id) ? g.id : next++;
      if (id >= next) next = id + 1;
      seen.add(id);
      const before = had.find((f) => f.id === id);
      // one the owner made a follow-up task stays one, and only a task made with follow_up_task makes one
      const status =
        before?.status === 'later' || (ignoring && before?.status === 'dropped') ? before.status : g.status === 'later' ? (before?.status ?? 'open') : (g.status ?? before?.status ?? 'open');
      const url = g.url ?? (status === before?.status ? before?.url : undefined);
      if (g.with?.length) named.push([id, g.with]);
      findings.push({
        id,
        title: clip(String(g.title).trim(), 120),
        text: clip(String(g.text).trim(), 2000),
        ...(g.security ? { security: true } : {}),
        status,
        ...(url ? { url } : {}),
        ...(status === 'later' && before?.card ? { card: before.card } : {}),
        ...(status === 'open' && before?.decided ? { decided: before.decided, ...(before.withChanges ? { withChanges: true as const } : {}) } : {}),
      });
    }
    // bundles: each finding's group of the findings named together with it, in both directions
    const root = new Map(findings.map((f) => [f.id, f.id]));
    const find = (id: number): number => (root.get(id) === id ? id : find(root.get(id)!));
    for (const [id, others] of named) for (const o of others) if (root.has(o)) root.set(find(o), find(id));
    for (const f of findings) {
      const w = findings.filter((o) => o.id !== f.id && find(o.id) === find(f.id)).map((o) => o.id);
      if (w.length) f.with = w;
    }
    this.o.board.work(cardId, { contribution: toJson({ ...c, findings }) });
    return `Recorded: ${findings.length === 1 ? '1 finding' : `${findings.length} findings`}.`;
  }

  /**
   * "Merge (PR #5)": the owner approved a review card's demo. Obeya merges the pull request on the
   * forge (the repository's allowed method, squash first), pinned to the head the worker reviewed:
   * a PR that moved since the handover is not merged, and its worker reviews it anew. Where the
   * worker's own commits are held (`HeldChanges`), Obeya first pushes them onto the PR's branch,
   * fast-forward only, and posts their text: as a comment, or with requests to the contributor as
   * one review asking for changes, after which the card waits for them and nothing is merged;
   * `merge: false` ("Push only") stops after the post too. Before the merge the demo goes on its
   * page where the site publishes on approval, and the page's link goes into a comment on the PR
   * once it is online (`onApproval`; the description stays the contributor's). A refused merge
   * leaves the card waiting for the owner, with the reason, but a conflict with main, which goes to
   * the worker with the approval kept (`conflicted`): its next handover is merged without the owner
   * (`kept`). Merged, the card is live and, where work lands on the local main, the checkout pulls the
   * merge.
   *
   * `findings`: decisions on findings the owner made and did not send before approving. Those that
   * fit a merge (a follow-up task, ignored) go with it: decided where the approval goes through
   * (after a push and its post), and the worker hears them with the merge, or on their own where
   * nothing is merged; the others (to the contributor, the worker's own change) hold the merge up
   * and are refused.
   */
  async mergeContribution(cardId: string, { merge = true, findings, kept = false }: { merge?: boolean; findings?: Record<number, ChangeRoute>; kept?: boolean } = {}): Promise<ApproveResult | void> {
    const forge = this.o.forge;
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!forge || !c) throw new BadRequest('notReview', 'the card reviews no pull request');
    if (!merge && !c.held) throw new BadRequest('notReady', 'nothing of the agent’s waits to be pushed');
    if (findings) {
      if (Object.values(findings).some((route) => route !== 'later' && route !== 'drop')) throw new BadRequest('decideFirst', 'a finding for the contributor or the agent’s own change holds the merge up: send that decision first');
      const shut = Object.keys(findings).filter((id) => !c.findings?.some((f) => f.id === Number(id) && f.status === 'open' && !f.decided));
      if (shut.length) throw new BadRequest('noFinding', `finding ${shut.join(', ')} is not open`);
    }
    // the decisions as the owner reads them in the card's log, and the worker with the approval
    const decide = (): Comments | undefined => {
      if (!findings) return undefined;
      const decided = this.decide(cardId, findings);
      this.o.board.log(cardId, 'hint', 'owner', decided.log);
      return { text: decided.note, images: [] };
    };
    const along = (a: Comments | undefined, b: Comments | undefined): Comments | undefined => (a && b ? { text: `${a.text}\n\n${b.text}`, images: [...a.images, ...b.images] } : (a ?? b));
    const t = this.o.board.t.worker;
    const still = this.w.sameRun(cardId);
    const held = this.w.held(cardId).length > 0;
    this.w.holdOff(cardId);
    this.w.approving.add(cardId);
    // under way on every page, one loaded meanwhile too, as a landing is (approved before, it is the worker's)
    if (!kept) this.o.board.work(cardId, { approved_at: new Date().toISOString() });
    const cwd = this.forgeCwd(cardId);
    let merged: string | void;
    try {
      const now = await forge.status(cwd, c.url).catch((e: unknown) => {
        throw new BadRequest('mergeRefused', messageOf(e));
      });
      // approved before, the worker's handover after a conflict is merged while the card is still with Obeya
      const ready = kept ? this.w.card(cardId).state === 'working' && !!this.o.board.row(cardId).approved_at : handedOver(this.w.card(cardId));
      if (!ready || !still()) throw new BadRequest('notReady', 'the card is not ready for review');
      if (now.state === 'MERGED') return this.w.merged(cardId, now.mergeCommit, t.mergedContribution(c.number), decide());
      if (now.state === 'CLOSED') throw new BadRequest('prClosed', 'the pull request was closed');
      // the worker's own commits go on top of the head they were made on; already there, only their text is still to post
      if (!c.reviewed || (now.head !== c.reviewed && now.head !== c.held?.base)) throw this.moved(cardId, c, now.head);
      // unpushed commits on the local main the pull after the merge would stop at: the owner sees them before the merge
      const merging = merge && !c.held?.asks.length;
      if (merging) {
        const shown = c.clash;
        const clash = await this.probeClash(cardId);
        if (!still()) return;
        if (clash && !sameClash(shown, clash)) {
          this.o.board.log(cardId, 'state', 'obeya', t.clashFound(c.number, clash.subject, clash.card?.title));
          throw new BadRequest('pullClash', `the pull request collides with unpushed commits on the local main (${clash.commit.slice(0, 7)} ${clash.subject})`);
        }
        // a conflict with main the worker resolves; commits of its own not pushed yet may resolve it already
        if (now.mergeable === 'CONFLICTING' && now.head === c.reviewed) return this.conflicted(cardId, c, now.head, along(decide(), this.w.approvalComments(cardId)), kept);
      }
      if (c.held) {
        if (now.head !== c.reviewed) await this.pushHeld(cardId, c);
        if (!still()) return;
        await this.postHeld(cardId, c);
        if (c.held.asks.length || !merge) {
          const decided = decide();
          if (decided) this.w.deliver(cardId, decided.text, [], true);
          return;
        }
      }
      // the decisions the owner had not sent, and the comments held back while they watched, go with the approval
      const comments = along(decide(), this.w.approvalComments(cardId));
      this.o.board.work(cardId, { contribution: toJson({ ...(fromJson(this.o.board.row(cardId).contribution) ?? c), approved: true }) });
      if (!kept) this.o.board.log(cardId, 'state', 'owner', t.approvedMerge(c.number));
      this.o.onApproval?.(cardId);
      try {
        merged = await forge.merge(cwd, c.url, c.reviewed);
      } catch (e) {
        const reason = messageOf(e).replace(/^gh pr merge \S+: /, '');
        // the forge read the PR's mergeability before the push, or not at all yet: it says now whether main is in the way
        const after = await forge.status(cwd, c.url).catch(() => undefined);
        if (!still()) return;
        if (after?.mergeable === 'CONFLICTING' || (after?.mergeable !== 'MERGEABLE' && CONFLICT.test(reason))) return this.conflicted(cardId, c, after?.head || c.reviewed, comments, kept);
        this.o.board.log(cardId, 'error', 'obeya', t.mergeRefused(reason));
        if (comments) this.w.deliver(cardId, comments.text, comments.images, true);
        throw new BadRequest('mergeRefused', reason);
      }
      if (!still()) return;
      this.w.merged(cardId, merged || undefined, t.mergedContribution(c.number), comments);
    } catch (e) {
      if (held && this.w.held(cardId).length) this.w.releaseSoon(cardId);
      throw e;
    } finally {
      this.w.approving.delete(cardId);
      // not merged and not with the worker: the card waits for the owner (or the contributor) again
      const state = !kept && this.o.board.item(cardId) ? this.o.board.row(cardId).state : undefined;
      if (state === 'waiting' || state === 'inPr') this.o.board.work(cardId, { approved_at: null });
    }
  }

  /** "Push only": the worker's own commits held on a review card go onto the PR with their text, and the card waits for the owner's "Merge" again. */
  pushContribution(cardId: string) {
    const card = this.w.card(cardId);
    if (!card.contribution || !handedOver(card) || this.w.approving.has(cardId)) throw new BadRequest('notReady', 'the card is not ready for review');
    return this.mergeContribution(cardId, { merge: false });
  }

  /**
   * The owner's own wording of the text that goes onto the PR with the worker's held changes: it is
   * the held text from now on, posted with the approval and kept by a handover without pr_draft. The
   * worker hears it with its next message or step, an earlier edit's news replaced, so that a
   * pr_draft it gives later starts from the owner's words. An empty text sends the commits without a
   * comment, but not with requests to the contributor, which are that text.
   */
  editHeld(cardId: string, body: unknown) {
    const card = this.w.card(cardId);
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!c?.held || !handedOver(card) || this.w.approving.has(cardId)) throw new BadRequest('notReady', 'no text waits for the approval on this card');
    const text = typeof body === 'string' ? clip(body.trim(), 20000) : '';
    if (!text && c.held.asks.length) throw new BadRequest('emptyText', 'the text for the pull request asks the contributor for changes and cannot be empty');
    if (text === c.held.body) return;
    this.o.board.work(cardId, {
      contribution: toJson({ ...c, held: { ...c.held, body: text } }),
      unheard: this.w.unheardWith(cardId, heldEdited(text), { replaces: HELD_EDITED }),
    });
    this.o.board.log(cardId, 'state', 'owner', (text ? this.o.board.t.worker.heldEdited : this.o.board.t.worker.heldRemoved)(c.number));
  }

  /**
   * The approval of a review card met a conflict of its pull request with main, at `head`. Where the
   * contributor allows maintainers' edits, the worker resolves it on its branch with the approval
   * kept: its next handover is pushed and merged without the owner (`landApproved`), unless it brings
   * nothing new, which leaves the merge to the owner. Otherwise only the contributor can resolve it:
   * the worker writes it up as a finding, and the owner decides whether it goes to them.
   */
  private conflicted(cardId: string, c: StoredContribution, head: string, comments: Comments | undefined, kept: boolean): ApproveResult {
    const t = this.o.board.t.worker;
    const row = this.o.board.row(cardId);
    const now = fromJson(row.contribution) ?? c;
    const also = comments?.text ?? '';
    if (!c.canModify) {
      this.o.board.log(cardId, 'error', 'obeya', t.mergeConflictNoEdits(c.number, c.author));
      this.o.board.work(cardId, { state: 'working', need: null, detail: null, status_line: null, approved_at: null });
      this.w.deliver(
        cardId,
        [
          `The owner approved your handover, but the pull request cannot be merged: it conflicts with main. ${c.author} does not allow maintainers' edits, so nothing of yours can go onto its branch, and only ${c.author} can resolve the conflict. Find out what conflicts (merge main into the PR's head in your workspace, then abort that merge), record it as a finding (findings) that names the files and the change on main they conflict with, and hand over again: the owner decides whether it goes to ${c.author}.`,
          also,
        ]
          .filter(Boolean)
          .join('\n\n'),
        comments?.images,
        !kept,
      );
      return { conflict: 'contributor' };
    }
    if (kept && now.conflict === head) {
      // handed over without a resolution: the merge is the owner's again
      this.o.board.log(cardId, 'error', 'obeya', t.conflictUnresolved(c.number));
      this.o.board.work(cardId, { state: 'waiting', need: row.demo ? 'demo' : 'review', status_line: null, approved_at: null });
      return undefined;
    }
    this.o.board.log(cardId, 'error', 'obeya', t.mergeConflict(c.number));
    this.o.board.work(cardId, {
      contribution: toJson({ ...now, conflict: head }),
      state: 'working',
      need: null,
      detail: null,
      status_line: null,
      approved_at: row.approved_at ?? new Date().toISOString(),
    });
    this.w.deliver(
      cardId,
      [
        `The owner approved your handover, but the pull request cannot be merged: it conflicts with main, which moved since the PR branched off. Resolve the conflict on your branch, which stands on the PR's head ${head.slice(0, 7)}: fetch main from origin and merge it in (do not rebase or rewrite the PR's commits), resolve the conflicts so that both the PR's change and what main brought keep working, run the checks and commit the merge.`,
        `The approval holds for that resolution: once you hand over again (ready_for_review with the checks and the merge probe in review, and in pr_draft a short note for ${c.author}, in the PR's language, on what conflicted and how you resolved it), Obeya pushes your commits onto the PR's branch, posts the note and merges, without asking the owner again and with the demo already on the card. A resolution that changes what the owner approved, or needs a product call, is theirs: ask.`,
        also,
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      !kept,
    );
    return { conflict: 'agent' };
  }

  /**
   * The approval of a review card met a pull request at another head than the one handed over (the
   * contributor pushed since): Obeya pushes, posts and merges nothing, and the worker reviews the PR
   * as it is now, its own commits not pushed yet put on top. Returns the refusal to throw.
   */
  private moved(cardId: string, c: StoredContribution, head: string): BadRequest {
    const t = this.o.board.t.worker;
    const comments = this.w.approvalComments(cardId);
    this.o.board.log(cardId, 'state', 'obeya', c.held ? t.heldMoved(head.slice(0, 7)) : t.unreviewedHead(head.slice(0, 7)));
    // the approval was for what the worker reviewed, not for the contributor's push
    this.o.board.work(cardId, { state: 'working', need: null, detail: null, status_line: null, approved_at: null });
    this.w.deliver(
      cardId,
      [
        c.held
          ? `The owner approved your handover, but the pull request's head is ${head.slice(0, 7)} now, not the ${c.held.base.slice(0, 7)} your commits build on: ${c.author} pushed meanwhile. So Obeya pushed, posted and merged nothing.`
          : `The owner approved your handover, but the pull request's head is ${head.slice(0, 7)} now, not the ${c.reviewed?.slice(0, 7) ?? 'commit'} you handed over, so Obeya did not merge it.`,
        `Review it as it is now: fetch its head, look at what changed before you run any of it, then the code review, a new demo where the change shows, the checks and the merge probe.${c.held ? ' Put your own commits on top of the new head first (rebase; the PR\'s commits stay as they are), and check that pr_draft still says what goes with them.' : ''} Hand over again.`,
        comments?.text ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      true,
    );
    return new BadRequest('prMoved', `the pull request is at ${head.slice(0, 7)} now, not at the commit handed over`);
  }

  /**
   * The worker's own commits held on a review card go onto the PR's branch in the contributor's
   * repository, fast-forward only, from its workspace and without its hooks (the PR's code ran there).
   * A push the forge rejects as not a fast-forward is a push of the contributor's meanwhile, which
   * goes back to the worker as a moved head would; any other refusal stays with the owner.
   */
  private async pushHeld(cardId: string, c: StoredContribution & { held?: object }): Promise<void> {
    const t = this.o.board.t.worker;
    const ws = this.o.board.row(cardId).workspace;
    const to = pushTarget(c);
    const refuse = (reason: string) => {
      this.o.board.log(cardId, 'error', 'obeya', t.pushRefused(reason));
      return new BadRequest('pushRefused', reason);
    };
    if (!ws) throw refuse('the card has no workspace');
    if (!to) throw refuse('the forge names no branch of the pull request to push to');
    try {
      await gitAsync(ws, '-c', 'core.hooksPath=/dev/null', 'push', '--quiet', to.repo, `${c.reviewed}:refs/heads/${to.branch}`);
    } catch (e) {
      const why = messageOf(e);
      if (/non-fast-forward|fetch first|\[rejected\]|stale info/.test(why)) {
        const head = await this.prHead(cardId, c);
        throw this.moved(cardId, c, head || 'another commit');
      }
      throw refuse(why);
    }
    // the forge shows the new head a moment after the push; the merge is pinned to it
    for (let i = 0; i < 10; i++) {
      const head = await this.prHead(cardId, c);
      if (head === c.reviewed) break;
      await new Promise((r) => setTimeout(r, this.o.pushSettle ?? 1000));
    }
  }

  /**
   * Once the worker's own commits are on the PR's branch, their text goes onto the PR in the owner's
   * name: a comment (none where the owner emptied it), or with requests to the contributor one review
   * asking for changes, after which the card waits for them. The findings it fixed and those it asks for link it. A text the forge
   * refuses leaves the card with the owner, its commits pushed and nothing merged, and the findings
   * it asked for open, to be decided anew.
   */
  private async postHeld(cardId: string, c: StoredContribution): Promise<void> {
    const t = this.o.board.t.worker;
    const held = c.held!;
    const asks = held.asks.length > 0;
    let url: string | undefined;
    let failed: string | undefined;
    try {
      if (asks || held.body) url = (await (asks ? this.o.forge!.requestChanges(this.forgeCwd(cardId), c.url, held.body) : this.o.forge!.comment(this.forgeCwd(cardId), c.url, held.body))) || undefined;
    } catch (e) {
      failed = messageOf(e);
    }
    const now = fromJson(this.o.board.row(cardId).contribution) ?? c;
    const { held: _, changing: __, ...rest } = now;
    const findings = now.findings?.map((f): Finding => {
      const { decided: ___, withChanges: ____, ...plain } = f;
      if (held.asks.includes(f.id) && f.status === 'open') return failed ? plain : { ...plain, status: 'sent', ...(url ? { url } : {}) };
      if (f.status === 'fixed' && !f.url && url) return { ...f, url };
      return f;
    });
    const sent = asks && !failed;
    this.o.board.work(cardId, {
      // the owner's edit went out as they wrote it: nothing of it is news to the worker any more
      ...(failed ? {} : { unheard: toJson(this.w.unheardBut(cardId, HELD_EDITED)) }),
      contribution: toJson({
        ...rest,
        ...(findings ? { findings } : {}),
        ...(sent ? { requested: { ...(url ? { url } : {}), at: new Date().toISOString() } } : {}),
      }),
      // the state says it: "Waiting for the contributor"
      ...(sent ? { state: 'inPr', need: null, detail: null, status_line: null } : {}),
    });
    if (failed) {
      this.o.board.log(cardId, 'error', 'obeya', t.postFailed(failed));
      throw new BadRequest('mergeRefused', `pushed, but the forge refused the text that goes with it (${failed})`);
    }
    this.o.board.log(cardId, 'state', 'owner', `${t.pushedHeld(c.number, held.commits, asks ? c.author : undefined, !held.body)}${url ? ` ${url}` : ''}`);
  }

  /**
   * A review card's pull request was closed without a merge: the owner says whether the card can go
   * (its worker closes it then) or stays. Asked once; `comments` are what the contributor wrote on it
   * since the card came to wait for them. A card the owner set aside until the contributor responds
   * wakes with it, also one closed before that wake existed.
   */
  contributionClosed(cardId: string, comments: string[] = []) {
    const row = this.o.board.row(cardId);
    const c = fromJson(row.contribution);
    if (!c) return;
    const t = this.o.board.t.worker;
    const awaited = this.o.board.snoozedOf(cardId)?.contributor;
    if (awaited) this.o.board.unsnooze(cardId, { said: t.prClosed });
    if (c.closed) return;
    this.w.refuseAsked(cardId, 'meanwhile the pull request was closed without a merge.');
    this.o.board.work(cardId, { contribution: toJson({ ...c, closed: true }) });
    if (!awaited) this.o.board.log(cardId, 'state', 'obeya', t.prClosed);
    this.w.toOwner(cardId, { text: t.contributionClosedQuestion, options: [t.closeCard, t.keepCard] });
    this.w.deliver(
      cardId,
      [
        `The pull request was closed without a merge. Obeya asked the owner whether the card can go. If they say so, close it with close_unchanged; nothing of it lands.`,
        ...(comments.length ? [`What ${c.author} wrote on it before:`, ...comments] : []),
      ].join('\n\n'),
    );
  }

  /**
   * The contributor answered while the review card waited for them, or pushed: the worker hears
   * what came and reviews again; the owner's log gets `note`. A card the owner set aside on its
   * handover until then wakes with it, and its handover gives way to the new review.
   */
  contributorAnswered(cardId: string, note: string, message: string) {
    const awaited = this.o.board.snoozedOf(cardId)?.contributor;
    if (awaited) this.o.board.unsnooze(cardId, { said: note });
    else this.o.board.log(cardId, 'state', 'obeya', note);
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (c?.requested) this.o.board.work(cardId, { contribution: toJson({ ...c, requested: undefined }) });
    const state = this.o.board.row(cardId).state;
    if (state === 'inPr' || (awaited && state === 'waiting')) this.o.board.work(cardId, { state: 'working', need: null, detail: null, status_line: null });
    this.w.deliver(cardId, awaited ? `The owner had set your handover aside until ${awaited.author} responded.\n\n${message}` : message);
  }

  /**
   * The owner's change request, as the worker wrote it, goes to the contributor as a review asking
   * for changes; the card waits for them (`inPr`, "Waiting for the contributor") with the review linked
   * in its log. Returns why it was not sent, or nothing.
   */
  async requestChanges(cardId: string, body: string, ids: number[] = []): Promise<string | undefined> {
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!this.o.forge || !c) return 'Not sent: this card reviews no pull request.';
    if (!body.trim()) return 'Not sent: the review has no text.';
    const still = this.w.sameRun(cardId);
    // the head the request is about, where no handover named one yet: a push after it is news for the worker
    const ws = this.o.board.row(cardId).workspace;
    const head = c.reviewed ?? (ws ? await gitAsync(ws, 'rev-parse', 'HEAD').catch(() => undefined) : undefined);
    let url: string | void;
    try {
      url = await this.o.forge.requestChanges(this.forgeCwd(cardId), c.url, body.trim());
    } catch (e) {
      return `Not sent: the forge refused it (${messageOf(e)}). Tell the owner with reply if it keeps failing.`;
    }
    const t = this.o.board.t.worker;
    // the owner stopped the card meanwhile: the review is out, but the card does not wait for anyone
    const row = this.o.board.row(cardId);
    if (!still() || !(row.state === 'working' || row.state === 'waiting')) {
      this.o.board.log(cardId, 'state', 'worker', `${t.changesRequested(c.number, c.author)}${url ? ` ${url}` : ''}`);
      return 'Sent, but the card was stopped meanwhile. End your turn.';
    }
    const now = fromJson(row.contribution) ?? c;
    this.o.board.work(cardId, {
      state: 'inPr',
      need: null,
      detail: null,
      // the state says it: "Waiting for the contributor"
      status_line: null,
      contribution: toJson({
        ...now,
        ...(head && !now.reviewed ? { reviewed: head } : {}),
        // the findings it holds are sent, with the review they went in
        ...(now.findings ? { findings: now.findings.map((f) => (ids.includes(f.id) && f.status !== 'later' ? { id: f.id, title: f.title, text: f.text, ...(f.security ? { security: true } : {}), status: 'sent' as const, ...(url ? { url } : {}) } : f)) } : {}),
        requested: { ...(url ? { url } : {}), at: new Date().toISOString() },
      }),
    });
    this.o.board.log(cardId, 'state', 'worker', `${t.changesRequested(c.number, c.author)}${url ? ` ${url}` : ''}`);
    return undefined;
  }

  /**
   * Where a review card's branch stands against its pull request at a handover: its head, the PR's
   * head on the forge (`base`) and how many commits of the worker's own go on top of it. Why it
   * cannot be handed over, where the branch does not build on the PR's head: the contributor pushed
   * since the worker fetched, or the branch was rewritten.
   */
  async ownCommits(cardId: string, c: StoredContribution): Promise<OwnCommits | string> {
    const ws = this.o.board.row(cardId).workspace ?? '';
    let head: string;
    try {
      head = await gitAsync(ws, 'rev-parse', 'HEAD');
    } catch (e) {
      return `Not handed over: Obeya could not read your branch's head (${messageOf(e)}). Check the workspace, then call ready_for_review again.`;
    }
    if (!this.o.forge) return { head, base: head, commits: 0 };
    let base: string;
    try {
      base = (await this.o.forge.status(this.forgeCwd(cardId), c.url)).head;
    } catch (e) {
      return `Not handed over: Obeya could not read the pull request's head from the forge (${messageOf(e)}). Call ready_for_review again in a moment.`;
    }
    if (!base || base === head) return { head, base: head, commits: 0 };
    // a head the workspace does not have is one pushed since it fetched; any other failure tells nothing
    const on = await isAncestor(ws, base, head).catch(async (e: unknown) => ((await hasCommit(ws, base).catch(() => true)) ? messageOf(e) : false));
    if (typeof on === 'string') return `Not handed over: Obeya could not tell whether your branch builds on the pull request’s head ${base.slice(0, 7)} (${on}). Check the workspace, then call ready_for_review again.`;
    if (!on)
      return `Not handed over: the pull request's head is ${base.slice(0, 7)}, and your branch does not build on it (${c.author} pushed since you fetched it, or your branch was rewritten). Fetch refs/pull/${c.number}/head from ${this.prSource(c)} and look at what changed before you run any of it; put the commits of your own that are not on the PR yet on top of it (rebase; the PR's commits stay as they are), review what is new, then hand over again.`;
    // a merge of main into it counts once, not with each commit it brings
    const commits = Number(await gitAsync(ws, 'rev-list', '--count', '--first-parent', `${base}..${head}`).catch(() => '0')) || 0;
    return { head, base, commits };
  }

  /**
   * What a review card's handover holds back for the owner's approval: the worker's own commits on
   * top of the PR's head, the text that goes onto the PR with them (`draft`, else the one handed over
   * before) and the findings decided for the contributor meanwhile, which go in the same text. None
   * where the branch holds no commits of its own; why it cannot be handed over, as the worker reads it.
   */
  heldAt(cardId: string, mine: OwnCommits, draft: string | undefined): (HeldChanges & { base: string }) | string | undefined {
    const c = fromJson(this.o.board.row(cardId).contribution)!;
    const asks = (c.findings ?? []).filter((f) => f.status === 'open' && f.decided === 'contributor');
    if (!mine.commits) {
      const waiting = asks.filter((f) => f.withChanges);
      if (!c.changing && !c.held && !waiting.length) return undefined;
      // nothing of its own to push after all: a request that waited for it goes out now, alone
      const { changing: _, held: __, ...rest } = c;
      const findings = c.findings?.map((f) => (f.withChanges ? (({ withChanges: ___, ...x }) => x)(f) : f));
      this.o.board.work(cardId, { contribution: toJson({ ...rest, ...(findings ? { findings } : {}) }) });
      return waiting.length
        ? `Not handed over: your branch holds no commits beyond the pull request's head, so nothing of yours waits to be pushed, and ${waiting.map((f) => `#${f.id}`).join(', ')} for ${c.author} would wait for nothing. Send ${waiting.length === 1 ? 'it' : 'them'} now with request_changes.`
        : undefined;
    }
    if (!c.canModify)
      return `Not handed over: your branch holds ${mine.commits === 1 ? 'a commit' : `${mine.commits} commits`} beyond the pull request's head ${mine.base.slice(0, 7)}, and ${c.author} does not allow maintainers' edits, so nothing can go onto the PR's branch. Put your branch back on the PR's head (git reset --hard ${mine.base.slice(0, 7)}), then hand over again.`;
    // a draft written before the worker heard of the owner's edit would put back what they rewrote
    const edited = draft?.trim() && this.w.unheard(cardId).find((u) => u.text.startsWith(HELD_EDITED));
    if (edited) {
      this.w.untell(cardId, HELD_EDITED);
      return `Not handed over: ${edited.text.replace(HELD_EDITED, 'the owner edited the text that goes onto the pull request with the approval.')}\n\nThen call ready_for_review again.`;
    }
    // a text the owner emptied stays empty: the commits go without a comment
    const body = draft?.trim() ? clip(draft.trim(), 20000) : (c.held?.body ?? '');
    if (!body && (!c.held || asks.length))
      return `Not handed over: your branch holds ${mine.commits === 1 ? 'a commit' : `${mine.commits} commits`} of your own that ${mine.commits === 1 ? 'is' : 'are'} not on the pull request yet. Give pr_draft: the text Obeya posts on the PR once the owner approves, after pushing them (what you changed and why${asks.length ? `, and the request for ${asks.map((f) => `#${f.id}`).join(', ')} to ${c.author}` : ''}). Then call ready_for_review again.`;
    return { body, commits: mine.commits, asks: asks.map((f) => f.id), base: mine.base };
  }

  /**
   * The checkout's main around a review card's merge (`WorkerOptions.pulls`), where work lands on
   * the local main of a repository with a remote; none elsewhere.
   */
  pulls() {
    return this.o.adapter.land === 'main' && this.o.remote ? this.o.pulls : undefined;
  }

  /**
   * The local main gets a review card's merge from the remote; the card's log says how it went.
   * Where its unpushed commits stop the pull on a conflict, a worker resolves it (`resolvePull`).
   */
  async pullAfterMerge(cardId: string) {
    const t = this.o.board.t.worker;
    const r = await this.pulls()!.pullMain().catch((e: unknown) => ({ problem: messageOf(e) }));
    if (!this.o.board.card(cardId)) return;
    if ('stopped' in r) return this.resolvePull(cardId, r.stopped);
    if ('problem' in r) this.o.board.log(cardId, 'error', 'obeya', t.pullFailed(r.problem));
    else this.pulled(cardId, r.to);
  }

  /** The local main has a review card's merge now: its log says so, the read tree reads it, and the other review cards look again at what the move means for them. */
  private pulled(cardId: string, commit: string) {
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.pulledMain(commit.slice(0, 7)));
    this.o.onMerged?.(cardId);
    this.reprobeClashes();
  }

  /**
   * Whether pulling a review card's PR, once merged, into the local main would stop on a conflict
   * with its unpushed commits (`Workspaces.clashBeforeMerge`), named with the card that landed the
   * commit it stops at. Kept on the card for the owner to see before the merge; undefined where it
   * cannot tell (no head reviewed yet, git failed), which leaves what the card shows.
   */
  async probeClash(cardId: string): Promise<Clash | null | undefined> {
    const pulls = this.pulls();
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!pulls || !c?.reviewed) return undefined;
    let clash: Clash | null;
    try {
      const found = await pulls.clashBeforeMerge(cardId, c.reviewed);
      clash = found && { ...found, ...(await this.landedBy(found.commit)) };
    } catch (e) {
      console.error(`probing ${cardId}'s pull request against the local main:`, messageOf(e));
      return undefined;
    }
    const now = this.o.board.card(cardId) && fromJson(this.o.board.row(cardId).contribution);
    if (!now || now.reviewed !== c.reviewed) return clash;
    if (!sameClash(now.clash, clash)) {
      const { clash: _, ...rest } = now;
      this.o.board.work(cardId, { contribution: toJson({ ...rest, ...(clash ? { clash } : {}) }) });
    }
    return clash;
  }

  /**
   * "Push main, adapt the PR" on a review card whose PR collides with unpushed commits on the
   * local main: once the undo window is through (`keepMainFor` takes it back), the local main goes
   * to `origin` (`Workspaces.pushMain`), so the PR now conflicts there, and the card's worker brings
   * the PR up to date with it, itself where the contributor allows maintainers' edits, else by a
   * change request to them. A push that fails says why on the card, which stays with the owner.
   */
  pushMainFor(cardId: string) {
    const i = this.o.board.item(cardId);
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!i || !c?.clash || !handedOver(i) || !this.pulls()) throw new BadRequest('noClash', 'the card’s pull request collides with nothing unpushed on main');
    if (this.pushingMain.has(cardId) || this.w.approving.has(cardId)) throw new BadRequest('notReady', 'the card is busy with main already');
    this.pushingMain.set(
      cardId,
      setTimeout(() => {
        this.pushingMain.set(cardId, true);
        void this.pushMainNow(cardId).finally(() => this.pushingMain.delete(cardId));
      }, this.o.pushHold ?? PUSH_HOLD_MS),
    );
  }

  /** The owner takes back "Push main" within its undo window: nothing happened. */
  keepMainFor(cardId: string) {
    const held = this.pushingMain.get(cardId);
    if (!held || held === true) throw new BadRequest('noClash', 'main is not waiting to be pushed for this card');
    clearTimeout(held);
    this.pushingMain.delete(cardId);
  }

  private async pushMainNow(cardId: string) {
    const t = this.o.board.t.worker;
    const r = await this.pulls()!.pushMain().catch((e: unknown) => ({ problem: messageOf(e) }));
    if (!this.o.board.item(cardId)) return;
    if ('problem' in r) {
      this.o.board.log(cardId, 'error', 'obeya', t.pushFailed(r.problem));
      return;
    }
    this.o.onMerged?.(cardId);
    this.reprobeClashes();
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (!c) return;
    const files = c.clash?.files ?? [];
    const { clash: _, ...rest } = c;
    this.o.board.work(cardId, { contribution: toJson({ ...rest, ...(c.canModify ? { changing: true as const } : {}) }), state: 'working', need: null, detail: null, status_line: null });
    this.o.board.log(cardId, 'state', 'owner', t.pushedMain(r.to.slice(0, 7), c.number));
    this.w.deliver(
      cardId,
      [
        `The owner had Obeya push the local main to origin (${r.to.slice(0, 7)} there now): its commits nobody had pushed yet collide with this pull request${files.length ? ` in ${files.join(', ')}` : ''}, so the pull request now conflicts with origin's main. Bring it up to date with origin's main, so that both changes keep working.`,
        c.canModify
          ? `${c.author} allows maintainers' edits: merge origin's main into your branch, which is the PR's head (a merge, not a rebase: Obeya pushes onto the PR's branch only what builds on its head), resolve the conflict, run the checks and commit. Then review the new head as before (the checks, the merge probe; a new demo only where what the pull request does looks different now) and hand over again with pr_draft saying what you changed and why: Obeya pushes it onto the PR's branch and posts the text once the owner approves.`
          : `${c.author} does not allow maintainers' edits: ask them with request_changes, in the PR's language, to bring the PR up to date with main${files.length ? ` (the conflict is in ${files.join(', ')})` : ''}. The card then waits for them, and you review their push as any other.`,
      ].join('\n\n'),
      [],
      true,
    );
  }

  /** A review card waiting for the owner looks again at whether its PR collides with what is unpushed on the local main (`probeClash`), as each round of the PR watcher has it do. */
  recheckClash(cardId: string) {
    const i = this.o.board.item(cardId);
    if (i && handedOver(i) && !answering(i) && !this.w.approving.has(cardId)) void this.probeClash(cardId);
  }

  /**
   * The local main moved, or may have while Obeya was not running: each review card waiting for the
   * owner looks again at whether its PR collides with what is unpushed on it.
   */
  reprobeClashes() {
    if (!this.pulls()) return;
    for (const i of this.o.board.items()) if (i.contribution && (!this.o.repo || i.repo === this.o.repo) && handedOver(i) && !answering(i)) void this.probeClash(i.id);
  }

  /** The card whose landing put `commit` on the default branch, where one did. */
  private async landedBy(commit: string): Promise<{ card?: { id: string; title: string } }> {
    const landed = this.o.board
      .items()
      .filter((i) => finished(i.state) && !i.contribution && (!this.o.repo || i.repo === this.o.repo))
      .flatMap((i) => {
        const row = this.o.board.row(i.id);
        const s = fromJson(row.shipped);
        return s?.commit && s.base && !s.pr ? [{ card: i, base: s.base, commit: s.commit, at: row.updated_at }] : [];
      })
      // the cards touched last first: unpushed commits are recent
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 100);
    const at = await this.pulls()!.landingOf(commit, landed);
    const card = landed[at]?.card;
    return card ? { card: { id: card.id, title: card.title } } : {};
  }

  /**
   * Pulling review card `reviewId`'s merged PR into the local main stopped on a conflict with its
   * unpushed commits (`stopped`), and was taken back. Those commits were never pushed, so a worker
   * may rebase them onto the remote's main: the worker of the card whose commit conflicts, else the
   * review card's own, each while its session can go on (finishing after its landing, or resumed in
   * a fresh workspace as for a question). It hands over the resolution, which lands without the
   * owner (`landResolved`). Where no worker can take it, the review card says what is left to do.
   */
  private async resolvePull(reviewId: string, stopped: PullStopped) {
    const t = this.o.board.t.worker;
    const c = fromJson(this.o.board.row(reviewId).contribution);
    if (!c) return;
    const { card } = await this.landedBy(stopped.commit);
    const resolving: Resolving = { card: reviewId, pr: c.number, url: c.url, stopped };
    // a card resolving one already is busy with that
    const takes = (id: string) => {
      const i = this.o.board.item(id);
      const l = i && fromJson(this.o.board.row(id).landed);
      return !!i && i.kind === 'task' && !i.prototypeOf && !i.archivedAt && !l?.resolve && ((!!l && !!i.finishing) || askable(i));
    };
    const resolver = [card?.id, reviewId].find((id) => !!id && takes(id));
    if (!resolver) {
      this.o.board.log(reviewId, 'error', 'obeya', t.pullUnresolved(stopped.subject, stopped.files.join(', '), t.noResolver));
      return;
    }
    const own = resolver !== reviewId;
    this.o.board.log(reviewId, 'state', 'obeya', t.pullStopped(stopped.subject, own ? this.w.card(resolver).title : null));
    if (own) this.o.board.log(resolver, 'state', 'obeya', t.resolvingPull(c.number, stopped.subject));
    const message = (path: string) => this.resolveMessage(resolving, own, path);
    const item = this.w.card(resolver);
    const landed = fromJson(this.o.board.row(resolver).landed);
    if (landed && item.finishing) {
      this.o.board.work(resolver, { landed: toJson({ ...landed, resolve: resolving }), status_line: t.resolvingStatus(c.number) });
      this.w.deliver(resolver, message(this.o.board.row(resolver).workspace ?? ''));
      return;
    }
    // no workspace to resolve it in: the owner pulls by hand
    const failed = () => {
      if (this.o.board.card(resolver)) this.o.board.work(resolver, { status_line: null });
      if (this.o.board.card(reviewId)) this.o.board.log(reviewId, 'error', 'obeya', t.pullUnresolved(stopped.subject, stopped.files.join(', '), t.noResolver));
    };
    try {
      this.w.resumeFinished(item, { resolve: resolving }, (path, worktree) => [message(path), ...(worktree ? [IN_WORKTREE] : [])].join('\n\n'), [], undefined, failed);
      this.o.board.work(resolver, { status_line: t.resolvingStatus(c.number) });
    } catch (e) {
      console.error(`resuming ${resolver} to resolve the pull:`, messageOf(e));
      failed();
    }
  }

  /** What the worker that resolves a stopped pull hears: what stopped, and how to rebase and hand it over. */
  private resolveMessage(r: Resolving, own: boolean, path: string): string {
    const s = r.stopped;
    const repo = this.o.repoPath ?? 'the Obeya checkout';
    const checks = this.o.adapter.checks ?? [];
    const commits = s.unpushed === 1 ? 'one commit' : `${s.unpushed} commits`;
    return [
      `Obeya merged pull request #${r.pr} (${r.url}) on the forge, but pulling the merge into the local main of the Obeya checkout (${repo}) stopped on a conflict: the local main has ${commits} nobody pushed yet, and ${own ? 'the commit of your card' : 'its commit'} ${s.commit.slice(0, 7)} (“${s.subject}”) conflicts with the pull request in ${s.files.join(', ')}. Obeya took the pull back: the local main is as it was, at ${s.main.slice(0, 7)}.`,
      `Those commits were never pushed, so you may rebase them: that rewrites no published history. Resolve it in your workspace (${path}):`,
      [
        `1. Put a branch of your own at the local main as it stood: git checkout -B <branch> ${s.main}. Commit what you still have in the workspace first. Where the workspace lacks those commits, fetch them from the checkout first: git fetch ${repo} ${s.main} ${s.upstream}.`,
        `2. Rebase it onto ${s.upstream}, origin's main with the merge: git rebase ${s.upstream}. Resolve each conflict so that both the pull request's change and the local commits keep doing what they did.`,
        `3. Run ${checks.length ? `the checks (${checks.map((x) => `\`${x}\``).join(', ')})` : 'the repository’s checks'}.`,
        '4. Call ready_for_review with a summary of how you resolved it, without a demo. Obeya then puts the local main at your HEAD, with whatever landed on it meanwhile on top. Do not push.',
      ].join('\n'),
      'Where the two changes contradict each other so that resolving it is a product decision, ask the owner.',
    ].join('\n\n');
  }

  /** The unpushed commits on the local main were rebased (`rewritten`, each old commit by its new one): the cards that landed them name the new ones. */
  private reshipped(rewritten: Record<string, string>) {
    for (const i of this.o.board.items()) {
      if (this.o.repo && i.repo !== this.o.repo) continue;
      const row = this.o.board.row(i.id);
      const s = fromJson(row.shipped);
      const commit = s?.commit && rewritten[s.commit];
      if (!s || !commit) continue;
      this.o.board.work(i.id, { shipped: toJson({ ...s, commit, ...(s.base && rewritten[s.base] ? { base: rewritten[s.base] } : {}) }) });
    }
  }

  /**
   * The worker handed over the stopped pull it resolved (`resolvePull`): the checkout's main goes to
   * its workspace's `HEAD`, and the review card's log says main has its merge. Returns what the
   * worker hears; what is in its workspace's way it fixes, what is in the checkout's goes to the owner.
   */
  async landResolved(cardId: string, r: Resolving): Promise<string> {
    const t = this.o.board.t.worker;
    const row = this.o.board.row(cardId);
    const res = await this.pulls()!.landResolution(row.workspace ?? '', { main: r.stopped.main, upstream: r.stopped.upstream });
    const landed = fromJson(this.o.board.row(cardId).landed);
    const { resolve: _, ...rest } = landed ?? {};
    const done = () => this.o.board.work(cardId, { landed: toJson(rest), status_line: null });
    if ('code' in res) {
      if (res.worker) {
        if (res.main && landed?.resolve) this.o.board.work(cardId, { landed: toJson({ ...landed, resolve: { ...landed.resolve, stopped: { ...landed.resolve.stopped, main: res.main } } }) });
        return `Not landed: ${res.detail}. Fix that, then call ready_for_review again.`;
      }
      done();
      if (this.o.board.card(r.card)) this.o.board.log(r.card, 'error', 'obeya', t.pullFailed(res.detail));
      this.o.board.log(cardId, 'error', 'obeya', t.pullFailed(res.detail));
      return `Not landed: ${res.detail}. That is in the Obeya checkout, not in your work: the owner sees it on the card. End your turn.`;
    }
    done();
    if ('rewritten' in res) this.reshipped(res.rewritten);
    const to = 'already' in res ? res.already : res.to;
    if (!('already' in res)) this.o.board.log(cardId, 'state', 'worker', t.resolvedPull(r.pr, to.slice(0, 7)));
    if (this.o.board.card(r.card)) this.pulled(r.card, to);
    return 'already' in res
      ? `The local main has the merge already (${to.slice(0, 7)}): someone pulled it meanwhile, so nothing of yours is needed. End your turn.`
      : `Landed: the local main is at ${to.slice(0, 7)} now, the pull request's merge under its unpushed commits. End your turn.`;
  }

  /**
   * A review card's worker handed over the resolution of a conflict with main the owner's approval
   * met: Obeya pushes and merges it on that approval. What stops it but a new conflict or a push of
   * the contributor's (both of which go back to the worker) leaves the card waiting for the owner,
   * who approves again.
   */
  async mergeApproved(cardId: string) {
    const c = fromJson(this.o.board.row(cardId).contribution);
    if (c) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.mergingResolved(c.number));
    try {
      await this.mergeContribution(cardId, { kept: true });
    } catch (e) {
      if (e instanceof BadRequest && e.code === 'prMoved') return;
      const row = this.o.board.row(cardId);
      if (!this.o.board.item(cardId)) return;
      if (row.state === 'working' && row.approved_at) this.o.board.work(cardId, { state: 'waiting', need: row.demo ? 'demo' : 'review', status_line: null, approved_at: null });
      // most refusals are in the card's log already
      const said = messageOf(e);
      if (!this.o.board.events(cardId).at(-1)?.text.includes(said)) this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.mergeRefused(said));
    }
  }

  /** The workers shut down: a "Push main" still in its undo window goes undone, as the new workers could not take it back. */
  shutdown() {
    for (const [id, held] of this.pushingMain) {
      if (held === true) continue;
      clearTimeout(held);
      this.pushingMain.delete(id);
    }
  }
}

/** Whether two clashes a review card's PR has with the local main are the same, to the owner: none, or the same commit with the same files. */
function sameClash(a: Clash | null | undefined, b: Clash | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.commit === b.commit && a.files.join('\n') === b.files.join('\n');
}

/**
 * Where Obeya pushes a review card's held commits: the PR's branch in its repository, both as the
 * forge names them and from the contributor, so taken only in a plain form (an https address, or a
 * repository on this machine, as a scratch Obeya's played forge has it; a branch name git takes).
 */
function pushTarget(c: StoredContribution): { repo: string; branch: string } | null {
  const repo = c.headRepo && (/^https:\/\/[\w.-]+(:\d+)?(\/[\w.-]+)+$/.test(c.headRepo) || isAbsolute(c.headRepo)) ? c.headRepo : null;
  const branch = c.headRef && /^[\w][\w./-]*$/.test(c.headRef) && !c.headRef.includes('..') && !c.headRef.endsWith('.lock') ? c.headRef : null;
  return repo && branch ? { repo, branch } : null;
}

/** The CLAUDE.md of the default branch of the repository at `path`; empty where it has none. */
async function readNotes(path: string): Promise<string> {
  const { commit } = await defaultBranchCommit(path);
  return (await gitTry(path, 'show', `${commit}:CLAUDE.md`)) ?? '';
}
