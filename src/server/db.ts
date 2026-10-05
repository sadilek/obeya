import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardEvent, CardKind, CardState, Need, Preference, PreferenceState, Talk } from '../core/types';

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
  /** JSON: set while the Koordinator decides (`{ checking: true }`) or the card waits (`{ behind, reason }`), with `since`. */
  queue: string | null;
  /** JSON: the card's pull request once approval opened the PR phase (`PrState`). */
  pr: string | null;
  /** The owner's card's repository on a canvas with several; null is the home repository. */
  repo: string | null;
  /** JSON: the card's latest demo (`{ kind, dir, chapters, question? }`; no `kind` is a video). */
  demo: string | null;
  /** When the owner took the finished card off the canvas into the archive. */
  archived_at: string | null;
  /** JSON: an idea's status and brief (`{ status, brief }`). */
  idea: string | null;
  /** A prototype's idea. */
  prototype_of: string | null;
  /** When the owner approved work that could not land yet; its next handover lands without asking again. */
  approved_at: string | null;
  /**
   * JSON, while the card's work is on main and its worker finishes what remains (its workspace and
   * session are kept until then): `{ commit?, restart? }`, `restart` when it waits for Obeya to run the change.
   */
  landed: string | null;
  /** JSON: ids of the screenshots the owner attached to the card's task. */
  images: string | null;
  /** JSON, projects only: the plan doc as last read (`PlanDoc`), kept for the archive once the doc is gone. */
  plan: string | null;
  /** A card the Arbeitsrückschau proposed: what it rests on. */
  retro: string | null;
  /** JSON, while a worker's proposal waits: `Proposal` (an idea or a task, why, the questions to decide). */
  proposal: string | null;
  /** JSON: the plan docs (plan references) the landed work of a card that was an idea added. */
  plan_docs: string | null;
  /** JSON, prototypes only: how it ended (`end`, once archived) and its worker's proposal to build the idea on it (`proposal`). */
  prototype: string | null;
  /** A card that was an idea and is built on the branch of one of its prototypes: that prototype. */
  built_on: string | null;
  /** JSON: the demo's page for colleagues (`StoredShare` in share.ts); its slug stays once it was shared. */
  share: string | null;
}


/** A step in a card's history, as the Koordinator reads it; `created` marks a card of the owner's or a proposal. */
export interface Moment {
  at: string;
  cardId: string;
  kind: CardEvent['kind'] | 'created';
  author: CardEvent['author'];
  text: string;
}

/** Something the owner said: to an agent (`hint` a note or feedback, `answer`), in an idea (`talk`), to the Koordinator (`say`). */
export interface Utterance {
  at: string;
  kind: 'hint' | 'answer' | 'talk' | 'say';
  text: string;
  cardId?: string;
  title?: string;
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
export const MIGRATIONS = [
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
  // ideas are discussed before they are planned; a spike prototypes one and never lands
  `ALTER TABLE cards ADD COLUMN idea TEXT;
   ALTER TABLE cards ADD COLUMN spike_of TEXT REFERENCES cards(id);`,
  // what the owner said to the Koordinator and what it answered: its memory across sessions
  `CREATE TABLE talk (
     id INTEGER PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     at TEXT NOT NULL,
     said TEXT NOT NULL,
     reply TEXT NOT NULL,
     card_id TEXT REFERENCES cards(id),
     undone INTEGER NOT NULL DEFAULT 0
   );`,
  // an idea whose agent had the last word waits for the owner
  `UPDATE cards SET idea = json_set(idea, '$.yourTurn', json('true'))
   WHERE state = 'idea' AND idea IS NOT NULL
     AND (SELECT author FROM events WHERE card_id = cards.id AND kind = 'talk' ORDER BY id DESC LIMIT 1) = 'explorer';`,
  // screenshots the owner attached to a message (a JSON list of image ids)
  `ALTER TABLE events ADD COLUMN images TEXT;`,
  // a question the Koordinator looks up: answered later, by itself or a project agent
  `ALTER TABLE talk ADD COLUMN question TEXT;
   ALTER TABLE talk ADD COLUMN about TEXT;
   ALTER TABLE talk ADD COLUMN answer TEXT;
   ALTER TABLE talk ADD COLUMN answer_by TEXT;`,
  // an approval that could not land yet holds until the worker has fixed what stood in the way
  `ALTER TABLE cards ADD COLUMN approved_at TEXT;`,
  // landed work whose worker still finishes what remains after the landing
  `ALTER TABLE cards ADD COLUMN landed TEXT;`,
  // screenshots of a card's task, and of a command typed to the Koordinator (JSON lists of image ids)
  `ALTER TABLE cards ADD COLUMN images TEXT;
   ALTER TABLE talk ADD COLUMN images TEXT;`,
  // a project keeps its plan doc's last state, so it can go into the archive when the doc goes;
  // an idea's card remembers the plan docs its work added, so the project knows where it came from
  `ALTER TABLE cards ADD COLUMN plan TEXT;
   ALTER TABLE cards ADD COLUMN plan_docs TEXT;`,
  // a spike is called a prototype now
  `ALTER TABLE cards RENAME COLUMN spike_of TO prototype_of;`,
  // a learned rule is a proposal until the owner accepts it; the rules kept so far stay active
  `ALTER TABLE preferences ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
   ALTER TABLE preferences ADD COLUMN quote TEXT;
   ALTER TABLE preferences ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE preferences ADD COLUMN replaces INTEGER REFERENCES preferences(id);
   ALTER TABLE preferences ADD COLUMN decided_at TEXT;`,
  // a discarded or built prototype goes into the archive; an idea may be built on a prototype's branch
  `ALTER TABLE cards ADD COLUMN prototype TEXT;
   ALTER TABLE cards ADD COLUMN built_on TEXT REFERENCES cards(id);`,
  // a video demo shared with colleagues on a page outside Obeya
  `ALTER TABLE cards ADD COLUMN share TEXT;`,
  // a learned rule about a repository goes into its CLAUDE.md, not the preference memory
  `ALTER TABLE preferences ADD COLUMN target TEXT;`,
  // bugfix and feature are one kind now: a task
  `UPDATE cards SET kind = 'task' WHERE kind IN ('bugfix', 'feature');`,
  // the Arbeitsrückschau: friction noted on a card's run, per repository, and the cards it proposed
  `CREATE TABLE friction (
     id INTEGER PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id),
     repo TEXT NOT NULL,
     card_id TEXT NOT NULL REFERENCES cards(id),
     at TEXT NOT NULL,
     what TEXT NOT NULL,
     cost TEXT NOT NULL,
     fix TEXT NOT NULL
   );
   CREATE INDEX friction_repo ON friction (canvas_id, repo, at);
   ALTER TABLE cards ADD COLUMN retro TEXT;`,
  `ALTER TABLE cards ADD COLUMN proposal TEXT;`,
];

export type NewRow = Pick<CardRow, 'canvas_id' | 'kind' | 'x' | 'y'> &
  Partial<Pick<CardRow, 'state' | 'title' | 'body' | 'parent_id' | 'plan_ref' | 'from_id' | 'repo' | 'idea' | 'prototype_of' | 'prototype' | 'images' | 'retro' | 'proposal'>>;

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
    | 'idea'
    | 'approved_at'
    | 'landed'
    | 'images'
    | 'plan'
    | 'plan_docs'
    | 'from_id'
    | 'prototype'
    | 'built_on'
    | 'share'
    | 'proposal'
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
  shared(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND share IS NOT NULL').all({ c: canvasId }) as CardRow[];
  }

  archived(canvasId: string): CardRow[] {
    return this.db
      .query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC, created_at DESC')
      .all({ c: canvasId }) as CardRow[];
  }

  /** The canvas's projects, on the canvas or archived. */
  projects(canvasId: string): CardRow[] {
    return this.db.query("SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND kind = 'project' AND plan_ref IS NOT NULL").all({ c: canvasId }) as CardRow[];
  }

  /** The cards whose landed work added plan docs, on the canvas or archived. */
  withPlanDocs(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND plan_docs IS NOT NULL').all({ c: canvasId }) as CardRow[];
  }

  /** The canvas's prototypes, on the canvas or archived, the oldest first. */
  prototypes(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND prototype_of IS NOT NULL ORDER BY created_at, rowid').all({ c: canvasId }) as CardRow[];
  }

  /** The workstreams of the given projects. */
  children(parentIds: string[]): CardRow[] {
    if (!parentIds.length) return [];
    return this.db
      .query(`SELECT * FROM cards WHERE deleted_at IS NULL AND parent_id IN (${parentIds.map((_, i) => `$p${i}`).join(', ')})`)
      .all(Object.fromEntries(parentIds.map((id, i) => [`p${i}`, id]))) as CardRow[];
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
      `INSERT INTO cards (id, canvas_id, kind, state, title, body, x, y, parent_id, plan_ref, from_id, repo, idea, prototype_of, prototype, images, retro, proposal, created_at, updated_at)
       VALUES ($id, $canvas_id, $kind, $state, $title, $body, $x, $y, $parent_id, $plan_ref, $from_id, $repo, $idea, $prototype_of, $prototype, $images, $retro, $proposal, $now, $now)`,
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
          idea: r.idea ?? null,
          prototype_of: r.prototype_of ?? null,
          prototype: r.prototype ?? null,
          images: r.images ?? null,
          retro: r.retro ?? null,
          proposal: r.proposal ?? null,
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
      .query('INSERT INTO events (card_id, at, kind, author, text, code, images) VALUES ($cardId, $at, $kind, $author, $text, $code, $images) RETURNING id')
      .get({ ...e, code: e.code ?? null, images: e.images?.length ? JSON.stringify(e.images) : null, at }) as { id: number };
    return { ...e, id, at };
  }

  events(cardId: string, limit = 500): CardEvent[] {
    const rows = this.db
      .query('SELECT id, card_id AS cardId, at, kind, author, text, code, images FROM events WHERE card_id = $c ORDER BY id DESC LIMIT $limit')
      .all({ c: cardId, limit }) as (Omit<CardEvent, 'images'> & { code: CardEvent['code'] | null; images: string | null })[];
    return rows.reverse().map(({ code, images, ...e }) => ({ ...e, ...(code ? { code } : {}), ...(images ? { images: JSON.parse(images) as string[] } : {}) }));
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

  /** The decisions taken on one card outside any project (an idea's, say). */
  cardDecisions(canvasId: string, cardId: string): DecisionRow[] {
    return this.db
      .query('SELECT * FROM decisions WHERE canvas_id = $c AND card_id = $card AND project_id IS NULL ORDER BY id')
      .all({ c: canvasId, card: cardId }) as DecisionRow[];
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

  /** The canvas's preferences, oldest first: those in the given states, or all. */
  preferences(canvasId: string, states?: PreferenceState[]): Preference[] {
    return (
      this.db.query('SELECT * FROM preferences WHERE canvas_id = $c AND deleted_at IS NULL ORDER BY id').all({ c: canvasId }) as {
        id: number;
        text: string;
        card_id: string | null;
        state: PreferenceState;
        quote: string | null;
        review: number;
        replaces: number | null;
        target: string | null;
      }[]
    )
      .filter((r) => !states || states.includes(r.state))
      .map((r) => ({
        id: r.id,
        text: r.text,
        state: r.state,
        ...(r.card_id ? { cardId: r.card_id } : {}),
        ...(r.quote ? { quote: r.quote } : {}),
        ...(r.review ? { review: true } : {}),
        ...(r.replaces !== null ? { replaces: r.replaces } : {}),
        ...(r.target ? { target: r.target } : {}),
      }));
  }

  addPreference(
    canvasId: string,
    text: string,
    cardId: string | null,
    proposal?: { quote?: string; review?: boolean; replaces?: number; target?: string },
  ): number {
    return (
      this.db
        .query(
          `INSERT INTO preferences (canvas_id, text, card_id, created_at, state, quote, review, replaces, target)
           VALUES ($c, $text, $cardId, $now, $state, $quote, $review, $replaces, $target) RETURNING id`,
        )
        .get({
          c: canvasId,
          text,
          cardId,
          now: now(),
          state: proposal ? 'proposed' : 'active',
          quote: proposal?.quote ?? null,
          review: proposal?.review ? 1 : 0,
          replaces: proposal?.replaces ?? null,
          target: proposal?.target ?? null,
        }) as { id: number }
    ).id;
  }

  /** A rule the owner gives outright for the CLAUDE.md of the repository `target`: filed at once, without a proposal. */
  fileRule(canvasId: string, text: string, cardId: string | null, target: string): number {
    return (
      this.db
        .query(
          `INSERT INTO preferences (canvas_id, text, card_id, created_at, state, target)
           VALUES ($c, $text, $cardId, $now, 'filed', $target) RETURNING id`,
        )
        .get({ c: canvasId, text, cardId, now: now(), target }) as { id: number }
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

  /**
   * Accepts or rejects an open proposal; returns whether there was one. Accepted, it becomes an
   * active rule, or one filed for the repository `target`, whose CLAUDE.md it goes into.
   */
  decideProposal(canvasId: string, id: number, state: 'active' | 'rejected', target?: string | null): boolean {
    return (
      this.db
        .query(
          `UPDATE preferences SET state = $state, decided_at = $now, target = CASE WHEN $keep THEN target ELSE $target END
           WHERE id = $id AND canvas_id = $c AND state = 'proposed' AND deleted_at IS NULL`,
        )
        .run({ id, c: canvasId, state: state === 'active' && target ? 'filed' : state, now: now(), keep: target === undefined, target: target ?? null }).changes > 0
    );
  }

  // ---------------------------------------------------------------- the Koordinator's memory

  addTalk(canvasId: string, said: string, reply: string, cardId: string | null, lookUp?: { question: string; about: string | null }, images: string[] = []): number {
    return (
      this.db
        .query(
          'INSERT INTO talk (canvas_id, at, said, reply, card_id, question, about, images) VALUES ($c, $at, $said, $reply, $cardId, $question, $about, $images) RETURNING id',
        )
        .get({
          c: canvasId,
          at: now(),
          said,
          reply,
          cardId,
          question: lookUp?.question ?? null,
          about: lookUp?.about ?? null,
          images: images.length ? JSON.stringify(images) : null,
        }) as { id: number }
    ).id;
  }

  undoTalk(id: number) {
    this.db.query('UPDATE talk SET undone = 1 WHERE id = $id').run({ id });
  }

  answerTalk(id: number, answer: string, by: 'koordinator' | 'project') {
    this.db.query('UPDATE talk SET answer = $answer, answer_by = $by WHERE id = $id').run({ id, answer, by });
  }

  /** The latest exchanges, oldest first; with `withoutCard`, only those without an open card. */
  talk(canvasId: string, limit = 20, withoutCard = false): Talk[] {
    return (this.db.query(`SELECT * FROM talk WHERE canvas_id = $c${withoutCard ? ' AND card_id IS NULL' : ''} ORDER BY id DESC LIMIT $limit`).all({ c: canvasId, limit }) as TalkRow[])
      .reverse()
      .map(toTalk);
  }

  /** One exchange, with the card its question is about. */
  exchange(id: number): (Talk & { about?: string }) | null {
    const r = this.db.query('SELECT * FROM talk WHERE id = $id').get({ id }) as TalkRow | null;
    return r ? { ...toTalk(r), ...(r.about ? { about: r.about } : {}) } : null;
  }

  /** Questions being looked up, oldest first. */
  lookingUp(canvasId: string): number[] {
    return (this.db.query('SELECT id FROM talk WHERE canvas_id = $c AND question IS NOT NULL AND answer IS NULL ORDER BY id').all({ c: canvasId }) as { id: number }[]).map((r) => r.id);
  }

  /**
   * How the cards got where they are, after `since` (ISO time), oldest first: their milestones
   * (state changes, questions, answers, hand-overs, the owner's notes, errors) and the creation of
   * cards that come from no plan doc. Deleted cards are left out.
   */
  timeline(canvasId: string, since: string, limit: number): Moment[] {
    return (
      this.db
        .query(
          // within one millisecond, cards are created before anything happens to them, each in the order it was written
          `SELECT at, cardId, kind, author, text FROM (
             SELECT e.at, e.card_id AS cardId, e.kind, e.author, e.text, 1 AS phase, e.id AS seq FROM events e JOIN cards c ON c.id = e.card_id
             WHERE c.canvas_id = $c AND c.deleted_at IS NULL AND e.at > $since AND e.kind IN ('state', 'question', 'answer', 'review', 'hint', 'error')
             UNION ALL
             SELECT created_at, id, 'created', CASE WHEN from_id IS NULL THEN 'owner' ELSE 'worker' END, '', 0, rowid FROM cards
             WHERE canvas_id = $c AND deleted_at IS NULL AND plan_ref IS NULL AND created_at > $since
           ) ORDER BY at DESC, phase DESC, seq DESC LIMIT $limit`,
        )
        .all({ c: canvasId, since, limit }) as Moment[]
    ).reverse();
  }

  /**
   * What the owner said after `since` (ISO time), oldest first, at most the latest `limit`: notes,
   * feedback and answers to agents, an idea's discussion, and what they said to the Koordinator
   * (unless taken back).
   */
  utterances(canvasId: string, since: string, limit: number): Utterance[] {
    return (
      this.db
        .query(
          `SELECT at, cardId, title, kind, text FROM (
             SELECT e.at, e.card_id AS cardId, c.title, e.kind, e.text, e.id AS seq FROM events e JOIN cards c ON c.id = e.card_id
             WHERE c.canvas_id = $c AND e.author = 'owner' AND e.kind IN ('hint', 'answer', 'talk') AND e.at > $since
             UNION ALL
             SELECT t.at, t.card_id, c.title, 'say', t.said, t.id FROM talk t LEFT JOIN cards c ON c.id = t.card_id
             WHERE t.canvas_id = $c AND t.undone = 0 AND t.at > $since
           ) ORDER BY at DESC, seq DESC LIMIT $limit`,
        )
        .all({ c: canvasId, since, limit }) as { at: string; cardId: string | null; title: string | null; kind: Utterance['kind']; text: string }[]
    )
      .reverse()
      .map((r) => ({ at: r.at, kind: r.kind, text: r.text, ...(r.cardId ? { cardId: r.cardId } : {}), ...(r.title ? { title: r.title } : {}) }));
  }

  /** Proposals the owner accepted or rejected after `since` (ISO time), oldest first. */
  decidedProposals(canvasId: string, since: string): { at: string; text: string; state: 'active' | 'rejected' | 'filed'; quote?: string; target?: string }[] {
    return (
      this.db
        .query(`SELECT decided_at AS at, text, state, quote, target FROM preferences WHERE canvas_id = $c AND decided_at > $since ORDER BY decided_at`)
        .all({ c: canvasId, since }) as { at: string; text: string; state: 'active' | 'rejected' | 'filed'; quote: string | null; target: string | null }[]
    ).map(({ quote, target, ...r }) => ({ ...r, ...(quote ? { quote } : {}), ...(target ? { target } : {}) }));
  }

  /**
   * Cards of the owner's deleted after `since` (ISO time), oldest first, with the state they had: a
   * worker's proposal the owner dismissed, say. Plan cards go with their plan doc, not by a click.
   */
  removed(canvasId: string, since: string): { at: string; title: string; state: CardState }[] {
    return this.db
      .query(`SELECT deleted_at AS at, title, COALESCE(state, 'planned') AS state FROM cards WHERE canvas_id = $c AND plan_ref IS NULL AND deleted_at > $since ORDER BY deleted_at`)
      .all({ c: canvasId, since }) as { at: string; title: string; state: CardState }[];
  }

  // ---------------------------------------------------------------- the Arbeitsrückschau

  addFriction(canvasId: string, repo: string, cardId: string, notes: FrictionNote[]) {
    const stmt = this.db.query('INSERT INTO friction (canvas_id, repo, card_id, at, what, cost, fix) VALUES ($c, $repo, $card, $at, $what, $cost, $fix)');
    const at = now();
    this.db.transaction(() => notes.forEach((n) => stmt.run({ c: canvasId, repo, card: cardId, at, ...n })))();
  }

  /** The friction noted on a repository's cards after `since` (ISO time; all without), oldest first, with each card's title. */
  friction(canvasId: string, repo: string, since: string | null): Friction[] {
    return this.db
      .query(
        `SELECT f.card_id AS cardId, COALESCE(c.title, '') AS title, f.at, f.what, f.cost, f.fix FROM friction f JOIN cards c ON c.id = f.card_id
         WHERE f.canvas_id = $c AND f.repo = $repo AND f.at > $since ORDER BY f.at, f.id`,
      )
      .all({ c: canvasId, repo, since: since ?? '' }) as Friction[];
  }

  /** The cards the Arbeitsrückschau proposed for a repository (`null`: the home repository), oldest first, with what became of them. */
  retroProposals(canvasId: string, repo: string | null): { title: string; retro: string; state: CardState; dismissed: boolean }[] {
    return (
      this.db
        .query(`SELECT COALESCE(title, '') AS title, retro, COALESCE(state, 'planned') AS state, deleted_at FROM cards WHERE canvas_id = $c AND retro IS NOT NULL AND repo IS $repo ORDER BY created_at, rowid`)
        .all({ c: canvasId, repo }) as { title: string; retro: string; state: CardState; deleted_at: string | null }[]
    ).map(({ deleted_at, ...r }) => ({ ...r, dismissed: !!deleted_at && r.state === 'proposal' }));
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

/** One piece of friction in a worker's run: what went wrong, what it cost, what would have prevented it. */
export interface FrictionNote {
  what: string;
  cost: string;
  fix: string;
}
export interface Friction extends FrictionNote {
  cardId: string;
  /** The card's title. */
  title: string;
  at: string;
}

interface TalkRow {
  id: number;
  at: string;
  said: string;
  reply: string;
  card_id: string | null;
  undone: number;
  question: string | null;
  about: string | null;
  answer: string | null;
  answer_by: 'koordinator' | 'project' | null;
  images: string | null;
}

const toTalk = (r: TalkRow): Talk => ({
  id: r.id,
  at: r.at,
  said: r.said,
  reply: r.reply,
  ...(r.card_id ? { cardId: r.card_id } : {}),
  ...(r.undone ? { undone: true } : {}),
  ...(r.question ? { question: r.question } : {}),
  ...(r.answer !== null ? { answer: r.answer } : {}),
  ...(r.answer_by ? { answerBy: r.answer_by } : {}),
  ...(r.images ? { images: JSON.parse(r.images) as string[] } : {}),
});
