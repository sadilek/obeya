// A card's shared page as the board knows it: the demos it shows and the card's demos it may show,
// its tags, and what it lacks of what changed since it was published.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type KnownChange, missedChanges, type OutdatedBy, PAGE_CHANGES, THEME_CHANGED } from '../core/page-changes';
import { pageTags } from '../core/page-tags';
import type { DemoKind, PageTags } from '../core/types';
import type { CardRow, Store } from './db';
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
export const demoFile = (d: { dir: string; kind: DemoKind }) => join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4');

/** The file that shows a demo is there. */
export const demoThere = (d: { dir: string; kind: DemoKind }) => existsSync(demoFile(d));

/** How often Obeya looks again whether the demos of outdated pages are still on disk (`Board.lookAtDemos`): the owner deletes them outside it. */
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

export const RESHARE_SETTING = 'reshare';
/** The newest page change when the owner put the notice of outdated pages away: it shows again for pages a newer one leaves outdated. */
export const RESHARE_DISMISSED = 'reshare_dismissed';
/**
 * The pages a theme left outdated when the owner put the notice away, by card: the theme each was
 * published with and the one its repository had then (hashes, null for none). Such a page shows
 * again once either differs: its repository's theme changed anew, or it was shared again since.
 */
export const RESHARE_DISMISSED_THEMES = 'reshare_dismissed_themes';

/** A page's theme and its repository's, as `RESHARE_DISMISSED_THEMES` keeps them. */
export type ThemePair = [published: string | null, now: string | null];

/** The current theme's hash of a card's repository (theme.ts): null where it has none, undefined while that is not known (the repository does not run). */
export type ThemeNow = (r: CardRow) => string | null | undefined;

/** Whether the theme of a stored page's repository (`now`, see `ThemeNow`) differs from the one it was published with; not while it is not at rest. */
export const themeChanged = (s: StoredShare, now: string | null | undefined) => !!s.url && !s.state && now !== undefined && (s.theme ?? null) !== now;

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
export function convertSingleDemoShares(store: Store, canvasId: string) {
  for (const r of store.shared(canvasId)) {
    const { dir, shown, ...rest } = JSON.parse(r.share!) as StoredShare & { dir?: string; shown?: SharedDemo['shown'] };
    if (rest.demos || !dir || !shown) continue;
    const demo = cardDemos(r).findLast((d) => d.dir === dir);
    const one: SharedDemo = { ...(demo?.handover !== undefined ? { handover: demo.handover } : {}), ...(demo?.at ? { at: demo.at } : {}), dir, shown };
    store.update(r.id, { share: toJson({ ...rest, demos: [one] }) });
  }
}
