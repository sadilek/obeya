// Re-voices the demos of a canvas's most recently approved cards in another language and shares
// them, as was done for the 30 last Obeya demos when its demos went public in English.
//
//   bun scripts/revoice-demos.ts list [--canvas obeya] [--count 30] [--language en]
//   bun scripts/revoice-demos.ts publish <card id>… [--canvas obeya]
//
// `list`: the latest demo video of each of the `count` most recently approved cards whose demo kept
// its frames, newest first, with where it stands: `translate` (re-voicing asks for its words in the
// language), `render` (translated, not yet rendered), `revoiced`, `shared`, or `as is` (narrated in
// that language already). The re-voicing itself is the demo skill's (`node lib/revoice.ts <dir>
// <language>`), run by an agent, which translates and checks each.
// `publish`: for each card whose demo was re-voiced, the Obeya running on OBEYA_HOME (else
// ~/.obeya) reads it again (chapters, page) and shares it through its queue, like "Share"; one
// narrated in that language already is shared as it is.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGES, type Language } from '../src/core/locale';
import { MESSAGES } from '../src/core/messages';
import { recorded } from '../src/server/instance';
import { ownerApi } from '../src/server/owner';
import { obeyaHome } from '../plugin/skills/demo/lib/settings.ts';
import { script } from './common';

const { values, positionals } = script('revoice-demos').args({
  canvas: { type: 'string', default: 'obeya' },
  count: { type: 'string', default: '30' },
  language: { type: 'string', default: 'en' },
});
const home = obeyaHome();
const canvas = values.canvas;
const count = Number(values.count);
const language = LANGUAGES.find((l) => l === values.language);
const [command, ...ids] = positionals;
if (!language || !Number.isInteger(count) || (command !== 'list' && command !== 'publish') || (command === 'publish' && !ids.length)) {
  console.error('usage: bun scripts/revoice-demos.ts list [--canvas obeya] [--count 30] [--language en]\n       bun scripts/revoice-demos.ts publish <card id>… [--canvas obeya]');
  process.exit(2);
}

/** How the owner's approval reads in a card's log, in either language. */
const APPROVED = Object.values(MESSAGES).flatMap((m) => [m.worker.approvedMain, m.worker.approvedDirect, m.worker.approvedPr, m.worker.approvedUnchanged]);

interface Row {
  id: string;
  title: string | null;
  demo: string;
  share: string | null;
  approved: string;
}

/** The language a demo's report page names, if any. */
const pageLanguage = (dir: string): Language | undefined => {
  try {
    const lang = /<html\b[^>]*\blang="([a-z]{2})"/.exec(readFileSync(join(dir, 'index.html'), 'utf8'))?.[1];
    return LANGUAGES.find((l) => l === lang);
  } catch {
    return undefined;
  }
};

/** Where a demo stands on its way to `language`. */
function standing(dir: string, shared: boolean): string {
  const revoiced = existsSync(join(dir, '.work', 'revoice', 'original', 'index.html'));
  if (pageLanguage(dir) === language) return shared ? 'shared' : revoiced ? 'revoiced' : 'as is';
  return existsSync(join(dir, '.work', 'revoice', `${language}.json`)) ? 'render' : 'translate';
}

function candidates(): (Row & { dir: string })[] {
  const db = new Database(join(home, 'obeya.db'), { readonly: true });
  const rows = db
    .query<Row, string[]>(
      `SELECT c.id, c.title, c.demo, c.share, max(e.at) AS approved FROM cards c JOIN events e ON e.card_id = c.id
       WHERE c.canvas_id = ? AND c.deleted_at IS NULL AND c.demo IS NOT NULL AND c.prototype_of IS NULL AND e.kind = 'state' AND e.author = 'owner'
         AND e.text IN (${APPROVED.map(() => '?').join(', ')})
       GROUP BY c.id ORDER BY approved DESC`,
    )
    .all(canvas, ...APPROVED);
  db.close();
  return rows
    .map((r) => ({ ...r, dir: (JSON.parse(r.demo) as { dir: string; kind: string }).dir, kind: (JSON.parse(r.demo) as { kind: string }).kind }))
    .filter((r) => r.kind !== 'html' && existsSync(join(r.dir, '.work', 'frames.txt')) && existsSync(join(r.dir, '.work', 'frames')))
    .slice(0, count);
}

if (command === 'list') {
  for (const r of candidates()) {
    const shared = !!r.share && !!(JSON.parse(r.share) as { url?: string }).url;
    console.log([r.id, standing(r.dir, shared), r.approved.slice(0, 10), r.dir, (r.title ?? '').split('\n')[0]!.slice(0, 70)].join('\t'));
  }
} else {
  const instance = recorded(home);
  if (!instance) throw new Error(`no Obeya runs on ${home}`);
  const post = (path: string, json?: unknown) => ownerApi(instance.url, home)(`/api/c/${canvas}${path}`, { method: 'POST', json });
  const byId = new Map(candidates().map((r) => [r.id, r]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) throw new Error(`${id} is no card among the ${count} latest approved on ${canvas} whose demo kept its frames`);
    const now = standing(r.dir, false);
    if (now !== 'revoiced' && now !== 'as is') throw new Error(`${id}: its demo is not re-voiced in ${language} (${r.dir})`);
    if (now === 'revoiced') await post(`/cards/${id}/demo-rebuilt`);
    // one that cannot be shared (the site's credentials are not on this machine) is re-read all the same
    const shared = await post(`/cards/${id}/act`, { action: 'share' }).then(
      () => 'sharing',
      (e: Error) => `not shared: ${e.message}`,
    );
    console.log([id, now === 'revoiced' ? 're-read' : 'as is', shared, r.dir].join('\t'));
  }
}
