// A command of the adapter's `stack`, run in a workspace by Obeya itself (design: Parking).

/** A stack's stop takes seconds; one that hangs this long counts as failed. */
const STACK_TIMEOUT = 2 * 60_000;

/** Runs `command` through the platform's shell in `cwd`: whether it exited 0, and what it printed. */
export async function runStackCommand(cwd: string, command: string, timeout = STACK_TIMEOUT): Promise<{ ok: boolean; output: string }> {
  const shell = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
  try {
    const p = Bun.spawn(shell, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: code === 0, output: `${out}${err}`.trim() || (code === 0 ? '' : p.signalCode ? `stopped (${p.signalCode})` : `exit code ${code}`) };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}
