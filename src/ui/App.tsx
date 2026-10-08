// The canvas: camera, drag, unfold-in-place and the plan sheet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Bounds, boundsOf, CARD_SIZE, PROJECT_HEAD, PROJECT_PAD, unionBounds } from '../core/layout';
import { answering, type CanvasInfo, type CanvasSnapshot, type CardPatch, finished, type Group, type Item, needsYou, openPerGroup, type PendingRestart, START_ALL_HOLD_MS } from '../core/types';
import { api, ApiError, beforeReload, onSpeak, setCanvas, useCanvas } from './api';
import { GroupNames, growFrom, inside, Lasso, Ring, TerritoryLayer, useTerritories } from './groups';
import { BOTTOM, type Cam, camFor, centreOn, chase, dragLimit, edgeScroll, FAR, flying, flyTo, keepInView, MAX_ZOOM, MIN_ZOOM, overviewCam, stopFlight, TOP, toWorld } from './camera';
import { plain } from './markdown';
import { type ActDone, Detail, hasAgent, type Pending } from './detail';
import type { Field } from './api';
import { ArchiveSheet } from './archive';
import { ConfigSheet } from './config';
import { Setup } from './setup';
import { KoordinatorSheet } from './koordinator';
import { depsOf } from './deps';
import { collect, keep, type Kept, restore, type SideSheet, takeKept } from './keep';
import { Sign, Wordmark } from './logo';
import { Help, HelpButton } from './help';
import { imageFiles, useShotInput } from './shots';
import { type Heard, PushToTalk, play, ToldList, usePushToTalk, useTold, type Where } from './voice';
import { CanvasPill, CardView, DepLinks, Edges, Links, Minimap, ProjectView, RestartPill, Sheet, WorkspacesPill } from './parts';
import { clampWidth, loadWidths, saveWidths, SHEET_GAP, sheetBottom, SHEET_W, type SheetWidths, widthsIn } from './sheetWidth';
import { errorText, t } from './strings';
import { split } from './talk';

export function App() {
  const [canvases, setCanvases] = useState<CanvasInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.canvases().then(setCanvases, () => setFailed(true));
  }, []);
  if (!canvases) return <Splash offline={failed} />;
  // the canvas in the address, else the first
  const wanted = new URLSearchParams(location.search).get('c');
  const current = canvases.find((c) => c.id === wanted) ?? canvases[0];
  // the first start: no canvas yet, so the setup assistant fills the page and creates one
  if (!current) return <Setup first />;
  setCanvas(current.id);
  return <Live canvases={canvases} />;
}

/** While the page loads, and after a restart until the canvas is back: the sign in the middle, above "offline" when the server cannot be reached. */
function Splash({ offline }: { offline: boolean }) {
  return (
    <div id="splash">
      <Sign size={56} />
      {offline && <div>{t.offline}</div>}
    </div>
  );
}

function Live({ canvases }: { canvases: CanvasInfo[] }) {
  const { snapshot, online, restart, waiting } = useCanvas();
  if (!snapshot) return <Splash offline={!online} />;
  return <Canvas snapshot={snapshot} online={online} restart={restart} canvases={canvases} waiting={waiting} />;
}

type Focus = { type: 'project'; id: string; prevCam: Cam } | { type: 'card'; id: string; prevCam: Cam; project: Focus | null };
type Pos = { x: number; y: number };

// opening a card takes FLY_MS + UNFOLD_MS (300 ms) and closing the same: fast, yet still a visible move
const FLY_MS = 130;
const UNFOLD_MS = 170;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What `get` returns once it returns something, within `ms`. */
async function soon<T>(get: () => T | undefined, ms = 3000): Promise<T | undefined> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) {
    const v = get();
    if (v) return v;
  }
  return get();
}
/** The state whose colour an open card wears: a demo whose worker takes in the owner's answer is at work. */
const shownState = (i: Item) => (answering(i) ? 'working' : i.state);

const camKey = (canvasId: string) => `obeya-cam-${canvasId}`;

function Canvas({
  snapshot,
  online,
  restart,
  canvases,
  waiting,
}: {
  snapshot: CanvasSnapshot;
  online: boolean;
  restart: PendingRestart | null;
  canvases: CanvasInfo[];
  waiting: Record<string, number>;
}) {
  // ---------------------------------------------------------------- items
  // Local positions win over the snapshot until the server echoes them back.
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  // Cards created here, until the snapshot carries them.
  const [pending, setPending] = useState<Item[]>([]);
  // Approved cards the server is still landing, with what the card says meanwhile, until it moves on.
  const [underway, setUnderway] = useState<Record<string, string>>({});
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    const byId = new Map(snapshot.items.map((i) => [i.id, i]));
    setMoved((m) => {
      const keep = Object.entries(m).filter(([id, p]) => {
        const i = byId.get(id);
        return i && (dragRef.current?.id === id || i.x !== p.x || i.y !== p.y);
      });
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
    setPending((p) => (p.some((i) => byId.has(i.id)) ? p.filter((i) => !byId.has(i.id)) : p));
    setUnderway((u) => {
      const keep = Object.entries(u).filter(([id]) => byId.get(id)?.state === 'waiting');
      return keep.length === Object.keys(u).length ? u : Object.fromEntries(keep);
    });
  }, [snapshot]);

  const items = useMemo(() => {
    // the snapshot may carry a new card before its creation answers: then it is there once
    const ids = new Set(snapshot.items.map((i) => i.id));
    const all = [...snapshot.items, ...pending.filter((i) => !ids.has(i.id))];
    return all.map((i) => (moved[i.id] ? { ...i, ...moved[i.id] } : i));
  }, [snapshot, pending, moved]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const placed = useMemo(() => items.map((item) => ({ item, b: boundsOf(item, items) })), [items]);
  const territories = useTerritories(placed, snapshot.groups);
  const kidsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) if (i.parent) m.set(i.parent, [...(m.get(i.parent) ?? []), i]);
    return m;
  }, [items]);
  // ideas with a prototype on the canvas, which stay out of the archive until it ends
  const prototyped = useMemo(() => new Set(items.flatMap((i) => (i.prototypeOf ? [i.prototypeOf] : []))), [items]);
  const all: Bounds = useMemo(() => unionBounds(placed.map((p) => p.b)) ?? { x: 0, y: 0, w: 1000, h: 600 }, [placed]);
  // what the view keeps in sight: the cards, and a project only while it holds none
  const content = useMemo(() => placed.filter(({ item }) => !kidsOf.has(item.id)).map((p) => p.b), [placed, kidsOf]);
  const contentRef = useRef(content);
  contentRef.current = content;
  const byId = (id: string) => itemsRef.current.find((i) => i.id === id);
  const bounds = (i: Item) => boundsOf(i, itemsRef.current);

  // ---------------------------------------------------------------- camera
  const [cam, setCamState] = useState<Cam>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(camKey(snapshot.canvas.id)) ?? 'null');
      if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) return keepInView(saved, content, { left: 0, top: TOP, right: innerWidth, bottom: innerHeight - BOTTOM });
    } catch {}
    return centreOn(all, 1);
  });
  const camRef = useRef(cam);
  const setCam = useCallback((c: Cam) => {
    camRef.current = c;
    setCamState(c);
  }, []);
  const fly = (to: Cam, ms?: number) => flyTo(camRef.current, to, setCam, ms);
  const flyOrJump = async (to: Cam, ms: number, jump: boolean) => (jump ? setCam(to) : fly(to, ms));
  useEffect(() => {
    document.documentElement.style.setProperty('--s', String(cam.s));
    if (focusRef.current) return;
    const h = setTimeout(() => {
      try {
        localStorage.setItem(camKey(snapshot.canvas.id), JSON.stringify(cam));
      } catch {}
    }, 300);
    return () => clearTimeout(h);
  }, [cam, snapshot.canvas.id]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  // ---------------------------------------------------------------- focus
  const [focus, setFocusState] = useState<Focus | null>(null);
  const focusRef = useRef<Focus | null>(null);
  const setFocus = (f: Focus | null) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const [openId, setOpenId] = useState<string | null>(null);
  const [dim, setDim] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [sheetOn, setSheetOn] = useState(false);
  // the open project's plan doc, read in the widened sheet
  const [reading, setReadingState] = useState<{ mark?: string } | null>(null);
  const readingRef = useRef(reading);
  const setReading = (r: { mark?: string } | null) => {
    readingRef.current = r;
    setReadingState(r);
  };
  // how wide the sheets are, as the owner dragged them; in effect clamped to the window
  const [widths, setWidths] = useState<SheetWidths>(() => loadWidths(localStorage));
  const sheetW = widthsIn(widths, innerWidth);
  const sheetWRef = useRef(sheetW);
  sheetWRef.current = sheetW;
  const [kOn, setKOn] = useState(false);
  const toggleKoordinator = () => {
    if (!kOn && focusRef.current?.type === 'project') closeProject();
    setKOn(!kOn);
    setAOn(false);
    setCOn(false);
  };
  const [aOn, setAOn] = useState(false);
  const toggleArchive = () => {
    if (!aOn && focusRef.current?.type === 'project') closeProject();
    setAOn(!aOn);
    setKOn(false);
    setCOn(false);
  };
  const [helpOn, setHelpOn] = useState(false);
  const [cOn, setCOn] = useState(false);
  const [setupOn, setSetupOn] = useState(false);
  const toggleConfig = () => {
    if (!cOn && focusRef.current?.type === 'project') closeProject();
    setCOn(!cOn);
    setKOn(false);
    setAOn(false);
  };
  // the archive, read while its sheet is open; archived cards unfold from their row there
  const [archived, setArchived] = useState<Item[]>([]);
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const archiveEls = useRef(new Map<string, HTMLElement>()).current;
  // rows of the project sheet, where its archived workstreams and its idea unfold from
  const sheetEls = useRef(new Map<string, HTMLElement>()).current;
  /** The element a card unfolds from and folds back to: on the canvas, or a row in the sheet it was opened from. */
  const fromEl = (id: string, inProject: boolean) =>
    els.get(id) ?? (inProject ? (sheetEls.get(id) ?? archiveEls.get(id)) : (archiveEls.get(id) ?? sheetEls.get(id)));
  // an archived card opened from a project's sheet, which the archive list may not hold
  const [opened, setOpened] = useState<Item | null>(null);
  useEffect(() => {
    if (!aOn) return;
    let current = true;
    api.archived().then((a) => current && setArchived(a), console.error);
    return () => void (current = false);
  }, [aOn, snapshot]);
  const [popId, setPopId] = useState<string | null>(null);
  const els = useRef(new Map<string, HTMLElement>()).current;
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // the panel follows its content from the unfold until it starts to fold
  const unfolded = useRef(false);
  const fitPanel = (i: Item) => {
    const panel = panelRef.current;
    const inner = innerRef.current;
    if (panel && inner) Object.assign(panel.style, panelRect(i, inner));
  };

  // edits of the open card, saved shortly after typing stops
  const edit = useRef<{ id: string; patch: CardPatch; timer?: ReturnType<typeof setTimeout> } | null>(null);
  /** Saves what was typed into the open card; actions on it wait for this. */
  const flushEdit = (): Promise<void> => {
    const e = edit.current;
    if (!e) return Promise.resolve();
    clearTimeout(e.timer);
    edit.current = null;
    return Object.keys(e.patch).length ? api.patch(e.id, e.patch) : Promise.resolve();
  };
  // the open card's title as typed, which the snapshot may not carry yet
  const openTitle = useRef('');
  const onEdit = (p: CardPatch) => {
    const id = focusRef.current?.id;
    if (!id) return;
    if (p.title !== undefined) openTitle.current = p.title;
    if (edit.current?.id !== id) flushEdit().catch(console.error);
    const e = (edit.current ??= { id, patch: {} });
    Object.assign(e.patch, p);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => flushEdit().catch(console.error), 400);
  };

  /** Unfolds the card `i`; `quick` without the flight and the unfold, as after a reload. */
  async function open(i: Item, quick = false) {
    const f = focusRef.current;
    if (f?.type === 'card') return;
    if (i.kind === 'project') return openProject(i);
    setFocus({ type: 'card', id: i.id, prevCam: camRef.current, project: f });
    openTitle.current = i.title;
    setOpened(i.archivedAt ? i : null);
    // bring the card to the middle at a readable scale first, so the unfold starts where the eye is;
    // an archived card is not on the canvas and unfolds from its row in the archive
    if (!i.archivedAt) await flyOrJump(centreOnPoint(bounds(i), Math.max(camRef.current.s, 0.85)), FLY_MS, quick);
    const el = fromEl(i.id, !!f);
    const panel = panelRef.current;
    // nothing to unfold from: the canvas stays as it was, open for the next card
    if (!el || !panel) return setFocus(f);
    const r = el.getBoundingClientRect();
    flushSync(() => setOpenId(i.id));
    panel.style.setProperty('--c', `var(--${shownState(i)})`);
    panel.className = '';
    panel.style.setProperty('--unfold', `${quick ? 0 : UNFOLD_MS}ms`);
    Object.assign(panel.style, rect(r), { display: 'block', borderRadius: '14px' });
    panel.getBoundingClientRect();
    panel.classList.add('anim');
    panel.style.borderRadius = '18px';
    fitPanel(i);
    unfolded.current = true;
    setDim(true);
    setSheetOn(false);
    if (!quick) await sleep(UNFOLD_MS);
    panel.classList.add('ready');
    const title = panel.querySelector<HTMLTextAreaElement>('textarea.p-title');
    if (title && !title.value) title.focus();
  }

  // a card that starts or finishes work while open changes its width and colour: resize in place
  const openItem = openId
    ? (items.find((i) => i.id === openId) ?? archived.find((i) => i.id === openId) ?? (opened?.id === openId ? opened : undefined))
    : undefined;
  const openState = openItem && `${shownState(openItem)}:${openItem.need ?? ''}`;
  useEffect(() => {
    const panel = panelRef.current;
    const i = openItem;
    if (!panel || !i || !unfolded.current) return;
    panel.style.setProperty('--c', `var(--${shownState(i)})`);
    fitPanel(i);
  }, [openState]);
  // content that grows or shrinks (a log loading, a question arriving, a resized text box) resizes it too
  useEffect(() => {
    const content = innerRef.current?.firstElementChild;
    if (!openId || !content) return;
    // in the next frame: a split that fills the panel takes back what the rest grew by, which would
    // change the content again while the observer reports
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const i = byId(openId) ?? archivedRef.current.find((x) => x.id === openId);
        if (i && unfolded.current) fitPanel(i);
      });
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [openId]);
  // and so does the window: a split filling the panel takes the height it has
  useEffect(() => {
    const i = openId && (byId(openId) ?? archivedRef.current.find((x) => x.id === openId));
    if (i && unfolded.current) fitPanel(i);
  }, [tick]);

  // the open card went away on the server (cut into packages, deleted elsewhere): fold the panel
  useEffect(() => {
    if (openId && !openItem && focusRef.current?.type === 'card') closeCard({ keepUntitled: true });
  }, [openId, openItem]);

  function onDone(d: ActDone, p?: Pending) {
    if (!d.close) return;
    closeCard({ keepUntitled: true });
    if (!p || !d.pending) return showAck(d.ack, d.undo);
    // the card says it is under way until the snapshot moves it on; a refusal puts it back as it was
    const what = d.pending;
    setUnderway((u) => ({ ...u, [p.card]: what }));
    showWait(`${what.charAt(0).toUpperCase()}${what.slice(1)}`);
    p.answered.then(
      () => showAck(d.ack, d.undo),
      (e) => {
        if (!(e instanceof ApiError)) console.error(e);
        setUnderway(({ [p.card]: _, ...rest }) => rest);
        showAck(t.cardError(p.title, e instanceof ApiError ? errorText(e.code) : t.offlineError));
      },
    );
  }

  async function closeCard({ keepUntitled = false } = {}) {
    const f = focusRef.current;
    const panel = panelRef.current;
    if (f?.type !== 'card' || !panel) return;
    flushEdit().catch(console.error);
    panel.querySelector('video')?.pause();
    const i = byId(f.id);
    const el = fromEl(f.id, !!f.project);
    unfolded.current = false;
    panel.classList.remove('ready');
    if (el) Object.assign(panel.style, rect(el.getBoundingClientRect()), { borderRadius: '14px' });
    setDim(false);
    await sleep(UNFOLD_MS);
    panel.style.display = 'none';
    panel.className = '';
    setOpenId(null);
    setFocus(f.project);
    if (f.project) setSheetOn(true);
    // a new card left without a title was not wanted
    if (!keepUntitled && i?.source === 'manual' && !openTitle.current.trim()) api.remove(i.id).catch(console.error);
    await fly(f.prevCam, FLY_MS);
    // the card may have gone (archived, deleted) and taken the last content in view with it
    recover();
  }

  async function openProject(p: Item, quick = false) {
    const f = focusRef.current;
    setFocus({ type: 'project', id: p.id, prevCam: f?.type === 'project' ? f.prevCam : camRef.current });
    setSheetId(p.id);
    setReading(null);
    setSheetOn(true);
    setKOn(false);
    setAOn(false);
    setCOn(false);
    // an archived project is not on the canvas: its sheet takes the archive's place
    if (!p.archivedAt) await flyOrJump(camFor(bounds(p), 40, sheetWRef.current.sheet + 30, 60), 700, quick);
  }

  /** Reads the project's plan doc in the sheet, at the workstream `mark`; `null` goes back to the workstreams. */
  async function readPlan(p: Item, r: { mark?: string } | null, quick = false) {
    if (focusRef.current?.type === 'card') await closeCard();
    const f = focusRef.current;
    setFocus({ type: 'project', id: p.id, prevCam: f?.type === 'project' ? f.prevCam : camRef.current });
    setSheetId(p.id);
    setReading(r);
    setSheetOn(true);
    setKOn(false);
    setAOn(false);
    setCOn(false);
    // the project stays in view beside the wider sheet
    await flyOrJump(camFor(bounds(p), 40, (r ? sheetWRef.current.read : sheetWRef.current.sheet) + 30, 60), 700, quick);
  }

  async function closeProject() {
    const f = focusRef.current;
    if (f?.type !== 'project') return;
    setFocus(null);
    setSheetOn(false);
    // back to the archive it was opened from
    if (archivedRef.current.some((i) => i.id === f.id) && !itemsRef.current.some((i) => i.id === f.id)) setAOn(true);
    await fly(f.prevCam, 600);
    recover();
  }

  async function deleteOpen() {
    const f = focusRef.current;
    if (f?.type !== 'card') return;
    const i = byId(f.id);
    const title = openTitle.current.trim();
    if (edit.current) clearTimeout(edit.current.timer);
    edit.current = null;
    await closeCard({ keepUntitled: true });
    if (!i) return;
    await api.remove(i.id);
    if (title) showAck(t.deleted(plain(title)), () => api.restore(i.id));
  }

  async function createAt(world: Pos) {
    const [w, h] = CARD_SIZE.task;
    const card = await api.create({ title: '', x: Math.round(world.x - w / 2), y: Math.round(world.y - h / 2) });
    flushSync(() => {
      // the snapshot that carries it may have come first: then it is no longer pending
      if (!snapshotRef.current.items.some((i) => i.id === card.id)) setPending((p) => [...p, card]);
      setPopId(card.id);
    });
    await open(card);
  }
  const createAtCentre = () => createAt(toWorld(camRef.current, innerWidth / 2, innerHeight / 2));

  // ---------------------------------------------------------------- kept across a restart
  // a restart reloads the page: what was open comes back as it was, without the flights
  const keepNow = useRef(() => {});
  keepNow.current = () => {
    flushEdit().catch(console.error);
    const f = focusRef.current;
    const project = f?.type === 'project' ? f.id : f?.type === 'card' ? f.project?.id : undefined;
    const sheet: SideSheet | undefined = kOn ? 'koordinator' : aOn ? 'archive' : cOn ? 'config' : undefined;
    keep(sessionStorage, snapshot.canvas.id, {
      at: Date.now(),
      ...(f?.type === 'card' ? { card: f.id } : {}),
      ...(project ? { project, reading: !!readingRef.current } : {}),
      ...(sheet ? { sheet } : {}),
      ...collect(),
    });
  };
  useEffect(() => beforeReload(() => keepNow.current()), []);
  useEffect(() => {
    const k = takeKept(sessionStorage, snapshot.canvas.id);
    if (k) reopen(k).catch(console.error);
  }, []);
  async function reopen(k: Kept) {
    if (k.sheet === 'koordinator') setKOn(true);
    else if (k.sheet === 'archive') setAOn(true);
    else if (k.sheet === 'config') setCOn(true);
    let gone: Item[] | undefined;
    const find = async (id?: string) => (id ? (byId(id) ?? (gone ??= await api.archived().catch(() => [])).find((i) => i.id === id)) : undefined);
    const p = await find(k.project);
    // an archived project's sheet lists its workstreams from the archive
    if (gone) setArchived(gone);
    // the doc opens at its top, and the kept position puts it back where it was
    if (p) await (k.reading ? readPlan(p, {}, true) : openProject(p, true));
    const i = await find(k.card);
    // an archived card unfolds from its row in the archive or the project's sheet, once that has loaded
    if (i && (!i.archivedAt || (await soon(() => fromEl(i.id, !!p))))) await open(i, true);
    restore(k);
  }

  // ---------------------------------------------------------------- acknowledgement with undo
  const [ack, setAck] = useState<{ text: string; undo?: () => unknown; wait?: boolean } | null>(null);
  const [ackOn, setAckOn] = useState(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A confirmation; with `undo`, "Rückgängig" shows for `undoMs` (while the server still waits). */
  function showAck(text: string, undo?: () => unknown, undoMs = 7000) {
    setAck({ text, undo });
    setAckOn(true);
    clearTimeout(ackTimer.current);
    clearTimeout(undoTimer.current);
    if (undo) undoTimer.current = setTimeout(() => setAck((a) => (a && a.text === text ? { text } : a)), Math.max(0, undoMs - 400));
    ackTimer.current = setTimeout(() => setAckOn(false), 7000);
  }
  /** What the server is still at: stays, turning, until a confirmation takes its place. */
  function showWait(text: string) {
    setAck({ text, wait: true });
    setAckOn(true);
    clearTimeout(ackTimer.current);
    clearTimeout(undoTimer.current);
  }

  /** The play button on a card: starts it, or one queued behind others despite the likely conflict. */
  const startCard = useCallback(async (i: Item) => {
    try {
      await api.act(i.id, { action: i.queue ? 'force' : 'start' });
      if (i.queue) showAck(t.queue.forced);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      showAck(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  }, []);

  /** The archive button on a finished card or a dropped idea: takes it off the canvas, with a moment to undo. */
  const archiveCard = useCallback(async (i: Item) => {
    try {
      await api.archive(i.id);
      showAck(t.archive.archived(plain(i.title)), () => api.unarchive(i.id));
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      showAck(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  }, []);

  /**
   * The project's button, on its card and in its sheet: all planned workstreams go to the
   * Koordinator together, which waits a few seconds before it plans them, so the start can be taken back.
   */
  const startAll = useCallback(async (p: Item, n: number) => {
    try {
      await api.act(p.id, { action: 'start' });
      showAck(
        t.plan.startedAll(n),
        async () => {
          try {
            await api.act(p.id, { action: 'dequeue' });
            showAck(t.plan.startTakenBack);
          } catch (e) {
            showAck(e instanceof ApiError && e.code === 'notQueued' ? t.voice.tooLate : t.offlineError);
          }
        },
        START_ALL_HOLD_MS,
      );
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      showAck(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  }, []);

  // ---------------------------------------------------------------- voice
  const where = (): Where => {
    const f = focusRef.current;
    return f?.type === 'card' ? { card: f.id } : f?.type === 'project' ? { project: f.id } : null;
  };
  // a command that makes a card: when it appears, the camera goes there
  const newCardWatch = useRef<{ known: Set<string>; until: number } | null>(null);
  function onHeard(h: Heard) {
    // said to the open card's agent or idea: the card shows it
    if (h.quiet) return;
    play(h.audio);
    if (h.token && !focusRef.current) newCardWatch.current = { known: new Set(itemsRef.current.map((i) => i.id)), until: Date.now() + 20_000 };
  }
  const told = useTold(onHeard);
  /** Hands a command for `target` on, with its line above the microphone. */
  const tellAbout = (target: Where, label: string | null, request: () => Promise<Heard>) => {
    const i = target ? itemsRef.current.find((x) => x.id === ('card' in target ? target.card : target.project)) : undefined;
    const title = plain(i?.title ?? '');
    return told.tell(label ?? (i ? `„${title}“` : t.voice.koordinator), target && 'card' in target && i ? { id: i.id, title } : undefined, request);
  };
  /** Words typed on a card, in its idea or in the Koordinator's sheet: read by the Koordinator like spoken ones. */
  const tellTyped = useCallback((text: string, images: string[] | undefined, target: Where, field?: Field) => {
    const words = text.replace(/\s+/g, ' ');
    void tellAbout(target, `„${words.length > 40 ? `${words.slice(0, 39)}…` : words}“`, () => api.command(text, target, images, field));
  }, []);
  useEffect(() => {
    const w = newCardWatch.current;
    if (!w) return;
    if (Date.now() > w.until) return void (newCardWatch.current = null);
    const made = snapshot.items.find((i) => i.source === 'manual' && !w.known.has(i.id));
    if (!made || focusRef.current) return;
    newCardWatch.current = null;
    setPopId(made.id);
    // a new idea opens, so the owner sees the discussion begin
    if (made.state === 'idea') {
      setKOn(false);
      open(made);
    }
    else fly(centreOnPoint(boundsOf(made, itemsRef.current), Math.max(camRef.current.s, 0.8)), 700);
  }, [snapshot]);
  // an idea's agent sums up its reply aloud, for the owner who has the idea open; an answer the
  // Koordinator looked up is heard wherever the owner is
  useEffect(
    () =>
      onSpeak((cardId, audio) => {
        const f = focusRef.current;
        if (!cardId || (f?.type === 'card' && f.id === cardId)) play(audio);
      }),
    [],
  );
  // screenshots for the next recording: picked beside the mic, dropped on it, or pasted (⌘V) anywhere but in a text field
  const voiceShots = useShotInput();
  const ptt = usePushToTalk(where, (target, request) => tellAbout(target, null, request), (h) => showAck(h.confirm), voiceShots);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
  const voiceShotsRef = useRef(voiceShots);
  voiceShotsRef.current = voiceShots;
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.code === 'Space' && pttRef.current.stop();
    const release = () => pttRef.current.stop();
    const paste = (e: ClipboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      const files = imageFiles(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      voiceShotsRef.current.attach(files);
    };
    addEventListener('keyup', up, true);
    addEventListener('pointerup', release);
    addEventListener('paste', paste);
    return () => {
      removeEventListener('keyup', up, true);
      removeEventListener('pointerup', release);
      removeEventListener('paste', paste);
    };
  }, []);
  const focusItem = focus ? (items.find((i) => i.id === focus.id) ?? archived.find((i) => i.id === focus.id)) : undefined;
  const target =
    focus?.type === 'card'
      ? (focusItem?.state === 'idea' ? t.voice.idea : focusItem && hasAgent(focusItem) ? t.voice.agent : t.voice.card)(plain(focusItem?.title ?? ''))
      : focus?.type === 'project'
        ? t.voice.project(plain(focusItem?.title ?? ''))
        : t.voice.koordinator;

  // ---------------------------------------------------------------- pointer: pan, drag, click
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  // a dragged card follows the world point it was picked up at, also while the view scrolls under it
  type Drag = { id: string; x: number; y: number; px: number; py: number; grab: Pos; start: Pos; limit: Bounds; moved: boolean; frame: number; last: number };
  const dragRef = useRef<Drag | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // the card the pointer is on, for the waits around it
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Shift + drag on the canvas draws a lasso; the colour ring then puts what it caught into a group
  const lassoRef = useRef<Pos[] | null>(null);
  const [lasso, setLasso] = useState<Pos[]>([]);
  const [ring, setRing] = useState<{ at: Pos; ids: string[] } | null>(null);
  async function assignGroup(to: { group: string | null } | { name: string }) {
    const r = ring!;
    setRing(null);
    setLasso([]);
    // the territory grows from the pointer, or from the one card it is for
    const one = r.ids.length === 1 ? placed.find((p) => p.item.id === r.ids[0])?.b : undefined;
    growFrom(r.ids, one ? { x: one.x + one.w / 2, y: one.y + one.h / 2 } : toWorld(camRef.current, r.at.x, r.at.y));
    try {
      if ('name' in to) await api.createGroup(to.name, r.ids);
      else await api.assign(r.ids, to.group);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      showAck(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  }
  /** The × on a group's name in the colour ring: its cards belong to none, with a moment to undo. */
  async function deleteGroup(g: Group) {
    setRing(null);
    setLasso([]);
    try {
      const gone = await api.deleteGroup(g.id);
      showAck(t.groups.removed(g.name), () => api.createGroup(gone.group.name, gone.cards, gone.group.hue));
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      showAck(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  }
  /** A right click on a card opens the colour ring for it; a workstream's is its project's. */
  function onContextMenu(e: React.MouseEvent) {
    if (focusRef.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.item');
    let i = el && byId(el.dataset.id!);
    if (i?.parent) i = byId(i.parent);
    if (!i) return;
    e.preventDefault();
    setRing({ at: { x: e.clientX, y: e.clientY }, ids: [i.id] });
  }
  // the strip on the right a sheet covers, which neither edge indicators nor dragging count as view
  const readingNow = !!reading && focus?.type === 'project';
  const reserve = focus || kOn || aOn || cOn ? (readingNow ? sheetW.read : sheetW.sheet) + 30 : 0;
  const reserveRef = useRef(reserve);
  reserveRef.current = reserve;

  // the grip at the open sheet's left edge widens or narrows it; reading a plan doc has its own width
  const gripOn = kOn || aOn || cOn || sheetOn;
  const gripKind = readingNow && sheetOn ? 'read' : 'sheet';
  const gripRef = useRef<{ x: number; w: number; kind: 'sheet' | 'read' } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) saveWidths(localStorage, widths);
  }, [widths, resizing]);
  function onGripDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gripRef.current = { x: e.clientX, w: sheetW[gripKind], kind: gripKind };
    setResizing(true);
  }
  function onGripMove(e: React.PointerEvent) {
    const g = gripRef.current;
    if (!g) return;
    const w = clampWidth(g.w + g.x - e.clientX, innerWidth, g.kind);
    setWidths((ws) => ({ ...ws, [g.kind]: w }));
  }
  function onGripUp() {
    gripRef.current = null;
    setResizing(false);
  }
  /** `c`, moved just far enough that the view outside the sheet shows some content. */
  const kept = (c: Cam) => keepInView(c, contentRef.current, { left: 0, top: TOP, right: innerWidth - reserveRef.current, bottom: innerHeight - BOTTOM });
  /** The view at the current zoom with a world point in the middle, as far as content stays in sight. */
  const viewOn = (wx: number, wy: number) => kept({ s: camRef.current.s, x: innerWidth / 2 - wx * camRef.current.s, y: innerHeight / 2 - wy * camRef.current.s });
  /** When no content is in view any more (cards went, the window shrank), flies to the nearest. */
  const recover = () => {
    if (focusRef.current?.type === 'card' || dragRef.current || panRef.current || flying()) return;
    const c = camRef.current;
    const k = kept(c);
    if (k.x !== c.x || k.y !== c.y) fly(k, 400);
  };
  useEffect(recover, [content, tick]);

  function onPointerDown(e: React.PointerEvent) {
    if (focusRef.current?.type === 'card' || e.button !== 0) return;
    stopFlight();
    const el = (e.target as Element).closest<HTMLElement>('.item');
    // a project moves by its header; its body is canvas, so dragging there pans
    if (el && (!el.classList.contains('project') || (e.target as Element).closest('.head'))) {
      const i = byId(el.dataset.id!);
      if (!i) return;
      // the view scrolls as far as the rest of the canvas reaches, plus room to drop the card beside it
      const rest = itemsRef.current.filter((x) => x.id !== i.id);
      const b = bounds(i);
      const content = unionBounds(rest.map((x) => boundsOf(x, rest))) ?? b;
      const grab = toWorld(camRef.current, e.clientX, e.clientY);
      dragRef.current = { id: i.id, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, grab, start: { x: i.x, y: i.y }, limit: dragLimit(content, b), moved: false, frame: 0, last: 0 };
    } else if (e.shiftKey) {
      lassoRef.current = [{ x: e.clientX, y: e.clientY }];
      setLasso(lassoRef.current);
    } else {
      panRef.current = { x: e.clientX, y: e.clientY };
      setPanning(true);
    }
    viewportRef.current!.setPointerCapture(e.pointerId);
  }

  /** Puts the dragged card under the pointer. */
  function place(d: Drag) {
    const w = toWorld(camRef.current, d.px, d.py);
    let p = { x: Math.round(d.start.x + w.x - d.grab.x), y: Math.round(d.start.y + w.y - d.grab.y) };
    // workstreams stay inside their project
    if (byId(d.id)?.parent) p = { x: Math.max(PROJECT_PAD, p.x), y: Math.max(PROJECT_HEAD, p.y) };
    setMoved((m) => ({ ...m, [d.id]: p }));
  }

  /** While a card is dragged, scrolls the view when the pointer is near an edge. */
  function edgeTick(now: number) {
    const d = dragRef.current;
    if (!d) return;
    const ms = d.last ? Math.min(50, now - d.last) : 0;
    d.last = now;
    const c = camRef.current;
    const view = { left: 0, top: TOP, right: innerWidth - reserveRef.current, bottom: innerHeight };
    const next = edgeScroll(c, { x: d.px, y: d.py }, { x: d.x, y: d.y }, view, d.limit, ms);
    if (next.x !== c.x || next.y !== c.y) {
      setCam(next);
      place(d);
    }
    d.frame = requestAnimationFrame(edgeTick);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (lassoRef.current) {
      lassoRef.current = [...lassoRef.current, { x: e.clientX, y: e.clientY }];
      setLasso(lassoRef.current);
      return;
    }
    const d = dragRef.current;
    if (d) {
      d.px = e.clientX;
      d.py = e.clientY;
      if (!d.moved && Math.hypot(d.px - d.x, d.py - d.y) < 5) return;
      if (!d.moved) {
        setDragId(d.id);
        d.moved = true;
        d.frame = requestAnimationFrame(edgeTick);
      }
      place(d);
      return;
    }
    // the view follows the pointer step by step, so after a stop at the content's edge it turns back at once
    const p = panRef.current;
    if (!p) return;
    const c = camRef.current;
    setCam(kept({ ...c, x: c.x + e.clientX - p.x, y: c.y + e.clientY - p.y }));
    p.x = e.clientX;
    p.y = e.clientY;
  }

  function onPointerUp(e: React.PointerEvent) {
    const l = lassoRef.current;
    if (l) {
      lassoRef.current = null;
      const c = camRef.current;
      // what the lasso caught: each card whose middle lies inside, a workstream as its project
      const ids = [
        ...new Set(placed.filter(({ b }) => inside({ x: c.x + (b.x + b.w / 2) * c.s, y: c.y + (b.y + b.h / 2) * c.s }, l)).map(({ item }) => item.parent ?? item.id)),
      ];
      if (ids.length) setRing({ at: { x: e.clientX, y: e.clientY }, ids });
      else setLasso([]);
      return;
    }
    const d = dragRef.current;
    if (d) {
      cancelAnimationFrame(d.frame);
      dragRef.current = null;
      setDragId(null);
      const i = byId(d.id);
      if (!i) return;
      if (d.moved)
        api.patch(i.id, { x: i.x, y: i.y }).catch((err) => {
          console.error(err);
          setMoved(({ [i.id]: _, ...rest }) => rest);
        });
      else open(i);
      return;
    }
    panRef.current = null;
    setPanning(false);
  }

  function onDoubleClick(e: React.MouseEvent) {
    // the pointer capture retargets the event to the viewport, so look at what is under the pointer
    if (focusRef.current || document.elementFromPoint(e.clientX, e.clientY)?.closest('.item')) return;
    createAt(toWorld(camRef.current, e.clientX, e.clientY));
  }

  useEffect(() => {
    const vp = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (focusRef.current?.type === 'card') return;
      stopFlight();
      const c = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.s * Math.exp(-e.deltaY * 0.012)));
        setCam(kept({ s, x: e.clientX - (e.clientX - c.x) * (s / c.s), y: e.clientY - (e.clientY - c.y) * (s / c.s) }));
      } else setCam(kept({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [setCam]);

  // ---------------------------------------------------------------- keys
  const attention = items.filter(needsYou);
  const queuedCount = items.filter((i) => i.state === 'planned' && i.queue).length;
  const proposalCount = snapshot.preferences.filter((p) => p.state === 'proposed').length;
  const doneCount = items.filter((i) => i.source === 'manual' && finished(i.state)).length;
  async function archiveDone() {
    const { ids } = await api.archiveDone();
    if (ids.length) showAck(t.archive.archivedMany(ids.length), () => Promise.all(ids.map((id) => api.unarchive(id))));
  }
  const attnIdx = useRef(-1);
  function nextAttention() {
    const list = itemsRef.current.filter(needsYou);
    if (!list.length || focusRef.current?.type === 'card') return;
    attnIdx.current = (attnIdx.current + 1) % list.length;
    open(list[attnIdx.current]!);
  }
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const f = focusRef.current;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    // text fields in a sheet handle their own keys (Esc cancels an edit there)
    if (typing && (e.target as Element).closest('.sheet')) return;
    // the legend over the page takes the keys until it closes
    if (helpOn) {
      if (e.key === 'Escape' || e.key === '?') setHelpOn(false);
      // Space would press the focused button behind it
      if (e.key === 'Escape' || e.key === '?' || e.code === 'Space') e.preventDefault();
      return;
    }
    if (e.key === '?' && !typing) {
      e.preventDefault();
      setHelpOn(true);
      return;
    }
    // hold Space anywhere but in a text field to speak; the demo pauses while the owner talks
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!e.repeat) {
        panelRef.current?.querySelector('video')?.pause();
        pttRef.current.start();
      }
      return;
    }
    if (e.key === 'Escape') {
      // a screenshot shown large closes first; the card stays open
      if (document.querySelector('.lightbox')) return;
      if (typing) (e.target as HTMLElement).blur();
      if (f?.type === 'card') closeCard();
      else if (f?.type === 'project' && readingRef.current && sheetProject) readPlan(sheetProject, null);
      else if (f?.type === 'project') closeProject();
      return;
    }
    if (typing || f?.type === 'card' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '0') {
      setFocus(null);
      setSheetOn(false);
      fly(kept(overviewCam(all)), 700);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      nextAttention();
    } else if (e.key === 'n') createAtCentre();
    else if (e.key === 'k') toggleKoordinator();
    else if (e.key === 'a') toggleArchive();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', h, true);
    return () => removeEventListener('keydown', h, true);
  }, []);

  // ---------------------------------------------------------------- render
  const sheetProject = sheetId ? (items.find((i) => i.id === sheetId) ?? archived.find((i) => i.id === sheetId)) : undefined;
  const sheetKids = !sheetProject ? [] : sheetProject.archivedAt ? archived.filter((i) => i.parent === sheetProject.id) : (kidsOf.get(sheetProject.id) ?? []);
  const deps = useMemo(() => (hoverId && !panning && !dragId ? depsOf(hoverId, items) : undefined), [hoverId, panning, dragId, items]);
  const depOf = (id: string) => (!deps ? undefined : id === hoverId ? 'self' : deps.before.has(id) ? 'before' : deps.after.has(id) ? 'after' : undefined);
  const edgeTargets = placed.filter(({ item }) => needsYou(item) && (focus?.type !== 'project' || item.parent === focus.id));

  return (
    <div
      className={[cam.s < FAR && 'z-far', resizing && 'resizing'].filter(Boolean).join(' ') || undefined}
      style={
        {
          '--sheet-w': `${sheetW.sheet}px`,
          '--read-w': `${sheetW.read}px`,
          '--sheet-b': `${sheetBottom(sheetW.sheet, innerWidth)}px`,
          '--read-b': `${sheetBottom(sheetW.read, innerWidth)}px`,
        } as React.CSSProperties
      }
    >
      <div
        id="viewport"
        ref={viewportRef}
        className={panning ? 'panning' : undefined}
        style={{ backgroundSize: `${22 * cam.s}px ${22 * cam.s}px`, backgroundPosition: `${cam.x}px ${cam.y}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div id="world" style={{ transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.s})` }}>
          <TerritoryLayer {...territories} selected={ring ? placed.filter((p) => ring.ids.includes(p.item.id)).map((p) => p.b) : []} />
          <Links placed={placed} />
          {deps && <DepLinks placed={placed} edges={deps.edges} />}
          {placed.map(({ item, b }) =>
            item.kind === 'project' ? (
              <ProjectView key={item.id} item={item} b={b} kids={kidsOf.get(item.id) ?? []} onStartAll={startAll} />
            ) : (
              <CardView
                key={item.id}
                item={item}
                b={b}
                lifted={item.id === openId}
                dragging={item.id === dragId}
                pop={item.id === popId}
                prototyped={prototyped.has(item.id)}
                showRepo={snapshot.canvas.repos.length > 1}
                els={els}
                onStart={startCard}
                onArchive={archiveCard}
                dep={depOf(item.id)}
                underway={underway[item.id]}
                onHover={setHoverId}
              />
            ),
          )}
          <GroupNames shapes={territories.shapes} />
        </div>
      </div>
      {!items.length && <div className="empty">{t.empty}</div>}
      {!ring && <Lasso pts={lasso} />}
      {ring && (
        <Ring
          at={ring.at}
          count={ring.ids.length}
          groups={snapshot.groups}
          open={openPerGroup(snapshot.items)}
          onPick={(group) => assignGroup({ group })}
          onCreate={(name) => assignGroup({ name })}
          onDelete={deleteGroup}
          onClose={() => (setRing(null), setLasso([]))}
        />
      )}
      {(!focus || focus.type === 'project') && <Edges cam={cam} targets={edgeTargets} rightReserve={reserve} onOpen={open} />}
      <header id="bar">
        <Wordmark height={22} />
        <CanvasPill canvas={snapshot.canvas} canvases={canvases} waiting={waiting} />
        <button className="pill" onClick={() => focusRef.current?.type !== 'card' && createAtCentre()}>
          + {t.newCard}
        </button>
        <HelpButton on={helpOn} onClick={() => setHelpOn(!helpOn)} />
        <div className="right">
          {!online && <div className="pill offline">{t.offline}</div>}
          {online && restart && <RestartPill restart={restart} items={items} />}
          {snapshot.workspaces && <WorkspacesPill pools={snapshot.workspaces} canvas={snapshot.canvas} items={items} />}
          <button className={cOn ? 'pill kpill on' : 'pill kpill'} onClick={toggleConfig}>
            {t.config.button}
          </button>
          <button className={aOn ? 'pill kpill on' : 'pill kpill'} onClick={toggleArchive}>
            {t.archive.button}
          </button>
          <button className={kOn ? 'pill kpill on' : 'pill kpill'} onClick={toggleKoordinator}>
            {t.koordinator.button}
            {queuedCount > 0 && (
              <span className="n" title={t.koordinator.queuedCount(queuedCount)}>
                {queuedCount}
              </span>
            )}
            {proposalCount > 0 && (
              <span className="n prop" title={t.koordinator.proposalsCount(proposalCount)}>
                {proposalCount}
              </span>
            )}
          </button>
          {attention.length > 0 && (
            <button className="pill" id="attention" onClick={nextAttention}>
              <span className="n">{attention.length}</span> {t.needsYou}
            </button>
          )}
        </div>
      </header>
      <Minimap
        cam={cam}
        all={all}
        placed={placed}
        territories={territories.shapes}
        onJump={(wx, wy) => !focusRef.current && fly(viewOn(wx, wy), 500)}
        onFollow={(wx, wy) => !focusRef.current && chase(camRef.current, viewOn(wx, wy), setCam)}
      />
      <div id="dim" className={dim ? 'on' : undefined} onClick={() => closeCard()} />
      {helpOn && <Help onClose={() => setHelpOn(false)} />}
      <div id="panel" ref={panelRef}>
        <button className="close" title={t.close} onClick={() => closeCard()}>
          ✕
        </button>
        <div className="inner" ref={innerRef}>
          <div className="content">
            {openItem && (
              <Detail
                key={openItem.id}
                item={openItem}
                all={items}
                repos={snapshot.canvas.repos}
                parent={openItem.parent ? (items.find((p) => p.id === openItem.parent) ?? archived.find((p) => p.id === openItem.parent)) : undefined}
                from={openItem.from ? (items.find((p) => p.id === openItem.from) ?? archived.find((p) => p.id === openItem.from)) : undefined}
                onReadPlan={(project, mark) => readPlan(project, { mark })}
                onEdit={onEdit}
                flush={flushEdit}
                onDelete={deleteOpen}
                onDone={onDone}
                onTell={(text, images, field) => tellTyped(text, images, { card: openItem.id }, field)}
              />
            )}
          </div>
        </div>
      </div>
      <ArchiveSheet on={aOn} archived={archived} done={doneCount} onOpen={open} onArchiveDone={() => archiveDone().catch(console.error)} els={archiveEls} />
      <ConfigSheet on={cOn} onSetup={() => setSetupOn(true)} />
      {setupOn && <Setup onClose={() => setSetupOn(false)} />}
      <KoordinatorSheet on={kOn} canvas={snapshot.canvas.id} items={items} preferences={snapshot.preferences} repos={snapshot.canvas.repos} talk={snapshot.talk} reshare={snapshot.reshare} onOpen={open} onTell={(text, images) => tellTyped(text, images, null)} />
      <PushToTalk phase={ptt.phase} level={ptt.level} flat={ptt.flat} target={target} shots={voiceShots} onDown={ptt.start} />
      <Sheet
        project={sheetProject}
        kids={sheetKids}
        all={items}
        on={sheetOn}
        reading={reading}
        onOpen={open}
        onRead={(r) => sheetProject && readPlan(sheetProject, r)}
        onStartAll={startAll}
        els={sheetEls}
        version={snapshot}
      />
      <div
        id="sheet-grip"
        className={gripOn ? 'on' : undefined}
        style={{ right: SHEET_GAP + sheetW[gripKind] - 6, bottom: sheetBottom(sheetW[gripKind], innerWidth) }}
        title={t.sheetGrip}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={() => setWidths((ws) => ({ ...ws, [gripKind]: gripKind === 'sheet' ? SHEET_W : null }))}
      />
      {/* commands on their way and confirmations, stacked above the microphone */}
      <div id="acks">
        <ToldList told={told.told} open={focus?.type === 'card' ? focus.id : undefined} onUndo={told.undo} />
        <div id="ack" className={`ack${ackOn ? ' on' : ''}${ack?.wait ? ' wait' : ''}`}>
          <span>{ack?.text}</span>
          {ack?.undo && (
            <button
              onClick={() => {
                ack.undo?.();
                setAckOn(false);
              }}
            >
              {t.undo}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the unfolded card sits: centred, as tall as its content needs up to a limit, beyond which it
 * scrolls. Lays the content out at the final width to measure it, so call it with the content rendered.
 */
function panelRect(i: Item, inner: HTMLElement) {
  const tall = i.state !== 'planned' && i.state !== 'proposal';
  // a card with a conversation beside what it is about (an idea, a proposal, a task an agent worked on) gets the room of the mock's demo panel
  const wide = split(i);
  const W = Math.min(wide ? 1600 : tall ? 980 : 900, innerWidth - 80);
  inner.style.width = `${W}px`;
  inner.style.paddingBottom = '';
  inner.style.overflowY = '';
  const pad = getComputedStyle(inner);
  const base = parseFloat(pad.paddingBottom);
  const content = inner.firstElementChild as HTMLElement;
  // heights unrounded: a content half a pixel higher than its panel scrolls it
  const height = (e: HTMLElement) => e.getBoundingClientRect().height;
  const mic = (document.getElementById('ptt')?.getBoundingClientRect().top ?? innerHeight) - MIC_GAP;
  // an idea's or a task's split grows with its taller column up to the room from the top bar down
  // to the microphone: beyond that its columns scroll, and the panel itself does not
  const fill = content.querySelector<HTMLElement>('.split:not(.proposal-grid)');
  if (fill) {
    fill.style.minHeight = fill.style.maxHeight = '';
    if (getComputedStyle(fill).gridTemplateColumns.split(' ').length > 1) {
      const rest = height(content) - height(fill) + parseFloat(pad.paddingTop) + base;
      const room = Math.floor(mic - PANEL_TOP - rest);
      fill.style.minHeight = `${SPLIT_MIN}px`;
      fill.style.maxHeight = `${Math.max(SPLIT_MIN, room)}px`;
      // nothing to scroll to, so no scrollbar either; on a low window the panel scrolls past the microphone
      if (room >= SPLIT_MIN) inner.style.overflowY = 'hidden';
    }
  }
  const need = height(content) + parseFloat(pad.paddingTop) + base;
  // a proposal grows with its text as far as the screen allows
  const max = Math.min(i.state === 'proposal' || fill ? Infinity : wide ? 880 : tall ? 760 : i.source === 'manual' ? 480 : 560, innerHeight - 110);
  // in the middle of the window; a split's panel ends above the microphone, as when it fills the room
  const top = (H: number) => Math.max(PANEL_TOP, Math.min((innerHeight - H) / 2, fill ? mic - H : Infinity));
  // the microphone sits over the bottom of a tall panel: the content gets room below it to scroll
  // up past the microphone, and the panel grows by that room where it can
  const under = (H: number) => Math.max(0, top(H) + H - mic - base);
  let H = Math.min(Math.ceil(need), max);
  H = Math.min(Math.ceil(need + under(H)), max);
  const extra = under(H);
  if (extra) inner.style.paddingBottom = `${base + extra}px`;
  return { left: `${(innerWidth - W) / 2}px`, top: `${top(H)}px`, width: `${W}px`, height: `${H}px` };
}

/** Where a panel starts at the top: below the bar. */
const PANEL_TOP = 64;
/** The least height of an idea's or a task's split: on a low window the panel scrolls past the microphone instead. */
const SPLIT_MIN = 320;

/** Room between the panel's content and the microphone. */
const MIC_GAP = 12;

const rect = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** Camera centred on the middle of `b` at scale `s`, ignoring the top bar (the unfold is centred on the screen). */
const centreOnPoint = (b: Bounds, s: number): Cam => ({ s, x: innerWidth / 2 - (b.x + b.w / 2) * s, y: innerHeight / 2 - (b.y + b.h / 2) * s });
