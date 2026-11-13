// Measures what giving up an idle agent's process and resuming its session costs in tokens, against
// keeping the process: for each harness, sessions that do the same first turn, then wait a while
// and take the same two short messages, either in the process kept running ("live") or in one
// that rested in between (`withRest`: the process ended once the turn was over, and the session
// resumed by its id with the next message, as Obeya does). A pause within the prompt cache's
// lifetime shows whether a resume keeps the cached prefix (the whole conversation read from the
// cache); one beyond it shows whether a resumed session writes more to the cache than a live one,
// which then writes its whole prefix anew as well. Runs on the machine's own logins, through
// Obeya's own runtimes.
//
//   bun scripts/measure-resume-cache.ts [--claude] [--codex] [--pauses 2,65] [--modes live,rested] [--repeat <n>] [--out <file.json>]
//
// Pauses are in minutes, counted from the end of the first turn; the run lasts as long as the
// longest. --repeat runs each arm that many times. Without --claude or --codex both run. Prints a
// table and writes every request's usage to --out (default: resume-cache-<time>.json in the system
// temp folder).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { codexRuntime } from '../src/server/codex';
import { OBEYA_PLUGIN } from '../src/server/demo';
import { sdkRuntime } from '../src/server/claude';
import { type AgentEvent, type AgentRuntime, type AgentSession, CODEX_SESSION, withRest } from '../src/server/runtime';
import { ROOT, script } from './common';

const { values } = script('measure-resume-cache').args({
  claude: { type: 'boolean' },
  codex: { type: 'boolean' },
  pauses: { type: 'string' },
  modes: { type: 'string' },
  repeat: { type: 'string' },
  out: { type: 'string' },
});
const harnesses = (['claude', 'codex'] as const).filter((h) => values[h]);
const runs = harnesses.length ? harnesses : (['claude', 'codex'] as const);
const pauses = (values.pauses ?? '2,65').split(',').map(Number);
const MODES = ['live', 'rested'] as const;
type Mode = (typeof MODES)[number];
const modes = (values.modes?.split(',') ?? MODES) as Mode[];
const out = values.out ?? join(tmpdir(), `resume-cache-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const FIRST =
  'Read the files guide-1.md, guide-2.md and guide-3.md in this folder, each in full with your file reading tool (not the shell), then answer in one sentence: what do they describe?';
const SECOND = 'Reply with the single word OK, nothing else.';
const THIRD = 'Reply with the single word DONE, nothing else.';
/** Between the second and the third message: long enough for whatever a resumed session connects in the background (claude.ai's MCP servers) to have connected. */
const FOLLOW_MS = 90_000;

/** A folder for one session, with files that make its first turn's prompt a realistic size. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resume-cache-'));
  for (const [i, f] of ['communication.md', 'card-lifecycle.md', 'landing.md'].entries())
    writeFileSync(join(dir, `guide-${i + 1}.md`), readFileSync(join(ROOT, 'docs/design', f), 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=m', '-c', 'user.email=m@example.com', 'commit', '-qm', 'guides', '--allow-empty'], { cwd: dir });
  return dir;
}

/** A session driven turn by turn: `turn` sends a message and settles when the session is idle again. */
function drive(runtime: AgentRuntime, harness: 'claude' | 'codex', cwd: string) {
  let id: string | undefined;
  let idle: (() => void) | undefined;
  let failure: string | undefined;
  let session: AgentSession | undefined;
  const spec = {
    cwd,
    harness,
    effort: 'high' as const,
    // in place of a worker's instructions: as long, and the same at every start
    system: readFileSync(join(ROOT, 'docs/design/agents-and-workspaces.md'), 'utf8'),
    tools: [{ name: 'report', description: 'Show the owner one short status line.', schema: { status: z.string() }, run: () => 'Shown.' }],
    plugins: [OBEYA_PLUGIN],
    onEvent: (e: AgentEvent) => {
      if (e.type === 'session') id = e.id;
      if (e.type === 'error') failure = e.message;
      if (e.type === 'idle' && !e.more) idle?.();
    },
  };
  const turn = (text: string) =>
    new Promise<void>((resolve, reject) => {
      idle = () => (failure ? reject(new Error(failure)) : resolve());
      if (!session) session = runtime.start(spec, text);
      else session.send(text);
    });
  return {
    turn,
    id: () => id!,
    close: async () => {
      session?.close();
      await session?.done;
    },
  };
}

type Request = { at: string; read: number; write: number; uncached: number; output: number };

/** Every request of a Claude Code session's main conversation, from its transcript. */
function claudeRequests(id: string): Request[] {
  const projects = join(homedir(), '.claude/projects');
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${id}.jsonl`)));
  if (!dir) throw new Error(`no transcript of session ${id}`);
  const seen = new Set<string>();
  const requests: Request[] = [];
  for (const line of readFileSync(join(projects, dir, `${id}.jsonl`), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.isSidechain || e.type !== 'assistant' || !e.message?.usage || !e.requestId || seen.has(e.requestId)) continue;
    seen.add(e.requestId);
    const u = e.message.usage;
    requests.push({ at: e.timestamp, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, uncached: u.input_tokens ?? 0, output: u.output_tokens ?? 0 });
  }
  return requests;
}

/** Every request of a Codex thread, from its rollout (Codex reports no cache writes: what is not read from the cache is uncached input). */
function codexRequests(id: string): Request[] {
  const thread = id.slice(CODEX_SESSION.length);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.includes(thread) && files.push(join(d, f.name));
  };
  walk(join(homedir(), '.codex/sessions'));
  const requests: Request[] = [];
  for (const file of files.sort())
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"token_count"')) continue;
      const e = JSON.parse(line);
      const u = e.payload?.info?.last_token_usage;
      if (!u) continue;
      requests.push({ at: e.timestamp, read: u.cached_input_tokens ?? 0, write: u.cache_write_input_tokens ?? 0, uncached: u.input_tokens - (u.cached_input_tokens ?? 0), output: u.output_tokens ?? 0 });
    }
  // the same request reported twice (a resumed rollout repeating its last count) counts once
  return requests.filter((r, i) => i === 0 || r.at !== requests[i - 1]!.at);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One session: the first turn, the pause (its process kept, or given up early in it and resumed with the next message), then the two short messages. */
async function arm(harness: 'claude' | 'codex', mode: Mode, pause: number) {
  const base = harness === 'claude' ? sdkRuntime : codexRuntime;
  const runtime = mode === 'rested' ? withRest(base, Math.min(10_000, pause * 30_000)) : base;
  const session = drive(runtime, harness, folder());
  await session.turn(FIRST);
  await sleep(pause * 60_000);
  await session.turn(SECOND);
  await sleep(FOLLOW_MS);
  await session.turn(THIRD);
  await session.close();
  const id = session.id();
  const requests = harness === 'claude' ? claudeRequests(id) : codexRequests(id);
  return { harness, mode, pause, id, requests };
}

type Arm = Awaited<ReturnType<typeof arm>>;

const prompt = (q: Request) => q.read + q.write + q.uncached;

/** The three requests that matter: the first turn's last, and the answers to the second and third message. */
function summary(a: Arm) {
  const [before, second, third] = a.requests.slice(-3) as [Request, Request, Request];
  return {
    arm: `${a.harness} ${a.mode} ${a.pause} min`,
    'prefix before': prompt(before),
    '2nd: read': second.read,
    '2nd: written': second.write,
    '2nd: uncached': second.uncached,
    '2nd: new tokens': prompt(second) - prompt(before) - before.output,
    '3rd: read': third.read,
    '3rd: written': third.write,
    '3rd: uncached': third.uncached,
    '3rd: new tokens': prompt(third) - prompt(second) - second.output,
  };
}

const repeat = Number(values.repeat ?? 1);
const arms: Promise<Arm | { failed: string }>[] = [];
for (const harness of runs)
  for (const pause of pauses)
    for (const mode of modes) for (let n = 0; n < repeat; n++) arms.push(arm(harness, mode, pause).catch((e) => ({ failed: `${harness} ${mode} ${pause} min: ${e instanceof Error ? e.message : e}` })));
const results = await Promise.all(arms);
writeFileSync(out, JSON.stringify(results, null, 2));
for (const r of results) if ('failed' in r) console.log(`✗ ${r.failed}`);
console.table(results.filter((r): r is Arm => !('failed' in r) && r.requests.length >= 3).map(summary));
console.log(`every request: ${out}`);
