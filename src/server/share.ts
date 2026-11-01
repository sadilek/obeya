// Sharing a card's demo with colleagues, a video or an HTML artifact: a page outside Obeya, on the
// static site Obeya keeps itself (`demo.site` of the repository's settings, site.ts). Obeya writes
// the page's text when the worker did not. A page keeps the newest page change (page-changes.ts) it
// was published after: one that lacks a change since is offered to share again ("Erneut teilen"),
// with what that brings, on its card, or many at once from the Koordinator's sheet.
// Once the card has a pull request, its description links the page and the page links it; work that
// lands without one links the page in its commit's trailer, and the page links the commit. A
// repository without a site (or with a site whose credentials are not on this machine) exports
// the demo instead: the same page as a ZIP with its files, or as one HTML file.
// Pages of one target are on one site, so each publish names the others.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES, type Messages } from '../core/messages';
import { type Demo, type DemoKind, type DemoPage, EXPORT_HTML_MAX, type Item, type PageTags, withSupplemented } from '../core/types';
import { BadRequest, type Board, cardDemos, contributionOf, type DemoRef, pageTagsOf, type PrState, reshareable, sameDemo, type SharedDemo, sharedDemos, type Shipped, type StoredDemo, type StoredReshare, type StoredShare } from './board';
import { PAGE_CHANGES, pagesVersion } from '../core/page-changes';
import { dimensions, shownTags, tagsOf, untagged } from '../core/page-tags';
import type { DemoSite } from '../adapters/types';
import { expandHome, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { type Gone, siteBase, siteMissing, siteTarget } from './site';
import { allowedHere, approvedHere, newToken, type PersonalSite, personalDemoSite, readPersonal } from './personal-site';
import { artifactCopy } from './artifact-copy';
import { GITHUB_PAGES } from './site-hosts';
import { rereadChapters, videoFacts } from './demo';
import { ARTIFACT_DIR, artifactFiles, artifactPageHtml, captionTracks, type DemoPageParts, day, demoFile, demoPageHtml, ON_DISK, PAGE_WORDS, type PageCommit, type PageLanguage, silentVideo } from './demo-page';
import { type Forge, landedUrl, parsePrUrl } from './forge';
import type { AgentRuntime } from './runtime';
import { readSession } from './koordinator';
import type { CardRow } from './db';
import { branchName, gitAsync } from './workspaces';
import { originOf } from './forgejo';
import { zip } from './zip';
import { messageOf } from '../core/text';

/** A later demo version on a page, below the first as an addendum. */
export interface PageDemo {
  title: string;
  text: string;
  kind: DemoKind;
  chapters: [number, string][];
  dir: string;
  /** When it was handed over, which its section is headed with. */
  at?: string;
}

/** What a page on the site is made of: the first demo version shared, and the later ones below it. */
export interface SharePage {
  /** Stays the same for a card, so a shared link keeps working when the page is published again. */
  slug: string;
  title: string;
  text: string;
  /** A video, or an HTML artifact. */
  kind: DemoKind;
  /** Seconds and title of each scene; none for an artifact. */
  chapters: [number, string][];
  /** The card's pull request, once it has one. */
  pr: string | null;
  /** Without a pull request: where the card's work landed on the default branch, once it has. */
  commit?: PageCommit | null;
  /** The demo's language, for the page's own words (`language` of the page templates). */
  language: PageLanguage;
  /** The demo's directory: `demo.mp4`, `poster.jpg`, `captions.vtt`; an artifact's `index.html` and the files it loads. */
  dir: string;
  /** The slugs of the other pages Obeya has stored as shared on this site: the site must still hold them. */
  shared: string[];
  /** The later demo versions on the page, in order of handover. */
  more?: PageDemo[];
  /** The page's tags from the site's vocabulary, by dimension (`tagsOf`); none where the site has none. */
  tags?: PageTags;
}

/**
 * Where a repository's demos may go: the site its settings name (none without one), its checkout,
 * and whether it is public (as its forge says), which lets it share on the owner's personal site.
 */
export interface ShareSource {
  site: DemoSite | null;
  repo: string;
  isPublic?: boolean;
}

/**
 * Where a card's pages go. Pages whose targets have the same key are on one site: a publish or
 * withdrawal names the others as shared. Keys are not stored, so they only need to stay the same
 * across a restart.
 */
export interface ShareTarget {
  key: string;
  /** An unlisted site (the owner's personal one): a page's place on it is `<token>/<slug>`. */
  unlisted?: true;
  /** The card's repository checkout. */
  repo: string;
  /**
   * The page's URL, or why it did not go out; what the target said on the way goes into the card's
   * log, and what it says while it goes on (`log`). `gone`: pages another machine withdrew, found
   * on the way.
   */
  publish(page: SharePage, log?: (text: string) => void): Promise<({ url: string; said: string } | { why: string; said: string }) & { gone?: Gone[] }>;
  withdraw(slug: string, shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
  /**
   * The pages another machine withdrew (their cards here lose their link), and the pages shared
   * from here (`shared`) that the live site lacks or has older, taken offline by another machine's
   * deployment that came in between.
   */
  audit(shared: string[]): Promise<{ gone: Gone[]; missing: string[] }>;
  /** Where the page of `slug` is, before it is published. */
  pageUrl(slug: string): string;
  /** Deploys again what this machine has, for the pages `audit` found missing. */
  repair(shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
}

/**
 * Where a site's deploy runs, under Obeya's home: not in the checkout, which is often a workspace
 * of the pool too, and a file a command leaves in its working directory (`wrangler pages deploy`
 * writes its cache there) would keep the workspace from being leased until someone cleans up.
 */
export const SHARE_CWD = 'share';

export interface SharingOptions {
  board: Board;
  runtime: AgentRuntime;
  /** Where the card's repository may share demos; null while it does not run. */
  sourceFor: (card: Item) => ShareSource | null;
  /** The owner's personal demo site on this machine; read from Obeya's home without it. */
  personal?: () => PersonalSite | null;
  /** The personal site as a demo site, how it is deployed (`personalDemoSite` without it; a stand-in in tests). */
  personalSite?: (p: PersonalSite) => DemoSite;
  /** The language the card's repository names for its demos (`demo.language` of its settings); none where it names none. */
  languageFor?: (card: Item) => PageLanguage | undefined;
  /** Obeya's data directory, passed to a site's deploy as `OBEYA_HOME`; the deploy runs in a directory of it (`SHARE_CWD`). */
  home: string;
  /** Where the card's pull request is, for the page's link in its description. */
  forge: Forge;
  /**
   * A page went out (`url`: where it is) or did not (`why`); without either, the page is at rest as
   * the card's share says. Landed work's worker may wait for its address.
   */
  onPage?: (cardId: string, r?: { url: string } | { why: string }) => void;
}

/** A site's deploy that has not finished by then is stopped (an upload of a few files takes seconds). */
export const COMMAND_TIMEOUT = 15 * 60_000;

/** The pages of all canvases go out one at a time: a site directory takes one change at a time. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export class Sharing {
  /** Comments linking a review card's page under way, by card and page: one at a time. */
  private commenting = new Set<string>();
  /** When the versions were last asked for because the owner came back. */
  private checked = 0;
  /** A page of the run sharing many again is waiting for its turn, or going out. */
  private resharing = false;
  /** Cards whose latest demo goes on their page after the share under way: what that share settles is not the end. */
  private after = new Set<string>();

  constructor(private o: SharingOptions) {}

  /**
   * "Teilen", "Auf der Seite ersetzen" or "Zur Seite dazunehmen": one of the card's demos (by its handover; the latest
   * without) is published right away, on the card's page in place of the versions there, or beside
   * them in its place by handover (`add`). A supplement on a new page or added takes along the demos
   * it supplements. A demo on the page already goes out again with the rest.
   * There is no hold to take it back: "Nicht mehr teilen" withdraws it just as easily.
   */
  share(cardId: string, { demo: handover, add = false }: { demo?: number | undefined; add?: boolean } = {}) {
    const card = this.card(cardId);
    const demo = handover === undefined ? this.demo(cardId) : this.cardDemo(cardId, { handover, dir: '' });
    if (card.prototypeOf || !demo || !this.target(card)) throw new BadRequest('noShare', 'the card has no demo, or its repository shares none');
    if (this.onPersonal(card) && !this.personalAllowed(card)) throw new BadRequest('noShare', 'the repository is private and not allowed on the personal demo site');
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    const now: DemoRef[] = s?.url ? sharedDemos(s) : [];
    const ref = refOf(demo);
    const on = now.some((d) => sameDemo(d, ref));
    // with no page yet or beside the versions there, it takes along the demos it supplements
    const next = on ? now : add || !now.length ? this.beside(cardId, now, ref) : [ref];
    this.set(cardId, { ...this.fresh(card, s), state: 'publishing', next: next.map(refOf) });
    const t = this.o.board.t.share;
    const said = !s?.url ? t.share : on ? t.again : add ? t.added : t.newDemo;
    this.o.board.log(cardId, 'state', 'owner', said);
    void serial(() => this.publish(cardId));
  }

  /**
   * The owner approved the card's work. Where its repository's site publishes on approval
   * (`demo.site.publish`), or the owner ticked the repository for it on the personal site its page
   * goes to, its latest demo goes on its page unless it is there: beside the versions
   * there where its worker said it only supplements them (with the demos it supplements), else in
   * their place. It goes out through
   * the queue like any share, so the landing does not wait for it; a failure goes into the card's
   * log. Returns the trailer for the commit that lands, for a card with a page (`Demo-Video: <url>`,
   * `Demo-Page:` for an artifact): its URL is known before the deploy is done.
   */
  approved(cardId: string): string | null {
    try {
      const trailer = this.publishApproved(cardId);
      // a review card's page, online already with its latest demo: its link goes onto the PR now
      const s = this.stored(cardId);
      const pr = this.prOf(cardId);
      const card = this.find(cardId);
      if (pr && s?.url && !s.state && card?.contribution) {
        const target = this.target(card);
        const first = sharedDemos(s)[0];
        if (target && first) void this.linkPr(cardId, pr, s.url, target.repo, first.shown.kind);
      }
      return trailer;
    } catch (e) {
      // the work lands all the same
      this.o.board.log(cardId, 'error', 'obeya', `${this.o.board.t.share.notShared}: ${messageOf(e)}`);
      return null;
    }
  }

  private publishApproved(cardId: string): string | null {
    const card = this.find(cardId);
    if (!card || card.prototypeOf) return null;
    const target = this.target(card);
    if (target && this.publishesOnApproval(card)) {
      const s = this.stored(cardId);
      if (s?.notOnApproval) this.notOnPage(cardId);
      // a share under way (one the owner chose) goes out first; the latest demo after it
      else if (s?.state === 'publishing') {
        this.after.add(cardId);
        void serial(async () => {
          this.after.delete(cardId);
          this.onPage(cardId);
          // on the page already after all: the page is where it is
          if (this.stored(cardId)?.state !== 'publishing') this.settled(cardId);
        });
      }
      else this.onPage(cardId);
    }
    // the page as it is about to be, or as it is
    const page = this.stored(cardId);
    if (!page || page.state === 'withdrawing') return null;
    const first = page.state === 'publishing' && page.next ? page.next[0] : page.url ? sharedDemos(page)[0] : undefined;
    // a page going out is where the site has it then; one at rest where it was published
    const url = page.state === 'publishing' && target ? target.pageUrl(pathOf(page)) : page.url;
    if (!first || !url) return null;
    const kind = this.cardDemo(cardId, first)?.kind ?? sharedDemos(page).find((d) => sameDemo(d, first))?.shown.kind;
    return `${kind === 'html' ? 'Demo-Page' : 'Demo-Video'}: ${url}`;
  }

  /**
   * „Mit der Freigabe teilen“, where approving shares (see `approved`): whether approving the
   * card puts its latest demo on its page. It stays with the card across handovers.
   */
  onApproval(cardId: string, on: boolean) {
    const card = this.card(cardId);
    if (card.prototypeOf) throw new BadRequest('noShare', 'prototypes are not shared');
    const { notOnApproval: _, ...s } = this.stored(cardId) ?? { slug: slugOf(card) };
    this.set(cardId, on ? s : { ...s, notOnApproval: true });
  }

  /**
   * The owner sets one dimension of the page's tags by hand: neither a worker nor the reading session
   * changes it after. It takes effect at once: a page online goes out again with it, one going out
   * gets it right after.
   */
  setTags(cardId: string, dimension: string, values: string[]) {
    const card = this.card(cardId);
    if (card.prototypeOf) throw new BadRequest('noShare', 'prototypes are not shared');
    const vocabulary = this.vocabulary(card);
    const allowed = dimensions(vocabulary).find(([d]) => d === dimension)?.[1];
    if (!allowed) throw new BadRequest('invalid', `the site has no tags of the dimension ${dimension}`);
    const wrong = values.filter((v) => !allowed.includes(v));
    if (wrong.length) throw new BadRequest('invalid', `not in the site's tags of ${dimension}: ${wrong.join(', ')}`);
    const s = this.stored(cardId) ?? { slug: slugOf(card) };
    const chosen = allowed.filter((v) => values.includes(v));
    this.setTagFields(cardId, card, { tags: { ...s.tags, [dimension]: chosen } });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.share.tagsSet(dimension, chosen));
    if (s.url && !s.state) this.refresh(cardId, true);
  }

  /** The approval of a card whose owner unticked „Mit der Freigabe teilen“: the log says so where it would have shared. */
  private notOnPage(cardId: string) {
    const demo = this.demo(cardId);
    const s = this.stored(cardId);
    if (!demo || (s?.url && sharedDemos(s).some((d) => sameDemo(d, refOf(demo))))) return;
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.notOnApproval);
  }

  /** The card's latest demo goes on its page as an approval puts it there, unless it is there already or the page is busy. */
  private onPage(cardId: string) {
    const card = this.find(cardId);
    const demo = this.demo(cardId);
    const s = this.stored(cardId);
    if (!card || !demo || s?.state) return;
    const now: DemoRef[] = s?.url ? sharedDemos(s) : [];
    const ref = refOf(demo);
    if (now.some((d) => sameDemo(d, ref))) return;
    const add = demo.follows === 'supplements';
    this.set(cardId, { ...this.fresh(card, s), state: 'publishing', next: (add ? this.beside(cardId, now, ref) : [ref]).map(refOf) });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.approved(!now.length ? 'share' : add ? 'add' : 'replace'));
    void serial(() => this.publish(cardId));
  }

  /**
   * Takes one demo version off the page (by its handover), which goes out again without it; the
   * last one, or without a handover the whole page, is withdrawn.
   */
  unshare(cardId: string, handover?: number) {
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    if (!s?.url) throw new BadRequest('notShared', 'the demo is not shared');
    const t = this.o.board.t.share;
    const now = sharedDemos(s);
    const demo = handover === undefined ? null : (this.cardDemo(cardId, { handover, dir: '' }) ?? { handover, dir: '' });
    const rest = demo ? now.filter((d) => !sameDemo(d, refOf(demo))) : [];
    if (demo && rest.length === now.length) throw new BadRequest('notShared', 'the demo is not on the page');
    if (rest.length) {
      this.set(cardId, { ...s, state: 'publishing', next: rest.map(refOf) });
      this.o.board.log(cardId, 'state', 'owner', t.unshareOne);
      void serial(() => this.publish(cardId));
      return;
    }
    this.set(cardId, { ...s, state: 'withdrawing' });
    this.o.board.log(cardId, 'state', 'owner', t.unshare);
    void serial(() => this.withdraw(cardId));
  }

  /**
   * The card's latest demo video was made anew in its directory, narrated in another language
   * (the demo skill's `--revoice`): the card shows it with its chapters read again, and its page's
   * text, written for what it said before, goes, to be written again in its language when it is
   * shared. A demo on a page is not changed under the page: it is withdrawn first.
   */
  rebuilt(cardId: string) {
    const demo = this.demo(cardId);
    if (!demo || demo.kind === 'html') throw new BadRequest('noShare', 'the card has no demo video');
    const s = this.stored(cardId);
    if (s?.state || (s?.url && sharedDemos(s).some((d) => sameDemo(d, refOf(demo))))) throw new BadRequest('shareBusy', 'the demo is on a shared page; stop sharing it first');
    const chapters = rereadChapters(demo.dir);
    if (typeof chapters === 'string') throw new BadRequest('invalid', chapters);
    const { page: _, tracks: _tracks, silent: _silent, ...rest } = demo;
    this.o.board.work(cardId, { demo: JSON.stringify({ ...rest, chapters, ...videoFacts(demo.dir) }) });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.rebuilt(this.languageOf(demo.dir, this.card(cardId))));
  }

  /**
   * The card's pull request is open: a page shared before gets its link. A share under way picks
   * it up when it is done.
   */
  prOpened(cardId: string) {
    const s = this.stored(cardId);
    const pr = this.prOf(cardId);
    if (pr && s?.url && !s.state && s.pr !== pr) this.refresh(cardId);
  }

  /**
   * The card's work landed on the default branch: a page shared before, without a pull request, gets
   * the link to its commit. A share under way picks it up when it is done.
   */
  async landed(cardId: string) {
    const card = this.find(cardId);
    const s = this.stored(cardId);
    if (!card || !s?.url || s.state) return;
    const commit = await this.commitOf(card);
    if (commit && s.commit !== commit.url && !this.stored(cardId)?.state) this.refresh(cardId);
  }

  /** After a restart: a share under way goes on, a withdrawal too. */
  resume() {
    this.convert();
    for (const { r, s } of this.shares()) {
      // one of many shared again goes on with the rest of them
      if (s.state === 'publishing' && s.again && this.o.board.reshareRun()?.queue[0] === r.id) continue;
      if (s.state === 'publishing') void serial(() => this.publish(r.id));
      else if (s.state === 'withdrawing') void serial(() => this.withdraw(r.id));
    }
    void serial(() => this.checkSites());
    this.nextAgain();
  }

  /**
   * Pages published before Obeya kept the page changes (until 2026-10-16) kept a hash of sample
   * pages instead, which says nothing about what changed: their change is read off the page as the
   * site has it (the style for an artifact alone came with the security fix, Newsreader with the
   * look), and one whose page is not there counts as published before both.
   */
  private convert() {
    const known = new Set<string>(['', ...PAGE_CHANGES.map((c) => c.id)]);
    for (const { r, s } of this.shares()) {
      if (!s.url || (s.version !== undefined && known.has(s.version))) continue;
      const card = this.find(r.id);
      const source = card && this.o.sourceFor(card);
      let page = '';
      try {
        if (source?.site) page = readFileSync(join(siteBase(this.o.home, source.site), 'site', s.slug, 'index.html'), 'utf8');
      } catch {}
      const version = page.includes('body.alone') ? '2026-10-16-alone' : page.includes('Newsreader') ? '2026-10-10-look' : '';
      const { outdated: _, ...rest } = s as StoredShare & { outdated?: true };
      this.set(r.id, { ...rest, version });
    }
    // pages from before several versions (until 2026-10-16) showed one demo: a list of one, the
    // card's demo in that directory (the latest one rendered there) named by its handover
    for (const { r, s } of this.shares()) {
      if (s.demos || !s.dir || !s.shown) continue;
      const { dir: _, shown: __, ...rest } = s;
      const demo = cardDemos(r).findLast((d) => d.dir === s.dir);
      const one: SharedDemo = { ...(demo ? refOf(demo) : { dir: s.dir }), ...(demo?.at ? { at: demo.at } : {}), dir: s.dir, shown: s.shown };
      this.set(r.id, { ...rest, demos: [one] });
    }
  }

  /**
   * "Erneut teilen" for many pages at once, from the Koordinator's sheet: the outdated pages, the
   * newest demos first, `count` of them or all. They go out one after the other, each as it shows
   * now, so a newer demo on a card still waits for its "Neu teilen"; a share the owner starts
   * meanwhile goes out between two of them.
   */
  reshareMany(count: number | null, tags = false) {
    const run = this.o.board.reshareRun();
    if (run?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again already');
    const rows = (tags ? this.o.board.untaggedRows() : this.o.board.outdatedRows().map(({ r }) => r))
      .filter((r) => this.find(r.id) && this.target(this.find(r.id)!))
      .map((r) => ({ r, s: JSON.parse(r.share!) as StoredShare }));
    if (!rows.length) throw new BadRequest('nothingOutdated', tags ? 'no shared page lacks tags' : 'no shared page is outdated');
    const made = (dir?: string) => (dir ? (statOr(join(dir, 'demo.mp4')) ?? statOr(join(dir, 'index.html')) ?? statOr(dir) ?? 0) : 0);
    // newest by the newest version on the page
    const queue = rows
      .map(({ r, s }) => ({ id: r.id, at: Math.max(0, ...sharedDemos(s).map((d) => made(d.dir))) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, count ?? undefined)
      .map((r) => r.id);
    this.o.board.setReshareRun({ queue, total: queue.length, done: 0, failed: [], ...(tags ? { tags: true as const } : {}) });
    this.nextAgain();
  }

  /** Stops sharing many again: the page going out finishes, the rest stay as they are. */
  stopResharing() {
    const run = this.o.board.reshareRun();
    if (!run?.queue.length) return;
    const going = this.resharing && this.stored(run.queue[0]!)?.state === 'publishing' ? [run.queue[0]!] : [];
    this.o.board.setReshareRun({ ...run, queue: going, stopped: true });
  }

  /** "Ausblenden": puts away what the finished run says, and the notice of outdated pages until a newer change. */
  dismissResharing() {
    const run = this.o.board.reshareRun();
    if (run?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again');
    // a run tagging pages leaves the notice of outdated pages as it is
    if (run?.tags) this.o.board.setReshareRun(null);
    else this.o.board.dismissOutdated();
  }

  /** The next page of the run sharing many again, once the site is free. */
  private nextAgain() {
    if (this.resharing || !this.o.board.reshareRun()?.queue.length) return;
    this.resharing = true;
    void serial(() => this.again()).finally(() => {
      this.resharing = false;
      this.nextAgain();
    });
  }

  private async again() {
    const id = this.o.board.reshareRun()?.queue[0];
    if (!id) return;
    const s = this.stored(id);
    const tags = !!this.o.board.reshareRun()?.tags;
    let ok: boolean | null = null;
    if (s?.state === 'publishing' && s.again) ok = await this.publish(id);
    else {
      const row = this.find(id) && this.o.board.row(id);
      // one that got its tags meanwhile, or is up to date, no longer counts
      const still = row && (tags ? this.o.board.untaggedRows().some((r) => r.id === id) : reshareable(row).length > 0);
      if (s && still) {
        this.set(id, { ...s, state: 'publishing', refresh: true, again: true });
        this.o.board.log(id, 'state', 'owner', tags ? this.o.board.t.share.tagging : this.o.board.t.share.againWithOthers);
        ok = await this.publish(id);
      }
    }
    // shared again meanwhile on its own, withdrawn or gone: it no longer counts
    const run = this.o.board.reshareRun();
    if (!run) return;
    const next: StoredReshare = { ...run, queue: run.queue.filter((x) => x !== id) };
    if (ok === true) next.done++;
    else if (ok === false) next.failed = [...next.failed, id];
    else next.total--;
    this.o.board.setReshareRun(next);
  }

  /**
   * The owner came back to Obeya: each site is asked again (at most once a minute) which pages
   * another machine withdrew, or took offline.
   */
  soon() {
    if (Date.now() - this.checked < 60_000) return;
    this.checked = Date.now();
    void serial(() => this.checkSites());
  }

  /**
   * Asks each site with pages out which of them another machine withdrew (their cards lose their
   * link), or took offline (deployed again).
   */
  async checkSites() {
    const targets = new Map<string, ShareTarget>();
    for (const { r, s } of this.shares()) {
      const card = this.find(r.id);
      const target = card && s.url ? this.target(card) : null;
      if (target) targets.set(target.key, target);
    }
    for (const target of targets.values()) {
      const shared = this.others('', target.key);
      const { gone, missing } = await target.audit(shared);
      this.lost(target.key, gone);
      if (missing.length) await this.repair(target, shared, missing);
    }
  }

  /** Pages shared from here that another machine's deployment took offline: deployed again, a line on each card. */
  private async repair(target: ShareTarget, shared: string[], missing: string[]) {
    const ids = this.shares()
      .filter(({ s }) => missing.includes(pathOf(s)))
      .map(({ r }) => r.id);
    const log = (kind: 'activity' | 'state' | 'error', text: string) => ids.forEach((id) => this.o.board.log(id, kind, 'obeya', text));
    const t = this.o.board.t.share;
    const r = await target.repair(shared, (text) => log('activity', text));
    this.lost(target.key, r.gone);
    if (r.why) return log('error', [t.notRestored(r.why), r.said].filter(Boolean).join('\n\n'));
    if (r.said) log('activity', r.said);
    log('state', t.restored);
  }

  /** Pages withdrawn on another machine: their cards here lose their link. */
  private lost(key: string, gone: Gone[] = []) {
    for (const g of gone) {
      const { r, s } = this.shares().find(({ s }) => pathOf(s) === g.slug) ?? {};
      const card = r && this.find(r.id);
      if (!r || !s?.url || s.state || !card || this.target(card)?.key !== key) continue;
      this.set(r.id, { slug: s.slug, ...(s.token ? { token: s.token } : {}) });
      this.o.board.log(r.id, 'state', 'obeya', this.o.board.t.share.withdrawnElsewhere(g.machine));
    }
  }

  /** Publishes again what the page shows, with the pull request's link, or with the tags the owner set (`retag`). */
  private refresh(cardId: string, retag = false) {
    const s = this.stored(cardId);
    if (!s?.url || s.state) return;
    this.set(cardId, { ...s, state: 'publishing', refresh: true, ...(retag ? { retag: true as const } : {}) });
    void serial(() => this.publish(cardId));
  }

  /** Publishes the card's page; whether it went out (null: nothing to publish). */
  private async publish(cardId: string): Promise<boolean | null> {
    const s = this.stored(cardId);
    const card = this.find(cardId);
    if (s?.state !== 'publishing' || !card) return null;
    const t = this.o.board.t.share;
    const failed = s.again ? t.notAgain : s.retag ? t.notShared : s.refresh ? t.notLinked : t.notShared;
    const back = (why: string, out = '') => {
      this.set(cardId, atRest(s));
      this.o.board.log(cardId, 'error', 'obeya', [`${failed}: ${why}`, out].filter(Boolean).join('\n\n'));
      this.settled(cardId, { why });
      return false;
    };
    const target = this.target(card);
    // a private repository unticked since: its page may be withdrawn, but nothing more goes out
    if (s.personal && !this.personalAllowed(card)) return back(t.privateNotAllowed);
    let demos: SharedDemo[];
    if (s.refresh) {
      // the page as it is: a newer demo on the card waits for "Auf der Seite ersetzen" or "Zur Seite dazunehmen"
      demos = sharedDemos(s);
      if (!demos.length || !target) {
        if (s.again) return back(t.demoGone);
        this.set(cardId, atRest(s));
        this.o.board.log(cardId, 'activity', 'obeya', t.linkLater);
        this.settled(cardId, s.url ? { url: s.url } : { why: t.noDemo });
        return null;
      }
    } else {
      // the versions the owner chose; a share from before them (until 2026-10-16) meant the latest demo
      const latest = this.demo(cardId);
      const want = s.next ?? (latest ? [refOf(latest)] : []);
      if (!want.length || !target) return back(t.noDemo);
      demos = [];
      for (const ref of want) {
        const kept = s.url ? sharedDemos(s).find((d) => sameDemo(d, ref)) : undefined;
        if (kept) {
          demos.push(kept);
          continue;
        }
        const demo = this.cardDemo(cardId, ref);
        if (!demo) return back(t.noDemo);
        // a page written now chooses the tags the card's page lacks along with its text
        const page = await this.page(card, demo, this.missingTags(card));
        demos.push({ ...refOf(demo), ...(demo.at ? { at: demo.at } : {}), shown: { title: page.title, text: page.text, chapters: demo.chapters, kind: demo.kind } });
      }
    }
    const [first, ...later] = demos as [SharedDemo, ...SharedDemo[]];
    const vocabulary = this.vocabulary(card);
    const lacking = this.missingTags(card);
    if (lacking) await this.chooseTags(card, demos, lacking);
    const tags = tagsOf(pageTagsOf(this.o.board.row(cardId)), vocabulary);
    const pr = this.prOf(cardId);
    const commit = pr ? null : await this.commitOf(card);
    const input: SharePage = {
      slug: pathOf(s),
      ...first.shown,
      pr,
      ...(commit ? { commit } : {}),
      language: this.languageOf(first.dir, card),
      dir: first.dir,
      shared: this.others(cardId, target.key),
      ...(later.length ? { more: later.map((d) => ({ ...d.shown, dir: d.dir, ...(d.at ? { at: d.at } : {}) })) } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
    };
    const r = await target.publish(input, (text) => this.o.board.log(cardId, 'activity', 'obeya', text));
    this.lost(target.key, r.gone);
    if ('why' in r) return back(r.why, r.said);
    const { url } = r;
    this.set(cardId, { slug: s.slug, url, demos, ...(pr ? { pr } : {}), ...(commit ? { commit: commit.url } : {}), version: pagesVersion(), ...kept(s), ...(s.personal ? { personal: true as const } : {}) });
    if (r.said) this.o.board.log(cardId, 'activity', 'obeya', r.said);
    this.o.board.log(cardId, 'state', 'obeya', s.again ? t.sharedAgain(url) : s.retag ? t.retagged(url) : s.refresh ? (pr ? t.linksPr(url) : t.linksCommit(url)) : t.shared(url));
    this.settled(cardId, { url });
    if (pr) await this.linkPr(cardId, pr, url, target.repo, first.shown.kind);
    // the pull request was opened or the work landed while the page went out, or the owner changed its tags: once more, with them
    const now = this.prOf(cardId);
    const landed = !now && (await this.commitOf(card))?.url;
    const retag = JSON.stringify(tagsOf(pageTagsOf(this.o.board.row(cardId)), vocabulary)) !== JSON.stringify(tags);
    if ((now && now !== pr) || (landed && landed !== commit?.url) || retag) this.refresh(cardId, retag);
    return true;
  }

  /**
   * Puts the page's link into the pull request's description, unless it is there already (the
   * worker put it there, or Obeya did before). A line of Obeya's own is found again by its marker.
   */
  private async linkPr(cardId: string, pr: string, url: string, cwd: string, kind: DemoKind) {
    const n = parsePrUrl(pr)?.number;
    const row = this.o.board.row(cardId);
    const review = contributionOf(row);
    if (review) {
      // a review card's PR is the contributor's: its description stays theirs, and the link comes as a comment, once the owner approved
      const key = `${cardId}\n${url}`;
      if (!review.approved || review.linked === url || this.commenting.has(key)) return;
      // marked once the comment is there: a restart before then comments at the next approval
      this.commenting.add(key);
      const t = MESSAGES[this.languageOf(this.demo(cardId)?.dir ?? '', this.card(cardId))].share;
      try {
        const at = await this.o.forge.comment(cwd, pr, t.prComment(kind === 'html', url));
        const now = contributionOf(this.o.board.row(cardId));
        if (now) this.o.board.work(cardId, { contribution: JSON.stringify({ ...now, linked: url }) });
        this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.prCommented(n, at || pr));
      } catch (e) {
        this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.share.prNotCommented(n, messageOf(e)));
      } finally {
        this.commenting.delete(key);
      }
      return;
    }
    try {
      const body = withDemoLink(await this.o.forge.body(cwd, pr), url, kind, this.o.board.t);
      if (body === null) return;
      await this.o.forge.setBody(cwd, pr, body);
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.prLinked(n, pr));
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.share.prNotLinked(n, messageOf(e)));
    }
  }

  private async withdraw(cardId: string) {
    const s = this.stored(cardId);
    const card = this.find(cardId);
    if (s?.state !== 'withdrawing' || !card) return;
    const back = (why: string, out = '') => {
      this.set(cardId, atRest(s));
      this.o.board.log(cardId, 'error', 'obeya', [why, out].filter(Boolean).join('\n\n'));
    };
    const target = this.target(card);
    const t = this.o.board.t.share;
    if (!target) return back(t.notWithdrawnNoShare);
    const r = await target.withdraw(pathOf(s), this.others(cardId, target.key), (text) => this.o.board.log(cardId, 'activity', 'obeya', text));
    this.lost(target.key, r.gone);
    if (r.why) return back(r.why, r.said);
    this.set(cardId, { slug: s.slug, ...kept(s) });
    if (r.said) this.o.board.log(cardId, 'activity', 'obeya', r.said);
    this.o.board.log(cardId, 'state', 'obeya', t.withdrawn);
  }

  /**
   * The card's demo as a file to pass on, for a repository without a share target: the page in a
   * ZIP with the video, poster and captions beside it, or one HTML file that holds them all (videos
   * up to EXPORT_HTML_MAX). An HTML artifact goes beside its page in the ZIP, or into the one file
   * when it is its `index.html` alone. Nothing leaves Obeya, so nothing is held.
   */
  async export(cardId: string, as: 'zip' | 'html', handover?: number): Promise<{ name: string; type: string; data: Uint8Array<ArrayBuffer> }> {
    const card = this.card(cardId);
    const demo = handover === undefined ? this.demo(cardId) : this.cardDemo(cardId, { handover, dir: '' });
    if (demo?.kind === 'html' && !card.prototypeOf) return this.exportArtifact(card, demo, as);
    const video = demo && demoFile(demo.dir, 'demo.mp4');
    if (card.prototypeOf || !demo || !video || !existsSync(video)) throw new BadRequest('noShare', 'the card has no demo');
    const size = statSync(video).size;
    if (as === 'html' && size > EXPORT_HTML_MAX)
      throw new BadRequest('exportTooLarge', `the video is ${(size / 1024 / 1024).toFixed(1)} MiB; one HTML file takes at most ${EXPORT_HTML_MAX / 1024 / 1024} MiB`);
    const page = await this.page(card, demo);
    const slug = this.stored(cardId)?.slug ?? slugOf(card);
    const file = (f: string) => {
      const path = demoFile(demo.dir, f);
      return path ? new Uint8Array(readFileSync(path)) : null;
    };
    const poster = file('poster.jpg');
    const language = this.languageOf(demo.dir, card);
    // every caption track goes with it; one from before the tracks is in the demo's language
    const tracks = captionTracks(demo.dir).flatMap((t) => {
      const data = file(t.file);
      return data ? [{ file: t.file, language: t.language ?? language, data }] : [];
    });
    const parts: Omit<DemoPageParts, 'video' | 'poster'> = {
      title: page.title,
      text: page.text,
      chapters: demo.chapters,
      pr: this.prOf(cardId),
      commit: await this.commitOf(card),
      when: PAGE_WORDS[language].demoOf(day(statSync(video).mtime, language)),
      tabTitle: page.title,
      language,
      // a page opened from disk may not load a caption file
      tracks: tracks.map((t) => ({ language: t.language, vtt: new TextDecoder().decode(t.data) })),
      ...(silentVideo(video) ? { silent: true } : {}),
    };
    let out: { name: string; type: string; data: Uint8Array<ArrayBuffer> };
    if (as === 'html') {
      const html = demoPageHtml({
        ...parts,
        video: { base64: Buffer.from(readFileSync(video)).toString('base64') },
        ...(poster ? { poster: `data:image/jpeg;base64,${Buffer.from(poster).toString('base64')}` } : {}),
      });
      out = { name: `${slug}.html`, type: 'text/html; charset=utf-8', data: new TextEncoder().encode(html) };
    } else {
      const html = demoPageHtml({ ...parts, video: { src: 'demo.mp4' }, ...(poster ? { poster: 'poster.jpg' } : {}) });
      const entries = [
        { name: `${slug}/index.html`, data: new TextEncoder().encode(html) },
        { name: `${slug}/demo.mp4`, data: new Uint8Array(readFileSync(video)) },
        ...(poster ? [{ name: `${slug}/poster.jpg`, data: poster }] : []),
        ...tracks.map((t) => ({ name: `${slug}/${t.file}`, data: t.data })),
      ];
      out = { name: `${slug}.zip`, type: 'application/zip', data: zip(entries) };
    }
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.share.exported(as === 'zip', out.name));
    return out;
  }

  private async exportArtifact(card: Item, demo: Demo & { dir: string }, as: 'zip' | 'html') {
    const files = artifactFiles(demo.dir);
    if (!files.includes('index.html')) throw new BadRequest('noShare', 'the card has no demo');
    if (as === 'html' && files.length > 1) throw new BadRequest('exportNotAlone', 'the artifact loads files beside its index.html; it goes out as a ZIP only');
    const page = await this.page(card, demo);
    const slug = this.stored(card.id)?.slug ?? slugOf(card);
    const index = readFileSync(join(demo.dir, 'index.html'), 'utf8');
    const language = this.languageOf(demo.dir, card);
    const when = PAGE_WORDS[language].demoOf(day(statSync(join(demo.dir, 'index.html')).mtime, language));
    const parts = { title: page.title, text: page.text, pr: this.prOf(card.id), commit: await this.commitOf(card), when, tabTitle: page.title, language };
    let out: { name: string; type: string; data: Uint8Array<ArrayBuffer> };
    if (as === 'html') {
      out = { name: `${slug}.html`, type: 'text/html; charset=utf-8', data: new TextEncoder().encode(artifactPageHtml({ ...parts, artifact: { html: index } })) };
    } else {
      const copy = await artifactCopy(demo.dir, files, ON_DISK);
      const entries = [
        { name: `${slug}/index.html`, data: new TextEncoder().encode(artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` }, disk: true })) },
        ...files.map((f) => ({
          name: `${slug}/${ARTIFACT_DIR}/${f}`,
          data: copy.has(f) ? new TextEncoder().encode(copy.get(f)) : new Uint8Array(readFileSync(join(demo.dir, f))),
        })),
      ];
      out = { name: `${slug}.zip`, type: 'application/zip', data: zip(entries) };
    }
    this.o.board.log(card.id, 'state', 'owner', this.o.board.t.share.exported(as === 'zip', out.name));
    return out;
  }

  /**
   * The page's title and text: the worker's, else written now and kept with the demo, so it is not
   * written again; a page written now chooses the tags the card's page lacks (`lacking`) along with it.
   */
  private async page(card: Item, demo: Demo & { dir: string }, lacking: PageTags | null = null): Promise<DemoPage> {
    if (demo.page) return demo.page;
    const { tags, ...page } = await this.writePage(card, demo, this.languageOf(demo.dir, card), lacking);
    if (tags) this.chosen(card.id, tags);
    const row = this.o.board.row(card.id);
    const latest = this.demo(card.id);
    if (latest && sameDemo(latest, demo)) this.o.board.work(card.id, { demo: JSON.stringify({ ...latest, page }) });
    else if (row.demos)
      this.o.board.work(card.id, { demos: JSON.stringify((JSON.parse(row.demos) as StoredDemo[]).map((d) => (sameDemo(d, demo) ? { ...d, page } : d))) });
    return page;
  }

  /**
   * The page's text for a demo handed over without one (its repository did not share then): a short
   * session writes it from the worker's summary. Without one, the card's title and the summary's start stand in.
   */
  private async writePage(card: Item, demo: Demo, language: PageLanguage, lacking: PageTags | null): Promise<DemoPage> {
    // a card's summary goes with its approval; the log keeps every handover
    const summary = this.o.board.summary(card.id) ?? this.o.board.events(card.id).filter((e) => e.kind === 'review' && e.author === 'worker').at(-1)?.text ?? '';
    const fallback: DemoPage = { title: plainText(card.title), text: plainText(summary).split(/(?<=[.!?])\s+/).slice(0, 4).join(' ') || plainText(card.title) };
    let page: DemoPage | null = null;
    await readSession(this.o.runtime, {
      cwd: this.target(card)?.repo ?? this.o.home,
      role: 'chores',
      system: pageSystem(LANGUAGE_NAMES[language], lacking),
      tools: (finish) => [
        {
          name: 'page',
          description: `The page's title and text, in ${LANGUAGE_NAMES[language]}${lacking ? `, and its tags: ${TAGS_FIELD}` : ''}.`,
          schema: { title: z.string(), text: z.string(), ...(lacking ? { tags: tagsSchema(lacking) } : {}) },
          run: ({ title, text, tags }) => {
            if (page) return 'Already written.';
            page = {
              title: String(title).trim().slice(0, 200) || fallback.title,
              text: String(text).trim().slice(0, 2000) || fallback.text,
              ...(lacking ? { tags: picked(tags, lacking) } : {}),
            };
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        `The card: “${plainText(card.title)}”.`,
        card.body.trim() ? `Its task:\n${card.body.trim().slice(0, 3000)}` : '',
        summary ? `What its worker handed over:\n${summary.slice(0, 4000)}` : '',
        demo.kind === 'html'
          ? 'The demo is a page to look at (an HTML artifact: charts, a comparison, an analysis), not a video.'
          : demo.chapters.length
            ? `The demo video's chapters: ${demo.chapters.map(([, t]) => t).join(' · ')}`
            : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    return page ?? fallback;
  }

  /**
   * The tags the card's page lacks for the site's vocabulary (each such dimension with its values),
   * chosen by a short session from the title and text of its demos; it chooses only those, so what
   * the owner or a worker chose stays. Without an answer they stay lacking.
   */
  private async chooseTags(card: Item, demos: SharedDemo[], lacking: PageTags) {
    let tags: PageTags | null = null;
    await readSession(this.o.runtime, {
      cwd: this.target(card)?.repo ?? this.o.home,
      role: 'chores',
      system: TAGS_SYSTEM,
      tools: (finish) => [
        {
          name: 'tags',
          description: `The page's tags: ${TAGS_FIELD}.`,
          schema: { tags: tagsSchema(lacking) },
          run: ({ tags: given }) => {
            if (tags) return 'Already chosen.';
            tags = picked(given, lacking);
            return finish('Recorded. End your turn now.');
          },
        },
      ],
      brief: [
        `The dimensions to choose for, each with its values:\n${dimensions(lacking)
          .map(([d, v]) => `- ${d}: ${v.join(', ')}`)
          .join('\n')}`,
        ...demos.map((d, i) => `${i ? 'A later demo on the page' : 'The page'}: “${d.shown.title}”\n${d.shown.text}`),
      ].join('\n\n'),
    });
    if (tags) this.chosen(card.id, tags);
  }

  /**
   * Keeps the tags the reading session chose: each dimension of them in place of what the card had
   * of it (which lacked a value the vocabulary has), below what a worker or the owner chooses later.
   */
  private chosen(cardId: string, tags: PageTags) {
    const row = this.o.board.row(cardId);
    const without = (t: PageTags | undefined) => (t ? Object.fromEntries(Object.entries(t).filter(([d]) => !(d in tags))) : undefined);
    const page = <D extends Demo>(d: D): D => (d.page?.tags ? { ...d, page: { ...d.page, tags: without(d.page.tags) } } : d);
    if (row.demo) this.o.board.work(cardId, { demo: JSON.stringify(page(JSON.parse(row.demo) as StoredDemo)) });
    if (row.demos) this.o.board.work(cardId, { demos: JSON.stringify((JSON.parse(row.demos) as StoredDemo[]).map(page)) });
    const s = this.stored(cardId);
    this.setTagFields(cardId, this.card(cardId), { tags: without(s?.tags) ?? {}, auto: { ...s?.auto, ...tags } });
    this.o.board.log(cardId, 'activity', 'obeya', this.o.board.t.share.tagsChosen(shownTags(tags, tags).map(([d, v]) => `${d}: ${v.join(', ')}`).join(' · ') || '–'));
  }

  /** The site's vocabulary of tags for the card's page; none where its repository names none, or the page is on the personal site. */
  private vocabulary(card: Item): PageTags | undefined {
    if (this.onPersonal(card)) return undefined;
    const v = this.o.sourceFor(card)?.site?.tags;
    return v && dimensions(v).length ? v : undefined;
  }

  /** The dimensions of the vocabulary the card's page lacks tags for, each with its values; null where it lacks none. */
  private missingTags(card: Item): PageTags | null {
    const vocabulary = this.vocabulary(card);
    const lacking = untagged(pageTagsOf(this.o.board.row(card.id)), vocabulary);
    return lacking.length ? Object.fromEntries(lacking.map((d) => [d, vocabulary![d]!])) : null;
  }

  /** The slugs of the other pages shared through the target. */
  private others(cardId: string, key: string): string[] {
    return this.shares()
      .filter(({ r }) => r.id !== cardId)
      .flatMap(({ r, s }) => {
        const card = this.find(r.id);
        return s.url && s.state !== 'withdrawing' && card && this.target(card)?.key === key ? [pathOf(s)] : [];
      })
      .sort();
  }

  /**
   * Where the card's page goes: where it is, once it is out or going out; else its repository's
   * site, where this machine can deploy to it, else the owner's personal site, where the repository
   * may share there (public, or ticked). Null where none takes it: its demos are exported.
   */
  private target(card: Item): ShareTarget | null {
    const s = this.stored(card.id);
    if (s?.url || s?.state) return s.personal ? this.personalTarget(card) : this.ownTarget(card);
    return this.ownTarget(card) ?? (this.personalAllowed(card) ? this.personalTarget(card) : null);
  }

  /** The card's repository's own site, where this machine has its credentials. */
  private ownTarget(card: Item): ShareTarget | null {
    const src = this.o.sourceFor(card);
    if (!src?.site || siteMissing(this.o.home, src.site)) return null;
    const language = this.o.languageFor?.(card);
    return siteTarget(src.site, src.repo, this.o.home, this.o.board.t.share, language ? { language } : {});
  }

  /**
   * The owner's personal site, unlisted, where this machine is connected to it and has its
   * credentials; none for a page that went out on another personal site (this machine was connected
   * to another one since).
   */
  private personalTarget(card: Item): ShareTarget | null {
    const src = this.o.sourceFor(card);
    const p = this.personal();
    if (!src || !p) return null;
    const url = this.stored(card.id)?.url;
    if (url && !url.startsWith(`${p.url.replace(/\/+$/, '')}/`)) return null;
    const site = (this.o.personalSite ?? personalDemoSite)(p);
    if (siteMissing(this.o.home, site)) return null;
    const language = this.o.languageFor?.(card);
    return siteTarget(site, src.repo, this.o.home, this.o.board.t.share, { ...(p.secret ? { unlisted: { secret: p.secret } } : {}), ...(language ? { language } : {}) });
  }

  private personal(): PersonalSite | null {
    return this.o.personal ? this.o.personal() : readPersonal(this.o.home);
  }

  /** Whether the card's repository may share on the personal site: a public one, or a private one the owner ticked. */
  private personalAllowed(card: Item): boolean {
    const src = this.o.sourceFor(card);
    const p = this.personal();
    return !!src && !!p && allowedHere(p, src.repo, !!src.isPublic);
  }

  /** Whether approving the card puts its latest demo on its page: its site publishes on approval, or the personal site, where its page goes, has its repository ticked for it. */
  private publishesOnApproval(card: Item): boolean {
    const src = this.o.sourceFor(card);
    if (!src) return false;
    if (src.site?.publish === 'approved') return true;
    const p = this.personal();
    return !!p && approvedHere(p, src.repo) && this.onPersonal(card);
  }

  /** Whether the card's page is, or would go, on the personal site. */
  private onPersonal(card: Item): boolean {
    const s = this.stored(card.id);
    return s?.url || s?.state ? !!s.personal : !this.ownTarget(card) && this.personalAllowed(card);
  }

  /**
   * The card's share as a publish starts from it: a page that is out stays where it is; a new one
   * goes where `target` says, on the personal site with the random part of its address, drawn once
   * for the card, so its link stays the same when it is shared again.
   */
  private fresh(card: Item, s: StoredShare | null): StoredShare {
    const { personal: _, ...base } = s ? atRest(s) : { slug: slugOf(card) };
    if (s?.url) return atRest(s);
    if (!this.onPersonal(card)) return base;
    // a listed personal site (a public repository) has no random part in its addresses
    return this.personal()?.secret ? { ...base, personal: true, token: base.token ?? newToken() } : { ...base, personal: true };
  }

  private card(cardId: string): Item {
    const card = this.o.board.card(cardId);
    if (!card) throw new BadRequest('unknownCard', 'unknown card');
    return card;
  }

  /** A card on the canvas or in the archive; none once it was deleted. */
  private find(cardId: string): Item | undefined {
    try {
      return this.o.board.card(cardId);
    } catch {
      return undefined;
    }
  }

  /**
   * Where the card's work landed on the default branch without a pull request, on the forge of its
   * repository's `origin`: its commit, or for several the comparison over them; null before it
   * landed, with a pull request, or where `origin` is no forge.
   */
  private async commitOf(card: Item): Promise<PageCommit | null> {
    const row = this.o.board.row(card.id);
    const shipped = row.shipped ? (JSON.parse(row.shipped) as Shipped) : null;
    const repo = this.o.sourceFor(card)?.repo;
    if (!shipped?.commit || shipped.pr || this.prOf(card.id) || !repo) return null;
    const remote = await originOf(repo);
    if (!remote) return null;
    // the checkout may not have them (pushed from the card's clone): then the last commit stands for them
    const count = shipped.base ? Number(await gitAsync(repo, 'rev-list', '--count', `${shipped.base}..${shipped.commit}`).catch(() => '1')) : 1;
    const url = landedUrl(remote, shipped.commit, count > 1 ? shipped.base : undefined);
    return url ? { url, ...(count > 1 ? { several: true as const } : {}) } : null;
  }

  /** The card's pull request, once its worker opened it. */
  private prOf(cardId: string): string | null {
    const pr = this.o.board.row(cardId).pr;
    return pr ? ((JSON.parse(pr) as PrState).url ?? null) : null;
  }

  /**
   * The language a demo is in: the one its `index.html` names (the report page of a video, which the
   * director writes in the narration language, or the artifact itself), else the language the
   * card's repository names for its demos, else the narration language of the demo settings.
   */
  private languageOf(dir: string, card: Item): PageLanguage {
    try {
      const lang = /<html\b[^>]*\blang=["']?([a-z]{2})/i.exec(readFileSync(join(dir, 'index.html'), 'utf8').slice(0, 2000))?.[1]?.toLowerCase();
      if (lang === 'de' || lang === 'en') return lang;
    } catch {}
    return this.o.languageFor?.(card) ?? readDemoSettings(this.o.home).language;
  }

  /** One of the card's demos a page may show (`cardDemos`), by its handover, else by its directory. */
  /** The versions on the page, the demo and the ones it supplements (`withSupplemented`), in order of handover. */
  private beside(cardId: string, now: DemoRef[], ref: DemoRef): DemoRef[] {
    const all = cardDemos(this.o.board.row(cardId));
    const i = all.findLastIndex((d) => sameDemo(d, ref));
    const along = i < 0 ? [ref] : withSupplemented(all, i).map(refOf);
    return inOrder([...now, ...along.filter((d) => !now.some((n) => sameDemo(n, d)))]);
  }

  private cardDemo(cardId: string, ref: DemoRef): StoredDemo | null {
    return cardDemos(this.o.board.row(cardId)).findLast((d) => sameDemo(d, ref)) ?? null;
  }

  private demo(cardId: string): (Demo & { dir: string }) | null {
    const d = this.o.board.row(cardId).demo;
    return d ? (JSON.parse(d) as Demo & { dir: string }) : null;
  }

  /** The cards of the canvas, archived ones too, that were ever shared or are about to be, with their shares. */
  private shares(): { r: CardRow; s: StoredShare }[] {
    return this.o.board.sharedRows().map((r) => ({ r, s: JSON.parse(r.share!) as StoredShare }));
  }

  private stored(cardId: string): StoredShare | null {
    if (!this.find(cardId)) return null;
    const s = this.o.board.row(cardId).share;
    return s ? (JSON.parse(s) as StoredShare) : null;
  }

  /** The card's page is at rest: those waiting for it hear so, unless its latest demo goes out after it. */
  private settled(cardId: string, r?: { url: string } | { why: string }) {
    if (!this.after.has(cardId)) this.o.onPage?.(cardId, r);
  }

  /**
   * Stores the card's share. The page's tags stay as they are (`setTags`, `chosen` change them): a
   * share read before the owner changed them, while its page went out, would bring the old ones back.
   */
  private set(cardId: string, { tags: _, auto: __, ...s }: StoredShare) {
    const now = this.stored(cardId);
    this.o.board.work(cardId, { share: JSON.stringify({ ...s, ...(now?.tags ? { tags: now.tags } : {}), ...(now?.auto ? { auto: now.auto } : {}) }) });
  }

  /** Changes the page's tags the owner set by hand, or the reading session chose. */
  private setTagFields(cardId: string, card: Item, fields: Pick<StoredShare, 'tags' | 'auto'>) {
    const s = this.stored(cardId) ?? { slug: slugOf(card) };
    this.o.board.work(cardId, { share: JSON.stringify({ ...s, ...fields }) });
  }
}

const pageSystem = (language: string, lacking: PageTags | null) => `You write the page on which the demo of a change (a video, or a page with charts or an analysis) is shared with colleagues of the team. They have never seen the tool the change was planned in, its cards or plan docs; they know the product. Read the card's task and its worker's summary, and call the tool page once with:
- title: what changes, for a user of the product, in a few words (not the card's internal wording).
- text: two to five sentences in ${language}: what changes for the user and why. No findings, no test details, no internal process (cards, workers, demos, reviews), no markdown.${
  lacking
    ? `
- tags: for each of these dimensions, the values that fit the change (an empty list where none does), from these alone:
${dimensions(lacking)
  .map(([d, v]) => `  - ${d}: ${v.join(', ')}`)
  .join('\n')}`
    : ''
}
Then end your turn. Read code only if the summary leaves unclear what the change does for the user.`;

const TAGS_SYSTEM = `You tag the page on which the demo of a change is shared with colleagues, so they find it among many by its tags. Read the page's title and text, and call the tool tags once: for each dimension the brief names, the values that fit the change (an empty list where none does), from its values alone. Then end your turn.`;

const TAGS_FIELD = 'for each dimension, the values that fit (an empty list where none does), only from the values given for it';

const tagsSchema = (lacking: PageTags) =>
  z
    .record(z.string(), z.array(z.string()))
    .describe(
      dimensions(lacking)
        .map(([d, v]) => `${d}: ${v.join(', ')}`)
        .join('; '),
    );

/** The tags a session gave, kept to the dimensions and values asked for; a dimension it left out has none. */
function picked(given: unknown, lacking: PageTags): PageTags {
  const g = (given && typeof given === 'object' ? given : {}) as Record<string, unknown>;
  return Object.fromEntries(dimensions(lacking).map(([d, values]) => [d, values.filter((v) => Array.isArray(g[d]) && (g[d] as unknown[]).includes(v))]));
}

/** A share at rest: neither held, nor publishing, nor withdrawing. */
function atRest({ state: _, refresh: __, again: ___, next: ____, retag: _____, ...s }: StoredShare): StoredShare {
  return s;
}

/** What a share keeps when its page is made anew or withdrawn: the owner's choices, and the random part of its address on the personal site. */
const kept = (s: StoredShare): Pick<StoredShare, 'notOnApproval' | 'token'> => ({ ...(s.notOnApproval ? { notOnApproval: true as const } : {}), ...(s.token ? { token: s.token } : {}) });

/** The page's place on its site: its slug, on the personal site behind the random part of its address. */
const pathOf = (s: StoredShare) => (s.personal && s.token ? `${s.token}/${s.slug}` : s.slug);

/** What names a demo among the card's: its handover, and its directory. */
const refOf = (d: DemoRef): DemoRef => ({ ...(d.handover !== undefined ? { handover: d.handover } : {}), dir: d.dir });

/** Demo versions in order of handover; one without (from before handovers were kept) comes first. */
const inOrder = <T extends DemoRef>(demos: T[]): T[] => [...demos].sort((a, b) => (a.handover ?? -1) - (b.handover ?? -1));

/** When the file was last written, in ms; null when it is not there. */
function statOr(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Marks the line Obeya put into a pull request's description, so it is found again. */
export const DEMO_MARKER = '<!-- obeya:demo -->';

/** The description with a line linking the demo's page; null when it links the page already. */
export function withDemoLink(body: string, url: string, kind: DemoKind = 'video', t: Messages = MESSAGES.de): string | null {
  if (body.includes(url)) return null;
  const line = `${t.share.prLine(kind === 'html')}: ${url} ${DEMO_MARKER}`;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.includes(DEMO_MARKER));
  if (i >= 0) {
    lines[i] = line;
    return lines.join('\n');
  }
  return body.trim() ? `${body.trimEnd()}\n\n${line}\n` : `${line}\n`;
}

/** A card's page keeps this slug for good: a shared link stays the same, and an export is named by it. */
const slugOf = (card: Item) => branchName(card.title, card.id).slice('obeya/'.length);

/** The words of a command line, as a shell would split it where quotes ("…", '…') keep spaces. */
export const commandWords = (line: string): string[] => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);

/**
 * Argv whose program, given as a path, is found in the repository (`~` is the home directory), and
 * a script (`.ts`, `.js`) runs with Obeya's own Bun, on every platform.
 */
export function scriptArgv(words: string[], repoPath: string): string[] {
  if (!words.length) return [];
  let [program, ...rest] = words as [string, ...string[]];
  // bunx is Obeya's own Bun too: an installation of Obeya may have no bunx on the PATH
  if (program === 'bunx') return [process.execPath, 'x', ...rest];
  program = expandHome(program);
  const script = /\.(m?[jt]sx?|cjs)$/.test(program);
  if ((script || /[\\/]/.test(program)) && !isAbsolute(program)) program = resolve(repoPath, program);
  return script ? [process.execPath, program, ...rest] : [program, ...rest];
}

/** What the demo site lacks to be shared on (a title, an http(s) URL, a deploy command); null where it has it. */
export function siteIncomplete(site: DemoSite): string | null {
  if (!site.title.trim()) return 'demo.site.title: missing';
  if (!/^https?:\/\/[^\s/]+[^\s]*$/.test(site.url)) return 'demo.site.url: expected an http(s) URL';
  if (!site.deploy.trim()) return 'demo.site.deploy: missing';
  return null;
}

/**
 * Why the demo site a repository's settings name cannot be used, in English, starting with its
 * field (`demo.site.url: …`); null where it can. The configuration reports it.
 */
export function siteProblem(site: DemoSite, repoPath: string): string | null {
  const incomplete = siteIncomplete(site);
  if (incomplete) return incomplete;
  const words = commandWords(site.deploy);
  // the deploy Obeya builds in: a GitHub repository, pushed to with gh's login
  if (words[0] === GITHUB_PAGES) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(words[1] ?? '')) return `demo.site.deploy: ${GITHUB_PAGES} expects <owner>/<repository>`;
    return Bun.which('gh') ? null : `demo.site.deploy: ${GITHUB_PAGES} needs gh, which is not on the PATH`;
  }
  // bunx runs as Obeya's own Bun
  if (words[0] === 'bunx') return words.length > 1 ? null : 'demo.site.deploy: bunx without a package';
  const argv = scriptArgv(words, repoPath);
  const program = argv[0] === process.execPath ? argv[1] : argv[0];
  if (!program) return 'demo.site.deploy: the deploy command is empty';
  if (isAbsolute(program)) return existsSync(program) ? null : `demo.site.deploy: the deploy command's program ${program} does not exist`;
  return Bun.which(program) ? null : `demo.site.deploy: the deploy command's program ${program} is not on the PATH`;
}

/** The last lines of a command's output, for the card's log. */
export function tail(s: string, lines = 20): string {
  const all = s.trim().split('\n');
  return (all.length > lines ? ['…', ...all.slice(-lines)] : all).join('\n').slice(-3000);
}

const plainText = (s: string) => s.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
