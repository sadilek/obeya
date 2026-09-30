// Shapes shared by the server and the UI.

export type CardKind = 'bugfix' | 'feature' | 'project';

export const STATES = ['proposal', 'planned', 'working', 'waiting', 'approved', 'inPr', 'live'] as const;
export type CardState = (typeof STATES)[number];

/** What a `waiting` card waits for. `review` stands in for `demo` until workers record demos (M4). */
export type Need = 'demo' | 'question' | 'review';

export interface Question {
  text: string;
  options: string[];
}

/** One item on the canvas as the UI sees it: a stored card merged with what its plan doc says. */
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
  /** The worker's latest `report`. */
  statusLine?: string;
  /** Open question, when `need` is `question`. */
  question?: Question;
  /** The worker's summary, when `need` is `review` or `demo`. */
  summary?: string;
  /** The demo, when `need` is `demo`; its files are served under `/api/cards/:id/demo/`. */
  demo?: Demo;
  /** A proposal's source card. */
  from?: string;
  /** The repository the card belongs to (an id from the canvas's `repos`). */
  repo: string;
  branch?: string;
  /** Files the Koordinator expects the card to change. */
  scope?: string[];
  /** A planned card the Koordinator is deciding on, or that waits for cards in progress. */
  queue?: Queue;
  /** The pull request, once the worker opened it after approval. */
  pr?: PullRequest;
  /** When the owner archived the card; archived cards are not on the canvas but in its archive. */
  archivedAt?: string;
}

export interface PullRequest {
  url: string;
  number: number;
  /** Checks on the PR's latest commit, as last seen. */
  checks: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  conflict: boolean;
}

export type Queue = { checking: true } | { cutting: true } | { behind: string[]; reason: string };

export interface Demo {
  /** Seconds and title of each scene. */
  chapters: [number, string][];
  shown: string[];
  notShown: string[];
  findings: string[];
  /** A question only the owner can answer, beyond "approve or give feedback". */
  question?: string;
}

/** One line in a card's log. */
export interface CardEvent {
  id: number;
  cardId: string;
  at: string;
  kind: 'report' | 'activity' | 'say' | 'question' | 'answer' | 'hint' | 'review' | 'state' | 'error';
  author: 'worker' | 'owner' | 'project' | 'koordinator' | 'obeya';
  text: string;
  /** Set on an error the UI words itself; `text` then holds the server's technical detail. */
  code?: ErrorCode;
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
}

export interface CanvasSnapshot {
  canvas: CanvasInfo;
  items: Item[];
  preferences: Preference[];
}

/** A lasting preference of the owner, learned by the Koordinator or written by the owner. */
export interface Preference {
  id: number;
  text: string;
  /** The card whose exchange it was learned from. */
  cardId?: string;
}

export interface NewCard {
  kind: 'bugfix' | 'feature';
  title: string;
  body?: string;
  x: number;
  y: number;
  /** A repository of the canvas; its home repository when left out. */
  repo?: string;
}

export interface CardPatch {
  x?: number;
  y?: number;
  kind?: 'bugfix' | 'feature';
  title?: string;
  body?: string;
  state?: CardState;
  need?: Need | null;
  /** Another repository of the canvas, before work on the card has begun. */
  repo?: string;
}

/** Owner actions on a card's work, posted to `/api/c/:canvas/cards/:id/act`. */
export type CardAction =
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'message'; text: string }
  | { action: 'answer'; text: string }
  | { action: 'approve' }
  /** Start a queued card although it may collide. */
  | { action: 'force' }
  | { action: 'dequeue' }
  /** Let the Koordinator cut the card into packages that can run in parallel. */
  | { action: 'split' }
  | { action: 'accept' }
  | { action: 'dismiss' };

/**
 * Why the server refused a request. The server sends the code and an English detail
 * (`{ code, error }`, status 400); the UI shows its own text for the code.
 */
export type ErrorCode =
  | 'unknownCard'
  | 'project'
  | 'notPlanned'
  | 'queued'
  | 'notQueued'
  | 'notSplittable'
  | 'noAgent'
  | 'noQuestion'
  | 'notReady'
  | 'notProposal'
  | 'planCard'
  | 'noWorkspace'
  | 'dirtyWorkspaces'
  | 'workspace'
  | 'emptyText'
  | 'unknownPreference'
  /** Only a finished card of the owner's goes into the archive. */
  | 'notDone'
  | 'notArchived'
  /** Approval could not land the work on main. */
  | 'landDirty'
  | 'landConflict'
  | 'landEmpty'
  | 'landCheckout'
  | 'landMerge'
  | 'land'
  /** Malformed input: a bug in the UI rather than something the owner can fix. */
  | 'invalid';

/** Server → UI over the WebSocket. */
export type ServerMessage = { type: 'snapshot'; snapshot: CanvasSnapshot } | { type: 'event'; event: CardEvent };
