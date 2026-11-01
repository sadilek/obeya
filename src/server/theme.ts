// A repository's theme for its shared demo pages: `.obeya/theme.css` as its default branch has it
// (like its settings, `readShared`), not as a card's branch does. Obeya manages nothing of it: the
// file goes into each page after Obeya's own style (demo-page.ts), so it wins, with the files it
// names (`url()`, `@import`: a logo, a font) as `data:` URLs where their real path lies in
// `.obeya/`; what else it names, a file elsewhere or an address on the internet, is dropped. A page
// is published with the theme's hash, and is outdated once the hash differs (board.ts).

import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { themeData } from './artifact-copy';
import { demoFile } from './demo-page';
import { GIT, isFolder } from './workspaces';

/** The directory a repository's theme is in, and the theme's file there. */
export const THEME_DIR = '.obeya';
export const THEME_FILE = 'theme.css';

/** A theme as the pages carry it: its CSS with what it names inside, and a hash of that. */
export interface Theme {
  css: string;
  hash: string;
}

/** Themes as last read, by repository and what they were read from: the `.obeya` tree, or a folder's files. */
const read = new Map<string, Theme | null>();

/**
 * The theme of the repository at `repo`: from the git tree of `.obeya/` on its default branch
 * (`tree`, as `readShared` notes it; none where it has none), or from a folder without git as the
 * folder has it. Null without a `theme.css`.
 */
export function readTheme(repo: string, tree: string | undefined): Theme | null {
  const folder = isFolder(repo);
  const key = `${repo}\0${folder ? folderStamp(join(repo, THEME_DIR)) : (tree ?? '')}`;
  if (read.has(key)) return read.get(key)!;
  const theme = folder ? themeOf(folderFiles(join(repo, THEME_DIR))) : tree ? themeOf(treeFiles(repo, tree)) : null;
  read.set(key, theme);
  return theme;
}

/** The theme from the files of `.obeya/`, each read by its path there; null without a `theme.css`. */
function themeOf(file: (path: string) => Buffer | null): Theme | null {
  const text = file(THEME_FILE);
  if (!text) return null;
  // a directory to resolve its references in; nothing is read from it but through `file`
  const css = themeData(text.toString('utf8'), join('/', THEME_DIR), file);
  return { css, hash: createHash('sha256').update(css).digest('hex').slice(0, 16) };
}

/** The regular files of a git tree, by their paths in it; a link (mode 120000) or a submodule is none. */
function treeFiles(repo: string, tree: string): (path: string) => Buffer | null {
  const r = Bun.spawnSync([GIT, '-C', repo, 'ls-tree', '-r', '-z', tree], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const blobs = new Map<string, string>();
  if (r.exitCode === 0)
    for (const e of r.stdout.toString().split('\0')) {
      const m = /^(100644|100755) blob (\S+)\t(.+)$/s.exec(e);
      if (m) blobs.set(m[3]!, m[2]!);
    }
  return (path) => {
    const id = blobs.get(path);
    if (!id) return null;
    const b = Bun.spawnSync([GIT, '-C', repo, 'cat-file', 'blob', id], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    return b.exitCode === 0 ? Buffer.from(b.stdout) : null;
  };
}

/** The files of a folder's `.obeya/`, each where its real path lies inside it (`demoFile`). */
function folderFiles(dir: string): (path: string) => Buffer | null {
  return (path) => {
    const f = demoFile(dir, path);
    return f ? readFileSync(f) : null;
  };
}

/** What a folder's `.obeya/` holds, by its files' paths, sizes and times: while it stays, so does the theme read from it. */
function folderStamp(dir: string): string {
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true }) as Dirent[]) {
      const f = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(f);
      else {
        try {
          const s = statSync(join(dir, f));
          out.push(`${f}:${s.size}:${s.mtimeMs}`);
        } catch {}
      }
    }
  };
  walk('');
  return out.sort().join('\n');
}
