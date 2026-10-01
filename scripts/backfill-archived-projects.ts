// One-off, for Obeya's own canvas: projects whose plan doc was deleted before Obeya kept a doc's
// last state on its project are only hidden. This takes each one's last state from the git history
// (the version before the commit that deleted the doc) and puts the project into the archive, dated
// by that commit. The idea it came from is linked only where exactly one candidate exists: an
// idea's "Plan-Doc" card that landed on main within ten minutes before the doc was added.
//
//   bun scripts/backfill-archived-projects.ts --db ~/.obeya/obeya.db --repo ~/dev/obeya [--canvas obeya] [--write]
//
// Without --write it only says what it would do. With --write it first copies the database next to
// it (`obeya.db.backup-<time>`). Run it once the change that added the `plan` column has landed and
// Obeya has restarted with it.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePlanDoc } from '../src/core/plan-doc';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = resolve(opt('db') ?? `${process.env.HOME}/.obeya/obeya.db`);
const repo = resolve(opt('repo') ?? '.');
const canvas = opt('canvas') ?? 'obeya';
const write = args.includes('--write');

const git = (...a: string[]) => {
  const r = Bun.spawnSync(['git', '-C', repo, ...a]);
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
const db = new Database(dbPath, { strict: true });
const columns = (db.query('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name);
if (!columns.includes('plan')) throw new Error('the database has no `plan` column yet: start Obeya with the new code first');

type Row = { id: string; plan_ref: string; from_id: string | null };
const hidden = db
  .query("SELECT id, plan_ref, from_id FROM cards WHERE canvas_id = $c AND kind = 'project' AND deleted_at IS NULL AND archived_at IS NULL AND plan IS NULL")
  .all({ c: canvas }) as Row[];
const plans: { row: Row; plan: string; at: string; origin: string | null }[] = [];

for (const row of hidden) {
  if (row.plan_ref.includes(':')) {
    console.log(`skip ${row.plan_ref}: not in the home repository`);
    continue;
  }
  if (existsSync(resolve(repo, row.plan_ref))) {
    console.log(`skip ${row.plan_ref}: the doc is still there`);
    continue;
  }
  const deleted = git('log', '--diff-filter=D', '--format=%H %cI', '-1', '--', row.plan_ref).trim();
  if (!deleted) {
    console.log(`skip ${row.plan_ref}: no commit deletes it`);
    continue;
  }
  const [sha, date] = deleted.split(' ') as [string, string];
  const doc = parsePlanDoc(row.plan_ref, git('show', `${sha}^:${row.plan_ref}`));
  if (!doc) {
    console.log(`skip ${row.plan_ref}: its last version has no workstreams`);
    continue;
  }
  const at = new Date(date).toISOString();
  const added = new Date(git('log', '--diff-filter=A', '--format=%cI', '--reverse', '--', row.plan_ref).trim().split('\n')[0]!);
  const candidates = db
    .query(
      `SELECT DISTINCT c.id FROM cards c JOIN events e ON e.card_id = c.id
       WHERE c.canvas_id = $c AND c.deleted_at IS NULL AND c.idea IS NOT NULL AND c.title LIKE 'Plan-Doc:%'
         AND e.kind = 'state' AND e.text LIKE 'Freigegeben%' AND e.at BETWEEN $from AND $to`,
    )
    .all({ c: canvas, from: new Date(added.getTime() - 10 * 60_000).toISOString(), to: new Date(added.getTime() + 60_000).toISOString() }) as { id: string }[];
  const origin = !row.from_id && candidates.length === 1 ? candidates[0]!.id : null;
  plans.push({ row, plan: JSON.stringify(doc), at, origin });
  console.log(
    `${row.plan_ref}: „${doc.title}“, ${doc.workstreams.length} workstreams, archived ${at} (deleted in ${sha.slice(0, 7)})` +
      (origin ? `, from idea ${origin}` : candidates.length > 1 ? `, idea unclear (${candidates.length} candidates)` : ', no idea'),
  );
}

if (!plans.length) console.log('nothing to do');
else if (!write) console.log('dry run; --write applies it');
else {
  const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`backup: ${backup}`);
  const update = db.query('UPDATE cards SET plan = $plan, archived_at = $at, from_id = COALESCE(from_id, $origin), updated_at = $now WHERE id = $id');
  db.transaction(() => {
    for (const p of plans) update.run({ id: p.row.id, plan: p.plan, at: p.at, origin: p.origin, now: new Date().toISOString() });
  })();
  console.log(`archived ${plans.length} projects`);
}
db.close();
