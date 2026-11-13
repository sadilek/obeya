// What the UI's tests share.

import type { Item } from '../core/types';

/** A browser's local or session storage, held in memory. */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** A task card on the canvas, with what `over` sets. */
export const testItem = (over: Partial<Item>): Item => ({ id: 'x', kind: 'task', state: 'planned', title: '', body: '', x: 0, y: 0, source: 'manual', ...over }) as Item;
