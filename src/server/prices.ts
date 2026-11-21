// What a Codex or Gemini session cost, estimated from the tokens it reports (Codex's
// `thread/tokenUsage/updated`, the answer to each of Gemini's prompts) at the API list prices of
// OpenAI and Google: neither names a cost, unlike Claude Code. The tables need keeping up as the
// prices and models change.

import { CODEX_PRESET, GEMINI_PRESET, modelFamily, newestOfFamilies } from '../core/agents';

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
function priceOf<P>(table: Record<string, P>, preset: string, model: string): P {
  if (table[model]) return table[model];
  const known = newestOfFamilies(Object.keys(table).map((id) => ({ id })));
  const family = known.find((m) => modelFamily(m.id) === modelFamily(model)) ?? known.find((m) => modelFamily(m.id) === preset)!;
  return table[family.id]!;
}

/** What `tokens` cost on `model` in US dollars, at the table's prices. */
export function codexCost(model: string, tokens: CodexTokens): number {
  const p = priceOf(PRICES, CODEX_PRESET, model);
  const cached = tokens.cachedInputTokens;
  const written = tokens.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, tokens.inputTokens - cached - written);
  return (uncached * p.input + cached * p.cached + written * p.cacheWrite + tokens.outputTokens * p.output) / 1e6;
}

/**
 * Google's standard-tier list prices for Gemini's models (US dollars per million tokens; thinking
 * counts as output, cached input at the context caching price), as
 * https://aistudio.google.com/docs/pricing listed them on 2026-11-20, each from the day it applies:
 * Argon's and Flash's rise on the day named.
 */
const GEMINI_PRICES: Record<string, { from?: string; input: number; cached: number; output: number }[]> = {
  'gemini-4-neon': [{ input: 3, cached: 0.15, output: 15 }],
  'gemini-4-argon': [
    { input: 2, cached: 0.1, output: 10 },
    { from: '2026-12-01', input: 4, cached: 0.2, output: 20 },
  ],
  'gemini-4-hydrogen': [{ input: 1.5, cached: 0.075, output: 7.5 }],
  'gemini-3.8-flash': [
    { input: 0.75, cached: 0.075, output: 3.75 },
    { from: '2027-01-01', input: 1.5, cached: 0.15, output: 7.5 },
  ],
};

/** A Gemini session's tokens so far, as its turns report them: `inputTokens` without the cached ones, `outputTokens` with the thinking. */
export interface GeminiTokens {
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
}

/**
 * What `tokens` cost on a Gemini `model` in US dollars, at the prices that apply `on` that day; a
 * model the table lacks at the newest of its family the table has, else at Neon's. The storage of
 * the context cache by the hour, which Google bills for explicit caches only, is left out.
 */
export function geminiCost(model: string, tokens: GeminiTokens, on = new Date()): number {
  const day = on.toISOString().slice(0, 10);
  const prices = priceOf(GEMINI_PRICES, GEMINI_PRESET, model);
  const p = prices.filter((q) => !q.from || q.from <= day).at(-1) ?? prices[0]!;
  return (tokens.inputTokens * p.input + tokens.cachedReadTokens * p.cached + tokens.outputTokens * p.output) / 1e6;
}
