import { describe, expect, test } from 'bun:test';
import { CLONES, type FilledClones, type Item, openPerGroup, type ResolvedCanvas, stoppedArchivable, type Talk, unreadPerProject, withClones, withSupplemented } from './types';

const card = (over: Partial<Item>): Item => ({ id: 'x', number: 1, kind: 'task', state: 'planned', title: '', body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...over });

describe('openPerGroup', () => {
  test('counts the cards still to be done, a project by its workstreams', () => {
    const open = openPerGroup([
      card({ group: 'a', state: 'working' }),
      card({ group: 'a', state: 'waiting' }),
      card({ group: 'a', state: 'live' }),
      card({ group: 'a', state: 'done' }),
      card({ group: 'a', archivedAt: '2026-10-01' }),
      card({ group: 'a', state: 'idea', idea: { status: 'dropped', brief: '', thinking: false, yourTurn: false, questions: [], variants: [], mocks: [] } }),
      card({ group: 'b', kind: 'project' }),
      card({ group: 'b', parent: 'p', state: 'planned' }),
      card({ group: 'c', state: 'live' }),
      card({ state: 'working' }),
    ]);
    expect([...open]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    // a group whose cards are all done has none open
    expect(open.get('c')).toBeUndefined();
  });
});

test("a project's card counts its agent's answers that wait unread, asked in its sheet", () => {
  const talk = (over: Partial<Talk>): Talk => ({ id: 1, at: '2026-10-29T09:00:00Z', said: '', ...over });
  const unread = unreadPerProject([
    talk({ askedIn: 'p', answer: 'W2 first.', unread: true }),
    talk({ askedIn: 'p', answer: 'Yes.', unread: true }),
    talk({ askedIn: 'q', answer: 'Read already.' }),
    // asked of Obeya: its button counts it, not the project's card
    talk({ question: 'What is left?', answer: 'W3.', unread: true }),
  ]);
  expect([...unread]).toEqual([['p', 2]]);
});

describe('withClones', () => {
  const at = (...workspaces: ('clones' | 'worktrees')[]): ResolvedCanvas => ({ id: 'c', name: 'c', repos: workspaces.map((w) => ({ id: 'r', workspaces: w, values: {} as never, shareTo: 'main' })) });

  test('fills in a repository added in clones, once per path', () => {
    const saved = [{ repos: [{ path: '/a' }] }];
    const filled = new Map() as FilledClones;
    const draft = [{ repos: [{ path: '/a' }, { path: '/b' }] }];
    const next = withClones(draft, saved, [at('clones', 'clones')], filled);
    expect(next).toEqual([{ repos: [{ path: '/a' }, { path: '/b', clones: CLONES }] }]);
    // emptied again, it stays empty
    expect(withClones([{ repos: [{ path: '/a' }, { path: '/b' }] }], saved, [at('clones', 'clones')], filled)).toBeNull();
  });

  test('takes its own count out again once existing clones are listed, and brings it back when they go', () => {
    const filled = new Map() as FilledClones;
    const resolved = [at('clones')];
    const added = withClones([{ repos: [{ path: '/b' }] }], [], resolved, filled)!;
    expect(added[0]!.repos[0]!.clones).toBe(CLONES);
    // two existing clones beside it would make four: the dialog's 2 goes
    const listed = withClones([{ repos: [{ path: '/b', clones: CLONES, workspaces: ['/b2', '/b3'] }] }], [], resolved, filled);
    expect(listed).toEqual([{ repos: [{ path: '/b', workspaces: ['/b2', '/b3'] }] }]);
    // a blank line lists none
    expect(withClones([{ repos: [{ path: '/b', workspaces: ['/b2'] }] }], [], resolved, filled)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', workspaces: [' '] }] }], [], resolved, filled)).toEqual([{ repos: [{ path: '/b', workspaces: [' '], clones: CLONES }] }]);
  });

  test('never touches a count the owner typed or changed', () => {
    const resolved = [at('clones')];
    // typed before listing existing ones
    const typed = new Map() as FilledClones;
    withClones([{ repos: [{ path: '/b' }] }], [], resolved, typed);
    expect(withClones([{ repos: [{ path: '/b', clones: 3 }] }], [], resolved, typed)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', clones: 3, workspaces: ['/b2'] }] }], [], resolved, typed)).toBeNull();
    // typed while the dialog's count was out for existing clones
    const back = new Map() as FilledClones;
    withClones([{ repos: [{ path: '/b' }] }], [], resolved, back);
    withClones([{ repos: [{ path: '/b', clones: CLONES, workspaces: ['/b2'] }] }], [], resolved, back);
    expect(withClones([{ repos: [{ path: '/b', clones: 1, workspaces: ['/b2'] }] }], [], resolved, back)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', clones: 1 }] }], [], resolved, back)).toBeNull();
    // listed before the path was checked: nothing is filled in, and emptying the list fills it in
    const first = new Map() as FilledClones;
    expect(withClones([{ repos: [{ path: '/b', workspaces: ['/b2'] }] }], [], resolved, first)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', workspaces: [] }] }], [], resolved, first)).toEqual([{ repos: [{ path: '/b', workspaces: [], clones: CLONES }] }]);
  });

  test('leaves worktrees, counts of its own and repositories not checked yet', () => {
    const draft = [{ repos: [{ path: '/w' }, { path: '/n', clones: 0 }, { path: '/l', workspaces: ['/x'] }, { path: '' }] }, { repos: [{ path: '/u' }] }];
    expect(withClones(draft, [], [at('worktrees', 'clones', 'clones', 'clones'), null], new Map())).toBeNull();
  });
});

test('a stopped task goes into the archive while nothing waits to start it and its workspace holds no work', () => {
  const stoppedTask = { kind: 'task', state: 'planned', branch: 'obeya/x', source: 'manual' } as const;
  expect(stoppedArchivable(stoppedTask)).toBe(true);
  expect(stoppedArchivable({ ...stoppedTask, branch: undefined })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, workspace: '/clones/1' })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, queue: { checking: true, since: '' } })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, source: 'plan' })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, prototypeOf: 'idea' })).toBe(false);
});

describe('withSupplemented', () => {
  const demos = [{ n: 1 }, { n: 2, follows: 'supplements' as const }, { n: 3, follows: 'replaces' as const }, { n: 4, follows: 'supplements' as const }, { n: 5, follows: 'supplements' as const }, { n: 6 }];
  const along = (i: number) => withSupplemented(demos, i).map((d) => d.n);
  test('a demo takes along the ones it supplements, back to one recorded afresh', () => {
    expect(along(1)).toEqual([1, 2]);
    expect(along(4)).toEqual([3, 4, 5]);
  });
  test('a demo that supplements nothing goes alone', () => {
    expect(along(0)).toEqual([1]);
    expect(along(2)).toEqual([3]);
    expect(along(5)).toEqual([6]);
  });
});
