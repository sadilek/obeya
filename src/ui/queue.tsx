// The queue: the bar's button with its count and the list under it, where a row is dragged to its
// place by its grip (or, with a mouse, by itself), as far as its waits let it; pulled farther, it says
// why it stops. A row's × takes its card out. On the card, two buttons move it one place earlier or
// later; one whose way is blocked by a wait says why when clicked (and on hover), and at the head or
// the end of the queue it is greyed out. The card also unfolds the queue, where it alone is dragged.

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { move, movable, notStarted, queueOrder, reach } from '../core/queue';
import type { Item } from '../core/types';
import { api } from './api';
import { plain } from './markdown';
import { type Drag, useSortable } from './sortable';
import { failText, stateLabel, t } from './strings';

/** A list under a bar's button: while it is `on`, a click anywhere beside `box` closes it, and Esc does with `esc`. */
export function useMenuClose(on: boolean, box: RefObject<HTMLElement | null>, close: () => void, esc = false) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!on) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || latest.current();
    const key = (e: KeyboardEvent) => esc && e.key === 'Escape' && latest.current();
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', key);
    };
  }, [on]);
}

/** The bar's queue button: how many cards wait; a click lists them under it, in turn, to open or move. */
export function QueuePill({ items, onOpen }: { items: Item[]; onOpen: (i: Item) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = useQueueSort(items, list);
  const queued = q.queued;
  useMenuClose(open, box, () => setOpen(false), true);
  // the list closed under a drag: the row is not dropped anywhere
  useEffect(() => {
    if (!open) q.sort.cancel();
  }, [open]);
  return (
    <div className="menu-pill queue" ref={box}>
      <button className={open ? 'pill kpill on' : 'pill kpill'} title={t.queue.count(queued.length)} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
        </svg>
        <span className="lbl">{t.queue.button}</span>
        {queued.length > 0 && <span className="n">{queued.length}</span>}
      </button>
      {open && (
        <div className="bar-menu queue-menu" ref={list}>
          {queued.length ? (
            <QueueList
              items={items}
              q={q}
              onOpen={(i) => {
                setOpen(false);
                onOpen(i);
              }}
            />
          ) : (
            <p className="hint">{t.queue.empty}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The queue's order to drag in: in the bar's list every card that may move, on a waiting card
 * (`own`) only that card. Held by what stays mounted while the list folds and unfolds, so that a
 * drop shown ahead of the server keeps the next drag from starting from the old order.
 */
export function useQueueSort(items: Item[], scroller: RefObject<HTMLElement | null>, own?: string) {
  // why a row's last move or × did not go
  const [failed, setFailed] = useState<{ id: string; text: string }>();
  const queued = queueOrder(items);
  const fixed = (id: string) => (own ? id !== own : !movable(queued.find((i) => i.id === id)!));
  const sort = useSortable(
    queued.map((i) => i.id),
    {
      reach: (id) => ({ earlier: reach(id, true, items).places, later: reach(id, false, items).places }),
      drop: (id, places) => {
        setFailed(undefined);
        return api.act(id, { action: 'reorder', earlier: places < 0, places: Math.abs(places) }).catch((err) => {
          setFailed({ id, text: failText(err) });
          throw err;
        });
      },
      scroller,
      fixed,
    },
  );
  return { queued, sort, fixed, own, failed, setFailed };
}

/**
 * The waiting cards in turn, a row dragged to its place as far as its waits let it. In the bar's
 * list (`onOpen`) a row opens its card and its × takes it out of the queue; on a waiting card the
 * other rows stand there to show where it is.
 */
export function QueueList({ items, q, onOpen }: { items: Item[]; q: ReturnType<typeof useQueueSort>; onOpen?: (i: Item) => void }) {
  const { queued, sort, fixed, own, failed, setFailed } = q;
  return (
    <ol className={own ? 'qlist on-card' : 'qlist'}>
      {sort.order.map((id) => {
        const i = queued.find((q) => q.id === id)!;
        return (
          <QueueRow
            key={id}
            item={i}
            items={items}
            own={id === own}
            row={sort.row(id)}
            grip={fixed(id) ? undefined : sort.grip(id)}
            drag={sort.drag?.key === id ? sort.drag : undefined}
            failed={failed?.id === id ? failed.text : ''}
            onFail={(text) => setFailed(text ? { id, text } : undefined)}
            onOpen={onOpen}
          />
        );
      })}
    </ol>
  );
}

/** What a waiting card's line says it waits for: each card by `name`, and whether it has not been started. */
export function waitedOn(ids: string[], items: Item[], name: (id: string) => string = (id) => plain(items.find((i) => i.id === id)?.title ?? id)) {
  return ids.map((id) => {
    const i = items.find((x) => x.id === id);
    return { title: name(id), notStarted: !!i && notStarted(i) };
  });
}

export type Behind = { behind: string[]; reason: string; manualWait?: string[] };

/** Why a card waits behind others: the reason Obeya gave, or the owner's arrows where only they hold it. */
export const waitReason = (q: Behind) => (q.behind.some((id) => !q.manualWait?.includes(id)) ? q.reason : t.queue.drawn);

/** The confirmation that a waiting card was started anyway. */
export const forcedText = (q: Item['queue']) => (q && 'behind' in q && q.behind.every((id) => q.manualWait?.includes(id)) ? t.queue.forcedDrawn : t.queue.forced);

/** What a card waits for and why: the waits Obeya inferred with their reason, then those the owner's arrows hold it for. */
export function waitText(q: Behind, items: Item[], name?: (id: string) => string): string {
  const drawn = q.behind.filter((id) => q.manualWait?.includes(id));
  const inferred = q.behind.filter((id) => !drawn.includes(id));
  if (!inferred.length) return `${t.queue.behind(waitedOn(drawn, items, name))} ${t.queue.drawn}`;
  return `${t.queue.behind(waitedOn(inferred, items, name))} ${q.reason}${drawn.length ? ` ${t.queue.drawnToo(waitedOn(drawn, items, name))}` : ''}`;
}

type Sort = ReturnType<typeof useSortable>;

/** A card in the queue, with its grip and what it waits for; in the bar's list (`onOpen`) also the × that takes it out of the queue. */
function QueueRow(p: {
  item: Item;
  items: Item[];
  own: boolean;
  row: ReturnType<Sort['row']>;
  grip?: ReturnType<Sort['grip']>;
  drag?: Drag;
  failed: string;
  onFail: (text: string) => void;
  onOpen?: (i: Item) => void;
}) {
  const { item, items, onOpen } = p;
  // pulled beyond where its waits let it go: the card that stops it, and why
  const stop = p.drag?.held && reach(item.id, p.drag.held === 'earlier', items);
  const held = stop && stop.stop && stop.why ? t.queue.stuck[stop.why](plain(stop.stop.title)) : '';
  return (
    <li className={p.own ? 's-planned own' : 's-planned'} {...p.row} onClick={onOpen && (() => onOpen(item))}>
      {p.grip ? (
        <span className="grip" title={t.queue.drag} aria-hidden {...p.grip}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2.5" cy="3" r="1.5" />
            <circle cx="7.5" cy="3" r="1.5" />
            <circle cx="2.5" cy="8" r="1.5" />
            <circle cx="7.5" cy="8" r="1.5" />
            <circle cx="2.5" cy="13" r="1.5" />
            <circle cx="7.5" cy="13" r="1.5" />
          </svg>
        </span>
      ) : (
        <span className="grip none" />
      )}
      <span className="dot" />
      <span className="q-what">
        {plain(item.title)}
        <br />
        <span className="hint">{item.queue && 'behind' in item.queue ? t.queue.behind(waitedOn(item.queue.behind, items)) : stateLabel(item)}</span>
        {p.failed && <span className="hint why">{p.failed}</span>}
      </span>
      {onOpen && (
        <button
          className="x"
          title={t.queue.dequeue}
          aria-label={t.queue.dequeue}
          onClick={(e) => {
            e.stopPropagation();
            p.onFail('');
            api.act(item.id, { action: 'dequeue' }).catch((err) => p.onFail(failText(err)));
          }}
        >
          ×
        </button>
      )}
      {held && <span className="q-held">{held}</span>}
    </li>
  );
}

/** The nearest element around `el` that scrolls now (one that may scroll but holds all it has does not), as a ref the drag reads when it starts. */
export function scrollerOf(el: RefObject<HTMLElement | null>): RefObject<HTMLElement | null> {
  return {
    get current() {
      for (let e = el.current?.parentElement; e; e = e.parentElement) if (/auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight) return e;
      return null;
    },
  };
}

/** The buttons, the card's place, and why the last move did not go; none for a card that cannot move. */
export function useQueueMove(item: Item, items: Item[]): { buttons: ReactNode; place: string; why: string } | undefined {
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
          api.act(item.id, { action: 'reorder', earlier }).catch((err) => setWhy({ id: item.id, text: failText(err), error: true }));
        }}
      >
        {earlier ? '↑' : '↓'}
        {` ${label}`}
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
