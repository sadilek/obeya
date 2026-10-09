// The queue: the bar's button with its count and the list under it, and moving a waiting card earlier
// or later, with the same two buttons on the card and in that list. A button whose way is blocked by a
// wait says why when clicked (and on hover); at the head or the end of the queue it is greyed out.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { move, movable, queueOrder } from '../core/queue';
import type { Item } from '../core/types';
import { api, ApiError } from './api';
import { plain } from './markdown';
import { errorText, stateLabel, t } from './strings';

/** The bar's queue button: how many cards wait; a click lists them under it, in turn, to open or move. */
export function QueuePill({ items, onOpen }: { items: Item[]; onOpen: (i: Item) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // in turn, with the cards being cut after them
  const order = queueOrder(items);
  const queued = [...order, ...items.filter((i) => i.state === 'planned' && i.queue && !order.includes(i))];
  useEffect(() => {
    if (!open) return;
    // a click anywhere else or Esc closes the list
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="queue-pill" ref={box}>
      <button className={open ? 'pill kpill on' : 'pill kpill'} title={t.queue.count(queued.length)} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
        </svg>
        <span className="lbl">{t.queue.button}</span>
        {queued.length > 0 && <span className="n">{queued.length}</span>}
      </button>
      {open && (
        <div className="queue-menu">
          {queued.length ? (
            <ol>
              {queued.map((i) => (
                <QueueRow
                  key={i.id}
                  item={i}
                  items={items}
                  onOpen={(i) => {
                    setOpen(false);
                    onOpen(i);
                  }}
                />
              ))}
            </ol>
          ) : (
            <p className="hint">{t.queue.empty}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** A card in the queue, with what it waits for and the buttons that move it. */
function QueueRow({ item, items, onOpen }: { item: Item; items: Item[]; onOpen: (i: Item) => void }) {
  const m = useQueueMove(item, items);
  const title = (id: string) => plain(items.find((i) => i.id === id)?.title ?? '');
  return (
    <li className="s-planned" onClick={() => onOpen(item)}>
      <span className="dot" />
      <span className="q-what">
        {plain(item.title)}
        <br />
        <span className="hint">{item.queue && 'behind' in item.queue ? t.queue.behind(item.queue.behind.map(title)) : stateLabel(item)}</span>
        {m?.why && <span className="hint why">{m.why}</span>}
      </span>
      {m?.buttons}
    </li>
  );
}

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
