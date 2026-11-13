// What Obeya knows about how a repository works: its defaults (`generic.ts`) with the repository's
// settings in front (`.obeya/settings.json`, then this machine's). The core only talks to this
// interface.

import type { SharedSettings } from '../core/config';

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
  /** The original repository's main branch as detected (`detectUpstream`), where the checkout is a fork with a remote `upstream`. */
  upstream?: string;
  /** The URLs of its remotes, by name: the original repository's, for one, which cards may go to as a pull request. */
  remotes?: Record<string, string>;
}

/** The repository's settings in front of Obeya's defaults: a field with a default is always there. */
export type RepoAdapter = SharedSettings & Required<Pick<SharedSettings, 'planDocs' | 'land' | 'autoMerge' | 'checks' | 'setup' | 'softPaths' | 'workspaces' | 'prNoise' | 'language'>>;
