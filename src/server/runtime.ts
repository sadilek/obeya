// Agent sessions behind a small interface, so the orchestration can be tested without a model: the
// contract every runtime fills (Claude Code's in claude.ts, Codex's in codex.ts), the decorators that
// wrap any of them, and what both runtimes share.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { remote, type SshHost } from './hosts';
import type { z } from 'zod';
import { filesIn } from './files';
import { OWN_GROUP } from './spawn';
import type { Messages } from '../core/messages';
import type { ToolWatch } from './folder';
import { agentDefault, type AgentEffort, type AgentRole, type AgentSetting, type CardAgent, type Harness, storedModel } from '../core/types';
import { messageOf } from '../core/text';
import { claudeLoginFailed, codexLoginLost } from '../core/login';

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Returns the text the agent sees as the tool result. */
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export type AgentEvent =
  /** The session's id, once it started or resumed, and the model it runs on as the harness names it, where it says. */
  | { type: 'session'; id: string; model?: string; effort?: AgentEffort }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  /**
   * A tool call was refused without anyone being asked: by a rule of the settings, auto mode's
   * classifier, the permission mode, a hook (`obeya`: Obeya's own, `refuseForegroundWait`).
   * `reason`: the deciding component's own words, when it gave any.
   */
  | { type: 'denied'; name: string; input: Record<string, unknown>; by: DeniedBy; reason?: string }
  /**
   * The turn ended; the session waits for the next message. `background` counts the agent's
   * background tasks still running: when one ends, the session wakes itself for a new turn.
   * `more`: a message sent during the turn came too late for it and starts a turn of its own,
   * which follows without another message.
   */
  | { type: 'idle'; background?: number; more?: boolean }
  /**
   * What the session cost so far in US dollars, as its harness estimates it at API list prices
   * (Claude Code's own estimate; Codex's tokens at `codexCost`'s), after each of its turns: a running
   * total, which a resumed session goes on from where its harness kept it. `withSpend` takes it.
   */
  | { type: 'spend'; session: string; usd: number }
  /**
   * The agent's background tasks still running changed, in a turn or between turns: a deploy
   * watcher that ends, say, which then wakes the session. `tasks`: all that run now, by the SDK's id.
   */
  | { type: 'background'; tasks: { id: string; description: string }[] }
  /**
   * The session's machine is out of reach (a worker on an SSH host whose connection failed or
   * dropped): the session has ended, and resumes by its id once the host answers again.
   */
  | { type: 'lost'; message: string }
  /**
   * The turn failed. `limit` when the account's usage limit stopped it (the five-hour session
   * limit, say): it lifts again at `resetsAt` (milliseconds) when the API said when. `token` when
   * the session signed in with a token rather than this machine's account (`CardEvent.token`).
   */
  | { type: 'error'; message: string; limit?: { resetsAt?: number }; token?: true };

/** Who refused a tool call (`SDKPermissionDeniedMessage.decision_reason_type`, sorted). */
export type DeniedBy = 'rule' | 'classifier' | 'mode' | 'hook' | 'obeya' | 'other';

/** A tool call the settings want a person to confirm (an `ask` rule, a safety check). */
export interface PermissionRequest {
  name: string;
  input: Record<string, unknown>;
  /** Why it is asked, when Claude Code says. */
  reason?: string;
}

export type PermissionAnswer = { allow: true } | { allow: false; message: string };

export interface AgentSpec {
  /** Where the agent works; a workspace on another machine (`ssh://<host>/…`) runs it there (`hosts.ts`). */
  cwd: string;
  /** Appended to the default system prompt. */
  system: string;
  /** Tools the agent reaches as `mcp__obeya__<name>`. */
  tools: AgentTool[];
  /** Resume this session instead of starting one. */
  resume?: string;
  /** Directories outside `cwd` the agent works in as in its own (a looked-up thread's output directory). */
  dirs?: string[];
  /** Read-only agents get no tools that change files or run commands. */
  readOnly?: boolean;
  /**
   * The repository's own Claude Code settings in `cwd` wait for the owner to confirm them
   * (`withRepoTrust`): the session reads the user's settings alone, none of the repository's.
   */
  untrusted?: boolean;
  /** Directories of local Claude Code plugins loaded into the session (skills, mainly). */
  plugins?: string[];
  permissionMode?: PermissionMode;
  /** Added to the agent's environment (Obeya's own, cleaned). */
  env?: Record<string, string>;
  /** How much the model thinks; low for quick, small jobs. */
  effort?: AgentEffort;
  /** The model, when not the default: a smaller one for small, frequent jobs; for Codex a family, its newest model on the machine the agent runs on. */
  model?: string;
  /** The group the agent belongs to, whose harness, model and effort the owner chooses (`withAgentSetting`). */
  role?: AgentRole;
  /** The harness, model and effort the owner chose for this one agent (a card's), over its group's where it names them. */
  agent?: CardAgent;
  /** The card the agent works for (a worker's, an idea's, a project's): its cost counts to that card; without one, to the canvas alone (`withSpend`). */
  spendOn?: string;
  /** The harness it runs on (`byHarness`): Claude Code where none is named. */
  harness?: Harness;
  /**
   * Asked after every tool step of the agent's own (not a subagent's): what changed since the
   * session's instructions were built, or what waited for its next step, for the agent to read with
   * that step's result without being stopped; nothing when nothing did. Asking takes it: it is read.
   */
  contextUpdate?: () => string | undefined;
  /**
   * Told before and after each tool call of the agent and its subagents, and waited for: what a
   * call changes in a folder without git becomes the card's (`FolderWorkspaces.watch`).
   */
  watch?: ToolWatch;
  /**
   * Asked when a tool call needs a person's permission; settles with their answer. Without it such a
   * call is refused, as in any session without someone to ask.
   */
  askOwner?: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
  /**
   * The agent waits for the account's usage limit instead of failing on it (`withLimitWait`): a turn
   * the limit stops is neither an error nor over, and this hears when the agent goes on by itself,
   * and nothing once it does or its session ends. Without it, the turn fails with the error's `limit`.
   */
  onLimit?: (until: number | undefined) => void;
  onEvent: (e: AgentEvent) => void;
}

export interface AgentSession {
  /** Sends a user message, with images (files) after the text; the session takes it at the next opportunity. */
  send(text: string, images?: string[]): void;
  /** Ends the session after the current step. */
  close(): void;
  /** Settles when the session has ended. */
  done: Promise<void>;
}

export interface AgentRuntime {
  /** Without a first message the agent starts up and waits, so a later `send` skips the start-up. */
  start(spec: AgentSpec, firstMessage?: string, images?: string[]): AgentSession;
}

/** A Codex thread's id as Obeya keeps it for a session (`AgentEvent` `session`), told apart from a Claude Code session's. */
export const CODEX_SESSION = 'codex:';

/** The harness a kept session runs on: Codex's threads carry their mark (`CODEX_SESSION`). */
export const sessionHarness = (session: string): Harness => (session.startsWith(CODEX_SESSION) ? 'codex' : 'claude');

/**
 * A runtime that starts each agent of a group on its group's harness, model and effort
 * (`agentSetting`), asked at every start, or on the harness and model and the effort chosen for that
 * agent alone (a card's), each where it names one. Claude Code's default model is no model given;
 * a Codex agent always gets a family (`codexFamily`), which its session resolves to a model. A session
 * resumed stays on the harness it began on, with that harness's preset model if the choice has
 * moved on since, so a card goes on with its conversation.
 */
export function withAgentSetting(runtime: AgentRuntime, setting: (role: AgentRole) => AgentSetting): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      if (!spec.role) return runtime.start(spec, firstMessage, images);
      const group = setting(spec.role);
      const own = spec.agent;
      const chosen: AgentSetting = { ...group, ...(own?.harness && own.model ? { harness: own.harness, model: own.model } : {}), ...(own?.effort ? { effort: own.effort } : {}) };
      const on: Harness = spec.resume ? sessionHarness(spec.resume) : chosen.harness;
      const { harness, model, effort } = on === chosen.harness ? chosen : { ...agentDefault(spec.role, on), effort: chosen.effort };
      const { model: _, agent: __, ...rest } = spec;
      const given = storedModel(harness, model);
      return runtime.start({ ...rest, harness, effort, ...(given === 'default' ? {} : { model: given }) }, firstMessage, images);
    },
  };
}

/**
 * A runtime whose agents' costs go to `record` (`spend` events, which the agent's own handler never
 * hears): by the card each works for (`AgentSpec.spendOn`), else as the canvas's own.
 */
export function withSpend(runtime: AgentRuntime, record: (card: string | undefined, session: string, usd: number) => void): AgentRuntime {
  return {
    start: (spec, firstMessage, images) =>
      runtime.start({ ...spec, onEvent: (e) => (e.type === 'spend' ? record(spec.spendOn, e.session, e.usd) : spec.onEvent(e)) }, firstMessage, images),
  };
}

/** A runtime that starts each agent on the harness its spec names (`withAgentSetting`), else the one of the session it resumes, else Claude Code. */
export function byHarness(runtimes: Record<Harness, AgentRuntime>): AgentRuntime {
  return { start: (spec, firstMessage, images) => runtimes[spec.harness ?? (spec.resume ? sessionHarness(spec.resume) : 'claude')].start(spec, firstMessage, images) };
}

/**
 * A runtime that starts each agent working in a repository whose own Claude Code settings wait for
 * the owner's confirmation (`untrusted`, by the agent's `cwd`) without them: their hooks, MCP
 * servers and helpers would run outside the permission checks. Claude Code then reads none of the
 * repository's files, its CLAUDE.md neither, so the agent gets that in its instructions instead.
 * Where finding that out takes git, the agent starts once git has answered (`startingLater`): the
 * server does not wait for it.
 */
export function withRepoTrust(runtime: AgentRuntime, untrusted: (cwd: string) => boolean | Promise<boolean>): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      // one already started without them (a review card's) brings its notes from elsewhere
      if (spec.untrusted) return runtime.start(spec, firstMessage, images);
      const start = (held: boolean) => {
        if (!held) return runtime.start(spec, firstMessage, images);
        const file = join(spec.cwd, 'CLAUDE.md');
        const notes = !remote(spec.cwd) && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
        const system = notes ? `${spec.system}\n\nThe repository's CLAUDE.md:\n\n${notes}` : spec.system;
        return runtime.start({ ...spec, untrusted: true, system }, firstMessage, images);
      };
      const held = untrusted(spec.cwd);
      if (typeof held === 'boolean') return start(held);
      // where it cannot be told, the repository's settings are not read
      return startingLater(
        held.catch(() => true).then((h) => () => start(h)),
        spec,
      );
    },
  };
}

/**
 * A session that starts once `starting` settles with how to start it: what it is sent meanwhile
 * reaches it then. Closed before, it never starts. One that fails to start ends with the error.
 */
export function startingLater(starting: Promise<() => AgentSession>, spec: AgentSpec): AgentSession {
  let session: AgentSession | undefined;
  let closed = false;
  const waiting: { text: string; images?: string[] }[] = [];
  const done = starting.then(async (start) => {
    if (closed) return;
    try {
      session = start();
    } catch (e) {
      spec.onEvent({ type: 'error', message: messageOf(e) });
      return;
    }
    for (const m of waiting.splice(0)) session.send(m.text, m.images);
    await session.done;
  });
  return {
    send: (text, images) => (session ? session.send(text, images) : void waiting.push({ text, images })),
    close: () => {
      closed = true;
      session?.close();
    },
    done,
  };
}

/** What an agent the usage limit stopped is told once it lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped your last turn has reset. Go on where you stopped.';

/** For an agent that waits for the usage limit with nowhere to show it (`AgentSpec.onLimit`): nobody waits for its result. */
export const waitQuietly = () => {};

/**
 * A runtime whose agents with `onLimit` wait for the account's usage limit: the turn it stopped
 * waits, without its error and its end, and `margin` after the limit lifts (`limitLifts`) the
 * session is told to go on where it stopped; one that runs into the limit again waits anew.
 */
export function withLimitWait(runtime: AgentRuntime, margin = 10_000): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      const onLimit = spec.onLimit;
      if (!onLimit) return runtime.start(spec, firstMessage, images);
      let lifts: ReturnType<typeof setTimeout> | undefined;
      // the end of the turn the limit stopped is not the end of its work
      let stopped = false;
      let closed = false;
      const session: AgentSession = runtime.start(
        {
          ...spec,
          onEvent: (e) => {
            if (e.type === 'error' && e.limit) {
              stopped = true;
              if (closed) return;
              const until = limitLifts(e.limit, margin);
              clearTimeout(lifts);
              // a timer runs at most about 24 days
              lifts = setTimeout(
                () => {
                  lifts = undefined;
                  onLimit(undefined);
                  session.send(LIMIT_LIFTED);
                },
                Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1),
              );
              onLimit(until);
            } else if (e.type === 'idle' && stopped) stopped = false;
            else spec.onEvent(e);
          },
        },
        firstMessage,
        images,
      );
      return {
        send: (text, images) => session.send(text, images),
        close: () => {
          closed = true;
          if (lifts) onLimit(undefined);
          clearTimeout(lifts);
          lifts = undefined;
          session.close();
        },
        done: session.done,
      };
    },
  };
}

/**
 * How long an agent waits before its process goes (`withRest`): past the longest prompt-cache
 * lifetime Claude Code uses (an hour, on a subscription; measured 2026-11-09), with a margin for the
 * time between the turn's last request and its end. Codex too: its cache has no fixed lifetime (hits
 * after four hours and misses after two, measured 2026-11-09), and a resumed Codex session reads it
 * as well as the process kept would have.
 */
export const REST_AFTER_MS = 65 * 60_000;

/**
 * A runtime whose sessions give up their process once they have waited `after` with nothing running
 * (their turn over, no background work), so a session waiting for the owner holds no memory. The
 * next message resumes the session by its id, as after a restart: its callers see one session
 * throughout. The resumed session pays for its conversation what the process kept would have paid
 * then: `after` lies past Claude Code's prompt-cache lifetime, so its cache is gone either way, and
 * Codex's is read by a resumed session as by a kept one.
 */
export function withRest(runtime: AgentRuntime, after = REST_AFTER_MS): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      let id = spec.resume;
      let session: AgentSession | undefined;
      // which process's events count: one given up says nothing more
      let generation = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      // the process given up last, which a resumed one waits for, so two never run on one session
      let gone: Promise<void> = Promise.resolve();
      // its turn is over, and no other follows by itself
      let waiting = false;
      let ended!: () => void;
      const done = new Promise<void>((r) => (ended = r));
      const rest = () => {
        timer = undefined;
        if (!session || !id || closed) return;
        const resting = session;
        session = undefined;
        generation++;
        resting.close();
        gone = resting.done;
      };
      const begin = (text?: string, given?: string[]) => {
        const mine = ++generation;
        const resumed: AgentSpec = {
            ...spec,
            ...(id ? { resume: id } : {}),
            onEvent: (e) => {
              if (mine !== generation) return;
              clearTimeout(timer);
              timer = undefined;
              if (e.type === 'session') id = e.id;
              if (e.type === 'idle') waiting = !e.more;
              else if (e.type !== 'background') waiting = false;
              // waiting with nothing of its own running: the next message may be long in coming
              if (waiting && (e.type === 'idle' ? !e.background : e.type === 'background' && !e.tasks.length)) timer = setTimeout(rest, after);
              spec.onEvent(e);
            },
        };
        const s = mine === 1 ? runtime.start(resumed, text, given) : startingLater(gone.then(() => () => runtime.start(resumed, text, given)), resumed);
        session = s;
        void s.done.then(() => {
          // a process given up for rest has not ended the session
          if (mine !== generation) return;
          clearTimeout(timer);
          session = undefined;
          ended();
        });
      };
      begin(firstMessage, images);
      return {
        send(text, given) {
          if (closed) return;
          clearTimeout(timer);
          timer = undefined;
          waiting = false;
          if (session) session.send(text, given);
          else begin(text, given);
        },
        close() {
          closed = true;
          clearTimeout(timer);
          if (session) session.close();
          else ended();
        },
        done,
      };
    },
  };
}

/** Claude Code and Codex processes started on this machine that still run. */
const here = new Set<ChildProcess>();

/** Counts a process among the agents' that `endAgentsHere` ends as Obeya stops. */
export function trackHere(p: ChildProcess) {
  here.add(p);
  p.once('exit', () => here.delete(p));
}

/** A session's error with what Claude Code said last on stderr, unless the error names it already. */
export function withStderr(message: string, stderr: string): string {
  const tail = stderr.trim();
  return tail && !message.includes(tail) ? `${message}. stderr: ${tail}` : message;
}

/**
 * Ends the Claude Code processes started on this machine, and what each runs, as Obeya stops: once
 * they paused for it, or at once when the owner would not wait. Without a terminal's Ctrl-C reaching
 * them, they would otherwise go on with a turn that nobody hears any more. Not on Windows, where they
 * stay in the console (`OWN_GROUP`) and a kill would end them at once, before they end what they run:
 * there they end as before, with their stdin.
 */
export function endAgentsHere() {
  if (!OWN_GROUP) return;
  for (const p of here) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGTERM');
    } catch {
      // gone already
    }
  }
}

/** A usage limit that does not say when it lifts is tried again after this. */
const LIMIT_RETRY = 15 * 60_000;
/** A usage limit that should have lifted already is tried again after this. */
const LIMIT_AGAIN = 60_000;

/** When to go on after the usage limit stopped a turn: `margin` after it lifts, so that clocks a little apart do not matter. */
export function limitLifts(limit: { resetsAt?: number }, margin: number, now = Date.now()): number {
  const reset = limit.resetsAt;
  return !reset ? now + LIMIT_RETRY : reset > now ? reset + margin : now + LIMIT_AGAIN;
}

/** A session's failure in the owner's words. */
export function failureReason(message: string, t: Messages): string {
  if (claudeLoginFailed(message)) return t.failure.notLoggedIn;
  const codex = codexLoginLost(message);
  if (codex) return t.failure.codexNotLoggedIn(codex.host);
  return t.failure.session(message);
}

/** Background work that ended wakes the agent within this; a turn that waits longer without a sign counts as ended. */
export const BACKGROUND_GRACE = 10 * 60_000;
/**
 * Background work ends by its own limit well within this (a command run in the background after two
 * hours at most, a watcher after half an hour): it is only for a session that never says the work ended.
 */
export const BACKGROUND_LIMIT = 3 * 60 * 60_000;

/**
 * A turn of an agent that answers the owner (an idea's, a look-up's) that ended while its background
 * work runs: that work wakes the agent when it ends, so the turn waits for it, and the owner's words
 * meanwhile go into the session at once. Without a sign of the agent for a long while
 * (BACKGROUND_LIMIT while the work runs, BACKGROUND_GRACE after it ended), `over` ends the turn.
 */
export class BackgroundWait {
  /** How many of the agent's background tasks run, as the session last said. */
  running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private over: () => void,
    private limits: { grace?: number; limit?: number } = {},
    /** The turn starts or stops waiting. */
    private onChange?: (waiting: boolean) => void,
  ) {}

  get waiting(): boolean {
    return this.timer !== undefined;
  }

  /** The turn ended: it waits for the agent's background work to wake it. */
  start() {
    const was = this.waiting;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.onChange?.(false);
        this.over();
      },
      this.running > 0 ? (this.limits.limit ?? BACKGROUND_LIMIT) : (this.limits.grace ?? BACKGROUND_GRACE),
    );
    if (!was) this.onChange?.(true);
  }

  /** The agent's background work started or ended: a turn waiting for it waits as long as it runs. */
  changed(running: number) {
    this.running = running;
    if (this.waiting) this.start();
  }

  /** The agent goes on (a message, its work woke it), or its session ends: the turn waits no more. */
  stop() {
    if (!this.waiting) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onChange?.(false);
  }
}

/**
 * Workers of a scratch Obeya for a demo (`--idle-workers`): a started card is in progress, but no
 * agent works on it, so it stays as staged and costs nothing. What a worker is told goes into the
 * server's log, for a demo to show what reaches the agent.
 */
export const idleRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    let end!: () => void;
    const done = new Promise<void>((r) => (end = r));
    const heard = (text: string, images: string[] = []) =>
      console.log(`idle worker in ${spec.cwd} is told${images.length ? ` (with ${images.length} image${images.length === 1 ? '' : 's'})` : ''}:\n${text}\n---`);
    if (firstMessage) heard(firstMessage, images);
    return { send: heard, close: () => end(), done };
  },
};

/**
 * Obeya's own environment minus what belongs to a Claude Code session that may have started it (but
 * the login of a machine without a keychain, `CLAUDE_CODE_OAUTH_TOKEN`), minus the supervisor's
 * mark (an Obeya an agent starts, a scratch one for a demo, supervises itself), and minus what has
 * the compiled binary run scripts as Bun.
 */
export function cleanEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|OBEYA_SUPERVISED$|OBEYA_FROM_APP$|BUN_BE_BUN$)/.test(k)));
}

/**
 * Copies a message's images and the dropped files its text names (under `files` here) into Obeya's
 * directory `dir` on the host (awaited only when there is something to copy): the text with their
 * paths there, and the images' paths there. What cannot be copied keeps its path here; a directory
 * that cannot be made ready leaves the message as it was (the session sees the images in it all the
 * same).
 */
export async function carryTo(host: SshHost, dir: string | Promise<string>, text: string, images: string[], files: string): Promise<{ text: string; images: string[] }> {
  const dropped = filesIn(text, files);
  if (!images.length && !dropped.length) return { text, images };
  try {
    const at = await dir;
    const to = `${at}/images`;
    if (images.length) await host.copyFiles(images, to);
    const there = `${at}/files`;
    if (dropped.length) await host.copyFiles(dropped, there);
    const carried = images.reduce((t, f) => t.split(f).join(`${to}/${basename(f)}`), text);
    return { text: dropped.reduce((t, d) => t.split(d).join(`${there}/${basename(d)}`), carried), images: images.map((f) => `${to}/${basename(f)}`) };
  } catch (e) {
    console.error(messageOf(e));
    return { text, images };
  }
}
