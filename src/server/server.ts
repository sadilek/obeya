import type { ServerWebSocket } from 'bun';
import type { CardPatch, NewCard, ServerMessage } from '../core/types';
import index from '../ui/index.html';
import { BadRequest, type Board } from './board';

export function serve(board: Board, port: number, development = false) {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const push = () => {
    const msg = JSON.stringify({ type: 'snapshot', snapshot: board.snapshot() } satisfies ServerMessage);
    for (const ws of sockets) ws.send(msg);
  };
  board.onChange(push);

  const handle = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const out = await fn();
      return out === undefined ? new Response(null, { status: 204 }) : Response.json(out);
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
        DELETE: (req) => handle(() => board.remove(req.params.id)),
      },
      '/api/cards/:id/restore': { POST: (req) => handle(() => board.restore(req.params.id)) },
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
