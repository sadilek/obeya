// „Für dich“: what waits for the owner on a canvas, as the phone view lists it and the canvas's
// navigation does on every page. Built once for both: the same entries, in the same order, with
// the same card faces. An entry only opens its card (or Obeya's conversation): the owner decides on
// a card with its demo, its questions and its conversation in view.

import { type Item, needsYou, type Talk, type Waiting } from '../core/types';
import { plain } from './markdown';
import { CardFace, cardClass } from './parts';
import { clock, shortDay, t } from './strings';

/** When it began: the time today, else the day. */
export const when = (iso: string | number) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : shortDay(iso));

/**
 * One canvas's entries in Tab's order: the cards that need the owner (but none they just acted on,
 * `underway`), then those snoozed while they waited, until they come back; and Obeya's latest answer
 * while answers wait unread in its conversation.
 */
export function forYouOf(w: Waiting, underway: (id: string) => boolean): { cards: Item[]; obeya?: Talk } {
  const cards = [...w.items.filter((i) => needsYou(i) && !underway(i.id)), ...w.items.filter((i) => i.snoozed?.waiting)];
  const unread = w.talk.filter((x) => x.unread);
  return unread.length ? { cards, obeya: unread.at(-1)! } : { cards };
}

/** One canvas's entries as rows of a list; `where` (its name, with several canvases) leads each card's kind line. */
export function ForYouRows({
  waiting,
  canvas,
  where,
  underway,
  onOpen,
  onObeya,
}: {
  waiting: Waiting;
  canvas: string;
  where?: string;
  underway: (id: string) => boolean;
  onOpen: (i: Item) => void;
  onObeya: (canvas: string) => void;
}) {
  const { cards, obeya } = forYouOf(waiting, underway);
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
