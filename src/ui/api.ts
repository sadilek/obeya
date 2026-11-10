import { useEffect, useState } from 'react';
import type { CardDiff } from '../core/diff';
import { type Place, placeParam } from '../core/layout';
import type { AccessView, ArchivePage, Pairing, RemoteSetting, AgentRole, AgentSetting, Harness, CloudPreset, AgentsView, CanvasConfig, CanvasInfo, CanvasSnapshot, ClientMessage, ConfigSaved, ConfigView, CardAction, ConfigChecked, DemoSettings, Group, DemoSettingsView, DemoVoiceCheck, PersonalSiteView, SiteSetupJob, TagProposalJob, PageTags, NarrationLanguage, FirstCanvas, GitSetupPreview, MachineItem, MachineSectionId, MachineView, SetupCheck, SetupFolder, VoiceSetupView, CardEvent, CardPatch, CostsView, Item, Language, LanguageView, NewCard, Notice, OwnerHold, PendingRestart, ProjectHistory, RepoTrust, ServerMessage, SettingsShared, Skill, SourceUpdate, SpotInput, TalkRef, AppUpdate, Theme, ThemeView, Usage, UsageMeterView, Waiting } from '../core/types';
import { setCostsShown } from './costs';
import type { Wish } from '../core/wish';
import { INPUT, noteMessage, watchPageStalls } from './stalls';

/** A request the server refused; `code` picks the owner's text, the message is the server's detail. */
export class ApiError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, keepalive?: boolean): Promise<T> {
  const res = await send(method, path, body, keepalive);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The request, with `body` as JSON; throws the server's refusal. With `keepalive`, it outlasts the page. */
async function send(method: string, path: string, body?: unknown, keepalive?: boolean) {
  const res = await fetch(path, {
    method,
    keepalive,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await refused(res);
  return res;
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
/** The page runs as the app on a phone's home screen, not in its browser. */
export const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** A path in the shown canvas's API. */
export const at = (path: string) => `/api/c/${encodeURIComponent(canvasId)}${path}`;
/**
 * The canvas each card is on, where the page shows the cards of several (the phone view). A call
 * about a card goes to its canvas even once another is in view: the card closing puts Obeya's in
 * view before the card's last calls (its held comments released, say) go out.
 */
const canvasOfCard = new Map<string, string>();
export function cardsOn(canvas: string, cards: string[]) {
  for (const id of cards) canvasOfCard.set(id, canvas);
}
/** The canvas of the card `id`: the one it is on where the page shows several, else the shown one. */
export const canvasOf = (id: string) => canvasOfCard.get(id) ?? canvasId;
/** A path in the API of the card's canvas, about the card or project `id`. */
export const cardAt = (id: string, path = '') => `/api/c/${encodeURIComponent(canvasOf(id))}/cards/${id}${path}`;
/** A path in the API of the canvas of what the words are about, else of the shown one. */
const whereAt = (where: Where, path: string) => {
  const id = where && ('card' in where ? where.card : where.project);
  return id ? `/api/c/${encodeURIComponent(canvasOf(id))}${path}` : at(path);
};
/** Where a looked-up answer's file is served; `download` to save it. */
export const answerFile = (thread: number, name: string, download = false) =>
  at(`/threads/${thread}/files/${name.split('/').map(encodeURIComponent).join('/')}${download ? '?download' : ''}`);

/** Where a file of a card's work is served (its left column's tabs); `download` to save it. */
export const cardFile = (id: string, path: string, download = false) =>
  cardAt(id, `/files/${path.split('/').map(encodeURIComponent).join('/')}${download ? '?download' : ''}`);

/** What a command is said about: the open card, the open project, or neither. */
export type Where = { card: string } | { project: string } | null;
/** The field on a card words were typed into, which tells the Coordinator what they were meant as. */
export type Field = 'note' | 'answer' | 'feedback' | 'demo' | 'discuss' | 'revise';

/** What Obeya made of a command. */
export interface Heard {
  confirm: string;
  token?: string;
  /** How long the command still waits for "Undo". */
  undoMs?: number;
  /** Said to the open card's agent: the card shows it, so there is nothing to confirm. */
  quiet?: boolean;
  /** Nothing was heard: the screenshots shown with it wait for the next recording. */
  unheard?: boolean;
  /** The words heard. */
  text?: string;
  /** The owner asked to tell Obeya's makers something: the draft for them opens with it. */
  wish?: Wish;
  /** The exchange the reply stands in, which the conversation in view may show already. */
  talk?: number;
  /** The project whose sheet shows that exchange too. */
  project?: string;
  /** The card whose conversation shows the reply in full. */
  inCard?: string;
}
/** How long "Undo" shows: until shortly before the command stops waiting. */
export const undoShownMs = (undoMs: number) => Math.max(0, undoMs - 400);
/** How long a confirmation stays above the microphone: 7 s, unless its undo window is longer. */
export const confirmShownMs = (undoMs = 0) => Math.max(7000, undoMs + 1500);

/**
 * How a new site is set up at its host: in the Cloudflare account of a site this machine deploys to
 * (`account`, by site), with another account's API token, or (neither) with the machine's own login;
 * at GitHub in a public repository (`public`) or a private one.
 */
export interface SiteHow {
  account?: string;
  token?: string;
  accountId?: string;
  public?: true;
}

export const api = {
  canvases: () => call<CanvasInfo[]>('GET', '/api/canvases'),
  /** The canvas `id` as it is now, for a switch to it before its own connection is open. */
  canvasOf: (id: string) => call<CanvasSnapshot>('GET', `/api/c/${encodeURIComponent(id)}/canvas`),
  /** Obeya's configuration, for all canvases. */
  config: () => call<ConfigView>('GET', '/api/config'),
  /** What the configuration as saved amounts to, and what is wrong with it: it reads every repository, so it comes after `config`. */
  configCheck: () => call<ConfigChecked>('GET', '/api/config/check'),
  checkConfig: (canvases: CanvasConfig[]) => call<ConfigChecked>('POST', '/api/config/check', canvases),
  retryStart: () => call<{}>('POST', '/api/config/retry'),
  /** Saves it; Obeya then starts again with it where something restarts it. */
  saveConfig: (canvases: CanvasConfig[]) => call<ConfigSaved>('PUT', '/api/config', canvases),
  /** "Take over into the repository for everyone": the repository's settings for this machine into its `.obeya/settings.json`. */
  shareSettings: (path: string, direct = false) => call<SettingsShared>('POST', '/api/config/share-settings', { path, direct }),
  /** The owner confirms the repository's commands the dialog showed them (the groups `held` of `now`): they count from now on. */
  trustCommands: (path: string, trust: RepoTrust) => call<object>('POST', '/api/config/trust', { path, seen: trust.now, held: trust.held }),
  /** The interface language (chosen, or the system's) and the conversation language (chosen, or the interface's). */
  language: () => call<LanguageView>('GET', '/api/language'),
  /** Saves the owner's choice; `null` follows the system again. */
  saveLanguage: (language: Language | null) => call<LanguageView>('PUT', '/api/language', { language }),
  /** The language agents write the owner in until the owner's words say otherwise; `null` follows the interface's. */
  saveConversationLanguage: (conversation: Language | null) => call<LanguageView>('PUT', '/api/language', { conversation }),
  /** Light or dark as the owner chose, or `null` for the system's. */
  theme: () => call<ThemeView>('GET', '/api/theme'),
  // other devices reaching Obeya: the section "Other devices" and "Connect a phone"
  access: () => call<AccessView | { local: false; tailnet: boolean }>('GET', '/api/access'),
  saveAccess: (remote: RemoteSetting | null) => call<AccessView>('PUT', '/api/access', { remote }),
  pair: () => call<Pairing>('POST', '/api/access/pair'),
  removeDevice: (id: string) => call<{ removed: boolean }>('DELETE', `/api/access/devices/${encodeURIComponent(id)}`),
  /** Obeya's key for pushes, and whether this device gets them. */
  push: () => call<{ key: string; on: boolean }>('GET', '/api/push'),
  subscribe: (subscription: PushSubscriptionJSON) => call<void>('PUT', '/api/push', subscription),
  saveTheme: (theme: Theme | null) => call<ThemeView>('PUT', '/api/theme', { theme }),
  /** Whether the bar shows the plan's usage limits. */
  usageMeter: () => call<UsageMeterView>('GET', '/api/usage-meter'),
  saveUsageMeter: (on: boolean) => call<UsageMeterView>('PUT', '/api/usage-meter', { on }),
  costs: () => call<CostsView>('GET', '/api/costs'),
  saveCosts: (on: boolean) => call<CostsView>('PUT', '/api/costs', { on }),
  /** The model and effort of each group of agents. */
  agents: () => call<AgentsView>('GET', '/api/agents'),
  /** Saves the model or the effort of one group. */
  saveAgents: (role: AgentRole, choice: Partial<AgentSetting>) => call<AgentsView>('PUT', '/api/agents', { [role]: choice }),
  /** Updates Claude Code in the background, here or on the host named; the view says how far it got. */
  updateHarness: (harness: Harness, host?: string) => call<AgentsView>('POST', '/api/agents/update', host === undefined ? { harness } : { harness, host }),
  /** The setup assistant's list: what Obeya needs on this machine. */
  setup: () => call<MachineView>('GET', '/api/setup'),
  setupInstall: (section: MachineSectionId, id: MachineItem['id']) => call<MachineView>('POST', '/api/setup/install', { section, id }),
  /** Opens a terminal that logs in (`token`: Claude's `claude setup-token`); `opened: false` where Obeya found none. */
  setupLogin: (section: MachineSectionId, id: MachineItem['id'], token?: boolean) => call<{ opened: boolean; command: string }>('POST', '/api/setup/login', { section, id, ...(token ? { token } : {}) }),
  /** Starts a login to Codex here or on a host (`host`): the sign-in page for the browser, and the id to follow it by. */
  codexLogin: (host: string | null) => call<{ id: string; url: string }>('POST', '/api/setup/codex-login', { host }),
  codexLoginState: (id: string) => call<{ state: 'waiting' | 'done' | 'failed'; error?: string }>('GET', `/api/setup/codex-login?id=${encodeURIComponent(id)}`),
  /** The token from `claude setup-token`, for the sessions that run on a token. */
  setupToken: (token: string) => call<{ saved: true }>('POST', '/api/setup/token', { token }),
  setupIdentity: (name: string, email: string) => call<MachineView>('POST', '/api/setup/identity', { name, email }),
  /** Whether the system's folder dialog is offered to this browser: the machine has one, and the browser runs on it. */
  setupPicker: () => call<{ picker: boolean }>('GET', '/api/setup/pick'),
  /** A folder from the system's dialog; null when cancelled. */
  setupPick: (prompt: string) => call<{ path: string | null }>('POST', '/api/setup/pick', { prompt }),
  /** The first canvas from a folder (saved at once) or a clone (the view follows it). */
  setupFolder: (path: string) => call<SetupFolder>('POST', '/api/setup/folder', { path }),
  setupGitPreview: (path: string) => call<GitSetupPreview>('POST', '/api/setup/git-preview', { path }),
  setupGit: (path: string) => call<{ branch: string }>('POST', '/api/setup/git', { path }),
  setupCanvas: (input: { path: string; git?: false } | { clone: string; into: string }) => call<FirstCanvas | MachineView>('POST', '/api/setup/canvas', input),
  voiceSetup: () => call<VoiceSetupView>('GET', '/api/voice-setup'),
  installVoice: () => call<VoiceSetupView>('POST', '/api/voice-setup/install'),
  measureVoice: () => call<VoiceSetupView>('POST', '/api/voice-setup/measure'),
  /** Tests a cloud service with the check's sentence and hears through it from then on; a key left out keeps the saved one. */
  useCloudVoice: (service: { preset: CloudPreset; baseUrl?: string; model?: string; key?: string }) => call<VoiceSetupView>('PUT', '/api/voice-setup/cloud', service),
  useLocalVoice: () => call<VoiceSetupView>('DELETE', '/api/voice-setup/cloud'),
  /** The owner's personal demo site on this machine: set up at a host, connected by code, removed; repositories ticked for it (private ones, those that share with the approval). */
  personalSite: () => call<PersonalSiteView>('GET', '/api/personal-site'),
  setUpPersonalSite: (host: 'cloudflare' | 'github', how: SiteHow = {}) => call<PersonalSiteView>('POST', '/api/personal-site/setup', { host, ...how }),
  connectPersonalSite: (code: string) => call<PersonalSiteView>('POST', '/api/personal-site/connect', { code }),
  personalSiteCode: () => call<{ code: string }>('GET', '/api/personal-site/code'),
  removePersonalSite: () => call<PersonalSiteView>('DELETE', '/api/personal-site'),
  allowPrivateRepo: (path: string, on: boolean) => call<PersonalSiteView>('POST', '/api/personal-site/private', { path, on }),
  /** Ticks or unticks a repository whose approved cards put their latest demo on the personal site by themselves. */
  shareApprovedRepo: (path: string, on: boolean) => call<PersonalSiteView>('POST', '/api/personal-site/approved', { path, on }),
  /** "Set up a demo site …" for a repository: started, followed, and taken into its settings. */
  setUpRepoSite: (path: string, host: 'cloudflare' | 'github', name: string, how: SiteHow = {}) => call<{ job: SiteSetupJob | null }>('POST', '/api/site-setup', { path, host, name, ...how }),
  repoSiteSetup: (path: string) => call<{ job: SiteSetupJob | null }>('GET', `/api/site-setup?path=${encodeURIComponent(path)}`),
  repoSiteTaken: (path: string) => call<object>('DELETE', `/api/site-setup?path=${encodeURIComponent(path)}`),
  proposeTags: (path: string, current: PageTags | undefined, language: NarrationLanguage | null) =>
    call<{ job: TagProposalJob }>('POST', '/api/tag-proposal', { path, ...(current ? { current } : {}), ...(language ? { language } : {}) }),
  tagProposal: (path: string) => call<{ job: TagProposalJob | null; available: boolean }>('GET', `/api/tag-proposal?path=${encodeURIComponent(path)}`),
  tagProposalTaken: (path: string) => call<object>('DELETE', `/api/tag-proposal?path=${encodeURIComponent(path)}`),
  demoSettings: () => call<DemoSettingsView>('GET', '/api/demo-settings'),
  saveDemoSettings: (settings: DemoSettings) => call<DemoSettingsView>('PUT', '/api/demo-settings', settings),
  checkDemoVoice: (settings: DemoSettings) => call<DemoVoiceCheck>('POST', '/api/demo-settings/check', settings),
  demoSetup: (settings: DemoSettings) => call<SetupCheck>('POST', '/api/demo-settings/setup', settings),
  installDemoVoice: (settings: DemoSettings) => call<DemoSettingsView>('POST', '/api/demo-settings/install', settings),
  /** One sentence in the voice, as a WAV to play. */
  demoVoiceSample: async (settings: DemoSettings) => (await send('POST', '/api/demo-settings/sample', settings)).blob(),
  /** Has a restart that waits for workers go ahead now; false when none waits. */
  restartNow: () => call<{ restarting: boolean }>('POST', '/api/restart'),
  /** Has the restart of this canvas's repositories' agents that waits for them go ahead at once. */
  restartReposNow: () => call<{ restarting: boolean }>('POST', at('/restart')),
  /** Pauses the agents at work on a canvas; cards the Coordinator lets start there wait until they resume. */
  pauseAgents: (canvas: string) => call<void>('POST', `/api/c/${encodeURIComponent(canvas)}/pause`),
  /** Resumes a canvas's paused agents, and the cards waiting for that start. */
  resumeAgents: (canvas: string) => call<void>('POST', `/api/c/${encodeURIComponent(canvas)}/resume`),
  /** Installs the newer version of the app once the workers paused, as a restart waits for them. */
  installUpdate: () => call<{ updating: boolean }>('POST', '/api/app-update/install'),
  /** Fast-forwards the checkout Obeya runs from to its upstream; Obeya then restarts with the new code once the workers paused. */
  pullSource: () => call<{ source: SourceUpdate | null }>('POST', '/api/source-update/pull'),
  /** Draws or removes an owner-drawn arrow; `keepalive` for one sent as the page goes. */
  dependency: (from: string, to: string, remove = false, keepalive = false) => call<void>(remove ? 'DELETE' : 'POST', at('/dependencies'), { from, to }, keepalive),
  create: (c: NewCard) => call<Item>('POST', at('/cards'), c),
  /** The card that writes a repository's settings for everyone, on the canvas it belongs to (not necessarily the shown one). */
  adapterSetup: (canvas: string, repo: string) => call<Item>('POST', `/api/c/${encodeURIComponent(canvas)}/adapter-setup`, { repo }),
  /** The note on a repository's plan directory stays where the owner put it (its top left). */
  movePlanDirNote: (repo: string, to: { x: number; y: number }) => call<void>('PATCH', at(`/plan-dirs/${encodeURIComponent(repo)}`), to),
  preparePlanDoc: (canvas: string, repo: string, file: string) => call<Item>('POST', `/api/c/${encodeURIComponent(canvas)}/prepare-plan-doc`, { repo, file }),
  /** Downloads a card's demo as a ZIP of its page with the files, or as one HTML file. */
  exportDemo: (id: string, as: 'zip' | 'html', demo?: number) => download(cardAt(id, `/export?as=${as}${demo === undefined ? '' : `&demo=${demo}`}`), `demo.${as}`),
  /** The size of a card's demo video in bytes, the latest one or earlier one `n`; null when unknown. */
  demoSize: async (id: string, n?: number) => {
    const res = await fetch(cardAt(id, n === undefined ? '/demo/demo.mp4' : `/demos/${n}/demo.mp4`), { headers: { range: 'bytes=0-0' } });
    await res.body?.cancel();
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    return res.ok && total > 0 ? total : null;
  },
  patch: (id: string, p: CardPatch) => call<void>('PATCH', cardAt(id), p),
  remove: (id: string) => call<void>('DELETE', cardAt(id)),
  restore: (id: string) => call<void>('POST', cardAt(id, '/restore')),
  /** Takes a finished card off the canvas into the archive. */
  archive: (id: string) => call<void>('POST', cardAt(id, '/archive')),
  unarchive: (id: string) => call<void>('POST', cardAt(id, '/unarchive')),
  /**
   * A page of the archive, the most recently archived first, each project with its workstreams:
   * `count` cards after where the page before ended (its `next`); with `q`, those holding its words
   * (`labels`: the archive's labels as the page shows them; `everywhere`: for the search across
   * canvas and archive, workstreams on their own too).
   */
  archivePage: (o: { count: number; next?: string; q?: string; labels?: Record<string, string>; everywhere?: boolean }) => {
    const p = new URLSearchParams({ count: String(o.count) });
    if (o.q) p.set('q', o.q);
    if (o.next) p.set(o.q ? 'from' : 'after', o.next);
    if (o.q && o.labels) p.set('labels', JSON.stringify(o.labels));
    if (o.everywhere) p.set('everywhere', '');
    return call<ArchivePage>('GET', at(`/archive?${p}`));
  },
  /** The archive's entries of these archived cards, each project with its workstreams; one no longer archived is left out. */
  archiveEntries: (ids: string[]) => call<ArchivePage>('GET', at(`/archive?ids=${ids.map(encodeURIComponent).join(',')}`)).then((p) => p.items),
  /** The archive's entry holding the card an address names (an archived workstream's is its project's); none outside the archive. */
  archiveEntry: (code: string) => call<ArchivePage>('GET', at(`/archive?code=${encodeURIComponent(code)}`)).then((p) => p.items),
  /** Archives every finished card of the owner's on the canvas. */
  archiveDone: () => call<{ ids: string[] }>('POST', at('/archive')),
  act: <T = void>(id: string, a: CardAction) => call<T>('POST', cardAt(id, '/act'), a),
  /** "Make it a card": a looked-up thread moves onto a Question card, which comes back. */
  threadCard: (thread: number) => call<Item>('POST', at(`/threads/${thread}/card`)),
  walkthrough: (talk: number) => call<{ thread: number; file: string }>('POST', at(`/talk/${talk}/walkthrough`)),
  cardWalkthrough: (card: string, ev: number) => call<{ thread: number; file: string }>('POST', at(`/cards/${card}/events/${ev}/walkthrough`)),
  /** Opens an answer's file with the system's app, or without `file` the thread's directory. */
  openAnswer: (thread: number, file?: string) => call<void>('POST', at(`/threads/${thread}/open`), file === undefined ? {} : { file }),
  openCardFile: (id: string, file: string, show = false) => call<void>('POST', cardAt(id, '/open'), { file, ...(show ? { show } : {}) }),
  /** A new group with the cards in it; a name a group has already puts them into that one. */
  createGroup: (name: string, cards: string[], hue?: number) => call<Group>('POST', at('/groups'), { name, cards, hue }),
  /** Ends the group: its cards belong to none. Returns what brings it back. */
  deleteGroup: (id: string) => call<{ group: Group; cards: string[] }>('DELETE', at(`/groups/${id}`)),
  /** Puts the cards into the group, or with `null` into none. */
  assign: (cards: string[], group: string | null) => call<void>('POST', at('/assign'), { cards, group }),
  /** Stores a screenshot for a message; the message names it by the id. */
  uploadImage: async (image: Blob) => {
    const res = await fetch(at('/images'), { method: 'POST', headers: { 'content-type': image.type }, body: image });
    await refused(res);
    return ((await res.json()) as { id: string }).id;
  },
  /** Stores another kind of file for a message; returns the path the agent reads it at. */
  uploadFile: async (file: File) => {
    const res = await fetch(at(`/files?name=${encodeURIComponent(file.name)}`), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    await refused(res);
    return ((await res.json()) as { path: string }).path;
  },
  /** Where a file dropped in the browser lies on Obeya's machine, if Obeya finds exactly one that fits its name, size and time. */
  findFile: async (file: File) => (await call<{ path: string | null }>('POST', at('/files/find'), { name: file.name, size: file.size, modified: file.lastModified })).path,
  /** An image the app's drop names by its path on this machine, as a file the page attaches. */
  localImage: async (path: string) => {
    const res = await fetch(at(`/files/local?path=${encodeURIComponent(path)}`));
    await refused(res);
    const blob = await res.blob();
    return new File([blob], path.split(/[\\/]/).at(-1)!, { type: blob.type });
  },
  events: (id: string) => call<CardEvent[]>('GET', cardAt(id, '/events')),
  /** The skills the owner can ask the card's agent for by `/name`. */
  skills: (id: string) => call<Skill[]>('GET', cardAt(id, '/skills')),
  /** Whether the app in the card's workspace answers now. */
  appUp: async (id: string) => (await call<{ up: boolean }>('GET', cardAt(id, '/app'))).up,
  /** Where the owner's browser opens the card's app: through Obeya, which keeps it running a while after. */
  appOpen: (id: string) => cardAt(id, '/app/open'),
  /** What the card's work changes (null: nothing to read, no workspace and not landed); `full`: with the diff itself. */
  diff: async (id: string, full = false) => (await call<CardDiff | undefined>('GET', cardAt(id, `/diff${full ? '?full' : ''}`))) ?? null,
  /** A project's plan doc as written. */
  planDoc: (id: string) => call<{ file: string; markdown: string }>('GET', cardAt(id, '/plan')),
  /** A project's decisions and the idea it came from. */
  history: (id: string) => call<ProjectHistory>('GET', cardAt(id, '/history')),
  /**
   * What the owner said about the card or project in view, with the screenshots shown with it;
   * `replyTo`: in reply to that message of the card's conversation, or of the sheet; `text`: typed in the field
   * before it, which goes first; `listen`: dictated into a field, the words only come back; `spot`:
   * about that place in the card's demo video; `place`: where on the canvas the owner was, for a card it makes;
   * `sent`: the page's name for the recording, to ask whether it arrived (`voiceArrived`). A refusal
   * throws an ApiError; a connection that broke, anything else.
   */
  voice: async (
    audio: Blob,
    where: Where,
    { images = [], replyTo, text, listen, spot, place, sent }: { images?: string[]; replyTo?: number | TalkRef; text?: string; listen?: boolean; spot?: SpotInput; place?: Place; sent?: string } = {},
  ) => {
    const q = [
      ...(sent ? [`sent=${encodeURIComponent(sent)}`] : []),
      ...images.map((id) => `image=${encodeURIComponent(id)}`),
      ...(place ? [`place=${placeParam(place)}`] : []),
      ...(replyTo ? [`replyTo=${typeof replyTo === 'number' ? replyTo : `${replyTo.talk}.${replyTo.part}`}`] : []),
      ...(listen ? ['listen'] : []),
      ...(spot ? [`at=${spot.at}`, ...(spot.still ? [`still=${encodeURIComponent(spot.still)}`] : []), ...(spot.demo !== undefined ? [`demo=${spot.demo}`] : [])] : []),
    ].join('&');
    let body: Blob | FormData = audio;
    if (text?.trim()) {
      body = new FormData();
      body.set('audio', audio);
      body.set('text', text);
    }
    const res = await fetch(whereAt(where, `/voice${query(where)}${q && (where ? '&' : '?')}${q}`), { method: 'POST', body });
    await refused(res);
    return (await res.json()) as Heard;
  },
  /** Whether the recording `voice` sent as `sent` arrived whole. */
  voiceArrived: async (sent: string) => (await call<{ arrived: boolean }>('GET', at(`/voice/arrived/${encodeURIComponent(sent)}`))).arrived,
  /** The owner started speaking, or with `ahead` may speak or type a command soon: Obeya gets ready to read it. */
  warmVoice: (ahead = false) => fetch(at(`/voice/warm${ahead ? '?ahead=1' : ''}`), { method: 'POST' }).catch(() => {}),
  /** The same, typed; `field`: the field of the open card it was typed into. */
  command: (text: string, where: Where, { images, field, replyTo, spot, place }: { images?: string[]; field?: Field; replyTo?: number | TalkRef; spot?: SpotInput; place?: Place } = {}) =>
    call<Heard>('POST', whereAt(where, `/command${query(where)}${place ? `${where ? '&' : '?'}place=${placeParam(place)}` : ''}`), { text, ...(images?.length ? { images } : {}), ...(field ? { field } : {}), ...(replyTo ? { replyTo } : {}), ...(spot ? { spot } : {}) }),
  /** A typed request to the Coordinator of another canvas, about nothing in view there. */
  commandOn: (canvas: string, text: string) => call<Heard>('POST', `/api/c/${encodeURIComponent(canvas)}/command`, { text }),
  undo: (token: string) => call<{ undone: boolean }>('POST', at('/command/undo'), { token }),
  /** The issue for Obeya's makers as a small job writes it from the owner's words, reworking the draft so far; `app`: Obeya runs in its app. */
  writeWish: (w: { said: string; answer?: string; title?: string; body?: string; images?: string[]; app: boolean }) =>
    call<{ title: string; body: string; raw?: true; limitedUntil?: string }>('POST', at('/wish'), w),
  /** A rule of the owner's, active at once, or with `target` one for that repository's CLAUDE.md. */
  addPreference: (text: string, target?: string) => call<void>('POST', at('/preferences'), { text, ...(target ? { target } : {}) }),
  /** Changes a preference, or deletes it with `null`. */
  setPreference: (id: number, text: string | null) =>
    text === null ? call<void>('DELETE', at(`/preferences/${id}`)) : call<void>('PATCH', at(`/preferences/${id}`), { text }),
  /** Accepts a proposed rule, in the owner's words and for the place they chose (a repository, `null` for the preferences) when they changed these. */
  acceptProposal: (id: number, text?: string, target?: string | null) =>
    call<void>('POST', at(`/preferences/${id}/accept`), { ...(text === undefined ? {} : { text }), ...(target === undefined ? {} : { target }) }),
  rejectProposal: (id: number) => call<void>('POST', at(`/preferences/${id}/reject`)),
  /** Takes a setting the work retrospective proposed, as it is or with the owner's `value`: on this machine, or into the repository for everyone. */
  takeSetting: (id: number, where: 'machine' | 'repository', value?: string | string[]) => call<unknown>('POST', at(`/setting-proposals/${id}/take`), { where, ...(value === undefined ? {} : { value }) }),
  rejectSetting: (id: number) => call<void>('POST', at(`/setting-proposals/${id}/reject`)),
  /** Shares outdated pages again, the newest demos first: `count` of them, or all with null. */
  reshare: (count: number | null, tags = false) => call<void>('POST', at('/reshare'), { count, ...(tags ? { tags } : {}) }),
  stopReshare: () => call<void>('POST', at('/reshare/stop')),
  /** "Hide": puts away what the finished run says, and the notice of outdated pages until a newer change. */
  dismissReshare: () => call<void>('DELETE', at('/reshare')),
  /** Obeya's sheet is in view, or (`ids`) these exchanges in a project's sheet. */
  readTalk: (ids?: number[]) => call<void>('POST', at('/talk/read'), ids ? { ids } : undefined),
  /** Obeya no longer waits on the card after that exchange, to take the step it said it would. */
  unwait: (talk: number, card: string) => call<{ stopped: boolean }>('POST', at(`/talk/${talk}/unwait`), { card }),
};

// Log lines arrive over the canvas's WebSocket; whoever shows a card's log listens here.
const eventListeners = new Set<(e: CardEvent) => void>();
export function onCardEvent(fn: (e: CardEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// A canvas's WebSocket is open again after it was lost: what was pushed meanwhile never arrived, so
// whoever shows a card's log loads it anew (the agent may have read the owner's words meanwhile).
const reconnectListeners = new Set<() => void>();
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

// A line taken out of a card's log (a comment deleted before it went to the worker).
const goneListeners = new Set<(cardId: string, id: number) => void>();
export function onCardEventGone(fn: (cardId: string, id: number) => void): () => void {
  goneListeners.add(fn);
  return () => goneListeners.delete(fn);
}

// What Obeya tells the owner without a command of theirs to answer (an answer looked up, what a
// request an agent passed on came to): it shows above the microphone, with "Undo" while actions wait.
const noticeListeners = new Set<(n: Notice) => void>();
/** Notices that came before anything showed them: those a page gets as it opens, before the canvas is drawn. */
let heldNotices: { n: Notice; at: number }[] = [];
export function onNotice(fn: (n: Notice) => void): () => void {
  noticeListeners.add(fn);
  const held = heldNotices;
  heldNotices = [];
  // the undo window went on meanwhile
  for (const { n, at } of held) fn(n.undoMs ? { ...n, undoMs: Math.max(0, n.undoMs - (Date.now() - at)) } : n);
  return () => noticeListeners.delete(fn);
}
function notice(n: Notice) {
  if (!noticeListeners.size) heldNotices.push({ n, at: Date.now() });
  for (const fn of noticeListeners) fn(n);
}

// What the owner does in this page that a restart would cut off, by who holds it (the demo video,
// push-to-talk); the server hears every change, and again after a reconnect.
const holds = new Map<string, OwnerHold>();
/** The page's open WebSockets: one for the canvas it shows, or the phone view's one to every canvas. */
const sockets = new Map<string, WebSocket>();
/** The key of the phone view's one connection among them. */
const EVERY = '*';
const sendHolds = () => {
  for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hold', hold: [...new Set(holds.values())] } satisfies ClientMessage));
};
/** Holds a due restart off while the owner watches (`video`) or dictates (`voice`); `null` lets go. */
export function holdRestart(by: string, what: OwnerHold | null) {
  if ((holds.get(by) ?? null) === what) return;
  if (what) holds.set(by, what);
  else holds.delete(by);
  sendHolds();
}

// Where the owner looks on the canvas, for a card a command makes without a place of its own: the
// server hears every change, again after a reconnect, and when the page gets the focus back, so
// the page the owner looked at last wins.
let focusMessage: Extract<ClientMessage, { type: 'focus' }> | null = null;
const sendFocus = () => {
  const ws = sockets.get(canvasId) ?? sockets.get(EVERY);
  if (focusMessage && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(focusMessage));
};
export function reportFocus(place: Place) {
  focusMessage = { type: 'focus', place: placeParam(place) };
  sendFocus();
}

// The owner uses this page: in view, and they moved, typed or scrolled in it, or a video plays, within
// the last half minute; in the phone view, in view at all, as a phone's screen locks by itself. While
// they do at the machine (and three minutes after) or on the phone (until it goes out of view),
// nothing that starts waiting is pushed to their phone; a page at the machine left in view with
// nobody at it does not hold pushes off.
const HERE_MS = 30_000;
let used = true;
let inViewIsUse = false;
/** The phone view: being in view is using it. */
export const phoneInUse = () => void (inViewIsUse = true);
const sendHere = () => {
  const ws = sockets.get(canvasId) ?? sockets.get(EVERY);
  if (document.visibilityState === 'visible' && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'here' } satisfies ClientMessage));
};
if (typeof document !== 'undefined') {
  // a stall of this page goes into the server's log
  watchPageStalls((stall) => {
    const ws = sockets.get(canvasId) ?? [...sockets.values()][0];
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'stall', ...stall } satisfies ClientMessage));
    return true;
  });
  for (const type of INPUT) addEventListener(type, () => void (used = true), { capture: true, passive: true });
  setInterval(() => {
    const playing = [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
    if (!used && !playing && !inViewIsUse) return;
    used = false;
    sendHere();
  }, HERE_MS);
  // the phone locked or another app in front: what starts waiting from now on is pushed again
  const away = () => {
    if (document.visibilityState !== 'hidden') return;
    for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'away' } satisfies ClientMessage));
  };
  document.addEventListener('visibilitychange', away);
  addEventListener('pagehide', away);
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
 * In the app's window, whose shell is about to start again while the server runs on (a new build of
 * it, app/src/update.rs): what a reload keeps goes to the server rather than this tab's session
 * storage, which the new shell's webview starts without. `token` tells the shell it is there.
 */
export async function handOver(token: string) {
  for (const fn of reloadListeners) fn();
  const entries = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!).map((k) => [k, sessionStorage.getItem(k) ?? '']);
  await send('POST', '/api/app-rebuilt/handover', { token, entries });
}

/** In the window of a shell that started again: what the page before it handed over, back into session storage, once. */
export async function takeHandOver() {
  try {
    const entries = (await call<[string, string][] | null>('GET', '/api/app-rebuilt/handover')) ?? [];
    for (const [k, v] of entries) sessionStorage.setItem(k, v);
  } catch {}
}

/** What the page hears of the canvas it shows, and of the server. */
export interface CanvasFeed {
  snapshot: CanvasSnapshot | null;
  online: boolean;
  /** Since when the server does not answer; null while it does. */
  offlineSince: number | null;
  restart: PendingRestart | null;
  update: AppUpdate | null;
  /** New commits on the upstream of the checkout Obeya runs from. */
  source: SourceUpdate | null;
  /** The plan's usage limits, while the bar shows them. */
  usage: Usage | null;
  /** What waits for the owner on each canvas, by canvas id. */
  waiting: Record<string, Waiting>;
  oldBun: string | null;
  /** The canvases as they changed while the page is open (one started, stopped or renamed); null until they do. */
  canvases: CanvasInfo[] | null;
}

/** The server answered nothing while the page loaded (the app from the home screen, the machine asleep). */
export let quietAtStart = false;
export const markQuiet = () => void (quietAtStart = true);

/** How long a connection may take to open before the page counts the server as not answering. */
const QUIET_MS = 3000;
/** How long before it is given up and tried anew. */
const GIVE_UP_MS = 10_000;

/** What a page does with what its WebSocket hears, beyond what every page does alike (log lines, notices, a new server). */
interface Link {
  /** The socket's path under `/api/`. */
  path: string;
  message(msg: ServerMessage & { canvas?: string }): void;
  /** The server has not answered since `since`; a time already noted stays. */
  quiet(since: number): void;
  /** The socket is open. */
  answers(): void;
  /** The page came back into view without a connection: not answering counts from now. */
  back(): void;
  /** The socket closed: what the page shows may be gone. */
  lost(): void;
}

/**
 * Keeps the WebSocket `link` names open, among the page's sockets as `key`: a lost connection is
 * tried again with a growing pause, and at once when the page comes back into view (a phone that
 * was locked). Returns what closes it.
 */
function keepOpen(key: string, link: Link): () => void {
  let ws: WebSocket;
  let retry: ReturnType<typeof setTimeout>;
  let delay = 500;
  let closed = false;
  let server: string | undefined;
  let hidden = document.visibilityState !== 'visible';
  /** The socket was open before: one that opens now opens again. */
  let opened = false;
  const connect = () => {
    // the app on the home screen says so: Obeya notes the address it keeps, to tell when Obeya's has moved
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${link.path}${standalone() ? '?app' : ''}`);
    sockets.set(key, ws);
    // a sleeping machine answers nothing, not even a refusal: the page says so meanwhile, and tries anew
    const since = Date.now();
    const opening = ws;
    setTimeout(() => opening.readyState === WebSocket.CONNECTING && !closed && link.quiet(since), QUIET_MS);
    setTimeout(() => opening.readyState === WebSocket.CONNECTING && opening.close(), GIVE_UP_MS);
    ws.onopen = () => {
      if (document.visibilityState === 'visible') sendHere();
      if (opened) for (const fn of reconnectListeners) fn();
      opened = true;
      link.answers();
      delay = 500;
      sendHolds();
      sendFocus();
    };
    ws.onmessage = (e) => {
      const start = performance.now();
      const msg = JSON.parse(e.data) as ServerMessage & { canvas?: string };
      // what the page took in, for a stall right after it
      queueMicrotask(() => noteMessage(msg.type, e.data.length, start, performance.now() - start));
      // a new server process may run new code: the page loads it, and keeps what was open
      if (msg.type === 'hello') {
        if (server && server !== msg.server) reload();
        server = msg.server;
      }
      if (msg.type === 'event') for (const fn of eventListeners) fn(msg.event);
      else if (msg.type === 'eventGone') for (const fn of goneListeners) fn(msg.cardId, msg.id);
      else if (msg.type === 'notice') notice(msg);
      else link.message(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      link.quiet(Date.now());
      link.lost();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();
  // back from GitHub, say: the server looks at the pull requests now instead of at its next round
  const back = () => {
    const visible = document.visibilityState === 'visible';
    const cameBack = hidden && visible;
    hidden = !visible;
    if (visible && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'back' } satisfies ClientMessage));
    if (!visible || closed || ws.readyState === WebSocket.OPEN) return sendFocus();
    // a phone that was locked had no connection meanwhile, which says nothing of the server: not
    // answering counts from now, and a connection still opening from back then is tried anew
    if (cameBack) link.back();
    // a connection lost meanwhile is tried again now, not after the pause it waits
    if (ws.readyState === WebSocket.CLOSED || (cameBack && ws.readyState === WebSocket.CONNECTING)) {
      clearTimeout(retry);
      ws.onclose = null;
      ws.close();
      delay = 500;
      connect();
    }
    sendFocus();
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);
  return () => {
    closed = true;
    clearTimeout(retry);
    document.removeEventListener('visibilitychange', back);
    window.removeEventListener('focus', back);
    if (sockets.get(key) === ws) sockets.delete(key);
    ws.close();
  };
}

/**
 * After a lost connection: a device removed from Obeya's devices, or a browser whose cookie no
 * longer names the owner's key, gets the page that says how to connect or sign in again; `listed`
 * sees the canvases there are.
 */
const checkAccess = (listed: (canvases: CanvasInfo[]) => unknown = () => {}) =>
  void api.canvases().then(listed, (e) => e instanceof ApiError && (e.code === 'notPaired' || e.code === 'notOwner') && location.reload());

/** Since when the server does not answer, null while it does: a page that loaded while it answered nothing says so at once. */
function useQuiet() {
  const [offlineSince, setOfflineSince] = useState<number | null>(() => (quietAtStart ? Date.now() - QUIET_MS : null));
  const [kept] = useState(() => ({
    quiet: (since: number) => setOfflineSince((t) => t ?? since),
    answers: () => setOfflineSince(null),
    back: () => setOfflineSince((t) => (t === null ? null : Date.now())),
  }));
  return { offlineSince, ...kept };
}

/**
 * The live canvas `id` (the shown one by default): the server pushes a snapshot on connect and after
 * every change, the restart that waits, the newer version of the app there is, how many cards on
 * each canvas need the owner, and the Bun it runs on when that is too old. `start` is what the page
 * has already, on a switch from another canvas.
 */
export function useCanvas(id = canvasId, start?: Partial<CanvasFeed>): CanvasFeed {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(start?.snapshot ?? null);
  const { offlineSince, ...quiet } = useQuiet();
  // what the bar shows is the server's, not the canvas's: a switch to another canvas starts from it
  const [restart, setRestart] = useState<PendingRestart | null>(start?.restart ?? null);
  const [update, setUpdate] = useState<AppUpdate | null>(start?.update ?? null);
  const [source, setSource] = useState<SourceUpdate | null>(start?.source ?? null);
  const [usage, setUsage] = useState<Usage | null>(start?.usage ?? null);
  const [waiting, setWaiting] = useState<Record<string, Waiting>>(start?.waiting ?? {});
  const [oldBun, setOldBun] = useState<string | null>(start?.oldBun ?? null);
  const [canvases, setCanvases] = useState<CanvasInfo[] | null>(start?.canvases ?? null);
  useEffect(
    () =>
      keepOpen(id, {
        path: `c/${encodeURIComponent(id)}/ws`,
        ...quiet,
        message: (msg) => {
          if (msg.type === 'hello') setOldBun(msg.oldBun ?? null);
          else if (msg.type === 'snapshot') setSnapshot(msg.snapshot);
          else if (msg.type === 'restart') setRestart(msg.restart);
          else if (msg.type === 'update') setUpdate(msg.update);
          else if (msg.type === 'source') setSource(msg.source);
          else if (msg.type === 'usage') setUsage(msg.usage);
          else if (msg.type === 'costs') setCostsShown(msg.shown);
          else if (msg.type === 'waiting') setWaiting(msg.waiting);
          else if (msg.type === 'canvases') setCanvases(msg.canvases);
        },
        // a canvas the configuration no longer has: the page goes to the first one there is
        lost: () => checkAccess((list) => list.some((c) => c.id === id) || location.replace('/')),
      }),
    [id],
  );
  return { snapshot, online: offlineSince === null, offlineSince, restart, update, source, usage, waiting, oldBun, canvases };
}

/** What the phone view hears of every canvas over its one connection. */
export interface EveryCanvas {
  /** Each canvas's live snapshot by its id, once it came. */
  snapshots: Record<string, CanvasSnapshot>;
  /** Since when the server does not answer; null while it does. */
  offlineSince: number | null;
  usage: Usage | null;
  /** The canvases as they changed while the page is open (one started, stopped or renamed); null until the server sent them. */
  canvases: CanvasInfo[] | null;
}

/**
 * What the connection to every canvas does with what it hears, each part of `EveryCanvas` set
 * through `set`. The last canvas stopped (its repository gone, say): the page goes to `/` (setup, or
 * a canvas started since), as a canvas's own page does once its canvas is gone, and the phone view
 * never gets an empty list of canvases.
 */
export function everyCanvasHeard(
  set: {
    snapshots: (f: (s: Record<string, CanvasSnapshot>) => Record<string, CanvasSnapshot>) => void;
    usage: (u: Usage | null) => void;
    canvases: (c: CanvasInfo[]) => void;
  },
  leave = () => location.replace('/'),
): Link['message'] {
  return (msg) => {
    const on = msg.canvas;
    if (msg.type === 'snapshot' && on) set.snapshots((s) => ({ ...s, [on]: msg.snapshot }));
    else if (msg.type === 'usage') set.usage(msg.usage);
    else if (msg.type === 'costs') setCostsShown(msg.shown);
    else if (msg.type === 'canvases' && !msg.canvases.length) leave();
    else if (msg.type === 'canvases') {
      set.canvases(msg.canvases);
      // a canvas stopped: its cards go with it
      const ids = new Set(msg.canvases.map((c) => c.id));
      set.snapshots((s) => (Object.keys(s).every((k) => ids.has(k)) ? s : Object.fromEntries(Object.entries(s).filter(([k]) => ids.has(k)))));
    }
  };
}

/**
 * Every canvas live over one WebSocket, for the phone view, which shows them all: it opens in one
 * handshake and hears what is server-wide once. A socket per canvas (until 2026-11-06) made a phone
 * on a slow network wait for each in turn (a browser opens one at a time to the same host), and it
 * counted Obeya as not answering meanwhile and showed no cards.
 */
export function useEveryCanvas(): EveryCanvas {
  const [snapshots, setSnapshots] = useState<Record<string, CanvasSnapshot>>({});
  const { offlineSince, ...quiet } = useQuiet();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [canvases, setCanvases] = useState<CanvasInfo[] | null>(null);
  useEffect(
    () =>
      keepOpen(EVERY, {
        path: 'ws',
        ...quiet,
        message: everyCanvasHeard({ snapshots: setSnapshots, usage: setUsage, canvases: setCanvases }),
        lost: () => checkAccess(),
      }),
    [],
  );
  return { snapshots, offlineSince, usage, canvases };
}
