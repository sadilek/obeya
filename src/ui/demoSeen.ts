// Whether a card's demo starts by itself: only when the owner opens the card to a demo this browser
// has not played yet, never when the demo arrives on a card that is already open.
import type { Demo } from '../core/types';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const key = (cardId: string) => `obeya-demo-seen-${cardId}`;
const heldKey = (cardId: string) => `obeya-demo-held-${cardId}`;
/** A new render after feedback has other chapter times, so it counts as unseen again. */
const mark = (demo: Demo) => JSON.stringify(demo.chapters);

/** One demo, by its handover and its render. */
export const sameDemo = (a: Demo | undefined, b: Demo | undefined) => !!a && !!b && a.handover === b.handover && mark(a) === mark(b);

/** This browser has not played the demo yet (a new render counts as new). */
export function unseen(store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo): boolean {
  try {
    return store.getItem(key(cardId)) !== mark(demo);
  } catch {
    return true;
  }
}

/** The demo played, by itself or on a click: the next opening of the card leaves it behind its play button. */
export function markSeen(store: Store, cardId: string, demo: Demo) {
  try {
    store.setItem(key(cardId), mark(demo));
  } catch {}
}

/**
 * A demo that arrived on the open card waits behind its play button. The page a restart reloads
 * reopens the card without the owner opening it, so the tab remembers the demo waiting (session
 * storage) and the reloaded card keeps it waiting; closing the card forgets it, and the next opening
 * starts it.
 */
export const held = {
  set(store: Store, cardId: string, demo: Demo) {
    try {
      store.setItem(heldKey(cardId), mark(demo));
    } catch {}
  },
  is(store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo): boolean {
    try {
      return store.getItem(heldKey(cardId)) === mark(demo);
    } catch {
      return false;
    }
  },
  clear(store: Pick<Storage, 'removeItem'>, cardId: string) {
    try {
      store.removeItem(heldKey(cardId));
    } catch {}
  },
};

/** The demo the owner opened the card to: none when there was none, or when the tab kept one waiting through a reload. */
export function openedWith(store: Pick<Storage, 'getItem'>, cardId: string, demo: Demo | undefined): Demo | undefined {
  return demo && !held.is(store, cardId, demo) ? demo : undefined;
}

/** A demo other than the one the card opened to arrived on the open card: it waits behind its play button. */
export const arrivedOnOpenCard = (opened: Demo | undefined, demo: Demo) => !sameDemo(opened, demo);
