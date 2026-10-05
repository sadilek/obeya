// One canvas and everything that works on it: its repositories (each with adapter, workspaces,
// workers, project agents and PR watcher), the board, the Koordinator and the voice commands.

import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pickAdapter } from '../adapters';
import { Answers } from './answers';
import { repoName } from '../adapters/generic';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import type { CanvasConfig, CardAction, CardPatch, ConfigProblemCode, Item, RepoConfig, RepoRef } from '../core/types';
import { BadRequest, Board, type StoredIdea } from './board';
import { type Command, Commander } from './commands';
import type { Config } from './config';
import type { Store } from './db';
import { Explorers } from './explorers';
import { Images, MAX_IMAGES } from './images';
import type { Forge } from './forge';
import { Koordinator } from './koordinator';
import { PrWatcher } from './pr-watcher';
import { ProjectAgents } from './project-agents';
import { readPlanDocs, repoInfo, watchPlanDocs } from './repo';
import type { AgentRuntime } from './runtime';
import { changesCode } from './self-update';
import { Sharing, shareArgv } from './share';
import { type DueRestart, Workers } from './workers';
import { type Landed, Workspaces } from './workspaces';

export type { CanvasConfig, RepoConfig };

export interface CanvasDeps {
  store: Store;
  /** Obeya's data directory (workspaces live under it). */
  home: string;
  runtime: AgentRuntime;
  /** Runs the cards' workers; `runtime` when left out. */
  workerRuntime?: AgentRuntime;
  forge: Forge;
  permissionMode?: 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'default';
  /** Watch plan docs and pull requests; off in tests. */
  watch?: boolean;
  /** How long a voice command waits for undo. */
  commandDelayMs?: number;
  /** The checkout this Obeya runs from, when it starts again for new code there (self-update.ts). */
  ownCheckout?: string | null;
  /** Obeya's configuration, which the Koordinator reads and changes on the owner's word. */
  config?: Config;
  /** How long the owner stops typing in a card before what they wrote counts as written. */
  writingPauseMs?: number;
}

export interface RepoRuntime {
  ref: RepoRef;
  info: RepoInfo;
  adapter: RepoAdapter;
  /** The command that shares its video demos (the configuration's, else the adapter's); null where they are exported. */
  share: string[] | null;
  workspaces: Workspaces;
  workers: Workers;
  projectAgents: ProjectAgents;
}

export class CanvasRuntime {
  readonly board: Board;
  readonly koordinator: Koordinator;
  readonly commander: Commander;
  readonly explorers: Explorers;
  /** Screenshots the owner attaches to what they write. */
  readonly images: Images;
  readonly answers: Answers;
  /** Video demos shared with colleagues, through the share command of the card's repository. */
  readonly sharing: Sharing;
  readonly repos: RepoRuntime[] = [];
  private stops: (() => void)[] = [];
  private prWatchers: PrWatcher[] = [];
  /** Cards the owner is writing in, with their text before; a pause in typing hands it to the learner. */
  private writing = new Map<string, { before: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(config: CanvasConfig, private deps: CanvasDeps) {
    const resolved = resolveCanvas(config, deps.store);
    const { id, name, infos, adapters, refs, stored } = resolved;
    config = resolved.config;
    const home = refs[0]!.id;
    const images = (this.images = new Images(join(deps.home, 'images', id)));
    this.board = new Board(
      deps.store,
      { id, name, repos: refs },
      () =>
        infos.flatMap((info, i) =>
          readPlanDocs(info.path, adapters[i]!).map((d) => (refs[i]!.id === home ? d : { ...d, file: `${refs[i]!.id}:${d.file}` })),
        ),
      images,
    );
    const board = this.board;
    const imageFiles = (ids: string[] = []) => ids.flatMap((i) => images.path(i) ?? []);
    if (!stored) deps.store.setSetting(id, 'home_repo', home);
    const preferences = () => board.preferencesText();

    // the Koordinator needs the workers, and the workers ask it: it is set right after them
    let koordinator!: Koordinator;
    config.repos.forEach((rc, i) => {
      const info = infos[i]!;
      const adapter = adapters[i]!;
      const ref = refs[i]!;
      const isHome = ref.id === home;
      const share = shareCommandOf(rc, info, adapter);
      const workspaces = new Workspaces(deps.store, id, {
        mode: adapter.workspaces,
        repoPath: info.path,
        dir: isHome ? join(deps.home, 'workspaces', id) : join(deps.home, 'workspaces', id, ref.id),
        repo: isHome ? null : ref.id,
      });
      // a clone registered for this repository must be one of it
      for (const w of rc.workspaces ?? []) workspaces.register(resolve(w), [info.remote, info.path].filter((x): x is string => !!x));
      // landing on main needs clones that see the local main; otherwise they track the remote
      if (rc.clones) workspaces.ensureClones(adapter.land === 'main' || !info.remote ? info.path : info.remote, rc.clones);
      const projectAgents = new ProjectAgents(board, deps.runtime, info.path, preferences);
      const workers = new Workers({
        board,
        runtime: deps.workerRuntime ?? deps.runtime,
        workspaces,
        adapter,
        shares: !!share,
        repo: ref.id,
        preferences,
        onOwnerInput: (card, kind, text, context) => koordinator.learn(card, kind, text, context),
        advisor: (card) => {
          const project = card.parent ? board.item(card.parent) : undefined;
          return project
            ? { by: 'project', ask: (q) => projectAgents.ask(project, card, q) }
            : { by: 'koordinator', ask: (q) => koordinator.ask(card, q) };
        },
        onPrOpened: (cardId) => this.sharing.prOpened(cardId),
        onPrototype: (prototype, summary, demo) => this.prototypeReady(prototype, summary, demo),
        onPrototypeAnswer: (prototype, question, answer, by) => this.prototypeAnswered(prototype, question, answer, by),
        ...(deps.ownCheckout && sameDir(deps.ownCheckout, info.path) ? { restartsFor: (l: Landed) => changesCode(info.path, l.from, l.to) } : {}),
        imageFiles,
        ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
      });
      this.repos.push({ ref, info, adapter, share, workspaces, workers, projectAgents });
      if (deps.watch) {
        this.stops.push(watchPlanDocs(info.path, adapter, () => board.docsChanged()));
        if (adapter.land === 'pr') {
          const watcher = new PrWatcher(board, workers, deps.forge, (cardId) => board.row(cardId).workspace ?? info.path, adapter.prNoise, ref.id);
          watcher.start();
          this.prWatchers.push(watcher);
          this.stops.push(() => watcher.stop());
        }
      }
    });
    for (const r of this.repos) r.workers.resumeAll();
    koordinator = this.koordinator = new Koordinator({
      board,
      runtime: deps.runtime,
      preferences,
      home: this.repos[0]!.info.path,
      repoFor: (card) => {
        const r = this.repoOf(card);
        return { workers: r.workers, workspaces: r.workspaces, adapter: r.adapter, path: r.info.path };
      },
    });
    koordinator.resume();
    this.explorers = new Explorers({
      board,
      runtime: deps.runtime,
      preferences,
      pathFor: (card) => this.repoOf(card).info.path,
      onOwnerInput: (card, text) => koordinator.learn(card, 'idea', text),
      imageFiles,
    });
    this.explorers.resumeAll();
    this.answers = new Answers({
      board,
      runtime: deps.runtime,
      preferences,
      pathFor: (card) => (card ? this.repoOf(card) : this.repos[0]!).info.path,
      startBrief: (card) => this.repoOf(card).workers.startBrief(card),
      projectAgent: (project) => this.repoOf(project).projectAgents,
      onAnswer: (question, answer) => this.commander.tell(`The answer you looked up for the owner's question „${question}“ came in and was shown to them: ${answer.slice(0, 1500)}`),
    });
    this.commander = new Commander({
      board,
      runtime: deps.runtime,
      cwd: this.repos[0]!.info.path,
      execute: (c) => this.run(c),
      imageFiles,
      lookUp: (talk) => this.answers.lookUp(talk),
      onOwnerInput: (card, kind, text, reply) => this.koordinator.learn((card && board.item(card)) || null, kind, text, { reply }),
      ...(deps.config ? { config: deps.config } : {}),
      ...(deps.commandDelayMs !== undefined ? { delayMs: deps.commandDelayMs } : {}),
    });
    this.answers.resume();
    this.sharing = new Sharing({
      board,
      runtime: deps.runtime,
      home: deps.home,
      forge: deps.forge,
      commandFor: (card) => {
        const r = this.repoOf(card);
        return r.share ? { command: r.share, cwd: r.info.path } : null;
      },
    });
    this.sharing.resume();
  }

  get id() {
    return this.board.canvas.id;
  }

  /** The repository a card belongs to. */
  repoOf(card: Item | string): RepoRuntime {
    const item = typeof card === 'string' ? this.board.item(card) : card;
    if (!item) throw new BadRequest('unknownCard', 'unknown card');
    return this.repos.find((r) => r.ref.id === item.repo) ?? this.repos[0]!;
  }

  /** The owner edits a card; what they write in it is offered for learning once they have written it. */
  patch(cardId: string, p: CardPatch) {
    const { body: before, state } = this.board.row(cardId);
    this.board.patch(cardId, p);
    if (p.body !== undefined) {
      const w = this.writing.get(cardId);
      clearTimeout(w?.timer);
      this.writing.set(cardId, { before: w?.before ?? before ?? '', timer: setTimeout(() => this.written(cardId), this.deps.writingPauseMs ?? 60_000) });
    }
    // an idea's agent starts from the card's text, and opens the discussion with it
    if (p.state === 'idea' && state !== 'idea') {
      this.written(cardId);
      this.explorers.open(cardId);
    }
  }

  /** The owner has written in the card (a pause, or they act on it): the learner gets what they wrote. */
  private written(cardId: string) {
    const w = this.writing.get(cardId);
    if (!w) return;
    clearTimeout(w.timer);
    this.writing.delete(cardId);
    const card = this.board.item(cardId);
    const [text, before] = [card?.body.trim() ?? '', w.before.trim()];
    if (card && text && text !== before) this.koordinator.learn(card, 'card', text, before ? { before } : {});
  }

  /** The owner accepts a rule proposal, maybe in their words or for another place (a repository's CLAUDE.md, or none). */
  acceptRule(id: number, text?: string, target?: string | null) {
    this.board.acceptProposal(id, text, target);
    this.fileRules();
  }

  /**
   * A rule the owner gives outright, by „Merk dir: …“ or in the sheet: one of theirs, active at once,
   * or with `repos` one for those repositories' CLAUDE.md, which goes straight into their cards
   * „CLAUDE.md ergänzen“. `replaces`: the active rule it changes; `card`: the card open when it was said.
   */
  remember(text: string, o: { repos?: string[]; replaces?: number; card?: string } = {}) {
    // the rule it changes may have been deleted in the meantime: then it is a new one
    const replaces = o.replaces !== undefined && this.board.preferences('active').some((p) => p.id === o.replaces) ? o.replaces : undefined;
    if (o.repos?.length) {
      this.board.fileRule(text, o.repos, o.card ?? null, replaces);
      this.fileRules();
    } else if (replaces !== undefined) this.board.setPreference(replaces, text);
    else this.board.addPreference(text, o.card ?? null);
  }

  rejectRule(id: number) {
    this.board.rejectProposal(id);
    this.fileRules();
  }

  /**
   * Once no proposal waits any more, the cards „CLAUDE.md ergänzen“ start, with all the rules
   * accepted for them: a waiting proposal might yet become one of theirs.
   */
  private fileRules() {
    if (this.board.preferences('proposed').length) return;
    for (const r of this.board.canvas.repos) {
      const card = this.board.collecting(r.id);
      if (card) this.koordinator.request(card.id);
    }
  }

  /** The owner clicks in the card's panel: a click without words the learner reads counts towards the Rückschau. */
  press(cardId: string, a: CardAction) {
    const r = this.act(cardId, a);
    if (!(['message', 'answer', 'discuss'].includes(a.action) && 'text' in a && a.text?.trim())) this.koordinator.noticed();
    return r;
  }

  /** An owner action from the card's panel, or from a spoken command. */
  act(cardId: string, a: CardAction) {
    this.written(cardId);
    const text = 'text' in a ? (a.text ?? '') : '';
    const images = this.images.resolve('images' in a ? a.images : undefined);
    // a prototype may leave it to the idea's brief what it shows; a screenshot may speak for itself
    if ('text' in a && (typeof text !== 'string' || (!text.trim() && a.action !== 'prototype' && !images.length) || text.length > 20000))
      throw new BadRequest('emptyText', 'text must be a non-empty string');
    switch (a.action) {
      case 'start':
        return this.koordinator.request(cardId);
      case 'force':
        return this.koordinator.force(cardId);
      case 'dequeue':
        return this.koordinator.dequeue(cardId);
      case 'split':
        return this.koordinator.split(cardId);
      case 'stop':
        return this.repoOf(cardId).workers.stop(cardId);
      case 'message':
        return this.repoOf(cardId).workers.message(cardId, text.trim(), images, !!a.spoken);
      case 'answer':
        return this.repoOf(cardId).workers.answer(cardId, text.trim(), 'owner', images, !!a.spoken);
      case 'approve':
        return this.repoOf(cardId).workers.approve(cardId);
      case 'accept':
        // accepting a proposal is the owner's go unless they keep it to edit first: the card goes to
        // the Koordinator like a started one
        this.board.accept(cardId);
        if (a.start !== false) this.koordinator.request(cardId);
        return;
      case 'dismiss':
        if (this.board.row(cardId).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return this.board.remove(cardId);
      case 'discuss':
        return this.explorers.discuss(cardId, text.trim(), !!a.spoken, images);
      case 'build':
        return this.build(cardId);
      case 'planDoc':
        return this.planDoc(cardId);
      case 'park':
      case 'drop':
        return this.shelve(cardId, a.action);
      case 'prototype':
        return this.prototype(cardId, text.trim());
      case 'buildPrototype':
        return this.buildOnPrototype(cardId);
      case 'discard':
        return this.repoOf(this.prototypeCard(cardId)).workers.endPrototype(cardId, 'discarded');
      case 'share':
        return this.sharing.share(cardId);
      case 'unshare':
        return this.sharing.unshare(cardId);
      default:
        throw new BadRequest('invalid', 'unknown action');
    }
  }

  /** Deletes a card of the owner's, stopping its worker first; a prototype is discarded into the archive instead. */
  remove(cardId: string) {
    clearTimeout(this.writing.get(cardId)?.timer);
    this.writing.delete(cardId);
    const { state, landed, workspace, prototype_of } = this.board.row(cardId);
    if (prototype_of) return this.repoOf(cardId).workers.endPrototype(cardId, 'discarded');
    if (state === 'working' || state === 'waiting' || (landed && workspace)) this.repoOf(cardId).workers.stop(cardId);
    if (state === 'idea') this.explorers.close(cardId);
    this.board.remove(cardId);
  }

  // ---------------------------------------------------------------- ideas

  /**
   * The idea is built as it stands: its brief becomes the card's task, and the card goes to the
   * Koordinator to start. A prototype still running for it is discarded: what is built now is the brief.
   */
  private build(cardId: string) {
    const card = this.settledIdea(cardId);
    this.decided(card, { answer: 'So bauen, wie der Stand der Idee sagt.', log: 'So bauen: Der Stand der Idee ist der Auftrag.' });
    this.koordinator.request(cardId);
  }

  /**
   * The idea is built on this prototype: the prototype's workspace and branch become the idea's,
   * whose worker goes on from there with the brief, the prototype's handover and the owner's answers
   * on it. The prototype goes into the archive as built, the idea's other prototypes as discarded.
   */
  private buildOnPrototype(prototypeId: string) {
    const prototype = this.prototypeCard(prototypeId);
    const idea = this.settledIdea(prototype.prototypeOf!);
    const { workers } = this.repoOf(prototype);
    const { path, branch } = workers.buildOn(prototype.id, idea);
    this.board.work(idea.id, { workspace: path, branch, built_on: prototype.id });
    this.decided(idea, { answer: `So bauen, auf Prototyp „${prototype.title}“.`, log: `So bauen, auf dem Prototyp „${prototype.title}“: Sein Branch ist jetzt der dieser Aufgabe.` });
    this.koordinator.request(idea.id);
  }

  /** The idea is decided for building: its agent's conversation ends, the brief becomes the task, the other prototypes are discarded. */
  private decided(idea: Item, how: { answer: string; log: string }) {
    const { brief } = this.board.idea(idea.id);
    this.explorers.close(idea.id);
    for (const p of this.board.snapshot().items.filter((i) => i.prototypeOf === idea.id)) this.repoOf(p).workers.endPrototype(p.id, 'discarded', 'obeya');
    this.board.work(idea.id, { state: 'planned', ...(brief.trim() ? { body: brief.trim() } : {}) });
    // the screenshots the owner showed in the discussion belong to what is built
    const shown = this.board.events(idea.id).flatMap((e) => (e.kind === 'talk' && e.author === 'owner' ? (e.images ?? []) : []));
    if (shown.length) this.addTaskImages(idea.id, shown);
    this.board.decide({ project_id: null, card_id: idea.id, question: `Idee „${idea.title}“: wie weiter?`, answer: how.answer, by: 'owner' });
    this.board.log(idea.id, 'state', 'owner', how.log);
  }

  /**
   * A big idea becomes a project: a worker writes its plan doc on the idea's card at once, and once
   * the doc lands, the project takes the idea's place.
   */
  private planDoc(cardId: string) {
    const card = this.settledIdea(cardId);
    const idea = this.board.idea(cardId);
    const dir = this.repoOf(card).adapter.planDocs.dir;
    this.explorers.close(cardId);
    this.board.work(cardId, {
      state: 'planned',
      idea: JSON.stringify({ ...idea, project: true } satisfies StoredIdea),
      body: [
        `Schreibe aus dem Stand dieser Idee ein Plan-Doc in \`${dir}/\`, nach den Konventionen des Repositorys (vorhandene Plan-Docs als Vorbild). Es braucht ein \`## Ziel\` (oder \`## Goal\`) und eine Checkliste unter \`## Workstreams\` (\`- [ ] **W1:** Titel. Details\`), in Pakete geschnitten, die einzeln landen können; dann zeigt Obeya es als Projekt, das an die Stelle dieser Idee tritt. Baue nichts davon; nur das Plan-Doc (und ein Verweis darauf, wo das Repository Plan-Docs verlinkt).`,
        `Idee: „${card.title}“`,
        idea.brief.trim() || card.body.trim(),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.board.decide({ project_id: null, card_id: cardId, question: `Idee „${card.title}“: wie weiter?`, answer: 'Als Projekt: erst ein Plan-Doc mit Workstreams.', by: 'owner' });
    this.board.log(cardId, 'state', 'owner', 'Als Projekt: Ein Agent schreibt das Plan-Doc; ist es gelandet, tritt das Projekt an die Stelle der Idee.');
    this.koordinator.request(cardId);
  }

  /** Parked or dropped, the idea stays on the canvas with its brief; what its agent has not answered yet waits for the conversation to go on. */
  private shelve(cardId: string, how: 'park' | 'drop') {
    const card = this.ideaCard(cardId);
    this.explorers.interrupt(cardId, how === 'park' ? 'parked' : 'dropped');
    this.board.setIdea(cardId, { status: how === 'park' ? 'parked' : 'dropped' });
    if (how === 'drop') this.board.decide({ project_id: null, card_id: cardId, question: `Idee „${card.title}“: wie weiter?`, answer: 'Verworfen.', by: 'owner' });
    this.board.log(cardId, 'state', 'owner', how === 'park' ? 'Geparkt.' : 'Verworfen.');
  }

  /**
   * A worker builds a throwaway prototype for the idea, in its own workspace; it never lands itself.
   * Several may run side by side, each with its approach in its title.
   */
  private prototype(cardId: string, what: string) {
    const card = this.ideaCard(cardId);
    const approach = approachOf(what);
    const base = `Prototyp: ${card.title}${approach ? ` – ${approach}` : ''}`;
    const taken = new Set((this.board.item(cardId)?.prototypes ?? []).map((p) => p.title));
    let title = base;
    for (let n = 2; taken.has(title); n++) title = `${base} (${n})`;
    const prototype = this.board.addPrototype(cardId, title, what || 'Zeige die Idee so, wie der Stand der Idee sie beschreibt.');
    try {
      this.repoOf(prototype).workers.start(prototype.id);
    } catch (e) {
      this.board.remove(prototype.id);
      throw e;
    }
    // the owner now waits for the prototype, not the other way round; the agent's reply to its result gives the turn back
    this.board.setIdea(cardId, { yourTurn: false });
    this.board.log(cardId, 'state', 'owner', `Prototyp „${title}“ gestartet${what ? `: ${what.replace(/[.!?]$/, '')}` : ''}.`);
  }

  /** A prototype handed over: its demo shows on the idea beside those of the other prototypes, and the idea's agent hears what it found. */
  private prototypeReady(prototype: Item, summary: string, demo: string | undefined) {
    const idea = this.board.item(prototype.prototypeOf!);
    if (!idea) return;
    this.board.log(idea.id, 'state', 'worker', `Prototyp „${prototype.title}“ fertig${demo ? '; seine Demo liegt hier' : ''}.`);
    if (idea.state === 'idea')
      this.explorers.tell(
        idea.id,
        `A worker built the throwaway prototype “${prototype.title}” for this idea. Its summary:\n\n${summary}\n\nTake what it showed and what it means for the idea into the brief, then reply to the owner in a sentence or two.`,
      );
  }

  /** A question on a prototype was answered: the idea's agent takes it into the brief, so the idea does not ask it again. */
  private prototypeAnswered(prototype: Item, question: string, answer: string, by: 'owner' | 'project' | 'koordinator') {
    const who = by === 'owner' ? 'The owner' : 'The Koordinator, on the owner’s behalf,';
    this.explorers.tell(
      prototype.prototypeOf!,
      `On the prototype “${prototype.title}”, its worker asked: „${question}“\n\n${who} answered: ${answer}\n\nTake what this settles into the brief (decisions, open questions), so it is not asked again. Do not reply to the owner for it; end your turn without a reply unless it raises something they must decide now.`,
      true,
    );
  }

  private prototypeCard(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (!card.prototypeOf) throw new BadRequest('notPrototype', 'the card is not a prototype');
    return card;
  }

  private ideaCard(cardId: string): Item {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (card.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return card;
  }

  /** An idea to build or plan: not while its agent works on a reply, which will change the brief the owner decides on. */
  private settledIdea(cardId: string): Item {
    const card = this.ideaCard(cardId);
    if (card.idea?.thinking) throw new BadRequest('ideaThinking', 'the idea’s agent is still working on its reply; decide once it is there');
    return card;
  }

  /** A voice (or typed) command, once its undo window has passed. */
  run(c: Command) {
    switch (c.do) {
      case 'newCard': {
        const at = c.from ? { from: c.from } : this.board.freeSpot();
        const card = this.board.create({
          title: c.title,
          body: c.body,
          ...(c.repo ? { repo: c.repo } : {}),
          ...(c.images?.length ? { images: c.images } : {}),
          ...at,
        });
        this.board.log(card.id, 'state', 'owner', 'Per Sprache angelegt.');
        if (c.start) this.koordinator.request(card.id);
        return;
      }
      case 'newIdea': {
        const card = this.board.create({ idea: true, title: c.title, body: c.body, ...(c.repo ? { repo: c.repo } : {}), ...this.board.freeSpot() });
        this.board.log(card.id, 'state', 'owner', 'Per Sprache angelegt.');
        // the agent opens the discussion with what the owner said
        this.explorers.discuss(card.id, c.body.trim() || c.title, true, this.images.resolve(c.images));
        return;
      }
      case 'discuss':
        return this.act(c.card, { action: 'discuss', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'prototype':
        return this.act(c.card, { action: 'prototype', text: c.text });
      case 'buildPrototype':
      case 'discard':
        return this.act(c.card, { action: c.do });
      case 'build':
      case 'planDoc':
      case 'park':
      case 'drop':
        return this.act(c.card, { action: c.do });
      case 'start':
      case 'force':
        // screenshots said with the start belong to the task, so the worker gets them with it
        if (c.images?.length) this.addTaskImages(c.card, c.images);
        return this.act(c.card, { action: c.do });
      case 'note':
      case 'feedback':
        return this.act(c.card, { action: 'message', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'answer':
        return this.act(c.card, { action: 'answer', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'approve':
      case 'accept':
      case 'dismiss':
      case 'split':
      case 'stop':
        return this.act(c.card, { action: c.do });
      case 'configure':
        return this.deps.config?.save(c.canvases);
      case 'remember':
        return this.remember(c.text, c);
    }
  }

  /** Adds screenshots to a card's task, keeping the latest when there are more than a message takes. */
  private addTaskImages(cardId: string, images: string[]) {
    const had = this.board.item(cardId)?.images ?? [];
    this.board.work(cardId, { images: JSON.stringify([...had.filter((i) => !images.includes(i)), ...images].slice(-MAX_IMAGES)) });
  }

  /** The cards whose worker is in the middle of a turn, which a restart would cut off. */
  busy(): string[] {
    return this.repos.flatMap((r) => r.workers.busyCards());
  }

  /** The owner came back to a page of this canvas: its open pull requests are looked at now, and the versions of its share commands. */
  ownerBack() {
    for (const w of this.prWatchers) w.soon();
    this.sharing.soon();
  }

  /** Obeya is about to restart, or no longer is: the workers hear so and pause for it. */
  restartDue(due: DueRestart | null) {
    for (const r of this.repos) r.workers.restartDue(due);
  }

  shutdown() {
    for (const [, w] of this.writing) clearTimeout(w.timer);
    for (const stop of this.stops) stop();
    for (const r of this.repos) r.workers.shutdown();
    this.explorers.shutdown();
  }
}

/** A prototype's approach, for its title: the first sentence of what it is to show, kept short. */
export function approachOf(what: string, max = 40): string {
  const text = what.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  const first = (text.match(/^.+?[.!?;:](?=\s|$)/)?.[0] ?? text).replace(/[.;:]$/, '');
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

/** Why a canvas's configuration does not work; `repo` is the index of the repository in question. */
export class ConfigError extends Error {
  constructor(
    readonly code: ConfigProblemCode,
    message: string,
    readonly repo?: number,
  ) {
    super(message);
  }
}

/**
 * What a canvas's configuration amounts to, without touching anything: its repositories (home
 * first), their adapters and ids, and the canvas's id and name. Throws a ConfigError.
 */
export function resolveCanvas(config: CanvasConfig, store: Store) {
  if (!config.repos.length) throw new ConfigError('noRepo', 'a canvas needs at least one repository');
  let infos = config.repos.map((r, i) => {
    try {
      return repoInfo(resolve(r.path));
    } catch {
      throw new ConfigError('notRepo', `${r.path} is not a git repository`, i);
    }
  });
  let adapters = config.repos.map((r, i) => {
    try {
      return pickAdapter(infos[i]!, r.adapter);
    } catch (e) {
      throw new ConfigError('unknownAdapter', e instanceof Error ? e.message : String(e), i);
    }
  });
  let refs = uniqueRefs(config.repos, infos, adapters);
  const id = config.id ? slug(config.id) : config.name ? slug(config.name) : adapters[0]!.canvasId(infos[0]!);
  // the home repository is fixed when the canvas is first served: bare plan references, cards
  // without a repository and the home workspace directory are its, whatever the order later
  const stored = store.setting(id, 'home_repo');
  if (stored && stored !== refs[0]!.id) {
    const at = refs.findIndex((r) => r.id === stored);
    if (at < 0) throw new ConfigError('homeMissing', `canvas ${id}: its home repository "${stored}" is not configured; list it (first or anywhere)`);
    const order = [at, ...refs.map((_, i) => i).filter((i) => i !== at)];
    config = { ...config, repos: order.map((i) => config.repos[i]!) };
    infos = order.map((i) => infos[i]!);
    adapters = order.map((i) => adapters[i]!);
    refs = uniqueRefs(config.repos, infos, adapters);
  }
  const name = config.name ?? adapters[0]!.canvasName(infos[0]!);
  return { config, id, name, infos, adapters, refs, stored };
}

/** Repository ids unique on the canvas: the repository's name, with a number when two share one. */
function uniqueRefs(configs: RepoConfig[], infos: RepoInfo[], adapters: RepoAdapter[]): RepoRef[] {
  const seen = new Map<string, number>();
  return infos.map((info, i) => {
    const base = slug(repoName(info)) || `repo${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}${n}`,
      name: i === 0 ? adapters[0]!.canvasName(info) : repoName(info),
      path: info.path,
      branch: info.branch,
      ...(shareCommandOf(configs[i]!, info, adapters[i]!) ? { share: true } : {}),
    };
  });
}

/** A repository's share command: the configuration's, else the adapter's; null without either. */
function shareCommandOf(config: RepoConfig, info: RepoInfo, adapter: RepoAdapter): string[] | null {
  if (config.share?.trim()) return shareArgv(config.share, info.path);
  return adapter.demo?.share ?? null;
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const slug = (s: string) =>
  s
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-|-$/g, '');
