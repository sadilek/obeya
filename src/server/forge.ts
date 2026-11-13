// Where pull requests live. GitHub through the `gh` CLI, Forgejo and Gitea through their API
// (`forgejo.ts`); tests use a fake.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterpriseServer, ghHosts, onGitHub, parseRemote } from './repo';
import { spawnOutput } from './spawn';
import { gitTry, LOGIN_TTL } from './git';
import type { GithubLogin } from './hosts';
import type { AdoptedPr } from '../core/types';

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
    /** A review's verdict, where it gives one: approved, changes requested, or such a review dismissed since. */
    verdict?: 'approved' | 'changes' | 'dismissed';
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
  /** Closes the pull request without merging it, its branch left as it is. */
  close(cwd: string, url: string): Promise<void>;
  /** Opens a pull request from the pushed branch `head` onto `base`; returns its URL. */
  open(cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<string>;
  /** The URL of pull request `n` of the repository whose checkout `cwd` is (its `origin`). */
  urlOf(cwd: string, n: number): Promise<string>;
  /** A pull request someone outside opened, as a review card takes it on. */
  contribution(cwd: string, url: string): Promise<ContributionInfo>;
  /** Writes `body` as a comment in the PR's conversation; returns the comment's URL where the forge says. */
  comment(cwd: string, url: string, body: string): Promise<string | void>;
  /** A review of the PR that asks for changes (on GitHub "Request changes"), with `body`; returns its URL where the forge says. */
  requestChanges(cwd: string, url: string, body: string): Promise<string | void>;
  /** Whether the repository at `cwd`'s origin is public, as its forge says; null where it cannot tell. */
  visibility?(cwd: string): Promise<'public' | 'private' | null>;
  /**
   * The open pull request from `branch` of the repository at `cwd`'s origin: in that repository, else
   * in the one it is a fork of (the original); null where there is none. `AdoptedPr` says where it
   * is and whether the owner's account may merge it there.
   */
  branchPr?(cwd: string, branch: string): Promise<AdoptedPr | null>;
  /** Whether the account Obeya acts as may merge the pull request at `url` (it may push to its repository); null where the forge cannot tell. */
  mayMerge?(cwd: string, url: string): Promise<boolean | null>;
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
  // a login, query or fragment in the server's address (`https://elsewhere#@github.com`) would let
  // the host it is told by differ from the one it is sent to
  if (!m || /[@?#\\]/.test(m[1]!) || !URL.canParse(m[1]!)) return null;
  const [, , owner, repo, n] = m as unknown as [string, string, string, string, string];
  const at = new URL(m[1]!);
  const host = at.host;
  const number = Number(n);
  // told by the host it goes to, as the URL parser reads it
  if (github(`${at.protocol}//${host}`)) {
    return at.pathname === '/' ? { forge: 'github', base: `https://${host}`, host, owner, repo, number, url: `https://${host}/${owner}/${repo}/pull/${number}` } : null;
  }
  const base = `${at.protocol}//${host}${at.pathname.replace(/\/$/, '')}`;
  return { forge: 'forgejo', base, host, owner, repo, number, url: `${base}/${owner}/${repo}/pulls/${number}` };
}

/** Whether a git remote (https, ssh, scp-like, or a path) is the repository `owner/repo`. */
export const sameRepo = (remote: string, owner: string, repo: string) =>
  parseRemote(remote).path.split(/[/\\]/).slice(-2).join('/').toLowerCase() === `${owner}/${repo}`.toLowerCase();

/**
 * Where work that landed on the default branch without a pull request shows on the forge of
 * `remote` (https, ssh or scp-like): its commit `to`, or with `from` the comparison over its
 * commits `from..to`. The path is GitHub's, Forgejo's and Gitea's; GitLab puts it below `/-/`.
 * None for a repository on this machine.
 */
export function landedUrl(remote: string, to: string, from?: string): string | null {
  const { host, web } = parseRemote(remote);
  if (!host || !web) return null;
  const repo = `${web}${host.includes('gitlab') ? '/-' : ''}`;
  return from ? `${repo}/compare/${from}...${to}` : `${repo}/commit/${to}`;
}

/**
 * The forge a pull request is on, by its URL; one is opened on the forge of the repository's
 * `origin` (GitHub where `onGitHub` says so, else Forgejo).
 */
export const routedForge = (github: Forge, forgejo: Forge, origin: (cwd: string) => Promise<string | null>, onGitHub: (remote: string) => boolean): Forge => {
  const of = (url: string) => (parsePrUrl(url, onGitHub)?.forge === 'forgejo' ? forgejo : github);
  /** The forge of the checkout's `origin`; none without one. */
  const byOrigin = async (cwd: string) => {
    const remote = await origin(cwd);
    return remote ? (onGitHub(remote) ? github : forgejo) : null;
  };
  return {
    status: (cwd, url) => of(url).status(cwd, url),
    body: (cwd, url) => of(url).body(cwd, url),
    setBody: (cwd, url, body) => of(url).setBody(cwd, url, body),
    merge: (cwd, url, head) => of(url).merge(cwd, url, head),
    close: (cwd, url) => of(url).close(cwd, url),
    contribution: (cwd, url) => of(url).contribution(cwd, url),
    urlOf: async (cwd, n) => ((await byOrigin(cwd)) ?? github).urlOf(cwd, n),
    comment: (cwd, url, body) => of(url).comment(cwd, url, body),
    requestChanges: (cwd, url, body) => of(url).requestChanges(cwd, url, body),
    open: async (cwd, pr) => ((await byOrigin(cwd)) ?? github).open(cwd, pr),
    visibility: async (cwd) => {
      const f = await byOrigin(cwd);
      return f?.visibility ? f.visibility(cwd) : null;
    },
    branchPr: async (cwd, branch) => {
      const f = await byOrigin(cwd);
      return f?.branchPr ? f.branchPr(cwd, branch) : null;
    },
    mayMerge: async (cwd, url) => {
      const f = of(url);
      return f.mayMerge ? f.mayMerge(cwd, url) : null;
    },
  };
};

/**
 * Where gh runs: the directory, and the GitHub host (github.com or an Enterprise server), owner and
 * name of the repository it works on, where known.
 */
export interface GhAt {
  cwd: string;
  host?: string;
  owner?: string;
  repo?: string;
}

/** A GitHub repository: its host, owner and name. */
export interface GithubRepo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * The host, owner and name of a GitHub repository by its remote URL (https, ssh or scp-like) on
 * github.com or a GitHub Enterprise server gh is logged into (`onGitHub`), or none for any other.
 */
export function githubRepo(remote: string, hosts: () => string[] = ghHosts): GithubRepo | undefined {
  const { host, path } = parseRemote(remote);
  if (!host || !onGitHub(remote.trim(), hosts)) return undefined;
  const m = /^([^/]+)\/([^/]+)$/.exec(path);
  // ssh.github.com, GitHub's SSH over port 443, is github.com to gh
  return m ? { host: host.endsWith('.github.com') ? 'github.com' : host, owner: m[1]!, repo: m[2]! } : undefined;
}

/**
 * The GitHub account the owner set for a repository on this machine (`RepoConfig.githubAccount`), by
 * the repository on GitHub: gh works on it, and on its pull requests, as that account.
 */
const accounts = new Map<string, string>();
const repoKey = ({ host, owner, repo }: GithubRepo) => `${host}/${owner}/${repo}`.toLowerCase();

/** gh works on `repo` as `account` from now on; returns what ends that. */
export function useGithubAccount(repo: GithubRepo, account: string): () => void {
  const key = repoKey(repo);
  accounts.set(key, account);
  return () => {
    if (accounts.get(key) === account) accounts.delete(key);
  };
}

/** The account gh works as on `owner/repo` on `host`: the one set for it, else the owner's own login (a personal repository). */
const accountOf = ({ host, owner, repo }: { host: string; owner?: string; repo?: string }) => (owner && repo && accounts.get(repoKey({ host, owner, repo }))) || owner;


/** By gh program, host and account: its token as gh hands it out (asked once for calls side by side), and when it was asked. */
const tokens = new Map<string, { token: Promise<string | null>; at: number }>();

/**
 * The token of gh's login as `account` on `host` (`gh auth token --user`), asked once per
 * `LOGIN_TTL`; null where gh has no such login.
 */
function accountToken(program: string, host: string, account: string, timeout: number): Promise<string | null> {
  const key = `${program}\n${host}\n${account}`;
  let known = tokens.get(key);
  if (!known || Date.now() - known.at > LOGIN_TTL) {
    // without the tokens in the environment, which gh would hand back instead of the account's own
    const { GH_TOKEN: _, GITHUB_TOKEN: __, GH_ENTERPRISE_TOKEN: ___, GITHUB_ENTERPRISE_TOKEN: ____, ...plain } = process.env;
    const asked = spawnOutput([program, 'auth', 'token', '--hostname', host, '--user', account], { env: plain, stdin: 'ignore', timeout }).then(
      (r) => (r.code === 0 && r.stdout.trim()) || null,
      () => null,
    );
    known = { token: asked, at: Date.now() };
    tokens.set(key, known);
  }
  return known.token;
}

/** The variable gh reads a token for `host` from, and the other one it would read instead. */
const tokenVariables = (host: string) => (enterpriseServer(host) ? (['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const) : (['GH_TOKEN', 'GITHUB_TOKEN'] as const));

/**
 * The login of `account` on `host`, read in the background and again once older than `LOGIN_TTL`,
 * the one read before standing meanwhile: its token (for a host's clones, `GithubLogin`), and `env`,
 * the variable that has gh (and git through gh's credential helper) work as that account in an
 * agent's environment. None until it is read, or where gh has no such login; `ready` settles once it
 * was read for the first time.
 */
export function accountLogin(host: string, account: string, program = 'gh', timeout = GH_TIMEOUT): GithubLogin & { env: () => Record<string, string> | undefined; ready: () => Promise<unknown> } {
  let token: string | null = null;
  let read: Promise<unknown> | undefined;
  let at = 0;
  const refresh = () => {
    at = Date.now();
    read = accountToken(program, host, account, timeout).then((t) => (token = t));
    return read;
  };
  const login = () => {
    if (!read || Date.now() - at > LOGIN_TTL) void refresh();
    return token ?? undefined;
  };
  return Object.assign(login, {
    env: () => {
      const t = login();
      return t ? { [tokenVariables(host)[0]]: t } : undefined;
    },
    ready: () => read ?? refresh(),
  });
}

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
async function ghEnv(program: string, { host, owner, repo }: Omit<GhAt, 'cwd'>, timeout: number): Promise<NodeJS.ProcessEnv | undefined> {
  if (!host) return undefined;
  return accountEnv(host, accountOf({ host, owner, repo }), program, timeout);
}

/**
 * gh's environment (and git's, where its credential helper is gh's) for working as `account` on
 * `host`: the account's token where gh has a login for it, else gh as it runs anyway.
 */
export async function accountEnv(host: string, account: string | undefined, program = 'gh', timeout = GH_TIMEOUT): Promise<NodeJS.ProcessEnv> {
  const token = account ? await accountToken(program, host, account, timeout) : null;
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: host };
  if (token) {
    // the account's token in place of any the environment has for the host
    const [name, other] = tokenVariables(host);
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
async function originRepo(cwd: string): Promise<GithubRepo | undefined> {
  const remote = await gitTry(cwd, 'remote', 'get-url', 'origin');
  return remote !== null ? githubRepo(remote) : undefined;
}

/** A pull request URL read as GitHub's, whatever its host: `routedForge` sent it to gh. */
const githubPr = (url: string) => parsePrUrl(url, () => true);

/**
 * The pull request's address as gh takes it: one recorded with Forgejo's `/pulls/` (an Enterprise
 * PR reported before gh was logged in there) gh would reject.
 */
const ghUrl = (url: string) => githubPr(url)?.url ?? url;

/** Where gh runs for the pull request at `url`. */
const atPr = (cwd: string, url: string): GhAt => {
  const ref = githubPr(url);
  return ref ? { cwd, host: ref.host, owner: ref.owner, repo: ref.repo } : { cwd };
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
  reviews: { id: string; author: { login: string }; body: string; submittedAt?: string; state?: string }[];
}

/** GitHub through a `gh` runner (the real CLI, or canned output in tests). */
export const makeGhForge = (
  run: (at: GhAt, ...args: string[]) => string | Promise<string>,
  repoOf: (cwd: string) => Promise<GithubRepo | { host: string; owner: string } | undefined> = originRepo,
): Forge => {
  /** Where gh runs for the repository of the checkout's `origin`. */
  const atOrigin = async (cwd: string): Promise<GhAt> => ({ cwd, ...(await repoOf(cwd)) });
  return {
    async status(cwd, url) {
      const ref = prRef(url);
      const at = atPr(cwd, url);
      // side by side: each is a round trip to GitHub
      const [pr, inline, threads] = await Promise.all([
        run(at, 'pr', 'view', ghUrl(url), '--json', 'state,mergeable,mergeStateStatus,headRefOid,mergeCommit,author,statusCheckRollup,comments,reviews'),
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
      return (JSON.parse(await run(atPr(cwd, url), 'pr', 'view', ghUrl(url), '--json', 'body')) as { body: string }).body;
    },
    async setBody(cwd, url, body) {
      await withBodyFile(body, (file) => run(atPr(cwd, url), 'pr', 'edit', ghUrl(url), '--body-file', file));
    },
    async close(cwd, url) {
      await run(atPr(cwd, url), 'pr', 'close', ghUrl(url));
    },
    async open(cwd, pr) {
      const at = await atOrigin(cwd);
      // gh prints the new pull request's URL last
      const out = await withBodyFile(pr.body, (file) => run(at, 'pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body-file', file));
      return out.trim().split('\n').at(-1)!.trim();
    },
    async urlOf(cwd, n) {
      return (await run(await atOrigin(cwd), 'pr', 'view', String(n), '--json', 'url', '--jq', '.url')).trim();
    },
    async visibility(cwd) {
      const v = (await run(await atOrigin(cwd), 'repo', 'view', '--json', 'visibility', '--jq', '.visibility')).trim().toUpperCase();
      return v === 'PUBLIC' ? 'public' : v ? 'private' : null;
    },
    async branchPr(cwd, branch) {
      const at = await atOrigin(cwd);
      if (!at.owner || !at.repo) return null;
      const own = `${at.owner}/${at.repo}`;
      const repo = JSON.parse(await run(at, 'api', `repos/${own}`, '--jq', '{parent: .parent.full_name, push: .permissions.push}')) as { parent?: string | null; push?: boolean | null };
      // the pull request of a branch of origin's: in origin's repository, else from there against the original
      for (const full of [own, ...(repo.parent ? [repo.parent] : [])]) {
        const open = JSON.parse(await run(at, 'api', `repos/${full}/pulls?state=open&head=${encodeURIComponent(`${at.owner}:${branch}`)}`, '--jq', '[.[] | {url: .html_url, number: .number}]')) as { url: string; number: number }[];
        const pr = open[0];
        if (!pr) continue;
        if (full === own) return { url: pr.url, number: pr.number, ...(repo.push === false ? { maintainers: true as const } : {}) };
        return { url: pr.url, number: pr.number, repo: full, maintainers: true };
      }
      return null;
    },
    async mayMerge(cwd, url) {
      const ref = prRef(url);
      const push = (await run(atPr(cwd, url), 'api', `repos/${ref.owner}/${ref.repo}`, '--jq', '.permissions.push')).trim();
      return push === 'true' ? true : push === 'false' ? false : null;
    },
    async contribution(cwd, url) {
      const ref = prRef(url);
      const pr = JSON.parse(
        await run(atPr(cwd, url), 'pr', 'view', ghUrl(url), '--json', 'title,author,state,headRefOid,headRefName,headRepository,headRepositoryOwner,maintainerCanModify'),
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
      const out = await withBodyFile(body, (file) => run(atPr(cwd, url), 'pr', 'comment', ghUrl(url), '--body-file', file));
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
      await run(at, 'pr', 'merge', ghUrl(url), `--${method}`, '--match-head-commit', head);
      try {
        return (await run(at, 'pr', 'view', ghUrl(url), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid')).trim() || undefined;
      } catch {
        // merged all the same: the first fetch after it stands in for the commit (Workers.merged)
        return undefined;
      }
    },
  };
};

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
        ...editedAt(c.createdAt, updated.get(c.id)),
        url: c.url,
      })),
      ...pr.reviews.flatMap((r) => reviewComment({ id: r.id, author: r.author.login, body: r.body, at: r.submittedAt, state: r.state }) ?? []),
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

/** A review's verdict by the state the forge gives it (GitHub's `CHANGES_REQUESTED`, Forgejo's `REQUEST_CHANGES`); none for a comment. */
const verdictOf = (state?: string): { verdict?: 'approved' | 'changes' | 'dismissed' } => {
  const v = (state ?? '').toUpperCase();
  return v === 'APPROVED' ? { verdict: 'approved' } : v === 'CHANGES_REQUESTED' || v === 'REQUEST_CHANGES' ? { verdict: 'changes' } : v === 'DISMISSED' ? { verdict: 'dismissed' } : {};
};

/** A review as one of `PrStatus.comments`, by its id on the forge; none for one with neither text nor verdict. */
export const reviewComment = (r: { id: number | string; author: string; body: string; at?: string; state?: string }): PrStatus['comments'][number] | null => {
  const c = { id: `r${r.id}`, author: r.author, body: r.body, ...(r.at ? { at: r.at } : {}), ...verdictOf(r.state) };
  return c.body.trim() || c.verdict ? c : null;
};

/** A conversation comment's `edited`, from when it was written and last changed: an edit within a minute of writing is part of writing it. */
export const editedAt = (created?: string, updated?: string): { edited?: string } =>
  created && updated && Date.parse(updated) - Date.parse(created) > 60_000 ? { edited: updated } : {};

export const ghForge = makeGhForge(ghCli());
