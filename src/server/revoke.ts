// Taking back the owner's approval of a card's work (design: Taking back an approval): an
// approval that held for the worker's next handover is dropped; a pull request not merged yet is
// closed; work that landed is reverted the way it got onto the default branch (a commit on the local
// main, a push to the remote's, or a pull request that reverts the merged one). The card then waits
// for the owner again with its demo, its work back on its branch, so that approving it once more
// lands it again.

import { REVOKE_HOLD_MS, type Item } from '../core/types';
import { messageOf } from '../core/text';
import { BadRequest } from './board';
import { parsePrUrl } from './forge';
import { hostName } from './hosts';
import { fromJson, type LandedState, type PrState, toJson } from './row';
import { revocable } from './revocable';
import type { Delivery } from './workers';
import type { WorkerOptions } from './worker-options';
import { type Landed, type LandProblem, shortageOf } from './workspaces';
import { WorkspaceError } from './git';

/** What taking back an approval needs of the workers. */
export interface RevokeHost {
  /** Cards whose work is landing, or being taken back: approving again is refused meanwhile, and a restart waits. */
  landing: Set<string>;
  sameRun(cardId: string): () => boolean;
  card(id: string): Item;
  deliver(cardId: string, text: string, images?: string[], o?: Delivery): void;
  tellLater(cardId: string, text: string): void;
  /** Whether the card's worker is in the middle of a turn. */
  inTurn(cardId: string): boolean;
  /** Ends the card's session, if it has one running. */
  end(cardId: string): void;
  bump(cardId: string): void;
  /** Settles once git has freed what the card held before (its landed workspace, say): a lease taken meanwhile would go with it. */
  freed(cardId: string): Promise<void>;
  /** Removes a follow-up's temporary worktree. */
  removeTree(path: string | null): void;
  /** The card's workspace goes back (a worktree removed, a clone free again), its session ended: the card holds none any more. */
  free(cardId: string): void;
}

/** How the worker hears that it is to undo what it did after the landing. */
const UNDO_AFTER =
  'If you did something after the landing that presents the work as done (closed an issue, posted its link, told someone), undo it where it no longer holds.';

export class Revocations {
  /** Cards whose approval waits out its undo window before it is taken back (`revoke`), or is being taken back. */
  private held = new Map<string, ReturnType<typeof setTimeout> | true>();

  constructor(
    private o: WorkerOptions,
    private w: RevokeHost,
  ) {}

  /**
   * The owner takes back their approval of the card's work: once the undo window is through
   * (`keep` takes it back), as `revocable` says. Refused where there is nothing to take back, or it
   * is landing right now.
   */
  revoke(cardId: string) {
    const how = revocable(this.o.board.row(cardId));
    if (!how) throw new BadRequest('notRevocable', 'the card has no approval to take back');
    if (this.held.has(cardId) || this.w.landing.has(cardId)) throw new BadRequest('notReady', 'the card’s work is landing or being taken back');
    this.held.set(
      cardId,
      setTimeout(() => {
        this.held.set(cardId, true);
        void this.now(cardId)
          .catch((e: unknown) => {
            console.error(`taking back the approval of ${cardId}:`, e);
            if (this.o.board.item(cardId)) this.failed(cardId, messageOf(e));
          })
          .finally(() => this.held.delete(cardId));
      }, this.o.revokeHold ?? REVOKE_HOLD_MS),
    );
  }

  /** The owner takes back "Take back approval" within its undo window: nothing happened. */
  keep(cardId: string) {
    const held = this.held.get(cardId);
    if (!held || held === true) throw new BadRequest('notRevoking', 'the card’s approval is not waiting to be taken back');
    clearTimeout(held);
    this.held.delete(cardId);
  }

  /** Whether the card's approval is being taken back right now: its rows change under whatever else would act on it. */
  busy(cardId: string): boolean {
    return this.held.get(cardId) === true;
  }

  /** Stops the undo windows still running: nothing is taken back after the workers shut down. */
  shutdown() {
    for (const held of this.held.values()) if (held !== true) clearTimeout(held);
    this.held.clear();
  }

  private async now(cardId: string) {
    if (!this.o.board.item(cardId)) return;
    const how = revocable(this.o.board.row(cardId));
    if (!how) return;
    // its worker handed over during the undo window, and the approval it held is landing the work now
    if (this.w.landing.has(cardId)) return this.failed(cardId, this.o.board.t.worker.revokeLanding);
    if (how.how === 'approval') return this.dropApproval(cardId);
    this.w.landing.add(cardId);
    this.o.board.work(cardId, { status_line: this.o.board.t.worker.revoking });
    try {
      if (how.how === 'closePr') await this.closePrs(cardId);
      else await this.revert(cardId, how.how === 'rollbackPr');
    } finally {
      this.w.landing.delete(cardId);
    }
  }

  /** It could not be taken back: the card stays as it was, and says why. */
  private failed(cardId: string, why: string) {
    this.o.board.work(cardId, { status_line: null });
    this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.revokeFailed(why));
  }

  /** The approval held for the worker's next handover (its work could not land yet) holds no more. */
  private dropApproval(cardId: string) {
    this.o.board.work(cardId, { approved_at: null });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.revokedApproval);
    this.w.tellLater(cardId, 'The owner took back their approval of your work: once you hand over again, it waits for their approval, as any handover, instead of landing by itself.');
  }

  /** Where the forge's calls for the card run: its workspace on this machine, else the repository's checkout. */
  private forgeCwd(cardId: string): string {
    const ws = this.o.board.row(cardId).workspace;
    return ws && !hostName(ws) ? ws : (this.o.repoPath ?? process.cwd());
  }

  /**
   * Its pull requests, none merged yet, are closed unmerged, their branches left as they are; the
   * card waits for the owner again with its demo, and its worker hears so with its next step (at
   * once where it is in a turn: it may be opening the pull request).
   */
  private async closePrs(cardId: string) {
    const closed: PrState[] = [];
    // one the worker reports while the others are being closed is closed too
    for (let round = 0; round < 3; round++) {
      const root = fromJson(this.o.board.row(cardId).pr);
      const open = [root, ...(root?.more ?? [])].filter((p): p is PrState => !!p?.url && !p.closed && !p.merged && !closed.some((c) => c.url === p.url));
      if (!open.length) break;
      if (!this.o.forge) return this.failed(cardId, 'no forge to close the pull request on');
      const cwd = this.forgeCwd(cardId);
      const results = await Promise.allSettled(open.map((p) => this.o.forge!.close(cwd, p.url!)));
      if (!this.o.board.item(cardId)) return;
      const still = results.flatMap((r, i) => (r.status === 'rejected' ? [`${open[i]!.url}: ${messageOf(r.reason)}`] : []));
      if (still.length) return this.failed(cardId, still.join('; '));
      closed.push(...open);
    }
    const names = closed.map((p) => `#${p.number}${p.repo ? ` (${p.repo})` : ''}`);
    const row = this.o.board.row(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: row.demo ? 'demo' : 'review', detail: null, status_line: null, approved_at: null, pr: null });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.revokedPr(names));
    const text = [
      'The owner took back their approval of your work.',
      names.length ? `Obeya closed your pull request${names.length > 1 ? 's' : ''} ${names.join(', ')} without merging; ${names.length > 1 ? 'their branches stay' : 'its branch stays'}.` : 'No pull request of yours was recorded yet.',
      'The card waits for the owner’s approval again, with the demo it has: open no pull request and push nothing until they approve. If you opened one that Obeya does not know of, close it.',
      'Change nothing else unless the owner asks.',
    ].join(' ');
    if (this.w.inTurn(cardId)) this.w.deliver(cardId, text, [], { owner: true });
    else this.w.tellLater(cardId, text);
  }

  /**
   * Landed work goes off the default branch the way it got there: a revert commit landed on the
   * local main, or pushed to the remote's where the work was pushed there directly; for a merged pull
   * request, a pull request that reverts it, which Obeya then watches and merges like the card's own
   * (`rolledBack` once merged). The worker finishing after the landing stops; the revert is made in
   * its workspace, or in one taken for it.
   */
  private async revert(cardId: string, rollback: boolean) {
    const row = this.o.board.row(cardId);
    const s = fromJson(row.shipped)!;
    const landed = { base: s.base!, commit: s.commit!, ...(s.head ? { head: s.head } : {}) };
    // pushed straight to the remote's main where work otherwise goes out as a pull request (`direct` was not recorded before 2026-11-12)
    const direct = !rollback && (s.direct ?? this.o.adapter.land === 'pr');
    const onto = rollback || direct ? 'origin' : 'local';
    const ws = await this.workspace(cardId);
    if (!ws) return;
    const ok = async (r: unknown): Promise<boolean> => {
      if (!this.o.board.item(cardId)) return false;
      if (r && typeof r === 'object' && 'code' in r) {
        await this.giveBack(cardId, landed.commit);
        this.failed(cardId, (r as LandProblem).detail);
        return false;
      }
      return true;
    };
    const made = await this.o.workspaces.revertLanded(cardId, landed, onto, this.w.card(cardId).title);
    if (!(await ok(made)) || 'code' in made) return;
    // a rebase merge brought several commits, of which the forge named the last
    landed.base = made.base;
    if (rollback) return this.openRollback(cardId, landed, made.main, s.pr!.number);
    const result: Landed | LandProblem = onto === 'local' ? await this.o.workspaces.landOnMain(cardId, row.branch!) : await this.o.workspaces.pushToMain(cardId);
    if (!(await ok(result)) || 'code' in result) return;
    const restarts = (await this.o.restartsFor?.(result, direct ? ws : undefined)) ?? false;
    this.o.onMerged?.(cardId);
    await this.backToOwner(cardId, landed, onto, this.o.board.t.worker.reverted(result.to.slice(0, 7)), [
      `The owner took back their approval of your work. Obeya reverted it on main (${result.to.slice(0, 7)}${direct ? ', pushed to the remote' : ''}): main no longer has it.`,
      restarts === 'obeya' ? 'Obeya runs from that checkout and starts again with the revert as soon as no worker is in the middle of a turn.' : '',
    ]);
  }

  /**
   * The workspace the revert is made in: that of the worker still finishing after the landing,
   * whose session ends; else one taken for the card on its branch, as a question after the work
   * takes one. None where no workspace is free: the card says so.
   */
  private async workspace(cardId: string): Promise<string | null> {
    const row = this.o.board.row(cardId);
    const l = fromJson(row.landed);
    this.w.end(cardId);
    this.w.bump(cardId);
    // meanwhile the card holds its workspace as landed work does while its worker finishes
    const revoking = toJson<LandedState>({ revoking: true });
    if (row.workspace && l && !l.worktree) {
      this.o.board.work(cardId, { landed: revoking, app: null });
      return row.workspace;
    }
    // a follow-up in a temporary worktree: that takes no part in landing
    if (row.workspace) this.w.removeTree(row.workspace);
    this.o.board.work(cardId, { workspace: null, landed: revoking, app: null });
    await this.w.freed(cardId);
    try {
      const lease = this.o.workspaces.lease(cardId, row.branch!, { overSlots: true });
      this.o.board.work(cardId, { workspace: lease.path });
      const at = (await lease.ready) ?? lease.path;
      if (at !== lease.path) this.o.board.work(cardId, { workspace: at });
      return at;
    } catch (e) {
      this.o.board.work(cardId, { workspace: null });
      const why = e instanceof WorkspaceError && shortageOf(e.code) ? this.o.board.t.worker.revokeNoWorkspace : messageOf(e);
      this.failed(cardId, why);
      return null;
    }
  }

  /** What stopped the revert: the card stays live, its branch back on the landed work, and the workspace taken for it goes back. */
  private async giveBack(cardId: string, commit: string) {
    await this.o.workspaces.resetBranch(cardId, commit).catch((e: unknown) => console.error(`putting the branch of ${cardId} back on ${commit}:`, e));
    if (this.o.board.item(cardId)) this.w.free(cardId);
  }

  /**
   * The revert of the card's merged pull request `of` goes out as a pull request of its own, from a
   * branch named after the card's: the card is in it, and its worker tends it as its own (review
   * comments, failed checks); Obeya merges it once it is ready.
   */
  private async openRollback(cardId: string, landed: { base: string; commit: string }, main: string, of: number) {
    const row = this.o.board.row(cardId);
    const head = `${row.branch}-rollback`;
    const card = this.w.card(cardId);
    let url: string;
    try {
      if (!this.o.forge) throw new Error('no forge to open the pull request on');
      await this.o.workspaces.pushAs(cardId, head);
      url = await this.o.forge.open(this.forgeCwd(cardId), { base: main, head, title: `Revert "${card.title}"`, body: `Reverts #${of}.` });
    } catch (e) {
      if (!this.o.board.item(cardId)) return;
      await this.giveBack(cardId, landed.commit);
      return this.failed(cardId, messageOf(e));
    }
    const number = parsePrUrl(url)?.number;
    if (!this.o.board.item(cardId)) return;
    const pr: PrState = { url, ...(number ? { number } : {}), seen: [], reported: [], rollback: { ...landed, of, head } };
    this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, status_line: null, approved_at: null, landed: null, pr: toJson(pr) });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.rollbackOpened(number ?? 0, of));
    this.o.onPrOpened?.(cardId);
    this.w.deliver(
      cardId,
      [
        `The owner took back their approval of your work. Your pull request #${of} was merged already, so Obeya opened a pull request that reverts it: ${url}, from the branch ${head}. Your workspace holds that revert as the one commit on top of ${main}, on your branch ${row.branch}; a change to it goes out with \`git push origin HEAD:${head}\`.`,
        'Obeya watches it as it watched yours: it passes you review comments, failed checks and conflicts, which you handle the way the repository does, and merges it once it is ready. Once it is merged, Obeya puts your work back onto your branch, and the card waits for the owner’s approval again.',
        UNDO_AFTER,
        'Then end your turn.',
      ].join('\n\n'),
      [],
      { owner: true },
    );
  }

  /**
   * The pull request that reverts the card's merged work is merged: the work goes back onto the
   * card's branch, and the card is the owner's again.
   */
  async rolledBack(cardId: string) {
    const pr = fromJson(this.o.board.row(cardId).pr)!;
    const rollback = pr.rollback!;
    this.w.landing.add(cardId);
    // its worker, tending the rollback, stops before its branch changes under it; the watcher no longer looks
    this.w.end(cardId);
    this.w.bump(cardId);
    this.o.board.work(cardId, { landed: toJson<LandedState>({ revoking: true }), status_line: this.o.board.t.worker.revoking });
    try {
      this.o.onMerged?.(cardId);
      await this.backToOwner(cardId, rollback, 'origin', this.o.board.t.worker.rolledBack(pr.number ?? 0), [`The pull request that reverts your work (#${pr.number}) is merged: main no longer has your work.`]);
    } catch (e) {
      if (this.o.board.item(cardId)) this.failed(cardId, messageOf(e));
    } finally {
      this.w.landing.delete(cardId);
    }
  }

  /** The pull request that reverts the card's work was closed unmerged: the work stays on the default branch, and the card is live again. */
  async rollbackClosed(cardId: string) {
    const pr = fromJson(this.o.board.row(cardId).pr)!;
    this.w.landing.add(cardId);
    this.w.end(cardId);
    this.w.bump(cardId);
    // the card keeps its workspace until its branch is back on the work
    this.o.board.work(cardId, { state: 'live', need: null, detail: null, status_line: null, pr: null, landed: toJson<LandedState>({ revoking: true }) });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.rollbackClosed(pr.number ?? 0));
    try {
      await this.giveBack(cardId, pr.rollback!.commit);
    } finally {
      this.w.landing.delete(cardId);
    }
  }

  /**
   * Obeya stopped while it took back the card's approval (a restart waits for that, a crash does
   * not): work already off the default branch goes back onto the card's branch and the card is the
   * owner's; a rollback PR is watched again, which sees its merge anew; otherwise nothing was taken
   * back, and the card, live as before, says so.
   */
  async recover(cardId: string) {
    const row = this.o.board.row(cardId);
    const l = fromJson(row.landed);
    if (!l?.revoking) return;
    this.w.landing.add(cardId);
    try {
      if (row.state === 'waiting' && l.reapply) {
        const { onto, ...landed } = l.reapply;
        await this.backToOwner(cardId, landed, onto, this.o.board.t.worker.revokedAfterRestart, ['The owner took back their approval of your work, and Obeya took it off main before it restarted: main no longer has it.']);
      } else if (row.state === 'inPr') this.o.board.work(cardId, { landed: null, status_line: null });
      else {
        const commit = fromJson(row.shipped)?.commit;
        if (commit) await this.giveBack(cardId, commit);
        else this.w.free(cardId);
        this.failed(cardId, this.o.board.t.worker.revokeCutOff);
      }
    } finally {
      this.w.landing.delete(cardId);
    }
  }

  /**
   * The work is off the default branch: it goes back onto the card's branch in its workspace, on
   * top of the default branch as `onto` has it now, and the card waits for the owner's approval
   * again with its demo. The worker hears it (`told` first) and ends its turn.
   */
  private async backToOwner(cardId: string, landed: { base: string; commit: string }, onto: 'local' | 'origin', logLine: string, told: string[]) {
    // the work is off the default branch: a restart before it is back on the branch puts it there (`recover`)
    const before = this.o.board.row(cardId);
    this.o.board.work(cardId, {
      state: 'waiting',
      need: before.demo ? 'demo' : 'review',
      detail: null,
      approved_at: null,
      shipped: null,
      pr: null,
      landed: toJson<LandedState>({ revoking: true, reapply: { base: landed.base, commit: landed.commit, onto } }),
    });
    const back = await this.o.workspaces.reapply(cardId, landed, onto).catch((e: unknown) => {
      console.error(`putting the work of ${cardId} back onto its branch:`, e);
      return null;
    });
    if (!this.o.board.item(cardId)) return;
    const row = this.o.board.row(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: row.demo ? 'demo' : 'review', detail: null, status_line: null, approved_at: null, landed: null, shipped: null, pr: null });
    this.o.board.log(cardId, 'state', 'owner', logLine);
    if (!back) this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.notReapplied);
    this.w.deliver(
      cardId,
      [
        ...told,
        back
          ? `Your branch ${row.branch} holds the work again, as one commit on top of main (${back.slice(0, 7)}); where it was pushed before, a push of it now needs --force-with-lease.`
          : `Obeya could not put the work back onto your branch ${row.branch}: it no longer applies cleanly on main, so the branch stands on main alone. Bring the work (${landed.base.slice(0, 12)}..${landed.commit.slice(0, 12)}) back onto it, commit it, and hand over again.`,
        'The card waits for the owner’s approval again, with the demo it has; approving it lands the work again.',
        UNDO_AFTER,
        back ? 'Change nothing else unless the owner asks, and end your turn.' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      [],
      { owner: true },
    );
  }
}
