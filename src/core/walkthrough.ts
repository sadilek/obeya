// A looked-up answer told as a walkthrough: slides and their narration, which the answering agent
// hands over one at a time and Obeya voices sentence by sentence while it writes on. The server
// keeps each walkthrough as one JSON file in the thread's output directory, its clips beside it;
// the player in the page reads it while it grows (design: The Koordinator → Walkthroughs).

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

/** A sentence voiced: its file beside the walkthrough, and how long it plays. */
export interface Clip {
  file: string;
  seconds: number;
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
