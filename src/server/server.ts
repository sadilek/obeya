// HTTP and WebSocket for the UI: one API per canvas under /api/c/<canvas>/.

import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CanvasInfo, type CardAction, type CardPatch, needsYou, type NewCard, type PendingRestart, type ServerMessage } from '../core/types';
import index from '../ui/index.html';
import { BadRequest } from './board';
import type { CanvasRuntime } from './canvas';
import type { Focus, Heard } from './commands';
import type { Config } from './config';
import { serveDemoFile } from './demo';
import type { Restarter } from './self-update';
import { looping, silence, type Speaker, type Transcriber } from './voice';

type Req = Request & { params: Record<string, string> };

export interface Voice {
  transcriber: Transcriber;
  speaker: Speaker;
}

export function serve(canvases: CanvasRuntime[], { transcriber, speaker }: Voice, port: number, development = false, config?: Config, restarter?: Restarter) {
  const byId = new Map(canvases.map((c) => [c.id, c]));
  const started = crypto.randomUUID();
  const sockets = new Map<string, Set<ServerWebSocket<{ canvas: string }>>>(canvases.map((c) => [c.id, new Set()]));
  /** Spoken texts by id, rendered while the owner already reads them. */
  const speech = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();
  /** Starts speaking `text` and returns where the browser fetches it. */
  const voice = (c: CanvasRuntime, text: string) => {
    const id = crypto.randomUUID();
    speech.set(id, speaker.speak(text));
    setTimeout(() => speech.delete(id), 60_000);
    return `/api/c/${encodeURIComponent(c.id)}/voice/speech/${id}`;
  };
  /** The restart that waits, as canvas `id` sees it. */
  const pending = (id: string): PendingRestart | null => {
    const due = restarter?.due();
    if (!due) return null;
    const here = due.waiting.filter((w) => w.canvas === id);
    return { reason: due.reason, since: due.since, deadline: due.deadline, cards: here.map((w) => w.card), elsewhere: due.waiting.length - here.length };
  };
  /** How many cards on each canvas need the owner: each canvas's switcher points to the others. */
  const counted = (c: CanvasRuntime) => c.board.snapshot().items.filter(needsYou).length;
  const waiting = Object.fromEntries(canvases.map((c) => [c.id, counted(c)]));
  const waitingMessage = () => JSON.stringify({ type: 'waiting', waiting } satisfies ServerMessage);
  for (const c of canvases) {
    const send = (msg: ServerMessage) => {
      const text = JSON.stringify(msg);
      for (const ws of sockets.get(c.id)!) ws.send(text);
    };
    restarter?.onChange(() => send({ type: 'restart', restart: pending(c.id) }));
    c.board.onChange(() => {
      send({ type: 'snapshot', snapshot: c.board.snapshot() });
      const n = counted(c);
      if (n === waiting[c.id]) return;
      waiting[c.id] = n;
      const text = waitingMessage();
      for (const set of sockets.values()) for (const ws of set) ws.send(text);
    });
    c.board.onEvent((event) => send({ type: 'event', event }));
    c.board.onSpeak((cardId, text) => send({ type: 'speak', cardId, audio: voice(c, text) }));
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
      const first = await transcriber.transcribe(file, c.commander.vocabulary());
      const text = first.text.trim();
      if (silence(text)) return console.log(`whisper on ${c.id}: ${text}`), '';
      if (!looping(text) && !first.doubtful) return text;
      // the card titles talk Whisper into loops or guesses on a recording without speech: once more without them
      console.log(`whisper ${looping(text) ? 'looped' : 'was unsure'} on ${c.id}: ${text.slice(0, 80)}; once more without the card titles`);
      const again = await transcriber.transcribe(file, '');
      const second = again.text.trim();
      if (!looping(second) && !again.doubtful && !silence(second)) return second;
      console.log(`whisper on ${c.id} without the card titles${again.doubtful ? ', unsure' : ''}: ${second.slice(0, 80)}`);
      return silence(second) ? '' : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /** `null`: Whisper heard nothing it could write down, which the Koordinator should not guess from. */
  const heard = async (c: CanvasRuntime, text: string | null, focus: Focus, images: string[] = []) => {
    // the owner sees only the confirmation; the transcript is for whoever reads the server's log
    console.log(`heard on ${c.id}: ${text === null ? '(not understood)' : text || '(nothing)'}`);
    // nothing heard or understood: screenshots shown with it stay in the browser for the next try
    const h: Heard & { unheard?: true } =
      text === null
        ? { confirm: 'Das habe ich nicht verstanden.', unheard: true }
        : text
          ? await c.commander.hear(text, focus, images)
          : { confirm: 'Ich habe nichts gehört.', unheard: true };
    // the written confirmation goes out now, so the undo window starts now; the voice follows
    if (h.token) c.commander.arm(h.token);
    if (h.quiet) return h;
    return { ...h, ...(h.token ? { undoMs: c.commander.delayMs } : {}), audio: voice(c, h.confirm) };
  };

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    development: development && { hmr: true, console: true },
    routes: {
      '/': index,
      '/api/canvases': { GET: () => Response.json(canvases.map((c) => c.board.canvas) satisfies CanvasInfo[]) },
      // Obeya's configuration: read, checked while the owner edits it, and saved (Obeya then starts again)
      '/api/config': {
        GET: () => (config ? Response.json(config.view()) : new Response('Not found', { status: 404 })),
        PUT: async (req) => (config ? handle(async () => config.save(await req.json())) : new Response('Not found', { status: 404 })),
      },
      // the owner has a restart that waits for workers go ahead at once
      '/api/restart': {
        POST: () =>
          handle(() => {
            const due = !!restarter?.due();
            // after the answer is out: the restart stops this server
            if (due) setTimeout(() => restarter!.now(), 100);
            return { restarting: due };
          }),
      },
      '/api/config/check': { POST: async (req) => (config ? handle(async () => config.check(await req.json())) : new Response('Not found', { status: 404 })) },
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
      // a screenshot for a message: uploaded first, the message then names it by id
      '/api/c/:canvas/images': {
        POST: on(async (c, req) => ({ id: c.images.save(new Uint8Array(await req.arrayBuffer()), req.headers.get('content-type') ?? '') })),
      },
      '/api/c/:canvas/images/:file': {
        GET: (req) => {
          const file = byId.get(req.params.canvas)?.images.path(req.params.file);
          return file ? new Response(Bun.file(file), { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }) : new Response('Not found', { status: 404 });
        },
      },
      '/api/c/:canvas/cards/:id/plan': { GET: on((c, req) => c.board.planDoc(req.params.id!)) },
      // a project's decisions and the idea it came from
      '/api/c/:canvas/cards/:id/history': { GET: on((c, req) => c.board.projectHistory(req.params.id!)) },
      // an HTML artifact's page may load files from folders beside it
      '/api/c/:canvas/cards/:id/demo/*': {
        GET: (req) => {
          try {
            const demo = byId.get(req.params.canvas)?.board.demoFiles(req.params.id);
            const file = decodeURIComponent(new URL(req.url).pathname.split('/demo/').slice(1).join('/demo/'));
            return demo ? serveDemoFile(demo, file, req) : new Response('Not found', { status: 404 });
          } catch {
            return new Response('Not found', { status: 404 });
          }
        },
      },
      // what the owner said (audio) or typed, read by the Koordinator as one action
      '/api/c/:canvas/voice': {
        POST: on(async (c, req) => {
          // screenshots shown with the recording (`?image=<id>`, repeated), checked before transcribing
          const images = new URL(req.url).searchParams.getAll('image');
          c.images.resolve(images);
          return heard(c, await transcribe(c, req), focusOf(req), images);
        }),
      },
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
          const { text, images } = (await req.json()) as { text: string; images?: string[] };
          if (typeof text !== 'string' || !text.trim()) throw new BadRequest('emptyText', 'text must be a non-empty string');
          // screenshots pasted into the typed command go to the cards it creates or concerns
          c.images.resolve(images);
          return heard(c, text.trim(), focusOf(req), images ?? []);
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
        ws.send(JSON.stringify({ type: 'hello', server: started } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: c.board.snapshot() } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'restart', restart: pending(c.id) } satisfies ServerMessage));
        ws.send(waitingMessage());
      },
      close: (ws) => void sockets.get(ws.data.canvas)?.delete(ws),
      message: () => {},
    },
  });
}
