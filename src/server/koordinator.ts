// The Koordinator decides when a card may start: not while it is likely to collide with work in
// progress. Collisions come from overlapping files (estimated before the start, actual while a
// worker works) and from the Koordinator's own judgement.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import type { Item, Queue } from '../core/types';
import { BadRequest, type Board } from './board';
import type { AgentRuntime } from './runtime';
import type { Workers } from './workers';
import type { Workspaces } from './workspaces';

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
}

export class Koordinator {
  /** Decisions to start are taken one at a time, so two colliding cards cannot both slip through. */
  private chain: Promise<unknown> = Promise.resolve();
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
    if (card.kind === 'project') throw new BadRequest('a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('only a planned card can be started');
    if (card.queue) throw new BadRequest('the card is already with the Koordinator');
    this.setQueue(cardId, { checking: true });
    this.serial(() => this.decide(cardId));
  }

  /** Start a queued card anyway. */
  force(cardId: string) {
    const card = this.card(cardId);
    if (!card.queue || 'checking' in card.queue) throw new BadRequest('the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', 'Trotz Überschneidung gestartet.');
    this.o.workers.start(cardId);
  }

  dequeue(cardId: string) {
    if (!this.card(cardId).queue) throw new BadRequest('the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', 'Aus der Warteschlange genommen.');
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
      this.o.board.log(cardId, 'error', 'obeya', e instanceof Error ? e.message : String(e));
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
    if (!i) throw new BadRequest('unknown card');
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

const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** Two paths overlap when they are equal or one is a directory (trailing `/`) containing the other. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
