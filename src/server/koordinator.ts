// The Koordinator decides when a card may start: not while it is likely to collide with work in
// progress. Collisions come from overlapping files (estimated before the start, actual while a
// worker works) and from the Koordinator's own judgement.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import type { Item, Question, Queue } from '../core/types';
import { ADVICE_RULES, consult, decisionLog, type Reply } from './advisor';
import { BadRequest, type Board } from './board';
import type { AgentRuntime } from './runtime';
import type { Workers } from './workers';
import type { Workspaces } from './workspaces';

interface Package {
  kind: 'bugfix' | 'feature';
  title: string;
  body: string;
  files: string[];
}
type Cut = { packages: Package[]; reason: string } | { keep: string };

export interface Scope {
  files: string[];
  /** Cards in progress the Koordinator judges to collide, beyond overlapping files. */
  collidesWith: string[];
  reason: string;
}

export interface KoordinatorOptions {
  board: Board;
  runtime: AgentRuntime;
  workers: Workers;
  workspaces: Workspaces;
  adapter: RepoAdapter;
  /** The checkout the Koordinator reads to estimate scopes. */
  repoPath: string;
  /** The owner's recorded preferences, as agents read them. */
  preferences?: () => string;
}

export class Koordinator {
  /** Decisions to start are taken one at a time, so two colliding cards cannot both slip through. */
  private chain: Promise<unknown> = Promise.resolve();
  private answers: Promise<unknown> = Promise.resolve();
  private learning: Promise<unknown> = Promise.resolve();
  private draining = false;

  constructor(private o: KoordinatorOptions) {
    o.board.onChange(() => this.scheduleDrain());
  }

  /** After a restart: decide again on cards the Koordinator was checking, and start what is free. */
  resume() {
    for (const i of this.o.board.snapshot().items)
      if (i.state === 'planned' && i.queue && 'checking' in i.queue) this.serial(() => this.decide(i.id));
    this.scheduleDrain();
  }

  /** The owner wants the card worked on. */
  request(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') throw new BadRequest('project', 'a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    if (card.queue) throw new BadRequest('queued', 'the card is already with the Koordinator');
    this.setQueue(cardId, { checking: true });
    this.serial(() => this.decide(cardId));
  }

  /** The owner wants the card cut into packages that can run in parallel. */
  split(cardId: string) {
    const card = this.card(cardId);
    if (card.source !== 'manual' || card.state !== 'planned' || card.queue) throw new BadRequest('notSplittable', 'only a planned card of your own can be split');
    this.setQueue(cardId, { cutting: true });
    this.serial(() => this.cut(cardId));
  }

  private async cut(cardId: string) {
    const card = this.o.board.item(cardId);
    if (!card || !card.queue || !('cutting' in card.queue)) return;
    let result: Cut;
    try {
      result = await this.plan(card);
    } catch (e) {
      this.setQueue(cardId, null);
      this.o.board.log(cardId, 'error', 'obeya', `Koordinator konnte die Karte nicht aufteilen (${e instanceof Error ? e.message : String(e)}).`);
      return;
    }
    if (!('packages' in result) || result.packages.length < 2) {
      this.setQueue(cardId, null);
      this.o.board.log(cardId, 'state', 'koordinator', `Nicht aufgeteilt: ${'keep' in result ? result.keep : 'ein Paket genügt.'}`);
      return;
    }
    const made = this.o.board.replace(cardId, result.packages);
    for (const m of made) this.o.board.log(m.id, 'state', 'koordinator', `Aus „${card.title}“ aufgeteilt. ${result.reason}`);
  }

  private plan(card: Item): Promise<Cut> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (r: Cut) => {
        if (done) return 'Already reported.';
        done = true;
        resolve(r);
        return 'Recorded. End your turn now.';
      };
      const session = this.o.runtime.start(
        {
          cwd: this.o.repoPath,
          readOnly: true,
          system: CUT_SYSTEM,
          tools: [
            {
              name: 'packages',
              description: 'Replace the card by these packages (2 to 6). Titles and bodies in German; files as in scope estimates.',
              schema: {
                packages: z.array(z.object({ kind: z.enum(['bugfix', 'feature']), title: z.string(), body: z.string(), files: z.array(z.string()) })).min(2).max(6),
                reason: z.string(),
              },
              run: (a) => finish({ packages: a.packages as Package[], reason: String(a.reason) }),
            },
            {
              name: 'keep',
              description: 'Leave the card whole, with a one-sentence reason in German.',
              schema: { reason: z.string() },
              run: (a) => finish({ keep: String(a.reason) }),
            },
          ],
          onEvent: (e) => {
            if (e.type === 'error' && !done) {
              done = true;
              session.close();
              reject(new Error(e.message));
            } else if (e.type === 'idle') {
              session.close();
              if (!done) {
                done = true;
                reject(new Error('keine Antwort'));
              }
            }
          },
        },
        `The card: ${card.kind} "${card.title}".\n\n${card.body || '(no description)'}${this.o.preferences ? `\n\n${this.o.preferences()}` : ''}`,
      );
    });
  }

  /** Start a queued card anyway. */
  force(cardId: string) {
    const card = this.card(cardId);
    if (!card.queue || !('behind' in card.queue)) throw new BadRequest('notQueued', 'the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', 'Trotz Überschneidung gestartet.');
    this.o.workers.start(cardId);
  }

  dequeue(cardId: string) {
    if (!this.card(cardId).queue) throw new BadRequest('notQueued', 'the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', 'Aus der Warteschlange genommen.');
  }

  /** Answers the question of a card without a project, or escalates it. One question at a time. */
  ask(card: Item, q: Question): Promise<Reply> {
    const next = this.answers
      .catch(() => {})
      .then(() =>
        consult({
          runtime: this.o.runtime,
          cwd: this.o.repoPath,
          resume: this.o.board.setting('koordinator_session') ?? undefined,
          onSession: (id) => this.o.board.setSetting('koordinator_session', id),
          system: `You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Workers on cards that belong to no project send you the questions they cannot decide themselves.\n\n${ADVICE_RULES}`,
          message: [
            `Question from the worker on the ${card.kind} "${card.title}":`,
            card.body ? `The card: ${card.body.slice(0, 1500)}` : '',
            q.text,
            q.options.length ? `Options the worker suggests:\n${q.options.map((o) => `- ${o}`).join('\n')}` : '',
            `Decisions on cards without a project so far:\n${decisionLog(this.o.board.decisions(null))}`,
            this.o.preferences?.() ?? '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          fallback: q,
        }),
      );
    this.answers = next;
    return next;
  }

  /**
   * The owner answered, sent a note or gave feedback: if it states a lasting preference, keep it
   * as a rule for every agent. Runs in the background, one at a time.
   */
  learn(card: Item, kind: 'answer' | 'note' | 'feedback', text: string, question?: string) {
    this.learning = this.learning
      .catch(() => {})
      .then(() => this.distill(card, kind, text, question))
      .catch((e) => console.error('Koordinator (learning):', e));
  }

  private distill(card: Item, kind: 'answer' | 'note' | 'feedback', text: string, question?: string): Promise<void> {
    const rules = this.o.board.preferences();
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: string) => {
        if (!done) {
          done = true;
          resolve();
        }
        return r;
      };
      const session = this.o.runtime.start(
        {
          cwd: this.o.repoPath,
          readOnly: true,
          system: LEARN_SYSTEM,
          tools: [
            {
              name: 'remember',
              description: 'Record a lasting preference as one short rule in German. Pass replaces with the number of an existing rule it refines or contradicts.',
              schema: { rule: z.string(), replaces: z.number().int().optional() },
              run: ({ rule, replaces }) => {
                const r = String(rule).trim().slice(0, 500);
                if (!r) return finish('Empty rule ignored.');
                const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
                if (old) this.o.board.setPreference(old.id, r);
                else this.o.board.addPreference(r, card.id);
                this.o.board.log(card.id, 'state', 'koordinator', `Merkt sich: „${r}“`);
                return finish('Recorded. End your turn now.');
              },
            },
            { name: 'nothing', description: 'Nothing lasting to record.', schema: {}, run: () => finish('Fine. End your turn now.') },
          ],
          onEvent: (e) => {
            if (e.type === 'idle' || e.type === 'error') {
              session.close();
              finish('');
            }
          },
        },
        [
          `Card: ${card.kind} "${card.title}".`,
          question ? `The worker asked: ${question}` : '',
          `The owner's ${kind === 'answer' ? 'answer' : kind === 'note' ? 'note to the worker' : 'feedback on the finished work'}: ${text}`,
          rules.length ? `Rules recorded so far:\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}` : 'No rules recorded so far.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    });
  }

  /** Cards that a card in progress may collide with. */
  inProgress(): Item[] {
    return this.o.board.snapshot().items.filter((i) => (i.state === 'working' || i.state === 'waiting') && i.kind !== 'project');
  }

  private async decide(cardId: string) {
    const card = this.o.board.item(cardId);
    // taken out of the queue or deleted while waiting for its turn
    if (!card || card.state !== 'planned' || !card.queue || !('checking' in card.queue)) return;
    const active = this.inProgress();
    if (!active.length) {
      // nothing it could collide with: start at once, and estimate the scope for the cards after it
      this.startNow(cardId, 'Nichts läuft gerade; es geht sofort los.');
      if (this.o.board.item(cardId)?.state !== 'working') return;
      try {
        const scope = await this.estimate(card, []);
        this.o.board.work(cardId, { scope: JSON.stringify({ files: scope.files, reason: scope.reason }) });
      } catch {}
      return;
    }
    let scope: Scope;
    try {
      scope = await this.estimate(card, active);
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', `Koordinator konnte den Umfang nicht schätzen (${e instanceof Error ? e.message : String(e)}); die Karte startet trotzdem.`);
      scope = { files: [], collidesWith: [], reason: '' };
    }
    if (!this.o.board.item(cardId)?.queue) return;
    this.o.board.work(cardId, { scope: JSON.stringify({ files: scope.files, reason: scope.reason }) });
    const behind = this.collisions(scope, active);
    if (!behind.length) return this.startNow(cardId, 'Keine Überschneidung mit laufender Arbeit.');
    const names = behind.map((id) => `„${active.find((a) => a.id === id)?.title ?? id}“`).join(', ');
    const reason = scope.reason || 'Überschneidung mit laufender Arbeit.';
    this.setQueue(cardId, { behind, reason });
    this.o.board.log(cardId, 'state', 'obeya', `Koordinator: wartet auf ${names}. ${reason}`);
  }

  private startNow(cardId: string, why: string) {
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'obeya', `Koordinator: ${why}`);
    try {
      this.o.workers.start(cardId);
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', e instanceof Error ? e.message : String(e), e instanceof BadRequest ? e.code : undefined);
    }
  }

  /** In-progress cards the scope collides with: overlapping files, or the Koordinator's judgement. */
  collisions(scope: Scope, active: Item[]): string[] {
    const mine = this.hard(scope.files);
    return active
      .filter((a) => {
        if (scope.collidesWith.includes(a.id)) return true;
        const theirs = this.hard([...(a.scope ?? []), ...this.o.workspaces.changedFiles(a.id)]);
        return mine.some((f) => theirs.some((g) => overlaps(f, g)));
      })
      .map((a) => a.id);
  }

  private hard(files: string[]): string[] {
    return files.map(normalize).filter((f) => f && !this.o.adapter.softPaths.some((s) => overlaps(f, s)));
  }

  /** Queued cards start once nothing they wait for is in progress any more. */
  private scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    setTimeout(() => {
      this.draining = false;
      this.serial(() => this.drain());
    }, 0);
  }

  private drain() {
    const items = this.o.board.snapshot().items;
    const active = new Set(this.inProgress().map((i) => i.id));
    const waiting = items.filter((i) => i.state === 'planned' && i.queue && 'behind' in i.queue);
    for (const w of waiting) {
      const q = w.queue as { behind: string[]; reason: string };
      const still = q.behind.filter((id) => active.has(id));
      if (still.length === q.behind.length) continue;
      if (still.length) {
        this.setQueue(w.id, { behind: still, reason: q.reason });
        continue;
      }
      // what it waited for is done; check again against what runs now, with the estimate it has
      const scope: Scope = { files: w.scope ?? [], collidesWith: [], reason: q.reason };
      const now = this.collisions(scope, this.inProgress());
      if (now.length) this.setQueue(w.id, { behind: now, reason: q.reason });
      else {
        this.startNow(w.id, 'Die Überschneidung ist erledigt; es geht los.');
        active.add(w.id);
      }
    }
  }

  // ---------------------------------------------------------------- the estimate

  private estimate(card: Item, active: Item[]): Promise<Scope> {
    return new Promise((resolve, reject) => {
      let done = false;
      const tags = new Map(active.map((a, n) => [`K${n + 1}`, a.id]));
      const session = this.o.runtime.start(
        {
          cwd: this.o.repoPath,
          readOnly: true,
          system: SYSTEM,
          tools: [
            {
              name: 'scope',
              description: 'Report the files the card will change, the cards in progress it collides with (their tags), and a one-sentence reason in German.',
              schema: { files: z.array(z.string()), collides_with: z.array(z.string()), reason: z.string() },
              run: (a) => {
                if (done) return 'Already reported.';
                done = true;
                resolve({
                  files: (a.files as string[]).slice(0, 200),
                  collidesWith: (a.collides_with as string[]).map((t) => tags.get(t)).filter((x): x is string => !!x),
                  reason: String(a.reason).slice(0, 500),
                });
                return 'Recorded. End your turn now.';
              },
            },
          ],
          onEvent: (e) => {
            if (e.type === 'error' && !done) {
              done = true;
              session.close();
              reject(new Error(e.message));
            } else if (e.type === 'idle') {
              session.close();
              if (!done) {
                done = true;
                reject(new Error('no estimate'));
              }
            }
          },
        },
        this.brief(card, active, tags),
      );
    });
  }

  private brief(card: Item, active: Item[], tags: Map<string, string>): string {
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    const lines = [
      `The card to start: ${card.kind} "${card.title}".`,
      card.body.trim(),
      project?.plan ? `It is workstream ${card.label ?? ''} of the project "${project.title}"; plan doc ${project.plan.file}.` : '',
      active.length
        ? `Cards in progress:\n${[...tags]
            .map(([tag, id]) => {
              const a = active.find((x) => x.id === id)!;
              const files = [...new Set([...(a.scope ?? []), ...this.o.workspaces.changedFiles(id)])];
              return `- ${tag}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}\n  files: ${files.join(', ') || '(none known)'}`;
            })
            .join('\n')}`
        : 'No cards are in progress.',
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  // ---------------------------------------------------------------- helpers

  private serial(fn: () => unknown) {
    this.chain = this.chain.then(fn).catch((e) => console.error('Koordinator:', e));
  }

  private setQueue(cardId: string, q: Queue | null) {
    this.o.board.work(cardId, { queue: q ? JSON.stringify(q) : null });
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

const SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. Your job here: before a card starts, estimate which files it will change, and judge whether it collides with a card in progress — whether their changes are likely to conflict or to step on each other's behaviour.

Read what you need in the repository (you cannot change files), then call scope exactly once:
- files: repository-relative paths the card will most likely change; a path ending in "/" stands for a directory. Be concrete; list new files where you expect them.
- collides_with: the tags of cards in progress it collides with beyond plain file overlap (same feature, same data model, same UI flow); empty when none.
- reason: one sentence in German for the owner, naming the overlap if there is one. The owner does not know the tags: name cards by their title.
Keep it quick: this runs every time a card starts.
`.trim();

const LEARN_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. You keep the owner's preference memory: short rules every agent follows, so the owner never has to say the same thing twice.

You get one thing the owner said about a card. Decide whether it states a lasting preference that should guide future work on other cards too — about how to work, what to ask and what not, style, wording, testing, tools. Most answers only decide the case at hand: then call nothing.
If it does state one, call remember with a short, general rule in German ("Beschriftungen: präzise vor kurz.", "Abrechnungsänderungen bekommen immer das Codex-Review."). If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not record what is already covered.
`.trim();

const CUT_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Several workers run at the same time, each on one card in its own workspace; cards that change the same files have to wait for each other. The owner asks you to cut a card into work packages that can run in parallel.

Read what you need in the repository (you cannot change files). Then either call packages or keep:
- packages: 2 to 6 cards that together do exactly what the card asks, each shippable and testable on its own, touching different files wherever possible. Each body says what to do and how to verify it, so a worker needs no other context. files: the repository-relative paths each will change ("dir/" for a directory). reason: one sentence in German on how you cut.
- keep: when the card is small, or its parts cannot run apart without stepping on each other.
Do not add scope the card does not ask for.
`.trim();

const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** Two paths overlap when they are equal or one is a directory (trailing `/`) containing the other. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
