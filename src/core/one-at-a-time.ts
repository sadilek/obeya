// Work that must not overlap with other work under the same key (a landing per repository, a turn
// per thread) runs one after the other; work asked for again while it is under way (a look at a
// clone, a read of the registry) is done once for all who asked.

/**
 * Runs `fn` once what runs under `key` in `running` has settled, whether it failed or not; at once
 * when nothing does. Returns what `fn` comes to.
 */
export function oneAtATime<K, T>(running: Map<K, Promise<unknown>>, key: K, fn: () => Promise<T>): Promise<T> {
  const before = running.get(key);
  const next = before ? before.then(fn) : fn();
  const settled = next.catch(() => {});
  running.set(key, settled);
  void settled.then(() => running.get(key) === settled && running.delete(key));
  return next;
}

/** Calls under way by key: a `Map`, or a `WeakMap` for keys that are objects. */
interface Running<K, T> {
  get(key: K): Promise<T> | undefined;
  set(key: K, value: Promise<T>): unknown;
  delete(key: K): unknown;
}

/** What the call under `key` in `running` comes to: the one under way, else `fn`'s, which those asking meanwhile share. */
export function shared<K, T>(running: Running<K, T>, key: K, fn: () => Promise<T>): Promise<T> {
  const under = running.get(key);
  if (under) return under;
  const call: Promise<T> = fn().finally(() => void (running.get(key) === call && running.delete(key)));
  running.set(key, call);
  return call;
}
