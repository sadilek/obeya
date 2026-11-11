// State this browser keeps across reloads: a value in localStorage (or, for one tab, sessionStorage)
// under a key, often one per canvas. A full or refused storage never breaks the page: what cannot be
// read reads as nothing, what cannot be written is not kept.

import { useMemo, useState } from 'react';

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A browser storage, reached only when used: one that refuses storage throws already on reaching it. */
const lazy = (store: () => Storage): Store => ({ getItem: (k) => store().getItem(k), setItem: (k, v) => store().setItem(k, v), removeItem: (k) => store().removeItem(k) });
/** This browser's localStorage, for the helpers below. */
export const local = lazy(() => localStorage);
/** This tab's sessionStorage, for the helpers below. */
export const session = lazy(() => sessionStorage);

/** The text under `key`; null when there is none or the storage refuses. */
export function read(store: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`, or removes the key for null; false where the storage refused. */
export function write(store: Pick<Storage, 'setItem' | 'removeItem'>, key: string, value: string | null): boolean {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The text under `key`, once: the key goes. */
export function take(store: Store, key: string): string | null {
  const v = read(store, key);
  write(store, key, null);
  return v;
}

const parsed = <T>(raw: string | null): T | null => {
  try {
    return JSON.parse(raw ?? 'null') as T | null;
  } catch {
    return null;
  }
};

/** The value kept under `key` as JSON; null when there is none, it is no JSON or the storage refuses. */
export const readJson = <T>(store: Pick<Storage, 'getItem'>, key: string): T | null => parsed<T>(read(store, key));

/** Keeps `value` under `key` as JSON, or removes the key for null; false where the storage refused. */
export const writeJson = (store: Pick<Storage, 'setItem' | 'removeItem'>, key: string, value: unknown): boolean => write(store, key, value === null ? null : JSON.stringify(value));

/** The value kept under `key` as JSON, once: the key goes. */
export const takeJson = <T>(store: Store, key: string): T | null => parsed<T>(take(store, key));

/** Whether the flag under `key` is set (kept as `'1'`). */
export const flag = (store: Pick<Storage, 'getItem'>, key: string) => read(store, key) === '1';

/** Sets the flag under `key`, or removes it. */
export const setFlag = (store: Pick<Storage, 'setItem' | 'removeItem'>, key: string, on: boolean) => void write(store, key, on ? '1' : null);

/**
 * A hint that shows until the owner has used once what it points to: one flag in localStorage per
 * hint. Whether the owner has used what the hint under `key` points to.
 */
export const known = (key: string) => flag(local, key);

/** Remembers that the owner has used what the hint under `key` points to: its hint goes. */
export const know = (key: string) => setFlag(local, key, true);

/** Whether the owner has used what the hint under `key` points to, and the call that remembers they have. */
export function useKnown(key: string): [boolean, () => void] {
  const [is, setIs] = useState(() => known(key));
  return [
    is,
    () => {
      if (is) return;
      know(key);
      setIs(true);
    },
  ];
}

/** The value under `key`, `fallback` while there is none; a new key (another canvas) reads its own. */
export function useStoredState<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [set, setSet] = useState<{ key: string; v: T } | null>(null);
  const v = useMemo(() => (set?.key === key ? set.v : (readJson<T>(local, key) ?? fallback)), [set, key]);
  return [
    v,
    (next) => {
      setSet({ key, v: next });
      writeJson(local, key, next);
    },
  ];
}
