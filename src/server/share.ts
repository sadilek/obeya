// Sharing a card's demo with colleagues, a video or an HTML artifact: a page outside Obeya, on a
// static site Obeya keeps itself (`demo.site` of the repository's adapter, site.ts), or published
// by a command the repository names (`demo.share`). Obeya writes the page's text when
// the worker did not, and runs the command in a directory under Obeya's home (not in the checkout,
// often a workspace of the pool too), with the checkout in `OBEYA_REPO`:
// `publish` with the page as JSON on stdin, which prints the page's URL; `withdraw <slug>`; and,
// where the command knows it, `version`, which prints the version of the pages it writes (the
// video pages', then `html:<version>` for artifact pages where those differ): a page published with
// another one is offered to share again ("Erneut teilen"), on its card, or many at once from the
// Koordinator's sheet.
// Once the card has a pull request, its description links the page and the page links it. The
// target is the repository's configuration's command, else its adapter's site, else its adapter's
// command. A repository with none (or a site whose credentials are not on this machine) exports
// the demo instead: the same page as a ZIP with its files, or as one HTML file.
// Pages of one target are on one site, so they share its version and each publish names the others.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { adapterProblems, KIT_PATH } from '../adapters';
import { LANGUAGE_NAMES } from '../core/locale';
import { MESSAGES, type Messages } from '../core/messages';
import { type Demo, type DemoKind, type DemoPage, EXPORT_HTML_MAX, type Item } from '../core/types';
import { BadRequest, type Board, type PrState, reshareable, type StoredReshare, type StoredShare } from './board';
import type { DemoSite, RepoAdapter } from '../adapters/types';
import { readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { BUN_ENV } from './resources';
import { type Gone, siteMissing, siteTarget } from './site';
import { ARTIFACT_DIR, artifactFiles, artifactPageHtml, type DemoPageParts, day, demoPageHtml, PAGE_WORDS, type PageLanguage, withHeightReport } from './demo-page';
import { type Forge, parsePrUrl } from './forge';
import type { AgentRuntime } from './runtime';
import { branchName } from './workspaces';
import { zip } from './zip';

/** What the share command gets on stdin for `publish`; `withdraw` gets `slug` and `shared` only. */
export interface SharePage {
  /** Stays the same for a card, so a shared link keeps working when the page is published again. */
  slug: string;
  title: string;
  text: string;
  /** A video, or an HTML artifact (since 2026-10-05; absent from commands' input before). */
  kind: DemoKind;
  /** Seconds and title of each scene; none for an artifact. */
  chapters: [number, string][];
  /** The card's pull request, once it has one. */
  pr: string | null;
  /**
   * The demo's language, for the page's own words (`language` of the kit's page templates; since
   * 2026-10-07, absent from commands' input before, when pages were German).
   */
  language: PageLanguage;
  /** The demo's directory: `demo.mp4`, `poster.jpg`, `captions.vtt`; an artifact's `index.html` and the files it loads. */
  dir: string;
  /** The slugs of the other pages Obeya has stored as shared through this command: the site must still hold them. */
  shared: string[];
}

/** A repository's share command (argv), and the repository's checkout, passed to it as `OBEYA_REPO`. */
export interface ShareCommand {
  command: string[];
  repo: string;
}

/** Where a repository's demos go: its share command, or the site its adapter names; with its checkout. */
export type ShareSource = ShareCommand | { site: DemoSite; repo: string };

/**
 * Where a card's pages go. Pages whose targets have the same key are on one site: the target's
 * version applies to all of them, and a publish or withdrawal names the others as shared. Keys
 * are not stored (a stored share keeps the version only), so they only need to stay the same
 * across a restart.
 */
export interface ShareTarget {
  key: string;
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
   * Of a site: the pages another machine withdrew (their cards here lose their link), and the pages
   * shared from here (`shared`) that the live site lacks or has older, taken offline by another
   * machine's deployment that came in between.
   */
  audit?(shared: string[]): Promise<{ gone: Gone[]; missing: string[] }>;
  /** Of a site: deploys again what this machine has, for the pages `audit` found missing. */
  repair?(shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
  /** The version of the pages the target writes, which changes whenever its pages would come out different; null when it says none. */
  version(): Promise<Versions | null>;
}

/** A share command as a target, keyed by its argv as pages were before targets. */
export function commandTarget({ command, repo }: ShareCommand, home: string, t: Messages['share']): ShareTarget {
  return {
    key: `command:${JSON.stringify(command)}`,
    repo,
    async publish(page) {
      const r = await run([...command, 'publish'], JSON.stringify(page), repo, home);
      const url = r.out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).at(-1);
      if (r.code !== 0 || !url) return { why: r.code !== 0 ? t.commandFailed(r.code) : t.noUrl, said: tail(r.err || r.out) };
      // stdout carries the URL, logged with the share; what the command says on the way is on stderr
      return { url, said: r.err.trim() ? tail(r.err) : '' };
    },
    async withdraw(slug, shared) {
      const r = await run([...command, 'withdraw', slug], JSON.stringify({ slug, shared }), repo, home);
      if (r.code !== 0) return { why: t.notWithdrawnFailed(r.code), said: tail(r.err || r.out) };
      return { said: r.err.trim() || r.out.trim() ? tail(`${r.out}\n${r.err}`) : '' };
    },
    async version() {
      const r = await run([...command, 'version'], '', repo, home);
      return r.code === 0 ? parseVersions(r.out) : null;
    },
  };
}

/**
 * Where share commands run, under Obeya's home: not in the checkout, which is often a workspace
 * of the pool too, and a file a command leaves in its working directory (`wrangler pages deploy`
 * writes its cache there) would keep the workspace from being leased until someone cleans up.
 */
export const SHARE_CWD = 'share';

export interface SharingOptions {
  board: Board;
  runtime: AgentRuntime;
  /** Where the card's repository shares demos; null when it shares none. */
  sourceFor: (card: Item) => ShareSource | null;
  /**
   * Obeya's data directory, passed to the command as `OBEYA_HOME` (with `OBEYA_KIT`, the helpers an
   * adapter's command imports); the command runs in a directory of it (`SHARE_CWD`).
   */
  home: string;
  /** Where the card's pull request is, for the page's link in its description. */
  forge: Forge;
  /** This machine's name on a site several machines publish to; the host name without it. */
  machine?: string;
}

/** A share command (or a site's deploy) that has not finished by then is stopped (an upload of a few files takes seconds). */
export const COMMAND_TIMEOUT = 15 * 60_000;

/** The pages of all canvases go through one command at a time: a site directory takes one change at a time. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export class Sharing {
  /** When the versions were last asked for because the owner came back. */
  private checked = 0;
  /** A page of the run sharing many again is waiting for the command, or going out. */
  private resharing = false;

  constructor(private o: SharingOptions) {}

  /**
   * "Teilen" or "Neu teilen": the card's demo is published right away. There is no hold to
   * take it back: "Nicht mehr teilen" withdraws the page just as easily.
   */
  share(cardId: string) {
    const card = this.card(cardId);
    const demo = this.demo(cardId);
    if (card.prototypeOf || !demo || !this.target(card)) throw new BadRequest('noShare', 'the card has no demo, or its repository shares none');
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    this.set(cardId, { ...(s ? atRest(s) : { slug: slugOf(card) }), state: 'publishing' });
    const t = this.o.board.t.share;
    const again = !s?.url ? t.share : s.dir === demo.dir && s.outdated ? t.again : t.newDemo;
    this.o.board.log(cardId, 'state', 'owner', again);
    void serial(() => this.publish(cardId));
  }

  /** Withdraws the published page. */
  unshare(cardId: string) {
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    if (!s?.url) throw new BadRequest('notShared', 'the demo is not shared');
    this.set(cardId, { ...s, state: 'withdrawing' });
    this.o.board.log(cardId, 'state', 'owner', this.o.board.t.share.unshare);
    void serial(() => this.withdraw(cardId));
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

  /** After a restart: a share under way goes on, a withdrawal too; pages published with an earlier version are marked. */
  resume() {
    for (const r of this.o.board.sharedRows()) {
      let s = JSON.parse(r.share!) as StoredShare;
      // held for the owner to take back, as shares were until 2026-10-02: it goes out now
      if ((s.state as string) === 'pending') this.set(r.id, (s = { ...s, state: 'publishing' }));
      // one of many shared again goes on with the rest of them
      if (s.state === 'publishing' && s.again && this.o.board.reshareRun()?.queue[0] === r.id) continue;
      if (s.state === 'publishing') void serial(() => this.publish(r.id));
      else if (s.state === 'withdrawing') void serial(() => this.withdraw(r.id));
    }
    void serial(() => this.checkVersions());
    this.nextAgain();
  }

  /**
   * "Erneut teilen" for many pages at once, from the Koordinator's sheet: the outdated pages, the
   * newest demos first, `count` of them or all. They go out one after the other, each as it shows
   * now, so a newer demo on a card still waits for its "Neu teilen"; a share the owner starts
   * meanwhile goes out between two of them.
   */
  reshareMany(count: number | null) {
    const run = this.o.board.reshareRun();
    if (run?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again already');
    const rows = this.o.board.sharedRows().filter((r) => reshareable(r) && this.find(r.id) && this.target(this.find(r.id)!));
    if (!rows.length) throw new BadRequest('nothingOutdated', 'no shared page is outdated');
    const made = (r: (typeof rows)[number]) => {
      const dir = (JSON.parse(r.share!) as StoredShare).dir;
      return dir ? (statOr(join(dir, 'demo.mp4')) ?? statOr(join(dir, 'index.html')) ?? statOr(dir) ?? 0) : 0;
    };
    const queue = rows
      .map((r) => ({ id: r.id, at: made(r) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, count ?? undefined)
      .map((r) => r.id);
    this.o.board.setReshareRun({ queue, total: queue.length, done: 0, failed: [] });
    this.nextAgain();
  }

  /** Stops sharing many again: the page going out finishes, the rest stay as they are. */
  stopResharing() {
    const run = this.o.board.reshareRun();
    if (!run?.queue.length) return;
    const going = this.resharing && this.stored(run.queue[0]!)?.state === 'publishing' ? [run.queue[0]!] : [];
    this.o.board.setReshareRun({ ...run, queue: going, stopped: true });
  }

  /** Puts away what the finished run says. */
  dismissResharing() {
    if (this.o.board.reshareRun()?.queue.length) throw new BadRequest('reshareBusy', 'pages are being shared again');
    this.o.board.setReshareRun(null);
  }

  /** The next page of the run sharing many again, once the command is free. */
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
    let ok: boolean | null = null;
    if (s?.state === 'publishing' && s.again) ok = await this.publish(id);
    else {
      const row = this.find(id) && this.o.board.row(id);
      if (s && row && reshareable(row)) {
        this.set(id, { ...s, state: 'publishing', refresh: true, again: true });
        this.o.board.log(id, 'state', 'owner', this.o.board.t.share.againWithOthers);
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
   * The owner came back to Obeya: the versions are asked again (at most once a minute), since a
   * share command from another repository changes without Obeya restarting, and a site is asked
   * which pages another machine withdrew.
   */
  soon() {
    if (Date.now() - this.checked < 60_000) return;
    this.checked = Date.now();
    void serial(() => this.checkVersions());
  }

  /**
   * Asks each share target with pages out for the version of the pages it writes, and marks the
   * pages published with another one (or before commands said theirs): sharing them again would
   * make a difference. A card whose page another machine withdrew loses its link.
   */
  async checkVersions() {
    const targets = new Map<string, ShareTarget>();
    for (const r of this.o.board.sharedRows()) {
      const card = this.find(r.id);
      const target = card && (JSON.parse(r.share!) as StoredShare).url ? this.target(card) : null;
      if (target) targets.set(target.key, target);
    }
    for (const target of targets.values()) {
      this.mark(target.key, await target.version());
      if (target.audit) {
        const shared = this.others('', target.key);
        const { gone, missing } = await target.audit(shared);
        this.lost(target.key, gone);
        if (missing.length) await this.repair(target, shared, missing);
      }
    }
  }

  /** Pages shared from here that another machine's deployment took offline: deployed again, a line on each card. */
  private async repair(target: ShareTarget, shared: string[], missing: string[]) {
    const ids = this.o.board
      .sharedRows()
      .filter((r) => missing.includes((JSON.parse(r.share!) as StoredShare).slug))
      .map((r) => r.id);
    const log = (kind: 'activity' | 'state' | 'error', text: string) => ids.forEach((id) => this.o.board.log(id, kind, 'obeya', text));
    const t = this.o.board.t.share;
    const r = await target.repair!(shared, (text) => log('activity', text));
    this.lost(target.key, r.gone);
    if (r.why) return log('error', [t.notRestored(r.why), r.said].filter(Boolean).join('\n\n'));
    if (r.said) log('activity', r.said);
    log('state', t.restored);
  }

  /** Pages withdrawn on another machine: their cards here lose their link. */
  private lost(key: string, gone: Gone[] = []) {
    for (const g of gone) {
      const r = this.o.board.sharedRows().find((r) => (JSON.parse(r.share!) as StoredShare).slug === g.slug);
      const s = r && (JSON.parse(r.share!) as StoredShare);
      const card = r && this.find(r.id);
      if (!r || !s?.url || s.state || !card || this.target(card)?.key !== key) continue;
      this.set(r.id, { slug: s.slug });
      this.o.board.log(r.id, 'state', 'obeya', this.o.board.t.share.withdrawnElsewhere(g.machine));
    }
  }

  /** Marks each page at rest shared through the target as published with another version than its current one, or not. */
  private mark(key: string, versions: Versions | null) {
    for (const r of this.o.board.sharedRows()) {
      const s = JSON.parse(r.share!) as StoredShare;
      const card = this.find(r.id);
      if (!s.url || s.state || !card || this.target(card)?.key !== key) continue;
      const current = versionOf(versions, s.shown?.kind);
      const outdated = !!current && s.version !== current;
      if (outdated !== !!s.outdated) {
        const { outdated: _, ...rest } = s;
        this.set(r.id, { ...rest, ...(outdated ? { outdated: true as const } : {}) });
      }
    }
  }

  /** Publishes again what the page shows, with the pull request's link. */
  private refresh(cardId: string) {
    const s = this.stored(cardId);
    if (!s?.url || s.state) return;
    this.set(cardId, { ...s, state: 'publishing', refresh: true });
    void serial(() => this.publish(cardId));
  }

  /** Publishes the card's page; whether it went out (null: nothing to publish). */
  private async publish(cardId: string): Promise<boolean | null> {
    const s = this.stored(cardId);
    const card = this.find(cardId);
    if (s?.state !== 'publishing' || !card) return null;
    const t = this.o.board.t.share;
    const failed = s.again ? t.notAgain : s.refresh ? t.notLinked : t.notShared;
    const back = (why: string, out = '') => {
      this.set(cardId, atRest(s));
      this.o.board.log(cardId, 'error', 'obeya', [`${failed}: ${why}`, out].filter(Boolean).join('\n\n'));
      return false;
    };
    const demo = this.demo(cardId);
    const target = this.target(card);
    let shown: NonNullable<StoredShare['shown']>;
    let dir: string;
    if (s.refresh) {
      // the page as it is: a newer demo on the card waits for "Neu teilen"
      const now = s.shown ?? (demo?.page && demo.dir === s.dir ? { ...demo.page, chapters: demo.chapters, kind: demo.kind ?? 'video' } : null);
      if (!now || !s.dir || !target) {
        if (s.again) return back(t.demoGone);
        this.set(cardId, atRest(s));
        this.o.board.log(cardId, 'activity', 'obeya', t.linkLater);
        return null;
      }
      shown = now;
      dir = s.dir;
    } else {
      if (!demo || !target) return back(t.noDemo);
      const page = await this.page(card, demo);
      shown = { title: page.title, text: page.text, chapters: demo.chapters, kind: demo.kind ?? 'video' };
      dir = demo.dir;
    }
    const pr = this.prOf(cardId);
    const input: SharePage = { slug: s.slug, ...shown, kind: shown.kind ?? 'video', pr, language: this.languageOf(dir), dir, shared: this.others(cardId, target.key) };
    const r = await target.publish(input, (text) => this.o.board.log(cardId, 'activity', 'obeya', text));
    this.lost(target.key, r.gone);
    if ('why' in r) return back(r.why, r.said);
    const { url } = r;
    const versions = await target.version();
    const current = versionOf(versions, shown.kind);
    this.set(cardId, { slug: s.slug, url, dir, shown, ...(pr ? { pr } : {}), ...(current ? { version: current } : {}) });
    this.mark(target.key, versions);
    if (r.said) this.o.board.log(cardId, 'activity', 'obeya', r.said);
    this.o.board.log(cardId, 'state', 'obeya', s.again ? t.sharedAgain(url) : s.refresh ? t.linksPr(url) : t.shared(url));
    if (pr) this.linkPr(cardId, pr, url, target.repo, shown.kind);
    // the pull request was opened while the page went out: once more, with its link
    const now = this.prOf(cardId);
    if (now && now !== pr) this.refresh(cardId);
    return true;
  }

  /**
   * Puts the page's link into the pull request's description, unless it is there already (the
   * worker put it there, or Obeya did before). A line of Obeya's own is found again by its marker.
   */
  private linkPr(cardId: string, pr: string, url: string, cwd: string, kind: DemoKind = 'video') {
    const n = parsePrUrl(pr)?.number;
    try {
      const body = withDemoLink(this.o.forge.body(cwd, pr), url, kind, this.o.board.t);
      if (body === null) return;
      this.o.forge.setBody(cwd, pr, body);
      this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.share.prLinked(n));
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.share.prNotLinked(n, e instanceof Error ? e.message : String(e)));
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
    const r = await target.withdraw(s.slug, this.others(cardId, target.key), (text) => this.o.board.log(cardId, 'activity', 'obeya', text));
    this.lost(target.key, r.gone);
    if (r.why) return back(r.why, r.said);
    const versions = await target.version();
    this.set(cardId, { slug: s.slug });
    this.mark(target.key, versions);
    if (r.said) this.o.board.log(cardId, 'activity', 'obeya', r.said);
    this.o.board.log(cardId, 'state', 'obeya', t.withdrawn);
  }

  /**
   * The card's demo as a file to pass on, for a repository without a share target: the page in a
   * ZIP with the video, poster and captions beside it, or one HTML file that holds them all (videos
   * up to EXPORT_HTML_MAX). An HTML artifact goes beside its page in the ZIP, or into the one file
   * when it is its `index.html` alone. Nothing leaves Obeya, so nothing is held.
   */
  async export(cardId: string, as: 'zip' | 'html'): Promise<{ name: string; type: string; data: Uint8Array<ArrayBuffer> }> {
    const card = this.card(cardId);
    const demo = this.demo(cardId);
    if (demo?.kind === 'html' && !card.prototypeOf) return this.exportArtifact(card, demo, as);
    const video = demo && join(demo.dir, 'demo.mp4');
    if (card.prototypeOf || !demo || !video || !existsSync(video)) throw new BadRequest('noShare', 'the card has no demo');
    const size = statSync(video).size;
    if (as === 'html' && size > EXPORT_HTML_MAX)
      throw new BadRequest('exportTooLarge', `the video is ${(size / 1024 / 1024).toFixed(1)} MiB; one HTML file takes at most ${EXPORT_HTML_MAX / 1024 / 1024} MiB`);
    const page = await this.page(card, demo);
    const slug = this.stored(cardId)?.slug ?? slugOf(card);
    const file = (f: string) => (existsSync(join(demo.dir, f)) ? new Uint8Array(readFileSync(join(demo.dir, f))) : null);
    const poster = file('poster.jpg');
    const captions = file('captions.vtt');
    const language = this.languageOf(demo.dir);
    const parts: Omit<DemoPageParts, 'video' | 'poster'> = {
      title: page.title,
      text: page.text,
      chapters: demo.chapters,
      pr: this.prOf(cardId),
      when: PAGE_WORDS[language].demoOf(day(statSync(video).mtime, language)),
      tabTitle: page.title,
      language,
      // a page opened from disk may not load a caption file
      captions: { vtt: captions ? new TextDecoder().decode(captions) : 'WEBVTT\n' },
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
        ...(captions ? [{ name: `${slug}/captions.vtt`, data: captions }] : []),
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
    const language = this.languageOf(demo.dir);
    const when = PAGE_WORDS[language].demoOf(day(statSync(join(demo.dir, 'index.html')).mtime, language));
    const parts = { title: page.title, text: page.text, pr: this.prOf(card.id), when, tabTitle: page.title, language };
    let out: { name: string; type: string; data: Uint8Array<ArrayBuffer> };
    if (as === 'html') {
      out = { name: `${slug}.html`, type: 'text/html; charset=utf-8', data: new TextEncoder().encode(artifactPageHtml({ ...parts, artifact: { html: index } })) };
    } else {
      const entries = [
        { name: `${slug}/index.html`, data: new TextEncoder().encode(artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` } })) },
        ...files.map((f) => ({
          name: `${slug}/${ARTIFACT_DIR}/${f}`,
          data: f === 'index.html' ? new TextEncoder().encode(withHeightReport(index)) : new Uint8Array(readFileSync(join(demo.dir, f))),
        })),
      ];
      out = { name: `${slug}.zip`, type: 'application/zip', data: zip(entries) };
    }
    this.o.board.log(card.id, 'state', 'owner', this.o.board.t.share.exported(as === 'zip', out.name));
    return out;
  }

  /** The page's title and text: the worker's, else written now and kept with the demo, so it is not written again. */
  private async page(card: Item, demo: Demo & { dir: string }): Promise<DemoPage> {
    if (demo.page) return demo.page;
    const page = await this.writePage(card, demo);
    if (this.demo(card.id)?.dir === demo.dir) this.o.board.work(card.id, { demo: JSON.stringify({ ...demo, page }) });
    return page;
  }

  /**
   * The page's text for a demo handed over before workers wrote one: a short session writes it
   * from the worker's summary. Without one, the card's title and the summary's start stand in.
   */
  private writePage(card: Item, demo: Demo): Promise<DemoPage> {
    // a card's summary goes with its approval; the log keeps every handover
    const summary = this.o.board.summary(card.id) ?? this.o.board.events(card.id).filter((e) => e.kind === 'review' && e.author === 'worker').at(-1)?.text ?? '';
    const fallback: DemoPage = { title: plainText(card.title), text: plainText(summary).split(/(?<=[.!?])\s+/).slice(0, 4).join(' ') || plainText(card.title) };
    const repo = this.target(card)?.repo;
    return new Promise((resolve) => {
      let page: DemoPage | null = null;
      const session = this.o.runtime.start(
        {
          cwd: repo ?? this.o.home,
          readOnly: true,
          role: 'chores',
          system: pageSystem(LANGUAGE_NAMES[this.o.board.language()]),
          tools: [
            {
              name: 'page',
              description: `The page's title and text, in ${LANGUAGE_NAMES[this.o.board.language()]}.`,
              schema: { title: z.string(), text: z.string() },
              run: ({ title, text }) => {
                if (page) return 'Already written.';
                page = { title: String(title).trim().slice(0, 200) || fallback.title, text: String(text).trim().slice(0, 2000) || fallback.text };
                return 'Recorded. End your turn now.';
              },
            },
          ],
          onEvent: (e) => {
            if (e.type === 'idle' || (e.type === 'error' && !page)) {
              session.close();
              resolve(page ?? fallback);
            }
          },
        },
        [
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
      );
    });
  }

  /** The slugs of the other pages shared through the target. */
  private others(cardId: string, key: string): string[] {
    return this.o.board
      .sharedRows()
      .filter((r) => r.id !== cardId)
      .flatMap((r) => {
        const s = JSON.parse(r.share!) as StoredShare;
        const card = this.find(r.id);
        return s.url && s.state !== 'withdrawing' && card && this.target(card)?.key === key ? [s.slug] : [];
      })
      .sort();
  }

  /** Where the card's pages go; null when its repository shares none, or its site's credentials are not on this machine. */
  private target(card: Item): ShareTarget | null {
    const src = this.o.sourceFor(card);
    if (!src) return null;
    if ('site' in src) return siteMissing(this.o.home, src.site) ? null : siteTarget(src.site, src.repo, this.o.home, this.o.board.t.share, { machine: this.o.machine });
    return commandTarget(src, this.o.home, this.o.board.t.share);
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

  /** The card's pull request, once its worker opened it. */
  private prOf(cardId: string): string | null {
    const pr = this.o.board.row(cardId).pr;
    return pr ? ((JSON.parse(pr) as PrState).url ?? null) : null;
  }

  /**
   * The language a demo is in: the one its `index.html` names (the report page of a video, which the
   * director writes in the narration language, or the artifact itself), else the narration
   * language of the demo settings.
   */
  private languageOf(dir: string): PageLanguage {
    try {
      const lang = /<html\b[^>]*\blang=["']?([a-z]{2})/i.exec(readFileSync(join(dir, 'index.html'), 'utf8').slice(0, 2000))?.[1]?.toLowerCase();
      if (lang === 'de' || lang === 'en') return lang;
    } catch {}
    return readDemoSettings(this.o.home).language;
  }

  private demo(cardId: string): (Demo & { dir: string }) | null {
    const d = this.o.board.row(cardId).demo;
    return d ? (JSON.parse(d) as Demo & { dir: string }) : null;
  }

  private stored(cardId: string): StoredShare | null {
    if (!this.find(cardId)) return null;
    const s = this.o.board.row(cardId).share;
    return s ? (JSON.parse(s) as StoredShare) : null;
  }

  private set(cardId: string, s: StoredShare) {
    this.o.board.work(cardId, { share: JSON.stringify(s) });
  }
}

const pageSystem = (language: string) => `You write the page on which the demo of a change (a video, or a page with charts or an analysis) is shared with colleagues of the team. They have never seen the tool the change was planned in, its cards or plan docs; they know the product. Read the card's task and its worker's summary, and call the tool page once with:
- title: what changes, for a user of the product, in a few words (not the card's internal wording).
- text: two to five sentences in ${language}: what changes for the user and why. No findings, no test details, no internal process (cards, workers, demos, reviews), no markdown.
Then end your turn. Read code only if the summary leaves unclear what the change does for the user.`;

/** A share at rest: neither held, nor publishing, nor withdrawing. */
function atRest({ state: _, refresh: __, again: ___, ...s }: StoredShare): StoredShare {
  return s;
}

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

/**
 * The versions a share command says its pages are written in: the first word for video pages (and
 * for all, from a command that says one only), `html:<version>` for artifact pages.
 */
export interface Versions {
  video: string;
  html?: string;
}

export function parseVersions(out: string): Versions | null {
  const words = out.trim().split('\n').at(-1)?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!words[0]) return null;
  const html = words.find((w) => w.startsWith('html:'))?.slice('html:'.length);
  return { video: words[0], ...(html ? { html } : {}) };
}

/** The version a page of the kind is written in now. */
const versionOf = (v: Versions | null, kind: DemoKind = 'video') => (v ? (kind === 'html' ? (v.html ?? v.video) : v.video) : null);

/** A card's page keeps this slug for good: a shared link stays the same, and an export is named by it. */
const slugOf = (card: Item) => branchName(card.title, card.id).slice('obeya/'.length);

/**
 * A share command line as the configuration holds it, as argv: words split at spaces outside
 * quotes. A program given as a path, and any script, is found in the repository (`~` is the home
 * directory); a script (`.ts`, `.js`) runs with Obeya's own Bun, on every platform.
 */
export function shareArgv(line: string, repoPath: string): string[] {
  return scriptArgv(
    [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!),
    repoPath,
  );
}

/** Argv whose program, given as a path, is found in the repository, and a script runs with Obeya's own Bun. */
export function scriptArgv(words: string[], repoPath: string): string[] {
  if (!words.length) return [];
  let [program, ...rest] = words as [string, ...string[]];
  program = program.replace(/^~(?=$|[\\/])/, homedir());
  const script = /\.(m?[jt]sx?|cjs)$/.test(program);
  if ((script || /[\\/]/.test(program)) && !isAbsolute(program)) program = resolve(repoPath, program);
  return script ? [process.execPath, program, ...rest] : [program, ...rest];
}

/** Why a share command cannot run: its program is not there. */
export function shareProblem(argv: string[]): string | null {
  const program = argv[0] === process.execPath ? argv[1] : argv[0];
  if (!program) return 'the share command is empty';
  if (isAbsolute(program)) return existsSync(program) ? null : `the share command's program ${program} does not exist`;
  return Bun.which(program) ? null : `the share command's program ${program} is not on the PATH`;
}

/**
 * What is wrong with a repository's adapter, one line each, as the configuration and the adapter
 * skill's check report it: its fields (`adapterProblems`), a demo that names both a site and a share
 * command, and a share or deploy program that is not there. With `ownShare` the configuration names
 * a share command of its own, so the adapter's are not run and not checked.
 */
export function adapterRepoProblems(adapter: RepoAdapter, repoPath: string, ownShare = false): string[] {
  const { site, share } = adapter.demo ?? {};
  const shareWrong = !ownShare && !site && share && shareProblem(share);
  const deployWrong = !ownShare && site && shareProblem(scriptArgv(site.deploy, repoPath));
  return [
    ...adapterProblems(adapter),
    ...(site && share ? ['demo: names both site and share; the site is used, so share goes'] : []),
    ...(shareWrong ? [`demo.share: ${shareWrong}`] : []),
    ...(deployWrong ? [`demo.site.deploy: ${deployWrong}`] : []),
  ];
}

/** Runs the share command in `SHARE_CWD` under Obeya's home; never throws. */
async function run(argv: string[], stdin: string, repo: string, home: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const cwd = join(home, SHARE_CWD);
    mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, ...(argv[0] === process.execPath ? BUN_ENV : {}), OBEYA_HOME: home, OBEYA_KIT: KIT_PATH, OBEYA_REPO: repo };
    const p = Bun.spawn(argv, { cwd, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env, timeout: COMMAND_TIMEOUT });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) {
    return { code: -1, out: '', err: e instanceof Error ? e.message : String(e) };
  }
}

/** The last lines of a command's output, for the card's log. */
export function tail(s: string, lines = 20): string {
  const all = s.trim().split('\n');
  return (all.length > lines ? ['…', ...all.slice(-lines)] : all).join('\n').slice(-3000);
}

const plainText = (s: string) => s.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
