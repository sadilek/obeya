import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { Language } from '../core/locale';
import { needsYou } from '../core/types';
import { Board } from './board';
import { Store } from './db';
import { ghCli, makeGhForge, type Forge, type PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { artifact, FakeRuntime, fakeGh, gitRepo, noContributions, until } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

let dir: string;
let main: string;
let workspaces: Workspaces;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let status: PrStatus;
let watcher: PrWatcher;
/** Merges the watcher made, by commit; a reason in `refuse` makes GitHub refuse them. */
let merges: string[];
let refuse: string | undefined;
/** A reason in `unreadable` makes reading the PR fail. */
let unreadable: string | undefined;
/** The repository's settings, as the workers and each round of the watcher read them. */
let settings: RepoAdapter;
/** Cards whose PR the worker reported, as the canvas passes them to sharing. */
let opened: string[];
/** The language of Obeya's interface, which the lines the watcher logs on a card speak. */
let language: Language;
const URL_ = 'https://github.com/acme/app/pull/42';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-pr-'));
  main = join(dir, 'main');
  gitRepo(main);
  const store = new Store(':memory:');
  language = 'de';
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs: [], dirs: [] }), undefined, undefined, () => language);
  workspaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir: join(dir, 'ws') });
  workspaces.ensureClones(main, 1);
  runtime = new FakeRuntime();
  opened = [];
  settings = { ...generic, land: 'pr', workspaces: 'clones', prNoise: ['deploy-bot'] };
  workers = new Workers({ board, runtime, workspaces, adapter: settings, onPrOpened: (id) => opened.push(id) });
  status = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: 'aaa', author: 'owner', checks: [], comments: [] };
  merges = [];
  refuse = undefined;
  unreadable = undefined;
  const forge: Forge = {
    ...noContributions,
    open: async () => '',
    status: async () => {
      if (unreadable) throw new Error(unreadable);
      return status;
    },
    body: async () => '',
    setBody: async () => {},
    merge: async (_cwd, url, head) => {
      if (refuse) throw new Error(`gh pr merge ${url}: ${refuse}`);
      merges.push(head);
      status.state = 'MERGED';
    },
  };
  watcher = new PrWatcher(board, workers, forge, () => main, () => settings);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};

/** Work on the card's branch, so approving it goes out as a pull request. */
function commit(cardId: string) {
  const clone = board.row(cardId).workspace!;
  writeFileSync(join(clone, 'export.ts'), '');
  git(clone, 'add', '.');
  git(clone, 'commit', '--quiet', '-m', 'Export');
}

/** A card through review and approval, with its PR reported. */
async function inPr() {
  const c = board.create({ title: 'Export', x: 0, y: 0 });
  await workers.start(c.id);
  commit(c.id);
  await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
  await workers.approve(c.id);
  return c.id;
}

describe('the PR phase', () => {
  test('approval asks the worker to open the PR; pr_opened records it', async () => {
    const id = await inPr();
    expect(state(id)).toBe('inPr');
    expect(runtime.last.inbox.at(-1)).toContain('goes out as a pull request');
    // without a shared demo, the approval says nothing about one
    expect(runtime.last.inbox.at(-1)).not.toContain('shared with the team');
    expect(runtime.last.closed).toBe(false);
    expect(runtime.last.call('pr_opened', { url: 'https://example.com/x' })).toContain('not the URL of a pull request');
    // one on Codeberg (Forgejo) is recorded like one on GitHub
    runtime.last.call('pr_opened', { url: 'https://codeberg.org/acme/app/pulls/12' });
    expect(board.item(id)!.pr).toMatchObject({ url: 'https://codeberg.org/acme/app/pulls/12', number: 12 });
    // written GitHub's way, it is recorded as Codeberg writes it
    runtime.last.call('pr_opened', { url: 'https://codeberg.org/acme/app/pull/13' });
    expect(board.item(id)!.pr).toMatchObject({ url: 'https://codeberg.org/acme/app/pulls/13', number: 13 });
    runtime.last.call('pr_opened', { url: URL_ });
    expect(board.item(id)!.pr).toMatchObject({ url: URL_, number: 42 });
    // with the PR open, ending the turn needs no nudge
    const n = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(n);
  });

  test('a demo shared before approval is linked in the PR by the worker; pr_opened passes the PR on', async () => {
    const c = board.create({ title: 'Export', x: 0, y: 0 });
    await workers.start(c.id);
    commit(c.id);
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    board.work(c.id, { share: JSON.stringify({ slug: 'export', url: 'https://demos.example/export/', dir: '/d' }) });
    await workers.approve(c.id);
    expect(runtime.last.inbox.at(-1)).toContain('shared with the team on a page of its own: https://demos.example/export/. Link it');
    runtime.last.call('pr_opened', { url: URL_ });
    expect(opened).toEqual([c.id]);
  });

  test('pr_opened before approval is refused', async () => {
    const c = board.create({ title: 'X', x: 0, y: 0 });
    await workers.start(c.id);
    expect(runtime.last.call('pr_opened', { url: URL_ })).toContain('not approved');
  });

  test('a turn in the PR phase without a PR is nudged', async () => {
    await inPr();
    // the turn that handed over ends, then the one the approval started
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'text', text: 'Ich pushe den Branch.' });
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('no pull request for this card yet');
  });
});

describe('watching', () => {
  test('new comments from others, failed checks and conflicts go to the worker once each', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.comments = [
      { id: 'i1', author: 'greptile', body: 'Null check missing.', path: 'src/a.ts', line: 3 },
      { id: 'c2', author: 'owner', body: 'Fixed in the latest push.' },
      { id: 'c3', author: 'deploy-bot', body: 'Deployed preview.' },
    ];
    status.checks = [{ name: 'build', state: 'failure', url: 'https://ci/1' }, { name: 'lint', state: 'success' }];
    status.mergeable = 'CONFLICTING';
    const before = runtime.last.inbox.length;
    await watcher.poll();
    const sent = runtime.last.inbox.slice(before);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain('greptile on src/a.ts:3');
    expect(sent[0]).not.toContain('Fixed in the latest push');
    expect(sent[0]).not.toContain('Deployed preview');
    expect(sent[1]).toContain('- build: https://ci/1');
    expect(sent[2]).toContain('conflicts with its base branch');
    expect(board.item(id)!.pr).toMatchObject({ conflict: true, checks: status.checks });
    // the card shows the review, without the noise
    expect(board.item(id)!.pr!.review).toEqual([
      { author: 'greptile', at: '', threads: [{ author: 'greptile', body: 'Null check missing.', at: '', path: 'src/a.ts', line: 3, resolved: false, replies: [] }] },
      { author: 'owner', mine: true, body: 'Fixed in the latest push.', at: '' },
    ]);

    await watcher.poll();
    expect(runtime.last.inbox.length).toBe(before + 3);
    // a new commit fails again: reported again
    status.head = 'bbb';
    await watcher.poll();
    expect(runtime.last.inbox.at(-2)).toContain('Checks failed');
    expect(runtime.last.inbox.at(-1)).toContain('conflicts');
  });

  test('the line on the card about review comments passed on speaks the interface language', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    const lines = () => board.events(id).map((e) => e.text);
    status.comments = [{ id: 'i1', author: 'greptile', body: 'Null check missing.' }];
    await watcher.poll();
    expect(lines().at(-1)).toBe('Neuer Review-Kommentar von greptile, an den Agenten weitergegeben.');
    status.comments.push({ id: 'i2', author: 'lead', body: 'Rename it.' }, { id: 'i3', author: 'lead', body: 'And test it.' });
    await watcher.poll();
    expect(lines().at(-1)).toBe('2 neue Review-Kommentare, an den Agenten weitergegeben.');

    language = 'en';
    status.comments.push({ id: 'i4', author: 'greptile', body: 'Still missing.' });
    await watcher.poll();
    expect(lines().at(-1)).toBe('New review comment from greptile, passed on to the agent.');
    status.comments.push({ id: 'i5', author: 'lead', body: 'Typo.' }, { id: 'i6', author: 'lead', body: 'Docs.' });
    await watcher.poll();
    expect(lines().at(-1)).toBe('2 new review comments, passed on to the agent.');
  });

  test('a PR with nothing left for the worker is merged by Obeya, which makes the card live', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    // the turn that handed over ends, then the one the approval started
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    status.checks = [{ name: 'Greptile Review', state: 'success' }];
    status.comments = [
      { id: 'cSUM', author: 'greptile', body: 'Confidence Score: 4/5', at: '2026-10-02T08:34:00Z' },
      { id: 'cPING', author: 'owner', body: '@greptile re-review', at: '2026-10-02T08:46:00Z' },
    ];
    await watcher.poll();
    expect(merges).toEqual([]);
    // the worker answers the summary
    runtime.last.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual([]);
    // the reviewer rewrites its summary, with no new comment
    status.comments[0] = { ...status.comments[0]!, body: 'Confidence Score: 5/5', edited: '2026-10-02T08:49:00Z' };
    await watcher.poll();
    expect(merges).toEqual(['aaa']);
    expect(state(id)).toBe('live');
    expect(board.events(id).map((e) => e.text).slice(-2)).toEqual(['Bereit zum Mergen: Checks grün, alle Anmerkungen erledigt, das Review ist durch. Obeya mergt.', 'Pull Request gemergt. Live.']);
    expect(runtime.last.inbox.at(-1)).toContain('pull request was merged');
  });

  test('a push the reviewer has not seen is not merged: the worker is asked to request a new review, once per commit', async () => {
    // a PR on 2026-10-02: the fix after Greptile's 3/5 was pushed without a re-review request
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    status.head = 'bbb';
    status.changedAt = '2026-10-02T12:49:20Z';
    status.comments = [
      { id: 'cSUM', author: 'greptile', body: 'Confidence Score: 3/5', at: '2026-10-02T12:44:56Z' },
      { id: 'i1', author: 'greptile', body: 'Session tokens can remain active', at: '2026-10-02T12:45:00Z', round: 'A', resolved: true },
      { id: 'i2', author: 'owner', body: 'Fixed in bbb.', at: '2026-10-02T12:52:13Z', round: 'B', replyTo: 'i1' },
    ];
    // what the worker was told already
    board.work(id, { pr: JSON.stringify({ ...JSON.parse(board.row(id).pr!), seen: ['cSUM', 'i1'] }) });
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(runtime.last.inbox.at(-1)).toContain('nobody asked for another look');
    expect(board.events(id).at(-1)!.text).toBe('Neuer Stand seit dem letzten Review, um ein neues hat niemand gebeten. Der Agent fragt danach.');
    // said once for this commit
    runtime.last.emit({ type: 'idle' });
    const inbox = runtime.last.inbox.length;
    await watcher.poll();
    expect(runtime.last.inbox.length).toBe(inbox);
    // the worker asks; the reviewer answers by rewriting its summary
    status.comments.push({ id: 'cPING', author: 'owner', body: '@greptile re-review', at: '2026-10-02T12:53:00Z' });
    await watcher.poll();
    expect(merges).toEqual([]);
    status.comments[0] = { ...status.comments[0]!, body: 'Confidence Score: 5/5', edited: '2026-10-02T12:57:00Z' };
    await watcher.poll();
    expect(merges).toEqual(['bbb']);
    expect(state(id)).toBe('live');
  });

  test('a reviewer confidence below 4/5 leaves the merge to the owner; a better one lets Obeya merge', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    status.comments = [{ id: 'cSUM', author: 'greptile', body: 'Confidence Score: 3/5', at: '2026-10-02T08:34:00Z' }];
    board.work(id, { pr: JSON.stringify({ ...JSON.parse(board.row(id).pr!), seen: ['cSUM'] }) });
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(state(id)).toBe('inPr');
    expect(board.item(id)!.pr).toMatchObject({ ready: true, held: { score: '3/5', by: 'greptile' } });
    expect(needsYou(board.item(id)!)).toBe(true);
    expect(board.events(id).at(-1)!.text).toBe('Bereit zum Mergen, aber greptile gibt nur 3/5: Unter 4/5 mergt Obeya nicht selbst. Du entscheidest.');
    // said once
    const events = board.events(id).length;
    await watcher.poll();
    expect(board.events(id).length).toBe(events);
    // a new review rates it 4/5
    status.comments[0] = { ...status.comments[0]!, body: 'Confidence Score: 4/5', edited: '2026-10-02T08:49:00Z' };
    await watcher.poll();
    expect(merges).toEqual(['aaa']);
    expect(state(id)).toBe('live');
  });

  test('a repository that does not merge automatically leaves a ready PR to the owner, who merges it on the forge', async () => {
    settings.autoMerge = false;
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(state(id)).toBe('inPr');
    expect(board.item(id)!.pr).toMatchObject({ ready: true, manual: true });
    expect(needsYou(board.item(id)!)).toBe(true);
    expect(board.events(id).at(-1)!.text).toBe('Bereit zum Mergen: Checks grün, alle Anmerkungen erledigt, das Review ist durch. In diesem Repository mergt Obeya nicht selbst: bitte selbst mergen.');
    // said once
    const events = board.events(id).length;
    await watcher.poll();
    expect(board.events(id).length).toBe(events);
    // new work for the worker takes the readiness back
    status.comments.push({ id: 'i3', author: 'lead', body: 'One more thing.', at: '2026-10-02T09:00:00Z' });
    await watcher.poll();
    expect(board.item(id)!.pr?.ready).toBeUndefined();
    // the owner merges on the forge: the card is live
    status.state = 'MERGED';
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(state(id)).toBe('live');
  });

  test('the worker hears who merges its pull request', async () => {
    settings.autoMerge = false;
    await inPr();
    expect(runtime.last.inbox.at(-1)).toContain('Do not merge it: the people on the forge merge it once its checks have passed');
  });

  test('a merge GitHub refuses leaves it to the owner, tried again each round; new work takes that back', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    refuse = 'At least 1 approving review is required by reviewers with write access.';
    await watcher.poll();
    expect(state(id)).toBe('inPr');
    expect(board.item(id)!.pr).toMatchObject({ ready: true, mergeError: refuse });
    expect(needsYou(board.item(id)!)).toBe(true);
    expect(board.events(id).at(-1)!.text).toBe(`Obeya konnte nicht mergen: ${refuse}`);
    // said once
    const events = board.events(id).length;
    await watcher.poll();
    expect(board.events(id).length).toBe(events);
    // a new comment is work for the worker again
    status.comments.push({ id: 'i3', author: 'lead', body: 'One more thing.', at: '2026-10-02T09:00:00Z' });
    await watcher.poll();
    expect(board.item(id)!.pr!.ready).toBeUndefined();
    expect(needsYou(board.item(id)!)).toBe(false);
    // the worker resolves it; now GitHub lets the merge through
    status.comments[0]!.resolved = true;
    runtime.last.emit({ type: 'idle' });
    refuse = undefined;
    await watcher.poll();
    expect(state(id)).toBe('live');
  });

  test('while the owner is asked, news waits; the answer returns the card to the PR', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.call('ask', { question: 'Soll ich dem Reviewer widersprechen?' });
    expect(state(id)).toBe('waiting:question');
    status.comments = [{ id: 'i9', author: 'reviewer', body: 'Rename this.' }];
    const n = runtime.last.inbox.length;
    await watcher.poll();
    expect(runtime.last.inbox.length).toBe(n);
    workers.answer(id, 'Ja, mit Begründung.');
    expect(state(id)).toBe('inPr');
    await watcher.poll();
    expect(runtime.last.inbox.at(-1)).toContain('Rename this.');
  });

  test('stopping during a PR question detaches the PR; a new start is a fresh run', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.call('ask', { question: 'Q?' });
    await workers.stop(id);
    expect(board.item(id)!.pr).toBeUndefined();
    expect(board.events(id).at(-1)!.text).toContain('#42 bleibt offen');
    await workers.start(id);
    runtime.last.call('ask', { question: 'Neu?' });
    workers.answer(id, 'Ja.');
    expect(state(id)).toBe('working');
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('working');
  });

  test('the owner coming back looks at the PRs right away, but not again within the gap', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    // not yet ready, so Obeya does not merge it itself
    status.checks = [{ name: 'build', state: 'pending' }];
    let asked = 0;
    const counting = new PrWatcher(board, workers, { status: async () => (asked++, status), body: async () => '', setBody: async () => {}, merge: async () => {}, open: async () => '', ...noContributions }, () => dir);
    counting.soon();
    counting.soon();
    await Bun.sleep(5);
    expect(asked).toBe(1);

    // merged on GitHub: the owner back in Obeya sees it without waiting for the next round
    status.state = 'MERGED';
    counting.soon(0);
    expect(state(id)).toBe('inPr');
    await Bun.sleep(5);
    expect(asked).toBe(2);
    expect(state(id)).toBe('live');
  });

  test('a PR that cannot be read for ten minutes says why on its card, once; reading it again clears that', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    const events = board.events(id).length;
    unreadable = 'git has no login for codeberg.org';
    await watcher.poll();
    // the network gone for a moment is not worth a line
    expect(board.events(id).length).toBe(events);
    const pr = JSON.parse(board.row(id).pr!);
    board.work(id, { pr: JSON.stringify({ ...pr, readError: { since: pr.readError.since - 10 * 60_000 } }) });
    await watcher.poll();
    await watcher.poll();
    expect(board.events(id).map((e) => e.text).slice(events)).toEqual(['Obeya kann den Pull Request nicht lesen: git has no login for codeberg.org']);
    unreadable = undefined;
    await watcher.poll();
    expect(JSON.parse(board.row(id).pr!).readError).toBeUndefined();
  });

  test('a merge makes the card live and frees the clone; a close asks the owner', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
    // the worker hears it and may finish what remains; the clone is free once its turn has ended
    expect(runtime.last.inbox.at(-1)).toContain('pull request was merged');
    expect(board.item(id)!.finishing).toBe(true);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.closed).toBe(true);
    expect(board.row(id).workspace).toBeNull();
    // the clone goes once git has read which plan docs the branch adds
    await new Promise((r) => setTimeout(r, 0));

    status.state = 'OPEN';
    const other = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.state = 'CLOSED';
    await watcher.poll();
    expect(state(other)).toBe('waiting:question');
    expect(board.item(other)!.question!.options).toEqual(['Neu eröffnen', 'Die Arbeit verwerfen']);
  });
});

describe('a tool call waiting for permission', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('after the merge, a worker finishing asks for one: the card is not merged a second time, and the question stays', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
    const told = runtime.last.inbox.length;
    // the turn the merge started cleans up, with a command the settings want confirmed
    const answer = runtime.last.permission('Bash', { command: 'rm -rf /tmp/demo' });
    await flush();
    expect(state(id)).toBe('waiting:question');
    await watcher.poll();
    expect(state(id)).toBe('waiting:question');
    expect(board.events(id).filter((e) => e.text === 'Pull Request gemergt. Live.')).toHaveLength(1);
    expect(runtime.last.inbox.length).toBe(told);
    workers.answer(id, 'Erlauben');
    expect(await answer).toEqual({ allow: true });
  });

  test('one waiting when the PR is merged is refused, so the worker goes on and hears of the merge', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    const answer = runtime.last.permission('Bash', { command: 'git push --force' });
    await flush();
    expect(state(id)).toBe('waiting:question');
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
    const refused = await answer;
    expect(refused.allow).toBe(false);
    expect('message' in refused && refused.message).toContain('pull request was merged');
    expect(runtime.last.inbox.at(-1)).toContain('pull request was merged');
  });
});

describe('a merge that takes a while', () => {
  test('a watcher stopped meanwhile leaves the card alone, merged or refused; a card on another PR meanwhile too', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    let answer: ((refused?: string) => void) | undefined;
    let asked = 0;
    const slow: Forge = {
      ...noContributions,
      open: async () => '',
      status: async () => (asked++, status),
      body: async () => '',
      setBody: async () => {},
      merge: () =>
        new Promise((resolve, reject) => {
          answer = (refused) => (refused ? reject(new Error(refused)) : resolve('f00d'));
        }),
    };
    const merging = () => {
      answer = undefined;
      const w = new PrWatcher(board, workers, slow, () => main, () => settings);
      const round = w.poll();
      return { w, round };
    };
    const pr = () => JSON.parse(board.row(id).pr!);

    let { w, round } = merging();
    await until(() => answer);
    w.stop();
    answer!('Base branch was modified');
    await round;
    expect(pr().mergeError).toBeUndefined();
    expect(state(id)).toBe('inPr');

    ({ w, round } = merging());
    await until(() => answer);
    w.stop();
    answer!();
    await round;
    expect(state(id)).toBe('inPr');

    // the worker opened another pull request in its place meanwhile
    ({ w, round } = merging());
    await until(() => answer);
    runtime.last.call('pr_opened', { url: 'https://github.com/acme/app/pull/43' });
    answer!();
    await round;
    expect(state(id)).toBe('inPr');
    expect(pr().url).toBe('https://github.com/acme/app/pull/43');
    // and a watcher stopped does not start another round
    w.stop();
    const before = asked;
    await w.poll();
    expect(asked).toBe(before);
  });
});

describe('gh slow to answer', () => {
  /** A watcher that asks the stand-in `gh` for the PRs, which may take up to `timeout` per call. */
  const throughGh = (delays: Record<number, number>, timeout?: number) =>
    new PrWatcher(board, workers, makeGhForge(ghCli(fakeGh(join(dir, 'gh'), delays), timeout), async () => undefined), () => main, () => settings);

  test('while a round waits for gh, the server answers at once; the card hears of the comment once gh has answered', async () => {
    await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    const before = runtime.last.inbox.length;
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      const round = throughGh({ 42: 1500 }).poll();
      const waits: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        expect(await (await fetch(server.url)).text()).toBe('ok');
        waits.push(performance.now() - t);
        await Bun.sleep(100);
      }
      // gh blocking the server, each request would wait for it
      expect(Math.max(...waits)).toBeLessThan(250);
      expect(runtime.last.inbox.length).toBe(before);
      await round;
      expect(runtime.last.inbox.at(-1)).toContain('- lead (https://gh/c42):\nRename it.');
    } finally {
      server.stop(true);
    }
  });

  test('a PR gh does not answer for holds up neither the other cards nor the round past its timeout', async () => {
    workspaces.ensureClones(main, 2);
    const slow = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    await inPr();
    const fast = runtime.last;
    fast.call('pr_opened', { url: 'https://github.com/acme/app/pull/43' });
    fast.emit({ type: 'idle' });
    const t = performance.now();
    const round = throughGh({ 42: 30_000 }, 1000).poll();
    await until(() => fast.inbox.at(-1)?.includes('Rename it.'));
    expect(performance.now() - t).toBeLessThan(1000);
    await round;
    expect(performance.now() - t).toBeLessThan(5000);
    // reading it failed: the card says so if it goes on failing
    expect(JSON.parse(board.row(slow).pr!).readError).toBeDefined();
  });
});
