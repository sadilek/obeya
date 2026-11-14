// A card's number (`K42`), on its face and in its sheet: a click puts it on the clipboard, so the
// owner can name the card by it to the Coordinator and the agents. In the sheet, the day the card
// was made stands before it.

import { useRef } from 'react';
import { cardTag } from '../core/card-number';
import { useCopied } from './copy';
import { day, madeOn, t } from './strings';

/** The two sheets of the copy icon. */
export function CopyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13 4.5V4.2A1.2 1.2 0 0 0 11.8 3H4.2A1.2 1.2 0 0 0 3 4.2v7.6A1.2 1.2 0 0 0 4.2 13h.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The card's number as a button that copies it and says so for a moment; where the page may not
 * write the clipboard, it selects the number instead. The copy icon after it shows while the pointer is
 * on it (on a touch screen always). A click on it neither opens nor drags the card it sits on.
 */
export function CardNumber({ n, className }: { n: number; className?: string }) {
  const tag = cardTag(n);
  const el = useRef<HTMLSpanElement>(null);
  const [done, copy] = useCopied(1500);
  return (
    <button
      type="button"
      className={['card-no', className, done].filter(Boolean).join(' ')}
      title={t.cardNumber.copy(tag)}
      aria-label={t.cardNumber.copy(tag)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        void copy(tag, el.current!);
      }}
    >
      <span ref={el}>{tag}</span>
      {done ? <span className="card-no-done">{done === 'copied' ? t.copied : t.cardNumber.selected}</span> : <CopyIcon size={12} />}
    </button>
  );
}

/** An open card's day of making and its number, side by side in the sheet's head. */
export function CardId({ n, createdAt, className }: { n: number; createdAt?: string; className: string }) {
  return (
    <div className={className}>
      {createdAt && (
        <span className="card-made" title={madeOn(createdAt)}>
          {day(createdAt)}
        </span>
      )}
      <CardNumber n={n} />
    </div>
  );
}

/**
 * The room the sheet's head (`CardId`, which lies over the sheet) takes beside the first line of
 * the card's text, kept free so a long title wraps before it: as wide as the head's words.
 */
export function CardIdRoom({ n, createdAt }: { n: number; createdAt?: string }) {
  return (
    <span className="card-id-room" aria-hidden="true">
      {createdAt && <span>{day(createdAt)}</span>}
      <span>{cardTag(n)}</span>
    </span>
  );
}
