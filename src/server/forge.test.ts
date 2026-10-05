import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lastAsked, makeGhForge, parsePrUrl, readable, readyToMerge, reviewOf, reviewStale, type PrStatus } from './forge';

test('parsePrUrl', () => {
  expect(parsePrUrl('https://github.com/example-org/acme/pull/813')).toEqual({ owner: 'example-org', repo: 'acme', number: 813 });
  expect(parsePrUrl('https://github.com/a/b/issues/1')).toBeNull();
});

test('gh output becomes a PR status', () => {
  const calls: string[][] = [];
  const forge = makeGhForge((_cwd, ...args) => {
    calls.push(args);
    if (args[0] === 'pr')
      return JSON.stringify({
        state: 'OPEN',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        headRefOid: 'abc',
        author: { login: 'owner' },
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/1' },
          { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'StatusContext', context: 'greptile', state: 'SUCCESS', targetUrl: 'https://g/1' },
        ],
        comments: [{ id: 'IC_1', author: { login: 'greptile-apps' }, body: 'Summary', url: 'https://gh/c1', createdAt: '2026-10-02T08:00:00Z' }],
        reviews: [
          { id: 'PRR_1', author: { login: 'lead' }, body: '' },
          { id: 'PRR_2', author: { login: 'lead' }, body: 'Please split this.', submittedAt: '2026-10-02T08:05:00Z' },
        ],
      });
    if (args[1] === 'graphql')
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 7 }] } }] },
              comments: { nodes: [{ id: 'IC_1', updatedAt: '2026-10-02T08:09:00Z' }] },
              commits: { nodes: [{ commit: { committedDate: '2026-10-02T07:58:00Z' } }] },
            },
          },
        },
      });
    return JSON.stringify([
      { id: 7, user: { login: 'greptile-apps[bot]' }, body: 'Null check.', path: 'src/a.ts', line: 3, html_url: 'https://gh/i7', created_at: '2026-10-02T08:01:00Z', pull_request_review_id: 90 },
      { id: 8, user: { login: 'owner' }, body: 'Added.', path: 'src/a.ts', line: 3, html_url: 'https://gh/i8', created_at: '2026-10-02T08:03:00Z', pull_request_review_id: 91, in_reply_to_id: 7 },
    ]);
  });
  const s = forge.status('/repo', 'https://github.com/acme/app/pull/42');
  expect(calls[1]).toEqual(['api', 'repos/acme/app/pulls/42/comments', '--paginate']);
  expect(calls[2]!.slice(0, 8)).toEqual(['api', 'graphql', '-F', 'owner=acme', '-F', 'repo=app', '-F', 'number=42']);
  expect(s).toEqual({
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    mergeState: 'DIRTY',
    head: 'abc',
    headAt: '2026-10-02T07:58:00Z',
    author: 'owner',
    checks: [
      { name: 'build', state: 'failure', url: 'https://ci/1' },
      { name: 'test', state: 'pending' },
      { name: 'docs', state: 'success' },
      { name: 'greptile', state: 'success', url: 'https://g/1' },
    ],
    comments: [
      { id: 'cIC_1', author: 'greptile-apps', body: 'Summary', at: '2026-10-02T08:00:00Z', edited: '2026-10-02T08:09:00Z', url: 'https://gh/c1' },
      { id: 'rPRR_2', author: 'lead', body: 'Please split this.', at: '2026-10-02T08:05:00Z' },
      { id: 'i7', author: 'greptile-apps', body: 'Null check.', at: '2026-10-02T08:01:00Z', path: 'src/a.ts', line: 3, url: 'https://gh/i7', round: '90', resolved: true },
      { id: 'i8', author: 'owner', body: 'Added.', at: '2026-10-02T08:03:00Z', path: 'src/a.ts', line: 3, url: 'https://gh/i8', round: '91', replyTo: 'i7' },
    ],
  });
});

test('the review: rounds of threads with their replies, and the conversation between them', () => {
  const c = (id: string, author: string, at: string, more: Partial<PrStatus['comments'][number]> = {}) => ({ id, author, body: `${id} text`, at: `2026-10-02T08:${at}:00Z`, ...more });
  const s: PrStatus = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    head: 'h',
    author: 'owner',
    checks: [],
    comments: [
      c('cSUM', 'greptile-apps', '30', { edited: '2026-10-02T08:49:00Z' }),
      c('cDEPLOY', 'deploy-bot', '31'),
      c('cPING', 'owner', '37', { url: 'https://gh/ping' }),
      c('i1', 'greptile-apps', '34', { round: 'A', path: 'docs/a.md', resolved: true }),
      c('i2', 'greptile-apps', '34', { round: 'A', path: 'docs/a.md', line: 5, resolved: false }),
      c('i3', 'owner', '36', { round: 'B', replyTo: 'i1' }),
      c('i4', 'greptile-apps', '38', { round: 'C', replyTo: 'i1' }),
      c('i5', 'greptile-apps', '39', { round: 'D', resolved: true }),
    ],
  };
  const r = reviewOf(s, ['deploy-bot']);
  expect(r.map((e) => ('threads' in e ? `round:${e.threads.length}` : e.body))).toEqual(['round:2', 'cPING text', 'round:1', 'cSUM text']);
  expect(r[3]).toMatchObject({ at: '2026-10-02T08:49:00Z', edited: true });
  const first = r[0] as Extract<(typeof r)[number], { threads: unknown[] }>;
  expect(first).toMatchObject({ author: 'greptile-apps', at: '2026-10-02T08:34:00Z' });
  expect(first.threads[0]).toMatchObject({ body: 'i1 text', path: 'docs/a.md', resolved: true });
  expect(first.threads[0]!.replies).toEqual([
    { author: 'owner', mine: true, body: 'i3 text', at: '2026-10-02T08:36:00Z' },
    { author: 'greptile-apps', body: 'i4 text', at: '2026-10-02T08:38:00Z' },
  ]);
  expect(first.threads[1]).toMatchObject({ line: 5, resolved: false, replies: [] });
  expect(r[1]).toEqual({ author: 'owner', mine: true, body: 'cPING text', at: '2026-10-02T08:37:00Z', url: 'https://gh/ping' });
});

test('a review bot’s HTML becomes text: badges by name, folded and code parts gone', () => {
  // as Greptile writes them on Acme's PR #821
  expect(
    readable(
      '<a href="#"><img alt="P1" src="https://x/p1.svg" align="top"></a> **Rows remain on both pages** Step 5 adds\\-on.\n\n<details><summary>Prompt To Fix With AI</summary>\n\nfix it\n</details>',
    ),
  ).toBe('P1 **Rows remain on both pages** Step 5 adds-on.');
  expect(
    readable(
      '<!-- greptile_summary -->\n\n<h2><a href="r"><picture><img alt="Retrigger" src="r.svg"></picture></a>Confidence Score: 5/5</h2>\n\nSafe&nbsp;to merge\\.\n\n<h3>Diagram</h3>\n\n```mermaid\nflowchart LR\n```\n\n<sub>Reviews (4)</sub>',
    ),
  ).toBe('**Confidence Score: 5/5**\n\nSafe to merge.\n\nReviews (4)');
  expect(readable('x'.repeat(4000))).toHaveLength(3002);
});

test('ready to merge: GitHub clean, checks green, threads resolved, the last re-review request answered', () => {
  // Acme's PR #821 on 2026-10-02: Greptile answered the third re-review request by rewriting its
  // summary to 5/5, with no new comment
  const at = (m: string) => `2026-10-02T08:${m}:00Z`;
  const s: PrStatus = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    head: 'e238bbc',
    author: 'owner',
    checks: [{ name: 'CI', state: 'success' }, { name: 'Greptile Review', state: 'success' }],
    comments: [
      { id: 'cDEPLOY', author: 'cloudflare', body: 'Deployed', at: at('31'), edited: at('46') },
      { id: 'cSUM', author: 'greptile-apps', body: 'Confidence Score: 5/5', at: at('34'), edited: at('49') },
      { id: 'cPING1', author: 'owner', body: '@greptile re-review', at: at('37') },
      { id: 'cPING3', author: 'owner', body: '@greptile re-review', at: at('46') },
      { id: 'i1', author: 'greptile-apps', body: 'Rows on both pages', at: at('43'), round: 'A', resolved: true },
      { id: 'i2', author: 'owner', body: 'Split the steps.', at: at('46'), round: 'B', replyTo: 'i1' },
    ],
  };
  expect(readyToMerge(s, ['cloudflare'])).toBe(true);
  const without = (f: (s: PrStatus) => void) => {
    const c = structuredClone(s);
    f(c);
    return readyToMerge(c, ['cloudflare']);
  };
  // the re-review not answered yet: only the deploy bot has written since
  expect(without((c) => delete c.comments[1]!.edited)).toBe(false);
  expect(without((c) => (c.comments[4]!.resolved = false))).toBe(false);
  expect(without((c) => (c.checks[1]!.state = 'pending'))).toBe(false);
  expect(without((c) => (c.mergeState = 'BLOCKED'))).toBe(false);
  expect(without((c) => (c.mergeable = 'UNKNOWN'))).toBe(false);
  // no reviewer asked for anything
  expect(without((c) => (c.comments = []))).toBe(true);
  // the head commit is older than the reviewer's last word; one made after it is not reviewed yet
  expect(without((c) => (c.headAt = at('45')))).toBe(true);
  expect(without((c) => (c.headAt = at('50')))).toBe(false);
});

test('a push since the review is not ready to merge until the reviewer has seen it', () => {
  // a PR on 2026-10-02: Greptile rated the first commit 3/5; the worker pushed a fix,
  // replied in the threads and resolved them, but asked for no new review, and the PR was merged
  const s: PrStatus = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    head: 'ae384ff',
    headAt: '2026-10-02T12:49:20Z',
    author: 'owner',
    checks: [{ name: 'CI', state: 'success' }],
    comments: [
      { id: 'cDEPLOY', author: 'cloudflare', body: 'Deployed', at: '2026-10-02T12:40:45Z', edited: '2026-10-02T12:53:00Z' },
      { id: 'cSUM', author: 'greptile-apps', body: 'Confidence Score: 3/5', at: '2026-10-02T12:44:56Z' },
      { id: 'i1', author: 'greptile-apps', body: 'Permissions can remain active', at: '2026-10-02T12:45:00Z', round: 'A', resolved: true },
      { id: 'i2', author: 'owner', body: 'Fixed in ae384ff.', at: '2026-10-02T12:52:13Z', round: 'B', replyTo: 'i1' },
    ],
  };
  expect(reviewStale(s, ['cloudflare'])).toBe(true);
  expect(readyToMerge(s, ['cloudflare'])).toBe(false);
  // asked, not answered yet
  s.comments.push({ id: 'cPING', author: 'owner', body: '@greptile re-review', at: '2026-10-02T12:53:00Z' });
  expect(lastAsked(s)).toBe('2026-10-02T12:53:00Z');
  expect(readyToMerge(s, ['cloudflare'])).toBe(false);
  // the reviewer rewrites its summary
  s.comments[1]!.edited = '2026-10-02T12:57:00Z';
  expect(reviewStale(s, ['cloudflare'])).toBe(false);
  expect(readyToMerge(s, ['cloudflare'])).toBe(true);
  // a PR no reviewer wrote on waits for nobody
  expect(reviewStale({ ...s, comments: [s.comments[0]!] }, ['cloudflare'])).toBe(false);
});

test('the description is read with gh pr view and replaced through a file', () => {
  const calls: string[][] = [];
  let written = '';
  const forge = makeGhForge((_cwd, ...args) => {
    calls.push(args);
    if (args[1] === 'edit') written = readFileSync(args.at(-1)!, 'utf8');
    return args[1] === 'view' ? JSON.stringify({ body: 'Text' }) : '';
  });
  const url = 'https://github.com/acme/app/pull/42';
  expect(forge.body('/repo', url)).toBe('Text');
  expect(calls[0]).toEqual(['pr', 'view', url, '--json', 'body']);
  forge.setBody('/repo', url, 'Text\n\nDemo-Video: https://d/a/');
  expect(calls[1]!.slice(0, 4)).toEqual(['pr', 'edit', url, '--body-file']);
  expect(written).toBe('Text\n\nDemo-Video: https://d/a/');
});

test('a merge uses the method the repository allows, and only the commit that was found ready', () => {
  const calls: string[][] = [];
  let allows = { squash: true, merge: false, rebase: false };
  const forge = makeGhForge((_cwd, ...args) => {
    calls.push(args);
    return args[0] === 'api' ? JSON.stringify(allows) : '';
  });
  const url = 'https://github.com/acme/app/pull/42';
  forge.merge('/repo', url, 'abc');
  expect(calls[0]!.slice(0, 2)).toEqual(['api', 'repos/acme/app']);
  expect(calls[1]).toEqual(['pr', 'merge', url, '--squash', '--match-head-commit', 'abc']);
  allows = { squash: false, merge: true, rebase: true };
  forge.merge('/repo', url, 'abc');
  expect(calls[3]).toEqual(['pr', 'merge', url, '--merge', '--match-head-commit', 'abc']);
});
