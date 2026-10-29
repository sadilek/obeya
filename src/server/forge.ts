// Where pull requests live. GitHub through the `gh` CLI, Forgejo and Gitea through their API
// (`forgejo.ts`); tests use a fake.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrReviewEntry, PrThread } from '../core/types';
import { enterpriseServer, ghHosts, onGitHub, remoteHost } from './repo';
import { spawnOutput } from './spawn';

export interface PrStatus {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /**
   * GitHub's verdict on merging now (`mergeStateStatus`): `CLEAN` when nothing stands in the way,
   * `BLOCKED` while branch protection waits for something (an approval, a required check), `BEHIND`,
   * `DIRTY`, `UNSTABLE`, `DRAFT`, `UNKNOWN` while GitHub still works it out.
   */
  mergeState?: string;
  /** The commit the checks ran on. */
  head: string;
  /**
   * When the PR's own changes last changed: the committer date of its newest commit that is not a
   * merge (merging the base in brings changes reviewed there). A review written before it has not
   * seen them.
   */
  changedAt?: string;
  checks: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  /**
   * Conversation comments, review summaries and inline review comments, oldest first. An inline
   * comment's `round` is the review it came with; a reply names its thread's first comment in
   * `replyTo`, and that first comment says whether the thread is `resolved`. `edited`: when a
   * conversation comment was last changed (a review bot rewrites its summary each round).
   */
  comments: {
    id: string;
    author: string;
    body: string;
    at?: string;
    edited?: string;
    path?: string;
    line?: number;
    url?: string;
    round?: string;
    replyTo?: string;
    resolved?: boolean;
  }[];
  /** Who opened the PR (the owner's account; the worker's own replies carry it too; on a review card, the contributor's). */
  author: string;
  /** The account Obeya acts as on the forge (the owner's), where the forge says: on a review card, comments of its own. */
  viewer?: string;
  /** Once merged: the commit the merge put on the base branch. */
  mergeCommit?: string;
}

/**
 * A forge's calls go over the network and take seconds when it is slow: each runs in the background,
 * so the server answers meanwhile.
 */
export interface Forge {
  status(cwd: string, url: string): Promise<PrStatus>;
  /** The PR's description. */
  body(cwd: string, url: string): Promise<string>;
  /** Replaces the PR's description. */
  setBody(cwd: string, url: string, body: string): Promise<void>;
  /**
   * Merges the PR, if its head is still `head`, the way the repository allows; throws with GitHub's
   * reason when it cannot. Returns the commit the merge put on the base branch, where GitHub says.
   */
  merge(cwd: string, url: string, head: string): Promise<string | void>;
  /** Opens a pull request from the pushed branch `head` onto `base`; returns its URL. */
  open(cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<string>;
  /** The URL of pull request `n` of the repository whose checkout `cwd` is (its `origin`). */
  urlOf(cwd: string, n: number): Promise<string>;
  /** A pull request someone outside opened, as a review card takes it on. */
  contribution(cwd: string, url: string): Promise<ContributionInfo>;
  /** Writes `body` as a comment in the PR's conversation; returns the comment's URL where the forge says. */
  comment(cwd: string, url: string, body: string): Promise<string | void>;
  /** A review of the PR that asks for changes (on GitHub „Request changes“), with `body`; returns its URL where the forge says. */
  requestChanges(cwd: string, url: string, body: string): Promise<string | void>;
  /** Whether the repository at `cwd`'s origin is public, as its forge says; null where it cannot tell. */
  visibility?(cwd: string): Promise<'public' | 'private' | null>;
}

/** A pull request a review card takes on (`Forge.contribution`). */
export interface ContributionInfo {
  title: string;
  author: string;
  state: PrStatus['state'];
  /** Its head commit. */
  head: string;
  /** Maintainers may push to its branch (GitHub's `maintainerCanModify`, Forgejo's `allow_maintainer_edit`). */
  canModify: boolean;
  /** Its branch's repository (a fork's, usually) and the branch, for pushing onto it. */
  headRepo?: string;
  headRef?: string;
}

/**
 * A pull request URL: on GitHub `https://<host>/<owner>/<repo>/pull/<n>` (github.com, or a GitHub
 * Enterprise server, whose PRs have the same path), on Forgejo or Gitea (Codeberg, a server of one's
 * own, perhaps below a path) `https://<host>/<owner>/<repo>/pulls/<n>`. `github` says which hosts
 * are GitHub's; the host decides, since agents write one forge's path on the other (Codeberg
 * answers `/pull/` with 404). `base`: the server's address; `host`: GitHub's host as gh names it;
 * `url`: the address as the forge writes it.
 */
export function parsePrUrl(
  url: string,
  github: (url: string) => boolean = onGitHub,
): { forge: 'github' | 'forgejo'; base: string; host: string; owner: string; repo: string; number: number; url: string } | null {
  const m = /^(https?:\/\/[^/\s]+(?:\/[^/\s]+)*?)\/([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)\/?$/.exec(url.trim());
  if (!m || !URL.canParse(m[1]!)) return null;
  const [, base, owner, repo, n] = m as unknown as [string, string, string, string, string];
  const at = new URL(base);
  const host = at.host.toLowerCase();
  const number = Number(n);
  if (github(base)) {
    return at.pathname === '/' ? { forge: 'github', base: `https://${host}`, host, owner, repo, number, url: `https://${host}/${owner}/${repo}/pull/${number}` } : null;
  }
  return { forge: 'forgejo', base, host, owner, repo, number, url: `${base}/${owner}/${repo}/pulls/${number}` };
}

/** Whether a git remote (https, ssh, scp-like, or a path) is the repository `owner/repo`. */
export const sameRepo = (remote: string, owner: string, repo: string) =>
  remote
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join('/') === `${owner}/${repo}`.toLowerCase();

/**
 * The forge a pull request is on, by its URL; one is opened on the forge of the repository's
 * `origin` (GitHub where `onGitHub` says so, else Forgejo).
 */
export const routedForge = (github: Forge, forgejo: Forge, origin: (cwd: string) => Promise<string | null>, onGitHub: (remote: string) => boolean): Forge => {
  const of = (url: string) => (parsePrUrl(url, onGitHub)?.forge === 'forgejo' ? forgejo : github);
  return {
    status: (cwd, url) => of(url).status(cwd, url),
    body: (cwd, url) => of(url).body(cwd, url),
    setBody: (cwd, url, body) => of(url).setBody(cwd, url, body),
    merge: (cwd, url, head) => of(url).merge(cwd, url, head),
    contribution: (cwd, url) => of(url).contribution(cwd, url),
    urlOf: async (cwd, n) => {
      const remote = await origin(cwd);
      return (remote && !onGitHub(remote) ? forgejo : github).urlOf(cwd, n);
    },
    comment: (cwd, url, body) => of(url).comment(cwd, url, body),
    requestChanges: (cwd, url, body) => of(url).requestChanges(cwd, url, body),
    open: async (cwd, pr) => {
      const remote = await origin(cwd);
      return (remote && !onGitHub(remote) ? forgejo : github).open(cwd, pr);
    },
    visibility: async (cwd) => {
      const remote = await origin(cwd);
      if (!remote) return null;
      const f = onGitHub(remote) ? github : forgejo;
      return f.visibility ? f.visibility(cwd) : null;
    },
  };
};

/**
 * Where gh runs: the directory, and the GitHub host (github.com or an Enterprise server) and owner
 * of the repository it works on, where known.
 */
export interface GhAt {
  cwd: string;
  host?: string;
  owner?: string;
}

/**
 * The host and owner of a GitHub repository by its remote URL (https, ssh or scp-like) on
 * github.com or a GitHub Enterprise server gh is logged into (`onGitHub`), or none for any other.
 */
export function githubRepo(remote: string, hosts: () => string[] = ghHosts): { host: string; owner: string } | undefined {
  const url = remote.trim();
  const host = remoteHost(url);
  if (!host || !onGitHub(url, hosts)) return undefined;
  const path = url.includes('://') ? url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '') : url.replace(/^[^:]*:\/?/, '');
  const owner = /^([^/]+)\/[^/]+?\/?$/.exec(path)?.[1];
  // ssh.github.com, GitHub's SSH over port 443, is github.com to gh
  return owner ? { host: host.endsWith('.github.com') ? 'github.com' : host, owner } : undefined;
}


/** How long a token gh keeps for an account is taken as it stands. */
const TOKEN_TTL = 10 * 60_000;
/** By gh program, host and account: its token as gh hands it out (asked once for calls side by side), and when it was asked. */
const tokens = new Map<string, { token: Promise<string | null>; at: number }>();

/**
 * How long one gh call may take before it counts as failed: GitHub slow to answer holds up only the
 * card it reads for, and only that long.
 */
const GH_TIMEOUT = 60_000;

/**
 * gh's environment for a repository of `owner` on `host`: gh sent to that host (`GH_HOST`; else
 * `gh api` would ask github.com), and the token of gh's login there for that account where it
 * has one, so that a private repository of the owner is seen whichever account gh has active on
 * this machine (another one finds no such repository); else gh as it runs anyway (an
 * organisation's repository, say).
 */
async function ghEnv(program: string, { host, owner }: Omit<GhAt, 'cwd'>, timeout: number): Promise<NodeJS.ProcessEnv | undefined> {
  if (!host) return undefined;
  let token: string | null = null;
  if (owner) {
    const key = `${program}\n${host}\n${owner}`;
    let known = tokens.get(key);
    if (!known || Date.now() - known.at > TOKEN_TTL) {
      // without the tokens in the environment, which gh would hand back instead of the account's own
      const { GH_TOKEN: _, GITHUB_TOKEN: __, GH_ENTERPRISE_TOKEN: ___, GITHUB_ENTERPRISE_TOKEN: ____, ...plain } = process.env;
      const asked = spawnOutput([program, 'auth', 'token', '--hostname', host, '--user', owner], { env: plain, stdin: 'ignore', timeout }).then(
        (r) => (r.code === 0 && r.stdout.trim()) || null,
        () => null,
      );
      known = { token: asked, at: Date.now() };
      tokens.set(key, known);
    }
    token = await known.token;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: host };
  if (token) {
    // the account's token in place of any the environment has for the host
    const [name, other] = enterpriseServer(host) ? ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] : ['GH_TOKEN', 'GITHUB_TOKEN'];
    delete env[other];
    env[name] = token;
  }
  return env;
}

/**
 * A runner for `makeGhForge` that runs gh (`program`; a stand-in in tests) without blocking the
 * server: each call is a round trip to GitHub, a second when all is well and many when GitHub or
 * the machine is slow, in which the server would answer nothing else.
 */
export const ghCli =
  (program = 'gh', timeout = GH_TIMEOUT) =>
  async ({ cwd, ...at }: GhAt, ...args: string[]): Promise<string> => {
    const env = await ghEnv(program, at, timeout);
    const r = await spawnOutput([program, ...args], { cwd, stdin: 'ignore', timeout, ...(env ? { env } : {}) });
    if (r.signal) throw new Error(`gh ${args.slice(0, 3).join(' ')}: no answer within ${timeout / 1000} s`);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${r.stderr.trim()}`);
    return r.stdout;
  };

/** The host and owner of the GitHub repository a checkout's `origin` is, where it is one. */
async function originRepo(cwd: string): Promise<{ host: string; owner: string } | undefined> {
  const r = await spawnOutput(['git', '-C', cwd, 'remote', 'get-url', 'origin'], { stdin: 'ignore' });
  return r.code === 0 ? githubRepo(r.stdout) : undefined;
}

/** A pull request URL read as GitHub's, whatever its host: `routedForge` sent it to gh. */
const githubPr = (url: string) => parsePrUrl(url, () => true);

/** Where gh runs for the pull request at `url`. */
const atPr = (cwd: string, url: string): GhAt => {
  const ref = githubPr(url);
  return ref ? { cwd, host: ref.host, owner: ref.owner } : { cwd };
};

/** The pull request at `url`; throws for a URL that is no GitHub pull request's. */
function prRef(url: string) {
  const ref = githubPr(url);
  if (!ref) throw new Error(`not a GitHub pull request URL: ${url}`);
  return ref;
}

/** Runs `f` with `body` in a file: a long description as an argument would pass Windows' limit on a command line. */
export async function withBodyFile<T>(body: string, f: (file: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-pr-body-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    return await f(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface GhPr {
  state: PrStatus['state'];
  mergeable: PrStatus['mergeable'];
  mergeStateStatus?: string;
  headRefOid: string;
  mergeCommit?: { oid: string } | null;
  author: { login: string };
  statusCheckRollup: { __typename: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[];
  comments: { id: string; author: { login: string }; body: string; url: string; createdAt?: string }[];
  reviews: { id: string; author: { login: string }; body: string; submittedAt?: string }[];
}

/** GitHub through a `gh` runner (the real CLI, or canned output in tests). */
export const makeGhForge = (
  run: (at: GhAt, ...args: string[]) => string | Promise<string>,
  repoOf: (cwd: string) => Promise<{ host: string; owner: string } | undefined> = originRepo,
): Forge => ({
  async status(cwd, url) {
    const ref = prRef(url);
    const at = atPr(cwd, url);
    // side by side: each is a round trip to GitHub
    const [pr, inline, threads] = await Promise.all([
      run(at, 'pr', 'view', url, '--json', 'state,mergeable,mergeStateStatus,headRefOid,mergeCommit,author,statusCheckRollup,comments,reviews'),
      run(at, 'api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, '--paginate'),
      run(
        at,
        'api',
        'graphql',
        '-F',
        `owner=${ref.owner}`,
        '-F',
        `repo=${ref.repo}`,
        '-F',
        `number=${ref.number}`,
        '-f',
        'query=query($owner: String!, $repo: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } } comments(last: 100) { nodes { id updatedAt } } commits(last: 30) { nodes { commit { committedDate parents { totalCount } } } } } } }',
      ),
    ]);
    return ghStatus(pr, inline, threads);
  },
  async body(cwd, url) {
    return (JSON.parse(await run(atPr(cwd, url), 'pr', 'view', url, '--json', 'body')) as { body: string }).body;
  },
  async setBody(cwd, url, body) {
    await withBodyFile(body, (file) => run(atPr(cwd, url), 'pr', 'edit', url, '--body-file', file));
  },
  async open(cwd, pr) {
    const at: GhAt = { cwd, ...(await repoOf(cwd)) };
    // gh prints the new pull request's URL last
    const out = await withBodyFile(pr.body, (file) => run(at, 'pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body-file', file));
    return out.trim().split('\n').at(-1)!.trim();
  },
  async urlOf(cwd, n) {
    const at: GhAt = { cwd, ...(await repoOf(cwd)) };
    return (await run(at, 'pr', 'view', String(n), '--json', 'url', '--jq', '.url')).trim();
  },
  async visibility(cwd) {
    const at: GhAt = { cwd, ...(await repoOf(cwd)) };
    const v = (await run(at, 'repo', 'view', '--json', 'visibility', '--jq', '.visibility')).trim().toUpperCase();
    return v === 'PUBLIC' ? 'public' : v ? 'private' : null;
  },
  async contribution(cwd, url) {
    const ref = prRef(url);
    const pr = JSON.parse(
      await run(atPr(cwd, url), 'pr', 'view', url, '--json', 'title,author,state,headRefOid,headRefName,headRepository,headRepositoryOwner,maintainerCanModify'),
    ) as { title: string; author: { login: string }; state: PrStatus['state']; headRefOid: string; headRefName?: string; headRepository?: { name: string } | null; headRepositoryOwner?: { login: string } | null; maintainerCanModify?: boolean };
    const owner = pr.headRepositoryOwner?.login;
    const repo = pr.headRepository?.name;
    return {
      title: pr.title,
      author: pr.author.login,
      state: pr.state,
      head: pr.headRefOid,
      canModify: !!pr.maintainerCanModify,
      ...(owner && repo ? { headRepo: `https://${ref.host}/${owner}/${repo}.git` } : {}),
      ...(pr.headRefName ? { headRef: pr.headRefName } : {}),
    };
  },
  async comment(cwd, url, body) {
    // gh prints the new comment's URL
    const out = await withBodyFile(body, (file) => run(atPr(cwd, url), 'pr', 'comment', url, '--body-file', file));
    return out.trim().split('\n').at(-1)?.trim() || undefined;
  },
  async requestChanges(cwd, url, body) {
    const ref = prRef(url);
    // through the API, which names the review's URL; `gh pr review` does not
    const out = await withBodyFile(body, (file) =>
      run(atPr(cwd, url), 'api', '-X', 'POST', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, '-f', 'event=REQUEST_CHANGES', '-F', `body=@${file}`, '--jq', '.html_url'),
    );
    return out.trim() || undefined;
  },
  async merge(cwd, url, head) {
    const ref = prRef(url);
    const at = atPr(cwd, url);
    // the repository's own merge methods (some allow squash only); squash first where it allows several
    const allows = JSON.parse(await run(at, 'api', `repos/${ref.owner}/${ref.repo}`, '--jq', '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}')) as Record<string, boolean>;
    const method = (['squash', 'merge', 'rebase'] as const).find((m) => allows[m] !== false) ?? 'squash';
    // no --delete-branch: that also switches branches in the workspace; the repository deletes merged branches or not
    await run(at, 'pr', 'merge', url, `--${method}`, '--match-head-commit', head);
    try {
      return (await run(at, 'pr', 'view', url, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid')).trim() || undefined;
    } catch {
      // merged all the same: the first fetch after it stands in for the commit (Workers.merged)
      return undefined;
    }
  },
});

/** A PR's status from gh's three answers: the PR, its inline comments, and GraphQL's threads and commits. */
function ghStatus(prOut: string, inlineOut: string, threadsOut: string): PrStatus {
  const pr = JSON.parse(prOut) as GhPr;
  const inline = JSON.parse(inlineOut) as {
    id: number;
    user: { login: string };
    body: string;
    path: string;
    line: number | null;
    html_url: string;
    created_at?: string;
    pull_request_review_id?: number | null;
    in_reply_to_id?: number | null;
  }[];
  // whether a thread is resolved and when a comment was last changed only GraphQL says; a thread
  // is known by its first comment
  const threads = JSON.parse(threadsOut) as {
    data?: {
      viewer?: { login: string };
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes: { isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[] };
          comments?: { nodes: { id: string; updatedAt: string }[] };
          commits?: { nodes: { commit: { committedDate: string; parents: { totalCount: number } } }[] };
        };
      };
    };
  };
  const resolved = new Set(
    (threads.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter((t) => t.isResolved).map((t) => t.comments.nodes[0]?.databaseId),
  );
  const changedAt = (threads.data?.repository?.pullRequest?.commits?.nodes ?? []).findLast((n) => n.commit.parents.totalCount < 2)?.commit.committedDate;
  const updated = new Map((threads.data?.repository?.pullRequest?.comments?.nodes ?? []).map((c) => [c.id, c.updatedAt]));
  // an edit within a minute of writing is part of writing it
  const edited = (id: string, at?: string) => {
    const u = updated.get(id);
    return u && at && Date.parse(u) - Date.parse(at) > 60_000 ? { edited: u } : {};
  };
  const checks = (pr.statusCheckRollup ?? []).map((c) => {
    const name = c.name ?? c.context ?? 'check';
    const verdict = (c.conclusion ?? c.state ?? '').toUpperCase();
    const done = c.__typename === 'CheckRun' ? c.status === 'COMPLETED' : verdict !== 'PENDING' && verdict !== 'EXPECTED';
    const state: PrStatus['checks'][number]['state'] = !done
      ? 'pending'
      : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)
        ? 'success'
        : 'failure';
    return { name, state, ...((c.detailsUrl ?? c.targetUrl) ? { url: c.detailsUrl ?? c.targetUrl } : {}) };
  });
  return {
    state: pr.state,
    mergeable: pr.mergeable,
    ...(pr.mergeStateStatus ? { mergeState: pr.mergeStateStatus } : {}),
    head: pr.headRefOid,
    ...(changedAt ? { changedAt } : {}),
    author: pr.author.login,
    ...(threads.data?.viewer?.login ? { viewer: threads.data.viewer.login } : {}),
    ...(pr.state === 'MERGED' && pr.mergeCommit?.oid ? { mergeCommit: pr.mergeCommit.oid } : {}),
    checks,
    comments: [
      ...pr.comments.map((c) => ({
        id: `c${c.id}`,
        author: c.author.login,
        body: c.body,
        ...(c.createdAt ? { at: c.createdAt } : {}),
        ...edited(c.id, c.createdAt),
        url: c.url,
      })),
      ...pr.reviews
        .filter((r) => r.body.trim())
        .map((r) => ({ id: `r${r.id}`, author: r.author.login, body: r.body, ...(r.submittedAt ? { at: r.submittedAt } : {}) })),
      // the REST API names an app `<name>[bot]`, `gh pr view` plain `<name>`: one name for both
      ...inline.map((c) => ({
        id: `i${c.id}`,
        author: c.user.login.replace(/\[bot\]$/, ''),
        body: c.body,
        ...(c.created_at ? { at: c.created_at } : {}),
        path: c.path,
        ...(c.line ? { line: c.line } : {}),
        url: c.html_url,
        ...(c.pull_request_review_id ? { round: String(c.pull_request_review_id) } : {}),
        ...(c.in_reply_to_id ? { replyTo: `i${c.in_reply_to_id}` } : { resolved: resolved.has(c.id) }),
      })),
    ],
  };
}

export const ghForge = makeGhForge(ghCli());

/**
 * What the card shows of a pull request's review, oldest first: each round a reviewer left comments
 * on the code in, with the replies in each thread, and the conversation between the rounds.
 * Comments by `skip` (bots that are not reviewers) are left out; `mine` marks `self`: the PR's
 * author, which is the worker writing in the owner's name, or on a review card the owner's account.
 */
export function reviewOf(s: PrStatus, skip: string[] = [], self = s.author): PrReviewEntry[] {
  const shown = s.comments.filter((c) => !skip.includes(c.author));
  const mine = (author: string) => (author === self ? { mine: true } : {});
  const threads = new Map<string, PrThread>();
  const rounds = new Map<string, Extract<PrReviewEntry, { threads: PrThread[] }>>();
  const entries: PrReviewEntry[] = [];
  for (const c of shown) {
    if (c.replyTo || !c.id.startsWith('i')) continue;
    const thread: PrThread = {
      author: c.author,
      ...mine(c.author),
      body: readable(c.body),
      at: c.at ?? '',
      ...(c.path ? { path: c.path } : {}),
      ...(c.line ? { line: c.line } : {}),
      ...(c.url ? { url: c.url } : {}),
      resolved: !!c.resolved,
      replies: [],
    };
    threads.set(c.id, thread);
    const key = c.round ?? c.id;
    const round = rounds.get(key);
    if (round) round.threads.push(thread);
    else {
      const r = { author: c.author, ...mine(c.author), at: c.at ?? '', threads: [thread] };
      rounds.set(key, r);
      entries.push(r);
    }
  }
  for (const c of shown) {
    const reply = { author: c.author, ...mine(c.author), body: readable(c.body), at: c.at ?? '' };
    if (c.replyTo) threads.get(c.replyTo)?.replies.push(reply);
    // a comment rewritten since stands where it was last changed
    else if (!c.id.startsWith('i')) entries.push({ ...reply, ...(c.edited ? { at: c.edited, edited: true } : {}), ...(c.url ? { url: c.url } : {}) });
  }
  for (const r of rounds.values()) r.at = r.threads.reduce((a, t) => (t.at && t.at < a ? t.at : a), r.at);
  return entries.filter((e) => 'threads' in e || e.body).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Whether the pull request only waits for the merge: GitHub sees nothing in the way, every
 * check has passed, every review thread is resolved, a reviewer who wrote has seen the PR's own
 * latest changes, and whoever was asked for another look has answered since the author last asked (a
 * review bot answers a re-review by rewriting its summary, often without a new comment). Comments
 * by `skip` do not count as an answer.
 */
export function readyToMerge(s: PrStatus, skip: string[] = []): boolean {
  if (s.state !== 'OPEN' || s.mergeable !== 'MERGEABLE') return false;
  if (s.mergeState !== 'CLEAN' && s.mergeState !== 'HAS_HOOKS') return false;
  if (s.checks.some((c) => c.state !== 'success')) return false;
  const others = reviewers(s, skip);
  if (others.some((c) => c.id.startsWith('i') && !c.replyTo && !c.resolved)) return false;
  if (reviewStale(s, skip)) return false;
  const asked = lastAsked(s);
  return !asked || others.some((c) => (c.edited ?? c.at ?? '') > asked);
}

/**
 * Whether a reviewer wrote on the pull request, but nothing since its own changes last changed
 * (a merge of the base does not count): the last verdict is about an older state. A PR merged on Greptile's 3/5 of its first commit
 * (2026-10-02): the fix pushed after it was never reviewed, as nobody asked for another look.
 */
export function reviewStale(s: PrStatus, skip: string[] = []): boolean {
  if (!s.changedAt) return false;
  const last = reviewers(s, skip).reduce((a, c) => latest(a, c.edited ?? c.at), '');
  return !!last && last < s.changedAt;
}

/** When the author last asked for another look (a conversation comment of theirs). */
export function lastAsked(s: PrStatus): string {
  return s.comments.filter((c) => c.author === s.author && c.id.startsWith('c')).reduce((a, c) => latest(a, c.at), '');
}

/**
 * The confidence a reviewer gave last, in a comment rewritten or written latest (Greptile's
 * "Confidence Score: 3/5" in its summary); none when no reviewer gives one.
 */
export function confidence(s: PrStatus, skip: string[] = []): { score: number; of: number; by: string } | undefined {
  let found: { score: number; of: number; by: string; at: string } | undefined;
  for (const c of reviewers(s, skip)) {
    const m = /Confidence Score:\s*(\d+)\s*\/\s*(\d+)/i.exec(c.body);
    const at = c.edited ?? c.at ?? '';
    if (m && (!found || at >= found.at)) found = { score: Number(m[1]), of: Number(m[2]), by: c.author, at };
  }
  return found && { score: found.score, of: found.of, by: found.by };
}

const reviewers = (s: PrStatus, skip: string[]) => s.comments.filter((c) => c.author !== s.author && !skip.includes(c.author));
const latest = (a: string, b?: string) => (b && b > a ? b : a);

const MAX_BODY = 3000;
/** Where `readable` took a part out. */
const GONE = '\u0000';

/**
 * A comment as text the card renders: review bots write HTML (badges, folded prompts for other
 * agents, diagrams) into their Markdown; the badges' names stay, code and folded parts go.
 */
export function readable(body: string): string {
  let t = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details>[\s\S]*?<\/details>/gi, `\n${GONE}\n`)
    .replace(/<picture>[\s\S]*?<\/picture>/gi, '')
    .replace(/```[\s\S]*?(```|$)/g, `\n${GONE}\n`)
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<h\d[^>]*>([\s\S]*?)<\/h\d>/gi, '\n### $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1');
  // headings become bold lines; a heading whose section went (a diagram, say) goes with it
  const lines = t.split('\n').map((l) => l.trimEnd());
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (!h) {
      if (line.trim() !== GONE) out.push(line);
      continue;
    }
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (next && next.trim() !== GONE && !/^#{1,6}\s/.test(next.trim()) && h[1]!.trim()) out.push(`**${h[1]!.trim()}**`);
  }
  t = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY).trimEnd()} …` : t;
}
