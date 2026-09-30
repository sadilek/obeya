import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardKind, CardState, Need } from '../core/types';

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
];

export type NewRow = Pick<CardRow, 'canvas_id' | 'kind' | 'x' | 'y'> &
  Partial<Pick<CardRow, 'state' | 'title' | 'body' | 'parent_id' | 'plan_ref'>>;

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

  /** Every card of the canvas that is not deleted. */
  cards(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL').all({ c: canvasId }) as CardRow[];
  }

  card(id: string): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE id = $id').get({ id }) as CardRow | null) ?? null;
  }

  insert(rows: NewRow[]): CardRow[] {
    const stmt = this.db.query(
      `INSERT INTO cards (id, canvas_id, kind, state, title, body, x, y, parent_id, plan_ref, created_at, updated_at)
       VALUES ($id, $canvas_id, $kind, $state, $title, $body, $x, $y, $parent_id, $plan_ref, $now, $now)`,
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
          now: now(),
        });
        return id;
      }),
    )();
    return ids.map((id) => this.card(id)!);
  }

  update(id: string, fields: Partial<Pick<CardRow, 'x' | 'y' | 'kind' | 'title' | 'body' | 'state' | 'need' | 'deleted_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = $${k}`).join(', ');
    this.db.query(`UPDATE cards SET ${set}, updated_at = $now WHERE id = $id`).run({ ...fields, id, now: now() });
  }
}

const now = () => new Date().toISOString();
