import { useEffect, useState } from 'react';
import type { CanvasSnapshot, CardAction, CardEvent, CardPatch, Item, NewCard, ServerMessage } from '../core/types';

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

const query = (where: { card: string } | { project: string } | null) =>
  !where ? '' : 'card' in where ? `?card=${encodeURIComponent(where.card)}` : `?project=${encodeURIComponent(where.project)}`;

export const api = {
  create: (c: NewCard) => call<Item>('POST', '/api/cards', c),
  patch: (id: string, p: CardPatch) => call<void>('PATCH', `/api/cards/${id}`, p),
  remove: (id: string) => call<void>('DELETE', `/api/cards/${id}`),
  restore: (id: string) => call<void>('POST', `/api/cards/${id}/restore`),
  act: (id: string, a: CardAction) => call<void>('POST', `/api/cards/${id}/act`, a),
  events: (id: string) => call<CardEvent[]>('GET', `/api/cards/${id}/events`),
  /** What the owner said, or typed, about the card or project in view. */
  voice: async (audio: Blob, where: { card: string } | { project: string } | null) => {
    const res = await fetch(`/api/voice${query(where)}`, { method: 'POST', body: audio });
    if (!res.ok) throw new Error(`voice: ${res.status}`);
    return (await res.json()) as { confirm: string; token?: string; audio?: string };
  },
  command: (text: string, where: { card: string } | { project: string } | null) =>
    call<{ confirm: string; token?: string; audio?: string }>('POST', `/api/command${query(where)}`, { text }),
  undo: (token: string) => call<{ undone: boolean }>('POST', '/api/command/undo', { token }),
  addPreference: (text: string) => call<{ id: number }>('POST', '/api/preferences', { text }),
  /** Changes a preference, or deletes it with `null`. */
  setPreference: (id: number, text: string | null) =>
    text === null ? call<void>('DELETE', `/api/preferences/${id}`) : call<void>('PATCH', `/api/preferences/${id}`, { text }),
};

// Log lines arrive over the canvas's WebSocket; whoever shows a card's log listens here.
const eventListeners = new Set<(e: CardEvent) => void>();
export function onCardEvent(fn: (e: CardEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
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
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        setOnline(true);
        delay = 500;
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === 'snapshot') setSnapshot(msg.snapshot);
        else if (msg.type === 'event') for (const fn of eventListeners) fn(msg.event);
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
