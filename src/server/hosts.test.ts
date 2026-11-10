// Workers on other machines (design: Hosts), against a stand-in for `ssh` that runs the commands
// on this machine (`fakeSsh`): git and files over the connection, a session's process, clones
// there, and a session that resumes once a dropped connection is back.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { generic } from '../adapters/generic';
import { Board } from './board';
import { Store } from './db';
import { githubToken, HostError, hostName, onHost, registerHost, remote, sessionFiles, type SshHost } from './hosts';
import { runAppCommand } from './app-command';
import { codexRuntime } from './codex';
import { claudeModels } from './harnesses';
import { type AgentEvent, sdkRuntime } from './runtime';
import { FakeRuntime, fakeSsh, gitClone, gitRepo, identify, removeDir, syncGitCalls, until } from './testing';
import { Workers } from './workers';
import { git, gitAsync, HERE, RECHECK_MS, Workspaces } from './workspaces';

let dir: string;
let ssh: string;
let host: SshHost;
let name: string;
/**
 * A host is a macOS or Linux machine, and the stand-in for `ssh` runs the host's shell commands
 * on this one: on Windows, which is no host, the tests that go over the connection are skipped.
 */
const overSsh = process.platform === 'win32' ? test.skip : test;
const log = () => (existsSync(join(dir, 'net', 'log')) ? readFileSync(join(dir, 'net', 'log'), 'utf8') : '');

beforeEach(() => {
  // as `pwd -P` there names it
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'obeya-hosts-')));
  ssh = fakeSsh(join(dir, 'net'));
  // a host of its own per test: what it prepared once is not prepared again
  name = `box${Math.random().toString(36).slice(2, 8)}`;
  host = registerHost({ name, ssh: 'me@box', home: join(dir, 'home'), program: ssh, claudeToken: () => 'sk-claude' });
});
afterEach(() => removeDir(dir));

describe('a workspace on a host', () => {
  test('is named by its host, and found again by that name', () => {
    const path = onHost(name, '/srv/clones/1');
    expect(path).toBe(`ssh://${name}/srv/clones/1`);
    expect(remote(path)).toEqual({ host, path: '/srv/clones/1' });
    expect(hostName(path)).toBe(name);
    expect(remote('/Users/me/repo')).toBeNull();
    expect(() => remote('ssh://gone/x')).toThrow('no host gone');
    expect(hostName('ssh://gone/x')).toBe('gone');
  });

  overSsh('runs git there, with the GitHub login on stdin rather than on the command line', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    host.tokenFor(repo, () => 'ghp_secret');
    const path = onHost(name, repo);
    expect(git(path, 'branch', '--show-current')).toBe('main');
    expect(await gitAsync(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(() => git(path, 'checkout', 'nowhere')).toThrow('git checkout nowhere');
    expect((await host.run('printf %s "$GH_TOKEN"', { cwd: repo })).stdout).toBe('ghp_secret');
    expect((await host.run('printf %s "$GH_TOKEN"', { cwd: dir })).stdout).toBe('');
    expect(log()).toContain('me@box');
    expect(log()).not.toContain('ghp_secret');
  });

  overSsh("reads the repository's GitHub login in the background, a command there waiting for it the first time", async () => {
    const repo = gitRepo(join(dir, 'repo'));
    // git's credential helper as a stand-in: each read gives a new login, and is counted
    const fakeGit = join(dir, 'fake-git');
    writeFileSync(fakeGit, `#!/bin/sh\necho x >> ${join(dir, 'reads')}\necho password=ghp_$(wc -l < ${join(dir, 'reads')} | tr -d ' ')\n`, { mode: 0o755 });
    const reads = () => (existsSync(join(dir, 'reads')) ? readFileSync(join(dir, 'reads'), 'utf8').split('\n').length - 1 : 0);
    const synced = syncGitCalls();
    const login = githubToken(repo, 'https://github.com/acme/repo.git', fakeGit);
    host.tokenFor(repo, login);
    expect((await host.run('printf %s "$GH_TOKEN"', { cwd: repo })).stdout).toBe('ghp_1');
    expect(login()).toBe('ghp_1');
    expect(reads()).toBe(1);
    // read again in the background once it is old: the one before stands meanwhile
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try {
      expect(login()).toBe('ghp_1');
      await until(() => login() === 'ghp_2');
    } finally {
      setSystemTime();
    }
    expect(synced.stop()).toEqual([]);
    // a remote not on HTTPS has none, and nothing is read for it
    expect(githubToken(repo, 'git@github.com:acme/repo.git', fakeGit)()).toBeUndefined();
    expect(reads()).toBe(2);
  });

  overSsh("runs the stack commands of the settings there", async () => {
    mkdirSync(join(dir, 'ws'));
    const r = await runAppCommand(onHost(name, join(dir, 'ws')), 'pwd -P && echo stopped > stack.log');
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'ws', 'stack.log'), 'utf8')).toBe('stopped\n');
    writeFileSync(join(dir, 'net', 'down'), '');
    expect((await runAppCommand(onHost(name, join(dir, 'ws')), 'true')).ok).toBe(false);
  });

  overSsh('copies directories there and back', async () => {
    mkdirSync(join(dir, 'demo', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'demo.mp4'), 'video');
    writeFileSync(join(dir, 'demo', 'sub', "it's.txt"), 'quote');
    await host.copyTo(join(dir, 'demo'), join(dir, 'there', 'demo'));
    expect(readFileSync(join(dir, 'there', 'demo', 'sub', "it's.txt"), 'utf8')).toBe('quote');
    const copy = host.localCopy(join(dir, 'there', 'demo'));
    expect(copy.startsWith(join(dir, 'home', 'hosts', name))).toBe(true);
    await host.copyFrom(join(dir, 'there', 'demo'), copy);
    expect(readFileSync(join(copy, 'demo.mp4'), 'utf8')).toBe('video');
    await expect(host.copyFrom(join(dir, 'nothing'), copy)).rejects.toThrow();
    // the worker names the directory: none leads out of the copies, whose place a copy takes
    expect(() => host.localCopy('/../../..')).toThrow(HostError);
    expect(() => host.localCopy('/tmp/./x')).toThrow(HostError);
    await expect(host.copyFrom(join(dir, 'there', 'demo'), join(dir, 'home'))).rejects.toThrow(HostError);
    expect(existsSync(join(dir, 'home'))).toBe(true);
  });
});

describe('a session on a host', () => {
  /** A session's process from the SDK's spawn options, with what it printed. */
  const spawnSession = (s: Omit<SpawnOptions, 'signal'>, files = { dirs: { plugin: join(dir, 'plugin') } }, onExit?: (code: number | null) => void) => {
    const p = host.session({ cwd: join(dir, 'ws'), files, onExit })({ ...s, signal: new AbortController().signal });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
    return { p, out: () => out, exited };
  };

  beforeEach(() => {
    mkdirSync(join(dir, 'plugin', 'skills'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'skills', 'SKILL.md'), 'a skill');
    mkdirSync(join(dir, 'ws'));
  });

  overSsh('starts Claude Code there once the host has the plugin, with its environment and the logins from stdin', async () => {
    const s = spawnSession({
      command: 'sh',
      args: ['-c', 'echo "$PWD|$FOO|$OBEYA_HOME|$CLAUDE_CODE_OAUTH_TOKEN|$OBEYA_URL|$1|$OBEYA_HOLDS_VOICE"; cat "$1/skills/SKILL.md"; echo; read line; echo "got $line"', 'x', join(dir, 'plugin')],
      env: { FOO: "it's", OBEYA_URL: 'http://localhost:4417', OBEYA_NARRATION_URL: 'http://127.0.0.1:4418' },
    });
    s.p.stdin.write('ping\n');
    expect(await s.exited).toBe(0);
    // Obeya's directory there is in the host's home
    const remoteDir = join(dir, 'net', 'home', '.obeya', 'remote');
    const [first, skill, got] = s.out().trim().split('\n');
    const [pwd, foo, home, token, url, plugin, held] = first!.split('|');
    expect(pwd).toEndWith('/ws');
    expect(foo).toBe("it's");
    expect(home).toBe(remoteDir);
    expect(token).toBe('sk-claude');
    // a port there forwarded to Obeya's here
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d{5}$/);
    expect(plugin).toBe(`${home}/plugin`);
    // the narration voice Obeya holds needs no installation there
    expect(held).toBe('1');
    expect(skill).toBe('a skill');
    expect(got).toBe('got ping');
    expect(readFileSync(join(remoteDir, 'plugin.stamp'), 'utf8')).toHaveLength(16);
    expect(log()).not.toContain('sk-claude');
  });

  overSsh("ends as a lost connection when the host cannot be made ready", async () => {
    writeFileSync(join(dir, 'net', 'down'), '');
    let heard: number | null | undefined;
    const s = spawnSession({ command: 'true', args: [], env: {} }, undefined, (code) => (heard = code));
    expect(await s.exited).toBe(255);
    // what has the runtime call it a lost connection rather than a failed session
    expect(heard).toBe(255);
  });

  overSsh("a host unreachable before Claude Code starts there loses the connection rather than failing the session", async () => {
    writeFileSync(join(dir, 'net', 'down'), '');
    const events: AgentEvent[] = [];
    const session = sdkRuntime.start({ cwd: onHost(name, join(dir, 'ws')), system: '', tools: [], plugins: [join(dir, 'plugin')], onEvent: (e) => events.push(e) }, 'hello');
    await session.done;
    expect(events).toEqual([{ type: 'lost', message: `the connection to ${name} was lost` }]);
  });

  overSsh('ends the session a dropped connection left running there, but never itself', async () => {
    const pids = join(dir, 'net', 'home', '.obeya', 'remote', 'sessions');
    const pidFile = join(pids, `${join(dir, 'ws').replace(/[^\w.-]+/g, '-')}.pid`);
    mkdirSync(pids, { recursive: true });
    // the one left running
    const left = spawn('sh', ['-c', 'sleep 30; echo claude']);
    writeFileSync(pidFile, `${left.pid}\n`);
    const ended = new Promise((r) => left.on('exit', r));
    const s = spawnSession({ command: 'sh', args: ['-c', 'echo claude here'], env: {} });
    expect(await s.exited).toBe(0);
    await ended;
    // a host that restarted gives out its pids again: the new session may have the one in the file
    const wrapper = join(dir, 'net', 'same-pid');
    writeFileSync(wrapper, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec ${JSON.stringify(ssh)} "$@"\n`, { mode: 0o755 });
    const again = registerHost({ name: `${name}-again`, ssh: 'me@box', home: join(dir, 'home'), program: wrapper });
    const p = again.session({ cwd: join(dir, 'ws'), files: { dirs: { plugin: join(dir, 'plugin') } } })({ command: 'sh', args: ['-c', 'echo claude here'], env: {}, signal: new AbortController().signal });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    expect(await new Promise<number | null>((r) => p.on('exit', (code: number | null) => r(code)))).toBe(0);
    expect(out).toContain('claude here');
  });

  overSsh('copies the plugin once, until it changes', async () => {
    await host.prepare({ dirs: { plugin: join(dir, 'plugin') } });
    const again = registerHost({ name: `${name}-2`, ssh: 'me@box', home: join(dir, 'home'), program: ssh });
    const copies = () => log().split('\n').filter((l) => l.includes('tar -xf')).length;
    const before = copies();
    await again.prepare({ dirs: { plugin: join(dir, 'plugin') } });
    expect(copies()).toBe(before);
  });

  test("the owner's demo settings go there with the voice references as paths here, without a key file or the demo directory", () => {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'demo.json'), JSON.stringify({ language: 'de', voice: 'qwen3', references: { de: '~/voice/me.wav', en: '/voice/me-en.wav' }, keyFile: '~/.voice/key', directory: '/opt/work/demos' }));
    const settings = JSON.parse(sessionFiles(join(dir, 'home'), []).files!['demo.json']!()!);
    expect(settings.references).toEqual({ de: `${homedir()}/voice/me.wav`, en: '/voice/me-en.wav' });
    expect(settings.keyFile).toBeUndefined();
    // a path of this machine: demos on the host go into its own ~/demos
    expect(settings.directory).toBeUndefined();
  });
});

describe('clones on a host', () => {
  let origin: string;
  let spaces: Workspaces;
  let store: Store;
  let board: Board;

  beforeEach(() => {
    gitRepo(join(dir, 'main'));
    origin = join(dir, 'origin.git');
    gitClone(join(dir, 'main'), origin, { bare: true });
    store = new Store(':memory:');
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: join(dir, 'main'), branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: join(dir, 'ws') });
  });

  overSsh('are made there, leased after those here, and land through the remote', async () => {
    await spaces.ensureClones(origin, 1);
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 2, () => 'ghp_x')).toBeNull();
    // made once: a second call finds them
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 2, () => 'ghp_x')).toBeNull();
    expect(spaces.list().map((w) => w.path)).toEqual([join(dir, 'ws', '1'), onHost(name, join(dir, 'far', '1')), onHost(name, join(dir, 'far', '2'))]);
    // trusted by Claude Code, whose dialog nobody answers there
    const trusted = JSON.parse(readFileSync(join(dir, 'net', 'home', '.claude.json'), 'utf8')).projects;
    expect(Object.keys(trusted)).toEqual([join(dir, 'far', '1'), join(dir, 'far', '2')]);
    expect(trusted[join(dir, 'far', '1')]).toEqual({ hasTrustDialogAccepted: true });
    // the system's helper (macOS's keychain) reset by an empty one, then the token's
    expect(Bun.spawnSync(['git', '-C', join(dir, 'far', '1'), 'config', '--local', '--get-all', 'credential.helper']).stdout.toString()).toMatch(/^\n!f\(\).*GH_TOKEN/);
    const [a, b] = [board.create({ title: 'A', x: 0, y: 0 }).id, board.create({ title: 'B', x: 0, y: 0 }).id];
    const here = spaces.lease(a, 'obeya/a');
    expect(here.path).toBe(join(dir, 'ws', '1'));
    const far = spaces.lease(b, 'obeya/b');
    expect(far.path).toBe(onHost(name, join(dir, 'far', '1')));
    await Promise.all([here.ready, far.ready]);
    expect(await spaces.hasWork(b)).toBe(false);
    const local = join(dir, 'far', '1');
    identify(local);
    writeFileSync(join(local, 'new.txt'), 'x\n');
    expect(await spaces.hasWork(b)).toBe(true);
    expect(await spaces.changes(b)).toEqual([{ file: 'new.txt', regions: [] }]);
    git(local, 'add', '.');
    git(local, 'commit', '--quiet', '-m', 'far work');
    const landed = await spaces.pushToMain(b);
    expect('to' in landed && git(origin, 'log', '-1', '--format=%s', 'main')).toBe('far work');
    await spaces.discard(b, 'obeya/b');
    expect(git(local, 'branch', '--list', 'obeya/b')).toBe('');
    // many git calls, each through the stand-in for ssh
  }, 30_000);

  overSsh('take a new card on the first machine with a free slot, here first', async () => {
    let workers!: Workers;
    spaces = new Workspaces(store, 'c', {
      mode: 'clones',
      repoPath: join(dir, 'main'),
      dir: join(dir, 'ws'),
      machines: [{ host: null, slots: 1 }, { host: name, slots: 1 }],
      busy: (h) => workers.busyOn(h),
    });
    await spaces.ensureClones(origin, 2);
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 2, () => undefined)).toBeNull();
    const runtime = new FakeRuntime();
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, workspaces: 'clones', land: 'pr' } });
    const [a, b, c] = ['A', 'B', 'C'].map((title) => board.create({ title, x: 0, y: 0 }).id) as [string, string, string];
    await workers.start(a);
    expect(board.row(a).workspace).toBe(join(dir, 'ws', '1'));
    // the slot here is taken by A at work, though a clone here is free
    await workers.start(b);
    expect(board.row(b).workspace).toBe(onHost(name, join(dir, 'far', '1')));
    expect(() => workers.start(c)).toThrow(expect.objectContaining({ code: 'noSlot' }));
    expect(spaces.leasable()).toBe(false);
    expect(spaces.pool(workers.inTurn())).toEqual([
      { name: HERE, here: true, slots: 1, total: 2, cards: [a], busy: [a], workspaces: [{ path: join(dir, 'ws', '1'), card: a }, { path: join(dir, 'ws', '2') }] },
      { name, slots: 1, total: 2, cards: [b], busy: [b], workspaces: [{ path: join(dir, 'far', '1'), card: b }, { path: join(dir, 'far', '2') }] },
    ]);
    // A asks the owner and holds its clone, but no slot
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a).workspace)!;
    await sa.call('ask', { question: 'Welche Farbe?' });
    sa.emit({ type: 'idle' });
    expect(spaces.leasable()).toBe(true);
    await workers.start(c);
    expect(board.row(c).workspace).toBe(join(dir, 'ws', '2'));
    // the owner's question to a card whose work is over does not wait for a slot
    const d = board.create({ title: 'D', x: 0, y: 0 }).id;
    const lease = spaces.lease(d, 'obeya/d', { overSlots: true });
    expect(lease.path).toBe(onHost(name, join(dir, 'far', '2')));
    await lease.ready;
    workers.shutdown();
  }, 30_000);

  overSsh('of a host that stops answering are looked at in the background, and again only a while later', async () => {
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 2, () => undefined)).toBeNull();
    let back = 0;
    const stop = host.onBack(() => back++);
    const tries = () => (existsSync(join(dir, 'net', 'tries')) ? readFileSync(join(dir, 'net', 'tries'), 'utf8').split('\n').length - 1 : 0);
    writeFileSync(join(dir, 'net', 'down'), '');
    const before = tries();
    // not looked at yet: a card may take one, which is looked at again before it works there; the server does not wait for the host,
    // whose looks have started but answer only later
    expect(spaces.leasable()).toBe(true);
    expect(host.unreachable).toBe(false);
    // the looks find the host gone
    await until(() => !spaces.leasable());
    expect(host.unreachable).toBe(true);
    const looked = tries();
    expect(looked).toBeGreaterThan(before);
    // the next looks, at every change of the board, do not ask it again
    for (let i = 0; i < 5; i++) expect(spaces.leasable()).toBe(false);
    expect(tries()).toBe(looked);
    // a while later a look has it asked again, in the background
    rmSync(join(dir, 'net', 'down'));
    setSystemTime(new Date(Date.now() + RECHECK_MS));
    try {
      expect(spaces.leasable()).toBe(false);
    } finally {
      setSystemTime();
    }
    await until(() => spaces.leasable());
    expect(host.unreachable).toBe(false);
    expect(back).toBe(1);
    stop();
  });

  overSsh('fewer of them in the configuration: the others leave the pool once a card no longer holds them, and their folders go', async () => {
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 3, () => undefined)).toBeNull();
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    await spaces.lease(a, 'obeya/a').ready;
    writeFileSync(join(dir, 'far', '3', 'notes.txt'), 'mine\n');
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 0, () => undefined)).toBeNull();
    expect(spaces.list().map((w) => w.path)).toEqual([onHost(name, join(dir, 'far', '1'))]);
    // a free clean one goes from the host's disk; one with work not landed stays, and the pool says so. Each is
    // looked at through git over ssh, twice: a second here, over three on a busy CI runner
    await until(() => !existsSync(join(dir, 'far', '2')) && spaces.pool([]).some((h) => h.kept?.length), 10_000);
    expect(spaces.pool([]).find((h) => h.name === name)?.kept).toEqual([join(dir, 'far', '3')]);
    // while the host does not answer, the clone a card gives back stays; the next start looks again
    writeFileSync(join(dir, 'net', 'down'), '');
    spaces.release(a);
    expect(spaces.list()).toEqual([]);
    await Bun.sleep(100);
    expect(existsSync(join(dir, 'far', '1', '.git'))).toBe(true);
    rmSync(join(dir, 'net', 'down'));
    rmSync(join(dir, 'far', '3', 'notes.txt'));
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 0, () => undefined)).toBeNull();
    await until(() => !existsSync(join(dir, 'far', '1')) && !existsSync(join(dir, 'far', '3')) && !spaces.pool([]).some((h) => h.kept), 10_000);
  }, 30_000);

  overSsh('wait for a host that cannot be reached, and say why', async () => {
    writeFileSync(join(dir, 'net', 'down'), '');
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 1, () => undefined)).toContain('Connection refused');
    expect(spaces.list()).toEqual([]);
  });
});

describe('a Codex session on a host', () => {
  beforeEach(() => {
    // the host's Codex: the stand-in for its app server, where the installers put programs
    const bin = join(dir, 'net', 'home', '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, 'fixtures', 'fake-codex.ts'))} "$@"\n`, { mode: 0o755 });
    mkdirSync(join(dir, 'ws'));
    mkdirSync(join(dir, 'plugin', 'skills'), { recursive: true });
  });

  overSsh("runs Codex's app server there, with the plugin's skills as copied there, its hooks reaching Obeya here, and no Claude login", async () => {
    const events: AgentEvent[] = [];
    const requests = join(dir, 'requests.jsonl');
    const session = codexRuntime.start({ cwd: onHost(name, join(dir, 'ws')), system: '', tools: [], plugins: [join(dir, 'plugin')], env: { FAKE_CODEX_LOG: requests }, onEvent: (e) => events.push(e) }, 'run echo $CLAUDE_CODE_OAUTH_TOKEN there');
    await until(() => events.some((e) => e.type === 'idle'), 10_000);
    expect(events).toContainEqual({ type: 'text', text: 'ran: there' });
    const asked = readFileSync(requests, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method: string; params: any });
    expect(asked.find((r) => r.method === 'skills/extraRoots/set')!.params.extraRoots).toEqual([join(dir, 'net', 'home', '.obeya', 'remote', 'plugin', 'skills')]);
    expect(asked.find((r) => r.method === 'thread/start')!.params.cwd).toBe(join(dir, 'ws'));
    // the hook ran there and Obeya answered it: a long wait is refused there as here
    session.send('run sleep 45');
    await until(() => events.filter((e) => e.type === 'idle').length === 2, 10_000);
    expect(events).toContainEqual({ type: 'denied', name: 'Bash', input: { command: 'sleep 45' }, by: 'obeya' });
    // a screenshot goes there with the message, named by its path there
    writeFileSync(join(dir, 'shot.png'), 'png');
    session.send('look', [join(dir, 'shot.png')]);
    await until(() => events.filter((e) => e.type === 'idle').length === 3, 10_000);
    const images = join(dir, 'net', 'home', '.obeya', 'remote', 'images');
    expect(events).toContainEqual({ type: 'text', text: `echo: look | [image ${images}/shot.png]` });
    expect(readFileSync(join(images, 'shot.png'), 'utf8')).toBe('png');
    expect(log()).not.toContain('sk-claude');
    session.close();
    await session.done;
  }, 20_000);

  overSsh('a host unreachable before Codex starts there loses the connection rather than failing the session', async () => {
    writeFileSync(join(dir, 'net', 'down'), '');
    const events: AgentEvent[] = [];
    const session = codexRuntime.start({ cwd: onHost(name, join(dir, 'ws')), system: '', tools: [], onEvent: (e) => events.push(e) }, 'hello');
    await session.done;
    expect(events).toEqual([{ type: 'lost', message: `the connection to ${name} was lost` }]);
  });

  overSsh("a Codex thread's transcript there is found by its id for the work retrospective", async () => {
    const id = '01a1a634-1526-77c0-b3ba-30c136b024f5';
    const day = join(dir, 'net', 'home', '.codex', 'sessions', '2026', '11', '04');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-04T11-56-33-${id}.jsonl`), '{"type":"session_meta"}\n');
    const file = await host.transcript(`codex:${id}`, join(dir, 'ws'));
    expect(readFileSync(file!, 'utf8')).toBe('{"type":"session_meta"}\n');
    expect(await host.transcript('codex:../../x', join(dir, 'ws'))).toBeNull();
  });
});

describe("Claude Code on a host", () => {
  /** The stand-in's state there (`fixtures/fake-claude.ts`). */
  let state: string;
  beforeEach(() => {
    const bin = join(dir, 'net', 'home', '.local', 'bin');
    state = join(dir, 'net', 'home', '.fake-claude');
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, 'fixtures', 'fake-claude.ts'))} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(state, 'version'), '2.1.300\n');
  });

  overSsh('says its version there and the channel it updates from; null where it is not installed', async () => {
    expect(await host.claude()).toEqual({ version: '2.1.300', channel: 'latest' });
    // the stand-in's host has this machine's environment, with the tests' own CLAUDE_CONFIG_DIR
    const config = process.env.CLAUDE_CONFIG_DIR ?? join(dir, 'net', 'home', '.claude');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    expect(await host.claude()).toEqual({ version: '2.1.300', channel: 'stable' });
    // as a shell says of a program it does not find (this machine, the stand-in's host, may have one on its PATH)
    writeFileSync(join(dir, 'net', 'home', '.local', 'bin', 'claude'), '#!/bin/sh\nexit 127\n');
    expect(await host.claude()).toBeNull();
    writeFileSync(join(dir, 'net', 'down'), '');
    await expect(host.claude()).rejects.toThrow('Connection refused');
  });

  overSsh('is updated there, and says why where that fails', async () => {
    writeFileSync(join(state, 'newest'), '2.1.338');
    await host.updateClaude();
    expect((await host.claude())?.version).toBe('2.1.338');
    writeFileSync(join(state, 'update-fails'), 'Error: no network');
    await expect(host.updateClaude()).rejects.toThrow('claude update exited with 1: Error: no network');
  });

  overSsh('lists its models there, from a session started over the connection with the Claude login', async () => {
    writeFileSync(join(state, 'models.json'), JSON.stringify([{ value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'claude-fable-5-2' }]));
    expect(await claudeModels('/', host)).toEqual([{ value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'claude-fable-5-2' }]);
    expect(log()).not.toContain('sk-claude');
  }, 20_000);
});

describe('Codex on a host', () => {
  /** The stand-in's state there (`fixtures/fake-codex.ts`). */
  let state: string;
  let bin: string;
  const fake = join(import.meta.dir, 'fixtures', 'fake-codex.ts');
  beforeEach(() => {
    bin = join(dir, 'net', 'home', '.local', 'bin');
    state = join(dir, 'net', 'home', '.fake-codex');
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(state, 'version'), '0.159.2\n');
  });

  overSsh('says its version there; null where it is not installed', async () => {
    expect(await host.codex()).toEqual({ version: '0.159.2' });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 127\n');
    expect(await host.codex()).toBeNull();
    writeFileSync(join(dir, 'net', 'down'), '');
    await expect(host.codex()).rejects.toThrow('Connection refused');
  });

  overSsh('is updated there with `codex update`, and says why where that fails', async () => {
    writeFileSync(join(state, 'newest'), '0.167.0');
    await host.updateCodex();
    expect(await host.codex()).toEqual({ version: '0.167.0' });
    writeFileSync(join(state, 'update-fails'), 'Error: no network');
    await expect(host.updateCodex()).rejects.toThrow('codex update exited with 1: Error: no network');
  });

  overSsh('older than `codex update`, is updated by the package manager it lives in, and else says so', async () => {
    writeFileSync(join(state, 'old'), '');
    // installed by npm: its package's script, linked onto the PATH
    const pkg = join(dir, 'net', 'home', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(pkg, { recursive: true });
    renameSync(join(bin, 'codex'), join(pkg, 'codex.js'));
    symlinkSync(join(pkg, 'codex.js'), join(bin, 'codex'));
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" > ${JSON.stringify(join(state, 'npm'))}\n`, { mode: 0o755 });
    await host.updateCodex();
    expect(readFileSync(join(state, 'npm'), 'utf8').trim()).toBe('install -g @openai/codex@latest');
    // a copy of its own, which no package manager knows
    rmSync(join(bin, 'codex'));
    copyFileSync(join(pkg, 'codex.js'), join(bin, 'codex'));
    await expect(host.updateCodex()).rejects.toThrow(/Codex at .* is too old to update itself/);
  });
});

describe('a worker on a host', () => {
  overSsh('whose connection drops resumes its session once the host answers, with the message it had not taken', async () => {
    gitRepo(join(dir, 'main'));
    const origin = join(dir, 'origin.git');
    gitClone(join(dir, 'main'), origin, { bare: true });
    const store = new Store(':memory:');
    const board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: join(dir, 'main'), branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: join(dir, 'ws') });
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 1, () => undefined)).toBeNull();
    const runtime = new FakeRuntime();
    const workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, workspaces: 'clones', land: 'pr' }, reconnectMs: 20 });
    const card = board.create({ title: 'Weit weg', x: 0, y: 0 });
    await workers.start(card.id);
    const first = runtime.last;
    expect(first.spec.cwd).toBe(onHost(name, join(dir, 'far', '1')));
    first.emit({ type: 'session', id: 's1' });
    first.emit({ type: 'tool', name: 'Bash', input: { command: 'ls' } });
    first.emit({ type: 'idle' });
    // the owner writes, and the connection drops before the worker takes the message
    workers.message(card.id, 'Bitte auch CSV.');
    writeFileSync(join(dir, 'net', 'down'), '');
    first.emit({ type: 'lost', message: 'the connection was lost' });
    expect(board.events(card.id).some((e) => e.text.includes(`Die Verbindung zu ${name} ist weg`))).toBe(true);
    await Bun.sleep(80);
    expect(runtime.sessions).toHaveLength(1);
    rmSync(join(dir, 'net', 'down'));
    await until(() => runtime.sessions.length === 2);
    expect(runtime.last.spec.resume).toBe('s1');
    expect(runtime.last.inbox[0]).toContain('Bitte auch CSV.');
    // at work when it dropped, it hears what happened
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'ls' } });
    runtime.last.emit({ type: 'lost', message: 'the connection was lost' });
    await until(() => runtime.sessions.length === 3);
    expect(runtime.last.inbox[0]).toContain('dropped');
    // its turn ended, its background work (a render) running: that went with the session too
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'bun render.ts' } });
    runtime.last.emit({ type: 'idle', background: 1 });
    runtime.last.emit({ type: 'lost', message: 'the connection was lost' });
    await until(() => runtime.sessions.length === 4);
    expect(runtime.last.inbox[0]).toContain('dropped');
    // its demo is made there, and served from its copy here
    const demo = join(dir, 'far', 'demo');
    mkdirSync(demo);
    writeFileSync(join(demo, 'demo.mp4'), 'video');
    writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEins.\n');
    expect(await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: { dir: demo, chapters: ['Eins'] } })).toContain('End your turn');
    const shown = JSON.parse(board.row(card.id).demo!) as { dir: string };
    expect(shown.dir).toBe(host.localCopy(demo));
    expect(readFileSync(join(shown.dir, 'demo.mp4'), 'utf8')).toBe('video');
    expect(await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: { dir: join(dir, 'far', 'none'), chapters: [] } })).toContain('could not be copied');
    // waiting for the owner, it takes in their words and waits for its background work, when the connection drops
    runtime.last.emit({ type: 'idle' });
    workers.message(card.id, 'Noch ein Satz im Video.');
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'bun render.ts' } });
    runtime.last.emit({ type: 'idle', background: 1 });
    runtime.last.emit({ type: 'lost', message: 'the connection was lost' });
    await until(() => runtime.sessions.length === 5);
    expect(runtime.last.inbox[0]).toContain('dropped');
    workers.shutdown();
  }, 20_000);

  overSsh('that could not start there, as the host did not answer, starts once it does, with its task', async () => {
    gitRepo(join(dir, 'main'));
    const origin = join(dir, 'origin.git');
    gitClone(join(dir, 'main'), origin, { bare: true });
    const store = new Store(':memory:');
    const board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: join(dir, 'main'), branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: join(dir, 'ws') });
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 1, () => undefined)).toBeNull();
    const runtime = new FakeRuntime();
    const workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, workspaces: 'clones', land: 'pr' }, reconnectMs: 20 });
    const card = board.create({ title: 'Weit weg', body: 'Eine Wochenansicht.', x: 0, y: 0 });
    await workers.start(card.id);
    // the host goes before the session reports an id: getting it ready failed
    writeFileSync(join(dir, 'net', 'down'), '');
    runtime.last.emit({ type: 'lost', message: 'the connection was lost' });
    expect(board.events(card.id).some((e) => e.text.includes(`Die Verbindung zu ${name} ist weg`))).toBe(true);
    await Bun.sleep(80);
    expect(runtime.sessions).toHaveLength(1);
    rmSync(join(dir, 'net', 'down'));
    await until(() => runtime.sessions.length === 2);
    expect(runtime.last.spec.resume).toBeUndefined();
    expect(runtime.last.inbox[0]).toContain('Eine Wochenansicht.');
    workers.shutdown();
  }, 20_000);
});

describe('the app of a card on a host', () => {
  let board: Board;
  let runtime: FakeRuntime;
  let workers: Workers;
  let spaces: Workspaces;
  let apps: ReturnType<typeof Bun.serve>[];
  /** An app running there (the stand-in's host is this machine), answering with its name. */
  const app = (name: string) => {
    const a = Bun.serve({ port: 0, fetch: () => new Response(name) });
    apps.push(a);
    return `http://localhost:${a.port}/`;
  };
  const pids = (file: string) => (existsSync(join(dir, 'net', file)) ? readFileSync(join(dir, 'net', file), 'utf8').trim().split('\n').map(Number) : []);
  const forwards = () => pids('forwards');
  const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.text(), () => null);
  const closed = (url: string) => until(async () => (await answers(url)) === null);

  beforeEach(async () => {
    apps = [];
    gitRepo(join(dir, 'main'));
    const origin = join(dir, 'origin.git');
    gitClone(join(dir, 'main'), origin, { bare: true });
    const store = new Store(':memory:');
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: join(dir, 'main'), branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: join(dir, 'ws') });
    expect(await spaces.ensureHostClones(host, join(dir, 'far'), origin, 1, () => undefined)).toBeNull();
    runtime = new FakeRuntime();
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, workspaces: 'clones', land: 'pr' } });
  });
  afterEach(() => {
    workers.shutdown();
    for (const a of apps) a.stop(true);
  });

  overSsh('opens through a forward of its port, which ends once the card no longer offers it', async () => {
    const card = board.create({ title: 'Weit weg', x: 0, y: 0 });
    await workers.start(card.id);
    expect(runtime.last.inbox[0]).toContain("Obeya forwards that address's port, and only that one");
    const first = app('erste');
    runtime.last.call('app_running', { url: `${first}seite?x=1` });
    expect(await workers.appUp(card.id)).toBe(true);
    const opened = (await workers.openApp(card.id))!;
    expect(opened).toMatch(/^http:\/\/localhost:\d+\/seite\?x=1$/);
    expect(new URL(opened).port).not.toBe(new URL(first).port);
    expect(await answers(opened)).toBe('erste');
    // asked again, the same forward
    expect(await workers.openApp(card.id)).toBe(opened);
    expect(forwards()).toHaveLength(1);
    // a new address: the forward goes there instead
    runtime.last.call('app_running', { url: app('zweite') });
    await closed(opened);
    const second = (await workers.openApp(card.id))!;
    expect(await answers(second)).toBe('zweite');
    // the worker stops the app
    runtime.last.call('app_running', { url: '' });
    await closed(second);
    expect(await workers.appUp(card.id)).toBe(false);
    expect(await workers.openApp(card.id)).toBeNull();
    // the workspace goes with the card's work
    runtime.last.call('app_running', { url: app('dritte') });
    const third = (await workers.openApp(card.id))!;
    expect(await answers(third)).toBe('dritte');
    await workers.stop(card.id);
    await closed(third);
    expect(forwards()).toHaveLength(3);
  }, 20_000);

  overSsh('is forwarded again after its connection dropped, on the same port, and not while the host does not answer', async () => {
    const card = board.create({ title: 'Weit weg', x: 0, y: 0 });
    await workers.start(card.id);
    runtime.last.call('app_running', { url: app('da') });
    const opened = (await workers.openApp(card.id))!;
    process.kill(forwards()[0]!, 'SIGTERM');
    await closed(opened);
    writeFileSync(join(dir, 'net', 'down'), '');
    expect(await workers.appUp(card.id)).toBe(false);
    rmSync(join(dir, 'net', 'down'));
    expect(await workers.openApp(card.id)).toBe(opened);
    expect(await answers(opened)).toBe('da');
    // its port gone before Obeya hears that its connection ended (which comes a while later)
    process.kill(pids('proxies').at(-1)!, 'SIGTERM');
    await closed(opened);
    expect(await workers.openApp(card.id)).toBe(opened);
    expect(await answers(opened)).toBe('da');
    // Obeya stops, and the forward with it
    workers.shutdown();
    await closed(opened);
  }, 20_000);

  overSsh('ends when the card is parked', async () => {
    workers.shutdown();
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, workspaces: 'clones', land: 'pr', app: { run: 'true', stop: 'true' } }, parkGrace: 10, tryGrace: 0 });
    const card = board.create({ title: 'Weit weg', x: 0, y: 0 });
    await workers.start(card.id);
    runtime.last.call('app_running', { url: app('da') });
    const opened = (await workers.openApp(card.id))!;
    expect(await answers(opened)).toBe('da');
    runtime.last.call('ask', { question: 'Welche Farbe?' });
    runtime.last.emit({ type: 'idle' });
    await until(() => board.row(card.id).parked, 10_000);
    await closed(opened);
  }, 20_000);
});
