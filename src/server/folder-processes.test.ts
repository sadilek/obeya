import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endProcessesIn, interactive, listing, parsePosix, type Running, runsFrom, toEnd } from './folder-processes';
import { alive, leftBehind } from './testing';

const proc = (o: Partial<Running>): Running => ({ pid: 1, ppid: 0, exe: '', cmd: '', cwd: '', ...o });

describe('runsFrom', () => {
  const dir = 'D:\\obeya\\workspaces\\campus\\3c79a644';
  test('a program in the folder, a working directory in it, a script it names', () => {
    expect(runsFrom(proc({ exe: `${dir}\\pocketbase\\pocketbase.exe` }), [dir], true)).toBe(true);
    expect(runsFrom(proc({ exe: 'C:\\Program Files\\nodejs\\node.exe', cwd: `${dir}\\server\\`, cmd: 'node index.mjs' }), [dir], true)).toBe(true);
    expect(runsFrom(proc({ exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: `"C:\\Program Files\\nodejs\\node.exe" ${dir.replace(/\\/g, '/')}/node_modules/vite/bin/vite.js` }), [dir], true)).toBe(true);
    expect(runsFrom(proc({ cwd: dir.toUpperCase() }), [dir], true)).toBe(true);
  });

  test('not a folder whose name begins the same, nor one that names it in passing', () => {
    expect(runsFrom(proc({ cwd: `${dir}0\\` }), [dir], true)).toBe(false);
    expect(runsFrom(proc({ cmd: `grep x ${dir}0\\file` }), [dir], true)).toBe(false);
    expect(runsFrom(proc({ cmd: `echo foo${dir}` }), [dir], true)).toBe(false);
    expect(runsFrom(proc({ cwd: '/home/me/ws/1/', cmd: 'vite' }), ['/home/me/ws/1'], false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/home/me/ws/10' }), ['/home/me/ws/1'], false)).toBe(false);
  });

  test('a command line that only names a file there is not the folder\'s: an editor, an ssh session', () => {
    const ws = '/home/me/ws/1';
    expect(runsFrom(proc({ cwd: '/home/me', cmd: `vim ${ws}/app.ts /home/me/notes.md` }), [ws], false)).toBe(false);
    expect(runsFrom(proc({ cwd: '/home/me', cmd: `ssh other 'cd ${ws} && node server.js'` }), [ws], false)).toBe(false);
    expect(runsFrom(proc({ cwd: '/', cmd: `${ws}/bin/server --port 3000` }), [ws], false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/', cmd: `node --inspect ${ws}/server.js` }), [ws], false)).toBe(true);
    expect(runsFrom(proc({ cwd: 'C:\\Users\\me', cmd: `"C:\\Program Files\\nodejs\\node.exe" "${dir}\\server.mjs"` }), [dir], true)).toBe(true);
  });

  test('a folder whose path has a space, which ps gives without quotes', () => {
    const ws = '/home/me/My Work/1';
    expect(runsFrom(proc({ cwd: '/', cmd: `node ${ws}/server.js` }), [ws], false)).toBe(true);
  });

  test('the folder by the path its links lead to (macOS: /var is /private/var)', () => {
    const dirs = ['/var/folders/x/ws', '/private/var/folders/x/ws'];
    expect(runsFrom(proc({ cwd: '/private/var/folders/x/ws' }), dirs, false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/', cmd: 'node /private/var/folders/x/ws/server.js' }), dirs, false)).toBe(true);
  });

  test("a runtime's words are what it runs, after flags that take one of their own", () => {
    const ws = '/home/me/ws/1';
    expect(runsFrom(proc({ cwd: '/', cmd: `node --require /opt/preload.js ${ws}/server.js` }), [ws], false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/', cmd: `node --title myapp ${ws}/server.js` }), [ws], false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/', cmd: `node --import=${ws}/setup.mjs app` }), [ws], false)).toBe(true);
    expect(runsFrom(proc({ cwd: '/', cmd: 'node /opt/other/server.js' }), [ws], false)).toBe(false);
  });

  test("a terminal opened in the folder is someone's, a shell running a script there the app's", () => {
    const ws = '/home/me/ws/1';
    for (const cmd of ['-zsh', '/bin/bash -l', 'zsh -i', '/bin/bash --init-file /dev/null -i', '"C:\\Windows\\system32\\cmd.exe"', 'pwsh.exe -NoLogo']) expect(interactive(proc({ cmd }))).toBe(true);
    for (const cmd of ['sh -c npm run dev', 'bash /srv/run.sh', 'sh ./run.sh', 'cmd.exe /c start.cmd', 'node index.mjs']) expect(interactive(proc({ cmd }))).toBe(false);
    expect(runsFrom(proc({ cwd: ws, cmd: '-zsh' }), [ws], false)).toBe(false);
    expect(runsFrom(proc({ cwd: ws, cmd: 'sh ./run.sh' }), [ws], false)).toBe(true);
  });
});

test("a host's listing: the folder's real path, the listing's own shell, though its command line in ps names the markers again", () => {
  const out = ['/private/srv/ws/1', '--- self 50', `   50     9 sh -c cd /srv/ws/1; echo "--- self $$"; ps; echo '--- dirs'`, '   51    50 ps axww', '--- dirs', 'p50', 'n/', ''].join('\n');
  expect(listing(out)).toEqual({
    real: '/private/srv/ws/1',
    self: 50,
    all: [
      { pid: 50, ppid: 9, exe: '', cmd: `sh -c cd /srv/ws/1; echo "--- self $$"; ps; echo '--- dirs'`, cwd: '/' },
      { pid: 51, ppid: 50, exe: '', cmd: 'ps axww', cwd: '' },
    ],
  });
});

test('what a process from the folder started ends with it, wherever it works; Obeya\'s own line stays', () => {
  const ws = '/home/me/ws/1';
  const all = [
    proc({ pid: 10, ppid: 1, cmd: 'obeya', cwd: '/home/me' }),
    proc({ pid: 11, ppid: 10, cmd: 'claude', cwd: ws }),
    proc({ pid: 20, ppid: 1, cmd: 'node server.js', cwd: ws }),
    proc({ pid: 21, ppid: 20, cmd: '/usr/bin/postgres -D /tmp/db', cwd: '/tmp' }),
    proc({ pid: 22, ppid: 21, cmd: 'postgres: writer', cwd: '/tmp' }),
    proc({ pid: 30, ppid: 1, cmd: 'node other.js', cwd: '/home/me/ws/2' }),
  ];
  expect(toEnd(all, [ws], false, new Set([10, 11])).toSorted()).toEqual([20, 21, 22]);
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
    '--- programs',
    '  103 /bin/bash',
    '',
  ].join('\n');
  expect(parsePosix(out)).toEqual([
    { pid: 101, ppid: 1, exe: '/usr/bin/node', cmd: '/usr/bin/node /srv/ws/1/node_modules/.bin/vite', cwd: '' },
    { pid: 102, ppid: 1, exe: '', cmd: 'node index.mjs', cwd: '/srv/ws/1/server' },
    { pid: 103, ppid: 102, exe: '/bin/bash', cmd: '-bash', cwd: '/home/me' },
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
