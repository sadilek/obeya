// A looked-up answer told as a walkthrough: slides and their narration, which the answering agent
// hands over one at a time and Obeya voices sentence by sentence while it writes on. The server
// keeps each walkthrough as one JSON file in the thread's output directory, its clips beside it;
// the player in the page reads it while it grows (design: The Koordinator → Walkthroughs).

/**
 * The one size a slide is laid out in, in px: the player scales it to its width, so a slide looks
 * the same in every view, only smaller or larger, and the server can tell whether it fits.
 */
export const SLIDE_WIDTH = 800;
export const SLIDE_HEIGHT = 500;

/** What a slide shows, as the agent hands it over. */
export type SlideContent =
  | { type: 'title'; title: string; subtitle?: string }
  | { type: 'points'; title: string; points: string[] }
  | { type: 'flow'; title: string; steps: { label: string; note?: string }[] }
  /** Real lines of the repository, `lines` inclusive, `focus` ranges highlighted one after the other; `code` as Obeya read them. */
  | { type: 'code'; title: string; file: string; lines: [number, number]; focus: [number, number][]; note?: string; code: string[] };

/**
 * A slide as the player plays it: its narration as the sentences it is voiced in (`parts`), and for
 * a slide whose items show one after the other the item each sentence belongs to (`items`).
 */
export type Slide = SlideContent & { parts: string[]; items?: number[] };

/**
 * A sentence voiced: its file beside the walkthrough, and how long it plays; once heard back, the
 * second each of its words (`wordsOf`) starts at, which the caption's pointer follows.
 */
export interface Clip {
  file: string;
  seconds: number;
  words?: number[];
}

/** The error of a walkthrough whose voicing stopped with the server that voiced it. */
export const INTERRUPTED = 'interrupted';

/** The file a walkthrough is kept in (`<name>.walkthrough.json`). */
export interface Walkthrough {
  title: string;
  slides: Slide[];
  /** The agent has handed over every slide. */
  done: boolean;
  /** Per slide, per sentence: its clip once voiced. */
  clips: (Clip | null)[][];
  /** The directory beside it the clips are in, relative to the thread's output directory. */
  clipsDir: string;
  /** Why the voice could not speak it. */
  error?: string;
}

/** How a walkthrough's file is named in the thread's output directory, and so among its answer's files. */
export const WALKTHROUGH_SUFFIX = '.walkthrough.json';

export const isWalkthrough = (name: string) => name.endsWith(WALKTHROUGH_SUFFIX);

/** How many items of a slide show one after the other as the narration reaches them. */
export function itemsOf(s: SlideContent): number {
  return s.type === 'points' ? s.points.length : s.type === 'flow' ? s.steps.length : s.type === 'code' ? s.focus.length : 0;
}

/** A sentence's words as the caption shows them, apart at its spaces. */
export const wordsOf = (sentence: string) => sentence.trim().split(/\s+/).filter(Boolean);

/** A word's letters and digits as they are compared, without case, accents or punctuation. */
const lettersOf = (word: string) =>
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

/**
 * The words of an item's text that tell the narration has reached it: those of four letters or more
 * (else its longest), without those the other items share ("pull request" in "Open pull request" and
 * "Merge pull request"), unless it has no other.
 */
function telling(text: string, others: string[]) {
  const words = wordsOf(text).map(lettersOf).filter(Boolean);
  const long = words.filter((w) => w.length >= 4);
  const own = long.length ? long : words.sort((a, b) => b.length - a.length).slice(0, 1);
  const theirs = others.flatMap((o) => wordsOf(o).map(lettersOf));
  const apart = own.filter((w) => !theirs.some((t) => names(t, w)));
  return apart.length ? apart : own;
}

/**
 * Whether a word of the narration names the item's word: the same, the same with an ending of a
 * letter or two ("open", "opens"), or the same stem ("approves", "approved").
 */
function names(said: string, word: string) {
  if (said === word) return true;
  const [short, long] = said.length <= word.length ? [said, word] : [word, said];
  if (short.length >= 4 && long.length - short.length <= 2 && long.startsWith(short)) return true;
  const stem = short.length - 1;
  return stem >= 4 && said.slice(0, stem) === word.slice(0, stem);
}

/**
 * On a slide whose narration is one text, where it first names each of its items, in order: the
 * sentence and its word from which the item shows, or `undefined` for one it names nowhere after
 * the item before it.
 */
export function mentions(s: Slide): ({ part: number; word: number } | undefined)[] {
  const texts = s.type === 'points' ? s.points : s.type === 'flow' ? s.steps.map((x) => x.label) : [];
  const said = s.parts.flatMap((p, part) => wordsOf(p).map((w, word) => ({ part, word, letters: lettersOf(w) })));
  let from = 0;
  return texts.map((text, k) => {
    const words = telling(text, texts.filter((_, j) => j !== k));
    const at = said.findIndex((x, i) => i >= from && words.some((w) => names(x.letters, w)));
    if (at < 0) return undefined;
    from = at + 1;
    return { part: said[at]!.part, word: said[at]!.word };
  });
}

/**
 * The second of its slide from which each item shows: the first with the slide, so it never stands
 * empty; the others with their part of the narration (a narration in parts), where the narration
 * first names them (one text), else spread between their neighbours. `at`: the second of the slide
 * a sentence's word starts at; `part`: the second a sentence starts at.
 */
export function itemStarts(s: Slide, at: (part: number, word: number) => number, part: (part: number) => number, seconds: number): number[] {
  const n = itemsOf(s);
  if (s.items) return Array.from({ length: n }, (_, k) => (k ? part(Math.max(0, s.items!.indexOf(k))) : 0));
  const found = s.type === 'code' ? [] : mentions(s).map((m) => m && at(m.part, m.word));
  const starts: number[] = [];
  for (let k = 0; k < n; k++) {
    const f = found[k];
    if (f !== undefined && k > 0) {
      starts.push(Math.max(f, starts[k - 1] ?? 0));
      continue;
    }
    if (k === 0) {
      starts.push(0);
      continue;
    }
    let next = k + 1;
    while (next < n && found[next] === undefined) next++;
    const to = next < n ? found[next]! : seconds * 0.9;
    const from = starts[k - 1]!;
    starts.push(from + Math.max(0, to - from) / (next - k + 1));
  }
  return starts;
}
