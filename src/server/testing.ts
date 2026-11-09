// Test doubles, and git repositories for tests.

import { dlopen, FFIType, ptr } from 'bun:ffi';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Forge } from './forge';
import type { AgentEvent, AgentRuntime, AgentSession, AgentSpec, PermissionAnswer } from './runtime';
import { PATIENCE } from './patience';
import { git } from './workspaces';
import { KEY_HEADER, keyOf } from './owner';
import { Voicing } from './walkthrough';
import type { Language } from '../core/locale';

/** The calls of a forge that only review cards make, for a fake forge of a test that has none. */
export const noContributions: Pick<Forge, 'urlOf' | 'contribution' | 'comment' | 'requestChanges'> = { urlOf: async () => '', contribution: async () => ({}) as never, comment: async () => {}, requestChanges: async () => {} };

/** A forge for tests that never reach a pull request. */
export const noForge: Forge = { status: async () => ({}) as never, body: async () => '', setBody: async () => {}, merge: async () => {}, open: async () => '', ...noContributions };

/** A session whose tools and events the test drives. */
export class FakeSession implements AgentSession {
  inbox: string[] = [];
  /** The images sent with each message of `inbox`, by index. */
  images: string[][] = [];
  closed = false;
  done: Promise<void>;
  private finish!: () => void;
  constructor(
    readonly spec: AgentSpec,
    first?: string,
    images: string[] = [],
  ) {
    if (first !== undefined) this.send(first, images);
    this.done = new Promise((r) => (this.finish = r));
  }
  send(text: string, images: string[] = []) {
    this.inbox.push(text);
    this.images.push(images);
  }
  close() {
    this.closed = true;
    this.abort.abort();
    this.finish();
  }
  private abort = new AbortController();
  /** A tool call that needs a person's permission: settles with the answer the session got. */
  permission(name: string, input: Record<string, unknown>, reason?: string): Promise<PermissionAnswer> {
    return this.spec.askOwner!({ name, input, ...(reason ? { reason } : {}) }, this.abort.signal);
  }
  call(name: string, args: Record<string, unknown>) {
    return this.spec.tools.find((t) => t.name === name)!.run(args);
  }
  /** A tool call of the agent that does `act` in its workspace, with the hooks that watch it before and after. */
  async use(name: string, input: Record<string, unknown>, act: () => unknown = () => {}) {
    const call = { id: `call-${++FakeSession.calls}`, name, input };
    await this.spec.watch?.before(call);
    await act();
    await this.spec.watch?.after(call);
  }
  private static calls = 0;
  /** A tool step of the agent: what the session hands it with the step's result. */
  toolStep(): string | undefined {
    return this.spec.contextUpdate?.();
  }
  emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }
}

export class FakeRuntime implements AgentRuntime {
  sessions: FakeSession[] = [];
  start(spec: AgentSpec, first?: string, images?: string[]) {
    const s = new FakeSession(spec, first, images);
    this.sessions.push(s);
    return s;
  }
  get last() {
    return this.sessions.at(-1)!;
  }
}

/** How much longer a test may take on this machine: `patience.ts`. */
export { PATIENCE };

const templates = new Map<string, string>();
let templateDir: string | undefined;
/** The repositories `gitRepo` and `gitClone` copied, each with the template it is a copy of. */
const copies = new Map<string, string>();
/** The clones of templates, themselves templates: by the template cloned and whether bare. */
const clones = new Map<string, string>();

/** Lets git trust a copy of a repository: it keeps mtime and size, not inode and ctime. */
const trustCopies = (gitDir: string) => appendFileSync(join(gitDir, 'config'), '[core]\n\tcheckStat = minimal\n\ttrustctime = false\n');

/**
 * Makes `path` a git repository on `main` with `files` committed as "init", in which tests can
 * commit. Spawning git is what makes the tests slow, so each set of files is committed once into
 * a template, and the repository is a copy of it.
 */
export function gitRepo(path: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const key = JSON.stringify(files);
  let template = templates.get(key);
  if (!template) {
    templateDir ??= mkdtempSync(join(tmpdir(), 'obeya-template-'));
    template = join(templateDir, String(templates.size));
    git(templateDir, 'init', '--quiet', '--template=', '-b', 'main', template);
    identify(template);
    trustCopies(join(template, '.git'));
    // git's automatic maintenance after a commit would run in the background and could add or
    // remove files (objects/maintenance.lock) while another test copies the template
    appendFileSync(join(template, '.git/config'), '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(template, file)), { recursive: true });
      writeFileSync(join(template, file), text);
    }
    git(template, 'add', '.');
    git(template, 'commit', '--quiet', '-m', 'init');
    templates.set(key, template);
  }
  cpSync(template, path, { recursive: true, preserveTimestamps: true });
  copies.set(resolve(path), template);
  return path;
}

/**
 * `git clone` of `source` into `path` (`bare`: `--bare`), as tests set up the clones of a
 * repository. A git clone costs a second on Windows, where starting git and the processes it starts
 * for a clone is slow: where `source` is a copy `gitRepo` or `gitClone` made whose branches have not
 * moved since, the clone is a copy of a clone of its template, made once.
 */
export function gitClone(source: string, path: string, { bare = false } = {}): string {
  const template = copies.get(resolve(source));
  // refsOf reads the files backend's refs: a reftable repository's (init.defaultRefFormat) it cannot compare
  if (!template || existsSync(join(gitDir(source), 'reftable')) || refsOf(source) !== refsOf(template)) {
    mkdirSync(dirname(path), { recursive: true });
    git(dirname(path), 'clone', '--quiet', ...(bare ? ['--bare'] : []), source, path);
    return path;
  }
  const key = `${template}\n${bare}`;
  let clone = clones.get(key);
  if (!clone) {
    clone = join(templateDir!, `clone-${clones.size}${bare ? '.git' : ''}`);
    // with git's template, as `git clone` makes it: tests put hooks into hooks/
    git(templateDir!, 'clone', '--quiet', ...(bare ? ['--bare'] : []), template, clone);
    trustCopies(gitDir(clone));
    clones.set(key, clone);
  }
  cpSync(clone, path, { recursive: true, preserveTimestamps: true });
  // the clone's origin is `source`: its url line, however git wrote it (quoted where the path has a
  // # or ;), becomes a quoted one. A copy whose origin stayed the template would push into it
  const config = join(gitDir(path), 'config');
  const text = readFileSync(config, 'utf8');
  const url = /(\[remote "origin"\]\n(?:\t.*\n)*?)\turl = .*\n/;
  if (!url.test(text)) throw new Error(`gitClone: no origin url in ${config}`);
  const quoted = `"${source.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
  writeFileSync(config, text.replace(url, (_, section: string) => `${section}\turl = ${quoted}\n`));
  copies.set(resolve(path), clone);
  return path;
}

const gitDir = (repo: string) => (existsSync(join(repo, '.git')) ? join(repo, '.git') : repo);

/** A repository's branches and tags, and where its HEAD points: what a clone of it takes. */
function refsOf(repo: string): string {
  const dir = gitDir(repo);
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      // none there, or a directory
      return '';
    }
  };
  // a copy deleted since has none
  const names = existsSync(join(dir, 'refs')) ? (readdirSync(join(dir, 'refs'), { recursive: true }) as string[]) : [];
  const refs = names.sort().map((r) => `${r}:${read(join(dir, 'refs', r)).trim()}`);
  return [read(join(dir, 'HEAD')), read(join(dir, 'packed-refs')), ...refs].join('\n');
}

/** Removes the templates of `gitRepo`; test-setup.ts calls it once all tests have run. */
export function removeTemplates() {
  if (templateDir) rmSync(templateDir, { recursive: true, force: true });
  templateDir = undefined;
  templates.clear();
  copies.clear();
  clones.clear();
}

/**
 * Removes `path` with all in it, as a test's cleanup does. On Windows a file a process still has
 * open cannot go (EBUSY): git freeing a workspace, a program the test started and stopped, may
 * hold one for a moment after the test is through. So it tries again for a while; Bun ignores
 * `rmSync`'s own `maxRetries`.
 */
export async function removeDir(path: string) {
  for (const end = Date.now() + 10_000; ; await Bun.sleep(50)) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '') || Date.now() > end) throw e;
    }
  }
}

let launcher: string | undefined;

/**
 * A program `name` in `dir` that runs the TypeScript `script` with Bun, for a stand-in of a CLI
 * (gh, tailscale). Elsewhere it is a shell script; Windows starts only an `.exe` that way (a
 * `.cmd` refuses arguments with `&` or `|`), so there it is a small program compiled once per
 * test process that imports the script beside it of its own name.
 */
function bunProgram(dir: string, name: string, script: string): string {
  const source = join(dir, `${name}.ts`);
  writeFileSync(source, script);
  if (process.platform !== 'win32') {
    const program = join(dir, name);
    writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(source)} "$@"\n`, { mode: 0o755 });
    return program;
  }
  if (!launcher || !existsSync(launcher)) {
    templateDir ??= mkdtempSync(join(tmpdir(), 'obeya-template-'));
    const main = join(templateDir, 'launcher.ts');
    writeFileSync(main, "await import(process.execPath.replace(/\\.exe$/i, '.ts'));\n");
    launcher = join(templateDir, 'launcher.exe');
    const r = Bun.spawnSync([process.execPath, 'build', '--compile', main, '--outfile', launcher], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`compiling the launcher failed: ${r.stderr.toString()}`);
  }
  const program = join(dir, `${name}.exe`);
  if (existsSync(program)) return program;
  try {
    linkSync(launcher, program);
  } catch {
    copyFileSync(launcher, program);
  }
  return program;
}

let sh: string | undefined;

/** Git for Windows' sh: git's exec path is `<root>/mingw64/libexec/git-core`, sh is in `<root>/usr/bin`. */
function gitSh(): string {
  if (sh) return sh;
  const exec = Bun.spawnSync(['git', '--exec-path'], { stdout: 'pipe' }).stdout.toString().trim();
  const root = resolve(exec, '..', '..', '..');
  sh = [join(root, 'usr', 'bin', 'sh.exe'), join(root, 'bin', 'sh.exe')].find((p) => existsSync(p)) ?? Bun.which('sh') ?? undefined;
  if (!sh) throw new Error(`no sh beside git (${exec})`);
  return sh;
}

/**
 * A program `name` in `dir` whose behaviour is the shell script `body`, as tests make a machine's
 * programs (claude, git, a folder dialog) answer: on Windows it runs in Git for Windows' sh. Its path.
 */
export function fakeProgram(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    const program = join(dir, name);
    writeFileSync(program, `#!/bin/sh\n${body}\n`);
    chmodSync(program, 0o755);
    return program;
  }
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `${body}\n`);
  return bunProgram(dir, name, `const r = Bun.spawnSync([${JSON.stringify(gitSh())}, ${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit'] });\nprocess.exit(r.exitCode ?? 1);\n`);
}

/** Lets tests commit in `repo`, a repository or a clone of one, as T. */
export function identify(repo: string) {
  appendFileSync(join(repo, '.git/config'), '[user]\n\temail = t@example.com\n\tname = T\n');
}

/**
 * Waits until `done` holds. A request reaches the server only after a round trip, which on a
 * loaded machine (other workers' test runs) takes longer than any fixed pause; a test that went
 * on too early failed and left its request open, and stopping the server reset it in the next test.
 */
/**
 * `fetch` and `WebSocket` with the owner's key of the server `of` gives (one of `serve`), as the
 * page, the app's shell and Obeya's scripts send it. A request without it goes through the global ones.
 */
export function asOwner(of: () => object) {
  const withKey = (given?: HeadersInit) => {
    const headers = new Headers(given);
    if (!headers.has(KEY_HEADER)) headers.set(KEY_HEADER, keyOf(of()));
    return headers;
  };
  return {
    fetch: (input: string | URL | Request, init: RequestInit = {}) => globalThis.fetch(input, { ...init, headers: withKey(init.headers) }),
    WebSocket: class extends globalThis.WebSocket {
      // `{ headers }` as Bun takes it (the DOM's type knows only protocols there)
      constructor(url: string | URL, given: unknown = {}) {
        const o = given as { headers?: HeadersInit };
        super(url, { ...o, headers: Object.fromEntries(withKey(o.headers)) } as unknown as string[]);
      }
    },
  };
}

/** The board's listeners have heard of what changed so far (they hear of it once the code that changed it is through: `Board.changed`). */
export const heard = () => Bun.sleep(0);

/**
 * Windows counts a thread's CPU time in ticks of about 15.6 ms, coarser than a read of the cards;
 * the clock's time counted the waits for a core with it, which a busy runner made the larger part
 * of a run's cost or a rebuild's, by turns. The CPU cycles the thread ran are exact there, and
 * only their ratios count.
 */
const cycles = (() => {
  if (process.platform !== 'win32') return null;
  const { symbols } = dlopen('kernel32.dll', { QueryThreadCycleTime: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 } });
  const out = new BigUint64Array(1);
  // GetCurrentThread's handle, which stands for the calling thread
  return () => (symbols.QueryThreadCycleTime(-2n, ptr(out)), Number(out[0]));
})();

/**
 * What `run` costs the thread that runs the server's code, once what listens to changes heard of
 * those before it: its CPU time (CPU cycles on Windows), which leaves out the waits for a core of a
 * busy machine. Only ratios of such costs, measured on the same machine, say anything.
 */
export async function cpuTime(run: () => unknown): Promise<number> {
  await heard();
  if (cycles) {
    const start = cycles();
    await run();
    return cycles() - start;
  }
  const start = process.threadCpuUsage();
  await run();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** Starts a process that runs on in `cwd` the way an app's start script leaves one behind: detached, its starter gone. Its pid. */
export async function leftBehind(cwd: string): Promise<number> {
  const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(cwd)}, detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`;
  const starter = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe' });
  const pid = Number((await new Response(starter.stdout).text()).trim());
  await starter.exited;
  return pid;
}

/** Whether the process `pid` runs. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const until = async (done: () => unknown, ms = 3000 * PATIENCE) => {
  for (const end = Date.now() + ms; !(await done()); await Bun.sleep(2)) if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${done}`);
};

/**
 * Records the git calls the server waits for (git through `Bun.spawnSync`, as `git` makes them),
 * from now until `stop`, which gives them back, each as its arguments after `git`.
 */
export function syncGitCalls() {
  const calls: string[] = [];
  const spawnSync = Bun.spawnSync;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const first = args[0] as string[] | { cmd: string[] };
    const argv = Array.isArray(first) ? first : first.cmd;
    if (/(^|[/\\])git(\.exe)?$/.test(argv[0] ?? '')) calls.push(argv.slice(1).join(' '));
    return spawnSync(...args);
  }) as typeof Bun.spawnSync;
  return {
    stop: () => {
      Bun.spawnSync = spawnSync;
      return calls;
    },
  };
}

/**
 * A stand-in for `ssh` that runs the command on this machine, as a host's login shell would; the
 * host counts as unreachable (exit 255, as ssh's own) while `<dir>/down` exists. Its home is
 * `<dir>/home`. Each command it ran is appended to `<dir>/log`, with the target first; each
 * connection it tried, reachable or not, adds a line to `<dir>/tries`. A forward (`-L` from here,
 * `-R` from there, the same on one machine) is a proxy on this machine for as long as the command
 * runs; the command's pid goes to `<dir>/forwards`, each proxy's to `<dir>/proxies`.
 */
export function fakeSsh(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const program = join(dir, 'ssh');
  const proxy = join(dir, 'forward.ts');
  writeFileSync(
    proxy,
    `import { connect, createServer } from 'node:net';
const [, port, host, to] = /^(?:.*?:)?(\\d+):(\\[[^\\]]*\\]|[^:]*):(\\d+)$/.exec(process.argv[2]!)!;
createServer((c) => {
  const t = connect(Number(to), host!.replace(/^\\[|\\]$/g, ''));
  c.pipe(t).pipe(c);
  t.on('error', () => c.destroy());
  c.on('error', () => t.destroy());
}).listen(Number(port), '127.0.0.1');
`,
  );
  writeFileSync(
    program,
    `#!/bin/sh
fwd=
while [ $# -gt 1 ]; do
  case "$1" in -L|-R) fwd="$fwd $2"; shift 2 ;; -o) shift 2 ;; -T|-n) shift ;; *) break ;; esac
done
target="$1"; shift
echo x >> ${JSON.stringify(join(dir, 'tries'))}
[ -e ${JSON.stringify(join(dir, 'down'))} ] && { echo "ssh: connect to host $target: Connection refused" >&2; exit 255; }
printf '%s %s\\n' "$target" "$*" >> ${JSON.stringify(join(dir, 'log'))}
HOME=${JSON.stringify(join(dir, 'home'))}; export HOME; mkdir -p "$HOME"
[ -z "$fwd" ] && exec sh -c "$*"
echo $$ >> ${JSON.stringify(join(dir, 'forwards'))}
proxy=
for f in $fwd; do
  ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} "$f" & proxy="$proxy $!"
  echo $! >> ${JSON.stringify(join(dir, 'proxies'))}
done
# a command in the background reads /dev/null in dash, even with <&0: stdin goes by another fd
exec 3<&0
sh -c "$*" <&3 3<&- & command=$!
trap 'kill $proxy $command 2>/dev/null; exit 255' TERM INT
wait $command
kill $proxy 2>/dev/null
`,
    { mode: 0o755 },
  );
  return program;
}


/** A demo for a handover in a test that is not about demos: an HTML artifact in a directory of its own. */
export function artifact(): { kind: 'html'; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-artifact-'));
  writeFileSync(join(dir, 'index.html'), '<p>Ergebnis</p>\n');
  return { kind: 'html', dir };
}

/**
 * A stand-in for GitHub's CLI, in `dir`, slow as GitHub can be: it answers a call on pull request
 * number `n` after `delays[n]` milliseconds (none for others), with an open PR whose one comment
 * is by `lead`; `auth token` answers at once with `token:<host>:<user>`. Each call is appended to
 * `<dir>/calls`, with the host and tokens gh would use from its environment.
 */
export function fakeGh(dir: string, delays: Record<number, number>): string {
  mkdirSync(dir, { recursive: true });
  return bunProgram(
    dir,
    'gh',
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const env = ['GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].map((k, i) => (process.env[k] || !i ? k + '=' + (process.env[k] ?? '') : '')).filter(Boolean);
appendFileSync(${JSON.stringify(join(dir, 'calls'))}, args.join(' ') + ' | ' + env.join(' ') + '\\n');
const opt = (name: string) => args[args.indexOf(name) + 1];
if (args[0] === 'auth') { console.log('token:' + opt('--hostname') + ':' + opt('--user')); process.exit(0); }
const n = Number(/pulls?\\/(\\d+)|number=(\\d+)/.exec(args.join(' '))?.slice(1).find(Boolean));
await Bun.sleep((${JSON.stringify(delays)} as Record<number, number>)[n] ?? 0);
if (args[0] === 'pr') console.log(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: 'aaa', author: { login: 'owner' }, statusCheckRollup: [], comments: [{ id: 'IC_' + n, author: { login: 'lead' }, body: 'Rename it.', url: 'https://gh/c' + n }], reviews: [] }));
else if (args[1] === 'graphql') console.log('{}');
else console.log('[]');
`,
  );
}

/**
 * A stand-in for Tailscale's CLI, in `dir`: `status --json` answers `<dir>/status.json` (as
 * `tailscaleStatus` writes it), `serve status --json`, `serve --bg --https=<port> <target>`,
 * `serve --https=<port> off` and `serve set-raw` (the config on stdin) read and change
 * `<dir>/serve.json`. While `<dir>/fail` exists, `serve` fails with its text on stderr; while
 * `<dir>/slow` exists, `status` answers after 5 s. Each call is appended to `<dir>/calls`.
 */
export function fakeTailscale(dir: string, status: TailscaleStatus = { state: 'Running', name: 'mac.tail1234.ts.net', https: true }): string {
  mkdirSync(dir, { recursive: true });
  const program = bunProgram(
    dir,
    'tailscale',
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
appendFileSync(dir + '/calls', args.join(' ') + '\\n');
const status = JSON.parse(readFileSync(dir + '/status.json', 'utf8'));
const config = existsSync(dir + '/serve.json') ? JSON.parse(readFileSync(dir + '/serve.json', 'utf8')) : {};
if (args[0] === 'status') {
  if (existsSync(dir + '/slow')) await Bun.sleep(5000);
  console.log(JSON.stringify(status));
}
else if (args[0] === 'serve' && args[1] === 'status') console.log(JSON.stringify(config));
else if (args[0] === 'serve') {
  if (existsSync(dir + '/fail')) { console.error(readFileSync(dir + '/fail', 'utf8')); process.exit(1); }
  if (args[1] === 'set-raw') { writeFileSync(dir + '/serve.json', await Bun.stdin.text()); process.exit(0); }
  const port = args.find((a) => a.startsWith('--https='))!.slice(8);
  const name = status.Self.DNSName.replace(/\\.$/, '');
  const target = args[args.length - 1];
  config.TCP ??= {}; config.Web ??= {};
  if (target === 'off') { delete config.TCP[port]; delete config.Web[name + ':' + port]; }
  else { config.TCP[port] = { HTTPS: true }; config.Web[name + ':' + port] = { Handlers: { '/': { Proxy: target } } }; }
  writeFileSync(dir + '/serve.json', JSON.stringify(config));
}
`,
  );
  tailscaleStatus(dir, status);
  return program;
}

/**
 * What the fake `tailscale status --json` says: its backend's state, the machine's tailnet name,
 * whether HTTPS is on, the account it runs as and how many other devices the tailnet has (one).
 */
export interface TailscaleStatus {
  state: 'Running' | 'NeedsLogin' | 'Stopped';
  name: string;
  https: boolean;
  account?: string;
  others?: number;
}

export function tailscaleStatus(dir: string, s: TailscaleStatus) {
  const peers = Object.fromEntries(Array.from({ length: s.others ?? 1 }, (_, i) => [`nodekey:${i}`, { HostName: `phone-${i}` }]));
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      BackendState: s.state,
      Self: { DNSName: `${s.name}.`, UserID: 1 },
      CertDomains: s.https ? [s.name] : null,
      Peer: peers,
      User: { 1: { LoginName: s.account ?? 'owner@example.com' } },
    }),
  );
}

/** A WAV of `seconds` of silence, 16 kHz mono 16-bit, as a voice writes one. */
export function silentWav(seconds: number): Buffer {
  const data = Math.round(seconds * 16000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

/**
 * The voice of walkthroughs, for a test: each sentence it speaks is in `said` (with its language)
 * and lasts a second; `held` keeps it from speaking until `go`, so a test sees the order it takes;
 * a sentence with "mute" in it fails.
 */
export function fakeVoicing() {
  const said: string[] = [];
  const warmed: Language[] = [];
  let gate: { promise: Promise<void>; open: () => void } | undefined;
  /** What each clip says, by its file: what hearing it back hears. */
  const spoken = new Map<string, string>();
  const voicing = new Voicing({
    speak: async (text, out, language) => {
      if (gate) await gate.promise;
      if (/\bmute\b/i.test(text)) throw new Error('the voice failed\nno model');
      said.push(`${language}:${text}`);
      writeFileSync(out, silentWav(1));
      spoken.set(out.replace(/\.part\.wav$/, ''), text);
    },
    warm: (language) => void warmed.push(language),
    // hears each word a tenth of a second after the one before; a sentence with "deaf" in it not at all
    hear: async (wav) => {
      const text = spoken.get(wav) ?? '';
      if (/\bdeaf\b/i.test(text)) throw new Error('no recognition');
      return text.split(/\s+/).map((w, k): [string, number] => [` ${w}`, k / 10]);
    },
  });
  return {
    voicing,
    said,
    warmed,
    hold() {
      let open = () => {};
      const promise = new Promise<void>((r) => (open = r));
      gate = { promise, open };
    },
    go() {
      const g = gate;
      gate = undefined;
      g?.open();
    },
  };
}
