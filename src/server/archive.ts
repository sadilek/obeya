// The canvas's archive as the owner reads it: a page at a time, a card or an entry by its id, and
// the search through it, which keeps what it reads of the archive while the owner searches.

import type { PlanDoc } from '../core/plan-doc';
import { type ArchiveLabel, archiveLabel, fold, inTitle, searchText, searchWords } from '../core/search';
import type { ArchivePage, Item } from '../core/types';
import type { Board } from './board';
import type { ArchiveCursor, CardRow, Store } from './db';
import { workDone } from './items';
import { fromJson } from './row';

/** How many archived cards a pass over the whole archive builds at a time, the server answering between. */
const ARCHIVE_SLICE = 250;
/** How many archived cards the search's first reading of the archive reads at a time: each slice about a rebuild of the canvas view. */
const INDEX_SLICE = 100;
/** How long what the search reads of the archive is kept after the last search. */
const ARCHIVE_INDEX_KEPT_MS = 10 * 60_000;

/** What the search reads of an archived card (or of a workstream of an archived project). */
interface Indexed {
  id: string;
  /** The archived card whose entry it is in: itself, or its project. */
  top: string;
  parent?: string;
  /** Its entry's place in the archive's order. */
  order: ArchiveCursor;
  /** What a search reads (`searchText`), its label aside. */
  text: string;
  label?: ArchiveLabel;
  /** Whether its title holds every word. */
  byTitle: (words: string[]) => boolean;
}

/** What the search keeps of the archive: each entry by its archived card, read up to `upTo` of the database's log of the archive's writes. */
interface ArchiveIndex {
  upTo: number;
  byTop: Map<string, Indexed[]>;
  /** Every entry's cards in the archive's order, once a search needed them in it. */
  order: Indexed[] | null;
}

function indexed(i: Item, top: string, order: ArchiveCursor, workstreams: Item[] = []): Indexed {
  const label = archiveLabel(i);
  return { id: i.id, top, ...(i.parent ? { parent: i.parent } : {}), order, text: searchText(i, workstreams), ...(label ? { label } : {}), byTitle: (words) => inTitle(i, words) };
}

/** The archive's entries in its order, the most recently archived first, each card followed by its workstreams. */
const orderOf = (byTop: Map<string, Indexed[]>): Indexed[] => [...byTop.values()].sort((a, b) => later(a[0]!.order, b[0]!.order)).flat();

/** The archive's order (`Store.archivePage`), as the database compares text: the later archived first, of those the later created, then the greater id. */
const later = (a: ArchiveCursor, b: ArchiveCursor) => {
  const cmp = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  return cmp(a.at, b.at) || cmp(a.created, b.created) || cmp(a.id, b.id);
};
const archiveOrder = (a: CardRow, b: CardRow) => later(cursorRow(a), cursorRow(b));

const cursorRow = (r: CardRow): ArchiveCursor => ({ at: r.archived_at!, created: r.created_at, id: r.id });
/** Where a page of the archive ended, as the page gets it to ask for the next. */
const cursorFrom = (r: CardRow) => JSON.stringify([r.archived_at, r.created_at, r.id]);
/** Where the page before ended, as the page gave it back; from the start for anything else. */
function cursorOf(s: string | undefined): ArchiveCursor | undefined {
  try {
    const [at, created, id] = s ? (JSON.parse(s) as unknown[]) : [];
    return typeof at === 'string' && typeof created === 'string' && typeof id === 'string' ? { at, created, id } : undefined;
  } catch {
    return undefined;
  }
}

/** The archive of one canvas, read through its board: the cards it holds as the UI sees them. */
export class Archive {
  constructor(
    private store: Store,
    private canvasId: string,
    /** The board's cards on the canvas: building them reads the docs as they are now, which decides what is archived. */
    private board: Pick<Board, 'items'>,
    /** The items of these rows, with the plan docs of their projects as they last stood. */
    private build: (rows: CardRow[], docs: PlanDoc[]) => Item[],
  ) {
    // the search reads the whole archive anew the first time: what its log held before is read with it
    store.archiveLog.drop(canvasId, store.archiveLog.at());
  }

  /**
   * What a search through the archive reads of each archived card (`search`), kept while the
   * owner searches and up to date with the database's log of the archive's writes (`upTo`); null
   * until the first search, and again a while after the last.
   */
  private index: ArchiveIndex | null = null;
  /** The archive being read for the search, a slice at a time. */
  private indexing: Promise<ArchiveIndex> | null = null;
  /** When the search's reading of the archive goes, unless the owner searches again before. */
  private indexDrop: ReturnType<typeof setTimeout> | null = null;

  /**
   * A page of the archive, the most recently archived first (of cards archived at once, the newest
   * first): `count` cards after where the page before ended (its `next`), or from the start. A
   * project comes as its plan doc last stood, followed by its workstreams (with `parent`), which the
   * archive lists under it, not on their own. Only the cards of the page are built, however long the
   * archive: the page asks for more as the owner scrolls.
   */
  page(count: number, after?: string): ArchivePage {
    // the docs as they are now decide what is archived
    this.board.items();
    const rows = this.store.archivePage(this.canvasId, count + 1, cursorOf(after));
    const page = rows.slice(0, count);
    return { items: this.of(page), ...(rows.length > count ? { next: cursorFrom(page.at(-1)!) } : {}) };
  }

  /**
   * The whole archive, a page after the other: for a pass over all of it that the owner does not
   * wait for (a folder's cards once after a start).
   */
  async *pages(size = ARCHIVE_SLICE): AsyncGenerator<Item[]> {
    for (let after: string | undefined, first = true; first || after; first = false) {
      const page = this.page(size, after);
      yield page.items;
      after = page.next;
      // what waits for the server in the meantime is answered between the pages
      if (after) await new Promise((r) => setImmediate(r));
    }
  }

  /** The whole archive at once, the most recently archived first (`page`). */
  all(): Item[] {
    const items: Item[] = [];
    for (let after: string | undefined, first = true; first || after; first = false) {
      const page = this.page(ARCHIVE_SLICE, after);
      items.push(...page.items);
      after = page.next;
    }
    return items;
  }

  /**
   * The archive's entries of these cards, as `page` lists them, in its order: the page reads
   * again the entries it holds apart from its pages (a card opened from its address) once the
   * archive changed. A card no longer archived is left out.
   */
  entries(ids: string[]): Item[] {
    this.board.items();
    return this.of(this.store.archivedRows(this.canvasId, ids).sort(archiveOrder));
  }

  /**
   * The archive's entry holding the card an address names (its id or its short code): the archived
   * card, or the archived project of a workstream with all its workstreams; none for a card not in
   * the archive.
   */
  entry(code: string): Item[] {
    this.board.items();
    const row = this.store.cardNamed(code);
    if (!row || row.canvas_id !== this.canvasId || row.deleted_at) return [];
    if (row.archived_at) return this.of([row]);
    const parent = row.parent_id ? this.store.card(row.parent_id) : null;
    return parent?.archived_at && parent.canvas_id === this.canvasId && !parent.deleted_at ? this.of([parent]) : [];
  }

  /**
   * The archive's cards that hold every word of `query` in what a search reads (`searchText`) or in
   * their label, which `labels` gives in the owner's words; `count` of them from the `from`th on (the
   * page before's `next`). The archive's filter (`everywhere` false) finds the archived cards, each
   * with its workstreams' text, in the archive's order; the search across canvas and archive
   * (`everywhere`) finds workstreams on their own too, those with every word in the title first, and
   * names them in `hits`. Only the cards of the page are built: the rest is read from what the search
   * keeps of the archive (`indexed`), which the first search reads a slice at a time.
   */
  async search(query: string, o: { count: number; from?: number; labels?: Partial<Record<ArchiveLabel, string>>; everywhere?: boolean }): Promise<ArchivePage> {
    const words = searchWords(query);
    const index = await this.indexed();
    const labels = new Map(Object.entries(o.labels ?? {}).map(([k, v]) => [k, fold(String(v))]));
    const holds = (e: Indexed) => words.every((w) => e.text.includes(w) || (!!e.label && !!labels.get(e.label)?.includes(w)));
    const found = (index.order ??= orderOf(index.byTop)).filter((e) => (o.everywhere || !e.parent) && holds(e));
    const ranked = o.everywhere ? [...found.filter((e) => e.byTitle(words)), ...found.filter((e) => !e.byTitle(words))] : found;
    const from = Math.max(0, o.from ?? 0);
    const page = ranked.slice(from, from + o.count);
    const tops = [...new Set(page.map((e) => e.top))];
    const rank = new Map(tops.map((id, n) => [id, n]));
    const items = this.of(this.store.archivedRows(this.canvasId, tops).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!));
    return {
      items,
      found: ranked.length,
      ...(from + o.count < ranked.length ? { next: String(from + o.count) } : {}),
      ...(o.everywhere ? { hits: page.map((e) => e.id) } : {}),
    };
  }

  /**
   * What the search reads of the archive, up to date: read the first time a slice at a time, the
   * server answering between the slices; then only the entries the archive's writes since touched.
   */
  private async indexed(): Promise<ArchiveIndex> {
    // the docs as they are now decide what is archived
    this.board.items();
    if (this.indexDrop) clearTimeout(this.indexDrop);
    this.indexDrop = setTimeout(() => {
      this.index = null;
      this.indexDrop = null;
    }, ARCHIVE_INDEX_KEPT_MS);
    this.indexDrop.unref?.();
    if (!this.index) {
      this.indexing ??= this.indexArchive().finally(() => (this.indexing = null));
      this.index = await this.indexing;
    }
    const index = this.index;
    const { upTo, ids } = this.store.archiveLog.changes(this.canvasId, index.upTo);
    if (ids.length) {
      const rows = this.store.archivedRows(this.canvasId, ids);
      for (const id of ids) index.byTop.delete(id);
      for (const [top, entries] of this.indexEntries(rows)) index.byTop.set(top, entries);
      index.order = null;
      this.store.archiveLog.drop(this.canvasId, upTo);
    }
    index.upTo = upTo;
    return index;
  }

  /** The whole archive as the search reads it, a slice at a time. */
  private async indexArchive(): Promise<ArchiveIndex> {
    // the writes from here on are read again after
    const upTo = this.store.archiveLog.at();
    this.store.archiveLog.drop(this.canvasId, upTo);
    const byTop = new Map<string, Indexed[]>();
    for (let after: ArchiveCursor | undefined, first = true; first || after; first = false) {
      const rows = this.store.archivePage(this.canvasId, INDEX_SLICE, after);
      for (const [top, entries] of this.indexEntries(rows)) byTop.set(top, entries);
      after = rows.length === INDEX_SLICE ? cursorRow(rows.at(-1)!) : undefined;
      // what waits for the server in the meantime is answered between the slices
      if (after) await new Promise((r) => setImmediate(r));
    }
    return { upTo, byTop, order: null };
  }

  /** What the search reads of the entries of these archived cards, by card: the card, then its workstreams. */
  private indexEntries(rows: CardRow[]): Map<string, Indexed[]> {
    const order = new Map(rows.map((r) => [r.id, cursorRow(r)]));
    const items = this.of(rows);
    const kidsOf = Map.groupBy(items.filter((i) => i.parent), (i) => i.parent!);
    const out = new Map<string, Indexed[]>();
    for (const i of items) {
      if (i.parent) continue;
      const kids = kidsOf.get(i.id) ?? [];
      out.set(i.id, [indexed(i, i.id, order.get(i.id)!, kids), ...kids.map((k) => indexed(k, i.id, order.get(i.id)!))]);
    }
    return out;
  }

  /** The archive's items for these of its cards, each project followed by its workstreams. */
  of(rows: CardRow[]): Item[] {
    const projects = rows.filter((r) => r.plan_ref);
    const docs = projects.map((r) => fromJson(r.plan!));
    const kids = this.store.children(projects.map((r) => r.id));
    // a project whose work is done may come back to the canvas
    const done = new Set(projects.flatMap((r, n) => (workDone(docs[n]!, kids) ? [r.id] : [])));
    const items = this.build([...rows, ...kids], docs).map((i) => (done.has(i.id) ? { ...i, state: 'done' as const } : i));
    const byId = new Map(items.map((i) => [i.id, i]));
    const kidsOf = Map.groupBy(items.filter((i) => i.parent), (i) => i.parent!);
    return rows.flatMap((r) => {
      const at = { archivedAt: r.archived_at! };
      const own = byId.get(r.id);
      return own ? [{ ...own, ...at }, ...(kidsOf.get(r.id) ?? []).map((i) => ({ ...i, ...at }))] : [];
    });
  }
}
