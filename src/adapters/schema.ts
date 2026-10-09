// What a repository's adapter module may export, checked when Obeya loads it: a misspelt field
// (`check:` for `checks:`) or a wrong type would otherwise be ignored without a word, or break
// whatever reads it later. Each problem names its field; the field does not count, so the generic
// adapter's value stands for it, and the rest of the adapter works.

import { z } from 'zod';
import type { RepoAdapter } from './types';

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function', { message: 'expected a function' });
const strings = z.array(z.string());

const planDocs = z.object({ dir: z.string(), exclude: strings }).strict();
const demo = z.object({ required: z.boolean(), howToRun: z.string(), share: strings.min(1).optional() }).strict();
const stack = z
  .object({
    start: z.string(),
    refresh: z.string(),
    urls: z.object({ file: z.string(), frontendKey: z.string() }).strict(),
    stop: z.string().optional(),
    keep: z.string().optional(),
  })
  .strict();

/** `RepoAdapter`, every field but the name optional: what is left out comes from the generic adapter. */
export const adapterShape = z
  .object({
    name: z.string().min(1),
    matches: fn.optional(),
    canvasId: fn.optional(),
    canvasName: fn.optional(),
    planDocs: planDocs.optional(),
    setup: z.string().optional(),
    checks: strings.optional(),
    land: z.enum(['main', 'pr']).optional(),
    direct: z.boolean().optional(),
    softPaths: strings.optional(),
    workspaces: z.enum(['clones', 'worktrees']).optional(),
    demo: demo.optional(),
    prNoise: strings.optional(),
    stack: stack.optional(),
  })
  .strict();

// the fields each object knows, for a guess at what a misspelt one meant
const KNOWN: Record<string, string[]> = {
  '': Object.keys(adapterShape.shape),
  planDocs: Object.keys(planDocs.shape),
  demo: Object.keys(demo.shape),
  stack: Object.keys(stack.shape),
  'stack.urls': ['file', 'frontendKey'],
};

/**
 * Checks what a module exported (an object with a `name`): the adapter without the fields that are
 * wrong, and one line per problem, in English, starting with the field (`demo.howToRun: …`).
 */
export function checkAdapter(made: Record<string, unknown>): { adapter: Partial<RepoAdapter>; problems: string[] } {
  const parsed = adapterShape.safeParse(made);
  if (parsed.success) return { adapter: made as Partial<RepoAdapter>, problems: [] };
  const adapter: Record<string, unknown> = { ...made };
  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const guess = closest(key, KNOWN[at] ?? []);
        problems.push(`${at ? `${at}.` : ''}${key}: no such field${guess ? ` (did you mean ${guess}?)` : ''}`);
        if (!at) delete adapter[key];
      }
      continue;
    }
    const missing = issue.code === 'invalid_type' && issue.message.endsWith('received undefined');
    problems.push(`${at}: ${missing ? 'missing' : issue.message.replace(/^Invalid (input|option): /, '')}`);
    // the whole top-level field goes: half a `demo` or `planDocs` would be worse than the generic one
    delete adapter[String(issue.path[0])];
  }
  return { adapter: adapter as Partial<RepoAdapter>, problems };
}

/** The known field a misspelt one most likely meant: the same ignoring case, the start of it, or at most two edits away. */
function closest(key: string, known: string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of known) {
    const [a, b] = [key.toLowerCase(), name.toLowerCase()];
    const d = a === b ? 0 : a.length >= 4 && b.startsWith(a) ? 1 : distance(a, b);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}
