// A newer version of the app, as its shell reports it (app/src/update.rs): downloaded and checked,
// every few seconds while the shell runs the server. The bar shows it; installing it goes like a
// restart (the Restarter's `update`), and the shell installs it once the server has ended.

import type { AppUpdate } from '../core/types';

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
    if (!version) throw new TypeError('version expected');
    const update: AppUpdate = { version };
    const notes = text(u.notes);
    if (notes) update.notes = notes;
    if (typeof u.date === 'number' && Number.isFinite(u.date)) update.date = u.date;
    const download = text(u.download);
    if (download?.startsWith('https://')) update.download = download;
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
