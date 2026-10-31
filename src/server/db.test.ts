import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardEvent } from '../core/types';
import { MIGRATIONS, NewerDatabase, OlderDatabase, RELEASED, Store } from './db';

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
    const s = new Store(path);
    s.ensureCanvas('c', 'C');
    const [video, answered, held, project] = s.insert([
      { canvas_id: 'c', kind: 'task', state: 'waiting', x: 0, y: 0 },
      { canvas_id: 'c', kind: 'task', state: 'waiting', x: 0, y: 1 },
      { canvas_id: 'c', kind: 'task', state: 'done', x: 0, y: 2 },
      { canvas_id: 'c', kind: 'project', plan_ref: 'docs/plan/gone.md', title: 'Gone', x: 0, y: 3 },
    ]);
    const log = (cardId: string, kind: CardEvent['kind'], author: CardEvent['author'], text: string) => s.addEvent({ cardId, kind, author, text });
    const first = log(answered!.id, 'review', 'worker', 'Done.');
    log(answered!.id, 'answer', 'owner', 'Yes');
    log(answered!.id, 'review', 'worker', 'Done again.');
    const paused = log(video!.id, 'state', 'owner', 'Paused. The agent goes on when you click “Resume” or write to it.');
    s.update(video!.id, { demo: JSON.stringify({ dir: '/d', chapters: [], answering: true }) });
    s.update(answered!.id, { demo: JSON.stringify({ kind: 'video', dir: '/d', chapters: [], question: 'Q?', answer: 'Yes' }) });
    s.update(held!.id, { share: JSON.stringify({ slug: 's', state: 'pending', dir: '/d', shown: { title: 'T', text: '', chapters: [] } }) });
    s.setSetting('c', 'work_retro_since:app', '2026-10-01T00:00:00Z');
    // the schema as released: without the columns later migrations add
    s.db.run('ALTER TABLE talk DROP COLUMN reply_to');
    s.db.run('ALTER TABLE cards DROP COLUMN app');
    s.db.run('DROP TABLE devices');
    s.db.run('ALTER TABLE talk DROP COLUMN wish');
    s.db.run('ALTER TABLE events DROP COLUMN wish');
    s.db.run('ALTER TABLE cards DROP COLUMN demos');
    s.db.run('ALTER TABLE cards DROP COLUMN waiting_since');
    s.db.run('DROP TABLE trusted_commands');
    s.db.run('ALTER TABLE talk DROP COLUMN held');
    s.db.run('ALTER TABLE cards DROP COLUMN snoozed');
    s.db.run('ALTER TABLE talk DROP COLUMN waits');
    s.db.run('ALTER TABLE talk DROP COLUMN after_wait');
    s.db.run('DROP TABLE folder_cards');
    s.db.run('ALTER TABLE cards DROP COLUMN files');
    s.db.run('ALTER TABLE cards DROP COLUMN deps');
    s.db.run('ALTER TABLE cards DROP COLUMN collapsed');
    s.db.run('ALTER TABLE talk DROP COLUMN asked_in');
    s.db.run('ALTER TABLE events DROP COLUMN reply');
    s.db.run('ALTER TABLE cards DROP COLUMN kept_in');
    s.db.run('ALTER TABLE cards DROP COLUMN contribution');
    s.db.run('ALTER TABLE cards DROP COLUMN new_repo');
    s.db.run('ALTER TABLE talk DROP COLUMN moved');
    s.db.run('ALTER TABLE cards DROP COLUMN page_heard');
    s.db.run('ALTER TABLE events DROP COLUMN forwarded');
    s.db.run('ALTER TABLE cards DROP COLUMN pausing');
    s.db.run('ALTER TABLE talk DROP COLUMN then_step');
    s.db.run('ALTER TABLE talk DROP COLUMN after_answer');
    s.db.run('ALTER TABLE events DROP COLUMN token');
    s.db.run(`PRAGMA user_version = ${RELEASED}`);
    s.db.close();

    const after = new Store(path);
    expect(JSON.parse(after.card(video!.id)!.demo!)).toEqual({ dir: '/d', chapters: [], kind: 'video' });
    expect(JSON.parse(after.card(video!.id)!.detail!)).toEqual({ answering: true });
    expect(after.events(video!.id).find((e) => e.id === paused.id)!.text).toBe('Paused.');
    expect(JSON.parse(after.card(answered!.id)!.demo!).handover).toBe(first.id);
    expect(JSON.parse(after.card(held!.id)!.share!)).toMatchObject({ state: 'publishing', shown: { kind: 'video' } });
    expect(JSON.parse(after.card(project!.id)!.plan!)).toEqual({ file: 'docs/plan/gone.md', title: 'Gone', goal: '', workstreams: [], markdown: '' });
    expect(after.setting('c', 'work_retro_runs:app')).toBe('3');
    after.db.close();
  }));
