// A task that works on a branch of the owner's that existed before it (design: Landing, A branch of
// the owner's): which branches a task may take, taking one, where its open pull request is, and
// how its approved work goes onto that pull request.

import { finished } from '../core/card';
import { messageOf } from '../core/text';
import type { AdoptedBranch, AdoptedPr, BranchChoice } from '../core/types';
import { BadRequest } from './board';
import { fromJson, type PrState, toJson } from './row';
import type { WorkerOptions } from './worker-options';
import type { OwnBranch } from './workspaces';

export class AdoptedBranches {
  constructor(private o: WorkerOptions) {}

  /**
   * The branches a new task of this repository may work on (`BranchChoice`): one another card works
   * on names it (a card not finished or archived, or finishing in its workspace), one checked out
   * by the owner is left out.
   */
  async choices(): Promise<BranchChoice[]> {
    return (await this.read()).map(({ name, local, card }) => ({ name, ...(local ? {} : { remoteOnly: true as const }), ...(card ? { card } : {}) }));
  }

  /** The owner's branches (`OwnBranch`) a task may take, each with the card that holds it already. */
  private async read(): Promise<(OwnBranch & { card?: { id: string; title: string } })[]> {
    const own = (await this.o.workspaces.branchChoices?.()) ?? [];
    const cards = this.claims();
    return own.flatMap((b) => {
      const card = cards.get(b.name);
      return b.checkedOut && !card ? [] : [{ ...b, ...(card ? { card } : {}) }];
    });
  }

  /** The cards of this repository that hold a branch, by its name: their own once begun, the one they adopted before that. */
  private claims(): Map<string, { id: string; title: string }> {
    const out = new Map<string, { id: string; title: string }>();
    for (const i of this.o.board.items()) {
      if ((this.o.repo && i.repo !== this.o.repo) || i.archivedAt || (finished(i.state) && !i.workspace)) continue;
      const name = i.branch ?? i.adopted?.branch;
      if (name) out.set(name, { id: i.id, title: i.title });
    }
    return out;
  }

  /**
   * Before work begins on the task: it works on the owner's branch `branch` (one of `choices` no
   * other card holds), or with null on a new branch from the main branch again. Its open pull request
   * is looked up afterwards, without the owner waiting for the forge.
   */
  async adopt(cardId: string, branch: string | null) {
    this.unbegun(cardId);
    const row = this.o.board.row(cardId);
    if (branch === null) {
      if (row.adopted) this.o.board.work(cardId, { adopted: null });
      return;
    }
    if (typeof branch !== 'string' || !branch.trim()) throw new BadRequest('invalid', 'branch must be the name of a branch');
    const name = branch.trim();
    const choice = (await this.read()).find((b) => b.name === name);
    if (!choice) throw new BadRequest('noBranch', `there is no branch ${name} of yours here (the main branch and Obeya's own are not taken, nor one you have checked out)`);
    // what git was asked meanwhile: the card may have started, or another card taken the branch, since
    this.unbegun(cardId);
    const holder = this.claims().get(name) ?? choice.card;
    if (holder && holder.id !== cardId) throw new BadRequest('branchOnCard', `the card “${holder.title}” works on ${name} already`);
    // the start point of a fork's task is the branch now, not the original's main
    this.o.board.work(cardId, { adopted: toJson<AdoptedBranch>({ branch: name, ...(choice.remote ? { remote: true } : {}) }), upstream: null });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.adopted(name));
    void this.lookUp(cardId);
  }

  /** Refuses unless the card is a task nobody has begun to work on. */
  private unbegun(cardId: string) {
    const card = this.o.board.item(cardId);
    const row = this.o.board.row(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (card.kind !== 'task' || card.state !== 'planned' || row.branch || row.workspace || card.prototypeOf || card.contribution || card.builtOn)
      throw new BadRequest('invalid', 'a task takes a branch of yours only before work on it begins');
  }

  /**
   * The open pull request of the card's adopted branch, asked of the forge now and stored with the
   * branch (gone where there is none any more); as stored where the forge cannot be asked. Null for a
   * card on a branch of its own.
   */
  async lookUp(cardId: string): Promise<AdoptedPr | null> {
    const stored = fromJson(this.o.board.row(cardId).adopted);
    if (!stored) return null;
    if (!this.o.forge?.branchPr) return stored.pr ?? null;
    let pr: AdoptedPr | null;
    try {
      pr = await this.o.forge.branchPr(this.o.repoPath ?? '.', stored.branch);
    } catch (e) {
      console.error(`pull request of ${stored.branch}:`, messageOf(e));
      return stored.pr ?? null;
    }
    // taken back or another branch taken meanwhile: what was asked is no longer the card's
    const now = fromJson(this.o.board.row(cardId).adopted);
    if (now?.branch !== stored.branch) return now?.pr ?? null;
    if (JSON.stringify(now.pr ?? null) !== JSON.stringify(pr)) {
      const { pr: _, ...rest } = now;
      this.o.board.work(cardId, { adopted: toJson<AdoptedBranch>({ ...rest, ...(pr ? { pr } : {}) }) });
    }
    return pr;
  }
}

/** The pull request an adopted branch's approved work went onto, as the watcher follows it. */
export const adoptedPrState = (pr: AdoptedPr): PrState => ({
  url: pr.url,
  number: pr.number,
  seen: [],
  reported: [],
  adopted: true,
  ...(pr.repo ? { repo: pr.repo } : {}),
  ...(pr.maintainers ? { maintainers: true as const } : {}),
});

/** A pull request as the card and the worker name it: `#82`, with its repository where that is another than origin's. */
export const adoptedPrName = (pr: Pick<AdoptedPr, 'number' | 'repo'>) => `${pr.repo ?? ''}#${pr.number}`;
