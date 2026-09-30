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

  // Filled in by later milestones; unused in M1.

  /** How a worker brings up the app in its workspace and finds the frontend (M2, M3). */
  stack?: {
    start: string;
    /** After a backend change, without restarting everything. */
    refresh: string;
    /** `KEY=value` file the running stack writes, and the key holding the frontend URL. */
    urls: { file: string; frontendKey: string };
  };
  /** Checks a worker runs before a card goes to `waiting` (M2). */
  checks?: string[];
}
