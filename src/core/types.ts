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
  /** The worker's summary, when `need` is `review`. */
  summary?: string;
  /** A proposal's source card. */
  from?: string;
  branch?: string;
  /** Files the Koordinator expects the card to change. */
  scope?: string[];
  /** A planned card the Koordinator is deciding on, or that waits for cards in progress. */
  queue?: Queue;
}

export type Queue = { checking: true } | { behind: string[]; reason: string };

/** One line in a card's log. */
export interface CardEvent {
  id: number;
  cardId: string;
  at: string;
  kind: 'report' | 'activity' | 'say' | 'question' | 'answer' | 'hint' | 'review' | 'state' | 'error';
  author: 'worker' | 'owner' | 'project' | 'koordinator' | 'obeya';
  text: string;
}

export interface CanvasInfo {
  id: string;
  name: string;
  repoPath: string;
  branch: string;
}

export interface CanvasSnapshot {
  canvas: CanvasInfo;
  items: Item[];
}

export interface NewCard {
  kind: 'bugfix' | 'feature';
  title: string;
  body?: string;
  x: number;
  y: number;
}

export interface CardPatch {
  x?: number;
  y?: number;
  kind?: 'bugfix' | 'feature';
  title?: string;
  body?: string;
  state?: CardState;
  need?: Need | null;
}

/** Owner actions on a card's work, posted to `/api/cards/:id/act`. */
export type CardAction =
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'message'; text: string }
  | { action: 'answer'; text: string }
  | { action: 'approve' }
  /** Start a queued card although it may collide. */
  | { action: 'force' }
  | { action: 'dequeue' }
  | { action: 'accept' }
  | { action: 'dismiss' };

/** Server → UI over the WebSocket. */
export type ServerMessage = { type: 'snapshot'; snapshot: CanvasSnapshot } | { type: 'event'; event: CardEvent };
