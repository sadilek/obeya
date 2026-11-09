import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db';

/**
 * A history like the one of a long-used Obeya, written straight into a store's database: cards on
 * the canvas and many more in the archive (half of those with a page shared on the repository's
 * site), deleted ones, other canvases beside it, the cards' logs and what the owner said to the
 * Koordinator, spread over the days the history spans with the newest now. At `scale` 0, only the
 * `open` cards on the canvas, with no history at all.
 *
 * At `scale` 1 it has the shape of the owner's database of 9 November 2026 (55 MB: 158,000 events
 * over 40 days, 1,700 cards, 1,000 exchanges with the Koordinator, 10 canvases); a larger scale
 * stands for a longer history at the same pace (10: 400 days), with as many cards on the canvas as
 * before: what grows with time is the archive, the logs and the sheet, not the canvas.
 *
 * Rows are written by SQL in a few statements, so a history of millions of events takes seconds.
 */
export interface History {
  /** The canvas's archived cards, the most recently archived first. */
  archived: string[];
  /** The canvas's cards on the canvas. */
  onCanvas: string[];
  /** The canvas's cards with a page on its site, archived ones too. */
  shared: string[];
  /** The id of the newest event. */
  events: number;
}

const DAY = 86_400_000;

export function writeHistory(store: Store, canvas: string, dir: string, scale: number, open = 150): History {
  const db = store.db;
  const end = Date.now();
  const span = Math.round(40 * scale * DAY);
  const start = end - span;
  const iso = (ms: number) => new Date(ms).toISOString();
  // the demos of the shared cards lie in a few folders: what counts is that each card looks at one
  const demos = Array.from({ length: 8 }, (_, n) => {
    const d = join(dir, 'demos', `d${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'demo.mp4'), 'video');
    return d;
  });
  const others = Array.from({ length: 9 }, (_, n) => `other-${n}`);
  db.transaction(() => {
    for (const c of others) db.query('INSERT OR IGNORE INTO canvases (id, name, created_at) VALUES ($c, $c, $at)').run({ c, at: iso(start) });
    const first = ((db.query('SELECT coalesce(max(number), 0) AS n FROM cards').get() as { n: number }).n ?? 0) + 1;
    const archived = 900 * scale;
    const deleted = 60 * scale;
    const elsewhere = 600 * scale;
    const total = archived + open + deleted + elsewhere;
    // card n: archived (n < archived), on the canvas, deleted, then those of the other canvases;
    // created over the span in that order, the open ones last of the canvas's
    db.query(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < $total)
       INSERT INTO cards (id, short, number, canvas_id, kind, state, title, body, x, y, created_at, updated_at, changed_at, archived_at, deleted_at, demo, share)
       SELECT printf('%08x-0000-4000-8000-%012x', i + 1 + $first, i), printf('%08x', i + 1 + $first), i + $first,
         CASE WHEN i < $archived + $open + $deleted THEN $c ELSE printf('other-%d', i % 9) END,
         'task',
         CASE WHEN i < $archived THEN 'live' WHEN i < $archived + $open THEN (CASE i % 10 WHEN 0 THEN 'working' WHEN 1 THEN 'waiting' WHEN 2 THEN 'planned' ELSE 'live' END) ELSE 'live' END,
         printf('Card %d', i), substr($body, 1, 200 + i % 300),
         (i % 30) * 400, (i / 30) * 300,
         strftime('%Y-%m-%dT%H:%M:%fZ', ($start + (CASE WHEN i < $archived THEN i * 1.0 / $archived ELSE 0.9 + (i % 97) / 1000.0 END) * $span) / 1000.0, 'unixepoch'),
         strftime('%Y-%m-%dT%H:%M:%fZ', ($start + (CASE WHEN i < $archived THEN i * 1.0 / $archived ELSE 0.95 END) * $span) / 1000.0, 'unixepoch'),
         strftime('%Y-%m-%dT%H:%M:%fZ', ($start + (CASE WHEN i < $archived THEN i * 1.0 / $archived ELSE 0.95 END) * $span) / 1000.0, 'unixepoch'),
         CASE WHEN i < $archived OR i >= $archived + $open + $deleted THEN strftime('%Y-%m-%dT%H:%M:%fZ', ($start + (i % ($archived + 1)) * 1.0 / ($archived + 1) * $span + 3600000) / 1000.0, 'unixepoch') END,
         CASE WHEN i >= $archived + $open AND i < $archived + $open + $deleted THEN strftime('%Y-%m-%dT%H:%M:%fZ', $end / 1000.0, 'unixepoch') END,
         CASE WHEN i % 2 = 0 THEN json_object('dir', json_extract($demos, printf('$[%d]', i % 8)), 'kind', 'video', 'chapters', json('[[0,"Before"],[20,"After"]]'), 'page', json_object('title', printf('Card %d', i), 'text', substr($body, 1, 300))) END,
         CASE WHEN i % 2 = 0 AND i < $archived + $open THEN json_object('slug', printf('card-%d', i), 'url', printf('http://127.0.0.1:9/card-%d/', i), 'version', '',
           'demos', json_array(json_object('dir', json_extract($demos, printf('$[%d]', i % 8)), 'shown', json_object('kind', 'video', 'chapters', json('[[0,"Before"],[20,"After"]]'), 'page', json_object('title', printf('Card %d', i), 'text', substr($body, 1, 300)))))) END
       FROM n`,
    ).run({ total, first, archived, open, deleted, c: canvas, body: 'What the card asks for, in a few sentences, as the owner wrote it. '.repeat(10), start, span, end, demos: JSON.stringify(demos) });
    // the logs: about 90 lines per card, the pace of the owner's Obeya, mostly the agents' activity;
    // each line on a card worked on at its time, the newest also on the cards on the canvas now
    const events = 158_000 * scale;
    if (events) db.query(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < $events),
       k(i, h, kind, author) AS (
         SELECT i, (i * 2654435761) % 1000,
           CASE WHEN (i * 2654435761) % 1000 < 670 THEN 'activity' WHEN (i * 2654435761) % 1000 < 810 THEN 'say' WHEN (i * 2654435761) % 1000 < 900 THEN 'state'
             WHEN (i * 2654435761) % 1000 < 930 THEN 'report' WHEN (i * 2654435761) % 1000 < 941 THEN 'review' WHEN (i * 2654435761) % 1000 < 946 THEN 'hint'
             WHEN (i * 2654435761) % 1000 < 949 THEN 'error' WHEN (i * 2654435761) % 1000 < 951 THEN 'question' WHEN (i * 2654435761) % 1000 < 953 THEN 'answer'
             WHEN (i * 2654435761) % 1000 < 961 THEN 'talk' ELSE 'closing' END,
           CASE WHEN (i * 2654435761) % 1000 BETWEEN 880 AND 899 THEN 'owner' WHEN (i * 2654435761) % 1000 < 880 AND (i * 2654435761) % 1000 >= 810 THEN 'obeya'
             WHEN (i * 2654435761) % 1000 BETWEEN 941 AND 945 THEN 'owner' WHEN (i * 2654435761) % 1000 BETWEEN 951 AND 952 THEN 'owner'
             WHEN (i * 2654435761) % 1000 BETWEEN 953 AND 954 THEN 'owner' WHEN (i * 2654435761) % 1000 BETWEEN 946 AND 948 THEN 'obeya' ELSE 'worker' END
         FROM n),
       c(i, h, kind, author, j) AS (
         SELECT i, h, kind, author,
           CASE WHEN (i * 31) % 100 < 25 AND $elsewhere > 0 THEN $archived + $open + $deleted + min($elsewhere - 1, CAST(i * 1.0 / $events * $elsewhere AS INTEGER) + i % 5)
             WHEN (i * 31) % 100 < 45 AND i * 1.0 / $events > 0.95 THEN $archived + (i * 7919) % $open
             WHEN $archived > 0 THEN min($archived - 1, CAST(i * 1.0 / $events * $archived AS INTEGER) + i % 5)
             ELSE (i * 7919) % $open END
         FROM k)
       INSERT INTO events (card_id, at, kind, author, text)
       SELECT printf('%08x-0000-4000-8000-%012x', j + 1 + $first, j),
         strftime('%Y-%m-%dT%H:%M:%fZ', ($start + i * 1.0 / $events * $span) / 1000.0, 'unixepoch'),
         kind, author, substr($text, 1 + h % 50, CASE kind WHEN 'review' THEN 1000 WHEN 'closing' THEN 700 ELSE 60 + h % 140 END)
       FROM c`,
    ).run({ events, archived, open, deleted, elsewhere, first, start, span, text: 'The agent read the files, ran the tests and wrote down what it found along the way. '.repeat(14) });
    // what the owner said to the Koordinator and what it answered: 1,000 exchanges per 40 days
    if (scale) db.query(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < $talk)
       INSERT INTO talk (canvas_id, at, said, reply, card_id)
       SELECT CASE WHEN i % 5 = 4 THEN printf('other-%d', i % 9) ELSE $c END,
         strftime('%Y-%m-%dT%H:%M:%fZ', ($start + i * 1.0 / $talk * $span) / 1000.0, 'unixepoch'),
         substr($said, 1 + i % 40, 80 + i % 200), substr($said, 1, 120 + i % 300), NULL
       FROM n`,
    ).run({ talk: 1000 * scale, c: canvas, start, span, said: 'Start the card about the settings dialog and tell me when its demo is there. '.repeat(8) });
  })();
  const ids = (sql: string, p: Record<string, string | number> = {}) => (db.query(sql).all({ c: canvas, ...p }) as { id: string }[]).map((r) => r.id);
  return {
    archived: ids('SELECT id FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC'),
    onCanvas: ids('SELECT id FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at'),
    shared: ids('SELECT id FROM cards WHERE canvas_id = $c AND deleted_at IS NULL AND share IS NOT NULL'),
    events: (db.query('SELECT max(id) AS n FROM events').get() as { n: number }).n,
  };
}
