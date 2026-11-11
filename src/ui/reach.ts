// Why the phone does not reach Obeya (design: Running Obeya, "When the server does not answer"). The
// page tells the likely cause from what it can see on its own: the browser's network state, how a
// request to Obeya's address fails, and whether a push came a moment ago. Pushes travel through the
// browser's push service on the open internet, not through the phone's way to the computer, so a
// recent one says Obeya was running then, and that way is the likely cause (Tailscale stopped by
// Android, most often).

import { useEffect, useState } from 'react';
import { api } from './api';
import { t } from './strings';
import { local, read, write } from './stored';

/** The likely cause; null until something tells. */
export type Why = 'noNetwork' | 'noObeya' | 'answers' | 'pushed' | 'unreachable' | 'noAnswer' | null;

/** How a request to Obeya's address went: an HTTP status, a failure after `failed` ms, or no answer at all. */
export type Probe = { status: number } | { failed: number } | { slow: true };

/** A failure this quick never got an answer from Obeya: no name or route for the address, or the computer refused it. */
export const FAST_MS = 2000;
/** How long the probe waits for an answer: a sleeping machine gives none. */
export const PROBE_MS = 3000;
/** How often it looks again while Obeya does not answer. */
const EVERY_MS = 10_000;
/** Shared with the service worker, which notes there when the last push was sent. */
const PUSHED = 'obeya-pushed';
/** Where the page keeps whether Obeya told it that it reaches Obeya through Tailscale. */
const TAILNET = 'obeya-tailnet';

/**
 * The address looks like one in a tailnet: a MagicDNS name, or one of Tailscale's addresses
 * (100.64.0.0/10, which other VPNs use too, or fd7a:115c:a1e0::/48). Only until Obeya has said so itself.
 */
export function tailnet(host: string): boolean {
  if (/\.ts\.net$/i.test(host)) return true;
  if (/^\[?fd7a:115c:a1e0:/i.test(host)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) < 128;
}

/** Whether this page reaches Obeya through Tailscale: as Obeya said while it answered, else as the address looks. */
export function useTailnet(connected: boolean): boolean {
  const [said, setSaid] = useState<boolean | null>(() => {
    const v = read(local, TAILNET);
    return v === null ? null : v === 'true';
  });
  useEffect(() => {
    if (!connected) return;
    let gone = false;
    api.access().then(
      (v) => {
        const yes = !v.local && v.tailnet;
        if (!gone) setSaid(yes);
        write(local, TAILNET, String(yes));
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [connected]);
  return said ?? tailnet(location.hostname);
}

/** Opens the Tailscale app on Android (its `tailscale://navigate` link); without it, Chrome offers it in the Play Store. */
export const TAILSCALE_APP = 'intent://navigate#Intent;scheme=tailscale;package=com.tailscale.ipn;end';

/** A push sent this recently says Obeya was running a moment ago; an older one says nothing about now. */
export const RECENT_MS = 10 * 60_000;

/**
 * The likely cause of not reaching Obeya. An answer from the address says the way is there: a
 * gateway error (`tailscale serve` with nothing behind it) that the machine runs without Obeya, any
 * other answer that Obeya itself answers. A push sent a moment ago says Obeya was running then;
 * a request failing at once got no answer from Obeya (no way to the address, or the computer
 * refused it); one hanging went somewhere nobody answers (a sleeping machine).
 */
export function whyQuiet(o: { online: boolean; pushedAt: number | null; probe: Probe | null; now?: number }): Why {
  const now = o.now ?? Date.now();
  if (!o.online) return 'noNetwork';
  if (o.probe && 'status' in o.probe) return o.probe.status >= 502 && o.probe.status <= 504 ? 'noObeya' : 'answers';
  // the computer's clock against the phone's: one far ahead says as little as one far behind
  if (o.pushedAt !== null && Math.abs(now - o.pushedAt) < RECENT_MS) return 'pushed';
  if (!o.probe) return null;
  return 'failed' in o.probe && o.probe.failed < FAST_MS ? 'unreachable' : 'noAnswer';
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

/**
 * The likely cause while Obeya has not answered since `since` (null while it does), when the last
 * push was sent, and whether the first probe since then is back.
 */
export function useWhyQuiet(since: number | null): { why: Why; pushedAt: number | null; probed: boolean } {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pushedAt, setPushedAt] = useState<number | null>(null);
  const [probed, setProbed] = useState<Probe | null>(null);
  useEffect(() => {
    const net = () => setOnline(navigator.onLine);
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    void lastPush().then((at) => at !== null && setPushedAt((p) => Math.max(p ?? 0, at)));
    const pushed = (e: MessageEvent) => e.data?.type === 'pushed' && typeof e.data.at === 'number' && setPushedAt((p) => Math.max(p ?? 0, e.data.at));
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
  return { why: since === null ? null : whyQuiet({ online, pushedAt, probe: probed }), pushedAt, probed: probed !== null };
}

/**
 * What the line at the top says beneath "Obeya is not answering": the likely cause, more about it
 * behind "More about this" (why pushes still come, a changed address, how to keep Android from
 * stopping Tailscale), and whether it offers to open the Tailscale app (on Android, where Tailscale
 * may be the cause).
 */
export function quietText(why: Why, o: { tailnet: boolean; android: boolean; pushedAt: string | null }): { line: string; more: string[]; open: boolean } {
  const w = t.phone.whyQuiet;
  const ts = o.tailnet;
  const at = o.pushedAt ?? '';
  const said: Record<Exclude<Why, null> | 'unknown', [string, string[]]> = {
    unknown: ts ? [w.tailnet, [w.moved]] : [t.phone.notAnsweringWhy, []],
    noNetwork: [w.noNetwork, []],
    noObeya: [w.noObeya, []],
    answers: [w.answers, []],
    pushed: ts ? [w.pushedTailscale(at), [w.pushesStill, w.moved]] : [w.pushed(at), [w.moved]],
    unreachable: ts ? [w.unreachableTailscale, [w.moved]] : [w.unreachable, [w.moved]],
    noAnswer: ts ? [w.noAnswerTailscale, [w.moved]] : [w.noAnswer, [w.moved]],
  };
  const [line, more] = said[why ?? 'unknown'];
  // where Tailscale on the phone may be the cause
  const tailscale = ts && why !== 'noNetwork' && why !== 'noObeya' && why !== 'answers';
  return { line, more: tailscale && o.android ? [...more, w.android] : more, open: tailscale && o.android };
}
