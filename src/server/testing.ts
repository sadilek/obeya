// Test doubles, and git repositories for tests.

import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Forge } from './forge';
import type { AgentEvent, AgentRuntime, AgentSession, AgentSpec, PermissionAnswer } from './runtime';
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

const templates = new Map<string, string>();
let templateDir: string | undefined;

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
    // a copy keeps mtime and size but not inode and ctime: git is to trust what the copy keeps
    appendFileSync(join(template, '.git/config'), '[core]\n\tcheckStat = minimal\n\ttrustctime = false\n');
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
  return path;
}

/** Removes the templates of `gitRepo`; test-setup.ts calls it once all tests have run. */
export function removeTemplates() {
  if (templateDir) rmSync(templateDir, { recursive: true, force: true });
  templateDir = undefined;
  templates.clear();
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

export const until = async (done: () => unknown, ms = 3000) => {
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
  const program = join(dir, 'gh');
  const script = join(dir, 'gh.ts');
  writeFileSync(
    script,
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
  writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return program;
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
  const program = join(dir, 'tailscale');
  const script = join(dir, 'tailscale.ts');
  writeFileSync(
    script,
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
  writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
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
  const voicing = new Voicing({
    speak: async (text, out, language) => {
      if (gate) await gate.promise;
      if (/\bmute\b/i.test(text)) throw new Error('the voice failed\nno model');
      said.push(`${language}:${text}`);
      writeFileSync(out, silentWav(1));
    },
    warm: (language) => void warmed.push(language),
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
