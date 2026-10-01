import { expect, test } from 'bun:test';
import { makeGhForge, parsePrUrl } from './forge';

test('parsePrUrl', () => {
  expect(parsePrUrl('https://github.com/OK-Energy-Group/oke/pull/813')).toEqual({ owner: 'OK-Energy-Group', repo: 'oke', number: 813 });
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
        headRefOid: 'abc',
        author: { login: 'owner' },
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/1' },
          { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'StatusContext', context: 'greptile', state: 'SUCCESS', targetUrl: 'https://g/1' },
        ],
        comments: [{ id: 'IC_1', author: { login: 'greptile-apps' }, body: 'Summary', url: 'https://gh/c1' }],
        reviews: [
          { id: 'PRR_1', author: { login: 'lead' }, body: '' },
          { id: 'PRR_2', author: { login: 'lead' }, body: 'Please split this.' },
        ],
      });
    return JSON.stringify([{ id: 7, user: { login: 'greptile-apps[bot]' }, body: 'Null check.', path: 'src/a.ts', line: 3, html_url: 'https://gh/i7' }]);
  });
  const s = forge.status('/repo', 'https://github.com/acme/app/pull/42');
  expect(calls[1]).toEqual(['api', 'repos/acme/app/pulls/42/comments', '--paginate']);
  expect(s).toEqual({
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    head: 'abc',
    author: 'owner',
    checks: [
      { name: 'build', state: 'failure', url: 'https://ci/1' },
      { name: 'test', state: 'pending' },
      { name: 'docs', state: 'success' },
      { name: 'greptile', state: 'success', url: 'https://g/1' },
    ],
    comments: [
      { id: 'cIC_1', author: 'greptile-apps', body: 'Summary', url: 'https://gh/c1' },
      { id: 'rPRR_2', author: 'lead', body: 'Please split this.' },
      { id: 'i7', author: 'greptile-apps', body: 'Null check.', path: 'src/a.ts', line: 3, url: 'https://gh/i7' },
    ],
  });
});
