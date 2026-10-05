// The excerpt of a worker's run for the Arbeitsrückschau, drawn without a model from the Agent
// SDK's transcript (`<projects>/<workspace path>/<session id>.jsonl`): where the worker went wrong
// and corrected itself. The format is the SDK's own and may change: whatever cannot be read is
// left out, and a transcript that cannot be read at all gives no excerpt rather than an error.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One tool call of the run, with what came of it and the agent's words around it. */
export interface Call {
  /** Its place among the run's tool calls, from 1. */
  step: number;
  tool: string;
  /** What it did: the command, the file, the pattern. */
  what: string;
  failed: boolean;
  /** The error it ended in, shortened. */
  error?: string;
  /** The agent's last words before the call and its first words after the result. */
  before?: string;
  after?: string;
}

export type Finding =
  /** A call that failed, and was not retried right away. */
  | { kind: 'failure'; call: Call }
  /** Similar calls in a row: a failed one followed by its correction, or the same command again and again. */
  | { kind: 'retry'; calls: Call[] }
  /** A file written whole more than once. */
  | { kind: 'rewrite'; file: string; times: number; before?: string };

export interface Excerpt {
  /** Tool calls in all. */
  steps: number;
  /** How many calls came before the first change to a file; null when it changed none. */
  firstChange: number | null;
  findings: Finding[];
}

/** The directory holding the SDK's transcripts, one subdirectory per working directory. */
export function transcriptsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

/**
 * The transcript file of a session, or null. It is looked for under the working directory it ran
 * in first (`cwd`, as the SDK names its directory), then in every directory, as the naming may change.
 */
export function findTranscript(sessionId: string, cwd?: string | null, dir = transcriptsDir()): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = join(dir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const d of readdirSync(dir)) {
      const file = join(dir, d, name);
      if (existsSync(file)) return file;
    }
  } catch {}
  return null;
}

/** The excerpt of a transcript file; null when it is missing, unreadable or shows nothing gone wrong. */
export function excerptOf(file: string | null): Excerpt | null {
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const e = excerpt(text);
  return e && e.findings.length ? e : null;
}

type Entry = { kind: 'text'; text: string } | { kind: 'call'; id: string; tool: string; input: Record<string, unknown> };

/**
 * The excerpt of a transcript's text (JSON lines); null when no line reads as the run of an agent.
 * Subagents' lines are left out: their own transcript is not the worker's.
 */
export function excerpt(jsonl: string): Excerpt | null {
  const entries: Entry[] = [];
  const results = new Map<string, { failed: boolean; output: string }>();
  let recognised = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(d) || d.isSidechain === true || !isObject(d.message)) continue;
    const content = d.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (d.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        recognised = true;
        entries.push({ kind: 'text', text: block.text.trim() });
      } else if (d.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        recognised = true;
        entries.push({ kind: 'call', id: block.id, tool: block.name, input: isObject(block.input) ? block.input : {} });
      } else if (d.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, { failed: block.is_error === true, output: resultText(block.content) });
      }
    }
  }
  if (!recognised) return null;

  const calls: (Call & { key: string; input: Record<string, unknown> })[] = [];
  let lastText: string | undefined;
  for (const e of entries) {
    if (e.kind === 'text') {
      lastText = e.text;
      const prev = calls.at(-1);
      if (prev && prev.after === undefined) prev.after = clip(e.text, WORDS);
      continue;
    }
    const r = results.get(e.id);
    // cut off by Obeya's restart, or stopped by the owner: no mistake of the agent's
    const failed = !!r?.failed && !CUT_OFF.some((c) => c.test(r.output));
    calls.push({
      step: calls.length + 1,
      tool: e.tool,
      what: describe(e.tool, e.input),
      failed,
      ...(failed ? { error: shorten(r!.output) } : {}),
      ...(lastText ? { before: clip(lastText, WORDS) } : {}),
      key: keyOf(e.tool, e.input),
      input: e.input,
    });
    lastText = undefined;
  }

  const findings: Finding[] = [];
  for (let i = 0; i < calls.length; ) {
    let j = i + 1;
    while (j < calls.length && similar(calls[j - 1]!, calls[j]!)) j++;
    const run = calls.slice(i, j);
    const repeated = run[0]!.tool === 'Bash' && run.length >= REPEATS;
    if (run.length >= 2 && (run[0]!.failed || repeated)) findings.push({ kind: 'retry', calls: run.map(plain) });
    else {
      // a run that is no retry is calls on their own: of those, the failed ones count
      for (const c of run) if (c.failed) findings.push({ kind: 'failure', call: plain(c) });
    }
    i = j;
  }

  const writes = new Map<string, typeof calls>();
  for (const c of calls) {
    if (c.tool !== 'Write' || typeof c.input.file_path !== 'string') continue;
    writes.set(c.input.file_path, [...(writes.get(c.input.file_path) ?? []), c]);
  }
  for (const [file, ws] of writes) {
    if (ws.length < 2) continue;
    const last = ws.at(-1)!;
    findings.push({ kind: 'rewrite', file, times: ws.length, ...(last.before ? { before: last.before } : {}) });
  }

  const first = calls.findIndex((c) => CHANGES.includes(c.tool));
  return { steps: calls.length, firstChange: first < 0 ? null : first, findings: findings.slice(0, MAX_FINDINGS) };
}

/**
 * The excerpts of a card's runs as one text for the model, the earliest run first; empty when no
 * run shows anything gone wrong.
 */
export function excerptText(runs: Excerpt[]): string {
  const shown = runs.filter((r) => r.findings.length);
  if (!shown.length) return '';
  const text = runs
    .map((r, n) => {
      const head = `${runs.length > 1 ? `Run ${n + 1} of ${runs.length}: ` : ''}${r.steps} tool calls${r.firstChange !== null ? `, the first change to a file after ${r.firstChange}` : ', no change to a file'}.`;
      return [head, ...r.findings.map((f, i) => `${i + 1}. ${finding(f)}`)].join('\n');
    })
    .join('\n\n');
  return clip(text, MAX_TEXT);
}

function finding(f: Finding): string {
  if (f.kind === 'rewrite') return [`${f.file} written whole ${f.times} times.`, f.before ? `   Before the last time: "${f.before}"` : ''].filter(Boolean).join('\n');
  if (f.kind === 'failure') return [`Step ${f.call.step} failed: ${f.call.tool} ${f.call.what}`, ...around(f.call, f.call)].join('\n');
  const [first, last] = [f.calls[0]!, f.calls.at(-1)!];
  const failed = f.calls.filter((c) => c.failed).length;
  return [
    `Steps ${first.step}–${last.step}: ${f.calls.length} similar ${first.tool} calls in a row, ${failed} failed${last.failed ? ', the last one too' : ''}:`,
    ...f.calls.map((c) => `   ${c.failed ? '✗' : '✓'} ${c.what}`),
    ...around(first, last, f.calls.find((c) => c.failed)),
  ].join('\n');
}

function around(first: Call, last: Call, failed: Call | undefined = first): string[] {
  return [
    first.before ? `   Before: "${first.before}"` : '',
    failed?.error ? `   Error: ${failed.error.replace(/\n/g, '\n   ')}` : '',
    last.after ? `   After: "${last.after}"` : '',
  ].filter(Boolean);
}

const plain = ({ key: _k, input: _i, ...c }: Call & { key: string; input: Record<string, unknown> }): Call => c;

/** Two calls in a row that are the same attempt again: the same tool on the same thing, a command only slightly changed. */
function similar(a: { tool: string; key: string }, b: { tool: string; key: string }): boolean {
  if (a.tool !== b.tool || !a.key || !b.key) return false;
  if (a.tool !== 'Bash') return a.key === b.key;
  const [x, y] = [a.key.split(/\s+/), b.key.split(/\s+/)];
  if (x[0] !== y[0]) return false;
  const shared = x.filter((t) => y.includes(t)).length;
  return (2 * shared) / (x.length + y.length) >= SIMILAR;
}

/** What makes two calls the same attempt: a command without its `cd` into the workspace, else the file or pattern. */
function keyOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return str(input.command).replace(/^\s*cd\s+\S+\s*&&\s*/, '').trim();
  return str(input.file_path) || str(input.path) || str(input.pattern) || str(input.url) || str(input.skill);
}

function describe(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `\`${clip(keyOf(tool, input).replace(/\s*\n\s*/g, ' ⏎ '), COMMAND)}\``;
  const what = keyOf(tool, input);
  return what ? clip(what, COMMAND) : '';
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** A long error keeps its start and its end, where the cause usually is. */
function shorten(s: string): string {
  const t = s.trim();
  if (t.length <= ERROR_HEAD + ERROR_TAIL + 20) return t;
  return `${t.slice(0, ERROR_HEAD)}\n…\n${t.slice(-ERROR_TAIL)}`;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Results that end a call without the agent having done anything wrong. */
const CUT_OFF = [/^(Error: )?Exit code 137\b/, /^\[Request interrupted/, /doesn't want to proceed/];
/** The tools that change files. */
const CHANGES = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
/** How alike two commands' words must be to count as the same attempt, and how often a command repeated counts without a failure. */
const SIMILAR = 0.6;
const REPEATS = 3;
/** How much of each thing the excerpt keeps. */
const WORDS = 300;
const COMMAND = 300;
const ERROR_HEAD = 400;
const ERROR_TAIL = 400;
const MAX_FINDINGS = 30;
const MAX_TEXT = 15_000;
