// One canvas and everything that works on it: its repositories (each with adapter, workspaces,
// workers, project agents and PR watcher), the board, the Koordinator and the voice commands.

import { join, resolve } from 'node:path';
import { pickAdapter } from '../adapters';
import { repoName } from '../adapters/generic';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import type { CardAction, Item, RepoRef } from '../core/types';
import { BadRequest, Board } from './board';
import { type Command, Commander } from './commands';
import type { Store } from './db';
import type { Forge } from './forge';
import { Koordinator } from './koordinator';
import { PrWatcher } from './pr-watcher';
import { ProjectAgents } from './project-agents';
import { readPlanDocs, repoInfo, watchPlanDocs } from './repo';
import type { AgentRuntime } from './runtime';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

export interface RepoConfig {
  path: string;
  adapter?: string;
  /** Clones to register as workspaces (adapters that use clones). */
  workspaces?: string[];
  /** Clones to create under Obeya's home (adapters that use clones). */
  clones?: number;
}

export interface CanvasConfig {
  /** Names the canvas; its id follows. Without it, the first repository's adapter names both. */
  name?: string;
  repos: RepoConfig[];
}

export interface CanvasDeps {
  store: Store;
  /** Obeya's data directory (workspaces live under it). */
  home: string;
  runtime: AgentRuntime;
  forge: Forge;
  permissionMode?: 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'default';
  /** Watch plan docs and pull requests; off in tests. */
  watch?: boolean;
  /** How long a voice command waits for undo. */
  commandDelayMs?: number;
}

export interface RepoRuntime {
  ref: RepoRef;
  info: RepoInfo;
  adapter: RepoAdapter;
  workspaces: Workspaces;
  workers: Workers;
  projectAgents: ProjectAgents;
}

export class CanvasRuntime {
  readonly board: Board;
  readonly koordinator: Koordinator;
  readonly commander: Commander;
  readonly repos: RepoRuntime[] = [];
  private stops: (() => void)[] = [];

  constructor(config: CanvasConfig, private deps: CanvasDeps) {
    if (!config.repos.length) throw new Error('a canvas needs at least one repository');
    let infos = config.repos.map((r) => repoInfo(resolve(r.path)));
    let adapters = config.repos.map((r, i) => pickAdapter(infos[i]!, r.adapter));
    let refs = uniqueRefs(infos, adapters);
    const id = config.name ? slug(config.name) : adapters[0]!.canvasId(infos[0]!);
    // the home repository is fixed when the canvas is first served: bare plan references, cards
    // without a repository and the home workspace directory are its, whatever the order later
    const stored = deps.store.setting(id, 'home_repo');
    if (stored && stored !== refs[0]!.id) {
      const at = refs.findIndex((r) => r.id === stored);
      if (at < 0) throw new Error(`canvas ${id}: its home repository "${stored}" is not configured; list it (first or anywhere)`);
      const order = [at, ...refs.map((_, i) => i).filter((i) => i !== at)];
      config = { ...config, repos: order.map((i) => config.repos[i]!) };
      infos = order.map((i) => infos[i]!);
      adapters = order.map((i) => adapters[i]!);
      refs = uniqueRefs(infos, adapters);
    }
    const name = config.name ?? adapters[0]!.canvasName(infos[0]!);
    const home = refs[0]!.id;
    this.board = new Board(deps.store, { id, name, repos: refs }, () =>
      infos.flatMap((info, i) =>
        readPlanDocs(info.path, adapters[i]!).map((d) => (refs[i]!.id === home ? d : { ...d, file: `${refs[i]!.id}:${d.file}` })),
      ),
    );
    const board = this.board;
    if (!stored) deps.store.setSetting(id, 'home_repo', home);
    const preferences = () => board.preferencesText();

    // the Koordinator needs the workers, and the workers ask it: it is set right after them
    let koordinator!: Koordinator;
    config.repos.forEach((rc, i) => {
      const info = infos[i]!;
      const adapter = adapters[i]!;
      const ref = refs[i]!;
      const isHome = ref.id === home;
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
        runtime: deps.runtime,
        workspaces,
        adapter,
        repo: ref.id,
        preferences,
        onOwnerInput: (card, kind, text, question) => koordinator.learn(card, kind, text, question),
        advisor: (card) => {
          const project = card.parent ? board.item(card.parent) : undefined;
          return project
            ? { by: 'project', ask: (q) => projectAgents.ask(project, card, q) }
            : { by: 'koordinator', ask: (q) => koordinator.ask(card, q) };
        },
        ...(deps.permissionMode ? { permissionMode: deps.permissionMode } : {}),
      });
      this.repos.push({ ref, info, adapter, workspaces, workers, projectAgents });
      if (deps.watch) {
        this.stops.push(watchPlanDocs(info.path, adapter, () => board.docsChanged()));
        if (adapter.land === 'pr') {
          const watcher = new PrWatcher(board, workers, deps.forge, (cardId) => board.row(cardId).workspace ?? info.path, adapter.prNoise, ref.id);
          watcher.start();
          this.stops.push(() => watcher.stop());
        }
      }
    });
    for (const r of this.repos) r.workers.resumeAll();
    koordinator = this.koordinator = new Koordinator({
      board,
      runtime: deps.runtime,
      preferences,
      repoFor: (card) => {
        const r = this.repoOf(card);
        return { workers: r.workers, workspaces: r.workspaces, adapter: r.adapter, path: r.info.path };
      },
    });
    koordinator.resume();
    this.commander = new Commander({
      board,
      runtime: deps.runtime,
      cwd: this.repos[0]!.info.path,
      execute: (c) => this.run(c),
      ...(deps.commandDelayMs !== undefined ? { delayMs: deps.commandDelayMs } : {}),
    });
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

  /** An owner action from the card's panel. */
  act(cardId: string, a: CardAction) {
    const text = 'text' in a ? a.text : '';
    if ('text' in a && (typeof text !== 'string' || !text.trim() || text.length > 20000)) throw new BadRequest('emptyText', 'text must be a non-empty string');
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
        return this.repoOf(cardId).workers.message(cardId, text.trim());
      case 'answer':
        return this.repoOf(cardId).workers.answer(cardId, text.trim());
      case 'approve':
        return this.repoOf(cardId).workers.approve(cardId);
      case 'accept':
        return this.board.accept(cardId);
      case 'dismiss':
        if (this.board.row(cardId).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return this.board.remove(cardId);
      default:
        throw new BadRequest('invalid', 'unknown action');
    }
  }

  /** Deletes a card of the owner's, stopping its worker first. */
  remove(cardId: string) {
    const { state } = this.board.row(cardId);
    if (state === 'working' || state === 'waiting') this.repoOf(cardId).workers.stop(cardId);
    this.board.remove(cardId);
  }

  /** A voice (or typed) command, once its undo window has passed. */
  run(c: Command) {
    switch (c.do) {
      case 'newCard': {
        const card = this.board.create({ kind: c.kind, title: c.title, body: c.body, ...(c.repo ? { repo: c.repo } : {}), ...this.board.freeSpot() });
        this.board.log(card.id, 'state', 'owner', 'Per Sprache angelegt.');
        if (c.start) this.koordinator.request(card.id);
        return;
      }
      case 'start':
        return this.act(c.card, { action: 'start' });
      case 'note':
      case 'feedback':
        return this.act(c.card, { action: 'message', text: c.text });
      case 'answer':
        return this.act(c.card, { action: 'answer', text: c.text });
      case 'approve':
      case 'accept':
      case 'dismiss':
      case 'split':
      case 'stop':
        return this.act(c.card, { action: c.do });
    }
  }

  shutdown() {
    for (const stop of this.stops) stop();
    for (const r of this.repos) r.workers.shutdown();
  }
}

/** Repository ids unique on the canvas: the repository's name, with a number when two share one. */
function uniqueRefs(infos: RepoInfo[], adapters: RepoAdapter[]): RepoRef[] {
  const seen = new Map<string, number>();
  return infos.map((info, i) => {
    const base = slug(repoName(info)) || `repo${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}${n}`, name: i === 0 ? adapters[0]!.canvasName(info) : repoName(info), path: info.path, branch: info.branch };
  });
}

const slug = (s: string) =>
  s
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-|-$/g, '');
