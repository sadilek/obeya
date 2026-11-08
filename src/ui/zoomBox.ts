// Where a demo video, a walkthrough or a screenshot stands when zoomed (zoom.ts, shots.tsx Lightbox),
// and where it grows out of: the video as large as the window allows, short of full screen, with
// the microphone below it still in view.

/** How long growing and shrinking takes, and how it moves. */
export const ZOOM_MS = 380;
export const ZOOM_EASE = 'cubic-bezier(.3,.9,.3,1)';

/** Room the video leaves to the window's edge, and below it for the microphone. */
export const ZOOM_MARGIN = 32;
export const ZOOM_BELOW = 112;

export type Box = { left: number; top: number; width: number; height: number };

/**
 * The largest box of the video's shape in a window of `w`×`h`, centred above the microphone.
 * `chrome`: what stands under the picture in the same box (a walkthrough's caption and controls),
 * as high as `fixed` plus `perWidth` times the box's width.
 */
export function zoomBox(aspect: number, w: number, h: number, chrome = { fixed: 0, perWidth: 0 }): Box {
  const width = Math.max(0, Math.min(w - 2 * ZOOM_MARGIN, (h - ZOOM_MARGIN - ZOOM_BELOW - chrome.fixed) / (1 / aspect + chrome.perWidth)));
  const height = width / aspect + chrome.fixed + chrome.perWidth * width;
  return { left: (w - width) / 2, top: ZOOM_MARGIN + (h - ZOOM_MARGIN - ZOOM_BELOW - height) / 2, width, height };
}

/** The transform that puts a box of `to`'s place and size onto `from` (with transform-origin 0 0). */
export const onto = (from: Box, to: Box) => `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`;

/**
 * Where a whole image of `aspect` stands behind a thumbnail that shows it cropped to `thumb`
 * (object-fit: cover), and the inset of that box the thumbnail shows, in fractions of its size.
 */
export function behindThumb(thumb: Box, aspect: number): { box: Box; inset: { x: number; y: number } } {
  const width = Math.max(thumb.width, thumb.height * aspect);
  const height = width / aspect;
  const box = { left: thumb.left - (width - thumb.width) / 2, top: thumb.top - (height - thumb.height) / 2, width, height };
  return { box, inset: { x: (width - thumb.width) / 2 / width, y: (height - thumb.height) / 2 / height } };
}
