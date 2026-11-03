// A card's number: given once, counting across all canvases, never given again. The owner and the
// agents name a card by it (`K42`); the address keeps the card's short code.

/** How a card's number reads, in every language: `K42`. */
export const cardTag = (n: number) => `K${n}`;

/** The card number a tag names (`K42`, also `k 42`, `K-42`, `Ka 42` as speech recognition writes it, or a bare `42`), or undefined. */
export function numberOfTag(tag: string): number | undefined {
  const m = /^\s*(?:K|Ka)?[ -]?(\d{1,9})\s*$/i.exec(tag);
  return m ? Number(m[1]) : undefined;
}

/** The card numbers a text names (`K42`, also `K 42` and `Ka 42` from speech recognition), each once, in order. */
export function cardNumbersIn(text: string): number[] {
  return [...new Set([...text.matchAll(/\b(?:K|Ka)[ -]?(\d{1,9})\b/gi)].map((m) => Number(m[1])))];
}

/**
 * The setting (per canvas) since when its cards have numbers: the Koordinator's memory of earlier
 * exchanges names cards by tags that held for one session only.
 */
export const NUMBERS_SINCE = 'card_numbers_since';
