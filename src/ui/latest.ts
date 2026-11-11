// Values that callbacks and effects read as they are now: listeners set up once, and the callbacks
// handed to memoised children, see the latest render without being made anew for it.

import { useCallback, useRef, useState } from 'react';

/** A ref holding `value` as of the latest render. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A callback of a fixed identity that calls `fn` as of the latest render. */
export function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useLatest(fn);
  return useCallback((...a: A) => ref.current(...a), []);
}

/** State with a ref that holds the value set last, for what reads it before the next render. */
export function useLive<T>(init: T | (() => T)): [T, (v: T) => void, { readonly current: T }] {
  const [v, setV] = useState(init);
  const ref = useRef(v);
  const set = useCallback((n: T) => {
    ref.current = n;
    setV(n);
  }, []);
  return [v, set, ref];
}
