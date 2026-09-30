// Where pull requests live. GitHub through the `gh` CLI; tests use a fake.

export interface PrStatus {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** The commit the checks ran on. */
  head: string;
  checks: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  /** Conversation comments, review summaries and inline review comments, oldest first. */
  comments: { id: string; author: string; body: string; path?: string; line?: number; url?: string }[];
  /** Who opened the PR (the owner's account; the worker's own replies carry it too). */
  author: string;
}

export interface Forge {
  status(cwd: string, url: string): PrStatus;
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
  headRefOid: string;
  author: { login: string };
  statusCheckRollup: { __typename: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[];
  comments: { id: string; author: { login: string }; body: string; url: string }[];
  reviews: { id: string; author: { login: string }; body: string }[];
}

/** GitHub through a `gh` runner (the real CLI, or canned output in tests). */
export const makeGhForge = (run: (cwd: string, ...args: string[]) => string): Forge => ({
  status(cwd, url) {
    const ref = parsePrUrl(url);
    if (!ref) throw new Error(`not a GitHub pull request URL: ${url}`);
    const pr = JSON.parse(run(cwd, 'pr', 'view', url, '--json', 'state,mergeable,headRefOid,author,statusCheckRollup,comments,reviews')) as GhPr;
    const inline = JSON.parse(run(cwd, 'api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, '--paginate')) as {
      id: number;
      user: { login: string };
      body: string;
      path: string;
      line: number | null;
      html_url: string;
    }[];
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
      head: pr.headRefOid,
      author: pr.author.login,
      checks,
      comments: [
        ...pr.comments.map((c) => ({ id: `c${c.id}`, author: c.author.login, body: c.body, url: c.url })),
        ...pr.reviews.filter((r) => r.body.trim()).map((r) => ({ id: `r${r.id}`, author: r.author.login, body: r.body })),
        ...inline.map((c) => ({ id: `i${c.id}`, author: c.user.login, body: c.body, path: c.path, ...(c.line ? { line: c.line } : {}), url: c.html_url })),
      ],
    };
  },
});

export const ghForge = makeGhForge(gh);
