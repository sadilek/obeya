// What a restart's reload keeps: which card, project and sheet were open, where they were scrolled
// to, where the demo video stood, and what was typed but not sent. Written down just before the
// reload (sessionStorage, per tab), and taken once by the page that loads.

/** A sheet on the right that is not a project's, or the archive's list under its button. */
export type SideSheet = 'koordinator' | 'archive' | 'config';

export interface Kept {
  at: number;
  /** The open card, and the project whose sheet it was opened from or that is open itself. */
  card?: string;
  project?: string;
  /** The project's plan doc was read in its sheet. */
  reading?: boolean;
  sheet?: SideSheet;
  /** Scrolled boxes, by `place`. */
  scroll: [string, number][];
  /** Text fields with a draft in them, by `place`. */
  drafts: [string, string][];
  video?: { time: number; playing: boolean };
}

/** Where the open things are: the panel of the open card, the sheets and the archive's list. */
export const ROOTS = ['panel', 'sheet', 'ksheet', 'amenu', 'csheet'];

/** How old what was kept may be to come back: a restart takes seconds, a page reloaded much later starts afresh. */
const FRESH_MS = 5 * 60_000;
const key = (canvas: string) => `obeya-kept-${canvas}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function keep(store: Store, canvas: string, kept: Kept) {
  try {
    store.setItem(key(canvas), JSON.stringify(kept));
  } catch {}
}

/** What the reload before this page kept, once. */
export function takeKept(store: Store, canvas: string, now = Date.now()): Kept | null {
  try {
    const raw = store.getItem(key(canvas));
    store.removeItem(key(canvas));
    const k = raw ? (JSON.parse(raw) as Kept) : null;
    return k && now - k.at < FRESH_MS ? k : null;
  } catch {
    return null;
  }
}

const kindOf = (el: Element) =>
  el instanceof HTMLTextAreaElement ? `textarea[${el.placeholder}]` : `${el.tagName.toLowerCase()}.${[...el.classList].sort().join('.')}`;

/**
 * A name for `el` that finds it again in the page that loads: its root, what it is, and which of
 * its kind there it is. Text fields go by their placeholder, other boxes by their class.
 */
export function place(root: Element, el: Element): string {
  if (el === root) return JSON.stringify([root.id]);
  const kind = kindOf(el);
  return JSON.stringify([root.id, kind, [...root.querySelectorAll('*')].filter((x) => kindOf(x) === kind).indexOf(el)]);
}

/** The element `place` named, if the page has it. */
export function find(name: string): Element | undefined {
  const [rootId, kind, i] = JSON.parse(name) as [string, string?, number?];
  const root = document.getElementById(rootId) ?? undefined;
  if (!root || kind === undefined) return root;
  return [...root.querySelectorAll('*')].filter((x) => kindOf(x) === kind)[i!];
}

/** The scrolled boxes and the drafts in the open things. */
export function collect(): Pick<Kept, 'scroll' | 'drafts' | 'video'> {
  const scroll: [string, number][] = [];
  const drafts: [string, string][] = [];
  for (const id of ROOTS) {
    const root = document.getElementById(id);
    if (!root) continue;
    for (const el of [root, ...root.querySelectorAll('*')]) if (el.scrollTop > 0) scroll.push([place(root, el), el.scrollTop]);
    for (const el of root.querySelectorAll('textarea')) if (el.value.trim()) drafts.push([place(root, el), el.value]);
  }
  const v = document.querySelector<HTMLVideoElement>('#panel video');
  return { scroll, drafts, ...(v && v.currentTime > 0 && !v.ended ? { video: { time: v.currentTime, playing: !v.paused } } : {}) };
}

/**
 * Puts back what `collect` found, in the page as it loads: content that arrives later (a log, a
 * plan doc) moves boxes, so the positions are put back again until the content has settled, unless
 * the owner scrolls or types first.
 */
export function restore(k: Pick<Kept, 'scroll' | 'drafts' | 'video'>, settleMs = 2500) {
  const until = performance.now() + settleMs;
  const drafts = new Map(k.drafts);
  let stop = false;
  const owner = () => void (stop = true);
  const events = ['wheel', 'pointerdown', 'keydown'] as const;
  for (const e of events) addEventListener(e, owner, { capture: true, once: true });
  let video = k.video;
  const tick = () => {
    if (stop || performance.now() > until) return void events.forEach((e) => removeEventListener(e, owner, { capture: true }));
    for (const [name, top] of k.scroll) {
      const el = find(name);
      if (el && el.scrollTop !== top) el.scrollTop = top;
    }
    // a controlled field takes the draft through the input event React listens to
    for (const [name, text] of drafts) {
      const el = find(name);
      if (!(el instanceof HTMLTextAreaElement)) continue;
      drafts.delete(name);
      if (el.value) continue;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const v = video && document.querySelector<HTMLVideoElement>('#panel video');
    if (video && v && v.readyState >= HTMLMediaElement.HAVE_METADATA) {
      v.currentTime = video.time;
      if (video.playing) v.play().catch(() => {});
      video = undefined;
    }
    setTimeout(tick, 100);
  };
  tick();
}
