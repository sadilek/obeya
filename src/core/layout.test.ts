import { describe, expect, test } from 'bun:test';
import { type Bounds, freeSpotNear, GAP } from './layout';

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
});
