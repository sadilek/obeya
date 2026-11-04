// What a card's work changes in its repository, as `git diff` shows it: the server sums it up for
// the line beside the card's branch, the UI shows it file by file.

/** A card's change: the branch in its workspace so far, or what landed; in a folder without git, what the card changed there. */
export interface CardDiff {
  /**
   * `branch`: the workspace's branch against the default branch, committed or not; `landed`: what
   * the landing put on the default branch; `folder`: what the card changed in a folder without git
   * (`folder` holds the list, `patch` the text files' diffs).
   */
  source: 'branch' | 'landed' | 'folder';
  files: DiffFile[];
  folder?: FolderChanges;
  /** The whole diff, when it was asked for; cut off at `PATCH_LIMIT` characters (`truncated`). */
  patch?: string;
  truncated?: true;
}

export interface DiffFile {
  /** The file as it is now (as it was, for a deleted one). */
  file: string;
  /** A renamed file: its name before. */
  from?: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  added: number;
  removed: number;
  binary?: true;
}

/** What a card changed in a folder without git (design: Folders without git), as its change list shows it. */
export interface FolderChanges {
  /**
   * Which undo the card has: `full` from a clone of the folder taken at its start (where the file
   * system clones), `partial` from copies of what its editing tools overwrote and of the folder's
   * text files; null once nothing can be undone (the card is done).
   */
  undo: 'full' | 'partial' | null;
  changes: FolderChange[];
  /**
   * What changed while only calls of the card ran that write nothing (a command that only reads or
   * waits): another program may have made it, so it is no change of the card's, nor undone with them.
   */
  uncertain?: FolderChange[];
}

export interface FolderChange {
  kind: 'added' | 'modified' | 'deleted' | 'moved';
  /** Relative to the folder, with `/`; where it is now (for a deleted one, where it was). */
  path: string;
  /** A moved one: where it was. */
  from?: string;
  dir?: true;
  /** A moved file the card also changed. */
  changed?: true;
  /** A file the card made or changed that is no longer where it left it: someone deleted or moved it since. */
  gone?: true;
  /** Lines added and removed, for a text file whose earlier version Obeya kept. */
  added?: number;
  removed?: number;
  /**
   * What undoing the card does with it: puts it back (`yes`); cannot, as no copy of it from before
   * the card's change is kept (`lost`); or leaves it as it is, since someone changed it after the
   * card (`changedSince`), or since another card's agent was at work when it changed and it may be
   * that card's (`shared`). None once nothing can be undone.
   */
  undo?: 'yes' | 'lost' | 'changedSince' | 'shared';
}

/** The changes as the owner reads them: a directory the card added shows through what it put in it, a deleted one stands for what it held. */
export function shownChanges(changes: FolderChange[]): FolderChange[] {
  const gone = changes.filter((c) => c.dir && c.kind === 'deleted').map((c) => c.path);
  return changes.filter((c) => {
    if (gone.some((d) => c.path.startsWith(`${d}/`))) return false;
    if (c.dir && c.kind === 'added') return !changes.some((x) => x !== c && x.path.startsWith(`${c.path}/`));
    return true;
  });
}

/** How much of a diff goes to the page: beyond it, it is cut off at a file's end. */
export const PATCH_LIMIT = 2_000_000;

/** One file's part of a `git diff`: the summary, and its lines from the `diff --git` line on. */
export interface DiffPart extends DiffFile {
  lines: string[];
}

/** A `git diff` split into its files, each with what it adds and removes. */
export function splitDiff(patch: string): DiffPart[] {
  const out: DiffPart[] = [];
  let header = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // the names as the header line has them; `---`/`+++` or `rename` lines correct them below
      const names = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      out.push({ file: names?.[2] ?? line.slice(11), status: 'modified', added: 0, removed: 0, lines: [line] });
      header = true;
      continue;
    }
    const cur = out.at(-1);
    if (!cur) continue;
    cur.lines.push(line);
    if (header) {
      if (line.startsWith('@@')) header = false;
      else if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) [cur.status, cur.from] = ['renamed', line.slice(12)];
      else if (line.startsWith('rename to ')) cur.file = line.slice(10);
      // git ends a name with a space in it with a tab here
      else if (line.startsWith('+++ b/')) cur.file = line.slice(6).replace(/\t$/, '');
      else if (line.startsWith('--- a/') && cur.status === 'deleted') cur.file = line.slice(6).replace(/\t$/, '');
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true;
      continue;
    }
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return out;
}

/** The files of a diff without their lines. */
export const diffFiles = (patch: string): DiffFile[] => splitDiff(patch).map(({ lines: _, ...f }) => f);

/** Lines added and removed over all files. */
export function diffSize(files: DiffFile[]): { added: number; removed: number } {
  return files.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), { added: 0, removed: 0 });
}

/** A card's change from its whole diff: the files, and the diff itself when asked for (cut off at a file's end past `PATCH_LIMIT`). */
export function cardDiff(source: CardDiff['source'], patch: string, full: boolean): CardDiff {
  const files = diffFiles(patch);
  if (!full) return { source, files };
  if (patch.length <= PATCH_LIMIT) return { source, files, patch };
  const cut = patch.lastIndexOf('\ndiff --git ', PATCH_LIMIT);
  return { source, files, patch: patch.slice(0, cut > 0 ? cut : PATCH_LIMIT), truncated: true };
}

/** The lines of `before` and `after` as a diff: each kept (` `), gone (`-`) or new (`+`), in order (longest common subsequence). */
export function lineDiff(before: string[], after: string[]): { kind: ' ' | '-' | '+'; line: string }[] {
  const n = before.length;
  const m = after.length;
  // common[i][j]: the longest common subsequence of before[i..] and after[j..]
  const common = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) common[i]![j] = before[i] === after[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const out: { kind: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: ' ', line: before[i]! });
      i++;
      j++;
    } else if (i < n && (j === m || common[i + 1]![j]! >= common[i]![j + 1]!)) out.push({ kind: '-', line: before[i++]! });
    else out.push({ kind: '+', line: after[j++]! });
  }
  return out;
}
