// What a canvas last read of its repositories' default branches, by each repository's path: its
// `.obeya/settings.json` and Claude Code configuration, the commands of them that wait for the
// owner's confirmation, whether an adapter module is left there, and its theme for shared pages.
// Git reads them without the server waiting for it, and what was read stands while the
// repository's refs do not move (`refsSeal`).

import { readSharedFiles, type SharedRead } from '../adapters';
import type { RepoSettings, SharedSettings, TrustGroup } from '../core/types';
import { type DefaultRead, readDefault, type RepoRead, type RepoReads } from './canvas-config';
import type { Store } from './db';
import { isFolder } from './branches';
import { refsSeal } from './read-tree';
import { readingTheme, type Theme } from './theme';
import { commandsOf, heldGroups, withoutHeld } from './trust';

/** How often `readSettings` reads a repository whose refs move while git reads it. */
const READ_TRIES = 5;

export interface SettingsReadsOptions {
  store: Store;
  /** The settings the owner set on this machine for the repository at a path, as they apply now. */
  mine: (path: string) => RepoSettings | undefined;
  /** The repository's `.obeya/settings.json` changed: this machine's values it now holds as well go (`Config.takenOver`). */
  takenOver?: (path: string, before: SharedSettings | undefined, now: SharedSettings | undefined) => void;
  /** A theme was read for the repository at `path`; `changed` where it differs from the one known before. */
  themeRead: (path: string, changed: boolean) => void;
}

export class SettingsReads {
  /** By repository's path: its `.obeya/settings.json` as the read tree last had it. */
  private shared = new Map<string, SharedRead>();
  /** By repository's path: its commands that do not count until the owner confirms them, as last worked out (`heldOf`). */
  private held = new Map<string, TrustGroup[]>();
  /** By repository's path: whether its main branch had an adapter module as the configuration was last resolved, which a repository starting takes. */
  private adapterModules = new Map<string, boolean>();
  /** By repository's path: its theme (`themeOf`), and a read of it under way. */
  private themes = new Map<string, Theme | null>();
  private themeReads = new Map<string, Promise<void>>();
  /**
   * By repository's path: what its default branch had when last read (`claudeHeld`, `moved`), or as
   * it is being read, under the seal its refs had before (`refsSeal`).
   */
  private defaultRead = new Map<string, { seal: string; read: DefaultRead | Promise<DefaultRead> }>();

  constructor(private o: SettingsReadsOptions) {}

  /** The repository's `.obeya/settings.json` as its read tree last had it. */
  sharedRead(path: string): SharedRead | undefined {
    return this.shared.get(path);
  }

  /** Whether the repository's main branch had an adapter module when last read. */
  adapterModule(path: string): boolean | undefined {
    return this.adapterModules.get(path);
  }

  /**
   * The repository's settings for everyone, as its read tree last had them (read with the rest of
   * the repository as the canvas resolves it, `took`, and again whenever it moves, `reread`),
   * without the commands that wait for the owner's confirmation (`heldOf`).
   */
  sharedOf = (path: string): (() => SharedSettings | undefined) => () => withoutHeld(this.shared.get(path)?.settings, this.heldOf(path));

  /**
   * The repository's theme for its shared pages, as its default branch had it when last read
   * (theme.ts, `movedTo`); null without one. For a page about to go out: one not read yet is read
   * now, the page waiting for it, not the server.
   */
  themeOf(path: string): Theme | null | Promise<Theme | null> {
    if (this.themes.has(path)) return this.themes.get(path)!;
    if (!this.themeReads.has(path)) this.readThemeOf(path, this.shared.get(path)?.obeyaTree);
    // a read begun meanwhile wins; one that failed leaves the page without a theme
    return this.themeReads.get(path)!.then(() => (this.themes.has(path) ? this.themes.get(path)! : this.themeReads.has(path) ? this.themeOf(path) : null));
  }

  /** `themeOf` for the canvas, which does not wait for it: undefined while it is read. */
  themeKnown(path: string): Theme | null | undefined {
    if (!this.themes.has(path) && !this.themeReads.has(path)) this.readThemeOf(path, this.shared.get(path)?.obeyaTree);
    return this.themes.get(path);
  }

  /** Reads the repository's theme from `tree` without the server waiting for git; a read or a theme since wins. */
  readThemeOf(path: string, tree: string | undefined) {
    const reading: Promise<void> = readingTheme(path, tree).then(
      (theme) => void (this.themeReads.get(path) === reading && this.setTheme(path, theme)),
      () => void (this.themeReads.get(path) === reading && this.themeReads.delete(path)),
    );
    this.themeReads.set(path, reading);
  }

  /** The repository's theme as now read: a different one leaves other pages outdated. */
  setTheme(path: string, theme: Theme | null) {
    this.themeReads.delete(path);
    const before = this.themes.get(path);
    this.themes.set(path, theme);
    this.o.themeRead(path, before === undefined || before?.hash !== theme?.hash);
  }

  /**
   * The groups of the repository's commands that do not count until the owner confirms them: new
   * or changed on its default branch since (`heldGroups`). Worked out again whenever it moves or
   * its settings are saved (`heldAgain`).
   */
  heldOf(path: string): TrustGroup[] {
    let held = this.held.get(path);
    if (!held) {
      held = heldGroups(commandsOf(this.shared.get(path)), this.o.store.trustedCommands(path), this.o.mine(path));
      this.held.set(path, held);
      if (held.length) console.warn(`Obeya: ${path}: ${held.join(', ')} of its settings wait for the owner's confirmation in Configuration (held)`);
    }
    return held;
  }

  /** Works out the repository's held commands again (`heldOf`); says whether they changed. */
  heldAgain(path: string): boolean {
    const was = this.held.get(path);
    this.held.delete(path);
    return JSON.stringify(this.heldOf(path)) !== JSON.stringify(was ?? []);
  }

  /**
   * Whether the repository's own Claude Code configuration waits for the owner's trust, as its
   * default branch has it now (`folder`: a folder without git, read as it is), with `mine` its
   * settings on this machine.
   */
  claudeHeld(path: string, folder: boolean, mine: RepoSettings | undefined): boolean | Promise<boolean> {
    const trusted = this.o.store.trustedCommands(path);
    const held = (read: SharedRead) => heldGroups(commandsOf(read), trusted, mine).includes('claude');
    // a folder without git is read as it is
    if (folder) return held(readSharedFiles(path));
    const seal = refsSeal(path);
    const known = this.defaultRead.get(path);
    const read = seal && known?.seal === seal ? known.read : this.readSettings(path);
    return read instanceof Promise ? read.then((r) => held(r.shared)) : held(read.shared);
  }

  /** Keeps `read`, read from the default branch after its refs had `seal`; a read since (another seal) is not undone. */
  private readAt(path: string, seal: string, read: DefaultRead | Promise<DefaultRead>) {
    const entry = { seal, read };
    this.defaultRead.set(path, entry);
    if (read instanceof Promise) void read.then((r) => this.defaultRead.get(path) === entry && this.defaultRead.set(path, { seal, read: r }), () => this.defaultRead.get(path) === entry && this.defaultRead.delete(path));
  }

  /**
   * What `resolveCanvas` reads of a repository, from `reads`: kept as what its default branch had,
   * its settings where none were read before.
   */
  took(reads: RepoReads): (path: string) => RepoRead | null {
    return (path) => {
      const { seal, read } = reads.repos.get(path) ?? { seal: null, read: null };
      if (read && seal) this.readAt(path, seal, { shared: read.shared, adapterModule: read.adapterModule, branch: read.info.branch });
      if (read && !this.shared.has(path)) this.shared.set(path, read.shared);
      if (read) this.adapterModules.set(path, read.adapterModule);
      return read;
    };
  }

  /** What was read of the repository at `path` last, where its refs did not move since; a folder without git as it is now. */
  readNow(path: string): DefaultRead | undefined {
    if (isFolder(path)) return { shared: readSharedFiles(path), adapterModule: false, branch: '' };
    const seal = refsSeal(path);
    const known = this.defaultRead.get(path);
    return seal && known?.seal === seal && !(known.read instanceof Promise) ? known.read : undefined;
  }

  /**
   * Reads the repository at `path` on its default branch again, without the server waiting for git,
   * and keeps that (`defaultRead`). Where its refs moved while git read, what it read may be the
   * commit before: it reads again, a few times at most.
   */
  readSettings(path: string, tries = READ_TRIES): Promise<DefaultRead> {
    const seal = refsSeal(path);
    const read = readDefault(path).then(async (r): Promise<DefaultRead> => (seal && tries > 1 && refsSeal(path) !== seal ? this.readSettings(path, tries - 1) : { ...r, theme: await readingTheme(path, r.shared.obeyaTree) }));
    if (seal) this.readAt(path, seal, read);
    return read;
  }

  /**
   * What the configuration's problems of the repository are read from on its default branch: its
   * `.obeya/settings.json` as the file has it (a field that does not count included), and whether a
   * leftover `.obeya/adapter/` is there (`adapterModule`, as read with the rest), noted for
   * `proposeSetup`.
   */
  problemSources(path: string, adapterModule: boolean): string {
    this.adapterModules.set(path, adapterModule);
    const read = this.shared.get(path);
    return JSON.stringify([read?.raw, read?.problems, read?.claude, this.heldOf(path), adapterModule]);
  }

  /**
   * The repository's `.obeya/settings.json` as its default branch has it now (`now`). Where it
   * changed, this machine's values that it now holds as well go (they were taken over for everyone,
   * see `Config.takenOver`). Says whether it changed.
   */
  reread(path: string, now: SharedRead): boolean {
    const before = this.shared.get(path);
    if (JSON.stringify([now.settings, now.claude]) === JSON.stringify([before?.settings, before?.claude])) {
      // a field that does not count changed alone: the problems change, the settings do not
      this.shared.set(path, now);
      return false;
    }
    this.shared.set(path, now);
    for (const p of now.problems) console.warn(`Obeya: ${path}: ${p} (ignored)`);
    this.o.takenOver?.(path, before?.settings, now.settings);
    return true;
  }
}
