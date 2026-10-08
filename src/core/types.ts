// Shapes shared by the server and the UI.

import type { DemoSettings, VoiceKind } from '../../plugin/skills/demo/lib/settings.ts';
import type { SetupId, SetupItem } from '../../plugin/skills/demo/lib/setup.ts';
import type { Language } from './locale';
import { MESSAGES } from './messages';

export type { DemoSettings, NarrationLanguage, VoiceKind } from '../../plugin/skills/demo/lib/settings.ts';
export type { Language } from './locale';
export type { SetupCheck, SetupId, SetupItem } from '../../plugin/skills/demo/lib/setup.ts';

export type CardKind = 'task' | 'project';

export const STATES = ['idea', 'proposal', 'planned', 'working', 'waiting', 'approved', 'inPr', 'live', 'done'] as const;
export type CardState = (typeof STATES)[number];

/** A card whose work is over: `live` once it landed, `done` when it needed no change to the code (a demo, an analysis). */
export const finished = (s: CardState) => s === 'live' || s === 'done';

/**
 * A finished card an agent worked on, on the canvas, with no agent on it now: what the owner asks
 * about it resumes the agent that did the work, which answers and ends again.
 */
export const askable = (i: Pick<Item, 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  finished(i.state) && !!i.branch && !i.prototypeOf && !i.archivedAt && !i.finishing;

/**
 * How many cards of each group are still to be done: not finished, not archived, not a dropped
 * idea. A project counts by its workstreams, not as a card of its own.
 */
export function openPerGroup(items: Item[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const i of items)
    if (i.group && i.kind === 'task' && !finished(i.state) && !i.archivedAt && i.idea?.status !== 'dropped') open.set(i.group, (open.get(i.group) ?? 0) + 1);
  return open;
}

/** A workstream a prototype can be built for: nobody has worked on it yet, and the Koordinator does not hold it. */
export const buildableOn = (i: Item) => i.state === 'planned' && !i.branch && !i.queue;

/**
 * The workstream of a project, among `items`, that its idea's prototypes are built for: the one
 * nobody has started that mentions prototypes, as the plan doc's worker writes it. None when no
 * such workstream, or several, leave it to the owner.
 */
export function prototypeWorkstream(items: Item[], projectId: string): Item | undefined {
  const named = items.filter((i) => i.parent === projectId && buildableOn(i) && /prototyp/i.test(`${i.title}\n${i.body}`));
  return named.length === 1 ? named[0] : undefined;
}

/** What a `waiting` card waits for. `review` stands in for `demo` until workers record demos (M4). */
export type Need = 'demo' | 'question' | 'review';

/** A question an agent asks the owner, with answer options to choose from when it has them. */
export interface Question {
  text: string;
  options: string[];
  /** Several options may be chosen together. */
  multiple?: boolean;
  /** What the asking agent would pick if it had to decide: some of the options, and why. */
  pick?: { options: string[]; why: string };
}

/** A question as its card's log holds it: the text, then one line per option. */
export const formatQuestion = (q: Question, language: Language): string =>
  q.options.length ? `${q.text}${q.multiple ? ` (${MESSAGES[language].multiple})` : ''}\n${q.options.map((o) => `– ${o}`).join('\n')}` : q.text;

/** One item on the canvas as the UI sees it: a stored card merged with what its plan doc says. */
/** Its worker takes in the owner's words on its handover: meanwhile the card is at work, and still waits for approval. */
export const answering = (i: Item) => i.state === 'waiting' && (i.need === 'demo' || i.need === 'review') && !!i.answering;

/**
 * Whether an agent hears what the owner says or types on the card when it is open: its worker (at
 * work, waiting, in a pull request, finishing after the landing, or one a question resumes on a
 * finished card) or an idea's exploration agent. The words then go straight to it; on any other
 * card they go to the Koordinator.
 */
export const agentListens = (i: Pick<Item, 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  !i.archivedAt && (i.state === 'idea' || i.state === 'working' || i.state === 'waiting' || i.state === 'inPr' || !!i.finishing || askable(i));

/**
 * A card needs the owner: it waits (but not while its worker takes in what the owner wrote on its
 * handover), is a proposal, has a pull request that only waits for the
 * owner's merge, or is an open idea whose agent has replied and is done.
 */
export const needsYou = (i: Item) =>
  (i.state === 'waiting' && !answering(i)) || (i.state === 'proposal' && !i.proposal?.revising) || (i.state === 'inPr' && !!i.pr?.ready) || (!!i.idea && i.idea.status === 'open' && i.idea.yourTurn && !i.idea.thinking);

export interface Item {
  id: string;
  kind: CardKind;
  state: CardState;
  need?: Need;
  title: string;
  /** Free text: the owner's description, or a workstream's text from the plan doc (inline markdown). */
  body: string;
  /** Position; relative to the parent project for its workstreams. */
  x: number;
  y: number;
  parent?: string;
  /** `manual` cards are the owner's; `plan` cards mirror a plan doc and are read-only here. */
  source: 'manual' | 'plan';
  /** Workstream label from the plan doc (`W3`). */
  label?: string;
  /** Projects only. */
  plan?: { file: string; goal: string };
  /** Projects only: the idea their plan doc was written from. */
  origin?: string;
  /** The worker's latest `report`. */
  statusLine?: string;
  /**
   * Open question: the worker's, when `need` is `question`; or the one in its demo report, while
   * the demo waits for approval and the owner has not answered it.
   */
  question?: Question;
  /** The worker's summary, when `need` is `review` or `demo`. */
  summary?: string;
  /**
   * Its worker takes in what the owner wrote or said on its handover (`need` is `review` or `demo`):
   * until its turn ends, the card is at work and not the owner's, and still waits for approval.
   */
  answering?: true;
  /** Why the worker handed over without a demo, in the rare case there was nothing to show (`need` is `review`). */
  noDemo?: string;
  /** The demo, when `need` is `demo`; its files are served under `/api/cards/:id/demo/`. */
  demo?: Demo;
  /** The demo's page for colleagues, once the owner shared it (or is about to). */
  share?: Share;
  /** The card it comes from: a proposal's source, a prototype's idea, or the card a follow-up follows up on. */
  from?: string;
  /** A card the Arbeitsrückschau proposed: the cards and the friction on them it rests on. */
  retro?: string;
  /** A worker's proposal, while it waits: an idea or a task, why, and what the owner has to decide. */
  proposal?: Proposal;
  /** An agent's proposal the owner accepted: its text is that agent's. */
  proposed?: true;
  /** The repository the card belongs to (an id from the canvas's `repos`). */
  repo: string;
  branch?: string;
  /** Files the Koordinator expects the card to change. */
  scope?: string[];
  /** A planned card the Koordinator is deciding on, or that waits for cards in progress. */
  queue?: Queue;
  /** The pull request, once the worker opened it after approval. */
  pr?: PullRequest;
  /**
   * A workstream planned again: a part of it landed (this commit, this pull request), but its plan
   * doc keeps it open. A new run does the rest.
   */
  landedPart?: { commit?: string; pr?: { url: string; number: number } };
  /** When the owner archived the card; archived cards are not on the canvas but in its archive. */
  archivedAt?: string;
  /** Ideas only: what the discussion has settled so far. */
  idea?: Idea;
  /** A prototype's idea: the throwaway prototype is built for it and never lands itself. */
  prototypeOf?: string;
  /** A prototype of one of the variants its idea's agent planned: that variant's approach. */
  variant?: string;
  /** A prototype in the archive: discarded (its code thrown away), or built (its idea was built on its branch). */
  prototypeEnd?: 'discarded' | 'built';
  /** A prototype built for a workstream of the project its idea became: that workstream ("W6 „Seite bauen“"). */
  builtInto?: string;
  /** A prototype: its idea's title, wherever the idea is (on the canvas, or in the archive once it became a project). */
  ideaTitle?: string;
  /** A prototype whose worker proposes to build the idea on it: why, in its words. */
  buildProposal?: string;
  /** Ideas: their prototypes, on the canvas or in the archive, the oldest first; each shows its demo on the idea. A workstream built on a prototype: that one. */
  prototypes?: Item[];
  /** A card that was an idea, or a workstream of the project an idea became, built on the branch of one of the idea's prototypes: that prototype. */
  builtOn?: string;
  /** The work has landed and its worker finishes what remains (a migration, say) before its session ends. */
  finishing?: boolean;
  /** While `finishing`: nothing just landed, the owner asked about the finished card and its agent answers. */
  followUp?: boolean;
  /** Waiting for approval, its branch holds no change (checked at the handover): approving makes the card `done`. */
  noChange?: boolean;
  /** Screenshots the owner attached to the card's task; its worker gets them at the start. */
  images?: string[];
  /** A card that was an idea and has been decided: the brief it was decided on. */
  brief?: string;
  /** A card that was an idea and has been decided: the mocks of its brief. */
  mocks?: Mock[];
  /** A card that was an idea, decided as a project: its worker writes the plan doc, and the project takes its place. */
  becomesProject?: boolean;
  /** The group the card belongs to (a `Group` id); a workstream's is its project's. */
  group?: string;
}

/**
 * A group of cards on the canvas, shown as a coloured territory behind them. It exists while a card
 * belongs to it (on the canvas or in the archive).
 */
export interface Group {
  id: string;
  name: string;
  /** Its colour's hue, 0–359. */
  hue: number;
}

/**
 * What a worker proposes beyond the card's text, which it writes for the agent that will take the
 * card on. Accepting it writes the questions into the text: those the owner answered on the
 * proposal as decided, the others as open.
 */
export interface Proposal {
  /** Something to think through with the owner first: accepted, it becomes an idea. */
  idea?: boolean;
  /** Why the worker proposes it, for the owner only; the card's text does not say it. */
  reason?: string;
  questions: Question[];
  /** What the owner said it should become (`spoken`: through speech recognition), while an agent reworks the text, the reason and the questions by it. */
  revising?: { words: string; spoken?: boolean };
  /** "Übernehmen und starten" was clicked while it was reworked: it is accepted once the new text is there, unless that asks questions. */
  acceptAfterRevision?: true;
}

/** A decision taken on a card: an answer to a worker's question, or the owner's call on an idea. */
export interface Decision {
  id: number;
  cardId: string;
  question: string;
  answer: string;
  by: 'owner' | 'project' | 'koordinator';
  at: string;
}

/** What a project's sheet shows beyond the project: its decisions and the idea it came from. */
export interface ProjectHistory {
  /** The project's decisions and those of its idea, oldest first. */
  decisions: Decision[];
  /** The idea the plan doc was written from, wherever it is now (on the canvas or archived). */
  origin: Item | null;
}

/**
 * An idea under discussion with its exploration agent. `open` while it is discussed; parked or
 * dropped ideas stay on the canvas with their state, and talking to them opens them again.
 */
export interface Idea {
  status: 'open' | 'parked' | 'dropped';
  /** The state of the idea as the agent keeps it (markdown): goal, variants, decisions, open questions. */
  brief: string;
  /** The exploration agent is working on a reply. */
  thinking: boolean;
  /** "So bauen" was clicked while the agent worked on a reply: the idea is built once the reply is there, unless it asks questions. */
  buildAfterReply?: true;
  /** The agent replied and the owner has not answered yet: an open idea then needs the owner. */
  yourTurn: boolean;
  /** The questions of the agent's latest reply, until the owner says something. */
  questions: Question[];
  /** What the agent would do next in the owner's place, from its latest reply, until the owner says something. */
  next?: NextStep;
  /** The prototypes the brief plans, one per variant: "Prototyp bauen lassen" offers them, to start at once. */
  variants: PlannedPrototype[];
  /** How the brief's variants look, one mock each, shown beside it. */
  mocks: Mock[];
}

/** A few lines of HTML the idea's agent writes to show how something would look; the card shows it in a sandboxed frame. */
export interface Mock {
  title: string;
  html: string;
}

/** A prototype the idea's agent plans: its approach in a few words (its title) and what it builds and shows (its task). */
export interface PlannedPrototype {
  approach: string;
  show: string;
}

/** The owner's next click on an idea: answer its questions, or one of the decisions on the card. */
export const NEXT_STEPS = ['answer', 'build', 'planDoc', 'prototype', 'park', 'drop'] as const;
export interface NextStep {
  step: (typeof NEXT_STEPS)[number];
  why: string;
}

export interface PullRequest {
  url: string;
  number: number;
  /** Checks on the PR's latest commit, as last seen. */
  checks: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  conflict: boolean;
  /**
   * Nothing is left for the worker (checks green, threads resolved, reviewers answered), and GitHub
   * refused Obeya's merge for `mergeError`, or the reviewer's confidence is too low for Obeya to
   * merge (`held`, Greptile's 3/5 say): the owner merges, or tells the worker what is missing.
   */
  ready?: boolean;
  mergeError?: string;
  held?: { score: string; by: string };
  /** The review as last seen, oldest first (`reviewOf` in the server's forge). */
  review?: PrReviewEntry[];
}

/** A comment on a pull request; `mine` when the PR's author wrote it (the worker, in the owner's name). */
export interface PrComment {
  author: string;
  mine?: boolean;
  body: string;
  /** When it was written, or last changed when `edited`. */
  at: string;
  edited?: boolean;
  url?: string;
}

/** A reviewer's comment on the code and the replies in its thread. */
export interface PrThread extends PrComment {
  path?: string;
  line?: number;
  resolved: boolean;
  replies: PrComment[];
}

/** A round of a reviewer's comments on the code, or a comment in the conversation. */
export type PrReviewEntry = { author: string; mine?: boolean; at: string; threads: PrThread[] } | PrComment;

/**
 * How long a project's workstreams, started together, wait before the Koordinator plans them: the
 * owner can take the start back until then (a button on the project card is easily hit).
 */
export const START_ALL_HOLD_MS = 8000;

/**
 * `since`: when the card came to the Koordinator; of the cards whose turn comes, the one waiting
 * longest goes first. `together`: the project whose workstreams the Koordinator judges all at once.
 * `workspace`: the Koordinator let the card start, but no workspace was free for it (`none`: all
 * leased or none set up; `dirty`: every free one has uncommitted changes); it starts once one is.
 */
export type Queue = (
  | { checking: true; together?: string }
  | { cutting: true }
  | { behind: string[]; reason: string }
  | { workspace: WorkspaceShortage }
) & { since?: string };

export type WorkspaceShortage = 'none' | 'dirty';

/**
 * How a demo shows the work: a narrated `video` of something that happens, or an `html` artifact
 * to look at (design drafts side by side, a layout, an analysis).
 */
export type DemoKind = 'video' | 'html';

export interface Demo {
  /** Absent on demos from before HTML artifacts: those are videos. */
  kind?: DemoKind;
  /** Seconds and title of each scene; none for an HTML artifact. */
  chapters: [number, string][];
  /** A question only the owner can answer, beyond "approve or give feedback". */
  question?: string;
  /** The owner's answer to it; the demo keeps waiting for approval. */
  answer?: string;
  /** The page it is shared on, for colleagues who have never seen Obeya: written by the worker at handover, or later from its summary. */
  page?: DemoPage;
  /** An HTML artifact that is its `index.html` alone: it also goes out as one HTML file. */
  single?: true;
}

export interface DemoPage {
  title: string;
  /** Two to five sentences on what changes and why. */
  text: string;
}

/**
 * The largest video exported as one HTML file (which holds it in base64, a third larger): such a
 * file still goes by mail. A larger one is exported as a ZIP only.
 */
export const EXPORT_HTML_MAX = 15 * 1024 * 1024;

/**
 * A card's shared demo page. `publishing` while the share command runs, `shared` once the page is
 * up, `withdrawing` while it is taken down.
 */
export interface Share {
  state: 'publishing' | 'shared' | 'withdrawing';
  /** The page; set once it was published, kept while it is published again. */
  url?: string;
  /** The card has a newer demo than the one on the page. */
  stale?: boolean;
  /** The page shows the card's demo, but the share command writes pages differently now ("Erneut teilen"). */
  outdated?: boolean;
}

/** One line in a card's log. */
export interface CardEvent {
  id: number;
  cardId: string;
  at: string;
  /** `talk` is the discussion of an idea: the owner's messages and the exploration agent's replies. */
  kind: 'report' | 'activity' | 'say' | 'question' | 'answer' | 'hint' | 'review' | 'state' | 'error' | 'talk';
  author: 'worker' | 'owner' | 'project' | 'koordinator' | 'obeya' | 'explorer';
  text: string;
  /** Set on an error the UI words itself; `text` then holds the server's technical detail. */
  code?: ErrorCode;
  /** Screenshots the owner attached (ids under `/api/c/<canvas>/images/`). */
  images?: string[];
  /** The mocks of an exploration agent's reply. */
  mocks?: Mock[];
}

export interface CanvasInfo {
  id: string;
  name: string;
  /** The repositories on the canvas; the first is its home. */
  repos: RepoRef[];
}

export interface RepoRef {
  id: string;
  name: string;
  path: string;
  branch: string;
  /** It has a share target: demos go to a page outside Obeya (the configuration's command, or the adapter's `demo.share`); without one they are exported as a file. */
  share?: boolean;
  /** Its workers work in a pool of clones (else a worktree per card, as many as there are cards). */
  clones?: boolean;
  /** Its approved work goes out as a pull request (else it lands on the default branch of the Obeya checkout). */
  pullRequests?: boolean;
  /** With `pullRequests`: the owner may have approved work pushed directly onto the default branch instead (the adapter's `direct`). */
  direct?: boolean;
}

/** A repository's pool of clones: how many there are, and the cards that hold one now. */
export interface ClonePool {
  repo: string;
  total: number;
  cards: string[];
}

export interface CanvasSnapshot {
  canvas: CanvasInfo;
  items: Item[];
  /** The canvas's groups, the oldest first. */
  groups: Group[];
  preferences: Preference[];
  /** The owner's latest exchanges with the Koordinator without an open card (those with one are in its log). */
  talk: Talk[];
  /** The clone pools of the repositories that use clones; none when no repository does. */
  workspaces?: ClonePool[];
  /** Shared pages the share commands now write differently, and sharing many of them again; none when there is neither. */
  reshare?: Reshare;
}

/**
 * Shared demo pages to bring up to date at once, from the Koordinator's sheet: how many are
 * outdated, and the run that shares them again one after the other.
 */
export interface Reshare {
  /** Pages that could be shared again and are not queued. */
  outdated: number;
  run?: {
    total: number;
    /** Shared again. */
    done: number;
    /** Failed, with the reason in their card's log. */
    failed: { id: string; title: string }[];
    /** Still to go, the one going out now included. */
    left: number;
    /** The card whose page goes out now. */
    current?: string;
    /** The owner stopped it: the pages not yet out stay as they were. */
    stopped?: boolean;
  };
}

/** One exchange between the owner and the Koordinator. */
export interface Talk {
  id: number;
  at: string;
  /** What the owner said or typed. */
  said: string;
  reply: string;
  /** The card that was open. */
  cardId?: string;
  /** The owner took the actions back. */
  undone?: boolean;
  /** Screenshots that came with the command; they went to the cards it created or concerned. */
  images?: string[];
  /** A question the Koordinator looks up; its answer comes later. */
  question?: string;
  answer?: string;
  /** Who answered: the Koordinator, or the project agent of the workstream asked about. */
  answerBy?: 'koordinator' | 'project';
}

/**
 * A lasting preference of the owner, learned by the Koordinator or written by the owner. A learned
 * one is a proposal until the owner accepts it; agents follow active ones only.
 */
export interface Preference {
  id: number;
  text: string;
  state: PreferenceState;
  /** The card whose exchange it was learned from. */
  cardId?: string;
  /** What the owner said there that it was learned from. */
  quote?: string;
  /** Proposed by the Rückschau over many exchanges, not from one. */
  review?: boolean;
  /** The active rule a proposal would change. */
  replaces?: number;
  /**
   * A repository: the rule is about it and belongs in its CLAUDE.md, not in the preference memory.
   * Accepted, it is `filed` there through a card „CLAUDE.md ergänzen“ and applies to no agent until it is.
   */
  target?: string;
}

export type PreferenceState = 'proposed' | 'active' | 'rejected' | 'filed';

export interface NewCard {
  title: string;
  body?: string;
  /** Where it goes; left out for a follow-up, which goes below the card it comes from. */
  x?: number;
  y?: number;
  /** A repository of the canvas; its home repository when left out (a follow-up's: that of its card). */
  repo?: string;
  /** An idea to discuss before anything is planned. */
  idea?: boolean;
  /** The card this one follows up on, e.g. for a finding of its demo. */
  from?: string;
  /** Screenshots for the task (ids from `POST /api/c/<canvas>/images`). */
  images?: string[];
}

export interface CardPatch {
  x?: number;
  y?: number;
  title?: string;
  body?: string;
  state?: CardState;
  need?: Need | null;
  /** Another repository of the canvas, before work on the card has begun. */
  repo?: string;
  /** The task's screenshots, all of them (ids from `POST /api/c/<canvas>/images`). */
  images?: string[];
}

/** Owner actions on a card's work, posted to `/api/c/:canvas/cards/:id/act`. */
export type CardAction =
  /** On a project: all its planned workstreams go to the Koordinator, which orders them. */
  | { action: 'start' }
  | { action: 'stop' }
  /** `images`: ids of screenshots uploaded before (`POST /api/c/<canvas>/images`); with them the text may be empty. */
  /** `spoken`: the words came through speech recognition, which the agent is told. */
  | { action: 'message'; text: string; spoken?: boolean; images?: string[] }
  | { action: 'answer'; text: string; spoken?: boolean; images?: string[] }
  /** `direct`: onto the default branch at once, without a pull request, where the repository allows it (`RepoRef.direct`). */
  | { action: 'approve'; direct?: boolean }
  /** Start a queued card although it may collide. */
  | { action: 'force' }
  /** On a project: takes back a start of all its workstreams while the Koordinator has not planned them yet. */
  | { action: 'dequeue' }
  /** A waiting card one place earlier or later in the queue, past a card it has no wait with. */
  | { action: 'reorder'; earlier: boolean }
  /** Let the Koordinator cut the card into packages that can run in parallel. */
  | { action: 'split' }
  /**
   * A proposal becomes the owner's card and starts (a proposed idea: its discussion opens); with
   * `start: false` it is only planned. `picks`: the options the owner chose for each of its questions.
   * While the proposal is reworked, it is accepted and started once the new text is there, unless that asks questions.
   */
  | { action: 'accept'; start?: boolean; picks?: string[][] }
  /** A proposal: accepting it after its revision is taken back. */
  | { action: 'unaccept' }
  | { action: 'dismiss' }
  /** A proposal: an agent reworks its text, reason and questions by what the owner said (`text`). */
  | { action: 'revise'; text: string; spoken?: boolean }
  /** Ideas: talk to the exploration agent; `spoken` gets a short spoken summary back. */
  | { action: 'discuss'; text: string; spoken?: boolean; images?: string[] }
  /**
   * Ideas: the brief becomes the card's task and the card is planned. While the agent works on a
   * reply, the idea is built once the reply is there, unless it asks questions.
   */
  | { action: 'build' }
  /** Ideas: building after the reply is taken back. */
  | { action: 'unbuild' }
  /** Ideas: a planned card whose worker writes a plan doc from the brief. */
  | { action: 'planDoc' }
  | { action: 'park' }
  | { action: 'drop' }
  /**
   * Ideas: a worker builds a throwaway prototype and shows it as a demo on the idea; several may run
   * side by side. One per planned variant named in `variants` (by approach), and one for `text`.
   * Neither: one per planned variant without a prototype on the canvas, or, without any planned,
   * the idea as it stands.
   */
  | { action: 'prototype'; text?: string; variants?: string[] }
  /**
   * Prototypes: the idea is built on this prototype's branch; the idea's other prototypes are
   * discarded. Once the idea has become a project, one of its workstreams is built on it instead:
   * `workstream`, or else the one the plan doc builds on the prototypes with.
   */
  | { action: 'buildPrototype'; workstream?: string }
  /** Prototypes: thrown away, into the archive with log, demo and summary. */
  | { action: 'discard' }
  /** A video demo is published for colleagues right away, or again with the card's newer demo. */
  | { action: 'share' }
  /** Withdraws the published page. */
  | { action: 'unshare' };

/**
 * Why the server refused a request. The server sends the code and an English detail
 * (`{ code, error }`, status 400); the UI shows its own text for the code.
 */
export type ErrorCode =
  | 'unknownCard'
  /** A group that no card belongs to any more, so it is gone. */
  | 'unknownGroup'
  | 'project'
  | 'notPlanned'
  | 'queued'
  | 'notQueued'
  /** Moving a card in the queue: it is first or last already, or the card it would pass has a wait with it or is being judged. */
  | 'notMovable'
  | 'notSplittable'
  | 'noAgent'
  | 'noQuestion'
  | 'notReady'
  /** Approving directly onto main: the card's repository lands approved work only through a pull request. */
  | 'noDirect'
  | 'notProposal'
  | 'revising'
  | 'planCard'
  | 'noWorkspace'
  | 'dirtyWorkspaces'
  | 'workspace'
  | 'emptyText'
  | 'unknownPreference'
  /** An uploaded screenshot is no image the agents read, or too large. */
  | 'imageType'
  | 'imageTooLarge'
  /** Only a finished card of the owner's goes into the archive. */
  | 'notDone'
  | 'notArchived'
  | 'notIdea'
  /** The idea's agent is still working on its reply: building or planning waits for it. */
  | 'ideaThinking'
  /** A prototype for the idea is still running. */
  | 'prototypeRunning'
  /** The prototype's idea is becoming a project: its plan doc is not there yet. */
  | 'projectPending'
  /** The prototype's idea is gone from the canvas, and no project of it is there. */
  | 'ideaGone'
  /** The prototype's idea became a project whose plan doc does not say which workstream builds on it, and none was chosen. */
  | 'workstreamMissing'
  /** The workstream to build on a prototype was started already. */
  | 'workstreamStarted'
  /** Every variant the idea's agent planned has its prototype on the canvas already. */
  | 'variantsRunning'
  /** A project has no planned workstream left that is not already with the Koordinator. */
  | 'nothingToStart'
  /** The action is for a prototype on the canvas, and the card is none. */
  | 'notPrototype'
  /** A discarded or built prototype stays in the archive; a new attempt is a new prototype. */
  | 'prototypeEnded'
  /** Sharing: the card has no demo, or its repository shares none. */
  | 'noShare'
  /** Sharing: the page is being published or withdrawn right now. */
  | 'shareBusy'
  /** Sharing: the demo is not shared. */
  | 'notShared'
  /** Sharing many pages again: a run is under way already. */
  | 'reshareBusy'
  /** Setup: the folder for the first canvas is no git repository. */
  | 'notRepo'
  /** Setup: the folder a clone would go to exists already. */
  | 'cloneTarget'
  /** Setup: an installation or a clone is running already. */
  | 'setupBusy'
  /** Sharing many pages again: no page is outdated. */
  | 'nothingOutdated'
  /** Export: the video is too large for one HTML file. */
  | 'exportTooLarge'
  /** Export: the HTML artifact loads files beside its page, so it does not fit one HTML file. */
  | 'exportNotAlone'
  /** Approval could not land the work on main. */
  | 'landDirty'
  | 'landConflict'
  | 'landEmpty'
  | 'landCheckout'
  | 'landMerge'
  /** Pushing approved work directly onto `origin`'s default branch was turned away (a protected branch, say). */
  | 'landPush'
  | 'land'
  /** A configuration with problems; they come with it. */
  | 'config'
  /** A voice's sample could not be made; why comes with it. */
  | 'voiceSample'
  /** A voice is being installed already. */
  | 'voiceInstalling'
  /** Malformed input: a bug in the UI rather than something the owner can fix. */
  | 'invalid';

/** A repository on a canvas, as Obeya's configuration lists it (`canvases.json`). */
export interface RepoConfig {
  path: string;
  /** The adapter's name; without it, the repository's `origin` picks one. */
  adapter?: string;
  /** Clones to register as workspaces (adapters that use clones). */
  workspaces?: string[];
  /** Clones to create under Obeya's home (adapters that use clones). */
  clones?: number;
  /**
   * The command that shares a demo on a page outside Obeya (`publish`, `withdraw <slug>`;
   * `SharePage` in `src/server/share.ts`), as a command line: it takes the place of the adapter's.
   * Without one, and without the adapter's, "Teilen" exports the demo as a file.
   */
  share?: string;
}

/** A canvas in Obeya's configuration. */
export interface CanvasConfig {
  /** Names the canvas; its id follows. Without it, the first repository's adapter names both. */
  name?: string;
  /** Keeps the canvas's id, and with it its cards, whatever its name says: set when a canvas is renamed. */
  id?: string;
  repos: RepoConfig[];
}

/** What a configuration amounts to: each canvas's id and name, and its repositories with their adapters. */
export interface ResolvedCanvas {
  id: string;
  name: string;
  repos: { id: string; adapter: string; workspaces: 'clones' | 'worktrees'; /** The adapter names a share command of its own. */ adapterShares?: boolean }[];
}

/** Something in a configuration that keeps Obeya from starting with it; `canvas` and `repo` count from 0. */
export interface ConfigProblem {
  code: ConfigProblemCode;
  canvas?: number;
  repo?: number;
  /** In English, for developers and the Koordinator. */
  detail: string;
}

export type ConfigProblemCode =
  /** No canvas at all. */
  | 'noCanvas'
  | 'noRepo'
  /** A path that is no git repository. */
  | 'notRepo'
  | 'unknownAdapter'
  /** Two canvases with the same id. */
  | 'sameId'
  /** The repository the canvas was first served with is missing. */
  | 'homeMissing'
  /** A clone listed as a workspace that is no git repository. */
  | 'notClone'
  /** A share command whose program is not there. */
  | 'shareCommand'
  /** Malformed: a bug in whoever wrote it. */
  | 'invalid';

/** Obeya's configuration as the owner sees and edits it. */
export interface ConfigView {
  /** The file it is saved in. */
  file: string;
  /** Where the running canvases come from: that file, or repositories named on the command line. */
  source: 'file' | 'args';
  /** As saved (or as given on the command line, before anything is saved). */
  canvases: CanvasConfig[];
  /** What they amount to, by index; null for a canvas with a problem. */
  resolved: (ResolvedCanvas | null)[];
  problems: ConfigProblem[];
  /** The ids of the canvases this server runs. */
  running: string[];
  /** The adapters a repository can name. */
  adapters: string[];
  /**
   * Settings of the running server, from its command line; its version (`package.json`), and the
   * commit of the checkout it runs from (null for the compiled binary).
   */
  server: { port: number; home: string; permissionMode: string; restarts: boolean; version: string; commit: string | null };
  /** Saved, and Obeya starts again with it once no agent is in the middle of a turn. */
  restarting: boolean;
}

/** What keeps the demo settings from working (a voice to install is not one: `DemoVoiceCheck.install`). */
export type DemoSettingsProblem =
  /** `command` without one. */
  | 'noCommand'
  /** The own endpoint, or Azure's region, is missing. */
  | 'noUrl'
  /** A service without its environment variable or a key file. */
  | 'noKey'
  | 'keyFileMissing'
  /** Qwen3's clip to clone is not there, or its transcript beside it. */
  | 'referenceMissing'
  | 'noTranscript'
  /** `say` is macOS only. */
  | 'notHere';

/** What the settings sheet shows about a voice, saved or not yet. */
export interface DemoVoiceCheck {
  /** The person the narration speaks in, which follows from whether the voice is the owner's own. */
  person: 'first' | 'third';
  problems: DemoSettingsProblem[];
  /** What the voice needs installed by Obeya and is missing (Piper, Qwen3-TTS), and about how much that is. */
  install: { installed: boolean; missing: string[]; mb: number };
}

/** An installation Obeya runs for a voice, one at a time. */
export interface VoiceInstallJob {
  voice: VoiceKind;
  running: boolean;
  /** The last line of its output. */
  line: string;
  error?: string;
}

/** The demo settings (`plugin/skills/demo/lib/settings.ts`) as the settings sheet shows them. */
export interface DemoSettingsView {
  /** The file they are saved in, under Obeya's home. */
  file: string;
  settings: DemoSettings;
  /** The saved voice checked. */
  check: DemoVoiceCheck;
  /** The installation running or last run, while Obeya runs. */
  job?: VoiceInstallJob;
  /** `process.platform` of the server: `say` is offered on a Mac only. */
  platform: string;
}

/** The language Obeya speaks to the owner (`src/server/settings.ts`): chosen in the settings, else the system's. */
export interface LanguageView {
  /** The file it is saved in, under Obeya's home. */
  file: string;
  /** What the owner chose; `null` follows the system. */
  chosen: Language | null;
  /** The system's language, or the fallback when Obeya does not speak it. */
  system: Language;
  /** The one that applies. */
  language: Language;
}

/** The agents Obeya runs, grouped as the owner sets their model and effort (`src/server/settings.ts`). */
export const AGENT_ROLES = ['koordinator', 'worker', 'explorer', 'chores'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** The models offered: Claude Code's default, or one of its aliases, each the newest of its family. */
export const AGENT_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
/** The model and effort a group of agents runs with. */
export interface AgentSetting {
  model: AgentModel;
  effort: AgentEffort;
}
/** What applies until the owner chooses otherwise: small jobs on Sonnet, the Koordinator at medium effort. */
export const AGENT_DEFAULTS: Record<AgentRole, AgentSetting> = {
  koordinator: { model: 'default', effort: 'medium' },
  worker: { model: 'default', effort: 'high' },
  explorer: { model: 'default', effort: 'high' },
  chores: { model: 'sonnet', effort: 'high' },
};

/** The model and effort of each group of agents, as they apply (`settings.json` over `AGENT_DEFAULTS`). */
export interface AgentsView {
  file: string;
  agents: Record<AgentRole, AgentSetting>;
}

/** What Obeya's own voice in needs on this machine (`src/server/voice-setup.ts`). */
export type VoiceSetupId = 'whisper' | 'ffmpeg' | 'uv';
export type VoiceSetupItem = Omit<SetupItem, 'id'> & { id: VoiceSetupId };

export interface VoiceSetupView {
  platform: string;
  arch: string;
  /** Whisper on MLX (Apple Silicon) or faster-whisper. */
  listen: 'mlx' | 'faster';
  items: VoiceSetupItem[];
  /** What "Installieren" fetches and about how much: Whisper and its model. */
  fetch: { parts: 'whisper'[]; mb: number };
  /** The installation running or last run. */
  job?: { running: boolean; step: 'whisper'; line: string; error?: string };
}

/** The setup assistant's list (`src/server/machine.ts`): what Obeya needs on this machine, by what it is for. */
export type MachineSectionId = 'needed' | 'pr' | 'voice' | 'demos';
/** Claude Code, its login, git and git's name and e-mail for commits. */
export type NeededId = 'claude' | 'claudeLogin' | 'git' | 'gitUser';
/** gh and its login. */
export type PrId = 'gh' | 'ghLogin';

/** A piece of the list, as a setup check gives it, and what Obeya does about it at a click. */
export type MachineItem = Omit<SetupItem, 'id'> & {
  /** `globalKey`: the app's push-to-talk key in another app, while the app runs (src/server/push-key.ts). */
  id: NeededId | PrId | VoiceSetupId | SetupId | 'globalKey';
  /**
   * `install`: Obeya installs it (no admin rights, or Homebrew or winget). `login`: Obeya opens a
   * terminal that logs in. `identity`: the owner gives git's name and e-mail, which Obeya sets.
   */
  act?: 'install' | 'login' | 'identity';
};

export interface MachineSection {
  id: MachineSectionId;
  items: MachineItem[];
  /** About this many megabytes still to download for what the section is for (voice, demos). */
  mb: number;
}

/** An installation, a login or a clone Obeya runs for the assistant, one at a time. */
export interface MachineJob {
  kind: 'install' | 'clone';
  section?: MachineSectionId;
  id?: MachineItem['id'];
  running: boolean;
  /** The last line of its output. */
  line: string;
  error?: string;
  /** A clone that became the first canvas: its id, opened once Obeya runs again. */
  canvas?: string;
}

export interface MachineView {
  platform: string;
  arch: string;
  sections: MachineSection[];
  /** The Claude Code Obeya was checked with (the Agent SDK's); the machine's may be newer or older. */
  checkedClaude: string;
  job?: MachineJob;
  /** Obeya can open the system's folder dialog here. */
  picker: boolean;
  /** Where a clone goes by default: the owner's home directory. */
  cloneInto: string;
  /** Saving the first canvas starts Obeya again by itself; else the owner starts it. */
  restarts: boolean;
}

/** What choosing the first canvas did: it is saved, and Obeya starts again with it where something restarts it. */
export interface FirstCanvas {
  canvas: string;
  restarting: boolean;
}

/** Why Obeya starts again: new code on the checkout it runs from, or a configuration the owner saved; or why it stops for good (Ctrl-C, SIGTERM). */
export type RestartReason = 'code' | 'config' | 'stop';

/** What the owner does in an open page that a restart would cut off: watching a demo video, dictating. */
export type OwnerHold = 'video' | 'voice';

/** A restart that waits for workers to finish their turns, or for the owner, as one canvas sees it. */
export interface PendingRestart {
  reason: RestartReason;
  /** When it was due, and when it goes ahead however busy the workers are (ms since the epoch). */
  since: number;
  deadline: number;
  /** The cards on this canvas whose worker it waits for. */
  cards: string[];
  /** How many workers on other canvases it waits for. */
  elsewhere: number;
  /** What the owner does in some open page that it waits for, past the deadline too. */
  owner: OwnerHold[];
}

/** UI → server over the WebSocket. */
export type ClientMessage =
  /** What the owner does in this page that a restart waits for (sent on every change). */
  | { type: 'hold'; hold: OwnerHold[] }
  /** The owner came back to this page (from GitHub, say): what Obeya polls is looked at now. */
  | { type: 'back' }
  /**
   * What the owner has in view (sent on every change and when the page gets the focus back): a
   * command from the app's push-to-talk key in another app goes there. `target` and `title` as the
   * microphone shows them.
   */
  | { type: 'focus'; card?: string; project?: string; target: string; title?: string };

/** Server → UI over the WebSocket. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: CanvasSnapshot }
  | { type: 'event'; event: CardEvent }
  /** First on every connection: which server process this is, so a page from an earlier one reloads. */
  | { type: 'hello'; server: string }
  /** On connect and whenever it changes: the restart Obeya waits with, if any. */
  | { type: 'restart'; restart: PendingRestart | null }
  /** On connect and whenever it changes: how many cards on each canvas need the owner, by canvas id. */
  | { type: 'waiting'; waiting: Record<string, number> }
  /** A line for the owner above the microphone, wherever they are. */
  | ({ type: 'notice' } & Notice);

/**
 * What Obeya tells the owner above the microphone without a command of theirs to answer: an answer
 * the Koordinator looked up, or what it did with a request a card's agent passed on from the
 * owner's words (`to_obeya`), with `token` while those actions wait for "Rückgängig".
 */
export interface Notice {
  /** The card it is about, named when another one is open. */
  cardId?: string;
  text: string;
  token?: string;
  undoMs?: number;
}
