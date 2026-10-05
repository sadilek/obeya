// Groups on the canvas: the territories behind the cards and their names, how a territory grows
// when cards change group (here, by voice or in another page alike), and the lasso and colour ring
// that assign a group.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bounds } from '../core/layout';
import type { Group, Item } from '../core/types';
import { t } from './strings';
import { type Claim, type Territory, Territories } from './territory';

type Placed = { item: Item; b: Bounds }[];
type Pt = { x: number; y: number };

/** How long a card takes to grow into its new group, once its turn in the wave has come. */
const GROW_MS = 1100;
/** The wave reaches the cards one after the other, by their distance from where it starts (ms per world px). */
const WAVE_SPEED = 0.9;
const WAVE_MAX_DELAY = 900;
/** How long a wave and the light along the edge are shown, after their delay. */
const WAVE_MS = 1700;
/** A computation of the territories longer than this makes the next one wait (ms). */
const SLOW_MS = 8;

interface Fade {
  from?: string;
  to?: string;
  t0: number;
  delay: number;
}
export interface Wave {
  key: number;
  x: number;
  y: number;
  hue: number;
  delay: number;
}
/** A light running once along the edge of a territory that cards came into. */
export interface Streak {
  key: number;
  group: string;
  delay: number;
}
export interface Shape {
  g: Group;
  t: Territory;
}

/** Where the owner just assigned a group: the change grows from there once the server has it. */
let origin: { ids: Set<string>; at: Pt; until: number } | null = null;
export function growFrom(ids: string[], at: Pt) {
  origin = { ids: new Set(ids), at, until: performance.now() + 5000 };
}

/** Springs past 1 a little and settles: the territory grows a bit too far and draws back. */
const spring = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.exp(-5 * x) * Math.cos(9 * x));
const centre = (b: Bounds) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

let effectKey = 0;

/**
 * The territories of the groups behind the cards on the canvas (a project counts as one card, its
 * workstreams inside), animated while cards change group.
 */
export function useTerritories(placed: Placed, groups: Group[]): { shapes: Shape[]; waves: Wave[]; streaks: Streak[] } {
  const [engine] = useState(() => new Territories());
  const [fades] = useState(() => new Map<string, Fade>());
  // groups seen so far: one that went with its last card still fades out in its colour
  const [known] = useState(() => new Map<string, Group>());
  for (const g of groups) known.set(g.id, g);
  const seen = useRef<Map<string, string | undefined> | null>(null);
  const [fx, setFx] = useState<{ waves: Wave[]; streaks: Streak[] }>({ waves: [], streaks: [] });
  const [tick, setTick] = useState(0);
  const top = useMemo(() => placed.filter((p) => !p.item.parent), [placed]);

  const signature = top.map((p) => `${p.item.id}:${p.item.group ?? ''}`).join(',');
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = new Map(top.map((p) => [p.item.id, p.item.group]));
    // what the page loads with is there at once
    if (!before) return;
    const changed = top.filter((p) => before.get(p.item.id) !== p.item.group);
    if (!changed.length) return;
    const now = performance.now();
    const mine = origin && origin.until > now && changed.some((p) => origin!.ids.has(p.item.id));
    const centres = changed.map((p) => centre(p.b));
    const from = mine ? origin!.at : { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length };
    if (mine) origin = null;
    const waves: Wave[] = [];
    const streaks = new Map<string, Streak>();
    let last = 0;
    changed.forEach((p, n) => {
      const c = centres[n]!;
      const delay = Math.min(WAVE_MAX_DELAY, Math.hypot(c.x - from.x, c.y - from.y) * WAVE_SPEED);
      const to = p.item.group;
      fades.set(p.item.id, { from: before.get(p.item.id), to, t0: now, delay });
      last = Math.max(last, delay);
      const g = to ? known.get(to) : undefined;
      if (!g) return;
      waves.push({ key: ++effectKey, ...c, hue: g.hue, delay });
      const s = streaks.get(g.id);
      if (!s || s.delay > delay) streaks.set(g.id, { key: ++effectKey, group: g.id, delay: delay + 250 });
    });
    const added = new Set([...waves.map((w) => w.key), ...[...streaks.values()].map((s) => s.key)]);
    setFx((f) => ({ waves: [...f.waves, ...waves], streaks: [...f.streaks, ...streaks.values()] }));
    setTimeout(
      () => setFx((f) => ({ waves: f.waves.filter((w) => !added.has(w.key)), streaks: f.streaks.filter((s) => !added.has(s.key)) })),
      last + WAVE_MS + 300,
    );
    setTick((n) => n + 1);
  }, [signature]);

  // while cards grow, every frame; at rest, nothing
  useEffect(() => {
    if (!fades.size) return;
    const frame = requestAnimationFrame(() => {
      const now = performance.now();
      for (const [id, f] of fades) if (now - f.t0 - f.delay > GROW_MS) fades.delete(id);
      setTick((n) => n + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [tick]);

  // a computation that took long leaves the next frames to the cards: the territories follow a dragged
  // card a little less often, and catch up once it rests
  const last = useRef<{ at: number; shapes: Shape[]; later?: ReturnType<typeof setTimeout> }>({ at: -Infinity, shapes: [] });
  const shapes = useMemo(() => {
    const now = performance.now();
    const pause = engine.last.ms > SLOW_MS ? engine.last.ms * 1.5 : 0;
    clearTimeout(last.current.later);
    if (now - last.current.at < pause) {
      last.current.later = setTimeout(() => setTick((n) => n + 1), pause - (now - last.current.at));
      return last.current.shapes;
    }
    const fading = new Set<string>();
    const claims: Claim[] = top.map(({ item, b }) => {
      const f = fades.get(item.id);
      if (!f) return { id: item.id, b, w: item.group ? { [item.group]: 1 } : {} };
      const p = spring((now - f.t0 - f.delay) / GROW_MS);
      const w: Record<string, number> = {};
      if (f.to) w[f.to] = p;
      if (f.from) (w[f.from] = Math.max(0, 1 - p)), fading.add(f.from);
      return { id: item.id, b, w };
    });
    const ids = [...groups.map((g) => g.id), ...[...fading].filter((id) => !groups.some((g) => g.id === id) && known.has(id))];
    const shapes = engine.compute(claims, ids).map((x) => ({ g: known.get(x.group)!, t: x }));
    last.current = { at: now, shapes };
    return shapes;
  }, [top, groups, tick]);
  useEffect(() => () => clearTimeout(last.current.later), []);

  return { shapes, ...fx };
}

const hue = (h: number) => ({ '--h': h }) as React.CSSProperties;

/** The territories, in world coordinates under the cards; `selected`: the cards the colour ring is for. */
export function TerritoryLayer({ shapes, waves, streaks, selected }: { shapes: Shape[]; waves: Wave[]; streaks: Streak[]; selected: Bounds[] }) {
  return (
    <svg id="territories" width="1" height="1">
      {shapes.map(({ g, t: x }) => (
        <g key={g.id} className="terr" style={hue(g.hue)}>
          <path className="area" d={x.main} fillRule="evenodd" />
          <path className="glow" d={x.main} />
          <path className="edge" d={x.main} />
          <path className="inner" d={x.inner} />
          {streaks
            .filter((s) => s.group === g.id)
            .map((s) => (
              <path key={s.key} className="streak" d={x.main} pathLength={100} style={{ animationDelay: `${s.delay}ms` }} />
            ))}
        </g>
      ))}
      {waves.map((w) => (
        <circle key={w.key} className="wave" cx={w.x} cy={w.y} style={{ ...hue(w.hue), animationDelay: `${w.delay}ms` }} />
      ))}
      {selected.map((b, n) => (
        <rect key={n} className="sel" x={b.x - 7} y={b.y - 7} width={b.w + 14} height={b.h + 14} rx={16} />
      ))}
    </svg>
  );
}

/** The groups' names over their territories, shown when zoomed far out. */
export function GroupNames({ shapes }: { shapes: Shape[] }) {
  return (
    <svg id="gnames" width="1" height="1">
      {shapes.map(
        ({ g, t: x }) =>
          x.label && (
            <text key={g.id} className="gname" x={x.label.x} y={x.label.y} style={{ ...hue(g.hue), fontSize: `calc(${x.labelSize}px / var(--s))` }}>
              {g.name}
            </text>
          ),
      )}
    </svg>
  );
}

// ------------------------------------------------------------------ lasso

/** The lasso the owner draws with Shift held, in screen coordinates. */
export function Lasso({ pts }: { pts: Pt[] }) {
  if (pts.length < 2) return null;
  const d = `M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`;
  const head = pts[pts.length - 1]!;
  return (
    <svg id="lasso">
      <path className="lfill" d={d} />
      <path className="lglow" d={d} />
      <path className="lline" d={d} />
      <circle className="lhead" cx={head.x} cy={head.y} r={5} />
    </svg>
  );
}

/** Whether `p` lies inside the polygon. */
export function inside(p: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ------------------------------------------------------------------ colour ring

type Ball = { kind: 'group'; g: Group } | { kind: 'new' } | { kind: 'none' };
const RADIUS = 84;
const RING_MARGIN = 120;

/**
 * A ring of colour balls around `at` (screen): the groups, a new one, none. Moving towards a ball
 * picks it, a click takes it; a new group asks for its name first.
 */
export function Ring({
  at: pointer,
  count,
  groups,
  onPick,
  onCreate,
  onClose,
}: {
  at: Pt;
  count: number;
  groups: Group[];
  onPick: (group: string | null) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  // the ring stays clear of the screen's edges and the bar
  const at = { x: Math.min(Math.max(pointer.x, RING_MARGIN), innerWidth - RING_MARGIN), y: Math.min(Math.max(pointer.y, RING_MARGIN + 50), innerHeight - RING_MARGIN) };
  const balls: Ball[] = [...groups.map((g) => ({ kind: 'group' as const, g })), { kind: 'new' }, { kind: 'none' }];
  const [hot, setHot] = useState(-1);
  const [naming, setNaming] = useState(false);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const angle = (k: number) => -Math.PI / 2 + (k * 2 * Math.PI) / balls.length;
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    // Escape closes the ring before anything else hears it
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    addEventListener('keydown', key, true);
    return () => (cancelAnimationFrame(frame), removeEventListener('keydown', key, true));
  }, []);
  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);
  /** The ball in the direction of the pointer; none near the middle. */
  function aimed(e: React.PointerEvent): number {
    const dx = e.clientX - at.x;
    const dy = e.clientY - at.y;
    if (Math.hypot(dx, dy) < 30) return -1;
    const a = Math.atan2(dy, dx);
    let best = 0;
    let bd = Infinity;
    balls.forEach((_, k) => {
      const d = Math.abs(Math.atan2(Math.sin(a - angle(k)), Math.cos(a - angle(k))));
      if (d < bd) [bd, best] = [d, k];
    });
    return best;
  }
  // a click picks where it is, also when no move came before it
  function pick(k: number) {
    const b = balls[k];
    if (!b) return onClose();
    if (b.kind === 'new') return setNaming(true);
    onPick(b.kind === 'group' ? b.g.id : null);
  }
  const hb = balls[hot];
  const caption = naming ? '' : !hb ? t.groups.cards(count) : hb.kind === 'group' ? hb.g.name : hb.kind === 'new' ? t.groups.create : t.groups.none;
  return (
    <div id="ringback" onPointerMove={(e) => naming || setHot(aimed(e))} onPointerDown={(e) => (e.preventDefault(), naming ? onClose() : pick(aimed(e)))} onContextMenu={(e) => e.preventDefault()}>
      <div className={`ring${open ? ' open' : ''}`} style={{ left: at.x, top: at.y }}>
        <div className="rhalo" />
        {balls.map((b, k) => (
          <div
            key={b.kind === 'group' ? b.g.id : b.kind}
            className={`ball ${b.kind}${k === hot ? ' hot' : ''}`}
            aria-label={b.kind === 'group' ? b.g.name : b.kind === 'new' ? t.groups.create : t.groups.none}
            style={
              {
                '--h': b.kind === 'group' ? b.g.hue : 0,
                '--bx': `${Math.cos(angle(k)) * RADIUS}px`,
                '--by': `${Math.sin(angle(k)) * RADIUS}px`,
                transitionDelay: `${k * 28}ms`,
              } as React.CSSProperties
            }
          >
            {b.kind === 'new' ? '+' : b.kind === 'none' ? '∅' : ''}
          </div>
        ))}
        <div className="rcap">{caption}</div>
        {naming && (
          <input
            ref={input}
            className="rname"
            placeholder={t.groups.name}
            maxLength={60}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // typing, Space included, is for the name, not push-to-talk or the canvas's keys
              e.stopPropagation();
              const name = e.currentTarget.value.trim();
              if (e.key === 'Enter' && name) onCreate(name);
            }}
          />
        )}
      </div>
    </div>
  );
}
