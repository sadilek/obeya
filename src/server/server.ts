// HTTP and WebSocket for the UI: one API per canvas under /api/c/<canvas>/.

import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasInfo, CardAction, CardPatch, NewCard, ServerMessage } from '../core/types';
import index from '../ui/index.html';
import { BadRequest } from './board';
import type { CanvasRuntime } from './canvas';
import type { Focus, Heard } from './commands';
import { serveDemoFile } from './demo';
import type { Speaker, Transcriber } from './voice';

type Req = Request & { params: Record<string, string> };

export interface Voice {
  transcriber: Transcriber;
  speaker: Speaker;
}

export function serve(canvases: CanvasRuntime[], { transcriber, speaker }: Voice, port: number, development = false) {
  const byId = new Map(canvases.map((c) => [c.id, c]));
  const sockets = new Map<string, Set<ServerWebSocket<{ canvas: string }>>>(canvases.map((c) => [c.id, new Set()]));
  for (const c of canvases) {
    const send = (msg: ServerMessage) => {
      const text = JSON.stringify(msg);
      for (const ws of sockets.get(c.id)!) ws.send(text);
    };
    c.board.onChange(() => send({ type: 'snapshot', snapshot: c.board.snapshot() }));
    c.board.onEvent((event) => send({ type: 'event', event }));
  }

  const handle = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const out = await fn();
      return out === undefined || out === null ? new Response(null, { status: 204 }) : Response.json(out);
    } catch (e) {
      if (e instanceof BadRequest) return Response.json({ code: e.code, error: e.message }, { status: 400 });
      if (e instanceof SyntaxError) return Response.json({ code: 'invalid', error: 'invalid JSON' }, { status: 400 });
      throw e;
    }
  };
  /** A route on one canvas; an unknown canvas is a 404. */
  const on =
    (fn: (c: CanvasRuntime, req: Req) => unknown | Promise<unknown>) =>
    (req: Req): Response | Promise<Response> => {
      const c = byId.get(req.params.canvas!);
      return c ? handle(() => fn(c, req)) : Response.json({ code: 'invalid', error: 'unknown canvas' }, { status: 404 });
    };

  const focusOf = (req: Request): Focus => {
    const q = new URL(req.url).searchParams;
    return { ...(q.get('card') ? { card: q.get('card')! } : {}), ...(q.get('project') ? { project: q.get('project')! } : {}) };
  };
  const transcribe = async (c: CanvasRuntime, req: Request) => {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-'));
    const file = join(dir, 'speech.webm');
    try {
      await Bun.write(file, await req.arrayBuffer());
      return (await transcriber.transcribe(file, c.commander.vocabulary())).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /** Spoken confirmations by id, rendered while the owner already reads them. */
  const speech = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();
  const heard = async (c: CanvasRuntime, text: string, focus: Focus) => {
    // the owner sees only the confirmation; the transcript is for whoever reads the server's log
    console.log(`heard on ${c.id}: ${text || '(nothing)'}`);
    const h: Heard = text ? await c.commander.hear(text, focus) : { confirm: 'Ich habe nichts gehört.' };
    // the written confirmation goes out now, so the undo window starts now; the voice follows
    if (h.token) c.commander.arm(h.token);
    const id = crypto.randomUUID();
    speech.set(id, speaker.speak(h.confirm));
    setTimeout(() => speech.delete(id), 60_000);
    return { ...h, ...(h.token ? { undoMs: c.commander.delayMs } : {}), audio: `/api/c/${encodeURIComponent(c.id)}/voice/speech/${id}` };
  };

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    development: development && { hmr: true, console: true },
    routes: {
      '/': index,
      '/api/canvases': { GET: () => Response.json(canvases.map((c) => c.board.canvas) satisfies CanvasInfo[]) },
      '/api/c/:canvas/canvas': { GET: on((c) => c.board.snapshot()) },
      '/api/c/:canvas/cards': { POST: on(async (c, req) => c.board.create((await req.json()) as NewCard)) },
      '/api/c/:canvas/cards/:id': {
        PATCH: on(async (c, req) => c.board.patch(req.params.id!, (await req.json()) as CardPatch)),
        DELETE: on((c, req) => c.remove(req.params.id!)),
      },
      '/api/c/:canvas/cards/:id/restore': { POST: on((c, req) => c.board.restore(req.params.id!)) },
      '/api/c/:canvas/cards/:id/archive': { POST: on((c, req) => c.board.archive([req.params.id!])) },
      '/api/c/:canvas/cards/:id/unarchive': { POST: on((c, req) => c.board.unarchive(req.params.id!)) },
      // the archive, newest first; posting archives every finished card of the owner's
      '/api/c/:canvas/archive': { GET: on((c) => c.board.archived()), POST: on((c) => ({ ids: c.board.archiveDone() })) },
      '/api/c/:canvas/cards/:id/act': { POST: on(async (c, req) => c.act(req.params.id!, (await req.json()) as CardAction)) },
      '/api/c/:canvas/cards/:id/events': { GET: on((c, req) => c.board.events(req.params.id!)) },
      '/api/c/:canvas/cards/:id/demo/:file': {
        GET: (req) => {
          try {
            const dir = byId.get(req.params.canvas)?.board.demoDir(req.params.id);
            return dir ? serveDemoFile(dir, req.params.file, req) : new Response('Not found', { status: 404 });
          } catch {
            return new Response('Not found', { status: 404 });
          }
        },
      },
      // what the owner said (audio) or typed, read by the Koordinator as one action
      '/api/c/:canvas/voice': { POST: on(async (c, req) => heard(c, await transcribe(c, req), focusOf(req))) },
      // the owner started speaking: transcription, speech and the Koordinator get ready meanwhile
      '/api/c/:canvas/voice/warm': {
        POST: on((c) => {
          transcriber.warm?.();
          speaker.warm?.();
          c.commander.warm();
        }),
      },
      '/api/c/:canvas/voice/speech/:id': {
        GET: async (req) => {
          const audio = await speech.get(req.params.id);
          return audio ? new Response(audio, { headers: { 'content-type': 'audio/wav' } }) : new Response('Not found', { status: 404 });
        },
      },
      '/api/c/:canvas/command': {
        POST: on(async (c, req) => {
          const { text } = (await req.json()) as { text: string };
          if (typeof text !== 'string' || !text.trim()) throw new BadRequest('emptyText', 'text must be a non-empty string');
          return heard(c, text.trim(), focusOf(req));
        }),
      },
      '/api/c/:canvas/command/undo': {
        POST: on(async (c, req) => ({ undone: c.commander.undo(((await req.json()) as { token: string }).token) })),
      },
      '/api/c/:canvas/preferences': { POST: on(async (c, req) => ({ id: c.board.addPreference(((await req.json()) as { text: string }).text) })) },
      '/api/c/:canvas/preferences/:id': {
        PATCH: on(async (c, req) => c.board.setPreference(Number(req.params.id), ((await req.json()) as { text: string }).text)),
        DELETE: on((c, req) => c.board.setPreference(Number(req.params.id), null)),
      },
      '/api/c/:canvas/ws': (req, server) =>
        byId.has(req.params.canvas) && server.upgrade(req, { data: { canvas: req.params.canvas } })
          ? undefined
          : new Response('WebSocket expected', { status: 400 }),
    },
    fetch: () => new Response('Not found', { status: 404 }),
    websocket: {
      data: {} as { canvas: string },
      open: (ws) => {
        const c = byId.get(ws.data.canvas);
        if (!c) return ws.close();
        sockets.get(c.id)!.add(ws);
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: c.board.snapshot() } satisfies ServerMessage));
      },
      close: (ws) => void sockets.get(ws.data.canvas)?.delete(ws),
      message: () => {},
    },
  });
}
