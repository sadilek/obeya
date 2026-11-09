// Trusting a repository's commands (design: Trusting a repository's commands): what of its own
// files Obeya runs or contacts without a click, or its agents' sessions run outside Claude Code's
// permission checks, counts only as the owner last confirmed it. A command new on the default
// branch, or changed there, is held until the owner confirms it in "Configuration".

import type { SharedRead } from '../adapters';
import type { RepoCommands, RepoSettings, SharedSettings, TrustGroup } from '../core/types';

const GROUPS: TrustGroup[] = ['app', 'site', 'claude'];

/** The commands of a repository's `.obeya/settings.json` and Claude Code settings as read; a group it has none of is left out. */
export function commandsOf(read: Pick<SharedRead, 'settings' | 'claude'> | undefined): RepoCommands {
  const out: RepoCommands = {};
  const { stop, keep } = read?.settings?.app ?? {};
  if (stop?.trim() || keep?.trim()) out.app = { ...(stop?.trim() ? { stop } : {}), ...(keep?.trim() ? { keep } : {}) };
  const site = read?.settings?.demo?.site;
  if (site) out.site = { url: site.url, deploy: site.deploy, ...(site.env !== undefined ? { env: site.env } : {}), ...(site.headers ? { headers: site.headers } : {}), ...(site.publish ? { publish: site.publish } : {}) };
  if (read?.claude && Object.keys(read.claude).length) out.claude = read.claude;
  return out;
}

/** JSON with every object's keys in order, so that the same commands read the same however they were written down. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * The groups of `now` that do not count: each differs from what the owner confirmed (`trusted`;
 * nothing yet: every group is new), unless this machine's settings (`mine`) set all of it, which
 * then applies instead and needs no confirming.
 */
export function heldGroups(now: RepoCommands, trusted: RepoCommands | null, mine?: RepoSettings): TrustGroup[] {
  const covered = (g: TrustGroup) => (g === 'app' ? mine?.app?.stop !== undefined && mine.app.keep !== undefined : g === 'site' ? mine?.demo?.site !== undefined : false);
  return GROUPS.filter((g) => now[g] !== undefined && !covered(g) && !same(now[g], trusted?.[g]));
}

/** What is trusted once the owner trusted the groups `held` of `now`, as the dialog showed them: those groups as they are now, the others as trusted before. */
export function trustHeld(trusted: RepoCommands | null, now: RepoCommands, held: TrustGroup[]): RepoCommands {
  const next: RepoCommands = { ...trusted };
  for (const g of held) (next as Record<TrustGroup, unknown>)[g] = now[g];
  return next;
}

/** The repository's settings without what `held` holds: those fields then come from this machine or the defaults. */
export function withoutHeld(s: SharedSettings | undefined, held: TrustGroup[]): SharedSettings | undefined {
  if (!s) return s;
  const out = { ...s };
  if (held.includes('app') && s.app) {
    const { stop: _, keep: __, ...app } = s.app;
    if (Object.keys(app).length) out.app = app;
    else delete out.app;
  }
  if (held.includes('site') && s.demo) {
    const { site: _, ...demo } = s.demo;
    if (Object.keys(demo).length) out.demo = demo;
    else delete out.demo;
  }
  return out;
}

/**
 * The repository's `.obeya/settings.json` now holds this machine's values (`after`, taken over
 * for everyone, see `Config.takenOver`): a group of commands that holds only what the owner set
 * here (`mine`) or confirmed before is theirs and needs no confirming. Returns what is trusted then,
 * or null where that changes nothing.
 */
export function trustTakenOver(trusted: RepoCommands | null, after: SharedSettings, mine: RepoSettings | undefined): RepoCommands | null {
  const now = commandsOf({ settings: after });
  const own = commandsOf({ settings: { ...(mine?.app ? { app: mine.app } : {}), ...(mine?.demo ? { demo: mine.demo } : {}) } });
  const next: RepoCommands = { ...trusted };
  let changed = false;
  const app = now.app;
  // each of the two is the owner's or trusted; one that went, though trusted, needs confirming: a stop without its keep could stop what it kept
  const theirs = (f: 'stop' | 'keep') => (app?.[f] === undefined ? trusted?.app?.[f] === undefined : app[f] === own.app?.[f] || app[f] === trusted?.app?.[f]);
  if (app && !same(app, trusted?.app) && theirs('stop') && theirs('keep')) {
    next.app = app;
    changed = true;
  }
  if (now.site && !same(now.site, trusted?.site) && same(now.site, own.site)) {
    next.site = now.site;
    changed = true;
  }
  return changed ? next : null;
}
