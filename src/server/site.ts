// A static site Obeya keeps itself, for a repository whose adapter names one (`demo.site`): the
// share target for hosts that take a directory and serve it as it is.
//
// The site lives under Obeya's home in `sites/<key>/`, the key made of its URL's host and path, so
// every clone and repository naming the same site shares one directory (and the one queue all
// shares go through, `serial` in share.ts). Its `site/` is what is deployed: one directory per page
// with the demo's files, its `index.html` and a `meta.json`, plus the overview at the root. A host
// deployment is a full snapshot of that directory, so each publish or withdrawal changes it and runs
// the deploy line on the whole of it (`{dir}` in the line stands for it), with the `KEY=value` lines
// of the site's env file added to its environment. A deploy that fails puts the page back as it was
// (it is set aside in `backup/` meanwhile); a directory lacking pages Obeya has as shared is not
// deployed, since the deployment would take them offline.
//
// Several machines may publish to one site, so each change pulls before it pushes: the site's
// manifest (`obeya-site.json`: every page with its files, a revision and the machine; tombstones
// for withdrawn pages) is read first, pages missing here or newer there are downloaded, pages
// withdrawn there removed; it is read again right before the deploy and after it, and a change
// another machine's deployment came in between with is made once more. A deployment that lands
// later still takes pages offline: `audit` finds the pages shared from here that the live site
// lacks, and `repair` deploys them again. A manifest that cannot be read refuses the deploy (a site
// with nothing at its URL is the first one). A host may answer every missing file with a page of its
// own (Cloudflare Pages serves the overview): a manifest answered that way is missing, not unreadable.
//
// The pages come from Obeya's own templates (`demo-page.ts`), each in its demo's language, the
// overview in the site's. A call writes only its own page and the overview: a page shared earlier
// keeps the template it was written with until it is published again (`version` says when that
// would make a difference). A page published again with the same video, or the same artifact
// files, keeps its date, so the overview keeps its order when pages are brought up to date or get
// their pull request's link. What counts is the demo's own files (`source` in meta.json), not the
// copies on the site, which carry the script Obeya adds to an artifact.
//
// A host may serve no byte ranges (Cloudflare Pages does not): the video page then loads the video
// whole, so a browser can seek in it (`demo-page.ts`).

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DemoSite } from '../adapters/types';
import type { Messages } from '../core/messages';
import { readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { ARTIFACT_DIR, artifactFiles, artifactPageHtml, day, demoPageHtml, esc, PAGE_STYLE, PAGE_WORDS, type PageLanguage, withHeightReport } from './demo-page';
import { BUN_ENV } from './resources';
import { COMMAND_TIMEOUT, SHARE_CWD, type SharePage, type ShareTarget, scriptArgv, tail, type Versions } from './share';

/** Where the sites live under Obeya's home. */
export const SITES_DIR = 'sites';
/** The largest file a site takes without `maxFile` (Cloudflare Pages' limit). */
export const MAX_FILE = 25 * 1024 * 1024;
const VIDEO_FILES = ['demo.mp4', 'poster.jpg', 'captions.vtt'];

/** What a page's directory on the site keeps besides its files, for the overview: the format of the share command sites were kept with before. */
interface Meta {
  /** Absent on video pages. */
  kind?: 'html';
  title: string;
  text: string;
  chapters: [number, string][];
  pr: string | null;
  /** When it was first shared, and when its video or artifact last changed (the date the page and the overview show). */
  first: string;
  at: string;
  /** A hash of the video or the artifact's files as the demo has them. */
  source: string;
  /** The page's language; absent on pages written before sites knew it. */
  language?: PageLanguage;
}

/** The site's directory name: its URL's host and path. */
export function siteKey(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The site's directory under Obeya's home: `site/` is deployed, `backup/` holds a page set aside while a deploy runs. */
export const siteBase = (home: string, site: DemoSite) => join(home, SITES_DIR, siteKey(site.url));

/** The page's URL on the site. */
export const pageUrl = (site: DemoSite, slug: string) => `${site.url.replace(/\/+$/, '')}/${slug}/`;

/** The site's host and path, as the owner reads it. */
export const siteName = (site: DemoSite) => site.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** The env file the site names, as a path; null when it names none. */
const envPath = (home: string, site: DemoSite) => (site.env ? (isAbsolute(site.env) ? site.env : resolve(home, site.env)) : null);

/** The env file the site needs on this machine and lacks, as the adapter names it; null when it has it, or needs none. */
export function siteMissing(home: string, site: DemoSite): string | null {
  const file = envPath(home, site);
  return file && !existsSync(file) ? site.env! : null;
}

/** `KEY=value` lines; blank lines, comments and a leading `export` are allowed, a value may be quoted. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const v = m[2]!;
    env[m[1]!] = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return env;
}

class Refused extends Error {}

/** The site's manifest, at its root: every page with its files, and the pages withdrawn. */
export const MANIFEST = 'obeya-site.json';

/** A page in the manifest, or a withdrawn one (a tombstone). Only the machine whose card it is changes a page, so its revision counts up. */
interface Entry {
  rev: number;
  /** Which machine wrote this revision (its host name). */
  machine: string;
  /** When: written, or withdrawn. */
  at: string;
  withdrawn?: true;
  meta?: Meta;
  /** Every file of the page's directory, its path relative to it. */
  files?: Record<string, { size: number; hash: string }>;
}

interface Manifest {
  /** Names the deployment that carried it, so the check after a deploy tells its own from another machine's. */
  deploy: string;
  machine: string;
  at: string;
  pages: Record<string, Entry>;
}

/** The live site: its manifest; none for a site not deployed yet, or deployed before sites had one (with the pages its overview links). */
interface Live {
  deploy: string | null;
  pages: Record<string, Entry>;
  linked: string[];
}

/** A page this Obeya may have as shared that another machine withdrew. */
export interface Gone {
  slug: string;
  machine: string;
}

export interface SiteOptions {
  /** This machine's name in the manifest; the host name (without its domain) without it. */
  machine?: string;
  /** How long to wait (ms) before each look at the live site after a deploy, until it shows the deployment. */
  checkWaits?: number[];
}

/** About 30 s for a deployment to show: a host or its CDN may serve the earlier one for a moment. */
const CHECK_WAITS = [0, 1000, 2000, 4000, 8000, 15000];
/** Reading the manifest takes a moment; a file of a page (at most the site's limit) a few minutes on a slow line. */
const FETCH_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 5 * 60_000;

/** The site as a share target, keyed by its directory, so every repository naming it shares its pages' version and guard. */
export function siteTarget(site: DemoSite, repo: string, home: string, t: Messages['share'], opts: SiteOptions = {}): ShareTarget {
  const base = siteBase(home, site);
  const dir = join(base, 'site');
  const machine = opts.machine ?? hostname().split('.')[0]!;
  const overviewLanguage = (): PageLanguage => site.language ?? readDemoSettings(home).language;
  const root = site.url.replace(/\/+$/, '');

  /** The site lives only in its directory: one that lost pages Obeya has as shared would drop them with the next deployment. */
  const checkSite = (shared: string[], self: string, live: Live) => {
    const missing = shared.filter((s) => s !== self && !existsSync(join(dir, s, 'meta.json')));
    if (missing.length) throw new Refused(t.siteLacks(dir, missing));
    const before = live.linked.filter((s) => s !== self && !existsSync(join(dir, s, 'meta.json')));
    if (before.length) throw new Refused(t.siteBefore(before));
  };

  const deployEnv = (): Record<string, string> => {
    const file = envPath(home, site);
    if (!file) return {};
    if (!existsSync(file)) throw new Refused(t.envMissing(file));
    return parseEnv(readFileSync(file, 'utf8'));
  };

  /** The headers for reading the live site, `${KEY}` taken from the env file (else Obeya's environment). */
  const headers = (env: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(site.headers ?? {}).map(([name, value]) => [
        name,
        value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
          const v = env[key] ?? process.env[key];
          if (v === undefined) throw new Refused(t.headerKey(key, name));
          return v;
        }),
      ]),
    );

  const get = (path: string, env: Record<string, string>, timeout = FETCH_TIMEOUT) =>
    fetch(`${root}/${path}`, { headers: { ...headers(env), 'Cache-Control': 'no-cache' }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });

  /** The live site's manifest; refused when it cannot be read, since deploying blind could take other machines' pages offline. */
  const readLive = async (env: Record<string, string>): Promise<Live> => {
    const at = `${root}/${MANIFEST}`;
    const unreadable = (why: string) => new Refused(t.manifestUnreadable(at, why));
    const answer = async (path: string) => {
      try {
        return await get(path, env);
      } catch (e) {
        if (e instanceof Refused) throw e;
        throw unreadable(e instanceof Error ? e.message : String(e));
      }
    };
    const status = (r: Response) => (r.status >= 300 && r.status < 400 ? t.loginWall(r.status) : `HTTP ${r.status}`);
    const r = await answer(`${MANIFEST}?at=${Date.now()}`);
    if (r.ok) {
      const body = await r.text();
      const m = manifestOf(body);
      if (m) return { deploy: m.deploy ?? null, pages: m.pages, linked: [] };
      // a host may answer a missing file with a page of its own (Cloudflare Pages serves the
      // overview for a site without a 404.html): the manifest is missing when a file that cannot
      // be there gets the same answer
      const missing = await answer(`${MANIFEST}.${randomUUID()}`);
      if (!missing.ok || (await missing.text()) !== body) throw unreadable(t.notManifest);
    } else if (r.status !== 404) throw unreadable(status(r));
    // no manifest: a site not deployed yet (nothing there at all), or one deployed before sites had one
    const page = await answer('');
    if (page.status === 404) return { deploy: null, pages: {}, linked: [] };
    if (!page.ok) throw unreadable(status(page));
    const linked = [...new Set([...(await page.text()).matchAll(/href="([a-z0-9][a-z0-9-]{0,80})\/"/g)].map((m) => m[1]!))];
    return { deploy: null, pages: {}, linked };
  };

  /** The manifest in a file the live site served; null when it is none. */
  const manifestOf = (text: string): Manifest | null => {
    try {
      const m = JSON.parse(text) as Manifest | null;
      return m && typeof m.pages === 'object' && m.pages ? m : null;
    } catch {
      return null;
    }
  };

  /** The manifest of this directory: as written with the last change, plus pages kept before it (by the command sites were kept with before). */
  const readLocal = (): Manifest => {
    const file = join(dir, MANIFEST);
    const m: Manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { deploy: '', machine, at: '', pages: {} };
    for (const slug of pageDirs())
      if (!m.pages[slug] || m.pages[slug].withdrawn) m.pages[slug] = { ...entryOf(slug), rev: (m.pages[slug]?.rev ?? 0) + 1, machine };
    return m;
  };

  /** Writes the manifest for the next deployment, under a name of its own; returns it. Pages whose directory is not there are left out. */
  const writeLocal = (m: Manifest): string => {
    const deploy = randomUUID();
    const pages = Object.fromEntries(Object.entries(m.pages).filter(([slug, e]) => e.withdrawn || existsSync(join(dir, slug, 'meta.json'))));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ deploy, machine, at: new Date().toISOString(), pages } satisfies Manifest, null, 1));
    return deploy;
  };

  const pageDirs = () => (existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'meta.json'))) : []);

  /** A page of the directory as the manifest lists it. */
  const entryOf = (slug: string): Entry => {
    const files: Entry['files'] = {};
    for (const f of filesUnder(join(dir, slug))) {
      const bytes = readFileSync(join(dir, slug, f));
      files[f] = { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') };
    }
    const meta = JSON.parse(readFileSync(join(dir, slug, 'meta.json'), 'utf8')) as Meta;
    return { rev: 1, machine, at: new Date().toISOString(), meta, files };
  };

  /** Whether the directory holds the page's files the manifest lists, by their sizes. */
  const holds = (slug: string, e: Entry) =>
    Object.entries(e.files ?? {}).every(([f, { size }]) => existsSync(join(dir, slug, f)) && statSync(join(dir, slug, f)).size === size);

  /**
   * Pull: brings the directory up to the live site. Pages missing here or newer there are
   * downloaded, pages withdrawn there are removed here; pages the live site lacks stay (this
   * machine's not deployed yet, or lost to a deploy that came in between). Returns the pages
   * withdrawn there by another machine that this directory had.
   */
  const pull = async (local: Manifest, live: Live, env: Record<string, string>, log: (text: string) => void): Promise<Gone[]> => {
    const gone: Gone[] = [];
    const fetchList: [string, Entry][] = [];
    for (const [slug, e] of Object.entries(live.pages)) {
      if (!isSlug(slug)) continue;
      const mine = local.pages[slug];
      if (e.withdrawn) {
        if (mine && mine.rev >= e.rev) continue;
        if (mine && !mine.withdrawn) gone.push({ slug, machine: e.machine });
        rmSync(join(dir, slug), { recursive: true, force: true });
        local.pages[slug] = e;
      } else if (!mine || mine.rev < e.rev || (mine.rev === e.rev && !holds(slug, e))) fetchList.push([slug, e]);
    }
    if (fetchList.length) {
      const bytes = fetchList.reduce((n, [, e]) => n + Object.values(e.files ?? {}).reduce((m, f) => m + f.size, 0), 0);
      log(t.pulling(fetchList.length, (bytes / 1024 / 1024).toFixed(1)));
    }
    let done = 0;
    for (const [slug, e] of fetchList) {
      const into = join(base, 'incoming', slug);
      rmSync(into, { recursive: true, force: true });
      for (const [f, want] of Object.entries(e.files ?? {})) {
        const name = `${slug}/${f}`;
        if (!isPath(f)) throw new Refused(t.downloadBad(name));
        const to = join(into, f);
        mkdirSync(dirname(to), { recursive: true });
        const have = join(dir, slug, f);
        if (existsSync(have) && statSync(have).size === want.size && hashOf(readFileSync(have)) === want.hash) {
          copyFileSync(have, to);
          continue;
        }
        // read whole (a file is at most the site's limit), so the timeout covers the body too
        let bytes: Uint8Array;
        try {
          const r = await get(`${slug}/${f.split('/').map(encodeURIComponent).join('/')}`, env, DOWNLOAD_TIMEOUT);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          bytes = new Uint8Array(await r.arrayBuffer());
        } catch (err) {
          throw new Refused(t.downloadFailed(name, err instanceof Error ? err.message : String(err)));
        }
        if (bytes.length !== want.size || hashOf(bytes) !== want.hash) throw new Refused(t.downloadBad(name));
        writeFileSync(to, bytes);
      }
      rmSync(join(dir, slug), { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      mkdirSync(into, { recursive: true });
      renameSync(into, join(dir, slug));
      local.pages[slug] = e;
      if (++done % 25 === 0 && done < fetchList.length) log(t.pulled(done, fetchList.length));
    }
    return gone;
  };

  /**
   * After a deploy: whether the live site shows the change (each page at its revision, or its
   * withdrawal), waiting while it still serves the deployment from before. False when another
   * machine's deployment came in between without it; null when the site never showed the new one.
   */
  const check = async (expect: [string, number][], mine: string, before: string | null, env: Record<string, string>): Promise<boolean | null> => {
    for (const wait of opts.checkWaits ?? CHECK_WAITS) {
      await Bun.sleep(wait);
      let live: Live;
      try {
        live = await readLive(env);
      } catch {
        continue;
      }
      if (live.deploy === mine || expect.every(([slug, rev]) => (live.pages[slug]?.rev ?? 0) >= rev)) return true;
      if (live.deploy !== before) return false;
    }
    return null;
  };

  /** Writes the overview from the pages in the directory. */
  const writeOverview = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), overviewHtml(site, readPages(dir), overviewLanguage()));
  };

  /** Runs the deploy line on the directory; what it said, for the card's log. */
  const deploy = async (env: Record<string, string>): Promise<string> => {
    mkdirSync(dir, { recursive: true });
    const argv = scriptArgv(
      site.deploy.map((a) => a.replaceAll('{dir}', dir)),
      repo,
    );
    const cwd = join(home, SHARE_CWD);
    mkdirSync(cwd, { recursive: true });
    let out: string;
    let code: number;
    try {
      const p = Bun.spawn(argv, {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...(argv[0] === process.execPath ? BUN_ENV : {}), OBEYA_HOME: home, OBEYA_REPO: repo, ...env },
        timeout: COMMAND_TIMEOUT,
      });
      const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      out = `${o}\n${e}`.trim();
      code = c;
    } catch (e) {
      out = e instanceof Error ? e.message : String(e);
      code = -1;
    }
    if (code !== 0) throw new Refused(t.deployFailed(code), { cause: out });
    return out ? tail(out) : '';
  };

  /**
   * One change of the site, made safe for several machines: pull, change the page (`apply` writes
   * its directory, or removes it, and returns its entry), deploy the whole directory, check the
   * live site shows it. Without a page (`slug` null) the round deploys the directory as it is, for
   * the pages this machine has as shared that the live site lacks, and checks those. A change
   * another machine's deployment came in between with (seen before the deploy, or after it without
   * the change) is undone here and made once more; a failed deploy is undone too. The page's
   * directory is set aside meanwhile in `backup/`.
   */
  const change = async (
    slug: string | null,
    shared: string[],
    apply: ((rev: number, before: Entry | undefined) => Entry) | null,
    log: (text: string) => void,
    gone: Gone[],
  ): Promise<string> => {
    const env = deployEnv();
    for (let round = 1; ; round++) {
      const live = await readLive(env);
      const local = readLocal();
      const lost = await pull(local, live, env, log);
      gone.push(...lost.filter((g) => g.slug !== slug));
      const away = new Set(gone.map((g) => g.slug));
      const kept = shared.filter((s) => !away.has(s));
      checkSite(kept, slug ?? '', live);
      const before = slug ? local.pages[slug] : undefined;
      const rev = slug ? Math.max(before?.rev ?? 0, live.pages[slug]?.rev ?? 0) + 1 : 0;
      const backup = slug ? setAside(slug) : null;
      const undo = () => {
        if (!slug) return;
        rmSync(join(dir, slug), { recursive: true, force: true });
        if (backup) renameSync(backup, join(dir, slug));
        if (before) local.pages[slug] = before;
        else delete local.pages[slug];
        writeLocal(local);
        writeOverview();
      };
      let said = '';
      let seen: boolean | null;
      try {
        if (slug && apply) local.pages[slug] = apply(rev, before);
        const expect: [string, number][] = slug
          ? [[slug, rev]]
          : kept.flatMap((s) => (local.pages[s] && !local.pages[s]!.withdrawn ? [[s, local.pages[s]!.rev] as [string, number]] : []));
        const id = writeLocal(local);
        writeOverview();
        // another machine deployed since the pull: its deployment would be lost, so pull again
        const now = await readLive(env);
        if (now.deploy !== live.deploy) seen = false;
        else {
          said = await deploy(env);
          seen = await check(expect, id, live.deploy, env);
        }
      } catch (e) {
        undo();
        throw e;
      }
      if (seen === false) {
        undo();
        if (round === 2) throw new Refused(t.lostTwice, { cause: said });
        log(t.cameBetween);
        continue;
      }
      if (backup) rmSync(backup, { recursive: true, force: true });
      return [said, seen === null ? t.notSeenYet : ''].filter(Boolean).join('\n');
    }
  };

  /** Moves a page's directory out of the site, so a change can be undone. */
  const setAside = (slug: string): string | null => {
    if (!existsSync(join(dir, slug))) return null;
    const backup = join(base, 'backup', `${slug}-${Date.now()}`);
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(join(dir, slug), backup);
    return backup;
  };

  /** Runs a change of the site, its reason in Obeya's words where it was refused, with the pages another machine withdrew. */
  const attempt = async <T>(fn: (gone: Gone[]) => Promise<T>): Promise<(T | { why: string; said: string }) & { gone: Gone[] }> => {
    const gone: Gone[] = [];
    try {
      return { ...(await fn(gone)), gone };
    } catch (e) {
      if (e instanceof Refused) return { why: e.message, said: typeof e.cause === 'string' ? tail(e.cause) : '', gone };
      return { why: e instanceof Error ? e.message : String(e), said: '', gone };
    }
  };

  return {
    key: `site:${siteKey(site.url)}`,
    repo,
    publish: (p: SharePage, log = () => {}) =>
      attempt(async (gone) => {
        const slug = checkSlug(p.slug);
        if (!p.title?.trim() || !p.text?.trim() || !p.dir) throw new Refused(t.pageIncomplete);
        const html = p.kind === 'html';
        const files = html ? artifactFiles(p.dir) : VIDEO_FILES.filter((f) => existsSync(join(p.dir, f)));
        for (const f of html ? ['index.html'] : ['demo.mp4', 'captions.vtt']) if (!files.includes(f)) throw new Refused(t.fileMissing(f, p.dir));
        const max = site.maxFile ?? MAX_FILE;
        for (const f of files) {
          const size = statSync(join(p.dir, f)).size;
          if (size > max) throw new Refused(t.fileTooLarge(f, (size / 1024 / 1024).toFixed(1), String(Math.round((max / 1024 / 1024) * 10) / 10)));
        }
        const target = join(dir, slug);
        const said = await change(
          slug,
          p.shared ?? [],
          (rev, entry) => {
            const before = entry?.withdrawn ? null : entry?.meta;
            mkdirSync(target, { recursive: true });
            const into = html ? join(target, ARTIFACT_DIR) : target;
            for (const f of files) {
              mkdirSync(dirname(join(into, f)), { recursive: true });
              copyFileSync(join(p.dir, f), join(into, f));
            }
            // the artifact tells the page around it its height, so the frame grows to it
            if (html) writeFileSync(join(into, 'index.html'), withHeightReport(readFileSync(join(p.dir, 'index.html'), 'utf8')));
            const now = new Date().toISOString();
            const source = sourceHash(p.dir, html ? files : ['demo.mp4']);
            const meta: Meta = {
              ...(html ? { kind: 'html' as const } : {}),
              title: p.title.trim(),
              text: p.text.trim(),
              chapters: html ? [] : (p.chapters ?? []),
              pr: p.pr ?? null,
              first: before?.first ?? now,
              at: before?.source === source ? before.at : now,
              source,
              language: p.language,
            };
            writeFileSync(join(target, 'meta.json'), JSON.stringify(meta, null, 2));
            writeFileSync(join(target, 'index.html'), pageHtml(site, meta, existsSync(join(target, 'poster.jpg'))));
            return { ...entryOf(slug), rev };
          },
          log,
          gone,
        );
        return { url: pageUrl(site, slug), said };
      }),
    withdraw: async (slugArg, shared, log = () => {}) => {
      const r = await attempt(async (gone) => {
        const slug = checkSlug(slugArg);
        const said = await change(slug, shared, (rev) => ({ rev, machine, at: new Date().toISOString(), withdrawn: true }), log, gone);
        return { said };
      });
      return 'why' in r ? { ...r, why: t.notWithdrawn(r.why) } : r;
    },
    version: async () => siteVersions(site),
    audit: async (shared) => {
      try {
        const live = await readLive(deployEnv());
        const local = readLocal();
        const gone = Object.entries(live.pages).flatMap(([slug, e]) => {
          const mine = local.pages[slug];
          return e.withdrawn && mine && !mine.withdrawn && mine.rev < e.rev ? [{ slug, machine: e.machine }] : [];
        });
        // shared from here, and not on the live site as written here: another machine's deployment took it offline
        const missing = shared.filter((slug) => {
          const mine = local.pages[slug];
          return mine && !mine.withdrawn && (live.pages[slug]?.rev ?? 0) < mine.rev;
        });
        return { gone, missing };
      } catch {
        return { gone: [], missing: [] };
      }
    },
    repair: async (shared, log = () => {}) => attempt(async (gone) => ({ said: await change(null, shared, null, log, gone) })),
  };
}

const isSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug);
/** A path inside a page's directory. */
const isPath = (f: string) => f.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\\'));
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The files under a directory, their paths relative to it with `/`. */
function filesUnder(root: string, at = ''): string[] {
  return readdirSync(join(root, at), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? filesUnder(root, at ? `${at}/${d.name}` : d.name) : d.isFile() ? [at ? `${at}/${d.name}` : d.name] : []))
    .sort();
}

function checkSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) throw new Refused(`not a slug: ${String(slug)}`);
  return slug;
}

/** A hash of the files (relative to `dir`) with their names. */
function sourceHash(dir: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    const bytes = readFileSync(join(dir, f));
    h.update(`${f}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

/**
 * The versions of the pages the site gets now: a hash of a sample page in each language, with
 * everything a page can have, the video pages', then the artifact pages'. Only a change that shows
 * on the pages gives a new one: of Obeya's templates, or of the site's title (in the tab titles).
 */
export function siteVersions(site: DemoSite): Versions {
  const at = '2026-01-15T12:00:00.000Z';
  const sample: Meta = {
    title: 'Title',
    text: 'A sentence.\n\nAnother one.',
    chapters: [
      [0, 'Before'],
      [12.5, 'After'],
    ],
    pr: 'https://github.com/o/r/pull/1',
    first: at,
    at,
    source: '',
  };
  const hash = (pages: string[]) => createHash('sha256').update(pages.join('\0')).digest('hex').slice(0, 12);
  const languages: PageLanguage[] = ['de', 'en'];
  const video = hash(languages.map((language) => pageHtml(site, { ...sample, language }, true)));
  const html = hash(languages.map((language) => pageHtml(site, { ...sample, kind: 'html', chapters: [], language }, false) + withHeightReport('<body></body>')));
  return { video, html };
}

/** A page of the site, in its language (German for pages from before sites knew it). */
function pageHtml(site: DemoSite, m: Meta, poster: boolean): string {
  const language = m.language ?? 'de';
  const w = PAGE_WORDS[language];
  const parts = {
    title: m.title,
    text: m.text,
    pr: m.pr,
    when: w.sharedOn(day(m.at, language)),
    tabTitle: `${m.title} · ${site.title}`,
    language,
    top: { href: '../', text: w.allDemos },
  };
  if (m.kind === 'html') return artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` } });
  return demoPageHtml({
    ...parts,
    chapters: m.chapters,
    video: { src: 'demo.mp4' },
    ...(poster ? { poster: 'poster.jpg' } : {}),
    captions: { src: 'captions.vtt' },
  });
}

/** The pages in the site's directory, the most recently shared first. */
function readPages(dir: string): (Meta & { slug: string })[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'meta.json')))
    .map((slug) => ({ slug, ...(JSON.parse(readFileSync(join(dir, slug, 'meta.json'), 'utf8')) as Meta) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Every page on the site, the most recently shared first, in the site's language. */
function overviewHtml(site: DemoSite, pages: (Meta & { slug: string })[], language: PageLanguage): string {
  const w = PAGE_WORDS[language];
  const first = (t: string) => (t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t).slice(0, 240);
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.title)}</title><style>${PAGE_STYLE}</style></head>
<body><main>
<h1>${esc(site.title)}</h1>
<div class="when">${esc(w.overview)}</div>
${
  pages.length
    ? `<ul class="demos">${pages.map((d) => `<li><a href="${d.slug}/"><b>${esc(d.title)}</b><span>${day(d.at, language)} · ${esc(first(d.text))}</span></a></li>`).join('\n')}</ul>`
    : `<p>${esc(w.noDemos)}</p>`
}
</main></body></html>
`;
}
