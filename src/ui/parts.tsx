// Presentational pieces of the canvas. State and camera live in App.tsx.

import { memo, useState } from 'react';
import { type Bounds, shapeOf } from '../core/layout';
import type { CardPatch, Item } from '../core/types';
import type { Cam } from './camera';
import { Inline, plain } from './markdown';
import { stateLabel, t } from './strings';

export const needsYou = (i: Item) => i.state === 'waiting' || i.state === 'proposal';

// ------------------------------------------------------------------ cards

interface CardProps {
  item: Item;
  b: Bounds;
  lifted: boolean;
  dragging: boolean;
  pop: boolean;
  els: Map<string, HTMLElement>;
}

const sameBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const CardView = memo(
  function CardView({ item, b, lifted, dragging, pop, els }: CardProps) {
    const shape = shapeOf(item);
    const kind = item.label ?? (item.parent ? t.kind.workstream : t.kind[item.kind]);
    const meta = plain(item.body).split('\n')[0];
    const cls = ['item', 'card', shape, `s-${item.state}`, lifted && 'lifted', dragging && 'dragging', pop && 'pop'].filter(Boolean).join(' ');
    return (
      <div
        className={cls}
        data-id={item.id}
        ref={(el) => void (el ? els.set(item.id, el) : els.delete(item.id))}
        style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 2 }}
      >
        <div className="kind">
          <span>
            {item.state === 'proposal' ? t.proposalMark : ''}
            {kind}
          </span>
        </div>
        <div className={item.title ? 'ttl' : 'ttl untitled'}>{item.title ? <Inline md={item.title} /> : t.titlePlaceholder}</div>
        {meta && <div className="meta">{meta}</div>}
        <div className="state">{stateLabel(item)}</div>
        {needsYou(item) && <div className="badge pulse">{item.state === 'proposal' ? '✦' : '!'}</div>}
      </div>
    );
  },
  (a, b) => a.item === b.item && sameBounds(a.b, b.b) && a.lifted === b.lifted && a.dragging === b.dragging && a.pop === b.pop,
);

export const ProjectView = memo(
  function ProjectView({ item, b, kids }: { item: Item; b: Bounds; kids: Item[] }) {
    const live = kids.filter((k) => k.state === 'live').length;
    const waiting = kids.filter(needsYou).length;
    return (
      <div className={`item project s-${item.state}`} data-id={item.id} style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 0 }}>
        <div className="head">
          <span className="ttl">{plain(item.title)}</span>
          <span className="kind">{t.kind.project}</span>
          <span className="progress">{t.progress(live, kids.length)}</span>
        </div>
        {waiting > 0 && <div className="badge">{waiting}</div>}
      </div>
    );
  },
  (a, b) => a.item === b.item && sameBounds(a.b, b.b) && a.kids.length === b.kids.length && a.kids.every((k, i) => k === b.kids[i]),
);

// ------------------------------------------------------------------ unfolded card

export function Detail({ item, parent, onEdit, onDelete }: { item: Item; parent?: Item; onEdit: (p: CardPatch) => void; onDelete: () => void }) {
  const kind = parent ? `${plain(parent.title)} · ${item.label ?? ''} · ${t.kind.workstream}` : t.kind[item.kind];
  if (item.source === 'manual') return <ManualDetail item={item} onEdit={onEdit} onDelete={onDelete} />;
  return (
    <>
      <div className="p-kind">{kind}</div>
      <div className="p-title">
        <Inline md={item.title} />
      </div>
      <div className="p-state">● {stateLabel(item)}</div>
      <Body md={item.body} />
      {parent?.plan && (
        <p className="p-src">
          {t.fromPlan} <code>{parent.plan.file}</code>
        </p>
      )}
    </>
  );
}

function ManualDetail({ item, onEdit, onDelete }: { item: Item; onEdit: (p: CardPatch) => void; onDelete: () => void }) {
  // local drafts: the server echo must not overwrite what is being typed
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [kind, setKind] = useState(item.kind as 'feature' | 'bugfix');
  return (
    <>
      <div className="p-kind">{t.kind[kind]}</div>
      <input
        className="p-title"
        value={title}
        placeholder={t.titlePlaceholder}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
          onEdit({ title: e.target.value });
        }}
      />
      <div className="p-state">● {stateLabel(item)}</div>
      <div>
        <div className="seg">
          {(['feature', 'bugfix'] as const).map((k) => (
            <button
              key={k}
              className={k === kind ? 'on' : ''}
              onClick={() => {
                setKind(k);
                onEdit({ kind: k });
              }}
            >
              {t.kind[k]}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="p-body"
        value={body}
        placeholder={t.bodyPlaceholder}
        maxLength={20000}
        onChange={(e) => {
          setBody(e.target.value);
          onEdit({ body: e.target.value });
        }}
      />
      <div className="actions">
        <button className="btn danger" onClick={onDelete}>
          {t.delete}
        </button>
      </div>
    </>
  );
}

/** A workstream's text: paragraphs, and its sub-items as a checklist. */
function Body({ md }: { md: string }) {
  const blocks: ({ list: { text: string; mark: string }[] } | { para: string })[] = [];
  for (const line of md.split('\n')) {
    const m = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (m) {
      const last = blocks.at(-1);
      const li = { text: m[2]!, mark: m[1] === undefined ? '' : m[1] === ' ' ? 'open' : 'done' };
      if (last && 'list' in last) last.list.push(li);
      else blocks.push({ list: [li] });
    } else if (line.trim()) blocks.push({ para: line.trim() });
  }
  return (
    <>
      {blocks.map((bl, i) =>
        'para' in bl ? (
          <p key={i} className="p-lead">
            <Inline md={bl.para} />
          </p>
        ) : (
          <ul key={i} className="p-list">
            {bl.list.map((li, j) => (
              <li key={j} className={li.mark}>
                <Inline md={li.text} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

// ------------------------------------------------------------------ plan sheet

export function Sheet({ project, kids, on, onOpen }: { project?: Item; kids: Item[]; on: boolean; onOpen: (i: Item) => void }) {
  return (
    <aside id="sheet" className={on ? 'on' : ''}>
      {project?.plan && (
        <>
          <div className="p-kind">{t.planSheet}</div>
          <h2>{plain(project.title)}</h2>
          <div className="goal">
            <Inline md={project.plan.goal} />
          </div>
          <div className="src">{project.plan.file}</div>
          <ol>
            {kids.map((k) => (
              <li key={k.id} className={`s-${k.state}`} onClick={() => onOpen(k)}>
                <span className="dot" />
                <span className="w">{k.label}</span>
                <span>
                  <Inline md={k.title} />
                  <br />
                  <span className="hint">{stateLabel(k)}</span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ overlays

/** Chips at the screen edge pointing at off-screen cards that need the owner. */
export function Edges({ cam, targets, rightReserve, onOpen }: { cam: Cam; targets: { item: Item; b: Bounds }[]; rightReserve: number; onOpen: (i: Item) => void }) {
  const m = 30;
  const top = 64;
  const bottom = innerHeight - 60;
  const right = innerWidth - rightReserve - m;
  return (
    <div id="edges">
      {targets.map(({ item, b }) => {
        const cx = cam.x + (b.x + b.w / 2) * cam.s;
        const cy = cam.y + (b.y + b.h / 2) * cam.s;
        if (cx > m && cx < right && cy > top && cy < bottom) return null;
        const x = Math.min(right, Math.max(m, cx));
        const y = Math.min(bottom, Math.max(top + 10, cy));
        const ang = (Math.atan2(cy - y, cx - x) * 180) / Math.PI;
        // anchored on the side it points to, so it stays on screen
        const tx = cx >= right ? '-100%' : cx <= m ? '0%' : '-50%';
        const title = plain(item.title);
        return (
          <button key={item.id} className={`edge s-${item.state}`} style={{ left: x, top: y, transform: `translate(${tx}, -50%)` }} onClick={() => onOpen(item)}>
            <span className="arr" style={{ transform: `rotate(${ang}deg)` }}>
              ➜
            </span>
            {title.length > 30 ? title.slice(0, 28) + '…' : title}
          </button>
        );
      })}
    </div>
  );
}

export function Minimap({ cam, all, placed, onJump }: { cam: Cam; all: Bounds; placed: { item: Item; b: Bounds }[]; onJump: (wx: number, wy: number) => void }) {
  const W = 210;
  const H = 130;
  const pad = 10;
  const k = Math.min((W - 2 * pad) / all.w, (H - 2 * pad) / all.h);
  const ox = (W - all.w * k) / 2 - all.x * k;
  const oy = (H - all.h * k) / 2 - all.y * k;
  return (
    <div
      id="minimap"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump((e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k);
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`}>
        {placed.map(({ item, b }) => (
          <rect
            key={item.id}
            x={ox + b.x * k}
            y={oy + b.y * k}
            width={b.w * k}
            height={b.h * k}
            rx={item.kind === 'project' ? 4 : 1.5}
            style={{ fill: item.kind === 'project' ? 'var(--container-line)' : `var(--${item.state})` }}
            opacity={item.kind === 'project' || needsYou(item) ? 1 : 0.55}
          />
        ))}
        <rect
          x={ox + (-cam.x / cam.s) * k}
          y={oy + (-cam.y / cam.s) * k}
          width={(innerWidth / cam.s) * k}
          height={(innerHeight / cam.s) * k}
          fill="none"
          style={{ stroke: 'var(--ink)' }}
          strokeWidth={1.2}
          rx={3}
          opacity={0.5}
        />
      </svg>
    </div>
  );
}
