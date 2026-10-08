// Moving a waiting card earlier or later in the queue: the same two buttons on the card and in the
// Koordinator's queue. A button whose way is blocked by a wait says why when clicked (and on hover);
// at the head or the end of the queue it is greyed out.

import { type ReactNode, useState } from 'react';
import { move, movable, queueOrder } from '../core/queue';
import type { Item } from '../core/types';
import { api, ApiError } from './api';
import { plain } from './markdown';
import { errorText, t } from './strings';

/** The buttons, the card's place, and why the last move did not go; none for a card that cannot move. */
export function useQueueMove(item: Item, items: Item[], labelled = false): { buttons: ReactNode; place: string; why: string } | undefined {
  // a refusal shows until the next click; a blocked way while it is still blocked
  const [why, setWhy] = useState<{ id: string; text: string; error?: true }>();
  if (!movable(item)) return undefined;
  const order = queueOrder(items);
  const ways = [true, false].map((earlier) => {
    const { past, why: stuck } = move(item.id, earlier, items);
    return { earlier, past, blocked: past && stuck ? t.queue.stuck[stuck](plain(past.title)) : '' };
  });
  const button = ({ earlier, past, blocked }: (typeof ways)[number]) => {
    const label = earlier ? t.queue.earlier : t.queue.later;
    return (
      <button
        key={label}
        className={['btn', 'qmove', blocked && 'stuck'].filter(Boolean).join(' ')}
        disabled={!past}
        title={blocked || label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          if (blocked) return setWhy({ id: item.id, text: blocked });
          setWhy(undefined);
          api.act(item.id, { action: 'reorder', earlier }).catch((err) => setWhy({ id: item.id, text: err instanceof ApiError ? errorText(err.code) : t.offlineError, error: true }));
        }}
      >
        {earlier ? '↑' : '↓'}
        {labelled && ` ${label}`}
      </button>
    );
  };
  const shown = why?.id === item.id && (why.error || ways.some((w) => w.blocked === why.text)) ? why.text : '';
  return {
    buttons: <span className="qmoves">{ways.map(button)}</span>,
    place: t.queue.place(order.findIndex((i) => i.id === item.id) + 1, order.length),
    why: shown,
  };
}
