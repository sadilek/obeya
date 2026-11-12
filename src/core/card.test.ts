import { describe, expect, test } from 'bun:test';
import { archiveRefusal, openPerGroup, unreadPerProject, withSupplemented } from './card';
import type { Item, Talk } from './types';

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

describe('archiveRefusal', () => {
  test('a stopped task goes into the archive while nothing waits to start it and its workspace holds no work', () => {
    const stoppedTask = card({ branch: 'obeya/x' });
    expect(archiveRefusal(stoppedTask)).toBeUndefined();
    expect(archiveRefusal({ ...stoppedTask, branch: undefined })).toBe('notDone');
    expect(archiveRefusal({ ...stoppedTask, workspace: '/clones/1' })).toBe('holdsWork');
    expect(archiveRefusal({ ...stoppedTask, keptIn: '/clones/1' })).toBe('holdsWork');
    // where its repository does not run on the canvas, nothing could show that work anyway
    expect(archiveRefusal({ ...stoppedTask, workspace: '/clones/1', repoDown: true })).toBeUndefined();
    expect(archiveRefusal({ ...stoppedTask, queue: { checking: true, since: '' } })).toBe('notDone');
    expect(archiveRefusal({ ...stoppedTask, source: 'plan' })).toBe('planCard');
    expect(archiveRefusal({ ...stoppedTask, prototypeOf: 'idea' })).toBe('notDone');
    // built on a prototype that no agent has worked on since: planned, not stopped
    expect(archiveRefusal({ ...stoppedTask, unstarted: true })).toBe('notDone');
  });

  test('a finished card goes once its agent is done; a workstream stays with its project', () => {
    expect(archiveRefusal(card({ state: 'live' }))).toBeUndefined();
    expect(archiveRefusal(card({ kind: 'question', state: 'done' }))).toBeUndefined();
    expect(archiveRefusal(card({ state: 'live', finishing: true }))).toBe('notDone');
    expect(archiveRefusal(card({ state: 'working' }))).toBe('notDone');
    expect(archiveRefusal(card({ state: 'live', source: 'plan', parent: 'p' }))).toBe('planCard');
  });

  test('a project goes once its work is done', () => {
    expect(archiveRefusal(card({ kind: 'project', source: 'plan', state: 'done' }))).toBeUndefined();
    expect(archiveRefusal(card({ kind: 'project', source: 'plan', state: 'planned' }))).toBe('notDone');
  });

  test('an idea goes once parked or dropped, and not while a prototype of it is on the canvas', () => {
    const idea = (status: 'open' | 'parked', prototypes: Item[] = []) => card({ state: 'idea', idea: { status, brief: '', thinking: false, yourTurn: false, questions: [], variants: [], mocks: [] }, prototypes });
    expect(archiveRefusal(idea('open'))).toBe('notDone');
    expect(archiveRefusal(idea('parked'))).toBeUndefined();
    expect(archiveRefusal(idea('parked', [card({ prototypeOf: 'x' })]))).toBe('prototypeRunning');
    expect(archiveRefusal(idea('parked', [card({ prototypeOf: 'x', archivedAt: '2026-11-01' })]))).toBeUndefined();
  });
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
