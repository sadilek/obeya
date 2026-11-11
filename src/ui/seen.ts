// What of each card's conversation the owner has had in view, in this browser: its messages after
// that are new to them (counted on the phone's button, marked in the conversation).
import { useEffect, useRef, useState } from 'react';
import { local, read, write, writeJson } from './stored';

/** The last event of each card's conversation the owner had in view, by card. */
const SEEN = 'obeya-seen';
// until 2026-10-17 only the phone kept it, under its own name
const BEFORE = 'obeya-phone-seen';

function all(): Record<string, number> {
  // the former key counts only while the current one is missing, not where it is broken
  try {
    return JSON.parse(read(local, SEEN) ?? read(local, BEFORE) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/** The last event of the card's conversation the owner had in view; -1 before they ever had it. */
export const seenOf = (card: string): number => all()[card] ?? -1;

export function markSeen(card: string, id: number) {
  const kept = Object.entries(all()).filter(([c]) => c !== card);
  if (writeJson(local, SEEN, Object.fromEntries([...kept.slice(-299), [card, id]]))) write(local, BEFORE, null);
}

/** Whether the page is in view: not in a background tab, not behind a locked screen. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const seen = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  return visible;
}

/** Event ids of a conversation that came while it was in view: each span after its first up to its second. */
export type Spans = [number, number][];

/** Whether the event came while the conversation was in view. */
export const cameInView = (came: Spans, id: number) => came.some(([after, upTo]) => id > after && id <= upTo);

/** What came in view, with the conversation's last event now `last`, and before it `before`. */
export const follow = (came: Spans, before: number | undefined, last: number | undefined, visible: boolean): Spans =>
  visible && before !== undefined && last !== undefined && last > before ? [...came, [before, last]] : came;

/**
 * A card's conversation in view: what of it the owner had seen when it came into view (so what came
 * after stays marked as new until it goes), and what came while it was in view (seen as it came,
 * never marked), while all it holds counts as seen as long as the page is in view. `last`: the
 * conversation's last event.
 */
export function useSeen(card: string, last: number | undefined): { seen: number; came: Spans } {
  const visible = usePageVisible();
  const atOpen = useRef<{ card: string; seen: number; last: number | undefined; came: Spans } | null>(null);
  if (atOpen.current?.card !== card) atOpen.current = { card, seen: seenOf(card), last, came: [] };
  const o = atOpen.current;
  o.came = follow(o.came, o.last, last, visible);
  if (last !== undefined) o.last = last;
  useEffect(() => {
    if (!visible || last === undefined || last <= seenOf(card)) return;
    markSeen(card, last);
  }, [card, last, visible]);
  return { seen: o.seen, came: o.came };
}
