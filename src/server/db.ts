import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardEvent, CardKind, CardState, Need, Preference } from '../core/types';

export interface CardRow {
  id: string;
  canvas_id: string;
  kind: CardKind;
  /** Null on plan cards: the state comes from the plan doc. */
  state: CardState | null;
  need: Need | null;
  title: string | null;
  body: string | null;
  x: number;
  y: number;
  parent_id: string | null;
  /** `docs/plan/x.md` for a project, `docs/plan/x.md#W3` for a workstream; null for manual cards. */
  plan_ref: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Agent session of the card's worker, or of a project's project agent. */
  session_id: string | null;
  /** Leased clone and branch while a worker has the card. */
  workspace: string | null;
  branch: string | null;
  /** The worker's latest `report`. */
  status_line: string | null;
  /** JSON: the open question (`{ text, options }`) or the review summary (`{ summary }`). */
  detail: string | null;
  /** A proposal's source card. */
  from_id: string | null;
  /** JSON: the Koordinator's estimate of the files the card changes (`{ files, reason }`). */
  scope: string | null;
  /** JSON: set while the Koordinator decides (`{ checking: true }`) or the card waits (`{ behind, reason }`). */
  queue: string | null;
  /** JSON: the card's pull request once approval opened the PR phase (`PrState`). */
  pr: string | null;
  /** The owner's card's repository on a canvas with several; null is the home repository. */
  repo: string | null;
  /** JSON: the card's latest demo (`{ dir, chapters, shown, notShown, findings, question? }`). */
  demo: string | null;
  /** When the owner took the finished card off the canvas into the archive. */
  archived_at: string | null;
}

export interface DecisionRow {
  id: number;
  canvas_id: string;
  project_id: string | null;
  card_id: string;
  question: string;
  answer: string;
  by: 'owner' | 'project' | 'koordinator';
  at: string;
}

// Append only; each entry runs once, tracked in `PRAGMA user_version`.
const MIGRATIONS = [
  `CREATE TABLE canvases (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE cards (
     id TEXT PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     kind TEXT NOT NULL,
     state TEXT,
     need TEXT,
     title TEXT,
     body TEXT,
     x REAL NOT NULL,
     y REAL NOT NULL,
     parent_id TEXT REFERENCES cards(id),
     plan_ref TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT,
     UNIQUE (canvas_id, plan_ref)
   );`,
  `ALTER TABLE cards ADD COLUMN session_id TEXT;
   ALTER TABLE cards ADD COLUMN workspace TEXT;
   ALTER TABLE cards ADD COLUMN branch TEXT;
   ALTER TABLE cards ADD COLUMN status_line TEXT;
   ALTER TABLE cards ADD COLUMN detail TEXT;
   ALTER TABLE cards ADD COLUMN from_id TEXT REFERENCES cards(id);
   CREATE TABLE workspaces (
     path TEXT PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     card_id TEXT REFERENCES cards(id)
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     card_id TEXT NOT NULL REFERENCES cards(id),
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     author TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE INDEX events_card ON events (card_id, id);
   CREATE TABLE decisions (
     id INTEGER PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     project_id TEXT REFERENCES cards(id),
     card_id TEXT NOT NULL REFERENCES cards(id),
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     by TEXT NOT NULL,
     at TEXT NOT NULL
   );`,
  `ALTER TABLE cards ADD COLUMN scope TEXT;
   ALTER TABLE cards ADD COLUMN queue TEXT;`,
  `CREATE TABLE settings (
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (canvas_id, key)
   );
   CREATE TABLE preferences (
     id INTEGER PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     text TEXT NOT NULL,
     card_id TEXT REFERENCES cards(id),
     created_at TEXT NOT NULL,
     deleted_at TEXT
   );`,
  `ALTER TABLE events ADD COLUMN code TEXT;`,
  `ALTER TABLE cards ADD COLUMN pr TEXT;`,
  // a canvas may span several repositories; null is the canvas's home repository
  `ALTER TABLE cards ADD COLUMN repo TEXT;
   ALTER TABLE workspaces ADD COLUMN repo TEXT;`,
  // the demo outlives the review it was made for; a card waiting with one moves it out of `detail`
  `ALTER TABLE cards ADD COLUMN demo TEXT;
   UPDATE cards SET demo = json_extract(detail, '$.demo') WHERE need = 'demo' AND json_extract(detail, '$.demo') IS NOT NULL;`,
  `ALTER TABLE cards ADD COLUMN archived_at TEXT;`,
];

export type NewRow = Pick<CardRow, 'canvas_id' | 'kind' | 'x' | 'y'> &
  Partial<Pick<CardRow, 'state' | 'title' | 'body' | 'parent_id' | 'plan_ref' | 'from_id' | 'repo'>>;

export type RowUpdate = Partial<
  Pick<
    CardRow,
    | 'x'
    | 'y'
    | 'kind'
    | 'title'
    | 'body'
    | 'state'
    | 'need'
    | 'deleted_at'
    | 'session_id'
    | 'workspace'
    | 'branch'
    | 'status_line'
    | 'detail'
    | 'scope'
    | 'queue'
    | 'pr'
    | 'demo'
    | 'archived_at'
  >
>;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    const { user_version } = this.db.query('PRAGMA user_version').get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[v]!);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  ensureCanvas(id: string, name: string) {
    this.db
      .query('INSERT INTO canvases (id, name, created_at) VALUES ($id, $name, $now) ON CONFLICT(id) DO UPDATE SET name = $name')
      .run({ id, name, now: now() });
  }

  /** Every card on the canvas: not deleted, not archived. */
  cards(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NULL').all({ c: canvasId }) as CardRow[];
  }

  /** The canvas's archive, the most recently archived first. */
  archived(canvasId: string): CardRow[] {
    return this.db
      .query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC, created_at DESC')
      .all({ c: canvasId }) as CardRow[];
  }

  /** Deletes the owner's cards that never got a title, created before `before`; returns how many. */
  sweepUntitled(canvasId: string, before: string): number {
    return this.db
      .query(
        `UPDATE cards SET deleted_at = $now
         WHERE canvas_id = $c AND plan_ref IS NULL AND deleted_at IS NULL AND state = 'planned'
           AND TRIM(COALESCE(title, '')) = '' AND created_at < $before`,
      )
      .run({ c: canvasId, before, now: now() }).changes;
  }

  card(id: string): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE id = $id').get({ id }) as CardRow | null) ?? null;
  }

  insert(rows: NewRow[]): CardRow[] {
    const stmt = this.db.query(
      `INSERT INTO cards (id, canvas_id, kind, state, title, body, x, y, parent_id, plan_ref, from_id, repo, created_at, updated_at)
       VALUES ($id, $canvas_id, $kind, $state, $title, $body, $x, $y, $parent_id, $plan_ref, $from_id, $repo, $now, $now)`,
    );
    const ids = this.db.transaction(() =>
      rows.map((r) => {
        const id = crypto.randomUUID();
        stmt.run({
          id,
          canvas_id: r.canvas_id,
          kind: r.kind,
          state: r.state ?? null,
          title: r.title ?? null,
          body: r.body ?? null,
          x: r.x,
          y: r.y,
          parent_id: r.parent_id ?? null,
          plan_ref: r.plan_ref ?? null,
          from_id: r.from_id ?? null,
          repo: r.repo ?? null,
          now: now(),
        });
        return id;
      }),
    )();
    return ids.map((id) => this.card(id)!);
  }

  update(id: string, fields: RowUpdate) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = $${k}`).join(', ');
    this.db.query(`UPDATE cards SET ${set}, updated_at = $now WHERE id = $id`).run({ ...fields, id, now: now() });
  }

  // ---------------------------------------------------------------- events

  addEvent(e: Omit<CardEvent, 'id' | 'at'>): CardEvent {
    const at = now();
    const { id } = this.db
      .query('INSERT INTO events (card_id, at, kind, author, text, code) VALUES ($cardId, $at, $kind, $author, $text, $code) RETURNING id')
      .get({ ...e, code: e.code ?? null, at }) as { id: number };
    return { ...e, id, at };
  }

  events(cardId: string, limit = 500): CardEvent[] {
    const rows = this.db
      .query('SELECT id, card_id AS cardId, at, kind, author, text, code FROM events WHERE card_id = $c ORDER BY id DESC LIMIT $limit')
      .all({ c: cardId, limit }) as (CardEvent & { code: CardEvent['code'] | null })[];
    return rows.reverse().map(({ code, ...e }) => (code ? { ...e, code } : e));
  }

  // ---------------------------------------------------------------- workspaces

  addWorkspace(canvasId: string, path: string, repo: string | null = null) {
    this.db.query('INSERT INTO workspaces (path, canvas_id, repo) VALUES ($path, $c, $repo) ON CONFLICT(path) DO NOTHING').run({ path, c: canvasId, repo });
  }

  /** The workspaces of one repository on the canvas (`null`: its home repository). */
  workspaces(canvasId: string, repo: string | null = null): { path: string; card_id: string | null }[] {
    return this.db
      .query('SELECT path, card_id FROM workspaces WHERE canvas_id = $c AND repo IS $repo ORDER BY path')
      .all({ c: canvasId, repo }) as { path: string; card_id: string | null }[];
  }

  removeWorkspace(path: string) {
    this.db.query('DELETE FROM workspaces WHERE path = $path').run({ path });
  }

  setLease(path: string, cardId: string | null) {
    this.db.query('UPDATE workspaces SET card_id = $cardId WHERE path = $path').run({ path, cardId });
  }

  // ---------------------------------------------------------------- decisions

  addDecision(d: Omit<DecisionRow, 'id' | 'at'>) {
    this.db
      .query('INSERT INTO decisions (canvas_id, project_id, card_id, question, answer, by, at) VALUES ($canvas_id, $project_id, $card_id, $question, $answer, $by, $at)')
      .run({ ...d, at: now() });
  }

  /** A project's decisions, or with `null` those of the canvas's standalone cards. */
  decisions(canvasId: string, projectId: string | null, limit = 40): DecisionRow[] {
    return (
      this.db
        .query('SELECT * FROM decisions WHERE canvas_id = $c AND project_id IS $p ORDER BY id DESC LIMIT $limit')
        .all({ c: canvasId, p: projectId, limit }) as DecisionRow[]
    ).reverse();
  }

  // ---------------------------------------------------------------- preferences

  preferences(canvasId: string): Preference[] {
    return (
      this.db.query('SELECT id, text, card_id FROM preferences WHERE canvas_id = $c AND deleted_at IS NULL ORDER BY id').all({ c: canvasId }) as {
        id: number;
        text: string;
        card_id: string | null;
      }[]
    ).map((r) => ({ id: r.id, text: r.text, ...(r.card_id ? { cardId: r.card_id } : {}) }));
  }

  addPreference(canvasId: string, text: string, cardId: string | null): number {
    return (
      this.db
        .query('INSERT INTO preferences (canvas_id, text, card_id, created_at) VALUES ($c, $text, $cardId, $now) RETURNING id')
        .get({ c: canvasId, text, cardId, now: now() }) as { id: number }
    ).id;
  }

  /** Changes or (with `null`) deletes a preference of the canvas; returns whether it existed. */
  setPreference(canvasId: string, id: number, text: string | null): boolean {
    const r =
      text === null
        ? this.db.query('UPDATE preferences SET deleted_at = $now WHERE id = $id AND canvas_id = $c AND deleted_at IS NULL').run({ id, c: canvasId, now: now() })
        : this.db.query('UPDATE preferences SET text = $text WHERE id = $id AND canvas_id = $c AND deleted_at IS NULL').run({ id, c: canvasId, text });
    return r.changes > 0;
  }

  // ---------------------------------------------------------------- settings

  setting(canvasId: string, key: string): string | null {
    return (this.db.query('SELECT value FROM settings WHERE canvas_id = $c AND key = $key').get({ c: canvasId, key }) as { value: string } | null)?.value ?? null;
  }

  setSetting(canvasId: string, key: string, value: string) {
    this.db
      .query('INSERT INTO settings (canvas_id, key, value) VALUES ($c, $key, $value) ON CONFLICT(canvas_id, key) DO UPDATE SET value = $value')
      .run({ c: canvasId, key, value });
  }
}

const now = () => new Date().toISOString();
