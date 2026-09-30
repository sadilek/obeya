// The canvas: camera, drag, unfold-in-place and the plan sheet, grown from design/mock/.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Bounds, boundsOf, CARD_SIZE, PROJECT_HEAD, PROJECT_PAD, unionBounds } from '../core/layout';
import type { CanvasSnapshot, CardPatch, Item } from '../core/types';
import { api, useCanvas } from './api';
import { type Cam, camFor, centreOn, FAR, flyTo, MAX_ZOOM, MIN_ZOOM, overviewCam, stopFlight, toWorld } from './camera';
import { plain } from './markdown';
import { type ActDone, Detail } from './detail';
import { CardView, Edges, Links, Minimap, needsYou, ProjectView, Sheet } from './parts';
import { t } from './strings';

export function App() {
  const { snapshot, online } = useCanvas();
  if (!snapshot) return online ? null : <div className="empty">{t.offline}</div>;
  return <Canvas snapshot={snapshot} online={online} />;
}

type Focus = { type: 'project'; id: string; prevCam: Cam } | { type: 'card'; id: string; prevCam: Cam; project: Focus | null };
type Pos = { x: number; y: number };

const SHEET_W = 410;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const camKey = (canvasId: string) => `obeya-cam-${canvasId}`;

function Canvas({ snapshot, online }: { snapshot: CanvasSnapshot; online: boolean }) {
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
  const flushEdit = () => {
    const e = edit.current;
    if (!e) return;
    clearTimeout(e.timer);
    edit.current = null;
    if (Object.keys(e.patch).length) api.patch(e.id, e.patch).catch(console.error);
  };
  // the open card's title as typed, which the snapshot may not carry yet
  const openTitle = useRef('');
  const onEdit = (p: CardPatch) => {
    const id = focusRef.current?.id;
    if (!id) return;
    if (p.title !== undefined) openTitle.current = p.title;
    if (edit.current?.id !== id) flushEdit();
    const e = (edit.current ??= { id, patch: {} });
    Object.assign(e.patch, p);
    clearTimeout(e.timer);
    e.timer = setTimeout(flushEdit, 400);
  };

  async function open(i: Item) {
    const f = focusRef.current;
    if (f?.type === 'card') return;
    if (i.kind === 'project') return openProject(i);
    setFocus({ type: 'card', id: i.id, prevCam: camRef.current, project: f });
    openTitle.current = i.title;
    // bring the card to the middle at a readable scale first, so the unfold starts where the eye is
    const b = bounds(i);
    await fly(centreOnPoint(b, Math.max(camRef.current.s, 0.85)), 520);
    const el = els.get(i.id);
    const panel = panelRef.current;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    flushSync(() => setOpenId(i.id));
    panel.style.setProperty('--c', `var(--${i.state})`);
    panel.className = '';
    Object.assign(panel.style, rect(r), { display: 'block', borderRadius: '14px' });
    panel.getBoundingClientRect();
    panel.classList.add('anim');
    panel.style.borderRadius = '18px';
    fitPanel(i);
    unfolded.current = true;
    setDim(true);
    setSheetOn(false);
    await sleep(450);
    panel.classList.add('ready');
    const title = panel.querySelector<HTMLInputElement>('input.p-title');
    if (title && !title.value) title.focus();
  }

  // a card that starts or finishes work while open changes its width and colour: resize in place
  const openItem = openId ? items.find((i) => i.id === openId) : undefined;
  const openState = openItem && `${openItem.state}:${openItem.need ?? ''}`;
  useEffect(() => {
    const panel = panelRef.current;
    const i = openId ? byId(openId) : undefined;
    if (!panel || !i || !unfolded.current) return;
    panel.style.setProperty('--c', `var(--${i.state})`);
    fitPanel(i);
  }, [openState]);
  // content that grows or shrinks (a log loading, a question arriving, a resized text box) resizes it too
  useEffect(() => {
    const content = innerRef.current?.firstElementChild;
    if (!openId || !content) return;
    const ro = new ResizeObserver(() => {
      const i = byId(openId);
      if (i && unfolded.current) fitPanel(i);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [openId]);

  function onDone(d: ActDone) {
    if (!d.close) return;
    closeCard({ keepUntitled: true });
    showAck(d.ack);
  }

  async function closeCard({ keepUntitled = false } = {}) {
    const f = focusRef.current;
    const panel = panelRef.current;
    if (f?.type !== 'card' || !panel) return;
    flushEdit();
    const i = byId(f.id);
    const el = els.get(f.id);
    unfolded.current = false;
    panel.classList.remove('ready');
    if (el) Object.assign(panel.style, rect(el.getBoundingClientRect()), { borderRadius: '14px' });
    setDim(false);
    await sleep(430);
    panel.style.display = 'none';
    panel.className = '';
    setOpenId(null);
    setFocus(f.project);
    if (f.project) setSheetOn(true);
    // a new card left without a title was not wanted
    if (!keepUntitled && i?.source === 'manual' && !openTitle.current.trim()) api.remove(i.id).catch(console.error);
    await fly(f.prevCam, 480);
  }

  async function openProject(p: Item) {
    const f = focusRef.current;
    setFocus({ type: 'project', id: p.id, prevCam: f?.type === 'project' ? f.prevCam : camRef.current });
    setSheetId(p.id);
    setSheetOn(true);
    await fly(camFor(bounds(p), 40, SHEET_W, 60), 700);
  }

  async function closeProject() {
    const f = focusRef.current;
    if (f?.type !== 'project') return;
    setFocus(null);
    setSheetOn(false);
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
  function showAck(text: string, undo?: () => unknown) {
    setAck({ text, undo });
    setAckOn(true);
    clearTimeout(ackTimer.current);
    ackTimer.current = setTimeout(() => setAckOn(false), 7000);
  }

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
    if (e.key === 'Escape') {
      if (typing) (e.target as HTMLElement).blur();
      if (f?.type === 'card') closeCard();
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
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', h, true);
    return () => removeEventListener('keydown', h, true);
  }, []);

  // ---------------------------------------------------------------- render
  const sheetProject = sheetId ? items.find((i) => i.id === sheetId) : undefined;
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
              <CardView key={item.id} item={item} b={b} lifted={item.id === openId} dragging={item.id === dragId} pop={item.id === popId} els={els} />
            ),
          )}
        </div>
      </div>
      {!items.length && <div className="empty">{t.empty}</div>}
      {(!focus || focus.type === 'project') && <Edges cam={cam} targets={edgeTargets} rightReserve={focus ? SHEET_W : 0} onOpen={open} />}
      <header id="bar">
        <div className="pill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="8" r="2.5" />
            <path d="M6 8.5v7M18 10.5c0 4-6 3-10 6" />
          </svg>
          <b>{snapshot.canvas.name}</b>
          <span className="hint">{snapshot.canvas.branch}</span>
        </div>
        <div className="pill">
          <b>Obeya</b>
        </div>
        <button className="pill" onClick={() => focusRef.current?.type !== 'card' && createAtCentre()}>
          + {t.newCard}
        </button>
        <span className="hint" id="keys">
          {t.keys}
        </span>
        {!online && <div className="pill offline">{t.offline}</div>}
        {attention.length > 0 && (
          <button className="pill" id="attention" onClick={nextAttention}>
            <span className="n">{attention.length}</span> {t.needsYou}
          </button>
        )}
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
                parent={openItem.parent ? items.find((p) => p.id === openItem.parent) : undefined}
                from={openItem.from ? items.find((p) => p.id === openItem.from) : undefined}
                onEdit={onEdit}
                onDelete={deleteOpen}
                onDone={onDone}
              />
            )}
          </div>
        </div>
      </div>
      <Sheet project={sheetProject} kids={sheetProject ? (kidsOf.get(sheetProject.id) ?? []) : []} on={sheetOn} onOpen={open} />
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
  const W = Math.min(tall ? 980 : 900, innerWidth - 80);
  inner.style.width = `${W}px`;
  const pad = getComputedStyle(inner);
  const need = (inner.firstElementChild as HTMLElement).offsetHeight + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  const H = Math.min(Math.ceil(need), tall ? 760 : i.source === 'manual' ? 480 : 560, innerHeight - 110);
  return { left: `${(innerWidth - W) / 2}px`, top: `${Math.max(64, (innerHeight - H) / 2)}px`, width: `${W}px`, height: `${H}px` };
}

const rect = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** Camera centred on the middle of `b` at scale `s`, ignoring the top bar (the unfold is centred on the screen). */
const centreOnPoint = (b: Bounds, s: number): Cam => ({ s, x: innerWidth / 2 - (b.x + b.w / 2) * s, y: innerHeight / 2 - (b.y + b.h / 2) * s });
