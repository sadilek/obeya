// Waiting for a server that was just started. Code from `git archive` starts cold, without Bun's
// transpile cache, and on a busy machine takes well over half a minute to answer; so the wait is
// long as long as the process lives, and ends at once when it exits.

/** Not up: `exit` is the process's exit code, or null when it still runs after `limit` ms. */
export type Up = { up: true } | { up: false; exit: number | null; waited: number };

export async function waitUp(
  url: string,
  o: { exited: () => number | null; limit: number; slowAfter?: number; onSlow?: () => void },
): Promise<Up> {
  const start = Date.now();
  let warned = false;
  for (;;) {
    if (await answers(url)) return { up: true };
    const waited = Date.now() - start;
    const exit = o.exited();
    if (exit !== null) return { up: false, exit, waited };
    if (waited >= o.limit) return { up: false, exit: null, waited };
    if (!warned && o.onSlow && waited >= (o.slowAfter ?? Infinity)) {
      warned = true;
      o.onSlow();
    }
    await Bun.sleep(250);
  }
}

export async function answers(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
