// Agent sessions behind a small interface, so the orchestration can be tested without a model: the
// contract every runtime fills (Claude Code's in claude.ts, Codex's in codex.ts), the decorators that
// wrap any of them, and what both runtimes share.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { remote, type SshHost } from './hosts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { filesIn } from './files';
import { OWN_GROUP } from './spawn';
import type { Messages } from '../core/messages';
import type { ToolWatch } from './folder';
import { agentDefault, type AgentEffort, type AgentRole, type AgentSetting, type CardAgent, type Harness, replacement, storedModel } from '../core/agents';
import type { HarnessLimit, HarnessLimits } from './limits';
import type { Listeners } from '../core/watched';
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
   * limit, say): it lifts again at `resetsAt` (milliseconds) when the API said when; or, with
   * `outage`, when the model's service could not be reached (an outage, `claudeUnreachable`): it is
   * tried again at `resetsAt` (`outageRetry`), and the turn waits as for the usage limit. `token`
   * when the session signed in with a token rather than this machine's account (`CardEvent.token`).
   */
  | { type: 'error'; message: string; limit?: TurnLimit; token?: true }
  /**
   * The agent runs on its group's fallback (`to`), not on harness `from`, which is at its usage
   * limit (or, with `outage`, cannot be reached) until `until` (milliseconds): it started there, or
   * a turn there stopped before the agent did anything and it started afresh on the fallback.
   */
  | { type: 'moved'; from: Harness; to: AgentSetting; until: number; outage?: true };

/**
 * What keeps a turn from going on until `resetsAt` (milliseconds, where known): the account's usage
 * limit, or with `outage` the model's service, which could not be reached.
 */
export interface TurnLimit {
  resetsAt?: number;
  outage?: true;
}

/** The session's host (`AgentEvent` `lost`) is out of reach. */
export const lostEvent = (host: string): AgentEvent => ({ type: 'lost', message: `the connection to ${host} was lost` });

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
  /**
   * The system prompt for the harness the agent ends up on, where it differs by harness (how a worker
   * waits) and that may not be the one its caller expected (`withAgentSetting`'s fallback); `system` otherwise.
   */
  systemFor?: (harness: Harness) => string;
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
   * and nothing once it does or its session ends. A service that could not be reached (`outage`) is
   * waited for the same way. Without it, the turn fails with the error's `limit`.
   */
  onLimit?: OnLimit;
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

/** What a fallback asks of a harness: whether it is at its limit now, and whether it is ready here (installed, logged in). */
export interface Availability {
  limit(h: Harness): HarnessLimit | undefined;
  ready(h: Harness): boolean;
}

/** Where an agent runs (`placeAgent`): its harness, model and effort, and the harness it was to run on where its limit moved it to the fallback. */
export interface Placed extends AgentSetting {
  moved?: { from: Harness; limit: HarnessLimit };
}

/**
 * Where an agent of a group starts: on its group's harness, model and effort, or on the harness and
 * model and the effort chosen for that agent alone (a card's), each where it names one. A session
 * resumed stays on the harness it began on: with the model chosen there where that is the group's
 * or its fallback's harness, else that harness's preset model, so a card goes on with its
 * conversation. A new one whose harness is at its limit (`avail`) starts on the group's fallback
 * instead (`replacement`), where that harness is ready and not at its limit itself.
 */
export function placeAgent(spec: Pick<AgentSpec, 'role' | 'agent' | 'resume'>, group: AgentSetting, avail?: Availability): Placed {
  const own = spec.agent;
  const chosen: AgentSetting = {
    harness: group.harness,
    model: group.model,
    effort: own?.effort ?? group.effort,
    ...(own?.harness && own.model ? { harness: own.harness, model: own.model } : {}),
  };
  const role = spec.role ?? 'worker';
  if (spec.resume) {
    const on = sessionHarness(spec.resume);
    if (on === chosen.harness) return chosen;
    const other = replacement(group, chosen.harness, chosen.effort);
    return other?.harness === on ? other : { ...agentDefault(role, on), effort: chosen.effort };
  }
  const limit = avail?.limit(chosen.harness);
  if (!limit) return chosen;
  const other = replacement(group, chosen.harness, chosen.effort);
  if (!other || !avail!.ready(other.harness) || avail!.limit(other.harness)) return chosen;
  return { ...other, moved: { from: chosen.harness, limit } };
}

/**
 * A runtime that starts each agent of a group where `placeAgent` places it, asked at every start
 * (`setting`, the group's as the owner chose it; `avail`, what the fallback asks of a harness).
 * Claude Code's default model is no model given; a Codex agent always gets a family (`codexFamily`),
 * which its session resolves to a model. An agent placed on its fallback hears so first (`moved`).
 */
export function withAgentSetting(runtime: AgentRuntime, setting: (role: AgentRole) => AgentSetting, avail?: Availability): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      if (!spec.role) return runtime.start(spec, firstMessage, images);
      const { harness, model, effort, moved } = placeAgent(spec, setting(spec.role), avail);
      if (moved) spec.onEvent({ type: 'moved', from: moved.from, to: { harness, model, effort }, until: moved.limit.until, ...(moved.limit.outage ? { outage: true as const } : {}) });
      const { model: _, agent: __, systemFor, ...rest } = spec;
      const given = storedModel(harness, model);
      return runtime.start({ ...rest, ...(systemFor ? { system: systemFor(harness) } : {}), harness, effort, ...(given === 'default' ? {} : { model: given }) }, firstMessage, images);
    },
  };
}

/** `spec` with `extra` after its system prompt, for whichever harness it ends up on (`systemFor`). */
export function appendSystem<S extends Pick<AgentSpec, 'system' | 'systemFor'>>(spec: S, extra: string): S {
  const { systemFor } = spec;
  return { ...spec, system: `${spec.system}\n\n${extra}`, ...(systemFor ? { systemFor: (h: Harness) => `${systemFor(h)}\n\n${extra}` } : {}) };
}

/** The harness an agent's spec runs on, once `withAgentSetting` has placed it: the one it names, else its session's, else Claude Code. */
export const specHarness = (spec: Pick<AgentSpec, 'harness' | 'resume'>): Harness => spec.harness ?? (spec.resume ? sessionHarness(spec.resume) : 'claude');

/**
 * A runtime whose agents tell `limits` what they find out about their harness: a turn the usage
 * limit (or an outage) stopped, until when it holds; a turn that works, that it lifted.
 */
export function withLimitRecord(runtime: AgentRuntime, limits: HarnessLimits): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      const harness = specHarness(spec);
      return runtime.start(
        {
          ...spec,
          onEvent: (e) => {
            if (e.type === 'error' && e.limit) limits.hit(harness, limitLifts(e.limit, 0), !!e.limit.outage);
            else if (e.type === 'text' || e.type === 'tool') limits.lifted(harness);
            spec.onEvent(e);
          },
        },
        firstMessage,
        images,
      );
    },
  };
}

/**
 * A runtime whose new agents start afresh on their group's fallback when a turn on their harness
 * stops at its limit before they did anything: nothing of their conversation is lost, so they need
 * not wait for the limit to lift. What they were sent goes to the new session, whose id follows the
 * first one's (`session`), after `moved`. An agent that waits
 * for the limit (`onLimit`) looks again whenever `changes` says something changed (the owner set a
 * fallback, say), and moves then. One that acted, or resumes a session, stays where it is: its
 * conversation cannot move to another harness.
 */
export function withFallback(runtime: AgentRuntime, setting: (role: AgentRole) => AgentSetting, avail: Availability, changes?: Listeners): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      if (!spec.role || spec.resume) return runtime.start(spec, firstMessage, images);
      const role = spec.role;
      let on = placeAgent(spec, setting(role), avail).harness;
      let agent = spec.agent;
      let acted = false;
      let closed = false;
      // what it was sent after its first message, while it had not acted: the next session gets it too
      const sent: { text: string; images?: string[] }[] = [];
      let waiting = false;
      let off: (() => void) | undefined;
      let generation = 0;
      let current!: AgentSession;
      let ended!: () => void;
      const done = new Promise<void>((r) => (ended = r));
      const act = () => {
        if (acted) return;
        acted = true;
        sent.length = 0;
        off?.();
        off = undefined;
      };
      /** Starts it afresh on the fallback, where one is to be had now; whether it did. */
      const move = (limit: HarnessLimit): boolean => {
        if (acted || closed) return false;
        const group = setting(role);
        const other = replacement(group, on, agent?.effort ?? spec.agent?.effort ?? group.effort);
        if (!other || !avail.ready(other.harness) || avail.limit(other.harness)) return false;
        const from = on;
        on = other.harness;
        agent = { harness: other.harness, model: other.model, effort: other.effort };
        generation++;
        const before = current;
        before.close();
        if (waiting) spec.onLimit?.(undefined);
        waiting = false;
        off?.();
        off = undefined;
        spec.onEvent({ type: 'moved', from, to: other, until: limit.until, ...(limit.outage ? { outage: true as const } : {}) });
        begin();
        return true;
      };
      const begin = () => {
        const mine = ++generation;
        const s = runtime.start(
          {
            ...spec,
            ...(agent ? { agent } : {}),
            ...(spec.onLimit
              ? {
                  onLimit: (until: number | undefined, outage?: boolean) => {
                    if (mine !== generation) return;
                    if (until !== undefined && move({ until, ...(outage ? { outage: true as const } : {}) })) return;
                    waiting = until !== undefined;
                    if (waiting && !acted && changes && !off)
                      off = changes.onChange(() => {
                        if (mine === generation && waiting) move(avail.limit(on) ?? { until: until! });
                      });
                    spec.onLimit!(until, outage);
                  },
                }
              : {}),
            onEvent: (e) => {
              if (mine !== generation) return;
              if (e.type === 'error' && e.limit && !spec.onLimit && move({ until: limitLifts(e.limit, 0), ...(e.limit.outage ? { outage: true as const } : {}) })) return;
              if (e.type === 'text' || e.type === 'tool' || e.type === 'idle' || e.type === 'error') act();
              spec.onEvent(e);
            },
          },
          firstMessage,
          images,
        );
        current = s;
        for (const m of sent) s.send(m.text, m.images);
        void s.done.then(() => {
          if (mine !== generation) return;
          off?.();
          ended();
        });
      };
      begin();
      return {
        send(text, given) {
          if (!acted) sent.push({ text, ...(given ? { images: given } : {}) });
          current.send(text, given);
        },
        close() {
          closed = true;
          off?.();
          off = undefined;
          current.close();
        },
        done,
      };
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

/** What a tool's schema looks like to the agent, as JSON Schema. */
export function toolSchema(t: AgentTool): unknown {
  try {
    return z.toJSONSchema(z.object(t.schema), { unrepresentable: 'any' });
  } catch {
    return Object.keys(t.schema).sort();
  }
}

/** A tool's print: changes with its description and its schema, which the agent reads of it. */
export const toolPrint = (t: AgentTool) => createHash('sha256').update(JSON.stringify([t.description, toolSchema(t)])).digest('hex').slice(0, 16);

/** The prints of `tools`, by name. */
export const toolPrints = (tools: AgentTool[]): Record<string, string> => Object.fromEntries(tools.map((t) => [t.name, toolPrint(t)]));

/** A Codex thread's tool that came after it started, in place of a print: the thread cannot call it, whatever it becomes. */
export const UNREACHABLE = 'unreachable';

/** What a session remembers of Obeya's tools (`Store`): what it last heard of them, by its id. */
export interface ToolsHeard {
  toolsHeard(session: string): Record<string, string> | undefined;
  heardTools(session: string, prints: Record<string, string>): void;
}

/**
 * What a resumed session is told of Obeya's tools that changed since it last heard of them
 * (`heard`), on `harness`: nothing when none did. Neither harness gives a resumed session the
 * tools as they are now: Claude Code keeps the definitions its session began with (a new tool it
 * adds by itself; a tool search brings the old definition back), Codex keeps a thread's tools with
 * the thread and takes no new ones. So the session reads each changed tool's definition here, and
 * calls it so, which both pass on to the tool as called. A tool new since then reaches a Codex
 * thread in no way: it hears once that it cannot call it.
 */
export function toolNews(heard: Record<string, string>, tools: AgentTool[], harness: Harness): string | undefined {
  const named = (name: string) => (harness === 'claude' ? `mcp__obeya__${name}` : name);
  const changed = tools.filter((t) => heard[t.name] !== undefined && heard[t.name] !== UNREACHABLE && heard[t.name] !== toolPrint(t));
  const added = harness === 'codex' ? tools.filter((t) => heard[t.name] === undefined) : [];
  const gone = Object.keys(heard).filter((name) => heard[name] !== UNREACHABLE && !tools.some((t) => t.name === name));
  if (!changed.length && !added.length && !gone.length) return undefined;
  const parts = ["Obeya's tools changed since this session last heard of them, and your list of tools still shows them as they were."];
  if (changed.length) {
    parts.push(`${changed.length === 1 ? 'This one is' : 'These are'} now as follows; call ${changed.length === 1 ? 'it' : 'them'} so, with the parameters given here:`);
    for (const t of changed) {
      const { $schema: _, ...schema } = (toolSchema(t) ?? {}) as Record<string, unknown>;
      parts.push(`${named(t.name)}: ${t.description}\nInput schema: ${JSON.stringify(schema)}`);
    }
  }
  if (gone.length) parts.push(`Gone, calling ${gone.length === 1 ? 'it' : 'them'} fails: ${gone.map(named).join(', ')}.`);
  if (added.length) parts.push(`New since, but this session cannot call ${added.length === 1 ? 'it' : 'them'}: ${added.map((t) => named(t.name)).join(', ')}.`);
  return parts.join('\n\n');
}

/**
 * What a session has heard of `tools` once it was told `toolNews` (after `heard`, on `harness`):
 * each one's print, but on Codex a tool that came after the thread started stays out of its reach.
 */
export function heardNow(heard: Record<string, string> | undefined, tools: AgentTool[], harness: Harness): Record<string, string> {
  const prints = toolPrints(tools);
  if (!heard || harness !== 'codex') return prints;
  return Object.fromEntries(Object.entries(prints).map(([name, print]) => [name, heard[name] === undefined || heard[name] === UNREACHABLE ? UNREACHABLE : print]));
}

/** Events that show a session took its message: it is at work, or done with it. */
const AT_WORK = new Set<AgentEvent['type']>(['text', 'tool', 'denied', 'idle', 'spend', 'background']);

/**
 * A runtime that tells a session it resumes which of Obeya's tools changed since it last heard of
 * them (`toolNews`), with its first message, and remembers in `heard` what each session has heard
 * of them (`heardNow`) once it took a message that carried the news: a turn that failed before
 * taking it tells it again at the next resume. A session `heard` never saw start hears nothing.
 */
export function withToolNews(runtime: AgentRuntime, heard: ToolsHeard): AgentRuntime {
  return {
    start(spec, firstMessage, images) {
      const harness = spec.resume ? sessionHarness(spec.resume) : (spec.harness ?? 'claude');
      const before = spec.resume ? heard.toolsHeard(spec.resume) : undefined;
      let news = before ? toolNews(before, spec.tools, harness) : undefined;
      // the news went with a message (or there was none), and what the session heard is written down
      let carried = !news;
      let written = false;
      let id: string | undefined;
      const withNews = (text: string) => {
        if (!news) return text;
        const t = `${news}\n\n${text}`;
        news = undefined;
        carried = true;
        return t;
      };
      const session = runtime.start(
        {
          ...spec,
          onEvent: (e) => {
            if (e.type === 'session') id = e.id;
            else if (id && carried && !written && AT_WORK.has(e.type)) {
              written = true;
              heard.heardTools(id, heardNow(before, spec.tools, harness));
            }
            spec.onEvent(e);
          },
        },
        firstMessage === undefined ? undefined : withNews(firstMessage),
        images,
      );
      return { send: (text, more) => session.send(withNews(text), more), close: () => session.close(), done: session.done };
    },
  };
}

/**
 * A harness at its usage limit until `resetsAt`: every turn of its agents fails at once on it, as
 * Claude Code's and Codex's do then. For demos and live checks of a group's fallback (`OBEYA_FAKE_LIMIT`).
 */
export function limitedRuntime(resetsAt: number): AgentRuntime {
  return {
    start(spec, firstMessage) {
      let closed = false;
      let ended!: () => void;
      const done = new Promise<void>((r) => (ended = r));
      const turn = () =>
        setTimeout(() => {
          if (closed) return;
          spec.onEvent({ type: 'error', message: `You've hit your session limit · resets ${new Date(resetsAt).toISOString()}`, limit: { resetsAt } });
          spec.onEvent({ type: 'idle' });
        }, 200);
      if (firstMessage !== undefined) turn();
      return {
        send: () => void turn(),
        close: () => {
          closed = true;
          ended();
        },
        done,
      };
    },
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
        return runtime.start({ ...(notes ? appendSystem(spec, `The repository's CLAUDE.md:\n\n${notes}`) : spec), untrusted: true }, firstMessage, images);
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

/**
 * Hears that an agent waits until `until` for the usage limit (or, with `outage`, for the model's
 * service to be reachable again), and `undefined` once it goes on or its session ends.
 */
export type OnLimit = (until: number | undefined, outage?: boolean) => void;

/** What an agent the usage limit stopped is told once it lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped your last turn has reset. Go on where you stopped.';
/** What an agent whose turn an outage stopped is told when Obeya tries again. */
export const OUTAGE_OVER = 'Your last turn stopped because the API could not be reached (an outage). Go on where you stopped.';
/** What an agent the `limit` stopped is told when it goes on. */
export const goOn = (limit: TurnLimit) => (limit.outage ? OUTAGE_OVER : LIMIT_LIFTED);

/** For an agent that waits for the usage limit with nowhere to show it (`AgentSpec.onLimit`): nobody waits for its result. */
export const waitQuietly = () => {};

/**
 * A runtime whose agents with `onLimit` wait for the account's usage limit: the turn it stopped
 * waits, without its error and its end, and `margin` after the limit lifts (`limitLifts`) the
 * session is told to go on where it stopped; one that runs into the limit again waits anew.
 */
export function withLimitWait(runtime: AgentRuntime, margin = LIMIT_MARGIN): AgentRuntime {
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
              const limit = e.limit;
              const until = limitLifts(limit, margin);
              clearTimeout(lifts);
              lifts = atTime(until, () => {
                lifts = undefined;
                onLimit(undefined);
                session.send(goOn(limit));
              });
              onLimit(until, !!limit.outage);
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

/** What a harness said last on stderr, `more` added to what was `kept`: as much as a session that ends with an error reports. */
export const stderrTail = (kept: string, more: string) => (kept + more).slice(-2000);

/** A session's error with what its harness said last on stderr, unless the error names it already. */
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

/** How long after a usage limit lifts an agent goes on by default, so that clocks a little apart do not matter. */
export const LIMIT_MARGIN = 10_000;

/** Runs `fn` at the time `at` (ms since the epoch), at once where it has passed; a timer runs at most about 24 days, so one further off runs then. */
export function atTime(at: number, fn: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(fn, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
}

/** When to go on after the usage limit stopped a turn: `margin` after it lifts, so that clocks a little apart do not matter. */
export function limitLifts(limit: { resetsAt?: number }, margin: number, now = Date.now()): number {
  const reset = limit.resetsAt;
  return !reset ? now + LIMIT_RETRY : reset > now ? reset + margin : now + LIMIT_AGAIN;
}

/**
 * How long Obeya waits before it tries again a turn that failed because the model's service could
 * not be reached, by how many such failures came in a row before (`streak`, from 0): soon at first,
 * an outage that lasts longer every quarter of an hour. Claude Code has retried an overloaded or
 * failing API for minutes before the turn fails; a refused request (a block page) it does not retry.
 */
const OUTAGE_RETRIES = [1, 2, 5, 10, 15].map((m) => m * 60_000);
export const outageRetry = (streak: number, now = Date.now()) => now + OUTAGE_RETRIES[Math.min(streak, OUTAGE_RETRIES.length - 1)]!;

/**
 * Whether a turn's failure says the Claude API could not be reached or did not serve the request,
 * as Claude Code words it: a server error or overload ("API Error: 529 …", "Repeated 529 Overloaded
 * errors"), no connection ("API Error: Connection error."), or a request refused by Cloudflare in
 * front of the API (a 403 with its block page, "Attention Required! | Cloudflare", which Claude Code
 * words as "Failed to authenticate"). A 403 of the API itself (an organisation without access, say)
 * is not one: trying again would not help.
 */
export function claudeUnreachable(message: string): boolean {
  return /\bAPI Error:? \(?(?:5\d\d\b|Repeated 529\b|Connection error\b|Request timed out\b)|\boverloaded_error\b|\bAPI Error:? \(?403\b.*(?:\bcloudflare\b|\battention required\b|<html)/is.test(message);
}

/** A session's failure in the owner's words. */
export function failureReason(message: string, t: Messages): string {
  if (claudeLoginFailed(message)) return t.failure.notLoggedIn;
  if (claudeUnreachable(message)) return t.failure.unreachable(message);
  const codex = codexLoginLost(message);
  if (codex) return t.failure.codexNotLoggedIn(codex.host);
  return t.failure.session(message);
}

/** Background work that ended wakes the agent within this; a turn that waits longer without a sign counts as ended. */
const BACKGROUND_GRACE = 10 * 60_000;
/**
 * Background work ends by its own limit well within this (a command run in the background after two
 * hours at most, a watcher after half an hour): it is only for a session that never says the work ended.
 */
const BACKGROUND_LIMIT = 3 * 60 * 60_000;

/**
 * A turn of an agent (a card's worker, an idea's, a look-up's) that ended while its background work
 * runs: that work wakes the agent when it ends, so the turn waits for it, and the owner's words
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
/**
 * A read-only session that reads `brief` (and `images`) and answers through its tools: it ends with
 * its turn, or once a tool calls `finish`. It settles with the error that ended it before a tool
 * called `finish`, if one did. With `onLimit` it waits for the account's usage limit instead of
 * failing on it (`AgentSpec.onLimit`).
 */
export function readSession(
  runtime: AgentRuntime,
  o: {
    cwd: string;
    system: string;
    tools: (finish: (r: string) => string) => AgentTool[];
    brief: string;
    role: AgentRole;
    images?: string[];
    onLimit?: OnLimit;
    /** The card it reads for, whose cost it counts to (`AgentSpec.spendOn`). */
    spendOn?: string;
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const end = (error?: string) => {
      if (!done) {
        done = true;
        resolve(error);
      }
    };
    const finish = (r: string) => {
      end();
      return r;
    };
    const session = runtime.start(
      {
        cwd: o.cwd,
        readOnly: true,
        role: o.role,
        system: o.system,
        tools: o.tools(finish),
        ...(o.onLimit ? { onLimit: o.onLimit } : {}),
        ...(o.spendOn ? { spendOn: o.spendOn } : {}),
        onEvent: (e) => {
          if (e.type === 'idle' || e.type === 'error') {
            session.close();
            end(e.type === 'error' ? e.message : undefined);
          }
        },
      },
      o.brief,
      o.images,
    );
  });
}

