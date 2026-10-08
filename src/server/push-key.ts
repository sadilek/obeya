// What the app's shell reports about the push-to-talk key in another app (app/src/ptt.rs), every
// two seconds while it runs: the settings sheet and the setup assistant show it.

import type { PushKeyShell } from '../core/push-key';
import type { MachineItem } from '../core/types';

/** The macOS settings page where Obeya gets "Input Monitoring". */
export const INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';

export class ShellReports {
  private last: { shell: PushKeyShell; at: number } | null = null;

  constructor(private readonly now = () => Date.now()) {}

  report(input: unknown): PushKeyShell {
    const s = (input ?? {}) as Partial<Record<keyof PushKeyShell, unknown>>;
    const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
    if (!text(s.state) || !text(s.platform)) throw new TypeError('state and platform expected');
    const shell = { state: text(s.state), platform: text(s.platform), session: text(s.session), detail: text(s.detail) } as PushKeyShell;
    for (const k of Object.keys(shell) as (keyof PushKeyShell)[]) if (shell[k] === undefined) delete shell[k];
    this.last = { shell, at: this.now() };
    return shell;
  }

  /** The shell that runs: one that stopped reporting has gone (the app quit). */
  current(): PushKeyShell | null {
    return this.last && this.now() - this.last.at < 10_000 ? this.last.shell : null;
  }

  /** The setup assistant's line for the key, while a shell runs; `found` is the key, or what is in the way. */
  item(key: string): MachineItem | null {
    const shell = this.current();
    if (!shell) return null;
    if (shell.state === 'on') return { id: 'globalKey', state: 'ok', found: key };
    if (shell.state === 'permission')
      return { id: 'globalKey', state: 'missing', found: shell.detail === 'restart' ? 'restart' : 'permission', install: { commands: [], url: INPUT_MONITORING } };
    if (shell.state === 'bind') return { id: 'globalKey', state: 'missing', found: 'bind' };
    return { id: 'globalKey', state: 'off', found: shell.state };
  }
}
