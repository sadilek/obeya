// The owner's personal demo site: one per person, kept in Obeya's home (`personal-site.json`), not
// in any repository. Every repository without a site of its own shares there, and every one whose
// site this machine cannot deploy to (a contributor's Obeya on Obeya's own repository, say). On
// Cloudflare Pages or from a private GitHub repository it is unlisted (site.ts): no overview, no
// feed, each page under a random part of its URL that is drawn once per card, the manifest under a
// secret path only the owner's machines know. From a public GitHub repository, whose files anyone
// can list, it is listed like a repository's site.
//
// A private repository shares there only once the owner ticked it (`private`), so nothing of a
// private project goes out unasked. A repository the owner ticked for it (`approved`) puts each
// approved card's latest demo there by itself, as a repository's site does with `publish`. A
// second machine joins with a connection code, which carries the site and its credentials.

import type { DemoSite } from '../core/types';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { GITHUB_PAGES, GITHUB_PAGES_MAX, parseEnv, SITES_DIR } from './site-hosts';
import { siteKey } from './site';

export const PERSONAL_FILE = 'personal-site.json';

/** Where the personal site is hosted. */
export type SiteHost = 'cloudflare' | 'github';

const shape = z
  .object({
    host: z.enum(['cloudflare', 'github']),
    /** Where it is served, e.g. `https://obeya-ada.pages.dev`. */
    url: z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/),
    /** The host's project: a Cloudflare Pages project's name, or the GitHub repository (`owner/name`); a word of the deploy line, so nothing else. */
    project: z.string().regex(/^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/),
    /**
     * An unlisted site's directory the manifest is in: only the owner's machines know it. Without
     * it the site is listed (a public GitHub repository, whose files anyone can list anyway).
     */
    secret: z.string().regex(/^[a-z0-9]{16,64}$/).optional(),
    /** The deploy's credentials, a `KEY=value` file under Obeya's home; none where the machine's own login deploys. */
    env: z.string().optional(),
    /** The private repositories (their checkouts' paths) the owner allowed to share here. */
    private: z.array(z.string()).optional(),
    /** The repositories (their checkouts' paths) whose approved cards put their latest demo here by themselves. */
    approved: z.array(z.string()).optional(),
  })
  .strict();

export type PersonalSite = z.infer<typeof shape>;

/** The file as last read, by its path: read again once it changed (sharing asks for it often). */
const cache = new Map<string, { stamp: string; site: PersonalSite | null }>();

/** The personal site this machine is connected to; null without one, or with a file that is not one. */
export function readPersonal(home: string): PersonalSite | null {
  const file = join(home, PERSONAL_FILE);
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const known = cache.get(file);
  if (known?.stamp === stamp) return known.site;
  let site: PersonalSite | null = null;
  try {
    const p = shape.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (p.success) site = p.data;
  } catch {}
  cache.set(file, { stamp, site });
  return site;
}

export function writePersonal(home: string, site: PersonalSite | null) {
  const file = join(home, PERSONAL_FILE);
  cache.delete(file);
  if (!site) return rmSync(file, { force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(file, `${JSON.stringify(shape.parse(site), null, 2)}\n`);
}

/** The personal site as a demo site: how it is deployed, and the host's file limit. */
export function personalDemoSite(p: PersonalSite): DemoSite {
  return {
    title: 'Demos',
    url: p.url,
    ...hostDeploy(p.host, p.project),
    ...(p.env ? { env: p.env } : {}),
  };
}

/** How a site set up at a host is deployed: a Cloudflare Pages project as Obeya's own site is, a GitHub repository by the deploy Obeya builds in, with GitHub's file limit. */
export function hostDeploy(host: SiteHost, project: string): Pick<DemoSite, 'deploy' | 'maxFile'> {
  return host === 'cloudflare'
    ? { deploy: `bunx wrangler@4 pages deploy {dir} --project-name ${project} --branch main --commit-dirty=true` }
    : { deploy: `${GITHUB_PAGES} ${project}`, maxFile: GITHUB_PAGES_MAX };
}

/** Whether the repository at `path` may share on the personal site: a public one always, a private one once ticked. */
export const allowedHere = (p: PersonalSite, path: string, isPublic: boolean) => isPublic || (p.private ?? []).some((x) => resolve(x) === resolve(path));

/** Whether the repository at `path` puts each approved card's latest demo on the personal site by itself. */
export const approvedHere = (p: PersonalSite, path: string) => (p.approved ?? []).some((x) => resolve(x) === resolve(path));

/** Ticks or unticks a private repository for the personal site. */
export const allowPrivate = (home: string, path: string, on: boolean) => tick(home, 'private', path, on);

/** Ticks or unticks a repository for sharing its approved demos on the personal site by themselves. */
export const shareApproved = (home: string, path: string, on: boolean) => tick(home, 'approved', path, on);

function tick(home: string, list: 'private' | 'approved', path: string, on: boolean): PersonalSite {
  const p = readPersonal(home);
  if (!p) throw new Error('no personal demo site on this machine');
  const others = (p[list] ?? []).filter((x) => resolve(x) !== resolve(path));
  const paths = on ? [...others, resolve(path)] : others;
  const { [list]: _, ...rest } = p;
  const next: PersonalSite = paths.length ? { ...rest, [list]: paths } : rest;
  writePersonal(home, next);
  return next;
}

/**
 * A random lower-case name of at least `bits` bits: the part of a page's URL nobody guesses, and the
 * manifest's directory. 36 letters and digits carry about 5.17 bits each.
 */
export function newToken(bits = 80): string {
  const n = Math.ceil(bits / Math.log2(36));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  // drawn without a bias: bytes past the last whole round of 36 are thrown away
  while (out.length < n) for (const b of randomBytes(n * 2)) if (b < 252 && out.length < n) out += alphabet[b % 36];
  return out;
}

/** Where the env file of a host's credentials goes for a site, relative to Obeya's home. */
export const envFileFor = (url: string, host: SiteHost) => `${SITES_DIR}/${siteKey(url)}/${host}.env`;

/** Writes `KEY=value` lines to a file under Obeya's home, readable by its owner alone. */
export function writeEnv(home: string, rel: string, env: Record<string, string>) {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
    { mode: 0o600 },
  );
}

const CODE_PREFIX = 'obeya-site:';

/**
 * The connection code for another machine of the owner's: the site with its secret path and the
 * deploy's credentials (none where the machine's own login deploys: wrangler's or gh's).
 */
export function connectionCode(home: string, p: PersonalSite): string {
  const env = p.env && existsSync(join(home, p.env)) ? parseEnv(readFileSync(join(home, p.env), 'utf8')) : undefined;
  const { private: _, approved: ___, env: __, ...site } = p;
  return CODE_PREFIX + Buffer.from(JSON.stringify({ ...site, ...(env ? { credentials: env } : {}) })).toString('base64url');
}

/** Connects this machine to the personal site a code names; the site, and whether it brought credentials. */
export function connect(home: string, code: string): { site: PersonalSite; credentials: boolean } {
  const text = code.trim();
  if (!text.startsWith(CODE_PREFIX)) throw new Error('not a connection code of a personal demo site');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('the connection code is incomplete; copy it again');
  }
  const { credentials, ...rest } = raw as { credentials?: Record<string, unknown> };
  const parsed = shape.omit({ env: true, private: true, approved: true }).safeParse(rest);
  if (!parsed.success) throw new Error('the connection code is incomplete; copy it again');
  const env = credentials && typeof credentials === 'object' ? Object.fromEntries(Object.entries(credentials).filter((e): e is [string, string] => typeof e[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]))) : {};
  const site: PersonalSite = { ...parsed.data };
  if (Object.keys(env).length) {
    site.env = envFileFor(site.url, site.host);
    writeEnv(home, site.env, env);
  }
  // the repositories ticked here stay ticked
  const before = readPersonal(home);
  if (before?.url === site.url) {
    if (before.private?.length) site.private = before.private;
    if (before.approved?.length) site.approved = before.approved;
  }
  writePersonal(home, site);
  return { site, credentials: !!site.env };
}
