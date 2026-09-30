// A repo adapter holds everything project-specific; the core only talks to this interface.

export interface RepoInfo {
  path: string;
  /** `origin` URL, if any. */
  remote: string | null;
  branch: string;
}

export interface RepoAdapter {
  name: string;
  /** Whether this adapter is meant for the repository (checked when none is named explicitly). */
  matches(repo: RepoInfo): boolean;
  /** One canvas per repository: clones of the same repository share it. */
  canvasId(repo: RepoInfo): string;
  canvasName(repo: RepoInfo): string;
  /** Where plan docs live, relative to the repository root. */
  planDocs: { dir: string; exclude: string[] };

  /** Command a worker runs first in a fresh clone (dependencies). */
  setup?: string;
  /** Checks a worker runs before it reports the card ready for review. */
  checks?: string[];
  /**
   * How approved work lands: `main` fast-forwards the checkout Obeya runs on to the worker's
   * branch (created clones then come from that checkout); `pr` leaves the branch for a pull
   * request (M5) and clones come from `origin`.
   */
  land: 'main' | 'pr';
  /** Workers get full clones from a pool, or a worktree of the Obeya checkout per card. */
  workspaces: 'clones' | 'worktrees';

  /** How a worker brings up the app in its workspace and finds the frontend (M4). */
  stack?: {
    start: string;
    /** After a backend change, without restarting everything. */
    refresh: string;
    /** `KEY=value` file the running stack writes, and the key holding the frontend URL. */
    urls: { file: string; frontendKey: string };
  };
}
