// A newer version of the app, as its shell reports it (app/src/update.rs): downloaded and checked,
// every few seconds while the shell runs the server. The bar shows it; installing it goes like a
// restart (the Restarter's `update`), and the shell installs it once the server has ended.

import type { AppUpdate } from '../core/types';
import { BadRequest } from './board';

/** Where the app's releases are, as its shell names them (`RELEASES` in app/src/update.rs). */
const RELEASES = 'https://github.com/sadilek/obeya/releases/';

/** A shell that reported nothing for this long has gone (the app quit), and its update with it. */
const FRESH_MS = 10_000;

export class AppUpdates {
  private last: AppUpdate | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  report(input: unknown): AppUpdate {
    const u = (input ?? {}) as Partial<Record<keyof AppUpdate, unknown>>;
    const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
    const version = text(u.version);
    if (!version) throw new BadRequest('invalid', 'version expected');
    const update: AppUpdate = { version };
    const notes = text(u.notes);
    if (notes) update.notes = notes;
    if (typeof u.date === 'number' && Number.isFinite(u.date)) update.date = u.date;
    const download = text(u.download);
    // the shell names a release of Obeya's (update.rs); another address in the bar would lead elsewhere
    if (download?.startsWith(RELEASES)) update.download = download;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.set(null), FRESH_MS);
    this.expiry.unref?.();
    this.set(update);
    return update;
  }

  /** The update the shell has ready, while it reports one. */
  current(): AppUpdate | null {
    return this.last;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(update: AppUpdate | null) {
    if (JSON.stringify(update) === JSON.stringify(this.last)) return;
    this.last = update;
    for (const fn of this.listeners) fn();
  }
}

/** How long what the page handed over waits for the page of the new shell: starting again takes seconds. */
const HANDED_OVER_MS = 2 * 60_000;

/**
 * What the page in the app's window keeps across its shell starting again while the server runs
 * on (a new build of a shell installed from a checkout, app/src/update.rs). A reload keeps it in
 * the tab's session storage (keep.ts, draft.ts), which the new shell's webview starts without: the
 * page hands it over here first (`token`: which time the shell asked), and the page the new shell
 * opens takes it back, once.
 */
export class HandOver {
  private kept: { token: string; entries: [string, string][]; at: number } | null = null;

  give(input: unknown) {
    const { token, entries } = (input ?? {}) as { token?: unknown; entries?: unknown };
    const pair = (e: unknown): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string';
    if (typeof token !== 'string' || !Array.isArray(entries) || !entries.every(pair)) throw new BadRequest('invalid', 'token and entries expected');
    this.kept = { token, entries, at: Date.now() };
  }

  /** Whether the page handed over when the shell asked with `token`. */
  has(token: unknown): boolean {
    return typeof token === 'string' && this.kept?.token === token;
  }

  take(now = Date.now()): [string, string][] | null {
    const kept = this.kept;
    this.kept = null;
    return kept && now - kept.at < HANDED_OVER_MS ? kept.entries : null;
  }
}
