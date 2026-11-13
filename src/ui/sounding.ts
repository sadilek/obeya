// Whether the page plays sound right now: what the microphone waits for before it is let go (see
// `micHolder` in voice.tsx).

/** Media elements that play outside the document (a walkthrough's voice), which a look into the page does not find. */
const outside = new Set<HTMLMediaElement>();

/** Counts `el` among the page's sounds although it is in no document; for elements made once per page. */
export function soundOutside<T extends HTMLMediaElement>(el: T): T {
  outside.add(el);
  return el;
}

/** Whether a video or audio on the page plays with its sound on. */
export const sounding = () =>
  typeof document !== 'undefined' &&
  [...document.querySelectorAll<HTMLMediaElement>('audio, video'), ...outside].some((m) => !m.paused && !m.ended && !m.muted && m.volume > 0);
