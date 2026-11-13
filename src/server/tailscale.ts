// Tailscale on this machine, for other devices to reach Obeya (remote.ts): what `tailscale status`
// says it allows, and the one `tailscale serve` entry Obeya keeps, which proxies HTTPS at the
// machine's tailnet name to Obeya's port on 127.0.0.1. Obeya touches no other entry: one on a port
// that serves something else stays, and Obeya takes the next port. Renamed in the tailnet, the
// machine keeps the entries under its old name, which nothing reaches any more but which hold their
// ports (Tailscale keeps ports per machine): Obeya's own goes, and its port serves the new name.

import { existsSync } from 'node:fs';
import type { RemoteProblem, TailscaleState } from '../core/types';

/** The HTTPS ports Obeya tries in turn (those the tailnet also lets Funnel use, which every client knows). */
export const SERVE_PORTS = [443, 8443, 10000] as const;

/** The entry Obeya serves: HTTPS on `https` of the tailnet name, proxied to `target`. */
export interface ServeEntry {
  https: number;
  target: string;
}

/** An entry, with the tailnet name it serves at. */
export type NamedEntry = ServeEntry & { name: string };

/** Where Tailscale's CLI is: on the PATH, else where its app for the platform puts it. */
export function findTailscale(platform = process.platform): string | null {
  const onPath = Bun.which('tailscale');
  if (onPath) return onPath;
  const known =
    platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : null;
  return known && existsSync(known) ? known : null;
}

interface Status {
  BackendState?: string;
  CertDomains?: string[] | null;
  Self?: { DNSName?: string; UserID?: number; TailscaleIPs?: string[] | null };
  Peer?: Record<string, unknown> | null;
  User?: Record<string, { LoginName?: string }> | null;
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

/** `tailscale serve status --json`'s configuration, from its first `{` (a warning may come before it). */
function parseServe(out: string): ServeConfig {
  const at = out.indexOf('{');
  return at < 0 ? {} : (JSON.parse(out.slice(at)) as ServeConfig);
}

/** Whether `config` still serves `entry` as Obeya noted it. */
const serves = (config: ServeConfig, entry: NamedEntry) => config.Web?.[`${entry.name}:${entry.https}`]?.Handlers?.['/']?.Proxy === entry.target;

/** The entries of `config` on one of `SERVE_PORTS` that proxy `/` somewhere. */
function entriesOf(config: ServeConfig): NamedEntry[] {
  return Object.entries(config.Web ?? {}).flatMap(([key, web]) => {
    const at = key.lastIndexOf(':');
    const https = Number(key.slice(at + 1));
    const target = web.Handlers?.['/']?.Proxy;
    return at > 0 && target && (SERVE_PORTS as readonly number[]).includes(https) ? [{ name: key.slice(0, at), https, target }] : [];
  });
}

/**
 * `config` without `entries` (each only while it is still as noted): their handler for `/` goes, the
 * entry with it once it has no other, its port once no entry under any name serves on it.
 */
function without(config: ServeConfig, entries: NamedEntry[]): ServeConfig {
  const next = structuredClone(config);
  for (const e of entries) {
    const key = `${e.name}:${e.https}`;
    const web = next.Web?.[key];
    if (web?.Handlers?.['/']?.Proxy !== e.target) continue;
    delete web.Handlers['/'];
    if (Object.keys(web.Handlers).length) continue;
    delete next.Web![key];
    delete next.AllowFunnel?.[key];
    if (!Object.keys(next.Web!).some((k) => k.endsWith(`:${e.https}`))) delete next.TCP?.[String(e.https)];
  }
  return next;
}

export class Tailscale {
  /** What `state` found last, once Tailscale answered. */
  private last: TailscaleState | undefined;
  /** This machine's addresses in the tailnet, as `state` found them last. */
  private ips: string[] = [];

  constructor(
    /** Its CLI; `null` where it is not installed. */
    private readonly bin: string | null = findTailscale(),
    private readonly platform = process.platform,
    /** How long `tailscale status` may take. */
    private readonly statusTimeout = 10_000,
  ) {}

  private async run(args: string[], timeout = 10_000, input?: string): Promise<{ ok: boolean; out: string; late?: true }> {
    const p = Bun.spawn([this.bin!, ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe', timeout });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    // a CLI newer than its service warns about it on stderr: only the output counts
    return { ok: code === 0, out: code === 0 ? out : `${out}\n${err}`.trim(), ...(p.signalCode ? { late: true as const } : {}) };
  }

  /** What Tailscale allows here now. */
  async state(): Promise<TailscaleState> {
    if (!this.bin) return { state: 'missing' };
    let status: Status;
    try {
      const r = await this.run(['status', '--json'], this.statusTimeout);
      // on a machine under load the answer can take longer than it may: that says nothing new
      if (r.late && this.last) return this.last;
      status = JSON.parse(r.out.slice(r.out.indexOf('{'))) as Status;
    } catch {
      return (this.last = { state: 'stopped' });
    }
    return (this.last = this.stateOf(status));
  }

  /** This machine's addresses in the tailnet; none while Tailscale is missing or stopped. */
  async addresses(): Promise<string[]> {
    const s = await this.state();
    return s.state === 'missing' || s.state === 'stopped' ? [] : this.ips;
  }

  private stateOf(status: Status): TailscaleState {
    this.ips = (status.Self?.TailscaleIPs ?? []).map((a) => a.toLowerCase());
    const name = status.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
    if (status.BackendState === 'NeedsLogin' || status.BackendState === 'NeedsMachineAuth' || status.BackendState === 'NoState') return { state: 'loggedOut' };
    if (status.BackendState !== 'Running' || !name) return { state: 'stopped' };
    if (!status.CertDomains?.length) return { state: 'noHttps', name };
    const account = status.User?.[String(status.Self?.UserID)]?.LoginName;
    return { state: 'ready', name, ...(account ? { account } : {}), others: Object.keys(status.Peer ?? {}).length };
  }

  private async config(): Promise<ServeConfig> {
    const r = await this.run(['serve', 'status', '--json']);
    if (!r.ok) throw new Error(r.out);
    return parseServe(r.out);
  }

  /**
   * Serves Obeya's `port` at `name` over HTTPS: on the best port of its entries there (`kept`, the
   * one it served before, while it is still Obeya's, or one proxying to its port), else on the first
   * of `SERVE_PORTS` nothing serves yet. Obeya's entries under another name (the same ones) are from
   * before the machine was renamed: they go first, and the ports they held count as Obeya's.
   */
  async serve(name: string, port: number, kept: NamedEntry | null): Promise<{ entry: ServeEntry } | { problem: RemoteProblem }> {
    const target = `http://127.0.0.1:${port}`;
    let config: ServeConfig;
    try {
      config = await this.config();
    } catch (e) {
      return { problem: this.problemOf((e as Error).message) };
    }
    const own = (e: NamedEntry) => e.target === target || (!!kept && e.name === kept.name && e.https === kept.https && e.target === kept.target);
    const renamed = entriesOf(config).filter((e) => e.name !== name && own(e));
    if (renamed.length) {
      const r = await this.drop(config, renamed);
      if ('problem' in r) return r;
      config = r.config;
    }
    const free = (p: number) => !config.TCP?.[String(p)];
    const mine = entriesOf(config).filter((e) => e.name === name && own(e));
    const at = (p: number) => mine.find((e) => e.https === p);
    const https = SERVE_PORTS.find((p) => at(p) || (free(p) && renamed.some((e) => e.https === p))) ?? SERVE_PORTS.find(free);
    if (!https) return { problem: { code: 'portsTaken' } };
    if (at(https)?.target !== target) {
      // the tailnet may ask for HTTPS to be turned on and wait for it: the state says so beforehand, the timeout ends the wait
      const r = await this.run(['serve', '--bg', `--https=${https}`, target], 20_000);
      if (!r.ok) return { problem: this.problemOf(r.out) };
    }
    // served at one address: Obeya's entries on other ports go
    const others = mine.filter((e) => e.https !== https);
    if (others.length) await this.config().then((c) => this.drop(c, others), () => {});
    return { entry: { https, target } };
  }

  /**
   * Tells Tailscale to serve `config` without `entries`: through `serve set-raw`, since `serve
   * --https=<port> off` reaches only entries under the machine's current name. It replaces the whole
   * configuration, so a change another program makes between reading it and this is lost; the
   * moment is short and comes at a start, a rename or the setting turned off.
   */
  private async drop(config: ServeConfig, entries: NamedEntry[]): Promise<{ config: ServeConfig } | { problem: RemoteProblem }> {
    const next = without(config, entries);
    const r = await this.run(['serve', 'set-raw'], 10_000, JSON.stringify(next));
    return r.ok ? { config: next } : { problem: this.problemOf(r.out) };
  }

  /** Removes the entry Obeya served, if it is still Obeya's. */
  async unserve(entry: NamedEntry): Promise<void> {
    const config = await this.config().catch(() => ({}) as ServeConfig);
    if (!serves(config, entry)) return;
    await this.drop(config, [entry]);
  }

  /** As `unserve`, waiting for it: Obeya stopping, which ends the process right after. */
  unserveSync(entry: NamedEntry) {
    const run = (args: string[], input?: string) =>
      Bun.spawnSync([this.bin!, ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    const status = run(['serve', 'status', '--json']);
    try {
      const config = parseServe(status.stdout.toString());
      if (serves(config, entry)) run(['serve', 'set-raw'], JSON.stringify(without(config, [entry])));
    } catch {}
  }

  private problemOf(output: string): RemoteProblem {
    if (this.platform === 'linux' && /access denied/i.test(output)) return { code: 'operator' };
    return { code: 'failed', detail: output.trim().split('\n').filter((l) => !/client version .* != tailscaled/.test(l)).join('\n') || 'tailscale serve failed' };
  }
}
