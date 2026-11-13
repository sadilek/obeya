import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Notice } from '../core/types';
import { Canvases } from './canvases';
import { Config } from './config';
import { Store } from './db';
import { FakeRuntime, gitRepo, noForge, ownGlobalGitConfig, refusal, removeDir, until } from './testing';
import { git } from './git';
import type { GithubForNewRepo } from './new-repo';

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let set: Canvases;
let config: Config;
let notices: Notice[];
/** What the fake GitHub was asked: the repositories looked at and forked, with the account. */
let asked: string[];
/** GitHub as the tests stage it: `look` and `fork` answer with repositories in the temp directory. */
let github: GithubForNewRepo;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// git's name and e-mail, which the first commit of a new repository is made under
ownGlobalGitConfig('[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-new-repo-'));
  const docs = gitRepo(join(dir, 'docs'));
  const configs = [{ name: 'Docs', repos: [{ path: docs }] }];
  writeFileSync(join(dir, 'canvases.json'), JSON.stringify(configs));
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  config = new Config({
    file: join(dir, 'canvases.json'),
    source: 'file',
    started: configs,
    store,
    running: () => set.all().map((c) => c.id),
    server: { port: 4417, home: dir, permissionMode: 'auto' },
    apply: (configs, ids) => set.apply(configs, ids),
  });
  asked = [];
  github = { look: () => Promise.reject(new Error('no GitHub here')), fork: () => Promise.reject(new Error('no GitHub here')), env: async () => ({}) };
  const viaFake: GithubForNewRepo = { look: (r, a) => github.look(r, a), fork: (r, a) => github.fork(r, a), env: (h, a) => github.env(h, a) };
  set = await Canvases.start(configs, { store, home: join(dir, 'home'), runtime, forge: noForge, config, newRepoHoldMs: 30, restartIntervalMs: 5, newRepoGithub: viaFake });
  notices = [];
  docsCanvas().board.onNotice((n) => notices.push(n));
});
afterEach(async () => {
  set.shutdown();
  await removeDir(dir);
});

const docsCanvas = () => set.get('docs')!;

/** An idea on the Docs canvas, discussed, with a screenshot, a decision and its agent's pick of a new repository at `path`. */
function idea(path: string, canvas = true) {
  const c = docsCanvas();
  const shot = c.images.save(PNG, 'image/png');
  const card = c.board.create({ idea: true, title: 'Class schedule', x: 0, y: 0, images: [shot] });
  c.board.setIdea(card.id, { brief: '**Goal** A schedule for the class.' });
  c.board.log(card.id, 'talk', 'owner', 'A separate repo for it, please.');
  c.board.decide({ project_id: null, card_id: card.id, question: 'Where?', answer: 'A repository of its own.', by: 'owner' });
  c.board.setNewRepo(card.id, { path, canvas, by: 'agent' }, 'agent');
  return card;
}

describe('building an idea in a new repository', () => {
  test('after the undo window, Obeya creates the repository and a canvas named after it, and the idea moves there with everything and starts', async () => {
    const path = join(dir, 'dev', 'super59');
    const card = idea(path);
    const follower = docsCanvas().board.create({ title: 'Invite the parents', x: 600, y: 0, from: card.id });
    docsCanvas().board.createGroup('School', [card.id, follower.id]);
    docsCanvas().act(card.id, { action: 'build' });
    // held for the owner to take it back: nothing made yet
    expect(docsCanvas().board.item(card.id)!.newRepo).toMatchObject({ path, canvas: true, due: expect.any(String) });
    expect(existsSync(path)).toBe(false);
    await until(() => set.get('super59'));
    const there = set.get('super59')!;
    // a local repository with its first commit, under git's name, and no remote
    expect(git(path, 'log', '--format=%an %s')).toBe('Ada Lovelace First commit');
    expect(existsSync(join(path, '.gitignore'))).toBe(true);
    expect(git(path, 'remote')).toBe('');
    expect(JSON.parse(readFileSync(join(dir, 'canvases.json'), 'utf8')).at(-1)).toEqual({ repos: [{ path }] });
    expect(there.board.canvas.name).toBe('super59');
    // the card is there, decided as "Build it like this" decides it, with its conversation, decisions and screenshot, out of its group
    await until(() => there.board.item(card.id)?.queue || there.board.item(card.id)?.state === 'working');
    const moved = there.board.item(card.id)!;
    expect(moved.body).toBe('**Goal** A schedule for the class.');
    expect(moved.repo).toBe('super59');
    expect(moved.group).toBeUndefined();
    expect(moved.newRepo).toBeUndefined();
    expect(there.board.events(card.id).map((e) => e.text)).toEqual(
      expect.arrayContaining(['A separate repo for it, please.', expect.stringContaining('Docs'), expect.stringContaining('So bauen')]),
    );
    expect(there.board.decisions(null).map((d) => d.answer)).toEqual(expect.arrayContaining(['A repository of its own.', expect.stringContaining(path)]));
    expect(there.images.path(moved.images![0]!)).toBeTruthy();
    // nothing of it stays on Docs: its sheet says where it went, and a page that has it open follows it
    expect(docsCanvas().board.item(card.id)).toBeUndefined();
    expect(docsCanvas().board.snapshot().talk.at(-1)).toMatchObject({ moved: { card: card.id, title: 'Class schedule', canvas: 'super59', canvasName: 'super59' } });
    expect(notices).toContainEqual(expect.objectContaining({ cardId: card.id, movedTo: 'super59' }));
    // the card that stayed still names it, on the other canvas
    expect(docsCanvas().board.item(follower.id)).toMatchObject({ from: card.id, fromElsewhere: { canvas: 'super59', canvasName: 'super59', title: 'Class schedule' } });
    expect(docsCanvas().board.snapshot().groups.map((g) => g.name)).toEqual(['School']);
  });

  test('its worker hears that the repository is new, and sets it up', async () => {
    const path = join(dir, 'super59');
    const card = idea(path);
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => runtime.sessions.some((s) => s.spec.role === 'worker' && s.inbox[0]?.includes('Class schedule')), 10_000);
    const brief = runtime.sessions.find((s) => s.spec.role === 'worker')!.inbox[0]!;
    expect(brief).toContain('This repository is new');
    expect(brief).toContain('obeya:settings');
    expect(brief).toContain('CLAUDE.md');
  });

  test('"Undo" in the undo window leaves everything as it was', async () => {
    const path = join(dir, 'super59');
    const card = idea(path);
    docsCanvas().act(card.id, { action: 'build' });
    docsCanvas().act(card.id, { action: 'stayHere' });
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(path)).toBe(false);
    expect(set.all().map((c) => c.id)).toEqual(['docs']);
    const now = docsCanvas().board.item(card.id)!;
    expect(now.state).toBe('idea');
    expect(now.newRepo).toEqual({ path, canvas: true, by: 'agent' });
    expect(refusal(() => docsCanvas().act(card.id, { action: 'stayHere' }))).toBe('newRepoGone');
  });

  test('a step that fails takes back those before it, and the card says why', async () => {
    // a repository named like the canvas it would leave: its canvas would have the same id
    const path = join(dir, 'elsewhere', 'docs');
    const card = idea(path);
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => docsCanvas().board.events(card.id).some((e) => e.kind === 'error'));
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'canvases.json'), 'utf8'))).toHaveLength(1);
    const now = docsCanvas().board.item(card.id)!;
    expect(now.state).toBe('idea');
    expect(now.newRepo?.due).toBeUndefined();
    expect(docsCanvas().board.events(card.id).at(-1)!.text).toContain('Repository nicht angelegt');
  });

  test('without a canvas of its own, the repository joins this canvas and the card works in it', async () => {
    const path = join(dir, 'super59');
    const task = docsCanvas().board.create({ title: 'Schedule', body: 'Build it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path, canvas: false } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => docsCanvas().board.item(task.id)?.repo === 'super59');
    expect(docsCanvas().board.canvas.repos.map((r) => r.id)).toEqual(['docs', 'super59']);
    expect(set.all().map((c) => c.id)).toEqual(['docs']);
    await until(() => docsCanvas().board.item(task.id)!.state !== 'planned' || docsCanvas().board.item(task.id)!.queue);
  });

  test('a folder that is a repository already is taken as it is; one inside another repository is refused', async () => {
    const path = gitRepo(join(dir, 'existing'));
    const head = git(path, 'rev-parse', 'HEAD');
    const card = idea(path);
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => set.get('existing'));
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    const inside = idea(join(dir, 'docs', 'sub'));
    docsCanvas().act(inside.id, { action: 'build' });
    await until(() => docsCanvas().board.events(inside.id).some((e) => e.kind === 'error'));
    expect(docsCanvas().board.events(inside.id).at(-1)!.text).toContain('liegt im Repository');
    expect(existsSync(join(dir, 'docs', 'sub'))).toBe(false);
  });

  test('a folder that is a repository of a canvas already is refused at once', () => {
    const card = idea(join(dir, 'docs'));
    expect(refusal(() => docsCanvas().act(card.id, { action: 'build' }))).toBe('newRepoPath');
  });

  test('in the undo window the card takes no other way on, and its agent does not change the target', () => {
    const card = idea(join(dir, 'super59'));
    docsCanvas().act(card.id, { action: 'build' });
    expect(refusal(() => docsCanvas().act(card.id, { action: 'planDoc' }))).toBe('newRepoDue');
    expect(docsCanvas().board.setNewRepo(card.id, { path: join(dir, 'other'), canvas: true, by: 'agent' }, 'agent')).toBe(false);
    expect(docsCanvas().board.item(card.id)!.newRepo?.due).toBeTruthy();
    docsCanvas().act(card.id, { action: 'stayHere' });
  });

  test('a failed step removes only the folders Obeya created, not what came beside them', async () => {
    mkdirSync(join(dir, 'parent'));
    const sibling = join(dir, 'parent', 'beta');
    mkdirSync(sibling);
    // named like the canvas it would leave: the configuration refuses it
    const card = idea(join(dir, 'parent', 'new', 'docs'));
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => docsCanvas().board.events(card.id).some((e) => e.kind === 'error'));
    expect(existsSync(join(dir, 'parent', 'new'))).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test('a link to a repository of a canvas counts as that repository; a path neither absolute nor from ~ is refused', () => {
    symlinkSync(join(dir, 'docs'), join(dir, 'link'));
    expect(refusal(() => docsCanvas().act(idea(join(dir, 'link')).id, { action: 'build' }))).toBe('newRepoPath');
    expect(refusal(() => docsCanvas().act(idea('~someone/project').id, { action: 'build' }))).toBe('newRepoPath');
  });

  test('a task snoozed to start later makes its new repository when it starts', async () => {
    const path = join(dir, 'later');
    const task = docsCanvas().board.create({ title: 'Later', body: 'Later.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path, canvas: true } });
    docsCanvas().act(task.id, { action: 'snooze', until: new Date(Date.now() + 60_000).toISOString() });
    docsCanvas().act(task.id, { action: 'wake' });
    await until(() => set.get('later')?.board.item(task.id));
  });

  test("what the owner picked on the card, the idea's agent does not change; the owner's pick of an existing repository takes the new one off", () => {
    const c = docsCanvas();
    const card = c.board.create({ idea: true, title: 'X', x: 0, y: 0 });
    expect(c.board.setNewRepo(card.id, { path: '~/dev/a', canvas: true, by: 'agent' }, 'agent')).toBe(true);
    c.board.patch(card.id, { newRepo: { path: '~/dev/b', canvas: false } });
    expect(c.board.setNewRepo(card.id, { path: '~/dev/c', canvas: true, by: 'agent' }, 'agent')).toBe(false);
    expect(c.board.item(card.id)!.newRepo).toEqual({ path: '~/dev/b', canvas: false, by: 'owner' });
    c.board.patch(card.id, { repo: 'docs' });
    expect(c.board.item(card.id)!.newRepo).toBeUndefined();
    // and stands too
    expect(c.board.setNewRepo(card.id, { path: '~/dev/d', canvas: true, by: 'agent' }, 'agent')).toBe(false);
  });
});

/** A project on "GitHub": a bare repository in the temp directory with a commit of its own on `main`. */
function project(name: string): string {
  const work = gitRepo(join(dir, 'work', name), { 'README.md': `# ${name}\n`, 'src/app.ts': 'export {};\n' });
  const bare = join(dir, 'remote', `${name}.git`);
  git(dir, 'clone', '--quiet', '--bare', work, bare);
  return bare;
}

/** GitHub with `acme/widgets`, which the owner may push to or not; a fork goes to `ada/widgets`. */
function stageGithub(push: boolean) {
  const original = project('widgets');
  const fork = join(dir, 'remote', 'ada', 'widgets.git');
  github = {
    look: async (r, account) => {
      asked.push(`look ${r.owner}/${r.repo} as ${account ?? 'gh'}`);
      return { push, fullName: `${r.owner}/${r.repo}`, cloneUrl: original, defaultBranch: 'main' };
    },
    fork: async (r, account) => {
      asked.push(`fork ${r.owner}/${r.repo} as ${account ?? 'gh'}`);
      git(dir, 'clone', '--quiet', '--bare', original, fork);
      return { fullName: 'ada/widgets', cloneUrl: fork };
    },
    env: async () => ({}),
  };
  return { original, fork };
}

describe('a new repository from an existing project', () => {
  test('a GitHub repository the owner cannot push to is forked and the fork cloned, the original as upstream; work lands on its main, each card may go to the original as a PR', async () => {
    const { original, fork } = stageGithub(false);
    const path = join(dir, 'dev', 'widgets');
    const task = docsCanvas().board.create({ title: 'Fix the widget', body: 'Fix it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path, canvas: true, from: 'acme/widgets' } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => set.get('widgets')?.board.item(task.id), 10_000);
    expect(asked).toEqual(['look acme/widgets as gh', 'fork acme/widgets as gh']);
    // the project's own history, not an empty first commit
    expect(git(path, 'log', '--format=%s')).toBe('init');
    expect(git(path, 'remote', 'get-url', 'origin')).toBe(fork);
    expect(git(path, 'remote', 'get-url', 'upstream')).toBe(original);
    expect(git(path, 'symbolic-ref', 'refs/remotes/upstream/HEAD')).toBe('refs/remotes/upstream/main');
    // the settings that make the approval offer the pull request to the original take effect at once, on this machine
    expect(JSON.parse(readFileSync(join(dir, 'canvases.json'), 'utf8')).at(-1)).toEqual({ repos: [{ path, settings: { land: 'main' } }] });
    const there = set.get('widgets')!;
    expect(there.board.canvas.repos[0]).toMatchObject({ branch: 'main', upstream: { ref: 'upstream/main', branch: 'main' } });
    expect(there.board.events(task.id).map((e) => e.text)).toContainEqual(expect.stringContaining('ada/widgets'));
    await until(() => runtime.sessions.some((s) => s.spec.role === 'worker' && s.inbox[0]?.includes('Fix the widget')), 10_000);
    const brief = runtime.sessions.find((s) => s.spec.role === 'worker' && s.inbox[0]?.includes('Fix the widget'))!.inbox[0]!;
    expect(brief).toContain('cloned it for this card from acme/widgets, by way of ada/widgets');
    // its branch may become the pull request to the original: nothing of setting up goes onto it
    expect(brief).not.toContain('obeya:settings');
    expect(brief).not.toContain('This repository is new:');
  });

  test('a GitHub repository the owner may push to is cloned as it is, without a fork', async () => {
    const { original } = stageGithub(true);
    const path = join(dir, 'widgets');
    const task = docsCanvas().board.create({ title: 'Fix', body: 'Fix it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path, canvas: false, from: 'https://github.com/acme/widgets.git' } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => docsCanvas().board.item(task.id)?.repo === 'widgets', 10_000);
    expect(asked).toEqual(['look acme/widgets as gh']);
    expect(git(path, 'remote')).toBe('origin');
    expect(git(path, 'remote', 'get-url', 'origin')).toBe(original);
    expect(JSON.parse(readFileSync(join(dir, 'canvases.json'), 'utf8'))[0].repos.at(-1)).toEqual({ path });
  });

  test('a folder or any other git URL is cloned as it is; the card says from where', async () => {
    const source = project('notes');
    const path = join(dir, 'notes');
    const card = idea(path);
    docsCanvas().board.setNewRepo(card.id, { path, canvas: true, from: source, by: 'agent' }, 'agent');
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => set.get('notes')?.board.item(card.id), 10_000);
    expect(git(path, 'log', '--format=%s')).toBe('init');
    expect(git(path, 'remote', 'get-url', 'origin')).toBe(source);
    expect(set.get('notes')!.board.events(card.id).map((e) => e.text)).toContainEqual(expect.stringContaining(`ist ein Klon von ${source}`));
  });

  test('something that is no project to clone is refused at once; a folder that is not empty fails, and stays as it was', async () => {
    const task = docsCanvas().board.create({ title: 'Fix', body: 'Fix it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path: join(dir, 'x'), canvas: true, from: 'just words' } });
    expect(refusal(() => docsCanvas().act(task.id, { action: 'start' }))).toBe('newRepoFrom');
    const full = join(dir, 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'mine.txt'), 'mine');
    docsCanvas().board.patch(task.id, { newRepo: { path: full, canvas: true, from: project('notes') } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => docsCanvas().board.events(task.id).some((e) => e.kind === 'error'));
    expect(docsCanvas().board.events(task.id).at(-1)!.text).toContain('nicht leer');
    expect(readFileSync(join(full, 'mine.txt'), 'utf8')).toBe('mine');
    expect(set.all().map((c) => c.id)).toEqual(['docs']);
  });

  test('files that come into the folder while GitHub answers stay where the clone then fails', async () => {
    let release!: () => void;
    const held = new Promise<void>((go) => (release = go));
    stageGithub(true);
    const look = github.look;
    github.look = async (r, a) => (await held, look(r, a));
    const path = join(dir, 'widgets');
    mkdirSync(path);
    const task = docsCanvas().board.create({ title: 'Fix', body: 'Fix it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path, canvas: true, from: 'acme/widgets' } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => docsCanvas().board.item(task.id)!.newRepo?.making);
    writeFileSync(join(path, 'mine.txt'), 'mine');
    release();
    await until(() => docsCanvas().board.events(task.id).some((e) => e.kind === 'error'));
    expect(readFileSync(join(path, 'mine.txt'), 'utf8')).toBe('mine');
  });

  test('an idea parked while it is cloned is not built, and its clone goes again', async () => {
    let release!: () => void;
    const held = new Promise<void>((go) => (release = go));
    const source = project('notes');
    stageGithub(true);
    const path = join(dir, 'notes');
    const card = idea(path);
    docsCanvas().board.setNewRepo(card.id, { path, canvas: true, from: source, by: 'agent' }, 'agent');
    // the clone is held up by holding up the first git call there is no other way to hold: the configuration's check
    const check = config.check.bind(config);
    let first = true;
    config.check = async (c) => (first ? ((first = false), await held) : undefined, check(c));
    docsCanvas().act(card.id, { action: 'build' });
    await until(() => docsCanvas().board.item(card.id)!.newRepo?.making);
    docsCanvas().act(card.id, { action: 'park' });
    release();
    await until(() => docsCanvas().board.events(card.id).some((e) => e.kind === 'error'));
    expect(existsSync(path)).toBe(false);
    expect(set.all().map((c) => c.id)).toEqual(['docs']);
    expect(docsCanvas().board.item(card.id)).toMatchObject({ state: 'idea' });
  });

  test('once the undo window is over, the card says the clone is under way and offers no undo', async () => {
    let release!: () => void;
    const held = new Promise<void>((go) => (release = go));
    stageGithub(true);
    const look = github.look;
    github.look = async (r, a) => (await held, look(r, a));
    const task = docsCanvas().board.create({ title: 'Fix', body: 'Fix it.', x: 0, y: 0 });
    docsCanvas().board.patch(task.id, { newRepo: { path: join(dir, 'widgets'), canvas: true, from: 'acme/widgets' } });
    docsCanvas().act(task.id, { action: 'start' });
    await until(() => docsCanvas().board.item(task.id)!.newRepo?.making);
    expect(refusal(() => docsCanvas().act(task.id, { action: 'stayHere' }))).toBe('newRepoGone');
    release();
    await until(() => set.get('widgets')?.board.item(task.id), 10_000);
  });
});

describe('the Coordinator across canvases', () => {
  test('a new card goes onto another canvas the owner names, and starts there; a follow-up names its card on this one', async () => {
    const other = gitRepo(join(dir, 'shop'));
    await config.save([...config.current(), { name: 'Shop', repos: [{ path: other }] }]);
    const shop = set.get('shop')!;
    const docs = docsCanvas();
    const shot = docs.images.save(PNG, 'image/png');
    const id = docs.run({ do: 'newCard', title: 'Checkout', body: 'Build the checkout.', start: true, canvas: 'shop', images: [shot] }) as string;
    expect(docs.board.item(id)).toBeUndefined();
    expect(shop.board.item(id)).toMatchObject({ title: 'Checkout', repo: 'shop' });
    expect(shop.images.path(shot)).toBeTruthy();
    await until(() => shop.board.item(id)!.queue || shop.board.item(id)!.state === 'working');
    const from = docs.board.create({ title: 'Plan the shop', x: 0, y: 0 });
    const follow = docs.run({ do: 'newCard', title: 'Payment', body: 'Payment.', start: false, canvas: 'shop', from: from.id }) as string;
    expect(shop.board.item(follow)).toMatchObject({ from: from.id, fromElsewhere: { canvas: 'docs', canvasName: 'Docs', title: 'Plan the shop' } });
  });
});
