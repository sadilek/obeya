// Other devices reaching Obeya: the owner's phone over the owner's own private network. Obeya keeps
// listening on 127.0.0.1; with the setting "Reachable from other devices" on, `tailscale serve`
// proxies HTTPS at the machine's tailnet name to it (tailscale.ts), or Obeya also listens on an
// address of this machine the owner picked (another VPN's interface), in plain HTTP.
//
// A request is local when it comes from loopback under one of this machine's names and no proxy
// forwarded it; through `tailscale serve` requests come from 127.0.0.1 too, but under the tailnet
// name and with `X-Forwarded-For`, and count as remote. A remote request needs a paired device:
// the page "Connect a phone" shows a one-time code (in a QR code with the address), the device
// opens it, and gets a cookie that Obeya keeps only the hash of. Without one it gets a page that
// says how to connect, and no API. Pairing, the devices and the setting are managed only on this
// machine itself. A device stays paired until it is removed or goes unused for `UNUSED_MS`.

import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../core/locale';
import { MESSAGES } from '../core/messages';
import type { AccessView, DeviceView, Pairing, RemoteProblem, RemoteSetting, TailscaleState } from '../core/types';
import { LOCAL_HOSTS, hostname, type Gate } from './access';
import { BadRequest } from './board';
import type { Store } from './db';
import { OWNER_SETTINGS_FILE as SETTINGS_FILE } from '../../plugin/skills/demo/lib/language.ts';
import { cookie, Owner } from './owner';
import { remoteOf, remoteSetting, saveRemote } from './settings';
import { type NamedEntry, Tailscale } from './tailscale';

export const DEVICE_COOKIE = 'obeya-device';
/** How long a pairing code holds. */
export const PAIRING_MS = 5 * 60_000;
/** Wrong codes after which a pairing code no longer pairs anything. */
const PAIRING_TRIES = 5;
/** A device unused this long is no longer paired: a phone given away or lost and forgotten. */
export const UNUSED_MS = 90 * 24 * 3600_000;
/** How often a device's "last seen" is written. */
const SEEN_EVERY_MS = 60_000;
/** The cookie's own lifetime, the longest browsers keep one (400 days); Obeya's `UNUSED_MS` decides. */
const COOKIE_MAX_AGE = 400 * 24 * 3600;
/** The `tailscale serve` entry Obeya made, in its home, so turning the setting off removes it after a restart too. */
const SERVE_FILE = 'tailscale-serve.json';

/** The icons of the web app's manifest and its service worker: the same for everyone, and nothing in them the owner's. */
export const PUBLIC = new Set(['/sw.js', '/icons/180.png', '/icons/512.png']);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'forwarded'];

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** A device's name from its browser's user agent: "iPhone · Safari". */
export function deviceName(ua: string): string {
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : '';
  const browser = /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [device, browser].filter(Boolean).join(' · ') || ua.slice(0, 40) || '?';
}

/** This machine's addresses beyond loopback, IPv4 first: where another VPN may reach it. */
export function machineAddresses(): string[] {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80')));
  return [...all.filter((a) => a!.family === 'IPv4'), ...all.filter((a) => a!.family === 'IPv6')].map((a) => a!.address);
}

/**
 * Where a remote request reached Obeya, as the device's browser has it: behind `tailscale serve`
 * (from loopback), from the headers it forwards; on the other address, as it came.
 */
function originOf(req: Request, proxied: boolean): string | null {
  const proto = (proxied && req.headers.get('x-forwarded-proto')) || new URL(req.url).protocol.slice(0, -1);
  const host = (proxied && req.headers.get('x-forwarded-host')) || req.headers.get('host');
  if (!host) return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** An address as it stands in a URL and a `Host` header: IPv6 in brackets. */
const inUrl = (address: string) => (address.includes(':') ? `[${address}]` : address);

export interface AccessOptions {
  store: Store;
  /** Obeya's home, with the setting in `settings.json`; without one (a test) it is kept in memory. */
  home?: string;
  tailscale?: Tailscale;
  language?: () => Language;
  now?: () => number;
  platform?: string;
  /** Who is the owner on this machine; by default the key in `home` (made up for a test without one). */
  owner?: Owner;
}

/** What answers on another address: started and stopped by the server, which knows its routes. */
export type Listen = (address: string | null) => void;

export class Access implements Gate {
  /** The owner's key: what a request from this machine names. */
  readonly owner: Owner;
  readonly store: Store;
  private readonly home?: string;
  private readonly tailscale: Tailscale;
  private readonly language: () => Language;
  private readonly now: () => number;
  private readonly platform: string;
  private setting: RemoteSetting | null;
  private ts: TailscaleState = { state: 'missing' };
  /** The `tailscale serve` entry Obeya keeps, and the tailnet name it serves at. */
  private served: NamedEntry | null = null;
  /** The other address Obeya listens on. */
  private listening: string | null = null;
  private problem: RemoteProblem | undefined;
  private port = 0;
  private listen: Listen = () => {};
  /** The current one-time code, for the address it was made at: another address makes a new one. */
  private pairing: { code: string; address: string; expires: number; tries: number; paired?: DeviceView; replaced?: string } | null = null;
  /** The device each admitted remote request came from: its WebSocket closes when the device is removed. */
  private readonly from = new WeakMap<Request, string>();
  private readonly removedFns = new Set<(id: string) => void>();
  /** Changes to the network, one after the other. */
  private applying: Promise<void> = Promise.resolve();

  constructor(o: AccessOptions) {
    this.store = o.store;
    this.home = o.home;
    this.tailscale = o.tailscale ?? new Tailscale();
    this.language = o.language ?? (() => 'de');
    this.now = o.now ?? Date.now;
    this.platform = o.platform ?? process.platform;
    this.owner = o.owner ?? new Owner({ home: o.home, language: this.language });
    this.setting = o.home ? remoteSetting(o.home) : null;
    this.served = this.readServed();
  }

  // ------------------------------------------------------------ the network

  /** Obeya's server answers on `port`: the network is made as the setting says. */
  start(port: number, listen: Listen): Promise<void> {
    this.port = port;
    this.listen = listen;
    return this.apply(true);
  }

  /** Stops answering on the other address. */
  stop() {
    if (this.listening) this.listen(null);
    this.listening = null;
  }

  /**
   * Obeya stops: the `tailscale serve` entry goes with it, so whatever takes its port afterwards is
   * not served to the tailnet. The next start serves Obeya again, at the same address while 443 is free.
   */
  release() {
    this.stop();
    if (!this.served) return;
    this.tailscale.unserveSync(this.served);
    this.keepServed(null);
  }

  /** Makes the network as the setting says; `check`: asks Tailscale even where it was asked before. */
  private apply(check = false): Promise<void> {
    this.applying = this.applying.then(async () => {
      try {
        await this.applyNow(check);
      } catch (e) {
        this.problem = { code: 'failed', detail: (e as Error).message };
      }
    });
    return this.applying;
  }

  private async applyNow(check: boolean) {
    const s = this.setting;
    if (s?.via !== 'address' && this.listening) {
      this.listen(null);
      this.listening = null;
    }
    if (s?.via !== 'tailscale') {
      if (this.served) {
        await this.tailscale.unserve(this.served).catch(() => {});
        this.keepServed(null);
      }
      if (s?.via === 'address' && this.listening !== s.address) {
        this.problem = undefined;
        if (this.listening) this.listen(null);
        this.listening = null;
        if (!machineAddresses().includes(s.address)) {
          this.problem = { code: 'listen', detail: `${s.address} is not an address of this machine` };
          return;
        }
        try {
          this.listen(s.address);
          this.listening = s.address;
        } catch (e) {
          this.problem = { code: 'listen', detail: (e as Error).message };
        }
      }
      if (!s) this.problem = undefined;
      return;
    }
    if (check || this.ts.state !== 'ready') this.ts = await this.tailscale.state();
    if (this.ts.state !== 'ready') return void (this.problem = undefined);
    const name = this.ts.name;
    if (this.served && this.served.name === name && this.served.target === `http://127.0.0.1:${this.port}` && !check && !this.problem) return;
    const r = await this.tailscale.serve(name, this.port, this.served);
    if ('problem' in r) {
      this.problem = r.problem;
      return;
    }
    this.problem = undefined;
    this.keepServed({ ...r.entry, name });
  }

  private readServed(): NamedEntry | null {
    if (!this.home || !existsSync(join(this.home, SERVE_FILE))) return null;
    try {
      const o = JSON.parse(readFileSync(join(this.home, SERVE_FILE), 'utf8')) as NamedEntry;
      return typeof o.https === 'number' && typeof o.target === 'string' && typeof o.name === 'string' ? o : null;
    } catch {
      return null;
    }
  }

  private keepServed(entry: NamedEntry | null) {
    this.served = entry;
    if (!this.home) return;
    if (entry) writeFileSync(join(this.home, SERVE_FILE), `${JSON.stringify(entry, null, 2)}\n`);
    else rmSync(join(this.home, SERVE_FILE), { force: true });
  }

  /**
   * How long Obeya keeps this machine from sleeping for other devices: `off` while they may not reach
   * it, else `always` or only while a worker `works`, as the owner set it.
   */
  awake(): 'off' | 'works' | 'always' {
    return !this.setting ? 'off' : this.setting.awake === 'always' ? 'always' : 'works';
  }

  /** Where other devices reach Obeya now; `null` while they do not. */
  address(): string | null {
    const s = this.setting;
    if (s?.via === 'tailscale' && this.served && this.ts.state === 'ready' && this.served.name === this.ts.name && !this.problem)
      return `https://${this.served.name}${this.served.https === 443 ? '' : `:${this.served.https}`}`;
    // as a browser's origin has it, port 80 left out, for comparing with the address a device's app keeps
    if (s?.via === 'address' && this.listening === s.address) return new URL(`http://${inUrl(s.address)}:${this.port}`).origin;
    return null;
  }

  /** The names requests may come under: this machine's, the tailnet name Obeya is served at, the other address. */
  hosts(): readonly string[] {
    return [...LOCAL_HOSTS, ...(this.served && this.setting?.via === 'tailscale' ? [this.served.name] : []), ...(this.listening ? [inUrl(this.listening).toLowerCase()] : [])];
  }

  /**
   * Whether other devices reach Obeya through Tailscale: served at its tailnet name, or listening on
   * one of the machine's addresses in the tailnet. A phone that loses Obeya names Tailscale only then.
   */
  async tailnet(): Promise<boolean> {
    if (this.setting?.via === 'tailscale') return true;
    if (!this.listening) return false;
    return (await this.tailscale.addresses()).includes(this.listening.toLowerCase());
  }

  /** The section "Other devices", with what Tailscale says now (and the network made anew if that changed). */
  async view(): Promise<AccessView> {
    if (this.setting?.via === 'tailscale') {
      const before = JSON.stringify(this.ts);
      this.ts = await this.tailscale.state();
      if (JSON.stringify(this.ts) !== before || (this.ts.state === 'ready' && !this.served)) await this.apply();
    } else this.ts = await this.tailscale.state();
    await this.applying;
    const p = this.livePairing();
    return {
      local: true,
      file: this.home ? join(this.home, SETTINGS_FILE) : SETTINGS_FILE,
      remote: this.setting,
      tailscale: this.ts,
      address: this.address(),
      ...(this.problem && this.setting ? { problem: this.problem } : {}),
      addresses: machineAddresses(),
      devices: this.devices(),
      pairing: p,
      platform: this.platform,
    };
  }

  /** Saves the setting (`{ remote }`), makes the network as it says, and returns the section. */
  async save(input: unknown): Promise<AccessView> {
    const given = (input as { remote?: unknown } | null)?.remote;
    if (given !== null && !remoteOf(given)) throw new BadRequest('invalid', 'remote must be null, { via: "tailscale" } or { via: "address", address }, each with an optional awake: "always"');
    this.setting = this.home ? saveRemote(this.home, input) : remoteOf(given);
    this.problem = undefined;
    if (!this.setting) this.pairing = null;
    await this.apply(true);
    return this.view();
  }

  // ------------------------------------------------------------ who comes in

  /** From this machine: loopback, under one of its names, forwarded by no proxy. */
  isLocal(req: Request, server: Bun.Server<unknown>): boolean {
    const ip = server.requestIP(req)?.address;
    return !!ip && LOOPBACK.has(ip) && !FORWARDED.some((h) => req.headers.has(h)) && LOCAL_HOSTS.includes(hostname(req.headers.get('host') ?? ''));
  }

  /**
   * What a request gets instead of its route's answer, or `null`: a local one passes with the
   * owner's key (and to sign in), a remote one from a paired device too, but for managing access;
   * another gets the page that says how to sign in or connect, or a 401 for the API.
   */
  admit(req: Request, server: Bun.Server<unknown>, route: string): Response | null {
    // what a browser fetches to make the home-screen app, maybe without its cookies: nothing in them is the owner's
    if (PUBLIC.has(route)) return null;
    if (this.isLocal(req, server)) return route === '/login' ? null : this.owner.refusal(req, server.port!, route);
    if (route === '/pair') return null;
    const device = this.device(req);
    if (device) {
      this.from.set(req, device.id);
      // the app on the device's home screen says so as its WebSocket connects (`?app`): the address it keeps
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket' && new URL(req.url).searchParams.has('app'))
        this.appAt(device, originOf(req, LOOPBACK.has(server.requestIP(req)?.address ?? '')));
      if (route.startsWith('/api/access') && !(route === '/api/access' && req.method === 'GET'))
        return Response.json({ code: 'onlyHere', error: 'only on the machine Obeya runs on' }, { status: 403 });
      return null;
    }
    if (route.startsWith('/api/')) return Response.json({ code: 'notPaired', error: 'this device is not paired with Obeya' }, { status: 401 });
    return this.notPairedPage(false);
  }

  /** `/login`: a browser on this machine signs in with a one-time link; another device goes to the canvas, or to how to connect. */
  loginRoute(req: Request, server: Bun.Server<unknown>): Response {
    return this.isLocal(req, server) ? this.owner.login(req, server.port!) : new Response(null, { status: 303, headers: { location: '/' } });
  }

  /** The device an admitted remote request came from. */
  deviceOf(req: Request): string | undefined {
    return this.from.get(req);
  }

  /** The paired device a request's cookie names; one unused for too long is removed. */
  device(req: Request): DeviceView | null {
    const token = cookie(req, DEVICE_COOKIE);
    if (!token) return null;
    const d = this.store.deviceByToken(sha256(token));
    if (!d) return null;
    const now = this.now();
    const seen = Date.parse(d.lastSeen);
    if (now - seen > UNUSED_MS) {
      this.remove(d.id);
      return null;
    }
    if (now - seen > SEEN_EVERY_MS) this.store.deviceSeen(d.id, new Date(now).toISOString());
    return d;
  }

  /** The device's app on the home screen opened Obeya at `origin`. */
  private appAt(device: DeviceView, origin: string | null) {
    if (origin && device.app !== origin) this.store.setDeviceApp(device.id, origin);
  }

  devices(): DeviceView[] {
    const now = this.now();
    return this.store.devices().filter((d) => now - Date.parse(d.lastSeen) <= UNUSED_MS);
  }

  /** Removes a device at once: its cookie lets nothing in any more, and its open pages lose their connection. */
  remove(id: string): boolean {
    const gone = this.store.removeDevice(id);
    if (gone) for (const fn of this.removedFns) fn(id);
    return gone;
  }

  onRemoved(fn: (id: string) => void) {
    this.removedFns.add(fn);
    return () => this.removedFns.delete(fn);
  }

  // ------------------------------------------------------------ pairing

  private livePairing(): Pairing | null {
    const address = this.address();
    // a code made at another address is gone, also once Obeya is back at the one it was made at
    if (this.pairing && this.pairing.address !== address) this.pairing = null;
    const p = this.pairing;
    if (!p || !address || p.expires <= this.now()) return null;
    return { code: p.code, url: `${address}/pair?code=${p.code}`, expires: new Date(p.expires).toISOString(), ...(p.paired ? { paired: p.paired } : {}), ...(p.replaced ? { replaced: p.replaced } : {}) };
  }

  /** A new one-time code, valid for `PAIRING_MS`; the one before no longer pairs. */
  pair(): Pairing {
    const address = this.address();
    if (!address) throw new BadRequest('notReachable', 'other devices do not reach Obeya yet');
    const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
    this.pairing = { code: String(n).padStart(6, '0'), address, expires: this.now() + PAIRING_MS, tries: 0 };
    return this.livePairing()!;
  }

  /**
   * Pairs the device that brings the current code; its cookie, or `null` for a wrong or expired code.
   * `counts`: a wrong code spends one of the tries; one another site sent the browser here with spends none.
   */
  redeem(code: string, userAgent: string, counts = true): { token: string; device: DeviceView } | null {
    if (this.pairing && this.pairing.address !== this.address()) this.pairing = null;
    const p = this.pairing;
    if (!p || p.paired || p.expires <= this.now()) return null;
    if (code.replace(/\D/g, '') !== p.code) {
      // guessing gets five tries at a code, then it is spent
      if (counts && ++p.tries >= PAIRING_TRIES) this.pairing = null;
      return null;
    }
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const at = new Date(this.now()).toISOString();
    const device: DeviceView = { id: crypto.randomUUID(), name: deviceName(userAgent), pairedAt: at, lastSeen: at };
    // the same phone again, after Obeya's address changed: the browser keeps a cookie per name, so
    // it pairs anew, and its entry under the old address goes (one per pairing, for two such phones)
    const address = this.address();
    const old = this.devices()
      .filter((d) => d.name === device.name && d.app && d.app !== address)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
    if (old) this.remove(old.id);
    this.store.addDevice({ ...device, tokenHash: sha256(token) });
    p.paired = device;
    if (old) p.replaced = old.app;
    console.log(`Obeya: ${device.name} paired`);
    return { token, device };
  }

  /**
   * `/pair`: the address in the QR code (`?code=`) or the form of the page for devices not paired
   * yet. A device with the right code gets its cookie and goes to the canvas.
   */
  async pairRoute(req: Request, server: Bun.Server<unknown>): Promise<Response> {
    if (this.isLocal(req, server) || this.device(req)) return new Response(null, { status: 303, headers: { location: '/' } });
    const code = req.method === 'POST' ? String((await req.formData().catch(() => null))?.get('code') ?? '') : (new URL(req.url).searchParams.get('code') ?? '');
    // another site may send a browser in the tailnet here as often as it likes, to spend the code's tries
    const paired = this.redeem(code, req.headers.get('user-agent') ?? '', req.headers.get('sec-fetch-site') !== 'cross-site');
    if (!paired) return this.notPairedPage(true);
    // over HTTPS the cookie goes with what a worker's HTML artifact loads in its sandboxed frame too, which counts as another site
    const https = (req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')) === 'https';
    const given = `${DEVICE_COOKIE}=${paired.token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; ${https ? 'SameSite=None; Secure' : 'SameSite=Lax'}`;
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': given } });
  }

  private notPairedPage(wrong: boolean): Response {
    const m = MESSAGES[this.language()].notPaired;
    const html = `<!doctype html>
<html lang="${this.language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${m.title}</title>
<style>
:root { color-scheme: light dark; font: 17px/1.45 -apple-system, system-ui, sans-serif; }
body { margin: 0; padding: 12vh 24px; max-width: 30rem; margin-inline: auto; }
h1 { font-size: 1.3rem; margin: 0 0 1rem; }
form { display: flex; gap: 8px; margin-top: 1rem; }
input { flex: 1; font: inherit; font-size: 1.4rem; letter-spacing: .2em; padding: 10px 12px; border-radius: 10px; border: 1px solid #8888; min-width: 0; }
button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 0; background: #2f6fde; color: #fff; }
.wrong { color: #d33; }
</style></head>
<body><h1>${m.heading}</h1>
${wrong ? `<p class="wrong">${m.wrong}</p>` : ''}<p>${m.how}</p>
<form method="post" action="/pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" aria-label="${m.code}" placeholder="${m.code}" required><button>${m.pair}</button></form>
</body></html>`;
    return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
