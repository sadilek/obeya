// One canvas and everything that works on it: its repositories (each with adapter, workspaces,
// workers, project agents and PR watcher), the board, the Koordinator and the voice commands.

import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adapterProblems, builtInAdapter, pickAdapter, repoAdapterTree } from '../adapters';
import { Answers } from './answers';
import { repoName } from '../adapters/generic';
import type { DemoSite, RepoAdapter, RepoInfo } from '../adapters/types';
import type { Language } from '../core/locale';
import { AGENT_DEFAULTS, agentListens, type AgentRole, type AgentSetting, buildableOn, type CanvasConfig, prototypeWorkstream, type CardAction, type CardPatch, type ConfigProblemCode, finished, type Item, type RepoConfig, type RepoRef } from '../core/types';
import { BadRequest, Board, type StoredIdea } from './board';
import { type Command, Commander } from './commands';
import type { Config } from './config';
import type { Store } from './db';
import { Explorers } from './explorers';
import { Images, MAX_IMAGES } from './images';
import type { Forge } from './forge';
import { Koordinator } from './koordinator';
import { WorkRetro } from './work-retro';
import { PrWatcher } from './pr-watcher';
import { ReadTree } from './read-tree';
import { Revisions } from './revisions';
import { ProjectAgents } from './project-agents';
import { readPlanDocs, repoInfo, watchPlanDocs } from './repo';
import { type AgentRuntime, withAgentSetting } from './runtime';
import { changesCode } from './self-update';
import { Sharing, shareArgv } from './share';
import { siteMissing, siteName } from './site';
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
  /** Added to every worker's environment (`OBEYA_URL`). */
  workerEnv?: Record<string, string>;
  /** How long a waiting card's stack runs on before it is stopped (Parking); five minutes when left out. */
  parkGrace?: number;
  /** The language Obeya speaks to the owner now (`ownerLanguage`); German when left out (the tests). */
  language?: () => Language;
  /** The model and effort of a group of agents (`agentSetting`), asked whenever one starts; the defaults when left out. */
  agents?: (role: AgentRole) => AgentSetting;
  /** A repository's own adapter (`.obeya/adapter/`) changed on its default branch: Obeya starts again for it, where something restarts it. */
  adapterChanged?: (repoPath: string) => void;
}

export interface RepoRuntime {
  ref: RepoRef;
  info: RepoInfo;
  adapter: RepoAdapter;
  /** Where its demos are shared (the configuration's command, else the adapter's site, else its command); null where they are exported. */
  share: Shares | null;
  /** Its Lesestand: the default branch, where plan docs are read and the agents that only read work. */
  read: ReadTree;
  workspaces: Workspaces;
  workers: Workers;
  projectAgents: ProjectAgents;
}

export class CanvasRuntime {
  readonly board: Board;
  readonly koordinator: Koordinator;
  /** The Arbeitsrückschau: friction in the workers' runs, made into proposals. */
  readonly workRetro: WorkRetro;
  readonly commander: Commander;
  readonly explorers: Explorers;
  /** Screenshots the owner attaches to what they write. */
  readonly images: Images;
  readonly answers: Answers;
  readonly revisions: Revisions;
  /** Demos shared with colleagues, through the share command of the card's repository. */
  readonly sharing: Sharing;
  readonly repos: RepoRuntime[] = [];
  private stops: (() => void)[] = [];
  private prWatchers: PrWatcher[] = [];
  /** What the owner last said or typed to each card's agent, for the Koordinator to read beside a request the agent passes on. */
  private said = new Map<string, { text: string; spoken: boolean }>();
  /** Cards the owner is writing in, with their text before; a pause in typing hands it to the learner. */
  private writing = new Map<string, { before: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(config: CanvasConfig, private deps: CanvasDeps) {
    const agents = deps.agents ?? ((role: AgentRole) => AGENT_DEFAULTS[role]);
    deps = { ...deps, runtime: withAgentSetting(deps.runtime, agents), ...(deps.workerRuntime ? { workerRuntime: withAgentSetting(deps.workerRuntime, agents) } : {}) };
    this.deps = deps;
    const resolved = resolveCanvas(config, deps.store);
    const { id, name, infos, adapters, adapterTrees, broken, refs, stored } = resolved;
    config = resolved.config;
    adapters.forEach((a, i) => {
      if (broken[i]) console.error(`Obeya: ${broken[i]}; ${infos[i]!.path} runs on the ${a.name} adapter until it is fixed on its default branch`);
      for (const p of adapterProblems(a)) console.warn(`Obeya: adapter of ${infos[i]!.path}, ${p} (ignored)`);
      if (a.demo?.site && a.demo.share) console.warn(`Obeya: adapter of ${infos[i]!.path} names both demo.site and demo.share; the site is used`);
    });
    // whether each repository shares here, which the UI shows
    refs.forEach((r, i) => Object.assign(r, shareRef(sharesOf(config.repos[i]!, infos[i]!, adapters[i]!), deps.home)));
    const home = refs[0]!.id;
    // whether the default branch now has another version of the repository's own adapter than the
    // one this canvas was set up with; then Obeya starts again for it
    const adapterMoved = (i: number): boolean => {
      const was = adapterTrees[i];
      if (was === undefined || !deps.adapterChanged || repoAdapterTree(infos[i]!.path) === was) return false;
      deps.adapterChanged(infos[i]!.path);
      return true;
    };
    const images = (this.images = new Images(join(deps.home, 'images', id)));
    // where work lands on the local main, the checkout is the Lesestand; otherwise it is a pool clone on a card's branch
    const reads = infos.map(
      (info, i) =>
        new ReadTree({
          repoPath: info.path,
          dir: adapters[i]!.land === 'main' ? null : join(deps.home, 'read', id, refs[i]!.id),
          remote: !!info.remote,
          onChange: () => {
            this.board.lesestandMoved(refs[i]!.id, reads[i]!.head());
            adapterMoved(i);
          },
        }),
    );
    this.stops.push(() => reads.forEach((r) => r.stop()));
    this.board = new Board(
      deps.store,
      { id, name, repos: refs },
      () =>
        reads.flatMap((read, i) =>
          readPlanDocs(read.path, adapters[i]!).map((d) => (refs[i]!.id === home ? d : { ...d, file: `${refs[i]!.id}:${d.file}` })),
        ),
      images,
      (repo, commit) => !!reads[refs.findIndex((r) => r.id === repo)]?.holds(commit),
      deps.language,
    );
    const board = this.board;
    const imageFiles = (ids: string[] = []) => ids.flatMap((i) => images.path(i) ?? []);
    if (!stored) deps.store.setSetting(id, 'home_repo', home);
    resolved.keep();
    const preferences = () => board.preferencesText();

    // the Koordinator needs the workers, and the workers ask it: it is set right after them
    let koordinator!: Koordinator;
    const workRetro = (this.workRetro = new WorkRetro({
      board,
      runtime: deps.runtime,
      pathFor: (repo) => (this.repos.find((r) => r.ref.id === repo) ?? this.repos[0]!).read.path,
    }));
    config.repos.forEach((rc, i) => {
      const info = infos[i]!;
      const adapter = adapters[i]!;
      const ref = refs[i]!;
      const read = reads[i]!;
      const isHome = ref.id === home;
      const share = sharesOf(rc, info, adapter);
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
      const projectAgents = new ProjectAgents(board, deps.runtime, () => read.path, preferences);
      const workers = new Workers({
        board,
        runtime: deps.workerRuntime ?? deps.runtime,
        workspaces,
        adapter,
        shares: !!share,
        repo: ref.id,
        preferences,
        onOwnerInput: (card, kind, text, context) => koordinator.learn(card, kind, text, context),
        onPrOpened: (cardId) => this.sharing.prOpened(cardId),
        onMerged: () => void read.refresh(),
        onPrototype: (prototype, summary, demo) => this.prototypeReady(prototype, summary, demo),
        onPrototypeAnswer: (prototype, question, answer) => this.prototypeAnswered(prototype, question, answer),
        // where work lands on the local main, the Lesestand is the checkout and moves with the landing
        restartsFor: (l: Landed) => (!!deps.ownCheckout && sameDir(deps.ownCheckout, info.path) && changesCode(info.path, l.from, l.to)) || adapterMoved(i),
        imageFiles,
        onWorkEnded: (cardId, workspace) => workRetro.ended(cardId, workspace),
        toObeya: (cardId, request) => this.forward(cardId, request),
        ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
        ...(deps.workerEnv ? { env: deps.workerEnv } : {}),
        ...(deps.parkGrace !== undefined ? { parkGrace: deps.parkGrace } : {}),
      });
      this.repos.push({ ref, info, adapter, share, read, workspaces, workers, projectAgents });
      if (deps.watch) {
        this.stops.push(watchPlanDocs(read.path, adapter, () => board.docsChanged()));
        if (adapter.land === 'pr') {
          const watcher = new PrWatcher(board, workers, deps.forge, (cardId) => board.row(cardId).workspace ?? info.path, adapter.prNoise, ref.id, () => void read.refresh());
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
      home: () => this.repos[0]!.read.path,
      repoFor: (card) => {
        const r = this.repoOf(card);
        return { workers: r.workers, workspaces: r.workspaces, adapter: r.adapter, path: r.read.path };
      },
    });
    koordinator.resume();
    this.explorers = new Explorers({
      board,
      runtime: deps.runtime,
      preferences,
      pathFor: (card) => this.repoOf(card).read.path,
      onOwnerInput: (card, text) => koordinator.learn(card, 'idea', text),
      imageFiles,
      onReplied: (cardId, replied) => this.replied(cardId, replied),
      toObeya: (cardId, request) => this.forward(cardId, request),
    });
    this.explorers.resumeAll();
    this.answers = new Answers({
      board,
      runtime: deps.runtime,
      preferences,
      pathFor: (card) => (card ? this.repoOf(card) : this.repos[0]!).read.path,
      startBrief: (card) => this.repoOf(card).workers.startBrief(card),
      projectAgent: (project) => this.repoOf(project).projectAgents,
      onAnswer: (question, answer) => this.commander.tell(`The answer you looked up for the owner's question „${question}“ came in and was shown to them: ${answer}`),
    });
    this.commander = new Commander({
      board,
      runtime: deps.runtime,
      cwd: this.repos[0]!.read.path,
      execute: (c) => this.run(c),
      imageFiles,
      lookUp: (talk) => this.answers.lookUp(talk),
      onOwnerInput: (card, kind, text, reply) => this.koordinator.learn((card && board.item(card)) || null, kind, text, { reply }),
      ...(deps.config ? { config: deps.config } : {}),
      agentSetting: () => agents('koordinator'),
      ...(deps.commandDelayMs !== undefined ? { delayMs: deps.commandDelayMs } : {}),
    });
    this.answers.resume();
    this.revisions = new Revisions({ board, runtime: deps.runtime, preferences, pathFor: (card) => this.repoOf(card).read.path, onRevised: (cardId, revised) => this.revised(cardId, revised) });
    this.revisions.resume();
    this.sharing = new Sharing({
      board,
      runtime: deps.runtime,
      home: deps.home,
      forge: deps.forge,
      sourceFor: (card) => {
        const r = this.repoOf(card);
        return r.share ? { ...r.share, repo: r.info.path } : null;
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

  /**
   * What the owner says or types with a card open that an agent listens on (`agentListens`) goes
   * straight to that agent, by the card's state: talk to an idea, the answer to its worker's
   * question, or else words the worker takes in (a note while it works, words on its handover, a
   * question once its work is done). The agent passes on what asks Obeya for something (`to_obeya`).
   */
  tell(cardId: string, text: string, images: string[], spoken: boolean) {
    const card = this.board.item(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    if (!agentListens(card)) throw new BadRequest('noAgent', 'no agent works on this card');
    const said = { text, spoken, ...(images.length ? { images } : {}) };
    // the agent passes a request on in its words; the Koordinator reads the owner's own beside them
    this.said.set(cardId, { text, spoken });
    if (card.state === 'idea') return this.act(cardId, { action: 'discuss', ...said });
    if (card.state === 'waiting' && card.need === 'question') return this.act(cardId, { action: 'answer', ...said });
    return this.act(cardId, { action: 'message', ...said });
  }

  /**
   * A request a card's agent passes on from the owner's words (`to_obeya`): the Koordinator reads it
   * with those words and the card in focus, as a command, and its confirmation (or reply, or that it
   * looks the question up) is the agent's answer. Actions wait for "Rückgängig" as usual; the owner
   * sees the confirmation above the microphone and in the card's conversation.
   */
  async forward(cardId: string, request: string): Promise<string> {
    const said = this.said.get(cardId);
    const h = await this.commander.forward(cardId, request, said);
    if (h.token) this.commander.arm(h.token);
    this.board.notify({ cardId, text: h.confirm, ...(h.token ? { token: h.token, undoMs: this.commander.delayMs } : {}) });
    return h.confirm;
  }

  /** The owner clicks in the card's panel: a click without words the learner reads counts towards the Rückschau. */
  press(cardId: string, a: CardAction) {
    const r = this.act(cardId, a);
    // the options picked on a proposal go to its reviser without the Koordinator, which would have logged them
    if (a.action === 'revise') this.board.log(cardId, 'say', 'owner', a.text.trim());
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
      case 'reorder':
        return this.koordinator.reorder(cardId, !!a.earlier);
      case 'split':
        return this.koordinator.split(cardId);
      case 'stop':
        return this.repoOf(cardId).workers.stop(cardId);
      case 'message':
        return this.repoOf(cardId).workers.message(cardId, text.trim(), images, !!a.spoken);
      case 'answer':
        return this.repoOf(cardId).workers.answer(cardId, text.trim(), images, !!a.spoken);
      case 'approve':
        return this.repoOf(cardId).workers.approve(cardId, { direct: !!a.direct });
      case 'accept':
        return this.accept(cardId, a.picks, a.start !== false);
      case 'unaccept':
        return this.unaccept(cardId);
      case 'dismiss':
        if (this.board.row(cardId).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return this.board.remove(cardId);
      case 'revise':
        return this.revisions.revise(cardId, text.trim(), !!a.spoken);
      case 'discuss':
        return this.explorers.discuss(cardId, text.trim(), !!a.spoken, images);
      case 'build':
        return this.build(cardId);
      case 'unbuild':
        return this.unbuild(cardId);
      case 'planDoc':
        return this.planDoc(cardId);
      case 'park':
      case 'drop':
        return this.shelve(cardId, a.action);
      case 'prototype':
        if (a.variants !== undefined && (!Array.isArray(a.variants) || a.variants.length > 20 || a.variants.some((v) => typeof v !== 'string')))
          throw new BadRequest('invalid', 'variants must be a list of the planned approaches');
        return this.prototype(cardId, text.trim(), a.variants);
      case 'buildPrototype':
        return this.buildOnPrototype(cardId, a.workstream);
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
    // work thrown away ended too (finished work counted when it landed)
    else if (!state || !finished(state)) this.workRetro.ended(cardId, workspace);
    this.board.remove(cardId);
  }

  /**
   * The card whose worker writes a repository's own adapter with the `adapter` skill, for one that
   * runs on the generic adapter; one still open for it is returned rather than a second made. It
   * goes right of everything on the canvas, at the top.
   */
  adapterSetupCard(repo: string): Item {
    const r = this.repos.find((x) => x.ref.id === repo);
    if (!r) throw new BadRequest('invalid', 'unknown repository');
    const { title, body } = this.board.t.adapterSetup;
    const items = this.board.snapshot().items;
    const open = items.find((i) => i.kind === 'task' && i.repo === repo && i.title === title(r.ref.name) && !finished(i.state) && !i.archivedAt);
    if (open) return open;
    const at = items.length ? { x: Math.max(...items.map((i) => i.x)) + 560, y: Math.min(...items.map((i) => i.y)) } : { x: 0, y: 0 };
    return this.board.create({ title: title(r.ref.name), body, repo, ...at });
  }

  // ---------------------------------------------------------------- proposals

  /**
   * Accepting a proposal is the owner's go unless they keep it to edit first (`start` false): the
   * card goes to the Koordinator like a started one, a proposed idea to its exploration agent.
   * Clicked while the proposal is reworked, it is accepted once the new text is there, unless that
   * asks questions.
   */
  private accept(cardId: string, picks: string[][] | undefined, start: boolean) {
    const proposal = this.board.item(cardId)?.proposal;
    if (start && proposal?.revising) {
      // the owner knows what comes; the new text still may ask what must be settled first
      if (this.board.acceptAfterRevision(cardId, true))
        this.board.log(cardId, 'state', 'owner', this.board.t.proposal.acceptAfterRevision(!!proposal.idea));
      return;
    }
    if (this.board.accept(cardId, picks, start)) this.explorers.open(cardId, true);
    else if (start) this.koordinator.request(cardId);
  }

  /** Accepting after the revision is taken back: the proposal stays one. */
  private unaccept(cardId: string) {
    if (this.board.acceptAfterRevision(cardId, false)) this.board.log(cardId, 'state', 'owner', this.board.t.proposal.notAccepting);
  }

  /** The revision is over (`revised`, or the agent ended without a text): a proposal accepted meanwhile is accepted now, unless it asks questions. */
  private revised(cardId: string, revised: boolean) {
    const card = this.board.item(cardId);
    if (card?.state !== 'proposal' || !card.proposal?.acceptAfterRevision) return;
    this.board.acceptAfterRevision(cardId, false);
    const asks = card.proposal.questions.length;
    if (revised && !asks) return this.accept(cardId, [], true);
    const t = this.board.t.proposal;
    this.board.log(cardId, 'state', 'obeya', !revised ? t.notAcceptedNoRevision : asks > 1 ? t.notAcceptedQuestions : t.notAcceptedQuestion);
  }

  // ---------------------------------------------------------------- ideas

  /**
   * The idea is built as it stands: its brief becomes the card's task, and the card goes to the
   * Koordinator to start. A prototype still running for it is discarded: what is built now is the brief.
   */
  private build(cardId: string) {
    const card = this.ideaCard(cardId);
    if (card.idea?.thinking) {
      // the owner knows what comes; the reply still may ask what must be settled first
      if (card.idea.buildAfterReply) return;
      this.board.setIdea(cardId, { buildAfterReply: true });
      this.board.log(cardId, 'state', 'owner', this.board.t.idea.buildAfterReply);
      return;
    }
    this.decided(card, { answer: this.board.t.idea.buildAnswer, log: this.board.t.idea.buildLog });
    this.koordinator.request(cardId);
  }

  /** Building after the reply is taken back: the idea stays in its discussion. */
  private unbuild(cardId: string) {
    if (!this.ideaCard(cardId).idea?.buildAfterReply) return;
    this.board.setIdea(cardId, { buildAfterReply: false });
    this.board.log(cardId, 'state', 'owner', this.board.t.idea.unbuild);
  }

  /**
   * The idea's agent has answered all it was told (`replied`), or its turn ended without (an error,
   * a restart): an idea to build after the reply is built now, unless the reply asks questions.
   */
  private replied(cardId: string, replied: boolean) {
    const card = this.board.item(cardId);
    if (card?.state !== 'idea' || !card.idea?.buildAfterReply) return;
    this.board.setIdea(cardId, { buildAfterReply: false });
    const asks = card.idea.questions.length;
    if (replied && !asks && card.idea.status === 'open') return this.build(cardId);
    const t = this.board.t.idea;
    this.board.log(cardId, 'state', 'obeya', !replied ? t.notBuiltNoReply : asks > 1 ? t.notBuiltQuestions : t.notBuiltQuestion);
  }

  /**
   * The idea is built on this prototype: the prototype's workspace and branch become the idea's,
   * whose worker goes on from there with the brief, the prototype's handover and the owner's answers
   * on it. The prototype goes into the archive as built, the idea's other prototypes as discarded.
   */
  private buildOnPrototype(prototypeId: string, workstreamId?: string) {
    const prototype = this.prototypeCard(prototypeId);
    const project = this.board.projectOf(prototype.prototypeOf!);
    if (project) return this.buildWorkstreamOn(prototype, project, workstreamId);
    const planning = this.board.item(prototype.prototypeOf!);
    if (planning?.becomesProject) throw new BadRequest('projectPending', 'the idea becomes a project; build on the prototype once its plan doc has landed');
    if (!planning) throw new BadRequest('ideaGone', 'the prototype’s idea is no longer on the canvas, and no project of it is');
    const idea = this.settledIdea(prototype.prototypeOf!);
    const { workers } = this.repoOf(prototype);
    const { path, branch } = workers.buildOn(prototype.id, idea);
    this.board.work(idea.id, { workspace: path, branch, built_on: prototype.id });
    this.decided(idea, { answer: this.board.t.idea.buildOnAnswer(prototype.title), log: this.board.t.idea.buildOnLog(prototype.title) });
    this.koordinator.request(idea.id);
  }

  /**
   * The idea has become a project: the workstream the owner chose, or else the one its plan doc
   * builds on the prototypes with, is built on the prototype's branch and starts at once; the
   * idea's other prototypes are discarded.
   */
  private buildWorkstreamOn(prototype: Item, project: Item, workstreamId?: string) {
    const ws = workstreamId ? this.board.item(workstreamId) : prototypeWorkstream(this.board.snapshot().items, project.id);
    if (!ws && !workstreamId) throw new BadRequest('workstreamMissing', 'the plan doc does not say which workstream builds on the prototype: choose it');
    if (!ws || ws.parent !== project.id) throw new BadRequest('invalid', 'not a workstream of the project the idea became');
    if (!buildableOn(ws)) throw new BadRequest('workstreamStarted', 'only a workstream nobody has started can be built on a prototype');
    const named = `${ws.label ? `${ws.label} ` : ''}${this.board.t.quote(ws.title)}`;
    const { path, branch } = this.repoOf(prototype).workers.buildOn(prototype.id, ws, named);
    this.board.work(ws.id, { workspace: path, branch, built_on: prototype.id });
    for (const p of this.board.snapshot().items.filter((i) => i.prototypeOf === prototype.prototypeOf)) this.repoOf(p).workers.endPrototype(p.id, 'discarded', 'obeya');
    const t = this.board.t.idea;
    this.board.decide({ project_id: project.id, card_id: ws.id, question: t.whichPrototype(named), answer: t.onPrototype(prototype.title), by: 'owner' });
    this.board.log(ws.id, 'state', 'owner', t.workstreamOnLog(prototype.title));
    this.koordinator.request(ws.id);
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
    this.board.decide({ project_id: null, card_id: idea.id, question: this.board.t.idea.howOn(idea.title), answer: how.answer, by: 'owner' });
    this.board.log(idea.id, 'state', 'owner', how.log);
  }

  /**
   * A big idea becomes a project: a worker writes its plan doc on the idea's card at once, and once
   * the doc lands, the project takes the idea's place. Its prototypes stay: the worker hears what
   * they showed, and the owner builds a workstream on one of them once the project stands.
   */
  private planDoc(cardId: string) {
    const card = this.settledIdea(cardId);
    const idea = this.board.idea(cardId);
    const dir = this.repoOf(card).adapter.planDocs.dir;
    const prototypes = this.board.snapshot().items.filter((i) => i.prototypeOf === cardId);
    const t = this.board.t.idea;
    this.explorers.close(cardId);
    this.board.work(cardId, {
      state: 'planned',
      idea: JSON.stringify({ ...idea, project: true } satisfies StoredIdea),
      body: [
        t.planDocTask(dir),
        t.planDocIdea(card.title),
        idea.brief.trim() || card.body.trim(),
        prototypes.length
          ? [
              t.planDocPrototypes(prototypes.length),
              ...prototypes.map((p) => {
                const summary = this.board.summary(p.id)?.trim();
                return summary ? t.planDocHandedOver(p.title, summary) : t.planDocInProgress(p.title);
              }),
            ].join('\n\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(card.title), answer: t.planDocAnswer, by: 'owner' });
    this.board.log(cardId, 'state', 'owner', t.planDocLog);
    this.koordinator.request(cardId);
  }

  /** Parked or dropped, the idea stays on the canvas with its brief; what its agent has not answered yet waits for the conversation to go on. */
  private shelve(cardId: string, how: 'park' | 'drop') {
    const card = this.ideaCard(cardId);
    this.explorers.interrupt(cardId, how === 'park' ? 'parked' : 'dropped');
    this.board.setIdea(cardId, { status: how === 'park' ? 'parked' : 'dropped', buildAfterReply: false });
    const t = this.board.t.idea;
    if (how === 'drop') this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(card.title), answer: t.dropped, by: 'owner' });
    this.board.log(cardId, 'state', 'owner', how === 'park' ? t.parked : t.dropped);
  }

  /**
   * Workers build throwaway prototypes for the idea, each in its own workspace; they never land
   * themselves. One per planned variant chosen, each with its approach in its title, and one for
   * what the owner wrote. Neither chosen nor written: the planned variants that have no prototype
   * on the canvas, or, with none planned, the idea as it stands.
   */
  private prototype(cardId: string, what: string, chosen?: string[]) {
    const card = this.ideaCard(cardId);
    const { variants = [] } = this.board.idea(cardId);
    const t = this.board.t.idea;
    const running = new Set(this.board.snapshot().items.flatMap((i) => (i.prototypeOf === cardId && i.variant ? [i.variant] : [])));
    const picked = chosen ? variants.filter((v) => chosen.includes(v.approach)) : what ? [] : variants.filter((v) => !running.has(v.approach));
    if (chosen?.length && !picked.length && !what) throw new BadRequest('invalid', 'none of the chosen variants is planned');
    if (!chosen && !what && variants.length && !picked.length) throw new BadRequest('variantsRunning', 'every planned variant has its prototype on the canvas');
    const runs = picked.map((v) => {
      const others = variants.filter((o) => o !== v).map((o) => o.approach);
      return { approach: v.approach, task: others.length ? `${v.show}\n\n${t.onlyThisVariant(others.join(', '))}` : v.show, variant: v.approach };
    });
    if (what || !runs.length) runs.push({ approach: approachOf(what), task: what || t.showAsItStands, variant: '' });
    const taken = new Set((this.board.item(cardId)?.prototypes ?? []).map((p) => p.title));
    const started: string[] = [];
    try {
      for (const run of runs) {
        const base = t.prototypeTitle(`${card.title}${run.approach ? ` – ${run.approach}` : ''}`);
        let title = base;
        for (let n = 2; taken.has(title); n++) title = `${base} (${n})`;
        taken.add(title);
        const prototype = this.board.addPrototype(cardId, title, run.task, run.variant || undefined);
        try {
          this.repoOf(prototype).workers.start(prototype.id);
        } catch (e) {
          this.board.remove(prototype.id);
          throw e;
        }
        started.push(title);
      }
    } finally {
      if (started.length) {
        // the owner now waits for the prototypes, not the other way round; the agent's reply to a result gives the turn back
        this.board.setIdea(cardId, { yourTurn: false });
        this.board.log(
          cardId,
          'state',
          'owner',
          started.length > 1 ? t.prototypesStarted(started.map((s) => this.board.t.quote(s)).join(', ')) : t.prototypeStarted(started[0]!, what && !picked.length ? what.replace(/[.!?]$/, '') : ''),
        );
      }
    }
  }

  /** A prototype handed over: its demo shows on the idea beside those of the other prototypes, and the idea's agent hears what it found. */
  private prototypeReady(prototype: Item, summary: string, demo: string | undefined) {
    const idea = this.board.item(prototype.prototypeOf!);
    if (!idea) return;
    this.board.log(idea.id, 'state', 'worker', this.board.t.idea.prototypeReady(prototype.title, !!demo));
    if (idea.state === 'idea')
      this.explorers.tell(
        idea.id,
        `A worker built the throwaway prototype “${prototype.title}” for this idea. Its summary:\n\n${summary}\n\nTake what it showed and what it means for the idea into the brief, then reply to the owner in a sentence or two.`,
      );
  }

  /** A question on a prototype was answered: the idea's agent takes it into the brief, so the idea does not ask it again. */
  private prototypeAnswered(prototype: Item, question: string, answer: string) {
    this.explorers.tell(
      prototype.prototypeOf!,
      `On the prototype “${prototype.title}”, its worker asked: „${question}“\n\nThe owner answered: ${answer}\n\nTake what this settles into the brief (decisions, open questions), so it is not asked again. Do not reply to the owner for it; end your turn without a reply unless it raises something they must decide now.`,
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
        this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
        if (c.start) this.koordinator.request(card.id);
        return;
      }
      case 'newIdea': {
        const card = this.board.create({ idea: true, title: c.title, body: c.body, ...(c.repo ? { repo: c.repo } : {}), ...this.board.freeSpot() });
        this.board.log(card.id, 'state', 'owner', this.board.t.voice.created);
        // the agent opens the discussion with what the owner said
        this.explorers.discuss(card.id, c.body.trim() || c.title, true, this.images.resolve(c.images));
        return;
      }
      case 'discuss':
        return this.act(c.card, { action: 'discuss', text: c.text, spoken: c.spoken ?? true, ...(c.images ? { images: c.images } : {}) });
      case 'prototype':
        return this.act(c.card, { action: 'prototype', text: c.text });
      case 'buildPrototype':
        return this.act(c.card, { action: 'buildPrototype', ...(c.workstream ? { workstream: c.workstream } : {}) });
      case 'discard':
        return this.act(c.card, { action: 'discard' });
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
      case 'revise':
        return this.act(c.card, { action: 'revise', text: c.text, spoken: c.spoken ?? true });
      case 'approve':
        return this.act(c.card, { action: 'approve', ...(c.direct ? { direct: true } : {}) });
      case 'accept':
      case 'dismiss':
      case 'dequeue':
      case 'split':
      case 'stop':
        return this.act(c.card, { action: c.do });
      case 'configure':
        return this.deps.config?.save(c.canvases);
      case 'remember':
        return this.remember(c.text, c);
      case 'workRetro':
        return this.workRetro.now(c.repo);
      case 'group':
        return void this.board.createGroup(c.name, c.cards);
      case 'ungroup':
        return this.board.group(c.cards, null);
      case 'renameGroup':
        return this.board.renameGroup(c.group, c.name);
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
    this.siteCredentials();
  }

  /** A site's env file placed or removed on this machine since: its repository's cards share again, or export. */
  private siteCredentials() {
    let changed = false;
    for (const r of this.repos) {
      const next = shareRef(r.share, this.deps.home);
      if (r.ref.share !== next.share || r.ref.shareNeeds?.file !== next.shareNeeds?.file) {
        delete r.ref.share;
        delete r.ref.shareNeeds;
        Object.assign(r.ref, next);
        changed = true;
      }
    }
    if (changed) this.board.changed();
  }

  /** Obeya is about to restart, or no longer is: the workers hear so and pause for it. */
  restartDue(due: DueRestart | null) {
    for (const r of this.repos) r.workers.restartDue(due);
  }

  shutdown() {
    for (const [, w] of this.writing) clearTimeout(w.timer);
    for (const stop of this.stops) stop();
    for (const r of this.repos) r.workers.shutdown();
    this.koordinator.shutdown();
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

/**
 * Starts the canvases; one that does not start is left out, with why in Obeya's log (and in
 * "Konfiguration", which checks the configuration again), and the others run.
 */
export function startCanvases(configs: CanvasConfig[], deps: CanvasDeps): CanvasRuntime[] {
  return configs.flatMap((c) => {
    try {
      return new CanvasRuntime(c, deps);
    } catch (e) {
      const why = e instanceof ConfigError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`Obeya: the canvas ${c.name ?? c.id ?? c.repos[0]?.path} does not start, left out: ${why}`);
      return [];
    }
  });
}

// the setting that names the repository whose own adapter named the canvas
const OWN_ADAPTER_OF = 'own_adapter_of';

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
 * first), their adapters and ids (`broken`: why a repository's own adapter does not load, where
 * it runs on the built-in one instead), and the canvas's id and name; `keep` notes which canvas
 * the repository's own adapter named, once the canvas is in the store. Throws a ConfigError.
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
  // the version of the repository's own adapter on its default branch; undefined where the configuration names one
  let adapterTrees = config.repos.map((r, i) => (r.adapter ? undefined : repoAdapterTree(infos[i]!.path)));
  // a repository's own adapter that does not load is fixed in the repository: meanwhile the
  // repository runs on the built-in adapter that matches it, with the error beside it
  let broken: (string | undefined)[] = [];
  let adapters = config.repos.map((r, i) => {
    try {
      return pickAdapter(infos[i]!, r.adapter);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (r.adapter) throw new ConfigError('unknownAdapter', message, i);
      broken[i] = message;
      return builtInAdapter(infos[i]!);
    }
  });
  let refs = uniqueRefs(infos, adapters);
  // the canvas the repository's own adapter named stays the one while that adapter does not load,
  // with its address, name and cards
  const named = !config.id && !config.name;
  const ownPath = named && adapterTrees[0] ? infos[0]!.path : null;
  const kept = ownPath && broken[0] !== undefined ? store.canvasWith(OWN_ADAPTER_OF, ownPath) : null;
  const id = config.id ? slug(config.id) : config.name ? slug(config.name) : (kept?.id ?? adapters[0]!.canvasId(infos[0]!));
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
    adapterTrees = order.map((i) => adapterTrees[i]);
    broken = order.map((i) => broken[i]);
    refs = uniqueRefs(infos, adapters);
  }
  const name = config.name ?? kept?.name ?? adapters[0]!.canvasName(infos[0]!);
  const keep = () => {
    if (ownPath && !kept) store.setSetting(id, OWN_ADAPTER_OF, ownPath);
  };
  return { config, id, name, infos, adapters, adapterTrees, broken, refs, stored, keep };
}

/** Repository ids unique on the canvas: the repository's name, with a number when two share one. */
function uniqueRefs(infos: RepoInfo[], adapters: RepoAdapter[]): RepoRef[] {
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
      ...(adapters[i]!.workspaces === 'clones' ? { clones: true } : {}),
      ...(adapters[i]!.land === 'pr' ? { pullRequests: true, ...(adapters[i]!.direct ? { direct: true } : {}) } : {}),
    };
  });
}

/** Where a repository shares demos, without its checkout. */
type Shares = { command: string[] } | { site: DemoSite };

/** Where a repository shares demos: the configuration's command, else the adapter's site, else its command; null without any. */
function sharesOf(config: RepoConfig, info: RepoInfo, adapter: RepoAdapter): Shares | null {
  if (config.share?.trim()) return { command: shareArgv(config.share, info.path) };
  if (adapter.demo?.site) return { site: adapter.demo.site };
  return adapter.demo?.share ? { command: adapter.demo.share } : null;
}

/** What the canvas tells the UI about it: a target here, or the env file a site lacks on this machine. */
function shareRef(share: Shares | null, home: string): Pick<RepoRef, 'share' | 'shareNeeds'> {
  if (!share) return {};
  const missing = 'site' in share ? siteMissing(home, share.site) : null;
  return missing && 'site' in share ? { shareNeeds: { site: siteName(share.site), file: missing } } : { share: true };
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
