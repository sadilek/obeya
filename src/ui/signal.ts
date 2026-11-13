// Something that happens, for whoever listens: a module's state changing, for the hooks that show it
// (`useSyncExternalStore(changed.on, …)`), or a message from the server.

export function signal<A extends unknown[] = []>() {
  const heard = new Set<(...a: A) => void>();
  return {
    /** Listens until the returned call. */
    on: (fn: (...a: A) => void): (() => void) => {
      heard.add(fn);
      return () => void heard.delete(fn);
    },
    /** Tells every listener; false where none listens. */
    emit: (...a: A): boolean => {
      for (const fn of heard) fn(...a);
      return heard.size > 0;
    },
  };
}
