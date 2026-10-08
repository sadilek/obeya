import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, NewerDatabase, Store } from './db';

test('a database a newer Obeya wrote is left alone, not opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-db-'));
  try {
    const path = join(dir, 'obeya.db');
    new Store(path).db.close();
    const newer = new Database(path);
    newer.run(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    newer.close();
    expect(() => new Store(path)).toThrow(NewerDatabase);
    const after = new Database(path);
    expect((after.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length + 1);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
