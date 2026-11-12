// What a card's row (`CardRow` in db.ts) stores in its JSON columns: the shape of each, and how it
// is read.

import type { Contribution, Demo, DemoKind, HeldChanges, Idea, Mock, NewRepo, NextStep, PageTags, PlannedPrototype, PrReviewEntry, PrWait, Question, SettledPart } from '../core/types';
import type { CardLanding } from '../core/config';
import type { PullStopped } from './workspaces';

declare const holds: unique symbol;

/** A JSON column's text, typed with what it holds: `fromJson` reads it as that. Any string can be written to it. */
export type Json<T> = string & { readonly [holds]?: T };

/** What a JSON column holds; null where it is empty. */
export function fromJson<T>(text: Json<T>): T;
export function fromJson<T>(text: Json<T> | null): T | null;
export function fromJson<T>(text: Json<T> | null): T | null {
  return text ? (JSON.parse(text) as T) : null;
}

/** A value as the JSON column it is written to holds it: the column's type checks it. */
export const toJson = <T>(value: NoInfer<T>): Json<T> => JSON.stringify(value);

/**
 * What a card waits on or was handed over with (`CardRow.detail`): the open question (with the
 * tool call that asked the owner's permission), or the handover's summary, whether the work changed
 * nothing and where it lands, and whether its worker is answering the owner's words since.
 */
export interface Detail {
  question?: Question;
  permission?: AskedPermission;
  summary?: string;
  noChange?: boolean;
  lands?: CardLanding;
  answering?: boolean;
  answered?: boolean;
}

/** The Coordinator's estimate of the files a card changes (`CardRow.scope`). */
export interface Scope {
  files: string[];
  reason: string;
}

/** What Obeya keeps about a card's pull request; `url` is null until the worker opened it. */
export interface PrState {
  url: string | null;
  number?: number;
  /** Comments already passed to the worker. */
  seen: string[];
  /** `check@commit` of failures already passed to the worker. */
  reported: string[];
  /** The commit a conflict was last reported for. */
  conflictHead?: string;
  /** The commit the worker was last told its reviewers have not seen. */
  staleHead?: string;
  /** A review card waiting for the contributor: the PR's head when it began to wait, and the one the worker was last told was pushed. */
  headSeen?: string;
  pushedHead?: string;
  /** The commit the PR was found ready to merge at; gone once something is left to do again. */
  readyHead?: string;
  /** Why the forge refused Obeya's merge of the ready PR: then the owner merges. */
  mergeError?: string;
  /** Since when reading the PR fails, and whether the card said why; gone once it reads again. */
  readError?: { since: number; shown?: boolean };
  /** A ready PR's reviewer confidence too low for Obeya to merge it: the owner decides. */
  held?: { score: string; by: string };
  /** A ready PR the repository's settings leave to the people on the forge to merge (`autoMerge` off). */
  manual?: true;
  /** The commit a branch behind its base, which the repository wants up to date, was last reported for. */
  behindHead?: string;
  checks?: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  /** The review as last seen, for the card. */
  review?: PrReviewEntry[];
  /** What the PR waits for before it is merged, as last polled; gone once it is ready. */
  waits?: PrWait[];
  /** `owner/name` of the PR's repository, where that is another than the card's. */
  repo?: string;
  /** Merged while the card's other pull requests were not yet: the commit the merge put on the base, where the forge said. */
  merged?: string | true;
  /** Closed without a merge: the owner was asked, and it holds up nothing. */
  closed?: true;
  /**
   * On the card's first pull request: the further ones the worker opened for the same work (in
   * other repositories, or a second in its own), each watched as the first; the card is live once
   * all are merged. The first is the one in the card's repository, which the landing is about.
   */
  more?: PrState[];
}

/** What is stored of a review card's pull request (`CardRow.contribution`): what the card shows, and what only the server needs. */
export interface StoredContribution extends Contribution {
  /** `base`: the PR's head the held commits go on top of, as it stood at the handover. */
  held?: HeldChanges & { base: string };
  /** The owner chose "Change it myself", and the worker's changes have not gone out yet: requests to the contributor wait for them. */
  changing?: true;
  /** The PR's head commit the worker reviewed at its latest handover: only that one is merged. */
  reviewed?: string;
  /** Where the PR's branch is, for a worker that pushes onto it: its repository's URL and branch. */
  headRepo?: string;
  headRef?: string;
  /** The owner approved: the demo's page is linked in a comment on the PR once it is online. */
  approved?: true;
  /** The page's address Obeya linked in a comment on the PR. */
  linked?: string;
  /** The PR was closed without a merge, and the owner was asked whether the card can go. */
  closed?: true;
  /** The PR's head at which the owner's approval last met a conflict with main, which went to the worker to resolve. */
  conflict?: string;
}

/** What a card's work landed with (`CardRow.shipped`); it stays after the worker is done. */
export interface Shipped {
  /** The commit on the default branch that holds the work; none while it is not known (`fetch`). */
  commit?: string;
  /**
   * Where the work's diff starts, so `base..commit` is what it changed: the default branch before it
   * landed, or a merge commit's first parent (`<commit>^`). None where that is not known (a merge
   * GitHub did not name).
   */
  base?: string;
  /** Merged as a pull request: that one. */
  pr?: { url: string; number: number };
  /** The merge commit is not known: the read tree's commit after the next fetch stands in for it. */
  fetch?: true;
}

/**
 * Which workstream of a project builds on which (`CardRow.deps`), as the Coordinator read it from
 * the plan doc: `on` by workstream key, for the doc's workstreams as they stood then (`sig`,
 * `depsSig`). `reading` while it reads them: `auto` for a project just come, which it arranges by
 * them unless the owner moved one of its cards first; `owner` when they asked to arrange it.
 */
export interface StoredDeps {
  sig?: string;
  on?: Record<string, string[]>;
  reading?: 'auto' | 'owner';
}

/** A demo version on a card's shared page, with what the page says of it, so it can be published again as it is. */
export interface SharedDemo {
  /** The handover it came with (`Demo.handover`): which of the card's demos it is. */
  handover?: number;
  /** When that handover was: a later version's section on the page is headed with it. */
  at?: string;
  /** The demo's directory. */
  dir: string;
  shown: { title: string; text: string; chapters: [number, string][]; kind: DemoKind };
}

/** Which of a card's demos a share means: by its handover, or by its directory where one of the two has no handover. */
export type DemoRef = { handover?: number; dir: string };

/** What Obeya keeps about a card's shared demo page (share.ts): one page per card, holding one or more of its demo versions. */
export interface StoredShare {
  /** The page's name on the site; it stays with the card, so its link keeps working. */
  slug: string;
  /** While published or withdrawn; none when at rest. */
  state?: 'publishing' | 'withdrawing';
  /** The published page. */
  url?: string;
  /** The demo versions on the published page, in order of handover: the first on top, each later one below as an addendum. */
  demos?: SharedDemo[];
  /** While `publishing` without `refresh`: the versions the page is to show, as the owner chose them. */
  next?: DemoRef[];
  /** The pull request the published page links. */
  pr?: string;
  /** Without a pull request: the address of the commit (or the comparison over the commits) the published page links. */
  commit?: string;
  /** While `publishing`: the page goes out again as it is, now with the PR's link; the card shows it as shared meanwhile. */
  refresh?: true;
  /** The newest page change (page-changes.ts) when it was published, '' before any: the changes after it are what sharing again brings. */
  version?: string;
  /** While `publishing` (with `refresh`): the page goes out again as it is, one of many the owner shares again at once. */
  again?: true;
  /** While `publishing` (with `refresh`): the page goes out again as it is, with the tags the owner set. */
  retag?: true;
  /** The owner unticked "Share on approval": where the site publishes on approval, approving the card shares nothing. */
  notOnApproval?: true;
  /** The page's tags the owner set by hand, by dimension: neither a worker nor the reading session changes them. */
  tags?: PageTags;
  /** The page's tags the reading session chose, by dimension, where neither the owner nor a worker had (`pageTagsOf`). */
  auto?: PageTags;
  /** The page is on the owner's personal site (unlisted), not on its repository's. */
  personal?: true;
  /** The random part of the page's address on the personal site (`<token>/<slug>`): drawn once for the card, so its link stays. */
  token?: string;
  /** The hash of its repository's theme (theme.ts) the published page carries; none where it carries none. */
  theme?: string;
}

/**
 * A demo as a card keeps it (`CardRow.demo`, and each of `CardRow.demos`): where its files are, and
 * for the latest one handed over, where Obeya keeps a copy of them (`keepDemo`). Once a later one
 * comes, it is the copy that the earlier demo's `dir` names.
 */
export type StoredDemo = Demo & { dir: string; kept?: string };

/** What is stored of a repository to create for a card: the target, and once Obeya made it, `made`. */
export type StoredNewRepo = NewRepo & { made?: true; none?: true };

/** What is stored of a prototype: how it ended, once it did, and its worker's proposal to build the idea on it. */
export interface StoredPrototype {
  /** The planned variant it shows. */
  variant?: string;
  end?: 'discarded' | 'built';
  /** Built for a workstream of the project its idea became: that workstream, as the owner reads it. */
  into?: string;
  proposal?: string;
}

/** What is stored of an idea; `thinking` while its agent works on a reply, `yourTurn` once it replied. */
export interface StoredIdea {
  status: Idea['status'];
  brief: string;
  thinking?: boolean;
  /** "Build it like this" waits for the reply its agent works on; questions in it call the building off. */
  buildAfterReply?: boolean;
  yourTurn?: boolean;
  questions?: Question[];
  next?: NextStep;
  /** The prototypes the brief plans, as the agent last set them. */
  variants?: PlannedPrototype[];
  /** The brief's mocks, as the agent last set them. */
  mocks?: Mock[];
  /** The settled part "Split off a task" builds, as the agent last marked it. */
  split?: SettledPart;
  /** Messages a turn ended before answering (the idea parked or dropped, an error, a restart); they go to the agent first next time. */
  unread?: Unread;
}

/** A message to an idea's agent: its text and the files of its screenshots. */
export interface Message {
  text: string;
  images: string[];
  /** The lines of the card's log with the owner's words it carries: unread until the agent takes it in. */
  said: number[];
}

/** A Question card's thread as stored: the exchange it started with, and its agent's turn. */
export interface StoredThread {
  talk: number;
  /** Its agent is reading, for what the owner asked on the card. */
  thinking?: boolean;
  /**
   * What the owner asked that the agent has not answered yet: behind a running turn, or left by a
   * restart; `talk`: asked in Obeya's sheet, whose exchange gets the answer too.
   */
  pending?: (Message & { talk?: number })[];
  answers: number;
  files: number;
}

export interface Unread {
  why: 'parked' | 'dropped' | 'error' | 'restart' | 'paused';
  messages: Message[];
}

/** A comment on a place in the demo video held back while the owner watches (`CardRow.held`). */
export interface HeldComment {
  id: number;
  spoken?: true;
}

/** What is stored while landed work's worker finishes (`CardRow.landed`). */
export interface LandedState {
  commit?: string;
  /** Nothing landed: the work changed nothing in the repository, and the card is `done` rather than `live`. */
  unchanged?: boolean;
  /** Obeya starts again for the landing. */
  restarts?: boolean;
  /** The worker waits for that restart. */
  waits?: boolean;
  /** The card's demo is going out on its page: the worker waits to hear the page's address (`pageSettled`). */
  page?: boolean;
  /** Not a landing: the owner asked about the finished card, and its worker was resumed to answer. */
  followUp?: boolean;
  /** The follow-up runs in a temporary worktree (`followUpTree`), no clone being free: it goes once the follow-up ends. */
  worktree?: boolean;
  /** The follow-up's worker needs a full clone: without a workspace, it waits for the next free one (`takeClone`). */
  needsClone?: boolean;
  /**
   * Not a landing of its own: pulling a review card's merged PR (`card`, PR `pr`) into the local
   * main stopped on a conflict (`stopped`), and this card's worker resolves it (`resolvePull`).
   */
  resolve?: Resolving;
}

/** A pull after a review card's merge that a worker resolves (`LandedState.resolve`). */
export interface Resolving {
  card: string;
  pr: number;
  url: string;
  stopped: PullStopped;
  /** The worker was reminded once that its turn ended with the pull unresolved. */
  reminded?: true;
}

/**
 * The owner's words Obeya holds for the worker while it is in a turn (`CardRow.unheard`), each with
 * the lines of the log it carries: it takes them in with its next tool step's result, or, should
 * the turn end before one, as the message that starts the next.
 */
export interface Unheard {
  said: number[];
  text: string;
  images: string[];
}

/**
 * Where the card's demo page stood when its worker last heard of it (`CardRow.page_heard`): going
 * online, online at its address (showing an earlier demo than the latest), or on no page.
 */
export type PageHeard = { page: 'none' } | { page: 'going' } | { page: 'online'; url: string; stale?: true };

/** What is stored while the owner has paused the card's worker (`CardRow.paused`). */
export interface PausedState {
  /** What Obeya had for the worker meanwhile (its pull request's review, the landing), and a message it had not taken in yet: it hears them once it goes on. */
  held?: { text: string; images: string[] }[];
}

/** What a tool call that needs the owner's permission was (`detail.permission`): a call allowed after its session was gone runs once it comes again. */
export interface AskedPermission {
  name: string;
  input: Record<string, unknown>;
}
