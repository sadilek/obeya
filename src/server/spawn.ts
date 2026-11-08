// A program run on this machine and waited for, with what it printed.

/**
 * Whether a process Obeya starts and ends itself goes into a process group of its own (POSIX):
 * Ctrl-C in the terminal goes to the whole foreground group. It reached every agent in the middle
 * of its turn, and what each ran, while Obeya meant to wait for them to pause; a sidecar it reached
 * died with a traceback. Out of that group, Ctrl-C reaches Obeya alone, which ends them itself. Not
 * on Windows, where a detached process has no console and every console program it starts opens a
 * window.
 */
export const OWN_GROUP = process.platform !== 'win32';

/**
 * Makes every console program Obeya starts through `Bun.spawn` or `Bun.spawnSync` (git above all,
 * many times a second while it looks after clones) run without a window, where nothing says
 * otherwise. On Windows a process without a console, as Obeya is when started detached (a scratch
 * Obeya, a launcher without a terminal), gives each console program it starts a window of its own:
 * it flashed up and took the focus from whatever the owner was typing in. A default for all, not
 * an option at each call: one call forgotten brings the flashing back. Node's `child_process`
 * passes its own `windowsHide` (false unless given), so a program that is meant to show (Explorer,
 * a terminal for a login) still does.
 */
export function hideConsoleWindows(platform: string = process.platform) {
  if (platform !== 'win32') return;
  const { spawn, spawnSync } = Bun;
  Bun.spawn = ((...args: unknown[]) => (spawn as (...a: unknown[]) => unknown)(...hidden(args))) as typeof Bun.spawn;
  Bun.spawnSync = ((...args: unknown[]) => (spawnSync as (...a: unknown[]) => unknown)(...hidden(args))) as typeof Bun.spawnSync;
}

/** The arguments of `Bun.spawn(argv, options)` or `Bun.spawn({ cmd, … })`, without a window unless they ask for one. */
export function hidden(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  const hide = (o: unknown) => ({ ...(o as object), windowsHide: (o as { windowsHide?: boolean } | undefined)?.windowsHide ?? true });
  return Array.isArray(first) ? [first, hide(rest[0]), ...rest.slice(1)] : [hide(first), ...rest];
}

/**
 * On Windows, one process starts at a time, across the server's thread and the threads
 * `spawnOutput` starts processes on. Bun starts a process through libuv, which makes the child's
 * ends of its pipes inheritable until the process is created; a process another thread creates in
 * that moment inherits them too and holds them open as long as it runs. A quick git call next to a
 * fetch then reached the end of its output only once the fetch ended. What holds a start: the call
 * of `Bun.spawn` until it returns, the whole of a `Bun.spawnSync` (which starts and waits in one
 * call), node's `child_process` too, which starts through these. Not on macOS and Linux, where the
 * pipes are never inheritable.
 */
const STARTS = process.platform === 'win32' ? new Int32Array(new SharedArrayBuffer(8)) : null;
/**
 * Who holds `STARTS` (its first number, 0 when no one does): the server's thread, or a thread by
 * its number. The second is 1 while the server's thread waits for it.
 */
const SERVER = 1;

/**
 * Takes `lock` for `owner`, waiting while another holds it. The server's thread (owner 1) goes
 * first: while it waits, no thread takes the lock, so the server waits at most for the start
 * underway, not for a queue of them. Self-contained: threads are given its code.
 */
function acquire(lock: Int32Array, owner: number) {
  if (owner === 1) Atomics.store(lock, 1, 1);
  for (;;) {
    if (owner !== 1) for (let first; (first = Atomics.load(lock, 1)) !== 0; ) Atomics.wait(lock, 1, first);
    const held = Atomics.compareExchange(lock, 0, 0, owner);
    if (held === 0) break;
    Atomics.wait(lock, 0, held);
  }
  if (owner === 1) {
    Atomics.store(lock, 1, 0);
    Atomics.notify(lock, 1);
  }
}
/** Gives `lock` back if `owner` still holds it, and wakes whoever waits for it. */
function release(lock: Int32Array, owner: number) {
  Atomics.compareExchange(lock, 0, owner, 0);
  Atomics.notify(lock, 0);
}

/** Makes `Bun.spawn` and `Bun.spawnSync` on the server's thread start one process at a time with the threads (see `STARTS`). */
export function oneStartAtATime() {
  if (!STARTS || oneAtATime) return;
  oneAtATime = true;
  const { spawn, spawnSync } = Bun;
  const lock = STARTS;
  // by these names the stall log leaves them out of where the server waited
  Bun.spawn = function oneAtATimeSpawn(...args: unknown[]) {
    acquire(lock, SERVER);
    try {
      return (spawn as (...a: unknown[]) => unknown)(...args);
    } finally {
      release(lock, SERVER);
    }
  } as typeof Bun.spawn;
  Bun.spawnSync = function oneAtATimeSpawnSync(...args: unknown[]) {
    acquire(lock, SERVER);
    try {
      return (spawnSync as (...a: unknown[]) => unknown)(...args);
    } finally {
      release(lock, SERVER);
    }
  } as typeof Bun.spawnSync;
}
let oneAtATime = false;
/** The functions `oneStartAtATime` puts in front of Bun's, by name. */
export const ONE_AT_A_TIME = ['oneAtATimeSpawn', 'oneAtATimeSpawnSync'];

type Options = Omit<Bun.SpawnOptions.SpawnOptions<Bun.SpawnOptions.Writable, 'pipe', 'pipe'>, 'stdout' | 'stderr'>;
type Output = { code: number; stdout: string; stderr: string; signal: string | null };

/**
 * Where `spawnOutput` starts its processes: on threads of their own, not the server's. Starting a
 * process holds the thread that starts it until the system has created the process, through the
 * async `Bun.spawn` too: on Windows tens of milliseconds on an idle machine, under load (antivirus,
 * many git calls at once) seconds each. A burst of them (a git call in each clone, several
 * landings, the upstream's fetch) held the server up for 10–20 s, in which it answered no page and
 * a WebSocket timed out opening; starting only a few per turn of the event loop shortened none of
 * those stretches. On a thread of its own a slow start holds up only the starts queued behind it
 * there; two threads, so one slow start does not hold up all. The thread's code is a string, not a
 * file: the compiled binary has no file to start it from.
 */
const THREADS = 2;
const THREAD_CODE = `
// first, before any process: a thread that fails without having said so started none
postMessage({ ready: true });
const acquire = ${acquire};
const release = ${release};
let starts = null, owner = 0;
self.onmessage = async ({ data: { id, argv, o, lock } }) => {
  // first, before any process: the lock on starting them (Windows), and who this thread is
  if (lock) return void ({ starts, owner } = lock);
  try {
    if (starts) acquire(starts, owner);
    let p;
    try {
      p = Bun.spawn(argv, { ...o, stdout: 'pipe', stderr: 'pipe' });
    } finally {
      if (starts) release(starts, owner);
    }
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    postMessage({ id, out: { code, stdout, stderr, signal: p.signalCode } });
  } catch (e) {
    postMessage({ id, error: { message: String(e?.message ?? e), code: e?.code, errno: e?.errno, syscall: e?.syscall, path: e?.path } });
  }
};`;

/** The options a thread can be given (what crosses to it is copied): the others start the process on the server's thread. */
const THREADED = new Set(['cwd', 'env', 'stdin', 'timeout', 'killSignal', 'windowsHide', 'windowsVerbatimArguments', 'argv0', 'detached', 'maxBuffer']);

/** A worker as Bun has it: one that may let the server end (`unref`) while it waits for nothing. */
type RefWorker = Worker & { ref(): void; unref(): void };

interface Thread {
  worker: RefWorker;
  waiting: Map<number, { argv: string[]; o: Options; done: (out: Output) => void; failed: (e: Error) => void }>;
  /** Whether its code has run: one that fails before then started no process. */
  ready: boolean;
  /** Set once it failed or ended: it takes no more processes. */
  lost: boolean;
  /** Its number, as it holds `STARTS`. */
  owner: number;
}
const threads: Thread[] = [];
let lastId = 0;
let lastOwner = SERVER;
/**
 * Ends a thread, and gives back `STARTS` if it holds it: ended in the middle of `Bun.spawn`, it
 * never gets to, and every start after would wait forever.
 */
function end(t: Thread) {
  t.worker.terminate();
  if (STARTS) release(STARTS, t.owner);
}
/** Set once a thread could not be started: the processes start on the server's thread then. */
let noThreads = false;

/**
 * Runs `fn` in a turn of the event loop of its own. A promise settled straight from a thread's
 * message stays pending for `expect(…).rejects` and `.resolves` of `bun test` (Bun 1.4.3), which
 * then waits until the test times out; settled from a turn of its own, it is not.
 */
const settle = (fn: () => void) => setImmediate(fn);

/** The thread with the fewest processes waiting, a new one while there are fewer than `THREADS`. */
function thread(): Thread | null {
  const idle = threads.find((t) => !t.waiting.size);
  if (idle || threads.length >= THREADS) return idle ?? threads.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
  if (noThreads) return null;
  let worker: RefWorker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([THREAD_CODE], { type: 'text/javascript' }))) as RefWorker;
  } catch (e) {
    noThreads = true;
    console.error(`Obeya: processes start on the server's thread, a thread of their own failed to start: ${(e as Error).message}`);
    return null;
  }
  // it keeps the server running only while a process it started is waited for
  worker.unref();
  const t: Thread = { worker, waiting: new Map(), ready: false, lost: false, owner: ++lastOwner };
  if (STARTS) worker.postMessage({ lock: { starts: STARTS, owner: t.owner } });
  worker.onmessage = ({ data }: MessageEvent<{ ready?: true; id: number; out?: Output; error?: Error & Record<string, unknown> }>) => {
    if (data.ready) return void (t.ready = true);
    const w = t.waiting.get(data.id);
    if (!w) return;
    t.waiting.delete(data.id);
    if (!t.waiting.size) worker.unref();
    settle(() => (data.out ? w.done(data.out) : w.failed(Object.assign(new Error(data.error?.message), data.error))));
  };
  worker.onerror = (e) => lose(t, e.message);
  // ended without an error (terminated): what it was given would wait forever
  worker.addEventListener('close', () => lose(t, 'it ended'));
  threads.push(t);
  return t;
}

/** Takes a thread that failed or ended out of use, and settles what it was given. */
function lose(t: Thread, why: string) {
  if (t.lost) return;
  t.lost = true;
  threads.splice(threads.indexOf(t), 1);
  end(t);
  if (!t.ready) {
    noThreads = true;
    console.error(`Obeya: processes start on the server's thread, a thread of their own failed to start: ${why}`);
  }
  const given = [...t.waiting.values()];
  t.waiting.clear();
  settle(() => {
    for (const w of given) {
      // one whose code never ran started nothing: what it was given starts here instead. One that
      // ran may have started it: it is not started twice (a push, a landing), it failed
      if (t.ready) w.failed(new Error(`the thread that started ${w.argv[0]} failed: ${why}`));
      else run(w.argv, w.o).then(w.done, w.failed);
    }
  });
}

/** Ends the threads `spawnOutput` starts its processes on, as a thread ends that dies without an error; settles once they have: for tests. */
export function endThreads(): Promise<void> {
  return Promise.all(
    threads.map((t) => {
      const ended = new Promise((go) => t.worker.addEventListener('close', go));
      end(t);
      return ended;
    }),
  ).then(() => new Promise((go) => setImmediate(go)));
}

/**
 * What is told of each process `spawnOutput` is about to start, on the server's thread, with what
 * it will answer: for tests, which see no `Bun.spawn` of it and cannot tell when a thread starts it.
 */
const starting = new Set<(argv: string[], out: Promise<Output>) => void>();
export function onStart(fn: (argv: string[], out: Promise<Output>) => void): () => void {
  starting.add(fn);
  return () => starting.delete(fn);
}

/** Runs `argv` and waits for it: its exit code, its output, and the signal that stopped it (a timeout), if one did. */
export function spawnOutput(argv: string[], o: Options = {}): Promise<Output> {
  // started only after this: the ones told may change what it finds
  const out = start(argv, o);
  for (const fn of starting) fn(argv, out);
  return out;
}

async function start(argv: string[], o: Options): Promise<Output> {
  const given = await threadOptions(o);
  const t = given && thread();
  if (!t) return run(argv, o);
  const id = ++lastId;
  return new Promise<Output>((done, failed) => {
    if (!t.waiting.size) t.worker.ref();
    t.waiting.set(id, { argv, o, done, failed });
    t.worker.postMessage({ id, argv, o: given });
  });
}

/** `o` as a thread is given it: the server's environment where it names none, stdin's bytes; null where an option cannot cross. */
async function threadOptions(o: Options): Promise<Record<string, unknown> | null> {
  if (Object.keys(o).some((k) => !THREADED.has(k))) return null;
  let stdin: unknown = o.stdin;
  if (stdin instanceof Blob) stdin = new Uint8Array(await stdin.arrayBuffer());
  else if (!(stdin == null || typeof stdin === 'string' || ArrayBuffer.isView(stdin))) return null;
  // as hideConsoleWindows does on the server's thread; the thread's environment may be older
  return { ...o, stdin, env: o.env ?? { ...process.env }, windowsHide: o.windowsHide ?? true };
}

async function run(argv: string[], o: Options): Promise<Output> {
  const p = Bun.spawn<Bun.SpawnOptions.Writable, 'pipe', 'pipe'>(argv, { ...o, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr, signal: p.signalCode };
}
