// A walkthrough's caption shows its sentence a page at a time, two lines at most, so the player does
// not grow and shrink with each sentence in a narrow sheet: the page with the word being spoken.

/** Of a font's size, how wide a character of the caption is on average (Inter, mixed case and spaces). */
const CHAR_EM = 0.53;
/** Lines of a page. */
const LINES = 2;

/** The characters a page of the caption holds in a caption `width` px wide, its font `size` px; some room is kept, as lines break at words. */
export const pageBudget = (width: number, size: number) => Math.max(12, Math.floor(((LINES * width) / (CHAR_EM * size)) * 0.88));

/**
 * The sentence's words in pages of about `budget` characters, as even as they come: each page the
 * index of its first word. A page ends after a comma or the like once it is most of the way
 * full, so a page reads as a phrase of its own.
 */
export function captionPages(words: string[], budget: number): number[] {
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  const pages = Math.max(1, Math.ceil(total / budget));
  if (pages === 1) return [0];
  const target = total / pages;
  const starts = [0];
  let at = 0;
  for (let k = 0; k < words.length; k++) {
    const len = words[k]!.length + 1;
    // over the even share, or it would no longer fit at all: the page ends before this word
    if (at > 0 && (at + len > budget || at + len / 2 > target * 1.08)) {
      starts.push(k);
      at = 0;
    }
    at += len;
    // a phrase ends here, and the page is most of the way full: it ends after this word
    if (k + 1 < words.length && /[,;:.!?–—]$/.test(words[k]!) && at >= target * 0.7) {
      starts.push(k + 1);
      at = 0;
    }
  }
  return starts;
}

/** The page of `starts` word `word` is on; the first before any word is spoken. */
export const pageOf = (starts: number[], word: number) => {
  let page = 0;
  for (const [k, s] of starts.entries()) if (word >= s) page = k;
  return page;
};
