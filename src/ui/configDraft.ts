// What the owner changed in the configuration's dialog but has not saved yet (the canvases with
// their repositories, the demo settings), written down per tab as it changes, so that it outlives
// closing the dialog and a page load: Obeya's restart, say, which reloads the page mid-edit; and
// what the dialog makes of a draft (the clones it fills in, whether saving it restarts agents).

import { type CanvasConfig, CLONES, repoShape, type ResolvedCanvas } from '../core/config';
import { readJson, type Store, writeJson } from './stored';

/** The dialog's drafts that are saved with a button of their own. */
export type ConfigDraftName = 'canvases' | 'demo';

const key = (name: ConfigDraftName) => `obeya-config-draft-${name}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Writes down `draft` while it differs from what is saved (`saved`), else forgets it. */
export function keepConfigDraft<T>(store: Store, name: ConfigDraftName, draft: T, saved: unknown, pick: (d: T) => unknown = (d) => d) {
  writeJson(store, key(name), same(pick(draft), saved) ? null : draft);
}

/** The draft written down, if it still differs from what is saved (`saved`). */
export function keptConfigDraft<T>(store: Store, name: ConfigDraftName, saved: unknown, pick: (d: T) => unknown = (d) => d): T | null {
  const d = readJson<T>(store, key(name));
  return d && !same(pick(d), saved) ? d : null;
}

/** Whether saving `after` over `before` restarts or stops some repository's agents: one that left, or whose shape changed (`repoShape`). */
export function restartsAgents(before: CanvasConfig[], after: CanvasConfig[]): boolean {
  const shapes = (canvases: CanvasConfig[]) => new Map(canvases.flatMap((c) => c.repos.map((r) => [r.path, repoShape(r)] as const)));
  const now = shapes(after);
  return [...shapes(before)].some(([path, shape]) => now.get(path) !== shape);
}

/**
 * Where the count of a repository added in the dialog stands (`withClones`): `filled`, the dialog's
 * `CLONES` is in; `withdrawn`, the dialog took it out again for the existing clones listed; `owner`,
 * the count is the owner's (typed, changed, emptied, or there before the dialog had a say). A path
 * not in it has had nothing filled in yet.
 */
export type FilledClones = Map<string, 'filled' | 'withdrawn' | 'owner'>;

/**
 * The draft with `CLONES` filled in for each repository the saved configuration does not have whose
 * settings say clones (`resolved`, by index) and that names none, once per path, or null when it
 * changes nothing. The dialog's number goes again once existing clones are listed beside it (they
 * add up, so 2 beside 2 existing would make 4) and comes back when the list is emptied, as long as
 * the owner has not touched it; `filled` keeps where each path stands, so a count of the owner's,
 * emptied included, stays as it is.
 */
export function withClones(draft: CanvasConfig[], saved: CanvasConfig[], resolved: (ResolvedCanvas | null)[], filled: FilledClones): CanvasConfig[] | null {
  const known = new Set(saved.flatMap((c) => c.repos.map((r) => r.path.trim())));
  let changed = false;
  const next = draft.map((c, i) => ({
    ...c,
    repos: c.repos.map((r, j) => {
      const path = r.path.trim();
      if (!path || known.has(path) || resolved[i]?.repos[j]?.workspaces !== 'clones') return r;
      const existing = !!r.workspaces?.some((w) => w.trim());
      const state = filled.get(path);
      if (state === 'owner') return r;
      // the count is no longer the one the dialog left: the owner's from now on
      if (r.clones !== (state === 'filled' ? CLONES : undefined)) {
        filled.set(path, 'owner');
        return r;
      }
      if ((state === 'filled') === !existing) return r;
      changed = true;
      filled.set(path, existing ? 'withdrawn' : 'filled');
      if (!existing) return { ...r, clones: CLONES };
      const { clones: _, ...rest } = r;
      return rest;
    }),
  }));
  return changed ? next : null;
}
