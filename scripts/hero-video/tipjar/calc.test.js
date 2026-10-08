import { expect, test } from 'bun:test';
import { tipFor } from './calc.js';

test('15 % on 84.50', () => {
  expect(tipFor(84.5, 15)).toEqual({ tip: 12.68, total: 97.18 });
});
