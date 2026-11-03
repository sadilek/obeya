import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import type { FolderWorkspaces } from './folder';
import { artifact, FakeRuntime, noForge } from './testing';

let dir: string;
let docs: string;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) % 251);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-folder-canvas-'));
  docs = join(dir, 'Documents');
  mkdirSync(join(docs, 'Scans'), { recursive: true });
  mkdirSync(join(docs, 'Estate'), { recursive: true });
  writeFileSync(join(docs, 'Scans', 'scan-1.pdf'), bytes(4000, 7));
  writeFileSync(join(docs, 'Estate', 'Inventory.md'), '# Estate\n\n- Savings book\n');
  writeFileSync(join(docs, '.obeya-note.txt'), 'x\n');
  runtime = new FakeRuntime();
  canvas = new CanvasRuntime({ repos: [{ path: docs, git: false }] }, { store: new Store(':memory:'), home: dir, runtime, forge: noForge });
  await (canvas.repos[0]!.workspaces as FolderWorkspaces).read;
});
afterEach(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const item = (id: string) => canvas.board.item(id)!;

describe('a canvas over a folder without git', () => {
  test('resolves without git: no branch, no pull requests, the folder its own Lesestand', () => {
    expect(canvas.board.canvas.repos[0]).toMatchObject({ id: 'documents', folder: true, branch: '' });
    expect(canvas.repos[0]!.read.path).toBe(docs);
  });

  test('two cards work in the folder at once, each with its own changes; undo puts back one card’s, approval ends the other', async () => {
    const sort = canvas.board.create({ title: 'Sort the scans', x: 0, y: 0 });
    const letter = canvas.board.create({ title: 'Draft the letter', x: 400, y: 0 });
    const workers = canvas.repoOf(sort.id).workers;
    await workers.start(sort.id);
    const a = runtime.last;
    await workers.start(letter.id);
    const b = runtime.last;
    expect(canvas.board.row(sort.id).workspace).toBe(docs);
    expect(a.spec.cwd).toBe(docs);
    expect(a.spec.system).toContain('directly in a folder that is not a git repository');
    await a.use('Bash', { command: 'mkdir -p Tax/2025 && mv Scans/scan-1.pdf Tax/2025/' }, () => {
      mkdirSync(join(docs, 'Tax', '2025'), { recursive: true });
      renameSync(join(docs, 'Scans', 'scan-1.pdf'), join(docs, 'Tax', '2025', 'scan-1.pdf'));
    });
    await b.use('Write', { file_path: join(docs, 'Estate', 'Reply.md') }, () => writeFileSync(join(docs, 'Estate', 'Reply.md'), 'Dear court,\n'));
    await b.use('Edit', { file_path: 'Estate/Inventory.md' }, () => writeFileSync(join(docs, 'Estate', 'Inventory.md'), '# Estate\n\n- Savings book\n- Car\n'));
    const listOf = async (id: string) => (await canvas.diff(id, false))!.folder!.changes.map((c) => `${c.kind} ${c.from ? `${c.from} → ` : ''}${c.path}`);
    expect(await listOf(sort.id)).toEqual(['moved Scans/scan-1.pdf → Tax/2025/scan-1.pdf', 'added Tax', 'added Tax/2025']);
    expect(await listOf(letter.id)).toEqual(['added Estate/Reply.md', 'modified Estate/Inventory.md']);
    // the Koordinator sees what each changed
    expect((await canvas.repos[0]!.workspaces.changes(letter.id)).map((c) => c.file)).toEqual(['Estate/Reply.md', 'Estate/Inventory.md']);

    // a handover without a demo: the change list shows what changed
    expect(await a.call('ready_for_review', { summary: 'Sorted.' })).toContain('Recorded');
    expect(await b.call('ready_for_review', { summary: 'Drafted.' })).toContain('Recorded');
    expect(item(sort.id)).toMatchObject({ state: 'waiting', need: 'review' });

    await canvas.act(sort.id, { action: 'undo' });
    expect(existsSync(join(docs, 'Scans', 'scan-1.pdf'))).toBe(true);
    expect(existsSync(join(docs, 'Tax'))).toBe(false);
    expect(await listOf(sort.id)).toEqual([]);
    expect(item(sort.id)).toMatchObject({ state: 'waiting', noChange: true });
    expect(canvas.board.events(sort.id).at(-1)!.text).toBe('Änderungen verworfen: 1 Datei zurückgesetzt.');
    // the other card's changes stay
    expect(readFileSync(join(docs, 'Estate', 'Reply.md'), 'utf8')).toBe('Dear court,\n');

    await canvas.act(letter.id, { action: 'approve' });
    expect(item(letter.id).state).toBe('done');
    expect(canvas.board.events(letter.id).some((e) => e.text === 'Freigegeben. Die Änderungen bleiben im Ordner: erledigt.')).toBe(true);
    expect(b.inbox.at(-1)).toContain('Your changes stay in the folder');
    // done: nothing is undone any more, but the list stays the card's record
    expect((await canvas.diff(letter.id, false))!.folder!.undo).toBeNull();
    expect(() => canvas.act(letter.id, { action: 'undo' })).toThrow();
  });

  test('the Koordinator holds a card that would touch what one in progress changed, until the owner starts it anyway', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 10));
    const estimates = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'scope'));
    const sort = canvas.board.create({ title: 'Sort the scans', x: 0, y: 0 });
    canvas.koordinator.request(sort.id);
    await settle();
    expect(item(sort.id).state).toBe('working');
    // its scope, estimated once it runs
    estimates()[0]!.call('scope', { files: ['Scans/'], conflicts_with: [], reason: '.' });
    estimates()[0]!.emit({ type: 'idle' });
    await settle();
    const worker = runtime.sessions.find((s) => s.spec.cwd === docs && s.spec.role === 'worker')!;
    await worker.use('Bash', { command: 'mv' }, () => renameSync(join(docs, 'Scans', 'scan-1.pdf'), join(docs, 'Scans', '2026-10-02 Bill.pdf')));
    const rename = canvas.board.create({ title: 'Rename the scans', x: 400, y: 0 });
    canvas.koordinator.request(rename.id);
    await settle();
    const judge = estimates().at(-1)!;
    expect(judge.spec.system).toContain('all directly in one folder that is not a git repository');
    expect(judge.inbox[0]).toContain('changed so far: Scans/2026-10-02 Bill.pdf (moved from Scans/scan-1.pdf)');
    judge.call('scope', { files: ['Scans/'], conflicts_with: ['K1'], reason: 'Both rename the scans.' });
    judge.emit({ type: 'idle' });
    await settle();
    expect(item(rename.id)).toMatchObject({ state: 'planned', queue: { behind: [sort.id] } });
    canvas.act(rename.id, { action: 'force' });
    await settle();
    expect(item(rename.id).state).toBe('working');
  });

  test("a question's drafts are no result: a handover without a demo shows the card's changes instead", async () => {
    const plan = canvas.board.create({ title: 'Letterhead', x: 0, y: 0 });
    const workers = canvas.repoOf(plan.id).workers;
    await workers.start(plan.id);
    const a = runtime.last;
    const drafts = artifact();
    expect(await a.call('ask', { question: 'Which letterhead?', options: ['A', 'B'], demo: drafts })).toContain('End your turn');
    expect(item(plan.id).demo).toMatchObject({ kind: 'html', asked: true });
    workers.answer(plan.id, 'A');
    await a.use('Write', { file_path: join(docs, 'Estate', 'Letterhead.md') }, () => writeFileSync(join(docs, 'Estate', 'Letterhead.md'), '# A\n'));
    expect(await a.call('ready_for_review', { summary: 'Done.' })).toContain('Recorded');
    expect(item(plan.id)).toMatchObject({ state: 'waiting', need: 'review' });
    expect(item(plan.id).demo).toBeUndefined();
    // kept with the card's earlier demos, which show once a later handover brings a demo
    expect(JSON.parse(canvas.board.row(plan.id).demos!)).toMatchObject([{ kind: 'html', asked: true }]);
  });

  test('a card shows the files it changed as its result: those its worker names first, served from the folder, no other file of it', async () => {
    const plan = canvas.board.create({ title: 'Pension plan', x: 0, y: 0 });
    const workers = canvas.repoOf(plan.id).workers;
    await workers.start(plan.id);
    const a = runtime.last;
    await a.use('Write', { file_path: join(docs, 'Estate', 'Plan.md') }, () => writeFileSync(join(docs, 'Estate', 'Plan.md'), '# Plan\n\n![Scan](../Scans/scan-1.pdf)\n'));
    await a.use('Bash', { command: 'python3 model.py' }, () => {
      writeFileSync(join(docs, 'Estate', 'model.py'), 'print(1)\n');
      mkdirSync(join(docs, 'Estate', '__pycache__'));
      writeFileSync(join(docs, 'Estate', '__pycache__', 'model.pyc'), bytes(100, 3));
    });
    expect(await a.call('ready_for_review', { summary: 'Done.', files: [{ path: 'Estate/Inventory.md', caption: 'x' }] })).toContain('Estate/Inventory.md is not among the files your card made or changed');
    // without files named, the card still shows what it changed, beside its conversation
    expect(await a.call('ready_for_review', { summary: 'Done.' })).toContain('Recorded');
    expect(item(plan.id).files).toEqual([]);
    workers.message(plan.id, 'Name the plan.');
    expect(await a.call('ready_for_review', { summary: 'Done.', files: [{ path: join(docs, 'Estate', 'Plan.md'), caption: 'The plan' }] })).toContain('Recorded');
    expect(item(plan.id).files).toEqual([{ path: 'Estate/Plan.md', caption: 'The plan' }]);

    const file = (path: string) => canvas.cardFile(plan.id, path);
    expect(await file('Estate/Plan.md')).toMatchObject({ path: expect.stringMatching(/Estate\/Plan\.md$/) });
    expect(await file('Estate/__pycache__/model.pyc')).not.toBeNull();
    // in the folder, but not the card's: neither a file it did not change nor one its Markdown links to that is no image
    expect(await file('Estate/Inventory.md')).toBeNull();
    expect(await file('Scans/scan-1.pdf')).toBeNull();
    expect(await file('../Documents/Estate/Inventory.md')).toBeNull();
  });

  test('a handover whose change has nothing to show leaves the conversation alone; a file gone since gets no tab', async () => {
    const tidy = canvas.board.create({ title: 'Tidy up', x: 0, y: 0 });
    const workers = canvas.repoOf(tidy.id).workers;
    await workers.start(tidy.id);
    const a = runtime.last;
    await a.use('Bash', { command: 'rm .obeya-note.txt' }, () => rmSync(join(docs, '.obeya-note.txt')));
    expect(await a.call('ready_for_review', { summary: 'Tidied.' })).toContain('Recorded');
    expect(item(tidy.id).files).toBeUndefined();

    workers.message(tidy.id, 'Write it down.');
    await a.use('Write', { file_path: join(docs, 'Tidied.md') }, () => writeFileSync(join(docs, 'Tidied.md'), '# Tidied\n'));
    expect(await a.call('ready_for_review', { summary: 'Written.' })).toContain('Recorded');
    expect(item(tidy.id).files).toEqual([]);
    // the owner deletes it before handing over again: nothing of the change is left to show
    rmSync(join(docs, 'Tidied.md'));
    expect((await canvas.diff(tidy.id, false))!.folder!.changes.find((c) => c.path === 'Tidied.md')).toMatchObject({ kind: 'added', gone: true });
    workers.message(tidy.id, 'Again.');
    expect(await a.call('ready_for_review', { summary: 'Again.' })).toContain('Recorded');
    expect(item(tidy.id).files).toBeUndefined();
  });

  test('a handover the owner stopped the session under, while its change was read, changes nothing', async () => {
    const card = canvas.board.create({ title: 'Write it', x: 0, y: 0 });
    const workers = canvas.repoOf(card.id).workers;
    await workers.start(card.id);
    const a = runtime.last;
    await a.use('Write', { file_path: join(docs, 'Note.md') }, () => writeFileSync(join(docs, 'Note.md'), '# Note\n'));
    const handover = a.call('ready_for_review', { summary: 'Written.' });
    workers.stop(card.id);
    expect(await handover).toContain('This session has ended');
    expect(item(card.id).state).toBe('planned');
    expect(canvas.board.events(card.id).some((e) => e.kind === 'review')).toBe(false);
  });

  test('cards handed over without a demo before Obeya kept their list get it at the start, archived ones too, while their files are there', async () => {
    const handed = async (title: string, file: string) => {
      const card = canvas.board.create({ title, x: 0, y: 0 });
      await canvas.repoOf(card.id).workers.start(card.id);
      const a = runtime.last;
      await a.use('Write', { file_path: join(docs, file) }, () => writeFileSync(join(docs, file), `# ${title}\n`));
      expect(await a.call('ready_for_review', { summary: 'Done.' })).toContain('Recorded');
      // as an Obeya before kept it
      canvas.board.work(card.id, { files: null });
      return { id: card.id, a };
    };
    const finish = async (card: { id: string }) => {
      await canvas.act(card.id, { action: 'approve' });
      return card.id;
    };
    const waiting = (await handed('Waiting', 'Waiting.md')).id;
    const done = await finish(await handed('Done', 'Done.md'));
    const archived = await finish(await handed('Archived', 'Archived.md'));
    canvas.board.work(archived, { archived_at: new Date().toISOString() });
    const gone = (await handed('Gone', 'Gone.md')).id;
    rmSync(join(docs, 'Gone.md'));
    // a card at work that never handed over waits for its handover
    const working = canvas.board.create({ title: 'Working', x: 0, y: 0 });
    await canvas.repoOf(working).workers.start(working.id);
    await runtime.last.use('Write', { file_path: join(docs, 'Working.md') }, () => writeFileSync(join(docs, 'Working.md'), '# Working\n'));

    canvas.repoOf(waiting).workers.resumeAll();
    const files = (id: string) => canvas.board.card(id)!.files;
    for (let n = 0; n < 100 && !files(archived); n++) await new Promise((r) => setTimeout(r, 10));
    expect(files(waiting)).toEqual([]);
    expect(files(done)).toEqual([]);
    expect(files(archived)).toEqual([]);
    expect(files(gone)).toBeUndefined();
    expect(files(working.id)).toBeUndefined();
  });

  test('has no prototypes', () => {
    const idea = canvas.board.create({ idea: true, title: 'Ordnung', x: 0, y: 0 });
    expect(() => canvas.act(idea.id, { action: 'prototype', text: 'so' })).toThrow('no prototypes');
  });
});
