import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardEvent, ChangeSize, DeviceView, CardKind, CardState, Need, Preference, PreferenceState, Proposal, ProposedSetting, Queue, SettingProposal, SettingProposalState, Snooze } from '../core/types';
import type { CardAgent } from '../core/agents';
import type { RepoCommands } from '../core/config';
import type { CardFile } from '../core/files';
import type { PlanDoc } from '../core/plan-doc';
import type { Detail, HeldComment, Json, LandedState, PageHeard, PausedState, PrState, Scope, Shipped, StoredContribution, StoredDemo, StoredDeps, StoredIdea, StoredNewRepo, StoredPrototype, StoredShare, StoredThread, Unheard } from './row';

/** Where a page of the archive ends (`Store.archivePage`): the last card's archiving, creation and id. */
export interface ArchiveCursor {
  at: string;
  created: string;
  id: string;
}

/** A card as stored. A JSON column's type names what it holds (`Json` in row.ts), so `fromJson` reads it typed. */
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
  /**
   * When something last happened at the card: a change the owner sees (`SEEN`) or a line in its log
   * other than a worker's tool activity. Moving it, grouping it, folding a project or bookkeeping do
   * not count. The migration that added it filled it from `updated_at`.
   */
  changed_at: string;
  deleted_at: string | null;
  /** Agent session of the card's worker, or of a project's project agent. */
  session_id: string | null;
  /** The model that session runs on, as its harness reported it at the start (`claude-opus-5-5`); its harness is the session's (`sessionHarness`). */
  model: string | null;
  /** The size of its change as the server last read it, for the page to lay out before it reads the change. */
  change_size: Json<ChangeSize> | null;
  /** The effort that session runs with, as Obeya started it (`high`). */
  effort: string | null;
  /** What its agents' sessions cost so far in US dollars, as their harnesses estimated it (`Store.spend`); null before any reported a cost. */
  spent: number | null;
  /** The harness, model and effort the owner chose for the card's agent, over its group's. */
  agent: Json<CardAgent> | null;
  /** Leased clone and branch while a worker has the card. */
  workspace: string | null;
  branch: string | null;
  /** The worker's latest `report`. */
  status_line: string | null;
  /** The open question, or the handover's summary. */
  detail: Json<Detail> | null;
  /** A proposal's source card. */
  from_id: string | null;
  /** The Coordinator's estimate of the files the card changes. */
  scope: Json<Scope> | null;
  /** Set while the Coordinator decides (`{ checking: true }`) or the card waits (`{ behind, reason }`), with `since`. */
  queue: Json<Queue> | null;
  /** The card's pull request once approval opened the PR phase; on a review card, the one it reviews from the start. */
  pr: Json<PrState> | null;
  /** Review cards only: the contributor's pull request the card reviews. */
  contribution: Json<StoredContribution> | null;
  /** The owner's card's repository on a canvas with several; null is the home repository. */
  repo: string | null;
  /** The card's latest demo (no `kind` is a video). */
  demo: Json<StoredDemo> | null;
  /** The demos of earlier handovers a later one replaced, the oldest first, each as `demo` was; append only. */
  demos: Json<StoredDemo[]> | null;
  /** When the owner took the finished card off the canvas into the archive. */
  archived_at: string | null;
  /** An idea's status and brief. */
  idea: Json<StoredIdea> | null;
  /** A prototype's idea. */
  prototype_of: string | null;
  /** When the owner approved work that could not land yet; its next handover lands without asking again. */
  approved_at: string | null;
  /**
   * While the card's work is on main and its worker finishes what remains (its workspace and
   * session are kept until then).
   */
  landed: Json<LandedState> | null;
  /** Ids of the screenshots the owner attached to the card's task. */
  images: Json<string[]> | null;
  /** Projects only: the plan doc as last read, kept for the archive once the doc is gone. */
  plan: Json<PlanDoc> | null;
  /** A card the work retrospective proposed: what it rests on. */
  retro: string | null;
  /** While a worker's proposal waits: an idea or a task, why, the questions to decide. */
  proposal: Json<Proposal> | null;
  /** The plan docs (plan references) the landed work of a card that was an idea added. */
  plan_docs: Json<string[]> | null;
  /** Prototypes only: how it ended (`end`, once archived) and its worker's proposal to build the idea on it (`proposal`). */
  prototype: Json<StoredPrototype> | null;
  /** A card that was an idea and is built on the branch of one of its prototypes: that prototype. */
  built_on: string | null;
  /** The demo's page for colleagues (share.ts); its slug stays once it was shared. */
  share: Json<StoredShare> | null;
  /** The group the card belongs to; a project's covers its workstreams, whose own stays null. */
  group_id: string | null;
  /**
   * Once the card's work landed: the commit it landed with and its
   * pull request. Kept after its worker is done: a workstream whose plan doc keeps it open is
   * planned again once the read tree holds that commit.
   */
  shipped: Json<Shipped> | null;
  /** When Obeya stopped the app in the card's workspace while the card waited (Parking); gone once its worker heard so. */
  parked: string | null;
  /** The owner's comments on places in the demo video Obeya holds back while they watch (event ids, `Item.held`). */
  held: Json<HeldComment[]> | null;
  /** 1 once the owner decided the card (an idea or a task of theirs) becomes a project: its worker writes the plan doc, and the project takes its place. */
  becomes_project: number;
  /** A Question card (and an idea that was one): the thread of looked-up answers it holds. */
  thread: Json<StoredThread> | null;
  /** While the owner has paused the card's agent: for a worker what came for it meanwhile, `{}` for an idea's or a Question card's agent, which keep what waits for them with the idea or the thread. */
  paused: Json<PausedState> | null;
  /** Since when (ISO) the owner has asked the card's agent to pause once it has brought its work to a safe point; null once it paused, went on or stopped. */
  pausing: string | null;
  /**
   * 1 when Obeya's workers stopped (a restart, a stop) while the card's worker was in a turn or had
   * paused for the restart: the next start resumes it even where its card waits (its pull request
   * open); null once it did.
   */
  resumes: number | null;
  /**
   * 1 where the owner chose that the card's work goes to the original repository of a fork as a
   * pull request too (`RepoRef.upstream`), not only onto the main branch; null otherwise.
   */
  upstream: number | null;
  /** The owner's words Obeya holds for the card's worker until it takes them in, at its next tool step or turn. */
  unheard: Json<Unheard[]> | null;
  /** The address its worker opens the app in the card's workspace at, while it runs (`app_running`); gone once Obeya stops the app or the workspace goes. */
  app: string | null;
  /** Since when the card waits for the owner (`needsYou`), kept while it does; null while it does not. */
  waiting_since: string | null;
  /** While the card is snoozed until a point in time: Obeya wakes it then. */
  snoozed: Json<Snooze> | null;
  /** The files its worker named as the result at its latest handover that named any. */
  files: Json<CardFile[]> | null;
  /** Projects only: which workstream builds on which, as the Coordinator read it from the plan doc. */
  deps: Json<StoredDeps> | null;
  /** 1 while the owner has a project folded to its head: its workstreams are not shown on the canvas. */
  collapsed: number;
  /**
   * The clone (`ssh://<host>/…` on a host) that holds the newest state of the card's branch since
   * the owner took its workspace from it, its uncommitted work in a commit of Obeya's on top; gone
   * once the card works in a clone again, which takes the branch from there.
   */
  kept_in: string | null;
  /**
   * A repository to create for the card before work begins; once Obeya made it, with `made`, so its
   * worker hears that the repository is new.
   */
  new_repo: Json<StoredNewRepo> | null;
  /** What the card's worker last heard of its demo's page, so it hears of a change with its next step. */
  page_heard: Json<PageHeard> | null;
  /** The card's code in addresses (`/c/<canvas>/card/<code>`): the start of its id's hex digits, unique among all cards (`SHORT`). */
  short: string;
  /** The card's number (`K42`): counting across all canvases, given once and never again. */
  number: number;
}

export interface GroupRow {
  id: string;
  canvas_id: string;
  name: string;
  hue: number;
  created_at: string;
}

export interface DecisionRow {
  id: number;
  canvas_id: string;
  project_id: string | null;
  card_id: string;
  question: string;
  answer: string;
  by: 'owner' | 'project' | 'coordinator';
  at: string;
}

/** The schema Obeya was released with; exported for the migration tests, which build older databases from it. */
export const SCHEMA = `
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
  -- what the owner said to the Coordinator and what it answered: its memory across sessions
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
  -- the work retrospective: friction noted on a card's run, per repository
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
  -- a command the owner has the confirmation of, while it waits for "Undo": it outlives a restart
  CREATE TABLE commands (
    token TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    due TEXT NOT NULL,
    body TEXT NOT NULL
  );
  -- a value for a repository's setting the work retrospective proposes, and where the owner took it
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

/** How many hex digits of its id a card's code has at least. */
export const SHORT = 6;

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
  // since when a card waits for the owner, for the phone view's "Needs you"
  'ALTER TABLE cards ADD COLUMN waiting_since TEXT;',
  // a repository's commands as the owner last confirmed them, by its path (JSON `RepoCommands`)
  `CREATE TABLE trusted_commands (
    repo TEXT PRIMARY KEY,
    commands TEXT NOT NULL,
    at TEXT NOT NULL
  );`,
  // a paired device's push subscription (JSON `Subscription`), where it turned notifications on
  'ALTER TABLE devices ADD COLUMN push TEXT;',
  // words the usage limit kept the Coordinator from reading, until it lifts (JSON `HeldTalk`)
  'ALTER TABLE talk ADD COLUMN held TEXT;',
  // a card set aside until a point in time, by its worker or the owner (JSON `Snooze`)
  'ALTER TABLE cards ADD COLUMN snoozed TEXT;',
  // cards the Coordinator waits on to take a step then (JSON `TalkWaitRow[]`), and the exchange it took that step up in (JSON `TalkAfter`)
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
  // a repository to create for a card before work begins, and that Obeya made it (JSON `StoredNewRepo` in row.ts);
  // an exchange of no one's in the sheet that says a card moved to another canvas (JSON `TalkMoved`)
  'ALTER TABLE cards ADD COLUMN new_repo TEXT; ALTER TABLE talk ADD COLUMN moved TEXT;',
  // what a card's worker last heard of its demo's page (JSON `PageHeard` in row.ts)
  'ALTER TABLE cards ADD COLUMN page_heard TEXT;',
  // Obeya's reply on a card to what its agent passed on from the owner's words (`to_obeya`)
  'ALTER TABLE events ADD COLUMN forwarded INTEGER;',
  // since when the owner asked the card's agent to pause at a safe point, until it has (ISO)
  'ALTER TABLE cards ADD COLUMN pausing TEXT;',
  // a question looked up for an action that needs its answer: the step the Coordinator takes then, and
  // the exchange of no one's it took that step up in (the id of the exchange whose answer came in)
  'ALTER TABLE talk ADD COLUMN then_step TEXT; ALTER TABLE talk ADD COLUMN after_answer INTEGER;',
  // an error of a session that signed in with a token rather than this machine's account
  'ALTER TABLE events ADD COLUMN token INTEGER;',
  // the cards each change of a canvas reads, without going through its archive
  `CREATE INDEX cards_open ON cards (canvas_id) WHERE deleted_at IS NULL AND archived_at IS NULL;
   CREATE INDEX cards_plan_docs ON cards (canvas_id) WHERE deleted_at IS NULL AND plan_docs IS NOT NULL;
   CREATE INDEX cards_prototypes ON cards (canvas_id, created_at) WHERE deleted_at IS NULL AND prototype_of IS NOT NULL;
   CREATE INDEX cards_waiting ON cards (canvas_id) WHERE waiting_since IS NOT NULL;
   CREATE INDEX cards_shared ON cards (canvas_id) WHERE deleted_at IS NULL AND share IS NOT NULL;`,
  // a card's code in addresses: the first `SHORT` hex digits of its id, one more for each card that shares them
  `ALTER TABLE cards ADD COLUMN short TEXT;
   UPDATE cards SET short = substr(replace(id, '-', ''), 1, ${SHORT});
   ${Array.from({ length: 32 - SHORT }, (_, k) => `UPDATE cards SET short = substr(replace(id, '-', ''), 1, ${SHORT + 1 + k}) WHERE short IN (SELECT short FROM cards GROUP BY short HAVING count(*) > 1);`).join('\n   ')}
   CREATE UNIQUE INDEX cards_short ON cards (short);`,
  // where the owner was on the canvas when they asked for a step that needed looking up first (JSON `Place`): its new cards go there
  'ALTER TABLE talk ADD COLUMN then_place TEXT;',
  // a card's number (`K42`), across all canvases, in the order the cards were made; and since when
  // each canvas has them, as its Coordinator's memory of earlier sessions names cards by tags of its own
  `ALTER TABLE cards ADD COLUMN number INTEGER;
   UPDATE cards SET number = (SELECT n FROM (SELECT id, row_number() OVER (ORDER BY created_at, rowid) AS n FROM cards) o WHERE o.id = cards.id);
   CREATE UNIQUE INDEX cards_number ON cards (number);
   INSERT OR IGNORE INTO settings (canvas_id, key, value) SELECT id, 'card_numbers_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM canvases;`,
  // the archive, read a page at a time, and its revision, read with every change of the canvas
  'CREATE INDEX cards_archived ON cards (canvas_id, archived_at) WHERE archived_at IS NOT NULL;',
  // where a paired device's app on the home screen opens Obeya, as it last connected
  'ALTER TABLE devices ADD COLUMN app TEXT;',
  // the model a card's agent session runs on, as its harness reported it
  'ALTER TABLE cards ADD COLUMN model TEXT;',
  // the size of a card's change as last read (JSON `ChangeSize`): the page lays out its change list with it before reading the change
  'ALTER TABLE cards ADD COLUMN change_size TEXT;',
  // when something the owner sees last happened at a card, which the search lists the canvas by;
  // `updated_at` stays the time of any write
  'ALTER TABLE cards ADD COLUMN changed_at TEXT; UPDATE cards SET changed_at = updated_at;',
  // the harness and model the owner chose for a card's agent, over its group's
  'ALTER TABLE cards ADD COLUMN agent TEXT;',
  // the effort a card's agent session runs with
  'ALTER TABLE cards ADD COLUMN effort TEXT;',
  // a mark per canvas that moves whenever a shared card changes in what its notice of outdated pages
  // is made of (`Store.shareRev`): the canvas makes that notice anew only then, not with every change
  `CREATE TABLE share_revs (
    canvas_id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL
  );
  CREATE TRIGGER share_rev AFTER UPDATE OF share, title, repo, plan_ref, demo, demos, deleted_at, canvas_id ON cards
    WHEN OLD.share IS NOT NULL OR NEW.share IS NOT NULL
  BEGIN
    INSERT INTO share_revs (canvas_id, rev) VALUES (OLD.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
    INSERT INTO share_revs (canvas_id, rev) VALUES (NEW.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
  END;
  CREATE TRIGGER share_rev_gone AFTER DELETE ON cards WHEN OLD.share IS NOT NULL
  BEGIN
    INSERT INTO share_revs (canvas_id, rev) VALUES (OLD.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
  END;`,
  // a mark per canvas that moves whenever a row the archive's items are made of is written, comes or
  // goes (`Store.archiveRev`): an archived card, a workstream of an archived project, a prototype of an
  // archived idea; read with every change of the canvas, which no longer goes over the archive for it
  `CREATE TABLE archive_revs (
    canvas_id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL
  );
  CREATE TRIGGER archive_rev AFTER UPDATE ON cards
    WHEN OLD.archived_at IS NOT NULL OR NEW.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (OLD.parent_id, OLD.prototype_of, NEW.parent_id, NEW.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_revs (canvas_id, rev) VALUES (OLD.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
    INSERT INTO archive_revs (canvas_id, rev) VALUES (NEW.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
  END;
  CREATE TRIGGER archive_rev_new AFTER INSERT ON cards
    WHEN NEW.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (NEW.parent_id, NEW.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_revs (canvas_id, rev) VALUES (NEW.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
  END;
  CREATE TRIGGER archive_rev_gone AFTER DELETE ON cards
    WHEN OLD.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (OLD.parent_id, OLD.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_revs (canvas_id, rev) VALUES (OLD.canvas_id, 1) ON CONFLICT(canvas_id) DO UPDATE SET rev = rev + 1;
  END;`,
  // the Coordinator's reply only answers the owner's words (no actions, no question looked up): "Show as walkthrough" can tell it
  'ALTER TABLE talk ADD COLUMN reply_only INTEGER;',
  // what each agent session on a canvas cost as its harness estimated it (`Store.spend`), and each
  // card's sum of its sessions', which its row carries so that the card shows it with its other fields
  `CREATE TABLE spend (
    canvas_id TEXT NOT NULL REFERENCES canvases(id),
    card_id TEXT REFERENCES cards(id),
    session TEXT NOT NULL,
    usd REAL NOT NULL,
    settled REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (canvas_id, session)
  );
  ALTER TABLE cards ADD COLUMN spent REAL;`,
  // what the Coordinator reads with each command and each of the owner's inputs, found by time rather
  // than by going through every event of the canvas: the milestones of the cards' logs (`timeline`),
  // what the owner said (`utterances`), the cards made, the exchanges of the sheet; the exchanges
  // whose reply waits on a card, and the workstreams of the projects shown, read on every change of
  // the canvas
  `CREATE INDEX events_milestones ON events (at) WHERE kind IN ('state', 'question', 'answer', 'review', 'hint', 'error');
   CREATE INDEX events_owner ON events (at) WHERE author = 'owner' AND kind IN ('hint', 'answer', 'talk');
   CREATE INDEX cards_created ON cards (canvas_id, created_at) WHERE deleted_at IS NULL AND plan_ref IS NULL;
   CREATE INDEX talk_canvas ON talk (canvas_id);
   CREATE INDEX talk_at ON talk (canvas_id, at);
   CREATE INDEX talk_waiting ON talk (canvas_id) WHERE waits IS NOT NULL;
   CREATE INDEX cards_parent ON cards (parent_id) WHERE parent_id IS NOT NULL;`,
  // which shared cards were written, come or went (`Store.sharedLog`), so a canvas keeps its
  // shared cards up to date by reading those again rather than all of them with every change
  `CREATE TABLE shared_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    card_id TEXT NOT NULL
  );
  CREATE TRIGGER shared_change AFTER UPDATE ON cards WHEN OLD.share IS NOT NULL OR NEW.share IS NOT NULL
  BEGIN
    INSERT INTO shared_changes (canvas_id, card_id) VALUES (NEW.canvas_id, NEW.id);
    INSERT INTO shared_changes (canvas_id, card_id) SELECT OLD.canvas_id, OLD.id WHERE OLD.canvas_id IS NOT NEW.canvas_id;
  END;
  CREATE TRIGGER shared_change_new AFTER INSERT ON cards WHEN NEW.share IS NOT NULL
  BEGIN
    INSERT INTO shared_changes (canvas_id, card_id) VALUES (NEW.canvas_id, NEW.id);
  END;
  CREATE TRIGGER shared_change_gone AFTER DELETE ON cards WHEN OLD.share IS NOT NULL
  BEGIN
    INSERT INTO shared_changes (canvas_id, card_id) VALUES (OLD.canvas_id, OLD.id);
  END;`,
  // what the Coordinator said, looked up and decided, stored as by `koordinator` (its German name) before it was renamed
  `UPDATE events SET author = 'coordinator' WHERE author = 'koordinator';
   UPDATE talk SET answer_by = 'coordinator' WHERE answer_by = 'koordinator';
   UPDATE decisions SET by = 'coordinator' WHERE by = 'koordinator';`,
  // the archive in its order, read a page at a time (`Store.archivePage`); and which of its rows were
  // written, came or went (`Store.archiveLog`), as the mark of the archive moves with them, so a
  // canvas keeps its search through the archive up to date by reading those again
  `CREATE INDEX cards_archive_order ON cards (canvas_id, archived_at, created_at, id) WHERE deleted_at IS NULL AND archived_at IS NOT NULL;
  CREATE TABLE archive_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    card_id TEXT NOT NULL
  );
  CREATE TRIGGER archive_change AFTER UPDATE ON cards
    WHEN OLD.archived_at IS NOT NULL OR NEW.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (OLD.parent_id, OLD.prototype_of, NEW.parent_id, NEW.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_changes (canvas_id, card_id) SELECT NEW.canvas_id, value FROM json_each(json_array(NEW.id, NEW.parent_id, NEW.prototype_of)) WHERE value IS NOT NULL;
    INSERT INTO archive_changes (canvas_id, card_id) SELECT OLD.canvas_id, value FROM json_each(json_array(OLD.parent_id, OLD.prototype_of)) WHERE value IS NOT NULL;
    INSERT INTO archive_changes (canvas_id, card_id) SELECT OLD.canvas_id, OLD.id WHERE OLD.canvas_id IS NOT NEW.canvas_id;
  END;
  CREATE TRIGGER archive_change_new AFTER INSERT ON cards
    WHEN NEW.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (NEW.parent_id, NEW.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_changes (canvas_id, card_id) SELECT NEW.canvas_id, value FROM json_each(json_array(NEW.id, NEW.parent_id, NEW.prototype_of)) WHERE value IS NOT NULL;
  END;
  CREATE TRIGGER archive_change_gone AFTER DELETE ON cards
    WHEN OLD.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM cards a WHERE a.id IN (OLD.parent_id, OLD.prototype_of) AND a.archived_at IS NOT NULL)
  BEGIN
    INSERT INTO archive_changes (canvas_id, card_id) SELECT OLD.canvas_id, value FROM json_each(json_array(OLD.id, OLD.parent_id, OLD.prototype_of)) WHERE value IS NOT NULL;
  END;`,
  // a card whose worker was at work when Obeya's workers stopped: the next start resumes it (`CardRow.resumes`)
  'ALTER TABLE cards ADD COLUMN resumes INTEGER;',
  // a question whose look-up the owner's later words went into: the exchange whose answer answers it too
  'ALTER TABLE talk ADD COLUMN joined INTEGER;',
  // a fork's card whose work goes to the original repository as a pull request too (`CardRow.upstream`)
  'ALTER TABLE cards ADD COLUMN upstream INTEGER;',
];

/**
 * How each optional field of a log line is stored, in the column of its name in snake case: empty
 * (absent, false, an empty list) is null, and null is read back as absent.
 */
const EVENT_FIELDS = {
  code: 'text',
  images: 'list',
  mocks: 'list',
  replyTo: 'int',
  spot: 'json',
  answer: 'json',
  picks: 'list',
  unread: 'flag',
  readAfter: 'int',
  wish: 'json',
  reply: 'flag',
  forwarded: 'flag',
  token: 'flag',
} as const satisfies Partial<Record<keyof CardEvent, 'text' | 'int' | 'flag' | 'json' | 'list'>>;
type EventField = keyof typeof EVENT_FIELDS;
const FIELDS = Object.entries(EVENT_FIELDS) as [EventField, (typeof EVENT_FIELDS)[EventField]][];
const columnOf = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const EVENT_COLUMNS = ['id', 'card_id AS cardId', 'at', 'kind', 'author', 'text', ...FIELDS.map(([f]) => (columnOf(f) === f ? f : `${columnOf(f)} AS ${f}`))].join(', ');
const INSERT_EVENT = `INSERT INTO events (card_id, at, kind, author, text, ${FIELDS.map(([f]) => columnOf(f)).join(', ')}) VALUES ($cardId, $at, $kind, $author, $text, ${FIELDS.map(([f]) => `$${f}`).join(', ')}) RETURNING id`;
type EventRow = Omit<CardEvent, EventField> & Record<EventField, string | number | null>;

/** A line to write into a card's log, said now or (`at`) earlier; an optional field that is empty or false is not stored. */
export type NewEvent = Pick<CardEvent, 'cardId' | 'kind' | 'author' | 'text'> & Partial<Pick<CardEvent, Exclude<EventField, 'unread' | 'readAfter'> | 'at'>> & { unread?: boolean };

const stored = (how: (typeof EVENT_FIELDS)[EventField], v: unknown): string | number | null =>
  how === 'flag' ? (v ? 1 : null) : how === 'list' ? ((v as unknown[] | undefined)?.length ? JSON.stringify(v) : null) : how === 'json' ? (v ? JSON.stringify(v) : null) : ((v as string | number | undefined) || null);

function eventOf(r: EventRow): CardEvent {
  const e: Record<string, unknown> = { id: r.id, cardId: r.cardId, at: r.at, kind: r.kind, author: r.author, text: r.text };
  for (const [f, how] of FIELDS) {
    const v = r[f];
    if (v) e[f] = how === 'flag' ? true : how === 'json' || how === 'list' ? JSON.parse(v as string) : v;
  }
  return e as unknown as CardEvent;
}

export type NewRow = Pick<CardRow, 'canvas_id' | 'kind' | 'x' | 'y'> &
  Partial<Pick<CardRow, 'state' | 'title' | 'body' | 'parent_id' | 'plan_ref' | 'from_id' | 'repo' | 'idea' | 'prototype_of' | 'prototype' | 'images' | 'retro' | 'proposal' | 'group_id'>>;

/**
 * The columns whose change the owner sees happen at the card (`changed_at`): its state, its words,
 * what its agent reports and hands over. Its place, its group, its folding and the bookkeeping behind
 * it (session, workspace, queue, what was read or heard) do not count.
 */
const SEEN = new Set<string>(['state', 'need', 'title', 'body', 'status_line', 'detail', 'demo', 'files', 'idea', 'proposal', 'prototype', 'images', 'pr', 'contribution', 'thread', 'shipped', 'landed', 'archived_at', 'paused', 'snoozed', 'share', 'app', 'plan']);

/** What `Store.update` may change on a card: all but what is set once at its creation, and its times. */
export type RowUpdate = Partial<Omit<CardRow, 'id' | 'canvas_id' | 'parent_id' | 'plan_ref' | 'prototype_of' | 'retro' | 'created_at' | 'updated_at' | 'changed_at'>>;

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

  /**
   * The log of shared cards' writes (`shared_changes`): which of a canvas's cards were written, came
   * or went while they were shared or about to be.
   */
  readonly sharedLog = this.changeLog('shared_changes');

  /**
   * The log of the archive's writes (`archive_changes`): which of a canvas's cards may have changed
   * archive entries, an archived card written, come or gone, and the archived project or idea of a
   * workstream or prototype written.
   */
  readonly archiveLog = this.changeLog('archive_changes');

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
    // a canvas reads its shared cards and its archive afresh when it opens, and only then follows the
    // logs of their writes: what they hold now no canvas reads, and one never opened again would never drop it
    this.db.run('DELETE FROM shared_changes');
    this.db.run('DELETE FROM archive_changes');
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

  /** The canvas's cards, archived ones too, that were ever shared or are about to be; with `ids`, those among them. */
  shared(canvasId: string, ids?: string[]): CardRow[] {
    if (ids)
      return this.db
        // by their ids, not by going through the canvas's shared cards
        .query('SELECT * FROM cards WHERE id IN (SELECT value FROM json_each($ids)) AND +canvas_id = $c AND deleted_at IS NULL AND share IS NOT NULL')
        .all({ c: canvasId, ids: JSON.stringify(ids) }) as CardRow[];
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND share IS NOT NULL').all({ c: canvasId }) as CardRow[];
  }

  /** Which of these cards are on the canvas: neither deleted nor archived. */
  openIds(canvasId: string, ids: string[]): Set<string> {
    const rows = this.db.query('SELECT id FROM cards WHERE id IN (SELECT value FROM json_each($ids)) AND canvas_id = $c AND deleted_at IS NULL AND archived_at IS NULL').all({ c: canvasId, ids: JSON.stringify(ids) }) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * A log the database keeps as cards are written: `changes`, the canvas's cards written since it
   * stood at `after`, and where it stands now; `at`, where it stands now (its entries' ids are never
   * taken again); `drop`, the canvas read its entries up to `upTo`, which leave it.
   */
  private changeLog(table: 'shared_changes' | 'archive_changes') {
    const at = () => (this.db.query(`SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '${table}'), 0) AS n`).get() as { n: number }).n;
    return {
      changes: (canvasId: string, after: number): { upTo: number; ids: string[] } => {
        const rows = this.db.query(`SELECT card_id AS card FROM ${table} WHERE canvas_id = $c AND id > $after`).all({ c: canvasId, after }) as { card: string }[];
        return { upTo: Math.max(after, at()), ids: [...new Set(rows.map((r) => r.card))] };
      },
      at,
      drop: (canvasId: string, upTo: number) => {
        this.db.query(`DELETE FROM ${table} WHERE canvas_id = $c AND id <= $upTo`).run({ c: canvasId, upTo });
      },
    };
  }

  /**
   * A mark of the canvas's shared cards that moves whenever one changes in what their pages' notice
   * is made of (their page, title, repository, demos), one stops being shared or goes.
   */
  shareRev(canvasId: string): number {
    return (this.db.query('SELECT rev FROM share_revs WHERE canvas_id = $c').get({ c: canvasId }) as { rev: number } | null)?.rev ?? 0;
  }

  /**
   * The canvas's archive, the most recently archived first (of those archived at once, the newest
   * card first): `count` cards after the card `after`, or from the start.
   */
  archivePage(canvasId: string, count: number, after?: ArchiveCursor): CardRow[] {
    const where = 'canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL';
    return (
      after
        ? this.db
            .query(`SELECT * FROM cards WHERE ${where} AND (archived_at, created_at, id) < ($at, $created, $id) ORDER BY archived_at DESC, created_at DESC, id DESC LIMIT $n`)
            .all({ c: canvasId, n: count, at: after.at, created: after.created, id: after.id })
        : this.db.query(`SELECT * FROM cards WHERE ${where} ORDER BY archived_at DESC, created_at DESC, id DESC LIMIT $n`).all({ c: canvasId, n: count })
    ) as CardRow[];
  }

  /** The rows of these cards that are in the canvas's archive. */
  archivedRows(canvasId: string, ids: string[]): CardRow[] {
    return this.db
      .query('SELECT * FROM cards WHERE id IN (SELECT value FROM json_each($ids)) AND canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL')
      .all({ c: canvasId, ids: JSON.stringify(ids) }) as CardRow[];
  }

  /**
   * An agent session's estimated cost so far (`usd`, US dollars), as its harness reports it after each
   * turn: cumulative over the session, a resumed one going on from its earlier total. A total below
   * the last one means the harness started counting afresh (a resume without the earlier total, a
   * cleared context): what it had counted before stays (`settled`). A session of a card's agent
   * (`cardId`) counts to that card, any other to the canvas alone. Says whether anything changed.
   */
  spend(canvasId: string, cardId: string | null, session: string, usd: number): boolean {
    return this.db.transaction(() => {
      const had = this.db.query('SELECT usd, settled FROM spend WHERE canvas_id = $c AND session = $s').get({ c: canvasId, s: session }) as { usd: number; settled: number } | null;
      if (had && had.usd === usd) return false;
      const settled = had ? had.settled + (usd < had.usd ? had.usd : 0) : 0;
      this.db
        .query('INSERT INTO spend (canvas_id, card_id, session, usd, settled) VALUES ($c, $card, $s, $u, $settled) ON CONFLICT(canvas_id, session) DO UPDATE SET card_id = $card, usd = $u, settled = $settled')
        .run({ c: canvasId, card: cardId, s: session, u: usd, settled });
      if (cardId) this.db.query('UPDATE cards SET spent = (SELECT sum(usd + settled) FROM spend WHERE card_id = $card) WHERE id = $card').run({ card: cardId });
      return true;
    })();
  }

  /** What the agents on a canvas cost so far in US dollars: its cards' (archived ones too) and its own agents' (the Coordinator's); 0 before any reported a cost. */
  spentOn(canvasId: string): number {
    return (this.db.query('SELECT sum(usd + settled) AS usd FROM spend WHERE canvas_id = $c').get({ c: canvasId }) as { usd: number | null }).usd ?? 0;
  }

  /** What the workstreams of each of these projects cost so far (archived ones too), by project; projects whose workstreams cost nothing are left out. */
  spentUnder(projects: string[]): Map<string, number> {
    const rows = this.db
      .query('SELECT parent_id AS project, sum(spent) AS usd FROM cards WHERE parent_id IN (SELECT value FROM json_each($p)) AND deleted_at IS NULL AND spent IS NOT NULL GROUP BY parent_id')
      .all({ p: JSON.stringify(projects) }) as { project: string; usd: number }[];
    return new Map(rows.map((r) => [r.project, r.usd]));
  }

  /**
   * A mark of the canvas's archive that moves whenever a row its items are made of is written: an
   * archived card, a workstream of an archived project, a prototype of an archived idea; one leaving
   * the archive (taken back, deleted) too. Kept by the database as the rows are written.
   */
  archiveRev(canvasId: string): string {
    return String((this.db.query('SELECT rev FROM archive_revs WHERE canvas_id = $c').get({ c: canvasId }) as { rev: number } | null)?.rev ?? 0);
  }

  /** The canvas's archived projects and archived cards whose landed work added plan docs. */
  archivedPlans(canvasId: string): CardRow[] {
    return this.db
      .query(
        `SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL
           AND ((kind = 'project' AND plan_ref IS NOT NULL) OR plan_docs IS NOT NULL)`,
      )
      .all({ c: canvasId }) as CardRow[];
  }

  /** The projects on the canvas (not archived) that have something stored of what builds on what, with only that. */
  projectDeps(canvasId: string): Pick<CardRow, 'id' | 'deps'>[] {
    return this.db
      .query("SELECT id, deps FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NULL AND kind = 'project' AND deps IS NOT NULL")
      .all({ c: canvasId }) as Pick<CardRow, 'id' | 'deps'>[];
  }

  /** The canvas's projects, on the canvas or archived. */
  projects(canvasId: string): CardRow[] {
    return this.db.query("SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND kind = 'project' AND plan_ref IS NOT NULL").all({ c: canvasId }) as CardRow[];
  }

  /** The cards whose landed work added plan docs, on the canvas or archived. */
  withPlanDocs(canvasId: string): CardRow[] {
    return this.db.query('SELECT * FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND plan_docs IS NOT NULL').all({ c: canvasId }) as CardRow[];
  }

  /** The canvas's prototypes, on the canvas or archived, the oldest first: which they are, without the rest of their rows. */
  prototypes(canvasId: string): Pick<CardRow, 'id' | 'prototype_of' | 'archived_at'>[] {
    return this.db
      .query('SELECT id, prototype_of, archived_at FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND prototype_of IS NOT NULL ORDER BY created_at, rowid')
      .all({ c: canvasId }) as Pick<CardRow, 'id' | 'prototype_of' | 'archived_at'>[];
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

  /** Of the given cards, those on another canvas than `canvasId` and not deleted: with their canvas, its name and their title. */
  elsewhere(ids: string[], canvasId: string): { id: string; canvas: string; canvasName: string | null; title: string | null }[] {
    if (!ids.length) return [];
    return this.db
      .query(
        `SELECT c.id, c.canvas_id AS canvas, v.name AS canvasName, c.title FROM cards c LEFT JOIN canvases v ON v.id = c.canvas_id
         WHERE c.id IN (SELECT value FROM json_each($ids)) AND c.canvas_id != $c AND c.deleted_at IS NULL`,
      )
      .all({ ids: JSON.stringify(ids), c: canvasId }) as { id: string; canvas: string; canvasName: string | null; title: string | null }[];
  }

  card(id: string): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE id = $id').get({ id }) as CardRow | null) ?? null;
  }

  /** The card an address names, by its id or its short code. */
  cardNamed(code: string): CardRow | null {
    return this.card(code) ?? ((this.db.query('SELECT * FROM cards WHERE short = $s').get({ s: code.toLowerCase() }) as CardRow | null) ?? null);
  }

  /** The card that works on a branch, archived ones too: the one that took it last, where several did. */
  cardOnBranch(branch: string): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE branch = $b AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 1').get({ b: branch }) as CardRow | null) ?? null;
  }

  /** The card with the number, wherever it is: on any canvas, archived or deleted. */
  cardByNumber(n: number): CardRow | null {
    return (this.db.query('SELECT * FROM cards WHERE number = $n').get({ n }) as CardRow | null) ?? null;
  }

  insert(rows: NewRow[]): CardRow[] {
    const stmt = this.db.query(
      `INSERT INTO cards (id, short, number, canvas_id, kind, state, title, body, x, y, parent_id, plan_ref, from_id, repo, idea, prototype_of, prototype, images, retro, proposal, group_id, created_at, updated_at, changed_at)
       VALUES ($id, $short, (SELECT coalesce(max(number), 0) + 1 FROM cards), $canvas_id, $kind, $state, $title, $body, $x, $y, $parent_id, $plan_ref, $from_id, $repo, $idea, $prototype_of, $prototype, $images, $retro, $proposal, $group_id, $now, $now, $now)`,
    );
    const taken = this.db.query('SELECT 1 FROM cards WHERE short = $s');
    const ids = this.db.transaction(() =>
      rows.map((r) => {
        const id = crypto.randomUUID();
        // the shortest start of its hex digits no other card has as its code; the whole of them is its own
        const hex = id.replaceAll('-', '');
        let n = SHORT;
        while (n < hex.length && taken.get({ s: hex.slice(0, n) })) n++;
        stmt.run({
          id,
          short: hex.slice(0, n),
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

  /** Something the owner sees happened at the card with this plan reference, outside its row (its text in the plan doc). */
  touch(canvasId: string, planRef: string) {
    this.db.query('UPDATE cards SET changed_at = $now WHERE canvas_id = $c AND plan_ref = $ref AND deleted_at IS NULL').run({ c: canvasId, ref: planRef, now: now() });
  }

  update(id: string, fields: RowUpdate) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = $${k}`).join(', ');
    const seen = keys.some((k) => SEEN.has(k));
    this.db.query(`UPDATE cards SET ${set}, updated_at = $now${seen ? ', changed_at = $now' : ''} WHERE id = $id`).run({ ...fields, id, now: now() });
  }

  /** Puts the card on another workstream (`planRef`, in project `parentId`), or takes it out of its project (both null). */
  replan(id: string, planRef: string | null, parentId: string | null) {
    this.db.query('UPDATE cards SET plan_ref = $ref, parent_id = $parent, updated_at = $now WHERE id = $id').run({ id, ref: planRef, parent: parentId, now: now() });
  }

  /** The last line of the card's log that names a branch of its own (`obeya/<slug>-<id>…`). */
  branchMention(cardId: string): string | null {
    const row = this.db
      .query("SELECT text FROM events WHERE card_id = $id AND text LIKE '%obeya/%' || $short || '%' ORDER BY id DESC LIMIT 1")
      .get({ id: cardId, short: cardId.slice(0, 6) }) as { text: string } | null;
    return row?.text ?? null;
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
    const stmt = this.db.query('UPDATE cards SET group_id = $g, updated_at = $now WHERE id = $id');
    this.db.transaction(() => cardIds.forEach((id) => stmt.run({ id, g: groupId, now: now() })))();
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

  /** Writes a line into a card's log; returns it as it is read back. */
  addEvent(e: NewEvent): CardEvent {
    const at = e.at || now();
    // a new line was read after none (`readAfter` is set as it is read)
    const fields = Object.fromEntries(FIELDS.map(([f, how]) => [f, stored(how, f === 'readAfter' ? undefined : e[f])])) as Record<EventField, string | number | null>;
    const head = { cardId: e.cardId, at, kind: e.kind, author: e.author, text: e.text };
    const { id } = this.db.query(INSERT_EVENT).get({ ...head, ...fields }) as { id: number };
    if (e.kind !== 'activity') this.db.query('UPDATE cards SET changed_at = max(changed_at, $at) WHERE id = $id').run({ id: e.cardId, at });
    return eventOf({ id, ...head, ...fields });
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

  // ---------------------------------------------------------------- the work retrospective

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

  /** The cards the work retrospective proposed for a repository (`null`: the home repository), oldest first, with what became of them. */
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

  /** The settings the work retrospective proposed, oldest first, with what became of them: those of a repository, or all; the cards they rest on with their titles. */
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

  /**
   * The repository ids the canvas's cards go by, archived ones included: their repository, the one
   * before the plan doc a workstream or project of another repository than the home one is of
   * (`<repo>:<path>`), and the one of the workspaces they hold.
   */
  cardRepos(canvasId: string): string[] {
    const rows = this.db
      .query(
        `SELECT repo FROM cards WHERE canvas_id = $c AND repo IS NOT NULL AND deleted_at IS NULL
         UNION SELECT substr(plan_ref, 1, instr(plan_ref, ':') - 1) FROM cards WHERE canvas_id = $c AND instr(plan_ref, ':') > 1 AND deleted_at IS NULL
         UNION SELECT repo FROM workspaces WHERE canvas_id = $c AND repo IS NOT NULL`,
      )
      .all({ c: canvasId }) as { repo: string }[];
    return rows.map((r) => r.repo);
  }

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
    const rows = this.db.query('SELECT id, name, paired_at AS pairedAt, last_seen AS lastSeen, push IS NOT NULL AS push, app FROM devices ORDER BY paired_at').all() as (Omit<DeviceView, 'push' | 'app'> & { push: number; app: string | null })[];
    return rows.map(({ push, app, ...d }) => ({ ...d, ...(push ? { push: true as const } : {}), ...(app ? { app } : {}) }));
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
    const d = this.db.query('SELECT id, name, paired_at AS pairedAt, last_seen AS lastSeen, app FROM devices WHERE token_hash = $hash').get({ hash }) as (Omit<DeviceView, 'app'> & { app: string | null }) | null;
    if (!d) return null;
    const { app, ...rest } = d;
    return app ? { ...rest, app } : rest;
  }

  addDevice(d: DeviceView & { tokenHash: string }) {
    this.db.query('INSERT INTO devices (id, token_hash, name, paired_at, last_seen) VALUES ($id, $hash, $name, $paired, $seen)').run({ id: d.id, hash: d.tokenHash, name: d.name, paired: d.pairedAt, seen: d.lastSeen });
  }

  /** Where the device's app on the home screen opens Obeya. */
  setDeviceApp(id: string, app: string) {
    this.db.query('UPDATE devices SET app = $app WHERE id = $id').run({ id, app });
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
