// The search over every card: the canvas's first, the archive's below. It matches as the archive's
// filter does (every typed word, case and accents aside); a card whose title holds the words comes
// before one that holds them only in its text (description, summary, last status, open question,
// a proposal's reason, a project's goal) or label. Before the first word it lists the canvas's
// cards, the one changed last first. The row under the pointer or picked by the arrow keys lights
// its card up on the canvas.

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Item } from '../core/types';
import { fold, labelOf, marked, matches, searchWords } from './archive';
import { plain } from './markdown';
import { shownState } from './parts';
import { useMenuClose } from './queue';
import { stateLabel, t } from './strings';

/** Results listed per section; the rest are counted. */
const LIMIT = 30;

export interface Hit {
  item: Item;
  /** Its title holds every word; else they are in its text or label. */
  byTitle: boolean;
}

/** The cards holding every word of `query`, those with all of them in the title first, each group in the given order. */
export function findCards(query: string, cards: Item[]): Hit[] {
  const words = searchWords(query);
  if (!words.length) return [];
  const hits = cards.filter((i) => (i.title || i.body) && matches(i, words)).map((item) => ({ item, byTitle: words.every((w) => fold(plain(item.title)).includes(w)) }));
  return [...hits.filter((h) => h.byTitle), ...hits.filter((h) => !h.byTitle)];
}

/** Before the first word: every card on the canvas, the one where something happened last first. */
export function recentCards(cards: Item[]): Hit[] {
  return cards
    .filter((i) => i.title || i.body)
    .map((item, n) => ({ item, n }))
    .sort((a, b) => (b.item.changedAt ?? '').localeCompare(a.item.changedAt ?? '') || a.n - b.n)
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
  onToggle: () => void;
  onClose: () => void;
  /** A card unfolded from the list is open: the list stays under the dim, for the card to fold back into. */
  held: boolean;
  /** The cards on the canvas. */
  items: Item[];
  /** The archive as the server sends it. */
  archived: Item[];
  onOpen: (i: Item) => void;
  /** The canvas's card whose row is under the pointer or picked by the arrow keys, to light it up there; `null` for none. */
  onLight: (id: string | null) => void;
  /** Where an archived card unfolds from and folds back to. */
  els: Map<string, HTMLElement>;
  icon: ReactNode;
}

/** The bar's search button; a click (or `S`) shows a field and, under it, the cards it finds. A click beside it or Esc (in App) closes it. */
export function SearchPill({ on, onToggle, onClose, held, items, archived, onOpen, onLight, els, icon }: Props) {
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(on, box, () => held || onClose());
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // the active row lights its card up once the pointer or an arrow key picked it, until the pointer leaves the list
  const [lit, setLit] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // what was searched last stays, selected, so typing starts a new search
  useEffect(() => void (on && field.current?.select()), [on]);
  useEffect(() => (setActive(0), setLit(false)), [query, on]);
  const words = searchWords(query);
  const byId = new Map([...items, ...archived].map((i) => [i.id, i]));
  // the archive joins with the first word, so the list before it stays short
  const sections = on
    ? words.length
      ? [
          { key: 'canvas', heading: t.search.canvas, hits: findCards(query, items) },
          { key: 'archive', heading: t.search.archive, hits: findCards(query, archived) },
        ].filter((s) => s.hits.length)
      : [{ key: 'recent', heading: t.search.recent, hits: recentCards(items) }].filter((s) => s.hits.length)
    : [];
  const shown = sections.flatMap((s) => s.hits.slice(0, LIMIT));
  const litItem = on && lit ? shown[active]?.item : undefined;
  // an archived card is nowhere on the canvas to light up
  const litId = litItem && !litItem.archivedAt ? litItem.id : null;
  useEffect(() => onLight(litId), [litId, onLight]);
  const pick = (h: Hit | undefined) => h && onOpen(h.item);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      setLit(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown[active]);
    }
  };
  // the row picked by the arrow keys stays in sight
  useEffect(() => void box.current?.querySelector('.s-row.active')?.scrollIntoView({ block: 'nearest' }), [active]);
  let row = 0;
  return (
    <div className="menu-pill search" ref={box}>
      <button className={on ? 'pill kpill on' : 'pill kpill'} title={t.search.title} aria-expanded={on} onClick={onToggle}>
        {icon}
        <span className="lbl">{t.search.button}</span>
      </button>
      {on && (
        <div className="bar-menu search-menu" onPointerLeave={() => setLit(false)}>
          <div className="a-search">
            <input
              ref={field}
              type="text"
              autoFocus
              value={query}
              placeholder={t.search.field}
              aria-label={t.search.field}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
            {query && (
              <button className="x" title={t.archive.clearSearch} aria-label={t.archive.clearSearch} onClick={() => (setQuery(''), field.current?.focus())}>
                ×
              </button>
            )}
          </div>
          {/* what the search looks through stays above the list until the first word */}
          {!words.length && <p className="hint">{t.search.hint}</p>}
          {words.length > 0 && !sections.length ? (
            <p className="hint">{t.search.noMatch(query.trim())}</p>
          ) : (
            sections.map((s) => (
              <section key={s.key}>
                <h4>{s.heading}</h4>
                <ol>
                  {s.hits.slice(0, LIMIT).map((h) => {
                    const i = h.item;
                    const k = row++;
                    const project = i.parent ? byId.get(i.parent) : undefined;
                    const label = i.archivedAt ? labelOf(i) : stateLabel(i);
                    const about = [label, project && [i.label, plain(project.title)].filter(Boolean).join(' · '), i.archivedAt && t.archive.day(new Date(i.archivedAt))].filter(Boolean).join(' · ');
                    return (
                      <li key={i.id}>
                        <button
                          className={k === active ? 's-row active' : 's-row'}
                          style={{ '--c': `var(--${i.archivedAt ? 'live' : shownState(i)})` } as CSSProperties}
                          ref={i.archivedAt ? (el) => void (el ? els.set(i.id, el) : els.delete(i.id)) : undefined}
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
                {s.hits.length > LIMIT && <p className="hint">{(words.length ? t.search.more : t.search.moreAll)(s.hits.length - LIMIT)}</p>}
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
