// HTTP and WebSocket for the UI: one API per canvas under /api/c/<canvas>/.

import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentListens, type CanvasInfo, type CardAction, type ClientMessage, type CardPatch, needsYou, type NewCard, type PendingRestart, type ServerMessage } from '../core/types';
import index from '../ui/index.html';
import panel from '../ui/panel.html';
import { BadRequest } from './board';
import type { CanvasRuntime } from './canvas';
import { defaultPushKey, type PageFocus, type PushKeyView } from '../core/push-key';
import { type Focus, type Heard, type Input, isField } from './commands';
import type { Config } from './config';
import { serveDemoFile } from './demo';
import { type NarrationHost, parseClipRequest } from './narration';
import type { Restarter } from './self-update';
import { looping, silence, type Transcriber } from './voice';
import type { MachineSetup } from './machine';
import type { VoiceSetup } from './voice-setup';
import { ShellReports } from './push-key';
import { AppUpdates } from './app-update';

type Req = Request & { params: Record<string, string> };

export interface Voice {
  transcriber: Transcriber;
  /** What voice in needs on this machine, for the settings sheet. */
  setup?: VoiceSetup;
}

export function serve(
  canvases: CanvasRuntime[],
  { transcriber, setup }: Voice,
  port: number,
  development = false,
  config?: Config,
  restarter?: Restarter,
  narration?: NarrationHost,
  machine?: MachineSetup,
  /** Stops Obeya as Ctrl-C does: once the workers paused, a second time at once. */
  stop?: () => void,
  /** What the app's shell reports about the push-to-talk key, shared with the setup assistant. */
  shells = new ShellReports(),
  /** The newer version of the app its shell has ready. */
  updates = new AppUpdates(),
) {
  const byId = new Map(canvases.map((c) => [c.id, c]));
  const started = crypto.randomUUID();
  const sockets = new Map<string, Set<ServerWebSocket<{ canvas: string; page: string }>>>(canvases.map((c) => [c.id, new Set()]));
  /** The restart that waits, as canvas `id` sees it. */
  const pending = (id: string): PendingRestart | null => {
    const due = restarter?.due();
    if (!due) return null;
    const here = due.waiting.filter((w) => w.canvas === id);
    return { reason: due.reason, since: due.since, deadline: due.deadline, cards: here.map((w) => w.card), elsewhere: due.waiting.length - here.length, owner: due.owner };
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
    updates.onChange(() => send({ type: 'update', update: updates.current() }));
    c.board.onChange(() => {
      send({ type: 'snapshot', snapshot: c.board.snapshot() });
      const n = counted(c);
      if (n === waiting[c.id]) return;
      waiting[c.id] = n;
      const text = waitingMessage();
      for (const set of sockets.values()) for (const ws of set) ws.send(text);
    });
    c.board.onEvent((event) => send({ type: 'event', event }));
    c.board.onNotice((n) => send({ type: 'notice', ...n }));
  }

  // The app's shell records a command when the owner holds the push-to-talk key in another app
  // (app/src/ptt.rs): it reports what it hears every few seconds, and asks where the owner was last.
  /** What each open page last reported as its focus, and when; the newest is where the owner was. */
  const focused = new Map<string, PageFocus & { at: number }>();
  const pushKeyView = (): PushKeyView => ({
    ...(config?.pushKey() ?? { key: defaultPushKey(process.platform), chosen: null, default: defaultPushKey(process.platform) }),
    shell: shells.current(),
  });
  const lastFocus = (): PageFocus | null => {
    const last = [...focused.values()].sort((a, b) => b.at - a.at)[0];
    if (last && byId.has(last.canvas)) return (({ at: _, ...f }) => f)(last);
    return canvases[0] ? { canvas: canvases[0].id } : null;
  };

  /** A click the Rückschau counts (a card deleted, a command taken back, a rule proposal decided on), once it went through. */
  const click = <T>(c: CanvasRuntime, out: T): T => {
    c.koordinator.noticed();
    return out;
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
  /**
   * What the owner said or typed: with an agent on the open card, straight to that agent (which
   * passes on what asks Obeya for something); else the Koordinator reads it. `null`: Whisper heard
   * nothing it could write down, which nobody should guess from.
   */
  const heard = async (c: CanvasRuntime, text: string | null, focus: Focus, images: string[] = [], input: Input = {}) => {
    // the owner sees only the confirmation; the transcript is for whoever reads the server's log
    console.log(`heard on ${c.id}: ${text === null ? '(not understood)' : text || '(nothing)'}`);
    // nothing heard or understood: screenshots shown with it stay in the browser for the next try
    if (text === null || (!text && !(input.typed && images.length))) return { confirm: text === null ? c.board.t.voice.notUnderstood : c.board.t.voice.nothingHeard, unheard: true };
    const card = focus.card ? c.board.item(focus.card) : undefined;
    if (card && agentListens(card)) {
      c.tell(card.id, text, images, !input.typed);
      // the card's conversation shows the words; the app's panel shows what was heard
      return { confirm: '', quiet: true, text } satisfies Heard & { text: string };
    }
    const h = await c.commander.hear(text, focus, images, input);
    // the written confirmation goes out now, so the undo window starts now
    if (h.token) c.commander.arm(h.token);
    // what was heard, for the app's panel, which shows it while the owner is in another app
    return { ...h, ...(h.token ? { undoMs: c.commander.delayMs } : {}), text };
  };

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    // a voice command answers once transcribed and read: with Whisper on a CPU that can take longer than Bun's 10 s
    idleTimeout: 120,
    development: development && { hmr: true, console: true },
    routes: {
      '/': index,
      // the app's floating panel for the push-to-talk key in another app
      '/panel': panel,
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
      // the app quitting, or anything that cannot send a signal (Windows has no SIGTERM): Ctrl-C over HTTP
      '/api/stop': {
        POST: () =>
          handle(() => {
            if (!stop) return { stopping: false };
            // after the answer is out: when no worker is busy, the stop ends this server
            setTimeout(stop, 100);
            return { stopping: true };
          }),
      },
      // the language Obeya speaks to the owner: chosen in the settings, else the system's
      '/api/language': {
        GET: () => (config ? Response.json(config.language()) : new Response('Not found', { status: 404 })),
        PUT: async (req) => (config ? handle(async () => config.saveLanguage(await req.json())) : new Response('Not found', { status: 404 })),
      },
      // the model and effort of each group of agents, read whenever one starts
      '/api/agents': {
        GET: () => (config ? Response.json(config.agents()) : new Response('Not found', { status: 404 })),
        PUT: async (req) => (config ? handle(async () => config.saveAgents(await req.json())) : new Response('Not found', { status: 404 })),
      },
      // what Obeya's own voice in needs here, and installing it
      '/api/voice-setup': { GET: () => (setup ? handle(() => setup.view()) : new Response('Not found', { status: 404 })) },
      '/api/voice-setup/install': { POST: () => (setup ? handle(() => setup.install()) : new Response('Not found', { status: 404 })) },
      // the setup assistant: what Obeya needs on this machine, installed, logged in; then the first canvas
      '/api/setup': { GET: () => (machine ? handle(() => machine.view()) : new Response('Not found', { status: 404 })) },
      '/api/setup/install': { POST: async (req) => (machine ? handle(async () => machine.install(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/setup/login': { POST: async (req) => (machine ? handle(async () => machine.login(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/setup/identity': { POST: async (req) => (machine ? handle(async () => machine.identity(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/setup/canvas': { POST: async (req) => (machine ? handle(async () => machine.canvas(await req.json())) : new Response('Not found', { status: 404 })) },
      // the system's folder dialog, open as long as the owner takes
      '/api/setup/pick': {
        POST: async (req, srv) => {
          if (!machine) return new Response('Not found', { status: 404 });
          srv.timeout(req, 0);
          const { prompt } = ((await req.json().catch(() => ({}))) ?? {}) as { prompt?: unknown };
          return handle(() => machine.pick(typeof prompt === 'string' ? prompt : ''));
        },
      },
      // the demo settings: narration language and voice, read by every render
      '/api/demo-settings': {
        GET: () => (config ? Response.json(config.demo()) : new Response('Not found', { status: 404 })),
        PUT: async (req) => (config ? handle(async () => config.saveDemo(await req.json())) : new Response('Not found', { status: 404 })),
      },
      // a voice as the owner chooses it: checked, installed (in the background), heard in a sample;
      // and what else a render needs on this machine
      '/api/demo-settings/check': { POST: async (req) => (config ? handle(async () => config.checkDemo(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/demo-settings/setup': { POST: async (req) => (config ? handle(async () => config.demoSetup(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/demo-settings/install': { POST: async (req) => (config ? handle(async () => config.installDemoVoice(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/demo-settings/sample': {
        POST: async (req) => {
          if (!config) return new Response('Not found', { status: 404 });
          const input = await req.json().catch(() => null);
          return config.sampleDemoVoice(input).then(
            (wav) => new Response(wav, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } }),
            (e) => handle(() => Promise.reject(e)),
          );
        },
      },
      // a demo's narration clip, in the voice Obeya holds loaded across renders (narration.ts); it
      // writes a file, so only as JSON, which a page elsewhere cannot send without asking first
      '/api/narration/clip': {
        POST: async (req, srv) => {
          if (!narration) return new Response('Not found', { status: 404 });
          if (!req.headers.get('content-type')?.startsWith('application/json')) return Response.json({ code: 'invalid', error: 'JSON only' }, { status: 415 });
          const request = parseClipRequest(await req.json().catch(() => null));
          if (typeof request === 'string') return Response.json({ code: 'invalid', error: request }, { status: 400 });
          // the clip waits its turn behind other renders' clips, maybe behind loading the model
          srv.timeout(req, 0);
          return Response.json(await narration.clip(request));
        },
      },
      '/api/config/check': { POST: async (req) => (config ? handle(async () => config.check(await req.json())) : new Response('Not found', { status: 404 })) },
      '/api/c/:canvas/canvas': { GET: on((c) => c.board.snapshot()) },
      '/api/c/:canvas/cards': { POST: on(async (c, req) => c.board.create((await req.json()) as NewCard)) },
      // from "Konfiguration", for a repository on the generic adapter: the card that writes its own
      '/api/c/:canvas/adapter-setup': { POST: on(async (c, req) => c.adapterSetupCard(String(((await req.json()) as { repo?: unknown }).repo))) },
      '/api/c/:canvas/cards/:id': {
        PATCH: on(async (c, req) => c.patch(req.params.id!, (await req.json()) as CardPatch)),
        DELETE: on((c, req) => click(c, c.remove(req.params.id!))),
      },
      // groups: a new one with its first cards (and a colour, when one comes back), a new name, the
      // end of one, and cards put into one (`group: null`: none)
      '/api/c/:canvas/groups': {
        POST: on(async (c, req) => {
          const { name, cards, hue } = ((await req.json()) ?? {}) as { name?: string; cards?: string[]; hue?: number };
          return c.board.createGroup(name, cards, hue);
        }),
      },
      '/api/c/:canvas/groups/:id': {
        PATCH: on(async (c, req) => c.board.renameGroup(req.params.id!, (((await req.json()) ?? {}) as { name?: string }).name)),
        DELETE: on((c, req) => c.board.deleteGroup(req.params.id!)),
      },
      '/api/c/:canvas/assign': {
        POST: on(async (c, req) => {
          const { cards, group } = ((await req.json()) ?? {}) as { cards?: string[]; group?: string | null };
          return c.board.group(cards, group ?? null);
        }),
      },
      '/api/c/:canvas/cards/:id/restore': { POST: on((c, req) => c.board.restore(req.params.id!)) },
      '/api/c/:canvas/cards/:id/archive': { POST: on((c, req) => c.board.archive([req.params.id!])) },
      '/api/c/:canvas/cards/:id/unarchive': { POST: on((c, req) => c.board.unarchive(req.params.id!)) },
      // the archive, newest first; posting archives every finished card of the owner's
      '/api/c/:canvas/archive': { GET: on((c) => c.board.archived()), POST: on((c) => ({ ids: c.board.archiveDone() })) },
      '/api/c/:canvas/cards/:id/act': { POST: on(async (c, req) => c.press(req.params.id!, (await req.json()) as CardAction)) },
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
      // a video demo as a file to pass on, where the repository has no share target (`?as=zip|html`)
      // the push-to-talk key anywhere on the machine, chosen in the settings, and the shell that hears it
      '/api/push-to-talk': {
        GET: () => Response.json(pushKeyView()),
        PUT: async (req) => (config ? handle(async () => (config.savePushKey(await req.json()), pushKeyView())) : new Response('Not found', { status: 404 })),
      },
      // the app's shell, every few seconds: what it hears; it gets the key that applies
      '/api/push-to-talk/shell': {
        POST: async (req) =>
          handle(async () => {
            try {
              shells.report(await req.json());
            } catch (e) {
              throw e instanceof TypeError ? new BadRequest('invalid', e.message) : e;
            }
            return pushKeyView();
          }),
      },
      // the app's shell, every few seconds while it has a newer version of the app ready
      '/api/app-update': {
        GET: () => Response.json(updates.current()),
        POST: async (req) =>
          handle(async () => {
            try {
              return updates.report(await req.json());
            } catch (e) {
              throw e instanceof TypeError ? new BadRequest('invalid', e.message) : e;
            }
          }),
      },
      // the owner installs it: once the workers paused, Obeya ends for the shell to install it and start again
      '/api/app-update/install': {
        POST: () =>
          handle(() => {
            const update = updates.current();
            if (!restarter || !update || update.download) throw new BadRequest('invalid', 'no update the app can install');
            // after the answer is out: with no worker to wait for, the update ends this server at once
            setTimeout(() => restarter.request('update'), 100);
            return { updating: true };
          }),
      },
      // where the owner was last in a page: the shell's command goes there
      '/api/focus': { GET: () => Response.json(lastFocus()) },
      '/api/c/:canvas/cards/:id/export': {
        GET: async (req) => {
          const c = byId.get(req.params.canvas);
          if (!c) return Response.json({ code: 'invalid', error: 'unknown canvas' }, { status: 404 });
          const as = new URL(req.url).searchParams.get('as');
          if (as !== 'zip' && as !== 'html') return Response.json({ code: 'invalid', error: 'as must be zip or html' }, { status: 400 });
          try {
            const f = await c.sharing.export(req.params.id, as);
            return new Response(f.data, { headers: { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' } });
          } catch (e) {
            if (e instanceof BadRequest) return Response.json({ code: e.code, error: e.message }, { status: 400 });
            throw e;
          }
        },
      },
      // what the owner said (audio), for the open card's agent or the Koordinator
      '/api/c/:canvas/voice': {
        POST: on(async (c, req) => {
          // screenshots shown with the recording (`?image=<id>`, repeated), checked before transcribing
          const images = new URL(req.url).searchParams.getAll('image');
          c.images.resolve(images);
          return heard(c, await transcribe(c, req), focusOf(req), images);
        }),
      },
      // the owner started speaking: transcription and the Koordinator get ready meanwhile
      '/api/c/:canvas/voice/warm': {
        POST: on((c) => {
          transcriber.warm?.();
          c.commander.warm();
        }),
      },
      '/api/c/:canvas/command': {
        POST: on(async (c, req) => {
          // `field`: typed into that field of the open card rather than into the Koordinator's sheet
          const { text, images, field } = (await req.json()) as { text: string; images?: string[]; field?: unknown };
          // a screenshot alone may speak for itself to the open card's agent
          const card = focusOf(req).card;
          const listens = !!card && !!c.board.item(card) && agentListens(c.board.item(card)!);
          if (typeof text !== 'string' || (!text.trim() && !(listens && images?.length))) throw new BadRequest('emptyText', 'text must be a non-empty string');
          // screenshots pasted into the typed command go to the cards it creates or concerns
          c.images.resolve(images);
          return heard(c, text.trim(), focusOf(req), images ?? [], { typed: true, ...(isField(field) ? { field } : {}) });
        }),
      },
      '/api/c/:canvas/command/undo': {
        POST: on(async (c, req) => click(c, { undone: c.commander.undo(((await req.json()) as { token: string }).token) })),
      },
      '/api/c/:canvas/preferences': {
        POST: on(async (c, req) => {
          const { text, target } = (await req.json()) as { text: string; target?: string };
          c.remember(text, target ? { repos: [target] } : {});
        }),
      },
      '/api/c/:canvas/preferences/:id': {
        PATCH: on(async (c, req) => c.board.setPreference(Number(req.params.id), ((await req.json()) as { text: string }).text)),
        DELETE: on((c, req) => c.board.setPreference(Number(req.params.id), null)),
      },
      '/api/c/:canvas/preferences/:id/accept': {
        POST: on(async (c, req) => {
          const { text, target } = (await req.json().catch(() => ({}))) as { text?: string; target?: string | null };
          return click(c, c.acceptRule(Number(req.params.id), text, target));
        }),
      },
      '/api/c/:canvas/preferences/:id/reject': { POST: on((c, req) => click(c, c.rejectRule(Number(req.params.id)))) },
      // "Erneut teilen" for many outdated pages at once: `count` of them, the newest demos first, or all (null)
      '/api/c/:canvas/reshare': {
        POST: on(async (c, req) => {
          const { count } = (await req.json().catch(() => ({}))) as { count?: number | null };
          if (count != null && !(Number.isInteger(count) && count > 0)) throw new BadRequest('invalid', 'count must be a positive integer or null');
          c.sharing.reshareMany(count ?? null);
        }),
        // puts away what the finished run says
        DELETE: on((c) => c.sharing.dismissResharing()),
      },
      '/api/c/:canvas/reshare/stop': { POST: on((c) => c.sharing.stopResharing()) },
      '/api/c/:canvas/ws': (req, server) =>
        byId.has(req.params.canvas) && server.upgrade(req, { data: { canvas: req.params.canvas, page: crypto.randomUUID() } })
          ? undefined
          : new Response('WebSocket expected', { status: 400 }),
    },
    fetch: () => new Response('Not found', { status: 404 }),
    websocket: {
      data: {} as { canvas: string; page: string },
      open: (ws) => {
        const c = byId.get(ws.data.canvas);
        if (!c) return ws.close();
        sockets.get(c.id)!.add(ws);
        ws.send(JSON.stringify({ type: 'hello', server: started } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: c.board.snapshot() } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'restart', restart: pending(c.id) } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'update', update: updates.current() } satisfies ServerMessage));
        ws.send(waitingMessage());
      },
      close: (ws) => {
        sockets.get(ws.data.canvas)?.delete(ws);
        restarter?.hold(ws.data.page);
        focused.delete(ws.data.page);
      },
      // the owner watching a demo video or dictating in this page holds a restart off
      message: (ws, text) => {
        try {
          const msg = JSON.parse(String(text)) as ClientMessage;
          if (msg.type === 'hold' && Array.isArray(msg.hold)) restarter?.hold(ws.data.page, msg.hold.filter((h) => h === 'video' || h === 'voice'));
          if (msg.type === 'back') byId.get(ws.data.canvas)?.ownerBack();
          if (msg.type === 'focus') {
            const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
            const f = { card: text(msg.card), project: text(msg.project), target: text(msg.target), title: text(msg.title) };
            focused.set(ws.data.page, { canvas: ws.data.canvas, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), at: Date.now() });
          }
        } catch {}
      },
    },
  });
}
