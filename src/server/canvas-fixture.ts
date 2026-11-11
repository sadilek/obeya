// What the tests of a one-repository canvas share: a checkout `main` in a fresh `dir`, a store, a
// fake runtime and the canvas on them, set up afresh for each test by `eachTest`. Tests read the
// bindings below; one that starts the canvas again (Obeya started anew, another setting) does so
// with `restart`, one that needs another canvas beside it with `start`.

import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasConfig, RepoConfig } from '../core/types';
import { type CanvasDeps, CanvasRuntime } from './canvas';
import type { Focus, Heard, Input } from './commands';
import { Store } from './db';
import { FakeRuntime, type FakeSession, gitRepo, handedOverOn, noForge, removeDir } from './testing';

export let dir: string;
/** The checkout on the canvas. */
export let main: string;
export let store: Store;
export let runtime: FakeRuntime;
/** The canvas `open` started last. */
export let canvas: CanvasRuntime;

/** How a file's canvas is set up: see `eachTest`. */
export interface CanvasSetup {
  /** The checkout's files, as `gitRepo` takes them. */
  files?: Record<string, string>;
  /** The repository's entry in the canvas's configuration beside its path; one clone where left out. */
  repo?: Omit<RepoConfig, 'path'>;
  /** The canvas's dependencies beside the fixture's own, read when it starts (after the file's own `beforeEach` that came first). */
  deps?: () => Partial<CanvasDeps>;
}

let setup: CanvasSetup = {};
/** Every canvas a test started here: each is shut down after the test. */
const started = new Set<CanvasRuntime>();

/**
 * Sets each test in the calling scope up afresh as `s` says, with the canvas started, and removes it
 * afterwards. A file calls it at its top; run one after the other in one process, the files share
 * this module, evaluated once.
 */
export function eachTest(s: CanvasSetup = {}) {
  beforeEach(async () => {
    setup = s;
    dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
    main = gitRepo(join(dir, 'main'), s.files);
    store = new Store(':memory:');
    runtime = new FakeRuntime();
    await open();
  });
  afterEach(async () => {
    await stopAll();
    await removeDir(dir);
  });
}

type Changes = { repo?: CanvasSetup['repo']; deps?: Partial<CanvasDeps> };

/**
 * Starts the canvas on the setup's store, runtime and checkout as `eachTest` was told, with `repo`
 * and `deps` changed; it becomes `canvas` and is shut down after the test.
 */
export async function open({ repo, deps }: Changes = {}): Promise<CanvasRuntime> {
  const config: CanvasConfig = { repos: [{ path: main, clones: 1, ...setup.repo, ...repo }] };
  return (canvas = await start(config, { ...setup.deps?.(), ...deps }));
}

/** Obeya started anew: `canvas` shut down and opened again, with `changes`. */
export async function restart(changes: Changes = {}): Promise<CanvasRuntime> {
  await stop(canvas);
  return open(changes);
}

/** A canvas as `config` has it, on the setup's store, home and runtime unless `deps` names others; shut down after the test. */
export async function start(config: CanvasConfig, deps: Partial<CanvasDeps> = {}): Promise<CanvasRuntime> {
  const c = await CanvasRuntime.start(config, { store, home: dir, runtime, forge: noForge, commandDelayMs: 10, ...deps });
  started.add(c);
  return c;
}

/** Shuts `c` down and waits for git freeing its workspaces in the background, so its directory can go. */
async function stop(c: CanvasRuntime) {
  started.delete(c);
  c.shutdown();
  await Promise.all(c.repos.map((r) => r.workers.freed()));
}

/** Shuts down every canvas started so far. */
export const stopAll = () => Promise.all([...started].map(stop));

export const board = () => canvas.board;
export const item = (id: string) => board().item(id)!;
export const workers = () => canvas.repos[0]!.workers;

/** A card handed over on the canvas's repository, as `handedOverOn` has it. */
export const handedOver = (o: Parameters<typeof handedOverOn>[1] = {}) => handedOverOn({ board: board(), workers: workers(), runtime }, o);

/** `ms` gone, so the timers' work is done, and the workspaces of the workers it started made ready and freed. */
export async function settle(ms = 5) {
  await new Promise((r) => setTimeout(r, ms));
  await Promise.all(canvas.repos.map((r) => r.workers.prepared()));
  await Promise.all(canvas.repos.map((r) => r.workers.freed()));
}

/**
 * Says `text` with `focus` (and `images` and `input`, as `hear` takes them); the Coordinator's
 * session calls `tool` with `args` (made from the brief it was handed, where they depend on it) and
 * ends its turn.
 */
export async function say(
  text: string,
  focus: Focus,
  tool: string,
  args: Record<string, unknown> | ((brief: string) => Record<string, unknown>),
  { images = [], input = {} }: { images?: string[]; input?: Input } = {},
): Promise<{ heard: Heard; session: FakeSession; brief: string; result: unknown }> {
  const heard = canvas.commander.hear(text, focus, images, input);
  await settle();
  const session = runtime.withTool('look_up').at(-1)!;
  const brief = session.inbox.at(-1)!;
  const result = session.call(tool, typeof args === 'function' ? args(brief) : args);
  session.emit({ type: 'idle' });
  return { heard: await heard, session, brief, result };
}
