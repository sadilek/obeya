import { useEffect, useState } from 'react';
import type { CanvasInfo, CanvasSnapshot, CardAction, CardEvent, CardPatch, Item, NewCard, ServerMessage } from '../core/types';

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
  if (!res.ok) {
    const body = await res.text();
    let code: string | undefined;
    let detail = body;
    try {
      ({ code, error: detail = body } = JSON.parse(body));
    } catch {}
    throw new ApiError(code, detail || `HTTP ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
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
type HeardReply = { confirm: string; token?: string; undoMs?: number; audio?: string; quiet?: boolean };

export const api = {
  canvases: () => call<CanvasInfo[]>('GET', '/api/canvases'),
  create: (c: NewCard) => call<Item>('POST', at('/cards'), c),
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
  /** What the owner said about the card or project in view. */
  voice: async (audio: Blob, where: Where) => {
    const res = await fetch(at(`/voice${query(where)}`), { method: 'POST', body: audio });
    if (!res.ok) throw new Error(`voice: ${res.status}`);
    return (await res.json()) as HeardReply;
  },
  /** The owner started speaking (or typing a command): Obeya gets ready to read it. */
  warmVoice: () => fetch(at('/voice/warm'), { method: 'POST' }).catch(() => {}),
  /** The same, typed. */
  command: (text: string, where: Where) => call<HeardReply>('POST', at(`/command${query(where)}`), { text }),
  undo: (token: string) => call<{ undone: boolean }>('POST', at('/command/undo'), { token }),
  addPreference: (text: string) => call<{ id: number }>('POST', at('/preferences'), { text }),
  /** Changes a preference, or deletes it with `null`. */
  setPreference: (id: number, text: string | null) =>
    text === null ? call<void>('DELETE', at(`/preferences/${id}`)) : call<void>('PATCH', at(`/preferences/${id}`), { text }),
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

/** The live canvas: the server pushes a snapshot on connect and after every change. */
export function useCanvas(): { snapshot: CanvasSnapshot | null; online: boolean } {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 500;
    let closed = false;
    let server: string | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${at('/ws')}`);
      ws.onopen = () => {
        setOnline(true);
        delay = 500;
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        // a new server process may run new code: the page loads it
        if (msg.type === 'hello') {
          if (server && server !== msg.server) location.reload();
          server = msg.server;
        } else if (msg.type === 'snapshot') setSnapshot(msg.snapshot);
        else if (msg.type === 'event') for (const fn of eventListeners) fn(msg.event);
        else if (msg.type === 'speak') for (const fn of speakListeners) fn(msg.cardId, msg.audio);
      };
      ws.onclose = () => {
        if (closed) return;
        setOnline(false);
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, []);
  return { snapshot, online };
}
