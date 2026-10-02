// Sharing a card's video demo with colleagues: a page outside Obeya, published by the command the
// repository's adapter names (`demo.share`). Obeya holds a share a few seconds for the owner to
// take it back, writes the page's text when the worker did not, and runs the command:
// `publish` with the page as JSON on stdin, which prints the page's URL; `withdraw <slug>`.

import { z } from 'zod';
import { OWNER_LANGUAGE } from '../core/locale';
import { type Demo, type DemoPage, type Item, SHARE_HOLD_MS } from '../core/types';
import { BadRequest, type Board, type PrState, type StoredShare } from './board';
import type { AgentRuntime } from './runtime';
import { branchName } from './workspaces';

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
  /** How long a share waits for the owner to take it back; SHARE_HOLD_MS by default. */
  holdMs?: number;
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
  private holds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private o: SharingOptions) {}

  /** "Teilen" or "Neu teilen": the card's video demo is published once the hold is over. */
  share(cardId: string) {
    const card = this.card(cardId);
    const demo = this.demo(cardId);
    if (card.prototypeOf || !demo || demo.kind === 'html' || !this.o.commandFor(card)) throw new BadRequest('noShare', "the card has no video demo, or its repository shares none");
    const s = this.stored(cardId);
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    this.set(cardId, { slug: s?.slug ?? branchName(card.title, card.id).slice('obeya/'.length), ...(s?.url ? { url: s.url, dir: s.dir } : {}), state: 'pending' });
    const seconds = Math.round((this.o.holdMs ?? SHARE_HOLD_MS) / 1000);
    this.o.board.log(cardId, 'state', 'owner', s?.url ? `Neu teilen: Die Seite bekommt die neue Demo in ${seconds} s.` : `Teilen: Die Seite geht in ${seconds} s online.`);
    this.hold(cardId);
  }

  /** Takes a held share back, or withdraws the published page. */
  unshare(cardId: string) {
    const s = this.stored(cardId);
    if (s?.state === 'pending') {
      clearTimeout(this.holds.get(cardId));
      this.holds.delete(cardId);
      this.set(cardId, { slug: s.slug, ...(s.url ? { url: s.url, dir: s.dir } : {}) });
      this.o.board.log(cardId, 'state', 'owner', 'Teilen zurückgenommen.');
      return;
    }
    if (s?.state) throw new BadRequest('shareBusy', 'the page is being shared or withdrawn');
    if (!s?.url) throw new BadRequest('notShared', 'the demo is not shared');
    this.set(cardId, { ...s, state: 'withdrawing' });
    this.o.board.log(cardId, 'state', 'owner', 'Nicht mehr teilen: Die Seite wird zurückgezogen.');
    void serial(() => this.withdraw(cardId));
  }

  /** After a restart: a share that was held or under way goes on, a withdrawal too. */
  resume() {
    for (const r of this.o.board.sharedRows()) {
      const s = JSON.parse(r.share!) as StoredShare;
      if (s.state === 'pending') this.hold(r.id);
      else if (s.state === 'publishing') void serial(() => this.publish(r.id));
      else if (s.state === 'withdrawing') void serial(() => this.withdraw(r.id));
    }
  }

  shutdown() {
    for (const t of this.holds.values()) clearTimeout(t);
    this.holds.clear();
  }

  private hold(cardId: string) {
    this.holds.set(
      cardId,
      setTimeout(() => {
        this.holds.delete(cardId);
        void serial(() => this.publish(cardId));
      }, this.o.holdMs ?? SHARE_HOLD_MS),
    );
  }

  private async publish(cardId: string) {
    const s = this.stored(cardId);
    const card = this.find(cardId);
    if (!s || (s.state !== 'pending' && s.state !== 'publishing') || !card) return;
    this.set(cardId, { ...s, state: 'publishing' });
    const back = (why: string, out = '') => {
      this.set(cardId, { slug: s.slug, ...(s.url ? { url: s.url, dir: s.dir } : {}) });
      this.o.board.log(cardId, 'error', 'obeya', [why, out].filter(Boolean).join('\n\n'));
    };
    const demo = this.demo(cardId);
    const cmd = this.o.commandFor(card);
    if (!demo || demo.kind === 'html' || !cmd) return back('Nicht geteilt: Die Karte hat keine Video-Demo mehr, oder ihr Repository teilt keine.');
    const page = demo.page ?? (await this.writePage(card, demo));
    // the page's text stays with the demo, so it is not written again for the next share
    if (!demo.page && this.demo(cardId)?.dir === demo.dir) this.o.board.work(cardId, { demo: JSON.stringify({ ...demo, page }) });
    const pr = this.o.board.row(cardId).pr;
    const input: SharePage = {
      slug: s.slug,
      title: page.title,
      text: page.text,
      chapters: demo.chapters,
      pr: pr ? ((JSON.parse(pr) as PrState).url ?? null) : null,
      dir: demo.dir,
      shared: this.others(cardId, cmd.command),
    };
    const r = await run([...cmd.command, 'publish'], JSON.stringify(input), cmd.cwd, this.o.home);
    const url = r.out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).at(-1);
    if (r.code !== 0 || !url) return back(r.code !== 0 ? `Nicht geteilt: Der Befehl zum Teilen ist gescheitert (Exit-Code ${r.code}).` : 'Nicht geteilt: Der Befehl zum Teilen hat keine URL ausgegeben.', tail(r.err || r.out));
    this.set(cardId, { slug: s.slug, url, dir: demo.dir });
    // stdout carries the URL, logged below; what the command says on the way is on stderr
    if (r.err.trim()) this.o.board.log(cardId, 'activity', 'obeya', tail(r.err));
    this.o.board.log(cardId, 'state', 'obeya', `Geteilt: ${url}`);
  }

  private async withdraw(cardId: string) {
    const s = this.stored(cardId);
    const card = this.find(cardId);
    if (s?.state !== 'withdrawing' || !card) return;
    const back = (why: string, out = '') => {
      this.set(cardId, { slug: s.slug, url: s.url, dir: s.dir });
      this.o.board.log(cardId, 'error', 'obeya', [why, out].filter(Boolean).join('\n\n'));
    };
    const cmd = this.o.commandFor(card);
    if (!cmd) return back('Nicht zurückgezogen: Das Repository der Karte teilt keine Demos mehr.');
    const r = await run([...cmd.command, 'withdraw', s.slug], JSON.stringify({ slug: s.slug, shared: this.others(cardId, cmd.command) }), cmd.cwd, this.o.home);
    if (r.code !== 0) return back(`Nicht zurückgezogen: Der Befehl zum Teilen ist gescheitert (Exit-Code ${r.code}).`, tail(r.err || r.out));
    this.set(cardId, { slug: s.slug });
    if (r.err.trim() || r.out.trim()) this.o.board.log(cardId, 'activity', 'obeya', tail(`${r.out}\n${r.err}`));
    this.o.board.log(cardId, 'state', 'obeya', 'Die Seite ist zurückgezogen.');
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
