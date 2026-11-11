// The canvas of one repository: stored cards merged with what the plan docs say.
//
// Plan docs are read, never written. Their projects and workstreams get a stored row the first
// time they appear, so the owner's placement survives; title, text and state always come from the
// doc. Each read keeps the doc's last state on its project: when the doc goes, the project goes
// into the archive with it, and comes back to its place when the doc returns. A workstream that
// leaves its doc stays stored but is not shown.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { arrangeWorkstreams, type Bounds, boundsOf, CARD_SIZE, freeSpotNear, GAP, type Place, PROJECT_HEAD, placeProjects, planDirNoteBox, placeWorkstreams, projectSize, sizeOf, unionBounds } from '../core/layout';
import { cardNumbersIn, cardTag } from '../core/card-number';
import type { Language } from '../core/locale';
import { MESSAGES, type Messages, snoozeTerm } from '../core/messages';
import { type KnownChange, missedChanges, type OutdatedBy, PAGE_CHANGES, pagesVersion, THEME_CHANGED } from '../core/page-changes';
import { pageTags, untagged } from '../core/page-tags';
import { allTicked, type OtherDoc, type PlanDoc, parsePlanDoc, withoutReference, type Workstream, workstreamAliases } from '../core/plan-doc';
import { type ArchiveLabel, archiveLabel, fold, inTitle, searchText, searchWords } from '../core/search';
import {
  type AnswerFile,
  type ArchivePage,
  type CanvasInfo,
  type CanvasSnapshot,
  type CardEvent,
  type CardAgent,
  type CardPatch,
  type ClonePool,
  type Decision,
  type Demo,
  type DemoKind,
  type PageTags,
  type EarlierDemo,
  type ErrorCode,
  type Group,
  type Snooze,
  type Woke,
  type Idea,
  type Item,
  type NewCard,
  type NewRepo,
  type TalkMoved,
  type PreferenceState,
  type ProposedSetting,
  type SettingProposal,
  type SettingProposalState,
  type PullRequest,
  type ProjectHistory,
  type Proposal,
  type Superseded,
  type CardState,
  type Revising,
  type Question,
  type PlanDir,
  type Queue,
  type Reshare,
  type TalkQuote,
  type TalkAfter,
  type TalkRef,
  type Thread,
  isTalkRef,
  STATES,
  archivedWithDone,
  finished,
  formatQuestion,
  needsYou,
  plannedToStart,
  type Notice,
  type WorkerTurn,
  AGENT_EFFORTS,
  type AgentEffort,
  type Harness,
  HARNESSES,
  modelFits,
  cardAgentOf,
  storedModel,
} from '../core/types';
import type { ArchiveCursor, CardRow, DecisionRow, Friction, FrictionNote, GroupRow, HeldTalk, Mark, NewEvent, NewRow, RowUpdate, Store, TalkWaitRow } from './db';
import { fromJson, type DemoRef, type PrState, type SharedDemo, type Shipped, type StoredDemo, type StoredDeps, type StoredIdea, type StoredNewRepo, type StoredShare, type StoredThread, toJson } from './row';
import type { Images } from './images';
import { sessionHarness } from './runtime';
import { branchName, CARD_BRANCH } from './branches';
import { clip, messageOf, oneLine } from '../core/text';
import type { Wish } from '../core/wish';

/** A card's place in the queue where it waits behind other cards; none otherwise. */
const waitOf = (r: Pick<CardRow, 'queue'>) => {
  const q = fromJson(r.queue);
  return q && 'behind' in q ? q : null;
};

/** The workstreams of a plan doc as what builds on what is read from them: a reading holds while this is the same. */
export const depsSig = (doc: PlanDoc) =>
  createHash('sha256')
    .update(JSON.stringify(doc.workstreams.map((w) => [w.key, w.title, w.body])))
    .digest('hex')
    .slice(0, 16);

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

/** A demo as the UI gets it: without its directories, and saying whether a video has a poster. */
const shownDemo = ({ dir, kept: _, ...d }: StoredDemo): Demo => (d.kind !== 'html' && !existsSync(join(dir, 'poster.jpg')) ? { ...d, noPoster: true } : d);

/**
 * The card's earlier demos the owner can still go back to: their files are on disk (demos are
 * deleted to free space) and no later demo was rendered into the same directory over them, as it
 * was for one from before Obeya kept copies (`StoredDemo`).
 */
function earlierDemos(r: CardRow): EarlierDemo[] {
  const all = fromJson(r.demos) ?? [];
  const later = (i: number) => [...all.slice(i + 1).map((d) => d.dir), ...(r.demo ? [fromJson(r.demo).dir] : [])];
  return all.flatMap((d, n) => (!later(n).includes(d.dir) && existsSync(join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4')) ? [{ ...shownDemo(d), n }] : []));
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
 * `earlierDemos` says), then the one on the card.
 */
export function cardDemos(r: CardRow): StoredDemo[] {
  const all = fromJson(r.demos) ?? [];
  const latest = fromJson(r.demo);
  const later = (i: number) => [...all.slice(i + 1).map((d) => d.dir), ...(latest ? [latest.dir] : [])];
  // drafts a question brought are not the work's result: no page shows them
  return [...all.filter((d, i) => !later(i).includes(d.dir) && demoThere(d)), ...(latest ? [latest] : [])].filter((d) => !d.asked);
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

/** The most characters of a card's title: the owner's are refused beyond it, agents' cut. */
export const TITLE_MAX = 200;
/** The most characters of a card's text (and of the owner's words a proposal is revised by). */
export const BODY_MAX = 20_000;
/** The most characters of a note beside a card or rule: a proposal's reason, a setting's basis, a rule's quote. */
export const NOTE_MAX = 2000;

/** States a worker or the owner's decision is still part of. */
export const ACTIVE: string[] = ['working', 'waiting', 'inPr', 'approved'];

/** Exchanges with the Coordinator its sheet shows. */
const SHEET_TALK = 30;

/** The setting that names the card collecting accepted rules for a repository's CLAUDE.md, per repository. */
const CLAUDE_MD_SETTING = 'claude_md_card:';

/** The setting that names the card filling in a repository's settings, proposed by Obeya or made in the Configuration dialog, per repository: Obeya proposes it once. */
const SETUP_CARD_SETTING = 'setup_card:';

/** The setting that names the card Obeya proposed to give a repository's shared pages a theme, per repository: Obeya proposes it once. */
const THEME_CARD_SETTING = 'theme_card:';

/** How long an empty card of the owner's (no title, text or screenshots) may exist before Obeya drops it on start. */
const UNTITLED_GRACE_MS = 10 * 60_000;

/** A request the server refuses: a stable code for the UI's text, and an English detail. */
export class BadRequest extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A card a number names (`Board.numbered`): its row; as the UI sees it where it is this canvas's; the name of its canvas where that is another. */
export interface Numbered {
  row: CardRow;
  item?: Item;
  canvasName?: string;
}

/** What the owner can reply to: the messages of a conversation. */
const QUOTABLE: CardEvent['kind'][] = ['say', 'closing', 'question', 'answer', 'hint', 'review', 'talk'];

/**
 * What an agent reads above the owner's words that reply to a message: which one, by its start
 * where the agent has the whole in its session (its own words, the owner's words to it), else whole
 * (Obeya's words in the card's conversation, an idea's agent's to a card's worker; the Coordinator,
 * which reads each command afresh, gets them all whole).
 */
export function replyNote(quoted: CardEvent | undefined, to: 'worker' | 'explorer' | 'coordinator'): string {
  if (!quoted) return '';
  const own = quoted.author === to;
  const what = quoted.kind === 'question' ? 'question' : quoted.kind === 'review' ? 'handover' : 'message';
  const whose = own
    ? `your ${what}`
    : quoted.author === 'owner'
      ? `their own earlier ${what}`
      : quoted.author === 'explorer' || quoted.author === 'worker'
        ? `the ${quoted.author === 'explorer' ? "idea's agent's" : "card's worker's"} ${what}`
        : `Obeya's ${what} in the card's conversation`;
  const heard = own || (quoted.author === 'owner' && quoted.kind !== 'say');
  const text = oneLine(quoted.text);
  return `[In reply to ${whose}: “${excerpt(text, heard && to !== 'coordinator' ? 160 : 2000)}”]\n\n`;
}

/** The start of a text, cut at a word, to point at it. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()} …`;
}

/**
 * What the canvas's plan directories hold: the docs that are projects (a bare path for the home
 * repository, `<repo>:<path>` for another) and, per repository, the others with their reason.
 */
export interface PlanRead {
  docs: PlanDoc[];
  dirs: { repo: string; dir: string; others: OtherDoc[] }[];
}

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

export class Board {
  private listeners = new Set<() => void>();
  /** Whether the listeners are to hear of the changes made since they last did (`changed`). */
  private telling = false;
  private docs: PlanDoc[] | null = null;
  /** The repositories on the canvas when `docs` were read. */
  private docsOf = '';
  private dirs: PlanRead['dirs'] = [];
  /** The docs whose projects were on the canvas at the last snapshot, to see one end or come back. */
  private open: string | null = null;
  private cache: CanvasSnapshot | null = null;
  /** The snapshot's `items`, also while the rest of it is not built (`items`); gone with `cache`. */
  private itemsCache: Item[] | null = null;
  /** The canvas's rows `items` made its cards of, for the rest of the snapshot of the same change; gone with `itemsCache`. */
  private rows: CardRow[] | null = null;
  /**
   * The archive's projects and cards whose landed work added plan docs, as last read, with the
   * archive's revision then: read again only once that moves, not with every change.
   */
  private archivedPlans: { rev: string; rows: CardRow[] } | null = null;
  /** What `toItems` made of each card's row, for as long as the row stays the same; gone with any change but a write to one card (`work`). */
  private worked: Worked = new Map();
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
   * What a search through the archive reads of each archived card (`archiveSearch`), kept while the
   * owner searches and up to date with the database's log of the archive's writes (`upTo`); null
   * until the first search, and again a while after the last.
   */
  private archiveIndex: ArchiveIndex | null = null;
  /** The archive being read for the search, a slice at a time. */
  private indexing: Promise<ArchiveIndex> | null = null;
  /** When the search's reading of the archive goes, unless the owner searches again before. */
  private indexDrop: ReturnType<typeof setTimeout> | null = null;
  /** The canvas's prototypes, and those `withPrototypes` handed out so far; gone with `cache`. */
  private prototypeItems: Prototypes | null = null;
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
  private eventListeners = new Set<(e: CardEvent) => void>();
  private goneListeners = new Set<(cardId: string, id: number) => void>();
  private noticeListeners = new Set<(n: Notice) => void>();

  constructor(
    private store: Store,
    readonly canvas: CanvasInfo,
    private readDocs: () => PlanRead,
    /** The owner's screenshots, which a card's images must be among. */
    private images?: Pick<Images, 'resolve'>,
    /**
     * Whether the read tree of the repository holds the commit, as known now: without the server
     * waiting for git, which reads the plan docs again (`docsChanged`) once it does. Without it, every
     * commit counts as held.
     */
    private holds?: (repo: string, commit: string) => boolean,
    /** The language of Obeya's interface now (`ownerLanguage`): what the server writes itself; the tests speak German. */
    readonly language: () => Language = () => 'de',
    /**
     * The owner's conversation language now (`conversationLanguage`): what agents write the owner
     * in until the owner's words say otherwise; the interface's when left out.
     */
    conversation?: () => Language,
  ) {
    this.conversation = conversation ?? language;
    store.ensureCanvas(canvas.id, canvas.name);
    // a new card whose page closed before anything was written in it was never wanted
    store.sweepUntitled(canvas.id, new Date(Date.now() - UNTITLED_GRACE_MS).toISOString());
    convertSingleDemoShares(store, canvas.id);
    // the search reads the whole archive anew the first time: what its log held before is read with it
    store.dropArchiveChanges(canvas.id, store.archiveLog());
  }

  readonly conversation: () => Language;

  /** What Obeya says to the owner, in the interface language. */
  get t(): Messages {
    return MESSAGES[this.language()];
  }

  /** The canvas's home repository: bare plan references and cards without a repository are its. */
  get home(): string {
    return this.canvas.repos[0]!.id;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: CardEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** A line taken out of a card's log (`unlog`). */
  onEventGone(fn: (cardId: string, id: number) => void): () => void {
    this.goneListeners.add(fn);
    return () => this.goneListeners.delete(fn);
  }

  /** Whoever shows the canvas (the server, to its pages) shows what Obeya tells the owner above the microphone. */
  onNotice(fn: (n: Notice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  /** A line for the owner above the microphone, wherever they are: an answer looked up, a confirmation that came without a command. */
  notify(n: Notice) {
    for (const fn of this.noticeListeners) fn(n);
  }

  /** Owner-drawn dependencies, directed from the prerequisite to the waiting card. */
  manualDependencies(): [string, string][] {
    try { return JSON.parse(this.setting('manual_dependencies') || '[]'); } catch { return []; }
  }

  connect(from: string, to: string, remove = false) {
    const items = this.snapshot().items;
    if (!items.some((i) => i.id === from) || !items.some((i) => i.id === to) || from === to)
      throw new BadRequest('unknownCard', 'invalid dependency');
    if (!remove && items.some((i) => (i.id === from || i.id === to) && !connectable(i)))
      throw new BadRequest('planDependency', 'project dependencies are decided from the plan');
    const edges = this.manualDependencies().filter(([a, b]) => a !== from || b !== to);
    if (!remove) {
      // A cycle would leave the cards waiting for each other forever.
      if (closesCycle(from, to, edges, items)) throw new BadRequest('dependencyCycle', 'dependency cycle');
      edges.push([from, to]);
    }
    this.setManualDependencies(edges);
  }

  /** Arrows of cards that no longer exist go; those of a deleted or archived card stay, for its return. */
  private setManualDependencies(edges: [string, string][]) {
    this.setSetting('manual_dependencies', JSON.stringify(edges.filter(([a, b]) => this.store.card(a) && this.store.card(b))));
    this.changed();
  }

  /**
   * A card changed. The listeners hear of it once the code that made the change is through, once
   * for all it changed: each of them may ask for the snapshot, which a change builds anew, and a
   * landing or a card moving on makes dozens of changes in a row.
   */
  changed() {
    // the demos' files may have come or gone with it
    this.worked.clear();
    this.changedRows();
  }

  /**
   * Cards' rows changed, and nothing else: what the other cards' rows make stays (their demos' files
   * are looked at again with the next change of anything else). A landing writes to its card dozens
   * of times, each read back at once, on a canvas of hundreds of cards with demos.
   */
  private changedRows() {
    this.cache = null;
    this.itemsCache = null;
    this.rows = null;
    this.prototypeItems = null;
    this.tell();
  }

  /** The listeners hear of the changes once the code that made them is through. */
  private tell() {
    if (this.telling) return;
    this.telling = true;
    queueMicrotask(() => {
      this.telling = false;
      for (const fn of this.listeners) {
        try {
          fn();
        } catch (e) {
          console.error(`Obeya: reacting to a change on the canvas ${this.canvas.id} failed: ${messageOf(e)}`);
        }
      }
    });
  }

  /** Plan docs changed on disk: read them again. */
  docsChanged() {
    this.docs = null;
    this.changed();
  }

  /**
   * The repository's read tree moved to `commit` after a fetch: pull requests merged before it,
   * whose merge commit GitHub did not say, count as landed with it. Then the plan docs are read again.
   */
  readTreeMoved(repo: string, commit: string) {
    for (const r of this.store.cards(this.canvas.id)) {
      const s = fromJson(r.shipped);
      if (!commit || !s?.fetch || (r.repo ?? (r.plan_ref ? repoOfRef(r.plan_ref, this.home) : this.home)) !== repo) continue;
      const { fetch: _, ...rest } = s;
      this.store.update(r.id, { shipped: toJson({ ...rest, commit }) });
    }
    // the docs' history is read anew
    this.readTreeAt++;
    this.docsChanged();
  }

  /**
   * The plan doc decides a workstream's state. Stored `live` means its work landed; once the
   * read tree holds what landed and the doc still leaves the workstream open, only a part of it is
   * done: the card is planned again, to be started for the rest. Its log, PR and handover stay.
   */
  private reopen(docs: PlanDoc[]) {
    const byFile = new Map(docs.map((d) => [d.file, d]));
    for (const r of this.store.cards(this.canvas.id)) {
      // a worker still finishing after the landing keeps its card until it is done (workDone)
      if (r.state !== 'live' || !r.plan_ref?.includes('#') || r.landed) continue;
      const hash = r.plan_ref.indexOf('#');
      const w = byFile.get(r.plan_ref.slice(0, hash))?.workstreams.find((x) => x.key === r.plan_ref!.slice(hash + 1));
      if (!w || w.done) continue;
      const s = fromJson(r.shipped) ?? {};
      if (s.fetch || (s.commit && this.holds && !this.holds(repoOfRef(r.plan_ref, this.home), s.commit))) continue;
      const pr = fromJson(r.pr);
      const shipped: Shipped = { ...s, ...(!s.pr && pr?.url && pr.number ? { pr: { url: pr.url, number: pr.number } } : {}) };
      // a new run starts on a fresh branch: the old one is merged, perhaps squashed
      this.store.update(r.id, { state: 'planned', need: null, pr: null, branch: null, shipped: toJson(shipped) });
      this.log(r.id, 'state', 'obeya', this.t.idea.partLanded);
    }
  }

  /**
   * Appends a line to the card's log. `images`: the owner's screenshots, by file or id (the log keeps
   * the id); `replyTo`: the message the owner's words reply to (`quoted`); `spot`: the place in the
   * demo video they are about; `picks`: the options an answer picked; `answer`: a looked-up answer's
   * exchange and files; `at` keeps a message's time when a thread is copied onto its Question card;
   * `wish`: on a reply of Obeya's, what a draft for its makers starts from; `forwarded`: Obeya's
   * reply to what the card's agent passed on; `token`: an error of a session signed in with a token.
   */
  log(
    cardId: string,
    kind: CardEvent['kind'],
    author: CardEvent['author'],
    text: string,
    extra: Omit<NewEvent, 'cardId' | 'kind' | 'author' | 'text'> = {},
  ): CardEvent {
    const e = this.store.addEvent({ cardId, kind, author, text, ...extra, ...(extra.images ? { images: extra.images.map((f) => basename(f)) } : {}) });
    for (const fn of this.eventListeners) fn(e);
    // a line other than tool activity is a change at the card, which the search lists by (`changedAt`)
    if (kind !== 'activity') this.stamp(cardId, e.at);
    return e;
  }

  /**
   * A line came into the card's log at `at`: the cards as built hold it as their last change. The
   * pages have the line already (`onEvent`) and order their search by it, so the canvas is neither
   * built afresh nor sent again; a page that connects later gets it with the snapshot.
   */
  private stamp(cardId: string, at: string) {
    const items = this.itemsCache;
    const k = items ? items.findIndex((i) => i.id === cardId) : -1;
    const i = items?.[k];
    if (i && (i.changedAt ?? '') < at) items![k] = { ...i, changedAt: at };
  }

  /** Takes a line out of the card's log: a comment the owner deleted before anyone read it. */
  unlog(cardId: string, id: number) {
    this.store.deleteEvent(cardId, id);
    for (const fn of this.goneListeners) fn(cardId, id);
  }

  /**
   * The card's agent read the owner's words of these lines now: in the conversation they move to
   * where it read them (`CardEvent.readAfter`), and can no longer be taken back.
   */
  readNow(cardId: string, ids: number[]) {
    if (!ids.length) return;
    for (const e of this.store.readEvents(cardId, ids)) for (const fn of this.eventListeners) fn(e);
  }

  /**
   * The owner takes back words the agent has not read: they leave the conversation, and so does
   * what they said aloud for them, which stood as the same words just before.
   */
  withdraw(cardId: string, id: number) {
    const events = this.store.events(cardId);
    const at = events.findIndex((e) => e.id === id);
    const said = events[at];
    if (!said) return;
    const spoken = events.slice(0, at).findLast((e) => e.author === 'owner');
    if (spoken?.kind === 'say' && spoken.text.trim() === said.text.trim()) this.unlog(cardId, spoken.id);
    this.unlog(cardId, id);
  }

  /** Whether the line is the owner's words the card's agent has not read yet. */
  unread(cardId: string, id: number): boolean {
    return !!this.store.event(cardId, id)?.unread;
  }

  /** The message of the sheet `ref` names, if it is one the owner can reply to there. */
  quotedTalk(ref: unknown): TalkQuote | undefined {
    return isTalkRef(ref) ? this.store.sheetQuote(this.canvas.id, ref) : undefined;
  }

  /** The message of the card's conversation the owner's words reply to, if `id` is one: what someone said, not a step or a state change. */
  quoted(cardId: string, id: unknown): CardEvent | undefined {
    if (typeof id !== 'number' || !Number.isInteger(id)) return;
    const e = this.store.event(cardId, id);
    return e && QUOTABLE.includes(e.kind) ? e : undefined;
  }

  /** The latest `limit` messages of the card's conversation, oldest first. */
  talkOf(cardId: string, limit: number): CardEvent[] {
    this.own(cardId);
    return this.store.talkOf(cardId, limit);
  }

  events(cardId: string): CardEvent[] {
    this.own(cardId);
    return this.store.events(cardId);
  }

  row(id: string): CardRow {
    return this.own(id);
  }

  /** The directory and kind of the card's latest demo, or of the `n`th of its earlier ones; it stays with the card after approval. */
  demoFiles(id: string, n?: number): { dir: string; kind: DemoKind } | null {
    const r = this.own(id);
    const stored = n === undefined ? fromJson(r.demo) : (fromJson(r.demos) ?? [])[n];
    if (!stored) return null;
    const { dir, kind } = stored;
    return { dir, kind };
  }

  /** The plan doc of a project, as written, for the owner to read. */
  planDoc(id: string): { file: string; markdown: string } {
    const row = this.own(id);
    const ref = row.plan_ref;
    // a doc gone from a project whose work is done, as it last stood
    const doc = ref && !ref.includes('#') ? ((this.docs ??= this.read()).find((d) => d.file === ref) ?? fromJson(row.plan) ?? undefined) : undefined;
    if (!doc) throw new BadRequest('invalid', 'not a project with a plan doc');
    return { file: doc.file, markdown: doc.markdown };
  }

  /**
   * The card a number names (`K42`), wherever it is: this canvas's as the UI sees it (on the canvas
   * or archived), another canvas's or a deleted one by its row alone; none for a number no card has.
   */
  numbered(n: number): Numbered | undefined {
    const row = this.store.cardByNumber(n);
    if (!row) return undefined;
    const item = row.canvas_id === this.canvas.id && !row.deleted_at ? this.card(row.id) : undefined;
    return { row, ...(item ? { item } : {}), ...(row.canvas_id !== this.canvas.id ? { canvasName: this.store.canvasName(row.canvas_id) ?? row.canvas_id } : {}) };
  }

  /** The card's number as its tag (`K42`), wherever the card is; '' for none. */
  tagOf(id: string): string {
    const row = this.store.card(id);
    return row ? cardTag(row.number) : '';
  }

  /**
   * Which cards the card numbers in the owner's words name, for an agent reading them: a line for
   * each that names one, '' where they name none. `self`: the card the agent works on.
   */
  numbersNote(text: string, self?: string): string {
    const named = cardNumbersIn(text).flatMap((n) => {
      const found = this.numbered(n);
      if (!found) return [];
      const { row, item, canvasName } = found;
      const where = row.id === self ? ' (your own card)' : row.deleted_at ? ' (deleted)' : canvasName ? ` (on the canvas “${canvasName}”)` : '';
      const state = item ? `, ${item.archivedAt ? 'archived' : item.state}` : '';
      return [`${cardTag(n)} is the card “${item?.title ?? row.title ?? ''}”${where}${state}.`];
    });
    return named.length ? `\n\n(Card numbers in these words: ${named.join(' ')})` : '';
  }

  /** The card as the UI sees it. */
  item(id: string): Item | undefined {
    return this.items().find((i) => i.id === id);
  }

  /** Of these cards, those deleted, archived or not on this canvas: what is kept by card for them may go. */
  gone(ids: string[]): string[] {
    const open = this.store.openIds(this.canvas.id, ids);
    return ids.filter((id) => !open.has(id));
  }

  /** Changes a card's work fields (state, session, workspace …); for the agents, not the owner. */
  work(id: string, fields: RowUpdate) {
    this.own(id);
    this.store.update(id, fields);
    this.changedRows();
  }

  /**
   * The cards of the canvas, archived ones too, that were ever shared or are about to be: read once,
   * then kept up to date by reading again those the database logged a write of (`Store.sharedChanges`).
   * A row stays the same object while it is not written, so what is made of it can be kept with it.
   */
  sharedRows(): CardRow[] {
    if (!this.shared) {
      const upTo = this.store.sharedLog();
      this.shared = { upTo, rows: new Map(this.store.shared(this.canvas.id).map((r) => [r.id, r])) };
      this.store.dropSharedChanges(this.canvas.id, upTo);
    } else {
      const { upTo, ids } = this.store.sharedChanges(this.canvas.id, this.shared.upTo);
      if (ids.length) {
        const rows = new Map(this.store.shared(this.canvas.id, ids).map((r) => [r.id, r]));
        for (const id of ids) {
          const r = rows.get(id);
          if (r) this.shared.rows.set(id, r);
          else this.shared.rows.delete(id);
        }
        this.store.dropSharedChanges(this.canvas.id, upTo);
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

  /**
   * Of these rows, those whose card the UI shows (`cards`), each with its repository and title: what
   * a pass over every shared page needs of them, found without building the archived ones' cards.
   */
  shownCards(rows: CardRow[]): Map<string, Pick<Item, 'id' | 'repo' | 'title'>> {
    const shown = new Map(this.items().map((i) => [i.id, i]));
    // reading the docs for the items may have moved a shared card to another workstream since its row was read
    const now = new Map(this.sharedRows().map((r) => [r.id, r]));
    const out = new Map<string, Pick<Item, 'id' | 'repo' | 'title'>>();
    const mine = (r: CardRow | null): r is CardRow => !!r && r.canvas_id === this.canvas.id && !r.deleted_at;
    const parents = new Map<string, CardRow | null>();
    const parent = (id: string) => {
      if (!parents.has(id)) parents.set(id, this.store.card(id));
      return parents.get(id)!;
    };
    // an archived project shows its doc as it last stood
    const docOf = (r: CardRow) => {
      const doc = fromJson(r.plan);
      return doc?.file === r.plan_ref ? doc : null;
    };
    for (const read of rows) {
      const given = now.get(read.id) ?? read;
      if (!mine(given)) continue;
      const item = shown.get(given.id);
      if (item) {
        out.set(given.id, { id: item.id, repo: item.repo, title: item.title });
        continue;
      }
      // as `cards` finds it in the archive: a card archived itself, or a workstream with its project
      const r = given.archived_at || (given.parent_id && parent(given.parent_id)?.archived_at) ? given : this.store.card(given.id);
      if (!mine(r)) continue;
      if (r.archived_at) {
        const doc = r.plan_ref && !r.plan_ref.includes('#') ? docOf(r) : null;
        if (!r.plan_ref) out.set(r.id, { id: r.id, repo: r.repo ?? this.home, title: r.title ?? '' });
        else if (doc) out.set(r.id, { id: r.id, repo: repoOfRef(doc.file, this.home), title: doc.title });
        continue;
      }
      const project = r.parent_id ? parent(r.parent_id) : null;
      if (!r.plan_ref || !mine(project) || !project.archived_at) continue;
      const doc = docOf(project);
      const w = doc && r.plan_ref.startsWith(`${doc.file}#`) ? doc.workstreams.find((x) => x.key === r.plan_ref!.slice(doc.file.length + 1)) : undefined;
      if (w) out.set(r.id, { id: r.id, repo: repoOfRef(r.plan_ref, this.home), title: w.title });
    }
    return out;
  }

  /**
   * Where a card nobody placed goes: with `place` (where the owner pointed, or the middle of what
   * they have in view), the free spot nearest the card centred on it, in view if there is room there; else a column
   * right of everything, below what is already there.
   */
  freeSpot(place?: Place): { x: number; y: number } {
    const items = this.items();
    if (place) {
      const [w, h] = CARD_SIZE.task;
      const at = this.nearFree(items, { x: place.x - w / 2, y: place.y - h / 2 }, place.view);
      return { x: Math.round(at.x), y: Math.round(at.y) };
    }
    const top = items.filter((i) => !i.parent);
    const all = unionBounds(top.map((i) => boundsOf(i, items)));
    if (!all) return { x: 0, y: 0 };
    const column = top.filter((i) => i.kind !== 'project' && i.x >= all.x + all.w - 400);
    const x = column.length ? Math.min(...column.map((i) => i.x)) : all.x + all.w + 80;
    const y = column.length ? Math.max(...column.map((i) => boundsOf(i, items).y + boundsOf(i, items).h)) + 30 : all.y;
    return { x, y };
  }

  /**
   * Where a follow-up of a card goes: below it, each further one beside the one before; or, when
   * something is in the way there (the card's own project, for a workstream), the nearest free spot.
   */
  private followUpSpot(fromId: string): { x: number; y: number } {
    const items = this.items();
    const from = items.find((i) => i.id === fromId);
    // an archived card is not on the canvas: its follow-ups go where there is room
    if (!from) return this.freeSpot();
    const earlier = items.filter((i) => i.from === fromId && i.state !== 'proposal' && !i.prototypeOf).length;
    return this.nearFree(items, below(boundsOf(from, items), earlier));
  }

  /** The free spot nearest `want` for a new card, clear of every project and card on the canvas; in `view` if there is room there. */
  private nearFree(items: Item[], want: { x: number; y: number }, view?: Bounds): { x: number; y: number } {
    return freeSpotNear(
      want,
      CARD_SIZE.task,
      items.filter((i) => !i.parent).map((i) => boundsOf(i, items)),
      view,
    );
  }

  /** The worker's last summary of a card; it stays with the card until work on it starts again. */
  summary(id: string): string | undefined {
    const r = this.own(id);
    return fromJson(r.detail)?.summary;
  }

  /**
   * An agent's proposal from card `fromId`: in the repository it names (`p.repo`), else in that card's,
   * placed below that card, or at the nearest free spot; its text for the agent that takes it on, and
   * apart from it why and what the owner has to decide.
   */
  propose(fromId: string, p: { title: string; task: string; reason?: string; idea?: boolean; questions?: Question[]; startAt?: string; repo?: string }): Item {
    if (p.repo !== undefined) this.checkRepo(p.repo);
    const items = this.items();
    const from = items.find((i) => i.id === fromId);
    const at = from ? this.nearFree(items, below(boundsOf(from, items))) : this.freeSpot();
    const proposal = proposalOf(p);
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: 'proposal',
        title: p.title.slice(0, TITLE_MAX),
        body: p.task.slice(0, BODY_MAX),
        ...at,
        from_id: fromId,
        repo: this.repoColumn(p.repo ?? from?.repo),
        proposal: toJson(proposal),
        group_id: from?.group ?? null,
      },
    ]);
    // its questions stand in its conversation as the proposing agent asked them, and stay there once settled
    for (const q of proposal.questions) this.log(row!.id, 'question', 'worker', formatQuestion(q, this.language()));
    this.changed();
    return this.itemOf(row!);
  }

  /**
   * An agent withdraws one of its own proposals from card `fromId` (the latest by that title), or
   * marks it replaced (`s.by`): still open, it goes at once; already accepted and not finished, it
   * carries the mark until the owner removes the card or keeps it. Says what became of it.
   */
  retract(fromId: string, title: string, s: Superseded): Retracted {
    // the proposal that replaces it is not among those it may replace
    const mine = this.store.proposalsFrom(this.canvas.id, fromId).filter((r) => r.id !== s.by);
    const row = mine.findLast((r) => titleKey(r.title ?? '') === titleKey(title));
    if (!row) return { kind: 'unknown', mine: mine.map((r) => ({ title: r.title ?? '', state: r.state ?? 'planned', gone: !!r.deleted_at })) };
    const proposal = fromJson(row.proposal)!;
    const was = { title: row.title ?? '', state: row.state ?? 'planned' };
    if (row.deleted_at) return { kind: proposal.superseded ? 'already' : was.state === 'proposal' ? 'dismissed' : 'removed', ...was };
    if (row.archived_at || finished(was.state)) return { kind: 'finished', ...was };
    // a proposal still open goes without the owner, as if never made
    if (was.state === 'proposal') this.setProposal(row.id, { ...proposal, superseded: s }, { deleted_at: new Date().toISOString() });
    else {
      this.setProposal(row.id, { ...proposal, superseded: s });
      this.log(row.id, 'state', 'coordinator', this.t.worker.superseded(s.title, s.why));
    }
    return { kind: was.state === 'proposal' ? 'gone' : 'marked', ...was };
  }

  /** The owner keeps a card whose agent withdrew or replaced it: the mark goes. */
  keep(id: string) {
    const row = this.own(id);
    const { superseded, ...proposal } = fromJson(row.proposal) ?? { questions: [] };
    if (!superseded) throw new BadRequest('notSuperseded', 'its agent has not withdrawn or replaced this card');
    this.setProposal(id, proposal);
  }

  /** The open proposal `id` and what it proposes; a card that is no proposal is refused. */
  private proposalOn(id: string): { row: CardRow; proposal: Proposal } {
    const row = this.own(id);
    if (row.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    return { row, proposal: fromJson(row.proposal) ?? { questions: [] } };
  }

  /** Stores what card `id` proposes, with the other changes to its row that go with it. */
  private setProposal(id: string, proposal: Proposal, fields: RowUpdate = {}) {
    this.store.update(id, { ...fields, proposal: toJson(proposal) });
    this.changed();
  }

  /**
   * A card the work retrospective proposes for a repository: it waits as a proposal like an agent's,
   * in a free spot, with what it rests on (`basis`).
   */
  proposeRetro(repo: string, p: { title: string; body: string; basis: string }): Item {
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: 'proposal',
        title: p.title.slice(0, TITLE_MAX),
        body: p.body.slice(0, BODY_MAX),
        ...this.freeSpot(),
        repo: this.repoColumn(repo),
        retro: p.basis.slice(0, NOTE_MAX),
        proposal: toJson(proposalOf({})),
      },
    ]);
    this.changed();
    return this.itemOf(row!);
  }

  /**
   * The card that fills in a repository's settings for everyone while it is open: the one made for
   * it (`setupCard`), else one of its title made before Obeya noted which it was.
   */
  openSetupCard(repo: string, name: string): Item | undefined {
    const id = this.setting(`${SETUP_CARD_SETTING}${repo}`);
    const title = this.t.adapterSetup.title(name);
    return this.items().find((i) => i.kind === 'task' && i.repo === repo && (i.id === id || i.title === title) && !finished(i.state) && !i.archivedAt);
  }

  /**
   * Makes the card that fills in a repository's settings for everyone, right of everything on the
   * canvas, at the top: the owner's, or Obeya's proposal (`propose`) with why. Either way Obeya
   * proposes it no more.
   */
  setupCard(repo: string, name: string, propose = false): Item {
    return this.repoCard(repo, SETUP_CARD_SETTING, this.t.adapterSetup, name, propose);
  }

  /**
   * A card of Obeya's for setting up a repository (`setupCard`, `proposeTheme`), right of everything
   * on the canvas, at the top: the owner's, or Obeya's proposal (`propose`) with why. The setting
   * `key` names it for the repository from then on.
   */
  private repoCard(repo: string, key: string, t: { title: (name: string) => string; body: string; reason: (name: string) => string }, name: string, propose: boolean): Item {
    this.checkRepo(repo);
    // clear of the note on the plan directory, as on a canvas that has nothing else yet
    const { items, planDirs = [] } = this.snapshot();
    const box = unionBounds([...items.filter((i) => !i.parent).map((i) => boundsOf(i, items)), ...planDirs.flatMap((d) => planDirNoteBox(d) ?? [])]);
    const at = box ? { x: box.x + box.w + 2 * GAP, y: box.y } : { x: 0, y: 0 };
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: propose ? 'proposal' : 'planned',
        title: t.title(name),
        body: t.body,
        ...at,
        repo: this.repoColumn(repo),
        ...(propose ? { proposal: toJson({ ...proposalOf({ reason: t.reason(name) }), setup: true }) } : {}),
      },
    ]);
    this.setSetting(`${key}${repo}`, row!.id);
    this.changed();
    return this.itemOf(row!);
  }

  /**
   * Obeya proposes the setup card (`setupCard`) for a repository whose settings it does not know
   * (`unknown`), once: dismissed, accepted or made in the dialog, it does not come back. Its
   * proposal still open goes once the settings are there, withdrawn rather than dismissed.
   */
  proposeSetup(repo: string, name: string, unknown: boolean) {
    const id = this.setting(`${SETUP_CARD_SETTING}${repo}`);
    if (!id) {
      if (unknown && !this.openSetupCard(repo, name)) this.setupCard(repo, name, true);
      return;
    }
    if (!unknown) this.withdrawOwn(id);
  }

  /**
   * Obeya proposes the card that gives a repository's shared pages a look of their own once a page
   * of it is out (`shares`) and it has no theme (`themed`), once: dismissed, accepted or done, it
   * does not come back. Its proposal still open goes once the repository has a theme.
   */
  proposeTheme(repo: string, name: string, p: { themed: boolean; shares: boolean }) {
    const id = this.setting(`${THEME_CARD_SETTING}${repo}`);
    if (!id) {
      if (!p.themed && p.shares) this.repoCard(repo, THEME_CARD_SETTING, this.t.themeCard, name, true);
      return;
    }
    if (p.themed) this.withdrawOwn(id);
  }

  /** Whether a page of the repository's cards is online, or was (archived cards too). */
  sharesPages(repo: string): boolean {
    const column = this.repoColumn(repo);
    return this.sharedRows().some((r) => r.repo === column && !!this.storedShare(r).url);
  }

  /** Obeya's own proposal still open goes, withdrawn rather than dismissed. */
  private withdrawOwn(id: string) {
    const row = this.store.card(id);
    if (!row || row.deleted_at || row.state !== 'proposal') return;
    this.setProposal(id, { ...fromJson(row.proposal)!, superseded: {} }, { deleted_at: new Date().toISOString() });
  }

  /** The cards the work retrospective proposed for a repository, with what became of them. */
  retroProposals(repo: string) {
    return this.store.retroProposals(this.canvas.id, this.repoColumn(repo));
  }

  /** A value for a repository's setting the work retrospective proposes: it waits in Obeya's sheet beside the rules. */
  proposeSetting(p: { repo: string; field: ProposedSetting; value: string | string[]; basis: string; cards: string[] }): number {
    this.checkRepo(p.repo);
    const id = this.store.addSettingProposal(this.canvas.id, { ...p, basis: p.basis.slice(0, NOTE_MAX) });
    this.changed();
    return id;
  }

  /** The settings the work retrospective proposed, with what became of them: those of a repository, or all. */
  settingProposals(repo?: string) {
    return this.store.settingProposals(this.canvas.id, repo);
  }

  /** The waiting setting proposal; a BadRequest where it was decided meanwhile or never was. */
  settingProposal(id: number): SettingProposal {
    const p = this.settingProposals().find((x) => x.id === id && x.state === 'proposed');
    if (!p) throw new BadRequest('unknownSetting', 'no such setting proposal');
    const { state: _, ...rest } = p;
    return rest;
  }

  /** The owner took a setting proposal (on this machine, or into the repository for everyone, with `value`) or rejected it; a rejected one is kept, so it does not come back. */
  decideSetting(id: number, state: Exclude<SettingProposalState, 'proposed'>, value?: string | string[]) {
    if (!this.store.decideSettingProposal(this.canvas.id, id, state, value)) throw new BadRequest('unknownSetting', 'no such setting proposal');
    this.changed();
  }

  addFriction(repo: string, cardId: string, notes: FrictionNote[]) {
    if (notes.length) this.store.addFriction(this.canvas.id, repo, cardId, notes);
  }

  /** The friction noted on a repository's cards after `since` (all without), oldest first. */
  friction(repo: string, since: string | null): Friction[] {
    return this.store.friction(this.canvas.id, repo, since);
  }

  decide(d: { project_id: string | null; card_id: string; question: string; answer: string; by: 'owner' }) {
    this.store.addDecision({ canvas_id: this.canvas.id, ...d });
  }

  /** The decisions taken on one card, oldest first. */
  decisionsOn(cardId: string): Decision[] {
    return this.store.cardDecisions(this.canvas.id, cardId).map(toDecision);
  }

  /** A project's decisions, or with `null` those of standalone cards. */
  decisions(projectId: string | null) {
    return this.store.decisions(this.canvas.id, projectId);
  }

  setting(key: string): string | null {
    return this.store.setting(this.canvas.id, key);
  }

  setSetting(key: string, value: string) {
    this.store.setSetting(this.canvas.id, key, value);
  }

  /** Sharing many outdated pages again, while it runs and until the owner puts its result away. */
  reshareRun(): StoredReshare | null {
    const v = this.setting(RESHARE_SETTING);
    return v ? (JSON.parse(v) as StoredReshare) : null;
  }

  setReshareRun(run: StoredReshare | null) {
    this.setSetting(RESHARE_SETTING, run ? JSON.stringify(run) : '');
    this.changed();
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
    const dismissed = at(this.setting(RESHARE_DISMISSED));
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
          this.cache = null;
          this.tell();
        }
      } while (this.lookAgain);
    })().finally(() => (this.looking = null));
    return this.looking;
  }

  /** The current theme of each repository (its hash, null for none), by its id; for the pages it leaves outdated. */
  private themeOf?: (repo: string) => string | null | undefined;

  showThemes(of: (repo: string) => string | null | undefined) {
    this.themeOf = of;
    this.changed();
  }

  /** The current theme's hash of the card's repository (`ThemeNow`). */
  private themeNow: ThemeNow = (r) => this.themeOf?.(repoOfRow(r, this.home));

  /** The pages a theme left outdated when the owner put the notice away (`RESHARE_DISMISSED_THEMES`). */
  private dismissedThemes(): Record<string, ThemePair> {
    const v = this.setting(RESHARE_DISMISSED_THEMES);
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
    const vocabulary = this.vocabularyOf?.(repoOfRow(r, this.home));
    return !!s.url && !s.state && !s.personal && !!vocabulary && untagged(this.pageTags(r), vocabulary).length > 0;
  }

  /** The vocabulary of tags each repository's site names (`demo.site.tags`), for the pages without tags; none where it names none. */
  private vocabularyOf?: (repo: string) => PageTags | undefined;

  showVocabulary(of: (repo: string) => PageTags | undefined) {
    this.vocabularyOf = of;
    this.changed();
  }

  /** "Hide": the notice of outdated pages goes until a newer change, and the result of a run that finished with it. */
  dismissOutdated() {
    this.setSetting(RESHARE_DISMISSED, pagesVersion());
    // the pages outdated by a theme now; one no longer is needs no entry
    const themes: Record<string, ThemePair> = {};
    for (const r of this.sharedRows()) if (this.outdatedAsLooked(r).includes(THEME_CHANGED)) themes[r.id] = this.themePair(r);
    this.setSetting(RESHARE_DISMISSED_THEMES, JSON.stringify(themes));
    this.setReshareRun(null);
  }

  /** An idea's stored status and brief. */
  idea(id: string): StoredIdea {
    const r = this.own(id);
    if (r.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return r.idea ? fromJson(r.idea) : { status: 'open', brief: '' };
  }

  setIdea(id: string, fields: Partial<StoredIdea>) {
    this.work(id, { idea: toJson({ ...this.idea(id), ...fields }) });
  }

  /** The thread of looked-up answers a Question card (or an idea that was one) holds. */
  thread(id: string): StoredThread {
    const r = this.own(id);
    if (!r.thread) throw new BadRequest('notQuestion', 'the card holds no thread of answers');
    return fromJson(r.thread);
  }

  setThread(id: string, fields: Partial<StoredThread>) {
    this.work(id, { thread: toJson({ ...this.thread(id), ...fields }) });
  }

  /**
   * A Question card for a thread of looked-up answers, near the card whose log holds them (`near`)
   * or where there is room: its question as its title, the agent's session going on.
   */
  addQuestion(title: string, thread: StoredThread, session: string | undefined, repo: string | undefined, near?: string): Item {
    const at = near && this.item(near) ? this.followUpSpot(near) : this.freeSpot();
    const [row] = this.store.insert([
      { canvas_id: this.canvas.id, kind: 'question', state: 'done', title: clip(oneLine(title), 160), body: '', ...at, repo: this.repoColumn(repo), ...(near && this.item(near) ? { group_id: this.groupOf(this.own(near)) } : {}) },
    ]);
    this.store.update(row!.id, { thread: toJson(thread), ...(session ? { session_id: session } : {}) });
    this.changed();
    return this.item(row!.id)!;
  }

  /** A card whose worker builds a throwaway prototype for the idea; placed below it, beside the prototypes already there. */
  addPrototype(ideaId: string, title: string, body: string, variant?: string): Item {
    const items = this.items();
    const idea = items.find((i) => i.id === ideaId);
    const at = below(idea ? boundsOf(idea, items) : { x: 0, y: 0, w: 0, h: 0 }, items.filter((i) => i.prototypeOf === ideaId).length);
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: 'planned',
        title: title.slice(0, TITLE_MAX),
        body: body.slice(0, BODY_MAX),
        ...at,
        from_id: ideaId,
        prototype_of: ideaId,
        group_id: idea?.group ?? null,
        ...(variant ? { prototype: toJson({ variant }) } : {}),
        repo: this.repoColumn(idea?.repo),
      },
    ]);
    this.changed();
    return this.itemOf(row!);
  }

  /** The prototype's worker proposes to build the idea on it; the owner accepts on the prototype's card. */
  proposeBuild(id: string, reason: string) {
    const row = this.own(id);
    if (!row.prototype_of) throw new BadRequest('notPrototype', 'not a prototype');
    this.work(id, { prototype: toJson({ ...(fromJson(row.prototype) ?? {}), proposal: reason }) });
  }

  /**
   * A prototype has served its purpose: discarded or built, it goes into the archive with its log,
   * demo and summary, and never comes back. Its workspace is no longer its own.
   */
  endPrototype(id: string, end: 'discarded' | 'built', into?: string) {
    const row = this.own(id);
    if (!row.prototype_of) throw new BadRequest('notPrototype', 'not a prototype');
    const { proposal: _, ...kept } = fromJson(row.prototype) ?? {};
    this.work(id, { prototype: toJson({ ...kept, end, ...(into ? { into } : {}) }), archived_at: new Date().toISOString(), need: null, status_line: null, workspace: null, queue: null });
  }

  // ---------------------------------------------------------------- the Coordinator's memory

  /**
   * Records an exchange with the Coordinator, without its reply (`''`) while it reads the words;
   * returns its id. `replyTo`: the message of the sheet the words reply to.
   */
  addTalk(said: string, reply: string, cardId: string | null = null, lookUp?: { question: string; about: string | null }, images: string[] = [], replyTo?: TalkRef, after?: TalkAfter, askedIn?: string, answered?: number): number {
    const id = this.store.addTalk(this.canvas.id, said, reply, cardId, lookUp, images, replyTo, after, askedIn, answered);
    this.changed();
    return id;
  }

  /**
   * The Coordinator's reply to words it has read, the question it looks up for them, and what a
   * draft for Obeya's makers would start from; `waits`: unread in the sheet until the owner sees it;
   * `answers`: it answers them (not that it could not read them).
   */
  replyTalk(id: number, reply: string, lookUp?: { question: string; about: string | null }, wish?: Wish, waits = false, answers = waits) {
    this.store.replyTalk(id, reply, lookUp, wish, waits, answers);
    this.changed();
  }

  /**
   * After a restart: words the Coordinator was reading when Obeya stopped are not read any more;
   * they get a reply that says so, in the sheet or on the card that was open.
   */
  interruptTalk() {
    const lost = this.store.interruptTalk(this.canvas.id, this.t.voice.interrupted);
    for (const x of lost) if (x.cardId && this.item(x.cardId)) this.log(x.cardId, 'say', 'coordinator', this.t.voice.interrupted, { reply: true });
    if (lost.length) this.changed();
  }

  /** Words the usage limit keeps the Coordinator from reading, until it lifts; `null` once it reads them. */
  holdTalk(id: number, held: HeldTalk | null) {
    this.store.holdTalk(id, held);
    this.changed();
  }

  /** The words the usage limit holds, oldest first: after a restart, the Coordinator reads them once it lifts. */
  heldTalk() {
    return this.store.heldTalk(this.canvas.id);
  }

  /** The cards the Coordinator waits on after the exchange's reply, to take a step once each gets there. */
  waitTalk(id: number, waits: TalkWaitRow[]) {
    this.store.waitTalk(id, waits);
    this.changed();
  }

  /** The exchanges whose reply said the Coordinator waits on a card. */
  waitingTalk() {
    return this.store.waitingTalk(this.canvas.id);
  }

  /** The step the Coordinator takes once the exchange's looked-up answer is in, and where the owner was then; `null` once it has decided it. */
  thenTalk(id: number, then: string | null, place?: Place) {
    this.store.thenTalk(id, then, place);
  }

  /** Looked-up answers that are in whose step the Coordinator has not decided yet: after a restart, it takes them up. */
  answeredSteps() {
    return this.store.answeredSteps(this.canvas.id);
  }

  undoTalk(id: number) {
    this.store.undoTalk(id);
    this.changed();
  }

  /** A command waiting for "Undo" until `due`, kept across a restart (`Commander`). */
  holdCommand(token: string, due: number, body: unknown) {
    this.store.holdCommand(this.canvas.id, token, new Date(due).toISOString(), JSON.stringify(body));
  }

  dropCommand(token: string) {
    this.store.dropCommand(token);
  }

  heldCommands(): { token: string; due: number; body: unknown }[] {
    return this.store.heldCommands(this.canvas.id).map((r) => ({ token: r.token, due: Date.parse(r.due), body: JSON.parse(r.body) as unknown }));
  }

  talk(limit?: number) {
    return this.store.talk(this.canvas.id, limit);
  }

  /** The answer to a question the Coordinator looked up, with the files it comes with. */
  answerTalk(id: number, answer: string, by: 'coordinator' | 'project', files: AnswerFile[] = []) {
    this.store.answerTalk(id, answer, by, files);
    this.changed();
  }

  /** The files an exchange shows while its answer is still being looked up: the walkthrough it plays meanwhile. */
  talkFiles(id: number, files: AnswerFile[]) {
    this.store.talkFiles(id, files);
    this.changed();
  }

  /** The exchange follows up on the answer of `follows`: it goes on in that one's thread. */
  followTalk(id: number, follows: number) {
    const f = this.store.exchange(follows);
    if (!f?.thread) throw new BadRequest('invalid', 'the exchange followed up on was not looked up');
    this.store.followTalk(id, f.thread, follows);
    this.changed();
  }

  /** The session of the agent that looks the exchange's question up. */
  talkSession(id: number, session: string) {
    this.store.talkSession(id, session);
  }

  /** The exchanges of a looked-up thread, oldest first. */
  threadTalk(thread: number) {
    return this.store.thread(this.canvas.id, thread);
  }

  /** The thread is on a Question card from now on. */
  moveThread(thread: number, card: string) {
    this.store.moveThread(this.canvas.id, thread, card);
    this.changed();
  }

  /** The owner has Obeya's sheet in view, or (`ids`) those exchanges in a project's sheet. */
  readTalk(ids?: number[]) {
    if (this.store.readTalk(this.canvas.id, ids)) this.changed();
  }

  exchange(id: number) {
    return this.store.exchange(id);
  }

  /** The exchange a reply of the Coordinator's in the card's log stands for. */
  cardReply(cardId: string, reply: string) {
    return this.store.cardReply(cardId, reply);
  }

  /** A message of the card's log, by its id. */
  event(cardId: string, id: number) {
    return this.store.event(cardId, id);
  }

  /** Questions the Coordinator is still looking up. */
  lookingUp(): number[] {
    return this.store.lookingUp(this.canvas.id);
  }

  /** The cards' history after `since` (ISO time, or a `mark`), oldest first, at most the latest `limit` steps. */
  timeline(since: string | Mark, limit: number) {
    return this.store.timeline(this.canvas.id, since, limit);
  }

  /** Where the cards' history stands now. */
  mark() {
    return this.store.mark();
  }

  /** What the owner said after `since` (ISO time), oldest first, at most the latest `limit`. */
  utterances(since: string, limit: number) {
    return this.store.utterances(this.canvas.id, since, limit);
  }

  /** Rule proposals the owner accepted or rejected after `since` (ISO time), oldest first. */
  decidedProposals(since: string) {
    return this.store.decidedProposals(this.canvas.id, since);
  }

  /** The owner's cards deleted after `since` (ISO time), oldest first. */
  removed(since: string) {
    return this.store.removed(this.canvas.id, since);
  }

  /**
   * The owner takes a proposal: as an idea (`asIdea`, whatever it was proposed as), else as a
   * planned task. Its questions join the text, with the options picked (`picks`) as decided.
   */
  accept(id: string, picks: string[][] = [], asIdea = false) {
    const { row } = this.proposalOn(id);
    const proposal = fromJson(row.proposal);
    if (proposal?.revising) throw new BadRequest('revising', 'the proposal is being reworked');
    // an agent's proposal keeps that it was one: its task is not the owner's words; Obeya's setup card is as if the owner made it
    const kept = proposal && !proposal.setup && toJson<Proposal>({ ...(proposal.idea ? { idea: true } : {}), questions: [] });
    this.store.update(id, { state: asIdea ? 'idea' : 'planned', body: withQuestions(row.body ?? '', proposal?.questions ?? [], picks, this.t), proposal: kept || null });
    this.changed();
  }

  /**
   * The harness, model and effort the card's agent runs on, over the workers' group's (`null`: the
   * group's again), for each session of its next run. A session keeps what it started on, so the choice
   * changes only while the card waits to start (planned, or proposed).
   */
  chooseAgent(id: string, agent: CardAgent | null) {
    this.own(id);
    const card = this.item(id);
    if (card?.kind === 'project') throw new BadRequest('project', 'a project is worked on through its workstreams');
    if (card?.state !== 'planned' && card?.state !== 'proposal') throw new BadRequest('agentStarted', 'the card is at work or done: its agent keeps its harness and model');
    let chosen: CardAgent | null = null;
    if (agent !== null) {
      const { harness, model, effort, ...other } = (agent && typeof agent === 'object' ? agent : {}) as Record<string, unknown>;
      const both = harness !== undefined || model !== undefined;
      if (
        Object.keys(other).length ||
        (both && (!HARNESSES.some((h) => h === harness) || typeof model !== 'string' || !modelFits(harness as Harness, model))) ||
        (effort !== undefined && !AGENT_EFFORTS.some((e) => e === effort)) ||
        (!both && effort === undefined)
      )
        throw new BadRequest('invalid', 'agent must be a harness with a model it takes, an effort, or both');
      chosen = { ...(both ? { harness: harness as Harness, model: storedModel(harness as Harness, model as string) } : {}), ...(effort !== undefined ? { effort: effort as AgentEffort } : {}) };
    }
    this.store.update(id, { agent: chosen && toJson(chosen) });
    this.changed();
  }

  /**
   * The owner wants a proposal changed: an agent reworks it by their words, and it waits for that.
   * Words said while it is reworked wait for the rework after it. Returns whether they wait.
   */
  revising(id: string, words: string, spoken: boolean, said?: number, images: string[] = []): boolean {
    const { proposal } = this.proposalOn(id);
    const these: Revising = {
      words: words.slice(0, BODY_MAX),
      ...(spoken ? { spoken } : {}),
      ...(said ? { said: [said] } : {}),
      ...(images.length ? { images: images.map((f) => basename(f)) } : {}),
    };
    const revising = proposal.revising ? { ...proposal.revising, next: [...(proposal.revising.next ?? []), these] } : these;
    this.setProposal(id, { ...proposal, revising });
    return revising !== these;
  }

  /** The owner takes back words that wait for the proposal's next rework; false when none of them are these. */
  unrevise(id: string, said: number): boolean {
    const proposal = fromJson(this.own(id).proposal);
    const next = proposal?.revising?.next;
    if (!proposal?.revising || !next?.some((r) => r.said?.includes(said))) return false;
    const rest = next.filter((r) => !r.said?.includes(said));
    const { next: _, ...revising } = proposal.revising;
    this.setProposal(id, { ...proposal, revising: { ...revising, ...(rest.length ? { next: rest } : {}) } });
    return true;
  }

  /** When the proposal starts once accepted (ISO), or at once (`null`). */
  startAt(id: string, at: string | null) {
    const { startAt: _, ...proposal } = this.proposalOn(id).proposal;
    this.setProposal(id, { ...proposal, ...(at ? { startAt: at } : {}) });
  }

  /** "Accept and start" during a revision (`on`; `idea`: "Discuss as an idea"), or taken back; false when that was so already. */
  acceptAfterRevision(id: string, on: boolean | 'idea'): boolean {
    const { acceptAfterRevision: was, ...proposal } = this.proposalOn(id).proposal;
    if ((was ?? false) === on) return false;
    this.setProposal(id, { ...proposal, ...(on ? { acceptAfterRevision: on } : {}) });
    return true;
  }

  /**
   * The reworked proposal takes the place of the old one, or, without one (the agent failed), the
   * old one stands as it was; `images`, when given, are the screenshots that go with its task now.
   * Accepting it after the revision stays for the caller to settle. False when the card is no
   * proposal any more (dismissed meanwhile).
   */
  revised(id: string, p?: { title: string; task: string; reason?: string; idea?: boolean; questions: Question[]; images?: string[] }): boolean {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id || row.deleted_at || row.state !== 'proposal') return false;
    const { revising: done, ...was } = fromJson(row.proposal) ?? { questions: [] };
    // what the owner said meanwhile is the next rework's
    const next = done?.next?.length ? { revising: merged(done.next) } : {};
    // when it starts is the owner's to change, not the reviser's
    const proposal: Proposal = p ? { ...proposalOf({ ...p, startAt: was.startAt }), ...(was.acceptAfterRevision ? { acceptAfterRevision: was.acceptAfterRevision } : {}), ...(was.setup ? { setup: was.setup } : {}) } : was;
    this.setProposal(
      id,
      { ...proposal, ...next },
      { ...(p ? { title: p.title.slice(0, TITLE_MAX), body: p.task.slice(0, BODY_MAX) } : {}), ...(p?.images ? { images: p.images.length ? toJson(p.images) : null } : {}) },
    );
    return true;
  }

  // ---------------------------------------------------------------- archive

  /** Takes finished cards, stopped tasks, parked or dropped ideas of the owner's and projects whose work is done off the canvas into its archive. */
  archive(ids: string[]) {
    for (const id of ids) {
      const row = this.own(id);
      if (row.kind === 'project' && row.plan_ref) {
        if (this.items().find((i) => i.id === id)?.state !== 'done') throw new BadRequest('notDone', 'a project goes into the archive once its work is done');
        continue;
      }
      if (row.plan_ref) throw new BadRequest('planCard', 'a workstream stays with its project');
      if (row.state === 'idea') {
        if (this.idea(id).status === 'open') throw new BadRequest('notDone', 'an idea under discussion cannot be archived');
        if (this.items().some((i) => i.prototypeOf === id)) throw new BadRequest('prototypeRunning', 'a prototype for this idea is still running');
        continue;
      }
      // a stopped task goes with its conversation, for the owner to come back to; work its workspace holds would be left unseen,
      // unless its repository does not run on the canvas, where nothing could show it anyway; one built on a
      // prototype that no agent has worked on since is planned, not stopped (`unstarted`)
      if (row.state === 'planned' && row.branch && row.kind === 'task' && !row.prototype_of && !(row.built_on && !row.session_id)) {
        if (row.queue) throw new BadRequest('notDone', 'the card waits to be started');
        if ((row.workspace || row.kept_in) && !this.item(id)?.repoDown) throw new BadRequest('holdsWork', 'its workspace holds work that has not landed');
        continue;
      }
      if (!row.state || !finished(row.state)) throw new BadRequest('notDone', 'only a finished or stopped card can be archived');
      if (row.landed && row.workspace) throw new BadRequest('notDone', 'its agent still finishes what remains after the landing');
    }
    const at = new Date().toISOString();
    // a stopped card snoozed to start later starts no more: brought back, it is the owner's to start
    this.store.db.transaction(() => ids.forEach((id) => this.store.update(id, { archived_at: at, ...(this.snoozedOf(id)?.start ? { snoozed: null } : {}) })))();
    this.changed();
  }

  /** Archives every finished card of the owner's on the canvas; returns their ids. */
  archiveDone(): string[] {
    const ids = this.snapshot().items.filter(archivedWithDone).map((i) => i.id);
    if (ids.length) this.archive(ids);
    return ids;
  }

  /**
   * Puts an archived card back where it was on the canvas. A project comes back with its doc; one
   * whose work is done also on its own, as its doc last stood if it is gone.
   */
  unarchive(id: string) {
    const row = this.own(id);
    if (!row.archived_at) throw new BadRequest('notArchived', 'the card is not archived');
    if (row.kind === 'project' && row.plan_ref) {
      const doc = (this.docs ??= this.read()).find((d) => d.file === row.plan_ref) ?? fromJson(row.plan);
      if (!doc || !workDone(doc, this.store.cards(this.canvas.id))) throw new BadRequest('planCard', 'a project comes back when its plan doc does');
    } else if (row.plan_ref) throw new BadRequest('planCard', 'a workstream comes back with its project');
    // a new attempt is a new prototype
    if (row.prototype_of) throw new BadRequest('prototypeEnded', 'a discarded or built prototype stays in the archive');
    this.store.update(id, { archived_at: null });
    this.changed();
    this.backOnCanvas(id);
  }

  /**
   * A page of the archive, the most recently archived first (of cards archived at once, the newest
   * first): `count` cards after where the page before ended (its `next`), or from the start. A
   * project comes as its plan doc last stood, followed by its workstreams (with `parent`), which the
   * archive lists under it, not on their own. Only the cards of the page are built, however long the
   * archive: the page asks for more as the owner scrolls.
   */
  archivePage(count: number, after?: string): ArchivePage {
    // the docs as they are now decide what is archived
    this.items();
    const rows = this.store.archivePage(this.canvas.id, count + 1, cursorOf(after));
    const page = rows.slice(0, count);
    return { items: this.archiveOf(page), ...(rows.length > count ? { next: cursorFrom(page.at(-1)!) } : {}) };
  }

  /**
   * The whole archive, a page after the other: for a pass over all of it that the owner does not
   * wait for (a folder's cards once after a start).
   */
  async *archivedPages(size = ARCHIVE_SLICE): AsyncGenerator<Item[]> {
    for (let after: string | undefined, first = true; first || after; first = false) {
      const page = this.archivePage(size, after);
      yield page.items;
      after = page.next;
      // what waits for the server in the meantime is answered between the pages
      if (after) await new Promise((r) => setImmediate(r));
    }
  }

  /** The whole archive at once, the most recently archived first (`archivePage`). */
  archived(): Item[] {
    const items: Item[] = [];
    for (let after: string | undefined, first = true; first || after; first = false) {
      const page = this.archivePage(ARCHIVE_SLICE, after);
      items.push(...page.items);
      after = page.next;
    }
    return items;
  }

  /**
   * The archive's entries of these cards, as `archivePage` lists them, in its order: the page reads
   * again the entries it holds apart from its pages (a card opened from its address) once the
   * archive changed. A card no longer archived is left out.
   */
  archiveEntries(ids: string[]): Item[] {
    this.items();
    return this.archiveOf(this.store.archivedRows(this.canvas.id, ids).sort(archiveOrder));
  }

  /**
   * The archive's entry holding the card an address names (its id or its short code): the archived
   * card, or the archived project of a workstream with all its workstreams; none for a card not in
   * the archive.
   */
  archiveEntry(code: string): Item[] {
    this.items();
    const row = this.store.cardNamed(code);
    if (!row || row.canvas_id !== this.canvas.id || row.deleted_at) return [];
    if (row.archived_at) return this.archiveOf([row]);
    const parent = row.parent_id ? this.store.card(row.parent_id) : null;
    return parent?.archived_at && parent.canvas_id === this.canvas.id && !parent.deleted_at ? this.archiveOf([parent]) : [];
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
  async archiveSearch(query: string, o: { count: number; from?: number; labels?: Partial<Record<ArchiveLabel, string>>; everywhere?: boolean }): Promise<ArchivePage> {
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
    const items = this.archiveOf(this.store.archivedRows(this.canvas.id, tops).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!));
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
    this.items();
    if (this.indexDrop) clearTimeout(this.indexDrop);
    this.indexDrop = setTimeout(() => {
      this.archiveIndex = null;
      this.indexDrop = null;
    }, ARCHIVE_INDEX_KEPT_MS);
    this.indexDrop.unref?.();
    if (!this.archiveIndex) {
      this.indexing ??= this.indexArchive().finally(() => (this.indexing = null));
      this.archiveIndex = await this.indexing;
    }
    const index = this.archiveIndex;
    const { upTo, ids } = this.store.archiveChanges(this.canvas.id, index.upTo);
    if (ids.length) {
      const rows = this.store.archivedRows(this.canvas.id, ids);
      for (const id of ids) index.byTop.delete(id);
      for (const [top, entries] of this.indexEntries(rows)) index.byTop.set(top, entries);
      index.order = null;
      this.store.dropArchiveChanges(this.canvas.id, upTo);
    }
    index.upTo = upTo;
    return index;
  }

  /** The whole archive as the search reads it, a slice at a time. */
  private async indexArchive(): Promise<ArchiveIndex> {
    // the writes from here on are read again after
    const upTo = this.store.archiveLog();
    this.store.dropArchiveChanges(this.canvas.id, upTo);
    const byTop = new Map<string, Indexed[]>();
    for (let after: ArchiveCursor | undefined, first = true; first || after; first = false) {
      const rows = this.store.archivePage(this.canvas.id, INDEX_SLICE, after);
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
    const items = this.archiveOf(rows);
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
  private archiveOf(rows: CardRow[]): Item[] {
    const projects = rows.filter((r) => r.plan_ref);
    const docs = projects.map((r) => fromJson(r.plan!));
    const kids = this.store.children(projects.map((r) => r.id));
    // a project whose work is done may come back to the canvas
    const done = new Set(projects.flatMap((r, n) => (workDone(docs[n]!, kids) ? [r.id] : [])));
    const items = this.withProjectSpend(this.withPrototypes(toItems([...rows, ...kids], docs, this.home, this.worked, this.themeNow))).map((i) => (done.has(i.id) ? { ...i, state: 'done' as const } : i));
    const byId = new Map(items.map((i) => [i.id, i]));
    const kidsOf = Map.groupBy(items.filter((i) => i.parent), (i) => i.parent!);
    return rows.flatMap((r) => {
      const at = { archivedAt: r.archived_at! };
      const own = byId.get(r.id);
      return own ? [{ ...own, ...at }, ...(kidsOf.get(r.id) ?? []).map((i) => ({ ...i, ...at }))] : [];
    });
  }

  /** Any card of the canvas as the UI sees it: on the canvas, or in the archive. */
  card(id: string): Item | undefined {
    // the docs as they are now decide what is archived
    this.items();
    return this.cards([this.own(id)]).get(id);
  }

  /**
   * The cards of these rows as the UI sees them (`card`), built at once, by their ids: a pass over
   * many (all shared cards) builds the archived ones among them together, not one after the other.
   * A row of a card deleted, of another canvas or of none the UI shows is left out.
   */
  cards(rows: CardRow[]): Map<string, Item> {
    const shown = new Map(this.items().map((i) => [i.id, i]));
    const out = new Map<string, Item>();
    const mine = (r: CardRow | null): r is CardRow => !!r && r.canvas_id === this.canvas.id && !r.deleted_at;
    const parents = new Map<string, CardRow | null>();
    // the row of the archive that brings the card: its own, or its project's for a workstream
    const archivedOf = (r: CardRow) => {
      if (r.archived_at) return r;
      if (!r.parent_id) return null;
      if (!parents.has(r.parent_id)) parents.set(r.parent_id, this.store.card(r.parent_id));
      const parent = parents.get(r.parent_id)!;
      return mine(parent) && parent.archived_at ? parent : null;
    };
    const archived = new Map<string, CardRow>();
    const wanted: string[] = [];
    for (const given of rows.filter(mine)) {
      const item = shown.get(given.id);
      if (item) {
        out.set(given.id, item);
        continue;
      }
      // neither on the canvas nor archived as read: a project whose doc went may be archived by the canvas reading the docs
      const r = archivedOf(given) ? given : this.store.card(given.id);
      const brings = mine(r) ? archivedOf(r) : null;
      if (!brings) continue;
      archived.set(brings.id, brings);
      wanted.push(given.id);
    }
    if (!wanted.length) return out;
    // only the cards asked for (a workstream with its project)
    const archive = new Map(this.archiveOf([...archived.values()]).map((i) => [i.id, i]));
    for (const id of wanted) {
      const item = archive.get(id);
      if (item) out.set(id, item);
    }
    return out;
  }

  /** What a project's sheet shows besides the doc: its decisions and those of the idea or task it came from. */
  projectHistory(id: string): ProjectHistory {
    const row = this.own(id);
    if (row.kind !== 'project') throw new BadRequest('invalid', 'not a project');
    const own = this.store.decisions(this.canvas.id, id, 500);
    const origin = row.from_id ? this.store.card(row.from_id) : null;
    const fromOrigin = origin && !origin.deleted_at ? this.store.cardDecisions(this.canvas.id, origin.id) : [];
    const decisions = [...fromOrigin, ...own].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id).map(toDecision);
    // what its project agent answered: about the project or one of its workstreams
    const talk = this.store.talkAbout(this.canvas.id, [id, ...this.store.children([id]).map((c) => c.id)]);
    return { decisions, origin: origin && !origin.deleted_at ? (this.card(origin.id) ?? null) : null, talk };
  }

  /** The plan docs (plan references) that a card's landed work added; the card becomes their origin. */
  planDocsLanded(cardId: string, refs: string[]) {
    const row = this.own(cardId);
    // only a card that was an idea, or a task the owner planned as a project, is a project's origin
    if ((!row.idea && !row.becomes_project) || !refs.length) return;
    this.store.update(cardId, { plan_docs: toJson(refs) });
    this.changed();
  }

  /**
   * Why the card holding the workspace at `path` will not work in it again, where it will not: the
   * card does not name it as its workspace, or its work is over and its worker done (`stale`: the
   * lease outlived what it was for); it was deleted; or it is a workstream no worker is on whose box
   * the plan doc on the default branch ticks off (`ticked`; `merged` while it is in its pull request,
   * which the doc says has been merged), or that the doc there no longer has (`gone`). A box ticked
   * in a plan folder outside the repository says nothing of a landing (`tickedAhead`).
   */
  leaseEnded(cardId: string, path: string): 'stale' | 'deleted' | 'archived' | 'ticked' | 'merged' | 'gone' | null {
    const row = this.store.card(cardId);
    if (!row) return 'stale';
    if (row.canvas_id !== this.canvas.id) return null;
    // a deleted card keeps its workspace named, to take it back when it is restored
    if (row.workspace !== path) return 'stale';
    if (row.landed) return null;
    if (row.deleted_at) return 'deleted';
    // a stopped task the archive took with its workspace, while its repository did not run on the canvas
    if (row.archived_at && (row.state ?? 'planned') === 'planned') return 'archived';
    // what remained after the landing is done: the worker that did it gave the workspace up
    if (row.state && finished(row.state)) return 'stale';
    const hash = row.plan_ref?.indexOf('#') ?? -1;
    if (hash < 0 || row.state === 'working' || row.state === 'waiting' || row.state === 'approved') return null;
    if (row.state === 'inPr' && !row.pr) return null;
    if (row.state === 'inPr' && tickedAhead(row)) return null;
    // the docs are read the way the canvas reads them, which plans again a workstream only a part of which landed
    this.items();
    const doc = this.docs?.find((d) => d.file === row.plan_ref!.slice(0, hash));
    const w = doc?.workstreams.find((x) => x.key === row.plan_ref!.slice(hash + 1));
    // an open pull request goes on without the doc: its watcher sees it merged or closed; a repository
    // not (yet) on the canvas has no docs read
    if (!w) return row.state === 'inPr' || !this.canvas.repos.some((r) => r.id === repoOfRef(row.plan_ref!, this.home)) ? null : 'gone';
    if (!w.done || tickedAhead(row)) return null;
    return row.state === 'inPr' ? 'merged' : 'ticked';
  }

  /** The workspace at `path` was freed (`leaseEnded`); a deleted card keeps it named, to take it back when it is restored. */
  freed(cardId: string, path: string) {
    const row = this.store.card(cardId);
    // the pool the canvas shows has a clone more
    if (!row || row.deleted_at || row.workspace !== path) return this.changed();
    this.work(cardId, { workspace: null, app: null, parked: null });
  }

  /**
   * The card's clone went back to the pool, its branch kept there (`Workspaces.evict`), for its next
   * start to take from it: a card deleted meanwhile keeps that too, for when it is restored.
   */
  keptIn(cardId: string, path: string) {
    const row = this.store.card(cardId);
    if (!row || row.canvas_id !== this.canvas.id) return;
    this.store.update(cardId, { workspace: null, parked: null, app: null, kept_in: path });
    this.changedRows();
  }

  /**
   * The card's workspace at `path` left the pool, its folder gone: the card names none any more, one
   * at work is planned again, and its next start takes another workspace.
   */
  workspaceGone(cardId: string, path: string) {
    const row = this.store.card(cardId);
    if (!row || row.workspace !== path) return this.changed();
    const working = row.state === 'working';
    this.work(cardId, { workspace: null, app: null, parked: null, ...(working ? { state: 'planned', paused: null, pausing: null, snoozed: null } : {}) });
    if (!row.deleted_at) this.log(cardId, 'state', 'obeya', this.t.worker.workspaceGone(path, working));
  }

  /** A card's landed work is done, its worker gone: a card whose plan doc is a project now gives way to it. */
  workDone(cardId: string) {
    // a workstream its doc keeps open is planned again (reopen) once its worker is done
    if (this.own(cardId).plan_ref) this.docs = null;
    if (this.retire(cardId) || !this.docs) this.changed();
  }

  /** The canvas as the UI sees it; built once per change (every write here ends in `changed`). */
  snapshot(): CanvasSnapshot {
    const items = this.items();
    if (this.cache) return this.cache;
    const talk = this.store.talk(this.canvas.id, SHEET_TALK, true);
    const reshare = this.reshare();
    const pools = this.clonePools();
    const planDirs = this.planDirs(this.docs!, this.rows!);
    const spent = this.store.spentOn(this.canvas.id);
    const settingProposals = this.settingProposals()
      .filter((p) => p.state === 'proposed')
      .map(({ state: _, ...p }) => {
        const now = this.settingsNow?.(p.repo)?.[p.field];
        return now === undefined ? p : { ...p, now };
      });
    this.cache = {
      canvas: this.canvas,
      items,
      groups: this.store.groups(this.canvas.id).map(toGroup),
      preferences: this.store.preferences(this.canvas.id, ['proposed', 'active']),
      ...(settingProposals.length ? { settingProposals } : {}),
      talk: this.limits.size ? talk.map((x) => ({ ...x, ...this.limited(`talk:${x.id}`) })) : talk,
      ...(pools.length ? { workspaces: pools } : {}),
      ...(reshare ? { reshare } : {}),
      ...(planDirs.length ? { planDirs } : {}),
      archive: this.store.archiveRev(this.canvas.id),
      ...(spent ? { spent } : {}),
    };
    return this.cache;
  }

  /**
   * The canvas's cards as the UI sees them (the snapshot's `items`), built once per change without
   * the rest of the snapshot: code that changes cards reads them back between its writes.
   */
  items(): Item[] {
    // docs read before a repository joined the canvas lack its docs, which would count its workstreams gone
    const repos = this.canvas.repos.map((r) => r.id).join('\n');
    if (this.docs && this.docsOf !== repos) {
      this.docs = null;
      this.cache = null;
      this.itemsCache = null;
      this.rows = null;
      this.prototypeItems = null;
    }
    if (this.itemsCache) return this.itemsCache;
    const read = !this.docs;
    if (!this.docs) {
      this.docs = this.read();
      this.docsOf = repos;
    }
    // a doc whose cards wait for its history stays as last read until git is through (`follow`)
    const all = (this.docs = this.follow(this.docs, read));
    let rows = this.store.cards(this.canvas.id);
    const { docs, ended } = this.openDocs(all, rows);
    const open = docs.map((d) => d.file).join('\n');
    if (read || open !== this.open) {
      this.open = open;
      this.keepDocs(all, docs);
      if (read) this.reopen(all);
      // keeping and reopening docs archives and brings back their cards
      rows = this.store.cards(this.canvas.id);
    }
    let items = toItems(rows, docs, this.home, this.worked, this.themeNow);
    if (this.placeNew(docs, items, all, rows)) {
      // projects seen for the first time keep their doc too
      this.keepDocs(all, docs);
      // what reacts to changes hears of them too (the Coordinator reads what builds on what in a project just come)
      this.tell();
      rows = this.store.cards(this.canvas.id);
      items = toItems(rows, docs, this.home, this.worked, this.themeNow);
    }
    // a project whose work is done waits on the canvas for the owner to archive it
    if (ended.size) items = items.map((i) => (i.kind === 'project' && i.plan && ended.has(i.plan.file) ? { ...i, state: 'done' } : i));
    const manual = this.manualDependencies();
    if (manual.length) {
      const eligible = new Set(items.filter(connectable).map((i) => i.id));
      items = items.map((i) => {
        const on = eligible.has(i.id) ? manual.filter(([from, to]) => to === i.id && eligible.has(from)).map(([from]) => from) : [];
        return on.length ? { ...i, manualDependsOn: on } : i;
      });
    }
    items = this.withPrototypes(items);
    items = this.withProjectSpend(items);
    items = this.withElsewhere(items, rows);
    const inTurn = new Map([...this.turns].flatMap((f) => [...f()]));
    if (inTurn.size) items = items.map((i) => {
      const turn = inTurn.get(i.id);
      if (!turn) return i;
      const background = turn.tasks.length ? { background: turn.tasks } : {};
      // a worker that paused for the due restart is at work no more
      if (turn.restart) return needsYou(i) ? i : { ...i, restartPaused: true };
      // a turn that ended while its background work runs (the app served, say) holds the worker's slot,
      // but a card that waits for the owner then has nobody at work on it: only that work runs
      return turn.over && needsYou(i) ? { ...i, ...background } : { ...i, inTurn: true, ...background };
    });
    items = this.withoutStaleSnoozes(items, rows);
    items = this.withWaitingSince(items);
    // a card whose repository does not run on the canvas waits for it
    const running = new Set(this.canvas.repos.map((r) => r.id));
    if (items.some((i) => !running.has(i.repo))) items = items.map((i) => (running.has(i.repo) || i.kind === 'question' ? i : { ...i, repoDown: true }));
    if (this.limits.size) items = items.map((i) => ({ ...i, ...this.limited(`card:${i.id}`) }));
    this.itemsCache = items;
    this.rows = rows;
    return items;
  }

  /** A project's cost is its project agent's and its workstreams', archived ones too. */
  private withProjectSpend(items: Item[]): Item[] {
    const projects = items.flatMap((i) => (i.kind === 'project' ? [i.id] : []));
    if (!projects.length) return items;
    const under = this.store.spentUnder(projects);
    if (!under.size) return items;
    return items.map((i) => (i.kind === 'project' && under.has(i.id) ? { ...i, spent: (i.spent ?? 0) + under.get(i.id)! } : i));
  }

  /**
   * An agent session's cost so far (`Store.spend`): a card's agent's counts to that card (`cardId`),
   * any other to the canvas alone. Counted whether or not the owner has costs shown.
   */
  spend(cardId: string | undefined, session: string, usd: number) {
    const card = cardId && this.store.card(cardId) ? cardId : null;
    if (this.store.spend(this.canvas.id, card, session, usd)) this.changedRows();
  }

  /** Until when the usage limit holds back what goes by this key (`card:<id>`, `talk:<id>`). */
  private limited(key: string): { limitedUntil?: string } {
    const until = this.limits.get(key);
    return until ? { limitedUntil: until } : {};
  }

  /** Cards that come from a card on another canvas name it, with that canvas. */
  private withElsewhere(items: Item[], rows: CardRow[]): Item[] {
    // a card on this canvas is not looked up: the others are, all at once
    const here = new Set(rows.map((r) => r.id));
    const ids = [...new Set(items.flatMap((i) => (i.from && !here.has(i.from) ? [i.from] : [])))];
    const elsewhere = new Map(this.store.elsewhere(ids, this.canvas.id).map((o) => [o.id, o]));
    if (!elsewhere.size) return items;
    return items.map((i) => {
      const from = i.from ? elsewhere.get(i.from) : undefined;
      return from ? { ...i, fromElsewhere: { canvas: from.canvas, canvasName: from.canvasName ?? from.canvas, title: from.title ?? '' } } : i;
    });
  }

  /**
   * A card the owner snoozed while it waited for them that no longer waits for them (they answered
   * it after all, its proposal is reworked, its idea parked) is snoozed no longer; nor is a planned
   * card snoozed to start later that is no longer planned to start (started, made an idea, archived),
   * or no longer on the canvas (a workstream whose plan doc went or was ticked off): coming back after
   * its time, it would start unasked.
   */
  private withoutStaleSnoozes(items: Item[], rows: CardRow[]): Item[] {
    const shown = new Set(items.map((i) => i.id));
    for (const r of rows) if (r.snoozed && !shown.has(r.id) && fromJson(r.snoozed).start) this.store.update(r.id, { snoozed: null });
    return items.map((i) => {
      if (!i.snoozed?.waiting && !i.snoozed?.start) return i;
      const { snoozed: _, ...awake } = i;
      if (i.snoozed.waiting ? needsYou(awake) : plannedToStart(awake)) return i;
      this.store.update(i.id, { snoozed: null });
      return awake;
    });
  }

  /** The card's snooze, or null when it is not snoozed. */
  snoozedOf(cardId: string): Snooze | null {
    return fromJson(this.own(cardId).snoozed);
  }

  /** Snoozes the card until `until` (ISO) or the card it waits on, as `s` says, with the line in its conversation by whoever snoozed it (or changed the time). */
  snooze(cardId: string, s: Snooze, by: 'agent' | 'owner' = s.by) {
    this.work(cardId, { snoozed: toJson(s) });
    this.log(cardId, 'state', by === 'agent' ? 'worker' : 'owner', this.t.worker.snoozed(snoozeTerm(this.t, s), s.why));
  }

  /**
   * The card is snoozed no longer, with the line that it woke and why (`woke`): its time came, the
   * owner woke it, Obeya had something for its agent, the card needs the owner, what became of the
   * card it waited on, or what the contributor it waited for did. Returns the snooze it had.
   */
  unsnooze(cardId: string, woke: Woke): Snooze | null {
    const s = this.snoozedOf(cardId);
    if (!s) return null;
    this.work(cardId, { snoozed: null });
    const why = this.t.worker.wokeWhy;
    this.log(cardId, 'state', woke === 'owner' ? 'owner' : 'obeya', this.t.worker.woke(typeof woke === 'object' ? ('said' in woke ? woke.said : s.on ? why.card(s.on.title, woke.met, s.on.state) : why.time) : why[woke]));
    return s;
  }

  /**
   * Each card that waits for the owner with since when: noted when it starts to wait, kept in the
   * database across restarts while it waits, and forgotten once it no longer does.
   */
  private withWaitingSince(items: Item[]): Item[] {
    const known = this.store.waitingSince(this.canvas.id);
    const at = new Date().toISOString();
    const out = items.map((i) => {
      if (!needsYou(i)) return i;
      let since = known.get(i.id);
      if (!since) this.store.setWaitingSince(i.id, (since = at));
      return { ...i, waitingSince: since };
    });
    const waiting = new Set(out.flatMap((i) => (i.waitingSince ? [i.id] : [])));
    for (const id of known.keys()) if (!waiting.has(id)) this.store.setWaitingSince(id, null);
    return out;
  }

  private read(): PlanDoc[] {
    const { docs, dirs } = this.readDocs();
    this.dirs = dirs;
    return docs;
  }

  /**
   * The docs whose projects stand on the canvas: those with a workstream still open; those whose
   * every workstream is ticked, or whose doc is gone (as it last stood), while one of their cards is
   * still at work (in progress, or its worker finishing after the landing); and those whose work is
   * done and whose project the owner has not archived yet (`ended`). A project whose doc went before
   * its work was done (dropped, renamed) has ended without it, as have those the owner archived.
   */
  private openDocs(all: PlanDoc[], rows: CardRow[]): { docs: PlanDoc[]; ended: Set<string> } {
    const busy = new Set(
      rows
        .filter((r) => r.plan_ref?.includes('#') && ((r.state && ACTIVE.includes(r.state)) || (r.landed && r.workspace) || tickedAhead(r)))
        .map((r) => r.plan_ref!.slice(0, r.plan_ref!.indexOf('#'))),
    );
    // the projects on the canvas, as just read: an archived one is not among the rows
    const standing = new Set(rows.flatMap((r) => (r.kind === 'project' && r.plan_ref ? [r.plan_ref] : [])));
    const files = new Set(all.map((d) => d.file));
    const ended = new Set<string>();
    const done = all.filter((d) => allTicked(d) && !busy.has(d.file) && standing.has(d.file));
    for (const d of done) ended.add(d.file);
    const gone = this.projectsOf(rows).flatMap((r) => {
      if (!r.plan || files.has(r.plan_ref!)) return [];
      const doc = fromJson(r.plan);
      if (busy.has(r.plan_ref!)) return [doc];
      if (!standing.has(r.plan_ref!) || !workDone(doc, rows)) return [];
      ended.add(r.plan_ref!);
      return [doc];
    });
    return { docs: [...all.filter((d) => !allTicked(d) || busy.has(d.file) || ended.has(d.file)), ...gone], ended };
  }

  /**
   * The notes on the plan directories: one for each that holds docs which are not projects, and
   * one for a repository with no plan doc that never had a project, saying where the first goes.
   */
  private planDirs(docs: PlanDoc[], rows: CardRow[]): PlanDir[] {
    const projects = this.projectsOf(rows);
    const preparing = rows.filter((r) => !r.plan_ref && r.title && !finished(r.state ?? 'planned'));
    return this.dirs.flatMap(({ repo, dir, others }) => {
      const empty = !others.length && !docs.some((d) => repoOfRef(d.file, this.home) === repo) && !projects.some((p) => repoOfRef(p.plan_ref!, this.home) === repo);
      if (!empty && !others.length) return [];
      return [
        {
          repo,
          dir,
          empty,
          others: others.map((o) => {
            const titles = Object.values(MESSAGES).map((m) => m.preparePlanDoc.title(o.file));
            const card = preparing.find((r) => (r.repo ?? this.home) === repo && titles.includes(r.title!));
            return { ...o, ...(card ? { preparing: card.id } : {}) };
          }),
          ...this.planDirNoteAt(repo),
        },
      ];
    });
  }

  /** The canvas's projects, on the canvas (among its `rows`, as just read) or archived, in the order of their plan references. */
  private projectsOf(rows: CardRow[]): CardRow[] {
    const project = (r: CardRow) => r.kind === 'project' && r.plan_ref !== null;
    return [...rows.filter(project), ...this.archivedPlanRows().filter(project)].sort((a, b) => (a.plan_ref! < b.plan_ref! ? -1 : a.plan_ref! > b.plan_ref! ? 1 : 0));
  }

  /** The cards whose landed work added plan docs, on the canvas (among its `rows`, as just read) or archived, the oldest first. */
  private withPlanDocsOf(rows: CardRow[]): CardRow[] {
    return [...rows, ...this.archivedPlanRows()].filter((r) => r.plan_docs !== null).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
  }

  private archivedPlanRows(): CardRow[] {
    const rev = this.store.archiveRev(this.canvas.id);
    if (this.archivedPlans?.rev !== rev) this.archivedPlans = { rev, rows: this.store.archivedPlans(this.canvas.id) };
    return this.archivedPlans.rows;
  }

  private planDirNoteAt(repo: string): { at?: { x: number; y: number } } {
    const at = this.store.setting(this.canvas.id, `plan_dir_note:${repo}`);
    return at ? { at: JSON.parse(at) as { x: number; y: number } } : {};
  }

  /** The owner moved the note on a repository's plan directory: it stays there, wherever the projects go. */
  movePlanDirNote(repo: string, at: unknown) {
    const { x, y } = (at ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new BadRequest('invalid', 'a place needs x and y');
    if (!this.dirs.some((d) => d.repo === repo)) throw new BadRequest('invalid', 'no plan directory of that repository on the canvas');
    this.store.setSetting(this.canvas.id, `plan_dir_note:${repo}`, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    this.changed();
  }

  /**
   * When the agents that wait for the account's usage limit go on by themselves (ISO time), by
   * `card:<id>` and `talk:<id>`. Held in memory: after a restart they run into the limit again.
   */
  private limits = new Map<string, string>();

  /**
   * The agent of a card (other than its worker), or the one looking up the question of an exchange
   * in the sheet, waits for the usage limit until `until`; nothing once it goes on.
   */
  waitsForLimit(at: { card: string } | { talk: number }, until: number | undefined) {
    const key = 'card' in at ? `card:${at.card}` : `talk:${at.talk}`;
    const iso = until === undefined ? undefined : new Date(until).toISOString();
    if (this.limits.get(key) === iso) return;
    if (iso) this.limits.set(key, iso);
    else this.limits.delete(key);
    this.changed();
  }

  /** Who says which cards' workers are in a turn, each with its background work: one per repository's workers (`showTurns`). */
  private turns = new Set<() => Map<string, WorkerTurn>>();

  /** Who says which cards' workers are in a turn; a worker's turn starts and ends with `changed`, and so does its background work, so the cache holds. */
  showTurns(turns: () => Map<string, WorkerTurn>) {
    this.turns.add(turns);
  }

  /** The repositories' clone pools by machine, as those who run them say (`showPools`). */
  private pools?: () => ClonePool[];

  /**
   * Who says what the clone pools are. Leases change only along with a card (start, stop,
   * landing, a discarded prototype) and a worker's turn starts and ends with `changed`, so the cache holds.
   */
  showPools(pools: () => ClonePool[]) {
    this.pools = pools;
    this.changed();
  }

  /** The repositories' settings a setting proposal shows beside its value, as they apply now (`showSettings`). */
  private settingsNow?: (repo: string) => Record<ProposedSetting, string | string[]> | undefined;

  /** Who says how the repositories' settings stand; saving them reads the plan docs again (`docsChanged`), so the cache holds. */
  showSettings(now: (repo: string) => Record<ProposedSetting, string | string[]> | undefined) {
    this.settingsNow = now;
    this.changed();
  }

  /** The pools, each workspace a card holds with the card's title, also of a card not on the canvas, and the canvas of one on another. */
  private clonePools(): ClonePool[] {
    return (this.pools?.() ?? []).map((p) => ({
      ...p,
      hosts: p.hosts.map((h) => ({
        ...h,
        workspaces: h.workspaces.map((w) => {
          const row = w.card ? this.store.card(w.card) : null;
          if (!row) return w;
          return { ...w, ...(row.title ? { title: row.title } : {}), ...(row.canvas_id !== this.canvas.id ? { canvas: row.canvas_id } : {}) };
        }),
      })),
    }));
  }

  /** The outdated pages, archived cards' included, and the run sharing them again; made anew only once what it is made of changed (`noticeOf`). */
  private reshare(): Reshare | null {
    if (this.notice?.of !== this.noticeOf(this.notice?.repos ?? [])) {
      const rows = this.sharedRows();
      const repos = [...new Set(rows.map((r) => repoOfRow(r, this.home)))];
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
    return JSON.stringify([this.store.shareRev(this.canvas.id), this.setting(RESHARE_SETTING), this.pageInputs(repos)]);
  }

  /**
   * What the notice makes of each shared card's page besides its row: what the owner put away, the
   * theme and vocabulary of tags of the repositories with shared pages, and the look at the demos' files.
   */
  private pageInputs(repos: string[]): string {
    const settings = [RESHARE_DISMISSED, RESHARE_DISMISSED_THEMES].map((k) => this.setting(k));
    const looks = repos.map((id) => ({ id, theme: this.themeOf?.(id), tags: this.vocabularyOf?.(id) }));
    return JSON.stringify([settings, looks, this.looked]);
  }

  /**
   * What each shared card's page adds to the notice of outdated pages, by card, with its row and what
   * else it was made of (`pageInputs`): made again only for a row written since, so a change to one
   * shared card does not go over all of them again.
   */
  private pageNotes: { of: string; notes: Map<string, { r: CardRow; missed: OutdatedBy[] | null; untagged: boolean }> } | null = null;

  private makeReshare(rows: CardRow[], repos: string[]): Reshare | null {
    const run = this.reshareRun();
    const queued = new Set(run?.queue);
    const of = this.pageInputs(repos);
    const had = this.pageNotes?.of === of ? this.pageNotes.notes : new Map();
    const notes = new Map<string, { r: CardRow; missed: OutdatedBy[] | null; untagged: boolean }>();
    let offered: ReturnType<Board['offered']> | undefined;
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

  /**
   * Ideas, and cards that were ideas, with their prototypes, wherever these are: on the canvas or in
   * the archive; a workstream built on a prototype with that one. A prototype knows its idea's
   * title, also once the idea is in the archive.
   */
  private withPrototypes(items: Item[]): Item[] {
    const p = this.prototypes();
    if (!p.rows.length) return items;
    // a prototype among these items is not read again
    const given = new Map(items.flatMap((i) => (i.prototypeOf ? [[i.id, i]] : [])));
    return items.map((i) => {
      const ofIdea = p.ofIdea.get(i.id) ?? [];
      const built = i.parent && i.builtOn ? p.byId.get(i.builtOn) : undefined;
      const rows = built && !ofIdea.includes(built) ? p.rows.filter((r) => r.prototype_of === i.id || r === built) : ofIdea;
      const me = i.prototypeOf ? { ...i, ideaTitle: this.ideaTitle(p, i.prototypeOf) } : i;
      return rows.length ? { ...me, prototypes: rows.flatMap((r) => this.prototypeItem(p, r, given.get(r.id)) ?? []) } : me;
    });
  }

  /**
   * Which cards of the canvas are prototypes, read once per change; each is made into an item when a
   * card first needs it, once per change too: the canvas, the archive and every archived card looked
   * up on its own (sharing looks up hundreds in a row) need them.
   */
  private prototypes(): Prototypes {
    if (this.prototypeItems) return this.prototypeItems;
    const rows = this.store.prototypes(this.canvas.id);
    this.prototypeItems = { rows, ofIdea: Map.groupBy(rows, (r) => r.prototype_of!), byId: new Map(rows.map((r) => [r.id, r])), items: new Map(), titles: new Map() };
    return this.prototypeItems;
  }

  private prototypeItem(p: Prototypes, ref: PrototypeRef, given?: Item): Item | undefined {
    const made = p.items.get(ref.id);
    if (made) return made;
    const row = given ? null : this.store.card(ref.id);
    const item = given ?? (row && toItems([row], [], this.home, undefined, this.themeNow)[0]);
    if (!item) return undefined;
    const prototype = { ...item, ...(ref.archived_at ? { archivedAt: ref.archived_at } : {}), ideaTitle: this.ideaTitle(p, ref.prototype_of!) };
    p.items.set(ref.id, prototype);
    return prototype;
  }

  private ideaTitle(p: Prototypes, ideaId: string): string {
    const title = p.titles.get(ideaId) ?? this.store.card(ideaId)?.title ?? '';
    p.titles.set(ideaId, title);
    return title;
  }

  /** The project an idea became, while it is on the canvas. */
  projectOf(ideaId: string): Item | undefined {
    return this.items().find((i) => i.kind === 'project' && i.origin === ideaId);
  }

  // ---------------------------------------------------------------- preferences

  /** The canvas's preferences in the given states, or all of them (rejected proposals too). */
  preferences(...states: PreferenceState[]) {
    return this.store.preferences(this.canvas.id, states.length ? states : undefined);
  }

  /** The owner's active preferences as agents read them; empty when there are none. */
  preferencesText(): string {
    const p = this.preferences('active');
    return p.length ? `The owner's standing preferences (follow them unless the card says otherwise):\n${p.map((x) => `- ${x.text}`).join('\n')}` : '';
  }

  /** A rule the owner writes: active at once. */
  addPreference(text: string, cardId: string | null = null): number {
    const clean = checkPreference(text);
    const id = this.store.addPreference(this.canvas.id, clean, cardId);
    this.changed();
    return id;
  }

  /**
   * A learned rule, or a learned change to the active rule `replaces`: it waits for the owner. With a
   * `target` it is about that repository and belongs in its CLAUDE.md.
   */
  proposePreference(text: string, occasion: { cardId?: string; quote?: string; review?: boolean }, replaces?: number, target?: string): number {
    const clean = checkPreference(text);
    if (target !== undefined) this.checkRepo(target);
    const id = this.store.addPreference(this.canvas.id, clean, occasion.cardId ?? null, {
      quote: occasion.quote?.trim().slice(0, NOTE_MAX) || undefined,
      review: occasion.review,
      replaces,
      target,
    });
    this.changed();
    return id;
  }

  setPreference(id: number, text: string | null) {
    if (!this.store.setPreference(this.canvas.id, id, text === null ? null : checkPreference(text)))
      throw new BadRequest('unknownPreference', 'unknown preference');
    this.changed();
  }

  /**
   * The owner accepts a proposal, as it is or in their own words; a change takes the place of the
   * rule it changes. `target` sets where it goes when the owner changed that: a repository, or
   * `null` for the preference memory. A rule for a repository goes into its card "Add to
   * CLAUDE.md", which a worker writes it from into the CLAUDE.md; until then it applies to no agent.
   */
  acceptProposal(id: number, text?: string, target?: string | null) {
    const p = this.preferences('proposed').find((x) => x.id === id);
    if (!p) throw new BadRequest('unknownPreference', 'no such proposal');
    const clean = text === undefined ? p.text : checkPreference(text);
    if (target) this.checkRepo(target);
    const repo = target === undefined ? p.target : (target ?? undefined);
    this.store.db.transaction(() => {
      if (clean !== p.text) this.store.setPreference(this.canvas.id, id, clean);
      if (p.replaces !== undefined && this.preferences('active').some((x) => x.id === p.replaces)) this.store.setPreference(this.canvas.id, p.replaces, null);
      this.store.decideProposal(this.canvas.id, id, 'active', repo ?? null);
      if (repo) this.collect(repo, clean);
    })();
    this.changed();
  }

  /**
   * A rule the owner gives outright for the CLAUDE.md of each of `repos`, said („Merk dir: …“) or
   * written in the sheet: it goes into the repository's card "Add to CLAUDE.md" at once, without
   * a proposal. `replaces`: an active rule of the owner's it takes the place of.
   */
  fileRule(text: string, repos: string[], cardId: string | null = null, replaces?: number) {
    const clean = checkPreference(text);
    if (!repos.length) throw new BadRequest('invalid', 'no repository');
    for (const r of repos) this.checkRepo(r);
    this.store.db.transaction(() => {
      if (replaces !== undefined) this.store.setPreference(this.canvas.id, replaces, null);
      for (const repo of new Set(repos)) {
        this.store.fileRule(this.canvas.id, clean, cardId, repo);
        this.collect(repo, clean);
      }
    })();
    this.changed();
  }

  /**
   * Adds an accepted rule to the repository's open card "Add to CLAUDE.md": planned and not yet
   * with the Coordinator. Without one, a new card collects it.
   */
  private collect(repo: string, rule: string) {
    const open = this.collecting(repo);
    if (open) {
      this.store.update(open.id, { body: `${open.body.trimEnd()}\n- ${rule}` });
      this.log(open.id, 'state', 'coordinator', this.t.coordinator.ruleTaken(rule));
      return;
    }
    const card = this.create({ title: this.t.claudeMd.title, body: `${this.t.claudeMd.task}\n\n- ${rule}`, repo, ...this.freeSpot() });
    this.setSetting(`${CLAUDE_MD_SETTING}${repo}`, card.id);
    this.log(card.id, 'state', 'coordinator', this.t.coordinator.ruleTaken(rule));
  }

  /** The repository's card "Add to CLAUDE.md" while it still collects rules, if there is one. */
  collecting(repo: string): Item | undefined {
    const id = this.setting(`${CLAUDE_MD_SETTING}${repo}`);
    const card = id ? this.item(id) : undefined;
    return card && card.state === 'planned' && !card.queue && !card.archivedAt ? card : undefined;
  }

  private checkRepo(repo: string) {
    if (!this.canvas.repos.some((r) => r.id === repo)) throw new BadRequest('invalid', 'unknown repository');
  }

  /** What a card's `repo` column holds for `repo`: nothing for the home repository. */
  private repoColumn(repo: string | undefined): string | null {
    return repo && repo !== this.home ? repo : null;
  }

  /** A card just stored, as the UI sees it. */
  private itemOf(row: CardRow): Item {
    return toItems([row], [], this.home, undefined, this.themeNow)[0]!;
  }

  /** The owner rejects a proposal; it is kept, so the same one does not come back. */
  rejectProposal(id: number) {
    if (!this.store.decideProposal(this.canvas.id, id, 'rejected')) throw new BadRequest('unknownPreference', 'no such proposal');
    this.changed();
  }

  // ---------------------------------------------------------------- groups

  /** Puts the cards into the group, or with `null` into none; a workstream stands for its project. */
  group(cardIds: unknown, groupId: string | null) {
    const ids = this.groupable(cardIds);
    if (groupId !== null) this.ownGroup(groupId);
    this.store.setGroup(ids, groupId);
    this.store.dropEmptyGroups(this.canvas.id);
    this.changed();
  }

  /**
   * A new group with the cards in it, in the colour `hue` or else the first colour no group has. A
   * name a group has already (in any case) puts the cards into that group.
   */
  createGroup(name: unknown, cardIds: unknown, hue?: unknown): Group {
    const n = this.groupName(name);
    const ids = this.groupable(cardIds);
    if (!ids.length) throw new BadRequest('invalid', 'a group needs a card');
    if (hue !== undefined && !(Number.isInteger(hue) && (hue as number) >= 0 && (hue as number) < 360)) throw new BadRequest('invalid', 'hue must be a whole number from 0 to 359');
    const groups = this.store.groups(this.canvas.id);
    const g =
      groups.find((x) => x.name.toLowerCase() === n.toLowerCase()) ??
      this.store.addGroup(this.canvas.id, n, (hue as number | undefined) ?? nextHue(groups.map((x) => x.hue)));
    this.store.setGroup(ids, g.id);
    this.store.dropEmptyGroups(this.canvas.id);
    this.changed();
    return toGroup(g);
  }

  renameGroup(id: string, name: unknown) {
    this.ownGroup(id);
    const n = this.groupName(name);
    if (this.store.groups(this.canvas.id).some((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase()))
      throw new BadRequest('invalid', `there is a group named ${n} already`);
    this.store.renameGroup(id, n);
    this.changed();
  }

  /**
   * Ends the group: its cards, on the canvas and in the archive, belong to none. Returns what
   * `createGroup` needs to bring it back.
   */
  deleteGroup(id: string): { group: Group; cards: string[] } {
    const g = this.ownGroup(id);
    const cards = this.store.groupCards(g.id);
    this.store.setGroup(cards, null);
    this.store.dropEmptyGroups(this.canvas.id);
    this.changed();
    return { group: toGroup(g), cards };
  }

  /** The group a card's new offspring (a proposal, a follow-up, a package, a prototype) goes into. */
  private groupOf(r: CardRow): string | null {
    if (r.group_id) return r.group_id;
    return r.parent_id ? (this.store.card(r.parent_id)?.group_id ?? null) : null;
  }

  /** The cards, each own: workstreams give their project, every card once. */
  private groupable(cardIds: unknown): string[] {
    if (!Array.isArray(cardIds) || !cardIds.every((id) => typeof id === 'string')) throw new BadRequest('invalid', 'cards must be a list of card ids');
    return [...new Set(cardIds.map((id) => this.own(id)).map((r) => r.parent_id ?? r.id))];
  }

  private ownGroup(id: unknown): GroupRow {
    const g = typeof id === 'string' ? this.store.group(id) : null;
    if (!g || g.canvas_id !== this.canvas.id) throw new BadRequest('unknownGroup', 'unknown group');
    return g;
  }

  private groupName(name: unknown): string {
    checkText(name, 'name', 60);
    const n = oneLine(name as string);
    if (!n) throw new BadRequest('emptyText', 'a group needs a name');
    return n;
  }

  /**
   * `elsewhere`: the card on another canvas it follows up on (a card Obeya makes here from there); it
   * goes where `x` and `y` say, in no group.
   */
  create(n: NewCard, elsewhere?: string): Item {
    checkText(n.title, 'title', TITLE_MAX);
    if (n.body !== undefined) checkText(n.body, 'body', BODY_MAX);
    if (n.repo !== undefined) this.checkRepo(n.repo);
    const from = n.from !== undefined ? this.own(n.from) : undefined;
    if (from && n.idea) throw new BadRequest('invalid', 'an idea follows up on no card');
    if (!from) {
      checkNumber(n.x, 'x');
      checkNumber(n.y, 'y');
    }
    const at = from ? this.followUpSpot(from.id) : { x: n.x!, y: n.y! };
    // a follow-up stays in the repository of the card it comes from unless told otherwise
    const repo = n.repo ?? (from ? (from.repo ?? this.home) : undefined);
    if (n.images !== undefined) this.checkImages(n.images);
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: n.idea ? 'idea' : 'planned',
        title: n.title,
        body: n.body ?? '',
        ...at,
        repo: this.repoColumn(repo),
        ...(from ? { from_id: from.id, group_id: this.groupOf(from) } : elsewhere ? { from_id: elsewhere } : {}),
        images: n.images?.length ? toJson(n.images) : null,
        ...(n.idea ? { idea: toJson({ status: 'open', brief: '' }) } : {}),
      },
    ]);
    this.changed();
    return this.itemOf(row!);
  }

  patch(id: string, p: CardPatch) {
    const row = this.own(id);
    const allowed = row.plan_ref ? (row.kind === 'project' ? ['x', 'y', 'collapsed'] : ['x', 'y', 'state', 'need']) : ['x', 'y', 'title', 'body', 'state', 'need', 'repo', 'images', 'newRepo'];
    const bad = Object.keys(p).filter((k) => !allowed.includes(k));
    if (bad.length) throw new BadRequest('invalid', `cannot change ${bad.join(', ')} on this card`);
    if (p.x !== undefined) checkNumber(p.x, 'x');
    if (p.y !== undefined) checkNumber(p.y, 'y');
    if (p.collapsed !== undefined && typeof p.collapsed !== 'boolean') throw new BadRequest('invalid', 'collapsed must be true or false');
    if (p.title !== undefined) checkText(p.title, 'title', TITLE_MAX);
    if (p.body !== undefined) checkText(p.body, 'body', BODY_MAX);
    if (p.images !== undefined) this.checkImages(p.images);
    if (p.state !== undefined && !STATES.includes(p.state)) throw new BadRequest('invalid', `state must be one of ${STATES.join(', ')}`);
    if (p.need !== undefined && p.need !== null && p.need !== 'demo' && p.need !== 'question') throw new BadRequest('invalid', 'need must be demo, question or null');
    const { repo, images, collapsed, newRepo, ...fields } = p;
    if (newRepo !== undefined) this.checkNewRepo(row, newRepo);
    // a planned card of the owner's may become an idea again, to be discussed first
    if (p.state === 'idea' && row.state !== 'idea' && (row.plan_ref || (row.state ?? 'planned') !== 'planned' || row.workspace))
      throw new BadRequest('invalid', 'only a planned card of your own that has not been worked on can become an idea');
    if (repo !== undefined) {
      this.checkRepo(repo);
      // its workspace and branch belong to the repository it started in
      if ((row.state !== 'idea' && (row.state ?? 'planned') !== 'planned') || row.workspace) throw new BadRequest('invalid', 'a card changes repository only before work begins');
    }
    this.store.update(id, {
      ...fields,
      // a repository of the canvas picked instead of a new one: the owner's pick, which the idea's agent leaves
      ...(repo !== undefined ? { repo: this.repoColumn(repo) } : {}),
      ...(newRepo !== undefined || repo !== undefined
        ? { new_repo: toJson(newRepo ? ({ path: newRepo.path.trim(), canvas: newRepo.canvas, by: 'owner' } satisfies NewRepo) : ({ path: '', canvas: true, by: 'owner', none: true } satisfies StoredNewRepo)) }
        : {}),
      ...(images !== undefined ? { images: images.length ? toJson(images) : null } : {}),
      ...(collapsed !== undefined ? { collapsed: collapsed ? 1 : 0 } : {}),
    });
    this.changed();
  }

  private checkNewRepo(row: CardRow, n: unknown) {
    if (n !== null && (typeof n !== 'object' || typeof (n as NewRepo).path !== 'string' || typeof (n as NewRepo).canvas !== 'boolean'))
      throw new BadRequest('invalid', 'newRepo must be { path, canvas } or null');
    if (n && (n as NewRepo).path.length > 1000) throw new BadRequest('invalid', 'the path is too long');
    if (row.prototype_of || (row.state !== 'idea' && (row.state ?? 'planned') !== 'planned') || row.workspace)
      throw new BadRequest('invalid', 'a card gets a new repository only before work on it begins');
    if (this.newRepo(row.id)?.due) throw new BadRequest('newRepoDue', 'the new repository is being made');
  }

  /** The repository to create for a card, as stored (`StoredNewRepo`); none where there is none. */
  newRepo(id: string): StoredNewRepo | null {
    return fromJson(this.store.card(id)?.new_repo ?? null);
  }

  /**
   * The repository to create for a card, as its idea's agent or Obeya sets it; null takes it off.
   * What the owner chose, the agent does not change: false then.
   */
  setNewRepo(id: string, n: StoredNewRepo | null, by: NewRepo['by'] = 'owner'): boolean {
    const was = this.newRepo(id);
    // what the owner picked stands, and a repository about to be made stays as it was clicked
    if (by === 'agent' && ((was?.by === 'owner' && !was.made) || was?.due)) return false;
    this.store.update(id, { new_repo: n && toJson(n) });
    this.changed();
    return true;
  }

  /** The owner's history of the canvas, in Obeya's sheet: the card left for another canvas. */
  moved(m: TalkMoved) {
    this.store.addMoved(this.canvas.id, m, this.t.newRepo.movedAway(m.title, m.canvasName));
    this.changed();
  }

  /**
   * Merges tasks into the first (`keep`), titled `title`; the caller checks they may be merged and
   * removes the others. Their texts go in unchanged, each a section under its old title, with their
   * screenshots and the owner's notes they held. What followed up on them, and review findings that
   * linked them, now point at the first.
   */
  merge(keep: string, others: string[], title: string) {
    const first = this.own(keep);
    const rest = others.map((id) => this.own(id));
    const section = (r: CardRow) => `## ${r.title ?? ""}\n\n${r.body ?? ''}`.trim();
    const body = [first, ...rest].map(section).filter(Boolean).join('\n\n');
    checkText(body, 'the merged text', BODY_MAX);
    const list = (r: CardRow) => (fromJson(r.images) ?? []);
    const images = [...new Set([first, ...rest].flatMap(list))];
    const notes = [first, ...rest].flatMap((r) => (fromJson(r.unheard) ?? []));
    const gone = new Set(others);
    // started ones waiting in the queue: the merged task waits for what any of them waited for, in the place of the one queued first
    const queued = [first, ...rest].map(waitOf).filter((q) => !!q);
    const merged = (ids: string[]) => [...new Set(ids)].filter((id) => id !== keep && !gone.has(id));
    const behind = merged(queued.flatMap((q) => q.behind));
    const buildsOn = merged(queued.flatMap((q) => q.buildsOn ?? []));
    const manualWait = merged(queued.flatMap((q) => q.manualWait ?? []));
    const queue = behind.length ? toJson<Queue>({ behind, reason: queued[0]!.reason, ...(buildsOn.length && { buildsOn }), ...(manualWait.length && { manualWait }), since: queued.map((q) => q.since).sort()[0]! }) : null;
    this.store.update(keep, { title, body, images: images.length ? toJson(images) : null, ...(notes.length ? { unheard: toJson(notes) } : {}), ...(queue ? { queue } : {}) });
    for (const r of this.store.cards(this.canvas.id)) {
      if (r.from_id && gone.has(r.from_id) && r.id !== keep) this.store.update(r.id, { from_id: keep });
      // a card that waited for one that goes waits for the merged task instead
      const w = r.id === keep ? undefined : waitOf(r);
      if (w?.behind.some((id) => gone.has(id))) {
        const to = (ids: string[]) => [...new Set(ids.map((id) => (gone.has(id) ? keep : id)))];
        // a card it waited for by an inferred wait stays waited for so, also where an arrow named another merged into it
        const inferred = to(w.behind.filter((id) => !w.manualWait?.includes(id)));
        const manualWait = to(w.manualWait ?? []).filter((id) => !inferred.includes(id));
        this.store.update(r.id, { queue: toJson({ ...w, behind: to(w.behind), ...(w.buildsOn && { buildsOn: to(w.buildsOn) }), manualWait: manualWait.length ? manualWait : undefined }) });
      }
      const c = fromJson(r.contribution);
      if (c?.findings?.some((f) => f.card && gone.has(f.card))) this.store.update(r.id, { contribution: toJson({ ...c, findings: c.findings.map((f) => (f.card && gone.has(f.card) ? { ...f, card: keep } : f)) }) });
    }
    this.log(keep, 'state', 'obeya', this.t.voice.merged(rest.map((r) => r.title ?? '')));
    this.changed();
  }

  /** Manual cards only; a plan card goes away with its workstream. */
  remove(id: string) {
    if (this.own(id).plan_ref) throw new BadRequest('planCard', 'plan cards are removed in the plan doc');
    this.store.update(id, { deleted_at: new Date().toISOString() });
    this.changed();
  }

  restore(id: string) {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id) throw new BadRequest('unknownCard', 'unknown card');
    this.store.update(id, { deleted_at: null });
    this.changed();
    this.backOnCanvas(id);
  }

  /** A card deleted or archived is back: its arrows too, but none that the arrows drawn meanwhile would make a cycle. */
  private backOnCanvas(id: string) {
    const items = this.items();
    const edges = this.manualDependencies();
    const kept = edges.filter(([a, b]) => a !== id && b !== id);
    for (const [a, b] of edges) if ((a === id || b === id) && !closesCycle(a, b, kept, items)) kept.push([a, b]);
    if (kept.length !== edges.length) this.setManualDependencies(kept);
  }

  private checkImages(ids: unknown) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new BadRequest('invalid', 'images must be a list of image ids');
    this.images?.resolve(ids);
  }

  private own(id: string): CardRow {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id || row.deleted_at) throw new BadRequest('unknownCard', 'unknown card');
    return row;
  }

  /**
   * Keeps each doc's last state on its project. A project whose doc is gone, or whose work is done
   * (not among the `open` docs, which keep it while a workstream's worker finishes after its landing),
   * goes into the archive; one whose doc is back, or open again, returns to the canvas.
   */
  private keepDocs(all: PlanDoc[], open: PlanDoc[]) {
    const byFile = new Map(all.map((d) => [d.file, d]));
    const shown = new Set(open.map((d) => d.file));
    const at = new Date().toISOString();
    this.store.db.transaction(() => {
      for (const r of this.store.projects(this.canvas.id)) {
        const doc = byFile.get(r.plan_ref!);
        const plan = doc ? toJson<PlanDoc>(doc) : r.plan;
        const archived_at = shown.has(r.plan_ref!) ? null : (r.archived_at ?? at);
        if (r.plan !== plan || r.archived_at !== archived_at) this.store.update(r.id, { plan, archived_at });
        // a workstream the doc rewrote, ticked off or put in review changed, as an edit of a card does
        const before = r.plan && doc && r.plan !== plan ? fromJson(r.plan) : null;
        for (const w of doc?.workstreams ?? []) {
          const was = before?.workstreams.find((x) => x.key === w.key);
          if (was && (was.title !== w.title || was.body !== w.body || was.done !== w.done || was.inReview !== w.inReview)) this.store.touch(this.canvas.id, `${r.plan_ref}#${w.key}`);
        }
      }
    })();
  }

  /** What the Coordinator read of a project's plan doc about which workstream builds on which, and whether it is reading it now. */
  deps(projectId: string): StoredDeps & { current: boolean } {
    // the project keeps its doc as the canvas last read it
    this.items();
    const row = this.own(projectId);
    if (row.kind !== 'project' || !row.plan) throw new BadRequest('invalid', 'not a project');
    const d = fromJson(row.deps) ?? {};
    return { ...d, current: !!d.on && d.sig === depsSig(fromJson(row.plan)) };
  }

  /**
   * The projects whose plan doc the Coordinator is to read for which workstream builds on which
   * (`arranging` on the canvas), from their rows: asked on every change, this builds no snapshot.
   */
  arranging(): string[] {
    return this.store.projectDeps(this.canvas.id).flatMap((r) => (r.deps && fromJson(r.deps).reading ? [r.id] : []));
  }

  /** The Coordinator starts reading which workstream builds on which (`reading`), or has read it (`on`, for the doc as it stands now). */
  setDeps(projectId: string, d: { reading: NonNullable<StoredDeps['reading']> } | { on: Record<string, string[]> } | { failed: true }) {
    const row = this.own(projectId);
    const was = fromJson(row.deps) ?? {};
    const next: StoredDeps =
      'reading' in d ? { ...was, reading: d.reading } : 'on' in d ? { sig: depsSig(fromJson(row.plan!)), on: d.on } : { ...was, reading: undefined };
    this.store.update(projectId, { deps: toJson(next) });
    this.changed();
  }

  /** The workstream key of each of the project's workstreams, by card. */
  workstreamKeys(projectId: string): Map<string, string> {
    return new Map(this.store.children([projectId]).flatMap((k) => (k.plan_ref?.includes('#') ? [[k.id, k.plan_ref.slice(k.plan_ref.indexOf('#') + 1)]] : [])));
  }

  /** Whether none of the project's workstreams stands anywhere but where it was placed when the project came (`placeNew`). */
  untouched(projectId: string): boolean {
    const row = this.own(projectId);
    const doc = fromJson(row.plan!);
    const first = placeWorkstreams(doc.workstreams);
    const kids = this.store.children([projectId]);
    return kids.every((k) => {
      const n = doc.workstreams.findIndex((w) => `${doc.file}#${w.key}` === k.plan_ref);
      return n >= 0 && first[n]!.x === k.x && first[n]!.y === k.y;
    });
  }

  /**
   * Puts the project's workstreams in columns by what builds on what (`arrangeWorkstreams`). A
   * project that grows into another card or project moves to the nearest spot clear of everything.
   */
  arrange(projectId: string) {
    const items = this.items();
    const project = items.find((i) => i.id === projectId);
    if (project?.kind !== 'project') throw new BadRequest('invalid', 'not a project on the canvas');
    const kids = items.filter((i) => i.parent === projectId);
    const at = arrangeWorkstreams(kids);
    const moved = kids.map((k) => ({ ...k, ...at.get(k.id)! }));
    const [w, h] = projectSize(moved, project.title);
    const others = items.filter((i) => !i.parent && i.id !== projectId).map((i) => boundsOf(i, items));
    const overlaps = others.some((b) => project.x < b.x + b.w && b.x < project.x + w && project.y < b.y + b.h && b.y < project.y + h);
    this.store.db.transaction(() => {
      for (const k of moved) this.store.update(k.id, { x: k.x, y: k.y });
      if (overlaps) this.store.update(projectId, freeSpotNear(project, [w, h], others));
    })();
    this.changed();
  }

  /** Every workstream a plan doc has had, from its history in git, the newest first (`readPlanHistory`); none for a doc outside git. */
  private planHistory?: (ref: string) => Promise<Workstream[]>;
  /**
   * Each doc's history as read for the doc's text then (`markdown`) and the read tree then (`at`,
   * which `readTreeMoved` counts on); `past` is missing while git reads it.
   */
  private histories = new Map<string, { markdown: string; at: number; past?: Workstream[] }>();
  private readTreeAt = 0;

  /** Who reads a plan doc's history: a card whose workstream left the doc gets its title from there. */
  readPlanHistory(fn: (ref: string) => Promise<Workstream[]>) {
    this.planHistory = fn;
  }

  /**
   * What the history of the doc as it reads now says. Read once per text of the doc and read tree,
   * without the server waiting: until git is through, this throws `HistoryUnread`, and the plan
   * docs are read again (`docsChanged`) once it is.
   */
  private past(doc: PlanDoc): Workstream[] {
    if (!this.planHistory) return [];
    const was = this.histories.get(doc.file);
    if (was?.markdown === doc.markdown && was.at === this.readTreeAt) {
      if (was.past) return was.past;
      throw new HistoryUnread();
    }
    const reading: { markdown: string; at: number; past?: Workstream[] } = { markdown: doc.markdown, at: this.readTreeAt };
    this.histories.set(doc.file, reading);
    this.planHistory(doc.file)
      .catch(() => [])
      .then((past) => {
        // the doc or the read tree moved on meanwhile: what the cards wait for is read anew
        if (this.histories.get(doc.file) !== reading) return;
        reading.past = past;
        this.docsChanged();
      });
    throw new HistoryUnread();
  }

  /** The docs whose projects' repair waits for their history: they stand as last read until it is there (`follow`). */
  private heldBack = new Set<string>();
  /** Cards whose workstream left its doc, by when that was seen, that wait to leave their project (`follow`). */
  private missing = new Map<string, number>();
  /** Looks at the waiting cards again once the first of them may leave. */
  private waking?: ReturnType<typeof setTimeout>;

  /**
   * Keeps each workstream card with its own workstream. A card whose workstream the doc gives
   * another key now (a sibling dropped or added, `workstreamAliases`) moves onto it. A card whose
   * workstream the doc no longer lists, while the doc is there, leaves the project once an agent
   * worked on it, with its log, as a card of its own (`leave`); one nobody worked on just goes from
   * view. It remembers what the workstream was right away, and leaves only once it holds no
   * workspace it is not at work in, and, for a doc in a plan folder outside the repository, which
   * is written in place, once the workstream stayed away for `LEAVE_AFTER_MS`. With `read` (the docs
   * were read again), a project read before workstreams had keys of their own (`#n`, their place in
   * the doc) moves its cards onto those keys first (`rekey`). Between reads, only waiting cards
   * bring it here.
   */
  private follow(all: PlanDoc[], read: boolean): PlanDoc[] {
    if (!read && !this.missing.size) return all;
    const byFile = new Map(all.map((d) => [d.file, d]));
    const projects = this.store.projects(this.canvas.id).filter((p) => byFile.has(p.plan_ref!));
    // the doc as last read, with its whole text: only parsed where a card needs it
    const lastOf = new Map<string, PlanDoc | null>();
    const last = (p: CardRow) => (lastOf.has(p.id) ? lastOf.get(p.id)! : lastOf.set(p.id, fromJson(p.plan)).get(p.id)!);
    // a project whose repair waits for its doc's history keeps the doc as last read until it is there,
    // also for the passes between reads, whose docs are the ones this pass returns
    if (read) this.heldBack = new Set(projects.filter((p) => last(p) && !this.rekey(p, last(p)!, byFile.get(p.plan_ref!)!)).map((p) => p.plan_ref!));
    const kidsOf = Map.groupBy(this.store.children(projects.map((p) => p.id)), (k) => k.parent_id!);
    const waiting = new Set<string>();
    const now = Date.now();
    for (const p of projects) {
      if (this.heldBack.has(p.plan_ref!)) continue;
      const doc = byFile.get(p.plan_ref!)!;
      const kids = kidsOf.get(p.id) ?? [];
      const keys = new Set(doc.workstreams.map((w) => w.key));
      const holderOf = new Map(kids.flatMap((k) => (keys.has(keyOfRef(k.plan_ref) ?? '') ? [[keyOfRef(k.plan_ref)!, k] as const] : [])));
      for (const k of kids) {
        const key = keyOfRef(k.plan_ref);
        if (key === null || keys.has(key)) continue;
        // what the workstream was: in the doc as last read, else as the card remembered it
        const known = last(p)?.workstreams.find((x) => x.key === key);
        const w = sameWorkstream(key, doc, known ?? (k.title ? { title: k.title } : undefined));
        const holder = w && holderOf.get(w.key);
        // a card nobody worked on gives way to the one with the workstream's log
        if (w && (!holder || (!worked(holder) && worked(k)))) {
          if (holder) {
            this.store.replan(holder.id, `${p.plan_ref}#\u0000${holder.id}`, p.id);
            this.store.update(holder.id, { deleted_at: new Date().toISOString() });
          }
          this.store.replan(k.id, `${doc.file}#${w.key}`, p.id);
          holderOf.set(w.key, k);
          this.missing.delete(k.id);
          continue;
        }
        if (!worked(k)) continue;
        if (known) this.remember(k, known);
        const since = this.missing.get(k.id) ?? now;
        // a stopped card gives its workspace back first, as a workstream no longer in the doc does (`leaseEnded`);
        // a doc written in place may lack an item only while it is being edited
        if ((k.workspace && !atWork(k)) || (outsideRef(doc.file) && now - since < LEAVE_AFTER_MS)) {
          waiting.add(k.id);
          this.missing.set(k.id, since);
          continue;
        }
        const was = unreadAs(() => this.identity(k, doc, last(p), false));
        // what the workstream was waits for the doc's history: the card waits with it
        if (!was) {
          waiting.add(k.id);
          this.missing.set(k.id, since);
          continue;
        }
        this.leave(k, p, was, this.t.idea.leftGone(doc.title));
      }
    }
    for (const id of this.missing.keys()) if (!waiting.has(id)) this.missing.delete(id);
    clearTimeout(this.waking);
    const next = Math.min(...[...this.missing.values()].map((t) => t + LEAVE_AFTER_MS - now).filter((ms) => ms > 0));
    if (Number.isFinite(next)) {
      this.waking = setTimeout(() => this.changed(), next + 50);
      this.waking.unref?.();
    }
    if (!read || !this.heldBack.size) return all;
    const kept = new Map(projects.flatMap((p) => (this.heldBack.has(p.plan_ref!) ? [[p.plan_ref!, last(p)!] as const] : [])));
    return all.map((d) => kept.get(d.file) ?? d);
  }

  /** The card keeps what its workstream was (`w`), for when it leaves the project after the doc is read again. */
  private remember(row: CardRow, w: Pick<Workstream, 'label' | 'title' | 'body'>) {
    const title = w.label ? `${w.label} ${w.title}` : w.title;
    if (row.title !== title || row.body !== w.body) this.store.update(row.id, { title, body: w.body });
  }

  /**
   * Moves the project's cards from the keys an older Obeya gave its workstreams (their place in
   * the doc, `#n`) onto the keys they have now. A card an agent worked on goes by the title its
   * branch was named after, since the doc may have changed under its old key, so that its log stays
   * with its own workstream; one whose workstream the doc no longer has leaves the project, and the
   * project lays out afresh in the doc's order, with fresh cards for the workstreams without one.
   * Otherwise the cards keep their places. Returns false, changing nothing, while what it needs of
   * the doc's history is still being read.
   */
  private rekey(project: CardRow, before: PlanDoc, doc: PlanDoc): boolean {
    const again = parsePlanDoc(before.file, before.markdown);
    if ('reason' in again || again.workstreams.length !== before.workstreams.length) return true;
    const renamed = new Map(before.workstreams.flatMap((w, i) => (w.key !== again.workstreams[i]!.key ? [[w.key, again.workstreams[i]!.key] as const] : [])));
    if (!renamed.size) return true;
    const kids = this.store.children([project.id]);
    const keys = new Set(doc.workstreams.map((w) => w.key));
    // positional keys of a doc read before this one, whose cards are out of view now
    const positional = (k: string) => renamed.has(k) || (/^#\d+$/.test(k) && !before.workstreams.some((w) => w.key === k));
    const moving = kids.filter((k) => positional(keyOfRef(k.plan_ref) ?? ''));
    if (!moving.length) return true;
    const claimed = new Set(kids.filter((k) => !moving.includes(k)).flatMap((k) => keyOfRef(k.plan_ref) ?? []));
    const to = new Map<string, string>();
    const leaving: CardRow[] = [];
    const started = new Map(moving.map((k) => [k.id, this.startedAs(k)]));
    // first the cards an agent worked on, the most recent first, by the workstream they were started on
    const order = [...moving].sort((a, b) => Number(!started.get(a.id)) - Number(!started.get(b.id)) || b.updated_at.localeCompare(a.updated_at));
    // what the cards worked on, decided before anything changes: the doc's history may still be read
    const was = unreadAs(() => {
      for (const k of order) {
        const slug = started.get(k.id);
        const key = slug ? this.startedOn(slug, doc, claimed, again) : renamed.get(keyOfRef(k.plan_ref)!);
        if (key && keys.has(key) && !claimed.has(key)) {
          to.set(k.id, key);
          claimed.add(key);
        } else if (worked(k)) leaving.push(k);
      }
      return new Map(leaving.map((k) => [k.id, this.identity(k, doc, before, true)]));
    });
    if (!was) return false;
    const ref = (key: string) => `${doc.file}#${key}`;
    this.store.db.transaction(() => {
      // out of each other's way first: two cards may swap keys
      for (const k of moving) this.store.replan(k.id, `${project.plan_ref}#\u0000${k.id}`, project.id);
      for (const k of moving) {
        const key = to.get(k.id);
        if (key) this.store.replan(k.id, ref(key), project.id);
        // nobody worked on it: it goes, and the workstream gets a card of its own; its reference stays
        // one of no card, so that nothing reads it as a card of the owner's they deleted
        else if (!leaving.includes(k)) this.store.update(k.id, { deleted_at: new Date().toISOString() });
      }
      for (const k of leaving) {
        const w = was.get(k.id)!;
        if ((atWork(k) || !k.workspace) && !outsideRef(doc.file)) this.leave(k, project, w, this.t.idea.leftOther(doc.title));
        // a stopped card gives its workspace back first, and a doc outside the repository may lack an item
        // only for a moment: it leaves later (`follow`), with what it remembers
        else {
          this.store.replan(k.id, `${project.plan_ref}#~${k.id.slice(0, 6)}`, project.id);
          this.remember(k, w);
        }
      }
      // cards left, others get fresh ones: the project lays out afresh in the doc's order, which the mix-up had broken anyway
      if (leaving.length) {
        const rows = new Map(this.store.children([project.id]).flatMap((k) => (keyOfRef(k.plan_ref) ? [[keyOfRef(k.plan_ref)!, k] as const] : [])));
        const at = placeWorkstreams(doc.workstreams.map((w) => ({ done: w.done || finished(rows.get(w.key)?.state ?? 'planned') })));
        doc.workstreams.forEach((w, i) => {
          const row = rows.get(w.key);
          if (row) this.store.update(row.id, at[i]!);
          else this.store.insert([{ canvas_id: this.canvas.id, kind: 'task', parent_id: project.id, plan_ref: ref(w.key), ...at[i]! }]);
        });
      }
      // what the Coordinator read of which workstream builds on which goes with the cards
      const deps = fromJson(project.deps);
      if (deps?.on) {
        const keyOf = new Map(moving.flatMap((k) => (to.has(k.id) ? [[keyOfRef(k.plan_ref)!, to.get(k.id)!] as const] : [])));
        const on = Object.fromEntries(
          Object.entries(deps.on).flatMap(([k, by]) => {
            const key = keyOf.get(k) ?? (positional(k) ? undefined : k);
            return key ? [[key, by.flatMap((b) => keyOf.get(b) ?? (positional(b) ? [] : [b]))]] : [];
          }),
        );
        this.store.update(project.id, { deps: toJson({ ...deps, on }) });
      }
    })();
    return true;
  }

  /**
   * The key of the doc's workstream an agent started on under the title its branch was named after
   * (`slug`), among those no card has yet (`claimed`): by that title, or, where the doc reworded it
   * since, by the label the doc as Obeya last kept it (`stored`, read anew) or the doc's history gave
   * that title.
   */
  private startedOn(slug: string, doc: PlanDoc, claimed: Set<string>, stored: PlanDoc): string | undefined {
    const free = doc.workstreams.filter((w) => !claimed.has(w.key));
    const byTitle = free.find((w) => named(w, slug));
    if (byTitle) return byTitle.key;
    const label =
      stored.workstreams.find((w) => w.label && named(w, slug))?.label ??
      this.past(doc).find((w) => w.label && named(w, slug))?.label;
    const same = label ? free.filter((w) => w.label === label) : [];
    return same.length === 1 && doc.workstreams.filter((w) => w.label === label).length === 1 ? same[0]!.key : undefined;
  }

  /** The title of the card the agent last started on, as its branch has it (`branchName`); none for a card never started. */
  private startedAs(row: CardRow): string | null {
    const short = row.id.slice(0, 6);
    const at = new RegExp(`${CARD_BRANCH}([a-z0-9-]+)-${short}`);
    const slug = at.exec(row.branch ?? '')?.[1] ?? at.exec(this.store.branchMention(row.id) ?? '')?.[1] ?? null;
    // a title without a Latin letter or digit names its branch `card`, which tells no workstream apart
    return slug === 'card' ? null : slug;
  }

  /**
   * The workstream a card worked on, from the doc as last read (`before`), what the card remembered
   * of it (`remember`) or the history of the doc (`doc`, as it reads now): by its key, or, for a
   * card whose key was its place in the doc (`positional`), by the title its branch was named after.
   */
  private identity(row: CardRow, doc: PlanDoc, before: PlanDoc | null, positional: boolean): Pick<Workstream, 'label' | 'title' | 'body'> {
    const key = keyOfRef(row.plan_ref) ?? '';
    const slug = this.startedAs(row);
    const past = () => this.past(doc);
    // what the card remembered when its workstream left the doc (`remember`)
    const kept = () => (!positional && row.title ? { title: row.title, body: row.body ?? '' } : undefined);
    const byKey = () => (positional ? undefined : (before?.workstreams.find((w) => w.key === key) ?? kept() ?? past().find((w) => w.key === key)));
    const bySlug = () => (slug ? (before?.workstreams.find((w) => named(w, slug)) ?? past().find((w) => named(w, slug))) : undefined);
    const byPlace = () => (positional && !slug ? before?.workstreams.find((w) => w.key === key) : undefined);
    return byKey() ?? bySlug() ?? byPlace() ?? { title: slug ? slug.replace(/-/g, ' ') : key, body: '' };
  }

  /**
   * The card leaves its project as a card of its own, its log saying so (`why`), with the title and
   * text of the workstream it worked on (`w`). Finished, it goes into the archive; otherwise it
   * stands beside the project.
   */
  private leave(row: CardRow, project: CardRow, w: Pick<Workstream, 'label' | 'title' | 'body'>, why: string) {
    // a workstream planned again after part of it landed is done now that the doc asks no more of it
    const state = row.state === 'planned' && row.shipped ? 'live' : (row.state ?? 'planned');
    const done = finished(state) && !atWork(row);
    const at = done ? { x: row.x, y: row.y } : this.besideProject(project);
    this.store.replan(row.id, null, null);
    this.store.update(row.id, {
      title: w.label ? `${w.label} ${w.title}` : w.title,
      body: w.body,
      state,
      repo: repoOfRef(project.plan_ref!, this.home),
      group_id: project.group_id,
      ...at,
      ...(done ? { archived_at: new Date().toISOString() } : {}),
    });
    this.log(row.id, 'state', 'obeya', why);
  }

  /** A free spot for a card at the right of the project, near its top. */
  private besideProject(project: CardRow): { x: number; y: number } {
    const items = toItems(this.store.cards(this.canvas.id), this.docs ?? [], this.home);
    const p = items.find((i) => i.id === project.id);
    if (!p) return { x: project.x, y: project.y };
    const box = boundsOf(p, items);
    return freeSpotNear({ x: box.x + box.w + GAP, y: box.y }, CARD_SIZE.task, items.filter((i) => !i.parent).map((i) => boundsOf(i, items)));
  }

  /**
   * Stores a row for every project and workstream seen for the first time. A doc whose work was
   * done before Obeya first saw it (among `all`, not `docs`) gets its rows too, placed after the
   * others, and goes straight to the archive (`keepDocs`). Returns whether any were added.
   */
  private placeNew(docs: PlanDoc[], items: Item[], all: PlanDoc[], rows: CardRow[]): boolean {
    const byRef = new Map(rows.filter((r) => r.plan_ref).map((r) => [r.plan_ref!, r]));
    const add: NewRow[] = [];
    const c = this.canvas.id;

    for (const doc of docs) {
      const project = byRef.get(doc.file);
      if (!project) continue;
      const missing = doc.workstreams.filter((w) => !byRef.has(`${doc.file}#${w.key}`));
      if (!missing.length) continue;
      const kids = items.filter((i) => i.parent === project.id);
      const startY = kids.length ? Math.max(...kids.map((k) => k.y + sizeOf(k, items)[1])) + GAP : PROJECT_HEAD;
      placeWorkstreams(missing, startY).forEach((pos, n) =>
        add.push({ canvas_id: c, kind: 'task', parent_id: project.id, plan_ref: `${doc.file}#${missing[n]!.key}`, ...pos }),
      );
    }
    if (add.length) this.store.insert(add);
    // the workstreams just added are no projects, and linking one to its origin changes no plan reference
    const linked = this.linkOrigins(docs, rows);

    const known = new Set(this.projectsOf(rows).map((r) => r.plan_ref!));
    const done = all.filter((d) => !docs.includes(d) && !known.has(d.file));
    const fresh = [...docs.filter((d) => !byRef.has(d.file)), ...done];
    if (!fresh.length) return add.length > 0 || linked;
    const layouts = fresh.map((d) => {
      const pos = placeWorkstreams(d.workstreams);
      const kids = pos.map((p, n) => ({ kind: 'task' as const, state: d.workstreams[n]!.done ? ('live' as const) : ('planned' as const), parent: 'p', ...p }));
      return { doc: d, pos, size: projectSize(kids, d.title) };
    });
    const top = items.filter((i) => !i.parent);
    // below a note the owner put there too
    const notes = this.planDirs(all, rows).flatMap((d) => planDirNoteBox(d) ?? []);
    const at = placeProjects(unionBounds([...top.map((i) => boundsOf(i, items)), ...notes]), layouts.map((l) => l.size));
    layouts.forEach(({ doc, pos }, n) => {
      const [project] = this.store.insert([{ canvas_id: c, kind: 'project', plan_ref: doc.file, ...at[n]! }]);
      // a project just come stands arranged by what builds on what, once the Coordinator has read that
      if (docs.includes(doc) && doc.workstreams.filter((w) => !w.done).length > 1) this.store.update(project!.id, { deps: toJson({ reading: 'auto' }) });
      this.store.insert(
        doc.workstreams.map((w, k) => ({ canvas_id: c, kind: 'task' as const, parent_id: project!.id, plan_ref: `${doc.file}#${w.key}`, ...pos[k]! })),
      );
    });
    this.linkOrigins(docs, this.store.cards(this.canvas.id));
    return true;
  }

  /**
   * A project whose doc the landed work of an idea (or a task planned as a project) added remembers
   * that card and takes its place, while the card is on the canvas. Returns whether any did.
   */
  private linkOrigins(docs: PlanDoc[], rows: CardRow[]): boolean {
    const origin = new Map<string, string>();
    // a card writing its doc in a plan folder outside the repository names it from the start: it is its origin once approved
    for (const r of this.withPlanDocsOf(rows)) if (r.landed || r.state === 'live' || r.state === 'done') for (const ref of fromJson(r.plan_docs!)) origin.set(ref, r.id);
    if (!origin.size) return false;
    let linked = false;
    for (const r of this.projectsOf(rows)) {
      const from = !r.from_id ? origin.get(r.plan_ref!) : undefined;
      if (!from) continue;
      this.store.update(r.id, { from_id: from });
      this.takePlace(r.id, from, docs);
      this.retire(from);
      linked = true;
    }
    return linked;
  }

  /**
   * The project goes where its idea is on the canvas. What the larger project would cover moves
   * aside by as much as it outgrows the idea: the cards below it down, those beside it to the right.
   */
  private takePlace(projectId: string, ideaId: string, docs: PlanDoc[]) {
    const items = toItems(this.store.cards(this.canvas.id), docs, this.home, undefined, this.themeNow);
    const project = items.find((i) => i.id === projectId);
    const idea = items.find((i) => i.id === ideaId);
    if (!project || !idea) return;
    const [iw, ih] = sizeOf(idea, items);
    const [pw, ph] = sizeOf(project, items);
    const moves: [string, { x: number; y: number }][] = [[project.id, { x: idea.x, y: idea.y }]];
    for (const i of items) {
      if (i.parent || i.id === project.id || i.id === idea.id) continue;
      const b = boundsOf(i, items);
      if (ph > ih && b.y >= idea.y + ih && b.x < idea.x + pw && b.x + b.w > idea.x) moves.push([i.id, { x: i.x, y: i.y + ph - ih }]);
      else if (pw > iw && b.x >= idea.x + iw && b.y < idea.y + ph && b.y + b.h > idea.y) moves.push([i.id, { x: i.x + pw - iw, y: i.y }]);
    }
    this.store.db.transaction(() => moves.forEach(([id, at]) => this.store.update(id, at)))();
    // the project stands for the idea in its group too
    if (idea.group && !project.group) this.store.setGroup([project.id], idea.group);
  }

  /**
   * An idea or task whose plan doc is a project goes to the archive once its worker is done: the project
   * stands where it was and links it. Asked when the project is linked and when the worker is done,
   * once each; put back on the canvas, the idea stays. Returns whether it went.
   */
  private retire(ideaId: string): boolean {
    const r = this.store.card(ideaId);
    // `done`: approved without a change, its doc written in a plan folder outside the repository
    if (!r || r.deleted_at || r.archived_at || (r.state !== 'live' && r.state !== 'done') || (r.landed && r.workspace)) return false;
    if (!this.store.projects(this.canvas.id).some((p) => p.from_id === ideaId && !p.archived_at)) return false;
    this.store.update(ideaId, { archived_at: new Date().toISOString() });
    this.log(ideaId, 'state', 'obeya', r.idea ? this.t.idea.becameProject : this.t.idea.taskBecameProject);
    return true;
  }
}

/**
 * The repository a plan reference belongs to: `<repo>:<path>` for the canvas's other repositories,
 * a bare path for its home repository. The path is in the repository, or an absolute one of a plan
 * folder outside it (`/…`, or `C:/…` on Windows, which is no repository `C`).
 */
export function repoOfRef(ref: string, home: string): string {
  const m = REPO_PREFIX.exec(ref);
  return m ? m[1]! : home;
}

/** The repository a card belongs to, by its id: the one it names, else its plan doc's, else the home repository. */
export const repoOfRow = (r: CardRow, home: string): string => r.repo ?? (r.plan_ref ? repoOfRef(r.plan_ref, home) : home);

/** A plan reference's path, without the repository before it. */
export function pathOfRef(ref: string): string {
  return ref.replace(REPO_PREFIX, '');
}

const REPO_PREFIX = /^(?![A-Za-z]:\/)([\w.-]+):/;
/** A plan reference's path in a plan folder outside the repository: absolute, `/…` or `C:/…`. */
const OUTSIDE_PATH = /^(\/|[A-Za-z]:\/)/;

/** Whether the work of a project's doc is done: each workstream ticked, or its card (among `rows`) finished. */
function workDone(doc: PlanDoc, rows: Pick<CardRow, 'plan_ref' | 'state'>[]): boolean {
  const states = new Map(rows.flatMap((r) => (r.plan_ref?.startsWith(`${doc.file}#`) && r.state ? [[r.plan_ref, r.state]] : [])));
  return doc.workstreams.every((w) => {
    const state = states.get(`${doc.file}#${w.key}`);
    return w.done || (!!state && finished(state));
  });
}

/**
 * A workstream card with work not landed yet that a box in a plan folder outside the repository says
 * nothing of: the worker ticks it there at once, in no commit, so it may be ticked while the card is
 * in its pull request (before it is even open) or stopped with its branch.
 */
function tickedAhead(r: Pick<CardRow, 'plan_ref' | 'state' | 'branch'>): boolean {
  if (!r.plan_ref || !OUTSIDE_PATH.test(pathOfRef(r.plan_ref))) return false;
  return r.state === 'inPr' || (r.state === 'planned' && !!r.branch);
}

/** The canvas's prototypes for one change of the board: which cards they are, the items made of them so far, their ideas' titles. */
type Prototypes = {
  rows: PrototypeRef[];
  ofIdea: Map<string, PrototypeRef[]>;
  byId: Map<string, PrototypeRef>;
  items: Map<string, Item>;
  titles: Map<string, string>;
};
type PrototypeRef = Pick<CardRow, 'id' | 'prototype_of' | 'archived_at'>;

/** Visible items: projects first, their workstreams in doc order, then manual cards. */
export function toItems(rows: CardRow[], docs: PlanDoc[], home: string, worked?: Worked, themeNow?: ThemeNow): Item[] {
  const work = (r: CardRow) => workOf(r, worked, themeNow);
  const docByFile = new Map(docs.map((d) => [d.file, d]));
  // a project's group covers its workstreams
  const groupOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.group_id ? [[r.id, r.group_id]] : [])));
  // what each workstream builds on, by its project's reading of the doc
  const depsOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.deps ? [[r.id, fromJson(r.deps)]] : [])));
  const idOfRef = new Map(rows.flatMap((r) => (r.plan_ref ? [[r.plan_ref, r.id]] : [])));
  const projects: Item[] = [];
  const workstreams: { item: Item; order: number }[] = [];
  const manual: Item[] = [];
  for (const r of rows) {
    if (!r.plan_ref) {
      manual.push({
        id: r.id,
        short: r.short,
        number: r.number,
        kind: r.kind,
        state: r.state ?? 'planned',
        ...(r.need ? { need: r.need } : {}),
        title: r.title ?? '',
        body: r.body ?? '',
        x: r.x,
        y: r.y,
        source: 'manual',
        repo: r.repo ?? home,
        changedAt: r.changed_at,
        ...work(r),
        ...(r.state === 'idea' ? { idea: ideaOf(r) } : r.idea ? decided(r) : {}),
        ...(r.thread ? { thread: threadOf(r) } : {}),
        ...(r.becomes_project ? { becomesProject: true } : {}),
        ...(r.prototype_of ? { prototypeOf: r.prototype_of, ...prototypeOf(r) } : {}),
        ...(r.built_on ? { builtOn: r.built_on, ...(r.session_id ? {} : { unstarted: true as const }) } : {}),
        ...(r.images ? { images: fromJson(r.images) } : {}),
        ...(r.retro ? { retro: r.retro } : {}),
        ...(r.proposal ? (r.state === 'proposal' ? { proposal: fromJson(r.proposal)! } : { proposed: true as const, ...supersededOf(r) }) : {}),
        ...(r.group_id ? { group: r.group_id } : {}),
        ...newRepoOf(r),
      });
      continue;
    }
    const hash = r.plan_ref.indexOf('#');
    const doc = docByFile.get(hash < 0 ? r.plan_ref : r.plan_ref.slice(0, hash));
    if (!doc) continue;
    if (hash < 0) {
      projects.push({
        id: r.id,
        short: r.short,
        number: r.number,
        kind: 'project',
        state: 'planned',
        title: doc.title,
        body: '',
        x: r.x,
        y: r.y,
        source: 'plan',
        repo: repoOfRef(doc.file, home),
        changedAt: r.changed_at,
        plan: { file: doc.file, goal: doc.goal },
        ...(depsOf.get(r.id)?.reading ? { arranging: true as const } : {}),
        ...(r.collapsed ? { collapsed: true } : {}),
        ...(r.from_id ? { origin: r.from_id } : {}),
        ...(r.group_id ? { group: r.group_id } : {}),
        ...(r.spent ? { spent: r.spent } : {}),
      });
      continue;
    }
    const key = r.plan_ref.slice(hash + 1);
    const order = doc.workstreams.findIndex((w) => w.key === key);
    const w = doc.workstreams[order];
    if (!w || !r.parent_id) continue;
    const derived = w.done ? 'live' : w.inReview ? 'inPr' : 'planned';
    // work in progress wins over the doc: a ticked-off workstream may still wait for its merge, and so
    // does a stopped one whose box a plan folder outside the repository ticked
    const state = r.state && (ACTIVE.includes(r.state) || tickedAhead(r)) ? r.state : derived === 'live' ? 'live' : (r.state ?? derived);
    // what landed of a workstream planned again, also while a new run does the rest; once that lands, the card is live
    const shipped = state === 'planned' || ACTIVE.includes(state) ? fromJson(r.shipped) : null;
    const buildsOn = (depsOf.get(r.parent_id)?.on?.[key] ?? []).flatMap((k) => idOfRef.get(`${doc.file}#${k}`) ?? []);
    workstreams.push({
      order,
      item: {
        id: r.id,
        short: r.short,
        number: r.number,
        kind: r.kind,
        state,
        ...(r.need ? { need: r.need } : {}),
        title: w.title,
        body: w.body,
        x: r.x,
        y: r.y,
        parent: r.parent_id,
        source: 'plan',
        repo: repoOfRef(r.plan_ref, home),
        changedAt: r.changed_at,
        ...(w.label ? { label: w.label } : {}),
        ...work(r),
        ...(shipped ? { landedPart: { ...(shipped.commit ? { commit: shipped.commit } : {}), ...(shipped.pr ? { pr: shipped.pr } : {}) } } : {}),
        ...(r.built_on ? { builtOn: r.built_on, ...(r.session_id ? {} : { unstarted: true as const }) } : {}),
        ...(buildsOn.length ? { buildsOn } : {}),
        ...(groupOf.get(r.parent_id) ? { group: groupOf.get(r.parent_id)! } : {}),
      },
    });
  }
  const shown = new Set(projects.map((p) => p.id));
  const kids = workstreams.filter((w) => shown.has(w.item.parent!));
  const ordered = projects.flatMap((p) =>
    kids
      .filter((k) => k.item.parent === p.id)
      .sort((a, b) => a.order - b.order)
      .map((k) => k.item),
  );
  return [...projects, ...ordered, ...manual];
}

/** How long a workstream stays away from a doc in a plan folder outside the repository before its card leaves the project: such a doc is written in place, an item moved in two edits. */
export const LEAVE_AFTER_MS = 5 * 60_000;

/** A plan doc's history that `follow` needs is being read in git (`Board.past`). */
class HistoryUnread extends Error {}

/** What `fn` gives; undefined while the plan doc's history it needs is being read. */
function unreadAs<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HistoryUnread) return undefined;
    throw e;
  }
}

/** Whether a plan reference is to a doc in a plan folder outside the repository. */
const outsideRef = (ref: string) => OUTSIDE_PATH.test(pathOfRef(ref));

/**
 * The doc's workstream that a card keyed `key` had under another key: the doc dropped or added a
 * sibling, which changes whether a code is read as a label or a label needs its title. Where it is
 * known what the workstream was (`was`), the one with its label and title (a label alone may be
 * another's now); else the only one that would have had `key`.
 */
function sameWorkstream(key: string, doc: PlanDoc, was?: Pick<Workstream, 'label' | 'title'>): Workstream | undefined {
  const its = was ? workstreamAliases(was, true) : [];
  const same = doc.workstreams.filter((w) => (was ? workstreamAliases(w).some((k) => its.includes(k)) : workstreamAliases(w).includes(key)));
  return same.length === 1 ? same[0] : undefined;
}

/** The workstream key of a plan reference (`<doc>#<key>`); null for a project's or a card's without one. */
const keyOfRef = (ref: string | null): string | null => (ref?.includes('#') ? ref.slice(ref.indexOf('#') + 1) : null);

/** Whether an agent worked on the card: it was started, or its work landed or ended. */
const worked = (r: CardRow) => !!(r.session_id || r.branch || r.shipped || r.landed || (r.state && r.state !== 'planned'));

/** Whether an agent is at work on the card: in progress, or finishing after the landing. */
const atWork = (r: CardRow) => !!((r.state && ACTIVE.includes(r.state)) || (r.landed && r.workspace));

/** Whether a branch named after a title (`branchName`, its `slug`) was named after the workstream's, with or without its label before it. */
const named = (w: Pick<Workstream, 'label' | 'title'>, slug: string) =>
  [w.title, withoutReference(w.title), ...(w.label ? [`${w.label} ${w.title}`] : [])].some((t) => branchName(t, '000000').slice(CARD_BRANCH.length, -7) === slug);

/** Where a card goes below the card with bounds `b`: the `n`th of those there, each beside the one before. */
const below = (b: Bounds, n = 0) => ({ x: b.x + 35 + n * (CARD_SIZE.task[0] + GAP), y: b.y + b.h + 60 });

/** A card's new repository while it is still to be made, before work on the card begins. */
function newRepoOf(r: CardRow): Pick<Item, 'newRepo'> {
  const n = fromJson(r.new_repo);
  if (!n || n.made || n.none || (r.state !== 'idea' && (r.state ?? 'planned') !== 'planned') || r.workspace) return {};
  const { made: _, ...newRepo } = n;
  return { newRepo };
}

/** What `toItems` made of cards' rows: the fields a worker adds, by card, with the row they came from. */
type Worked = Map<string, { row: CardRow; work: Partial<Item> }>;

/** The fields a worker adds to the card, as `worked` holds them while its row is the same. */
function workOf(r: CardRow, worked?: Worked, themeNow?: ThemeNow): Partial<Item> {
  const had = worked?.get(r.id);
  if (had && sameRow(had.row, r)) return had.work;
  const made = work(r, themeNow);
  worked?.set(r.id, { row: r, work: made });
  return made;
}

const sameRow = (a: CardRow, b: CardRow) => {
  for (const k in b) if (a[k as keyof CardRow] !== b[k as keyof CardRow]) return false;
  return true;
};

/** A pull request of the card as the card shows it. */
const pullRequest = (pr: PrState): PullRequest => ({
  url: pr.url!,
  number: pr.number!,
  ...(pr.repo ? { repo: pr.repo } : {}),
  ...(pr.merged ? { merged: true } : {}),
  ...(pr.closed ? { closed: true } : {}),
  checks: pr.checks ?? [],
  conflict: !!pr.conflictHead,
  ...(pr.readyHead && (pr.mergeError || pr.held || pr.manual) ? { ready: true, ...(pr.mergeError ? { mergeError: pr.mergeError } : {}), ...(pr.held ? { held: pr.held } : {}), ...(pr.manual ? { manual: true } : {}) } : {}),
  ...(pr.waits?.length && !pr.merged && !pr.closed ? { waits: pr.waits } : {}),
  ...(pr.review?.length ? { review: pr.review } : {}),
});

/** The fields a worker adds to a card. */
function work(r: CardRow, themeNow?: ThemeNow): Partial<Item> {
  const detail = fromJson(r.detail) ?? {};
  const demo = r.demo ? shownDemo(fromJson(r.demo)) : undefined;
  const earlier = demo ? earlierDemos(r) : [];
  const handed = r.need === 'review' || r.need === 'demo';
  const answering = detail.answering && handed;
  const scope = fromJson(r.scope)?.files;
  const pr = fromJson(r.pr) ?? undefined;
  const contribution = fromJson(r.contribution);
  const share = shareOf(r, themeNow);
  const notOnApproval = fromJson(r.share)?.notOnApproval;
  const tags = demo && !r.prototype_of ? pageTagsOf(r) : {};
  const landed = fromJson(r.landed);
  return {
    ...(scope?.length ? { scope } : {}),
    ...(r.queue && (r.state ?? 'planned') === 'planned' ? { queue: fromJson(r.queue) } : {}),
    ...(pr?.url ? { pr: pullRequest(pr) } : {}),
    ...(pr?.more?.some((m) => m.url) ? { morePrs: pr.more.filter((m) => m.url).map(pullRequest) } : {}),
    ...(contribution ? { contribution: { url: contribution.url, number: contribution.number, author: contribution.author, title: contribution.title, canModify: contribution.canModify, ...(contribution.results ? { results: contribution.results } : {}), ...(contribution.findings ? { findings: contribution.findings } : {}), ...(contribution.requested ? { requested: contribution.requested } : {}), ...(contribution.held ? { held: { body: contribution.held.body, commits: contribution.held.commits, asks: contribution.held.asks } } : {}), ...(contribution.clash ? { clash: contribution.clash } : {}) } } : {}),
    ...(r.status_line ? { statusLine: r.status_line } : {}),
    ...(detail.question && r.need === 'question' ? { question: detail.question } : {}),
    // a demo's question is as open as a worker's: the owner answers it on the card or by voice
    ...(demo?.question && !demo.answer && r.need === 'demo' ? { question: { text: demo.question, options: demo.options ?? [], ...(demo.multiple ? { multiple: true } : {}), ...(demo.pick ? { pick: demo.pick } : {}) } } : {}),
    ...(detail.summary && handed ? { summary: detail.summary } : {}),
    ...(answering ? { answering: true } : {}),
    ...(detail.answered && !answering && handed ? { answered: true } : {}),
    ...(r.held ? { held: fromJson(r.held).map((h) => h.id) } : {}),
    // approved work is held for its next handover while the card is at work or asks the owner; on a waiting card it is landing
    ...(r.approved_at && r.state === 'waiting' && r.need !== 'question' ? { landing: true } : {}),
    ...(demo ? { demo } : {}),
    ...(earlier.length ? { demos: earlier } : {}),
    ...(r.files ? { files: fromJson(r.files) } : {}),
    ...(r.change_size ? { changeSize: fromJson(r.change_size) } : {}),
    ...(share ? { share } : {}),
    ...(notOnApproval ? { notOnApproval } : {}),
    ...(Object.keys(tags).length ? { tags } : {}),
    ...(r.from_id ? { from: r.from_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
    // a workspace on another machine as ssh and scp write it
    ...(r.workspace ? { workspace: r.workspace.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(r.kept_in ? { keptIn: r.kept_in.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(landed && (r.workspace || landed.needsClone) ? { finishing: true, ...(landed.followUp && !landed.resolve ? { followUp: true } : {}), ...(landed.needsClone && !r.workspace ? { waitsForClone: true } : {}) } : {}),
    ...(detail.noChange && handed ? { noChange: true } : {}),
    ...(detail.lands && handed ? { lands: detail.lands } : {}),
    ...(r.paused ? { paused: true } : {}),
    ...(r.pausing && !r.paused ? { pausing: true } : {}),
    ...(r.snoozed ? { snoozed: fromJson(r.snoozed) } : {}),
    ...(r.app && r.workspace && !r.parked ? { app: r.app } : {}),
    ...(r.session_id && r.model ? { runsOn: { harness: sessionHarness(r.session_id), model: r.model, ...(r.effort ? { effort: r.effort as AgentEffort } : {}) } } : {}),
    ...(r.agent ? { agent: cardAgentOf(r.agent) } : {}),
    ...(r.spent ? { spent: r.spent } : {}),
  };
}

/** The card's shared page as the UI sees it: none when it is not shared and not about to be. */
function shareOf(r: CardRow, themeNow?: ThemeNow): Item['share'] {
  const s = fromJson(r.share);
  if (!s || (!s.state && !s.url)) return undefined;
  // asked of a page at rest alone, so the cards never shared ask nothing
  const theme = s.url && !s.state ? themeNow?.(r) : undefined;
  // the newest demo of a handover: drafts shown with a question since are not what the page lacks
  const latest = r.demo ? [...(fromJson(r.demos) ?? []), fromJson(r.demo)].findLast((d) => !d.asked) : undefined;
  const shared = s.url ? sharedDemos(s) : [];
  // the card's demos on the page, by their handovers
  const on = cardDemos(r).flatMap((d) => (d.handover !== undefined && shared.some((x) => sameDemo(x, d)) ? [d.handover] : []));
  const stale = !!s.url && !!latest && !shared.some((x) => sameDemo(x, latest));
  const outdated = reshareable(r, theme);
  return {
    state: s.refresh ? 'shared' : (s.state ?? 'shared'),
    ...(s.url ? { url: s.url } : {}),
    ...(on.length ? { on } : {}),
    ...(stale ? { stale: true } : {}),
    // shown with each version on the page; the latest, not on it, brings the changes with "Replace on the page" or "Add to the page"
    ...(outdated.length ? { outdated } : {}),
    ...(s.personal && s.token ? { unlisted: true as const } : {}),
  };
}

/**
 * A proposal's text with its questions, once the owner took it: those they picked options for as
 * decided, the others as still open, for the agent that takes the card on.
 */
export function withQuestions(text: string, questions: Question[], picks: string[][], t: Messages): string {
  const chosen = (i: number) => (picks[i] ?? []).filter((o) => questions[i]!.options.includes(o));
  const decided = questions.flatMap((q, i) => (chosen(i).length ? [`- ${q.text} → ${chosen(i).join(', ')}`] : []));
  const open = questions.flatMap((q, i) => (chosen(i).length ? [] : [`- ${q.text}${q.options.length ? ` (${q.options.join(' / ')})` : ''}`]));
  return [text.trim(), decided.length ? `${t.decided}:\n${decided.join('\n')}` : '', open.length ? `${t.openQuestions}:\n${open.join('\n')}` : '']
    .filter(Boolean)
    .join('\n\n');
}

/** A prototype's end and proposal; an ended one keeps the summary it was handed over with. */
function prototypeOf(r: CardRow): Partial<Item> {
  const p = fromJson(r.prototype) ?? {};
  const summary = p.end && r.detail ? fromJson(r.detail).summary : undefined;
  return { ...(p.variant ? { variant: p.variant } : {}), ...(p.end ? { prototypeEnd: p.end } : {}), ...(p.into ? { builtInto: p.into } : {}), ...(p.proposal && !p.end ? { buildProposal: p.proposal } : {}), ...(summary ? { summary } : {}) };
}

/** The owner's words said one after the other while a proposal was reworked, as one rework's. */
const merged = (said: Revising[]): Revising => ({
  words: said.map((r) => r.words).join('\n\n'),
  ...(said.some((r) => r.spoken) ? { spoken: true } : {}),
  said: said.flatMap((r) => r.said ?? []),
  ...(said.some((r) => r.images?.length) ? { images: said.flatMap((r) => r.images ?? []) } : {}),
});

/** The mark of an accepted proposal its agent withdrew or replaced, while the card is not finished. */
const supersededOf = (r: CardRow): { superseded?: Superseded } => {
  const superseded = fromJson(r.proposal)?.superseded;
  return superseded && !r.archived_at && !finished(r.state ?? 'planned') ? { superseded } : {};
};

/** A title as an agent may name it: without case, quotes, markdown marks or extra spaces. */
export const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[„“”"'‚‘’«»*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** What became of an agent's own proposal it withdrew or replaced (`Board.retract`). */
export type Retracted =
  /** gone: it was still open and went; marked: accepted, it carries the mark now; finished: done or archived, it stays; dismissed: the owner had dismissed it; removed: the owner had deleted it; already: withdrawn before. */
  | { kind: 'gone' | 'marked' | 'finished' | 'dismissed' | 'removed' | 'already'; title: string; state: CardState }
  /** No proposal of the agent's has that title: those it has. */
  | { kind: 'unknown'; mine: { title: string; state: CardState; gone: boolean }[] };

/** A proposal as an agent made it: whether it is an idea, why, and at most five questions. */
const proposalOf = (p: { reason?: string; idea?: boolean; questions?: Question[]; startAt?: string }): Proposal => ({
  ...(p.idea ? { idea: true } : {}),
  ...(p.reason?.trim() ? { reason: p.reason.trim().slice(0, NOTE_MAX) } : {}),
  questions: (p.questions ?? []).slice(0, 5),
  ...(p.startAt ? { startAt: p.startAt } : {}),
});

const toDecision = (d: DecisionRow): Decision => ({ id: d.id, cardId: d.card_id, question: d.question, answer: d.answer, by: d.by, at: d.at });

/** A card that was an idea, as decided: the brief with its mocks. */
function decided(r: CardRow): Pick<Item, 'brief' | 'mocks'> {
  const i = fromJson(r.idea!);
  return { brief: i.brief, ...(i.mocks?.length ? { mocks: i.mocks } : {}) };
}

function threadOf(r: CardRow): Thread {
  const t = fromJson(r.thread!);
  return { talk: t.talk, ...(t.thinking ? { thinking: true } : {}), answers: t.answers, files: t.files };
}

function ideaOf(r: CardRow): Idea {
  const i = r.idea ? fromJson(r.idea) : { status: 'open' as const, brief: '' };
  return { status: i.status, brief: i.brief, thinking: !!i.thinking, ...(i.buildAfterReply ? { buildAfterReply: true as const } : {}), yourTurn: !!i.yourTurn, questions: i.questions ?? [], ...(i.next ? { next: i.next } : {}), variants: i.variants ?? [], mocks: i.mocks ?? [], ...(i.split ? { split: i.split } : {}) };
}

function checkPreference(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500) throw new BadRequest('emptyText', 'a preference is a non-empty string of at most 500 characters');
  return v.trim();
}

const toGroup = (g: GroupRow): Group => ({ id: g.id, name: g.name, hue: g.hue });

/** Group colours, apart from each other and from the states' colours on the cards; then the golden angle. */
const HUES = [200, 28, 150, 280, 345, 55, 175, 100];
export function nextHue(used: number[]): number {
  const free = HUES.find((h) => !used.includes(h));
  return free ?? Math.round((used.length * 137.508) % 360);
}

function checkText(v: unknown, name: string, max: number) {
  if (typeof v !== 'string' || v.length > max) throw new BadRequest('invalid', `${name} must be a string of at most ${max} characters`);
}

function checkNumber(v: unknown, name: string) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest('invalid', `${name} must be a finite number`);
}

/** A card the owner may draw dependencies to and from: not a project nor one of its workstreams. */
const connectable = (i: Item) => i.source !== 'plan' && i.kind !== 'project';

/**
 * Whether an arrow from `from` to `to` would close a cycle with the arrows between the cards shown
 * (`edges`; a deleted or archived card's count for nothing) and the waits Obeya inferred.
 */
function closesCycle(from: string, to: string, edges: [string, string][], items: Item[]): boolean {
  const shown = new Set(items.map((i) => i.id));
  const all = [
    ...edges.filter(([a, b]) => shown.has(a) && shown.has(b)),
    ...items.flatMap((i): [string, string][] => [...(i.buildsOn ?? []), ...(i.queue && 'behind' in i.queue ? i.queue.behind : []), ...(i.snoozed?.on ? [i.snoozed.on.card] : [])].map((before) => [before, i.id])),
  ];
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === from) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return all.some(([a, b]) => a === id && visit(b));
  };
  return visit(to);
}
