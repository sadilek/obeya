// What Obeya checks of a walkthrough's slide beyond its form, before it shows it: that it fits the
// player, and that its narration does more than read it out. Both are estimates computed here, at
// once, without asking a model: a slide refused goes back to the agent in the tool's reply, and the
// walkthrough plays while the agent writes it (design: The Koordinator → Walkthroughs).

import { SLIDE_HEIGHT, SLIDE_WIDTH, type SlideContent } from '../core/walkthrough';

// The slide's layout at its one size (src/ui/styles.css, `.wt-*`, in cqw of SLIDE_WIDTH), in px.
const CQ = SLIDE_WIDTH / 100;
const CONTENT_WIDTH = SLIDE_WIDTH - 12 * CQ;
const CONTENT_HEIGHT = SLIDE_HEIGHT - 9.5 * CQ;
const KICKER = 1.5 * CQ * 1.3 + 1.2 * CQ;
const H2 = { size: 4.2 * CQ, line: 4.2 * CQ * 1.08, after: 2.6 * CQ };
/** A point stands on a panel: its padding and border around it, a dot and a gap before its text. */
const POINT = { size: 2.6 * CQ, line: 2.6 * CQ * 1.3, padX: 2 * CQ, padY: 1.2 * CQ, border: 0.25 * CQ, dot: 1.1 * CQ + 1.6 * CQ, gap: 1.2 * CQ };
const STEP = { label: 2.4 * CQ, labelLine: 2.4 * CQ * 1.25, note: 1.8 * CQ, noteLine: 1.8 * CQ * 1.3, noteGap: 0.7 * CQ, padX: 1.4 * CQ, padY: 2 * CQ, border: 0.25 * CQ, arrow: 4 * CQ, spill: 0.6 * 1.4 * CQ };
/** A title slide has a padding of its own, its title and subtitle narrower than the slide (the motif stands on its right). */
const TITLE = { pad: 7 * CQ, bar: 0.6 * CQ + 3 * CQ, size: 6.2 * CQ, line: 6.2 * CQ * 1.02, width: 60 * CQ, sub: 2.6 * CQ, subLine: 2.6 * CQ * 1.4, subGap: 2.4 * CQ, subWidth: 56 * CQ };

/**
 * The faces a slide is set in, as styles.css sets them: Inter regular (points, notes, subtitles)
 * and semibold (steps), Bricolage Grotesque bold for slide titles and heavier for title slides,
 * both drawn tighter. scripts/slide-font-widths.ts measures them.
 */
export const FACES = {
  regular: { family: 'Inter', weight: 400, tracking: 0 },
  bold: { family: 'Inter', weight: 600, tracking: 0 },
  heading: { family: 'Bricolage Grotesque', weight: 700, tracking: -0.025 },
  display: { family: 'Bricolage Grotesque', weight: 750, tracking: -0.035 },
};
type Face = keyof typeof FACES;

/** The characters measured; the advance widths of each face in hundredths of an em, letter-spacing included, in this order. */
export const CHARS = 'abcdefghijklmnopqrstuvwxyzäöüßABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789 .,:;-–—!?()/„“”"\'’→#&+=%*<>[]{}@_';
const WIDTHS = {
  regular: '56,61,57,61,58,37,61,59,24,24,55,24,88,59,60,61,61,38,53,33,59,56,82,55,56,55,56,60,59,62,69,65,73,72,60,59,75,74,27,57,67,57,90,75,76,64,76,64,64,65,74,69,99,68,68,63,69,76,74,63,41,61,62,65,59,62,57,62,62,28,29,29,29,30,46,50,100,29,51,36,36,36,42,44,44,47,30,26,100,63,64,66,66,98,50,66,66,36,36,43,43,97,46',
  bold: '57,62,58,62,59,39,63,61,26,26,57,26,90,61,61,62,62,40,55,35,61,59,84,57,59,57,57,61,61,64,73,66,74,72,61,59,75,75,28,58,70,57,92,76,77,65,77,65,65,66,74,73,102,72,71,65,73,77,74,66,42,62,64,67,61,64,58,64,64,25,32,32,32,33,47,50,100,32,54,37,37,38,48,51,50,52,33,29,100,64,66,67,67,100,54,67,67,37,37,45,45,100,47',
  heading: '56,61,54,61,56,37,58,61,25,26,57,25,92,61,58,61,61,41,52,37,60,55,84,54,58,50,56,58,60,66,67,66,66,68,60,57,70,70,27,35,66,48,91,75,70,62,70,65,63,55,70,65,96,67,62,55,67,70,70,64,32,58,58,60,58,63,48,63,63,21,21,17,22,20,33,51,78,27,40,30,29,34,37,37,37,33,15,18,98,60,73,50,50,95,41,50,50,30,29,32,32,96,53',
  display: '56,61,53,61,55,37,57,60,25,25,56,24,92,60,58,61,61,41,51,37,59,54,84,54,57,50,56,58,59,65,67,65,65,67,59,56,69,69,26,34,66,47,91,75,69,61,69,65,62,54,70,64,96,67,62,54,67,69,70,63,32,57,57,60,58,62,48,62,62,19,21,17,22,19,32,51,78,26,39,29,29,33,37,38,38,34,15,18,97,59,72,50,50,95,41,50,50,29,29,31,31,96,51',
};
const EM = Object.fromEntries(
  Object.entries(WIDTHS).map(([face, list]) => {
    const w = list.split(',').map(Number);
    return [face, new Map([...CHARS].map((c, k) => [c, w[k]! / 100]))];
  }),
) as Record<Face, Map<string, number>>;

/** How wide `text` is set in `face` at `size` px; a character not measured counts as a wide one. */
const widthOf = (text: string, face: Face, size: number) => [...text].reduce((w, c) => w + (EM[face].get(c) ?? 0.75), 0) * size;

/** About how many characters of `face` at `size` px a line `width` px wide holds, by the mean width of its lower-case letters. */
export function charsIn(width: number, face: Face, size: number) {
  const letters = [...'abcdefghijklmnopqrstuvwxyz'];
  return Math.floor(width / ((letters.reduce((w, c) => w + EM[face].get(c)!, 0) / letters.length) * size));
}

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
    const title = lay(s.title, 'display', TITLE.size, TITLE.width);
    if (title.tooWide) return `"${title.tooWide}" in the title is wider than the title's line: use a shorter word.`;
    const sub = s.subtitle ? lay(s.subtitle, 'regular', TITLE.sub, TITLE.subWidth).lines : 0;
    const height = TITLE.bar + title.lines * TITLE.line + (sub ? TITLE.subGap + sub * TITLE.subLine : 0);
    return over(height, SLIDE_HEIGHT - 2 * TITLE.pad, TITLE.line, 'Shorten its title or subtitle.');
  }
  if (s.type === 'points') {
    const laid = s.points.map((p) => lay(p, 'regular', POINT.size, CONTENT_WIDTH - 2 * (POINT.padX + POINT.border) - POINT.dot));
    const wide = laid.findIndex((l) => l.tooWide);
    if (wide >= 0) return `"${laid[wide]!.tooWide}" in point ${wide + 1} is wider than the slide: break it up.`;
    const height = header(s.title) + laid.reduce((h, l) => h + l.lines * POINT.line + 2 * (POINT.padY + POINT.border), 0) + (s.points.length - 1) * POINT.gap;
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
        return `"${wide}" in step ${k + 1} is wider than its box: a flow of ${n} steps gives each box room for about ${charsIn(inner + STEP.spill, 'bold', STEP.label)} characters: use shorter words${n > 3 ? ' or fewer steps' : ''}, and let the narration say the rest.`;
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
