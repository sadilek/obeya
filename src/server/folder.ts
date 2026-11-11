// A folder without git as a repository (design: Folders without git). Every card works in the
// folder itself, beside other cards, the owner and whatever syncs it; nothing lands. What a card
// changes is told from a manifest of the folder (path, size, mtime, inode; a hash only of what
// changed), taken again after each of its tool calls that may write: a change goes to the card
// whose call ran when it happened (its ctime, which no tool sets), so the changes of the others
// stay theirs; one during a call that writes nothing (a command that only reads or waits) is kept
// apart as uncertain, as another program may have made it. Undo puts back what the card changed: from a clone of the folder taken at its start
// where the file system clones (APFS, btrfs, XFS), else from copies of what its editing tools
// overwrote and of the folder's text files.

import { constants, mkdirSync, realpathSync, statSync, type Stats, writeFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CardDiff, DiffFile, FolderChange, FolderChanges } from '../core/diff';
import { cardDiff } from '../core/diff';
import type { PoolHost } from '../core/types';
import { shared } from '../core/one-at-a-time';
import { messageOf } from '../core/text';
import type { Store } from './db';
import { spawnOutput } from './spawn';
import { writesNothing } from './shell';
import { type CardWorkspaces, type Change, type FileAt, ownFile, type LandProblem, type Landed, type Lease } from './workspaces';
import { GIT, WorkspaceError } from './git';

/** A file or directory as the manifest has it. */
export interface Entry {
  size: number;
  mtime: number;
  /** When it last changed in any way, as only the file system sets it: what tells whose change it was. */
  ctime: number;
  ino: number;
  dir?: true;
  /** Its bytes are only in the cloud (a dataless file of a file provider): it is never read or copied, which would download it. */
  cloud?: true;
  /** Of its contents, where Obeya read them: of what a card changed, to tell later whether someone changed it again. */
  hash?: string;
}

/** The folder's files and directories by their path relative to it (with `/`); `''` is the folder. */
export type Manifest = Map<string, Entry>;

/** What the folder's file manager, sync client or office suite keep there for themselves; never a card's change. */
const SKIPPED = new Set(['.DS_Store', '.git', '.Trash', '.Trashes', '.localized', '.tmp.drivedownload', '.tmp.driveupload', 'Thumbs.db', 'desktop.ini', 'Icon\r', '.obeya-restore']);
const skipped = (name: string) => SKIPPED.has(name) || name.startsWith('~$') || name.startsWith('.~lock.') || name.startsWith('.obeya-restore-');

/**
 * A file the provider keeps only in the cloud (macOS: no blocks on disk for a file with a size).
 * Elsewhere the blocks say nothing of that, and Windows reports none for every file.
 */
const dataless = (s: Stats) => process.platform === 'darwin' && s.isFile() && s.size > 0 && s.blocks === 0;

/** Whether a file's contents changed between two looks at it, by its size and modification time. */
const differs = (a: Entry, b: Entry) => a.size !== b.size || a.mtime !== b.mtime;

/** Whether `a` and `b` have the same size and, to within a millisecond, the same modification time. */
const sameStamp = (a: Entry, b: Entry) => a.size === b.size && Math.abs(a.mtime - b.mtime) < 1;

async function entryAt(path: string): Promise<Entry | null> {
  try {
    const s = await lstat(path);
    if (s.isDirectory()) return { size: 0, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino, dir: true };
    if (!s.isFile() && !s.isSymbolicLink()) return null;
    return { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, ino: s.ino, ...(dataless(s) ? { cloud: true as const } : {}) };
  } catch {
    return null;
  }
}

/** The manifest of the folder at `root`: every file and directory under it, but what `SKIPPED` names. Reads no file. */
export async function walk(root: string): Promise<Manifest> {
  const out: Manifest = new Map();
  const top = await entryAt(root);
  if (!top) return out;
  out.set('', top);
  const dirs = [''];
  while (dirs.length) {
    const batch = dirs.splice(0, 32);
    await Promise.all(
      batch.map(async (rel) => {
        let names: string[];
        try {
          names = await readdir(rel ? join(root, rel) : root);
        } catch {
          return;
        }
        await Promise.all(
          names
            .filter((n) => !skipped(n))
            .map(async (name) => {
              const path = rel ? `${rel}/${name}` : name;
              const e = await entryAt(join(root, path));
              if (!e) return;
              out.set(path, e);
              if (e.dir) dirs.push(path);
            }),
        );
      }),
    );
  }
  return out;
}

/** A change between two manifests, with when it happened (`at`, the file system's clock). */
export interface RawChange {
  kind: 'added' | 'modified' | 'deleted' | 'moved';
  path: string;
  from?: string;
  /** A file a moved directory took along: where it was. */
  was?: string;
  dir?: true;
  before?: Entry;
  after?: Entry;
  at: number;
}

const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `path`'s directories, nearest first, the folder (`''`) last. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(path); ; p = parentOf(p)) {
    out.push(p);
    if (!p) return out;
  }
}

/**
 * What changed from `last` to `next` (only at `only`, where given): added, deleted, modified (size
 * or mtime), and moved (a deleted and an added one with the same inode, or for a file the same size
 * and mtime). What moved with a directory is the directory's move. A deleted one happened when its
 * nearest directory still there last changed.
 */
export function compare(last: Manifest, next: Manifest, only?: Iterable<string>): RawChange[] {
  const keys = only ? new Set(only) : new Set([...last.keys(), ...next.keys()]);
  keys.delete('');
  const added: RawChange[] = [];
  const deleted: RawChange[] = [];
  const out: RawChange[] = [];
  const when = (path: string) => {
    for (const a of ancestors(path)) {
      const e = next.get(a);
      if (e) return e.ctime;
    }
    return Date.now();
  };
  // in the order of their paths, whatever order the folder was read in
  for (const path of [...keys].sort()) {
    const a = last.get(path);
    const b = next.get(path);
    if (a && b && !!a.dir === !!b.dir) {
      if (!b.dir && differs(a, b)) out.push({ kind: 'modified', path, before: a, after: b, at: b.ctime });
      continue;
    }
    if (a) deleted.push({ kind: 'deleted', path, ...(a.dir ? { dir: true as const } : {}), before: a, at: when(path) });
    if (b) added.push({ kind: 'added', path, ...(b.dir ? { dir: true as const } : {}), after: b, at: b.ctime });
  }
  const moves: RawChange[] = [];
  const take = (add: RawChange, del: RawChange) => {
    deleted.splice(deleted.indexOf(del), 1);
    added.splice(added.indexOf(add), 1);
    moves.push({ kind: 'moved', path: add.path, from: del.path, ...(add.dir ? { dir: true as const } : {}), before: del.before!, after: add.after!, at: add.at });
  };
  const byIno = new Map<number, RawChange[]>();
  for (const d of deleted) if (d.before!.ino) byIno.set(d.before!.ino, [...(byIno.get(d.before!.ino) ?? []), d]);
  for (const add of [...added]) {
    const del = byIno.get(add.after!.ino)?.find((d) => !!d.dir === !!add.dir && deleted.includes(d));
    if (del) take(add, del);
  }
  // a copy that kept its time and size, then the original deleted (a sync client's move, say)
  for (const add of [...added]) {
    if (add.dir || !add.after!.size) continue;
    const dels = deleted.filter((d) => !d.dir && !differs(d.before!, add.after!));
    if (dels.length === 1 && added.filter((x) => !x.dir && !differs(x.after!, add.after!)).length === 1) take(add, dels[0]!);
  }
  const dirMoves = moves.filter((m) => m.dir);
  const along = (m: RawChange) => dirMoves.some((d) => d !== m && under(m.from!, d.from!) && m.path === d.path + m.from!.slice(d.from!.length));
  // what a moved directory took along is its move; what changed in it besides is a change of its own, where it is now
  const carried = moves.filter(along);
  for (const m of carried)
    if (!m.dir && differs(m.before!, m.after!)) out.push({ kind: 'modified', path: m.path, was: m.from!, before: m.before!, after: m.after!, at: m.at });
  return [...moves.filter((m) => !carried.includes(m)), ...out, ...added, ...deleted];
}

/** How much of a file is read to tell text from binary, as git does: a NUL byte in it makes it binary. */
const SNIFF = 8000;
/** A text file larger than this is not copied for the partial undo nor shown as a diff. */
const TEXT_MAX = 1024 * 1024;
/** A file larger than this is not hashed: its size and mtime tell it. */
const HASH_MAX = 256 * 1024 * 1024;

/** Whether the file is text: not larger than `TEXT_MAX`, and no NUL byte in its first bytes. */
export async function isText(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > TEXT_MAX || dataless(s)) return false;
    const f = await open(path, 'r');
    try {
      const buf = new Uint8Array(Math.min(SNIFF, s.size));
      const { bytesRead } = await f.read(buf, 0, buf.length, 0);
      return !buf.subarray(0, bytesRead).includes(0);
    } finally {
      await f.close();
    }
  } catch {
    return false;
  }
}

async function hashFile(path: string, size: number): Promise<string | undefined> {
  if (size > HASH_MAX) return undefined;
  try {
    const h = new Bun.CryptoHasher('sha1');
    for await (const chunk of Bun.file(path).stream()) h.update(chunk);
    return h.digest('hex');
  } catch {
    return undefined;
  }
}

/** Copies `src` to `dst` (its directories made), a clone where the file system can, keeping its mtime. */
async function copyKeeping(src: string, dst: string, force = false) {
  await mkdir(join(dst, '..'), { recursive: true });
  await copyFile(src, dst, force ? constants.COPYFILE_FICLONE_FORCE : constants.COPYFILE_FICLONE);
  const s = await stat(src);
  await utimes(dst, s.atime, s.mtime);
}

/** Whether the file system clones `src` into `dir`: same volume, and a file system that clones. */
async function clones(src: string | undefined, dir: string): Promise<boolean> {
  if (!src) return true;
  const probe = join(dir, '.probe');
  try {
    await copyFile(src, probe, constants.COPYFILE_FICLONE_FORCE);
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => {});
    return false;
  }
}

/** Runs `f` over `items`, `n` at a time. */
async function inBatches<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(f));
}

/** A change the card made, as its record keeps it: before its first change and after its last. */
interface Tracked {
  kind: 'added' | 'modified' | 'deleted' | 'moved';
  path: string;
  from?: string;
  dir?: true;
  /** Moved, and its contents changed too. */
  changed?: true;
  /** Where it was before a directory the card moved took it along: its copies are kept by that path. */
  was?: string;
  /** Another card's call ran when it changed too: whose change it was cannot be told, so undo leaves it. */
  shared?: true;
  before?: Entry;
  after?: Entry;
}

/** A card's record in its folder (`folder_cards`). */
export interface FolderCard {
  /** It works in the folder (a workspace it holds, as a clone would be held). */
  held?: true;
  /** Its work is over: nothing is undone any more; a follow-up's changes are still its own. */
  done?: true;
  /** The undo it has, once Obeya made it ready (`snapshot/`, or `text/`); none before, and once done. */
  undo: 'full' | 'partial' | null;
  changes: Tracked[];
  /**
   * What changed during its calls that write nothing (a command that only reads or waits): not its
   * change, as another program may have made it; listed apart, never undone.
   */
  uncertain?: Tracked[];
}

/** Whether the change `c` is at `path`: there, or where it came from. */
const at = (c: RawChange, path: string) => path === c.path || path === c.from;

/**
 * Folds a change that may not be the card's into its list of those: unless it is at something the
 * card changed itself, which stays as the card left it (undo then finds it changed since).
 */
export function mergeUncertain(rec: FolderCard, c: RawChange) {
  if (rec.changes.some((t) => !!t.dir === !!c.dir && (at(c, t.path) || (t.from !== undefined && at(c, t.from))))) return;
  mergeOne((rec.uncertain ??= []), c);
}

/**
 * Folds a change the card made into its list: what it changes was, before, as another program may
 * have left it, which is no longer listed apart; what such a program changed in a directory the
 * card moves goes along with it.
 */
export function mergeOwn(rec: FolderCard, c: RawChange, shared = false) {
  if (rec.uncertain) {
    rec.uncertain = rec.uncertain.filter((t) => !(!!t.dir === !!c.dir && at(c, t.path)));
    if (c.kind === 'moved' && c.dir) for (const t of rec.uncertain) if (under(t.path, c.from!)) t.path = c.path + t.path.slice(c.from!.length);
  }
  merge(rec.changes, c, shared);
}

/** Folds a change into a card's list: one entry per thing it changed, from before its first change to after its last. */
export function merge(list: Tracked[], c: RawChange, shared = false) {
  const before = list.length;
  mergeOne(list, c);
  // whatever entry the change went into is no longer this card's alone
  if (shared) {
    const t = list.find((x) => x.path === c.path && !!x.dir === !!c.dir) ?? (list.length > before ? list.at(-1) : undefined);
    if (t) t.shared = true;
  }
}

function mergeOne(list: Tracked[], c: RawChange) {
  const at = (path: string) => list.findIndex((t) => t.path === path && !!t.dir === !!c.dir);
  const dir = c.dir ? { dir: true as const } : {};
  if (c.kind === 'added') {
    const i = at(c.path);
    const t = list[i];
    if (!t) list.push({ kind: 'added', path: c.path, ...dir, after: c.after! });
    else if (t.kind === 'deleted') {
      if (c.dir) list.splice(i, 1);
      else list[i] = { kind: 'modified', path: c.path, before: t.before!, after: c.after! };
    } else t.after = c.after!;
  } else if (c.kind === 'modified') {
    const i = at(c.path);
    const t = list[i];
    if (!t) list.push({ kind: 'modified', path: c.path, ...(c.was ? { was: c.was } : {}), before: c.before!, after: c.after! });
    else {
      t.after = c.after!;
      if (t.kind === 'moved') t.changed = true;
    }
  } else if (c.kind === 'deleted') {
    const i = at(c.path);
    const t = list[i];
    if (!t) list.push({ kind: 'deleted', path: c.path, ...dir, before: c.before! });
    else if (t.kind === 'added') list.splice(i, 1);
    else if (t.kind === 'moved') list[i] = { kind: 'deleted', path: t.from!, ...dir, before: t.before! };
    else list[i] = { kind: 'deleted', path: t.path, ...dir, before: t.before! };
  } else {
    const from = c.from!;
    // what the card changed in a directory goes along with it
    if (c.dir)
      for (const t of list)
        if (under(t.path, from)) {
          if (t.kind !== 'moved' && t.was === undefined) t.was = t.path;
          t.path = c.path + t.path.slice(from.length);
        }
    const i = at(from);
    const t = list[i];
    const changed = !c.dir && differs(c.before!, c.after!);
    if (!t) list.push({ kind: 'moved', path: c.path, from, ...dir, ...(changed ? { changed: true as const } : {}), before: c.before!, after: c.after! });
    else if (t.kind === 'added') Object.assign(t, { path: c.path, after: c.after! });
    else if (t.kind === 'moved') {
      if (t.from !== c.path) Object.assign(t, { path: c.path, after: c.after! });
      // back where it was
      else if (t.changed) list[i] = { kind: 'modified', path: c.path, before: t.before!, after: c.after! };
      else list.splice(i, 1);
    } else if (t.kind === 'modified') list[i] = { kind: 'moved', path: c.path, from, changed: true, before: t.before!, after: c.after! };
  }
}

/** Whether the entry `e` is still as the card left it: size and mtime, else its contents. */
async function unchanged(path: string, e: Entry | undefined, now: Entry | null): Promise<boolean> {
  if (!e || !now || !!e.dir !== !!now.dir) return false;
  if (e.dir) return true;
  // nothing touched it since: its ctime is the system's alone
  if (now.ctime === e.ctime && now.ino === e.ino) return true;
  // touched: its contents tell, where they were read; else its size and time
  if (e.hash && !now.cloud) return e.size === now.size && (await hashFile(path, now.size)) === e.hash;
  return sameStamp(e, now);
}

/** A tool call of an agent, as the session's hooks see it before and after it runs. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Follows an agent's tool calls in the folder (`AgentSpec.watch`). */
export interface ToolWatch {
  /** Before a call: settles once it may run (the card's undo is ready, what it overwrites is copied). */
  before(call: ToolCall): Promise<void>;
  /** After a call, done or failed: settles once what it changed is the card's. */
  after(call: ToolCall): Promise<void>;
}

/** Tools that change no file: no manifest is taken around them. */
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'ToolSearch', 'TaskOutput', 'BashOutput', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
/** Tools that write the one file their input names. */
const EDITS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

const writes = (name: string) => !READS.has(name) && !name.startsWith('mcp__obeya__');

/**
 * A tool call's window: from just before it ran until Obeya has read what it changed. `only`: the
 * paths it can change, for a call that writes one file; `reads`: a command that writes nothing, so
 * what changes meanwhile is no change of its own.
 */
interface Window {
  card: string;
  id: string;
  start: number;
  end?: number;
  only?: Set<string>;
  reads?: true;
}

/**
 * How far after a window's end a change's time may lie and still count as the window's: the file
 * system's clock is finer than Date.now(), which is cut down to the millisecond. A file system that
 * keeps whole seconds (HFS+, ext3) gets a second on both sides.
 */
const SLACK_MS = 1;

/** What undoing a card did, by path (`from → path` for a move put back). */
export interface UndoReport {
  undone: string[];
  /** Someone changed these after the card: left as they are. */
  changedSince: string[];
  /** No copy from before the card's change was kept: left as they are. */
  lost: string[];
  /** Another card's call ran when they changed, so they may be its: left as they are. */
  shared: string[];
}

export interface FolderOptions {
  /** The folder, as the configuration names it (a symbolic link stays one: agents work there by that name). */
  path: string;
  /** Where the cards' undo goes (a clone of the folder, or copies), under Obeya's home. */
  dir: string;
  /** A card's change list changed. */
  onChange?: (cardId: string) => void;
  /** `false`: the partial undo even where the file system clones. */
  clone?: false;
}

/**
 * The folder as every card's workspace: no branches, nothing lands. Keeps the folder's manifest as
 * last read, the windows of the tool calls running in it, and each card's changes and undo.
 */
export class FolderWorkspaces implements CardWorkspaces {
  readonly mode = 'folder' as const;
  readonly pooled = false;
  /** The folder with its links resolved: what the manifest is of. */
  private root: string;
  private last: Manifest = new Map();
  private baseline: Promise<void>;
  private windows: Window[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  /** A reading of the whole folder that has not started yet: later calls that ended share it. */
  private pending: { started: boolean; done: Promise<void> } | null = null;
  private ready = new Map<string, Promise<void>>();
  private records = new Map<string, FolderCard | null>();
  /** Undo under way, by card: a second click waits for the first. */
  private undoing = new Map<string, Promise<UndoReport>>();
  /** What an undo put back, until the folder is read after it: those changes are no card's. */
  private quiet = new Set<string>();

  constructor(
    private store: Store,
    private o: FolderOptions,
  ) {
    try {
      this.root = realpathSync(o.path);
    } catch {
      this.root = resolve(o.path);
    }
    this.baseline = walk(this.root).then((m) => void (this.last = m));
  }

  get dir() {
    return this.o.dir;
  }

  /** Settles once the folder's first manifest is read. */
  get read(): Promise<void> {
    return this.baseline;
  }

  // ---------------------------------------------------------------- the card's record

  private rec(cardId: string): FolderCard | null {
    if (!this.records.has(cardId)) {
      const json = this.store.folderCard(cardId);
      this.records.set(cardId, json ? (JSON.parse(json) as FolderCard) : null);
    }
    return this.records.get(cardId)!;
  }

  private save(cardId: string, rec: FolderCard | null) {
    this.records.set(cardId, rec);
    this.store.setFolderCard(cardId, this.root, rec ? JSON.stringify(rec) : null);
  }

  private undoDir(cardId: string) {
    return join(this.o.dir, cardId.slice(0, 8));
  }

  /** Removes the card's undo (its clone of the folder, or its copies); it is made afresh before its next change. */
  private dropUndo(cardId: string) {
    this.ready.delete(cardId);
    void rm(this.undoDir(cardId), { recursive: true, force: true }).catch((e) => console.error(`removing the undo of ${cardId}:`, messageOf(e)));
  }

  // ---------------------------------------------------------------- as a workspace

  list() {
    return [];
  }

  leasedBy(cardId: string): string | null {
    return this.rec(cardId)?.held ? this.o.path : null;
  }

  /** The folder itself, for any number of cards at once; the card's undo is made ready meanwhile. */
  lease(cardId: string): Lease {
    const rec = this.rec(cardId) ?? { undo: null, changes: [] };
    this.save(cardId, { ...rec, held: true });
    if (!rec.done) void this.prepare(cardId);
    return { path: this.o.path, ready: null };
  }

  leasable(): boolean {
    return true;
  }

  pool(): PoolHost[] {
    return [];
  }

  async hasWork(cardId: string): Promise<boolean> {
    return this.changed(cardId).length > 0;
  }

  /** A card stopped with nothing changed: its record and undo go. */
  release(cardId: string) {
    const rec = this.rec(cardId);
    if (!rec) return;
    if (rec.changes.length) return this.save(cardId, { ...rec, held: undefined });
    this.save(cardId, null);
    this.dropUndo(cardId);
  }

  /** The folder is no pool: no card's workspace goes to another. */
  async evict(): Promise<string | null> {
    return null;
  }

  /** The folder is no pool: nothing to give back. */
  async abandon(): Promise<boolean> {
    return false;
  }

  retake(cardId: string): Lease | null {
    const own = this.leasedBy(cardId);
    return own ? { path: own, ready: null } : null;
  }

  async forkPoint(): Promise<null> {
    return null;
  }

  async addedFiles(): Promise<string[]> {
    return [];
  }

  async landOnMain(): Promise<LandProblem | Landed> {
    return { code: 'land', worker: false, detail: 'a folder without git lands nothing' };
  }

  pushToMain(): Promise<LandProblem | Landed> {
    return this.landOnMain();
  }

  /** The owner approved the card: its undo goes at once, though its worker may still finish in the folder. */
  done(cardId: string) {
    const rec = this.rec(cardId);
    if (!rec || rec.done) return;
    this.save(cardId, { ...rec, done: true, undo: null });
    this.dropUndo(cardId);
  }

  /** The card's work is over: its undo goes; what it changed stays its record. */
  async removeLanded(cardId: string) {
    const rec = this.rec(cardId);
    if (!rec) return;
    this.save(cardId, { ...rec, held: undefined, done: true, undo: null });
    this.dropUndo(cardId);
  }

  /** The card goes: its record and undo with it. */
  async discard(cardId: string) {
    if (!this.rec(cardId)) return;
    this.save(cardId, null);
    this.dropUndo(cardId);
  }

  async transfer(): Promise<{ path: string; branch: string }> {
    throw new WorkspaceError('a folder without git has no branch to build on');
  }

  followUpTree(cardId: string): Lease {
    return this.lease(cardId);
  }

  async removeFollowUpTree() {}

  async landedDiff(): Promise<CardDiff | null> {
    return null;
  }

  /** The files the card changed in the folder as they are now: neither deleted nor a directory. */
  async changedFiles(cardId: string): Promise<string[]> {
    return (this.rec(cardId)?.changes ?? []).filter((t) => t.kind !== 'deleted' && !t.dir).map((t) => t.path);
  }

  /** A file in the folder, for a card that changed something there; a link is none. */
  async fileOf(cardId: string, path: string): Promise<FileAt | null> {
    return this.rec(cardId) ? ownFile(this.root, path) : null;
  }

  /** What the card changed, for the Coordinator: each path with what happened to it. */
  async changes(cardId: string): Promise<Change[]> {
    return this.changed(cardId);
  }

  /** What the card changed, as `changes` has it, read at once from what Obeya recorded. */
  changed(cardId: string): Change[] {
    return (this.rec(cardId)?.changes ?? []).map((t) => ({
      file: t.dir ? `${t.path}/` : t.path,
      regions: t.kind === 'moved' ? [`moved from ${t.from}${t.changed ? ', and changed' : ''}`] : t.kind === 'modified' ? [] : [t.kind],
    }));
  }

  // ---------------------------------------------------------------- following the cards' tool calls

  /** The hooks around the card's tool calls (`AgentSpec.watch`). */
  watch(cardId: string): ToolWatch {
    return {
      before: async (call) => {
        if (!writes(call.name)) return;
        await this.baseline;
        const rec = this.rec(cardId);
        if (!rec) return;
        if (!rec.done) await this.prepare(cardId);
        const field = EDITS[call.name];
        let only: Set<string> | undefined;
        if (field) {
          const file = this.inside(call.input[field]);
          only = new Set(file ? [file, ...ancestors(file)] : []);
          // what is there before it writes (a file the owner just made, say) is not the call's change
          if (file) await this.scan([...only]);
          if (file && !rec.done) await this.keepBefore(cardId, file);
        }
        // nor is what changed since the folder was last read, before a call that may write anywhere
        else await this.scanAll();
        const reads = !field && call.name === 'Bash' && typeof call.input.command === 'string' && writesNothing(call.input.command);
        this.windows.push({ card: cardId, id: call.id, start: this.clock(), ...(only ? { only } : {}), ...(reads ? { reads: true as const } : {}) });
      },
      after: async (call) => {
        const w = this.windows.find((x) => x.card === cardId && x.id === call.id && x.end === undefined);
        if (!w) return;
        await this.close(w);
      },
    };
  }

  /**
   * The card's background work runs (`true`) or has ended: what it changes meanwhile is the card's,
   * as during a call.
   */
  background(cardId: string, running: boolean) {
    const open = this.windows.find((x) => x.card === cardId && x.id === 'background' && x.end === undefined);
    if (running && !open && this.rec(cardId)) this.windows.push({ card: cardId, id: 'background', start: this.clock() });
    else if (!running && open) void this.close(open);
  }

  /**
   * The time as the file system stamps a change's ctime, read off a file of Obeya's own written
   * now. Linux stamps it from a coarse clock, up to a tick (1 to 10 ms) behind Date.now(), and
   * Windows may too: by Date.now(), a change right after a window opened would come before it.
   * Read at once, so nothing happens between the reading and the window's opening.
   */
  private clock(): number {
    const now = Date.now();
    const file = join(this.o.dir, 'clock');
    try {
      try {
        writeFileSync(file, 'x');
      } catch {
        mkdirSync(this.o.dir, { recursive: true });
        writeFileSync(file, 'x');
      }
      return Math.min(now, statSync(file).ctimeMs);
    } catch {
      return now;
    }
  }

  /** The card's turn is over: calls whose end the hooks never told (refused, cut off) end now. */
  settle(cardId: string): Promise<void> {
    return Promise.all(this.windows.filter((x) => x.card === cardId && x.end === undefined && x.id !== 'background').map((w) => this.close(w))).then(() => {});
  }

  /** Ends a window: once the folder is read after it, its changes are the card's, and it goes. */
  private async close(w: Window) {
    w.end = Date.now();
    try {
      await (w.only ? this.scan([...w.only]) : this.scanAll());
    } finally {
      this.windows = this.windows.filter((x) => x !== w);
    }
  }

  /** A path of a tool's input inside the folder, relative to it; null for one outside. */
  private inside(given: unknown): string | null {
    if (typeof given !== 'string' || !given) return null;
    const named = isAbsolute(given) ? resolve(given) : resolve(this.o.path, given);
    // a link is written through: what changes is where it points (a file not there yet, in its directory)
    let abs = named;
    try {
      abs = realpathSync(named);
    } catch {
      try {
        abs = join(realpathSync(join(named, '..')), basename(named));
      } catch {}
    }
    for (const base of [this.root, resolve(this.o.path)]) {
      const rel = relative(base, abs);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return null;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const r = this.chain.then(f);
    this.chain = r.catch(() => {});
    return r;
  }

  /** Reads the whole folder once more; calls that end before that reading starts share it. */
  private scanAll(): Promise<void> {
    if (this.pending && !this.pending.started) return this.pending.done;
    const p: { started: boolean; done: Promise<void> } = { started: false, done: Promise.resolve() };
    p.done = this.serial(async () => {
      p.started = true;
      await this.scanNow();
    });
    this.pending = p;
    return p.done;
  }

  private scan(paths: string[]): Promise<void> {
    return this.serial(() => this.scanNow(paths));
  }

  /** Reads the folder (or `paths` in it) and gives each change to the cards whose calls ran when it happened. */
  private async scanNow(paths?: string[]) {
    await this.baseline;
    const last = this.last;
    let next: Manifest;
    if (paths) {
      next = new Map(last);
      for (const p of paths) {
        const e = p ? await entryAt(join(this.root, p)) : await entryAt(this.root);
        if (e) next.set(p, e);
        else next.delete(p);
      }
    } else next = await walk(this.root);
    const raw = compare(last, next, paths);
    this.last = next;
    const touched = new Set<string>();
    for (const c of raw) {
      const { cards, uncertain } = this.cardsFor(c);
      if (!cards.length) continue;
      // what a card changed is hashed, to tell later whether someone changed it again
      if (!uncertain && c.after && !c.after.dir && !c.after.cloud && c.kind !== 'deleted') c.after.hash = await hashFile(join(this.root, c.path), c.after.size);
      for (const card of cards) {
        const rec = this.rec(card);
        if (!rec) continue;
        if (uncertain) mergeUncertain(rec, c);
        else mergeOwn(rec, c, cards.length > 1);
        this.save(card, rec);
        touched.add(card);
      }
    }
    for (const card of touched) this.o.onChange?.(card);
  }

  /**
   * The cards a change belongs to: those whose call ran when it happened; a call that writes one
   * file only takes that one. Where only calls that write nothing ran, it is theirs as `uncertain`.
   */
  private cardsFor(c: RawChange): { cards: string[]; uncertain: boolean } {
    const coarse = c.at % 1000 === 0 ? 1000 : 0;
    const inside = (w: { start: number; end?: number }) => w.start - coarse <= c.at && (w.end === undefined || c.at <= w.end + SLACK_MS + coarse);
    if (this.quiet.has(c.path) || (c.from !== undefined && this.quiet.has(c.from))) return { cards: [], uncertain: false };
    const during = this.windows.filter(inside);
    const claims = during.filter((w) => w.only && (w.only.has(c.path) || (c.from !== undefined && w.only.has(c.from))));
    const broad = during.filter((w) => !w.only);
    const writing = broad.filter((w) => !w.reads);
    const by = claims.length ? claims : writing.length ? writing : broad;
    return { cards: [...new Set(by.map((w) => w.card))], uncertain: !claims.length && !writing.length };
  }

  // ---------------------------------------------------------------- undo

  /** Makes the card's undo ready, once: a clone of the folder where the file system clones, else copies of its text files. */
  private prepare(cardId: string): Promise<void> {
    let p = this.ready.get(cardId);
    if (!p) {
      p = this.makeUndo(cardId).catch((e) => console.error(`the undo of ${cardId} in ${this.o.path}:`, messageOf(e)));
      this.ready.set(cardId, p);
    }
    return p;
  }

  private async makeUndo(cardId: string) {
    await this.baseline;
    const rec = this.rec(cardId);
    if (!rec || rec.done || rec.undo) return;
    const base = this.undoDir(cardId);
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const entries = [...this.last].filter(([p]) => p);
    const files = entries.filter(([, e]) => !e.dir && !e.cloud);
    const full = this.o.clone !== false && (await clones(files[0] && join(this.root, files[0][0]), base));
    const to = join(base, full ? 'snapshot' : 'text');
    for (const [p, e] of entries) if (e.dir) await mkdir(join(to, p), { recursive: true });
    await inBatches(files, 64, async ([p, e]) => {
      const src = join(this.root, p);
      try {
        if (full) await copyKeeping(src, join(to, p), true);
        else if (e.size <= TEXT_MAX && (await isText(src))) await copyKeeping(src, join(to, p));
      } catch {
        // gone meanwhile, or not readable: no copy of it
      }
    });
    const now = this.rec(cardId);
    if (now && !now.done) this.save(cardId, { ...now, undo: full ? 'full' : 'partial' });
  }

  /** Keeps a copy of the file a card's editing tool is about to write, unless the card changed it already (its copy from before is kept). */
  private async keepBefore(cardId: string, file: string) {
    const rec = this.rec(cardId);
    if (!rec || rec.changes.some((t) => t.path === file)) return;
    const src = join(this.root, file);
    const e = await entryAt(src);
    if (!e || e.dir || e.cloud || e.size > HASH_MAX) return;
    try {
      await copyKeeping(src, join(this.undoDir(cardId), 'before', file));
    } catch (err) {
      console.error(`copying ${file} before it is written:`, messageOf(err));
    }
  }

  /** A copy of the file as it was before the card changed it (`before`), at one of its places; null where none is kept. */
  private async copyOf(cardId: string, paths: (string | undefined)[], before: Entry | undefined): Promise<string | null> {
    if (!before || before.dir) return null;
    const base = this.undoDir(cardId);
    for (const kind of ['before', 'snapshot', 'text'])
      for (const p of paths) {
        if (!p) continue;
        const copy = join(base, kind, p);
        const e = await entryAt(copy);
        if (e && !e.dir && sameStamp(e, before)) return copy;
      }
    return null;
  }

  /** What undoing the change would do now. */
  private async undoable(cardId: string, t: Tracked): Promise<FolderChange['undo']> {
    if (t.shared) return 'shared';
    const here = join(this.root, t.path);
    const now = await entryAt(here);
    switch (t.kind) {
      case 'added':
        return t.dir || (await unchanged(here, t.after, now)) ? 'yes' : 'changedSince';
      case 'modified':
        if (!(await unchanged(here, t.after, now))) return 'changedSince';
        return (await this.copyOf(cardId, [t.was, t.path], t.before)) ? 'yes' : 'lost';
      case 'deleted':
        if (now) return t.dir ? 'yes' : 'changedSince';
        return t.dir || (await this.copyOf(cardId, [t.was, t.path], t.before)) ? 'yes' : 'lost';
      case 'moved':
        if (!(await unchanged(here, t.after, now)) || (await entryAt(join(this.root, t.from!)))) return 'changedSince';
        return !t.changed || (await this.copyOf(cardId, [t.from, t.path], t.before)) ? 'yes' : 'lost';
    }
  }

  /**
   * Puts back what the card changed, as it was before: what someone changed after the card is left
   * alone, and so is what no copy was kept of; the report names both. The card's list keeps what was
   * left; its undo goes and is made afresh before its next change.
   */
  undo(cardId: string): Promise<UndoReport> {
    return shared(this.undoing, cardId, () => this.serial(() => this.undoNow(cardId)));
  }

  private async undoNow(cardId: string): Promise<UndoReport> {
    await this.baseline;
    const rec = this.rec(cardId);
    const report: UndoReport = { undone: [], changedSince: [], lost: [], shared: [] };
    if (!rec) return report;
    if (rec.done) throw new WorkspaceError('the card is done: nothing of it is undone any more');
    await this.ready.get(cardId);
    try {
      return await this.putBack(cardId, rec, report);
    } finally {
      this.quiet.clear();
    }
  }

  private async putBack(cardId: string, rec: FolderCard, report: UndoReport): Promise<UndoReport> {
    const left: Tracked[] = [];
    const keep = (t: Tracked, why: 'changedSince' | 'lost' | 'shared') => {
      left.push(t);
      report[why].push(t.kind === 'moved' ? `${t.from} → ${t.path}` : t.path);
    };
    /** Whether undo leaves `t` as it is now (kept, with the reason). */
    const refused = async (t: Tracked) => {
      const why = await this.undoable(cardId, t);
      if (why === 'yes') return false;
      keep(t, why!);
      return true;
    };
    // what undo changes, and the directories it makes on the way
    const touch = (...paths: string[]) => {
      for (const p of paths) for (const x of [p, ...ancestors(p)]) if (x) this.quiet.add(x);
    };
    const put = async (copy: string, path: string) => {
      touch(path);
      const dst = join(this.root, path);
      const tmp = join(dst, '..', `.obeya-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await copyKeeping(copy, tmp);
      await rename(tmp, dst);
    };
    // contents first, where they are now (in a directory the card moved, say), then the moves back
    // deepest first, so a directory is empty once its contents went
    const depth = (t: Tracked) => t.path.split('/').length;
    const rest = rec.changes.filter((t) => t.kind !== 'moved');
    for (const t of rest.filter((x) => x.kind === 'added' && !x.dir)) {
      if (await refused(t)) continue;
      touch(t.path);
      await unlink(join(this.root, t.path)).catch(() => {});
      report.undone.push(t.path);
    }
    for (const t of rest.filter((x) => (x.kind === 'deleted' && x.dir) || (x.kind !== 'added' && !x.dir)).sort((a, b) => depth(a) - depth(b))) {
      if (await refused(t)) continue;
      try {
        touch(t.path);
        if (t.dir) await mkdir(join(this.root, t.path), { recursive: true });
        else {
          await mkdir(join(this.root, parentOf(t.path)), { recursive: true });
          await put((await this.copyOf(cardId, [t.was, t.path], t.before))!, t.path);
        }
        report.undone.push(t.path);
      } catch (e) {
        console.error(`putting back ${t.path}:`, messageOf(e));
        keep(t, 'lost');
      }
    }
    // later moves first, so what moved twice goes back the way it came; what a directory took along
    // is where the directory goes back to
    const moves = rec.changes.filter((t) => t.kind === 'moved').reverse();
    const along = (from: string, to: string) => {
      for (const x of [...moves, ...left]) if (under(x.path, from)) x.path = to + x.path.slice(from.length);
    };
    for (const t of moves) {
      const why = await this.undoable(cardId, t);
      if (why === 'changedSince' || why === 'shared') {
        keep(t, why);
        continue;
      }
      try {
        touch(t.path, t.from!);
        await mkdir(join(this.root, parentOf(t.from!)), { recursive: true });
        await rename(join(this.root, t.path), join(this.root, t.from!));
        if (t.dir) along(t.path, t.from!);
        if (t.changed) {
          const copy = await this.copyOf(cardId, [t.from, t.path], t.before);
          if (copy) await put(copy, t.from!);
          else {
            // moved back, its contents as the card left them
            keep({ kind: 'modified', path: t.from!, before: t.before!, after: t.after! }, 'lost');
            continue;
          }
        }
        report.undone.push(`${t.path} → ${t.from}`);
      } catch (e) {
        console.error(`undoing the move of ${t.from} to ${t.path}:`, messageOf(e));
        keep(t, 'changedSince');
      }
    }
    for (const t of rest.filter((x) => x.kind === 'added' && x.dir).sort((a, b) => depth(b) - depth(a))) {
      if (t.shared) {
        keep(t, 'shared');
        continue;
      }
      try {
        touch(t.path);
        await rmdir(join(this.root, t.path));
        report.undone.push(`${t.path}/`);
      } catch {
        // something else is in it now
        keep(t, 'changedSince');
      }
    }
    this.save(cardId, { ...rec, changes: left, undo: null });
    this.dropUndo(cardId);
    // what undo did is no card's change
    await this.scanNow();
    this.o.onChange?.(cardId);
    return report;
  }

  // ---------------------------------------------------------------- the change list

  /** What the card changed in the folder, as its change list and the diffs of its text files. */
  async diff(cardId: string, full: boolean): Promise<CardDiff | null> {
    const rec = this.rec(cardId);
    if (!rec) return null;
    const undo = rec.done ? null : (rec.undo ?? (rec.held ? (await this.ready.get(cardId), this.rec(cardId)?.undo ?? null) : null));
    const changes: FolderChange[] = [];
    const patches: string[] = [];
    // a change as the card shows it, and whether its file is gone from the folder since
    const view = async (t: Tracked): Promise<FolderChange> => ({
      kind: t.kind,
      path: t.path,
      ...(t.from ? { from: t.from } : {}),
      ...(t.dir ? { dir: true as const } : {}),
      ...(!t.dir && t.kind !== 'deleted' && !(await lstat(join(this.root, t.path)).then(() => true, () => false)) ? { gone: true as const } : {}),
    });
    for (const t of rec.changes) {
      // as the change is now, before the waits below: what undo would do, then whether the file is gone
      const changed = t.changed ? { changed: true as const } : {};
      const why = undo ? await this.undoable(cardId, t) : undefined;
      const c: FolderChange = { ...(await view(t)), ...changed };
      if (undo) c.undo = why;
      if (!t.dir) {
        const patch = await this.filePatch(cardId, t);
        patches.push(patch.text);
        if (patch.lines) Object.assign(c, patch.lines);
      }
      changes.push(c);
    }
    const uncertain: FolderChange[] = [];
    for (const t of rec.uncertain ?? []) uncertain.push(await view(t));
    const folder: FolderChanges = { undo, changes, ...(uncertain.length ? { uncertain } : {}) };
    return { ...cardDiff('folder', patches.join('\n'), full), folder };
  }

  /** One file's part of the card's diff, as `git diff` would have it: its text's lines where its earlier version is kept. */
  private async filePatch(cardId: string, t: Tracked): Promise<{ text: string; lines?: Pick<DiffFile, 'added' | 'removed'> }> {
    const name = t.path;
    const head = [`diff --git a/${t.from ?? name} b/${name}`];
    if (t.kind === 'added') head.push('new file mode 100644');
    if (t.kind === 'deleted') head.push('deleted file mode 100644');
    if (t.kind === 'moved') head.push('similarity index 100%', `rename from ${t.from}`, `rename to ${name}`);
    const here = join(this.root, name);
    const was = t.kind === 'added' ? '/dev/null' : await this.copyOf(cardId, [t.from ?? name, name], t.before);
    const now = t.kind === 'deleted' ? '/dev/null' : here;
    const text = (p: string | null) => (p === '/dev/null' ? Promise.resolve(true) : p ? isText(p) : Promise.resolve(false));
    const moveOnly = t.kind === 'moved' && !t.changed;
    if (moveOnly) return { text: head.join('\n') };
    if (!was || !(await text(was)) || !(await text(now)) || (t.after?.cloud ?? false)) return { text: [...head, `Binary files a/${t.from ?? name} and b/${name} differ`].join('\n') };
    const r = await spawnOutput([GIT, 'diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', was, now]).catch(() => null);
    const out = r?.stdout ?? '';
    const at = out.indexOf('\n@@');
    const hunks = at >= 0 ? out.slice(at + 1).replace(/\n$/, '') : '';
    let added = 0;
    let removed = 0;
    for (const line of hunks.split('\n')) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    head.push(`--- ${t.kind === 'added' ? '/dev/null' : `a/${t.from ?? name}`}`, `+++ ${t.kind === 'deleted' ? '/dev/null' : `b/${name}`}`);
    return { text: [...head, ...(hunks ? [hunks] : [])].join('\n'), lines: { added, removed } };
  }
}
