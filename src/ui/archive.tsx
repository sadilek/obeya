// The archive: finished and stopped cards and parked or dropped ideas taken off the canvas and projects whose plan doc is
// gone, the most recently archived first, listed under the bar's button as the queue is. A project's
// workstreams belong to it and are not listed on their own. A field over the list filters it as
// the owner types and stays in sight: only the list under it scrolls. The archive grows to thousands
// of cards: the server sends them a page at a time as the owner scrolls (and searches them itself),
// and of the rows sent, only those in view and a margin around them are on the page, the rest stand
// in as space of the height they had or will roughly have.

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ARCHIVE_LABELS, type ArchiveLabel, fold, searchText, searchWords } from '../core/search';
import type { Item } from '../core/types';
import { stopped } from '../core/card';
import { api } from './api';
import { plain } from './markdown';
import { useMenuClose } from './menu';
import { useWindowedRows } from './windowed';
import { becomesLabel, stateLabel, t } from './strings';


/** How many archived cards a page brings: more than a tall screen shows. */
export const ARCHIVE_PAGE = 50;
/** The most a request may ask for (the server's limit): reading again what was shown takes several. */
const PAGE_MAX = 200;

/** The archived cards of a list as far as the owner scrolled, and how to get more. */
export interface ArchiveList {
  /** The archived cards, each project followed by its workstreams. */
  items: Item[];
  /** Whether the first page came, for these words. */
  loaded: boolean;
  /** Whether there are more after these. */
  more: boolean;
  /** Asks for the next page, unless one is on its way. */
  next: () => void;
}

const tops = (items: Item[]) => items.reduce((n, i) => n + (i.parent ? 0 : 1), 0);

/** How long the words of a search stand still before the server is asked: a page per word typed, not per letter. */
const SETTLE_MS = 150;

/** `value` once it has stood still for a moment; at once when it becomes empty. */
export function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!value) return setSettled(value);
    const t = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return settled;
}

/**
 * The archive's cards holding every word of `query` ('' for all), the most recently archived first,
 * a page at a time while `on`. When the archive's mark (`rev`) moves, what was read is read again,
 * as far as it went. `onItems` hears of every card that came.
 */
export function useArchiveList(query: string, on: boolean, rev: string | undefined, onItems: (items: Item[]) => void): ArchiveList {
  const [list, setList] = useState<{ query: string; rev?: string; items: Item[]; next?: string; loaded: boolean }>({ query, items: [], loaded: false });
  const current = useRef(list);
  current.current = list;
  // the request whose answer counts: a later one makes an earlier one's answer go unheard
  const asked = useRef(0);
  const busy = useRef(false);
  const read = async (q: string, count: number, after: string | undefined, n: number) => {
    const items: Item[] = [];
    let next = after;
    do {
      const page = await api.archivePage({ count: Math.min(PAGE_MAX, count - tops(items)), next, q, labels: archiveLabelTexts() });
      if (n !== asked.current) return null;
      items.push(...page.items);
      next = page.next;
    } while (next && tops(items) < count);
    onItems(items);
    return { items, next };
  };
  // a request, busy until its answer, which `apply` takes unless a later request was made meanwhile
  const ask = (q: string, count: number, after: string | undefined, apply: (r: { items: Item[]; next: string | undefined }) => void) => {
    const n = ++asked.current;
    busy.current = true;
    read(q, count, after, n).then(
      (r) => {
        if (!r) return;
        busy.current = false;
        apply(r);
      },
      (e) => (n === asked.current && (busy.current = false), console.error(e)),
    );
  };
  useEffect(() => {
    const l = current.current;
    if (!on || (l.loaded && l.query === query && l.rev === rev)) return;
    // the same words read again as far as the owner scrolled; other words from their start
    const count = l.query === query ? Math.max(ARCHIVE_PAGE, tops(l.items)) : ARCHIVE_PAGE;
    ask(query, count, undefined, (r) => setList({ query, rev, items: r.items, next: r.next, loaded: true }));
  }, [on, query, rev]);
  const next = () => {
    const l = current.current;
    if (busy.current || !l.next || !on) return;
    ask(l.query, ARCHIVE_PAGE, l.next, (r) => setList((was) => ({ ...was, items: [...was.items, ...r.items], next: r.next })));
  };
  // other words show what the last ones found until theirs come
  const fits = list.query === query;
  return { items: list.items, loaded: fits && list.loaded, more: fits && !!list.next, next };
}

interface Props {
  on: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** A card unfolded from the list is open: the list stays under the dim, for the card to fold back into. */
  held: boolean;
  /** The archive's mark: the list is read again once it moves. */
  rev: string | undefined;
  /** Hears of every archived card that came, for the card to open from its row. */
  onItems: (items: Item[]) => void;
  /** Finished cards of the owner's still on the canvas. */
  done: number;
  onOpen: (i: Item) => void;
  onArchiveDone: () => void;
  /** Where an archived card unfolds from and folds back to. */
  els: Map<string, HTMLElement>;
  /** The archived card that unfolds or is open: its row is scrolled into view, for it to unfold from and fold back into. */
  keep?: string;
  icon: ReactNode;
}

/** A row of the list: a day's heading, or an archived card, first or last of its day's timeline. */
type Row = { key: string; day: string; item?: undefined } | { key: string; item: Item; first: boolean; last: boolean };

/** The bar's archive button; a click lists the archive under it. A click beside the list or Esc (in App) closes it. */
export function ArchivePill({ on, onToggle, onClose, held, rev, onItems, done, onOpen, onArchiveDone, els, keep, icon }: Props) {
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(on, box, () => held || onClose());
  const [query, setQuery] = useState('');
  const words = useMemo(() => searchWords(query), [query]);
  // the whole archive, and what the words find in it, each as far as the owner scrolled
  const all = useArchiveList('', on, rev, onItems);
  const said = useSettled(words.join(' '));
  const found = useArchiveList(said, on && !!said, rev, onItems);
  // until the words stand still, what was shown before stays
  const pages = words.length && said ? found : all;
  const workstreams = useMemo(() => Map.groupBy(pages.items.filter((x) => x.parent), (x) => x.parent!), [pages.items]);
  const shown = useMemo(() => pages.items.filter((i) => !i.parent), [pages.items]);
  // one heading per day, in the server's order
  const rows = useMemo(() => {
    const rows: Row[] = [];
    let day = '';
    for (const i of shown) {
      const d = t.archive.day(new Date(i.archivedAt!));
      const last = rows.at(-1);
      if (d !== day) {
        if (last?.item) last.last = true;
        rows.push({ key: `day ${d}`, day: (day = d) });
      }
      rows.push({ key: i.id, item: i, first: d !== day || !rows.at(-1)?.item, last: false });
    }
    const last = rows.at(-1);
    if (last?.item) last.last = true;
    return rows;
  }, [shown]);

  // only the rows in view are on the page
  const { scroller: menu, list, from, to, starts, rowRef: row, onScroll: look } = useWindowedRows({ rows, keyOf: (r) => r.key, guess, keep, top: words.join(' '), on });
  // the next page once the rows on the page reach the end of those that came; and pages until the
  // card that unfolds or is open (opened from its address, say) is among them
  useEffect(() => {
    if (!on) return;
    if (to >= rows.length && pages.more) pages.next();
    else if (keep && !words.length && all.more && !all.items.some((i) => i.id === keep)) all.next();
  });
  return (
    <div className="menu-pill archive" ref={box}>
      <button className={on ? 'pill kpill on' : 'pill kpill'} title={t.archive.title} aria-expanded={on} onClick={onToggle}>
        {icon}
        <span className="lbl">{t.archive.button}</span>
      </button>
      {on && (
        <div id="amenu" className="bar-menu archive-menu">
          {all.items.length > 0 && <SearchField value={query} label={t.archive.search} onChange={setQuery} />}
          {done > 0 && (
            <button className="btn" onClick={onArchiveDone}>
              {t.archive.archiveDone(done)}
            </button>
          )}
          <div className="a-list" ref={menu} onScroll={look}>
            {all.loaded && all.items.length === 0 ? (
              <p className="hint">{t.archive.empty}</p>
            ) : pages.loaded && shown.length === 0 && words.length ? (
              <p className="hint">{t.archive.noMatch(query.trim())}</p>
            ) : !shown.length ? null : (
              <div className="timeline" ref={list} style={{ paddingTop: starts[from], paddingBottom: starts.at(-1)! - starts[to]! }}>
                {rows.slice(from, to).map((r) => {
                  if (!r.item)
                    return (
                      <h4 key={r.key} data-k={r.key} ref={row(r.key)}>
                        {r.day}
                      </h4>
                    );
                  const i = r.item;
                  const label = labelOf(i);
                  return (
                    <div key={r.key} data-k={r.key} ref={row(r.key)} className={`a-row${r.first ? ' first' : ''}${r.last ? ' last' : ''}`}>
                      <time>{t.archive.time(new Date(i.archivedAt!))}</time>
                      <span className="tick" />
                      <button className="a-card" ref={placeIn(els, i.id)} onClick={() => onOpen(i)}>
                        <span className="a-ttl">{marked(plain(i.title), words)}</span>
                        {label && (
                          <span className="hint">
                            {label}
                            {i.kind === 'project' && ` · ${t.archive.workstreams(workstreams.get(i.id)?.length ?? 0)}`}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The field over the archive's list and over the search's: what was searched last stays, selected
 * as the list opens, so typing starts a new search; × clears it.
 */
export function SearchField({ value, label, onChange, onKeyDown }: { value: string; label: string; onChange: (value: string) => void; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => void field.current?.select(), []);
  return (
    <div className="a-search">
      <input ref={field} type="text" autoFocus value={value} placeholder={label} aria-label={label} spellCheck={false} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
      {value && (
        <button className="x" title={t.archive.clearSearch} aria-label={t.archive.clearSearch} onClick={() => (onChange(''), field.current?.focus())}>
          ×
        </button>
      )}
    </div>
  );
}

/** A row's ref that keeps its element in `els` under `id`, for a card to unfold from and fold back into. */
export const placeIn = (els: Map<string, HTMLElement>, id: string) => (el: HTMLElement | null) => void (el ? els.set(id, el) : els.delete(id));

/** A row's height before it was on the page: a title of about 45 characters per line, a label below it unless a plain task. */
function guess(r: Row): number {
  if (!r.item) return 25;
  const lines = Math.max(1, Math.ceil(plain(r.item.title).length / 45));
  return 28 + lines * 19 + (labelOf(r.item) ? 18 : 0) + (r.last ? 4 : 0);
}

/** An archived card's kind or state; a plain finished task, nearly every entry, goes without one, so the others stand out. */
export function labelOf(i: Item) {
  return i.idea || i.prototypeEnd || stopped(i) ? stateLabel(i) : i.becomesProject ? becomesLabel(i) : i.kind === 'task' ? '' : t.kind[i.kind];
}

/** The archive's labels as the list shows them, for the server's search to find a card by its label too. */
export function archiveLabelTexts(): Record<ArchiveLabel, string> {
  const text = (l: ArchiveLabel): string => {
    const [kind, what] = l.split(' ') as [string, string];
    if (kind === 'idea') return t.idea.status[what as 'open' | 'parked' | 'dropped'];
    if (kind === 'prototype') return t.idea.ended[what as 'discarded' | 'built'];
    if (kind === 'kind') return t.kind[what as 'project' | 'question'];
    return l === 'stopped' ? t.stoppedState : t.kind[l as 'becomesProject' | 'taskBecomesProject'];
  };
  return Object.fromEntries(ARCHIVE_LABELS.map((l) => [l, text(l)])) as Record<ArchiveLabel, string>;
}

/** Whether a card holds every word of the search, each anywhere in its `searchText` or its label. */
export function matches(i: Item, words: string[]) {
  const text = searchText(i, [], labelOf(i));
  return words.every((w) => text.includes(w));
}

/** The title with the words of the search marked where they occur. */
export function marked(title: string, words: string[]): ReactNode {
  if (!words.length) return title;
  // folded char by char, each folded unit knowing the title's char it came from
  let folded = '';
  const from: number[] = [];
  const chars = [...title];
  chars.forEach((c, k) => {
    const f = fold(c);
    folded += f;
    for (let u = 0; u < f.length; u++) from.push(k);
  });
  const hit = chars.map(() => false);
  for (const w of words) for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + 1)) for (let u = at; u < at + w.length; u++) hit[from[u]!] = true;
  const parts: ReactNode[] = [];
  for (let k = 0; k < chars.length; ) {
    let end = k;
    while (end < chars.length && hit[end] === hit[k]) end++;
    const run = chars.slice(k, end).join('');
    parts.push(hit[k] ? <mark key={k}>{run}</mark> : run);
    k = end;
  }
  return parts;
}
