// The canvas of one repository: stored cards merged with what the plan docs say.
//
// Plan docs are read, never written. Their projects and workstreams get a stored row the first
// time they appear, so the owner's placement survives; title, text and state always come from the
// doc. Each read keeps the doc's last state on its project: when the doc goes, the project goes
// into the archive with it, and comes back to its place when the doc returns. A workstream that
// leaves its doc stays stored but is not shown.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { arrangeWorkstreams, type Bounds, boundsOf, CARD_SIZE, freeSpotNear, GAP, type Place, PROJECT_HEAD, placeProjects, planDirNoteBox, placeWorkstreams, projectSize, sizeOf, unionBounds } from '../core/layout';
import type { CardFile } from '../core/files';
import type { Language } from '../core/locale';
import { MESSAGES, type Messages, snoozeTerm } from '../core/messages';
import { type KnownChange, missedChanges, PAGE_CHANGES, pagesVersion } from '../core/page-changes';
import { pageTags, untagged } from '../core/page-tags';
import { allTicked, type OtherDoc, type PlanDoc } from '../core/plan-doc';
import {
  type AnswerFile,
  type CanvasInfo,
  type CanvasSnapshot,
  type CardEvent,
  type CardPatch,
  type ClonePool,
  type Contribution,
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
  type Mock,
  type NewCard,
  type NewRepo,
  type TalkMoved,
  type PreferenceState,
  type ProposedSetting,
  type SettingProposal,
  type SettingProposalState,
  type PrReviewEntry,
  type ProjectHistory,
  type Proposal,
  type Superseded,
  type CardState,
  type Revising,
  type NextStep,
  type PlannedPrototype,
  type SettledPart,
  type Question,
  type PlanDir,
  type Reshare,
  type TalkQuote,
  type TalkAfter,
  type TalkRef,
  type Thread,
  isTalkRef,
  STATES,
  finished,
  formatQuestion,
  needsYou,
  plannedToStart,
  type Notice,
  type WorkerTurn,
} from '../core/types';
import type { CardRow, DecisionRow, Friction, FrictionNote, GroupRow, HeldTalk, Mark, NewRow, RowUpdate, Store, TalkWaitRow } from './db';
import type { Images } from './images';
import { clip, messageOf, oneLine } from '../core/text';
import type { Wish } from '../core/wish';

/** What Obeya keeps about a card's pull request; `url` is null until the worker opened it. */
export interface PrState {
  url: string | null;
  number?: number;
  /** Comments already passed to the worker. */
  seen: string[];
  /** `check@commit` of failures already passed to the worker. */
  reported: string[];
  /** The commit a conflict was last reported for. */
  conflictHead?: string;
  /** The commit the worker was last told its reviewers have not seen. */
  staleHead?: string;
  /** A review card waiting for the contributor: the PR's head when it began to wait, and the one the worker was last told was pushed. */
  headSeen?: string;
  pushedHead?: string;
  /** The commit the PR was found ready to merge at; gone once something is left to do again. */
  readyHead?: string;
  /** Why the forge refused Obeya's merge of the ready PR: then the owner merges. */
  mergeError?: string;
  /** Since when reading the PR fails, and whether the card said why; gone once it reads again. */
  readError?: { since: number; shown?: boolean };
  /** A ready PR's reviewer confidence too low for Obeya to merge it: the owner decides. */
  held?: { score: string; by: string };
  /** A ready PR the repository's settings leave to the people on the forge to merge (`autoMerge` off). */
  manual?: true;
  checks?: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  /** The review as last seen, for the card. */
  review?: PrReviewEntry[];
}

/** What is stored of a review card's pull request (`CardRow.contribution`): what the card shows, and what only the server needs. */
export interface StoredContribution extends Contribution {
  /** The PR's head commit the worker reviewed at its latest handover: only that one is merged. */
  reviewed?: string;
  /** Where the PR's branch is, for a worker that pushes onto it: its repository's URL and branch. */
  headRepo?: string;
  headRef?: string;
  /** The owner approved: the demo's page is linked in a comment on the PR once it is online. */
  approved?: true;
  /** The page's address Obeya linked in a comment on the PR. */
  linked?: string;
  /** The PR was closed without a merge, and the owner was asked whether the card can go. */
  closed?: true;
}

/** A review card's pull request as the card shows it. */
export const contributionOf = (r: Pick<CardRow, 'contribution'>): StoredContribution | null => (r.contribution ? (JSON.parse(r.contribution) as StoredContribution) : null);

/** What a card's work landed with (`CardRow.shipped`); it stays after the worker is done. */
export interface Shipped {
  /** The commit on the default branch that holds the work; none while it is not known (`fetch`). */
  commit?: string;
  /**
   * Where the work's diff starts, so `base..commit` is what it changed: the default branch before it
   * landed, or a merge commit's first parent (`<commit>^`). None where that is not known (a merge
   * GitHub did not name).
   */
  base?: string;
  /** Merged as a pull request: that one. */
  pr?: { url: string; number: number };
  /** The merge commit is not known: the Lesestand's commit after the next fetch stands in for it. */
  fetch?: true;
}

/**
 * Which workstream of a project builds on which (`CardRow.deps`), as the Koordinator read it from
 * the plan doc: `on` by workstream key, for the doc's workstreams as they stood then (`sig`,
 * `depsSig`). `reading` while it reads them: `auto` for a project just come, which it arranges by
 * them unless the owner moved one of its cards first; `owner` when they asked to arrange it.
 */
export interface StoredDeps {
  sig?: string;
  on?: Record<string, string[]>;
  reading?: 'auto' | 'owner';
}

/** The workstreams of a plan doc as what builds on what is read from them: a reading holds while this is the same. */
export const depsSig = (doc: PlanDoc) =>
  createHash('sha256')
    .update(JSON.stringify(doc.workstreams.map((w) => [w.key, w.title, w.body])))
    .digest('hex')
    .slice(0, 16);

/** A demo version on a card's shared page, with what the page says of it, so it can be published again as it is. */
export interface SharedDemo {
  /** The handover it came with (`Demo.handover`): which of the card's demos it is. */
  handover?: number;
  /** When that handover was: a later version's section on the page is headed with it. */
  at?: string;
  /** The demo's directory. */
  dir: string;
  shown: { title: string; text: string; chapters: [number, string][]; kind: DemoKind };
}

/** Which of a card's demos a share means: by its handover, or by its directory where one of the two has no handover. */
export type DemoRef = { handover?: number; dir: string };

/** Whether two references name the same demo of a card. */
export const sameDemo = (a: DemoRef, b: DemoRef) => (a.handover !== undefined && b.handover !== undefined ? a.handover === b.handover : a.dir === b.dir);

/** What Obeya keeps about a card's shared demo page (share.ts): one page per card, holding one or more of its demo versions. */
export interface StoredShare {
  /** The page's name on the site; it stays with the card, so its link keeps working. */
  slug: string;
  /** While published or withdrawn; none when at rest. */
  state?: 'publishing' | 'withdrawing';
  /** The published page. */
  url?: string;
  /** The demo versions on the published page, in order of handover: the first on top, each later one below as an addendum. */
  demos?: SharedDemo[];
  /** Before a page held several versions (until 2026-10-16): the one demo it showed, read as a list of one (`sharedDemos`). */
  dir?: string;
  shown?: SharedDemo['shown'];
  /** While `publishing` without `refresh`: the versions the page is to show, as the owner chose them. */
  next?: DemoRef[];
  /** The pull request the published page links. */
  pr?: string;
  /** Without a pull request: the address of the commit (or the comparison over the commits) the published page links. */
  commit?: string;
  /** While `publishing`: the page goes out again as it is, now with the PR's link; the card shows it as shared meanwhile. */
  refresh?: true;
  /** The newest page change (page-changes.ts) when it was published, '' before any: the changes after it are what sharing again brings. */
  version?: string;
  /** While `publishing` (with `refresh`): the page goes out again as it is, one of many the owner shares again at once. */
  again?: true;
  /** While `publishing` (with `refresh`): the page goes out again as it is, with the tags the owner set. */
  retag?: true;
  /** The owner unticked „Mit der Freigabe teilen“: where the site publishes on approval, approving the card shares nothing. */
  notOnApproval?: true;
  /** The page's tags the owner set by hand, by dimension: neither a worker nor the reading session changes them. */
  tags?: PageTags;
  /** The page's tags the reading session chose, by dimension, where neither the owner nor a worker had (`pageTagsOf`). */
  auto?: PageTags;  /** The page is on the owner's personal site (unlisted), not on its repository's. */
  personal?: true;
  /** The random part of the page's address on the personal site (`<token>/<slug>`): drawn once for the card, so its link stays. */
  token?: string;
}

/**
 * The tags of a card's page, each dimension from the first that has it: the owner's by hand, the
 * newest demo whose worker gave it, the reading session's. They belong to the page, not to a version.
 */
export function pageTagsOf(r: CardRow): PageTags {
  const s = r.share ? (JSON.parse(r.share) as StoredShare) : null;
  const demos = [...storedDemos(r), ...(r.demo ? [JSON.parse(r.demo) as StoredDemo] : [])].reverse();
  return pageTags([s?.tags, ...demos.map((d) => d.page?.tags), s?.auto]);
}

/** The demo versions on a stored page, in order of handover. */
export const sharedDemos = (s: StoredShare): SharedDemo[] => s.demos ?? (s.dir && s.shown ? [{ dir: s.dir, shown: s.shown }] : []);

/** The file that shows a demo is there: its video, or its artifact's page. */
export const demoThere = (d: { dir: string; kind: DemoKind }) => existsSync(join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4'));

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

/** The changes since a stored page was published that show on its kinds of page (a video, an artifact, or both on one page); none while it is not at rest. */
export function missedBy(s: StoredShare): KnownChange[] {
  if (!s.url || s.state) return [];
  const kinds = new Set(sharedDemos(s).map((d) => d.shown.kind));
  if (!kinds.size) kinds.add('video');
  const missed = new Set([...kinds].flatMap((k) => missedChanges(s.version, k, PAGE_CHANGES)));
  return PAGE_CHANGES.filter((c) => missed.has(c));
}

/** A demo as a card keeps it (`CardRow.demo`, and each of `CardRow.demos`). */
export type StoredDemo = Demo & { dir: string };

/** A demo as the UI gets it: without its directory, and saying whether a video has a poster. */
const shownDemo = ({ dir, ...d }: StoredDemo): Demo => (d.kind !== 'html' && !existsSync(join(dir, 'poster.jpg')) ? { ...d, noPoster: true } : d);

const storedDemos = (r: CardRow): StoredDemo[] => (r.demos ? (JSON.parse(r.demos) as StoredDemo[]) : []);

/**
 * The card's earlier demos the owner can still go back to: their files are on disk (demos are
 * deleted to free space) and no later demo was rendered into the same directory over them.
 */
function earlierDemos(r: CardRow): EarlierDemo[] {
  const all = storedDemos(r);
  const later = (i: number) => [...all.slice(i + 1).map((d) => d.dir), ...(r.demo ? [(JSON.parse(r.demo) as StoredDemo).dir] : [])];
  return all.flatMap((d, n) => (!later(n).includes(d.dir) && existsSync(join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4')) ? [{ ...shownDemo(d), n }] : []));
}

/**
 * The changes a page at rest lacks, where its demo is still at hand to share it again: the one on
 * the card, or the one it showed, kept with the share, and its files still on disk (demos are
 * deleted to free space; a page whose files are gone stays as it is, with nothing to offer).
 */
export function reshareable(r: CardRow): KnownChange[] {
  const s = r.share ? (JSON.parse(r.share) as StoredShare) : null;
  const missed = s ? missedBy(s) : [];
  const demos = s ? sharedDemos(s) : [];
  if (!missed.length || !demos.length || !demos.every((d) => demoThere({ dir: d.dir, kind: d.shown.kind }))) return [];
  return missed;
}

/**
 * The card's demos a page may show, the oldest first: its earlier ones that are still at hand (as
 * `earlierDemos` says), then the one on the card.
 */
export function cardDemos(r: CardRow): StoredDemo[] {
  const all = storedDemos(r);
  const latest = r.demo ? (JSON.parse(r.demo) as StoredDemo) : null;
  const later = (i: number) => [...all.slice(i + 1).map((d) => d.dir), ...(latest ? [latest.dir] : [])];
  return [...all.filter((d, i) => !later(i).includes(d.dir) && demoThere(d)), ...(latest ? [latest] : [])];
}

/** States a worker or the owner's decision is still part of. */
export const ACTIVE: string[] = ['working', 'waiting', 'inPr', 'approved'];

/** Exchanges with the Koordinator its sheet shows. */
const SHEET_TALK = 30;

/** The setting that names the card collecting accepted rules for a repository's CLAUDE.md, per repository. */
const CLAUDE_MD_SETTING = 'claude_md_card:';

/** The setting that names the card filling in a repository's settings, proposed by Obeya or made in the Konfiguration dialog, per repository: Obeya proposes it once. */
const SETUP_CARD_SETTING = 'setup_card:';

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

/** What the owner can reply to: the messages of a conversation. */
const QUOTABLE: CardEvent['kind'][] = ['say', 'closing', 'question', 'answer', 'hint', 'review', 'talk'];

/**
 * What an agent reads above the owner's words that reply to a message: which one, by its start
 * where the agent has the whole in its session (its own words, the owner's words to it), else whole
 * (Obeya's words in the card's conversation, an idea's agent's to a card's worker; the Koordinator,
 * which reads each command afresh, gets them all whole).
 */
export function replyNote(quoted: CardEvent | undefined, to: 'worker' | 'explorer' | 'koordinator'): string {
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
  const text = quoted.text.replace(/\s+/g, ' ').trim();
  return `[In reply to ${whose}: „${excerpt(text, heard && to !== 'koordinator' ? 160 : 2000)}“]\n\n`;
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
  /** The archive as `archived` built it; gone with `cache`, since it changes with the same writes. */
  private archiveItems: Item[] | null = null;
  private eventListeners = new Set<(e: CardEvent) => void>();
  private goneListeners = new Set<(cardId: string, id: number) => void>();
  private noticeListeners = new Set<(n: Notice) => void>();

  constructor(
    private store: Store,
    readonly canvas: CanvasInfo,
    private readDocs: () => PlanRead,
    /** The owner's screenshots, which a card's images must be among. */
    private images?: Pick<Images, 'resolve'>,
    /** Whether the Lesestand of the repository holds the commit; without it, every commit counts as held. */
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
    const edges = this.manualDependencies().filter(([a, b]) => a !== from || b !== to);
    if (!remove) {
      // A cycle would leave the cards waiting for each other forever.
      const all = [...edges, ...items.flatMap((i): [string, string][] => [...(i.buildsOn ?? []), ...(i.queue && 'behind' in i.queue ? i.queue.behind : []), ...(i.snoozed?.on ? [i.snoozed.on.card] : [])].map((before) => [before, i.id]))];
      const seen = new Set<string>();
      const visit = (id: string): boolean => {
        if (id === from) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return all.some(([a, b]) => a === id && visit(b));
      };
      if (visit(to)) throw new BadRequest('invalid', 'dependency cycle');
      edges.push([from, to]);
    }
    this.setSetting('manual_dependencies', JSON.stringify(edges));
    this.changed();
  }

  /**
   * A card changed. The listeners hear of it once the code that made the change is through, once
   * for all it changed: each of them may ask for the snapshot, which a change builds anew, and a
   * landing or a card moving on makes dozens of changes in a row.
   */
  changed() {
    this.cache = null;
    this.itemsCache = null;
    this.archiveItems = null;
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
   * The repository's Lesestand moved to `commit` after a fetch: pull requests merged before it,
   * whose merge commit GitHub did not say, count as landed with it. Then the plan docs are read again.
   */
  lesestandMoved(repo: string, commit: string) {
    for (const r of this.store.cards(this.canvas.id)) {
      const s = r.shipped ? (JSON.parse(r.shipped) as Shipped) : null;
      if (!commit || !s?.fetch || (r.repo ?? (r.plan_ref ? repoOfRef(r.plan_ref, this.home) : this.home)) !== repo) continue;
      const { fetch: _, ...rest } = s;
      this.store.update(r.id, { shipped: JSON.stringify({ ...rest, commit } satisfies Shipped) });
    }
    this.docsChanged();
  }

  /**
   * The plan doc decides a workstream's state. Stored `live` means its work landed; once the
   * Lesestand holds what landed and the doc still leaves the workstream open, only a part of it is
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
      const s = r.shipped ? (JSON.parse(r.shipped) as Shipped) : {};
      if (s.fetch || (s.commit && this.holds && !this.holds(repoOfRef(r.plan_ref, this.home), s.commit))) continue;
      const pr = r.pr ? (JSON.parse(r.pr) as PrState) : null;
      const shipped: Shipped = { ...s, ...(!s.pr && pr?.url && pr.number ? { pr: { url: pr.url, number: pr.number } } : {}) };
      // a new run starts on a fresh branch: the old one is merged, perhaps squashed
      this.store.update(r.id, { state: 'planned', need: null, pr: null, branch: null, shipped: JSON.stringify(shipped) });
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
    extra: Partial<Pick<CardEvent, 'code' | 'images' | 'mocks' | 'replyTo' | 'spot' | 'answer' | 'picks' | 'at' | 'wish' | 'reply' | 'forwarded' | 'token'>> & { unread?: boolean } = {},
  ): CardEvent {
    const { code, images, mocks, replyTo, spot, answer, picks, at, unread, wish, reply, forwarded, token } = extra;
    const e = this.store.addEvent({
      cardId,
      kind,
      author,
      text,
      ...(code ? { code } : {}),
      ...(images?.length ? { images: images.map((f) => basename(f)) } : {}),
      ...(mocks?.length ? { mocks } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(spot ? { spot } : {}),
      ...(answer ? { answer } : {}),
      ...(at ? { at } : {}),
      ...(unread ? { unread: true as const } : {}),
      ...(picks?.length ? { picks } : {}),
      ...(wish ? { wish } : {}),
      ...(reply ? { reply } : {}),
      ...(forwarded ? { forwarded } : {}),
      ...(token ? { token } : {}),
    });
    for (const fn of this.eventListeners) fn(e);
    return e;
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
    const stored = n === undefined ? r.demo : storedDemos(r)[n];
    if (!stored) return null;
    const { dir, kind } = (typeof stored === 'string' ? JSON.parse(stored) : stored) as StoredDemo;
    return { dir, kind };
  }

  /** The plan doc of a project, as written, for the owner to read. */
  planDoc(id: string): { file: string; markdown: string } {
    const ref = this.own(id).plan_ref;
    const doc = ref && !ref.includes('#') ? (this.docs ??= this.read()).find((d) => d.file === ref) : undefined;
    if (!doc) throw new BadRequest('invalid', 'not a project with a plan doc');
    return { file: doc.file, markdown: doc.markdown };
  }

  /** The card as the UI sees it. */
  item(id: string): Item | undefined {
    return this.items().find((i) => i.id === id);
  }

  /** Changes a card's work fields (state, session, workspace …); for the agents, not the owner. */
  work(id: string, fields: RowUpdate) {
    this.own(id);
    this.store.update(id, fields);
    this.changed();
  }

  /** The cards of the canvas, archived ones too, that were ever shared or are about to be. */
  sharedRows(): CardRow[] {
    return this.store.shared(this.canvas.id);
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
    return r.detail ? (JSON.parse(r.detail) as { summary?: string }).summary : undefined;
  }

  /**
   * A card an agent proposes, placed below the card it came from, or at the nearest free spot: its
   * text for the agent that takes it on, and apart from it why and what the owner has to decide.
   */
  /** An agent's proposal from card `fromId`: in the repository it names (`p.repo`), else in that card's. */
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
        title: p.title.slice(0, 200),
        body: p.task.slice(0, 20000),
        ...at,
        from_id: fromId,
        repo: this.repoColumn(p.repo ?? from?.repo),
        proposal: JSON.stringify(proposal),
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
    const proposal = storedProposal(row)!;
    const was = { title: row.title ?? '', state: row.state ?? 'planned' };
    if (row.deleted_at) return { kind: proposal.superseded ? 'already' : was.state === 'proposal' ? 'dismissed' : 'removed', ...was };
    if (row.archived_at || finished(was.state)) return { kind: 'finished', ...was };
    const superseded = JSON.stringify({ ...proposal, superseded: s } satisfies Proposal);
    // a proposal still open goes without the owner, as if never made
    if (was.state === 'proposal') this.store.update(row.id, { proposal: superseded, deleted_at: new Date().toISOString() });
    else {
      this.store.update(row.id, { proposal: superseded });
      this.log(row.id, 'state', 'koordinator', this.t.worker.superseded(s.title, s.why));
    }
    this.changed();
    return { kind: was.state === 'proposal' ? 'gone' : 'marked', ...was };
  }

  /** The owner keeps a card whose agent withdrew or replaced it: the mark goes. */
  keep(id: string) {
    const row = this.own(id);
    const { superseded, ...proposal } = storedProposal(row) ?? { questions: [] };
    if (!superseded) throw new BadRequest('notSuperseded', 'its agent has not withdrawn or replaced this card');
    this.store.update(id, { proposal: JSON.stringify(proposal satisfies Proposal) });
    this.changed();
  }

  /**
   * A card the Arbeitsrückschau proposes for a repository: it waits as a proposal like an agent's,
   * in a free spot, with what it rests on (`basis`).
   */
  proposeRetro(repo: string, p: { title: string; body: string; basis: string }): Item {
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: 'proposal',
        title: p.title.slice(0, 200),
        body: p.body.slice(0, 20000),
        ...this.freeSpot(),
        repo: this.repoColumn(repo),
        retro: p.basis.slice(0, 2000),
        proposal: JSON.stringify(proposalOf({})),
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
    this.checkRepo(repo);
    const { title, body, reason } = this.t.adapterSetup;
    // clear of the note on the plan directory, as on a canvas that has nothing else yet
    const { items, planDirs = [] } = this.snapshot();
    const box = unionBounds([...items.filter((i) => !i.parent).map((i) => boundsOf(i, items)), ...planDirs.flatMap((d) => planDirNoteBox(d) ?? [])]);
    const at = box ? { x: box.x + box.w + 2 * GAP, y: box.y } : { x: 0, y: 0 };
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'task',
        state: propose ? 'proposal' : 'planned',
        title: title(name),
        body,
        ...at,
        repo: this.repoColumn(repo),
        ...(propose ? { proposal: JSON.stringify({ ...proposalOf({ reason: reason(name) }), setup: true } satisfies Proposal) } : {}),
      },
    ]);
    this.setSetting(`${SETUP_CARD_SETTING}${repo}`, row!.id);
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
    const row = this.store.card(id);
    if (unknown || !row || row.deleted_at || row.state !== 'proposal') return;
    this.store.update(id, { proposal: JSON.stringify({ ...storedProposal(row)!, superseded: {} } satisfies Proposal), deleted_at: new Date().toISOString() });
    this.changed();
  }

  /** The cards the Arbeitsrückschau proposed for a repository, with what became of them. */
  retroProposals(repo: string) {
    return this.store.retroProposals(this.canvas.id, this.repoColumn(repo));
  }

  /** A value for a repository's setting the Arbeitsrückschau proposes: it waits in Obeya's sheet beside the rules. */
  proposeSetting(p: { repo: string; field: ProposedSetting; value: string | string[]; basis: string; cards: string[] }): number {
    this.checkRepo(p.repo);
    const id = this.store.addSettingProposal(this.canvas.id, { ...p, basis: p.basis.slice(0, 2000) });
    this.changed();
    return id;
  }

  /** The settings the Arbeitsrückschau proposed, with what became of them: those of a repository, or all. */
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
   * The outdated pages the Koordinator's sheet offers to share again, archived cards' included,
   * with the changes each lacks: after the owner put the notice away, only those a newer change
   * left outdated.
   */
  outdatedRows(shared = this.sharedRows()): { r: CardRow; missed: KnownChange[] }[] {
    const at = (id: string | null) => PAGE_CHANGES.findIndex((c) => c.id === id);
    const dismissed = at(this.setting(RESHARE_DISMISSED));
    return shared
      .map((r) => ({ r, missed: reshareable(r) }))
      .filter(({ missed }) => missed.some((c) => at(c.id) > dismissed));
  }

  /**
   * The shared pages the Koordinator's sheet offers to tag („N Seiten ohne Tags“), archived cards'
   * included: at rest, their demos at hand, on a site with a vocabulary, and lacking tags in one of
   * its dimensions.
   */
  untaggedRows(shared = this.sharedRows()): CardRow[] {
    return shared.filter((r) => {
      const s = JSON.parse(r.share!) as StoredShare;
      const vocabulary = this.vocabularyOf?.(r.repo ?? (r.plan_ref ? repoOfRef(r.plan_ref, this.home) : this.home));
      if (!s.url || s.state || !vocabulary || !untagged(pageTagsOf(r), vocabulary).length) return false;
      const demos = sharedDemos(s);
      return demos.length > 0 && demos.every((d) => demoThere({ dir: d.dir, kind: d.shown.kind }));
    });
  }

  /** The vocabulary of tags each repository's site names (`demo.site.tags`), for the pages without tags; none where it names none. */
  private vocabularyOf?: (repo: string) => PageTags | undefined;

  showVocabulary(of: (repo: string) => PageTags | undefined) {
    this.vocabularyOf = of;
    this.changed();
  }

  /** "Ausblenden": the notice of outdated pages goes until a newer change, and the result of a run that finished with it. */
  dismissOutdated() {
    this.setSetting(RESHARE_DISMISSED, pagesVersion());
    this.setReshareRun(null);
  }

  /** An idea's stored status and brief. */
  idea(id: string): StoredIdea {
    const r = this.own(id);
    if (r.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return r.idea ? (JSON.parse(r.idea) as StoredIdea) : { status: 'open', brief: '' };
  }

  setIdea(id: string, fields: Partial<StoredIdea>) {
    this.work(id, { idea: JSON.stringify({ ...this.idea(id), ...fields }) });
  }

  /** The thread of looked-up answers a Question card (or an idea that was one) holds. */
  thread(id: string): StoredThread {
    const r = this.own(id);
    if (!r.thread) throw new BadRequest('notQuestion', 'the card holds no thread of answers');
    return JSON.parse(r.thread) as StoredThread;
  }

  setThread(id: string, fields: Partial<StoredThread>) {
    this.work(id, { thread: JSON.stringify({ ...this.thread(id), ...fields }) });
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
    this.store.update(row!.id, { thread: JSON.stringify(thread), ...(session ? { session_id: session } : {}) });
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
        title: title.slice(0, 200),
        body: body.slice(0, 20000),
        ...at,
        from_id: ideaId,
        prototype_of: ideaId,
        group_id: idea?.group ?? null,
        ...(variant ? { prototype: JSON.stringify({ variant } satisfies StoredPrototype) } : {}),
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
    this.work(id, { prototype: JSON.stringify({ ...storedPrototype(row), proposal: reason } satisfies StoredPrototype) });
  }

  /**
   * A prototype has served its purpose: discarded or built, it goes into the archive with its log,
   * demo and summary, and never comes back. Its workspace is no longer its own.
   */
  endPrototype(id: string, end: 'discarded' | 'built', into?: string) {
    const row = this.own(id);
    if (!row.prototype_of) throw new BadRequest('notPrototype', 'not a prototype');
    const { proposal: _, ...kept } = storedPrototype(row);
    this.work(id, { prototype: JSON.stringify({ ...kept, end, ...(into ? { into } : {}) } satisfies StoredPrototype), archived_at: new Date().toISOString(), need: null, status_line: null, workspace: null, queue: null });
  }

  // ---------------------------------------------------------------- the Koordinator's memory

  /**
   * Records an exchange with the Koordinator, without its reply (`''`) while it reads the words;
   * returns its id. `replyTo`: the message of the sheet the words reply to.
   */
  addTalk(said: string, reply: string, cardId: string | null = null, lookUp?: { question: string; about: string | null }, images: string[] = [], replyTo?: TalkRef, after?: TalkAfter, askedIn?: string, answered?: number): number {
    const id = this.store.addTalk(this.canvas.id, said, reply, cardId, lookUp, images, replyTo, after, askedIn, answered);
    this.changed();
    return id;
  }

  /** The Koordinator's reply to words it has read, the question it looks up for them, and what a draft for Obeya's makers would start from; `waits`: unread in the sheet until the owner sees it. */
  replyTalk(id: number, reply: string, lookUp?: { question: string; about: string | null }, wish?: Wish, waits = false) {
    this.store.replyTalk(id, reply, lookUp, wish, waits);
    this.changed();
  }

  /**
   * After a restart: words the Koordinator was reading when Obeya stopped are not read any more;
   * they get a reply that says so, in the sheet or on the card that was open.
   */
  interruptTalk() {
    const lost = this.store.interruptTalk(this.canvas.id, this.t.voice.interrupted);
    for (const x of lost) if (x.cardId && this.item(x.cardId)) this.log(x.cardId, 'say', 'koordinator', this.t.voice.interrupted, { reply: true });
    if (lost.length) this.changed();
  }

  /** Words the usage limit keeps the Koordinator from reading, until it lifts; `null` once it reads them. */
  holdTalk(id: number, held: HeldTalk | null) {
    this.store.holdTalk(id, held);
    this.changed();
  }

  /** The words the usage limit holds, oldest first: after a restart, the Koordinator reads them once it lifts. */
  heldTalk() {
    return this.store.heldTalk(this.canvas.id);
  }

  /** The cards the Koordinator waits on after the exchange's reply, to take a step once each gets there. */
  waitTalk(id: number, waits: TalkWaitRow[]) {
    this.store.waitTalk(id, waits);
    this.changed();
  }

  /** The exchanges whose reply said the Koordinator waits on a card. */
  waitingTalk() {
    return this.store.waitingTalk(this.canvas.id);
  }

  /** The step the Koordinator takes once the exchange's looked-up answer is in; `null` once it has decided it. */
  thenTalk(id: number, then: string | null) {
    this.store.thenTalk(id, then);
  }

  /** Looked-up answers that are in whose step the Koordinator has not decided yet: after a restart, it takes them up. */
  answeredSteps() {
    return this.store.answeredSteps(this.canvas.id);
  }

  undoTalk(id: number) {
    this.store.undoTalk(id);
    this.changed();
  }

  /** A command waiting for "Rückgängig" until `due`, kept across a restart (`Commander`). */
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

  /** The answer to a question the Koordinator looked up, with the files it comes with. */
  answerTalk(id: number, answer: string, by: 'koordinator' | 'project', files: AnswerFile[] = []) {
    this.store.answerTalk(id, answer, by, files);
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

  /** The owner has the Koordinator's sheet in view: its answers are read. */
  /** The owner has Obeya's sheet in view, or (`ids`) those exchanges in a project's sheet. */
  readTalk(ids?: number[]) {
    if (this.store.readTalk(this.canvas.id, ids)) this.changed();
  }

  exchange(id: number) {
    return this.store.exchange(id);
  }

  /** Questions the Koordinator is still looking up. */
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
    const row = this.own(id);
    if (row.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    const proposal = storedProposal(row);
    if (proposal?.revising) throw new BadRequest('revising', 'the proposal is being reworked');
    // an agent's proposal keeps that it was one: its task is not the owner's words; Obeya's setup card is as if the owner made it
    const kept = proposal && !proposal.setup && JSON.stringify({ ...(proposal.idea ? { idea: true } : {}), questions: [] } satisfies Proposal);
    this.store.update(id, { state: asIdea ? 'idea' : 'planned', body: withQuestions(row.body ?? '', proposal?.questions ?? [], picks, this.t), proposal: kept || null });
    this.changed();
  }

  /**
   * The owner wants a proposal changed: an agent reworks it by their words, and it waits for that.
   * Words said while it is reworked wait for the rework after it. Returns whether they wait.
   */
  revising(id: string, words: string, spoken: boolean, said?: number, images: string[] = []): boolean {
    const row = this.own(id);
    if (row.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    const proposal = storedProposal(row) ?? { questions: [] };
    const these: Revising = {
      words: words.slice(0, 20000),
      ...(spoken ? { spoken } : {}),
      ...(said ? { said: [said] } : {}),
      ...(images.length ? { images: images.map((f) => basename(f)) } : {}),
    };
    const revising = proposal.revising ? { ...proposal.revising, next: [...(proposal.revising.next ?? []), these] } : these;
    this.store.update(id, { proposal: JSON.stringify({ ...proposal, revising } satisfies Proposal) });
    this.changed();
    return revising !== these;
  }

  /** The owner takes back words that wait for the proposal's next rework; false when none of them are these. */
  unrevise(id: string, said: number): boolean {
    const row = this.own(id);
    const proposal = storedProposal(row);
    const next = proposal?.revising?.next;
    if (!proposal?.revising || !next?.some((r) => r.said?.includes(said))) return false;
    const rest = next.filter((r) => !r.said?.includes(said));
    const { next: _, ...revising } = proposal.revising;
    this.store.update(id, { proposal: JSON.stringify({ ...proposal, revising: { ...revising, ...(rest.length ? { next: rest } : {}) } } satisfies Proposal) });
    this.changed();
    return true;
  }

  /** When the proposal starts once accepted (ISO), or at once (`null`). */
  startAt(id: string, at: string | null) {
    const row = this.own(id);
    if (row.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    const { startAt: _, ...proposal } = storedProposal(row) ?? { questions: [] };
    this.store.update(id, { proposal: JSON.stringify({ ...proposal, ...(at ? { startAt: at } : {}) } satisfies Proposal) });
    this.changed();
  }

  /** "Übernehmen und starten" during a revision (`on`; `idea`: "Als Idee besprechen"), or taken back; false when that was so already. */
  acceptAfterRevision(id: string, on: boolean | 'idea'): boolean {
    const row = this.own(id);
    if (row.state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    const { acceptAfterRevision: was, ...proposal } = storedProposal(row) ?? { questions: [] };
    if ((was ?? false) === on) return false;
    this.store.update(id, { proposal: JSON.stringify({ ...proposal, ...(on ? { acceptAfterRevision: on } : {}) } satisfies Proposal) });
    this.changed();
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
    const { revising: done, ...was } = storedProposal(row) ?? { questions: [] };
    // what the owner said meanwhile is the next rework's
    const next = done?.next?.length ? { revising: merged(done.next) } : {};
    // when it starts is the owner's to change, not the reviser's
    const proposal: Proposal = p ? { ...proposalOf({ ...p, startAt: was.startAt }), ...(was.acceptAfterRevision ? { acceptAfterRevision: was.acceptAfterRevision } : {}), ...(was.setup ? { setup: was.setup } : {}) } : was;
    this.store.update(id, {
      ...(p ? { title: p.title.slice(0, 200), body: p.task.slice(0, 20000) } : {}),
      ...(p?.images ? { images: p.images.length ? JSON.stringify(p.images) : null } : {}),
      proposal: JSON.stringify({ ...proposal, ...next } satisfies Proposal),
    });
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- archive

  /** Takes finished cards, stopped tasks and parked or dropped ideas of the owner's off the canvas into its archive. */
  archive(ids: string[]) {
    for (const id of ids) {
      const row = this.own(id);
      if (row.plan_ref) throw new BadRequest('planCard', 'a workstream stays with its project');
      if (row.state === 'idea') {
        if (this.idea(id).status === 'open') throw new BadRequest('notDone', 'an idea under discussion cannot be archived');
        if (this.items().some((i) => i.prototypeOf === id)) throw new BadRequest('prototypeRunning', 'a prototype for this idea is still running');
        continue;
      }
      // a stopped task goes with its conversation, for the owner to come back to; work its workspace holds would be left unseen
      if (row.state === 'planned' && row.branch && row.kind === 'task' && !row.prototype_of) {
        if (row.queue) throw new BadRequest('notDone', 'the card waits to be started');
        if (row.workspace || row.kept_in) throw new BadRequest('holdsWork', 'its workspace holds work that has not landed');
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
    const ids = this.snapshot()
      // a Question card is done when the owner says so, not with the finished work
      .items.filter((i) => i.source === 'manual' && i.kind !== 'question' && finished(i.state) && !i.finishing)
      .map((i) => i.id);
    if (ids.length) this.archive(ids);
    return ids;
  }

  /** Puts an archived card back where it was on the canvas; a project comes back with its doc. */
  unarchive(id: string) {
    const row = this.own(id);
    if (row.plan_ref) throw new BadRequest('planCard', 'a project comes back when its plan doc does');
    if (!row.archived_at) throw new BadRequest('notArchived', 'the card is not archived');
    // a new attempt is a new prototype
    if (row.prototype_of) throw new BadRequest('prototypeEnded', 'a discarded or built prototype stays in the archive');
    this.store.update(id, { archived_at: null });
    this.changed();
  }

  /**
   * The archive, the most recently archived first. A project comes as its plan doc last stood,
   * followed by its workstreams (with `parent`), which the archive lists under it, not on their own.
   */
  archived(): Item[] {
    // the docs as they are now decide what is archived
    this.items();
    if (this.archiveItems) return this.archiveItems;
    this.archiveItems = this.archiveOf(this.store.archived(this.canvas.id));
    return this.archiveItems;
  }

  /** The archive's items for these of its cards, each project followed by its workstreams. */
  private archiveOf(rows: CardRow[]): Item[] {
    const projects = rows.filter((r) => r.plan_ref);
    const docs = projects.map((r) => JSON.parse(r.plan!) as PlanDoc);
    const kids = this.store.children(projects.map((r) => r.id));
    const items = this.withPrototypes(toItems([...rows, ...kids], docs, this.home));
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
    this.own(id);
    const item = this.item(id);
    if (item || this.archiveItems) return item ?? this.archiveItems!.find((i) => i.id === id);
    // as the canvas has just read the docs: a project whose doc went is archived by that
    const row = this.own(id);
    // one card of the archive (a workstream with its project), without building all of it: sharing pages again asks for one after another
    const parent = row.parent_id ? this.store.card(row.parent_id) : null;
    const archived = row.archived_at ? row : parent?.archived_at && !parent.deleted_at && parent.canvas_id === this.canvas.id ? parent : null;
    return archived ? this.archiveOf([archived]).find((i) => i.id === id) : undefined;
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
    this.store.update(cardId, { plan_docs: JSON.stringify(refs) });
    this.changed();
  }

  /**
   * Why the card holding the workspace at `path` will not work in it again, where it will not: the
   * card does not name it as its workspace, or its work is over and its worker done (`stale`: the
   * lease outlived what it was for); it was deleted; or it is a workstream no worker is on whose box
   * the plan doc on the default branch ticks off (`ticked`; `merged` while it is in its pull request,
   * which the doc says has been merged), or that the doc there no longer has (`gone`).
   */
  leaseEnded(cardId: string, path: string): 'stale' | 'deleted' | 'ticked' | 'merged' | 'gone' | null {
    const row = this.store.card(cardId);
    if (!row) return 'stale';
    if (row.canvas_id !== this.canvas.id) return null;
    // a deleted card keeps its workspace named, to take it back when it is restored
    if (row.workspace !== path) return 'stale';
    if (row.landed) return null;
    if (row.deleted_at) return 'deleted';
    // what remained after the landing is done: the worker that did it gave the workspace up
    if (row.state && finished(row.state)) return 'stale';
    const hash = row.plan_ref?.indexOf('#') ?? -1;
    if (hash < 0 || row.state === 'working' || row.state === 'waiting' || row.state === 'approved') return null;
    if (row.state === 'inPr' && !row.pr) return null;
    // the docs are read the way the canvas reads them, which plans again a workstream only a part of which landed
    this.items();
    const doc = this.docs?.find((d) => d.file === row.plan_ref!.slice(0, hash));
    const w = doc?.workstreams.find((x) => x.key === row.plan_ref!.slice(hash + 1));
    // an open pull request goes on without the doc: its watcher sees it merged or closed; a repository
    // not (yet) on the canvas has no docs read
    if (!w) return row.state === 'inPr' || !this.canvas.repos.some((r) => r.id === repoOfRef(row.plan_ref!, this.home)) ? null : 'gone';
    if (!w.done) return null;
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
    const planDirs = this.planDirs(this.docs!);
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
      this.archiveItems = null;
    }
    if (this.itemsCache) return this.itemsCache;
    const read = !this.docs;
    if (!this.docs) {
      this.docs = this.read();
      this.docsOf = repos;
    }
    const all = this.docs;
    const docs = this.openDocs(all);
    const open = docs.map((d) => d.file).join('\n');
    if (read || open !== this.open) {
      this.open = open;
      this.keepDocs(all, docs);
      if (read) this.reopen(all);
    }
    let rows = this.store.cards(this.canvas.id);
    let items = toItems(rows, docs, this.home);
    if (this.placeNew(docs, items, all, rows)) {
      // projects seen for the first time keep their doc too
      this.keepDocs(all, docs);
      // what reacts to changes hears of them too (the Koordinator reads what builds on what in a project just come)
      this.tell();
      rows = this.store.cards(this.canvas.id);
      items = toItems(rows, docs, this.home);
    }
    const manual = this.manualDependencies();
    items = items.map((i) => {
      const on = manual.filter(([, to]) => to === i.id).map(([from]) => from);
      return on.length ? { ...i, manualDependsOn: on } : i;
    });
    items = this.withPrototypes(items);
    items = this.withElsewhere(items);
    const inTurn = new Map([...this.turns].flatMap((f) => [...f()]));
    if (inTurn.size) items = items.map((i) => {
      const turn = inTurn.get(i.id);
      if (!turn) return i;
      const background = turn.tasks.length ? { background: turn.tasks } : {};
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
    return items;
  }

  /** Until when the usage limit holds back what goes by this key (`card:<id>`, `talk:<id>`). */
  private limited(key: string): { limitedUntil?: string } {
    const until = this.limits.get(key);
    return until ? { limitedUntil: until } : {};
  }

  /** Cards that come from a card on another canvas name it, with that canvas. */
  private withElsewhere(items: Item[]): Item[] {
    return items.map((i) => {
      if (!i.from) return i;
      const from = this.store.card(i.from);
      if (!from || from.canvas_id === this.canvas.id || from.deleted_at) return i;
      return { ...i, fromElsewhere: { canvas: from.canvas_id, canvasName: this.store.canvasName(from.canvas_id) ?? from.canvas_id, title: from.title ?? '' } };
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
    for (const r of rows) if (r.snoozed && !shown.has(r.id) && (JSON.parse(r.snoozed) as Snooze).start) this.store.update(r.id, { snoozed: null });
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
    const s = this.own(cardId).snoozed;
    return s ? (JSON.parse(s) as Snooze) : null;
  }

  /** Snoozes the card until `until` (ISO) or the card it waits on, as `s` says, with the line in its conversation by whoever snoozed it (or changed the time). */
  snooze(cardId: string, s: Snooze, by: 'agent' | 'owner' = s.by) {
    this.work(cardId, { snoozed: JSON.stringify(s) });
    this.log(cardId, 'state', by === 'agent' ? 'worker' : 'owner', this.t.worker.snoozed(snoozeTerm(this.t, s), s.why));
  }

  /**
   * The card is snoozed no longer, with the line that it woke and why (`woke`): its time came, the
   * owner woke it, Obeya had something for its agent, the card needs the owner, or what became of the
   * card it waited on. Returns the snooze it had.
   */
  unsnooze(cardId: string, woke: Woke): Snooze | null {
    const s = this.snoozedOf(cardId);
    if (!s) return null;
    this.work(cardId, { snoozed: null });
    const why = this.t.worker.wokeWhy;
    this.log(cardId, 'state', woke === 'owner' ? 'owner' : 'obeya', this.t.worker.woke(typeof woke === 'object' ? (s.on ? why.card(s.on.title, woke.met, s.on.state) : why.time) : why[woke]));
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
   * The docs whose projects stand on the canvas: those with a workstream still open, and those
   * whose every workstream is ticked, or whose doc is gone (as it last stood), while one of their
   * cards is still at work (in progress, or its worker finishing after the landing). The others'
   * projects have ended.
   */
  private openDocs(all: PlanDoc[]): PlanDoc[] {
    const busy = new Set(
      this.store
        .cards(this.canvas.id)
        .filter((r) => r.plan_ref?.includes('#') && ((r.state && ACTIVE.includes(r.state)) || (r.landed && r.workspace)))
        .map((r) => r.plan_ref!.slice(0, r.plan_ref!.indexOf('#'))),
    );
    const files = new Set(all.map((d) => d.file));
    const gone = this.store
      .projects(this.canvas.id)
      .filter((r) => r.plan && busy.has(r.plan_ref!) && !files.has(r.plan_ref!))
      .map((r) => JSON.parse(r.plan!) as PlanDoc);
    return [...all.filter((d) => !allTicked(d) || busy.has(d.file)), ...gone];
  }

  /**
   * The notes on the plan directories: one for each that holds docs which are not projects, and
   * one for a repository with no plan doc that never had a project, saying where the first goes.
   */
  private planDirs(docs: PlanDoc[], rows = this.store.cards(this.canvas.id)): PlanDir[] {
    const projects = this.store.projects(this.canvas.id);
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

  /** The outdated pages, archived cards' included, and the run sharing them again. */
  private reshare(): Reshare | null {
    const rows = this.sharedRows();
    const run = this.reshareRun();
    const queued = new Set(run?.queue);
    const left = this.outdatedRows(rows).filter(({ r }) => !queued.has(r.id));
    const untagged = this.untaggedRows(rows).filter((r) => !queued.has(r.id)).length;
    if (!left.length && !untagged && !run) return null;
    // what sharing them again brings, and to how many of them
    const changes = PAGE_CHANGES.flatMap(({ id }) => {
      const pages = left.filter(({ missed }) => missed.some((c) => c.id === id)).length;
      return pages ? [{ id, pages }] : [];
    });
    const title = (id: string) => rows.find((r) => r.id === id)?.title ?? '';
    const first = run?.queue[0] ? rows.find((r) => r.id === run.queue[0]) : undefined;
    const current = first?.share && (JSON.parse(first.share) as StoredShare).state === 'publishing' ? first.title : undefined;
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
    const rows = this.store.prototypes(this.canvas.id);
    if (!rows.length) return items;
    const titles = new Map<string, string>();
    const ideaTitle = (id: string) => titles.get(id) ?? (titles.set(id, this.store.card(id)?.title ?? ''), titles.get(id)!);
    const named = (p: Item): Item => ({ ...p, ideaTitle: ideaTitle(p.prototypeOf!) });
    const prototypes = toItems(rows, [], this.home).map((p, n) => named(rows[n]!.archived_at ? { ...p, archivedAt: rows[n]!.archived_at! } : p));
    return items.map((i) => {
      const own = prototypes.filter((p) => p.prototypeOf === i.id || (i.parent && p.id === i.builtOn));
      const me = i.prototypeOf ? named(i) : i;
      return own.length ? { ...me, prototypes: own } : me;
    });
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
      quote: occasion.quote?.trim().slice(0, 2000) || undefined,
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
   * `null` for the preference memory. A rule for a repository goes into its card „CLAUDE.md
   * ergänzen“, which a worker writes it from into the CLAUDE.md; until then it applies to no agent.
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
   * written in the sheet: it goes into the repository's card „CLAUDE.md ergänzen“ at once, without
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
   * Adds an accepted rule to the repository's open card „CLAUDE.md ergänzen“: planned and not yet
   * with the Koordinator. Without one, a new card collects it.
   */
  private collect(repo: string, rule: string) {
    const open = this.collecting(repo);
    if (open) {
      this.store.update(open.id, { body: `${open.body.trimEnd()}\n- ${rule}` });
      this.log(open.id, 'state', 'koordinator', this.t.koordinator.ruleTaken(rule));
      return;
    }
    const card = this.create({ title: this.t.claudeMd.title, body: `${this.t.claudeMd.task}\n\n- ${rule}`, repo, ...this.freeSpot() });
    this.setSetting(`${CLAUDE_MD_SETTING}${repo}`, card.id);
    this.log(card.id, 'state', 'koordinator', this.t.koordinator.ruleTaken(rule));
  }

  /** The repository's card „CLAUDE.md ergänzen“ while it still collects rules, if there is one. */
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
    return toItems([row], [], this.home)[0]!;
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
    const n = (name as string).replace(/\s+/g, ' ').trim();
    if (!n) throw new BadRequest('emptyText', 'a group needs a name');
    return n;
  }

  /**
   * `elsewhere`: the card on another canvas it follows up on (a card Obeya makes here from there); it
   * goes where `x` and `y` say, in no group.
   */
  create(n: NewCard, elsewhere?: string): Item {
    checkText(n.title, 'title', 200);
    if (n.body !== undefined) checkText(n.body, 'body', 20000);
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
        images: n.images?.length ? JSON.stringify(n.images) : null,
        ...(n.idea ? { idea: JSON.stringify({ status: 'open', brief: '' } satisfies StoredIdea) } : {}),
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
    if (p.title !== undefined) checkText(p.title, 'title', 200);
    if (p.body !== undefined) checkText(p.body, 'body', 20000);
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
      // a repository of the canvas picked instead of a new one
      // a repository of the canvas picked instead of a new one: the owner's pick, which the idea's agent leaves
      ...(repo !== undefined ? { repo: this.repoColumn(repo) } : {}),
      ...(newRepo !== undefined || repo !== undefined
        ? { new_repo: JSON.stringify(newRepo ? ({ path: newRepo.path.trim(), canvas: newRepo.canvas, by: 'owner' } satisfies NewRepo) : ({ path: '', canvas: true, by: 'owner', none: true } satisfies StoredNewRepo)) }
        : {}),
      ...(images !== undefined ? { images: images.length ? JSON.stringify(images) : null } : {}),
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
    const r = this.store.card(id)?.new_repo;
    return r ? (JSON.parse(r) as StoredNewRepo) : null;
  }

  /**
   * The repository to create for a card, as its idea's agent or Obeya sets it; null takes it off.
   * What the owner chose, the agent does not change: false then.
   */
  setNewRepo(id: string, n: StoredNewRepo | null, by: NewRepo['by'] = 'owner'): boolean {
    const was = this.newRepo(id);
    // what the owner picked stands, and a repository about to be made stays as it was clicked
    if (by === 'agent' && ((was?.by === 'owner' && !was.made) || was?.due)) return false;
    this.store.update(id, { new_repo: n && JSON.stringify(n) });
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
    checkText(body, 'the merged text', 20000);
    const list = (r: CardRow) => (r.images ? (JSON.parse(r.images) as string[]) : []);
    const images = [...new Set([first, ...rest].flatMap(list))];
    const notes = [first, ...rest].flatMap((r) => (r.unheard ? (JSON.parse(r.unheard) as unknown[]) : []));
    this.store.update(keep, { title, body, images: images.length ? JSON.stringify(images) : null, ...(notes.length ? { unheard: JSON.stringify(notes) } : {}) });
    const gone = new Set(others);
    for (const r of this.store.cards(this.canvas.id)) {
      if (r.from_id && gone.has(r.from_id) && r.id !== keep) this.store.update(r.id, { from_id: keep });
      const c = contributionOf(r);
      if (c?.findings?.some((f) => f.card && gone.has(f.card))) this.store.update(r.id, { contribution: JSON.stringify({ ...c, findings: c.findings.map((f) => (f.card && gone.has(f.card) ? { ...f, card: keep } : f)) } satisfies StoredContribution) });
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
        const plan = doc ? JSON.stringify(doc) : r.plan;
        const archived_at = shown.has(r.plan_ref!) ? null : (r.archived_at ?? at);
        if (r.plan !== plan || r.archived_at !== archived_at) this.store.update(r.id, { plan, archived_at });
      }
    })();
  }

  /** What the Koordinator read of a project's plan doc about which workstream builds on which, and whether it is reading it now. */
  deps(projectId: string): StoredDeps & { current: boolean } {
    // the project keeps its doc as the canvas last read it
    this.items();
    const row = this.own(projectId);
    if (row.kind !== 'project' || !row.plan) throw new BadRequest('invalid', 'not a project');
    const d = row.deps ? (JSON.parse(row.deps) as StoredDeps) : {};
    return { ...d, current: !!d.on && d.sig === depsSig(JSON.parse(row.plan) as PlanDoc) };
  }

  /**
   * The projects whose plan doc the Koordinator is to read for which workstream builds on which
   * (`arranging` on the canvas), from their rows: asked on every change, this builds no snapshot.
   */
  arranging(): string[] {
    return this.store.projects(this.canvas.id).flatMap((r) => (!r.archived_at && r.deps && (JSON.parse(r.deps) as StoredDeps).reading ? [r.id] : []));
  }

  /** The Koordinator starts reading which workstream builds on which (`reading`), or has read it (`on`, for the doc as it stands now). */
  setDeps(projectId: string, d: { reading: NonNullable<StoredDeps['reading']> } | { on: Record<string, string[]> } | { failed: true }) {
    const row = this.own(projectId);
    const was = row.deps ? (JSON.parse(row.deps) as StoredDeps) : {};
    const next: StoredDeps =
      'reading' in d ? { ...was, reading: d.reading } : 'on' in d ? { sig: depsSig(JSON.parse(row.plan!) as PlanDoc), on: d.on } : { ...was, reading: undefined };
    this.store.update(projectId, { deps: JSON.stringify(next) });
    this.changed();
  }

  /** The workstream key of each of the project's workstreams, by card. */
  workstreamKeys(projectId: string): Map<string, string> {
    return new Map(this.store.children([projectId]).flatMap((k) => (k.plan_ref?.includes('#') ? [[k.id, k.plan_ref.slice(k.plan_ref.indexOf('#') + 1)]] : [])));
  }

  /** Whether none of the project's workstreams stands anywhere but where it was placed when the project came (`placeNew`). */
  untouched(projectId: string): boolean {
    const row = this.own(projectId);
    const doc = JSON.parse(row.plan!) as PlanDoc;
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
    const [w, h] = projectSize(moved);
    const others = items.filter((i) => !i.parent && i.id !== projectId).map((i) => boundsOf(i, items));
    const overlaps = others.some((b) => project.x < b.x + b.w && b.x < project.x + w && project.y < b.y + b.h && b.y < project.y + h);
    this.store.db.transaction(() => {
      for (const k of moved) this.store.update(k.id, { x: k.x, y: k.y });
      if (overlaps) this.store.update(projectId, freeSpotNear(project, [w, h], others));
    })();
    this.changed();
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
    const linked = this.linkOrigins(docs);

    const known = new Set(this.store.projects(this.canvas.id).map((r) => r.plan_ref!));
    const done = all.filter((d) => !docs.includes(d) && !known.has(d.file));
    const fresh = [...docs.filter((d) => !byRef.has(d.file)), ...done];
    if (!fresh.length) return add.length > 0 || linked;
    const layouts = fresh.map((d) => {
      const pos = placeWorkstreams(d.workstreams);
      const kids = pos.map((p, n) => ({ kind: 'task' as const, state: d.workstreams[n]!.done ? ('live' as const) : ('planned' as const), parent: 'p', ...p }));
      return { doc: d, pos, size: projectSize(kids) };
    });
    const top = items.filter((i) => !i.parent);
    // below a note the owner put there too
    const notes = this.planDirs(all).flatMap((d) => planDirNoteBox(d) ?? []);
    const at = placeProjects(unionBounds([...top.map((i) => boundsOf(i, items)), ...notes]), layouts.map((l) => l.size));
    layouts.forEach(({ doc, pos }, n) => {
      const [project] = this.store.insert([{ canvas_id: c, kind: 'project', plan_ref: doc.file, ...at[n]! }]);
      // a project just come stands arranged by what builds on what, once the Koordinator has read that
      if (docs.includes(doc) && doc.workstreams.filter((w) => !w.done).length > 1) this.store.update(project!.id, { deps: JSON.stringify({ reading: 'auto' } satisfies StoredDeps) });
      this.store.insert(
        doc.workstreams.map((w, k) => ({ canvas_id: c, kind: 'task' as const, parent_id: project!.id, plan_ref: `${doc.file}#${w.key}`, ...pos[k]! })),
      );
    });
    this.linkOrigins(docs);
    return true;
  }

  /**
   * A project whose doc the landed work of an idea (or a task planned as a project) added remembers
   * that card and takes its place, while the card is on the canvas. Returns whether any did.
   */
  private linkOrigins(docs: PlanDoc[]): boolean {
    const origin = new Map<string, string>();
    // a card writing its doc in a plan folder outside the repository names it from the start: it is its origin once approved
    for (const r of this.store.withPlanDocs(this.canvas.id)) if (r.landed || r.state === 'live' || r.state === 'done') for (const ref of JSON.parse(r.plan_docs!) as string[]) origin.set(ref, r.id);
    if (!origin.size) return false;
    let linked = false;
    for (const r of this.store.projects(this.canvas.id)) {
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
    const items = toItems(this.store.cards(this.canvas.id), docs, this.home);
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

/** A plan reference's path, without the repository before it. */
export function pathOfRef(ref: string): string {
  return ref.replace(REPO_PREFIX, '');
}

const REPO_PREFIX = /^(?![A-Za-z]:\/)([\w.-]+):/;

/** Visible items: projects first, their workstreams in doc order, then manual cards. */
export function toItems(rows: CardRow[], docs: PlanDoc[], home: string): Item[] {
  const docByFile = new Map(docs.map((d) => [d.file, d]));
  // a project's group covers its workstreams
  const groupOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.group_id ? [[r.id, r.group_id]] : [])));
  // what each workstream builds on, by its project's reading of the doc
  const depsOf = new Map(rows.flatMap((r) => (r.kind === 'project' && r.deps ? [[r.id, JSON.parse(r.deps) as StoredDeps]] : [])));
  const idOfRef = new Map(rows.flatMap((r) => (r.plan_ref ? [[r.plan_ref, r.id]] : [])));
  const projects: Item[] = [];
  const workstreams: { item: Item; order: number }[] = [];
  const manual: Item[] = [];
  for (const r of rows) {
    if (!r.plan_ref) {
      manual.push({
        id: r.id,
        kind: r.kind,
        state: r.state ?? 'planned',
        ...(r.need ? { need: r.need } : {}),
        title: r.title ?? '',
        body: r.body ?? '',
        x: r.x,
        y: r.y,
        source: 'manual',
        repo: r.repo ?? home,
        ...work(r),
        ...(r.state === 'idea' ? { idea: ideaOf(r) } : r.idea ? decided(r) : {}),
        ...(r.thread ? { thread: threadOf(r) } : {}),
        ...(r.becomes_project ? { becomesProject: true } : {}),
        ...(r.prototype_of ? { prototypeOf: r.prototype_of, ...prototypeOf(r) } : {}),
        ...(r.built_on ? { builtOn: r.built_on } : {}),
        ...(r.images ? { images: JSON.parse(r.images) as string[] } : {}),
        ...(r.retro ? { retro: r.retro } : {}),
        ...(r.proposal ? (r.state === 'proposal' ? { proposal: storedProposal(r)! } : { proposed: true as const, ...supersededOf(r) }) : {}),
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
        kind: 'project',
        state: 'planned',
        title: doc.title,
        body: '',
        x: r.x,
        y: r.y,
        source: 'plan',
        repo: repoOfRef(doc.file, home),
        plan: { file: doc.file, goal: doc.goal },
        ...(depsOf.get(r.id)?.reading ? { arranging: true as const } : {}),
        ...(r.collapsed ? { collapsed: true } : {}),
        ...(r.from_id ? { origin: r.from_id } : {}),
        ...(r.group_id ? { group: r.group_id } : {}),
      });
      continue;
    }
    const key = r.plan_ref.slice(hash + 1);
    const order = doc.workstreams.findIndex((w) => w.key === key);
    const w = doc.workstreams[order];
    if (!w || !r.parent_id) continue;
    const derived = w.done ? 'live' : w.inReview ? 'inPr' : 'planned';
    // work in progress wins over the doc: a ticked-off workstream may still wait for its merge
    const state = r.state && ACTIVE.includes(r.state) ? r.state : derived === 'live' ? 'live' : (r.state ?? derived);
    // what landed of a workstream planned again, also while a new run does the rest; once that lands, the card is live
    const shipped = (state === 'planned' || ACTIVE.includes(state)) && r.shipped ? (JSON.parse(r.shipped) as Shipped) : null;
    const buildsOn = (depsOf.get(r.parent_id)?.on?.[key] ?? []).flatMap((k) => idOfRef.get(`${doc.file}#${k}`) ?? []);
    workstreams.push({
      order,
      item: {
        id: r.id,
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
        ...(w.label ? { label: w.label } : {}),
        ...work(r),
        ...(shipped ? { landedPart: { ...(shipped.commit ? { commit: shipped.commit } : {}), ...(shipped.pr ? { pr: shipped.pr } : {}) } } : {}),
        ...(r.built_on ? { builtOn: r.built_on } : {}),
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

/** Where a card goes below the card with bounds `b`: the `n`th of those there, each beside the one before. */
const below = (b: Bounds, n = 0) => ({ x: b.x + 35 + n * (CARD_SIZE.task[0] + GAP), y: b.y + b.h + 60 });

/** What is stored of a repository to create for a card: the target, and once Obeya made it, `made`. */
export type StoredNewRepo = NewRepo & { made?: true; none?: true };

/** A card's new repository while it is still to be made, before work on the card begins. */
function newRepoOf(r: CardRow): Pick<Item, 'newRepo'> {
  const n = r.new_repo ? (JSON.parse(r.new_repo) as StoredNewRepo) : null;
  if (!n || n.made || n.none || (r.state !== 'idea' && (r.state ?? 'planned') !== 'planned') || r.workspace) return {};
  const { made: _, ...newRepo } = n;
  return { newRepo };
}

/** The fields a worker adds to a card. */
function work(r: CardRow): Partial<Item> {
  const detail = r.detail ? (JSON.parse(r.detail) as { question?: Item['question']; summary?: string; noChange?: boolean; lands?: Item['lands']; answering?: boolean; answered?: boolean }) : {};
  const demo = r.demo ? shownDemo(JSON.parse(r.demo) as StoredDemo) : undefined;
  const earlier = demo ? earlierDemos(r) : [];
  const handed = r.need === 'review' || r.need === 'demo';
  const answering = detail.answering && handed;
  const scope = r.scope ? (JSON.parse(r.scope) as { files: string[] }).files : undefined;
  const pr = r.pr ? (JSON.parse(r.pr) as PrState) : undefined;
  const contribution = contributionOf(r);
  const share = shareOf(r);
  const notOnApproval = r.share ? (JSON.parse(r.share) as StoredShare).notOnApproval : undefined;
  const tags = demo && !r.prototype_of ? pageTagsOf(r) : {};
  const landed = r.landed ? (JSON.parse(r.landed) as { followUp?: boolean; needsClone?: boolean }) : null;
  return {
    ...(scope?.length ? { scope } : {}),
    ...(r.queue && (r.state ?? 'planned') === 'planned' ? { queue: JSON.parse(r.queue) as Item['queue'] } : {}),
    ...(pr?.url ? { pr: { url: pr.url, number: pr.number!, checks: pr.checks ?? [], conflict: !!pr.conflictHead, ...(pr.readyHead && (pr.mergeError || pr.held || pr.manual) ? { ready: true, ...(pr.mergeError ? { mergeError: pr.mergeError } : {}), ...(pr.held ? { held: pr.held } : {}), ...(pr.manual ? { manual: true } : {}) } : {}), ...(pr.review?.length ? { review: pr.review } : {}) } } : {}),
    ...(contribution ? { contribution: { url: contribution.url, number: contribution.number, author: contribution.author, title: contribution.title, canModify: contribution.canModify, ...(contribution.results ? { results: contribution.results } : {}), ...(contribution.findings ? { findings: contribution.findings } : {}), ...(contribution.requested ? { requested: contribution.requested } : {}) } } : {}),
    ...(r.status_line ? { statusLine: r.status_line } : {}),
    ...(detail.question && r.need === 'question' ? { question: detail.question } : {}),
    // a demo's question is as open as a worker's: the owner answers it on the card or by voice
    ...(demo?.question && !demo.answer && r.need === 'demo' ? { question: { text: demo.question, options: demo.options ?? [], ...(demo.multiple ? { multiple: true } : {}), ...(demo.pick ? { pick: demo.pick } : {}) } } : {}),
    ...(detail.summary && handed ? { summary: detail.summary } : {}),
    ...(answering ? { answering: true } : {}),
    ...(detail.answered && !answering && handed ? { answered: true } : {}),
    ...(r.held ? { held: (JSON.parse(r.held) as { id: number }[]).map((h) => h.id) } : {}),
    // approved work is held for its next handover while the card is at work; on a waiting card it is landing
    ...(r.approved_at && r.state === 'waiting' ? { landing: true } : {}),
    ...(demo ? { demo } : {}),
    ...(earlier.length ? { demos: earlier } : {}),
    ...(r.files ? { files: JSON.parse(r.files) as CardFile[] } : {}),
    ...(share ? { share } : {}),
    ...(notOnApproval ? { notOnApproval } : {}),
    ...(Object.keys(tags).length ? { tags } : {}),
    ...(r.from_id ? { from: r.from_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
    // a workspace on another machine as ssh and scp write it
    ...(r.workspace ? { workspace: r.workspace.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(r.kept_in ? { keptIn: r.kept_in.replace(/^ssh:\/\/([^/]+)/, '$1:') } : {}),
    ...(landed && (r.workspace || landed.needsClone) ? { finishing: true, ...(landed.followUp ? { followUp: true } : {}), ...(landed.needsClone && !r.workspace ? { waitsForClone: true } : {}) } : {}),
    ...(detail.noChange && handed ? { noChange: true } : {}),
    ...(detail.lands && handed ? { lands: detail.lands } : {}),
    ...(r.paused ? { paused: true } : {}),
    ...(r.pausing && !r.paused ? { pausing: true } : {}),
    ...(r.snoozed ? { snoozed: JSON.parse(r.snoozed) as Snooze } : {}),
    ...(r.app && r.workspace && !r.parked ? { app: r.app } : {}),
  };
}

/** The card's shared page as the UI sees it: none when it is not shared and not about to be. */
function shareOf(r: CardRow): Item['share'] {
  const s = r.share ? (JSON.parse(r.share) as StoredShare) : null;
  if (!s || (!s.state && !s.url)) return undefined;
  const latest = r.demo ? (JSON.parse(r.demo) as StoredDemo) : undefined;
  const shared = s.url ? sharedDemos(s) : [];
  // the card's demos on the page, by their handovers
  const on = cardDemos(r).flatMap((d) => (d.handover !== undefined && shared.some((x) => sameDemo(x, d)) ? [d.handover] : []));
  const stale = !!s.url && !!latest && !shared.some((x) => sameDemo(x, latest));
  const outdated = reshareable(r);
  return {
    state: s.refresh ? 'shared' : (s.state ?? 'shared'),
    ...(s.url ? { url: s.url } : {}),
    ...(on.length ? { on } : {}),
    ...(stale ? { stale: true } : {}),
    // shown with each version on the page; the latest, not on it, brings the changes with „Auf der Seite ersetzen“ or „Zur Seite dazunehmen“
    ...(outdated.length ? { outdated: outdated.map((c) => c.id) } : {}),
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

/** What is stored of a prototype: how it ended, once it did, and its worker's proposal to build the idea on it. */
interface StoredPrototype {
  /** The planned variant it shows. */
  variant?: string;
  end?: 'discarded' | 'built';
  /** Built for a workstream of the project its idea became: that workstream, as the owner reads it. */
  into?: string;
  proposal?: string;
}

const storedPrototype = (r: CardRow): StoredPrototype => (r.prototype ? (JSON.parse(r.prototype) as StoredPrototype) : {});

/** A prototype's end and proposal; an ended one keeps the summary it was handed over with. */
function prototypeOf(r: CardRow): Partial<Item> {
  const p = storedPrototype(r);
  const summary = p.end && r.detail ? (JSON.parse(r.detail) as { summary?: string }).summary : undefined;
  return { ...(p.variant ? { variant: p.variant } : {}), ...(p.end ? { prototypeEnd: p.end } : {}), ...(p.into ? { builtInto: p.into } : {}), ...(p.proposal && !p.end ? { buildProposal: p.proposal } : {}), ...(summary ? { summary } : {}) };
}

/** What is stored of an idea; `thinking` while its agent works on a reply, `yourTurn` once it replied. */
export interface StoredIdea {
  status: Idea['status'];
  brief: string;
  thinking?: boolean;
  /** "So bauen" waits for the reply its agent works on; questions in it call the building off. */
  buildAfterReply?: boolean;
  yourTurn?: boolean;
  questions?: Question[];
  next?: NextStep;
  /** The prototypes the brief plans, as the agent last set them. */
  variants?: PlannedPrototype[];
  /** The brief's mocks, as the agent last set them. */
  mocks?: Mock[];
  /** The settled part "Teilaufgabe abtrennen" builds, as the agent last marked it. */
  split?: SettledPart;
  /** Messages a turn ended before answering (the idea parked or dropped, an error, a restart); they go to the agent first next time. */
  unread?: Unread;
}

/** A message to an idea's agent: its text and the files of its screenshots. */
export interface Message {
  text: string;
  images: string[];
  /** The lines of the card's log with the owner's words it carries: unread until the agent takes it in. */
  said: number[];
}

/** A Question card's thread as stored: the exchange it started with, and its agent's turn. */
export interface StoredThread {
  talk: number;
  /** Its agent is reading, for what the owner asked on the card. */
  thinking?: boolean;
  /**
   * What the owner asked that the agent has not answered yet: behind a running turn, or left by a
   * restart; `talk`: asked in Obeya's sheet, whose exchange gets the answer too.
   */
  pending?: (Message & { talk?: number })[];
  answers: number;
  files: number;
}

export interface Unread {
  why: 'parked' | 'dropped' | 'error' | 'restart' | 'paused';
  messages: Message[];
}

/** The owner's words said one after the other while a proposal was reworked, as one rework's. */
const merged = (said: Revising[]): Revising => ({
  words: said.map((r) => r.words).join('\n\n'),
  ...(said.some((r) => r.spoken) ? { spoken: true } : {}),
  said: said.flatMap((r) => r.said ?? []),
  ...(said.some((r) => r.images?.length) ? { images: said.flatMap((r) => r.images ?? []) } : {}),
});

const storedProposal = (r: CardRow): Proposal | undefined => (r.proposal ? (JSON.parse(r.proposal) as Proposal) : undefined);

/** The mark of an accepted proposal its agent withdrew or replaced, while the card is not finished. */
const supersededOf = (r: CardRow): { superseded?: Superseded } => {
  const superseded = storedProposal(r)?.superseded;
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
  ...(p.reason?.trim() ? { reason: p.reason.trim().slice(0, 2000) } : {}),
  questions: (p.questions ?? []).slice(0, 5),
  ...(p.startAt ? { startAt: p.startAt } : {}),
});

const toDecision = (d: DecisionRow): Decision => ({ id: d.id, cardId: d.card_id, question: d.question, answer: d.answer, by: d.by, at: d.at });

/** A card that was an idea, as decided: the brief with its mocks. */
function decided(r: CardRow): Pick<Item, 'brief' | 'mocks'> {
  const i = JSON.parse(r.idea!) as StoredIdea;
  return { brief: i.brief, ...(i.mocks?.length ? { mocks: i.mocks } : {}) };
}

function threadOf(r: CardRow): Thread {
  const t = JSON.parse(r.thread!) as StoredThread;
  return { talk: t.talk, ...(t.thinking ? { thinking: true } : {}), answers: t.answers, files: t.files };
}

function ideaOf(r: CardRow): Idea {
  const i = r.idea ? (JSON.parse(r.idea) as StoredIdea) : { status: 'open' as const, brief: '' };
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
