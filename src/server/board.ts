// The canvas of one repository: stored cards merged with what the plan docs say.
//
// Plan docs are read, never written. Their projects and workstreams get a stored row the first
// time they appear, so the owner's placement survives; title, text and state always come from the
// doc. A row whose doc or workstream is gone stays stored but is not shown.

import { boundsOf, GAP, PROJECT_HEAD, placeProjects, placeWorkstreams, projectSize, sizeOf, unionBounds } from '../core/layout';
import type { PlanDoc } from '../core/plan-doc';
import { type CanvasInfo, type CanvasSnapshot, type CardEvent, type CardPatch, type Item, type NewCard, STATES } from '../core/types';
import type { CardRow, NewRow, RowUpdate, Store } from './db';

export class BadRequest extends Error {}

export class Board {
  private listeners = new Set<() => void>();
  private docs: PlanDoc[] | null = null;
  private eventListeners = new Set<(e: CardEvent) => void>();

  constructor(
    private store: Store,
    readonly canvas: CanvasInfo,
    private readDocs: () => PlanDoc[],
  ) {
    store.ensureCanvas(canvas.id, canvas.name);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: CardEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** A card changed. */
  changed() {
    for (const fn of this.listeners) fn();
  }

  /** Plan docs changed on disk: read them again. */
  docsChanged() {
    this.docs = null;
    this.changed();
  }

  /** Appends a line to the card's log. */
  log(cardId: string, kind: CardEvent['kind'], author: CardEvent['author'], text: string): CardEvent {
    const e = this.store.addEvent({ cardId, kind, author, text });
    for (const fn of this.eventListeners) fn(e);
    return e;
  }

  events(cardId: string): CardEvent[] {
    this.own(cardId);
    return this.store.events(cardId);
  }

  row(id: string): CardRow {
    return this.own(id);
  }

  /** The card as the UI sees it. */
  item(id: string): Item | undefined {
    return this.snapshot().items.find((i) => i.id === id);
  }

  /** Changes a card's work fields (state, session, workspace …); for the agents, not the owner. */
  work(id: string, fields: RowUpdate) {
    this.own(id);
    this.store.update(id, fields);
    this.changed();
  }

  /** A card an agent proposes, placed below the card it came from. */
  propose(fromId: string, p: { kind: 'bugfix' | 'feature'; title: string; reason: string; suggestion: string }): Item {
    const items = this.snapshot().items;
    const from = items.find((i) => i.id === fromId);
    const b = from ? boundsOf(from, items) : { x: 0, y: 0, w: 0, h: 0 };
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: p.kind,
        state: 'proposal',
        title: p.title.slice(0, 200),
        body: `${p.reason}\n\n${p.suggestion}`.slice(0, 20000),
        x: b.x + 35,
        y: b.y + b.h + 60,
        from_id: fromId,
      },
    ]);
    this.changed();
    return toItems([row!], [])[0]!;
  }

  decide(d: { project_id: string | null; card_id: string; question: string; answer: string; by: 'owner' | 'project' | 'koordinator' }) {
    this.store.addDecision({ canvas_id: this.canvas.id, ...d });
  }

  /** A project's decisions, or with `null` those of standalone cards. */
  decisions(projectId: string | null) {
    return this.store.decisions(this.canvas.id, projectId);
  }

  setting(key: string): string | null {
    return this.store.setting(this.canvas.id, key);
  }

  setSetting(key: string, value: string) {
    this.store.setSetting(this.canvas.id, key, value);
  }

  accept(id: string) {
    if (this.own(id).state !== 'proposal') throw new BadRequest('not a proposal');
    this.store.update(id, { state: 'planned' });
    this.changed();
  }

  snapshot(): CanvasSnapshot {
    const docs = (this.docs ??= this.readDocs());
    let items = toItems(this.store.cards(this.canvas.id), docs);
    if (this.placeNew(docs, items)) items = toItems(this.store.cards(this.canvas.id), docs);
    return { canvas: this.canvas, items };
  }

  create(n: NewCard): Item {
    if (n.kind !== 'bugfix' && n.kind !== 'feature') throw new BadRequest('kind must be bugfix or feature');
    checkText(n.title, 'title', 200);
    if (n.body !== undefined) checkText(n.body, 'body', 20000);
    checkNumber(n.x, 'x');
    checkNumber(n.y, 'y');
    const [row] = this.store.insert([
      { canvas_id: this.canvas.id, kind: n.kind, state: 'planned', title: n.title, body: n.body ?? '', x: n.x, y: n.y },
    ]);
    this.changed();
    return toItems([row!], [])[0]!;
  }

  patch(id: string, p: CardPatch) {
    const row = this.own(id);
    const allowed = row.plan_ref ? (row.kind === 'project' ? ['x', 'y'] : ['x', 'y', 'state', 'need']) : ['x', 'y', 'kind', 'title', 'body', 'state', 'need'];
    const bad = Object.keys(p).filter((k) => !allowed.includes(k));
    if (bad.length) throw new BadRequest(`cannot change ${bad.join(', ')} on this card`);
    if (p.x !== undefined) checkNumber(p.x, 'x');
    if (p.y !== undefined) checkNumber(p.y, 'y');
    if (p.kind !== undefined && p.kind !== 'bugfix' && p.kind !== 'feature') throw new BadRequest('kind must be bugfix or feature');
    if (p.title !== undefined) checkText(p.title, 'title', 200);
    if (p.body !== undefined) checkText(p.body, 'body', 20000);
    if (p.state !== undefined && !STATES.includes(p.state)) throw new BadRequest(`state must be one of ${STATES.join(', ')}`);
    if (p.need !== undefined && p.need !== null && p.need !== 'demo' && p.need !== 'question') throw new BadRequest('need must be demo, question or null');
    this.store.update(id, p);
    this.changed();
  }

  /** Manual cards only; a plan card goes away with its workstream. */
  remove(id: string) {
    if (this.own(id).plan_ref) throw new BadRequest('plan cards are removed in the plan doc');
    this.store.update(id, { deleted_at: new Date().toISOString() });
    this.changed();
  }

  restore(id: string) {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id) throw new BadRequest('unknown card');
    this.store.update(id, { deleted_at: null });
    this.changed();
  }

  private own(id: string): CardRow {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id || row.deleted_at) throw new BadRequest('unknown card');
    return row;
  }

  /** Stores a row for every project and workstream seen for the first time. Returns whether any were added. */
  private placeNew(docs: PlanDoc[], items: Item[]): boolean {
    const rows = this.store.cards(this.canvas.id);
    const byRef = new Map(rows.filter((r) => r.plan_ref).map((r) => [r.plan_ref!, r]));
    const add: NewRow[] = [];
    const c = this.canvas.id;

    for (const doc of docs) {
      const project = byRef.get(doc.file);
      if (!project) continue;
      const missing = doc.workstreams.filter((w) => !byRef.has(`${doc.file}#${w.key}`));
      if (!missing.length) continue;
      const kids = items.filter((i) => i.parent === project.id);
      const startY = kids.length ? Math.max(...kids.map((k) => k.y + sizeOf(k, items)[1])) + GAP : PROJECT_HEAD;
      placeWorkstreams(missing, startY).forEach((pos, n) =>
        add.push({ canvas_id: c, kind: 'feature', parent_id: project.id, plan_ref: `${doc.file}#${missing[n]!.key}`, ...pos }),
      );
    }
    if (add.length) this.store.insert(add);

    const fresh = docs.filter((d) => !byRef.has(d.file));
    if (!fresh.length) return add.length > 0;
    const layouts = fresh.map((d) => {
      const pos = placeWorkstreams(d.workstreams);
      const kids = pos.map((p, n) => ({ kind: 'feature' as const, state: d.workstreams[n]!.done ? ('live' as const) : ('planned' as const), parent: 'p', ...p }));
      return { doc: d, pos, size: projectSize(kids) };
    });
    const top = items.filter((i) => !i.parent);
    const at = placeProjects(unionBounds(top.map((i) => boundsOf(i, items))), layouts.map((l) => l.size));
    layouts.forEach(({ doc, pos }, n) => {
      const [project] = this.store.insert([{ canvas_id: c, kind: 'project', plan_ref: doc.file, ...at[n]! }]);
      this.store.insert(
        doc.workstreams.map((w, k) => ({ canvas_id: c, kind: 'feature' as const, parent_id: project!.id, plan_ref: `${doc.file}#${w.key}`, ...pos[k]! })),
      );
    });
    return true;
  }
}

/** Visible items: projects first, their workstreams in doc order, then manual cards. */
export function toItems(rows: CardRow[], docs: PlanDoc[]): Item[] {
  const docByFile = new Map(docs.map((d) => [d.file, d]));
  const projects: Item[] = [];
  const workstreams: { item: Item; order: number }[] = [];
  const manual: Item[] = [];
  for (const r of rows) {
    if (!r.plan_ref) {
      manual.push({
        id: r.id,
        kind: r.kind,
        state: r.state ?? 'planned',
        ...(r.need ? { need: r.need } : {}),
        title: r.title ?? '',
        body: r.body ?? '',
        x: r.x,
        y: r.y,
        source: 'manual',
        ...work(r),
      });
      continue;
    }
    const hash = r.plan_ref.indexOf('#');
    const doc = docByFile.get(hash < 0 ? r.plan_ref : r.plan_ref.slice(0, hash));
    if (!doc) continue;
    if (hash < 0) {
      projects.push({ id: r.id, kind: 'project', state: 'planned', title: doc.title, body: '', x: r.x, y: r.y, source: 'plan', plan: { file: doc.file, goal: doc.goal } });
      continue;
    }
    const key = r.plan_ref.slice(hash + 1);
    const order = doc.workstreams.findIndex((w) => w.key === key);
    const w = doc.workstreams[order];
    if (!w || !r.parent_id) continue;
    const derived = w.done ? 'live' : w.inReview ? 'inPr' : 'planned';
    workstreams.push({
      order,
      item: {
        id: r.id,
        kind: r.kind,
        state: derived === 'live' ? 'live' : (r.state ?? derived),
        ...(r.need ? { need: r.need } : {}),
        title: w.title,
        body: w.body,
        x: r.x,
        y: r.y,
        parent: r.parent_id,
        source: 'plan',
        ...(w.label ? { label: w.label } : {}),
        ...work(r),
      },
    });
  }
  const shown = new Set(projects.map((p) => p.id));
  const kids = workstreams.filter((w) => shown.has(w.item.parent!));
  const ordered = projects.flatMap((p) =>
    kids
      .filter((k) => k.item.parent === p.id)
      .sort((a, b) => a.order - b.order)
      .map((k) => k.item),
  );
  return [...projects, ...ordered, ...manual];
}

/** The fields a worker adds to a card. */
function work(r: CardRow): Partial<Item> {
  const detail = r.detail ? (JSON.parse(r.detail) as { question?: Item['question']; summary?: string }) : {};
  const scope = r.scope ? (JSON.parse(r.scope) as { files: string[] }).files : undefined;
  return {
    ...(scope?.length ? { scope } : {}),
    ...(r.queue && (r.state ?? 'planned') === 'planned' ? { queue: JSON.parse(r.queue) as Item['queue'] } : {}),
    ...(r.status_line ? { statusLine: r.status_line } : {}),
    ...(detail.question && r.need === 'question' ? { question: detail.question } : {}),
    ...(detail.summary && r.need === 'review' ? { summary: detail.summary } : {}),
    ...(r.from_id ? { from: r.from_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
  };
}

function checkText(v: unknown, name: string, max: number) {
  if (typeof v !== 'string' || v.length > max) throw new BadRequest(`${name} must be a string of at most ${max} characters`);
}

function checkNumber(v: unknown, name: string) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(`${name} must be a finite number`);
}
