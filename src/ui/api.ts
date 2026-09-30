import { useEffect, useState } from 'react';
import type { CanvasSnapshot, CardPatch, Item, NewCard, ServerMessage } from '../core/types';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  create: (c: NewCard) => call<Item>('POST', '/api/cards', c),
  patch: (id: string, p: CardPatch) => call<void>('PATCH', `/api/cards/${id}`, p),
  remove: (id: string) => call<void>('DELETE', `/api/cards/${id}`),
  restore: (id: string) => call<void>('POST', `/api/cards/${id}/restore`),
};

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
