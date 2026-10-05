// Sharing a card's video demo with colleagues: a page outside Obeya, published by the command the
// repository's adapter names (`demo.share`). Obeya writes the page's text when the worker did not,
// and runs the command:
// `publish` with the page as JSON on stdin, which prints the page's URL; `withdraw <slug>`; and,
// where the command knows it, `version`, which prints the version of the pages it writes: a page
// published with another one is offered to share again ("Erneut teilen"), on its card, or many at
// once from the Koordinator's sheet.
// Once the card has a pull request, its description links the page and the page links it. The
// command comes from the repository's configuration, else from its adapter. A repository with
// neither exports the demo instead: the same page as a ZIP with its files, or as one HTML file.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import { type Demo, type DemoPage, EXPORT_HTML_MAX, type Item } from '../core/types';
import { BadRequest, type Board, type PrState, reshareable, type StoredReshare, type StoredShare } from './board';
import { type DemoPageParts, day, demoPageHtml } from './demo-page';
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
  /** Seconds and title of each scene. */
  chapters: [number, string][];
  /** The card's pull request, once it has one. */
  pr: string | null;
  /** The demo's directory: `demo.mp4`, `poster.jpg`, `captions.vtt`. */
  dir: string;
  /** The slugs of the other pages Obeya has stored as shared through this command: the site must still hold them. */
  shared: string[];
}

export interface SharingOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The share command of the card's repository (argv) and where it runs; null when it shares none. */
  commandFor: (card: Item) => { command: string[]; cwd: string } | null;
  /** Obeya's data directory, passed to the command as `OBEYA_HOME`. */
  home: string;
  /** Where the card's pull request is, for the page's link in its description. */
  forge: Forge;
}

/** A share command that has not finished by then is stopped (an upload of a few files takes seconds). */
const COMMAND_TIMEOUT = 15 * 60_000;

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
   * "Teilen" or "Neu teilen": the card's video demo is published right away. There is no hold to
   * take it back: "Nicht mehr teilen" withdraws the page just as easily.
   */
  share(cardId: string) {
    const card = this.card(cardId);
    const demo = this.demo(cardId);
    if (card.prototypeOf || !demo || demo.kind === 'html' || !this.o.commandFor(card)) throw new BadRequest('noShare', "the card has no video demo, or its repository shares none");
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    this.set(cardId, { ...(s ? atRest(s) : { slug: slugOf(card) }), state: 'publishing' });
    const again = !s?.url ? 'Teilen: Die Seite geht online.' : s.dir === demo.dir && s.outdated ? 'Erneut teilen: Die Seite wird mit dem neuen Stand erzeugt.' : 'Neu teilen: Die Seite bekommt die neue Demo.';
    this.o.board.log(cardId, 'state', 'owner', again);
    void serial(() => this.publish(cardId));
  }

  /** Withdraws the published page. */
  unshare(cardId: string) {
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    if (!s?.url) throw new BadRequest('notShared', 'the demo is not shared');
    this.set(cardId, { ...s, state: 'withdrawing' });
    this.o.board.log(cardId, 'state', 'owner', 'Nicht mehr teilen: Die Seite wird zurückgezogen.');
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
    const rows = this.o.board.sharedRows().filter((r) => reshareable(r) && this.find(r.id) && this.o.commandFor(this.find(r.id)!));
    if (!rows.length) throw new BadRequest('nothingOutdated', 'no shared page is outdated');
    const made = (r: (typeof rows)[number]) => {
      const dir = (JSON.parse(r.share!) as StoredShare).dir;
      return dir ? (statOr(join(dir, 'demo.mp4')) ?? statOr(dir) ?? 0) : 0;
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
        this.o.board.log(id, 'state', 'owner', 'Erneut teilen, mit anderen geteilten Demos: Die Seite wird mit dem neuen Stand erzeugt.');
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
   * share command from another repository changes without Obeya restarting.
   */
  soon() {
    if (Date.now() - this.checked < 60_000) return;
    this.checked = Date.now();
    void serial(() => this.checkVersions());
  }

  /**
   * Asks each share command with pages out for the version of the pages it writes, and marks the
   * pages published with another one (or before commands said theirs): sharing them again would
   * make a difference.
   */
  async checkVersions() {
    const commands = new Map<string, { command: string[]; cwd: string }>();
    for (const r of this.o.board.sharedRows()) {
      const card = this.find(r.id);
      const cmd = card && (JSON.parse(r.share!) as StoredShare).url ? this.o.commandFor(card) : null;
      if (cmd) commands.set(JSON.stringify(cmd.command), cmd);
    }
    for (const cmd of commands.values()) this.mark(cmd.command, await this.version(cmd));
  }

  /**
   * The version of the pages the command writes, which changes whenever its pages would come out
   * different; null when it says none.
   */
  private async version(cmd: { command: string[]; cwd: string }): Promise<string | null> {
    const r = await run([...cmd.command, 'version'], '', cmd.cwd, this.o.home);
    return (r.code === 0 && r.out.trim().split('\n').at(-1)?.trim().split(/\s+/)[0]) || null;
  }

  /** Marks each page at rest shared through the command as published with another version than its current one, or not. */
  private mark(command: string[], current: string | null) {
    const key = JSON.stringify(command);
    for (const r of this.o.board.sharedRows()) {
      const s = JSON.parse(r.share!) as StoredShare;
      const card = this.find(r.id);
      if (!s.url || s.state || !card || JSON.stringify(this.o.commandFor(card)?.command) !== key) continue;
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
    const failed = s.again ? 'Nicht erneut geteilt' : s.refresh ? 'Der Link zum Pull Request ist nicht auf die Seite gekommen' : 'Nicht geteilt';
    const back = (why: string, out = '') => {
      this.set(cardId, atRest(s));
      this.o.board.log(cardId, 'error', 'obeya', [`${failed}: ${why}`, out].filter(Boolean).join('\n\n'));
      return false;
    };
    const demo = this.demo(cardId);
    const cmd = this.o.commandFor(card);
    let shown: NonNullable<StoredShare['shown']>;
    let dir: string;
    if (s.refresh) {
      // the page as it is: a newer demo on the card waits for "Neu teilen"
      const now = s.shown ?? (demo?.page && demo.dir === s.dir ? { ...demo.page, chapters: demo.chapters } : null);
      if (!now || !s.dir || !cmd) {
        if (s.again) return back('Die Demo, die die Seite zeigt, ist nicht mehr da; „Neu teilen“ bringt die der Aufgabe.');
        this.set(cardId, atRest(s));
        this.o.board.log(cardId, 'activity', 'obeya', 'Die geteilte Seite bekommt den Link zum Pull Request mit dem nächsten „Neu teilen“.');
        return null;
      }
      shown = now;
      dir = s.dir;
    } else {
      if (!demo || demo.kind === 'html' || !cmd) return back('Die Aufgabe hat keine Video-Demo mehr, oder ihr Repository teilt keine.');
      const page = await this.page(card, demo);
      shown = { title: page.title, text: page.text, chapters: demo.chapters };
      dir = demo.dir;
    }
    const pr = this.prOf(cardId);
    const input: SharePage = { slug: s.slug, ...shown, pr, dir, shared: this.others(cardId, cmd.command) };
    const r = await run([...cmd.command, 'publish'], JSON.stringify(input), cmd.cwd, this.o.home);
    const url = r.out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).at(-1);
    if (r.code !== 0 || !url) return back(r.code !== 0 ? `Der Befehl zum Teilen ist gescheitert (Exit-Code ${r.code}).` : 'Der Befehl zum Teilen hat keine URL ausgegeben.', tail(r.err || r.out));
    const current = await this.version(cmd);
    this.set(cardId, { slug: s.slug, url, dir, shown, ...(pr ? { pr } : {}), ...(current ? { version: current } : {}) });
    this.mark(cmd.command, current);
    // stdout carries the URL, logged below; what the command says on the way is on stderr
    if (r.err.trim()) this.o.board.log(cardId, 'activity', 'obeya', tail(r.err));
    this.o.board.log(cardId, 'state', 'obeya', s.again ? `Erneut geteilt: ${url}` : s.refresh ? `Die geteilte Seite verlinkt jetzt den Pull Request: ${url}` : `Geteilt: ${url}`);
    if (pr) this.linkPr(cardId, pr, url, cmd.cwd);
    // the pull request was opened while the page went out: once more, with its link
    const now = this.prOf(cardId);
    if (now && now !== pr) this.refresh(cardId);
    return true;
  }

  /**
   * Puts the page's link into the pull request's description, unless it is there already (the
   * worker put it there, or Obeya did before). A line of Obeya's own is found again by its marker.
   */
  private linkPr(cardId: string, pr: string, url: string, cwd: string) {
    const n = parsePrUrl(pr)?.number;
    try {
      const body = withDemoLink(this.o.forge.body(cwd, pr), url);
      if (body === null) return;
      this.o.forge.setBody(cwd, pr, body);
      this.o.board.log(cardId, 'state', 'obeya', `Den Link zur Demo in die Beschreibung von Pull Request #${n} eingetragen.`);
    } catch (e) {
      this.o.board.log(cardId, 'error', 'obeya', `Den Link zur Demo nicht in Pull Request #${n} eingetragen: ${e instanceof Error ? e.message : String(e)}`);
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
    const cmd = this.o.commandFor(card);
    if (!cmd) return back('Nicht zurückgezogen: Das Repository der Aufgabe teilt keine Demos mehr.');
    const r = await run([...cmd.command, 'withdraw', s.slug], JSON.stringify({ slug: s.slug, shared: this.others(cardId, cmd.command) }), cmd.cwd, this.o.home);
    if (r.code !== 0) return back(`Nicht zurückgezogen: Der Befehl zum Teilen ist gescheitert (Exit-Code ${r.code}).`, tail(r.err || r.out));
    const current = await this.version(cmd);
    this.set(cardId, { slug: s.slug });
    this.mark(cmd.command, current);
    if (r.err.trim() || r.out.trim()) this.o.board.log(cardId, 'activity', 'obeya', tail(`${r.out}\n${r.err}`));
    this.o.board.log(cardId, 'state', 'obeya', 'Die Seite ist zurückgezogen.');
  }

  /**
   * The card's video demo as a file to pass on, for a repository without a share target: the page
   * in a ZIP with the video, poster and captions beside it, or one HTML file that holds them all
   * (videos up to EXPORT_HTML_MAX). Nothing leaves Obeya, so nothing is held.
   */
  async export(cardId: string, as: 'zip' | 'html'): Promise<{ name: string; type: string; data: Uint8Array<ArrayBuffer> }> {
    const card = this.card(cardId);
    const demo = this.demo(cardId);
    const video = demo && join(demo.dir, 'demo.mp4');
    if (card.prototypeOf || !demo || demo.kind === 'html' || !video || !existsSync(video)) throw new BadRequest('noShare', 'the card has no video demo');
    const size = statSync(video).size;
    if (as === 'html' && size > EXPORT_HTML_MAX)
      throw new BadRequest('exportTooLarge', `the video is ${(size / 1024 / 1024).toFixed(1)} MiB; one HTML file takes at most ${EXPORT_HTML_MAX / 1024 / 1024} MiB`);
    const page = await this.page(card, demo);
    const slug = this.stored(cardId)?.slug ?? slugOf(card);
    const file = (f: string) => (existsSync(join(demo.dir, f)) ? new Uint8Array(readFileSync(join(demo.dir, f))) : null);
    const poster = file('poster.jpg');
    const captions = file('captions.vtt');
    const parts: Omit<DemoPageParts, 'video' | 'poster'> = {
      title: page.title,
      text: page.text,
      chapters: demo.chapters,
      pr: this.prOf(cardId),
      when: `Demo vom ${day(statSync(video).mtime)}`,
      tabTitle: page.title,
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
    this.o.board.log(cardId, 'state', 'owner', `Exportiert als ${as === 'zip' ? 'ZIP' : 'HTML-Datei'}: ${out.name}`);
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
    const cmd = this.o.commandFor(card);
    return new Promise((resolve) => {
      let page: DemoPage | null = null;
      const session = this.o.runtime.start(
        {
          cwd: cmd?.cwd ?? this.o.home,
          readOnly: true,
          effort: 'low',
          system: PAGE_SYSTEM,
          tools: [
            {
              name: 'page',
              description: `The page's title and text, in ${OWNER_LANGUAGE}.`,
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
          demo.chapters.length ? `The demo video's chapters: ${demo.chapters.map(([, t]) => t).join(' · ')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    });
  }

  /** The slugs of the other pages shared through the same command. */
  private others(cardId: string, command: string[]): string[] {
    const key = JSON.stringify(command);
    return this.o.board
      .sharedRows()
      .filter((r) => r.id !== cardId)
      .flatMap((r) => {
        const s = JSON.parse(r.share!) as StoredShare;
        const card = this.find(r.id);
        return s.url && s.state !== 'withdrawing' && card && JSON.stringify(this.o.commandFor(card)?.command) === key ? [s.slug] : [];
      })
      .sort();
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

const PAGE_SYSTEM = `You write the page on which a demo video of a change is shared with colleagues of the team. They have never seen the tool the change was planned in, its cards or plan docs; they know the product. Read the card's task and its worker's summary, and call the tool page once with:
- title: what changes, for a user of the product, in a few words (not the card's internal wording).
- text: two to five sentences in ${OWNER_LANGUAGE}: what changes for the user and why. No findings, no test details, no internal process (cards, workers, demos, reviews), no markdown.
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
export function withDemoLink(body: string, url: string): string | null {
  if (body.includes(url)) return null;
  const line = `Demo-Video: ${url} ${DEMO_MARKER}`;
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

/**
 * A share command line as the configuration holds it, as argv: words split at spaces outside
 * quotes. A program given as a path, and any script, is found in the repository (`~` is the home
 * directory); a script (`.ts`, `.js`) runs with Obeya's own Bun, on every platform.
 */
export function shareArgv(line: string, repoPath: string): string[] {
  const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
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

/** Runs the share command; never throws. */
async function run(argv: string[], stdin: string, cwd: string, home: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(argv, { cwd, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OBEYA_HOME: home }, timeout: COMMAND_TIMEOUT });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) {
    return { code: -1, out: '', err: e instanceof Error ? e.message : String(e) };
  }
}

/** The last lines of a command's output, for the card's log. */
function tail(s: string, lines = 20): string {
  const all = s.trim().split('\n');
  return (all.length > lines ? ['…', ...all.slice(-lines)] : all).join('\n').slice(-3000);
}

const plainText = (s: string) => s.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
