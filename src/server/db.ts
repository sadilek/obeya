import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnswerFile, AnswerRef, CardEvent, DeviceView, CardKind, CardState, Mock, Need, Preference, PreferenceState, ProposedSetting, RepoCommands, SettingProposal, SettingProposalState, Spot, Talk, TalkAfter, TalkMoved, TalkQuote, TalkRef, TalkWait } from '../core/types';
import type { Wish } from '../core/wish';

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
  /**
   * When something last happened at the card: an update of the row or a line in its log other than
   * a worker's tool activity. Moving it on the canvas or into a group, or folding a project, does not count.
   */
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
  /** JSON: the card's pull request once approval opened the PR phase (`PrState`); on a review card, the one it reviews from the start. */
  pr: string | null;
  /** JSON, review cards only: the contributor's pull request the card reviews (`StoredContribution` in board.ts). */
  contribution: string | null;
  /** The owner's card's repository on a canvas with several; null is the home repository. */
  repo: string | null;
  /** JSON: the card's latest demo (`{ kind, dir, chapters, question? }`; no `kind` is a video). */
  demo: string | null;
  /** JSON: the demos of earlier handovers a later one replaced, the oldest first, each as `demo` was; append only. */
  demos: string | null;
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
  /** The group the card belongs to; a project's covers its workstreams, whose own stays null. */
  group_id: string | null;
  /**
   * JSON, once the card's work landed (`Shipped` in board.ts): the commit it landed with and its
   * pull request. Kept after its worker is done: a workstream whose plan doc keeps it open is
   * planned again once the Lesestand holds that commit.
   */
  shipped: string | null;
  /** When Obeya stopped the app in the card's workspace while the card waited (Parking); gone once its worker heard so. */
  parked: string | null;
  /** JSON: the owner's comments on places in the demo video Obeya holds back while they watch (event ids, `Item.held`). */
  held: string | null;
  /** 1 once the owner decided the card (an idea or a task of theirs) becomes a project: its worker writes the plan doc, and the project takes its place. */
  becomes_project: number;
  /** JSON, a Question card (and an idea that was one): the thread of looked-up answers it holds (`StoredThread` in board.ts). */
  thread: string | null;
  /** JSON, while the owner has paused the card's agent: for a worker what came for it meanwhile (`PausedState` in workers.ts), `{}` for an idea's or a Question card's agent, which keep what waits for them with the idea or the thread. */
  paused: string | null;
  /** Since when (ISO) the owner has asked the card's agent to pause once it has brought its work to a safe point; null once it paused, went on or stopped. */
  pausing: string | null;
  /** JSON: the owner's words Obeya holds for the card's worker until it takes them in, at its next tool step or turn (`Unheard` in workers.ts). */
  unheard: string | null;
  /** The address its worker opens the app in the card's workspace at, while it runs (`app_running`); gone once Obeya stops the app or the workspace goes. */
  app: string | null;
  /** Since when the card waits for the owner (`needsYou`), kept while it does; null while it does not. */
  waiting_since: string | null;
  /** JSON, while the card is snoozed until a point in time (`Snooze`): Obeya wakes it then. */
  snoozed: string | null;
  /** JSON: the files its worker named as the result at its latest handover that named any (`CardFile[]`). */
  files: string | null;
  /** JSON, projects only: which workstream builds on which, as the Koordinator read it from the plan doc (`StoredDeps` in board.ts). */
  deps: string | null;
  /** 1 while the owner has a project folded to its head: its workstreams are not shown on the canvas. */
  collapsed: number;
  /**
   * The clone (`ssh://<host>/…` on a host) that holds the newest state of the card's branch since
   * the owner took its workspace from it, its uncommitted work in a commit of Obeya's on top; gone
   * once the card works in a clone again, which takes the branch from there.
   */
  kept_in: string | null;
  /**
   * JSON: a repository to create for the card before work begins (`NewRepo`); once Obeya made it,
   * `{ path, canvas, made: true }`, so its worker hears that the repository is new.
   */
  new_repo: string | null;
  /** What the card's worker last heard of its demo's page (`PageHeard` in workers.ts), so it hears of a change with its next step. */
  page_heard: string | null;
}

/** Words the usage limit keeps the Koordinator from reading (`talk.held`): until when, and how it reads them then (`Commander`'s). */
export interface HeldTalk {
  until: string;
  reading: unknown;
}

/** A card the Koordinator waits on (`talk.waits`), and the step it said it takes once the card gets there. */
export interface TalkWaitRow extends TalkWait {
  then: string;
}

export interface GroupRow {
  id: string;
  canvas_id: string;
  name: string;
  hue: number;
  created_at: string;
}


/**
 * Where the cards' history stood when it was read: the time, and the latest event and card then.
 * What is written later has a larger id, even within the same millisecond or once the clock went back.
 */
export interface Mark {
  at: string;
  event: number;
  card: number;
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

/** The schema Obeya was released with. */
const SCHEMA = `
  CREATE TABLE canvases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    name TEXT NOT NULL,
    hue INTEGER NOT NULL,
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
    session_id TEXT,
    workspace TEXT,
    branch TEXT,
    status_line TEXT,
    detail TEXT,
    from_id TEXT REFERENCES cards(id),
    scope TEXT,
    queue TEXT,
    pr TEXT,
    repo TEXT,
    demo TEXT,
    archived_at TEXT,
    idea TEXT,
    prototype_of TEXT REFERENCES cards(id),
    approved_at TEXT,
    landed TEXT,
    images TEXT,
    plan TEXT,
    plan_docs TEXT,
    prototype TEXT,
    built_on TEXT REFERENCES cards(id),
    share TEXT,
    retro TEXT,
    proposal TEXT,
    group_id TEXT REFERENCES groups(id),
    shipped TEXT,
    parked TEXT,
    held TEXT,
    becomes_project INTEGER NOT NULL DEFAULT 0,
    thread TEXT,
    paused TEXT,
    unheard TEXT,
    UNIQUE (canvas_id, plan_ref)
  );
  CREATE TABLE workspaces (
    path TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    card_id TEXT REFERENCES cards(id),
    repo TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    code TEXT,
    images TEXT,
    mocks TEXT,
    reply_to INTEGER,
    spot TEXT,
    answer TEXT,
    picks TEXT,
    unread INTEGER,
    read_after INTEGER
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
  );
  CREATE TABLE settings (
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
    deleted_at TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    quote TEXT,
    review INTEGER NOT NULL DEFAULT 0,
    replaces INTEGER REFERENCES preferences(id),
    decided_at TEXT,
    target TEXT
  );
  -- what the owner said to the Koordinator and what it answered: its memory across sessions
  CREATE TABLE talk (
    id INTEGER PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    at TEXT NOT NULL,
    said TEXT NOT NULL,
    reply TEXT NOT NULL,
    card_id TEXT REFERENCES cards(id),
    undone INTEGER NOT NULL DEFAULT 0,
    question TEXT,
    about TEXT,
    answer TEXT,
    answer_by TEXT,
    images TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    thread INTEGER,
    follows INTEGER,
    files TEXT,
    card TEXT
  );
  -- the Arbeitsrückschau: friction noted on a card's run, per repository
  CREATE TABLE friction (
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
  -- a command the owner has the confirmation of, while it waits for "Rückgängig": it outlives a restart
  CREATE TABLE commands (
    token TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    due TEXT NOT NULL,
    body TEXT NOT NULL
  );
  -- a value for a repository's setting the Arbeitsrückschau proposes, and where the owner took it
  CREATE TABLE setting_proposals (
    id INTEGER PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    repo TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    basis TEXT NOT NULL,
    cards TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );`;

/**
 * The `user_version` of a database at `SCHEMA`: the steps its schema took before the release. One
 * that took fewer is from an Obeya before it (`OlderDatabase`).
 */
export const RELEASED = 40;

// Append only; each entry runs once on a database at `SCHEMA`, tracked in `PRAGMA user_version` after `RELEASED`.
export const MIGRATIONS = [
  // what an Obeya before the release kept in shapes that changed since, in today's: demos and
  // shared pages without a kind are videos; a share held for undo publishes; `answering` moves out
  // of the demo; a demo's question goes with the last handover before the owner answered it (else
  // the last one); a project whose doc went before Obeya kept it gets an empty one; the pause line
  // loses its second sentence; a repository with retrospectives before they were counted is past the ramp
  `UPDATE cards SET demo = json_set(demo, '$.kind', 'video') WHERE demo IS NOT NULL AND json_extract(demo, '$.kind') IS NULL;
   UPDATE cards SET share = json_set(share, '$.shown.kind', 'video') WHERE json_extract(share, '$.shown') IS NOT NULL AND json_extract(share, '$.shown.kind') IS NULL;
   UPDATE cards SET share = json_set(share, '$.state', 'publishing') WHERE json_extract(share, '$.state') = 'pending';
   UPDATE cards SET detail = json_set(coalesce(detail, '{}'), '$.answering', json('true')), demo = json_remove(demo, '$.answering')
    WHERE json_extract(demo, '$.answering');
   UPDATE cards SET demo = json_set(demo, '$.handover', (
       SELECT max(e.id) FROM events e WHERE e.card_id = cards.id AND e.kind = 'review'
          AND e.id < coalesce((SELECT max(a.id) FROM events a WHERE a.card_id = cards.id AND a.kind = 'answer' AND a.text = json_extract(cards.demo, '$.answer')), 9e18)))
    WHERE json_extract(demo, '$.question') IS NOT NULL AND json_extract(demo, '$.handover') IS NULL
      AND EXISTS (SELECT 1 FROM events e WHERE e.card_id = cards.id AND e.kind = 'review');
   UPDATE cards SET plan = json_object('file', plan_ref, 'title', coalesce(title, plan_ref), 'goal', '', 'workstreams', json('[]'), 'markdown', '')
    WHERE kind = 'project' AND plan_ref IS NOT NULL AND plan IS NULL;
   UPDATE events SET text = 'Paused.' WHERE kind = 'state' AND author = 'owner' AND text LIKE 'Paused. %';
   UPDATE events SET text = 'Pausiert.' WHERE kind = 'state' AND author = 'owner' AND text LIKE 'Pausiert. %';
   INSERT INTO settings (canvas_id, key, value)
     SELECT canvas_id, 'work_retro_runs:' || substr(key, 18), '3' FROM settings s WHERE key LIKE 'work_retro_since:%'
        AND NOT EXISTS (SELECT 1 FROM settings r WHERE r.canvas_id = s.canvas_id AND r.key = 'work_retro_runs:' || substr(s.key, 18));`,
  // the message of the sheet the owner's words reply to (JSON `TalkRef`)
  'ALTER TABLE talk ADD COLUMN reply_to TEXT;',
  // where the app in a card's workspace runs, for the owner to try it by hand
  'ALTER TABLE cards ADD COLUMN app TEXT;',
  // devices paired to reach Obeya from another machine: the hash of each one's cookie
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );`,
  // Obeya's reply says it cannot do what the owner asked, or the owner asked to tell its makers: what a draft for them starts from (JSON `Wish`)
  'ALTER TABLE talk ADD COLUMN wish TEXT; ALTER TABLE events ADD COLUMN wish TEXT;',
  // the demos of earlier handovers a later one replaced
  'ALTER TABLE cards ADD COLUMN demos TEXT;',
  // since when a card waits for the owner, for the phone view's „Für dich“
  'ALTER TABLE cards ADD COLUMN waiting_since TEXT;',
  // a repository's commands as the owner last confirmed them, by its path (JSON `RepoCommands`)
  `CREATE TABLE trusted_commands (
    repo TEXT PRIMARY KEY,
    commands TEXT NOT NULL,
    at TEXT NOT NULL
  );`,
  // a paired device's push subscription (JSON `Subscription`), where it turned notifications on
  'ALTER TABLE devices ADD COLUMN push TEXT;',
  // words the usage limit kept the Koordinator from reading, until it lifts (JSON `HeldTalk`)
  'ALTER TABLE talk ADD COLUMN held TEXT;',
  // a card set aside until a point in time, by its worker or the owner (JSON `Snooze`)
  'ALTER TABLE cards ADD COLUMN snoozed TEXT;',
  // cards the Koordinator waits on to take a step then (JSON `TalkWaitRow[]`), and the exchange it took that step up in (JSON `TalkAfter`)
  'ALTER TABLE talk ADD COLUMN waits TEXT; ALTER TABLE talk ADD COLUMN after_wait TEXT;',
  // what a card changed in a folder without git, and the undo it has there (JSON `FolderCard`, folder.ts)
  `CREATE TABLE folder_cards (
    card_id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    state TEXT NOT NULL
  );`,
  // the files a card's worker named as its result at its handover (JSON `CardFile[]`)
  'ALTER TABLE cards ADD COLUMN files TEXT;',
  // which workstream of a project builds on which, read from its plan doc to arrange them (JSON `StoredDeps`)
  'ALTER TABLE cards ADD COLUMN deps TEXT;',
  // a project the owner folded to its head
  'ALTER TABLE cards ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;',
  // words the owner wrote in a project's sheet, which went straight to its project agent: that project
  'ALTER TABLE talk ADD COLUMN asked_in TEXT;',
  // Obeya's reply on a card that answers the owner's words without acting on them: it stands in the conversation
  'ALTER TABLE events ADD COLUMN reply INTEGER;',
  // the clone holding a card's branch since the owner took its workspace from it
  'ALTER TABLE cards ADD COLUMN kept_in TEXT;',
  // a review card: the pull request of someone outside it reviews (JSON `StoredContribution`)
  'ALTER TABLE cards ADD COLUMN contribution TEXT;',
  // a repository to create for a card before work begins, and that Obeya made it (JSON `StoredNewRepo` in board.ts);
  // an exchange of no one's in the sheet that says a card moved to another canvas (JSON `TalkMoved`)
  'ALTER TABLE cards ADD COLUMN new_repo TEXT; ALTER TABLE talk ADD COLUMN moved TEXT;',
  // what a card's worker last heard of its demo's page (JSON `PageHeard` in workers.ts)
  'ALTER TABLE cards ADD COLUMN page_heard TEXT;',
  // Obeya's reply on a card to what its agent passed on from the owner's words (`to_obeya`)
  'ALTER TABLE events ADD COLUMN forwarded INTEGER;',
  // since when the owner asked the card's agent to pause at a safe point, until it has (ISO)
  'ALTER TABLE cards ADD COLUMN pausing TEXT;',
  // a question looked up for an action that needs its answer: the step the Koordinator takes then, and
  // the exchange of no one's it took that step up in (the id of the exchange whose answer came in)
  'ALTER TABLE talk ADD COLUMN then_step TEXT; ALTER TABLE talk ADD COLUMN after_answer INTEGER;',
  // an error of a session that signed in with a token rather than this machine's account
  'ALTER TABLE events ADD COLUMN token INTEGER;',
];

const EVENT_COLUMNS = 'id, card_id AS cardId, at, kind, author, text, code, images, mocks, reply_to AS replyTo, spot, answer, picks, unread, read_after AS readAfter, wish, reply, forwarded, token';
type EventRow = Omit<CardEvent, 'images' | 'mocks' | 'replyTo' | 'spot' | 'answer' | 'picks' | 'unread' | 'readAfter' | 'wish' | 'reply' | 'forwarded' | 'token'> & {
  code: CardEvent['code'] | null;
  images: string | null;
  mocks: string | null;
  replyTo: number | null;
  spot: string | null;
  answer: string | null;
  picks: string | null;
  unread: number | null;
  readAfter: number | null;
  wish: string | null;
  reply: number | null;
  forwarded: number | null;
  token: number | null;
};
const eventOf = ({ code, images, mocks, replyTo, spot, answer, picks, unread, readAfter, wish, reply, forwarded, token, ...e }: EventRow): CardEvent => ({
  ...e,
  ...(code ? { code } : {}),
  ...(images ? { images: JSON.parse(images) as string[] } : {}),
  ...(mocks ? { mocks: JSON.parse(mocks) as Mock[] } : {}),
  ...(replyTo ? { replyTo } : {}),
  ...(spot ? { spot: JSON.parse(spot) as Spot } : {}),
  ...(answer ? { answer: JSON.parse(answer) as AnswerRef } : {}),
  ...(picks ? { picks: JSON.parse(picks) as string[] } : {}),
  ...(unread ? { unread: true as const } : {}),
  ...(readAfter ? { readAfter } : {}),
  ...(wish ? { wish: JSON.parse(wish) as Wish } : {}),
  ...(reply ? { reply: true as const } : {}),
  ...(forwarded ? { forwarded: true as const } : {}),
  ...(token ? { token: true as const } : {}),
});

export type NewRow = Pick<CardRow, 'canvas_id' | 'kind' | 'x' | 'y'> &
  Partial<Pick<CardRow, 'state' | 'title' | 'body' | 'parent_id' | 'plan_ref' | 'from_id' | 'repo' | 'idea' | 'prototype_of' | 'prototype' | 'images' | 'retro' | 'proposal' | 'group_id'>>;

/** What `Store.update` may change on a card: all but what is set once at its creation, and its times. */
export type RowUpdate = Partial<Omit<CardRow, 'id' | 'canvas_id' | 'parent_id' | 'plan_ref' | 'prototype_of' | 'retro' | 'created_at' | 'updated_at'>>;

/** A database this Obeya cannot open as it is: it leaves it alone. */
export class UnusableDatabase extends Error {}

/** The database was written by a newer Obeya (the checkout and the app share one home). */
export class NewerDatabase extends UnusableDatabase {
  constructor(path: string, version: number, known: number) {
    super(`${path} is from a newer Obeya (schema ${version}; this one knows ${known}): update Obeya or start the newer one`);
  }
}

/** The database was written by an Obeya before the release and not brought up to it. */
export class OlderDatabase extends UnusableDatabase {
  constructor(path: string, version: number) {
    super(
      `${path} is from an Obeya before its release (schema ${version}): start the Obeya of commit 1cfa1dd once to bring it up to date, or move it away to start afresh`,
    );
  }
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    const { user_version } = this.db.query('PRAGMA user_version').get() as { user_version: number };
    const latest = RELEASED + MIGRATIONS.length;
    if (user_version > latest || (user_version > 0 && user_version < RELEASED)) {
      this.db.close();
      throw user_version > latest ? new NewerDatabase(path, user_version, latest) : new OlderDatabase(path, user_version);
    }
    if (user_version === 0)
      this.db.transaction(() => {
        this.db.run(SCHEMA);
        this.db.run(`PRAGMA user_version = ${RELEASED}`);
      })();
    for (let v = Math.max(user_version, RELEASED); v < latest; v++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[v - RELEASED]!);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  /** A canvas's name as last stored; none for a canvas this database has never seen. */
  canvasName(id: string): string | null {
    return (this.db.query('SELECT name FROM canvases WHERE id = $id').get({ id }) as { name: string } | null)?.name ?? null;
  }

  /**
   * The card goes to another canvas, at `at`, with its history and decisions: into that canvas's
   * home repository (`repo` null) and out of its group, which belongs to the canvas it leaves.
   */
  moveCard(id: string, canvasId: string, at: { x: number; y: number }, fields: RowUpdate = {}) {
    this.db.transaction(() => {
      this.update(id, { ...fields, x: at.x, y: at.y, repo: null, group_id: null });
      this.db.query('UPDATE cards SET canvas_id = $c WHERE id = $id').run({ id, c: canvasId });
      this.db.query('UPDATE decisions SET canvas_id = $c WHERE card_id = $id').run({ id, c: canvasId });
    })();
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

  /** The canvas's cards, archived ones too, that were ever shared or are about to be. */
  shared(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND share IS NOT NULL').all({ c: canvasId }) as CardRow[];
  }

  /** The canvas's archive, the most recently archived first. */
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

  /** Deletes the owner's cards left empty (no title, text or screenshots), created before `before`; returns how many. */
  sweepUntitled(canvasId: string, before: string): number {
    return this.db
      .query(
        `UPDATE cards SET deleted_at = $now
         WHERE canvas_id = $c AND plan_ref IS NULL AND deleted_at IS NULL AND state = 'planned'
           AND TRIM(COALESCE(title, '')) = '' AND TRIM(COALESCE(body, '')) = '' AND images IS NULL
           AND created_at < $before`,
      )
      .run({ c: canvasId, before, now: now() }).changes;
  }

  /** The proposals an agent made from a card, deleted and archived ones too, oldest first. */
  proposalsFrom(canvasId: string, fromId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND from_id = $f AND proposal IS NOT NULL ORDER BY created_at, rowid').all({ c: canvasId, f: fromId }) as CardRow[];
  }

  card(id: string): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE id = $id').get({ id }) as CardRow | null) ?? null;
  }

  insert(rows: NewRow[]): CardRow[] {
    const stmt = this.db.query(
      `INSERT INTO cards (id, canvas_id, kind, state, title, body, x, y, parent_id, plan_ref, from_id, repo, idea, prototype_of, prototype, images, retro, proposal, group_id, created_at, updated_at)
       VALUES ($id, $canvas_id, $kind, $state, $title, $body, $x, $y, $parent_id, $plan_ref, $from_id, $repo, $idea, $prototype_of, $prototype, $images, $retro, $proposal, $group_id, $now, $now)`,
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
          group_id: r.group_id ?? null,
          now: now(),
        });
        return id;
      }),
    )();
    return ids.map((id) => this.card(id)!);
  }

  /** Since when each of the canvas's cards waits for the owner, for those that do. */
  waitingSince(canvasId: string): Map<string, string> {
    const rows = this.db.query('SELECT id, waiting_since AS since FROM cards WHERE canvas_id = $c AND waiting_since IS NOT NULL').all({ c: canvasId }) as { id: string; since: string }[];
    return new Map(rows.map((r) => [r.id, r.since]));
  }

  /** Notes since when a card waits for the owner, or that it no longer does (`null`); the card counts as unchanged. */
  setWaitingSince(id: string, since: string | null) {
    this.db.query('UPDATE cards SET waiting_since = $since WHERE id = $id').run({ id, since });
  }

  update(id: string, fields: RowUpdate) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = $${k}`).join(', ');
    // the card's place on the canvas, or a project folded or unfolded, is no change at the card
    const moved = keys.every((k) => k === 'x' || k === 'y' || k === 'collapsed');
    this.db.query(`UPDATE cards SET ${set}${moved ? '' : ', updated_at = $now'} WHERE id = $id`).run({ ...fields, id, ...(moved ? {} : { now: now() }) });
  }

  // ---------------------------------------------------------------- groups

  /** The canvas's groups, the oldest first. */
  groups(canvasId: string): GroupRow[] {
    return this.db.query('SELECT * FROM groups WHERE canvas_id = $c ORDER BY created_at, rowid').all({ c: canvasId }) as GroupRow[];
  }

  group(id: string): GroupRow | null {
    return (this.db.query('SELECT * FROM groups WHERE id = $id').get({ id }) as GroupRow | null) ?? null;
  }

  addGroup(canvasId: string, name: string, hue: number): GroupRow {
    const id = crypto.randomUUID();
    this.db.query('INSERT INTO groups (id, canvas_id, name, hue, created_at) VALUES ($id, $c, $name, $hue, $now)').run({ id, c: canvasId, name, hue, now: now() });
    return this.group(id)!;
  }

  /** The cards in the group, on the canvas or in the archive. */
  groupCards(id: string): string[] {
    return (this.db.query('SELECT id FROM cards WHERE group_id = $id AND deleted_at IS NULL ORDER BY rowid').all({ id }) as { id: string }[]).map((r) => r.id);
  }

  renameGroup(id: string, name: string) {
    this.db.query('UPDATE groups SET name = $name WHERE id = $id').run({ id, name });
  }

  /** Puts the cards into the group, or with `null` into none. */
  setGroup(cardIds: string[], groupId: string | null) {
    const stmt = this.db.query('UPDATE cards SET group_id = $g WHERE id = $id');
    this.db.transaction(() => cardIds.forEach((id) => stmt.run({ id, g: groupId })))();
  }

  /** Removes the groups no card belongs to, on the canvas or in the archive; returns how many. */
  dropEmptyGroups(canvasId: string): number {
    return this.db.transaction(() => {
      // a deleted card that comes back has no group any more
      this.db
        .query('UPDATE cards SET group_id = NULL WHERE canvas_id = $c AND deleted_at IS NOT NULL AND group_id IS NOT NULL')
        .run({ c: canvasId });
      return this.db
        .query('DELETE FROM groups WHERE canvas_id = $c AND id NOT IN (SELECT group_id FROM cards WHERE canvas_id = $c AND group_id IS NOT NULL)')
        .run({ c: canvasId }).changes;
    })();
  }

  // ---------------------------------------------------------------- events

  /** A line in a card's log, said now or (`at`) earlier: a thread copied onto its Question card keeps its times. */
  addEvent(e: Omit<CardEvent, 'id' | 'at'> & { at?: string }): CardEvent {
    const at = e.at ?? now();
    const { id } = this.db
      .query(
        'INSERT INTO events (card_id, at, kind, author, text, code, images, mocks, reply_to, spot, answer, picks, unread, wish, reply, forwarded, token) VALUES ($cardId, $at, $kind, $author, $text, $code, $images, $mocks, $replyTo, $spot, $answer, $picks, $unread, $wish, $reply, $forwarded, $token) RETURNING id',
      )
      .get({
        ...e,
        answer: e.answer ? JSON.stringify(e.answer) : null,
        code: e.code ?? null,
        images: e.images?.length ? JSON.stringify(e.images) : null,
        mocks: e.mocks?.length ? JSON.stringify(e.mocks) : null,
        replyTo: e.replyTo ?? null,
        spot: e.spot ? JSON.stringify(e.spot) : null,
        picks: e.picks?.length ? JSON.stringify(e.picks) : null,
        unread: e.unread ? 1 : null,
        wish: e.wish ? JSON.stringify(e.wish) : null,
        reply: e.reply ? 1 : null,
        forwarded: e.forwarded ? 1 : null,
        token: e.token ? 1 : null,
        at,
      }) as { id: number };
    if (e.kind !== 'activity') this.db.query('UPDATE cards SET updated_at = max(updated_at, $at) WHERE id = $id').run({ id: e.cardId, at });
    return { ...e, id, at };
  }

  /** The latest messages of the card's conversation (`talk`, `question`), however many other lines came between them, oldest first. */
  talkOf(cardId: string, limit: number): CardEvent[] {
    const rows = this.db
      .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE card_id = $c AND kind IN ('talk', 'question') ORDER BY id DESC LIMIT $limit`)
      .all({ c: cardId, limit }) as EventRow[];
    return rows.reverse().map(eventOf);
  }

  events(cardId: string, limit = 500): CardEvent[] {
    const rows = this.db
      .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE card_id = $c ORDER BY id DESC LIMIT $limit`)
      .all({ c: cardId, limit }) as EventRow[];
    return rows.reverse().map(eventOf);
  }

  /**
   * The agent read the owner's words of these events now: they are read, and those logged before
   * the card's latest line that was read stand after it (`readAfter`). Returns those that were unread, as they are now.
   */
  readEvents(cardId: string, ids: number[]): CardEvent[] {
    return this.db.transaction(() => {
      ids = ids.filter((id) => this.event(cardId, id)?.unread);
      if (!ids.length) return [];
      const { last } = this.db.query('SELECT MAX(id) AS last FROM events WHERE card_id = $c AND unread IS NULL').get({ c: cardId }) as { last: number | null };
      const read = this.db.query('UPDATE events SET unread = NULL, read_after = CASE WHEN $last > id THEN $last END WHERE card_id = $c AND id = $id AND unread = 1');
      for (const id of ids) read.run({ c: cardId, id, last });
      return ids.map((id) => this.event(cardId, id)).filter((e) => !!e);
    })();
  }

  /** Takes an event out of the card's log. */
  deleteEvent(cardId: string, id: number) {
    this.db.query('DELETE FROM events WHERE card_id = $c AND id = $id').run({ c: cardId, id });
  }

  /** One event of the card's log. */
  event(cardId: string, id: number): CardEvent | undefined {
    const row = this.db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE card_id = $c AND id = $id`).get({ c: cardId, id }) as EventRow | null;
    return row ? eventOf(row) : undefined;
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

  /** Whether a workspace is registered, on any canvas. */
  hasWorkspace(path: string): boolean {
    return !!this.db.query('SELECT 1 FROM workspaces WHERE path = $path').get({ path });
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

  /** An exchange of no one's in the canvas's sheet, `reply` saying the card moved to another canvas. */
  addMoved(canvasId: string, moved: TalkMoved, reply: string): number {
    return (this.db.query("INSERT INTO talk (canvas_id, at, said, reply, moved) VALUES ($c, $at, '', $reply, $moved) RETURNING id").get({ c: canvasId, at: now(), reply, moved: JSON.stringify(moved) }) as { id: number }).id;
  }

  addTalk(canvasId: string, said: string, reply: string, cardId: string | null, lookUp?: { question: string; about: string | null }, images: string[] = [], replyTo?: TalkRef, after?: TalkAfter, askedIn?: string, answered?: number): number {
    return (
      this.db
        .query(
          'INSERT INTO talk (canvas_id, at, said, reply, card_id, question, about, images, reply_to, after_wait, asked_in, after_answer) VALUES ($c, $at, $said, $reply, $cardId, $question, $about, $images, $replyTo, $after, $askedIn, $answered) RETURNING id',
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
          replyTo: replyTo ? JSON.stringify({ talk: replyTo.talk, part: replyTo.part }) : null,
          after: after ? JSON.stringify(after) : null,
          askedIn: askedIn ?? null,
          answered: answered ?? null,
        }) as { id: number }
    ).id;
  }

  /**
   * The Koordinator's reply to words it has read, the question it looks up for them, and what a draft
   * for Obeya's makers would start from; with `waits`, one for the sheet waits there unread, as an
   * answer that was looked up does.
   */
  replyTalk(id: number, reply: string, lookUp?: { question: string; about: string | null }, wish?: Wish, waits = false) {
    this.db
      .query('UPDATE talk SET reply = $reply, question = $question, about = $about, wish = $wish, unread = $waits AND card_id IS NULL AND card IS NULL WHERE id = $id')
      .run({ id, reply, question: lookUp?.question ?? null, about: lookUp?.about ?? null, wish: wish ? JSON.stringify(wish) : null, waits: waits ? 1 : 0 });
  }

  /**
   * Words the Koordinator was reading when Obeya stopped: they get `reply`; returns them. Words the
   * usage limit holds wait on; words asked in a project's sheet the Koordinator never reads.
   */
  interruptTalk(canvasId: string, reply: string): Talk[] {
    const rows = this.db.query("SELECT * FROM talk WHERE canvas_id = $c AND reply = '' AND held IS NULL AND asked_in IS NULL ORDER BY id").all({ c: canvasId }) as TalkRow[];
    this.db.query("UPDATE talk SET reply = $reply WHERE canvas_id = $c AND reply = '' AND held IS NULL AND asked_in IS NULL").run({ c: canvasId, reply });
    return rows.map(toTalk);
  }

  /** Words the usage limit keeps the Koordinator from reading until `held.until`; `null` once it reads them. */
  holdTalk(id: number, held: HeldTalk | null) {
    this.db.query('UPDATE talk SET held = $held WHERE id = $id').run({ id, held: held ? JSON.stringify(held) : null });
  }

  /** The words the usage limit holds, oldest first. */
  heldTalk(canvasId: string): (Talk & { held: HeldTalk })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND held IS NOT NULL ORDER BY id').all({ c: canvasId }) as TalkRow[]).map((r) => ({ ...toTalk(r), held: JSON.parse(r.held!) as HeldTalk }));
  }

  /** The cards the Koordinator waits on after the exchange's reply; none once it no longer waits on any. */
  waitTalk(id: number, waits: TalkWaitRow[]) {
    this.db.query('UPDATE talk SET waits = $waits WHERE id = $id').run({ id, waits: waits.length ? JSON.stringify(waits) : null });
  }

  /** The exchanges whose reply said the Koordinator waits on a card, oldest first. */
  waitingTalk(canvasId: string): (Talk & { waiting: TalkWaitRow[] })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND waits IS NOT NULL ORDER BY id').all({ c: canvasId }) as TalkRow[]).map((r) => ({ ...toTalk(r), waiting: JSON.parse(r.waits!) as TalkWaitRow[] }));
  }

  /** The step the Koordinator takes once the exchange's looked-up answer is in; `null` once it has decided it. */
  thenTalk(id: number, then: string | null) {
    this.db.query('UPDATE talk SET then_step = $then WHERE id = $id').run({ id, then });
  }

  /** Looked-up answers that are in, oldest first, whose step the Koordinator has not decided yet. */
  answeredSteps(canvasId: string): Talk[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND then_step IS NOT NULL AND answer IS NOT NULL ORDER BY id').all({ c: canvasId }) as TalkRow[]).map(toTalk);
  }

  undoTalk(id: number) {
    this.db.query('UPDATE talk SET undone = 1 WHERE id = $id').run({ id });
  }

  /** A command that waits for "Rückgängig" until `due`; `body` is what runs then, as JSON. */
  holdCommand(canvasId: string, token: string, due: string, body: string) {
    this.db.query('INSERT OR REPLACE INTO commands (token, canvas_id, due, body) VALUES ($token, $c, $due, $body)').run({ token, c: canvasId, due, body });
  }

  dropCommand(token: string) {
    this.db.query('DELETE FROM commands WHERE token = $token').run({ token });
  }

  /** The commands still waiting, oldest first: after a restart, those the stopped server held. */
  heldCommands(canvasId: string): { token: string; due: string; body: string }[] {
    return this.db.query('SELECT token, due, body FROM commands WHERE canvas_id = $c ORDER BY due').all({ c: canvasId }) as { token: string; due: string; body: string }[];
  }

  /**
   * The answer to a looked-up question, with its files; one for the sheet (no card was open, and its
   * thread is on no Question card) waits there unread.
   */
  answerTalk(id: number, answer: string, by: 'koordinator' | 'project', files: AnswerFile[] = []) {
    this.db
      .query('UPDATE talk SET answer = $answer, answer_by = $by, files = $files, unread = card_id IS NULL AND card IS NULL WHERE id = $id')
      .run({ id, answer, by, files: files.length ? JSON.stringify(files) : null });
  }

  /** A follow-up continues the answer `follows`, in the thread `thread`. */
  followTalk(id: number, thread: number, follows: number) {
    this.db.query('UPDATE talk SET thread = $thread, follows = $follows WHERE id = $id').run({ id, thread, follows });
  }

  /** The session of the agent that looks the exchange's question up. */
  talkSession(id: number, session: string) {
    this.db.query('UPDATE talk SET session_id = $session WHERE id = $id').run({ id, session });
  }

  /** The exchanges of a thread, oldest first, with the session each was looked up in. */
  thread(canvasId: string, thread: number): (Talk & { about?: string; session?: string })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND (id = $t OR thread = $t) ORDER BY id').all({ c: canvasId, t: thread }) as TalkRow[]).map((r) => ({
      ...withContinues(this.db, r),
      ...(r.about ? { about: r.about } : {}),
      ...(r.session_id ? { session: r.session_id } : {}),
    }));
  }

  /** The thread moved onto a Question card: its exchanges, and every follow-up asked later, are answered there. */
  moveThread(canvasId: string, thread: number, card: string) {
    this.db.query('UPDATE talk SET card = $card, unread = 0 WHERE canvas_id = $c AND (id = $t OR thread = $t)').run({ c: canvasId, t: thread, card });
  }

  /** The owner saw the sheet's answers, or (`ids`) those of a project's sheet; whether any was unread. */
  readTalk(canvasId: string, ids?: number[]): boolean {
    if (ids)
      return this.db.query('UPDATE talk SET unread = 0 WHERE canvas_id = $c AND unread = 1 AND id IN (SELECT value FROM json_each($ids))').run({ c: canvasId, ids: JSON.stringify(ids) }).changes > 0;
    return this.db.query('UPDATE talk SET unread = 0 WHERE canvas_id = $c AND unread = 1').run({ c: canvasId }).changes > 0;
  }

  /**
   * The latest exchanges of the threads about any of `about` (a project and its workstreams), oldest
   * first: those its project agent answers.
   */
  talkAbout(canvasId: string, about: string[], limit = 100): Talk[] {
    return (
      this.db
        .query(
          `SELECT t.* FROM talk t JOIN talk r ON r.id = COALESCE(t.thread, t.id)
           WHERE t.canvas_id = $c AND r.about IN (SELECT value FROM json_each($about)) ORDER BY t.id DESC LIMIT $limit`,
        )
        .all({ c: canvasId, about: JSON.stringify(about), limit }) as TalkRow[]
    )
      .reverse()
      .map((r) => withContinues(this.db, r));
  }

  /** The latest exchanges, oldest first; with `withoutCard`, only those without an open card. */
  talk(canvasId: string, limit = 20, withoutCard = false): Talk[] {
    return (this.db.query(`SELECT * FROM talk WHERE canvas_id = $c${withoutCard ? ' AND card_id IS NULL' : ''} ORDER BY id DESC LIMIT $limit`).all({ c: canvasId, limit }) as TalkRow[])
      .reverse()
      .map((r) => withContinues(this.db, r));
  }

  /** A message of the canvas's sheet (an exchange with no card open), as a reply quotes it. */
  sheetQuote(canvasId: string, ref: TalkRef): TalkQuote | undefined {
    const sheet = this.db.query('SELECT 1 FROM talk WHERE id = $id AND canvas_id = $c AND card_id IS NULL').get({ id: ref.talk, c: canvasId });
    return sheet ? quotedTalk(this.db, ref) : undefined;
  }

  /** One exchange, with the card its question is about. */
  exchange(id: number): (Talk & { about?: string }) | null {
    const r = this.db.query('SELECT * FROM talk WHERE id = $id').get({ id }) as TalkRow | null;
    return r ? { ...withContinues(this.db, r), ...(r.about ? { about: r.about } : {}) } : null;
  }

  /** Questions being looked up, oldest first. */
  lookingUp(canvasId: string): number[] {
    return (this.db.query('SELECT id FROM talk WHERE canvas_id = $c AND question IS NOT NULL AND answer IS NULL ORDER BY id').all({ c: canvasId }) as { id: number }[]).map((r) => r.id);
  }

  /**
   * How the cards got where they are, after `since` (ISO time), oldest first: their milestones
   * (state changes, questions, answers, hand-overs, the owner's notes, errors) and the creation of
   * cards that come from no plan doc. Deleted cards are left out. After a mark, also what was written
   * since it, whatever its time; its time still counts, for an event that takes up the id of one the
   * owner deleted.
   */
  timeline(canvasId: string, since: string | Mark, limit: number): Moment[] {
    const m = typeof since === 'string' ? { at: since, event: Number.MAX_SAFE_INTEGER, card: Number.MAX_SAFE_INTEGER } : since;
    return (
      this.db
        .query(
          // within one millisecond, cards are created before anything happens to them, each in the order it was written
          `SELECT at, cardId, kind, author, text FROM (
             SELECT e.at, e.card_id AS cardId, e.kind, e.author, e.text, 1 AS phase, e.id AS seq FROM events e JOIN cards c ON c.id = e.card_id
             WHERE c.canvas_id = $c AND c.deleted_at IS NULL AND (e.at > $since OR e.id > $event) AND e.kind IN ('state', 'question', 'answer', 'review', 'hint', 'error')
             UNION ALL
             SELECT created_at, id, 'created', CASE WHEN from_id IS NULL THEN 'owner' ELSE 'worker' END, '', 0, rowid FROM cards
             WHERE canvas_id = $c AND deleted_at IS NULL AND plan_ref IS NULL AND (created_at > $since OR rowid > $card)
           ) ORDER BY at DESC, phase DESC, seq DESC LIMIT $limit`,
        )
        .all({ c: canvasId, since: m.at, event: m.event, card: m.card, limit }) as Moment[]
    ).reverse();
  }

  /** Where the cards' history stands now, for `timeline` to go on from. */
  mark(): Mark {
    const { event, card } = this.db
      .query('SELECT (SELECT COALESCE(MAX(id), 0) FROM events) AS event, (SELECT COALESCE(MAX(rowid), 0) FROM cards) AS card')
      .get() as { event: number; card: number };
    return { at: now(), event, card };
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
             WHERE t.canvas_id = $c AND t.undone = 0 AND t.after_wait IS NULL AND t.after_answer IS NULL AND t.moved IS NULL AND t.at > $since
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
    // a proposal its agent withdrew went without the owner
    return this.db
      .query(
        `SELECT deleted_at AS at, title, COALESCE(state, 'planned') AS state FROM cards WHERE canvas_id = $c AND plan_ref IS NULL AND deleted_at > $since
         AND NOT (state = 'proposal' AND json_extract(proposal, '$.superseded') IS NOT NULL) ORDER BY deleted_at`,
      )
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

  addSettingProposal(canvasId: string, p: Omit<SettingProposal, 'id' | 'cards'> & { cards: string[] }): number {
    return (
      this.db
        .query(
          `INSERT INTO setting_proposals (canvas_id, repo, field, value, basis, cards, created_at)
           VALUES ($c, $repo, $field, $value, $basis, $cards, $now) RETURNING id`,
        )
        .get({ c: canvasId, repo: p.repo, field: p.field, value: JSON.stringify(p.value), basis: p.basis, cards: JSON.stringify(p.cards), now: now() }) as { id: number }
    ).id;
  }

  /** The settings the Arbeitsrückschau proposed, oldest first, with what became of them: those of a repository, or all; the cards they rest on with their titles. */
  settingProposals(canvasId: string, repo?: string): (SettingProposal & { state: SettingProposalState })[] {
    const rows = this.db
      .query(`SELECT * FROM setting_proposals WHERE canvas_id = $c AND ($repo IS NULL OR repo = $repo) ORDER BY id`)
      .all({ c: canvasId, repo: repo ?? null }) as { id: number; repo: string; field: ProposedSetting; value: string; basis: string; cards: string; state: SettingProposalState }[];
    const title = this.db.query(`SELECT COALESCE(title, '') AS title FROM cards WHERE id = $id`);
    return rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      field: r.field,
      value: JSON.parse(r.value) as string | string[],
      basis: r.basis,
      cards: (JSON.parse(r.cards) as string[]).map((id) => ({ id, title: (title.get({ id }) as { title: string } | null)?.title ?? '' })),
      state: r.state,
    }));
  }

  /** Decides a waiting setting proposal, with the value the owner took; whether one waited. */
  decideSettingProposal(canvasId: string, id: number, state: Exclude<SettingProposalState, 'proposed'>, value?: string | string[]): boolean {
    return (
      this.db
        .query(`UPDATE setting_proposals SET state = $state, decided_at = $now, value = COALESCE($value, value) WHERE canvas_id = $c AND id = $id AND state = 'proposed'`)
        .run({ c: canvasId, id, state, now: now(), value: value === undefined ? null : JSON.stringify(value) }).changes > 0
    );
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

  // ---------------------------------------------------------------- trusted commands

  /** The commands of the repository at `path` as the owner last confirmed them; null where they confirmed none. */
  trustedCommands(path: string): RepoCommands | null {
    const row = this.db.query('SELECT commands FROM trusted_commands WHERE repo = $repo').get({ repo: path }) as { commands: string } | null;
    return row ? (JSON.parse(row.commands) as RepoCommands) : null;
  }

  trustCommands(path: string, commands: RepoCommands) {
    this.db
      .query('INSERT INTO trusted_commands (repo, commands, at) VALUES ($repo, $commands, $at) ON CONFLICT(repo) DO UPDATE SET commands = $commands, at = $at')
      .run({ repo: path, commands: JSON.stringify(commands), at: now() });
  }

  // ---------------------------------------------------------------- folders without git

  /** What the card changed in the folder without git it works in, as `folder.ts` keeps it (JSON); null where it has no record. */
  folderCard(cardId: string): string | null {
    const row = this.db.query('SELECT state FROM folder_cards WHERE card_id = $c').get({ c: cardId }) as { state: string } | null;
    return row?.state ?? null;
  }

  /** The cards with a record in the folder at `folder`. */
  folderCards(folder: string): { card_id: string; state: string }[] {
    return this.db.query('SELECT card_id, state FROM folder_cards WHERE folder = $f').all({ f: folder }) as { card_id: string; state: string }[];
  }

  /** Keeps the card's record in the folder; null removes it. */
  setFolderCard(cardId: string, folder: string, state: string | null) {
    if (state === null) this.db.query('DELETE FROM folder_cards WHERE card_id = $c').run({ c: cardId });
    else
      this.db
        .query('INSERT INTO folder_cards (card_id, folder, state) VALUES ($c, $f, $s) ON CONFLICT(card_id) DO UPDATE SET folder = $f, state = $s')
        .run({ c: cardId, f: folder, s: state });
  }

  // ---------------------------------------------------------------- devices

  devices(): DeviceView[] {
    const rows = this.db.query('SELECT id, name, paired_at AS pairedAt, last_seen AS lastSeen, push IS NOT NULL AS push FROM devices ORDER BY paired_at').all() as (Omit<DeviceView, 'push'> & { push: number })[];
    return rows.map(({ push, ...d }) => (push ? { ...d, push: true } : d));
  }

  /** The devices that get pushes, each with its subscription (JSON). */
  pushes(): { id: string; name: string; push: string; lastSeen: string }[] {
    return this.db.query('SELECT id, name, push, last_seen AS lastSeen FROM devices WHERE push IS NOT NULL').all() as { id: string; name: string; push: string; lastSeen: string }[];
  }

  /** A device's push subscription (JSON), or none any more. */
  setPush(id: string, push: string | null) {
    this.db.query('UPDATE devices SET push = $push WHERE id = $id').run({ id, push });
  }

  deviceByToken(hash: string): DeviceView | null {
    return this.db.query('SELECT id, name, paired_at AS pairedAt, last_seen AS lastSeen FROM devices WHERE token_hash = $hash').get({ hash }) as DeviceView | null;
  }

  addDevice(d: DeviceView & { tokenHash: string }) {
    this.db.query('INSERT INTO devices (id, token_hash, name, paired_at, last_seen) VALUES ($id, $hash, $name, $paired, $seen)').run({ id: d.id, hash: d.tokenHash, name: d.name, paired: d.pairedAt, seen: d.lastSeen });
  }

  deviceSeen(id: string, at: string) {
    this.db.query('UPDATE devices SET last_seen = $at WHERE id = $id').run({ id, at });
  }

  removeDevice(id: string): boolean {
    return this.db.query('DELETE FROM devices WHERE id = $id').run({ id }).changes > 0;
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
  unread: number;
  session_id: string | null;
  thread: number | null;
  follows: number | null;
  files: string | null;
  card: string | null;
  reply_to: string | null;
  wish: string | null;
  held: string | null;
  waits: string | null;
  after_wait: string | null;
  asked_in: string | null;
  moved: string | null;
  then_step: string | null;
  after_answer: number | null;
}

const toTalk = (r: TalkRow): Talk => ({
  id: r.id,
  at: r.at,
  said: r.said,
  // empty while the Koordinator reads the words
  ...(r.reply ? { reply: r.reply } : {}),
  ...(r.card_id ? { cardId: r.card_id } : {}),
  ...(r.undone ? { undone: true } : {}),
  ...(r.question ? { question: r.question } : {}),
  ...(r.answer !== null ? { answer: r.answer } : {}),
  ...(r.answer_by ? { answerBy: r.answer_by } : {}),
  ...(r.unread ? { unread: true } : {}),
  ...(r.images ? { images: JSON.parse(r.images) as string[] } : {}),
  // a looked-up question is a thread of its own until it follows up on one
  ...(r.question ? { thread: r.thread ?? r.id } : {}),
  ...(r.follows ? { follows: r.follows } : {}),
  ...(r.files ? { files: JSON.parse(r.files) as AnswerFile[] } : {}),
  ...(r.card ? { movedTo: r.card } : {}),
  ...(r.wish ? { wish: JSON.parse(r.wish) as Wish } : {}),
  ...(r.held ? { heldUntil: (JSON.parse(r.held) as HeldTalk).until } : {}),
  ...(r.waits ? { waits: (JSON.parse(r.waits) as TalkWaitRow[]).map(({ card, title, state }) => ({ card, title, state })) } : {}),
  ...(r.after_wait ? { after: JSON.parse(r.after_wait) as TalkAfter } : {}),
  ...(r.asked_in ? { askedIn: r.asked_in } : {}),
  ...(r.moved ? { moved: JSON.parse(r.moved) as TalkMoved } : {}),
  ...(r.then_step ? { then: r.then_step } : {}),
  ...(r.after_answer ? { answered: r.after_answer } : {}),
});

/**
 * An exchange with the question of the answer it continues, when it follows up on one, and the
 * message of the sheet it replies to, when it does.
 */
function withContinues(db: Database, r: TalkRow): Talk {
  const followed = r.follows ? (db.query('SELECT question FROM talk WHERE id = $id').get({ id: r.follows }) as { question: string | null } | null) : null;
  const replyTo = r.reply_to ? quotedTalk(db, JSON.parse(r.reply_to) as TalkRef) : undefined;
  return { ...toTalk(r), ...(followed?.question ? { continues: followed.question } : {}), ...(replyTo ? { replyTo } : {}) };
}

/** A message of the sheet as a reply quotes it; none where the exchange or its part is gone. */
function quotedTalk(db: Database, ref: TalkRef): TalkQuote | undefined {
  const r = db.query('SELECT said, reply, answer, answer_by FROM talk WHERE id = $id').get({ id: ref.talk }) as Pick<TalkRow, 'said' | 'reply' | 'answer' | 'answer_by'> | null;
  const text = r?.[ref.part];
  if (!r || !text) return;
  return { talk: ref.talk, part: ref.part, by: ref.part === 'said' ? 'owner' : ref.part === 'answer' ? (r.answer_by ?? 'koordinator') : 'koordinator', text };
}
