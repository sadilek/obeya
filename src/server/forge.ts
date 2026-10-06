// Where pull requests live. GitHub through the `gh` CLI; tests use a fake.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrReviewEntry, PrThread } from '../core/types';

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
  /** Who opened the PR (the owner's account; the worker's own replies carry it too). */
  author: string;
  /** Once merged: the commit the merge put on the base branch. */
  mergeCommit?: string;
}

export interface Forge {
  status(cwd: string, url: string): PrStatus;
  /** The PR's description. */
  body(cwd: string, url: string): string;
  /** Replaces the PR's description. */
  setBody(cwd: string, url: string, body: string): void;
  /**
   * Merges the PR, if its head is still `head`, the way the repository allows; throws with GitHub's
   * reason when it cannot. Returns the commit the merge put on the base branch, where GitHub says.
   */
  merge(cwd: string, url: string, head: string): string | void;
}

/** A GitHub pull request URL: `https://github.com/<owner>/<repo>/pull/<n>`. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

function gh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['gh', ...args], { cwd, stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
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
export const makeGhForge = (run: (cwd: string, ...args: string[]) => string): Forge => ({
  status(cwd, url) {
    const ref = parsePrUrl(url);
    if (!ref) throw new Error(`not a GitHub pull request URL: ${url}`);
    const pr = JSON.parse(run(cwd, 'pr', 'view', url, '--json', 'state,mergeable,mergeStateStatus,headRefOid,mergeCommit,author,statusCheckRollup,comments,reviews')) as GhPr;
    const inline = JSON.parse(run(cwd, 'api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, '--paginate')) as {
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
    const threads = JSON.parse(
      run(
        cwd,
        'api',
        'graphql',
        '-F',
        `owner=${ref.owner}`,
        '-F',
        `repo=${ref.repo}`,
        '-F',
        `number=${ref.number}`,
        '-f',
        'query=query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } } comments(last: 100) { nodes { id updatedAt } } commits(last: 30) { nodes { commit { committedDate parents { totalCount } } } } } } }',
      ),
    ) as {
      data?: {
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
  },
  body(cwd, url) {
    return (JSON.parse(run(cwd, 'pr', 'view', url, '--json', 'body')) as { body: string }).body;
  },
  setBody(cwd, url, body) {
    // a file, not an argument: a long description would pass Windows' limit on a command line
    const dir = mkdtempSync(join(tmpdir(), 'obeya-pr-body-'));
    try {
      writeFileSync(join(dir, 'body.md'), body);
      run(cwd, 'pr', 'edit', url, '--body-file', join(dir, 'body.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  merge(cwd, url, head) {
    const ref = parsePrUrl(url);
    if (!ref) throw new Error(`not a GitHub pull request URL: ${url}`);
    // the repository's own merge methods (some allow squash only); squash first where it allows several
    const allows = JSON.parse(run(cwd, 'api', `repos/${ref.owner}/${ref.repo}`, '--jq', '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}')) as Record<string, boolean>;
    const method = (['squash', 'merge', 'rebase'] as const).find((m) => allows[m] !== false) ?? 'squash';
    // no --delete-branch: that also switches branches in the workspace; the repository deletes merged branches or not
    run(cwd, 'pr', 'merge', url, `--${method}`, '--match-head-commit', head);
    try {
      return run(cwd, 'pr', 'view', url, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid').trim() || undefined;
    } catch {
      // merged all the same: the first fetch after it stands in for the commit (Workers.merged)
      return undefined;
    }
  },
});

export const ghForge = makeGhForge(gh);

/**
 * What the card shows of a pull request's review, oldest first: each round a reviewer left comments
 * on the code in, with the replies in each thread, and the conversation between the rounds.
 * Comments by `skip` (bots that are not reviewers) are left out; `mine` marks the PR's author,
 * which is the worker writing in the owner's name.
 */
export function reviewOf(s: PrStatus, skip: string[] = []): PrReviewEntry[] {
  const shown = s.comments.filter((c) => !skip.includes(c.author));
  const mine = (author: string) => (author === s.author ? { mine: true } : {});
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
