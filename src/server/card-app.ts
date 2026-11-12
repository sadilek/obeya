// The app in a card's workspace while its worker is away from it: stopped once the card has waited
// for the owner a while (`app.stop`), unless the owner opened it to try it by hand, and forwarded to
// the owner's browser from a workspace on another machine.

import { answering } from '../core/types';
import { clip } from '../core/text';
import { runAppCommand } from './app-command';
import { type Forward, remote } from './hosts';
import type { WorkerOptions } from './worker-options';
import { CardTimers } from './card-timers';

/** A quick reply from the owner should not pay for starting the stack again. */
const PARK_GRACE = 5 * 60_000;
/** An app the owner opened to try by hand runs at least this long after, waiting card or not. */
const TRY_GRACE = 30 * 60_000;
/** How long Obeya waits for the app to answer when it looks whether it runs. */
const PROBE_MS = 1500;

/** What the card's app needs of the workers. */
export interface CardAppsHost {
  /** Whether the card's worker is in a turn. */
  busy(cardId: string): boolean;
  /** Whether what began now is still under way when asked later (`Workers.sameRun`). */
  sameRun(cardId: string): () => boolean;
  /** Whether the workers were shut down. */
  shut(): boolean;
}

export class CardApps {
  /** Cards that wait for the owner, until their grace runs out and Obeya stops their app. */
  private parking = new CardTimers();
  /** When the owner last opened a card's app to try it by hand, by card. */
  readonly tried = new Map<string, number>();
  /** The forwards to the apps of cards whose workspace is on another machine, by card: the address forwarded, from which workspace, and the port here it had last. */
  private forwards = new Map<string, { app: string; workspace: string; forward: Forward; port?: number }>();
  /** Cards whose stack is being stopped: a message to their worker waits until it is. */
  readonly stopping = new Map<string, Promise<void>>();

  constructor(
    private o: WorkerOptions,
    private w: CardAppsHost,
  ) {}

  /** A forward to a card's app ends once the card no longer offers it: cleared, parked, its workspace gone. */
  unforwardGone() {
    for (const [id, f] of this.forwards) {
      const card = this.o.board.item(id);
      if (card?.app !== f.app || this.o.board.row(id).workspace !== f.workspace) this.unforward(id);
    }
  }

  /**
   * Whether the card waits for the owner with its workspace and nothing of its worker's running:
   * handed over, asked, or its pull request open, and the worker's turn over, background work included.
   */
  waitsForOwner(cardId: string): boolean {
    const card = this.o.board.item(cardId);
    if (!card || !(card.state === 'waiting' || (card.state === 'inPr' && card.pr) || card.paused || card.snoozed)) return false;
    // paused while taking in the owner's words on its handover, nothing of it runs either
    if ((answering(card) && !card.paused) || this.w.busy(cardId)) return false;
    const row = this.o.board.row(cardId);
    return !!row.workspace && !row.parked;
  }

  /** A card that waits for the owner has its app stopped once a quick reply has not come (`app.stop`). */
  parkLater(cardId: string) {
    if (!this.o.adapter.app?.stop || !this.waitsForOwner(cardId)) return;
    this.parking.set(cardId, Math.max(this.o.parkGrace ?? PARK_GRACE, (this.tried.get(cardId) ?? 0) + (this.o.tryGrace ?? TRY_GRACE) - Date.now()), () => {
      if (!this.waitsForOwner(cardId) || this.stopping.has(cardId)) return;
      const stopping = this.park(cardId).finally(() => this.stopping.delete(cardId));
      this.stopping.set(cardId, stopping);
    });
  }

  /**
   * Where the owner's browser reaches the app the card's worker said runs: its address, or for a
   * workspace on another machine that address's port forwarded here (only that port: a page that
   * talks to another port there finds nothing here). The forward is made when first asked for and
   * made again when its connection dropped, on the port it had if that is still free (`prefer`).
   */
  private async appAt(cardId: string, prefer?: number): Promise<string | null> {
    const app = this.o.board.item(cardId)?.app;
    const workspace = this.o.board.row(cardId).workspace;
    if (!app || !workspace) return null;
    const there = remote(workspace);
    if (!there) return app;
    if (this.w.shut()) return null;
    let url: URL;
    try {
      url = new URL(app);
    } catch {
      return null;
    }
    let f = this.forwards.get(cardId);
    if (f && !(await f.forward.live())) {
      // unless another call made it anew meanwhile; the card may no longer offer that app either
      const port = f.port;
      if (this.forwards.get(cardId) === f) this.unforward(cardId);
      return this.appAt(cardId, port);
    }
    if (!f) {
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      f = { app, workspace, forward: there.host.forward(host === '0.0.0.0' || host === '::' ? 'localhost' : host, port, prefer), port: prefer };
      this.forwards.set(cardId, f);
    }
    const local = await f.forward.ready;
    if (!local || this.forwards.get(cardId) !== f) return null;
    f.port = local;
    // the browser here names it as the worker did where it can, so the page's own origin stays
    url.hostname = url.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
    url.port = String(local);
    return url.href;
  }

  /** Ends the forward to the card's app, if it has one. */
  private unforward(cardId: string) {
    this.forwards.get(cardId)?.forward.close();
    this.forwards.delete(cardId);
  }

  /** Whether the app the card's worker said runs answers at its address now: any HTTP answer counts, an error page too. */
  async appUp(cardId: string): Promise<boolean> {
    const url = await this.appAt(cardId);
    if (!url) return false;
    try {
      await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS), tls: { rejectUnauthorized: false } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The owner opens the card's app to try it by hand: its address. Obeya leaves it running for a
   * while after (`TRY_GRACE`), so it does not stop under them once the card waits. None once it no longer runs.
   */
  async openApp(cardId: string): Promise<string | null> {
    const url = await this.appAt(cardId);
    if (!url) return null;
    this.tried.set(cardId, Date.now());
    if (this.parking.has(cardId)) this.parkLater(cardId);
    return url;
  }

  /** A card that is no longer left waiting keeps its app. */
  unpark(cardId: string) {
    this.parking.clear(cardId);
  }

  /** Stops the app in the card's workspace, unless it holds what must stay (`app.keep`). */
  private async park(cardId: string) {
    const { stop, keep } = this.o.adapter.app ?? {};
    // the settings lost the command since the grace began
    if (!stop) return;
    const workspace = this.o.board.row(cardId).workspace!;
    const still = this.w.sameRun(cardId);
    const kept = keep ? await runAppCommand(workspace, keep) : null;
    if (kept?.ok && !kept.missing) {
      if (still()) this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.parkKept);
      return;
    }
    const result = await runAppCommand(workspace, stop);
    // the card's work ended or started afresh meanwhile: its row is no longer this workspace's
    if (!still()) return;
    // a branch older than the stop command: nothing of the app runs there to stop
    if (result.missing) return;
    if (!result.ok) {
      this.o.board.log(cardId, 'error', 'obeya', this.o.board.t.worker.parkFailed(clip(result.output, 600)));
      return;
    }
    this.o.board.work(cardId, { parked: new Date().toISOString(), app: null });
    this.o.board.log(cardId, 'state', 'obeya', this.o.board.t.worker.parked);
  }

  parkedNote(): string {
    const { stop, run } = this.o.adapter.app ?? {};
    return `While the card waited, Obeya stopped the app in your workspace${stop ? ` (\`${stop}\`)` : ''} to free the machine. When you need it again, start it again${run?.trim() ? ' as the recipe in your brief says' : ''}.`;
  }

  /** The workers shut down: no app is parked or forwarded any more. */
  shutdown() {
    this.parking.clearAll();
    for (const id of [...this.forwards.keys()]) this.unforward(id);
  }
}
