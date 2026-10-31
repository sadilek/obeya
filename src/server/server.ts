// HTTP and WebSocket for the UI: one API per canvas under /api/c/<canvas>/.

import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { agentListens, type CanvasInfo, type CardAction, type ClientMessage, type CardPatch, type Item, type NewCard, type PendingRestart, type ServerMessage, type SpotInput, type TalkRef, isTalkRef, MAX_FILE_BYTES, needsYou, waitingOn } from '../core/types';
import index from '../ui/index.html';
import { guarded, LOCAL_HOSTS, refusal } from './access';
import { BadRequest } from './board';
import { type Dropped, findDropped, localImage } from './files';
import type { CanvasRuntime } from './canvas';
import { SiteSetup } from './site-setup';
import { parsePlace } from '../core/layout';
import { type Focus, type Heard, type Input, isField } from './commands';
import { holdsNotes } from '../core/queue';
import type { Config } from './config';
import { serveAnswerFile, serveCardFile, serveDemoFile, serveMockFrame } from './demo';
import { type NarrationHost, parseClipRequest } from './narration';
import type { Restarter } from './self-update';
import { looping, silence, type Transcriber } from './voice';
import { CloudError } from './voice-cloud';
import type { MachineSetup } from './machine';
import type { VoiceSetup } from './voice-setup';
import { AppUpdates, HandOver } from './app-update';
import type { SourceUpdates } from './source-update';
import { oldLinuxBun } from './repo';
import { Store } from './db';
import { Access } from './remote';
import { Push, startedWaiting } from './push';
import { worker } from '../ui/sw';
import icon180 from '../ui/logo/apple-touch-icon.png' with { type: 'file' };
import icon512 from '../ui/logo/icon-512.png' with { type: 'file' };
import { servePdfjs } from './pdfjs';
import { Tailscale } from './tailscale';
import { agentsView, languageView, saveAgents, saveLanguage, saveTheme, saveUsageMeter, themeView, usageMeterView } from './settings';
import type { UsageMeter } from './usage';
import { VERSION } from './resources';
import { footerOf } from './wish';
import { serving } from './owner';
import { pageStall, type Stalls } from './stalls';

type Req = Request & { params: Record<string, string> };

const notFound = () => new Response('Not found', { status: 404 });

/** `?replyTo=` of a recording: a card's event (`7`), or a message of the sheet (`12.answer`). */
function replyParam(p: string | null): number | TalkRef | undefined {
  const m = p?.match(/^(\d+)(?:\.(said|reply|answer))?$/);
  if (!m) return;
  return m[2] ? { talk: Number(m[1]), part: m[2] as TalkRef['part'] } : Number(m[1]) || undefined;
}

/** What the server knows of an open page's WebSocket: its canvas, the page, and the paired device it is on, if another. */
interface Socket {
  canvas: string;
  page: string;
  device?: string;
}

export interface Voice {
  transcriber: Transcriber;
  /** What voice in needs on this machine, for the settings sheet. */
  setup?: VoiceSetup;
}

/** The canvases a server serves: those that run now, and word whenever one starts, stops or changes (`Canvases`). */
export interface Served {
  all(): CanvasRuntime[];
  onChange?(fn: () => void): () => void;
}

/**
 * A demo's narration clip, in the voice Obeya holds loaded across renders (narration.ts). It writes a
 * file, so only as JSON, which a page elsewhere cannot send without asking first. `remote`: for a
 * render on another machine, whose clip comes back in the reply and is written nowhere here.
 */
function clipRoute(narration: NarrationHost, remote = false) {
  return async (req: Request, srv: Bun.Server<unknown>) => {
    if (!req.headers.get('content-type')?.startsWith('application/json')) return Response.json({ code: 'invalid', error: 'JSON only' }, { status: 415 });
    const request = parseClipRequest(await req.json().catch(() => null));
    if (typeof request === 'string') return Response.json({ code: 'invalid', error: request }, { status: 400 });
    if (remote && !request.inline) return Response.json({ code: 'invalid', error: 'inline must be true from another machine' }, { status: 400 });
    // the clip waits its turn behind other renders' clips, maybe behind loading the model
    srv.timeout(req, 0);
    const reply = await narration.clip(request);
    if (!request.inline || !('ok' in reply)) return Response.json(reply);
    const file = Bun.file(request.out);
    const wav = Buffer.from(await file.arrayBuffer()).toString('base64');
    await file.delete();
    return Response.json({ ...reply, wav });
  };
}

/**
 * What a worker on another machine reaches through the port forwarded to it (design: Hosts): the
 * narration clips and nothing else of Obeya's, as whoever is on that machine reaches the port too.
 */
export function serveNarration(narration: NarrationHost) {
  const clip = clipRoute(narration, true);
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 120,
    fetch: (req, srv) =>
      refusal(req, LOCAL_HOSTS) ?? (req.method === 'POST' && new URL(req.url).pathname === '/api/narration/clip' ? clip(req, srv) : notFound()),
  });
}

export function serve(
  served: Served | CanvasRuntime[],
  { transcriber, setup }: Voice,
  port: number,
  development = false,
  config?: Config,
  restarter?: Restarter,
  narration?: NarrationHost,
  machine?: MachineSetup,
  /** Stops Obeya as Ctrl-C does: once the workers paused, a second time at once. */
  stop?: () => void,
  /** The newer version of the app its shell has ready. */
  updates = new AppUpdates(),
  /** Who reaches Obeya from other devices; by default no one. */
  access = new Access({ store: new Store(':memory:'), tailscale: new Tailscale(null) }),
  /** What goes to the devices that turned notifications on. */
  push = new Push({ store: access.store }),
  /** New commits on the upstream of the checkout Obeya runs from; none for the app or the compiled binary. */
  sources?: SourceUpdates,
  /** The plan's usage limits for the bar, fetched while the owner has it show them and a page is open. */
  usage?: UsageMeter,
  /** Where the stalls of the pages go, beside the server's own. */
  stalls?: Stalls,
) {
  const canvases = Array.isArray(served) ? { all: () => served } : served;
  const sites = config
    ? new SiteSetup({
        home: config.home,
        changed: () => canvases.all().forEach((c) => c.personalSiteChanged()),
        repos: () => canvases.all().flatMap((c) => c.repos.map((r) => ({ path: r.info.path, name: r.ref.name, isPublic: !!r.isPublic, ownSite: !!r.ref.share && !r.ref.shareOnPersonal, onPersonal: !!r.ref.shareOnPersonal, siteApproved: r.site?.publish === 'approved' }))),
        user: (() => {
          try {
            return userInfo().username;
          } catch {
            return '';
          }
        })(),
      })
    : undefined;
  const byId = new Map<string, CanvasRuntime>();
  const handOver = new HandOver();
  const started = crypto.randomUUID();
  const sockets = new Map<string, Set<ServerWebSocket<Socket>>>();
  // a device removed loses its open pages at once
  access.onRemoved((device) => {
    for (const set of sockets.values()) for (const ws of set) if (ws.data.device === device) ws.close(4401, 'device removed');
  });
  /** The restart that waits, as canvas `id` sees it: Obeya's, else that of some of its repositories' agents. */
  const pending = (id: string): PendingRestart | null => {
    const due = restarter?.due();
    if (!due) return byId.get(id)?.pendingRestart() ?? null;
    const here = due.waiting.filter((w) => w.canvas === id);
    // the others by canvas, named, each card by its title: a canvas's page knows only its own cards
    const elsewhere = new Map<string, string[]>();
    const items = new Map<string, Item[]>();
    for (const w of due.waiting) {
      if (w.canvas === id) continue;
      if (!items.has(w.canvas)) items.set(w.canvas, byId.get(w.canvas)?.board.items() ?? []);
      const title = items.get(w.canvas)!.find((i) => i.id === w.card)?.title ?? w.card;
      elsewhere.set(w.canvas, [...(elsewhere.get(w.canvas) ?? []), title]);
    }
    return {
      reason: due.reason,
      deadline: due.deadline,
      cards: here.map((w) => w.card),
      elsewhere: [...elsewhere].map(([c, cards]) => ({ canvas: byId.get(c)?.board.canvas.name ?? c, cards })),
      owner: due.owner,
    };
  };
  /** How many things on each canvas need the owner: each canvas's switcher points to the others. */
  const counted = (c: CanvasRuntime) => waitingOn(c.board.snapshot());
  const waiting: Record<string, number> = {};
  const waitingMessage = () => JSON.stringify({ type: 'waiting', waiting } satisfies ServerMessage);
  const everyone = (text: string) => {
    for (const set of sockets.values()) for (const ws of set) ws.send(text);
  };
  const sendTo = (id: string, msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets.get(id) ?? []) ws.send(text);
  };
  restarter?.onChange(() => {
    for (const id of byId.keys()) sendTo(id, { type: 'restart', restart: pending(id) });
  });
  updates.onChange(() => everyone(JSON.stringify({ type: 'update', update: updates.current() } satisfies ServerMessage)));
  sources?.onChange(() => everyone(JSON.stringify({ type: 'source', source: sources.current() } satisfies ServerMessage)));
  usage?.onChange(() => everyone(JSON.stringify({ type: 'usage', usage: usage.current() } satisfies ServerMessage)));
  /** What tells the usage meter a page closed, by page. */
  const unwatch = new Map<string, () => void>();
  /** What stops sending each canvas's changes to its pages. */
  const detach = new Map<string, () => void>();
  const attach = (c: CanvasRuntime) => {
    byId.set(c.id, c);
    if (!sockets.has(c.id)) sockets.set(c.id, new Set());
    waiting[c.id] = counted(c);
    const send = (msg: ServerMessage) => sendTo(c.id, msg);
    /** The cards as last sent: what starts to wait for the owner after is pushed to their phone. */
    let seen = new Map(c.board.items().map((i) => [i.id, i]));
    const offs = [
      c.board.onChange(() => {
        const items = c.board.items();
        const started = startedWaiting(seen, items);
        seen = new Map(items.map((i) => [i.id, i]));
        const several = canvases.all().length > 1;
        push.waits(
          started.map(({ item, kind }) => ({
            card: item.id,
            title: item.title,
            kind,
            ...(several ? { canvas: c.board.canvas.name } : {}),
            still: () => {
              const now = c.board.item(item.id);
              return !!now && needsYou(now);
            },
          })),
        );
        send({ type: 'snapshot', snapshot: c.board.snapshot() });
        // what the switchers show of it (its repositories, whether they run as configured) may have changed
        relist();
        const n = counted(c);
        if (n === waiting[c.id]) return;
        waiting[c.id] = n;
        everyone(waitingMessage());
      }),
      c.board.onEvent((event) => send({ type: 'event', event })),
      c.board.onEventGone((cardId, id) => send({ type: 'eventGone', cardId, id })),
      c.board.onNotice((n) => send({ type: 'notice', ...n })),
      // its repositories' agents restarted: what the switchers show of it may have changed with them
      c.onPending(() => {
        send({ type: 'restart', restart: pending(c.id) });
        relist();
      }),
    ];
    detach.set(c.id, () => offs.forEach((off) => off()));
  };
  /** The list the pages' canvas switchers show, as it was last sent. */
  let listed = '';
  /** Sends the canvases to every page where they changed (one started, stopped, renamed, or with other repositories). */
  const relist = () => {
    const now = canvases.all().map((c) => c.board.canvas);
    const list = JSON.stringify(now);
    if (list === listed) return;
    const first = !listed;
    listed = list;
    if (first) return;
    everyone(JSON.stringify({ type: 'canvases', canvases: now } satisfies ServerMessage));
    everyone(waitingMessage());
  };
  for (const c of canvases.all()) attach(c);
  relist();
  // a canvas started or stopped while Obeya runs: the pages of one that stopped go to another
  canvases.onChange?.(() => {
    const now = canvases.all();
    for (const [id, c] of [...byId])
      if (!now.includes(c)) {
        detach.get(id)?.();
        detach.delete(id);
        byId.delete(id);
        delete waiting[id];
        // the page asks for the canvases, and goes to the first there is
        for (const ws of sockets.get(id) ?? []) ws.close();
        sockets.delete(id);
      }
    for (const c of now) if (byId.get(c.id) !== c) attach(c);
    relist();
  });

  /** A click the Rückschau counts (a card deleted, a command taken back, a rule proposal decided on), once it went through. */
  const click = <T>(c: CanvasRuntime, out: T): T => {
    c.koordinator.noticed();
    return out;
  };

  const handle = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const out = await fn();
      if (out instanceof Response) return out;
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
  /** A route that needs what this server may run without (its configuration, voice setup, the setup assistant); a 404 without it. */
  const needs =
    <T,>(x: T | undefined, fn: (x: T, req: Request) => unknown | Promise<unknown>) =>
    (req: Request): Response | Promise<Response> =>
      x ? handle(() => fn(x, req)) : notFound();
  /** Nothing the owner said came through: Whisper understood nothing (`null`), or heard nothing. */
  const unheard = (c: CanvasRuntime, text: string | null) => ({ confirm: text === null ? c.board.t.voice.notUnderstood : c.board.t.voice.nothingHeard, unheard: true });

  /**
   * A restart waits for what the owner said on the server's own count too, until its answer is
   * written, whether or not the page that sent it still holds it off: one that came while Whisper
   * wrote lost the words (until 2026-10-14).
   */
  let answering = 0;
  const holdingRestart =
    <T,>(fn: (c: CanvasRuntime, req: Req) => Promise<T>) =>
    async (c: CanvasRuntime, req: Req): Promise<T> => {
      const holder = `request ${++answering}`;
      restarter?.hold(holder, ['voice']);
      try {
        return await fn(c, req);
      } finally {
        restarter?.hold(holder);
      }
    };

  /**
   * The recordings that arrived whole (`?sent=<id>`, the page's name for one): a page whose
   * connection broke before the answer asks here whether Obeya has the command, and gives the field
   * its words and screenshots back only when it has not. The newest few hundred; a restart forgets them.
   */
  const arrived = new Set<string>();
  const ARRIVED_KEPT = 500;
  const arrive = (id: string | null) => {
    if (!id) return;
    arrived.add(id);
    for (const old of arrived) if (arrived.size > ARRIVED_KEPT) arrived.delete(old);
  };

  /** The card or project in view, and where on the canvas the owner was: as the page says, else what it last had in view. */
  const focusOf = (req: Request, c?: CanvasRuntime): Focus => {
    const q = new URL(req.url).searchParams;
    const place = parsePlace(q.get('place')) ?? c?.inView;
    return { ...(q.get('card') ? { card: q.get('card')! } : {}), ...(q.get('project') ? { project: q.get('project')! } : {}), ...(place ? { place } : {}) };
  };
  const transcribe = async (c: CanvasRuntime, audio: Blob) => {
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-'));
    // by what the browser recorded: a cloud service tells the format by the file's name
    const file = join(dir, `speech.${/mp4|m4a|aac/.test(audio.type) ? 'mp4' : /wav/.test(audio.type) ? 'wav' : /ogg/.test(audio.type) ? 'ogg' : 'webm'}`);
    try {
      await Bun.write(file, audio);
      const first = await transcriber.transcribe(file, c.commander.vocabulary());
      const text = first.text.trim();
      if (silence(text)) return console.log(`voice on ${c.id}: ${text}`), '';
      if (!looping(text) && !first.doubtful) return text;
      if (first.unprompted) return console.log(`voice ${looping(text) ? 'looped' : 'was unsure'} on ${c.id}: ${text.slice(0, 80)}`), null;
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
  // a planned card takes what is typed into its field for the agent that will take it on; spoken
  // words go to the Koordinator, which starts it, snoozes it or takes it out of the queue
  const listens = (card: Item, input: Input) => agentListens(card) || (input.field === 'note' && holdsNotes(card));
  /**
   * What the owner said or typed: with an agent on the open card, straight to that agent (which
   * passes on what asks Obeya for something); else the Koordinator reads it. `null`: Whisper heard
   * nothing it could write down, which nobody should guess from.
   */
  const heard = async (c: CanvasRuntime, text: string | null, focus: Focus, images: string[] = [], input: Input = {}) => {
    // the owner sees only the confirmation; the transcript is for whoever reads the server's log
    console.log(`heard on ${c.id}: ${text === null ? '(not understood)' : text || '(nothing)'}`);
    // nothing heard or understood: screenshots shown with it stay in the browser for the next try
    if (text === null || (!text && !(input.typed && images.length))) return unheard(c, text);
    const card = focus.card ? c.board.item(focus.card) : undefined;
    if (card && listens(card, input)) {
      c.tell(card.id, text, images, !input.typed, typeof input.replyTo === 'number' ? input.replyTo : undefined, input.spot);
      // the card's conversation shows the words
      return { confirm: '', quiet: true } satisfies Heard;
    }
    const h = await c.commander.hear(text, focus, images, input);
    // the written confirmation goes out now, so the undo window starts now
    if (h.token) c.commander.arm(h.token);
    return { ...h, ...(h.token ? { undoMs: c.commander.delayMs } : {}) };
  };

  const options = {
    port,
    hostname: '127.0.0.1',
    // a voice command answers once transcribed and read: with Whisper on a CPU that can take longer than Bun's 10 s
    idleTimeout: 120,
    development: development && { hmr: true, console: true },
    routes: guarded({
      '/': index,
      // a browser on this machine signing in with a one-time link (owner.ts)
      '/login': { GET: (req, srv) => access.loginRoute(req, srv) },
      // such a link, for whoever holds the owner's key (the app's shell, a second start, scripts); `next`: where it leads; `once`: for one browser
      '/api/login-link': {
        POST: async (req, srv) => {
          if (!access.isLocal(req, srv)) return onlyHere();
          const { next, once } = ((await req.json().catch(() => null)) ?? {}) as { next?: unknown; once?: unknown };
          return Response.json({ url: access.owner.link(new URL(req.url).origin, typeof next === 'string' ? next : '/', once === true) });
        },
      },
      // another device pairing: the address in the QR code (`?code=`), or the code typed into the page it got
      '/pair': { GET: (req, srv) => access.pairRoute(req, srv), POST: (req, srv) => access.pairRoute(req, srv) },
      // „Von anderen Geräten“: the setting, what the network allows, the devices; only on this machine
      '/api/access': {
        GET: (req, srv) => (access.isLocal(req, srv) ? handle(() => access.view()) : Response.json({ local: false })),
        PUT: async (req, srv) => (access.isLocal(req, srv) ? handle(async () => access.save(await req.json())) : onlyHere()),
      },
      '/api/access/pair': { POST: (req, srv) => (access.isLocal(req, srv) ? handle(() => access.pair()) : onlyHere()) },
      '/api/access/devices/:id': { DELETE: (req, srv) => (access.isLocal(req, srv) ? handle(() => ({ removed: access.remove(req.params.id) })) : onlyHere()) },
      // the web app on a phone's home screen: the icons of its manifest (manifest.webmanifest, which the
      // page's bundle carries), its service worker (sw.ts), and the device's push subscription (`on`:
      // Obeya has one for this device); pushes go only to paired devices
      '/icons/180.png': { GET: () => new Response(Bun.file(icon180), { headers: { 'cache-control': 'max-age=86400' } }) },
      '/icons/512.png': { GET: () => new Response(Bun.file(icon512), { headers: { 'cache-control': 'max-age=86400' } }) },
      // pdf.js's worker, fonts and decoders, where the page draws a PDF itself (src/ui/pdf.tsx)
      '/pdfjs/*': { GET: (req) => servePdfjs(req) },
      '/sw.js': { GET: () => new Response(`(${worker.toString()})();\n`, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } }) },
      '/api/push': {
        GET: (req) => handle(async () => {
          const device = access.deviceOf(req);
          return { key: await push.key(), on: !!device && push.subscribed(device) };
        }),
        PUT: async (req) => {
          const device = access.deviceOf(req);
          if (!device) return onlyDevices();
          return handle(async () => push.subscribe(device, await req.json()));
        },
        DELETE: (req) => {
          const device = access.deviceOf(req);
          return device ? handle(() => push.unsubscribe(device)) : onlyDevices();
        },
      },
      '/api/canvases': { GET: () => Response.json(canvases.all().map((c) => c.board.canvas) satisfies CanvasInfo[]) },
      // Obeya's configuration: read, checked while the owner edits it, and saved (Obeya then starts again)
      '/api/config': {
        GET: needs(config, (c) => c.view()),
        PUT: needs(config, async (c, req) => c.save(await req.json())),
      },
      // the owner has the restart of a repository's agents that waits for them go ahead at once
      '/api/c/:canvas/restart': { POST: on((c) => ({ restarting: c.restartNow() })) },
      // the owner pauses the canvas's agents at work (and holds its queue), or resumes its paused ones
      '/api/c/:canvas/pause': { POST: on((c) => c.pauseAgents()) },
      '/api/c/:canvas/resume': { POST: on((c) => c.resumeAgents()) },
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
      // the interface language (chosen in the settings, else the system's) and the conversation language (chosen, else the interface's)
      '/api/language': {
        GET: needs(config, (c) => languageView(c.home)),
        PUT: needs(config, async (c, req) => saveLanguage(c.home, await req.json())),
      },
      // light or dark: chosen in the settings, else as the system
      '/api/theme': {
        GET: needs(config, (c) => themeView(c.home)),
        PUT: needs(config, async (c, req) => saveTheme(c.home, await req.json())),
      },
      // whether the bar shows the plan's usage limits: the meter fetches them from then on, or stops
      '/api/usage-meter': {
        GET: needs(config, (c) => usageMeterView(c.home)),
        PUT: needs(config, async (c, req) => {
          const view = saveUsageMeter(c.home, await req.json());
          usage?.setOn(view.on);
          return view;
        }),
      },
      // the model and effort of each group of agents, read whenever one starts
      '/api/agents': {
        GET: needs(config, (c) => agentsView(c.home)),
        PUT: needs(config, async (c, req) => saveAgents(c.home, await req.json())),
      },
      // the owner's personal demo site: set up at a host, connected with another machine's code, removed
      // from this machine; the private repositories ticked for it, and those that share there with the approval
      '/api/personal-site': {
        GET: needs(sites, (x) => x.view()),
        DELETE: needs(sites, (x) => x.remove()),
      },
      '/api/personal-site/setup': { POST: needs(sites, async (x, req) => x.setupPersonal(await req.json())) },
      '/api/personal-site/connect': { POST: needs(sites, async (x, req) => x.connect(await req.json())) },
      '/api/personal-site/code': { GET: needs(sites, (x) => x.code()) },
      '/api/personal-site/private': { POST: needs(sites, async (x, req) => x.allow(await req.json())) },
      '/api/personal-site/approved': { POST: needs(sites, async (x, req) => x.approved(await req.json())) },
      // „Demo-Seite einrichten“ for a repository: started, followed, and taken into its settings
      '/api/site-setup': {
        GET: needs(sites, (x, req) => ({ job: x.repoJob(new URL(req.url).searchParams.get('path') ?? '') })),
        POST: needs(sites, async (x, req) => ({ job: x.setupRepo(await req.json()) })),
        DELETE: needs(sites, (x, req) => (x.doneWith(new URL(req.url).searchParams.get('path') ?? ''), {})),
      },
      // what Obeya's own voice in needs here, and installing it
      '/api/voice-setup': { GET: needs(setup, (s) => s.view()) },
      '/api/voice-setup/install': { POST: needs(setup, (s) => s.install()) },
      '/api/voice-setup/measure': { POST: needs(setup, (s) => s.measure()) },
      // a cloud service for voice in: tested and used (PUT), or back to this machine (DELETE)
      '/api/voice-setup/cloud': {
        PUT: needs(setup, async (s, req) => s.useCloud(await req.json())),
        DELETE: needs(setup, (s) => s.useLocal()),
      },
      // the setup assistant: what Obeya needs on this machine, installed, logged in; then the first canvas
      '/api/setup': { GET: needs(machine, (m) => m.view()) },
      '/api/setup/install': { POST: needs(machine, async (m, req) => m.install(await req.json())) },
      '/api/setup/login': { POST: needs(machine, async (m, req) => m.login(await req.json())) },
      '/api/setup/token': { POST: needs(machine, async (m, req) => m.saveToken(await req.json())) },
      '/api/setup/identity': { POST: needs(machine, async (m, req) => m.identity(await req.json())) },
      '/api/setup/folder': { POST: needs(machine, async (m, req) => m.folder(await req.json())) },
      // setting up git in a folder that has none: what the first commit holds, then the commit
      '/api/setup/git-preview': { POST: needs(machine, async (m, req) => m.gitPreview(await req.json())) },
      '/api/setup/git': { POST: needs(machine, async (m, req) => m.gitSetup(await req.json())) },
      '/api/setup/canvas': { POST: needs(machine, async (m, req) => m.canvas(await req.json())) },
      // the system's folder dialog, open as long as the owner takes
      '/api/setup/pick': {
        POST: async (req, srv) => {
          if (!machine) return notFound();
          srv.timeout(req, 0);
          const { prompt } = ((await req.json().catch(() => ({}))) ?? {}) as { prompt?: unknown };
          return handle(() => machine.pick(typeof prompt === 'string' ? prompt : ''));
        },
      },
      // the demo settings: narration language and voice, read by every render
      '/api/demo-settings': {
        GET: needs(config, (c) => c.demo()),
        PUT: needs(config, async (c, req) => c.saveDemo(await req.json())),
      },
      // a voice as the owner chooses it: checked, installed (in the background), heard in a sample;
      // and what else a render needs on this machine
      '/api/demo-settings/check': { POST: needs(config, async (c, req) => c.checkDemo(await req.json())) },
      '/api/demo-settings/setup': { POST: needs(config, async (c, req) => c.demoSetup(await req.json())) },
      '/api/demo-settings/install': { POST: needs(config, async (c, req) => c.installDemoVoice(await req.json())) },
      '/api/demo-settings/sample': {
        POST: async (req) => {
          if (!config) return notFound();
          const input = await req.json().catch(() => null);
          return config.sampleDemoVoice(input).then(
            (wav) => new Response(wav, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } }),
            (e) => handle(() => Promise.reject(e)),
          );
        },
      },
      // a demo's narration clip, in the voice Obeya holds loaded across renders (narration.ts)
      '/api/narration/clip': { POST: narration ? clipRoute(narration) : notFound },
      // „Für alle ins Repository übernehmen“: a repository's settings for this machine into its .obeya/settings.json
      '/api/config/share-settings': { POST: needs(config, async (c, req) => c.shareSettings(await req.json())) },
      // a repository's commands, new or changed on its default branch, confirmed by the owner: they count from now on
      '/api/config/trust': { POST: needs(config, async (c, req) => (c.trust(await req.json()), {})) },
      // what the configuration amounts to and what is wrong with it: as saved, or a draft as the owner edits it
      // „Erneut versuchen“: what did not start as the configuration has it tries again
      '/api/config/retry': { POST: needs(config, (c) => c.retry()) },
      '/api/config/check': {
        GET: needs(config, (c) => c.checkSaved()),
        POST: needs(config, async (c, req) => c.check(await req.json())),
      },
      '/api/c/:canvas/canvas': { GET: on((c) => c.board.snapshot()) },
      '/api/c/:canvas/cards': { POST: on(async (c, req) => c.board.create((await req.json()) as NewCard)) },
      // from "Konfiguration", for a repository without settings of its own: the card that writes them
      '/api/c/:canvas/adapter-setup': { POST: on(async (c, req) => c.adapterSetupCard(String(((await req.json()) as { repo?: unknown }).repo))) },
      // from the note on a plan directory: the card that prepares one of its docs as a project, started
      '/api/c/:canvas/prepare-plan-doc': {
        POST: on(async (c, req) => {
          const { repo, file } = ((await req.json()) ?? {}) as { repo?: unknown; file?: unknown };
          return c.preparePlanDoc(String(repo), String(file));
        }),
      },
      // the owner moved the note on a repository's plan directory
      '/api/c/:canvas/plan-dirs/:repo': {
        PATCH: on(async (c, req) => c.board.movePlanDirNote(req.params.repo!, await req.json())),
      },
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
      '/api/c/:canvas/cards/:id/restore': { POST: on((c, req) => c.restore(req.params.id!)) },
      '/api/c/:canvas/cards/:id/archive': { POST: on((c, req) => c.board.archive([req.params.id!])) },
      '/api/c/:canvas/cards/:id/unarchive': { POST: on((c, req) => c.board.unarchive(req.params.id!)) },
      // the archive, newest first; posting archives every finished card of the owner's
      '/api/c/:canvas/archive': { GET: on((c) => c.board.archived()), POST: on((c) => ({ ids: c.board.archiveDone() })) },
      '/api/c/:canvas/cards/:id/act': { POST: on(async (c, req) => c.press(req.params.id!, (await req.json()) as CardAction)) },
      // a script acting as the card's agent, in a scratch Obeya whose workers are idle (scripts/scratch-obeya.ts --say)
      '/api/c/:canvas/cards/:id/stand-in': { POST: on(async (c, req) => ({ result: await c.standIn(req.params.id!, (await req.json()) as Parameters<typeof c.standIn>[1]) })) },
      '/api/c/:canvas/cards/:id/events': { GET: on((c, req) => c.board.events(req.params.id!)) },
      // the skills the owner can ask the card's agent for by `/name`, for the field's menu
      '/api/c/:canvas/cards/:id/skills': { GET: on((c, req) => c.skillsOf(req.params.id!)) },
      // a screenshot for a message: uploaded first, the message then names it by id
      '/api/c/:canvas/images': {
        POST: on(async (c, req) => ({ id: c.images.save(new Uint8Array(await req.arrayBuffer()), req.headers.get('content-type') ?? '') })),
      },
      // a file of another kind for a message: Obeya keeps it, and the field gets its path (`?name`: what it was called)
      '/api/c/:canvas/files': {
        POST: on(async (c, req) => {
          if (Number(req.headers.get('content-length')) > MAX_FILE_BYTES) throw new BadRequest('fileTooLarge', `a file may have at most ${MAX_FILE_BYTES} bytes`);
          return { path: c.files.save(new Uint8Array(await req.arrayBuffer()), new URL(req.url).searchParams.get('name') ?? '') };
        }),
      },
      // a file of another kind dropped in a browser: where it lies on this machine, if Obeya finds exactly one that fits
      '/api/c/:canvas/files/find': {
        POST: on(async (_c, req) => ({ path: await findDropped((await req.json()) as Dropped) })),
      },
      // an image dropped in the app, which names it by its path: its bytes, for the page to attach it as a screenshot
      '/api/c/:canvas/files/local': {
        GET: on((_c, req) => {
          const image = localImage(new URL(req.url).searchParams.get('path') ?? '');
          if (!image) throw new BadRequest('imageType', 'no image on this machine');
          return new Response(Bun.file(image.file), { headers: { 'content-type': image.type, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' } });
        }),
      },
      '/api/c/:canvas/images/:file': {
        GET: (req) => {
          const file = byId.get(req.params.canvas)?.images.path(req.params.file);
          return file ? new Response(Bun.file(file), { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }) : notFound();
        },
      },
      // what the card's work changes: its files with lines added and removed, with `?full` the diff too
      '/api/c/:canvas/cards/:id/diff': { GET: on((c, req) => c.diff(req.params.id!, new URL(req.url).searchParams.has('full'))) },
      // the app running in the card's workspace: whether it answers, and the owner opening it to try it by hand
      '/api/c/:canvas/cards/:id/app': { GET: on((c, req) => c.appUp(req.params.id!)) },
      '/api/c/:canvas/cards/:id/app/open': {
        GET: async (req) => {
          const c = byId.get(req.params.canvas);
          if (!c) return notFound();
          let url: string | null = null;
          try {
            url = await c.openApp(req.params.id);
          } catch (e) {
            if (!(e instanceof BadRequest)) throw e;
          }
          return url ? Response.redirect(url, 302) : new Response(c.board.t.worker.appGone, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        },
      },
      '/api/c/:canvas/cards/:id/plan': { GET: on((c, req) => c.board.planDoc(req.params.id!)) },
      // a project's decisions and the idea it came from
      '/api/c/:canvas/cards/:id/history': { GET: on((c, req) => c.board.projectHistory(req.params.id!)) },
      // the frame an idea's mock is written into
      '/api/mock-frame': { GET: () => serveMockFrame() },
      // an HTML artifact's page may load files from folders beside it
      '/api/c/:canvas/cards/:id/demo/*': {
        GET: (req) => {
          try {
            const demo = byId.get(req.params.canvas)?.board.demoFiles(req.params.id);
            const file = decodeURIComponent(new URL(req.url).pathname.split('/demo/').slice(1).join('/demo/'));
            return demo ? serveDemoFile(demo, file, req) : notFound();
          } catch {
            return notFound();
          }
        },
      },
      // a demo a later handover replaced, which the owner went back to
      '/api/c/:canvas/cards/:id/demos/:n/*': {
        GET: (req) => {
          try {
            const n = Number(req.params.n);
            const demo = Number.isInteger(n) && n >= 0 ? byId.get(req.params.canvas)?.board.demoFiles(req.params.id, n) : null;
            const route = `/demos/${n}/`;
            const file = decodeURIComponent(new URL(req.url).pathname.split(route).slice(1).join(route));
            return demo ? serveDemoFile(demo, file, req, route) : notFound();
          } catch {
            return notFound();
          }
        },
      },
      // a file the card's work made or changed, for its left column; `?download` to save it
      '/api/c/:canvas/cards/:id/files/*': {
        GET: (req) => {
          try {
            const c = byId.get(req.params.canvas);
            const url = new URL(req.url);
            const file = decodeURIComponent(url.pathname.split('/files/').slice(1).join('/files/'));
            return c ? serveCardFile(file, url.searchParams.has('download'), req, (path) => c.cardFile(req.params.id, path)).catch(() => notFound()) : notFound();
          } catch {
            return notFound();
          }
        },
      },
      // opens a file of the card's work with the system's app (`show`: in its folder), on this machine only: from another device the browser downloads it
      '/api/c/:canvas/cards/:id/open': {
        POST: (req, srv) =>
          access.isLocal(req, srv)
            ? on(async (c, req) => {
                const { file, show } = (await req.json().catch(() => ({}))) as { file?: string; show?: boolean };
                if (typeof file !== 'string') throw new BadRequest('invalid', 'file must be a path');
                await c.openCardFile(req.params.id!, file, show === true);
              })(req)
            : onlyHere(),
      },
      // "Make it a card": a looked-up thread moves onto a Question card
      '/api/c/:canvas/threads/:thread/card': { POST: on((c, req) => c.answers.toCard(Number(req.params.thread))) },
      // a file a looked-up answer comes with; `?download` to save it
      '/api/c/:canvas/threads/:thread/files/*': {
        GET: (req) => {
          try {
            const c = byId.get(req.params.canvas);
            const url = new URL(req.url);
            const file = decodeURIComponent(url.pathname.split('/files/').slice(1).join('/files/'));
            return c ? serveAnswerFile(c.answerDir(Number(req.params.thread)), file, url.searchParams.has('download'), req) : notFound();
          } catch {
            return notFound();
          }
        },
      },
      // opens an answer's file (`file`), or its thread's directory, with the system's app
      '/api/c/:canvas/threads/:thread/open': {
        POST: (req, srv) =>
          access.isLocal(req, srv)
            ? on(async (c, req) => {
                const { file } = (await req.json().catch(() => ({}))) as { file?: string };
                await c.openAnswerFile(Number(req.params.thread), file);
              })(req)
            : onlyHere(),
      },
      // the app's shell, every few seconds while it has a newer version of the app ready
      '/api/app-update': {
        GET: () => Response.json(updates.current()),
        POST: async (req) =>
          handle(async () => {
            const body = await req.json();
            // a shell installed from a checkout has built itself anew there: in place as landed code is, so installed the same way, without asking
            if (body?.rebuilt === true) return (restarter?.request('update'), { updating: !!restarter });
            return updates.report(body);
          }),
      },
      // the Mac app's shell finds this Obeya running without the app that started it, so without the
      // system's permissions for it (the local network): it ends once the workers paused, and the shell
      // starts it again under itself (app/src/main.rs, `orphaned`)
      '/api/app-takeover': {
        POST: () =>
          handle(() => {
            // with no worker to wait for, this server ends right after the answer
            restarter?.request('takeover');
            return { taking: !!restarter };
          }),
      },
      // a shell installed from a checkout has built itself anew while this Obeya runs on without it (started
      // from a terminal), every few seconds until it starts again: it waits while the owner dictates or
      // watches a video, as a restart does; `kept`: whether the page handed over when the shell asked
      '/api/app-rebuilt': {
        POST: (req) =>
          handle(async () => {
            const { kept } = ((await req.json().catch(() => null)) ?? {}) as { kept?: unknown };
            return { now: !restarter?.owner().length, kept: handOver.has(kept) };
          }),
      },
      // what a reload keeps, from the page before the shell started again to the page after
      '/api/app-rebuilt/handover': {
        GET: () => Response.json(handOver.take()),
        POST: (req) => handle(async () => (handOver.give(await req.json()), { ok: true })),
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
      // new commits on the upstream of the checkout Obeya runs from
      '/api/source-update': { GET: () => Response.json(sources?.current() ?? null) },
      // the owner pulls them: a fast-forward of the checkout, after which the self-update restarts Obeya once the workers paused
      '/api/source-update/pull': { POST: needs(sources, async (s) => (await s.pull(), { source: s.current() })) },
      // a demo as a file to pass on, where the repository has no share target (`?as=zip|html`)
      '/api/c/:canvas/cards/:id/export': {
        GET: on(async (c, req) => {
          const as = new URL(req.url).searchParams.get('as');
          if (as !== 'zip' && as !== 'html') throw new BadRequest('invalid', 'as must be zip or html');
          // which of the card's demos, by its handover (`?demo=`); the latest without
          const demo = Number(new URL(req.url).searchParams.get('demo') ?? NaN);
          const f = await c.sharing.export(req.params.id!, as, Number.isInteger(demo) ? demo : undefined);
          return new Response(f.data, { headers: { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' } });
        }),
      },
      // what the owner said (audio), for the open card's agent or the Koordinator; the body is the
      // recording, or a form with it (`audio`) and the words typed in the field before it (`text`)
      '/api/c/:canvas/voice': {
        POST: on(holdingRestart(async (c, req) => {
          // screenshots shown with the recording (`?image=<id>`, repeated), checked before transcribing
          const params = new URL(req.url).searchParams;
          const images = params.getAll('image');
          c.images.resolve(images);
          // `?replyTo=<event>`: said in reply to that message of the open card's conversation; with
          // no card open, `?replyTo=<exchange>.<part>` to that message of the sheet (`TalkRef`)
          const replyTo = replyParam(params.get('replyTo'));
          const form = req.headers.get('content-type')?.startsWith('multipart/form-data') ? await req.formData() : null;
          const audio = form ? form.get('audio') : await req.blob();
          if (!(audio instanceof Blob)) throw new BadRequest('invalid', 'audio expected');
          arrive(params.get('sent'));
          // a browser sends a form's line breaks as CRLF: they go on as typed
          const field = form?.get('text');
          const typed = typeof field === 'string' ? field.replace(/\r\n/g, '\n') : undefined;
          let text: string | null;
          try {
            text = await transcribe(c, audio);
          } catch (e) {
            // the cloud service failed or refused: the owner reads why under the mic, and the words stay in the field
            if (!(e instanceof CloudError)) throw e;
            console.error(`voice on ${c.id}: ${e.service} failed: ${e.message}`);
            return { confirm: c.board.t.voice.cloudFailed(e.service, e.message), unheard: true };
          }
          // `?listen`: dictated into a field, the words go back to it and nowhere else
          if (params.has('listen')) {
            console.log(`dictated on ${c.id}: ${text === null ? '(not understood)' : text || '(nothing)'}`);
            return text ? { confirm: '', quiet: true, text } : unheard(c, text);
          }
          // what stood in the field goes first; nothing heard sends nothing, the field keeps it
          const words = text && typed?.trim() ? `${typed.trim()}${/\n/.test(typed.trim()) ? '\n\n' : ' '}${text}` : text;
          // `?at=<seconds>&still=<image>&demo=<handover>`: said about that place in the open card's demo video (`demo`: an earlier one)
          const at = params.get('at');
          const demo = Number(params.get('demo') || NaN);
          const spot = at !== null && at !== '' ? { at: Number(at), ...(params.get('still') ? { still: params.get('still')! } : {}), ...(Number.isInteger(demo) ? { demo } : {}) } : undefined;
          return heard(c, words, focusOf(req, c), images, { ...(replyTo ? { replyTo } : {}), ...(spot ? { spot } : {}) });
        })),
      },
      // the owner started speaking: transcription and the Koordinator get ready meanwhile
      // whether the recording the page named `?sent=<id>` arrived, for a page that lost the answer
      '/api/c/:canvas/voice/arrived/:id': { GET: on((_c, req) => ({ arrived: arrived.has(req.params.id!) })) },
      '/api/c/:canvas/voice/warm': {
        POST: on((c) => {
          transcriber.warm?.();
          c.commander.warm();
        }),
      },
      '/api/c/:canvas/command': {
        POST: on(async (c, req) => {
          // `field`: typed into that field of the open card rather than into the Koordinator's sheet
          // `replyTo`: typed in reply to that message of the open card's conversation, or with no card open of the sheet (`TalkRef`)
          // `spot`: typed about that place in the open card's demo video
          const { text, images, field, replyTo, spot } = (await req.json()) as { text: string; images?: string[]; field?: unknown; replyTo?: unknown; spot?: SpotInput };
          // a screenshot alone may speak for itself to the open card's agent
          const card = focusOf(req).card;
          const open = card ? c.board.item(card) : undefined;
          const toAgent = !!open && listens(open, isField(field) ? { field } : {});
          if (typeof text !== 'string' || (!text.trim() && !(toAgent && images?.length))) throw new BadRequest('emptyText', 'text must be a non-empty string');
          // screenshots pasted into the typed command go to the cards it creates or concerns
          c.images.resolve(images);
          return heard(c, text.trim(), focusOf(req, c), images ?? [], { typed: true, ...(isField(field) ? { field } : {}), ...(typeof replyTo === 'number' || isTalkRef(replyTo) ? { replyTo } : {}), ...(spot ? { spot } : {}) });
        }),
      },
      // a wish or a bug for Obeya's makers: the issue's text as a small job writes it, for the owner to check and open on GitHub
      '/api/c/:canvas/wish': {
        POST: on(async (c, req) => {
          const { said, answer, title, body, images, app } = ((await req.json()) ?? {}) as Record<string, unknown>;
          if (typeof said !== 'string' || !said.trim()) throw new BadRequest('emptyText', 'said must be a non-empty string');
          const ids = Array.isArray(images) ? images.filter((i): i is string => typeof i === 'string') : [];
          const server = config?.view().server;
          return c.writeWish(
            { said, ...(typeof answer === 'string' ? { answer } : {}), ...(typeof title === 'string' ? { title } : {}), ...(typeof body === 'string' ? { body } : {}) },
            footerOf(server?.version ?? VERSION, server?.commit ?? null, app === true),
            ids,
          );
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
      // a value for a repository's setting the Arbeitsrückschau proposed: taken on this machine or for everyone (`where`), or rejected
      '/api/c/:canvas/setting-proposals/:id/take': {
        POST: on(async (c, req) => {
          const { where, value } = (await req.json().catch(() => ({}))) as { where?: unknown; value?: unknown };
          return click(c, (await c.takeSetting(Number(req.params.id), where, value)) ?? {});
        }),
      },
      '/api/c/:canvas/setting-proposals/:id/reject': { POST: on((c, req) => click(c, c.rejectSetting(Number(req.params.id)))) },
      // "Erneut teilen" for many outdated pages at once (or, with `tags`, the pages without tags): `count` of them, the newest demos first, or all (null)
      '/api/c/:canvas/reshare': {
        POST: on(async (c, req) => {
          const { count, tags } = (await req.json().catch(() => ({}))) as { count?: number | null; tags?: unknown };
          if (count != null && !(Number.isInteger(count) && count > 0)) throw new BadRequest('invalid', 'count must be a positive integer or null');
          // `tags`: the pages without tags, tagged and shared again („N Seiten ohne Tags“)
          c.sharing.reshareMany(count ?? null, tags === true);
        }),
        // "Ausblenden": puts away what the finished run says, and the notice of outdated pages until a newer change
        DELETE: on((c) => c.sharing.dismissResharing()),
      },
      '/api/c/:canvas/reshare/stop': { POST: on((c) => c.sharing.stopResharing()) },
      // the card's latest demo was narrated anew in its directory (the demo skill's `--revoice`)
      '/api/c/:canvas/cards/:id/demo-rebuilt': { POST: on((c, req) => c.sharing.rebuilt(req.params.id!)) },
      // the owner has the Koordinator's sheet in view: the answers waiting there are read; with `ids`, those a project's sheet shows
      '/api/c/:canvas/talk/read': {
        POST: on(async (c, req) => {
          const { ids } = (await req.json().catch(() => ({}))) as { ids?: unknown };
          if (ids !== undefined && !(Array.isArray(ids) && ids.every((i) => Number.isInteger(i)))) throw new BadRequest('invalid', 'ids must be a list of exchange ids');
          c.board.readTalk(ids as number[] | undefined);
        }),
      },
      // the owner no longer wants the step the Koordinator waits on a card for („Nicht mehr warten“)
      '/api/c/:canvas/talk/:id/unwait': {
        POST: on(async (c, req) => ({ stopped: c.commander.unwait(Number(req.params.id), String(((await req.json().catch(() => ({}))) as { card?: unknown }).card ?? '')) })),
      },
      '/api/c/:canvas/ws': (req, server) =>
        byId.has(req.params.canvas) && server.upgrade(req, { data: { canvas: req.params.canvas, page: crypto.randomUUID(), device: access.deviceOf(req) } })
          ? undefined
          : new Response('WebSocket expected', { status: 400 }),
    }, access),
    fetch: (req: Request, srv: Bun.Server<Socket>) => refusal(req, access.hosts()) ?? access.admit(req, srv, '') ?? notFound(),
    websocket: {
      data: {} as Socket,
      open: (ws: ServerWebSocket<Socket>) => {
        const c = byId.get(ws.data.canvas);
        if (!c) return ws.close();
        sockets.get(c.id)!.add(ws);
        ws.send(JSON.stringify({ type: 'hello', server: started, ...(oldLinuxBun() ? { oldBun: Bun.version } : {}) } satisfies ServerMessage));
        // what the bar shows comes before the snapshot, which draws the bar: it is there from the first frame
        ws.send(JSON.stringify({ type: 'restart', restart: pending(c.id) } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'update', update: updates.current() } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'source', source: sources?.current() ?? null } satisfies ServerMessage));
        ws.send(JSON.stringify({ type: 'usage', usage: usage?.current() ?? null } satisfies ServerMessage));
        if (usage) unwatch.set(ws.data.page, usage.watch());
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: c.board.snapshot() } satisfies ServerMessage));
        ws.send(waitingMessage());
        // a page that reloads within a command's undo window offers "Rückgängig" again
        for (const n of c.commander.undoable()) ws.send(JSON.stringify({ type: 'notice', ...n } satisfies ServerMessage));
      },
      close: (ws: ServerWebSocket<Socket>) => {
        sockets.get(ws.data.canvas)?.delete(ws);
        unwatch.get(ws.data.page)?.();
        unwatch.delete(ws.data.page);
        restarter?.hold(ws.data.page);
        // a phone's last page closed: it no longer holds pushes off
        const { device } = ws.data;
        if (device && ![...sockets.values()].some((set) => [...set].some((w) => w.data.device === device))) push.away(device);
      },
      // the owner watching a demo video or dictating in this page holds a restart off
      message: (ws: ServerWebSocket<Socket>, text: string | Buffer) => {
        try {
          const msg = JSON.parse(String(text)) as ClientMessage;
          if (msg.type === 'hold' && Array.isArray(msg.hold)) restarter?.hold(ws.data.page, msg.hold.filter((h) => h === 'video' || h === 'voice'));
          if (msg.type === 'back') byId.get(ws.data.canvas)?.ownerBack();
          // back from the terminal, say, where the owner committed what stood in the way of a pull, or pulled
          if (msg.type === 'back') void sources?.check(false);
          // the owner uses a page at the machine or on their phone: what starts waiting meanwhile is not pushed
          const { device } = ws.data;
          if (msg.type === 'back' || msg.type === 'here') device ? push.onDevice(device) : push.here();
          if (msg.type === 'away' && device) push.away(device);
          if (msg.type === 'stall') {
            const stall = pageStall(msg);
            const { device } = ws.data;
            const where = `${device ? (access.devices().find((d) => d.id === device)?.name ?? 'another device') : 'this machine'}, canvas ${ws.data.canvas}`;
            if (stall) stalls?.page(stall, where, ws.data.page);
          }
          if (msg.type === 'focus') {
            const seen = parsePlace(typeof msg.place === 'string' ? msg.place : undefined);
            const c = byId.get(ws.data.canvas);
            if (seen && c) c.inView = seen;
          }
        } catch {}
      },
    },
  };
  const server = Bun.serve(options);
  serving(server, access.owner);
  // another VPN's address: the same routes there too, in plain HTTP
  let other: Bun.Server<Socket> | null = null;
  void access
    .start(server.port!, (address) => {
      other?.stop(true);
      other = address ? Bun.serve({ ...options, hostname: address, port: server.port! }) : null;
    })
    .then(() => {
      const address = access.address();
      if (address) console.log(`Obeya: other devices reach it at ${address}`);
    });
  return server;
}

/** Pushes go to a paired device: the machine Obeya runs on gets none. */
const onlyDevices = () => Response.json({ code: 'onlyDevices', error: 'only a paired device gets pushes' }, { status: 403 });

const onlyHere = () => Response.json({ code: 'onlyHere', error: 'only on the machine Obeya runs on' }, { status: 403 });
