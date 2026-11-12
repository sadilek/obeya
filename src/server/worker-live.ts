// A worker's session as Obeya follows it, for the `Workers` that run it and the tools it calls.

import type { BackgroundTask } from '../core/types';
import type { AgentSession, BackgroundWait, PermissionAnswer } from './runtime';

/**
 * A background task of the worker as Obeya follows it: whether it runs since an earlier turn, and
 * whether it serves the app the worker said runs, which wakes nobody: the worker waits for no app.
 */
export interface RunningTask extends BackgroundTask {
  earlier?: true;
  app?: true;
}

/**
 * The worker said its app runs (or no longer does). The work it started in this turn and runs now
 * serves it (the dev server it started, then checked); work from an earlier turn (a test run it
 * waits for) does not. The SDK links no task to the app, so this is what tells the two apart.
 */
export function appRunning(live: Live, url: string) {
  // an address app_running refuses changes nothing
  if (url && !APP_URL.test(url)) return;
  for (const t of live.tasks.values()) {
    if (!url) delete t.app;
    else if (!t.earlier) t.app = true;
  }
}

/** An app's address as app_running takes it. */
export const APP_URL = /^https?:\/\/[^\s/]+/i;

/** Whether all the worker's background work that runs serves its app. */
export function onlyApp(live: Live): boolean {
  return live.tasks.size > 0 && [...live.tasks.values()].every((t) => t.app);
}

/** A session's state as it starts, with what differs between sessions. */
export const newLive = (o: Pick<Live, 'host' | 'acted' | 'busy' | 'work' | 'preferences'> & Partial<Live>): Live => ({
  session: undefined!,
  handedOver: false,
  nudged: false,
  lastText: '',
  tasks: new Map(),
  stalled: false,
  ...o,
});

export interface Live {
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
  /** Whether the session said or did anything since it started: one that ends by itself after that has a conversation worth resuming. */
  ran?: boolean;
  nudged: boolean;
  /**
   * The last of Obeya's tools that refused the worker's call, with its words, until the same tool
   * takes a call: the nudge at the turn's end repeats them, for a worker that never read them.
   */
  refused?: { tool: string; text: string };
  lastText: string;
  /** The error the worker's last turn failed with (not logged in, say); gone once it says or does something. */
  failed?: string;
  /** Between a message and the end of the turn it starts: a restart now would cut the worker off. */
  busy: boolean;
  /**
   * An ended turn waiting for the worker's background work to wake it (`waiting`), and how many of
   * its background tasks run, as the session last said (`running`).
   */
  work: BackgroundWait;
  /** Set while the worker waits for a usage limit to lift: it then goes on where it stopped. */
  lifts?: ReturnType<typeof setTimeout>;
  /** Those tasks by the session's id, as the agent described them and since when Obeya saw them run, the oldest first: on the card while they run. */
  tasks: Map<string, RunningTask>;
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
  /** The worker ended a turn for the owner's pause at a safe point while its background work runs on: a turn that work starts hears that the owner still waits. */
  pauseHeld?: boolean;
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
