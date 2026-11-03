// Another canvas opens in the same page: the canvas shown gives way to it once it is there, while
// the rest of the page (the pinned navigation, the bar) stays, instead of the page loading anew.
// Before the page listens (and for a canvas it does not know), the address loads as a page.

let handler: ((path: string) => void) | null = null;

/** The page shows `fn`'s switch from now on; the function returned stops it. */
export function onSwitch(fn: (path: string) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Goes to the address `path` of another canvas (its own, or one of its cards'), with `?talk` and the like in its query. */
export function goTo(path: string) {
  if (handler) handler(path);
  else location.assign(path);
}
