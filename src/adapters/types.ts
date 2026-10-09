// A repo adapter holds everything project-specific; the core only talks to this interface.

export interface RepoInfo {
  path: string;
  /** `origin` URL, if any. */
  remote: string | null;
  branch: string;
}

/**
 * A static site the demos are shared on: Obeya keeps its directory (one subdirectory per page, and
 * the overview), writes the pages with its own templates and runs the deploy line after each change.
 */
export interface DemoSite {
  /** The overview's heading, and the pages' tab titles. */
  title: string;
  /** Where the site is served; a page's URL is `url/<slug>/`. */
  url: string;
  /** The command (argv) that deploys the site; `{dir}` stands for its directory. */
  deploy: string[];
  /**
   * A file of `KEY=value` lines, relative to Obeya's home, added to the deploy's environment
   * (credentials, never in git). A machine without it exports demos instead of sharing them.
   */
  env?: string;
  /** Headers for reading the live site (behind a login), values `${KEY}` from `env`; read once several machines publish to one site. */
  headers?: Record<string, string>;
  /** The largest file the host takes, in bytes; 25 MiB without it. */
  maxFile?: number;
  /** The overview's words; without it the narration language of the demo settings. */
  language?: 'de' | 'en';
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
   * With `land: 'pr'`: the owner may approve a card's work directly onto the default branch
   * instead, without a pull request. Obeya rebases it onto `origin`'s default branch and pushes it
   * there (never forced); review and the CI of a pull request are skipped.
   */
  direct?: boolean;
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
     * The command (argv) that shares a demo with colleagues on a page outside Obeya. Obeya runs
     * it in a directory under its home, not in the repository, with `OBEYA_HOME` set and the
     * repository's checkout in `OBEYA_REPO`: `publish` with the page as JSON on stdin
     * (`SharePage` in `src/server/share.ts`), printing the page's URL; `withdraw <slug>` takes it
     * down; `version`, where it knows it, prints the version of the pages it writes. Without it, demos are not shared.
     * For a host that takes a directory, `site` does it all instead.
     */
    share?: string[];
    /** A static site Obeya keeps and deploys itself (`src/server/site.ts`); it goes before `share`. */
    site?: DemoSite;
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
    /**
     * Stops the stack in a workspace. Obeya runs it there when the card waits for the owner and its
     * worker has nothing running (Parking), and tells the worker with its next message.
     */
    stop?: string;
    /** Exits 0 when the workspace's stack holds what must not be lost (a restored database, say): Obeya then leaves it running. */
    keep?: string;
  };
}
