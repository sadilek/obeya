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
  /**
   * Paths (a trailing `/` covers a directory) whose edits never count as a merge conflict between
   * two cards: they are resolved when a branch is rebased (docs, plan docs).
   */
  softPaths: string[];
  /** Workers get full clones from a pool, or a worktree of the Obeya checkout per card. */
  workspaces: 'clones' | 'worktrees';

  /**
   * Demos: whether a worker must hand over with one, and how it runs the app to record it (for
   * the `demo` skill). Without it, a written summary is enough.
   */
  demo?: {
    required: boolean;
    howToRun: string;
    /**
     * The command (argv) that shares a video demo with colleagues on a page outside Obeya. Obeya
     * runs it in the repository with `OBEYA_HOME` set: `publish` with the page as JSON on stdin
     * (`SharePage` in `src/server/share.ts`), printing the page's URL; `withdraw <slug>` takes it
     * down; `version`, where it knows it, prints the version of the pages it writes (and `all` when
     * each call writes every page afresh). Without it, demos are not shared.
     */
    share?: string[];
  };

  /** Accounts whose pull request comments are not review feedback (deploy bots and the like). */
  prNoise?: string[];

  /** How a worker brings up the app in its workspace and finds the frontend. */
  stack?: {
    start: string;
    /** After a backend change, without restarting everything. */
    refresh: string;
    /** `KEY=value` file the running stack writes, and the key holding the frontend URL. */
    urls: { file: string; frontendKey: string };
  };
}
