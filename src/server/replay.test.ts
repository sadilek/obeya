import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CUT_MS, GAP_MS, paced, readRecording, recordingRuntime, replayRuntime, Swap } from './replay';
import type { AgentEvent, AgentSpec, AgentTool } from './runtime';
import { onStart } from './spawn';
import { FakeRuntime, gitRepo, identify, until } from './testing';
import { git } from './workspaces';

const THEN = '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c';
const NOW = 'b81c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

/** An agent of `role` on the card `id`, in the scratch Obeya `dir`: what the tools were called with and what it said go into `heard`. */
function agent(dir: string, id: string, heard: { calls: Record<string, unknown>[]; events: AgentEvent[] }, o: { system?: string; schema?: AgentTool['schema']; refuse?: boolean } = {}): AgentSpec {
  return {
    cwd: join(dir, 'home', 'workspaces', 'tipjar', id.slice(0, 8)),
    role: 'koordinator',
    system: o.system ?? `You work on the card ${id}, on the branch obeya/split-the-bill-${id.slice(0, 6)}.`,
    tools: [
      {
        name: 'report',
        description: 'A status line.',
        schema: o.schema ?? { status: z.string() },
        run: (args) => {
          heard.calls.push(args);
          return o.refuse ? 'Not shown: the card is done.' : `Shown on ${id}.`;
        },
      },
    ],
    onEvent: (e) => heard.events.push(e),
  };
}

const heard = () => ({ calls: [] as Record<string, unknown>[], events: [] as AgentEvent[] });

/** A recorded session in `rec` of a scratch Obeya in `<root>/a`: two turns, the second on a message. */
async function recordTwoTurns(root: string, rec: string) {
  const fake = new FakeRuntime();
  const then = heard();
  const session = recordingRuntime(fake, rec, join(root, 'a', 'home')).start(agent(join(root, 'a'), THEN, then), `Start on ${THEN}.`);
  const s = fake.last;
  s.emit({ type: 'session', id: 'the-session' });
  s.emit({ type: 'text', text: `On obeya/split-the-bill-${THEN.slice(0, 6)} in ${join(root, 'a', 'home', 'workspaces', 'tipjar', THEN.slice(0, 8))}` });
  s.emit({ type: 'tool', name: 'mcp__obeya__report', input: { status: `Building ${THEN}` } });
  expect(await s.call('report', { status: `Building ${THEN}` })).toBe(`Shown on ${THEN}.`);
  s.emit({ type: 'idle' });
  session.send(`Comments on ${THEN}: start at two.`);
  s.emit({ type: 'text', text: 'Took them in.' });
  s.emit({ type: 'idle' });
  return then;
}

/** Settles once the recording has read the workspace's HEAD at a session's start: a commit before then would count as there from the start. */
const headRead = () =>
  new Promise<void>((read) => {
    const stop = onStart((argv, out) => {
      if (!argv.includes('rev-parse')) return;
      stop();
      out.then(() => read(), () => read());
    });
  });

test('a recorded session plays back with the ids and paths of the staging, its second turn on a message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const then = await recordTwoTurns(root, rec);
  expect(then.calls).toEqual([{ status: `Building ${THEN}` }]);
  expect(readRecording(rec).sessions[0]!.entries.map((e) => e.type)).toEqual(['event', 'event', 'event', 'call', 'event', 'send', 'event', 'event']);

  const now = heard();
  const session = replayRuntime(rec, { home: join(root, 'b', 'home'), log: () => {} }).start(agent(join(root, 'b'), NOW, now), `Start on ${NOW}.`);
  await until(() => now.events.some((e) => e.type === 'idle'));
  expect(now.events).toEqual([
    { type: 'session', id: 'the-session' },
    { type: 'text', text: `On obeya/split-the-bill-${NOW.slice(0, 6)} in ${join(root, 'b', 'home', 'workspaces', 'tipjar', NOW.slice(0, 8))}` },
    { type: 'tool', name: 'mcp__obeya__report', input: { status: `Building ${NOW}` } },
    { type: 'idle' },
  ]);
  // Obeya's own tool ran, with today's card
  expect(now.calls).toEqual([{ status: `Building ${NOW}` }]);
  // the second turn waits for its message
  await Bun.sleep(50);
  expect(now.events).toHaveLength(4);
  session.send(`Comments on ${NOW}: start at two.`);
  await until(() => now.events.length === 6);
  expect(now.events.slice(4)).toEqual([{ type: 'text', text: 'Took them in.' }, { type: 'idle' }]);
  // a message past the recording gets a turn that ends at once
  session.send('Landed on main.');
  await until(() => now.events.length === 7);
  expect(now.events[6]).toEqual({ type: 'idle' });
});

test('changed instructions or a changed tool refuse the playback, with why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  await recordTwoTurns(root, rec);
  const cases: [Parameters<typeof agent>[3], RegExp][] = [
    [{ system: `You work carefully on the card ${NOW}, on the branch obeya/split-the-bill-${NOW.slice(0, 6)}.` }, /instructions of the koordinator changed .*line 1/],
    [{ schema: { status: z.string(), at: z.number() } }, /schema of the koordinator's tool report changed/],
    // the recording no longer fits what the tool takes now
    [{ refuse: true }, /report refuses now what it took in the recording: Not shown/],
  ];
  for (const [i, [o, why]] of cases.entries()) {
    const refused: string[] = [];
    const now = heard();
    replayRuntime(rec, { home: join(root, `b${i}`, 'home'), refused: (w) => refused.push(w), log: () => {} }).start(agent(join(root, `b${i}`), NOW, now, o), `Start on ${NOW}.`);
    await until(() => now.events.some((e) => e.type === 'idle'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(why);
    const error = now.events.find((e) => e.type === 'error');
    expect(error && 'message' in error && error.message).toMatch(/^Replay refused: .*Record this demo anew/);
  }
});

test('an agent the recording has none for ends each turn at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  await recordTwoTurns(root, rec);
  const replay = replayRuntime(rec, { home: join(root, 'b', 'home'), log: () => {} });
  replay.start(agent(join(root, 'b'), NOW, heard()), `Start on ${NOW}.`);
  const other = heard();
  const session = replay.start({ ...agent(join(root, 'b'), NOW, other), role: 'chores' }, 'Look back.');
  await until(() => other.events.length === 1);
  session.send('And again.');
  await until(() => other.events.length === 2);
  expect(other.events).toEqual([{ type: 'idle' }, { type: 'idle' }]);
});

test('a handover plays the recorded commits into the workspace of today and its demo back where it was', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const worker = (dir: string, calls: Record<string, unknown>[], events: AgentEvent[] = []): AgentSpec => ({
    cwd: join(dir, 'ws'),
    role: 'worker',
    system: 'You build the card.',
    tools: [
      {
        name: 'ready_for_review',
        description: 'Hand over.',
        schema: { summary: z.string(), demo: z.object({ dir: z.string() }).optional() },
        run: (args) => {
          const d = (args.demo as { dir: string }).dir;
          calls.push({ ...args, log: git(join(dir, 'ws'), 'log', '--format=%s', 'main..HEAD'), video: readFileSync(join(d, 'demo.mp4'), 'utf8') });
          return 'Handed over.';
        },
      },
    ],
    onEvent: (e) => events.push(e),
  });
  // recorded: the worker commits on its branch and records a demo outside the workspace
  const a = join(root, 'a');
  gitRepo(join(a, 'ws'), { 'calc.js': 'export const tip = 0.15;\n' });
  identify(join(a, 'ws'));
  git(join(a, 'ws'), 'checkout', '-q', '-b', 'obeya/split');
  const fake = new FakeRuntime();
  const then: Record<string, unknown>[] = [];
  const started = headRead();
  recordingRuntime(fake, rec, join(a, 'home')).start(worker(a, then), 'Build it.');
  await started;
  writeFileSync(join(a, 'ws', 'split.js'), 'export const split = (bill, people) => bill / people;\n');
  git(join(a, 'ws'), 'add', '-A');
  git(join(a, 'ws'), 'commit', '-qm', 'Split the bill');
  mkdirSync(join(a, 'demos', 'split', '.work'), { recursive: true });
  writeFileSync(join(a, 'demos', 'split', 'demo.mp4'), 'the video');
  writeFileSync(join(a, 'demos', 'split', '.work', 'frame.png'), 'a frame');
  await fake.last.call('ready_for_review', { summary: 'Done.', demo: { dir: join(a, 'demos', 'split') } });
  fake.last.emit({ type: 'idle' });
  expect(then[0]).toMatchObject({ log: 'Split the bill', video: 'the video' });

  // played back: a workspace whose main is another commit of the same files, and no demo yet
  const b = join(root, 'b');
  gitRepo(join(b, 'ws'), { 'calc.js': 'export const tip = 0.15;\n' });
  identify(join(b, 'ws'));
  git(join(b, 'ws'), 'commit', '-q', '--amend', '--no-edit', '--date=2001-01-01T00:00:00');
  git(join(b, 'ws'), 'checkout', '-q', '-b', 'obeya/split');
  const now: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [];
  replayRuntime(rec, { home: join(b, 'home'), log: () => {} }).start(worker(b, now, events), 'Build it.');
  await until(() => events.some((e) => e.type === 'idle'));
  expect(now).toEqual([{ summary: 'Done.', demo: { dir: join(b, 'demos', 'split') }, log: 'Split the bill', video: 'the video' }]);
  expect(readFileSync(join(b, 'ws', 'split.js'), 'utf8')).toContain('bill / people');
  // the demo's work files stay out of the recording
  expect(existsSync(join(b, 'demos', 'split', '.work'))).toBe(false);
});

test('a gap plays back as recorded, what the take cut out of it in a moment; without cuts no gap is long', () => {
  expect(paced(0, 5000, [])).toBe(5000);
  expect(paced(0, 5000, [{ from: 1000, to: 4000 }])).toBe(2000 + CUT_MS);
  expect(paced(0, 5000, [{ from: 4000, to: 9000 }])).toBe(4000 + CUT_MS);
  expect(paced(0, 600, [{ from: 0, to: 9000 }])).toBe(CUT_MS);
  expect(paced(0, 60_000, undefined)).toBe(GAP_MS);
  expect(paced(0, 500, undefined)).toBe(500);
});

test('the ids a text held then and holds now stand for each other, their starts too', () => {
  const swap = new Swap();
  swap.path('/tmp/obeya-scratch-4481', '/tmp/obeya-scratch-4502');
  swap.learn(`card ${THEN} in /tmp/obeya-scratch-4481/home, commit 1a2b3c4d`, `card ${NOW} in /tmp/obeya-scratch-4502/home, commit 9f8e7d6c`);
  expect(swap.text(`obeya/split-the-bill-${THEN.slice(0, 6)} at /tmp/obeya-scratch-4481/home/workspaces/tipjar/${THEN.slice(0, 8)}, after 1a2b3c4d`)).toBe(
    `obeya/split-the-bill-${NOW.slice(0, 6)} at /tmp/obeya-scratch-4502/home/workspaces/tipjar/${NOW.slice(0, 8)}, after 9f8e7d6c`,
  );
  // words are no ids, and texts that differ in more than their ids teach nothing
  expect(swap.text('a decade of facade')).toBe('a decade of facade');
  swap.learn('card 0a0a0a0a and 1b1b1b1b', 'card 2c2c2c2c');
  expect(swap.text('0a0a0a0a')).toBe('0a0a0a0a');
  expect(swap.deep({ list: [`for ${THEN}`], n: 3 })).toEqual({ list: [`for ${NOW}`], n: 3 });
});

test("a worker's commits go into the workspace at its next call; rewritten ones as one commit of what changed, none where it is there already", async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const worker = (dir: string, seen: string[], events: AgentEvent[] = []): AgentSpec => ({
    cwd: join(dir, 'ws'),
    role: 'worker',
    system: 'You build the card.',
    tools: [{ name: 'report', description: 'A status line.', schema: { status: z.string() }, run: () => (seen.push(git(join(dir, 'ws'), 'log', '--format=%s', '-3').replace(/\n/g, ' | ')), 'Shown.') }],
    onEvent: (e) => events.push(e),
  });
  const commit = (ws: string, file: string, message: string) => {
    writeFileSync(join(ws, file), `${message}\n`);
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', message);
  };
  const a = join(root, 'a');
  gitRepo(join(a, 'ws'));
  identify(join(a, 'ws'));
  const fake = new FakeRuntime();
  const started = headRead();
  recordingRuntime(fake, rec, join(a, 'home')).start(worker(a, []), 'Build it.');
  await started;
  commit(join(a, 'ws'), 'one.txt', 'First step');
  await fake.last.call('report', { status: 'One step' });
  // amended
  writeFileSync(join(a, 'ws', 'one.txt'), 'First step, amended\n');
  git(join(a, 'ws'), 'commit', '-qa', '--amend', '--no-edit');
  await fake.last.call('report', { status: 'Amended' });
  // the same files again under another commit (a rebase onto a main that did not move)
  git(join(a, 'ws'), 'commit', '-q', '--amend', '--no-edit', '--date=2001-01-01T00:00:00');
  await fake.last.call('report', { status: 'Rebased' });
  fake.last.emit({ type: 'idle' });
  expect(readRecording(rec).sessions[0]!.entries.flatMap((e) => (e.type === 'call' ? [e.head ? (e.head.rewritten ? 'rewritten' : 'new') : 'none'] : []))).toEqual(['new', 'rewritten', 'rewritten']);

  const b = join(root, 'b');
  gitRepo(join(b, 'ws'));
  identify(join(b, 'ws'));
  const seen: string[] = [];
  const events: AgentEvent[] = [];
  replayRuntime(rec, { home: join(b, 'home'), log: () => {} }).start(worker(b, seen, events), 'Build it.');
  await until(() => events.some((e) => e.type === 'idle'));
  expect(seen).toEqual(['First step | init', 'First step | First step | init', 'First step | First step | init']);
  expect(readFileSync(join(b, 'ws', 'one.txt'), 'utf8')).toBe('First step, amended\n');
});

test("a handover with a merge of main into a pull request's head plays back as that merge, onto the head and main of today", async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const worker = (dir: string, seen: string[], events: AgentEvent[] = []): AgentSpec => ({
    cwd: join(dir, 'ws'),
    role: 'worker',
    system: 'You review the pull request.',
    tools: [{ name: 'ready_for_review', description: 'Hand over.', schema: { summary: z.string() }, run: () => (seen.push(git(join(dir, 'ws'), 'log', '-1', '--format=%s, after %p')), 'Handed over.') }],
    onEvent: (e) => events.push(e),
  });
  /** A forge whose main moved on after a pull request branched off it, in its lines too, and a workspace cloned before: each commit of `date`, so two stagings differ in every hash. */
  const stage = (dir: string, date: string) => {
    const forge = join(dir, 'forge');
    gitRepo(forge, { 'sync.ts': 'send(notes);\n' });
    git(forge, 'commit', '-q', '--amend', '--no-edit', `--date=${date}`);
    git(join(dir), 'clone', '-q', forge, 'ws');
    identify(join(dir, 'ws'));
    git(forge, 'checkout', '-q', '-b', 'pr-12');
    writeFileSync(join(forge, 'sync.ts'), 'send(notes.filter(filled));\n');
    git(forge, 'commit', '-qam', 'Skip empty notes', `--date=${date}`, '--author=Mara <mara@example.com>');
    git(forge, 'update-ref', 'refs/pull/12/head', 'HEAD');
    git(forge, 'checkout', '-q', 'main');
    writeFileSync(join(forge, 'sync.ts'), 'retry(() => send(notes));\n');
    git(forge, 'commit', '-qam', 'Retry a failed send', `--date=${date}`);
    return forge;
  };
  const a = join(root, 'a');
  stage(a, '2001-01-01T00:00:00');
  const ws = join(a, 'ws');
  const fake = new FakeRuntime();
  const started = headRead();
  recordingRuntime(fake, rec, join(a, 'home')).start(worker(a, []), 'Review PR #12.');
  await started;
  // recorded: the reviewer takes the pull request's head and merges main into it, resolving the conflict
  git(ws, 'fetch', '-q', 'origin');
  git(ws, 'fetch', '-q', 'origin', 'refs/pull/12/head');
  git(ws, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  expect(() => git(ws, 'merge', '-q', '--no-ff', 'origin/main', '-m', 'Merge main into pr-12')).toThrow();
  writeFileSync(join(ws, 'sync.ts'), 'retry(() => send(notes.filter(filled)));\n');
  git(ws, 'commit', '-qam', 'Merge main into pr-12');
  await fake.last.call('ready_for_review', { summary: 'Merged main in.' });
  fake.last.emit({ type: 'idle' });

  // played back: the same stage of another date, the workspace without the head or main of today
  const b = join(root, 'b');
  const forge = stage(b, '2002-02-02T00:00:00');
  const seen: string[] = [];
  const events: AgentEvent[] = [];
  replayRuntime(rec, { home: join(b, 'home'), log: () => {} }).start(worker(b, seen, events), 'Review PR #12.');
  await until(() => events.some((e) => e.type === 'idle'));
  expect(events.filter((e) => e.type === 'error')).toEqual([]);
  const now = join(b, 'ws');
  // the merge's parents are the pull request's head and main as staged today, which the workspace had not fetched
  expect(seen).toEqual([`Merge main into pr-12, after ${git(forge, 'rev-parse', '--short', 'refs/pull/12/head')} ${git(forge, 'rev-parse', '--short', 'main')}`]);
  expect(readFileSync(join(now, 'sync.ts'), 'utf8')).toBe('retry(() => send(notes.filter(filled)));\n');
  expect(git(now, 'status', '--porcelain')).toBe('');
});

test('of two recorded agents of a kind, each gets its own, whichever starts first; a changed set of tools refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const fake = new FakeRuntime();
  const recording = recordingRuntime(fake, rec, join(root, 'a', 'home'));
  const OTHER = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a';
  for (const [id, title] of [[THEN, 'Split'], [OTHER, 'Comma']] as const) {
    recording.start(agent(join(root, 'a'), id, heard()), `Build ${title} on ${id}.`);
    await fake.last.call('report', { status: `${title} built` });
    fake.last.emit({ type: 'idle' });
  }
  const now = heard();
  const replay = replayRuntime(rec, { home: join(root, 'b', 'home'), log: () => {} });
  replay.start(agent(join(root, 'b'), NOW, now), `Build Comma on ${NOW}.`);
  await until(() => now.calls.length === 1);
  expect(now.calls).toEqual([{ status: 'Comma built' }]);

  const refused: string[] = [];
  const more = agent(join(root, 'c'), NOW, heard());
  replayRuntime(rec, { home: join(root, 'c', 'home'), refused: (w) => refused.push(w), log: () => {} }).start(
    { ...more, tools: [...more.tools, { name: 'ask', description: 'A question.', schema: {}, run: () => '' }] },
    `Build Split on ${NOW}.`,
  );
  await until(() => refused.length === 1);
  expect(refused[0]).toMatch(/new tool, ask/);
});

test('a session that ended by itself ends when played back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = join(root, 'rec');
  const fake = new FakeRuntime();
  recordingRuntime(fake, rec, join(root, 'a', 'home')).start(agent(join(root, 'a'), THEN, heard()), 'Go.');
  fake.last.emit({ type: 'error', message: 'Claude Code exited' });
  // the SDK's session settles without close
  (fake.last as unknown as { finish: () => void }).finish();
  await until(() => readRecording(rec).sessions[0]!.entries.some((e) => e.type === 'end'));
  const now = heard();
  const session = replayRuntime(rec, { home: join(root, 'b', 'home'), log: () => {} }).start(agent(join(root, 'b'), NOW, now), 'Go.');
  await session.done;
  expect(now.events).toEqual([{ type: 'error', message: 'Claude Code exited' }]);
});

test('a path moved to one that holds the other is moved once', () => {
  const swap = new Swap();
  swap.path('/tmp/take-4481', '/tmp/take-44810');
  swap.path('/tmp/take-4481/home', '/tmp/take-44810/home');
  expect(swap.text('/tmp/take-4481/home/x and /tmp/take-4481/repo')).toBe('/tmp/take-44810/home/x and /tmp/take-44810/repo');
});
