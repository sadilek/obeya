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
// own (Cloudflare Pages serves the overview for a site without a `404.html`, as one deployed before
// Obeya wrote it): a manifest answered that way is missing, not unreadable.
//
// The pages come from Obeya's own templates (`demo-page.ts`, `site-pages.ts`), each in its demo's
// language, the overview in the site's. A call writes only its own page and the overview: a page
// shared earlier keeps the template it was written with until it is published again (the page
// changes since, page-changes.ts, say what that would bring). A page published again with the same
// video, or the same artifact files, keeps its date, so the overview keeps its order when pages are
// brought up to date or get their pull request's link. What counts is the demo's own files
// (`source` in meta.json), not the copies on the site, which carry what Obeya adds to an artifact
// (artifact-copy.ts).
//
// A repository's theme (theme.ts) goes into each page of its cards, after Obeya's style, and beside
// it as `theme.css`; each page names its repository (`repoMark`). The overview carries a theme only
// while every page that names its repository names the same one: the theme of that repository's
// page written last. Several repositories on one site: Obeya's look. Without a theme, the pages
// are what they were.
//
// A host may serve no byte ranges (Cloudflare Pages does not): the video page then loads the video
// whole, so a browser can seek in it (`demo-page.ts`).
//
// The owner's personal site (personal-site.ts) is unlisted (`unlisted`): a page lies at
// `<token>/<slug>/`, the token drawn per card; the manifest lies in a secret directory; the root and
// the answer to a missing address are blank; there is no feed; pages and headers keep search engines
// out and send no referrer.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Messages } from '../core/messages';
import type { DemoKind, PageTags, DemoSite } from '../core/types';
import { expandHome, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import type { Theme } from './theme';
import { ARTIFACT_DIR, type PageCommit, type PageLanguage } from './demo-page';
import { artifactFiles, captionTracks, demoFiles, silentVideo } from './demo-files';
import { artifactHeaders, FEED, feedXml, HEADERS, type Meta, newest, NOT_FOUND, notFoundHtml, overviewHtml, pageHtml, pageUrl, ROBOTS, robotsTxt, SITEMAP, sitemapXml, unlistedHeaders, type VersionFiles } from './site-pages';
import { artifactCopy } from './artifact-copy';
import { BUN_ENV } from './resources';
import { spawnOutput } from './spawn';
import { HERE } from './workspaces';
import { isFolder } from './branches';
import { gitTry } from './git';
import { BLANK_PAGE, GITHUB_PAGES, githubPagesDeploy, parseEnv, SITES_DIR } from './site-hosts';
import { commandWords } from './folder-processes';
import { messageOf } from '../core/text';

/** The largest file a site takes without `maxFile` (Cloudflare Pages' limit). */
export const MAX_FILE = 25 * 1024 * 1024;

/** A demo version on a page: the first gives the page its title and text, each later one is an addendum below it. */
export interface PageDemo {
  title: string;
  text: string;
  /** A video, or an HTML artifact. */
  kind: DemoKind;
  /** Seconds and title of each scene; none for an artifact. */
  chapters: [number, string][];
  /** The demo's directory: `demo.mp4`, `poster.jpg`, `captions.vtt`; an artifact's `index.html` and the files it loads. */
  dir: string;
  /** When it was handed over, which a later version's section is headed with. */
  at?: string;
}

/** What a page on the site is made of: its demo versions, and what the page says of the change. */
export interface SharePage {
  /** Stays the same for a card, so a shared link keeps working when the page is published again. */
  slug: string;
  /** The demo versions on the page, in order of handover. */
  demos: [PageDemo, ...PageDemo[]];
  /** The card's pull request, once it has one. */
  pr: string | null;
  /** Without a pull request: where the card's work landed on the default branch, once it has. */
  commit?: PageCommit | null;
  /** The demo's language, for the page's own words (`language` of the page templates). */
  language: PageLanguage;
  /** The slugs of the other pages Obeya has stored as shared on this site: the site must still hold them. */
  shared: string[];
  /** The page's tags from the site's vocabulary, by dimension (`tagsOf`); none where the site has none. */
  tags?: PageTags;
  /** The theme of the card's repository (theme.ts); none where it has none. */
  theme?: Theme;
}

/**
 * Where a card's pages go. Pages whose targets have the same key are on one site: a publish or
 * withdrawal names the others as shared. Keys are not stored, so they only need to stay the same
 * across a restart.
 */
export interface ShareTarget {
  key: string;
  /** The card's repository checkout. */
  repo: string;
  /**
   * The page's URL, or why it did not go out; what the target said on the way goes into the card's
   * log, and what it says while it goes on (`log`). `gone`: pages another machine withdrew, found
   * on the way.
   */
  publish(page: SharePage, log?: (text: string) => void): Promise<({ url: string; said: string } | { why: string; said: string }) & { gone?: Gone[] }>;
  withdraw(slug: string, shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
  /**
   * The pages another machine withdrew (their cards here lose their link), and the pages shared
   * from here (`shared`) that the live site lacks or has older, taken offline by another machine's
   * deployment that came in between.
   */
  audit(shared: string[]): Promise<{ gone: Gone[]; missing: string[] }>;
  /** Where the page of `slug` is, before it is published. */
  pageUrl(slug: string): string;
  /** Deploys again what this machine has, for the pages `audit` found missing. */
  repair(shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
  /**
   * Gives pages on the site their tags in one deploy, in place: each keeps its video or artifact as
   * the site has it (the demo's own files may be gone), and the page around them is written anew.
   * `shared`: every page shared through the target, those included.
   */
  retag(pages: { slug: string; tags: PageTags }[], shared: string[], log?: (text: string) => void): Promise<{ why?: string; said: string; gone?: Gone[] }>;
}

/**
 * Where a site's deploy runs, under Obeya's home: not in the checkout, which is often a workspace
 * of the pool too, and a file a command leaves in its working directory (`wrangler pages deploy`
 * writes its cache there) would keep the workspace from being leased until someone cleans up.
 */
export const SHARE_CWD = 'share';

/** A site's deploy that has not finished by then is stopped (an upload of a few files takes seconds). */
export const COMMAND_TIMEOUT = 15 * 60_000;

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

/**
 * Argv whose program, given as a path, is found in the repository (`~` is the home directory), and
 * a script (`.ts`, `.js`) runs with Obeya's own Bun, on every platform.
 */
export function scriptArgv(words: string[], repoPath: string): string[] {
  if (!words.length) return [];
  let [program, ...rest] = words as [string, ...string[]];
  // bunx is Obeya's own Bun too: an installation of Obeya may have no bunx on the PATH
  if (program === 'bunx') return [process.execPath, 'x', ...rest];
  program = expandHome(program);
  const script = /\.(m?[jt]sx?|cjs)$/.test(program);
  if ((script || /[\\/]/.test(program)) && !isAbsolute(program)) program = resolve(repoPath, program);
  return script ? [process.execPath, program, ...rest] : [program, ...rest];
}

/** What the demo site lacks to be shared on (a title, an http(s) URL, a deploy command); null where it has it. */
export function siteIncomplete(site: DemoSite): string | null {
  if (!site.title.trim()) return 'demo.site.title: missing';
  if (!/^https?:\/\/[^\s/]+[^\s]*$/.test(site.url)) return 'demo.site.url: expected an http(s) URL';
  if (!site.deploy.trim()) return 'demo.site.deploy: missing';
  return null;
}

/**
 * Why the demo site a repository's settings name cannot be used, in English, starting with its
 * field (`demo.site.url: …`); null where it can. The configuration reports it.
 */
export function siteProblem(site: DemoSite, repoPath: string): string | null {
  const incomplete = siteIncomplete(site);
  if (incomplete) return incomplete;
  const words = commandWords(site.deploy);
  // the deploy Obeya builds in: a GitHub repository, pushed to with gh's login
  if (words[0] === GITHUB_PAGES) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(words[1] ?? '')) return `demo.site.deploy: ${GITHUB_PAGES} expects <owner>/<repository>`;
    return Bun.which('gh') ? null : `demo.site.deploy: ${GITHUB_PAGES} needs gh, which is not on the PATH`;
  }
  // bunx runs as Obeya's own Bun
  if (words[0] === 'bunx') return words.length > 1 ? null : 'demo.site.deploy: bunx without a package';
  const argv = scriptArgv(words, repoPath);
  const program = argv[0] === process.execPath ? argv[1] : argv[0];
  if (!program) return 'demo.site.deploy: the deploy command is empty';
  if (isAbsolute(program)) return existsSync(program) ? null : `demo.site.deploy: the deploy command's program ${program} does not exist`;
  return Bun.which(program) ? null : `demo.site.deploy: the deploy command's program ${program} is not on the PATH`;
}

/** The last lines of a command's output, for the card's log. */
export function tail(s: string, lines = 20): string {
  const all = s.trim().split('\n');
  return (all.length > lines ? ['…', ...all.slice(-lines)] : all).join('\n').slice(-3000);
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

/** git's names by repository, each read once while the server runs. */
const gitNames = new Map<string, Promise<string | undefined>>();

/** git's name in the repository (its own `user.name`, else the global one); undefined where it has none. */
function gitName(repo: string): Promise<string | undefined> {
  let name = gitNames.get(repo);
  if (!name) {
    name = gitTry(repo, 'config', '--get', 'user.name').then((r) => r || undefined);
    gitNames.set(repo, name);
  }
  return name;
}

/** A page's theme beside its `index.html`, for the overview (`overviewTheme`). */
const PAGE_THEME = 'theme.css';

/** Repository marks by checkout, as `repoMark` works them out. */
const marks = new Map<string, Promise<string>>();

/**
 * Which repository a page comes from, the same for every clone of it on any machine: a hash of its
 * first commit (the smallest, where histories were joined), else of its path (a folder, a
 * repository without commits). A hash, so the public site names no repository.
 */
export function repoMark(repo: string): Promise<string> {
  const key = resolve(repo);
  let mark = marks.get(key);
  if (!mark) {
    mark = (async () => {
      let root = '';
      if (!isFolder(key)) {
        try {
          const roots = await gitTry(key, 'rev-list', '--max-parents=0', 'HEAD');
          if (roots !== null) root = roots.split('\n').sort()[0] ?? '';
        } catch {}
      }
      return createHash('sha256').update(root ? `commit:${root}` : `path:${key}`).digest('hex').slice(0, 16);
    })();
    marks.set(key, mark);
  }
  return mark;
}

/**
 * What Obeya has read of a site's directory, by directory, while the server runs: each page's
 * `meta.json` (null for a directory without one), and the pages whose files the directory was found
 * to hold, with the revision (`holds`). Only Obeya changes the directory, and each change forgets
 * the pages it touches; a page's directory gone otherwise shows when the site's directory is listed.
 * So a change reads and checks the one page it makes, not every page on the site: a site of some
 * hundred pages held the server up for a second with each share (2026-11-05).
 */
interface Read {
  metas: Map<string, Meta | null>;
  whole: Map<string, string>;
}
const readSites = new Map<string, Read>();

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

  /** What this server has read of the directory (`Read`). */
  const known = (): Read => {
    let k = readSites.get(dir);
    if (!k) readSites.set(dir, (k = { metas: new Map(), whole: new Map() }));
    return k;
  };
  /** Forgets what was read of a page whose directory changes. */
  const forget = (slug: string) => {
    const k = known();
    k.metas.delete(slug);
    k.whole.delete(slug);
  };

  /** The pages in the directory with their `meta.json`: the directory listed afresh, a `meta.json` read only where it was not read before. */
  const here = async (): Promise<Map<string, Meta>> => {
    const k = known();
    // a directory that is not there holds no pages; one that cannot be read refuses the change, as a deploy without its pages would take them offline
    const dirs = async (at: string) => (await readdir(at, { withFileTypes: true }).catch(absent([]))).filter((d) => d.isDirectory()).map((d) => d.name);
    // an unlisted site's pages lie a level deeper, in the random part of their address
    const slugs = new Set(unlisted ? (await Promise.all((await dirs(dir)).map(async (token) => (await dirs(join(dir, token))).map((s) => `${token}/${s}`)))).flat() : await dirs(dir));
    for (const s of k.metas.keys()) if (!slugs.has(s)) forget(s);
    await eachOf([...slugs].filter((s) => !k.metas.has(s)), async (s) => {
      const meta = await readFile(join(dir, s, 'meta.json'), 'utf8').then((text) => JSON.parse(text) as Meta, absent(null));
      k.metas.set(s, meta);
    });
    return new Map([...k.metas].flatMap(([s, m]) => (m ? [[s, m] as const] : [])));
  };

  /** The site lives only in its directory: one that lost pages Obeya has as shared would drop them with the next deployment. */
  const checkSite = async (shared: string[], self: string[]) => {
    const pages = await here();
    const missing = shared.filter((s) => !self.includes(s) && !pages.has(s));
    if (missing.length) throw new Refused(t.siteLacks(dir, missing));
  };

  const deployEnv = async (): Promise<Record<string, string>> => {
    const file = envPath(home, site);
    if (!file) return {};
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new Refused(t.envMissing(file));
    }
    return parseEnv(text);
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
  const readLocal = async (): Promise<Manifest> => {
    let text: string;
    try {
      text = await readFile(join(dir, manifestAt), 'utf8');
    } catch {
      return { deploy: '', machine, at: '', pages: {} };
    }
    return JSON.parse(text);
  };

  /** Writes the manifest for the next deployment, under a name of its own; returns it. Pages whose directory is not there are left out. */
  const writeLocal = async (m: Manifest): Promise<string> => {
    const deploy = randomUUID();
    const there = await here();
    const pages = Object.fromEntries(Object.entries(m.pages).filter(([slug, e]) => e.withdrawn || there.has(slug)));
    await mkdir(dirname(join(dir, manifestAt)), { recursive: true });
    await writeFile(join(dir, manifestAt), JSON.stringify({ deploy, machine, at: new Date().toISOString(), pages } satisfies Manifest, null, 1));
    return deploy;
  };

  /** A page of the directory as the manifest lists it. */
  const entryOf = async (slug: string): Promise<Entry> => {
    const files: Entry['files'] = {};
    for (const f of await filesUnder(join(dir, slug))) files[f] = await fileHash(join(dir, slug, f));
    const meta = JSON.parse(await readFile(join(dir, slug, 'meta.json'), 'utf8')) as Meta;
    return { rev: 1, machine, at: new Date().toISOString(), meta, files };
  };

  /** Whether the directory holds the page's files the manifest lists, by their sizes; looked at once for each revision of the page. */
  const holds = async (slug: string, e: Entry): Promise<boolean> => {
    const k = known();
    const revision = `${e.rev} ${e.machine} ${e.at}`;
    if (k.whole.get(slug) === revision) return true;
    const sizes = await Promise.all(Object.entries(e.files ?? {}).map(([f, { size }]) => stat(join(dir, slug, f)).then((s) => s.size === size, () => false)));
    if (!sizes.every(Boolean)) return false;
    k.whole.set(slug, revision);
    return true;
  };

  /**
   * Pull: brings the directory up to the live site. Pages missing here or newer there are
   * downloaded, pages withdrawn there are removed here; pages the live site lacks stay (this
   * machine's not deployed yet, or lost to a deploy that came in between). Returns the pages
   * withdrawn there by another machine that this directory had.
   */
  const pull = async (local: Manifest, live: Live, env: Record<string, string>, log: (text: string) => void): Promise<Gone[]> => {
    const gone: Gone[] = [];
    // what was found of a page's files counts only while its directory is still there
    await here();
    const candidates: [string, Entry, boolean][] = [];
    for (const [slug, e] of Object.entries(live.pages)) {
      if (!isPage(slug, unlisted)) continue;
      const mine = local.pages[slug];
      if (e.withdrawn) {
        if (mine && mine.rev >= e.rev) continue;
        if (mine && !mine.withdrawn) gone.push({ slug, machine: e.machine });
        forget(slug);
        await rm(join(dir, slug), { recursive: true, force: true });
        local.pages[slug] = e;
      } else if (!mine || mine.rev < e.rev) candidates.push([slug, e, true]);
      else if (mine.rev === e.rev) candidates.push([slug, e, false]);
    }
    // a page at the same revision here is fetched when the directory lacks its files
    await eachOf(candidates, async (c) => {
      if (!c[2]) c[2] = !(await holds(c[0], c[1]));
    });
    const fetchList = candidates.flatMap(([slug, e, fetch]) => (fetch ? [[slug, e] as [string, Entry]] : []));
    if (fetchList.length) {
      const bytes = fetchList.reduce((n, [, e]) => n + Object.values(e.files ?? {}).reduce((m, f) => m + f.size, 0), 0);
      log(t.pulling(fetchList.length, (bytes / 1024 / 1024).toFixed(1)));
    }
    let done = 0;
    for (const [slug, e] of fetchList) {
      const into = join(base, 'incoming', slug);
      await rm(into, { recursive: true, force: true });
      for (const [f, want] of Object.entries(e.files ?? {})) {
        const name = `${slug}/${f}`;
        if (!isPath(f)) throw new Refused(t.downloadBad(name));
        const to = join(into, f);
        await mkdir(dirname(to), { recursive: true });
        const have = join(dir, slug, f);
        const had = await stat(have).then((s) => s.size === want.size, () => false);
        if (had && (await fileHash(have)).hash === want.hash) {
          await copyFile(have, to);
          continue;
        }
        // read whole (a file is at most the site's limit), so the timeout covers the body too
        let bytes: Uint8Array;
        let hash: string;
        try {
          const r = await get(`${slug}/${f.split('/').map(encodeURIComponent).join('/')}`, env, DOWNLOAD_TIMEOUT);
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
          ({ bytes, hash } = await bodyOf(r.body));
        } catch (err) {
          throw new Refused(t.downloadFailed(name, messageOf(err)));
        }
        if (bytes.length !== want.size || hash !== want.hash) throw new Refused(t.downloadBad(name));
        await writeFile(to, bytes);
      }
      forget(slug);
      await rm(join(dir, slug), { recursive: true, force: true });
      // an unlisted site's page lies a level deeper, in the random part of its address
      await mkdir(dirname(join(dir, slug)), { recursive: true });
      await mkdir(into, { recursive: true });
      await rename(into, join(dir, slug));
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
   * Writes the overview, the answer to an address the site lacks (`404.html`), the feed and the
   * sitemap (with a `robots.txt` naming it where the site is its host's root) from the pages in the
   * directory, and the headers of the artifacts' files. An unlisted site has none of them: its root
   * and its answer to an address it lacks are a blank page, so neither leads to a page.
   */
  const writeOverview = async (written: Manifest) => {
    await mkdir(dir, { recursive: true });
    if (unlisted) {
      await writeFile(join(dir, 'index.html'), BLANK_PAGE);
      await writeFile(join(dir, NOT_FOUND), BLANK_PAGE);
      await writeFile(join(dir, HEADERS), unlistedHeaders() + artifactHeaders(site, true));
      for (const f of [FEED, SITEMAP, ROBOTS]) await rm(join(dir, f), { force: true });
      return;
    }
    // the most recently shared first
    const pages = [...(await here())]
      .map(([slug, m]) => ({ slug, ...m }))
      .sort((a, b) => newest(b).localeCompare(newest(a)) || a.slug.localeCompare(b.slug));
    const theme = await overviewTheme(dir, pages, written.pages);
    await writeFile(join(dir, 'index.html'), overviewHtml(site, pages, overviewLanguage(), theme));
    await writeFile(join(dir, NOT_FOUND), notFoundHtml(site, overviewLanguage(), theme));
    await writeFile(join(dir, FEED), feedXml(site, pages, overviewLanguage()));
    await writeFile(join(dir, SITEMAP), sitemapXml(site, pages));
    if (new URL(site.url).pathname === '/') await writeFile(join(dir, ROBOTS), robotsTxt(site));
    else await rm(join(dir, ROBOTS), { force: true });
    await writeFile(join(dir, HEADERS), artifactHeaders(site));
  };

  /** Runs the deploy line on the directory; what it said, for the card's log. */
  const deploy = async (env: Record<string, string>): Promise<string> => {
    await mkdir(dir, { recursive: true });
    const words = commandWords(site.deploy).map((a) => a.replaceAll('{dir}', dir));
    // the deploy Obeya builds in for GitHub Pages
    if (words[0] === GITHUB_PAGES) {
      try {
        return tail(await githubPagesDeploy(dir, words[1] ?? '', join(base, 'git'), { private: unlisted }));
      } catch (e) {
        throw new Refused(t.deployFailed(1), { cause: messageOf(e) });
      }
    }
    const argv = scriptArgv(words, repo);
    const cwd = join(home, SHARE_CWD);
    await mkdir(cwd, { recursive: true });
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
   * One change of the site, made safe for several machines: pull, change the pages (`apply` writes
   * a page's directory, or removes it, and returns its entry), deploy the whole directory, check the
   * live site shows it. Without pages the round deploys the directory as it is, for the pages this
   * machine has as shared that the live site lacks, and checks those. A change another machine's
   * deployment came in between with (seen before the deploy, or after it without the change) is
   * undone here and made once more; a failed deploy is undone too. Each page's directory is set
   * aside meanwhile (`wholeBackup`); with `inPlace`, only the files `apply` rewrites are
   * (`inPlaceBackup`).
   */
  const change = async ({
    slugs,
    shared,
    apply,
    log,
    gone,
    inPlace = false,
  }: {
    slugs: string[];
    shared: string[];
    apply?: (slug: string, rev: number, before: Entry | undefined) => Promise<Entry>;
    log: (text: string) => void;
    gone: Gone[];
    inPlace?: boolean;
  }): Promise<string> => {
    const env = await deployEnv();
    const backup = inPlace ? inPlaceBackup : wholeBackup;
    for (let round = 1; ; round++) {
      const live = await readLive(env);
      const local = await readLocal();
      const lost = await pull(local, live, env, log);
      gone.push(...lost.filter((g) => !slugs.includes(g.slug)));
      const away = new Set(gone.map((g) => g.slug));
      const kept = shared.filter((s) => !away.has(s));
      await checkSite(kept, inPlace ? [] : slugs);
      const before = new Map(slugs.map((s) => [s, local.pages[s]]));
      const rev = new Map(slugs.map((s) => [s, Math.max(local.pages[s]?.rev ?? 0, live.pages[s]?.rev ?? 0) + 1]));
      const aside = new Map<string, string | null>();
      for (const s of slugs) aside.set(s, await backup.setAside(s));
      const undo = async () => {
        if (!slugs.length) return;
        for (const s of slugs) {
          forget(s);
          await backup.restore(s, aside.get(s) ?? null);
          const was = before.get(s);
          if (was) local.pages[s] = was;
          else delete local.pages[s];
        }
        await writeLocal(local);
        await writeOverview(local);
      };
      let said = '';
      let seen: boolean | null;
      try {
        if (apply)
          for (const s of slugs) {
            local.pages[s] = await apply(s, rev.get(s)!, before.get(s));
            forget(s);
          }
        const expect: [string, number][] = slugs.length
          ? slugs.map((s) => [s, rev.get(s)!])
          : kept.flatMap((s) => (local.pages[s] && !local.pages[s]!.withdrawn ? [[s, local.pages[s]!.rev] as [string, number]] : []));
        const id = await writeLocal(local);
        await writeOverview(local);
        // another machine deployed since the pull: its deployment would be lost, so pull again
        const now = await readLive(env);
        if (now.deploy !== live.deploy) seen = false;
        else {
          said = await deploy(env);
          seen = await check(expect, id, live.deploy, env);
        }
      } catch (e) {
        await undo();
        throw e;
      }
      if (seen === false) {
        await undo();
        if (round === 2) throw new Refused(t.lostTwice, { cause: said });
        log(t.cameBetween);
        continue;
      }
      for (const b of aside.values()) if (b) await rm(b, { recursive: true, force: true });
      return [said, seen === null ? t.notSeenYet : ''].filter(Boolean).join('\n');
    }
  };

  /** A new directory in `backup/` for the page's, where it is there; null where it is not. */
  const backupFor = async (slug: string): Promise<string | null> => {
    if (!(await exists(join(dir, slug)))) return null;
    const backup = join(base, 'backup', `${slug}-${Date.now()}`);
    await mkdir(dirname(backup), { recursive: true });
    return backup;
  };

  /**
   * How a change keeps a page's directory, so it can be undone: `setAside` before it (where the
   * backup is; null for a page not there), `restore` to undo it, which takes the backup back.
   * A page written anew or withdrawn: its whole directory moved out of the site.
   */
  const wholeBackup: Backup = {
    setAside: async (slug) => {
      const backup = await backupFor(slug);
      if (!backup) return null;
      forget(slug);
      await rename(join(dir, slug), backup);
      return backup;
    },
    restore: async (slug, backup) => {
      await rm(join(dir, slug), { recursive: true, force: true });
      if (backup) await rename(backup, join(dir, slug));
    },
  };
  /** A page retagged in place: only the files that rewrites copied, the page's own files (its video, its artifact) staying where they are. */
  const inPlaceBackup: Backup = {
    setAside: async (slug) => {
      const backup = await backupFor(slug);
      if (!backup) return null;
      await mkdir(backup, { recursive: true });
      for (const f of REWRITTEN) if (await exists(join(dir, slug, f))) await copyFile(join(dir, slug, f), join(backup, f));
      return backup;
    },
    restore: async (slug, backup) => {
      if (!backup) return;
      for (const f of await readdir(backup)) await copyFile(join(backup, f), join(dir, slug, f));
      await rm(backup, { recursive: true, force: true });
    },
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
    publish: (p: SharePage, log = () => {}) =>
      attempt(async (gone) => {
        const slug = checkSlug(p.slug, unlisted);
        // the first version at the page's root, each later one in a directory of its own
        const ready = await Promise.all(
          p.demos.map(async (d, i) => {
            if (!d.title.trim() || !d.text.trim() || !d.dir) throw new Refused(t.pageIncomplete);
            const html = d.kind === 'html';
            const files = html ? artifactFiles(d.dir) : await demoFiles(d.dir);
            for (const f of html ? ['index.html'] : ['demo.mp4', 'captions.vtt']) if (!files.includes(f)) throw new Refused(t.fileMissing(f, d.dir));
            // what the artifact loads in CORS mode goes into its copy (artifact-copy.ts)
            const copy = html ? await artifactCopy(d.dir, files, new URL(site.url).origin) : new Map<string, string>();
            const max = site.maxFile ?? MAX_FILE;
            for (const f of files) {
              const size = copy.has(f) ? Buffer.byteLength(copy.get(f)!) : (await stat(join(d.dir, f))).size;
              if (size > max) throw new Refused(t.fileTooLarge(f, (size / 1024 / 1024).toFixed(1), String(Math.round((max / 1024 / 1024) * 10) / 10)));
            }
            return { d, sub: i ? String(i + 1) : '', html, files, copy };
          }),
        );
        const target = join(dir, slug);
        const said = await change({
          slugs: [slug],
          shared: p.shared,
          log,
          gone,
          apply: async (_, rev, entry) => {
            const before = entry?.withdrawn ? null : entry?.meta;
            // a version keeps its date while its demo's own files stay the same, wherever it was on the page
            const dated = new Map<string, string>(before ? [[before.source, before.at], ...(before.more ?? []).map((m) => [m.source, m.at] as [string, string])] : []);
            const now = new Date().toISOString();
            // the one whose Obeya publishes it now; a machine whose git has no name keeps whom the page named
            const by = opts.by ?? (await gitName(repo)) ?? before?.by;
            const written = [];
            for (const { d, sub, html, files, copy } of ready) {
              const into = join(target, sub, html ? ARTIFACT_DIR : '');
              await mkdir(into, { recursive: true });
              for (const f of files) {
                await mkdir(dirname(join(into, f)), { recursive: true });
                await copyFile(join(d.dir, f), join(into, f));
              }
              for (const [f, data] of copy) await writeFile(join(into, f), data);
              const source = await sourceHash(d.dir, html ? files : ['demo.mp4']);
              written.push({ d, sub, html, source, at: dated.get(source) ?? now });
            }
            const [first, ...later] = written as [(typeof written)[number], ...typeof written];
            const meta: Meta = {
              ...(first.html ? { kind: 'html' as const } : {}),
              title: first.d.title.trim(),
              text: first.d.text.trim(),
              chapters: first.html ? [] : first.d.chapters,
              pr: p.pr,
              ...(p.commit ? { commit: p.commit } : {}),
              first: before?.first ?? now,
              at: first.at,
              source: first.source,
              language: p.language,
              ...(by ? { by } : {}),
              ...(p.tags && Object.values(p.tags).some((v) => v.length) ? { tags: p.tags } : {}),
              repo: await repoMark(repo),
              ...(later.length
                ? {
                    more: later.map(({ d, sub, html, source, at }) => ({
                      ...(html ? { kind: 'html' as const } : {}),
                      title: d.title.trim(),
                      text: d.text.trim(),
                      chapters: html ? [] : d.chapters,
                      dir: sub,
                      handed: d.at ?? at,
                      at,
                      source,
                    })),
                  }
                : {}),
            };
            await writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2));
            if (p.theme) await writeFile(join(target, PAGE_THEME), p.theme.css);
            await writeFile(join(target, 'index.html'), pageHtml(site, slug, meta, await versionsFiles(target, meta), { unlisted, ...(p.theme ? { theme: p.theme.css } : {}) }));
            return { ...(await entryOf(slug)), rev };
          },
        });
        return { url: pageUrl(site, slug), said };
      }),
    withdraw: async (slugArg, shared, log = () => {}) => {
      const r = await attempt(async (gone) => {
        const slug = checkSlug(slugArg, unlisted);
        const said = await change({ slugs: [slug], shared, log, gone, apply: async (_, rev) => ({ rev, machine, at: new Date().toISOString(), withdrawn: true }) });
        return { said };
      });
      return 'why' in r ? { ...r, why: t.notWithdrawn(r.why) } : r;
    },
    pageUrl: (slug) => pageUrl(site, slug),
    audit: async (shared) => {
      try {
        const live = await readLive(await deployEnv());
        const local = await readLocal();
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
    retag: (pages, shared, log = () => {}) =>
      attempt(async (gone) => {
        const want = new Map(pages.map((p) => [checkSlug(p.slug, unlisted), p.tags]));
        const said = await change({
          slugs: [...want.keys()],
          shared,
          log,
          gone,
          inPlace: true,
          apply: async (slug, rev) => {
            const target = join(dir, slug);
            let text: string;
            try {
              text = await readFile(join(target, 'meta.json'), 'utf8');
            } catch {
              throw new Refused(t.siteLacks(dir, [slug]));
            }
            const { tags: _, ...before } = JSON.parse(text) as Meta;
            const tags = want.get(slug)!;
            const meta: Meta = { ...before, ...(Object.values(tags).some((v) => v.length) ? { tags } : {}) };
            await writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2));
            // the page around its files in today's template, with the theme it went out with
            const theme = await readFile(join(target, PAGE_THEME), 'utf8').catch(() => undefined);
            await writeFile(join(target, 'index.html'), pageHtml(site, slug, meta, await versionsFiles(target, meta), { unlisted, ...(theme ? { theme } : {}) }));
            return { ...(await entryOf(slug)), rev };
          },
        });
        return { said };
      }),
    repair: async (shared, log = () => {}) => attempt(async (gone) => ({ said: await change({ slugs: [], shared, log, gone }) })),
  };
}

/** How a change sets a page's directory aside, and puts it back to undo the change (`change`). */
interface Backup {
  setAside: (slug: string) => Promise<string | null>;
  restore: (slug: string, backup: string | null) => Promise<void>;
}

/** What retagging a page in place rewrites of its directory. */
const REWRITTEN = ['meta.json', 'index.html'];

/** A page's place on the site: its slug, on an unlisted site behind the random part of its address (`<token>/<slug>`). */
const isPage = (slug: string, unlisted: boolean) => (unlisted ? /^[a-z0-9]{16,40}\/[a-z0-9][a-z0-9-]{0,80}$/ : /^[a-z0-9][a-z0-9-]{0,80}$/).test(slug);
/** A path inside a page's directory. */
const isPath = (f: string) => f.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\\'));
/** For a file access that fails: `value` where the file is not there; any other failure stands. */
const absent =
  <T>(value: T) =>
  (e: unknown): T => {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR') return value;
    throw e;
  };

const exists = (path: string) => stat(path).then(
  () => true,
  () => false,
);

/** How much of a file is read, and hashed, at a time: a video of the site's limit read and hashed at once held the server up. */
const CHUNK = 1 << 20;

/** A file's size and hash, read a piece at a time. */
async function fileHash(file: string): Promise<{ size: number; hash: string }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK }) as AsyncIterable<Buffer>) {
    h.update(chunk);
    size += chunk.length;
  }
  return { size, hash: h.digest('hex') };
}

/** A download's bytes and their hash, hashed as they come in. */
async function bodyOf(body: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; hash: string }> {
  const h = createHash('sha256');
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    h.update(chunk);
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), hash: h.digest('hex') };
}

/** Runs `fn` on each item, a few at once: a site has hundreds of pages, a process may open fewer files at a time. */
async function eachOf<T>(items: T[], fn: (item: T) => Promise<void>, atOnce = 32): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(atOnce, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** The files under a directory, their paths relative to it with `/`. */
async function filesUnder(root: string, at = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(join(root, at), { withFileTypes: true })) {
    const f = at ? `${at}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await filesUnder(root, f)));
    else if (d.isFile()) out.push(f);
  }
  return out.sort();
}

function checkSlug(slug: string, unlisted: boolean): string {
  if (!isPage(slug, unlisted)) throw new Refused(`not a slug: ${String(slug)}`);
  return slug;
}

/** A hash of the files (relative to `dir`) with their names, each read a piece at a time. */
async function sourceHash(dir: string, files: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0${(await stat(join(dir, f))).size}\0`);
    for await (const chunk of createReadStream(join(dir, f), { highWaterMark: CHUNK }) as AsyncIterable<Buffer>) h.update(chunk);
  }
  return h.digest('hex');
}

async function versionFiles(dir: string): Promise<VersionFiles> {
  const [poster, tracks, silent] = await Promise.all([exists(join(dir, 'poster.jpg')), captionTracks(dir), silentVideo(join(dir, 'demo.mp4'))]);
  return { poster, tracks, silent };
}

/** What each version's directory of the page at `target` holds (`VersionFiles`), as `pageHtml` asks for it, read beforehand without blocking the server. */
async function versionsFiles(target: string, m: Meta): Promise<(dir: string) => VersionFiles> {
  const dirs = ['', ...(m.more ?? []).map((x) => x.dir)];
  const read = await Promise.all(dirs.map((d) => versionFiles(join(target, d))));
  return (dir) => read[dirs.indexOf(dir)] ?? { poster: false, tracks: [] };
}

/**
 * The theme of the overview: while the pages that name their repository all name the same one, the
 * theme of its page written last (`written`, the manifest's pages); none where they name several,
 * or none, or that page carries none. A page from before the marks does not count.
 */
async function overviewTheme(dir: string, pages: (Meta & { slug: string })[], written: Record<string, Entry>): Promise<string | undefined> {
  const marked = pages.filter((p) => p.repo);
  if (!marked.length || marked.some((p) => p.repo !== marked[0]!.repo)) return undefined;
  const last = marked.reduce((a, b) => ((written[b.slug]?.at ?? '') > (written[a.slug]?.at ?? '') ? b : a));
  return readFile(join(dir, last.slug, PAGE_THEME), 'utf8').catch(() => undefined);
}
