// Setting up demo sites from the configuration: the owner's personal site (Configuration → Demos),
// and a repository's own site ("Set up a demo site" at its settings). Each setup runs in the
// background, since a login in the browser may take minutes; the dialog follows its lines.

import { basename, resolve } from 'node:path';
import type { PersonalSiteView, SiteSetupJob, DemoSite } from '../core/types';
import { BadRequest } from './board';
import { allowPrivate, connect, connectionCode, envFileFor, hostDeploy, newToken, type PersonalSite, personalDemoSite, readPersonal, shareApproved, type SiteHost, writeEnv, writePersonal } from './personal-site';
import { siteMissing } from './site';
import { cloudflareAccounts, type Exec, setupCloudflare, setupGithub, SetupRefused } from './site-hosts';
import { messageOf } from '../core/text';

export interface SiteSetupOptions {
  home: string;
  /** The personal site changed: every canvas tells its cards where they share now. */
  changed: () => void;
  /**
   * The repositories on the canvases: their checkouts, names, whether public, whether they have a
   * site of their own this machine deploys to, whether they share on the personal site, and whether
   * their site's settings publish on approval.
   */
  repos?: () => { path: string; name: string; isPublic: boolean; ownSite: boolean; onPersonal?: boolean; siteApproved?: boolean }[];
  /** Who runs Obeya here, for the personal site's name at Cloudflare. */
  user?: string;
  /** Runs wrangler, gh and git; a stand-in in tests. */
  x?: Exec;
  /** How long to wait (ms, step by step) for a new site's address to answer; a stand-in in tests. */
  wait?: number[];
}

/** The jobs: `personal`, or a repository's by its checkout. */
export class SiteSetup {
  private jobs = new Map<string, SiteSetupJob>();

  constructor(private o: SiteSetupOptions) {}

  view(): PersonalSiteView {
    const p = readPersonal(this.o.home);
    const job = this.jobs.get(PERSONAL);
    return {
      site: p
        ? {
            host: p.host,
            url: p.url,
            project: p.project,
            example: `${p.url.replace(/\/+$/, '')}/${p.secret ? `${newToken()}/` : ''}…/`,
            ...(p.secret ? {} : { listed: true as const }),
            ...(siteMissing(this.o.home, personalDemoSite(p)) ? { needs: p.env! } : {}),
          }
        : null,
      ...(job ? { job } : {}),
      privateRepos: this.privateRepos(p),
      approvedRepos: this.approvedRepos(p),
      cloudflareAccounts: this.accounts(),
    };
  }

  /** The private repositories on the canvases, and those ticked that are not on them, each once. */
  private privateRepos(p: PersonalSite | null): PersonalSiteView['privateRepos'] {
    const ticked = (p?.private ?? []).map((x) => resolve(x));
    const repos = this.o.repos?.() ?? [];
    const out: PersonalSiteView['privateRepos'] = [];
    for (const r of repos) {
      const path = resolve(r.path);
      if (r.isPublic || out.some((x) => x.path === path)) continue;
      out.push({ path, name: r.name, allowed: ticked.includes(path), ...(r.ownSite ? { ownSite: true as const } : {}) });
    }
    for (const path of ticked) if (!out.some((x) => x.path === path)) out.push({ path, name: basename(path), allowed: true });
    return out;
  }

  /** The repositories on the canvases that share on the personal site, and those ticked to share there with the approval that are not on them, each once. */
  private approvedRepos(p: PersonalSite | null): PersonalSiteView['approvedRepos'] {
    const ticked = (p?.approved ?? []).map((x) => resolve(x));
    const out: PersonalSiteView['approvedRepos'] = [];
    for (const r of this.o.repos?.() ?? []) {
      const path = resolve(r.path);
      if (!r.onPersonal || out.some((x) => x.path === path)) continue;
      out.push({ path, name: r.name, on: !!r.siteApproved || ticked.includes(path), ...(r.siteApproved ? { bySettings: true as const } : {}) });
    }
    for (const path of ticked) if (!out.some((x) => x.path === path)) out.push({ path, name: basename(path), on: true });
    return out;
  }

  /** The Cloudflare accounts of the sites this machine deploys to, by site, for a new site to go into. */
  accounts(): string[] {
    return cloudflareAccounts(this.o.home).map((a) => a.site);
  }

  /** "Set up": the personal site at the host, unlisted. */
  setupPersonal(input: unknown): PersonalSiteView {
    const host = hostOf(input);
    const account = accountOf(input);
    const token = tokenOf(input);
    // a public repository: any GitHub account, and a listed site, since anyone can list its files
    const open = host === 'github' && (input as { public?: unknown } | null)?.public === true;
    if (readPersonal(this.o.home)) throw new BadRequest('invalid', 'this machine has a personal demo site already; remove it first');
    this.run(PERSONAL, host, async (log) => {
      // at GitHub, a private repository keeps the site unlisted; a public one lists its files, so its site is listed
      const name = host === 'cloudflare' ? `obeya-${slug(this.o.user ?? '') || 'demos'}`.slice(0, 50) : 'obeya-demos';
      const r = await this.atHost(host, { name, private: !open, account, token }, log);
      const site: PersonalSite = { host, url: r.url, project: r.project, ...(open ? {} : { secret: newToken(128) }) };
      if (r.env) writeEnv(this.o.home, (site.env = envFileFor(r.url, host)), r.env);
      writePersonal(this.o.home, site);
      this.o.changed();
      log(`Ready: ${site.url}`);
      return {};
    });
    return this.view();
  }

  /** "Connect to an existing site": the personal site another machine of the owner's set up, by its code. */
  connect(input: unknown): PersonalSiteView {
    const code = (input as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !code.trim()) throw new BadRequest('invalid', 'expected { code }');
    try {
      connect(this.o.home, code);
    } catch (e) {
      throw new BadRequest('invalid', messageOf(e));
    }
    this.jobs.delete(PERSONAL);
    this.o.changed();
    return this.view();
  }

  /** The code that connects another machine: the site and its credentials. */
  code(): { code: string } {
    const p = readPersonal(this.o.home);
    if (!p) throw new BadRequest('invalid', 'no personal demo site on this machine');
    return { code: connectionCode(this.o.home, p) };
  }

  /** "Remove from this machine": this machine no longer shares there; the pages online stay, as does the project at the host. */
  remove(): PersonalSiteView {
    writePersonal(this.o.home, null);
    this.jobs.delete(PERSONAL);
    this.o.changed();
    return this.view();
  }

  /** Ticks or unticks a private repository for the personal site. */
  allow(input: unknown): PersonalSiteView {
    return this.tick(input, allowPrivate);
  }

  /** Ticks or unticks a repository for sharing each approved card's latest demo on the personal site by itself. */
  approved(input: unknown): PersonalSiteView {
    return this.tick(input, shareApproved);
  }

  /** Ticks or unticks a repository in one of the personal site's lists (`{ path, on }`). */
  private tick(input: unknown, set: (home: string, path: string, on: boolean) => unknown): PersonalSiteView {
    const { path, on } = (input ?? {}) as { path?: unknown; on?: unknown };
    if (typeof path !== 'string' || typeof on !== 'boolean') throw new BadRequest('invalid', 'expected { path, on }');
    try {
      set(this.o.home, path, on);
    } catch (e) {
      throw new BadRequest('invalid', messageOf(e));
    }
    this.o.changed();
    return this.view();
  }

  /** "Set up a demo site" at a repository's settings: a listed site at the host, its `demo.site` for the dialog to take in. */
  setupRepo(input: unknown): SiteSetupJob | null {
    const { path, host: h, name } = (input ?? {}) as { path?: unknown; host?: unknown; name?: unknown };
    if (typeof path !== 'string' || !path) throw new BadRequest('invalid', 'expected { path, host }');
    const host = hostOf({ host: h });
    const account = accountOf(input);
    const token = tokenOf(input);
    const title = typeof name === 'string' && name.trim() ? name.trim() : basename(path);
    const project = `${slug(title) || 'demos'}-demos`.slice(0, 50);
    this.run(path, host, async (log) => {
      // listed: the repository behind it at GitHub may be public, as everything on the site is
      const r = await this.atHost(host, { name: project, private: false, account, token }, log);
      const site: DemoSite = { title: `${title} demos`, url: r.url, ...hostDeploy(host, r.project) };
      if (r.env) writeEnv(this.o.home, (site.env = envFileFor(r.url, host)), r.env);
      log(`Ready: ${site.url}`);
      return { site };
    });
    return this.jobs.get(path) ?? null;
  }

  /**
   * A new site at the host: a Cloudflare Pages project (in the account named, or with the token
   * given), or a GitHub repository with Pages (`private` or public). Its address and project, and
   * at Cloudflare the credentials for its env file where it took some.
   */
  private atHost(host: SiteHost, o: { name: string; private: boolean; account?: string | undefined; token?: Record<string, string> | undefined }, log: (line: string) => void): Promise<{ url: string; project: string; env?: Record<string, string> }> {
    const seams = { ...(this.o.x ? { x: this.o.x } : {}), ...(this.o.wait ? { wait: this.o.wait } : {}) };
    return host === 'cloudflare'
      ? setupCloudflare({ home: this.o.home, name: o.name, log, ...(o.account ? { account: o.account } : {}), ...(o.token ? { token: o.token } : {}), ...seams })
      : setupGithub({ name: o.name, private: o.private, log, ...seams });
  }

  /** A repository's setup, as far as it got; null without one. */
  repoJob(path: string): SiteSetupJob | null {
    return this.jobs.get(path) ?? null;
  }

  /** The dialog took in a repository's finished setup. */
  doneWith(path: string) {
    if (!this.jobs.get(path)?.running) this.jobs.delete(path);
  }

  private run(key: string, host: SiteHost, fn: (log: (line: string) => void) => Promise<{ site?: DemoSite }>) {
    if (this.jobs.get(key)?.running) throw new BadRequest('invalid', 'a setup is running already');
    const job: SiteSetupJob = { host, running: true, lines: [] };
    this.jobs.set(key, job);
    const log = (line: string) => {
      job.lines = [...job.lines, line.slice(0, 400)].slice(-12);
    };
    fn(log).then(
      ({ site }) => {
        job.running = false;
        if (site) job.site = site;
      },
      (e) => {
        job.running = false;
        job.error = messageOf(e);
        if (e instanceof SetupRefused && e.offer) job.offer = e.offer;
        console.error(`Obeya: setting up a demo site at ${host} failed: ${job.error}`);
      },
    );
  }
}

const PERSONAL = 'personal';

function hostOf(input: unknown): SiteHost {
  const host = (input as { host?: unknown } | null)?.host;
  if (host !== 'cloudflare' && host !== 'github') throw new BadRequest('invalid', 'expected { host: "cloudflare" | "github" }');
  return host;
}

/** The Cloudflare account to set up in, by the site whose credentials it takes; none: the machine's own `wrangler login`. */
function accountOf(input: unknown): string | undefined {
  const a = (input as { account?: unknown } | null)?.account;
  return typeof a === 'string' && a ? a : undefined;
}

/** An API token of another Cloudflare account, with its account's id where given: the new site's credentials. */
function tokenOf(input: unknown): Record<string, string> | undefined {
  const { token, accountId } = (input ?? {}) as { token?: unknown; accountId?: unknown };
  if (typeof token !== 'string' || !token.trim()) return undefined;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token.trim())) throw new BadRequest('invalid', 'that is not a Cloudflare API token');
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw new BadRequest('invalid', 'a Cloudflare account id is 32 hexadecimal characters');
  return { CLOUDFLARE_API_TOKEN: token.trim(), ...(id ? { CLOUDFLARE_ACCOUNT_ID: id } : {}) };
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
