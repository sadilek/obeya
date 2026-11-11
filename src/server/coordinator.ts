// The Coordinator decides when a card may start: not while its changes are likely to conflict on
// merge with work in progress. It judges that from what each card will change (estimated before
// the start) and has changed so far (files and the places in them); sharing a file is not enough.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { cardTag } from '../core/card-number';
import { drawnWaits, inQueue, movable, notStarted, queueOrder, reach, startable, waitsOn } from '../core/queue';
import { EVICT_HOLD_MS, finished, type Item, nameless, START_ALL_HOLD_MS, titleFrom, type Wait } from '../core/types';
import { ACTIVE, BadRequest, type Board, TITLE_MAX } from './board';
import { fromJson, toJson } from './row';
import { type AgentRuntime, readSession, waitQuietly } from './runtime';
import type { Workers } from './workers';
import { type CardWorkspaces, type Change, RECHECK_MS, shortageOf } from './workspaces';
import { LANGUAGE_NAMES } from '../core/locale';
import { messageOf, oneLine } from '../core/text';

/** A workstream as the Coordinator scheduled it, in its turn's order. */
interface Planned {
  card: string;
  files: string[];
  waitsFor: string[];
  /** Those of `waitsFor` it builds on. */
  buildsOn: string[];
  reason: string;
}

export interface Scope {
  files: string[];
  /** Cards in progress or queued ahead whose changes the Coordinator expects to conflict with this card's on merge. */
  conflictsWith: string[];
  /** Workstreams of its project it builds on: they hold it until they have landed, also while not started. */
  buildsOn: string[];
  reason: string;
}

/** What the Coordinator needs of the repository a card belongs to. */
export interface RepoHands {
  workers: Workers;
  workspaces: CardWorkspaces;
  adapter: RepoAdapter;
  /** Where the Coordinator reads (scopes, questions): the repository's read tree. */
  path: string;
  /** A folder without git: its cards all work in the folder itself, with no branches to merge. */
  folder?: boolean;
}

export interface CoordinatorOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The repository of a card; a canvas may span several. */
  repoFor: (card: Item) => RepoHands;
  /** Where the Coordinator reads for what the owner says without a card: the home repository's read tree. */
  home: () => string;
  /** Whether the owner paused the canvas's agents: a card the Coordinator lets start waits until they resume them (`{ paused }` in its queue). */
  paused?: () => boolean;
  /** How long a project's start, or taking a card's workspace, waits for the owner to take it back; START_ALL_HOLD_MS and EVICT_HOLD_MS by default. */
  holdMs?: number;
  /** The files of screenshots by their ids. */
  imageFiles?: (ids?: string[]) => string[];
}

export class Coordinator {
  /** The language its agents write the owner in: the owner's conversation language, since no words of the owner's go to them. */
  private get language() {
    return LANGUAGE_NAMES[this.o.board.conversation()];
  }

  /** Decisions to start are taken one at a time, so two colliding cards cannot both slip through. */
  private chain: Promise<unknown> = Promise.resolve();
  /** How many of those are still to come or under way. */
  private queued = 0;
  private draining = false;
  /** A look again at cards waiting for a workspace, which can free up without a change of the board (a dirty clone cleaned up). */
  private recheck?: ReturnType<typeof setTimeout>;
  /** Cards being named now: asked again, the same session answers. */
  private naming = new Map<string, Promise<void>>();

  /** The projects whose plan doc it reads now for which workstream builds on which. */
  private readingDeps = new Map<string, Promise<void>>();

  /** Cards whose workspace the owner takes from them, while the undo window runs (`evict`). */
  private evictions = new Map<string, ReturnType<typeof setTimeout>>();
  /** Cards giving up their workspace now, the undo window through: queued already, they start once that is done. */
  private giving = new Set<string>();

  /** Set once its canvas stopped (`shutdown`): it decides and starts nothing more. */
  private ended = false;
  private unwatch: () => void;

  constructor(private o: CoordinatorOptions) {
    this.unwatch = o.board.onChange(() => {
      this.scheduleDrain();
      this.readPendingDeps();
    });
  }

  /** After a restart: decide again on cards the Coordinator was checking, and start what is free. */
  resume() {
    const together = new Set<string>();
    for (const i of this.o.board.items()) {
      if (i.state !== 'planned' || !i.queue) continue;
      if ('checking' in i.queue && i.queue.together) together.add(i.queue.together);
      else if ('checking' in i.queue) this.serial(() => this.decide(i.id));
    }
    for (const p of together) this.serial(() => this.decideAll(p));
    this.scheduleDrain();
    this.readPendingDeps();
  }

  shutdown() {
    this.ended = true;
    this.unwatch();
    clearTimeout(this.recheck);
    for (const t of this.evictions.values()) clearTimeout(t);
  }

  /**
   * The owner takes the card's clone from it for the cards waiting for one (the Workspaces list):
   * after a few seconds in which `keep` takes that back, its worker stops and the clone is free
   * (`Workers.evict`), for the card that waits longest. A card whose worker was on it waits in the
   * queue behind those waiting already, and goes on on its branch once a workspace is free again; a
   * card stopped before stays planned.
   */
  evict(cardId: string) {
    const card = this.card(cardId);
    if (this.evictions.has(cardId) || !this.o.repoFor(card).workers.evictable(cardId)) throw new BadRequest('notEvictable', 'the card holds no clone that can be taken from it');
    const go = () => {
      this.evictions.delete(cardId);
      const now = this.o.board.item(cardId);
      if (!now) return this.o.board.changed();
      let workers: Workers;
      try {
        workers = this.o.repoFor(now).workers;
        if (!workers.evictable(cardId)) return this.o.board.changed();
      } catch {
        return this.o.board.changed();
      }
      // queued at once, so that a card waiting behind it for a likely conflict keeps waiting; at work
      // already, it goes on once a workspace is free, whatever arrows the owner draws meanwhile
      const active = now.state !== 'planned';
      if (active && !now.queue) {
        this.setQueue(cardId, { workspace: 'none', begun: true });
        this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.coordinator.requeued);
      }
      this.giving.add(cardId);
      workers
        .evict(cardId)
        .catch((e: unknown) => void (this.o.board.item(cardId) && this.o.board.log(cardId, 'error', 'obeya', messageOf(e))))
        .finally(() => {
          this.giving.delete(cardId);
          this.scheduleDrain();
        });
    };
    this.evictions.set(cardId, setTimeout(go, this.o.holdMs ?? EVICT_HOLD_MS));
    this.o.board.changed();
  }

  /** The owner takes back taking the card's workspace while the undo window runs: it keeps it, nothing happened. */
  keep(cardId: string) {
    const t = this.evictions.get(cardId);
    if (!t) throw new BadRequest('notEvictable', 'the card is not giving up its workspace');
    clearTimeout(t);
    this.evictions.delete(cardId);
    this.o.board.changed();
  }

  /** Whether the card's workspace goes to another card once the undo window is through (`evict`). */
  evicting(cardId: string): boolean {
    return this.evictions.has(cardId);
  }

  /** The owner wants the card worked on; a project, all its planned workstreams. */
  request(cardId: string): void {
    const card = this.card(cardId);
    if (card.repoDown) throw new BadRequest('repoDown', `the repository ${card.repo} of the card does not run on this canvas`);
    if (card.kind === 'project') return this.requestAll(card);
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    if (card.queue) throw new BadRequest('queued', 'the card is already with Obeya');
    this.setQueue(cardId, { checking: true });
    this.serial(() => this.decide(cardId));
  }

  /**
   * A follow-up task a review card's worker made of findings: it builds on the pull request, so it
   * queues behind the review card at once, and once the PR is merged starts (or is judged again
   * against the work in progress, as any card whose wait ended). A review card already finished
   * leaves nothing to wait for: the task is judged as any card.
   */
  followUp(taskId: string, reviewId: string): void {
    const review = this.o.board.item(reviewId);
    if (!review || !unlanded(review)) return this.request(taskId);
    const t = this.o.board.t.coordinator;
    const reason = t.followsReview(fromJson(this.o.board.row(reviewId).contribution)?.number ?? 0);
    this.setQueue(taskId, { behind: [reviewId], reason, buildsOn: [reviewId] });
    this.o.board.log(taskId, 'state', 'obeya', t.waitsFor(this.o.board.t.quote(review.title), reason));
  }

  /**
   * All planned workstreams of the project go to the Coordinator together (those snoozed to start later too: the owner starts them now): one turn sees them all
   * with the plan doc and decides which start now and which wait, for a dependency or a likely
   * conflict, and in which order. They queue in the plan's order until it has, and the turn waits a
   * few seconds, so the owner can take the start back (`dequeue` on the project).
   */
  private requestAll(project: Item): void {
    const open = startable(project, this.o.board.items());
    if (!open.length) throw new BadRequest('nothingToStart', 'the project has no planned workstream left to start');
    // one the owner set aside to start later goes with them, so a workstream building on it waits for it
    for (const w of open) if (w.snoozed?.start) this.o.board.unsnooze(w.id, 'owner');
    const now = Date.now();
    open.forEach((w, n) => this.o.board.work(w.id, { queue: toJson({ checking: true, together: project.id, since: new Date(now + n).toISOString() }) }));
    this.o.board.log(project.id, 'state', 'owner', this.o.board.t.coordinator.allStarted(open.map((w) => w.label ?? w.title).join(', ')));
    setTimeout(() => this.serial(() => this.decideAll(project.id)), this.o.holdMs ?? START_ALL_HOLD_MS);
  }

  /**
   * The owner wants the project's workstreams arranged by what builds on what: at once when it has
   * read that for the doc as it stands, else once it has.
   */
  async arrange(projectId: string): Promise<void> {
    if (this.o.board.deps(projectId).current) return this.o.board.arrange(projectId);
    this.o.board.setDeps(projectId, { reading: 'owner' });
    // the reading arranges the project once it has it
    await this.readDeps(projectId).catch((e) => {
      throw new BadRequest('arrangeFailed', messageOf(e));
    });
  }

  /** Projects waiting for their reading (one just come, or one asked for before a restart): it starts. */
  private readPendingDeps() {
    for (const id of this.o.board.arranging()) if (!this.readingDeps.has(id) && this.o.board.item(id)?.arranging) void this.readDeps(id).catch(() => {});
  }

  /**
   * Reads from the plan doc which workstream builds on which, and arranges the project by it when
   * the owner asked for that, or when it just came and the owner has moved none of its cards since.
   */
  private readDeps(projectId: string): Promise<void> {
    const running = this.readingDeps.get(projectId);
    if (running) return running;
    const run = (async () => {
      const project = this.o.board.item(projectId);
      if (!project) return;
      const kids = this.o.board.items().filter((i) => i.parent === projectId);
      let on: Record<string, string[]>;
      try {
        on = await this.dependencies(project, kids);
      } catch (e) {
        this.o.board.log(projectId, 'error', 'obeya', this.o.board.t.coordinator.arrangeFailed(messageOf(e)));
        this.o.board.setDeps(projectId, { failed: true });
        throw e;
      }
      if (!this.o.board.item(projectId)) return;
      const by = this.o.board.deps(projectId).reading;
      this.o.board.setDeps(projectId, { on });
      if (by === 'owner' || (by === 'auto' && this.o.board.untouched(projectId))) this.o.board.arrange(projectId);
    })().finally(() => this.readingDeps.delete(projectId));
    this.readingDeps.set(projectId, run);
    return run;
  }

  /** One turn reads from the plan doc which workstream builds on which: the keys of those each builds on, by key. */
  private async dependencies(project: Item, kids: Item[]): Promise<Record<string, string[]>> {
    const keys = this.o.board.workstreamKeys(project.id);
    const tags = new Map(kids.map((k) => [cardTag(k.number), k.id]));
    let on: Record<string, string[]> | undefined;
    const error = await readSession(this.o.runtime, {
      cwd: this.o.repoFor(project).path,
      role: 'coordinator',
      system: DEPS_SYSTEM,
      tools: (finish) => [
        {
          name: 'dependencies',
          description: 'Report every open workstream once: its tag and the tags of the workstreams it builds on (empty when it builds on none).',
          schema: { workstreams: z.array(z.object({ card: z.string(), builds_on: z.array(z.string()) })) },
          run: (a) => {
            if (on) return 'Already reported.';
            const found: Record<string, string[]> = {};
            for (const w of a.workstreams as { card: string; builds_on: string[] }[]) {
              const id = tags.get(w.card);
              if (!id) continue;
              found[keys.get(id)!] = w.builds_on.flatMap((t) => {
                const b = tags.get(t);
                return b && b !== id ? [keys.get(b)!] : [];
              });
            }
            const missing = kids.filter((k) => !finished(k.state) && !(keys.get(k.id)! in found));
            if (missing.length) return `Every open workstream once, please: missing ${missing.map((k) => cardTag(k.number)).join(', ')}. Call dependencies again with all of them.`;
            on = found;
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        ...projectHeader(project),
        `Its workstreams, in the plan's order:\n${kids.map((k) => `- ${cardTag(k.number)}${finished(k.state) ? ' (delivered)' : ''}: ${named(k)}${bodyCut(k, 600)}`).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (!on) throw new Error(error ?? 'no dependencies');
    return on;
  }

  /** The cards to be judged together under `key` (a project's start, or cards freed at once) that the Coordinator has not planned yet. */
  private unplanned(key: string): Item[] {
    return this.o.board
      .snapshot()
      .items.filter((i) => i.state === 'planned' && i.queue && 'checking' in i.queue && i.queue.together === key)
      .sort((a, b) => a.queue!.since.localeCompare(b.queue!.since));
  }

  /** Start a queued card anyway: should it wait for a workspace then, the owner's arrows no longer hold it. */
  force(cardId: string) {
    const card = this.card(cardId);
    if (!card.queue || !('behind' in card.queue)) throw new BadRequest('notQueued', 'the card is not waiting');
    const since = card.queue.since;
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.coordinator.startedDespite);
    this.launch(cardId, since, true);
  }

  /**
   * The owner moves a waiting card `places` places earlier or later in the queue, past cards it has
   * no wait with: it takes the place (`since`) of the farthest card it passes, and each card passed
   * moves up by one.
   */
  reorder(cardId: string, earlier: boolean, places = 1) {
    const card = this.card(cardId);
    if (!movable(card)) throw new BadRequest('notQueued', 'the card is not waiting');
    if (!Number.isInteger(places) || places < 1) throw new BadRequest('invalid', 'places must be a positive whole number');
    const items = this.o.board.items();
    const can = reach(cardId, earlier, items);
    if (can.places < places) throw new BadRequest('notMovable', can.why ? `${can.why}: ${can.stop!.id}` : 'not that far to go');
    const order = queueOrder(items);
    const times = order.map((i) => i.queue!.since);
    const n = order.findIndex((i) => i.id === cardId);
    const to = earlier ? n - places : n + places;
    const past = order[to]!;
    order.splice(n, 1);
    order.splice(to, 0, card);
    // the times stay where they were, each card in the new order taking the next; cards that came in
    // the same millisecond go by id, so one that would tie with the card before it gets a time of its own
    order.forEach((i, k) => {
      if (k && Date.parse(times[k]!) <= Date.parse(times[k - 1]!)) times[k] = new Date(Date.parse(times[k - 1]!) + 1).toISOString();
      if (times[k] !== i.queue!.since) this.setQueue(i.id, i.queue!, times[k]);
    });
    const t = this.o.board.t;
    this.o.board.log(cardId, 'state', 'owner', (earlier ? t.coordinator.movedBefore : t.coordinator.movedAfter)(past.title));
  }

  dequeue(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') {
      // the start of all its workstreams, taken back before the Coordinator planned them
      const back = this.unplanned(cardId);
      if (!back.length) throw new BadRequest('notQueued', 'no workstream of the project waits to be planned');
      for (const w of back) this.setQueue(w.id, null);
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.coordinator.startTakenBack(back.map((w) => w.label ?? w.title).join(', ')));
      return;
    }
    if (!card.queue) throw new BadRequest('notQueued', 'the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.coordinator.dequeued);
  }

  /** Cards in progress; with a repository, only those a card of it can collide with. */
  inProgress(repo?: string): Item[] {
    return this.o.board
      .snapshot()
      // approved work counts until it has landed: a PR not yet merged still holds its files
      // a prototype never lands, so it collides with nothing
      .items.filter((i) => ACTIVE.includes(i.state) && i.kind !== 'project' && !i.prototypeOf && (!repo || i.repo === repo));
  }

  /**
   * Cards of the card's repository queued before it and still waiting: they go first, so a card
   * likely to conflict with one of them queues behind it instead of overtaking it. One that waits
   * for the card itself (it builds on it) does not go first, so the two never wait for each other.
   */
  ahead(card: Item): Item[] {
    const since = card.queue?.since;
    if (!since) return [];
    const items = this.o.board.items();
    return items
      .filter((i) => i.id !== card.id && i.repo === card.repo && inQueue(i) && (i.queue!.since ?? '') < since && !waitsOn(i, card.id, items))
      .sort((a, b) => a.queue!.since.localeCompare(b.queue!.since));
  }

  /**
   * The other workstreams of a workstream's project that have not landed and are neither in progress
   * nor queued ahead: not started (stopped ones too), or queued after it. It may build on one of
   * them; one waiting for it is left out, so the two never wait for each other.
   */
  private pending(card: Item, active: Item[], ahead: Item[]): Item[] {
    if (!card.parent) return [];
    const items = this.o.board.items();
    const seen = new Set([card.id, ...active.map((i) => i.id), ...ahead.map((i) => i.id)]);
    return items.filter(
      (i) => i.parent === card.parent && i.kind !== 'project' && !seen.has(i.id) && !finished(i.state) && !i.archivedAt && !waitsOn(i, card.id, items),
    );
  }

  /** How the log names a card waited for: a workstream by its label, and one not started as such. */
  private nameOf(i: Item): string {
    const t = this.o.board.t;
    const name = i.parent && i.label ? `${i.label} ${t.quote(i.title)}` : t.quote(i.title);
    return notStarted(i) ? t.coordinator.notStarted(name) : name;
  }

  private async decide(cardId: string) {
    // a card started without a title gets one first: its worker, branch and the owner know it by it
    await this.name(cardId);
    const card = this.o.board.item(cardId);
    // taken out of the queue or deleted while waiting for its turn
    if (!card || card.state !== 'planned' || !card.queue || !('checking' in card.queue)) return;
    if (card.repoDown) return this.repoGone(card);
    const active = this.inProgress(card.repo);
    const ahead = this.ahead(card);
    const pending = this.pending(card, active, ahead);
    if (!active.length && !ahead.length && !pending.length) {
      // held by the owner's arrows alone, it is judged once they let it go
      if (drawnWaits(card, this.o.board.items()).length) return void this.queueOrStart(cardId, [], [], '', '');
      // nothing it could collide with or build on: start at once, and estimate the scope for the cards after it
      this.startNow(cardId, this.o.board.t.coordinator.nothingRuns);
      if (this.o.board.item(cardId)?.state !== 'working') return;
      try {
        const scope = await this.estimate(card, [], [], [], waitQuietly);
        this.o.board.work(cardId, { scope: toJson({ files: scope.files, reason: scope.reason }) });
      } catch {}
      return;
    }
    let scope: Scope;
    try {
      scope = await this.estimate(card, active, ahead, pending, (until) => this.o.board.waitsForLimit({ card: cardId }, until));
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.coordinator.estimateFailed(messageOf(e)));
      scope = { files: [], conflictsWith: [], buildsOn: [], reason: '' };
    }
    const now = this.o.board.item(cardId);
    if (!now?.queue) return;
    // its repository stopped running while the Coordinator read
    if (now.repoDown) return this.repoGone(now);
    this.o.board.work(cardId, { scope: toJson({ files: scope.files, reason: scope.reason }) });
    // the workstreams it builds on, and the cards in progress or queued ahead whose changes it
    // expects to conflict with the card's
    const behind = [...active, ...ahead, ...pending].filter((a) => scope.buildsOn.includes(a.id) || scope.conflictsWith.includes(a.id)).map((a) => a.id);
    const t = this.o.board.t.coordinator;
    const buildsOn = behind.filter((id) => scope.buildsOn.includes(id));
    const reason = scope.reason || (buildsOn.length ? t.buildsOn : t.likelyConflict);
    void this.queueOrStart(cardId, behind, buildsOn, reason, `${t.noConflict}${scope.reason ? ` ${scope.reason}` : ''}`, (id) => {
      const a = ahead.find((x) => x.id === id);
      return a && t.waitsAhead(a.title);
    });
  }

  /**
   * Queues the card behind the cards the Coordinator found it waits for (`inferred`, `buildsOn`
   * among them, for `reason`) and those the owner's arrows hold it for, or starts it (`why`) when
   * there are none, which it says. `name` names a card in the log where it knows better than `nameOf`.
   */
  private queueOrStart(cardId: string, inferred: string[], buildsOn: string[], reason: string, why: string, name?: (id: string) => string | undefined): boolean {
    const items = this.o.board.items();
    // an arrow drawn while it was judged may make a card it was to wait for wait for it instead
    inferred = inferred.filter((id) => {
      const i = items.find((x) => x.id === id);
      return !(i && waitsOn(i, cardId, items));
    });
    buildsOn = buildsOn.filter((id) => inferred.includes(id));
    const drawn = drawnWaits(this.card(cardId), items).filter((id) => !inferred.includes(id));
    if (!inferred.length && !drawn.length) {
      this.startNow(cardId, why);
      return true;
    }
    this.setQueue(cardId, { behind: [...inferred, ...drawn], reason: inferred.length ? reason : this.o.board.t.coordinator.drawn, ...(buildsOn.length && { buildsOn }), ...(drawn.length && { manualWait: drawn }) });
    this.logWait(cardId, inferred, reason, drawn, (id) => name?.(id) ?? this.nameOf(items.find((i) => i.id === id)!));
    return false;
  }

  /** The card's line on what it waits for: the waits inferred with their `reason`, and those the owner's arrows hold it for (`drawn`). */
  private logWait(cardId: string, inferred: string[], reason: string, drawn: string[], name: (id: string) => string) {
    const t = this.o.board.t.coordinator;
    const names = (ids: string[]) => ids.map(name).join(', ');
    const line = inferred.length ? `${t.waitsFor(names(inferred), reason)}${drawn.length ? ` ${t.drawnToo(names(drawn))}` : ''}` : t.waitsFor(names(drawn), t.drawn);
    this.o.board.log(cardId, 'state', 'obeya', line);
  }

  /**
   * Decides on the cards that came to the Coordinator together under `key`: the workstreams of a
   * project started at once (`key` its id), or cards whose waits ended at once (`freed:…`).
   */
  private async decideAll(key: string) {
    const items = this.o.board.items();
    const batch = this.unplanned(key);
    const project = this.o.board.item(key);
    const t = this.o.board.t.coordinator;
    if (!batch.length) return;
    if (batch[0]!.repoDown) return batch.forEach((w) => this.repoGone(w));
    if (batch.length === 1) {
      // one is judged as any card
      this.setQueue(batch[0]!.id, { checking: true });
      return this.decide(batch[0]!.id);
    }
    const ids = new Set(batch.map((w) => w.id));
    const repo = batch[0]!.repo;
    const active = this.inProgress(repo);
    // what waits already came first, as for a single card, unless it waits for one of them; freed
    // cards keep their places, so what was queued after the last of them is not ahead
    const last = batch.map((w) => w.queue!.since).sort().at(-1)!;
    const ahead = items
      .filter((i) => i.repo === repo && !ids.has(i.id) && inQueue(i) && (project || i.queue!.since < last) && !batch.some((w) => waitsOn(i, w.id, items)))
      .sort((a, b) => a.queue!.since.localeCompare(b.queue!.since));
    let plan: Planned[];
    try {
      plan = await this.schedule(project, batch, active, ahead);
    } catch (e) {
      // judged one by one instead, each seeing the others it may build on
      if (project) this.o.board.log(key, 'error', 'obeya', t.togetherFailed(messageOf(e)));
      else for (const w of batch) this.o.board.log(w.id, 'error', 'obeya', t.freedFailed(messageOf(e)));
      for (const w of batch) {
        this.setQueue(w.id, { checking: true });
        this.serial(() => this.decide(w.id));
      }
      return;
    }
    if (this.o.board.item(batch[0]!.id)?.repoDown) return this.unplanned(key).forEach((w) => this.repoGone(w));
    // taken out of the queue or started anyway meanwhile
    const still = (id: string) => {
      const q = this.o.board.item(id)?.queue;
      return !!q && 'checking' in q && q.together === key;
    };
    // the turn's order becomes the queue's: a card waits only for what comes before it, so none
    // wait for each other
    const times = batch.map((w) => w.queue!.since!);
    const before = new Set([...active, ...ahead].map((i) => i.id));
    const names = new Map([...active, ...ahead, ...batch].map((i) => [i.id, i.parent && i.label && (!project || i.parent === key) ? `${i.label} ${this.o.board.t.quote(i.title)}` : this.o.board.t.quote(i.title)]));
    let started = 0;
    plan.forEach((p, n) => {
      const id = p.card;
      if (!still(id)) return before.add(id);
      const behind = p.waitsFor.filter((b) => before.has(b) && this.blocks(b));
      before.add(id);
      this.o.board.work(id, { scope: toJson({ files: p.files, reason: p.reason }), queue: toJson({ checking: true, together: key, since: times[n]! }) });
      const buildsOn = behind.filter((b) => p.buildsOn.includes(b));
      const reason = p.reason || (buildsOn.length ? t.buildsOn : t.likelyConflict);
      if (this.queueOrStart(id, behind, buildsOn, reason, `${project ? t.togetherStarts : t.freedStarts}${p.reason ? ` ${p.reason}` : ''}`, (b) => names.get(b))) started++;
    });
    if (project) this.o.board.log(key, 'state', 'coordinator', t.planned(started, plan.length));
  }

  /** Whether a card still holds others back: in progress, or waiting itself. */
  private blocks(id: string): boolean {
    const i = this.o.board.item(id);
    return !!i && (this.inProgress(i.repo).some((a) => a.id === id) || inQueue(i));
  }

  /** `begun`: it waited, started anyway or at work before, for a workspace or the canvas's agents (see `Wait`). */
  private startNow(cardId: string, why: string, begun?: boolean) {
    const since = this.o.board.item(cardId)?.queue?.since;
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.coordinator.says(why));
    this.launch(cardId, since, begun);
  }

  /**
   * Starts the card's worker. Without a free workspace the card waits for one, in its place in the
   * queue (`since`), and starts once one is free; any other failure is logged and leaves it planned.
   */
  private launch(cardId: string, since?: string, begun?: boolean) {
    const card = this.o.board.item(cardId);
    if (!card) return;
    const unheld = begun ? { begun: true as const } : {};
    if (this.o.paused?.()) {
      this.setQueue(cardId, { paused: true, ...unheld }, since);
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.coordinator.canvasPaused);
      return;
    }
    const refused = (e: unknown) => {
      const shortage = e instanceof BadRequest ? shortageOf(e.code) : undefined;
      if (!shortage) return this.o.board.log(cardId, 'error', 'obeya', messageOf(e), { code: e instanceof BadRequest ? e.code : undefined });
      this.setQueue(cardId, { workspace: shortage, ...unheld }, since);
      this.o.board.log(cardId, 'state', 'obeya', { none: this.o.board.t.coordinator.noWorkspace, dirty: this.o.board.t.coordinator.dirtyWorkspaces, slots: this.o.board.t.coordinator.noSlot }[shortage]);
    };
    try {
      // git makes its workspace ready in the background; what goes wrong there its card says itself, but that the clone
      // it took was not clean and no other is, which queues it as when there is none at once
      this.o.repoFor(card).workers.start(cardId).catch(refused);
    } catch (e) {
      refused(e);
    }
  }

  /** Queued cards start once nothing they wait for is in progress or queued any more. */
  private scheduleDrain() {
    if (this.draining || this.ended) return;
    this.draining = true;
    setTimeout(() => {
      this.draining = false;
      this.serial(() => this.drain());
    }, 0);
  }

  private drain() {
    const items = this.o.board.items();
    // a card queued behind another that waits itself holds on while that one waits, and once it
    // has started, until it has landed: a card started or judged again here stays in this set
    const active = new Set([...this.inProgress(), ...items.filter(inQueue)].map((i) => i.id));
    // the card waiting longest goes first: one queued later must not take its turn
    const waiting = queueOrder(items).filter(movable);
    // a repository whose workspaces are taken by a card waiting longer is not asked again
    const full = new Set<string | undefined>();
    // cards waiting for a clone on one machine (`near`) that has none: asked again after a while, as for a full repository
    let again = false;
    const paused = !!this.o.paused?.();
    // cards whose waits ended in this pass
    const freed: Item[] = [];
    // the owner's question to a finished card whose agent needs a full clone goes before queued cards
    for (const f of items.filter((i) => i.waitsForClone && !i.repoDown)) {
      const hands = this.o.repoFor(f);
      if (full.has(f.repo) || !hands.workspaces.leasable(true) || !hands.workers.takeClone(f.id)) full.add(f.repo);
    }
    for (const w of waiting) {
      // one whose repository does not run waits on until it is back; one giving up its workspace, until it has;
      // one let start, until the owner resumes the canvas's agents
      if (w.repoDown || this.giving.has(w.id)) continue;
      const begun = 'begun' in w.queue! && !!w.queue.begun;
      if (!('behind' in w.queue!)) {
        // an arrow the owner drew since it was let start holds it as one drawn before
        const drawn = drawnWaits(w, items);
        if (drawn.length) {
          this.setQueue(w.id, { behind: drawn, reason: this.o.board.t.coordinator.drawn, manualWait: drawn });
          this.logWait(w.id, [], '', drawn, (id) => this.nameOf(items.find((i) => i.id === id)!));
          continue;
        }
      }
      if ('paused' in w.queue!) {
        if (!paused) this.startNow(w.id, this.o.board.t.coordinator.canvasPlays, begun);
        continue;
      }
      if ('workspace' in w.queue!) {
        // the slots the paused agents freed are not for it: it waits for them to resume
        if (paused) {
          this.setQueue(w.id, { paused: true, ...(begun && { begun }) }, w.queue!.since);
          this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.coordinator.canvasPaused);
          continue;
        }
        // a card whose branch a clone keeps takes one on that clone's machine: none there leaves the others to the cards behind it
        const near = this.o.board.row(w.id).kept_in;
        if (full.has(w.repo) || !this.o.repoFor(w).workspaces.leasable(false, near)) {
          if (near) again = true;
          else full.add(w.repo);
          continue;
        }
        this.startNow(w.id, w.queue!.workspace === 'slots' ? this.o.board.t.coordinator.slotFree : this.o.board.t.coordinator.workspaceFree, begun);
        if (this.o.board.item(w.id)?.queue) full.add(w.repo);
        continue;
      }
      const q = w.queue as { behind: string[]; reason: string; buildsOn?: string[]; manualWait?: string[] };
      // a review card whose PR was closed without a merge leaves nothing to build on: what followed
      // up on it goes back to planned, for the owner to decide on
      const unmerged = items.find((i) => q.buildsOn?.includes(i.id) && i.state === 'done' && fromJson(this.o.board.row(i.id).contribution)?.closed);
      if (unmerged) {
        this.setQueue(w.id, null);
        this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.coordinator.reviewClosed(this.o.board.t.quote(unmerged.title)));
        continue;
      }
      // the waits the Coordinator inferred hold while what they wait for is in progress or queued, or
      // has not landed where it builds on it; the owner's arrows hold beside them while drawn, so
      // removing one leaves exactly the waits inferred
      const inferred = q.behind.filter((id) => !q.manualWait?.includes(id) && (active.has(id) || (q.buildsOn?.includes(id) && unlanded(items.find((i) => i.id === id)))));
      const manualWait = drawnWaits(w, items).filter((id) => !inferred.includes(id));
      const buildsOn = (q.buildsOn ?? []).filter((id) => inferred.includes(id));
      const still = [...inferred, ...manualWait];
      if (same(still, q.behind) && same(manualWait, q.manualWait ?? []) && same(buildsOn, q.buildsOn ?? [])) continue;
      if (still.length) {
        this.setQueue(w.id, { behind: still, reason: inferred.length ? q.reason : this.o.board.t.coordinator.drawn, ...(buildsOn.length && { buildsOn }), ...(manualWait.length && { manualWait }) });
        // an arrow the owner drew to it while it waited holds it too, which it says
        const drawnNow = manualWait.filter((id) => !q.behind.includes(id));
        if (drawnNow.length) this.logWait(w.id, [], '', drawnNow, (id) => this.nameOf(items.find((i) => i.id === id)!));
        continue;
      }
      freed.push(w);
    }
    // what it waited for is done; with nothing else running it starts, else it is judged again
    // against what runs now, which may have started after it was judged. Cards freed at once (the
    // follow-up tasks of a merged PR, say) are judged together: one may build on another, or
    // collide with it, whichever came first in the queue.
    for (const repo of new Set(freed.map((w) => w.repo))) {
      const group = freed.filter((w) => w.repo === repo);
      if (group.length > 1) {
        const key = `freed:${randomUUID()}`;
        for (const w of group) {
          this.setQueue(w.id, { checking: true, together: key });
          this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.coordinator.waitedDoneTogether);
        }
        this.serial(() => this.decideAll(key));
        continue;
      }
      const w = group[0]!;
      if (!this.inProgress(w.repo).length) {
        this.startNow(w.id, this.o.board.t.coordinator.waitedDone);
      } else {
        this.setQueue(w.id, { checking: true });
        this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.coordinator.waitedDoneRecheck);
        this.serial(() => this.decide(w.id));
      }
    }
    if ((full.size || again) && !this.recheck) {
      this.recheck = setTimeout(() => {
        this.recheck = undefined;
        this.scheduleDrain();
      }, RECHECK_MS);
      this.recheck.unref?.();
    }
  }

  // ---------------------------------------------------------------- naming

  /**
   * A card the owner left without a title (`nameless`) gets one from its text and screenshots, by a
   * short session; a title the owner types meanwhile stands. Without an answer the text's start
   * stands in.
   */
  name(cardId: string): Promise<void> {
    const card = this.o.board.item(cardId);
    if (!card || !nameless(card)) return Promise.resolve();
    let naming = this.naming.get(cardId);
    if (!naming) {
      naming = this.writeTitle(card)
        .then((title) => {
          const now = this.o.board.item(cardId);
          if (now && !now.title.trim() && title) this.o.board.patch(cardId, { title });
        })
        .finally(() => this.naming.delete(cardId));
      this.naming.set(cardId, naming);
    }
    return naming;
  }

  private async writeTitle(card: Item): Promise<string> {
    let title: string | null = null;
    await readSession(this.o.runtime, {
      // a title reads as well from the home repository while the card's does not run
      cwd: card.repoDown ? this.o.home() : this.o.repoFor(card).path,
      role: 'chores',
      onLimit: (until) => this.o.board.waitsForLimit({ card: card.id }, until),
      system: NAME_SYSTEM(this.language),
      tools: (finish) => [
        {
          name: 'title',
          description: `The card's title, in the language the task is written in (${this.language} where it tells none, as with screenshots alone).`,
          schema: { title: z.string() },
          run: (a) => {
            if (title !== null) return 'Already named.';
            title = oneLine(String(a.title)).slice(0, TITLE_MAX);
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: card.body.trim() ? `The task:\n${card.body.trim()}` : 'The task is in the screenshots alone (shown below).',
      images: this.o.imageFiles?.(card.images) ?? [],
    });
    return title || titleFrom(card.body);
  }

  // ---------------------------------------------------------------- the estimate

  /** `onLimit`: where the estimate shows that it waits for the usage limit. */
  private async estimate(card: Item, active: Item[], ahead: Item[], pending: Item[], onLimit: (until: number | undefined) => void): Promise<Scope> {
    let scope: Scope | undefined;
    const tags = new Map([...active, ...ahead, ...pending].map((a) => [cardTag(a.number), a.id]));
    // a conflict only with what runs or goes first; building on only a workstream of its project
    const running = new Set([...active, ...ahead].map((a) => a.id));
    const siblings = new Set([...active, ...ahead, ...pending].filter((a) => card.parent && a.parent === card.parent).map((a) => a.id));
    const ids = (list: unknown, among: Set<string>) =>
      (Array.isArray(list) ? list : []).map((t) => tags.get(String(t))).filter((x): x is string => !!x && among.has(x));
    const error = await readSession(this.o.runtime, {
      cwd: this.o.repoFor(card).path,
      role: 'coordinator',
      onLimit,
      system: this.o.repoFor(card).folder ? FOLDER_SYSTEM(this.language) : SYSTEM(this.language),
      tools: (finish) => [
        {
          name: 'scope',
          description: `Report the files the card will change, the cards in progress or queued ahead whose changes are likely to conflict with it on merge (their tags), the workstreams of its project it builds on (their tags), and a one-sentence reason in ${this.language}.`,
          schema: { files: z.array(z.string()), conflicts_with: z.array(z.string()), builds_on: z.array(z.string()).optional(), reason: z.string() },
          run: (a) => {
            if (scope) return 'Already reported.';
            scope = {
              files: (a.files as string[]).slice(0, 200),
              conflictsWith: ids(a.conflicts_with, running),
              buildsOn: ids(a.builds_on, siblings),
              reason: String(a.reason).slice(0, 500),
            };
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: await this.brief(card, active, ahead, pending),
    });
    if (!scope) throw new Error(error ?? 'no estimate');
    return scope;
  }

  /**
   * One turn over all the cards of a batch, a project's workstreams (`project`) or cards freed at
   * once: in which order they go, and which wait for what.
   */
  private async schedule(project: Item | undefined, batch: Item[], active: Item[], ahead: Item[]): Promise<Planned[]> {
    let plan: Planned[] | undefined;
    const tags = new Map([...active, ...ahead, ...batch].map((a) => [cardTag(a.number), a.id]));
    const hands = this.o.repoFor(batch[0]!);
    const noun = project ? 'workstream' : 'card';
    const error = await readSession(this.o.runtime, {
      cwd: hands.path,
      role: 'coordinator',
      // the cards the owner started wait with it
      onLimit: (until) => {
        for (const w of batch) this.o.board.waitsForLimit({ card: w.id }, until);
      },
      system: (hands.folder ? FOLDER_SCHEDULE_SYSTEM : SCHEDULE_SYSTEM)(this.language, !project),
      tools: (finish) => [
        {
          name: 'schedule',
          description: `Report every ${noun} once, in the order they should go: its tag, the files it will change, the tags of the ${noun}s it builds on and of the cards it would likely conflict with (both empty to start now), and a one-sentence reason in ${this.language}.`,
          schema: {
            workstreams: z.array(
              z.object({ card: z.string(), files: z.array(z.string()), builds_on: z.array(z.string()), conflicts_with: z.array(z.string()), reason: z.string() }),
            ),
          },
          run: (a) => {
            if (plan) return 'Already reported.';
            const mine = new Set(batch.map((w) => w.id));
            const seen = new Set<string>();
            const order: Planned[] = [];
            for (const w of a.workstreams as { card: string; files: string[]; builds_on: string[]; conflicts_with: string[]; reason: string }[]) {
              const id = tags.get(w.card);
              if (!id || !mine.has(id) || seen.has(id)) continue;
              seen.add(id);
              const ids = (list: string[]) => list.map((t) => tags.get(t)).filter((x): x is string => !!x && x !== id);
              const buildsOn = ids(w.builds_on);
              order.push({
                card: id,
                files: w.files.slice(0, 200),
                waitsFor: [...new Set([...buildsOn, ...ids(w.conflicts_with)])],
                buildsOn,
                reason: String(w.reason).slice(0, 500),
              });
            }
            const missing = batch.filter((w) => !seen.has(w.id));
            if (missing.length) return `Every ${noun} once, please: missing ${missing.map((w) => cardTag(w.number)).join(', ')}. Call schedule again with all of them.`;
            plan = order;
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        ...(project
          ? [
              ...projectHeader(project),
              `Its workstreams to schedule, in the plan's order:\n${batch.map((w) => `- ${cardTag(w.number)}: ${named(w)}${bodyCut(w, 600)}`).join('\n')}`,
            ]
          : [
              `The cards to schedule, freed at once, in their order in the queue, which the owner may have set: keep it where neither a dependency nor a likely conflict asks for another:\n${batch
                .map((w) => {
                  const of = w.parent ? this.o.board.item(w.parent) : undefined;
                  const where = of?.plan ? ` (workstream ${w.label ?? ''} of the project "${of.title}", plan doc ${of.plan.file})` : '';
                  return `- ${cardTag(w.number)}: ${w.kind} "${w.title}"${where}${bodyCut(w, 1500)}`;
                })
                .join('\n')}`,
            ]),
        ...(await this.others(batch[0]!, active, ahead)),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (!plan) throw new Error(error ?? 'no schedule');
    return plan;
  }

  private async brief(card: Item, active: Item[], ahead: Item[], pending: Item[]): Promise<string> {
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    const siblings = [...active, ...ahead].filter((a) => a.parent === card.parent).map((a) => cardTag(a.number));
    const lines = [
      `The card to start: ${card.kind} "${card.title}".`,
      card.body.trim(),
      project?.plan ? `It is workstream ${card.label ?? ''} of the project "${project.title}"; plan doc ${project.plan.file}.` : '',
      ...(await this.others(card, active, ahead)),
      siblings.length ? `Of these, workstreams of the same project: ${siblings.join(', ')}.` : '',
      pending.length
        ? `The project's other workstreams that have not landed, neither in progress nor queued ahead:\n${pending
            .map((w) => {
              const state = notStarted(w) ? (w.branch ? 'stopped by the owner, not running' : 'not started') : 'queued after this card';
              return `- ${cardTag(w.number)}: ${named(w)} (${state})${bodyCut(w, 300)}`;
            })
            .join('\n')}`
        : '',
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  /** The cards in progress and queued ahead, as a turn of the Coordinator reads them. */
  private async others(card: Item, active: Item[], ahead: Item[]): Promise<string[]> {
    const folder = !!this.o.repoFor(card).folder;
    // in a folder nothing is merged later: every path counts
    const soft = folder ? [] : this.o.repoFor(card).adapter.softPaths;
    const described = folder ? (c: Change) => `${c.file} (${c.regions[0] ?? 'changed'})` : describe;
    const hard = (f: string) => !soft.some((s) => overlaps(normalize(f), s));
    /** A card in progress or ahead: its tag, title and first line, and what it is expected to change. */
    const head = (a: Item) => [
      `- ${cardTag(a.number)}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}`,
      `  expected to change: ${(a.scope ?? []).filter(hard).join(', ') || '(no estimate)'}`,
    ];
    // git reads the branches side by side, without holding up the server
    const changes = await Promise.all(active.map((a) => this.o.repoFor(a).workspaces.changes(a.id)));
    return [
      active.length
        ? `Cards in progress:\n${active
            .map((a, n) => {
              const changed = changes[n]!.filter((c) => hard(c.file));
              return [
                ...head(a),
                `  changed so far: ${changed.length ? changed.slice(0, 60).map(described).join(', ') : '(nothing yet)'}`,
              ].join('\n');
            })
            .join('\n')}`
        : 'No cards are in progress.',
      ahead.length
        ? `Cards queued ahead of this one (they wait for others and start before this card):\n${ahead
            .map((a) => {
              const q = a.queue!;
              const waitsFor =
                'behind' in q ? q.behind.map((id) => `"${this.o.board.item(id)?.title ?? id}"`).join(', ') : 'workspace' in q ? 'a free workspace (its start is decided)' : 'paused' in q ? "the owner to resume the canvas's paused agents (its start is decided)" : '';
              return [
                ...head(a),
                `  waits for: ${waitsFor || 'your decision'}`,
              ].join('\n');
            })
            .join('\n')}`
        : '',
      soft.length ? `Changes under ${soft.join(', ')} never count: they are resolved when a branch lands.` : '',
    ];
  }

  // ---------------------------------------------------------------- helpers

  /** What it decides goes one after the other; what was still to come when its canvas stopped does not run. */
  private serial(fn: () => unknown) {
    this.queued++;
    this.chain = this.chain
      .then(() => (this.ended ? undefined : fn()))
      .catch((e) => console.error('Coordinator:', e))
      .finally(() => this.queued--);
  }

  /** Whether it has a decision still to come or under way, a look at the queue after a change of the board included: for tests, which wait for it. */
  get deciding(): boolean {
    return this.draining || this.queued > 0;
  }

  /** The repository of a card it was deciding on stopped running on the canvas: the card is planned again, for the owner to start once it is back. */
  private repoGone(card: Item) {
    this.setQueue(card.id, null);
    this.o.board.log(card.id, 'state', 'obeya', this.o.board.t.coordinator.repoDown(card.repo));
  }

  /** A card keeps the time it came to the Coordinator for as long as it stays queued. */
  private setQueue(cardId: string, q: Wait | null, keep?: string) {
    const since = keep ?? this.o.board.item(cardId)?.queue?.since ?? new Date().toISOString();
    this.o.board.work(cardId, { queue: q ? toJson({ ...q, since }) : null });
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

const NAME_SYSTEM = (language: string) => `You name a card on Obeya, a canvas on which the owner directs coding agents. The owner wrote the card's task (below) without a title. Give it one with the tool title: in the language the task is written in (${language} where it tells none), short and precise like a ticket title (at most about 70 characters), saying what the task changes or achieves; no quotes, no full stop at the end. Then end your turn.`;

const SYSTEM = (language: string) => `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. Your job here: before a card starts, estimate which files it will change, and judge whether running it next to the cards in progress is likely to end in merge conflicts. Only those keep it waiting, and for a workstream of a project what it builds on; everything else should run in parallel. Cards queued ahead of it count too: they came first and start before it, so a card likely to conflict with one of them waits behind it rather than overtaking it.

A workstream of a project builds on another workstream of it when it needs code, an API, data or a decision that the other one introduces, or the plan says it comes after it. It then waits until that one has landed, also when the owner has not started that one yet: the owner may start workstreams one by one, and starting this one now would build on what is not there. Read the plan doc for that.

Sharing a file is not a conflict. Git merges changes to different places of the same file cleanly: new strings, types, routes, tests or functions added next to others; edits in different functions. A conflict is likely when both cards change the same lines or the same function or block, when one rewrites, moves, renames or reformats code the other one edits, or when both change the same small, tightly packed section (one config entry, one signature that both extend). For a card in progress you see what it is expected to change and the places it has changed so far (line ranges in its branch, with the enclosing function); read the code there when you need to.

Read what you need in the repository (you cannot change files), then call scope exactly once:
- files: repository-relative paths the card will most likely change; a path ending in "/" stands for a directory. Be concrete; list new files where you expect them.
- conflicts_with: the tags of cards in progress or queued ahead whose changes will likely conflict with this card's on merge; empty when none. When in doubt, leave a card out: a conflict that happens anyway goes back to its worker to resolve.
- builds_on: for a workstream, the tags of the workstreams of its project it builds on, whether in progress, queued or not started; empty when none, and for any other card.
- reason: one sentence in ${language} for the owner: with a dependency, what it builds on; with a conflict, where the two cards change the same code; without either, which files they share, if any, and why that is fine. The owner does not know the tags: name cards by their title.
Keep it quick: this runs every time a card starts.
`.trim();

const FOLDER_SYSTEM = (language: string) => `
You are the Coordinator of Obeya, a canvas on which the owner directs agents; the owner knows you simply as Obeya. Several workers work at the same time, all directly in one folder that is not a git repository: what one changes is there at once for the others, and nothing is merged afterwards. Your job here: before a card starts, estimate which files and directories it will touch, and judge whether running it next to the cards in progress is likely to get in their way. Only those keep it waiting, and for a workstream of a project what it builds on; everything else should run in parallel. Cards queued ahead of it count too: they came first and start before it, so a card likely to collide with one of them waits behind it rather than overtaking it.

A workstream of a project builds on another workstream of it when it needs files, an overview, data or a decision that the other one makes, or the plan says it comes after it. It then waits until that one is done, also when the owner has not started that one yet: the owner may start workstreams one by one, and starting this one now would build on what is not there. Read the plan doc for that.

Working in the same directory is not a collision: cards that add or edit different files there run side by side. A collision is likely when both change, move, rename or delete the same files; when one moves, renames or reorganises a directory the other works in; or when one sorts or rewrites files the other creates or reads. For a card in progress you see what it is expected to touch and what it has changed so far (each path, and whether it was added, changed, moved or deleted); look in the folder when you need to.

Read what you need in the folder (you cannot change files), then call scope exactly once:
- files: paths relative to the folder that the card will most likely touch; a path ending in "/" stands for a directory. Be concrete; list new files where you expect them.
- conflicts_with: the tags of cards in progress or queued ahead it would likely collide with; empty when none. Leave out a card that only works beside it.
- builds_on: for a workstream, the tags of the workstreams of its project it builds on, whether in progress, queued or not started; empty when none, and for any other card.
- reason: one sentence in ${language} for the owner: with a dependency, what it builds on; with a collision, which files or directories both touch; without either, what they share, if anything, and why that is fine. The owner does not know the tags: name cards by their title.
Keep it quick: this runs every time a card starts.
`.trim();

const DEPS_SYSTEM = `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents. The owner wants the workstreams of a project arranged by what builds on what: what can start at once on the left, what builds on it to the right of it. Read the plan doc (and the repository only where the doc leaves it open; you cannot change files) and say for each open workstream which workstreams it builds on.

A workstream builds on another when it needs code, an API, data, a document or a decision that the other one introduces, or when the plan says it comes after it, needs it or waits for it. Name only direct dependencies: when C builds on B and B on A, C names B, not A. Two workstreams that merely touch the same files, or that the plan lists one after the other without saying one needs the other, do not build on each other. A workstream may build on a delivered one.

Call dependencies exactly once, with every open workstream once.
`.trim();

/**
 * What a joint turn decides on: the workstreams of a project the owner started at once, or cards
 * whose waits ended at once (`freed`).
 */
const batchOf = (freed: boolean, folder: boolean) =>
  freed
    ? {
        situation: `Several cards waited in the queue, and what they waited for ${folder ? 'is done' : 'has landed'} now, so they are free to start at the same time; you decide together how they go, so that none starts without regard to the others. Read their tasks and what you need in the ${folder ? 'folder' : 'repository'} (you cannot change files).`,
        noun: 'card',
        dependsOn: folder ? 'it builds on files, an overview, data or a decision that the other one makes' : 'it builds on code, an API, data or a decision that the other one introduces',
      }
    : {
        situation: `The owner started all open workstreams of a project at once; you decide how they go. Read the plan doc and what you need in the ${folder ? 'folder' : 'repository'} (you cannot change files).`,
        noun: 'workstream',
        dependsOn: folder
          ? 'it builds on files, an overview, data or a decision that the other one makes, or the plan says it comes after it'
          : 'it builds on code, an API, data or a decision that the other one introduces, or the plan says it comes after it',
      };

const FOLDER_SCHEDULE_SYSTEM = (language: string, freed: boolean) => {
  const b = batchOf(freed, true);
  return `
You are the Coordinator of Obeya, a canvas on which the owner directs agents; the owner knows you simply as Obeya. Several workers work at the same time, all directly in one folder that is not a git repository: what one changes is there at once for the others, and nothing is merged afterwards. ${b.situation}

A ${b.noun} waits for another when:
- it depends on it: ${b.dependsOn}. It then waits until that one is done.
- running both at once likely collides: both change, move, rename or delete the same files, one reorganises a directory the other works in, or one sorts or rewrites files the other creates or reads. Working in the same directory is not a collision.
Everything else starts now and runs in parallel; parallel work is the point. Cards in progress and queued ahead count as for any start: a ${b.noun} likely to collide with one of them waits for it.

Call schedule exactly once, with every ${b.noun} once, in the order they should go (what starts now first, then each one after what it waits for):
- card: its tag.
- files: paths relative to the folder it will most likely touch; a path ending in "/" stands for a directory.
- builds_on: the tags of the ${b.noun}s it depends on (in progress, queued ahead, or earlier in your order).
- conflicts_with: the tags of cards it would likely collide with: cards in progress, queued ahead, or ${b.noun}s earlier in your order.
Both empty: it starts now. A ${b.noun} that waits starts by itself once what it waits for is done.
- reason: one sentence in ${language} for the owner: why it waits (the dependency, or where the changes collide), or, starting now, why it can run beside the others. The owner does not know the tags: name cards by their label or title.
`.trim();
};

const SCHEDULE_SYSTEM = (language: string, freed: boolean) => {
  const b = batchOf(freed, false);
  return `
You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. ${b.situation}

A ${b.noun} waits for another when:
- it depends on it: ${b.dependsOn}. It then waits until that one has landed.
- running both at once likely ends in merge conflicts: both change the same lines or the same function or block, one rewrites, moves, renames or reformats code the other one edits, or both change the same small, tightly packed section. Sharing a file is not a conflict: changes in different places of a file merge cleanly.
Everything else starts now and runs in parallel; parallel work is the point. When in doubt about a conflict, let it run: a conflict that happens anyway goes back to its worker. Cards in progress and queued ahead count as for any start: a ${b.noun} likely to conflict with one of them waits for it.

Call schedule exactly once, with every ${b.noun} once, in the order they should go (what starts now first, then each one after what it waits for):
- card: its tag.
- files: repository-relative paths it will most likely change; a path ending in "/" stands for a directory.
- builds_on: the tags of the ${b.noun}s it depends on (in progress, queued ahead, or earlier in your order).
- conflicts_with: the tags of cards it would likely conflict with: cards in progress, queued ahead, or ${b.noun}s earlier in your order.
Both empty: it starts now. A ${b.noun} that waits starts by itself once what it waits for has landed.
- reason: one sentence in ${language} for the owner: why it waits (the dependency, or where the changes collide), or, starting now, why it can run beside the others. The owner does not know the tags: name cards by their label or title.
`.trim();
};

/** A changed file with the places changed in it: "src/a.ts (lines 12-20 in function f; 40)", or "(new)". */
const describe = (c: Change) =>
  `${c.file} (${c.regions.length ? (c.regions[0] === 'deleted' ? 'deleted' : `lines ${c.regions.slice(0, 8).join('; ')}${c.regions.length > 8 ? '; …' : ''}`) : 'new'})`;

/** A card waited on that still holds back what builds on it: there, and its work not on the main branch yet. */
const unlanded = (i?: Item) => !!i && !finished(i.state) && !i.archivedAt;
/** Whether two lists hold the same cards. */
const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** A project as a turn of the Coordinator reads it above its workstreams: its title and plan doc, and its goal (empty without one). */
const projectHeader = (project: Item) => [`The project: "${project.title}"${project.plan ? `; plan doc ${project.plan.file}` : ''}.`, project.plan?.goal ? `Goal: ${project.plan.goal}` : ''];

/** A workstream by its label and title, as a turn of the Coordinator reads it. */
const named = (w: Item) => `${w.label ? `${w.label} ` : ''}"${w.title}"`;

/** A card's body on one line, cut at `cut` characters, behind a dash; nothing without one. */
const bodyCut = (w: Item, cut: number) => (w.body ? ` — ${w.body.replace(/\s+/g, ' ').slice(0, cut)}` : '');

const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** Two paths overlap when they are equal or one is a directory (trailing `/`) containing the other. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
