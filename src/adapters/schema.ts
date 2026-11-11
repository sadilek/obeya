// What a repository's settings may hold (this machine's in the configuration, everyone's in its
// `.obeya/settings.json`), checked where they are read: a misspelt field (`check:` for `checks:`)
// or a wrong type would otherwise be ignored without a word, or break whatever reads it later. Each
// problem names its field; the field does not count, so Obeya's default stands for it, and the rest
// of the settings work.

import { z } from 'zod';
import { LANGUAGES } from '../core/locale';
import { type RepoSettings, SHARED_FIELDS, type SharedSettings } from '../core/types';

const strings = z.array(z.string());

const planDocs = z.object({ dir: z.string(), exclude: strings }).strict();
// what a site needs to be used (a title, a URL, a command) is checked where it is used
// (`siteProblem`): the dialog saves one while the owner fills it in
const site = z
  .object({
    title: z.string(),
    url: z.string(),
    deploy: z.string(),
    // under Obeya's home: the settings may come from the repository, and the file's values go to `url`
    env: z
      .string()
      .min(1)
      .refine((f) => !/^([\\/~]|[A-Za-z]:)/.test(f) && !f.split(/[\\/]/).includes('..'), 'a path relative to Obeya’s home, without ..')
      .optional(),
    headers: z.record(z.string(), z.string()).optional(),
    maxFile: z.number().int().positive().optional(),
    publish: z.enum(['approved']).optional(),
    // the vocabulary pages are tagged from: each dimension with its values
    tags: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
  })
  .strict();
const demo = z.object({ site: site.optional(), language: z.enum(LANGUAGES).optional() }).strict();
const app = z.object({ run: z.string().optional(), stop: z.string().optional(), keep: z.string().optional() }).strict();

/** What a repository's settings for this machine may hold (`RepoSettings`): how it works, and its main branch. */
export const settingsShape = z
  .object({
    branch: z.string().optional(),
    land: z.enum(['main', 'pr']).optional(),
    direct: z.boolean().optional(),
    autoMerge: z.boolean().optional(),
    checks: strings.optional(),
    setup: z.string().optional(),
    planDocs: planDocs.optional(),
    softPaths: strings.optional(),
    workspaces: z.enum(['clones', 'worktrees']).optional(),
    prNoise: strings.optional(),
    language: z.enum(LANGUAGES).optional(),
    app: app.optional(),
    demo: demo.optional(),
  })
  .strict();

/** Whether A and B have the same fields, and a value of each is one of the other. */
type Same<A, B> = [A, keyof A] extends [B, keyof B] ? ([B, keyof B] extends [A, keyof A] ? true : false) : false;
// the shape and the interface the UI reads name the same settings: a field added to one alone is a type error
const sameSettings: Same<z.infer<typeof settingsShape>, RepoSettings> = true;
void sameSettings;

/**
 * What a repository's `.obeya/settings.json` may hold (`SharedSettings`): the settings for this
 * machine but the main branch, which says where the file is read from.
 */
export const sharedShape = settingsShape.omit({ branch: true });

// the fields each object knows, for a guess at what a misspelt one meant
const KNOWN: Record<string, string[]> = {
  '': [...SHARED_FIELDS],
  planDocs: Object.keys(planDocs.shape),
  demo: Object.keys(demo.shape),
  'demo.site': Object.keys(site.shape),
  app: Object.keys(app.shape),
};

/**
 * Checks what a repository's `.obeya/settings.json` holds, the same way: the settings without the
 * fields that are wrong, and one line per problem.
 */
export function checkShared(made: Record<string, unknown>): { settings: SharedSettings; problems: string[] } {
  const { settings: current, gone } = withoutGone(made);
  const { kept, problems } = checkFields(sharedShape, current, KNOWN);
  // the main branch says where the file is read from, so it is set on each machine
  return { settings: kept as SharedSettings, problems: [...gone, ...problems.map((p) => (p.startsWith('branch: ') ? 'branch: the main branch is set on each machine (or detected), not in the repository' : p))] };
}

/**
 * Settings without the fields Obeya no longer has, and a line for each: `demo.site.language` (the
 * overview's language), which `demo.language` names now along with that of the demos. It goes
 * alone, so the site stays.
 */
export function withoutGone(made: Record<string, unknown>): { settings: Record<string, unknown>; gone: string[] } {
  const demo = made.demo as { site?: Record<string, unknown> } | undefined;
  if (!demo?.site || typeof demo.site !== 'object' || !('language' in demo.site)) return { settings: made, gone: [] };
  const { language: _, ...site } = demo.site;
  return { settings: { ...made, demo: { ...demo, site } }, gone: ['demo.site.language: no longer read; demo.language names the language of the demos and of the overview'] };
}

/** `made` without the top-level fields `shape` refuses, and a line for each problem; `known` names the fields of each object, for a guess at a misspelt one. */
function checkFields(shape: z.ZodType, made: Record<string, unknown>, known: Record<string, string[]>): { kept: Record<string, unknown>; problems: string[] } {
  const parsed = shape.safeParse(made);
  if (parsed.success) return { kept: made, problems: [] };
  const kept: Record<string, unknown> = { ...made };
  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const guess = closest(key, known[at] ?? []);
        problems.push(`${at ? `${at}.` : ''}${key}: no such field${guess ? ` (did you mean ${guess}?)` : ''}`);
        // a field misspelt inside one takes the whole top-level field along, as a wrong type does below
        delete kept[at ? String(issue.path[0]) : key];
      }
      continue;
    }
    const missing = issue.code === 'invalid_type' && issue.message.endsWith('received undefined');
    problems.push(`${at}: ${missing ? 'missing' : issue.message.replace(/^Invalid (input|option): /, '')}`);
    // the whole top-level field goes: half a `demo` or `planDocs` would be worse than the default
    delete kept[String(issue.path[0])];
  }
  return { kept, problems };
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
