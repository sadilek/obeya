// Snoozing a card until a point in time: the owner's „Später …“ with its presets and a date and time
// of their own, on a card's action row and as „Ändern“ on the snooze line of its conversation, and
// that line with „Jetzt zurückholen“. One component for every kind of card; a review card handed over
// can also wait for its contributor to respond.

import { useLayoutEffect, useRef, useState } from 'react';
import { awaitsContributorNext, type CardEvent, type Item, type Snooze } from '../core/types';
import { api } from './api';
import { useMenuClose } from './queue';
import { clock, t } from './strings';

/** The clock mark of a snoozed card and of the button that snoozes one. */
export const ClockMark = () => (
  <svg className="clock-mark" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
    <circle cx="6" cy="6" r="4.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 3.2V6l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** Who snoozed the card and what its agent does then, as the card says it below its state. */
export const snoozeWho = (s: Snooze) => [t.snooze.by[s.by], s.why].filter(Boolean).join(' · ');

/** The times the menu offers from `now`: this evening (while it is still a while off), tomorrow morning, next Monday morning. */
export function snoozePresets(now: Date): { label: string; at: Date }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0);
  const evening = at(0, 18);
  const tomorrow = at(1, 8);
  const monday = at((8 - now.getDay()) % 7 || 7, 8);
  return [
    ...(evening.getTime() - now.getTime() > 30 * 60_000 ? [{ label: t.snooze.evening(clock(evening)), at: evening }] : []),
    { label: t.snooze.tomorrow(clock(tomorrow)), at: tomorrow },
    ...(monday.getTime() !== tomorrow.getTime() ? [{ label: t.snooze.monday(clock(monday)), at: monday }] : []),
  ];
}

/** A time as a `datetime-local` field holds it, in the browser's own time zone. */
const fieldValue = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Room kept between the menu and the edges of the screen. */
const EDGE = 8;

/** Puts the menu (fixed) below the button where it fits on the screen, else above it, else as low as fits, centred on the button. */
export function placeOnScreen(menu: HTMLElement, button: DOMRect) {
  const { width, height } = menu.getBoundingClientRect();
  const below = button.bottom + 6;
  const above = button.top - 6 - height;
  const top = below + height <= innerHeight - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, innerHeight - EDGE - height);
  const left = Math.min(Math.max(EDGE, button.left + button.width / 2 - width / 2), innerWidth - EDGE - width);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(EDGE, left)}px`;
}

/**
 * The button that snoozes the card („Später …“, „Ändern“) and its menu: the presets, and a date and
 * time to pick. `inline`: the menu opens below the button where the screen has room, else above it,
 * over the conversation rather than in it (on the phone the conversation is often lower than the
 * menu, which it cut off); else above the button. A proposal's start time is set with the same
 * menu (`heading`, `hint`), which can also take the time away (`clear`). `also`: a choice above
 * the times that waits for something else than a time (a review card's contributor).
 */
export function SnoozeMenu({
  label,
  onSnooze,
  className = 'btn',
  inline = false,
  heading = t.snooze.heading,
  hint = t.snooze.hint,
  set = t.snooze.set,
  at,
  clear,
  also,
  mark = true,
}: {
  label: string;
  onSnooze: (until: string) => void;
  className?: string;
  inline?: boolean;
  heading?: string;
  hint?: string;
  /** The button that takes the date and time picked. */
  set?: string;
  /** The time set now, which the field to pick one starts from. */
  at?: Date;
  clear?: { label: string; hint: string; onClear: () => void };
  also?: { label: string; hint: string; onPick: () => void };
  /** The clock mark on the button; none where the line beside it has one. */
  mark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!inline || !open) return;
    const place = () => menu.current && box.current && placeOnScreen(menu.current, box.current.firstElementChild!.getBoundingClientRect());
    place();
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  }, [open, picking]);
  const close = () => {
    setOpen(false);
    setPicking(false);
  };
  useMenuClose(open, box, close);
  const now = new Date();
  const go = (at: Date) => {
    close();
    onSnooze(at.toISOString());
  };
  const picked = value ? new Date(value) : null;
  const valid = !!picked && !Number.isNaN(picked.getTime()) && picked.getTime() > Date.now();
  return (
    <div className={inline ? 'snooze-box inline' : 'snooze-box'} ref={box}>
      <button className={className} title={hint} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        {mark && <ClockMark />} {label}
      </button>
      {open && (
        <div className="snooze-menu" role="menu" ref={menu}>
          <div className="snooze-h">{heading}</div>
          {also && (
            <button
              className="snooze-opt also"
              role="menuitem"
              title={also.hint}
              onClick={() => {
                close();
                also.onPick();
              }}
            >
              {also.label}
            </button>
          )}
          {snoozePresets(now).map((p) => (
            <button key={p.label} className="snooze-opt" role="menuitem" onClick={() => go(p.at)}>
              {p.label}
            </button>
          ))}
          {picking ? (
            <form
              className="snooze-pick"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) go(picked);
              }}
            >
              <input type="datetime-local" value={value} min={fieldValue(now)} onChange={(e) => setValue(e.target.value)} autoFocus />
              <button className="btn primary" disabled={!valid}>
                {set}
              </button>
            </form>
          ) : (
            <button
              className="snooze-opt more"
              role="menuitem"
              onClick={() => {
                setValue(fieldValue(at && at.getTime() > now.getTime() ? at : snoozePresets(now).at(-1)!.at));
                setPicking(true);
              }}
            >
              {t.snooze.pick}
            </button>
          )}
          {clear && (
            <button
              className="snooze-opt more"
              role="menuitem"
              title={clear.hint}
              onClick={() => {
                close();
                clear.onClear();
              }}
            >
              {clear.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Snoozes the card until `until`, or wakes it; the card shows it once the server has. */
const snooze = (cardId: string, until: string) => void api.act(cardId, { action: 'snooze', until }).catch(() => {});
const awaitContributor = (cardId: string) => void api.act(cardId, { action: 'awaitContributor' }).catch(() => {});

/** „Bis amerlander sich meldet“ in the menu of a review card handed over that does not wait for its contributor yet. */
export const contributorChoice = (item: Item, pick: () => void = () => awaitContributor(item.id)) =>
  item.contribution && awaitsContributorNext(item) ? { label: t.snooze.untilContributor(item.contribution.author), hint: t.snooze.untilContributorHint(item.contribution.author), onPick: pick } : undefined;
const wake = (cardId: string) => void api.act(cardId, { action: 'wake' }).catch(() => {});

/** The line in the conversation where the card was snoozed, while it still is: with „Jetzt zurückholen“ and „Ändern“. */
export function SnoozeLine({ item, e, at }: { item: Item; e: CardEvent; at: string }) {
  return (
    <div className="note ev-state snooze-line">
      <div>
        <ClockMark /> {at} · {e.text}
      </div>
      <div className="snooze-acts">
        <button className="btn small" title={t.snooze.wakeHint} onClick={() => wake(item.id)}>
          {t.snooze.wake}
        </button>
        <SnoozeMenu label={t.snooze.change} className="btn small" inline also={contributorChoice(item)} onSnooze={(until) => snooze(item.id, until)} />
      </div>
    </div>
  );
}
