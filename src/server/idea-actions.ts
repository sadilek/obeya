// What the owner decides on proposals, ideas and their prototypes, and on a card to be built in a
// repository that does not exist yet: accepting a proposal, building an idea, planning it as a
// project, prototypes and what becomes of them, and making the new repository the card moves to.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Item, UNDO_HOLD_MS } from '../core/types';
import { buildableOn, plannableAsProject } from '../core/card';
import { clip, messageOf, oneLine, plainText } from '../core/text';
import { BadRequest, type Board } from './board';
import { pathOfRef } from './plan-ref';
import type { CanvasRuntime, RepoRuntime } from './canvas';
import { slug } from './canvas-config';
import type { Config } from './config';
import type { Coordinator } from './coordinator';
import type { Store } from './db';
import { fromJson, type StoredDemo, type StoredNewRepo, toJson } from './row';
import type { Explorers } from './explorers';
import { type Images, MAX_IMAGES } from './images';
import { type ClonedRepo, cloneRepo, ghNewRepo, type GithubForNewRepo, makeRepo, type MadeRepo, newRepoPath, newRepoSource } from './new-repo';
import { expandHome } from '../../plugin/skills/demo/lib/settings.ts';
import { realPath } from './path';
import { outsidePlanDir } from './repo';

/** What is kept of a card's new repository once Obeya made it: where, and what it was cloned from (and the fork it made), for its worker's brief. */
const madeRecord = (target: StoredNewRepo, repo: MadeRepo | ClonedRepo): StoredNewRepo => ({
  path: target.path,
  canvas: target.canvas,
  by: target.by,
  made: true,
  ...('from' in repo ? { from: repo.from, ...(repo.fork ? { fork: repo.fork.name } : {}) } : {}),
});

/** New repositories being made, one after the other (`makeNewRepo`). */
let making: Promise<unknown> = Promise.resolve();

/**
 * The name a plan doc gives a prototype by: its variant, or else its approach as its title has it
 * after the idea's (which tells apart two prototypes of the same variant, "… (2)").
 */
export function prototypeName(p: Pick<Item, 'title' | 'variant'>): string {
  const variant = p.variant?.trim();
  if (variant && p.title.endsWith(variant)) return variant;
  return p.title.split(' – ').slice(1).join(' – ').trim() || variant || p.title;
}

/**
 * Which of an idea's prototypes the project it became builds on, and in which workstream, as the
 * plan doc says it: the one open workstream that names one prototype by its name (`prototypeName`)
 * in quotes; with a single prototype, also the one open workstream that mentions prototypes at all.
 * `also`: the other workstreams that mention prototypes all the same. `none` where no workstream
 * mentions a prototype; `unclear` where several name one, one names several, or one mentions a
 * prototype without naming which, with the workstreams that do.
 */
export function prototypeBuild<W extends { title: string; body: string }, P extends Pick<Item, 'title' | 'variant'>>(
  workstreams: W[],
  prototypes: P[],
): { workstream: W; prototype: P; also: W[] } | { none: true } | { unclear: 'several' | 'many' | 'unnamed'; workstreams: W[] } {
  const flat = (s: string) => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const quoted = (text: string, name: string) => name !== '' && new RegExp(`[„“”"‚‘’'«»‹›]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[„“”"‚‘’'«»‹›]`).test(text);
  const named = workstreams.flatMap((w) => {
    const text = flat(`${w.title}\n${w.body}`);
    const own = prototypes.filter((p) => quoted(text, flat(prototypeName(p))));
    return own.length ? [{ w, own }] : [];
  });
  const mentioning = workstreams.filter((w) => /prototyp/i.test(`${w.title}\n${w.body}`));
  if (named.length > 1) return { unclear: 'several', workstreams: named.map((n) => n.w) };
  if (named.length === 1) {
    const [{ w, own }] = named as [{ w: W; own: P[] }];
    return own.length > 1 ? { unclear: 'many', workstreams: [w] } : { workstream: w, prototype: own[0]!, also: mentioning.filter((m) => m !== w) };
  }
  if (!mentioning.length) return { none: true };
  if (mentioning.length === 1 && prototypes.length === 1) return { workstream: mentioning[0]!, prototype: prototypes[0]!, also: [] };
  return { unclear: mentioning.length > 1 ? 'several' : 'unnamed', workstreams: mentioning };
}

/** How often handing a prototype to its workstream is tried, git failing, before it is left to the owner. */
const SETTLE_TRIES = 3;

export interface IdeaActionsOptions {
  board: Board;
  /** The database, through which a card moves to another canvas. */
  store: Store;
  explorers: Explorers;
  coordinator: Coordinator;
  images: Images;
  /** Tells Obeya's assistant what became of a card (`Commander.tell`). */
  tell: (text: string) => void;
  /** The canvas's repositories that run, the home one first. */
  repos: () => RepoRuntime[];
  /** The repository a card belongs to (`CanvasRuntime.repoOf`). */
  repoOf: (card: Pick<Item, 'repo'> | string) => RepoRuntime;
  /** The canvases that run now, this one among them: a card goes to another one, or Obeya makes one there. */
  canvases?: () => CanvasRuntime[];
  /** Obeya's configuration, which a new repository is added to. */
  config?: Config;
  /** How long building or starting a card in a new repository waits for undo; UNDO_HOLD_MS when left out. */
  newRepoHoldMs?: number;
  /** What a new repository started from a GitHub repository asks of GitHub; `ghNewRepo` when left out. */
  github?: GithubForNewRepo;
  /** The card left for another canvas: what the canvas kept of the owner's words on it goes. */
  forget: (cardId: string) => void;
}

export class IdeaActions {
  private readonly board: Board;
  private readonly explorers: Explorers;
  private readonly coordinator: Coordinator;
  private readonly images: Images;
  /** A look for prototypes whose idea's project now stands (`settlePrototypes`), and the ideas whose prototype is being handed to its workstream. */
  private settleSoon: ReturnType<typeof setTimeout> | undefined;
  private settling = new Set<string>();
  private settleTries = new Map<string, number>();
  /** Set once the canvas shut down. */
  private stopped = false;

  constructor(private o: IdeaActionsOptions) {
    this.board = o.board;
    this.explorers = o.explorers;
    this.coordinator = o.coordinator;
    this.images = o.images;
  }

  private get id() {
    return this.board.canvas.id;
  }

  private get repos() {
    return this.o.repos();
  }

  private repoOf(card: Pick<Item, 'repo'> | string) {
    return this.o.repoOf(card);
  }

  /** Looks for prototypes whose idea's project now stands (`settlePrototypes`), once what changed the board is through. */
  settleLater() {
    if (this.settleSoon) return;
    this.settleSoon = setTimeout(() => {
      this.settleSoon = undefined;
      if (!this.stopped) this.settlePrototypes();
    }, 0);
  }

  // ---------------------------------------------------------------- proposals

  /**
   * Accepting a proposal is the owner's go unless they keep it to edit first (`start` false): the
   * card goes to the Coordinator like a started one, a proposed idea, or a task the owner takes as
   * one (`asIdea`), to its exploration agent. Clicked while the proposal is reworked, it is accepted
   * once the new text is there, unless that asks questions.
   */
  accept(cardId: string, picks: string[][] | undefined, start: boolean, asIdea?: boolean) {
    const card = this.board.item(cardId);
    if (card?.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    // one the work retrospective made before it stored proposal data has none
    const proposal = card.proposal ?? { questions: [] };
    if ((start || asIdea) && proposal.revising) {
      // the owner knows what comes; the new text still may ask what must be settled first
      if (this.board.acceptAfterRevision(cardId, asIdea ? 'idea' : true))
        this.board.log(cardId, 'state', 'owner', this.board.t.proposal.acceptAfterRevision(asIdea ? 'asIdea' : proposal.idea ? 'discuss' : 'start'));
      return;
    }
    const idea = !!asIdea || (start && !!proposal.idea);
    this.board.accept(cardId, picks, idea);
    if (idea) this.explorers.open(cardId, proposal.idea ? 'idea' : 'task');
    // one its agent proposed to start later waits until then, unless that time has passed
    else if (start && proposal.startAt && Date.parse(proposal.startAt) > Date.now())
      this.board.snooze(cardId, { until: proposal.startAt, by: 'agent', start: true, ...(proposal.reason ? { why: clip(oneLine(proposal.reason), 200) } : {}) });
    else if (start) {
      if (proposal.startAt) this.repoOf(cardId).workers.startsAt(cardId, proposal.startAt, 'agent', true);
      this.coordinator.request(cardId);
    }
  }

  /** Accepting after the revision is taken back: the proposal stays one. */
  unaccept(cardId: string) {
    if (this.board.acceptAfterRevision(cardId, false)) this.board.log(cardId, 'state', 'owner', this.board.t.proposal.notAccepting);
  }

  /** The revision is over (`revised`, or the agent ended without a text): a proposal accepted meanwhile is accepted now, unless it asks questions. */
  revised(cardId: string, revised: boolean) {
    const card = this.board.item(cardId);
    // words the owner said meanwhile are reworked in first
    const armed = card?.proposal?.acceptAfterRevision;
    if (card?.state !== 'proposal' || !armed || card.proposal!.revising) return;
    this.board.acceptAfterRevision(cardId, false);
    const asks = card.proposal!.questions.length;
    if (revised && !asks) return this.accept(cardId, [], true, armed === 'idea');
    const t = this.board.t.proposal;
    this.board.log(cardId, 'state', 'obeya', !revised ? t.notAcceptedNoRevision : asks > 1 ? t.notAcceptedQuestions : t.notAcceptedQuestion);
  }

  // ---------------------------------------------------------------- ideas

  /**
   * The idea is built as it stands: its brief becomes the card's task, and the card goes to the
   * Coordinator to start. A prototype still running for it is discarded: what is built now is the brief.
   */
  build(cardId: string) {
    const card = this.ideaCard(cardId);
    if (card.idea?.thinking) {
      // the owner knows what comes; the reply still may ask what must be settled first
      if (card.idea.buildAfterReply) return;
      this.board.setIdea(cardId, { buildAfterReply: true });
      this.board.log(cardId, 'state', 'owner', this.board.t.idea.buildAfterReply);
      return;
    }
    if (card.newRepo) return this.intoNewRepo(cardId);
    this.decided(card, { answer: this.board.t.idea.buildAnswer, log: this.board.t.idea.buildLog });
    this.coordinator.request(cardId);
  }

  // ---------------------------------------------------------------- a new repository

  /** Cards whose new repository Obeya makes once the undo window is through (`NewRepo.due`). */
  private newRepos = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * "Build it like this" or "Start agent" on a card to be built in a repository that does not exist yet:
   * after a few seconds in which `stayHere` takes it back, Obeya makes that repository and builds or
   * starts the card there (`makeNewRepo`). What it cannot do is refused at once where it can tell.
   */
  intoNewRepo(cardId: string) {
    const card = this.board.item(cardId);
    const target = card?.newRepo;
    if (!card || !target) throw new BadRequest('invalid', 'the card has no new repository');
    if (target.due) return;
    const t = this.board.t.newRepo;
    const path = newRepoPath(target.path, t);
    if (target.from?.trim()) newRepoSource(target.from, t);
    if (this.o.config && this.o.config.view().source !== 'file') throw new BadRequest('newRepoPath', t.fromCommandLine);
    this.taken(path);
    const due = Date.now() + (this.o.newRepoHoldMs ?? UNDO_HOLD_MS);
    this.board.setNewRepo(cardId, { ...target, due: new Date(due).toISOString() });
    this.newRepos.set(
      cardId,
      setTimeout(() => {
        this.newRepos.delete(cardId);
        // past taking it back: the card says so while a clone takes its minutes
        const now = this.board.newRepo(cardId);
        if (now?.due) this.board.setNewRepo(cardId, { ...now, making: true });
        // one after the other, on any canvas: each adds to the configuration as the one before left it
        making = making.then(() => this.makeNewRepo(cardId));
      }, due - Date.now()),
    );
  }

  /** The owner takes back building or starting the card in its new repository while the undo window runs. */
  stayHere(cardId: string) {
    if (!this.keepHere(cardId)) throw new BadRequest('newRepoGone', 'the new repository is being made already');
    this.board.log(cardId, 'state', 'owner', this.board.t.newRepo.stayed);
  }

  /** Building or starting the card in its new repository does not happen after all, if its undo window still runs; whether it did. */
  keepHere(cardId: string): boolean {
    const timer = this.newRepos.get(cardId);
    const target = this.board.newRepo(cardId);
    if (!timer || !target?.due) return false;
    clearTimeout(timer);
    this.newRepos.delete(cardId);
    this.board.setNewRepo(cardId, { ...target, due: undefined });
    return true;
  }

  /** Refuses a folder that is a repository of a canvas already: the card is to be built there instead. */
  private taken(path: string) {
    const real = realPath(path);
    for (const c of this.o.canvases?.() ?? [{ repos: this.repos, board: this.board }]) {
      const r = c.repos.find((x) => realPath(x.info.path) === real);
      if (r) throw new BadRequest('newRepoPath', this.board.t.newRepo.taken(path, c.board.canvas.name));
    }
  }

  /**
   * Makes the card's new repository and builds or starts the card there, one step after the other:
   * the folder and git (`makeRepo`), the configuration with a canvas of its own named after it (or
   * the repository on this canvas), then the card: an idea is decided as "Build it like this" decides it, and
   * moves, with its history and decisions, to the new canvas, where it starts. A step that fails takes
   * back those before it, and the card says why.
   */
  private async makeNewRepo(cardId: string) {
    const t = this.board.t.newRepo;
    const target = this.board.newRepo(cardId);
    const card = this.board.item(cardId);
    if (!card || !target?.due) return;
    const undo: (() => unknown)[] = [];
    try {
      const path = newRepoPath(target.path, t);
      this.taken(path);
      const config = this.o.config;
      if (!config) throw new Error('no configuration to add the repository to');
      const { resolved } = await config.check(config.current());
      const here = resolved.findIndex((r) => r?.id === this.id);
      if (here < 0) throw new Error(`the canvas ${this.id} is not in the configuration`);
      const source = target.from?.trim() ? newRepoSource(target.from, t) : null;
      // on GitHub as the account set for the card's repository on this machine, else gh's active one
      const mine = this.repos.find((r) => r.ref.id === card.repo) ?? this.repos[0];
      const account = source && 'github' in source && mine ? config.current()[here]?.repos.find((r) => resolve(expandHome(r.path)) === resolve(mine.info.path))?.githubAccount : undefined;
      const repo: MadeRepo | ClonedRepo = source ? await cloneRepo(path, source, t, this.o.github ?? ghNewRepo(), account) : makeRepo(path, t);
      undo.push(repo.undo);
      // on the configuration as it is now, and taken back from it as it is then: changes meanwhile stay;
      // a fork lands on its own main branch, so each card may go to the original as a pull request too
      const added = {
        path: target.path.trim(),
        ...(account ? { githubAccount: account } : {}),
        ...('fork' in repo && repo.fork ? { settings: { land: 'main' as const } } : {}),
      };
      const now = config.current();
      const after = target.canvas ? [...now, { repos: [added] }] : now.map((c, i) => (i === here ? { ...c, repos: [...c.repos, added] } : c));
      await config.save(after);
      const without = () =>
        config.current().flatMap((c) => {
          const repos = c.repos.filter((r) => r.path !== added.path);
          return repos.length ? [{ ...c, repos }] : [];
        });
      undo.push(() => config.save(without()));
      if (!target.canvas) return this.joined(cardId, path, repo);
      const checked = await config.check(after);
      const id = checked.resolved.at(-1)?.id;
      const there = id ? this.o.canvases?.().find((c) => c.id === id) : undefined;
      if (!there) throw new Error(t.notStarted(checked.problems.filter((p) => p.canvas === after.length - 1).map((p) => p.detail).join('; ') || path));
      this.moveTo(cardId, there, repo);
    } catch (e) {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (u) {
          console.error(`Obeya: taking back a step of the new repository of ${cardId}:`, u);
        }
      }
      if (!this.board.item(cardId)) return;
      this.board.setNewRepo(cardId, { ...target, due: undefined, making: undefined });
      this.board.log(cardId, 'error', 'obeya', t.failed(messageOf(e)), { code: e instanceof BadRequest ? e.code : undefined });
    }
  }

  /** The new repository joined this canvas: the card works in it, an idea built as "Build it like this" builds it. */
  private joined(cardId: string, path: string, repo: MadeRepo | ClonedRepo) {
    const r = this.repos.find((x) => x.info.path === path);
    if (!r) throw new Error(`${path} does not run on the canvas`);
    const card = this.board.item(cardId)!;
    const target = this.board.newRepo(cardId)!;
    this.board.patch(cardId, { repo: r.ref.id });
    this.board.setNewRepo(cardId, { ...madeRecord(target, repo), canvas: false });
    this.board.log(cardId, 'state', 'obeya', this.board.t.newRepo.joined(target.path.trim(), repo.made));
    if ('from' in repo) this.board.log(cardId, 'state', 'obeya', this.board.t.newRepo.cloned(target.path.trim(), repo.from, repo.fork?.name));
    if (card.state === 'idea') this.decided(card, { answer: this.board.t.newRepo.buildAnswer(target.path.trim()), log: this.board.t.idea.buildLog });
    this.coordinator.request(cardId);
  }

  /**
   * The card leaves for the canvas `there`, whose home repository was made for it: an idea is
   * decided here first (its agent's session ends, its prototypes are discarded), then the card goes
   * with its history, decisions and screenshots, out of its group, and starts there. This canvas's
   * sheet says where it went, and a page that has it open follows it.
   */
  private moveTo(cardId: string, there: CanvasRuntime, repo: MadeRepo | ClonedRepo) {
    const card = this.board.item(cardId)!;
    const target = this.board.newRepo(cardId)!;
    const shown = target.path.trim();
    // the screenshots of the task and of its conversation, which the new canvas keeps under its own name
    const row = this.board.row(cardId);
    const shots = [...(fromJson(row.images) ?? []), ...this.board.events(cardId).flatMap((e) => e.images ?? [])];
    this.images.copyTo(there.images, shots);
    if (card.state === 'idea') this.decided(card, { answer: this.board.t.newRepo.buildAnswer(shown), log: this.board.t.idea.buildLog });
    this.o.forget(cardId);
    const at = there.board.freeSpot(there.inView);
    this.o.store.moveCard(cardId, there.id, at, { new_repo: toJson({ ...madeRecord(target, repo), canvas: true }) });
    this.o.store.dropEmptyGroups(this.id);
    there.board.log(cardId, 'state', 'obeya', there.board.t.newRepo.movedHere(this.board.canvas.name, shown, repo.made));
    if ('from' in repo) there.board.log(cardId, 'state', 'obeya', there.board.t.newRepo.cloned(shown, repo.from, repo.fork?.name));
    const moved = { card: cardId, title: card.title, canvas: there.id, canvasName: there.board.canvas.name };
    this.board.moved(moved);
    this.o.tell(`The card "${card.title}" moved to the canvas "${there.board.canvas.name}", in its new repository ${shown}, and is built there.`);
    this.board.notify({ cardId, text: this.board.t.newRepo.movedAway(card.title, there.board.canvas.name), movedTo: there.id });
    there.board.changed();
    there.coordinator.request(cardId);
  }

  /**
   * "Split off a task": the part its agent marked as settled becomes a task of its own beside the idea,
   * in its group and linked to it, with the screenshots of the discussion, and starts at once. The
   * idea stays open with its conversation and its prototypes; its agent hears what became of the part.
   * Not while the agent works on a reply, which may change the split.
   */
  splitOff(cardId: string) {
    const idea = this.settledIdea(cardId);
    const { split } = this.board.idea(cardId);
    if (!split) throw new BadRequest('noSplit', 'the idea’s agent has marked no task to split off');
    const t = this.board.t.idea;
    const shown = this.board.events(cardId).flatMap((e) => (e.kind === 'talk' && e.author === 'owner' ? (e.images ?? []) : []));
    const images = [...new Set([...(idea.images ?? []), ...shown])].slice(-MAX_IMAGES);
    const task = this.board.create({ title: split.title, body: `${split.brief}\n\n${t.settledTask(idea.title)}`, from: cardId, ...(images.length ? { images } : {}) });
    this.board.log(task.id, 'state', 'owner', t.settledFrom(idea.title));
    this.board.setIdea(cardId, { split: undefined });
    this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(idea.title), answer: t.splitOffAnswer(split.title), by: 'owner' });
    this.board.log(cardId, 'state', 'owner', t.splitOffLog(split.title));
    this.coordinator.request(task.id);
    this.explorers.tell(
      cardId,
      `The owner clicked "${this.board.t.labels.splitOff}": the part you marked as settled is now the task “${split.title}”, on a card of its own beside this idea, and a worker starts on it. Obeya has cleared the split. This idea stays open, with this conversation and its prototypes, planned and running, for what is still open. Trim the brief to what is open (the built part a line under decisions, as the task “${split.title}”), then reply to the owner in a sentence or two.`,
    );
  }

  /** Building after the reply is taken back: the idea stays in its discussion. */
  unbuild(cardId: string) {
    if (!this.ideaCard(cardId).idea?.buildAfterReply) return;
    this.board.setIdea(cardId, { buildAfterReply: false });
    this.board.log(cardId, 'state', 'owner', this.board.t.idea.unbuild);
  }

  /**
   * The idea's agent has answered all it was told (`replied`), or its turn ended without (an error,
   * a restart): an idea to build after the reply is built now, unless the reply asks questions.
   */
  replied(cardId: string, replied: boolean) {
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
   * What stands in the way is thrown at once; git renames the branch in the background.
   */
  buildOnPrototype(prototypeId: string) {
    const prototype = this.prototypeCard(prototypeId);
    const planning = this.board.item(prototype.prototypeOf!);
    if (this.board.projectOf(prototype.prototypeOf!) || planning?.becomesProject)
      throw new BadRequest('projectPending', 'the idea becomes a project: the workstream its plan doc builds on the prototype gets its branch once the project stands');
    if (!planning) throw new BadRequest('ideaGone', 'the prototype’s idea is no longer on the canvas, and no project of it is');
    const idea = this.settledIdea(prototype.prototypeOf!);
    const { workers } = this.repoOf(prototype);
    return workers.buildOn(prototype.id, idea).then(() => {
      this.decided(idea, { answer: this.board.t.idea.buildOnAnswer(prototype.title), log: this.board.t.idea.buildOnLog(prototype.title) });
      this.coordinator.request(idea.id);
    });
  }

  /**
   * Once an idea has become a project, its plan doc settles the prototypes still on the canvas: the
   * one it builds on goes, with its workspace and branch, to the workstream that builds on it, which
   * starts on it like any other workstream; the others are discarded. Where the doc builds on none,
   * or does not say clearly which (or that workstream has been started meanwhile), all are discarded.
   */
  private settlePrototypes() {
    const items = this.board.items();
    const ideas = new Set(items.flatMap((i) => (i.prototypeOf && !this.settling.has(i.prototypeOf) ? [i.prototypeOf] : [])));
    for (const ideaId of ideas) {
      const project = this.board.projectOf(ideaId);
      if (!project) continue;
      const prototypes = items.filter((i) => i.prototypeOf === ideaId);
      // a repository still starting settles them once it is up
      if (prototypes.some((p) => !this.repos.some((r) => r.ref.id === p.repo))) continue;
      const open = items.filter((i) => i.parent === project.id && i.kind === 'task' && i.state !== 'live' && i.state !== 'done');
      const build = prototypeBuild(open, prototypes);
      const t = this.board.t.idea;
      const decide = (answer: string, cardId = project.id) => this.board.decide({ project_id: project.id, card_id: cardId, question: t.whichPrototype, answer, by: 'owner' });
      if (!('workstream' in build) || !buildableOn(build.workstream) || !this.board.row(build.prototype.id).workspace) {
        decide(t.onNoPrototype(!('none' in build)));
        this.discardPrototypes(ideaId);
        continue;
      }
      const { workstream: ws, prototype } = build;
      const named = `${ws.label ? `${ws.label} ` : ''}${this.board.t.quote(ws.title)}`;
      this.settling.add(ideaId);
      let built: Promise<unknown>;
      try {
        built = this.repoOf(prototype).workers.buildOn(prototype.id, ws, named, 'obeya');
      } catch (e) {
        built = Promise.reject(e);
      }
      // git still preparing a workspace refuses it: tried again once that is done; where git keeps failing, the prototype stays for the owner to see why
      void built.then(
        () => {
          decide(t.onPrototype(named, prototype.title), ws.id);
          this.board.log(ws.id, 'state', 'obeya', t.workstreamOnLog(prototype.title));
          this.discardPrototypes(ideaId);
          this.settling.delete(ideaId);
        },
        (e: unknown) => {
          const tries = (this.settleTries.get(ideaId) ?? 0) + 1;
          this.settleTries.set(ideaId, tries);
          if (tries < SETTLE_TRIES)
            return void this.repoOf(prototype).workers.prepared().then(() => {
              this.settling.delete(ideaId);
              this.settleLater();
            });
          this.board.log(ws.id, 'error', 'obeya', messageOf(e));
          for (const p of this.board.items().filter((i) => i.prototypeOf === ideaId && i.id !== prototype.id)) this.repoOf(p).workers.endPrototype(p.id, 'discarded', 'obeya');
        },
      );
    }
  }

  /** The idea's prototypes still on the canvas go into the archive as discarded. */
  private discardPrototypes(ideaId: string) {
    for (const p of this.board.items().filter((i) => i.prototypeOf === ideaId)) this.repoOf(p).workers.endPrototype(p.id, 'discarded', 'obeya');
  }

  /** The idea is decided for building: its agent's conversation ends, the brief becomes the task, the other prototypes are discarded. */
  private decided(idea: Item, how: { answer: string; log: string }) {
    const { brief } = this.board.idea(idea.id);
    this.explorers.close(idea.id);
    this.discardPrototypes(idea.id);
    this.board.work(idea.id, { state: 'planned', ...(brief.trim() ? { body: brief.trim() } : {}) });
    // the screenshots the owner showed in the discussion belong to what is built
    const shown = this.board.events(idea.id).flatMap((e) => (e.kind === 'talk' && e.author === 'owner' ? (e.images ?? []) : []));
    if (shown.length) this.addTaskImages(idea.id, shown);
    this.board.decide({ project_id: null, card_id: idea.id, question: this.board.t.idea.howOn(idea.title), answer: how.answer, by: 'owner' });
    this.board.log(idea.id, 'state', 'owner', how.log);
  }

  /**
   * A big idea becomes a project: a worker writes its plan doc on the idea's card at once, and once
   * the doc lands, the project takes the idea's place. Its prototypes stay until then: the worker
   * hears what they showed, and the doc names the one a workstream builds on (`settlePrototypes`).
   */
  planDoc(cardId: string) {
    const task = this.board.item(cardId);
    if (task && task.state !== 'idea') return this.planTaskDoc(task);
    const card = this.settledIdea(cardId);
    const idea = this.board.idea(cardId);
    const dir = this.repoOf(card).adapter.planDocs.dir;
    const outside = this.outsidePlanDoc(card);
    const prototypes = this.board.items().filter((i) => i.prototypeOf === cardId);
    const t = this.board.t.idea;
    this.explorers.close(cardId);
    this.board.work(cardId, {
      state: 'planned',
      becomes_project: 1,
      ...outside?.row,
      body: [
        t.planDocTask(dir, false, outside?.file),
        t.planDocIdea(card.title),
        idea.brief.trim() || card.body.trim(),
        prototypes.length
          ? [
              t.planDocPrototypes(prototypes.map(prototypeName)),
              ...prototypes.map((p) => {
                const summary = this.board.summary(p.id)?.trim();
                return summary ? t.planDocHandedOver(prototypeName(p), summary) : t.planDocInProgress(prototypeName(p));
              }),
            ].join('\n\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.board.decide({ project_id: null, card_id: cardId, question: t.howOn(card.title), answer: t.planDocAnswer, by: 'owner' });
    this.board.log(cardId, 'state', 'owner', t.planDocLog);
    this.coordinator.request(cardId);
  }

  /**
   * A planned task of the owner's that nobody has worked on becomes a project the same way: its
   * worker writes the plan doc from the task, with its screenshots, on the task's card.
   */
  private planTaskDoc(card: Item) {
    if (!plannableAsProject(card))
      throw new BadRequest('notPlannable', 'only an idea, or a planned task of your own nobody has worked on yet, can be planned as a project');
    const t = this.board.t.idea;
    const dir = this.repoOf(card).adapter.planDocs.dir;
    const outside = this.outsidePlanDoc(card);
    this.board.work(card.id, { becomes_project: 1, ...outside?.row, body: [t.planDocTask(dir, true, outside?.file), t.planDocCard(card.title), card.body.trim()].filter(Boolean).join('\n\n') });
    this.board.decide({ project_id: null, card_id: card.id, question: t.howOnTask(card.title), answer: t.planDocAnswer, by: 'owner' });
    this.board.log(card.id, 'state', 'owner', t.planDocTaskLog);
    this.coordinator.request(card.id);
  }

  /**
   * The doc a card planned as a project writes where the plan directory is a folder outside the
   * repository: named after the card, beside the docs there. Nothing of that folder lands, so the
   * card names its doc from the start (`plan_docs`), and the project takes its place once the
   * owner has approved the card (`linkOrigins`). None for a plan directory in the repository.
   */
  private outsidePlanDoc(card: Item): { file: string; row: { plan_docs: string } } | undefined {
    const r = this.repoOf(card);
    const outside = outsidePlanDir(r.adapter.planDocs.dir);
    // in a folder without git nothing lands either: the doc is there as soon as it is written
    const dir = outside ?? (r.info.folder ? r.adapter.planDocs.dir.replace(/[/\\]+$/, '') : null);
    if (!dir) return;
    const at = (file: string) => (outside ? file : join(r.info.path, file));
    const name = slug(card.title).slice(0, 60).replace(/^[.-]+|[.-]+$/g, '') || 'plan';
    // nor one another card was given and has not written yet
    const given = new Set(this.o.store.withPlanDocs(this.id).flatMap((row) => fromJson(row.plan_docs!).map(pathOfRef)));
    let file = `${dir}/${name}.md`;
    for (let n = 2; existsSync(at(file)) || given.has(file); n++) file = `${dir}/${name}-${n}.md`;
    const ref = r.ref.id === this.repos[0]!.ref.id ? file : `${r.ref.id}:${file}`;
    return { file, row: { plan_docs: toJson([ref]) } };
  }

  /** Parked or dropped, the idea stays on the canvas with its brief; what its agent has not answered yet waits for the conversation to go on. */
  shelve(cardId: string, how: 'park' | 'drop') {
    const card = this.ideaCard(cardId);
    // parked or dropped in the undo window of its new repository: it is not built there
    this.keepHere(cardId);
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
  prototype(cardId: string, what: string, chosen?: string[]) {
    const card = this.ideaCard(cardId);
    // a prototype is a branch thrown away or built on: a folder without git has none
    if (this.repoOf(card).info.folder) throw new BadRequest('inFolder', 'a folder without git has no prototypes: its cards change the folder itself');
    const { variants = [] } = this.board.idea(cardId);
    const t = this.board.t.idea;
    const running = new Set(this.board.items().flatMap((i) => (i.prototypeOf === cardId && i.variant ? [i.variant] : [])));
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
          void this.repoOf(prototype).workers.start(prototype.id).catch((e: unknown) => this.board.log(prototype.id, 'error', 'obeya', messageOf(e)));
        } catch (e) {
          this.board.remove(prototype.id);
          throw e;
        }
        started.push(title);
      }
    } finally {
      if (started.length) {
        // the owner now waits for the prototypes, not the other way round; the agent's reply to a result gives the turn back.
        // Its suggestion was for the idea before they started: acted on or passed over, it goes
        this.board.setIdea(cardId, { yourTurn: false, next: undefined });
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
  prototypeReady(prototype: Item, summary: string, demo: StoredDemo | undefined) {
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
  prototypeAnswered(prototype: Item, question: string, answer: string) {
    this.explorers.tell(
      prototype.prototypeOf!,
      `On the prototype “${prototype.title}”, its worker asked: “${question}”\n\nThe owner answered: ${answer}\n\nTake what this settles into the brief (decisions, open questions), so it is not asked again. Do not reply to the owner for it; end your turn without a reply unless it raises something they must decide now.`,
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

  /** Adds screenshots to a card's task, keeping the latest when there are more than a message takes. */
  addTaskImages(cardId: string, images: string[]) {
    const had = this.board.item(cardId)?.images ?? [];
    this.board.work(cardId, { images: toJson([...had.filter((i) => !images.includes(i)), ...images].slice(-MAX_IMAGES)) });
  }

  /** The owner discards a prototype: it goes into the archive as discarded. */
  discard(cardId: string) {
    return this.repoOf(this.prototypeCard(cardId)).workers.endPrototype(cardId, 'discarded');
  }

  shutdown() {
    this.stopped = true;
    clearTimeout(this.settleSoon);
  }
}

/** A prototype's approach, for its title: the first sentence of what it is to show, kept short. */
export function approachOf(what: string, max = 40): string {
  const text = plainText(what);
  const first = (text.match(/^.+?[.!?;:](?=\s|$)/)?.[0] ?? text).replace(/[.;:]$/, '');
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}
