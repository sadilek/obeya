import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endProcessesIn, parsePosix, type Running, runsFrom } from './folder-processes';
import { alive, leftBehind } from './testing';

const proc = (o: Partial<Running>): Running => ({ pid: 1, ppid: 0, exe: '', cmd: '', cwd: '', ...o });

describe('runsFrom', () => {
  const dir = 'D:\\obeya\\workspaces\\campus\\3c79a644';
  test('a program in the folder, a working directory in it, a script it names', () => {
    expect(runsFrom(proc({ exe: `${dir}\\pocketbase\\pocketbase.exe` }), dir, true)).toBe(true);
    expect(runsFrom(proc({ exe: 'C:\\Program Files\\nodejs\\node.exe', cwd: `${dir}\\server\\`, cmd: 'node index.mjs' }), dir, true)).toBe(true);
    expect(runsFrom(proc({ exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: `"C:\\Program Files\\nodejs\\node.exe" ${dir.replace(/\\/g, '/')}/node_modules/vite/bin/vite.js` }), dir, true)).toBe(true);
    expect(runsFrom(proc({ cwd: dir.toUpperCase() }), dir, true)).toBe(true);
  });

  test('not a folder whose name begins the same, nor one that names it in passing', () => {
    expect(runsFrom(proc({ cwd: `${dir}0\\` }), dir, true)).toBe(false);
    expect(runsFrom(proc({ cmd: `grep x ${dir}0\\file` }), dir, true)).toBe(false);
    expect(runsFrom(proc({ cmd: `echo foo${dir}` }), dir, true)).toBe(false);
    expect(runsFrom(proc({ cwd: '/home/me/ws/1/', cmd: 'vite' }), '/home/me/ws/1', false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/home/me/ws/10' }), '/home/me/ws/1', false)).toBe(false);
  });
});

test('parsePosix reads ps, /proc and lsof', () => {
  const out = [
    '  101     1 /usr/bin/node /srv/ws/1/node_modules/.bin/vite',
    '  102     1 node index.mjs',
    '  103   102 -bash',
    '--- dirs',
    'lrwxrwxrwx 1 me me 0 Nov  6 10:00 /proc/102/cwd -> /srv/ws/1/server',
    'lrwxrwxrwx 1 me me 0 Nov  6 10:00 /proc/101/exe -> /usr/bin/node (deleted)',
    'p103',
    'fcwd',
    'n/home/me',
    '',
  ].join('\n');
  expect(parsePosix(out)).toEqual([
    { pid: 101, ppid: 1, exe: '/usr/bin/node', cmd: '/usr/bin/node /srv/ws/1/node_modules/.bin/vite', cwd: '' },
    { pid: 102, ppid: 1, exe: '', cmd: 'node index.mjs', cwd: '/srv/ws/1/server' },
    { pid: 103, ppid: 102, exe: '', cmd: '-bash', cwd: '/home/me' },
  ]);
});

test('ends what runs from the folder, and nothing outside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'strays-'));
  const ws = join(root, 'ws');
  const other = join(root, 'ws2');
  mkdirSync(join(ws, 'server'), { recursive: true });
  mkdirSync(other);
  const inside = await leftBehind(join(ws, 'server'));
  const outside = await leftBehind(other);
  try {
    expect(alive(inside)).toBe(true);
    expect(await endProcessesIn(ws)).toEqual([inside]);
    for (let i = 0; i < 50 && alive(inside); i++) await Bun.sleep(100);
    expect(alive(inside)).toBe(false);
    expect(alive(outside)).toBe(true);
  } finally {
    // the run's temp directory goes after the tests: on Windows not while a process works in it
    for (const pid of [inside, outside]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 50 && (alive(inside) || alive(outside)); i++) await Bun.sleep(100);
    // Windows lets go of a dead process's working directory a moment later
    rmSync(root, { recursive: true, force: true, maxRetries: 20 });
  }
}, 30_000);
