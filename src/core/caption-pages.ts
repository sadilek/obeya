// A caption shows its sentence a page at a time, two lines at most, so the player does not grow and
// shrink with each sentence in a narrow sheet: the page with the word being spoken. A walkthrough's
// player and a demo video's (video-player.ts) page their captions alike; a shared demo page carries
// these functions as their source, so each holds all it needs.

/**
 * The sentence's words in pages of two lines at most, in a caption `line` px wide, each word as
 * wide as `widthOf` measures it: each page the index of its first word. Pages come as even as the
 * words allow, and one ends after a comma or the like once it is most of the way full, so a page
 * reads as a phrase of its own.
 */
export function captionPages(words: string[], widthOf: (text: string) => number, line: number): number[] {
  /** Lines of a page. */
  const LINES = 2;
  const widths = words.map(widthOf);
  const space = widthOf(' ');
  /** How many lines the words from `from` to `to` take, broken at words into lines `line` wide. */
  const linesOf = (from: number, to: number) => {
    let lines = 1;
    let at = 0;
    for (const w of widths.slice(from, to)) {
      if (at > 0 && at + space + w > line) {
        lines++;
        at = w;
      } else at += (at > 0 ? space : 0) + w;
    }
    return lines;
  };
  const fits = (from: number, to: number) => linesOf(from, to) <= LINES;
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

/**
 * A demo video's cue as its words, and the second each starts at where the cue marks them, as the
 * narration was heard back (a WebVTT timestamp before each word after the first,
 * `<00:00:03.120>word`): the first from the cue's start, a word without a timestamp from the one
 * before it. `times` is null for a cue without timestamps (an older demo's, a translation's).
 */
export function cueWords(raw: string): { words: string[]; times: number[] | null } {
  const words: string[] = [];
  const times: number[] = [];
  let marked = false;
  let at = -Infinity;
  for (const piece of raw.replace(/\s+/g, ' ').trim().split(' ')) {
    for (const m of piece.matchAll(/<(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)>/g)) {
      at = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      marked = true;
    }
    const word = piece.replace(/<[^>]*>/g, '');
    if (!word) continue;
    words.push(word);
    times.push(at);
  }
  return { words, times: marked ? times : null };
}

/**
 * The word of a cue being spoken at second `now` of the video, `share` of the way through the cue:
 * the last whose time has come where the cue has them (`cueWords`), else the one its letters' share
 * of the cue has reached; -1 for a cue without words.
 */
export function spokenWord({ words, times }: { words: string[]; times: number[] | null }, now: number, share: number): number {
  let word = -1;
  if (times) {
    for (const [k, at] of times.entries()) if (k === 0 || now >= at) word = k;
    return word;
  }
  const weights = words.map((x) => x.length + 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  for (const [k, x] of weights.entries()) {
    if (share * total >= at) word = k;
    at += x;
  }
  return word;
}
