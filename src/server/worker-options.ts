// What a repository's `Workers` are given, and what follows from it for each of their parts.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { RepoAdapter } from '../adapters/types';
import type { Language } from '../core/locale';
import type { Item } from '../core/types';
import type { Harness } from '../core/agents';
import type { RepoSettings } from '../core/config';
import type { Board } from './board';
import type { FolderWorkspaces } from './folder';
import type { Forge } from './forge';
import type { InputContext } from './learner';
import type { StoredDemo } from './row';
import type { AgentRuntime } from './runtime';
import type { CardWorkspaces, Landed, Workspaces } from './workspaces';

export interface WorkerOptions {
  board: Board;
  runtime: AgentRuntime;
  workspaces: CardWorkspaces;
  adapter: RepoAdapter;
  /**
   * The settings the owner set for the repository on this machine, in front of its
   * `.obeya/settings.json`: how work lands where they say so, whatever a card's branch changes.
   */
  machineSettings?: () => RepoSettings | undefined;
  /** Whether the repository shares demos on a page now (the configuration's command, the site its settings name); its settings' site alone when left out. */
  shares?: () => boolean;
  permissionMode?: PermissionMode;
  /** The owner's preferences, added to every worker's instructions. */
  preferences?: () => string;
  /** Called with everything the owner tells a worker, so lasting preferences can be learned. */
  onOwnerInput?: (card: Item, kind: 'answer' | 'note' | 'feedback', text: string, context?: InputContext) => void;
  /** On a canvas with several repositories: the one these workers work in. */
  repo?: string;
  /** The boards of the other canvases this Obeya runs: a worker proposes a card in their repositories too. */
  otherBoards?: () => Board[];
  /** The worker reported the card's pull request: a demo shared before gets its link. */
  onPrOpened?: (cardId: string) => void;
  /**
   * The owner approved the card's work (before it lands): its demo goes public where the
   * repository's site publishes on approval. Returns the trailer for the commit that lands, for a
   * card with a page (`Demo-Video: <url>`).
   */
  onApproval?: (cardId: string) => string | null;
  /** The default branch has moved: the card's pull request was merged, or its work pushed there directly. */
  onMerged?: (cardId: string) => void;
  /** A review card's worker made a follow-up task (`followUpTask`): it goes to the Coordinator, to wait for the PR's merge. */
  onFollowUpTask?: (taskId: string, reviewId: string) => void;
  /** The card's work landed on the default branch without a pull request (`shipped` says where): its shared page links the commit. */
  onLanded?: (cardId: string) => void;
  /** A prototype was handed over: the idea's agent hears the summary. */
  onPrototype?: (prototype: Item, summary: string, demo: StoredDemo | undefined) => void;
  /** A question on a prototype was answered: the idea's agent hears both, so its brief holds them. */
  onPrototypeAnswer?: (prototype: Item, question: string, answer: string) => void;
  /** How long an ended turn waits for a sign of the worker once none of its background work runs (any more). */
  backgroundGrace?: number;
  /** How long an ended turn waits at most while the worker's background work still runs. */
  backgroundLimit?: number;
  /** How long a worker asked to pause at a safe point has for it, before Obeya pauses it at once. */
  pauseLimit?: number;
  /** How long a card waits for the owner, its worker idle, before Obeya stops its workspace's app (`app.stop`). */
  parkGrace?: number;
  /** How long after the owner last opened the card's app Obeya leaves it running at the least, for them to try it by hand. */
  tryGrace?: number;
  /** How long the owner's comments on places in the demo video wait at most for them to finish watching. */
  holdGrace?: number;
  /** How long comments the owner finished watching with wait for an approval clicked at the same time, which takes them. */
  releaseDelay?: number;
  /** How often a session cut off from its machine asks whether that machine answers again; 30 s when left out. */
  reconnectMs?: number;
  /** How long after a usage limit lifts the worker goes on, so that clocks a little apart do not matter. */
  limitMargin?: number;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  /**
   * Whether Obeya starts again for work that landed (`obeya`): it runs from this repository's
   * checkout and the work changed code; or only this repository's agents do (`repo`): the work
   * changed where they work (its own adapter, its `.obeya/settings.json`). `pushedFrom` is the
   * workspace work was pushed from straight to the remote's main, which leaves the checkout as it is.
   */
  restartsFor?: (landed: Landed, pushedFrom?: string) => Promise<'obeya' | 'repo' | false> | 'obeya' | 'repo' | false;
  /** Added to every worker's environment: where Obeya is (`OBEYA_URL`), for a demo's narration. */
  env?: Record<string, string>;
  /**
   * The GitHub account set for the repository on this machine (`accountLogin`): its token goes into
   * every worker's environment, so the agent's gh works as that account. A session starts once it
   * was read for the first time.
   */
  githubLogin?: { env: () => Record<string, string> | undefined; ready: () => Promise<unknown> };
  /** The narration language of the demo settings, for a repository that names none for its demos; the conversation language when left out. */
  demoLanguage?: () => Language;
  /** The harness the workers' group runs on (`withAgentSetting`), where a card chose none: how a worker waits differs by it. Claude Code when left out. */
  harness?: () => Harness;
  /** Where Obeya keeps a copy of each demo handed over (`keepDemo`), by card and handover; without it a demo's files are only where the worker made them. */
  keptDemos?: string;
  /** The directory demos go into on this machine (the demo settings'); `~/demos` when left out. */
  demoDirectory?: () => string;
  /** A card's work ended (landed, closed without a change, a prototype discarded or built): its runs can be read now. */
  onWorkEnded?: (cardId: string, workspace: string | null) => void;
  /** Passes on to the Coordinator what the owner's words to a card's worker ask of Obeya (`to_obeya`); without it the worker has no such tool. */
  toObeya?: (cardId: string, request: string) => Promise<string>;
  /** Where pull requests live: a review card's is read, commented on and merged through it. */
  forge?: Forge;
  /** The repository's checkout, where the forge's calls run for a card without a workspace on this machine. */
  repoPath?: string;
  /** The URL of the checkout's `origin`, where a review card's PR head is fetched from when it is that repository. */
  remote?: string | null;
  /**
   * What happens to the checkout's main around a review card's merge where work lands on it
   * (`Workspaces`): before the merge, whether its unpushed commits would stop the pull of it; after,
   * the pull, and where that stops, the landing of the rebase a worker resolved.
   */
  pulls?: Pick<Workspaces, 'pullMain' | 'pushMain' | 'clashBeforeMerge' | 'landResolution' | 'landingOf'>;
  /** How long pushing main for a review card waits for the owner's "Undo"; UNDO_HOLD_MS when left out. */
  pushHold?: number;
  /** How long Obeya waits between looks at whether the forge shows a review card's pushed commits as the PR's head; a second when left out. */
  pushSettle?: number;
}

/** The folder without git the cards work in, where the repository is one (design: Folders without git). */
export function folderOf(o: WorkerOptions): FolderWorkspaces | null {
  return o.workspaces.mode === 'folder' ? (o.workspaces as FolderWorkspaces) : null;
}

/** Whether a video demo here may go to a page for colleagues, which the worker then writes. */
export function sharesOf(o: WorkerOptions): boolean {
  return o.shares ? o.shares() : !!o.adapter.demo?.site;
}
