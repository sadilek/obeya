// A frame's height that follows the page in it.

import { type RefObject, useEffect, useState } from 'react';

/**
 * The frame's height for the page in it to fit: what the page reports (`withHeightReport` in
 * `src/core/frame.ts`) and the frame's border, up to `cap`; undefined until it has reported. A
 * page as high as its frame would grow with each step: it stops after a few.
 */
export function useReportedHeight(frame: RefObject<HTMLIFrameElement | null>, cap: number) {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    let steps = 0;
    const on = (e: MessageEvent) => {
      const h = e.source === frame.current?.contentWindow && (e.data as { obeyaHeight?: unknown } | null)?.obeyaHeight;
      const f = frame.current;
      // the border is inside the frame's height (border-box): without it the page is a few pixels too high and scrolls
      if (typeof h === 'number' && h > 0 && f && steps++ < 30) setHeight(Math.min(Math.ceil(h) + f.offsetHeight - f.clientHeight, cap));
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);
  return height;
}
