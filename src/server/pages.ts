// The open pages and what goes to them over their WebSocket: a page of one canvas, or the phone
// view's one connection to every canvas. Each gets the bar's state, its canvases' snapshots and
// changes, the restart that waits, and what waits for the owner on every canvas; a page behind on a
// slow network gets the newest snapshot once it caught up rather than every one before it.

import type { ServerWebSocket } from 'bun';
import { parsePlace } from '../core/layout';
import { type CanvasInfo, type ClientMessage, type Item, needsYou, type PendingRestart, type ServerMessage, type Waiting, waitingIn, waitingOn } from '../core/types';
import type { AppUpdates } from './app-update';
import type { CanvasRuntime } from './canvas';
import { type Push, startedWaiting } from './push';
import type { Access } from './remote';
import { oldLinuxBun } from './repo';
import type { Restarter } from './self-update';
import type { SourceUpdates } from './source-update';
import { pageStall, type Stalls } from './stalls';
import type { UsageMeters } from './usage';

/**
 * What the server knows of an open page's WebSocket: its canvas (`EVERY` for the phone view's one
 * connection to every canvas), the page, the paired device it is on, if another, and the canvases
 * whose snapshot it is owed while it is behind on a slow network.
 */
export interface Socket {
  canvas: string;
  page: string;
  device?: string;
  owed?: Set<string>;
}

/** The canvas of a connection to every canvas: each message about one names it (`canvas`). */
const EVERY = '';
/** What a connection may hold unsent before a newer snapshot replaces the ones it has not sent yet. */
const BEHIND_BYTES = 256 * 1024;

/** The canvases a server serves: those that run now, and word whenever one starts, stops or changes (`Canvases`). */
export interface Served {
  all(): CanvasRuntime[];
  onChange?(fn: () => void): () => void;
}

export interface PagesOptions {
  canvases: Served;
  access: Access;
  push: Push;
  updates: AppUpdates;
  restarter?: Restarter;
  sources?: SourceUpdates;
  usage?: UsageMeters;
  /** Where the stalls of the pages go, beside the server's own. */
  stalls?: Stalls;
  /** Whether the pages show what the agents cost, as the owner chose. */
  costs: () => boolean;
}

export class Pages {
  /** This run of the server: a page that hears another after reconnecting knows the server started again. */
  private readonly started = crypto.randomUUID();
  private readonly byId = new Map<string, CanvasRuntime>();
  private readonly sockets = new Map<string, Set<ServerWebSocket<Socket>>>([[EVERY, new Set()]]);
  /** What waits for the owner on each canvas: every page lists it in its navigation, the other canvases' too. */
  private readonly waiting: Record<string, Waiting> = {};
  /** Each canvas's part of it as last sent, to send it again only when it changed. */
  private readonly waitingSent: Record<string, string> = {};
  /** Who waits for the count of what waits to change (`onCount`). */
  private readonly countWatchers = new Set<() => void>();
  /** What tells the usage meter a page closed, by page. */
  private readonly unwatch = new Map<string, () => void>();
  /** What stops sending each canvas's changes to its pages. */
  private readonly detach = new Map<string, () => void>();
  /** The list the pages' canvas switchers show, as it was last sent. */
  private listed = '';

  constructor(private o: PagesOptions) {
    // a device removed loses its open pages at once
    o.access.onRemoved((device) => {
      for (const set of this.sockets.values()) for (const ws of set) if (ws.data.device === device) ws.close(4401, 'device removed');
    });
    o.restarter?.onChange(() => {
      for (const id of this.byId.keys()) this.sendTo(id, { type: 'restart', restart: this.pending(id) });
    });
    o.updates.onChange(() => this.everyone(this.bar.update()));
    o.sources?.onChange(() => this.everyone(this.bar.source()));
    o.usage?.onChange(() => this.everyone(this.bar.usage()));
    for (const c of o.canvases.all()) this.attach(c);
    this.relist();
    // a canvas started or stopped while Obeya runs: the pages of one that stopped go to another
    o.canvases.onChange?.(() => {
      const now = o.canvases.all();
      for (const [id, c] of [...this.byId])
        if (!now.includes(c)) {
          this.detach.get(id)?.();
          this.detach.delete(id);
          this.byId.delete(id);
          delete this.waiting[id];
          delete this.waitingSent[id];
          // the page asks for the canvases, and goes to the first there is
          for (const ws of this.sockets.get(id) ?? []) ws.close();
          this.sockets.delete(id);
        }
      for (const c of now) if (this.byId.get(c.id) !== c) this.attach(c);
      this.relist();
    });
  }

  /** The running canvas `id`. */
  canvas(id: string): CanvasRuntime | undefined {
    return this.byId.get(id);
  }

  /** The canvases as the pages' switchers list them. */
  list(): CanvasInfo[] {
    return this.o.canvases.all().map((c) => c.board.canvas);
  }

  /** To every page, but those of canvas `but`. */
  everyone(msg: ServerMessage, but?: string) {
    const text = JSON.stringify(msg);
    for (const [id, set] of this.sockets) if (id !== but) for (const ws of set) this.put(ws, text);
  }

  /** How much waits for the owner on every canvas, counted as the bar's button counts it: the app shows it on its icon (app/src/badge.rs). */
  waitingCount(): number {
    return this.o.canvases.all().reduce((n, c) => n + (this.waiting[c.id] ? waitingOn(this.waiting[c.id]!) : 0), 0);
  }

  /** Calls `fn` whenever what waits for the owner may have changed its count; returns what stops it. */
  onCount(fn: () => void): () => void {
    this.countWatchers.add(fn);
    return () => this.countWatchers.delete(fn);
  }

  /** Opens a page's WebSocket: on canvas `canvas`, or without one the phone view's connection to every canvas. */
  upgrade(req: Request, server: Bun.Server<Socket>, canvas?: string): Response | undefined {
    if (canvas !== undefined && !this.byId.has(canvas)) return new Response('WebSocket expected', { status: 400 });
    return server.upgrade(req, { data: { canvas: canvas ?? EVERY, page: crypto.randomUUID(), device: this.o.access.deviceOf(req) } }) ? undefined : new Response('WebSocket expected', { status: 400 });
  }

  /** What the bar shows, as each page gets it on connecting and whenever it changes. */
  private readonly bar = {
    update: (): ServerMessage => ({ type: 'update', update: this.o.updates.current() }),
    source: (): ServerMessage => ({ type: 'source', source: this.o.sources?.current() ?? null }),
    usage: (): ServerMessage => ({ type: 'usage', usage: this.o.usage?.current() ?? null }),
  };

  /** Bun's WebSocket handlers for the pages. */
  readonly websocket = {
    data: {} as Socket,
    // offered to every page, used for those on another device (`put`)
    perMessageDeflate: true,
    open: (ws: ServerWebSocket<Socket>) => {
      const every = ws.data.canvas === EVERY;
      const c = this.byId.get(ws.data.canvas);
      if (!c && !every) return ws.close();
      this.sockets.get(ws.data.canvas)!.add(ws);
      const send = (msg: ServerMessage) => this.put(ws, JSON.stringify(msg));
      send({ type: 'hello', server: this.started, ...(oldLinuxBun() ? { oldBun: Bun.version } : {}) });
      // what the bar shows comes before the snapshot, which draws the bar: it is there from the first frame
      send(this.bar.update());
      send(this.bar.source());
      send(this.bar.usage());
      send({ type: 'costs', shown: this.o.costs() });
      if (this.o.usage) this.unwatch.set(ws.data.page, this.o.usage.watch());
      if (every) send({ type: 'canvases', canvases: this.list() });
      for (const x of every ? this.byId.values() : [c!]) this.greet(ws, x);
    },
    // caught up after a slow stretch: the newest snapshot of each canvas it missed one of
    drain: (ws: ServerWebSocket<Socket>) => {
      const owed = ws.data.owed;
      if (!owed?.size) return;
      // Bun calls this while bytes are still buffered: what does not fit yet waits for the next call
      for (const id of [...owed]) {
        const c = this.byId.get(id);
        if (!c) owed.delete(id);
        else if (!this.toward(ws, c, { type: 'snapshot', snapshot: c.board.snapshot() })) return;
      }
    },
    close: (ws: ServerWebSocket<Socket>) => {
      this.sockets.get(ws.data.canvas)?.delete(ws);
      this.unwatch.get(ws.data.page)?.();
      this.unwatch.delete(ws.data.page);
      this.o.restarter?.hold(ws.data.page);
      // a phone's last page closed: it no longer holds pushes off
      const { device } = ws.data;
      if (device && ![...this.sockets.values()].some((set) => [...set].some((w) => w.data.device === device))) this.o.push.away(device);
    },
    // the owner watching a demo video or dictating in this page holds a restart off
    message: (ws: ServerWebSocket<Socket>, text: string | Buffer) => {
      const { restarter, sources, push, access, stalls } = this.o;
      try {
        const msg = JSON.parse(String(text)) as ClientMessage;
        if (msg.type === 'hold' && Array.isArray(msg.hold)) restarter?.hold(ws.data.page, msg.hold.filter((h) => h === 'video' || h === 'voice'));
        if (msg.type === 'back') for (const c of ws.data.canvas === EVERY ? this.byId.values() : [this.byId.get(ws.data.canvas)]) c?.ownerBack();
        // back from the terminal, say, where the owner committed what stood in the way of a pull, or pulled
        if (msg.type === 'back') void sources?.check(false);
        // the owner uses a page at the machine or on their phone: what starts waiting meanwhile is not pushed
        const { device } = ws.data;
        if (msg.type === 'back' || msg.type === 'here') device ? push.onDevice(device) : push.here();
        if (msg.type === 'away' && device) push.away(device);
        if (msg.type === 'stall') {
          const stall = pageStall(msg);
          const where = `${device ? (access.devices().find((d) => d.id === device)?.name ?? 'another device') : 'this machine'}, ${ws.data.canvas === EVERY ? 'every canvas' : `canvas ${ws.data.canvas}`}`;
          if (stall) stalls?.page(stall, where, ws.data.page);
        }
        if (msg.type === 'focus') {
          const seen = parsePlace(typeof msg.place === 'string' ? msg.place : undefined);
          const c = this.byId.get(ws.data.canvas);
          if (seen && c) c.inView = seen;
        }
      } catch {}
    },
  };

  /** The restart that waits, as canvas `id` sees it: Obeya's, else that of some of its repositories' agents. */
  private pending(id: string): PendingRestart | null {
    const due = this.o.restarter?.due();
    if (!due) return this.byId.get(id)?.pendingRestart() ?? null;
    const here = due.waiting.filter((w) => w.canvas === id);
    // the others by canvas, named, each card by its title: a canvas's page knows only its own cards
    const elsewhere = new Map<string, string[]>();
    const items = new Map<string, Item[]>();
    for (const w of due.waiting) {
      if (w.canvas === id) continue;
      if (!items.has(w.canvas)) items.set(w.canvas, this.byId.get(w.canvas)?.board.items() ?? []);
      const title = items.get(w.canvas)!.find((i) => i.id === w.card)?.title ?? w.card;
      elsewhere.set(w.canvas, [...(elsewhere.get(w.canvas) ?? []), title]);
    }
    return {
      reason: due.reason,
      deadline: due.deadline,
      cards: here.map((w) => w.card),
      elsewhere: [...elsewhere].map(([c, cards]) => ({ canvas: this.byId.get(c)?.board.canvas.name ?? c, cards })),
      owner: due.owner,
    };
  }

  private waitingMessage(): ServerMessage {
    return { type: 'waiting', waiting: this.waiting };
  }

  /** What waits for the owner changed: every page hears of it, and whoever waits for the count. */
  private waitingChanged() {
    // a connection to every canvas has their snapshots, which hold it already
    this.everyone(this.waitingMessage(), EVERY);
    for (const w of [...this.countWatchers]) w();
  }

  /** Takes in what waits on `c` now; whether that changed. */
  private counted(c: CanvasRuntime, snapshot = c.board.snapshot()) {
    const w = waitingIn(snapshot);
    const text = JSON.stringify(w);
    if (text === this.waitingSent[c.id]) return false;
    this.waiting[c.id] = w;
    this.waitingSent[c.id] = text;
    return true;
  }

  /** To another device compressed: what Obeya sends is JSON, which shrinks to a tenth, and a phone's network may be slow. */
  private put(ws: ServerWebSocket<Socket>, text: string) {
    return ws.send(text, !!ws.data.device);
  }

  /** A message about canvas `id`, as a connection to every canvas gets it: naming the canvas. */
  private named(id: string, text: string) {
    return `{"canvas":${JSON.stringify(id)},${text.slice(1)}`;
  }

  /**
   * A snapshot to a page that is behind (a slow network, a phone in a tunnel) does not queue up
   * behind the ones before it: the page is owed canvas `id`'s and gets the newest once it caught
   * up (`drain`). One that Bun dropped (past its backpressure limit) stays owed too. False when owed.
   */
  private deliver(ws: ServerWebSocket<Socket>, id: string, type: ServerMessage['type'], text: string) {
    if (type !== 'snapshot') {
      this.put(ws, text);
      return true;
    }
    const sent = ws.getBufferedAmount() <= BEHIND_BYTES && this.put(ws, text) !== 0;
    if (sent) ws.data.owed?.delete(id);
    else (ws.data.owed ??= new Set()).add(id);
    return sent;
  }

  /** Canvas `c`'s message as page `ws` takes it: naming the canvas on a connection to every canvas. */
  private toward(ws: ServerWebSocket<Socket>, c: CanvasRuntime, msg: ServerMessage) {
    const text = JSON.stringify(msg);
    return this.deliver(ws, c.id, msg.type, ws.data.canvas === EVERY ? this.named(c.id, text) : text);
  }

  private sendTo(id: string, msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets.get(id) ?? []) this.deliver(ws, id, msg.type, text);
    const every = this.sockets.get(EVERY);
    if (!every?.size) return;
    const tagged = this.named(id, text);
    for (const ws of every) this.deliver(ws, id, msg.type, tagged);
  }

  /** What canvas `c` sends a page as it connects: its restart, its snapshot, the notices still to undo. */
  private greet(ws: ServerWebSocket<Socket>, c: CanvasRuntime) {
    const send = (msg: ServerMessage) => this.toward(ws, c, msg);
    send({ type: 'restart', restart: this.pending(c.id) });
    send({ type: 'snapshot', snapshot: c.board.snapshot() });
    if (ws.data.canvas !== EVERY) this.put(ws, JSON.stringify(this.waitingMessage()));
    // a page that reloads within a command's undo window offers "Undo" again
    for (const n of c.commander.undoable()) send({ type: 'notice', ...n });
  }

  private attach(c: CanvasRuntime) {
    this.byId.set(c.id, c);
    if (!this.sockets.has(c.id)) this.sockets.set(c.id, new Set());
    this.counted(c);
    // a canvas started while Obeya runs: the connections to every canvas get it too
    for (const ws of this.sockets.get(EVERY) ?? []) this.greet(ws, c);
    const send = (msg: ServerMessage) => this.sendTo(c.id, msg);
    /** The cards as last sent: what starts to wait for the owner after is pushed to their phone. */
    let seen = new Map(c.board.items().map((i) => [i.id, i]));
    const offs = [
      c.board.onChange(() => {
        const items = c.board.items();
        const started = startedWaiting(seen, items);
        seen = new Map(items.map((i) => [i.id, i]));
        const several = this.o.canvases.all().length > 1;
        this.o.push.waits(
          started.map(({ item, kind }) => ({
            card: item.id,
            title: item.title,
            kind,
            ...(several ? { canvas: c.board.canvas.name } : {}),
            still: () => {
              const now = c.board.item(item.id);
              return !!now && needsYou(now);
            },
          })),
        );
        const snapshot = c.board.snapshot();
        send({ type: 'snapshot', snapshot });
        // what the switchers show of it (its repositories, whether they run as configured) may have changed
        this.relist();
        if (this.counted(c, snapshot)) this.waitingChanged();
      }),
      c.board.onEvent((event) => send({ type: 'event', event })),
      c.board.onEventGone((cardId, id) => send({ type: 'eventGone', cardId, id })),
      c.board.onNotice((n) => send({ type: 'notice', ...n })),
      // its repositories' agents restarted: what the switchers show of it may have changed with them
      c.onPending(() => {
        send({ type: 'restart', restart: this.pending(c.id) });
        this.relist();
      }),
    ];
    this.detach.set(c.id, () => offs.forEach((off) => off()));
  }

  /** Sends the canvases to every page where they changed (one started, stopped, renamed, or with other repositories). */
  private relist() {
    const now = this.list();
    const list = JSON.stringify(now);
    if (list === this.listed) return;
    const first = !this.listed;
    this.listed = list;
    if (first) return;
    this.everyone({ type: 'canvases', canvases: now });
    this.waitingChanged();
  }
}
