// The archive: finished and stopped cards and parked or dropped ideas taken off the canvas and projects whose plan doc is
// gone, the most recently archived first, listed under the bar's button as the queue is. A project's
// workstreams belong to it and are not listed on their own. A field over the list filters it as
// the owner types. The list holds hundreds of cards: only the rows in view and a margin around them
// are on the page, the rest stand in as space of the height they had or will roughly have.

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { type Item, stopped } from '../core/types';
import { plain } from './markdown';
import { useMenuClose } from './queue';
import { becomesLabel, stateLabel, t } from './strings';

interface Props {
  on: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** A card unfolded from the list is open: the list stays under the dim, for the card to fold back into. */
  held: boolean;
  /** The archive as the server sends it, newest first; a project is followed by its workstreams. */
  archived: Item[];
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

/** How far beyond what is in view rows are on the page, so that scrolling shows no gap before they come. */
const MARGIN = 800;

/** The bar's archive button; a click lists the archive under it. A click beside the list or Esc (in App) closes it. */
export function ArchivePill({ on, onToggle, onClose, held, archived, done, onOpen, onArchiveDone, els, keep, icon }: Props) {
  const box = useRef<HTMLDivElement>(null);
  useMenuClose(on, box, () => held || onClose());
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  // what was searched last stays, selected, so typing starts a new search
  useEffect(() => void (on && field.current?.select()), [on]);
  const words = useMemo(() => searchWords(query), [query]);
  const workstreams = useMemo(() => Map.groupBy(archived.filter((x) => x.parent), (x) => x.parent!), [archived]);
  // each card's text to search, made the first time a search reads it
  const texts = useMemo(() => new Map<Item, string>(), [archived]);
  const shown = useMemo(() => {
    const textOf = (i: Item) => texts.get(i) ?? texts.set(i, searchText(i, workstreams.get(i.id))).get(i)!;
    return archived.filter((i) => !i.parent && (!words.length || words.every((w) => textOf(i).includes(w))));
  }, [archived, words]);
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

  // ---- only the rows in view are on the page
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The rows' heights once on the page, by key; they stay for the next opening. */
  const sizes = useRef(new Map<string, number>()).current;
  const rowEls = useRef(new Map<string, HTMLElement>()).current;
  const [, measured] = useReducer((n: number) => n + 1, 0);
  // the part of the list in view, from its top
  const [view, setView] = useState({ top: 0, height: innerHeight });
  const starts = offsets(rows.map((r) => sizes.get(r.key) ?? guess(r)));
  const [from, to] = visible(starts, view.top - MARGIN, view.top + view.height + MARGIN);
  /** The row at the top of the view and where it began, to keep it in its place in the view while rows above it change height. */
  const anchor = useRef<{ key: string; at: number } | null>(null);
  /** The card in `keep` whose row has been brought into view: the owner may scroll on from there. */
  const revealed = useRef<string | undefined>(undefined);
  // in fractions of a pixel: rounded heights add up to a list of another height than the rows on the page,
  // and a row going off the page then moves the others by a pixel, which moves the view, which brings it back
  const placeOf = (el: HTMLElement) => el.getBoundingClientRect().top - list.current!.getBoundingClientRect().top;
  const remember = (key: string, h: number) => h > 0 && Math.abs((sizes.get(key) ?? 0) - h) > 0.5 && !!sizes.set(key, h);
  const look = () => {
    const m = menu.current;
    const l = list.current;
    if (!m || !l) return;
    const top = m.scrollTop - l.offsetTop;
    setView((v) => (v.top === top && v.height === m.clientHeight ? v : { top, height: m.clientHeight }));
    anchor.current = null;
    // at the very top, a card archived meanwhile shows above the rest
    const viewTop = m.getBoundingClientRect().top;
    if (m.scrollTop > 0) for (const r of rows.slice(from, to)) {
      const el = rowEls.get(r.key);
      if (el && el.getBoundingClientRect().bottom > viewTop) {
        anchor.current = { key: r.key, at: placeOf(el) };
        break;
      }
    }
  };
  // a row whose height changes later (the fonts come, the window narrows) is measured again
  const watch = useMemo(
    () =>
      new ResizeObserver((es) => {
        let changed = false;
        for (const e of es) if (remember((e.target as HTMLElement).dataset.k!, e.borderBoxSize[0]!.blockSize)) changed = true;
        if (changed) measured();
      }),
    [],
  );
  useEffect(() => () => watch.disconnect(), []);
  const row = (key: string) => (el: HTMLElement | null) => {
    const was = rowEls.get(key);
    if (was && was !== el) watch.unobserve(was);
    if (el) {
      rowEls.set(key, el);
      watch.observe(el);
    } else rowEls.delete(key);
  };
  // a new search starts at the top of what it found
  useLayoutEffect(() => {
    if (menu.current) menu.current.scrollTop = 0;
    anchor.current = null;
  }, [words.join(' ')]);
  // the list opens at its top, with the height it has now
  useLayoutEffect(() => void (on && look()), [on]);
  useLayoutEffect(() => {
    const m = menu.current;
    if (!m) return;
    // the rows on the page as high as they are, and the row at the top where it was
    let changed = false;
    for (const r of rows.slice(from, to)) {
      const el = rowEls.get(r.key);
      if (el && remember(r.key, el.getBoundingClientRect().height)) changed = true;
    }
    const a = anchor.current && rowEls.get(anchor.current.key);
    const moved = a ? placeOf(a) - anchor.current!.at : 0;
    if (Math.abs(moved) >= 1) {
      m.scrollTop += moved;
      anchor.current!.at += moved;
    }
    if (changed) return measured();
    // the card that unfolds from its row, or is open, has it on the page and in view, once
    const el = keep && rowEls.get(keep);
    const k = keep && keep !== revealed.current ? rows.findIndex((r) => r.key === keep) : -1;
    if (el && el.offsetTop >= m.scrollTop && el.offsetTop + el.offsetHeight <= m.scrollTop + m.clientHeight) revealed.current = keep;
    else if (k >= 0) {
      m.scrollTop = list.current!.offsetTop + starts[k]! - m.clientHeight / 3;
      anchor.current = null;
    }
    if (!keep) revealed.current = undefined;
    look();
  });

  return (
    <div className="menu-pill archive" ref={box}>
      <button className={on ? 'pill kpill on' : 'pill kpill'} title={t.archive.title} aria-expanded={on} onClick={onToggle}>
        {icon}
        <span className="lbl">{t.archive.button}</span>
      </button>
      {on && (
        <div id="amenu" className="bar-menu archive-menu" ref={menu} onScroll={look}>
          {archived.length > 0 && (
            <div className="a-search">
              <input
                ref={field}
                type="text"
                autoFocus
                value={query}
                placeholder={t.archive.search}
                aria-label={t.archive.search}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="x" title={t.archive.clearSearch} aria-label={t.archive.clearSearch} onClick={() => (setQuery(''), field.current?.focus())}>
                  ×
                </button>
              )}
            </div>
          )}
          {done > 0 && (
            <button className="btn" onClick={onArchiveDone}>
              {t.archive.archiveDone(done)}
            </button>
          )}
          {archived.length === 0 ? (
            <p className="hint">{t.archive.empty}</p>
          ) : shown.length === 0 ? (
            <p className="hint">{t.archive.noMatch(query.trim())}</p>
          ) : (
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
                    <button className="a-card" ref={(el) => void (el ? els.set(i.id, el) : els.delete(i.id))} onClick={() => onOpen(i)}>
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
      )}
    </div>
  );
}

/** Where each row of these heights begins, and after them where the last one ends. */
export function offsets(heights: number[]): number[] {
  const starts = [0];
  for (const h of heights) starts.push(starts.at(-1)! + h);
  return starts;
}

/** The rows, from the first to before the last, that reach into the stretch from `top` to `bottom`, by where each begins (`offsets`). */
export function visible(starts: number[], top: number, bottom: number): [number, number] {
  const n = starts.length - 1;
  // the first row that ends below `top`
  let lo = 0;
  for (let hi = n; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (starts[mid + 1]! > top) hi = mid;
    else lo = mid + 1;
  }
  // past the end: the last row
  lo = Math.max(0, Math.min(lo, n - 1));
  let end = lo;
  while (end < n && starts[end]! < bottom) end++;
  return [lo, Math.max(end, Math.min(lo + 1, n))];
}

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

/** Lower case without accents, so „uber“ finds „Über“. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The words of a search in the archive, folded. */
export const searchWords = (query: string) => fold(query).split(/\s+/).filter(Boolean);

/**
 * A card's text that a search looks through, folded: its title, text, summary, last status, open
 * question, a proposal's reason and label; a project's goal and its workstreams too.
 */
export function searchText(i: Item, workstreams: Item[] = []) {
  return fold(
    [i.title, i.body, i.summary, i.statusLine, i.question?.text, i.proposal?.reason, labelOf(i), i.plan?.goal, ...workstreams.flatMap((w) => [w.title, w.body])].filter(Boolean).join('\n'),
  );
}

/** Whether a card holds every word of the search, each anywhere in its `searchText`. */
export function matches(i: Item, words: string[], workstreams: Item[] = []) {
  const text = searchText(i, workstreams);
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
