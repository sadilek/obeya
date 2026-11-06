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
self.onmessage = async ({ data: { id, argv, o } }) => {
  try {
    const p = Bun.spawn(argv, { ...o, stdout: 'pipe', stderr: 'pipe' });
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
  /** Whether it has answered: one that fails before it ever has did not start. */
  answered: boolean;
}
const threads: Thread[] = [];
let lastId = 0;
/** Set once a thread could not be started: the processes start on the server's thread then. */
let noThreads = false;

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
  const t: Thread = { worker, waiting: new Map(), answered: false };
  worker.onmessage = ({ data }: MessageEvent<{ id: number; out?: Output; error?: Error & Record<string, unknown> }>) => {
    const w = t.waiting.get(data.id);
    t.answered = true;
    if (!w) return;
    t.waiting.delete(data.id);
    if (!t.waiting.size) worker.unref();
    if (data.out) w.done(data.out);
    else w.failed(Object.assign(new Error(data.error?.message), data.error));
  };
  worker.onerror = (e) => {
    threads.splice(threads.indexOf(t), 1);
    worker.terminate();
    if (!t.answered) {
      noThreads = true;
      console.error(`Obeya: processes start on the server's thread, a thread of their own failed to start: ${e.message}`);
    }
    // one that never ran started nothing yet: what it was given starts here instead
    for (const w of t.waiting.values()) {
      if (t.answered) w.failed(new Error(`the thread that started ${w.argv[0]} failed: ${e.message}`));
      else run(w.argv, w.o).then(w.done, w.failed);
    }
    t.waiting.clear();
  };
  threads.push(t);
  return t;
}

/** What is told of each process `spawnOutput` is about to start, on the server's thread: for tests, which see no `Bun.spawn` of it. */
const starting = new Set<(argv: string[]) => void>();
export function onStart(fn: (argv: string[]) => void): () => void {
  starting.add(fn);
  return () => starting.delete(fn);
}

/** Runs `argv` and waits for it: its exit code, its output, and the signal that stopped it (a timeout), if one did. */
export async function spawnOutput(argv: string[], o: Options = {}): Promise<Output> {
  for (const fn of starting) fn(argv);
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
