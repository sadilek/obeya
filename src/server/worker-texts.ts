// What a card's worker hears from Obeya: the messages and the text builders that read no state of
// their own, for the `Workers` that send them.

import { mmss } from '../../plugin/skills/demo/lib/timeline.ts';
import { MESSAGES, type Messages } from '../core/messages';
import { clip } from '../core/text';
import { failureReason } from './runtime';
import type { Awaited, RestartReason, Snooze, Spot } from '../core/types';
import { ownWords } from '../core/card';
import type { DueRestart } from './workers';

/** Where in the demo video the owner's words are, as the worker reads it above them. */
export const spotNote = (spot: Spot) => {
  return `[${spot.earlier ? 'Earlier demo video, one a later handover of yours replaced,' : 'Demo video'} at ${mmss(spot.at)}${spot.chapter ? `, chapter “${spot.chapter}”` : ''}${spot.narration ? `, narration: “${spot.narration}”` : ''}]`;
};

/** How the worker hears that its approved work could not land for something that is not its own to fix. */
export const NOT_LANDED = 'Since you handed over, the owner approved your work, but Obeya could not land it on main:';

/** An answer as the worker reads it: the options the owner picked, apart from the words they added. */
export function answerNote(picks: string[], text: string): string {
  if (!picks.length) return text;
  const words = ownWords({ text, picks });
  return `They picked ${picks.map((o) => `“${o}”`).join(', ')}.${words ? `\n\nThey added in their own words:\n\n${words}` : ''}`;
}

export const hostResumed = (host: string) =>
  `The connection to ${host}, the machine your workspace is on, dropped, and your session ended with it. Whatever you had running there may have been stopped with it: background commands, servers you started, and a command still running in your turn. Run again what you still need, and go on from there.`;

/** What a restart stopped of the worker's, and how it goes on: the tail of `RESTARTED` and `REPO_RESTARTED`. */
const AFTER_RESTARTED =
  'Whatever you had running then was stopped with it: background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need. If you had paused for the restart, go on from there.';

export const RESTARTED = `Obeya was restarted. ${AFTER_RESTARTED}`;

export const REPO_RESTARTED = `Obeya restarted this repository's agents to apply a change to its configuration. ${AFTER_RESTARTED}`;

/** What a landed worker that waited for Obeya to run its change hears once it does. */
export const RUNS_YOUR_CHANGE = 'Obeya has started again and runs main with your change now.';

const DUE_WHY: Record<RestartReason, string> = {
  code: 'restart (new code landed on main)',
  config: 'restart (the owner saved a new configuration)',
  repository: "restart (a repository's settings changed on its default branch)",
  stop: 'stop (the owner is shutting it down)',
  update: 'restart (the owner installs a new version of the app)',
  takeover: 'restart (the app takes over this Obeya, which ran without it)',
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
export const restartNotice = (due: DueRestart) =>
  `${dueOpening(due)}. Pause at the next safe point: finish the step you are in, start nothing long (a test run, a demo render, a measurement), and end your turn, without handing over if you are not done. Background commands still running keep Obeya waiting: let those you need finish, stop the others (a scratch server you can start again). One that finishes before the restart wakes you for a turn that keeps Obeya waiting too: take in its result and end that turn as well. Obeya resumes you ${dueText(due).back}, and you go on from there.`;

/**
 * Tells a worker whose turn a message starts while a restart is due (a conflict after an approval,
 * an answer, a card started) that the turn keeps Obeya waiting: it takes the message in and leaves
 * what it asks for until Obeya resumes it, instead of judging a step short enough to do first.
 */
export const restartWaits = (due: DueRestart) =>
  `${dueOpening(due)}, and this turn keeps it waiting. Take in this message, leave the work it asks for until Obeya resumes you, and end your turn, without handing over. Obeya resumes you ${dueText(due).back}, and you do that work then.`;

/** Tells a worker that paused for a restart that then did not happen that it goes on now. */
export const RESTART_OFF = 'The restart you paused for is off: nothing was stopped. Go on from where you paused.';

/** Tells a worker that paused for the restart, and was woken before it (by its background work, a message), that Obeya still waits for it. */
export const stillDue = (due: DueRestart) =>
  `Obeya still waits for the ${dueText(due).thing} you paused for, ${minutesLeft(due)}, and this turn keeps it waiting. Take in what started it (a background command that finished, a message), leave the work it leads to until Obeya resumes you, and end your turn.`;


/** Tells a worker that the owner pauses it, so that it brings its work to a safe point first instead of being cut off. */
export const pauseNotice = (limit: number) => {
  const minutes = Math.max(1, Math.round(limit / 60_000));
  return `The owner pauses you now: they want you to stop for the time being, at a safe point rather than in the middle of a step. Finish the step you are in, start nothing long (a test run, a demo render, a measurement), and end your turn, without handing over if you are not done. Stop the background commands still running (a scratch server you can start again): one you let finish keeps the owner waiting. Obeya pauses you wherever you are after at most ${minutes} minute${minutes === 1 ? '' : 's'}. Pausing ends your session; once the owner lets you go on, you go on from there.`;
};

/** Tells a worker that paused for the owner, and was woken by its background work before it could, that they still wait for it. */
export const PAUSE_STILL =
  'The owner still waits for you to pause, and this turn keeps them waiting. Take in what started it (a background command that finished), leave the work it leads to until the owner lets you go on, and end your turn.';

/** Tells a worker about to pause at a safe point that the owner let it go on after all. */
export const PAUSE_TAKEN_BACK = 'The owner no longer wants you to pause: go on with your work.';

/** What the owner's pause or snooze (`how`) stopped of the worker's at once, and how it goes on. */
const cutOff = (how: 'Pausing' | 'Snoozing') =>
  `${how} ended your session at once: whatever you had running was stopped with it, background commands, servers you started, and a command still running in your turn (its result shows exit code 137). Run again what you still need, and go on where you stopped.`;

export const RESUMED = `The owner paused you and has now let you go on. ${cutOff('Pausing')}`;

/** Until when a worker snoozed, as it hears it: a time, or the card it waits on (and the time at the latest). */
export function snoozedUntil(s: Snooze): string {
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
export function wokeNote(s: Snooze, timeUp: boolean, owner: boolean, words: boolean, met?: Awaited): string {
  const now = MESSAGES.en.at(Date.now());
  const until = snoozedUntil(s);
  const why = s.why ? `, to: ${s.why}` : '';
  const ended =
    s.by === 'agent'
      ? 'Your session ended when you snoozed, and whatever still ran in the background then was stopped with it. Run again what you still need.'
      : cutOff('Snoozing');
  if (met && s.on) return `${metNote(s.on, met)} You snoozed until ${until}${why}. ${ended}`;
  if (timeUp) {
    const yet = s.on ? ` The card “${s.on.title}” has not got there yet.` : '';
    return `${s.by === 'owner' ? `The owner snoozed you until ${until}, and it is that time now.` : s.moved ? `It is now ${now}: you snoozed${why}, and the owner moved the time to now.` : s.on ? `It is now ${now}: you snoozed until ${until}${why}.` : `It is now ${now}, the time you snoozed until${why}.`}${yet} ${ended}`;
  }
  const who = s.by === 'owner' ? `The owner snoozed you until ${until}` : s.moved ? `You snoozed${why}, and the owner moved the time to ${MESSAGES.en.at(Date.parse(s.until!))}` : `You snoozed until ${until}${why}`;
  const early = owner ? (words ? 'the owner wakes you early' : 'the owner wakes you early, without words, so tell them with reply where things stand') : 'what follows wakes you early';
  return `${who}; it is now ${now}, and ${early}. ${ended}${s.by === 'agent' ? ' Once you have dealt with it, snooze again if there is still nothing to do until then.' : ''}`;
}

export const AFTER_RESTART = 'If something that remains needs Obeya to run your change, call after_restart and end your turn: Obeya tells you once it runs it.';

export const AFTER_LANDING =
  'Your workspace and this session stay until you end a turn with nothing left to wait for (a question, the restart); then both end. Commits you make here no longer land.';

export const AFTER_DONE = 'This session stays until you end a turn with nothing left to wait for (a question, say); then it ends.';

export const FOLLOW_UP_FOLDER =
  "Answer with reply (ask, for a decision that is the owner's). What you change in the folder now counts as this card's, as before, but can no longer be undone from the card: a change the owner's words call for that is more than a small correction becomes a card of its own (propose_card). The session ends once you end a turn with nothing left to wait for.";

export const FOLLOW_UP =
  "Answer with reply (ask, for a decision that is the owner's). Commits you make here do not land: a change to the code the owner's words call for becomes a card of its own (propose_card). Workspace and session end once you end a turn with nothing left to wait for.";

export const IN_WORKTREE =
  "No clone of the repository was free, so this is a temporary worktree, where the repository's app and tooling may not run. If answering needs a full clone, call need_clone and end your turn: Obeya resumes you in the next free clone.";

/** Where the worker of landed work links its demo's page. */
export const LINK_DEMO = 'Link it wherever you point people at this work (an issue you close, say).';

/** What the worker of landed work does where its demo is on no page the team can open. */
export const ASK_FOR_LINK = 'Before you point anyone to your demo (an issue you close, say), ask the owner for a link.';

/** The error a worker's turn failed with, as the owner and the worker read it. */
export const failureText = (failed: string, t: Messages) => failureReason(clip(failed, 1200), t);

/** A text that ends a sentence, with a full stop where it has no closing mark of its own. */
export const sentence = (text: string) => `${text}${/[.!?]$/.test(text) ? '' : '.'}`;

/** What a tool of a session that has ended (stopped, replaced) answers: the call changed nothing. */
export const SESSION_ENDED = 'This session has ended. Stop working and end your turn.';

/** The branch where a worker makes the merge of its pull request into the fork's main branch `into` itself, after Obeya's merge conflicted. */
export const mergeBranch = (branch: string, into: string) => `${branch}-into-${into}`;

/**
 * How the worker of a fork's card resolves a merge into the main branch `into` that conflicted
 * (`what`: the card's branch, or the pull request's head): on a branch of its own, so that its
 * pull request's branch carries nothing of `into`.
 */
export const mergeConflictHelp = (branch: string, into: string, resolved: string, what: string) =>
  `Make that merge yourself, never on ${branch} itself: the pull request's branch must carry nothing of ${into}. In your workspace, git switch -c ${resolved} ${into} (in a clone, from origin's ${into} or as Obeya's checkout has it: git fetch <path of the Obeya checkout> ${into}), git merge ${what === 'your branch' ? branch : what}, resolve the conflicts, run the checks, commit, then git switch ${branch} again. Obeya takes ${resolved} as the merge from there (it fast-forwards ${into} to it, or merges it where ${into} moved on meanwhile).`;
