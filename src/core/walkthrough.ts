// A looked-up answer told as a walkthrough: slides and their narration, which the answering agent
// hands over one at a time and Obeya voices sentence by sentence while it writes on. The server
// keeps each walkthrough as one JSON file in the thread's output directory, its clips beside it;
// the player in the page reads it while it grows (design: The Koordinator → Walkthroughs).

import type { Language } from './locale';
import { lettersOf, wordsOf } from '../../plugin/skills/demo/lib/word-times.ts';

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
  /** The language its narration is in, which the voice speaks (files before 2026-11-08 lack it). */
  language?: Language;
  /** The demo settings have no voice: the player shows each sentence as a caption for as long as reading it takes. */
  silent?: boolean;
}

/** How a walkthrough's file is named in the thread's output directory, and so among its answer's files. */
export const WALKTHROUGH_SUFFIX = '.walkthrough.json';

export const isWalkthrough = (name: string) => name.endsWith(WALKTHROUGH_SUFFIX);

/** How many items of a slide show one after the other as the narration reaches them. */
export function itemsOf(s: SlideContent): number {
  return s.type === 'points' ? s.points.length : s.type === 'flow' ? s.steps.length : s.type === 'code' ? s.focus.length : 0;
}

export { estimatedStarts, heardStarts, wordsOf } from '../../plugin/skills/demo/lib/word-times.ts';

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
