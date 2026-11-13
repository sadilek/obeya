import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, NewerDatabase, OlderDatabase, RELEASED, SCHEMA, SHORT, Store } from './db';
import { Sheet } from './sheet';

/**
 * A database as an Obeya left it that knew the first `n` migrations: the released schema and those,
 * at their `user_version`. A test puts its rows in by SQL, in the shape of that time.
 */
function databaseBefore(path: string, n: number) {
  const db = new Database(path, { strict: true });
  db.run(SCHEMA);
  for (const migration of MIGRATIONS.slice(0, n)) db.run(migration);
  db.run(`PRAGMA user_version = ${RELEASED + n}`);
  db.run("INSERT INTO canvases (id, name, created_at) VALUES ('c', 'C', '2026-10-01T00:00:00.000Z')");
  return db;
}

const version = (path: string) => {
  const db = new Database(path);
  const { user_version } = db.query('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return user_version;
};

function withPath(f: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-db-'));
  try {
    f(join(dir, 'obeya.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a database a newer Obeya wrote is left alone, not opened', () =>
  withPath((path) => {
    new Store(path).db.close();
    const newer = new Database(path);
    newer.run(`PRAGMA user_version = ${RELEASED + MIGRATIONS.length + 1}`);
    newer.close();
    expect(() => new Store(path)).toThrow(NewerDatabase);
    expect(version(path)).toBe(RELEASED + MIGRATIONS.length + 1);
  }));

test('a database an Obeya before the release left behind it is left alone, not opened', () =>
  withPath((path) => {
    const old = new Database(path);
    old.run('CREATE TABLE canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)');
    old.run(`PRAGMA user_version = ${RELEASED - 1}`);
    old.close();
    expect(() => new Store(path)).toThrow(OlderDatabase);
    expect(version(path)).toBe(RELEASED - 1);
  }));

test('what an Obeya before the release kept in earlier shapes is in today’s', () =>
  withPath((path) => {
    const db = databaseBefore(path, 0);
    const [video, answered, held, project] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const card = db.query(
      "INSERT INTO cards (id, canvas_id, kind, state, title, plan_ref, demo, share, x, y, created_at, updated_at) VALUES ($id, 'c', $kind, $state, $title, $plan_ref, $demo, $share, 0, 0, '', '')",
    );
    const row = { kind: 'task', state: null, title: null, plan_ref: null, demo: null, share: null };
    card.run({ ...row, id: video, state: 'waiting', demo: JSON.stringify({ dir: '/d', chapters: [], answering: true }) });
    card.run({ ...row, id: answered, state: 'waiting', demo: JSON.stringify({ kind: 'video', dir: '/d', chapters: [], question: 'Q?', answer: 'Yes' }) });
    card.run({ ...row, id: held, state: 'done', share: JSON.stringify({ slug: 's', state: 'pending', dir: '/d', shown: { title: 'T', text: '', chapters: [] } }) });
    card.run({ ...row, id: project, kind: 'project', title: 'Gone', plan_ref: 'docs/plan/gone.md' });
    const log = db.query("INSERT INTO events (id, card_id, at, kind, author, text) VALUES ($id, $card, '2026-10-01T00:00:00.000Z', $kind, $author, $text)");
    log.run({ id: 1, card: answered, kind: 'review', author: 'worker', text: 'Done.' });
    log.run({ id: 2, card: answered, kind: 'answer', author: 'owner', text: 'Yes' });
    log.run({ id: 3, card: answered, kind: 'review', author: 'worker', text: 'Done again.' });
    log.run({ id: 4, card: video, kind: 'state', author: 'owner', text: 'Paused. The agent goes on when you click “Resume” or write to it.' });
    db.run("INSERT INTO settings (canvas_id, key, value) VALUES ('c', 'work_retro_since:app', '2026-10-01T00:00:00Z')");
    db.close();

    const after = new Store(path);
    expect(JSON.parse(after.card(video)!.demo!)).toEqual({ dir: '/d', chapters: [], kind: 'video' });
    // a card's last visible change starts as its last write
    expect(after.card(video)!.changed_at).toBe(after.card(video)!.updated_at);
    expect(JSON.parse(after.card(video)!.detail!)).toEqual({ answering: true });
    expect(after.events(video).find((e) => e.id === 4)!.text).toBe('Paused.');
    expect(JSON.parse(after.card(answered)!.demo!).handover).toBe(1);
    expect(JSON.parse(after.card(held)!.share!)).toMatchObject({ state: 'publishing', shown: { kind: 'video' } });
    expect(JSON.parse(after.card(project)!.plan!)).toEqual({ file: 'docs/plan/gone.md', title: 'Gone', goal: '', workstreams: [], markdown: '' });
    expect(after.setting('c', 'work_retro_runs:app')).toBe('3');
    expect(after.card(video)!.short).toBe(video.replaceAll('-', '').slice(0, SHORT));
    after.db.close();
  }));

test('a card gets the shortest code no other card has: the start of its id, one digit longer for each card that shares it', () => {
  const s = new Store(':memory:');
  s.ensureCanvas('c', 'C');
  const [a] = s.insert([{ canvas_id: 'c', kind: 'task', x: 0, y: 0 }]);
  expect(a!.short).toMatch(new RegExp(`^[0-9a-f]{${SHORT}}$`));
  expect(a!.id.replaceAll('-', '').startsWith(a!.short)).toBe(true);
  // ids that share their start with cards there are already
  const ids = ['abcdef01-0000-4000-8000-000000000001', 'abcdef01-0000-4000-8000-000000000002', 'abcdef01-0000-4000-8000-000000000003'];
  const real = crypto.randomUUID;
  let n = 0;
  crypto.randomUUID = () => ids[n++] as ReturnType<typeof crypto.randomUUID>;
  try {
    expect(s.insert([0, 1, 2].map((y) => ({ canvas_id: 'c', kind: 'task' as const, x: 0, y }))).map((r) => r.short)).toEqual(['abcdef', 'abcdef0', 'abcdef01']);
  } finally {
    crypto.randomUUID = real;
  }
});

test('the migration gives the cards there are codes of their own, longer where their ids start alike', () =>
  withPath((path) => {
    // the migration that gives cards their codes
    const db = databaseBefore(path, 27);
    const ids = ['12345678-0000-4000-8000-000000000001', '12345678-0000-4000-8000-000000000002', '1234aaaa-0000-4000-8000-000000000003', 'ffffffff-0000-4000-8000-000000000004'];
    const insert = db.query("INSERT INTO cards (id, canvas_id, kind, x, y, created_at, updated_at) VALUES ($id, 'c', 'task', 0, 0, '', '')");
    for (const id of ids) insert.run({ id });
    db.close();
    const after = new Store(path);
    expect(ids.map((id) => after.card(id)!.short)).toEqual(['12345678000040008000000000000001', '12345678000040008000000000000002', '1234aa', 'ffffff']);
    after.db.close();
  }));

test('a card gets the next number across all canvases, also after the newest card was deleted', () => {
  const s = new Store(':memory:');
  s.ensureCanvas('c', 'C');
  s.ensureCanvas('d', 'D');
  const [a, b] = s.insert([0, 1].map((y) => ({ canvas_id: 'c', kind: 'task' as const, x: 0, y })));
  const [c] = s.insert([{ canvas_id: 'd', kind: 'task', x: 0, y: 0 }]);
  expect([a!.number, b!.number, c!.number]).toEqual([1, 2, 3]);
  s.update(c!.id, { deleted_at: new Date().toISOString() });
  expect(s.insert([{ canvas_id: 'c', kind: 'task', x: 0, y: 0 }])[0]!.number).toBe(4);
  expect(s.cardByNumber(3)!.id).toBe(c!.id);
  expect(s.cardByNumber(5)).toBeNull();
});

test('the migration numbers the cards there are in the order they were made, across canvases, and notes since when each canvas has numbers', () =>
  withPath((path) => {
    // the migration that numbers the cards
    const db = databaseBefore(path, 29);
    db.run("INSERT INTO canvases (id, name, created_at) VALUES ('d', 'D', '2026-10-01T00:00:00.000Z')");
    const insert = db.query("INSERT INTO cards (id, short, canvas_id, kind, x, y, created_at, updated_at) VALUES ($id, $id, $c, 'task', 0, 0, $at, $at)");
    insert.run({ id: 'later', c: 'c', at: '2026-10-02T00:00:00.000Z' });
    insert.run({ id: 'first', c: 'd', at: '2026-10-01T00:00:00.000Z' });
    insert.run({ id: 'same-time', c: 'c', at: '2026-10-02T00:00:00.000Z' });
    db.close();
    const after = new Store(path);
    expect(['first', 'later', 'same-time'].map((id) => after.card(id)!.number)).toEqual([1, 2, 3]);
    expect(after.setting('c', 'card_numbers_since')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(after.setting('d', 'card_numbers_since')).not.toBeNull();
    after.db.close();
  }));

test('a card counts as changed when something happens at it, not when it moves', () =>
  withPath((path) => {
    const s = new Store(path);
    s.ensureCanvas('c', 'C');
    const [card] = s.insert([{ canvas_id: 'c', kind: 'task', state: 'planned', x: 0, y: 0 }]);
    const id = card!.id;
    const old = '2026-01-01T00:00:00.000Z';
    const changed = () => s.card(id)!.changed_at!;
    const reset = () => s.db.run(`UPDATE cards SET changed_at = '${old}', updated_at = '${old}' WHERE id = '${id}'`);
    reset();
    s.update(id, { x: 40, y: 80 });
    // any write still moves `updated_at`
    expect(s.card(id)!.updated_at > old).toBe(true);
    s.update(id, { session_id: 's1', workspace: '/w', page_heard: '[]', waiting_since: '2026-01-02T00:00:00.000Z' });
    s.setGroup([id], s.addGroup('c', 'G', 0).id);
    s.addEvent({ cardId: id, kind: 'activity', author: 'worker', text: 'Read a file' });
    expect(changed()).toBe(old);
    s.update(id, { title: 'Renamed' });
    expect(changed() > old).toBe(true);
    reset();
    s.addEvent({ cardId: id, kind: 'report', author: 'worker', text: 'Tests pass' });
    expect(changed() > old).toBe(true);
    s.db.close();
  }));

test('the archive’s mark moves with every write to a row its items are made of, and with none to the cards on the canvas', () =>
  withPath((path) => {
    const s = new Store(path);
    s.ensureCanvas('c', 'C');
    s.ensureCanvas('d', 'D');
    const [plain, project, idea] = s.insert([
      { canvas_id: 'c', kind: 'task', state: 'live', x: 0, y: 0 },
      { canvas_id: 'c', kind: 'project', plan_ref: 'docs/plan/a.md', x: 0, y: 0 },
      { canvas_id: 'c', kind: 'task', state: 'idea', x: 0, y: 0 },
    ]);
    const [workstream, prototype] = s.insert([
      { canvas_id: 'c', kind: 'task', parent_id: project!.id, plan_ref: 'docs/plan/a.md#W1', x: 0, y: 0 },
      { canvas_id: 'c', kind: 'task', state: 'live', prototype_of: idea!.id, x: 0, y: 0 },
    ]);
    const rev = () => s.archiveRev('c');
    const moves = (write: () => void) => {
      const before = rev();
      write();
      return rev() !== before;
    };
    // nothing archived: the cards at work on the canvas leave it be
    expect(moves(() => s.update(workstream!.id, { status_line: 'Working' }))).toBe(false);
    expect(moves(() => s.update(prototype!.id, { status_line: 'Working' }))).toBe(false);
    expect(moves(() => s.update(plain!.id, { archived_at: '2026-11-01T00:00:00.000Z' }))).toBe(true);
    expect(moves(() => s.update(plain!.id, { title: 'Renamed in the archive' }))).toBe(true);
    expect(moves(() => s.update(project!.id, { archived_at: '2026-11-01T00:00:00.000Z' }))).toBe(true);
    expect(moves(() => s.update(workstream!.id, { status_line: 'Done' }))).toBe(true);
    let added = '';
    expect(moves(() => (added = s.insert([{ canvas_id: 'c', kind: 'task', parent_id: project!.id, plan_ref: 'docs/plan/a.md#W2', x: 0, y: 0 }])[0]!.id))).toBe(true);
    // a workstream taken out of the archived project leaves its archive
    expect(moves(() => s.replan(added, null, null))).toBe(true);
    expect(moves(() => s.update(added, { status_line: 'On its own' }))).toBe(false);
    expect(moves(() => s.update(idea!.id, { archived_at: '2026-11-01T00:00:00.000Z' }))).toBe(true);
    expect(moves(() => s.update(prototype!.id, { prototype: 'discarded' }))).toBe(true);
    // taken back, deleted, gone for good, moved to another canvas
    expect(moves(() => s.update(idea!.id, { archived_at: null }))).toBe(true);
    expect(moves(() => s.update(prototype!.id, { status_line: 'On the canvas again' }))).toBe(false);
    expect(moves(() => s.update(plain!.id, { deleted_at: '2026-11-02T00:00:00.000Z' }))).toBe(true);
    expect(moves(() => s.db.query('DELETE FROM cards WHERE id = $id').run({ id: plain!.id }))).toBe(true);
    const other = s.archiveRev('d');
    expect(moves(() => s.moveCard(workstream!.id, 'd', { x: 0, y: 0 }))).toBe(true);
    expect(s.archiveRev('d')).not.toBe(other);
    // the cards on the canvas still leave it be
    expect(moves(() => s.update(idea!.id, { title: 'An idea on the canvas' }))).toBe(false);
    s.db.close();
  }));

test("a session's cost counts as its latest running total; one that starts counting afresh keeps what it counted before", () => {
  const s = new Store(':memory:');
  s.ensureCanvas('c', 'C');
  const [card, project, workstream] = s.insert([
    { canvas_id: 'c', kind: 'task', x: 0, y: 0 },
    { canvas_id: 'c', kind: 'project', x: 0, y: 0 },
    { canvas_id: 'c', kind: 'task', x: 0, y: 0 },
  ]);
  s.db.query('UPDATE cards SET parent_id = $p WHERE id = $id').run({ p: project!.id, id: workstream!.id });
  expect(s.spend('c', card!.id, 'a', 0.5)).toBe(true);
  expect(s.spend('c', card!.id, 'a', 1.25)).toBe(true);
  // the same total again changes nothing
  expect(s.spend('c', card!.id, 'a', 1.25)).toBe(false);
  expect(s.card(card!.id)!.spent).toBe(1.25);
  // a lower total: the harness counts afresh, the 1.25 before it stays
  s.spend('c', card!.id, 'a', 0.25);
  expect(s.card(card!.id)!.spent).toBe(1.5);
  // a second session of the card adds to it
  s.spend('c', card!.id, 'b', 1);
  expect(s.card(card!.id)!.spent).toBe(2.5);
  // the canvas's own agents count to the canvas alone; a project's workstreams to the project
  s.spend('c', null, 'k', 0.3);
  s.spend('c', workstream!.id, 'w', 2);
  expect(s.card(project!.id)!.spent).toBeNull();
  expect(s.spentUnder([project!.id, card!.id])).toEqual(new Map([[project!.id, 2]]));
  expect(s.spentOn('c')).toBeCloseTo(4.8, 9);
  expect(s.spentOn('other')).toBe(0);
});

test('the migration gives what the Coordinator said, looked up and decided as `koordinator` to the Coordinator', () =>
  withPath((path) => {
    // the migration that renames `koordinator`
    const db = databaseBefore(path, 43);
    const at = '2026-10-01T00:00:00.000Z';
    db.run(`INSERT INTO cards (id, short, number, canvas_id, kind, x, y, created_at, updated_at) VALUES ('card', 'card', 1, 'c', 'task', 0, 0, '${at}', '${at}')`);
    db.run(`INSERT INTO events (id, card_id, at, kind, author, text) VALUES (1, 'card', '${at}', 'say', 'koordinator', '„Export“ startet.')`);
    db.run(`INSERT INTO talk (id, canvas_id, at, said, reply, question, answer, answer_by) VALUES (1, 'c', '${at}', 'Was steht?', 'Ich schaue nach.', 'Was steht?', 'Der Export.', 'koordinator')`);
    db.run(`INSERT INTO decisions (canvas_id, card_id, question, answer, by, at) VALUES ('c', 'card', 'CSV?', 'Ja.', 'koordinator', '${at}')`);
    db.close();
    const after = new Store(path);
    expect(after.event('card', 1)!.author).toBe('coordinator');
    expect(new Sheet(after.db, 'c', () => {}).latest().find((t) => t.id === 1)!.answerBy).toBe('coordinator');
    expect(after.cardDecisions('c', 'card').map((d) => d.by)).toEqual(['coordinator']);
    after.db.close();
  }));
