import { useEffect, useState } from 'react';
import type { CanvasConfig, CanvasInfo, CanvasSnapshot, ClientMessage, ConfigView, CardAction, DemoSettings, DemoSettingsView, CardEvent, CardPatch, Item, NewCard, OwnerHold, PendingRestart, ProjectHistory, ServerMessage } from '../core/types';

/** A request the server refused; `code` picks the owner's text, the message is the server's detail. */
export class ApiError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await refused(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Throws the server's refusal as an ApiError. */
async function refused(res: Response) {
  if (res.ok) return;
  const body = await res.text();
  let code: string | undefined;
  let detail = body;
  try {
    ({ code, error: detail = body } = JSON.parse(body));
  } catch {}
  throw new ApiError(code, detail || `HTTP ${res.status}`);
}

/** Saves a file the server makes, under the name it gives. */
async function download(path: string, fallback: string) {
  const res = await fetch(path);
  await refused(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const query = (where: Where) =>
  !where ? '' : 'card' in where ? `?card=${encodeURIComponent(where.card)}` : `?project=${encodeURIComponent(where.project)}`;

/** The canvas this page shows; every call goes to its API. */
let canvasId = '';
export function setCanvas(id: string) {
  canvasId = id;
}
/** A path in the shown canvas's API. */
export const at = (path: string) => `/api/c/${encodeURIComponent(canvasId)}${path}`;

type Where = { card: string } | { project: string } | null;
type HeardReply = { confirm: string; token?: string; undoMs?: number; audio?: string; quiet?: boolean; unheard?: boolean };

export const api = {
  canvases: () => call<CanvasInfo[]>('GET', '/api/canvases'),
  /** Obeya's configuration, for all canvases. */
  config: () => call<ConfigView>('GET', '/api/config'),
  checkConfig: (canvases: CanvasConfig[]) => call<Pick<ConfigView, 'canvases' | 'resolved' | 'problems'>>('POST', '/api/config/check', canvases),
  /** Saves it; Obeya then starts again with it where something restarts it. */
  saveConfig: (canvases: CanvasConfig[]) => call<{ restarting: boolean }>('PUT', '/api/config', canvases),
  demoSettings: () => call<DemoSettingsView>('GET', '/api/demo-settings'),
  saveDemoSettings: (settings: DemoSettings) => call<DemoSettingsView>('PUT', '/api/demo-settings', settings),
  /** Has a restart that waits for workers go ahead now; false when none waits. */
  restartNow: () => call<{ restarting: boolean }>('POST', '/api/restart'),
  create: (c: NewCard) => call<Item>('POST', at('/cards'), c),
  /** Downloads a card's video demo as a ZIP of its page with the files, or as one HTML file. */
  exportDemo: (id: string, as: 'zip' | 'html') => download(at(`/cards/${id}/export?as=${as}`), `demo.${as}`),
  /** The size of a card's demo video in bytes; null when unknown. */
  demoSize: async (id: string) => {
    const res = await fetch(at(`/cards/${id}/demo/demo.mp4`), { headers: { range: 'bytes=0-0' } });
    await res.body?.cancel();
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    return res.ok && total > 0 ? total : null;
  },
  patch: (id: string, p: CardPatch) => call<void>('PATCH', at(`/cards/${id}`), p),
  remove: (id: string) => call<void>('DELETE', at(`/cards/${id}`)),
  restore: (id: string) => call<void>('POST', at(`/cards/${id}/restore`)),
  /** Takes a finished card off the canvas into the archive. */
  archive: (id: string) => call<void>('POST', at(`/cards/${id}/archive`)),
  unarchive: (id: string) => call<void>('POST', at(`/cards/${id}/unarchive`)),
  /** The archive, the most recently archived first. */
  archived: () => call<Item[]>('GET', at('/archive')),
  /** Archives every finished card of the owner's on the canvas. */
  archiveDone: () => call<{ ids: string[] }>('POST', at('/archive')),
  act: (id: string, a: CardAction) => call<void>('POST', at(`/cards/${id}/act`), a),
  /** Stores a screenshot for a message; the message names it by the id. */
  uploadImage: async (image: Blob) => {
    const res = await fetch(at('/images'), { method: 'POST', headers: { 'content-type': image.type }, body: image });
    const body = (await res.json().catch(() => ({}))) as { id?: string; code?: string; error?: string };
    if (!res.ok || !body.id) throw new ApiError(body.code, body.error ?? `HTTP ${res.status}`);
    return body.id;
  },
  events: (id: string) => call<CardEvent[]>('GET', at(`/cards/${id}/events`)),
  /** A project's plan doc as written. */
  planDoc: (id: string) => call<{ file: string; markdown: string }>('GET', at(`/cards/${id}/plan`)),
  /** A project's decisions and the idea it came from. */
  history: (id: string) => call<ProjectHistory>('GET', at(`/cards/${id}/history`)),
  /** What the owner said about the card or project in view, with the screenshots shown with it. */
  voice: async (audio: Blob, where: Where, images: string[] = []) => {
    const q = images.map((id) => `image=${encodeURIComponent(id)}`).join('&');
    const res = await fetch(at(`/voice${query(where)}${q && (where ? '&' : '?')}${q}`), { method: 'POST', body: audio });
    if (!res.ok) throw new Error(`voice: ${res.status}`);
    return (await res.json()) as HeardReply;
  },
  /** The owner started speaking (or typing a command): Obeya gets ready to read it. */
  warmVoice: () => fetch(at('/voice/warm'), { method: 'POST' }).catch(() => {}),
  /** The same, typed. */
  command: (text: string, where: Where, images?: string[]) =>
    call<HeardReply>('POST', at(`/command${query(where)}`), { text, ...(images?.length ? { images } : {}) }),
  undo: (token: string) => call<{ undone: boolean }>('POST', at('/command/undo'), { token }),
  /** A rule of the owner's, active at once, or with `target` one for that repository's CLAUDE.md. */
  addPreference: (text: string, target?: string) => call<void>('POST', at('/preferences'), { text, ...(target ? { target } : {}) }),
  /** Changes a preference, or deletes it with `null`. */
  setPreference: (id: number, text: string | null) =>
    text === null ? call<void>('DELETE', at(`/preferences/${id}`)) : call<void>('PATCH', at(`/preferences/${id}`), { text }),
  /** Accepts a proposed rule, in the owner's words and for the place they chose (a repository, `null` for the preferences) when they changed these. */
  acceptProposal: (id: number, text?: string, target?: string | null) =>
    call<void>('POST', at(`/preferences/${id}/accept`), { ...(text === undefined ? {} : { text }), ...(target === undefined ? {} : { target }) }),
  rejectProposal: (id: number) => call<void>('POST', at(`/preferences/${id}/reject`)),
};

// Log lines arrive over the canvas's WebSocket; whoever shows a card's log listens here.
const eventListeners = new Set<(e: CardEvent) => void>();
export function onCardEvent(fn: (e: CardEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// Short spoken summaries of agents: an idea's replies, for whoever has the card open; answers the
// Koordinator looked up come without a card and are heard anywhere.
const speakListeners = new Set<(cardId: string | undefined, audio: string) => void>();
export function onSpeak(fn: (cardId: string | undefined, audio: string) => void): () => void {
  speakListeners.add(fn);
  return () => speakListeners.delete(fn);
}

// What the owner does in this page that a restart would cut off, by who holds it (the demo video,
// push-to-talk); the server hears every change, and again after a reconnect.
const holds = new Map<string, OwnerHold>();
let socket: WebSocket | null = null;
const sendHolds = () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'hold', hold: [...new Set(holds.values())] } satisfies ClientMessage));
};
/** Holds a due restart off while the owner watches (`video`) or dictates (`voice`); `null` lets go. */
export function holdRestart(by: string, what: OwnerHold | null) {
  if ((holds.get(by) ?? null) === what) return;
  if (what) holds.set(by, what);
  else holds.delete(by);
  sendHolds();
}

// Whoever has something to keep across the reload a restart brings writes it down here first.
const reloadListeners = new Set<() => void>();
export function beforeReload(fn: () => void): () => void {
  reloadListeners.add(fn);
  return () => reloadListeners.delete(fn);
}

/**
 * The live canvas: the server pushes a snapshot on connect and after every change, the restart that
 * waits, and how many cards on each canvas need the owner.
 */
export function useCanvas(): { snapshot: CanvasSnapshot | null; online: boolean; restart: PendingRestart | null; waiting: Record<string, number> } {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [restart, setRestart] = useState<PendingRestart | null>(null);
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 500;
    let closed = false;
    let server: string | undefined;
    const connect = () => {
      ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${at('/ws')}`);
      ws.onopen = () => {
        setOnline(true);
        delay = 500;
        sendHolds();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        // a new server process may run new code: the page loads it, and keeps what was open
        if (msg.type === 'hello') {
          if (server && server !== msg.server) {
            for (const fn of reloadListeners) fn();
            location.reload();
          }
          server = msg.server;
        } else if (msg.type === 'snapshot') setSnapshot(msg.snapshot);
        else if (msg.type === 'restart') setRestart(msg.restart);
        else if (msg.type === 'waiting') setWaiting(msg.waiting);
        else if (msg.type === 'event') for (const fn of eventListeners) fn(msg.event);
        else if (msg.type === 'speak') for (const fn of speakListeners) fn(msg.cardId, msg.audio);
      };
      ws.onclose = () => {
        if (closed) return;
        setOnline(false);
        // a canvas the configuration no longer has: the page goes to the first one there is
        api.canvases().then((list) => list.some((c) => c.id === canvasId) || location.replace(location.pathname), () => {});
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    // back from GitHub, say: the server looks at the pull requests now instead of at its next round
    const back = () => {
      if (document.visibilityState === 'visible' && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'back' } satisfies ClientMessage));
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      ws.close();
    };
  }, []);
  return { snapshot, online, restart, waiting };
}
