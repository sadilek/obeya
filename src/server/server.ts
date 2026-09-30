import type { ServerWebSocket } from 'bun';
import type { CardAction, CardPatch, NewCard, ServerMessage } from '../core/types';
import index from '../ui/index.html';
import { BadRequest, type Board } from './board';
import type { Koordinator } from './koordinator';
import type { Workers } from './workers';

export function serve(board: Board, workers: Workers, koordinator: Koordinator, port: number, development = false) {
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
    if ('text' in a && (typeof text !== 'string' || !text.trim() || text.length > 20000)) throw new BadRequest('text must be a non-empty string');
    switch (a.action) {
      case 'start':
        return koordinator.request(id);
      case 'force':
        return koordinator.force(id);
      case 'dequeue':
        return koordinator.dequeue(id);
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
        if (board.row(id).state !== 'proposal') throw new BadRequest('not a proposal');
        return board.remove(id);
      default:
        throw new BadRequest('unknown action');
    }
  };

  const handle = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const out = await fn();
      return out === undefined || out === null ? new Response(null, { status: 204 }) : Response.json(out);
    } catch (e) {
      if (e instanceof BadRequest) return Response.json({ error: e.message }, { status: 400 });
      if (e instanceof SyntaxError) return Response.json({ error: 'invalid JSON' }, { status: 400 });
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
