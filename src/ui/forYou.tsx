// „Braucht dich“: what waits for the owner on a canvas, as the phone view lists it and the canvas's
// navigation does on every page. Built once for both: the same entries, in the same order; the phone
// shows them as the canvas's cards, the navigation as light rows (everything in it waits for the
// owner, so a waiting card's orange frame would say nothing there). An entry only opens its card (or
// Obeya's conversation): the owner decides on a card with its demo, its questions and its
// conversation in view.

import { type CanvasInfo, type Item, needsYou, type Talk, type Waiting, waitingOn } from '../core/types';
import { plain } from './markdown';
import { CardFace, cardClass, shownTitle } from './parts';
import { clock, shortDay, stateLabel, t } from './strings';

/** When it began: the time today, else the day. */
export const when = (iso: string | number) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : shortDay(iso));

/**
 * One canvas's entries in Tab's order: the cards that need the owner (but none they just acted on,
 * `underway`, nor any snoozed, which are put off until they come back); and Obeya's latest answer
 * while answers wait unread in its conversation.
 */
export function forYouOf(w: Waiting, underway: (id: string) => boolean): { cards: Item[]; obeya?: Talk } {
  const cards = w.items.filter((i) => needsYou(i) && !underway(i.id));
  const unread = w.talk.filter((x) => x.unread);
  return unread.length ? { cards, obeya: unread.at(-1)! } : { cards };
}

/** How much of a canvas's entries waits for the owner: the cards listed, and one for Obeya's answers waiting unread. */
export const forYouCount = (w: Waiting, underway: (id: string) => boolean) => waitingOn({ items: w.items.filter((i) => !underway(i.id)), talk: w.talk });

/** The same on every canvas: what the bar's button and the head of „Braucht dich“ count. */
export const forYouTotal = (canvases: CanvasInfo[], waiting: Record<string, Waiting | undefined>, underway: (id: string) => boolean) =>
  canvases.reduce((n, c) => n + (waiting[c.id] ? forYouCount(waiting[c.id]!, underway) : 0), 0);

/**
 * One canvas's entries as rows of a list: as cards, `where` (its name, with several canvases) leading
 * each one's kind line; or `light`, each its title and what it waits for, the card `open` now marked.
 */
export function ForYouRows({
  waiting,
  canvas,
  where,
  underway,
  light,
  open,
  onOpen,
  onObeya,
}: {
  waiting: Waiting;
  canvas: string;
  where?: string;
  underway: (id: string) => boolean;
  light?: boolean;
  open?: string;
  onOpen: (i: Item) => void;
  onObeya: (canvas: string) => void;
}) {
  const { cards, obeya } = forYouOf(waiting, underway);
  if (light)
    return (
      <>
        {cards.map((i) => (
          <li key={i.id}>
            <button className={i.id === open ? 'fy-row on' : 'fy-row'} aria-current={i.id === open || undefined} onClick={() => onOpen(i)}>
              <span className="fy-ttl">{shownTitle(i)}</span>
              <span className="fy-state">
                {stateLabel(i)}
                {i.waitingSince && ` · ${t.phone.since(when(i.waitingSince))}`}
              </span>
            </button>
          </li>
        ))}
        {obeya && (
          <li key={`obeya:${canvas}`}>
            <button className="fy-row" onClick={() => onObeya(canvas)}>
              <span className="fy-ttl">{plain(obeya.question ?? obeya.said)}</span>
              <span className="fy-state">
                {t.phone.obeyaAnswered} · {t.phone.since(when(obeya.at))}
              </span>
            </button>
          </li>
        )}
      </>
    );
  return (
    <>
      {cards.map((i) => (
        <li key={i.id}>
          <button className={`${cardClass(i)} ph-card`} onClick={() => onOpen(i)}>
            <CardFace item={i} where={where} since={i.waitingSince ? t.phone.since(when(i.waitingSince)) : undefined} />
          </button>
        </li>
      ))}
      {obeya && (
        <li key={`obeya:${canvas}`}>
          <button className="card s-working ph-card" onClick={() => onObeya(canvas)}>
            <div className="kind">
              <span>{[where, t.koordinator.title].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="ttl">{plain(obeya.question ?? obeya.said)}</div>
            <div className="state">
              {t.phone.obeyaAnswered}
              <span className="since"> · {t.phone.since(when(obeya.at))}</span>
            </div>
          </button>
        </li>
      )}
    </>
  );
}
