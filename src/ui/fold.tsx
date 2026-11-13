// Sections folded away under their heads, kept per browser: the canvases in the navigation, and a
// canvas's cards within each of the phone's lists. One store per storage key, shared by every view
// of it on the page, so a section folded in one stays folded in the other (the navigation's list
// under its button and its sidebar).

import { useSyncExternalStore } from 'react';
import { local, readJson, writeJson } from './stored';
import { signal } from './signal';

interface Store {
  ids: string[];
  changed: ReturnType<typeof signal<[]>>;
}

const stores = new Map<string, Store>();

function storeOf(key: string): Store {
  let s = stores.get(key);
  if (s) return s;
  const v = readJson<unknown>(local, key);
  const ids = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  s = { ids, changed: signal() };
  stores.set(key, s);
  return s;
}

/** Folds the section `id` kept under `key`, or unfolds it. */
export function toggleFolded(key: string, id: string) {
  const s = storeOf(key);
  s.ids = s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id];
  writeJson(local, key, s.ids.length ? s.ids : null);
  s.changed.emit();
}

/** The sections folded under `key`. */
export function useFolded(key: string): string[] {
  const s = storeOf(key);
  return useSyncExternalStore(s.changed.on, () => s.ids);
}

/** The arrow at a foldable head's left: pointing right while folded, down while open (turned by CSS). */
export function FoldArrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
