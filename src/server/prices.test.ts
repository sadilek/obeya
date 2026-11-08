import { expect, test } from 'bun:test';
import { codexCost } from './prices';

const million = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 };

test("a Codex model's tokens at its list price: input uncached, cached or written to the cache, and output with the reasoning", () => {
  expect(codexCost('gpt-6.1-sol', million)).toBeCloseTo(2, 9);
  expect(codexCost('gpt-6.1-sol', { inputTokens: 1e6, cachedInputTokens: 6e5, cacheWriteInputTokens: 1e5, outputTokens: 5e4 })).toBeCloseTo(0.6 + 0.06 + 0.25 + 0.5, 9);
  expect(codexCost('gpt-6-astra', { ...million, inputTokens: 0, outputTokens: 1e6 })).toBeCloseTo(50, 9);
});

test("a model the table lacks: the newest of its family the table has, else the preset family's", () => {
  expect(codexCost('gpt-7-luna', million)).toBe(codexCost('gpt-6-luna', million));
  expect(codexCost('gpt-6.2-sol', million)).toBe(codexCost('gpt-6.1-sol', million));
  expect(codexCost('codex-auto-review', million)).toBe(codexCost('gpt-6.1-sol', million));
});
