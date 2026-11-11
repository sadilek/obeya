// What Obeya knows about how a repository works: its defaults (`generic.ts`) with the repository's
// settings in front (`.obeya/settings.json`, then this machine's). The core only talks to this
// interface.

import type { SharedSettings } from '../core/types';

export interface RepoInfo {
  path: string;
  /** `origin` URL, if any. */
  remote: string | null;
  /** `origin`'s URL as the repository's configuration has it, before git's `insteadOf` rewrites it into `remote`. */
  origin?: string;
  /** Its main branch, where cards start from and work lands (`defaultBranch`); empty in a folder without git. */
  branch: string;
  /** A folder without git (`RepoConfig.git` false): cards work in it directly. */
  folder?: true;
}

/** The repository's settings in front of Obeya's defaults: a field with a default is always there. */
export type RepoAdapter = SharedSettings & Required<Pick<SharedSettings, 'planDocs' | 'land' | 'softPaths' | 'workspaces' | 'language'>>;
