// A card's shared page as the board knows it: the demos it shows and the card's demos it may show,
// its tags, and what it lacks of what changed since it was published.

import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { type KnownChange, missedChanges, type OutdatedBy, PAGE_CHANGES, pagesVersion, THEME_CHANGED } from '../core/page-changes';
import { pageTags, untagged } from '../core/page-tags';
import type { DemoKind, PageTags, Reshare } from '../core/types';
import type { Board } from './board';
import type { CardRow, Store } from './db';
import { repoOfRow } from './plan-ref';
import { type DemoRef, fromJson, type SharedDemo, type StoredDemo, type StoredShare, toJson } from './row';

/** Whether two references name the same demo of a card. */
export const sameDemo = (a: DemoRef, b: DemoRef) => (a.handover !== undefined && b.handover !== undefined ? a.handover === b.handover : a.dir === b.dir);

/**
 * The tags of a card's page, each dimension from the first that has it: the owner's by hand, the
 * newest demo whose worker gave it, the reading session's. They belong to the page, not to a version.
 */
export function pageTagsOf(r: CardRow): PageTags {
  const s = fromJson(r.share);
  const demos = [...(fromJson(r.demos) ?? []), ...(r.demo ? [fromJson(r.demo)] : [])].reverse();
  return pageTags([s?.tags, ...demos.map((d) => d.page?.tags), s?.auto]);
}

/** The demo versions on a stored page, in order of handover. */
export const sharedDemos = (s: StoredShare): SharedDemo[] => s.demos ?? [];

/** The file that shows a demo: its video, or its artifact's page. */
const demoFile = (d: { dir: string; kind: DemoKind }) => join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4');

/** The file that shows a demo is there. */
export const demoThere = (d: { dir: string; kind: DemoKind }) => existsSync(demoFile(d));

/** How often Obeya looks again whether the demos of outdated pages are still on disk (`PageNotice.lookAtDemos`): the owner deletes them outside it. */
export const DEMO_LOOK_MS = 60_000;

/** Sharing many outdated pages again at once (share.ts), kept so a restart goes on with it. */
export interface StoredReshare {
  /** The cards still to go, in order; the first is the one going out. */
  queue: string[];
  total: number;
  done: number;
  failed: string[];
  stopped?: true;
  /** It tags pages without tags and shares them again, rather than sharing outdated ones again. */
  tags?: true;
}

const RESHARE_SETTING = 'reshare';
/** The newest page change when the owner put the notice of outdated pages away: it shows again for pages a newer one leaves outdated. */
const RESHARE_DISMISSED = 'reshare_dismissed';
/**
 * The pages a theme left outdated when the owner put the notice away, by card: the theme each was
 * published with and the one its repository had then (hashes, null for none). Such a page shows
 * again once either differs: its repository's theme changed anew, or it was shared again since.
 */
const RESHARE_DISMISSED_THEMES = 'reshare_dismissed_themes';

/** A page's theme and its repository's, as `RESHARE_DISMISSED_THEMES` keeps them. */
type ThemePair = [published: string | null, now: string | null];

/** The current theme's hash of a card's repository (theme.ts): null where it has none, undefined while that is not known (the repository does not run). */
export type ThemeNow = (r: CardRow) => string | null | undefined;

/** Whether the theme of a stored page's repository (`now`, see `ThemeNow`) differs from the one it was published with; not while it is not at rest. */
const themeChanged = (s: StoredShare, now: string | null | undefined) => !!s.url && !s.state && now !== undefined && (s.theme ?? null) !== now;

/** The changes since a stored page was published that show on its kinds of page (a video, an artifact, or both on one page); none while it is not at rest. */
export function missedBy(s: StoredShare): KnownChange[] {
  if (!s.url || s.state) return [];
  const kinds = new Set(sharedDemos(s).map((d) => d.shown.kind));
  if (!kinds.size) kinds.add('video');
  const missed = new Set([...kinds].flatMap((k) => missedChanges(s.version, k, PAGE_CHANGES)));
  return PAGE_CHANGES.filter((c) => missed.has(c));
}

/**
 * The card's earlier demos the owner can still go back to: their files are on disk (demos are
 * deleted to free space) and no later demo was rendered into the same directory over them, as it
 * was for one from before Obeya kept copies (`StoredDemo`).
 */
export function atHand(r: CardRow): { d: StoredDemo; n: number }[] {
  const all = fromJson(r.demos) ?? [];
  const latest = fromJson(r.demo);
  const later = (i: number) => [...all.slice(i + 1).map((d) => d.dir), ...(latest ? [latest.dir] : [])];
  return all.flatMap((d, n) => (!later(n).includes(d.dir) && demoThere(d) ? [{ d, n }] : []));
}

/**
 * The changes a page at rest lacks, where its demo is still at hand to share it again: the one on
 * the card, or the one it showed, kept with the share, and its files still on disk (demos are
 * deleted to free space; a page whose files are gone stays as it is, with nothing to offer).
 */
export function reshareable(r: CardRow, theme?: string | null, there = demoThere): OutdatedBy[] {
  const s = fromJson(r.share);
  const missed: OutdatedBy[] = s ? [...missedBy(s).map((c) => c.id), ...(themeChanged(s, theme) ? [THEME_CHANGED as OutdatedBy] : [])] : [];
  const demos = s ? sharedDemos(s) : [];
  if (!missed.length || !demos.length || !demos.every((d) => there({ dir: d.dir, kind: d.shown.kind }))) return [];
  return missed;
}

/**
 * The card's demos a page may show, the oldest first: its earlier ones that are still at hand (as
 * `atHand` says), then the one on the card.
 */
export function cardDemos(r: CardRow): StoredDemo[] {
  const latest = fromJson(r.demo);
  // drafts a question brought are not the work's result: no page shows them
  return [...atHand(r).map(({ d }) => d), ...(latest ? [latest] : [])].filter((d) => !d.asked);
}

/**
 * Pages from before several versions (until 2026-10-16) showed one demo (`dir`, `shown`): each
 * becomes a list of one, the card's demo in that directory (the latest one rendered there) named by
 * its handover. Runs before anything reads the canvas's shares.
 */
function convertSingleDemoShares(store: Store, canvasId: string) {
  for (const r of store.shared(canvasId)) {
    const { dir, shown, ...rest } = JSON.parse(r.share!) as StoredShare & { dir?: string; shown?: SharedDemo['shown'] };
    if (rest.demos || !dir || !shown) continue;
    const demo = cardDemos(r).findLast((d) => d.dir === dir);
    const one: SharedDemo = { ...(demo?.handover !== undefined ? { handover: demo.handover } : {}), ...(demo?.at ? { at: demo.at } : {}), dir, shown };
    store.update(r.id, { share: toJson({ ...rest, demos: [one] }) });
  }
}

/**
 * The notice of outdated and untagged shared pages in the Coordinator's sheet, and what it is made
 * of: the canvas's shared cards, archived ones too, what each page lacks, the run sharing them again,
 * and what the owner put away. Each part is kept until what it was made of changes.
 */
export class PageNotice {
  constructor(
    private store: Store,
    private canvasId: string,
    private board: Pick<Board, 'home' | 'setting' | 'setSetting' | 'changed'>,
    /** The canvas as built is out of date: a demo's file came or went (`lookAtDemos`). */
    private redraw: () => void,
  ) {
    convertSingleDemoShares(store, canvasId);
  }

  /** The canvas's shared cards (`sharedRows`) by id, with where the database's log of their writes stood when they were read. */
  private shared: { upTo: number; rows: Map<string, CardRow> } | null = null;
  /** The page stored with each shared row, as `storedShare` read it. */
  private shares = new WeakMap<CardRow, StoredShare>();
  /** The tags of each shared row's page, as `pageTags` read them. */
  private tagsOf = new WeakMap<CardRow, PageTags>();
  /** What leaves each shared row's page outdated (`outdatedAsLooked`), with the theme and the look at the demos' files it was found with. */
  private outdatedOf = new WeakMap<CardRow, { theme: string | null | undefined; looked: number; missed: OutdatedBy[] }>();
  /** How many times a look at the demos' files found one come or gone (`lookAtDemos`). */
  private looked = 0;
  /**
   * The notice of outdated pages as `reshare` made it last, with what it was made from (`noticeOf`):
   * it is made anew only once one of those changed, not with every change of the canvas.
   */
  private notice: { of: string; reshare: Reshare | null; repos: string[] } | null = null;
  /**
   * Whether the file showing each demo of an outdated page is on disk, by its path, as Obeya last
   * looked (`lookAtDemos`): the notice reads this instead of the disk. One not looked at yet counts
   * as there until the look a moment later.
   */
  private lookedFiles = new Map<string, boolean>();
  /** A look at the demos' files under way, and whether another is due once it is through. */
  private looking: Promise<void> | null = null;
  private lookAgain = false;
  private lookDue = false;
  /** The current theme of each repository (its hash, null for none), by its id; for the pages it leaves outdated. */
  private themeOf?: (repo: string) => string | null | undefined;
  /** The vocabulary of tags each repository's site names (`demo.site.tags`), for the pages without tags; none where it names none. */
  private vocabularyOf?: (repo: string) => PageTags | undefined;
  /**
   * What each shared card's page adds to the notice of outdated pages, by card, with its row and what
   * else it was made of (`pageInputs`): made again only for a row written since, so a change to one
   * shared card does not go over all of them again.
   */
  private pageNotes: { of: string; notes: Map<string, { r: CardRow; missed: OutdatedBy[] | null; untagged: boolean }> } | null = null;

  /**
   * The cards of the canvas, archived ones too, that were ever shared or are about to be: read once,
   * then kept up to date by reading again those the database logged a write of (`Store.sharedLog`).
   * A row stays the same object while it is not written, so what is made of it can be kept with it.
   */
  sharedRows(): CardRow[] {
    if (!this.shared) {
      const upTo = this.store.sharedLog.at();
      this.shared = { upTo, rows: new Map(this.store.shared(this.canvasId).map((r) => [r.id, r])) };
      this.store.sharedLog.drop(this.canvasId, upTo);
    } else {
      const { upTo, ids } = this.store.sharedLog.changes(this.canvasId, this.shared.upTo);
      if (ids.length) {
        const rows = new Map(this.store.shared(this.canvasId, ids).map((r) => [r.id, r]));
        for (const id of ids) {
          const r = rows.get(id);
          if (r) this.shared.rows.set(id, r);
          else this.shared.rows.delete(id);
        }
        this.store.sharedLog.drop(this.canvasId, upTo);
      }
      this.shared.upTo = upTo;
    }
    return [...this.shared.rows.values()];
  }

  /** The page stored with a shared card's row, read once per row (`sharedRows`). */
  storedShare(r: CardRow): StoredShare {
    let s = this.shares.get(r);
    if (!s) this.shares.set(r, (s = fromJson(r.share!)));
    return s;
  }

  /** The tags of a shared card's page (`pageTagsOf`), read once per row (`sharedRows`). */
  private pageTags(r: CardRow): PageTags {
    let tags = this.tagsOf.get(r);
    if (!tags) this.tagsOf.set(r, (tags = pageTagsOf(r)));
    return tags;
  }

  /** Sharing many outdated pages again, while it runs and until the owner puts its result away. */
  reshareRun(): StoredReshare | null {
    const v = this.board.setting(RESHARE_SETTING);
    return v ? (JSON.parse(v) as StoredReshare) : null;
  }

  setReshareRun(run: StoredReshare | null) {
    this.board.setSetting(RESHARE_SETTING, run ? JSON.stringify(run) : '');
    this.board.changed();
  }

  /**
   * The outdated pages the Coordinator's sheet offers to share again, archived cards' included,
   * with the changes each lacks: after the owner put the notice away, only those a newer change
   * left outdated.
   */
  outdatedRows(shared = this.sharedRows()): { r: CardRow; missed: OutdatedBy[] }[] {
    const offered = this.offered();
    return shared.flatMap((r) => {
      const missed = this.outdatedAsLooked(r);
      return offered(r, missed) ? [{ r, missed }] : [];
    });
  }

  /** Whether the sheet offers to share again a page that lacks the changes `missed` (`outdatedRows`), as the owner put the notice away. */
  private offered(): (r: CardRow, missed: OutdatedBy[]) => boolean {
    const at = (id: string | null) => PAGE_CHANGES.findIndex((c) => c.id === id);
    const dismissed = at(this.board.setting(RESHARE_DISMISSED));
    const themes = this.dismissedThemes();
    const hidden = (r: CardRow) => {
      const was = themes[r.id];
      return !!was && JSON.stringify(was) === JSON.stringify(this.themePair(r));
    };
    return (r, missed) => missed.some((id) => (id === THEME_CHANGED ? !hidden(r) : at(id) > dismissed));
  }

  /** What leaves the card's page outdated (`reshareable`), its repository's theme included. */
  outdatedBy(r: CardRow): OutdatedBy[] {
    return reshareable(r, this.themeNow(r));
  }

  /** `outdatedBy` with the demos' files as Obeya last looked at them (`lookedFiles`), without the disk; found once per row, theme and look. */
  private outdatedAsLooked(r: CardRow): OutdatedBy[] {
    const theme = this.themeNow(r);
    const had = this.outdatedOf.get(r);
    if (had && had.theme === theme && had.looked === this.looked) return had.missed;
    const missed = reshareable(r, theme, this.lookedThere);
    this.outdatedOf.set(r, { theme, looked: this.looked, missed });
    return missed;
  }

  private lookedThere = (d: { dir: string; kind: DemoKind }): boolean => {
    const file = demoFile(d);
    const there = this.lookedFiles.get(file);
    if (there !== undefined) return there;
    this.lookedFiles.set(file, true);
    this.lookSoon();
    return true;
  };

  /** A look at the demos' files once the code running now is through. */
  private lookSoon() {
    if (this.lookDue) return;
    this.lookDue = true;
    queueMicrotask(() => {
      this.lookDue = false;
      void this.lookAtDemos();
    });
  }

  /**
   * Looks whether the demos' files the notice of outdated pages knows of are on disk, without the
   * server waiting for the disk: a file come or gone makes the notice anew. New ones are looked at
   * as the notice meets them, all of them again every `DEMO_LOOK_MS` (the canvas's timer).
   */
  lookAtDemos(): Promise<void> {
    if (this.looking) {
      this.lookAgain = true;
      return this.looking;
    }
    this.looking = (async () => {
      do {
        this.lookAgain = false;
        const files = [...this.lookedFiles.keys()];
        const there = await Promise.all(files.map((f) => access(f).then(() => true, () => false)));
        let moved = false;
        files.forEach((f, n) => {
          if (this.lookedFiles.get(f) === there[n]) return;
          this.lookedFiles.set(f, there[n]!);
          moved = true;
        });
        if (moved) {
          this.looked++;
          this.notice = null;
          this.redraw();
        }
      } while (this.lookAgain);
    })().finally(() => (this.looking = null));
    return this.looking;
  }

  showThemes(of: (repo: string) => string | null | undefined) {
    this.themeOf = of;
    this.board.changed();
  }

  /** The current theme's hash of the card's repository (`ThemeNow`). */
  readonly themeNow: ThemeNow = (r) => this.themeOf?.(repoOfRow(r, this.board.home));

  /** The pages a theme left outdated when the owner put the notice away (`RESHARE_DISMISSED_THEMES`). */
  private dismissedThemes(): Record<string, ThemePair> {
    const v = this.board.setting(RESHARE_DISMISSED_THEMES);
    return v ? (JSON.parse(v) as Record<string, ThemePair>) : {};
  }

  /** The theme the card's page was published with, and its repository's now. */
  private themePair(r: CardRow): ThemePair {
    return [this.storedShare(r).theme ?? null, this.themeNow(r) ?? null];
  }

  /**
   * The shared pages the Coordinator's sheet offers to tag ("N pages without tags"), archived cards'
   * included: at rest, on their repository's site with a vocabulary, and lacking tags in one of its
   * dimensions. Their demos need not be at hand: the site's copy of a page is tagged in place.
   */
  untaggedRows(shared = this.sharedRows()): CardRow[] {
    return shared.filter((r) => this.untaggedRow(r));
  }

  /** Whether the card's page is among those the sheet offers to tag (`untaggedRows`). */
  private untaggedRow(r: CardRow): boolean {
    const s = this.storedShare(r);
    const vocabulary = this.vocabularyOf?.(repoOfRow(r, this.board.home));
    return !!s.url && !s.state && !s.personal && !!vocabulary && untagged(this.pageTags(r), vocabulary).length > 0;
  }

  showVocabulary(of: (repo: string) => PageTags | undefined) {
    this.vocabularyOf = of;
    this.board.changed();
  }

  /** "Hide": the notice of outdated pages goes until a newer change, and the result of a run that finished with it. */
  dismissOutdated() {
    this.board.setSetting(RESHARE_DISMISSED, pagesVersion());
    // the pages outdated by a theme now; one no longer is needs no entry
    const themes: Record<string, ThemePair> = {};
    for (const r of this.sharedRows()) if (this.outdatedAsLooked(r).includes(THEME_CHANGED)) themes[r.id] = this.themePair(r);
    this.board.setSetting(RESHARE_DISMISSED_THEMES, JSON.stringify(themes));
    this.setReshareRun(null);
  }

  /** The outdated pages, archived cards' included, and the run sharing them again; made anew only once what it is made of changed (`noticeOf`). */
  reshare(): Reshare | null {
    if (this.notice?.of !== this.noticeOf(this.notice?.repos ?? [])) {
      const rows = this.sharedRows();
      const repos = [...new Set(rows.map((r) => repoOfRow(r, this.board.home)))];
      this.notice = { reshare: this.makeReshare(rows, repos), repos, of: this.noticeOf(repos) };
      // what changed may have come with files come or gone
      this.lookSoon();
    }
    return this.notice.reshare;
  }

  /**
   * What the notice of outdated pages is made of, but for the demos' files (`lookAtDemos`): the
   * shared cards (`Store.shareRev`), the run, what the owner put away, and the theme and vocabulary
   * of tags of the repositories with shared pages (`repos`; a theme is asked for of those alone).
   */
  private noticeOf(repos: string[]): string {
    return JSON.stringify([this.store.shareRev(this.canvasId), this.board.setting(RESHARE_SETTING), this.pageInputs(repos)]);
  }

  /**
   * What the notice makes of each shared card's page besides its row: what the owner put away, the
   * theme and vocabulary of tags of the repositories with shared pages, and the look at the demos' files.
   */
  private pageInputs(repos: string[]): string {
    const settings = [RESHARE_DISMISSED, RESHARE_DISMISSED_THEMES].map((k) => this.board.setting(k));
    const looks = repos.map((id) => ({ id, theme: this.themeOf?.(id), tags: this.vocabularyOf?.(id) }));
    return JSON.stringify([settings, looks, this.looked]);
  }

  private makeReshare(rows: CardRow[], repos: string[]): Reshare | null {
    const run = this.reshareRun();
    const queued = new Set(run?.queue);
    const of = this.pageInputs(repos);
    const had = this.pageNotes?.of === of ? this.pageNotes.notes : new Map();
    const notes = new Map<string, { r: CardRow; missed: OutdatedBy[] | null; untagged: boolean }>();
    let offered: ReturnType<PageNotice['offered']> | undefined;
    for (const r of rows) {
      let note = had.get(r.id);
      if (note?.r !== r) {
        const missed = this.outdatedAsLooked(r);
        note = { r, missed: (offered ??= this.offered())(r, missed) ? missed : null, untagged: this.untaggedRow(r) };
      }
      notes.set(r.id, note);
    }
    this.pageNotes = { of, notes };
    const left = [...notes.values()].flatMap(({ r, missed }) => (missed && !queued.has(r.id) ? [{ r, missed }] : []));
    const untagged = [...notes.values()].filter(({ r, untagged }) => untagged && !queued.has(r.id)).length;
    if (!left.length && !untagged && !run) return null;
    // what sharing them again brings, and to how many of them
    const changes = ([...PAGE_CHANGES.map((c) => c.id), THEME_CHANGED] as OutdatedBy[]).flatMap((id) => {
      const pages = left.filter(({ missed }) => missed.includes(id)).length;
      return pages ? [{ id, pages }] : [];
    });
    const title = (id: string) => rows.find((r) => r.id === id)?.title ?? '';
    const first = run?.queue[0] ? rows.find((r) => r.id === run.queue[0]) : undefined;
    const current = first?.share && fromJson(first.share).state === 'publishing' ? first.title : undefined;
    return {
      outdated: left.length,
      ...(untagged ? { untagged } : {}),
      ...(changes.length ? { changes } : {}),
      ...(run
        ? {
            run: {
              total: run.total,
              done: run.done,
              failed: run.failed.map((id) => ({ id, title: title(id) })),
              left: run.queue.length,
              ...(current ? { current } : {}),
              ...(run.stopped ? { stopped: true } : {}),
              ...(run.tags ? { tags: true } : {}),
            },
          }
        : {}),
    };
  }
}
