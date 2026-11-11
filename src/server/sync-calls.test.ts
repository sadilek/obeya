import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The server runs on one JavaScript thread: while a synchronous call of a file or process API
// runs (`Bun.spawnSync`, `readFileSync`, `existsSync`), it answers no
// page, hears no agent and starts nothing. Every such call in the server's code is counted here
// against a list of what each file may call, with the reason it may stay. A new call fails this
// test until it is made asynchronous or listed with its reason; a call that goes has to leave the
// list, so that it only ever shrinks.

/**
 * Per file under `src/server/`: why its synchronous calls may stay, and how many of each it may
 * make. "Server path" means the call runs while the server serves (a request, a card's start or
 * landing, a periodic check); such a call stays only because it is cheap, and says so.
 */
const ALLOWED: Record<string, { why: string; calls: Record<string, number> }> = {
  'advisor.ts': { why: "server path, cheap: a stat of each file the assistant's answer names, to tell which are none", calls: { existsSync: 1, statSync: 1 } },
  'answers.ts': { why: "server path, cheap: creates an answer's directory before its agent starts", calls: { mkdirSync: 2 } },
  'app-command.ts': { why: "server path, cheap: whether the script an app command names is there, before it starts", calls: { existsSync: 1 } },
  'artifact-copy.ts': {
    why: "server path: an artifact's own files read by their real path while its copy is put together (a share, an export); small files, a candidate for fs/promises",
    calls: { readFileSync: 1, realpathSync: 2 },
  },
  'board.ts': {
    why: "server path, a stat per card's demo while the board's items are built (whether its files are still there); cheap each, and kept with the card's row while it stays the same",
    calls: { existsSync: 3 },
  },
  'canvas.ts': {
    why: "server path, cheap: an answer's directory made, a free plan doc name probed, a folder repository's directory checked, two paths compared by their real path after a landing",
    calls: { existsSync: 1, mkdirSync: 1, realpathSync: 2, statSync: 1 },
  },
  'canvas-fixture.ts': { why: "the canvas tests' fixture, not the server", calls: { mkdtempSync: 1 } },
  'claude.ts': {
    why: "server path at an agent's start: Claude Code's ~/.claude.json read whole to tell whether Chrome is paired (it grows with Claude's history; a candidate for fs/promises), a message's images",
    calls: { readFileSync: 2 },
  },
  'config.ts': {
    why: "the configuration file: read at startup, stat'ed when the configuration is asked for (one known path), written when the owner saves; on the server path otherwise only stats of known paths (a voice's key and reference clips, a repository's path) and a demo voice's sample in a temporary directory",
    calls: { existsSync: 7, mkdirSync: 1, mkdtempSync: 1, readFileSync: 2, rmSync: 1, statSync: 1, writeFileSync: 2 },
  },
  'db.ts': { why: 'startup: the database directory made before the database opens', calls: { mkdirSync: 1 } },
  'demo-files.ts': {
    why: "server path: a demo's files resolved by their real path (serving, sharing), its caption tracks and the start of its video read where a caller needs them at once (share.ts's export, a demo's facts at its handover); the demo site reads them with captionTracksAsync and silentVideoAsync; a demo handed over is kept (copyFileSync clones on APFS; elsewhere it copies the video, a candidate for fs/promises)",
    calls: { closeSync: 1, copyFileSync: 1, existsSync: 2, mkdirSync: 1, openSync: 1, readFileSync: 1, readSync: 1, readdirSync: 1, realpathSync: 2, rmSync: 2, statSync: 2, utimesSync: 1 },
  },
  'demo.ts': {
    why: "server path, cheap: a demo handed over is checked (its files there, its chapters read from a small WebVTT file); the plugin's demo skill looked up by a stat",
    calls: { existsSync: 5, readFileSync: 1, readdirSync: 1, realpathSync: 1, statSync: 1 },
  },
  'file-forge.ts': { why: 'the file-backed forge of tests and recorded demos (OBEYA_FORGE_FILE), not a real forge', calls: { readFileSync: 1, writeFileSync: 1 } },
  'files.ts': {
    why: "server path, cheap: a dropped file found by a stat of each candidate, an uploaded file written where the owner sends it",
    calls: { mkdirSync: 1, realpathSync: 1, statSync: 2, writeFileSync: 1 },
  },
  'folder-processes.ts': { why: "server path, cheap: one stat of the workspace whose processes are ended, for when it was made", calls: { statSync: 1 } },
  'folder.ts': {
    why: "server path, cheap: a folder card's root resolved once, the file system's clock read by touching one file, a path's real path checked",
    calls: { mkdirSync: 1, realpathSync: 3, statSync: 1, writeFileSync: 2 },
  },
  'forge.ts': { why: "server path, cheap: a pull request's body in a temporary file for gh", calls: { mkdtempSync: 1, rmSync: 1, writeFileSync: 1 } },
  'git.ts': {
    why: "the git binary is found once as the module loads; the synchronous git() (spawnSync), on this machine only, serves scripts, tests and startup (self-update's headOf); the server's own git goes through gitRun and the async runners on it",
    calls: { existsSync: 2, spawnSync: 3 },
  },
  'git-setup.ts': {
    why: "server path, rare: setting up git in a folder the owner chose (setup, a card's new repository) runs git init, add and commit with the server waiting; a candidate for spawnOutput",
    calls: { existsSync: 2, mkdtempSync: 1, rmSync: 3, spawnSync: 1, statSync: 2, writeFileSync: 2 },
  },
  'hosts.ts': {
    why: "cheap: the ssh socket directory checked per command, a session's files listed and stamped before it starts there, a host's copy replaced, Claude's token file",
    calls: { chmodSync: 2, existsSync: 3, lstatSync: 1, mkdirSync: 3, readFileSync: 1, readdirSync: 1, rmSync: 1, statSync: 1, writeFileSync: 2 },
  },
  'images.ts': { why: "server path, cheap: a pasted image written, looked up and copied to another canvas", calls: { copyFileSync: 1, existsSync: 1, mkdirSync: 2, writeFileSync: 1 } },
  'instance.ts': { why: "startup and shutdown: the running instance's file", calls: { readFileSync: 1, renameSync: 1, rmSync: 1, writeFileSync: 1 } },
  'machine.ts': {
    why: "server path, cheap: the setup's checks of known paths (Claude's binary, a clone's target), the first canvas's welcome marker",
    calls: { existsSync: 3, readFileSync: 1, rmSync: 1, writeFileSync: 1 },
  },
  'main.ts': { why: 'startup before the server listens, and the replay CLI', calls: { chmodSync: 1, existsSync: 2, mkdirSync: 1, rmSync: 1, statSync: 2, writeFileSync: 1 } },
  'narration.ts': {
    why: "server path: a render's clip (a WAV of a sentence, some hundred kB) written to a temporary file to be heard back, and removed",
    calls: { rmSync: 1, writeFileSync: 1 },
  },
  'new-repo.ts': {
    why: "server path, rare: making a card's new repository checks its folder and runs git rev-parse with the server waiting (gitOrNull, counted in git.ts; git-setup.ts does the rest); a candidate for gitTry",
    calls: { existsSync: 5, mkdirSync: 1, realpathSync: 2, rmSync: 3, rmdirSync: 1, statSync: 2 },
  },
  'owner.ts': { why: "the owner's key file, read or made at startup; two starts at once wait 10 ms for each other", calls: { chmodSync: 1, readFileSync: 1, sleepSync: 1, statSync: 1, writeFileSync: 1 } },
  'path.ts': { why: "startup: which installer directories exist, for the PATH; server path, cheap: a path's real path (realPath: the read tree's worktree checked, a workspace's files, a repository found again after a landing)", calls: { existsSync: 1, realpathSync: 1 } },
  'personal-site.ts': { why: "the owner's personal site settings, a small file read and written when they change", calls: { existsSync: 1, mkdirSync: 2, readFileSync: 2, rmSync: 1, statSync: 1, writeFileSync: 2 } },
  'push.ts': { why: 'the push notification keys, read or made once per server', calls: { chmodSync: 1, existsSync: 1, readFileSync: 1, writeFileSync: 1 } },
  'read-tree.ts': {
    why: "server path, cheap by design: the seals of a repository's refs and HEAD (refsSeal, headSeal) are a few stats and small reads instead of a git call, and so is whether git is at work in the read tree (gitAtWork, a few stats in its git directory before the plan docs are read)",
    calls: { existsSync: 8, mkdirSync: 1, readFileSync: 6, readdirSync: 1, statSync: 4 },
  },
  'remote.ts': { why: 'the remote access setting: a small file, and tailscale serve taken back as the server stops', calls: { existsSync: 1, readFileSync: 1, rmSync: 1, unserveSync: 1, writeFileSync: 1 } },
  'replay.ts': { why: 'CLI for recording and replaying demos, not the server', calls: { appendFileSync: 1, cpSync: 2, existsSync: 7, mkdirSync: 3, mkdtempSync: 2, readFileSync: 4, readdirSync: 3, rmSync: 2, writeFileSync: 4 } },
  'repo.ts': {
    why: "server path: the plan docs read from the read tree when they change (a directory of small files, read where the canvas needs them at once), the plan directory watched and polled by stats; gh's hosts file read for a remote's host",
    calls: { existsSync: 5, readFileSync: 2, readdirSync: 3, statSync: 3 },
  },
  'resources.ts': { why: 'startup: where the bundled resources are', calls: { existsSync: 2 } },
  'runtime.ts': { why: "server path at an agent's start: a repository's trust notes", calls: { existsSync: 1, readFileSync: 1 } },
  'scratch.ts': { why: "server path, cheap: a scratch Obeya's look once a minute whether its checkout is there and which branch its HEAD names (a stat and a small read)", calls: { existsSync: 1, readFileSync: 1 } },
  'self-update.ts': {
    why: "server path, cheap: the seal of the checkout's HEAD every two seconds (a few stats); bun install runs after the server stopped, before it restarts",
    calls: { existsSync: 1, readFileSync: 1, spawnSync: 1, statSync: 1 },
  },
  'server.ts': { why: 'server path, cheap: a temporary directory for a recording to transcribe', calls: { mkdtempSync: 1, rmSync: 1 } },
  'serve-files.ts': {
    why: "server path: a demo video's byte ranges are read at once, 8 MB at most (docs/design/demos.md, \"Demo files are read at once\"); a worker's page read to add its height report",
    calls: { closeSync: 1, fstatSync: 2, openSync: 1, readFileSync: 1, readSync: 1 },
  },
  'settings.ts': { why: "the agents' settings file: small, read when used and written when the owner saves", calls: { mkdirSync: 1, readFileSync: 1, writeFileSync: 1 } },
  'share.ts': {
    why: "server path: a demo exported as a ZIP or HTML file reads its video whole, a page reshared reads its HTML, demo files are stat'ed; a candidate for fs/promises",
    calls: { existsSync: 1, readFileSync: 7, statSync: 4 },
  },
  'shared-settings.ts': { why: "server path, cheap: a temporary index for committing a repository's settings", calls: { mkdtempSync: 1, rmSync: 1 } },
  'site-hosts.ts': {
    why: "server path, cheap: a site's env files listed for its Cloudflare account, small temporary directories for a first deployment, GitHub Pages' work tree tidied",
    calls: { existsSync: 1, mkdtempSync: 3, readFileSync: 1, readdirSync: 2, rmSync: 5, writeFileSync: 4 },
  },
  'site.ts': { why: "server path, cheap: whether a site's env file is there, asked where the canvas cannot wait (share.ts's checks, what the UI is told of sharing), and whether a deploy line's program is (the configuration's check)", calls: { existsSync: 2 } },
  'stalls.ts': {
    why: "the stall watcher: its own log, written at most once per stall; spawnSync is the wrapper that times Bun.spawnSync, not a call of its own",
    calls: { appendFileSync: 1, renameSync: 1, spawnSync: 1, statSync: 1 },
  },
  'tailscale.ts': { why: 'tailscale serve taken back as the server stops; the binary found by a stat', calls: { existsSync: 1, spawnSync: 1 } },
  'theme.ts': { why: "a folder's theme, read from the folder's few files (a repository's is read from git without waiting)", calls: { readFileSync: 1 } },
  'transcript.ts': {
    why: "server path, in the background: the work retrospective finds a session's transcript by listing Claude's and Codex's session directories and reads it whole; a candidate for fs/promises",
    calls: { existsSync: 2, readFileSync: 1, readdirSync: 3, statSync: 1 },
  },
  'voice-cloud.ts': { why: "the cloud voice's settings file, small, read when used and written when the owner saves", calls: { chmodSync: 1, existsSync: 1, readFileSync: 1, writeFileSync: 1 } },
  'walkthrough.ts': {
    why: "server path: a walkthrough's code slide reads one file of the repository (size-capped), its clips and state are small files renamed into place",
    calls: { existsSync: 1, lstatSync: 2, mkdirSync: 2, readFileSync: 3, realpathSync: 4, renameSync: 2, statSync: 3, writeFileSync: 1 },
  },
  'workers-fixture.ts': { why: "the workers' tests' fixture, not the server", calls: { mkdtempSync: 1 } },
  'workers.ts': { why: "server path, cheap: whether a kept demo copy is still there", calls: { existsSync: 1 } },
  'workspaces.ts': {
    why: "server path, cheap: stats of known workspace paths as cards start, land and are cleaned up",
    calls: { existsSync: 17, mkdirSync: 3, readdirSync: 1, realpathSync: 1, renameSync: 1, statSync: 2 },
  },
};

/** The server's own code: every `.ts` file under `src/server/` but the tests and what only they use. */
function serverFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' ? [] : serverFiles(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'testing.ts' && e.name !== 'test-setup.ts' ? [path] : [];
  });
}

/**
 * The source with its comments and the text of its strings blanked out (the lines kept where they
 * are): what is left is code. Template literals keep the code of their `${…}`; a regular
 * expression literal is skipped as a whole, so the quotes in it start no string.
 */
export function codeOf(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  /** In code: the depth of braces, per template literal whose `${…}` it is in. */
  const braces: number[] = [];
  let i = 0;
  /** The last character of code that is not white space, and where it is: it tells a division from a regular expression. */
  let last = '';
  let lastAt = -1;
  const templateFrom = (start: number): number => {
    // from just after a backtick or a `}` that ends an expression, to the next `${` or the closing backtick
    let j = start;
    while (j < source.length) {
      if (source[j] === '\\') j += 2;
      else if (source[j] === '`') {
        blank(start, j);
        return j + 1;
      } else if (source[j] === '$' && source[j + 1] === '{') {
        blank(start, j);
        braces.push(0);
        return j + 2;
      } else j++;
    }
    blank(start, j);
    return j;
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const to = end < 0 ? source.length : end;
      blank(i, to);
      i = to;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const to = end < 0 ? source.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      last = c;
    } else if (c === '`') {
      i = templateFrom(i + 1);
      last = '`';
    } else if (c === '/' && (last === '' || (/[(,=:[&|?{};+\-*%<>~^]/.test(last) && !(/[+-]/.test(last) && source[lastAt - 1] === last)) || (last === '!' && !/[\w)\]]/.test(source[lastAt - 1] ?? '')) || /\b(return|typeof|case|in|of)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))) {
      // a regular expression literal: to its closing slash outside a class, then its flags
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') j += 2;
        else if (source[j] === '[') (inClass = true), j++;
        else if (source[j] === ']') (inClass = false), j++;
        else if (source[j] === '/' && !inClass) break;
        else j++;
      }
      blank(i, j + 1);
      i = j + 1;
      while (i < source.length && /\w/.test(source[i]!)) i++;
      last = '/';
    } else {
      if (c === '{' && braces.length) braces[braces.length - 1]!++;
      else if (c === '}' && braces.length) {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          i = templateFrom(i + 1);
          last = '`';
          continue;
        }
        braces[braces.length - 1]!--;
      }
      if (!/\s/.test(c)) (last = c), (lastAt = i);
      i++;
    }
  }
  return out.join('');
}

/**
 * The calls of synchronous APIs in the code (`codeOf`): each name ending in `Sync` followed by `(`,
 * also with type arguments, `?.` or a line break between them, with its line; a function or method
 * of that name being declared is no call.
 */
export function syncCalls(source: string): { name: string; line: number }[] {
  const code = codeOf(source);
  const found: { name: string; line: number }[] = [];
  for (const m of code.matchAll(/\b(\w+Sync)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*(?:\?\.)?\s*\(/g)) {
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const lineEnd = code.indexOf('\n', m.index + m[0].length);
    const before = code.slice(lineStart, m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;
    // a method of a class: the line begins with its name and its parameters, its body with the line's end
    if (/^\s*((public|private|protected|static|async|override)\s+)*$/.test(before) && isMethod(code.slice(m.index! + m[0].length, lineEnd < 0 ? code.length : lineEnd))) continue;
    found.push({ name: m[1]!, line: code.slice(0, m.index).split('\n').length });
  }
  return found;
}

/** Whether what follows a name and its `(` on a line is a method's parameters, its return type and the `{` of its body. */
function isMethod(rest: string): boolean {
  let depth = 1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')' && --depth === 0) {
      const after = rest.slice(i + 1);
      return /^\s*(:.*)?\{\s*$/.test(after) && !after.includes('=>');
    }
  }
  return false;
}

describe('the scan for synchronous calls', () => {
  test('finds calls in code, not in comments or strings, nor where such a function is declared', () => {
    const source = [
      "import { existsSync } from 'node:fs';",
      '// readFileSync(file) in a comment',
      '/* writeFileSync(',
      '   still a comment */ const a = existsSync(x);',
      "const s = 'statSync(x)' + \"mkdirSync(y)\";",
      'const t = `rmSync(${dir}) ${readdirSync(dir).length}`;',
      "const r = /'/g.test(v) && lstatSync(p);",
      'export function gitStepsSync<T>(cwd: string) {',
      'function fooSync(x: number) {',
      '  runSync(argv: string[], cwd?: string): { code: number } {',
      '  return Bun.spawnSync([GIT, ...args], { stderr: "pipe" });',
      // a division after a value that cannot be null, and a regular expression after a negation
      "const half = `${(ms! / 2).toFixed(1)} s` + 'x' && !/'/.test(y) && renameSync(a, b);",
      '  someSync(a, (b) => {',
      // a call split over lines, with type arguments, optional, and after a division that follows an increment
      'const u = readFileSync',
      '  (file);',
      'const v = gitStepsSync<string>(cwd, steps) ?? statSync?.(p);',
      'const w = count++ / 2; mkdirSync(d);',
    ].join('\n');
    expect(syncCalls(source)).toEqual([
      { name: 'existsSync', line: 4 },
      { name: 'readdirSync', line: 6 },
      { name: 'lstatSync', line: 7 },
      { name: 'spawnSync', line: 11 },
      { name: 'renameSync', line: 12 },
      { name: 'someSync', line: 13 },
      { name: 'readFileSync', line: 14 },
      { name: 'gitStepsSync', line: 16 },
      { name: 'statSync', line: 16 },
      { name: 'mkdirSync', line: 17 },
    ]);
  });
});

describe('synchronous calls on the server', () => {
  const root = import.meta.dir;
  const found = new Map<string, Map<string, number[]>>();
  for (const path of serverFiles(root)) {
    const file = relative(root, path).replaceAll('\\', '/');
    const calls = syncCalls(readFileSync(path, 'utf8'));
    if (!calls.length) continue;
    const byName = new Map<string, number[]>();
    for (const c of calls) byName.set(c.name, [...(byName.get(c.name) ?? []), c.line]);
    found.set(file, byName);
  }

  test('are each allowed, with a reason: a new one is made asynchronous or listed', () => {
    const over: string[] = [];
    for (const [file, byName] of found)
      for (const [name, lines] of byName) {
        const allowed = ALLOWED[file]?.calls[name] ?? 0;
        if (lines.length > allowed) over.push(`${file}: ${name} ${lines.length} times, ${allowed} allowed (lines ${lines.join(', ')})`);
      }
    if (over.length)
      throw new Error(
        `Synchronous calls block the server's only thread while they run:\n  ${over.join('\n  ')}\nMake the call asynchronous (node:fs/promises, Bun.file, spawnOutput, gitAsync or gitTry), or, where it may block the server, add it to ALLOWED in src/server/sync-calls.test.ts with the reason.`,
      );
  });

  test('the list allows no more than the code has: a call made asynchronous leaves it', () => {
    const stale: string[] = [];
    for (const [file, { why, calls }] of Object.entries(ALLOWED)) {
      expect(why.trim()).not.toBe('');
      for (const [name, allowed] of Object.entries(calls)) {
        const has = found.get(file)?.get(name)?.length ?? 0;
        if (allowed > has) stale.push(`${file}: ${name} ${allowed} allowed, ${has} found`);
      }
    }
    if (stale.length) throw new Error(`ALLOWED in src/server/sync-calls.test.ts allows more than the code has; lower it:\n  ${stale.join('\n  ')}`);
  });
});
