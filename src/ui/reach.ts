// Why the phone does not reach Obeya (design: Running Obeya, "When the server does not answer"). The
// page tells the likely cause from what it can see on its own: the browser's network state, how a
// request to Obeya's address fails, and whether a push came since. Pushes travel through the
// browser's push service on the open internet, not through Tailscale, so one that came says Obeya
// runs and the phone's way to it is what is down (Tailscale stopped by Android, most often).

import { useEffect, useState } from 'react';
import { t } from './strings';

/** The likely cause; null until something tells. */
export type Why = 'noNetwork' | 'noObeya' | 'pushed' | 'unreachable' | 'noAnswer' | null;

/** How a request to Obeya's address went: an HTTP status, a failure after `failed` ms, or no answer at all. */
export type Probe = { status: number } | { failed: number } | { slow: true };

/** A failure this quick never left the phone: no name for the address, no route to it. */
export const FAST_MS = 2000;
/** How long the probe waits for an answer: a sleeping machine gives none. */
const PROBE_MS = 5000;
/** How often it looks again while Obeya does not answer. */
const EVERY_MS = 10_000;
/** Shared with the service worker, which notes there when the last push came. */
const PUSHED = 'obeya-pushed';

/** The address is in a tailnet: a MagicDNS name or a Tailscale address (100.64.0.0/10). */
export function tailnet(host: string): boolean {
  if (/\.ts\.net$/i.test(host)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) < 128;
}

/** Opens the Tailscale app on Android (its `tailscale://navigate` link); without it, Chrome offers it in the Play Store. */
export const TAILSCALE_APP = 'intent://navigate#Intent;scheme=tailscale;package=com.tailscale.ipn;end';

/** A push this recent says Obeya ran a moment ago, even one that came before the page lost it (the push the owner tapped to open it). */
export const RECENT_MS = 10 * 60_000;

/**
 * The likely cause of not reaching Obeya since `since`. An answer of the address that is an error of
 * the gateway (`tailscale serve` with nothing behind it) says the machine runs without Obeya; a push
 * since then, or a recent one, says Obeya runs; a request failing at once never got off the phone;
 * one hanging went somewhere nobody answers (a sleeping machine), unless a push came since.
 */
export function whyQuiet(o: { online: boolean; since: number; pushedAt: number | null; probe: Probe | null; now?: number }): Why {
  const now = o.now ?? Date.now();
  if (!o.online) return 'noNetwork';
  if (o.probe && 'status' in o.probe && o.probe.status >= 502 && o.probe.status <= 504) return 'noObeya';
  if (o.pushedAt !== null && o.pushedAt > o.since) return 'pushed';
  if (o.probe && 'failed' in o.probe && o.probe.failed < FAST_MS) return 'unreachable';
  if (o.pushedAt !== null && now - o.pushedAt < RECENT_MS) return 'pushed';
  return o.probe && !('status' in o.probe) ? 'noAnswer' : null;
}

/** Asks Obeya's address once, through no cache: what came back, or how it failed. */
export async function probe(): Promise<Probe> {
  const stop = new AbortController();
  const start = performance.now();
  const h = setTimeout(() => stop.abort(), PROBE_MS);
  try {
    const r = await fetch('/api/reach', { cache: 'no-store', signal: stop.signal });
    return { status: r.status };
  } catch {
    return stop.signal.aborted ? { slow: true } : { failed: performance.now() - start };
  } finally {
    clearTimeout(h);
  }
}

async function lastPush(): Promise<number | null> {
  try {
    const r = await (await caches.open(PUSHED)).match('/pushed');
    const at = r ? Number(await r.text()) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The likely cause while Obeya has not answered since `since` (null while it does), and when the last push came. */
export function useWhyQuiet(since: number | null): { why: Why; pushedAt: number | null } {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pushedAt, setPushedAt] = useState<number | null>(null);
  const [probed, setProbed] = useState<Probe | null>(null);
  useEffect(() => {
    const net = () => setOnline(navigator.onLine);
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    void lastPush().then((at) => at !== null && setPushedAt((p) => Math.max(p ?? 0, at)));
    const pushed = (e: MessageEvent) => e.data?.type === 'pushed' && typeof e.data.at === 'number' && setPushedAt(e.data.at);
    navigator.serviceWorker?.addEventListener('message', pushed);
    return () => {
      window.removeEventListener('online', net);
      window.removeEventListener('offline', net);
      navigator.serviceWorker?.removeEventListener('message', pushed);
    };
  }, []);
  useEffect(() => {
    setProbed(null);
    if (since === null) return;
    let gone = false;
    let busy = false;
    let h: ReturnType<typeof setTimeout>;
    const look = async () => {
      clearTimeout(h);
      if (busy) return;
      if (document.visibilityState === 'visible') {
        busy = true;
        const p = await probe();
        busy = false;
        if (gone) return;
        setProbed(p);
      }
      h = setTimeout(look, EVERY_MS);
    };
    void look();
    // back into view or onto a network: what held then may not now
    const again = () => void (document.visibilityState === 'visible' && look());
    document.addEventListener('visibilitychange', again);
    window.addEventListener('online', again);
    return () => {
      gone = true;
      clearTimeout(h);
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('online', again);
    };
  }, [since]);
  return { why: since === null ? null : whyQuiet({ online, since, pushedAt, probe: probed }), pushedAt };
}

/** What the line at the top says beneath "Obeya is not answering", and whether it offers Tailscale (its app, how to keep it on). */
export function quietText(why: Why, o: { tailnet: boolean; android: boolean; pushedAt: string | null }) {
  const w = t.phone.whyQuiet;
  const ts = o.tailnet;
  const lines: Record<Exclude<Why, null> | 'unknown', string[]> = {
    unknown: ts ? [w.tailnet, w.moved(true)] : [t.phone.notAnsweringWhy],
    noNetwork: [w.noNetwork],
    noObeya: [w.noObeya],
    pushed: ts ? [w.pushed(o.pushedAt ?? ''), w.tailscaleOff, w.pushesStill] : [w.pushed(o.pushedAt ?? ''), w.sameNetwork],
    unreachable: ts ? [w.unreachable, w.tailscaleOff, w.moved(true)] : [w.unreachable, w.sameNetwork, w.moved(false)],
    noAnswer: ts ? [w.noAnswer, w.tailscaleToo] : [w.noAnswer],
  };
  const tailscale = ts && o.android && why !== 'noNetwork' && why !== 'noObeya';
  return { lines: lines[why ?? 'unknown'], open: tailscale, keepOn: tailscale && (why === 'pushed' || why === 'unreachable') };
}
