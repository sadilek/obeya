// Brings demo videos encoded before they were limited range BT.709 into it, as new renders are
// (plugin/skills/demo/lib/range.ts): only the picture is encoded anew, with the CRF it had; the
// sound is copied. A video in that range already is left as it is.
//
//   bun scripts/video-range.ts sites [--dry-run]
//   bun scripts/video-range.ts <demo.mp4>…
//
// `sites`: the videos of the pages this Obeya (OBEYA_HOME, else ~/.obeya) has shared, on every site
// it can deploy to (each canvas repository's `demo.site`, the personal site). They go out in place
// (`ShareTarget.replace`), a few dozen pages per deploy: each page keeps its text, tags and date.
// The card's own copies of a shared video (its demo directory, the copy Obeya kept of it) are
// replaced too once the page is out, so sharing the page again does not bring the old video back.
// Pages another machine shared (the site's manifest names it), and demos only on cards, stay as
// they are. A run cut short goes on where it stopped: the encoded videos wait in `video-range/`
// beside the site's directory until they are out. Best run while nothing else is being shared:
// Obeya's own queue does not know of this one.
//
// With files: each is encoded anew in place (the hero video, before `scripts/hero-video/publish.ts`).

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DemoSite } from '../src/core/config';
import { MESSAGES } from '../src/core/messages';
import { readShared } from '../src/adapters';
import { readPersonal, personalDemoSite } from '../src/server/personal-site';
import { MANIFEST, MAX_FILE, siteBase, siteMissing, siteTarget, type SiteOptions } from '../src/server/site';
import { siteRoot, type Meta } from '../src/server/site-pages';
import { expandHome, obeyaHome } from '../plugin/skills/demo/lib/settings.ts';
import { inTvRange, toTvRange } from '../plugin/skills/demo/lib/range.ts';
import { HERE } from '../src/server/workspaces';
import { script } from './common';

const { fail, args } = script('video-range');
const { values, positionals } = args({ 'dry-run': { type: 'boolean', default: false } });
const [command = '', ...rest] = positionals;
if (!command) fail('usage: bun scripts/video-range.ts sites [--dry-run]\n       bun scripts/video-range.ts <demo.mp4>…');

/** Pages per deploy: a failed one is tried again whole, and a deploy uploads only the files that changed. */
const BATCH = 40;

/** Encodes `video` anew in place, through a file beside it. */
function inPlace(video: string) {
  const part = join(dirname(video), `.range-${process.pid}.mp4`);
  try {
    toTvRange(video, part);
    renameSync(part, video);
  } finally {
    rmSync(part, { force: true });
  }
}

/** A hash of a demo's video as a page's `source` names it (site.ts, `sourceHash`). */
async function sourceOf(file: string): Promise<string> {
  const h = createHash('sha256').update(`demo.mp4\0${statSync(file).size}\0`);
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) h.update(chunk);
  return h.digest('hex');
}

if (command !== 'sites') {
  for (const video of [command, ...rest]) {
    if (!existsSync(video)) fail(`${video} is not there`);
    if (inTvRange(video)) {
      console.log(`${video}: in range already`);
      continue;
    }
    if (values['dry-run']) {
      console.log(`${video}: to encode`);
      continue;
    }
    const t0 = Date.now();
    inPlace(video);
    console.log(`${video}: encoded in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  process.exit(0);
}

const home = obeyaHome();

/** Every site this machine can deploy to, with a repository naming it and how its target is made. */
interface Site {
  site: DemoSite;
  repo: string;
  opts: SiteOptions;
}
const sites = new Map<string, Site>();
const canvases = JSON.parse(readFileSync(join(home, 'canvases.json'), 'utf8')) as { repos: { path: string }[] }[];
for (const repo of canvases.flatMap((c) => c.repos.map((r) => expandHome(r.path)))) {
  if (!existsSync(repo)) continue;
  const settings = (await readShared(repo)).settings;
  const site = settings?.demo?.site;
  if (!site || siteMissing(home, site) || sites.has(siteBase(home, site))) continue;
  sites.set(siteBase(home, site), { site, repo, opts: settings.demo?.language ? { language: settings.demo.language } : {} });
}
const personal = readPersonal(home);
if (personal) {
  const site = personalDemoSite(personal);
  const repo = canvases[0]?.repos[0]?.path;
  if (repo && !siteMissing(home, site) && !sites.has(siteBase(home, site))) sites.set(siteBase(home, site), { site, repo: expandHome(repo), opts: personal.secret ? { unlisted: { secret: personal.secret } } : {} });
}

// the pages this Obeya shared, by address, and every directory a card names for its demos' files
const db = new Database(join(home, 'obeya.db'), { readonly: true });
const rows = db.query<{ demo: string | null; demos: string | null; share: string | null }, []>('SELECT demo, demos, share FROM cards WHERE demo IS NOT NULL OR share IS NOT NULL').all();
db.close();
const sharedUrls = new Set<string>();
const demoDirs = new Set<string>();
const dirsIn = (v: unknown): void => {
  if (Array.isArray(v)) v.forEach(dirsIn);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'dir' || k === 'kept') && typeof x === 'string' && x.startsWith('/')) demoDirs.add(x);
      else dirsIn(x);
    }
};
for (const r of rows) {
  for (const json of [r.demo, r.demos, r.share]) if (json) dirsIn(JSON.parse(json));
  const url = r.share ? (JSON.parse(r.share) as { url?: string }).url : undefined;
  if (url) sharedUrls.add(url);
}
/** The cards' copies of a video by its size: a page's video is a byte-for-byte copy of its card's. */
const bySize = new Map<number, string[]>();
for (const d of demoDirs) {
  const f = join(d, 'demo.mp4');
  if (!existsSync(f)) continue;
  const size = statSync(f).size;
  bySize.set(size, [...(bySize.get(size) ?? []), f]);
}

for (const { site, repo, opts } of sites.values()) {
  const base = siteBase(home, site);
  const dir = join(base, 'site');
  const root = siteRoot(site);
  const shared = [...sharedUrls].filter((u) => u.startsWith(root)).map((u) => u.slice(root.length).replace(/\/+$/, ''));
  // and the pages this machine wrote whose cards are gone
  const manifest = join(dir, opts.unlisted ? `${opts.unlisted.secret}/${MANIFEST}` : MANIFEST);
  const written = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { pages: Record<string, { machine: string; withdrawn?: true }> }).pages : {};
  const mine = [...new Set([...shared, ...Object.entries(written).flatMap(([slug, e]) => (e.machine === HERE && !e.withdrawn ? [slug] : []))])];
  const max = site.maxFile ?? MAX_FILE;
  // each page's videos not in range yet: a file of the page's directory, with its version's `source`
  const todo: { slug: string; file: string; source: string }[] = [];
  for (const slug of mine) {
    let meta: Meta;
    try {
      meta = JSON.parse(readFileSync(join(dir, slug, 'meta.json'), 'utf8')) as Meta;
    } catch {
      console.log(`${slug}: not in ${dir}, left out`);
      continue;
    }
    const versions = [{ sub: '', kind: meta.kind, source: meta.source }, ...(meta.more ?? []).map((m) => ({ sub: m.dir, kind: m.kind, source: m.source }))];
    for (const v of versions) {
      const file = v.sub ? `${v.sub}/demo.mp4` : 'demo.mp4';
      if (v.kind !== 'html' && existsSync(join(dir, slug, file)) && !inTvRange(join(dir, slug, file))) todo.push({ slug, file, source: v.source });
    }
  }
  const others = Object.entries(written).filter(([, e]) => e.machine !== HERE && !e.withdrawn).length;
  console.log(`${site.url}: ${mine.length} pages shared from here, ${todo.length} videos to encode${others ? `; ${others} pages from other machines left as they are` : ''}`);
  if (values['dry-run'] || !todo.length) continue;

  const staged = join(base, 'video-range');
  const target = siteTarget(site, repo, home, MESSAGES.en.share, opts);
  const pages = [...new Set(todo.map((t) => t.slug))];
  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = new Set(pages.slice(i, i + BATCH));
    const going = todo.filter((t) => batch.has(t.slug));
    const files = new Map<string, Record<string, string>>();
    for (const [n, t] of going.entries()) {
      const out = join(staged, t.slug, t.file);
      if (!existsSync(out)) {
        mkdirSync(dirname(out), { recursive: true });
        const part = `${out}.part`;
        const t0 = Date.now();
        toTvRange(join(dir, t.slug, t.file), part);
        renameSync(part, out);
        console.log(`  ${i + n + 1}/${todo.length} ${t.slug}/${t.file}: ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      if (statSync(out).size > max) {
        console.log(`  ${t.slug}/${t.file}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MiB encoded, more than the site takes; left as it was`);
        continue;
      }
      files.set(t.slug, { ...files.get(t.slug), [t.file]: out });
    }
    if (!files.size) continue;
    // the card's copies of each video, found before the page's video changes
    const copies = new Map<string, string[]>();
    for (const t of going) {
      if (!files.get(t.slug)?.[t.file]) continue;
      const mine: string[] = [];
      for (const f of bySize.get(statSync(join(dir, t.slug, t.file)).size) ?? []) if ((await sourceOf(f)) === t.source) mine.push(f);
      copies.set(`${t.slug}/${t.file}`, mine);
    }
    const r = await target.replace(
      [...files].map(([slug, f]) => ({ slug, files: f })),
      shared,
      (text) => console.log(`  ${text}`),
    );
    if (r.why) fail(`${site.url}: ${r.why}${r.said ? `\n${r.said}` : ''}`);
    console.log(`  ${files.size} pages out${r.said ? `: ${r.said.split('\n').at(-1)}` : ''}`);
    for (const [key, list] of copies) {
      const from = join(staged, key);
      for (const f of list) {
        const part = join(dirname(f), `.range-${process.pid}.mp4`);
        copyFileSync(from, part);
        renameSync(part, f);
        console.log(`  ${key}: the card's copy ${f}`);
      }
      rmSync(from, { force: true });
    }
  }
  rmSync(staged, { recursive: true, force: true });
}
