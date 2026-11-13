// The canvas page's address names the open card or project (`/c/<canvas>/card/<code>`). Opening one
// is a step in the browser's history, so Back closes it again, as on the phone; one opened in place
// of another (by a link in it) takes over that one's step. Changes take effect one after the other:
// a step back is done once the browser says so.

import { useEffect, useRef } from 'react';
import type { Item } from '../core/types';
import { canvasPath, cardPath, named, readAddress } from './address';
import { useLatest } from './latest';

/**
 * The address of the canvas `canvasId`: `openNow` is the card or project open now, `follow` closes
 * what the address no longer names and opens what it names, on Back or Forward.
 */
export function useCanvasAddress(canvasId: string, openNow: () => Item | undefined, follow: () => Promise<void>) {
  // leaving for another canvas: what this canvas still had under way (a lookup, a step of the
  // address) no longer touches the page, which shows the other
  const gone = useRef(false);
  useEffect(() => () => void (gone.current = true), []);
  const chain = useRef(Promise.resolve());
  const change = (fn: () => void | Promise<void>) => void (chain.current = chain.current.then(() => (gone.current ? undefined : fn())).catch(console.error));
  /** The step back this page asked the browser for, until it is done. */
  const stepBack = useRef<(() => void) | null>(null);
  /** While the page opens what the address names (as it loads, on Back or Forward): the address is set already. */
  const set = useRef(false);
  const pathOf = (i: Item | undefined) => `${i ? cardPath(canvasId, i) : canvasPath(canvasId)}${location.search}`;
  /** `i` opens over `under` (the project it is opened from, else the canvas). */
  function opens(i: Item, under: Item | undefined) {
    if (set.current) return;
    change(() => {
      const at = readAddress().card;
      if (at && named([i], at)) return;
      if (!at || (under && named([under], at))) history.pushState({ step: true }, '', pathOf(i));
      else history.replaceState(history.state, '', pathOf(i));
    });
  }
  /** What is open closes down to `under` (the project still open, else the canvas). */
  function closes(under: Item | undefined) {
    if (set.current) return;
    change(() => {
      if (!(history.state as { step?: true } | null)?.step) return history.replaceState(history.state, '', pathOf(under));
      return new Promise<void>((done) => {
        stepBack.current = () => {
          // the step before may name what is no longer open (a card opened over its project, then reloaded without it)
          const at = readAddress().card;
          if (at && !(under && named([under], at))) history.replaceState(history.state, '', pathOf(under));
          done();
        };
        history.back();
      });
    });
  }
  /** Names `i` (else the canvas) in place of what the address names now. */
  const replace = (i: Item | undefined) => history.replaceState(history.state, '', pathOf(i));
  /** Runs `fn`, which opens what the address names already. */
  async function opening(fn: () => Promise<unknown>) {
    set.current = true;
    try {
      await fn();
    } finally {
      set.current = false;
    }
  }
  /**
   * As the page loads: `fn` opens what the address or the page's memory names; a kept card the
   * address left out (a restart of the app's shell, a link to the canvas) gets its address once it
   * is open.
   */
  const load = (fn: () => Promise<unknown>) =>
    void opening(fn)
      .catch(console.error)
      .finally(() => gone.current || replace(openNow()));
  const followNow = useLatest(follow);
  useEffect(() => {
    const pop = () => {
      // Back or Forward to another canvas: the page switches to it (App)
      const to = readAddress().canvas;
      if (to && to !== canvasId) return;
      const done = stepBack.current;
      stepBack.current = null;
      if (done) done();
      else change(() => followNow.current());
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  return { gone, opens, closes, replace, opening, load };
}
