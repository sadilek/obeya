import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim, INSTANCE_FILE, recorded, release, restarting, running } from './instance';
import { gitRepo, until } from './testing';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-instance-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (pid: number, port: number) => ({ pid, port, url: `http://127.0.0.1:${port}`, version: '0.1.0', app: false });

test('an entry is given up only by the process that wrote it', () => {
  claim(dir, entry(4242, 4417));
  expect(recorded(dir)).toEqual(entry(4242, 4417));
  release(dir, 1);
  expect(recorded(dir)?.pid).toBe(4242);
  release(dir, 4242);
  expect(recorded(dir)).toBeNull();
});

test('runs: a live process whose URL answers; not a dead one, not this one, nor a live one that stays silent', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json([]) });
  const other = Bun.spawn(['sleep', '30']);
  try {
    claim(dir, entry(other.pid, server.port!));
    expect(await running(dir)).toMatchObject({ pid: other.pid });
    // the server itself finds its own entry, which is no other Obeya
    expect(await running(dir, other.pid)).toBeNull();
    server.stop(true);
    // alive but silent past the grace, as when another program got the pid of an Obeya long gone
    expect(await running(dir, process.pid, 300)).toBeNull();
    other.kill();
    await other.exited;
    claim(dir, entry(other.pid, server.port!));
    expect(await running(dir)).toBeNull();
  } finally {
    server.stop(true);
    other.kill();
  }
});

test('an Obeya starting again is waited for past the grace, until its server answers', async () => {
  const other = Bun.spawn(['sleep', '30']);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    claim(dir, entry(other.pid, 1));
    restarting(dir, 1);
    // only the supervisor that wrote the entry marks it
    expect(recorded(dir)?.restarting).toBeUndefined();
    restarting(dir, other.pid);
    expect(recorded(dir)?.restarting).toBe(true);
    const found = running(dir, process.pid, 100, 5000);
    await Bun.sleep(400);
    // the restarted server answers on another port and writes its own entry
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json([]) });
    claim(dir, entry(other.pid, server.port!));
    expect(await found).toMatchObject({ pid: other.pid, port: server.port });
    // one that does not come back counts as gone once the longer grace is over
    server.stop(true);
    restarting(dir, other.pid);
    expect(await running(dir, process.pid, 100, 300)).toBeNull();
  } finally {
    server?.stop(true);
    other.kill();
  }
});

test('a second Obeya on the same home ends and says where the first runs; the first stops over HTTP and gives up its entry', async () => {
  const repo = gitRepo(join(dir, 'repo'));
  const home = join(dir, 'home');
  const env = { ...process.env, OBEYA_HOME: home, OBEYA_SUPERVISED: '' };
  const main = join(import.meta.dir, 'main.ts');
  const first = Bun.spawn([process.execPath, main, repo, '--port', '0', '--idle-workers'], { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    await until(() => recorded(home), 20_000);
    const i = recorded(home)!;
    // the supervisor, which stays across restarts
    expect(i.pid).toBe(first.pid);
    expect((await fetch(`${i.url}/api/canvases`)).ok).toBe(true);

    const second = Bun.spawn([process.execPath, main, repo, '--port', '0'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await second.exited).toBe(1);
    expect(await new Response(second.stderr).text()).toContain(`already runs on ${home}, at ${i.url}`);

    expect(await (await fetch(`${i.url}/api/stop`, { method: 'POST' })).json()).toEqual({ stopping: true });
    expect(await first.exited).toBe(0);
    expect(existsSync(join(home, INSTANCE_FILE))).toBe(false);
  } finally {
    first.kill('SIGKILL');
  }
}, 30_000);
