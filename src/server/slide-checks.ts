// What Obeya checks of a walkthrough's slide beyond its form, before it shows it: that it fits the
// player, and that its narration does more than read it out. Both are estimates computed here, at
// once, without asking a model: a slide refused goes back to the agent in the tool's reply, and the
// walkthrough plays while the agent writes it (design: The Koordinator → Walkthroughs).

import { SLIDE_HEIGHT, SLIDE_WIDTH, type SlideContent } from '../core/walkthrough';

// The slide's layout at its one size (src/ui/styles.css, `.wt-*`, in cqw of SLIDE_WIDTH), in px.
const CQ = SLIDE_WIDTH / 100;
const CONTENT_WIDTH = SLIDE_WIDTH - 12 * CQ;
const CONTENT_HEIGHT = SLIDE_HEIGHT - 12.5 * CQ;
const KICKER = 2.2 * CQ * 1.3 + 1.2 * CQ;
const H2 = { size: 4.2 * CQ, line: 4.2 * CQ * 1.2, after: 3 * CQ };
const POINT = { size: 3.1 * CQ, line: 3.1 * CQ * 1.35, indent: 4 * CQ, gap: 2.2 * CQ };
const STEP = { label: 2.6 * CQ, labelLine: 2.6 * CQ * 1.25, note: 1.9 * CQ, noteLine: 1.9 * CQ * 1.3, noteGap: 0.8 * CQ, padX: 1.6 * CQ, padY: 2.2 * CQ, border: 0.3 * CQ, arrow: 4 * CQ, spill: 0.6 * 1.6 * CQ };
const TITLE = { bar: 3.8 * CQ, size: 6 * CQ, line: 6 * CQ * 1.15, after: 2 * CQ, sub: 3 * CQ, subLine: 3 * CQ * 1.45, subWidth: 0.8 * CONTENT_WIDTH };

/**
 * Advance widths in hundredths of an em, measured in Chromium at the sizes a slide sets them in:
 * Plex Condensed regular (points, notes) and bold (steps), Newsreader semibold for slide titles and
 * title slides, whose optical size makes it narrower the larger it is.
 */
const CHARS = 'abcdefghijklmnopqrstuvwxyzäöüßABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789 .,:;-–—!?()/„“”"\'’→#&+=%*<>[]{}@_';
const WIDTHS = {
  regular: '48,52,45,52,50,29,48,51,23,23,48,24,79,51,50,52,52,33,43,31,51,45,70,46,45,42,48,50,51,58,59,59,55,61,53,51,63,64,36,46,57,45,73,64,64,55,64,58,52,54,61,55,81,56,54,52,59,64,61,54,54,54,54,54,54,54,54,54,54,21,25,25,26,26,36,53,70,26,43,30,30,23,43,43,43,38,22,25,100,64,63,54,54,84,41,54,54,29,29,31,31,80,51',
  bold: '52,55,47,55,51,34,52,54,26,27,52,27,81,54,51,55,55,37,45,34,54,49,76,50,50,47,52,51,54,63,63,60,58,63,55,53,65,65,40,50,63,48,74,65,64,60,64,61,55,54,63,60,89,61,58,55,63,64,63,54,54,54,54,54,54,54,54,54,54,21,28,28,30,30,36,53,70,29,45,30,30,24,50,50,50,45,24,28,100,56,65,54,54,88,56,54,54,30,30,34,34,81,50',
  heading: '48,56,45,57,47,37,51,57,29,26,56,28,85,58,53,57,56,42,39,37,56,54,77,52,54,45,48,53,56,64,73,67,70,76,66,61,76,82,36,41,76,62,101,76,78,63,78,69,57,69,77,71,101,74,71,64,73,78,77,60,60,60,60,60,60,60,60,60,60,21,24,24,26,27,34,49,65,27,46,25,25,25,44,44,44,37,20,24,99,60,73,52,52,81,41,52,52,30,30,30,30,88,40',
  display: '50,58,46,59,48,38,52,59,29,27,58,29,88,60,55,59,57,43,41,38,58,56,79,54,55,47,50,55,58,65,75,68,71,77,68,62,77,84,37,42,78,63,103,77,79,65,79,71,58,72,78,73,104,75,72,66,75,79,78,62,62,62,62,62,62,62,62,62,62,21,24,24,27,27,33,48,65,27,47,25,25,24,44,44,44,38,20,24,100,62,75,54,54,81,40,54,54,30,30,29,29,89,41',
};
type Face = keyof typeof WIDTHS;
const EM = Object.fromEntries(
  Object.entries(WIDTHS).map(([face, list]) => {
    const w = list.split(',').map(Number);
    return [face, new Map([...CHARS].map((c, k) => [c, w[k]! / 100]))];
  }),
) as Record<Face, Map<string, number>>;

/** How wide `text` is set in `face` at `size` px; a character not measured counts as a wide one. */
const widthOf = (text: string, face: Face, size: number) => [...text].reduce((w, c) => w + (EM[face].get(c) ?? 0.75), 0) * size;

/**
 * `text` broken into lines `width` px wide as the browser breaks it, at spaces and after hyphens
 * and dashes: how many lines it takes, and the first piece wider than a line by more than `spill`
 * (it would spill out).
 */
export function lay(text: string, face: Face, size: number, width: number, spill = 0): { lines: number; tooWide?: string } {
  const space = widthOf(' ', face, size);
  let lines = 0;
  let line = 0;
  let tooWide: string | undefined;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const pieces = word.match(/[^-–—]*[-–—]+|[^-–—]+$/g) ?? [word];
    pieces.forEach((piece, k) => {
      const w = widthOf(piece, face, size);
      if (w > width + spill + 0.5) tooWide ??= word;
      const gap = k === 0 && line > 0 ? space : 0;
      if (lines === 0) lines = 1;
      if (line > 0 && line + gap + w > width + 0.5) {
        lines++;
        line = w;
      } else line += gap + w;
    });
  }
  return { lines, tooWide };
}

/** The height of a slide's kicker and title above its items. */
const header = (title: string) => KICKER + lay(title, 'heading', H2.size, CONTENT_WIDTH).lines * H2.line + H2.after;

/** What keeps a slide from fitting the player, said for the agent; `undefined` where it fits. */
export function tooFull(s: SlideContent): string | undefined {
  const over = (height: number, room: number, line: number, fix: string) =>
    height > room + 0.5 ? `the slide is too full: it runs about ${Math.ceil((height - room) / line)} line${Math.ceil((height - room) / line) === 1 ? '' : 's'} past its bottom. ${fix}` : undefined;
  if (s.type === 'title') {
    const title = lay(s.title, 'display', TITLE.size, CONTENT_WIDTH);
    const sub = s.subtitle ? lay(s.subtitle, 'regular', TITLE.sub, TITLE.subWidth).lines : 0;
    const height = TITLE.bar + title.lines * TITLE.line + TITLE.after + sub * TITLE.subLine;
    return over(height, CONTENT_HEIGHT, TITLE.line, 'Shorten its title or subtitle.');
  }
  if (s.type === 'points') {
    const laid = s.points.map((p) => lay(p, 'regular', POINT.size, CONTENT_WIDTH - POINT.indent));
    const wide = laid.findIndex((l) => l.tooWide);
    if (wide >= 0) return `"${laid[wide]!.tooWide}" in point ${wide + 1} is wider than the slide: break it up.`;
    const height = header(s.title) + laid.reduce((h, l) => h + l.lines * POINT.line, 0) + (s.points.length - 1) * POINT.gap;
    return over(height, CONTENT_HEIGHT, POINT.line, 'Shorten its points (the narration can say the rest), or spread them over two slides.');
  }
  if (s.type === 'flow') {
    const n = s.steps.length;
    let tallest = 0;
    for (const [k, step] of s.steps.entries()) {
      const inner = CONTENT_WIDTH / n - (k > 0 ? STEP.arrow : 0) - 2 * (STEP.padX + STEP.border);
      // a word too long for its line runs on into the box's padding on the right: most of it may go
      const label = lay(step.label, 'bold', STEP.label, inner, STEP.spill);
      const note = step.note ? lay(step.note, 'regular', STEP.note, inner, STEP.spill) : undefined;
      const wide = label.tooWide ?? note?.tooWide;
      if (wide)
        return `"${wide}" in step ${k + 1} is wider than its box: a flow of ${n} steps gives each box room for about ${Math.floor((inner + STEP.spill) / (0.5 * STEP.label))} characters: use shorter words${n > 3 ? ' or fewer steps' : ''}, and let the narration say the rest.`;
      tallest = Math.max(tallest, 2 * (STEP.padY + STEP.border) + label.lines * STEP.labelLine + (note ? STEP.noteGap + note.lines * STEP.noteLine : 0));
    }
    return over(header(s.title) + tallest, CONTENT_HEIGHT, STEP.labelLine, `Shorten the labels and notes of its steps${n > 3 ? ', or use fewer steps' : ''}.`);
  }
  // a code slide scrolls its lines to the range the narration is at
  return undefined;
}

/** The words of a text, lower case, without the short ones (articles, prepositions) that tell nothing. */
const wordsOf = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4);
/** Two forms of one word, as far as their beginning tells ("Karte", "Karten"; "wirkt", "wirken"). */
const sameWord = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return n >= 4 && n >= Math.min(a.length, b.length) - 2;
};

/** The share of a narration's words a slide does not show, below which it only reads the slide out. */
export const READ_OUT = 0.35;

/**
 * Whether a slide's narration only reads it out, said for the agent: too few of its words are not
 * on the slide. `narration`: what the agent wrote, without the title a title slide says first.
 */
export function readsOut(s: SlideContent, narration: string[]): string | undefined {
  const shown = wordsOf(
    [s.title, s.type === 'title' ? s.subtitle : '', s.type === 'points' ? s.points : [], s.type === 'flow' ? s.steps.flatMap((x) => [x.label, x.note ?? '']) : [], s.type === 'code' ? [s.note ?? '', ...s.code] : []].flat().join(' '),
  );
  const said = wordsOf(narration.join(' '));
  if (!said.length) return undefined;
  const added = said.filter((w) => !shown.some((x) => sameWord(w, x))).length;
  if (added / said.length >= READ_OUT) return undefined;
  return `its narration only reads the slide out (${said.length - added} of its ${said.length} words are on the slide). The owner sees the slide already: say what it does not show (why it is so, what follows from it, an example).`;
}
