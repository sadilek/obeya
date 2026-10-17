// Workers: one agent session per card, in a leased clone. Obeya is the mailbox between the
// worker and the owner; every exchange lands in the card's conversation.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RepoAdapter } from '../adapters/types';
import type { CardDiff } from '../core/diff';
import { LANGUAGE_NAMES, LANGUAGES, ownersLanguage, repositoryLanguage } from '../core/locale';
import { MESSAGES, type Messages, type Pause } from '../core/messages';
import { basename } from 'node:path';
import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';
import { answering, askable, type Awaited, AWAITED_STATES, awaited, type BackgroundTask, pausable, type CardLanding, type DemoKind, type DemoPage, finished, formatQuestion, handedOver, type Item, type TaskAuthor, taskAuthor, type Mock, ownWords, pickedAnswer, type Question, type RepoSettings, type RestartReason, type Snooze, type Spot, type Superseded, type SpotInput, started } from '../core/types';
import { BadRequest, type Board, replyNote, type Retracted, type StoredDemo, titleKey } from './board';
import { type Asked, decisionLog, toQuestion, withPick } from './advisor';
import { checkArtifact, DEMO_SKILL, DEMO_SKILL_FILE, demoSkillName, OBEYA_PLUGIN, placeIn, readChapters } from './demo';
import { artifactFiles } from './demo-page';
import { imageNote } from './images';
import { outsidePlanDir } from './repo';
import type { InputContext } from './koordinator';
import { type AgentEvent, type AgentRuntime, type AgentSession, type AgentTool, BACKGROUND_GRACE, BACKGROUND_LIMIT, failureReason, LIMIT_LIFTED, limitLifts, type PermissionAnswer, type PermissionRequest } from './runtime';
import { TO_OBEYA, toObeyaTool } from './to-obeya';
import { type Forward, HOST_DIR, hostName, remote } from './hosts';
import { runAppCommand } from './app-command';
import { readingShared } from '../adapters';
import { branchName, type CardWorkspaces, gitStepsSync, type Landed, shortageOf, together, WorkspaceError } from './workspaces';
import type { FolderWorkspaces, UndoReport } from './folder';
import type { PrState, Shipped } from './board';
import type { CardRow } from './db';
import { parsePrUrl } from './forge';
import { clip, messageOf } from '../core/text';
import { inQueue } from '../core/queue';

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
  /** A prototype was handed over: the idea's agent hears the summary. */
  onPrototype?: (prototype: Item, summary: string, demo: string | undefined) => void;
  /** A question on a prototype was answered: the idea's agent hears both, so its brief holds them. */
  onPrototypeAnswer?: (prototype: Item, question: string, answer: string) => void;
  /** How long an ended turn waits for a sign of the worker once none of its background work runs (any more). */
  backgroundGrace?: number;
  /** How long an ended turn waits at most while the worker's background work still runs. */
  backgroundLimit?: number;
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
  restartsFor?: (landed: Landed, pushedFrom?: string) => 'obeya' | 'repo' | false;
  /** Added to every worker's environment: where Obeya is (`OBEYA_URL`), for a demo's narration. */
  env?: Record<string, string>;
  /** A card's work ended (landed, closed without a change, a prototype discarded or built): its runs can be read now. */
  onWorkEnded?: (cardId: string, workspace: string | null) => void;
  /** Passes on to the Koordinator what the owner's words to a card's worker ask of Obeya (`to_obeya`); without it the worker has no such tool. */
  toObeya?: (cardId: string, request: string) => Promise<string>;
}

/** The owner's comments on places in the demo video that go with their approval, as the worker reads them. */
type Comments = { text: string; images: string[] };

/** A comment on a place in the demo video held back while the owner watches (`CardRow.held`). */
interface HeldComment {
  id: number;
  spoken?: true;
}

/** Where in the demo video the owner's words are, as the worker reads it above them. */
export const spotNote = (spot: Spot) => {
  return `[${spot.earlier ? 'Earlier demo video, one a later handover of yours replaced,' : 'Demo video'} at ${mmss(spot.at)}${spot.chapter ? `, chapter „${spot.chapter}“` : ''}${spot.narration ? `, narration: „${spot.narration}“` : ''}]`;
};

/** What is stored while landed work's worker finishes (`CardRow.landed`). */
interface LandedState {
  commit?: string;
  /** Nothing landed: the work changed nothing in the repository, and the card is `done` rather than `live`. */
  unchanged?: boolean;
  /** Obeya starts again for the landing. */
  restarts?: boolean;
  /** The worker waits for that restart. */
  waits?: boolean;
  /** Not a landing: the owner asked about the finished card, and its worker was resumed to answer. */
  followUp?: boolean;
  /** The follow-up runs in a temporary worktree (`followUpTree`), no clone being free: it goes once the follow-up ends. */
  worktree?: boolean;
  /** The follow-up's worker needs a full clone: without a workspace, it waits for the next free one (`takeClone`). */
  needsClone?: boolean;
}

/** Landed work's state once what it waited for (the restart) has happened. */
const settled = ({ restarts: _, waits: __, ...l }: LandedState): LandedState => l;

/** What the card's row stores while landed work's worker finishes; null while nothing has landed. */
const landedOf = (row: { landed: string | null }): LandedState | null => (row.landed ? (JSON.parse(row.landed) as LandedState) : null);

/** What `f` returns; a workspace it cannot have is the request's error. */
function asBadRequest<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof WorkspaceError) throw new BadRequest(e.code, e.message);
    throw e;
  }
}

/** The questions of a proposal (`propose_card`, `revise_proposal`) as the agent gives them. */
export const PROPOSAL_QUESTIONS = z.array(z.object({ question: z.string(), options: z.array(z.string()).max(4).optional(), multiple: z.boolean().optional() })).max(5);

/** The questions of a proposal as the card holds them. */
export const proposalQuestions = (questions: z.infer<typeof PROPOSAL_QUESTIONS> = []) => questions.map((q) => toQuestion(q.question, q.options, q.multiple));

/** How an agent writes a proposal's task, for the agent who takes it on and has not seen `unseen`. */
/** What became of a proposal the worker took back (`replaced`: by a new one), as it reads it. */
const retractedText = (r: Retracted, replaced: boolean): string => {
  if (r.kind === 'unknown')
    return `No proposal of yours is called so${replaced ? ', so nothing was replaced' : '; nothing was withdrawn'}. Yours: ${r.mine.length ? r.mine.map((m) => `„${m.title}“ (${m.gone ? 'removed' : m.state})`).join(', ') : 'none'}.`;
  const it = `„${r.title}“`;
  switch (r.kind) {
    case 'gone':
      return `${it} was still open and is gone from the canvas.`;
    case 'marked':
      return `The owner had taken ${it} on already (${r.state}): Obeya marks it as ${replaced ? 'replaced' : 'withdrawn'} and offers the owner to remove it.`;
    case 'finished':
      return `${it} is done already (${r.state}); it stays as it is.`;
    case 'dismissed':
      return `The owner had dismissed ${it} already.`;
    case 'removed':
      return `The owner had removed ${it} already.`;
    case 'already':
      return `${it} was withdrawn already.`;
  }
};

/** What a worker hears of a card's task someone else than the owner wrote: its language tells nothing of the owner's (`ownersLanguage`). */
const TASK_BY: Record<Exclude<TaskAuthor, 'owner'>, string> = {
  plan: "The card's task comes from the project's plan doc, not from the owner: its language tells nothing about theirs.",
  koordinator: "Obeya's Arbeitsrückschau wrote the card's task, not the owner: its language tells nothing about theirs.",
  idea: "The idea's agent wrote the card's task, not the owner: its language tells nothing about theirs.",
  proposal: "A worker proposed the card's task and the owner took it on: its language tells nothing about theirs.",
};

export const proposalTask = (unseen: string) =>
  `task: the card's text, written for the agent who will take it on, which has seen neither ${unseen}: what is wrong or wanted, where (files, names), what done looks like. Write it as the owner would write a card: no "I", no "my question", no "your card"; name other cards by their title.`;

/**
 * The owner's words Obeya holds for the worker while it is in a turn (`CardRow.unheard`), each with
 * the lines of the log it carries: it takes them in with its next tool step's result, or, should
 * the turn end before one, as the message that starts the next.
 */
interface Unheard {
  said: number[];
  text: string;
  images: string[];
}

/** What is stored while the owner has paused the card's worker (`CardRow.paused`). */
interface PausedState {
  /** What Obeya had for the worker meanwhile (its pull request's review, the landing), and a message it had not taken in yet: it hears them once it goes on. */
  held?: { text: string; images: string[] }[];
}

interface Live {
  session: AgentSession;
  /** The machine its workspace is on (null: the one Obeya runs on), where it holds a slot while in a turn. */
  host: string | null;
  /** Whether the worker called `ask` or `ready_for_review` in the current turn. */
  handedOver: boolean;
  /** Whether the worker answered the owner with `reply` in the current turn. */
  answered?: boolean;
  /** Whether the worker had words for the owner in the current turn: said something, replied, or passed their words on to Obeya. */
  spoke?: boolean;
  /** Whether the worker snoozed in the current turn: its session ends with the turn, and its closing words repeat the snooze. */
  snoozed?: boolean;
  /** The worker's words since its reply: its words once a step follows them, its closing words at the turn's end. */
  held?: string;
  /**
   * Whether the worker said or did anything in the current turn. A resumed session may first end a
   * turn of its own, over what the previous session left (a background command the restart stopped).
   */
  acted: boolean;
  nudged: boolean;
  lastText: string;
  /** The error the worker's last turn failed with (not logged in, say); gone once it says or does something. */
  failed?: string;
  /** Between a message and the end of the turn it starts: a restart now would cut the worker off. */
  busy: boolean;
  /** Set while an ended turn waits for the worker's background work to wake it. */
  waiting?: ReturnType<typeof setTimeout>;
  /** Set while the worker waits for a usage limit to lift: it then goes on where it stopped. */
  lifts?: ReturnType<typeof setTimeout>;
  /** How many of the worker's background tasks run, as the session last said. */
  background: number;
  /** Those tasks by the session's id, as the agent described them and since when Obeya saw them run, the oldest first: on the card while they run. */
  tasks: Map<string, BackgroundTask>;
  /** When the usage limit that stopped the worker lifts (or, not knowing, when to try again); gone once it works. */
  limited?: number;
  /** The card's status line from before the worker waited for the limit, back once it works again. */
  statusBefore?: string | null;
  /** Whether the card's open question is the worker having stopped, not a question it asked. */
  stalled: boolean;
  /** Whether the worker has heard of the restart that is due, so that it pauses for it. */
  toldRestart?: boolean;
  /** The card's status line from when the worker heard of the restart, back once it paused: a line about pausing is stale once it goes on. */
  statusBeforeRestart?: string | null;
  /** The worker ended a turn for the restart that is due: a turn that starts before the restart (its background work woke it) hears that Obeya still waits. */
  restartPaused?: boolean;
  /** The owner's preferences as the worker last heard them: in its instructions, or since then. */
  preferences: string;
  /** The project the card is a workstream of, and the last of its decisions the worker has heard of. */
  project?: { id: string; decision: number };
  /** Stands in for the agent of a card that has no session (`standIn`): its tools run all the same. */
  standIn?: true;
  /** A tool call waits for the owner's permission, the question the card waits on: settles it with their answer. */
  permission?: (answer: PermissionAnswer) => void;
  /** The permission asked last, which the next one waits for: the card holds one question at a time. */
  asking?: Promise<unknown>;
  /** The message that started the current turn, until the worker shows it has taken it: a session on another machine that is cut off before gets it again. */
  pending?: { text: string; images: string[] };
}

/** What a tool call that needs the owner's permission was (`detail.permission`): a call allowed after its session was gone runs once it comes again. */
interface AskedPermission {
  name: string;
  input: Record<string, unknown>;
}

/** A restart that waits for workers to finish their turns: why, and when it goes ahead at the latest. */
export interface DueRestart {
  reason: RestartReason;
  deadline: number;
  /** Only the agents of these workers' repository restart, for a change to its configuration; Obeya runs on. */
  repo?: boolean;
}

/** What the worker pauses for, as the card's log says it. */
const pauseOf = (due: DueRestart): Pause => (due.reason === 'stop' ? 'stop' : due.repo ? 'repo' : 'restart');

/** The owner may pause the demo video for a while; a browser gone away leaves no other sign. */
const HOLD_GRACE = 10 * 60_000;
/** Closing the card with „Freigeben“ also ends the watching: the approval takes the comments then. */
const RELEASE_DELAY = 1500;
/** A quick reply from the owner should not pay for starting the stack again. */
const PARK_GRACE = 5 * 60_000;
/** An app the owner opened to try by hand runs at least this long after, waiting card or not. */
const TRY_GRACE = 30 * 60_000;
/** How long Obeya waits for the app to answer when it looks whether it runs. */
const PROBE_MS = 1500;
/** Whether the card's status line is the one it shows while its worker waits for a usage limit, in either language. */
const limitLine = (line: string | null | undefined) => !!line && LANGUAGES.some((l) => line.startsWith(MESSAGES[l].worker.limitStatus));
/** Said of the owner's words when they came through speech recognition. */
export const SPOKEN = 'spoken, so speech recognition may have misheard words';

/** An answer as the worker reads it: the options the owner picked, apart from the words they added. */
export function answerNote(picks: string[], text: string): string {
  if (!picks.length) return text;
  const words = ownWords({ text, picks });
  return `They picked ${picks.map((o) => `„${o}“`).join(', ')}.${words ? `\n\nThey added in their own words:\n\n${words}` : ''}`;
}

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

/** How often Obeya asks whether a machine whose connection was lost answers again. */
const RECONNECT_MS = 30_000;

const hostResumed = (host: string) =>
  `The connection to ${host}, the machine your workspace is on, dropped, and your session ended with it. Whatever you had running there may have been stopped with it: background commands, servers you started, and a command still running in your turn. Run again what you still need, and go on from there.`;

const RESTARTED =
  'Obeya was restarted. Whatever you had running then was stopped with it: background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need. If you had paused for the restart, go on from there.';

const REPO_RESTARTED =
  "Obeya restarted this repository's agents to apply a change to its configuration. Whatever you had running then was stopped with it: background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need. If you had paused for the restart, go on from there.";

const DUE_WHY: Record<RestartReason, string> = {
  code: 'restart (new code landed on main)',
  config: 'restart (the owner saved a new configuration)',
  repository: "restart (a repository's settings changed on its default branch)",
  stop: 'stop (the owner is shutting it down)',
  update: 'restart (the owner installs a new version of the app)',
};

/** Why Obeya restarts the agents of one repository alone: where they work changed, which they start again with. */
const REPO_WHY: Partial<Record<RestartReason, string>> = {
  config: 'the owner changed its configuration',
  repository: 'its settings changed on its default branch',
};

/** What is about to happen, who it stops, and when the worker goes on, for the messages below. */
const dueText = (due: DueRestart) =>
  due.repo
    ? {
        what: `restart this repository's agents (${REPO_WHY[due.reason] ?? REPO_WHY.config}), you among them,`,
        whom: 'none of them',
        thing: "restart of this repository's agents",
        back: 'once it has restarted them',
      }
    : { what: `${DUE_WHY[due.reason]} and stops whatever its workers run at that moment.`, whom: 'no worker', thing: DUE_WHY[due.reason], back: 'once it runs again' };

/** How long Obeya waits for the restart at most, as the messages below say it. */
const minutesLeft = (due: DueRestart) => {
  const minutes = Math.max(1, Math.round((due.deadline - Date.now()) / 60_000));
  return `at most ${minutes} more minute${minutes === 1 ? '' : 's'}`;
};

/** What is about to happen and how long Obeya waits for it, as the messages to a worker in a turn begin. */
const dueOpening = (due: DueRestart) => {
  const d = dueText(due);
  return `Obeya is about to ${due.repo ? `${d.what} which stops whatever you run at that moment.` : d.what} It waits until ${d.whom} is in the middle of a turn, ${minutesLeft(due)}`;
};

/** Tells a worker that Obeya is about to restart or stop, so that it pauses at a safe point instead of being cut off. */
const restartNotice = (due: DueRestart) =>
  `${dueOpening(due)}. Pause at the next safe point: finish the step you are in, start nothing long (a test run, a demo render, a measurement), and end your turn, without handing over if you are not done. Background commands still running keep Obeya waiting: let those you need finish, stop the others (a scratch server you can start again). One that finishes before the restart wakes you for a turn that keeps Obeya waiting too: take in its result and end that turn as well. Obeya resumes you ${dueText(due).back}, and you go on from there.`;

/**
 * Tells a worker whose turn a message starts while a restart is due (a conflict after an approval,
 * an answer, a card started) that the turn keeps Obeya waiting: it takes the message in and leaves
 * what it asks for until Obeya resumes it, instead of judging a step short enough to do first.
 */
const restartWaits = (due: DueRestart) =>
  `${dueOpening(due)}, and this turn keeps it waiting. Take in this message, leave the work it asks for until Obeya resumes you, and end your turn, without handing over. Obeya resumes you ${dueText(due).back}, and you do that work then.`;

/** Tells a worker that paused for the restart, and was woken before it (by its background work, a message), that Obeya still waits for it. */
const stillDue = (due: DueRestart) =>
  `Obeya still waits for the ${dueText(due).thing} you paused for, ${minutesLeft(due)}, and this turn keeps it waiting. Take in what started it (a background command that finished, a message), leave the work it leads to until Obeya resumes you, and end your turn.`;

const RESUMED =
  'The owner paused you and has now let you go on. Pausing ended your session at once: whatever you had running was stopped with it, background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need, and go on where you stopped.';

/** A year: no snooze lasts longer. */
const SNOOZE_LIMIT = 366 * 24 * 60 * 60_000;

/** Until when a worker snoozed, as it hears it: a time, or the card it waits on (and the time at the latest). */
function snoozedUntil(s: Snooze): string {
  const at = s.until ? MESSAGES.en.at(Date.parse(s.until)) : '';
  if (!s.on) return at;
  const what = s.on.state === 'done' ? 'is done (its work on main, or the card closed without a change)' : 'waits for the owner (a question or a handover)';
  return `the card “${s.on.title}” ${what}${at ? `, or ${at} at the latest` : ''}`;
}

/** What became of the card a snoozed worker waits on, that wakes it. */
function metNote(on: NonNullable<Snooze['on']>, met: Awaited): string {
  const card = `the card “${on.title}”`;
  switch (met) {
    case 'reached':
      return on.state === 'done' ? `${cap(card)} is done: its work is on main, or it closed without a change.` : `${cap(card)} waits for the owner now (a question or a handover), or is done.`;
    case 'gone':
      return `${cap(card)} is gone from the canvas.`;
    case 'archived':
      return `${cap(card)} was archived.`;
    case 'stopped':
      return `The owner stopped ${card}: it is planned again, and nobody works on it.`;
    case 'dropped':
      return `${cap(card)} was an idea, and the owner dropped it.`;
  }
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * What a snoozed worker hears when it wakes: why now (`timeUp`: its time has come; `met`: the card it
 * waits on got there, or no longer can; `owner`: the owner woke it, `words` with words of theirs
 * that follow; else Obeya has something for it).
 */
function wokeNote(s: Snooze, timeUp: boolean, owner: boolean, words: boolean, met?: Awaited): string {
  const now = MESSAGES.en.at(Date.now());
  const until = snoozedUntil(s);
  const why = s.why ? `, to: ${s.why}` : '';
  const ended =
    s.by === 'agent'
      ? 'Your session ended when you snoozed, and whatever still ran in the background then was stopped with it. Run again what you still need.'
      : 'Snoozing ended your session at once: whatever you had running was stopped with it, background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need, and go on where you stopped.';
  if (met && s.on) return `${metNote(s.on, met)} You snoozed until ${until}${why}. ${ended}`;
  if (timeUp) {
    const yet = s.on ? ` The card “${s.on.title}” has not got there yet.` : '';
    return `${s.by === 'owner' ? `The owner snoozed you until ${until}, and it is that time now.` : s.moved ? `It is now ${now}: you snoozed${why}, and the owner moved the time to now.` : s.on ? `It is now ${now}: you snoozed until ${until}${why}.` : `It is now ${now}, the time you snoozed until${why}.`}${yet} ${ended}`;
  }
  const who = s.by === 'owner' ? `The owner snoozed you until ${until}` : s.moved ? `You snoozed${why}, and the owner moved the time to ${MESSAGES.en.at(Date.parse(s.until!))}` : `You snoozed until ${until}${why}`;
  const early = owner ? (words ? 'the owner wakes you early' : 'the owner wakes you early, without words, so tell them with reply where things stand') : 'what follows wakes you early';
  return `${who}; it is now ${now}, and ${early}. ${ended}${s.by === 'agent' ? ' Once you have dealt with it, snooze again if there is still nothing to do until then.' : ''}`;
}

const AFTER_RESTART = 'If something that remains needs Obeya to run your change, call after_restart and end your turn: Obeya tells you once it runs it.';

const AFTER_LANDING =
  'Your workspace and this session stay until you end a turn with nothing left to wait for (a question, the restart); then both end. Commits you make here no longer land.';

const AFTER_DONE = 'This session stays until you end a turn with nothing left to wait for (a question, say); then it ends.';

const FOLLOW_UP_FOLDER =
  "Answer with reply (ask, for a decision that is the owner's). What you change in the folder now counts as this card's, as before, but can no longer be undone from the card: a change the owner's words call for that is more than a small correction becomes a card of its own (propose_card). The session ends once you end a turn with nothing left to wait for.";

const FOLLOW_UP =
  "Answer with reply (ask, for a decision that is the owner's). Commits you make here do not land: a change to the code the owner's words call for becomes a card of its own (propose_card). Workspace and session end once you end a turn with nothing left to wait for.";

const IN_WORKTREE =
  "No clone of the repository was free, so this is a temporary worktree, where the repository's app and tooling may not run. If answering needs a full clone, call need_clone and end your turn: Obeya resumes you in the next free clone.";

export class Workers {
  private live = new Map<string, Live>();
  /** Cards whose approved work is landing: the server answers meanwhile, but approving again is refused, and a restart waits. */
  private landing = new Set<string>();
  /** Bumped whenever a card's work starts, stops or ends: replies and tool calls from before are stale. */
  private generation = new Map<string, number>();
  /** The restart that waits for workers, if one does. */
  private restart: DueRestart | null = null;
  /** Cards that wait for the owner, until their grace runs out and Obeya stops their app. */
  private parking = new Map<string, ReturnType<typeof setTimeout>>();
  /** When the owner last opened a card's app to try it by hand, by card. */
  private tried = new Map<string, number>();
  /** The forwards to the apps of cards whose workspace is on another machine, by card: the address forwarded, from which workspace, and the port here it had last. */
  private forwards = new Map<string, { app: string; workspace: string; forward: Forward; port?: number }>();
  /** Cards whose stack is being stopped: a message to their worker waits until it is. */
  private stopping = new Map<string, Promise<void>>();
  /** Cards whose session on another machine was cut off, waiting for that machine to answer again. */
  private reconnecting = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tool calls the owner allowed after the session that asked was gone (a restart), by card: each runs once, without asking again. */
  private granted = new Map<string, Set<string>>();
  /** Cards with comments on places in the demo video held back: when they go to the worker without the owner's sign. */
  private holding = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private o: WorkerOptions) {
    // what a worker does shows on its card while it is in a turn, and only then can it be paused
    o.board.showTurns(() => this.turnsShown());
    // a forward to a card's app ends once the card no longer offers it: cleared, parked, its workspace gone
    o.board.onChange(() => {
      for (const [id, f] of this.forwards) {
        const card = this.o.board.item(id);
        if (card?.app !== f.app || this.o.board.row(id).workspace !== f.workspace) this.unforward(id);
      }
    });
  }

  /** The folder without git the cards work in, where the repository is one (design: Folders without git). */
  private get folder(): FolderWorkspaces | null {
    return this.o.workspaces.mode === 'folder' ? (this.o.workspaces as FolderWorkspaces) : null;
  }

  /** Whether a video demo here may go to a page for colleagues, which the worker then writes. */
  private get shares(): boolean {
    return this.o.shares ? this.o.shares() : !!this.o.adapter.demo?.site;
  }

  // ---------------------------------------------------------------- owner actions

  start(cardId: string) {
    const card = this.card(cardId);
    if (card.kind === 'project') throw new BadRequest('project', 'a project is worked on through its workstreams');
    if (card.state !== 'planned') throw new BadRequest('notPlanned', 'only a planned card can be started');
    // once work has begun the branch stays the card's, whatever the title says now
    const row = this.o.board.row(card.id);
    // a workstream planned again after a part landed: the branch of that part may still be in a clone
    const shipped = row.shipped ? (JSON.parse(row.shipped) as Shipped) : null;
    const branch = row.branch ?? `${branchName(card.title, card.id)}${shipped ? `-${shipped.commit?.slice(0, 7) ?? 'rest'}` : ''}`;
    const path = asBadRequest(() => this.o.workspaces.lease(card.id, branch));
    this.bump(card.id);
    // the run before is not resumed, but the Arbeitsrückschau still reads it
    if (row.session_id) this.o.board.log(card.id, 'state', 'obeya', this.o.board.t.worker.restarted(this.o.board.t.worker.earlierRun(row.session_id)));
    // a fresh session knows of no app that was stopped
    this.o.board.work(card.id, { state: 'working', need: null, detail: null, status_line: null, workspace: path, branch, session_id: null, pr: null, approved_at: null, parked: null, paused: null, snoozed: null, app: null });
    this.o.board.log(card.id, 'state', 'obeya', this.folder ? this.o.board.t.worker.startedInFolder : this.o.board.t.worker.started(branch));
    this.launch(card.id, this.briefing(card, branch, !!row.branch), undefined, this.taskImages(card));
  }

  /**
   * A hint while the worker runs, words on its handover, or a question once its work is done;
   * `images` are screenshot files the owner attached; `replyTo`: the message of the card's
   * conversation the words reply to, which the worker reads above them; `spot`: the place in the
   * demo video they are about. Such words on a handover are held back while the owner watches (`hold`).
   */
  message(cardId: string, text: string, images: string[] = [], spoken = false, replyTo?: number, spot?: SpotInput) {
    const card = this.card(cardId);
    const place = spot ? this.place(cardId, spot) : undefined;
    const handover = handedOver(card);
    if (place && handover) return this.hold(card, text, images, spoken, replyTo, place);
    const words = this.words(cardId, text, images, replyTo, place);
    // the log shows the owner's screenshots, not the stills that join them below
    const shots = images;
    // words that reach the worker in the middle of a turn wait for its next step, unread until then
    const log = (later = false) => [this.o.board.log(cardId, 'hint', 'owner', text, { images: shots, replyTo, spot: place, unread: later && this.takesLater(cardId) }).id];
    // the worker sees the frame the words are about
    images = [...this.stills(place), ...images];
    if (handover) {
      // under a demo whose report asks a question, the words answer it, whatever else they say
      if (card.question) return this.answerDemo(card, text, images, spoken, replyTo, []);
      // the work still waits for approval while the worker takes the words in; a change they call for comes as a new handover
      this.takingIn(cardId);
      // words without a place end the watching: the comments held back come first, and go with them
      const held = this.takeHeld(cardId);
      const said = log(!held);
      if (text) this.o.onOwnerInput?.(card, 'feedback', text);
      this.deliver(
        cardId,
        `The owner wrote on your handover${spoken ? ` (${SPOKEN})` : ''}. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held ? `${held.text}\n\nThen they wrote:\n\n` : ''}${words}`,
        [...(held?.images ?? []), ...images],
        true,
        held ? [] : said,
      );
    } else if (card.state === 'waiting' && card.need === 'question') {
      // a note instead of an answer takes the question back: it may have settled it, else the worker asks anew
      const waiting = this.live.get(cardId)?.permission;
      this.backToWork(cardId);
      if (waiting) {
        // the tool call waits for the owner, so the worker reads nothing else meanwhile: the note refuses it
        log();
        if (text) this.o.onOwnerInput?.(card, 'note', text);
        waiting({ allow: false, message: `Not run: the owner wrote a note instead of allowing it${spoken ? ` (${SPOKEN})` : ''}. If the note settles it, go on; if not, ask again.\n\n${words}` });
        if (images.length) this.live.get(cardId)!.session.send('The screenshots of the owner’s note.', images);
        return;
      }
      const said = log(true);
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.deliver(
        cardId,
        `A note from the owner instead of an answer${spoken ? ` (${SPOKEN})` : ''}. It withdraws your question („${card.question?.text ?? ''}“): if the note settles it, go on; if not, ask again.\n\n${words}`,
        images,
        true,
        said,
      );
    } else if (inQueue(card)) {
      // the card waits to start: the words go with the task to the worker that takes it on
      const said = [this.o.board.log(cardId, 'hint', 'owner', text, { images: shots, replyTo, spot: place, unread: true }).id];
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.o.board.work(cardId, { unheard: JSON.stringify([...this.unheard(cardId), { said, text: `A note from the owner while your card waited to start${spoken ? ` (${SPOKEN})` : ''}:\n\n${words}`, images }] satisfies Unheard[]) });
    } else if (this.waitsForClone(cardId)) {
      // no session to take them in now: they go with the message that resumes it in the clone
      const said = [this.o.board.log(cardId, 'hint', 'owner', text, { images: shots, replyTo, spot: place, unread: true }).id];
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      this.o.board.work(cardId, { unheard: JSON.stringify([...this.unheard(cardId), { said, text: `A note from the owner while you waited for the clone${spoken ? ` (${SPOKEN})` : ''}:\n\n${words}`, images }] satisfies Unheard[]) });
    } else if (card.state === 'working' || card.state === 'inPr' || card.finishing) {
      const said = log(true);
      if (text) this.o.onOwnerInput?.(card, 'note', text);
      // a note to a paused worker lets it go on, with the note
      const how = card.paused ? 'with which they let you go on' : 'it does not stop you; adjust your plan if it changes anything';
      this.deliver(cardId, `A note from the owner${spoken ? ` (${SPOKEN})` : ''} (${how}):\n\n${words}`, images, true, said);
    } else if (askable(card)) this.followUp(card, text, images, spoken, replyTo, place);
    else throw new BadRequest('noAgent', 'no agent works on this card');
  }

  /**
   * The owner asks about a card whose work is over: its worker's session is resumed in a fresh
   * workspace on the card's branch, as after a landing, and ends again once the worker has answered.
   */
  private followUp(card: Item, text: string, images: string[], spoken: boolean, replyTo?: number, place?: Spot) {
    const row = this.o.board.row(card.id);
    let path: string;
    let worktree = false;
    try {
      // the owner's question does not wait for a slot
      path = this.o.workspaces.lease(card.id, row.branch!, { overSlots: true });
    } catch (e) {
      if (!(e instanceof WorkspaceError)) throw e;
      if (!shortageOf(e.code)) throw new BadRequest(e.code, e.message);
      // nor for a clone: a worktree takes none
      path = asBadRequest(() => this.o.workspaces.followUpTree(card.id, row.branch!));
      worktree = true;
    }
    this.bump(card.id);
    const commit = row.shipped ? (JSON.parse(row.shipped) as Shipped).commit : undefined;
    const landed: LandedState = { ...(card.state === 'done' ? { unchanged: true } : commit ? { commit } : {}), followUp: true, ...(worktree ? { worktree } : {}) };
    this.o.board.work(card.id, { workspace: path, landed: JSON.stringify(landed), status_line: null, app: null });
    const stills = this.stills(place);
    this.o.board.log(card.id, 'hint', 'owner', text, { images: images.slice(stills.length), replyTo, spot: place });
    if (text) this.o.onOwnerInput?.(card, 'note', text);
    const message = [
      this.folder
        ? `The owner asks about this card${spoken ? ` (${SPOKEN})` : ''}. It is done, and your session had ended; it goes on in the folder ${path}, which other cards and the owner may have changed since.`
        : `The owner asks about this card${spoken ? ` (${SPOKEN})` : ''}. ${card.state === 'done' ? 'It was closed without a change to the repository' : `Its work is on main${commit ? ` (${commit.slice(0, 7)})` : ''}`}, and your session had ended; it goes on in a fresh workspace ${worktree ? 'at the head of' : 'on'} the branch ${row.branch}, where main may have moved on since.`,
      this.words(card.id, text, images.slice(stills.length), replyTo, place),
      this.folder ? FOLLOW_UP_FOLDER : FOLLOW_UP,
      ...(worktree ? [IN_WORKTREE] : []),
    ].join('\n\n');
    // a card that never reported a session: a new one needs the card first
    if (row.session_id) this.launch(card.id, message, row.session_id, images);
    else this.launch(card.id, `You worked on the card „${card.title}“:\n\n${card.body}\n\n${message}`, undefined, [...this.taskImages(card), ...images]);
  }

  /** Whether the card's follow-up waits for a full clone, its worker without a workspace. */
  private waitsForClone(cardId: string): boolean {
    const row = this.o.board.row(cardId);
    return !row.workspace && !!landedOf(row)?.needsClone;
  }

  /**
   * The follow-up's worker asked for a full clone (`need_clone`) and ended its turn: its session and
   * temporary worktree end, and the card waits for the next free clone, which resumes the session.
   */
  private awaitClone(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    const row = this.o.board.row(cardId);
    const { worktree: _, ...landed } = landedOf(row)!;
    this.removeTree(row.workspace);
    this.o.board.work(cardId, { workspace: null, landed: JSON.stringify(landed), status_line: this.o.board.t.worker.waitsForWorkspace });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.waitsForClone);
    this.takeClone(cardId);
  }

  /**
   * A follow-up waiting for a full clone takes the next clean free one, on any machine whatever its
   * slots, and its worker goes on there. Returns whether it did; the Koordinator asks again as the board changes.
   */
  takeClone(cardId: string): boolean {
    if (!this.waitsForClone(cardId)) return false;
    const row = this.o.board.row(cardId);
    let path: string;
    try {
      path = this.o.workspaces.lease(cardId, row.branch!, { overSlots: true });
    } catch (e) {
      if (!(e instanceof WorkspaceError && shortageOf(e.code))) console.error(`a clone for the follow-up on ${cardId}:`, e);
      return false;
    }
    const { needsClone: _, ...landed } = landedOf(row)!;
    this.bump(cardId);
    this.o.board.work(cardId, { workspace: path, landed: JSON.stringify(landed), status_line: null, app: null });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.cloneFree);
    this.deliver(cardId, `A clone is free now: you go on in it, a full clone on the branch ${row.branch}. Answer the owner's question there.\n\n${FOLLOW_UP}`);
    return true;
  }

  /** Whether the card's follow-up runs in a temporary worktree. */
  private inWorktree(cardId: string): boolean {
    return !!landedOf(this.o.board.row(cardId))?.worktree;
  }

  /** Removes a follow-up's temporary worktree; one left behind does no harm. */
  private removeTree(path: string | null) {
    if (!path) return;
    try {
      this.o.workspaces.removeFollowUpTree(path);
    } catch (e) {
      console.error(`removing the follow-up worktree ${path}:`, e);
    }
  }

  /**
   * The owner answered the card's question: `words` are their own, `picks` the options they picked
   * (those not among the question's are dropped). The log holds both as one text, picks first
   * (`pickedAnswer`); the worker reads which is which.
   */
  answer(cardId: string, words: string, images: string[] = [], spoken = false, replyTo?: number, picks: string[] = []) {
    const card = this.card(cardId);
    const options = card.question?.options ?? [];
    const picked = options.filter((o) => picks.includes(o));
    const text = pickedAnswer(picked, words);
    if (card.state === 'waiting' && card.need === 'demo' && card.question) return this.answerDemo(card, text, images, spoken, replyTo, picked);
    if (!(card.state === 'waiting' && card.need === 'question')) throw new BadRequest('noQuestion', 'the card has no open question');
    const row = this.o.board.row(cardId);
    const detail = row.detail ? (JSON.parse(row.detail) as { question?: Question; permission?: AskedPermission }) : {};
    if (detail.permission) return this.answerPermission(card, detail.permission, text, images, spoken, replyTo);
    const question = detail.question;
    const q = question?.text ?? this.pendingQuestion(cardId) ?? '';
    this.backToWork(cardId);
    this.recordAnswer(card, q, text, images, replyTo, picked);
    this.deliver(cardId, `Answer to your question (from the owner${spoken ? `; ${SPOKEN}` : ''}):\n\n${this.words(cardId, answerNote(picked, text), images, replyTo)}`, images, true);
  }

  /**
   * The owner answered whether a tool call may run: the call waiting for it runs or is refused, with
   * their words. Allowed after the session that asked was gone (a restart), it runs once the worker
   * makes it again. No decision for the log: it is about one call, not the work.
   */
  private answerPermission(card: Item, asked: AskedPermission, text: string, images: string[], spoken: boolean, replyTo?: number) {
    const [first = '', ...rest] = text.split('\n\n');
    const is = (option: (t: Messages) => string) => LANGUAGES.some((l) => option(MESSAGES[l]).toLowerCase() === first.trim().toLowerCase());
    const allowed = is((t) => t.worker.allow);
    const words = (allowed || is((t) => t.worker.deny) ? rest.join('\n\n') : text).trim();
    this.backToWork(card.id);
    this.o.board.log(card.id, 'answer', 'owner', text, { images, replyTo });
    if (words) this.o.onOwnerInput?.(card, 'answer', words, { question: card.question?.text ?? '' });
    const said = words ? `${spoken ? ` (${SPOKEN})` : ''}:\n\n${this.words(card.id, words, images, replyTo)}` : images.length ? `, with screenshots:${imageNote(images)}` : '.';
    const live = this.live.get(card.id);
    if (live?.permission) {
      live.permission(allowed ? { allow: true } : { allow: false, message: `Not run: the owner did not allow it${said}` });
      // the call's result can carry no words, the next message can
      if (allowed && (words || images.length)) live.session.send(`The owner allowed it${said}`, images);
      else if (images.length) live.session.send('The screenshots of the owner’s answer.', images);
      return;
    }
    // the session that asked is gone: the worker hears the answer when it goes on, and the call runs once it makes it again
    if (allowed) this.granted.set(card.id, (this.granted.get(card.id) ?? new Set()).add(permissionKey(asked)));
    const call = describeTool(asked.name, asked.input, this.o.board.t);
    this.deliver(
      card.id,
      allowed
        ? `Before Obeya restarted, a tool call of yours (${call}) waited for the owner's permission. The owner allowed it${said}\n\nMake the call again if you still need it; it runs without asking again.`
        : `Before Obeya restarted, a tool call of yours (${call}) waited for the owner's permission. The owner did not allow it${said}`,
      images,
      true,
    );
  }

  /**
   * The question in a demo report, answered: the worker hears it, and the demo still waits for
   * approval. While the worker takes in the answer (it may rework the demo), the card is not the
   * owner's; once its turn ends without a new handover, the demo is theirs again.
   */
  private answerDemo(card: Item, text: string, images: string[], spoken: boolean, replyTo: number | undefined, picks: string[]) {
    const q = card.question!.text;
    const held = this.takeHeld(card.id);
    const demo = JSON.parse(this.o.board.row(card.id).demo!) as Record<string, unknown>;
    this.o.board.work(card.id, { demo: JSON.stringify({ ...demo, answer: text || '(Screenshot)' }) });
    this.takingIn(card.id);
    this.recordAnswer(card, q, text, images, replyTo, picks);
    this.deliver(
      card.id,
      `The owner answered the question in your demo report („${q}“)${spoken ? ` (${SPOKEN})` : ''}. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held ? `${held.text}\n\nThen they answered:\n\n` : ''}${this.words(card.id, answerNote(picks, text), images, replyTo)}`,
      [...(held?.images ?? []), ...images],
      true,
    );
  }

  /**
   * The owner's words as the worker reads them: the place in the demo video and the message they
   * reply to above them, the frame's and the screenshots' files below.
   */
  private words(cardId: string, text: string, images: string[], replyTo?: number, place?: Spot) {
    const still = this.stills(place);
    return `${place ? `${spotNote(place)}\n` : ''}${replyNote(replyTo ? this.o.board.quoted(cardId, replyTo) : undefined, 'worker')}${text}${still.length ? `\n\nThe frame at that place in the video is shown below (file: ${still[0]}).` : ''}${imageNote(images)}`;
  }

  /**
   * A place in the card's demo video, with the chapter there and what the narration says: in the
   * card's demo, or in an earlier one the owner went back to (`spot.demo`).
   */
  private place(cardId: string, spot: SpotInput): Spot {
    const at = Math.max(0, Math.round(spot.at * 10) / 10);
    const row = this.o.board.row(cardId);
    const current = row.demo ? (JSON.parse(row.demo) as StoredDemo) : undefined;
    const earlier = spot.demo !== undefined && spot.demo !== current?.handover ? (JSON.parse(row.demos ?? '[]') as StoredDemo[]).findLast((d) => d.handover === spot.demo) : undefined;
    const d = earlier ?? current;
    return {
      at,
      ...(d && d.kind !== 'html' ? placeIn(d.dir, d.chapters, at) : {}),
      ...(spot.still ? { still: spot.still } : {}),
      ...(d?.handover !== undefined ? { demo: d.handover } : {}),
      ...(earlier ? { earlier: true as const } : {}),
    };
  }

  /**
   * The card's earlier demos with the one a new handover replaces added, as `CardRow.demos` keeps
   * them. A demo from before handovers named theirs gets the last one before now: its time, and the
   * places in it the owner's comments are about.
   */
  private earlier(cardId: string, row: CardRow): string {
    const replaced = JSON.parse(row.demo!) as StoredDemo;
    const e = replaced.handover === undefined ? this.o.board.events(cardId).findLast((e) => e.kind === 'review') : undefined;
    return JSON.stringify([...(JSON.parse(row.demos ?? '[]') as StoredDemo[]), { ...replaced, ...(e ? { handover: e.id, at: e.at } : {}) }]);
  }

  /** The file of the frame at a place in the video, if it has one. */
  private stills(place: Spot | undefined): string[] {
    return place?.still ? (this.o.imageFiles?.([place.still]) ?? []) : [];
  }

  /**
   * Words on a place in the demo video, while the card waits for the owner's approval: they stand in
   * the conversation at once, but reach the worker together once the owner has finished watching
   * (`release`, words without a place, an approval), so that it reworks the demo once rather than
   * for each comment. Ten minutes after the last one without a sign, they go anyway.
   */
  private hold(card: Item, text: string, images: string[], spoken: boolean, replyTo: number | undefined, place: Spot) {
    // unread until they go: they stand below whatever the worker does meanwhile, and where they went once sent
    const e = this.o.board.log(card.id, 'hint', 'owner', text, { images, replyTo, spot: place, unread: true });
    if (text) this.o.onOwnerInput?.(card, 'feedback', text);
    this.o.board.work(card.id, { held: JSON.stringify([...this.held(card.id), { id: e.id, ...(spoken ? { spoken: true } : {}) }]) });
    this.releaseLater(card.id, this.o.holdGrace ?? HOLD_GRACE);
  }

  private held(cardId: string): HeldComment[] {
    const held = this.o.board.row(cardId).held;
    return held ? (JSON.parse(held) as HeldComment[]) : [];
  }

  private releaseLater(cardId: string, ms: number) {
    clearTimeout(this.holding.get(cardId));
    this.holding.set(
      cardId,
      setTimeout(() => {
        this.holding.delete(cardId);
        // no request to answer with the error: it goes into the card's log
        try {
          this.release(cardId);
        } catch (e) {
          if (this.o.board.item(cardId)) this.o.board.log(cardId, 'error', 'obeya', messageOf(e));
        }
      }, ms),
    );
  }

  /**
   * The owner has finished watching the demo video (it ended, the card closed, it stood still for a
   * while): the comments held back go to the worker, after a moment in which an approval clicked
   * with the closing takes them instead.
   */
  released(cardId: string, now = false) {
    this.card(cardId);
    if (!this.held(cardId).length) return;
    // sent by the owner ("Jetzt senden"): no approval is on its way to take them instead
    if (now) this.release(cardId);
    else this.releaseLater(cardId, this.o.releaseDelay ?? RELEASE_DELAY);
  }

  /**
   * The owner takes back words the worker has not taken in: a comment on a place in the demo video
   * that is still held back, or words Obeya holds until its next step. They leave the conversation,
   * and the worker never hears them.
   */
  unsay(cardId: string, id: number) {
    this.card(cardId);
    const unheard = this.unheard(cardId);
    const words = unheard.find((u) => u.said.includes(id));
    if (words && this.o.board.unread(cardId, id)) {
      const rest = unheard.filter((u) => u !== words);
      this.o.board.work(cardId, { unheard: rest.length ? JSON.stringify(rest) : null });
      for (const said of words.said) this.o.board.withdraw(cardId, said);
      return;
    }
    const held = this.held(cardId);
    if (!held.some((h) => h.id === id)) throw new BadRequest('notHeld', 'the comment is not held back: the worker has it already');
    const rest = held.filter((h) => h.id !== id);
    this.o.board.work(cardId, { held: rest.length ? JSON.stringify(rest) : null });
    if (!rest.length) {
      clearTimeout(this.holding.get(cardId));
      this.holding.delete(cardId);
    }
    this.o.board.unlog(cardId, id);
  }

  /** The comments held back go to the worker as one message, the card still waiting for approval. */
  private release(cardId: string) {
    const card = this.o.board.item(cardId);
    if (!card || !handedOver(card)) return void this.takeHeld(cardId);
    const held = this.takeHeld(cardId);
    if (!held) return;
    this.takingIn(cardId);
    this.deliver(
      cardId,
      `The owner watched your demo video and commented on places in it. The card still waits for their approval of what you handed over; a change their words call for goes into a new handover:\n\n${held.text}`,
      held.images,
      true,
    );
  }

  /** The comments held back as the worker reads them, each with its place, and their frames and screenshots; none are held afterwards. */
  private takeHeld(cardId: string): { text: string; images: string[] } | null {
    clearTimeout(this.holding.get(cardId));
    this.holding.delete(cardId);
    const held = this.held(cardId);
    if (!held.length) return null;
    // read where they go, before they stop being held: never shown meanwhile as words waiting for a step
    this.o.board.readNow(cardId, held.map((h) => h.id));
    this.o.board.work(cardId, { held: null });
    const events = new Map(this.o.board.events(cardId).map((e) => [e.id, e]));
    const images: string[] = [];
    const comments = held.flatMap(({ id, spoken }) => {
      const e = events.get(id);
      if (!e) return [];
      const still = this.stills(e.spot);
      const shots = this.o.imageFiles?.(e.images) ?? [];
      images.push(...still, ...shots);
      const files = [...still.map((f) => `frame: ${f}`), ...shots.map((f) => `screenshot: ${f}`)];
      return [
        `${e.spot ? spotNote(e.spot) : ''}${spoken ? ` (${SPOKEN})` : ''}\n${replyNote(e.replyTo ? this.o.board.quoted(cardId, e.replyTo) : undefined, 'worker')}${e.text}${files.length ? `\n(${files.join('; ')})` : ''}`,
      ];
    });
    if (!comments.length) return null;
    const many = comments.length > 1;
    return {
      text: `${many ? `${comments.length} comments` : 'A comment'} on places in your demo video${images.length ? ` (${many ? 'their frames and screenshots are' : 'its frame is'} shown below, in this order)` : ''}:\n\n${comments.join('\n\n')}`,
      images,
    };
  }

  /** `direct`: the work goes onto the default branch at once instead of into a pull request, where the repository's settings allow it. */
  async approve(cardId: string, { direct = false }: { direct?: boolean } = {}) {
    const card = this.card(cardId);
    if (!handedOver(card) || this.landing.has(cardId)) throw new BadRequest('notReady', 'the card is not ready for review');
    const lands = this.landingOf(cardId);
    // where work lands on main anyway, approving it directly is approving it
    if (direct && lands.land === 'pr' && !lands.direct)
      throw new BadRequest('noDirect', 'this repository lands approved work only through a pull request; its settings do not allow pushing it directly');
    if (direct && card.prototypeOf) throw new BadRequest('noDirect', 'a prototype never lands');
    // comments on places in the demo video the owner made before approving go with the approval
    const held = this.takeHeld(cardId);
    const comments = held
      ? { text: `Before approving, the owner watched your demo video. ${held.text}\n\nThey approved the work as it is all the same: what still matters of these comments, propose as a card of its own (propose_card).`, images: held.images }
      : undefined;
    // a prototype never lands: approving it is having seen enough
    if (card.prototypeOf) return this.endPrototype(cardId, 'discarded');
    // work that changed nothing (a demo, an analysis) has nothing to land and no pull request to open;
    // in a folder without git, what it changed is in the folder already
    if (this.folder || !this.o.workspaces.hasWork(cardId)) return this.close(cardId, 'owner', comments);
    if (lands.land === 'main' || direct) {
      // the click ends the owner's turn: while the work lands, the card no longer needs them
      this.o.board.work(cardId, { approved_at: new Date().toISOString() });
      return this.land(cardId, 'owner', comments);
    }
    // the worker opens the PR the way the repository does it, then Obeya watches it
    const pr: PrState = { url: null, seen: [], reported: [] };
    // the line the worker reported before handing over is about work that is done
    this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, status_line: null, pr: JSON.stringify(pr) });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.approvedPr);
    // a page that goes out now gets the pull request's link from Obeya once both are there
    this.o.onApproval?.(cardId);
    // a demo shared later gets its line from Obeya once the pull request is open
    const shared = card.share?.url;
    this.deliver(
      cardId,
      [
        'The owner approved your work. In this repository it goes out as a pull request, opened the way the repository does it (its own skills and conventions): from now on you may push this branch. Whoever reads the pull request has not seen Obeya, the card or the plan doc. Do not merge it: Obeya merges it once its checks have passed and its review is through.',
        shared ? `Your demo video is shared with the team on a page of its own: ${shared}. Link it in the pull request's description.` : '',
        'Once you report its URL with pr_opened, Obeya watches it and passes you review comments, failed checks and conflicts; you handle them the way the repository does (its skill for review comments, if it has one). A comment that questions a decision, or a conflict that needs a product call, is the owner’s (ask).',
        comments?.text ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      true,
    );
  }

  /**
   * „Änderungen verwerfen“ in a folder without git, on a card waiting for approval: what its worker
   * changed there is put back as it was (`FolderWorkspaces.undo`), but what someone changed since
   * and what no copy was kept of. The card goes on waiting for the owner, its log says what was put
   * back and what not, and its worker hears it with its next message.
   */
  async undo(cardId: string): Promise<UndoReport> {
    const card = this.card(cardId);
    if (!this.folder) throw new BadRequest('notFolder', 'only the changes of a card in a folder without git are undone');
    if (!handedOver(card) || this.landing.has(cardId)) throw new BadRequest('notReady', 'only a card waiting for approval has its changes discarded');
    const report = await this.folder.undo(cardId);
    const t = this.o.board.t.worker;
    const files = (list: string[]) => list.join(', ');
    this.o.board.log(
      cardId,
      'state',
      'owner',
      [t.undone(report.undone.filter((p) => !p.endsWith('/')).length), report.changedSince.length ? t.undoChangedSince(files(report.changedSince)) : '', report.lost.length ? t.undoLost(files(report.lost)) : '', report.shared.length ? t.undoShared(files(report.shared)) : ''].filter(Boolean).join(' '),
    );
    const row = this.o.board.row(cardId);
    const detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
    const told = [
      `The owner discarded your changes in the folder: Obeya put back what your card changed (${report.undone.join(', ') || 'nothing'}) as it was before.`,
      report.changedSince.length ? `Left as they are, since someone changed them after you: ${files(report.changedSince)}.` : '',
      report.lost.length ? `Left as they are, since no copy from before your change was kept: ${files(report.lost)}.` : '',
      report.shared.length ? `Left as they are, since another card's agent was at work when they changed: ${files(report.shared)}.` : '',
      'The card still waits for the owner.',
    ];
    this.o.board.work(cardId, {
      detail: JSON.stringify({ ...detail, noChange: !this.o.workspaces.hasWork(cardId) || undefined }),
      unheard: JSON.stringify([...this.unheard(cardId), { said: [], text: told.filter(Boolean).join(' '), images: [] }] satisfies Unheard[]),
    });
    return report;
  }

  /**
   * How the card's work lands: as the repository's settings say, except where its own branch
   * changes that in `.obeya/settings.json` (the card that sets up the settings, say) and the
   * settings of this machine do not say otherwise. Then as the branch says: the owner approves the
   * change with the work, and has answered how work lands in the card that makes it. `own` holds
   * what the branch decides.
   */
  landingOf(cardId: string): { land: 'main' | 'pr'; direct: boolean; own?: CardLanding } {
    const repo = { land: this.o.adapter.land, direct: !!this.o.adapter.direct };
    const fork = this.o.workspaces.forkPoint(cardId);
    if (!fork) return repo;
    const [now, before] = gitStepsSync(fork.ws, together(readingShared('HEAD'), readingShared(fork.base)));
    const machine = this.o.machineSettings?.();
    const own: CardLanding = {};
    for (const field of ['land', 'direct'] as const) {
      const v = now.settings?.[field];
      if (v !== undefined && v !== before.settings?.[field] && machine?.[field] === undefined) Object.assign(own, { [field]: v });
    }
    if (own.land === undefined && own.direct === undefined) return repo;
    return { land: own.land ?? repo.land, direct: own.direct ?? repo.direct, own };
  }

  /**
   * Lands approved work on main: on the Obeya checkout, or, where work otherwise goes out as a pull
   * request, pushed directly onto `origin`'s default branch. What the worker can fix (main moved on
   * and the change conflicts, uncommitted work) goes back to it with the approval kept: its next
   * handover lands without the owner approving again, the same way. What blocks the Obeya checkout,
   * or a push turned away, stays with the owner and needs a new approval.
   */
  private async land(cardId: string, by: 'owner' | 'obeya', comments?: Comments) {
    if (this.landing.has(cardId)) return;
    this.landing.add(cardId);
    try {
      await this.landNow(cardId, by, comments);
    } catch (e) {
      // a landing that broke off gives the card back to the owner, who approves again
      if (this.o.board.row(cardId).state === 'waiting') this.o.board.work(cardId, { approved_at: null });
      throw e;
    } finally {
      this.landing.delete(cardId);
    }
  }

  private async landNow(cardId: string, by: 'owner' | 'obeya', comments?: Comments) {
    const row = this.o.board.row(cardId);
    // only a direct approval is held where work goes out as a pull request
    const direct = this.landingOf(cardId).land === 'pr';
    // read before landing: the landed branch adds nothing against main
    const added = this.planDocsAdded(cardId);
    // the demo goes out with the approval, also where it holds for the worker's next handover
    const trailer = this.o.onApproval?.(cardId) ?? undefined;
    const result = await (direct ? this.o.workspaces.pushToMain(cardId, trailer) : this.o.workspaces.landOnMain(cardId, row.branch!, trailer));
    if ('code' in result && !result.worker) {
      this.o.board.work(cardId, { approved_at: null });
      throw new BadRequest(result.code, result.detail);
    }
    if ('code' in result) {
      this.o.board.work(cardId, { state: 'working', need: null, detail: null, approved_at: row.approved_at ?? new Date().toISOString() });
      this.o.board.log(cardId, 'error', 'obeya', result.detail, { code: result.code });
      this.deliver(
        cardId,
        [
          `The owner approved your work, but it could not land on main: ${result.detail}`,
          'The approval holds for what it takes to land the work: once you hand over again, Obeya lands it without asking the owner again, with the demo already on the card. A change to what the owner approved is theirs to decide.',
          ...(comments ? [comments.text] : []),
        ].join('\n\n'),
        comments?.images,
        by === 'owner',
      );
      return;
    }
    this.o.board.planDocsLanded(cardId, added);
    this.bump(cardId);
    const restartFor = this.o.restartsFor?.(result, direct ? (row.workspace ?? undefined) : undefined) ?? false;
    const restarts = !!restartFor;
    this.o.board.work(cardId, {
      state: 'live',
      need: null,
      detail: null,
      status_line: null,
      approved_at: null,
      landed: JSON.stringify({ commit: result.to, ...(restarts ? { restarts } : {}) } satisfies LandedState),
      shipped: JSON.stringify({ commit: result.to, base: result.from } satisfies Shipped),
    });
    const t = this.o.board.t.worker;
    if (direct) this.o.board.log(cardId, 'state', by, by === 'owner' ? t.approvedDirect : t.landedDirect);
    else this.o.board.log(cardId, 'state', by, by === 'owner' ? t.approvedMain : t.landedMain);
    if (direct) this.o.onMerged?.(cardId);
    this.afterLanding(
      cardId,
      [
        direct
          ? `${by === 'owner' ? 'The owner approved your work to go directly onto main, and Obeya' : 'Obeya'} pushed it there without a pull request (${result.to.slice(0, 7)}); the card is live.`
          : `${by === 'owner' ? 'The owner approved your work, and it' : 'Your work'} is on main now (${result.to.slice(0, 7)}); the card is live.`,
        restartFor === 'obeya'
          ? `Obeya runs from that checkout and starts again with your change as soon as no worker is in the middle of a turn, which stops whatever you run then. ${AFTER_RESTART}`
          : restartFor === 'repo'
            ? `Your change moves where this repository's agents work: Obeya restarts them with it as soon as none of them is in the middle of a turn, you among them, which stops whatever you run then. ${AFTER_RESTART}`
            : '',
        comments?.text ?? '',
        AFTER_LANDING,
      ]
        .filter(Boolean)
        .join('\n\n'),
      comments?.images,
      by === 'owner',
    );
  }

  /**
   * Approved work that changed nothing in the repository: nothing lands, and the card is `done`.
   * Its worker hears so and may finish what remains, as after a landing.
   */
  private close(cardId: string, by: 'owner' | 'worker', comments?: Comments) {
    // a demo, an analysis: what the approval was for goes public as any approved demo
    if (by === 'owner') this.o.onApproval?.(cardId);
    this.bump(cardId);
    this.o.board.work(cardId, { state: 'done', need: null, detail: null, status_line: null, approved_at: null, pr: null, landed: JSON.stringify({ unchanged: true } satisfies LandedState) });
    const t = this.o.board.t.worker;
    const folder = !!this.folder && this.o.workspaces.hasWork(cardId);
    // what it changed in the folder stays: nothing of it is undone any more
    this.folder?.done(cardId);
    this.o.board.log(cardId, 'state', by, by === 'owner' ? (folder ? t.approvedFolder : t.approvedUnchanged) : t.doneUnchanged);
    // the worker that closed it is told by the tool's result, and its turn's end finishes it
    if (by === 'owner')
      this.afterLanding(
        cardId,
        `${folder ? 'The owner approved your work. Your changes stay in the folder as they are, and the card is done: they can no longer be undone from the card.' : 'The owner approved your work. It changed nothing in the repository, so nothing lands and there is no pull request: the card is done.'}${comments ? `\n\n${comments.text}` : ''}\n\n${this.folder ? AFTER_DONE : AFTER_LANDING}`,
        comments?.images,
        true,
      );
  }

  /**
   * Landed work's worker hears about it and may finish what remains (a migration, say) in its
   * workspace, which stays until then. Without a session to tell, the workspace goes at once.
   */
  private afterLanding(cardId: string, message: string, images: string[] = [], owner = false) {
    const row = this.o.board.row(cardId);
    if (!row.workspace || (!this.live.has(cardId) && !row.session_id)) return this.finish(cardId);
    this.deliver(cardId, message, images, owner);
  }

  /** Landed work's worker is done: its session ends and its workspace is freed. */
  private finish(cardId: string) {
    this.end(cardId);
    this.bump(cardId);
    const row = this.o.board.row(cardId);
    if (this.inWorktree(cardId)) this.removeTree(row.workspace);
    else
      try {
        this.o.workspaces.removeLanded(cardId, row.branch ?? '');
      } catch (e) {
        // the card is done either way; a leftover worktree does no harm
        console.error('freeing a landed workspace:', e);
      }
    const landed = landedOf(row);
    this.o.board.work(cardId, { landed: null, workspace: null, status_line: null, parked: null, paused: null, snoozed: null, app: null, ...(row.state === 'waiting' ? { state: landed?.unchanged ? 'done' : 'live', need: null, detail: null } : {}) });
    this.o.board.workDone(cardId);
    // the Arbeitsrückschau read the card's runs when its work ended
    if (!landed?.followUp) this.o.onWorkEnded?.(cardId, row.workspace);
  }

  /** The plan docs the card's branch adds, as plan references of the canvas. */
  private planDocsAdded(cardId: string): string[] {
    // a plan folder outside the repository has nothing in the branch: such a card named its doc when it started
    if (!this.o.board.row(cardId).idea || outsidePlanDir(this.o.adapter.planDocs.dir)) return [];
    const home = !this.o.repo || this.o.repo === this.o.board.home;
    return this.o.workspaces
      .addedFiles(cardId, this.o.adapter.planDocs.dir)
      .filter((f) => f.endsWith('.md') && !this.o.adapter.planDocs.exclude.some((x) => f.endsWith(`/${x}`)))
      .map((f) => (home ? f : `${this.o.repo}:${f}`));
  }

  /**
   * A prototype has served its purpose, whatever its state: its worker stops and the card goes into
   * the archive with its log, demo and summary. Discarded, its workspace and branch are thrown away;
   * built, they went to its idea, or the workstream `into`, before (`buildOn`).
   */
  endPrototype(cardId: string, end: 'discarded' | 'built', by: 'owner' | 'obeya' = 'owner', into?: string) {
    const card = this.card(cardId);
    if (!card.prototypeOf) throw new BadRequest('notPrototype', 'not a prototype');
    this.o.onWorkEnded?.(cardId, this.o.board.row(cardId).workspace);
    this.end(cardId);
    this.bump(cardId);
    this.o.board.work(cardId, { paused: null, snoozed: null });
    try {
      this.o.workspaces.discard(cardId, this.o.board.row(cardId).branch ?? '');
    } catch (e) {
      // the card goes anyway; a leftover worktree does no harm
      console.error('discarding a prototype:', e);
    }
    const idea = this.o.board.card(card.prototypeOf);
    const t = this.o.board.t.worker;
    this.o.board.log(cardId, 'state', by, end === 'discarded' ? t.prototypeDiscarded : into ? t.prototypeBuiltInto(into) : t.prototypeBuilt(idea?.title ?? ''));
    this.o.board.endPrototype(cardId, end, into);
    if (end === 'discarded' && this.o.board.item(card.prototypeOf)) this.o.board.log(card.prototypeOf, 'state', by, t.prototypeDiscardedOnIdea(card.title));
  }

  /**
   * The idea, or the workstream `into` names of the project it became, is built on this prototype:
   * its workspace and branch (renamed for that card) go to the card, and the prototype ends as
   * built. Returns the workspace and branch the card has now.
   */
  buildOn(prototypeId: string, idea: Item, into?: string): { path: string; branch: string } {
    const { workspace, branch } = this.o.board.row(prototypeId);
    if (!workspace || !branch) throw new BadRequest('noWorkspace', 'the prototype has no workspace to build on');
    const moved = asBadRequest(() => this.o.workspaces.transfer(prototypeId, idea.id, branch, branchName(idea.title, idea.id)));
    this.endPrototype(prototypeId, 'built', 'owner', into);
    return moved;
  }

  /**
   * What the card's work changes: once it landed, what the landing put on the default branch;
   * before, its branch in its workspace so far. Null when neither is there to read.
   */
  diff(cardId: string, full: boolean): Promise<CardDiff | null> {
    const row = this.o.board.row(cardId);
    const shipped = row.shipped ? (JSON.parse(row.shipped) as Shipped) : null;
    // landed work's workspace, while its worker finishes, has nothing left against the default branch
    if (row.state === 'live' && shipped?.commit && shipped.base) return this.o.workspaces.landedDiff(shipped.base, shipped.commit, full);
    return this.o.workspaces.diff(cardId, full);
  }

  /**
   * The card's pull request was merged, with `commit` the merge put on the base branch where GitHub
   * said: the work is live, the workspace free.
   */
  merged(cardId: string, commit?: string) {
    this.bump(cardId);
    this.o.board.planDocsLanded(cardId, this.planDocsAdded(cardId));
    const pr = this.o.board.row(cardId).pr;
    const { url, number } = pr ? (JSON.parse(pr) as PrState) : { url: null, number: undefined };
    const shipped: Shipped = { ...(commit ? { commit, base: `${commit}^` } : { fetch: true }), ...(url && number ? { pr: { url, number } } : {}) };
    this.o.board.work(cardId, {
      state: 'live',
      need: null,
      detail: null,
      status_line: null,
      landed: JSON.stringify((commit ? { commit } : {}) satisfies LandedState),
      shipped: JSON.stringify(shipped),
    });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.merged);
    this.o.onMerged?.(cardId);
    this.afterLanding(cardId, `Your pull request was merged; the card is live.\n\n${AFTER_LANDING}`);
  }

  /** Passes what happened on the pull request to the worker; the owner's log gets `note`. */
  prEvent(cardId: string, note: string, message: string) {
    this.o.board.log(cardId, 'state', 'obeya', note);
    this.deliver(cardId, message);
  }

  /** The pull request was closed without a merge: the owner decides what happens. */
  prClosed(cardId: string) {
    const t = this.o.board.t.worker;
    this.o.board.log(cardId, 'state', 'obeya', t.prClosed);
    this.toOwner(cardId, {
      text: t.prClosedQuestion,
      options: [t.reopen, t.discardWork],
    });
  }

  stop(cardId: string) {
    const card = this.card(cardId);
    if (card.finishing) {
      this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.stopped);
      this.finish(cardId);
      return;
    }
    if (card.state !== 'working' && card.state !== 'waiting') throw new BadRequest('noAgent', 'no agent works on this card');
    // comments held back for the worker stay in the conversation
    this.takeHeld(cardId);
    this.end(cardId);
    this.bump(cardId);
    // work on the branch keeps its workspace, so starting again goes on from there
    const keep = this.o.workspaces.hasWork(cardId);
    if (!keep) this.o.workspaces.release(cardId);
    this.o.board.work(cardId, { state: 'planned', need: null, detail: null, pr: null, approved_at: null, paused: null, snoozed: null, app: null, ...(keep ? {} : { workspace: null }) });
    this.o.board.log(cardId, 'state', 'owner', card.pr ? this.o.board.t.worker.stoppedPrOpen(card.pr.number) : this.o.board.t.worker.stopped);
  }

  /**
   * The owner pauses the card's worker while it is in a turn: its session ends at once, in the
   * middle of a step if need be, and whatever it ran with it (background work included). Card,
   * state, workspace, branch and session stay; the slot it held is free. It goes on where it stopped
   * once the owner resumes it or writes to it (`deliver`); what Obeya has for it meanwhile waits
   * until then, and its app is parked like a waiting card's. A worker taking in the owner's
   * words on its handover is paused the same way: the card still waits for approval, and the
   * worker finishes taking them in once it goes on.
   */
  pause(cardId: string) {
    const card = this.card(cardId);
    if (!pausable(card)) throw new BadRequest('noAgent', card.paused ? 'the agent is paused already' : 'the agent is not working on anything');
    // a message the worker had not taken in yet goes to it with the rest
    const pending = this.live.get(cardId)?.pending;
    this.end(cardId);
    this.bump(cardId);
    clearTimeout(this.reconnecting.get(cardId));
    this.reconnecting.delete(cardId);
    this.o.board.work(cardId, { paused: JSON.stringify((pending ? { held: [pending] } : {}) satisfies PausedState) });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.pausedByOwner);
    this.parkLater(cardId);
  }

  /** The owner lets the paused worker go on, whatever the card's state; it hears what came for it meanwhile. */
  resume(cardId: string) {
    const card = this.card(cardId);
    if (!card.paused) throw new BadRequest('notPaused', 'the agent is not paused');
    this.deliver(cardId, '', [], true);
  }

  /**
   * A scratch Obeya's idle workers (`--idle-workers`): a script acts as the card's agent
   * (`scripts/scratch-obeya.ts --say`), for a check of what the owner sees while one works. Its
   * words go into the conversation as an agent's text does, and its tools (report, reply, ask,
   * ready_for_review, …) run as the agent's do, through the same code; no turn starts or ends. A
   * card without a session (one staged at work) gets a stand-in for it. Returns what the agent would
   * have read as the tool's result.
   */
  async standIn(cardId: string, act: { say: string } | { tool: string; args?: Record<string, unknown> }): Promise<string> {
    const card = this.card(cardId);
    const live = this.live.get(cardId);
    if ('say' in act) {
      const text = String(act.say).trim();
      if (!text) throw new BadRequest('emptyText', 'say must be a non-empty string');
      if (live) this.onEvent(cardId, live, { type: 'text', text });
      else this.o.board.log(cardId, 'say', 'worker', clip(text, 12000));
      return 'Shown on the card.';
    }
    const stand: Live = live ?? {
      session: undefined!,
      host: null,
      handedOver: false,
      acted: true,
      nudged: false,
      lastText: '',
      busy: false,
      background: 0,
      tasks: new Map(),
      stalled: false,
      preferences: '',
      standIn: true,
    };
    const tool = this.tools(cardId, stand, !!card.prototypeOf).find((t) => t.name === act.tool);
    if (!tool) throw new BadRequest('invalid', `the card's agent has no tool ${act.tool}`);
    // as the SDK checks a call against the tool's schema
    const args = z.object(tool.schema).safeParse(act.args ?? {});
    if (!args.success) throw new BadRequest('invalid', `${act.tool}: ${args.error.message}`);
    return await tool.run(args.data);
  }

  /**
   * The card of the canvas a worker means by `title`, to wait on: the one by that title (the open
   * one, of several), else the one whose title holds it, if only one does; else why there is none.
   */
  private cardTitled(cardId: string, title: string): Item | string {
    const items = this.o.board.snapshot().items.filter((i) => i.id !== cardId && i.kind !== 'project');
    const key = titleKey(title);
    const exact = items.filter((i) => titleKey(i.title) === key);
    const pick = (of: Item[]) => of.findLast((i) => !i.archivedAt && !finished(i.state)) ?? of.at(-1)!;
    if (exact.length) return pick(exact);
    const near = items.filter((i) => !i.archivedAt && !finished(i.state) && titleKey(i.title).includes(key));
    if (near.length === 1) return near[0]!;
    if (near.length > 1) return `several cards have “${title}” in their title (${near.map((i) => `“${i.title}”`).join(', ')}); give one's full title.`;
    return `no card on the canvas is called “${title}”.`;
  }

  /**
   * The owner snoozes the card's worker until `until` (ISO), whether it is in a turn or between
   * turns: as on a pause, its session ends at once and what Obeya has for it meanwhile waits; at the
   * time it goes on where it stopped. A worker snoozed already only gets the new time.
   */
  snooze(cardId: string, until: string) {
    const card = this.card(cardId);
    if (card.snoozed) return this.o.board.snooze(cardId, { ...card.snoozed, until, ...(card.snoozed.by === 'agent' ? { moved: true as const } : {}) }, 'owner');
    // a message the worker had not taken in yet goes to it with the rest, after what a pause held already
    const pending = this.live.get(cardId)?.pending;
    const held = this.pausedOf(cardId)?.held ?? [];
    this.end(cardId);
    this.bump(cardId);
    clearTimeout(this.reconnecting.get(cardId));
    this.reconnecting.delete(cardId);
    this.o.board.work(cardId, { paused: JSON.stringify({ held: [...held, ...(pending ? [pending] : [])] } satisfies PausedState) });
    this.o.board.snooze(cardId, { until, by: 'owner' });
    this.parkLater(cardId);
  }

  /** The snoozed worker wakes and goes on: at its time (`timeUp`), as the card it waits on got there or no longer can (`met`), or because the owner wakes it now. */
  wake(cardId: string, timeUp = false, met?: Awaited) {
    this.card(cardId);
    const s = this.o.board.snoozedOf(cardId);
    if (!s || s.waiting) throw new BadRequest('notSnoozed', 'the agent is not snoozed');
    this.deliver(cardId, '', [], true, [], timeUp, met);
  }

  /** What the owner's pause holds for the worker, or null when it is not paused. */
  private pausedOf(cardId: string): PausedState | null {
    const paused = this.o.board.row(cardId).paused;
    return paused ? (JSON.parse(paused) as PausedState) : null;
  }

  /** After a restart (`repo`: of this repository's agents alone): resume every card whose worker was in the middle of a turn. */
  resumeAll(repo = false) {
    const restarted = repo ? REPO_RESTARTED : RESTARTED;
    for (const i of this.o.board.snapshot().items) {
      if (this.o.repo && i.repo !== this.o.repo) continue;
      // the page reloaded: the owner may watch on, or have gone
      if (i.held?.length) this.releaseLater(i.id, this.o.holdGrace ?? HOLD_GRACE);
      const row = this.o.board.row(i.id);
      const landed = landedOf(row);
      // a snoozed worker sleeps on until its time, a restart notwithstanding
      if (row.snoozed && !(JSON.parse(row.snoozed) as Snooze).waiting) {
        // the owner's snooze holds what Obeya has for the worker, as a pause does
        if (row.paused) this.pausedOverRestart(i.id, landed);
        else {
          this.parkLater(i.id);
          // a restart it waited for after the landing has happened: that wakes it
          if (landed?.restarts) {
            this.o.board.work(i.id, { landed: JSON.stringify(settled(landed)) });
            this.deliver(i.id, 'Obeya has started again and runs main with your change now.');
          }
        }
        continue;
      }
      // the owner's pause holds across the restart
      if (row.paused) {
        this.pausedOverRestart(i.id, landed);
        continue;
      }
      if (landed && row.workspace) {
        this.resumeLanded(i, landed, row.session_id, repo);
        continue;
      }
      // a worker taking in the owner's words on its handover was in the middle of a turn too
      if (answering(i)) {
        if (row.workspace && row.session_id) this.launch(i.id, restarted, row.session_id);
        else this.answerTaken(i.id);
        continue;
      }
      // a landing the restart cut off: the card waits for the owner's approval again
      if (i.landing) this.o.board.work(i.id, { approved_at: null });
      if (this.waitsForOwner(i.id)) {
        this.parkLater(i.id);
        continue;
      }
      if (i.state !== 'working' && i.state !== 'inPr') continue;
      if (!row.workspace) continue;
      if (row.session_id) this.launch(i.id, restarted, row.session_id);
      // it never reported a session: start one with the card
      else if (i.state === 'working') this.launch(i.id, this.briefing(i, row.branch ?? '', true), undefined, this.taskImages(i));
    }
  }

  /** After a restart, a paused worker stays paused: a restart it waited for has happened, which it hears once it goes on. */
  private pausedOverRestart(cardId: string, l: LandedState | null) {
    this.parkLater(cardId);
    if (!l?.restarts) return;
    this.o.board.work(cardId, { landed: JSON.stringify(settled(l)) });
    this.deliver(cardId, 'Obeya has started again and runs main with your change now.');
  }

  /** After a restart (`repo`: of this repository's agents alone): landed work's worker goes on with what remains; the restart it waited for has happened. */
  private resumeLanded(card: Item, l: LandedState, session: string | null, repo: boolean) {
    if (!session) return this.finish(card.id);
    this.o.board.work(card.id, { landed: JSON.stringify(settled(l)) });
    // an open question waits for its answer, which resumes the session
    if (card.state === 'waiting') return this.parkLater(card.id);
    const restarted = repo ? REPO_RESTARTED : RESTARTED;
    this.launch(card.id, l.restarts ? `${repo ? 'Obeya runs' : 'Obeya has started again and runs'} main with your change now. ${restarted}` : restarted, session);
  }

  /** The cards whose worker is in a turn, each holding a slot on its machine. */
  inTurn(): string[] {
    return [...this.live].filter(([, l]) => l.busy).map(([id]) => id);
  }

  /** The cards whose worker is in a turn, each with its background work that runs. */
  private turnsShown(): Map<string, BackgroundTask[]> {
    return new Map([...this.live].filter(([, l]) => l.busy).map(([id, l]) => [id, [...l.tasks.values()]]));
  }

  /** How many of these workers are in a turn on a machine (null: the one Obeya runs on). */
  busyOn(host: string | null): number {
    return [...this.live.values()].filter((l) => l.busy && l.host === host).length;
  }

  /**
   * The cards whose worker is in the middle of a turn (or whose ended turn waits for its background
   * work), and those whose work is landing: a restart would cut off git midway.
   */
  busyCards(): string[] {
    return [...new Set([...this.inTurn(), ...this.landing])];
  }

  /**
   * Obeya is about to restart (or no longer is): workers in the middle of a turn hear so and pause
   * at a safe point, and those that start a turn before the restart hear it with their message.
   */
  restartDue(due: DueRestart | null) {
    this.restart = due;
    if (!due) {
      // a worker that paused for it goes on with the owner's words that waited meanwhile
      for (const cardId of this.live.keys()) if (!this.takesLater(cardId) && this.unheard(cardId).length) this.deliver(cardId, '');
      return;
    }
    for (const [cardId, live] of this.live) {
      if (!live.busy || live.toldRestart) continue;
      this.tellRestart(cardId, live);
      live.session.send(restartNotice(due));
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartDue(pauseOf(due)));
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.end(id);
    for (const timer of this.reconnecting.values()) clearTimeout(timer);
    this.reconnecting.clear();
    for (const timer of this.parking.values()) clearTimeout(timer);
    this.parking.clear();
    for (const id of [...this.forwards.keys()]) this.unforward(id);
  }

  // ---------------------------------------------------------------- sessions

  /** What a worker's environment gets: where Obeya is, and the language the repository names for its demos (`DEMO_LANGUAGE`, read by the demo skill). */
  private env(): Record<string, string> | undefined {
    const language = this.o.adapter.demo?.language;
    return language ? { ...this.o.env, DEMO_LANGUAGE: language } : this.o.env;
  }

  private launch(cardId: string, message: string, resume?: string, images: string[] = []) {
    const row = this.o.board.row(cardId);
    if (!row.workspace) throw new Error(`card ${cardId} has no workspace to work in`);
    const preferences = this.o.preferences?.() ?? '';
    const live: Live = { session: undefined!, host: hostName(row.workspace), handedOver: false, acted: false, nudged: false, lastText: '', busy: true, background: 0, tasks: new Map(), stalled: false, preferences };
    const project = this.o.board.item(cardId)?.parent;
    if (project) live.project = { id: project, decision: this.o.board.decisions(project).at(-1)?.id ?? 0 };
    this.live.set(cardId, live);
    this.o.board.changed();
    ({ text: message, images } = this.withUnheard(cardId, message, images));
    message = this.withRestart(cardId, live, message);
    live.pending = { text: message, images };
    const env = this.env();
    // a plan folder outside the repository is the worker's to tick its workstream in, on this machine
    const plans = live.host ? null : outsidePlanDir(this.o.adapter.planDocs.dir);
    live.session = this.o.runtime.start(
      {
        cwd: row.workspace,
        role: 'worker',
        ...(plans ? { dirs: [plans] } : {}),
        system: this.system(preferences, !!row.prototype_of, this.o.board.item(cardId)),
        tools: this.tools(cardId, live, !!row.prototype_of),
        plugins: [OBEYA_PLUGIN],
        ...(env ? { env } : {}),
        contextUpdate: () =>
          [this.restartStillDue(cardId, live), this.unheardNow(cardId, live), this.preferencesUpdate(live), this.decisionsUpdate(cardId, live)].filter(Boolean).join('\n\n') || undefined,
        askOwner: (request, signal) => this.askOwner(cardId, live, request, signal),
        ...(this.folder ? { watch: this.folder.watch(cardId) } : {}),
        ...(resume ? { resume } : {}),
        ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
        onEvent: (e) => this.onEvent(cardId, live, e),
      },
      message,
      images,
    );
    live.session.done.then(() => {
      if (this.live.get(cardId) !== live) return;
      this.live.delete(cardId);
      // the card no longer shows its worker in a turn (an error after its turn ended counted as one)
      this.o.board.changed();
      // a session that ended without ending its turn takes in no answer any more
      this.answerTaken(cardId);
    });
  }

  /**
   * Passes a message to the worker, resuming its session if it has none. While the owner has paused
   * it, Obeya's messages wait (`owner` false); the owner's let it go on, after what waited. The
   * owner's words of the log's lines `said` wait for the worker's next step while it is in a turn
   * (`takesLater`), unread until then; other words go into the session's input at once.
   */
  private deliver(cardId: string, text: string, images: string[] = [], owner = false, said: number[] = [], timeUp = false, met?: Awaited) {
    const paused = this.pausedOf(cardId);
    if (paused && !owner) {
      this.o.board.work(cardId, { paused: JSON.stringify({ held: [...(paused.held ?? []), { text, images }] } satisfies PausedState) });
      return;
    }
    // a snoozed worker wakes: at its time, by the owner's words, or (snoozed by itself) by whatever Obeya has for it
    const snoozed = this.o.board.snoozedOf(cardId);
    const woke = snoozed && !snoozed.waiting ? snoozed : null;
    if (woke) {
      this.o.board.unsnooze(cardId, met ? { met } : timeUp ? 'time' : owner ? 'owner' : 'news');
      const live = this.live.get(cardId);
      if (live) live.snoozed = false;
    }
    const wokeText = woke ? wokeNote(woke, timeUp, owner, !!text, met) : '';
    if (paused) {
      this.o.board.work(cardId, { paused: null });
      if (!woke) this.o.board.log(cardId, 'state', 'owner', this.o.board.t.worker.resumedByOwner);
      const held = paused.held ?? [];
      text = [woke ? wokeText : RESUMED, ...(held.length ? [`While you were ${woke ? 'snoozed' : 'paused'}, Obeya had this for you:\n\n${held.map((h) => h.text).join('\n\n---\n\n')}`] : []), ...(text ? [`Then:\n\n${text}`] : [])].join('\n\n');
      images = [...held.flatMap((h) => h.images), ...images];
    } else if (woke) text = [wokeText, text].filter(Boolean).join('\n\n');
    this.unpark(cardId);
    const stopping = this.stopping.get(cardId);
    if (stopping) {
      // the worker might start the app again while the stop still runs, and lose it
      const generation = this.generation.get(cardId);
      void stopping.then(() => {
        if (this.generation.get(cardId) === generation) this.deliver(cardId, text, images, false, said);
      });
      return;
    }
    if (said.length && this.takesLater(cardId)) {
      this.o.board.work(cardId, { unheard: JSON.stringify([...this.unheard(cardId), { said, text, images }] satisfies Unheard[]) });
      return;
    }
    this.o.board.readNow(cardId, said);
    const parked = this.o.board.row(cardId).parked;
    if (parked) {
      this.o.board.work(cardId, { parked: null });
      text = `${text}\n\n${this.parkedNote()}`;
    }
    const live = this.live.get(cardId);
    if (live) {
      // the turn this starts reports the background work that is still running
      clearTimeout(live.waiting);
      live.waiting = undefined;
      clearTimeout(live.lifts);
      live.lifts = undefined;
      this.setBusy(live, true);
      ({ text, images } = this.withUnheard(cardId, text, images));
      const message = this.withRestart(cardId, live, text);
      live.pending = { text: message, images };
      live.session.send(message, images);
      return;
    }
    const row = this.o.board.row(cardId);
    if (row.session_id) return this.launch(cardId, text, row.session_id, images);
    // no session to resume (it never reported one): a new one needs the card first
    const card = this.card(cardId);
    this.launch(cardId, `${this.briefing(card, row.branch ?? '', true)}\n\n${text}`, undefined, [...this.taskImages(card), ...images]);
  }

  /** Whether the worker is in the middle of a turn, so that the owner's words wait for its next step. */
  private takesLater(cardId: string): boolean {
    const live = this.live.get(cardId);
    return !!live && live.busy && !live.waiting && !this.stopping.has(cardId) && !this.pausedOf(cardId);
  }

  private unheard(cardId: string): Unheard[] {
    const stored = this.o.board.row(cardId).unheard;
    return stored ? (JSON.parse(stored) as Unheard[]) : [];
  }

  /** The owner's words Obeya held for the worker, taken out: they are read from now on. */
  private takeUnheard(cardId: string): Unheard[] {
    const unheard = this.unheard(cardId);
    if (!unheard.length) return [];
    this.o.board.work(cardId, { unheard: null });
    this.o.board.readNow(cardId, unheard.flatMap((u) => u.said));
    return unheard;
  }

  /** A message that starts a turn, with the owner's words that waited for the worker's next step after it. */
  private withUnheard(cardId: string, text: string, images: string[]): { text: string; images: string[] } {
    const unheard = this.takeUnheard(cardId);
    if (!unheard.length) return { text, images };
    return { text: [text, ...unheard.map((u) => u.text)].filter(Boolean).join('\n\n---\n\n'), images: [...images, ...unheard.flatMap((u) => u.images)] };
  }

  /**
   * The owner's words that waited for the worker's next step, passed with that step's result. A
   * tool result carries no images: the worker opens the screenshots' files itself.
   */
  private unheardNow(cardId: string, live: Live): string | undefined {
    if (this.live.get(cardId) !== live) return;
    const unheard = this.takeUnheard(cardId);
    if (!unheard.length) return;
    const images = unheard.flatMap((u) => u.images);
    return [...unheard.map((u) => u.text), ...(images.length ? [`The screenshots cannot come with a tool result: read their files to see them (${images.join(', ')}).`] : [])].join('\n\n---\n\n');
  }

  /**
   * The worker's turn ended before a step took in the owner's words that waited for it: they start
   * its next turn. Not while it stops for a restart or a usage limit, which it goes on from with them.
   */
  private unheardStarts(cardId: string, live: Live): boolean {
    if (this.restart || live.limited || !this.unheard(cardId).length) return false;
    const { text, images } = this.withUnheard(cardId, '', []);
    this.setBusy(live, true);
    live.pending = { text, images };
    live.session.send(text, images);
    return true;
  }

  /** Preferences the owner gave or changed since the worker last heard them, passed with its next tool result. */
  private preferencesUpdate(live: Live): string | undefined {
    const now = this.o.preferences?.() ?? '';
    if (now === live.preferences) return;
    live.preferences = now;
    return now ? `The owner's preferences changed while you work; they now read:\n\n${now}` : 'The owner withdrew their standing preferences; none apply any more.';
  }

  /** Decisions taken in the card's project since the worker last heard of them, passed with its next tool result; those on its own card it heard as answers. */
  private decisionsUpdate(cardId: string, live: Live): string | undefined {
    if (!live.project) return;
    const fresh = this.o.board.decisions(live.project.id).filter((d) => d.id > live.project!.decision);
    if (!fresh.length) return;
    live.project.decision = fresh.at(-1)!.id;
    const others = fresh.filter((d) => d.card_id !== cardId);
    return others.length ? `Decisions taken in this project while you work:\n${decisionLog(others)}` : undefined;
  }

  /**
   * A message that starts a turn while a restart is due tells the worker of it, once: that the
   * work the message asks for waits until Obeya resumes it (workers in a turn heard of it already).
   */
  private withRestart(cardId: string, live: Live, text: string): string {
    const still = this.restartStillDue(cardId, live);
    if (still) return `${text}\n\n${still}`;
    if (!this.restart || live.toldRestart) return text;
    this.tellRestart(cardId, live);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartWaits(pauseOf(this.restart)));
    return `${text}\n\n${restartWaits(this.restart)}`;
  }

  /**
   * A turn that starts after the worker paused for the restart, before it happened, hears once that
   * Obeya still waits: with its message, or with its first tool step when nothing of Obeya's started
   * it (a background command that finished, which the worker would otherwise go on from).
   */
  private restartStillDue(cardId: string, live: Live): string | undefined {
    if (!this.restart || !live.restartPaused) return;
    live.restartPaused = false;
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.restartStillDue(pauseOf(this.restart)));
    return stillDue(this.restart);
  }

  private tellRestart(cardId: string, live: Live) {
    live.toldRestart = true;
    live.statusBeforeRestart = this.o.board.row(cardId).status_line;
  }

  /** The worker ended its turn for the restart: the card says so, and its status line is again the one from before it heard of it. */
  private pausedForRestart(cardId: string, live: Live) {
    if (live.statusBeforeRestart !== undefined) this.o.board.work(cardId, { status_line: live.statusBeforeRestart });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.paused(pauseOf(this.restart!)));
  }

  private bump(cardId: string) {
    this.generation.set(cardId, (this.generation.get(cardId) ?? 0) + 1);
    this.unpark(cardId);
  }

  private end(cardId: string) {
    const live = this.live.get(cardId);
    this.live.delete(cardId);
    clearTimeout(live?.waiting);
    clearTimeout(live?.lifts);
    live?.session.close();
    // its slot is free again
    if (live?.busy) this.o.board.changed();
  }

  /**
   * Whether the worker is in a turn. It holds a slot on its machine meanwhile: the board hears of
   * each change, so the Workspaces pill shows it and a card waiting for a slot starts once one frees.
   */
  private setBusy(live: Live, busy: boolean) {
    if (live.busy === busy) return;
    live.busy = busy;
    if ([...this.live.values()].includes(live)) this.o.board.changed();
  }

  private onEvent(cardId: string, live: Live, e: AgentEvent) {
    if (this.live.get(cardId) !== live) return;
    if (e.type === 'background') return this.backgroundChanged(cardId, live, e.tasks);
    // a turn may also start without a message from Obeya (a finished background command)
    this.setBusy(live, e.type !== 'idle');
    clearTimeout(live.waiting);
    live.waiting = undefined;
    clearTimeout(live.lifts);
    live.lifts = undefined;
    if (e.type === 'text' || e.type === 'tool') {
      // a turn of its own (a finished background command woke it) after it answered the owner's
      // words on its handover: it works on towards what it told them, so the card is at work again
      if (!live.acted && this.o.board.item(cardId)?.answered) this.takingIn(cardId, true);
      this.resumed(cardId, live);
      this.unlimited(cardId, live);
      live.failed = undefined;
    }
    if (e.type === 'text' || e.type === 'tool' || e.type === 'error') live.acted = true;
    if (e.type === 'text' || e.type === 'tool' || (e.type === 'idle' && !e.more)) live.pending = undefined;
    switch (e.type) {
      case 'session': {
        // a session that replaces another (none resumed, say) keeps the one before for the Arbeitsrückschau
        const before = this.o.board.row(cardId).session_id;
        if (before && before !== e.id) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.newSession(this.o.board.t.worker.earlierRun(before)));
        this.o.board.work(cardId, { session_id: e.id });
        break;
      }
      case 'text':
        live.lastText = e.text;
        // after handing over the worker's closing words repeat the handover the card shows: the
        // conversation leaves them out; after a reply its words wait to see whether work follows them
        // or they close the turn, repeating the reply
        if (live.handedOver || live.snoozed) break;
        live.spoke = true;
        if (live.answered) live.held = clip(e.text, 12000);
        else this.o.board.log(cardId, 'say', 'worker', clip(e.text, 12000));
        break;
      case 'tool':
        if (live.held !== undefined) this.o.board.log(cardId, 'say', 'worker', live.held);
        live.held = undefined;
        if (!e.name.startsWith('mcp__obeya__')) this.o.board.log(cardId, 'activity', 'worker', describeTool(e.name, e.input, this.o.board.t));
        break;
      case 'denied': {
        const t = this.o.board.t;
        this.o.board.log(cardId, 'denied', 'worker', t.worker.denied(describeTool(e.name, e.input, t), t.worker.deniedBy[e.by], e.reason && clip(e.reason, 600)));
        break;
      }
      case 'error':
        if (e.limit) {
          live.limited = limitLifts(e.limit, this.o.limitMargin ?? 10_000);
          const t = this.o.board.t;
          this.o.board.log(cardId, 'state', 'obeya', `${e.message}. ${e.limit.resetsAt ? t.worker.limitResumes(t.when(live.limited)) : t.worker.limitRetries(t.when(live.limited))}`);
          break;
        }
        live.failed = e.message;
        this.o.board.log(cardId, 'error', 'obeya', e.message);
        break;
      case 'lost':
        this.lost(cardId, live);
        break;
      case 'idle':
        live.background = e.background ?? 0;
        if (!live.background) live.tasks.clear();
        this.turnEnded(cardId, live, live.background, false, this.unheardStarts(cardId, live) || e.more);
        this.parkLater(cardId);
        break;
    }
  }

  private async landApproved(cardId: string) {
    try {
      await this.land(cardId, 'obeya');
    } catch (e) {
      // the Obeya checkout is in the way: the card waits for the owner, who approves again
      if (!(e instanceof BadRequest)) return this.o.board.log(cardId, 'error', 'obeya', messageOf(e));
      this.o.board.work(cardId, { state: 'waiting', need: this.o.board.row(cardId).demo ? 'demo' : 'review', status_line: null });
      this.o.board.log(cardId, 'error', 'obeya', e.message, { code: e.code });
    }
  }

  /**
   * A turn that ends without handing over gets one nudge; after that the owner is asked. A turn
   * that ends while the worker's background work runs (a demo render, say) waits for that work
   * to wake the worker instead, unless nothing happens for a long while; so does a turn in which
   * the worker did nothing, as it never ended a turn of its own there. A turn that ends with a
   * message from Obeya still to come (`more`) is not the worker's last: the turn that message starts
   * is, so the landing of its work, told while the worker ended its reply, is not lost with the session.
   */
  private turnEnded(cardId: string, live: Live, background: number, waited = false, more = false) {
    // calls whose end its hooks never heard of (refused, cut off) end with the turn
    void this.folder?.settle(cardId);
    const handedOver = live.handedOver;
    const acted = live.acted || waited;
    const closing = live.held;
    const snoozed = live.snoozed;
    const spoke = !!live.spoke;
    live.handedOver = false;
    live.answered = false;
    live.spoke = false;
    // a snooze holds across a turn a message from Obeya still starts (a restart notice): its session ends after that one
    if (!more) live.snoozed = false;
    live.held = undefined;
    live.acted = false;
    // a turn that took in the restart pauses for it, whatever else keeps the worker busy
    if (this.restart && live.toldRestart && !more) live.restartPaused = true;
    const card = this.o.board.item(cardId);
    if (!card) return;
    if (closing !== undefined) this.o.board.log(cardId, 'closing', 'worker', closing);
    const row = this.o.board.row(cardId);
    // it snoozed: its session ends (its background work with it), and Obeya resumes it at the time
    if (snoozed && !handedOver && !more && row.snoozed) return this.end(cardId);
    if (background > 0) {
      // the usage limit cut the worker's turn off while its work runs on: the card says so, and the
      // worker goes on once it lifts, without waiting for that work to wake it
      if (live.limited && !handedOver && this.goesOnAfterLimit(cardId)) return this.waitForLimit(cardId, live, live.limited, background);
      // the background work still belongs to the turn, whatever the card's state (a worker may ask
      // while its render runs): a restart now would cut it off
      this.waitForWorker(cardId, live);
      if (!handedOver) return;
    }
    if (more && !handedOver) return this.waitForWorker(cardId, live);
    if (answering(card)) {
      // a resumed session may first end a turn of its own before it takes in the owner's words
      if (!acted && !handedOver) return this.waitForWorker(cardId, live);
      // it paused for the restart, which resumes it, still taking in the answer
      if (this.restart && live.toldRestart && !handedOver) return this.pausedForRestart(cardId, live);
      // the usage limit cut it off: it goes on by itself once the limit lifts, still taking in the answer
      if (live.limited && !handedOver) return this.waitForLimit(cardId, live, live.limited);
      this.answerTaken(cardId, spoke);
    }
    if (handedOver) {
      // work the owner approved already lands once its worker handed over what stood in the way
      if (card.state === 'working' && row.approved_at) void this.landApproved(cardId);
      return;
    }
    const landed = landedOf(row);
    // in the PR phase a turn ends normally once the PR is open
    if (card.state === 'inPr' && card.pr) return;
    if (card.state !== 'working' && card.state !== 'inPr' && !landed) return;
    if (landed) {
      // what remained after the landing is done, unless the worker waits for its question, the restart or the usage limit
      if (card.state === 'waiting' || landed.waits) return;
      if (landed.needsClone) return this.awaitClone(cardId);
      // it paused for the restart, which resumes it with its workspace
      if (this.restart && live.toldRestart && !live.failed) return this.pausedForRestart(cardId, live);
      if (live.limited) return this.waitForLimit(cardId, live, live.limited);
      if (live.failed) return this.failedAfterLanding(cardId, live);
      this.finish(cardId);
      return;
    }
    // it paused for the restart, which resumes it
    if (this.restart && live.toldRestart) return this.pausedForRestart(cardId, live);
    if (live.limited) return this.waitForLimit(cardId, live, live.limited);
    if (!acted && !live.nudged) {
      // the worker's own turn is still to come; should it not, it counts as ended after a while
      // (silence after a nudge, though, is the worker having stopped)
      this.waitForWorker(cardId, live);
      return;
    }
    if (!live.nudged) {
      live.nudged = true;
      this.setBusy(live, true);
      live.session.send(
        card.state === 'inPr'
          ? 'Your turn ended, and Obeya has no pull request for this card yet (pr_opened), nor did you close it as needing none (close_unchanged).'
          : 'Your turn ended without a handover (ready_for_review) or a question (ask), so the card still shows you at work. Should you end your turn again like this, Obeya passes your last words to the owner as a question.',
      );
      return;
    }
    live.nudged = false;
    live.stalled = true;
    // a session that fails again after the nudge cannot go on by itself: the owner hears why, not its last words
    const text = live.failed ? failureReason(clip(live.failed, 1200), this.o.board.t) : live.lastText ? clip(live.lastText, 1200) : this.o.board.t.worker.stalled;
    this.toOwner(cardId, { text, options: [], stuck: true });
  }

  /**
   * A turn after the landing that an error cut off (the API overloaded, say) has not done what
   * remained: it is tried once more, then the owner hears why. A restart that is due tries it
   * again by resuming the worker, and need not wait for a turn that may fail the same way.
   */
  private failedAfterLanding(cardId: string, live: Live) {
    if (this.restart) {
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.paused(pauseOf(this.restart)));
      return;
    }
    if (!live.nudged) {
      live.nudged = true;
      this.setBusy(live, true);
      live.session.send(`Your last turn broke off with an error (${clip(live.failed!, 300)}). Your work is on main; go on with what remained after the landing.`);
      return;
    }
    live.nudged = false;
    live.stalled = true;
    const t = this.o.board.t;
    const reason = failureReason(clip(live.failed!, 1200), t);
    this.toOwner(cardId, { text: t.worker.remainsUndone(`${reason}${/[.!?]$/.test(reason) ? '' : '.'}`), options: [t.worker.tryAgain], stuck: true });
  }

  /**
   * The worker takes in the owner's words on its handover: the card is at work meanwhile, and still
   * waits for approval. New words are not answered yet; a worker that its background work woke
   * after it answered (`woke`) works on towards that answer, which stands.
   */
  private takingIn(cardId: string, woke = false) {
    const detail = this.o.board.row(cardId).detail;
    const { answered, ...rest } = detail ? (JSON.parse(detail) as Record<string, unknown>) : {};
    this.o.board.work(cardId, { detail: JSON.stringify({ ...rest, ...(woke && answered ? { answered } : {}), answering: true }) });
  }

  /**
   * The worker has taken in the owner's words on its handover: work still waiting is the owner's
   * again, `answered` when its turn ended with words for them rather than a new demo (or a turn
   * before did, `takingIn`). Without any (its session ended, its turn broke off) the owner hears
   * that their words went unanswered.
   */
  private answerTaken(cardId: string, spoke = false) {
    const { detail } = this.o.board.row(cardId);
    if (!detail) return;
    const { answering, answered: before, ...rest } = JSON.parse(detail) as Record<string, unknown>;
    if (!answering) return;
    const answered = spoke || !!before;
    this.o.board.work(cardId, { detail: JSON.stringify({ ...rest, ...(answered ? { answered: true } : {}) }) });
    if (!answered) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.unanswered);
  }

  /**
   * Waits for a sign of life from the worker; without one for a long while, its turn counts as ended.
   * While its background work runs (a watcher waiting for a deploy, say) that may take long: the
   * wait is the work's own, which wakes the worker when it ends.
   */
  private waitForWorker(cardId: string, live: Live) {
    this.setBusy(live, true);
    clearTimeout(live.waiting);
    live.waiting = setTimeout(() => {
      live.waiting = undefined;
      this.setBusy(live, false);
      if (this.live.get(cardId) !== live) return;
      this.turnEnded(cardId, live, 0, true);
      this.parkLater(cardId);
    }, live.background > 0 ? (this.o.backgroundLimit ?? BACKGROUND_LIMIT) : (this.o.backgroundGrace ?? BACKGROUND_GRACE));
  }

  /** The worker's background work started or ended: an ended turn waiting for it waits as long as it runs. */
  private backgroundChanged(cardId: string, live: Live, running: { id: string; description: string }[]) {
    live.background = running.length;
    // what it changes in a folder without git meanwhile is the card's
    this.folder?.background(cardId, running.length > 0);
    const now = Date.now();
    live.tasks = new Map(running.map((t) => [t.id, { description: t.description, since: live.tasks.get(t.id)?.since ?? now }]));
    // the card shows what runs while the worker is in a turn
    if (live.busy) this.o.board.changed();
    if (live.waiting) this.waitForWorker(cardId, live);
  }

  // ---------------------------------------------------------------- parking

  /**
   * Whether the card waits for the owner with its workspace and nothing of its worker's running:
   * handed over, asked, or its pull request open, and the worker's turn over, background work included.
   */
  private waitsForOwner(cardId: string): boolean {
    const card = this.o.board.item(cardId);
    if (!card || !(card.state === 'waiting' || (card.state === 'inPr' && card.pr) || card.paused || card.snoozed)) return false;
    // paused while taking in the owner's words on its handover, nothing of it runs either
    if ((answering(card) && !card.paused) || this.live.get(cardId)?.busy) return false;
    const row = this.o.board.row(cardId);
    return !!row.workspace && !row.parked;
  }

  /** A card that waits for the owner has its app stopped once a quick reply has not come (`app.stop`). */
  private parkLater(cardId: string) {
    if (!this.o.adapter.app?.stop || !this.waitsForOwner(cardId)) return;
    clearTimeout(this.parking.get(cardId));
    this.parking.set(
      cardId,
      setTimeout(() => {
        this.parking.delete(cardId);
        if (!this.waitsForOwner(cardId) || this.stopping.has(cardId)) return;
        const stopping = this.park(cardId).finally(() => this.stopping.delete(cardId));
        this.stopping.set(cardId, stopping);
      }, Math.max(this.o.parkGrace ?? PARK_GRACE, (this.tried.get(cardId) ?? 0) + (this.o.tryGrace ?? TRY_GRACE) - Date.now())),
    );
  }

  /**
   * Where the owner's browser reaches the app the card's worker said runs: its address, or for a
   * workspace on another machine that address's port forwarded here (only that port: a page that
   * talks to another port there finds nothing here). The forward is made when first asked for and
   * made again when its connection dropped, on the port it had if that is still free.
   */
  private async appAt(cardId: string): Promise<string | null> {
    const app = this.o.board.item(cardId)?.app;
    const workspace = this.o.board.row(cardId).workspace;
    if (!app || !workspace) return null;
    const there = remote(workspace);
    if (!there) return app;
    let url: URL;
    try {
      url = new URL(app);
    } catch {
      return null;
    }
    let f = this.forwards.get(cardId);
    let prefer: number | undefined;
    if (f && !f.forward.alive) {
      prefer = f.port;
      this.unforward(cardId);
      f = undefined;
    }
    if (!f) {
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      f = { app, workspace, forward: there.host.forward(host === '0.0.0.0' || host === '::' ? 'localhost' : host, port, prefer), port: prefer };
      this.forwards.set(cardId, f);
    }
    const local = await f.forward.ready;
    if (!local || this.forwards.get(cardId) !== f) return null;
    f.port = local;
    // the browser here names it as the worker did where it can, so the page's own origin stays
    url.hostname = url.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
    url.port = String(local);
    return url.href;
  }

  /** Ends the forward to the card's app, if it has one. */
  private unforward(cardId: string) {
    this.forwards.get(cardId)?.forward.close();
    this.forwards.delete(cardId);
  }

  /** Whether the app the card's worker said runs answers at its address now: any HTTP answer counts, an error page too. */
  async appUp(cardId: string): Promise<boolean> {
    const url = await this.appAt(cardId);
    if (!url) return false;
    try {
      await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS), tls: { rejectUnauthorized: false } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The owner opens the card's app to try it by hand: its address. Obeya leaves it running for a
   * while after (`TRY_GRACE`), so it does not stop under them once the card waits. None once it no longer runs.
   */
  async openApp(cardId: string): Promise<string | null> {
    const url = await this.appAt(cardId);
    if (!url) return null;
    this.tried.set(cardId, Date.now());
    if (this.parking.has(cardId)) this.parkLater(cardId);
    return url;
  }

  /** A card that is no longer left waiting keeps its app. */
  private unpark(cardId: string) {
    clearTimeout(this.parking.get(cardId));
    this.parking.delete(cardId);
  }

  /**
   * The connection to the machine the card's workspace is on is gone, and the session with it (as
   * at a restart of Obeya): once that machine answers again, the session resumes by its id, with
   * the message it had not yet taken, else told what happened if it was at work (or waited for its
   * background work). A session that never started there (the host could not be reached to get
   * it ready) has no id: a new one starts with the message it was to begin with. A card that waits
   * for the owner meanwhile needs no session until their next message.
   */
  private lost(cardId: string, live: Live) {
    const there = remote(this.o.board.row(cardId).workspace);
    if (!there) return;
    this.live.delete(cardId);
    clearTimeout(live.waiting);
    clearTimeout(live.lifts);
    const pending = live.pending;
    // in a turn, or its ended turn waiting for background work that woke it: that work went with the session
    const busy = live.busy;
    const generation = this.generation.get(cardId);
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.hostLost(there.host.name));
    const again = async () => {
      this.reconnecting.delete(cardId);
      const current = () => this.generation.get(cardId) === generation && !this.live.has(cardId);
      if (!current()) return;
      if (!(await there.host.reachable())) {
        if (current()) this.reconnecting.set(cardId, setTimeout(again, this.o.reconnectMs ?? RECONNECT_MS));
        return;
      }
      const row = this.o.board.row(cardId);
      const card = this.o.board.item(cardId);
      if (!current() || !card || !row.workspace || (!row.session_id && !pending) || card.snoozed) return;
      const working = busy || card.state === 'working' || card.state === 'inPr' || answering(card) || !!row.landed;
      if (!pending && !working) return;
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.hostBack(there.host.name));
      if (pending) this.launch(cardId, pending.text, row.session_id ?? undefined, pending.images);
      else this.launch(cardId, hostResumed(there.host.name), row.session_id!);
    };
    this.reconnecting.set(cardId, setTimeout(again, this.o.reconnectMs ?? RECONNECT_MS));
  }

  /**
   * A demo directory as the server reads it: the worker's own on this machine; from a worker on
   * another machine, its copy here (design: Hosts), taken afresh at each handover.
   */
  private async demoHere(cardId: string, dir: string): Promise<{ dir: string } | { wrong: string }> {
    try {
      const there = remote(this.o.board.row(cardId).workspace);
      if (!there) return { dir };
      const copy = there.host.localCopy(dir);
      await there.host.copyFrom(dir, copy);
      return { dir: copy };
    } catch (e) {
      return { wrong: messageOf(e) };
    }
  }

  /** Stops the app in the card's workspace, unless it holds what must stay (`app.keep`). */
  private async park(cardId: string) {
    const { stop, keep } = this.o.adapter.app ?? {};
    // the settings lost the command since the grace began
    if (!stop) return;
    const workspace = this.o.board.row(cardId).workspace!;
    const generation = this.generation.get(cardId);
    if (keep && (await runAppCommand(workspace, keep)).ok) {
      if (this.generation.get(cardId) === generation) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.parkKept);
      return;
    }
    const result = await runAppCommand(workspace, stop);
    // the card's work ended or started afresh meanwhile: its row is no longer this workspace's
    if (this.generation.get(cardId) !== generation) return;
    if (!result.ok) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.parkFailed(clip(result.output, 600)));
      return;
    }
    this.o.board.work(cardId, { parked: new Date().toISOString(), app: null });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.parked);
  }

  private parkedNote(): string {
    const { stop, run } = this.o.adapter.app ?? {};
    return `While the card waited, Obeya stopped the app in your workspace${stop ? ` (\`${stop}\`)` : ''} to free the machine. When you need it again, start it again${run?.trim() ? ' as the recipe in your brief says' : ''}.`;
  }

  /**
   * The usage limit stopped the worker, at work, taking in the owner's words on its handover or after
   * the landing: it goes on by itself once the limit lifts. Meanwhile it is not busy (a restart need
   * not wait for it, and resumes it into the same limit), unless its `background` work runs on,
   * which a restart would cut off; a message from the owner reaches it at once and finds out whether
   * the limit still holds.
   */
  private waitForLimit(cardId: string, live: Live, at: number, background = 0) {
    if (background > 0) this.waitForWorker(cardId, live);
    else this.setBusy(live, false);
    if (live.statusBefore === undefined) {
      // after a restart the line may still be the one this shows
      const line = this.o.board.row(cardId).status_line;
      live.statusBefore = line && limitLine(line) ? null : line;
    }
    this.o.board.work(cardId, { status_line: this.o.board.t.worker.limitStatusUntil(this.o.board.t.when(at)) });
    clearTimeout(live.lifts);
    // a timer runs at most about 24 days
    live.lifts = setTimeout(() => {
      live.lifts = undefined;
      if (this.live.get(cardId) !== live || !this.goesOnAfterLimit(cardId)) return;
      this.deliver(cardId, LIMIT_LIFTED);
    }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
  }

  /** Whether the card's worker goes on by itself once the usage limit lifts: it is at work on the card, not waiting for the owner. */
  private goesOnAfterLimit(cardId: string): boolean {
    const card = this.o.board.item(cardId);
    if (!card) return false;
    const landed = !!this.o.board.row(cardId).landed;
    return card.state === 'working' || card.state === 'inPr' || answering(card) || (landed && card.state !== 'waiting');
  }

  /** A worker that waited for the usage limit works again: its status line is back. */
  private unlimited(cardId: string, live: Live) {
    live.limited = undefined;
    const before = live.statusBefore;
    live.statusBefore = undefined;
    if (before !== undefined) this.o.board.work(cardId, { status_line: before });
    // it waited before a restart
    else if (limitLine(this.o.board.row(cardId).status_line)) this.o.board.work(cardId, { status_line: null });
  }

  /** A worker that went to the owner for having stopped and then works on by itself takes the question back. */
  private resumed(cardId: string, live: Live) {
    if (!live.stalled) return;
    live.stalled = false;
    const card = this.o.board.item(cardId);
    if (card?.state !== 'waiting' || card.need !== 'question') return;
    this.backToWork(cardId);
  }

  // ---------------------------------------------------------------- the worker's tools

  private tools(cardId: string, live: Live, prototype: boolean): AgentTool[] {
    // the system prompt says which language that is (`ownersLanguage`)
    const language = "the owner's language";
    // the page goes to colleagues: in the language of the repository's demos where it names one
    const pageLanguage = LANGUAGE_NAMES[this.o.adapter.demo?.language ?? this.o.board.conversation()];
    const handOver = () => {
      live.handedOver = true;
      live.nudged = false;
      // a question or a handover after a snooze in the same turn: the card waits for the owner instead
      if (live.snoozed) {
        live.snoozed = false;
        this.o.board.work(cardId, { snoozed: null });
      }
    };
    // a session the owner stopped or replaced may still call its tools: those calls change nothing
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({ ...t, run: (args) => (this.live.get(cardId) === live || live.standIn ? t.run(args) : 'This session has ended. Stop working and end your turn.') }));
    return current([
      {
        name: 'report',
        description: `Show the owner one short status line on your card (in ${language}, at most ~80 characters). Use it at milestones, not for every step.`,
        schema: { status: z.string() },
        run: ({ status }) => {
          const s = clip(String(status), 200);
          this.o.board.work(cardId, { status_line: s });
          this.o.board.log(cardId, 'report', 'worker', s);
          return 'Shown on the card.';
        },
      },
      {
        name: 'reply',
        description: `Answer a note or feedback from the owner in your card's conversation: a sentence or two in ${language}, what you change because of it or why nothing. The reply does not end your turn: if work remains, carry on with it; if none does (your work is handed over and the note changes nothing), your turn ends with the reply, and the card goes on waiting for the owner's approval.`,
        schema: { text: z.string() },
        run: ({ text }) => {
          const s = clip(String(text).trim(), 2000);
          if (!s) return 'Not shown: the reply is empty.';
          this.o.board.log(cardId, 'talk', 'worker', s);
          live.answered = true;
          live.spoke = true;
          return 'Shown to the owner.';
        },
      },
      {
        name: 'ask',
        description: `Ask for a decision you should not make yourself: product behaviour, trade-offs, anything irreversible or external. Write the question in ${language} for a reader who has not seen the code, and offer up to four short answer options when they exist; the owner picks one on the card (several when multiple is true) or writes their own. pick: the options you would choose yourself if you had to decide (one, or several when multiple), and pick_why: why, in one short sentence in ${language}; the card marks them for the owner. Then end your turn.`,
        schema: {
          question: z.string(),
          options: z.array(z.string()).max(4).optional(),
          multiple: z.boolean().optional(),
          pick: z.array(z.string()).optional(),
          pick_why: z.string().optional(),
        },
        run: (args) => {
          handOver();
          const q = withPick(args as unknown as Asked);
          this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
          this.toOwner(cardId, q);
          return END_TURN;
        },
      },
      // a prototype makes no cards of its own: what it proposes is building its idea on it
      prototype
        ? {
            name: 'propose_build',
            description: `Propose that the idea be built on this prototype: a worker then goes on from your branch, takes over what carries and brings it to production quality, and the idea's other prototypes are discarded. Use it when your approach convinced (the owner said so, or it clearly settles the idea). It shows on your card, where the owner accepts it or not. reason: why, in ${language}, a sentence or two.`,
            schema: { reason: z.string() },
            run: ({ reason }) => {
              this.o.board.proposeBuild(cardId, clip(String(reason).trim(), 2000));
              this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.proposesBuild(clip(String(reason).trim(), 300)));
              return 'Shown on your card; the owner decides. Continue with your task.';
            },
          }
        : {
            name: 'propose_card',
            description: [
              `Propose a separate card for something you noticed that is outside your task, instead of doing it here; the owner decides on it.`,
              `idea: true for something to think through with the owner before anyone builds it (it becomes an idea, discussed with an agent of its own); leave it out for a task that is clear enough to build.`,
              proposalTask('your card nor your session'),
              `reason: for the owner only, why you propose it, a sentence or two; it does not go to that agent.`,
              `questions: what the owner has to decide first (product behaviour, a trade-off), each with up to four short options; keep them out of task. The owner may answer them on the proposal; what they decided and what stays open go to the agent with the task.`,
              `replaces: the title of an earlier proposal of yours this one takes the place of; Obeya takes that one off the canvas, or, if the owner has taken it on already, marks it as replaced and offers to remove it.`,
              `Everything in ${language}.`,
            ].join(' '),
            schema: {
              title: z.string(),
              task: z.string(),
              reason: z.string(),
              idea: z.boolean().optional(),
              questions: PROPOSAL_QUESTIONS.optional(),
              replaces: z.string().optional(),
            },
            run: ({ title, task, reason, idea, questions, replaces }) => {
              const p = this.o.board.propose(cardId, {
                title: String(title),
                task: String(task),
                reason: String(reason),
                idea: !!idea,
                questions: proposalQuestions(questions as z.infer<typeof PROPOSAL_QUESTIONS> | undefined),
              });
              this.o.board.log(cardId, 'activity', 'worker', idea ? this.o.board.t.worker.proposedIdea(p.title) : this.o.board.t.worker.proposedCard(p.title));
              const old = typeof replaces === 'string' && replaces.trim() ? replaces.trim() : undefined;
              return old ? `Proposed. ${this.retract(cardId, old, { by: p.id, title: p.title })}` : 'Proposed; the owner decides. Continue with your task.';
            },
          },
      // a prototype makes no cards, so it has none to take back
      ...(prototype
        ? []
        : [
            {
              name: 'withdraw_proposal',
              description: [
                `Take back a card you proposed earlier (propose_card) that turned out wrong or needless, by its title. Still open, it goes from the canvas at once; if the owner has taken it on already, Obeya marks it as withdrawn and offers to remove it.`,
                `replaced_by: the title of a proposal of yours that takes its place, when you made one already (a new one names the old with replaces instead).`,
                `why: for the owner, a sentence, in ${language}.`,
              ].join(' '),
              schema: { title: z.string(), why: z.string(), replaced_by: z.string().optional() },
              run: (args: Record<string, unknown>) => {
                const { title, why, replaced_by } = args as { title: string; why: string; replaced_by?: string };
                // the latest by that title, as retract takes the latest it replaces: of two alike, the newer replaces the older
                const by = replaced_by?.trim() ? this.o.board.snapshot().items.findLast((i) => i.from === cardId && (!!i.proposal || !!i.proposed) && titleKey(i.title) === titleKey(replaced_by)) : undefined;
                if (replaced_by?.trim() && !by) return `No card you proposed on the canvas is called „${replaced_by.trim()}“. Nothing was withdrawn.`;
                return this.retract(cardId, String(title).trim(), { ...(by ? { by: by.id, title: by.title } : {}), ...(why?.trim() ? { why: clip(why.trim(), 1000) } : {}) });
              },
            },
          ]),
      {
        name: 'pr_opened',
        description: 'After the owner approved: report the pull request you opened for this card (its URL). Then end your turn; Obeya watches it.',
        schema: { url: z.string() },
        run: ({ url }) => {
          const row = this.o.board.row(cardId);
          if (!row.pr) return 'Not recorded: the owner has not approved this card yet. Do not open a pull request before that.';
          const ref = parsePrUrl(String(url));
          if (!ref) return 'Not recorded: that is not the URL of a pull request (on GitHub https://github.com/<owner>/<repo>/pull/<number>, on Forgejo or Gitea such as Codeberg https://<host>/<owner>/<repo>/pulls/<number>).';
          handOver();
          const pr = { ...(JSON.parse(row.pr) as PrState), url: String(url).trim(), number: ref.number };
          this.o.board.work(cardId, { pr: JSON.stringify(pr) });
          this.o.board.log(cardId, 'state', 'worker', this.o.board.t.worker.prOpened(ref.number));
          this.o.onPrOpened?.(cardId);
          return 'Recorded. End your turn now; Obeya watches the pull request.';
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it, running the checks and making the demo. The summary (in ${language}) is what this handover tells the owner beyond what the card's conversation already holds: on your first handover, what changed from the user's point of view and what they really need to know (something left open or not verified, a decision you took for them), in a few short paragraphs at most; on a later one, only what your last handover and your replies since have not said yet, often a sentence. Obeya keeps your handovers and replies together as the card's report for whoever reads it later. A problem you noticed outside the task goes to propose_card, not into the summary. The demo: a video's directory and chapter titles in scene order, or an HTML artifact's directory, with its report (in the language of its narration); without a new one, the demo already on the card stands. Then end your turn.`,
        schema: {
          summary: z.string(),
          demo: z
            .object({
              kind: z
                .enum(['video', 'html'])
                .optional()
                .describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at, for results that are seen rather than watched happening"),
              dir: z.string().describe('absolute path of the demo: a video holds demo.mp4 and captions.vtt, an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
              question: z.string().optional().describe('only when something needs the owner beyond approve or feedback; the owner can answer it on the card before approving'),
              ...(this.shares
                ? {
                    page: z
                      .object({ title: z.string(), text: z.string() })
                      .optional()
                      .describe(
                        `required: the page on which the owner may share the demo (the video, or the HTML artifact below the text) with colleagues, in ${pageLanguage}. They know the product but have never seen Obeya, this card or the plan doc. title: what changes, in a few words; text: two to five sentences on what changes for the user and why, without findings, tests or internal process`,
                      ),
                    follows: z
                      .enum(['replaces', 'supplements'])
                      .optional()
                      .describe(
                        "when the card has a demo from an earlier handover: 'replaces' if this one shows the change afresh, so a shared page should show it instead; 'supplements' if it only shows what was corrected or explained since, to stand on the shared page beside the one before",
                      ),
                  }
                : {}),
            })
            .optional(),
        },
        run: ({ summary, demo }) => {
          type Demo = { kind?: DemoKind; dir: string; chapters?: string[]; question?: string; page?: DemoPage; follows?: 'replaces' | 'supplements' };
          const given = demo as Demo | undefined;
          const handOverWork = (d: Demo | undefined): string => {
            const s = clip(String(summary), 6000);
            const row = this.o.board.row(cardId);
            if (row.landed) return 'Not handed over: your work is on main already.';
            if (row.pr) return 'Not handed over: the work is in its pull request, where Obeya follows it.';
            // approved work that could not land comes back to be landed, not reviewed: its demo stands
            const approved = !!row.approved_at;
            // a handover in answer to the owner's words that brings no new demo is an answer to them, not a demo to watch
            const answered = !d && !!row.detail && !!(JSON.parse(row.detail) as { answering?: boolean }).answering;
            // without a new demo, the one on the card stands
            const kept = !d && !!row.demo;
            // in a folder without git the card's change list shows what changed, where often nothing can be shown on screen
            if (!d && !kept && !approved && !this.folder)
              return `Not handed over: every handover brings a demo. Record it with ${this.demoSkill(cardId)}, or make an HTML artifact when the result is something to look at, then call ready_for_review again with it.`;
            let demoJson: string | undefined;
            if (d) {
              const kind = d.kind ?? 'video';
              // what the worker says of it beside the demo before, for the owner's buttons when the page shows that one
              const report = { ...(d.question ? { question: d.question } : {}), ...(row.demo && (d.follows === 'replaces' || d.follows === 'supplements') ? { follows: d.follows } : {}) };
              const page = d.page && d.page.title.trim() && d.page.text.trim() ? { title: clip(d.page.title.trim(), 200), text: clip(d.page.text.trim(), 2000) } : undefined;
              if (this.shares && !page)
                return 'Not handed over: a demo here needs its page (title and text) for colleagues, in case the owner shares it. Call ready_for_review again with demo.page.';
              if (kind === 'html') {
                const wrong = checkArtifact(d.dir);
                if (wrong) return `Not handed over: ${wrong}. Fix the artifact, then call ready_for_review again.`;
                // an artifact that is its index.html alone also goes out as one HTML file
                const single = artifactFiles(d.dir).length === 1;
                demoJson = JSON.stringify({ kind, dir: d.dir, chapters: [], ...report, ...(page ? { page } : {}), ...(single ? { single } : {}) });
              } else {
                const chapters = readChapters(d.dir, d.chapters ?? []);
                if (typeof chapters === 'string') return `Not handed over: ${chapters}. Fix the demo, then call ready_for_review again.`;
                demoJson = JSON.stringify({ kind, dir: d.dir, chapters, ...report, ...(page ? { page } : {}) });
              }
            }
            handOver();
            const report = this.report(cardId, s);
            // the owner sees before approving where work lands that its own branch decides
            const own = this.landingOf(cardId).own;
            const e = this.o.board.log(cardId, 'review', 'worker', s);
            // the demo report's question goes with the handover it came with, also once a later one keeps the demo
            if (demoJson) demoJson = JSON.stringify({ ...(JSON.parse(demoJson) as object), handover: e.id, at: e.at });
            // the demo it replaces stays with the card, for the owner to go back to
            const demos = demoJson && row.demo ? this.earlier(cardId, row) : undefined;
            // approved work does not wait for the owner again: it stays with Obeya until its turn has ended
            this.o.board.work(cardId, {
              // the worker's last status line is about the work it hands over: it would show again once the card is at work
              ...(approved ? { status_line: this.o.board.t.worker.landing } : { state: 'waiting', need: d || kept ? 'demo' : 'review', status_line: null }),
              // approving work that changes nothing makes the card done, which the owner sees before approving
              detail: JSON.stringify({ summary: report, ...(this.o.workspaces.hasWork(cardId) ? (own ? { lands: own } : {}) : { noChange: true }), ...(answered && !approved ? { answered: true } : {}) }),
              ...(demoJson ? { demo: demoJson } : {}),
              ...(demos ? { demos } : {}),
            });
            const card = this.o.board.item(cardId);
            if (card?.prototypeOf) this.o.onPrototype?.(card, report, demoJson);
            if (approved) return 'Recorded. End your turn now; once it has ended, Obeya lands your work on main.';
            return END_TURN;
          };
          // a demo made on another machine is served and shared from its copy here
          if (given && hostName(this.o.board.row(cardId).workspace))
            return this.demoHere(cardId, given.dir).then((here) =>
              'wrong' in here
                ? `Not handed over: the demo could not be copied to the owner's machine (${here.wrong}). Check the directory, then call ready_for_review again.`
                : handOverWork({ ...given, dir: here.dir }),
            );
          return handOverWork(given);
        },
      },
      {
        name: 'close_unchanged',
        description: `After the owner approved: your work changed nothing in the repository (no commits, nothing uncommitted), because the task needed no change to the code (a demo, an analysis, an answer). Then nothing lands and there is no pull request to open: this closes the card as done instead. Then end your turn.`,
        schema: {},
        run: () => {
          const row = this.o.board.row(cardId);
          if (row.landed) return 'Not recorded: the card is finished already.';
          const pr = row.pr ? (JSON.parse(row.pr) as PrState) : null;
          if (!row.approved_at && !(pr && !pr.url)) return 'Not recorded: only work the owner approved can be closed, and only before its pull request is open. Hand it over with ready_for_review first.';
          if (this.o.workspaces.hasWork(cardId))
            return 'Not recorded: your branch holds commits or uncommitted changes. Work that changes the repository lands (or goes out as a pull request); throw away what is not meant to land first, if nothing is.';
          this.close(cardId, 'worker');
          return `Recorded: the card is done. ${AFTER_LANDING}`;
        },
      },
      {
        name: 'after_restart',
        description: 'Only after your work has landed and Obeya said it starts again for it: what remains needs Obeya to run your change. Then end your turn; Obeya tells you once it runs your change.',
        schema: {},
        run: () => {
          const l = landedOf(this.o.board.row(cardId));
          if (!l) return 'Not recorded: your work has not landed.';
          if (!l.restarts) return 'Not recorded: Obeya does not start again for this landing; what runs now is what you get.';
          this.o.board.work(cardId, { landed: JSON.stringify({ ...l, waits: true } satisfies LandedState) });
          this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.waitsForRestart);
          return 'Recorded. End your turn now.';
        },
      },
      {
        name: 'snooze',
        description: [
          `Snooze while there is nothing to do until a point in time further off than a background command can wait (a check at midnight, a test that runs for days, a report on the 31st), or until another card on this canvas gets somewhere (its fix is on main, its demo is ready).`,
          `until: that time, ISO 8601 with your timezone's offset (2026-10-31T08:00:00+01:00). card: the title of the card to wait on; state: what it is to reach, 'done' (its work is on main, or it closed without a change; the default) or 'waits_for_owner' (it asks the owner or hands its work over). Give until, card or both: Obeya wakes you at whichever comes first, and also when that card can no longer get there (stopped, archived, removed).`,
          `why: what you do then, in a few words in ${language}, shown on the card. Your session ends with your turn, and whatever you still run in the background with it; workspace and branch stay. Obeya resumes this session then, or earlier with a note from the owner or whatever else comes for you (a review, the landing). For checkpoints one after the other, snooze to the next one each time you wake. Then end your turn.`,
        ].join(' '),
        schema: { until: z.string().optional(), why: z.string(), card: z.string().optional(), state: z.enum(['done', 'waits_for_owner']).optional() },
        run: ({ until, why, card: title, state }) => {
          const card = this.o.board.item(cardId);
          if (!card) return 'Not snoozed: the card is gone.';
          if (live.handedOver) return 'Not snoozed: you asked or handed over in this turn, so the card waits for the owner.';
          if (!(card.state === 'working' || card.state === 'inPr' || card.finishing)) return 'Not snoozed: the card waits for the owner; their answer or approval comes as your next message.';
          const named = typeof until === 'string' && until.trim() !== '';
          const at = named ? Date.parse(String(until)) : NaN;
          if (named && Number.isNaN(at)) return 'Not snoozed: give the time as ISO 8601 with your timezone offset (2026-10-31T08:00:00+01:00).';
          if (named && at <= Date.now()) return `Not snoozed: that time has passed (it is ${new Date().toISOString()} now).`;
          if (named && at > Date.now() + SNOOZE_LIMIT) return 'Not snoozed: snooze for a year at most.';
          let on: Snooze['on'];
          if (typeof title === 'string' && title.trim()) {
            const found = this.cardTitled(cardId, title.trim());
            if (typeof found === 'string') return `Not snoozed: ${found}`;
            const awaits = state === 'waits_for_owner' ? 'waitsForOwner' : AWAITED_STATES[0];
            const now = awaited(found, awaits);
            if (now === 'reached') return `Not snoozed: the card “${found.title}” ${awaits === 'done' ? 'is done already' : 'waits for the owner already'}.`;
            if (now) return `Not snoozed: the card “${found.title}” cannot get there now (${now}).`;
            on = { card: found.id, title: found.title, state: awaits };
          } else if (!named) return 'Not snoozed: give until, card, or both.';
          live.snoozed = true;
          live.nudged = false;
          const s: Snooze = { ...(named ? { until: new Date(at).toISOString() } : {}), ...(on ? { on } : {}), by: 'agent', ...(String(why).trim() ? { why: clip(String(why).trim(), 200) } : {}) };
          this.o.board.snooze(cardId, s);
          return `Snoozed until ${snoozedUntil(s)}. End your turn now; Obeya resumes this session then.`;
        },
      },
      {
        name: 'app_running',
        description: `The app runs in your workspace and opens in a browser: its address as you open it (http://localhost:5173, say), so the owner can open it from the card to try it by hand while it runs. Again when the address changes; an empty url once you stop it.`,
        schema: { url: z.string() },
        run: ({ url }) => {
          const u = String(url).trim();
          if (!u) {
            this.o.board.work(cardId, { app: null });
            return 'Recorded: the card no longer offers the app.';
          }
          if (!/^https?:\/\/[^\s/]+/i.test(u)) return 'Not recorded: give the address as http(s)://host:port/….';
          this.o.board.work(cardId, { app: u });
          return 'Recorded: the card offers the app to the owner while it answers there.';
        },
      },
      ...(this.inWorktree(cardId)
        ? [
            {
              name: 'need_clone',
              description: "Only in a follow-up in a temporary worktree: answering the owner needs a full clone (the repository's app or tooling, which may not run here). Then end your turn; Obeya resumes you in the next free clone.",
              schema: {},
              run: () => {
                const l = landedOf(this.o.board.row(cardId));
                if (!l?.worktree) return 'Not recorded: you work in a full clone already.';
                this.o.board.work(cardId, { landed: JSON.stringify({ ...l, needsClone: true } satisfies LandedState) });
                this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.needsClone);
                return 'Recorded. Tell the owner with reply that you go on once a clone is free, then end your turn: Obeya resumes you in the next free clone.';
              },
            } satisfies AgentTool,
          ]
        : []),
      ...(this.o.toObeya
        ? [
            toObeyaTool((request) => {
              // what Obeya does or replies is shown to the owner as the answer to their words
              live.spoke = true;
              return this.o.toObeya!(cardId, request);
            }),
          ]
        : []),
    ]);
  }

  /**
   * The card's report for whoever reads it beyond its conversation (a follow-up's worker, the
   * Koordinator, a shared page): a later handover holds only what changed, so the first one since
   * the worker started comes with what it said in the conversation after it, its replies and later
   * handovers, `latest` last.
   */
  private report(cardId: string, latest: string): string {
    const events = this.o.board.events(cardId);
    const since = events.slice(events.findLastIndex(started) + 1).filter((e) => e.author === 'worker' && (e.kind === 'review' || e.kind === 'talk'));
    const first = since.findIndex((e) => e.kind === 'review');
    if (first < 0) return latest;
    return [since[first]!.text, this.o.board.t.worker.laterInConversation, ...since.slice(first + 1).map((e) => e.text), latest].join('\n\n');
  }

  /**
   * A tool call that needs a person's permission becomes the question the card waits on; the call
   * runs or is refused with the owner's answer. Meanwhile the worker waits for the owner as after
   * `ask`: a restart need not wait for it.
   */
  private askOwner(cardId: string, live: Live, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const asked = (live.asking ?? Promise.resolve()).then(() => this.askNow(cardId, live, request, signal));
    live.asking = asked.catch(() => {});
    return asked;
  }

  private askNow(cardId: string, live: Live, request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const asked: AskedPermission = { name: request.name, input: request.input };
    if (this.granted.get(cardId)?.delete(permissionKey(asked))) return Promise.resolve({ allow: true });
    if (this.live.get(cardId) !== live || signal.aborted) return Promise.resolve({ allow: false, message: 'This session has ended. Stop working and end your turn.' });
    const t = this.o.board.t;
    const q: Question = { text: t.worker.permission(permissionWhat(request.name, request.input, t), request.reason && clip(request.reason, 600)), options: [t.worker.allow, t.worker.deny] };
    this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
    this.wokenForOwner(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: 'question', detail: JSON.stringify({ question: q, permission: asked }) });
    this.setBusy(live, false);
    return new Promise((resolve) => {
      live.permission = (answer) => {
        live.permission = undefined;
        this.setBusy(live, true);
        resolve(answer);
      };
      // the session ended (stopped, Obeya restarting): the question stays on the card for the next one
      signal.addEventListener('abort', () => (live.permission = undefined), { once: true });
    });
  }

  /** The worker takes back one of its proposals by title, or marks it replaced (`s.by`): what became of it, as the tool's result. */
  private retract(cardId: string, title: string, s: Superseded): string {
    const r = this.o.board.retract(cardId, title, s);
    if (r.kind === 'gone' || r.kind === 'marked') this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.withdrewProposal(r.title, s.why, s.title));
    return retractedText(r, !!s.by);
  }

  private toOwner(cardId: string, q: Question) {
    this.wokenForOwner(cardId);
    this.o.board.work(cardId, { state: 'waiting', need: 'question', detail: JSON.stringify({ question: q }) });
  }

  /**
   * The card needs the owner now (its pull request closed, a tool call to allow): a snooze of its
   * worker's is over, so the card reaches them. One the owner snoozed stays paused, holding what
   * came for it meanwhile, until their answer lets it go on.
   */
  private wokenForOwner(cardId: string) {
    const s = this.o.board.snoozedOf(cardId);
    if (s && !s.waiting) this.o.board.unsnooze(cardId, 'needsYou');
  }

  private pendingQuestion(cardId: string): string | undefined {
    return this.o.board
      .events(cardId)
      .filter((e) => e.kind === 'question')
      .at(-1)?.text;
  }

  /** The owner's answer to the question `q`: in the card's log, as a decision, and for whoever learns from it. */
  private recordAnswer(card: Item, q: string, text: string, images: string[], replyTo: number | undefined, picks: string[]) {
    this.o.board.log(card.id, 'answer', 'owner', text, { images, replyTo, picks });
    this.o.board.decide({ project_id: card.parent ?? null, card_id: card.id, question: q, answer: text || '(Screenshot)', by: 'owner' });
    if (text) this.o.onOwnerInput?.(card, 'answer', text, { question: q });
    if (card.prototypeOf) this.o.onPrototypeAnswer?.(card, q, text || '(Screenshot)');
  }

  /** The card's question is settled: it goes back to its work, in its pull request, or finished (`done` when nothing landed, else `live`). */
  private backToWork(cardId: string) {
    const row = this.o.board.row(cardId);
    const landed = landedOf(row);
    this.o.board.work(cardId, { state: landed ? (landed.unchanged ? 'done' : 'live') : row.pr ? 'inPr' : 'working', need: null, detail: null });
  }

  // ---------------------------------------------------------------- prompts

  private system(preferences: string, prototype = false, card?: Item): string {
    // a task the owner wrote is their first words to the worker; one an agent or a plan doc wrote is not
    const by = card?.body.trim() ? taskAuthor(card) : undefined;
    const language = by === 'owner' ? ownersLanguage(this.o.board.conversation(), "the card's task") : `${ownersLanguage(this.o.board.conversation())}${by ? ` ${TASK_BY[by]}` : ''}`;
    const folder = !!this.folder;
    return `
You are a worker agent directed through Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. ${
      folder
        ? 'You work on exactly one card, directly in a folder that is not a git repository. Other workers may work on other cards in the same folder at the same time, and so may the owner.'
        : 'You work on exactly one card, in a workspace of the repository (a clone or worktree) that belongs to that card, on your own branch. Other workers may work on other cards at the same time in their own workspaces.'
    }

The owner does not watch you work and does not read code. They see your card's conversation: your status lines, questions, replies and handovers. Talk to them only through the Obeya tools:
- report: a short status line at milestones.
- reply: your answer to a note or feedback from the owner, in a sentence or two: what you change because of it, or why nothing.
- ask: a decision that is not yours (product behaviour, trade-offs, anything irreversible or external). Make routine judgement calls yourself. After ask, end your turn; the answer arrives as the next message.
${prototype ? '- propose_build: propose that the idea be built on your prototype, once it convinced. You make no other cards; mention other problems you noticed in your summary.' : '- propose_card: a separate problem or idea you noticed, as a card for the agent who will take it on; do not widen your task. withdraw_proposal takes back one of yours that turned out wrong.'}
- ready_for_review: ${folder ? 'the work is done' : 'the work is committed'} and the checks pass. Then end your turn.${this.o.toObeya ? '\n- to_obeya: what the owner\'s words ask of Obeya rather than you.' : ''}

${
      folder
        ? "Obeya's messages tell you what happened: feedback, an answer, a note from the owner, your changes discarded, the approval. What to do about it is yours to judge. What you change in the folder is there at once. Obeya records which files your card changed (added, changed, moved, deleted) from your tool calls; the owner sees that list on the card and may discard your changes before approving. Approving makes the card done, and Obeya tells you so; your session ends with the turn after that."
        : "Obeya's messages tell you what happened: feedback, an answer, a note from the owner, a landing that failed, your work landing. What to do about it is yours to judge. Approved work lands (or goes out as a pull request) and Obeya tells you once it is on main; your session ends with the turn after that, so whatever was waiting for the landing can still be done then. Work that changed nothing in the repository (the task needed only a demo, an analysis or an answer) lands nothing: approving it makes the card done, and Obeya tells you so the same way."
    }
${this.o.toObeya ? `\n${TO_OBEYA}\n` : ''}
Rules:
${folder ? '- Others work in the same folder at the same time: leave what your card is not about as it is.' : '- Commit your work on your branch in this workspace. Do not push, do not open pull requests, do not switch branches.'}
- Follow the repository's own instructions (CLAUDE.md and docs).
- Owner-facing text (report, reply, ask, ${prototype ? 'propose_build' : 'propose_card'}, ready_for_review) is in the owner's language, short and concrete. What you write between tool calls also shows on the card for the owner, folded under your next message: keep it brief and in the owner's language too. ${language} The docs you read do not count as the owner's words.
- ${repositoryLanguage(this.o.adapter.language, folder)} A demo (its narration, report, or an HTML artifact's words) is in the language the demo skill's settings name, whatever language the owner talks in.
- Wait for anything external (a deploy, a CI run, a process to finish) in the background: run_in_background or Monitor, then end your turn; Obeya wakes you when it finishes or fires. A point in time further off than a background command can wait (two hours), or another card getting somewhere (its fix on main), you snooze until (snooze). Never wait with sleep or a polling loop in the foreground: a note from the owner reaches you only once the running command is done.
- When a note or feedback from the owner arrives, answer it with reply. If it is unclear what they want, ask.
`.trim() + (preferences ? `\n\n${preferences}` : '');
  }

  /** The task the card's worker gets at its start, as Obeya would send it now (one that already ran goes on from its branch). */
  startBrief(card: Item): string {
    const row = this.o.board.row(card.id);
    return this.briefing(card, row.branch ?? branchName(card.title, card.id), !!row.branch);
  }

  /** The files of the screenshots the owner attached to the card's task. */
  private taskImages(card: Item): string[] {
    return this.o.imageFiles?.(card.images) ?? [];
  }

  /**
   * The demo skill as a worker hears of it: by its name in the session and, for a session that
   * does not know it, by its file, on the machine the card's workspace is on.
   */
  private demoSkill(cardId: string): string {
    const there = remote(this.o.board.row(cardId).workspace);
    const [name, file] = there ? [DEMO_SKILL, `~/${HOST_DIR}/${basename(OBEYA_PLUGIN)}/skills/demo/SKILL.md`] : [demoSkillName(), DEMO_SKILL_FILE];
    return `the demo skill (\`${name}\`; if your session does not know it, read its file ${file} and follow that)`;
  }

  private briefing(card: Item, branch: string, resumed = false): string {
    const parts = [`Your card: “${card.title}”.`];
    const idea = card.prototypeOf ? this.o.board.card(card.prototypeOf) : undefined;
    if (card.prototypeOf)
      parts.push(
        [
          `This card is a throwaway prototype for the idea “${idea?.title ?? ''}”, so the owner can see the idea before deciding on it; other prototypes may try other approaches beside it. It never lands itself: the owner either discards it (its code is thrown away, its demo stays in the archive) or has the idea built on its branch, by a worker who takes over what carries and brings it to production quality.`,
          'So build only what the demo needs to show, as quickly as you can: no tests, no polish, no docs or plan changes, and do not run the checks. Commit it on your branch anyway, so the demo can be reproduced and the idea can be built on it. The demo only needs to make the idea visible: a video of 30–60 s, or an HTML artifact when the idea is something to look at (drafts of a logo, say).',
          "Your questions and the owner's answers also reach the idea's exploration agent, so ask on this card; the idea will not ask them again.",
          idea?.idea?.brief ? `The idea as discussed so far:

${idea.idea.brief}` : '',
          mocksText(idea?.idea?.mocks),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    if (card.body.trim()) parts.push(card.body.trim());
    // the owner's own words: the language the worker writes them in until they say more (`ownersLanguage`)
    if (card.body.trim() && taskAuthor(card) === 'owner') parts.push('The owner wrote this task themselves: write to them in its language.');
    if (card.mocks?.length) parts.push(mocksText(card.mocks));
    if (card.builtOn) parts.push(this.builtOnPrototype(card.builtOn, !!card.parent));
    const from = card.from && !card.prototypeOf ? this.o.board.item(card.from) ?? this.o.board.archived().find((i) => i.id === card.from) : undefined;
    if (from) {
      const summary = this.o.board.summary(from.id)?.trim();
      parts.push(`This card follows up on the card “${from.title}”.${summary ? ` Its worker handed it over with this summary:\n\n${summary}` : ''}`);
    }
    const shots = this.taskImages(card);
    if (shots.length)
      parts.push(`${shots.length === 1 ? 'The owner attached a screenshot' : `The owner attached ${shots.length} screenshots`} to the card (shown with this message; files: ${shots.join(', ')}).`);
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (project?.plan) parts.push(`This is workstream ${card.label ?? ''} of the project “${project.title}”. Read its plan doc ${project.plan.file} first; it holds the context and decisions.`);
    const decisions = project ? this.o.board.decisions(project.id) : [];
    if (decisions.length) parts.push(`Decisions taken in this project so far:\n${decisionLog(decisions)}`);
    const part = project?.plan && this.o.board.row(card.id).shipped;
    if (part) {
      const s = JSON.parse(part) as Shipped;
      const what = [s.pr && `pull request #${s.pr.number} (${s.pr.url})`, s.commit && `commit ${s.commit.slice(0, 7)}`].filter(Boolean).join(', ');
      parts.push(
        `A part of this workstream has landed already${what ? ` (${what})` : ''}, but the plan doc keeps the workstream open. Look at what landed and do the rest.`,
      );
    }
    if (this.folder) return this.folderBriefing(card.id, parts, resumed);
    parts.push(
      card.builtOn
        ? `You are on branch ${branch}, which holds the prototype's commits (and any earlier work on this card): look at its log and diff first.`
        : resumed
          ? `You are on branch ${branch}, which already holds earlier work on this card: look at its log and diff first and go on from there.`
          : `You are on branch ${branch}, fresh from the default branch.`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the clone.`);
    const { run, stop } = this.o.adapter.app ?? {};
    const parking = stop ? ' While the card waits for the owner, Obeya stops the app in your workspace; your next message then says so.' : '';
    const far = hostName(this.o.board.row(card.id).workspace) ? " (this workspace is on another machine: Obeya forwards that address's port, and only that one, to the owner's)" : '';
    const tryIt = ` Once it runs and opens in a browser, give its address with app_running, so the owner can try it by hand from the card${far}.`;
    if (run?.trim()) parts.push(`How to run the app: ${run.trim()}${parking}${tryIt}`);
    else parts.push(`${parking}${tryIt}`.trim());
    if (this.o.adapter.checks?.length && !card.prototypeOf) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    parts.push(
      [
        `Then show the owner the result with a demo, so they can judge at a glance whether the work is done, and hand it over with ready_for_review.`,
        `Usually that is a video of the change, recorded with ${this.demoSkill(card.id)} as its instructions say (directory, chapter titles). Its length follows the size of the change, never padded: 30–60 s for a small one (a fix: the broken behaviour, then the fixed one), 1½–3 min for a larger one. Skip the skill's last steps (opening the page, the notification, the chat reply): Obeya shows the demo on the card.${this.shares ? ' The owner may share the demo, a video or an HTML artifact, with colleagues of the team on a page of its own: hand it over with that page (title, text), written for them.' : ''} ${run?.trim() ? 'Run the app for it as the recipe above says.' : "The repository's settings say nothing yet about how to run the app: find it out from the repository (README, scripts, configuration) and say in your summary how you ran it."}`,
        "When the result is something to look at rather than something that happens (drafts of a logo or a layout side by side, a comparison of variants, an analysis, an answer), make an HTML artifact instead: an index.html in a new directory under ~/demos/ (never in git), self-contained or with the files it loads beside it, made for the owner to decide on, and hand it over with kind 'html'. It shows in a sandboxed frame on the card, about 800 px wide, without Obeya's API.",
        'Where either would do, record the video: watching the work happen is what the owner enjoys most.',
      ].join(' '),
    );
    return parts.join('\n\n');
  }

  /** The end of the briefing in a folder without git: where the card works, and how it hands over without a branch. */
  private folderBriefing(cardId: string, parts: string[], resumed: boolean): string {
    const changed = this.folder!.changes(cardId).length;
    parts.push(
      `You work directly in the folder ${this.o.board.row(cardId).workspace}, which is not a git repository: what you change there is there at once, for everyone.${resumed && changed ? ` Your card changed ${changed === 1 ? 'one file' : `${changed} files`} there before; the card lists them.` : ''}`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the folder.`);
    const run = this.o.adapter.app?.run?.trim();
    if (run) parts.push(`How to run the app: ${run} Once it runs and opens in a browser, give its address with app_running, so the owner can try it by hand from the card.`);
    if (this.o.adapter.checks?.length) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    parts.push(
      [
        'Then hand it over with ready_for_review: your summary says what you did and what the owner needs to know. The card shows the owner what you changed in the folder, file by file (added, changed, moved, deleted, with the changed lines of text files), and they may discard those changes before approving.',
        `A demo is needed only where something can be seen: a draft or an overview to look at as an HTML artifact (an index.html in a new directory under ~/demos/, outside the folder, self-contained or with the files it loads beside it, made for the owner to decide on), handed over with kind 'html'; something that happens on screen as a video, recorded with ${this.demoSkill(cardId)}.`,
      ].join(' '),
    );
    return parts.join('\n\n');
  }

  /** What the worker of an idea, or of a workstream of the project it became, built on a prototype hears of it: what the branch holds, the prototype's handover and the owner's answers on it. */
  private builtOnPrototype(prototypeId: string, workstream: boolean): string {
    const prototype = this.o.board.card(prototypeId);
    const summary = this.o.board.summary(prototypeId)?.trim();
    const answers = this.o.board.decisionsOn(prototypeId);
    return [
      `The owner chose to build this ${workstream ? 'workstream' : 'idea'} on the prototype “${prototype?.title ?? ''}”${workstream ? `, one of those built for the idea the project came from` : ''}, and your branch is that prototype's. It is a throwaway prototype: built quickly to show the idea, without tests, polish or docs, with shortcuts. Take over what carries and bring it to production quality: tests, the repository's checks, the design doc and other docs, shortcuts removed. Rewrite or drop what does not hold up; nothing on the branch counts as reviewed code. The task is ${workstream ? 'the workstream as its plan doc describes it' : "the idea's brief above"}; the prototype is a means to it, not the result.`,
      summary ? `The prototype's worker handed it over with this summary:\n\n${summary}` : '',
      answers.length ? `What the owner answered on the prototype:\n${answers.map((d) => `- ${d.question} → ${d.answer}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private card(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    return i;
  }
}

/** The mocks of an idea's brief as a worker reads them, after the brief they belong to. */
function mocksText(mocks: Mock[] | undefined): string {
  if (!mocks?.length) return '';
  return ['Mocks of the brief, as the owner saw them rendered (how its variants look):', ...mocks.map((m) => `${m.title || 'Mock'}:\n\n\`\`\`html\n${m.html}\n\`\`\``)].join('\n\n');
}

/** One log line for a built-in tool call. */
export function describeTool(name: string, input: Record<string, unknown>, t: Messages): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = (k: string) => s(k).split('/').slice(-2).join('/');
  switch (name) {
    case 'Read':
      return t.tool.read(file('file_path'));
    case 'Edit':
    case 'MultiEdit':
      return t.tool.edit(file('file_path'));
    case 'Write':
      return t.tool.write(file('file_path'));
    case 'Bash':
      return `$ ${clip(s('command').split('\n')[0]!, 120)}`;
    case 'Grep':
      return t.tool.grep(clip(s('pattern'), 60));
    case 'Glob':
      return t.tool.glob(clip(s('pattern'), 60));
    case 'TodoWrite':
      return t.tool.todo;
    case 'Task':
    case 'Agent':
      return `Subagent: ${clip(s('description'), 80)}`;
    default:
      return name;
  }
}

/** What a tool call that needs the owner's permission does, as the question shows it: a command whole, line by line as code, else its log line or its input. */
export function permissionWhat(name: string, input: Record<string, unknown>, t: Messages): string {
  if (name === 'Bash' && typeof input.command === 'string') return code(clip(input.command, 4000));
  const line = describeTool(name, input, t);
  return line === name ? `${name}: ${code(clip(JSON.stringify(input), 2000))}` : line;
}

/** Each line as inline code (a line that holds a backtick as it is): the card renders no code blocks. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (l.includes('`') ? l : `\`${l}\``))
    .join('\n');

const permissionKey = (p: AskedPermission) => JSON.stringify([p.name, p.input]);

