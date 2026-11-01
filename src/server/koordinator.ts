// The Koordinator decides when a card may start: not while its changes are likely to conflict on
// merge with work in progress. It judges that from what each card will change (estimated before
// the start) and has changed so far (files and the places in them); sharing a file is not enough.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { inQueue, movable, notStarted, queueOrder, reach, waitsOn } from '../core/queue';
import { type AgentRole, type CardEvent, EVICT_HOLD_MS, finished, type Item, nameless, type Preference, START_ALL_HOLD_MS, titleFrom, type Wait } from '../core/types';
import { ACTIVE, BadRequest, type Board } from './board';
import type { Utterance } from './db';
import { type AgentRuntime, type AgentTool, waitQuietly } from './runtime';
import type { Workers } from './workers';
import { type CardWorkspaces, type Change, RECHECK_MS, shortageOf } from './workspaces';
import { LANGUAGE_NAMES } from '../core/locale';
import { clip, messageOf } from '../core/text';

/** A workstream as the Koordinator scheduled it, in its turn's order. */
interface Planned {
  card: string;
  files: string[];
  waitsFor: string[];
  /** Those of `waitsFor` it builds on. */
  buildsOn: string[];
  reason: string;
}

/**
 * What the owner said that may hold a lasting preference: to a worker (answer, note, feedback), in
 * an idea's discussion, to the Koordinator in conversation (a command it carried out, or a question
 * or remark it replied to), or in the text of a card they wrote.
 */
export type OwnerInput = 'answer' | 'note' | 'feedback' | 'idea' | 'command' | 'talk' | 'card';

/** What the learner reads an input with. */
export interface InputContext {
  /** The question the owner answered. */
  question?: string;
  /** The Koordinator's reply to what the owner said to it. */
  reply?: string;
  /** The card's text before the owner wrote in it: a proposal's, a follow-up's. */
  before?: string;
}

export interface Scope {
  files: string[];
  /** Cards in progress or queued ahead whose changes the Koordinator expects to conflict with this card's on merge. */
  conflictsWith: string[];
  /** Workstreams of its project it builds on: they hold it until they have landed, also while not started. */
  buildsOn: string[];
  reason: string;
}

/** What the Koordinator needs of the repository a card belongs to. */
export interface RepoHands {
  workers: Workers;
  workspaces: CardWorkspaces;
  adapter: RepoAdapter;
  /** Where the Koordinator reads (scopes, questions): the repository's Lesestand. */
  path: string;
  /** A folder without git: its cards all work in the folder itself, with no branches to merge. */
  folder?: boolean;
}

export interface KoordinatorOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The repository of a card; a canvas may span several. */
  repoFor: (card: Item) => RepoHands;
  /** Where the Koordinator reads for what the owner says without a card: the home repository's Lesestand. */
  home: () => string;
  /** Whether the owner paused the canvas's agents: a card the Koordinator lets start waits until they resume them (`{ paused }` in its queue). */
  paused?: () => boolean;
  /** How long a project's start, or taking a card's workspace, waits for the owner to take it back; START_ALL_HOLD_MS and EVICT_HOLD_MS by default. */
  holdMs?: number;
  /** After how many of the owner's inputs the Rückschau runs; REVIEW_EVERY by default. */
  reviewEvery?: number;
  /** The files of screenshots by their ids. */
  imageFiles?: (ids?: string[]) => string[];
}

export class Koordinator {
  /** The language its agents write the owner in: the owner's conversation language, since no words of the owner's go to them. */
  private get language() {
    return LANGUAGE_NAMES[this.o.board.conversation()];
  }

  /** Decisions to start are taken one at a time, so two colliding cards cannot both slip through. */
  private chain: Promise<unknown> = Promise.resolve();
  private learning: Promise<unknown> = Promise.resolve();
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

  constructor(private o: KoordinatorOptions) {
    o.board.onChange(() => {
      this.scheduleDrain();
      this.readPendingDeps();
    });
  }

  /** After a restart: decide again on cards the Koordinator was checking, and start what is free. */
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
      // queued at once, so that a card waiting behind it for a likely conflict keeps waiting
      const active = now.state !== 'planned';
      if (active && !now.queue) {
        this.setQueue(cardId, { workspace: 'none' });
        this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.koordinator.requeued);
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
   * All planned workstreams of the project go to the Koordinator together (those snoozed to start later too: the owner starts them now): one turn sees them all
   * with the plan doc and decides which start now and which wait, for a dependency or a likely
   * conflict, and in which order. They queue in the plan's order until it has, and the turn waits a
   * few seconds, so the owner can take the start back (`dequeue` on the project).
   */
  private requestAll(project: Item): void {
    const open = this.o.board.items().filter((i) => i.parent === project.id && i.state === 'planned' && !i.queue);
    if (!open.length) throw new BadRequest('nothingToStart', 'the project has no planned workstream left to start');
    // one the owner set aside to start later goes with them, so a workstream building on it waits for it
    for (const w of open) if (w.snoozed?.start) this.o.board.unsnooze(w.id, 'owner');
    const now = Date.now();
    open.forEach((w, n) => this.o.board.work(w.id, { queue: JSON.stringify({ checking: true, together: project.id, since: new Date(now + n).toISOString() }) }));
    this.o.board.log(project.id, 'state', 'owner', this.o.board.t.koordinator.allStarted(open.map((w) => w.label ?? w.title).join(', ')));
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
        this.o.board.log(projectId, 'error', 'obeya', this.o.board.t.koordinator.arrangeFailed(messageOf(e)));
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
    const tags = new Map(kids.map((k, n) => [`K${n + 1}`, k.id]));
    let on: Record<string, string[]> | undefined;
    const error = await readSession(this.o.runtime, {
      cwd: this.o.repoFor(project).path,
      role: 'koordinator',
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
            if (missing.length) return `Every open workstream once, please: missing ${missing.map((k) => tagOf(tags, k.id)).join(', ')}. Call dependencies again with all of them.`;
            on = found;
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        `The project: "${project.title}"${project.plan ? `; plan doc ${project.plan.file}` : ''}.`,
        project.plan?.goal ? `Goal: ${project.plan.goal}` : '',
        `Its workstreams, in the plan's order:\n${kids
          .map((k) => `- ${tagOf(tags, k.id)}${finished(k.state) ? ' (delivered)' : ''}: ${k.label ? `${k.label} ` : ''}"${k.title}"${k.body ? ` — ${k.body.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`)
          .join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (!on) throw new Error(error ?? 'no dependencies');
    return on;
  }

  /** The workstreams of a project's start that the Koordinator has not planned yet. */
  private unplanned(projectId: string): Item[] {
    return this.o.board
      .snapshot()
      .items.filter((i) => i.parent === projectId && i.state === 'planned' && i.queue && 'checking' in i.queue && i.queue.together === projectId)
      .sort((a, b) => a.queue!.since.localeCompare(b.queue!.since));
  }

  /** Start a queued card anyway. */
  force(cardId: string) {
    const card = this.card(cardId);
    if (!card.queue || !('behind' in card.queue)) throw new BadRequest('notQueued', 'the card is not waiting');
    const since = card.queue.since;
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.koordinator.startedDespite);
    this.launch(cardId, since);
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
    this.o.board.log(cardId, 'state', 'owner', (earlier ? t.koordinator.movedBefore : t.koordinator.movedAfter)(past.title));
  }

  dequeue(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') {
      // the start of all its workstreams, taken back before the Koordinator planned them
      const back = this.unplanned(cardId);
      if (!back.length) throw new BadRequest('notQueued', 'no workstream of the project waits to be planned');
      for (const w of back) this.setQueue(w.id, null);
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.koordinator.startTakenBack(back.map((w) => w.label ?? w.title).join(', ')));
      return;
    }
    if (!card.queue) throw new BadRequest('notQueued', 'the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.koordinator.dequeued);
  }

  /**
   * The owner said something (to a worker, in an idea, to the Koordinator, in a card's text): if it
   * states a lasting preference, propose it as a rule for every agent; the owner accepts it in the
   * sheet. `card` is the card it concerns, or the one open; none in a conversation without one.
   * Runs in the background, one at a time.
   */
  learn(card: Item | null, kind: OwnerInput, text: string, context: InputContext = {}) {
    // what surrounded the input is read now: by its turn, the agent may have answered it
    const around = this.around(card, kind, text, context);
    this.learning = this.learning.then(() => this.distill(card, kind, text, context, around)).catch((e) => console.error('Koordinator (learning):', e));
    this.noticed();
  }

  /**
   * The owner said something, or clicked without words (a start, an approval, a dismissed
   * proposal): every `reviewEvery` of these, the Rückschau reads the history since the last one,
   * after the learner has read the input that completed the count. The count is a setting of the
   * canvas, so it survives a restart.
   */
  noticed() {
    const b = this.o.board;
    // the first input counted starts the history; it was logged a moment ago
    if (!b.setting(REVIEW_SINCE)) b.setSetting(REVIEW_SINCE, new Date(Date.now() - 60_000).toISOString());
    const count = Number(b.setting(REVIEW_COUNT) ?? 0) + 1;
    if (count < (this.o.reviewEvery ?? REVIEW_EVERY)) return b.setSetting(REVIEW_COUNT, String(count));
    const since = b.setting(REVIEW_SINCE)!;
    b.setSetting(REVIEW_COUNT, '0');
    b.setSetting(REVIEW_SINCE, new Date().toISOString());
    this.learning = this.learning.then(() => this.review(since)).catch((e) => console.error('Koordinator (Rückschau):', e));
  }

  /** The Rückschau: one session reads what happened since `since` and proposes rules for patterns across cards. */
  private async review(since: string): Promise<void> {
    const history = this.history(since);
    if (!history.length) return;
    const rules = this.o.board.preferences('active');
    let proposed = 0;
    await readSession(this.o.runtime, {
      cwd: this.o.home(),
      role: 'koordinator',
      onLimit: waitQuietly,
      system: REVIEW_SYSTEM(this.language),
      tools: (finish): AgentTool[] => [
        {
          name: 'propose',
          description: `Propose a rule to the owner: one short rule in ${this.language}, and why (one short sentence in ${this.language}, under 150 characters, naming what in the history it rests on). Pass replaces with the number of a recorded rule it refines or contradicts. ${REPOS_PARAM}`,
          schema: { rule: z.string(), why: z.string(), replaces: z.number().int().optional(), repos: z.array(z.string()).optional() },
          run: ({ rule, why, replaces, repos }) => {
            const r = String(rule).trim().slice(0, 500);
            if (!r) return 'Empty rule ignored.';
            if (proposed >= REVIEW_PROPOSALS) return finish(`At most ${REVIEW_PROPOSALS} proposals. End your turn now.`);
            const targets = this.targets(repos);
            if (typeof targets === 'string') return targets;
            const fresh = targets.filter((t) => !this.o.board.preferences('proposed').some((p) => p.text === r && p.target === t));
            if (!fresh.length) return 'Already proposed.';
            const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
            for (const t of fresh) this.o.board.proposePreference(r, { review: true, quote: String(why ?? '') }, old?.id, t);
            proposed++;
            return proposed < REVIEW_PROPOSALS ? 'Proposed.' : finish('Proposed. That was the last one; end your turn now.');
          },
        },
        { name: 'done', description: 'Nothing (more) to propose.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
      brief: [`What happened on the canvas since the last Rückschau, oldest first:\n${history.join('\n')}`, ...this.rules(null)].filter(Boolean).join('\n\n'),
    });
  }

  /**
   * What the Rückschau reads, oldest first, at most the latest REVIEW_HISTORY lines: the cards'
   * milestones (the owner's notes, answers and clicks, the agents' questions and hand-overs, answers
   * given in the owner's name), the owner's words in ideas and to the Koordinator (taken back or
   * not), the cards they deleted or dismissed, and the rule proposals they decided on.
   */
  private history(since: string): string[] {
    const b = this.o.board;
    const title = (id?: string) => (id ? b.item(id)?.title : undefined);
    const lines: { at: string; text: string }[] = [
      ...b.timeline(since, REVIEW_HISTORY).flatMap((m) => {
        const t = title(m.cardId);
        if (!t) return [];
        const who = m.kind === 'answer' && m.author !== 'owner' ? `${WHO[m.author]}, in the owner's name,` : WHO[m.author];
        const what = m.kind === 'created' ? (m.author === 'owner' ? 'the owner created the card' : 'an agent proposed the card') : `${who}${STEPS[m.kind] ?? ' '}${clip(m.text, 300)}`;
        return [{ at: m.at, text: `"${t}": ${what}` }];
      }),
      ...b
        .utterances(since, REVIEW_HISTORY)
        .filter((u) => u.kind === 'talk')
        .map((u) => ({ at: u.at, text: `"${u.title ?? ''}": the owner in the idea's discussion: ${clip(u.text, 300)}` })),
      ...b
        .talk(REVIEW_HISTORY)
        .filter((t) => t.at > since && t.reply !== undefined)
        .map((t) => {
          const open = title(t.cardId);
          return {
            at: t.at,
            text: `the owner to you${open ? ` (with "${open}" open)` : ''}: ${clip(t.said, 300)} → ${clip(t.reply!, 200)}${t.undone ? ' (the owner took it back)' : ''}`,
          };
        }),
      ...b.removed(since).map((r) => ({
        at: r.at,
        text: r.state === 'proposal' ? `the owner dismissed the card an agent proposed: "${r.title}"` : `the owner deleted the card "${r.title}" (${r.state})`,
      })),
      ...b.decidedProposals(since).map((p) => ({
        at: p.at,
        text: `the owner ${p.state === 'rejected' ? 'rejected' : 'accepted'} the proposed rule "${p.text}"${p.state === 'filed' ? ` for the CLAUDE.md of ${p.target}` : ''}${p.quote ? ` (its occasion: ${clip(p.quote, 200)})` : ''}`,
      })),
    ];
    return lines
      .sort((x, y) => x.at.localeCompare(y.at))
      .slice(-REVIEW_HISTORY)
      .map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')} ${l.text}`);
  }

  /**
   * What the learner and the Rückschau read about the rules: the canvas's repositories, the active
   * rules (numbered, for `replaces`), the rules on their way into a CLAUDE.md, and the proposals
   * waiting or rejected.
   */
  private rules(card: Item | null): string[] {
    const b = this.o.board;
    const repo = card?.repo ?? b.home;
    const rules = b.preferences('active');
    const where = (p: Preference) => (p.target ? ` (for the CLAUDE.md of ${p.target})` : '');
    const list = (ps: Preference[]) => ps.map((p) => `- ${p.text}${where(p)}`).join('\n');
    const [open, filed, rejected] = [b.preferences('proposed'), b.preferences('filed'), b.preferences('rejected')];
    return [
      `The canvas's repositories (ids for repos):\n${b.canvas.repos.map((r) => `- ${r.id}: ${r.name}, at ${r.path}${r.id === repo ? (card ? " (the card's)" : ' (the home repository)') : ''}`).join('\n')}`,
      rules.length ? `Rules recorded so far:\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}` : 'No rules recorded so far.',
      filed.length ? `Rules the owner accepted for a repository's CLAUDE.md (in it or on their way; do not propose them again):\n${list(filed)}` : '',
      open.length ? `Proposals waiting for the owner (do not propose them again):\n${list(open)}` : '',
      rejected.length ? `Proposals the owner rejected (do not propose them again):\n${list(rejected)}` : '',
    ];
  }

  /** The repositories a proposal is for (none: the preference memory), or why they are not the canvas's. */
  private targets(repos: unknown): (string | undefined)[] | string {
    const ids = Array.isArray(repos) ? [...new Set(repos.map(String).filter(Boolean))] : [];
    const known = this.o.board.canvas.repos.map((r) => r.id);
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length) return `Unknown repository ${unknown.join(', ')}; the canvas has ${known.join(', ')}. Call propose again.`;
    return ids.length ? ids : [undefined];
  }

  /** What the learner reads an input in: the card's text, the agent's last message before it, what the owner said in the last days. */
  private around(card: Item | null, kind: OwnerInput, text: string, { question }: InputContext): string[] {
    // a card deleted meanwhile has no log to read
    const events = card && this.o.board.item(card.id) ? this.o.board.events(card.id) : [];
    // the newest first; a question the owner answered is shown as such
    const said = question ? undefined : events.find((e) => AGENTS.includes(e.author) && SAYS.includes(e.kind));
    const recent = this.o.board.utterances(new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString(), RECENT_UTTERANCES + 1);
    // the input itself is among them, as the newest with its words (a card's text is not)
    const self = recent.findLastIndex((u) => u.text === text);
    if (self >= 0) recent.splice(self, 1);
    return [
      card?.body && kind !== 'card' ? `The card's text:\n${clip(card.body, 1500)}` : '',
      recent.length
        ? `What the owner said in the last ${RECENT_DAYS} days, oldest first:\n${recent
            .slice(-RECENT_UTTERANCES)
            .map((u) => `- ${u.at.slice(0, 10)}, ${UTTERED[u.kind]}${u.title ? ` on "${u.title}"` : ''}: ${clip(u.text, 300)}`)
            .join('\n')}`
        : '',
      said ? `The ${said.author === 'explorer' ? 'idea agent' : 'agent'}'s last message on the card before it:\n${clip(said.text, 1500)}` : '',
    ];
  }

  private async distill(card: Item | null, kind: OwnerInput, text: string, context: InputContext, around: string[]): Promise<void> {
    const rules = this.o.board.preferences('active');
    const open = this.o.board.preferences('proposed');
    const { question, reply, before } = context;
    let proposed = false;
    await readSession(this.o.runtime, {
      cwd: card && !card.repoDown ? this.o.repoFor(card).path : this.o.home(),
      role: 'koordinator',
      onLimit: waitQuietly,
      system: LEARN_SYSTEM(this.language),
      tools: (finish): AgentTool[] => [
        {
          name: 'propose',
          description: `Propose a lasting preference to the owner as one short rule in ${this.language}. Pass replaces with the number of a recorded rule it refines or contradicts. ${REPOS_PARAM}`,
          schema: { rule: z.string(), replaces: z.number().int().optional(), repos: z.array(z.string()).optional() },
          run: ({ rule, replaces, repos }) => {
            const r = String(rule).trim().slice(0, 500);
            if (!r) return finish('Empty rule ignored.');
            if (proposed) return finish('One proposal per input. End your turn now.');
            const targets = this.targets(repos);
            if (typeof targets === 'string') return targets;
            const fresh = targets.filter((t) => !open.some((p) => p.text === r && p.target === t));
            if (!fresh.length) return finish('Already proposed. End your turn now.');
            const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
            for (const t of fresh) this.o.board.proposePreference(r, { ...(card ? { cardId: card.id } : {}), quote: text }, old?.id, t);
            proposed = true;
            if (card) this.o.board.log(card.id, 'state', 'koordinator', this.o.board.t.koordinator.proposes(r));
            return finish('Proposed. End your turn now.');
          },
        },
        { name: 'nothing', description: 'Nothing lasting to record.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
      brief: [
        card ? `Card${kind === 'talk' || kind === 'command' ? ' the owner had open' : ''}: ${card.kind === 'project' ? 'project ' : ''}"${card.title}".` : '',
        ...around,
        question ? `The worker asked: ${question}` : '',
        before ? `Before the owner wrote in it, the card's text read:\n${before}` : '',
        `The owner's ${INPUTS[kind]}: ${text}`,
        reply ? `You replied: ${reply}` : '',
        ...this.rules(card),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
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
    return notStarted(i) ? t.koordinator.notStarted(name) : name;
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
      // nothing it could collide with or build on: start at once, and estimate the scope for the cards after it
      this.startNow(cardId, this.o.board.t.koordinator.nothingRuns);
      if (this.o.board.item(cardId)?.state !== 'working') return;
      try {
        const scope = await this.estimate(card, [], [], [], waitQuietly);
        this.o.board.work(cardId, { scope: JSON.stringify({ files: scope.files, reason: scope.reason }) });
      } catch {}
      return;
    }
    let scope: Scope;
    try {
      scope = await this.estimate(card, active, ahead, pending, (until) => this.o.board.waitsForLimit({ card: cardId }, until));
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.koordinator.estimateFailed(messageOf(e)));
      scope = { files: [], conflictsWith: [], buildsOn: [], reason: '' };
    }
    const now = this.o.board.item(cardId);
    if (!now?.queue) return;
    // its repository stopped running while the Koordinator read
    if (now.repoDown) return this.repoGone(now);
    this.o.board.work(cardId, { scope: JSON.stringify({ files: scope.files, reason: scope.reason }) });
    // the workstreams it builds on, and the cards in progress or queued ahead whose changes it
    // expects to conflict with the card's
    const behind = [...active, ...ahead, ...pending].filter((a) => scope.buildsOn.includes(a.id) || scope.conflictsWith.includes(a.id)).map((a) => a.id);
    const t = this.o.board.t.koordinator;
    if (!behind.length) return this.startNow(cardId, `${t.noConflict}${scope.reason ? ` ${scope.reason}` : ''}`);
    const names = behind
      .map((id) => {
        const a = ahead.find((x) => x.id === id);
        return a ? t.waitsAhead(a.title) : this.nameOf([...active, ...pending].find((x) => x.id === id)!);
      })
      .join(', ');
    const buildsOn = behind.filter((id) => scope.buildsOn.includes(id));
    const reason = scope.reason || (buildsOn.length ? t.buildsOn : t.likelyConflict);
    this.setQueue(cardId, { behind, reason, ...(buildsOn.length && { buildsOn }) });
    this.o.board.log(cardId, 'state', 'obeya', t.waitsFor(names, reason));
  }

  /** Decides on the workstreams of a project that came to the Koordinator together. */
  private async decideAll(projectId: string) {
    const items = this.o.board.items();
    const batch = this.unplanned(projectId);
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
    // what waits already came first, as for a single card, unless it waits for one of them
    const ahead = items
      .filter((i) => i.repo === repo && !ids.has(i.id) && inQueue(i) && !batch.some((w) => waitsOn(i, w.id, items)))
      .sort((a, b) => a.queue!.since.localeCompare(b.queue!.since));
    let plan: Planned[];
    try {
      plan = await this.schedule(this.o.board.item(projectId)!, batch, active, ahead);
    } catch (e) {
      // judged one by one instead, each seeing the others it may build on
      this.o.board.log(projectId, 'error', 'obeya', this.o.board.t.koordinator.togetherFailed(messageOf(e)));
      for (const w of batch) {
        this.setQueue(w.id, { checking: true });
        this.serial(() => this.decide(w.id));
      }
      return;
    }
    if (this.o.board.item(projectId)?.repoDown) return this.unplanned(projectId).forEach((w) => this.repoGone(w));
    // taken out of the queue or started anyway meanwhile
    const still = (id: string) => {
      const q = this.o.board.item(id)?.queue;
      return !!q && 'checking' in q && q.together === projectId;
    };
    // the turn's order becomes the queue's: a workstream waits only for what comes before it, so
    // none wait for each other
    const times = batch.map((w) => w.queue!.since!);
    const before = new Set([...active, ...ahead].map((i) => i.id));
    const names = new Map([...active, ...ahead, ...batch].map((i) => [i.id, i.parent === projectId && i.label ? `${i.label} ${this.o.board.t.quote(i.title)}` : this.o.board.t.quote(i.title)]));
    let started = 0;
    plan.forEach((p, n) => {
      const id = p.card;
      if (!still(id)) return before.add(id);
      const behind = p.waitsFor.filter((b) => before.has(b) && this.blocks(b));
      before.add(id);
      this.o.board.work(id, { scope: JSON.stringify({ files: p.files, reason: p.reason }), queue: JSON.stringify({ checking: true, together: projectId, since: times[n] }) });
      if (!behind.length) {
        started++;
        return this.startNow(id, `${this.o.board.t.koordinator.togetherStarts}${p.reason ? ` ${p.reason}` : ''}`);
      }
      const buildsOn = behind.filter((b) => p.buildsOn.includes(b));
      const reason = p.reason || (buildsOn.length ? this.o.board.t.koordinator.buildsOn : this.o.board.t.koordinator.likelyConflict);
      this.setQueue(id, { behind, reason, ...(buildsOn.length && { buildsOn }) });
      this.o.board.log(id, 'state', 'obeya', this.o.board.t.koordinator.waitsFor(behind.map((b) => names.get(b) ?? b).join(', '), reason));
    });
    this.o.board.log(projectId, 'state', 'koordinator', this.o.board.t.koordinator.planned(started, plan.length));
  }

  /** Whether a card still holds others back: in progress, or waiting itself. */
  private blocks(id: string): boolean {
    const i = this.o.board.item(id);
    return !!i && (this.inProgress(i.repo).some((a) => a.id === id) || inQueue(i));
  }

  private startNow(cardId: string, why: string) {
    const card = this.o.board.item(cardId);
    const since = card?.queue?.since;
    const items = this.o.board.snapshot().items;
    const manual = (card?.manualDependsOn ?? []).filter((id) => unlanded(items.find((i) => i.id === id)));
    if (manual.length) {
      this.setQueue(cardId, { behind: manual, buildsOn: manual, manualWait: manual, reason: this.o.board.t.koordinator.buildsOn }, since);
      return;
    }
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.koordinator.says(why));
    this.launch(cardId, since);
  }

  /**
   * Starts the card's worker. Without a free workspace the card waits for one, in its place in the
   * queue (`since`), and starts once one is free; any other failure is logged and leaves it planned.
   */
  private launch(cardId: string, since?: string) {
    const card = this.o.board.item(cardId);
    if (!card) return;
    if (this.o.paused?.()) {
      this.setQueue(cardId, { paused: true }, since);
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.koordinator.canvasPaused);
      return;
    }
    const refused = (e: unknown) => {
      const shortage = e instanceof BadRequest ? shortageOf(e.code) : undefined;
      if (!shortage) return this.o.board.log(cardId, 'error', 'obeya', messageOf(e), { code: e instanceof BadRequest ? e.code : undefined });
      this.setQueue(cardId, { workspace: shortage }, since);
      this.o.board.log(cardId, 'state', 'obeya', { none: this.o.board.t.koordinator.noWorkspace, dirty: this.o.board.t.koordinator.dirtyWorkspaces, slots: this.o.board.t.koordinator.noSlot }[shortage]);
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
    if (this.draining) return;
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
    // the owner's question to a finished card whose agent needs a full clone goes before queued cards
    for (const f of items.filter((i) => i.waitsForClone && !i.repoDown)) {
      const hands = this.o.repoFor(f);
      if (full.has(f.repo) || !hands.workspaces.leasable(true) || !hands.workers.takeClone(f.id)) full.add(f.repo);
    }
    for (const w of waiting) {
      // one whose repository does not run waits on until it is back; one giving up its workspace, until it has;
      // one let start, until the owner resumes the canvas's agents
      if (w.repoDown || this.giving.has(w.id)) continue;
      if ('paused' in w.queue!) {
        if (!paused) this.startNow(w.id, this.o.board.t.koordinator.canvasPlays);
        continue;
      }
      if ('workspace' in w.queue!) {
        // the slots the paused agents freed are not for it: it waits for them to resume
        if (paused) {
          this.setQueue(w.id, { paused: true }, w.queue!.since);
          this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.koordinator.canvasPaused);
          continue;
        }
        // a card whose branch a clone keeps takes one on that clone's machine: none there leaves the others to the cards behind it
        const near = this.o.board.row(w.id).kept_in;
        if (full.has(w.repo) || !this.o.repoFor(w).workspaces.leasable(false, near)) {
          if (near) again = true;
          else full.add(w.repo);
          continue;
        }
        this.startNow(w.id, w.queue!.workspace === 'slots' ? this.o.board.t.koordinator.slotFree : this.o.board.t.koordinator.workspaceFree);
        if (this.o.board.item(w.id)?.queue) full.add(w.repo);
        continue;
      }
      const q = w.queue as { behind: string[]; reason: string; buildsOn?: string[]; manualWait?: string[] };
      const manual = (w.manualDependsOn ?? []).filter((id) => unlanded(items.find((i) => i.id === id)));
      const inferred = q.behind.filter((id) => !q.manualWait?.includes(id));
      const manualOnly = manual.filter((id) => !inferred.includes(id));
      const still = [...new Set([...inferred.filter((id) => active.has(id) || (q.buildsOn?.includes(id) && unlanded(items.find((i) => i.id === id)))), ...manual])];
      if (still.length === q.behind.length && still.every((id) => q.behind.includes(id)) && manualOnly.length === (q.manualWait?.length ?? 0) && manualOnly.every((id) => q.manualWait?.includes(id))) continue;
      if (still.length) {
        const buildsOn = [...new Set([...(q.buildsOn ?? []).filter((id) => still.includes(id) && !q.manualWait?.includes(id)), ...manual])];
        this.setQueue(w.id, { behind: still, reason: q.reason, ...(buildsOn.length && { buildsOn }), ...(manualOnly.length && { manualWait: manualOnly }) });
        continue;
      }
      // what it waited for is done; with nothing else running it starts, else it is judged again
      // against what runs now, which may have started after it was judged
      if (!this.inProgress(w.repo).length) {
        this.startNow(w.id, this.o.board.t.koordinator.waitedDone);
        active.add(w.id);
      } else {
        this.setQueue(w.id, { checking: true });
        this.o.board.log(w.id, 'state', 'obeya', this.o.board.t.koordinator.waitedDoneRecheck);
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
            title = String(a.title).replace(/\s+/g, ' ').trim().slice(0, 200);
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
    const tags = new Map([...active, ...ahead, ...pending].map((a, n) => [`K${n + 1}`, a.id]));
    // a conflict only with what runs or goes first; building on only a workstream of its project
    const running = new Set([...active, ...ahead].map((a) => a.id));
    const siblings = new Set([...active, ...ahead, ...pending].filter((a) => card.parent && a.parent === card.parent).map((a) => a.id));
    const ids = (list: unknown, among: Set<string>) =>
      (Array.isArray(list) ? list : []).map((t) => tags.get(String(t))).filter((x): x is string => !!x && among.has(x));
    const error = await readSession(this.o.runtime, {
      cwd: this.o.repoFor(card).path,
      role: 'koordinator',
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
      brief: await this.brief(card, active, ahead, pending, tags),
    });
    if (!scope) throw new Error(error ?? 'no estimate');
    return scope;
  }

  /** One turn over all the workstreams: in which order they go, and which wait for what. */
  private async schedule(project: Item, batch: Item[], active: Item[], ahead: Item[]): Promise<Planned[]> {
    let plan: Planned[] | undefined;
    const tags = new Map([...active, ...ahead, ...batch].map((a, n) => [`K${n + 1}`, a.id]));
    const error = await readSession(this.o.runtime, {
      cwd: this.o.repoFor(project).path,
      role: 'koordinator',
      // the workstreams the owner started wait with it
      onLimit: (until) => {
        for (const w of batch) this.o.board.waitsForLimit({ card: w.id }, until);
      },
      system: this.o.repoFor(project).folder ? FOLDER_SCHEDULE_SYSTEM(this.language) : SCHEDULE_SYSTEM(this.language),
      tools: (finish) => [
        {
          name: 'schedule',
          description: `Report every workstream once, in the order they should go: its tag, the files it will change, the tags of the workstreams it builds on and of the cards it would likely conflict with (both empty to start now), and a one-sentence reason in ${this.language}.`,
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
            if (missing.length) return `Every workstream once, please: missing ${missing.map((w) => tagOf(tags, w.id)).join(', ')}. Call schedule again with all of them.`;
            plan = order;
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        `The project: "${project.title}"${project.plan ? `; plan doc ${project.plan.file}` : ''}.`,
        project.plan?.goal ? `Goal: ${project.plan.goal}` : '',
        `Its workstreams to schedule, in the plan's order:\n${batch
          .map((w) => `- ${tagOf(tags, w.id)}: ${w.label ? `${w.label} ` : ''}"${w.title}"${w.body ? ` — ${w.body.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`)
          .join('\n')}`,
        ...(await this.others(project, active, ahead, tags)),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (!plan) throw new Error(error ?? 'no schedule');
    return plan;
  }

  private async brief(card: Item, active: Item[], ahead: Item[], pending: Item[], tags: Map<string, string>): Promise<string> {
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    const siblings = [...active, ...ahead].filter((a) => a.parent === card.parent).map((a) => tagOf(tags, a.id));
    const lines = [
      `The card to start: ${card.kind} "${card.title}".`,
      card.body.trim(),
      project?.plan ? `It is workstream ${card.label ?? ''} of the project "${project.title}"; plan doc ${project.plan.file}.` : '',
      ...(await this.others(card, active, ahead, tags)),
      siblings.length ? `Of these, workstreams of the same project: ${siblings.join(', ')}.` : '',
      pending.length
        ? `The project's other workstreams that have not landed, neither in progress nor queued ahead:\n${pending
            .map((w) => {
              const state = notStarted(w) ? (w.branch ? 'stopped by the owner, not running' : 'not started') : 'queued after this card';
              return `- ${tagOf(tags, w.id)}: ${w.label ? `${w.label} ` : ''}"${w.title}" (${state})${w.body ? ` — ${w.body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
            })
            .join('\n')}`
        : '',
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  /** The cards in progress and queued ahead, as a turn of the Koordinator reads them. */
  private async others(card: Item, active: Item[], ahead: Item[], tags: Map<string, string>): Promise<string[]> {
    const folder = !!this.o.repoFor(card).folder;
    // in a folder nothing is merged later: every path counts
    const soft = folder ? [] : this.o.repoFor(card).adapter.softPaths;
    const described = folder ? (c: Change) => `${c.file} (${c.regions[0] ?? 'changed'})` : describe;
    const hard = (f: string) => !soft.some((s) => overlaps(normalize(f), s));
    // git reads the branches side by side, without holding up the server
    const changes = await Promise.all(active.map((a) => this.o.repoFor(a).workspaces.changes(a.id)));
    return [
      active.length
        ? `Cards in progress:\n${active
            .map((a, n) => {
              const tag = tagOf(tags, a.id);
              const changed = changes[n]!.filter((c) => hard(c.file));
              return [
                `- ${tag}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}`,
                `  expected to change: ${(a.scope ?? []).filter(hard).join(', ') || '(no estimate)'}`,
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
                `- ${tagOf(tags, a.id)}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}`,
                `  expected to change: ${(a.scope ?? []).filter(hard).join(', ') || '(no estimate)'}`,
                `  waits for: ${waitsFor || 'your decision'}`,
              ].join('\n');
            })
            .join('\n')}`
        : '',
      soft.length ? `Changes under ${soft.join(', ')} never count: they are resolved when a branch lands.` : '',
    ];
  }

  // ---------------------------------------------------------------- helpers

  private serial(fn: () => unknown) {
    this.chain = this.chain.then(fn).catch((e) => console.error('Koordinator:', e));
  }

  /** The repository of a card it was deciding on stopped running on the canvas: the card is planned again, for the owner to start once it is back. */
  private repoGone(card: Item) {
    this.setQueue(card.id, null);
    this.o.board.log(card.id, 'state', 'obeya', this.o.board.t.koordinator.repoDown(card.repo));
  }

  /** A card keeps the time it came to the Koordinator for as long as it stays queued. */
  private setQueue(cardId: string, q: Wait | null, keep?: string) {
    const since = keep ?? this.o.board.item(cardId)?.queue?.since ?? new Date().toISOString();
    this.o.board.work(cardId, { queue: q ? JSON.stringify({ ...q, since }) : null });
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

const NAME_SYSTEM = (language: string) => `You name a card on Obeya, a canvas on which the owner directs coding agents. The owner wrote the card's task (below) without a title. Give it one with the tool title: in the language the task is written in (${language} where it tells none), short and precise like a ticket title (at most about 70 characters), saying what the task changes or achieves; no quotes, no full stop at the end. Then end your turn.`;

const SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. Your job here: before a card starts, estimate which files it will change, and judge whether running it next to the cards in progress is likely to end in merge conflicts. Only those keep it waiting, and for a workstream of a project what it builds on; everything else should run in parallel. Cards queued ahead of it count too: they came first and start before it, so a card likely to conflict with one of them waits behind it rather than overtaking it.

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
You are the Koordinator of Obeya, a canvas on which the owner directs agents; the owner knows you simply as Obeya. Several workers work at the same time, all directly in one folder that is not a git repository: what one changes is there at once for the others, and nothing is merged afterwards. Your job here: before a card starts, estimate which files and directories it will touch, and judge whether running it next to the cards in progress is likely to get in their way. Only those keep it waiting, and for a workstream of a project what it builds on; everything else should run in parallel. Cards queued ahead of it count too: they came first and start before it, so a card likely to collide with one of them waits behind it rather than overtaking it.

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
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. The owner wants the workstreams of a project arranged by what builds on what: what can start at once on the left, what builds on it to the right of it. Read the plan doc (and the repository only where the doc leaves it open; you cannot change files) and say for each open workstream which workstreams it builds on.

A workstream builds on another when it needs code, an API, data, a document or a decision that the other one introduces, or when the plan says it comes after it, needs it or waits for it. Name only direct dependencies: when C builds on B and B on A, C names B, not A. Two workstreams that merely touch the same files, or that the plan lists one after the other without saying one needs the other, do not build on each other. A workstream may build on a delivered one.

Call dependencies exactly once, with every open workstream once.
`.trim();

const FOLDER_SCHEDULE_SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs agents; the owner knows you simply as Obeya. Several workers work at the same time, all directly in one folder that is not a git repository: what one changes is there at once for the others, and nothing is merged afterwards. The owner started all open workstreams of a project at once; you decide how they go. Read the plan doc and what you need in the folder (you cannot change files).

A workstream waits for another when:
- it depends on it: it builds on files, an overview, data or a decision that the other one makes, or the plan says it comes after it. It then waits until that one is done.
- running both at once likely collides: both change, move, rename or delete the same files, one reorganises a directory the other works in, or one sorts or rewrites files the other creates or reads. Working in the same directory is not a collision.
Everything else starts now and runs in parallel; parallel work is the point. Cards in progress and queued ahead count as for any start: a workstream likely to collide with one of them waits for it.

Call schedule exactly once, with every workstream once, in the order they should go (what starts now first, then each one after what it waits for):
- card: its tag.
- files: paths relative to the folder it will most likely touch; a path ending in "/" stands for a directory.
- builds_on: the tags of the workstreams it depends on (in progress, queued ahead, or earlier in your order).
- conflicts_with: the tags of cards it would likely collide with: cards in progress, queued ahead, or workstreams earlier in your order.
Both empty: it starts now. A workstream that waits starts by itself once what it waits for is done.
- reason: one sentence in ${language} for the owner: why it waits (the dependency, or where the changes collide), or, starting now, why it can run beside the others. The owner does not know the tags: name cards by their label or title.
`.trim();

const SCHEDULE_SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. The owner started all open workstreams of a project at once; you decide how they go. Read the plan doc and what you need in the repository (you cannot change files).

A workstream waits for another when:
- it depends on it: it builds on code, an API, data or a decision that the other one introduces, or the plan says it comes after it. It then waits until that one has landed.
- running both at once likely ends in merge conflicts: both change the same lines or the same function or block, one rewrites, moves, renames or reformats code the other one edits, or both change the same small, tightly packed section. Sharing a file is not a conflict: changes in different places of a file merge cleanly.
Everything else starts now and runs in parallel; parallel work is the point. When in doubt about a conflict, let it run: a conflict that happens anyway goes back to its worker. Cards in progress and queued ahead count as for any start: a workstream likely to conflict with one of them waits for it.

Call schedule exactly once, with every workstream once, in the order they should go (what starts now first, then each one after what it waits for):
- card: its tag.
- files: repository-relative paths it will most likely change; a path ending in "/" stands for a directory.
- builds_on: the tags of the workstreams it depends on (in progress, queued ahead, or earlier in your order).
- conflicts_with: the tags of cards it would likely conflict with: cards in progress, queued ahead, or workstreams earlier in your order.
Both empty: it starts now. A workstream that waits starts by itself once what it waits for has landed.
- reason: one sentence in ${language} for the owner: why it waits (the dependency, or where the changes collide), or, starting now, why it can run beside the others. The owner does not know the tags: name cards by their label or title.
`.trim();

/**
 * Where a rule goes: the preference memory, for how agents work with the owner through Obeya, or a
 * repository's CLAUDE.md, for anything about the repository. Shared by the learner and the Rückschau.
 */
const WHERE_RULES_GO = `
A rule goes to one of two places:
- The preference memory, for rules at the level of Obeya: how the agents work with the owner through Obeya, whatever the repository. What to ask the owner and what to decide alone, how many options a question offers, how to report, hand over and demo, what to decide in the owner's name and what not. Leave repos out.
- A repository's CLAUDE.md, for anything about a repository: its conventions, product requirements, tools, how its code is written, tested and landed, the UI and its wording, and taste in code too, even when it holds in every repository. There it is versioned, colleagues see it, and Claude Code follows it outside Obeya as well. Pass repos: the repository it concerns (usually the card's), or every repository of the canvas when it holds in all of them. A worker writes it into the CLAUDE.md once the owner accepts it; until that has landed, no agent follows it. If the repository's CLAUDE.md or docs say it already (you can read them), propose nothing.
`.trim();

const REPOS_PARAM =
  "repos: the ids of the repositories whose CLAUDE.md the rule belongs in (one proposal each); leave it out for a rule on how agents work with the owner through Obeya.";

const LEARN_SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. You keep the owner's rules, so the owner never has to say the same thing twice.

You get one thing the owner just said: to the agent on a card, in the text of a card they wrote, or to you in conversation. With it you see the card, what the owner said in the last days, the agent's last message before it, the canvas's repositories, the rules recorded so far, and the proposals waiting for the owner or rejected by them. Decide whether it holds a lasting rule that should guide future work on other cards too: how to work, what to ask and what not, style, wording, testing, tools.

${WHERE_RULES_GO}

Signals for one:
- It is phrased generally: "immer", "nie", "ab jetzt", "grundsätzlich", "jedes Mal", "bei so etwas".
- It corrects how an agent works rather than what it builds: the agent asked what it could have decided itself, skipped a check, wrote in a style the owner does not want, went beyond its task. The agent's last message shows what the owner reacts to.
- It repeats something the owner said before, on this card or another: said twice, it should not need saying a third time.
Not a preference: deciding the case at hand (an option, a name, a date, what this card should do), approving, asking how things stand, correcting a fact. Most of what the owner says is like that: then call nothing.

Make few, good proposals: at most one per input, and only one you expect the owner to accept; when unsure, wait until the owner says it again. Call propose with a short, general rule in ${language}, in the owner's terms and without the occasion ("Fragen an mich mit höchstens drei Optionen.", "Änderungen am Login bekommen immer das Codex-Review." for the repository with the login); the owner accepts or rejects it before it applies. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either.
`.trim();

/** After how many of the owner's inputs the Rückschau runs, at most how many rules it proposes, and how much history it reads. */
export const REVIEW_EVERY = 20;
const REVIEW_PROPOSALS = 3;
const REVIEW_HISTORY = 300;
/** The settings that keep the Rückschau's count across restarts, and when its history begins. */
const REVIEW_COUNT = 'review_inputs';
const REVIEW_SINCE = 'review_since';

const REVIEW_SYSTEM = (language: string) => `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya. You keep the owner's rules, so the owner never has to say the same thing twice.

${WHERE_RULES_GO}

This is the Rückschau. You get what happened on the canvas since the last one, oldest first: what the owner said and clicked (notes, answers, feedback, approvals, starts against your advice, cards and proposals they deleted or dismissed, commands they took back, rule proposals they accepted or rejected), and what the agents asked and handed over. Each thing the owner said was already read on its own; look for what only shows across several moments and cards:
- the same correction or feedback on different cards;
- the same kind of question, answered the same way each time;
- proposals of one kind the owner always dismisses, or always takes;
- your advice to wait overruled again and again;
- commands taken back, and what the owner did instead.
Clicks without words count here: what the owner does again and again says what they want as much as what they say.

Propose a rule only for a pattern seen at least twice, on different cards, that you expect the owner to accept; most of the time there is none. Call propose for each, at most ${REVIEW_PROPOSALS}: rule, a short, general rule in ${language} in the owner's terms and without the occasion ("Fragen an mich mit höchstens drei Optionen.", "Änderungen am Login bekommen immer das Codex-Review." for the repository with the login); why, one short sentence in ${language} for the owner (under 150 characters) naming the cards or moments it rests on. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either. Then call done.
`.trim();

/** How the Rückschau names who did something on a card, and what. */
const WHO: Record<CardEvent['author'], string> = {
  owner: 'the owner',
  worker: 'the agent',
  explorer: 'the idea agent',
  project: 'the project agent',
  koordinator: 'you',
  obeya: 'Obeya',
};
const STEPS: Partial<Record<CardEvent['kind'], string>> = {
  state: ': ',
  question: ' asked: ',
  answer: ' answered: ',
  review: ' handed over: ',
  hint: ' wrote to the agent: ',
  error: ', an error: ',
};

/** How far back the learner reads what the owner said, and at most how much of it. */
const RECENT_DAYS = 3;
const RECENT_UTTERANCES = 30;

/** Who on a card speaks for an agent, and in which of its log lines. */
const AGENTS: CardEvent['author'][] = ['worker', 'explorer'];
const SAYS: CardEvent['kind'][] = ['say', 'question', 'review', 'report', 'talk'];

/** How the learner hears what the owner said in the last days. */
const UTTERED: Record<Utterance['kind'], string> = {
  hint: 'to the agent',
  answer: "answering the agent's question",
  talk: "in an idea's discussion",
  say: 'to you',
};

/** How the learner hears each kind of input. */
const INPUTS: Record<OwnerInput, string> = {
  answer: 'answer',
  note: 'note to the worker',
  feedback: 'feedback on the finished work',
  idea: 'words in the discussion of an idea',
  command: 'words to you, which you carried out',
  talk: 'question or remark to you',
  card: 'text of a card they wrote, the task for an agent',
};

/**
 * A read-only session that reads `brief` (and `images`) and answers through its tools: it ends with
 * its turn, or once a tool calls `finish`. It settles with the error that ended it before a tool
 * called `finish`, if one did. With `onLimit` it waits for the account's usage limit instead of
 * failing on it (`AgentSpec.onLimit`).
 */
export function readSession(
  runtime: AgentRuntime,
  o: {
    cwd: string;
    system: string;
    tools: (finish: (r: string) => string) => AgentTool[];
    brief: string;
    role: AgentRole;
    images?: string[];
    onLimit?: (until: number | undefined) => void;
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const end = (error?: string) => {
      if (!done) {
        done = true;
        resolve(error);
      }
    };
    const finish = (r: string) => {
      end();
      return r;
    };
    const session = runtime.start(
      {
        cwd: o.cwd,
        readOnly: true,
        role: o.role,
        system: o.system,
        tools: o.tools(finish),
        ...(o.onLimit ? { onLimit: o.onLimit } : {}),
        onEvent: (e) => {
          if (e.type === 'idle' || e.type === 'error') {
            session.close();
            end(e.type === 'error' ? e.message : undefined);
          }
        },
      },
      o.brief,
      o.images,
    );
  });
}

/** A changed file with the places changed in it: "src/a.ts (lines 12-20 in function f; 40)", or "(new)". */
const describe = (c: Change) =>
  `${c.file} (${c.regions.length ? (c.regions[0] === 'deleted' ? 'deleted' : `lines ${c.regions.slice(0, 8).join('; ')}${c.regions.length > 8 ? '; …' : ''}`) : 'new'})`;

/** The tag a turn of the Koordinator knows a card by. */
/** A card waited on that still holds back what builds on it: there, and its work not on the main branch yet. */
const unlanded = (i?: Item) => !!i && !finished(i.state) && !i.archivedAt;

const tagOf = (tags: Map<string, string>, id: string) => [...tags].find(([, x]) => x === id)![0];

const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** Two paths overlap when they are equal or one is a directory (trailing `/`) containing the other. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
