import { expect, test } from 'bun:test';
import { readyToMerge, reviewOf } from './forge';
import { ForgeError, makeForgejoForge, remoteRepo, type Api } from './forgejo';

const URL_ = 'https://codeberg.org/acme/app/pulls/12';

/** Canned answers by method and path (the query cut off, except the page); `calls` records each. */
function server(answers: Record<string, unknown>, origin: string | null = null) {
  const calls: { base: string; method: string; path: string; body?: unknown }[] = [];
  const api: Api = (_cwd, base, method, path, body) => {
    calls.push({ base, method, path, ...(body === undefined ? {} : { body }) });
    const page = /[?&]page=(\d+)/.exec(path)?.[1];
    const key = `${method} ${path.split('?')[0]}`;
    const a = answers[key];
    if (a instanceof Error) throw a;
    // a list answers on its first page only
    if (page) return page === '1' ? a : [];
    return a;
  };
  return { forge: makeForgejoForge(api, () => origin), calls };
}

const pr = {
  state: 'open',
  merged: false,
  mergeable: true,
  draft: false,
  body: 'Text',
  head: { sha: 'abc' },
  user: { login: 'owner' },
};

test('Forgejo’s answers become a PR status: checks, conversation, reviews and threads by line', () => {
  const { forge, calls } = server({
    'GET repos/acme/app/pulls/12': pr,
    'GET repos/acme/app/pulls/12/reviews': [
      { id: 90, user: { login: 'lead' }, body: 'Please split this.', state: 'REQUEST_CHANGES', submitted_at: '2026-10-02T10:05:00+02:00', comments_count: 1 },
      { id: 91, user: { login: 'owner' }, body: '', state: 'COMMENT', submitted_at: '2026-10-02T10:06:00+02:00', comments_count: 1 },
      { id: 92, user: { login: 'lead' }, body: 'draft', state: 'PENDING', comments_count: 3 },
    ],
    'GET repos/acme/app/pulls/12/reviews/90/comments': [
      { id: 7, user: { login: 'lead' }, body: 'Null check.', path: 'src/a.ts', position: 3, original_position: 0, html_url: 'https://cb/i7', created_at: '2026-10-02T10:01:00+02:00', pull_request_review_id: 90, resolver: { login: 'owner' } },
    ],
    'GET repos/acme/app/pulls/12/reviews/91/comments': [
      { id: 8, user: { login: 'owner' }, body: 'Added.', path: 'src/a.ts', position: 3, original_position: 0, html_url: 'https://cb/i8', created_at: '2026-10-02T10:03:00+02:00', pull_request_review_id: 91, resolver: null },
    ],
    'GET repos/acme/app/issues/12/comments': [
      { id: 5, user: { login: 'bot' }, body: 'Summary', html_url: 'https://cb/c5', created_at: '2026-10-02T10:00:00+02:00', updated_at: '2026-10-02T10:09:00+02:00' },
      { id: 6, user: { login: 'owner' }, body: 'Typo fixed', html_url: 'https://cb/c6', created_at: '2026-10-02T10:10:00+02:00', updated_at: '2026-10-02T10:10:30+02:00' },
    ],
    // the last commit merges the base in: the PR's own changes are older
    'GET repos/acme/app/pulls/12/commits': [
      { commit: { committer: { date: '2026-10-02T07:58:00Z' } }, parents: [{}] },
      { commit: { committer: { date: '2026-10-02T08:20:00Z' } }, parents: [{}, {}] },
    ],
    'GET repos/acme/app/commits/abc/status': {
      statuses: [
        { context: 'ci / check', status: 'failure', target_url: 'https://cb/run/1' },
        { context: 'ci / e2e', status: 'pending' },
        { context: 'docs', status: 'skipped' },
      ],
    },
  });
  const s = forge.status('/repo', URL_);
  // times in UTC, whatever zone the server or the committer wrote them in
  expect(calls[0]).toEqual({ base: 'https://codeberg.org', method: 'GET', path: 'repos/acme/app/pulls/12' });
  // the pending review's comments are a draft nobody else sees
  expect(calls.some((c) => c.path.includes('reviews/92'))).toBe(false);
  expect(s).toEqual({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    head: 'abc',
    changedAt: '2026-10-02T07:58:00.000Z',
    author: 'owner',
    checks: [
      { name: 'ci / check', state: 'failure', url: 'https://cb/run/1' },
      { name: 'ci / e2e', state: 'pending' },
      { name: 'docs', state: 'success' },
    ],
    comments: [
      { id: 'c5', author: 'bot', body: 'Summary', at: '2026-10-02T08:00:00.000Z', edited: '2026-10-02T08:09:00.000Z', url: 'https://cb/c5' },
      { id: 'c6', author: 'owner', body: 'Typo fixed', at: '2026-10-02T08:10:00.000Z', url: 'https://cb/c6' },
      { id: 'r90', author: 'lead', body: 'Please split this.', at: '2026-10-02T08:05:00.000Z' },
      { id: 'i7', author: 'lead', body: 'Null check.', at: '2026-10-02T08:01:00.000Z', path: 'src/a.ts', line: 3, url: 'https://cb/i7', round: '90', resolved: true },
      { id: 'i8', author: 'owner', body: 'Added.', at: '2026-10-02T08:03:00.000Z', path: 'src/a.ts', line: 3, url: 'https://cb/i8', round: '91', replyTo: 'i7' },
    ],
  });
  // the card shows it as a GitHub PR's: one round, its thread resolved with the agent's reply
  const review = reviewOf(s);
  expect(review.filter((e) => 'threads' in e)).toEqual([
    {
      author: 'lead',
      at: '2026-10-02T08:01:00.000Z',
      threads: [{ author: 'lead', body: 'Null check.', at: '2026-10-02T08:01:00.000Z', path: 'src/a.ts', line: 3, url: 'https://cb/i7', resolved: true, replies: [{ author: 'owner', mine: true, body: 'Added.', at: '2026-10-02T08:03:00.000Z' }] }],
    },
  ]);
});

test('merged, closed, conflicting and draft PRs on Forgejo', () => {
  const status = (p: object) =>
    server({
      'GET repos/acme/app/pulls/12': { ...pr, ...p },
      'GET repos/acme/app/pulls/12/reviews': [],
      'GET repos/acme/app/issues/12/comments': [],
      'GET repos/acme/app/pulls/12/commits': [],
      'GET repos/acme/app/commits/abc/status': { statuses: [] },
    }).forge.status('/repo', URL_);
  const merged = status({ state: 'closed', merged: true, mergeable: false, merge_commit_sha: 'e5d1a09' });
  expect([merged.state, merged.mergeCommit]).toEqual(['MERGED', 'e5d1a09']);
  expect(status({ state: 'closed' }).state).toBe('CLOSED');
  const draft = status({ mergeable: false, draft: true });
  expect([draft.mergeable, draft.mergeState]).toEqual(['UNKNOWN', 'DRAFT']);
  expect(readyToMerge(status({}))).toBe(true);
  expect(readyToMerge(draft)).toBe(false);
});

test('the description on Forgejo is read and replaced', () => {
  const { forge, calls } = server({ 'GET repos/acme/app/pulls/12': pr });
  expect(forge.body('/repo', URL_)).toBe('Text');
  forge.setBody('/repo', URL_, 'Text\n\nDemo-Video: https://d/a/');
  expect(calls[1]).toEqual({ base: 'https://codeberg.org', method: 'PATCH', path: 'repos/acme/app/pulls/12', body: { body: 'Text\n\nDemo-Video: https://d/a/' } });
});

test('a merge on Forgejo uses the style the repository allows, only for the commit found ready; a refusal says the server’s reason', () => {
  let allows: Record<string, boolean> = { allow_squash_merge: true, allow_merge_commits: true };
  const answers: Record<string, unknown> = {
    'GET repos/acme/app': allows,
    'POST repos/acme/app/pulls/12/merge': undefined,
    'GET repos/acme/app/pulls/12': { ...pr, merged: true, merge_commit_sha: 'f00d' },
  };
  const { forge, calls } = server(answers);
  expect(forge.merge('/repo', URL_, 'abc')).toBe('f00d');
  expect(calls[1]).toEqual({ base: 'https://codeberg.org', method: 'POST', path: 'repos/acme/app/pulls/12/merge', body: { Do: 'squash', head_commit_id: 'abc' } });
  allows = { allow_squash_merge: false, allow_merge_commits: false, allow_rebase: true };
  answers['GET repos/acme/app'] = allows;
  forge.merge('/repo', URL_, 'abc');
  expect(calls[4]!.body).toEqual({ Do: 'rebase', head_commit_id: 'abc' });
  answers['POST repos/acme/app/pulls/12/merge'] = new ForgeError('Please try again later', 'POST repos/acme/app/pulls/12/merge');
  expect(() => forge.merge('/repo', URL_, 'abc')).toThrow(/^Please try again later$/);
});

test('a pull request is opened on the Forgejo repository of origin', () => {
  const { forge, calls } = server({ 'POST repos/acme/app/pulls': { html_url: 'https://codeberg.org/acme/app/pulls/13' } }, 'https://codeberg.org/acme/app.git');
  expect(forge.open('/repo', { base: 'main', head: 'obeya-settings', title: 'T', body: 'B' })).toBe('https://codeberg.org/acme/app/pulls/13');
  expect(calls[0]).toEqual({ base: 'https://codeberg.org', method: 'POST', path: 'repos/acme/app/pulls', body: { base: 'main', head: 'obeya-settings', title: 'T', body: 'B' } });
});

test('the server and repository of a remote on Forgejo', () => {
  expect(remoteRepo('https://codeberg.org/acme/app.git')).toEqual({ base: 'https://codeberg.org', repo: 'repos/acme/app' });
  expect(remoteRepo('git@codeberg.org:acme/app.git')).toEqual({ base: 'https://codeberg.org', repo: 'repos/acme/app' });
  expect(remoteRepo('ssh://git@git.example.org:2222/team/app.git')).toEqual({ base: 'https://git.example.org', repo: 'repos/team/app' });
  expect(remoteRepo('https://git.example.org/forge/team/app')).toEqual({ base: 'https://git.example.org/forge', repo: 'repos/team/app' });
  expect(remoteRepo('/local/path')).toBeNull();
});

test('a head Forgejo cannot merge is a conflict only once it still cannot at the next look: before, Forgejo may still check it', () => {
  const answers: Record<string, unknown> = {
    'GET repos/acme/app/pulls/12': { ...pr, mergeable: false },
    'GET repos/acme/app/pulls/12/reviews': [],
    'GET repos/acme/app/issues/12/comments': [],
    'GET repos/acme/app/pulls/12/commits': [],
    'GET repos/acme/app/commits/abc/status': { statuses: [] },
    'GET repos/acme/app/commits/def/status': { statuses: [] },
  };
  const { forge } = server(answers);
  const look = () => {
    const s = forge.status('/repo', URL_);
    return [s.mergeable, s.mergeState];
  };
  expect(look()).toEqual(['UNKNOWN', 'UNKNOWN']);
  expect(look()).toEqual(['CONFLICTING', 'DIRTY']);
  // a new push is checked afresh
  answers['GET repos/acme/app/pulls/12'] = { ...pr, mergeable: false, head: { sha: 'def' } };
  expect(look()).toEqual(['UNKNOWN', 'UNKNOWN']);
  answers['GET repos/acme/app/pulls/12'] = { ...pr, mergeable: true, head: { sha: 'def' } };
  expect(look()).toEqual(['MERGEABLE', 'CLEAN']);
});

test('a failed check on a later page of the head’s statuses keeps the PR from ready', () => {
  const page = (n: number) => (n === 1 ? { statuses: Array.from({ length: 50 }, (_, i) => ({ context: `lint ${i}`, status: 'success' })) } : n === 2 ? { statuses: [{ context: 'e2e', status: 'failure' }] } : { statuses: [] });
  const forge = makeForgejoForge((_cwd, _base, _method, path) => {
    const p = path.split('?')[0]!;
    if (p === 'repos/acme/app/pulls/12') return pr;
    if (p.endsWith('/status')) return page(Number(/page=(\d+)/.exec(path)![1]));
    return [];
  }, () => null);
  const s = forge.status('/repo', URL_);
  expect(s.checks.length).toBe(51);
  expect(s.checks.at(-1)).toEqual({ name: 'e2e', state: 'failure' });
  expect(readyToMerge(s)).toBe(false);
});
