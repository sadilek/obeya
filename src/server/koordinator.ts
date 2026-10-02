// The Koordinator decides when a card may start: not while its changes are likely to conflict on
// merge with work in progress. It judges that from what each card will change (estimated before
// the start) and has changed so far (files and the places in them); sharing a file is not enough.

import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import { type CardEvent, type Item, type Question, type Queue, START_ALL_HOLD_MS } from '../core/types';
import { ADVICE_RULES, consult, decisionLog, type Reply } from './advisor';
import { BadRequest, type Board } from './board';
import type { Utterance } from './db';
import type { AgentRuntime, AgentTool } from './runtime';
import type { Workers } from './workers';
import type { Change, Workspaces } from './workspaces';

interface Package {
  kind: 'bugfix' | 'feature';
  title: string;
  body: string;
  files: string[];
}
type Cut = { packages: Package[]; reason: string } | { keep: string };
/** A workstream as the Koordinator scheduled it, in its turn's order. */
interface Planned {
  card: string;
  files: string[];
  waitsFor: string[];
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
  /** The answer given in the owner's name to the card's last question, which the input may overrule. */
  overruled?: { question: string; answer: string; by: 'project' | 'koordinator' };
  /** The Koordinator's reply to what the owner said to it. */
  reply?: string;
  /** The card's text before the owner wrote in it: a proposal's, a finding a follow-up quotes. */
  before?: string;
}

export interface Scope {
  files: string[];
  /** Cards in progress or queued ahead whose changes the Koordinator expects to conflict with this card's on merge. */
  conflictsWith: string[];
  reason: string;
}

/** What the Koordinator needs of the repository a card belongs to. */
export interface RepoHands {
  workers: Workers;
  workspaces: Workspaces;
  adapter: RepoAdapter;
  /** The checkout the Koordinator reads (scopes, cutting, questions). */
  path: string;
}

export interface KoordinatorOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The repository of a card; a canvas may span several. */
  repoFor: (card: Item) => RepoHands;
  /** The checkout the Koordinator reads for what the owner says without a card (the home repository). */
  home: string;
  /** The owner's recorded preferences, as agents read them. */
  preferences?: () => string;
  /** Worker questions one session answers; the next one starts fresh. */
  sessionQuestions?: number;
  /** How long a project's start waits for the owner to take it back; START_ALL_HOLD_MS by default. */
  holdMs?: number;
  /** After how many of the owner's inputs the Rückschau runs; REVIEW_EVERY by default. */
  reviewEvery?: number;
}

export class Koordinator {
  /** Decisions to start are taken one at a time, so two colliding cards cannot both slip through. */
  private chain: Promise<unknown> = Promise.resolve();
  private answers: Promise<unknown> = Promise.resolve();
  private learning: Promise<unknown> = Promise.resolve();
  /**
   * The session that answers worker questions, kept for a few questions and never across a
   * restart, so it cannot grow without end. What it needs to remember comes with every question:
   * the decisions so far and the preferences.
   */
  private questionSession: { id?: string; asked: number } = { asked: 0 };
  private draining = false;

  constructor(private o: KoordinatorOptions) {
    o.board.onChange(() => this.scheduleDrain());
  }

  /** After a restart: decide again on cards the Koordinator was checking, and start what is free. */
  resume() {
    const together = new Set<string>();
    for (const i of this.o.board.snapshot().items) {
      if (i.state !== 'planned' || !i.queue) continue;
      if ('checking' in i.queue && i.queue.together) together.add(i.queue.together);
      else if ('checking' in i.queue) this.serial(() => this.decide(i.id));
      else if ('cutting' in i.queue) this.serial(() => this.cut(i.id));
    }
    for (const p of together) this.serial(() => this.decideAll(p));
    this.scheduleDrain();
  }

  /** The owner wants the card worked on; a project, all its planned workstreams. */
  request(cardId: string): void {
    const card = this.card(cardId);
    if (card.kind === 'project') return this.requestAll(card);
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    if (card.queue) throw new BadRequest('queued', 'the card is already with the Koordinator');
    this.setQueue(cardId, { checking: true });
    this.serial(() => this.decide(cardId));
  }

  /**
   * All planned workstreams of the project go to the Koordinator together: one turn sees them all
   * with the plan doc and decides which start now and which wait, for a dependency or a likely
   * conflict, and in which order. They queue in the plan's order until it has, and the turn waits a
   * few seconds, so the owner can take the start back (`dequeue` on the project).
   */
  private requestAll(project: Item): void {
    const open = this.o.board.snapshot().items.filter((i) => i.parent === project.id && i.state === 'planned' && !i.queue);
    if (!open.length) throw new BadRequest('nothingToStart', 'the project has no planned workstream left to start');
    const now = Date.now();
    open.forEach((w, n) => this.o.board.work(w.id, { queue: JSON.stringify({ checking: true, together: project.id, since: new Date(now + n).toISOString() }) }));
    this.o.board.log(project.id, 'state', 'owner', `Alle Workstreams gestartet: ${open.map((w) => w.label ?? w.title).join(', ')}. Der Koordinator legt die Reihenfolge fest.`);
    setTimeout(() => this.serial(() => this.decideAll(project.id)), this.o.holdMs ?? START_ALL_HOLD_MS);
  }

  /** The workstreams of a project's start that the Koordinator has not planned yet. */
  private unplanned(projectId: string): Item[] {
    return this.o.board
      .snapshot()
      .items.filter((i) => i.parent === projectId && i.state === 'planned' && i.queue && 'checking' in i.queue && i.queue.together === projectId)
      .sort((a, b) => (a.queue!.since ?? '').localeCompare(b.queue!.since ?? ''));
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
          cwd: this.o.repoFor(card).path,
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
    this.o.repoFor(card).workers.start(cardId);
  }

  dequeue(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') {
      // the start of all its workstreams, taken back before the Koordinator planned them
      const back = this.unplanned(cardId);
      if (!back.length) throw new BadRequest('notQueued', 'no workstream of the project waits to be planned');
      for (const w of back) this.setQueue(w.id, null);
      this.o.board.log(cardId, 'state', 'owner', `Start zurückgenommen: ${back.map((w) => w.label ?? w.title).join(', ')}.`);
      return;
    }
    if (!card.queue) throw new BadRequest('notQueued', 'the card is not waiting');
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'owner', 'Aus der Warteschlange genommen.');
  }

  /** Answers the question of a card without a project, or escalates it. One question at a time. */
  ask(card: Item, q: Question): Promise<Reply> {
    const next = this.answers
      .catch(() => {})
      .then(() => {
        if (this.questionSession.asked >= (this.o.sessionQuestions ?? 20)) this.questionSession = { asked: 0 };
        const s = this.questionSession;
        s.asked++;
        return consult({
          runtime: this.o.runtime,
          cwd: this.o.repoFor(card).path,
          resume: s.id,
          onSession: (id) => (s.id = id),
          system: `You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Workers on cards that belong to no project send you the questions they cannot decide themselves.\n\n${ADVICE_RULES}`,
          message: [
            `Question from the worker on the ${card.kind} "${card.title}":`,
            card.body ? `The card: ${card.body.slice(0, 1500)}` : '',
            q.text,
            q.options.length ? `Options the worker suggests${q.multiple ? ' (several may be chosen)' : ''}:\n${q.options.map((o) => `- ${o}`).join('\n')}` : '',
            `Decisions on cards without a project so far:\n${decisionLog(this.o.board.decisions(null))}`,
            this.o.preferences?.() ?? '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          fallback: q,
        }).catch((e) => {
          // a session that failed is not resumed again
          if (this.questionSession === s) this.questionSession = { asked: 0 };
          throw e;
        });
      });
    this.answers = next;
    return next;
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
    this.learning = this.learning
      .catch(() => {})
      .then(() => this.distill(card, kind, text, context, around))
      .catch((e) => console.error('Koordinator (learning):', e));
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
    this.learning = this.learning
      .catch(() => {})
      .then(() => this.review(since))
      .catch((e) => console.error('Koordinator (Rückschau):', e));
  }

  /** The Rückschau: one session reads what happened since `since` and proposes rules for patterns across cards. */
  private review(since: string): Promise<void> {
    const history = this.history(since);
    if (!history.length) return Promise.resolve();
    const rules = this.o.board.preferences('active');
    const open = this.o.board.preferences('proposed');
    const rejected = this.o.board.preferences('rejected');
    let proposed = 0;
    return this.read(
      this.o.home,
      REVIEW_SYSTEM,
      (finish): AgentTool[] => [
        {
          name: 'propose',
          description:
            'Propose a rule to the owner: one short rule in German, and why (one short sentence in German, under 150 characters, naming what in the history it rests on). Pass replaces with the number of a recorded rule it refines or contradicts.',
          schema: { rule: z.string(), why: z.string(), replaces: z.number().int().optional() },
          run: ({ rule, why, replaces }) => {
            const r = String(rule).trim().slice(0, 500);
            if (!r) return 'Empty rule ignored.';
            if (proposed >= REVIEW_PROPOSALS) return finish(`At most ${REVIEW_PROPOSALS} proposals. End your turn now.`);
            if (this.o.board.preferences('proposed').some((p) => p.text === r)) return 'Already proposed.';
            const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
            this.o.board.proposePreference(r, { review: true, quote: String(why ?? '') }, old?.id);
            proposed++;
            return proposed < REVIEW_PROPOSALS ? 'Proposed.' : finish('Proposed. That was the last one; end your turn now.');
          },
        },
        { name: 'done', description: 'Nothing (more) to propose.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
      [
        `What happened on the canvas since the last Rückschau, oldest first:\n${history.join('\n')}`,
        rules.length ? `Rules recorded so far:\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}` : 'No rules recorded so far.',
        open.length ? `Proposals waiting for the owner (do not propose them again):\n${open.map((r) => `- ${r.text}`).join('\n')}` : '',
        rejected.length ? `Proposals the owner rejected (do not propose them again):\n${rejected.map((r) => `- ${r.text}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
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
        .filter((t) => t.at > since)
        .map((t) => {
          const open = title(t.cardId);
          return {
            at: t.at,
            text: `the owner to the Koordinator${open ? ` (with "${open}" open)` : ''}: ${clip(t.said, 300)} → ${clip(t.reply, 200)}${t.undone ? ' (the owner took it back)' : ''}`,
          };
        }),
      ...b.removed(since).map((r) => ({
        at: r.at,
        text: r.state === 'proposal' ? `the owner dismissed the card an agent proposed: "${r.title}"` : `the owner deleted the card "${r.title}" (${r.state})`,
      })),
      ...b.decidedProposals(since).map((p) => ({
        at: p.at,
        text: `the owner ${p.state === 'active' ? 'accepted' : 'rejected'} the proposed rule "${p.text}"${p.quote ? ` (its occasion: ${clip(p.quote, 200)})` : ''}`,
      })),
    ];
    return lines
      .sort((x, y) => x.at.localeCompare(y.at))
      .slice(-REVIEW_HISTORY)
      .map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')} ${l.text}`);
  }

  /** A reading session of the learner's, read-only: it ends with its turn, or once a tool calls `finish`. */
  private read(cwd: string, system: string, tools: (finish: (r: string) => string) => AgentTool[], brief: string): Promise<void> {
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
          cwd,
          readOnly: true,
          system,
          tools: tools(finish),
          onEvent: (e) => {
            if (e.type === 'idle' || e.type === 'error') {
              session.close();
              finish('');
            }
          },
        },
        brief,
      );
    });
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

  private distill(card: Item | null, kind: OwnerInput, text: string, context: InputContext, around: string[]): Promise<void> {
    const rules = this.o.board.preferences('active');
    const open = this.o.board.preferences('proposed');
    const rejected = this.o.board.preferences('rejected');
    const { question, overruled, reply, before } = context;
    let proposed = false;
    return this.read(
      card ? this.o.repoFor(card).path : this.o.home,
      LEARN_SYSTEM,
      (finish): AgentTool[] => [
        {
          name: 'propose',
          description:
            'Propose a lasting preference to the owner as one short rule in German. Pass replaces with the number of a recorded rule it refines or contradicts.',
          schema: { rule: z.string(), replaces: z.number().int().optional() },
          run: ({ rule, replaces }) => {
            const r = String(rule).trim().slice(0, 500);
            if (!r) return finish('Empty rule ignored.');
            if (proposed) return finish('One proposal per input. End your turn now.');
            if (open.some((p) => p.text === r)) return finish('Already proposed. End your turn now.');
            const old = typeof replaces === 'number' ? rules[replaces - 1] : undefined;
            this.o.board.proposePreference(r, { ...(card ? { cardId: card.id } : {}), quote: text }, old?.id);
            proposed = true;
            if (card) this.o.board.log(card.id, 'state', 'koordinator', `Schlägt vor: „${r}“`);
            return finish('Proposed. End your turn now.');
          },
        },
        { name: 'nothing', description: 'Nothing lasting to record.', schema: {}, run: () => finish('Fine. End your turn now.') },
      ],
        [
          card ? `Card${kind === 'talk' || kind === 'command' ? ' the owner had open' : ''}: ${card.kind} "${card.title}".` : '',
          ...around,
          question ? `The worker asked: ${question}` : '',
          overruled
            ? `The worker asked: ${overruled.question}\nThe ${overruled.by === 'project' ? 'project agent' : 'Koordinator'} answered it in the owner's name: ${overruled.answer}\nWhat follows is the owner's first word on the card since. If it overrules that answer, the answer missed what the owner wants: that may be a lasting preference the answering agent should have known.`
            : '',
          before ? `Before the owner wrote in it, the card's text read:\n${before}` : '',
          `The owner's ${INPUTS[kind]}: ${text}`,
          reply ? `The Koordinator replied: ${reply}` : '',
          rules.length ? `Rules recorded so far:\n${rules.map((r, n) => `${n + 1}. ${r.text}`).join('\n')}` : 'No rules recorded so far.',
          open.length ? `Proposals waiting for the owner (do not propose them again):\n${open.map((r) => `- ${r.text}`).join('\n')}` : '',
          rejected.length ? `Proposals the owner rejected (do not propose them again):\n${rejected.map((r) => `- ${r.text}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
    );
  }

  /** Cards in progress; with a repository, only those a card of it can collide with. */
  inProgress(repo?: string): Item[] {
    return this.o.board
      .snapshot()
      // approved work counts until it has landed: a PR not yet merged still holds its files
      // a prototype never lands, so it collides with nothing
      .items.filter((i) => ['working', 'waiting', 'inPr', 'approved'].includes(i.state) && i.kind !== 'project' && !i.prototypeOf && (!repo || i.repo === repo));
  }

  /**
   * Cards of the card's repository queued before it and still waiting: they go first, so a card
   * likely to conflict with one of them queues behind it instead of overtaking it.
   */
  ahead(card: Item): Item[] {
    const since = card.queue?.since;
    if (!since) return [];
    return this.o.board
      .snapshot()
      .items.filter((i) => i.id !== card.id && i.repo === card.repo && waits(i) && (i.queue!.since ?? '') < since)
      .sort((a, b) => (a.queue!.since ?? '').localeCompare(b.queue!.since ?? ''));
  }

  private async decide(cardId: string) {
    const card = this.o.board.item(cardId);
    // taken out of the queue or deleted while waiting for its turn
    if (!card || card.state !== 'planned' || !card.queue || !('checking' in card.queue)) return;
    const active = this.inProgress(card.repo);
    const ahead = this.ahead(card);
    if (!active.length && !ahead.length) {
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
      scope = await this.estimate(card, active, ahead);
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', `Koordinator konnte den Umfang nicht schätzen (${e instanceof Error ? e.message : String(e)}); die Karte startet trotzdem.`);
      scope = { files: [], conflictsWith: [], reason: '' };
    }
    if (!this.o.board.item(cardId)?.queue) return;
    this.o.board.work(cardId, { scope: JSON.stringify({ files: scope.files, reason: scope.reason }) });
    const behind = this.collisions(card, scope, [...active, ...ahead]);
    if (!behind.length) return this.startNow(cardId, `Kein Merge-Konflikt mit laufender Arbeit zu erwarten.${scope.reason ? ` ${scope.reason}` : ''}`);
    const names = behind
      .map((id) => {
        const a = ahead.find((x) => x.id === id);
        return a ? `„${a.title}“ (wartet selbst und ist vorher dran)` : `„${active.find((x) => x.id === id)?.title ?? id}“`;
      })
      .join(', ');
    const reason = scope.reason || 'Wahrscheinlich Merge-Konflikte mit laufender Arbeit.';
    this.setQueue(cardId, { behind, reason });
    this.o.board.log(cardId, 'state', 'obeya', `Koordinator: wartet auf ${names}. ${reason}`);
  }

  /** Decides on the workstreams of a project that came to the Koordinator together. */
  private async decideAll(projectId: string) {
    const items = this.o.board.snapshot().items;
    const batch = this.unplanned(projectId);
    if (!batch.length) return;
    if (batch.length === 1) {
      // one is judged as any card
      this.setQueue(batch[0]!.id, { checking: true });
      return this.decide(batch[0]!.id);
    }
    const ids = new Set(batch.map((w) => w.id));
    const repo = batch[0]!.repo;
    const active = this.inProgress(repo);
    // what waits already came first, as for a single card
    const ahead = items
      .filter((i) => i.repo === repo && !ids.has(i.id) && waits(i))
      .sort((a, b) => (a.queue!.since ?? '').localeCompare(b.queue!.since ?? ''));
    let plan: Planned[];
    try {
      plan = await this.schedule(this.o.board.item(projectId)!, batch, active, ahead);
    } catch (e) {
      // judged one by one instead: without the dependencies, but nothing is lost
      this.o.board.log(projectId, 'error', 'obeya', `Koordinator konnte die Workstreams nicht gemeinsam einplanen (${e instanceof Error ? e.message : String(e)}); er prüft sie einzeln.`);
      for (const w of batch) {
        this.setQueue(w.id, { checking: true });
        this.serial(() => this.decide(w.id));
      }
      return;
    }
    // taken out of the queue or started anyway meanwhile
    const still = (id: string) => {
      const q = this.o.board.item(id)?.queue;
      return !!q && 'checking' in q && q.together === projectId;
    };
    // the turn's order becomes the queue's: a workstream waits only for what comes before it, so
    // none wait for each other
    const times = batch.map((w) => w.queue!.since!);
    const before = new Set([...active, ...ahead].map((i) => i.id));
    const names = new Map([...active, ...ahead, ...batch].map((i) => [i.id, i.parent === projectId && i.label ? `${i.label} „${i.title}“` : `„${i.title}“`]));
    let started = 0;
    plan.forEach((p, n) => {
      const id = p.card;
      if (!still(id)) return before.add(id);
      const behind = p.waitsFor.filter((b) => before.has(b) && this.blocks(b));
      before.add(id);
      this.o.board.work(id, { scope: JSON.stringify({ files: p.files, reason: p.reason }), queue: JSON.stringify({ checking: true, together: projectId, since: times[n] }) });
      if (!behind.length) {
        started++;
        return this.startNow(id, `Gemeinsam mit den anderen Workstreams eingeplant; startet jetzt.${p.reason ? ` ${p.reason}` : ''}`);
      }
      const reason = p.reason || 'Wahrscheinlich Merge-Konflikte mit laufender Arbeit.';
      this.setQueue(id, { behind, reason });
      this.o.board.log(id, 'state', 'obeya', `Koordinator: wartet auf ${behind.map((b) => names.get(b) ?? b).join(', ')}. ${reason}`);
    });
    this.o.board.log(projectId, 'state', 'koordinator', `Eingeplant: ${started} von ${plan.length} Workstreams starten jetzt, die anderen warten.`);
  }

  /** Whether a card still holds others back: in progress, or waiting itself. */
  private blocks(id: string): boolean {
    const i = this.o.board.item(id);
    return !!i && (this.inProgress(i.repo).some((a) => a.id === id) || waits(i));
  }

  private startNow(cardId: string, why: string) {
    this.setQueue(cardId, null);
    this.o.board.log(cardId, 'state', 'obeya', `Koordinator: ${why}`);
    try {
      const card = this.o.board.item(cardId);
      if (card) this.o.repoFor(card).workers.start(cardId);
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', e instanceof Error ? e.message : String(e), e instanceof BadRequest ? e.code : undefined);
    }
  }

  /** Cards of the card's repository (in progress or queued ahead) whose changes the Koordinator expects to conflict with the card's. */
  collisions(card: Item, scope: Scope, others: Item[]): string[] {
    return others.filter((a) => a.repo === card.repo && scope.conflictsWith.includes(a.id)).map((a) => a.id);
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
    const items = this.o.board.snapshot().items;
    // a card queued behind another that waits itself holds on while that one waits, and once it
    // has started, until it has landed: a card started or judged again here stays in this set
    const active = new Set([...this.inProgress(), ...items.filter(waits)].map((i) => i.id));
    // the card waiting longest goes first: one queued later must not take its turn
    const waiting = items
      .filter((i) => i.state === 'planned' && i.queue && 'behind' in i.queue)
      .sort((a, b) => (a.queue!.since ?? '').localeCompare(b.queue!.since ?? ''));
    for (const w of waiting) {
      const q = w.queue as { behind: string[]; reason: string };
      const still = q.behind.filter((id) => active.has(id));
      if (still.length === q.behind.length) continue;
      if (still.length) {
        this.setQueue(w.id, { behind: still, reason: q.reason });
        continue;
      }
      // what it waited for is done; with nothing else running it starts, else it is judged again
      // against what runs now, which may have started after it was judged
      if (!this.inProgress(w.repo).length) {
        this.startNow(w.id, 'Worauf sie gewartet hat, ist erledigt; es geht los.');
        active.add(w.id);
      } else {
        this.setQueue(w.id, { checking: true });
        this.o.board.log(w.id, 'state', 'obeya', 'Koordinator: Worauf sie gewartet hat, ist erledigt; prüft neu gegen die laufende Arbeit.');
        this.serial(() => this.decide(w.id));
      }
    }
  }

  // ---------------------------------------------------------------- the estimate

  private estimate(card: Item, active: Item[], ahead: Item[] = []): Promise<Scope> {
    return new Promise((resolve, reject) => {
      let done = false;
      const tags = new Map([...active, ...ahead].map((a, n) => [`K${n + 1}`, a.id]));
      const session = this.o.runtime.start(
        {
          cwd: this.o.repoFor(card).path,
          readOnly: true,
          system: SYSTEM,
          tools: [
            {
              name: 'scope',
              description: 'Report the files the card will change, the cards in progress or queued ahead whose changes are likely to conflict with it on merge (their tags), and a one-sentence reason in German.',
              schema: { files: z.array(z.string()), conflicts_with: z.array(z.string()), reason: z.string() },
              run: (a) => {
                if (done) return 'Already reported.';
                done = true;
                resolve({
                  files: (a.files as string[]).slice(0, 200),
                  conflictsWith: (a.conflicts_with as string[]).map((t) => tags.get(t)).filter((x): x is string => !!x),
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
        this.brief(card, active, ahead, tags),
      );
    });
  }

  /** One turn over all the workstreams: in which order they go, and which wait for what. */
  private schedule(project: Item, batch: Item[], active: Item[], ahead: Item[]): Promise<Planned[]> {
    return new Promise((resolve, reject) => {
      let done = false;
      const tags = new Map([...active, ...ahead, ...batch].map((a, n) => [`K${n + 1}`, a.id]));
      const tagOf = (id: string) => [...tags].find(([, x]) => x === id)![0];
      const session = this.o.runtime.start(
        {
          cwd: this.o.repoFor(project).path,
          readOnly: true,
          system: SCHEDULE_SYSTEM,
          tools: [
            {
              name: 'schedule',
              description: 'Report every workstream once, in the order they should go: its tag, the files it will change, the tags of the cards it waits for (in progress, queued ahead, or workstreams earlier in your order; empty to start now), and a one-sentence reason in German.',
              schema: {
                workstreams: z.array(z.object({ card: z.string(), files: z.array(z.string()), waits_for: z.array(z.string()), reason: z.string() })),
              },
              run: (a) => {
                if (done) return 'Already reported.';
                const mine = new Set(batch.map((w) => w.id));
                const seen = new Set<string>();
                const plan: Planned[] = [];
                for (const w of a.workstreams as { card: string; files: string[]; waits_for: string[]; reason: string }[]) {
                  const id = tags.get(w.card);
                  if (!id || !mine.has(id) || seen.has(id)) continue;
                  seen.add(id);
                  plan.push({
                    card: id,
                    files: w.files.slice(0, 200),
                    waitsFor: w.waits_for.map((t) => tags.get(t)).filter((x): x is string => !!x && x !== id),
                    reason: String(w.reason).slice(0, 500),
                  });
                }
                const missing = batch.filter((w) => !seen.has(w.id));
                if (missing.length) return `Every workstream once, please: missing ${missing.map((w) => tagOf(w.id)).join(', ')}. Call schedule again with all of them.`;
                done = true;
                resolve(plan);
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
                reject(new Error('no schedule'));
              }
            }
          },
        },
        [
          `The project: "${project.title}"${project.plan ? `; plan doc ${project.plan.file}` : ''}.`,
          project.plan?.goal ? `Goal: ${project.plan.goal}` : '',
          `Its workstreams to schedule, in the plan's order:\n${batch
            .map((w) => `- ${tagOf(w.id)}: ${w.label ? `${w.label} ` : ''}"${w.title}"${w.body ? ` — ${w.body.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`)
            .join('\n')}`,
          ...this.others(project, active, ahead, tags),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    });
  }

  private brief(card: Item, active: Item[], ahead: Item[], tags: Map<string, string>): string {
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    const lines = [
      `The card to start: ${card.kind} "${card.title}".`,
      card.body.trim(),
      project?.plan ? `It is workstream ${card.label ?? ''} of the project "${project.title}"; plan doc ${project.plan.file}.` : '',
      ...this.others(card, active, ahead, tags),
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  /** The cards in progress and queued ahead, as a turn of the Koordinator reads them. */
  private others(card: Item, active: Item[], ahead: Item[], tags: Map<string, string>): string[] {
    const soft = this.o.repoFor(card).adapter.softPaths;
    const hard = (f: string) => !soft.some((s) => overlaps(normalize(f), s));
    const tagOf = (id: string) => [...tags].find(([, x]) => x === id)![0];
    return [
      active.length
        ? `Cards in progress:\n${active
            .map((a) => {
              const tag = tagOf(a.id);
              const changed = this.o.repoFor(a).workspaces.changes(a.id).filter((c) => hard(c.file));
              return [
                `- ${tag}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}`,
                `  expected to change: ${(a.scope ?? []).filter(hard).join(', ') || '(no estimate)'}`,
                `  changed so far: ${changed.length ? changed.slice(0, 60).map(describe).join(', ') : '(nothing yet)'}`,
              ].join('\n');
            })
            .join('\n')}`
        : 'No cards are in progress.',
      ahead.length
        ? `Cards queued ahead of this one (they wait for others and start before this card):\n${ahead
            .map((a) => {
              const q = a.queue!;
              const waitsFor = 'behind' in q ? q.behind.map((id) => `"${this.o.board.item(id)?.title ?? id}"`).join(', ') : '';
              return [
                `- ${tagOf(a.id)}: "${a.title}"${a.body ? ` — ${a.body.split('\n')[0]!.slice(0, 200)}` : ''}`,
                `  expected to change: ${(a.scope ?? []).filter(hard).join(', ') || '(no estimate)'}`,
                `  waits for: ${waitsFor || 'the Koordinator\'s decision'}`,
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

  /** A card keeps the time it came to the Koordinator for as long as it stays queued. */
  private setQueue(cardId: string, q: Queue | null) {
    const since = this.o.board.item(cardId)?.queue?.since ?? new Date().toISOString();
    this.o.board.work(cardId, { queue: q ? JSON.stringify({ ...q, since }) : null });
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

const SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. Your job here: before a card starts, estimate which files it will change, and judge whether running it next to the cards in progress is likely to end in merge conflicts. Only those keep it waiting; everything else should run in parallel. Cards queued ahead of it count too: they came first and start before it, so a card likely to conflict with one of them waits behind it rather than overtaking it.

Sharing a file is not a conflict. Git merges changes to different places of the same file cleanly: new strings, types, routes, tests or functions added next to others; edits in different functions. A conflict is likely when both cards change the same lines or the same function or block, when one rewrites, moves, renames or reformats code the other one edits, or when both change the same small, tightly packed section (one config entry, one signature that both extend). For a card in progress you see what it is expected to change and the places it has changed so far (line ranges in its branch, with the enclosing function); read the code there when you need to.

Read what you need in the repository (you cannot change files), then call scope exactly once:
- files: repository-relative paths the card will most likely change; a path ending in "/" stands for a directory. Be concrete; list new files where you expect them.
- conflicts_with: the tags of cards in progress or queued ahead whose changes will likely conflict with this card's on merge; empty when none. When in doubt, leave a card out: a conflict that happens anyway goes back to its worker to resolve.
- reason: one sentence in German for the owner: with a conflict, where the two cards change the same code; without one, which files they share, if any, and why that is fine. The owner does not know the tags: name cards by their title.
Keep it quick: this runs every time a card starts.
`.trim();

const SCHEDULE_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Several workers work at the same time, each in its own workspace, and their branches are rebased onto the main branch one after the other. The owner started all open workstreams of a project at once; you decide how they go. Read the plan doc and what you need in the repository (you cannot change files).

A workstream waits for another when:
- it depends on it: it builds on code, an API, data or a decision that the other one introduces, or the plan says it comes after it. It then waits until that one has landed.
- running both at once likely ends in merge conflicts: both change the same lines or the same function or block, one rewrites, moves, renames or reformats code the other one edits, or both change the same small, tightly packed section. Sharing a file is not a conflict: changes in different places of a file merge cleanly.
Everything else starts now and runs in parallel; parallel work is the point. When in doubt about a conflict, let it run: a conflict that happens anyway goes back to its worker. Cards in progress and queued ahead count as for any start: a workstream likely to conflict with one of them waits for it.

Call schedule exactly once, with every workstream once, in the order they should go (what starts now first, then each one after what it waits for):
- card: its tag.
- files: repository-relative paths it will most likely change; a path ending in "/" stands for a directory.
- waits_for: the tags of cards it waits for: cards in progress, queued ahead, or workstreams earlier in your order. Empty: it starts now. A workstream that waits starts by itself once what it waits for has landed.
- reason: one sentence in German for the owner: why it waits (the dependency, or where the changes collide), or, starting now, why it can run beside the others. The owner does not know the tags: name cards by their label or title.
`.trim();

const LEARN_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. You keep the owner's preference memory: short rules every agent follows, so the owner never has to say the same thing twice.

You get one thing the owner just said: to the agent on a card, in the text of a card they wrote, or to you, the Koordinator, in conversation. With it you see the card, what the owner said in the last days, the agent's last message before it, the rules recorded so far, and the proposals waiting for the owner or rejected by them. Decide whether it holds a lasting preference that should guide future work on other cards too: how to work, what to ask and what not, style, wording, testing, tools.

Signals for one:
- It is phrased generally: "immer", "nie", "ab jetzt", "grundsätzlich", "jedes Mal", "bei so etwas".
- It corrects how an agent works rather than what it builds: the agent asked what it could have decided itself, skipped a check, wrote in a style the owner does not want, went beyond its task. The agent's last message shows what the owner reacts to.
- It repeats something the owner said before, on this card or another: said twice, it should not need saying a third time.
- It overrules an answer given in the owner's name: the agent that answered lacked a rule.
Not a preference: deciding the case at hand (an option, a name, a date, what this card should do), approving, asking how things stand, correcting a fact. Most of what the owner says is like that: then call nothing.

Make few, good proposals: at most one per input, and only one you expect the owner to accept; when unsure, wait until the owner says it again. Call propose with a short, general rule in German, in the owner's terms and without the occasion ("Beschriftungen: präzise vor kurz.", "Abrechnungsänderungen bekommen immer das Codex-Review."); the owner accepts or rejects it before it applies. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either.
`.trim();

/** After how many of the owner's inputs the Rückschau runs, at most how many rules it proposes, and how much history it reads. */
export const REVIEW_EVERY = 20;
const REVIEW_PROPOSALS = 3;
const REVIEW_HISTORY = 300;
/** The settings that keep the Rückschau's count across restarts, and when its history begins. */
const REVIEW_COUNT = 'review_inputs';
const REVIEW_SINCE = 'review_since';

const REVIEW_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. You keep the owner's preference memory: short rules every agent follows, so the owner never has to say the same thing twice.

This is the Rückschau. You get what happened on the canvas since the last one, oldest first: what the owner said and clicked (notes, answers, feedback, approvals, starts against your advice, cards and proposals they deleted or dismissed, commands they took back, rule proposals they accepted or rejected), and what the agents asked and handed over. Each thing the owner said was already read on its own; look for what only shows across several moments and cards:
- the same correction or feedback on different cards;
- the same kind of question, answered the same way each time;
- proposals of one kind the owner always dismisses, or always takes;
- your advice to wait overruled again and again;
- answers given in the owner's name that the owner then overruled;
- commands taken back, and what the owner did instead.
Clicks without words count here: what the owner does again and again says what they want as much as what they say.

Propose a rule only for a pattern seen at least twice, on different cards, that you expect the owner to accept; most of the time there is none. Call propose for each, at most ${REVIEW_PROPOSALS}: rule, a short, general rule in German in the owner's terms and without the occasion ("Beschriftungen: präzise vor kurz.", "Abrechnungsänderungen bekommen immer das Codex-Review."); why, one short sentence in German for the owner (under 150 characters) naming the cards or moments it rests on. If it refines or contradicts a recorded rule, pass that rule's number as replaces. Do not propose what a recorded rule or a waiting proposal already covers, nor a rejected proposal again, in other words either. Then call done.
`.trim();

/** How the Rückschau names who did something on a card, and what. */
const WHO: Record<CardEvent['author'], string> = {
  owner: 'the owner',
  worker: 'the agent',
  explorer: 'the idea agent',
  project: 'the project agent',
  koordinator: 'the Koordinator',
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
  say: 'to the Koordinator',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** How the learner hears each kind of input. */
const INPUTS: Record<OwnerInput, string> = {
  answer: 'answer',
  note: 'note to the worker',
  feedback: 'feedback on the finished work',
  idea: 'words in the discussion of an idea',
  command: 'words to the Koordinator, which it carried out',
  talk: 'question or remark to the Koordinator',
  card: 'text of a card they wrote, the task for an agent',
};

const CUT_SYSTEM = `
You are the Koordinator of Obeya, a canvas on which the owner directs coding agents. Several workers run at the same time, each on one card in its own workspace; cards whose changes would conflict on merge (the same code in the same files) have to wait for each other. The owner asks you to cut a card into work packages that can run in parallel.

Read what you need in the repository (you cannot change files). Then either call packages or keep:
- packages: 2 to 6 cards that together do exactly what the card asks, each shippable and testable on its own, touching different files wherever possible. Each body says what to do and how to verify it, so a worker needs no other context. files: the repository-relative paths each will change ("dir/" for a directory). reason: one sentence in German on how you cut.
- keep: when the card is small, or its parts cannot run apart without stepping on each other.
Do not add scope the card does not ask for.
`.trim();

/** A card the Koordinator holds back or is judging, before it starts. */
const waits = (i: Item) => i.state === 'planned' && !!i.queue && ('behind' in i.queue || 'checking' in i.queue);

/** A changed file with the places changed in it: "src/a.ts (lines 12-20 in function f; 40)", or "(new)". */
const describe = (c: Change) =>
  `${c.file} (${c.regions.length ? (c.regions[0] === 'deleted' ? 'deleted' : `lines ${c.regions.slice(0, 8).join('; ')}${c.regions.length > 8 ? '; …' : ''}`) : 'new'})`;

const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** Two paths overlap when they are equal or one is a directory (trailing `/`) containing the other. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
