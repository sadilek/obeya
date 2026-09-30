// Shapes shared by the server and the UI.

export type CardKind = 'bugfix' | 'feature' | 'project';

export const STATES = ['proposal', 'planned', 'working', 'waiting', 'approved', 'inPr', 'live'] as const;
export type CardState = (typeof STATES)[number];

/** What a `waiting` card waits for. */
export type Need = 'demo' | 'question';

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

/** Server → UI over the WebSocket. */
export type ServerMessage = { type: 'snapshot'; snapshot: CanvasSnapshot };
