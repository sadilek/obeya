// What a Codex session cost, estimated from the tokens Codex reports (`thread/tokenUsage/updated`)
// at OpenAI's API list prices: Codex itself names no cost, unlike Claude Code. The table needs
// keeping up as OpenAI changes its prices and models.

import { CODEX_PRESET, codexFamily, newestOfFamilies } from '../core/types';

/** US dollars per million tokens. Input tokens are each uncached, cached or written to the cache; reasoning counts as output. */
interface Price {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/**
 * OpenAI's standard-tier list prices for prompts up to 272K tokens, as
 * https://developers.openai.com/api/docs/pricing listed them on 2026-11-08 (cache writes at the
 * default 30-minute lifetime). gpt-5.6-sol's is a promotion until 2026-11-30.
 */
const PRICES: Record<string, Price> = {
  'gpt-6.1-sol': { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, cacheWrite: 12.5, output: 50 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, cacheWrite: 1.25, output: 5 },
  'gpt-6-sol': { input: 2, cached: 0.2, cacheWrite: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2 },
};

/** A Codex thread's tokens so far, as Codex counts them (`TokenUsageBreakdown`): `inputTokens` includes the cached and the cache-written ones, `outputTokens` the reasoning. */
export interface CodexTokens {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

/**
 * The price a model is estimated at: its own; for a model the table lacks, the newest of its family
 * the table has (a newer Sol at the latest Sol's), else the preset family's newest, as Claude Code
 * prices a model it does not know at its default's.
 */
function priceOf(model: string): Price {
  if (PRICES[model]) return PRICES[model];
  const known = newestOfFamilies(Object.keys(PRICES).map((id) => ({ id })));
  const family = known.find((m) => codexFamily(m.id) === codexFamily(model)) ?? known.find((m) => codexFamily(m.id) === CODEX_PRESET)!;
  return PRICES[family.id]!;
}

/** What `tokens` cost on `model` in US dollars, at the table's prices. */
export function codexCost(model: string, tokens: CodexTokens): number {
  const p = priceOf(model);
  const cached = tokens.cachedInputTokens;
  const written = tokens.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, tokens.inputTokens - cached - written);
  return (uncached * p.input + cached * p.cached + written * p.cacheWrite + tokens.outputTokens * p.output) / 1e6;
}
