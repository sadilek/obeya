// The page's address: `/c/<canvas>` shows a canvas, `/c/<canvas>/card/<code>` a card open on it,
// the code being the card's short code or its whole id. What else the page shows (the phone view,
// the conversation open on the phone) stays in the query.
import type { Item } from '../core/types';

export interface Address {
  canvas?: string;
  /** A card's code or id, as the address has it. */
  card?: string;
}

const PATH = /^\/c\/([^/]+)(?:\/card\/([^/]+))?\/?$/;

/** What an address names; the query of addresses before paths (`?c=<canvas>&card=<id>`) too. */
export function readAddress(at: { pathname: string; search: string } = location): Address {
  const m = PATH.exec(at.pathname);
  if (m) return { canvas: decodeURIComponent(m[1]!), ...(m[2] ? { card: decodeURIComponent(m[2]) } : {}) };
  const q = new URLSearchParams(at.search);
  const canvas = q.get('c');
  const card = q.get('card');
  return { ...(canvas ? { canvas } : {}), ...(card ? { card } : {}) };
}

export const canvasPath = (canvas: string) => `/c/${encodeURIComponent(canvas)}`;

/** The address of a card on its canvas: by its short code where it has one. */
export const cardPath = (canvas: string, card: Pick<Item, 'id' | 'short'> | string) =>
  `${canvasPath(canvas)}/card/${encodeURIComponent(typeof card === 'string' ? card : (card.short ?? card.id))}`;

/** The card an address names among `items`, by its code or its id. */
export const named = <T extends Pick<Item, 'id' | 'short'>>(items: T[], code: string): T | undefined =>
  items.find((i) => i.id === code) ?? items.find((i) => i.short === code.toLowerCase());

/** The query without what the path says now, with flags (`?talk`) kept as bare names. */
export function queryWithout(search: string, ...names: string[]): string {
  const q = new URLSearchParams(search);
  for (const n of names) q.delete(n);
  const s = q.toString().replace(/=(&|$)/g, '$1');
  return s ? `?${s}` : '';
}

/** An address from before paths (`/?c=<canvas>&card=<id>`) in today's form, in place; a link or bookmark of then still opens what it named. */
export function upgradeAddress() {
  if (location.pathname !== '/') return;
  const { canvas, card } = readAddress();
  if (!canvas) return;
  history.replaceState(history.state, '', `${card ? cardPath(canvas, card) : canvasPath(canvas)}${queryWithout(location.search, 'c', 'card')}${location.hash}`);
}
