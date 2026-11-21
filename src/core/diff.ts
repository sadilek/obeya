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

/** A piece of a changed line: `changed` where it differs from the line it replaces (or is replaced by). */
export interface LinePart {
  text: string;
  changed: boolean;
}

/** A line of a text diff; a line that replaces a similar one (or is replaced by it) has `parts`, which mark the words that differ. */
export interface TextLine {
  kind: ' ' | '-' | '+';
  line: string;
  parts?: LinePart[];
}

/** Words, runs of space and single other characters: what a changed line is compared by. */
const tokens = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];

/** Beyond this many token pairs, two lines are not compared word by word (the comparison grows with their product). */
const WORD_CELLS = 250_000;

/**
 * Two lines compared word by word: each split into pieces that both share and pieces only it has;
 * null where they share too little for that to help (less than half their text), so the lines read
 * as one gone and one new.
 */
export function wordDiff(before: string, after: string): [LinePart[], LinePart[]] | null {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > WORD_CELLS) return null;
  const marks = lineDiff(a, b);
  const shared = marks.reduce((n, m) => (m.kind === ' ' && m.line.trim() ? n + m.line.length : n), 0);
  if ((2 * shared) / (before.trim().length + after.trim().length || 1) < 0.5) return null;
  const side = (gone: ' ' | '-' | '+') => {
    const kept = marks.filter((m) => m.kind !== gone);
    const parts: LinePart[] = [];
    kept.forEach((m, i) => {
      // space between two changed words is part of the change, so a changed phrase reads as one
      const changed = m.kind !== ' ' || (!m.line.trim() && kept[i - 1]?.kind !== ' ' && kept[i + 1]?.kind !== ' ' && i > 0 && i < kept.length - 1);
      const last = parts.at(-1);
      if (last && last.changed === changed) last.text += m.line;
      else parts.push({ text: m.line, changed });
    });
    return parts;
  };
  return [side('+'), side('-')];
}

/**
 * The lines of `before` and `after` as a diff the owner reads: in each run of changed lines the
 * gone ones before the new, and a gone line paired with a new one similar to it (in order) marked
 * word by word.
 */
export function textDiff(before: string[], after: string[]): TextLine[] {
  const out: TextLine[] = [];
  const marks = lineDiff(before, after);
  for (let i = 0; i < marks.length; ) {
    if (marks[i]!.kind === ' ') {
      out.push(marks[i++]!);
      continue;
    }
    const gone: TextLine[] = [];
    const added: TextLine[] = [];
    for (; i < marks.length && marks[i]!.kind !== ' '; i++) (marks[i]!.kind === '-' ? gone : added).push({ ...marks[i]! });
    let from = 0;
    for (const g of gone) {
      for (let j = from; j < added.length; j++) {
        const parts = wordDiff(g.line, added[j]!.line);
        if (!parts) continue;
        [g.parts, added[j]!.parts] = parts;
        from = j + 1;
        break;
      }
    }
    out.push(...gone, ...added);
  }
  return out;
}

/** A row of a diff with the unchanged stretches far from a change folded: a line, or how many lines are folded there. */
export type DiffRow = { line: TextLine } | { folded: TextLine[] };

/** A diff with the unchanged lines more than `context` lines from a change folded into a row each (where that hides at least two). */
export function foldUnchanged(lines: TextLine[], context = 3): DiffRow[] {
  const out: DiffRow[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== ' ') {
      out.push({ line: lines[i++]! });
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end]!.kind === ' ') end++;
    const run = lines.slice(i, end);
    const head = i === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;
    if (run.length - head - tail < 2) out.push(...run.map((line) => ({ line })));
    else {
      out.push(...run.slice(0, head).map((line) => ({ line })));
      out.push({ folded: run.slice(head, run.length - tail) });
      out.push(...run.slice(run.length - tail).map((line) => ({ line })));
    }
    i = end;
  }
  return out;
}
