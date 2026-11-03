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

/**
 * How many processes `spawnOutput` starts in one turn of the event loop. Starting one takes the
 * server's thread a moment, under load many milliseconds: dozens started at once (a git call in
 * each clone, several landings) held it up for most of a second, in which it answered no page.
 * Those beyond wait for the next turn, so that what else waits comes between.
 */
const STARTS_PER_TURN = 4;
let startedThisTurn = 0;
const waitingToStart: (() => void)[] = [];
let turning = false;

/** Settles once a process may start in this turn of the event loop (`STARTS_PER_TURN`). */
function startTurn(): Promise<void> | undefined {
  nextTurn();
  if (startedThisTurn < STARTS_PER_TURN && !waitingToStart.length) {
    startedThisTurn++;
    return;
  }
  return new Promise((go) => waitingToStart.push(go));
}

function nextTurn() {
  if (turning) return;
  turning = true;
  setImmediate(() => {
    turning = false;
    startedThisTurn = 0;
    while (startedThisTurn < STARTS_PER_TURN && waitingToStart.length) {
      startedThisTurn++;
      waitingToStart.shift()!();
    }
    if (waitingToStart.length) nextTurn();
  });
}

/** Runs `argv` and waits for it: its exit code, its output, and the signal that stopped it (a timeout), if one did. */
export function spawnOutput(argv: string[], o: Options = {}): Promise<{ code: number; stdout: string; stderr: string; signal: string | null }> {
  // at once where it may, as a caller expects of a process it started
  const turn = startTurn();
  return turn ? turn.then(() => run(argv, o)) : run(argv, o);
}

async function run(argv: string[], o: Options): Promise<{ code: number; stdout: string; stderr: string; signal: string | null }> {
  const p = Bun.spawn<Bun.SpawnOptions.Writable, 'pipe', 'pipe'>(argv, { ...o, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr, signal: p.signalCode };
}
