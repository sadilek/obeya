import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardAction, CardPatch, NewCard, ServerMessage } from '../core/types';
import index from '../ui/index.html';
import { BadRequest, type Board } from './board';
import { serveDemoFile } from './demo';
import type { Commander, Focus, Heard } from './commands';
import type { Koordinator } from './koordinator';
import { speak, type Transcriber } from './voice';
import type { Workers } from './workers';

export interface Voice {
  commander: Commander;
  transcriber: Transcriber;
}

export function serve(board: Board, workers: Workers, koordinator: Koordinator, voice: Voice, port: number, development = false) {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const push = () => {
    const msg = JSON.stringify({ type: 'snapshot', snapshot: board.snapshot() } satisfies ServerMessage);
    for (const ws of sockets) ws.send(msg);
  };
  board.onChange(push);
  board.onEvent((event) => {
    const msg = JSON.stringify({ type: 'event', event } satisfies ServerMessage);
    for (const ws of sockets) ws.send(msg);
  });

  const act = (id: string, a: CardAction) => {
    const text = 'text' in a ? a.text : '';
    if ('text' in a && (typeof text !== 'string' || !text.trim() || text.length > 20000)) throw new BadRequest('emptyText', 'text must be a non-empty string');
    switch (a.action) {
      case 'start':
        return koordinator.request(id);
      case 'force':
        return koordinator.force(id);
      case 'dequeue':
        return koordinator.dequeue(id);
      case 'split':
        return koordinator.split(id);
      case 'stop':
        return workers.stop(id);
      case 'message':
        return workers.message(id, text.trim());
      case 'answer':
        return workers.answer(id, text.trim());
      case 'approve':
        return workers.approve(id);
      case 'accept':
        return board.accept(id);
      case 'dismiss':
        if (board.row(id).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
        return board.remove(id);
      default:
        throw new BadRequest('invalid', 'unknown action');
    }
  };

  const focusOf = (req: Request): Focus => {
    const q = new URL(req.url).searchParams;
    return { ...(q.get('card') ? { card: q.get('card')! } : {}), ...(q.get('project') ? { project: q.get('project')! } : {}) };
  };
  const transcribe = async (req: Request) => {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-'));
    const file = join(dir, 'speech.webm');
    try {
      await Bun.write(file, await req.arrayBuffer());
      return (await voice.transcriber.transcribe(file, voice.commander.vocabulary())).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const heard = async (text: string, focus: Focus) => {
    const h: Heard = text ? await voice.commander.hear(text, focus) : { confirm: 'Ich habe nichts gehört.' };
    const audio = speak(h.confirm);
    if (h.token) voice.commander.arm(h.token);
    return { ...h, ...(audio ? { audio: `data:audio/wav;base64,${Buffer.from(audio).toString('base64')}` } : {}) };
  };

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

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    development: development && { hmr: true, console: true },
    routes: {
      '/': index,
      '/api/canvas': { GET: () => Response.json(board.snapshot()) },
      '/api/cards': { POST: (req) => handle(async () => board.create((await req.json()) as NewCard)) },
      '/api/cards/:id': {
        PATCH: (req) => handle(async () => board.patch(req.params.id, (await req.json()) as CardPatch)),
        DELETE: (req) =>
          handle(() => {
            const { state } = board.row(req.params.id);
            if (state === 'working' || state === 'waiting') workers.stop(req.params.id);
            board.remove(req.params.id);
          }),
      },
      '/api/cards/:id/restore': { POST: (req) => handle(() => board.restore(req.params.id)) },
      '/api/cards/:id/act': { POST: (req) => handle(async () => act(req.params.id, (await req.json()) as CardAction)) },
      // what the owner said (audio) or typed, read by the Koordinator as one action
      '/api/voice': { POST: (req) => handle(async () => heard(await transcribe(req), focusOf(req))) },
      '/api/command': {
        POST: (req) =>
          handle(async () => {
            const { text } = (await req.json()) as { text: string };
            if (typeof text !== 'string' || !text.trim()) throw new BadRequest('emptyText', 'text must be a non-empty string');
            return heard(text.trim(), focusOf(req));
          }),
      },
      '/api/command/undo': {
        POST: (req) => handle(async () => ({ undone: voice.commander.undo(((await req.json()) as { token: string }).token) })),
      },
      '/api/preferences': { POST: (req) => handle(async () => ({ id: board.addPreference(((await req.json()) as { text: string }).text) })) },
      '/api/preferences/:id': {
        PATCH: (req) => handle(async () => board.setPreference(Number(req.params.id), ((await req.json()) as { text: string }).text)),
        DELETE: (req) => handle(() => board.setPreference(Number(req.params.id), null)),
      },
      '/api/cards/:id/demo/:file': {
        GET: (req) => {
          try {
            const dir = board.demoDir(req.params.id);
            return dir ? serveDemoFile(dir, req.params.file, req) : new Response('Not found', { status: 404 });
          } catch {
            return new Response('Not found', { status: 404 });
          }
        },
      },
      '/api/cards/:id/events': { GET: (req) => handle(() => board.events(req.params.id)) },
      '/api/ws': (req, server) => (server.upgrade(req) ? undefined : new Response('WebSocket expected', { status: 400 })),
    },
    fetch: () => new Response('Not found', { status: 404 }),
    websocket: {
      open: (ws) => {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: board.snapshot() } satisfies ServerMessage));
      },
      close: (ws) => void sockets.delete(ws),
      message: () => {},
    },
  });
}
