// A scratch Obeya's agents recorded once and played back (`--record`, `--replay`): a demo whose
// agents ran for real once comes out the same in every take after, in minutes and without a model.
//
// A recording is a directory: `meta.json`, and for each agent session a `session-<n>.jsonl`, its
// first line what the agent got (role, instructions, tools, first message), each further line one
// thing that happened in it, in order: an event of the session, a call of one of Obeya's tools with
// its arguments and result, a message sent to it, a context update taken after a tool step. A
// worker's call also keeps the commits it made in its workspace since its call before
// (`session-<n>/<k>.bundle`), a handover (`ready_for_review`) a copy of the demo it names
// (`session-<n>/demo-<k>/`). `cuts.json`, which the demo copies in after
// the take, holds what the take cut out (`Director.skip`, wall clock).
//
// Playing back, each session Obeya starts gets the recorded one of its role and tools, in order;
// its events go out again at the recorded pace, its calls run Obeya's real tools with the recorded
// arguments, and a step after a message waits for that message. What the take cut out goes by in a
// moment, the rest at the recorded pace (without cuts, no gap is longer than `GAP_MS`). Card ids,
// branches and paths differ in every staging: what the agent was given then and is given now
// pairs them, and what it says and calls is told in today's.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentEvent, AgentRuntime, AgentSession, AgentSpec, AgentTool } from './runtime';
import { gitAsync } from './workspaces';
import { messageOf } from '../core/text';

/** What an agent was given of a tool: what the fingerprint of a recording covers. */
export interface ToolPrint {
  name: string;
  description: string;
  schema: unknown;
}

/** The first line of a session's file. */
export interface SessionStart {
  type: 'start';
  at: number;
  role?: string;
  cwd: string;
  system: string;
  tools: ToolPrint[];
  first?: string;
  images: number;
}

/** What happened in a session, numbered (`seq`) in the order it happened: a call when it was made. */
export type Entry = { seq: number; at: number } & (
  | { type: 'event'; event: AgentEvent }
  | { type: 'call'; end: number; name: string; args: Record<string, unknown>; result: string; head?: Head; demo?: { dir: string; copy: string } }
  | { type: 'send'; text: string; images: number }
  | { type: 'context'; text?: string }
  | { type: 'close' }
  /** The session ended by itself. */
  | { type: 'end' }
);

/**
 * The workspace's commits at a worker's call: `bundle` (in the recording) holds `to`, which follows
 * `from`; `rewritten` where it does not descend from it (an amended commit, a branch rebased).
 */
interface Head {
  bundle: string;
  from: string;
  to: string;
  rewritten?: true;
}

interface Meta {
  version: 1;
  /** The recorded Obeya's home, whose paths the agents were told. */
  home: string;
  at: number;
}

/** The handover, whose demo goes into the recording. */
const HANDOVER = 'ready_for_review';
/** Without the take's cuts, the longest a gap of the recording lasts when played back. */
export const GAP_MS = 2000;
/** What a gap inside a cut of the take lasts when played back. */
export const CUT_MS = 100;
/** A tool's refusal, as Obeya's tools word it ("Not handed over: …", the Koordinator's "Nothing recorded: …"). */
const REFUSAL = /^(?:Not [a-z ]+|Nothing recorded):/;
/** How long a step that took a context update waits for it to be there now. */
const CONTEXT_WAIT_MS = 120_000;

/** What a tool's schema looks like to the agent, as JSON Schema. */
function schemaOf(t: AgentTool): unknown {
  try {
    return z.toJSONSchema(z.object(t.schema), { unrepresentable: 'any' });
  } catch {
    return Object.keys(t.schema).sort();
  }
}

const printOf = (tools: AgentTool[]): ToolPrint[] => tools.map((t) => ({ name: t.name, description: t.description, schema: schemaOf(t) }));

/** Whether `dir` may become a recording: missing, empty, or a recording already. */
export function mayRecordInto(dir: string): boolean {
  return !existsSync(dir) || !readdirSync(dir).length || existsSync(join(dir, 'meta.json'));
}

/**
 * A runtime that records every session `inner` runs into `dir`, for `replayRuntime` to play back,
 * after the sessions recorded there already (an Obeya that started again goes on with its
 * recording). `home` is Obeya's home, whose paths the agents are told.
 */
export function recordingRuntime(inner: AgentRuntime, dir: string, home: string): AgentRuntime {
  if (!mayRecordInto(dir)) throw new Error(`${dir} holds something other than a recording; record into an empty or new directory`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'meta.json'))) writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ version: 1, home, at: Date.now() } satisfies Meta, null, 1)}\n`);
  let sessions = readdirSync(dir).filter((f) => /^session-\d+\.jsonl$/.test(f)).length;
  // the last commit recorded of each workspace: the next call's commits follow it
  const heads = new Map<string, Promise<string | undefined>>();
  return {
    start(spec, firstMessage, images) {
      const i = sessions++;
      const file = join(dir, `session-${i}.jsonl`);
      const own = join(dir, `session-${i}`);
      const write = (x: SessionStart | Entry) => appendFileSync(file, `${JSON.stringify(x)}\n`);
      let seq = 0;
      type Happened = Entry extends infer E ? (E extends Entry ? Omit<E, 'seq' | 'at'> : never) : never;
      const line = (x: Happened, n = seq++, at = Date.now()) => write({ ...x, seq: n, at } as Entry);
      write({ type: 'start', at: Date.now(), ...(spec.role ? { role: spec.role } : {}), cwd: spec.cwd, system: spec.system, tools: printOf(spec.tools), ...(firstMessage !== undefined ? { first: firstMessage } : {}), images: images?.length ?? 0 });
      const worker = spec.role === 'worker';
      if (worker && !heads.has(spec.cwd)) heads.set(spec.cwd, headOf(spec.cwd));
      let calls = 0;
      const tools = spec.tools.map((t) => ({
        ...t,
        run: async (args: Record<string, unknown>) => {
          const at = Date.now();
          const k = calls++;
          const n = seq++;
          const kept: Pick<Extract<Entry, { type: 'call' }>, 'head' | 'demo'> = {};
          if (worker) {
            // the commits since the worker's call before
            const from = await heads.get(spec.cwd);
            const to = await headOf(spec.cwd);
            if (from && to && to !== from) {
              heads.set(spec.cwd, Promise.resolve(to));
              const bundle = `session-${i}/${k}.bundle`;
              mkdirSync(own, { recursive: true });
              await gitAsync(spec.cwd, 'bundle', 'create', '-q', join(dir, bundle), 'HEAD');
              kept.head = { bundle, from, to, ...((await descends(spec.cwd, from, to)) ? {} : { rewritten: true as const }) };
            }
            // a question may bring a demo too (drafts to choose from)
            const demoDir = t.name === HANDOVER || t.name === 'ask' ? (args.demo as { dir?: unknown } | undefined)?.dir : undefined;
            if (typeof demoDir === 'string' && existsSync(demoDir)) {
              const copy = `session-${i}/demo-${k}`;
              cpSync(demoDir, join(dir, copy), { recursive: true, filter: (src) => basename(src) !== '.work' });
              kept.demo = { dir: demoDir, copy };
            }
          }
          const result = await t.run(args);
          line({ type: 'call', end: Date.now(), name: t.name, args, result, ...kept }, n, at);
          return result;
        },
      }));
      const session = inner.start(
        {
          ...spec,
          tools,
          onEvent: (event) => {
            line({ type: 'event', event });
            spec.onEvent(event);
          },
          ...(spec.contextUpdate
            ? {
                contextUpdate: () => {
                  const text = spec.contextUpdate!();
                  line({ type: 'context', ...(text !== undefined ? { text } : {}) });
                  return text;
                },
              }
            : {}),
        },
        firstMessage,
        images,
      );
      let closed = false;
      void session.done.then(() => closed || line({ type: 'end' }));
      return {
        send(text, images) {
          line({ type: 'send', text, images: images?.length ?? 0 });
          session.send(text, images);
        },
        close() {
          closed = true;
          line({ type: 'close' });
          session.close();
        },
        done: session.done,
      };
    },
  };
}

async function headOf(cwd: string): Promise<string | undefined> {
  return gitAsync(cwd, 'rev-parse', 'HEAD').catch(() => undefined);
}

async function descends(cwd: string, from: string, to: string): Promise<boolean> {
  return gitAsync(cwd, 'merge-base', '--is-ancestor', from, to).then(
    () => true,
    () => false,
  );
}

/** A recorded session as `replayRuntime` reads it. */
interface Recorded {
  n: number;
  start: SessionStart;
  entries: Entry[];
}

/** Reads the recording in `dir`. */
export function readRecording(dir: string): { meta: Meta; sessions: Recorded[]; cuts: { from: number; to: number }[] | undefined } {
  if (!existsSync(join(dir, 'meta.json'))) throw new Error(`${dir} holds no recording (no meta.json)`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
  const sessions = readdirSync(dir)
    .map((f) => /^session-(\d+)\.jsonl$/.exec(f))
    .filter((m) => !!m)
    .map((m) => {
      const [start, ...entries] = readFileSync(join(dir, m[0]), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SessionStart | Entry);
      // a call's line is written once it returned: in order of when it was made
      return { n: Number(m[1]), start: start as SessionStart, entries: (entries as Entry[]).sort((a, b) => a.seq - b.seq) };
    })
    .sort((a, b) => a.n - b.n);
  const cutsFile = join(dir, 'cuts.json');
  // the director's, in seconds
  const cuts = existsSync(cutsFile) ? (JSON.parse(readFileSync(cutsFile, 'utf8')) as { from: number; to: number }[]).map((c) => ({ from: c.from * 1000, to: c.to * 1000 })) : undefined;
  return { meta, sessions, cuts };
}

/**
 * How long the gap from `from` to `to` (recorded, ms) lasts when played back: what a cut of the take
 * holds of it in `CUT_MS`, the rest as recorded; without cuts at most `GAP_MS`.
 */
export function paced(from: number, to: number, cuts: { from: number; to: number }[] | undefined): number {
  const gap = Math.max(0, to - from);
  if (!cuts) return Math.min(gap, GAP_MS);
  const cut = cuts.reduce((sum, c) => sum + Math.max(0, Math.min(to, c.to) - Math.max(from, c.from)), 0);
  return gap - cut + Math.min(cut, CUT_MS);
}

/** UUIDs, and runs of hex digits (a card id's start in a branch name or path, a commit): what differs from staging to staging. */
const VOLATILE = /(?<![0-9A-Za-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{6,40})(?![0-9A-Za-z])/g;

/**
 * What stands for what between the recording and now: card ids, branches, commits and paths, paired
 * where a text the agent got then and the one it gets now differ in them alone.
 */
export class Swap {
  private tokens = new Map<string, string>();
  private paths: [string, string][] = [];

  private moves: RegExp | undefined;

  path(then: string, now: string) {
    if (then === now || this.paths.some(([t]) => t === then)) return;
    this.paths.push([then, now]);
    // the longest first: a workspace before the home it lies in
    this.paths.sort((a, b) => b[0].length - a[0].length);
    this.moves = new RegExp(this.paths.map(([t]) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  }

  /** A swap that knows what this one knows, to try a pairing on. */
  copy(): Swap {
    const c = new Swap();
    for (const [t, n] of this.paths) c.path(t, n);
    c.tokens = new Map(this.tokens);
    return c;
  }

  /** `text` with the paths of then moved to now's, in one pass: a new path is not moved again. */
  private moved(text: string): string {
    return this.moves ? text.replace(this.moves, (t) => this.paths.find(([p]) => p === t)![1]) : text;
  }

  /** Pairs what differs between `then` and `now`, when they hold as many volatile tokens. */
  learn(then: string | undefined, now: string | undefined) {
    if (!then || !now) return;
    const a = this.moved(then).match(VOLATILE) ?? [];
    const b = now.match(VOLATILE) ?? [];
    if (a.length !== b.length) return;
    a.forEach((x, i) => {
      const y = b[i]!;
      if (x === y || this.tokens.has(x)) return;
      this.tokens.set(x, y);
      // a card's id stands in its branch and its workspace by its start
      if (x.length === 36 && y.length === 36) for (const k of [6, 8]) if (!this.tokens.has(x.slice(0, k))) this.tokens.set(x.slice(0, k), y.slice(0, k));
    });
  }

  /** `text` as it would be said now. */
  text(text: string): string {
    return this.moved(text).replace(VOLATILE, (x) => this.tokens.get(x) ?? x);
  }

  /** Every string in `value`, as `text` has it. */
  deep<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.deep(v)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.deep(v)])) as T;
    return value;
  }
}

/** Where two texts first differ, a line of each, for a reason to show. */
export function firstDifference(then: string, now: string): string {
  const a = then.split('\n');
  const b = now.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  const at = i < 0 ? a.length : i;
  const clipped = (l: string | undefined) => (l === undefined ? '(nothing)' : `"${l.length > 160 ? `${l.slice(0, 160)}…` : l}"`);
  return `line ${at + 1}: recorded ${clipped(a[at])}, now ${clipped(b[at])}`;
}

/** Why the session `spec` does not fit the recorded `start` (its instructions or tools changed), or nothing. */
export function mismatch(start: SessionStart, spec: AgentSpec, swap: Swap): string | undefined {
  const who = start.role ?? 'agent';
  const system = swap.text(start.system);
  if (system !== spec.system) return `the instructions of the ${who} changed since the recording (${firstDifference(system, spec.system)})`;
  const now = printOf(spec.tools);
  for (const t of start.tools) {
    const n = now.find((x) => x.name === t.name);
    if (!n) return `the ${who}'s tool ${t.name} is gone`;
    if (swap.text(t.description) !== n.description) return `the description of the ${who}'s tool ${t.name} changed (${firstDifference(swap.text(t.description), n.description)})`;
    if (JSON.stringify(t.schema) !== JSON.stringify(n.schema)) return `the schema of the ${who}'s tool ${t.name} changed`;
  }
  const added = now.find((n) => !start.tools.some((t) => t.name === n.name));
  if (added) return `the ${who} has a new tool, ${added.name}`;
  return undefined;
}

const names = (tools: { name: string }[]) =>
  tools
    .map((t) => t.name)
    .sort()
    .join(' ');

export interface ReplayOptions {
  /** Obeya's home now. */
  home: string;
  /** Hears why the recording does not fit, once: the recording's agents then do nothing. */
  refused?: (why: string) => void;
  /** Hears what differs without stopping the playback (a message the agent gets now, a tool's result). */
  log?: (line: string) => void;
}

/**
 * A runtime that plays the recording in `dir` back (`recordingRuntime`). A session Obeya starts gets
 * the first recorded one not played yet of its role and tools (else of its role with the most tools
 * in common), the one whose first message is the same where several are left; which were played is
 * kept in the home (`replay-played.json`), so an Obeya started again goes on with the next. One whose instructions or tools differ from the recording's refuses
 * the playback (`refused`, and an error on its card), as does a tool that refuses now what it took
 * then: the recording no longer fits, and a real run has to record it anew. A session the recording
 * has none for ends each of its turns at once.
 */
export function replayRuntime(dir: string, o: ReplayOptions): AgentRuntime {
  const { meta, sessions, cuts } = readRecording(dir);
  const log = o.log ?? ((line: string) => console.log(`replay: ${line}`));
  const swap = new Swap();
  swap.path(dirname(meta.home), dirname(o.home));
  swap.path(meta.home, o.home);
  let refusal: string | undefined;
  const refuse = (why: string) => {
    if (refusal) return;
    refusal = why;
    log(`refused: ${why}: record anew`);
    o.refused?.(why);
  };
  mkdirSync(o.home, { recursive: true });
  const playedFile = join(o.home, 'replay-played.json');
  const played = new Set<number>(existsSync(playedFile) ? (JSON.parse(readFileSync(playedFile, 'utf8')) as number[]) : []);
  return {
    start(spec, firstMessage) {
      const left = sessions.filter((s) => !played.has(s.n) && s.start.role === spec.role);
      const shared = (s: Recorded) => s.start.tools.filter((t) => spec.tools.some((x) => x.name === t.name)).length;
      const most = Math.max(0, ...left.map(shared));
      const exact = left.filter((s) => names(s.start.tools) === names(spec.tools));
      // a changed set of tools is the closest one, for the check below to name what changed
      const candidates = exact.length ? exact : most ? left.filter((s) => shared(s) === most) : [];
      const fits = (s: Recorded) => {
        if (s.start.first === undefined) return firstMessage === undefined;
        const tried = swap.copy();
        tried.path(s.start.cwd, spec.cwd);
        tried.learn(s.start.system, spec.system);
        tried.learn(s.start.first, firstMessage);
        return tried.text(s.start.first) === firstMessage;
      };
      const rec = candidates.find(fits) ?? candidates[0];
      if (!rec) {
        log(`the recording has no ${spec.role ?? 'agent'} with the tools ${names(spec.tools) || '(none)'} left; this one ends each turn at once`);
        return idleSession(spec, firstMessage !== undefined);
      }
      played.add(rec.n);
      writeFileSync(playedFile, JSON.stringify([...played]));
      swap.path(rec.start.cwd, spec.cwd);
      swap.learn(rec.start.system, spec.system);
      swap.learn(rec.start.first, firstMessage);
      const wrong = refusal ?? mismatch(rec.start, spec, swap);
      if (wrong) {
        refuse(wrong);
        return refusedSession(spec, `Replay refused: ${wrong}. Record this demo anew with real agents.`);
      }
      if ((rec.start.first !== undefined ? swap.text(rec.start.first) : undefined) !== firstMessage)
        log(`session ${rec.n} (${rec.start.role ?? 'agent'}) starts with another message than recorded: ${firstDifference(swap.text(rec.start.first ?? ''), firstMessage ?? '')}`);
      return play(rec, spec, { dir, cuts, swap, log, refuse });
    },
  };
}

/** A session the recording has nothing for: each turn ends at once. */
function idleSession(spec: AgentSpec, first: boolean): AgentSession {
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  let closed = false;
  const turn = () => queueMicrotask(() => !closed && spec.onEvent({ type: 'idle' }));
  if (first) turn();
  return {
    send: () => turn(),
    close: () => {
      closed = true;
      end();
    },
    done,
  };
}

/** A session that fails on every message, with `message`. */
function refusedSession(spec: AgentSpec, message: string): AgentSession {
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  let closed = false;
  const fail = () =>
    queueMicrotask(() => {
      if (closed) return;
      spec.onEvent({ type: 'error', message });
      spec.onEvent({ type: 'idle' });
    });
  fail();
  return {
    send: () => fail(),
    close: () => {
      closed = true;
      end();
    },
    done,
  };
}

interface Player {
  dir: string;
  cuts: { from: number; to: number }[] | undefined;
  swap: Swap;
  log: (line: string) => void;
  refuse: (why: string) => void;
}

/** Plays `rec` into the session of `spec`. */
function play(rec: Recorded, spec: AgentSpec, p: Player): AgentSession {
  const { swap } = p;
  const who = `session ${rec.n} (${rec.start.role ?? 'agent'})`;
  let closed = false;
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  // the messages sent so far, with when they came, how many of them the recording's steps took, and who waits for the next
  const sent: { text: string; at: number }[] = [];
  let taken = 0;
  let wake: (() => void) | undefined;
  // played to its end (or refused): a message from then on gets a turn that ends at once
  let over = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const run = async () => {
    // the recorded time of the step before, and when it was played
    let then = rec.start.at;
    let now = Date.now();
    for (const e of rec.entries) {
      if (closed) return;
      if (e.type === 'send') {
        while (sent.length <= taken && !closed) await new Promise<void>((r) => (wake = r));
        if (closed) return;
        const got = sent[taken++]!;
        swap.learn(e.text, got.text);
        if (swap.text(e.text) !== got.text) p.log(`${who} got another message than recorded: ${firstDifference(swap.text(e.text), got.text)}`);
        // the steps after a message are timed from it
        then = e.at;
        now = Math.max(now, got.at);
        continue;
      }
      if (e.type === 'close') continue;
      if (e.type === 'end') {
        // the session ended by itself, as recorded
        closed = true;
        end();
        return;
      }
      const wait = now + paced(then, e.at, p.cuts) - Date.now();
      if (wait > 0) await sleep(wait);
      if (closed) return;
      if (e.type === 'event') spec.onEvent(swap.deep(e.event));
      else if (e.type === 'context') {
        // what the agent read with this step then (the owner's note, say) it waits for now
        let text = spec.contextUpdate?.();
        for (const until = Date.now() + CONTEXT_WAIT_MS; e.text && text === undefined && Date.now() < until && !closed; text = spec.contextUpdate?.()) await sleep(250);
        if (e.text && text === undefined) p.log(`${who} took no context update where the recording has one: ${firstDifference(e.text, '')}`);
        swap.learn(e.text, text);
      }
      else {
        const why = await call(e);
        if (closed) return;
        if (why) {
          p.refuse(why);
          spec.onEvent({ type: 'error', message: `Replay refused: ${why}. Record this demo anew with real agents.` });
          spec.onEvent({ type: 'idle' });
          return;
        }
      }
      then = e.type === 'call' ? e.end : e.at;
      now = Date.now();
    }
  };
  /** Runs the recorded call `e` with Obeya's tool of today; why the recording no longer fits, if it does not. */
  const call = async (e: Extract<Entry, { type: 'call' }>): Promise<string | undefined> => {
    const tool = spec.tools.find((t) => t.name === e.name);
    if (!tool) return `the ${rec.start.role ?? 'agent'} has no tool ${e.name} any more`;
    try {
      if (e.head) await commits(e.head);
      if (e.demo) cpSync(join(p.dir, e.demo.copy), swap.text(e.demo.dir), { recursive: true });
    } catch (error) {
      return `the recorded work of ${e.name} does not go into the workspace: ${messageOf(error)}`;
    }
    const result = await tool.run(swap.deep(e.args));
    swap.learn(e.result, result);
    if (REFUSAL.test(result) && !REFUSAL.test(e.result)) return `${e.name} refuses now what it took in the recording: ${result}`;
    if (swap.text(e.result) !== result) p.log(`${who}: ${e.name} answers otherwise than recorded: ${firstDifference(swap.text(e.result), result)}`);
    return undefined;
  };
  /** The recorded commits since the worker's call before, onto what the workspace holds now. */
  const commits = async (head: Head) => {
    const cwd = spec.cwd;
    const ref = `refs/obeya-replay/${head.to}`;
    await gitAsync(cwd, 'fetch', '-q', join(p.dir, head.bundle), `+HEAD:${ref}`);
    const [name, email] = (await gitAsync(cwd, 'log', '-1', '--format=%an%n%ae', head.to)).split('\n');
    const as = ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
    try {
      if (!head.rewritten) {
        await gitAsync(cwd, ...as, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', `${head.from}..${head.to}`).catch(async (error) => {
          await gitAsync(cwd, 'cherry-pick', '--abort').catch(() => {});
          throw error;
        });
        return;
      }
      // rewritten (an amend; a rebase, which the landing of today did too): what changed, as one commit
      if ((await gitAsync(cwd, 'rev-parse', 'HEAD^{tree}')) === (await gitAsync(cwd, 'rev-parse', `${head.to}^{tree}`))) return;
      const patch = join(mkdtempSync(join(tmpdir(), 'obeya-replay-')), 'change.patch');
      const diff = await gitAsync(cwd, 'diff', '--binary', head.from, head.to);
      if (!diff) return;
      writeFileSync(patch, `${diff}\n`);
      await gitAsync(cwd, 'apply', '--3way', '--index', patch);
      await gitAsync(cwd, ...as, 'commit', '-q', '--allow-empty', '-m', await gitAsync(cwd, 'log', '-1', '--format=%B', head.to));
      rmSync(dirname(patch), { recursive: true, force: true });
    } finally {
      await gitAsync(cwd, 'update-ref', '-d', ref).catch(() => {});
    }
  };
  const turnEnds = () => queueMicrotask(() => !closed && spec.onEvent({ type: 'idle' }));
  queueMicrotask(() =>
    run()
      .catch((error) => {
        p.log(`${who} failed: ${messageOf(error)}`);
        if (closed) return;
        spec.onEvent({ type: 'error', message: `Replay failed: ${messageOf(error)}` });
        spec.onEvent({ type: 'idle' });
      })
      .finally(() => {
        over = true;
        // what came after the last recorded message
        for (; taken < sent.length; taken++) {
          p.log(`${who} gets a message the recording has no turn for; the turn ends at once`);
          turnEnds();
        }
      }),
  );
  return {
    send(text) {
      sent.push({ text, at: Date.now() });
      if (!over) return wake?.();
      taken++;
      p.log(`${who} gets a message the recording has no turn for; the turn ends at once`);
      turnEnds();
    },
    close() {
      closed = true;
      wake?.();
      end();
    },
    done,
  };
}
