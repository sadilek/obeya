import { expect, test } from 'bun:test';
import { type AgentEvent, claudeUnreachable, cleanEnv, failureReason, OUTAGE_OVER, outageRetry, withLimitWait, withRepoTrust, withRest, withSpend } from './runtime';
import { MESSAGES } from '../core/messages';
import { FakeRuntime } from './testing';

test('an agent with onLimit waits for the usage limit and goes on where it stopped once it lifts; one without fails on it', async () => {
  const fake = new FakeRuntime();
  const runtime = withLimitWait(fake, 10);
  const events: AgentEvent[] = [];
  const waits: (number | undefined)[] = [];
  const session = runtime.start({ cwd: '/r', system: '', tools: [], onLimit: (until) => waits.push(until), onEvent: (e) => events.push(e) }, 'Los.');
  const s = fake.last;
  const limit = (ms: number) => {
    s.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + ms } });
    s.emit({ type: 'idle' });
  };
  limit(20);
  // neither the error nor the end of the turn it stopped
  expect(events).toEqual([]);
  expect(waits).toHaveLength(1);
  expect(waits[0]! - Date.now()).toBeGreaterThan(20);
  await new Promise((r) => setTimeout(r, 50));
  expect(waits.at(-1)).toBeUndefined();
  expect(s.inbox).toEqual(['Los.', 'The usage limit that stopped your last turn has reset. Go on where you stopped.']);
  // a turn after it ends as ever; another error is one
  s.emit({ type: 'idle' });
  s.emit({ type: 'error', message: 'boom' });
  expect(events).toEqual([{ type: 'idle' }, { type: 'error', message: 'boom' }]);
  // closed while it waits, it waits no more
  limit(10_000);
  expect(waits).toHaveLength(3);
  session.close();
  expect(waits).toHaveLength(4);
  expect(waits.at(-1)).toBeUndefined();
  expect(s.closed).toBe(true);
  await new Promise((r) => setTimeout(r, 30));
  expect(s.inbox).toHaveLength(2);

  // without onLimit, the limit is the agent's to handle
  const plain: AgentEvent[] = [];
  runtime.start({ cwd: '/r', system: '', tools: [], onEvent: (e) => plain.push(e) }, 'Los.');
  fake.last.emit({ type: 'error', message: 'limit', limit: {} });
  expect(plain).toEqual([{ type: 'error', message: 'limit', limit: {} }]);
});

test('an agent with onLimit waits out an outage the same way, told so, and tries again later each time it fails', async () => {
  const fake = new FakeRuntime();
  const runtime = withLimitWait(fake, 10);
  const events: AgentEvent[] = [];
  const waits: [number | undefined, boolean | undefined][] = [];
  runtime.start({ cwd: '/r', system: '', tools: [], onLimit: (until, outage) => waits.push([until, outage]), onEvent: (e) => events.push(e) }, 'Los.');
  const s = fake.last;
  s.emit({ type: 'error', message: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', limit: { resetsAt: Date.now() + 20, outage: true } });
  s.emit({ type: 'idle' });
  expect(events).toEqual([]);
  expect(waits[0]![1]).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(waits.at(-1)).toEqual([undefined, undefined]);
  expect(s.inbox.at(-1)).toBe(OUTAGE_OVER);
});

test('the turns an outage stopped are tried again soon at first, then every quarter of an hour', () => {
  const now = Date.parse('2026-11-13T10:15:00Z');
  expect([0, 1, 2, 3, 4, 5, 40].map((n) => (outageRetry(n, now) - now) / 60_000)).toEqual([1, 2, 5, 10, 15, 15, 15]);
});

test('a failure that says the Claude API could not be reached is an outage; a refusal of the API itself is not', () => {
  for (const m of [
    'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare',
    'API Error: 403 <html><head><title>Attention Required! | Cloudflare</title>',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: Repeated 529 Overloaded errors',
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'API Error: 503 Service Unavailable',
    'API Error: Connection error.',
    'API Error: Request timed out.',
  ])
    expect([m, claudeUnreachable(m)]).toEqual([m, true]);
  for (const m of [
    'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your organization does not have access"}}',
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
    "You've hit your session limit · resets 2:40pm",
    'Not logged in · Please run /login',
  ])
    expect([m, claudeUnreachable(m)]).toEqual([m, false]);
  expect(failureReason('Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', MESSAGES.en)).toContain('status.claude.com');
  // a lost login stays one
  expect(failureReason('Failed to authenticate. API Error: 401 Invalid bearer token', MESSAGES.en)).toBe(MESSAGES.en.failure.notLoggedIn);
});

test("an agent's environment keeps a machine's Claude login but not another session's marks", () => {
  const env = cleanEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', OBEYA_SUPERVISED: '1', OBEYA_FROM_APP: '1', BUN_BE_BUN: '1' });
  expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
});

test('a session waiting past the prompt cache gives up its process, and the next message resumes it by its id', async () => {
  const fake = new FakeRuntime();
  const runtime = withRest(fake, 30);
  const events: AgentEvent[] = [];
  let ended = false;
  const session = runtime.start({ cwd: '/r', system: 'You work on a card.', tools: [], onEvent: (e) => events.push(e) }, 'Go.');
  void session.done.then(() => (ended = true));
  const first = fake.last;
  first.emit({ type: 'session', id: 's1' });
  // in a turn, and waiting for its background work, it keeps its process
  await Bun.sleep(60);
  first.emit({ type: 'idle', background: 1 });
  await Bun.sleep(60);
  expect(first.closed).toBe(false);
  // the work ends without a turn after it: now it only waits
  first.emit({ type: 'background', tasks: [] });
  await Bun.sleep(60);
  expect(first.closed).toBe(true);
  expect(fake.sessions).toHaveLength(1);
  expect(ended).toBe(false);
  // what the process given up still says counts for nothing
  first.emit({ type: 'text', text: 'late' });
  expect(events.map((e) => e.type)).toEqual(['session', 'idle', 'background']);
  session.send('Feedback.');
  await Bun.sleep(0);
  const second = fake.last;
  expect(fake.sessions).toHaveLength(2);
  expect(second.spec.resume).toBe('s1');
  expect(second.spec.system).toBe('You work on a card.');
  expect(second.inbox).toEqual(['Feedback.']);
  second.emit({ type: 'text', text: 'On it.' });
  expect(events.at(-1)).toEqual({ type: 'text', text: 'On it.' });
  // a message after the turn's end keeps it awake; the turn's end with another to follow too
  second.emit({ type: 'idle', more: true });
  await Bun.sleep(60);
  expect(second.closed).toBe(false);
  second.emit({ type: 'idle' });
  await Bun.sleep(10);
  session.send('More.');
  await Bun.sleep(60);
  expect(second.closed).toBe(false);
  expect(second.inbox).toEqual(['Feedback.', 'More.']);
  // closed, the session ends; and one closed while resting ends at once
  session.close();
  await session.done;
  expect(second.closed).toBe(true);
  const other = runtime.start({ cwd: '/r', system: '', tools: [], onEvent: () => {} }, 'Go.');
  fake.last.emit({ type: 'session', id: 's2' });
  fake.last.emit({ type: 'idle' });
  await Bun.sleep(60);
  other.close();
  await other.done;
  expect(fake.sessions).toHaveLength(3);
});

test('a session that never said its id keeps its process: it could not be resumed', async () => {
  const fake = new FakeRuntime();
  withRest(fake, 10).start({ cwd: '/r', system: '', tools: [], onEvent: () => {} }, 'Go.');
  fake.last.emit({ type: 'idle' });
  await Bun.sleep(40);
  expect(fake.last.closed).toBe(false);
});

test("an agent whose repository's trust takes git to tell starts once it is told, with what it was sent meanwhile; closed before, it never starts", async () => {
  const fake = new FakeRuntime();
  let tell!: (held: boolean) => void;
  const runtime = withRepoTrust(fake, () => new Promise<boolean>((r) => (tell = r)));
  const spec = { cwd: '/nowhere', system: 'Work.', tools: [], onEvent: () => {} };
  const session = runtime.start(spec, 'Start.');
  session.send('And this.');
  expect(fake.sessions).toHaveLength(0);
  tell(true);
  await Bun.sleep(0);
  expect(fake.last.spec.untrusted).toBe(true);
  expect(fake.last.inbox).toEqual(['Start.', 'And this.']);
  session.close();
  expect(fake.last.closed).toBe(true);
  await session.done;

  const closed = runtime.start(spec, 'Start.');
  closed.close();
  tell(false);
  await closed.done;
  expect(fake.sessions).toHaveLength(1);
});

test("an agent's cost goes to the card it works for, else to the canvas, and never to the agent's own handler", () => {
  const fake = new FakeRuntime();
  const spent: [string | undefined, string, number][] = [];
  const runtime = withSpend(fake, (card, session, usd) => spent.push([card, session, usd]));
  const events: AgentEvent[] = [];
  runtime.start({ cwd: '/r', system: '', tools: [], spendOn: 'card-1', onEvent: (e) => events.push(e) }, 'Los.');
  fake.last.emit({ type: 'spend', session: 's1', usd: 0.5 });
  fake.last.emit({ type: 'idle' });
  runtime.start({ cwd: '/r', system: '', tools: [], onEvent: (e) => events.push(e) }, 'Los.');
  fake.last.emit({ type: 'spend', session: 's2', usd: 0.25 });
  expect(spent).toEqual([
    ['card-1', 's1', 0.5],
    [undefined, 's2', 0.25],
  ]);
  expect(events).toEqual([{ type: 'idle' }]);
});
