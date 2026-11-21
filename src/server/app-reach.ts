// A card's app for the owner's phone: the app listens on this machine (`localhost:5173`, say), which
// the phone cannot reach. Opened from another device, Obeya puts a proxy of its own in front of it,
// at the address other devices reach Obeya under with a port of its own: through Tailscale
// `https://<machine>.<tailnet>.ts.net:<port>` (a `tailscale serve` entry to the proxy on 127.0.0.1),
// on another address `http://<address>:<port>`. The port is the app's own number where it is free,
// so the address reads like the app's. The proxy lets in only paired devices, as Obeya does, and
// passes requests and WebSockets on to the app as if they came from this machine: under the app's
// own host, without Obeya's cookies. It stays while the app answers, and goes once it no longer
// does, when the network changes, and when Obeya stops.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NamedEntry, Tailscale } from './tailscale';

/** The `tailscale serve` entries Obeya made for cards' apps, in its home, so a restart removes those of a run that ended without it. */
const APPS_FILE = 'tailscale-serve-apps.json';
/** How often Obeya looks whether the apps it makes reachable still answer. */
const SWEEP_MS = 60_000;
/** How long a look waits for the app to answer. */
const PROBE_MS = 1500;
/** Looks in a row an app may miss before its proxy goes: a dev server restarting answers again soon. */
const MISSES = 3;

/** Where other devices reach Obeya, and so the proxies in front of its cards' apps. */
export type Where = { via: 'tailscale'; name: string } | { via: 'address'; address: string };

/** Obeya's cookies, which the app never sees: the device's and the owner's (`obeya-<port>`). */
const OURS = /^obeya-/;
/** Headers that belong to one connection and do not pass a proxy, and those a proxy before this one added. */
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];
/** What the WebSocket handshake sets itself. */
const HANDSHAKE = /^sec-websocket-/;

/** An address as it stands in a URL: IPv6 in brackets. */
const inUrl = (address: string) => (address.includes(':') ? `[${address}]` : address);

interface Exposure {
  /** The app's origin on this machine. */
  target: string;
  /** Where other devices open it. */
  origin: string;
  server: Bun.Server<Socket>;
  entry?: NamedEntry;
  misses: number;
}

interface Socket {
  up: WebSocket;
  /** The paired device it came from: removed, its sockets close. */
  device: string;
  /** What the app sent before the device's side was open. */
  early: (string | ArrayBuffer)[];
  down?: Bun.ServerWebSocket<Socket>;
}

export interface AppReachOptions {
  tailscale: Tailscale;
  /** Obeya's home, for the entries it made; none in a test. */
  home?: string;
  /** The paired device a request comes from, by its id; `null` for none. */
  paired: (req: Request) => string | null;
  /** The page a device that is not paired gets. */
  notPaired: () => Response;
  sweepMs?: number;
}

export class AppReach {
  private exposures = new Map<string, Promise<Exposure>>();
  private where: string | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** The WebSockets open through the proxies. */
  private sockets = new Set<Bun.ServerWebSocket<Socket>>();

  constructor(private o: AppReachOptions) {}

  /**
   * The address under which a device reaches the app at `app` (a URL on this machine), its proxy
   * made at the first call; throws with what went wrong, Tailscale's words, say.
   */
  async reach(app: string, where: Where): Promise<string> {
    const url = new URL(app);
    const key = JSON.stringify(where);
    if (this.where !== key) {
      await this.close();
      this.where = key;
    }
    let made = this.exposures.get(url.origin);
    if (!made) {
      made = this.expose(url, where);
      this.exposures.set(url.origin, made);
      made.catch(() => this.exposures.delete(url.origin));
    }
    const e = await made;
    this.sweepLater();
    return `${e.origin}${url.pathname}${url.search}${url.hash}`;
  }

  private async expose(app: URL, where: Where): Promise<Exposure> {
    const target = app.origin;
    const wanted = Number(app.port) || (app.protocol === 'https:' ? 443 : 80);
    const handler = this.handler(target);
    if (where.via === 'address') {
      // the app's own number, unless that is taken on this address (the app itself listening on all of them, say)
      let server: Bun.Server<Socket>;
      try {
        server = Bun.serve<Socket>({ ...handler, hostname: where.address, port: wanted });
      } catch {
        server = Bun.serve<Socket>({ ...handler, hostname: where.address, port: 0 });
      }
      return { target, origin: new URL(`http://${inUrl(where.address)}:${server.port}`).origin, server, misses: 0 };
    }
    const server = Bun.serve<Socket>({ ...handler, hostname: '127.0.0.1', port: 0 });
    const r = await this.o.tailscale.serveApp(where.name, [wanted, server.port!], `http://127.0.0.1:${server.port}`);
    if ('problem' in r) {
      void server.stop(true);
      throw new Error(r.problem.code === 'failed' || r.problem.code === 'listen' ? r.problem.detail : r.problem.code);
    }
    this.note([...this.noted(), r.entry]);
    return { target, origin: `https://${where.name}:${r.entry.https}`, server, entry: r.entry, misses: 0 };
  }

  /** What the proxy in front of the app at `target` answers. */
  private handler(target: string) {
    const o = this.o;
    // the path joined to the app's origin as text: as a URL relative to it, `//host/…` would name another host
    const toApp = (req: Request) => {
      const from = new URL(req.url);
      return new URL(target + from.pathname + from.search);
    };
    const headers = (req: Request, origin: string) => {
      const h = new Headers();
      for (const [k, v] of req.headers) if (!HOP.includes(k)) h.set(k, v);
      h.set('host', new URL(target).host);
      const cookies = (req.headers.get('cookie') ?? '')
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c && !OURS.test(c));
      if (cookies.length) h.set('cookie', cookies.join('; '));
      else h.delete('cookie');
      // the page's own origin as the app knows it, for its checks of where a request comes from
      if (h.get('origin') === origin) h.set('origin', target);
      const referer = h.get('referer');
      if (referer?.startsWith(`${origin}/`)) h.set('referer', target + referer.slice(origin.length));
      return h;
    };
    const originOf = (req: Request) => {
      const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.slice(0, -1);
      const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
      return `${proto}://${host}`;
    };
    return {
      idleTimeout: 0,
      fetch: async (req: Request, server: Bun.Server<Socket>): Promise<Response | undefined> => {
        const device = o.paired(req);
        if (!device) return o.notPaired();
        const origin = originOf(req);
        // the device's cookie goes with what other sites' pages send too: from them only opening a
        // page of the app passes (a link), as at Obeya's own gate; a form they post, a fetch or a WebSocket does not
        const given = req.headers.get('origin');
        const foreign = req.headers.get('sec-fetch-site') === 'cross-site' || (!!given && given !== origin);
        const opening = (req.method === 'GET' || req.method === 'HEAD') && req.headers.get('sec-fetch-mode') === 'navigate' && req.headers.get('upgrade') === null;
        if (foreign && !opening) return new Response('Only the app itself may call it', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        const h = headers(req, origin);
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          for (const k of [...h.keys()]) if (HANDSHAKE.test(k)) h.delete(k);
          const to = toApp(req);
          to.protocol = to.protocol === 'https:' ? 'wss:' : 'ws:';
          const up = new WebSocket(to.href, { headers: Object.fromEntries(h), protocols, tls: { rejectUnauthorized: false } } as unknown as string[]);
          up.binaryType = 'arraybuffer';
          const data: Socket = { up, device, early: [] };
          up.onmessage = (e) => (data.down ? data.down.send(e.data as string | ArrayBuffer) : data.early.push(e.data as string | ArrayBuffer));
          up.onclose = (e) => data.down?.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
          const open = await new Promise<boolean>((done) => {
            up.onopen = () => done(true);
            up.onerror = () => done(false);
          });
          if (!open) return new Response('The app refused the WebSocket', { status: 502 });
          return server.upgrade(req, { data, headers: up.protocol ? { 'sec-websocket-protocol': up.protocol } : {} }) ? undefined : new Response('Upgrade failed', { status: 400 });
        }
        let res: Response;
        try {
          res = await fetch(toApp(req), {
            method: req.method,
            headers: h,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
            redirect: 'manual',
            decompress: false,
            tls: { rejectUnauthorized: false },
          } as RequestInit);
        } catch {
          return new Response('The app does not answer', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        const out = new Headers(res.headers);
        out.delete('transfer-encoding');
        out.delete('connection');
        // a redirect within the app stays at the address the device reaches it under
        const location = out.get('location');
        if (location?.startsWith(target)) out.set('location', origin + location.slice(target.length));
        // the app sets no cookie of Obeya's on the device: it would sign the device out of Obeya
        const cookies = res.headers.getSetCookie().filter((c) => !OURS.test(c.trim()));
        out.delete('set-cookie');
        for (const c of cookies) out.append('set-cookie', c);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
      },
      websocket: {
        open: (ws: Bun.ServerWebSocket<Socket>) => {
          ws.data.down = ws;
          this.sockets.add(ws);
          for (const m of ws.data.early.splice(0)) ws.send(m);
        },
        message(ws: Bun.ServerWebSocket<Socket>, m: string | Buffer) {
          if (ws.data.up.readyState === WebSocket.OPEN) ws.data.up.send(m as string | Uint8Array<ArrayBuffer>);
        },
        close: (ws: Bun.ServerWebSocket<Socket>) => {
          this.sockets.delete(ws);
          ws.data.up.close();
        },
      },
    };
  }

  /** Looks every while whether the apps still answer, as long as there are any. */
  private sweepLater() {
    if (this.sweeper || !this.exposures.size) return;
    this.sweeper = setInterval(() => void this.sweep(), this.o.sweepMs ?? SWEEP_MS);
    this.sweeper.unref?.();
  }

  /** An app that no longer answers loses its proxy. */
  async sweep() {
    for (const [key, made] of this.exposures) {
      const e = await made.catch(() => null);
      if (!e) continue;
      const up = await fetch(e.target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS), tls: { rejectUnauthorized: false } } as RequestInit).then(
        () => true,
        () => false,
      );
      e.misses = up ? 0 : e.misses + 1;
      if (e.misses >= MISSES && this.exposures.get(key) === made) await this.drop([key]);
    }
    if (!this.exposures.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private async drop(keys: string[]) {
    const gone = (await Promise.all(keys.map((k) => this.exposures.get(k)?.catch(() => null)))).filter((e): e is Exposure => !!e);
    for (const k of keys) this.exposures.delete(k);
    for (const e of gone) void e.server.stop(true);
    const entries = gone.flatMap((e) => (e.entry ? [e.entry] : []));
    if (!entries.length) return;
    // an entry Tailscale did not let go stays noted, so the next start takes it back
    if (!(await this.o.tailscale.unserve(entries).catch(() => false))) return;
    const left = this.noted().filter((n) => !entries.some((e) => e.https === n.https && e.name === n.name && e.target === n.target));
    this.note(left);
  }

  /** A device was removed: its WebSockets to the apps close, as its pages' to Obeya do. */
  revoke(device: string) {
    for (const ws of this.sockets) if (ws.data.device === device) ws.close(1008, 'device removed');
  }

  /** Where the proxies are now, as `reach` was last given it; `null` while there are none. */
  at(): Where | null {
    return this.where && this.exposures.size ? (JSON.parse(this.where) as Where) : null;
  }

  /** All proxies go: the network changed or was turned off. */
  async close() {
    await this.drop([...this.exposures.keys()]);
    this.where = null;
  }

  /**
   * Obeya stops: the proxies go with it, their entries too, waiting for that, and those a run before
   * left behind (ended without removing them).
   */
  release() {
    for (const made of this.exposures.values()) void made.then((e) => e.server.stop(true), () => {});
    this.exposures.clear();
    const entries = this.noted();
    if (!entries.length || this.o.tailscale.unserveSync(entries)) this.note([]);
  }

  /** Obeya starts: entries a run before left behind go, so their ports serve nothing that is not behind the gate. */
  async tidy() {
    const left = this.noted();
    if (!left.length) return;
    if (await this.o.tailscale.unserve(left).catch(() => false)) this.note([]);
  }

  /** The entries noted: in the home, or in memory in a test without one. */
  private noted(): NamedEntry[] {
    if (!this.o.home) return this.memory;
    if (!existsSync(join(this.o.home, APPS_FILE))) return [];
    try {
      const list = JSON.parse(readFileSync(join(this.o.home, APPS_FILE), 'utf8')) as NamedEntry[];
      return Array.isArray(list) ? list.filter((e) => typeof e?.https === 'number' && typeof e.name === 'string' && typeof e.target === 'string') : [];
    } catch {
      return [];
    }
  }

  private memory: NamedEntry[] = [];

  private note(entries: NamedEntry[]) {
    this.memory = entries;
    if (!this.o.home) return;
    if (entries.length) writeFileSync(join(this.o.home, APPS_FILE), `${JSON.stringify(entries, null, 2)}\n`);
    else rmSync(join(this.o.home, APPS_FILE), { force: true });
  }
}
