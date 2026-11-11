// Answering a part of what the card shows: text the owner marks in a conversation (an agent's message
// or their own, an open question), in what the card is about beside it (an idea's brief, a task's text, a file) or in a
// page framed there (an HTML artifact, a page among the files, an idea's mock) gets a small button
// beside it, which puts it into the card's field in quotation marks, followed by " - ", with the
// cursor behind it (`cite` in `draft.ts` says where). Until the owner has used it once the button
// names what it does beside its icon, so it is found.

import { type RefObject, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cite } from './draft';
import { useKnown } from './stored';
import { t } from './strings';
import { oneLine } from '../core/text';
import { signal } from './signal';

const KNOWN = 'obeya-cite-known';

/** The marked text as the quote has it: one line, without the spaces around it. */
export const citable = oneLine;

interface Marked {
  text: string;
  /** Where the button goes, in the window: the point it is centred on, and whether it hangs below that point rather than standing above it. */
  x: number;
  y: number;
  below: boolean;
  /** Whether it ends at that point rather than being centred on it. */
  left: boolean;
}

/** A line of the marking, or the part of the window the marking's button may stand beside: left, top, right, bottom. */
type Box = [number, number, number, number];

const boxOf = (r: DOMRect): Box => [r.left, r.top, r.right, r.bottom];
const within = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/**
 * Where the button goes for a marking from line `first` to line `last` in `view`, the part of the
 * window it is seen in: null when it is scrolled out of view. At the desk beside where the pointer let
 * go, outside the marking: below its last line, or above its first when marked backwards, on the other
 * side where the view has no room for it; on a touch screen below the middle of its last line, clear
 * of the handles and of the system's menu above it.
 */
export function spot(first: Box, last: Box, backwards: boolean, view: Box, touch: boolean): Omit<Marked, 'text'> | null {
  const [left, top, right, bottom] = view;
  if (last[3] < top || first[1] > bottom || last[2] < left || first[0] > right) return null;
  const below = touch || !backwards ? bottom - last[3] > 40 || first[1] - top < 36 : first[1] - top < 36;
  const x = touch ? (last[0] + last[2]) / 2 : backwards ? first[0] : last[2];
  // below where the mouse let go it ends there, left of the pointer, which would cover it
  const ends = below && !touch && !backwards;
  // never off the view's edge: a framed page may say its marking lies anywhere
  const y = Math.min(Math.max(below ? last[3] : first[1], top), bottom);
  return { x: Math.min(Math.max(x, left + (ends ? 80 : 24)), right - 24), y, below, left: ends };
}

/**
 * The marking in a framed page, as the page says it (`withMarkReport` in src/core/frame.ts): its
 * lines in the frame's window. There is one marking at a time, on Obeya's page or in one frame: a new
 * one in a frame takes the page's away, a press on Obeya's page the frame's.
 */
interface FrameMark {
  frame: HTMLIFrameElement;
  text: string;
  first: Box;
  last: Box;
  backwards: boolean;
}

let framed: FrameMark | null = null;
const { emit: framedChanged, on: onFramed } = signal();

/** Takes the marking away in the frame that has one: the page in it clears it on `{ obeyaUnmark }`. */
function unmarkFrame() {
  if (!framed) return;
  framed.frame.contentWindow?.postMessage({ obeyaUnmark: true }, '*');
  framed = null;
  framedChanged();
}

const isBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n));

let hearing = false;
/** Listens once for what framed pages say is marked in them. */
function hearFrames() {
  if (hearing) return;
  hearing = true;
  addEventListener('message', (e) => {
    const m = (e.data as { obeyaMarked?: unknown } | null)?.obeyaMarked;
    if (m === undefined) return;
    const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    const said = m as Partial<FrameMark> | null;
    if (!said || typeof said.text !== 'string' || !isBox(said.first) || !isBox(said.last)) {
      if (framed?.frame !== frame) return;
      framed = null;
      return framedChanged();
    }
    // only the frame the owner is at marks anything: no other can take the page's marking away
    if (document.activeElement !== frame) return;
    if (framed && framed.frame !== frame) unmarkFrame();
    // the page's marking goes, as a new marking in a page of its own would take it
    const sel = getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
    framed = { frame, text: said.text, first: said.first, last: said.last, backwards: !!said.backwards };
    framedChanged();
  });
  document.addEventListener('pointerdown', (e) => !(e.target as Element).closest?.('.cite') && unmarkFrame(), true);
}

/**
 * The button at text marked in `box`, for the field of draft `draft`: in its messages (`.msg`) and
 * the open questions below them (`.question.ask`), or
 * `anywhere` in it but a field to type in; also in a page framed in it.
 */
export function CiteButton({ box, draft, anywhere, onCite }: { box: RefObject<HTMLElement | null>; draft: string; anywhere?: boolean; onCite?: () => void }) {
  const [marked, setMarked] = useState<Marked | null>(null);
  const [citeKnown, knowCite] = useKnown(KNOWN);
  const named = !citeKnown;
  useEffect(() => {
    hearFrames();
    const touch = matchMedia('(pointer: coarse)').matches;
    // while the mouse still drags out the marking, the button waits for it to let go
    let dragging = false;
    const place = () => {
      const b = box.current;
      if (dragging || !b) return setMarked(null);
      // scrolled out of the box's view, or out of the window, the marking takes its button along
      const view = within(boxOf(b.getBoundingClientRect()), [0, 0, innerWidth, innerHeight]);
      if (framed) {
        const { frame, first, last, backwards } = framed;
        const text = citable(framed.text);
        if (!b.contains(frame) || !text) return setMarked(null);
        const f = frame.getBoundingClientRect();
        const dx = f.left + frame.clientLeft;
        const dy = f.top + frame.clientTop;
        const moved = (l: Box): Box => [l[0] + dx, l[1] + dy, l[2] + dx, l[3] + dy];
        // a page can say anything: its button stays beside its frame
        const at = spot(moved(first), moved(last), backwards, within(view, boxOf(f)), touch);
        return setMarked(at && { text, ...at });
      }
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setMarked(null);
      const typing = document.activeElement;
      if ((typing instanceof HTMLTextAreaElement || typing instanceof HTMLInputElement) && b.contains(typing)) return setMarked(null);
      const r = sel.getRangeAt(0);
      const inside = (n: Node) => {
        const el = n instanceof Element ? n : n.parentElement;
        if (anywhere) return !!el && b.contains(el) && !el.closest('[contenteditable]');
        const m = el?.closest('.msg, .question.ask');
        return !!m && b.contains(m);
      };
      if (!inside(r.startContainer) || !inside(r.endContainer)) return setMarked(null);
      const text = citable(sel.toString());
      const lines = [...r.getClientRects()].filter((c) => c.width > 0);
      if (!text || !lines.length) return setMarked(null);
      const backwards = sel.anchorNode === r.endContainer && sel.anchorOffset === r.endOffset;
      const at = spot(boxOf(lines[0]!), boxOf(lines.at(-1)!), backwards, view, touch);
      setMarked(at && { text, ...at });
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !(e.target as Element).closest?.('.cite')) {
        dragging = true;
        setMarked(null);
      }
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      place();
    };
    document.addEventListener('selectionchange', place);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    // any scroll moves the marking: the box's, a column's around it, the page's
    document.addEventListener('scroll', place, true);
    addEventListener('resize', place);
    const unheard = onFramed(place);
    return () => {
      document.removeEventListener('selectionchange', place);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      unheard();
    };
  }, [box, anywhere]);
  if (!marked) return null;
  return createPortal(
    <button
      className={['cite', marked.below && 'below', marked.left && 'left', named && 'named'].filter(Boolean).join(' ')}
      style={{ left: marked.x, top: marked.y }}
      title={t.talk.citeHint}
      aria-label={t.talk.citeHint}
      // the marking stays while the button is pressed, and so does the focus where it is
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (framed) unmarkFrame();
        else getSelection()?.removeAllRanges();
        setMarked(null);
        cite(draft, t.talk.cited(marked.text));
        onCite?.();
        knowCite();
      }}
    >
      <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
        <path d="M3.5 15v-3.6c0-3 1.3-5.3 4-6.6l.8 1.3c-1.5.9-2.3 2-2.5 3.4H8.5V15zM11.5 15v-3.6c0-3 1.3-5.3 4-6.6l.8 1.3c-1.5.9-2.3 2-2.5 3.4h2.7V15z" fill="currentColor" />
      </svg>
      {named && <span>{t.talk.cite}</span>}
    </button>,
    document.body,
  );
}
