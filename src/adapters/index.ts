import { generic } from './generic';
import { obeya } from './obeya';
import { acme } from './acme';
import type { RepoAdapter, RepoInfo } from './types';

/** Specific adapters first; the generic one matches every repository. */
const ADAPTERS: RepoAdapter[] = [acme, obeya, generic];

export function pickAdapter(repo: RepoInfo, name?: string): RepoAdapter {
  if (name) {
    const a = ADAPTERS.find((x) => x.name === name);
    if (!a) throw new Error(`Unknown adapter "${name}" (known: ${ADAPTERS.map((x) => x.name).join(', ')})`);
    return a;
  }
  return ADAPTERS.find((a) => a.matches(repo))!;
}
