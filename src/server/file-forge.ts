// A forge kept in a JSON file, for a scratch Obeya (scripts/scratch-obeya.ts) whose demo needs pull
// requests without a real forge: the file holds them as a forge would answer for them, Obeya's
// comments, reviews and merges go into it, and whoever stages the demo edits it to play the people on
// the forge (a contributor answering, pushing). A merge squashes the PR's head onto the default
// branch of the repository the file names, as the forge would on its side.

import { readFileSync, writeFileSync } from 'node:fs';
import type { ContributionInfo, Forge, PrStatus } from './forge';
import { gitAsync } from './workspaces';

/** One pull request in the file. */
export interface FilePr {
  url: string;
  number: number;
  title: string;
  author: string;
  state?: PrStatus['state'];
  /** Its head commit; in the repository as `refs/pull/<number>/head` too. */
  head: string;
  canModify?: boolean;
  headRepo?: string;
  headRef?: string;
  checks?: PrStatus['checks'];
  comments?: PrStatus['comments'];
  mergeable?: PrStatus['mergeable'];
  mergeCommit?: string;
  body?: string;
}

/** The file: the repository its PRs are of, the account Obeya acts as, the PRs. */
export interface ForgeFile {
  repo: string;
  viewer: string;
  prs: FilePr[];
}

export function fileForge(path: string): Forge {
  const read = () => JSON.parse(readFileSync(path, 'utf8')) as ForgeFile;
  const write = (f: ForgeFile) => writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`);
  const pr = (f: ForgeFile, url: string) => f.prs.find((p) => p.url === url) ?? (() => { throw new Error(`no pull request ${url}`); })();
  const say = (url: string, kind: string, body: string) => {
    const f = read();
    const p = pr(f, url);
    const id = `c${Date.now()}${(p.comments ?? []).length}`;
    p.comments = [...(p.comments ?? []), { id, author: f.viewer, body: kind ? `${kind}\n\n${body}` : body, at: new Date().toISOString(), url: `${url}#${id}` }];
    write(f);
    return `${url}#${id}`;
  };
  // a push onto the PR's branch in the forge's repository moves its head (and `refs/pull/<n>/head`), as on the forge
  const headOf = async (f: ForgeFile, p: FilePr) => {
    const pushed = p.headRef && (await gitAsync(f.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${p.headRef}`).catch(() => ''));
    if (!pushed) return p.head;
    await gitAsync(f.repo, 'update-ref', `refs/pull/${p.number}/head`, pushed).catch(() => {});
    return pushed;
  };
  return {
    async status(_cwd, url) {
      const f = read();
      const p = pr(f, url);
      const head = await headOf(f, p);
      return {
        state: p.state ?? 'OPEN',
        mergeable: p.mergeable ?? 'MERGEABLE',
        mergeState: 'CLEAN',
        head,
        checks: p.checks ?? [],
        comments: p.comments ?? [],
        author: p.author,
        viewer: f.viewer,
        ...(p.mergeCommit ? { mergeCommit: p.mergeCommit } : {}),
      };
    },
    async body(_cwd, url) {
      return pr(read(), url).body ?? '';
    },
    async setBody(_cwd, url, body) {
      const f = read();
      pr(f, url).body = body;
      write(f);
    },
    async open() {
      throw new Error('this forge opens no pull requests');
    },
    async urlOf(_cwd, n) {
      const p = read().prs.find((x) => x.number === n);
      if (!p) throw new Error(`no pull request #${n}`);
      return p.url;
    },
    async contribution(_cwd, url): Promise<ContributionInfo> {
      const f = read();
      const p = pr(f, url);
      return {
        title: p.title,
        author: p.author,
        state: p.state ?? 'OPEN',
        head: await headOf(f, p),
        canModify: !!p.canModify,
        ...(p.headRepo ? { headRepo: p.headRepo } : {}),
        ...(p.headRef ? { headRef: p.headRef } : {}),
      };
    },
    async comment(_cwd, url, body) {
      return say(url, '', body);
    },
    async requestChanges(_cwd, url, body) {
      return say(url, '**Changes requested**', body);
    },
    async merge(_cwd, url, head) {
      const f = read();
      const p = pr(f, url);
      if ((await headOf(f, p)) !== head) throw new Error('Head branch was modified. Review and try the merge again.');
      if ((p.state ?? 'OPEN') !== 'OPEN') throw new Error('Pull request is not open');
      await gitAsync(f.repo, 'merge', '--squash', '--quiet', head);
      await gitAsync(f.repo, '-c', `user.name=${p.author}`, '-c', `user.email=${p.author}@users.noreply`, 'commit', '--quiet', '-m', `${p.title} (#${p.number})`);
      const commit = await gitAsync(f.repo, 'rev-parse', 'HEAD');
      const now = read();
      Object.assign(pr(now, url), { state: 'MERGED', mergeCommit: commit });
      write(now);
      return commit;
    },
  };
}
