// Shapes shared by the server and the UI.

export type CardKind = 'bugfix' | 'feature' | 'project';

export const STATES = ['idea', 'proposal', 'planned', 'working', 'waiting', 'approved', 'inPr', 'live'] as const;
export type CardState = (typeof STATES)[number];

/** What a `waiting` card waits for. `review` stands in for `demo` until workers record demos (M4). */
export type Need = 'demo' | 'question' | 'review';

/** A question an agent asks the owner, with answer options to choose from when it has them. */
export interface Question {
  text: string;
  options: string[];
  /** Several options may be chosen together. */
  multiple?: boolean;
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
  /**
   * Open question: the worker's, when `need` is `question`; or the one in its demo report, while
   * the demo waits for approval and the owner has not answered it.
   */
  question?: Question;
  /** The worker's summary, when `need` is `review` or `demo`. */
  summary?: string;
  /** The demo, when `need` is `demo`; its files are served under `/api/cards/:id/demo/`. */
  demo?: Demo;
  /** The card it comes from: a proposal's source, a spike's idea, or the card a follow-up follows up on. */
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
  /** Ideas only: what the discussion has settled so far. */
  idea?: Idea;
  /** A spike's idea: the throwaway prototype is built for it and never lands. */
  spikeOf?: string;
  /** The work has landed and its worker finishes what remains (a migration, say) before its session ends. */
  finishing?: boolean;
  /** Screenshots the owner attached to the card's task; its worker gets them at the start. */
  images?: string[];
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
  /** The agent replied and the owner has not answered yet: an open idea then needs the owner. */
  yourTurn: boolean;
  /** The questions of the agent's latest reply, until the owner says something. */
  questions: Question[];
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
  /** The owner's answer to it; the demo keeps waiting for approval. */
  answer?: string;
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
  /** The owner's latest exchanges with the Koordinator without an open card (those with one are in its log). */
  talk: Talk[];
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
  kind?: 'bugfix' | 'feature';
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
  | { action: 'start' }
  | { action: 'stop' }
  /** `images`: ids of screenshots uploaded before (`POST /api/c/<canvas>/images`); with them the text may be empty. */
  | { action: 'message'; text: string; images?: string[] }
  | { action: 'answer'; text: string; images?: string[] }
  | { action: 'approve' }
  /** Start a queued card although it may collide. */
  | { action: 'force' }
  | { action: 'dequeue' }
  /** Let the Koordinator cut the card into packages that can run in parallel. */
  | { action: 'split' }
  /** A proposal becomes the owner's card and starts; with `start: false` it is only planned. */
  | { action: 'accept'; start?: boolean }
  | { action: 'dismiss' }
  /** Ideas: talk to the exploration agent; `spoken` gets a short spoken summary back. */
  | { action: 'discuss'; text: string; spoken?: boolean; images?: string[] }
  /** Ideas: the brief becomes the card's task and the card is planned. */
  | { action: 'build' }
  /** Ideas: a planned card whose worker writes a plan doc from the brief. */
  | { action: 'planDoc' }
  | { action: 'park' }
  | { action: 'drop' }
  /** Ideas: a worker builds a throwaway prototype and shows it as a demo on the idea. */
  | { action: 'spike'; text?: string };

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
  /** An uploaded screenshot is no image the agents read, or too large. */
  | 'imageType'
  | 'imageTooLarge'
  /** Only a finished card of the owner's goes into the archive. */
  | 'notDone'
  | 'notArchived'
  | 'notIdea'
  /** A spike for the idea is still running. */
  | 'spikeRunning'
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
export type ServerMessage =
  | { type: 'snapshot'; snapshot: CanvasSnapshot }
  | { type: 'event'; event: CardEvent }
  /** First on every connection: which server process this is, so a page from an earlier one reloads. */
  | { type: 'hello'; server: string }
  /** A short spoken summary of a card's agent (an idea's reply), to play while the card is open. */
  | { type: 'speak'; cardId?: string; audio: string };
