// A card named in a text (what a queued card waits for, the card a follow-up comes from, a card
// Obeya created in reply to a command): a link that opens it in place of what is open, as long as
// it is on the canvas. Its address is the card's, so a click with a modifier opens it in a tab of its own.
import { Fragment, type ReactNode, useContext } from 'react';
import type { Item, TalkCard } from '../core/types';
import { cardPath } from './address';
import { canvasOf } from './api';
import { Body, linkableSlices, plain, WordLinks } from './markdown';
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

const OPEN_QUOTE = /^[„“"«'‘]$/;
const CLOSE_QUOTE = /^[“”"»'’]$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Normalises quotes and case strictly 1:1 (preserving UTF-16 length and indices, so characters
 * whose lowercase expands to two code units like Turkish `İ` never shift offsets).
 */
function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '„' || ch === '“' || ch === '”' || ch === '«' || ch === '»') out += '"';
    else if (ch === '‘' || ch === '’') out += "'";
    else {
      const low = ch.toLowerCase();
      out += low.length === 1 ? low : ch;
    }
  }
  return out;
}

export interface TextMatch {
  start: number;
  end: number;
  entry: TalkCard;
  text: string;
}

/**
 * Matches cards in `created` against one parsed plain-text slice (longest title first, preferring
 * occurrences surrounded by quotes, without overlapping spans).
 */
export function matchTextSlice(text: string, created: TalkCard[]): TextMatch[] {
  if (!text || !created.length) return [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([a, b]) => start < b && end > a);
  const folded = fold(text);
  const claimed: TextMatch[] = [];

  // longest titles first so "Export als PDF" claims its span before "Export"
  const order = created.map((entry, idx) => ({ entry, idx })).sort((a, b) => b.entry.title.length - a.entry.title.length || a.idx - b.idx);

  const findIn = (haystack: string, needle: string): [number, number] | null => {
    if (!needle) return null;
    const startsWord = WORD_CHAR.test(needle[0]!);
    const endsWord = WORD_CHAR.test(needle[needle.length - 1]!);
    let fallback: [number, number] | null = null;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (overlaps(at, end)) continue;
      const before = text[at - 1];
      const after = text[end];
      const quoted = !!before && !!after && OPEN_QUOTE.test(before) && CLOSE_QUOTE.test(after);
      if (quoted) return [at, end];
      if ((startsWord && before && WORD_CHAR.test(before)) || (endsWord && after && WORD_CHAR.test(after))) continue;
      if (!fallback) fallback = [at, end];
    }
    return fallback;
  };

  for (const { entry } of order) {
    const raw = entry.title.trim();
    const stripped = plain(raw).trim();
    const needles = stripped && stripped !== raw ? [raw, stripped] : [raw];
    let hit: [number, number] | null = null;
    for (const n of needles) {
      hit = findIn(text, n) ?? findIn(folded, fold(n));
      if (hit) break;
    }
    if (hit) {
      taken.push(hit);
      claimed.push({ start: hit[0], end: hit[1], entry, text: text.slice(hit[0], hit[1]) });
    }
  }

  return claimed.sort((a, b) => a.start - b.start);
}

/**
 * Checks which cards in `created` appear in the linkable inline text of `md` (outside code spans,
 * fenced code blocks, HTML comments, web addresses and links), and which ones fall back to a link
 * below the reply.
 */
export function matchCreatedCards(md: string, created: TalkCard[]): { matches: TextMatch[]; unmatched: TalkCard[] } {
  if (!created.length) return { matches: [], unmatched: [] };
  const matches: TextMatch[] = [];
  const matched = new Set<string>();
  for (const slice of linkableSlices(md)) {
    for (const m of matchTextSlice(slice, created)) {
      matches.push(m);
      matched.add(m.entry.id);
    }
  }
  return { matches, unmatched: created.filter((c) => !matched.has(c.id)) };
}

/** A link to a card created by Obeya: live in known items via `CardLink`, on another canvas via its path, plain text once archived or deleted. */
function CreatedCardLink({ entry, card, title, onOpen }: { entry: TalkCard; card: Item | undefined; title?: string; onOpen?: (i: Item) => void }) {
  if (entry.gone) return <>{plain(title ?? entry.title)}</>;
  if (card && !card.archivedAt) return <CardLink card={card} title={title ?? card.title} onOpen={onOpen} />;
  if (entry.canvas) {
    return (
      <a className="link" href={cardPath(entry.canvas, entry.short ?? entry.id)}>
        {plain(title ?? entry.title)}
      </a>
    );
  }
  return <>{plain(title ?? entry.title)}</>;
}

/**
 * Obeya's reply text, with any cards the command created turned into links: inline on each card's
 * title in parsed text (outside code, links and web addresses), and below the reply where its title
 * was not linkable in the text (a PR review card, or a title wrapped in inline code). Cards archived
 * or deleted on any canvas stay plain text.
 */
export function ReplyBody({ md, created, items, onOpen }: { md: string; created?: TalkCard[]; items?: Item[]; onOpen?: (i: Item) => void }) {
  const ctx = useContext(Cards);
  if (!created?.length) return <Body md={md} />;
  const all = items ?? ctx.items;
  const open = onOpen ?? ctx.open;
  const { unmatched } = matchCreatedCards(md, created);
  const linkSlice = (slice: string): ReactNode => {
    const hits = matchTextSlice(slice, created);
    if (!hits.length) return slice;
    const out: ReactNode[] = [];
    let last = 0;
    hits.forEach((h, i) => {
      if (h.start > last) out.push(slice.slice(last, h.start));
      out.push(
        <Fragment key={i}>
          <CreatedCardLink entry={h.entry} card={all.find((x) => x.id === h.entry.id)} title={h.text} onOpen={open} />
        </Fragment>,
      );
      last = h.end;
    });
    if (last < slice.length) out.push(slice.slice(last));
    return out;
  };
  const footer = unmatched
    .filter((entry) => !entry.gone)
    .map((entry) => ({ entry, card: all.find((x) => x.id === entry.id) }))
    .filter(({ entry, card }) => !!entry.canvas || (!!card && !card.archivedAt));
  return (
    <>
      <WordLinks.Provider value={linkSlice}>
        <Body md={md} />
      </WordLinks.Provider>
      {footer.length > 0 && (
        <div className="created-links">
          {footer.map(({ entry, card }) => (
            <span key={entry.id} className="created-link">
              ↗ <CreatedCardLink entry={entry} card={card} onOpen={open} />
            </span>
          ))}
        </div>
      )}
    </>
  );
}
