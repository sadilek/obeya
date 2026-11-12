// Sharing a card's demo with colleagues, a video or an HTML artifact: a page outside Obeya, on the
// static site Obeya keeps itself (`demo.site` of the repository's settings, site.ts). Obeya writes
// the page's text when the worker did not. A page keeps the newest page change (page-changes.ts) it
// was published after: one that lacks a change since is offered to share again ("Share again"),
// with what that brings, on its card, or many at once from the Coordinator's sheet.
// Once the card has a pull request, its description links the page and the page links it; work that
// lands without one links the page in its commit's trailer, and the page links the commit. A
// repository without a site (or with a site whose credentials are not on this machine) exports
// the demo instead: the same page as a ZIP with its files, or as one HTML file.
// Pages of one target are on one site, so each publish names the others.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGES, type Messages } from '../core/messages';
import { type Demo, type DemoKind, type DemoPage, EXPORT_HTML_MAX, type Item, type PageTags, withSupplemented, type DemoSite } from '../core/types';
import { BadRequest, type Board } from './board';
import { cardDemos, pageTagsOf, sameDemo, sharedDemos, type StoredReshare } from './shared-pages';
import { fromJson, type DemoRef, type SharedDemo, type StoredDemo, type StoredShare, toJson } from './row';
import { PAGE_CHANGES, pagesVersion } from '../core/page-changes';
import { dimensions, shownTags, tagsOf, untagged } from '../core/page-tags';
import { readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { type Gone, type PageDemo, siteBase, siteMissing, type SiteOptions, type SharePage, siteTarget, type ShareTarget } from './site';
import { allowedHere, approvedHere, newToken, type PersonalSite, personalDemoSite, readPersonal } from './personal-site';
import { artifactCopy } from './artifact-copy';
import { rereadChapters } from './demo';
import { artifactFiles, captionTracks, demoFile, keepDemo, silentVideo, videoFacts } from './demo-files';
import { ARTIFACT_DIR, artifactPageHtml, type DemoPageParts, day, demoPageHtml, ON_DISK, PAGE_WORDS, type PageCommit, type PageLanguage } from './demo-page';
import type { Theme } from './theme';
import { type Forge, landedUrl, parsePrUrl } from './forge';
import type { AgentRuntime } from './runtime';
import { chooseTags, type TagAsk, writePage } from './page-session';
import type { CardRow } from './db';
import { branchName } from './branches';
import { gitAsync } from './git';
import { originOf } from './forgejo';
import { zip } from './zip';
import { messageOf } from '../core/text';

/**
 * Where a repository's demos may go: the site its settings name (none without one), its checkout,
 * and whether it is public (as its forge says), which lets it share on the owner's personal site.
 */
export interface ShareSource {
  site: DemoSite | null;
  repo: string;
  isPublic?: boolean;
  /** Its theme for the pages (`.obeya/theme.css`, theme.ts), asked for once a page goes out; none where it has none. */
  theme?: () => Theme | null | Promise<Theme | null>;
}

export interface SharingOptions {
  board: Board;
  runtime: AgentRuntime;
  /** Where the card's repository may share demos; null while it does not run. */
  sourceFor: (card: CardPlace) => ShareSource | null;
  /** The owner's personal demo site on this machine; read from Obeya's home without it. */
  personal?: () => PersonalSite | null;
  /** The personal site as a demo site, how it is deployed (`personalDemoSite` without it; a stand-in in tests). */
  personalSite?: (p: PersonalSite) => DemoSite;
  /** The language the card's repository names for its demos (`demo.language` of its settings); none where it names none. */
  languageFor?: (card: CardPlace) => PageLanguage | undefined;
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
  /** The pages of the run tagging pages whose tags are being chosen, or going out. */
  private tagging: string[] = [];
  /** Cards whose latest demo goes on their page after the share under way: what that share settles is not the end. */
  private after = new Set<string>();

  constructor(private o: SharingOptions) {}

  /**
   * "Share", "Replace on the page" or "Add to the page": one of the card's demos (by its handover; the latest
   * without) is published right away, on the card's page in place of the versions there, or beside
   * them in its place by handover (`add`). A supplement on a new page or added takes along the demos
   * it supplements. A demo on the page already goes out again with the rest.
   * There is no hold to take it back: "Stop sharing" withdraws it just as easily.
   */
  share(cardId: string, { demo: handover, add = false }: { demo?: number | undefined; add?: boolean } = {}) {
    const card = this.card(cardId);
    const demo = handover === undefined ? this.demo(cardId) : this.cardDemo(cardId, { handover, dir: '' });
    if (card.prototypeOf || !demo || !this.target(card)) throw new BadRequest('noShare', 'the card has no demo, or its repository shares none');
    if (this.onPersonal(card) && !this.personalAllowed(card)) throw new BadRequest('noShare', 'the repository is private and not allowed on the personal demo site');
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    const now: DemoRef[] = s?.url ? sharedDemos(s) : [];
    const on = shows(s, demo);
    const next = on ? now : this.versionsWith(cardId, now, refOf(demo), add);
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
   * "Share on approval", where approving shares (see `approved`): whether approving the
   * card puts its latest demo on its page. It stays with the card across handovers.
   */
  onApproval(cardId: string, on: boolean) {
    const card = this.card(cardId);
    if (card.prototypeOf) throw new BadRequest('noShare', 'prototypes are not shared');
    const { notOnApproval: _, ...s } = this.shareOf(card);
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
    const s = this.shareOf(card);
    const chosen = allowed.filter((v) => values.includes(v));
    this.setTagFields(cardId, card, { tags: { ...s.tags, [dimension]: chosen } });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.share.tagsSet(dimension, chosen));
    if (s.url && !s.state) this.refresh(cardId, true);
  }

  /** The approval of a card whose owner unticked "Share on approval": the log says so where it would have shared. */
  private notOnPage(cardId: string) {
    const demo = this.demo(cardId);
    const s = this.stored(cardId);
    if (!demo || shows(s, demo)) return;
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.notOnApproval);
  }

  /** The card's latest demo goes on its page as an approval puts it there, unless it is there already or the page is busy. */
  private onPage(cardId: string) {
    const card = this.find(cardId);
    const demo = this.demo(cardId);
    const s = this.stored(cardId);
    if (!card || !demo || s?.state || shows(s, demo)) return;
    const now: DemoRef[] = s?.url ? sharedDemos(s) : [];
    const add = demo.follows === 'supplements';
    this.set(cardId, { ...this.fresh(card, s), state: 'publishing', next: this.versionsWith(cardId, now, refOf(demo), add).map(refOf) });
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
  async rebuilt(cardId: string) {
    const demo = this.demo(cardId);
    if (!demo || demo.kind === 'html') throw new BadRequest('noShare', 'the card has no demo video');
    const busy = () => {
      const s = this.stored(cardId);
      if (s?.state || shows(s, demo)) throw new BadRequest('shareBusy', 'the demo is on a shared page; stop sharing it first');
    };
    busy();
    const chapters = rereadChapters(demo.dir);
    if (typeof chapters === 'string') throw new BadRequest('invalid', chapters);
    const { page: _, tracks: _tracks, silent: _silent, kept, ...rest } = demo;
    // the copy Obeya keeps of it is of what it is now
    const [keeps, facts] = await Promise.all([kept && keepDemo({ dir: demo.dir, kind: 'video' }, kept), videoFacts(demo.dir)]);
    // read meanwhile: a demo handed over since stands, and one shared since is not changed under its page
    if (this.demo(cardId)?.handover !== demo.handover) return;
    busy();
    this.o.board.work(cardId, { demo: toJson({ ...rest, chapters, ...facts, ...(keeps ? { kept } : {}) }) });
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
      if (s.state === 'publishing' && s.again && this.o.board.pages.reshareRun()?.queue[0] === r.id) continue;
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
  }

  /**
   * "Share again" for many pages at once, from the Coordinator's sheet: the outdated pages, the
   * newest demos first, `count` of them or all. They go out one after the other, each as it shows
   * now, so a newer demo on a card still waits for its "Replace on the page"; a share the owner starts
   * meanwhile goes out between two of them. With `tags`, the pages without tags instead, tagged
   * in place a batch at a time (`tagSome`).
   */
  reshareMany(count: number | null, tags = false) {
    const run = this.o.board.pages.reshareRun();
    if (run?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again already');
    const outdated = tags ? this.o.board.pages.untaggedRows() : this.o.board.pages.outdatedRows().map(({ r }) => r);
    const cards = this.o.board.shownCards(outdated);
    const rows = outdated
      .map((r) => ({ r, s: this.o.board.pages.storedShare(r), card: cards.get(r.id) }))
      .filter(({ s, card }) => card && this.target(card, s));
    if (!rows.length) throw new BadRequest('nothingOutdated', tags ? 'no shared page lacks tags' : 'no shared page is outdated');
    const made = (dir?: string) => (dir ? (statOr(join(dir, 'demo.mp4')) ?? statOr(join(dir, 'index.html')) ?? statOr(dir) ?? 0) : 0);
    // newest by the newest version on the page
    const queue = rows
      .map(({ r, s }) => ({ id: r.id, at: Math.max(0, ...sharedDemos(s).map((d) => made(d.dir))) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, count ?? undefined)
      .map((r) => r.id);
    this.o.board.pages.setReshareRun({ queue, total: queue.length, done: 0, failed: [], ...(tags ? { tags: true as const } : {}) });
    this.nextAgain();
  }

  /** Stops sharing many again: the page going out finishes, the rest stay as they are. */
  stopResharing() {
    const run = this.o.board.pages.reshareRun();
    if (!run?.queue.length) return;
    const going = this.tagging.length ? run.queue.filter((id) => this.tagging.includes(id)) : this.resharing && this.stored(run.queue[0]!)?.state === 'publishing' ? [run.queue[0]!] : [];
    this.o.board.pages.setReshareRun({ ...run, queue: going, stopped: true });
  }

  /** "Hide": puts away what the finished run says, and the notice of outdated pages until a newer change. */
  dismissResharing() {
    const run = this.o.board.pages.reshareRun();
    if (run?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again');
    // a run tagging pages leaves the notice of outdated pages as it is
    if (run?.tags) this.o.board.pages.setReshareRun(null);
    else this.o.board.pages.dismissOutdated();
  }

  /** The next page of the run sharing many again, once the site is free. */
  private nextAgain() {
    if (this.resharing || !this.o.board.pages.reshareRun()?.queue.length) return;
    this.resharing = true;
    void serial(() => this.again()).finally(() => {
      this.resharing = false;
      this.nextAgain();
    });
  }

  private async again() {
    const run = this.o.board.pages.reshareRun();
    const id = run?.queue[0];
    if (!id) return;
    const s = this.stored(id);
    // a page that was going out when Obeya stopped goes on as it was, before the rest
    if (run.tags && !(s?.state === 'publishing' && s.again)) return this.tagSome();
    let ok: boolean | null = null;
    if (s?.state === 'publishing' && s.again) ok = await this.publish(id);
    else {
      const row = this.find(id) && this.o.board.row(id);
      // one that is up to date meanwhile no longer counts
      if (s && row && this.o.board.pages.outdatedBy(row).length > 0) {
        this.set(id, { ...s, state: 'publishing', refresh: true, again: true });
        this.o.board.log(id, 'state', 'owner', this.o.board.t.share.againWithOthers);
        ok = await this.publish(id);
      }
    }
    // shared again meanwhile on its own, withdrawn or gone: it no longer counts
    const now = this.o.board.pages.reshareRun();
    if (!now) return;
    const next: StoredReshare = { ...now, queue: now.queue.filter((x) => x !== id) };
    if (ok === true) next.done++;
    else if (ok === false) next.failed = [...next.failed, id];
    else next.total--;
    this.o.board.pages.setReshareRun(next);
  }

  /**
   * The next pages of the run tagging pages, up to a batch on one site: one reading session chooses
   * the tags they lack, one deploy puts them on their pages in place (`ShareTarget.retag`), so a
   * page whose demo files are gone from this machine gets its tags too, from the copy on the site.
   * The card keeps the tags once they are out: a run cut short by a restart chooses them again.
   * One that got its tags meanwhile drops out; one the session left without tags, or whose deploy
   * failed, is counted as failed.
   */
  private async tagSome() {
    const run = this.o.board.pages.reshareRun();
    if (!run?.queue.length) return;
    const untaggedNow = new Set(this.o.board.pages.untaggedRows().map((r) => r.id));
    const pages: Tagging[] = [];
    const dropped: string[] = [];
    let target: ShareTarget | null = null;
    for (const id of run.queue) {
      if (pages.length >= TAG_BATCH) break;
      const card = this.find(id);
      const s = this.stored(id);
      const on = card && s?.url && !s.state && untaggedNow.has(id) ? this.target(card) : null;
      const lacking = on && this.missingTags(card!);
      if (!on || !lacking) dropped.push(id);
      // pages on another site wait for a batch of their own
      else if (!target || on.key === target.key) {
        target = on;
        pages.push({ id, card: card!, slug: pathOf(s!), demos: sharedDemos(s!), lacking });
      }
    }
    this.tagging = pages.map((p) => p.id);
    const done: string[] = [];
    const failed: string[] = [];
    try {
      if (target) await this.tagBatch(target, pages, done, failed, dropped);
    } finally {
      this.tagging = [];
    }
    const now = this.o.board.pages.reshareRun();
    if (!now) return;
    const out = new Set([...pages.map((p) => p.id), ...dropped]);
    this.o.board.pages.setReshareRun({
      ...now,
      queue: now.queue.filter((x) => !out.has(x)),
      done: now.done + done.length,
      failed: [...now.failed, ...failed],
      total: now.total - dropped.filter((id) => now.queue.includes(id)).length,
    });
  }

  /** Tags a batch of `tagSome` on its site, noting each page as done, failed, or no longer lacking tags (`dropped`). */
  private async tagBatch(target: ShareTarget, pages: Tagging[], done: string[], failed: string[], dropped: string[]) {
    const t = this.o.board.t.share;
    const chosen = await chooseTags(this.o.runtime, target.repo, pages);
    // the owner may have chosen some meanwhile: the session's choice stands only where the page still lacks
    const going = pages.flatMap((p) => {
      const lacking = this.missingTags(p.card);
      const tags = lacking && chosen.get(p.id) ? Object.fromEntries(Object.entries(chosen.get(p.id)!).filter(([d]) => d in lacking)) : null;
      if (!lacking) dropped.push(p.id);
      else if (!tags || !Object.keys(tags).length) failed.push(p.id);
      return tags && Object.keys(tags).length ? [{ ...p, chosen: tags, tags: tagsOf({ ...pageTagsOf(this.o.board.row(p.id)), ...tags }, this.vocabulary(p.card)) }] : [];
    });
    // one the owner tagged meanwhile lacks nothing, whatever the session gave it
    for (const p of pages) if (!chosen.has(p.id) && failed.includes(p.id)) this.o.board.log(p.id, 'error', 'obeya', `${t.notShared}: ${t.noTags}`);
    if (going.length) {
      const r = await target.retag(
        going.map((p) => ({ slug: p.slug, tags: p.tags })),
        this.others('', target.key),
      );
      this.lost(target.key, r.gone ?? []);
      for (const p of going) {
        if (r.why) {
          this.o.board.log(p.id, 'error', 'obeya', withOutput(`${t.notShared}: ${r.why}`, r.said));
          failed.push(p.id);
          continue;
        }
        this.chosen(p.id, p.chosen);
        this.o.board.log(p.id, 'state', 'obeya', t.retagged(this.stored(p.id)?.url ?? target.pageUrl(p.slug)));
        done.push(p.id);
      }
    }
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
    // the first site's pages from the same pass; the next site's after the first answered, as they are then
    let cards: SharedCard[] | undefined = this.sharedCards();
    this.overPages(() => {
      for (const { s, card } of cards!) {
        const target = s.url ? this.target(card, s) : null;
        if (target) targets.set(target.key, target);
      }
    });
    for (const target of targets.values()) {
      const shared = this.others('', target.key, cards);
      cards = undefined;
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
    if (r.why) return log('error', withOutput(t.notRestored(r.why), r.said));
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
    // why the page goes out: shared again with many, its tags changed, a link to its change added, or the owner shared it
    const why = s.again ? 'again' : s.retag ? 'retag' : s.refresh ? 'link' : 'share';
    const failed = { again: t.notAgain, retag: t.notShared, link: t.notLinked, share: t.notShared }[why];
    const back = (why: string, out = '') => {
      this.set(cardId, atRest(s));
      this.o.board.log(cardId, 'error', 'obeya', withOutput(`${failed}: ${why}`, out));
      this.settled(cardId, { why });
      return false;
    };
    const target = this.target(card);
    // a private repository unticked since: its page may be withdrawn, but nothing more goes out
    if (s.personal && !this.personalAllowed(card)) return back(t.privateNotAllowed);
    let demos: SharedDemo[];
    if (s.refresh) {
      // the page as it is: a newer demo on the card waits for "Replace on the page" or "Add to the page"
      demos = sharedDemos(s).map((d) => this.filesOf(cardId, d));
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
          demos.push(this.filesOf(cardId, kept));
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
    const onPage = (d: SharedDemo): PageDemo => ({ ...d.shown, dir: d.dir, ...(d.at ? { at: d.at } : {}) });
    const vocabulary = this.vocabulary(card);
    const lacking = this.missingTags(card);
    if (lacking) {
      const tags = (await chooseTags(this.o.runtime, target.repo, [{ id: cardId, demos, lacking }])).get(cardId);
      if (tags) this.chosen(cardId, tags);
    }
    const tags = tagsOf(pageTagsOf(this.o.board.row(cardId)), vocabulary);
    const pr = this.prOf(cardId);
    const commit = pr ? null : await this.commitOf(card);
    const theme = await this.themeOf(card);
    const input: SharePage = {
      slug: pathOf(s),
      demos: [onPage(first), ...later.map(onPage)],
      pr,
      ...(commit ? { commit } : {}),
      language: this.languageOf(first.dir, card),
      shared: this.others(cardId, target.key),
      ...(Object.keys(tags).length ? { tags } : {}),
      ...(theme ? { theme } : {}),
    };
    const r = await target.publish(input, (text) => this.o.board.log(cardId, 'activity', 'obeya', text));
    this.lost(target.key, r.gone);
    if ('why' in r) return back(r.why, r.said);
    const { url } = r;
    this.set(cardId, { slug: s.slug, url, demos, ...(pr ? { pr } : {}), ...(commit ? { commit: commit.url } : {}), version: pagesVersion(), ...(theme ? { theme: theme.hash } : {}), ...kept(s), ...(s.personal ? { personal: true as const } : {}) });
    if (r.said) this.o.board.log(cardId, 'activity', 'obeya', r.said);
    const out = { again: t.sharedAgain, retag: t.retagged, link: pr ? t.linksPr : t.linksCommit, share: t.shared }[why];
    this.o.board.log(cardId, 'state', 'obeya', out(url));
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
    const review = fromJson(row.contribution);
    if (review) {
      // a review card's PR is the contributor's: its description stays theirs, and the link comes as a comment, once the owner approved
      const key = `${cardId}\n${url}`;
      if (!review.approved || review.linked === url || this.commenting.has(key)) return;
      // marked once the comment is there: a restart before then comments at the next approval
      this.commenting.add(key);
      const t = MESSAGES[this.languageOf(this.demo(cardId)?.dir ?? '', this.card(cardId))].share;
      try {
        const at = await this.o.forge.comment(cwd, pr, t.prComment(kind === 'html', url));
        const now = fromJson(this.o.board.row(cardId).contribution);
        if (now) this.o.board.work(cardId, { contribution: toJson({ ...now, linked: url }) });
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
      this.o.board.log(cardId, 'error', 'obeya', withOutput(why, out));
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
    if (card.prototypeOf || !demo) throw new BadRequest('noShare', 'the card has no demo');
    const made = demo.kind === 'html' ? await this.artifactExport(card, demo, as) : await this.videoExport(card, demo, as);
    const slug = this.shareOf(card).slug;
    const out =
      'html' in made
        ? { name: `${slug}.html`, type: 'text/html; charset=utf-8', data: new TextEncoder().encode(made.html) }
        : { name: `${slug}.zip`, type: 'application/zip', data: zip(made.entries.map((e) => ({ name: `${slug}/${e.name}`, data: e.data }))) };
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.share.exported(as === 'zip', out.name));
    return out;
  }

  /** A video demo's export: its page as one file, or with its video, poster and captions beside it (`entries`, by their place in the ZIP's directory). */
  private async videoExport(card: Item, demo: StoredDemo, as: 'zip' | 'html'): Promise<Exported> {
    const video = demoFile(demo.dir, 'demo.mp4');
    if (!video) throw new BadRequest('noShare', 'the card has no demo');
    const size = statSync(video).size;
    if (as === 'html' && size > EXPORT_HTML_MAX)
      throw new BadRequest('exportTooLarge', `the video is ${(size / 1024 / 1024).toFixed(1)} MiB; one HTML file takes at most ${EXPORT_HTML_MAX / 1024 / 1024} MiB`);
    const file = (f: string) => {
      const path = demoFile(demo.dir, f);
      return path ? new Uint8Array(readFileSync(path)) : null;
    };
    const poster = file('poster.jpg');
    // the narration's text, whether or not it is a track: what a player outside Obeya reads where it knows one file only
    const narration = file('captions.vtt');
    const shared = await this.exportParts(card, demo, video);
    // every caption track goes with it; one from before the tracks is in the demo's language
    const tracks = (await captionTracks(demo.dir)).flatMap((t) => {
      const data = file(t.file);
      return data ? [{ file: t.file, language: t.language ?? shared.language, data }] : [];
    });
    const parts: Omit<DemoPageParts, 'video' | 'poster'> = {
      ...shared,
      chapters: demo.chapters,
      // a page opened from disk may not load a caption file
      tracks: tracks.map((t) => ({ language: t.language, vtt: new TextDecoder().decode(t.data) })),
      ...((await silentVideo(video)) ? { silent: true } : {}),
    };
    if (as === 'html')
      return {
        html: demoPageHtml({
          ...parts,
          video: { base64: Buffer.from(readFileSync(video)).toString('base64') },
          ...(poster ? { poster: `data:image/jpeg;base64,${Buffer.from(poster).toString('base64')}` } : {}),
        }),
      };
    const html = demoPageHtml({ ...parts, video: { src: 'demo.mp4' }, ...(poster ? { poster: 'poster.jpg' } : {}) });
    return {
      entries: [
        { name: 'index.html', data: new TextEncoder().encode(html) },
        { name: 'demo.mp4', data: new Uint8Array(readFileSync(video)) },
        ...(poster ? [{ name: 'poster.jpg', data: poster }] : []),
        ...tracks.map((t) => ({ name: t.file, data: t.data })),
        ...(narration && !tracks.some((t) => t.file === 'captions.vtt') ? [{ name: 'captions.vtt', data: narration }] : []),
      ],
    };
  }

  /** An HTML artifact's export: its page with the artifact inside, where it is its `index.html` alone, or with the artifact's files beside it. */
  private async artifactExport(card: Item, demo: StoredDemo, as: 'zip' | 'html'): Promise<Exported> {
    const files = artifactFiles(demo.dir);
    if (!files.includes('index.html')) throw new BadRequest('noShare', 'the card has no demo');
    if (as === 'html' && files.length > 1) throw new BadRequest('exportNotAlone', 'the artifact loads files beside its index.html; it goes out as a ZIP only');
    const parts = await this.exportParts(card, demo, join(demo.dir, 'index.html'));
    if (as === 'html') return { html: artifactPageHtml({ ...parts, artifact: { html: readFileSync(join(demo.dir, 'index.html'), 'utf8') } }) };
    const copy = await artifactCopy(demo.dir, files, ON_DISK);
    return {
      entries: [
        { name: 'index.html', data: new TextEncoder().encode(artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` }, disk: true })) },
        ...files.map((f) => ({
          name: `${ARTIFACT_DIR}/${f}`,
          data: copy.has(f) ? new TextEncoder().encode(copy.get(f)) : new Uint8Array(readFileSync(join(demo.dir, f))),
        })),
      ],
    };
  }

  /** What an exported page shows of every demo: its words, the link to the change, and the day the demo was made, that of the file `dated`. */
  private async exportParts(card: Item, demo: StoredDemo, dated: string) {
    const page = await this.page(card, demo);
    const theme = await this.themeOf(card);
    const language = this.languageOf(demo.dir, card);
    return {
      title: page.title,
      text: page.text,
      pr: this.prOf(card.id),
      commit: await this.commitOf(card),
      when: PAGE_WORDS[language].demoOf(day(statSync(dated).mtime, language)),
      tabTitle: page.title,
      language,
      ...(theme ? { theme: theme.css } : {}),
    };
  }

  /** The theme of the card's repository for its page; none where it has none. */
  private async themeOf(card: Item): Promise<Theme | null | undefined> {
    return this.o.sourceFor(card)?.theme?.();
  }

  /**
   * The page's title and text: the worker's, else written now and kept with the demo, so it is not
   * written again; a page written now chooses the tags the card's page lacks (`lacking`) along with it.
   */
  private async page(card: Item, demo: Demo & { dir: string }, lacking: PageTags | null = null): Promise<DemoPage> {
    if (demo.page) return demo.page;
    // a card's summary goes with its approval; the log keeps every handover
    const summary = this.o.board.summary(card.id) ?? this.o.board.events(card.id).filter((e) => e.kind === 'review' && e.author === 'worker').at(-1)?.text ?? '';
    const { tags, ...page } = await writePage(this.o.runtime, { cwd: this.target(card)?.repo ?? this.o.home, card, summary, demo, language: this.languageOf(demo.dir, card), lacking });
    if (tags) this.chosen(card.id, tags);
    const row = this.o.board.row(card.id);
    const latest = this.demo(card.id);
    if (latest && sameDemo(latest, demo)) this.o.board.work(card.id, { demo: toJson({ ...latest, page }) });
    else if (row.demos)
      this.o.board.work(card.id, { demos: toJson(fromJson(row.demos).map((d) => (sameDemo(d, demo) ? { ...d, page } : d))) });
    return page;
  }

  /**
   * Keeps the tags the reading session chose: each dimension of them in place of what the card had
   * of it (which lacked a value the vocabulary has), below what a worker or the owner chooses later.
   */
  private chosen(cardId: string, tags: PageTags) {
    const row = this.o.board.row(cardId);
    const without = (t: PageTags | undefined) => (t ? Object.fromEntries(Object.entries(t).filter(([d]) => !(d in tags))) : undefined);
    const page = <D extends Demo>(d: D): D => (d.page?.tags ? { ...d, page: { ...d.page, tags: without(d.page.tags) } } : d);
    if (row.demo) this.o.board.work(cardId, { demo: toJson(page(fromJson(row.demo))) });
    if (row.demos) this.o.board.work(cardId, { demos: toJson(fromJson(row.demos).map(page)) });
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
  private others(cardId: string, key: string, cards = this.sharedCards()): string[] {
    return this.overPages(() =>
      cards.flatMap(({ s, card }) => (card.id !== cardId && s.url && s.state !== 'withdrawing' && this.target(card, s)?.key === key ? [pathOf(s)] : [])).sort(),
    );
  }

  /**
   * Where the card's page goes: where it is, once it is out or going out; else its repository's
   * site, where this machine can deploy to it, else the owner's personal site, where the repository
   * may share there (public, or ticked). Null where none takes it: its demos are exported.
   */
  private target(card: CardPlace, s = this.stored(card.id)): ShareTarget | null {
    if (s?.url || s?.state) return s.personal ? this.personalTarget(card, s) : this.ownTarget(card);
    return this.ownTarget(card) ?? (this.personalAllowed(card) ? this.personalTarget(card, s) : null);
  }

  /** The card's repository's own site, where this machine has its credentials. */
  private ownTarget(card: CardPlace): ShareTarget | null {
    const src = this.o.sourceFor(card);
    if (!src?.site) return null;
    const language = this.o.languageFor?.(card);
    return this.siteTarget(src.site, src.repo, language ? { language } : {});
  }

  /**
   * `siteTarget`, where this machine has the site's credentials; within a pass over the shared pages
   * (`overPages`), made once per site, repository and options rather than once per page.
   */
  private siteTarget(site: DemoSite, repo: string, opts: SiteOptions): ShareTarget | null {
    const make = () => (siteMissing(this.o.home, site) ? null : siteTarget(site, repo, this.o.home, this.o.board.t.share, opts));
    if (!this.pass) return make();
    let bySite = this.pass.get(site);
    if (!bySite) this.pass.set(site, (bySite = new Map()));
    const key = JSON.stringify([repo, opts]);
    if (!bySite.has(key)) bySite.set(key, make());
    return bySite.get(key)!;
  }

  /** The targets made during the pass over the shared pages running now (`overPages`), by site; none outside one. */
  private pass: Map<DemoSite, Map<string, ShareTarget | null>> | null = null;

  /** Runs `f`, a pass over the shared pages that does not wait for anything, making each target once (`siteTarget`). */
  private overPages<T>(f: () => T): T {
    if (this.pass) return f();
    this.pass = new Map();
    try {
      return f();
    } finally {
      this.pass = null;
    }
  }

  /**
   * The owner's personal site, unlisted, where this machine is connected to it and has its
   * credentials; none for a page that went out on another personal site (this machine was connected
   * to another one since).
   */
  private personalTarget(card: CardPlace, s = this.stored(card.id)): ShareTarget | null {
    const src = this.o.sourceFor(card);
    const p = this.personal();
    if (!src || !p) return null;
    const url = s?.url;
    if (url && !url.startsWith(`${p.url.replace(/\/+$/, '')}/`)) return null;
    const site = (this.o.personalSite ?? personalDemoSite)(p);
    const language = this.o.languageFor?.(card);
    return this.siteTarget(site, src.repo, { ...(p.secret ? { unlisted: { secret: p.secret } } : {}), ...(language ? { language } : {}) });
  }

  private personal(): PersonalSite | null {
    return this.o.personal ? this.o.personal() : readPersonal(this.o.home);
  }

  /** Whether the card's repository may share on the personal site: a public one, or a private one the owner ticked. */
  private personalAllowed(card: CardPlace): boolean {
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
    const shipped = fromJson(row.shipped);
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
    return fromJson(this.o.board.row(cardId).pr)?.url ?? null;
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

  /**
   * The versions a page shows with the demo `ref` going on it: in place of those on it, the demo
   * alone; beside them (`add`), or on a page without any, the demo and the ones it supplements
   * (`withSupplemented`) with them, in order of handover.
   */
  private versionsWith(cardId: string, now: DemoRef[], ref: DemoRef, add: boolean): DemoRef[] {
    if (now.length && !add) return [ref];
    const all = cardDemos(this.o.board.row(cardId));
    const i = all.findLastIndex((d) => sameDemo(d, ref));
    const along = i < 0 ? [ref] : withSupplemented(all, i).map(refOf);
    return inOrder([...now, ...along.filter((d) => !now.some((n) => sameDemo(n, d)))]);
  }

  /**
   * A version on the page with where its files are now: an earlier demo is shown from the copy Obeya
   * kept of it once a later one came (`StoredDemo`), which may have been rendered over the files it
   * went out from.
   */
  private filesOf(cardId: string, d: SharedDemo): SharedDemo {
    const dir = this.cardDemo(cardId, d)?.dir;
    return dir && d.handover !== undefined ? { ...d, dir } : d;
  }

  /** One of the card's demos a page may show (`cardDemos`), by its handover, else by its directory. */
  private cardDemo(cardId: string, ref: DemoRef): StoredDemo | null {
    return cardDemos(this.o.board.row(cardId)).findLast((d) => sameDemo(d, ref)) ?? null;
  }

  private demo(cardId: string): StoredDemo | null {
    return fromJson(this.o.board.row(cardId).demo);
  }

  /** The cards of the canvas, archived ones too, that were ever shared or are about to be, with their shares. */
  private shares(): { r: CardRow; s: StoredShare }[] {
    return this.o.board.pages.sharedRows().map((r) => ({ r, s: this.o.board.pages.storedShare(r) }));
  }

  /** The shared cards (`shares`) the UI shows, with where each belongs (`Board.shownCards`); those gone are left out. */
  private sharedCards(): SharedCard[] {
    const shares = this.shares();
    const cards = this.o.board.shownCards(shares.map(({ r }) => r));
    return shares.flatMap(({ r, s }) => {
      const card = cards.get(r.id);
      return card ? [{ r, s, card }] : [];
    });
  }

  /** The card's share, or what a new one starts from: the slug its page keeps for good. */
  private shareOf(card: Item): StoredShare {
    return this.stored(card.id) ?? { slug: slugOf(card) };
  }

  private stored(cardId: string): StoredShare | null {
    if (!this.find(cardId)) return null;
    return fromJson(this.o.board.row(cardId).share);
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
    this.o.board.work(cardId, { share: toJson({ ...s, ...(now?.tags ? { tags: now.tags } : {}), ...(now?.auto ? { auto: now.auto } : {}) }) });
  }

  /** Changes the page's tags the owner set by hand, or the reading session chose. */
  private setTagFields(cardId: string, card: Item, fields: Pick<StoredShare, 'tags' | 'auto'>) {
    const s = this.shareOf(card);
    this.o.board.work(cardId, { share: toJson({ ...s, ...fields }) });
  }
}

/** How many pages the run tagging pages tags with one session and one deploy. */
const TAG_BATCH = 20;

/** What a page's place depends on of its card: its repository, and its title in the tests' stand-ins. */
export type CardPlace = Pick<Item, 'id' | 'repo' | 'title'>;

/** A shared card with its share and its place. */
interface SharedCard {
  r: CardRow;
  s: StoredShare;
  card: CardPlace;
}

/** An exported page: one HTML file, or the files of its ZIP, each by its place in the page's directory. */
type Exported = { html: string } | { entries: { name: string; data: Uint8Array<ArrayBuffer> }[] };

/** A page the reading session chooses tags for. */
interface Tagging extends TagAsk {
  card: Item;
  /** Its place on its site (`pathOf`). */
  slug: string;
  demos: SharedDemo[];
}

/** Whether the demo is on the share's page. */
const shows = (s: StoredShare | null, demo: DemoRef) => !!s?.url && sharedDemos(s).some((d) => sameDemo(d, refOf(demo)));

/** A line for the card's log with what the deploy said below it, where it said something. */
const withOutput = (head: string, said: string) => [head, said].filter(Boolean).join('\n\n');

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
export function withDemoLink(body: string, url: string, kind: DemoKind, t: Messages): string | null {
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
