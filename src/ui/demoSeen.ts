// Whether a card's demo starts by itself: only when the owner opens the card to a demo this browser
// has not played yet, never when the demo arrives on a card that is already open.
import type { Demo } from '../core/types';
import { read, write } from './stored';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (cardId: string) => `obeya-demo-seen-${cardId}`;
const heldKey = (cardId: string) => `obeya-demo-held-${cardId}`;
/** One demo, by its handover and its render: a later handover counts as new even where its chapters fall at the same times. */
const mark = (demo: Demo) => JSON.stringify([demo.handover ?? null, demo.chapters]);

export const sameDemo = (a: Demo | undefined, b: Demo | undefined) => !!a && !!b && mark(a) === mark(b);

/** This browser has not played the demo yet (a new render counts as new). */
export const unseen = (store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo): boolean => read(store, key(cardId)) !== mark(demo);

/** The demo played, by itself or on a click: the next opening of the card leaves it behind its play button. */
export const markSeen = (store: Store, cardId: string, demo: Demo) => void write(store, key(cardId), mark(demo));

/**
 * A demo that arrived on the open card waits behind its play button. The page a restart reloads
 * reopens the card without the owner opening it, so the tab remembers the demo waiting (session
 * storage) and the reloaded card keeps it waiting; closing the card forgets it, and the next opening
 * starts it.
 */
export const held = {
  set: (store: Store, cardId: string, demo: Demo) => void write(store, heldKey(cardId), mark(demo)),
  is: (store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo): boolean => read(store, heldKey(cardId)) === mark(demo),
  clear: (store: Store, cardId: string) => void write(store, heldKey(cardId), null),
};

/** The demo the owner opened the card to: none when there was none, or when the tab kept one waiting through a reload. */
export function openedWith(store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo | undefined): Demo | undefined {
  return demo && !held.is(store, cardId, demo) ? demo : undefined;
}

/** A demo other than the one the card opened to arrived on the open card: it waits behind its play button. */
export const arrivedOnOpenCard = (opened: Demo | undefined, demo: Demo) => !sameDemo(opened, demo);
