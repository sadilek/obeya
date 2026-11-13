import { describe, expect, test } from 'bun:test';
import { CLONES, type ResolvedCanvas } from '../core/config';
import { type FilledClones, keepConfigDraft, keptConfigDraft, withClones } from './configDraft';
import { memoryStorage } from './testing';


test('a draft not saved yet comes back after a reload, until it is saved', () => {
  const s = memoryStorage();
  const saved = { voice: 'say' };
  keepConfigDraft(s, 'demo', { voice: 'piper' }, saved);
  expect(keptConfigDraft<{ voice: string }>(s, 'demo', saved)).toEqual({ voice: 'piper' });
  // saved meanwhile: what is saved now is the draft, nothing to bring back
  expect(keptConfigDraft(s, 'demo', { voice: 'piper' })).toBeNull();
  keepConfigDraft(s, 'demo', { voice: 'piper' }, { voice: 'piper' });
  expect(s.length).toBe(0);
});

test('the canvases keep their draft with the ids they had, and each draft its own place', () => {
  const s = memoryStorage();
  type K = { draft: { name: string }[]; origin: (string | null)[] };
  const of = (k: K) => k.draft;
  const saved = [{ name: 'obeya' }];
  const k: K = { draft: [{ name: 'Obeya' }], origin: ['obeya'] };
  keepConfigDraft(s, 'canvases', k, saved, of);
  expect(keptConfigDraft(s, 'demo', {})).toBeNull();
  expect(keptConfigDraft<K>(s, 'canvases', saved, of)).toEqual(k);
  // put back as saved: forgotten
  keepConfigDraft(s, 'canvases', { draft: saved, origin: ['obeya'] }, saved, of);
  expect(keptConfigDraft<K>(s, 'canvases', saved, of)).toBeNull();
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
