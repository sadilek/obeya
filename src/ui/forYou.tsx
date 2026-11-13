// "Needs you": what waits for the owner on a canvas, as the phone view lists it and the canvas's
// navigation does on every page. Built once for both: the same entries, in the same order; the phone
// shows them as the canvas's cards, the navigation as light rows (everything in it waits for the
// owner, so a waiting card's orange frame would say nothing there). An entry only opens its card (or
// Obeya's conversation): the owner decides on a card with its demo, its questions and its
// conversation in view.

import { type ReactNode, useRef, useState } from 'react';
import type { CanvasInfo, Item, Talk } from '../core/types';
import { needsYou, snoozable, type Waiting, waitingOn } from '../core/card';
import { Aside, SWIPED_CARD } from './aside';
import { plain } from './markdown';
import { ClockMark, SnoozeFor } from './snooze';
import { CardFace, cardClass, shownTitle } from './parts';
import { stateLabel, t, when } from './strings';

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

/** The same on every canvas: what the bar's button and the head of "Needs you" count. */
export const forYouTotal = (canvases: CanvasInfo[], waiting: Record<string, Waiting | undefined>, underway: (id: string) => boolean) =>
  canvases.reduce((n, c) => n + (waiting[c.id] ? forYouCount(waiting[c.id]!, underway) : 0), 0);

/**
 * A card in one of the phone's lists, tapped to open it. With `swipe` the owner swipes it aside (to
 * set it aside, or back from there), or with `swipe.snooze` to the left to snooze it, and the card
 * `swipe.hint` names nudges until they have once. Behind the card as it moves stands what the swipe
 * does.
 */
export function PhoneCard({ item: i, swipe, onOpen }: { item: Item; swipe?: Swipe; onOpen: (i: Item) => void }) {
  const [snoozing, setSnoozing] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  // a card waiting for the owner says since when, wherever it stands
  const since = needsYou(i) && i.waitingSince ? t.phone.since(when(i.waitingSince)) : undefined;
  const face: ReactNode = (
    <button className={`${cardClass(i)} ph-card`} onClick={() => onOpen(i)}>
      <CardFace inButton item={i} since={since} />
    </button>
  );
  const snoozes = !!swipe?.snooze && needsYou(i) && snoozable(i);
  const label = swipe && <span className="ph-behind-label">{swipe.label}</span>;
  return (
    <li ref={row}>
      {swipe ? (
        <Aside
          on
          className="ph-swipe"
          learnt={SWIPED_CARD}
          nudge={swipe.hint === i.id}
          behind={{
            right: label,
            left: snoozes ? (
              <span className="ph-behind-label">
                <ClockMark /> {t.snooze.button}
              </span>
            ) : (
              label
            ),
          }}
          flies={(side) => side > 0 || !snoozes}
          onGone={(side) => (side < 0 && snoozes ? setSnoozing(true) : swipe.onGone(i))}
        >
          {face}
        </Aside>
      ) : (
        face
      )}
      {snoozing && <SnoozeFor item={i} anchor={() => row.current!.getBoundingClientRect()} onClose={() => setSnoozing(false)} />}
    </li>
  );
}

/**
 * What a card swiped aside in the phone's lists does: `onGone`, which `label` names behind it;
 * `snooze`, a swipe to the left of a card waiting for the owner snoozes it instead; `hint`, the card
 * that shows the gesture.
 */
export interface Swipe {
  onGone: (i: Item) => void;
  label: string;
  snooze?: boolean;
  hint?: string;
}

/**
 * One canvas's entries as rows of a list: as the phone's cards (`swipe`, swiped aside); or `light`,
 * each its title and what it waits for, the card `open` now marked.
 */
export function ForYouRows({
  waiting,
  canvas,
  underway,
  light,
  open,
  swipe,
  onOpen,
  onObeya,
}: {
  waiting: Waiting;
  canvas: string;
  underway: (id: string) => boolean;
  light?: boolean;
  open?: string;
  swipe?: Swipe;
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
        <PhoneCard key={i.id} item={i} swipe={swipe} onOpen={onOpen} />
      ))}
      {obeya && (
        <li key={`obeya:${canvas}`}>
          <button className="card s-waiting ph-card" onClick={() => onObeya(canvas)}>
            <div className="kind">
              <span>{t.coordinator.title}</span>
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
