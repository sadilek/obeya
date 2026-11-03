// Other machines that workers run on, reached over SSH (design: Hosts). A workspace on one is
// named `ssh://<host>/<path there>`: git, the stack commands of the repository's settings and the worker's Claude Code
// run there through `ssh`, and files cross at fixed points (the plugin before a session, the owner's
// screenshots with a message, a demo directory at a handover). Nothing secret is stored there:
// the Claude login and the repository's GitHub token travel on stdin at each start.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type AddressInfo, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { resource } from './resources';
import { OWN_GROUP, spawnOutput } from './spawn';
import { expandHome, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';

/** Where a workspace on another machine says which machine it is on. */
const PREFIX = 'ssh://';

/** The workspace `path` on the host `name`, as Obeya names it. */
export const onHost = (name: string, path: string) => `${PREFIX}${name}${path.startsWith('/') ? '' : '/'}${path}`;

/** The host a workspace is on and its path there; null for a workspace on this machine. */
export function remote(path: string | null | undefined): { host: SshHost; path: string } | null {
  const name = hostName(path);
  if (name === null) return null;
  const host = hosts.get(name);
  if (!host) throw new HostError(`no host ${name} in the configuration`);
  return { host, path: path!.slice(PREFIX.length + name.length) || '/' };
}

/** The name of the host a workspace is on, null for this machine; also for a host no longer configured. */
export function hostName(path: string | null | undefined): string | null {
  if (!path?.startsWith(PREFIX)) return null;
  return path.slice(PREFIX.length).split('/')[0]!;
}

export class HostError extends Error {}

/** A host's exit code for "the connection failed" (ssh's own), whatever the command there did. */
export const LOST = 255;

/**
 * How long a host whose connection failed counts as unreachable for the commands the server waits
 * for, before one of them has it asked again in the background.
 */
export const RECHECK_DOWN_MS = 30_000;

/** Directories that come first on the host's PATH: where the official installers put Claude Code and Bun. */
const PATH_PREFIX = '$HOME/.local/bin:$HOME/.bun/bin';

/** Obeya's directory on a host, in its home: the plugin, the demo settings, the owner's screenshots, voices. */
export const HOST_DIR = '.obeya/remote';

/** A string as one word for a POSIX shell. */
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Environment for a command there, as one line of `export`s; values with line breaks are left out. */
function exports(env: Record<string, string | undefined>): string {
  return Object.entries(env)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && !/[\r\n]/.test(e[1]) && /^[A-Za-z_]\w*$/.test(e[0]))
    .map(([k, v]) => `export ${k}=${sh(v)};`)
    .join(' ');
}

/**
 * The directory of the shared connections' sockets: this user's alone, as whoever reaches a socket
 * uses its connection (and gets what goes over it, the tokens on stdin). Short, under `/tmp`, as a
 * socket's path has a limit of about 100 bytes; null when another user holds it, and each command
 * then connects on its own.
 */
function socketDir(): string | null {
  const dir = `/tmp/obeya-ssh-${process.getuid?.() ?? 0}`;
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) return null;
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

export interface HostOptions {
  name: string;
  /** What `ssh` connects to: `user@machine`, or a name from `~/.ssh/config`. */
  ssh: string;
  /** Obeya's home on this machine: copies of the host's demo directories go there. */
  home: string;
  /** The Claude login the host's sessions run on (`claude setup-token`); without it they run on the host's own. */
  claudeToken?: () => string | undefined;
  /** The program that is `ssh` (tests run the commands on this machine with a stand-in). */
  program?: string;
}

/** A machine reached over SSH. */
export class SshHost {
  private prepared?: Promise<string>;
  /** Tokens by the workspace root they are for (a repository's clones there): its GitHub login. */
  private tokens: { root: string; token: () => string | undefined }[] = [];
  /** When the connection last failed, while the host has not answered since; whether it is being asked again. */
  private down?: { at: number; asking?: boolean };
  /** Who hears that the host answers again after it did not. */
  private back: (() => void)[] = [];

  constructor(readonly o: HostOptions) {}

  get name() {
    return this.o.name;
  }

  /** `ssh`'s options: no prompts, a connection that fails fast and notices a drop, one connection shared where the platform can (`own`: a connection of its own). */
  private options(own = false): string[] {
    const sockets = own || process.platform === 'win32' ? null : socketDir();
    const shared = sockets ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${sockets}/%C`, '-o', 'ControlPersist=300'] : [];
    return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...shared, '-T'];
  }

  /** The workspaces under `root` (a repository's clones) use this GitHub login for git and gh. */
  tokenFor(root: string, token: () => string | undefined) {
    this.tokens.push({ root, token });
  }

  /** The GitHub login for a path there, by the root it is under. */
  private token(path: string): string | undefined {
    return this.tokens.find((t) => path === t.root || path.startsWith(`${t.root}/`))?.token();
  }

  /**
   * The argv of `ssh` running `command` (words, or a shell line) there in `cwd`: through `sh`, with
   * the installers' directories on its PATH; with `env`, read as the first line of stdin, so that
   * no secret shows in a process list. `sh` replaces the login shell there rather than running
   * under it (dash, say, forks for it), so that a session's pid is the one ssh started and a signal
   * to it reaches the command.
   */
  argv(command: string[] | string, o: { cwd?: string; env?: boolean; forward?: string; local?: string } = {}): string[] {
    const line = typeof command === 'string' ? command : `exec ${command.map(sh).join(' ')}`;
    const script = [
      o.env ? 'IFS= read -r obeya_env; eval "$obeya_env"; unset obeya_env;' : '',
      `PATH="${PATH_PREFIX}:$PATH"; export PATH;`,
      o.cwd ? `cd ${sh(o.cwd)} && { ${line}
}` : line,
    ]
      .filter(Boolean)
      .join(' ');
    // a forward from here goes on a connection of its own, which ends with it rather than with the shared one
    const forwards = [...(o.forward ? ['-R', o.forward] : []), ...(o.local ? ['-o', 'ExitOnForwardFailure=yes', '-L', o.local] : [])];
    return [this.o.program ?? 'ssh', ...this.options(!!o.local), ...forwards, this.o.ssh, `exec sh -c ${sh(script)}`];
  }

  /** The environment line for a command in `cwd`: the GitHub login of the repository it is in. */
  private envLine(cwd: string | undefined, extra: Record<string, string | undefined> = {}): string {
    const token = cwd ? this.token(cwd) : undefined;
    return `${exports({ ...(token ? { GH_TOKEN: token } : {}), ...extra })}\n`;
  }

  /** Whether the host's connection failed and it has not answered since. */
  get unreachable(): boolean {
    return !!this.down;
  }

  /** `f` runs each time the host answers again after its connection failed; returns what stops that. */
  onBack(f: () => void): () => void {
    this.back.push(f);
    return () => (this.back = this.back.filter((g) => g !== f));
  }

  /** What a command's exit code says about the connection: `LOST` that it failed, anything else that the host answered. */
  private heard(code: number) {
    if (code === LOST) {
      if (this.down) this.down.at = Date.now();
      else this.down = { at: Date.now() };
      return;
    }
    if (!this.down) return;
    this.down = undefined;
    for (const f of this.back) f();
  }

  /**
   * Runs a program there and waits for it (git, mostly: short calls on a shared connection). The
   * server answers nothing else meanwhile, and ssh gives up on a host that does not answer only
   * after seconds (a name it cannot resolve, a connection timeout): while the host's connection has
   * failed, it fails at once instead, and from time to time the host is asked again in the background.
   */
  runSync(argv: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    if (this.down) {
      if (!this.down.asking && Date.now() - this.down.at >= RECHECK_DOWN_MS) {
        const down = this.down;
        down.asking = true;
        void this.reachable().finally(() => (down.asking = false));
      }
      return { code: LOST, stdout: '', stderr: `${this.name} does not answer` };
    }
    const r = Bun.spawnSync(this.argv(argv, { cwd, env: true }), { stdin: Buffer.from(this.envLine(cwd)), stdout: 'pipe', stderr: 'pipe' });
    const code = r.exitCode ?? LOST;
    this.heard(code);
    return { code, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  /** Runs a program (or a shell line) there without blocking the server; `input` is its stdin, after the environment line. */
  async run(command: string[] | string, o: { cwd?: string; timeout?: number; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await spawnOutput(this.argv(command, { cwd: o.cwd, env: true }), {
      stdin: new Blob([this.envLine(o.cwd), o.input ?? '']),
      ...(o.timeout ? { timeout: o.timeout } : {}),
    });
    const code = r.signal ? LOST : r.code;
    this.heard(code);
    return { code, stdout: r.stdout, stderr: r.stderr };
  }

  /** Whether the host answers now. */
  async reachable(): Promise<boolean> {
    return (await this.run(['true'], { timeout: 20_000 })).code === 0;
  }

  /** The absolute path of a directory there (`~/…` as the host's home has it), created if missing. */
  async resolveDir(dir: string): Promise<string> {
    const at = dir === '~' ? '"$HOME"' : dir.startsWith('~/') ? `"$HOME"/${sh(dir.slice(2))}` : sh(dir);
    const r = await this.run(`mkdir -p ${at} && cd ${at} && pwd -P`);
    if (r.code !== 0) throw new HostError(`${this.name}: ${dir}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
    return r.stdout.trim();
  }

  /** Copies the directory `from` here into `to` there, replacing what was there. */
  copyTo(from: string, to: string): Promise<void> {
    return this.send(['-C', from, '.'], to, true, `copying ${from} to ${this.name}:${to}`);
  }

  /** Sends what tar packs here (`pack`: its arguments) into the directory `to` there, emptied first when `fresh`; `what` names the copy where it fails. */
  private async send(pack: string[], to: string, fresh: boolean, what: string): Promise<void> {
    const tar = Bun.spawn(['tar', '-cf', '-', ...pack], { stdout: 'pipe', stderr: 'pipe' });
    const p = Bun.spawn(this.argv(`${fresh ? `rm -rf ${sh(to)} && ` : ''}mkdir -p ${sh(to)} && tar -xf - -C ${sh(to)}`), { stdin: tar.stdout, stdout: 'pipe', stderr: 'pipe' });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited, tar.exited]);
    if (code !== 0) throw new HostError(`${what}: ${err.trim() || `exit code ${code}`}`);
  }

  /** Copies the directory `from` there into `to` here, replacing what was here. */
  async copyFrom(from: string, to: string): Promise<void> {
    // it replaces what is at `to`: only ever a copy of this host's
    if (!resolve(to).startsWith(resolve(this.copies()) + sep)) throw new HostError(`${to} is no place for a copy of ${this.name}'s files`);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    const p = Bun.spawn(this.argv(['tar', '-C', from, '-cf', '-', '.']), { stdout: 'pipe', stderr: 'pipe' });
    const tar = Bun.spawn(['tar', '-xf', '-', '-C', to], { stdin: p.stdout, stdout: 'ignore', stderr: 'pipe' });
    const [err, code, untar] = await Promise.all([new Response(p.stderr).text(), p.exited, tar.exited]);
    if (code !== 0 || untar !== 0) throw new HostError(`copying ${this.name}:${from}: ${err.trim() || `exit code ${code || untar}`}`);
  }

  /** Copies files from here into a directory there, keeping their names. */
  copyFiles(files: string[], to: string): Promise<void> {
    return this.send(
      files.flatMap((f) => ['-C', dirname(f), basename(f)]),
      to,
      false,
      `copying files to ${this.name}:${to}`,
    );
  }

  /**
   * Marks a clone there as trusted by Claude Code (its folder dialog, `hasTrustDialogAccepted` in
   * `~/.claude.json`), so that the repository's own settings (its permission rules, say) apply
   * there as in the clones the owner trusted here. Nobody is there to answer the dialog. A file it
   * cannot read is left alone.
   */
  async trust(dir: string): Promise<void> {
    const r = await this.run('cat "$HOME/.claude.json" 2>/dev/null || true');
    if (r.code !== 0) throw new HostError(`${this.name}: ${r.stderr.trim()}`);
    let config: { projects?: Record<string, Record<string, unknown>> };
    try {
      config = r.stdout.trim() ? JSON.parse(r.stdout) : {};
    } catch {
      return;
    }
    const projects = (config.projects ??= {});
    if (projects[dir]?.hasTrustDialogAccepted) return;
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
    // written whole and moved into place, so a session reading it meanwhile sees the old or the new file
    const w = await this.run('cat > "$HOME/.claude.json.obeya" && mv "$HOME/.claude.json.obeya" "$HOME/.claude.json"', { input: JSON.stringify(config, null, 2) });
    if (w.code !== 0) throw new HostError(`${this.name}: ${w.stderr.trim()}`);
  }

  /**
   * A session's transcript there (Claude Code's, under the directory it ran in), copied here for
   * the Arbeitsrückschau; null when there is none or the host does not answer.
   */
  async transcript(sessionId: string, cwd: string): Promise<string | null> {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    const r = await this.run(`cat "$HOME"/.claude/projects/${sh(cwd.replace(/[^a-zA-Z0-9]/g, '-'))}/${sh(`${sessionId}.jsonl`)}`);
    if (r.code !== 0 || !r.stdout) return null;
    const file = join(this.o.home, 'hosts', this.name, 'transcripts', `${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.stdout);
    return file;
  }

  /**
   * A host directory's copy here, where the server serves and shares it from: under Obeya's home, by
   * host and path. A path with `.` or `..` in it has none: the worker names it, and the copy replaces
   * whatever is at its place here.
   */
  localCopy(path: string): string {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '.' || p === '..')) throw new HostError(`${path} is no directory path without . and ..`);
    return join(this.copies(), ...parts);
  }

  /** Where the copies of the host's directories are here. */
  private copies(): string {
    return join(this.o.home, 'hosts', this.name);
  }

  /**
   * Makes the host ready for sessions, once per run of Obeya (again after it failed): Obeya's
   * directory there with `files` in it. Returns that directory. A directory that did not change
   * since its last copy is not copied again.
   */
  prepare(files: HostFiles): Promise<string> {
    this.prepared ??= this.copyOnce(files).catch((e) => {
      this.prepared = undefined;
      throw e;
    });
    return this.prepared;
  }

  private async copyOnce(files: HostFiles): Promise<string> {
    const dir = await this.resolveDir(`~/${HOST_DIR}`);
    for (const [name, from] of Object.entries(files.dirs)) {
      if (!existsSync(from)) continue;
      const stamp = treeStamp(from);
      const there = await this.run(['cat', `${dir}/${name}.stamp`]);
      if (there.code === 0 && there.stdout.trim() === stamp) continue;
      await this.copyTo(from, `${dir}/${name}`);
      const w = await this.run(`printf %s ${sh(stamp)} > ${sh(`${dir}/${name}.stamp`)}`);
      if (w.code !== 0) throw new HostError(`${this.name}: ${w.stderr.trim()}`);
    }
    for (const [name, content] of Object.entries(files.files ?? {})) {
      const text = content();
      const w = await this.run(text === undefined ? `rm -f ${sh(`${dir}/${name}`)}` : `cat > ${sh(`${dir}/${name}`)}`, { input: text });
      if (w.code !== 0) throw new HostError(`copying ${name} to ${this.name}: ${w.stderr.trim()}`);
    }
    return dir;
  }

  /**
   * Forwards a free port here to `port` at `target` as the host reaches it (the address of an app
   * running there, for the owner's browser), on a connection of its own, until `close`. `prefer`
   * is the port tried first (the one a forward had before it went with a dropped connection).
   * The forward ends with Obeya too: its command there waits for stdin, which closes then.
   */
  forward(target: string, port: number, prefer?: number): Forward {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let closed = false;
    let alive = true;
    const listen = async (): Promise<number | null> => {
      const local = (prefer && (await freePort(prefer))) || (await freePort(0));
      if (closed || !local) return null;
      child = Bun.spawn(this.argv('cat >/dev/null', { local: `localhost:${local}:${target.includes(':') ? `[${target}]` : target}:${port}` }), {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'pipe',
        detached: OWN_GROUP,
      });
      void child.exited.then(() => (alive = false));
      void new Response(child.stderr as ReadableStream).text().then((text) => text.trim() && console.error(`${this.name}: ${text.trim()}`));
      // the port takes connections once ssh logged in and listens; ssh gives up on its own (ConnectTimeout)
      while (alive && !closed) {
        if (await accepts(local)) return local;
        await Bun.sleep(50);
      }
      return null;
    };
    const forward: Forward = {
      ready: listen(),
      get alive() {
        return alive && !closed;
      },
      close: () => {
        closed = true;
        child?.kill();
      },
    };
    return forward;
  }

  /**
   * A worker's session there: the SDK's `spawnClaudeCodeProcess`, which starts Claude Code through
   * `ssh` in `cwd` once the host has `files` (paths of those directories among its arguments
   * become their copies there), its environment (the SDK's and the session's, Obeya's directory
   * there as `OBEYA_HOME`, the logins) read from stdin first. A host that cannot be made ready
   * ends the process as a lost connection would. With `OBEYA_NARRATION_URL` in the environment, a
   * port there is forwarded to it, Obeya's narration alone, as `OBEYA_URL` there. `onExit` hears the exit code of
   * `ssh` (`LOST`: the connection failed or dropped).
   */
  session(o: { cwd: string; files: HostFiles; onExit?: (code: number | null) => void }): (s: SpawnOptions) => SpawnedProcess {
    const ready = this.prepare(o.files);
    return (s) => {
      const p = deferred(ready, (dir) => {
        const token = this.o.claudeToken?.();
        const local = Object.entries(o.files.dirs);
        const args = s.args.map((a) => {
          const hit = local.find(([, from]) => a === from);
          return hit ? `${dir}/${hit[0]}` : a;
        });
        // only the narration's port: whoever is on that machine reaches the forward too
        const here = s.env.OBEYA_NARRATION_URL ? Number(new URL(s.env.OBEYA_NARRATION_URL).port) : 0;
        // a port of its own per session, so that sessions ending do not take another's forward along
        const there = here ? 30_000 + Math.floor(Math.random() * 30_000) : 0;
        // a session cut off by a dropped connection may still run there: the one that resumes it ends it first;
        // not itself, whose pid a host that restarted since (a container, say) may give out again
        const pid = sh(`${dir}/sessions/${o.cwd.replace(/[^\w.-]+/g, '-')}.pid`);
        const previous = `mkdir -p ${sh(`${dir}/sessions`)}; old=$(cat ${pid} 2>/dev/null); [ -n "$old" ] && [ "$old" != $$ ] && ps -p "$old" -o command= 2>/dev/null | grep -q claude && kill "$old"; echo $$ > ${pid};`;
        const argv = this.argv(`${previous} exec ${[s.command, ...args].map(sh).join(' ')}`, {
          cwd: o.cwd,
          env: true,
          ...(here ? { forward: `127.0.0.1:${there}:127.0.0.1:${here}` } : {}),
        });
        const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP });
        // with Obeya reachable, a voice it holds loaded narrates from Obeya's machine (OBEYA_HOLDS_VOICE: no need to install it here)
        const { OBEYA_URL: _, OBEYA_NARRATION_URL: __, ...own } = s.env;
        const env = { ...own, OBEYA_HOME: dir, ...(here ? { OBEYA_URL: `http://127.0.0.1:${there}`, OBEYA_HOLDS_VOICE: '1' } : {}), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) };
        child.stdin!.write(this.envLine(o.cwd, env));
        // ssh's own complaints (a forward refused, the connection dropped) are no session output
        child.stderr!.on('data', (d: Buffer) => {
          const text = d.toString().trim();
          if (text) console.error(`${this.name}: ${text}`);
        });
        return child;
      });
      // the process's exit, not ssh's: a host that could not be made ready never started it
      p.on('exit', (code: number | null) => o.onExit?.(code));
      return p;
    };
  }
}

/** A port here forwarded to one a host reaches (`SshHost.forward`). */
export interface Forward {
  /** The port here once it takes connections; null when the forward failed or was closed first. */
  ready: Promise<number | null>;
  /** False once the forward ended: closed, failed, or gone with its connection. */
  readonly alive: boolean;
  close(): void;
}

/** `port` here if it is free on the loopback, else (or for 0) one the system picks; null if none. */
function freePort(port: number): Promise<number | null> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(null));
    server.listen(port, '127.0.0.1', () => {
      const { port: got } = server.address() as AddressInfo;
      server.close(() => done(got));
    });
  });
}

/** Whether something here takes connections on `port`. */
async function accepts(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** What a host gets before a session, by the path it has in Obeya's directory there. */
export interface HostFiles {
  /** Directories here. */
  dirs: Record<string, string>;
  /** Files by their content; none removes one there. */
  files?: Record<string, () => string | undefined>;
}

/** A fingerprint of a directory's files (names, sizes, times): what changes when one does. */
function treeStamp(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const s = statSync(p);
        h.update(`${relative(dir, p)}\0${s.size}\0${s.mtimeMs}\n`);
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/**
 * A process for the SDK that starts once `ready` settles: its stdin is held until then, and a
 * `ready` that fails ends it with the code of a lost connection.
 */
function deferred<T>(ready: Promise<T>, start: (value: T) => ChildProcess): SpawnedProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let child: ChildProcess | undefined;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let killed = false;
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    signalCode = signal;
    stdout.end();
    events.emit('exit', code, signal);
  };
  ready.then(
    (value) => {
      if (killed) return exit(null, 'SIGTERM');
      try {
        child = start(value);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        return exit(LOST, null);
      }
      stdin.pipe(child.stdin!);
      child.stdout!.pipe(stdout);
      child.on('exit', exit);
      child.on('error', (e) => events.emit('error', e));
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      exit(LOST, null);
    },
  );
  return {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill(signal) {
      killed = true;
      return child ? child.kill(signal) : true;
    },
    on: (event: string, listener: (...a: any[]) => void) => void events.on(event, listener),
    once: (event: string, listener: (...a: any[]) => void) => void events.once(event, listener),
    off: (event: string, listener: (...a: any[]) => void) => void events.off(event, listener),
  } as SpawnedProcess;
}

/**
 * What a worker's session needs on a host: the plugins it loads, the `playwright-core` the demo
 * skill imports (found from the plugin's directory there, as in Obeya's checkout), and the owner's
 * demo settings, with the voice references as paths here: Obeya holds that voice and reads them.
 * The key file of a hosted voice stays here, and so does the demo directory, a path of this
 * machine: on the host, demos go into its default.
 */
export function sessionFiles(home: string, plugins: string[]): HostFiles {
  return {
    dirs: { ...Object.fromEntries(plugins.map((p) => [basename(p), p])), 'node_modules/playwright-core': resource('node_modules', 'playwright-core') },
    files: {
      'demo.json': () => {
        const file = join(home, 'demo.json');
        if (!existsSync(file)) return undefined;
        const { keyFile: _, directory: __, references, ...settings } = readDemoSettings(home);
        return JSON.stringify({ ...settings, ...(references ? { references: Object.fromEntries(Object.entries(references).map(([l, clip]) => [l, expandHome(clip)])) } : {}) }, null, 2);
      },
    },
  };
}

/** The hosts of the configuration, by name. */
const hosts = new Map<string, SshHost>();

/** Makes a host known under its name; the configuration's hosts are registered at start. */
export function registerHost(o: HostOptions): SshHost {
  const known = hosts.get(o.name);
  if (known && known.o.ssh === o.ssh && known.o.program === o.program) return known;
  const host = new SshHost(o);
  hosts.set(o.name, host);
  return host;
}

/**
 * The token sessions log in to Claude with where not on this machine's account (a host's, and this
 * machine's when it runs on `CLAUDE_CODE_OAUTH_TOKEN`): `claude-token` in Obeya's home, or
 * `CLAUDE_CODE_OAUTH_TOKEN`.
 */
export function claudeToken(home: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const file = join(home, 'claude-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim() || undefined;
  return env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
}

/**
 * Keeps a new token (from `claude setup-token`) as `claude-token`, for the owner's eyes alone; the
 * sessions that start from now on log in with it, this machine's too where it runs on a token.
 */
export function saveClaudeToken(home: string, token: string, env: Record<string, string | undefined> = process.env) {
  const file = join(home, 'claude-token');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  if (env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

/**
 * git's credential helper for a host's clones: the GitHub login comes from `GH_TOKEN`, which Obeya
 * passes with each command and session, and is stored nowhere (the empty helper before it drops the
 * system's, macOS's keychain, which would keep it).
 */
export const TOKEN_HELPER = ['', '!f() { test "$1" = get && test -n "$GH_TOKEN" && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'];

/** git's options that make a command there use `TOKEN_HELPER`. */
export const TOKEN_HELPER_ARGS = TOKEN_HELPER.flatMap((h) => ['-c', `credential.helper=${h}`]);

/** How long a repository's GitHub login is asked again after it was read. */
const TOKEN_TTL = 10 * 60_000;

/**
 * The GitHub login git uses for a repository here (`git credential fill` in its checkout, so the
 * account its own configuration picks), for its clones on a host; none for a remote not on HTTPS.
 */
export function githubToken(repoPath: string, remoteUrl: string | undefined, git: string = 'git'): () => string | undefined {
  let cached: { token: string | undefined; at: number } | undefined;
  return () => {
    if (cached && Date.now() - cached.at < TOKEN_TTL) return cached.token;
    let token: string | undefined;
    const url = remoteUrl?.match(/^https:\/\/([^/]+)\//);
    if (url) {
      const r = Bun.spawnSync([git, '-C', repoPath, 'credential', 'fill'], {
        stdin: Buffer.from(`protocol=https\nhost=${url[1]}\n\n`),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      token = r.exitCode === 0 ? /^password=(.*)$/m.exec(r.stdout.toString())?.[1] : undefined;
    }
    cached = { token, at: Date.now() };
    return token;
  };
}
