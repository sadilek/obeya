// Pull requests on Forgejo and Gitea (Codeberg, a server of one's own), through their REST API with
// the login git has for the host. Tests use canned answers.

import { messageOf } from '../core/text';
import { editedAt, type Forge, type PrStatus, parsePrUrl, reviewComment, withBodyFile } from './forge';
import { spawnOutput } from './spawn';
import { gitCredential, gitTry, LOGIN_TTL } from './git';

/**
 * One call of the API below `<base>/api/v1/`; returns the parsed answer (undefined for an empty one)
 * and throws a `ForgeError` with the server's reason.
 */
export type Api = (cwd: string, base: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<unknown>;

export class ForgeError extends Error {
  constructor(
    /** The server's reason as it gave it. */
    readonly reason: string,
    readonly where: string,
    /** The HTTP status it answered with, where it answered. */
    readonly code?: number,
  ) {
    super(`${reason} (${where})`);
  }
}

/**
 * What to do where a host may be a GitHub Enterprise server rather than Forgejo: Obeya counts it
 * GitHub's only once gh is logged into it (`onGitHub`).
 */
const gheHint = (host: string) => `if ${host} is a GitHub Enterprise server, log gh in there: gh auth login --hostname ${host}`;

interface FjUser {
  login: string;
}
interface FjPr {
  title?: string;
  allow_maintainer_edit?: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha?: string | null;
  mergeable: boolean;
  draft?: boolean;
  body?: string | null;
  head: { sha: string; ref?: string; repo?: { clone_url?: string } | null };
  user: FjUser;
}
interface FjReview {
  id: number;
  user: FjUser | null;
  body: string;
  state: string;
  /** A request for changes dismissed since keeps its state. */
  dismissed?: boolean;
  submitted_at?: string;
  comments_count: number;
}
interface FjInline {
  id: number;
  user: FjUser | null;
  body: string;
  path: string;
  position?: number;
  original_position?: number;
  html_url: string;
  created_at?: string;
  pull_request_review_id?: number;
  resolver?: FjUser | null;
}
interface FjComment {
  id: number;
  user: FjUser | null;
  body: string;
  html_url: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * A time in UTC: Forgejo gives comments in the server's zone and commits in the committer's, and
 * Obeya compares times as text (`reviewStale`).
 */
const utc = (t?: string) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : (t ?? ''));

/** An account by its name; a deleted one is Forgejo's `ghost`. */
const login = (u: FjUser | null) => u?.login ?? 'ghost';

/** Open, closed or merged, in the words of `PrStatus`. */
const stateOf = (pr: FjPr): PrStatus['state'] => (pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN');

/** The pull request's API path (`repos/<owner>/<repo>/pulls/<n>`) and the server it is on. */
function where(url: string): { base: string; repo: string; pull: string; number: number } {
  const ref = parsePrUrl(url);
  if (ref?.forge !== 'forgejo') throw new Error(`not a Forgejo pull request URL: ${url}`);
  const repo = `repos/${ref.owner}/${ref.repo}`;
  return { base: ref.base, repo, pull: `${repo}/pulls/${ref.number}`, number: ref.number };
}

/**
 * The server and repository of a git remote on Forgejo (`https://host/owner/repo.git`, `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git`); over ssh, the server is the host's https.
 */
export function remoteRepo(remote: string): { base: string; repo: string } | null {
  const scp = !remote.includes('://') && /^(?:[^@/]+@)?([^/:]+):\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  if (scp) return { base: `https://${scp[1]}`, repo: `repos/${scp[2]}/${scp[3]}` };
  let u: URL;
  try {
    u = new URL(remote);
  } catch {
    return null;
  }
  const m = /^(.*?)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) return null;
  const base = u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}${m[1]}` : `https://${u.hostname}`;
  return { base, repo: `repos/${m[2]}/${m[3]}` };
}

/** Forgejo or Gitea through an API runner (the real server, or canned answers in tests). */
export const makeForgejoForge = (forgejo: Api, origin: (cwd: string) => Promise<string | null>): Forge => {
  /** The API, where a server answers that it has no such API path (as GitHub Enterprise does) with what to do if it is GitHub's. */
  const api: Api = (cwd, base, method, path, body) =>
    forgejo(cwd, base, method, path, body).catch((e: unknown) => {
      throw e instanceof ForgeError && e.code === 404 ? new ForgeError(`${e.reason}; ${gheHint(new URL(base).host)}`, e.where, e.code) : e;
    });
  /** By PR: the head Forgejo could not merge at the last look. */
  const unmergeable = new Map<string, string>();
  /**
   * Every page of a list (the server's page size may be smaller than asked); `pick` finds the list
   * in an answer that wraps it.
   */
  const all = async <T>(cwd: string, base: string, path: string, pick = (answer: unknown) => answer as T[] | undefined): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const got = pick(await api(cwd, base, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=50&page=${page}`));
      if (!got?.length) break;
      out.push(...got);
    }
    return out;
  };
  /** The server and repository of the checkout's `origin`, for a call that needs one: throws where there is none. */
  const originRepo = async (cwd: string) => {
    const remote = await origin(cwd);
    const at = remote ? remoteRepo(remote) : null;
    if (!at) throw new Error(`no Forgejo repository at origin: ${remote ?? 'none'}`);
    return at;
  };
  return {
    async status(cwd, url) {
      const { base, repo, pull, number } = where(url);
      // side by side where one call does not need another's answer: each is a round trip to the server
      const [pr, allReviews, conversation, commits, viewer] = await Promise.all([
        api(cwd, base, 'GET', pull) as Promise<FjPr>,
        all<FjReview>(cwd, base, `${pull}/reviews`),
        // every page: a request on a later one must not let the PR pass for ready
        all<FjComment>(cwd, base, `${repo}/issues/${number}/comments`),
        all<{ commit: { committer: { date: string } }; parents?: unknown[] }>(cwd, base, `${pull}/commits?verification=false&files=false`),
        // the account the login is for: on a review card, its comments are the owner's own
        (api(cwd, base, 'GET', 'user') as Promise<FjUser | undefined>).then((u) => u?.login, () => undefined),
      ]);
      const reviews = allReviews.filter((r) => r.state !== 'PENDING');
      const inline = (
        await Promise.all(reviews.filter((r) => r.comments_count > 0).map((r) => api(cwd, base, 'GET', `${pull}/reviews/${r.id}/comments`) as Promise<FjInline[]>))
      ).flat();
      // every page: a check on a later one that failed must not let the PR pass for ready
      type Status = { context: string; status: string; target_url?: string };
      const statuses = await all<Status>(cwd, base, `${repo}/commits/${pr.head.sha}/status`, (answer) => (answer as { statuses?: Status[] } | undefined)?.statuses);
      // merging the base in brings changes reviewed there: the PR's own changes are its other commits
      const changedAt = commits
        .filter((c) => (c.parents?.length ?? 1) < 2)
        .map((c) => utc(c.commit.committer.date))
        .reduce<string | undefined>((a, d) => (!a || d > a ? d : a), undefined);
      // Forgejo keeps no threads: a thread is the comments on one line of one file, the first of them opens it
      const threads = new Map<string, FjInline[]>();
      for (const c of [...inline].sort((a, b) => utc(a.created_at).localeCompare(utc(b.created_at)) || a.id - b.id)) {
        const key = `${c.path}:${c.position ?? 0}:${c.original_position ?? 0}`;
        threads.set(key, [...(threads.get(key) ?? []), c]);
      }
      // Forgejo says only whether it can merge now: not while it still checks a new head (seconds to
      // minutes), nor on a conflict; a head it still cannot merge at the next look has a conflict
      const conflict = !pr.mergeable && !pr.draft && unmergeable.get(url) === pr.head.sha;
      if (pr.mergeable || pr.draft) unmergeable.delete(url);
      else unmergeable.set(url, pr.head.sha);
      return {
        state: stateOf(pr),
        mergeable: pr.mergeable ? 'MERGEABLE' : conflict ? 'CONFLICTING' : 'UNKNOWN',
        mergeState: pr.draft ? 'DRAFT' : pr.mergeable ? 'CLEAN' : conflict ? 'DIRTY' : 'UNKNOWN',
        head: pr.head.sha,
        ...(changedAt ? { changedAt } : {}),
        author: login(pr.user),
        ...(viewer ? { viewer } : {}),
        ...(pr.merged && pr.merge_commit_sha ? { mergeCommit: pr.merge_commit_sha } : {}),
        checks: statuses.map((s) => ({
          name: s.context,
          state: s.status === 'pending' ? 'pending' : ['success', 'skipped', 'warning'].includes(s.status) ? 'success' : 'failure',
          ...(s.target_url ? { url: s.target_url } : {}),
        })),
        comments: [
          ...conversation.map((c) => ({
            id: `c${c.id}`,
            author: login(c.user),
            body: c.body,
            ...(c.created_at ? { at: utc(c.created_at) } : {}),
            ...editedAt(c.created_at, utc(c.updated_at)),
            url: c.html_url,
          })),
          ...reviews.flatMap((r) => reviewComment({ id: r.id, author: login(r.user), body: r.body, at: utc(r.submitted_at), state: r.dismissed ? 'DISMISSED' : r.state }) ?? []),
          ...[...threads.values()].flatMap(([first, ...replies]) =>
            [first!, ...replies].map((c) => ({
              id: `i${c.id}`,
              author: login(c.user),
              body: c.body,
              ...(c.created_at ? { at: utc(c.created_at) } : {}),
              path: c.path,
              ...((c.position || c.original_position) ? { line: c.position || c.original_position } : {}),
              url: c.html_url,
              ...(c.pull_request_review_id ? { round: String(c.pull_request_review_id) } : {}),
              ...(c === first ? { resolved: [first, ...replies].some((r) => r.resolver) } : { replyTo: `i${first!.id}` }),
            })),
          ),
        ],
      } satisfies PrStatus;
    },
    async body(cwd, url) {
      const { base, pull } = where(url);
      return ((await api(cwd, base, 'GET', pull)) as FjPr).body ?? '';
    },
    async setBody(cwd, url, body) {
      const { base, pull } = where(url);
      await api(cwd, base, 'PATCH', pull, { body });
    },
    async close(cwd, url) {
      const { base, pull } = where(url);
      await api(cwd, base, 'PATCH', pull, { state: 'closed' });
    },
    async merge(cwd, url, head) {
      const { base, repo, pull } = where(url);
      // the repository's own merge styles; squash first where it allows several
      const allows = (await api(cwd, base, 'GET', repo)) as Record<string, boolean | undefined>;
      const styles = [
        ['squash', 'allow_squash_merge'],
        ['merge', 'allow_merge_commits'],
        ['rebase', 'allow_rebase'],
        ['rebase-merge', 'allow_rebase_explicit'],
        ['fast-forward-only', 'allow_fast_forward_only_merge'],
      ] as const;
      const style = styles.find(([, allowed]) => allows[allowed])?.[0] ?? 'squash';
      try {
        await api(cwd, base, 'POST', `${pull}/merge`, { Do: style, head_commit_id: head });
      } catch (e) {
        throw new Error(e instanceof ForgeError ? e.reason : messageOf(e));
      }
      try {
        return ((await api(cwd, base, 'GET', pull)) as FjPr).merge_commit_sha || undefined;
      } catch {
        // merged all the same: the first fetch after it stands in for the commit (Workers.merged)
        return undefined;
      }
    },
    async visibility(cwd) {
      const remote = await origin(cwd);
      const at = remote ? remoteRepo(remote) : null;
      if (!at) return null;
      const r = (await api(cwd, at.base, 'GET', at.repo)) as { private?: boolean; internal?: boolean } | undefined;
      return r && typeof r.private === 'boolean' ? (r.private || r.internal ? 'private' : 'public') : null;
    },
    async urlOf(cwd, n) {
      const at = await originRepo(cwd);
      return `${at.base}/${at.repo.slice('repos/'.length)}/pulls/${n}`;
    },
    async contribution(cwd, url) {
      const { base, pull } = where(url);
      const pr = (await api(cwd, base, 'GET', pull)) as FjPr;
      return {
        title: pr.title ?? '',
        author: login(pr.user),
        state: stateOf(pr),
        head: pr.head.sha,
        canModify: !!pr.allow_maintainer_edit,
        ...(pr.head.repo?.clone_url ? { headRepo: pr.head.repo.clone_url } : {}),
        ...(pr.head.ref ? { headRef: pr.head.ref } : {}),
      };
    },
    async comment(cwd, url, body) {
      const { base, repo, number } = where(url);
      return ((await api(cwd, base, 'POST', `${repo}/issues/${number}/comments`, { body })) as { html_url?: string } | undefined)?.html_url || undefined;
    },
    async requestChanges(cwd, url, body) {
      const { base, pull } = where(url);
      return ((await api(cwd, base, 'POST', `${pull}/reviews`, { body, event: 'REQUEST_CHANGES' })) as { html_url?: string } | undefined)?.html_url || undefined;
    },
    async open(cwd, pr) {
      const at = await originRepo(cwd);
      return ((await api(cwd, at.base, 'POST', `${at.repo}/pulls`, pr)) as { html_url: string }).html_url;
    },
  };
};

/**
 * Logins by workspace and repository, read from git for a while: each round of the watcher makes
 * several calls, some side by side, which wait for the one reading.
 */
const logins = new Map<string, { auth: Promise<string>; at: number }>();

/**
 * The repository's URL as git knows it for its login: `origin` where it is that repository over
 * http(s) (a helper keyed by the repository's path, `credential.useHttpPath`, finds what a push used),
 * else the repository's https URL on the server.
 */
async function repoUrl(cwd: string, base: string, path: string): Promise<string> {
  const repo = /^repos\/[^/]+\/[^/?]+/.exec(path)?.[0];
  const remote = await originOf(cwd);
  const at = remote && /^https?:/.test(remote) ? remoteRepo(remote) : null;
  if (remote && at && at.base === base && at.repo.toLowerCase() === repo?.toLowerCase()) return remote;
  return repo ? `${base}/${repo.slice('repos/'.length)}.git` : base;
}

/**
 * The login git has for the repository (`git credential fill`: the keychain, the credential manager,
 * whatever the machine set up, a repository's own helper too), as an Authorization header, and how
 * to forget it once the server refuses it. Never asks: where git has none, it fails.
 */
async function loginFor(cwd: string, base: string, path: string): Promise<{ auth: string; forget: () => void }> {
  const url = await repoUrl(cwd, base, path);
  const key = `${cwd}\n${url}`;
  let known = logins.get(key);
  const fresh = !known || Date.now() - known.at >= LOGIN_TTL;
  if (fresh) logins.set(key, (known = { auth: credential(cwd, base, url), at: Date.now() }));
  const entry = known!;
  // only this login goes: one read since in its place stays
  const forget = () => void (logins.get(key) === entry && logins.delete(key));
  // a failure is not kept: the next call asks git again
  if (fresh) entry.auth.catch(forget);
  return { auth: await entry.auth, forget };
}

async function credential(cwd: string, base: string, url: string): Promise<string> {
  const { host } = new URL(base);
  const fields = await gitCredential(cwd, `url=${url}`);
  const password = fields?.get('password');
  if (!password) throw new Error(`git has no login for ${host}: store an access token of yours there as git's password for ${host} (a push over https with it does); ${gheHint(host)}`);
  return `Basic ${Buffer.from(`${fields!.get('username') ?? ''}:${password}`).toString('base64')}`;
}

/** The API over curl (on every system Obeya runs on), the login in its config on stdin, never on the command line. */
const curlApi: Api = async (cwd, base, method, path, body) => {
  const { auth, forget } = await loginFor(cwd, base, path);
  const call = (file?: string) =>
    spawnOutput(
      [
        'curl',
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        '30',
        '--config',
        '-',
        '--request',
        method,
        '--write-out',
        '\n%{http_code}',
        ...(file ? ['--header', 'Content-Type: application/json', '--data-binary', `@${file}`] : []),
        `${base}/api/v1/${path}`,
      ],
      { cwd, stdin: Buffer.from(`header = "Authorization: ${auth}"\nheader = "Accept: application/json"\n`) },
    );
  const r = body === undefined ? await call() : await withBodyFile(JSON.stringify(body), call);
  if (r.code !== 0) throw new ForgeError(r.stderr.trim() || `curl failed (${r.code})`, `${method} ${path}`);
  const out = r.stdout;
  const cut = out.lastIndexOf('\n');
  const code = Number(out.slice(cut + 1));
  const text = out.slice(0, cut).trim();
  if (code === 401) forget();
  if (code >= 300) {
    let reason = '';
    try {
      reason = (JSON.parse(text) as { message?: string }).message ?? '';
    } catch {}
    throw new ForgeError(reason || `HTTP ${code}`, `${method} ${path}`, code);
  }
  return text ? JSON.parse(text) : undefined;
};

/** The URL of a repository's `origin`; null without one. */
export const originOf = (cwd: string): Promise<string | null> => gitTry(cwd, 'remote', 'get-url', 'origin');

export const forgejoForge = makeForgejoForge(curlApi, originOf);
