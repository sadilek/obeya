// The search over every card: the canvas's first, the archive's below. It matches as the archive's
// filter does (every typed word, case and accents aside, or a card number); the card a word names by
// its number comes first, then one whose title holds the words, then one that holds them only in its
// text (description, summary, last status, open question, a proposal's reason, a project's goal) or
// label. The server searches the archive, which is not on
// the page as a whole. Before the first word it lists the canvas's cards, the one changed last
// first. The row under the pointer or picked by the arrow keys lights its card up on the canvas.

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../core/types';
import { onCardEvent } from './api';
import { cardTag } from '../core/card-number';
import { byNumber, fold, inTitle, rank, ranked, searchWords } from '../core/search';
import { api } from './api';
import { archiveLabelTexts, labelOf, marked, matches, placeIn, SearchField, useSettled } from './archive';
import { plain } from './markdown';
import { shownState } from './parts';
import { useMenuClose } from './menu';
import { stateLabel, t } from './strings';

/** Results listed per section; the rest are counted. */
const LIMIT = 30;

export interface Hit {
  item: Item;
  /** Its title holds every word; else they are in its text or label. */
  byTitle: boolean;
}

/**
 * The cards holding every word of `query`: the card a word names by its number first, then those
 * with all of them in the title, then the rest, each group in the given order.
 */
export function findCards(query: string, cards: Item[]): Hit[] {
  const words = searchWords(query);
  if (!words.length) return [];
  return ranked(cards.filter((i) => (i.title || i.body) && matches(i, words)), (i) => rank(i, words)).map((item) => ({ item, byTitle: inTitle(item, words) }));
}

/**
 * Before the first word: every card on the canvas, the one where something happened last first;
 * `lines`: when a line last came into a card's log, since the snapshot its `changedAt` is from.
 */
export function recentCards(cards: Item[], lines: ReadonlyMap<string, string> = new Map()): Hit[] {
  const at = (i: Item) => {
    const line = lines.get(i.id) ?? '';
    const changed = i.changedAt ?? '';
    return line > changed ? line : changed;
  };
  return cards
    .filter((i) => i.title || i.body)
    .map((item, n) => ({ item, n, at: at(item) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.n - b.n)
    .map(({ item }) => ({ item, byTitle: true }));
}

/** A short excerpt of the card's text around the first searched word in it, the words marked. */
export function excerpt(i: Item, words: string[], width = 110): ReactNode {
  for (const line of [i.body, i.summary, i.statusLine, i.question?.text, i.proposal?.reason, i.plan?.goal].filter(Boolean).flatMap((s) => plain(s!).split('\n'))) {
    const folded = fold(line);
    const at = Math.min(...words.map((w) => folded.indexOf(w)).filter((k) => k >= 0));
    if (!Number.isFinite(at)) continue;
    let from = Math.max(0, at - Math.floor(width / 3));
    if (from > 0) from = line.indexOf(' ', from) + 1 || from;
    const to = Math.min(line.length, from + width);
    return (
      <>
        {from > 0 && '…'}
        {marked(line.slice(from, to), words)}
        {to < line.length && '…'}
      </>
    );
  }
  return null;
}

interface Props {
  on: boolean;
  /** The button that teaches the key shows: the owner has not used `/` yet, and the canvas has enough cards to search. */
  teach: boolean;
  /** A click on that button: how to open the search. */
  onTeach: () => void;
  onClose: () => void;
  /** A card unfolded from the list is open: the list stays under the dim, for the card to fold back into. */
  held: boolean;
  /** The cards on the canvas. */
  items: Item[];
  /** The archive's mark: what the search found there is looked for again once it moves. */
  rev: string | undefined;
  /** Hears of the archived cards the search found, for them to open. */
  onArchived: (items: Item[]) => void;
  onOpen: (i: Item) => void;
  /** The canvas's card whose row is under the pointer or picked by the arrow keys, to light it up there; `null` for none. */
  onLight: (id: string | null) => void;
  /** Where an archived card unfolds from and folds back to. */
  els: Map<string, HTMLElement>;
  /** Where the open list stands on the screen, as it changes, for what it covers on the canvas; `undefined` once it closed. */
  onCover: (r: DOMRect | undefined) => void;
}

/**
 * The search in the bar: `/` (in App) shows a field and, under it, the cards it finds; a click beside
 * it or Esc closes it. Until `/` has been used, a button there teaches the key.
 */
export function SearchPill({ on, teach, onTeach, onClose, held, items, rev, onArchived, onOpen, onLight, els, onCover }: Props) {
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(on, box, () => held || onClose());
  // the button that teaches the key keeps its place while the search is open, even once the first `/` made it go: nothing in the bar moves under the list
  const [taught, setTaught] = useState(teach);
  if (!on && taught !== teach) setTaught(teach);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // the active row lights its card up once the pointer or an arrow key picked it, until the pointer leaves the list
  const [lit, setLit] = useState(false);
  useEffect(() => (setActive(0), setLit(false)), [query, on]);
  const words = useMemo(() => searchWords(query), [query]);
  // a line in a card's log comes on its own, not with a new snapshot (Board.log): its time orders the list too
  const [lines, setLines] = useState<ReadonlyMap<string, string>>(new Map());
  // a line sent again later (one read out to the agent, say) keeps its own time: the latest stays
  useEffect(() => onCardEvent((e) => void (e.kind !== 'activity' && setLines((m) => ((m.get(e.cardId) ?? '') >= e.at ? m : new Map(m).set(e.cardId, e.at))))), []);
  const menu = useRef<HTMLDivElement>(null);
  const measured = useRef('');
  const measure = () => {
    const r = menu.current?.getBoundingClientRect();
    const key = r ? `${r.left} ${r.top} ${r.width} ${r.height}` : '';
    if (key === measured.current) return;
    measured.current = key;
    onCover(r);
  };
  // the list as it stands once drawn, after each change around it (the bar shifting with the
  // navigation pinned, say), when its size changes with the words and when the window does
  useLayoutEffect(measure);
  useEffect(() => {
    const el = menu.current;
    if (!on || !el) return;
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    addEventListener('resize', measure);
    return () => (seen.disconnect(), removeEventListener('resize', measure));
  }, [on]);
  // what the server found in the archive for these words: the first cards, and how many in all
  const [archived, setArchived] = useState<{ words: string; items: Item[]; hits: Hit[]; found: number }>({ words: '', items: [], hits: [], found: 0 });
  const said = useSettled(words.join(' '));
  useEffect(() => {
    if (!on || !said) return;
    let current = true;
    api.archivePage({ count: LIMIT, q: said, labels: archiveLabelTexts(), everywhere: true }).then((p) => {
      if (!current) return;
      onArchived(p.items);
      const byId = new Map(p.items.map((i) => [i.id, i]));
      const hits = (p.hits ?? []).flatMap((id) => (byId.has(id) ? [{ item: byId.get(id)!, byTitle: inTitle(byId.get(id)!, said.split(' ')) }] : []));
      setArchived({ words: said, items: p.items, hits, found: p.found ?? hits.length });
    }, console.error);
    return () => void (current = false);
  }, [on, said, rev]);
  // until the archive's answer to these words comes, the one to the words before stands
  const byId = useMemo(() => new Map([...items, ...archived.items].map((i) => [i.id, i])), [items, archived]);
  // the archive joins with the first word, so the list before it stays short; worked out once per
  // words and cards, not on every move of the pointer over the list, which lights a card up
  const sections = useMemo(() => {
    if (!on) return [];
    const section = (key: string, heading: string, hits: Hit[], all = hits.length) => ({ key, heading, hits: hits.slice(0, LIMIT), more: all - Math.min(LIMIT, hits.length) });
    return words.length
      ? [section('canvas', t.search.canvas, findCards(query, items)), section('archive', t.search.archive, archived.words ? archived.hits : [], archived.found)].filter((s) => s.hits.length)
      : [section('recent', t.search.recent, recentCards(items, lines))].filter((s) => s.hits.length);
  }, [on, query, words, items, archived, lines]);
  const shown = sections.flatMap((s) => s.hits);
  // a list that grew shorter while open (a card archived meanwhile) keeps a row picked: the last
  const at = Math.max(0, Math.min(active, shown.length - 1));
  const litItem = on && lit ? shown[at]?.item : undefined;
  // an archived card is nowhere on the canvas to light up
  const litId = litItem && !litItem.archivedAt ? litItem.id : null;
  useEffect(() => onLight(litId), [litId, onLight]);
  const pick = (h: Hit | undefined) => h && onOpen(h.item);
  const onKey = (e: KeyboardEvent) => {
    // the keys confirm or pick a character of an input method then, not a row
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (n) setActive((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      setLit(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown[at]);
    }
  };
  // the row picked by the arrow keys stays in sight
  useEffect(() => void box.current?.querySelector('.s-row.active')?.scrollIntoView({ block: 'nearest' }), [at]);
  let row = 0;
  return (
    <div className="menu-pill search" ref={box}>
      {taught && (
        <button className="pill search-hint" onClick={onTeach} style={on ? { visibility: 'hidden' } : undefined}>
          {t.search.button[0]} <kbd>/</kbd> {t.search.button[1]}
        </button>
      )}
      {on && (
        <div className="bar-menu search-menu" ref={menu} onPointerLeave={() => setLit(false)}>
          <SearchField value={query} label={t.search.field} onChange={setQuery} onKeyDown={onKey} />
          {/* the list scrolls under the field, which stays in sight */}
          <div className="s-list">
            {words.length > 0 && !sections.length ? (
              <p className="hint">{t.search.noMatch(query.trim())}</p>
            ) : (
              sections.map((s) => (
                <section key={s.key}>
                  <h4>{s.heading}</h4>
                  <ol>
                    {s.hits.map((h) => {
                      const i = h.item;
                      const k = row++;
                      const project = i.parent ? byId.get(i.parent) : undefined;
                      const label = i.archivedAt ? labelOf(i) : stateLabel(i);
                      // found by its number, the card says it
                      const about = [byNumber(i, words) && cardTag(i.number), label, project && [i.label, plain(project.title)].filter(Boolean).join(' · '), i.archivedAt && t.archive.day(new Date(i.archivedAt))].filter(Boolean).join(' · ');
                      return (
                        <li key={i.id}>
                          <button
                            className={k === at ? 's-row active' : 's-row'}
                            style={{ '--c': `var(--${i.archivedAt ? 'live' : shownState(i)})` } as CSSProperties}
                            ref={i.archivedAt ? placeIn(els, i.id) : undefined}
                            onPointerEnter={() => (setActive(k), setLit(true))}
                            onClick={() => onOpen(i)}
                          >
                            <span className="dot" />
                            <span className="s-what">
                              <span className="s-ttl">{marked(plain(i.title), words)}</span>
                              {!h.byTitle && <span className="s-text">{excerpt(i, words)}</span>}
                              {about && <span className="hint">{about}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                  {s.more > 0 && <p className="hint">{(words.length ? t.search.more : t.search.moreAll)(s.more)}</p>}
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
