// Where the words of a voiced sentence start: from what speech recognition heard of it, lined up
// letter by letter, else by their length. A walkthrough's caption (src/core/walkthrough.ts) and a
// demo's captions (subtitles.ts) follow them. Here, in the plugin, since a demo render runs where
// only the plugin is (an SSH host, a release's resources).

/** A sentence's words as the caption shows them, apart at its spaces. */
export const wordsOf = (sentence: string) => sentence.trim().split(/\s+/).filter(Boolean);

/** A word's letters and digits as they are compared, without case, accents or punctuation. */
export const lettersOf = (word: string) =>
  word
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Where each word of a sentence voiced in `seconds` starts, as its length suggests: a word takes
 * time by its letters, and a little more for the pause around it.
 */
export function estimatedStarts(sentence: string, seconds: number): number[] {
  const weights = wordsOf(sentence).map((w) => lettersOf(w).length + 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return weights.map((w) => {
    const start = (at / total) * seconds;
    at += w;
    return round(start);
  });
}

/**
 * Where each word of a sentence starts in its clip, from what speech recognition heard of it:
 * `heard` in pieces (words or parts of them), each with the second it starts at. Recognition writes
 * some words otherwise ("Obia" for "Obeya", a number as digits, a compound apart), so the sentence
 * and what was heard are lined up letter by letter, and a word starts where its first letter was
 * heard; a word none of whose letters line up gets a start between its neighbours', by its length.
 */
export function heardStarts(sentence: string, heard: [string, number][], seconds: number): number[] {
  const words = wordsOf(sentence);
  // the sentence's letters, each with its word
  const said: { c: string; word: number }[] = [];
  words.forEach((w, k) => {
    for (const c of lettersOf(w)) said.push({ c, word: k });
  });
  // the letters heard, each at a time within its piece
  const got: { c: string; at: number }[] = [];
  heard.forEach(([text, start], k) => {
    const end = heard[k + 1]?.[1] ?? Math.max(start, seconds);
    const letters = lettersOf(text);
    [...letters].forEach((c, i) => got.push({ c, at: start + ((end - start) * i) / Math.max(1, letters.length) }));
  });
  const starts: (number | undefined)[] = words.map(() => undefined);
  if (said.length && got.length) {
    for (const [i, j] of alignment(said.map((x) => x.c).join(''), got.map((x) => x.c).join(''))) {
      const k = said[i]!.word;
      if (starts[k] === undefined) starts[k] = got[j]!.at;
    }
  }
  if (starts.every((x) => x === undefined)) return estimatedStarts(sentence, seconds);
  // the words that lined up nowhere, between their neighbours by their length; never before a word ahead of them
  const guess = estimatedStarts(sentence, seconds);
  const out: number[] = [];
  for (let k = 0; k < words.length; k++) {
    const s = starts[k];
    if (s !== undefined) {
      out.push(Math.max(s, out[k - 1] ?? 0));
      continue;
    }
    const before = k - 1;
    let after = k + 1;
    while (after < words.length && starts[after] === undefined) after++;
    const from = before >= 0 ? out[before]! : 0;
    const to = after < words.length ? starts[after]! : seconds;
    const g0 = before >= 0 ? guess[before]! : 0;
    const g1 = after < words.length ? guess[after]! : seconds;
    const share = g1 > g0 ? (guess[k]! - g0) / (g1 - g0) : 0;
    out.push(Math.max(from, from + (to - from) * share));
  }
  return out.map(round);
}

const round = (s: number) => Math.round(s * 100) / 100;

/**
 * The pairs of positions of `a` and `b` that line up, as the least edits from one to the other
 * have them: letters that are the same, and letters said otherwise (a sound misheard).
 */
function alignment(a: string, b: string): [number, number][] {
  const n = a.length;
  const m = b.length;
  const cost = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 0; i <= n; i++) cost[at(i, 0)] = i;
  for (let j = 0; j <= m; j++) cost[at(0, j)] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      cost[at(i, j)] = Math.min(cost[at(i - 1, j - 1)]! + (a[i - 1] === b[j - 1] ? 0 : 1), cost[at(i - 1, j)]! + 1, cost[at(i, j - 1)]! + 1);
  const pairs: [number, number][] = [];
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (cost[at(i, j)] === cost[at(i - 1, j - 1)]! + (a[i - 1] === b[j - 1] ? 0 : 1)) pairs.push([--i, --j]);
    else if (cost[at(i, j)] === cost[at(i - 1, j)]! + 1) i--;
    else j--;
  }
  return pairs.reverse();
}
