// What a page asks the server once (`ask` keeps its promise), read into a component's state.

import { useEffect, useState } from 'react';

/** `start` until the answer to `ask` comes, then the answer; `ask` false asks nothing. */
export function useAsked(ask: (() => Promise<boolean>) | false, start = false): boolean {
  const [v, setV] = useState(start);
  useEffect(() => {
    let live = true;
    if (ask) void ask().then((a) => live && setV(a));
    return () => void (live = false);
  }, []);
  return v;
}
