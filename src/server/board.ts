// The canvas of one repository: stored cards merged with what the plan docs say.
//
// Plan docs are read, never written. Their projects and workstreams get a stored row the first
// time they appear, so the owner's placement survives; title, text and state always come from the
// doc. A row whose doc or workstream is gone stays stored but is not shown.

import { boundsOf, GAP, PROJECT_HEAD, placeProjects, placeWorkstreams, projectSize, sizeOf, unionBounds } from '../core/layout';
import type { PlanDoc } from '../core/plan-doc';
import { type CanvasInfo, type CanvasSnapshot, type CardEvent, type CardPatch, type ErrorCode, type Idea, type Item, type NewCard, STATES } from '../core/types';
import type { CardRow, NewRow, RowUpdate, Store } from './db';

/** What Obeya keeps about a card's pull request; `url` is null until the worker opened it. */
export interface PrState {
  url: string | null;
  number?: number;
  /** Comments already passed to the worker. */
  seen: string[];
  /** `check@commit` of failures already passed to the worker. */
  reported: string[];
  /** The commit a conflict was last reported for. */
  conflictHead?: string;
  checks?: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
}

/** A request the server refuses: a stable code for the UI's text, and an English detail. */
/** States a worker or the owner's decision is still part of. */
const ACTIVE: string[] = ['working', 'waiting', 'inPr', 'approved'];

/** Exchanges with the Koordinator its sheet shows. */
const SHEET_TALK = 30;

/** How long an untitled card of the owner's may exist before Obeya drops it on start. */
const UNTITLED_GRACE_MS = 10 * 60_000;

export class BadRequest extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class Board {
  private listeners = new Set<() => void>();
  private docs: PlanDoc[] | null = null;
  private cache: CanvasSnapshot | null = null;
  private eventListeners = new Set<(e: CardEvent) => void>();
  private speakListeners = new Set<(cardId: string | undefined, text: string) => void>();

  constructor(
    private store: Store,
    readonly canvas: CanvasInfo,
    private readDocs: () => PlanDoc[],
  ) {
    store.ensureCanvas(canvas.id, canvas.name);
    // a new card whose page closed before it got a title was never wanted
    store.sweepUntitled(canvas.id, new Date(Date.now() - UNTITLED_GRACE_MS).toISOString());
  }

  /** The canvas's home repository: bare plan references and cards without a repository are its. */
  get home(): string {
    return this.canvas.repos[0]!.id;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: CardEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Whoever voices the canvas (the server) speaks what agents say aloud. */
  onSpeak(fn: (cardId: string | undefined, text: string) => void): () => void {
    this.speakListeners.add(fn);
    return () => this.speakListeners.delete(fn);
  }

  /** A short text to speak to the owner: about a card, heard while it is open, or without one, heard anywhere. */
  speak(cardId: string | undefined, text: string) {
    for (const fn of this.speakListeners) fn(cardId, text);
  }

  /** A card changed. */
  changed() {
    this.cache = null;
    for (const fn of this.listeners) fn();
  }

  /** Plan docs changed on disk: read them again. */
  docsChanged() {
    this.docs = null;
    this.changed();
  }

  /** Appends a line to the card's log. */
  log(cardId: string, kind: CardEvent['kind'], author: CardEvent['author'], text: string, code?: ErrorCode, images?: string[]): CardEvent {
    const e = this.store.addEvent({ cardId, kind, author, text, ...(code ? { code } : {}), ...(images?.length ? { images } : {}) });
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

  /** The directory of the card's latest demo; it stays with the card after approval. */
  demoDir(id: string): string | null {
    const r = this.own(id);
    return r.demo ? (JSON.parse(r.demo) as { dir: string }).dir : null;
  }

  /** The plan doc of a project, as written, for the owner to read. */
  planDoc(id: string): { file: string; markdown: string } {
    const ref = this.own(id).plan_ref;
    const doc = ref && !ref.includes('#') ? (this.docs ??= this.readDocs()).find((d) => d.file === ref) : undefined;
    if (!doc) throw new BadRequest('invalid', 'not a project with a plan doc');
    return { file: doc.file, markdown: doc.markdown };
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

  /** Cards that replace `id`, side by side where it was; they start planned, with their scope. */
  replace(id: string, cards: { kind: 'bugfix' | 'feature'; title: string; body: string; files: string[] }[]): Item[] {
    const row = this.own(id);
    if (row.plan_ref) throw new BadRequest('planCard', 'plan cards are changed in the plan doc');
    const rows = this.store.insert(
      cards.map((c, n) => ({
        canvas_id: this.canvas.id,
        kind: c.kind,
        state: 'planned' as const,
        title: c.title.slice(0, 200),
        body: c.body.slice(0, 20000),
        x: row.x + (n % 3) * 330,
        y: row.y + Math.floor(n / 3) * 170,
        repo: row.repo,
      })),
    );
    rows.forEach((r, n) => this.store.update(r.id, { scope: JSON.stringify({ files: cards[n]!.files, reason: '' }) }));
    this.store.update(id, { deleted_at: new Date().toISOString(), queue: null });
    this.changed();
    return rows.map((r) => this.snapshot().items.find((i) => i.id === r.id)!);
  }

  /** Where a card nobody placed goes: a column right of everything, below what is already there. */
  freeSpot(): { x: number; y: number } {
    const items = this.snapshot().items;
    const top = items.filter((i) => !i.parent);
    const all = unionBounds(top.map((i) => boundsOf(i, items)));
    if (!all) return { x: 0, y: 0 };
    const column = top.filter((i) => i.kind !== 'project' && i.x >= all.x + all.w - 400);
    const x = column.length ? Math.min(...column.map((i) => i.x)) : all.x + all.w + 80;
    const y = column.length ? Math.max(...column.map((i) => boundsOf(i, items).y + boundsOf(i, items).h)) + 30 : all.y;
    return { x, y };
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
        repo: from && from.repo !== this.home ? from.repo : null,
      },
    ]);
    this.changed();
    return toItems([row!], [], this.home)[0]!;
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

  /** An idea's stored status and brief. */
  idea(id: string): StoredIdea {
    const r = this.own(id);
    if (r.state !== 'idea') throw new BadRequest('notIdea', 'the card is not an idea');
    return r.idea ? (JSON.parse(r.idea) as StoredIdea) : { status: 'open', brief: '' };
  }

  setIdea(id: string, fields: Partial<StoredIdea>) {
    this.work(id, { idea: JSON.stringify({ ...this.idea(id), ...fields }) });
  }

  /** A card whose worker builds a throwaway prototype for the idea; placed below it. */
  addSpike(ideaId: string, title: string, body: string): Item {
    const items = this.snapshot().items;
    const idea = items.find((i) => i.id === ideaId);
    const b = idea ? boundsOf(idea, items) : { x: 0, y: 0, w: 0, h: 0 };
    const spikes = items.filter((i) => i.spikeOf === ideaId).length;
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: 'feature',
        state: 'planned',
        title: title.slice(0, 200),
        body: body.slice(0, 20000),
        x: b.x + 35 + spikes * 30,
        y: b.y + b.h + 60 + spikes * 30,
        from_id: ideaId,
        spike_of: ideaId,
        repo: idea && idea.repo !== this.home ? idea.repo : null,
      },
    ]);
    this.changed();
    return toItems([row!], [], this.home)[0]!;
  }

  // ---------------------------------------------------------------- the Koordinator's memory

  /** Records an exchange with the Koordinator; returns its id. */
  addTalk(said: string, reply: string, cardId: string | null = null, lookUp?: { question: string; about: string | null }): number {
    const id = this.store.addTalk(this.canvas.id, said, reply, cardId, lookUp);
    this.changed();
    return id;
  }

  undoTalk(id: number) {
    this.store.undoTalk(id);
    this.changed();
  }

  talk(limit?: number) {
    return this.store.talk(this.canvas.id, limit);
  }

  /** The answer to a question the Koordinator looked up. */
  answerTalk(id: number, answer: string, by: 'koordinator' | 'project') {
    this.store.answerTalk(id, answer, by);
    this.changed();
  }

  exchange(id: number) {
    return this.store.exchange(id);
  }

  /** Questions the Koordinator is still looking up. */
  lookingUp(): number[] {
    return this.store.lookingUp(this.canvas.id);
  }

  /** The cards' history after `since` (ISO time), oldest first, at most the latest `limit` steps. */
  timeline(since: string, limit: number) {
    return this.store.timeline(this.canvas.id, since, limit);
  }

  accept(id: string) {
    if (this.own(id).state !== 'proposal') throw new BadRequest('notProposal', 'not a proposal');
    this.store.update(id, { state: 'planned' });
    this.changed();
  }

  // ---------------------------------------------------------------- archive

  /** Takes finished cards of the owner's off the canvas into its archive. */
  archive(ids: string[]) {
    for (const id of ids) {
      const row = this.own(id);
      if (row.plan_ref) throw new BadRequest('planCard', 'a workstream stays with its project');
      if (row.state !== 'live') throw new BadRequest('notDone', 'only a live card can be archived');
    }
    const at = new Date().toISOString();
    this.store.db.transaction(() => ids.forEach((id) => this.store.update(id, { archived_at: at })))();
    this.changed();
  }

  /** Archives every finished card of the owner's on the canvas; returns their ids. */
  archiveDone(): string[] {
    const ids = this.snapshot()
      .items.filter((i) => i.source === 'manual' && i.state === 'live')
      .map((i) => i.id);
    if (ids.length) this.archive(ids);
    return ids;
  }

  /** Puts an archived card back where it was on the canvas. */
  unarchive(id: string) {
    if (!this.own(id).archived_at) throw new BadRequest('notArchived', 'the card is not archived');
    this.store.update(id, { archived_at: null });
    this.changed();
  }

  /** The archive, the most recently archived first. */
  archived(): Item[] {
    return this.store.archived(this.canvas.id).map((r) => ({ ...toItems([r], [], this.home)[0]!, archivedAt: r.archived_at! }));
  }

  /** The canvas as the UI sees it; built once per change (every write here ends in `changed`). */
  snapshot(): CanvasSnapshot {
    if (this.cache) return this.cache;
    const docs = (this.docs ??= this.readDocs());
    let items = toItems(this.store.cards(this.canvas.id), docs, this.home);
    if (this.placeNew(docs, items)) items = toItems(this.store.cards(this.canvas.id), docs, this.home);
    this.cache = { canvas: this.canvas, items, preferences: this.store.preferences(this.canvas.id), talk: this.store.talk(this.canvas.id, SHEET_TALK, true) };
    return this.cache;
  }

  // ---------------------------------------------------------------- preferences

  preferences() {
    return this.store.preferences(this.canvas.id);
  }

  /** The owner's preferences as agents read them; empty when there are none. */
  preferencesText(): string {
    const p = this.preferences();
    return p.length ? `The owner's standing preferences (follow them unless the card says otherwise):\n${p.map((x) => `- ${x.text}`).join('\n')}` : '';
  }

  addPreference(text: string, cardId: string | null = null): number {
    const clean = checkPreference(text);
    const id = this.store.addPreference(this.canvas.id, clean, cardId);
    this.changed();
    return id;
  }

  setPreference(id: number, text: string | null) {
    if (!this.store.setPreference(this.canvas.id, id, text === null ? null : checkPreference(text)))
      throw new BadRequest('unknownPreference', 'unknown preference');
    this.changed();
  }

  create(n: NewCard): Item {
    if (n.kind !== 'bugfix' && n.kind !== 'feature') throw new BadRequest('invalid', 'kind must be bugfix or feature');
    checkText(n.title, 'title', 200);
    if (n.body !== undefined) checkText(n.body, 'body', 20000);
    checkNumber(n.x, 'x');
    checkNumber(n.y, 'y');
    if (n.repo !== undefined && !this.canvas.repos.some((r) => r.id === n.repo)) throw new BadRequest('invalid', 'unknown repository');
    const [row] = this.store.insert([
      {
        canvas_id: this.canvas.id,
        kind: n.kind,
        state: n.idea ? 'idea' : 'planned',
        title: n.title,
        body: n.body ?? '',
        x: n.x,
        y: n.y,
        repo: n.repo && n.repo !== this.home ? n.repo : null,
        ...(n.idea ? { idea: JSON.stringify({ status: 'open', brief: '' } satisfies StoredIdea) } : {}),
      },
    ]);
    this.changed();
    return toItems([row!], [], this.home)[0]!;
  }

  patch(id: string, p: CardPatch) {
    const row = this.own(id);
    const allowed = row.plan_ref ? (row.kind === 'project' ? ['x', 'y'] : ['x', 'y', 'state', 'need']) : ['x', 'y', 'kind', 'title', 'body', 'state', 'need', 'repo'];
    const bad = Object.keys(p).filter((k) => !allowed.includes(k));
    if (bad.length) throw new BadRequest('invalid', `cannot change ${bad.join(', ')} on this card`);
    if (p.x !== undefined) checkNumber(p.x, 'x');
    if (p.y !== undefined) checkNumber(p.y, 'y');
    if (p.kind !== undefined && p.kind !== 'bugfix' && p.kind !== 'feature') throw new BadRequest('invalid', 'kind must be bugfix or feature');
    if (p.title !== undefined) checkText(p.title, 'title', 200);
    if (p.body !== undefined) checkText(p.body, 'body', 20000);
    if (p.state !== undefined && !STATES.includes(p.state)) throw new BadRequest('invalid', `state must be one of ${STATES.join(', ')}`);
    if (p.need !== undefined && p.need !== null && p.need !== 'demo' && p.need !== 'question') throw new BadRequest('invalid', 'need must be demo, question or null');
    const { repo, ...fields } = p;
    // a planned card of the owner's may become an idea again, to be discussed first
    if (p.state === 'idea' && row.state !== 'idea' && (row.plan_ref || (row.state ?? 'planned') !== 'planned' || row.workspace))
      throw new BadRequest('invalid', 'only a planned card of your own that has not been worked on can become an idea');
    if (repo !== undefined) {
      if (!this.canvas.repos.some((r) => r.id === repo)) throw new BadRequest('invalid', 'unknown repository');
      // its workspace and branch belong to the repository it started in
      if ((row.state ?? 'planned') !== 'planned' || row.workspace) throw new BadRequest('invalid', 'a card changes repository only before work begins');
    }
    this.store.update(id, { ...fields, ...(repo !== undefined ? { repo: repo === this.home ? null : repo } : {}) });
    this.changed();
  }

  /** Manual cards only; a plan card goes away with its workstream. */
  remove(id: string) {
    if (this.own(id).plan_ref) throw new BadRequest('planCard', 'plan cards are removed in the plan doc');
    this.store.update(id, { deleted_at: new Date().toISOString() });
    this.changed();
  }

  restore(id: string) {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id) throw new BadRequest('unknownCard', 'unknown card');
    this.store.update(id, { deleted_at: null });
    this.changed();
  }

  private own(id: string): CardRow {
    const row = this.store.card(id);
    if (!row || row.canvas_id !== this.canvas.id || row.deleted_at) throw new BadRequest('unknownCard', 'unknown card');
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
/**
 * The repository a plan reference belongs to: `<repo>:<path>` for the canvas's other repositories,
 * a bare path for its home repository.
 */
export function repoOfRef(ref: string, home: string): string {
  const m = /^([\w.-]+):(?!\/)/.exec(ref);
  return m ? m[1]! : home;
}

export function toItems(rows: CardRow[], docs: PlanDoc[], home: string): Item[] {
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
        repo: r.repo ?? home,
        ...work(r),
        ...(r.state === 'idea' ? { idea: ideaOf(r) } : {}),
        ...(r.spike_of ? { spikeOf: r.spike_of } : {}),
      });
      continue;
    }
    const hash = r.plan_ref.indexOf('#');
    const doc = docByFile.get(hash < 0 ? r.plan_ref : r.plan_ref.slice(0, hash));
    if (!doc) continue;
    if (hash < 0) {
      projects.push({
        id: r.id,
        kind: 'project',
        state: 'planned',
        title: doc.title,
        body: '',
        x: r.x,
        y: r.y,
        source: 'plan',
        repo: repoOfRef(doc.file, home),
        plan: { file: doc.file, goal: doc.goal },
      });
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
        // work in progress wins over the doc: a ticked-off workstream may still wait for its merge
        state: r.state && ACTIVE.includes(r.state) ? r.state : derived === 'live' ? 'live' : (r.state ?? derived),
        ...(r.need ? { need: r.need } : {}),
        title: w.title,
        body: w.body,
        x: r.x,
        y: r.y,
        parent: r.parent_id,
        source: 'plan',
        repo: repoOfRef(r.plan_ref, home),
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
  const demo = r.demo ? (({ dir: _, ...d }) => d)(JSON.parse(r.demo) as Item['demo'] & { dir: string }) : undefined;
  const scope = r.scope ? (JSON.parse(r.scope) as { files: string[] }).files : undefined;
  const pr = r.pr ? (JSON.parse(r.pr) as PrState) : undefined;
  return {
    ...(scope?.length ? { scope } : {}),
    ...(r.queue && (r.state ?? 'planned') === 'planned' ? { queue: JSON.parse(r.queue) as Item['queue'] } : {}),
    ...(pr?.url ? { pr: { url: pr.url, number: pr.number!, checks: pr.checks ?? [], conflict: !!pr.conflictHead } } : {}),
    ...(r.status_line ? { statusLine: r.status_line } : {}),
    ...(detail.question && r.need === 'question' ? { question: detail.question } : {}),
    ...(detail.summary && (r.need === 'review' || r.need === 'demo') ? { summary: detail.summary } : {}),
    ...(demo ? { demo } : {}),
    ...(r.from_id ? { from: r.from_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
  };
}

/** What is stored of an idea; `thinking` while its agent works on a reply, `yourTurn` once it replied. */
export interface StoredIdea {
  status: Idea['status'];
  brief: string;
  thinking?: boolean;
  yourTurn?: boolean;
}

function ideaOf(r: CardRow): Idea {
  const i = r.idea ? (JSON.parse(r.idea) as StoredIdea) : { status: 'open' as const, brief: '' };
  return { status: i.status, brief: i.brief, thinking: !!i.thinking, yourTurn: !!i.yourTurn };
}

function checkPreference(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500) throw new BadRequest('emptyText', 'a preference is a non-empty string of at most 500 characters');
  return v.trim();
}

function checkText(v: unknown, name: string, max: number) {
  if (typeof v !== 'string' || v.length > max) throw new BadRequest('invalid', `${name} must be a string of at most ${max} characters`);
}

function checkNumber(v: unknown, name: string) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest('invalid', `${name} must be a finite number`);
}
