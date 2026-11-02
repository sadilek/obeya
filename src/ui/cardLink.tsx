// A card named in a text (what a queued card waits for, the card a follow-up comes from): a link
// that opens it in place of what is open, as long as it is on the canvas. Its address is the card's,
// so a click with a modifier opens it in a tab of its own.
import { useContext } from 'react';
import type { Item } from '../core/types';
import { cardPath } from './address';
import { canvasOf } from './api';
import { plain } from './markdown';
import { Cards } from './message';

/** The card by `title` (its own by default); plain text where it is not on the canvas. `onOpen` in place of the `Cards` around it. */
export function CardLink({ card, title, onOpen, className = 'link' }: { card: Item | undefined; title?: string; onOpen?: (i: Item) => void; className?: string }) {
  const cards = useContext(Cards);
  const text = plain(title ?? card?.title ?? '');
  // an archived card is not on the canvas to unfold from
  if (!card || card.archivedAt) return <>{text}</>;
  return (
    <a
      className={className}
      href={cardPath(canvasOf(card.id), card)}
      onClick={(e) => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        (onOpen ?? cards.open)(card);
      }}
    >
      {text}
    </a>
  );
}

const MARK = '\u0000';

/** A sentence of the strings that names cards: `text` gets a mark for each name, which becomes the card's link. */
export function Naming({ text, cards, onOpen }: { text: (...names: string[]) => string; cards: { card: Item | undefined; title?: string }[]; onOpen?: (i: Item) => void }) {
  const parts = text(...cards.map((_, k) => `${MARK}${k}${MARK}`)).split(MARK);
  // the parts alternate: text, the number of a name, text, …
  return (
    <>
      {parts.map((x, k) => {
        if (k % 2 === 0) return x;
        const c = cards[Number(x)]!;
        return <CardLink key={k} card={c.card} title={c.title} onOpen={onOpen} />;
      })}
    </>
  );
}
