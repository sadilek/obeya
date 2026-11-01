// A static site Obeya keeps itself, for a repository whose settings name one (`demo.site`): the
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
// keeps the template it was written with until it is published again (the page changes since,
// page-changes.ts, say what that would bring). A page published again with the same video, or the same artifact
// files, keeps its date, so the overview keeps its order when pages are brought up to date or get
// their pull request's link. What counts is the demo's own files (`source` in meta.json), not the
// copies on the site, which carry what Obeya adds to an artifact (artifact-copy.ts).
//
// A host may serve no byte ranges (Cloudflare Pages does not): the video page then loads the video
// whole, so a browser can seek in it (`demo-page.ts`).
//
// A host that reads a `_headers` file (Cloudflare Pages, Netlify) sends an artifact's files with the
// headers that keep it from the internet beyond what its CSP covers (`artifactHeaders`).
//
// The owner's personal site (personal-site.ts) is unlisted (`unlisted`): a page lies at
// `<token>/<slug>/`, the token drawn per card; the manifest lies in a secret directory; the root and
// the answer to a missing address are blank; there is no feed; pages and headers keep search engines
// out and send no referrer.

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { DemoSite } from '../adapters/types';
import type { Messages } from '../core/messages';
import { dimensions } from '../core/page-tags';
import type { PageTags } from '../core/types';
import { readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { ARTIFACT_DIR, artifactFiles, artifactPageHtml, type CaptionTrack, captionTracks, credit, day, demoPageHtml, esc, OBEYA_URL, PAGE_STYLE, type PageCommit, paragraphs, PAGE_WORDS, type PageLanguage, silentVideo, type StackedDemo, stackedPageHtml } from './demo-page';
import { artifactCopy } from './artifact-copy';
import { pagePolicy, sealed, withHeightReport } from '../core/frame';
import { demoFiles, OWN_CONNECTIONS } from './demo';
import { BUN_ENV } from './resources';
import { spawnOutput } from './spawn';
import { HERE } from './workspaces';
import { BLANK_PAGE, GITHUB_PAGES, githubPagesDeploy } from './site-hosts';
import { COMMAND_TIMEOUT, commandWords, SHARE_CWD, type SharePage, type ShareTarget, scriptArgv, tail } from './share';
import { messageOf } from '../core/text';

/** Where the sites live under Obeya's home. */
export const SITES_DIR = 'sites';
/** The largest file a site takes without `maxFile` (Cloudflare Pages' limit). */
export const MAX_FILE = 25 * 1024 * 1024;

/** What a page's directory on the site keeps besides its files, for the overview. */
interface Meta {
  /** Absent on video pages. */
  kind?: 'html';
  title: string;
  text: string;
  chapters: [number, string][];
  pr: string | null;
  /** Without a pull request: where the work landed on the default branch; absent before it did, and on pages from before (until 2026-10-30). */
  commit?: PageCommit;
  /** When it was first shared, and when its video or artifact last changed (the date the page and the overview show). */
  first: string;
  at: string;
  /** A hash of the video or the artifact's files as the demo has them. */
  source: string;
  language: PageLanguage;
  /** Who shared it: git's name (`user.name`) in the repository of the Obeya that published it; absent on pages from before (until 2026-10-20) or where git has none. */
  by?: string;
  /** The later demo versions on the page, in order of handover, each in a directory of the page's (`dir`). */
  more?: MoreMeta[];
  /** The page's tags from the site's vocabulary (`demo.site.tags`), by dimension; absent on pages without. */
  tags?: PageTags;
}

/** A later demo version on a page: what its section shows, and when it was handed over (`handed`, its heading). */
interface MoreMeta {
  kind?: 'html';
  title: string;
  text: string;
  chapters: [number, string][];
  dir: string;
  handed: string;
  at: string;
  source: string;
}

/** When the page's newest version last changed: the date the overview shows it with. */
const newest = (m: Meta) => [m.at, ...(m.more ?? []).map((x) => x.at)].sort().at(-1)!;

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
const envPath = (home: string, site: DemoSite) => {
  if (!site.env) return null;
  const file = resolve(home, site.env);
  // under the home alone (the settings' check says so): what is in it goes to the site's URL
  if (!file.startsWith(resolve(home) + sep)) throw new Refused(`the site's env file ${site.env} is not under Obeya's home`);
  return file;
};

/** The env file the site needs on this machine and lacks, as the settings name it; null when it has it, or needs none. */
export function siteMissing(home: string, site: DemoSite): string | null {
  let file: string | null;
  try {
    file = envPath(home, site);
  } catch {
    return site.env!;
  }
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

/** The live site: its manifest; none for a site not deployed yet. */
interface Live {
  deploy: string | null;
  pages: Record<string, Entry>;
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
  /** The overview's words: the language the repository names for its demos (`demo.language`); without it the narration language of the demo settings. */
  language?: PageLanguage;
  /** Who the pages published from here say shared them; git's name (`user.name`) in the repository without it. */
  by?: string;
  /**
   * An unlisted site (the owner's personal one): each page under a random part of its address
   * (`<token>/<slug>`), the manifest under a secret directory, no overview and no feed, nothing
   * for search engines, no referrer for the links leaving it.
   */
  unlisted?: { secret: string };
}

/** git's name in the repository (its own `user.name`, else the global one); undefined where it has none. */
function gitName(repo: string): string | undefined {
  try {
    const r = Bun.spawnSync(['git', '-C', repo, 'config', '--get', 'user.name'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** About 30 s for a deployment to show: a host or its CDN may serve the earlier one for a moment. */
const CHECK_WAITS = [0, 1000, 2000, 4000, 8000, 15000];
/** About two minutes on GitHub Pages, whose build takes a minute or so after the push. */
const PAGES_CHECK_WAITS = [0, 5000, 10000, 15000, 20000, 30000, 40000];
/** Reading the manifest takes a moment; a file of a page (at most the site's limit) a few minutes on a slow line. */
const FETCH_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 5 * 60_000;

/** The site as a share target, keyed by its directory, so every repository naming it shares its pages' version and guard. */
export function siteTarget(site: DemoSite, repo: string, home: string, t: Messages['share'], opts: SiteOptions = {}): ShareTarget {
  const base = siteBase(home, site);
  const dir = join(base, 'site');
  const machine = opts.machine ?? HERE;
  const overviewLanguage = (): PageLanguage => opts.language ?? readDemoSettings(home).language;
  const root = site.url.replace(/\/+$/, '');
  const unlisted = !!opts.unlisted;
  /** Where the manifest is on the site: at its root, or in the unlisted site's secret directory. */
  const manifestAt = opts.unlisted ? `${opts.unlisted.secret}/${MANIFEST}` : MANIFEST;

  /** The site lives only in its directory: one that lost pages Obeya has as shared would drop them with the next deployment. */
  const checkSite = (shared: string[], self: string) => {
    const missing = shared.filter((s) => s !== self && !existsSync(join(dir, s, 'meta.json')));
    if (missing.length) throw new Refused(t.siteLacks(dir, missing));
  };

  const deployEnv = (): Record<string, string> => {
    const file = envPath(home, site);
    if (!file) return {};
    if (!existsSync(file)) throw new Refused(t.envMissing(file));
    return parseEnv(readFileSync(file, 'utf8'));
  };

  /** The headers for reading the live site, `${KEY}` taken from the env file (not Obeya's environment, whose secrets the settings may not send anywhere). */
  const headers = (env: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(site.headers ?? {}).map(([name, value]) => [
        name,
        value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
          const v = env[key];
          if (v === undefined) throw new Refused(t.headerKey(key, name));
          return v;
        }),
      ]),
    );

  /**
   * A file of the live site. A redirect within the site is followed: Cloudflare Pages answers
   * `…/index.html` with a 308 to `…/`, which made a page another machine shared impossible to pull
   * (2026-10-09). A redirect elsewhere is a login, and comes back as it is.
   */
  const get = async (path: string, env: Record<string, string>, timeout = FETCH_TIMEOUT) => {
    const signal = AbortSignal.timeout(timeout);
    let url = `${root}/${path}`;
    for (let hop = 0; ; hop++) {
      const r = await fetch(url, { headers: { ...headers(env), 'Cache-Control': 'no-cache' }, redirect: 'manual', signal });
      const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      const next = to ? new URL(to, url) : null;
      if (!next || next.origin !== new URL(url).origin || hop >= 3) return r;
      url = next.href;
    }
  };

  /** The live site's manifest; refused when it cannot be read, since deploying blind could take other machines' pages offline. */
  const readLive = async (env: Record<string, string>): Promise<Live> => {
    const at = `${root}/${manifestAt}`;
    const unreadable = (why: string) => new Refused(t.manifestUnreadable(at, why));
    const answer = async (path: string) => {
      try {
        return await get(path, env);
      } catch (e) {
        if (e instanceof Refused) throw e;
        throw unreadable(messageOf(e));
      }
    };
    const status = (r: Response) => (r.status >= 300 && r.status < 400 ? t.loginWall(r.status) : `HTTP ${r.status}`);
    const r = await answer(`${manifestAt}?at=${Date.now()}`);
    if (r.ok) {
      const body = await r.text();
      const m = manifestOf(body);
      if (m) return { deploy: m.deploy, pages: m.pages };
      // a host may answer a missing file with a page of its own (Cloudflare Pages serves the
      // overview for a site without a 404.html): the manifest is missing when a file that cannot
      // be there gets the same answer
      const missing = await answer(`${manifestAt}.${randomUUID()}`);
      if (!missing.ok || (await missing.text()) !== body) throw unreadable(t.notManifest);
    } else if (r.status !== 404) throw unreadable(status(r));
    // no manifest: a site not deployed yet
    return { deploy: null, pages: {} };
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

  /** The manifest of this directory, as written with the last change. */
  const readLocal = (): Manifest => {
    const file = join(dir, manifestAt);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { deploy: '', machine, at: '', pages: {} };
  };

  /** Writes the manifest for the next deployment, under a name of its own; returns it. Pages whose directory is not there are left out. */
  const writeLocal = (m: Manifest): string => {
    const deploy = randomUUID();
    const pages = Object.fromEntries(Object.entries(m.pages).filter(([slug, e]) => e.withdrawn || existsSync(join(dir, slug, 'meta.json'))));
    mkdirSync(dirname(join(dir, manifestAt)), { recursive: true });
    writeFileSync(join(dir, manifestAt), JSON.stringify({ deploy, machine, at: new Date().toISOString(), pages } satisfies Manifest, null, 1));
    return deploy;
  };

  /** A page of the directory as the manifest lists it. */
  const entryOf = (slug: string): Entry => {
    const files: Entry['files'] = {};
    for (const f of filesUnder(join(dir, slug))) {
      const bytes = readFileSync(join(dir, slug, f));
      files[f] = { size: bytes.length, hash: hashOf(bytes) };
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
      if (!isPage(slug, unlisted)) continue;
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
          throw new Refused(t.downloadFailed(name, messageOf(err)));
        }
        if (bytes.length !== want.size || hashOf(bytes) !== want.hash) throw new Refused(t.downloadBad(name));
        writeFileSync(to, bytes);
      }
      rmSync(join(dir, slug), { recursive: true, force: true });
      // an unlisted site's page lies a level deeper, in the random part of its address
      mkdirSync(dirname(join(dir, slug)), { recursive: true });
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
    for (const wait of opts.checkWaits ?? (commandWords(site.deploy)[0] === GITHUB_PAGES ? PAGES_CHECK_WAITS : CHECK_WAITS)) {
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

  /**
   * Writes the overview and the feed from the pages in the directory, and the headers of the
   * artifacts' files. An unlisted site has neither overview nor feed: its root and its answer to an
   * address it lacks (`404.html`) are a blank page, so neither leads to a page.
   */
  const writeOverview = () => {
    mkdirSync(dir, { recursive: true });
    if (unlisted) {
      writeFileSync(join(dir, 'index.html'), BLANK_PAGE);
      writeFileSync(join(dir, NOT_FOUND), BLANK_PAGE);
      writeFileSync(join(dir, HEADERS), unlistedHeaders() + artifactHeaders(site, true));
      rmSync(join(dir, FEED), { force: true });
      return;
    }
    const pages = readPages(dir);
    writeFileSync(join(dir, 'index.html'), overviewHtml(site, pages, overviewLanguage()));
    writeFileSync(join(dir, FEED), feedXml(site, pages, overviewLanguage()));
    writeFileSync(join(dir, HEADERS), artifactHeaders(site));
  };

  /** Runs the deploy line on the directory; what it said, for the card's log. */
  const deploy = async (env: Record<string, string>): Promise<string> => {
    mkdirSync(dir, { recursive: true });
    const words = commandWords(site.deploy).map((a) => a.replaceAll('{dir}', dir));
    // the deploy Obeya builds in for GitHub Pages
    if (words[0] === GITHUB_PAGES) {
      try {
        return tail(await githubPagesDeploy(dir, words[1] ?? '', join(base, 'git'), undefined, { private: unlisted }));
      } catch (e) {
        throw new Refused(t.deployFailed(1), { cause: messageOf(e) });
      }
    }
    const argv = scriptArgv(words, repo);
    const cwd = join(home, SHARE_CWD);
    mkdirSync(cwd, { recursive: true });
    let out: string;
    let code: number;
    try {
      const r = await spawnOutput(argv, {
        cwd,
        stdin: 'ignore',
        env: { ...process.env, ...(argv[0] === process.execPath ? BUN_ENV : {}), OBEYA_HOME: home, OBEYA_REPO: repo, ...env },
        timeout: COMMAND_TIMEOUT,
      });
      out = `${r.stdout}\n${r.stderr}`.trim();
      code = r.code;
    } catch (e) {
      out = messageOf(e);
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
      checkSite(kept, slug ?? '');
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
      return { why: messageOf(e), said: '', gone };
    }
  };

  return {
    key: `site:${siteKey(site.url)}`,
    repo,
    ...(unlisted ? { unlisted: true as const } : {}),
    publish: (p: SharePage, log = () => {}) =>
      attempt(async (gone) => {
        const slug = checkSlug(p.slug, unlisted);
        // the first version at the page's root, each later one in a directory of its own
        const parts = [{ ...p, sub: '' }, ...(p.more ?? []).map((m, i) => ({ ...m, sub: String(i + 2) }))];
        const ready = await Promise.all(
          parts.map(async (d) => {
            if (!d.title?.trim() || !d.text?.trim() || !d.dir) throw new Refused(t.pageIncomplete);
            const html = d.kind === 'html';
            const files = html ? artifactFiles(d.dir) : demoFiles(d.dir);
            for (const f of html ? ['index.html'] : ['demo.mp4', 'captions.vtt']) if (!files.includes(f)) throw new Refused(t.fileMissing(f, d.dir));
            // what the artifact loads in CORS mode goes into its copy (artifact-copy.ts)
            const copy = html ? await artifactCopy(d.dir, files, new URL(site.url).origin) : new Map<string, string>();
            const max = site.maxFile ?? MAX_FILE;
            for (const f of files) {
              const size = copy.has(f) ? Buffer.byteLength(copy.get(f)!) : statSync(join(d.dir, f)).size;
              if (size > max) throw new Refused(t.fileTooLarge(f, (size / 1024 / 1024).toFixed(1), String(Math.round((max / 1024 / 1024) * 10) / 10)));
            }
            return { d, html, files, copy };
          }),
        );
        const target = join(dir, slug);
        const said = await change(
          slug,
          p.shared ?? [],
          (rev, entry) => {
            const before = entry?.withdrawn ? null : entry?.meta;
            // a version keeps its date while its demo's own files stay the same, wherever it was on the page
            const dated = new Map<string, string>(before ? [[before.source, before.at], ...(before.more ?? []).map((m) => [m.source, m.at] as [string, string])] : []);
            const now = new Date().toISOString();
            // the one whose Obeya publishes it now; a machine whose git has no name keeps whom the page named
            const by = opts.by ?? gitName(repo) ?? before?.by;
            const written = ready.map(({ d, html, files, copy }) => {
              const into = join(target, d.sub, html ? ARTIFACT_DIR : '');
              mkdirSync(into, { recursive: true });
              for (const f of files) {
                mkdirSync(dirname(join(into, f)), { recursive: true });
                copyFileSync(join(d.dir, f), join(into, f));
              }
              for (const [f, data] of copy) writeFileSync(join(into, f), data);
              const source = sourceHash(d.dir, html ? files : ['demo.mp4']);
              return { d, html, source, at: dated.get(source) ?? now };
            });
            const [first, ...later] = written as [(typeof written)[number], ...typeof written];
            const meta: Meta = {
              ...(first.html ? { kind: 'html' as const } : {}),
              title: p.title.trim(),
              text: p.text.trim(),
              chapters: first.html ? [] : (p.chapters ?? []),
              pr: p.pr ?? null,
              ...(p.commit ? { commit: p.commit } : {}),
              first: before?.first ?? now,
              at: first.at,
              source: first.source,
              language: p.language,
              ...(by ? { by } : {}),
              ...(p.tags && Object.values(p.tags).some((v) => v.length) ? { tags: p.tags } : {}),
              ...(later.length
                ? {
                    more: later.map(({ d, html, source, at }) => ({
                      ...(html ? { kind: 'html' as const } : {}),
                      title: d.title.trim(),
                      text: d.text.trim(),
                      chapters: html ? [] : (d.chapters ?? []),
                      dir: d.sub,
                      handed: 'at' in d && d.at ? d.at : at,
                      at,
                      source,
                    })),
                  }
                : {}),
            };
            writeFileSync(join(target, 'meta.json'), JSON.stringify(meta, null, 2));
            writeFileSync(join(target, 'index.html'), pageHtml(site, meta, (sub) => versionFiles(join(target, sub)), undefined, unlisted));
            return { ...entryOf(slug), rev };
          },
          log,
          gone,
        );
        return { url: pageUrl(site, slug), said };
      }),
    withdraw: async (slugArg, shared, log = () => {}) => {
      const r = await attempt(async (gone) => {
        const slug = checkSlug(slugArg, unlisted);
        const said = await change(slug, shared, (rev) => ({ rev, machine, at: new Date().toISOString(), withdrawn: true }), log, gone);
        return { said };
      });
      return 'why' in r ? { ...r, why: t.notWithdrawn(r.why) } : r;
    },
    pageUrl: (slug) => pageUrl(site, slug),
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

/** A page's place on the site: its slug, on an unlisted site behind the random part of its address (`<token>/<slug>`). */
const isPage = (slug: string, unlisted: boolean) => (unlisted ? /^[a-z0-9]{16,40}\/[a-z0-9][a-z0-9-]{0,80}$/ : /^[a-z0-9][a-z0-9-]{0,80}$/).test(slug);
/** A path inside a page's directory. */
const isPath = (f: string) => f.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\\'));
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The files under a directory, their paths relative to it with `/`. */
function filesUnder(root: string, at = ''): string[] {
  return readdirSync(join(root, at), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? filesUnder(root, at ? `${at}/${d.name}` : d.name) : d.isFile() ? [at ? `${at}/${d.name}` : d.name] : []))
    .sort();
}

function checkSlug(slug: unknown, unlisted: boolean): string {
  if (typeof slug !== 'string' || !isPage(slug, unlisted)) throw new Refused(`not a slug: ${String(slug)}`);
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
 * A hash of a sample page in each language, with everything a page can have, the video pages',
 * then the artifact pages': it changes with every change to Obeya's templates, and `PAGES_HASH`
 * (page-changes.ts) pins it, so a change is described for the viewers, or found to show nowhere.
 */
export function pagesHash(): { video: string; html: string; stacked: string } {
  const site = { title: 'Demos', url: 'https://demos.example.dev/', deploy: 'true' };
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
    language: 'de',
    by: 'Ada Lovelace',
    tags: { Area: ['Billing', 'Reports'], Audience: [] },
  };
  const hash = (pages: string[]) => createHash('sha256').update(pages.join('\0')).digest('hex').slice(0, 12);
  const languages: PageLanguage[] = ['de', 'en'];
  // without a pull request, the commit (the commits) the work landed as
  const commit = { url: 'https://github.com/o/r/commit/b' };
  const commits = { url: 'https://github.com/o/r/compare/a...b', several: true as const };
  const files = () => ({ poster: true, tracks: [{ file: 'captions.vtt' }] });
  const video = hash(languages.flatMap((language) => [pageHtml(site, { ...sample, language }, files), pageHtml(site, { ...sample, language, pr: null, commit }, files)]));
  const html = hash(languages.map((language) => pageHtml(site, { ...sample, kind: 'html', chapters: [], language }, () => ({ poster: false, tracks: [] })) + sealed(withHeightReport('<body></body>'), new URL(site.url).origin)));
  // a page with several versions: a video, then an artifact and a video as addenda
  const more: MoreMeta[] = [
    { kind: 'html', title: 'Second', text: 'A detail.', chapters: [], dir: '2', handed: at, at, source: '' },
    { title: 'Third', text: 'Another detail.', chapters: [[0, 'Only']], dir: '3', handed: at, at, source: '' },
  ];
  // the same on every machine: the time of an addendum is said in the machine's time zone
  const stacked = hash(languages.flatMap((language) => [pageHtml(site, { ...sample, language, more }, files, 'UTC'), pageHtml(site, { ...sample, language, more, pr: null, commit: commits }, files, 'UTC')]));
  return { video, html, stacked };
}

/** The file a host such as Cloudflare Pages or Netlify reads the headers of the site's files from; on another host it is a file nobody asks for. */
export const HEADERS = '_headers';
/** The page a host (Cloudflare Pages, GitHub Pages, Netlify) answers an address it lacks with. */
export const NOT_FOUND = '404.html';

/** Every file of an unlisted site is kept out of search engines, and a link leaving it says nothing of where it came from. */
const unlistedHeaders = () => `/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
`;

/**
 * The headers of an artifact's files on the site, for a host that sends them: its policy again, now
 * with the sandbox, so a file opened directly does not run in the site's origin, and what no CSP
 * reaches, a connection opened ahead (`preconnect`) or WebRTC, kept to the site
 * (`Connection-Allowlist`, Chrome 152 on).
 */
export function artifactHeaders(site: DemoSite, unlisted = false): string {
  const u = new URL(site.url);
  // on an unlisted site, behind the random part of the page's address
  const path = u.pathname.replace(/\/+$/, '') + (unlisted ? '/:token' : '');
  // an artifact as the page's first version, and as a later one in a directory of its own
  return [`${path}/:slug/${ARTIFACT_DIR}/*`, `${path}/:slug/:n/${ARTIFACT_DIR}/*`]
    .map(
      (at) => `${at}
  Content-Security-Policy: sandbox allow-scripts; ${pagePolicy(u.origin)}
  Connection-Allowlist: ${OWN_CONNECTIONS}
  X-DNS-Prefetch-Control: off
`,
    )
    .join('');
}

/** What a video version's directory on the site holds beside its video: a poster, its caption tracks, and whether the video is silent. */
interface VersionFiles {
  poster: boolean;
  tracks: CaptionTrack[];
  silent?: boolean;
}

function versionFiles(dir: string): VersionFiles {
  const video = join(dir, 'demo.mp4');
  return { poster: existsSync(join(dir, 'poster.jpg')), tracks: captionTracks(dir), silent: existsSync(video) && silentVideo(video) };
}

/**
 * A page of the site, in its language; `files`: what a version's directory (the page's own: '')
 * holds. A page of an unlisted site links no overview and no tags, and keeps itself out of search
 * engines.
 */
function pageHtml(site: DemoSite, m: Meta, files: (dir: string) => VersionFiles, timeZone?: string, unlisted = false): string {
  const { language } = m;
  const w = PAGE_WORDS[language];
  const parts = {
    title: m.title,
    text: m.text,
    pr: m.pr,
    commit: m.commit ?? null,
    when: w.sharedOn(day(m.at, language), m.by),
    tabTitle: unlisted ? m.title : `${m.title} · ${site.title}`,
    language,
    ...(unlisted
      ? { unlisted: true as const }
      : {
          top: { href: '../', text: w.allDemos },
          // each links the overview showing the pages that have it
          tags: Object.entries(m.tags ?? {}).flatMap(([dimension, values]) => values.map((value) => ({ dimension, value, href: `../?${new URLSearchParams({ [dimension]: value })}` }))),
        }),
  };
  // a track from before the tracks is in the demo's language
  const tracks = (f: VersionFiles) => f.tracks.map((t) => ({ file: t.file, language: t.language ?? language }));
  if (m.more?.length) {
    const demo = (d: { kind?: 'html'; title: string; text: string; chapters: [number, string][] }, dir: string): StackedDemo => {
      if (d.kind === 'html') return { kind: 'html', title: d.title, text: d.text, base: dir ? `${dir}/` : '' };
      const f = files(dir);
      return { kind: 'video', title: d.title, text: d.text, base: dir ? `${dir}/` : '', chapters: d.chapters, poster: f.poster, tracks: tracks(f), ...(f.silent ? { silent: true } : {}) };
    };
    return stackedPageHtml({ ...parts, demos: [demo(m, ''), ...m.more.map((x) => ({ ...demo(x, x.dir), at: x.handed }))], ...(timeZone ? { timeZone } : {}) });
  }
  if (m.kind === 'html') return artifactPageHtml({ ...parts, artifact: { src: `${ARTIFACT_DIR}/index.html` } });
  const own = files('');
  return demoPageHtml({
    ...parts,
    chapters: m.chapters,
    video: { src: 'demo.mp4' },
    ...(own.poster ? { poster: 'poster.jpg' } : {}),
    tracks: tracks(own).map((t) => ({ language: t.language, src: t.file })),
    ...(own.silent ? { silent: true } : {}),
  });
}

/** The pages in the site's directory, the most recently shared first. */
function readPages(dir: string): (Meta & { slug: string })[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'meta.json')))
    .map((slug) => ({ slug, ...(JSON.parse(readFileSync(join(dir, slug, 'meta.json'), 'utf8')) as Meta) }))
    .sort((a, b) => newest(b).localeCompare(newest(a)));
}

/** The site's Atom feed, at its root beside the overview. */
export const FEED = 'feed.xml';

/** The first sentence of a page's text, as the overview shows it. */
const firstSentence = (t: string) => (t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t).slice(0, 240);

/** The style the overview adds: its filter (search, a row of chips per dimension), the count and „Links kopieren“, each page's copy icon. */
const OVERVIEW_STYLE = `
  .filter { display: grid; gap: 10px; margin: 0 0 16px; }
  .filter input { font: inherit; font-size: 15px; width: 100%; padding: 7px 11px; border: 1px solid var(--line); border-radius: 3px; background: var(--card); color: var(--ink); }
  .filter input:focus { outline: none; border-color: var(--accent); }
  .dim { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .dim > span { color: var(--muted); font-size: 13px; min-width: 90px; }
  .chip { all: unset; cursor: pointer; font-size: 13px; line-height: 1.5; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); }
  .chip:hover { border-color: var(--accent); }
  .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--card); }
  .chip:focus-visible, .copy:focus-visible, .copy-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding: 10px 0 12px; font-size: 14px; color: var(--muted); }
  .copy-all, .copy { all: unset; cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 6px; }
  .copy-all svg, .copy svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  ul.demos li { position: relative; }
  ul.demos li[hidden] { display: none; }
  ul.demos a { padding-right: 52px; }
  ul.demos i { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; font-style: normal; }
  ul.demos i em { font-style: normal; font-size: 12px; padding: 0 8px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .copy { position: absolute; top: 12px; right: 12px; padding: 6px; border-radius: 3px; opacity: 0; transition: opacity 0.1s; }
  .copy:hover { background: var(--chip); }
  ul.demos li:hover .copy, .copy:focus-visible, .copy.done { opacity: 1; }
  .copy.done::after { content: attr(data-done); position: absolute; right: 100%; margin-right: 4px; font-size: 13px; white-space: nowrap; }
  @media (hover: none) { .copy { opacity: 1; } }
`;

/** Two overlapping sheets: the mark for copying. */
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

/**
 * Every page on the site, the most recently shared first, in the site's language. Above them a
 * filter: a search over title and text, and a row of chips per dimension of the site's vocabulary
 * (its values that some page has), any of a dimension's and all dimensions; it stands in the URL
 * (`?Area=Billing&q=pdf`), so a filtered list can be passed on. Each page's link is copied by its
 * icon, those shown all at once by „Links kopieren“: as HTML links and as a Markdown list. It all
 * runs in the browser; the site stays static.
 */
function overviewHtml(site: DemoSite, pages: (Meta & { slug: string })[], language: PageLanguage): string {
  const w = PAGE_WORDS[language];
  const has = (d: string, v: string) => pages.some((p) => p.tags?.[d]?.includes(v));
  const dims = dimensions(site.tags).flatMap(([d, values]) => {
    const on = values.filter((v) => has(d, v));
    return on.length ? [[d, on] as const] : [];
  });
  const search = (d: Meta) => [d.title, d.text, ...(d.more ?? []).flatMap((m) => [m.title, m.text])].join(' ').toLowerCase().replace(/\s+/g, ' ');
  const entry = (d: Meta & { slug: string }) => {
    const tags = dims.flatMap(([dim, values]) => values.filter((v) => d.tags?.[dim]?.includes(v)));
    const line = [day(newest(d), language), ...(d.by ? [w.by(d.by)] : []), firstSentence(d.text)].map(esc).join(' · ');
    return `<li data-tags="${esc(JSON.stringify(d.tags ?? {}))}" data-search="${esc(search(d))}"><a href="${d.slug}/"><b>${esc(d.title)}</b><span>${line}</span>${tags.length ? `<i>${tags.map((v) => `<em>${esc(v)}</em>`).join('')}</i>` : ''}</a><button class="copy" data-url="${esc(pageUrl(site, d.slug))}" data-done="${esc(w.copied)}" title="${esc(w.copyLink)}" aria-label="${esc(w.copyLink)}">${COPY_ICON}</button></li>`;
  };
  const filter = `<div class="filter">
<input type="search" id="q" placeholder="${esc(w.search)}" aria-label="${esc(w.search)}" autocomplete="off">
${dims.map(([d, values]) => `<div class="dim" role="group" aria-label="${esc(d)}"><span>${esc(d)}</span>${values.map((v) => `<button class="chip" data-d="${esc(d)}" data-v="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join('')}</div>`).join('\n')}
</div>
<div class="bar"><span id="count">${esc(w.shown.replace('{n}', String(pages.length)).replace('{m}', String(pages.length)))}</span><button class="copy-all" title="${esc(w.copyLinksHint)}">${COPY_ICON}<span>${esc(w.copyLinks)}</span></button></div>
`;
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.title)}</title><link rel="alternate" type="application/atom+xml" title="${esc(site.title)}" href="${FEED}"><style>${PAGE_STYLE}${OVERVIEW_STYLE}</style></head>
<body><main>
<h1>${esc(site.title)}</h1>
<div class="when">${esc(w.overview)} · <a href="${FEED}">${esc(w.feed)}</a></div>
${
  pages.length
    ? `${filter}<ul class="demos">${pages.map(entry).join('\n')}</ul>
<p class="none" hidden>${esc(w.noMatch)}</p>
<script>${overviewScript(w)}</script>`
    : `<p>${esc(w.noDemos)}</p>`
}
${credit(language)}</main></body></html>
`;
}

/**
 * The overview's filter in the browser: the chips and the search from the URL, the pages that pass
 * them, the count, the URL kept in step; copying a page's link, and the links of those shown as
 * `text/html` and as a Markdown list (`text/plain`), as text alone where the browser has no `ClipboardItem`.
 */
const overviewScript = (w: (typeof PAGE_WORDS)[PageLanguage]) => `
  const words = ${JSON.stringify({ shown: w.shown, copied: w.copied, copyLinks: w.copyLinks }).replace(/</g, '\\u003c')};
  const q = document.getElementById('q'), chips = [...document.querySelectorAll('.chip')], items = [...document.querySelectorAll('ul.demos li')];
  const count = document.getElementById('count'), none = document.querySelector('.none'), all = document.querySelector('.copy-all');
  const params = new URLSearchParams(location.search);
  q.value = params.get('q') || '';
  for (const c of chips) c.setAttribute('aria-pressed', String(params.getAll(c.dataset.d).includes(c.dataset.v)));
  const tagsOf = (li) => { try { return JSON.parse(li.dataset.tags); } catch { return {}; } };
  const apply = () => {
    const chosen = {};
    for (const c of chips) if (c.getAttribute('aria-pressed') === 'true') (chosen[c.dataset.d] ||= []).push(c.dataset.v);
    const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let n = 0;
    for (const li of items) {
      const tags = tagsOf(li);
      // any of a dimension's chips, and every dimension with one
      const pass = Object.entries(chosen).every(([d, vs]) => vs.some((v) => (tags[d] || []).includes(v))) && terms.every((t) => li.dataset.search.includes(t));
      li.hidden = !pass;
      if (pass) n++;
    }
    count.textContent = words.shown.replace('{n}', n).replace('{m}', items.length);
    none.hidden = n > 0;
    all.disabled = n === 0;
    const next = new URLSearchParams();
    for (const [d, vs] of Object.entries(chosen)) for (const v of vs) next.append(d, v);
    if (q.value.trim()) next.set('q', q.value.trim());
    const search = next.toString();
    history.replaceState(null, '', search ? '?' + search : location.pathname);
  };
  for (const c of chips) c.addEventListener('click', () => { c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true')); apply(); });
  q.addEventListener('input', apply);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const copy = async (html, text) => {
    if (window.ClipboardItem && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        return;
      } catch {}
    }
    await navigator.clipboard.writeText(text);
  };
  for (const b of document.querySelectorAll('.copy')) b.addEventListener('click', async () => {
    const url = b.dataset.url;
    await copy('<a href="' + esc(url) + '">' + esc(url) + '</a>', url);
    b.classList.add('done');
    setTimeout(() => b.classList.remove('done'), 1500);
  });
  all.addEventListener('click', async () => {
    const shown = items.filter((li) => !li.hidden).map((li) => ({ title: li.querySelector('b').textContent, url: li.querySelector('.copy').dataset.url }));
    if (!shown.length) return;
    await copy('<ul>' + shown.map((d) => '<li><a href="' + esc(d.url) + '">' + esc(d.title) + '</a></li>').join('') + '</ul>', shown.map((d) => '- [' + d.title.replace(/([\\[\\]])/g, '\\\\$1') + '](' + d.url + ')').join('\\n'));
    const label = all.querySelector('span');
    label.textContent = words.copied;
    setTimeout(() => { label.textContent = words.copyLinks; }, 1500);
  });
  apply();
`;

/** Text without the control characters XML 1.0 does not allow. */
const printable = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
/** Text in XML. */
const xml = (s: string) => esc(printable(s));

/**
 * The site's pages as an Atom feed, in the order and with the dates of the overview: each page's
 * title, its text, its address as link and id. The feed is as old as its newest page; a site
 * without pages dates it now.
 */
function feedXml(site: DemoSite, pages: (Meta & { slug: string })[], language: PageLanguage): string {
  const base = `${site.url.replace(/\/+$/, '')}/`;
  const updated = pages.length ? newest(pages[0]!) : new Date().toISOString();
  const entry = (d: Meta & { slug: string }) => {
    const url = xml(pageUrl(site, d.slug));
    const plain = printable(d.text);
    return `<entry xml:lang="${d.language}">
<title type="text">${xml(d.title)}</title>
<link rel="alternate" type="text/html" href="${url}"/>
<id>${url}</id>
<published>${xml(d.first)}</published>
<updated>${xml(newest(d))}</updated>
${d.by ? `<author><name>${xml(d.by)}</name></author>\n` : ''}${Object.entries(d.tags ?? {})
      .flatMap(([dim, values]) => values.map((v) => `<category term="${xml(v)}" label="${xml(`${dim}: ${v}`)}"/>\n`))
      .join('')}<summary type="text">${xml(firstSentence(plain))}</summary>
<content type="html">${xml(paragraphs(plain))}</content>
</entry>
`;
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${language}">
<title type="text">${xml(site.title)}</title>
<subtitle type="text">${xml(PAGE_WORDS[language].overview)}</subtitle>
<link rel="self" type="application/atom+xml" href="${xml(base + FEED)}"/>
<link rel="alternate" type="text/html" href="${xml(base)}"/>
<id>${xml(base)}</id>
<updated>${xml(updated)}</updated>
<author><name>${xml(site.title)}</name></author>
<generator uri="${OBEYA_URL}">Obeya</generator>
${pages.map(entry).join('')}</feed>
`;
}
