import { describe, expect, test } from 'bun:test';
import { type Arrangeable, arrangeWorkstreams, type Bounds, collapsedSize, dependencyColumns, dependencyOrder, freeSpotNear, GAP, PROJECT_COLLAPSED, PROJECT_HEAD, PROJECT_PAD, projectSize, shapeOf } from './layout';

const clear = (a: Bounds, b: Bounds) => a.x + a.w + GAP <= b.x || b.x + b.w + GAP <= a.x || a.y + a.h + GAP <= b.y || b.y + b.h + GAP <= a.y;

describe('freeSpotNear', () => {
  test('takes the wanted spot when it is free', () => {
    expect(freeSpotNear({ x: 0, y: 200 }, [300, 136], [{ x: 0, y: 0, w: 300, h: 136 }])).toEqual({ x: 0, y: 200 });
  });

  test('moves out of a project to the nearest side', () => {
    const project = { x: 0, y: 0, w: 1000, h: 600 };
    // wanted near the right edge: right of the project is nearer than below it
    expect(freeSpotNear({ x: 800, y: 300 }, [300, 136], [project])).toEqual({ x: 1020, y: 300 });
    // wanted near the bottom: below it
    expect(freeSpotNear({ x: 400, y: 500 }, [300, 136], [project])).toEqual({ x: 400, y: 620 });
  });

  test('keeps clear of everything taken', () => {
    const taken = [
      { x: 0, y: 0, w: 1000, h: 600 },
      { x: 1020, y: 200, w: 300, h: 136 },
      { x: 400, y: 620, w: 300, h: 136 },
    ];
    const at = freeSpotNear({ x: 500, y: 400 }, [300, 136], taken);
    for (const b of taken) expect(clear({ ...at, w: 300, h: 136 }, b)).toBe(true);
  });

  test('inside the view: a wanted spot at its edge moves in', () => {
    const view = { x: 0, y: 0, w: 1200, h: 800 };
    expect(freeSpotNear({ x: 1100, y: 750 }, [300, 136], [], view)).toEqual({ x: 1200 - 300 - GAP, y: 800 - 136 - GAP });
  });

  test('inside the view: a free spot in view wins over a nearer one partly out of it', () => {
    const view = { x: 0, y: 0, w: 1200, h: 800 };
    // a column filling the view's right side: right of it is nearer, but out of view
    const taken = [{ x: 700, y: 0, w: 400, h: 800 }];
    const at = freeSpotNear({ x: 800, y: 300 }, [300, 136], taken, view);
    expect(at).toEqual({ x: 700 - 300 - GAP, y: 300 });
  });

  test('a view with no room left: the nearest free spot, out of view', () => {
    const view = { x: 0, y: 0, w: 1200, h: 800 };
    const taken = [{ x: -100, y: -100, w: 1400, h: 1000 }];
    const at = freeSpotNear({ x: 500, y: 400 }, [300, 136], taken, view);
    expect(clear({ ...at, w: 300, h: 136 }, taken[0]!)).toBe(true);
  });
});

describe("a project's title", () => {
  const column = [
    { kind: 'task' as const, state: 'planned' as const, parent: 'p', x: PROJECT_PAD, y: PROJECT_HEAD },
    { kind: 'task' as const, state: 'planned' as const, parent: 'p', x: PROJECT_PAD, y: PROJECT_HEAD + 156 },
  ];

  test('a short one leaves a project of one column at its narrowest', () => {
    expect(projectSize(column, 'Faster checkout')[0]).toBe(420);
  });

  test('a long one widens the project so that it takes two lines at most', () => {
    const short = 'Split the bill between friends';
    const long = 'Split the bill between friends, settle it by card and keep a history of every bill shared';
    expect(projectSize(column, short)[0]).toBe(420);
    expect(projectSize(column, long)[0]).toBeGreaterThan(420);
    expect(projectSize(column, `**${long}**`)[0]).toBe(projectSize(column, long)[0]);
  });

  test('collapsed, a project grows a line taller where its title takes two', () => {
    expect(collapsedSize('Tips')).toEqual([...PROJECT_COLLAPSED]);
    const [w, h] = collapsedSize('Receipts by email after every order');
    expect(w).toBe(PROJECT_COLLAPSED[0]);
    expect(h).toBeGreaterThan(PROJECT_COLLAPSED[1]);
  });
});

describe('shapeOf', () => {
  const ws = { kind: 'task' as const, parent: 'p' };

  test('a delivered workstream shrinks to a chip', () => {
    expect(shapeOf({ ...ws, state: 'live' })).toBe('chip');
    expect(shapeOf({ ...ws, state: 'done' })).toBe('chip');
  });

  test('a workstream whose agent still works after the landing stays at the size of a task', () => {
    expect(shapeOf({ ...ws, state: 'live', finishing: true })).toBe('task');
    expect(shapeOf({ ...ws, state: 'done', finishing: true })).toBe('task');
    // once its agent is done, it shrinks
    expect(shapeOf({ ...ws, state: 'live', finishing: false })).toBe('chip');
  });

  test('a card on its own stays a task', () => {
    expect(shapeOf({ kind: 'task', state: 'live' })).toBe('task');
  });
});

describe('arranging workstreams by their dependencies', () => {
  const ws = (id: string, buildsOn: string[] = [], state: Arrangeable['state'] = 'planned'): Arrangeable => ({ id, kind: 'task', state, parent: 'p', buildsOn });

  test('what builds on another stands in a column right of it', () => {
    const { layers } = dependencyColumns([ws('a'), ws('b', ['a']), ws('c'), ws('d', ['b', 'c'])]);
    expect(layers).toEqual([[['a', 'c']], [['b']], [['d']]]);
  });

  test('within a column the cards follow the rows of what they build on', () => {
    // y builds on b (second row), x on a (first row): x comes first although the plan names y first
    const { layers } = dependencyColumns([ws('a'), ws('b'), ws('y', ['b']), ws('x', ['a'])]);
    expect(layers[1]).toEqual([['x', 'y']]);
  });

  test('delivered workstreams stay above, and what builds on them alone can start at once', () => {
    const r = dependencyColumns([ws('done', [], 'live'), ws('a', ['done']), ws('b', ['a'])]);
    expect(r.chips).toEqual(['done']);
    expect(r.layers).toEqual([[['a']], [['b']]]);
    expect(dependencyOrder([ws('a', ['done']), ws('done', [], 'live'), ws('b', ['a'])])).toEqual(['done', 'a', 'b']);
  });

  test('a cycle is cut where it closes', () => {
    expect(dependencyColumns([ws('a', ['b']), ws('b', ['a'])]).layers.flat(2).sort()).toEqual(['a', 'b']);
  });

  test('a depth with more cards than a column holds goes on in a column beside it', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ws(id));
    const pos = arrangeWorkstreams([...many, ws('z', ['e'])]);
    expect(pos.get('a')).toEqual({ x: PROJECT_PAD, y: PROJECT_HEAD });
    expect(pos.get('e')).toEqual({ x: PROJECT_PAD + 300 + GAP, y: PROJECT_HEAD });
    // the next depth after a wider gap than between the two columns of one
    expect(pos.get('z')!.x - pos.get('e')!.x).toBeGreaterThan(300 + GAP);
  });

  test('cards and chips never overlap', () => {
    const all = [ws('d1', [], 'live'), ws('d2', [], 'done'), ws('a'), ws('b', ['a']), ws('c', ['a']), ws('d', ['b'])];
    const pos = arrangeWorkstreams(all);
    const boxes = all.map((w) => {
      const [width, height] = shapeOf(w) === 'chip' ? [196, 64] : [300, 136];
      return { ...pos.get(w.id)!, w: width, h: height };
    });
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(clear(a, b)).toBe(true);
  });
});
