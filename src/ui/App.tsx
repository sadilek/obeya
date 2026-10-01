// The canvas: camera, drag, unfold-in-place and the plan sheet, grown from design/mock/.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Bounds, boundsOf, CARD_SIZE, PROJECT_HEAD, PROJECT_PAD, unionBounds } from '../core/layout';
import type { CanvasInfo, CanvasSnapshot, CardPatch, Item } from '../core/types';
import { api, onSpeak, setCanvas, useCanvas } from './api';
import { type Cam, camFor, centreOn, FAR, flyTo, MAX_ZOOM, MIN_ZOOM, overviewCam, stopFlight, toWorld } from './camera';
import { plain } from './markdown';
import { type ActDone, Detail } from './detail';
import { ArchiveSheet } from './archive';
import { KoordinatorSheet } from './koordinator';
import { imageFiles, useShotInput } from './shots';
import { type Heard, PushToTalk, play, usePushToTalk, type Where } from './voice';
import { CanvasPill, CardView, Edges, Links, Minimap, needsYou, ProjectView, readingWidth, Sheet } from './parts';
import { t } from './strings';

export function App() {
  const [canvases, setCanvases] = useState<CanvasInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.canvases().then(setCanvases, () => setFailed(true));
  }, []);
  if (!canvases) return failed ? <div className="empty">{t.offline}</div> : null;
  // the canvas in the address, else the first
  const wanted = new URLSearchParams(location.search).get('c');
  const current = canvases.find((c) => c.id === wanted) ?? canvases[0];
  if (!current) return <div className="empty">{t.noCanvas}</div>;
  setCanvas(current.id);
  return <Live canvases={canvases} />;
}

function Live({ canvases }: { canvases: CanvasInfo[] }) {
  const { snapshot, online } = useCanvas();
  if (!snapshot) return online ? null : <div className="empty">{t.offline}</div>;
  return <Canvas snapshot={snapshot} online={online} canvases={canvases} />;
}

type Focus = { type: 'project'; id: string; prevCam: Cam } | { type: 'card'; id: string; prevCam: Cam; project: Focus | null };
type Pos = { x: number; y: number };

const SHEET_W = 410;
// opening a card takes FLY_MS + UNFOLD_MS (300 ms) and closing the same: fast, yet still a visible move
const FLY_MS = 130;
const UNFOLD_MS = 170;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const camKey = (canvasId: string) => `obeya-cam-${canvasId}`;

function Canvas({ snapshot, online, canvases }: { snapshot: CanvasSnapshot; online: boolean; canvases: CanvasInfo[] }) {
  // ---------------------------------------------------------------- items
  // Local positions win over the snapshot until the server echoes them back.
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  // Cards created here, until the snapshot carries them.
  const [pending, setPending] = useState<Item[]>([]);
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
  }, [snapshot]);

  const items = useMemo(() => {
    const all = [...snapshot.items, ...pending];
    return all.map((i) => (moved[i.id] ? { ...i, ...moved[i.id] } : i));
  }, [snapshot, pending, moved]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const placed = useMemo(() => items.map((item) => ({ item, b: boundsOf(item, items) })), [items]);
  const kidsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) if (i.parent) m.set(i.parent, [...(m.get(i.parent) ?? []), i]);
    return m;
  }, [items]);
  const all: Bounds = useMemo(() => unionBounds(placed.map((p) => p.b)) ?? { x: 0, y: 0, w: 1000, h: 600 }, [placed]);
  const byId = (id: string) => itemsRef.current.find((i) => i.id === id);
  const bounds = (i: Item) => boundsOf(i, itemsRef.current);

  // ---------------------------------------------------------------- camera
  const [cam, setCamState] = useState<Cam>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(camKey(snapshot.canvas.id)) ?? 'null');
      if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) return saved;
    } catch {}
    return centreOn(all, 1);
  });
  const camRef = useRef(cam);
  const setCam = useCallback((c: Cam) => {
    camRef.current = c;
    setCamState(c);
  }, []);
  const fly = (to: Cam, ms?: number) => flyTo(camRef.current, to, setCam, ms);
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
  const [, setTick] = useState(0);
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
  const [kOn, setKOn] = useState(false);
  const toggleKoordinator = () => {
    if (!kOn && focusRef.current?.type === 'project') closeProject();
    setKOn(!kOn);
    setAOn(false);
  };
  const [aOn, setAOn] = useState(false);
  const toggleArchive = () => {
    if (!aOn && focusRef.current?.type === 'project') closeProject();
    setAOn(!aOn);
    setKOn(false);
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

  async function open(i: Item) {
    const f = focusRef.current;
    if (f?.type === 'card') return;
    if (i.kind === 'project') return openProject(i);
    setFocus({ type: 'card', id: i.id, prevCam: camRef.current, project: f });
    openTitle.current = i.title;
    setOpened(i.archivedAt ? i : null);
    // bring the card to the middle at a readable scale first, so the unfold starts where the eye is;
    // an archived card is not on the canvas and unfolds from its row in the archive
    if (!i.archivedAt) await fly(centreOnPoint(bounds(i), Math.max(camRef.current.s, 0.85)), FLY_MS);
    const el = fromEl(i.id, !!f);
    const panel = panelRef.current;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    flushSync(() => setOpenId(i.id));
    panel.style.setProperty('--c', `var(--${i.state})`);
    panel.className = '';
    panel.style.setProperty('--unfold', `${UNFOLD_MS}ms`);
    Object.assign(panel.style, rect(r), { display: 'block', borderRadius: '14px' });
    panel.getBoundingClientRect();
    panel.classList.add('anim');
    panel.style.borderRadius = '18px';
    fitPanel(i);
    unfolded.current = true;
    setDim(true);
    setSheetOn(false);
    await sleep(UNFOLD_MS);
    panel.classList.add('ready');
    const title = panel.querySelector<HTMLInputElement>('input.p-title');
    if (title && !title.value) title.focus();
  }

  // a card that starts or finishes work while open changes its width and colour: resize in place
  const openItem = openId
    ? (items.find((i) => i.id === openId) ?? archived.find((i) => i.id === openId) ?? (opened?.id === openId ? opened : undefined))
    : undefined;
  const openState = openItem && `${openItem.state}:${openItem.need ?? ''}`;
  useEffect(() => {
    const panel = panelRef.current;
    const i = openItem;
    if (!panel || !i || !unfolded.current) return;
    panel.style.setProperty('--c', `var(--${i.state})`);
    fitPanel(i);
  }, [openState]);
  // content that grows or shrinks (a log loading, a question arriving, a resized text box) resizes it too
  useEffect(() => {
    const content = innerRef.current?.firstElementChild;
    if (!openId || !content) return;
    const ro = new ResizeObserver(() => {
      const i = byId(openId) ?? archivedRef.current.find((x) => x.id === openId);
      if (i && unfolded.current) fitPanel(i);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [openId]);

  // the open card went away on the server (cut into packages, deleted elsewhere): fold the panel
  useEffect(() => {
    if (openId && !openItem && focusRef.current?.type === 'card') closeCard({ keepUntitled: true });
  }, [openId, openItem]);

  function onDone(d: ActDone) {
    if (!d.close) return;
    closeCard({ keepUntitled: true });
    showAck(d.ack, d.undo);
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
  }

  async function openProject(p: Item) {
    const f = focusRef.current;
    setFocus({ type: 'project', id: p.id, prevCam: f?.type === 'project' ? f.prevCam : camRef.current });
    setSheetId(p.id);
    setReading(null);
    setSheetOn(true);
    setKOn(false);
    setAOn(false);
    // an archived project is not on the canvas: its sheet takes the archive's place
    if (!p.archivedAt) await fly(camFor(bounds(p), 40, SHEET_W, 60), 700);
  }

  /** Reads the project's plan doc in the sheet, at the workstream `mark`; `null` goes back to the workstreams. */
  async function readPlan(p: Item, r: { mark?: string } | null) {
    if (focusRef.current?.type === 'card') await closeCard();
    const f = focusRef.current;
    setFocus({ type: 'project', id: p.id, prevCam: f?.type === 'project' ? f.prevCam : camRef.current });
    setSheetId(p.id);
    setReading(r);
    setSheetOn(true);
    setKOn(false);
    setAOn(false);
    // the project stays in view beside the wider sheet
    await fly(camFor(bounds(p), 40, r ? readingWidth() + 30 : SHEET_W, 60), 700);
  }

  async function closeProject() {
    const f = focusRef.current;
    if (f?.type !== 'project') return;
    setFocus(null);
    setSheetOn(false);
    // back to the archive it was opened from
    if (archivedRef.current.some((i) => i.id === f.id) && !itemsRef.current.some((i) => i.id === f.id)) setAOn(true);
    await fly(f.prevCam, 600);
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
    const [w, h] = CARD_SIZE.feature;
    const card = await api.create({ kind: 'feature', title: '', x: Math.round(world.x - w / 2), y: Math.round(world.y - h / 2) });
    flushSync(() => {
      setPending((p) => [...p, card]);
      setPopId(card.id);
    });
    await open(card);
  }
  const createAtCentre = () => createAt(toWorld(camRef.current, innerWidth / 2, innerHeight / 2));

  // ---------------------------------------------------------------- acknowledgement with undo
  const [ack, setAck] = useState<{ text: string; undo?: () => unknown } | null>(null);
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

  // ---------------------------------------------------------------- voice
  const where = (): Where => {
    const f = focusRef.current;
    return f?.type === 'card' ? { card: f.id } : f?.type === 'project' ? { project: f.id } : null;
  };
  // a command that makes a card: when it appears, the camera goes there
  const newCardWatch = useRef<{ known: Set<string>; until: number } | null>(null);
  function onHeard(h: Heard) {
    // said to the open idea: the conversation shows it
    if (h.quiet) return;
    showAck(
      h.confirm,
      h.token
        ? async () => {
            const { undone } = await api.undo(h.token!);
            if (!undone) showAck(t.voice.tooLate);
          }
        : undefined,
      h.undoMs,
    );
    play(h.audio);
    if (h.token && !focusRef.current) newCardWatch.current = { known: new Set(itemsRef.current.map((i) => i.id)), until: Date.now() + 20_000 };
  }
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
  const ptt = usePushToTalk(where, onHeard, voiceShots);
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
      ? (focusItem?.state === 'idea' ? t.voice.idea : t.voice.card)(plain(focusItem?.title ?? ''))
      : focus?.type === 'project'
        ? t.voice.project(plain(focusItem?.title ?? ''))
        : t.voice.koordinator;

  // ---------------------------------------------------------------- pointer: pan, drag, click
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; cam: Cam } | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; start: Pos; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (focusRef.current?.type === 'card' || e.button !== 0) return;
    stopFlight();
    const el = (e.target as Element).closest<HTMLElement>('.item');
    // a project moves by its header; its body is canvas, so dragging there pans
    if (el && (!el.classList.contains('project') || (e.target as Element).closest('.head'))) {
      const i = byId(el.dataset.id!);
      if (!i) return;
      dragRef.current = { id: i.id, x: e.clientX, y: e.clientY, start: { x: i.x, y: i.y }, moved: false };
    } else {
      panRef.current = { x: e.clientX, y: e.clientY, cam: camRef.current };
      setPanning(true);
    }
    viewportRef.current!.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const s = camRef.current.s;
    if (d) {
      const dx = (e.clientX - d.x) / s;
      const dy = (e.clientY - d.y) / s;
      if (!d.moved && Math.hypot(dx * s, dy * s) < 5) return;
      if (!d.moved) setDragId(d.id);
      d.moved = true;
      const i = byId(d.id);
      let p = { x: Math.round(d.start.x + dx), y: Math.round(d.start.y + dy) };
      // workstreams stay inside their project
      if (i?.parent) p = { x: Math.max(PROJECT_PAD, p.x), y: Math.max(PROJECT_HEAD, p.y) };
      setMoved((m) => ({ ...m, [d.id]: p }));
      return;
    }
    const p = panRef.current;
    if (p) setCam({ ...p.cam, x: p.cam.x + e.clientX - p.x, y: p.cam.y + e.clientY - p.y });
  }

  function onPointerUp() {
    const d = dragRef.current;
    if (d) {
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
        setCam({ s, x: e.clientX - (e.clientX - c.x) * (s / c.s), y: e.clientY - (e.clientY - c.y) * (s / c.s) });
      } else setCam({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY });
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [setCam]);

  // ---------------------------------------------------------------- keys
  const attention = items.filter(needsYou);
  const queuedCount = items.filter((i) => i.state === 'planned' && i.queue).length;
  const doneCount = items.filter((i) => i.source === 'manual' && i.state === 'live').length;
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
      fly(overviewCam(all), 700);
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
  const edgeTargets = placed.filter(({ item }) => needsYou(item) && (focus?.type !== 'project' || item.parent === focus.id));

  return (
    <div className={cam.s < FAR ? 'z-far' : undefined}>
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
      >
        <div id="world" style={{ transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.s})` }}>
          <Links placed={placed} />
          {placed.map(({ item, b }) =>
            item.kind === 'project' ? (
              <ProjectView key={item.id} item={item} b={b} kids={kidsOf.get(item.id) ?? []} />
            ) : (
              <CardView
                key={item.id}
                item={item}
                b={b}
                lifted={item.id === openId}
                dragging={item.id === dragId}
                pop={item.id === popId}
                showRepo={snapshot.canvas.repos.length > 1}
                els={els}
              />
            ),
          )}
        </div>
      </div>
      {!items.length && <div className="empty">{t.empty}</div>}
      {(!focus || focus.type === 'project') && <Edges cam={cam} targets={edgeTargets} rightReserve={focus || kOn || aOn ? (reading && focus?.type === 'project' ? readingWidth() + 30 : SHEET_W) : 0} onOpen={open} />}
      <header id="bar">
        <CanvasPill canvas={snapshot.canvas} canvases={canvases} />
        {snapshot.canvas.name.toLowerCase() !== 'obeya' && (
          <div className="pill">
            <b>Obeya</b>
          </div>
        )}
        <button className="pill" onClick={() => focusRef.current?.type !== 'card' && createAtCentre()}>
          + {t.newCard}
        </button>
        <span className="hint" id="keys">
          {t.keys}
        </span>
        <div className="right">
          {!online && <div className="pill offline">{t.offline}</div>}
          <button className={aOn ? 'pill kpill on' : 'pill kpill'} onClick={toggleArchive}>
            {t.archive.button}
          </button>
          <button className={kOn ? 'pill kpill on' : 'pill kpill'} onClick={toggleKoordinator}>
            {t.koordinator.button}
            {queuedCount > 0 && <span className="n">{queuedCount}</span>}
          </button>
          {attention.length > 0 && (
            <button className="pill" id="attention" onClick={nextAttention}>
              <span className="n">{attention.length}</span> {t.needsYou}
            </button>
          )}
        </div>
      </header>
      <Minimap cam={cam} all={all} placed={placed} onJump={(wx, wy) => !focusRef.current && fly({ s: camRef.current.s, x: innerWidth / 2 - wx * camRef.current.s, y: innerHeight / 2 - wy * camRef.current.s }, 500)} />
      <div id="dim" className={dim ? 'on' : undefined} onClick={() => closeCard()} />
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
                from={openItem.from ? items.find((p) => p.id === openItem.from) : undefined}
                onReadPlan={(project, mark) => readPlan(project, { mark })}
                onEdit={onEdit}
                flush={flushEdit}
                onDelete={deleteOpen}
                onDone={onDone}
              />
            )}
          </div>
        </div>
      </div>
      <ArchiveSheet on={aOn} archived={archived} done={doneCount} onOpen={open} onArchiveDone={() => archiveDone().catch(console.error)} els={archiveEls} />
      <KoordinatorSheet on={kOn} items={items} preferences={snapshot.preferences} talk={snapshot.talk} onOpen={open} onHeard={onHeard} />
      <PushToTalk phase={ptt.phase} level={ptt.level} target={target} shots={voiceShots} onDown={ptt.start} />
      <Sheet
        project={sheetProject}
        kids={sheetKids}
        on={sheetOn}
        reading={reading}
        onOpen={open}
        onRead={(r) => sheetProject && readPlan(sheetProject, r)}
        els={sheetEls}
        version={snapshot}
      />
      <div id="ack" className={ackOn ? 'on' : undefined}>
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
  );
}

/**
 * Where the unfolded card sits: centred, as tall as its content needs up to a limit, beyond which it
 * scrolls. Lays the content out at the final width to measure it, so call it with the content rendered.
 */
function panelRect(i: Item, inner: HTMLElement) {
  const tall = i.state !== 'planned' && i.state !== 'proposal';
  // a demo gets the room of the mock's demo panel, and so does an idea's brief beside its conversation
  const demo = (i.state === 'waiting' && i.need === 'demo') || i.state === 'idea';
  const W = Math.min(demo ? 1120 : tall ? 980 : 900, innerWidth - 80);
  inner.style.width = `${W}px`;
  const pad = getComputedStyle(inner);
  const need = (inner.firstElementChild as HTMLElement).offsetHeight + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  const H = Math.min(Math.ceil(need), demo ? 880 : tall ? 760 : i.source === 'manual' ? 480 : 560, innerHeight - 110);
  return { left: `${(innerWidth - W) / 2}px`, top: `${Math.max(64, (innerHeight - H) / 2)}px`, width: `${W}px`, height: `${H}px` };
}

const rect = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** Camera centred on the middle of `b` at scale `s`, ignoring the top bar (the unfold is centred on the screen). */
const centreOnPoint = (b: Bounds, s: number): Cam => ({ s, x: innerWidth / 2 - (b.x + b.w / 2) * s, y: innerHeight / 2 - (b.y + b.h / 2) * s });
