// A card named in a text (what a queued card waits for, the card a follow-up comes from, a card
// Obeya created in reply to a command): a link that opens it in place of what is open, as long as
// it is on the canvas. Its address is the card's, so a click with a modifier opens it in a tab of its own.
import { useContext } from 'react';
import type { Item, TalkCard } from '../core/types';
import { cardPath } from './address';
import { canvasOf } from './api';
import { Body, CardMentions, plain } from './markdown';
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

/** Where a created-card title may not be linked: fenced code blocks, markdown links, bare web addresses. */
const SKIP_RANGES = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|$(?![\s\S]))|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>`"]+/gm;
const OPEN_QUOTE = /^[„“"«'‘]$/;
const CLOSE_QUOTE = /^[“”"»'’]$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Normalises quotes and case 1:1 (preserving character length and indices) for fallback title matching. */
const fold = (s: string) =>
  s
    .replace(/[„“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();

export interface MatchedReply {
  /** `md` with each matched card title replaced by `\u0000<index>\u0000`, pointing into `matches`. */
  marked: string;
  /** Matched spans in `marked`, in order: the created card and the text as it stood in `md`. */
  matches: { entry: TalkCard; text: string }[];
  /** Cards from `created` whose title did not appear in `md`, in their original order. */
  unmatched: TalkCard[];
}

/**
 * Matches each card in `created` against `md` so its title can become a link in place. Longest
 * titles claim their span first, preferring occurrences surrounded by quotes; cards whose title
 * does not stand in `md` (a PR review whose title came from GitHub after the reply, say) come back
 * in `unmatched`.
 */
export function matchCreatedCards(md: string, created: TalkCard[]): MatchedReply {
  const clean = md.includes(MARK) ? md.replaceAll(MARK, '') : md;
  if (!created.length) return { marked: clean, matches: [], unmatched: [] };
  const taken: [number, number][] = [];
  for (const m of clean.matchAll(SKIP_RANGES)) taken.push([m.index, m.index + m[0].length]);
  const overlaps = (start: number, end: number) => taken.some(([a, b]) => start < b && end > a);
  const folded = fold(clean);
  const claimed: { start: number; end: number; entry: TalkCard }[] = [];
  const unmatchedIndices = new Set<number>();

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
      const before = clean[at - 1];
      const after = clean[end];
      const quoted = !!before && !!after && OPEN_QUOTE.test(before) && CLOSE_QUOTE.test(after);
      if (quoted) return [at, end];
      if ((startsWord && before && WORD_CHAR.test(before)) || (endsWord && after && WORD_CHAR.test(after))) continue;
      if (!fallback) fallback = [at, end];
    }
    return fallback;
  };

  for (const { entry, idx } of order) {
    const raw = entry.title.trim();
    const stripped = plain(raw).trim();
    const needles = stripped && stripped !== raw ? [raw, stripped] : [raw];
    let hit: [number, number] | null = null;
    for (const n of needles) {
      hit = findIn(clean, n) ?? findIn(folded, fold(n));
      if (hit) break;
    }
    if (hit) {
      taken.push(hit);
      claimed.push({ start: hit[0], end: hit[1], entry });
    } else {
      unmatchedIndices.add(idx);
    }
  }

  claimed.sort((a, b) => a.start - b.start);
  let marked = '';
  let last = 0;
  const matches: MatchedReply['matches'] = [];
  for (const c of claimed) {
    marked += clean.slice(last, c.start) + `${MARK}${matches.length}${MARK}`;
    matches.push({ entry: c.entry, text: clean.slice(c.start, c.end) });
    last = c.end;
  }
  marked += clean.slice(last);
  const unmatched = created.filter((_, idx) => unmatchedIndices.has(idx));
  return { marked, matches, unmatched };
}

/** A link to a card created by Obeya: on this canvas via `CardLink`, on another canvas via its path. */
function CreatedCardLink({ entry, card, title, onOpen }: { entry: TalkCard; card: Item | undefined; title?: string; onOpen?: (i: Item) => void }) {
  if (entry.canvas) {
    return (
      <a className="link" href={cardPath(entry.canvas, entry.id)}>
        {plain(title ?? entry.title)}
      </a>
    );
  }
  return <CardLink card={card} title={title ?? card?.title ?? entry.title} onOpen={onOpen} />;
}

/**
 * Obeya's reply text, with any cards the command created turned into links: inline on each card's
 * title where the reply names it, and below the reply where its title was not in the text (a PR
 * review card, say). Cards archived or deleted on this canvas stay plain text.
 */
export function ReplyBody({ md, created, items, onOpen }: { md: string; created?: TalkCard[]; items?: Item[]; onOpen?: (i: Item) => void }) {
  const ctx = useContext(Cards);
  if (!created?.length) return <Body md={md} />;
  const all = items ?? ctx.items;
  const open = onOpen ?? ctx.open;
  const { marked, matches, unmatched } = matchCreatedCards(md, created);
  const mentions = matches.map((m, i) => <CreatedCardLink key={i} entry={m.entry} card={all.find((x) => x.id === m.entry.id)} title={m.text} onOpen={open} />);
  const footer = unmatched
    .map((entry) => ({ entry, card: all.find((x) => x.id === entry.id) }))
    .filter(({ entry, card }) => !!entry.canvas || (!!card && !card.archivedAt));
  return (
    <>
      <CardMentions.Provider value={mentions}>
        <Body md={marked} />
      </CardMentions.Provider>
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
