import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineView } from '../core/types';
import { Board } from './board';
import type { CanvasRuntime } from './canvas';
import { Config } from './config';
import { Store } from './db';
import { CLONES, cloneName, machineHint, MachineSetup, runnable, WELCOME_FILE, welcome } from './machine';
import { gitRepo } from './testing';

let dir: string;
let home: string;
let bin: string;
let store: Store;
let restarts: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-machine-'));
  home = join(dir, 'home');
  bin = join(dir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  store = new Store(':memory:');
  restarts = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A program on the test's PATH that answers as the script says. */
function fake(name: string, script: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

const config = () =>
  new Config({
    file: join(home, 'canvases.json'),
    source: 'file',
    started: [],
    store,
    running: () => [],
    server: { port: 4417, home, permissionMode: 'auto' },
    restart: () => void restarts++,
  });

const setup = (o: { compiled?: boolean; env?: Record<string, string> } = {}) =>
  new MachineSetup({ home, config: config(), env: { PATH: bin, ...o.env }, platform: 'linux', arch: 'x64', compiled: o.compiled ?? true, restarts: true });

const section = (v: MachineView, id: string) => v.sections.find((s) => s.id === id)!;

describe('what Obeya needs on this machine', () => {
  test('finds Claude Code, its login, git and gh, and says what is missing with how to get it', async () => {
    fake('claude', 'case "$1" in --version) echo "2.1.300 (Claude Code)";; auth) echo \'{"loggedIn": false}\'; exit 1;; esac');
    fake('git', 'case "$1" in --version) echo "git version 2.45.0";; config) exit 1;; esac');
    const v = await setup().view();
    expect(section(v, 'needed').items).toEqual([
      { id: 'claude', state: 'ok', found: '2.1.300' },
      { id: 'claudeLogin', state: 'missing', install: { commands: ['claude auth login'] }, act: 'login' },
      { id: 'git', state: 'ok', found: '2.45.0' },
      expect.objectContaining({ id: 'gitUser', state: 'missing', act: 'identity' }),
    ]);
    // gh is not there: its command for this Linux, run by hand; the login waits for it
    const pr = section(v, 'pr').items;
    expect(pr[0]).toMatchObject({ id: 'gh', state: 'missing', install: { url: 'https://cli.github.com' } });
    expect(pr[0]!.act).toBeUndefined();
    expect(pr[1]).toEqual({ id: 'ghLogin', state: 'missing' });
    expect(v.checkedClaude).toMatch(/^\d+\.\d+\.\d+$/);
    // what demos need is checked too; without a voice check there is no voice section
    expect(v.sections.map((s) => s.id)).toEqual(['needed', 'pr', 'demos']);
  });

  test('offers the official installer for a missing Claude Code, and the logins once logged in', async () => {
    fake('git', 'case "$1" in --version) echo "git version 2.45.0";; config) echo "Ada";; esac');
    fake('gh', 'case "$1" in --version) echo "gh version 2.60.0 (2024-10-01)";; auth) echo "  ✓ Logged in to github.com account ada (keyring)";; esac');
    // not where the official installer puts it either
    const v = await setup({ env: { OBEYA_CLAUDE: join(dir, 'none', 'claude') } }).view();
    const needed = section(v, 'needed').items;
    expect(needed[0]).toMatchObject({ id: 'claude', state: 'missing', install: { commands: ['curl -fsSL https://claude.ai/install.sh | bash'] }, act: 'install' });
    expect(needed[1]).toEqual({ id: 'claudeLogin', state: 'missing' });
    expect(needed[3]).toEqual({ id: 'gitUser', state: 'ok', found: 'Ada <Ada>' });
    expect(section(v, 'pr').items).toEqual([
      { id: 'gh', state: 'ok', found: '2.60.0' },
      { id: 'ghLogin', state: 'ok', found: 'ada' },
    ]);
  });

  test("from the checkout, the agents' Claude Code is the Agent SDK's", async () => {
    const v = await setup({ compiled: false }).view();
    expect(section(v, 'needed').items[0]).toEqual({ id: 'claude', state: 'ok', found: `${v.checkedClaude} (Agent SDK)` });
  });

  test('installs at a click only what needs no password', () => {
    fake('brew', 'exit 0');
    const env = { PATH: bin };
    expect(runnable('curl -LsSf https://astral.sh/uv/install.sh | sh', env, 'linux')).toEqual(['sh', '-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
    expect(runnable('irm https://claude.ai/install.ps1 | iex', env, 'win32')).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
    expect(runnable('brew install gh', env, 'darwin')).toEqual([join(bin, 'brew'), 'install', 'gh']);
    expect(runnable('sudo apt install gh', env, 'linux')).toBeNull();
    // winget is not on this PATH
    expect(runnable('winget install --id GitHub.cli -e', env, 'win32')).toBeNull();
  });

  test('says how to install git and gh on each platform', () => {
    expect(machineHint('git', 'darwin', null, false).commands).toEqual(['xcode-select --install']);
    expect(machineHint('git', 'darwin', null, true).commands).toEqual(['brew install git']);
    expect(machineHint('gh', 'win32', null, false).commands).toEqual(['winget install --id GitHub.cli -e']);
    expect(machineHint('gh', 'linux', 'pacman', false).commands).toEqual(['sudo pacman -S github-cli']);
    expect(machineHint('git', 'linux', null, false).commands).toEqual([]);
    expect(machineHint('claude', 'win32', null, false).commands).toEqual(['irm https://claude.ai/install.ps1 | iex']);
  });

  test("sets git's name and e-mail as the owner gives them", async () => {
    const log = join(dir, 'git.log');
    fake('git', `echo "$@" >> ${log}; case "$1" in --version) echo "git version 2.45.0";; config) [ $# -gt 3 ] || exit 1;; esac`);
    await setup().identity({ name: ' Ada Lovelace ', email: 'ada@example.com' });
    expect(readFileSync(log, 'utf8')).toContain('config --global user.name Ada Lovelace\nconfig --global user.email ada@example.com\n');
  });
});

describe('the first canvas', () => {
  test('a repository folder becomes a canvas with clones for its adapter, and Obeya starts again', async () => {
    const repo = gitRepo(join(dir, 'shop'));
    const out = await setup().canvas({ path: repo });
    expect(out).toEqual({ canvas: 'shop', restarting: true });
    expect(restarts).toBe(1);
    expect(JSON.parse(readFileSync(join(home, 'canvases.json'), 'utf8'))).toEqual([{ repos: [{ path: repo, clones: CLONES }] }]);
    expect(readFileSync(join(home, WELCOME_FILE), 'utf8')).toBe('shop');
  });

  test('a folder without a repository is refused', async () => {
    mkdirSync(join(dir, 'empty'));
    await expect(setup().canvas({ path: join(dir, 'empty') })).rejects.toMatchObject({ code: 'notRepo' });
    expect(existsSync(join(home, 'canvases.json'))).toBe(false);
  });

  test('a clone goes into a folder of its name and becomes the canvas', async () => {
    const origin = gitRepo(join(dir, 'origin', 'shop'));
    const s = new MachineSetup({ home, config: config(), restarts: true });
    await s.canvas({ clone: origin, into: join(dir, 'code') });
    let v = await s.view();
    for (let i = 0; v.job?.running && i < 100; i++) await Bun.sleep(50), (v = await s.view());
    expect(v.job).toMatchObject({ kind: 'clone', running: false, canvas: 'shop' });
    expect(existsSync(join(dir, 'code', 'shop', '.git'))).toBe(true);
    // the folder is there now: a second clone into it is refused
    await expect(new MachineSetup({ home, config: config(), restarts: true }).canvas({ clone: origin, into: join(dir, 'code') })).rejects.toMatchObject({ code: 'cloneTarget' });
  });

  test('names a clone after its repository', () => {
    expect(cloneName('owner/shop')).toBe('shop');
    expect(cloneName('https://github.com/owner/shop.git')).toBe('shop');
    expect(cloneName('git@github.com:owner/shop.git')).toBe('shop');
    expect(cloneName('/srv/git/shop/')).toBe('shop');
  });

  test('the canvas the assistant created gets one first card that says what to try', () => {
    const board = new Board(store, { id: 'shop', name: 'Shop', repos: [{ id: 'shop', name: 'Shop', path: '/r', branch: 'main' }] }, () => []);
    const canvas = { id: 'shop', board } as unknown as CanvasRuntime;
    writeFileSync(join(home, WELCOME_FILE), 'shop');
    welcome(home, [canvas]);
    welcome(home, [canvas]);
    const cards = board.snapshot().items.filter((i) => i.kind === 'task');
    expect(cards.map((c) => c.title)).toEqual([board.t.welcome.title]);
    expect(existsSync(join(home, WELCOME_FILE))).toBe(false);
  });
});
