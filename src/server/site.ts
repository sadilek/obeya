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

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** The site as a share target, keyed by its directory, so every repository naming it shares its pages' version and guard. */
export function siteTarget(site: DemoSite, repo: string, home: string, t: Messages['share']): ShareTarget {
  const base = siteBase(home, site);
  const dir = join(base, 'site');
  const overviewLanguage = (): PageLanguage => site.language ?? readDemoSettings(home).language;

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

  /** Moves a page's directory out of the site, so a failed deployment can put it back. */
  const setAside = (slug: string): string | null => {
    if (!existsSync(join(dir, slug))) return null;
    const backup = join(base, 'backup', `${slug}-${Date.now()}`);
    mkdirSync(dirname(backup), { recursive: true });
    renameSync(join(dir, slug), backup);
    return backup;
  };
  const restore = (slug: string, backup: string | null) => {
    rmSync(join(dir, slug), { recursive: true, force: true });
    if (backup) renameSync(backup, join(dir, slug));
    if (existsSync(dir)) writeOverview();
  };

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

  /** Runs a change of the site, its reason in Obeya's words where it was refused. */
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | { why: string; said: string }> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Refused) return { why: e.message, said: typeof e.cause === 'string' ? tail(e.cause) : '' };
      return { why: e instanceof Error ? e.message : String(e), said: '' };
    }
  };

  return {
    key: `site:${siteKey(site.url)}`,
    repo,
    publish: (p: SharePage) =>
      attempt(async () => {
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
        checkSite(p.shared ?? [], slug);
        const env = deployEnv();
        const target = join(dir, slug);
        const before = existsSync(join(target, 'meta.json')) ? (JSON.parse(readFileSync(join(target, 'meta.json'), 'utf8')) as Meta) : null;
        const backup = setAside(slug);
        let said: string;
        try {
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
          writeOverview();
          said = await deploy(env);
        } catch (e) {
          restore(slug, backup);
          throw e;
        }
        if (backup) rmSync(backup, { recursive: true, force: true });
        return { url: pageUrl(site, slug), said };
      }),
    withdraw: async (slugArg, shared) => {
      const r = await attempt(async () => {
        const slug = checkSlug(slugArg);
        checkSite(shared, slug);
        const env = deployEnv();
        const backup = setAside(slug);
        let said: string;
        try {
          writeOverview();
          said = await deploy(env);
        } catch (e) {
          restore(slug, backup);
          throw e;
        }
        if (backup) rmSync(backup, { recursive: true, force: true });
        return { said };
      });
      return 'why' in r ? { why: t.notWithdrawn(r.why), said: r.said } : r;
    },
    version: async () => siteVersions(site),
  };
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
