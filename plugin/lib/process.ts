// Process helpers the plugin's skills share: whether a process runs, whether a module is the script
// that runs, and a PID file as a lock. Plain Node with type stripping, like the skills that import it.

import fs from 'node:fs';

/** Whether a process runs; `kill(pid, 0)` only asks, on Windows too. One of another user counts (`EPERM`). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the module at `filename` is the script Node runs, not one imported; never inside Obeya's
 * binary, where every module it carries has the binary's name, that of the script it runs.
 */
export function isMain(filename: string): boolean {
  if (/^\/\$bunfs\/|^[A-Za-z]:[\\/]~BUN[\\/]/.test(filename)) return false;
  const script = process.argv[1];
  if (!script) return false;
  // Windows paths are the same file whatever their case
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(filename, script) || same(fs.realpathSync(script), filename);
}

/**
 * Takes `file` as a lock for this process: writes its PID there and removes it on exit if still
 * its own. Returns the PID of another process that holds it and runs, and then takes nothing.
 */
export function holdPidLock(file: string): number | undefined {
  const other = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  if (other > 0 && other !== process.pid && alive(other)) return other;
  fs.writeFileSync(file, String(process.pid));
  process.on('exit', () => {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
  });
  return undefined;
}
