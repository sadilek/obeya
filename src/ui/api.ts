import { useEffect, useState } from 'react';
import type { PushKeyView } from '../core/push-key';
import type { AgentRole, AgentSetting, AgentsView, CanvasConfig, CanvasInfo, CanvasSnapshot, ClientMessage, ConfigView, CardAction, DemoSettings, Group, DemoSettingsView, DemoVoiceCheck, FirstCanvas, MachineItem, MachineSectionId, MachineView, SetupCheck, VoiceSetupView, CardEvent, CardPatch, Item, Language, LanguageView, NewCard, Notice, OwnerHold, PendingRestart, ProjectHistory, ServerMessage, AppUpdate } from '../core/types';

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
  await refused(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Throws the server's refusal as an ApiError. */
async function refused(res: Response) {
  if (res.ok) return;
  const body = await res.text();
  let code: string | undefined;
  let detail = body;
  try {
    ({ code, error: detail = body } = JSON.parse(body));
  } catch {}
  throw new ApiError(code, detail || `HTTP ${res.status}`);
}

/** Saves a file the server makes, under the name it gives. */
async function download(path: string, fallback: string) {
  const res = await fetch(path);
  await refused(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
/** The field on a card words were typed into, which tells the Koordinator what they were meant as. */
export type Field = 'note' | 'answer' | 'feedback' | 'demo' | 'discuss' | 'revise';
type HeardReply = { confirm: string; token?: string; undoMs?: number; quiet?: boolean; unheard?: boolean };

export const api = {
  canvases: () => call<CanvasInfo[]>('GET', '/api/canvases'),
  /** Obeya's configuration, for all canvases. */
  config: () => call<ConfigView>('GET', '/api/config'),
  checkConfig: (canvases: CanvasConfig[]) => call<Pick<ConfigView, 'canvases' | 'resolved' | 'problems'>>('POST', '/api/config/check', canvases),
  /** Saves it; Obeya then starts again with it where something restarts it. */
  saveConfig: (canvases: CanvasConfig[]) => call<{ restarting: boolean }>('PUT', '/api/config', canvases),
  /** The language Obeya speaks to the owner: chosen, or the system's. */
  language: () => call<LanguageView>('GET', '/api/language'),
  /** The push-to-talk key in another app, and the app's shell that hears it. */
  pushKey: () => call<PushKeyView>('GET', '/api/push-to-talk'),
  savePushKey: (key: string | null) => call<PushKeyView>('PUT', '/api/push-to-talk', { key }),
  /** Saves the owner's choice; `null` follows the system again. */
  saveLanguage: (language: Language | null) => call<LanguageView>('PUT', '/api/language', { language }),
  /** The model and effort of each group of agents. */
  agents: () => call<AgentsView>('GET', '/api/agents'),
  /** Saves the model or the effort of one group. */
  saveAgents: (role: AgentRole, choice: Partial<AgentSetting>) => call<AgentsView>('PUT', '/api/agents', { [role]: choice }),
  /** The setup assistant's list: what Obeya needs on this machine. */
  setup: () => call<MachineView>('GET', '/api/setup'),
  setupInstall: (section: MachineSectionId, id: MachineItem['id']) => call<MachineView>('POST', '/api/setup/install', { section, id }),
  /** Opens a terminal that logs in; `opened: false` where Obeya found none. */
  setupLogin: (section: MachineSectionId, id: MachineItem['id']) => call<{ opened: boolean }>('POST', '/api/setup/login', { section, id }),
  setupIdentity: (name: string, email: string) => call<MachineView>('POST', '/api/setup/identity', { name, email }),
  /** A folder from the system's dialog; null when cancelled. */
  setupPick: (prompt: string) => call<{ path: string | null }>('POST', '/api/setup/pick', { prompt }),
  /** The first canvas from a folder (saved at once) or a clone (the view follows it). */
  setupCanvas: (input: { path: string } | { clone: string; into: string }) => call<FirstCanvas | MachineView>('POST', '/api/setup/canvas', input),
  voiceSetup: () => call<VoiceSetupView>('GET', '/api/voice-setup'),
  installVoice: () => call<VoiceSetupView>('POST', '/api/voice-setup/install'),
  demoSettings: () => call<DemoSettingsView>('GET', '/api/demo-settings'),
  saveDemoSettings: (settings: DemoSettings) => call<DemoSettingsView>('PUT', '/api/demo-settings', settings),
  checkDemoVoice: (settings: DemoSettings) => call<DemoVoiceCheck>('POST', '/api/demo-settings/check', settings),
  demoSetup: (settings: DemoSettings) => call<SetupCheck>('POST', '/api/demo-settings/setup', settings),
  installDemoVoice: (settings: DemoSettings) => call<DemoSettingsView>('POST', '/api/demo-settings/install', settings),
  /** One sentence in the voice, as a WAV to play. */
  async demoVoiceSample(settings: DemoSettings): Promise<Blob> {
    const res = await fetch('/api/demo-settings/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
    await refused(res);
    return res.blob();
  },
  /** Has a restart that waits for workers go ahead now; false when none waits. */
  restartNow: () => call<{ restarting: boolean }>('POST', '/api/restart'),
  /** Installs the newer version of the app once the workers paused, as a restart waits for them. */
  installUpdate: () => call<{ updating: boolean }>('POST', '/api/app-update/install'),
  create: (c: NewCard) => call<Item>('POST', at('/cards'), c),
  /** The card that writes a repository's own adapter, on the canvas it belongs to (not necessarily the shown one). */
  adapterSetup: (canvas: string, repo: string) => call<Item>('POST', `/api/c/${encodeURIComponent(canvas)}/adapter-setup`, { repo }),
  /** Downloads a card's demo as a ZIP of its page with the files, or as one HTML file. */
  exportDemo: (id: string, as: 'zip' | 'html') => download(at(`/cards/${id}/export?as=${as}`), `demo.${as}`),
  /** The size of a card's demo video in bytes; null when unknown. */
  demoSize: async (id: string) => {
    const res = await fetch(at(`/cards/${id}/demo/demo.mp4`), { headers: { range: 'bytes=0-0' } });
    await res.body?.cancel();
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    return res.ok && total > 0 ? total : null;
  },
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
  /** A new group with the cards in it; a name a group has already puts them into that one. */
  createGroup: (name: string, cards: string[], hue?: number) => call<Group>('POST', at('/groups'), { name, cards, hue }),
  /** Ends the group: its cards belong to none. Returns what brings it back. */
  deleteGroup: (id: string) => call<{ group: Group; cards: string[] }>('DELETE', at(`/groups/${id}`)),
  /** Puts the cards into the group, or with `null` into none. */
  assign: (cards: string[], group: string | null) => call<void>('POST', at('/assign'), { cards, group }),
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
  /** A project's decisions and the idea it came from. */
  history: (id: string) => call<ProjectHistory>('GET', at(`/cards/${id}/history`)),
  /** What the owner said about the card or project in view, with the screenshots shown with it. */
  voice: async (audio: Blob, where: Where, images: string[] = []) => {
    const q = images.map((id) => `image=${encodeURIComponent(id)}`).join('&');
    const res = await fetch(at(`/voice${query(where)}${q && (where ? '&' : '?')}${q}`), { method: 'POST', body: audio });
    if (!res.ok) throw new Error(`voice: ${res.status}`);
    return (await res.json()) as HeardReply;
  },
  /** The owner started speaking (or typing a command): Obeya gets ready to read it. */
  warmVoice: () => fetch(at('/voice/warm'), { method: 'POST' }).catch(() => {}),
  /** The same, typed; `field`: the field of the open card it was typed into. */
  command: (text: string, where: Where, images?: string[], field?: Field) =>
    call<HeardReply>('POST', at(`/command${query(where)}`), { text, ...(images?.length ? { images } : {}), ...(field ? { field } : {}) }),
  /** A typed request to the Koordinator of another canvas, about nothing in view there. */
  commandOn: (canvas: string, text: string) => call<HeardReply>('POST', `/api/c/${encodeURIComponent(canvas)}/command`, { text }),
  undo: (token: string) => call<{ undone: boolean }>('POST', at('/command/undo'), { token }),
  /** A rule of the owner's, active at once, or with `target` one for that repository's CLAUDE.md. */
  addPreference: (text: string, target?: string) => call<void>('POST', at('/preferences'), { text, ...(target ? { target } : {}) }),
  /** Changes a preference, or deletes it with `null`. */
  setPreference: (id: number, text: string | null) =>
    text === null ? call<void>('DELETE', at(`/preferences/${id}`)) : call<void>('PATCH', at(`/preferences/${id}`), { text }),
  /** Accepts a proposed rule, in the owner's words and for the place they chose (a repository, `null` for the preferences) when they changed these. */
  acceptProposal: (id: number, text?: string, target?: string | null) =>
    call<void>('POST', at(`/preferences/${id}/accept`), { ...(text === undefined ? {} : { text }), ...(target === undefined ? {} : { target }) }),
  rejectProposal: (id: number) => call<void>('POST', at(`/preferences/${id}/reject`)),
  /** Shares outdated pages again, the newest demos first: `count` of them, or all with null. */
  reshare: (count: number | null) => call<void>('POST', at('/reshare'), { count }),
  stopReshare: () => call<void>('POST', at('/reshare/stop')),
  /** Puts away what the finished run says. */
  dismissReshare: () => call<void>('DELETE', at('/reshare')),
  /** The owner has the Koordinator's sheet in view: the answers waiting there are read. */
  readTalk: () => call<void>('POST', at('/talk/read')),
};

// Log lines arrive over the canvas's WebSocket; whoever shows a card's log listens here.
const eventListeners = new Set<(e: CardEvent) => void>();
export function onCardEvent(fn: (e: CardEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// What Obeya tells the owner without a command of theirs to answer (an answer looked up, what a
// request an agent passed on came to): it shows above the microphone, with "Rückgängig" while actions wait.
const noticeListeners = new Set<(n: Notice) => void>();
export function onNotice(fn: (n: Notice) => void): () => void {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
}

// What the owner does in this page that a restart would cut off, by who holds it (the demo video,
// push-to-talk); the server hears every change, and again after a reconnect.
const holds = new Map<string, OwnerHold>();
let socket: WebSocket | null = null;
const sendHolds = () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'hold', hold: [...new Set(holds.values())] } satisfies ClientMessage));
};
/** Holds a due restart off while the owner watches (`video`) or dictates (`voice`); `null` lets go. */
export function holdRestart(by: string, what: OwnerHold | null) {
  if ((holds.get(by) ?? null) === what) return;
  if (what) holds.set(by, what);
  else holds.delete(by);
  sendHolds();
}

// What the owner has in view, for a command from the app's push-to-talk key in another app: the
// server hears every change, again after a reconnect, and when the page gets the focus back, so
// the page the owner looked at last wins.
let focusMessage: Extract<ClientMessage, { type: 'focus' }> | null = null;
const sendFocus = () => {
  if (focusMessage && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(focusMessage));
};
export function reportFocus(where: Where, target: string, title?: string) {
  focusMessage = { type: 'focus', ...(where ?? {}), target, ...(title ? { title } : {}) };
  sendFocus();
}

// Whoever has something to keep across the reload a restart brings writes it down here first.
const reloadListeners = new Set<() => void>();
export function beforeReload(fn: () => void): () => void {
  reloadListeners.add(fn);
  return () => reloadListeners.delete(fn);
}

/** Loads the page again, keeping what is open, as after a restart. */
export function reload() {
  for (const fn of reloadListeners) fn();
  location.reload();
}

/**
 * The live canvas: the server pushes a snapshot on connect and after every change, the restart that
 * waits, the newer version of the app there is, and how many cards on each canvas need the owner.
 */
export function useCanvas(): { snapshot: CanvasSnapshot | null; online: boolean; restart: PendingRestart | null; update: AppUpdate | null; waiting: Record<string, number> } {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [restart, setRestart] = useState<PendingRestart | null>(null);
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 500;
    let closed = false;
    let server: string | undefined;
    const connect = () => {
      ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${at('/ws')}`);
      ws.onopen = () => {
        setOnline(true);
        delay = 500;
        sendHolds();
        sendFocus();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        // a new server process may run new code: the page loads it, and keeps what was open
        if (msg.type === 'hello') {
          if (server && server !== msg.server) reload();
          server = msg.server;
        } else if (msg.type === 'snapshot') setSnapshot(msg.snapshot);
        else if (msg.type === 'restart') setRestart(msg.restart);
        else if (msg.type === 'update') setUpdate(msg.update);
        else if (msg.type === 'waiting') setWaiting(msg.waiting);
        else if (msg.type === 'event') for (const fn of eventListeners) fn(msg.event);
        else if (msg.type === 'notice') for (const fn of noticeListeners) fn(msg);
      };
      ws.onclose = () => {
        if (closed) return;
        setOnline(false);
        // a canvas the configuration no longer has: the page goes to the first one there is
        api.canvases().then((list) => list.some((c) => c.id === canvasId) || location.replace(location.pathname), () => {});
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    // back from GitHub, say: the server looks at the pull requests now instead of at its next round
    const back = () => {
      if (document.visibilityState === 'visible' && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'back' } satisfies ClientMessage));
      sendFocus();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      ws.close();
    };
  }, []);
  return { snapshot, online, restart, update, waiting };
}
