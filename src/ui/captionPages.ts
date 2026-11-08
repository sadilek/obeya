// A walkthrough's caption shows its sentence a page at a time, two lines at most, so the player does
// not grow and shrink with each sentence in a narrow sheet: the page with the word being spoken.

/** Lines of a page. */
const LINES = 2;

/** How many lines words `widths` wide (`space` between them) take, broken at words into lines `line` wide. */
function linesOf(widths: number[], space: number, line: number) {
  let lines = 1;
  let at = 0;
  for (const w of widths) {
    if (at > 0 && at + space + w > line) {
      lines++;
      at = w;
    } else at += (at > 0 ? space : 0) + w;
  }
  return lines;
}

/**
 * The sentence's words in pages of two lines at most, in a caption `line` px wide, each word as
 * wide as `widthOf` measures it: each page the index of its first word. Pages come as even as the
 * words allow, and one ends after a comma or the like once it is most of the way full, so a page
 * reads as a phrase of its own.
 */
export function captionPages(words: string[], widthOf: (text: string) => number, line: number): number[] {
  const widths = words.map(widthOf);
  const space = widthOf(' ');
  const fits = (from: number, to: number) => linesOf(widths.slice(from, to), space, line) <= LINES;
  if (fits(0, words.length)) return [0];
  // as many pages as filling each to the brim takes, then each about an even share of the sentence
  let pages = 0;
  for (let from = 0; from < words.length; pages++) {
    let to = from + 1;
    while (to < words.length && fits(from, to + 1)) to++;
    from = to;
  }
  const target = (widths.reduce((s, w) => s + w + space, 0) / pages) * 1.05;
  const starts = [0];
  let at = 0;
  for (let k = 0; k < words.length; k++) {
    const w = widths[k]! + space;
    // it would no longer fit, or the page has its share: the page ends before this word
    if (k > starts.at(-1)! && (!fits(starts.at(-1)!, k + 1) || at + w / 2 > target)) {
      starts.push(k);
      at = 0;
    }
    at += w;
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
